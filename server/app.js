import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import {attachDatabasePool} from '@vercel/functions';
import { hashPassword, verifyPassword, token, sha256, canonicalItems, uuid } from './security.js';
import { createPriceQuote, verifyPriceQuote } from './price-quote.js';
import { shopStatus, remoteInventory } from './shopify.js';
import { verifyShopifyWebhook, parseOrderEvent } from './webhook.js';
import { syncOne } from './shopify-sync.js';
import { reportRange, salesCsv } from './reports.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (!process.env.PRICE_QUOTE_SECRET || process.env.PRICE_QUOTE_SECRET.length<32) throw new Error('PRICE_QUOTE_SECRET must have at least 32 characters');
const priceSecret=process.env.PRICE_QUOTE_SECRET;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.DATABASE_POOL_MAX||8) });
pool.on('error',err=>console.error('Database idle connection error:',err.message));
if(process.env.VERCEL)attachDatabasePool(pool);
const page = await readFile(fileURLToPath(new URL('../ui/index.html', import.meta.url)));
const appScript = await readFile(fileURLToPath(new URL('../ui/app.js', import.meta.url)));
const offlineScript = await readFile(fileURLToPath(new URL('../ui/offline.js', import.meta.url)));
const workerScript = await readFile(fileURLToPath(new URL('../ui/sw.js', import.meta.url)));
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const send = (res, status, value, headers={}) => { res.writeHead(status, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', ...headers }); res.end(JSON.stringify(value)); };

async function body(req) {
  if (!String(req.headers['content-type']||'').startsWith('application/json')) fail(415, 'JSON required');
  let chunks=[],size=0;
  for await (const chunk of req) { size += chunk.length; if (size > 100000) fail(413,'Body too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400,'Invalid JSON'); }
}
async function rawBody(req,max=1000000){
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>max)fail(413,'Body too large');chunks.push(chunk)}
  return Buffer.concat(chunks);
}
function cookie(req) { return (req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('madar_session='))?.slice(14); }
async function currentUser(req) {
  const raw=cookie(req); if (!raw) fail(401,'Login required');
  const r=await pool.query("SELECT u.id,u.email,u.role,u.active,u.session_version FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.session_version=u.session_version AND (u.role<>'cashier' OR EXISTS(SELECT 1 FROM user_locations ul JOIN cashier_devices d ON d.location_id=ul.location_id WHERE ul.user_id=u.id AND d.device_hash=s.device_hash))",[sha256(raw)]);
  if (!r.rowCount || !r.rows[0].active) fail(401,'Session expired');
  return r.rows[0];
}
async function canUse(user, locationId) {
  if (!uuid(locationId)) fail(400,'Invalid location');
  if (user.role==='admin') return;
  const r=await pool.query('SELECT 1 FROM user_locations WHERE user_id=$1 AND location_id=$2',[user.id,locationId]);
  if (!r.rowCount) fail(403,'Location access denied');
}
function checkOrigin(req) {
  if (!['POST','PATCH','DELETE','PUT'].includes(req.method)) return;
  const origin=req.headers.origin;
  if (origin && new URL(origin).host!==req.headers.host) fail(403,'Invalid origin');
  if (req.headers['sec-fetch-site']==='cross-site') fail(403,'Invalid request site');
}
async function transaction(work) {
  const c=await pool.connect();
  try { await c.query('BEGIN'); const result=await work(c); await c.query('COMMIT'); return result; }
  catch(e){ await c.query('ROLLBACK'); throw e; }
  finally { c.release(); }
}
function normalEmail(email){ if(typeof email!=='string'||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Invalid email'); return email.toLowerCase().trim(); }
function cookieHeader(raw,maxAge){return 'madar_session='+raw+'; HttpOnly; SameSite=Strict; Path=/; Max-Age='+maxAge+(process.env.NODE_ENV==='production'?'; Secure':'')}
async function route(req,res) {
  if(req.method==='POST'&&req.url==='/api/shopify/webhook'){
    const configured=process.env.SHOPIFY_SHOP_DOMAIN,secret=process.env.SHOPIFY_APP_CLIENT_SECRET;
    if(!configured||!secret)fail(503,'Webhook not configured');
    const raw=await rawBody(req),signature=req.headers['x-shopify-hmac-sha256'];
    if(!verifyShopifyWebhook(raw,signature,secret))fail(401,'Invalid webhook signature');
    if(req.headers['x-shopify-shop-domain']!==configured)fail(403,'Unexpected shop');
    const webhookId=req.headers['x-shopify-webhook-id'],topic=req.headers['x-shopify-topic'];
    if(typeof webhookId!=='string'||!webhookId||webhookId.length>150||!['orders/create','orders/cancelled','refunds/create'].includes(topic))fail(400,'Unsupported webhook');
    let payload;try{payload=JSON.parse(raw.toString('utf8'))}catch{fail(400,'Invalid webhook JSON')}
    let order;try{order=parseOrderEvent(payload,topic)}catch(err){fail(400,err.message)}
    const saved=await transaction(async c=>{
      const event=await c.query('INSERT INTO shopify_webhook_events(webhook_id,topic,order_gid) VALUES($1,$2,$3) ON CONFLICT(webhook_id) DO NOTHING RETURNING webhook_id',[webhookId,topic,order.orderGid]);
      if(!event.rowCount)return false;
      await c.query("INSERT INTO shopify_orders(order_gid,order_name,last_topic,financial_status,fulfillment_status,cancelled_at,order_updated_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(order_gid) DO UPDATE SET order_name=EXCLUDED.order_name,last_topic=EXCLUDED.last_topic,financial_status=EXCLUDED.financial_status,fulfillment_status=EXCLUDED.fulfillment_status,cancelled_at=COALESCE(shopify_orders.cancelled_at,EXCLUDED.cancelled_at),order_updated_at=EXCLUDED.order_updated_at WHERE shopify_orders.order_updated_at IS NULL OR EXCLUDED.order_updated_at>=shopify_orders.order_updated_at",[order.orderGid,order.orderName,topic,order.financialStatus,order.fulfillmentStatus,order.cancelledAt,order.updatedAt]);
      if(topic==='orders/cancelled'||topic==='refunds/create'){
        await c.query("UPDATE shopify_orders SET review_status='pending',last_topic=$2 WHERE order_gid=$1",[order.orderGid,topic]);
        await c.query('UPDATE shopify_settings SET sync_enabled=false WHERE id=true');
      }
      for(const item of order.items){
        const mapping=item.sku?await c.query('SELECT v.id FROM variants v JOIN shopify_variant_links l ON l.variant_id=v.id WHERE v.sku=$1',[item.sku]):{rows:[]};
        await c.query('INSERT INTO shopify_order_items(order_gid,line_item_id,sku,variant_id,quantity) VALUES($1,$2,$3,$4,$5) ON CONFLICT(order_gid,line_item_id) DO UPDATE SET sku=EXCLUDED.sku,variant_id=EXCLUDED.variant_id,quantity=EXCLUDED.quantity',[order.orderGid,item.lineItemId,item.sku,mapping.rows[0]?.id||null,item.quantity]);
      }
      return true;
    });send(res,200,{ok:true,duplicate:!saved});return;
  }
  checkOrigin(req);
  const url=new URL(req.url,'http://localhost');
  if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(page);return}
  if(req.method==='GET'&&url.pathname==='/app.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(appScript);return}
  if(req.method==='GET'&&url.pathname==='/offline.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});res.end(offlineScript);return}
  if(req.method==='GET'&&url.pathname==='/sw.js'){res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store','service-worker-allowed':'/'});res.end(workerScript);return}
  if(req.method==='GET'&&url.pathname==='/api/health'){send(res,200,{ok:true});return}
  if(req.method==='POST'&&url.pathname==='/api/login'){
    const input=await body(req),email=normalEmail(input.email);
    const result=await pool.query('SELECT id,email,role,active,password_hash,session_version FROM users WHERE email=$1',[email]);
    const user=result.rows[0];
    if(!user || !user.active || !await verifyPassword(input.password,user.password_hash)) fail(401,'Invalid credentials');
    const raw=token(),deviceHash=user.role==='cashier'?(uuid(input.deviceId)?sha256(input.deviceId):fail(400,'Cashier device ID required')):null;
    await transaction(async c=>{
      if(deviceHash){
        const branch=await c.query("SELECT l.id FROM user_locations ul JOIN locations l ON l.id=ul.location_id WHERE ul.user_id=$1 AND l.kind='branch' AND l.active ORDER BY l.id FOR UPDATE OF l",[user.id]);
        if(branch.rowCount!==1)fail(403,'Cashier must belong to one active branch');
        const binding=await c.query('SELECT device_hash FROM cashier_devices WHERE location_id=$1',[branch.rows[0].id]);
        if(binding.rowCount&&binding.rows[0].device_hash!==deviceHash)fail(409,'This branch is registered to another cashier device. Ask the admin to release it after syncing pending invoices.');
        await c.query('INSERT INTO cashier_devices(location_id,device_hash,cashier_id) VALUES($1,$2,$3) ON CONFLICT(location_id) DO UPDATE SET cashier_id=EXCLUDED.cashier_id,last_seen_at=now()',[branch.rows[0].id,deviceHash,user.id]);
      }
      await c.query("INSERT INTO sessions(token_hash,user_id,session_version,device_hash,expires_at) VALUES($1,$2,$3,$4,now()+interval '12 hours')",[sha256(raw),user.id,user.session_version,deviceHash]);
      await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[user.id,'login']);
    });
    send(res,200,{id:user.id,email:user.email,role:user.role},{'set-cookie':cookieHeader(raw,43200)});return;
  }
  const user=await currentUser(req);
  if(req.method==='POST'&&url.pathname==='/api/logout'){
    await pool.query('DELETE FROM sessions WHERE token_hash=$1',[sha256(cookie(req))]);
    send(res,200,{ok:true},{'set-cookie':cookieHeader('',0)});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/me'){
    const access=await pool.query('SELECT location_id FROM user_locations WHERE user_id=$1',[user.id]);
    send(res,200,{id:user.id,email:user.email,role:user.role,locationIds:access.rows.map(x=>x.location_id)});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/cashier-devices'){
    if(user.role!=='admin')fail(403,'Admin only');
    const r=await pool.query("SELECT d.location_id,l.name location_name,u.email cashier,d.registered_at,d.last_seen_at FROM cashier_devices d JOIN locations l ON l.id=d.location_id JOIN users u ON u.id=d.cashier_id ORDER BY l.name");
    send(res,200,r.rows);return;
  }
  const release=url.pathname.match(/^\/api\/cashier-devices\/([0-9a-f-]{36})\/release$/);
  if(req.method==='POST'&&release){
    if(user.role!=='admin'||!uuid(release[1]))fail(403,'Admin only');
    const input=await body(req);if(input.pendingInvoicesChecked!==true)fail(400,'Review pending invoices before releasing a device');
    const result=await transaction(async c=>{
      const loc=await c.query("SELECT id FROM locations WHERE id=$1 AND kind='branch' FOR UPDATE",[release[1]]);
      if(!loc.rowCount)fail(404,'Branch not found');
      const removed=await c.query('DELETE FROM cashier_devices WHERE location_id=$1 RETURNING location_id',[release[1]]);
      await c.query("DELETE FROM sessions WHERE user_id IN (SELECT ul.user_id FROM user_locations ul JOIN users u ON u.id=ul.user_id WHERE ul.location_id=$1 AND u.role='cashier')",[release[1]]);
      await c.query('INSERT INTO audit_logs(actor_id,location_id,action) VALUES($1,$2,$3)',[user.id,release[1],'cashier.device_release']);
      return {released:removed.rowCount>0};
    });send(res,200,result);return;
  }
  if(req.method==='GET'&&url.pathname==='/api/dashboard'){
    const scope="($1::boolean OR EXISTS(SELECT 1 FROM user_locations ul WHERE ul.user_id=$2 AND ul.location_id=l.id))";
    const params=[user.role==='admin',user.id];
    const [sales,stock,transfers,recent,locations]=await Promise.all([
      pool.query(`SELECT COALESCE(SUM(s.total),0) total,COUNT(*) invoices FROM sales s JOIN locations l ON l.id=s.location_id WHERE ${scope} AND (s.created_at AT TIME ZONE 'Africa/Cairo')::date=(now() AT TIME ZONE 'Africa/Cairo')::date`,params),
      pool.query(`SELECT COALESCE(SUM(b.quantity),0) pieces,COUNT(*) FILTER(WHERE b.quantity>0 AND b.quantity<4) low_variants FROM stock_balances b JOIN locations l ON l.id=b.location_id WHERE l.active AND ${scope}`,params),
      pool.query(`SELECT COUNT(*) completed FROM transfers t JOIN locations l ON l.id=t.source_id WHERE ${scope} AND (t.completed_at AT TIME ZONE 'Africa/Cairo')::date=(now() AT TIME ZONE 'Africa/Cairo')::date`,params),
      pool.query(`SELECT s.id,s.total,s.created_at,l.name location_name,u.email cashier FROM sales s JOIN locations l ON l.id=s.location_id JOIN users u ON u.id=s.cashier_id WHERE ${scope} ORDER BY s.created_at DESC LIMIT 5`,params),
      pool.query(`SELECT l.id,l.name,l.kind,COALESCE(SUM(b.quantity),0) pieces FROM locations l LEFT JOIN stock_balances b ON b.location_id=l.id WHERE l.active AND ${scope} GROUP BY l.id ORDER BY l.kind DESC,l.name`,params)
    ]);
    send(res,200,{sales:sales.rows[0],stock:stock.rows[0],transfers:transfers.rows[0],recent:recent.rows,locations:locations.rows});return;
  }
  if(req.method==='GET'&&['/api/reports/sales','/api/reports/sales.csv'].includes(url.pathname)){
    if(!['admin','branch_manager','stock_manager'].includes(user.role))fail(403,'Reports permission required');
    let range;try{range=reportRange(url.searchParams.get('from'),url.searchParams.get('to'))}catch(err){fail(400,err.message)}
    const locationId=url.searchParams.get('locationId')||null;
    if(locationId&&!uuid(locationId))fail(400,'Invalid location');
    if(locationId)await canUse(user,locationId);
    const params=[user.role==='admin',user.id,range.from,range.to,locationId];
    const where="s.created_at >= ($3::date::timestamp AT TIME ZONE 'Africa/Cairo') AND s.created_at < (($4::date + 1)::timestamp AT TIME ZONE 'Africa/Cairo') AND ($5::uuid IS NULL OR s.location_id=$5) AND ($1::boolean OR EXISTS(SELECT 1 FROM user_locations ul WHERE ul.user_id=$2 AND ul.location_id=s.location_id))";
    const detail=`SELECT s.id,s.created_at,s.total,l.name location_name,u.email cashier,COALESCE((SELECT SUM(si.quantity) FROM sale_items si WHERE si.sale_id=s.id),0) pieces FROM sales s JOIN locations l ON l.id=s.location_id JOIN users u ON u.id=s.cashier_id WHERE ${where} ORDER BY s.created_at DESC,s.id DESC`;
    if(url.pathname.endsWith('.csv')){
      const result=await pool.query(detail+' LIMIT 5001',params);
      if(result.rows.length>5000)fail(422,'CSV export exceeds 5000 invoices; narrow the dates or branch');
      res.writeHead(200,{'content-type':'text/csv; charset=utf-8','content-disposition':'attachment; filename="madar-sales.csv"','cache-control':'no-store'});res.end(salesCsv(result.rows));return;
    }
    const page=Number(url.searchParams.get('page')||1);
    if(!Number.isSafeInteger(page)||page<1||page>100)fail(400,'Invalid page');
    const [summary,branches,records,topProducts]=await Promise.all([
      pool.query(`SELECT COUNT(*) invoices,COALESCE(SUM(s.total),0) total,COALESCE(SUM(q.pieces),0) pieces FROM sales s LEFT JOIN LATERAL (SELECT SUM(si.quantity) pieces FROM sale_items si WHERE si.sale_id=s.id) q ON true WHERE ${where}`,params),
      pool.query(`SELECT l.id,l.name,COUNT(*) invoices,COALESCE(SUM(s.total),0) total FROM sales s JOIN locations l ON l.id=s.location_id WHERE ${where} GROUP BY l.id,l.name ORDER BY total DESC,l.name`,params),
      pool.query(detail+' LIMIT 50 OFFSET $6',[...params,(page-1)*50]),
      pool.query(`SELECT v.sku,p.name,v.size,v.color,SUM(si.quantity) pieces,SUM(si.quantity*si.unit_price) total FROM sales s JOIN sale_items si ON si.sale_id=s.id JOIN variants v ON v.id=si.variant_id JOIN products p ON p.id=v.product_id WHERE ${where} GROUP BY v.id,p.id ORDER BY pieces DESC,total DESC LIMIT 10`,params)
    ]);
    send(res,200,{range,summary:summary.rows[0],branches:branches.rows,topProducts:topProducts.rows,records:records.rows,page,pageSize:50});return;
  }
  if(req.method==='GET'&&url.pathname==='/api/locations'){
    const r=await pool.query('SELECT l.id,l.name,l.kind FROM locations l WHERE l.active AND ($1::boolean OR EXISTS(SELECT 1 FROM user_locations ul WHERE ul.user_id=$2 AND ul.location_id=l.id)) ORDER BY l.kind DESC,l.name',[user.role==='admin',user.id]);
    send(res,200,r.rows);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/locations'){
    if(user.role!=='admin') fail(403,'Admin only');
    const input=await body(req);
    if(typeof input.name!=='string'||input.name.trim().length<2||input.name.length>100||!['branch','warehouse'].includes(input.kind))fail(400,'Invalid location');
    const result=await transaction(async c=>{
      let r=await c.query('INSERT INTO locations(name,kind) VALUES($1,$2) RETURNING id,name,kind',[input.name.trim(),input.kind]);
      await c.query('INSERT INTO audit_logs(actor_id,location_id,action) VALUES($1,$2,$3)',[user.id,r.rows[0].id,'location.create']);
      return r.rows[0];
    });send(res,201,result);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/users'){
    if(!['admin','branch_manager'].includes(user.role)) fail(403,'Access denied');
    const input=await body(req),email=normalEmail(input.email);
    if(!uuid(input.locationId)||!['cashier','branch_manager','stock_manager'].includes(input.role))fail(400,'Invalid account');
    if(user.role==='branch_manager'&&input.role!=='cashier')fail(403,'Managers create cashiers only');
    await canUse(user,input.locationId);
    const location=await pool.query('SELECT kind,active FROM locations WHERE id=$1',[input.locationId]);
    if(!location.rowCount||!location.rows[0].active||((input.role==='cashier'||input.role==='branch_manager')&&location.rows[0].kind!=='branch'))fail(400,'Invalid assigned location');
    const passwordHash=await hashPassword(input.password);
    const created=await transaction(async c=>{
      let r=await c.query('INSERT INTO users(email,password_hash,role,created_by) VALUES($1,$2,$3,$4) RETURNING id,email,role',[email,passwordHash,input.role,user.id]);
      await c.query('INSERT INTO user_locations(user_id,location_id) VALUES($1,$2)',[r.rows[0].id,input.locationId]);
      await c.query('INSERT INTO audit_logs(actor_id,location_id,action,target_id) VALUES($1,$2,$3,$4)',[user.id,input.locationId,'user.create',r.rows[0].id]);
      return r.rows[0];
    });send(res,201,created);return;
  }
  if(req.method==='GET'&&url.pathname==='/api/users'){
    if(!['admin','branch_manager'].includes(user.role))fail(403,'Access denied');
    const r=await pool.query('SELECT u.id,u.email,u.role,u.active,l.id AS "locationId",l.name AS "locationName" FROM users u JOIN user_locations ul ON ul.user_id=u.id JOIN locations l ON l.id=ul.location_id WHERE ($1::boolean OR EXISTS(SELECT 1 FROM user_locations mine WHERE mine.user_id=$2 AND mine.location_id=l.id)) AND ($1::boolean OR u.role=$3) ORDER BY l.name,u.email',[user.role==='admin',user.id,'cashier']);
    send(res,200,r.rows);return;
  }
  const disable=url.pathname.match(/^\/api\/users\/([0-9a-f-]+)\/disable$/i);
  if(req.method==='POST'&&disable){
    if(!uuid(disable[1])||!['admin','branch_manager'].includes(user.role)||disable[1]===user.id)fail(403,'Access denied');
    const result=await transaction(async c=>{
      const target=await c.query('SELECT id,role FROM users WHERE id=$1 FOR UPDATE',[disable[1]]);
      if(!target.rowCount)fail(404,'User not found');
      if(user.role==='branch_manager'){
        if(target.rows[0].role!=='cashier')fail(403,'Access denied');
        const owns=await c.query('SELECT 1 FROM user_locations t JOIN user_locations m ON m.location_id=t.location_id WHERE t.user_id=$1 AND m.user_id=$2',[disable[1],user.id]);
        if(!owns.rowCount)fail(403,'Access denied');
      }
      await c.query('UPDATE users SET active=false,session_version=session_version+1 WHERE id=$1',[disable[1]]);
      await c.query('DELETE FROM sessions WHERE user_id=$1',[disable[1]]);
      await c.query('INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,$2,$3)',[user.id,'user.disable',disable[1]]);
      return {ok:true};
    });send(res,200,result);return;
  }
  const reset=url.pathname.match(/^\/api\/users\/([0-9a-f-]+)\/password$/i);
  if(req.method==='POST'&&reset){
    if(!uuid(reset[1])||!['admin','branch_manager'].includes(user.role))fail(403,'Access denied');
    const input=await body(req),passwordHash=await hashPassword(input.password);
    const result=await transaction(async c=>{
      const target=await c.query('SELECT id,role FROM users WHERE id=$1 FOR UPDATE',[reset[1]]);
      if(!target.rowCount)fail(404,'User not found');
      if(user.role==='branch_manager'){
        if(target.rows[0].role!=='cashier')fail(403,'Access denied');
        const scope=await c.query('SELECT 1 FROM user_locations t JOIN user_locations m ON m.location_id=t.location_id WHERE t.user_id=$1 AND m.user_id=$2',[reset[1],user.id]);
        if(!scope.rowCount)fail(403,'Access denied');
      }
      await c.query('UPDATE users SET password_hash=$2,session_version=session_version+1 WHERE id=$1',[reset[1],passwordHash]);
      await c.query('DELETE FROM sessions WHERE user_id=$1',[reset[1]]);
      await c.query('INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,$2,$3)',[user.id,'user.password_reset',reset[1]]);
      return {ok:true};
    });send(res,200,result);return;
  }
  if(req.method==='GET'&&url.pathname==='/api/inventory'){
    const locationId=url.searchParams.get('locationId');if(!uuid(locationId))fail(400,'locationId required');
    await canUse(user,locationId);
    const r=await pool.query('SELECT v.id AS "variantId",p.name,v.sku,v.size,v.color,v.sale_price AS price,COALESCE(b.quantity,0) AS quantity FROM variants v JOIN products p ON p.id=v.product_id LEFT JOIN stock_balances b ON b.variant_id=v.id AND b.location_id=$1 WHERE p.active ORDER BY p.name,v.sku',[locationId]);
    send(res,200,r.rows.map(row=>({...row,priceQuote:createPriceQuote(priceSecret,locationId,row.variantId,row.price)})));return;
  }
  if(req.method==='GET'&&url.pathname==='/api/transfers'){
    if(!['admin','stock_manager'].includes(user.role))fail(403,'Stock permission required');
    const r=await pool.query("SELECT t.id,t.quantity,t.completed_at,source.name AS source_name,destination.name AS destination_name,p.name AS product_name,v.sku,v.size,v.color FROM transfers t JOIN locations source ON source.id=t.source_id JOIN locations destination ON destination.id=t.destination_id JOIN variants v ON v.id=t.variant_id JOIN products p ON p.id=v.product_id WHERE $1::boolean OR (EXISTS(SELECT 1 FROM user_locations ul WHERE ul.user_id=$2 AND ul.location_id=t.source_id) AND EXISTS(SELECT 1 FROM user_locations ul WHERE ul.user_id=$2 AND ul.location_id=t.destination_id)) ORDER BY t.completed_at DESC,t.id DESC LIMIT 30",[user.role==='admin',user.id]);
    send(res,200,r.rows);return;
  }
  if(url.pathname.startsWith('/api/shopify/')){
    if(user.role!=='admin')fail(403,'Admin only');
    if(req.method==='GET'&&url.pathname==='/api/shopify/status'){
      const settings=await pool.query('SELECT warehouse_location_id,shopify_location_gid,sync_enabled FROM shopify_settings WHERE id=true');
      const counts=await pool.query('SELECT status,count(*)::int AS count FROM shopify_sync_queue GROUP BY status');
      let shop=null,error=null;
      try{shop=(await shopStatus()).shop}catch(err){error=err.message}
      send(res,200,{shop,connection:error?'error':'connected',error,settings:settings.rows[0]||null,queue:counts.rows});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/shopify/settings'){
      const input=await body(req);
      if(!uuid(input.warehouseLocationId)||!/^gid:\/\/shopify\/Location\/[0-9]+$/.test(input.shopifyLocationGid||''))fail(400,'Invalid Shopify location configuration');
      const loc=await pool.query("SELECT 1 FROM locations WHERE id=$1 AND kind='warehouse' AND active",[input.warehouseLocationId]);
      if(!loc.rowCount)fail(400,'Choose an active warehouse');
      const prior=await pool.query('SELECT warehouse_location_id,shopify_location_gid FROM shopify_settings WHERE id=true');
      if(prior.rowCount&&(prior.rows[0].warehouse_location_id!==input.warehouseLocationId||prior.rows[0].shopify_location_gid!==input.shopifyLocationGid)){
        const linked=await pool.query('SELECT EXISTS(SELECT 1 FROM shopify_variant_links) AS linked');
        if(linked.rows[0].linked)fail(409,'Unlink and reconcile variants before changing Shopify or warehouse location');
      }
      const result=await transaction(async c=>{
        const r=await c.query('INSERT INTO shopify_settings(id,warehouse_location_id,shopify_location_gid) VALUES(true,$1,$2) ON CONFLICT(id) DO UPDATE SET warehouse_location_id=EXCLUDED.warehouse_location_id,shopify_location_gid=EXCLUDED.shopify_location_gid,sync_enabled=false RETURNING warehouse_location_id,shopify_location_gid,sync_enabled',[input.warehouseLocationId,input.shopifyLocationGid]);
        await c.query('INSERT INTO audit_logs(actor_id,action) VALUES($1,$2)',[user.id,'shopify.settings']);return r.rows[0];
      });send(res,200,result);return;
    }
    if(req.method==='POST'&&url.pathname==='/api/shopify/enable'){
      const input=await body(req);
      if(typeof input.enabled!=='boolean')fail(400,'enabled must be boolean');
      if(input.enabled){
        if(process.env.SHOPIFY_WRITES_ENABLED!=='true')fail(403,'Shopify writes are disabled in server configuration');
        const setting=await pool.query('SELECT warehouse_location_id,shopify_location_gid FROM shopify_settings WHERE id=true');
        if(!setting.rowCount)fail(400,'Configure Shopify location first');
        const unallocated=await pool.query('SELECT count(*)::int AS count FROM shopify_orders o LEFT JOIN shopify_order_allocations a ON a.order_gid=o.order_gid WHERE a.order_gid IS NULL AND o.cancelled_at IS NULL');
        if(unallocated.rows[0].count)fail(409,'Review and allocate imported orders first');
        const returns=await pool.query("SELECT count(*)::int AS count FROM shopify_orders o JOIN shopify_order_allocations a ON a.order_gid=o.order_gid WHERE o.review_status='pending'");
        if(returns.rows[0].count)fail(409,'Review cancellations and refunds of allocated orders first');
        const conflicts=await pool.query("SELECT count(*)::int AS count FROM shopify_sync_queue WHERE status='conflict'");
        if(conflicts.rows[0].count)fail(409,'Resolve Shopify queue conflicts first');
        const links=await pool.query("SELECT l.inventory_item_gid,v.sku,COALESCE(b.quantity,0)::int AS quantity,COALESCE((SELECT sum(q.delta) FROM shopify_sync_queue q WHERE q.variant_id=v.id AND q.status='pending'),0)::int AS pending_delta FROM shopify_variant_links l JOIN variants v ON v.id=l.variant_id LEFT JOIN stock_balances b ON b.variant_id=v.id AND b.location_id=$1 ORDER BY v.sku LIMIT 101",[setting.rows[0].warehouse_location_id]);
        if(!links.rowCount||links.rowCount>100)fail(409,'Link between 1 and 100 variants before enabling sync');
        for(const link of links.rows){
          const remote=await remoteInventory(link.inventory_item_gid,setting.rows[0].shopify_location_gid);
          if(remote.sku!==link.sku||remote.quantity+link.pending_delta!==link.quantity)fail(409,'Stock baseline differs for '+link.sku+'; reconcile before enabling');
        }
      }
      const enabled=await transaction(async c=>{const r=await c.query('UPDATE shopify_settings SET sync_enabled=$1 WHERE id=true RETURNING sync_enabled',[input.enabled]);if(!r.rowCount)fail(400,'Configure Shopify first');await c.query('INSERT INTO audit_logs(actor_id,action,details) VALUES($1,$2,$3)',[user.id,'shopify.sync_toggle',{enabled:input.enabled}]);return r.rows[0]});
      send(res,200,enabled);return;
    }
    if(req.method==='POST'&&url.pathname==='/api/shopify/sync-run'){
      send(res,200,await syncOne(pool));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/shopify/mappings'){
      const input=await body(req);
      if(!uuid(input.variantId)||!/^gid:\/\/shopify\/InventoryItem\/[0-9]+$/.test(input.inventoryItemGid||''))fail(400,'Invalid variant mapping');
      const setting=await pool.query('SELECT warehouse_location_id,shopify_location_gid FROM shopify_settings WHERE id=true');
      if(!setting.rowCount)fail(400,'Configure Shopify location first');
      const local=await pool.query('SELECT sku FROM variants WHERE id=$1',[input.variantId]);if(!local.rowCount)fail(404,'Variant not found');
      const oldLink=await pool.query('SELECT inventory_item_gid FROM shopify_variant_links WHERE variant_id=$1',[input.variantId]);
      if(oldLink.rowCount&&oldLink.rows[0].inventory_item_gid!==input.inventoryItemGid)fail(409,'Existing Shopify mapping cannot be changed while its history is retained');
      const remote=await remoteInventory(input.inventoryItemGid,setting.rows[0].shopify_location_gid);
      if(remote.sku!==local.rows[0].sku)fail(409,'SKU differs between POS and Shopify');
      const result=await transaction(async c=>{
        await c.query('INSERT INTO shopify_variant_links(variant_id,inventory_item_gid) VALUES($1,$2) ON CONFLICT(variant_id) DO NOTHING',[input.variantId,input.inventoryItemGid]);
        const actual=await c.query('SELECT inventory_item_gid FROM shopify_variant_links WHERE variant_id=$1',[input.variantId]);
        if(actual.rows[0].inventory_item_gid!==input.inventoryItemGid)fail(409,'Variant already linked elsewhere');
        await c.query('UPDATE shopify_order_items SET variant_id=$1 WHERE sku=$2 AND variant_id IS NULL',[input.variantId,local.rows[0].sku]);
        await c.query('INSERT INTO audit_logs(actor_id,location_id,action,target_id) VALUES($1,$2,$3,$4)',[user.id,setting.rows[0].warehouse_location_id,'shopify.mapping',input.variantId]);
        return {variantId:input.variantId,localSku:local.rows[0].sku,remoteQuantity:remote.quantity};
      });send(res,200,result);return;
    }
    if(req.method==='GET'&&url.pathname==='/api/shopify/reconcile'){
      const settings=await pool.query('SELECT warehouse_location_id,shopify_location_gid FROM shopify_settings WHERE id=true');
      if(!settings.rowCount)fail(400,'Configure Shopify location first');
      const rows=await pool.query('SELECT l.variant_id,v.sku,l.inventory_item_gid,COALESCE(b.quantity,0) AS local_quantity FROM shopify_variant_links l JOIN variants v ON v.id=l.variant_id LEFT JOIN stock_balances b ON b.variant_id=l.variant_id AND b.location_id=$1 ORDER BY v.sku LIMIT 20',[settings.rows[0].warehouse_location_id]);
      const output=[];
      for(const row of rows.rows){
        try{const remote=await remoteInventory(row.inventory_item_gid,settings.rows[0].shopify_location_gid);output.push({variantId:row.variant_id,sku:row.sku,localQuantity:row.local_quantity,shopifyQuantity:remote.quantity,status:Number(row.local_quantity)===remote.quantity?'matched':'different'})}
        catch(err){output.push({variantId:row.variant_id,sku:row.sku,status:'error',error:err.message})}
      }
      send(res,200,{items:output,limited:rows.rowCount===20,writeEnabled:false});return;
    }
    if(req.method==='GET'&&url.pathname==='/api/shopify/queue'){
      const jobs=await pool.query('SELECT q.id,v.sku,q.desired_quantity,q.status,q.attempts,q.last_error,q.created_at FROM shopify_sync_queue q JOIN variants v ON v.id=q.variant_id ORDER BY q.id DESC LIMIT 100');
      send(res,200,jobs.rows);return;
    }
    if(req.method==='GET'&&url.pathname==='/api/shopify/orders'){
      const orders=await pool.query("SELECT o.order_gid,o.order_name,o.last_topic,o.financial_status,o.fulfillment_status,o.cancelled_at,o.review_status,o.created_at,a.allocated_at,r.returned_at,count(i.line_item_id)::int AS items,count(i.line_item_id) FILTER (WHERE i.variant_id IS NULL)::int AS unmapped_items FROM shopify_orders o LEFT JOIN shopify_order_items i ON i.order_gid=o.order_gid LEFT JOIN shopify_order_allocations a ON a.order_gid=o.order_gid LEFT JOIN shopify_order_returns r ON r.order_gid=o.order_gid GROUP BY o.order_gid,a.allocated_at,r.returned_at ORDER BY o.created_at DESC LIMIT 100");
      send(res,200,orders.rows);return;
    }
    const allocate=url.pathname.match(/^\/api\/shopify\/orders\/([0-9]+)\/allocate$/);
    if(req.method==='POST'&&allocate){
      const orderGid='gid://shopify/Order/'+allocate[1];
      const result=await transaction(async c=>{
        const order=await c.query('SELECT order_gid,cancelled_at FROM shopify_orders WHERE order_gid=$1 FOR UPDATE',[orderGid]);
        if(!order.rowCount)fail(404,'Order not found');
        const existing=await c.query('SELECT operation_id,allocated_at FROM shopify_order_allocations WHERE order_gid=$1',[orderGid]);
        if(existing.rowCount)return {operationId:existing.rows[0].operation_id,allocatedAt:existing.rows[0].allocated_at,duplicate:true};
        if(order.rows[0].cancelled_at)fail(409,'Cancelled order needs manual review');
        const setting=await c.query('SELECT warehouse_location_id FROM shopify_settings WHERE id=true');if(!setting.rowCount)fail(400,'Warehouse not configured');
        const items=await c.query('SELECT variant_id,SUM(quantity)::int AS quantity FROM shopify_order_items WHERE order_gid=$1 GROUP BY variant_id ORDER BY variant_id',[orderGid]);
        if(!items.rowCount||items.rows.some(x=>!x.variant_id||x.quantity<1))fail(409,'All order items must be linked and have positive quantities');
        const locationId=setting.rows[0].warehouse_location_id,operationId=randomUUID();
        await c.query("SET LOCAL app.skip_shopify_queue = 'on'");
        await c.query("INSERT INTO operations(id,kind,request_hash,location_id,user_id) VALUES($1,'shopify_sale',$2,$3,$4)",[operationId,sha256(orderGid),locationId,user.id]);
        for(const item of items.rows){
          const balance=await c.query('SELECT quantity FROM stock_balances WHERE location_id=$1 AND variant_id=$2 FOR UPDATE',[locationId,item.variant_id]);
          if(!balance.rowCount||balance.rows[0].quantity<item.quantity)fail(409,'Insufficient warehouse stock');
          await c.query('UPDATE stock_balances SET quantity=quantity-$3,version=version+1 WHERE location_id=$1 AND variant_id=$2',[locationId,item.variant_id,item.quantity]);
          await c.query("INSERT INTO stock_movements(operation_id,location_id,variant_id,kind,delta) VALUES($1,$2,$3,'shopify_sale',$4)",[operationId,locationId,item.variant_id,-item.quantity]);
        }
        const allocated=await c.query('INSERT INTO shopify_order_allocations(order_gid,operation_id,location_id,allocated_by) VALUES($1,$2,$3,$4) RETURNING allocated_at',[orderGid,operationId,locationId,user.id]);
        await c.query("UPDATE shopify_orders SET review_status='reviewed' WHERE order_gid=$1",[orderGid]);
        const output={operationId,allocatedAt:allocated.rows[0].allocated_at,duplicate:false};
        await c.query('UPDATE operations SET result=$2 WHERE id=$1',[operationId,output]);
        await c.query('INSERT INTO audit_logs(actor_id,location_id,action,details) VALUES($1,$2,$3,$4)',[user.id,locationId,'shopify.order.allocate',{orderGid}]);
        return output;
      });send(res,200,result);return;
    }
    const returnOrder=url.pathname.match(/^\/api\/shopify\/orders\/([0-9]+)\/return$/);
    if(req.method==='POST'&&returnOrder){
      const orderGid='gid://shopify/Order/'+returnOrder[1];
      const result=await transaction(async c=>{
        const order=await c.query('SELECT cancelled_at,last_topic FROM shopify_orders WHERE order_gid=$1 FOR UPDATE',[orderGid]);
        if(!order.rowCount)fail(404,'Order not found');
        const old=await c.query('SELECT operation_id,returned_at FROM shopify_order_returns WHERE order_gid=$1',[orderGid]);
        if(old.rowCount)return {operationId:old.rows[0].operation_id,returnedAt:old.rows[0].returned_at,duplicate:true};
        if(!order.rows[0].cancelled_at)fail(409,'Only cancelled orders can be fully restocked here');
        const allocation=await c.query('SELECT location_id FROM shopify_order_allocations WHERE order_gid=$1',[orderGid]);
        if(!allocation.rowCount)fail(409,'Order was not allocated from the warehouse');
        const items=await c.query('SELECT variant_id,SUM(quantity)::int AS quantity FROM shopify_order_items WHERE order_gid=$1 GROUP BY variant_id ORDER BY variant_id',[orderGid]);
        if(!items.rowCount||items.rows.some(x=>!x.variant_id||x.quantity<1))fail(409,'Order items need review');
        const operationId=randomUUID(),locationId=allocation.rows[0].location_id;
        await c.query("SET LOCAL app.skip_shopify_queue = 'on'");
        await c.query("INSERT INTO operations(id,kind,request_hash,location_id,user_id) VALUES($1,'shopify_return',$2,$3,$4)",[operationId,sha256(orderGid+':return'),locationId,user.id]);
        for(const item of items.rows){
          await c.query('INSERT INTO stock_balances(location_id,variant_id,quantity) VALUES($1,$2,$3) ON CONFLICT(location_id,variant_id) DO UPDATE SET quantity=stock_balances.quantity+EXCLUDED.quantity,version=stock_balances.version+1',[locationId,item.variant_id,item.quantity]);
          await c.query("INSERT INTO stock_movements(operation_id,location_id,variant_id,kind,delta) VALUES($1,$2,$3,'shopify_return',$4)",[operationId,locationId,item.variant_id,item.quantity]);
        }
        const saved=await c.query('INSERT INTO shopify_order_returns(order_gid,operation_id,returned_by) VALUES($1,$2,$3) RETURNING returned_at',[orderGid,operationId,user.id]);
        await c.query("UPDATE shopify_orders SET review_status='reviewed' WHERE order_gid=$1",[orderGid]);
        const output={operationId,returnedAt:saved.rows[0].returned_at,duplicate:false};
        await c.query('UPDATE operations SET result=$2 WHERE id=$1',[operationId,output]);
        await c.query('INSERT INTO audit_logs(actor_id,location_id,action,details) VALUES($1,$2,$3,$4)',[user.id,locationId,'shopify.order.cancelled_return',{orderGid}]);return output;
      });send(res,200,result);return;
    }
  }
  if(req.method==='GET'&&url.pathname==='/api/products'){
    if(!['admin','stock_manager'].includes(user.role))fail(403,'Stock permission required');
    const r=await pool.query('SELECT p.id AS "productId",p.name,p.brand,p.category,v.id AS "variantId",v.sku,v.size,v.color,v.sale_price AS price FROM products p JOIN variants v ON v.product_id=p.id WHERE p.active ORDER BY p.name,v.sku');
    send(res,200,r.rows);return;
  }
  const addVariant=url.pathname.match(/^\/api\/products\/([0-9a-f-]{36})\/variants$/);
  if(req.method==='POST'&&addVariant){
    if(user.role!=='admin')fail(403,'Admin only');
    if(!uuid(addVariant[1]))fail(400,'Invalid product');
    const input=await body(req);
    if(typeof input.sku!=='string'||!/^[A-Za-z0-9._-]{2,64}$/.test(input.sku)||typeof input.size!=='string'||!input.size.trim()||input.size.length>100||typeof input.color!=='string'||!input.color.trim()||input.color.length>100||!['number','string'].includes(typeof input.price)||String(input.price).trim()===''||!Number.isFinite(Number(input.price))||Number(input.price)<0||Number(input.price)>100000000)fail(400,'Invalid variant');
    const created=await transaction(async c=>{
      const p=await c.query('SELECT id FROM products WHERE id=$1 AND active FOR UPDATE',[addVariant[1]]);if(!p.rowCount)fail(404,'Product not found');
      const v=await c.query('INSERT INTO variants(product_id,sku,size,color,sale_price) VALUES($1,$2,$3,$4,$5) RETURNING id,sku',[addVariant[1],input.sku,input.size.trim(),input.color.trim(),Number(input.price).toFixed(2)]);
      await c.query('INSERT INTO audit_logs(actor_id,action,target_id,details) VALUES($1,$2,$3,$4)',[user.id,'product.variant_create',addVariant[1],{variantId:v.rows[0].id}]);
      return {productId:addVariant[1],variantId:v.rows[0].id,sku:v.rows[0].sku};
    });send(res,201,created);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/products'){
    if(user.role!=='admin')fail(403,'Admin only');
    const input=await body(req);
    if(typeof input.name!=='string'||input.name.trim().length<2||input.name.length>120||typeof input.sku!=='string'||!/^[A-Za-z0-9._-]{2,64}$/.test(input.sku)||typeof input.size!=='string'||!input.size.trim()||typeof input.color!=='string'||!input.color.trim()||!Number.isFinite(Number(input.price))||Number(input.price)<0||Number(input.price)>100000000)fail(400,'Invalid product');
    const created=await transaction(async c=>{
      const p=await c.query('INSERT INTO products(name) VALUES($1) RETURNING id',[input.name.trim()]);
      const v=await c.query('INSERT INTO variants(product_id,sku,size,color,sale_price) VALUES($1,$2,$3,$4,$5) RETURNING id,sku',[p.rows[0].id,input.sku,input.size.trim(),input.color.trim(),Number(input.price).toFixed(2)]);
      await c.query('INSERT INTO audit_logs(actor_id,action,target_id) VALUES($1,$2,$3)',[user.id,'product.create',p.rows[0].id]);return {productId:p.rows[0].id,variantId:v.rows[0].id,sku:v.rows[0].sku};
    });send(res,201,created);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/receipts'){
    if(!['admin','stock_manager'].includes(user.role))fail(403,'Stock permission required');
    const input=await body(req);
    if(!uuid(input.operationId)||!uuid(input.locationId)||!uuid(input.variantId)||!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>100000)fail(400,'Invalid receipt');
    await canUse(user,input.locationId);
    const result=await transaction(async c=>{
      const loc=await c.query('SELECT 1 FROM locations WHERE id=$1 AND active',[input.locationId]);if(!loc.rowCount)fail(400,'Invalid location');
      const variant=await c.query('SELECT 1 FROM variants WHERE id=$1',[input.variantId]);if(!variant.rowCount)fail(400,'Unknown variant');
      const fingerprint=sha256(JSON.stringify({locationId:input.locationId,variantId:input.variantId,quantity:input.quantity}));
      const ins=await c.query("INSERT INTO operations(id,kind,request_hash,location_id,user_id) VALUES($1,'receipt',$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id",[input.operationId,fingerprint,input.locationId,user.id]);
      if(!ins.rowCount){const old=await c.query('SELECT user_id,kind,request_hash,result FROM operations WHERE id=$1',[input.operationId]);if(!old.rowCount||old.rows[0].user_id!==user.id||old.rows[0].kind!=='receipt'||old.rows[0].request_hash!==fingerprint)fail(409,'Operation ID already used');return old.rows[0].result}
      const balance=await c.query('INSERT INTO stock_balances(location_id,variant_id,quantity) VALUES($1,$2,$3) ON CONFLICT(location_id,variant_id) DO UPDATE SET quantity=stock_balances.quantity+EXCLUDED.quantity,version=stock_balances.version+1 RETURNING quantity',[input.locationId,input.variantId,input.quantity]);
      await c.query("INSERT INTO stock_movements(operation_id,location_id,variant_id,kind,delta) VALUES($1,$2,$3,'receipt',$4)",[input.operationId,input.locationId,input.variantId,input.quantity]);
      const out={operationId:input.operationId,quantity:balance.rows[0].quantity};
      await c.query('UPDATE operations SET result=$2 WHERE id=$1',[input.operationId,out]);
      await c.query('INSERT INTO audit_logs(actor_id,location_id,action,target_id) VALUES($1,$2,$3,$4)',[user.id,input.locationId,'stock.receipt',input.variantId]);return out;
    });send(res,201,result);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/transfers'){
    if(!['admin','stock_manager'].includes(user.role))fail(403,'Stock permission required');
    const input=await body(req);
    if(!uuid(input.operationId)||!uuid(input.sourceId)||!uuid(input.destinationId)||input.sourceId===input.destinationId||!uuid(input.variantId)||!Number.isSafeInteger(input.quantity)||input.quantity<1||input.quantity>100000)fail(400,'Invalid transfer');
    await canUse(user,input.sourceId);await canUse(user,input.destinationId);
    const fingerprint=sha256(JSON.stringify({sourceId:input.sourceId,destinationId:input.destinationId,variantId:input.variantId,quantity:input.quantity}));
    const result=await transaction(async c=>{
      const locations=await c.query('SELECT id FROM locations WHERE id=ANY($1::uuid[]) AND active ORDER BY id FOR UPDATE',[ [input.sourceId,input.destinationId] ]);
      if(locations.rowCount!==2)fail(400,'Inactive location');
      const ins=await c.query("INSERT INTO operations(id,kind,request_hash,location_id,user_id) VALUES($1,'transfer',$2,$3,$4) ON CONFLICT(id) DO NOTHING RETURNING id",[input.operationId,fingerprint,input.sourceId,user.id]);
      if(!ins.rowCount){const old=await c.query('SELECT user_id,kind,request_hash,result FROM operations WHERE id=$1',[input.operationId]);if(!old.rowCount||old.rows[0].user_id!==user.id||old.rows[0].kind!=='transfer'||old.rows[0].request_hash!==fingerprint)fail(409,'Operation ID already used');return old.rows[0].result}
      const source=await c.query('SELECT quantity FROM stock_balances WHERE location_id=$1 AND variant_id=$2 FOR UPDATE',[input.sourceId,input.variantId]);
      if(!source.rowCount||source.rows[0].quantity<input.quantity)fail(409,'Insufficient source stock');
      await c.query('UPDATE stock_balances SET quantity=quantity-$3,version=version+1 WHERE location_id=$1 AND variant_id=$2',[input.sourceId,input.variantId,input.quantity]);
      const dest=await c.query('INSERT INTO stock_balances(location_id,variant_id,quantity) VALUES($1,$2,$3) ON CONFLICT(location_id,variant_id) DO UPDATE SET quantity=stock_balances.quantity+EXCLUDED.quantity,version=stock_balances.version+1 RETURNING quantity',[input.destinationId,input.variantId,input.quantity]);
      const transfer=await c.query('INSERT INTO transfers(operation_id,source_id,destination_id,variant_id,quantity,requested_by,completed_at) VALUES($1,$2,$3,$4,$5,$6,now()) RETURNING id',[input.operationId,input.sourceId,input.destinationId,input.variantId,input.quantity,user.id]);
      await c.query("INSERT INTO stock_movements(operation_id,location_id,variant_id,kind,delta) VALUES($1,$2,$3,'transfer_out',$4),($1,$5,$3,'transfer_in',$6)",[input.operationId,input.sourceId,input.variantId,-input.quantity,input.destinationId,input.quantity]);
      const out={transferId:transfer.rows[0].id,operationId:input.operationId,destinationQuantity:dest.rows[0].quantity};
      await c.query('UPDATE operations SET result=$2 WHERE id=$1',[input.operationId,out]);
      await c.query('INSERT INTO audit_logs(actor_id,location_id,action,target_id) VALUES($1,$2,$3,$4)',[user.id,input.sourceId,'stock.transfer',transfer.rows[0].id]);return out;
    });send(res,201,result);return;
  }
  if(req.method==='POST'&&url.pathname==='/api/sales'){
    if(!['admin','cashier','branch_manager'].includes(user.role))fail(403,'Sales permission required');
    const input=await body(req);
    if(!uuid(input.operationId)||!uuid(input.locationId))fail(400,'Invalid operation or location');
    await canUse(user,input.locationId);
    const items=canonicalItems(input.items);
    const loc=await pool.query('SELECT 1 FROM locations WHERE id=$1 AND kind=$2 AND active',[input.locationId,'branch']);
    if(!loc.rowCount)fail(400,'Sales require an active branch');
    const requestHash=sha256(JSON.stringify({locationId:input.locationId,items}));
    const result=await transaction(async c=>{
      const createdAt=typeof input.clientCreatedAt==='string'&&!Number.isNaN(Date.parse(input.clientCreatedAt))?input.clientCreatedAt:null;
      const inserted=await c.query("INSERT INTO operations(id,kind,request_hash,location_id,user_id,device_id,client_created_at) VALUES($1,'sale',$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING RETURNING id",[input.operationId,requestHash,input.locationId,user.id,uuid(input.deviceId)?input.deviceId:null,createdAt]);
      if(!inserted.rowCount){
        const previous=await c.query('SELECT user_id,location_id,kind,request_hash,result FROM operations WHERE id=$1',[input.operationId]);
        if(!previous.rowCount||previous.rows[0].user_id!==user.id||previous.rows[0].location_id!==input.locationId||previous.rows[0].kind!=='sale'||previous.rows[0].request_hash!==requestHash)fail(409,'Operation ID already used');
        return previous.rows[0].result;
      }
      let total=0;const priced=[];
      for(const item of items){
        let cents;
        try{cents=verifyPriceQuote(priceSecret,item.priceQuote,input.locationId,item.variantId)}
        catch{fail(409,'Price quote expired or invalid; refresh inventory')}
        const row=await c.query('SELECT v.sale_price AS price,b.quantity,p.active FROM stock_balances b JOIN variants v ON v.id=b.variant_id JOIN products p ON p.id=v.product_id WHERE b.location_id=$1 AND b.variant_id=$2 FOR UPDATE OF b',[input.locationId,item.variantId]);
        if(!row.rowCount||!row.rows[0].active||row.rows[0].quantity<item.quantity)fail(409,'Insufficient branch stock');
        if(!Number.isSafeInteger(cents))fail(500,'Invalid price');
        total+=cents*item.quantity;priced.push({...item,price:cents});
        await c.query('UPDATE stock_balances SET quantity=quantity-$3,version=version+1 WHERE location_id=$1 AND variant_id=$2',[input.locationId,item.variantId,item.quantity]);
      }
      if(!Number.isSafeInteger(total))fail(400,'Total exceeds supported range');
      const sale=await c.query('INSERT INTO sales(operation_id,location_id,cashier_id,total) VALUES($1,$2,$3,$4) RETURNING id',[input.operationId,input.locationId,user.id,(total/100).toFixed(2)]);
      for(const item of priced){
        await c.query('INSERT INTO sale_items(sale_id,variant_id,quantity,unit_price) VALUES($1,$2,$3,$4)',[sale.rows[0].id,item.variantId,item.quantity,(item.price/100).toFixed(2)]);
        await c.query("INSERT INTO stock_movements(operation_id,location_id,variant_id,kind,delta) VALUES($1,$2,$3,'sale',$4)",[input.operationId,input.locationId,item.variantId,-item.quantity]);
      }
      const output={saleId:sale.rows[0].id,operationId:input.operationId,total:(total/100).toFixed(2)};
      await c.query('UPDATE operations SET result=$2 WHERE id=$1',[input.operationId,output]);
      await c.query('INSERT INTO audit_logs(actor_id,location_id,action,target_id,details) VALUES($1,$2,$3,$4,$5)',[user.id,input.locationId,'sale.create',sale.rows[0].id,{total:output.total}]);
      return output;
    });send(res,201,result);return;
  }
  fail(404,'Not found');
}
export async function handler(req,res){return route(req,res).catch(err=>{
  const status=err.status || (err.code==='23505'?409:500);
  if(status===500)console.error(err);
  if(!res.headersSent)send(res,status,{error:status===500?'Server error':err.code==='23505'?'This value already exists':err.message});else res.end();
})}
export const runShopifySync=()=>syncOne(pool);

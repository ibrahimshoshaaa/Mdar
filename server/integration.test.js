import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {PGlite} from '@electric-sql/pglite';
import {PGLiteSocketServer} from '@electric-sql/pglite-socket';
import {hashPassword} from './security.js';
import 'fake-indexeddb/auto';
globalThis.window=globalThis;
await import('../ui/offline.js');
delete globalThis.window;

test('full API inventory, sales, reports, roles and cashier device cycle', {timeout:60000}, async()=>{
  const db=await PGlite.create();let child,socket,log='';
  try{
    const root=new URL('../',import.meta.url);
    // gen_random_uuid is built into PostgreSQL; PGlite omits the unused pgcrypto extension.
    await db.exec((await readFile(new URL('schema.sql',root),'utf8')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
    for(const file of ['migration-002-shopify.sql','migration-003-shopify-orders.sql','migration-004-shopify-allocation.sql','migration-005-shopify-cancellations.sql','migration-006-cashier-device.sql'])await db.exec(await readFile(new URL(file,root),'utf8'));
    const password='integration-test-password';
    await db.query("INSERT INTO users(email,password_hash,role) VALUES($1,$2,'admin')",['admin@test.local',await hashPassword(password)]);
    socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:15439});await socket.start();
    child=spawn(process.execPath,['server/index.js'],{cwd:root,env:{...process.env,DATABASE_URL:'postgresql://postgres:postgres@127.0.0.1:15439/postgres',DATABASE_POOL_MAX:'1',PORT:'15440',PRICE_QUOTE_SECRET:'integration-only-secret-'.repeat(3),SHOPIFY_WRITES_ENABLED:'false'}});
    child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Server startup failed: '+log)),10000);child.stdout.on('data',()=>{if(log.includes('Madar listening')){clearTimeout(timer);resolve()}});child.on('exit',()=>{clearTimeout(timer);reject(new Error(log))})});
    const request=async(path,{cookie,body,method=body?'POST':'GET',status=200}={})=>{
      let response;try{response=await fetch('http://127.0.0.1:15440'+path,{method,headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)})}catch(err){throw new Error(path+' failed: '+err.message+' '+log,{cause:err})}
      const text=await response.text();assert.equal(response.status,status,path+' '+text+' '+log);
      return {value:response.headers.get('content-type')?.includes('json')?JSON.parse(text):text,cookie:response.headers.get('set-cookie')?.split(';')[0]};
    };
    const admin=(await request('/api/login',{body:{email:'admin@test.local',password}})).cookie;
    const makeLocation=async(name,kind)=>(await request('/api/locations',{cookie:admin,body:{name,kind},status:201})).value.id;
    const warehouse=await makeLocation('Test warehouse','warehouse'),branch=await makeLocation('Test branch','branch'),other=await makeLocation('Other branch','branch');
    const product=(await request('/api/products',{cookie:admin,body:{name:'Test shirt',sku:'SHIRT-B-L',size:'L',color:'Black',price:100},status:201})).value;
    await request('/api/products/'+product.productId+'/variants',{cookie:admin,body:{sku:'SHIRT-W-M',size:'M',color:'White',price:120},status:201});
    assert.equal((await request('/api/products',{cookie:admin})).value.length,2);
    const receipt={operationId:crypto.randomUUID(),locationId:warehouse,variantId:product.variantId,quantity:20};
    await request('/api/receipts',{cookie:admin,body:receipt,status:201});await request('/api/receipts',{cookie:admin,body:receipt,status:201});
    const transfer={operationId:crypto.randomUUID(),sourceId:warehouse,destinationId:branch,variantId:product.variantId,quantity:8};
    await request('/api/transfers',{cookie:admin,body:transfer,status:201});await request('/api/transfers',{cookie:admin,body:transfer,status:201});
    await request('/api/transfers',{cookie:admin,body:{...transfer,operationId:crypto.randomUUID(),quantity:50},status:409});
    await request('/api/users',{cookie:admin,body:{email:'cashier@test.local',password,role:'cashier',locationId:branch},status:201});
    const deviceId=crypto.randomUUID(),cashier=(await request('/api/login',{body:{email:'cashier@test.local',password,deviceId}})).cookie;
    await request('/api/login',{body:{email:'cashier@test.local',password,deviceId:crypto.randomUUID()},status:409});
    await request('/api/inventory?locationId='+other,{cookie:cashier,status:403});
    const inventory=(await request('/api/inventory?locationId='+branch,{cookie:cashier})).value,item=inventory.find(x=>x.variantId===product.variantId);
    assert.equal(Number(item.quantity),8);
    const sale={operationId:crypto.randomUUID(),locationId:branch,items:[{variantId:product.variantId,quantity:3,priceQuote:item.priceQuote}]};
    await request('/api/sales',{cookie:cashier,body:sale,status:201});await request('/api/sales',{cookie:cashier,body:sale,status:201});
    assert.equal(Number((await request('/api/inventory?locationId='+branch,{cookie:cashier})).value.find(x=>x.variantId===product.variantId).quantity),5);
    assert.equal(Number((await request('/api/inventory?locationId='+warehouse,{cookie:admin})).value.find(x=>x.variantId===product.variantId).quantity),12);
    const today=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(p=>[p.type,p.value]));
    const date=today.year+'-'+today.month+'-'+today.day,query='?from='+date+'&to='+date;
    const report=(await request('/api/reports/sales'+query,{cookie:admin})).value;
    assert.equal(Number(report.summary.total),300);assert.equal(Number(report.summary.invoices),1);assert.equal(Number(report.topProducts[0].pieces),3);
    assert.match((await request('/api/reports/sales.csv'+query,{cookie:admin})).value,/cashier@test.local/);
    await request('/api/reports/sales'+query,{cookie:cashier,status:403});
    await request('/api/reports/sales?from=2026-02-30&to=2026-03-01',{cookie:admin,status:400});
    await request('/api/users',{cookie:admin,body:{email:'manager@test.local',password,role:'branch_manager',locationId:other},status:201});
    const manager=(await request('/api/login',{body:{email:'manager@test.local',password}})).cookie;
    assert.equal(Number((await request('/api/reports/sales'+query,{cookie:manager})).value.summary.total),0);
    await request('/api/reports/sales'+query+'&locationId='+branch,{cookie:manager,status:403});
    await request('/api/users',{cookie:manager,body:{email:'own-cashier@test.local',password,role:'cashier',locationId:other},status:201});
    await request('/api/users',{cookie:manager,body:{email:'wrong-branch@test.local',password,role:'cashier',locationId:branch},status:403});
    assert.equal(Number((await request('/api/dashboard',{cookie:admin})).value.sales.total),300);
    assert.equal((await request('/api/transfers',{cookie:admin})).value.length,1);
    const me=(await request('/api/me',{cookie:cashier})).value;
    const cached=(await request('/api/inventory?locationId='+branch,{cookie:cashier})).value;
    await MadarOffline.snapshot(me.id,branch,cached);
    await MadarOffline.sell(me.id,branch,[{variantId:product.variantId,quantity:1}]);
    await MadarOffline.sell(me.id,branch,[{variantId:product.variantId,quantity:1}]);
    assert.equal((await MadarOffline.inventory(me.id,branch)).find(x=>x.variantId===product.variantId).quantity,3);
    assert.equal(Number((await request('/api/inventory?locationId='+branch,{cookie:cashier})).value.find(x=>x.variantId===product.variantId).quantity),5);
    const queued=await MadarOffline.allPending(me.id);assert.equal(queued.length,2);
    for(const queuedSale of queued){
      const payload={operationId:queuedSale.operationId,locationId:branch,clientCreatedAt:queuedSale.createdAt,items:queuedSale.items.map(({variantId,quantity,priceQuote})=>({variantId,quantity,priceQuote}))};
      await request('/api/sales',{cookie:cashier,body:payload,status:201});
      await request('/api/sales',{cookie:cashier,body:payload,status:201});
      await MadarOffline.setStatus(queuedSale.operationId,'synced');
    }
    assert.equal((await MadarOffline.allPending(me.id)).length,0);
    assert.equal(Number((await request('/api/inventory?locationId='+branch,{cookie:cashier})).value.find(x=>x.variantId===product.variantId).quantity),3);
    assert.equal(Number((await request('/api/reports/sales'+query,{cookie:admin})).value.summary.total),500);
    await request('/api/cashier-devices/'+branch+'/release',{cookie:admin,body:{pendingInvoicesChecked:true}});
    await request('/api/me',{cookie:cashier,status:401});
    await request('/api/login',{body:{email:'cashier@test.local',password,deviceId:crypto.randomUUID()}});
  }finally{
    if(child&&child.exitCode===null){child.kill('SIGTERM');await once(child,'exit')}
    if(socket){await socket.stop();await new Promise(resolve=>setTimeout(resolve,100))}await db.close();
  }
});

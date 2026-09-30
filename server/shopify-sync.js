import { remoteInventory, adjustInventory } from './shopify.js';

export async function syncOne(pool){
  if(process.env.SHOPIFY_WRITES_ENABLED!=='true')return {status:'disabled'};
  let job;
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    await c.query("UPDATE shopify_sync_queue SET status='pending' WHERE status='processing' AND next_attempt_at<now()");
    const r=await c.query("SELECT q.id,q.delta,q.idempotency_key,q.change_from_quantity,q.attempts,l.inventory_item_gid,s.shopify_location_gid,v.sku FROM shopify_sync_queue q JOIN shopify_variant_links l ON l.variant_id=q.variant_id JOIN variants v ON v.id=q.variant_id CROSS JOIN shopify_settings s WHERE s.sync_enabled AND q.status='pending' AND q.next_attempt_at<=now() AND NOT EXISTS (SELECT 1 FROM shopify_sync_queue earlier WHERE earlier.variant_id=q.variant_id AND earlier.id<q.id AND earlier.status IN ('pending','processing','conflict')) ORDER BY q.id LIMIT 1 FOR UPDATE OF q SKIP LOCKED");
    if(!r.rowCount){await c.query('COMMIT');return {status:'empty'}}
    job=r.rows[0];
    await c.query("UPDATE shopify_sync_queue SET status='processing',next_attempt_at=now()+interval '2 minutes',attempts=attempts+1 WHERE id=$1",[job.id]);
    await c.query('COMMIT');
  }catch(err){await c.query('ROLLBACK');throw err}
  finally{c.release()}
  try{
    let previousQuantity=job.change_from_quantity;
    if(previousQuantity===null){
      const remote=await remoteInventory(job.inventory_item_gid,job.shopify_location_gid);
      if(remote.sku!==job.sku||!Number.isSafeInteger(remote.quantity))throw new Error('Shopify mapping or stock level invalid');
      previousQuantity=remote.quantity;
      await pool.query("UPDATE shopify_sync_queue SET change_from_quantity=$2 WHERE id=$1 AND status='processing'",[job.id,previousQuantity]);
    }
    await adjustInventory({inventoryItemId:job.inventory_item_gid,locationId:job.shopify_location_gid,delta:job.delta,previousQuantity,idempotencyKey:job.idempotency_key});
    await pool.query("UPDATE shopify_sync_queue SET status='synced',last_error=NULL WHERE id=$1 AND status='processing'",[job.id]);
    return {status:'synced',id:job.id};
  }catch(err){
    const stale=/CHANGE_FROM_QUANTITY_STALE/.test(err.message);
    const conflict=/mapping|stock level invalid|inventory conflict/i.test(err.message)&&!stale;
    const delay=Math.min(3600,Math.pow(2,Math.min(job.attempts+1,8))*10);
    if(stale){
      // A compare-and-set failure did not change stock; a new key may use a fresh comparison.
      await pool.query("UPDATE shopify_sync_queue SET status='pending',change_from_quantity=NULL,idempotency_key=gen_random_uuid(),last_error=$2,next_attempt_at=now()+($3::int*interval '1 second') WHERE id=$1 AND status='processing'",[job.id,String(err.message).slice(0,500),delay]);
    }else{
      // A timeout may have succeeded remotely: retain the same key and comparison for retry.
      await pool.query("UPDATE shopify_sync_queue SET status=$2,last_error=$3,next_attempt_at=now()+($4::int*interval '1 second') WHERE id=$1 AND status='processing'",[job.id,conflict?'conflict':'pending',String(err.message).slice(0,500),delay]);
    }
    return {status:conflict?'conflict':'retry',id:job.id,error:err.message};
  }
}

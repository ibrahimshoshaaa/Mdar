/* Cashier device storage. All stock deductions and queued sales commit in one IndexedDB transaction. */
(function () {
  const DB_NAME='madar-pos-device-v1';
  const VERSION=2;
  function open(){
    return new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,VERSION);
      request.onupgradeneeded=()=>{
        const db=request.result;
        if(!db.objectStoreNames.contains('stock'))db.createObjectStore('stock',{keyPath:'key'});
        if(!db.objectStoreNames.contains('sales'))db.createObjectStore('sales',{keyPath:'operationId'});
        if(!db.objectStoreNames.contains('auth'))db.createObjectStore('auth',{keyPath:'email'});
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error);
    });
  }
  function complete(tx){return new Promise((resolve,reject)=>{tx.oncomplete=()=>resolve();tx.onabort=()=>reject(tx.error||new Error('Local transaction aborted'));tx.onerror=()=>reject(tx.error||new Error('Local transaction failed'))})}
  function request(req){return new Promise((resolve,reject)=>{req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error)})}
  const key=(userId,locationId,variantId)=>[userId,locationId,variantId].join(':');
  async function pending(userId,locationId){
    const db=await open();
    try{
      const tx=db.transaction('sales','readonly'),rows=await request(tx.objectStore('sales').getAll());
      return rows.filter(s=>s.userId===userId && s.locationId===locationId && s.status!=='synced').sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    }finally{db.close()}
  }
  async function allPending(userId){
    const db=await open();
    try{const tx=db.transaction('sales','readonly'),rows=await request(tx.objectStore('sales').getAll());
      return rows.filter(s=>s.userId===userId&&s.status!=='synced').sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    }finally{db.close()}
  }
  async function allUnsent(){
    const db=await open();
    try{const tx=db.transaction('sales','readonly'),rows=await request(tx.objectStore('sales').getAll());
      return rows.filter(s=>s.status!=='synced').sort((a,b)=>a.createdAt.localeCompare(b.createdAt));
    }finally{db.close()}
  }
  async function snapshot(userId,locationId,rows){
    const db=await open();
    try{
      const tx=db.transaction(['stock','sales'],'readwrite'),store=tx.objectStore('stock');
      const sales=await request(tx.objectStore('sales').getAll());
      if(sales.some(s=>s.userId===userId&&s.locationId===locationId&&s.status!=='synced')){
        tx.abort();throw new Error('Sync pending sales before refreshing the local balance');
      }
      const existing=await request(store.getAll());
      for(const row of existing)if(row.userId===userId&&row.locationId===locationId)store.delete(row.key);
      for(const row of rows)store.put({key:key(userId,locationId,row.variantId),userId,locationId,variantId:row.variantId,name:row.name,sku:row.sku,size:row.size,color:row.color,price:row.price,priceQuote:row.priceQuote,quantity:Number(row.quantity)});
      await complete(tx);
    }finally{db.close()}
  }
  async function inventory(userId,locationId){
    const db=await open();
    try{const tx=db.transaction('stock','readonly'),rows=await request(tx.objectStore('stock').getAll());
      return rows.filter(row=>row.userId===userId&&row.locationId===locationId);
    }finally{db.close()}
  }
  async function sell(userId,locationId,items){
    if(!userId||!locationId||!Array.isArray(items)||!items.length)throw new Error('Invalid local sale');
    const db=await open(),operationId=crypto.randomUUID(),createdAt=new Date().toISOString();
    try{
      const tx=db.transaction(['stock','sales'],'readwrite'),stock=tx.objectStore('stock');
      const unique=new Set(),prices=[];
      try{
        for(const item of [...items].sort((a,b)=>a.variantId.localeCompare(b.variantId))){
          if(unique.has(item.variantId)||!Number.isSafeInteger(item.quantity)||item.quantity<1)throw new Error('Invalid sale item');
          unique.add(item.variantId);
          const row=await request(stock.get(key(userId,locationId,item.variantId)));
          if(!row||row.quantity<item.quantity)throw new Error('رصيد الفرع غير كافٍ');
          if(typeof row.priceQuote!=='string')throw new Error('افتح الفرع بالإنترنت لتحديث سعر الصنف');
          try{
            const encoded=row.priceQuote.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');
            const quote=JSON.parse(atob(encoded));
            if(!Number.isSafeInteger(quote.expiresAt)||Date.now()>quote.expiresAt)throw new Error();
          }catch{throw new Error('انتهت صلاحية أسعار الأصناف؛ اتصل بالإنترنت قبل بيع جديد')}
          row.quantity-=item.quantity;stock.put(row);
          prices.push({variantId:item.variantId,quantity:item.quantity,unitPrice:row.price,priceQuote:row.priceQuote});
        }
        tx.objectStore('sales').add({operationId,userId,locationId,items:prices,createdAt,status:'pending',error:null});
      }catch(err){tx.abort();throw err}
      await complete(tx);
      return {operationId,items:prices,createdAt};
    }finally{db.close()}
  }
  async function setStatus(operationId,status,error=null){
    const db=await open();
    try{
      const tx=db.transaction('sales','readwrite'),store=tx.objectStore('sales'),sale=await request(store.get(operationId));
      if(sale){sale.status=status;sale.error=error;store.put(sale)}
      await complete(tx);
    }finally{db.close()}
  }
  async function derive(password,salt){
    const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
    const result=await crypto.subtle.deriveBits({name:'PBKDF2',salt,iterations:300000,hash:'SHA-256'},key,256);
    return new Uint8Array(result);
  }
  async function rememberCashier(user,password,locations){
    if(user.role!=='cashier'||typeof password!=='string')return;
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const verifier=await derive(password,salt);
    const db=await open();
    try{const tx=db.transaction('auth','readwrite');tx.objectStore('auth').put({email:user.email.toLowerCase(),id:user.id,role:user.role,locations,deviceId:localStorage.getItem('madar-cashier-device'),salt:Array.from(salt),verifier:Array.from(verifier),expiresAt:Date.now()+12*60*60*1000});await complete(tx)}
    finally{db.close()}
  }
  async function offlineCashier(email,password){
    const db=await open();let record;
    try{const tx=db.transaction('auth','readonly');record=await request(tx.objectStore('auth').get(email.toLowerCase().trim()))}
    finally{db.close()}
    if(!record||record.role!=='cashier'||record.expiresAt<Date.now()||!record.deviceId||record.deviceId!==localStorage.getItem('madar-cashier-device'))throw new Error('يلزم تسجيل الدخول بالإنترنت لتحديث صلاحية الجهاز');
    const candidate=await derive(password,new Uint8Array(record.salt));let diff=0;
    for(let i=0;i<candidate.length;i++)diff|=candidate[i]^record.verifier[i];
    if(diff)throw new Error('بيانات الدخول غير صحيحة');
    return {user:{id:record.id,email:record.email,role:record.role},locations:record.locations};
  }
  window.MadarOffline={pending,allPending,allUnsent,snapshot,inventory,sell,setStatus,rememberCashier,offlineCashier};
})();

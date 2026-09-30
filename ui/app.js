// This layer activates only when the page is served by the POS API.
// Opening index.html directly remains a visual-only design preview.
if (location.protocol === 'http:' || location.protocol === 'https:') {
  const state = { user:null, locations:[], inventory:[], syncing:false, offline:false };
  const css = document.createElement('style');
  css.textContent = '.auth-shade{position:fixed;inset:0;background:#102b3f;z-index:30;display:grid;place-items:center;padding:18px}.auth-card{background:white;border-radius:20px;width:min(100%,420px);padding:28px;box-shadow:0 20px 60px #071a2940}.auth-card h1{margin:8px 0 6px;font-size:1.6rem}.auth-card p{color:#5e7482;line-height:1.6}.auth-card label{display:grid;gap:7px;margin:15px 0}.auth-card input{padding:12px;border:1px solid #c9d8e1;border-radius:10px;width:100%}.auth-error{color:#b42d2d;min-height:1.4em}.session-bar{display:flex;align-items:center;gap:8px}.session-bar button{border:1px solid #d5e1e8;background:white;border-radius:9px;padding:8px 11px}.loading-note{padding:12px;background:#fff3df;border-radius:9px;color:#77540a;margin:12px 0}';
  document.head.append(css);
  const shade = document.createElement('div');
  shade.className='auth-shade';
  shade.innerHTML='<form class="auth-card"><div class="brand"><span class="mark">م</span> مدار</div><h1>تسجيل الدخول</h1><p>ادخل بحساب الإدارة أو الفرع للوصول للمخزون والمبيعات.</p><label>البريد الإلكتروني<input name="email" type="email" autocomplete="username" required></label><label>كلمة المرور<input name="password" type="password" autocomplete="current-password" required></label><div class="auth-error" role="alert"></div><button class="primary" style="width:100%">دخول</button></form>';
  document.body.append(shade);
  const api = async (path, options={}) => {
    const response = await fetch(path,{ credentials:'same-origin', headers:{'content-type':'application/json'}, ...options });
    const result = await response.json();
    if (!response.ok){const error=new Error(result.error || 'تعذر تنفيذ العملية');error.status=response.status;throw error}
    return result;
  };
  const errorText = err => err.message==='Failed to fetch' ? 'تعذر الاتصال بالخادم. تحقق من الإنترنت وأعد المحاولة.' : err.message;
  function deviceId(){let id=localStorage.getItem('madar-cashier-device');if(!/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(id||'')){id=crypto.randomUUID();localStorage.setItem('madar-cashier-device',id)}return id}
  const session = document.createElement('div');
  session.className='session-bar';
  document.querySelector('.top-actions').prepend(session);
  const formatNumber=value=>Number(value||0).toLocaleString('ar-EG');
  async function loadDashboard(){
    if(!state.user)return;
    try{
      const report=await api('/api/dashboard');
      e('dash-sales').textContent=formatNumber(report.sales.total)+' ج.م';
      e('dash-invoices').textContent=formatNumber(report.sales.invoices)+' فاتورة اليوم';
      e('dash-pieces').textContent=formatNumber(report.stock.pieces);
      e('dash-transfers').textContent=formatNumber(report.transfers.completed);
      e('dash-low').textContent=formatNumber(report.stock.low_variants);
      e('dash-date').textContent=new Intl.DateTimeFormat('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'full'}).format(new Date());
      const tbody=e('dash-recent');tbody.replaceChildren();
      for(const sale of report.recent){const tr=document.createElement('tr');for(const value of ['#'+sale.id.slice(0,8),sale.location_name,sale.cashier,formatNumber(sale.total)+' ج.م',new Date(sale.created_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'short',timeStyle:'short'})]){const td=document.createElement('td');td.textContent=value;tr.append(td)}tbody.append(tr)}
      if(!report.recent.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.textContent='لا توجد مبيعات مسجلة بعد.';tr.append(td);tbody.append(tr)}
      const sites=e('dash-locations');sites.replaceChildren();
      for(const site of report.locations){const row=document.createElement('div');row.className='branch-row';const name=document.createElement('div');const title=document.createElement('b');title.textContent=site.name;const hint=document.createElement('small');hint.textContent=site.kind==='warehouse'?'مخزن':'فرع';name.append(title,hint);const amount=document.createElement('span');amount.className='number';amount.textContent=formatNumber(site.pieces)+' قطعة';row.append(name,amount);sites.append(row)}
      if(!report.locations.length)sites.textContent='لا توجد مواقع متاحة.';
    }catch(err){e('dash-date').textContent='تعذر تحديث الملخص';e('dash-recent').replaceChildren();e('dash-locations').textContent='اتصل بالخادم لعرض الأرصدة الحالية.'}
  }
  document.addEventListener('click',ev=>{if(ev.target.closest('[data-go="dashboard"]'))loadDashboard()});
  labels.shopify='Shopify';icons.shopify='◇';
  for(const id of ['desktop-nav','mobile-nav']){
    const b=document.createElement('button');b.dataset.go='shopify';b.innerHTML='<span aria-hidden="true" style="font-size:1.25rem;line-height:1">◇</span><span>Shopify</span>';e(id).append(b)
  }
  const shopSection=document.createElement('section');shopSection.id='shopify';shopSection.className='view';
  labels.reports='التقارير';icons.reports='▥';
  for(const id of ['desktop-nav','mobile-nav']){const b=document.createElement('button');b.dataset.go='reports';b.innerHTML='<span aria-hidden="true" style="font-size:1.25rem;line-height:1">▥</span><span>التقارير</span>';e(id).append(b)}
  const reportSection=document.createElement('section');reportSection.id='reports';reportSection.className='view';
  reportSection.innerHTML='<div class="panel"><div class="panel-head"><h3>تقرير المبيعات</h3><span class="muted" id="report-status">اختر الفترة</span></div><div class="report-presets"><button type="button" class="secondary" data-period="today">اليوم</button><button type="button" class="secondary" data-period="yesterday">أمس</button><button type="button" class="secondary" data-period="seven">آخر ٧ أيام</button><button type="button" class="secondary" data-period="thirty">آخر ٣٠ يومًا</button><button type="button" class="secondary" data-period="month">هذا الشهر</button></div><form id="report-filters" class="report-filters"><label class="field">من<input name="from" type="date" required></label><label class="field">إلى<input name="to" type="date" required></label><label class="field">الفرع<select name="locationId"><option value="">كل الفروع المصرح بها</option></select></label><button class="primary">عرض</button><button type="button" class="secondary" id="report-export">تصدير CSV</button></form></div><div class="grid" style="margin-top:16px"><div class="card accent"><span class="label">إجمالي المبيعات</span><strong id="report-total">—</strong></div><div class="card"><span class="label">الفواتير</span><strong id="report-invoices">—</strong></div><div class="card"><span class="label">القطع المباعة</span><strong id="report-pieces">—</strong></div></div><div class="section-row"><h2>المبيعات حسب الفرع</h2></div><div class="panel table-wrap"><table><thead><tr><th>الفرع</th><th>الفواتير</th><th>الإجمالي</th></tr></thead><tbody id="report-branches"></tbody></table></div><div class="section-row"><h2>الفواتير</h2><span class="muted">٥٠ فاتورة في الصفحة</span></div><div class="panel table-wrap"><table><thead><tr><th>الفاتورة</th><th>الوقت</th><th>الفرع</th><th>الكاشير</th><th>القطع</th><th>الإجمالي</th></tr></thead><tbody id="report-records"></tbody></table><div class="report-pages"><button class="secondary" id="report-prev" type="button">السابق</button><span id="report-page">١</span><button class="secondary" id="report-next" type="button">التالي</button></div></div>';
  e('dashboard').after(reportSection);
  const topSection=document.createElement('div');topSection.innerHTML='<div class="section-row"><h2>الأصناف الأكثر بيعًا</h2><span class="muted">أعلى ١٠ أصناف</span></div><div class="panel" id="report-products"></div>';
  reportSection.querySelector('#report-branches').closest('.panel').after(topSection);
  const reportForm=reportSection.querySelector('#report-filters');let reportPage=1,reportSerial=0,reportLoaded=false;
  const cairoDate=date=>{const parts=Object.fromEntries(new Intl.DateTimeFormat('en-US',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(date).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));return parts.year+'-'+parts.month+'-'+parts.day};
  function setReportPeriod(period){
    const today=cairoDate(new Date()),day=new Date(today+'T12:00:00Z'),shift=days=>{const d=new Date(day);d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10)};
    let from=today,to=today;
    if(period==='yesterday')from=to=shift(-1);
    if(period==='seven')from=shift(-6);
    if(period==='thirty')from=shift(-29);
    if(period==='month')from=today.slice(0,8)+'01';
    reportForm.elements.from.value=from;reportForm.elements.to.value=to;reportPage=1;loadReport();
  }
  function reportParams(){return new URLSearchParams({from:reportForm.elements.from.value,to:reportForm.elements.to.value,locationId:reportForm.elements.locationId.value})}
  function fillReportRows(id,rows,keys,empty){const tbody=e(id);tbody.replaceChildren();for(const row of rows){const tr=document.createElement('tr');for(const key of keys){const td=document.createElement('td');td.textContent=key(row);tr.append(td)}tbody.append(tr)}if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=keys.length;td.textContent=empty;tr.append(td);tbody.append(tr)}}
  async function loadReport(){
    if(!state.user||state.user.role==='cashier')return;
    const serial=++reportSerial;e('report-status').textContent='جارٍ تحميل التقرير...';
    try{
      const params=reportParams();params.set('page',reportPage);
      const report=await api('/api/reports/sales?'+params);
      if(serial!==reportSerial)return;
      reportLoaded=true;e('report-total').textContent=formatNumber(report.summary.total)+' ج.م';e('report-invoices').textContent=formatNumber(report.summary.invoices);e('report-pieces').textContent=formatNumber(report.summary.pieces);
      fillReportRows('report-branches',report.branches,[r=>r.name,r=>formatNumber(r.invoices),r=>formatNumber(r.total)+' ج.م'],'لا توجد مبيعات في الفترة.');
      const products=e('report-products');products.replaceChildren();
      const highest=Math.max(1,...report.topProducts.map(x=>Number(x.pieces)));
      for(const item of report.topProducts){const row=document.createElement('div');row.className='report-product';const heading=document.createElement('div');heading.className='report-product-head';const title=document.createElement('b');title.textContent=item.name+' · '+item.color+' / '+item.size+' · '+item.sku;const count=document.createElement('span');count.textContent=formatNumber(item.pieces)+' قطعة · '+formatNumber(item.total)+' ج.م';heading.append(title,count);const track=document.createElement('div');track.className='report-track';const fill=document.createElement('div');fill.style.width=Math.max(2,Number(item.pieces)/highest*100)+'%';track.append(fill);row.append(heading,track);products.append(row)}
      if(!report.topProducts.length)products.textContent='لا توجد أصناف مباعة في الفترة.';
      fillReportRows('report-records',report.records,[r=>'#'+r.id.slice(0,8),r=>new Date(r.created_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'short',timeStyle:'short'}),r=>r.location_name,r=>r.cashier,r=>formatNumber(r.pieces),r=>formatNumber(r.total)+' ج.م'],'لا توجد فواتير في هذه الصفحة.');
      e('report-page').textContent=formatNumber(reportPage);e('report-prev').disabled=reportPage===1;e('report-next').disabled=reportPage*report.pageSize>=Number(report.summary.invoices)||reportPage>=100;
      e('report-status').textContent='آخر تحديث: '+new Date().toLocaleTimeString('ar-EG',{timeZone:'Africa/Cairo'});
    }catch(err){if(serial===reportSerial)e('report-status').textContent=errorText(err)}
  }
  reportSection.querySelectorAll('[data-period]').forEach(button=>button.onclick=()=>setReportPeriod(button.dataset.period));
  reportForm.onsubmit=ev=>{ev.preventDefault();reportPage=1;loadReport()};
  reportForm.elements.locationId.onchange=()=>{reportPage=1;loadReport()};
  e('report-prev').onclick=()=>{if(reportPage>1){reportPage--;loadReport()}};
  e('report-next').onclick=()=>{if(!e('report-next').disabled){reportPage++;loadReport()}};
  e('report-export').onclick=async()=>{
    const button=e('report-export');button.disabled=true;
    try{
      const response=await fetch('/api/reports/sales.csv?'+reportParams(),{credentials:'same-origin'});
      if(!response.ok){const result=await response.json();throw new Error(result.error||'تعذر التصدير')}
      const blob=await response.blob(),link=document.createElement('a'),url=URL.createObjectURL(blob);
      link.href=url;link.download='madar-sales-'+reportForm.elements.from.value+'-'+reportForm.elements.to.value+'.csv';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
    }catch(err){toast(errorText(err))}finally{button.disabled=false}
  };
  document.addEventListener('click',ev=>{if(ev.target.closest('[data-go="reports"]')){if(!reportLoaded)setReportPeriod('today');else loadReport()}});
  shopSection.innerHTML='<div class="notice">تُراجع الطلبات والمخزون هنا. إرسال فروق المخزون إلى Shopify متوقف افتراضيًا ويتطلب تفعيل الأدمن وإعداد الخادم.</div><div class="content-grid"><div class="panel"><div class="panel-head"><h3>الاتصال والمواقع</h3><button class="secondary" id="shop-refresh">تحديث الحالة</button></div><p id="shop-status" class="muted">لم يُفحص الاتصال بعد</p><form id="shop-settings" class="fields"><label class="field">المخزن المصدر<select name="warehouseLocationId" required></select></label><label class="field">معرّف موقع Shopify<input name="shopifyLocationGid" required placeholder="gid://shopify/Location/123"></label><div><button class="primary">حفظ الإعدادات</button></div></form></div><div class="panel"><h3>ربط صنف</h3><p class="muted">يراجع النظام تطابق SKU قبل حفظ الربط.</p><form id="shop-map" class="fields"><label class="field">الصنف المحلي<select name="variantId" required></select></label><label class="field">معرّف Inventory Item<input name="inventoryItemGid" required placeholder="gid://shopify/InventoryItem/123"></label><div><button class="primary">تحقق واربط</button></div></form></div></div><div class="section-row"><h2>مقارنة المخزون</h2><button class="secondary" id="shop-compare">مقارنة الآن</button></div><div class="panel table-wrap"><table><thead><tr><th>SKU</th><th>المخزن</th><th>Shopify</th><th>الحالة</th></tr></thead><tbody id="shop-rows"><tr><td colspan="4">اربط الأصناف ثم اضغط مقارنة.</td></tr></tbody></table></div><div class="section-row"><h2>قائمة المزامنة</h2></div><div class="panel table-wrap"><table><thead><tr><th>SKU</th><th>الكمية المطلوبة</th><th>الحالة</th><th>وقت التسجيل</th></tr></thead><tbody id="shop-queue"><tr><td colspan="4">لم تُحمّل القائمة بعد.</td></tr></tbody></table></div>';
  document.querySelector('.main').append(shopSection);
  const syncControls=document.createElement('div');syncControls.className='panel';syncControls.style.marginTop='16px';
  syncControls.innerHTML='<div class="panel-head"><h3>إرسال تغييرات المخزن</h3><span id="shop-sync-mode" class="badge low">متوقف</span></div><p class="muted">التفعيل يتحقق من رصيد البداية والطلبات المعلقة. تغييرات المخزن تُرسل كفروق، وطلبات Shopify المعتمدة لا تُخصم من المتجر مرة ثانية.</p><div class="toolbar"><button id="shop-enable" class="primary">تفعيل المزامنة</button><button id="shop-disable" class="secondary">إيقاف المزامنة</button><button id="shop-run" class="secondary">محاولة إرسال الآن</button></div>';
  shopSection.querySelector('.content-grid').after(syncControls);
  e('shop-enable').onclick=async()=>{try{await api('/api/shopify/enable',{method:'POST',body:JSON.stringify({enabled:true})});toast('تم تفعيل إرسال المخزون');await shopRefresh()}catch(err){toast(errorText(err))}};
  e('shop-disable').onclick=async()=>{try{await api('/api/shopify/enable',{method:'POST',body:JSON.stringify({enabled:false})});toast('توقفت المزامنة');await shopRefresh()}catch(err){toast(errorText(err))}};
  e('shop-run').onclick=async()=>{try{const result=await api('/api/shopify/sync-run',{method:'POST',body:'{}'});toast('النتيجة: '+result.status);await shopRefresh()}catch(err){toast(errorText(err))}};
  const ordersPanel=document.createElement('div');ordersPanel.innerHTML='<div class="section-row"><h2>طلبات Shopify الواردة</h2><button class="secondary" id="shop-orders-refresh">تحديث الطلبات</button></div><div class="panel table-wrap"><table><thead><tr><th>الطلب</th><th>الحالة</th><th>الأصناف</th><th>غير المربوط</th><th>المخزن</th><th>وقت الوصول</th></tr></thead><tbody id="shop-orders"><tr><td colspan="6">لم تُحمّل الطلبات بعد.</td></tr></tbody></table></div>';
  shopSection.append(ordersPanel);
  async function shopOrders(){
    try{const orders=await api('/api/shopify/orders'),tbody=e('shop-orders');tbody.replaceChildren();
      for(const order of orders){
        const tr=document.createElement('tr');
        for(const value of [order.order_name,order.last_topic==='refunds/create'?'مرتجع · راجع':order.cancelled_at?(order.allocated_at?'ملغي بعد الاعتماد · راجع':'ملغي'):order.financial_status||order.last_topic,order.items,order.unmapped_items]){const td=document.createElement('td');td.textContent=value;tr.append(td)}
        const action=document.createElement('td');
        if(order.returned_at)action.textContent='أُعيد للمخزن';
        else if(order.cancelled_at&&order.allocated_at){const button=document.createElement('button');button.className='link';button.textContent='إعادة للمخزن';button.onclick=async()=>{
          if(!confirm('إعادة كل أصناف الطلب '+order.order_name+' للمخزن المحلي؟'))return;
          try{const id=order.order_gid.split('/').at(-1);await api('/api/shopify/orders/'+id+'/return',{method:'POST',body:'{}'});toast('أُعيد الرصيد للمخزن المحلي');await shopOrders();await shopRefresh()}
          catch(err){toast(errorText(err))}
        };action.append(button)}
        else if(order.allocated_at)action.textContent='خُصم مرة واحدة';
        else if(!order.cancelled_at&&Number(order.unmapped_items)===0&&Number(order.items)>0){const button=document.createElement('button');button.className='link';button.textContent='اعتماد وخصم';button.onclick=async()=>{
          if(!confirm('اعتماد الطلب '+order.order_name+' وخصم أصنافه من المخزن؟'))return;
          try{const id=order.order_gid.split('/').at(-1);await api('/api/shopify/orders/'+id+'/allocate',{method:'POST',body:'{}'});toast('تم اعتماد الطلب وخصم المخزن');await shopOrders();await shopRefresh()}
          catch(err){toast(errorText(err))}
        };action.append(button)}else action.textContent='يحتاج مراجعة';
        tr.append(action);const time=document.createElement('td');time.textContent=new Date(order.created_at).toLocaleString('ar-EG');tr.append(time);tbody.append(tr)
      }
      if(!orders.length){const tr=document.createElement('tr');tr.innerHTML='<td colspan="6">لم يصل طلب بعد. أضف رابط الـwebhook في إعدادات متجر الاختبار.</td>';tbody.append(tr)}
    }catch(err){toast(errorText(err))}
  }
  e('shop-orders-refresh').onclick=shopOrders;
  async function shopRefresh(){
    try{
      const status=await api('/api/shopify/status');
      e('shop-status').textContent=status.shop?'متصل: '+status.shop.name:status.error||'غير متصل';
      e('shop-sync-mode').textContent=status.settings?.sync_enabled?'مفعّل':'متوقف';
      const select=e('shop-settings').elements.warehouseLocationId;select.replaceChildren();
      for(const loc of state.locations.filter(l=>l.kind==='warehouse'))select.add(new Option(loc.name,loc.id));
      if(status.settings){select.value=status.settings.warehouse_location_id;e('shop-settings').elements.shopifyLocationGid.value=status.settings.shopify_location_gid}
      const tbody=e('shop-queue');tbody.replaceChildren();
      const jobs=await api('/api/shopify/queue');
      for(const job of jobs){const tr=document.createElement('tr');for(const value of [job.sku,job.desired_quantity,job.status,new Date(job.created_at).toLocaleString('ar-EG')]){const td=document.createElement('td');td.textContent=value;tr.append(td)}tbody.append(tr)}
      if(!jobs.length){const tr=document.createElement('tr');tr.innerHTML='<td colspan="4">لا توجد عمليات.</td>';tbody.append(tr)}
      if(status.settings){const list=await api('/api/inventory?locationId='+status.settings.warehouse_location_id);const variants=e('shop-map').elements.variantId;variants.replaceChildren();for(const item of list)variants.add(new Option(item.name+' · '+item.sku,item.variantId))}
    }catch(err){e('shop-status').textContent=errorText(err)}
  }
  e('shop-refresh').onclick=shopRefresh;
  e('shop-settings').onsubmit=async ev=>{ev.preventDefault();try{const f=Object.fromEntries(new FormData(ev.target));await api('/api/shopify/settings',{method:'POST',body:JSON.stringify(f)});toast('حُفظت المواقع والمزامنة متوقفة');await shopRefresh()}catch(err){toast(errorText(err))}};
  e('shop-map').onsubmit=async ev=>{ev.preventDefault();try{const f=Object.fromEntries(new FormData(ev.target));await api('/api/shopify/mappings',{method:'POST',body:JSON.stringify(f)});toast('تم ربط الصنف');await shopRefresh()}catch(err){toast(errorText(err))}};
  e('shop-compare').onclick=async()=>{try{const report=await api('/api/shopify/reconcile'),tbody=e('shop-rows');tbody.replaceChildren();for(const item of report.items){const tr=document.createElement('tr');for(const value of [item.sku,item.localQuantity??'—',item.shopifyQuantity??'—',item.error||({matched:'متطابق',different:'مختلف'})[item.status]]){const td=document.createElement('td');td.textContent=value;tr.append(td)}tbody.append(tr)}if(!report.items.length){const tr=document.createElement('tr');tr.innerHTML='<td colspan="4">لم تُربط أصناف بعد.</td>';tbody.append(tr)}if(report.limited)toast('عرض أول ٢٠ صنفًا فقط')}catch(err){toast(errorText(err))}};
  document.addEventListener('click',ev=>{if(ev.target.closest('[data-go="shopify"]')&&state.user?.role==='admin'){shopRefresh();shopOrders()}});
  const queuePanel=document.createElement('div');queuePanel.className='notice';
  queuePanel.innerHTML='<span id="sync-summary">جاهز للبيع</span> <button class="link" id="sync-now" type="button">مزامنة الآن</button><div id="sync-errors" style="margin-top:5px"></div>';
  e('pos').prepend(queuePanel);
  async function queueStatus(){
    if(!state.user)return;
    try{
      const unsent=await MadarOffline.allUnsent();
      const mine=unsent.filter(s=>s.userId===state.user.id);
      const conflicts=mine.filter(s=>s.status==='conflict');
      e('sync-summary').textContent=conflicts.length?'تعارض يحتاج مراجعة: '+conflicts.length+' · البيع متوقف في الفرع':mine.length?'فواتير بانتظار المزامنة: '+mine.length:state.offline?'وضع عدم الاتصال · الرصيد المحلي':'كل الفواتير متزامنة';
      e('sync-errors').textContent=conflicts.map(s=>s.operationId+' — '+s.error).join('؛ ');
    }catch(err){e('sync-summary').textContent='التخزين المحلي غير متاح؛ لا يمكن البيع أوفلاين'}
  }
  async function syncPending(){
    if(!state.user||state.syncing)return;
    state.syncing=true;let reauth=false;
    try{
      const unsent=await MadarOffline.allPending(state.user.id);
      for(const sale of unsent){
        if(sale.status==='conflict')break;
        try{
          await api('/api/sales',{method:'POST',body:JSON.stringify({operationId:sale.operationId,locationId:sale.locationId,clientCreatedAt:sale.createdAt,items:sale.items.map(({variantId,quantity,priceQuote})=>({variantId,quantity,priceQuote}))})});
          await MadarOffline.setStatus(sale.operationId,'synced');
        }catch(err){
          if([400,403,409].includes(err.status))await MadarOffline.setStatus(sale.operationId,'conflict',err.message);
          if(err.status===401)reauth=true;
          break;
        }
      }
    }finally{state.syncing=false;await queueStatus();if(reauth){toast('سجّل الدخول بنفس الكاشير لمزامنة الفواتير المعلقة');showLogin()}}
  }
  e('sync-now').onclick=async()=>{await syncPending();await loadInventory()};
  window.addEventListener('online',async()=>{if(state.user){await syncPending();await loadInventory()}});
  setInterval(()=>{if(state.user&&navigator.onLine)syncPending().catch(()=>{})},15000);
  function showLogin(){shade.style.display='grid';state.user=null;session.replaceChildren();}
  async function loadLocations(cachedLocations){
    state.locations=cachedLocations||await api('/api/locations');
    reportForm.elements.locationId.replaceChildren(new Option('كل الفروع المصرح بها',''));
    for(const loc of state.locations.filter(l=>l.kind==='branch'))reportForm.elements.locationId.add(new Option(loc.name,loc.id));
    const branchRows=e('branch-rows');branchRows.replaceChildren();
    for(const loc of state.locations){
      const tr=document.createElement('tr');
      for(const value of [loc.name,loc.kind==='branch'?'فرع':'مخزن','—','—']){let td=document.createElement('td');td.textContent=value;tr.append(td)}
      const td=document.createElement('td');td.textContent='نشط';tr.append(td);branchRows.append(tr);
    }
    for (const id of ['pos-location','stock-location']){
      const select=e(id);select.replaceChildren();
      if(id==='stock-location'&&state.user.role==='admin'){const o=new Option('كل المواقع','all');select.add(o)}
      for(const loc of state.locations){if(id==='pos-location'&&loc.kind!=='branch')continue;select.add(new Option(loc.name,loc.id))}
    }
    e('pos-location').onchange=loadInventory;
    e('stock-location').onchange=loadStock;
    await loadInventory();await loadStock();
  }
  async function loadInventory(){
    const id=e('pos-location').value;
    if(!id){data.splice(0);renderProducts();return}
    let rows;
    const pending=await MadarOffline.pending(state.user.id,id);
    if(pending.length){rows=await MadarOffline.inventory(state.user.id,id);state.offline=true}
    else {
      try{rows=await api('/api/inventory?locationId='+encodeURIComponent(id));await MadarOffline.snapshot(state.user.id,id,rows);state.offline=false}
      catch(err){rows=await MadarOffline.inventory(state.user.id,id);state.offline=true;if(!rows.length)throw err}
    }
    state.inventory=rows;data.splice(0,data.length,...rows.map(x=>({id:x.variantId,name:x.name,variant:x.color+' / '+x.size,sku:x.sku,price:Number(x.price),qty:Number(x.quantity)})));
    cart={};renderCart();renderProducts();
    await queueStatus();
  }
  async function loadStock(){
    const id=e('stock-location').value;
    const locations=id==='all'?state.locations:[state.locations.find(x=>x.id===id)].filter(Boolean);
    const batches=await Promise.all(locations.map(async loc=>{
      try{return {loc,items:await api('/api/inventory?locationId='+encodeURIComponent(loc.id))}}
      catch(err){if(state.user.role!=='cashier')throw err;return {loc,items:await MadarOffline.inventory(state.user.id,loc.id)}}
    }));
    const tbody=e('stock-rows');tbody.replaceChildren();
    for(const {loc,items} of batches)for(const item of items){
      let tr=document.createElement('tr');
      for(const value of [item.name,item.color+' / '+item.size,item.sku,loc.name,item.quantity]){
        let td=document.createElement('td');td.textContent=value;tr.append(td)
      }
      let td=document.createElement('td'),b=document.createElement('span');
      b.className='badge'+(Number(item.quantity)<4?' low':'');b.textContent=Number(item.quantity)<4?'منخفض':'متاح';td.append(b);tr.append(td);tbody.append(tr);
    }
    if(!tbody.children.length){let tr=document.createElement('tr');let td=document.createElement('td');td.colSpan=6;td.textContent='لا توجد أصناف لهذا الموقع';tr.append(td);tbody.append(tr)}
  }
  async function loadUsers(){
    if(!['admin','branch_manager'].includes(state.user.role))return;
    const users=await api('/api/users'),tbody=e('user-rows');tbody.replaceChildren();
    for(const u of users){
      const tr=document.createElement('tr');
      for(const value of [u.email,u.email,({cashier:'كاشير',branch_manager:'مدير فرع',stock_manager:'مسؤول مخزون'})[u.role]||u.role,u.locationName]){
        let td=document.createElement('td');td.textContent=value;tr.append(td)
      }
      const td=document.createElement('td'),b=document.createElement('span');b.className='badge';b.textContent=u.active?'نشط':'معطل';td.append(b);
      if(u.active){let reset=document.createElement('button');reset.className='link';reset.textContent='تغيير كلمة المرور';reset.onclick=async()=>{
        const password=prompt('كلمة المرور الجديدة (١٢ حرفًا على الأقل)');if(password===null)return;
        try{await api('/api/users/'+u.id+'/password',{method:'POST',body:JSON.stringify({password})});toast('تم تغيير كلمة المرور وإغلاق جلسات الحساب')}
        catch(err){toast(errorText(err))}
      };td.append(' ',reset);let btn=document.createElement('button');btn.className='link';btn.textContent='تعطيل';btn.onclick=async()=>{
        if(!confirm('تعطيل حساب '+u.email+'؟'))return;
        try{await api('/api/users/'+u.id+'/disable',{method:'POST',body:'{}'});await loadUsers()}catch(err){toast(errorText(err))}
      };td.append(' ',btn)}
      tr.append(td);tbody.append(tr)
    }
  }
  async function enter(user,password=null,cachedLocations=null){
    state.user=user;
    if(!cachedLocations)await syncPending();
    session.replaceChildren();
    const name=document.createElement('span');name.className='chip';name.textContent=user.email;
    const logout=document.createElement('button');logout.textContent='خروج';logout.onclick=async()=>{try{await api('/api/logout',{method:'POST',body:'{}'})}finally{showLogin()}};
    session.append(name,logout);
    document.querySelector('.location').textContent=user.role==='admin'?'الإدارة العامة / جميع المواقع':'مساحة الفرع';
    document.querySelectorAll('[data-go="branches"]').forEach(x=>x.style.display=user.role==='admin'?'':'none');
    document.querySelectorAll('[data-go="users"]').forEach(x=>x.style.display=['admin','branch_manager'].includes(user.role)?'':'none');
    document.querySelectorAll('[data-go="shopify"]').forEach(x=>x.style.display=user.role==='admin'?'':'none');
    document.querySelectorAll('[data-go="reports"]').forEach(x=>x.style.display=user.role==='cashier'?'none':'');
    e('add-branch').style.display=user.role==='admin'?'':'none';
    if(user.role==='branch_manager'){
      const role=e('user-form').elements.role;role.replaceChildren(new Option('كاشير','cashier'));
    }
    try{await loadLocations(cachedLocations);receiptChoices();if(!cachedLocations){await loadUsers();await loadDashboard();await loadTransfers();await loadDevices();await loadCatalog()}}catch(err){toast(errorText(err))}
    if(password&&!cachedLocations){
      try{await MadarOffline.rememberCashier(user,password,state.locations)}catch(err){toast('لم يُجهز هذا الجهاز للعمل بدون إنترنت')}
    }
    if(!cachedLocations&&'serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
    stockPanel.querySelector('#new-product').style.display=user.role==='admin'?'':'none';
    stockForm.style.display=['admin','stock_manager'].includes(user.role)?'':'none';
    catalogPanel.style.display=user.role==='admin'?'':'none';
    transferHistory.style.display=['admin','stock_manager'].includes(user.role)?'':'none';
    e('transfer-button').style.display=['admin','stock_manager'].includes(user.role)?'':'none';
    navigate(user.role==='cashier'?'pos':'dashboard');shade.style.display='none';
  }
  shade.querySelector('form').onsubmit=async ev=>{
    ev.preventDefault();const button=ev.target.querySelector('button');button.disabled=true;
    const values=Object.fromEntries(new FormData(ev.target));
    try{values.deviceId=deviceId();await api('/api/login',{method:'POST',body:JSON.stringify(values)});await enter(await api('/api/me'),values.password)}
    catch(err){
      if(err instanceof TypeError){
        try{const saved=await MadarOffline.offlineCashier(values.email,values.password);await enter(saved.user,null,saved.locations)}
        catch(localError){shade.querySelector('.auth-error').textContent=errorText(localError)}
      }else shade.querySelector('.auth-error').textContent=errorText(err)
    }
    finally{button.disabled=false}
  };
  api('/api/me').then(enter).catch(showLogin);
  e('search').oninput=renderProducts;
  e('stock-search').oninput=loadStock;
  e('checkout').onclick=async()=>{
    if(!state.user)return;
    const items=Object.entries(cart).filter(([,qty])=>qty>0).map(([sku,quantity])=>({variantId:data.find(p=>p.sku===sku)?.id,quantity}));
    if(!items.length){toast('اختار صنفًا أولًا');return}
    const locationId=e('pos-location').value;
    e('checkout').disabled=true;
    try{
      const other=(await MadarOffline.allUnsent()).some(s=>s.locationId===locationId&&s.userId!==state.user.id);
      if(other)throw new Error('توجد فواتير معلقة لحساب كاشير آخر في هذا الفرع. سجّل دخوله لمزامنتها أولًا.');
      const conflicts=await MadarOffline.pending(state.user.id,locationId);
      if(conflicts.some(s=>s.status==='conflict'))throw new Error('المزامنة متوقفة بسبب تعارض. راجع العملية قبل بيع جديد.');
      const sale=await MadarOffline.sell(state.user.id,locationId,items);
      toast('سُجلت الفاتورة محليًا: '+sale.operationId.slice(0,8));
      await loadInventory();
      if(navigator.onLine){await syncPending();await loadInventory();await loadDashboard()}
    }catch(err){toast(errorText(err))}
    finally{e('checkout').disabled=false}
  };
  e('branch-form').onsubmit=async ev=>{
    ev.preventDefault();const f=new FormData(ev.target);
    try{
      const loc=await api('/api/locations',{method:'POST',body:JSON.stringify({name:f.get('branch'),kind:'branch'})});
      toast('تم إنشاء الفرع. أضف حساب المدير من صفحة المستخدمين.');
      ev.target.reset();e('branch-form-panel').style.display='none';await loadLocations();await loadDevices();
    }catch(err){toast(errorText(err))}
  };
  const userForm=e('user-form');
  let passwordLabel=document.createElement('label');passwordLabel.className='field';
  passwordLabel.textContent='كلمة مرور مؤقتة';
  let pass=document.createElement('input');pass.type='password';pass.name='password';pass.minLength=12;pass.required=true;passwordLabel.append(pass);
  userForm.querySelector('.fields').append(passwordLabel);
  const role=userForm.elements.role;
  role.replaceChildren(new Option('مدير فرع','branch_manager'),new Option('كاشير','cashier'),new Option('مسؤول مخزون','stock_manager'));
  userForm.onsubmit=async ev=>{
    ev.preventDefault();const f=new FormData(ev.target),locationId=userForm.elements.branch.value;
    try{
      await api('/api/users',{method:'POST',body:JSON.stringify({email:f.get('email'),password:f.get('password'),role:f.get('role'),locationId})});
      toast('تم إنشاء الحساب');ev.target.reset();e('user-form-panel').style.display='none';await loadUsers();
    }catch(err){toast(errorText(err))}
  };
  e('add-user').onclick=()=>{
    userForm.elements.branch.replaceChildren();
    for(const loc of state.locations.filter(l=>l.kind==='branch'))userForm.elements.branch.add(new Option(loc.name,loc.id));
    e('user-form-panel').style.display='block';
  };
  const devicesPanel=document.createElement('div');devicesPanel.className='panel';devicesPanel.style.marginTop='16px';
  devicesPanel.innerHTML='<div class="panel-head"><h3>أجهزة الكاشير المسجلة</h3><button class="link" id="devices-refresh" type="button">تحديث</button></div><p class="muted">يسجل النظام متصفح كاشير واحدًا لكل فرع. راجع الفواتير غير المتزامنة على الجهاز القديم قبل تبديله.</p><div class="table-wrap"><table><thead><tr><th>الفرع</th><th>آخر كاشير</th><th>آخر دخول</th><th>الإجراء</th></tr></thead><tbody id="devices-rows"></tbody></table></div>';
  e('branches').append(devicesPanel);
  async function loadDevices(){
    if(state.user?.role!=='admin')return;
    try{
      const devices=await api('/api/cashier-devices'),byLocation=new Map(devices.map(d=>[d.location_id,d])),tbody=e('devices-rows');tbody.replaceChildren();
      for(const loc of state.locations.filter(x=>x.kind==='branch')){
        const d=byLocation.get(loc.id),tr=document.createElement('tr');
        for(const value of [loc.name,d?.cashier||'لا يوجد جهاز',d?new Date(d.last_seen_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo'}):'—']){const td=document.createElement('td');td.textContent=value;tr.append(td)}
        const action=document.createElement('td');
        if(d){const button=document.createElement('button');button.className='link';button.textContent='فك ربط الجهاز';button.onclick=async()=>{
          if(!confirm('تأكد أولًا من مزامنة كل الفواتير المعلقة على الجهاز القديم لفرع '+loc.name+'. فك الربط يبطل جلساته المتصلة، وقد تبقى فواتير أوفلاين تحتاج مراجعة. هل راجعت الجهاز وتريد المتابعة؟'))return;
          button.disabled=true;
          try{await api('/api/cashier-devices/'+loc.id+'/release',{method:'POST',body:JSON.stringify({pendingInvoicesChecked:true})});toast('تم فك الربط. يمكن للكاشير تسجيل الدخول على الجهاز الجديد.');await loadDevices()}
          catch(err){toast(errorText(err))}finally{button.disabled=false}
        };action.append(button)}else action.textContent='بانتظار دخول كاشير';
        tr.append(action);tbody.append(tr);
      }
      if(!tbody.children.length){const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.textContent='أنشئ فرعًا أولًا.';tr.append(td);tbody.append(tr)}
    }catch(err){toast(errorText(err))}
  }
  devicesPanel.querySelector('#devices-refresh').onclick=loadDevices;
  const transferPanel=document.createElement('div');transferPanel.className='panel';transferPanel.style.cssText='margin-top:16px;display:none';
  transferPanel.innerHTML='<h3>تحويل مخزون</h3><form id="transfer-form"><div class="fields" style="margin:16px 0"><label class="field">من موقع<select name="sourceId" required></select></label><label class="field">إلى موقع<select name="destinationId" required></select></label><label class="field">الصنف<select name="variantId" required></select></label><label class="field">الكمية<input name="quantity" type="number" min="1" step="1" required></label></div><button class="primary">تنفيذ التحويل</button></form>';
  e('inventory').append(transferPanel);
  const transferForm=transferPanel.querySelector('form');
  const transferHistory=document.createElement('div');transferHistory.className='panel';transferHistory.style.marginTop='16px';
  transferHistory.innerHTML='<div class="panel-head"><h3>آخر التحويلات</h3><button type="button" class="link" id="refresh-transfers">تحديث</button></div><div class="table-wrap"><table><thead><tr><th>الصنف</th><th>من</th><th>إلى</th><th>الكمية</th><th>الوقت</th></tr></thead><tbody id="transfer-rows"></tbody></table></div>';
  e('inventory').append(transferHistory);
  async function loadTransfers(){
    if(!['admin','stock_manager'].includes(state.user?.role))return;
    try{
      const rows=await api('/api/transfers'),tbody=e('transfer-rows');tbody.replaceChildren();
      for(const row of rows){const tr=document.createElement('tr');for(const value of [row.product_name+' · '+row.color+' / '+row.size+' · '+row.sku,row.source_name,row.destination_name,formatNumber(row.quantity),new Date(row.completed_at).toLocaleString('ar-EG',{timeZone:'Africa/Cairo',dateStyle:'short',timeStyle:'short'})]){const td=document.createElement('td');td.textContent=value;tr.append(td)}tbody.append(tr)}
      if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=5;td.textContent='لا توجد تحويلات مسجلة بعد.';tr.append(td);tbody.append(tr)}
    }catch(err){toast(errorText(err))}
  }
  transferHistory.querySelector('#refresh-transfers').onclick=loadTransfers;
  function retryableOperation(form,payload){
    const fingerprint=JSON.stringify(payload);
    if(form.dataset.operationFingerprint!==fingerprint){form.dataset.operationFingerprint=fingerprint;form.dataset.operationId=crypto.randomUUID()}
    return {...payload,operationId:form.dataset.operationId};
  }
  function clearOperation(form){delete form.dataset.operationFingerprint;delete form.dataset.operationId}
  e('transfer-button').onclick=async()=>{
    if(!['admin','stock_manager'].includes(state.user.role)){toast('لا تملك صلاحية التحويل');return}
    transferPanel.style.display=transferPanel.style.display==='none'?'block':'none';
    for(const key of ['sourceId','destinationId']){transferForm.elements[key].replaceChildren();for(const loc of state.locations)transferForm.elements[key].add(new Option(loc.name,loc.id))}
    if(state.locations.length>1)transferForm.elements.destinationId.selectedIndex=1;
    await transferVariants();
  };
  async function transferVariants(){
    const id=transferForm.elements.sourceId.value;
    if(!id)return;
    try{
      const items=await api('/api/inventory?locationId='+encodeURIComponent(id));
      transferForm.elements.variantId.replaceChildren();
      for(const item of items.filter(x=>Number(x.quantity)>0))transferForm.elements.variantId.add(new Option(item.name+' · '+item.color+' / '+item.size+' ('+item.quantity+')',item.variantId));
    }catch(err){toast(errorText(err))}
  }
  transferForm.elements.sourceId.onchange=transferVariants;
  transferForm.onsubmit=async ev=>{
    ev.preventDefault();const f=Object.fromEntries(new FormData(transferForm));
    if(f.sourceId===f.destinationId){toast('اختار وجهة مختلفة عن المصدر');return}
    const payload=retryableOperation(transferForm,{sourceId:f.sourceId,destinationId:f.destinationId,variantId:f.variantId,quantity:Number(f.quantity)});
    const button=transferForm.querySelector('button[type="submit"],button.primary');button.disabled=true;
    try{
      await api('/api/transfers',{method:'POST',body:JSON.stringify(payload)});
      clearOperation(transferForm);toast('تم تحويل المخزون');transferPanel.style.display='none';await loadInventory();await loadStock();await loadDashboard();await loadTransfers();
    }catch(err){toast(errorText(err))}finally{button.disabled=false}
  };
  const stockPanel=document.createElement('div');stockPanel.className='panel';stockPanel.style.marginTop='16px';
  stockPanel.innerHTML='<h3>إضافة صنف ورصيد</h3><p class="muted">أنشئ صنفًا ومتغيره أولًا، ثم أضف الكمية للموقع المطلوب.</p><form id="new-product"><div class="fields"><label class="field">اسم المنتج<input name="name" required></label><label class="field">SKU<input name="sku" pattern="[A-Za-z0-9._-]{2,64}" required></label><label class="field">المقاس<input name="size" required></label><label class="field">اللون<input name="color" required></label><label class="field">سعر البيع<input name="price" type="number" min="0" step="0.01" required></label></div><button class="primary" style="margin-top:14px">إنشاء الصنف</button></form><hr style="border:0;border-top:1px solid #e4edf1;margin:22px 0"><form id="new-receipt"><div class="fields"><label class="field">الصنف<select name="variantId" required></select></label><label class="field">الموقع<select name="locationId" required></select></label><label class="field">الكمية<input name="quantity" type="number" min="1" step="1" required></label></div><button class="primary" style="margin-top:14px">إضافة رصيد</button></form>';
  e('inventory').append(stockPanel);
  const catalogPanel=document.createElement('div');catalogPanel.className='panel';catalogPanel.style.marginTop='16px';
  catalogPanel.innerHTML='<div class="panel-head"><h3>كتالوج المنتجات والمتغيرات</h3><button type="button" class="link" id="catalog-refresh">تحديث</button></div><div class="toolbar"><input id="catalog-search" type="search" placeholder="بحث بالمنتج أو SKU" aria-label="بحث كتالوج المنتجات"></div><div id="catalog-list" class="catalog-list"></div><hr style="border:0;border-top:1px solid #e4edf1;margin:22px 0"><h3>إضافة مقاس أو لون لمنتج موجود</h3><form id="new-variant" class="fields" style="margin-top:15px"><label class="field">المنتج<select name="productId" required></select></label><label class="field">SKU جديد<input name="sku" pattern="[A-Za-z0-9._-]{2,64}" required></label><label class="field">المقاس<input name="size" maxlength="100" required></label><label class="field">اللون<input name="color" maxlength="100" required></label><label class="field">سعر البيع<input name="price" type="number" min="0" step="0.01" required></label><div style="align-self:end"><button class="primary">إضافة المتغير</button></div></form>';
  e('inventory').append(catalogPanel);
  let catalogRows=[];
  function renderCatalog(){
    const query=catalogPanel.querySelector('#catalog-search').value.trim().toLowerCase(),list=catalogPanel.querySelector('#catalog-list');list.replaceChildren();
    const groups=new Map();for(const row of catalogRows){if(!groups.has(row.productId))groups.set(row.productId,{name:row.name,variants:[]});groups.get(row.productId).variants.push(row)}
    for(const product of groups.values()){
      const filtered=product.variants.filter(v=>[product.name,v.sku,v.color,v.size].join(' ').toLowerCase().includes(query));if(!filtered.length)continue;
      const details=document.createElement('details');details.className='catalog-product';const summary=document.createElement('summary');summary.textContent=product.name+' · '+product.variants.length+' متغير';details.append(summary);
      const wrap=document.createElement('div');wrap.className='table-wrap';const table=document.createElement('table');const head=document.createElement('thead');head.innerHTML='<tr><th>SKU</th><th>المقاس</th><th>اللون</th><th>سعر البيع</th></tr>';const body=document.createElement('tbody');
      for(const variant of filtered){const tr=document.createElement('tr');for(const value of [variant.sku,variant.size,variant.color,formatNumber(variant.price)+' ج.م']){const td=document.createElement('td');td.textContent=value;tr.append(td)}body.append(tr)}table.append(head,body);wrap.append(table);details.append(wrap);list.append(details);
    }
    if(!list.children.length)list.textContent='لا توجد منتجات مطابقة.';
  }
  async function loadCatalog(){
    if(state.user?.role!=='admin')return;
    try{
      catalogRows=await api('/api/products');
      const select=catalogPanel.querySelector('#new-variant').elements.productId,selected=select.value;select.replaceChildren();const seen=new Set();
      for(const row of catalogRows)if(!seen.has(row.productId)){seen.add(row.productId);select.add(new Option(row.name,row.productId))}
      if(selected&&seen.has(selected))select.value=selected;
      renderCatalog();
    }catch(err){toast(errorText(err))}
  }
  catalogPanel.querySelector('#catalog-search').oninput=renderCatalog;
  catalogPanel.querySelector('#catalog-refresh').onclick=loadCatalog;
  catalogPanel.querySelector('#new-variant').onsubmit=async ev=>{
    ev.preventDefault();const form=ev.target,f=Object.fromEntries(new FormData(form)),button=form.querySelector('button.primary');button.disabled=true;
    try{await api('/api/products/'+f.productId+'/variants',{method:'POST',body:JSON.stringify({sku:f.sku,size:f.size,color:f.color,price:f.price})});toast('تمت إضافة المتغير');const productId=f.productId;form.reset();await loadCatalog();form.elements.productId.value=productId;await loadInventory();receiptChoices();await loadStock()}
    catch(err){toast(errorText(err))}finally{button.disabled=false}
  };
  const stockForm=stockPanel.querySelector('#new-receipt');
  function receiptChoices(){
    stockForm.elements.locationId.replaceChildren();
    for(const loc of state.locations)stockForm.elements.locationId.add(new Option(loc.name,loc.id));
    stockForm.elements.variantId.replaceChildren();
    const seen=new Set();
    for(const item of state.inventory)if(!seen.has(item.variantId)){seen.add(item.variantId);stockForm.elements.variantId.add(new Option(item.name+' · '+item.color+' / '+item.size,item.variantId))}
  }
  const originalLoadInventory=loadInventory;
  e('pos-location').onchange=async()=>{await originalLoadInventory();receiptChoices()};
  stockPanel.querySelector('#new-product').onsubmit=async ev=>{
    ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));
    try{await api('/api/products',{method:'POST',body:JSON.stringify(f)});toast('تم إنشاء الصنف');ev.target.reset();await loadCatalog();await loadInventory();receiptChoices();await loadStock()}
    catch(err){toast(errorText(err))}
  };
  stockForm.onsubmit=async ev=>{
    ev.preventDefault();const f=Object.fromEntries(new FormData(ev.target));
    const payload=retryableOperation(stockForm,{locationId:f.locationId,variantId:f.variantId,quantity:Number(f.quantity)});
    const button=stockForm.querySelector('button.primary');button.disabled=true;
    try{await api('/api/receipts',{method:'POST',body:JSON.stringify(payload)});clearOperation(stockForm);toast('تم إضافة الرصيد');ev.target.reset();await loadInventory();receiptChoices();await loadStock();await loadDashboard()}
    catch(err){toast(errorText(err))}finally{button.disabled=false}
  };
}

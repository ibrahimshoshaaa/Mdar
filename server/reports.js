export function reportRange(from,to){
  const valid=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  if(!valid(from)||!valid(to))throw new Error('Invalid report dates');
  const days=(Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z'))/86400000;
  if(days<0||days>366)throw new Error('Report range must be at most 367 days');
  return {from,to};
}

export function csvCell(value){
  let text=String(value??'');
  if(/^[\s]*[=+@-]/.test(text))text="'"+text;
  return '"'+text.replaceAll('"','""')+'"';
}
export function salesCsv(rows){
  const lines=[['رقم الفاتورة','التاريخ بتوقيت القاهرة','الفرع','الكاشير','عدد القطع','الإجمالي بالجنيه']];
  for(const row of rows)lines.push([row.id,new Intl.DateTimeFormat('sv-SE',{timeZone:'Africa/Cairo',dateStyle:'short',timeStyle:'medium',hour12:false}).format(new Date(row.created_at)),row.location_name,row.cashier,row.pieces,row.total]);
  return '\uFEFF'+lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

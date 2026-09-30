import test from 'node:test';
import assert from 'node:assert/strict';
import {reportRange,salesCsv} from './reports.js';

test('report dates reject invalid, reversed and oversized ranges',()=>{
  assert.deepEqual(reportRange('2026-09-01','2026-09-30'),{from:'2026-09-01',to:'2026-09-30'});
  for(const [from,to] of [['2026-02-30','2026-03-01'],['2026-10-01','2026-09-30'],['2025-01-01','2026-09-30']])assert.throws(()=>reportRange(from,to));
});
test('CSV escapes quotes and spreadsheet formulas',()=>{
  const csv=salesCsv([{id:'abc',created_at:'2026-09-30T10:00:00Z',location_name:'="bad"',cashier:'a,"b',pieces:2,total:'10.00'}]);
  assert.match(csv,/"'=\"\"bad\"\""/);
  assert.match(csv,/"a,\"\"b"/);
  assert.match(csv,/"10.00"/);
});

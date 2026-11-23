export const floors = ['floor1','floor2','floor3'];
const numberPattern = /^\d+(?:\.\d{1,2})?$/;
const localPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;
export const taipei = (value = new Date()) =>
  new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0,19);
const dayNumber = value => Date.parse(value.slice(0,10)) / 86400000;
const toCents = value => Math.round(value * 100);

export function normalize(date, values) {
  const dated = date.trim().replace(' ', 'T');
  if (!localPattern.test(dated)) throw Error('抄表日期或時間格式有誤。');
  const local = dated.length === 16 ? dated + ':00' : dated;
  const dateTime = new Date(local + '+08:00');
  if (isNaN(dateTime) || taipei(dateTime) !== local) throw Error('抄表日期或時間無效。');
  const row = {recorded_at: dateTime.toISOString()};
  for (const floor of floors) {
    const value = String(values[floor] ?? '').trim();
    if (value && (!numberPattern.test(value) || +value > 9999999999.99))
      throw Error('請輸入非負讀數，最多兩位小數。');
    row[floor] = value ? Number(value) : null;
  }
  if (floors.every(floor => row[floor] === null)) throw Error('至少填寫一個樓層。');
  return row;
}

export function parseCSV(text) {
  const [header, ...lines] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (header !== 'recorded_at,floor1,floor2,floor3') throw Error('CSV 欄位應為 recorded_at,floor1,floor2,floor3。');
  const rows = new Map();
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    const [date, floor1, floor2, floor3, ...extra] = line.split(',');
    try {
      if (floor3 === undefined || extra.length) throw Error('欄位數量有誤。');
      const row = normalize(date, {floor1,floor2,floor3});
      const prior = rows.get(row.recorded_at);
      if (prior && floors.some(floor => prior[floor] !== row[floor])) throw Error('相同時間有不同讀數。');
      rows.set(row.recorded_at, row);
    } catch (error) { throw Error(`第 ${index + 2} 列：${error.message}`); }
  });
  if (!rows.size) throw Error('CSV 沒有抄表紀錄。');
  return [...rows.values()];
}

export function calculate(rows) {
  const prior = {};
  return [...rows].sort((a,b) => Date.parse(a.recorded_at) - Date.parse(b.recorded_at)).map(row => {
    const local = taipei(row.recorded_at);
    const intervals = {};
    for (const floor of floors) {
      if (row[floor] === null || row[floor] === undefined) continue;
      if (prior[floor]) intervals[floor] = {
        start: prior[floor].local,
        cents: toCents(row[floor]) - toCents(prior[floor].reading),
        days: dayNumber(local) - dayNumber(prior[floor].local)
      };
      prior[floor] = {local,reading:row[floor]};
    }
    return {...row, local, intervals};
  });
}

export function summarize(rows, period, filter, floor) {
  const buckets = new Map();
  let gaps = 0;
  let drops = 0;
  const length = {day:10,month:7,year:4}[period];
  for (const row of rows) {
    if (filter && !row.local.startsWith(filter)) continue;
    for (const key of floor === 'total' ? floors : [floor]) {
      const interval = row.intervals[key];
      if (!interval) continue;
      if (interval.cents < 0) { drops++; continue; }
      if (period === 'day' && interval.days > 1) { gaps++; continue; }
      const bucket = row.local.slice(0,length);
      buckets.set(bucket, (buckets.get(bucket) ?? 0) + interval.cents);
    }
  }
  return {buckets, gaps, drops, total:[...buckets.values()].reduce((a,b) => a + b,0)};
}

export function usageLast24Hours(rows) {
  const end = rows.length ? Date.parse(rows.at(-1).recorded_at) : null;
  const start = end === null ? null : end - 24 * 3600000;
  const readings = Object.fromEntries(floors.map(floor => [floor, {status:'missing'}]));
  if (end === null) return {start,end,readings};

  for (const floor of floors) {
    // All floors share the same window. A floor without an end reading cannot
    // establish its usage through the end of that window.
    if (rows.at(-1)[floor] == null) continue;
    let later = rows.at(-1);
    for (let i = rows.length - 2; i >= 0; i--) {
      const earlier = rows[i];
      if (earlier[floor] == null) continue;
      const from = Date.parse(earlier.recorded_at);
      const to = Date.parse(later.recorded_at);
      const difference = toCents(later[floor]) - toCents(earlier[floor]);
      if (difference < 0) {
        readings[floor] = {status:'drop'};
        break;
      }
      if (from <= start) {
        if (from === start) {
          readings[floor] = {status:'measured',cents:toCents(rows.at(-1)[floor]) - toCents(earlier[floor])};
        } else if (to - from <= 48 * 3600000) {
          const partial = difference * (to - start) / (to - from);
          readings[floor] = {
            status:'estimated',
            cents:Math.round(toCents(rows.at(-1)[floor]) - toCents(later[floor]) + partial)
          };
        }
        break;
      }
      later = earlier;
    }
  }
  return {start,end,readings};
}

import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.mjs';
import { floors, taipei, normalize, parseCSV, calculate, summarize, usageLast24Hours } from './meter.mjs?v=usage24';

function periodKeys(period, filter, available) {
  if (period === 'day' && /^\d{4}-\d{2}$/.test(filter)) {
    const [year,month] = filter.split('-').map(Number);
    const count = new Date(Date.UTC(year,month,0)).getUTCDate();
    return Array.from({length:count},(_,i) => filter + '-' + String(i + 1).padStart(2,'0'));
  }
  if (period === 'month' && /^\d{4}$/.test(filter)) {
    return Array.from({length:12},(_,i) => filter + '-' + String(i + 1).padStart(2,'0'));
  }
  if (period === 'year' && available.length) {
    const first = +available[0], last = +available.at(-1);
    return Array.from({length:last - first + 1},(_,i) => String(first + i));
  }
  return available;
}

const tones = { '1 樓':'#146653', '2 樓':'#366caf', '3 樓':'#a35527' };
const numberFormat = new Intl.NumberFormat('zh-TW',{maximumFractionDigits:2});
const format = cents => numberFormat.format(cents / 100);

function drawTrend(canvas, keys, series, period) {
  const ctx = canvas.getContext('2d');
  const values = series.flatMap(({data}) => [...data.values()]);
  if (!ctx || !keys.length || !values.length) return [];
  const width = 680, height = 240;
  canvas.width = width * 2;
  canvas.height = height * 2;
  ctx.scale(2,2);

  const left = 63, right = 654, top = 27, bottom = 200;
  const x = i => keys.length === 1 ? (left+right)/2 : left + i*(right-left)/(keys.length-1);
  const target = Math.max(25,...values)/4;
  const divisor = 10 ** Math.floor(Math.log10(target));
  const unit = [1,2,2.5,5,10].find(n => n * divisor >= target) * divisor;
  const upper = unit*4;
  const y = value => bottom - value*(bottom-top)/upper;

  ctx.fillStyle = '#f5f8f6';
  ctx.fillRect(left,top,right-left,bottom-top);
  ctx.font = '13px system-ui';
  ctx.fillStyle = '#203d35';
  ctx.strokeStyle = '#d5e2db';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (let i=0; i<=4; i++) {
    const level = i*unit, levelY = y(level);
    ctx.beginPath();
    ctx.moveTo(left,levelY);
    ctx.lineTo(right,levelY);
    ctx.stroke();
    ctx.fillText(format(level),left-8,levelY+5);
  }
  ctx.textAlign = 'left';
  ctx.fillText('用電（度）',left,16);
  ctx.textAlign = 'center';
  const tick = Math.max(1,Math.ceil(keys.length/7));
  keys.forEach((key,i) => {
    if (i % tick !== 0 && (i !== keys.length-1 || i % tick < tick/2)) return;
    const label = period === 'day' ? key.slice(5).replace('-','/') : period === 'month' ? key.slice(5)+' 月' : key;
    ctx.fillText(label,x(i),226);
  });

  for (const {label,data} of series) {
    const color = tones[label] ?? '#146653';
    const points = keys.map((key,i) => data.has(key) ? [x(i),y(data.get(key))] : null);
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    let previous;
    for (const point of points) {
      if (point && previous) {
        const middle = (point[0] + previous[0])/2;
        ctx.bezierCurveTo(middle,previous[1],middle,point[1],point[0],point[1]);
      } else if (point) {
        ctx.moveTo(...point);
      }
      previous = point;
    }
    ctx.stroke();
    for (const point of points) {
      if (!point) continue;
      ctx.beginPath();
      ctx.arc(point[0],point[1],3.1,0,2*Math.PI);
      ctx.fill();
    }
  }
  return series.map(({label}) => ({color:tones[label] ?? '#146653',label}));
}


const xmlHeader = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const spreadsheet = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const office = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const packageRel = 'http://schemas.openxmlformats.org/package/2006/relationships';
const encode = new TextEncoder();
const escapeXML = text => String(text).replace(/[&<>"']/g,char => ({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'
})[char]);

function zip(files) {
  const parts = [], directory = [];
  const crcTable = Uint32Array.from({length:256},(_,n) => {
    for (let i=0;i<8;i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n >>> 0;
  });
  let offset = 0, directorySize = 0;
  const header = length => {
    const bytes = new Uint8Array(length);
    const view = new DataView(bytes.buffer);
    return {bytes,u16:(index,value) => view.setUint16(index,value,true),u32:(index,value) => view.setUint32(index,value,true)};
  };
  for (const [path, xml] of Object.entries(files)) {
    const name = encode.encode(path), data = encode.encode(xml);
    let crc = 0xffffffff;
    for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = header(30), central = header(46);
    local.u32(0,0x04034b50); local.u16(4,20); local.u16(12,33);
    local.u32(14,crc); local.u32(18,data.length); local.u32(22,data.length); local.u16(26,name.length);
    central.u32(0,0x02014b50); central.u16(4,20); central.u16(6,20); central.u16(14,33);
    central.u32(16,crc); central.u32(20,data.length); central.u32(24,data.length);
    central.u16(28,name.length); central.u32(42,offset);
    parts.push(local.bytes,name,data);
    directory.push(central.bytes,name);
    offset += local.bytes.length + name.length + data.length;
    directorySize += central.bytes.length + name.length;
  }
  const end = header(22), count = directory.length / 2;
  end.u32(0,0x06054b50); end.u16(8,count); end.u16(10,count);
  end.u32(12,directorySize); end.u32(16,offset);
  return new Blob([...parts,...directory,end.bytes],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}

function sheetXml(table) {
  const columnCount = table[0].length;
  const cells = table.map((row,index) => {
    const number = index + 1;
    const values = row.map((value,column) => {
      if (value == null) return '';
      const ref = String.fromCharCode(65+column) + number;
      if (typeof value === 'number') return `<c r="${ref}"><v>${value}</v></c>`;
      if (typeof value === 'object') return `<c r="${ref}" s="1"><v>${value.date}</v></c>`;
      return `<c r="${ref}" t="inlineStr"${index===0?' s="2"':''}><is><t>${escapeXML(value)}</t></is></c>`;
    }).join('');
    return `<row r="${number}">${values}</row>`;
  }).join('');
  return `${xmlHeader}<worksheet xmlns="${spreadsheet}"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="${columnCount}" width="19" customWidth="1"/></cols><sheetData>${cells}</sheetData><autoFilter ref="A1:${String.fromCharCode(64+columnCount)}${table.length}"/></worksheet>`;
}

function exportWorkbook(rows) {
  const detail = [['抄表時間（臺灣）','1 樓讀數','2 樓讀數','3 樓讀數','1 樓差值','2 樓差值','3 樓差值']];
  for (const row of rows) detail.push([
    {date:Date.parse(row.local+'Z') / 86400000 + 25569},
    ...floors.map(floor => row[floor] == null ? null : Number(row[floor])),
    ...floors.map(floor => row.intervals[floor] ? row.intervals[floor].cents/100 : null)
  ]);
  const sheets = [['抄表明細',detail]];
  for (const [period,label] of [['day','日用電'],['month','月用電'],['year','年用電']]) {
    const maps = floors.map(floor => summarize(rows,period,'',floor).buckets);
    const dates = [...new Set(maps.flatMap(map => [...map.keys()]))].sort();
    sheets.push([label, [['期間','1 樓用電（度）','2 樓用電（度）','3 樓用電（度）','全樓合計（度）'],
      ...dates.map(date => {
        const values = maps.map(map => map.get(date));
        return [date,...values.map(value => value == null ? null : value/100),values.reduce((sum,value)=>sum+(value??0),0)/100];
      })
    ]]);
  }
  const workbookSheets = sheets.map(([name],i) => `<sheet name="${escapeXML(name)}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('');
  const sheetRelationships = sheets.map((_,i) => `<Relationship Id="rId${i+1}" Type="${office}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('');
  const sheetTypes = sheets.map((_,i) => `<Override PartName="/xl/worksheets/sheet${i+1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  const files = {
    '[Content_Types].xml':`${xmlHeader}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheetTypes}</Types>`,
    '_rels/.rels':`${xmlHeader}<Relationships xmlns="${packageRel}"><Relationship Id="rId1" Type="${office}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'xl/workbook.xml':`${xmlHeader}<workbook xmlns="${spreadsheet}" xmlns:r="${office}"><sheets>${workbookSheets}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`${xmlHeader}<Relationships xmlns="${packageRel}">${sheetRelationships}<Relationship Id="rId${sheets.length+1}" Type="${office}/styles" Target="styles.xml"/></Relationships>`,
    'xl/styles.xml':`${xmlHeader}<styleSheet xmlns="${spreadsheet}"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`
  };
  sheets.forEach(([,table],i) => { files[`xl/worksheets/sheet${i+1}.xml`] = sheetXml(table); });
  return zip(files);
}

const $ = id => document.getElementById(id);
const fmt = new Intl.NumberFormat('zh-TW', {maximumFractionDigits:2});
const labels = {floor1:'1 樓',floor2:'2 樓',floor3:'3 樓'};
const display = cents => fmt.format(cents / 100);
const reading = $('reading');
const field = name => reading.elements.namedItem(name);
const storageKey = 'floor-meter.offline.v1';
let client, access, offline = false, rows = [], period = 'day', editing;
const canManage = () => offline || access?.role === 'owner';

function showMessage(id, value, error = false) {
  $(id).textContent = value;
  $(id).classList.toggle('error', error);
}
function element(tag, value, className) {
  const node = document.createElement(tag);
  if (value !== undefined) node.textContent = value;
  if (className) node.className = className;
  return node;
}
function localRows() {
  return JSON.parse(localStorage.getItem(storageKey) ?? '[]');
}
function readError(error) {
  if (error.code === '23505') return canManage()
    ? '此時間已有抄表紀錄，可在明細中編輯。'
    : '此時間已有抄表紀錄。如需更正，請聯絡管理者。';
  if (error.code === '42501') return '這個帳號沒有執行此操作的權限。';
  return error.message || '無法完成操作，請稍後再試。';
}
async function fetchRows() {
  if (offline) return localRows();
  const result = [];
  let cursor;
  while (true) {
    let query = client.from('meter_readings').select('recorded_at,floor1,floor2,floor3').eq('user_id',access.book_id)
      .order('recorded_at',{ascending:true}).limit(500);
    if (cursor) query = query.gt('recorded_at',cursor);
    const {data,error} = await query;
    if (error) throw error;
    if (!data.length) return result;
    result.push(...data);
    cursor = data.at(-1).recorded_at;
  }
}
async function refresh() {
  rows = calculate(await fetchRows());
  render();
}

function render() {
  renderLast24Hours();
  $('export-excel').disabled = !rows.length;
  const latest = rows.at(-1);
  $('coverage').textContent = latest
    ? `${rows[0].local.slice(0,10)} 至 ${latest.local.slice(0,10)} · ${fmt.format(rows.length)} 筆抄表`
    : '目前沒有抄表紀錄';
  $('metrics').replaceChildren(...floors.map(floor => {
    const row = rows.findLast(item => item[floor] != null);
    const card = element('article', undefined, 'card metric ' + floor);
    card.append(element('span', labels[floor] + '累計讀數'), element('strong',row ? fmt.format(row[floor]) : '—'),
      element('small',row ? row.local.slice(0,16).replace('T',' ') : '尚無紀錄'));
    return card;
  }));
  const previouslySelected = $('year').value;
  const years = [...new Set([...rows.map(row => row.local.slice(0,4)),taipei().slice(0,4)])].sort().reverse();
  $('year').replaceChildren(...years.map(year => new Option(year,year)));
  $('year').value = years.includes(previouslySelected) ? previouslySelected : latest?.local.slice(0,4) ?? years[0];
  renderChart();
  renderHistory();
  updateEstimate();
}

function renderLast24Hours() {
  const {start,end,readings} = usageLast24Hours(rows);
  const local = time => taipei(time).slice(0,16).replace('T',' ');
  $('usage-24-period').textContent = end === null
    ? '目前沒有抄表紀錄'
    : `${local(start)} 至 ${local(end)}（臺灣時間）`;
  const results = floors.map(floor => readings[floor]);
  const total = results.every(result => result.cents != null)
    ? {status:results.some(result => result.status === 'estimated') ? 'estimated' : 'measured',
       cents:results.reduce((sum,result) => sum + result.cents,0)}
    : {status:'missing'};
  $('usage-24-metrics').replaceChildren(...[...results,total].map((result,i) => {
    const title = i === floors.length ? '全樓合計' : labels[floors[i]];
    const item = element('div',undefined,'usage-24-metric');
    const status = {measured:'實測',estimated:'估算',missing:'資料不足',drop:'讀數下降，請查核'};
    item.append(
      element('span',title),
      element('strong',result.cents == null ? '—' : `${display(result.cents)} 度`),
      element('small',status[result.status])
    );
    return item;
  }));
}

function renderChart() {
  $('month-field').hidden = period !== 'day';
  $('year-field').hidden = period !== 'month';
  const filter = period === 'day' ? $('month').value : period === 'month' ? $('year').value : '';
  const {buckets,total,gaps,drops} = summarize(rows,period,filter,$('floor').value);
  $('sum').textContent = buckets.size ? display(total) : '—';
  $('summary-label').textContent = filter || '全部年度';
  const chart = $('chart');
  chart.replaceChildren();
  if (buckets.size) renderTrend(chart, filter, buckets);
  else chart.append(element('p','此範圍尚無可統計的用電量。','empty'));
  const rule = period === 'day' ? '日用電量依抄表結束日顯示，跨多個日曆日的差值保留在明細。'
    : '用電量依每次抄表的結束日歸入當月或當年，跨期用電依抄表區間合計。';
  $('chart-note').textContent = rule + (gaps ? ` 本期略過 ${gaps} 筆跨日差值。` : '')
    + (drops ? ` 略過 ${drops} 筆讀數下降的區間。` : '')
    + ($('floor').value === 'total' ? ' 全樓合計加總各樓層可計算的差值。' : '');
}
function renderTrend(chart, filter, buckets) {
  const selected = $('floor').value;
  const selectedFloors = selected === 'total' ? floors : [selected];
  const series = selectedFloors.map(floor => ({
    label: labels[floor],
    data: selected === 'total' ? summarize(rows,period,filter,floor).buckets : buckets
  }));
  const dates = [...buckets.keys()].sort();
  const keys = periodKeys(period,filter,dates);
  const graphic = element('div',undefined,'trend-graphic');
  const canvas = element('canvas');
  canvas.setAttribute('role','img');
  canvas.setAttribute('aria-label',selected === 'total'
    ? '各樓層用電曲線圖，橫軸為期間，縱軸為用電度數。'
    : labels[selected] + '用電曲線圖，橫軸為期間，縱軸為用電度數。');
  graphic.append(canvas);
  chart.append(graphic);
  const lines = drawTrend(canvas,keys,series,period);
  if (lines.length) {
    const legend = element('div',undefined,'trend-legend');
    for (const {color,label} of lines) {
      const item = element('span',undefined,'trend-key');
      const swatch = element('i');
      swatch.style.backgroundColor = color;
      swatch.setAttribute('aria-hidden','true');
      item.append(swatch,element('span',label));
      legend.append(item);
    }
    chart.append(legend);
  }
  const details = element('details',undefined,'trend-data');
  details.append(element('summary','查看趨勢數據'));
  const container = element('div',undefined,'table-wrap');
  const table = element('table');
  const head = element('thead');
  const heading = element('tr');
  for (const column of ['期間',...series.map(item => item.label + '（度）'),...(selected === 'total' ? ['合計（度）'] : [])]) {
    const header = element('th',column);
    header.scope = 'col';
    heading.append(header);
  }
  head.append(heading);
  const body = element('tbody');
  for (const date of dates) {
    const tr = element('tr');
    tr.append(element('td',date));
    for (const {data} of series) tr.append(element('td',data.has(date) ? display(data.get(date)) : '—'));
    if (selected === 'total') tr.append(element('td',display(buckets.get(date))));
    body.append(tr);
  }
  table.append(head,body);
  container.append(table);
  details.append(container);
  chart.append(details);
}
function renderHistory() {
  const filter = $('history-filter').value;
  let list = [...rows].reverse();
  if (filter === 'latest') list = list.slice(0,30);
  if (filter === 'anomaly') list = list.filter(row => floors.some(floor => row.intervals[floor]?.cents < 0));
  $('history').replaceChildren();
  $('history-actions').hidden = !canManage();
  if (!list.length) {
    const tr = element('tr');
    const td = element('td','沒有符合條件的紀錄。');
    td.colSpan = canManage() ? 5 : 4;
    tr.append(td);
    $('history').append(tr);
  }
  for (const row of list) {
    const tr = element('tr');
    tr.append(element('td',row.local.slice(0,16).replace('T',' ')));
    for (const floor of floors) {
      const diff = row.intervals[floor];
      const cell = element('td',row[floor] == null ? '—' : fmt.format(row[floor]));
      if (diff) {
        const hours = (Date.parse(row.local + '+08:00') - Date.parse(diff.start + '+08:00')) / 3600000;
        cell.append(element('small',`（${display(diff.cents)} 度／${fmt.format(hours)} 小時）`,diff.cents < 0 ? 'error' : ''));
      }
      tr.append(cell);
    }
    if (canManage()) {
      const action = element('td');
      const button = element('button','編輯','quiet');
      button.type = 'button';
      button.addEventListener('click',() => edit(row));
      action.append(button);
      tr.append(action);
    }
    $('history').append(tr);
  }
}
function edit(row) {
  if (row && !canManage()) return;
  editing = row?.recorded_at;
  field('recorded_at').value = row?.local ?? taipei().slice(0,16);
  field('recorded_at').readOnly = !!row;
  for (const floor of floors) field(floor).value = row?.[floor] ?? '';
  $('entry-title').textContent = row ? '編輯抄表' : '新增抄表';
  $('cancel-edit').hidden = !row;
  showMessage('save-message','');
  updateEstimate();
  if (row) { $('entry-title').scrollIntoView({block:'center'}); field('floor1').focus(); }
}
function updateEstimate() {
  const date = field('recorded_at').value;
  const stamp = date ? Date.parse(date + '+08:00') : NaN;
  const details = floors.flatMap(floor => {
    if (field(floor).value === '' || isNaN(stamp)) return [];
    const prior = rows.findLast(row => Date.parse(row.recorded_at) < stamp && row[floor] != null);
    if (!prior) return [labels[floor] + '建立基準'];
    const diff = Math.round(+field(floor).value * 100) - Math.round(prior[floor] * 100);
    return [`${labels[floor]} ${display(diff)} 度${diff < 0 ? '（讀數下降）' : ''}`];
  });
  $('estimate').textContent = details.join('、') || '填寫至少一個樓層的累計電表讀數。';
}
function showDashboard() {
  $('login-panel').hidden = true;
  $('dashboard').hidden = false;
  $('logout').hidden = false;
  $('mode').textContent = offline ? '離線模式 · 只存於此瀏覽器' : '家庭用電紀錄';
  $('import-panel').hidden = !canManage();
  $('logout').textContent = offline ? '離開' : '登出';
  $('month').value = taipei().slice(0,7);
  edit();
}
async function activate() {
  showDashboard();
  try {
    await refresh();
    if (rows.length) $('month').value = rows.at(-1).local.slice(0,7);
    renderChart();
    showMessage('page-error','');
  } catch (error) {
    showMessage('page-error','讀取紀錄失敗：' + readError(error),true);
  }
}
async function submit(event, message, action) {
  event.preventDefault();
  const button = event.submitter ?? event.currentTarget.querySelector('button');
  button.disabled = true;
  showMessage(message,'處理中…');
  try { await action(); } catch (error) { showMessage(message,readError(error),true); }
  finally { button.disabled = false; }
}

$('login').addEventListener('submit',event => submit(event,'login-message',async () => {
  if (!client) throw Error('連線尚未完成。');
  const callback = new URL('./',window.location.href);
  const {error} = await client.auth.signInWithOAuth({
    provider:'google',
    options:{redirectTo:callback.href,queryParams:{prompt:'select_account'}}
  });
  if (error) throw error;
}));
$('offline').addEventListener('click',async () => { offline = true; await activate(); });
$('logout').addEventListener('click',async () => {
  if (!offline && client) {
    const {error} = await client.auth.signOut();
    if (error) {
      showMessage($('dashboard').hidden ? 'login-message' : 'page-error',readError(error),true);
      return;
    }
  }
  offline = false;
  access = undefined;
  rows = [];
  render();
  $('dashboard').hidden = true;
  $('logout').hidden = true;
  $('mode').textContent = '';
  $('login-panel').hidden = false;
  showMessage('login-message','');
});
reading.addEventListener('input',updateEstimate);
$('cancel-edit').addEventListener('click',() => edit());
reading.addEventListener('submit',event => submit(event,'save-message',async () => {
  const row = normalize(field('recorded_at').value,Object.fromEntries(floors.map(floor => [floor,field(floor).value])));
  if (offline) {
    const data = localRows();
    const index = data.findIndex(existing => existing.recorded_at === row.recorded_at);
    if (index !== -1 && !editing) throw Error('此時間已有抄表紀錄，可在明細中編輯。');
    if (index === -1) data.push(row);
    else data[index] = row;
    localStorage.setItem(storageKey,JSON.stringify(data));
  } else if (editing) {
    if (!canManage()) throw Error('只有管理者可以編輯既有紀錄。');
    const {data,error} = await client.from('meter_readings').update(row)
      .eq('recorded_at',editing).eq('user_id',access.book_id).select('recorded_at').single();
    if (error || !data) throw error ?? Error('找不到該筆抄表紀錄。');
  } else {
    const {error} = await client.rpc('add_meter_reading',{
      reading_time:row.recorded_at,reading_floor1:row.floor1,reading_floor2:row.floor2,reading_floor3:row.floor3
    });
    if (error) throw error;
  }
  edit();
  $('month').value = taipei(row.recorded_at).slice(0,7);
  showMessage('save-message','已儲存抄表讀數。');
  try { await refresh(); } catch { showMessage('page-error','已儲存，重新整理頁面可載入最新紀錄。',true); }
}));
$('import').addEventListener('submit',event => submit(event,'import-message',async () => {
  if (!canManage()) throw Error('只有管理者可以匯入歷史紀錄。');
  const file = $('import').elements.namedItem('file').files[0];
  const imported = parseCSV(await file.text());
  let count;
  if (offline) {
    const data = new Map(localRows().map(row => [row.recorded_at,row]));
    const prior = data.size;
    for (const row of imported) if (!data.has(row.recorded_at)) data.set(row.recorded_at,row);
    localStorage.setItem(storageKey,JSON.stringify([...data.values()]));
    count = data.size - prior;
  } else {
    const {count:inserted,error} = await client.from('meter_readings').upsert(
      imported.map(row => ({...row,user_id:access.book_id})),
      {onConflict:'user_id,recorded_at',ignoreDuplicates:true,count:'exact'});
    if (error) throw error;
    count = inserted;
  }
  showMessage('import-message',count == null ? `已處理 ${imported.length} 筆抄表紀錄。`
    : `已新增 ${count} 筆，略過 ${imported.length - count} 筆相同時間的紀錄。`);
  try {
    await refresh();
    if (rows.length) $('month').value = rows.at(-1).local.slice(0,7);
    renderChart();
  } catch { showMessage('page-error','已匯入，重新整理頁面可載入最新紀錄。',true); }
}));
$('periods').addEventListener('click',event => {
  if (!event.target.dataset.period) return;
  period = event.target.dataset.period;
  for (const button of $('periods').children) button.setAttribute('aria-pressed',String(button.dataset.period === period));
  renderChart();
});
for (const id of ['floor','month','year']) $(id).addEventListener('change',renderChart);
$('history-filter').addEventListener('change',renderHistory);
$('export-excel').addEventListener('click',() => {
  if (!rows.length) return;
  const url = URL.createObjectURL(exportWorkbook(rows));
  const link = element('a');
  link.href = url;
  link.download = `家庭用電紀錄-${taipei().slice(0,10)}.xlsx`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url),30000);
});

async function start() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) {
    $('login').hidden = true;
    $('offline').hidden = false;
    showMessage('login-message','雲端尚未設定。可先在這個瀏覽器匯入 CSV、登錄讀數和查看趨勢。');
    return;
  }
  const {createClient} = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.4/+esm');
  client = createClient(SUPABASE_URL,SUPABASE_PUBLISHABLE_KEY);
  $('login').querySelector('button').disabled = false;
  const {data,error} = await client.auth.getSession();
  if (error) throw error;
  if (!data.session) return;
  $('logout').hidden = false;
  const result = await client.rpc('meter_book_access');
  if (result.error) throw result.error;
  access = result.data;
  if (!access?.book_id) {
    showMessage('login-message','這個帳號尚未取得家庭電量紀錄的權限。請聯絡管理者或切換 Google 帳號。',true);
    return;
  }
  await activate();
}
start().catch(error => showMessage('login-message','連線失敗：' + readError(error),true));

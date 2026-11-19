import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './config.mjs';
import { floors, taipei, normalize, parseCSV, calculate, summarize } from './meter.mjs';

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

function renderChart() {
  $('month-field').hidden = period !== 'day';
  $('year-field').hidden = period !== 'month';
  const filter = period === 'day' ? $('month').value : period === 'month' ? $('year').value : '';
  const {buckets,total,gaps,drops} = summarize(rows,period,filter,$('floor').value);
  $('sum').textContent = buckets.size ? display(total) : '—';
  $('summary-label').textContent = filter || '全部年度';
  const chart = $('chart');
  chart.replaceChildren();
  if (!buckets.size) chart.append(element('p','此範圍尚無可統計的用電量。','empty'));
  const ceiling = Math.max(1,...buckets.values());
  for (const [date,cents] of buckets) {
    const line = element('div',undefined,'chart-row');
    const bar = element('span',undefined,'chart-track');
    bar.setAttribute('aria-hidden','true');
    const fill = element('span',undefined,'chart-fill');
    fill.style.width = `${cents / ceiling * 100}%`;
    bar.append(fill);
    line.append(element('span',period === 'day' ? date.slice(5).replace('-','/') : date),bar,element('strong',display(cents)));
    chart.append(line);
  }
  const rule = period === 'day' ? '日用電量依抄表結束日顯示，跨多個日曆日的差值保留在明細。'
    : '用電量依每次抄表的結束日歸入當月或當年，跨期用電依抄表區間合計。';
  $('chart-note').textContent = rule + (gaps ? ` 本期略過 ${gaps} 筆跨日差值。` : '')
    + (drops ? ` 略過 ${drops} 筆讀數下降的區間。` : '')
    + ($('floor').value === 'total' ? ' 全樓合計加總各樓層可計算的差值。' : '');
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

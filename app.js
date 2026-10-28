'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const preset = JSON.parse($('connectionPreset').textContent);
  const PERIOD = 10000, STALE = 45000, MAX = 360;
  let definitions = preset.fields || [], items = {}, records = [], token = '', mode = 'real';
  let generation = 0, pollTimer, controller, demoTimer, connected = false, lastFetch = 0, receivedAt = 0, selected = 'PackVoltage', count = 0;
  const fmt = (time, full = false) => new Date(Number(time)).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false, ...(full ? {month:'2-digit',day:'2-digit'} : {}), hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const finite = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
  const reading = key => { const row = items[key]; return row && finite(row.value) && finite(row.time) && Number(row.time) > 0 ? row : null; };
  const num = key => reading(key) ? Number(items[key].value) : null;
  const show = (key, digits = 2, suffix = '') => num(key) === null ? '—' : num(key).toFixed(digits) + suffix;
  const stale = row => !row || !finite(row.time) || !connected || Date.now() - Math.min(Number(row.time), receivedAt || Date.now()) > STALE;
  const setBadge = (text, kind = '') => { $('connectionBadge').textContent = text; $('connectionBadge').className = 'badge ' + kind; };
  const notice = (text, kind = '') => { $('notice').textContent = text; $('notice').className = 'notice ' + kind; };
  function log(text) { const li = document.createElement('li'); li.textContent = fmt(Date.now()) + ' · ' + text; $('log').prepend(li); while ($('log').children.length > 30) $('log').lastChild.remove(); }
  function cancel() { generation++; clearTimeout(pollTimer); clearInterval(demoTimer); demoTimer = null; if (controller) controller.abort(); controller = null; token = ''; connected = false; $('refreshBtn').disabled = true; }
  function clearData() { items = {}; records = []; count = 0; receivedAt = 0; lastFetch = 0; $('exportBtn').disabled = true; renderAll(); }
  function exitDemo() { $('demoBadge').classList.add('hidden'); $('demoBtn').textContent = '演示数据'; }
  function start() {
    cancel(); exitDemo(); mode = 'real'; clearData();
    if (!preset.endpoint) { setBadge('待接入', 'warn'); notice('只读数据接口尚未配置，可点击“演示数据”预览。', 'warn'); return; }
    const supplied = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (!supplied) { setBadge('等待访问链接'); notice('请使用含有访问凭据的完整个人链接打开；普通网址无法读取设备数值。', 'warn'); return; }
    try {
      const endpoint = new URL(preset.endpoint);
      if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.fcapp.run') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('接口地址不正确');
      if (!/^[A-Za-z0-9_-]{32,}$/.test(supplied)) throw Error('访问凭据不完整');
      token = supplied; $('refreshBtn').disabled = false; poll(generation);
    } catch (error) { setBadge('无法连接', 'bad'); notice(error.message, 'bad'); }
  }
  async function poll(myGeneration) {
    if (myGeneration !== generation || !token || mode !== 'real' || controller) return;
    clearTimeout(pollTimer);
    const request = new AbortController(); controller = request;
    const deadline = setTimeout(() => request.abort(), 18000);
    if (!lastFetch) { setBadge('正在连接', 'warn'); notice('正在读取 BMS 最新属性…'); }
    try {
      const response = await fetch(preset.endpoint, {headers:{Authorization:'Bearer ' + token}, mode:'cors', credentials:'omit', cache:'no-store', referrerPolicy:'no-referrer', signal:request.signal});
      if (myGeneration !== generation) return;
      if (response.status === 401 || response.status === 403) { cancel(); setBadge('访问被拒绝', 'bad'); notice('只读访问凭据无效，请使用正确的个人链接。', 'bad'); tick(); return; }
      if (!response.ok) throw Error('数据接口暂不可用（HTTP ' + response.status + '）');
      const payload = await response.json();
      if (myGeneration !== generation) return;
      ingest(payload); lastFetch = Date.now(); connected = true; setBadge('接口已连接', 'good'); renderAll();
    } catch (error) {
      if (myGeneration !== generation) return;
      connected = false; setBadge(navigator.onLine ? '等待重连' : '网页已离线', 'warn');
      notice('暂时无法读取设备数据，10 秒后重试。已有数据保留，上报是否过期请看属性时间。', 'warn');
      log(error.name === 'AbortError' ? '数据读取超时。' : '数据读取失败，请检查接口、网络及 CORS。'); tick();
    } finally {
      clearTimeout(deadline); if (controller === request) controller = null;
      if (myGeneration === generation && token && mode === 'real') pollTimer = setTimeout(() => poll(myGeneration), PERIOD);
    }
  }
  function ingest(payload) {
    if (payload.deviceName !== preset.deviceName || payload.productKey !== preset.productKey || !payload.items || typeof payload.items !== 'object') throw Error('接口返回的设备不匹配');
    const now = Date.now(), changes = {};
    const known = new Set(definitions.map(x => x.Identifier));
    for (const [key, row] of Object.entries(payload.items)) {
      if (!known.has(key)) continue;
      if (!row || typeof row !== 'object') continue;
      const validTime = finite(row.time) && Number(row.time) > 0 && Number(row.time) < 8640000000000000;
      if (validTime && Number(row.time) > now + 300000) { log('忽略时间超前超过 5 分钟的属性：' + key); continue; }
      if (validTime && items[key]?.time && Number(row.time) < Number(items[key].time)) continue;
      if (validTime && (!items[key] || Number(row.time) > Number(items[key].time || 0))) changes[key] = {...row, time:Number(row.time)};
      items[key] = {...row, time:validTime ? Number(row.time) : null};
    }
    receivedAt = now;
    if (Object.keys(changes).length) {
      records.push({receivedAt:now, items:changes});
      records = records.filter(r => r.receivedAt >= now-3600000).slice(-MAX); count++;
      $('exportBtn').disabled = false;
      if (count === 1) log(mode === 'demo' ? '已收到第一条模拟数据。' : '已收到第一条真实属性记录。');
    }
  }
  function metricFooter(id, key, prefix = '') {
    const row = reading(key); $(id).textContent = row ? prefix + '上报 ' + fmt(row.time) + (stale(row) ? ' · 已过期' : '') : '等待上报';
    $(id).closest('.metric').classList.toggle('stale', !!row && stale(row));
  }
  function renderMetrics() {
    $('socValue').textContent = show('Soc', 0); $('socBar').style.width = Math.max(0, Math.min(100, num('Soc') || 0)) + '%';
    $('voltageValue').textContent = show('PackVoltage'); $('currentValue').textContent = show('Current');
    metricFooter('socFoot', 'Soc', show('RemainingCapacity', 2, ' Ah') + ' / ' + show('NominalCapacity', 2, ' Ah') + ' · ');
    metricFooter('voltageFoot', 'PackVoltage'); metricFooter('currentFoot', 'Current');
    const probes = definitions.filter(x => /^Temperature\d+$/.test(x.Identifier)).map(x => ({key:x.Identifier, row:reading(x.Identifier)})).filter(x => x.row);
    const max = probes.sort((a,b) => Number(b.row.value)-Number(a.row.value))[0];
    $('tempValue').textContent = max ? Number(max.row.value).toFixed(1) : '—';
    if (max) metricFooter('tempFoot', max.key, max.key.replace('Temperature','探头 ') + ' · ');
    else { $('tempFoot').textContent = '等待温度探头上报'; $('tempFoot').closest('.metric').classList.remove('stale'); }
    $('cellCount').textContent = show('CellCount', 0, ' 串'); $('minCell').textContent = show('MinCellVoltage', 3, ' V'); $('maxCell').textContent = show('MaxCellVoltage', 3, ' V');
    $('deltaCell').textContent = num('DeltaCellVoltage') === null ? '—' : (num('DeltaCellVoltage')*1000).toFixed(0) + ' mV';
    $('messageCount').textContent = count + ' 条';
  }
  function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function renderCells() {
    const cells = definitions.filter(x => /^CellVoltage\d+$/.test(x.Identifier)).sort((a,b) => Number(a.Identifier.slice(11))-Number(b.Identifier.slice(11)));
    const vals = cells.map(x => num(x.Identifier)).filter(x => x !== null), low = vals.length ? Math.min(...vals)-.01 : 0, high = vals.length ? Math.max(...vals)+.01 : 1;
    $('cells').replaceChildren(...cells.map(def => {
      const row = reading(def.Identifier), n = Number(def.Identifier.slice(11));
      const card = element('div', undefined, 'cell' + (!row ? ' unreported' : stale(row) ? ' stale' : '') + (num('CellCount') !== null && n > num('CellCount') ? ' outside' : ''));
      card.append(element('small', 'CELL ' + String(n).padStart(2,'0')), element('strong', row ? Number(row.value).toFixed(3) + ' V' : '未上报'));
      const bar = element('div', undefined, 'bar'), fill = element('i'); fill.style.width = row ? Math.max(0, Math.min(100, (Number(row.value)-low)/(high-low)*100))+'%' : '0'; bar.append(fill); card.append(bar);
      card.title = row ? def.Name + ' · ' + fmt(row.time, true) + (stale(row) ? ' · 已过期' : '') : def.Name + ' · 未上报'; return card;
    }));
  }
  function renderStatus() {
    const probes = definitions.filter(x => /^Temperature\d+$/.test(x.Identifier)).sort((a,b) => a.Identifier.localeCompare(b.Identifier, undefined, {numeric:true}));
    $('temperatures').replaceChildren(...probes.map(def => { const row = reading(def.Identifier), card = element('div', undefined, 'probe' + (row && stale(row) ? ' stale' : '')); card.append(element('small', def.Name), element('strong', show(def.Identifier, 1, ' °C'))); if (row) card.title = fmt(row.time,true); return card; }));
    const statuses = [['ChargeMosOn','充电 MOS'],['DischargeMosOn','放电 MOS'],['BalanceStatus','均衡状态码'],['ProtectionStatus','保护状态码'],['BleConn','BLE 连接上报'],['WifiStatus','Wi-Fi 连接上报']];
    $('deviceStatus').replaceChildren(...statuses.map(([key,label]) => { const row = reading(key), div = element('div'); let value = row ? String(row.value) : '未上报'; if (row && ['ChargeMosOn','DischargeMosOn'].includes(key)) value = Number(row.value) === 1 ? '开启' : Number(row.value) === 0 ? '关闭' : String(row.value); if (row && ['BleConn','WifiStatus'].includes(key)) value = Number(row.value) === 1 ? '已连接' : Number(row.value) === 0 ? '未连接' : String(row.value); div.append(element('span',label),element('strong',value + (row && stale(row) ? ' · 旧数据' : ''))); return div; }));
  }
  function renderTable() {
    const query = $('search').value.trim().toLowerCase();
    const filtered = definitions.filter(def => (def.Identifier + ' ' + def.Name).toLowerCase().includes(query));
    $('fieldCount').textContent = definitions.length + ' 项'; $('noResults').classList.toggle('hidden', filtered.length > 0);
    $('propertyRows').replaceChildren(...filtered.map(def => {
      const row = items[def.Identifier], valid = row && row.value !== null && row.value !== undefined && row.time;
      const tr = element('tr'), name = element('td'); name.append(element('strong',def.Name || def.Identifier),element('small',def.Identifier));
      const value = element('td', valid ? (row.value === '' ? '（空字符串）' : String(row.value)) : '—', 'value');
      const unit = element('td',def.Unit || '—'), time = element('td', valid ? fmt(row.time,true) : '未上报');
      const state = element('td'); state.append(element('span', valid ? (mode === 'demo' ? '模拟' : stale(row) ? '已过期' : '新鲜') : '未上报', 'state' + (valid && stale(row) ? ' warn' : '')));
      tr.append(name,value,unit,time,state); return tr;
    }));
  }
  function tick() {
    $('clock').textContent = fmt(Date.now(),true);
    const rows = Object.values(items).filter(row => row.time), latest = rows.length ? Math.max(...rows.map(row => Number(row.time))) : 0;
    $('latestTime').textContent = latest ? fmt(latest,true) : '—';
    const hasExpired = rows.some(stale), age = latest ? Math.max(0, Math.floor((Date.now()-Math.min(latest,receivedAt))/1000)) : null;
    $('freshness').textContent = mode === 'demo' ? '模拟数据' : !rows.length ? '等待数据' : !connected ? '网页连接中断' : hasExpired ? '部分属性已过期' : '数据新鲜';
    $('freshness').style.color = mode === 'demo' || hasExpired ? 'var(--orange)' : 'var(--green)';
    if (mode === 'demo') notice('演示模式 · 以下为模拟数据，未连接真实 BMS。', 'warn');
    else if (connected && latest) notice(hasExpired ? '数据接口已连接，但部分属性超过 45 秒无新上报，请查看属性时间。' : '同步中 · 最近上报 ' + fmt(latest) + ' · ' + age + ' 秒前', hasExpired ? 'warn' : '');
    renderMetrics(); renderCells(); renderStatus(); renderTable();
  }
  function renderChart() {
    const field = definitions.find(x => x.Identifier === selected), points = records.filter(r => r.items[selected] && finite(r.items[selected].value)).map(r => ({time:Number(r.items[selected].time),value:Number(r.items[selected].value)})).sort((a,b) => a.time-b.time);
    const svg = $('chart'), width = Math.max(1,svg.clientWidth || 900), left = width < 500 ? 39 : 51, right = Math.max(left+1,width-19), top = 18, bottom = 164;
    svg.setAttribute('viewBox',`0 0 ${width} 205`); svg.setAttribute('aria-label',(field?.Name || selected)+'趋势'); $('chartEmpty').classList.toggle('hidden',points.length > 0);
    let min = points.length ? Math.min(...points.map(p=>p.value)) : 0, max = points.length ? Math.max(...points.map(p=>p.value)) : 1;
    const pad = Math.max((max-min)*.2, selected === 'PackVoltage' ? .02 : selected === 'Current' ? .1 : .5); min -= pad; max += pad;
    const start = points.length ? points[0].time : Date.now(), end = points.length > 1 ? points.at(-1).time : start+60000;
    const x = t => left+(t-start)/Math.max(1,end-start)*(right-left), y = v => bottom-(v-min)/(max-min)*(bottom-top);
    let markup = '';
    for (let i=0;i<4;i++) { const value=min+(max-min)*i/3, yy=y(value); markup += `<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="#e7ede2" stroke-dasharray="4 5"/><text x="${left-7}" y="${yy+4}" text-anchor="end" fill="#8d9c83" font-size="10">${value.toFixed(selected==='PackVoltage'?2:1)}</text>`; }
    for (let i=0;i<3;i++) markup += `<text x="${left+(right-left)*i/2}" y="192" text-anchor="middle" fill="#8d9c83" font-size="10">${fmt(start+(end-start)*i/2)}</text>`;
    if (points.length) { let d='', previous=null; for (const p of points) { d += (previous===null || p.time-previous>STALE ? 'M' : 'L')+x(p.time).toFixed(2)+','+y(p.value).toFixed(2)+' '; previous=p.time; } markup += `<path d="${d}" fill="none" stroke="#36775b" stroke-width="2.4" stroke-linejoin="round"/>`; if(points.length<=60) for(const p of points) markup+=`<circle cx="${x(p.time)}" cy="${y(p.value)}" r="3" fill="#36775b" stroke="white"/>`; }
    svg.innerHTML = markup;
  }
  function renderAll() { renderMetrics(); renderCells(); renderStatus(); renderTable(); renderChart(); tick(); }
  $('demoBtn').addEventListener('click', () => {
    if(mode==='demo') { start(); return; }
    cancel(); mode='demo'; clearData(); connected=true; $('demoBadge').classList.remove('hidden'); $('demoBtn').textContent='返回实时'; setBadge('演示模式','warn');
    const demoStarted = Date.now();
    function sample() { const now=Date.now(), t=(now-demoStarted)/1000, data={};
      for(const def of definitions) { const key=def.Identifier; let value=null;
        if(/^CellVoltage\d+$/.test(key) && Number(key.slice(11))<=8) value=(3.44+Math.sin(t/30+Number(key.slice(11)))*.015).toFixed(3);
        else if(/^Temperature\d+$/.test(key) && Number(key.slice(11))<=3) value=(27+Math.sin(t/45+Number(key.slice(11)))).toFixed(1);
        else value=({PackVoltage:(27.51+Math.sin(t/30)*.04).toFixed(2),Current:(Math.sin(t/40)*.5).toFixed(2),Soc:94,RemainingCapacity:47,NominalCapacity:50,CycleCount:12,CellCount:8,TempSensorCount:3,ChargeMosOn:1,DischargeMosOn:1,ProtectionStatus:0,BalanceStatus:0,BleConn:1,WifiStatus:1,MinCellVoltage:3.425,MaxCellVoltage:3.455,DeltaCellVoltage:.030,AverageCellVoltage:3.44,Uptime:Math.floor(300+t),FwVersion:'演示版本'})[key] ?? null;
        data[key]={value,time:value===null?null:now}; }
      ingest({deviceName:preset.deviceName,productKey:preset.productKey,items:data}); connected=true;renderAll(); }
    sample(); demoTimer=setInterval(sample,PERIOD);
  });
  $('refreshBtn').addEventListener('click', () => poll(generation));
  $('search').addEventListener('input',renderTable);
  document.querySelectorAll('[data-chart]').forEach(button => button.addEventListener('click',()=>{selected=button.dataset.chart;document.querySelectorAll('[data-chart]').forEach(tab=>tab.setAttribute('aria-pressed',String(tab===button)));renderChart();}));
  $('exportBtn').addEventListener('click',()=>{
    if(!records.length)return;
    const quote = v => '"'+String(v??'').replace(/"/g,'""')+'"';
    const lines=['mode,received_at,identifier,name,value,unit,reported_at'];
    for(const record of records) for(const [key,row] of Object.entries(record.items)) { const def=definitions.find(x=>x.Identifier===key); const safe = value => /^[=+@\-\t\r]/.test(String(value)) && !finite(value) ? "'"+value : value; lines.push([mode,new Date(record.receivedAt).toISOString(),key,safe(def?.Name||key),safe(row.value),def?.Unit||'',new Date(row.time).toISOString()].map(quote).join(',')); }
    const url=URL.createObjectURL(new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=(mode==='demo'?'模拟-':'真实-')+'BMS-'+new Date().toISOString().replace(/[:.]/g,'-')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  });
  addEventListener('resize',renderChart); addEventListener('hashchange',start);
  addEventListener('offline',()=>{if(mode==='real'&&token){connected=false;setBadge('网页已离线','warn');notice('网页网络已断开，恢复后自动读取。','warn');renderAll();}});
  addEventListener('online',()=>{if(mode==='real'&&token)poll(generation);});
  addEventListener('pagehide',cancel); addEventListener('pageshow',event=>{if(event.persisted)start();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&mode==='real'&&token)poll(generation);});
  log('页面已就绪，正在检查只读访问链接。'); start(); setInterval(tick,1000);
})();

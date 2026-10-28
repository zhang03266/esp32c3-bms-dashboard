'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const preset = JSON.parse($('connectionPreset').textContent);
  const definitions = preset.fields || [], known = new Set(definitions.map(x => x.Identifier));
  const INTERVALS = [5,10,15,30,60,180,300], STALE = 45000, MAX = 360;
  let interval = 10;
  try { const saved=Number(localStorage.getItem('bms-refresh-interval')); if(INTERVALS.includes(saved)) interval=saved; } catch {}
  $('refreshInterval').value=String(interval);
  $('intervalDisplay').textContent=interval+' 秒';
  $('cacheHint').classList.toggle('hidden',interval!==5);
  const staleThreshold = () => STALE + Math.max(0,interval*1000-10000);
  let items = {}, records = [], token = '', generation = 0, pollTimer, controller;
  let connected = false, lastFetch = 0, receivedAt = 0, selected = 'PackVoltage', count = 0, serverOffset = 0;
  const clockNow = () => Date.now() + serverOffset;
  const finite = value => value !== null && value !== undefined && String(value).trim() !== '' && Number.isFinite(Number(value));
  const fmt = (time, full = false) => new Date(Number(time)).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',hour12:false,...(full?{month:'2-digit',day:'2-digit'}:{}),hour:'2-digit',minute:'2-digit',second:'2-digit'});
  const visible = (node, show) => node.classList.toggle('hidden', !show);
  function hasData(key) {
    const row = items[key];
    if (!row || !finite(row.time) || Number(row.time) <= 0 || row.value === null || row.value === undefined || String(row.value).trim() === '') return false;
    const type = definitions.find(x => x.Identifier === key)?.DataType;
    return ['int','float','double','long'].includes(type) ? finite(row.value) : true;
  }
  const reading = key => hasData(key) && finite(items[key].value) ? items[key] : null;
  const num = key => reading(key) ? Number(items[key].value) : null;
  const show = (key, digits = 2, unit = '') => num(key) === null ? '' : num(key).toFixed(digits) + unit;
  const stale = row => !connected || clockNow() - Math.min(Number(row.time), receivedAt || clockNow()) > staleThreshold();
  const setBadge = (text, kind = '') => { $('connectionBadge').textContent = text; $('connectionBadge').className = 'badge ' + kind; };
  const notice = (text, kind = '') => { $('notice').textContent = text; $('notice').className = 'notice ' + kind; };
  function element(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
  function log(text) { const li = element('li',fmt(clockNow())+' · '+text); $('log').prepend(li); while ($('log').children.length > 30) $('log').lastChild.remove(); }

  function applyTheme(theme) {
    const dark = theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const label = dark ? '切换至日间模式' : '切换至夜间模式';
    $('themeBtn').setAttribute('aria-label',label); $('themeBtn').title = label;
    document.querySelector('meta[name="theme-color"]').content = dark ? '#0b121b' : '#f3f6f8';
    renderChart();
  }
  $('themeBtn').addEventListener('click',()=>{
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('bms-theme',theme); } catch {}
    applyTheme(theme);
  });
  const scheme = matchMedia('(prefers-color-scheme: dark)');
  const updateSystemTheme = event=>{
    try { if (localStorage.getItem('bms-theme')) return; } catch {}
    applyTheme(event.matches?'dark':'light');
  };
  if (scheme.addEventListener) scheme.addEventListener('change',updateSystemTheme);
  else if (scheme.addListener) scheme.addListener(updateSystemTheme);

  function cancel() { generation++; clearTimeout(pollTimer); if (controller) controller.abort(); controller = null; token = ''; connected = false; $('refreshBtn').disabled = true; }
  function clearData() { items = {}; records = []; count = 0; receivedAt = 0; lastFetch = 0; $('exportBtn').disabled = true; renderAll(); }
  function empty(title, description) { $('emptyTitle').textContent = title; $('emptyDescription').textContent = description; }
  function start() {
    cancel(); serverOffset = 0; clearData();
    if (!preset.endpoint) { setBadge('待接入','warn'); notice('只读数据接口尚未配置。','warn'); empty('等待配置数据接口','完成接入后，将自动显示有数据的监测模块。'); return; }
    const supplied = new URLSearchParams(location.hash.slice(1)).get('token') || '';
    if (!supplied) { setBadge('等待访问链接'); notice('请使用完整的个人链接打开看板。','warn'); empty('使用个人链接连接设备','连接成功后，将显示设备已上报的数据。'); return; }
    try {
      const endpoint = new URL(preset.endpoint);
      if (endpoint.protocol !== 'https:' || !endpoint.hostname.endsWith('.fcapp.run') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('接口地址不正确');
      if (!/^[A-Za-z0-9_-]{32,}$/.test(supplied)) throw Error('访问凭据不完整');
      token = supplied; $('refreshBtn').disabled = false; empty('正在连接设备','正在读取云端最新上报，请稍候。'); poll(generation);
    } catch (error) { setBadge('无法连接','bad'); notice(error.message,'bad'); empty('暂时无法连接',error.message); }
  }
  async function poll(myGeneration) {
    if (myGeneration !== generation || !token || controller) return;
    clearTimeout(pollTimer);
    const request = new AbortController(); controller = request;
    const deadline = setTimeout(()=>request.abort(),18000);
    if (!lastFetch) { setBadge('正在连接','warn'); notice('正在读取 BMS 最新属性…'); }
    try {
      const response = await fetch(preset.endpoint,{headers:{Authorization:'Bearer '+token},mode:'cors',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:request.signal});
      if (myGeneration !== generation) return;
      if (response.status === 401 || response.status === 403) { cancel(); setBadge('访问被拒绝','bad'); notice('只读访问凭据无效，请使用正确的个人链接。','bad'); empty('访问凭据无效','请使用正确的个人链接重新打开。'); renderAll(); return; }
      if (!response.ok) throw Error('数据接口暂不可用（HTTP '+response.status+'）');
      const payload = await response.json();
      if (myGeneration !== generation) return;
      if (finite(payload.queriedAt)) serverOffset = Number(payload.queriedAt)-Date.now();
      ingest(payload); lastFetch = Date.now(); connected = true; setBadge('已连接','good'); empty('暂无已上报数据','收到有效上报后，对应模块将自动出现。'); renderAll();
    } catch (error) {
      if (myGeneration !== generation) return;
      connected = false; setBadge(navigator.onLine?'等待重连':'网页已离线','warn');
      notice('暂时无法读取设备数据，'+interval+' 秒后重试；已收到的数据保留。','warn');
      empty('等待连接恢复','网络恢复后将自动重新读取设备数据。');
      log(error.name==='AbortError'?'数据读取超时。':'数据读取失败，请检查接口、网络及 CORS。'); renderAll();
    } finally {
      clearTimeout(deadline); if (controller===request) controller=null;
      if (myGeneration===generation && token) pollTimer=setTimeout(()=>poll(myGeneration),interval*1000);
    }
  }
  function ingest(payload) {
    if (payload.deviceName!==preset.deviceName || payload.productKey!==preset.productKey || !payload.items || typeof payload.items!=='object' || Array.isArray(payload.items)) throw Error('接口返回的设备不匹配');
    const now=clockNow(), changes={}, next={};
    for (const [key,row] of Object.entries(payload.items)) {
      if (!known.has(key) || !row || typeof row!=='object') continue;
      if (!finite(row.time) || Number(row.time)<=0 || Number(row.time)>now+300000 || Number(row.time)>8640000000000000) continue;
      if (row.value===null || row.value===undefined || String(row.value).trim()==='') continue;
      if (items[key]?.time && Number(row.time)<Number(items[key].time)) { next[key]=items[key]; continue; }
      next[key]={...row,time:Number(row.time)};
      if (!items[key] || Number(row.time)>Number(items[key].time)) changes[key]=next[key];
    }
    items=next; receivedAt=now;
    const validChanges=Object.fromEntries(Object.entries(changes).filter(([key])=>hasData(key)));
    if (Object.keys(validChanges).length) {
      const snapshot=Object.fromEntries(definitions.filter(def=>hasData(def.Identifier)).map(def=>[def.Identifier,items[def.Identifier]]));
      records.push({receivedAt:now,reportedAt:Math.max(...Object.values(validChanges).map(row=>row.time)),items:validChanges,snapshot}); records=records.filter(r=>r.receivedAt>=now-3600000).slice(-MAX); count++;
      $('exportBtn').disabled=false; if (count===1) log('已收到第一条真实属性记录。');
    }
  }

  function metricFooter(id,key,prefix='') {
    const row=reading(key); $(id).textContent=row?prefix+'上报 '+fmt(row.time)+(stale(row)?' · 已过期':''):'';
    $(id).closest('.metric').classList.toggle('stale',!!row&&stale(row));
  }
  function fitReadings() {
    document.querySelectorAll('.metric:not(.hidden) .reading').forEach(container=>{
      const value=container.querySelector('strong'),unit=container.querySelector('span');
      value.style.fontSize='';
      const available=Math.max(1,container.clientWidth-unit.getBoundingClientRect().width-7);
      if(value.scrollWidth>available) value.style.fontSize=Math.max(10,Math.floor(parseFloat(getComputedStyle(value).fontSize)*available/value.scrollWidth))+'px';
    });
  }
  function renderMetrics() {
    $('socValue').textContent=show('Soc',0);
    $('voltageValue').textContent=show('PackVoltage'); $('currentValue').textContent=show('Current');
    const capacity=[show('RemainingCapacity',2,' Ah'),show('NominalCapacity',2,' Ah')].filter(Boolean).join(' / ');
    metricFooter('socFoot','Soc',capacity?capacity+' · ':''); metricFooter('voltageFoot','PackVoltage'); metricFooter('currentFoot','Current');
    const probes=definitions.filter(x=>/^Temperature\d+$/.test(x.Identifier)&&reading(x.Identifier));
    const max=probes.sort((a,b)=>num(b.Identifier)-num(a.Identifier))[0];
    $('tempValue').textContent=max?show(max.Identifier,1):'';
    if (max) metricFooter('tempFoot',max.Identifier,max.Name+' · ');
    document.querySelectorAll('[data-metric]').forEach(card=>visible(card,card.dataset.metric==='temperature'?!!max:!!reading(card.dataset.metric)));
    const metricCount=document.querySelectorAll('[data-metric]:not(.hidden)').length;
    visible($('metricGrid'),metricCount>0); $('metricGrid').style.setProperty('--metric-count',String(metricCount||1)); $('metricGrid').dataset.count=String(metricCount);
    document.querySelectorAll('[data-field]').forEach(node=>visible(node,hasData(node.dataset.field)));
    visible(document.querySelector('.cell-stats'),[...document.querySelectorAll('.cell-stats [data-field]')].some(node=>!node.classList.contains('hidden')));
    $('cellCount').textContent=show('CellCount',0,' 串'); visible($('cellCount'),!!reading('CellCount'));
    $('minCell').textContent=show('MinCellVoltage',3,' V'); $('maxCell').textContent=show('MaxCellVoltage',3,' V'); $('averageCell').textContent=show('AverageCellVoltage',3,' V');
    $('deltaCell').textContent=num('DeltaCellVoltage')===null?'':(num('DeltaCellVoltage')*1000).toFixed(0)+' mV';
    $('messageCount').textContent=count+' 条';
  }
  function renderCells() {
    const cells=definitions.filter(x=>/^CellVoltage\d+$/.test(x.Identifier)&&reading(x.Identifier)).sort((a,b)=>Number(a.Identifier.slice(11))-Number(b.Identifier.slice(11)));
    visible($('cellsModule'),cells.length>0);
    const values=cells.map(x=>num(x.Identifier)).filter(Number.isFinite),minimum=Math.min(...values),maximum=Math.max(...values);
    $('cells').replaceChildren(...cells.map(def=>{
      const row=items[def.Identifier],n=Number(def.Identifier.slice(11)),card=element('div',undefined,'cell'+(stale(row)?' stale':'')); card.dataset.field=def.Identifier;
      if (values.length>1 && minimum<maximum) card.classList.add(Number(row.value)===minimum?'cell-min':Number(row.value)===maximum?'cell-max':'cell-normal');
      const label=element('small',String(n));
      const value=element('strong',Number(row.value).toFixed(3)); value.append(element('em','V'));
      const battery=element('div',undefined,'cell-battery'); battery.append(value);
      card.append(label,battery); card.title=def.Name+' · '+fmt(row.time,true)+(stale(row)?' · 已过期':''); return card;
    }));
  }
  function renderTemperatures() {
    const probes=definitions.filter(x=>/^Temperature\d+$/.test(x.Identifier)&&reading(x.Identifier)).sort((a,b)=>a.Identifier.localeCompare(b.Identifier,undefined,{numeric:true}));
    visible($('temperatureModule'),probes.length>0); $('probeCount').textContent=probes.length+' 个探头';
    $('temperatures').replaceChildren(...probes.map(def=>{
      const row=items[def.Identifier],card=element('div',undefined,'probe'+(stale(row)?' stale':'')); card.dataset.field=def.Identifier;
      const value=element('strong',Number(row.value).toFixed(1)); value.append(element('em','°C'));
      card.append(element('small',def.Name),value,element('time',fmt(row.time)+(stale(row)?' · 已过期':''))); return card;
    }));
  }
  const groups={
    wifi:{module:'wifiModule',target:'wifiFields',keys:['WifiStatus','WifiSsid','WifiIp','WifiRssi','WifiChannel']},
    bluetooth:{module:'bluetoothModule',target:'bluetoothFields',keys:['BleConn','BleName','BleMac','BleRssi','Rssi','BleFailCount']},
    alerts:{module:'alertsModule',target:'alertFields',keys:['ProtectionStatus','BalanceStatus','ChargeMosOn','DischargeMosOn','OtaErrorCode']},
    device:{module:'deviceModule',target:'deviceFields',keys:['RemainingCapacity','NominalCapacity','CycleCount','CellCount','TempSensorCount','Uptime','FwVersion','SoftwareVersion','HardwareVersion','ProductionDate']},
    ota:{module:'otaModule',target:'otaFields',keys:['OtaStatus','OtaProgress','OtaFlag','OtaErrorCode','OtaTargetVersion']}
  };
  function renderGroups() {
    for (const group of Object.values(groups)) {
      const keys=group.keys.filter(hasData); visible($(group.module),keys.length>0);
      $(group.target).replaceChildren(...keys.map(key=>{
        const def=definitions.find(x=>x.Identifier===key),row=items[key],div=element('div'); div.dataset.field=key;
        div.append(element('span',def.Name,'field-name')); const value=element('strong',undefined,'field-value');
        if (['ChargeMosOn','DischargeMosOn','BleConn','WifiStatus'].includes(key)) {
          const on=row.value===true||row.value==='true'||Number(row.value)===1,off=row.value===false||row.value==='false'||Number(row.value)===0,mos=key.endsWith('MosOn');
          value.append(element('span',on?(mos?'开启':'已连接'):off?(mos?'关闭':'未连接'):String(row.value),'status-pill'+(on?' on':off?' off':'')));
        } else { value.append(document.createTextNode(typeof row.value==='object'?JSON.stringify(row.value):String(row.value))); if (def.Unit) value.append(element('span',def.Unit,'unit')); }
        if (stale(row)) value.append(element('span','旧数据 · '+fmt(row.time),'old'));
        if (['ProtectionStatus','OtaErrorCode'].includes(key)&&finite(row.value)&&Number(row.value)!==0) div.classList.add('attention');
        div.append(value); div.title=key+' · '+fmt(row.time,true); return div;
      }));
    }
    const attention=['ProtectionStatus','OtaErrorCode'].some(key=>reading(key)&&num(key)!==0);
    $('alertBadge').textContent=attention?'状态码需关注':'设备上报值'; $('alertBadge').classList.toggle('attention',attention);
  }
  function renderTable() {
    const available=definitions.filter(def=>hasData(def.Identifier)),query=$('search').value.trim().toLowerCase();
    const filtered=available.filter(def=>(def.Identifier+' '+def.Name).toLowerCase().includes(query));
    $('fieldCount').textContent=available.length+' 项'; visible($('propertiesModule'),available.length>0); visible($('noResults'),filtered.length===0);
    $('propertyRows').replaceChildren(...filtered.map(def=>{
      const row=items[def.Identifier],tr=element('tr'); tr.dataset.field=def.Identifier;
      const name=element('td'); name.append(element('strong',def.Name||def.Identifier),element('small',def.Identifier));
      const value=element('td',typeof row.value==='object'?JSON.stringify(row.value):String(row.value),'value'); if (def.Unit) value.append(element('span',def.Unit,'table-unit'));
      const stamp=element('td',fmt(row.time,true)),state=element('td'); state.append(element('span',stale(row)?'已过期':'新鲜','state'+(stale(row)?' warn':'')));
      tr.append(name,value,stamp,state); return tr;
    }));
  }
  function renderChart() {
    const buttons=[...document.querySelectorAll('[data-chart]')],available=buttons.filter(button=>reading(button.dataset.chart));
    buttons.forEach(button=>visible(button,!!reading(button.dataset.chart))); visible($('trendsModule'),available.length>0);
    if (!available.some(button=>button.dataset.chart===selected)) selected=available[0]?.dataset.chart||'PackVoltage';
    buttons.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.chart===selected)));
    const svg=$('chart'); if (!available.length) {svg.replaceChildren();return;}
    const field=definitions.find(x=>x.Identifier===selected),points=records.filter(r=>r.items[selected]&&finite(r.items[selected].value)).map(r=>({time:Number(r.items[selected].time),value:Number(r.items[selected].value)})).sort((a,b)=>a.time-b.time);
    const width=Math.max(1,svg.clientWidth||900),left=width<500?39:51,right=Math.max(left+1,width-17),top=18,bottom=164;
    svg.setAttribute('viewBox',`0 0 ${width} 210`); svg.setAttribute('aria-label',(field?.Name||selected)+'趋势'); visible($('chartEmpty'),points.length===0);
    let min=points.length?Math.min(...points.map(p=>p.value)):0,max=points.length?Math.max(...points.map(p=>p.value)):1;
    const pad=Math.max((max-min)*.2,selected === 'PackVoltage' ? 0.02 : selected === 'Current' ? 0.1 : 0.5);min-=pad;max+=pad;
    const start=points.length?points[0].time:clockNow(),end=points.length>1?points.at(-1).time:start+60000;
    const x=t=>left+(t-start)/Math.max(1,end-start)*(right-left),y=v=>bottom-(v-min)/(max-min)*(bottom-top);
    const style=getComputedStyle(document.documentElement),line=style.getPropertyValue('--line').trim(),text=style.getPropertyValue('--muted').trim(),color=style.getPropertyValue('--chart-line').trim(),surface=style.getPropertyValue('--surface').trim();
    let markup='';
    for(let i=0;i<4;i++){const value=min+(max-min)*i/3,yy=y(value);markup+=`<line x1="${left}" x2="${right}" y1="${yy}" y2="${yy}" stroke="${line}" stroke-dasharray="4 5"/><text x="${left-7}" y="${yy+4}" text-anchor="end" fill="${text}" font-size="12">${value.toFixed(selected==='PackVoltage'?2:1)}</text>`;}
    for(let i=0;i<3;i++)markup+=`<text x="${left+(right-left)*i/2}" y="192" text-anchor="${i===0?'start':i===2?'end':'middle'}" fill="${text}" font-size="12">${fmt(start+(end-start)*i/2)}</text>`;
    if(points.length){let d='',previous=null;for(const p of points){d+=(previous===null||p.time-previous>Math.max(STALE,interval*2000)?'M':'L')+x(p.time).toFixed(2)+','+y(p.value).toFixed(2)+' ';previous=p.time;}markup+=`<path d="${d}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;if(points.length<=60)for(const p of points)markup+=`<circle cx="${x(p.time)}" cy="${y(p.value)}" r="3" fill="${color}" stroke="${surface}"/>`;}
    svg.innerHTML=markup;
  }
  function tick() {
    $('clock').textContent=fmt(clockNow(),true);
    const valid=definitions.filter(def=>hasData(def.Identifier)).map(def=>items[def.Identifier]),latest=valid.length?Math.max(...valid.map(row=>row.time)):0;
    visible($('telemetry'),valid.length>0); visible($('emptyState'),valid.length===0);
    $('latestTime').textContent=latest?fmt(latest,true):'';
    const expired=valid.some(stale),age=latest?Math.max(0,Math.floor((clockNow()-Math.min(latest,receivedAt))/1000)):0;
    $('freshness').textContent=!valid.length?'等待数据':!connected?'网页连接中断':expired?'部分数据已过期':'数据新鲜'; $('freshness').style.color=expired?'var(--amber)':'var(--accent)';
    if(connected)notice(!valid.length?'接口已连接，等待设备有效上报。':expired?'接口已连接，部分属性超过 '+Math.round(staleThreshold()/1000)+' 秒无新上报。':'同步中 · 最近上报 '+fmt(latest)+' · '+age+' 秒前',expired?'warn':'');
    renderMetrics();renderCells();renderTemperatures();renderGroups();renderTable();fitReadings();
  }
  function renderAll(){tick();renderChart();}
  $('refreshInterval').addEventListener('change',event=>{
    const next=Number(event.target.value); if(!INTERVALS.includes(next)){event.target.value=String(interval);return;}
    interval=next; $('intervalDisplay').textContent=interval+' 秒'; $('cacheHint').classList.toggle('hidden',interval!==5); try { localStorage.setItem('bms-refresh-interval',String(interval)); } catch {}
    clearTimeout(pollTimer); renderAll(); if(token&&!controller) poll(generation);
  });
  $('refreshBtn').addEventListener('click',()=>poll(generation)); $('search').addEventListener('input',renderTable);
  document.querySelectorAll('[data-chart]').forEach(button=>button.addEventListener('click',()=>{selected=button.dataset.chart;renderChart();}));
  $('exportBtn').addEventListener('click',()=>{
    if(!records.length)return;
    const quote=v=>'"'+String(v??'').replace(/"/g,'""')+'"',safe=value=>/^[\s]*[=+@\-\t\r]/.test(String(value))&&!finite(value)?"'"+value:value;
    const columns=definitions.filter(def=>records.some(record=>record.snapshot[def.Identifier]));
    const label=def=>(def.Name||def.Identifier)+(def.Unit?' ('+def.Unit+')':'');
    const labels=columns.map(label),headers=columns.map((def,i)=>labels.indexOf(labels[i])===labels.lastIndexOf(labels[i])?labels[i]:labels[i]+' ['+def.Identifier+']');
    const lines=[['序号','上报时间（北京时间）',...headers].map(quote).join(',')];
    records.forEach((record,index)=>{const time=new Date(record.reportedAt).toLocaleString('sv-SE',{timeZone:'Asia/Shanghai',hour12:false});const values=columns.map(def=>{const value=record.snapshot[def.Identifier]?.value;return safe(typeof value==='object'&&value!==null?JSON.stringify(value):value??'');});lines.push([index+1,time,...values].map(quote).join(','));});
    const url=URL.createObjectURL(new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'})),a=element('a');a.href=url;a.download='BMS-'+new Date().toISOString().replace(/[:.]/g,'-')+'.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);
  });
  addEventListener('resize',()=>{renderChart();fitReadings();});addEventListener('hashchange',start);
  addEventListener('offline',()=>{if(token){connected=false;setBadge('网页已离线','warn');notice('网页网络已断开，恢复后自动读取。','warn');renderAll();}});
  addEventListener('online',()=>{if(token)poll(generation);});addEventListener('pagehide',cancel);addEventListener('pageshow',event=>{if(event.persisted)start();});
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'&&token)poll(generation);});
  applyTheme(document.documentElement.dataset.theme);log('页面已就绪，正在检查只读访问链接。');start();setInterval(tick,1000);
})();

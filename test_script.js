
const IST_OFFSET = 5.5 * 60 * 60000;
let startingCapital = 0; 
let isPremiumUser = false;

function getCapital() { return startingCapital > 0 ? startingCapital : null; }
function getReturnPct(totalPnl) {
  const cap = getCapital();
  if (!cap || cap <= 0) return null;
  return +((totalPnl / cap) * 100).toFixed(2);
}
function fmtReturn(totalPnl) {
  const pct = getReturnPct(totalPnl);
  if (pct === null) return '—';
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
}
function fmtCapital() {
  const cap = getCapital();
  if (!cap) return '—';
  return '$' + cap.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
}

let charts = {};
let allTrades = [];
let calYear = 0, calMonth = 0;
let availableMonths = [];
let availableYears = [];
let currentYear = new Date().getFullYear();
let calViewMode = 'month'; 

let dailyDayMap = {};
let dailyDayKeys = [];

/* --- Chart.js Plugins --- */
const noTradePlugin = {
  id: 'noTradeText',
  afterDatasetsDraw(chart) {
    const { ctx, data, scales } = chart;
    const dataset = data.datasets[0];
    const meta = chart.getDatasetMeta(0);

    ctx.save();
    ctx.font = 'bold 9px "IBM Plex Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    meta.data.forEach((bar, index) => {
      const value = dataset.data[index];
      if (value === 0) {
        const x = bar.x;
        const y = scales.y.getPixelForValue(0);
        const barWidth = bar.width;
        const barHeight = 40;

        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = 'rgba(128,128,128,0.4)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - barWidth/2 + 2, y - barHeight/2, barWidth - 4, barHeight);
        ctx.setLineDash([]);

        ctx.fillStyle = 'rgba(128,128,128,0.08)';
        ctx.fillRect(x - barWidth/2 + 2, y - barHeight/2, barWidth - 4, barHeight);

        ctx.fillStyle = 'rgba(128,128,128,0.7)';
        ctx.fillText('No', x, y - 5);
        ctx.fillText('Trade', x, y + 6);
      }
    });
    ctx.restore();
  }
};

/* --- Helpers --- */
function toIST(s) {
  if (!s) return null;
  if (s instanceof Date) return s;
  
  let clean = s.replace(/\./g, '-');
  if (!clean || clean.trim() === '') return null;
  
  let raw = clean.includes('T') ? clean : clean.replace(' ', 'T');
  let wz = raw.endsWith('Z') || raw.includes('+') || raw.includes('-') ? raw : raw + 'Z';
  
  const d = new Date(wz);
  if (isNaN(d.getTime())) {
    const d2 = new Date(s);
    if (isNaN(d2.getTime())) return null;
    return new Date(d2.getTime() + IST_OFFSET);
  }
  return new Date(d.getTime() + IST_OFFSET);
}
function pad2(n) { return String(n).padStart(2,'0'); }
const MONTHS_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const MONTHS_LONG = ['January','February','March','April','May','June','July','August','September','October','November','December'];
function fmtDate(d) { return d.getUTCDate()+' '+MONTHS_SHORT[d.getUTCMonth()]+' '+d.getUTCFullYear(); }
function fmtShort(d) { return d.getUTCDate()+' '+MONTHS_SHORT[d.getUTCMonth()]; }
function fmtTime(d) {
  const h = d.getUTCHours();
  const m = pad2(d.getUTCMinutes());
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return h12 + ':' + m + ' ' + ampm;
}
function isoDay(d) { return d.getUTCFullYear()+'-'+pad2(d.getUTCMonth()+1)+'-'+pad2(d.getUTCDate()); }
function monthLabel(y,m) { return MONTHS_LONG[m]+' '+y; }

/* --- CSV Parser --- */
function splitCSVLine(line, sep) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === sep && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function findHeaderIndex(headers, aliases) {
  for (const alias of aliases) {
    const idx = headers.indexOf(alias);
    if (idx !== -1) return idx;
  }
  for (const alias of aliases) {
    const idx = headers.findIndex(h => h.includes(alias));
    if (idx !== -1) return idx;
  }
  return -1;
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error('CSV appears empty.');
  const sep = lines[0].includes('\t') ? '\t' : ',';
  
  // Normalize headers
  const headers = splitCSVLine(lines[0], sep).map(h => 
    h.trim().replace(/^"|"$/g, '').toLowerCase().replace(/\s+/g, '_')
  );

  const aliasMap = {
    ticket: ['ticket', 'position_id', 'id', 'order', 'deal', 'transaction'],
    open: ['opening_time_utc', 'open_time_utc', 'open_time', 'opening_time', 'open'],
    close: ['closing_time_utc', 'close_time_utc', 'close_time', 'closing_time', 'close'],
    type: ['type', 'action', 'direction', 'cmd', 'side'],
    symbol: ['symbol', 'instrument', 'asset', 'ticker', 'pair'],
    lots: ['lots', 'volume', 'amount', 'size', 'vol'],
    profit: ['profit', 'pnl', 'gain', 'net_profit', 'profit_loss']
  };

  const idxMap = {};
  for (const [key, aliases] of Object.entries(aliasMap)) {
    idxMap[key] = findHeaderIndex(headers, aliases);
  }

  const required = ['open', 'close', 'type', 'symbol', 'profit'];
  const missing = required.filter(k => idxMap[k] === -1);
  if (missing.length) {
    throw new Error('Missing columns: ' + missing.map(k => aliasMap[k][0]).join(', ') + '. Please export a valid trade history CSV.');
  }

  const cleanNumStr = str => str.replace(/[$,\s]/g, '');
  const trades = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = splitCSVLine(line, sep).map(c => c.trim().replace(/^"|"$/g, ''));
    
    const profitVal = cols[idxMap['profit']];
    if (!profitVal) continue;
    const profit = parseFloat(cleanNumStr(profitVal));
    if (isNaN(profit)) continue;
    
    const openStr = cols[idxMap['open']];
    const closeStr = cols[idxMap['close']];
    if (!openStr || !closeStr) continue;
    
    const ticketIdx = idxMap['ticket'];
    const ticket = ticketIdx !== -1 && cols[ticketIdx] ? cols[ticketIdx] : String(1000000 + i);
    
    const typeIdx = idxMap['type'];
    const type = typeIdx !== -1 ? cols[typeIdx].toLowerCase() : 'buy';
    
    const symbolIdx = idxMap['symbol'];
    const symbol = symbolIdx !== -1 ? cols[symbolIdx].toUpperCase() : 'UNKNOWN';
    
    const lotsIdx = idxMap['lots'];
    const lotsVal = lotsIdx !== -1 ? cols[lotsIdx] : '0.01';
    const lots = parseFloat(cleanNumStr(lotsVal)) || 0.01;
    
    trades.push({
      ticket,
      open: openStr,
      close: closeStr,
      type,
      symbol,
      lots,
      profit
    });
  }

  if (!trades.length) throw new Error('No valid closed trades found.');
  return trades;
}

function buildDayMap(trades, year, month) {
  const dayData = {};
  trades.forEach(t => {
    const d = t.closeIST;
    if (d.getUTCFullYear() === year && d.getUTCMonth() === month) {
      const key = isoDay(d);
      if (!dayData[key]) dayData[key] = {pnl:0, trades:[], wins:0, losses:0};
      dayData[key].pnl += t.profit;
      dayData[key].trades.push(t);
      if (t.profit > 0) dayData[key].wins++; else dayData[key].losses++;
    }
  });
  Object.keys(dayData).forEach(k => { dayData[k].pnl = +dayData[k].pnl.toFixed(2); });
  return dayData;
}

function buildMonthlySummaryCards(dayData) {
  const monthPnl = Object.values(dayData).reduce((s,d)=>s+d.pnl,0);
  const monthTrades = Object.values(dayData).reduce((s,d)=>s+d.trades.length,0);
  const monthWins = Object.values(dayData).reduce((s,d)=>s+d.wins,0);
  const tradingDays = Object.keys(dayData).length;
  const winDays = Object.values(dayData).filter(d=>d.pnl>0).length;
  return [
    {lbl:'Month P&L', val:(monthPnl>=0?'+':'')+'$'+monthPnl.toFixed(2), c:monthPnl>=0?'win':'loss'},
    {lbl:'Trades', val:monthTrades, c:''},
    {lbl:'Win Rate', val:monthTrades?((monthWins/monthTrades)*100).toFixed(0)+'%':'—', c:''},
    {lbl:'Trading Days', val:tradingDays, c:''},
    {lbl:'Profit Days', val:winDays+' / '+tradingDays, c:winDays>tradingDays/2?'win':'loss'},
  ];
}

function renderMonthGrid(gridEl, dayData, year, month, onCellClick) {
  gridEl.innerHTML = '';
  const firstDay = new Date(Date.UTC(year, month, 1));
  const startOffset = (firstDay.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month+1, 0)).getUTCDate();
  const todayISO = isoDay(toIST(new Date().toISOString()));

  const cells = [];
  for (let i = 0; i < startOffset; i++) {
    cells.push({ type: 'empty' });
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = year+'-'+pad2(month+1)+'-'+pad2(d);
    cells.push({
      type: 'day',
      d: d,
      dateKey: dateKey,
      data: dayData[dateKey]
    });
  }
  const remaining = cells.length % 7;
  if (remaining > 0) {
    const pad = 7 - remaining;
    for (let i = 0; i < pad; i++) {
      cells.push({ type: 'empty' });
    }
  }

  const maxAbs = Math.max(...Object.values(dayData).map(d=>Math.abs(d.pnl)), 0.01);
  const numWeeks = cells.length / 7;

  for (let w = 0; w < numWeeks; w++) {
    const weekCells = cells.slice(w * 7, (w + 1) * 7);
    let weeklyPnl = 0;
    let weeklyTrades = 0;
    let weeklyWins = 0;
    let weeklyLosses = 0;
    let hasWeeklyData = false;

    weekCells.forEach(cObj => {
      if (cObj.type === 'day' && cObj.data) {
        weeklyPnl += cObj.data.pnl;
        weeklyTrades += cObj.data.trades.length;
        weeklyWins += cObj.data.wins;
        weeklyLosses += cObj.data.losses;
        hasWeeklyData = true;
      }
    });

    weekCells.forEach(cObj => {
      if (cObj.type === 'empty') {
        const c = document.createElement('div');
        c.className = 'cal-cell empty';
        gridEl.appendChild(c);
      } else {
        const data = cObj.data;
        const dateKey = cObj.dateKey;
        const cell = document.createElement('div');
        cell.className = 'cal-cell' + (data ? ' has-trades' : '');
        if (data) cell.classList.add(data.pnl >= 0 ? 'win-day' : 'loss-day');
        if (dateKey === todayISO) cell.classList.add('today');

        let inner = '<div class="day-num">'+cObj.d+'</div>';
        if (data) {
          const pnlColor = data.pnl >= 0 ? '#1A8F68' : '#C94B2B';
          inner += '<div class="day-pnl" style="color:'+pnlColor+'">'+(data.pnl>=0?'+':'')+'$'+data.pnl.toFixed(2)+'</div>';
          inner += '<div class="day-trades">'+data.trades.length+' trade'+(data.trades.length!==1?'s':'')+' · '+data.wins+'W/'+data.losses+'L</div>';
          const barPct = Math.min(100, (Math.abs(data.pnl)/maxAbs)*100);
          inner += '<div class="day-bar" style="background:'+pnlColor+';width:'+barPct+'%;opacity:0.6;"></div>';
        }
        cell.innerHTML = inner;
        if (data && onCellClick) {
          cell.addEventListener('click', () => onCellClick(dateKey, data, cell));
        }
        gridEl.appendChild(cell);
      }
    });

    const wCell = document.createElement('div');
    wCell.className = 'cal-cell weekly-cell';
    if (hasWeeklyData) {
      wCell.classList.add(weeklyPnl >= 0 ? 'win-week' : 'loss-week');
      const pnlColor = weeklyPnl >= 0 ? '#1A8F68' : '#C94B2B';
      let inner = '<div class="day-num" style="color: ' + pnlColor + '; font-weight: 700; font-size: 10px; letter-spacing: 0.05em;">WEEKLY</div>';
      inner += '<div class="day-pnl" style="color:'+pnlColor+'; font-weight: bold; margin-top: 2px;">'+(weeklyPnl>=0?'+':'')+'$'+weeklyPnl.toFixed(2)+'</div>';
      inner += '<div class="day-trades" style="margin-top: auto;">'+weeklyTrades+' trade'+(weeklyTrades!==1?'s':'')+' · '+weeklyWins+'W/'+weeklyLosses+'L</div>';
      wCell.innerHTML = inner;
    } else {
      wCell.classList.add('empty');
      wCell.innerHTML = '<div class="day-num" style="color: var(--muted); font-weight: 700; font-size: 10px; letter-spacing: 0.05em;">WEEKLY</div><div style="font-size: 10px; color: var(--muted); margin-top: auto;">No trades</div>';
    }
    gridEl.appendChild(wCell);
  }
}

function tradeRowHTML(t) {
  const w = t.profit > 0;
  const diffMs = new Date(toIST(t.close)) - new Date(toIST(t.open));
  const diffSec = Math.round(diffMs / 1000);
  const dur = Math.round(diffMs / 60000);
  const ds = diffSec < 60 ? diffSec + 's' : (dur >= 60 ? Math.floor(dur/60)+'h '+(dur%60)+'m' : dur+'m');
  const openTime = fmtTime(new Date(toIST(t.open)));
  const closeTime = fmtTime(t.closeIST);
  return '<div class="trade-row">'
      +'<span class="badge-'+(t.type==='buy'?'buy':'sell')+'">'+(t.type==='buy'?'B':'S')+'</span>'
      +'<span style="font-weight:600;width:66px;font-size:13px;">'+t.symbol+'</span>'
      +'<span class="badge-lots">'+t.lots.toFixed(2)+'</span>'
      +'<span class="trade-time-details"><span style="color:var(--green);">Open '+openTime+'</span> → <span style="color:var(--red);">Close '+closeTime+'</span> IST · '+ds+'</span>'
      +'<span class="tag '+(w?'tag-w':'tag-l')+'">'+(w?'+':'')+'$'+t.profit.toFixed(2)+'</span>'
      +'</div>';
}

function renderMonthlyBars(containerEl, yearMonthDataMap, onBarClick) {
  const months = Object.keys(yearMonthDataMap).sort();
  if (!months.length) { containerEl.innerHTML = '<p style="font-size:12px;color:var(--muted);padding:1rem 0;">No monthly data calculated.</p>'; return; }
  const vals = months.map(k => yearMonthDataMap[k].pnl);
  const maxAbs = Math.max(...vals.map(v => Math.abs(v)), 0.01);
  const MAX_H = 80;

  containerEl.innerHTML = months.map(k => {
    const [y,m] = k.split('-');
    const d = yearMonthDataMap[k];
    const isWin = d.pnl >= 0;
    const h = Math.max(4, Math.round((Math.abs(d.pnl)/maxAbs) * MAX_H));
    const color = isWin ? '#1A8F68' : '#C94B2B';
    const sign = isWin ? '+' : '';
    return `<div class="month-bar-col" data-ym="${k}" title="${MONTHS_SHORT[parseInt(m)-1]} ${y}: ${sign}$${d.pnl.toFixed(2)}">
      <div class="month-bar-val" style="color:${color}">${sign}$${d.pnl.toFixed(2)}</div>
      <div style="flex:1;width:100%;display:flex;align-items:${isWin?'flex-end':'flex-start'};">
        <div class="month-bar" style="height:${h}px;background:${color};width:100%;opacity:0.85;border-radius:4px;"></div>
      </div>
      <div class="month-bar-label">${MONTHS_SHORT[parseInt(m)-1]}</div>
    </div>`;
  }).join('');

  if (onBarClick) {
    containerEl.querySelectorAll('.month-bar-col').forEach(col => {
      col.addEventListener('click', () => onBarClick(col.dataset.ym));
    });
  }
}

function renderMiniMonths(containerEl, yearMonthDataMap, selectedYM, onMonthClick) {
  const allYMs = [];
  const years = [...new Set(Object.keys(yearMonthDataMap).map(k=>k.split('-')[0]))].sort();
  years.forEach(y => {
    for (let m = 1; m <= 12; m++) {
      allYMs.push(y+'-'+pad2(m));
    }
  });

  containerEl.innerHTML = allYMs.map(ym => {
    const [y,m] = ym.split('-');
    const data = yearMonthDataMap[ym];
    const hasData = !!data;
    const isActive = ym === selectedYM;
    const monthNum = parseInt(m)-1;
    const year = parseInt(y);

    let dots = '';
    if (hasData) {
      const daysInM = new Date(Date.UTC(year, monthNum+1, 0)).getUTCDate();
      const firstDay = new Date(Date.UTC(year, monthNum, 1)).getUTCDay();
      for (let i=0;i<firstDay;i++) dots += '<div class="mini-cal-dot empty-d"></div>';
      for (let d=1;d<=daysInM;d++) {
        const key = y+'-'+pad2(monthNum+1)+'-'+pad2(d);
        const dd = data.dayData[key];
        if (dd) {
          dots += '<div class="mini-cal-dot '+(dd.pnl>=0?'win-d':'loss-d')+'" title="'+pad2(d)+': '+(dd.pnl>=0?'+':'')+'$'+dd.pnl.toFixed(2)+'"></div>';
        } else {
          dots += '<div class="mini-cal-dot"></div>';
        }
      }
    }

    const pnlColor = hasData ? (data.pnl >= 0 ? '#1A8F68' : '#C94B2B') : 'var(--muted)';
    const pnlText = hasData ? ((data.pnl>=0?'+':'')+'$'+data.pnl.toFixed(2)) : '—';

    return `<div class="mini-month ${isActive?'active-month':''} ${!hasData?'no-data':''}" data-ym="${ym}">
      <div class="mini-month-header">
        <span class="mini-month-name">${MONTHS_SHORT[monthNum]} ${y}</span>
        <span class="mini-month-pnl" style="color:${pnlColor}">${pnlText}</span>
      </div>
      ${hasData ? `<div class="mini-cal-grid">${dots}</div>
      <div class="mini-month-stats">
        <span class="mini-stat">Trades: <span>${data.trades}</span></span>
        <span class="mini-stat">WR: <span>${data.wr}%</span></span>
      </div>` : '<div style="font-size:11px;color:var(--muted);padding:0.25rem 0;">No trades</div>'}
    </div>`;
  }).join('');

  containerEl.querySelectorAll('.mini-month:not(.no-data)').forEach(el => {
    el.addEventListener('click', () => onMonthClick(el.dataset.ym));
  });
}

function buildYearMonthDataMap(trades, year) {
  const map = {};
  for (let m = 0; m < 12; m++) {
    const ym = year+'-'+pad2(m+1);
    const dayData = buildDayMap(trades, year, m);
    if (Object.keys(dayData).length > 0) {
      const pnl = +Object.values(dayData).reduce((s,d)=>s+d.pnl,0).toFixed(2);
      const tradesCount = Object.values(dayData).reduce((s,d)=>s+d.trades.length,0);
      const wins = Object.values(dayData).reduce((s,d)=>s+d.wins,0);
      map[ym] = {
        pnl, trades: tradesCount,
        wr: tradesCount ? (wins/tradesCount*100).toFixed(0) : '0',
        wins, dayData
      };
    }
  }
  return map;
}

/* ═══════════════════════════════════
   MAIN DASHBOARD BUILD
   ═══════════════════════════════════ */
function buildDashboard(raw) {
  const trades = raw.map(t=>({...t, closeIST:toIST(t.close), openIST:toIST(t.open)})).sort((a,b)=>a.closeIST-b.closeIST);
  allTrades = trades;

  const totalPnl = +trades.reduce((s,t)=>s+t.profit,0).toFixed(2);
  const wins = trades.filter(t=>t.profit>0);
  const losses = trades.filter(t=>t.profit<=0);
  const wr = trades.length ? (wins.length/trades.length*100).toFixed(1) : '0';
  const avgW = wins.length?(wins.reduce((s,t)=>s+t.profit,0)/wins.length).toFixed(2):'0.00';
  const avgL = losses.length?(losses.reduce((s,t)=>s+t.profit,0)/losses.length).toFixed(2):'0.00';
  const best = trades.length ? Math.max(...trades.map(t=>t.profit)) : 0;
  const worst = trades.length ? Math.min(...trades.map(t=>t.profit)) : 0;

  const cap = getCapital();
  const returnPct = getReturnPct(totalPnl);

  /* Sidebar meta */
  if (trades.length > 0) {
    const firstD = trades[0].closeIST, lastD = trades[trades.length-1].closeIST;
    const sMeta = document.getElementById('sidebarMeta');
    if (sMeta) sMeta.textContent = fmtShort(firstD)+' – '+fmtShort(lastD);
    document.getElementById('topMeta').textContent = trades.length+' trades · '+fmtShort(firstD)+' – '+fmtShort(lastD)+' IST';
  } else {
    const sMeta = document.getElementById('sidebarMeta');
    if (sMeta) sMeta.textContent = '—';
    document.getElementById('topMeta').textContent = 'Upload your Exness CSV to begin';
  }

  const pnlSidebar = document.getElementById('sidebarPnl');
  if (pnlSidebar) {
    pnlSidebar.textContent = (totalPnl>=0?'+':'')+'$'+totalPnl.toFixed(2);
    pnlSidebar.style.color = totalPnl>=0 ? '#1A8F68' : '#C94B2B';
  }

  document.getElementById('nav-badge-overview').textContent = trades.length;
  document.getElementById('nav-badge-trades').textContent = trades.length;

  const grossProfit = wins.reduce((s,t)=>s+t.profit,0);
  const grossLoss = Math.abs(losses.reduce((s,t)=>s+t.profit,0));
  const profitFactor = grossLoss > 0 ? (grossProfit / grossLoss).toFixed(2) : '∞';

  const avgWinAmount = wins.length ? (wins.reduce((s,t)=>s+t.profit,0) / wins.length) : 0;
  const avgLossAmount = losses.length ? Math.abs(losses.reduce((s,t)=>s+t.profit,0) / losses.length) : 0;
  const riskRewardRatio = avgLossAmount > 0 ? (avgWinAmount / avgLossAmount).toFixed(2) : '0.00';

  const mEl = document.getElementById('metrics'); mEl.innerHTML='';
  const metrics = [
   {lbl:'Net P&L',    val:(totalPnl>=0?'+':'')+'$'+totalPnl.toFixed(2), sub:trades.length+' closed trades',      c:totalPnl>=0?'win':'loss'},
   {lbl:'Win Rate',   val:wr+'%',        sub:wins.length+'W / '+losses.length+'L',                                c:''},
   {lbl:'Trades',     val:trades.length, sub:trades.length ? fmtShort(trades[0].closeIST)+' – '+fmtShort(trades[trades.length-1].closeIST) : '—', c:''},
   {lbl:'Avg Win',    val:'+$'+avgW,     sub:'per winning trade',                                                 c:'win'},
   {lbl:'Avg Loss',   val:'$'+avgL,      sub:'per losing trade',                                                  c:'loss'},
   {lbl:'Risk Reward', val:'1:'+riskRewardRatio, sub:'avg win / avg loss', c: parseFloat(riskRewardRatio)>=1.5?'win':(parseFloat(riskRewardRatio)>=1?'':'loss')},
   {lbl:'Best Trade', val:'+$'+best.toFixed(2), sub:'single trade',                                              c:'win'},
   {lbl:'Worst Trade',val:'$'+worst.toFixed(2), sub:'single trade',                                              c:'loss'},
   {lbl:'Profit Factor', val:profitFactor, sub: parseFloat(profitFactor) < 1.00 ? '❌ Losing Money' : (parseFloat(profitFactor) < 1.30 ? '⚠️ Break-Even' : (parseFloat(profitFactor) < 1.50 ? '📉 Weak Edge' : (parseFloat(profitFactor) < 2.00 ? 'Solid Target' : (parseFloat(profitFactor) <= 2.50 ? '🏆 Excellent' : '🚨 Suspicious')))), c: profitFactor>=1.5?'win':(profitFactor>=1?'':'loss')},
  ];

  if (returnPct !== null) {
    metrics.unshift({
      lbl:'Total Return', val:(returnPct>=0?'+':'')+returnPct.toFixed(2)+'%', sub:'on $'+cap.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})+' capital', c:returnPct>=0?'win':'loss'
    });
  }

  metrics.forEach(m=>{
    const d=document.createElement('div'); d.className='mcard';
    d.innerHTML='<div class="lbl">'+m.lbl+'</div><div class="val '+m.c+'">'+m.val+'</div><div class="sub">'+m.sub+'</div>';
    mEl.appendChild(d);
  });

  destroyCharts();
  if (trades.length === 0) return;

  const tc='#aaa', gc='rgba(0,0,0,0.04)';

  function buildEquityData(tradeset) {
    let cum = cap || 0;
    const pts = [], labels = [], colors = [], profits = [];
    tradeset.forEach((t) => {
      cum = +(cum + t.profit).toFixed(2);
      pts.push(cum);
      profits.push(t.profit);
      colors.push(t.profit >= 0 ? 'rgba(26,143,104,0.9)' : 'rgba(201,75,43,0.9)');
      labels.push(fmtShort(t.closeIST));
    });
    return { pts, labels, colors, profits };
  }

  function buildEquityChart(tradeset) {
    const { pts, labels, colors, profits } = buildEquityData(tradeset);

    if (charts.equity) {
      charts.equity.data.labels = labels;
      charts.equity.data.datasets[0].data = pts;
      charts.equity.data.datasets[0].pointBackgroundColor = colors;
      charts.equity.data.datasets[0].pointBorderColor = colors;
      const newLineColor = pts[pts.length-1] >= (cap || 0) ? '#1A8F68' : '#C94B2B';
      charts.equity.data.datasets[0].borderColor = newLineColor;
      charts.equity.update('none');
    } else {
      const ctx = document.getElementById('equityChart');
      const lineColor = pts[pts.length-1] >= (cap || 0) ? '#1A8F68' : '#C94B2B';
      charts.equity = new Chart(ctx, {
        type: 'line',
        data: {
          labels,
          datasets: [{
            data: pts,
            borderColor: lineColor,
            borderWidth: 2,
            fill: { target: { value: cap || 0 }, above: 'rgba(26,143,104,0.09)', below: 'rgba(201,75,43,0.09)' },
            backgroundColor: (ctxObj) => {
              const chart = ctxObj.chart;
              const { ctx: c, chartArea } = chart;
              if (!chartArea) return 'rgba(26,143,104,0.09)';
              const g = c.createLinearGradient(0, chartArea.top, 0, chartArea.bottom);
              g.addColorStop(0, pts[pts.length-1]>= (cap || 0) ? 'rgba(26,143,104,0.18)' : 'rgba(201,75,43,0.18)');
              g.addColorStop(1, 'rgba(0,0,0,0)');
              return g;
            },
            pointRadius: pts.length <= 80 ? 2.5 : 1.5,
            pointHoverRadius: 4,
            pointBackgroundColor: colors,
            pointBorderColor: colors,
            pointBorderWidth: 0,
            tension: 0.35,
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: '#111',
              titleColor: '#ccc',
              bodyColor: '#fff',
              borderColor: '#333',
              borderWidth: 1,
              padding: 10,
              displayColors: false,
              callbacks: {
                title: (items) => {
                  const t = tradeset[items[0].dataIndex];
                  return fmtDate(t.closeIST) + ' ' + fmtTime(t.closeIST) + ' IST';
                },
                label: (item) => {
                  const pnl = profits[item.dataIndex];
                  const cum = item.raw;
                  const sign = pnl >= 0 ? '+' : '';
                  const csign = cum >= (cap || 0) ? '+' : '';
                  return [
                    'Trade P&L: ' + sign + '$' + pnl.toFixed(2),
                    'Balance: $' + cum.toFixed(2),
                  ];
                }
              }
            }
          },
          scales: {
            x: {
              display: true,
              ticks: { color: tc, font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 },
              grid: { display: false },
              border: { display: true, color: 'rgba(128, 128, 128, 0.2)' }
            },
            y: {
              ticks: { color: tc, callback: v => '$'+v, font: { size: 11 }, maxTicksLimit: 6 },
              grid: { color: gc },
              border: { display: true, color: 'rgba(128, 128, 128, 0.2)' }
            }
          }
        }
      });
    }
  }

  buildEquityChart(trades);

  const eqBtnContainer = document.getElementById('equityRangeBtns');
  if (eqBtnContainer && !eqBtnContainer._hasListeners) {
    eqBtnContainer._hasListeners = true;
    eqBtnContainer.querySelectorAll('.eq-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        eqBtnContainer.querySelectorAll('.eq-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const range = btn.dataset.range;
        let filtered = allTrades;
        if (range === 'week') {
          const cutoff = new Date(allTrades[allTrades.length-1].closeIST.getTime() - 7*24*3600*1000);
          filtered = allTrades.filter(t => t.closeIST >= cutoff);
        } else if (range === 'month') {
          const cutoff = new Date(allTrades[allTrades.length-1].closeIST.getTime() - 30*24*3600*1000);
          filtered = allTrades.filter(t => t.closeIST >= cutoff);
        }
        if (!filtered.length) filtered = allTrades;
        buildEquityChart(filtered.slice());
      });
    });
  }

  dailyDayMap = {}; trades.forEach(t=>{ const k=isoDay(t.closeIST); dailyDayMap[k]=(dailyDayMap[k]||0)+t.profit; });
  dailyDayKeys = Object.keys(dailyDayMap).sort();

  function buildDailyChart(dayInter) {
    if (charts.daily) { try { charts.daily.destroy(); } catch(e){} charts.daily = null; }
    charts.daily = new Chart(document.getElementById('dailyChart'),{
      type:'bar',
      plugins: [noTradePlugin],
      data:{
        labels:dayInter.map(k=>{ const [y,m,d]=k.split('-'); return d+' '+MONTHS_SHORT[parseInt(m)-1]; }),
        datasets:[{
          data:dayInter.map(k=>+(dailyDayMap[k]||0).toFixed(2)),
          backgroundColor:dayInter.map(k=>{
            const val = dailyDayMap[k]||0;
            if (val === 0) return 'rgba(128,128,128,0.08)';
            return val >= 0 ? 'rgba(26,143,104,0.75)' : 'rgba(201,75,43,0.75)';
          }),
          borderRadius:3
        }]
      },
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:tc,font:{size:10}},grid:{display:false}},y:{ticks:{color:tc,callback:v=>'$'+v},grid:{color:gc}}}}
    });
  }
  buildDailyChart(dailyDayKeys);

  const dailyBtnContainer = document.getElementById('dailyRangeBtns');
  if (dailyBtnContainer && !dailyBtnContainer._hasListeners) {
    dailyBtnContainer._hasListeners = true;
    dailyBtnContainer.querySelectorAll('.eq-range-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        dailyBtnContainer.querySelectorAll('.eq-range-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const range = btn.dataset.range;
        dailyDayMap = {}; allTrades.forEach(t=>{ const k=isoDay(t.closeIST); dailyDayMap[k]=(dailyDayMap[k]||0)+t.profit; });
        dailyDayKeys = Object.keys(dailyDayMap).sort();
        let filteredKeys = dailyDayKeys;
        if (range === 'week') {
          const endDate = allTrades[allTrades.length-1].closeIST;
          filteredKeys = [];
          for (let i = 6; i >= 0; i--) {
            const d = new Date(endDate.getTime() - i*24*3600*1000);
            filteredKeys.push(isoDay(d));
          }
        } else if (range === 'month') {
          const endDate = allTrades[allTrades.length-1].closeIST;
          filteredKeys = [];
          for (let i = 29; i >= 0; i--) {
            const d = new Date(endDate.getTime() - i*24*3600*1000);
            filteredKeys.push(isoDay(d));
          }
        }
        if (!filteredKeys.length) filteredKeys = dailyDayKeys;
        buildDailyChart(filteredKeys);
      });
    });
  }

  const symbolMap = {}; trades.forEach(t=>{ symbolMap[t.symbol]=(symbolMap[t.symbol]||0)+t.profit; });
  const symKeys = Object.keys(symbolMap).sort((a,b)=>Math.abs(symbolMap[b])-Math.abs(symbolMap[a]));
  charts.symbol = new Chart(document.getElementById('symbolChart'),{
    type:'bar', data:{labels:symKeys, datasets:[{data:symKeys.map(k=>+symbolMap[k].toFixed(2)), backgroundColor:symKeys.map(k=>symbolMap[k]>=0?'rgba(26,143,104,0.75)':'rgba(201,75,43,0.75)'), borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{color:tc,callback:v=>'$'+v},grid:{color:gc}},y:{ticks:{color:tc,font:{size:11}}}}}
  });
  charts.win = new Chart(document.getElementById('winChart'),{
    type:'doughnut', data:{labels:['Wins ('+wins.length+')','Losses ('+losses.length+')'], datasets:[{data:[wins.length,losses.length], backgroundColor:['rgba(26,143,104,0.85)','rgba(201,75,43,0.85)'], borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom',labels:{color:tc,font:{size:11},boxWidth:12,padding:10}}}}
  });

  const symSel = document.getElementById('filterSym');
  symSel.innerHTML='<option value="">All symbols</option>';
  [...new Set(trades.map(t=>t.symbol))].sort().forEach(s=>{ symSel.innerHTML+='<option value="'+s+'">'+s+'</option>'; });
  document.getElementById('filterSym').onchange =
  document.getElementById('filterType').onchange =
  document.getElementById('filterResult').onchange = applyFilters;
  document.getElementById('resetFilters').onclick = ()=>{ ['filterSym','filterType','filterResult'].forEach(id=>document.getElementById(id).value=''); applyFilters(); };
  renderTradeList(trades);

  buildAvailableMonths(trades);
  const last = trades[trades.length-1].closeIST;
  calYear = last.getUTCFullYear(); calMonth = last.getUTCMonth();
  buildCalMonthSelect();
  renderCalendar();

  buildAvailableYears(trades);
  currentYear = last.getUTCFullYear();
  buildYearSelect();
  renderYearView(currentYear);
}

function applyFilters() {
  const sym=document.getElementById('filterSym').value;
  const type=document.getElementById('filterType').value;
  const res=document.getElementById('filterResult').value;
  let f=allTrades;
  if(sym) f=f.filter(t=>t.symbol===sym);
  if(type) f=f.filter(t=>t.type===type);
  if(res==='win') f=f.filter(t=>t.profit>0);
  if(res==='loss') f=f.filter(t=>t.profit<=0);
  renderTradeList(f);
}

function renderTradeList(trades) {
  const el=document.getElementById('tradeList');
  document.getElementById('filterCount').textContent=trades.length+' trade'+(trades.length!==1?'s':'')+' shown';
  if(!trades.length){ el.innerHTML='<p style="font-size:13px;color:var(--muted);padding:1rem 0;">No trades match filters.</p>'; return; }

  const dayGroups = {};
  [...trades].reverse().forEach(t => {
    const dayKey = isoDay(t.closeIST);
    if (!dayGroups[dayKey]) {
      dayGroups[dayKey] = { trades: [], pnl: 0, wins: 0, losses: 0 };
    }
    dayGroups[dayKey].trades.push(t);
    dayGroups[dayKey].pnl += t.profit;
    if (t.profit > 0) dayGroups[dayKey].wins++;
    else dayGroups[dayKey].losses++;
  });

  const sortedDays = Object.keys(dayGroups).sort().reverse();

  el.innerHTML = sortedDays.map(dayKey => {
    const group = dayGroups[dayKey];
    const dayDate = new Date(dayKey + 'T00:00:00Z');
    const dayLabel = fmtDate(dayDate);
    const isWin = group.pnl >= 0;
    const pnlSign = isWin ? '+' : '';

    const tradesHTML = group.trades.map(t => {
      const w = t.profit > 0;
      const diffMs = new Date(toIST(t.close)) - new Date(toIST(t.open));
      const diffSec = Math.round(diffMs / 1000);
      const dur = Math.round(diffMs / 60000);
      const ds = diffSec < 60 ? diffSec + 's' : (dur >= 60 ? Math.floor(dur/60) + 'h ' + (dur%60) + 'm' : dur + 'm');
      const openTime = fmtTime(new Date(toIST(t.open)));
      const closeTime = fmtTime(t.closeIST);
      return '<div class="trade-row">'
        + '<span class="badge-' + (t.type==='buy'?'buy':'sell') + '">' + (t.type==='buy'?'B':'S') + '</span>'
        + '<span style="font-weight:600;width:66px;font-size:13px;">' + t.symbol + '</span>'
        + '<span class="badge-lots">' + t.lots.toFixed(2) + '</span>'
        + '<span class="trade-time-details"><span style="color:var(--green);">Open ' + openTime + '</span> → <span style="color:var(--red);">Close ' + closeTime + '</span> IST · ' + ds + '</span>'
        + '<span class="tag ' + (w?'tag-w':'tag-l') + '">' + (w?'+':'') + '$' + t.profit.toFixed(2) + '</span>'
        + '</div>';
    }).join('');

    return '<div class="day-group" data-day="' + dayKey + '">'
      + '<div class="day-group-header">'
      + '<div class="day-group-header-left">'
      + '<span class="day-group-date">' + dayLabel + '</span>'
      + '<span class="day-group-meta">' + group.trades.length + ' trade' + (group.trades.length!==1?'s':'') + ' · ' + group.wins + 'W/' + group.losses + 'L</span>'
      + '</div>'
      + '<div style="display:flex;align-items:center;gap:8px;">'
      + '<span class="day-group-pnl ' + (isWin?'win':'loss') + '">' + pnlSign + '$' + group.pnl.toFixed(2) + '</span>'
      + '<span class="day-group-toggle">▼</span>'
      + '</div>'
      + '</div>'
      + '<div class="day-group-trades">' + tradesHTML + '</div>'
      + '</div>';
  }).join('');

  el.querySelectorAll('.day-group-header').forEach(header => {
    header.addEventListener('click', function() {
      this.parentElement.classList.toggle('collapsed');
    });
  });
}

/* ─── Calendar view (Month View) ─── */
function buildAvailableMonths(trades) {
  const seen = new Set();
  trades.forEach(t => { const d=t.closeIST; seen.add(d.getUTCFullYear()+'-'+pad2(d.getUTCMonth()+1)); });
  availableMonths = [...seen].sort();
}

function buildCalMonthSelect() {
  const sel = document.getElementById('calMonthSelect');
  sel.innerHTML = availableMonths.map(ym => {
    const [y,m] = ym.split('-');
    return '<option value="'+ym+'" '+(parseInt(y)===calYear&&parseInt(m)-1===calMonth?'selected':'')+'>'+MONTHS_SHORT[parseInt(m)-1]+' '+y+'</option>';
  }).join('');
  sel.onchange = ()=>{ const [y,m]=sel.value.split('-'); calYear=parseInt(y); calMonth=parseInt(m)-1; renderCalendar(); };
}

function renderCalendar() {
  if (availableMonths.length === 0) return;
  document.getElementById('calTitle').textContent = monthLabel(calYear, calMonth);
  document.getElementById('calMonthSelect').value = calYear+'-'+pad2(calMonth+1);

  const dayData = buildDayMap(allTrades, calYear, calMonth);
  const cards = buildMonthlySummaryCards(dayData);
  document.getElementById('calSummary').innerHTML = cards.map(m=>'<div class="cal-sum-card"><div class="lbl">'+m.lbl+'</div><div class="val '+m.c+'">'+m.val+'</div></div>').join('');

  renderMonthGrid(document.getElementById('calGrid'), dayData, calYear, calMonth, (dateKey, data, cell) => {
    document.querySelectorAll('#calGrid .cal-cell').forEach(c=>c.classList.remove('selected'));
    cell.classList.add('selected');
    openDrawer('dayDrawer','drawerDate','drawerTrades', dateKey, data);
  });

  const curIdx = availableMonths.indexOf(calYear+'-'+pad2(calMonth+1));
  document.getElementById('calPrev').disabled = curIdx<=0;
  document.getElementById('calNext').disabled = curIdx>=availableMonths.length-1;
  document.getElementById('dayDrawer').classList.remove('show');
}

/* ─── Calendar view (All Months View) ─── */
function renderAllMonthsView() {
  const years = [...new Set(allTrades.map(t=>t.closeIST.getUTCFullYear()))].sort();
  let selectedYM = null;

  const totalPnl = allTrades.reduce((s,t)=>s+t.profit,0);
  const totalWins = allTrades.filter(t=>t.profit>0).length;
  const tradingDaysSet = new Set(allTrades.map(t=>isoDay(t.closeIST)));
  document.getElementById('allMonthsSummary').innerHTML = [
    {lbl:'Total P&L', val:(totalPnl>=0?'+':'')+'$'+totalPnl.toFixed(2), c:totalPnl>=0?'win':'loss'},
    {lbl:'Total Trades', val:allTrades.length, c:''},
    {lbl:'Win Rate', val:allTrades.length ? (totalWins/allTrades.length*100).toFixed(1)+'%' : '—', c:''},
    {lbl:'Months Active', val:availableMonths.length, c:''},
    {lbl:'Trading Days', val:tradingDaysSet.size, c:''},
  ].map(m=>'<div class="cal-sum-card"><div class="lbl">'+m.lbl+'</div><div class="val '+m.c+'">'+m.val+'</div></div>').join('');

  const allYMData = {};
  years.forEach(y => {
    const yMap = buildYearMonthDataMap(allTrades, y);
    Object.assign(allYMData, yMap);
  });

  renderMonthlyBars(document.getElementById('monthlyBars'), allYMData, (ym) => {
    showMonthDetail(ym);
    selectedYM = ym;
    renderMiniMonthsAll();
  });

  function renderMiniMonthsAll() {
    const allDisplay = {};
    years.forEach(y => {
      for (let m=1;m<=12;m++) {
        const ym = y+'-'+pad2(m);
        allDisplay[ym] = allYMData[ym] || null;
      }
    });

    const container = document.getElementById('monthsGrid');
    const allYMs = Object.keys(allDisplay).sort();
    container.innerHTML = allYMs.map(ym => {
      const [y,m] = ym.split('-');
      const data = allDisplay[ym];
      const hasData = !!data;
      const isActive = ym === selectedYM;
      const monthNum = parseInt(m)-1;
      const year = parseInt(y);

      let dots = '';
      if (hasData) {
        const daysInM = new Date(Date.UTC(year, monthNum+1, 0)).getUTCDate();
        const firstDay = new Date(Date.UTC(year, monthNum, 1)).getUTCDay();
        for (let i=0;i<firstDay;i++) dots += '<div class="mini-cal-dot empty-d"></div>';
        for (let d=1;d<=daysInM;d++) {
          const key = y+'-'+pad2(monthNum+1)+'-'+pad2(d);
          const dd = data.dayData[key];
          if (dd) {
            dots += '<div class="mini-cal-dot '+(dd.pnl>=0?'win-d':'loss-d')+'"></div>';
          } else {
            dots += '<div class="mini-cal-dot"></div>';
          }
        }
      }

      const pnlColor = hasData ? (data.pnl >= 0 ? '#1A8F68' : '#C94B2B') : 'var(--muted)';
      const pnlText = hasData ? ((data.pnl>=0?'+':'')+'$'+data.pnl.toFixed(2)) : '—';

      return `<div class="mini-month ${isActive?'active-month':''} ${!hasData?'no-data':''}" data-ym="${ym}">
        <div class="mini-month-header">
          <span class="mini-month-name">${MONTHS_SHORT[monthNum]} ${y}</span>
          <span class="mini-month-pnl" style="color:${pnlColor}">${pnlText}</span>
        </div>
        ${hasData ? `<div class="mini-cal-grid">${dots}</div>
        <div class="mini-month-stats">
          <span class="mini-stat">Trades: <span>${data.trades}</span></span>
          <span class="mini-stat">WR: <span>${data.wr}%</span></span>
        </div>` : '<div style="font-size:11px;color:var(--muted);padding:0.25rem 0;">No trades</div>'}
      </div>`;
    }).join('');

    container.querySelectorAll('.mini-month:not(.no-data)').forEach(el => {
      el.addEventListener('click', () => {
        selectedYM = el.dataset.ym;
        renderMiniMonthsAll();
        showMonthDetail(selectedYM);
      });
    });
  }

  renderMiniMonthsAll();

  function showMonthDetail(ym) {
    const [y,m] = ym.split('-');
    const yr = parseInt(y), mo = parseInt(m)-1;
    const panel = document.getElementById('monthDetailPanel');
    document.getElementById('monthDetailTitle').textContent = MONTHS_LONG[mo]+' '+y;
    panel.style.display = 'block';
    panel.scrollIntoView({behavior:'smooth', block:'nearest'});

    const dayData = buildDayMap(allTrades, yr, mo);
    const cards = buildMonthlySummaryCards(dayData);
    document.getElementById('monthDetailSummary').innerHTML = cards.map(c=>'<div class="cal-sum-card"><div class="lbl">'+c.lbl+'</div><div class="val '+c.c+'">'+c.val+'</div></div>').join('');

    renderMonthGrid(document.getElementById('monthDetailGrid'), dayData, yr, mo, (dateKey, data, cell) => {
      document.querySelectorAll('#monthDetailGrid .cal-cell').forEach(c=>c.classList.remove('selected'));
      cell.classList.add('selected');
      openDrawer('dayDrawer2','drawerDate2','drawerTrades2', dateKey, data);
    });
    document.getElementById('dayDrawer2').classList.remove('show');
  }
}

function openDrawer(drawerId, dateId, tradesId, dateKey, data) {
  const drawer = document.getElementById(drawerId);
  const [y,m,d] = dateKey.split('-');
  const totalPnl = data.pnl;
  document.getElementById(dateId).innerHTML = d+' '+MONTHS_SHORT[parseInt(m)-1]+' '+y+
    ' &nbsp;<span style="font-size:13px;font-weight:400;color:'+(totalPnl>=0?'#1A8F68':'#C94B2B')+'">'+(totalPnl>=0?'+':'')+'$'+totalPnl.toFixed(2)+'</span>';
  document.getElementById(tradesId).innerHTML = [...data.trades].sort((a,b)=>a.closeIST-b.closeIST).map(tradeRowHTML).join('');
  drawer.classList.add('show');
  drawer.scrollIntoView({behavior:'smooth',block:'nearest'});
}

/* ─── Year View ─── */
function buildAvailableYears(trades) {
  const seen = new Set();
  trades.forEach(t => seen.add(t.closeIST.getUTCFullYear()));
  availableYears = [...seen].sort();
}

function buildYearSelect() {
  const sel = document.getElementById('yearSelect');
  sel.innerHTML = availableYears.map(y=>'<option value="'+y+'" '+(y===currentYear?'selected':'')+'>'+y+'</option>').join('');
  sel.onchange = ()=>{ currentYear=parseInt(sel.value); renderYearView(currentYear); };
}

function renderYearView(year) {
  if (availableYears.length === 0) return;
  document.getElementById('yearTitle').textContent = year;
  document.getElementById('yearSelect').value = year;

  const yearData = buildYearMonthDataMap(allTrades, year);
  const yearPnl = Object.values(yearData).reduce((s,d)=>s+d.pnl,0);
  const yearTrades = Object.values(yearData).reduce((s,d)=>s+d.trades,0);
  const yearWins = Object.values(yearData).reduce((s,d)=>s+d.wins,0);
  const yearMonths = Object.keys(yearData).length;
  const profitMonths = Object.values(yearData).filter(d=>d.pnl>0).length;

  document.getElementById('yearSummary').innerHTML = [
    {lbl:'Year P&L', val:(yearPnl>=0?'+':'')+'$'+yearPnl.toFixed(2), c:yearPnl>=0?'win':'loss'},
    {lbl:'Total Trades', val:yearTrades, c:''},
    {lbl:'Win Rate', val:yearTrades?(yearWins/yearTrades*100).toFixed(1)+'%':'—', c:''},
    {lbl:'Active Months', val:yearMonths, c:''},
    {lbl:'Profit Months', val:profitMonths+' / '+yearMonths, c:profitMonths>yearMonths/2?'win':'loss'},
  ].map(m=>'<div class="year-sum-card"><div class="lbl">'+m.lbl+'</div><div class="val '+m.c+'">'+m.val+'</div></div>').join('');

  renderMonthlyBars(document.getElementById('yearMonthlyBars'), yearData, (ym) => {
    showYearMonthDetail(ym);
  });

  const container = document.getElementById('yearMonthsGrid');
  const allYMs = Array.from({length:12},(_,i)=>year+'-'+pad2(i+1));
  container.innerHTML = allYMs.map(ym => {
    const m = parseInt(ym.split('-')[1])-1;
    const data = yearData[ym];
    const hasData = !!data;
    const pnlColor = hasData ? (data.pnl>=0?'#1A8F68':'#C94B2B') : 'var(--muted)';
    const pnlText = hasData ? ((data.pnl>=0?'+':'')+'$'+data.pnl.toFixed(2)) : '—';

    let dots = '';
    if (hasData) {
      const daysInM = new Date(Date.UTC(year, m+1, 0)).getUTCDate();
      const firstDay = new Date(Date.UTC(year, m, 1)).getUTCDay();
      for (let i=0;i<firstDay;i++) dots += '<div class="mini-cal-dot empty-d"></div>';
      for (let d=1;d<=daysInM;d++) {
        const key = year+'-'+pad2(m+1)+'-'+pad2(d);
        const dd = data.dayData[key];
        dots += '<div class="mini-cal-dot '+(dd?(dd.pnl>=0?'win-d':'loss-d'):'')+'"  title="'+(dd?(dd.pnl>=0?'+':'')+'$'+dd.pnl.toFixed(2):'')+'"></div>';
      }
    }

    return `<div class="mini-month ${!hasData?'no-data':''}" data-ym="${ym}">
      <div class="mini-month-header">
        <span class="mini-month-name">${MONTHS_LONG[m]}</span>
        <span class="mini-month-pnl" style="color:${pnlColor}">${pnlText}</span>
      </div>
      ${hasData ? `<div class="mini-cal-grid">${dots}</div>
      <div class="mini-month-stats">
        <span class="mini-stat">Trades: <span>${data.trades}</span></span>
        <span class="mini-stat">WR: <span>${data.wr}%</span></span>
      </div>` : '<div style="font-size:11px;color:var(--muted);padding:0.5rem 0;">No trades</div>'}
    </div>`;
  }).join('');

  container.querySelectorAll('.mini-month:not(.no-data)').forEach(el => {
    el.addEventListener('click', () => showYearMonthDetail(el.dataset.ym));
  });

  const curIdx = availableYears.indexOf(year);
  document.getElementById('yearPrev').disabled = curIdx<=0;
  document.getElementById('yearNext').disabled = curIdx>=availableYears.length-1;
  document.getElementById('yearMonthDetail').style.display = 'none';
}

function showYearMonthDetail(ym) {
  const [y,m] = ym.split('-');
  const yr = parseInt(y), mo = parseInt(m)-1;
  document.getElementById('yearMonthDetailTitle').textContent = MONTHS_LONG[mo]+' '+yr;
  const panel = document.getElementById('yearMonthDetail');
  panel.style.display = 'block';
  panel.scrollIntoView({behavior:'smooth', block:'nearest'});

  document.querySelectorAll('#yearMonthsGrid .mini-month').forEach(el=>el.classList.remove('active-month'));
  const activeEl = document.querySelector('#yearMonthsGrid .mini-month[data-ym="'+ym+'"]');
  if (activeEl) activeEl.classList.add('active-month');

  const dayData = buildDayMap(allTrades, yr, mo);
  const cards = buildMonthlySummaryCards(dayData);
  document.getElementById('yearMonthDetailSummary').innerHTML = cards.map(c=>'<div class="cal-sum-card"><div class="lbl">'+c.lbl+'</div><div class="val '+c.c+'">'+c.val+'</div></div>').join('');
  renderMonthGrid(document.getElementById('yearMonthDetailGrid'), dayData, yr, mo, (dateKey, data, cell) => {
    document.querySelectorAll('#yearMonthDetailGrid .cal-cell').forEach(c=>c.classList.remove('selected'));
    cell.classList.add('selected');
    openDrawer('dayDrawer3','drawerDate3','drawerTrades3', dateKey, data);
  });
  document.getElementById('dayDrawer3').classList.remove('show');
}

/* ─── Calendar view switcher ─── */
document.getElementById('btnMonthView').addEventListener('click', () => {
  document.getElementById('btnMonthView').classList.add('active');
  document.getElementById('btnYearInline').classList.remove('active');
  document.getElementById('calMonthView').style.display = '';
  document.getElementById('calAllMonths').style.display = 'none';
  document.getElementById('monthNavControls').style.display = 'flex';
  calViewMode = 'month';
});
document.getElementById('btnYearInline').addEventListener('click', () => {
  document.getElementById('btnYearInline').classList.add('active');
  document.getElementById('btnMonthView').classList.remove('active');
  document.getElementById('calMonthView').style.display = 'none';
  document.getElementById('calAllMonths').style.display = '';
  document.getElementById('monthNavControls').style.display = 'none';
  calViewMode = 'all';
  if (allTrades.length) renderAllMonthsView();
});

document.getElementById('calPrev').addEventListener('click',()=>{
  const idx=availableMonths.indexOf(calYear+'-'+pad2(calMonth+1));
  if(idx>0){ const [y,m]=availableMonths[idx-1].split('-'); calYear=parseInt(y); calMonth=parseInt(m)-1; buildCalMonthSelect(); renderCalendar(); }
});
document.getElementById('calNext').addEventListener('click',()=>{
  const idx=availableMonths.indexOf(calYear+'-'+pad2(calMonth+1));
  if(idx<availableMonths.length-1){ const [y,m]=availableMonths[idx+1].split('-'); calYear=parseInt(y); calMonth=parseInt(m)-1; buildCalMonthSelect(); renderCalendar(); }
});

document.getElementById('yearPrev').addEventListener('click',()=>{
  const idx=availableYears.indexOf(currentYear);
  if(idx>0){ currentYear=availableYears[idx-1]; buildYearSelect(); renderYearView(currentYear); }
});
document.getElementById('yearNext').addEventListener('click',()=>{
  const idx=availableYears.indexOf(currentYear);
  if(idx<availableYears.length-1){ currentYear=availableYears[idx+1]; buildYearSelect(); renderYearView(currentYear); }
});

document.getElementById('drawerClose').addEventListener('click',()=>document.getElementById('dayDrawer').classList.remove('show'));
document.getElementById('drawerClose2').addEventListener('click',()=>document.getElementById('dayDrawer2').classList.remove('show'));
document.getElementById('drawerClose3').addEventListener('click',()=>document.getElementById('dayDrawer3').classList.remove('show'));

/* ─── Sidebar navigation ─── */
const pageMap = {
  overview: 'Dashboard', calendar: 'P&L Calendar', analysis: 'Trade Analysis', trades: 'All Trades', aimentor: 'AI Mentor', yearview: 'Year View'
};
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const page = item.dataset.page;
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.remove('active'));
    document.querySelectorAll('.page').forEach(x=>x.classList.remove('show'));
    item.classList.add('active');
    const pageEl = document.getElementById('page-'+page);
    if (pageEl) pageEl.classList.add('show');
    document.getElementById('topbarTitle').textContent = pageMap[page] || 'Dashboard';
    
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('show');
  });
});

document.getElementById('hamburger').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.toggle('open');
  document.getElementById('sidebarOverlay').classList.toggle('show');
});
document.getElementById('sidebarOverlay').addEventListener('click',()=>{
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('show');
});

function destroyCharts() {
  Object.values(charts).forEach(c=>{ try{c.destroy();}catch(e){} });
  charts = {};
}
function showError(msg) {
  const el=document.getElementById('errBox');
  el.textContent='⚠️ '+msg; el.style.display='block';
  setTimeout(()=>el.style.display='none',7000);
}

/* ─── Toast Notification ─── */
function showToast(msg, type='success') {
  let toast = document.getElementById('saveToast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'saveToast';
    toast.style.cssText = `
      position:fixed; bottom:24px; right:24px; z-index:9999;
      padding:10px 18px; border-radius:9px; font-size:13px; font-weight:500;
      display:flex; align-items:center; gap:8px;
      box-shadow:0 4px 20px rgba(0,0,0,0.18);
      transition:opacity 0.3s, transform 0.3s;
      font-family:'IBM Plex Sans',sans-serif;
      opacity:0; transform:translateY(8px);
    `;
    document.body.appendChild(toast);
  }
  toast.style.background = type==='success' ? '#1A8F68' : '#C94B2B';
  toast.style.color = '#fff';
  toast.innerHTML = (type==='success' ? '✓ ' : '⚠ ') + msg;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(()=>{
    toast.style.opacity='0';
    toast.style.transform='translateY(8px)';
  }, 3200);
}

/* ─── DB persistence UI Badge ─── */
function updateStorageBadge(meta) {
  const badge = document.getElementById('storageBadge');
  const separator = document.getElementById('storageSeparator');
  const countEl = document.getElementById('storageBadgeCount');
  if (!badge) return;
  if (meta && meta.count > 0) {
    if (countEl) {
      countEl.textContent = `${meta.count} trades in log`;
    }
    badge.style.display = 'flex';
    if (separator) separator.style.display = 'block';
  } else {
    badge.style.display = 'none';
    if (separator) separator.style.display = 'none';
  }
}

function launchDashboard(trades) {
  document.getElementById('uploadScreen').style.display='none';
  document.getElementById('errBox').style.display='none';

  document.querySelectorAll('.page').forEach(p => p.classList.remove('show'));
  document.getElementById('page-overview').classList.add('show');

  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('nav-overview').classList.add('active');
  document.getElementById('topbarTitle').textContent = 'Dashboard';

  buildDashboard(trades);
  window.scrollTo({top:0,behavior:'smooth'});
}

async function handleFile(file) {
  if(!file) return;
  if(!file.name.toLowerCase().endsWith('.csv')){ showError('Please upload a .csv file.'); return; }
  
  const reader=new FileReader();
  reader.onload = async (e) => {
    try {
      // Clear previous CSV data
      const deleteRes = await fetch('/api/trades', { method: 'DELETE' });
      if (!deleteRes.ok) {
        showError('Failed to clear previous trade history before upload.');
        return;
      }

      // Reset Starting Capital & Daily Rules
      await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startingCapital: 0,
          dailyLossLimit: 0,
          dailyProfitTarget: 0,
          dailyLossType: 'usd'
        })
      });
      startingCapital = 0;
      const capInput = document.getElementById('capitalInput');
      const capHint  = document.getElementById('capitalHint');
      const lossTypeSelect = document.getElementById('dailyLossType');
      const lossInput = document.getElementById('analysisDailyLoss');
      const profitInput = document.getElementById('analysisDailyProfit');
      
      if (capInput) capInput.value = '';
      if (capHint)  { capHint.textContent = 'Enter your starting capital for this account'; capHint.className = 'cap-hint info'; }
      if (lossTypeSelect) lossTypeSelect.value = 'usd';
      if (lossInput) lossInput.value = '';
      if (profitInput) profitInput.value = '';
      
      updateDailyLossInputType('usd');
      updateAnalysisPreviews();

      const trades = parseCSV(e.target.result);
      const rawForStorage = trades.map(t=>({
        ticket: t.ticket, open: t.open, close: t.close,
        type: t.type, symbol: t.symbol, lots: t.lots, profit: t.profit
      }));
      
      const response = await fetch('/api/trades/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: rawForStorage })
      });

      if (response.ok) {
        const result = await response.json();
        
        // Reload all trades from backend db
        const reloadRes = await fetch('/api/trades');
        if (reloadRes.ok) {
          const freshTrades = await reloadRes.json();
          launchDashboard(freshTrades);
          updateStorageBadge({ count: freshTrades.length });
          showToast(`Successfully imported ${result.count} new trades!`);
        }
      } else {
        const err = await response.json();
        showError(err.error || 'Failed to upload trades to database.');
      }
    } catch(err){ showError(err.message); }
  };
  reader.readAsText(file);
}

async function resetDashboardToEmpty() {
  allTrades = [];
  availableMonths = [];
  availableYears = [];

  destroyCharts();

  ['equityChart','dailyChart','symbolChart','winChart'].forEach(id => {
    const canvas = document.getElementById(id);
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  });

  const sMeta = document.getElementById('sidebarMeta');
  if (sMeta) sMeta.textContent = '—';
  const sPnl = document.getElementById('sidebarPnl');
  if (sPnl) {
    sPnl.textContent = '—';
    sPnl.style.color = 'var(--sidebar-muted)';
  }
  document.getElementById('nav-badge-overview').textContent = '0';
  document.getElementById('nav-badge-trades').textContent = '0';

  document.getElementById('topMeta').textContent = 'Upload your Exness CSV to begin';
  document.getElementById('topbarTitle').textContent = 'Trading Dashboard';

  document.getElementById('metrics').innerHTML = [
    {lbl:'Net P&L',    val:'$0.00',  sub:'no trades'},
    {lbl:'Win Rate',   val:'0%',     sub:'0W / 0L'},
    {lbl:'Trades',     val:'0',      sub:'—'},
    {lbl:'Avg Win',    val:'+$0.00', sub:'per winning trade'},
    {lbl:'Avg Loss',   val:'$0.00',  sub:'per losing trade'},
    {lbl:'Risk Reward', val:'1:0.00', sub:'avg win / avg loss'},
    {lbl:'Best Trade', val:'+$0.00', sub:'single trade'},
    {lbl:'Worst Trade',val:'$0.00',  sub:'single trade'},
    {lbl:'Profit Factor', val:'0.00', sub:''},
  ].map(m=>`<div class="mcard"><div class="lbl">${m.lbl}</div><div class="val">${m.val}</div><div class="sub">${m.sub}</div></div>`).join('');

  dailyDayMap = {};
  dailyDayKeys = [];

  document.getElementById('tradeList').innerHTML = '<p style="font-size:13px;color:var(--muted);padding:1rem 0;">No trades. Upload a CSV to get started.</p>';
  document.getElementById('filterCount').textContent = '';
  document.getElementById('filterSym').innerHTML = '<option value="">All symbols</option>';
  document.getElementById('filterType').value = '';
  document.getElementById('filterResult').value = '';

  document.getElementById('calGrid').innerHTML = '';
  document.getElementById('calSummary').innerHTML = '';
  document.getElementById('dayDrawer').classList.remove('show');
  document.getElementById('yearSummary').innerHTML = '';
  document.getElementById('yearMonthsGrid').innerHTML = '';
  document.getElementById('yearMonthDetail').style.display = 'none';

  updateStorageBadge(null);

  document.querySelectorAll('.page').forEach(p => p.classList.remove('show'));
  document.getElementById('page-overview').classList.add('show');
  document.getElementById('uploadScreen').style.display = '';
  document.getElementById('uploadScreen').style.padding = '2rem 1.5rem';

  document.querySelectorAll('.nav-item').forEach(x => x.classList.remove('active'));
  document.getElementById('nav-overview').classList.add('active');

  document.querySelectorAll('.eq-range-btn').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('#equityRangeBtns .eq-range-btn[data-range="all"]').forEach(b => b.classList.add('active'));
  document.querySelectorAll('#dailyRangeBtns .eq-range-btn[data-range="all"]').forEach(b => b.classList.add('active'));
}

document.getElementById('deleteDataBtn').addEventListener('click', async () => {
  const confirmed = window.confirm('Wipe all saved trade history from SQLite? This cannot be undone.');
  if (!confirmed) return;

  try {
    const res = await fetch('/api/trades', { method: 'DELETE' });
    if (res.ok) {
      resetDashboardToEmpty();
      showToast('All trades wiped from database', 'error');
    } else {
      showError('Failed to wipe trades from database.');
    }
  } catch (e) {
    showError('Network error clearing database.');
  }
});

document.getElementById('reuploadInput').addEventListener('change',e=>{ handleFile(e.target.files[0]); e.target.value=''; });
document.getElementById('fileInput').addEventListener('change',e=>{ handleFile(e.target.files[0]); e.target.value=''; });
const dz=document.getElementById('dropZone');
dz.addEventListener('click', (e) => { if (e.target.closest('.upload-btn-lbl') || e.target.tagName === 'INPUT') return; document.getElementById('fileInput').click(); });
dz.addEventListener('dragover',e=>{ e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave',()=>dz.classList.remove('drag'));
dz.addEventListener('drop',e=>{ e.preventDefault(); dz.classList.remove('drag'); handleFile(e.dataTransfer.files[0]); });

/* ─── Theme Toggle ─── */
const STORAGE_THEME_KEY = 'exness_theme_v1';
function loadTheme() {
  try {
    const saved = localStorage.getItem(STORAGE_THEME_KEY);
    const icon = document.getElementById('themeIcon');
    if (saved === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (icon) {
        icon.className = 'fa-solid fa-moon';
        icon.style.color = '#B8B6B0';
      }
    } else {
      if (icon) {
        icon.className = 'fa-solid fa-sun';
        icon.style.color = '#F59E0B';
      }
    }
  } catch(e) {}
}
function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  const icon = document.getElementById('themeIcon');
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    localStorage.setItem(STORAGE_THEME_KEY, 'light');
    if (icon) {
      icon.className = 'fa-solid fa-sun';
      icon.style.color = '#F59E0B';
    }
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    localStorage.setItem(STORAGE_THEME_KEY, 'dark');
    if (icon) {
      icon.className = 'fa-solid fa-moon';
      icon.style.color = '#B8B6B0';
    }
  }
}
document.getElementById('themeToggle').addEventListener('click', toggleTheme);
loadTheme();

/* ─── Capital Input Handler ─── */
document.getElementById('capitalInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btnSaveDailyRules').click();
});

/* ─── Profile Dialog and Settings ─── */
const profileWrap = document.getElementById('profileWrap');
const profileIcon = document.getElementById('profileIcon');
const profileAvatarText = document.getElementById('profileAvatarText');
const profileDropdown = document.getElementById('profileDropdown');
const profileAvatarLarge = document.getElementById('profileAvatarLarge');
const profileNameEl = document.getElementById('profileName');
const profileEmailEl = document.getElementById('profileEmail');
const profileFullName = document.getElementById('profileFullName');
const profileEmailField = document.getElementById('profileEmailField');
const profileBroker = document.getElementById('profileBroker');
const profileStyle = document.getElementById('profileStyle');
const profileSaveBtn = document.getElementById('profileSaveBtn');
const profileStatTrades = document.getElementById('profileStatTrades');
const profileStatWR = document.getElementById('profileStatWR');
const profileStatPnL = document.getElementById('profileStatPnL');
const profileStatDays = document.getElementById('profileStatDays');

let profileData = {
  fullName: '',
  email: '',
  broker: '',
  style: ''
};

function getInitials(name) {
  if (!name || !name.trim()) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].charAt(0).toUpperCase();
  return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
}

async function saveProfile() {
  const name = profileFullName.value.trim();
  const email = profileEmailField.value.trim();
  const broker = profileBroker.value.trim();
  const style = profileStyle.value;

  profileSaveBtn.disabled = true;
  profileSaveBtn.textContent = 'Saving...';

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        email,
        broker,
        style,
        startingCapital
      })
    });

    if (res.ok) {
      profileData.fullName = name;
      profileData.email = email;
      profileData.broker = broker;
      profileData.style = style;
      updateProfileUI();
      closeProfile();
      showToast('Profile updated in SQLite');
    } else {
      const err = await res.json();
      alert('Failed to save profile: ' + (err.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Connection error saving profile settings.');
  } finally {
    profileSaveBtn.disabled = false;
    profileSaveBtn.textContent = 'Save Profile';
  }
}

function updateProfileUI() {
  const initials = getInitials(profileData.fullName);

  profileAvatarText.textContent = initials;
  profileAvatarLarge.textContent = initials;
  profileNameEl.textContent = profileData.fullName || 'Set your name';
  profileEmailEl.textContent = profileData.email || '—';

  profileFullName.value = profileData.fullName || '';
  profileEmailField.value = profileData.email || '';
  profileBroker.value = profileData.broker || '';
  profileStyle.value = profileData.style || '';

  updateProfileStats();
}

function updateProfileStats() {
  if (!allTrades || !allTrades.length) {
    profileStatTrades.textContent = '0';
    profileStatWR.textContent = '0%';
    profileStatPnL.textContent = '$0.00';
    profileStatPnL.className = 'profile-stat-val';
    profileStatDays.textContent = '0';
    return;
  }

  const totalTrades = allTrades.length;
  const wins = allTrades.filter(t => t.profit > 0).length;
  const wr = totalTrades ? ((wins / totalTrades) * 100).toFixed(1) : '0.0';
  const totalPnl = allTrades.reduce((s, t) => s + t.profit, 0);
  const activeDaysSet = new Set(allTrades.map(t => isoDay(t.closeIST)));
  const activeDays = activeDaysSet.size;

  profileStatTrades.textContent = totalTrades;
  profileStatWR.textContent = wr + '%';
  profileStatPnL.textContent = (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(2);
  profileStatPnL.className = 'profile-stat-val ' + (totalPnl >= 0 ? 'win' : 'loss');
  profileStatDays.textContent = activeDays;
}

function toggleProfile(e) {
  if (e) e.stopPropagation();
  const isOpen = profileDropdown.classList.contains('show');
  if (isOpen) {
    closeProfile();
  } else {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('show');
    updateProfileStats();
    profileDropdown.classList.add('show');
    setTimeout(() => {
      document.addEventListener('click', closeProfileOnClickOutside, { once: true });
    }, 10);
  }
}

function closeProfile() {
  profileDropdown.classList.remove('show');
}

function closeProfileOnClickOutside(e) {
  if (profileDropdown.contains(e.target)) {
    setTimeout(() => {
      document.addEventListener('click', closeProfileOnClickOutside, { once: true });
    }, 10);
    return;
  }
  closeProfile();
}

profileIcon.addEventListener('click', (e) => {
  e.stopPropagation();
  toggleProfile(e);
});

profileSaveBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  saveProfile();
});

[profileFullName, profileEmailField, profileBroker, profileStyle].forEach(el => {
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveProfile();
    }
  });
});

/* ─── Stripe billing checkout triggers ─── */
const upgradeBtn = document.getElementById('upgradeBtn');
const profileTier = document.getElementById('profileTier');

async function triggerBillingUpgrade() {
  upgradeBtn.disabled = true;
  upgradeBtn.innerHTML = '<span class="spinner" style="border-top-color:#fff"></span> Connecting...';

  try {
    const res = await fetch('/api/payment/create-checkout-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });

    if (res.ok) {
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      }
    } else {
      const err = await res.json();
      alert(err.error || 'Failed to initiate billing upgrade.');
    }
  } catch (e) {
    alert('Billing server offline. Upgrade unavailable.');
  } finally {
    upgradeBtn.disabled = false;
    upgradeBtn.innerHTML = '👑 Upgrade to Premium';
  }
}
upgradeBtn.addEventListener('click', triggerBillingUpgrade);

/* ─── Logout handler ─── */
async function handleLogout() {
  const confirmed = window.confirm('Are you sure you want to log out of your trading journal?');
  if (!confirmed) return;
  
  try {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = 'auth.html';
  } catch (e) {
    window.location.href = 'auth.html';
  }
}
document.getElementById('sidebarLogoutBtn').addEventListener('click', handleLogout);
document.getElementById('profileLogoutBtn').addEventListener('click', (e) => {
  e.stopPropagation();
  handleLogout();
});

/* ─── AI Mentor Chat ─── */
const chatMessages = document.getElementById('chatMessages');
const chatInput = document.getElementById('chatInput');
const chatSendBtn = document.getElementById('chatSendBtn');

function addMessage(text, isUser = false) {
  const msgDiv = document.createElement('div');
  msgDiv.className = 'chat-message ' + (isUser ? 'user-message' : 'ai-message');
  msgDiv.innerHTML = '<div class="chat-avatar ' + (isUser ? 'user-avatar' : 'ai-avatar') + '">' + (isUser ? '👤' : '◈') + '</div><div class="chat-bubble"><p>' + text + '</p></div>';
  chatMessages.appendChild(msgDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
  const typingDiv = document.createElement('div');
  typingDiv.className = 'chat-message ai-message typing-msg';
  typingDiv.innerHTML = '<div class="chat-avatar ai-avatar">◈</div><div class="chat-bubble typing-indicator"><span></span><span></span><span></span></div>';
  chatMessages.appendChild(typingDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;
  return typingDiv;
}

function removeTyping() {
  const typing = chatMessages.querySelector('.typing-msg');
  if (typing) typing.remove();
}

async function handleChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  addMessage(text, true);
  chatInput.value = '';
  const typing = showTyping();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text })
    });
    
    removeTyping();
    if (res.ok) {
      const data = await res.json();
      addMessage(data.response, false);
    } else {
      const err = await res.json();
      addMessage('⚠️ ' + (err.error || 'Failed to analyze trade request.'), false);
    }
  } catch (e) {
    removeTyping();
    addMessage('⚠️ AI Mentor connection error. Server offline.', false);
  }
}
chatSendBtn.addEventListener('click', handleChat);
chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleChat(); });

/* ─── Boot: load database states ─── */
async function boot() {
  const overlay = document.getElementById('bootLoadingOverlay');
  const hideOverlay = () => {
    if (overlay) {
      overlay.classList.add('fade-out');
      setTimeout(() => { if (overlay) overlay.style.display = 'none'; }, 380);
    }
  };

  const params = new URLSearchParams(window.location.search);
  
  // Handle Stripe upgrade notifications
  if (params.get('payment') === 'success') {
    showToast('🎉 Upgrade Complete! Lifetime Premium Membership activated.', 'success');
    window.history.replaceState({}, document.title, window.location.pathname);
  } else if (params.get('payment') === 'cancel') {
    showToast('Billing upgrade checkout cancelled.', 'error');
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // 1. Auth checkpoint
  try {
    let authRes;
    try {
      authRes = await fetch('/api/auth/me');
    } catch (networkErr) {
      // Server is down or unreachable
      hideOverlay();
      showError('Cannot connect to server. Please make sure the server is running.');
      return;
    }

    if (!authRes.ok) {
      hideOverlay();
      window.location.href = 'auth.html';
      return;
    }
    const user = await authRes.json();
    
    isPremiumUser = user.isPremium;
    if (isPremiumUser) {
      upgradeBtn.style.display = 'none';
      profileTier.textContent = '👑 Premium Account';
      profileIcon.classList.add('premium-user');
    } else {
      upgradeBtn.style.display = 'flex';
      profileTier.textContent = 'Free Account';
      profileIcon.classList.remove('premium-user');
    }

    // 2. Fetch Profile Info
    try {
      const profRes = await fetch('/api/profile');
      if (profRes.ok) {
        const prof = await profRes.json();
        profileData = {
          fullName: prof.name,
          email: prof.email,
          broker: prof.broker,
          style: prof.style
        };
        startingCapital = prof.startingCapital || 0;
        document.getElementById('capitalInput').value = startingCapital > 0 ? startingCapital : '';
        const hint = document.getElementById('capitalHint');
        if (startingCapital > 0) {
          hint.textContent = 'Saved: $' + startingCapital.toLocaleString('en-US', {minimumFractionDigits:2});
          hint.className = 'cap-hint ok';
        }
        
        // Populate Trade Analysis Daily Rules
        const dlType = prof.dailyLossType || 'usd';
        document.getElementById('dailyLossType').value = dlType;
        updateDailyLossInputType(dlType);
        document.getElementById('analysisDailyLoss').value = prof.dailyLossLimit > 0 ? prof.dailyLossLimit : '';
        document.getElementById('analysisDailyProfit').value = prof.dailyProfitTarget > 0 ? prof.dailyProfitTarget : '';
        
        // Populate Active Targets preview pills
        updateAnalysisPreviews();
        
        updateProfileUI();
      }
    } catch (profileErr) {
      console.warn('Profile fetch failed (non-fatal):', profileErr);
    }

    // 3. Fetch Trade Logs
    try {
      const tradesRes = await fetch('/api/trades');
      if (tradesRes.ok) {
        const trades = await tradesRes.json();
        if (trades && trades.length > 0) {
          launchDashboard(trades);
          updateStorageBadge({ count: trades.length });
        } else {
          resetDashboardToEmpty();
        }
      } else {
        resetDashboardToEmpty();
      }
    } catch (tradesErr) {
      console.warn('Trades fetch failed (non-fatal):', tradesErr);
      resetDashboardToEmpty();
    }

    // 4. Auto click reupload if action=upload was set
    if (params.get('action') === 'upload') {
      document.getElementById('fileInput').click();
    }

  } catch (err) {
    console.error('Boot error:', err);
    hideOverlay();
    return;
  }

  hideOverlay();
}

// Add sidebar collapse toggle logic
const collapseBtn = document.getElementById('collapseSidebarBtn');
if (collapseBtn) {
  // Load collapse state from localStorage
  const isCollapsed = localStorage.getItem('sidebar_collapsed') === 'true';
  if (isCollapsed) {
    document.body.classList.add('sidebar-collapsed');
    collapseBtn.innerHTML = '<i class="fa-solid fa-angles-right"></i>';
    collapseBtn.setAttribute('title', 'Expand sidebar');
  }

  collapseBtn.addEventListener('click', () => {
    document.body.classList.toggle('sidebar-collapsed');
    const currentlyCollapsed = document.body.classList.contains('sidebar-collapsed');
    localStorage.setItem('sidebar_collapsed', currentlyCollapsed);
    collapseBtn.innerHTML = currentlyCollapsed ? '<i class="fa-solid fa-angles-right"></i>' : '<i class="fa-solid fa-angles-left"></i>';
    collapseBtn.setAttribute('title', currentlyCollapsed ? 'Expand sidebar' : 'Collapse sidebar');
    
    // Resize charts after transition finishes (0.25s CSS transition)
    setTimeout(() => {
      Object.values(charts).forEach(c => {
        if (c && typeof c.resize === 'function') {
          c.resize();
        }
      });
    }, 260);
  });
}

/* ─── Trade Analysis Page Logic ─── */
function populateAnalysisTradesDropdown() {
  const selectEl = document.getElementById('analysisTradeSelect');
  if (!selectEl) return;
  const currentVal = selectEl.value;
  selectEl.innerHTML = '<option value="">— Select a trade to review —</option>';
  
  if (allTrades && allTrades.length > 0) {
    const sorted = allTrades.slice().sort((a,b) => {
      const dateA = a.closeIST ? new Date(a.closeIST) : new Date(0);
      const dateB = b.closeIST ? new Date(b.closeIST) : new Date(0);
      return dateB - dateA;
    });
    sorted.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.ticket;
      const dateStr = t.closeIST ? fmtShort(t.closeIST) : '';
      const pnlStr = (t.profit >= 0 ? '+' : '') + '$' + t.profit.toFixed(2);
      opt.textContent = `[${t.symbol.toUpperCase()}] ${t.type.toUpperCase()} · ${pnlStr} (${dateStr})`;
      selectEl.appendChild(opt);
    });
  }
  
  selectEl.value = currentVal;
}

function updateAnalysisPreviews() {
  const cap = parseFloat(document.getElementById('capitalInput').value) || 0;
  const loss = parseFloat(document.getElementById('analysisDailyLoss').value) || 0;
  const profit = parseFloat(document.getElementById('analysisDailyProfit').value) || 0;
  const lossType = document.getElementById('dailyLossType').value;

  const capEl = document.getElementById('previewCapital');
  const lossEl = document.getElementById('previewLossLimit');
  const profitEl = document.getElementById('previewProfitTarget');
  const typeEl = document.getElementById('previewLossType');

  if (capEl)    capEl.textContent    = cap > 0    ? '$' + cap.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}) : '—';
  if (lossEl)   lossEl.textContent   = loss > 0   ? (lossType === 'percent' ? loss.toFixed(1) + '%' : lossType === 'trades' ? loss + ' trades' : '$' + loss.toFixed(2)) : '—';
  if (profitEl) profitEl.textContent = profit > 0 ? '$' + profit.toFixed(2) : '—';
  if (typeEl)   typeEl.textContent   = lossType === 'percent' ? 'Percentage' : lossType === 'trades' ? 'Max Trades' : 'Fixed ($)';
  
  updateTodayTradesList();
}

function updateTodayTradesList() {
  const filterType = document.getElementById('analysisTradesFilter')?.value || 'today';
  const nowIST = toIST(new Date().toISOString());
  if (!nowIST) return;

  const todayISO = isoDay(nowIST);
  let filtered = [];
  
  if (filterType === 'today') {
    filtered = allTrades.filter(t => t.closeIST && isoDay(t.closeIST) === todayISO);
  } else if (filterType === 'week') {
    const dayOfWeek = nowIST.getUTCDay();
    const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const startOfWeek = new Date(nowIST.getTime() + diffToMonday * 24 * 3600 * 1000);
    startOfWeek.setUTCHours(0,0,0,0);
    filtered = allTrades.filter(t => t.closeIST && t.closeIST >= startOfWeek);
  } else if (filterType === 'month') {
    const startOfMonth = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), 1));
    filtered = allTrades.filter(t => t.closeIST && t.closeIST >= startOfMonth);
  } else if (filterType === '3month') {
    const cutoff = new Date(nowIST.getTime() - 90 * 24 * 3600 * 1000);
    filtered = allTrades.filter(t => t.closeIST && t.closeIST >= cutoff);
  } else if (filterType === '6month') {
    const cutoff = new Date(nowIST.getTime() - 180 * 24 * 3600 * 1000);
    filtered = allTrades.filter(t => t.closeIST && t.closeIST >= cutoff);
  } else if (filterType === 'year') {
    const startOfYear = new Date(Date.UTC(nowIST.getUTCFullYear(), 0, 1));
    filtered = allTrades.filter(t => t.closeIST && t.closeIST >= startOfYear);
  }
  
  const countEl = document.getElementById('todayTradesCount');
  if (countEl) {
    countEl.textContent = filtered.length + (filtered.length === 1 ? ' Trade' : ' Trades');
  }
  
  const container = document.getElementById('todayTradesList');
  if (!container) return;
  
  if (filtered.length === 0) {
    let emptyText = 'No trades taken today yet';
    if (filterType === 'week') emptyText = 'No trades taken this week';
    if (filterType === 'month') emptyText = 'No trades taken this month';
    if (filterType === '3month') emptyText = 'No trades taken in last 3 months';
    if (filterType === '6month') emptyText = 'No trades taken in last 6 months';
    if (filterType === 'year') emptyText = 'No trades taken this year';
    
    container.innerHTML = `
      <div class="an-today-empty">
        <i class="fa-solid fa-chart-candlestick"></i>
        <p>${emptyText}</p>
      </div>
    `;
    return;
  }
  
  const selectedTicket = document.getElementById('analysisTradeSelect')?.value || '';
  
  const sorted = filtered.slice().sort((a, b) => b.closeIST - a.closeIST);
  
  container.innerHTML = sorted.map(t => {
    const profitColor = t.profit >= 0 ? 'green' : 'red';
    const profitStr = (t.profit >= 0 ? '+' : '') + '$' + t.profit.toFixed(2);
    let timeStr = t.closeIST ? fmtTime(t.closeIST) : '—';
    if (filterType !== 'today' && t.closeIST) {
      if (isoDay(t.closeIST) !== todayISO) {
        timeStr = fmtShort(t.closeIST) + ' ' + timeStr;
      }
    }
    const isActive = t.ticket === selectedTicket ? 'active' : '';
    return `
      <div class="an-today-trade-item ${isActive}" data-ticket="${t.ticket}">
        <div class="an-today-trade-info">
          <span class="an-today-trade-sym">${t.symbol.toUpperCase()} (${t.type.toUpperCase()})</span>
          <span class="an-today-trade-meta">${t.lots.toFixed(2)} lots · ${timeStr} IST</span>
        </div>
        <span class="an-today-trade-pnl ${profitColor}">${profitStr}</span>
      </div>
    `;
  }).join('');
}

function updateDailyLossInputType(type) {
  const lbl = document.getElementById('lblDailyLossValue');
  const input = document.getElementById('analysisDailyLoss');
  if (!lbl || !input) return;
  
  if (type === 'percent') {
    lbl.textContent = 'Daily Loss Limit (%)';
    input.placeholder = 'e.g. 2';
  } else if (type === 'trades') {
    lbl.textContent = 'Daily Max Trades';
    input.placeholder = 'e.g. 5';
  } else {
    lbl.textContent = 'Daily Loss Limit ($)';
    input.placeholder = 'e.g. 50';
  }
}

const tradesFilterEl = document.getElementById('analysisTradesFilter');
if (tradesFilterEl) {
  tradesFilterEl.addEventListener('change', () => {
    updateTodayTradesList();
  });
}

/* ─── Auto-save Daily Rules & Targets ─── */
async function autoSaveDailyRules() {
  const dailyLoss = parseFloat(document.getElementById('analysisDailyLoss').value) || 0;
  const dailyProfit = parseFloat(document.getElementById('analysisDailyProfit').value) || 0;
  const dailyLossType = document.getElementById('dailyLossType').value;
  const startingCapInput = parseFloat(document.getElementById('capitalInput').value) || 0;

  try {
    const res = await fetch('/api/profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        dailyLossLimit: dailyLoss,
        dailyProfitTarget: dailyProfit,
        dailyLossType: dailyLossType,
        startingCapital: startingCapInput
      })
    });
    if (res.ok) {
      startingCapital = startingCapInput;
      const hint = document.getElementById('capitalHint');
      if (hint) {
        if (startingCapital > 0) {
          hint.textContent = 'Saved: $' + startingCapital.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});
          hint.className = 'cap-hint ok';
        } else {
          hint.textContent = '';
        }
      }
      
      // Update preview pills
      updateAnalysisPreviews();

      if (allTrades.length) {
        buildDashboard(allTrades);
      }
    }
  } catch(e) {
    console.error('Error auto-saving rules:', e);
  }
}

// Debounce helper
function debounce(func, delay) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), delay);
  };
}

const debouncedSaveDailyRules = debounce(autoSaveDailyRules, 1000);

document.getElementById('dailyLossType').addEventListener('change', (e) => {
  updateDailyLossInputType(e.target.value);
  autoSaveDailyRules();
});

// Save on change (focus loss)
document.getElementById('capitalInput').addEventListener('change', autoSaveDailyRules);
document.getElementById('analysisDailyLoss').addEventListener('change', autoSaveDailyRules);
document.getElementById('analysisDailyProfit').addEventListener('change', autoSaveDailyRules);

// Fast preview and debounced save on typing input
document.getElementById('capitalInput').addEventListener('input', () => {
  updateAnalysisPreviews();
  debouncedSaveDailyRules();
});
document.getElementById('analysisDailyLoss').addEventListener('input', () => {
  updateAnalysisPreviews();
  debouncedSaveDailyRules();
});
document.getElementById('analysisDailyProfit').addEventListener('input', () => {
  updateAnalysisPreviews();
  debouncedSaveDailyRules();
});

document.getElementById('btnSaveDailyRules').addEventListener('click', async () => {
  await autoSaveDailyRules();
  showToast('Rules, targets and starting capital saved!', 'success');
  const badge = document.getElementById('rulesSavedBadge');
  if (badge) {
    badge.style.display = 'inline-block';
    setTimeout(() => { badge.style.display = 'none'; }, 3000);
  }
});

let currentUploadedBase64 = '';

document.getElementById('analysisTradeSelect').addEventListener('change', (e) => {
  const ticket = e.target.value;
  const btnSave = document.getElementById('btnSaveTradeAnalysis');
  const tradeBody = document.getElementById('anTradeBody');
  const emptyState = document.getElementById('anEmptyState');
  const tradeFooter = document.getElementById('anTradeFooter');

  // Update active state in Today's Trades list
  document.querySelectorAll('.an-today-trade-item').forEach(el => {
    if (el.dataset.ticket === ticket) {
      el.classList.add('active');
    } else {
      el.classList.remove('active');
    }
  });

  // Update Daily Performance table to highlight the selected trade's day
  if (ticket) {
    const selTrade = allTrades.find(t => t.ticket === ticket);
    const selDateKey = selTrade && selTrade.closeIST ? isoDay(selTrade.closeIST) : null;
    renderDailyPerformanceTable(selDateKey);
  } else {
    renderDailyPerformanceTable(null);
  }
  
  if (!ticket) {
    if (tradeBody) { tradeBody.classList.remove('visible'); }
    if (emptyState) { emptyState.style.display = 'flex'; }
    if (tradeFooter) { tradeFooter.classList.remove('visible'); }
    btnSave.disabled = true;
    document.getElementById('analysisTimeframe').value = '';
    document.getElementById('analysisNotes').value = '';
    document.getElementById('screenshotPreview').style.display = 'none';
    const dz = document.getElementById('screenshotDropZone');
    if (dz) { dz.classList.remove('has-image'); }
    const controls = document.getElementById('screenshotControls');
    if (controls) { controls.style.display = 'none'; }
    currentUploadedBase64 = '';
    return;
  }
  
  const trade = allTrades.find(t => t.ticket === ticket);
  if (!trade) return;
  
  // Show the review UI
  if (tradeBody)   { tradeBody.classList.add('visible'); }
  if (emptyState)  { emptyState.style.display = 'none'; }
  if (tradeFooter) { tradeFooter.classList.add('visible'); }
  btnSave.disabled = false;

  // Populate new stat boxes
  const profitColor = trade.profit >= 0 ? 'green' : 'red';
  const profitStr = (trade.profit >= 0 ? '+' : '') + '$' + trade.profit.toFixed(2);
  
  const setNew = (id, val, cls) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.className = 'tsb-val' + (cls ? ' ' + cls : '');
  };
  setNew('dtTicketNew', trade.ticket);
  setNew('dtSymbolTypeNew', `${trade.symbol.toUpperCase()} / ${trade.type.toUpperCase()}`);
  setNew('dtLotsNew', trade.lots.toFixed(2) + ' lots');
  setNew('dtProfitNew', profitStr, profitColor);
  setNew('dtCloseTimeNew', trade.closeIST ? (fmtShort(trade.closeIST) + ' ' + fmtTime(trade.closeIST)) : '—');

  // Also keep hidden backward-compat fields updated
  document.getElementById('dtTicket').textContent = trade.ticket;
  document.getElementById('dtSymbolType').textContent = `${trade.symbol.toUpperCase()} / ${trade.type.toUpperCase()}`;
  document.getElementById('dtLotsProfit').textContent = `${trade.lots.toFixed(2)} lots · ${profitStr}`;
  document.getElementById('dtCloseTime').textContent = trade.closeIST ? (fmtShort(trade.closeIST) + ' ' + fmtTime(trade.closeIST)) : '—';
  
  document.getElementById('analysisTimeframe').value = trade.timeframe || '';
  document.getElementById('analysisNotes').value = trade.notes || '';
  
  const preview = document.getElementById('screenshotPreview');
  const dz = document.getElementById('screenshotDropZone');
  const controls = document.getElementById('screenshotControls');
  if (trade.screenshotUrl) {
    preview.src = trade.screenshotUrl;
    preview.style.display = 'block';
    if (dz) { dz.classList.add('has-image'); }
    if (controls) { controls.style.display = 'flex'; }
    currentUploadedBase64 = trade.screenshotUrl;
  } else {
    preview.style.display = 'none';
    if (dz) { dz.classList.remove('has-image'); }
    if (controls) { controls.style.display = 'none'; }
    currentUploadedBase64 = '';
  }
});

// Click handler for Today's Trades list to sync with Trade Setup Review
const tradesListContainer = document.getElementById('todayTradesList');
if (tradesListContainer) {
  tradesListContainer.addEventListener('click', (e) => {
    const item = e.target.closest('.an-today-trade-item');
    if (item) {
      const ticket = item.dataset.ticket;
      const selectEl = document.getElementById('analysisTradeSelect');
      if (selectEl && ticket) {
        selectEl.value = ticket;
        selectEl.dispatchEvent(new Event('change'));
      }
    }
  });
}

const dropZone = document.getElementById('screenshotDropZone');
const fileInput = document.getElementById('screenshotInput');

dropZone.addEventListener('click', (e) => {
  if (dropZone.classList.contains('has-image')) {
    e.stopPropagation();
    // Open lightbox
    const preview = document.getElementById('screenshotPreview');
    const lightbox = document.getElementById('lightboxModal');
    const lightboxImg = document.getElementById('lightboxImage');
    if (lightbox && lightboxImg && preview) {
      lightboxImg.src = preview.src;
      lightbox.classList.add('show');
      lightbox.style.display = 'flex';
    }
    return;
  }
  fileInput.click();
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    handleScreenshotFile(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files && e.target.files[0]) {
    handleScreenshotFile(e.target.files[0]);
  }
});

// Reusable function to save timeframe, notes, and screenshot
async function saveTradeSetup() {
  const ticket = document.getElementById('analysisTradeSelect').value;
  if (!ticket) return;
  
  const timeframe = document.getElementById('analysisTimeframe').value;
  const notes = document.getElementById('analysisNotes').value;
  
  try {
    const res = await fetch(`/api/trades/${ticket}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeframe,
        notes,
        screenshotUrl: currentUploadedBase64
      })
    });
    
    if (res.ok) {
      const idx = allTrades.findIndex(t => t.ticket === ticket);
      if (idx !== -1) {
        allTrades[idx].timeframe = timeframe;
        allTrades[idx].notes = notes;
        allTrades[idx].screenshotUrl = currentUploadedBase64;
      }
    } else {
      const err = await res.json();
      showToast('Failed to save trade setup: ' + (err.error || 'unknown error'), 'error');
    }
  } catch (e) {
    showToast('Network error saving trade setup analysis', 'error');
  }
}

function handleScreenshotFile(file) {
  if (!file.type.startsWith('image/')) {
    showToast('Please upload a valid image file', 'error');
    return;
  }
  
  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64 = e.target.result;
    const preview = document.getElementById('screenshotPreview');
    const dz = document.getElementById('screenshotDropZone');
    const controls = document.getElementById('screenshotControls');
    
    preview.src = base64;
    preview.style.display = 'block';
    if (dz) { dz.classList.add('has-image'); }
    if (controls) { controls.style.display = 'flex'; }
    currentUploadedBase64 = base64;
    
    // Auto-save immediately!
    await saveTradeSetup();
    showToast('Screenshot uploaded and saved!', 'success');
  };
  reader.readAsDataURL(file);
}

// Event listeners for screenshot controls
document.getElementById('btnReplaceScreenshot').addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

document.getElementById('btnRemoveScreenshot').addEventListener('click', async (e) => {
  e.stopPropagation();
  const confirmed = window.confirm('Are you sure you want to remove this screenshot?');
  if (!confirmed) return;

  const preview = document.getElementById('screenshotPreview');
  const dz = document.getElementById('screenshotDropZone');
  const controls = document.getElementById('screenshotControls');
  
  if (preview) { preview.src = ''; preview.style.display = 'none'; }
  if (dz) { dz.classList.remove('has-image'); }
  if (controls) { controls.style.display = 'none'; }
  currentUploadedBase64 = '';
  
  // Auto-save the removal immediately
  await saveTradeSetup();
  showToast('Screenshot removed and saved!', 'success');
});

// Auto-save timeframe and notes on input/change
document.getElementById('analysisTimeframe').addEventListener('change', saveTradeSetup);

const debouncedSaveTradeSetup = debounce(saveTradeSetup, 1000);
document.getElementById('analysisNotes').addEventListener('input', debouncedSaveTradeSetup);

// Click handler for preview image to trigger lightbox
document.getElementById('screenshotPreview').addEventListener('click', (e) => {
  e.stopPropagation();
  const lightbox = document.getElementById('lightboxModal');
  const lightboxImg = document.getElementById('lightboxImage');
  if (lightbox && lightboxImg) {
    lightboxImg.src = e.target.src;
    lightbox.classList.add('show');
    lightbox.style.display = 'flex';
  }
});

// Close lightbox on click
document.getElementById('lightboxModal').addEventListener('click', () => {
  const lightbox = document.getElementById('lightboxModal');
  if (lightbox) {
    lightbox.classList.remove('show');
    setTimeout(() => { lightbox.style.display = 'none'; }, 300);
  }
});

// Manual save button triggers immediate save with feedback toast
document.getElementById('btnSaveTradeAnalysis').addEventListener('click', async () => {
  await saveTradeSetup();
  showToast('Trade setup analysis saved successfully!', 'success');
});

// Override buildDashboard and resetDashboardToEmpty to keep profile stats and analysis page updated
const originalBuildDashboard = buildDashboard;
buildDashboard = function(raw) {
  originalBuildDashboard(raw);
  updateProfileStats();
  populateAnalysisTradesDropdown();
  updateAnalysisPreviews();
  renderDailyPerformanceTable(null); // Render with all days
};

const originalResetDashboard = resetDashboardToEmpty;
resetDashboardToEmpty = function() {
  originalResetDashboard();
  updateProfileStats();
  populateAnalysisTradesDropdown();
  updateAnalysisPreviews();
  renderDailyPerformanceTable(null);
};

/* ─── Daily Performance Table ─── */

/**
 * Computes per-day performance stats from allTrades.
 * Returns array of { dateKey, date, totalPnl, winRate, totalTrades, avgDurationMs }
 * sorted descending by date.
 */
function computeDailyPerformance() {
  if (!allTrades || !allTrades.length) return [];
  
  const dayMap = {};
  
  allTrades.forEach(t => {
    if (!t.closeIST) return;
    const key = isoDay(t.closeIST);
    if (!dayMap[key]) {
      dayMap[key] = { dateKey: key, date: t.closeIST, trades: [], totalPnl: 0, wins: 0 };
    }
    dayMap[key].trades.push(t);
    dayMap[key].totalPnl += t.profit;
    if (t.profit > 0) dayMap[key].wins++;
  });
  
  return Object.values(dayMap)
    .map(day => {
      const totalTrades = day.trades.length;
      const winRate = totalTrades > 0 ? ((day.wins / totalTrades) * 100).toFixed(0) : 0;
      
      // Calculate average trade duration in milliseconds
      let totalDurMs = 0;
      let durCount = 0;
      day.trades.forEach(t => {
        if (t.open && t.close) {
          const openIST = toIST(t.open);
          const closeIST = toIST(t.close);
          if (openIST && closeIST) {
            const diffMs = closeIST.getTime() - openIST.getTime();
            if (diffMs > 0) {
              totalDurMs += diffMs;
              durCount++;
            }
          }
        }
      });
      
      const avgDurationMs = durCount > 0 ? totalDurMs / durCount : 0;
      
      return {
        dateKey: day.dateKey,
        date: day.date,
        totalPnl: +day.totalPnl.toFixed(2),
        winRate: parseInt(winRate),
        totalTrades,
        avgDurationMs
      };
    })
    .sort((a, b) => b.date - a.date); // Newest first
}

/**
 * Format milliseconds into a human-readable duration string.
 */
function fmtDuration(ms) {
  if (!ms || ms <= 0) return '—';
  const totalSec = Math.round(ms / 1000);
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  
  if (hours > 0) {
    return hours + 'h ' + mins + 'm';
  } else if (mins > 0) {
    return mins + 'm ' + secs + 's';
  } else {
    return secs + 's';
  }
}

/**
 * Render the daily performance table.
 * @param {string|null} filterDateKey - ISO date key (YYYY-MM-DD) to highlight and scroll to, or null to show all.
 */
function renderDailyPerformanceTable(filterDateKey) {
  const empty = document.getElementById('dpEmpty');
  const table = document.getElementById('dpTable');
  const tbody = document.getElementById('dpTableBody');
  const badge = document.getElementById('dpBadge');
  
  if (!empty || !table || !tbody) return;
  
  const perfData = computeDailyPerformance();
  
  if (!perfData.length) {
    empty.style.display = 'flex';
    table.style.display = 'none';
    if (badge) badge.textContent = 'All Days';
    return;
  }
  
  empty.style.display = 'none';
  table.style.display = 'table';
  
  if (badge) {
    badge.textContent = filterDateKey ? '1 Day' : perfData.length + ' Days';
  }
  
  tbody.innerHTML = perfData.map(day => {
    const isActive = filterDateKey && day.dateKey === filterDateKey;
    const pnlColor = day.totalPnl >= 0 ? 'win' : 'loss';
    const pnlStr = (day.totalPnl >= 0 ? '+' : '') + '$' + Math.abs(day.totalPnl).toFixed(2);
    const wrColor = day.winRate >= 60 ? 'color:var(--green)' : day.winRate <= 35 ? 'color:var(--red)' : 'color:var(--text)';
    
    // Format date nicely
    const [y, m, d] = day.dateKey.split('-');
    const dateLabel = d + ' ' + MONTHS_SHORT[parseInt(m)-1] + ' ' + y;
    
    return `<tr class="${isActive ? 'dp-row-active' : ''}" data-date="${day.dateKey}">
      <td class="dp-date">${dateLabel}</td>
      <td class="dp-pnl ${pnlColor}">${pnlStr}</td>
      <td class="dp-wr" style="${wrColor}">${day.winRate}%</td>
      <td class="dp-count">${day.totalTrades}</td>
      <td class="dp-dur">${fmtDuration(day.avgDurationMs)}</td>
    </tr>`;
  }).join('');
  
  // Scroll to highlighted row if a date filter is active
  if (filterDateKey) {
    const activeRow = tbody.querySelector('.dp-row-active');
    if (activeRow) {
      setTimeout(() => {
        activeRow.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 50);
    }
  }
}

// Run boot to initialize
boot();


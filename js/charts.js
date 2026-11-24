import { $, eur, sum, isPaid, iso } from './config.js';
import { buildCycles, cycleTransactions, isSavingTx, savingSigned } from './finance-engine.js';

function getThemeColors() {
  const dark = document.documentElement.getAttribute('data-theme') === 'dark';
  return {
    text: dark ? '#93a4b7' : '#68798a',
    ink: dark ? '#e8eef5' : '#192838',
    grid: dark ? 'rgba(255,255,255,0.08)' : 'rgba(20,43,69,0.08)',
    accent: dark ? '#5b9bd5' : '#173653',
    green: '#2b8a64',
    gold: '#c5a56b',
    red: '#b54747'
  };
}

export function drawSavingsChart(state) {
  const canvas = $('savingsChart');
  if (!canvas) return;
  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(280, rect.width || 420);
  const h = 220;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const colors = getThemeColors();
  const cycles = buildCycles(state).slice(-8);
  const allSav = (state.transactions || []).filter(t => !t.deleted_at && isSavingTx(t) && isPaid(t));

  const points = cycles.map(c => {
    const cum = allSav.filter(t => t.date <= c.end).reduce((a, t) => a + savingSigned(t), 0);
    return { label: c.monthLabel.slice(0, 3), value: Math.max(0, cum) };
  });

  if (!points.length) return;
  const maxVal = Math.max(100, ...points.map(p => p.value)) * 1.15;
  const padL = 56, padR = 16, padT = 18, padB = 30;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const y = padT + (plotH * i) / 3;
    const val = maxVal * (1 - i / 3);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(Math.round(val) + '€', padL - 6, y + 4);
  }

  const coords = points.map((p, idx) => ({
    x: padL + (points.length === 1 ? plotW / 2 : (plotW * idx) / (points.length - 1)),
    y: padT + plotH - (p.value / maxVal) * plotH,
    ...p
  }));

  ctx.beginPath();
  coords.forEach((pt, i) => (i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y)));
  ctx.strokeStyle = colors.green;
  ctx.lineWidth = 2.5;
  ctx.stroke();

  ctx.textAlign = 'center';
  coords.forEach(pt => {
    ctx.beginPath();
    ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = colors.gold;
    ctx.fill();
    ctx.fillStyle = colors.text;
    ctx.fillText(pt.label, pt.x, h - 10);
  });
}

export function drawAnalyticsChart(state, cycle, metric = 'categories', chartType = 'bar') {
  const canvas = $('analyticsCanvas');
  const legendEl = $('analyticsLegend');
  if (!canvas || !cycle) return;

  const rect = canvas.parentElement.getBoundingClientRect();
  const w = Math.max(280, rect.width || 500);
  const h = 230;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);

  const colors = getThemeColors();
  const palette = ['#2B8A64', '#D49B3E', '#1F567D', '#48B888', '#8E6BBF', '#D96B52', '#3A9AB8', '#A68A56'];
  let items = [];

  if (metric === 'cycles_trend') {
    const cycles = buildCycles(state).slice(-6);
    items = cycles.map(c => {
      const txs = cycleTransactions(state, c).filter(t => isPaid(t) && t.type === 'expense');
      return { label: c.monthLabel.slice(0, 6), value: sum(txs) };
    });
  } else {
    const txs = cycleTransactions(state, cycle).filter(t => isPaid(t) && t.type === 'expense' && t.date <= iso());
    const activeCats = (state.categories || []).filter(c => !c.deleted_at);
    items = activeCats
      .map(c => ({
        label: c.name,
        value: sum(txs.filter(t => t.category === c.name)),
        budget: Number(c.budget) || 0
      }))
      .filter(x => x.value > 0 || (metric === 'budget_vs_actual' && x.budget > 0));
  }

  if (legendEl) {
    legendEl.innerHTML = items
      .map((it, i) => `<span class="legend-item"><i class="legend-swatch" style="background:${palette[i % palette.length]}"></i>${it.label}: <b>${eur(it.value)}</b></span>`)
      .join('');
  }

  if (!items.length) {
    ctx.fillStyle = colors.text;
    ctx.font = '13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Sem dados suficientes neste ciclo.', w / 2, h / 2);
    return;
  }

  if (chartType === 'pie') {
    const total = items.reduce((a, b) => a + b.value, 0) || 1;
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) * 0.38;
    let start = -Math.PI / 2;
    items.forEach((it, idx) => {
      const slice = (it.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + slice);
      ctx.closePath();
      ctx.fillStyle = palette[idx % palette.length];
      ctx.fill();
      start += slice;
    });
    return;
  }

  const maxVal = Math.max(10, ...items.map(i => Math.max(i.value, i.budget || 0))) * 1.15;
  const padL = 56, padR = 16, padT = 18, padB = 34;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  ctx.strokeStyle = colors.grid;
  ctx.fillStyle = colors.text;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 3; i++) {
    const y = padT + (plotH * i) / 3;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillText(Math.round(maxVal * (1 - i / 3)) + '€', padL - 6, y + 4);
  }

  const step = plotW / items.length;
  ctx.textAlign = 'center';
  if (chartType === 'line') {
    ctx.beginPath();
    items.forEach((it, i) => {
      const x = padL + step * i + step / 2;
      const y = padT + plotH - (it.value / maxVal) * plotH;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.strokeStyle = colors.green;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }

  items.forEach((it, i) => {
    const cx = padL + step * i + step / 2;
    const barH = (it.value / maxVal) * plotH;
    const y = padT + plotH - barH;
    if (chartType === 'bar') {
      const bw = Math.min(34, step * 0.56);
      ctx.fillStyle = palette[i % palette.length];
      ctx.fillRect(cx - bw / 2, y, bw, barH);
    } else {
      ctx.beginPath();
      ctx.arc(cx, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = colors.gold;
      ctx.fill();
    }
    ctx.fillStyle = colors.text;
    ctx.fillText(it.label.slice(0, 9), cx, h - 10);
  });
}

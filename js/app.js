import {
  APP_VERSION, $, iso, currentMonth, eur, esc, sum, isPaid, fmtDate,
  addMonthsClamp, uid, haptic, showToast, evaluateAmountExpression,
  loadUiPrefs, saveUiPrefs, applyThemeAndDensity
} from './config.js';
import {
  loadLocalState, saveLocalState,
  convertLegacyV1Backup, createInitialState
} from './db.js';
import {
  buildCycles, currentCycle, cycleTransactions, computeCycleBalance,
  computeCycleProjection, computeDailyBurnRate, getAllCreditCardsStats, computeCreditCardDebt,
  goalTotal, getUserDisplayName, computeCycleReferenceMonth, getProjectedCalendarEvents
} from './finance-engine.js';
import { SecurityManager } from './security.js';
import { extractLinesFromPdf, parseStatementLines, guessCategory, learnCategoryRule } from './importers.js';
import { evaluateStatementDuplicates } from './duplicate-detector.js';
import { generateCyclePdfReport } from './pdf-report.js';
import { drawSavingsChart, drawAnalyticsChart } from './charts.js';

let state = loadLocalState();
let selectedCycleKey = null;
let movementCycleKey = null;
let encargosCycleKey = null;
let quickStatusFilter = 'all';
let calendarMonthStr = currentMonth();
let calScopeMode = 'day';
let selectedGoalId = null;

const CAL_LAYOUT_KEY = 'unofin_cal_split_v1';
function loadCalLayoutPrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(CAL_LAYOUT_KEY) || '{}');
    return {
      leftPct: Number.isFinite(raw.leftPct) ? Math.min(72, Math.max(28, raw.leftPct)) : 50,
      swapped: !!raw.swapped
    };
  } catch (_) {
    return { leftPct: 50, swapped: false };
  }
}
function saveCalLayoutPrefs(prefs) {
  try {
    localStorage.setItem(CAL_LAYOUT_KEY, JSON.stringify(prefs));
  } catch (_) {}
}
let calLayoutPrefs = loadCalLayoutPrefs();

let selectedCalendarDay = iso();
let parsedImportRows = [];

const security = new SecurityManager();
security.applyPrivacy();
security.startIdleWatcher();
if (security.hasPin()) security.lock();

function mutate(record) {
  if (record) record.updated_at = Date.now();
  saveLocalState(state);
  render();
}

function openMobileDrawer() {
  $('mobileMoreBackdrop').hidden = false;
  $('mobileMoreDrawer').hidden = false;
  $('mobileMoreBtn').setAttribute('aria-expanded', 'true');
}

function closeMobileDrawer() {
  $('mobileMoreBackdrop').hidden = true;
  $('mobileMoreDrawer').hidden = true;
  $('mobileMoreBtn').setAttribute('aria-expanded', 'false');
}

function updateAnalyticsView() {
  const cycles = buildCycles(state);
  const c = cycles.find(x => x.key === $('analyticsCycleSelect').value) || currentCycle(cycles);
  if ($('analyticsCycleSubtitle') && c) {
    $('analyticsCycleSubtitle').textContent = `${c.monthLabel} · ${fmtDate(c.start)} a ${fmtDate(c.end)}`;
  }
  requestAnimationFrame(() => drawAnalyticsChart(state, c, $('analyticsMetric').value, $('analyticsChartType').value));
}

function switchTab(tabId) {
  closeMobileDrawer();
  document.querySelectorAll('nav button[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === tabId));

  const isDrawerTab = ['recorrentes', 'calendario', 'orcamento', 'dados'].includes(tabId);
  if ($('mobileMoreBtn')) $('mobileMoreBtn').classList.toggle('active', isDrawerTab);

  if (tabId === 'resumo') requestAnimationFrame(() => drawSavingsChart(state));
  if (tabId === 'graficos') updateAnalyticsView();
  if (tabId === 'calendario') renderCalendar();
}

const DISMISSED_ALERTS_KEY = 'unofin-dismissed-alerts-v1';

function getDismissedAlertsMap() {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_ALERTS_KEY) || '{}') || {};
  } catch {
    return {};
  }
}

function isAlertDismissedForCycle(cycleKey, alertId) {
  const map = getDismissedAlertsMap();
  return Array.isArray(map[cycleKey]) && map[cycleKey].includes(alertId);
}

function dismissAlertForCycle(cycleKey, alertId) {
  const map = getDismissedAlertsMap();
  const list = Array.isArray(map[cycleKey]) ? map[cycleKey] : [];
  if (!list.includes(alertId)) list.push(alertId);
  map[cycleKey] = list;
  const keys = Object.keys(map);
  if (keys.length > 12) {
    keys.slice(0, keys.length - 12).forEach(k => delete map[k]);
  }
  try {
    localStorage.setItem(DISMISSED_ALERTS_KEY, JSON.stringify(map));
  } catch {}
}

let rolloverPromptOpen = false;

function checkAutomaticCycleRollover() {
  if (rolloverPromptOpen) return;
  if ($('closeCycleModal') && !$('closeCycleModal').hidden) return;
  if ($('appLockOverlay') && !$('appLockOverlay').hidden) return;

  const cycles = buildCycles(state);
  const closedCycles = cycles.filter(c => !c.open && !c.fallback && !c.preCycle);
  if (!closedCycles.length) return;

  const handled = new Set(state.meta?.handled_rollovers || []);
  const latestClosed = closedCycles[closedCycles.length - 1];

  const closureTag = `cycle-close:${latestClosed.key}`;
  const existingClosureTxs = state.transactions.filter(t => !t.deleted_at && t.occurrence_key === closureTag);
  if (existingClosureTxs.length) {
    const realCloseBal = Number(computeCycleBalance(state, latestClosed, latestClosed.end).toFixed(2));
    const currentClosureTx = existingClosureTxs[0];
    const currentSigned = currentClosureTx.type === 'income' ? Number(currentClosureTx.amount) : -Number(currentClosureTx.amount);
    if (Math.abs(realCloseBal - currentSigned) >= 0.01 && currentClosureTx.category === 'Saldo transitado') {
      const [ey, em, ed] = latestClosed.end.split('-').map(Number);
      const nextDayObj = new Date(ey, em - 1, ed + 1);
      const nextCycleStartDate = `${nextDayObj.getFullYear()}-${String(nextDayObj.getMonth() + 1).padStart(2, '0')}-${String(nextDayObj.getDate()).padStart(2, '0')}`;
      if (Math.abs(realCloseBal) < 0.01) {
        currentClosureTx.deleted_at = Date.now();
        currentClosureTx.updated_at = Date.now();
      } else {
        currentClosureTx.date = nextCycleStartDate;
        currentClosureTx.type = realCloseBal >= 0 ? 'income' : 'expense';
        currentClosureTx.description = realCloseBal >= 0
          ? `Saldo positivo transitado (${fmtDate(latestClosed.start)} – ${fmtDate(latestClosed.end)})`
          : `Saldo negativo transitado (${fmtDate(latestClosed.start)} – ${fmtDate(latestClosed.end)})`;
        currentClosureTx.amount = Math.abs(realCloseBal);
        currentClosureTx.updated_at = Date.now();
      }
      saveLocalState(state);
    }
    if (!handled.has(latestClosed.key)) {
      state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
      state.meta.handled_rollovers = [...handled, latestClosed.key];
      saveLocalState(state);
    }
    return;
  }

  if (handled.has(latestClosed.key)) return;

  const bal = Number(computeCycleBalance(state, latestClosed, latestClosed.end).toFixed(2));
  if (Math.abs(bal) < 0.01) {
    state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
    state.meta.handled_rollovers = [...handled, latestClosed.key];
    saveLocalState(state);
    return;
  }

  selectedCycleKey = latestClosed.key;
  rolloverPromptOpen = true;
  if (typeof window._openCloseCycleModalFor === 'function') {
    window._openCloseCycleModalFor(latestClosed);
  }
}

function drawResumoDonutChart(catSlices, totalAmount) {
  const panel = $('catsDonutPanel');
  const canvas = $('resumoDonutCanvas');
  const totalEl = $('resumoDonutTotal');
  if (!panel || !canvas || !totalEl) return;

  panel.hidden = false;
  totalEl.textContent = eur(totalAmount || 0);

  const valid = (catSlices || []).filter(s => s.value > 0);
  if (!valid.length || totalAmount <= 0) {
    const dpr0 = Math.min(window.devicePixelRatio || 1, 2);
    const sz0 = 190;
    canvas.width = sz0 * dpr0;
    canvas.height = sz0 * dpr0;
    canvas.style.width = `${sz0}px`;
    canvas.style.height = `${sz0}px`;
    const ctx0 = canvas.getContext('2d');
    ctx0.scale(dpr0, dpr0);
    ctx0.clearRect(0, 0, sz0, sz0);
    ctx0.beginPath();
    ctx0.arc(sz0 / 2, sz0 / 2, 74, 0, Math.PI * 2);
    ctx0.strokeStyle = 'rgba(130, 150, 170, 0.22)';
    ctx0.lineWidth = 22;
    ctx0.stroke();
    return;
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = 190;
  canvas.width = size * dpr;
  canvas.height = size * dpr;
  canvas.style.width = `${size}px`;
  canvas.style.height = `${size}px`;

  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, size, size);

  const palette = ['#2B8A64', '#D49B3E', '#1F567D', '#48B888', '#8E6BBF', '#D96B52', '#3A9AB8', '#A68A56'];
  const cx = size / 2;
  const cy = size / 2;
  const radius = 74;
  const lineWidth = 22;
  let startAngle = -Math.PI / 2;

  valid.forEach((slice, idx) => {
    const angle = (slice.value / totalAmount) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, startAngle, startAngle + angle);
    ctx.strokeStyle = palette[idx % palette.length];
    ctx.lineWidth = lineWidth;
    ctx.lineCap = 'butt';
    ctx.stroke();
    startAngle += angle;
  });
}

function getSuggestedEncargoDate(cycle, dayOfMonth) {
  const day = Math.min(31, Math.max(1, Number(dayOfMonth) || 1));
  if (!cycle || !cycle.start || !cycle.end) {
    const curM = currentMonth();
    const [y, m] = curM.split('-').map(Number);
    const maxD = new Date(y, m, 0).getDate();
    return `${curM}-${String(Math.min(day, maxD)).padStart(2, '0')}`;
  }
  const [sy, sm] = cycle.start.split('-').map(Number);
  const sMaxD = new Date(sy, sm, 0).getDate();
  const cand1 = `${cycle.start.slice(0, 7)}-${String(Math.min(day, sMaxD)).padStart(2, '0')}`;
  if (cand1 >= cycle.start && cand1 <= cycle.end) return cand1;

  const [ey, em] = cycle.end.split('-').map(Number);
  const eMaxD = new Date(ey, em, 0).getDate();
  const cand2 = `${cycle.end.slice(0, 7)}-${String(Math.min(day, eMaxD)).padStart(2, '0')}`;
  if (cand2 >= cycle.start && cand2 <= cycle.end) return cand2;

  return cycle.start;
}

function render() {
  document.title = `UnoFin ${APP_VERSION} — Gestão financeira pessoal`;
  const footerEl = document.querySelector('footer');
  if (footerEl) footerEl.textContent = `UnoFin · ${APP_VERSION} · Gestão financeira pessoal`;

  const prefs = loadUiPrefs();
  if ($('resumo')) $('resumo').setAttribute('data-summary-level', prefs.summaryLevel || 'detailed');
  document.querySelectorAll('[data-summary-level-btn]').forEach(btn => {
    const active = btn.dataset.summaryLevelBtn === (prefs.summaryLevel || 'detailed');
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-pressed', String(active));
  });

  if ($('lockAppHeaderBtn')) $('lockAppHeaderBtn').hidden = !security.hasPin();
  if ($('disablePinBtn')) $('disablePinBtn').hidden = !security.hasPin();
  if ($('lockNowBtn')) $('lockNowBtn').hidden = !security.hasPin();
  if ($('enableBioBtn')) {
    $('enableBioBtn').hidden = !(security.hasPin() && window.PublicKeyCredential);
    $('enableBioBtn').textContent = security.cfg.bioCredId ? '👆 Biometria ativa (Reconfigurar)' : '👆 Ativar Biometria';
  }
  if ($('securityLockStatus')) {
    $('securityLockStatus').textContent = security.hasPin()
      ? `🔒 Bloqueio por PIN ativo${security.cfg.bioCredId ? ' (com Biometria)' : ''} neste dispositivo.`
      : 'Bloqueio por PIN desativado neste dispositivo.';
    $('securityLockStatus').className = 'alert' + (security.hasPin() ? ' good' : '');
  }

  const cycles = buildCycles(state);
  const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
  selectedCycleKey = cycle.key;
  if (!movementCycleKey) movementCycleKey = cycle.key;

  const cycleIdx = cycles.findIndex(c => c.key === cycle.key);
  if ($('prevCycleBtn')) $('prevCycleBtn').disabled = cycleIdx <= 0;
  if ($('nextCycleBtn')) $('nextCycleBtn').disabled = cycleIdx >= cycles.length - 1;

  const mLabel = cycle.monthLabel || computeCycleReferenceMonth(cycle);
  $('monthTitle').textContent = cycle.fallback ? `${mLabel} · provisório` : `Ciclo de ${mLabel}${cycle.open ? ' (em curso)' : ''}`;
  $('cycleRange').textContent = `${fmtDate(cycle.start)} a ${fmtDate(cycle.end)}`;

  const cycleOptionsHtml = cycles
    .slice()
    .reverse()
    .map(c => `<option value="${esc(c.key)}">${esc(c.monthLabel)} (${fmtDate(c.start)} – ${fmtDate(c.end)})</option>`)
    .join('');

  $('cycleSelect').innerHTML = cycleOptionsHtml;
  $('cycleSelect').value = cycle.key;

  $('movementCycle').innerHTML = '<option value="all">Todos os movimentos</option>' + cycleOptionsHtml;
  $('movementCycle').value = movementCycleKey;

  if ($('analyticsCycleSelect')) {
    const prevAna = $('analyticsCycleSelect').value;
    $('analyticsCycleSelect').innerHTML = cycleOptionsHtml;
    $('analyticsCycleSelect').value = cycles.some(c => c.key === prevAna) ? prevAna : cycle.key;
  }

  const today = iso();
  const tx = cycleTransactions(state, cycle).filter(t => t.date <= today);
  const ex = tx.filter(t => t.type === 'expense' && isPaid(t));
  const inc = tx.filter(t => t.type === 'income' && isPaid(t));
  const svIn = tx.filter(t => t.type === 'saving' && isPaid(t));
  const svOut = tx.filter(t => t.type === 'saving_withdraw' && isPaid(t));
  const ccPayItems = tx.filter(t => t.type === 'cc_payment' && isPaid(t));
  const ccPayTotal = sum(ccPayItems);
  const bankExItems = ex.filter(t => !t.credit_card_id);
  const ccExpItems = ex.filter(t => t.credit_card_id);
  const ccExpTotal = sum(ccExpItems);
  const bal = computeCycleBalance(state, cycle, today);

  $('inc').textContent = eur(sum(inc));
  $('exp').textContent = eur(sum(bankExItems) + ccPayTotal);
  $('bal').textContent = eur(bal);
  $('bal').className = bal < 0 ? 'minus' : '';
  $('savm').textContent = eur(sum(svIn) - sum(svOut));

  if ($('ccSpentLine')) {
    const parts = [];
    if (ccExpTotal > 0) parts.push(`💳 Compras a crédito: <strong>${eur(ccExpTotal)}</strong>`);
    if (ccPayTotal > 0) parts.push(`💳 Cartão pago no ciclo: <strong>${eur(ccPayTotal)}</strong>`);
    if (parts.length) {
      $('ccSpentLine').hidden = false;
      $('ccSpentLine').innerHTML = parts.join(' · ');
    } else {
      $('ccSpentLine').hidden = true;
      $('ccSpentLine').innerHTML = '';
    }
  }

  const totalBudget = (state.categories || []).filter(c => !c.deleted_at).reduce((a, c) => a + (Number(c.budget) || 0), 0);
  if ($('basicCycleProgressWrap')) {
    if (prefs.summaryLevel === 'basic' && totalBudget > 0) {
      $('basicCycleProgressWrap').hidden = false;
      const pct = Math.min(100, ((sum(bankExItems) + ccPayTotal) / totalBudget) * 100);
      $('basicCycleProgressBar').style.width = `${pct}%`;
      $('basicCycleProgressLabel').textContent = `${Math.round(pct)}% do orçamento planeado (${eur(totalBudget)})`;
    } else {
      $('basicCycleProgressWrap').hidden = true;
    }
  }

  const burn = computeDailyBurnRate(state, cycle, bal);
  if ($('dailyBurnRateLine')) {
    if (burn) {
      $('dailyBurnRateLine').hidden = false;
      $('dailyBurnRateLine').innerHTML =
        burn.dailyAllowance <= 0
          ? `⚠️ Orçamento diário esgotado (${burn.daysLeft}d até fecho)`
          : `📅 Disponível/dia: <strong>${eur(burn.dailyAllowance)}</strong> (${burn.daysLeft}d)`;
    } else {
      $('dailyBurnRateLine').hidden = true;
    }
  }

  const proj = computeCycleProjection(state, cycle, bal);
  if ($('projectedBalLine')) {
    if (proj && proj.itemCount > 0) {
      $('projectedBalLine').hidden = false;
      $('projectedBalLine').innerHTML = `Previsto no fecho: <strong>${eur(proj.projectedBalance)}</strong>`;
    } else {
      $('projectedBalLine').hidden = true;
    }
  }

  const activeCats = (state.categories || [])
    .filter(c => !c.deleted_at)
    .sort((a, b) => (Number(a.sort_order) || 999) - (Number(b.sort_order) || 999) || String(a.name).localeCompare(String(b.name)));
  const ccStats = getAllCreditCardsStats(state);

  if ($('alerts')) {
    const alertHtml = [];
    for (const c of activeCats) {
      if (c.budget > 0) {
        const paidSpent = sum(bankExItems.filter(t => t.category === c.name));
        const virtSpent = sum(ccExpItems.filter(t => t.category === c.name));
        const spent = paidSpent + virtSpent;
        if (spent > c.budget) {
          const aid = `cat-over:${c.id || c.name}`;
          if (!isAlertDismissedForCycle(cycle.key, aid)) {
            const detailTxt = virtSpent > 0 ? `${eur(paidSpent)} pago + ${eur(virtSpent)} a crédito` : `${eur(spent)}`;
            alertHtml.push(`<div class="alert red alert-dismissible"><span>⚠️ <b>${esc(c.name)}</b> ultrapassou o limite em ${eur(spent - c.budget)} (${detailTxt} / ${eur(c.budget)}).</span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta até ao ciclo seguinte" aria-label="Fechar alerta">✕</button></div>`);
          }
        } else if (spent >= c.budget * 0.85) {
          const aid = `cat-warn:${c.id || c.name}`;
          if (!isAlertDismissedForCycle(cycle.key, aid)) {
            alertHtml.push(`<div class="alert alert-dismissible"><span>⚡ <b>${esc(c.name)}</b> já atingiu ${Math.round((spent / c.budget) * 100)}% do orçamento (${eur(spent)} / ${eur(c.budget)}).</span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta até ao ciclo seguinte" aria-label="Fechar alerta">✕</button></div>`);
          }
        }
      }
    }
    for (const card of ccStats) {
      if (card.limit > 0 && card.debt >= card.limit * 0.8) {
        const aid = `cc-limit:${card.id || card.name}:${card.debt >= card.limit ? 'full' : '80'}`;
        if (!isAlertDismissedForCycle(cycle.key, aid)) {
          alertHtml.push(`<div class="alert ${card.debt >= card.limit ? 'red' : ''} alert-dismissible"><span>💳 Cartão <b>${esc(card.name)}</b> com ${Math.round(card.pct)}% do plafond utilizado (${eur(card.debt)} / ${eur(card.limit)}).</span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta até ao ciclo seguinte" aria-label="Fechar alerta">✕</button></div>`);
        }
      }
    }

    const todayIso = iso();
    if (todayIso >= cycle.start && todayIso <= cycle.end) {
      const todayMs = new Date(`${todayIso}T00:00:00`).getTime();
      const dueSoon = [];
      for (const r of (state.recurring_expenses || [])) {
        if (r.deleted_at || r.active === false) continue;
        const cpMap = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
        const entry = cpMap[cycle.key] || {};
        if (entry.paid) continue;
        const dueDate = getSuggestedEncargoDate(cycle, r.day_of_month);
        const dueMs = new Date(`${dueDate}T00:00:00`).getTime();
        const diffDays = Math.round((dueMs - todayMs) / (1000 * 60 * 60 * 24));
        if (diffDays <= 5) {
          const amt = entry.amount !== undefined && entry.amount !== null && entry.amount !== '' ? Number(entry.amount) : (Number(r.amount) || 0);
          dueSoon.push({ r, dueDate, diffDays, amt });
        }
      }
      if (dueSoon.length > 0) {
        const aid = `encargos-due:${cycle.key}:${dueSoon.map(x => x.r.id).join(',')}`;
        if (!isAlertDismissedForCycle(cycle.key, aid)) {
          const summaryNames = dueSoon
            .slice(0, 3)
            .map(x => `${esc(x.r.description)} (${x.diffDays < 0 ? `dia ${fmtDate(x.dueDate).slice(0, 5)}` : x.diffDays === 0 ? 'hoje' : `em ${x.diffDays}d`}${x.amt > 0 ? ` · ${eur(x.amt)}` : ''})`)
            .join(', ');
          const extraCnt = dueSoon.length > 3 ? ` e +${dueSoon.length - 3}` : '';
          alertHtml.push(`<div class="alert alert-dismissible"><span>🔁 <b>Encargos por pagar:</b> ${summaryNames}${extraCnt}. <button type="button" class="ghost" data-jump-encargos="1" style="padding:2px 8px;font-size:11.5px;margin-left:4px">Abrir Caderno</button></span><button type="button" class="alert-dismiss-btn" data-dismiss-alert="${esc(aid)}" data-dismiss-cycle="${esc(cycle.key)}" title="Ocultar este alerta" aria-label="Fechar alerta">✕</button></div>`);
        }
      }
    }

    $('alerts').innerHTML = alertHtml.join('');
  }

  const catRowsHtml = activeCats.map(c => {
    const paidV = sum(bankExItems.filter(t => t.category === c.name));
    const virtV = sum(ccExpItems.filter(t => t.category === c.name));
    const totalV = paidV + virtV;
    const paidPct = c.budget ? Math.min(100, (paidV / c.budget) * 100) : 0;
    const virtPct = c.budget ? Math.min(Math.max(0, 100 - paidPct), (virtV / c.budget) * 100) : 0;
    const cls = c.budget ? (paidV > c.budget ? 'over' : totalV > c.budget ? 'warn' : paidV >= c.budget * 0.85 ? 'warn' : '') : '';
    const virtualNote = virtV > 0 ? `<span class="barline-virtual-note">+ ${eur(virtV)} virtual (créd.)</span>` : '';
    return `<div class="barline">
      <span class="barline-name" title="${esc(c.name)}">${esc(c.name)}</span>
      <div class="bar-dual" title="Pago em conta: ${eur(paidV)}${virtV > 0 ? ` · Virtual a crédito: ${eur(virtV)}` : ''}">
        <i class="bar-paid ${cls}" style="width:${paidPct}%"></i>
        ${virtPct > 0 ? `<i class="bar-virtual" style="width:${virtPct}%"></i>` : ''}
      </div>
      <span class="barline-val barline-val-stack"><b>${eur(paidV)}</b> / ${Math.round(c.budget)}€${virtualNote}</span>
    </div>`;
  });

  if (ccPayTotal > 0) {
    catRowsHtml.push(`<div class="barline" style="padding-top:6px;border-top:1px dashed var(--line)">
      <span class="barline-name" title="Pagamento de cartão de crédito">💳 Pagamento cartão</span>
      <div class="bar-dual"><i class="bar-paid" style="width:100%"></i></div>
      <span class="barline-val barline-val-stack"><b>${eur(ccPayTotal)}</b> <span class="small">pago</span></span>
    </div>`);
  }

  $('cats').innerHTML = catRowsHtml.join('');
  const donutSlices = activeCats
    .map(c => ({
      name: c.name,
      value: sum(bankExItems.filter(t => t.category === c.name)) + sum(ccExpItems.filter(t => t.category === c.name))
    }))
    .filter(s => s.value > 0)
    .sort((a, b) => b.value - a.value);
  if (ccPayTotal > 0) donutSlices.push({ name: 'Pagamento cartão', value: ccPayTotal });
  const donutGrandTotal = donutSlices.reduce((acc, s) => acc + s.value, 0);
  drawResumoDonutChart(donutSlices, donutGrandTotal);

  const totalDebt = ccStats.reduce((a, c) => a + c.debt, 0);
  if ($('creditCardsSummaryCard')) {
    $('creditCardsSummaryCard').hidden = ccStats.length === 0;
    $('ccTotalDebtBadge').textContent = `${eur(totalDebt)} em dívida`;
    $('creditCardsSummary').innerHTML = ccStats
      .map(
        c =>
          `<div class="item row"><div><b>💳 ${esc(c.name)}</b><div class="small">${c.limit > 0 ? `Plafond ${eur(c.limit)}` : 'Sem limite definido'}</div></div><b class="${c.debt > 0 ? 'minus' : 'plus'}">${eur(c.debt)}</b></div>`
      )
      .join('');
  }
  if ($('ccManagerTotalBadge')) $('ccManagerTotalBadge').textContent = `Dívida total: ${eur(totalDebt)}`;
  if ($('creditCardList')) {
    $('creditCardList').innerHTML = ccStats.length
      ? ccStats
          .map(
            c =>
              `<div class="item row"><div><b>💳 ${esc(c.name)}</b><div class="small">${c.limit > 0 ? `Plafond ${eur(c.limit)} · ` : ''}Dívida atual: <b>${eur(c.debt)}</b></div></div><div class="row" style="gap:6px"><button type="button" class="ghost" style="padding:5px 9px;font-size:12px" data-edit-cc="${esc(c.id)}" title="Editar cartão">✎</button><button type="button" class="danger" data-del-cc="${esc(c.id)}">Remover</button></div></div>`
          )
          .join('')
      : '<div class="empty">Sem cartões configurados.</div>';
  }

  const activeGoals = (state.savings_goals || []).filter(g => !g.deleted_at);
  if ($('goalCount')) $('goalCount').textContent = `${activeGoals.length} ativo(s)`;
  if ($('goalsSummary')) {
    $('goalsSummary').innerHTML = activeGoals.length
      ? activeGoals
          .map(g => {
            const saved = goalTotal(state, g.id);
            const pct = g.target > 0 ? Math.min(100, (saved / g.target) * 100) : 0;
            return `<div class="item"><div class="row"><b>${esc(g.name)}</b><span class="small">${eur(saved)} / ${eur(g.target)} (${Math.round(pct)}%)</span></div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
          })
          .join('')
      : '<div class="empty">Ainda sem objetivos de poupança.</div>';
  }

  if (selectedGoalId && !activeGoals.some(g => String(g.id) === String(selectedGoalId))) {
    selectedGoalId = null;
  }

  $('goalList').innerHTML = activeGoals.length
    ? activeGoals
        .map(g => {
          const saved = goalTotal(state, g.id);
          const pct = g.target > 0 ? Math.min(100, (saved / g.target) * 100) : 0;
          const isSel = String(selectedGoalId) === String(g.id);
          const txCount = (state.transactions || []).filter(t => !t.deleted_at && String(t.goal_id) === String(g.id)).length;
          return `<div class="card goal-card-clickable${isSel ? ' is-selected-goal' : ''}" data-select-goal="${esc(g.id)}" title="Clica para ver os movimentos deste objetivo"><div class="row"><b>${esc(g.name)}</b><div class="row" style="gap:6px"><span class="pill">${Math.round(pct)}%</span><button type="button" class="ghost" style="padding:5px 9px;font-size:12px" data-edit-goal="${esc(g.id)}" title="Editar objetivo">✎</button><button type="button" class="danger" data-del-goal="${esc(g.id)}" title="Eliminar objetivo">×</button></div></div><div class="small">${eur(saved)} / ${eur(g.target)}${g.deadline ? ` · Meta: ${fmtDate(g.deadline)}` : ''} · ${txCount} mov.</div><div class="progress"><i style="width:${pct}%"></i></div></div>`;
        })
        .join('')
    : '<div class="card empty">Ainda não existem objetivos de poupança.</div>';

  renderGoalMovementsPanel(activeGoals);

  const recent = [...tx]
    .sort((a, b) => b.date.localeCompare(a.date) || Number(b.updated_at || 0) - Number(a.updated_at || 0))
    .slice(0, 10);
  $('recent').innerHTML = recent.length
    ? recent.map(renderTxRow).join('')
    : '<div class="empty">Ainda sem movimentos neste ciclo.</div>';

  renderFilteredTransactions(cycles);
  renderQuickTemplates();

  const catsHtml = activeCats.map(c => `<option value="${esc(c.name)}">${esc(c.name)}</option>`).join('');
  $('category').innerHTML = catsHtml;
  if ($('qCategory')) $('qCategory').innerHTML = catsHtml;
  if ($('recurrenceCategory')) $('recurrenceCategory').innerHTML = catsHtml;
  if ($('simCategory')) $('simCategory').innerHTML = catsHtml;
  $('filterCategory').innerHTML = '<option value="all">Todas as categorias</option>' + catsHtml;

  populateCreditCardSelects();
  if ($('qCard')) {
    const activeCards = (state.credit_cards || []).filter(c => !c.deleted_at);
    $('qCard').innerHTML = '<option value="">Conta / Débito</option>' +
      activeCards.map(c => `<option value="${esc(c.id)}">💳 ${esc(c.name)}</option>`).join('');
  }
  if ($('qDate') && !$('qDate').value) $('qDate').value = iso();

  $('savingGoal').innerHTML =
    '<option value="">Sem objetivo</option>' + activeGoals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');

  if ($('newRuleCategory')) {
    const prevRuleCat = $('newRuleCategory').value;
    $('newRuleCategory').innerHTML = catsHtml;
    if (prevRuleCat && activeCats.some(c => c.name === prevRuleCat)) $('newRuleCategory').value = prevRuleCat;
  }

  $('budgetFields').innerHTML = activeCats
    .map(
      (c, idx) =>
        `<div class="item row cat-edit-row" style="gap:8px;flex-wrap:nowrap">
          <div class="row" style="gap:4px;flex:1 1 auto;min-width:0">
            <button type="button" class="cat-order-btn" data-move-cat="${esc(c.id)}" data-dir="-1" ${idx === 0 ? 'disabled' : ''} title="Subir categoria">↑</button>
            <button type="button" class="cat-order-btn" data-move-cat="${esc(c.id)}" data-dir="1" ${idx === activeCats.length - 1 ? 'disabled' : ''} title="Descer categoria">↓</button>
            <input data-cat-name-id="${esc(c.id)}" type="text" maxlength="50" value="${esc(c.name)}" style="flex:1 1 auto;min-width:95px;padding:7px 9px;font-weight:600">
          </div>
          <div class="row" style="gap:6px;flex-shrink:0">
            <input data-cat-budget-id="${esc(c.id)}" type="number" min="0" step="0.01" value="${Number(c.budget) || 0}" style="width:96px;text-align:right;padding:7px 8px">
            <button type="button" class="danger" data-del-cat="${esc(c.id)}" title="Apagar categoria" style="padding:7px 10px;font-size:13px">🗑️</button>
          </div>
        </div>`
    )
    .join('');
  $('budgetTotal').textContent = eur(totalBudget);

  renderCategoryRules();

  if ($('userName')) $('userName').value = state.household.adult1_name || '';
  if ($('cycleGroupingDays')) $('cycleGroupingDays').value = state.household.cycle_grouping_days ?? 14;

  renderRecurringSection();
  drawSavingsChart(state);
}

function renderFilteredTransactions(cycles) {
  let list = state.transactions.filter(t => !t.deleted_at);
  if (movementCycleKey && movementCycleKey !== 'all') {
    const cy = cycles.find(c => c.key === movementCycleKey);
    if (cy) list = list.filter(t => t.date >= cy.start && t.date <= cy.end);
  }

  const tp = $('filter').value;
  if (tp === 'expense') list = list.filter(t => t.type === 'expense');
  else if (tp === 'cc_expense') list = list.filter(t => t.type === 'expense' && t.credit_card_id);
  else if (tp !== 'all') list = list.filter(t => t.type === tp);

  const df = $('filterDateFrom').value;
  const dt = $('filterDateTo').value;
  if (df) list = list.filter(t => t.date >= df);
  if (dt) list = list.filter(t => t.date <= dt);

  const q = $('filterSearch').value.trim().toLowerCase();
  if (q) list = list.filter(t => String(t.description || '').toLowerCase().includes(q));

  const cat = $('filterCategory').value;
  if (cat !== 'all') list = list.filter(t => t.category === cat);

  if (quickStatusFilter === 'pending') list = list.filter(t => t.status === 'pending');
  else if (quickStatusFilter === 'skipped') list = list.filter(t => t.status === 'skipped');
  else if (quickStatusFilter === 'installments') list = list.filter(t => !!t.installment_group_id);

  const sortDir = $('movementSortOrder') ? $('movementSortOrder').value : 'desc';
  list.sort((a, b) => {
    const cmp = String(a.date || '').localeCompare(String(b.date || ''));
    if (cmp !== 0) return sortDir === 'asc' ? cmp : -cmp;
    const ua = Number(a.updated_at || 0);
    const ub = Number(b.updated_at || 0);
    return sortDir === 'asc' ? ua - ub : ub - ua;
  });

  const hasFilters = tp !== 'all' || df || dt || q || cat !== 'all' || quickStatusFilter !== 'all';
  $('resetFiltersBtn').hidden = !hasFilters;
  $('filterCountLabel').textContent = `${list.length} movimento(s) · Total: ${eur(sum(list))}`;

  $('transactions').innerHTML = list.length
    ? list.map(renderTxRow).join('')
    : '<div class="empty">Nenhum movimento encontrado com estes filtros.</div>';
}

function renderTxRow(t) {
  const isProj = !!t.isProjected;
  const isVirtualCc = t.type === 'expense' && !!t.credit_card_id;
  const cls = t.type === 'income'
    ? 'plus'
    : isVirtualCc
      ? 'virtual-cc'
      : t.type === 'saving_withdraw' || t.type === 'transfer'
        ? 'neutral'
        : 'minus';
  const sign = t.type === 'income'
    ? '+'
    : t.type === 'saving'
      ? '↗'
      : t.type === 'saving_withdraw'
        ? '↙'
        : t.type === 'transfer'
          ? '⇄'
          : isVirtualCc
            ? '💳'
            : '−';
  const ccBadge = isVirtualCc
    ? '<span class="pill-virtual">Virtual · Cartão</span>'
    : t.type === 'cc_payment'
      ? ' · 💳 Pagamento de cartão'
      : '';
  const transferInfo = t.type === 'transfer' && t.person && t.person.includes('→') ? ` · ${esc(t.person)}` : '';
  const statusTag = isProj ? ' · 📋 Caderno de encargos' : t.status === 'pending' ? ' · ⏳ Pendente' : t.status === 'skipped' ? ' · 🚫 Ignorado' : '';
  const clickAttr = isProj ? '' : `data-open-tx="${esc(t.id)}"`;
  const rowCls = isProj
    ? 'item row tx-row-projected'
    : isVirtualCc
      ? 'item row tx-clickable tx-row-virtual-cc'
      : 'item row tx-clickable';
  return `<div class="${rowCls}" ${clickAttr}>
    <div style="min-width:0;flex:1">
      <b>${esc(t.description)}</b>${ccBadge}
      <div class="small">${fmtDate(t.date)} · ${esc(t.category)}${transferInfo}${statusTag}</div>
    </div>
    <b class="amount ${cls}" style="white-space:nowrap">${sign} ${eur(t.amount)}</b>
  </div>`;
}

function renderCategoryRules() {
  const listEl = $('categoryRulesList');
  const badgeEl = $('autoRulesCountBadge');
  if (!listEl) return;
  const rules = (state.meta?.category_rules || []).slice().sort((a, b) => (b.hits || 0) - (a.hits || 0));
  if (badgeEl) badgeEl.textContent = `${rules.length} regra(s)`;
  if (!rules.length) {
    listEl.innerHTML = '<div class="empty">Ainda sem regras aprendidas ou personalizadas.</div>';
    return;
  }
  listEl.innerHTML = rules
    .map(
      (r, idx) => `<div class="item row" style="gap:8px">
        <div style="min-width:0;flex:1">
          <b>${esc(r.keyword)}</b> → <span class="pill">${esc(r.category)}</span>
          ${r.hits ? `<span class="small" style="margin-left:6px">(${r.hits}x)</span>` : ''}
        </div>
        <button type="button" class="danger" data-del-cat-rule="${idx}" title="Apagar regra">×</button>
      </div>`
    )
    .join('');
}

function renderQuickTemplates() {
  const counts = new Map();
  for (const t of state.transactions) {
    if (t.deleted_at || t.type !== 'expense') continue;
    const key = `${t.description.trim()}|${t.category}`;
    const prev = counts.get(key) || { desc: t.description.trim(), category: t.category, amount: t.amount, n: 0 };
    prev.n++;
    prev.amount = t.amount;
    counts.set(key, prev);
  }
  const top = [...counts.values()].filter(x => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 4);
  if (!$('quickTemplatesBar')) return;
  $('quickTemplatesBar').hidden = top.length === 0;
  $('quickTemplatesList').innerHTML = top
    .map(
      (x, idx) =>
        `<button type="button" class="tpl-chip" data-tpl-idx="${idx}">${esc(x.desc)} (${eur(x.amount)})</button>`
    )
    .join('');
  $('quickTemplatesList')._items = top;
}

function renderRecurringSection() {
  const cycles = buildCycles(state);
  const activeCycle = cycles.find(c => c.key === encargosCycleKey) || cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
  if (activeCycle) encargosCycleKey = activeCycle.key;

  const cycleSel = $('encargosCycleSelect');
  if (cycleSel && activeCycle) {
    cycleSel.innerHTML = cycles
      .slice()
      .reverse()
      .map(c => `<option value="${esc(c.key)}">${esc(c.monthLabel)} (${fmtDate(c.start)} – ${fmtDate(c.end)})</option>`)
      .join('');
    cycleSel.value = activeCycle.key;
  }

  const rules = (state.recurring_expenses || []).filter(r => !r.deleted_at && r.active !== false);
  const cycleKey = activeCycle ? activeCycle.key : currentMonth();

  let paidCount = 0;
  let totalPaid = 0;
  let totalExpected = 0;

  const checklistEl = $('encargosChecklist');
  if (checklistEl) {
    if (!rules.length) {
      checklistEl.innerHTML = '<div class="empty">Ainda não tens fornecedores ou serviços no caderno de encargos. Toca em <b>+ Novo serviço</b> para adicionar.</div>';
    } else {
      checklistEl.innerHTML = rules
        .map(r => {
          const cpMap = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
          const entry = cpMap[cycleKey] || {};
          const isDone = !!entry.paid;
          const amountVal = entry.amount !== undefined && entry.amount !== null && entry.amount !== ''
            ? Number(entry.amount)
            : (Number(r.amount) || 0);
          const dateVal = entry.paidDate || getSuggestedEncargoDate(activeCycle, r.day_of_month);

          totalExpected += amountVal;
          if (isDone) {
            paidCount++;
            totalPaid += amountVal;
          }

          const entityHtml = r.entity
            ? `<button type="button" class="mb-copy-chip" data-copy-mb="${esc(r.entity)}" title="Copiar Entidade">Entidade: <b>${esc(r.entity)}</b> 📋</button>`
            : '';
          const refHtml = r.payment_ref
            ? `<button type="button" class="mb-copy-chip" data-copy-mb="${esc(r.payment_ref)}" title="Copiar Referência">Ref.: <b>${esc(r.payment_ref)}</b> 📋</button>`
            : '';

          return `<div class="encargo-card ${isDone ? 'is-paid' : ''}" data-encargo-id="${esc(r.id)}">
            <div class="encargo-header">
              <div style="min-width:0;flex:1">
                <button type="button" class="encargo-title-btn" data-open-encargo="${esc(r.id)}">
                  <span>${esc(r.description)}</span>
                  <span style="font-size:12px;opacity:0.65">ⓘ</span>
                </button>
                <div class="small">${esc(r.category)} · Dia habitual: ${r.day_of_month}</div>
              </div>
              <span class="pill" style="cursor:pointer" data-open-encargo="${esc(r.id)}">${isDone ? '✅ Pago' : '⏳ Por pagar'}</span>
            </div>
            ${entityHtml || refHtml ? `<div class="encargo-mb-row">${entityHtml}${refHtml}</div>` : ''}
            <div class="encargo-controls">
              <div>
                <div class="small" style="margin-bottom:2px">Valor (€)</div>
                <input type="number" step="0.01" min="0" data-encargo-amount="${esc(r.id)}" value="${amountVal > 0 ? amountVal.toFixed(2) : ''}" placeholder="0,00">
              </div>
              <div>
                <div class="small" style="margin-bottom:2px">Data pagamento</div>
                <input type="date" data-encargo-date="${esc(r.id)}" value="${esc(dateVal)}">
              </div>
              <label class="encargo-paid-toggle">
                <input type="checkbox" data-encargo-paid="${esc(r.id)}" ${isDone ? 'checked' : ''}>
                <span>Pago</span>
              </label>
            </div>
          </div>`;
        })
        .join('');
    }
  }

  const unpaidCount = Math.max(0, rules.length - paidCount);
  if ($('encargosProgressBadge')) $('encargosProgressBadge').textContent = `${paidCount} / ${rules.length} pagos`;
  if ($('encargosCycleTotals')) $('encargosCycleTotals').textContent = `${eur(totalPaid)} pago / ${eur(totalExpected)} total`;

  ['mobileMoreBadge', 'drawerRecBadge', 'desktopRecBadge'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.hidden = unpaidCount === 0;
    el.textContent = unpaidCount;
  });
}

function renderGoalMovementsPanel(activeGoals) {
  const cardEl = $('goalMovementsCard');
  const titleEl = $('goalMovementsTitle');
  const subEl = $('goalMovementsSubtitle');
  const sumEl = $('goalMovementsSummary');
  const listEl = $('goalMovementsList');
  const quickBtn = $('goalQuickMoveBtn');
  const allBtn = $('goalShowAllMovesBtn');
  if (!cardEl || !listEl) return;

  if (!activeGoals || !activeGoals.length) {
    cardEl.hidden = true;
    return;
  }
  cardEl.hidden = false;

  const selGoal = selectedGoalId
    ? activeGoals.find(g => String(g.id) === String(selectedGoalId))
    : null;

  const goalNameById = new Map(activeGoals.map(g => [String(g.id), g.name]));
  const matchingTx = (state.transactions || [])
    .filter(t => {
      if (t.deleted_at || !t.goal_id) return false;
      if (selGoal) return String(t.goal_id) === String(selGoal.id);
      return goalNameById.has(String(t.goal_id));
    })
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || Number(b.updated_at || 0) - Number(a.updated_at || 0));

  if (selGoal) {
    titleEl.textContent = `Movimentos — ${selGoal.name}`;
    subEl.textContent = `${matchingTx.length} movimento(s) registado(s) neste objetivo`;
    if (quickBtn) quickBtn.hidden = false;
    if (allBtn) allBtn.hidden = activeGoals.length <= 1;
  } else {
    titleEl.textContent = 'Todos os movimentos de objetivos';
    subEl.textContent = 'Clica num cartão de objetivo acima para filtrar';
    if (quickBtn) quickBtn.hidden = true;
    if (allBtn) allBtn.hidden = true;
  }

  if (!matchingTx.length) {
    if (sumEl) {
      sumEl.hidden = true;
      sumEl.innerHTML = '';
    }
    listEl.innerHTML = selGoal
      ? `<div class="empty">Ainda não existem reforços nem resgates associados a <b>${esc(selGoal.name)}</b>.</div>`
      : '<div class="empty">Ainda não existem movimentos associados aos teus objetivos de poupança.</div>';
    return;
  }

  const totalAdded = matchingTx.filter(t => t.type === 'saving').reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const totalWithdrawn = matchingTx.filter(t => t.type === 'saving_withdraw').reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const netSaved = totalAdded - totalWithdrawn;

  if (sumEl) {
    sumEl.hidden = false;
    sumEl.innerHTML = `
      <div class="day-sum-pill"><span class="small">Total reforçado</span><b class="plus">+${eur(totalAdded)}</b></div>
      <div class="day-sum-pill"><span class="small">Utilizado / Resgate</span><b class="minus">−${eur(totalWithdrawn)}</b></div>
      <div class="day-sum-pill"><span class="small">Saldo acumulado</span><b class="${netSaved >= 0 ? 'plus' : 'minus'}">${eur(netSaved)}</b></div>
    `;
  }

  listEl.innerHTML = `<div class="tx-list-scroll">${matchingTx.map(renderTxRow).join('')}</div>`;
}

function renderCalendar() {
  if ($('calendarMonth')) $('calendarMonth').value = calendarMonthStr;
  const [y, m] = calendarMonthStr.split('-').map(Number);
  const title = new Date(y, m - 1, 2).toLocaleDateString('pt-PT', { month: 'long', year: 'numeric' });
  $('calTitle').textContent = title.charAt(0).toUpperCase() + title.slice(1);

  const firstDay = new Date(y, m - 1, 1).getDay();
  const offset = firstDay === 0 ? 6 : firstDay - 1;
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = iso();
  const projectedMonthEvents = getProjectedCalendarEvents(state, calendarMonthStr);

  const weekHeaders = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map(d => `<div class="cal-head">${d}</div>`).join('');

  let cells = '';
  for (let i = 0; i < offset; i++) cells += '<div class="cal-day is-empty"></div>';

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${calendarMonthStr}-${String(d).padStart(2, '0')}`;
    const realTx = state.transactions.filter(t => !t.deleted_at && t.date === dateStr);
    const projTx = projectedMonthEvents.filter(p => p.date === dateStr);
    const hasFutureScheduled = realTx.some(t => t.date > today);
    const hasExp = realTx.some(t => t.type === 'expense' && t.date <= today);
    const hasInc = realTx.some(t => t.type === 'income');
    const hasSav = realTx.some(t => t.type === 'saving' || t.type === 'saving_withdraw');
    const hasProj = projTx.length > 0 || hasFutureScheduled;
    const dots =
      (hasExp ? '<i class="dot dot-exp"></i>' : '') +
      (hasInc ? '<i class="dot dot-inc"></i>' : '') +
      (hasSav ? '<i class="dot dot-sav"></i>' : '') +
      (hasProj ? '<i class="dot dot-proj"></i>' : '');
    const cls = `cal-day${dateStr === today ? ' is-today' : ''}${dateStr === selectedCalendarDay ? ' is-selected' : ''}${hasProj ? ' has-projected' : ''}`;
    cells += `<div class="${cls}" data-cal-day="${dateStr}"><strong>${d}</strong><div class="cal-dots">${dots}</div></div>`;
  }

  $('calendar').innerHTML = weekHeaders + cells;
  if ($('calScopeToggleBtn')) {
    $('calScopeToggleBtn').textContent = calScopeMode === 'month' ? '📅 Ver só o dia' : '📋 Ver mês inteiro';
  }
  let items = [];
  if (calScopeMode === 'month') {
    $('dayTitle').textContent = `Movimentos de ${title}`;
    const realMonth = state.transactions.filter(t => !t.deleted_at && String(t.date || '').startsWith(calendarMonthStr)).sort((a, b) => a.date.localeCompare(b.date));
    items = [...realMonth, ...projectedMonthEvents].sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')));
  } else {
    $('dayTitle').textContent = `Movimentos de ${fmtDate(selectedCalendarDay)}`;
    const selMonth = selectedCalendarDay.slice(0, 7);
    const selProjected = selMonth === calendarMonthStr
      ? projectedMonthEvents.filter(p => p.date === selectedCalendarDay)
      : getProjectedCalendarEvents(state, selMonth).filter(p => p.date === selectedCalendarDay);
    items = [...state.transactions.filter(t => !t.deleted_at && t.date === selectedCalendarDay), ...selProjected];
  }

  const daySummaryEl = $('daySummary');
  if (daySummaryEl) {
    if (!items.length) {
      daySummaryEl.hidden = true;
      daySummaryEl.innerHTML = '';
    } else {
      const validItems = items.filter(t => t.status !== 'skipped');
      const dayInc = sum(validItems.filter(t => t.type === 'income'));
      const dayExp = sum(validItems.filter(t => t.type === 'expense'));
      const dayNet = dayInc - dayExp;
      daySummaryEl.hidden = false;
      daySummaryEl.innerHTML = `
        <div class="day-sum-pill"><span class="small">Receitas</span><b class="plus">+${eur(dayInc)}</b></div>
        <div class="day-sum-pill"><span class="small">Despesas</span><b class="minus">−${eur(dayExp)}</b></div>
        <div class="day-sum-pill"><span class="small">${calScopeMode === 'month' ? 'Saldo do mês' : 'Saldo do dia'}</span><b class="${dayNet > 0 ? 'plus' : dayNet < 0 ? 'minus' : ''}">${dayNet > 0 ? '+' : ''}${eur(dayNet)}</b></div>
      `;
    }
  }

  $('dayItems').innerHTML = items.length ? items.map(renderTxRow).join('') : calScopeMode === 'month' ? '<div class="empty">Sem movimentos neste mês.</div>' : '<div class="empty">Sem movimentos neste dia.</div>';
}

function openTxDetailModal(txId) {
  const tx = state.transactions.find(t => String(t.id) === String(txId));
  if (!tx) return;
  $('modalTxId').value = tx.id;
  $('txModalReadView').hidden = false;
  $('txModalEditForm').hidden = true;

  const typeLabels = {
    expense: 'Despesa',
    cc_payment: 'Pagamento de cartão de crédito',
    income: 'Rendimento',
    saving: 'Poupança transferida',
    saving_withdraw: 'Resgate de poupança',
    transfer: 'Transferência interna entre contas'
  };
  const icons = { expense: '💸', cc_payment: '💳', income: '💰', saving: '🎯', saving_withdraw: '🏦', transfer: '🔁' };
  $('txModalIcon').textContent = icons[tx.type] || '🧾';
  $('txModalAmountDisplay').textContent = eur(tx.amount);
  $('txModalAmountDisplay').className = 'tx-modal-amount ' + (tx.type === 'income' ? 'plus' : tx.type === 'expense' ? 'minus' : 'neutral');
  $('txModalDescDisplay').textContent = tx.description;
  $('txModalDateDisplay').textContent = fmtDate(tx.date);
  $('txModalTypeDisplay').textContent = typeLabels[tx.type] || tx.type;
  $('txModalCatDisplay').textContent = tx.category;
  $('txModalSubtitle').textContent = tx.status === 'pending' ? 'Estado: Pendente' : 'Estado: Confirmado';

  if ($('txModalExtraRow')) {
    if (tx.type === 'transfer' && tx.person) {
      $('txModalExtraRow').hidden = false;
      $('txModalExtraLabel').textContent = 'Movimentação';
      $('txModalExtraDisplay').textContent = tx.person;
    } else {
      $('txModalExtraRow').hidden = true;
    }
  }

  const instBox = $('txModalInstallmentBox');
  if (instBox) {
    if (tx.installment_group_id) {
      const today = iso();
      const groupTxs = state.transactions.filter(t => !t.deleted_at && t.installment_group_id === tx.installment_group_id).sort((a, b) => a.date.localeCompare(b.date));
      const futureTxs = groupTxs.filter(t => t.date > today);
      const paidCount = groupTxs.length - futureTxs.length;
      const remainingTotal = sum(futureTxs);
      instBox.hidden = false;
      $('txModalInstProgressBadge').textContent = `${paidCount}/${groupTxs.length} pagas`;
      $('txModalInstSummaryText').textContent = futureTxs.length
        ? `Faltam ${futureTxs.length} prestação(ões) futura(s) · Total em dívida: ${eur(remainingTotal)}`
        : 'Todas as prestações deste plano já venceram.';
      $('txModalSettleInstBtn').hidden = futureTxs.length === 0;
      $('txModalDeleteFutureInstBtn').hidden = futureTxs.length === 0;
    } else {
      instBox.hidden = true;
    }
  }

  $('txDetailModal').hidden = false;
}

function populateCreditCardSelects(selectedCardId = null) {
  const cards = (state.credit_cards || []).filter(c => !c.deleted_at);
  const methodHtml =
    '<option value="bank">Conta à ordem / Débito / Dinheiro</option>' +
    cards.map(c => `<option value="cc:${esc(c.id)}">💳 ${esc(c.name)} (dívida: ${eur(computeCreditCardDebt(state, c))})</option>`).join('');
  const paymentHtml =
    '<option value="">Selecionar cartão…</option>' +
    cards.map(c => `<option value="${esc(c.id)}">💳 ${esc(c.name)} (dívida: ${eur(computeCreditCardDebt(state, c))})</option>`).join('');

  if ($('paymentMethod')) {
    const prev = $('paymentMethod').value;
    $('paymentMethod').innerHTML = methodHtml;
    if (prev && Array.from($('paymentMethod').options).some(o => o.value === prev)) $('paymentMethod').value = prev;
  }
  if ($('ccPaymentCard')) {
    const prev = $('ccPaymentCard').value;
    $('ccPaymentCard').innerHTML = paymentHtml;
    if (prev && Array.from($('ccPaymentCard').options).some(o => o.value === prev)) $('ccPaymentCard').value = prev;
    else if (cards.length === 1) $('ccPaymentCard').value = String(cards[0].id);
  }
  if ($('modalEditPaymentMethod')) {
    $('modalEditPaymentMethod').innerHTML = methodHtml;
    $('modalEditPaymentMethod').value = selectedCardId ? `cc:${selectedCardId}` : 'bank';
  }
  if ($('modalEditCcPaymentCard')) {
    const prevModal = $('modalEditCcPaymentCard').value;
    $('modalEditCcPaymentCard').innerHTML = paymentHtml;
    const targetVal = selectedCardId || prevModal || (cards.length === 1 ? String(cards[0].id) : '');
    if (targetVal && Array.from($('modalEditCcPaymentCard').options).some(o => String(o.value) === String(targetVal))) {
      $('modalEditCcPaymentCard').value = String(targetVal);
    }
  }
}

function switchModalToEdit() {
  const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
  if (!tx) return;
  $('txModalReadView').hidden = true;
  $('txModalEditForm').hidden = false;

  $('modalEditDate').value = tx.date;
  $('modalEditType').value = tx.type;
  $('modalEditDesc').value = tx.description;
  $('modalEditAmount').value = tx.amount;
  $('modalEditCat').innerHTML = $('category').innerHTML;
  $('modalEditCat').value = tx.category;
  $('modalEditCountsCycle').checked = tx.counts_for_cycle !== false;

  if ($('modalEditTransferFrom') && $('modalEditTransferTo')) {
    const parts = String(tx.person || '').split('→').map(s => s.trim());
    $('modalEditTransferFrom').value = parts[0] || 'Conta Principal';
    $('modalEditTransferTo').value = parts[1] || 'Conta Poupança';
  }

  populateCreditCardSelects(tx.credit_card_id || null);
  $('modalEditGoal').innerHTML = $('savingGoal').innerHTML;
  $('modalEditGoal').value = tx.goal_id || '';
  updateModalEditVisibility();
}

function updateModalEditVisibility() {
  const tp = $('modalEditType').value;
  if (tp === 'cc_payment' || tp === 'expense') {
    const curVal = tp === 'cc_payment'
      ? $('modalEditCcPaymentCard').value
      : ($('modalEditPaymentMethod').value.startsWith('cc:') ? $('modalEditPaymentMethod').value.slice(3) : null);
    populateCreditCardSelects(curVal || null);
  }
  $('modalEditCatWrap').hidden = tp !== 'expense';
  $('modalEditPaymentMethodWrap').hidden = tp !== 'expense';
  $('modalEditCcPaymentWrap').hidden = tp !== 'cc_payment';
  $('modalEditGoalWrap').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
  $('modalEditIncomeCycleWrap').hidden = tp !== 'income';
  if ($('modalEditTransferWrap')) $('modalEditTransferWrap').hidden = tp !== 'transfer';
}

function runImpactSimulator() {
  const amount = Number($('simAmount').value) || 0;
  const n = Math.max(1, Number($('simInstallments').value) || 1);
  const desc = $('simDesc').value.trim() || 'Compra simulada';
  const box = $('simResultBox');
  const actions = $('simActions');
  if (amount <= 0) {
    box.hidden = true;
    actions.hidden = true;
    return;
  }
  const perMonth = amount / n;
  const cycles = buildCycles(state);
  const cur = currentCycle(cycles);
  const curBal = computeCycleBalance(state, cur, iso());
  const newBal = curBal - perMonth;

  box.hidden = false;
  actions.hidden = false;
  box.innerHTML = `
    <div><strong>${esc(desc)}</strong>: ${n > 1 ? `${n}x de <b>${eur(perMonth)}</b>/ciclo` : `<b>${eur(amount)}</b> a pronto`}</div>
    <div style="margin-top:6px">Saldo atual do ciclo: <b>${eur(curBal)}</b> → Após impacto: <b class="${newBal < 0 ? 'minus' : 'plus'}">${eur(newBal)}</b></div>
  `;
}

async function initStorageProtectionAndBackupReminder() {
  const statusEl = $('storagePersistenceStatus');
  const reminderEl = $('backupReminderLine');
  const lastBackup = localStorage.getItem('unofin_last_backup_date');

  if (reminderEl) {
    if (!lastBackup) {
      reminderEl.textContent = '⚠️ Ainda não fizeste nenhuma cópia de segurança JSON neste dispositivo.';
    } else {
      const days = Math.floor((Date.now() - new Date(lastBackup).getTime()) / (1000 * 60 * 60 * 24));
      if (days === 0) reminderEl.textContent = '✅ Última cópia de segurança exportada hoje.';
      else if (days >= 30) {
        reminderEl.style.color = 'var(--amber)';
        reminderEl.textContent = `⚠️ Última cópia de segurança há ${days} dias (${fmtDate(lastBackup.slice(0, 10))}). Recomendamos exportar um novo ficheiro JSON.`;
      } else {
        reminderEl.textContent = `ℹ️ Última cópia de segurança há ${days} dia(s) (${fmtDate(lastBackup.slice(0, 10))}).`;
      }
    }
  }

  if (!statusEl) return;
  let persisted = false;
  if (navigator.storage && navigator.storage.persist) {
    try {
      persisted = await navigator.storage.persisted();
      if (!persisted) persisted = await navigator.storage.persist();
    } catch (_) {}
  }

  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone && persisted) {
    statusEl.className = 'alert good';
    statusEl.innerHTML = '📱 <b>App instalada com armazenamento protegido:</b> Os teus dados estão guardados localmente e protegidos contra limpeza automática.';
  } else {
    statusEl.className = 'alert';
    statusEl.innerHTML = '💾 <b>Modo 100% Local:</b> Os dados ficam guardados apenas neste navegador. Instala a app no ecrã principal e exporta cópias JSON periodicamente.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  applyThemeAndDensity(() => drawSavingsChart(state));
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyThemeAndDensity(() => drawSavingsChart(state)));
  }

  $('date').value = iso();

  $('themeQuickToggleBtn').onclick = () => {
    const order = ['auto', 'light', 'dark'];
    const cur = loadUiPrefs().theme || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    saveUiPrefs({ theme: next });
    applyThemeAndDensity(() => drawSavingsChart(state));
    showToast(`Tema: ${next === 'dark' ? 'Escuro' : next === 'light' ? 'Claro' : 'Automático'}`);
  };
  $('themeMode').onchange = e => { saveUiPrefs({ theme: e.target.value }); applyThemeAndDensity(() => drawSavingsChart(state)); };
  $('densityMode').onchange = e => { saveUiPrefs({ density: e.target.value }); applyThemeAndDensity(); };

  document.querySelectorAll('nav button[data-tab]').forEach(btn => { btn.onclick = () => switchTab(btn.dataset.tab); });
  $('mobileMoreBtn').onclick = openMobileDrawer;
  $('closeMobileMoreBtn').onclick = closeMobileDrawer;
  $('mobileMoreBackdrop').onclick = closeMobileDrawer;
  document.querySelectorAll('[data-drawer-tab]').forEach(btn => { btn.onclick = () => switchTab(btn.dataset.drawerTab); });

  function openAddTxModal(focusField = true) {
    const modal = $('addTxModal');
    if (!modal) return;
    if (!$('date').value) $('date').value = iso();
    modal.hidden = false;
    if (focusField && $('desc')) setTimeout(() => $('desc').focus(), 40);
  }
  function closeAddTxModal() { if ($('addTxModal')) $('addTxModal').hidden = true; }

  $('quickAddFab').onclick = () => openAddTxModal(true);
  if ($('viewAllCycleTxBtn')) $('viewAllCycleTxBtn').onclick = () => { movementCycleKey = selectedCycleKey || 'all'; switchTab('movimentos'); };
  if ($('goalShowAllMovesBtn')) $('goalShowAllMovesBtn').onclick = () => { selectedGoalId = null; render(); };
  if ($('goalQuickMoveBtn')) {
    $('goalQuickMoveBtn').onclick = () => {
      openAddTxModal(true);
      if ($('type')) { $('type').value = 'saving'; $('type').dispatchEvent(new Event('change')); }
      if ($('savingGoal') && selectedGoalId) $('savingGoal').value = selectedGoalId;
    };
  }
  document.addEventListener('click', e => {
    if (e.target.closest('[data-jump-encargos]')) { encargosCycleKey = selectedCycleKey; switchTab('recorrentes'); }
  });
  if ($('openNewTxModalBtn')) $('openNewTxModalBtn').onclick = () => openAddTxModal(true);
  if ($('closeAddTxModalBtn')) $('closeAddTxModalBtn').onclick = closeAddTxModal;
  if ($('cancelAddTxModalBtn')) $('cancelAddTxModalBtn').onclick = closeAddTxModal;
  if ($('addTxModal')) $('addTxModal').onclick = e => { if (e.target === $('addTxModal')) closeAddTxModal(); };
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && $('addTxModal') && !$('addTxModal').hidden) closeAddTxModal(); });

  document.querySelectorAll('[data-summary-level-btn]').forEach(btn => {
    btn.onclick = () => { saveUiPrefs({ summaryLevel: btn.dataset.summaryLevelBtn }); render(); };
  });

  $('cycleSelect').onchange = e => { selectedCycleKey = e.target.value; movementCycleKey = e.target.value; render(); };
  $('prevCycleBtn').onclick = () => {
    const cycles = buildCycles(state);
    const idx = cycles.findIndex(c => c.key === selectedCycleKey);
    if (idx > 0) { selectedCycleKey = cycles[idx - 1].key; render(); }
  };
  $('nextCycleBtn').onclick = () => {
    const cycles = buildCycles(state);
    const idx = cycles.findIndex(c => c.key === selectedCycleKey);
    if (idx >= 0 && idx < cycles.length - 1) { selectedCycleKey = cycles[idx + 1].key; render(); }
  };
  $('openSimulatorShortcutBtn').onclick = () => { switchTab('orcamento'); $('simDesc').focus(); };

  function markCycleRolloverHandled(cycleKey) {
    state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
    const set = new Set(state.meta.handled_rollovers || []);
    set.add(cycleKey);
    state.meta.handled_rollovers = [...set];
    state.meta.updated_at = Date.now();
    saveLocalState(state);
  }

  function openCloseCycleModal(explicitCycle = null) {
    const cycles = buildCycles(state);
    const cycle = explicitCycle || cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
    $('closeCycleModal').dataset.targetCycleKey = cycle.key;
    const bal = Number(computeCycleBalance(state, cycle, cycle.end).toFixed(2));
    $('closeCycleSubtitle').textContent = `${cycle.monthLabel} (${fmtDate(cycle.start)} a ${fmtDate(cycle.end)})`;

    const alertBox = $('closeCycleAlertBox');
    const expText = $('closeCycleExplanation');
    const posOpts = $('closeCyclePositiveOptions');
    const confirmBtn = $('confirmCloseCycleBtn');

    if (Math.abs(bal) < 0.01) {
      alertBox.className = 'alert good';
      alertBox.innerHTML = 'Saldo final do ciclo: <b>0,00 €</b>';
      expText.textContent = 'Este ciclo está perfeitamente saldado (0,00 €).';
      posOpts.hidden = true;
      confirmBtn.hidden = true;
    } else if (bal < 0) {
      confirmBtn.hidden = false;
      alertBox.className = 'alert red';
      alertBox.innerHTML = `Saldo final negativo: <b>${eur(bal)}</b>`;
      expText.textContent = 'Este défice transitará para o início do ciclo seguinte.';
      posOpts.hidden = true;
    } else {
      confirmBtn.hidden = false;
      alertBox.className = 'alert good';
      alertBox.innerHTML = `Saldo bancário real no fecho (sobra): <b>+${eur(bal)}</b>`;
      expText.textContent = 'Escolhe o destino desta sobra bancária:';
      posOpts.hidden = false;
      const defaultRadio = document.querySelector('input[name="cycleCloseAction"][value="carryover"]');
      if (defaultRadio) defaultRadio.checked = true;
      $('closeCycleGoalWrap').hidden = true;
      const activeGoals = (state.savings_goals || []).filter(g => !g.deleted_at);
      $('closeCycleGoalSelect').innerHTML =
        '<option value="">Poupança geral (sem objetivo específico)</option>' +
        activeGoals.map(g => `<option value="${esc(g.id)}">${esc(g.name)}</option>`).join('');
    }
    $('closeCycleModal').hidden = false;
  }

  window._openCloseCycleModalFor = openCloseCycleModal;
  if ($('closeCycleBtn')) $('closeCycleBtn').onclick = () => openCloseCycleModal();
  function dismissCloseCycleModal() {
    const targetKey = $('closeCycleModal').dataset.targetCycleKey;
    if (targetKey) markCycleRolloverHandled(targetKey);
    $('closeCycleModal').hidden = true;
    rolloverPromptOpen = false;
  }
  if ($('closeCycleModalXBtn')) $('closeCycleModalXBtn').onclick = dismissCloseCycleModal;
  if ($('cancelCloseCycleBtn')) $('cancelCloseCycleBtn').onclick = dismissCloseCycleModal;
  if ($('closeCycleModal')) $('closeCycleModal').onclick = e => { if (e.target === $('closeCycleModal')) dismissCloseCycleModal(); };
  document.querySelectorAll('input[name="cycleCloseAction"]').forEach(radio => {
    radio.onchange = () => { $('closeCycleGoalWrap').hidden = radio.value !== 'savings'; };
  });

  if ($('confirmCloseCycleBtn')) {
    $('confirmCloseCycleBtn').onclick = () => {
      const cycles = buildCycles(state);
      const targetKey = $('closeCycleModal').dataset.targetCycleKey || selectedCycleKey;
      const cycle = cycles.find(c => c.key === targetKey) || currentCycle(cycles);
      const bal = Number(computeCycleBalance(state, cycle, cycle.end).toFixed(2));
      if (Math.abs(bal) < 0.01) { $('closeCycleModal').hidden = true; return; }

      const [ey, em, ed] = cycle.end.split('-').map(Number);
      const nextDayObj = new Date(ey, em - 1, ed + 1);
      const nextCycleStartDate = `${nextDayObj.getFullYear()}-${String(nextDayObj.getMonth() + 1).padStart(2, '0')}-${String(nextDayObj.getDate()).padStart(2, '0')}`;
      const ownerName = getUserDisplayName(state);

      const closureTag = `cycle-close:${cycle.key}`;
      for (const oldTx of state.transactions) {
        if (!oldTx.deleted_at && oldTx.occurrence_key === closureTag) { oldTx.deleted_at = Date.now(); oldTx.updated_at = Date.now(); }
      }

      if (bal < 0) {
        state.transactions.push({
          id: uid('carry'), date: nextCycleStartDate, type: 'expense',
          description: `Saldo negativo transitado (${fmtDate(cycle.start)} – ${fmtDate(cycle.end)})`,
          amount: Math.abs(bal), category: 'Saldo transitado', person: ownerName,
          status: 'confirmed', occurrence_key: closureTag, counts_for_cycle: false, updated_at: Date.now()
        });
        showToast(`Défice de ${eur(bal)} transitado.`, { type: 'success' });
      } else {
        const action = document.querySelector('input[name="cycleCloseAction"]:checked')?.value || 'carryover';
        if (action === 'carryover') {
          state.transactions.push({
            id: uid('carry'), date: nextCycleStartDate, type: 'income',
            description: `Saldo positivo transitado (${fmtDate(cycle.start)} – ${fmtDate(cycle.end)})`,
            amount: bal, category: 'Saldo transitado', person: ownerName,
            status: 'confirmed', occurrence_key: closureTag, counts_for_cycle: false, updated_at: Date.now()
          });
          showToast(`Sobra de +${eur(bal)} transitada!`, { type: 'success' });
        } else {
          const goalId = $('closeCycleGoalSelect').value || null;
          state.transactions.push({
            id: uid('sav-close'), date: cycle.end, type: 'saving',
            description: `Sobra de ciclo transferida para Poupança (${fmtDate(cycle.end)})`,
            amount: bal, category: 'Poupança', person: ownerName, goal_id: goalId,
            status: 'confirmed', occurrence_key: closureTag, counts_for_cycle: false, updated_at: Date.now()
          });
          showToast(`Sobra de +${eur(bal)} atribuída a Poupança!`, { type: 'success' });
        }
      }

      markCycleRolloverHandled(cycle.key);
      saveLocalState(state);
      $('closeCycleModal').hidden = true;
      rolloverPromptOpen = false;
      selectedCycleKey = currentCycle(buildCycles(state)).key;
      render();
    };
  }

  $('amount').oninput = () => {
    const raw = $('amount').value;
    const val = evaluateAmountExpression(raw);
    const badge = $('calcPreviewBadge');
    if (/[+\-*/()]/.test(raw) && Number.isFinite(val)) { badge.hidden = false; badge.textContent = `= ${eur(val)}`; }
    else badge.hidden = true;
  };
  document.querySelectorAll('[data-calc-op]').forEach(btn => {
    btn.onclick = () => { const inp = $('amount'); if (inp) { inp.value += ` ${btn.dataset.calcOp} `; inp.focus(); } };
  });
  $('calcEvalBtn').onclick = () => {
    const val = evaluateAmountExpression($('amount').value);
    if (Number.isFinite(val)) { $('amount').value = val.toFixed(2); $('calcPreviewBadge').hidden = true; }
  };
  if ($('modalCalcEvalBtn')) {
    $('modalCalcEvalBtn').onclick = () => {
      const val = evaluateAmountExpression($('modalEditAmount').value);
      if (Number.isFinite(val)) $('modalEditAmount').value = val.toFixed(2);
    };
  }

  $('type').onchange = () => {
    const tp = $('type').value;
    if (tp === 'cc_payment' || tp === 'expense') populateCreditCardSelects();
    $('categoryField').hidden = tp !== 'expense';
    $('installmentsField').hidden = tp !== 'expense';
    $('expensePaymentMethodField').hidden = tp !== 'expense';
    $('ccPaymentField').hidden = tp !== 'cc_payment';
    $('savingGoalField').hidden = tp !== 'saving' && tp !== 'saving_withdraw';
    $('incomeCycleField').hidden = tp !== 'income';
    if ($('transferAccountsField')) $('transferAccountsField').hidden = tp !== 'transfer';
  };
  $('paymentMethod').onchange = () => { $('expenseCcHint').hidden = !$('paymentMethod').value.startsWith('cc:'); };
  $('isInstallment').onchange = () => { $('installmentsOptions').hidden = !$('isInstallment').checked; };
  $('desc').oninput = () => {
    if ($('type').value === 'expense' && $('desc').value.trim().length >= 3) {
      const guessed = guessCategory(state, $('desc').value);
      $('category').value = guessed;
      $('categoryAutoHint').textContent = `(${guessed})`;
    }
  };

  $('txForm').onsubmit = e => {
    e.preventDefault();
    const rawAmount = evaluateAmountExpression($('amount').value);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) { alert('Introduz um valor válido.'); return; }
    const tp = $('type').value;
    let ccId = null;
    if (tp === 'expense' && $('paymentMethod').value.startsWith('cc:')) ccId = $('paymentMethod').value.slice(3);
    else if (tp === 'cc_payment') {
      ccId = $('ccPaymentCard').value || null;
      if (!ccId) { alert('Seleciona o cartão de crédito.'); return; }
    }

    const isInst = tp === 'expense' && $('isInstallment').checked;
    const count = isInst ? Math.max(2, Math.min(60, Math.round(Number($('installmentCount').value) || 2))) : 1;
    const mode = $('installmentAmountMode').value;
    const groupId = isInst ? uid('inst') : null;
    const baseDate = $('date').value;
    const baseDesc = $('desc').value.trim();
    const ownerName = getUserDisplayName(state);

    for (let i = 0; i < count; i++) {
      let partAmt = rawAmount;
      if (isInst && mode === 'total') {
        const baseCent = Math.floor((rawAmount * 100) / count);
        const rem = Math.round(rawAmount * 100) - baseCent * count;
        partAmt = (baseCent + (i < rem ? 1 : 0)) / 100;
      }
      state.transactions.push({
        id: uid('tx'),
        date: i === 0 ? baseDate : addMonthsClamp(baseDate, i),
        type: tp,
        description: isInst ? `${baseDesc} (${i + 1}/${count})` : baseDesc,
        amount: Number(partAmt.toFixed(2)),
        category: tp === 'expense' ? $('category').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : tp === 'transfer' ? 'Transferência interna' : 'Poupança',
        person: tp === 'transfer' && $('transferFrom') && $('transferTo')
          ? `${$('transferFrom').value.trim() || 'Origem'} → ${$('transferTo').value.trim() || 'Destino'}`
          : ownerName,
        status: 'confirmed',
        credit_card_id: ccId,
        goal_id: tp === 'saving' || tp === 'saving_withdraw' ? $('savingGoal').value || null : null,
        installment_group_id: groupId,
        counts_for_cycle: tp === 'income' ? $('incomeCountsForCycle').checked : true,
        updated_at: Date.now()
      });
    }

    saveLocalState(state);
    $('txForm').reset();
    $('date').value = iso();
    $('calcPreviewBadge').hidden = true;
    $('categoryAutoHint').textContent = '';
    $('installmentsOptions').hidden = true;
    $('type').dispatchEvent(new Event('change'));
    closeAddTxModal();
    render();
    haptic([14, 25, 14]);
    showToast(isInst ? `${count} prestações registadas!` : 'Movimento guardado.', { type: 'success' });
    checkAutomaticCycleRollover();
  };

  ['movementCycle', 'filter', 'filterDateFrom', 'filterDateTo', 'filterSearch', 'filterCategory', 'movementSortOrder'].forEach(id => {
    $(id).addEventListener('input', () => {
      if (id === 'movementCycle') movementCycleKey = $('movementCycle').value;
      renderFilteredTransactions(buildCycles(state));
    });
  });
  document.querySelectorAll('[data-quick-status]').forEach(btn => {
    btn.onclick = () => {
      quickStatusFilter = btn.dataset.quickStatus;
      document.querySelectorAll('[data-quick-status]').forEach(b => b.classList.toggle('active', b === btn));
      renderFilteredTransactions(buildCycles(state));
    };
  });
  $('resetFiltersBtn').onclick = () => {
    $('filter').value = 'all'; $('filterDateFrom').value = ''; $('filterDateTo').value = '';
    $('filterSearch').value = ''; $('filterCategory').value = 'all'; quickStatusFilter = 'all';
    document.querySelectorAll('[data-quick-status]').forEach(b => b.classList.toggle('active', b.dataset.quickStatus === 'all'));
    renderFilteredTransactions(buildCycles(state));
  };

  document.addEventListener('click', e => {
    const openTx = e.target.closest('[data-open-tx]');
    if (openTx) { openTxDetailModal(openTx.dataset.openTx); return; }

    const tplBtn = e.target.closest('[data-tpl-idx]');
    if (tplBtn) {
      const item = $('quickTemplatesList')._items?.[Number(tplBtn.dataset.tplIdx)];
      if (item) {
        $('type').value = 'expense'; $('type').dispatchEvent(new Event('change'));
        $('desc').value = item.desc; $('category').value = item.category; $('amount').value = item.amount;
      }
      return;
    }

    const editCc = e.target.closest('[data-edit-cc]');
    if (editCc) {
      const card = state.credit_cards.find(c => String(c.id) === String(editCc.dataset.editCc));
      if (card) {
        $('ccId').value = card.id; $('ccName').value = card.name || '';
        $('ccLimit').value = Number(card.card_limit) > 0 ? card.card_limit : '';
        $('ccInitialDebt').value = Number(card.initial_debt) || 0;
        if ($('ccFormTitle')) $('ccFormTitle').textContent = `Editar cartão: ${card.name}`;
        if ($('ccSaveBtn')) $('ccSaveBtn').textContent = 'Guardar alterações';
        if ($('ccCancelBtn')) $('ccCancelBtn').hidden = false;
        $('ccName').focus();
      }
      return;
    }

    const delCc = e.target.closest('[data-del-cc]');
    if (delCc) {
      const card = state.credit_cards.find(c => String(c.id) === String(delCc.dataset.delCc));
      if (card && confirm(`Remover o cartão "${card.name}"?`)) {
        if (String($('ccId').value) === String(card.id) && $('ccCancelBtn')) $('ccCancelBtn').click();
        card.deleted_at = Date.now();
        mutate(card);
      }
      return;
    }

    const delGoal = e.target.closest('[data-del-goal]');
    if (delGoal) {
      e.stopPropagation();
      const g = state.savings_goals.find(x => String(x.id) === String(delGoal.dataset.delGoal));
      if (g && confirm(`Eliminar o objetivo "${g.name}"?`)) {
        if (String(selectedGoalId) === String(g.id)) selectedGoalId = null;
        g.deleted_at = Date.now(); mutate(g);
      }
      return;
    }

    const editGoal = e.target.closest('[data-edit-goal]');
    if (editGoal) {
      e.stopPropagation();
      const g = state.savings_goals.find(x => String(x.id) === String(editGoal.dataset.editGoal));
      if (g) {
        $('goalId').value = g.id; $('goalName').value = g.name; $('goalTarget').value = g.target;
        $('goalDeadline').value = g.deadline || ''; $('goalFormTitle').textContent = 'Editar objetivo'; $('goalCancel').hidden = false;
      }
      return;
    }

    const selectGoalCard = e.target.closest('[data-select-goal]');
    if (selectGoalCard) {
      const gid = selectGoalCard.dataset.selectGoal;
      selectedGoalId = String(selectedGoalId) === String(gid) ? null : gid;
      render();
      return;
    }

    const calDay = e.target.closest('[data-cal-day]');
    if (calDay) {
      selectedCalendarDay = calDay.dataset.calDay; calScopeMode = 'day'; renderCalendar();
      if (window.innerWidth <= 1039 && $('dayTitle')) $('dayTitle').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      return;
    }

    const copyMbBtn = e.target.closest('[data-copy-mb]');
    if (copyMbBtn) {
      const val = copyMbBtn.dataset.copyMb;
      navigator.clipboard?.writeText(val).then(() => showToast(`Copiado: ${val}`, { type: 'success' })).catch(() => showToast(`Valor: ${val}`));
      return;
    }

    const dismissAlertBtn = e.target.closest('[data-dismiss-alert]');
    if (dismissAlertBtn) {
      const alertId = dismissAlertBtn.dataset.dismissAlert;
      const cycleKey = dismissAlertBtn.dataset.dismissCycle || selectedCycleKey;
      if (alertId && cycleKey) { dismissAlertForCycle(cycleKey, alertId); render(); }
      return;
    }

    const delRuleBtn = e.target.closest('[data-del-cat-rule]');
    if (delRuleBtn) {
      const idx = Number(delRuleBtn.dataset.delCatRule);
      const sorted = (state.meta?.category_rules || []).slice().sort((a, b) => (b.hits || 0) - (a.hits || 0));
      const target = sorted[idx];
      if (target && state.meta?.category_rules) {
        state.meta.category_rules = state.meta.category_rules.filter(r => r !== target);
        state.meta.updated_at = Date.now();
        saveLocalState(state);
        renderCategoryRules();
        showToast('Regra removida.');
      }
      return;
    }

    const openEncBtn = e.target.closest('[data-open-encargo]');
    if (openEncBtn) {
      const r = state.recurring_expenses.find(x => String(x.id) === String(openEncBtn.dataset.openEncargo));
      if (r) {
        $('recurrenceId').value = r.id;
        $('encargoModalTitle').textContent = r.description;
        $('encargoModalSubtitle').textContent = `${r.category} · Dia habitual: ${r.day_of_month}`;
        $('encargoViewName').textContent = r.description;
        $('encargoViewMeta').textContent = r.category;
        $('encargoViewEntity').textContent = r.entity || '—';
        $('encargoViewRef').textContent = r.payment_ref || '—';
        $('encargoViewAmount').textContent = Number(r.amount) > 0 ? eur(r.amount) : 'Variável';
        $('encargoViewDay').textContent = `Dia ${r.day_of_month} de cada ciclo`;
        $('encargoCopyEntityBtn').hidden = !r.entity;
        $('encargoCopyRefBtn').hidden = !r.payment_ref;

        const cp = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
        const historyEntries = Object.entries(cp)
          .filter(([, v]) => v && v.paid && v.paidDate)
          .sort((a, b) => String(b[1].paidDate).localeCompare(String(a[1].paidDate)))
          .slice(0, 6);
        $('encargoHistoryList').innerHTML = historyEntries.length
          ? historyEntries
              .map(([, v]) => `<div class="item row" style="padding:7px 8px"><span>${fmtDate(v.paidDate)}</span><b>${eur(v.amount)}</b></div>`)
              .join('')
          : '<div class="empty" style="padding:10px">Ainda sem pagamentos registados.</div>';

        $('encargoModalReadView').hidden = false;
        $('recurrenceForm').hidden = true;
        $('encargoModal').hidden = false;
      }
      return;
    }
  });

  if ($('openNewEncargoBtn')) {
    $('openNewEncargoBtn').onclick = () => {
      $('recurrenceForm').reset();
      $('recurrenceId').value = '';
      $('recurrenceDay').value = '1';
      $('encargoModalTitle').textContent = 'Novo serviço / encargo';
      $('encargoModalSubtitle').textContent = 'Adiciona uma conta fixa ou fornecedor ao caderno de encargos';
      $('encargoModalReadView').hidden = true;
      $('recurrenceForm').hidden = false;
      $('encargoModal').hidden = false;
      setTimeout(() => $('recurrenceDescription').focus(), 40);
    };
  }
  if ($('encargoSwitchEditBtn')) {
    $('encargoSwitchEditBtn').onclick = () => {
      const r = state.recurring_expenses.find(x => String(x.id) === String($('recurrenceId').value));
      if (!r) return;
      $('encargoModalTitle').textContent = 'Editar fornecedor / serviço';
      $('recurrenceDescription').value = r.description;
      $('recurrenceCategory').value = r.category;
      $('recurrenceEntity').value = r.entity || '';
      $('recurrenceRef').value = r.payment_ref || '';
      $('recurrenceAmount').value = Number(r.amount) > 0 ? r.amount : '';
      $('recurrenceDay').value = r.day_of_month;
      $('encargoModalReadView').hidden = true;
      $('recurrenceForm').hidden = false;
    };
  }
  if ($('encargoDeleteBtn')) {
    $('encargoDeleteBtn').onclick = () => {
      const r = state.recurring_expenses.find(x => String(x.id) === String($('recurrenceId').value));
      if (!r) return;
      if (confirm(`Remover "${r.description}" do caderno de encargos?`)) {
        r.deleted_at = Date.now();
        $('encargoModal').hidden = true;
        mutate(r);
        showToast('Fornecedor removido.');
      }
    };
  }
  if ($('encargoCopyEntityBtn')) {
    $('encargoCopyEntityBtn').onclick = () => {
      const val = $('encargoViewEntity').textContent;
      if (val && val !== '—') navigator.clipboard?.writeText(val).then(() => showToast(`Entidade copiada: ${val}`, { type: 'success' }));
    };
  }
  if ($('encargoCopyRefBtn')) {
    $('encargoCopyRefBtn').onclick = () => {
      const val = $('encargoViewRef').textContent;
      if (val && val !== '—') navigator.clipboard?.writeText(val).then(() => showToast(`Referência copiada: ${val}`, { type: 'success' }));
    };
  }
  function closeEncargoModal() { if ($('encargoModal')) $('encargoModal').hidden = true; }
  if ($('closeEncargoModalBtn')) $('closeEncargoModalBtn').onclick = closeEncargoModal;
  if ($('recurrenceCancel')) $('recurrenceCancel').onclick = closeEncargoModal;
  if ($('encargoModal')) $('encargoModal').onclick = e => { if (e.target === $('encargoModal')) closeEncargoModal(); };

  if ($('encargosCycleSelect')) {
    $('encargosCycleSelect').onchange = e => { encargosCycleKey = e.target.value; renderRecurringSection(); };
  }

  if ($('encargosChecklist')) {
    $('encargosChecklist').addEventListener('change', e => {
      const paidChk = e.target.closest('[data-encargo-paid]');
      const amtInp = e.target.closest('[data-encargo-amount]');
      const dateInp = e.target.closest('[data-encargo-date]');
      const target = paidChk || amtInp || dateInp;
      if (!target) return;

      const recId = target.dataset.encargoPaid || target.dataset.encargoAmount || target.dataset.encargoDate;
      const r = state.recurring_expenses.find(x => String(x.id) === String(recId));
      if (!r) return;

      const cycles = buildCycles(state);
      const activeCycle = cycles.find(c => c.key === encargosCycleKey) || currentCycle(cycles);
      const cycleKey = activeCycle ? activeCycle.key : currentMonth();

      r.cycle_payments = r.cycle_payments && typeof r.cycle_payments === 'object' ? r.cycle_payments : {};
      const entry = r.cycle_payments[cycleKey] || {};

      const cardEl = target.closest('.encargo-card');
      const curAmtInput = cardEl ? cardEl.querySelector('[data-encargo-amount]') : null;
      const curDateInput = cardEl ? cardEl.querySelector('[data-encargo-date]') : null;
      const curPaidInput = cardEl ? cardEl.querySelector('[data-encargo-paid]') : null;

      const amountVal = Math.max(0, Number(curAmtInput?.value) || Number(r.amount) || 0);
      const dateVal = curDateInput?.value || getSuggestedEncargoDate(activeCycle, r.day_of_month);
      const isNowPaid = !!curPaidInput?.checked;

      entry.amount = amountVal;
      entry.paidDate = dateVal;
      entry.paid = isNowPaid;
      r.cycle_payments[cycleKey] = entry;
      r.updated_at = Date.now();

      const ownerName = getUserDisplayName(state);

      if (paidChk) {
        if (isNowPaid) {
          if (amountVal <= 0) {
            alert('Introduz primeiro o valor pago (€) deste encargo.');
            curPaidInput.checked = false;
            entry.paid = false;
            curAmtInput?.focus();
            return;
          }
          if (entry.txId) {
            const existing = state.transactions.find(t => String(t.id) === String(entry.txId) && !t.deleted_at);
            if (existing) {
              existing.amount = amountVal;
              existing.date = dateVal;
              existing.description = r.description;
              existing.category = r.category;
              existing.updated_at = Date.now();
            } else {
              entry.txId = null;
            }
          }
          if (!entry.txId) {
            const newTxId = uid('tx');
            state.transactions.push({
              id: newTxId,
              date: dateVal,
              type: 'expense',
              description: r.description,
              amount: amountVal,
              category: r.category,
              person: ownerName,
              status: 'confirmed',
              occurrence_key: `encargo:${r.id}:${cycleKey}`,
              updated_at: Date.now()
            });
            entry.txId = newTxId;
          }
          haptic([12, 20, 12]);
          showToast(`✅ ${r.description} registado como pago (${eur(amountVal)})`, { type: 'success' });
        } else {
          if (entry.txId) {
            const existing = state.transactions.find(t => String(t.id) === String(entry.txId));
            if (existing && !existing.deleted_at) { existing.deleted_at = Date.now(); existing.updated_at = Date.now(); }
            entry.txId = null;
          }
          showToast(`Pagamento de ${r.description} desmarcado.`);
        }
      } else if (isNowPaid && entry.txId) {
        const existing = state.transactions.find(t => String(t.id) === String(entry.txId) && !t.deleted_at);
        if (existing) {
          existing.amount = amountVal;
          existing.date = dateVal;
          existing.updated_at = Date.now();
          showToast('Valor/data do pagamento atualizado.', { type: 'success' });
        }
      }

      saveLocalState(state);
      render();
    });
  }

  $('closeTxModalBtn').onclick = () => { $('txDetailModal').hidden = true; };
  $('txModalSwitchEditBtn').onclick = switchModalToEdit;
  $('txModalCancelEditBtn').onclick = () => { $('txModalEditForm').hidden = true; $('txModalReadView').hidden = false; };
  $('modalEditType').onchange = updateModalEditVisibility;

  $('txModalEditForm').onsubmit = e => {
    e.preventDefault();
    const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
    if (!tx) return;
    const val = evaluateAmountExpression($('modalEditAmount').value);
    if (!Number.isFinite(val) || val <= 0) { alert('Valor inválido.'); return; }
    const tp = $('modalEditType').value;
    let ccId = null;
    if (tp === 'expense' && $('modalEditPaymentMethod').value.startsWith('cc:')) ccId = $('modalEditPaymentMethod').value.slice(3);
    else if (tp === 'cc_payment') {
      ccId = $('modalEditCcPaymentCard').value || null;
      if (!ccId) { alert('Seleciona o cartão de crédito.'); return; }
    }

    const oldCategory = tx.category;
    tx.date = $('modalEditDate').value;
    tx.type = tp;
    tx.description = $('modalEditDesc').value.trim();
    tx.amount = Number(val.toFixed(2));
    tx.category = tp === 'expense' ? $('modalEditCat').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : tp === 'transfer' ? 'Transferência interna' : 'Poupança';
    tx.person = tp === 'transfer' && $('modalEditTransferFrom') && $('modalEditTransferTo')
      ? `${$('modalEditTransferFrom').value.trim() || 'Origem'} → ${$('modalEditTransferTo').value.trim() || 'Destino'}`
      : getUserDisplayName(state);
    tx.credit_card_id = ccId;
    tx.goal_id = tp === 'saving' || tp === 'saving_withdraw' ? $('modalEditGoal').value || null : null;
    tx.counts_for_cycle = tp === 'income' ? $('modalEditCountsCycle').checked : true;
    if (tp === 'expense' && tx.category && tx.category !== oldCategory) learnCategoryRule(state, tx.description, tx.category);

    $('txDetailModal').hidden = true;
    mutate(tx);
    showToast('Movimento atualizado.', { type: 'success' });
  };

  $('txModalDuplicateBtn').onclick = () => {
    const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
    if (!tx) return;
    const copy = { ...tx, id: uid('tx'), date: iso(), installment_group_id: null, occurrence_key: null, updated_at: Date.now() };
    state.transactions.push(copy);
    $('txDetailModal').hidden = true;
    mutate(copy);
    showToast('Movimento duplicado para hoje.', { type: 'success' });
  };

  $('txModalDeleteBtn').onclick = () => {
    const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
    if (!tx) return;
    tx.deleted_at = Date.now();
    $('txDetailModal').hidden = true;
    mutate(tx);
    showToast('Movimento eliminado.', {
      undoLabel: 'Anular',
      onUndo: () => { tx.deleted_at = null; mutate(tx); }
    });
  };

  if ($('txModalSettleInstBtn')) {
    $('txModalSettleInstBtn').onclick = () => {
      const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
      if (!tx || !tx.installment_group_id) return;
      const today = iso();
      const futureTxs = state.transactions.filter(t => !t.deleted_at && t.installment_group_id === tx.installment_group_id && t.date > today);
      if (!futureTxs.length) return;
      const remTotal = sum(futureTxs);
      if (!confirm(`Antecipar e liquidar as ${futureTxs.length} prestação(ões) restante(s) (${eur(remTotal)}) com data de hoje (${fmtDate(today)})?`)) return;
      const now = Date.now();
      futureTxs.forEach(item => { item.date = today; item.updated_at = now; });
      $('txDetailModal').hidden = true;
      saveLocalState(state);
      render();
      showToast(`${futureTxs.length} prestações liquidadas hoje!`, { type: 'success' });
    };
  }

  if ($('txModalDeleteFutureInstBtn')) {
    $('txModalDeleteFutureInstBtn').onclick = () => {
      const tx = state.transactions.find(t => String(t.id) === String($('modalTxId').value));
      if (!tx || !tx.installment_group_id) return;
      const today = iso();
      const futureTxs = state.transactions.filter(t => !t.deleted_at && t.installment_group_id === tx.installment_group_id && t.date > today);
      if (!futureTxs.length) return;
      if (!confirm(`Apagar as ${futureTxs.length} prestação(ões) futura(s) deste plano?`)) return;
      const now = Date.now();
      futureTxs.forEach(item => { item.deleted_at = now; item.updated_at = now; });
      $('txDetailModal').hidden = true;
      saveLocalState(state);
      render();
      showToast(`${futureTxs.length} prestações futuras apagadas.`);
    };
  }

  $('goalForm').onsubmit = e => {
    e.preventDefault();
    const id = $('goalId').value;
    const data = { name: $('goalName').value.trim(), target: Number($('goalTarget').value), deadline: $('goalDeadline').value || null };
    if (id) {
      const g = state.savings_goals.find(x => String(x.id) === String(id));
      if (g) { Object.assign(g, data); mutate(g); }
    } else {
      const g = { id: uid('goal'), ...data, status: 'active', updated_at: Date.now() };
      state.savings_goals.push(g);
      mutate(g);
    }
    $('goalForm').reset(); $('goalId').value = ''; $('goalFormTitle').textContent = 'Criar objetivo de poupança'; $('goalCancel').hidden = true;
    showToast('Objetivo guardado.', { type: 'success' });
  };
  $('goalCancel').onclick = () => { $('goalForm').reset(); $('goalId').value = ''; $('goalFormTitle').textContent = 'Criar objetivo de poupança'; $('goalCancel').hidden = true; };

  $('recurrenceForm').onsubmit = e => {
    e.preventDefault();
    const id = $('recurrenceId').value;
    const payload = {
      description: $('recurrenceDescription').value.trim(),
      category: $('recurrenceCategory').value,
      entity: $('recurrenceEntity') ? $('recurrenceEntity').value.trim() : '',
      payment_ref: $('recurrenceRef') ? $('recurrenceRef').value.trim() : '',
      amount: Math.max(0, Number($('recurrenceAmount').value) || 0),
      person: getUserDisplayName(state),
      day_of_month: Math.min(31, Math.max(1, Number($('recurrenceDay').value) || 1)),
      active: true
    };
    if (id) {
      const r = state.recurring_expenses.find(x => String(x.id) === String(id));
      if (r) { Object.assign(r, payload); mutate(r); }
    } else {
      const r = { id: uid('rec'), ...payload, cycle_payments: {}, updated_at: Date.now() };
      state.recurring_expenses.push(r);
      mutate(r);
    }
    $('recurrenceForm').reset(); $('recurrenceId').value = ''; $('encargoModal').hidden = true;
    showToast('Fornecedor guardado no caderno de encargos.', { type: 'success' });
  };

  $('budgetForm').onsubmit = e => {
    e.preventDefault();
    const rows = Array.from(document.querySelectorAll('#budgetFields .cat-edit-row'));
    const seenNames = new Set();
    const updates = [];

    for (const row of rows) {
      const nameInp = row.querySelector('[data-cat-name-id]');
      const budgetInp = row.querySelector('[data-cat-budget-id]');
      if (!nameInp || !budgetInp) continue;
      const catId = nameInp.dataset.catNameId;
      const newName = nameInp.value.trim();
      const newBudget = Math.max(0, Number(budgetInp.value) || 0);
      if (!newName) { alert('O nome da categoria não pode ficar vazio.'); nameInp.focus(); return; }
      const lower = newName.toLowerCase();
      if (seenNames.has(lower)) { alert(`Já existe outra categoria com o nome "${newName}".`); nameInp.focus(); return; }
      seenNames.add(lower);
      updates.push({ catId, newName, newBudget });
    }

    const now = Date.now();
    for (const u of updates) {
      const c = state.categories.find(x => String(x.id) === String(u.catId));
      if (!c) continue;
      const oldName = c.name;
      c.name = u.newName;
      c.budget = u.newBudget;
      c.updated_at = now;

      if (oldName !== u.newName) {
        for (const t of state.transactions) {
          if (!t.deleted_at && t.category === oldName) { t.category = u.newName; t.updated_at = now; }
        }
        for (const r of state.recurring_expenses) {
          if (!r.deleted_at && r.category === oldName) { r.category = u.newName; r.updated_at = now; }
        }
      }
    }

    saveLocalState(state);
    render();
    showToast('Categorias e limites atualizados.', { type: 'success' });
  };

  if ($('budgetFields')) {
    $('budgetFields').addEventListener('click', e => {
      const moveBtn = e.target.closest('[data-move-cat]');
      if (moveBtn) {
        const catId = moveBtn.dataset.moveCat;
        const dir = Number(moveBtn.dataset.dir) || 0;
        const active = (state.categories || [])
          .filter(c => !c.deleted_at)
          .sort((a, b) => (Number(a.sort_order) || 999) - (Number(b.sort_order) || 999) || String(a.name).localeCompare(String(b.name)));
        const idx = active.findIndex(c => String(c.id) === String(catId));
        const targetIdx = idx + dir;
        if (idx >= 0 && targetIdx >= 0 && targetIdx < active.length) {
          const temp = active[idx];
          active[idx] = active[targetIdx];
          active[targetIdx] = temp;
          const now = Date.now();
          active.forEach((c, i) => { c.sort_order = i + 1; c.updated_at = now; });
          saveLocalState(state);
          render();
        }
        return;
      }

      const delBtn = e.target.closest('[data-del-cat]');
      if (!delBtn) return;
      const catId = delBtn.dataset.delCat;
      const c = state.categories.find(x => String(x.id) === String(catId));
      if (!c) return;

      const activeCats = state.categories.filter(x => !x.deleted_at);
      if (activeCats.length <= 1) { alert('Tens de manter pelo menos uma categoria ativa.'); return; }

      const usedCount = state.transactions.filter(t => !t.deleted_at && t.category === c.name).length;
      const fallbackCat = activeCats.find(x => String(x.id) !== String(catId) && x.name === 'Outros') || activeCats.find(x => String(x.id) !== String(catId));

      const confirmMsg = usedCount > 0
        ? `Apagar a categoria "${c.name}"?

Os ${usedCount} movimento(s) associados serão reatribuídos automaticamente para "${fallbackCat.name}".`
        : `Apagar a categoria "${c.name}"?`;

      if (!confirm(confirmMsg)) return;

      const now = Date.now();
      if (usedCount > 0 && fallbackCat) {
        for (const t of state.transactions) {
          if (!t.deleted_at && t.category === c.name) { t.category = fallbackCat.name; t.updated_at = now; }
        }
        for (const r of state.recurring_expenses) {
          if (!r.deleted_at && r.category === c.name) { r.category = fallbackCat.name; r.updated_at = now; }
        }
      }
      c.deleted_at = now;
      c.updated_at = now;
      saveLocalState(state);
      render();
      showToast(`Categoria "${c.name}" removida.`, { type: 'success' });
    });
  }

  $('newCategoryForm').onsubmit = e => {
    e.preventDefault();
    const name = $('newCategoryName').value.trim();
    if (!name) return;
    if (state.categories.some(c => !c.deleted_at && c.name.toLowerCase() === name.toLowerCase())) { alert('Essa categoria já existe.'); return; }
    const cat = { id: uid('cat'), name, budget: Math.max(0, Number($('newCategoryBudget').value) || 0), sort_order: state.categories.length + 1, updated_at: Date.now() };
    state.categories.push(cat);
    $('newCategoryForm').reset();
    mutate(cat);
    showToast('Categoria criada.', { type: 'success' });
  };

  if ($('addCategoryRuleForm')) {
    $('addCategoryRuleForm').onsubmit = e => {
      e.preventDefault();
      const kw = $('newRuleKeyword').value.trim().toUpperCase();
      const cat = $('newRuleCategory').value;
      if (!kw || !cat) return;
      state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
      state.meta.category_rules = state.meta.category_rules || [];
      const existing = state.meta.category_rules.find(r => r.keyword.toUpperCase() === kw);
      if (existing) { existing.category = cat; existing.hits = (existing.hits || 1) + 1; }
      else state.meta.category_rules.push({ keyword: kw, category: cat, hits: 1 });
      state.meta.updated_at = Date.now();
      saveLocalState(state);
      $('addCategoryRuleForm').reset();
      renderCategoryRules();
      showToast(`Regra "${kw}" → "${cat}" guardada.`, { type: 'success' });
    };
  }

  function resetCreditCardForm() {
    $('creditCardForm').reset();
    $('ccId').value = '';
    if ($('ccInitialDebt')) $('ccInitialDebt').value = '0';
    if ($('ccFormTitle')) $('ccFormTitle').textContent = 'Cartões de crédito';
    if ($('ccSaveBtn')) $('ccSaveBtn').textContent = 'Guardar cartão';
    if ($('ccCancelBtn')) $('ccCancelBtn').hidden = true;
  }

  if ($('ccCancelBtn')) $('ccCancelBtn').onclick = resetCreditCardForm;

  $('creditCardForm').onsubmit = e => {
    e.preventDefault();
    const name = $('ccName').value.trim();
    if (!name) return;
    const editId = $('ccId').value;
    const limitVal = Math.max(0, Number($('ccLimit').value) || 0);
    const debtVal = Math.max(0, Number($('ccInitialDebt').value) || 0);

    if (editId) {
      const existing = state.credit_cards.find(c => String(c.id) === String(editId));
      if (existing) {
        existing.name = name;
        existing.card_limit = limitVal;
        existing.initial_debt = debtVal;
        resetCreditCardForm();
        mutate(existing);
        showToast('Cartão atualizado.', { type: 'success' });
        return;
      }
    }

    const card = {
      id: uid('cc'), name, card_limit: limitVal, initial_debt: debtVal,
      owner: getUserDisplayName(state), updated_at: Date.now()
    };
    state.credit_cards.push(card);
    resetCreditCardForm();
    mutate(card);
    showToast('Cartão de crédito adicionado.', { type: 'success' });
  };

  ['simDesc', 'simAmount', 'simInstallments', 'simCategory'].forEach(id => { $(id).addEventListener('input', runImpactSimulator); });
  $('simResetBtn').onclick = () => { $('simDesc').value = ''; $('simAmount').value = ''; $('simInstallments').value = '1'; runImpactSimulator(); };
  $('simConvertToTxBtn').onclick = () => {
    const amount = Number($('simAmount').value) || 0;
    if (amount <= 0) return;
    openAddTxModal(false);
    $('type').value = 'expense'; $('type').dispatchEvent(new Event('change'));
    $('desc').value = $('simDesc').value.trim() || 'Compra simulada';
    $('amount').value = amount;
    $('category').value = $('simCategory').value;
    const n = Number($('simInstallments').value) || 1;
    $('isInstallment').checked = n > 1;
    $('installmentsOptions').hidden = n <= 1;
    $('installmentCount').value = n;
    $('installmentAmountMode').value = 'total';
  };

  $('savePeople').onclick = () => {
    state.household.adult1_name = $('userName').value.trim() || 'Pessoal';
    state.household.adult2_name = '';
    state.household.cycle_grouping_days = Math.max(0, Math.min(20, Math.round(Number($('cycleGroupingDays').value) || 14)));
    mutate(state.household);
    showToast('Perfil e regra de ciclos guardados.', { type: 'success' });
  };

  $('exportCyclePdfBtn').onclick = () => {
    const cycles = buildCycles(state);
    const c = cycles.find(x => x.key === selectedCycleKey) || currentCycle(cycles);
    generateCyclePdfReport(state, c);
  };
  if ($('exportMovementsPdfBtn')) {
    $('exportMovementsPdfBtn').onclick = () => {
      const cycles = buildCycles(state);
      let list = state.transactions.filter(t => !t.deleted_at);
      let label = 'Todos os movimentos';
      if (movementCycleKey && movementCycleKey !== 'all') {
        const cy = cycles.find(c => c.key === movementCycleKey);
        if (cy) { list = list.filter(t => t.date >= cy.start && t.date <= cy.end); label = cy.monthLabel; }
      }
      const tp = $('filter').value;
      if (tp === 'expense') list = list.filter(t => t.type === 'expense');
      else if (tp === 'cc_expense') list = list.filter(t => t.type === 'expense' && t.credit_card_id);
      else if (tp !== 'all') list = list.filter(t => t.type === tp);
      const df = $('filterDateFrom').value;
      const dt = $('filterDateTo').value;
      if (df) list = list.filter(t => t.date >= df);
      if (dt) list = list.filter(t => t.date <= dt);
      const q = $('filterSearch').value.trim().toLowerCase();
      if (q) list = list.filter(t => String(t.description || '').toLowerCase().includes(q));
      const cat = $('filterCategory').value;
      if (cat !== 'all') list = list.filter(t => t.category === cat);
      if (quickStatusFilter === 'pending') list = list.filter(t => t.status === 'pending');
      else if (quickStatusFilter === 'skipped') list = list.filter(t => t.status === 'skipped');
      else if (quickStatusFilter === 'installments') list = list.filter(t => !!t.installment_group_id);

      const sortedDates = list.map(t => t.date).filter(Boolean).sort();
      const pseudoCycle = {
        monthLabel: label,
        start: df || sortedDates[0] || iso(),
        end: dt || sortedDates[sortedDates.length - 1] || iso()
      };
      generateCyclePdfReport(state, pseudoCycle, list, `Extrato de Movimentos — ${label}`);
    };
  }

  $('analyticsCycleSelect').onchange = updateAnalyticsView;
  $('analyticsMetric').onchange = updateAnalyticsView;
  $('analyticsChartType').onchange = updateAnalyticsView;

  $('prevCalMonth').onclick = () => {
    const [y, m] = calendarMonthStr.split('-').map(Number);
    const d = new Date(y, m - 2, 1);
    calendarMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderCalendar();
  };
  $('nextCalMonth').onclick = () => {
    const [y, m] = calendarMonthStr.split('-').map(Number);
    const d = new Date(y, m, 1);
    calendarMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    renderCalendar();
  };
  $('calendarMonth').onchange = e => { if (e.target.value) { calendarMonthStr = e.target.value; renderCalendar(); } };
  if ($('calScopeToggleBtn')) {
    $('calScopeToggleBtn').onclick = () => { calScopeMode = calScopeMode === 'day' ? 'month' : 'day'; renderCalendar(); };
  }

  const calLayoutEl = $('calSplitLayout');
  if (calLayoutEl) {
    calLayoutEl.style.setProperty('--cal-left-size', `${calLayoutPrefs.leftPct}%`);
    calLayoutEl.classList.toggle('is-swapped', !!calLayoutPrefs.swapped);
  }
  if ($('calSwapOrderBtn')) {
    $('calSwapOrderBtn').onclick = () => {
      calLayoutPrefs.swapped = !calLayoutPrefs.swapped;
      if (calLayoutEl) calLayoutEl.classList.toggle('is-swapped', calLayoutPrefs.swapped);
      saveCalLayoutPrefs(calLayoutPrefs);
      showToast(calLayoutPrefs.swapped ? 'Movimentos movidos para a esquerda.' : 'Calendário movido para a esquerda.');
    };
  }
  if ($('calExpandMovementsBtn')) {
    $('calExpandMovementsBtn').onclick = () => {
      const isCurrentlyExpanded = calLayoutPrefs.leftPct <= 34;
      calLayoutPrefs.leftPct = isCurrentlyExpanded ? 50 : 32;
      if (calLayoutEl) calLayoutEl.style.setProperty('--cal-left-size', `${calLayoutPrefs.leftPct}%`);
      saveCalLayoutPrefs(calLayoutPrefs);
      $('calExpandMovementsBtn').textContent = calLayoutPrefs.leftPct <= 34 ? '⤡ Normal' : '⤢ Ampliar';
    };
  }
  const calSplitterEl = $('calSplitter');
  if (calSplitterEl && calLayoutEl) {
    let draggingSplit = false;
    const updateSplitFromClientX = clientX => {
      const rect = calLayoutEl.getBoundingClientRect();
      if (!rect.width) return;
      const rel = ((clientX - rect.left) / rect.width) * 100;
      const clamped = Math.min(72, Math.max(28, Math.round(rel * 10) / 10));
      calLayoutPrefs.leftPct = clamped;
      calLayoutEl.style.setProperty('--cal-left-size', `${clamped}%`);
    };
    calSplitterEl.addEventListener('pointerdown', e => {
      draggingSplit = true;
      calSplitterEl.classList.add('is-dragging');
      calSplitterEl.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    calSplitterEl.addEventListener('pointermove', e => { if (draggingSplit) updateSplitFromClientX(e.clientX); });
    const stopSplitDrag = () => {
      if (!draggingSplit) return;
      draggingSplit = false;
      calSplitterEl.classList.remove('is-dragging');
      saveCalLayoutPrefs(calLayoutPrefs);
    };
    calSplitterEl.addEventListener('pointerup', stopSplitDrag);
    calSplitterEl.addEventListener('pointercancel', stopSplitDrag);
  }

  function showImportPreview(rawRows) {
    parsedImportRows = evaluateStatementDuplicates(rawRows, state.transactions, { dayWindow: 3 });
    if (!parsedImportRows.length) {
      alert('Não foram detetados movimentos válidos nesse ficheiro/texto.');
      return;
    }

    const dupCount = parsedImportRows.filter(r => r.isDuplicate).length;
    const newCount = parsedImportRows.length - dupCount;
    const activeCats = (state.categories || []).filter(c => !c.deleted_at);

    $('csvPreviewContainer').hidden = false;
    $('csvToggleAll').checked = newCount > 0 && dupCount === 0;
    $('csvSummaryCount').innerHTML = dupCount > 0
      ? `<b>${newCount}</b> novo(s) · <span style="color:#d97706;font-weight:600">⚠️ ${dupCount} possível(is) duplicado(s) desmarcado(s)</span>`
      : `<b>${parsedImportRows.length}</b> movimento(s) detetado(s)`;

    $('csvPreviewList').innerHTML = parsedImportRows
      .map((r, i) => {
        const catOptions = activeCats
          .map(c => `<option value="${esc(c.name)}" ${c.name === r.category ? 'selected' : ''}>${esc(c.name)}</option>`)
          .join('');
        const dupBadge = r.isDuplicate
          ? `<div style="margin-top:3px"><span class="dup-badge" title="${esc(r.duplicateReason)}">⚠️ Possível duplicado (${esc(r.duplicateReason)})</span></div>`
          : '';
        return `<div class="item row ${r.isDuplicate ? 'import-row-duplicate' : ''}" style="gap:8px;align-items:flex-start">
          <input type="checkbox" data-imp-idx="${i}" ${r.selected ? 'checked' : ''} style="width:18px;height:18px;min-height:18px;margin-top:4px;flex-shrink:0">
          <div style="flex:1;min-width:0">
            <div><b>${esc(r.description)}</b></div>
            <div class="small" style="margin-bottom:4px">${fmtDate(r.date)}</div>
            <div class="row" style="gap:6px;justify-content:flex-start;flex-wrap:wrap">
              <select data-imp-type="${i}" style="padding:3px 6px;font-size:12px;width:auto;min-height:30px">
                <option value="expense" ${r.type === 'expense' ? 'selected' : ''}>Despesa (−)</option>
                <option value="income" ${r.type === 'income' ? 'selected' : ''}>Rendimento (+)</option>
                <option value="saving" ${r.type === 'saving' ? 'selected' : ''}>Poupança</option>
                <option value="cc_payment" ${r.type === 'cc_payment' ? 'selected' : ''}>Pag. Cartão</option>
              </select>
              <select data-imp-cat="${i}" style="padding:3px 6px;font-size:12px;width:auto;max-width:165px;min-height:30px" ${r.type !== 'expense' ? 'hidden' : ''}>
                ${catOptions}
              </select>
            </div>
            ${dupBadge}
          </div>
          <b class="${r.type === 'income' ? 'plus' : 'minus'}" style="white-space:nowrap">${r.type === 'income' ? '+' : '−'} ${eur(r.amount)}</b>
        </div>`;
      })
      .join('');
  }

  $('csvFileInput').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      let rows = [];
      if (file.name.toLowerCase().endsWith('.pdf')) {
        showToast('A analisar extrato PDF…');
        const lines = await extractLinesFromPdf(file);
        rows = parseStatementLines(state, lines);
      } else {
        const text = await file.text();
        rows = parseStatementLines(state, text.split(/\r?\n/));
      }
      showImportPreview(rows);
    } catch (err) {
      alert('Erro ao ler extrato: ' + err.message);
    }
    e.target.value = '';
  };

  $('togglePasteExtractBtn').onclick = () => { $('pasteExtractBox').hidden = !$('pasteExtractBox').hidden; };
  $('cancelPasteTextBtn').onclick = () => { $('pasteExtractBox').hidden = true; };
  $('parsePastedTextBtn').onclick = () => {
    const rows = parseStatementLines(state, $('pasteExtractText').value.split(/\r?\n/));
    $('pasteExtractBox').hidden = true;
    showImportPreview(rows);
  };

  $('csvToggleAll').onchange = e => {
    const checked = e.target.checked;
    parsedImportRows.forEach(r => { r.selected = checked; });
    document.querySelectorAll('[data-imp-idx]').forEach(cb => { cb.checked = checked; });
  };
  $('csvPreviewList').addEventListener('change', e => {
    if (e.target.dataset.impIdx !== undefined) {
      parsedImportRows[Number(e.target.dataset.impIdx)].selected = e.target.checked;
    } else if (e.target.dataset.impType !== undefined) {
      const idx = Number(e.target.dataset.impType);
      const newType = e.target.value;
      parsedImportRows[idx].type = newType;
      const catSel = $('csvPreviewList').querySelector(`[data-imp-cat="${idx}"]`);
      if (catSel) catSel.hidden = newType !== 'expense';
      const amtEl = e.target.closest('.item')?.querySelector('b:last-child');
      if (amtEl) {
        const r = parsedImportRows[idx];
        amtEl.className = newType === 'income' ? 'plus' : 'minus';
        amtEl.textContent = `${newType === 'income' ? '+' : '−'} ${eur(r.amount)}`;
      }
    } else if (e.target.dataset.impCat !== undefined) {
      const idx = Number(e.target.dataset.impCat);
      const newCat = e.target.value;
      parsedImportRows[idx].category = newCat;
      if (parsedImportRows[idx].type === 'expense') learnCategoryRule(state, parsedImportRows[idx].description, newCat);
    }
  });
  $('csvCancelImportBtn').onclick = () => { $('csvPreviewContainer').hidden = true; parsedImportRows = []; };
  $('csvConfirmImportBtn').onclick = () => {
    const chosen = parsedImportRows.filter(r => r.selected);
    if (!chosen.length) { alert('Nenhum movimento selecionado.'); return; }
    const ownerName = getUserDisplayName(state);
    for (const r of chosen) {
      const cat = r.type === 'expense' ? r.category : r.type === 'cc_payment' ? 'Pagamento de cartão' : r.type === 'income' ? 'Rendimento' : 'Poupança';
      state.transactions.push({
        id: uid('imp'),
        date: r.date,
        type: r.type,
        description: r.description,
        amount: r.amount,
        category: cat,
        person: ownerName,
        status: 'confirmed',
        updated_at: Date.now()
      });
    }
    saveLocalState(state);
    $('csvPreviewContainer').hidden = true;
    parsedImportRows = [];
    render();
    showToast(`${chosen.length} movimento(s) importado(s)!`, { type: 'success' });
  };

  $('exportBackupBtn').onclick = () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `unofin-backup-${iso()}.json`;
    a.click();
    localStorage.setItem('unofin_last_backup_date', new Date().toISOString());
    initStorageProtectionAndBackupReminder();
    showToast('Cópia de segurança JSON exportada!', { type: 'success' });
  };

  $('importLegacyBackup').onchange = async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const raw = JSON.parse(await file.text());
      const converted = convertLegacyV1Backup(raw);
      if (!confirm(`Importar ${converted.transactions.length} movimento(s) desta cópia de segurança? Os dados atuais serão substituídos.`)) return;
      state = converted;
      saveLocalState(state);
      render();
      showToast('Backup restaurado com sucesso!', { type: 'success' });
    } catch (err) {
      alert('Erro ao ler ficheiro JSON: ' + err.message);
    }
    e.target.value = '';
  };

  $('exportCsvBtn').onclick = () => {
    const header = 'Data;Tipo;Descricao;Categoria;Valor
';
    const rows = state.transactions
      .filter(t => !t.deleted_at)
      .map(t => `${t.date};${t.type};"${String(t.description).replace(/"/g, '""')}";${t.category};${String(t.amount).replace('.', ',')}`)
      .join('
');
    const blob = new Blob(['﻿' + header + rows], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `unofin-movimentos-${iso()}.csv`;
    a.click();
  };

  $('privacyToggleBtn').onclick = () => security.togglePrivacy();
  $('lockAppHeaderBtn').onclick = () => security.lock();
  $('lockNowBtn').onclick = () => security.lock();
  $('savePinBtn').onclick = async () => {
    const pin = $('newPinInput').value.trim();
    if (!/^\d{4,6}$/.test(pin)) { alert('O PIN deve ter entre 4 e 6 dígitos.'); return; }
    await security.setPin(pin, $('autoLockMinutes').value);
    $('newPinInput').value = '';
    render();
    showToast('PIN local guardado.', { type: 'success' });
  };
  $('disablePinBtn').onclick = () => {
    if (confirm('Remover o bloqueio por PIN?')) { security.disablePin(); render(); showToast('PIN removido.'); }
  };
  $('enableBioBtn').onclick = async () => {
    try { await security.enableBiometrics(); render(); showToast('Biometria configurada!', { type: 'success' }); }
    catch (err) { alert(err.message); }
  };
  $('appLockUnlockBtn').onclick = async () => {
    const ok = await security.verifyPin($('appLockPinInput').value);
    if (!ok) $('appLockError').textContent = 'PIN incorreto.';
  };
  $('appLockBioBtn').onclick = () => security.unlockWithBiometrics();

  if ($('resetDatabaseBtn')) {
    $('resetDatabaseBtn').onclick = () => {
      if (!confirm('Tens a certeza absoluta que queres apagar TODOS os movimentos, objetivos e cartões guardados neste dispositivo? Esta ação não pode ser anulada.')) return;
      state = createInitialState();
      saveLocalState(state);
      selectedCycleKey = null;
      movementCycleKey = null;
      render();
      showToast('Base de dados local limpa.');
    };
  }

  let deferredInstallPrompt = null;
  function updateInstallAppUi() {
    const statusEl = $('installAppStatus');
    const btnEl = $('installPwaBtn');
    const guideEl = $('installManualGuide');
    const badgeEl = $('installAppBadge');
    if (!statusEl || !btnEl) return;

    const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
    const ua = navigator.userAgent || '';
    const isIos = /iPhone|iPad|iPod/i.test(ua);

    if (isStandalone) {
      statusEl.className = 'alert good';
      statusEl.innerHTML = '✅ <b>UnoFin já está instalada!</b> Estás a usar a versão em modo aplicação (ecrã inteiro).';
      btnEl.hidden = true;
      if (badgeEl) badgeEl.textContent = 'Instalada';
      if (guideEl) guideEl.hidden = true;
    } else if (deferredInstallPrompt) {
      statusEl.className = 'alert good';
      statusEl.innerHTML = '📲 <b>Pronta a instalar!</b> Podes adicionar a UnoFin ao ecrã principal ou ambiente de trabalho com um toque.';
      btnEl.hidden = false;
      if (guideEl) guideEl.hidden = true;
    } else {
      statusEl.className = 'alert';
      statusEl.innerHTML = '💡 <b>Instalação no teu dispositivo:</b> Adiciona a UnoFin ao ecrã inicial para acesso rápido e proteção de dados locais.';
      btnEl.hidden = false;
      if (guideEl) {
        guideEl.hidden = false;
        guideEl.innerHTML = isIos
          ? '<b>No iPhone / iPad (Safari):</b><br>1. Toca no botão <b>Partilhar</b> (quadrado com seta para cima na barra inferior).<br>2. Desliza para baixo e toca em <b>"Adicionar ao ecrã principal"</b>.<br>3. Confirma tocando em <b>Adicionar</b>.'
          : '<b>No Android (Chrome) ou PC (Edge / Chrome):</b><br>1. Abre o menu do navegador (<b>⋮</b> no canto superior direito).<br>2. Escolhe <b>"Instalar aplicação"</b> ou <b>"Adicionar ao ecrã principal"</b>.';
      }
    }
  }

  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updateInstallAppUi();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updateInstallAppUi();
    showToast('UnoFin instalada com sucesso!', { type: 'success' });
  });

  if ($('installPwaBtn')) {
    $('installPwaBtn').onclick = async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        const { outcome } = await deferredInstallPrompt.userChoice;
        if (outcome === 'accepted') deferredInstallPrompt = null;
        updateInstallAppUi();
      } else {
        const guideEl = $('installManualGuide');
        if (guideEl) {
          guideEl.hidden = false;
          guideEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
        showToast('Segue os passos abaixo para adicionar ao ecrã inicial.');
      }
    };
  }
  updateInstallAppUi();

  if ($('quickTxForm')) {
    $('quickTxForm').onsubmit = e => {
      e.preventDefault();
      const val = evaluateAmountExpression($('qAmount').value);
      if (!Number.isFinite(val) || val <= 0) { alert('Introduz um valor válido.'); $('qAmount').focus(); return; }
      const tp = $('qType').value;
      const ccId = tp === 'expense' && $('qCard')?.value ? $('qCard').value : null;
      if (tp === 'cc_payment' && !$('qCard')?.value) { alert('Seleciona o cartão a liquidar.'); $('qCard').focus(); return; }
      const desc = $('qDesc').value.trim();
      const cat = tp === 'expense' ? $('qCategory').value : tp === 'cc_payment' ? 'Pagamento de cartão' : tp === 'income' ? 'Rendimento' : 'Poupança';

      const newTx = {
        id: uid('tx'),
        date: $('qDate').value || iso(),
        type: tp,
        description: desc,
        amount: Number(val.toFixed(2)),
        category: cat,
        person: getUserDisplayName(state),
        status: 'confirmed',
        credit_card_id: tp === 'cc_payment' ? $('qCard').value : ccId,
        counts_for_cycle: true,
        updated_at: Date.now()
      };
      state.transactions.push(newTx);
      saveLocalState(state);
      $('qDesc').value = '';
      $('qAmount').value = '';
      render();
      haptic([12, 20, 12]);
      showToast('Movimento registado!', { type: 'success' });
    };
  }

  function openReconcileModal() {
    const cycles = buildCycles(state);
    const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
    const curBal = Number(computeCycleBalance(state, cycle, iso()).toFixed(2));
    $('recCurrentAppBal').textContent = eur(curBal);
    $('recRealBankBalance').value = '';
    $('recDiffRow').hidden = true;
    $('reconcileModal').hidden = false;
    setTimeout(() => $('recRealBankBalance').focus(), 40);
  }
  if ($('openReconcileBtn')) $('openReconcileBtn').onclick = openReconcileModal;
  if ($('closeReconcileModalBtn')) $('closeReconcileModalBtn').onclick = () => { $('reconcileModal').hidden = true; };
  if ($('cancelReconcileBtn')) $('cancelReconcileBtn').onclick = () => { $('reconcileModal').hidden = true; };
  if ($('recRealBankBalance')) {
    $('recRealBankBalance').oninput = () => {
      const cycles = buildCycles(state);
      const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
      const curBal = Number(computeCycleBalance(state, cycle, iso()).toFixed(2));
      const realVal = parseFloat($('recRealBankBalance').value);
      if (!Number.isFinite(realVal)) { $('recDiffRow').hidden = true; return; }
      const diff = Number((realVal - curBal).toFixed(2));
      $('recDiffRow').hidden = false;
      $('recDiffPreview').textContent = diff === 0 ? '0,00 € (Sem diferença)' : `${diff > 0 ? '+' : ''}${eur(diff)}`;
      $('recDiffPreview').className = diff > 0 ? 'plus' : diff < 0 ? 'minus' : '';
    };
  }
  if ($('reconcileForm')) {
    $('reconcileForm').onsubmit = e => {
      e.preventDefault();
      const cycles = buildCycles(state);
      const cycle = cycles.find(c => c.key === selectedCycleKey) || currentCycle(cycles);
      const curBal = Number(computeCycleBalance(state, cycle, iso()).toFixed(2));
      const realVal = parseFloat($('recRealBankBalance').value);
      if (!Number.isFinite(realVal)) return;
      const diff = Number((realVal - curBal).toFixed(2));
      if (Math.abs(diff) < 0.01) {
        $('reconcileModal').hidden = true;
        showToast('O saldo já coincide exatamente com o banco!');
        return;
      }
      const adjTx = {
        id: uid('adj'),
        date: iso(),
        type: diff > 0 ? 'income' : 'expense',
        description: `Acerto de saldo bancário (${fmtDate(iso())})`,
        amount: Math.abs(diff),
        category: 'Acerto de saldo',
        person: getUserDisplayName(state),
        status: 'confirmed',
        counts_for_cycle: false,
        updated_at: Date.now()
      };
      state.transactions.push(adjTx);
      $('reconcileModal').hidden = true;
      mutate(adjTx);
      showToast(`Saldo acertado em ${diff > 0 ? '+' : ''}${eur(diff)}!`, { type: 'success' });
    };
  }

  render();
  initStorageProtectionAndBackupReminder();
  checkAutomaticCycleRollover();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  });
}

(function initSplashScreen() {
  const splash = document.getElementById('appSplashScreen');
  if (!splash) return;
  const hideSplash = () => {
    if (splash.classList.contains('is-hidden')) return;
    splash.classList.add('is-hidden');
    setTimeout(() => { splash.remove(); }, 460);
  };
  const minDelay = new Promise(resolve => setTimeout(resolve, 650));
  const domReady = document.readyState === 'complete'
    ? Promise.resolve()
    : new Promise(resolve => window.addEventListener('load', resolve, { once: true }));
  Promise.all([minDelay, domReady]).then(hideSplash);
  setTimeout(hideSplash, 2600);
})();

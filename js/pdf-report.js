import { eur, esc, fmtDate, sum, isPaid, iso } from './config.js';
import { cycleTransactions, computeCycleBalance, getUserDisplayName } from './finance-engine.js';

export function generateCyclePdfReport(state, cycle, customList = null, customTitle = null) {
  let container = document.getElementById('printReportContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'printReportContainer';
    container.className = 'print-only-report';
    document.body.appendChild(container);
  }

  const txList = customList || cycleTransactions(state, cycle).filter(t => t.date <= iso());
  const paidTx = txList.filter(isPaid);
  const inc = sum(paidTx.filter(t => t.type === 'income'));
  const exp = sum(paidTx.filter(t => t.type === 'expense' && !t.credit_card_id)) + sum(paidTx.filter(t => t.type === 'cc_payment'));
  const sav = sum(paidTx.filter(t => t.type === 'saving')) - sum(paidTx.filter(t => t.type === 'saving_withdraw'));
  const bal = customList ? inc - exp - sav : computeCycleBalance(state, cycle, iso());
  const owner = getUserDisplayName(state);

  const catTotals = new Map();
  paidTx.filter(t => t.type === 'expense').forEach(t => {
    catTotals.set(t.category, (catTotals.get(t.category) || 0) + (Number(t.amount) || 0));
  });
  const catRows = [...catTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([cat, val]) => `<tr><td>${esc(cat)}</td><td class="num">${eur(val)}</td></tr>`)
    .join('') || '<tr><td colspan="2">Sem despesas registadas.</td></tr>';

  const txRows = [...txList]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(t => {
      const sign = t.type === 'income' ? '+' : '−';
      const cls = t.type === 'income' ? 'pos' : 'neg';
      return `<tr>
        <td>${fmtDate(t.date)}</td>
        <td>${esc(t.description)}</td>
        <td>${esc(t.category)}</td>
        <td class="num ${cls}">${sign} ${eur(t.amount)}</td>
      </tr>`;
    })
    .join('') || '<tr><td colspan="4">Sem movimentos no período.</td></tr>';

  container.innerHTML = `
    <div class="rep-header">
      <div>
        <div class="rep-brand">UNOFIN · GESTÃO FINANCEIRA PESSOAL</div>
        <h1>${esc(customTitle || `Relatório Financeiro — ${cycle.monthLabel}`)}</h1>
        <div class="rep-sub">Período: ${fmtDate(cycle.start)} a ${fmtDate(cycle.end)} · Titular: ${esc(owner)}</div>
      </div>
      <div class="rep-meta">Emitido em<br><b>${fmtDate(iso())}</b></div>
    </div>

    <div class="rep-kpis">
      <div class="rep-kpi"><span>Rendimentos</span><b class="pos">${eur(inc)}</b></div>
      <div class="rep-kpi"><span>Despesas pagas</span><b class="neg">${eur(exp)}</b></div>
      <div class="rep-kpi"><span>Poupança líquida</span><b>${eur(sav)}</b></div>
      <div class="rep-kpi"><span>Saldo do período</span><b class="${bal < 0 ? 'neg' : 'pos'}">${eur(bal)}</b></div>
    </div>

    <h3>Resumo por categoria</h3>
    <table class="rep-table">
      <thead><tr><th>Categoria</th><th class="num">Total</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table>

    <h3>Detalhe de movimentos (${txList.length})</h3>
    <table class="rep-table">
      <thead><tr><th>Data</th><th>Descrição</th><th>Categoria</th><th class="num">Valor</th></tr></thead>
      <tbody>${txRows}</tbody>
    </table>
  `;

  window.print();
}

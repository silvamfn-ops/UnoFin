import { daysBetween } from './config.js';

export function evaluateStatementDuplicates(rows, existingTransactions, opts = {}) {
  const dayWindow = opts.dayWindow ?? 3;
  const active = (existingTransactions || []).filter(t => !t.deleted_at);

  return rows.map(r => {
    const match = active.find(tx => {
      if (Math.abs((Number(tx.amount) || 0) - (Number(r.amount) || 0)) > 0.01) return false;
      if (tx.type !== r.type) return false;
      const diff = Math.abs(daysBetween(tx.date, r.date));
      return diff <= dayWindow;
    });

    if (match) {
      return {
        ...r,
        isDuplicate: true,
        matchedTx: match,
        duplicateReason: `Já existe movimento de ${match.amount.toFixed(2)} € em ${match.date}`,
        selected: false
      };
    }
    return { ...r, isDuplicate: false, matchedTx: null, duplicateReason: '', selected: true };
  });
}

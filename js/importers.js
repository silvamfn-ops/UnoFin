const BUILTIN_KEYWORDS = [
  { keys: ['CONTINENTE', 'PINGO DOCE', 'LIDL', 'ALDI', 'AUCHAN', 'MERCADONA', 'INTERMARCHE', 'MINIPRECO'], cat: 'Supermercado & Casa' },
  { keys: ['EDP', 'ENDESA', 'IBERDROLA', 'GOLDENERGY', 'EPAL', 'AGUAS', 'MEO', 'NOS', 'VODAFONE', 'DIGI', 'GALP GAS'], cat: 'Contas & Serviços' },
  { keys: ['GALP', 'REPSOL', 'BP ', 'CEPSA', 'PRIO', 'VIA VERDE', 'CP ', 'METRO', 'CARRIS', 'UBER', 'BOLT'], cat: 'Transportes & Combustível' },
  { keys: ['RESTAURANTE', 'CAFE', 'MC DONALD', 'MCDONALD', 'BURGER', 'PIZZA', 'CINEMA', 'SPOTIFY', 'NETFLIX'], cat: 'Restaurantes & Lazer' },
  { keys: ['FARMACIA', 'CLINICA', 'HOSPITAL', 'WELLS', 'CUF', 'LUSIADAS', 'MEDIS', 'MULTICARE'], cat: 'Saúde & Bem-estar' },
  { keys: ['ZARA', 'PRIMARK', 'DECATHLON', 'FNAC', 'WORTEN', 'AMAZON', 'IKEA', 'LEROY'], cat: 'Compras & Vestuário' }
];

export function guessCategory(state, description) {
  const upper = String(description || '').toUpperCase();
  const activeCats = new Set((state.categories || []).filter(c => !c.deleted_at).map(c => c.name));
  const fallback = activeCats.has('Outros') ? 'Outros' : ([...activeCats][0] || 'Outros');

  const userRules = (state.meta?.category_rules || []).slice().sort((a, b) => (b.hits || 0) - (a.hits || 0));
  for (const r of userRules) {
    if (r.keyword && upper.includes(r.keyword.toUpperCase()) && activeCats.has(r.category)) {
      return r.category;
    }
  }
  for (const item of BUILTIN_KEYWORDS) {
    if (item.keys.some(k => upper.includes(k)) && activeCats.has(item.cat)) {
      return item.cat;
    }
  }
  return fallback;
}

export function learnCategoryRule(state, description, category) {
  const clean = String(description || '')
    .toUpperCase()
    .replace(/\d+/g, ' ')
    .replace(/[^A-ZÀ-ÿ\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length >= 4)
    .slice(0, 2)
    .join(' ');
  if (!clean) return;
  state.meta = state.meta || { category_rules: [], handled_rollovers: [] };
  state.meta.category_rules = state.meta.category_rules || [];
  const existing = state.meta.category_rules.find(r => r.keyword.toUpperCase() === clean);
  if (existing) {
    existing.category = category;
    existing.hits = (existing.hits || 1) + 1;
  } else {
    state.meta.category_rules.push({ keyword: clean, category, hits: 1 });
  }
}

export async function extractLinesFromPdf(file) {
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
        resolve();
      };
      s.onerror = () => reject(new Error('Não foi possível carregar o leitor de PDF (verifica a ligação à internet ou usa CSV).'));
      document.head.appendChild(s);
    });
  }
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const byY = new Map();
    for (const item of content.items) {
      const y = Math.round(item.transform[5] / 4) * 4;
      const arr = byY.get(y) || [];
      arr.push({ x: item.transform[4], str: item.str });
      byY.set(y, arr);
    }
    const sortedYs = [...byY.keys()].sort((a, b) => b - a);
    for (const y of sortedYs) {
      const rowStr = byY.get(y).sort((a, b) => a.x - b.x).map(i => i.str).join(' ').replace(/\s+/g, ' ').trim();
      if (rowStr) lines.push(rowStr);
    }
  }
  return lines;
}

function normalizeDateToken(tok) {
  const mIso = tok.match(/^(\d{4})[-/](\d{2})[-/](\d{2})$/);
  if (mIso) return `${mIso[1]}-${mIso[2]}-${mIso[3]}`;
  const mPt = tok.match(/^(\d{2})[-/.](\d{2})[-/.](\d{4})$/);
  if (mPt) return `${mPt[3]}-${mPt[2]}-${mPt[1]}`;
  return null;
}

export function parseStatementLines(state, lines) {
  const results = [];
  const dateRe = /(\d{4}[-/]\d{2}[-/]\d{2}|\d{2}[-/.]\d{2}[-/.]\d{4})/;
  const amtRe = /([+-]?\s*\d{1,3}(?:[.\s]\d{3})*,\d{2}|[+-]?\s*\d+\.\d{2})\s*€?$/;

  for (const rawLine of lines) {
    const line = String(rawLine || '').trim();
    if (line.length < 8) continue;

    // Suporte CSV simples separado por ;
    if (line.includes(';')) {
      const parts = line.split(';').map(p => p.replace(/^"|"$/g, '').trim());
      const d = parts.map(normalizeDateToken).find(Boolean);
      const numPart = [...parts].reverse().find(p => /^[+-]?\s*\d+(?:[.,]\d{1,2})?$/.test(p.replace(/[€\s]/g, '')));
      if (d && numPart) {
        const val = parseFloat(numPart.replace(/[€\s]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'));
        if (Number.isFinite(val) && val !== 0) {
          const desc = parts.find(p => p !== numPart && !normalizeDateToken(p) && p.length > 2) || 'Movimento importado';
          const type = val > 0 ? 'income' : 'expense';
          results.push({
            date: d,
            description: desc,
            amount: Math.abs(val),
            type,
            category: type === 'expense' ? guessCategory(state, desc) : 'Rendimento',
            selected: true
          });
          continue;
        }
      }
    }

    const dm = line.match(dateRe);
    const am = line.match(amtRe);
    if (!dm || !am) continue;

    const date = normalizeDateToken(dm[1]);
    if (!date) continue;

    const rawNum = am[1].replace(/\s/g, '');
    const normalizedNum = rawNum.includes(',') ? rawNum.replace(/\./g, '').replace(',', '.') : rawNum;
    const val = parseFloat(normalizedNum);
    if (!Number.isFinite(val) || val === 0) continue;

    let desc = line.slice(dm.index + dm[0].length, am.index).replace(dateRe, '').replace(/\s+/g, ' ').trim();
    if (!desc || desc.length < 2) desc = 'Movimento bancário';

    const type = val > 0 ? 'income' : 'expense';
    results.push({
      date,
      description: desc,
      amount: Math.abs(val),
      type,
      category: type === 'expense' ? guessCategory(state, desc) : 'Rendimento',
      selected: true
    });
  }
  return results;
}

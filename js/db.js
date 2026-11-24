import { uid } from './config.js';

const STORAGE_KEY = 'unofin_state_v1';

export const DEFAULT_CATEGORIES = [
  { name: 'Supermercado & Casa', budget: 300, sort_order: 1 },
  { name: 'Contas & Serviços', budget: 180, sort_order: 2 },
  { name: 'Transportes & Combustível', budget: 120, sort_order: 3 },
  { name: 'Restaurantes & Lazer', budget: 150, sort_order: 4 },
  { name: 'Saúde & Bem-estar', budget: 60, sort_order: 5 },
  { name: 'Compras & Vestuário', budget: 80, sort_order: 6 },
  { name: 'Outros', budget: 50, sort_order: 7 }
];

export function createInitialState() {
  const now = Date.now();
  return {
    version: '1.0.0',
    household: {
      id: null,
      adult1_name: 'Pessoal',
      adult2_name: '',
      cycle_grouping_days: 14,
      updated_at: now
    },
    categories: DEFAULT_CATEGORIES.map(c => ({
      id: uid('cat'),
      name: c.name,
      budget: c.budget,
      sort_order: c.sort_order,
      updated_at: now,
      deleted_at: null
    })),
    credit_cards: [],
    savings_goals: [],
    recurring_expenses: [],
    transactions: [],
    meta: {
      category_rules: [],
      handled_rollovers: [],
      updated_at: now
    }
  };
}

export function loadLocalState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      const init = createInitialState();
      saveLocalState(init);
      return init;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return createInitialState();
    return {
      version: '1.0.0',
      household: {
        id: null,
        adult1_name: 'Pessoal',
        adult2_name: '',
        cycle_grouping_days: 14,
        ...(parsed.household || {})
      },
      categories: Array.isArray(parsed.categories) ? parsed.categories : createInitialState().categories,
      credit_cards: Array.isArray(parsed.credit_cards) ? parsed.credit_cards : [],
      savings_goals: Array.isArray(parsed.savings_goals) ? parsed.savings_goals : [],
      recurring_expenses: Array.isArray(parsed.recurring_expenses) ? parsed.recurring_expenses : [],
      transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
      meta: {
        category_rules: Array.isArray(parsed.meta?.category_rules) ? parsed.meta.category_rules : [],
        handled_rollovers: Array.isArray(parsed.meta?.handled_rollovers) ? parsed.meta.handled_rollovers : [],
        updated_at: parsed.meta?.updated_at || Date.now()
      }
    };
  } catch {
    return createInitialState();
  }
}

export function saveLocalState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Erro ao guardar estado local:', err);
  }
}

export function convertLegacyV1Backup(json) {
  const base = createInitialState();
  const now = Date.now();
  if (!json || typeof json !== 'object') throw new Error('Ficheiro JSON inválido.');

  if (json.household) {
    base.household.adult1_name = json.household.adult1_name || 'Pessoal';
    base.household.adult2_name = '';
    base.household.cycle_grouping_days = Number(json.household.cycle_grouping_days ?? 14);
  }
  if (Array.isArray(json.categories) && json.categories.length) {
    base.categories = json.categories.map((c, idx) => ({
      id: c.id || uid('cat'),
      name: String(c.name || 'Categoria'),
      budget: Number(c.budget) || 0,
      sort_order: Number(c.sort_order) || idx + 1,
      updated_at: now,
      deleted_at: c.deleted_at || null
    }));
  }
  if (Array.isArray(json.credit_cards)) {
    base.credit_cards = json.credit_cards.map(c => ({
      id: c.id || uid('cc'),
      name: String(c.name || 'Cartão'),
      card_limit: Number(c.card_limit) || 0,
      initial_debt: Number(c.initial_debt) || 0,
      owner: base.household.adult1_name,
      updated_at: now,
      deleted_at: c.deleted_at || null
    }));
  }
  if (Array.isArray(json.savings_goals)) {
    base.savings_goals = json.savings_goals.map(g => ({
      id: g.id || uid('goal'),
      name: String(g.name || 'Objetivo'),
      target: Number(g.target) || 0,
      deadline: g.deadline || null,
      status: g.status || 'active',
      updated_at: now,
      deleted_at: g.deleted_at || null
    }));
  }
  if (Array.isArray(json.recurring_expenses)) {
    base.recurring_expenses = json.recurring_expenses.map(r => ({
      id: r.id || uid('rec'),
      description: String(r.description || 'Serviço'),
      category: String(r.category || 'Contas & Serviços'),
      entity: r.entity || '',
      payment_ref: r.payment_ref || '',
      amount: Number(r.amount) || 0,
      person: base.household.adult1_name,
      day_of_month: Number(r.day_of_month) || 1,
      start_month: r.start_month || null,
      end_month: r.end_month || null,
      active: r.active !== false,
      cycle_payments: r.cycle_payments || {},
      updated_at: now,
      deleted_at: r.deleted_at || null
    }));
  }
  if (Array.isArray(json.transactions)) {
    base.transactions = json.transactions.map(t => ({
      id: t.id || uid('tx'),
      date: String(t.date || ''),
      type: String(t.type || 'expense'),
      description: String(t.description || ''),
      amount: Number(t.amount) || 0,
      category: String(t.category || 'Outros'),
      person: t.type === 'transfer' && String(t.person || '').includes('→') ? t.person : base.household.adult1_name,
      status: t.status || 'confirmed',
      credit_card_id: t.credit_card_id || null,
      goal_id: t.goal_id || null,
      installment_group_id: t.installment_group_id || null,
      occurrence_key: t.occurrence_key || null,
      counts_for_cycle: t.counts_for_cycle !== false,
      updated_at: now,
      deleted_at: t.deleted_at || null
    }));
  }
  if (json.meta) {
    base.meta.category_rules = Array.isArray(json.meta.category_rules) ? json.meta.category_rules : [];
    base.meta.handled_rollovers = Array.isArray(json.meta.handled_rollovers) ? json.meta.handled_rollovers : [];
  }
  return base;
}

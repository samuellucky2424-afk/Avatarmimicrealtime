// @ts-nocheck
export const DB_TABLES = {
  users: 'kusers',
  wallets: 'kwallets',
  transactions: 'ktransactions',
  sessions: 'ksessions',
  plans: 'kplans',
  subscriptions: 'ksubscriptions',
  exchangeRates: 'kexchange_rates',
  admins: 'kadmins',
  creditAdjustments: 'kcredit_adjustments',
  auditLog: 'kaudit_log',
};

export const DB_RPC = {
  getUserCredits: 'kget_user_credits',
  deductCredits: 'kdeduct_credits',
  addCredits: 'kadd_credits',
  isAdmin: 'kis_admin',
  isCurrentUserAdmin: 'kis_current_user_admin',
  adminListUsers: 'kadmin_list_users',
  adminSetCredits: 'kadmin_set_credits',
  adminSetBlocked: 'kadmin_set_blocked',
  adminUpsertPlan: 'kadmin_upsert_plan',
  adminDeletePlan: 'kadmin_delete_plan',
  adminStats: 'kadmin_stats',
};

const LEGACY_TO_CLONE_TABLE = {
  users: DB_TABLES.users,
  wallets: DB_TABLES.wallets,
  transactions: DB_TABLES.transactions,
  sessions: DB_TABLES.sessions,
  plans: DB_TABLES.plans,
  subscriptions: DB_TABLES.subscriptions,
  exchange_rates: DB_TABLES.exchangeRates,
  admins: DB_TABLES.admins,
  credit_adjustments: DB_TABLES.creditAdjustments,
  audit_log: DB_TABLES.auditLog,
};

const LEGACY_TO_CLONE_RPC = {
  get_user_credits: DB_RPC.getUserCredits,
  deduct_credits: DB_RPC.deductCredits,
  add_credits: DB_RPC.addCredits,
  is_admin: DB_RPC.isAdmin,
  is_current_user_admin: DB_RPC.isCurrentUserAdmin,
  admin_list_users: DB_RPC.adminListUsers,
  admin_set_credits: DB_RPC.adminSetCredits,
  admin_set_blocked: DB_RPC.adminSetBlocked,
  admin_upsert_plan: DB_RPC.adminUpsertPlan,
  admin_delete_plan: DB_RPC.adminDeletePlan,
  admin_stats: DB_RPC.adminStats,
};

export function mapDbTableName(table) {
  return LEGACY_TO_CLONE_TABLE[table] || table;
}

export function mapDbRpcName(fn) {
  return LEGACY_TO_CLONE_RPC[fn] || fn;
}

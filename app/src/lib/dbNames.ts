export const DB_TABLES = {
  users: 'users',
  wallets: 'wallets',
  transactions: 'transactions',
  sessions: 'sessions',
  plans: 'plans',
  subscriptions: 'subscriptions',
  exchangeRates: 'exchange_rates',
  admins: 'admins',
  creditAdjustments: 'credit_adjustments',
  auditLog: 'audit_log',
  notifications: 'notifications',
} as const;

export const DB_RPC = {
  isCurrentUserAdmin: 'is_current_user_admin',
  adminListUsers: 'admin_list_users',
  adminSetCredits: 'admin_set_credits',
  adminSetBlocked: 'admin_set_blocked',
  adminUpsertPlan: 'admin_upsert_plan',
  adminDeletePlan: 'admin_delete_plan',
  adminStats: 'admin_stats',
} as const;

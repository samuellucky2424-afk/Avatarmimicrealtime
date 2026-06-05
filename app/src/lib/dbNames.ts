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
} as const;

export const DB_RPC = {
  isCurrentUserAdmin: 'kis_current_user_admin',
  adminListUsers: 'kadmin_list_users',
  adminSetCredits: 'kadmin_set_credits',
  adminSetBlocked: 'kadmin_set_blocked',
  adminUpsertPlan: 'kadmin_upsert_plan',
  adminDeletePlan: 'kadmin_delete_plan',
  adminStats: 'kadmin_stats',
} as const;

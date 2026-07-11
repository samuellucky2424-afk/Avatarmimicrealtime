// @ts-nocheck
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

export const supabaseAdminConfigError = !supabaseUrl
  ? 'Missing SUPABASE_URL or VITE_SUPABASE_URL'
  : !supabaseServiceKey
    ? 'Missing SUPABASE_SERVICE_KEY or SUPABASE_SERVICE_ROLE_KEY'
    : null;

const rawSupabaseAdmin = (supabaseUrl && supabaseServiceKey)
  ? createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false }
    })
  : null;

const TABLE_NAMES = {
  users: 'users',
  wallets: 'wallets',
  transactions: 'transactions',
  sessions: 'sessions',
  plans: 'plans',
  subscriptions: 'subscriptions',
  exchange_rates: 'exchange_rates',
  admins: 'admins',
  credit_adjustments: 'credit_adjustments',
  audit_log: 'audit_log',
};

const RPC_NAMES = {
  get_user_credits: 'get_user_credits',
  deduct_credits: 'deduct_credits',
  add_credits: 'add_credits',
  is_admin: 'is_admin',
  is_current_user_admin: 'is_current_user_admin',
  admin_list_users: 'admin_list_users',
  admin_set_credits: 'admin_set_credits',
  admin_set_blocked: 'admin_set_blocked',
  admin_upsert_plan: 'admin_upsert_plan',
  admin_delete_plan: 'admin_delete_plan',
  admin_stats: 'admin_stats',
};

function createMappedSupabaseClient(client) {
  if (!client) return null;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'from') {
        return (table) => target.from(TABLE_NAMES[table] || table);
      }

      if (prop === 'rpc') {
        return (fn, args, options) => target.rpc(RPC_NAMES[fn] || fn, args, options);
      }

      return Reflect.get(target, prop, receiver);
    },
  });
}

export const supabaseAdmin = rawSupabaseAdmin
  ? createMappedSupabaseClient(rawSupabaseAdmin)
  : null;

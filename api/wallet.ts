// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { requireSupabaseUser } from '../shared/paystack-payment.js';

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!supabaseAdmin) {
    return res.status(200).json({
      balance: 0,
      credits: 0,
      transactions: [],
      warning: supabaseAdminConfigError || 'Supabase admin is not configured'
    });
  }
  
  const userId = req.query.userId || req.query.id;
  if (!userId) return res.status(400).json({ error: 'User ID is required' });

  try {
    const auth = await requireSupabaseUser(supabaseAdmin, req);
    if (!auth.ok) {
      return res.status(auth.statusCode).json({ error: auth.message });
    }
    if (auth.user.id !== userId) {
      return res.status(403).json({ error: 'Wallet user does not match the current session' });
    }

    const { data: wallet, error: walletError } = await supabaseAdmin
      .from('wallets')
      .select('credits')
      .eq('user_id', userId)
      .maybeSingle();
    if (walletError) {
      return res.status(500).json({ error: walletError.message || 'wallet query failed' });
    }

    const { data: transactionsData, error: transactionsError } = await supabaseAdmin
      .from('transactions')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (transactionsError) {
      console.error('[api/wallet] transactions query failed:', transactionsError);
      return res.status(500).json({ error: transactionsError.message || 'transactions query failed' });
    }
    const txs = transactionsData;
    
    // Map DB columns to our frontend transaction structure
    const mappedTxs = (txs || []).map(tx => ({
      id: tx.id,
      type: tx.type,
      amount: tx.amount,
      credits: tx.credits || 0,
      description: tx.description || (tx.type === 'credit' ? 'Credits purchased' : 'Session usage'),
      timestamp: tx.created_at,
    }));
    
    res.json({
      balance: 0,
      credits: wallet?.credits || 0,
      transactions: mappedTxs
    });
  } catch (error) {
    console.error('[api/wallet] unexpected error:', error);
    res.status(500).json({ error: error?.message || 'Internal server error' });
  }
}

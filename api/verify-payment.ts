// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import {
  applyVerifiedPaystackPayment,
  getPaystackPaymentContext,
  getPaystackSecretKey,
  requireSupabaseUser,
  verifyPaystackTransaction,
} from './paystack.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ status: 'failed', message: 'Method not allowed' });
  if (!supabaseAdmin) return res.status(503).json({ status: 'failed', message: supabaseAdminConfigError });

  const secretKey = getPaystackSecretKey(process.env);
  if (!secretKey) {
    return res.status(503).json({ status: 'failed', message: 'Missing PAYSTACK_SECRET_KEY' });
  }

  const reference = String(req.body?.reference || req.body?.transactionId || '').trim();
  if (!reference) {
    return res.status(400).json({ status: 'failed', message: 'Missing Paystack payment reference' });
  }

  try {
    const auth = await requireSupabaseUser(supabaseAdmin, req);
    if (!auth.ok) {
      return res.status(auth.statusCode).json({ status: 'failed', message: auth.message });
    }

    const transaction = await verifyPaystackTransaction(secretKey, reference);
    const context = getPaystackPaymentContext(transaction, { reference });

    if (context.userId && context.userId !== auth.user.id) {
      return res.status(403).json({ status: 'failed', message: 'Payment reference belongs to another user' });
    }

    const result = await applyVerifiedPaystackPayment(supabaseAdmin, transaction, { reference });

    if (result.status === 'pending') {
      return res.status(202).json(result);
    }

    if (result.status !== 'success') {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (error) {
    console.error('[api/verify-payment] Paystack verification failed:', error);
    return res.status(500).json({
      status: 'failed',
      message: error?.message || 'Unable to verify Paystack payment',
    });
  }
}

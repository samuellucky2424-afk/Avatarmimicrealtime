// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import {
  createPaystackReference,
  getPaystackSecretKey,
  initializePaystackTransaction,
  requireSupabaseUser,
  resolvePaystackPlan,
} from './paystack.js';

function normalizeOrigin(req) {
  const origin = req.headers.origin || req.headers.referer;
  if (typeof origin !== 'string') return null;

  try {
    return new URL(origin).origin;
  } catch {
    return null;
  }
}

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

  const {
    userId,
    email,
    name,
    planId,
    credits,
    planName,
  } = req.body || {};

  if (!userId || (!planId && !(Number(credits) > 0))) {
    return res.status(400).json({ status: 'failed', message: 'Missing Paystack checkout data' });
  }

  try {
    const auth = await requireSupabaseUser(supabaseAdmin, req);
    if (!auth.ok) {
      return res.status(auth.statusCode).json({ status: 'failed', message: auth.message });
    }

    if (auth.user.id !== userId) {
      return res.status(403).json({ status: 'failed', message: 'Payment user does not match the current session' });
    }

    const plan = await resolvePaystackPlan(supabaseAdmin, { planId, credits });
    const reference = createPaystackReference();
    const origin = normalizeOrigin(req);
    const result = await initializePaystackTransaction({
      secretKey,
      email: auth.user.email || email,
      amountNGN: plan.amountNGN,
      reference,
      callbackUrl: origin ? `${origin}/?reference=${encodeURIComponent(reference)}#/subscription` : null,
      metadata: {
        provider: 'paystack',
        app: 'techlordmedia',
        userId: auth.user.id,
        email: auth.user.email || email,
        name,
        planId: plan.id,
        credits: plan.credits,
        amountNGN: plan.amountNGN,
        planName: plan.name || planName,
      },
    });

    return res.json({
      ...result,
      planId: plan.id,
      planName: plan.name,
      credits: plan.credits,
      amountNGN: plan.amountNGN,
    });
  } catch (error) {
    console.error('[api/paystack-initialize] Paystack initialization failed:', error);
    return res.status(502).json({
      status: 'failed',
      message: error?.message || 'Unable to initialize Paystack payment',
    });
  }
}

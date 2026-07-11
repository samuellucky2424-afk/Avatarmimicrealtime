// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';

async function requireSupabaseUser(client, req) {
  const header = req?.headers?.authorization || req?.headers?.Authorization || '';
  const token = String(header).match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (!token) return { ok: false, statusCode: 401, message: 'Missing authorization token' };
  const { data, error } = await client.auth.getUser(token);
  if (error || !data?.user?.id) return { ok: false, statusCode: 401, message: 'Invalid authorization token' };
  return { ok: true, user: data.user };
}

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;
const SESSION_BILLING_GRACE_SECONDS = 20;

function normalizeCredits(value) {
  const credits = Number(value ?? 0);
  return Number.isFinite(credits) ? credits : 0;
}

function getBillableSeconds(startTime) {
  const timestamp = new Date(startTime).getTime();
  if (!Number.isFinite(timestamp)) {
    return 0;
  }

  const elapsedSeconds = Math.floor((Date.now() - timestamp) / 1000);
  const billableSeconds = Math.max(elapsedSeconds - SESSION_BILLING_GRACE_SECONDS, 0);
  return Math.min(billableSeconds, MAX_BILLABLE_SECONDS);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const userId = req.query.userId || req.query.id;
  const sessionId = req.query.sessionId;
  if (!userId || !sessionId) return res.status(400).json({ error: 'User ID and session ID are required' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const auth = await requireSupabaseUser(supabaseAdmin, req);
    if (!auth.ok) {
      return res.status(auth.statusCode).json({ error: auth.message });
    }
    if (auth.user.id !== userId) {
      return res.status(403).json({ error: 'Session user does not match the current session' });
    }

    const [walletResult, activeSessionResult] = await Promise.all([
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
      supabaseAdmin
        .from('sessions')
        .select('id, start_time')
        .eq('id', sessionId)
        .eq('user_id', userId)
        .eq('status', 'active')
        .maybeSingle(),
    ]);

    if (walletResult.error) {
      console.error('Failed to load wallet for session-status:', walletResult.error);
      return res.status(500).json({ error: 'Failed to load wallet' });
    }

    if (activeSessionResult.error) {
      console.error('Failed to load active session for session-status:', activeSessionResult.error);
      return res.status(500).json({ error: 'Failed to load active session' });
    }

    const walletData = walletResult.data;
    const activeSession = activeSessionResult.data;

    const walletCredits = normalizeCredits(walletData?.credits);

    if (!activeSession) {
      return res.json({ credits: walletCredits, remainingCredits: walletCredits, shouldStop: walletCredits <= 0 });
    }

    // Compute live balance: wallet credits minus every second elapsed since start.
    // This is purely a read — no DB writes. The actual deduction happens in
    // end-session so the wallet value stays stable during streaming.
    const billableElapsed = getBillableSeconds(activeSession.start_time);
    const liveDeducted = Math.min(walletCredits, billableElapsed * CREDITS_PER_SECOND);
    const remainingCredits = Math.max(0, walletCredits - liveDeducted);
    const shouldStop = remainingCredits <= 0;

    return res.json({
      credits: remainingCredits,
      remainingCredits,
      elapsedSeconds: billableElapsed,
      shouldStop,
      forceEnd: shouldStop,
    });
  } catch (error) {
    console.error('session-status unexpected error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

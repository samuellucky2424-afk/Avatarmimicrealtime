// @ts-nocheck
import { supabaseAdmin, supabaseAdminConfigError } from './supabase.js';
import { logPaymentActivity } from '../../shared/payment-activity-log.js';
import { requireSupabaseUser } from '../../shared/paystack-payment.js';

const CREDITS_PER_SECOND = 2;
const MAX_BILLABLE_SECONDS = 7200;
const SESSION_BILLING_GRACE_SECONDS = 20;

function getAiServiceKey() {
  return process.env.DECART_API_KEY?.trim() || null;
}

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

async function billAndCloseExistingSession(session, userId, currentCredits) {
  const billableSeconds = getBillableSeconds(session.start_time);
  const creditsToDeduct = Math.min(currentCredits, billableSeconds * CREDITS_PER_SECOND);
  const remainingCredits = currentCredits - creditsToDeduct;

  const { data: closedRows, error: sessionUpdateError } = await supabaseAdmin
    .from('sessions')
    .update({
      end_time: new Date(),
      status: 'ended',
      seconds_used: billableSeconds,
      credits_used: creditsToDeduct,
    })
    .eq('id', session.id)
    .eq('status', 'active')
    .select('id');

  if (sessionUpdateError) {
    throw sessionUpdateError;
  }

  if (!closedRows || closedRows.length === 0) {
    await logPaymentActivity(supabaseAdmin, {
      event: 'orphan_session_close_skipped',
      severity: 'warning',
      userId,
      targetId: session.id,
      message: 'Previous active session was already closed before startup cleanup could bill it',
      payload: { sessionId: session.id },
    });
    return currentCredits;
  }

  if (creditsToDeduct > 0) {
    const { error: walletUpdateError } = await supabaseAdmin
      .from('wallets')
      .update({ credits: remainingCredits })
      .eq('user_id', userId);

    if (walletUpdateError) {
      throw walletUpdateError;
    }
  }

  await logPaymentActivity(supabaseAdmin, {
    event: 'orphan_session_billed_and_closed',
    userId,
    targetId: session.id,
    message: `Previous active session closed and billed ${creditsToDeduct} credits`,
    payload: {
      sessionId: session.id,
      beforeCredits: currentCredits,
      creditsDeducted: creditsToDeduct,
      afterCredits: remainingCredits,
      billableSeconds,
    },
  });

  return remainingCredits;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    if (!supabaseAdmin) {
      return res.status(503).json({ allowed: false, error: supabaseAdminConfigError || 'Supabase admin is not configured' });
    }

    const aiServiceKey = getAiServiceKey();
    if (!aiServiceKey) {
      return res.status(503).json({ allowed: false, error: 'The AI service is not configured on the server' });
    }

    const { userId } = req.body;
    if (!userId) return res.status(400).json({ allowed: false, error: 'User ID is required' });

    const auth = await requireSupabaseUser(supabaseAdmin, req);
    if (!auth.ok) {
      return res.status(auth.statusCode).json({ allowed: false, error: auth.message });
    }
    if (auth.user.id !== userId) {
      return res.status(403).json({ allowed: false, error: 'Session user does not match the current session' });
    }

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_start_requested',
      userId,
      targetId: userId,
      payload: {},
    });

    // Fetch any previous active sessions and the wallet in parallel.
    const [activeSessionsResult, walletResult] = await Promise.all([
      supabaseAdmin
        .from('sessions')
        .select('id, start_time')
        .eq('user_id', userId)
        .eq('status', 'active')
        .order('start_time', { ascending: true }),
      supabaseAdmin.from('wallets').select('credits').eq('user_id', userId).maybeSingle(),
    ]);

    if (activeSessionsResult.error) {
      console.error('Failed to load active sessions:', activeSessionsResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load active sessions' });
    }

    if (walletResult.error) {
      console.error('Failed to load wallet:', walletResult.error);
      return res.status(500).json({ allowed: false, error: 'Failed to load wallet' });
    }

    const existingActiveSessions = activeSessionsResult.data ?? [];
    const walletNow = walletResult.data;

    let runningCredits = normalizeCredits(walletNow?.credits);
    if (existingActiveSessions && existingActiveSessions.length > 0) {
      try {
        for (const session of existingActiveSessions) {
          runningCredits = await billAndCloseExistingSession(session, userId, runningCredits);
        }
      } catch (cleanupError) {
        console.error('Failed to bill and close previous sessions:', cleanupError);
        await logPaymentActivity(supabaseAdmin, {
          event: 'orphan_session_billing_failed',
          severity: 'error',
          userId,
          targetId: userId,
          message: cleanupError?.message || 'Failed to bill and close previous sessions',
          payload: { activeSessionCount: existingActiveSessions.length },
        });
        return res.status(500).json({ allowed: false, error: 'Failed to close previous sessions' });
      }

      await logPaymentActivity(supabaseAdmin, {
        event: 'orphan_sessions_billed',
        userId,
        targetId: userId,
        message: 'Previous active sessions were billed and closed during a new explicit start',
        payload: {
          activeSessionCount: existingActiveSessions.length,
          sessionIds: existingActiveSessions.map((session) => session.id),
          remainingCredits: runningCredits,
        },
      });
    }

    // Use the already-fetched and post-cleanup-billed credit balance.
    const userCredits = runningCredits;
    if (userCredits <= 0) {
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_start_denied_insufficient_credits',
        severity: 'warning',
        userId,
        targetId: userId,
        payload: { credits: userCredits },
      });
      return res.json({ allowed: false, error: 'Insufficient credits' });
    }

    // Expose a deterministic time budget to the client based on current credits.
    const maxSeconds = Math.floor(userCredits / CREDITS_PER_SECOND) + SESSION_BILLING_GRACE_SECONDS;

    const { data: newSession, error: sessionError } = await supabaseAdmin
      .from('sessions')
      .insert({
        user_id: userId,
        status: 'active',
        start_time: new Date(),
        credits_used: 0,
        seconds_used: 0,
      }).select('id').single();

    if (sessionError) {
      console.error('Failed to create session:', sessionError);
      await logPaymentActivity(supabaseAdmin, {
        event: 'session_start_failed',
        severity: 'error',
        userId,
        targetId: userId,
        message: sessionError.message,
        payload: { credits: userCredits },
      });
      return res.status(500).json({ allowed: false, error: 'Failed to create session' });
    }

    await logPaymentActivity(supabaseAdmin, {
      event: 'session_started',
      userId,
      targetId: newSession.id,
      payload: { sessionId: newSession.id, credits: userCredits, maxSeconds },
    });

    res.json({ allowed: true, sessionId: newSession.id, credits: userCredits, maxSeconds, token: aiServiceKey });
  } catch (error) {
    console.error('start-session unexpected error:', error);
    await logPaymentActivity(supabaseAdmin, {
      event: 'session_start_unexpected_error',
      severity: 'error',
      message: error?.message || 'Internal server error',
    });
    res.status(500).json({ allowed: false, error: 'Internal server error' });
  }
}

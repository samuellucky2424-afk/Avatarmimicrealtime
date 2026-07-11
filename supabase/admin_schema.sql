-- =============================================================================
-- SUREVIDEOTOOL — ADMIN SCHEMA, RLS, AND RPCs
-- Run this in Supabase SQL Editor AFTER schema.sql
-- Idempotent: safe to re-run.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- -----------------------------------------------------------------------------
-- 0. Make sure public.users mirrors auth.users (so RLS via auth.uid() works)
--    This trigger inserts a public.users row whenever a new auth user signs up.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.users (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user();

-- Backfill any existing auth users that don't have a public.users row yet
INSERT INTO public.users (id, email)
SELECT au.id, au.email FROM auth.users au
LEFT JOIN public.users u ON u.id = au.id
WHERE u.id IS NULL;

-- Make sure each user has a wallet
INSERT INTO public.wallets (user_id, credits)
SELECT u.id, 0 FROM public.users u
LEFT JOIN public.wallets w ON w.user_id = u.id
WHERE w.user_id IS NULL;

-- -----------------------------------------------------------------------------
-- 1. Add is_blocked flag on users
-- -----------------------------------------------------------------------------
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_blocked BOOLEAN DEFAULT FALSE;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS blocked_reason TEXT;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;

-- -----------------------------------------------------------------------------
-- 2. ADMINS TABLE
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admins (
    user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email   TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.admins ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins can read admins" ON public.admins;
CREATE POLICY "Admins can read admins" ON public.admins
    FOR SELECT USING (auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 3. is_admin() helper — used by other policies and by the frontend via RPC
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin(p_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (SELECT 1 FROM public.admins WHERE user_id = p_user);
$$;

-- Frontend-callable RPC: returns boolean for current logged-in user
CREATE OR REPLACE FUNCTION public.is_current_user_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.is_admin(auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.is_current_user_admin() TO authenticated, anon;

-- -----------------------------------------------------------------------------
-- 4. CREDIT ADJUSTMENTS (audit of admin credit edits)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.credit_adjustments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id  UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    admin_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    delta    INTEGER NOT NULL,
    new_balance INTEGER NOT NULL,
    reason   TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_credit_adjustments_user ON public.credit_adjustments(user_id);

ALTER TABLE public.credit_adjustments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read adjustments" ON public.credit_adjustments;
CREATE POLICY "Admins read adjustments" ON public.credit_adjustments
    FOR SELECT USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 5. AUDIT LOG (general admin actions)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action   TEXT NOT NULL,
    target_table TEXT,
    target_id    TEXT,
    payload  JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created ON public.audit_log(created_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins read audit" ON public.audit_log;
CREATE POLICY "Admins read audit" ON public.audit_log
    FOR SELECT USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 5b. USER NOTIFICATIONS
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.notifications (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    message     TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
    severity    TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_active_created
    ON public.notifications(is_active, created_at DESC);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users read active notifications" ON public.notifications;
CREATE POLICY "Users read active notifications" ON public.notifications
    FOR SELECT USING (is_active OR public.is_admin());

DROP POLICY IF EXISTS "Admins insert notifications" ON public.notifications;
CREATE POLICY "Admins insert notifications" ON public.notifications
    FOR INSERT WITH CHECK (public.is_admin() AND created_by = auth.uid());

DROP POLICY IF EXISTS "Admins update notifications" ON public.notifications;
CREATE POLICY "Admins update notifications" ON public.notifications
    FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins delete notifications" ON public.notifications;
CREATE POLICY "Admins delete notifications" ON public.notifications
    FOR DELETE USING (public.is_admin());

-- -----------------------------------------------------------------------------
-- 6. ADMIN-ONLY POLICIES on existing tables
-- -----------------------------------------------------------------------------
-- Plans: anyone reads, only admins write
DROP POLICY IF EXISTS "Admins manage plans" ON public.plans;
CREATE POLICY "Admins manage plans" ON public.plans
    FOR ALL USING (public.is_admin()) WITH CHECK (public.is_admin());

-- Users: admins can read & update everyone
DROP POLICY IF EXISTS "Admins read all users" ON public.users;
CREATE POLICY "Admins read all users" ON public.users
    FOR SELECT USING (public.is_admin() OR auth.uid() = id);

DROP POLICY IF EXISTS "Admins update users" ON public.users;
CREATE POLICY "Admins update users" ON public.users
    FOR UPDATE USING (public.is_admin() OR auth.uid() = id)
    WITH CHECK (public.is_admin() OR auth.uid() = id);

-- Wallets: admins can read & update everyone
DROP POLICY IF EXISTS "Admins read all wallets" ON public.wallets;
CREATE POLICY "Admins read all wallets" ON public.wallets
    FOR SELECT USING (public.is_admin() OR auth.uid() = user_id);

DROP POLICY IF EXISTS "Admins update wallets" ON public.wallets;
CREATE POLICY "Admins update wallets" ON public.wallets
    FOR UPDATE USING (public.is_admin() OR auth.uid() = user_id)
    WITH CHECK (public.is_admin() OR auth.uid() = user_id);

-- Transactions: admins read everything
DROP POLICY IF EXISTS "Admins read all transactions" ON public.transactions;
CREATE POLICY "Admins read all transactions" ON public.transactions
    FOR SELECT USING (public.is_admin() OR auth.uid() = user_id);

-- Sessions: admins read everything
DROP POLICY IF EXISTS "Admins read all sessions" ON public.sessions;
CREATE POLICY "Admins read all sessions" ON public.sessions
    FOR SELECT USING (public.is_admin() OR auth.uid() = user_id);

-- -----------------------------------------------------------------------------
-- 7. ADMIN RPCs (security definer — enforce admin check inside)
-- -----------------------------------------------------------------------------

-- 7a. List users with wallet credits + status
CREATE OR REPLACE FUNCTION public.admin_list_users(
    p_search TEXT DEFAULT NULL,
    p_limit  INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id UUID,
    email TEXT,
    credits INTEGER,
    is_blocked BOOLEAN,
    blocked_reason TEXT,
    created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN QUERY
    SELECT u.id, u.email,
           COALESCE(w.credits, 0) AS credits,
           COALESCE(u.is_blocked, FALSE) AS is_blocked,
           u.blocked_reason,
           u.created_at
    FROM public.users u
    LEFT JOIN public.wallets w ON w.user_id = u.id
    WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%'
    ORDER BY u.created_at DESC
    LIMIT p_limit OFFSET p_offset;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_list_users(TEXT, INTEGER, INTEGER) TO authenticated;

-- 7b. Set a user's credits to an absolute value
CREATE OR REPLACE FUNCTION public.admin_set_credits(
    p_user_id UUID,
    p_credits INTEGER,
    p_reason  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin   UUID := auth.uid();
    v_current INTEGER;
    v_delta   INTEGER;
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    IF p_credits < 0 THEN
        RAISE EXCEPTION 'Credits cannot be negative';
    END IF;

    -- Ensure wallet exists
    INSERT INTO public.wallets (user_id, credits) VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT credits INTO v_current FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
    v_delta := p_credits - COALESCE(v_current, 0);

    UPDATE public.wallets SET credits = p_credits WHERE user_id = p_user_id;

    INSERT INTO public.credit_adjustments (user_id, admin_id, delta, new_balance, reason)
    VALUES (p_user_id, v_admin, v_delta, p_credits, p_reason);

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'set_credits', 'wallets', p_user_id::TEXT,
            json_build_object('delta', v_delta, 'new_balance', p_credits, 'reason', p_reason));

    RETURN json_build_object('success', TRUE, 'new_credits', p_credits, 'delta', v_delta);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_credits(UUID, INTEGER, TEXT) TO authenticated;

-- 7c. Block / unblock a user
CREATE OR REPLACE FUNCTION public.admin_set_blocked(
    p_user_id UUID,
    p_blocked BOOLEAN,
    p_reason  TEXT DEFAULT NULL
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    UPDATE public.users
       SET is_blocked = p_blocked,
           blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
           blocked_at     = CASE WHEN p_blocked THEN NOW()    ELSE NULL END
     WHERE id = p_user_id;

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, CASE WHEN p_blocked THEN 'block_user' ELSE 'unblock_user' END,
            'users', p_user_id::TEXT,
            json_build_object('reason', p_reason));

    RETURN json_build_object('success', TRUE, 'is_blocked', p_blocked);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_set_blocked(UUID, BOOLEAN, TEXT) TO authenticated;

-- 7d. Upsert / update a plan
CREATE OR REPLACE FUNCTION public.admin_upsert_plan(
    p_id        UUID,
    p_name      TEXT,
    p_credits   INTEGER,
    p_usd_price NUMERIC
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
    v_id    UUID;
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.plans (name, credits, usd_price)
        VALUES (p_name, p_credits, p_usd_price)
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.plans
           SET name = p_name, credits = p_credits, usd_price = p_usd_price
         WHERE id = p_id
        RETURNING id INTO v_id;
    END IF;

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'upsert_plan', 'plans', v_id::TEXT,
            json_build_object('name', p_name, 'credits', p_credits, 'usd_price', p_usd_price));

    RETURN json_build_object('success', TRUE, 'id', v_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_upsert_plan(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;

-- 7e. Delete a plan
CREATE OR REPLACE FUNCTION public.admin_delete_plan(p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v_admin UUID := auth.uid();
BEGIN
    IF NOT public.is_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    DELETE FROM public.plans WHERE id = p_id;

    INSERT INTO public.audit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'delete_plan', 'plans', p_id::TEXT, '{}'::JSONB);

    RETURN json_build_object('success', TRUE);
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_delete_plan(UUID) TO authenticated;

-- 7f. Admin stats (totals for dashboard cards)
CREATE OR REPLACE FUNCTION public.admin_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE v JSON;
BEGIN
    IF NOT public.is_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT json_build_object(
        'total_users',     (SELECT COUNT(*) FROM public.users),
        'blocked_users',   (SELECT COUNT(*) FROM public.users WHERE is_blocked),
        'total_credits',   (SELECT COALESCE(SUM(credits),0) FROM public.wallets),
        'total_revenue',   (SELECT COALESCE(SUM(amount_naira),0) FROM public.transactions WHERE type='credit_purchase'),
        'active_sessions', (SELECT COUNT(*) FROM public.sessions WHERE status='active')
    ) INTO v;
    RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.admin_stats() TO authenticated;

-- -----------------------------------------------------------------------------
-- 8. SEED THE ADMIN
--    Admin email for this deployment: Joshtoo@stayhome.li
--    NOTE: First create the auth user via Supabase dashboard:
--      Authentication → Users → Add user
--        email:    Joshtoo@stayhome.li
--        password: Use a strong password
--        Auto Confirm: YES
--    Then run this block (it picks up the auth user by email).
-- -----------------------------------------------------------------------------
INSERT INTO public.admins (user_id, email)
SELECT id, email FROM auth.users
WHERE LOWER(email) = LOWER('Joshtoo@stayhome.li')
ON CONFLICT (user_id) DO NOTHING;

-- =============================================================================
-- DONE
-- =============================================================================

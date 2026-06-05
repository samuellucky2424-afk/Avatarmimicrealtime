-- =============================================================================
-- TECH LORD MEDIA CLONE DATABASE SETUP
-- Creates k-prefixed app tables and k-prefixed RPCs in the same Supabase project.
-- Run in Supabase SQL Editor. Idempotent: safe to re-run.
--
-- This intentionally does not replace the original public.users, public.wallets,
-- or original admin_* RPCs, so the original app can keep using them.
--
-- Admin login:
--   1. Create exactly one admin user in Supabase Authentication with the
--      email/password you want.
--   2. Set clone_admin_email below to that email before running this script.
--   3. The packaged app never stores the admin password; Supabase Auth checks it.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

SELECT set_config('techlordmedia.clone_admin_email', 'CHANGE_ADMIN_EMAIL_HERE', false);

DO $$
DECLARE
    clone_admin_email TEXT := current_setting('techlordmedia.clone_admin_email', true);
BEGIN
    IF clone_admin_email = 'CHANGE_ADMIN_EMAIL_HERE' THEN
        RAISE NOTICE 'Set clone_admin_email near the top of this script before running the admin seed.';
    END IF;
END $$;

-- =============================================================================
-- 1. TABLES
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.kusers (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email           TEXT UNIQUE NOT NULL,
    is_blocked      BOOLEAN DEFAULT FALSE,
    blocked_reason  TEXT,
    blocked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.kwallets (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID UNIQUE NOT NULL REFERENCES public.kusers(id) ON DELETE CASCADE,
    credits     INTEGER DEFAULT 0 CHECK (credits >= 0),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kwallets_user_id ON public.kwallets(user_id);

CREATE TABLE IF NOT EXISTS public.ktransactions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES public.kusers(id) ON DELETE CASCADE,
    wallet_id     UUID REFERENCES public.kwallets(id) ON DELETE SET NULL,
    type          TEXT NOT NULL CHECK (type IN ('credit_purchase', 'usage', 'admin_adjustment', 'credit', 'debit')),
    amount_naira  NUMERIC(12, 2) DEFAULT 0,
    amount        NUMERIC(12, 2) DEFAULT 0,
    credits       INTEGER NOT NULL DEFAULT 0,
    reference     TEXT,
    description   TEXT,
    status        TEXT DEFAULT 'success' CHECK (status IN ('pending', 'success', 'failed', 'refunded')),
    metadata      JSONB DEFAULT '{}',
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ktransactions_user_id ON public.ktransactions(user_id);
CREATE INDEX IF NOT EXISTS idx_ktransactions_wallet_id ON public.ktransactions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_ktransactions_created_at ON public.ktransactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ktransactions_type ON public.ktransactions(type);
CREATE INDEX IF NOT EXISTS idx_ktransactions_status ON public.ktransactions(status);
CREATE INDEX IF NOT EXISTS idx_ktransactions_reference ON public.ktransactions(reference);

CREATE TABLE IF NOT EXISTS public.ksessions (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES public.kusers(id) ON DELETE CASCADE,
    start_time    TIMESTAMPTZ DEFAULT NOW(),
    end_time      TIMESTAMPTZ,
    credits_used  INTEGER DEFAULT 0,
    seconds_used  INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ksessions_user_id ON public.ksessions(user_id);
CREATE INDEX IF NOT EXISTS idx_ksessions_status ON public.ksessions(status);
CREATE INDEX IF NOT EXISTS idx_ksessions_created_at ON public.ksessions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ksessions_start_time ON public.ksessions(start_time DESC);

CREATE TABLE IF NOT EXISTS public.kplans (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL UNIQUE,
    credits     INTEGER NOT NULL DEFAULT 0,
    usd_price   NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kplans_credits ON public.kplans(credits);

CREATE TABLE IF NOT EXISTS public.ksubscriptions (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES public.kusers(id) ON DELETE CASCADE,
    plan_name    TEXT NOT NULL,
    amount_paid  NUMERIC(12, 2) DEFAULT 0,
    credits      INTEGER NOT NULL,
    status       TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ksubscriptions_user_id ON public.ksubscriptions(user_id);
CREATE INDEX IF NOT EXISTS idx_ksubscriptions_status ON public.ksubscriptions(status);

CREATE TABLE IF NOT EXISTS public.kexchange_rates (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency   TEXT NOT NULL DEFAULT 'USD',
    to_currency     TEXT NOT NULL DEFAULT 'NGN',
    rate            NUMERIC(12, 4) NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_currency, to_currency)
);

CREATE TABLE IF NOT EXISTS public.kadmins (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.kcredit_adjustments (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES public.kusers(id) ON DELETE CASCADE,
    admin_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    delta        INTEGER NOT NULL,
    new_balance  INTEGER NOT NULL,
    reason       TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kcredit_adjustments_user ON public.kcredit_adjustments(user_id);

CREATE TABLE IF NOT EXISTS public.kaudit_log (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    target_table  TEXT,
    target_id     TEXT,
    payload       JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kaudit_log_created ON public.kaudit_log(created_at DESC);

-- =============================================================================
-- 2. TRIGGERS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.khandle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.kusers (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS kon_auth_user_created ON auth.users;
CREATE TRIGGER kon_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.khandle_new_auth_user();

CREATE OR REPLACE FUNCTION public.kcreate_wallet_for_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.kwallets (user_id, credits)
    VALUES (NEW.id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ktrg_create_wallet ON public.kusers;
CREATE TRIGGER ktrg_create_wallet
    AFTER INSERT ON public.kusers
    FOR EACH ROW EXECUTE FUNCTION public.kcreate_wallet_for_user();

CREATE OR REPLACE FUNCTION public.kvalidate_credits_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.credits < 0 THEN
        RAISE EXCEPTION 'Credits cannot be negative';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ktrg_validate_credits ON public.kwallets;
CREATE TRIGGER ktrg_validate_credits
    BEFORE UPDATE ON public.kwallets
    FOR EACH ROW EXECUTE FUNCTION public.kvalidate_credits_update();

-- =============================================================================
-- 3. CORE FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.kget_user_credits(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_credits INTEGER;
BEGIN
    SELECT credits INTO v_credits
      FROM public.kwallets
     WHERE user_id = p_user_id;
    RETURN COALESCE(v_credits, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.kdeduct_credits(p_user_id UUID, p_deduct INTEGER)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_current INTEGER;
    v_final   INTEGER;
    v_new     INTEGER;
BEGIN
    SELECT credits INTO v_current
      FROM public.kwallets
     WHERE user_id = p_user_id
     FOR UPDATE;

    v_final := LEAST(COALESCE(v_current, 0), p_deduct);
    v_new := GREATEST(0, COALESCE(v_current, 0) - v_final);

    UPDATE public.kwallets
       SET credits = v_new
     WHERE user_id = p_user_id;

    RETURN json_build_object('success', TRUE, 'credits_deducted', v_final, 'remaining_credits', v_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.kadd_credits(
    p_user_id UUID,
    p_credits INTEGER,
    p_amount NUMERIC DEFAULT 0,
    p_ref TEXT DEFAULT NULL,
    p_plan TEXT DEFAULT 'Credit Purchase'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_new INTEGER;
BEGIN
    INSERT INTO public.kwallets (user_id, credits)
    VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.kwallets
       SET credits = credits + p_credits
     WHERE user_id = p_user_id
     RETURNING credits INTO v_new;

    INSERT INTO public.ktransactions (user_id, type, amount_naira, amount, credits, reference, description, status)
    VALUES (p_user_id, 'credit_purchase', p_amount, p_amount, p_credits, p_ref, p_plan || ' purchased', 'success');

    INSERT INTO public.ksubscriptions (user_id, plan_name, amount_paid, credits, status)
    VALUES (p_user_id, p_plan, p_amount, p_credits, 'active');

    RETURN json_build_object('success', TRUE, 'credits_added', p_credits, 'new_credits', v_new);
END;
$$;

-- =============================================================================
-- 4. ADMIN HELPERS AND RPCs
-- =============================================================================

CREATE OR REPLACE FUNCTION public.kis_admin(p_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.kadmins
         WHERE user_id = p_user
            OR (
                p_user = auth.uid()
                AND LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
            )
    );
$$;

CREATE OR REPLACE FUNCTION public.kis_current_user_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.kis_admin(auth.uid());
$$;

GRANT EXECUTE ON FUNCTION public.kis_current_user_admin() TO authenticated, anon;

CREATE OR REPLACE FUNCTION public.kadmin_list_users(
    p_search TEXT DEFAULT NULL,
    p_limit  INTEGER DEFAULT 100,
    p_offset INTEGER DEFAULT 0
)
RETURNS TABLE (
    id              UUID,
    email           TEXT,
    credits         INTEGER,
    is_blocked      BOOLEAN,
    blocked_reason  TEXT,
    created_at      TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF NOT public.kis_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN QUERY
    SELECT u.id,
           u.email,
           COALESCE(w.credits, 0) AS credits,
           COALESCE(u.is_blocked, FALSE) AS is_blocked,
           u.blocked_reason,
           u.created_at
      FROM public.kusers u
      LEFT JOIN public.kwallets w ON w.user_id = u.id
     WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%'
     ORDER BY u.created_at DESC
     LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.kadmin_set_credits(
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
    IF NOT public.kis_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    IF p_credits < 0 THEN
        RAISE EXCEPTION 'Credits cannot be negative';
    END IF;

    INSERT INTO public.kwallets (user_id, credits)
    VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT credits INTO v_current
      FROM public.kwallets
     WHERE user_id = p_user_id
     FOR UPDATE;

    v_delta := p_credits - COALESCE(v_current, 0);

    UPDATE public.kwallets
       SET credits = p_credits
     WHERE user_id = p_user_id;

    INSERT INTO public.kcredit_adjustments (user_id, admin_id, delta, new_balance, reason)
    VALUES (p_user_id, v_admin, v_delta, p_credits, p_reason);

    INSERT INTO public.kaudit_log (actor_id, action, target_table, target_id, payload)
    VALUES (
        v_admin,
        'set_credits',
        'kwallets',
        p_user_id::TEXT,
        json_build_object('delta', v_delta, 'new_balance', p_credits, 'reason', p_reason)
    );

    RETURN json_build_object('success', TRUE, 'new_credits', p_credits, 'delta', v_delta);
END;
$$;

CREATE OR REPLACE FUNCTION public.kadmin_set_blocked(
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
    IF NOT public.kis_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    UPDATE public.kusers
       SET is_blocked = p_blocked,
           blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
           blocked_at = CASE WHEN p_blocked THEN NOW() ELSE NULL END
     WHERE id = p_user_id;

    INSERT INTO public.kaudit_log (actor_id, action, target_table, target_id, payload)
    VALUES (
        v_admin,
        CASE WHEN p_blocked THEN 'block_user' ELSE 'unblock_user' END,
        'kusers',
        p_user_id::TEXT,
        json_build_object('reason', p_reason)
    );

    RETURN json_build_object('success', TRUE, 'is_blocked', p_blocked);
END;
$$;

CREATE OR REPLACE FUNCTION public.kadmin_upsert_plan(
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
    IF NOT public.kis_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.kplans (name, credits, usd_price)
        VALUES (p_name, p_credits, p_usd_price)
        ON CONFLICT (name) DO UPDATE
            SET credits = EXCLUDED.credits,
                usd_price = EXCLUDED.usd_price
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.kplans
           SET name = p_name,
               credits = p_credits,
               usd_price = p_usd_price
         WHERE id = p_id
         RETURNING id INTO v_id;
    END IF;

    INSERT INTO public.kaudit_log (actor_id, action, target_table, target_id, payload)
    VALUES (
        v_admin,
        'upsert_plan',
        'kplans',
        v_id::TEXT,
        json_build_object('name', p_name, 'credits', p_credits, 'usd_price', p_usd_price)
    );

    RETURN json_build_object('success', TRUE, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.kadmin_delete_plan(p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
BEGIN
    IF NOT public.kis_admin(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    DELETE FROM public.kplans WHERE id = p_id;

    INSERT INTO public.kaudit_log (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'delete_plan', 'kplans', p_id::TEXT, '{}'::JSONB);

    RETURN json_build_object('success', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public.kadmin_stats()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v JSON;
BEGIN
    IF NOT public.kis_admin(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT json_build_object(
        'total_users',     (SELECT COUNT(*) FROM public.kusers),
        'blocked_users',   (SELECT COUNT(*) FROM public.kusers WHERE is_blocked),
        'total_credits',   (SELECT COALESCE(SUM(credits), 0) FROM public.kwallets),
        'total_revenue',   (
            SELECT COALESCE(SUM(COALESCE(NULLIF(amount_naira, 0), amount, 0)), 0)
              FROM public.ktransactions
             WHERE type IN ('credit_purchase', 'credit')
               AND COALESCE(status, 'success') = 'success'
        ),
        'active_sessions', (SELECT COUNT(*) FROM public.ksessions WHERE status = 'active')
    ) INTO v;

    RETURN v;
END;
$$;

GRANT EXECUTE ON FUNCTION public.kadmin_list_users(TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kadmin_set_credits(UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kadmin_set_blocked(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kadmin_upsert_plan(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kadmin_delete_plan(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.kadmin_stats() TO authenticated;

-- =============================================================================
-- 5. ROW-LEVEL SECURITY
-- =============================================================================

ALTER TABLE public.kusers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kwallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ktransactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kplans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ksubscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kexchange_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kadmins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kcredit_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.kaudit_log ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT schemaname, tablename, policyname
          FROM pg_policies
         WHERE schemaname = 'public'
           AND tablename IN (
               'kusers',
               'kwallets',
               'ktransactions',
               'ksessions',
               'kplans',
               'ksubscriptions',
               'kexchange_rates',
               'kadmins',
               'kcredit_adjustments',
               'kaudit_log'
           )
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I', r.policyname, r.schemaname, r.tablename);
    END LOOP;
END $$;

CREATE POLICY "kusers_select" ON public.kusers
    FOR SELECT USING (auth.uid() = id OR public.kis_admin());
CREATE POLICY "kusers_update" ON public.kusers
    FOR UPDATE USING (auth.uid() = id OR public.kis_admin())
    WITH CHECK (auth.uid() = id OR public.kis_admin());

CREATE POLICY "kwallets_select" ON public.kwallets
    FOR SELECT USING (auth.uid() = user_id OR public.kis_admin());
CREATE POLICY "kwallets_update" ON public.kwallets
    FOR UPDATE USING (auth.uid() = user_id OR public.kis_admin())
    WITH CHECK (auth.uid() = user_id OR public.kis_admin());

CREATE POLICY "ktransactions_select" ON public.ktransactions
    FOR SELECT USING (auth.uid() = user_id OR public.kis_admin());
CREATE POLICY "ktransactions_insert" ON public.ktransactions
    FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.kis_admin());

CREATE POLICY "ksessions_select" ON public.ksessions
    FOR SELECT USING (auth.uid() = user_id OR public.kis_admin());
CREATE POLICY "ksessions_insert" ON public.ksessions
    FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.kis_admin());
CREATE POLICY "ksessions_update" ON public.ksessions
    FOR UPDATE USING (auth.uid() = user_id OR public.kis_admin())
    WITH CHECK (auth.uid() = user_id OR public.kis_admin());

CREATE POLICY "kplans_select" ON public.kplans
    FOR SELECT USING (TRUE);
CREATE POLICY "kplans_admin_all" ON public.kplans
    FOR ALL USING (public.kis_admin()) WITH CHECK (public.kis_admin());

CREATE POLICY "ksubscriptions_select" ON public.ksubscriptions
    FOR SELECT USING (auth.uid() = user_id OR public.kis_admin());
CREATE POLICY "ksubscriptions_insert" ON public.ksubscriptions
    FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.kis_admin());

CREATE POLICY "kexchange_rates_select" ON public.kexchange_rates
    FOR SELECT USING (TRUE);
CREATE POLICY "kexchange_rates_admin_all" ON public.kexchange_rates
    FOR ALL USING (public.kis_admin()) WITH CHECK (public.kis_admin());

CREATE POLICY "kadmins_self" ON public.kadmins
    FOR SELECT USING (
        auth.uid() = user_id
        OR LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
    );

CREATE POLICY "kcredit_adjustments_admin_select" ON public.kcredit_adjustments
    FOR SELECT USING (public.kis_admin());

CREATE POLICY "kaudit_log_admin_select" ON public.kaudit_log
    FOR SELECT USING (public.kis_admin());
CREATE POLICY "kaudit_log_service_insert" ON public.kaudit_log
    FOR INSERT WITH CHECK (auth.role() = 'service_role' OR public.kis_admin());

-- Explicit grants for PostgREST/Supabase client access. RLS policies above still
-- decide which rows each normal user can see or change.
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

GRANT SELECT, UPDATE ON public.kusers TO authenticated;
GRANT SELECT, UPDATE ON public.kwallets TO authenticated;
GRANT SELECT, INSERT ON public.ktransactions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.ksessions TO authenticated;
GRANT SELECT ON public.kplans TO anon, authenticated;
GRANT SELECT, INSERT ON public.ksubscriptions TO authenticated;
GRANT SELECT ON public.kexchange_rates TO anon, authenticated;
GRANT SELECT ON public.kadmins TO authenticated;
GRANT SELECT ON public.kcredit_adjustments TO authenticated;
GRANT SELECT, INSERT ON public.kaudit_log TO authenticated;

GRANT ALL ON public.kusers TO service_role;
GRANT ALL ON public.kwallets TO service_role;
GRANT ALL ON public.ktransactions TO service_role;
GRANT ALL ON public.ksessions TO service_role;
GRANT ALL ON public.kplans TO service_role;
GRANT ALL ON public.ksubscriptions TO service_role;
GRANT ALL ON public.kexchange_rates TO service_role;
GRANT ALL ON public.kadmins TO service_role;
GRANT ALL ON public.kcredit_adjustments TO service_role;
GRANT ALL ON public.kaudit_log TO service_role;

GRANT EXECUTE ON FUNCTION public.kget_user_credits(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kdeduct_credits(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kadd_credits(UUID, INTEGER, NUMERIC, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.kis_admin(UUID) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.kis_current_user_admin() TO authenticated, anon, service_role;

-- =============================================================================
-- 6. SEED AND BACKFILL
-- =============================================================================

INSERT INTO public.kplans (name, credits, usd_price) VALUES
    ('Starter',     500,   11500.00),
    ('Basic',      1000,  23000.00),
    ('Pro',        2000,  46000.00),
    ('Enterprise', 5000, 115000.00)
ON CONFLICT (name) DO UPDATE
SET credits = EXCLUDED.credits,
    usd_price = EXCLUDED.usd_price;

INSERT INTO public.kexchange_rates (from_currency, to_currency, rate)
VALUES ('USD', 'NGN', 1500.0000)
ON CONFLICT (from_currency, to_currency) DO UPDATE
SET rate = EXCLUDED.rate,
    updated_at = NOW();

INSERT INTO public.kusers (id, email)
SELECT au.id, au.email
  FROM auth.users au
 WHERE au.email IS NOT NULL
ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;

INSERT INTO public.kwallets (user_id, credits)
SELECT u.id, 0
  FROM public.kusers u
  LEFT JOIN public.kwallets w ON w.user_id = u.id
 WHERE w.user_id IS NULL;

DO $$
DECLARE
    clone_admin_email TEXT := current_setting('techlordmedia.clone_admin_email', true);
BEGIN
    IF clone_admin_email IS NULL OR clone_admin_email = 'CHANGE_ADMIN_EMAIL_HERE' THEN
        RAISE NOTICE 'Skipping kadmins seed because clone_admin_email was not set.';
        RETURN;
    END IF;

    DELETE FROM public.kadmins
     WHERE LOWER(email) <> LOWER(clone_admin_email);

    INSERT INTO public.kadmins (user_id, email)
    SELECT id, email
      FROM auth.users
     WHERE LOWER(email) = LOWER(clone_admin_email)
    ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email;

    IF NOT FOUND THEN
        RAISE NOTICE 'No Supabase Auth user found for admin email %. Create the Auth user, then re-run this script.', clone_admin_email;
    END IF;
END $$;

-- Enable realtime for tables the app watches or may show live later.
DO $$
DECLARE
    t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['kwallets', 'ktransactions', 'ksessions', 'kplans']
        LOOP
            IF NOT EXISTS (
                SELECT 1
                  FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime'
                   AND schemaname = 'public'
                   AND tablename = t
            ) THEN
                EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
            END IF;
        END LOOP;
    END IF;
END $$;

-- =============================================================================
-- DONE
-- =============================================================================

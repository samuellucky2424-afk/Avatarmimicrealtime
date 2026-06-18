-- =============================================================================
-- VIRTUAL PRESENCE AI — NEW _vp TABLES SETUP
-- =============================================================================
-- This script creates the new tables, triggers, RPC functions, and RLS policies
-- specifically for Virtual Presence AI, using the '_vp' suffix to prevent
-- conflicts with any existing tables in your Supabase schema.
-- =============================================================================

-- ENABLE EXTENSIONS
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- =============================================================================
-- 1. CREATE NEW TABLES (Ending in _vp)
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.users_vp (
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email           TEXT UNIQUE NOT NULL,
    is_blocked      BOOLEAN DEFAULT FALSE,
    blocked_reason  TEXT,
    blocked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.wallets_vp (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID UNIQUE NOT NULL REFERENCES public.users_vp(id) ON DELETE CASCADE,
    credits     INTEGER DEFAULT 0 CHECK (credits >= 0),
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_wallets_vp_user_id ON public.wallets_vp(user_id);

CREATE TABLE IF NOT EXISTS public.transactions_vp (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES public.users_vp(id) ON DELETE CASCADE,
    wallet_id     UUID REFERENCES public.wallets_vp(id) ON DELETE SET NULL,
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
CREATE INDEX IF NOT EXISTS idx_transactions_vp_user_id ON public.transactions_vp(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_vp_wallet_id ON public.transactions_vp(wallet_id);
CREATE INDEX IF NOT EXISTS idx_transactions_vp_created_at ON public.transactions_vp(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_vp_type ON public.transactions_vp(type);
CREATE INDEX IF NOT EXISTS idx_transactions_vp_status ON public.transactions_vp(status);
CREATE INDEX IF NOT EXISTS idx_transactions_vp_reference ON public.transactions_vp(reference);

CREATE TABLE IF NOT EXISTS public.sessions_vp (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id       UUID NOT NULL REFERENCES public.users_vp(id) ON DELETE CASCADE,
    start_time    TIMESTAMPTZ DEFAULT NOW(),
    end_time      TIMESTAMPTZ,
    credits_used  INTEGER DEFAULT 0,
    seconds_used  INTEGER DEFAULT 0,
    status        TEXT DEFAULT 'active' CHECK (status IN ('active', 'ended')),
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sessions_vp_user_id ON public.sessions_vp(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_vp_status ON public.sessions_vp(status);
CREATE INDEX IF NOT EXISTS idx_sessions_vp_created_at ON public.sessions_vp(created_at DESC);

CREATE TABLE IF NOT EXISTS public.plans_vp (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name        TEXT NOT NULL UNIQUE,
    credits     INTEGER NOT NULL DEFAULT 0,
    usd_price   NUMERIC(10, 2) NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_plans_vp_credits ON public.plans_vp(credits);

CREATE TABLE IF NOT EXISTS public.subscriptions_vp (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES public.users_vp(id) ON DELETE CASCADE,
    plan_name    TEXT NOT NULL,
    amount_paid  NUMERIC(12, 2) DEFAULT 0,
    credits      INTEGER NOT NULL,
    status       TEXT DEFAULT 'active' CHECK (status IN ('active', 'expired', 'cancelled', 'pending')),
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_vp_user_id ON public.subscriptions_vp(user_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_vp_status ON public.subscriptions_vp(status);

CREATE TABLE IF NOT EXISTS public.exchange_rates_vp (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_currency   TEXT NOT NULL DEFAULT 'USD',
    to_currency     TEXT NOT NULL DEFAULT 'NGN',
    rate            NUMERIC(12, 4) NOT NULL,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(from_currency, to_currency)
);

CREATE TABLE IF NOT EXISTS public.admins_vp (
    user_id     UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.credit_adjustments_vp (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id      UUID NOT NULL REFERENCES public.users_vp(id) ON DELETE CASCADE,
    admin_id     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    delta        INTEGER NOT NULL,
    new_balance  INTEGER NOT NULL,
    reason       TEXT,
    created_at   TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_credit_adjustments_vp_user ON public.credit_adjustments_vp(user_id);

CREATE TABLE IF NOT EXISTS public.audit_log_vp (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    actor_id      UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    action        TEXT NOT NULL,
    target_table  TEXT,
    target_id     TEXT,
    payload       JSONB,
    created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_log_vp_created ON public.audit_log_vp(created_at DESC);

-- =============================================================================
-- 2. TRIGGERS & TRIGGER FUNCTIONS
-- =============================================================================

CREATE OR REPLACE FUNCTION public.handle_new_auth_user_vp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    -- Only trigger on Virtual Presence AI signups
    IF LOWER(COALESCE(NEW.raw_user_meta_data ->> 'app', '')) <> 'virtualpresenceai'
       AND LOWER(COALESCE(NEW.raw_user_meta_data ->> 'app_name', '')) <> 'virtual presence ai' THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.users_vp (id, email)
    VALUES (NEW.id, NEW.email)
    ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_vp ON auth.users;
CREATE TRIGGER on_auth_user_created_vp
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_user_vp();

CREATE OR REPLACE FUNCTION public.create_wallet_for_user_vp()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.wallets_vp (user_id, credits)
    VALUES (NEW.id, 0)
    ON CONFLICT (user_id) DO NOTHING;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_wallet_vp ON public.users_vp;
CREATE TRIGGER trg_create_wallet_vp
    AFTER INSERT ON public.users_vp
    FOR EACH ROW EXECUTE FUNCTION public.create_wallet_for_user_vp();

CREATE OR REPLACE FUNCTION public.validate_credits_update_vp()
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

DROP TRIGGER IF EXISTS trg_validate_credits_vp ON public.wallets_vp;
CREATE TRIGGER trg_validate_credits_vp
    BEFORE UPDATE ON public.wallets_vp
    FOR EACH ROW EXECUTE FUNCTION public.validate_credits_update_vp();

-- =============================================================================
-- 3. CORE FUNCTIONS & RPCs (Ending in _vp)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.get_user_credits_vp(p_user_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_credits INTEGER;
BEGIN
    SELECT credits INTO v_credits
      FROM public.wallets_vp
     WHERE user_id = p_user_id;
    RETURN COALESCE(v_credits, 0);
END;
$$;

CREATE OR REPLACE FUNCTION public.deduct_credits_vp(p_user_id UUID, p_deduct INTEGER)
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
      FROM public.wallets_vp
     WHERE user_id = p_user_id
     FOR UPDATE;

    v_final := LEAST(COALESCE(v_current, 0), p_deduct);
    v_new := GREATEST(0, COALESCE(v_current, 0) - v_final);

    UPDATE public.wallets_vp
       SET credits = v_new
     WHERE user_id = p_user_id;

    RETURN json_build_object('success', TRUE, 'credits_deducted', v_final, 'remaining_credits', v_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.add_credits_vp(
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
    INSERT INTO public.wallets_vp (user_id, credits)
    VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    UPDATE public.wallets_vp
       SET credits = credits + p_credits
      WHERE user_id = p_user_id
      RETURNING credits INTO v_new;

    INSERT INTO public.transactions_vp (user_id, type, amount_naira, amount, credits, reference, description, status)
    VALUES (p_user_id, 'credit_purchase', p_amount, p_amount, p_credits, p_ref, p_plan || ' purchased', 'success');

    INSERT INTO public.subscriptions_vp (user_id, plan_name, amount_paid, credits, status)
    VALUES (p_user_id, p_plan, p_amount, p_credits, 'active');

    RETURN json_build_object('success', TRUE, 'credits_added', p_credits, 'new_credits', v_new);
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin_vp(p_user UUID DEFAULT auth.uid())
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.admins_vp
         WHERE user_id = p_user
            OR (
                p_user = auth.uid()
                AND LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', ''))
            )
       );
$$;

CREATE OR REPLACE FUNCTION public.is_current_user_admin_vp()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT public.is_admin_vp(auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.admin_list_users_vp(
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
    IF NOT public.is_admin_vp(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    RETURN QUERY
    SELECT u.id,
           u.email,
           COALESCE(w.credits, 0) AS credits,
           COALESCE(u.is_blocked, FALSE) AS is_blocked,
           u.blocked_reason,
           u.created_at
      FROM public.users_vp u
      LEFT JOIN public.wallets_vp w ON w.user_id = u.id
     WHERE p_search IS NULL OR u.email ILIKE '%' || p_search || '%'
     ORDER BY u.created_at DESC
     LIMIT p_limit OFFSET p_offset;
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_credits_vp(
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
    IF NOT public.is_admin_vp(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;
    IF p_credits < 0 THEN
        RAISE EXCEPTION 'Credits cannot be negative';
    END IF;

    INSERT INTO public.wallets_vp (user_id, credits) VALUES (p_user_id, 0)
    ON CONFLICT (user_id) DO NOTHING;

    SELECT credits INTO v_current
      FROM public.wallets_vp
     WHERE user_id = p_user_id
     FOR UPDATE;

    v_delta := p_credits - COALESCE(v_current, 0);

    UPDATE public.wallets_vp
       SET credits = p_credits
     WHERE user_id = p_user_id;

    INSERT INTO public.credit_adjustments_vp (user_id, admin_id, delta, new_balance, reason)
    VALUES (p_user_id, v_admin, v_delta, p_credits, p_reason);

    INSERT INTO public.audit_log_vp (actor_id, action, target_table, target_id, payload)
    VALUES (
        v_admin,
        'set_credits',
        'wallets_vp',
        p_user_id::TEXT,
        json_build_object('delta', v_delta, 'new_balance', p_credits, 'reason', p_reason)
    );

    RETURN json_build_object('success', TRUE, 'new_credits', p_credits, 'delta', v_delta);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_set_blocked_vp(
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
    IF NOT public.is_admin_vp(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    UPDATE public.users_vp
       SET is_blocked = p_blocked,
           blocked_reason = CASE WHEN p_blocked THEN p_reason ELSE NULL END,
           blocked_at = CASE WHEN p_blocked THEN NOW() ELSE NULL END
     WHERE id = p_user_id;

    INSERT INTO public.audit_log_vp (actor_id, action, target_table, target_id, payload)
    VALUES (
        v_admin,
        CASE WHEN p_blocked THEN 'block_user' ELSE 'unblock_user' END,
        'users_vp',
        p_user_id::TEXT,
        json_build_object('reason', p_reason)
    );

    RETURN json_build_object('success', TRUE, 'is_blocked', p_blocked);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_upsert_plan_vp(
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
    IF NOT public.is_admin_vp(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    IF p_id IS NULL THEN
        INSERT INTO public.plans_vp (name, credits, usd_price)
        VALUES (p_name, p_credits, p_usd_price)
        ON CONFLICT (name) DO UPDATE
            SET credits = EXCLUDED.credits,
                usd_price = EXCLUDED.usd_price
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.plans_vp
           SET name = p_name,
               credits = p_credits,
               usd_price = p_usd_price
         WHERE id = p_id
         RETURNING id INTO v_id;
    END IF;

    INSERT INTO public.audit_log_vp (actor_id, action, target_table, target_id, payload)
    VALUES (
        v_admin,
        'upsert_plan',
        'plans_vp',
        v_id::TEXT,
        json_build_object('name', p_name, 'credits', p_credits, 'usd_price', p_usd_price)
    );

    RETURN json_build_object('success', TRUE, 'id', v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_delete_plan_vp(p_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_admin UUID := auth.uid();
BEGIN
    IF NOT public.is_admin_vp(v_admin) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    DELETE FROM public.plans_vp WHERE id = p_id;

    INSERT INTO public.audit_log_vp (actor_id, action, target_table, target_id, payload)
    VALUES (v_admin, 'delete_plan', 'plans_vp', p_id::TEXT, '{}'::JSONB);

    RETURN json_build_object('success', TRUE);
END;
$$;

CREATE OR REPLACE FUNCTION public.admin_stats_vp()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v JSON;
BEGIN
    IF NOT public.is_admin_vp(auth.uid()) THEN
        RAISE EXCEPTION 'Not authorized';
    END IF;

    SELECT json_build_object(
        'total_users',     (SELECT COUNT(*) FROM public.users_vp),
        'blocked_users',   (SELECT COUNT(*) FROM public.users_vp WHERE is_blocked),
        'total_credits',   (SELECT COALESCE(SUM(credits), 0) FROM public.wallets_vp),
        'total_revenue',   (
            SELECT COALESCE(SUM(COALESCE(NULLIF(amount_naira, 0), amount, 0)), 0)
              FROM public.transactions_vp
             WHERE type IN ('credit_purchase', 'credit')
               AND COALESCE(status, 'success') = 'success'
        ),
        'active_sessions', (SELECT COUNT(*) FROM public.sessions_vp WHERE status = 'active')
    ) INTO v;

    RETURN v;
END;
$$;

-- =============================================================================
-- 4. ROW-LEVEL SECURITY & GRANTS
-- =============================================================================

ALTER TABLE public.users_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wallets_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.plans_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.exchange_rates_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admins_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credit_adjustments_vp ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log_vp ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_vp_select" ON public.users_vp FOR SELECT USING (auth.uid() = id OR public.is_admin_vp());
CREATE POLICY "users_vp_update" ON public.users_vp FOR UPDATE USING (auth.uid() = id OR public.is_admin_vp()) WITH CHECK (auth.uid() = id OR public.is_admin_vp());

CREATE POLICY "wallets_vp_select" ON public.wallets_vp FOR SELECT USING (auth.uid() = user_id OR public.is_admin_vp());
CREATE POLICY "wallets_vp_update" ON public.wallets_vp FOR UPDATE USING (auth.uid() = user_id OR public.is_admin_vp()) WITH CHECK (auth.uid() = user_id OR public.is_admin_vp());

CREATE POLICY "transactions_vp_select" ON public.transactions_vp FOR SELECT USING (auth.uid() = user_id OR public.is_admin_vp());
CREATE POLICY "transactions_vp_insert" ON public.transactions_vp FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.is_admin_vp());

CREATE POLICY "sessions_vp_select" ON public.sessions_vp FOR SELECT USING (auth.uid() = user_id OR public.is_admin_vp());
CREATE POLICY "sessions_vp_insert" ON public.sessions_vp FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.is_admin_vp());
CREATE POLICY "sessions_vp_update" ON public.sessions_vp FOR UPDATE USING (auth.uid() = user_id OR public.is_admin_vp()) WITH CHECK (auth.uid() = user_id OR public.is_admin_vp());

CREATE POLICY "plans_vp_select" ON public.plans_vp FOR SELECT USING (TRUE);
CREATE POLICY "plans_vp_admin_all" ON public.plans_vp FOR ALL USING (public.is_admin_vp()) WITH CHECK (public.is_admin_vp());

CREATE POLICY "subscriptions_vp_select" ON public.subscriptions_vp FOR SELECT USING (auth.uid() = user_id OR public.is_admin_vp());
CREATE POLICY "subscriptions_vp_insert" ON public.subscriptions_vp FOR INSERT WITH CHECK (auth.uid() = user_id OR auth.role() = 'service_role' OR public.is_admin_vp());

CREATE POLICY "exchange_rates_vp_select" ON public.exchange_rates_vp FOR SELECT USING (TRUE);
CREATE POLICY "exchange_rates_vp_admin_all" ON public.exchange_rates_vp FOR ALL USING (public.is_admin_vp()) WITH CHECK (public.is_admin_vp());

CREATE POLICY "admins_vp_self" ON public.admins_vp FOR SELECT USING (auth.uid() = user_id OR LOWER(email) = LOWER(COALESCE(auth.jwt() ->> 'email', '')));
CREATE POLICY "credit_adjustments_vp_admin_select" ON public.credit_adjustments_vp FOR SELECT USING (public.is_admin_vp());
CREATE POLICY "audit_log_vp_admin_select" ON public.audit_log_vp FOR SELECT USING (public.is_admin_vp());

GRANT SELECT, UPDATE ON public.users_vp TO authenticated;
GRANT SELECT, UPDATE ON public.wallets_vp TO authenticated;
GRANT SELECT, INSERT ON public.transactions_vp TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sessions_vp TO authenticated;
GRANT SELECT ON public.plans_vp TO anon, authenticated;
GRANT SELECT, INSERT ON public.subscriptions_vp TO authenticated;
GRANT SELECT ON public.exchange_rates_vp TO anon, authenticated;
GRANT SELECT ON public.admins_vp TO authenticated;
GRANT SELECT ON public.credit_adjustments_vp TO authenticated;
GRANT SELECT, INSERT ON public.audit_log_vp TO authenticated;

GRANT ALL ON public.users_vp TO service_role;
GRANT ALL ON public.wallets_vp TO service_role;
GRANT ALL ON public.transactions_vp TO service_role;
GRANT ALL ON public.sessions_vp TO service_role;
GRANT ALL ON public.plans_vp TO service_role;
GRANT ALL ON public.subscriptions_vp TO service_role;
GRANT ALL ON public.exchange_rates_vp TO service_role;
GRANT ALL ON public.admins_vp TO service_role;
GRANT ALL ON public.credit_adjustments_vp TO service_role;
GRANT ALL ON public.audit_log_vp TO service_role;

GRANT EXECUTE ON FUNCTION public.get_user_credits_vp(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.deduct_credits_vp(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.add_credits_vp(UUID, INTEGER, NUMERIC, TEXT, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_admin_vp(UUID) TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.is_current_user_admin_vp() TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_users_vp(TEXT, INTEGER, INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_credits_vp(UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_set_blocked_vp(UUID, BOOLEAN, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_upsert_plan_vp(UUID, TEXT, INTEGER, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_delete_plan_vp(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_stats_vp() TO authenticated;

-- =============================================================================
-- 5. PLANS SEED
-- =============================================================================

INSERT INTO public.plans_vp (name, credits, usd_price) VALUES
    ('Starter',     500,   11500.00),
    ('Basic',      1000,  23000.00),
    ('Pro',        2000,  46000.00),
    ('Enterprise', 5000, 115000.00)
ON CONFLICT (name) DO UPDATE
SET credits = EXCLUDED.credits,
    usd_price = EXCLUDED.usd_price;

INSERT INTO public.exchange_rates_vp (from_currency, to_currency, rate)
VALUES ('USD', 'NGN', 1500.0000)
ON CONFLICT (from_currency, to_currency) DO UPDATE
SET rate = EXCLUDED.rate,
    updated_at = NOW();

-- Enable Realtime for standard tables
DO $$
DECLARE
    t TEXT;
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        FOREACH t IN ARRAY ARRAY['wallets_vp', 'transactions_vp', 'sessions_vp', 'plans_vp']
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

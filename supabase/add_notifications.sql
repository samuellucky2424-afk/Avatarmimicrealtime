-- Avatar Mimic Real Time: admin-to-user dashboard notifications
-- Safe to run more than once in the Supabase SQL Editor.

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

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
DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications
    FOR SELECT USING (is_active OR public.is_admin());

DROP POLICY IF EXISTS "Admins insert notifications" ON public.notifications;
DROP POLICY IF EXISTS "notifications_admin_insert" ON public.notifications;
CREATE POLICY "notifications_admin_insert" ON public.notifications
    FOR INSERT WITH CHECK (public.is_admin() AND created_by = auth.uid());

DROP POLICY IF EXISTS "Admins update notifications" ON public.notifications;
DROP POLICY IF EXISTS "notifications_admin_update" ON public.notifications;
CREATE POLICY "notifications_admin_update" ON public.notifications
    FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS "Admins delete notifications" ON public.notifications;
DROP POLICY IF EXISTS "notifications_admin_delete" ON public.notifications;
CREATE POLICY "notifications_admin_delete" ON public.notifications
    FOR DELETE USING (public.is_admin());

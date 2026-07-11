-- Avatar Mimic Real Time: admin-managed WhatsApp checkout number
-- Safe to run more than once in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS public.app_settings (
    key         TEXT PRIMARY KEY,
    value       TEXT NOT NULL DEFAULT '',
    updated_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public reads app settings" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_select" ON public.app_settings;
CREATE POLICY "app_settings_select" ON public.app_settings FOR SELECT USING (TRUE);

DROP POLICY IF EXISTS "Admins insert app settings" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_admin_insert" ON public.app_settings;
CREATE POLICY "app_settings_admin_insert" ON public.app_settings
    FOR INSERT WITH CHECK (public.is_admin() AND updated_by = auth.uid());

DROP POLICY IF EXISTS "Admins update app settings" ON public.app_settings;
DROP POLICY IF EXISTS "app_settings_admin_update" ON public.app_settings;
CREATE POLICY "app_settings_admin_update" ON public.app_settings
    FOR UPDATE USING (public.is_admin()) WITH CHECK (public.is_admin());

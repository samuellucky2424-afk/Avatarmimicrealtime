import { createClient } from '@supabase/supabase-js';

const DEPLOYED_SUPABASE_URL = 'https://nvhhimehfryzxecxbcyr.supabase.co';
const DEPLOYED_SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im52aGhpbWVoZnJ5enhlY3hiY3lyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM3NDIxNTUsImV4cCI6MjA5OTMxODE1NX0.VID7Mi6zVXwuDVSyrGVpntch-AkCyHZzIctKOhJf6_Y';

function resolvePublicConfig(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  if (!trimmed || trimmed.startsWith('YOUR_')) {
    return fallback;
  }

  return trimmed;
}

const supabaseUrl = resolvePublicConfig(import.meta.env.VITE_SUPABASE_URL, DEPLOYED_SUPABASE_URL);
const supabaseAnonKey = resolvePublicConfig(import.meta.env.VITE_SUPABASE_ANON_KEY, DEPLOYED_SUPABASE_ANON_KEY);

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

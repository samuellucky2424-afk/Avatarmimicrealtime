import { supabase } from '@/lib/supabase';

const DEPLOYED_APP_ORIGIN = 'https://virtual-presence-ai.vercel.app';
const LOCAL_API_BASE = '/api';

function normalizeApiBase(value?: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function isFileProtocol(): boolean {
  return typeof window !== 'undefined' && window.location.protocol === 'file:';
}

function getApiBase(): string {
  const configuredBase = normalizeApiBase(import.meta.env.VITE_API_URL);
  const deployedBase = `${DEPLOYED_APP_ORIGIN}/api`;

  if (configuredBase) {
    if (configuredBase.startsWith('/') && isFileProtocol()) {
      return deployedBase;
    }

    return configuredBase;
  }

  if (import.meta.env.DEV && import.meta.env.VITE_USE_LOCAL_API === 'true') {
    return LOCAL_API_BASE;
  }

  return deployedBase;
}

function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const normalizedPath = withLeadingSlash(path);
  const apiBase = getApiBase();
  return fetch(`${apiBase}${normalizedPath}`, init);
}

export async function apiFetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  const headers = new Headers(init?.headers);

  if (token && !headers.has('Authorization')) {
    headers.set('Authorization', `Bearer ${token}`);
  }

  return apiFetch(path, {
    ...init,
    headers,
  });
}

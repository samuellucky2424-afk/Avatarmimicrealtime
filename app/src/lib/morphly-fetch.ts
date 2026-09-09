type AuthFetch = (path: string, init?: RequestInit) => Promise<Response>;

const MORPHLY_API_ORIGIN = 'https://api.morphly.fun';

// The SDK uses its fetch callback for both our token route and Morphly's
// heartbeat/stop requests. Only our token route needs the app's authentication.
export function createMorphlyFetch(authFetch: AuthFetch, meteredSessionId: string): AuthFetch {
  return async (path, init) => {
    if (path === '/morphly-token') {
      const headers = new Headers(init?.headers);
      headers.set('X-Morphly-Session-Id', meteredSessionId);
      return authFetch(path, { ...init, headers });
    }

    const providerUrl = new URL(path);
    if (providerUrl.origin !== MORPHLY_API_ORIGIN || providerUrl.username || providerUrl.password) {
      throw new Error('Unexpected Morphly request origin');
    }

    // Preserve the provider's session bearer token, URL, timeout and keepalive.
    return fetch(path, init);
  };
}

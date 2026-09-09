const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('../app/node_modules/typescript');

function loadHandler(relativePath, fetch) {
  const user = { id: 'test-user' };
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() { return { data: { id: 'test-session' }, error: null }; },
  };
  const supabaseAdmin = {
    auth: { async getUser() { return { data: { user }, error: null }; } },
    from() { return query; },
  };
  const filename = path.resolve(__dirname, '..', relativePath);
  const { outputText } = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  vm.runInNewContext(outputText, {
    exports,
    require(specifier) {
      if (specifier === './supabase.js') return { supabaseAdmin, supabaseAdminConfigError: null };
      if (specifier === '../../shared/paystack-payment.js') {
        return {
          requireSupabaseUser: async () => ({ ok: true, user }),
          checkUserRateLimit: () => ({ ok: true }),
        };
      }
      throw new Error(`Unexpected import: ${specifier}`);
    },
    process: { env: { MORPHLY_API_KEY: 'test-placeholder-key' } },
    fetch,
    URL,
    AbortSignal,
    console: { error() {} },
  }, { filename });
  return exports.default;
}

function vercelResponse() {
  // Vercel adds status/json helpers to ServerResponse, but no Express .set().
  return {
    headers: {},
    statusCode: 200,
    body: undefined,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

const request = {
  method: 'POST',
  headers: { authorization: 'Bearer test-user-token', 'x-morphly-session-id': 'test-session' },
  body: { origin: 'http://localhost:5173', maxSessionSeconds: 60 },
};

for (const route of ['api/morphly-token.ts', 'app/api/morphly-token.ts']) {
  test(`${route}: forwards successful session credentials on Vercel`, async () => {
    const payload = { session_id: 'opaque-id', session_token: 'opaque-token', client_token: 'opaque-client' };
    const handler = loadHandler(route, async () => ({ status: 201, json: async () => payload }));
    const response = vercelResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 201);
    assert.strictEqual(response.body, payload);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test(`${route}: preserves upstream error status and body`, async () => {
    const payload = { error: 'Too many requests', code: 'RATE_LIMITED', retry_after: 30 };
    const handler = loadHandler(route, async () => ({ status: 429, json: async () => payload }));
    const response = vercelResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 429);
    assert.strictEqual(response.body, payload);
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test(`${route}: reports genuine upstream fetch failures as unavailable`, async () => {
    const handler = loadHandler(route, async () => { throw new TypeError('fetch failed'); });
    const response = vercelResponse();
    await handler(request, response);
    assert.equal(response.statusCode, 502);
    assert.equal(response.body.error, 'Session service unavailable');
    assert.equal(response.body.code, 'MORPHLY_UPSTREAM_UNREACHABLE');
  });
}

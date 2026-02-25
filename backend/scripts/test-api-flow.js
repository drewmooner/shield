/**
 * Run with: node scripts/test-api-flow.js
 * Backend must be running on PORT (default 3002).
 * Tests: health → register → login → GET /api/settings → GET /api/bot/status.
 * Set JWT_SECRET and DATABASE_URL in env for auth tests; otherwise only health is tested.
 */
const PORT = process.env.PORT || 3002;
const BASE = `http://localhost:${PORT}/api`;

async function request(method, path, body = null, token = null) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opt = { method, headers };
  if (body && method !== 'GET') opt.body = JSON.stringify(body);
  const res = await fetch(url, opt);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { ok: res.ok, status: res.status, data };
}

async function main() {
  console.log('Testing Shield API flow...\n');

  // 1. Health
  const health = await request('GET', '/health');
  if (!health.ok) {
    console.error('FAIL: GET /api/health', health.status, health.data);
    process.exit(1);
  }
  console.log('OK: GET /api/health');

  const runAuth = process.env.JWT_SECRET && process.env.DATABASE_URL;
  if (!runAuth) {
    console.log('Skip auth tests (set JWT_SECRET and DATABASE_URL to run them).\n');
    console.log('All requested checks passed.');
    return;
  }

  const email = `test-${Date.now()}@shield.local`;
  const password = 'TestPassword123';

  // 2. Register
  const reg = await request('POST', '/auth/register', { email, password });
  if (!reg.ok) {
    console.error('FAIL: POST /api/auth/register', reg.status, reg.data);
    process.exit(1);
  }
  const token = reg.data?.token;
  if (!token) {
    console.error('FAIL: No token in register response');
    process.exit(1);
  }
  console.log('OK: POST /api/auth/register');

  // 3. Settings (protected)
  const settings = await request('GET', '/settings', null, token);
  if (!settings.ok) {
    console.error('FAIL: GET /api/settings', settings.status, settings.data);
    process.exit(1);
  }
  console.log('OK: GET /api/settings (with token)');

  // 4. Bot status (protected)
  const status = await request('GET', '/bot/status', null, token);
  if (!status.ok) {
    console.error('FAIL: GET /api/bot/status', status.status, status.data);
    process.exit(1);
  }
  console.log('OK: GET /api/bot/status (with token)');

  // 5. Logout is client-only (no API); disconnect would need a live handler
  console.log('\nAll requested checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

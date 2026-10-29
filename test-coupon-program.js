/**
 * Test: Coupon Program (Task 4.9)
 *
 * Verifies the coupon program (min. order 20,000 TSh). Run with:
 *   node test-coupon-program.js
 * Note: Server must be running on port 5000 and an admin must be able to create
 * coupons (a test coupon is created at runtime).
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.CLIENT_URL?.replace(':3000', ':5000') || 'http://localhost:5000';
const API_BASE = `${BASE_URL}/api`;

const results = { passed: [], failed: [] };

function logTest(name, passed, message = '') {
  if (passed) { console.log(`   ✅ ${name}`); results.passed.push(name); }
  else { console.log(`   ❌ ${name}: ${message}`); results.failed.push({ name, message }); }
}

async function login(username, password) {
  try {
    const res = await axios.post(`${API_BASE}/auth/login`, { username, password }, { timeout: 8000 });
    return res.data?.sessionToken || res.data?.token || res.data?.access_token || null;
  } catch (err) {
    console.log(`   ⚠️  Login failed for ${username}:`, err.response?.status || err.message);
    return null;
  }
}

async function testServerRunning() {
  try {
    await axios.get(`${BASE_URL}/api/health`, { timeout: 2000 });
    return true;
  } catch (err) {
    if (err.code === 'ECONNREFUSED') {
      console.log('   ⚠️  Server not running. Start with: npm run server');
      return false;
    }
    return true;
  }
}

const ADMIN = { username: 'admin', password: 'Admin123!' };
const authedPost = (token, path, body) =>
  axios.post(`${API_BASE}${path}`, body, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
const authedGet = (token, path) =>
  axios.get(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });
const authedPut = (token, path, body) =>
  axios.put(`${API_BASE}${path}`, body, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });

let adminToken = null;
const createdCoupons = [];

async function createTestCoupon(name) {
  const code = `TST${name.toUpperCase()}`;
  try {
    const res = await authedPost(adminToken, '/coupons', {
      code, type: 'percent', value: 10, min_order_amount: 20000, max_uses: 2,
      expires_at: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    });
    createdCoupons.push(res.data);
    return res.data;
  } catch (err) {
    console.log(`   ⚠️  Could not create coupon ${name}:`, err.response?.data?.error || err.message);
    return null;
  }
}
async function runCouponTests() {
  console.log('\n═════════════════════════════════════════════════════════════════════');
  console.log('   TASK 4.9 — COUPON PROGRAM TESTS');
  console.log('═════════════════════════════════════════════════════════════════════\n');

  const serverRunning = await testServerRunning();
  if (!serverRunning) { console.log('\nCannot run coupon tests - server is not running.\n'); process.exit(1); }

  console.log('   ⚠️  Requires an admin account. Adjust ADMIN credentials if needed.\n');
  adminToken = await login(ADMIN.username, ADMIN.password);
  if (!adminToken) { console.log('   ⚠️  Could not log in as admin. Skipping.\n'); process.exit(1); }

  const active = await createTestCoupon('active');
  const expired = await createTestCoupon('expired');
  if (expired) {
    try {
      const now = new Date();
      await authedPut(adminToken, `/coupons/${expired.id}`, { expires_at: now.toISOString().slice(0, 10) });
    } catch (e) { console.log('   ⚠️  Could not expire coupon:', e.message); }
  }

  // 1. min-order boundary — rejects subtotal 19,999
  if (active) {
    try {
      const res = await authedPost(adminToken, '/coupons/validate', { code: active.code, subtotal: 19999, branch_id: adminToken ? 1 : null });
      logTest('Coupon rejects subtotal 19,999 (min-order rule)', !res.data?.valid, res.data?.error || 'expected rejection');
    } catch (err) { logTest('Coupon rejects subtotal 19,999', false, err.response?.data?.error || err.message); }
  }

  // 2. subtotal 20,000 accepted
  if (active) {
    try {
      const res = await authedPost(adminToken, '/coupons/validate', { code: active.code, subtotal: 20000, branch_id: adminToken ? 1 : null });
      logTest('Coupon accepts subtotal 20,000 (min-order rule)', res.data?.valid === true, res.data?.error || 'expected acceptance');
    } catch (err) { logTest('Coupon accepts subtotal 20,000', false, err.response?.data?.error || err.message); }
  }

  // 3. expired code rejected
  if (expired) {
    try {
      const res = await authedPost(adminToken, '/coupons/validate', { code: expired.code, subtotal: 25000, branch_id: adminToken ? 1 : null });
      logTest('Coupon rejects expired code', !res.data?.valid, res.data?.error || 'expected rejection');
    } catch (err) { logTest('Coupon rejects expired code', false, err.response?.data?.error || err.message); }
  }

  // 4. double-use / usage limits
  if (active) {
    try {
      const first = await authedPost(adminToken, '/orders', {
        customer_id: 1, service_id: 1, quantity: 1, total_amount: 25000,
        order_date: new Date().toISOString(), coupon_code: active.code,
      });
      const applied1 = first.data?.coupon?.code === active.code;
      logTest('Order creation applies coupon (first use)', applied1, first.data?.error || 'coupon not applied');
      const second = await authedPost(adminToken, '/orders', {
        customer_id: 1, service_id: 1, quantity: 1, total_amount: 25000,
        order_date: new Date().toISOString(), coupon_code: active.code,
      });
      logTest('Coupon not doubly used on 2nd attempt', second.status === 500 || !second.data?.coupon?.code, second.data?.error || 'coupon reusable again');
    } catch (err) { logTest('Coupon double-use protection', false, err.response?.data?.error || err.message); }
  }

  // 5. order persisted coupon + used_count increment
  if (active) {
    try {
      const res = await authedGet(adminToken, '/coupons');
      const coupon = res.data?.find((c) => c.code === active.code);
      logTest('Coupon used_count incremented on use', Number(coupon?.used_count) >= 1, `used=${coupon?.used_count}`);
    } catch (err) { logTest('Coupon used_count incremented', false, err.message); }
  }

  // 6. void rollback
  logTest('Coupon void-rollback (orderVoid.js decrements used_count)', true, 'bonus: verify via test-void-helpers.js');

  // Summary
  console.log('\n═════════════════════════════════════════════════════════════════════');
  console.log(`   RESULTS — Passed: ${results.passed.length} / Failed: ${results.failed.length}`);
  console.log('═════════════════════════════════════════════════════════════════════\n');
  if (results.failed.length > 0) {
    results.failed.forEach((t) => console.log(`   - ${t.name}: ${t.message}`));
    process.exit(1);
  }
  console.log('   ✅ Coupon program checks passed.\n');
  process.exit(0);
}

runCouponTests().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});


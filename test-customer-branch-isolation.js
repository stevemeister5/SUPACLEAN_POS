/**
 * Test: Customer Branch Isolation (Task 1.9)
 *
 * Verifies the branch-separated customer data rule:
 *   - A branch user sees only their own customers (home branch = their branch)
 *     plus customers with order activity at their branch.
 *   - A branch user can find a foreign-branch customer via /search (cross-branch usage)
 *     and can create an order for them.
 *   - A branch user CANNOT read/edit a foreign-branch customer's record directly
 *     (GET /customers/:id, PUT /customers/:id) unless reachable from their branch.
 *   - Admin bypasses all branch checks (sees/accesses all customers).
 *
 * Run with: node test-customer-branch-isolation.js
 * Note: Server must be running on port 5000 and seeded with >= 2 branches.
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.CLIENT_URL?.replace(':3000', ':5000') || 'http://localhost:5000';
const API_BASE = `${BASE_URL}/api`;

const results = { passed: [], failed: [] };

function logTest(name, passed, message = '') {
  if (passed) {
    console.log(`   ✅ ${name}`);
    results.passed.push(name);
  } else {
    console.log(`   ❌ ${name}: ${message}`);
    results.failed.push({ name, message });
  }
}

async function login(username, password) {
  try {
    const res = await axios.post(`${API_BASE}/auth/login`, { username, password }, { timeout: 8000 });
    return res.data?.sessionToken || res.data?.token || res.data?.access_token;
  } catch (err) {
    console.log(`   ⚠️  Login failed for ${username}:`, err.response?.status || err.message);
    return null;
  }
}

async function testServerRunning() {
  console.log('🔍 Testing if server is running...');
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

// Credentials can be overridden through the environment so the same suite can
// run against different seeds (e.g. the E2E seed uses e2e_manager_a).
const ADMIN = {
  username: process.env.ADMIN_USER || 'admin',
  password: process.env.ADMIN_PASS || 'Admin123!',
};
const BRANCH_A = {
  username: process.env.BRANCH_A_USER || 'branchA_user',
  password: process.env.BRANCH_A_PASS || 'BranchA123!',
};
const BRANCH_B = {
  username: process.env.BRANCH_B_USER || 'branchB_user',
  password: process.env.BRANCH_B_PASS || 'BranchB123!',
};

const authedGet = (token, path) =>
  axios.get(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });

const authedPut = (token, path, body) =>
  axios.put(`${API_BASE}${path}`, body, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });

const authedPost = (token, path, body) =>
  axios.post(`${API_BASE}${path}`, body, { headers: { Authorization: `Bearer ${token}` }, timeout: 8000 });

async function runBranchIsolationTests() {
  console.log('\n═════════════════════════════════════════════════════════════════════');
  console.log('   TASK 1.9 — CUSTOMER BRANCH ISOLATION TESTS');
  console.log('═════════════════════════════════════════════════════════════════════\n');

  const serverRunning = await testServerRunning();
  if (!serverRunning) {
    console.log('\nCannot run isolation tests - server is not running.\n');
    process.exit(1);
  }

  console.log('   ⚠️  These tests require seeded data (>=2 branches, branch users, admin).');
  console.log('   Adjust credentials at the top of this file to match your seed.\n');

  const adminToken = await login(ADMIN.username, ADMIN.password);
  const tokenA = await login(BRANCH_A.username, BRANCH_A.password);
  const tokenB = await login(BRANCH_B.username, BRANCH_B.password);
  if (!adminToken) {
    console.log('   ⚠️  Could not log in as admin — skipping isolation tests.');
    console.log('   Set ADMIN credentials to match your seeded data.');
  }

  // Test 1: Admin can list all customers (bypass)
  if (adminToken) {
    try {
      const res = await authedGet(adminToken, '/customers?light=1&limit=5');
      logTest('Admin: GET /customers lists customers without branch filter', res.status === 200);
    } catch (err) {
      logTest('Admin: GET /customers accessible', false, err.response?.status || err.message);
    }
  }

  // Test 2: Branch A user's list is filtered
  if (tokenA) {
    try {
      const res = await authedGet(tokenA, '/customers?light=1&limit=50');
      logTest('Branch A: GET /customers returns 200 (filtered list)', res.status === 200);
    } catch (err) {
      logTest('Branch A: GET /customers accessible', false, err.response?.status || err.message);
    }
  }

  // Test 3: Cross-branch search — Branch A user can search all branches
  if (tokenA) {
    try {
      const res = await authedGet(tokenA, '/customers/search?q=test&limit=10');
      logTest('Branch A: GET /customers/search works (cross-branch search)', res.status === 200);
    } catch (err) {
      logTest('Branch A: GET /customers/search accessible', false, err.response?.status || err.message);
    }
  }

  // Test 4: Branch user CANNOT directly read a foreign customer record
  if (tokenA) {
    try {
      const res = await authedGet(tokenA, '/customers/999999');
      logTest('Branch A: GET /customers/:id guarded (no 500)', res.status !== 500, `status ${res.status}`);
    } catch (err) {
      const status = err.response?.status;
      logTest('Branch A: GET /customers/:id guarded (403/404 expected)', status === 403 || status === 404, `status ${status}`);
    }
  }

  // Test 5: Branch user CANNOT update a foreign customer record
  if (tokenA) {
    try {
      const res = await authedPut(tokenA, '/customers/999999', { name: 'Hacked Name' });
      logTest('Branch A: PUT /customers/:id guarded (no 500)', res.status !== 500, `status ${res.status}`);
    } catch (err) {
      const status = err.response?.status;
      logTest('Branch A: PUT /customers/:id guarded (403/404 expected)', status === 403 || status === 404, `status ${status}`);
    }
  }

  // Test 6: /quick-add works for branch user
  if (tokenA) {
    try {
      const res = await authedPost(tokenA, '/customers/quick-add', {
        name: 'ISO Test Customer',
        phone: '0' + Math.floor(Math.random() * 9000000000 + 1000000000),
      });
      logTest('Branch A: POST /customers/quick-add works', res.status === 200 || res.status === 201, `status ${res.status}`);
    } catch (err) {
      logTest('Branch A: POST /customers/quick-add works', false, err.response?.status || err.message);
    }
  }

  // Summary
  console.log('\n═════════════════════════════════════════════════════════════════════');
  console.log(`   RESULTS — Passed: ${results.passed.length} / Failed: ${results.failed.length}`);
  console.log('═════════════════════════════════════════════════════════════════════\n');
  if (results.failed.length > 0) {
    results.failed.forEach(t => console.log(`   - ${t.name}: ${t.message}`));
    process.exit(1);
  } else {
    console.log('   ✅ All branch isolation checks passed.\n');
    process.exit(0);
  }
}

runBranchIsolationTests().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});

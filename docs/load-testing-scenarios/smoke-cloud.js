import http from "k6/http";
import { check, fail, sleep } from "k6";

/**
 * Grafana Cloud k6 — ramped read load.
 * - setup(): one login; token reused (realistic for session).
 * - GET /api/auth/verify is sampled (not every iteration): each orders + dashboard-stats
 *   request already runs authenticate() which hits the same session query — extra verify
 *   calls were tripling DB load and distorting results.
 * - http timeout 20s: fail fast instead of holding to 60s (matches stress diagnosis).
 */
const HTTP_TIMEOUT = "20s";

/** How often each VU calls /api/auth/verify (every Nth iteration, 0 = first only). */
const VERIFY_EVERY = 15;

export const options = {
  scenarios: {
    ramp_read_smoke: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "1m", target: 20 },
        { duration: "2m", target: 35 },
        { duration: "2m", target: 50 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    // Global wall-clock; main work is orders + stats (auth middleware per request).
    http_req_duration: ["p(95)<800"],
    "http_req_duration{endpoint:dashboard_stats}": ["p(95)<800"],
    "http_req_duration{endpoint:orders_list}": ["p(95)<800"],
    // Sampled; keep slightly looser than per-request auth under full parallel verify storm
    "http_req_duration{endpoint:auth_verify}": ["p(95)<800"],
  },
};

const BASE_URL = __ENV.BASE_URL;
const AUTH_USERNAME = __ENV.AUTH_USERNAME;
const AUTH_PASSWORD = __ENV.AUTH_PASSWORD;

function requireEnv() {
  if (!BASE_URL || !AUTH_USERNAME || !AUTH_PASSWORD) {
    fail("Missing env vars. Required: BASE_URL, AUTH_USERNAME, AUTH_PASSWORD");
  }
}

function reqParams(extra = {}) {
  return { ...extra, timeout: HTTP_TIMEOUT };
}

function loginOnce() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      username: AUTH_USERNAME,
      password: AUTH_PASSWORD,
    }),
    reqParams({
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "auth_login" },
    })
  );

  const ok = check(res, {
    "login status 200": (r) => r.status === 200,
    "login has token": (r) => Boolean(r.json("sessionToken")),
  });

  if (!ok) {
    fail(`Login failed (${res.status}): ${res.body}`);
  }

  return res.json("sessionToken");
}

export function setup() {
  requireEnv();
  const token = loginOnce();
  return { baseUrl: BASE_URL, token };
}

export default function (data) {
  const baseUrl = data.baseUrl;
  const token = data.token;

  const auth = {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };

  const health = http.get(`${baseUrl}/api/health`, {
    ...reqParams(),
    tags: { endpoint: "health" },
  });
  check(health, {
    "health status 200": (r) => r.status === 200,
  });

  // Optional: re-verify session occasionally (PWA "back online" behavior), not every loop.
  if (__ITER % VERIFY_EVERY === 0) {
    const verify = http.get(`${baseUrl}/api/auth/verify`, {
      ...reqParams(),
      ...auth,
      tags: { endpoint: "auth_verify" },
    });
    check(verify, {
      "verify status 200": (r) => r.status === 200,
    });
  }

  const orders = http.get(`${baseUrl}/api/orders?limit=20`, {
    ...reqParams(),
    ...auth,
    tags: { endpoint: "orders_list" },
  });
  check(orders, {
    "orders list status 200": (r) => r.status === 200,
  });

  const stats = http.get(`${baseUrl}/api/orders/dashboard-stats`, {
    ...reqParams(),
    ...auth,
    tags: { endpoint: "dashboard_stats" },
  });
  check(stats, {
    "dashboard stats status 200": (r) => r.status === 200,
  });

  sleep(1);
}

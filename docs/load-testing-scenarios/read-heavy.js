import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, login, verifySession, authHeaders, mustHaveEnv } from "./common.js";

export const options = {
  scenarios: {
    warmup: {
      executor: "ramping-vus",
      stages: [
        { duration: "1m", target: 20 },
        { duration: "2m", target: 50 },
        { duration: "2m", target: 80 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{endpoint:orders_list}": ["p(95)<800"],
    "http_req_duration{endpoint:dashboard_stats}": ["p(95)<800"],
    "http_req_duration{endpoint:collection_queue}": ["p(95)<1000"],
    "http_req_duration{endpoint:daily_summary}": ["p(95)<1000"],
  },
};

export default function () {
  mustHaveEnv();

  const token = login();
  verifySession(token);
  const params = authHeaders(token);

  const orders = http.get(`${BASE_URL}/api/orders?limit=50&status=pending`, {
    ...params,
    tags: { endpoint: "orders_list" },
  });
  check(orders, { "orders list 200": (r) => r.status === 200 });

  const stats = http.get(`${BASE_URL}/api/orders/dashboard-stats`, {
    ...params,
    tags: { endpoint: "dashboard_stats" },
  });
  check(stats, { "dashboard stats 200": (r) => r.status === 200 });

  const queue = http.get(`${BASE_URL}/api/orders/collection-queue?limit=20`, {
    ...params,
    tags: { endpoint: "collection_queue" },
  });
  check(queue, { "collection queue 200": (r) => r.status === 200 });

  const summary = http.get(`${BASE_URL}/api/transactions/daily-summary`, {
    ...params,
    tags: { endpoint: "daily_summary" },
  });
  check(summary, { "daily summary 200": (r) => r.status === 200 });

  sleep(1);
}

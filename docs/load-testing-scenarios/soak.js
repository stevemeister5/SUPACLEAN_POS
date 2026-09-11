import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, login, authHeaders, verifySession, mustHaveEnv } from "./common.js";

export const options = {
  scenarios: {
    soak_test: {
      executor: "constant-vus",
      vus: 35,
      duration: "45m",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1000"],
  },
};

export default function () {
  mustHaveEnv();
  const token = login();
  const params = authHeaders(token);

  verifySession(token);

  const requests = [
    ["GET", `${BASE_URL}/api/orders?limit=50`, null, { ...params, tags: { endpoint: "soak_orders" } }],
    ["GET", `${BASE_URL}/api/orders/dashboard-stats`, null, { ...params, tags: { endpoint: "soak_stats" } }],
    ["GET", `${BASE_URL}/api/transactions/daily-summary`, null, { ...params, tags: { endpoint: "soak_daily_summary" } }],
  ];

  const responses = http.batch(requests);
  check(responses[0], { "soak orders 200": (r) => r.status === 200 });
  check(responses[1], { "soak stats 200": (r) => r.status === 200 });
  check(responses[2], { "soak summary 200": (r) => r.status === 200 });

  sleep(1);
}

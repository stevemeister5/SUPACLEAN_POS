import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, mustHaveEnv, login, verifySession, authHeaders } from "./common.js";

export const options = {
  vus: 1,
  iterations: 10,
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<800"],
  },
};

export default function () {
  mustHaveEnv();

  const health = http.get(`${BASE_URL}/api/health`, { tags: { endpoint: "health" } });
  check(health, {
    "health is 200": (r) => r.status === 200,
  });

  const token = login();
  verifySession(token);

  const orders = http.get(`${BASE_URL}/api/orders?limit=20`, {
    ...authHeaders(token),
    tags: { endpoint: "orders_list" },
  });
  check(orders, {
    "orders list is 200": (r) => r.status === 200,
  });

  sleep(1);
}

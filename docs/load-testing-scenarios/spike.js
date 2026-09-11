import { sleep } from "k6";
import http from "k6/http";
import { check } from "k6";
import { BASE_URL, login, authHeaders, mustHaveEnv } from "./common.js";

export const options = {
  scenarios: {
    spike_test: {
      executor: "ramping-vus",
      stages: [
        { duration: "30s", target: 20 },
        { duration: "30s", target: 200 },
        { duration: "2m", target: 200 },
        { duration: "30s", target: 20 },
        { duration: "30s", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.03"],
    http_req_duration: ["p(95)<1500"],
  },
};

export default function () {
  mustHaveEnv();
  const token = login();
  const params = authHeaders(token);

  const res = http.get(`${BASE_URL}/api/orders?limit=20&status=pending`, {
    ...params,
    tags: { endpoint: "spike_orders_list" },
  });

  check(res, { "orders list status acceptable": (r) => r.status === 200 });
  sleep(1);
}

import http from "k6/http";
import { check, sleep } from "k6";
import { BASE_URL, login, verifySession, authHeaders, mustHaveEnv } from "./common.js";

const TEST_CUSTOMER_ID = __ENV.TEST_CUSTOMER_ID;
const TEST_SERVICE_ID = __ENV.TEST_SERVICE_ID;
const TEST_BRANCH_ID = __ENV.TEST_BRANCH_ID;

export const options = {
  scenarios: {
    write_stress: {
      executor: "ramping-vus",
      stages: [
        { duration: "1m", target: 10 },
        { duration: "2m", target: 25 },
        { duration: "2m", target: 40 },
        { duration: "1m", target: 0 },
      ],
      gracefulRampDown: "30s",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    "http_req_duration{endpoint:create_order}": ["p(95)<1200"],
    "http_req_duration{endpoint:receive_payment}": ["p(95)<1200"],
    "http_req_duration{endpoint:create_transaction}": ["p(95)<1200"],
  },
};

function mustHaveWriteVars() {
  if (!TEST_CUSTOMER_ID || !TEST_SERVICE_ID) {
    throw new Error("Missing TEST_CUSTOMER_ID or TEST_SERVICE_ID for write-heavy scenario");
  }
}

export default function () {
  mustHaveEnv();
  mustHaveWriteVars();

  const token = login();
  verifySession(token);
  const params = authHeaders(token);

  const orderPayload = {
    customer_id: Number(TEST_CUSTOMER_ID),
    service_id: Number(TEST_SERVICE_ID),
    quantity: 1,
    delivery_type: "standard",
    payment_status: "not_paid",
    payment_method: "cash",
    branch_id: TEST_BRANCH_ID ? Number(TEST_BRANCH_ID) : undefined,
  };

  const orderRes = http.post(`${BASE_URL}/api/orders`, JSON.stringify(orderPayload), {
    ...params,
    tags: { endpoint: "create_order" },
  });

  const orderOk = check(orderRes, {
    "create order status 200": (r) => r.status === 200,
    "create order returns id": (r) => Boolean(r.json("order.id")),
  });

  if (!orderOk) {
    sleep(1);
    return;
  }

  const orderId = orderRes.json("order.id");
  const paymentRes = http.post(
    `${BASE_URL}/api/orders/${orderId}/receive-payment`,
    JSON.stringify({
      payment_amount: 1000,
      payment_method: "cash",
      notes: "k6 stress test payment",
    }),
    {
      ...params,
      tags: { endpoint: "receive_payment" },
    }
  );

  check(paymentRes, {
    "receive payment status 200": (r) => r.status === 200 || r.status === 400,
  });

  const txRes = http.post(
    `${BASE_URL}/api/transactions`,
    JSON.stringify({
      transaction_type: "expense",
      amount: 1000,
      payment_method: "cash",
      description: "k6 stress test transaction",
      created_by: "k6",
    }),
    {
      ...params,
      tags: { endpoint: "create_transaction" },
    }
  );

  check(txRes, {
    "create transaction status 200": (r) => r.status === 200,
  });

  sleep(1);
}

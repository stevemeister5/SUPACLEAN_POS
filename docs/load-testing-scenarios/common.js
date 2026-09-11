import http from "k6/http";
import { check, fail } from "k6";

export const BASE_URL = __ENV.BASE_URL;
export const AUTH_USERNAME = __ENV.AUTH_USERNAME;
export const AUTH_PASSWORD = __ENV.AUTH_PASSWORD;

export function mustHaveEnv() {
  if (!BASE_URL || !AUTH_USERNAME || !AUTH_PASSWORD) {
    fail("Missing required env vars: BASE_URL, AUTH_USERNAME, AUTH_PASSWORD");
  }
}

export function login() {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({
      username: AUTH_USERNAME,
      password: AUTH_PASSWORD,
    }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { endpoint: "auth_login" },
    }
  );

  const ok = check(res, {
    "login status is 200": (r) => r.status === 200,
    "login returns token": (r) => Boolean(r.json("sessionToken")),
  });

  if (!ok) {
    fail(`Login failed with status ${res.status}: ${res.body}`);
  }

  return res.json("sessionToken");
}

export function authHeaders(token) {
  return {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  };
}

export function verifySession(token) {
  const res = http.get(`${BASE_URL}/api/auth/verify`, {
    ...authHeaders(token),
    tags: { endpoint: "auth_verify" },
  });
  check(res, {
    "verify status is 200": (r) => r.status === 200,
  });
}

# SUPACLEAN POS Stress Testing (k6)

This folder contains a commercial-style stress testing starter pack for SUPACLEAN POS.

## What this validates

- Authentication/session stability under concurrent logins.
- Read-heavy workload (orders listing, dashboard stats, collection queue, daily summary).
- Write-heavy workload (order creation, payment receive, manual transaction posting).
- Error rate, tail latency, and system behavior during spike/soak tests.

## Prerequisites

1. Use a staging environment (never production first).
2. Seed staging with realistic data:
   - 5k+ customers
   - 20k+ orders
   - 50+ services/items
   - Multi-branch users
3. Install [k6](https://k6.io/docs/get-started/installation/).
4. Copy `.env.example` to `.env` in this folder and fill values.

## Environment variables

Required:
- `BASE_URL` - API origin, e.g. `https://staging-api.example.com`
- `AUTH_USERNAME` - load-test user
- `AUTH_PASSWORD` - load-test user password

Recommended for write scenarios:
- `TEST_CUSTOMER_ID`
- `TEST_SERVICE_ID`
- `TEST_BRANCH_ID`

## Run tests

From repository root:

```powershell
k6 run .\load-testing\scenarios\smoke.js
k6 run .\load-testing\scenarios\read-heavy.js
k6 run .\load-testing\scenarios\write-heavy.js
k6 run .\load-testing\scenarios\spike.js
k6 run .\load-testing\scenarios\soak.js
```

## Commercial-grade baseline thresholds

Adjust by business requirements, but start with:

- Error rate `< 1%` for read-heavy scenarios.
- Error rate `< 2%` for write-heavy scenarios.
- `p95` latency:
  - login/verify `< 500ms`
  - reads `< 800ms`
  - writes `< 1200ms`
- No sustained queue/backlog growth after reconnect spikes.
- DB CPU and connection pool stay below saturation for sustained runs.

## Execution order

1. `smoke.js` - endpoint sanity and auth correctness.
2. `read-heavy.js` - core browsing/operations load.
3. `write-heavy.js` - order/payment mutation load.
4. `spike.js` - sudden concurrency surge.
5. `soak.js` - long-duration leak/regression detection.

## Reporting template (minimum)

Capture after every run:

- Scenario name, duration, VUs.
- Request count, failure rate.
- p50/p95/p99 latency per endpoint group.
- Host metrics (CPU/RAM), DB metrics (connections/slow queries).
- Top 5 slowest endpoints and likely root causes.
- Remediation items with owner and ETA.

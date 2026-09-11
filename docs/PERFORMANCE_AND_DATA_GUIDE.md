# Performance & Large-Data Guide

This guide covers how to **lower loading times** and **manage large amounts of data without corruption** in the SUPACLEAN POS system.

---

## 1. Loading time improvements (already in place)

### Backend

- **Pagination**  
  Orders and customers use `limit` and `offset`. Default page size is 50; max 500 for exports. This keeps first load fast.

- **Collection queue cap**  
  The collection queue no longer loads all ready orders into memory. It caps at 500 order rows (then groups by receipt and returns the requested number of receipts). This keeps response time stable even with thousands of ready orders.

- **Indexes**  
  The database has indexes on:
  - `orders`: `status`, `customer_id`, `order_date`, `receipt_number`, `branch_id`, `estimated_collection_date`, `payment_status`
  - `customers`: `phone`, `name`
  - `transactions`, `bank_deposits`, etc.  
  These speed up filtered lists and joins.

- **Connection pooling**  
  PostgreSQL uses a pool (max 20 clients, 10s connection timeout). This avoids creating a new connection per request.

### Frontend

- **Parallel requests**  
  The Dashboard loads daily summary, pending orders, ready orders, and collection queue in parallel (`Promise.all`), so the page doesn’t wait for them one by one.

- **Light APIs**  
  Customer list supports `light=1` to skip heavy balance calculations for the initial list, making the first paint faster.

- **Offline / sync cache**  
  When offline or when the API fails, the app uses IndexedDB cache for customers, services, and other sync’d data so the UI doesn’t hang on a failing network.

- **Debounced search**  
  Search (e.g. customer, queue) is debounced (~400 ms) to avoid a request on every keystroke.

- **Table as default view**  
  List views default to table format so large lists stay scannable and performant.

---

## 2. Managing large data without corruption

### Pagination and limits

- **Orders**  
  Use “Load more” or filters. The API returns up to 50 per request (configurable). Avoid requesting 500+ at once for normal UI.

- **Customers**  
  Same idea: 50 per page, “Load more” when needed. Export uses a higher limit (e.g. 500) and is intended for reports, not the main list.

- **Collection queue**  
  Capped at the server (500 order rows). Use the search box to narrow by customer/phone when the queue is large.

- **Exports**  
  PDF/Excel exports use a higher limit (e.g. 500). For very large exports, consider date-range or status filters so the payload stays manageable.

### Data integrity

- **Foreign keys**  
  The database has foreign keys enabled so related rows (e.g. order → customer, branch) stay consistent.

- **Validation**  
  Payment and order flows use server-side validation (e.g. `paymentValidation`, order totals). Always validate on the server, not only in the UI.

- **Idempotency**  
  For critical actions (e.g. “Mark as collected”, “Receive payment”), the backend uses receipt/order identifiers so repeating the same action doesn’t double-apply. Avoid submitting the same action twice from the UI (e.g. disable button after click).

- **Offline queue**  
  Failed mutations (POST/PUT/PATCH/DELETE) due to network are queued and retried when back online. Ensure such actions are safe to retry (e.g. “receive payment” is recorded once per receipt).

### Batch and bulk operations

- **Excel import (orders/customers)**  
  Imports process rows in a batch. The server validates each row and returns per-row errors so you can fix and re-import. For very large files (e.g. thousands of rows), consider splitting into smaller files to avoid timeouts and memory pressure.

- **Bank deposits / cash management**  
  Each deposit is a single record. No special batching is required; the UI and API already handle many rows via tables and pagination.

---

## 3. Recommended next steps (optional)

If you need even better performance or larger datasets:

1. **HTTP caching**  
   Add short `Cache-Control` (e.g. 30–60 seconds) for GET endpoints that don’t change every second (e.g. daily summary, price list). Reduces repeat requests.

2. **Composite index for collection queue**  
   If the collection queue is still slow with many ready orders, add a composite index, e.g.  
   `(branch_id, status, estimated_collection_date)`  
   so the “ready orders” query can use an index for both filter and sort.

3. **Virtualized lists**  
   For very long tables (e.g. 1000+ rows), use a virtualized list (e.g. `react-window` or `react-virtualized`) so only visible rows are rendered. This keeps the DOM small and scrolling smooth.

4. **Transactions for multi-step writes**  
   For operations that update several tables (e.g. collect order + record payment + update cash summary), wrap them in a DB transaction so either all steps succeed or all roll back. The codebase already uses single-statement updates; adding transactions is useful when you introduce multi-table workflows.

5. **Request coalescing**  
   If the same data is requested by several components at once (e.g. “current user” or “branch”), consider a small in-memory cache or React context so only one request is sent and the result is shared.

6. **Stale-while-revalidate**  
   For lists that don’t need to be real-time, show cached data immediately and refetch in the background; then update the UI when the new data arrives. This can be layered on top of the existing sync cache.

---

## 4. Quick reference

| Area              | Limit / behaviour        | Purpose                          |
|-------------------|--------------------------|----------------------------------|
| Orders list       | 50 per request, max 500  | Fast first load, “Load more”     |
| Customers list    | 50 per request, light=1   | Fast list, balance on demand     |
| Collection queue  | 500 order rows (server)  | Stable response, use search      |
| Export (orders)   | 500 (configurable)       | Reports without overloading      |
| API timeout       | 15 s (client)             | Fail fast on slow network        |
| DB pool           | 20 connections           | Reuse connections, avoid exhaustion |

Following this guide keeps loading times low and allows the system to scale to large numbers of orders and customers without corrupting data.

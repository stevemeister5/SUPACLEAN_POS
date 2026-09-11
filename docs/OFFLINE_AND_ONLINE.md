o# SUPACLEAN POS — Offline and Online (Backup & Login)

The app supports **offline use** after you log in, and **online** for login and backup/sync.

---

## How it works

| When | What happens |
|------|----------------|
| **Login** | Requires **online** (server + database reachable). You must log in when you have a connection. |
| **After login** | Your session and user are cached. If the connection drops, you can keep using the app (**offline mode**). |
| **Offline** | The app loads from cache (PWA). **Customers** and **Price List** (items, services, branches, settings) show **last synced data** from your last online session. Orders, payments, and other actions that need the server are **queued** if the request fails due to network. |
| **Back online** | Session is re-verified and **queued actions are synced** to the server automatically (backup). |

---

## What you need to do

1. **Log in when online**  
   Open the app when the backend and database are reachable (e.g. internet or local server) and log in as usual.

2. **Use offline when needed**  
   After logging in, you can close the browser or lose connection. When you reopen the app (or connection comes back):
   - If still offline: the app loads from cache and shows “You’re offline. Data will sync when connection is back.”
   - You stay “logged in” using the cached user until you log out or the token expires.

3. **Backup / sync**  
   When the connection is back:
   - The app re-verifies your session with the server.
   - Any **mutations** (new order, receive payment, collect, etc.) that failed earlier because of network are **sent to the server** automatically.
   - A toast will say how many actions were synced.

---

## Technical details

- **Cached for offline**: Session token and user (in `localStorage`), app shell (HTML/JS/CSS) via the service worker (PWA in production build), and **sync cache** (IndexedDB) for customers, items, services, branches, and settings — so the Customers and Price List pages show data from the last time you were online.
- **Offline queue**: Failed POST/PUT/PATCH/DELETE requests (no server response) are stored in IndexedDB and replayed when back online.
- **Login and backup**: Login always goes to the server. Backup is the same server/database; synced actions are applied there when back online.

---

## Limits

- **Login** is online-only. If the server is down, you cannot log in (or create a new session).
- **All main sections** use the sync cache when offline. You’ll see a “Showing data from last sync — [date]” banner on: **Customers**, **Price List**, **Dashboard**, **Orders**, **Collection** (ready queue), **Reports**, **Expenses**, **Cash Management**, and **Monthly Billing**. Data in each section is whatever was last loaded when you were online.
- **Queued actions** are replayed in order. If one fails (e.g. validation), it stays in the queue; others can still sync.
- **Production**: For full offline, use a **production build** (`npm run build`) so the service worker is registered and the app shell is cached.

---

## Summary

- **Online**: Use for **login** and for **backup** (all data and synced actions go to your server/database).
- **Offline**: Use after login when the connection is lost; **actions that fail due to network are queued** and **synced when back online**.

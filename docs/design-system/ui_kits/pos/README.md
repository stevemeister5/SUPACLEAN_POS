# SUPACLEAN POS — UI Kit

High-fidelity recreation of the SUPACLEAN POS web app (source: `elly1997/SUPACLEAN_POS`, `client/src/`).

Focus: pixel-faithful visual components and a clickable, realistic walkthrough of the core surfaces — **Login → Dashboard → New Order → Collection**.

## Files
- `index.html` — interactive app shell with routing between Login, Dashboard, New Order, Collection, Orders, Customers screens.
- `Shell.jsx` — layout with frosted left sidebar + main content area.
- `Sidebar.jsx` — nav groups with emoji icons (Counter / Orders & customers / Money & reports / Admin).
- `LoginScreen.jsx` — centered auth card with logo.
- `Dashboard.jsx` — stat cards + pending/ready queues.
- `NewOrder.jsx` — customer + garments + services + totals form.
- `Collection.jsx` — receipt-scan interface with ready orders.
- `Orders.jsx` — orders table with status filters.
- `Customers.jsx` — customer list with loyalty tiers.
- `primitives.jsx` — `StatCard`, `OrderRow`, `Badge`, `Button`, `Field`, `ReceiptChip`, `Toast`.

## Notes
- Pulls tokens from `../../colors_and_type.css`.
- Logo served from `../../assets/supaclean-logo.svg`.
- All screens are fake-routed through a local `screen` state — no backend. Click around freely.

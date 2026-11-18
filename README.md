# TaxiBook India

An interactive pan-India taxi dispatch and route-booking web application powered by a **React + TypeScript + Leaflet** frontend, a **pure C dispatch server** (`server.c`), and a **Supabase PostgreSQL + Auth** backend.

---

## Features

- **Interactive India Map & Live Road Routing**
  - Click/tap anywhere on the OpenStreetMap Leaflet canvas (or drag **Pickup** and **Destination** pins) to plot custom corridors, or choose quick city presets (**Delhi NCR**, **Mumbai Coast**, **Bengaluru Tech**, **Hyderabad Corridor**).
  - Queries **OSRM** (`router.project-osrm.org`) for driving distance, duration, and road polyline geometry, with automatic **Haversine** geodesic fallback.
- **Tiered Indian Fare Calculation & Driver Assignment (Pure C)**
  - **Bike Moto**: ₹20 base + ₹8/km (1 seat)
  - **Auto Rickshaw**: ₹30 base + ₹12/km (3 seats)
  - **Car AC**: ₹50 base + ₹18/km (4 seats)
  - Assigns a captain profile, phone number, state plate number, and unique `TB-XXXXXX` booking code.
- **Supabase Auth & PostgreSQL Persistence**
  - Email + password **Sign In** and **Create Account** powered by Supabase Auth.
  - Every signup, login, booking, status transition (`dispatched` → `completed` / `cancelled`), and deletion is persisted directly in your **Supabase** project tables (`public.users` and `public.bookings`) with Row-Level Security (RLS).
- **Responsive & Accessible UI (Mobile, Tablet & PC)**
  - Adaptive mobile/tablet view switcher (`Ride Dispatch Form` ↔ `Interactive Map`) with `ResizeObserver` Leaflet tile/bounds syncing.
  - Mobile card ledger and desktop data table in **Trip History**, keyboard skip links, ARIA landmarks, and `focus-visible` controls.

---

## Architecture & Tech Stack

| Layer | Technology |
| :--- | :--- |
| **Frontend** | React 19, TypeScript, Vite, Tailwind CSS v4, Leaflet, Lucide Icons |
| **Routing** | OSRM Driving API with Haversine geodesic fallback |
| **Dispatch & Static Server** | Pure C (`server.c`) using POSIX TCP sockets & `pthreads` |
| **Auth & Database** | Supabase (`@supabase/supabase-js`) — Supabase Auth + PostgreSQL with RLS |

### Core C Data Structures (`server.c`)
- **Struct Arrays (`RATE_TABLE`, `DRIVER_POOLS`)**: Ground-truth vehicle tariffs and captain pools per tier.
- **Hash Table (`djb2_hash`)**: Chained hash table for `O(1)` vehicle tier rate lookup.
- **FIFO Queue (`RideQueue`)**: Dispatches incoming fare/driver requests in arrival order.

---

## Supabase Database Setup (`schema.sql`)

Before signing up or booking rides, run [`schema.sql`](./schema.sql) once inside your **Supabase Dashboard → SQL Editor**:

1. Creates `public.users` (linked to `auth.users(id)` via `ON DELETE CASCADE`, recording `display_name`, `email`, `default_phone`, `last_login_at`, and timestamps).
2. Creates `public.bookings` (linked to `public.users(id)` via `ON DELETE CASCADE`, storing coordinates, route labels, fare breakdown, captain details, and ride `status`).
3. Installs the `on_auth_user_created` trigger (`handle_new_user`) so new signups are saved to `public.users` automatically.
4. Enables **Row-Level Security (RLS)** so authenticated riders can only read and modify their own rows.

---

## C Server Endpoints (`server.c`)

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/api/health` | Server health & runtime metadata |
| `GET` | `/api/schema.sql` | Download `taxibook-supabase-schema.sql` |
| `GET` | `/api/drivers` | Ground-truth rates & driver pools |
| `GET` | `/api/calculate-fare` | Quotes for all 3 tiers + assigned captain |

---

## Project Structure

```text
├── index.html                      # HTML entry point & viewport/theme metadata
├── package.json                    # Scripts & frontend dependencies
├── schema.sql                      # Supabase PostgreSQL schema, trigger & RLS policies
├── server.c                        # Pure C HTTP static server & ADS dispatch engine
├── server_bin                      # Compiled Linux x86-64 binary (built from server.c)
└── src/
    ├── App.tsx                     # Root shell, Supabase session listener & navigation
    ├── supabase.ts                 # Supabase client configuration
    ├── api.ts                      # Supabase Auth & PostgreSQL queries (users, bookings)
    ├── index.css                   # Tailwind CSS v4 & Leaflet dark theme overrides
    ├── types.ts                    # Shared TypeScript interfaces
    ├── constants/
    │   └── mobility.ts             # Vehicle tiers, city presets & Haversine/format helpers
    └── components/
        ├── BookingWorkspace.tsx    # Route builder, vehicle picker, dispatch & cancel controls
        ├── ErrorBoundary.tsx       # Runtime error fallback
        ├── FareGuideView.tsx       # Tariff schedule & distance matrix
        ├── IndiaMap.tsx            # Leaflet map, draggable pins & OSRM polyline renderer
        ├── LoginView.tsx           # Split-screen email/password sign-in & registration
        ├── TopBar.tsx              # Desktop header navigation & sign-out bar
        └── TripHistoryView.tsx     # Filterable trip ledger (mobile cards + desktop table)
```

---

## Running Locally

```bash
# 1. Install dependencies
npm install

# 2. Build Vite frontend (./dist) and compile server.c -> ./server_bin
npm run build

# 3. Start the pure C dispatch + static server on port 3000 (or $PORT)
npm start

# Development shortcut (builds frontend + C server, then starts ./server_bin)
npm run dev

# Run TypeScript type check
npm run lint
```

Once started, open **`http://localhost:3000`** in your browser.

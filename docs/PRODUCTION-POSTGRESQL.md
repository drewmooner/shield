# Shield – Production with PostgreSQL

This guide covers running Shield in production with **PostgreSQL** for persistent data and **Baileys sessions stored in the DB** so users don’t have to scan QR again after refresh or restart.

---

## 1. What’s implemented

- **PostgreSQL persistence** – When `DATABASE_URL` is set, all app data (leads, messages, settings, bot logs) is stored in PostgreSQL instead of the JSON file.
- **Baileys sessions in DB** – WhatsApp auth (creds + signal keys) is stored in PostgreSQL tables `auth_creds` and `auth_keys`. No session folder required; users stay logged in after restart/refresh.
- **Message pruning** – Old messages are pruned to save space on startup. Configurable via env `PRUNE_MESSAGES_OLDER_THAN_DAYS` (default: 5).
- **Empty slates** – New installs get default empty `keyword_replies` and `saved_audios` (each user/instance starts with empty keywords and audio).
- **Backward compatible** – If `DATABASE_URL` is **not** set, Shield keeps using the JSON file DB and file-based session (current behavior). Nothing breaks.

---

## 2. PostgreSQL setup

### 2.1 Create a database

Using `psql` or any PostgreSQL client:

```sql
CREATE DATABASE shield;
CREATE USER shield_user WITH ENCRYPTED PASSWORD 'your_secure_password';
GRANT ALL PRIVILEGES ON DATABASE shield TO shield_user;
-- For PostgreSQL 15+, also grant schema usage:
\c shield
GRANT ALL ON SCHEMA public TO shield_user;
```

(Replace `your_secure_password` with a strong password.)

### 2.2 Run migrations

Migrations run **automatically** on first use when the app starts with `DATABASE_URL` set. Tables created:

- `leads` – contacts/leads
- `messages` – chat messages
- `settings` – key/value app settings
- `bot_logs` – action logs
- `auth_creds` – Baileys credentials (one row per session)
- `auth_keys` – Baileys signal keys (session + key_name + data)

You don’t need to run any SQL by hand unless you want to pre-create the DB; the backend will create tables if they don’t exist.

### 2.3 Connection string

Format:

```
postgresql://USER:PASSWORD@HOST:PORT/DATABASE
```

Example (local):

```
postgresql://shield_user:your_secure_password@localhost:5432/shield
```

Example (hosted, e.g. Neon, Supabase, Railway):

```
postgresql://user:pass@ep-xxx.region.aws.neon.tech/neondb?sslmode=require
```

---

## 3. Environment variables (backend)

Set these in your backend environment (e.g. `.env` or your host’s env config):

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | For Postgres | Full PostgreSQL connection string. If **not** set, Shield uses JSON file + file session (no Postgres). |
| `PRUNE_MESSAGES_OLDER_THAN_DAYS` | No | Delete messages older than this many days (default: 5). Run on startup. |
| `SESSION_NAME` | No | Baileys session name in DB (default: `shield-session`). |
| `DB_PATH` | No | Only used when **not** using Postgres; JSON file path (default: `shield.json`). |

Example `.env` for production with Postgres:

```env
DATABASE_URL=postgresql://shield_user:your_secure_password@localhost:5432/shield
PRUNE_MESSAGES_OLDER_THAN_DAYS=5
PORT=3002
```

---

## 4. What you need to do

1. **Create the PostgreSQL database** (and user) as in § 2.1.
2. **Set `DATABASE_URL`** in the backend environment to your Postgres connection string.
3. **Install backend dependencies** (includes `pg`):  
   `cd backend && npm install`
4. **Start the backend**:  
   `npm start`  
   On first start with `DATABASE_URL` set, tables will be created automatically.
5. **(Optional)** Adjust `PRUNE_MESSAGES_OLDER_THAN_DAYS` if you want a different retention (default 5 days).

---

## 5. Security notes

- **Credentials** – Store `DATABASE_URL` in env only; never commit it. Use your platform’s secrets (e.g. Vercel, Railway, Render).
- **Sessions** – Auth data is in `auth_creds` and `auth_keys`. Restrict DB access (user/password, network, SSL) as you would for any production DB.
- **Backups** – Back up PostgreSQL regularly; that backs up both app data and WhatsApp session state.

---

## 6. What’s left before production (checklist)

- [ ] **PostgreSQL** – Create DB, set `DATABASE_URL`, run backend once so tables are created.
- [ ] **Frontend** – Ensure `NEXT_PUBLIC_API_URL` (or your API base URL) points to your production backend.
- [ ] **Backend URL** – Deploy backend (e.g. Railway, Render, Fly.io) and set CORS/origins if needed.
- [ ] **Secrets** – All secrets in env (no hardcoding).
- [ ] **HTTPS** – Use HTTPS in production for frontend and API.
- [ ] **(Optional) Multi-user** – Current design is single-tenant (one WhatsApp connection per instance). For multiple users/tenants you’d add a `user_id` (or tenant_id) to leads/settings/auth and scope all queries by it.

---

## 7. Empty keywords and audio

- New installs (and new Postgres DBs) get default settings with:
  - `keyword_replies: '[]'`
  - `saved_audios: '[]'`
- So each deployment starts with an empty slate for keywords and audio. No code change needed beyond what’s already in defaults.

---

## 8. Troubleshooting

- **“Connection refused” / “timeout”** – Check `DATABASE_URL`, DB is running, firewall/security groups allow your backend’s IP, and (if remote) `?sslmode=require` when required.
- **“relation does not exist”** – Tables are created on first run. Ensure the DB user can create tables in the public schema (`GRANT ALL ON SCHEMA public TO shield_user`).
- **QR every time** – If you use Postgres but still get QR on every restart, confirm `DATABASE_URL` is set in the **same** process that runs the backend and that no code path is clearing `auth_creds`/`auth_keys` (e.g. only clear on explicit logout).
- **Pruning** – Pruning runs on startup (default: messages older than 5 days). To change retention, set `PRUNE_MESSAGES_OLDER_THAN_DAYS` and restart.

---

## 9. Deploying the backend on Render

1. **Create a Web Service** – [Render Dashboard](https://dashboard.render.com) → New → Web Service.
2. **Connect your repo** – Link the Shield repo (backend lives in the `backend` folder).
3. **Settings**
   - **Root Directory**: `backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance type**: Free or paid (Free can spin down; paid keeps the process up for WhatsApp).
4. **Environment variables** (Render → Your service → Environment):
   - `DATABASE_URL` – Your PostgreSQL connection string (Render Postgres or external).
   - `PRUNE_MESSAGES_OLDER_THAN_DAYS` – `5` (or leave unset; default is 5).
   - `PORT` – Render sets this automatically; you can leave it unset.
   - `NODE_ENV` – `production` (optional).
5. **PostgreSQL on Render** – You can create a PostgreSQL instance in Render (Dashboard → New → PostgreSQL), then copy the **Internal Database URL** into `DATABASE_URL` so the backend and DB are in the same region.
6. **Frontend** – Point your frontend (e.g. Vercel) at the Render backend URL: set `NEXT_PUBLIC_API_URL` to `https://your-service-name.onrender.com/api` (or your custom domain). Update CORS on the backend if you use a different frontend origin.

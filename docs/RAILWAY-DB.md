# Setting up PostgreSQL on Railway for Shield

1. **Create a Railway project**  
   Go to [railway.app](https://railway.app) and sign in. Create a new project.

2. **Add PostgreSQL**  
   In the project dashboard: **New** → **Database** → **PostgreSQL**. Railway will provision a Postgres instance.

3. **Get the connection URL**  
   Click the PostgreSQL service. Open the **Variables** or **Connect** tab. Copy **`DATABASE_URL`** (or the connection string shown). It looks like:
   ```
   postgresql://postgres:PASSWORD@HOST:PORT/railway
   ```

4. **Add env vars to your Shield backend**  
   - If the backend is also on Railway: add a **Service** for your app, then in that service go to **Variables** and add:
     - `DATABASE_URL` = (paste the PostgreSQL URL)
     - `JWT_SECRET` = (a long random string, e.g. run `openssl rand -base64 32` locally and paste)
   - If the backend runs elsewhere: set `DATABASE_URL` and `JWT_SECRET` in that environment the same way.

5. **Deploy**  
   Deploy your backend. On first run, Shield’s migrations will create the tables (including `users`) in the Railway Postgres database.

6. **Optional: connect from local**  
   For local dev, add a `.env` in `backend/` with:
   ```
   DATABASE_URL=postgresql://...
   JWT_SECRET=your-secret-here
   ```

That’s it. The app uses `DATABASE_URL` for all data and auth; `JWT_SECRET` enables multi-tenant login.

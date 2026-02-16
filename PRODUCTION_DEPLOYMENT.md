# Production Deployment Guide

## Environment Variables Required

### Backend (.env file in `backend/` directory)

Create `backend/.env` with the following variables:

```env
# Server Configuration
PORT=3002

# Database Configuration
DB_PATH=shield.json

# WhatsApp Session Configuration
SESSION_PATH=./sessions
SESSION_NAME=shield-session

# AI Configuration (Optional - can also be set in UI Settings)
# These take priority over database settings
OPENROUTER_API_KEY=sk-or-v1-your-api-key-here
AI_MODEL=anthropic/claude-opus-4.6
AI_ENABLED=true

# Node Environment
NODE_ENV=production
```

**Required Variables:**
- `PORT` - Backend server port (default: 3002)

**Optional Variables (with defaults):**
- `DB_PATH` - Database file path (default: `shield.json`)
- `SESSION_PATH` - WhatsApp session directory (default: `./sessions`)
- `SESSION_NAME` - WhatsApp session name (default: `shield-session`)
- `OPENROUTER_API_KEY` - OpenRouter API key (optional, can be set in UI)
- `AI_MODEL` - AI model to use (optional, can be set in UI)
- `AI_ENABLED` - Enable AI template selection (optional, can be set in UI)

---

### Frontend (.env.local or hosting platform env vars)

For Next.js, create `.env.local` in the root directory:

```env
# Backend API URL
# For production, set this to your backend URL
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
```

**Scenarios:**

1. **Same Domain (Recommended):**
   ```env
   NEXT_PUBLIC_API_URL=/api
   ```
   - Frontend and backend on same domain
   - Next.js rewrites handle the proxying
   - Update `next.config.ts` rewrite destination to your backend URL

2. **Separate Domains:**
   ```env
   NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
   ```
   - Frontend and backend on different domains
   - Ensure CORS is configured in backend (already done)

3. **Local Development:**
   ```env
   # Leave empty or don't set - uses defaults
   NEXT_PUBLIC_API_URL=
   ```

---

## Deployment Checklist

### Backend Deployment

1. **Create `.env` file in `backend/` directory:**
   ```bash
   cd backend
   cp .env.example .env
   # Edit .env with your values
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Build (if needed):**
   ```bash
   # No build step needed - runs directly with Node.js
   ```

4. **Start server:**
   ```bash
   npm start
   # Or use PM2 for production:
   pm2 start server.js --name shield-backend
   ```

5. **Ensure directories exist:**
   - `backend/sessions/` - Will be created automatically
   - `data/` - Will be created automatically (for database)

### Frontend Deployment

1. **Set environment variables in hosting platform:**
   - Vercel: Project Settings → Environment Variables
   - Netlify: Site Settings → Environment Variables
   - Or create `.env.local` for local builds

2. **Update `next.config.ts` for production:**
   ```typescript
   const nextConfig: NextConfig = {
     async rewrites() {
       return [
         {
           source: '/api/:path*',
           destination: process.env.BACKEND_URL || 'http://localhost:3002/api/:path*',
         },
       ];
     },
   };
   ```

3. **Build:**
   ```bash
   npm run build
   ```

4. **Start:**
   ```bash
   npm start
   ```

---

## Production Considerations

### Security

1. **Never commit `.env` files:**
   - Already in `.gitignore`
   - Use hosting platform environment variables

2. **API Keys:**
   - Store OpenRouter API key in environment variables
   - Or set via UI Settings (stored in database)

3. **CORS:**
   - Backend CORS is configured to allow all origins
   - For production, restrict to your frontend domain:
   ```javascript
   app.use(cors({
     origin: process.env.FRONTEND_URL || 'https://yourdomain.com'
   }));
   ```

### File Storage

1. **Database:**
   - Stored in `data/shield.json`
   - Ensure persistent storage on your server
   - Consider backups

2. **WhatsApp Sessions:**
   - Stored in `backend/sessions/shield-session/`
   - **Critical:** Must persist across restarts
   - Backup this directory regularly

### Process Management

**Recommended: Use PM2**

```bash
# Install PM2
npm install -g pm2

# Start backend
cd backend
pm2 start server.js --name shield-backend

# Start frontend (if self-hosted)
cd ..
pm2 start npm --name shield-frontend -- start

# Save PM2 configuration
pm2 save
pm2 startup
```

### Monitoring

1. **Logs:**
   - Backend logs to console
   - Frontend logs available via `/api/logs` endpoint
   - Use PM2 logs: `pm2 logs shield-backend`

2. **Health Check:**
   - Backend: `GET /api/health`
   - Frontend: Standard Next.js health checks

---

## Example Production Setup

### Option 1: Same Server (Recommended for small scale)

```
Server: yourdomain.com
├── Frontend (Next.js) - Port 3000
└── Backend (Express) - Port 3002
```

**Environment Variables:**

Backend `.env`:
```env
PORT=3002
NODE_ENV=production
```

Frontend `.env.local`:
```env
NEXT_PUBLIC_API_URL=/api
```

`next.config.ts`:
```typescript
destination: 'http://localhost:3002/api/:path*'
```

---

### Option 2: Separate Servers

```
Frontend: app.yourdomain.com (Vercel/Netlify)
Backend: api.yourdomain.com (VPS/Cloud)
```

**Environment Variables:**

Backend `.env`:
```env
PORT=3002
NODE_ENV=production
```

Frontend (hosting platform env vars):
```env
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
```

**Backend CORS update:**
```javascript
app.use(cors({
  origin: 'https://app.yourdomain.com'
}));
```

---

## Quick Start Commands

### Backend
```bash
cd backend
npm install
cp .env.example .env
# Edit .env
npm start
```

### Frontend
```bash
npm install
# Set NEXT_PUBLIC_API_URL in hosting platform or .env.local
npm run build
npm start
```

---

## Troubleshooting

### Backend not connecting
- Check `PORT` is correct
- Verify `.env` file exists and is loaded
- Check firewall rules

### Frontend can't reach backend
- Verify `NEXT_PUBLIC_API_URL` is set correctly
- Check CORS configuration
- Verify backend is running

### WhatsApp session lost
- Ensure `sessions/` directory persists
- Check file permissions
- Verify session path in `.env`

---

## Files to Create

1. `backend/.env` - Backend environment variables
2. `.env.local` (or hosting platform env vars) - Frontend environment variables

## Files to NEVER Commit

- `backend/.env`
- `.env.local`
- `backend/sessions/`
- `data/shield.json`
- `node_modules/`

All should already be in `.gitignore`.


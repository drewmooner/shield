# Environment Variables Setup for Production

## Quick Reference

### Backend Environment Variables

**File:** `backend/.env`

```env
# Required
PORT=3002

# Optional (with defaults)
DB_PATH=shield.json
SESSION_PATH=./sessions
SESSION_NAME=shield-session

# AI Configuration (Optional - can be set in UI)
OPENROUTER_API_KEY=sk-or-v1-your-key-here
AI_MODEL=anthropic/claude-opus-4.6
AI_ENABLED=true

# Production
NODE_ENV=production
```

### Frontend Environment Variables

**File:** `.env.local` (or set in hosting platform)

```env
# For same domain (recommended)
NEXT_PUBLIC_API_URL=/api

# OR for separate domains
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
```

---

## Detailed Setup

### 1. Backend `.env` File

Create `backend/.env`:

**Minimum Required:**
```env
PORT=3002
```

**Full Configuration:**
```env
PORT=3002
DB_PATH=shield.json
SESSION_PATH=./sessions
SESSION_NAME=shield-session
OPENROUTER_API_KEY=sk-or-v1-your-api-key
AI_MODEL=anthropic/claude-opus-4.6
AI_ENABLED=true
NODE_ENV=production
```

**Notes:**
- `PORT`: Backend server port (default: 3002)
- `DB_PATH`: Database file location (default: `shield.json` in `data/` folder)
- `SESSION_PATH`: WhatsApp session directory (default: `./sessions`)
- `SESSION_NAME`: WhatsApp session folder name (default: `shield-session`)
- `OPENROUTER_API_KEY`: Optional - can be set in UI Settings instead
- `AI_MODEL`: Optional - can be set in UI Settings instead
- `AI_ENABLED`: Optional - can be set in UI Settings instead

---

### 2. Frontend Environment Variables

**Option A: Same Domain (Recommended)**

If frontend and backend are on the same domain:

```env
# .env.local (or hosting platform env vars)
NEXT_PUBLIC_API_URL=/api
```

Update `next.config.ts`:
```typescript
destination: 'http://localhost:3002/api/:path*'  // For local
// OR
destination: 'http://your-backend-url:3002/api/:path*'  // For production
```

**Option B: Separate Domains**

If frontend and backend are on different domains:

```env
# .env.local (or hosting platform env vars)
NEXT_PUBLIC_API_URL=https://api.yourdomain.com/api
```

Update backend CORS in `backend/server.js`:
```javascript
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://app.yourdomain.com'
}));
```

---

## Production Deployment Steps

### Step 1: Backend Setup

```bash
cd backend
cp .env.example .env  # If you created .env.example
# OR create .env manually
nano .env  # or use your preferred editor
```

Add your values:
```env
PORT=3002
NODE_ENV=production
OPENROUTER_API_KEY=sk-or-v1-your-actual-key
```

### Step 2: Frontend Setup

**For Vercel/Netlify:**
- Go to Project Settings → Environment Variables
- Add: `NEXT_PUBLIC_API_URL` = `/api` or your backend URL

**For Self-Hosted:**
```bash
# Create .env.local
echo "NEXT_PUBLIC_API_URL=/api" > .env.local
```

### Step 3: Update next.config.ts (if needed)

If backend is on a different server:
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

---

## Environment Variables Summary

| Variable | Location | Required | Default | Description |
|----------|----------|----------|---------|-------------|
| `PORT` | `backend/.env` | ✅ | `3002` | Backend server port |
| `DB_PATH` | `backend/.env` | ❌ | `shield.json` | Database file path |
| `SESSION_PATH` | `backend/.env` | ❌ | `./sessions` | WhatsApp session directory |
| `SESSION_NAME` | `backend/.env` | ❌ | `shield-session` | WhatsApp session name |
| `OPENROUTER_API_KEY` | `backend/.env` | ❌ | - | OpenRouter API key (can set in UI) |
| `AI_MODEL` | `backend/.env` | ❌ | - | AI model (can set in UI) |
| `AI_ENABLED` | `backend/.env` | ❌ | - | Enable AI (can set in UI) |
| `NEXT_PUBLIC_API_URL` | `.env.local` | ❌ | `/api` | Frontend API URL |

---

## Security Checklist

- ✅ `.env` files are in `.gitignore` (already configured)
- ✅ Never commit `.env` files
- ✅ Use environment variables in hosting platforms
- ✅ Rotate API keys regularly
- ✅ Use different keys for development/production
- ✅ Restrict CORS in production to your frontend domain

---

## Quick Commands

```bash
# Backend
cd backend
echo "PORT=3002" > .env
echo "NODE_ENV=production" >> .env

# Frontend
echo "NEXT_PUBLIC_API_URL=/api" > .env.local
```

---

## Troubleshooting

**Backend not starting:**
- Check `PORT` is not in use
- Verify `.env` file exists in `backend/` directory
- Check file permissions

**Frontend can't connect:**
- Verify `NEXT_PUBLIC_API_URL` is set correctly
- Check backend is running
- Verify CORS configuration
- Check network/firewall rules

**WhatsApp session issues:**
- Ensure `sessions/` directory persists
- Check `SESSION_PATH` in `.env`
- Verify file permissions


# Vercel + Railway Deployment Guide

## Architecture

- **Frontend:** Vercel (Next.js)
- **Backend:** Railway (Express + Baileys)

---

## Step 1: Deploy Backend to Railway

### 1.1 Create Railway Project

1. Go to [railway.app](https://railway.app)
2. Create new project
3. Connect your GitHub repo or deploy from directory
4. Select `backend/` folder as root

### 1.2 Set Environment Variables in Railway

Go to your Railway project → Variables tab and add:

```env
PORT=3002
NODE_ENV=production
DB_PATH=shield.json
SESSION_PATH=./sessions
SESSION_NAME=shield-session
OPENROUTER_API_KEY=sk-or-v1-your-api-key-here
AI_MODEL=anthropic/claude-opus-4.6
AI_ENABLED=true
```

**Required:**
- `PORT` - Railway will auto-assign, but set to 3002 for consistency

**Optional:**
- All others have defaults or can be set in UI

### 1.3 Update Backend CORS for Vercel

Railway will give you a URL like: `https://your-app-name.up.railway.app`

Update `backend/server.js` to allow your Vercel domain:

```javascript
// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://your-vercel-app.vercel.app',
  credentials: true
}));
```

Or allow all origins (less secure but easier):
```javascript
app.use(cors());
```

### 1.4 Railway Configuration

**Build Command:** (Railway auto-detects, but you can set)
```bash
# No build needed - just install
npm install
```

**Start Command:**
```bash
npm start
```

**Root Directory:** `backend`

### 1.5 Get Railway Backend URL

After deployment, Railway will provide:
- **Public URL:** `https://your-app-name.up.railway.app`
- **Backend API:** `https://your-app-name.up.railway.app/api`

**Important:** Save this URL for Step 2!

---

## Step 2: Deploy Frontend to Vercel

### 2.1 Create Vercel Project

1. Go to [vercel.com](https://vercel.com)
2. Import your GitHub repo
3. Vercel will auto-detect Next.js

### 2.2 Set Environment Variables in Vercel

Go to Project Settings → Environment Variables and add:

```env
NEXT_PUBLIC_API_URL=https://your-app-name.up.railway.app/api
```

**Replace `your-app-name.up.railway.app` with your actual Railway URL!**

### 2.3 Update next.config.ts

Update `next.config.ts` to use environment variable:

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // In production, use Railway backend URL
    const backendUrl = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002';
    
    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
```

**OR** simpler approach - just use the public API URL directly (no rewrites needed):

```typescript
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // No rewrites needed - frontend will call Railway directly
};

export default nextConfig;
```

### 2.4 Vercel Build Settings

Vercel auto-detects Next.js, but verify:
- **Framework Preset:** Next.js
- **Root Directory:** `/` (root of repo)
- **Build Command:** `npm run build`
- **Output Directory:** `.next`

---

## Step 3: Update Backend CORS

Update `backend/server.js` to allow your Vercel domain:

```javascript
// Middleware
const allowedOrigins = [
  'http://localhost:3001',
  'http://localhost:3000',
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, Postman, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
```

**OR** simpler - allow all origins (for development/testing):

```javascript
app.use(cors({
  origin: true, // Allow all origins
  credentials: true
}));
```

---

## Step 4: Railway Environment Variables (Complete List)

Add these in Railway → Variables:

```env
# Server
PORT=3002
NODE_ENV=production

# Frontend URL (for CORS)
FRONTEND_URL=https://your-vercel-app.vercel.app

# Database
DB_PATH=shield.json

# WhatsApp Session
SESSION_PATH=./sessions
SESSION_NAME=shield-session

# AI Configuration
OPENROUTER_API_KEY=sk-or-v1-your-api-key-here
AI_MODEL=anthropic/claude-opus-4.6
AI_ENABLED=true
```

---

## Step 5: Vercel Environment Variables (Complete List)

Add these in Vercel → Project Settings → Environment Variables:

```env
# Backend API URL (Railway)
NEXT_PUBLIC_API_URL=https://your-app-name.up.railway.app/api
```

**Important:** 
- Replace with your actual Railway URL
- Add for all environments (Production, Preview, Development)

---

## Step 6: Persistent Storage on Railway

### WhatsApp Sessions

Railway provides ephemeral storage by default. For persistent WhatsApp sessions:

**Option 1: Use Railway Volumes (Recommended)**
1. Go to Railway project → Volumes
2. Create new volume
3. Mount to `/app/sessions`
4. Update `SESSION_PATH` in env vars if needed

**Option 2: Use External Storage**
- AWS S3
- Google Cloud Storage
- Or any object storage

**Option 3: Accept Ephemeral (Not Recommended)**
- Sessions will be lost on restart
- Need to re-scan QR code after each deployment

### Database

Same as sessions - use Railway Volumes or external storage for `data/` directory.

---

## Step 7: Deployment Checklist

### Railway Backend ✅
- [ ] Project created and connected
- [ ] Environment variables set
- [ ] CORS configured for Vercel domain
- [ ] Persistent storage configured (Volumes)
- [ ] Backend URL saved

### Vercel Frontend ✅
- [ ] Project imported
- [ ] `NEXT_PUBLIC_API_URL` set to Railway URL
- [ ] `next.config.ts` updated (if using rewrites)
- [ ] Deployed successfully

### Testing ✅
- [ ] Frontend loads
- [ ] QR code appears
- [ ] Can connect WhatsApp
- [ ] Messages work
- [ ] Settings save correctly

---

## Troubleshooting

### CORS Errors

**Error:** `Access to fetch at '...' from origin '...' has been blocked by CORS policy`

**Fix:**
1. Check Railway CORS configuration
2. Verify `FRONTEND_URL` in Railway env vars matches your Vercel URL
3. Check browser console for exact error

### Backend Not Reachable

**Error:** `Failed to connect to backend`

**Fix:**
1. Verify Railway backend is running (check Railway logs)
2. Check `NEXT_PUBLIC_API_URL` in Vercel matches Railway URL
3. Test Railway URL directly: `https://your-app.up.railway.app/api/health`
4. Check Railway public domain is enabled

### WhatsApp Session Lost

**Issue:** Need to scan QR code after every restart

**Fix:**
1. Set up Railway Volumes for persistent storage
2. Mount volume to `/app/sessions`
3. Verify `SESSION_PATH` in env vars

### Environment Variables Not Working

**Issue:** Variables not being read

**Fix:**
1. Restart Railway service after adding env vars
2. Check variable names match exactly (case-sensitive)
3. Verify no typos in Vercel env vars
4. Rebuild Vercel after adding env vars

---

## Quick Reference

### Railway Backend URL Format
```
https://your-app-name.up.railway.app
```

### Vercel Frontend URL Format
```
https://your-app-name.vercel.app
```

### API Endpoint
```
https://your-app-name.up.railway.app/api
```

---

## Example Configuration

### Railway Variables:
```env
PORT=3002
NODE_ENV=production
FRONTEND_URL=https://shield-app.vercel.app
OPENROUTER_API_KEY=sk-or-v1-abc123...
```

### Vercel Variables:
```env
NEXT_PUBLIC_API_URL=https://shield-backend.up.railway.app/api
```

---

## Next Steps After Deployment

1. **Test Connection:**
   - Visit your Vercel URL
   - Check if QR code appears
   - Scan and connect

2. **Monitor Logs:**
   - Railway: Project → Deployments → View Logs
   - Vercel: Project → Deployments → View Function Logs

3. **Set Up Monitoring:**
   - Railway: Built-in metrics
   - Vercel: Analytics dashboard

4. **Backup:**
   - Export WhatsApp sessions regularly
   - Backup database file
   - Save environment variables securely

---

## Cost Considerations

### Railway
- Free tier: $5 credit/month
- Hobby plan: $5/month
- Pro plan: $20/month

### Vercel
- Free tier: Good for personal projects
- Pro: $20/month for team features

---

## Security Best Practices

1. **Never commit `.env` files** ✅ (already in .gitignore)
2. **Use Railway secrets** for sensitive data
3. **Use Vercel environment variables** for frontend
4. **Enable Railway authentication** if needed
5. **Use HTTPS** (both Railway and Vercel provide this)
6. **Restrict CORS** to your Vercel domain only

---

## Support

- Railway Docs: https://docs.railway.app
- Vercel Docs: https://vercel.com/docs
- Railway Discord: https://discord.gg/railway
- Vercel Discord: https://vercel.com/discord


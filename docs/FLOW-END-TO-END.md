# Shield – Flow from start to end

## 1. **Start (first time)**
- User opens app → **Register** (email + password).
- Backend: `POST /api/auth/register` → user stored (Postgres), JWT returned.
- Frontend stores token + user, redirects to **/** (dashboard).

## 2. **Returning user**
- User opens app → **Log in** (email + password).
- Backend: `POST /api/auth/login` → JWT returned.
- Frontend stores token + user, redirects to **/**.

## 3. **Dashboard**
- Home shows **StatusBar** (connection status) and **Leads** (if any).
- If not connected: **QRAuth** loads → `getBotStatus()` (with token) → shows QR or “Reconnect”.
- User scans QR → WhatsApp connects → socket `status_update` → UI shows “Connected”.
- **Reconnect** / **Get New QR** in QRAuth → `reconnectBot()` (with token) → new QR.

## 4. **Leads**
- **Leads** list from `GET /api/leads` (with token).
- Click lead → **Lead detail** page → messages, send reply, complete/delete lead.
- Connection timestamp from `getBotStatus()` (with token).

## 5. **Settings**
- **Settings** page: keyword replies, audios (record/upload/delete), delays, auto-reply toggle.
- All via `getSettings()` / `updateSettings()` / `uploadAudio()` / `deleteAudio()` (with token).
- Audio playback uses `getAudioBlobUrl()` (auth fetch + blob URL) so it works with JWT.
- **Save Settings** / **Save changes** (keywords) / toggle → `POST /api/settings` (with token).

## 6. **End – Logout**
- **Nav** or **Settings → Account**: click **Log out** → confirm.
- Frontend: `logout()` → clear token + user, redirect to **/login**.
- No backend call; next request without token gets 401 and redirect to login.

## 7. **End – Disconnect (WhatsApp only)**
- **StatusBar**: click **Disconnect**.
- Frontend: `disconnectBot()` → `POST /api/bot/disconnect` (with token).
- Backend: `getOrCreateHandler(req.userId)` → `whatsapp.disconnect()`.
- Session stays (user still logged in); QR can be shown again to reconnect.

## Auth everywhere
- All API calls (except login/register) use `fetchWithAuth` (Bearer token).
- Socket handshake sends `auth: { token }` when token exists.
- Backend middleware sets `req.userId` from JWT; all DB and handler access use `req.userId`.

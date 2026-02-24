# Message Flow: WhatsApp → Backend → Frontend

## Complete Flow Diagram

```
┌─────────────────┐
│  WhatsApp App   │
│  (User Phone)   │
└────────┬────────┘
         │
         │ 1. User sends message
         ▼
┌─────────────────────────────────────────────────────────┐
│              Baileys WhatsApp Socket                    │
│  ┌──────────────────────────────────────────────────┐  │
│  │ messages.upsert event fires                      │  │
│  │ Type: 'notify' (real-time) or 'append' (synced) │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬────────────────────────────────────────────────┘
         │
         │ 2. Event received by backend listener
         ▼
┌─────────────────────────────────────────────────────────┐
│         backend/whatsapp.js                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │ handleIncomingMessage()                          │  │
│  │  - Filters: status broadcasts, groups, old msgs │  │
│  │  - Extracts: phone, message text, timestamp      │  │
│  │  - Creates/updates lead in database              │  │
│  │  - Stores message in database                     │  │
│  │  - Fetches contact info (name, profile pic)      │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬────────────────────────────────────────────────┘
         │
         │ 3. Message stored, emit WebSocket event
         ▼
┌─────────────────────────────────────────────────────────┐
│         backend/whatsapp.js                             │
│  ┌──────────────────────────────────────────────────┐  │
│  │ this.io.emit('new_message', {                    │  │
│  │   leadId: lead.id,                               │  │
│  │   message: {                                      │  │
│  │     id: savedMessage.id,                         │  │
│  │     sender: 'user' | 'shield',                    │  │
│  │     content: messageText,                         │  │
│  │     timestamp: msgTimestamp                       │  │
│  │   },                                              │  │
│  │   lead: updatedLead                               │  │
│  │ })                                                 │  │
│  │ this.io.emit('leads_changed')                     │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬────────────────────────────────────────────────┘
         │
         │ 4. WebSocket event broadcast via Socket.IO
         ▼
┌─────────────────────────────────────────────────────────┐
│         Socket.IO Server (backend/server.js)           │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Broadcasts to ALL connected frontend clients     │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬────────────────────────────────────────────────┘
         │
         │ 5. Event received by frontend Socket.IO client
         ▼
┌─────────────────────────────────────────────────────────┐
│         app/lib/useSocket.ts                            │
│  ┌──────────────────────────────────────────────────┐  │
│  │ Singleton Socket.IO client (polling transport)  │  │
│  │ Connected via SocketProvider                     │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬────────────────────────────────────────────────┘
         │
         │ 6. Event forwarded to component listeners
         ▼
┌─────────────────────────────────────────────────────────┐
│         app/lead/[id]/page.tsx                          │
│  ┌──────────────────────────────────────────────────┐  │
│  │ handleNewMessage(data)                           │  │
│  │  - Filters by connectionTimestampRef            │  │
│  │  - Filters by leadId match                       │  │
│  │  - Checks for duplicates                         │  │
│  │  - Updates UI state (setLead)                   │  │
│  │  - Triggers auto-scroll                          │  │
│  └──────────────────────────────────────────────────┘  │
└────────┬────────────────────────────────────────────────┘
         │
         │ 7. React re-renders with new message
         ▼
┌─────────────────┐
│   UI Updated     │
│  Message Visible │
└─────────────────┘
```

## Step-by-Step Flow

### Step 1: WhatsApp Message Received
- **Location**: `backend/whatsapp.js` line 287
- **Event**: `messages.upsert` fires from Baileys
- **What happens**: 
  - Listener logs: `🔔🔔🔔 messages.upsert EVENT FIRED 🔔🔔🔔`
  - Increments `messageReceivedCount`
  - Processes all messages in the array

### Step 2: Message Processing
- **Location**: `backend/whatsapp.js` line 650 (`handleIncomingMessage`)
- **Filters applied**:
  - ✅ Connection time check (`connectionTime` must be set)
  - ✅ Status broadcasts skipped (`status@broadcast`)
  - ✅ Group messages skipped (`@g.us`)
  - ✅ Old messages filtered (5-minute window for `append` type)
  - ✅ Protocol messages skipped
  - ✅ Duplicate detection (content + sender + timestamp within 30s)

### Step 3: Database Storage
- **Location**: `backend/whatsapp.js` line 966 (`database.createMessage`)
- **What happens**:
  - Creates/updates lead in database
  - Stores message with: `id`, `lead_id`, `sender`, `content`, `status`, `timestamp`
  - Fetches contact info (name, profile picture)
  - Updates lead's `updated_at` timestamp

### Step 4: WebSocket Event Emission
- **Location**: `backend/whatsapp.js` line 1050 (`this.io.emit`)
- **Events emitted**:
  1. `new_message` - Contains full message data and lead info
  2. `leads_changed` - Signals dashboard to refresh
- **Verification**: Logs show `📤 Emitting to X connected clients`

### Step 5: Frontend Receives Event
- **Location**: `app/lead/[id]/page.tsx` line 183 (`handleNewMessage`)
- **What happens**:
  - Socket.IO client receives `new_message` event
  - Handler function executes
  - Logs: `📨 new_message event received`

### Step 6: Frontend Filtering
- **Location**: `app/lead/[id]/page.tsx` line 188
- **Filters applied**:
  - ✅ Connection timestamp check (with 5-second buffer)
  - ✅ LeadId match check
  - ✅ Duplicate check (by message ID)

### Step 7: UI Update
- **Location**: `app/lead/[id]/page.tsx` line 217 (`setLead`)
- **What happens**:
  - Adds message to `lead.messages` array
  - React re-renders component
  - Message appears in chat UI
  - Auto-scrolls to bottom if user is near bottom

## Key Timestamps

1. **Backend `connectionTime`**: Set when WhatsApp connects (`connection === 'open'`)
   - Stored as: `Date.now()` (milliseconds number)
   - Used to filter historical messages

2. **Frontend `connectionTimestampRef`**: Set when backend sends `status_update` with `connectionTime`
   - Stored as: milliseconds number (from backend)
   - Used to filter messages in UI

3. **Message `timestamp`**: From WhatsApp message (`messageTimestamp * 1000`)
   - Stored as: ISO string in database
   - Compared as: milliseconds number in frontend

## Critical Points

✅ **Backend must have `this.io` set** - Without it, events won't reach frontend
✅ **Connection timestamp sync** - Frontend uses backend's timestamp (not WebSocket time)
✅ **Buffer window** - 5-second buffer prevents filtering out valid messages
✅ **Duplicate detection** - Prevents same message from appearing twice
✅ **LeadId matching** - Ensures messages only appear in correct chat

## Testing Checklist

- [ ] Backend is running (`npm start` in backend/)
- [ ] WhatsApp is connected (check `/api/bot/status`)
- [ ] WebSocket listeners attached (check `/api/debug/listeners`)
- [ ] Frontend is running (`npm run dev`)
- [ ] Frontend WebSocket connected (check browser console)
- [ ] Send test message from phone
- [ ] Check backend console for `🔔🔔🔔 messages.upsert EVENT FIRED`
- [ ] Check backend console for `📡 Emitting WebSocket event: new_message`
- [ ] Check frontend console for `📨 new_message event received`
- [ ] Verify message appears in UI

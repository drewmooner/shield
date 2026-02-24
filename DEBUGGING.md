# Debugging: Message Not Displaying in UI

## Quick Checklist

### 1. Check Backend Console
When you send a message, you should see:
```
🔔 messages.upsert EVENT FIRED: 1 messages (type: notify)
   Connection status: ✅ Connected
   Connection time: [timestamp]
📨 messages.upsert event received: 1 messages (type: notify)
   From: [phone number]
   FromMe: false
✅ Message stored successfully!
📡 Emitting WebSocket event: new_message
   - LeadId: [lead-id]
📤 Emitting to X connected clients
✅ WebSocket events emitted via io.emit()
```

### 2. Check Frontend Console
You should see:
```
📨 new_message event received: [data]
✅ Message matches current lead: [lead-id]
✅ Adding new message to UI
```

### 3. Common Issues

**Issue: Backend not receiving messages**
- Check: `Connection status: ✅ Connected` in backend logs
- Check: `Connection time: [timestamp]` is set
- Fix: Restart backend if not connected

**Issue: Backend receiving but not emitting**
- Check: `this.io is null` error in backend
- Fix: Verify `whatsapp.setIO(io)` is called in server.js

**Issue: Frontend not receiving events**
- Check: WebSocket connected (green dot in UI)
- Check: Browser console for connection errors
- Fix: Refresh page, check WebSocket connection

**Issue: LeadId mismatch**
- Check: Backend logs show `LeadId: [id]`
- Check: Frontend URL shows `/lead/[id]`
- Fix: Make sure you're on the correct lead page

**Issue: Message filtered out**
- Check: `⏭️ Skipping old message` in frontend console
- Fix: Message timestamp is before connection time

## Test Steps

1. **Send a test message** from your phone
2. **Check backend console** - should see message processing
3. **Check frontend console** - should see WebSocket event
4. **Check UI** - message should appear

## If Still Not Working

1. Open browser DevTools → Network tab
2. Filter by "WS" (WebSocket)
3. Check if WebSocket connection is active
4. Send a message and watch for events
5. Check the WebSocket frames for `new_message` events

# Baileys Implementation Code Sections

## 1. Package.json - Dependencies

```json
{
  "name": "shield-backend",
  "version": "1.0.0",
  "description": "Shield WhatsApp Triage Assistant Backend",
  "main": "server.js",
  "type": "module",
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  },
  "dependencies": {
    "@whiskeysockets/baileys": "^6.7.8",
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "lowdb": "^7.0.1",
    "pino": "^8.16.2",
    "p-queue": "^7.4.1",
    "qrcode-terminal": "^0.12.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/express": "^4.17.21",
    "@types/node": "^20.10.6"
  }
}
```

**Key Dependency:**
- **Baileys Version:** `^6.7.8` (latest stable)

---

## 2. Imports

```javascript
import makeWASocket, { 
  DisconnectReason, 
  useMultiFileAuthState, 
  fetchLatestBaileysVersion 
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';
```

---

## 3. Auth State Setup (useMultiFileAuthState)

```javascript
// Setup session paths
this.sessionPath = process.env.SESSION_PATH || './sessions';
this.sessionName = process.env.SESSION_NAME || 'shield-session';
this.fullSessionPath = join(__dirname, this.sessionPath, this.sessionName);

// Ensure session directory exists
const sessionDir = join(__dirname, this.sessionPath);
if (!existsSync(sessionDir)) {
  mkdirSync(sessionDir, { recursive: true });
  console.log('✅ Created session directory');
}

// Load auth state using useMultiFileAuthState
console.log('📥 Loading auth state...');
const { state, saveCreds } = await useMultiFileAuthState(this.fullSessionPath);
const hasCreds = !!state.creds && !!state.creds.me;
console.log('✅ Auth state loaded');
console.log('🔐 Has valid credentials:', hasCreds);

if (hasCreds) {
  console.log('📱 Credentials found - attempting to connect without QR...');
} else {
  console.log('📱 No credentials found - will generate QR code...');
}
```

**Key Points:**
- Uses `useMultiFileAuthState` for multi-file session storage
- Session path: `./sessions/shield-session`
- Automatically creates session directory if it doesn't exist
- Checks for existing credentials to determine if QR is needed

---

## 4. Dynamic WhatsApp Version Fetching

```javascript
// Fetch latest Baileys version dynamically
console.log('🌐 Fetching latest Baileys version dynamically...');
let version;
try {
  const versionData = await fetchLatestBaileysVersion();
  version = versionData.version;
  console.log('✅ Latest Baileys version fetched:', JSON.stringify(version));
  console.log('   Using dynamic version for WhatsApp connection');
} catch (versionError) {
  console.error('⚠️ Failed to fetch latest version:', versionError.message);
  console.log('   Falling back to default version (Baileys will auto-detect)');
  version = null; // Baileys will use default/auto-detect
}
```

**Key Points:**
- Uses `fetchLatestBaileysVersion()` to get the latest WhatsApp version
- Falls back to `null` if fetch fails (Baileys auto-detects)
- Version is an array like `[2, 3000, 1023223821]`

---

## 5. Baileys Socket Initialization (makeWASocket)

```javascript
// Create socket with proper configuration
console.log('🔌 Creating WhatsApp socket...');
const socketConfig = {
  version,  // Dynamic version from fetchLatestBaileysVersion()
  logger: pino({ level: 'silent' }),
  auth: state,  // From useMultiFileAuthState
  browser: ['Shield', 'Chrome', '1.0.0'],
  getMessage: async (key) => {
    return {
      conversation: 'Message not available'
    };
  },
  // Connection timeouts
  connectTimeoutMs: 60000,
  defaultQueryTimeoutMs: 60000,
  // Keep alive
  keepAliveIntervalMs: 10000,
  // Retry configuration
  retryRequestDelayMs: 250,
  maxMsgRetryCount: 3,
};

// Clean up old socket if exists
if (this.sock) {
  try {
    this.sock.end(undefined);
  } catch (e) {
    // Ignore cleanup errors
  }
  this.sock = null;
}

// Create new socket
this.sock = makeWASocket(socketConfig);
console.log('✅ Socket created');
```

**Key Configuration:**
- **version:** Dynamic (fetched from WhatsApp)
- **auth:** State from `useMultiFileAuthState`
- **logger:** Silent (using pino)
- **browser:** Custom browser identifier
- **Timeouts:** 60 seconds for connection and queries
- **Keep alive:** 10 seconds interval

---

## 6. Event Listeners Setup

```javascript
// Set up event listeners BEFORE any connection updates can occur
console.log('📡 Setting up event listeners...');

// Handle credentials updates
this.sock.ev.on('creds.update', saveCreds);
console.log('  ✅ creds.update listener attached');

// Handle connection updates (MUST be set up immediately)
this.sock.ev.on('connection.update', async (update) => {
  await this.handleConnectionUpdate(update);
});
console.log('  ✅ connection.update listener attached');

// Handle incoming messages
this.sock.ev.on('messages.upsert', async (m) => {
  await this.handleIncomingMessage(m);
});
console.log('  ✅ messages.upsert listener attached');

console.log('✅ All event listeners attached\n');
```

**Key Points:**
- Event listeners are set up **immediately** after socket creation
- `creds.update` saves credentials automatically
- `connection.update` handles QR codes and connection state
- `messages.upsert` handles incoming messages

---

## 7. QR Code Handling (connection.update event)

```javascript
async handleConnectionUpdate(update) {
  const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

  // Log all update details
  console.log('\n📡 connection.update received:');
  console.log('   Connection state:', connection || 'undefined');
  console.log('   Has QR:', !!qr);
  console.log('   QR length:', qr ? qr.length : 0);
  console.log('   Is new login:', isNewLogin);
  console.log('   Has lastDisconnect:', !!lastDisconnect);

  // Handle QR code generation - print immediately when received
  if (qr) {
    console.log('\n');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📱 ✅ QR CODE RECEIVED FROM WHATSAPP!');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('📱 Scan this QR code with WhatsApp to connect:');
    console.log('   Open WhatsApp → Settings → Linked Devices → Link a Device');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    
    // Print QR code in terminal using qrcode-terminal
    qrcode.generate(qr, { small: true });
    
    console.log('');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('✅ QR code displayed above - scan with your phone');
    console.log('✅ QR code also available in frontend at http://localhost:3001');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('');
    
    // Update status with QR code for frontend
    await this.updateStatus('qr_ready', { qr });
    console.log('✅ QR code stored and sent to frontend via API');
    
    return; // Don't process connection state when QR is present
  }

  // Handle connection state changes (open, close, connecting, etc.)
  // ... rest of connection handling code
}
```

**Key Points:**
- QR code is received in the `connection.update` event
- Printed immediately using `qrcode-terminal`
- Stored in status for frontend API access
- Returns early to avoid processing connection state when QR is present

---

## 8. Error Handling for 405 (Method Not Allowed)

```javascript
// Handle 405 - Method Not Allowed (usually means connection rejected)
if (statusCode === 405) {
  console.log('   ⚠️ Status 405: Method Not Allowed - Connection rejected by WhatsApp');
  console.log('   💡 This usually means:');
  console.log('      - WhatsApp version mismatch');
  console.log('      - Connection method not supported');
  console.log('      - Need to use latest Baileys version');
  console.log('   🔄 Cleaning session and will retry with fresh connection...');
  
  // Clean up session for fresh start
  if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
    try {
      rmSync(this.fullSessionPath, { recursive: true, force: true });
      console.log('   ✅ Session cleaned for fresh connection');
    } catch (cleanError) {
      console.error('   ⚠️ Failed to clean session:', cleanError.message);
    }
  }
  
  // Reset and retry with fresh connection
  this.isConnecting = false;
  this.reconnectAttempts = 0;
  
  // Wait a bit before retrying
  setTimeout(async () => {
    console.log('   🔄 Retrying with fresh session and latest version...');
    await this.initialize();
  }, 3000);
  
  await this.updateStatus('reconnecting', { 
    reason: 'method_not_allowed',
    statusCode: 405,
    message: 'Connection rejected, retrying with fresh session'
  });
  return;
}
```

---

## 9. Complete Initialization Flow

```javascript
async initialize() {
  // 1. Prevent multiple simultaneous initializations
  if (this.isConnecting) {
    console.log('⚠️ Initialization already in progress, skipping...');
    return;
  }
  this.isConnecting = true;

  // 2. Setup session paths
  this.sessionPath = process.env.SESSION_PATH || './sessions';
  this.sessionName = process.env.SESSION_NAME || 'shield-session';
  this.fullSessionPath = join(__dirname, this.sessionPath, this.sessionName);

  // 3. Ensure session directory exists
  const sessionDir = join(__dirname, this.sessionPath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }

  // 4. Clean up corrupted session if needed
  await this.cleanupSession();

  // 5. Load auth state using useMultiFileAuthState
  const { state, saveCreds } = await useMultiFileAuthState(this.fullSessionPath);

  // 6. Fetch latest Baileys version dynamically
  const versionData = await fetchLatestBaileysVersion();
  const version = versionData.version;

  // 7. Create socket with makeWASocket
  this.sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    auth: state,
    browser: ['Shield', 'Chrome', '1.0.0'],
    // ... other config
  });

  // 8. Set up event listeners immediately
  this.sock.ev.on('creds.update', saveCreds);
  this.sock.ev.on('connection.update', async (update) => {
    await this.handleConnectionUpdate(update);
  });
  this.sock.ev.on('messages.upsert', async (m) => {
    await this.handleIncomingMessage(m);
  });
}
```

---

## 10. Common Error Patterns

### Error: 405 (Method Not Allowed)
- **Cause:** Version mismatch or connection method not supported
- **Solution:** Clean session, retry with latest version

### Error: Connection stuck in "connecting"
- **Cause:** QR code not being generated or event listener not set up
- **Solution:** Ensure event listeners are set up before socket creation

### Error: QR code not appearing
- **Cause:** Session folder has corrupted credentials
- **Solution:** Delete session folder completely and restart

---

## File Structure

```
backend/
├── whatsapp.js      # Main Baileys implementation
├── server.js        # Express server with API routes
├── database.js      # Database operations
├── package.json     # Dependencies
└── sessions/        # Session storage (created automatically)
    └── shield-session/
        ├── creds.json
        ├── app-state-sync-key-*.json
        └── app-state-sync-version-*.json
```

---

## Environment Variables

```env
PORT=3002
DB_PATH=shield.json
SESSION_PATH=./sessions
SESSION_NAME=shield-session
```

---

## Notes

1. **Session Management:** Uses `useMultiFileAuthState` for multi-file session storage
2. **Version:** Dynamically fetched using `fetchLatestBaileysVersion()`
3. **QR Code:** Handled in `connection.update` event, printed with `qrcode-terminal`
4. **Error Handling:** Specific handling for 405 errors with automatic retry
5. **Event Listeners:** Set up immediately after socket creation to catch all events


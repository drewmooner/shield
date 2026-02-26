import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Database from './database.js';
import WhatsAppHandler from './whatsapp.js';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, createReadStream, unlinkSync } from 'fs';

// Load .env file (if it exists) - Railway environment variables take precedence
dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET;
const BCRYPT_ROUNDS = 12;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const dataDir = join(__dirname, 'data');
const audioDir = join(dataDir, 'audio');
if (!existsSync(audioDir)) mkdirSync(audioDir, { recursive: true });

const audioStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, audioDir),
  filename: (req, file, cb) => {
    const id = req.audioId || randomUUID();
    req.audioId = id;
    const ext = file.originalname.split('.').pop()?.toLowerCase() || 'ogg';
    cb(null, `${id}.${ext}`);
  }
});
const uploadAudio = multer({ storage: audioStorage, limits: { fileSize: 16 * 1024 * 1024 } });

const app = express();
const httpServer = createServer(app);
const PORT = process.env.PORT || 3002;

// Simple health check that works immediately (before DB init)
// This ensures Railway health checks don't fail during startup
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Start server immediately so Railway sees the port is open
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Shield Backend listening on ${PORT} (0.0.0.0)`);
  console.log(`✅ Health check available at http://0.0.0.0:${PORT}/health`);
});

// Build allowed origins once (Express + Socket.IO use the same list)
const CORS_ORIGINS = [
  'http://localhost:3001',
  'http://localhost:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3000',
  process.env.FRONTEND_URL,
  process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null,
  ...(process.env.CORS_ALLOWED_ORIGINS ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) : []),
  'https://shield-gold.vercel.app',
].filter(Boolean);

function isOriginAllowed(origin, allowedOrigins) {
  if (!origin) {
    return true;
  }
  
  // In development, allow all origins
  if (process.env.NODE_ENV !== 'production') {
    return true;
  }
  
  // Allow all Vercel preview and production URLs (*.vercel.app)
  // Check both with and without protocol
  if (origin.includes('.vercel.app')) {
    console.log(`✅ CORS allowed Vercel origin: ${origin}`);
    return true;
  }
  
  // Allow exact matches
  if (allowedOrigins.includes(origin)) {
    console.log(`✅ CORS allowed exact match: ${origin}`);
    return true;
  }
  
  // Allow wildcard
  if (allowedOrigins.includes('*')) {
    console.log(`✅ CORS allowed wildcard: ${origin}`);
    return true;
  }
  
  // Check if origin matches any allowed origin (subdomain or path matching)
  const originDomain = origin.replace(/^https?:\/\//, '').split('/')[0];
  const normalized = allowedOrigins.map(a => a.replace(/^https?:\/\//, '').split('/')[0]);
  
  // Check exact domain match
  if (normalized.includes(originDomain)) {
    console.log(`✅ CORS allowed domain match: ${origin}`);
    return true;
  }
  
  // Check if origin is a subdomain of any allowed origin
  for (const allowed of normalized) {
    if (originDomain.endsWith(`.${allowed}`) || allowed.endsWith(`.${originDomain}`)) {
      console.log(`✅ CORS allowed subdomain match: ${origin} (${allowed})`);
      return true;
    }
  }
  
  console.log(`❌ CORS blocked origin: ${origin}`);
  console.log(`   Allowed origins:`, allowedOrigins);
  console.log(`   NODE_ENV:`, process.env.NODE_ENV);
  return false;
}

// Initialize Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: function(origin, callback) {
      // Socket.IO may pass undefined origin for same-origin requests
      if (!origin) {
        console.log('✅ CORS allowed (no origin - same origin request)');
        return callback(null, true);
      }
      
      if (isOriginAllowed(origin, CORS_ORIGINS)) {
        return callback(null, true);
      }
      console.log('⚠️ CORS blocked WebSocket origin:', origin);
      console.log('   Allowed origins:', CORS_ORIGINS);
      callback(new Error('CORS not allowed'), false);
    },
    credentials: true,
    methods: ['GET', 'POST']
  },
  path: '/socket.io/'
});

// Middleware – CORS uses same allowlist as Socket.IO
app.use(cors({
  origin: function (origin, callback) {
    if (isOriginAllowed(origin, CORS_ORIGINS)) {
      return callback(null, true);
    }
    console.log('CORS blocked origin:', origin);
    callback(new Error('CORS not allowed'), false);
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Initialize database (PostgreSQL when DATABASE_URL set, else JSON file)
let db;
try {
  // Debug: Check if DATABASE_URL is set (without logging the actual URL for security)
  const rawDatabaseUrl = process.env.DATABASE_URL;
  const hasDatabaseUrl = !!(rawDatabaseUrl && rawDatabaseUrl.trim());
  const databaseUrlLength = rawDatabaseUrl ? rawDatabaseUrl.length : 0;
  const isWhitespaceOnly = rawDatabaseUrl && !rawDatabaseUrl.trim();
  const existsInEnv = 'DATABASE_URL' in process.env;
  
  console.log('🔍 Database configuration check:');
  console.log(`   DATABASE_URL key exists: ${existsInEnv}`);
  console.log(`   DATABASE_URL value type: ${typeof rawDatabaseUrl}`);
  console.log(`   DATABASE_URL is non-empty: ${hasDatabaseUrl}`);
  if (rawDatabaseUrl !== undefined) {
    console.log(`   DATABASE_URL length: ${databaseUrlLength} characters`);
    if (isWhitespaceOnly) {
      console.log('   ⚠️ DATABASE_URL is set but contains only whitespace!');
      console.log('   💡 Please set a valid PostgreSQL connection string in Railway variables');
    } else if (rawDatabaseUrl === '') {
      console.log('   ⚠️ DATABASE_URL is set but is an empty string!');
      console.log('   💡 Please set a valid PostgreSQL connection string in Railway variables');
    } else {
      // Show first few chars and last few chars for debugging (not the full URL)
      const url = rawDatabaseUrl.trim();
      const preview = url.length > 20 ? `${url.substring(0, 10)}...${url.substring(url.length - 10)}` : '***';
      console.log(`   DATABASE_URL preview: ${preview}`);
    }
  } else {
    console.log('   ⚠️ DATABASE_URL not found in environment variables');
  }
  const dbRelatedVars = Object.keys(process.env).filter(k => k.includes('DATABASE') || k.includes('DB'));
  console.log('   Available env vars:', dbRelatedVars.join(', ') || 'none');
  if (dbRelatedVars.length > 0 && !hasDatabaseUrl) {
    console.log('   💡 DATABASE_URL exists but appears to be empty or invalid');
    console.log('   💡 In Railway: Go to Variables → Check DATABASE_URL has a value');
    console.log('   💡 Value should be: postgresql://user:password@host:port/database');
  }
  
  if (hasDatabaseUrl) {
    console.log('🔄 Initializing database with PostgreSQL...');
    db = new Database({ databaseUrl: process.env.DATABASE_URL.trim() });
  } else {
    console.log('🔄 Initializing database with JSON file...');
    console.log('   💡 To use PostgreSQL, set DATABASE_URL environment variable');
    db = new Database(process.env.DB_PATH || 'shield.json');
  }
  
  // Update health check endpoints now that db is initialized (if it exists)
  if (db) {
    // Override simple health checks with enhanced ones that check database
    app.get('/api/health', async (req, res) => {
      const health = { status: 'ok', timestamp: new Date().toISOString() };
      
      // Check database connectivity if using PostgreSQL
      if (db.driver) {
        try {
          await db.driver._waitInit();
          const pool = db.getPool();
          if (pool) {
            const client = await pool.connect();
            try {
              await client.query('SELECT 1');
              health.database = 'connected';
            } finally {
              client.release();
            }
          }
        } catch (error) {
          health.status = 'degraded';
          health.database = 'error';
          health.databaseError = error.message;
        }
      } else {
        health.database = 'json_file';
      }
      
      res.json(health);
    });
    
    app.get('/health', async (req, res) => {
      const health = { status: 'ok', timestamp: new Date().toISOString() };
      
      // Check database connectivity if using PostgreSQL
      if (db.driver) {
        try {
          await db.driver._waitInit();
          const pool = db.getPool();
          if (pool) {
            const client = await pool.connect();
            try {
              await client.query('SELECT 1');
              health.database = 'connected';
            } finally {
              client.release();
            }
          }
        } catch (error) {
          health.status = 'degraded';
          health.database = 'error';
          health.databaseError = error.message;
        }
      } else {
        health.database = 'json_file';
      }
      
      res.json(health);
    });
    
    console.log('✅ Database initialized, enhanced health checks enabled');
  }
} catch (error) {
  console.error('❌ Failed to initialize database:', error.message);
  console.error('   Stack:', error.stack);
  // Don't exit - let the server continue with basic health checks
  // This prevents Railway from killing the container
  console.error('   ⚠️ Server will continue with limited functionality (JSON file mode)');
  // Initialize with JSON file as fallback
  try {
    db = new Database(process.env.DB_PATH || 'shield.json');
    console.log('   ✅ Fallback to JSON database successful');
  } catch (fallbackError) {
    console.error('   ❌ Fallback database initialization also failed:', fallbackError.message);
    // Still don't exit - health checks will work without database
  }
}

// ----- Auth: JWT optional; when JWT_SECRET set, multi-tenant per user -----
function authMiddleware(req, res, next) {
  if (!JWT_SECRET) {
    req.userId = 'default';
    return next();
  }
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized', code: 'NO_TOKEN' });
  }
  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.userId = decoded.sub;
    req.user = decoded;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured (JWT_SECRET)' });
  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const trimmedEmail = email.trim().toLowerCase();
  if (!trimmedEmail || password.length < 8) {
    return res.status(400).json({ error: 'Email required and password must be at least 8 characters' });
  }
  try {
    const existing = await db.getUserByEmail(trimmedEmail);
    if (existing) return res.status(409).json({ error: 'This email is already registered. Use the login page instead.' });
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const id = randomUUID();
    await db.createUser(id, trimmedEmail, passwordHash);
    const token = jwt.sign({ sub: id, email: trimmedEmail }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id, email: trimmedEmail } });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured (JWT_SECRET)' });
  const { email, password } = req.body || {};
  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const trimmedEmail = email.trim().toLowerCase();
  try {
    const user = await db.getUserByEmail(trimmedEmail);
    if (!user) return res.status(401).json({ error: 'Invalid email or password' });
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return res.status(401).json({ error: 'Invalid email or password' });
    const token = jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: 'Login failed' });
  }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  if (!JWT_SECRET || req.userId === 'default') return res.status(401).json({ error: 'Not authenticated' });
  try {
    const user = await db.getUserById(req.userId);
    if (!user) return res.status(401).json({ error: 'User not found' });
    return res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to get user' });
  }
});

// Per-user WhatsApp handlers (userId -> { whatsapp, state })
const userHandlers = new Map();
function getOrCreateHandler(userId) {
  const uid = userId || 'default';
  if (userHandlers.has(uid)) return userHandlers.get(uid);
  const state = { connectionStatus: { status: 'initializing', timestamp: new Date().toISOString() } };
  const sessionName = uid === 'default' ? 'shield-session' : `user-${uid}`;
  const whatsapp = new WhatsAppHandler(db, { sessionName, clientId: uid });
  whatsapp.setIO(io);
  whatsapp.setStatusCallback((status) => {
    const existingQr = state.connectionStatus.qr;
    const newQr = status.qr;
    state.connectionStatus = {
      ...status,
      timestamp: new Date().toISOString(),
      connectionTime: whatsapp.connectionTime || status.connectionTime || null,
      qr: newQr || existingQr
    };
    if (JWT_SECRET) io.to(`user:${uid}`).emit('status_update', state.connectionStatus);
    else io.emit('status_update', state.connectionStatus);
  });
  whatsapp.setEventEmitter((eventName, data) => {
    try {
      if (JWT_SECRET) io.to(`user:${uid}`).emit(eventName, data);
      else io.emit(eventName, data);
    } catch (error) {
      console.error(`❌ Error emitting ${eventName}:`, error);
    }
  });
  whatsapp.initialize().catch((error) => {
    console.error(`❌ Failed to initialize WhatsApp for user ${uid}:`, error);
    state.connectionStatus = { status: 'error', error: error.message, timestamp: new Date().toISOString() };
  });
  userHandlers.set(uid, { whatsapp, state });
  return userHandlers.get(uid);
}

function emitToUser(userId, eventName, data) {
  if (JWT_SECRET) io.to(`user:${userId}`).emit(eventName, data);
  else io.emit(eventName, data);
}

// Prune old messages from PostgreSQL on startup (all tenants; logs deleted row count)
const pruneDays = parseInt(process.env.PRUNE_MESSAGES_OLDER_THAN_DAYS || '5', 10);
if (Number.isFinite(pruneDays) && pruneDays > 0) {
  db.pruneOldMessagesGlobally(pruneDays).catch((err) => console.warn('Prune on startup:', err.message));
}

// Socket.IO: auth by token when JWT_SECRET set; send that user's status
io.on('connection', (socket) => {
  let userId = 'default';
  if (JWT_SECRET) {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        userId = decoded.sub;
        socket.join(`user:${userId}`);
      } catch (e) {
        socket.emit('status_update', { status: 'error', error: 'Invalid token', timestamp: new Date().toISOString() });
        return;
      }
    } else {
      socket.emit('status_update', { status: 'error', error: 'No token', timestamp: new Date().toISOString() });
      return;
    }
  }
  const handler = getOrCreateHandler(userId);
  socket.emit('status_update', handler.state.connectionStatus);
  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected: ${socket.id} (reason: ${reason})`);
  });
});

// API Routes
// Auth: skip for health and auth routes; otherwise require JWT when JWT_SECRET set
app.use((req, res, next) => {
  const p = req.originalUrl || req.url || '';
  if (p === '/health' || p === '/api/health' || p.startsWith('/api/auth')) return next();
  return authMiddleware(req, res, next);
});

// Debug endpoint to check WhatsApp listener status
app.get('/api/debug/listeners', async (req, res) => {
  try {
    const { whatsapp } = getOrCreateHandler(req.userId);
    const status = whatsapp.getStatus();
    
    // Safely access socket properties
    let sock = null;
    let socketExists = false;
    let socketUserId = null;
    let listenersAttached = false;
    
    try {
      sock = whatsapp.sock;
      socketExists = !!sock;
      if (sock) {
        socketUserId = sock.user?.id || null;
        listenersAttached = !!sock.ev;
      }
    } catch (sockError) {
      console.log('   ⚠️ Could not access socket:', sockError.message);
    }
    
    // Safely serialize lastMessageTime
    let lastMessageTimeISO = null;
    try {
      if (whatsapp.lastMessageTime) {
        lastMessageTimeISO = whatsapp.lastMessageTime instanceof Date 
          ? whatsapp.lastMessageTime.toISOString()
          : new Date(whatsapp.lastMessageTime).toISOString();
      }
    } catch (timeError) {
      // Ignore time serialization errors
    }
    
    const debugInfo = {
      isConnected: whatsapp.isConnected || false,
      connectionTime: whatsapp.connectionTime ? new Date(whatsapp.connectionTime).toISOString() : null,
      status: status?.status || 'unknown',
      socketExists: socketExists,
      socketUserId: socketUserId,
      listenersAttached: listenersAttached,
      messageReceivedCount: whatsapp.messageReceivedCount || 0,
      lastMessageTime: lastMessageTimeISO,
      timestamp: new Date().toISOString(),
      message: 'Send a test WhatsApp message to verify messages.upsert is firing. Check backend console for event logs.'
    };
    
    console.log('\n🔍 DEBUG: Listener Status Check');
    console.log('   isConnected:', whatsapp.isConnected);
    console.log('   connectionTime:', whatsapp.connectionTime ? new Date(whatsapp.connectionTime).toISOString() : 'NOT SET');
    console.log('   Socket exists:', socketExists);
    console.log('   Event emitter exists:', listenersAttached);
    console.log('   Socket user ID:', socketUserId || 'none');
    console.log('   Message received count:', whatsapp.messageReceivedCount || 0);
    console.log('   Last message time:', lastMessageTimeISO || 'never');
    if (socketExists && listenersAttached) {
      console.log('   ✅ Listeners are attached (messages.upsert, connection.update, etc.)');
    } else {
      console.log('   ⚠️ Socket or listeners may not be properly initialized');
    }
    console.log('');
    
    res.json(debugInfo);
  } catch (error) {
    console.error('❌ Error in /api/debug/listeners:', error);
    console.error('   Message:', error.message);
    console.error('   Stack:', error.stack);
    res.status(500).json({ 
      error: error.message,
      stack: error.stack 
    });
  }
});

// Test export endpoint
app.get('/api/export/test', (req, res) => {
  res.json({ message: 'Export endpoint is working', timestamp: new Date().toISOString() });
});

// Test messages endpoint
app.get('/api/test-messages', async (req, res) => {
  try {
    await db.db.read();
    const allMessages = db.db.data.messages;
    console.log('📬 Retrieved messages:', allMessages);
    console.log('📊 Total messages:', allMessages.length);
    res.json({ 
      count: allMessages.length,
      messages: allMessages 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Refresh all contact names directly from WhatsApp
app.post('/api/contacts/refresh', async (req, res) => {
  try {
    const { whatsapp } = getOrCreateHandler(req.userId);
    const result = await whatsapp.refreshAllContactNames();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bot status
app.get('/api/bot/status', async (req, res) => {
  try {
    const handler = getOrCreateHandler(req.userId);
    const { whatsapp, state } = handler;
    const connectionStatus = state.connectionStatus;
    let status = { status: 'initializing', isConnected: false };
    try {
      status = whatsapp.getStatus();
    } catch (statusError) {
      console.error('Error getting WhatsApp status:', statusError);
      status = connectionStatus;
    }
    
    let logs = [];
    try {
      logs = await db.getRecentLogs(20, req.userId);
    } catch (logError) {
      console.error('Error fetching logs:', logError);
      logs = [];
    }
    
    let botPaused = 'false';
    try {
      botPaused = await db.getSetting('bot_paused', req.userId) || 'false';
    } catch (settingError) {
      console.error('Error fetching bot_paused setting:', settingError);
    }
    
    const qr = connectionStatus.qr || status.qr;
    
    const response = {
      status: connectionStatus.status || status.status || 'initializing',
      isConnected: status.isConnected || false,
      reconnectAttempts: status.reconnectAttempts || 0,
      connectionTime: whatsapp.connectionTime || connectionStatus.connectionTime || null,
      ...(qr ? { qr } : {}),
      bot_paused: botPaused,
      timestamp: connectionStatus.timestamp || new Date().toISOString(),
      logs: logs.map(log => {
        try {
          // Parse details if it's a string, otherwise use as-is
          let details = null;
          if (log.details) {
            if (typeof log.details === 'string') {
              try {
                details = JSON.parse(log.details);
              } catch (parseErr) {
                details = null;
              }
            } else {
              details = log.details;
            }
          }
          return {
            id: log.id,
            action: log.action,
            timestamp: log.timestamp,
            details
          };
        } catch (parseError) {
          // If parsing fails, just return log without details
          return {
            id: log.id,
            action: log.action,
            timestamp: log.timestamp,
            details: null
          };
        }
      })
    };
    
    res.json(response);
  } catch (error) {
    console.error('❌ Error in /api/bot/status:', error);
    console.error('   Message:', error.message);
    console.error('   Stack:', error.stack);
    
    // Return a safe error response that won't break the frontend
    try {
      res.status(500).json({ 
        status: 'error',
        error: error.message || 'Unknown error',
        isConnected: false,
        reconnectAttempts: 0,
        bot_paused: 'false',
        timestamp: new Date().toISOString(),
        logs: []
      });
    } catch (jsonError) {
      // If even JSON serialization fails, send minimal response
      console.error('❌ Failed to send error response:', jsonError);
      res.status(500).send('Internal Server Error');
    }
  }
});

// Pause/Resume bot (scoped to this client's handler; emit to this client only)
app.post('/api/bot/pause', async (req, res) => {
  await db.setSetting('bot_paused', 'true', req.userId);
  await db.addLog('bot_paused', { timestamp: new Date().toISOString() }, req.userId);
  emitToUser(req.userId, 'bot_status_changed', { bot_paused: 'true' });
  res.json({ success: true, paused: true });
});

app.post('/api/bot/resume', async (req, res) => {
  await db.setSetting('bot_paused', 'false', req.userId);
  await db.addLog('bot_resumed', { timestamp: new Date().toISOString() }, req.userId);
  emitToUser(req.userId, 'bot_status_changed', { bot_paused: 'false' });
  res.json({ success: true, paused: false });
});

// Reconnect
app.post('/api/bot/reconnect', async (req, res) => {
  try {
    const { whatsapp } = getOrCreateHandler(req.userId);
    await whatsapp.reconnect();
    res.json({ success: true, message: 'Reconnection initiated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect
app.post('/api/bot/disconnect', async (req, res) => {
  try {
    const { whatsapp } = getOrCreateHandler(req.userId);
    await whatsapp.disconnect();
    res.json({ success: true, message: 'Disconnected successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get all leads
app.get('/api/leads', async (req, res) => {
  try {
    // Prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const { status } = req.query;
    const leads = await db.getAllLeads(status || null, req.userId);
    const { whatsapp } = getOrCreateHandler(req.userId);
    const connectionTime = whatsapp.connectionTime;
    const leadsWithMessages = await Promise.all(
      leads.map(async (lead) => {
let messages = await db.getMessagesByLead(lead.id, req.userId);
        // Filter to only show messages after connection
        if (connectionTime) {
          messages = messages.filter(msg => {
            const msgTime = new Date(msg.timestamp);
            return msgTime >= connectionTime;
          });
        }
        const lastMessage = messages[messages.length - 1] || null;

        // Use cached contact info from database (faster - no WhatsApp API calls)
        // Contact info is already fetched and stored when chats are loaded
        const contactName = lead.contact_name || lead.phone_number;
        const profilePictureUrl = lead.profile_picture_url || null;
        
        return {
          ...lead,
          contactName,
          profilePictureUrl,
          lastMessage: lastMessage ? {
            content: lastMessage.content.substring(0, 50),
            timestamp: lastMessage.timestamp,
            sender: lastMessage.sender
          } : null
        };
      })
    );

    res.json(leadsWithMessages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get single lead
app.get('/api/leads/:id', async (req, res) => {
  try {
    // Prevent caching
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    
    const leadId = req.params.id;
    const lead = await db.getLead(leadId, req.userId);
    if (!lead) {
      console.log(`❌ Lead not found: ${leadId}`);
      // Check if lead exists with different ID (might be a normalization issue)
      await db.db.read();
      const allLeads = db.db.data.leads;
      console.log(`   Available leads: ${allLeads.length} total`);
      return res.status(404).json({ error: 'Lead not found', leadId });
    }
    
    // Removed verbose logging - only log if needed for debugging
    // console.log(`✅ Lead found: ${lead.phone_number}`);
    
    // Only return messages created after connection time (filter old messages)
    let messages = await db.getMessagesByLead(lead.id, req.userId);
    const { whatsapp } = getOrCreateHandler(req.userId);
    const connectionTime = whatsapp.connectionTime;
    if (connectionTime) {
      // Filter to only show messages after connection was established
      messages = messages.filter(msg => {
        const msgTime = new Date(msg.timestamp);
        return msgTime >= connectionTime;
      });
    }
    
    const response = { 
      ...lead, 
      messages,
      contactName: lead.contact_name || lead.phone_number,
      profilePictureUrl: lead.profile_picture_url || null
    };
    
    // console.log(`✅ API response: lead with ${response.messages.length} messages\n`);
    res.json(response);
  } catch (error) {
    console.error('❌ API Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Mark lead as completed
app.post('/api/leads/:id/complete', async (req, res) => {
  try {
    await db.updateLeadStatus(req.params.id, 'completed', req.userId);
    await db.addLog('lead_completed', { leadId: req.params.id }, req.userId);
    // Emit WebSocket event
    const lead = await db.getLead(req.params.id, req.userId);
    if (lead) {
      emitToUser(req.userId, 'lead_updated', lead);
      emitToUser(req.userId, 'leads_changed');
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete lead and all messages
app.delete('/api/leads/:id', async (req, res) => {
  try {
    await db.deleteLead(req.params.id, req.userId);
    await db.addLog('lead_deleted', { leadId: req.params.id }, req.userId);
    // Emit WebSocket event
    emitToUser(req.userId, 'lead_deleted', { id: req.params.id });
    emitToUser(req.userId, 'leads_changed');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear everything: all leads and all messages (fresh start - only new incoming/outgoing will show)
app.post('/api/messages/clear', async (req, res) => {
  try {
    console.log('🧹 Clearing all leads and messages...');
    const result = await db.clearAll(req.userId);
    console.log(`✅ Cleared ${result.leadCount} leads and ${result.messageCount} messages`);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('❌ Error clearing:', error);
    res.status(500).json({ error: error.message, stack: error.stack });
  }
});

// Send manual message
app.post('/api/messages/send', async (req, res) => {
  try {
    const { phoneNumber, message, leadId } = req.body;
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'phoneNumber and message are required' });
    }

    const { whatsapp } = getOrCreateHandler(req.userId);
    const result = await whatsapp.sendManualMessage(phoneNumber, message, io, leadId || null);
    res.json(result);
  } catch (error) {
    console.error('❌ /api/messages/send error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getAllSettings(req.userId);
    const productInfo = await db.getProductInfo(req.userId);
    
    const { openrouter_api_key, ai_model, ...safeSettings } = settings;
    if (typeof safeSettings.keyword_replies === 'string') {
      try {
        safeSettings.keyword_replies = JSON.parse(safeSettings.keyword_replies);
      } catch {
        safeSettings.keyword_replies = [];
      }
    }
    if (typeof safeSettings.saved_audios === 'string') {
      try {
        safeSettings.saved_audios = JSON.parse(safeSettings.saved_audios);
      } catch {
        safeSettings.saved_audios = [];
      }
    } else if (!Array.isArray(safeSettings.saved_audios)) {
      safeSettings.saved_audios = [];
    }
    res.json({ ...safeSettings, product_info: productInfo });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update settings
app.post('/api/settings', async (req, res) => {
  try {
    const { product_info, keyword_replies, ...otherSettings } = req.body;

    if (product_info !== undefined) {
      await db.setProductInfo(product_info, req.userId);
    }

    if (keyword_replies !== undefined) {
      const value = Array.isArray(keyword_replies) ? JSON.stringify(keyword_replies) : (typeof keyword_replies === 'string' ? keyword_replies : JSON.stringify([]));
      await db.setSetting('keyword_replies', value, req.userId);
    }

    for (const [key, value] of Object.entries(otherSettings)) {
      if (value !== undefined) {
        await db.setSetting(key, typeof value === 'object' ? JSON.stringify(value) : String(value), req.userId);
      }
    }

    await db.addLog('settings_updated', { timestamp: new Date().toISOString() }, req.userId);
    
    // Emit WebSocket event for settings update
    const updatedSettings = await db.getAllSettings(req.userId);
    const updatedProductInfo = await db.getProductInfo(req.userId);
    emitToUser(req.userId, 'settings_updated', { 
      ...updatedSettings, 
      product_info: updatedProductInfo 
    });
    
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Normalize path to forward slashes so it works on all platforms
function normalizeAudioPath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/') : p;
}

// Upload pre-recorded audio (multipart) — adds to saved_audios list
app.post('/api/settings/audio', uploadAudio.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file' });
    const id = req.audioId || req.file.filename.split('.')[0];
    const relativePath = normalizeAudioPath(join('audio', req.file.filename));
    const raw = await db.getSetting('saved_audios', req.userId);
    let list = [];
    try {
      list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    } catch {
      list = [];
    }
    list.push({ id, path: relativePath });
    await db.setSetting('saved_audios', JSON.stringify(list), req.userId);
    const updatedSettings = await db.getAllSettings(req.userId);
    const savedAudios = typeof updatedSettings.saved_audios === 'string' ? JSON.parse(updatedSettings.saved_audios || '[]') : (updatedSettings.saved_audios || []);
    emitToUser(req.userId, 'settings_updated', { ...updatedSettings, saved_audios: savedAudios });
    res.json({ success: true, id, path: relativePath });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve saved audio for playback by id (query ?id=) or legacy single file (no id)
app.get('/api/settings/audio/file', async (req, res) => {
  try {
    let id = req.query.id || req.params?.id;
    if (Array.isArray(id)) id = id[0];
    id = id ? String(id).trim() : null;

    let fullPath = null;
    let list = [];

    if (id) {
      const raw = await db.getSetting('saved_audios', req.userId);
      try {
        list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
      } catch {
        return res.status(404).json({ error: 'No audio' });
      }
      const entry = list.find(a => a.id === id);
      if (!entry) return res.status(404).json({ error: 'No audio' });
      fullPath = join(dataDir, normalizeAudioPath(entry.path));
    } else {
      const legacyPath = await db.getSetting('welcome_audio_path', req.userId);
      if (legacyPath) fullPath = join(dataDir, normalizeAudioPath(legacyPath));
    }

    if (!fullPath || !existsSync(fullPath)) return res.status(404).json({ error: 'File not found' });
    const ext = fullPath.split('.').pop()?.toLowerCase() || 'ogg';
    const mime = ext === 'mp3' ? 'audio/mpeg' : 'audio/ogg';
    res.setHeader('Content-Type', mime);
    createReadStream(fullPath).pipe(res);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete one pre-recorded audio by id
app.delete('/api/settings/audio/:id', async (req, res) => {
  try {
    const id = req.params.id;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const raw = await db.getSetting('saved_audios', req.userId);
    let list = [];
    try {
      list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    } catch {
      return res.json({ success: true });
    }
    const entry = list.find(a => a.id === id);
    list = list.filter(a => a.id !== id);
    await db.setSetting('saved_audios', JSON.stringify(list), req.userId);
    if (entry) {
      const fullPath = join(dataDir, normalizeAudioPath(entry.path));
      if (existsSync(fullPath)) unlinkSync(fullPath);
    }
    const updatedSettings = await db.getAllSettings(req.userId);
    const savedAudios = typeof updatedSettings.saved_audios === 'string' ? JSON.parse(updatedSettings.saved_audios || '[]') : (updatedSettings.saved_audios || []);
    emitToUser(req.userId, 'settings_updated', { ...updatedSettings, saved_audios: savedAudios });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export chat logs
app.get('/api/export/logs', async (req, res) => {
  try {
    const { format = 'json' } = req.query;
    const leads = await db.getAllLeads(null, req.userId);
    
    const { whatsapp } = getOrCreateHandler(req.userId);
    const connectionTime = whatsapp.connectionTime;
    const allMessages = [];
    for (const lead of leads) {
      let messages = await db.getMessagesByLead(lead.id, req.userId);
      // Filter to only show messages after connection
      if (connectionTime) {
        messages = messages.filter(msg => {
          const msgTime = new Date(msg.timestamp);
          return msgTime >= connectionTime;
        });
      }
      for (const msg of messages) {
        allMessages.push({
          leadId: lead.id,
          phoneNumber: lead.phone_number,
          sender: msg.sender,
          content: msg.content,
          timestamp: msg.timestamp,
          status: msg.status
        });
      }
    }
    
    // Sort by timestamp
    allMessages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    if (format === 'csv') {
      // Generate CSV
      const headers = ['Phone Number', 'Sender', 'Content', 'Timestamp', 'Status'];
      const rows = allMessages.map(msg => [
        msg.phoneNumber,
        msg.sender,
        `"${msg.content.replace(/"/g, '""')}"`, // Escape quotes in CSV
        msg.timestamp,
        msg.status
      ]);
      
      const csv = [
        headers.join(','),
        ...rows.map(row => row.join(','))
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename=shield-logs-${new Date().toISOString().split('T')[0]}.csv`);
      res.send(csv);
    } else {
      // Generate JSON
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename=shield-logs-${new Date().toISOString().split('T')[0]}.json`);
      res.json({
        exportDate: new Date().toISOString(),
        totalMessages: allMessages.length,
        messages: allMessages
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get logs
app.get('/api/logs', async (req, res) => {
  try {
    const { limit = 20 } = req.query;
    const logs = await db.getRecentLogs(parseInt(limit), req.userId);
    res.json(logs.map(log => {
      try {
        let details = null;
        if (log.details) {
          // Parse details if it's a string, otherwise use as-is
          if (typeof log.details === 'string') {
            try {
              details = JSON.parse(log.details);
            } catch (parseErr) {
              details = log.details; // Use as string if parsing fails
            }
          } else {
            details = log.details; // Already an object
          }
        }
        return {
          id: log.id,
          action: log.action,
          timestamp: log.timestamp,
          details
        };
      } catch (parseError) {
        return {
          id: log.id,
          action: log.action,
          timestamp: log.timestamp,
          details: null
        };
      }
    }));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Note: Log events are emitted directly from whatsapp.js and API endpoints

// Helper function to emit events
export function emitEvent(eventName, data) {
  io.emit(eventName, data);
}

// Handle port already in use error
httpServer.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n❌ ERROR: Port ${PORT} is already in use!`);
    console.error(`\n🔧 Fix: Run this command to kill all Node processes:`);
    console.error(`   Get-Process -Name node | Stop-Process -Force`);
    console.error(`\n   Or use: node kill-node.ps1`);
    console.error(`\n   Then restart: npm start\n`);
    process.exit(1);
  } else {
    console.error('Server error:', error);
    process.exit(1);
  }
});

// Graceful shutdown handler
let isShuttingDown = false;
const SHUTDOWN_TIMEOUT = 30000; // 30 seconds max for shutdown

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`⚠️ ${signal} received again, forcing exit...`);
    process.exit(1);
  }
  
  isShuttingDown = true;
  console.log(`\n🛑 ${signal} received, starting graceful shutdown...`);
  
  // Set a timeout to force exit if shutdown takes too long
  const forceExitTimer = setTimeout(() => {
    console.error('❌ Shutdown timeout exceeded, forcing exit...');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT);
  
  try {
    // Close HTTP server (stops accepting new connections)
    console.log('   Closing HTTP server...');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('   ⚠️ HTTP server close timeout, continuing...');
        resolve();
      }, 5000);
      
      httpServer.close(() => {
        clearTimeout(timeout);
        console.log('   ✅ HTTP server closed');
        resolve();
      });
    });
    
    // Close Socket.IO server
    console.log('   Closing Socket.IO server...');
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.log('   ⚠️ Socket.IO close timeout, continuing...');
        resolve();
      }, 5000);
      
      io.close(() => {
        clearTimeout(timeout);
        console.log('   ✅ Socket.IO server closed');
        resolve();
      });
    });
    
    // Close all WhatsApp handlers (with timeout per handler)
    console.log('   Closing WhatsApp handlers...');
    const disconnectPromises = [];
    for (const [userId, handler] of userHandlers.entries()) {
      const disconnectPromise = (async () => {
        try {
          if (handler.whatsapp) {
            // Set a timeout for each disconnect (10 seconds max)
            await Promise.race([
              handler.whatsapp.disconnect().catch(err => {
                console.error(`   ⚠️ Error disconnecting WhatsApp for ${userId}:`, err.message);
              }),
              new Promise(resolve => setTimeout(() => {
                console.log(`   ⚠️ WhatsApp disconnect timeout for ${userId}, continuing...`);
                resolve();
              }, 10000))
            ]);
            console.log(`   ✅ WhatsApp handler closed for user: ${userId}`);
          }
        } catch (error) {
          console.error(`   ⚠️ Error closing WhatsApp handler for ${userId}:`, error.message);
        }
      })();
      disconnectPromises.push(disconnectPromise);
    }
    await Promise.all(disconnectPromises);
    
    // Close database connections
    console.log('   Closing database connections...');
    await Promise.race([
      db.close(),
      new Promise(resolve => setTimeout(() => {
        console.log('   ⚠️ Database close timeout, continuing...');
        resolve();
      }, 5000))
    ]);
    console.log('   ✅ Database closed');
    
    clearTimeout(forceExitTimer);
    console.log('✅ Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimer);
    console.error('❌ Error during graceful shutdown:', error);
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  gracefulShutdown('uncaughtException').catch(() => process.exit(1));
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejection in production, but log it
  if (process.env.NODE_ENV === 'production') {
    console.error('   Continuing in production mode...');
  } else {
    gracefulShutdown('unhandledRejection').catch(() => process.exit(1));
  }
});


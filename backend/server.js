import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import multer from 'multer';
import { createServer } from 'http';
import { Server } from 'socket.io';
import Database from './database.js';
import WhatsAppHandler from './whatsapp.js';
import { randomUUID } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, createReadStream, unlinkSync } from 'fs';

dotenv.config();

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

// Bind immediately so Render/cloud sees the port open (before DB/WhatsApp init)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Shield Backend listening on ${PORT} (0.0.0.0)`);
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
  if (!origin) return true;
  if (process.env.NODE_ENV !== 'production' || allowedOrigins.length === 0) return true;
  const normalized = allowedOrigins.map(a => a.replace(/^https?:\/\//, ''));
  return normalized.some(allowed => origin.replace(/^https?:\/\//, '').includes(allowed) || origin === allowed || allowed === '*');
}

// Initialize Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: function(origin, callback) {
      if (isOriginAllowed(origin, CORS_ORIGINS)) {
        return callback(null, true);
      }
      console.log('⚠️ CORS blocked WebSocket origin:', origin);
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
const db = process.env.DATABASE_URL
  ? new Database({ databaseUrl: process.env.DATABASE_URL })
  : new Database(process.env.DB_PATH || 'shield.json');
const whatsapp = new WhatsAppHandler(db);

// Prune old messages on startup to save space (env: PRUNE_MESSAGES_OLDER_THAN_DAYS, default 5)
const pruneDays = parseInt(process.env.PRUNE_MESSAGES_OLDER_THAN_DAYS || '5', 10);
if (Number.isFinite(pruneDays) && pruneDays > 0) {
  db.pruneOldMessages(pruneDays).catch((err) => console.warn('Prune on startup:', err.message));
}

// Set up WebSocket event emitter for WhatsApp handler
// Pass io directly for more reliable event emission
whatsapp.setIO(io);
whatsapp.setEventEmitter((eventName, data) => {
  try {
    console.log(`📡 Emitting WebSocket event: ${eventName}`);
    io.emit(eventName, data);
    console.log(`✅ WebSocket event ${eventName} emitted successfully`);
  } catch (error) {
    console.error(`❌ Error emitting WebSocket event ${eventName}:`, error);
  }
});

// Status tracking
let connectionStatus = { status: 'initializing', timestamp: new Date().toISOString() };

whatsapp.setStatusCallback((status) => {
  // Preserve QR code if it exists in new status or keep existing one
  const existingQr = connectionStatus.qr;
  const newQr = status.qr;
  connectionStatus = { 
    ...status, 
    timestamp: new Date().toISOString(),
    // Include connectionTime from WhatsApp handler if available
    connectionTime: whatsapp.connectionTime || status.connectionTime || null,
    // Keep QR if new status has it, otherwise preserve existing
    qr: newQr || existingQr
  };
  
  // Emit status update via WebSocket
  io.emit('status_update', connectionStatus);
});

// Initialize WhatsApp connection
whatsapp.initialize().catch((error) => {
  console.error('❌ Failed to initialize WhatsApp:', error);
  console.error('Stack:', error.stack);
  // Update connection status to error
  connectionStatus = {
    status: 'error',
    error: error.message,
    timestamp: new Date().toISOString()
  };
});

// API Routes

// Debug endpoint to check WhatsApp listener status
app.get('/api/debug/listeners', async (req, res) => {
  try {
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
    const result = await whatsapp.refreshAllContactNames();
    res.json(result);
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Bot status
app.get('/api/bot/status', async (req, res) => {
  try {
    let status = { status: 'initializing', isConnected: false };
    try {
      status = whatsapp.getStatus();
    } catch (statusError) {
      console.error('Error getting WhatsApp status:', statusError);
      console.error('Stack:', statusError.stack);
      // Use connectionStatus as fallback
      status = connectionStatus;
    }
    
    let logs = [];
    try {
      logs = await db.getRecentLogs(20);
    } catch (logError) {
      console.error('Error fetching logs:', logError);
      logs = [];
    }
    
    let botPaused = 'false';
    try {
      botPaused = await db.getSetting('bot_paused') || 'false';
    } catch (settingError) {
      console.error('Error fetching bot_paused setting:', settingError);
    }
    
    // Merge connectionStatus with whatsapp status, prioritizing connectionStatus for QR
    // Ensure QR is preserved from either source
    const qr = connectionStatus.qr || status.qr;
    
    // Safely serialize the response, removing any non-serializable data
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

// Pause/Resume bot
app.post('/api/bot/pause', async (req, res) => {
  await db.setSetting('bot_paused', 'true');
  await db.addLog('bot_paused', { timestamp: new Date().toISOString() });
  // Emit WebSocket event
  io.emit('bot_status_changed', { bot_paused: 'true' });
  res.json({ success: true, paused: true });
});

app.post('/api/bot/resume', async (req, res) => {
  await db.setSetting('bot_paused', 'false');
  await db.addLog('bot_resumed', { timestamp: new Date().toISOString() });
  // Emit WebSocket event
  io.emit('bot_status_changed', { bot_paused: 'false' });
  res.json({ success: true, paused: false });
});

// Reconnect
app.post('/api/bot/reconnect', async (req, res) => {
  try {
    await whatsapp.reconnect();
    res.json({ success: true, message: 'Reconnection initiated' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Disconnect
app.post('/api/bot/disconnect', async (req, res) => {
  try {
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
    const leads = await db.getAllLeads(status || null);
    
    // Get last message and contact name for each lead
    // Only show messages after connection time
    const connectionTime = whatsapp.connectionTime;
    const leadsWithMessages = await Promise.all(
      leads.map(async (lead) => {
        let messages = await db.getMessagesByLead(lead.id);
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
    const lead = await db.getLead(leadId);
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
    let messages = await db.getMessagesByLead(lead.id);
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
    await db.updateLeadStatus(req.params.id, 'completed');
    await db.addLog('lead_completed', { leadId: req.params.id });
    // Emit WebSocket event
    const lead = await db.getLead(req.params.id);
    if (lead) {
      io.emit('lead_updated', lead);
      io.emit('leads_changed');
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete lead and all messages
app.delete('/api/leads/:id', async (req, res) => {
  try {
    await db.deleteLead(req.params.id);
    await db.addLog('lead_deleted', { leadId: req.params.id });
    // Emit WebSocket event
    io.emit('lead_deleted', { id: req.params.id });
    io.emit('leads_changed');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Clear everything: all leads and all messages (fresh start - only new incoming/outgoing will show)
app.post('/api/messages/clear', async (req, res) => {
  try {
    console.log('🧹 Clearing all leads and messages...');
    const result = await db.clearAll();
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

    // Pass io directly to sendManualMessage so it can emit events reliably
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
    const settings = await db.getAllSettings();
    const productInfo = await db.getProductInfo();
    
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
      await db.setProductInfo(product_info);
    }

    if (keyword_replies !== undefined) {
      const value = Array.isArray(keyword_replies) ? JSON.stringify(keyword_replies) : (typeof keyword_replies === 'string' ? keyword_replies : JSON.stringify([]));
      await db.setSetting('keyword_replies', value);
    }

    for (const [key, value] of Object.entries(otherSettings)) {
      if (value !== undefined) {
        await db.setSetting(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
    }

    await db.addLog('settings_updated', { timestamp: new Date().toISOString() });
    
    // Emit WebSocket event for settings update
    const updatedSettings = await db.getAllSettings();
    const updatedProductInfo = await db.getProductInfo();
    io.emit('settings_updated', { 
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
    const raw = await db.getSetting('saved_audios');
    let list = [];
    try {
      list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    } catch {
      list = [];
    }
    list.push({ id, path: relativePath });
    await db.setSetting('saved_audios', JSON.stringify(list));
    const updatedSettings = await db.getAllSettings();
    const savedAudios = typeof updatedSettings.saved_audios === 'string' ? JSON.parse(updatedSettings.saved_audios || '[]') : (updatedSettings.saved_audios || []);
    io.emit('settings_updated', { ...updatedSettings, saved_audios: savedAudios });
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
      const raw = await db.getSetting('saved_audios');
      try {
        list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
      } catch {
        return res.status(404).json({ error: 'No audio' });
      }
      const entry = list.find(a => a.id === id);
      if (!entry) return res.status(404).json({ error: 'No audio' });
      fullPath = join(dataDir, normalizeAudioPath(entry.path));
    } else {
      const legacyPath = await db.getSetting('welcome_audio_path');
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
    const raw = await db.getSetting('saved_audios');
    let list = [];
    try {
      list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    } catch {
      return res.json({ success: true });
    }
    const entry = list.find(a => a.id === id);
    list = list.filter(a => a.id !== id);
    await db.setSetting('saved_audios', JSON.stringify(list));
    if (entry) {
      const fullPath = join(dataDir, normalizeAudioPath(entry.path));
      if (existsSync(fullPath)) unlinkSync(fullPath);
    }
    const updatedSettings = await db.getAllSettings();
    const savedAudios = typeof updatedSettings.saved_audios === 'string' ? JSON.parse(updatedSettings.saved_audios || '[]') : (updatedSettings.saved_audios || []);
    io.emit('settings_updated', { ...updatedSettings, saved_audios: savedAudios });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Export chat logs
app.get('/api/export/logs', async (req, res) => {
  try {
    const { format = 'json' } = req.query;
    const leads = await db.getAllLeads();
    
    // Get all messages for all leads (only after connection time)
    const connectionTime = whatsapp.connectionTime;
    const allMessages = [];
    for (const lead of leads) {
      let messages = await db.getMessagesByLead(lead.id);
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
    const logs = await db.getRecentLogs(parseInt(limit));
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

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('✅ Client connected via WebSocket:', socket.id);
  console.log('   Origin:', socket.handshake.headers.origin || 'unknown');
  console.log('   Total connected clients:', io.sockets.sockets.size);
  
  // Send initial status on connection
  socket.emit('status_update', connectionStatus);
  
  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected: ${socket.id} (reason: ${reason})`);
    console.log('   Remaining connected clients:', io.sockets.sockets.size);
  });
  
  socket.on('error', (error) => {
    console.error(`❌ Socket error for ${socket.id}:`, error);
  });
});

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

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing database...');
  await db.close();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing database...');
  await db.close();
  process.exit(0);
});


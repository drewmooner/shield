import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Database from './database.js';
import WhatsAppHandler from './whatsapp.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
// CORS configuration for Vercel frontend
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
    
    // In production, check allowed origins; in development, allow all
    if (process.env.NODE_ENV !== 'production' || allowedOrigins.length === 0) {
      return callback(null, true);
    }
    
    if (allowedOrigins.some(allowed => origin.includes(allowed.replace('https://', '').replace('http://', '')))) {
      callback(null, true);
    } else {
      // Log for debugging
      console.log('CORS blocked origin:', origin);
      callback(null, true); // Allow for now - tighten in production
    }
  },
  credentials: true
}));
app.use(express.json());
app.use(express.static(join(__dirname, '../public')));

// Initialize database and WhatsApp handler
const db = new Database(process.env.DB_PATH || 'shield.json');
const whatsapp = new WhatsAppHandler(db);

// Status tracking
let connectionStatus = { status: 'initializing', timestamp: new Date().toISOString() };

whatsapp.setStatusCallback((status) => {
  // Preserve QR code if it exists in new status or keep existing one
  const existingQr = connectionStatus.qr;
  const newQr = status.qr;
  connectionStatus = { 
    ...status, 
    timestamp: new Date().toISOString(),
    // Keep QR if new status has it, otherwise preserve existing
    qr: newQr || existingQr
  };
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

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
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
  res.json({ success: true, paused: true });
});

app.post('/api/bot/resume', async (req, res) => {
  await db.setSetting('bot_paused', 'false');
  await db.addLog('bot_resumed', { timestamp: new Date().toISOString() });
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
    const leadsWithMessages = await Promise.all(
      leads.map(async (lead) => {
        const messages = await db.getMessagesByLead(lead.id);
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
    
    const messages = await db.getMessagesByLead(lead.id);
    // console.log(`📬 Returning ${messages.length} messages`);
    
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
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send manual message
app.post('/api/messages/send', async (req, res) => {
  try {
    const { phoneNumber, message } = req.body;
    if (!phoneNumber || !message) {
      return res.status(400).json({ error: 'phoneNumber and message are required' });
    }

    const result = await whatsapp.sendManualMessage(phoneNumber, message);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get settings
app.get('/api/settings', async (req, res) => {
  try {
    const settings = await db.getAllSettings();
    const templates = await db.getTemplates();
    res.json({ ...settings, templates });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update settings
app.post('/api/settings', async (req, res) => {
  try {
    const { templates, ...otherSettings } = req.body;

    // Update templates separately
    if (templates) {
      await db.setTemplates(templates);
    }

    // Update other settings
    for (const [key, value] of Object.entries(otherSettings)) {
      if (value !== undefined) {
        await db.setSetting(key, String(value));
      }
    }

    await db.addLog('settings_updated', { timestamp: new Date().toISOString() });
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
    
    // Get all messages for all leads
    const allMessages = [];
    for (const lead of leads) {
      const messages = await db.getMessagesByLead(lead.id);
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

// Start server
const server = app.listen(PORT, () => {
  console.log(`🚀 Shield Backend running on port ${PORT}`);
  console.log(`📱 WhatsApp connection initializing...`);
});

// Handle port already in use error
server.on('error', (error) => {
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


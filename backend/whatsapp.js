import makeWASocket, { DisconnectReason, useMultiFileAuthState, isJidBroadcast, isJidGroup, isJidStatusBroadcast, jidNormalizedUser, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { usePostgresAuthState } from './db/auth-state-postgres.js';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import { tmpdir } from 'os';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class WhatsAppHandler {
  constructor(database, options = {}) {
    this.database = database;
    this.clientId = options.clientId ?? null;
    this.cid = this.clientId ?? 'default';
    this.sessionPath = process.env.SESSION_PATH || './sessions';
    this.sessionName = options.sessionName ?? process.env.SESSION_NAME ?? 'shield-session';
    this.fullSessionPath = join(__dirname, this.sessionPath, this.sessionName);
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    this.messageQueue = null;
    this.onStatusChange = null;
    this.eventEmitter = null;
    this.currentStatus = { status: 'initializing' };
    this.connectionTime = null; // Track when connection was established to filter historical messages
    this.skipContactLeadCreationUntil = 0; // Skip creating leads from contacts for N ms after fresh clear
    this.io = null; // ✅ Store io instance here
    this.isRegeneratingQr = false; // When true, 'close' during QR refresh does not emit reconnecting
    this.messageReceivedCount = 0; // Track total messages received
    this.lastMessageTime = null; // Track when last message was received
    this.sentMessageLeadMap = new Map(); // msgId -> leadId pin for fromMe upserts
  }

  setStatusCallback(callback) {
    this.onStatusChange = callback;
  }

  setEventEmitter(emitter) {
    this.eventEmitter = emitter;
  }

  setIO(ioInstance) {
    if (!ioInstance) {
      console.error('❌ CRITICAL: setIO called with null/undefined ioInstance!');
      return;
    }
    this.io = ioInstance;
    console.log('✅ Socket.IO instance set in WhatsAppHandler');
    console.log(`   Socket.IO server ready: ${!!this.io}`);
    if (this.io?.sockets) {
      console.log(`   Connected frontend clients: ${this.io.sockets.sockets?.size || 0}`);
    }
  }

  emit(eventName, data) {
    // Multi-tenant: prefer eventEmitter so events go only to this account's sockets (io.to(`user:${uid}`))
    if (this.eventEmitter) {
      try {
        this.eventEmitter(eventName, data);
        return;
      } catch (error) {
        console.error(`❌ Error emitting ${eventName}:`, error);
      }
    }
    if (this.io) {
      try {
        this.io.emit(eventName, data);
      } catch (error) {
        console.error(`❌ Error emitting via io:`, error);
      }
    }
  }

  async updateStatus(status, details = {}) {
    this.isConnected = status === 'connected' || status === 'open';
    
    // Preserve QR code in status if it exists (unless explicitly cleared or connected)
    const existingQr = this.currentStatus?.qr;
    if (existingQr && !details.qr && status !== 'connected' && status !== 'open') {
      details.qr = existingQr; // Keep QR until connected
    }
    
    // Clear QR when connected
    if (status === 'connected' || status === 'open') {
      delete details.qr;
    }
    
    this.currentStatus = { 
      status, 
      ...details, 
      timestamp: new Date().toISOString() 
    };
    
    if (this.onStatusChange) {
      this.onStatusChange(this.currentStatus);
    }
    
    await this.database.addLog(`status_${status}`, details, this.cid);
  }

  /**
   * Clean up corrupted session folder
   */
  async cleanupSession() {
    if (!this.fullSessionPath) return;
    
    try {
      if (existsSync(this.fullSessionPath)) {
        const files = readdirSync(this.fullSessionPath);
        const hasCreds = files.includes('creds.json');
        
        // Check if creds.json exists but is corrupted (empty or invalid)
        if (hasCreds) {
          try {
            const { readFileSync } = await import('fs');
            const credsPath = join(this.fullSessionPath, 'creds.json');
            const credsContent = readFileSync(credsPath, 'utf-8');
            const creds = JSON.parse(credsContent);
            
            // If creds are invalid or missing required fields, consider corrupted
            if (!creds.me || !creds.me.id) {
              console.log('⚠️ Corrupted creds.json detected, cleaning session...');
              rmSync(this.fullSessionPath, { recursive: true, force: true });
              console.log('✅ Corrupted session cleaned');
            }
          } catch (parseError) {
            console.log('⚠️ Invalid creds.json detected, cleaning session...');
            rmSync(this.fullSessionPath, { recursive: true, force: true });
            console.log('✅ Corrupted session cleaned');
          }
        }
      }
    } catch (error) {
      console.error('Error cleaning session:', error);
    }
  }

  /**
   * Initialize WhatsApp connection with proper error handling and QR generation
   */
  async initialize() {
    // Prevent multiple simultaneous initializations
    if (this.isConnecting) {
      console.log('⚠️ Initialization already in progress, skipping...');
      return;
    }

    this.isConnecting = true;

    // Session paths set in constructor (per-client when options.sessionName provided)

    console.log('\n═══════════════════════════════════════');
    console.log('🚀 Starting WhatsApp initialization...');
    console.log('═══════════════════════════════════════\n');
    console.log('📁 Session path:', this.fullSessionPath);

    try {
      // Ensure session directory exists
      const sessionDir = join(__dirname, this.sessionPath);
      if (!existsSync(sessionDir)) {
        mkdirSync(sessionDir, { recursive: true });
        console.log('✅ Created session directory');
      }

      // Clean up corrupted session if needed
      await this.cleanupSession();

      // Check session state
      const sessionExists = existsSync(this.fullSessionPath);
      let sessionFiles = [];
      let hasValidCreds = false;

      if (sessionExists) {
        try {
          sessionFiles = readdirSync(this.fullSessionPath);
          hasValidCreds = sessionFiles.includes('creds.json');
          console.log('📂 Session exists:', sessionExists);
          console.log('📄 Session files:', sessionFiles.length, 'files');
          console.log('🔐 Has creds.json:', hasValidCreds);
        } catch (e) {
          console.log('⚠️ Error reading session directory:', e.message);
          // Session folder might be corrupted, will be handled by useMultiFileAuthState
        }
      } else {
        console.log('📂 No existing session found - will generate new QR code');
      }

      // Load auth state (PostgreSQL when DATABASE_URL set = persistent session, no re-scan; else file-based)
      console.log('📥 Loading auth state...');
      let state; let saveCreds;
      const pool = this.database.getPool && this.database.getPool();
      if (pool) {
        ({ state, saveCreds } = await usePostgresAuthState(pool, this.sessionName));
        console.log('✅ Auth state loaded from PostgreSQL (sessions persistent)');
      } else {
        // eslint-disable-next-line react-hooks/rules-of-hooks -- Baileys auth helper, not a React hook
        ({ state, saveCreds } = await useMultiFileAuthState(this.fullSessionPath));
        console.log('✅ Auth state loaded from file');
      }
      const hasCreds = !!state.creds && !!state.creds.me;
      console.log('🔐 Has valid credentials:', hasCreds);

      if (hasCreds) {
        console.log('📱 Credentials found - attempting to connect without QR...');
      } else {
        console.log('📱 No credentials found - will generate QR code...');
      }

      // Initialize message queue if not already done
      if (!this.messageQueue) {
        const { default: PQueue } = await import('p-queue');
        this.messageQueue = new PQueue({ concurrency: 1 });
      }

      // Update status to connecting
      await this.updateStatus('connecting');

      // Create socket with explicit latest WA Web version (reduces 405 handshake failures)
      let latestVersion = null;
      let latestInfo = null;
      try {
        console.log('🌐 Fetching latest WhatsApp Web version...');
        latestInfo = await fetchLatestBaileysVersion();
        latestVersion = latestInfo?.version || null;
        if (latestVersion) {
          console.log(`✅ Using WA Web version: ${latestVersion.join('.')} (isLatest: ${latestInfo?.isLatest ? 'yes' : 'no'})`);
        } else {
          console.log('⚠️ Could not resolve WA version from Baileys, falling back to default');
        }
      } catch (versionError) {
        console.log(`⚠️ Version fetch failed, using Baileys fallback: ${versionError.message}`);
      }

      console.log('🔌 Creating WhatsApp socket...');
      const socketConfig = {
        ...(latestVersion ? { version: latestVersion } : {}),
        logger: pino({ level: 'silent' }),
        auth: state,
        mobile: false, // Force desktop mode
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // More generic browser identifier
        // Emit our own sent messages so they sync across session and help linked-device parity with primary phone
        emitOwnEvents: true,
        // Prioritize notify (real-time) over append: skip full history sync
        syncFullHistory: false,
        // Don't mark online on connect - Baileys docs: "will stop sending notifications" when true
        markOnlineOnConnect: false,
        getMessage: async (key) => {
          return {
            conversation: 'Message not available'
          };
        },
        // ✅ CRITICAL: Filter unwanted messages at socket level (prevents buffer saturation)
        // Explicitly allow 1:1 chats first - @lid and @s.whatsapp.net must NEVER be filtered
        shouldIgnoreJid: (jid) => {
          if (!jid) return true;
          // Always allow 1:1 chats (phone@s.whatsapp.net, phone@lid) - fixes messages not firing
          if (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')) return false;
          // Filter status broadcasts, groups, newsletters only
          return isJidBroadcast(jid) || isJidGroup(jid) || isJidStatusBroadcast(jid);
        },
        // Connection timeouts - increased for QR scanning
        connectTimeoutMs: 120000, // 2 minutes to allow QR scanning
        defaultQueryTimeoutMs: 60000,
        // Keep alive
        keepAliveIntervalMs: 10000,
        // Retry configuration
        retryRequestDelayMs: 250,
        maxMsgRetryCount: 3,
        // Removed printQRInTerminal - deprecated, we handle QR manually
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

      // TEST: Force check for QR after a brief delay
      setTimeout(() => {
        console.log('🔍 Socket state check:');
        console.log('   Connected:', this.sock?.user?.id);
        console.log('   Auth state:', this.sock?.authState ? 'Present' : 'Missing');
        console.log('   Socket exists:', !!this.sock);
      }, 2000);

      // Set up event listeners BEFORE any connection updates can occur
      console.log('📡 Setting up event listeners...');

      // Handle credentials updates
      this.sock.ev.on('creds.update', (creds) => {
        setImmediate(() => {
          saveCreds(creds);
        });
      });
      console.log('  ✅ creds.update listener attached');

      // Handle connection updates (MUST be set up immediately)
      this.sock.ev.on('connection.update', async (update) => {
        const connection = update?.connection;
        if (connection === 'open') {
          this.skipContactLeadCreationUntil = Date.now() + 60000; // Prevent contacts from repopulating
          const shouldClear =
            (process.env.CLEAR_ON_CONNECT || '').toLowerCase() === 'true';
          if (shouldClear) {
            try {
              const { leadCount, messageCount } = await this.database.clearAll(this.cid);
              console.log(`   🧹 CLEAR_ON_CONNECT=true: Cleared ${leadCount} leads, ${messageCount} messages. Set CLEAR_ON_CONNECT=false (or unset) in Railway to keep messages across deploys.`);
              this.database.addLog('cleared_on_fresh_connect', { leadCount, messageCount }, this.cid);
              if (this.eventEmitter || this.io) {
                this.emit('leads_changed');
                this.emit('data_cleared'); // So UI can clear local state and show empty
              }
            } catch (err) {
              console.error('   ⚠️ Clear on fresh connect failed:', err.message);
            }
          } else {
            console.log('   ✅ Messages preserved across reconnect/deploy (CLEAR_ON_CONNECT is not set).');
          }
          this.connectionTime = Date.now();
          this.isConnected = true;
          this.isConnecting = false;
        }
        setImmediate(async () => {
          await this.handleConnectionUpdate(update);
        });
      });
      console.log('  ✅ connection.update listener attached');

      // messages.upsert listener attached ONLY in handleConnectionUpdate when connection opens
      // (avoids duplicate listeners + gap when replacing; connectionTime must be set first)
      console.log('  ⏭️ messages.upsert listener will be attached when connection opens');

      // Handle chats.set - PERSISTENT LISTENER (stores contacts but not messages)
      // We skip chats.set to avoid loading historical chats - only process new messages
      // this.sock.ev.on('chats.set', async (chats) => {
      //   setImmediate(async () => {
      //     await this.handleChatsUpdate(chats);
      //   });
      // });
      console.log('  ⏭️ chats.set listener disabled - only processing new incoming messages');

      // Handle contacts update - PERSISTENT LISTENER
      this.sock.ev.on('contacts.set', async (contacts) => {
        setImmediate(async () => {
          await this.handleContactsUpdate(contacts);
        });
      });
      console.log('  ✅ contacts.set listener attached');

      console.log('✅ All event listeners attached\n');

      // The connection.update event will be fired automatically by Baileys
      // We just need to wait for it in handleConnectionUpdate

    } catch (error) {
      console.error('\n❌ WhatsApp initialization error:');
      console.error('   Error:', error.message);
      console.error('   Stack:', error.stack);
      this.isConnecting = false;
      await this.updateStatus('error', { 
        error: error.message,
        stack: error.stack 
      });
      throw error;
    }
  }

  /**
   * Handle connection updates with detailed logging
   */
  async handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, isNewLogin, receivedPendingNotifications } = update;

    // PRIORITY: Handle QR code FIRST - check before anything else
    if (qr) {
      this.isRegeneratingQr = false; // New QR arrived, no longer regenerating
      console.log('\n📡 connection.update received:');
      console.log('   ✅ QR CODE DETECTED!');
      console.log('   QR length:', qr.length);
      
      // Log all update details
      console.log('   Connection state:', connection || 'undefined');
      console.log('   Is new login:', isNewLogin);
      console.log('   Has lastDisconnect:', !!lastDisconnect);
      console.log('\n');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('📱 ✅ QR CODE RECEIVED FROM WHATSAPP!');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('📱 Scan this QR code with WhatsApp to connect:');
      console.log('   Open WhatsApp → Settings → Linked Devices → Link a Device');
      console.log('═══════════════════════════════════════════════════════════');
      console.log('');
      
      // Print QR code in terminal using qrcode-terminal (backup to printQRInTerminal)
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

    // Log connection state details (only if no QR)
    console.log('\n📡 connection.update received:');
    console.log('   Connection state:', connection || 'undefined');
    console.log('   Has QR:', false);
    console.log('   Is new login:', isNewLogin);
    console.log('   Has lastDisconnect:', !!lastDisconnect);

    // Handle connection state changes
    if (connection === 'close') {
      // During QR refresh we intentionally close the socket; don't emit reconnecting/disconnected
      if (this.isRegeneratingQr) {
        console.log('   (QR regenerating – staying on qr_ready, no status change)');
        return;
      }
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const error = lastDisconnect?.error;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      this.connectionTime = null;
      console.log('   🔄 Connection time reset (clearing only happens on next connect if CLEAR_ON_CONNECT=true)');

      console.log('\n🔴 Connection closed:');
      console.log('   Status code:', statusCode);
      console.log('   Disconnect reason:', DisconnectReason[statusCode] || 'Unknown');
      
      if (error) {
        console.log('   Error message:', error.message || error);
      }

      // Handle specific disconnect reasons
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('   ⚠️ Logged out - credentials invalid');
        // Clean up session on logout (PostgreSQL: clear auth in DB; else delete session folder)
        if (this.database.getPool && this.database.getPool()) {
          try {
            await this.database.clearSessionAuth(this.sessionName);
            console.log('   ✅ Session auth cleared from PostgreSQL');
          } catch (cleanError) {
            console.error('   ⚠️ Failed to clear session auth:', cleanError.message);
          }
        } else if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
          console.log('   🧹 Cleaning up logged out session...');
          try {
            rmSync(this.fullSessionPath, { recursive: true, force: true });
            console.log('   ✅ Session cleaned');
          } catch (cleanError) {
            console.error('   ⚠️ Failed to clean session:', cleanError.message);
          }
        }
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        await this.updateStatus('disconnected', { 
          reason: 'logged_out',
          statusCode,
          error: error?.message 
        });
        return; // Don't reconnect on logout
      }

      // Handle 405 - Method Not Allowed (usually means connection rejected)
      if (statusCode === 405) {
        console.log('   ⚠️ Status 405: Method Not Allowed - Connection rejected by WhatsApp');
        console.log('   💡 This usually means:');
        console.log('      - WhatsApp version mismatch');
        console.log('      - Connection method not supported');
        console.log('      - Need to use latest Baileys version');
        console.log('   🔄 Will retry connection WITHOUT clearing session (preserve login)...');
        
        // Reset and retry with same session (no cleanup)
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
          message: 'Connection rejected, retrying without clearing session'
        });
        return;
      }

      if (statusCode === DisconnectReason.restartRequired) {
        console.log('   🔄 Restart required - reconnecting...');
        this.isConnecting = false;
        this.reconnectAttempts = 0; // Reset on restart required
        setTimeout(async () => {
          await this.initialize();
        }, 2000); // Faster reconnect for restart
        return;
      }

      if (statusCode === DisconnectReason.timedOut) {
        // Check if this is a network/DNS error (not QR expiration)
        const errorMessage = error?.message || '';
        const isNetworkError = errorMessage.includes('ENOTFOUND') || 
                               errorMessage.includes('getaddrinfo') ||
                               errorMessage.includes('ECONNREFUSED') ||
                               errorMessage.includes('ETIMEDOUT');
        
        if (isNetworkError) {
          console.log('   🌐 Network/DNS error detected:', errorMessage);
          console.log('   ⚠️ Cannot connect to WhatsApp servers - check your internet connection');
          this.isConnecting = false;
          await this.updateStatus('disconnected', { 
            reason: 'network_error',
            error: errorMessage,
            message: 'Cannot connect to WhatsApp. Check your internet connection.'
          });
          return;
        }
        
        // Check if we were waiting for QR scan - if so, regenerate QR
        const currentStatus = this.currentStatus?.status;
        const hasQR = this.currentStatus?.qr; // Check if we actually had a QR
        
        if ((currentStatus === 'qr_ready' || currentStatus === 'connecting') && hasQR) {
          console.log('   ⏱️ Connection timed out while waiting for QR scan');
          console.log('   🔄 QR code expired. Regenerating QR code...');
          this.isConnecting = false;
          this.reconnectAttempts = 0; // Reset attempts for QR regeneration
          this.isRegeneratingQr = true; // Stay on qr_ready; close events will not emit reconnecting
          // Regenerate QR by reinitializing
          setTimeout(async () => {
            console.log('   📱 Regenerating QR code...');
            await this.initialize();
          }, 2000); // Short delay before regenerating
          await this.updateStatus('qr_ready', { 
            reason: 'qr_regenerating',
            message: 'QR code expired, generating new one...'
          });
          return;
        }
        
        // Normal timeout (not QR-related, not network error)
        console.log('   ⏱️ Connection timed out - reconnecting...');
        this.isConnecting = false;
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
          this.reconnectAttempts++;
          await this.updateStatus('reconnecting', { 
            attempt: this.reconnectAttempts,
            reason: 'timed_out'
          });
          setTimeout(async () => {
            await this.initialize();
          }, this.reconnectDelay);
        } else {
          await this.updateStatus('disconnected', { 
            reason: 'max_attempts',
            attempts: this.reconnectAttempts
          });
        }
        return;
      }

      // Generic close handling
      if (shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        console.log(`   🔄 Reconnecting (attempt ${this.reconnectAttempts + 1}/${this.maxReconnectAttempts})...`);
        this.isConnecting = false;
        this.reconnectAttempts++;
        await this.updateStatus('reconnecting', { 
          attempt: this.reconnectAttempts,
          reason: DisconnectReason[statusCode] || 'unknown'
        });
        
        setTimeout(async () => {
          await this.initialize();
        }, this.reconnectDelay);
      } else {
        console.log('   ❌ Max reconnect attempts reached or should not reconnect');
        this.isConnecting = false;
        await this.updateStatus('disconnected', { 
          reason: shouldReconnect ? 'max_attempts' : 'logged_out',
          attempts: this.reconnectAttempts,
          statusCode
        });
        this.isConnected = false;
      }
    } 
    else if (connection === 'open') {
      // Clear + emit done in sync listener above (runs before this)
      // Set connection time to filter out historical messages (store as milliseconds number for consistency with frontend)
      this.connectionTime = Date.now();
      console.log(`✅ Connection time set: ${new Date(this.connectionTime).toISOString()} (${this.connectionTime}ms)`);
      console.log('\n🟢 Connection opened successfully!');
      this.reconnectAttempts = 0;
      this.isConnected = true;
      this.isConnecting = false;
      
      // ✅ DEBUG: Verify socket is ready and listeners are active
      console.log('\n🔍 DEBUG: Verifying socket after connection...');
      console.log(`   Socket exists: ${!!this.sock}`);
      console.log(`   Socket user ID: ${this.sock?.user?.id || 'none'}`);
      console.log(`   Event emitter exists: ${!!this.sock?.ev}`);
      console.log(`   Socket ready: ${!!this.sock && !!this.sock.user}`);
      
      // ✅ CRITICAL: Ensure messages.upsert listener is attached after connection
      // Attach new listener FIRST, then remove old - avoids gap where messages could be missed
      if (this.sock && this.sock.ev) {
        console.log('   ✅ Socket event emitter verified');
        
        const messageHandler = async (m) => {
          this.messageReceivedCount++;
          this.lastMessageTime = new Date();
          
          // Early skip for append: status/groups or all messages older than 5 min (no log spam)
          if (m.type === 'append' && m.messages.length > 0) {
            const allStatusBroadcastsOrGroups = m.messages.every(msg => {
              const jid = msg.key?.remoteJid;
              return jid === 'status@broadcast' || (jid && jid.endsWith('@g.us'));
            });
            if (allStatusBroadcastsOrGroups) return;
            
            const APPEND_WINDOW_MS = 5 * 60 * 1000;
            const now = Date.now();
            const allTooOld = m.messages.every(msg => {
              if (!msg.messageTimestamp) return false;
              return (now - msg.messageTimestamp * 1000) > APPEND_WINDOW_MS;
            });
            if (allTooOld) return;
          }
          
          // Log only when we will process (notify or recent append)
          const eventType = m.type === 'notify' ? '🔔 NOTIFY (NEW REAL-TIME)' : '📥 APPEND (recent)';
          console.log(`\n${eventType} messages.upsert: ${m.messages.length} message(s) (type: ${m.type})`);
          
          try {
            await this.handleIncomingMessage(m);
          } catch (error) {
            console.error('❌ Error in messages.upsert handler:', error);
            console.error('   Stack:', error.stack);
          }
        };
        this.sock.ev.removeAllListeners('messages.upsert');
        this.sock.ev.on('messages.upsert', messageHandler);
        console.log('   ✅✅✅ messages.upsert listener RE-ATTACHED after connection ✅✅✅');
      } else {
        console.error('   ❌ CRITICAL: Socket or event emitter missing - cannot attach listener!');
      }
      
      if (!this.io) {
        console.error('   ❌ CRITICAL: this.io is NOT set - WebSocket events will NOT reach frontend!');
      } else {
        const clientCount = this.io.sockets?.sockets?.size || 0;
        console.log(`   ✅ Socket.IO verified - ${clientCount} frontend client(s) connected`);
      }
      
      await this.updateStatus('connected', { 
        timestamp: new Date().toISOString(),
        connectionTime: this.connectionTime, // Include connectionTime in status update
        isNewLogin
      });
      console.log('✅ WhatsApp connected and ready\n');
      console.log('📥 Event listeners are active - chats/messages will be stored automatically as WhatsApp syncs them\n');
      console.log('💡 TIP: Send a test message to your WhatsApp number to verify messages.upsert is working\n');
      console.log('💡 DEBUG: If no messages appear, check:');
      console.log('   1. Is WhatsApp fully synced? (wait a few seconds after connection)');
      console.log('   2. Are you sending to the correct number?');
      console.log('   3. Check backend console for "🔔 messages.upsert EVENT FIRED" when you send a message\n');
    } 
    else if (connection === 'connecting') {
      console.log('   ⏳ Connecting... (waiting for QR code or connection)');
      // Only update if we're not already in qr_ready state
      if (this.currentStatus?.status !== 'qr_ready') {
        await this.updateStatus('connecting');
      }
    }
    else {
      // Unknown connection state
      console.log('   ⚠️ Unknown connection state:', connection);
    }
  }

  /**
   * Handle messages.upsert - process real-time messages
   * type 'notify' = new real-time messages - PROCESS immediately
   * type 'append' = could be historical OR new messages - PROCESS if recent (after connection time)
   */
  async handleIncomingMessage(m) {
    console.log(`\n📨 messages.upsert: ${m.messages.length} messages (type: ${m.type})`);

    // Must be connected
    if (!this.connectionTime) {
      console.log('   ⏭️ Skipping - connection not established yet');
      return;
    }

    // For 'notify' type - always process (these are definitely new real-time messages)
    if (m.type === 'notify') {
      console.log('   ✅✅✅ NOTIFY TYPE - Processing immediately (real-time new message) ✅✅✅');
    } else if (m.type === 'append') {
      console.log('   📥 APPEND TYPE - Checking if recent (synced/historical message)');
      // Quick filter: skip status broadcasts and groups early
      const allStatusBroadcastsOrGroups = m.messages.every(msg => {
        const jid = msg.key?.remoteJid;
        return jid === 'status@broadcast' || (jid && jid.endsWith('@g.us'));
      });
      
      if (allStatusBroadcastsOrGroups) {
        console.log(`   ⏭️ Skipping append event - all status broadcasts/groups`);
        return;
      }
      
      // ✅ NEW: Filter old messages BEFORE processing
      // Only process append messages from the last 5 minutes (configurable)
      const APPEND_TIME_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
      const now = Date.now();
      
      const recentMessages = m.messages.filter(msg => {
        if (!msg.messageTimestamp) {
          // No timestamp = likely new message, keep it
          return true;
        }
        
        const messageTime = msg.messageTimestamp * 1000;
        const age = now - messageTime;
        
        if (age > APPEND_TIME_WINDOW_MS) {
          const ageMinutes = Math.round(age / 60000);
          console.log(`   ⏭️ Filtering old append message (age: ${ageMinutes} minutes)`);
          return false;
        }
        
        return true;
      });
      
      if (recentMessages.length === 0) {
        console.log(`   ⏭️ Skipping append event - all messages too old (older than 5 minutes)`);
        return;
      }
      
      console.log(`   ✅ Processing ${recentMessages.length}/${m.messages.length} recent append messages`);
      // Replace messages array with filtered recent messages
      m.messages = recentMessages;
    } else {
      console.log(`   ⏭️ Skipping ${m.type} event (unknown type)`);
      return;
    }

    let storedCount = 0;
    let skippedCount = 0;
    let duplicateCount = 0;

    const botPaused = await this.database.getSetting('bot_paused', this.cid) === 'true';
    console.log(`\n🔄 Processing ${m.messages.length} messages from ${m.type} event...${botPaused ? ' (bot paused — minimal logging)' : ''}`);

    for (const msg of m.messages) {
      try {
        // Skip if no message object
        if (!msg.message) {
          console.log('   ⏭️ Skipping - no message content');
          skippedCount++;
          continue;
        }

        // Skip protocol messages (deletions, reactions, read receipts, etc)
        if (msg.message.protocolMessage) {
          console.log('   ⏭️ Skipping protocol message');
          skippedCount++;
          continue;
        }

        // Get message timestamp - if missing, use current time (likely a new message)
        const hasTimestamp = !!msg.messageTimestamp;
        const messageTimestamp = msg.messageTimestamp 
          ? new Date(msg.messageTimestamp * 1000) 
          : new Date();
        
        if (!botPaused) console.log(`   ✅ Processing message (type: ${m.type}, timestamp: ${messageTimestamp.toISOString()}, fromMe: ${msg.key.fromMe}, hasTimestamp: ${hasTimestamp})`);

        const jid = msg.key.remoteJid;

        // Skip status broadcasts
        if (jid === 'status@broadcast') {
          console.log('   ⏭️ Skipping status broadcast');
          skippedCount++;
          continue;
        }

        // Skip group messages (remove this if you want groups)
        if (jid.endsWith('@g.us')) {
          console.log('   ⏭️ Skipping group message:', jid);
          skippedCount++;
          continue;
        }

        if (!botPaused) {
          console.log(`   📱 Message details:`);
          console.log(`      JID: ${jid}`);
          console.log(`      FromMe: ${msg.key.fromMe}`);
          console.log(`      MessageTimestamp: ${msg.messageTimestamp || 'none'}`);
        }

        // Extract phone number (handle both @s.whatsapp.net and @lid formats)
        // JID format: phone@s.whatsapp.net or phone:12@s.whatsapp.net or phone:agentId@lid — strip device so one lead per contact
        let phoneNumber = jid;
        if (jid.includes('@s.whatsapp.net')) {
          phoneNumber = jid.replace('@s.whatsapp.net', '');
        } else if (jid.includes('@lid')) {
          const beforeLid = jid.split('@lid')[0];
          phoneNumber = beforeLid.includes(':') ? beforeLid.split(':')[0] : beforeLid;
        } else {
          console.log('   ⏭️ Skipping - invalid JID format:', jid);
          continue;
        }
        if (phoneNumber.includes(':')) phoneNumber = phoneNumber.split(':')[0];

        if (!phoneNumber) {
          console.log('   ⏭️ Skipping - invalid phone number from JID:', jid);
          continue;
        }

        const normalizedPhone = this.database.normalizePhoneNumber(phoneNumber);
        if (!normalizedPhone) {
          console.log('   ⏭️ Skipping - invalid normalized phone number from JID:', jid);
          continue;
        }
        
        if (!botPaused) console.log(`   📱 Processing message from: ${normalizedPhone} (JID: ${jid})`);

        // Unwrap special message types
        let messageContent = msg.message;
        if (msg.message?.ephemeralMessage) {
          messageContent = msg.message.ephemeralMessage.message;
        }
        if (msg.message?.viewOnceMessage) {
          messageContent = msg.message.viewOnceMessage.message;
        }
        if (msg.message?.documentWithCaptionMessage) {
          messageContent = msg.message.documentWithCaptionMessage.message;
        }

        // Extract text from all message types
        let messageText = messageContent?.conversation || 
                         messageContent?.extendedTextMessage?.text || 
                         messageContent?.imageMessage?.caption ||
                         messageContent?.videoMessage?.caption ||
                         messageContent?.audioMessage?.caption ||
                         messageContent?.documentMessage?.caption ||
                         '';

        // Handle media without captions
        if (!messageText || !messageText.trim()) {
          if (messageContent?.imageMessage) {
            messageText = '[Image]';
          } else if (messageContent?.videoMessage) {
            messageText = '[Video]';
          } else if (messageContent?.audioMessage) {
            messageText = '[Audio]';
          } else if (messageContent?.documentMessage) {
            messageText = '[Document]';
          } else if (messageContent?.stickerMessage) {
            messageText = '[Sticker]';
          } else {
            console.log('   ⏭️ Skipping - no text content');
            continue;
          }
        }

        if (!botPaused) console.log(`   📝 Message text: "${messageText}"`);

        const getContactName = (contactJid) => {
          const c = this.sock?.contacts?.[contactJid];
          return c?.notify || c?.name || c?.pushName || null;
        };

        // Get pushName for both incoming and outgoing
        let pushName = msg.key.fromMe
          ? (getContactName(jid) || (jid.includes('@lid') ? getContactName(`${normalizedPhone}@s.whatsapp.net`) : null))
          : (msg.pushName || null);

        // If this is our own echoed message, pin it back to the exact lead used when sending.
        let pinnedLead = null;
        if (msg.key.fromMe && msg.key?.id) {
          const pinnedLeadId = this.sentMessageLeadMap.get(msg.key.id);
          if (pinnedLeadId) {
            pinnedLead = await this.database.getLead(pinnedLeadId, this.cid);
            this.sentMessageLeadMap.delete(msg.key.id);
            if (pinnedLead) {
              console.log(`   📌 fromMe upsert pinned to lead ${pinnedLead.id} via msgId ${msg.key.id}`);
            }
          }
        }

        // Find or create lead. On incoming: scan for same-contact leads and merge into one (fixes outgoing duplicate).
        const normalizedJid = this.database.normalizeJid(jid) || this.database.getCanonicalJid(normalizedPhone);
        const allForContact = await this.database.findAllLeadsForContact(normalizedPhone, normalizedJid, this.cid);
        let lead = null;
        let didMerge = false;

        if (allForContact.length > 1) {
          // Always merge duplicates; if we have a pinnedLead from sendManualMessage, prefer it as primary
          const fromJid = allForContact.find(l => l.jid && this.database.normalizeJid(l.jid) === normalizedJid);
          const preferredId = pinnedLead?.id || fromJid?.id || null;
          lead = await this.database.mergeLeads(allForContact, preferredId, this.cid);
          didMerge = true;
          if (normalizedJid) { lead.jid = normalizedJid; lead.updated_at = new Date().toISOString(); }
          if (normalizedPhone) { lead.phone_number = normalizedPhone; lead.updated_at = new Date().toISOString(); }
          if (lead.updated_at) await this.database.db.write();
          console.log(`   🔀 Merged ${allForContact.length} leads into one: ${lead.id} (phone: ${normalizedPhone}, JID: ${normalizedJid})`);
        } else if (allForContact.length === 1) {
          lead = allForContact[0];
        } else if (pinnedLead) {
          // No match found in DB lookup, but we have an explicit pin from the send path
          lead = pinnedLead;
        }

        if (!lead) {
          lead = await this.database.getLeadByPhone(normalizedPhone, this.cid);
          if (!lead) lead = await this.database.getLeadByJid(jid, this.cid);
        }
        if (!lead) {
          console.log(`   👤 Creating new lead for phone: ${normalizedPhone} (JID: ${normalizedJid})`);
          lead = await this.database.createLead(normalizedPhone, pushName, null, normalizedJid, this.cid);
          console.log(`   ✅ Created lead: ${lead.id} (phone: ${lead.phone_number}, JID: ${lead.jid})`);
        } else if (!didMerge) {
          console.log(`   ✅ Found existing lead: ${lead.id} (phone: ${lead.phone_number}, JID: ${lead.jid})`);
          if (normalizedJid && (!lead.jid || this.database.normalizeJid(lead.jid) !== normalizedJid)) {
            lead.jid = normalizedJid;
            lead.updated_at = new Date().toISOString();
            await this.database.db.write();
          }
          if (lead.phone_number !== normalizedPhone && normalizedPhone) {
            lead.phone_number = normalizedPhone;
            lead.updated_at = new Date().toISOString();
            await this.database.db.write();
          }
        }

        if (didMerge) this.emit('leads_changed');

        // Outgoing: retry pushName with canonical JID (lead may have phone with country code)
        if (msg.key.fromMe && !pushName) {
          const cj = this.database.getCanonicalJid(lead.phone_number, lead.jid || jid);
          if (cj) pushName = getContactName(cj);
        }
        console.log(`   👤 PushName: ${pushName || 'none'} (JID: ${jid}, fromMe: ${msg.key.fromMe})`);
        
        // Fetch contact info directly from WhatsApp - ensures correct mapping
        // This is important for BOTH incoming and outgoing messages
        // Update contact info BEFORE storing message so WebSocket event has latest data
        if (this.sock && this.isConnected) {
          try {
            let needsUpdate = false;
            let contactName = lead.contact_name;
            let profilePictureUrl = lead.profile_picture_url;
            
            const canonicalJid = this.database.getCanonicalJid(lead.phone_number, lead.jid || jid);
            const tryJids = [jid];
            if (canonicalJid && !tryJids.includes(canonicalJid)) tryJids.push(canonicalJid);
            for (const tryJid of tryJids) {
              if (this.sock.contacts?.[tryJid]) {
                const contactFromJid = this.sock.contacts[tryJid].notify ||
                                      this.sock.contacts[tryJid].name ||
                                      this.sock.contacts[tryJid].pushName ||
                                      null;
                if (contactFromJid && contactFromJid !== contactName) {
                  contactName = contactFromJid;
                  needsUpdate = true;
                  console.log(`   📝 Got contact name from WhatsApp contacts: "${contactName}" (JID: ${tryJid}, Phone: ${normalizedPhone})`);
                }
                break;
              }
            }
            
            // Use message pushName if we don't have a name from contacts
            if (!contactName && pushName) {
              contactName = pushName;
              needsUpdate = true;
              console.log(`   📝 Using message pushName: "${pushName}" (JID: ${jid}, Phone: ${normalizedPhone})`);
            }
            
            // Get profile picture directly from WhatsApp (async but don't wait)
            if (!profilePictureUrl) {
              this.sock.profilePictureUrl(jid, 'image').then(picUrl => {
                if (picUrl) {
                  console.log(`   🖼️ Fetched profile picture directly from WhatsApp for ${normalizedPhone}`);
                  const cj = this.database.getCanonicalJid(lead.phone_number, lead.jid || jid);
                  this.database.updateLeadContactInfo(lead.id, contactName || lead.contact_name, picUrl, cj, this.cid);
                }
              }).catch(() => {
                // Profile picture not available, skip
              });
            }
            
            const jidToStore = normalizedJid || this.database.getCanonicalJid(normalizedPhone);
            if (needsUpdate || (jidToStore && lead.jid !== jidToStore)) {
              await this.database.updateLeadContactInfo(lead.id, contactName || lead.contact_name, profilePictureUrl, jidToStore, this.cid);
              // Refresh lead to get updated data
              lead = await this.database.getLead(lead.id, this.cid);
              console.log(`   ✅ Updated lead ${lead.id} with contact info (Name: "${lead.contact_name}", Phone: ${normalizedPhone}, JID: ${jid})`);
            }
          } catch (infoError) {
            console.error(`   ⚠️ Error fetching contact info for ${phoneNumber}:`, infoError.message);
            // Continue even if contact info fetch fails
          }
        }

        // When paused: don't store messages, don't log to bot_logs, don't emit — saves DB and credits. Resumes when bot is resumed.
        if (botPaused) continue;

        // Check if message already exists (prevent duplicates)
        const existingMessages = await this.database.getMessagesByLead(lead.id, this.cid);
        const msgTimestamp = msg.messageTimestamp 
          ? new Date(msg.messageTimestamp * 1000).toISOString()
          : new Date().toISOString();
        
        const sender = msg.key.fromMe ? 'shield' : 'user';
        
        // More lenient duplicate detection - check content, sender, and timestamp (within 30 seconds)
        const msgExists = existingMessages.some(m => {
          const timeDiff = Math.abs(new Date(m.timestamp).getTime() - new Date(msgTimestamp).getTime());
          const isDuplicate = m.content === messageText && 
                              m.sender === sender &&
                              timeDiff < 30000; // Within 30 seconds (more lenient)
          
          if (isDuplicate && !botPaused) {
            console.log(`   🔍 Found duplicate: content match, sender match, time diff: ${Math.round(timeDiff/1000)}s`);
          }
          return isDuplicate;
        });
        
        if (msgExists) {
          if (!botPaused) console.log('   ⏭️ Skipping duplicate message');
          duplicateCount++;
          continue;
        }
        
        if (!botPaused) console.log(`   ✅ Message is new - not a duplicate`);

        // Store message
        if (!botPaused) console.log('   💾 Storing message...');
        const savedMessage = await this.database.createMessage(
          lead.id, 
          sender, 
          messageText, 
          sender === 'shield' ? 'replied' : 'pending',
          msgTimestamp, // Pass message timestamp to update lead's updated_at
          this.cid
        );
        
        storedCount++;
        if (!botPaused) console.log(`   ✅ Message stored successfully!`);

        // Always refresh lead to get latest data (including contact info) before emitting WebSocket event
        const updatedLead = await this.database.getLead(lead.id, this.cid);
        if (!botPaused) {
          console.log(`   📋 Lead data: ${updatedLead.contact_name || updatedLead.phone_number} (${updatedLead.phone_number})`);
          console.log(`   📋 Lead JID: ${updatedLead.jid || 'none'}`);
          console.log(`   📡 Preparing WebSocket event: new_message`);
          console.log(`      - Sender: ${sender} (fromMe: ${msg.key.fromMe})`);
          console.log(`      - LeadId: ${lead.id}`);
          console.log(`      - Contact: ${updatedLead.contact_name || updatedLead.phone_number}`);
          console.log(`      - Message: "${messageText.substring(0, 50)}${messageText.length > 50 ? '...' : ''}"`);
        }
        
        // Emit WebSocket event for new message (multi-tenant: only this account's sockets)
        try {
          const eventData = {
            leadId: lead.id,
            message: {
              id: savedMessage.id,
              lead_id: lead.id,
              sender,
              content: messageText,
              status: sender === 'shield' ? 'replied' : 'pending',
              timestamp: msgTimestamp
            },
            lead: updatedLead
          };
          if (!botPaused) console.log(`   📤 Emitting new_message to this account only`);
          this.emit('new_message', eventData);
          this.emit('leads_changed');
          if (!botPaused) console.log(`   ✅ WebSocket events emitted`);
        } catch (emitError) {
          console.error(`   ❌ Error emitting WebSocket events:`, emitError);
          console.error(`   Stack:`, emitError.stack);
        }

        // Only auto-reply for NEW incoming messages from users (not historical, not from us)
        // Process both 'notify' and 'append' messages (append messages are already filtered by timestamp above)
        // If we got here, the message passed the timestamp filter, so it's recent
        const isRecentMessage = true; // Message already passed timestamp filtering
        
        if (isRecentMessage && sender === 'user') {
          const autoReplyEnabled = await this.database.getSetting('auto_reply_enabled', this.cid) === 'true';
          const botPaused = await this.database.getSetting('bot_paused', this.cid) === 'true';

          if (autoReplyEnabled && !botPaused) {
            const keywordReply = await this.getKeywordReply(messageText);
            if (keywordReply) {
              this.messageQueue.add(async () => { await this.sendKeywordReply(lead, phoneNumber, keywordReply, msg.key); });
              if (!botPaused) await this.database.addLog('message_received', { phoneNumber, leadId: lead.id }, this.cid);
              continue;
            }
            // No keyword match: do not send any message (no AI, no acknowledgement)
          }

          if (!botPaused) await this.database.addLog('message_received', { phoneNumber, leadId: lead.id }, this.cid);
        }

      } catch (error) {
        console.error('   ❌ Error processing message:', error);
      }
    }

    if (!botPaused) {
      console.log(`\n📊 Message Processing Summary:`);
      console.log(`   - Total messages in event: ${m.messages.length}`);
      console.log(`   - Stored: ${storedCount}`);
      console.log(`   - Skipped (filters): ${skippedCount}`);
      console.log(`   - Duplicates: ${duplicateCount}`);
      if (storedCount > 0) console.log(`\n✅ Successfully stored ${storedCount} new message(s)`);
      else if (duplicateCount > 0) console.log(`\n⏭️ All messages were duplicates (already processed)`);
      else if (skippedCount > 0) console.log(`\n⏭️ All messages were filtered (status/groups/old)`);
    } else {
      console.log(`   ⏸️ Bot paused — no message storage or logging until resumed`);
    }
  }

  /**
   * Mark a message as read so the user's main phone shows the chat as read/replied.
   * Call this when we receive an incoming user message and are about to (or have) replied.
   */
  async sendReadReceipt(messageKey) {
    if (!this.sock || !this.isConnected || !messageKey) return;
    if (messageKey.fromMe) return;
    try {
      const key = {
        remoteJid: messageKey.remoteJid,
        id: messageKey.id,
        fromMe: messageKey.fromMe
      };
      await this.sock.readMessages([key]);
    } catch (err) {
      console.error('   ⚠️ Could not send read receipt:', err.message);
    }
  }

  async getKeywordReply(text) {
    const raw = await this.database.getSetting('keyword_replies', this.cid);
    let list = [];
    try {
      list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    } catch {
      return null;
    }
    const normalized = (text || '').trim().toLowerCase();
    if (!normalized) return null;
    const entry = list.find(e => (e.keyword || '').trim().toLowerCase() === normalized);
    if (!entry) return null;
    const replyType = entry.replyType === 'audio' ? 'audio' : 'text';
    return {
      message: (entry.message || '').trim(),
      replyType,
      audioId: replyType === 'audio' ? (entry.audioId || null) : null
    };
  }

  async sendKeywordReply(lead, phoneNumber, reply, messageKey) {
    const phone = lead.phone_number || phoneNumber;
    const sendJid = this.database.getCanonicalJid(phone, lead?.jid || null) || `${phone}@s.whatsapp.net`;
    const normalizedJid = jidNormalizedUser(sendJid);

    // 1) View delay: wait before marking as read (human-like: don't view instantly)
    const viewMin = parseInt(await this.database.getSetting('view_delay_min_seconds', this.cid) || '1');
    const viewMax = parseInt(await this.database.getSetting('view_delay_max_seconds', this.cid) || '5');
    const viewDelay = Math.max(0, Math.floor(Math.random() * (Math.max(viewMax - viewMin, 0) + 1)) + viewMin);
    await new Promise(r => setTimeout(r, viewDelay * 1000));
    if (messageKey) await this.sendReadReceipt(messageKey);

    // 2) Reply delay: wait before replying (existing human-like delay)
    const minDelay = parseInt(await this.database.getSetting('min_delay_seconds', this.cid) || '3');
    const maxDelay = parseInt(await this.database.getSetting('max_delay_seconds', this.cid) || '10');
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    await new Promise(r => setTimeout(r, delay * 1000));

    const isAudio = reply.replyType === 'audio';

    // 3) Presence indicator before sending:
    // - text => "typing..."
    // - audio => "recording audio..." (gray WhatsApp-style)
    const typingEnabled = (await this.database.getSetting('typing_indicator_enabled', this.cid) || 'true') === 'true';
    if (typingEnabled && this.sock) {
      try {
        await this.sock.sendPresenceUpdate(isAudio ? 'recording' : 'composing', normalizedJid);
        const previewSec = isAudio
          ? 2 + Math.random() * 2
          : Math.min(3, 1 + (reply.message || '').length / 50 * 0.5 + Math.random() * 2);
        await new Promise(r => setTimeout(r, Math.max(1000, previewSec * 1000)));
      } catch (_) {}
    }

    if (isAudio) {
      const relativePath = await this.getAudioPathById(reply.audioId);
      if (!relativePath) {
        console.error('sendKeywordReply: no audio path for audioId', reply.audioId);
        if (reply.message && reply.message.trim()) {
          await this.sendMessage(sendJid, reply.message.trim());
          await this.database.addLog('keyword_reply_audio_fallback_text', {
            phoneNumber,
            leadId: lead.id,
            reason: 'missing_audio_path',
            audioId: reply.audioId
          }, this.cid);
        }
        return;
      }
      const dataDir = join(__dirname, 'data');
      const fullPath = join(dataDir, relativePath.replace(/\\/g, '/'));
      if (!existsSync(fullPath)) {
        console.error('sendKeywordReply: audio file not found', fullPath);
        if (reply.message && reply.message.trim()) {
          await this.sendMessage(sendJid, reply.message.trim());
          await this.database.addLog('keyword_reply_audio_fallback_text', {
            phoneNumber,
            leadId: lead.id,
            reason: 'audio_file_not_found',
            audioId: reply.audioId,
            path: relativePath
          }, this.cid);
        }
        return;
      }
      try {
        await this.sendAudioMessage(sendJid, fullPath);
      } catch (err) {
        console.error('sendKeywordReply: sendAudioMessage failed', err.message);
        throw err;
      }
    } else {
      await this.sendMessage(sendJid, reply.message || '');
    }

    // Stop typing indicator
    if (typingEnabled && this.sock) {
      try { await this.sock.sendPresenceUpdate('paused', normalizedJid); } catch (_) {}
    }
    const timestamp = new Date().toISOString();
    const content = isAudio ? '[Audio]' : (reply.message || '');
    const savedMessage = await this.database.createMessage(lead.id, 'shield', content, 'replied', timestamp, this.cid);
    await this.database.incrementReplyCount(lead.id, this.cid);
    const updatedLead = await this.database.getLead(lead.id, this.cid);
    if (this.io) {
      this.emit('new_message', { leadId: lead.id, message: { id: savedMessage.id, lead_id: lead.id, sender: 'shield', content, status: 'replied', timestamp: savedMessage.timestamp }, lead: updatedLead });
      this.emit('leads_changed');
    }
    await this.database.addLog('keyword_reply_sent', { phoneNumber, leadId: lead.id, type: isAudio ? 'audio' : 'text' }, this.cid);
  }

  async getAudioPathById(audioId) {
    if (!audioId) return null;
    const raw = await this.database.getSetting('saved_audios', this.cid);
    let list = [];
    try {
      list = typeof raw === 'string' ? JSON.parse(raw || '[]') : (raw || []);
    } catch {
      return null;
    }
    const entry = list.find(a => String(a.id) === String(audioId));
    return entry ? entry.path : null;
  }

  /**
   * Convert audio to OGG Opus (48kHz mono) so WhatsApp/Android can play it.
   * Returns Buffer or null if ffmpeg is missing or conversion fails.
   */
  convertToOggOpus(inputPath) {
    return new Promise((resolve) => {
      const outPath = join(tmpdir(), `shield-audio-${Date.now()}-${Math.random().toString(36).slice(2)}.ogg`);
      const args = [
        '-i', inputPath,
        '-c:a', 'libopus',
        '-ar', '48000',
        '-ac', '1',
        '-application', 'voip',
        '-avoid_negative_ts', 'make_zero',
        '-y', outPath
      ];
      const ffmpegPath = ffmpegInstaller.path;
      const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      proc.stderr?.on('data', (d) => { stderr += d.toString(); });
      proc.on('close', (code) => {
        if (code !== 0) {
          try { if (existsSync(outPath)) unlinkSync(outPath); } catch (_) {}
          if (code !== null) console.warn('sendAudioMessage: ffmpeg conversion failed, sending original. Exit:', code);
          resolve(null);
          return;
        }
        try {
          const buf = readFileSync(outPath);
          unlinkSync(outPath);
          resolve(buf.length > 0 ? buf : null);
        } catch (e) {
          try { if (existsSync(outPath)) unlinkSync(outPath); } catch (_) {}
          resolve(null);
        }
      });
      proc.on('error', (err) => {
        try { if (existsSync(outPath)) unlinkSync(outPath); } catch (_) {}
        console.warn('sendAudioMessage: ffmpeg not available, sending original.', err?.message || '');
        resolve(null);
      });
    });
  }

  async sendAudioMessage(jid, fullPath) {
    if (!this.sock || !this.isConnected) throw new Error('WhatsApp not connected');
    if (!fullPath || typeof fullPath !== 'string') throw new Error('sendAudioMessage: fullPath required');
    if (!existsSync(fullPath)) throw new Error(`sendAudioMessage: file not found: ${fullPath}`);
    const normalizedJid = jidNormalizedUser(jid);
    let audioBuffer = null;
    let mimetype = 'audio/ogg; codecs=opus';
    const converted = await this.convertToOggOpus(fullPath);
    if (converted && converted.length > 0) {
      audioBuffer = converted;
    } else {
      const ext = (fullPath.split('.').pop() || '').toLowerCase();
      mimetype = ext === 'mp3' ? 'audio/mpeg' : 'audio/ogg; codecs=opus';
      audioBuffer = readFileSync(fullPath);
    }
    if (!audioBuffer || audioBuffer.length === 0) throw new Error('sendAudioMessage: empty file');
    const content = {
      audio: audioBuffer,
      mimetype,
      ptt: true
    };
    try {
      const result = await this.sock.sendMessage(normalizedJid, content);
      await new Promise(r => setTimeout(r, 100));
      return result;
    } catch (err) {
      console.error('sendAudioMessage error:', err.message);
      throw err;
    }
  }

  async sendAutoReply(lead, phoneNumber) {
    try {
      const productInfo = await this.database.getProductInfo(this.cid);
      const primaryLink = await this.database.getSetting('primary_link', this.cid) || 'https://example.com';
      const backupLink = await this.database.getSetting('backup_link', this.cid) || '';
      const minDelay = parseInt(await this.database.getSetting('min_delay_seconds', this.cid) || '3');
      const maxDelay = parseInt(await this.database.getSetting('max_delay_seconds', this.cid) || '10');
      
      // ✅ MERGED: Get API key and model (always fetch, will use if auto-reply is enabled)
      // When auto-reply is enabled, automatically use AI if API key is configured
      const openrouterApiKey = process.env.OPENROUTER_API_KEY || await this.database.getSetting('openrouter_api_key', this.cid);
      const aiModel = process.env.AI_MODEL || await this.database.getSetting('ai_model', this.cid) || 'anthropic/claude-opus-4.6';

      // Random delay
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await new Promise(resolve => setTimeout(resolve, delay * 1000));

      let message;

      // ✅ MERGED: Use AI if API key exists (auto-reply is already checked before calling this function)
      // When auto-reply is enabled, automatically use AI if configured (no separate ai_enabled check)
      if (openrouterApiKey && openrouterApiKey.trim() !== '') {
        try {
          // Get last user message for context
          const messages = await this.database.getMessagesByLead(lead.id, this.cid);
          const lastUserMessage = messages.filter(m => m.sender === 'user').pop();
          const userMessage = lastUserMessage?.content || 'Hello';

          // Use AI to generate natural response using product information
          message = await this.generateAIResponse(userMessage, productInfo, openrouterApiKey, aiModel, primaryLink, backupLink);
        } catch (aiError) {
          console.error('AI response failed:', aiError);
          message = 'Thanks for your message!';
        }
      } else {
        // AI disabled - simple response
        message = 'Thanks for your message!';
      }

      const jid = this.database.getCanonicalJid(lead.phone_number || phoneNumber, lead?.jid || null) || `${phoneNumber}@s.whatsapp.net`;
      await this.sendMessage(jid, message);

      // Update database
      const timestamp = new Date().toISOString();
      const savedMessage = await this.database.createMessage(lead.id, 'shield', message, 'replied', timestamp, this.cid);
      await this.database.incrementReplyCount(lead.id, this.cid);

      // Emit WebSocket event for auto-reply (multi-tenant: this account only)
      const updatedLead = await this.database.getLead(lead.id, this.cid);
      this.emit('new_message', {
        leadId: lead.id,
        message: {
          id: savedMessage.id,
          lead_id: lead.id,
          sender: 'shield',
          content: message,
          status: 'replied',
          timestamp: savedMessage.timestamp
        },
        lead: updatedLead
      });
      this.emit('leads_changed');
      console.log(`   ✅ Auto-reply WebSocket events emitted`);

      await this.database.addLog('auto_reply_sent', { phoneNumber, leadId: lead.id, jid, replyCount: lead.reply_count + 1 }, this.cid);
    } catch (error) {
      console.error('Error sending auto-reply:', error);
      await this.database.addLog('error', { error: error.message, context: 'sendAutoReply' }, this.cid);
    }
  }

  /**
   * Generate AI response using product information
   */
  async generateAIResponse(userMessage, productInfo, apiKey, model = 'openai/gpt-3.5-turbo', primaryLink, backupLink) {
    const prompt = `You are a helpful WhatsApp assistant. A customer sent this message: "${userMessage}"

${productInfo ? `Product Information:
${productInfo}

` : ''}Available links:
- Primary link: ${primaryLink}
${backupLink ? `- Backup link: ${backupLink}` : ''}

Instructions:
- Respond naturally and helpfully to the customer's message
- ${productInfo ? 'Use the product information above to answer questions about the product/service' : 'Be friendly and professional'}
- ${primaryLink ? 'If relevant, you can mention the primary link naturally in your response' : ''}
- Keep responses concise and conversational
- Do NOT use placeholders like {{link}} - include the actual link URL if needed

Respond naturally as a helpful assistant:`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://shield-whatsapp-bot.com',
        'X-Title': 'Shield WhatsApp Bot'
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 300,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  async generateNaturalResponse(userMessage, apiKey, model) {
    const prompt = `You are a friendly WhatsApp assistant chatting with a customer. They said: "${userMessage}"

Respond naturally and human-like, as if you're having a casual conversation. Be friendly, helpful, and conversational. Keep it short (1-2 sentences max). Don't mention any links or products unless they specifically ask about them.`;

    const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://shield-whatsapp-bot.com',
        'X-Title': 'Shield WhatsApp Bot'
      },
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 150,
        temperature: 0.8,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.choices[0].message.content.trim();
  }

  async sendMessage(jid, message) {
    if (!this.sock || !this.isConnected) {
      throw new Error('WhatsApp not connected');
    }
    
    // Send message and wait for confirmation
    try {
      const result = await this.sock.sendMessage(jid, { text: message });
      // Small delay to ensure message is processed
      await new Promise(resolve => setTimeout(resolve, 100));
      return result;
    } catch (error) {
      console.error('Error sending message:', error);
      throw error;
    }
  }

  async sendManualMessage(phoneNumber, message, io, leadId = null) {
    try {
      // Normalize phone number using database method
      let normalizedPhone = this.database.normalizePhoneNumber(phoneNumber);
      console.log(`📤 Sending to: ${normalizedPhone}`);

      // If request came from an existing chat, pin to that lead first (prevents new lead IDs on reply)
      let lead = null;
      if (leadId) {
        lead = await this.database.getLead(leadId, this.cid);
        if (lead) {
          const pinnedPhone = this.database.normalizePhoneNumber(lead.phone_number);
          if (pinnedPhone) normalizedPhone = pinnedPhone;
          console.log(`   📌 Using pinned lead: ${lead.id} (${lead.phone_number})`);
        }
      }

      const defaultJid = this.database.getCanonicalJid(normalizedPhone);

      // Fallback lookup path when leadId is not provided/found
      if (!lead) {
        // Same order as message handler: phone first, then JID — avoids duplicate when user messages first
        lead = await this.database.getLeadByPhone(normalizedPhone, this.cid);
        if (!lead) {
          lead = await this.database.getLeadByJid(defaultJid, this.cid);
        }
      }
      const jidToUse = this.database.getCanonicalJid(normalizedPhone, lead?.jid || null) || defaultJid;
      if (!lead) {
        lead = await this.database.createLead(normalizedPhone, null, null, jidToUse, this.cid);
        console.log(`   ✅ Created lead: ${lead.id} (JID: ${lead.jid})`);
      } else {
        if (jidToUse && (!lead.jid || this.database.normalizeJid(lead.jid) !== this.database.normalizeJid(jidToUse))) {
          lead.jid = jidToUse;
          lead.updated_at = new Date().toISOString();
          await this.database.db.write();
        }
        if (normalizedPhone && lead.phone_number !== normalizedPhone) {
          lead.phone_number = normalizedPhone;
          lead.updated_at = new Date().toISOString();
          await this.database.db.write();
        }
      }

      console.log(`   📱 JID: ${jidToUse}`);
      
      const sendResult = await this.sendMessage(jidToUse, message);
      const sentMsgId = sendResult?.key?.id || sendResult?.id || null;
      if (sentMsgId) {
        this.sentMessageLeadMap.set(sentMsgId, lead.id);
        setTimeout(() => this.sentMessageLeadMap.delete(sentMsgId), 5 * 60 * 1000);
        console.log(`   🧷 Pinned sent msgId ${sentMsgId} -> lead ${lead.id}`);
      }
      console.log(`   ✅ Sent to lead ${lead.id}`);
      
      const timestamp = new Date().toISOString();
      
      // Deduplicate: don't store if same message arrived via messages.upsert in last 30s
      const existingMessages = await this.database.getMessagesByLead(lead.id, this.cid);
      const alreadyExists = existingMessages.some(
        m =>
          m.content === message &&
          m.sender === 'shield' &&
          Math.abs(new Date(m.timestamp).getTime() - new Date(timestamp).getTime()) < 30000
      );
      
      let savedMessage = null;
      if (!alreadyExists) {
        savedMessage = await this.database.createMessage(lead.id, 'shield', message, 'replied', timestamp, this.cid);
      } else {
        // Message already exists, find it to get the real ID
        const existingMessages = await this.database.getMessagesByLead(lead.id, this.cid);
        savedMessage = existingMessages.find(
          m =>
            m.content === message &&
            m.sender === 'shield' &&
            Math.abs(new Date(m.timestamp).getTime() - new Date(timestamp).getTime()) < 30000
        );
      }
      
      await this.database.incrementReplyCount(lead.id, this.cid);

      // Always fetch fresh lead after writing so the payload is up to date
      const updatedLead = await this.database.getLead(lead.id, this.cid);

      // Multi-tenant: emit only to this account's sockets
      if (savedMessage) {
        this.emit('new_message', {
          leadId: lead.id,
          message: {
            id: savedMessage.id,
            lead_id: lead.id,
            sender: 'shield',
            content: message,
            status: 'replied',
            timestamp: savedMessage.timestamp,
          },
          lead: updatedLead,
        });
        this.emit('leads_changed');
        console.log(`   📡 new_message emitted for lead ${lead.id}`);
      }

      await this.database.addLog('manual_reply_sent', { phoneNumber: normalizedPhone, leadId: lead.id, jid: jidToUse }, this.cid);
      return { success: true, leadId: lead.id };
    } catch (error) {
      console.error('❌ sendManualMessage error:', error);
      await this.database.addLog('error', { error: error.message, context: 'sendManualMessage' }, this.cid);
      throw error;
    }
  }

  /**
   * Handle chats update from WhatsApp - stores immediately
   */
  async handleChatsUpdate(chats) {
    if (!chats || !Array.isArray(chats)) return;
    if (Date.now() < this.skipContactLeadCreationUntil) {
      console.log('   ⏭️ Skipping chats update - fresh connect clear window');
      return;
    }

    try {
      console.log(`📱 Received ${chats.length} chats from WhatsApp - storing with names and images...`);
      let contactsLoaded = 0;
      let contactsWithInfo = 0;

      for (const chat of chats) {
        try {
          const jid = chat.id;
          if (!jid || jid.includes('@g.us')) continue; // Skip groups
          
          // Extract phone number (same as message handler: phone only for @lid so one lead per contact)
          let phoneNumber = jid;
          if (jid.includes('@s.whatsapp.net')) {
            phoneNumber = jid.replace('@s.whatsapp.net', '');
          } else if (jid.includes('@lid')) {
            const beforeLid = jid.split('@lid')[0];
            phoneNumber = beforeLid.includes(':') ? beforeLid.split(':')[0] : beforeLid;
          } else {
            continue; // Skip invalid JID format
          }
          
          if (!phoneNumber) continue;
          
          // Normalize phone number
          const normalizedPhone = this.database.normalizePhoneNumber(phoneNumber);
          if (!normalizedPhone) continue;

          // Get or create lead using JID first (most accurate), then phone number
          let lead = await this.database.getLeadByJid(jid, this.cid);
          if (!lead) {
            lead = await this.database.getLeadByPhone(normalizedPhone, this.cid);
          }
          const jidToStore = this.database.getCanonicalJid(normalizedPhone);
          if (!lead) {
            lead = await this.database.createLead(normalizedPhone, null, null, jidToStore, this.cid);
          } else if (jidToStore && !lead.jid) {
            lead.jid = jidToStore;
            await this.database.db.write();
          }

          // Fetch contact name and profile picture directly from WhatsApp
          // This ensures correct mapping without relying on cached contacts
          if (this.sock && this.isConnected) {
            try {
              let contactName = lead.contact_name;
              let profilePictureUrl = lead.profile_picture_url;
              let needsUpdate = false;

              // Fetch contact information directly from WhatsApp using onWhatsApp
              try {
                const contactInfo = await this.sock.onWhatsApp(jid);
                if (contactInfo && contactInfo.length > 0) {
                  const contact = contactInfo[0];
                  // Get contact name directly from WhatsApp response
                  const directContactName = contact?.notify || contact?.name || null;
                  
                  if (directContactName && directContactName !== contactName) {
                    contactName = directContactName;
                    needsUpdate = true;
                    console.log(`   📝 Updated contact name directly from WhatsApp: ${contactName} (JID: ${jid}, Phone: ${normalizedPhone})`);
                  }
                }
              } catch (onWhatsAppError) {
                // Fallback to contacts cache if direct fetch fails
                if (this.sock.contacts && this.sock.contacts[jid]) {
                  const newContactName = this.sock.contacts[jid].notify || 
                                        this.sock.contacts[jid].name || 
                                        this.sock.contacts[jid].pushName || 
                                        null;
                  if (newContactName && newContactName !== contactName) {
                    contactName = newContactName;
                    needsUpdate = true;
                    console.log(`   📝 Updated contact name from cache: ${contactName} (JID: ${jid}, Phone: ${normalizedPhone})`);
                  }
                }
              }
              
              // Get profile picture directly from WhatsApp
              if (!profilePictureUrl) {
                try {
                  profilePictureUrl = await this.sock.profilePictureUrl(jid, 'image');
                  if (profilePictureUrl) {
                    needsUpdate = true;
                    console.log(`   🖼️ Fetched profile picture directly from WhatsApp for ${normalizedPhone}`);
                  }
                } catch (picError) {
                  // Profile picture not available, skip
                }
              }

              const jidToStore = this.database.getCanonicalJid(normalizedPhone);
              if (needsUpdate) {
                await this.database.updateLeadContactInfo(lead.id, contactName, profilePictureUrl, jidToStore, this.cid);
                contactsWithInfo++;
              } else if (jidToStore && lead.jid !== jidToStore) {
                await this.database.updateLeadContactInfo(lead.id, lead.contact_name, lead.profile_picture_url, jidToStore, this.cid);
              } else if (contactName || profilePictureUrl) {
                contactsWithInfo++; // Count existing info
              }
            } catch (infoError) {
              // Skip if we can't fetch contact info
            }
          }

          contactsLoaded++;
        } catch (chatError) {
          // Skip individual chat errors silently
        }
      }

      if (contactsLoaded > 0) {
        console.log(`✅ Stored ${contactsLoaded} contacts in database (${contactsWithInfo} with names/images)`);
        await this.database.addLog('chats_synced', { contacts: contactsLoaded, withInfo: contactsWithInfo }, this.cid);
      }
    } catch (error) {
      console.error('Error processing chats update:', error);
      await this.database.addLog('error', { error: error.message, context: 'handleChatsUpdate' }, this.cid);
    }
  }

  /**
   * Store messages from messages.upsert event (backup method - not actively used)
   * Primary handling is in handleIncomingMessage()
   */
  async storeMessagesFromUpsert(m) {
    // This is a backup method - primary handling is done in handleIncomingMessage()
    // Only process 'notify' type (real-time messages)
    if (!m || !m.messages || !Array.isArray(m.messages) || m.type !== 'notify') return;
    if (!this.connectionTime) return;

    try {
      let messagesStored = 0;

      for (const msg of m.messages) {
        try {
          const remoteJid = msg.key?.remoteJid;
          if (!remoteJid || remoteJid.includes('@g.us') || remoteJid === 'status@broadcast') continue;
          
          let phoneNumber = remoteJid;
          if (remoteJid.includes('@s.whatsapp.net')) {
            phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
          } else if (remoteJid.includes('@lid')) {
            const beforeLid = remoteJid.split('@lid')[0];
            phoneNumber = beforeLid.includes(':') ? beforeLid.split(':')[0] : beforeLid;
          } else {
            continue;
          }
          
          if (!phoneNumber) continue;
          const normalizedPhone = this.database.normalizePhoneNumber(phoneNumber);
          if (!normalizedPhone) continue;

          const messageText = msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption ||
                            '[Media]';

          if (!messageText || messageText.trim() === '') continue;

          const jidToStore = this.database.getCanonicalJid(normalizedPhone);
          let lead = await this.database.getLeadByJid(remoteJid, this.cid);
          if (!lead) lead = await this.database.getLeadByPhone(normalizedPhone, this.cid);
          if (!lead) {
            lead = await this.database.createLead(normalizedPhone, null, null, jidToStore, this.cid);
          } else if (jidToStore && !lead.jid) {
            lead.jid = jidToStore;
            await this.database.db.write();
          }

          const existingMessages = await this.database.getMessagesByLead(lead.id, this.cid);
          const msgTimestamp = msg.messageTimestamp 
            ? new Date(msg.messageTimestamp * 1000).toISOString()
            : new Date().toISOString();
          
          const msgExists = existingMessages.some(m => 
            m.content === messageText && m.timestamp === msgTimestamp
          );
          if (msgExists) continue;

          const sender = msg.key?.fromMe ? 'shield' : 'user';
          await this.database.createMessage(
            lead.id, sender, messageText,
            sender === 'shield' ? 'replied' : 'pending',
            msgTimestamp,
            this.cid
          );
          messagesStored++;
        } catch (msgError) {
          // Skip individual message errors
        }
      }

      if (messagesStored > 0) {
        console.log(`✅ Stored ${messagesStored} messages via backup handler`);
      }
    } catch (error) {
      console.error('Error storing messages from upsert:', error);
    }
  }

  /**
   * Handle contacts update from WhatsApp
   */
  async handleContactsUpdate(contacts) {
    if (Date.now() < this.skipContactLeadCreationUntil) {
      console.log('   ⏭️ Skipping contacts update - fresh connect clear window');
      return;
    }
    if (!contacts || typeof contacts !== 'object') return;

    try {
      console.log(`📇 Received contacts from WhatsApp - fetching phone, name, and profile pictures...`);
      let contactsStored = 0;
      let contactsWithInfo = 0;

      for (const [jid, contact] of Object.entries(contacts)) {
        try {
          if (!jid || jid.includes('@g.us')) continue; // Skip groups
          
          // Extract phone number (same as message handler: phone only for @lid so one lead per contact)
          let phoneNumber = jid;
          if (jid.includes('@s.whatsapp.net')) {
            phoneNumber = jid.replace('@s.whatsapp.net', '');
          } else if (jid.includes('@lid')) {
            const beforeLid = jid.split('@lid')[0];
            phoneNumber = beforeLid.includes(':') ? beforeLid.split(':')[0] : beforeLid;
          } else {
            continue; // Skip invalid JID format
          }
          
          if (!phoneNumber) continue;
          
          // Normalize phone number
          const normalizedPhone = this.database.normalizePhoneNumber(phoneNumber);
          if (!normalizedPhone) continue;
          
          // Fetch contact information directly from WhatsApp using exact JID
          // This ensures correct mapping even if multiple contacts have similar phone numbers
          let contactName = null;
          let profilePictureUrl = null;
          
          // Fetch directly from WhatsApp - use exact JID to get correct contact
          if (this.sock && this.isConnected) {
            // Verify contact exists on WhatsApp and get info directly
            try {
              // First verify the contact exists on WhatsApp using exact JID
              const contactExists = await this.sock.onWhatsApp(jid);
              if (contactExists && contactExists.length > 0 && contactExists[0].exists) {
                // Get contact name from contacts object using exact JID (most reliable)
                // This ensures we get the correct name for the correct contact
                if (this.sock.contacts && this.sock.contacts[jid]) {
                  contactName = this.sock.contacts[jid].notify || 
                               this.sock.contacts[jid].name || 
                               this.sock.contacts[jid].pushName || 
                               null;
                  console.log(`   📝 Got contact name directly from WhatsApp: "${contactName}" (JID: ${jid})`);
                }
              }
            } catch (onWhatsAppError) {
              // If onWhatsApp fails, use contact object directly (still from WhatsApp)
              if (this.sock.contacts && this.sock.contacts[jid]) {
                contactName = this.sock.contacts[jid].notify || 
                             this.sock.contacts[jid].name || 
                             this.sock.contacts[jid].pushName ||
                             null;
              }
            }
            
            // Fetch profile picture directly from WhatsApp using exact JID
            try {
              profilePictureUrl = await this.sock.profilePictureUrl(jid, 'image');
            } catch (picError) {
              // Profile picture not available, skip
            }
          } else {
            // Fallback to contact object if socket not available
            contactName = contact?.notify || contact?.name || contact?.pushName || null;
          }
          
          // Get or create lead using JID first (most accurate), then phone number
          let lead = await this.database.getLeadByJid(jid, this.cid);
          if (!lead) {
            lead = await this.database.getLeadByPhone(normalizedPhone, this.cid);
          }
          
          const jidToStore = this.database.getCanonicalJid(normalizedPhone);
          if (!lead) {
            lead = await this.database.createLead(normalizedPhone, contactName, profilePictureUrl, jidToStore, this.cid);
            console.log(`   ✅ Created lead with JID: ${lead.id} (Phone: ${normalizedPhone}, JID: ${lead.jid})`);
          } else {
            if (jidToStore && !lead.jid) {
              lead.jid = jidToStore;
              await this.database.db.write();
            }
            if (contactName && contactName !== lead.contact_name) {
              await this.database.updateLeadContactInfo(lead.id, contactName, null, jidToStore, this.cid);
              console.log(`   📝 Updated contact name directly from WhatsApp: "${contactName}" (Phone: ${normalizedPhone}, JID: ${jidToStore})`);
            }
          }
          if (profilePictureUrl && profilePictureUrl !== lead.profile_picture_url) {
            await this.database.updateLeadContactInfo(lead.id, lead.contact_name, profilePictureUrl, jidToStore, this.cid);
            console.log(`   🖼️ Updated profile picture directly from WhatsApp for ${normalizedPhone} (JID: ${jidToStore})`);
          }
          
          if (contactName || profilePictureUrl) {
            contactsWithInfo++;
          }

          contactsStored++;
        } catch (contactError) {
          console.error(`   ❌ Error processing contact ${jid}:`, contactError.message);
        }
      }

      if (contactsStored > 0) {
        console.log(`✅ Processed ${contactsStored} contacts (${contactsWithInfo} with profile pictures)`);
        await this.database.addLog('contacts_synced', { contacts: contactsStored, withPictures: contactsWithInfo }, this.cid);
      }
    } catch (error) {
      console.error('Error processing contacts update:', error);
    }
  }

  /**
   * Refresh all contact names directly from WhatsApp
   * This ensures correct pushName assignment for all existing leads
   */
  async refreshAllContactNames() {
    if (!this.sock || !this.isConnected) {
      console.log('⚠️ Cannot refresh contact names - not connected to WhatsApp');
      return { success: false, error: 'Not connected to WhatsApp' };
    }

    try {
      console.log('🔄 Refreshing all contact names directly from WhatsApp...');
      const allLeads = await this.database.getAllLeads(null, this.cid);
      let updated = 0;
      let errors = 0;

      for (const lead of allLeads) {
        try {
          const jid = this.database.getCanonicalJid(lead.phone_number) || `${lead.phone_number}@s.whatsapp.net`;
          
          // Fetch contact info directly from WhatsApp using exact JID
          let contactName = null;
          let profilePictureUrl = lead.profile_picture_url;

          try {
            // Verify contact exists and get info using exact JID
            const contactInfo = await this.sock.onWhatsApp(jid);
            if (contactInfo && contactInfo.length > 0 && contactInfo[0].exists) {
              // Get contact name from contacts object using exact JID (most reliable)
              // This ensures we get the correct name for the correct contact
              if (this.sock.contacts && this.sock.contacts[jid]) {
                contactName = this.sock.contacts[jid].notify || 
                             this.sock.contacts[jid].name || 
                             this.sock.contacts[jid].pushName || 
                             null;
                console.log(`   📝 Fetched contact name: "${contactName}" for JID: ${jid}`);
              }
              
              // Also try to get profile picture if missing
              if (!profilePictureUrl) {
                try {
                  profilePictureUrl = await this.sock.profilePictureUrl(jid, 'image');
                } catch (picError) {
                  // Skip if unavailable
                }
              }
            }
          } catch (fetchError) {
            console.error(`   ⚠️ Error fetching contact info for ${lead.phone_number} (JID: ${jid}):`, fetchError.message);
            errors++;
            continue;
          }

          if (contactName && contactName !== lead.contact_name) {
            await this.database.updateLeadContactInfo(lead.id, contactName, profilePictureUrl, jid, this.cid);
            console.log(`   ✅ Updated lead ${lead.id}: "${lead.contact_name || 'none'}" -> "${contactName}" (Phone: ${lead.phone_number}, JID: ${jid})`);
            updated++;
          } else if (profilePictureUrl && profilePictureUrl !== lead.profile_picture_url) {
            await this.database.updateLeadContactInfo(lead.id, lead.contact_name, profilePictureUrl, jid, this.cid);
            updated++;
          } else if (jid && lead.jid !== jid) {
            await this.database.updateLeadContactInfo(lead.id, lead.contact_name, lead.profile_picture_url, jid, this.cid);
            updated++;
          }
        } catch (leadError) {
          console.error(`   ❌ Error processing lead ${lead.id}:`, leadError.message);
          errors++;
        }
      }

      console.log(`✅ Contact name refresh complete: ${updated} updated, ${errors} errors`);
      await this.database.addLog('contacts_refreshed', { updated, errors, total: allLeads.length }, this.cid);
      
      return { success: true, updated, errors, total: allLeads.length };
    } catch (error) {
      console.error('❌ Error refreshing contact names:', error);
      return { success: false, error: error.message };
    }
  }


  /**
   * Disconnect and logout from WhatsApp
   * This will:
   * 1. Call WhatsApp logout() method to unlink device from main phone
   * 2. Wait for logout confirmation via connection.update event
   * 3. Delete the session folder completely
   * 4. Reset connection state
   * 5. Update status to trigger QR code screen
   * 
   * After this, user must scan QR code again to reconnect
   */
  async disconnect() {
    if (!this.sock) {
      console.log('⚠️ No socket to disconnect');
      // Even if no socket, try to clean up session (PostgreSQL: clear auth; else delete folder)
      if (this.database.getPool && this.database.getPool()) {
        try {
          await this.database.clearSessionAuth(this.sessionName);
          console.log('✅ Session auth cleared from PostgreSQL');
        } catch (cleanError) {
          console.error('⚠️ Failed to clear session auth:', cleanError.message);
        }
      } else if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
        console.log('🧹 Cleaning up session folder...');
        try {
          rmSync(this.fullSessionPath, { recursive: true, force: true });
          console.log('✅ Session folder deleted');
        } catch (cleanError) {
          console.error('⚠️ Failed to delete session folder:', cleanError.message);
        }
      }
      this.isConnected = false;
      this.isConnecting = false;
      await this.updateStatus('disconnected', { reason: 'manual_logout' });
      return;
    }

    try {
      console.log('\n🔌 Disconnecting WhatsApp...');
      console.log('   📱 Calling WhatsApp logout() method to unlink device...');
      
      // Set up a promise to wait for logout confirmation
      let logoutConfirmed = false;
      const logoutPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          if (!logoutConfirmed) {
            console.log('   ⚠️ Logout confirmation timeout - proceeding anyway');
            resolve(false); // Resolve with false if timeout
          }
        }, 10000); // 10 second timeout

        // Listen for connection.update event that confirms logout
        const connectionListener = async (update) => {
          const { connection, lastDisconnect } = update;
          
          if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            // Check if this is a logout confirmation
            if (statusCode === DisconnectReason.loggedOut) {
              clearTimeout(timeout);
              logoutConfirmed = true;
              console.log('   ✅ Logout confirmed - device unlinked from WhatsApp');
              this.sock.ev.off('connection.update', connectionListener);
              resolve(true);
            } else if (statusCode) {
              // Other disconnect reason - still proceed
              clearTimeout(timeout);
              console.log(`   ℹ️ Connection closed with status: ${DisconnectReason[statusCode] || statusCode}`);
              this.sock.ev.off('connection.update', connectionListener);
              resolve(true);
            }
          }
        };

        this.sock.ev.on('connection.update', connectionListener);
      });

      // Call logout() method - this unlinks the device from WhatsApp
      try {
        await this.sock.logout();
        console.log('   ✅ Logout() method called successfully');
      } catch (logoutError) {
        console.error('   ⚠️ Logout() error:', logoutError.message);
        // Continue - we'll wait for confirmation anyway
      }
      
      // Wait for logout confirmation (or timeout)
      const confirmed = await logoutPromise;
      
      if (confirmed) {
        console.log('   ✅ Logout confirmed - device has been unlinked from your phone');
      } else {
        console.log('   ⚠️ Logout confirmation timeout - proceeding with cleanup');
      }
      
      // Close the socket connection
      try {
        this.sock.end(undefined);
        console.log('   ✅ Socket closed');
      } catch (endError) {
        console.error('   ⚠️ Error closing socket:', endError.message);
      }
      
      // Wait a moment to ensure everything is processed
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Delete session completely - PostgreSQL: clear auth in DB; else delete folder (ensures fresh QR on next connect)
      if (this.database.getPool && this.database.getPool()) {
        try {
          await this.database.clearSessionAuth(this.sessionName);
          console.log('   ✅ Session auth cleared from PostgreSQL');
        } catch (cleanError) {
          console.error('   ⚠️ Failed to clear session auth:', cleanError.message);
        }
      } else if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
        console.log('   🧹 Deleting session folder...');
        try {
          rmSync(this.fullSessionPath, { recursive: true, force: true });
          console.log('   ✅ Session folder deleted completely');
        } catch (cleanError) {
          console.error('   ⚠️ Failed to delete session folder:', cleanError.message);
          await new Promise(resolve => setTimeout(resolve, 500));
          try {
            rmSync(this.fullSessionPath, { recursive: true, force: true });
            console.log('   ✅ Session folder deleted on retry');
          } catch (retryError) {
            console.error('   ❌ Failed to delete session folder after retry:', retryError.message);
          }
        }
      }

      // Reset connection state
      this.isConnected = false;
      this.isConnecting = false;
      this.reconnectAttempts = 0;
      this.sock = null;
      
      // Update status to 'disconnected' - this will trigger QR code screen in frontend
      await this.updateStatus('disconnected', { 
        reason: 'manual_logout',
        requiresQR: true // Flag to indicate QR is needed
      });
      
      console.log('\n✅ Disconnected successfully!');
      console.log('   📱 Device has been unlinked from your WhatsApp');
      console.log('   🗑️ Session folder deleted');
      console.log('   🔄 QR code screen will appear - scan to reconnect\n');
      
      await this.database.addLog('device_disconnected', { 
        timestamp: new Date().toISOString(),
        reason: 'manual_logout',
        logoutConfirmed: confirmed
      }, this.cid);
    } catch (error) {
      console.error('❌ Error disconnecting:', error);
      // Still try to clean up session even if logout failed
      if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
        try {
          rmSync(this.fullSessionPath, { recursive: true, force: true });
          console.log('✅ Session folder deleted despite error');
        } catch (cleanError) {
          console.error('⚠️ Failed to delete session folder:', cleanError.message);
        }
      }
      this.isConnected = false;
      this.isConnecting = false;
      this.sock = null;
      await this.updateStatus('disconnected', { 
        reason: 'manual_logout', 
        error: error.message,
        requiresQR: true
      });
      throw error;
    }
  }

  /**
   * Reconnect with fresh session if needed
   */
  async reconnect() {
    if (this.isConnecting) {
      console.log('⚠️ Reconnection already in progress');
      return;
    }

    console.log('\n🔄 Manual reconnect requested...');
    
    // Reset reconnect attempts
    this.reconnectAttempts = 0;
    this.isConnecting = false;
    
    // Clean up old socket
    if (this.sock) {
      try {
        this.sock.end(undefined);
      } catch (e) {
        // Ignore
      }
      this.sock = null;
    }

    // Reinitialize
    await this.initialize();
  }

  getStatus() {
    // Return a clean, serializable status object
    const status = {
      isConnected: this.isConnected || false,
      reconnectAttempts: this.reconnectAttempts || 0,
      status: this.currentStatus?.status || 'initializing',
    };
    
    // Only include QR if it exists and is a string
    if (this.currentStatus?.qr && typeof this.currentStatus.qr === 'string') {
      status.qr = this.currentStatus.qr;
    }
    
    // Include timestamp if available
    if (this.currentStatus?.timestamp) {
      status.timestamp = this.currentStatus.timestamp;
    }
    
    return status;
  }
}

export default WhatsAppHandler;

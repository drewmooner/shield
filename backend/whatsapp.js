import makeWASocket, { DisconnectReason, useMultiFileAuthState } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class WhatsAppHandler {
  constructor(database) {
    this.database = database;
    this.sock = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.reconnectDelay = 5000;
    this.messageQueue = null;
    this.onStatusChange = null;
    this.currentStatus = { status: 'initializing' };
    this.sessionPath = null;
    this.sessionName = null;
    this.fullSessionPath = null;
  }

  setStatusCallback(callback) {
    this.onStatusChange = callback;
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
    
    await this.database.addLog(`status_${status}`, details);
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

    // Setup session paths
    this.sessionPath = process.env.SESSION_PATH || './sessions';
    this.sessionName = process.env.SESSION_NAME || 'shield-session';
    this.fullSessionPath = join(__dirname, this.sessionPath, this.sessionName);

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

      // Load auth state
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

      // Initialize message queue if not already done
      if (!this.messageQueue) {
        const { default: PQueue } = await import('p-queue');
        this.messageQueue = new PQueue({ concurrency: 1 });
      }

      // Update status to connecting
      await this.updateStatus('connecting');

      // Create socket with proper configuration
      console.log('🌐 Using Baileys default version handling...');
      console.log('🔌 Creating WhatsApp socket...');
      const socketConfig = {
        // Let Baileys auto-detect version - don't specify version
        logger: pino({ level: 'silent' }),
        auth: state,
        mobile: false, // Force desktop mode
        browser: ['Ubuntu', 'Chrome', '20.0.04'], // More generic browser identifier
        getMessage: async (key) => {
          return {
            conversation: 'Message not available'
          };
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
      // Prioritize QR handling - check QR first and return early
      this.sock.ev.on('connection.update', (update) => {
        setImmediate(async () => {
          await this.handleConnectionUpdate(update);
        });
      });
      console.log('  ✅ connection.update listener attached');

      // Handle messages.upsert - PERSISTENT LISTENER (handles new + historical messages)
      // This is event-driven: we react immediately, don't wait
      // Remove any existing listener first to prevent duplicates
      this.sock.ev.removeAllListeners('messages.upsert');
      this.sock.ev.on('messages.upsert', async (m) => {
        console.log('📨 messages.upsert event fired');
        console.log('   📋 Event data:', JSON.stringify({
          hasMessages: !!m.messages,
          messageCount: m.messages?.length || 0,
          type: m.type,
          firstMessageJid: m.messages?.[0]?.key?.remoteJid || 'none'
        }));
        try {
          await this.handleIncomingMessage(m);
        } catch (error) {
          console.error('❌ Error in messages.upsert handler:', error);
          console.error('   Stack:', error.stack);
        }
      });
      console.log('  ✅ messages.upsert listener attached (handles new + historical)');

      // Handle chats.set - PERSISTENT LISTENER (stores immediately when WhatsApp sends)
      this.sock.ev.on('chats.set', async (chats) => {
        setImmediate(async () => {
          await this.handleChatsUpdate(chats);
        });
      });
      console.log('  ✅ chats.set listener attached (stores immediately)');

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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const error = lastDisconnect?.error;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log('\n🔴 Connection closed:');
      console.log('   Status code:', statusCode);
      console.log('   Disconnect reason:', DisconnectReason[statusCode] || 'Unknown');
      
      if (error) {
        console.log('   Error message:', error.message || error);
      }

      // Handle specific disconnect reasons
      if (statusCode === DisconnectReason.loggedOut) {
        console.log('   ⚠️ Logged out - credentials invalid');
        // Clean up session on logout
        if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
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
      console.log('\n🟢 Connection opened successfully!');
      this.reconnectAttempts = 0;
      this.isConnected = true;
      this.isConnecting = false;
      
      await this.updateStatus('connected', { 
        timestamp: new Date().toISOString(),
        isNewLogin
      });
      console.log('✅ WhatsApp connected and ready\n');
      console.log('📥 Event listeners are active - chats/messages will be stored automatically as WhatsApp syncs them\n');
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
   * Handle messages.upsert - stores ALL messages immediately (new + historical)
   * This is the correct way: react to events, don't wait
   */
  async handleIncomingMessage(m) {
    console.log('\n📨 messages.upsert event fired');
    console.log(`📨 Received ${m.messages.length} messages (type: ${m.type})`);

    let storedCount = 0;

    for (const msg of m.messages) {
      try {
        // Skip if no message object
        if (!msg.message) {
          console.log('   ⏭️ Skipping - no message content');
          continue;
        }

        // Skip protocol messages (deletions, reactions, etc)
        if (msg.message.protocolMessage) {
          console.log('   ⏭️ Skipping protocol message');
          continue;
        }

        const jid = msg.key.remoteJid;

        // Skip status broadcasts
        if (jid === 'status@broadcast') {
          console.log('   ⏭️ Skipping status broadcast');
          continue;
        }

        // Skip group messages (remove this if you want groups)
        if (jid.endsWith('@g.us')) {
          console.log('   ⏭️ Skipping group message:', jid);
          continue;
        }

        // Extract phone number (remove @s.whatsapp.net)
        let phoneNumber = jid.replace('@s.whatsapp.net', '');
        if (!phoneNumber) {
          console.log('   ⏭️ Skipping - invalid JID:', jid);
          continue;
        }
        
        // Normalize phone number using database method
        phoneNumber = this.database.normalizePhoneNumber(phoneNumber);
        if (!phoneNumber) {
          console.log('   ⏭️ Skipping - invalid phone number from JID:', jid);
          continue;
        }
        
        console.log(`   📱 Processing message from: ${phoneNumber} (JID: ${jid})`);

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

        console.log(`   📝 Message text: "${messageText}"`);

        // Get pushName from message if available
        const pushName = msg.pushName || null;
        console.log(`   👤 PushName from message: ${pushName || 'none'} (JID: ${jid})`);

        // Find or create lead using normalized phone number FIRST
        let lead = await this.database.getLeadByPhone(phoneNumber);
        
        if (!lead) {
          console.log(`   👤 Creating new lead for phone: ${phoneNumber}`);
          // Use pushName when creating new lead
          lead = await this.database.createLead(phoneNumber, pushName);
          console.log(`   ✅ Created lead: ${lead.id} (phone: ${lead.phone_number}, name: ${pushName || 'none'})`);
        } else {
          console.log(`   ✅ Found existing lead: ${lead.id} (phone: ${lead.phone_number})`);
          
          // Update phone number to normalized format if different
          const normalized = this.database.normalizePhoneNumber(lead.phone_number);
          if (normalized !== lead.phone_number && normalized !== '') {
            console.log(`   🔄 Normalizing phone: ${lead.phone_number} -> ${normalized}`);
            lead.phone_number = normalized;
            await this.database.db.write();
          }
        }
        
        // Fetch contact info (name and profile picture) - Use both JID and pushName
        if (this.sock && this.isConnected) {
          try {
            let needsUpdate = false;
            let contactName = lead.contact_name;
            let profilePictureUrl = lead.profile_picture_url;
            
            // Priority 1: Get contact name from WhatsApp contacts using JID (most reliable)
            if (this.sock.contacts && this.sock.contacts[jid]) {
              const contactFromJid = this.sock.contacts[jid].name || 
                                     this.sock.contacts[jid].notify || 
                                     this.sock.contacts[jid].pushName || 
                                     null;
              if (contactFromJid && contactFromJid !== contactName) {
                contactName = contactFromJid;
                needsUpdate = true;
                console.log(`   📝 Got contact name from JID contacts: ${contactName}`);
              }
            }
            
            // Priority 2: Use pushName from message if we don't have a name yet or if it's different
            if (pushName && (!contactName || pushName !== contactName)) {
              // Verify pushName matches JID by checking if it's in our contacts
              // If not in contacts, still use it as it's from the message itself
              if (!contactName || (this.sock.contacts && this.sock.contacts[jid] && this.sock.contacts[jid].pushName === pushName)) {
                contactName = pushName;
                needsUpdate = true;
                console.log(`   📝 Using pushName from message: ${pushName}`);
              } else {
                console.log(`   ⚠️ PushName mismatch - JID contact: ${contactName}, message pushName: ${pushName} - using JID contact`);
              }
            }
            
            // Get profile picture if we don't have it
            if (!profilePictureUrl) {
              try {
                profilePictureUrl = await this.sock.profilePictureUrl(jid, 'image');
                if (profilePictureUrl) {
                  console.log(`   🖼️ Fetched profile picture for ${phoneNumber}`);
                  needsUpdate = true;
                }
              } catch (picError) {
                // Profile picture not available, skip
              }
            }
            
            // Update if we got any new info
            if (needsUpdate) {
              await this.database.updateLeadContactInfo(lead.id, contactName, profilePictureUrl);
            }
          } catch (infoError) {
            // Skip if we can't fetch contact info
          }
        }

        // Check if message already exists (prevent duplicates)
        const existingMessages = await this.database.getMessagesByLead(lead.id);
        const msgTimestamp = msg.messageTimestamp 
          ? new Date(msg.messageTimestamp * 1000).toISOString()
          : new Date().toISOString();
        
        const sender = msg.key.fromMe ? 'shield' : 'user';
        const msgExists = existingMessages.some(m => {
          const timeDiff = Math.abs(new Date(m.timestamp).getTime() - new Date(msgTimestamp).getTime());
          return m.content === messageText && 
                 m.sender === sender &&
                 timeDiff < 10000; // Within 10 seconds
        });
        
        if (msgExists) {
          console.log('   ⏭️ Skipping duplicate message');
          continue;
        }

        // Store message
        console.log('   💾 Storing message...');
        await this.database.createMessage(
          lead.id, 
          sender, 
          messageText, 
          sender === 'shield' ? 'replied' : 'pending',
          msgTimestamp // Pass message timestamp to update lead's updated_at
        );
        
        storedCount++;
        console.log(`   ✅ Message stored successfully!`);

        // Only auto-reply for NEW incoming messages from users (not historical, not from us)
        if (m.type === 'notify' && sender === 'user') {
          // Check if we should auto-reply
          const autoReplyEnabled = await this.database.getSetting('auto_reply_enabled') === 'true';
          const botPaused = await this.database.getSetting('bot_paused') === 'true';

          if (autoReplyEnabled && !botPaused) {
            // Queue auto-reply
            this.messageQueue.add(async () => {
              await this.sendAutoReply(lead, phoneNumber);
            });
          }

          await this.database.addLog('message_received', { phoneNumber, leadId: lead.id });
        }

      } catch (error) {
        console.error('   ❌ Error processing message:', error);
      }
    }

    if (storedCount > 0) {
      console.log(`\n✅ Stored ${storedCount} new messages`);
    } else {
      console.log('\n⚠️ No messages were stored (all filtered or duplicates)');
    }
  }

  async sendAutoReply(lead, phoneNumber) {
    try {
      // Get settings
      const templates = await this.database.getTemplates();
      const primaryLink = await this.database.getSetting('primary_link') || 'https://example.com';
      const backupLink = await this.database.getSetting('backup_link') || '';
      const minDelay = parseInt(await this.database.getSetting('min_delay_seconds') || '3');
      const maxDelay = parseInt(await this.database.getSetting('max_delay_seconds') || '10');
      // Get API key from env or database (env takes priority)
      const openrouterApiKey = process.env.OPENROUTER_API_KEY || await this.database.getSetting('openrouter_api_key');
      const aiModel = process.env.AI_MODEL || await this.database.getSetting('ai_model') || 'anthropic/claude-opus-4.6';
      const aiEnabled = process.env.AI_ENABLED === 'true' || await this.database.getSetting('ai_enabled') === 'true';

      // Random delay
      const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
      await new Promise(resolve => setTimeout(resolve, delay * 1000));

      let message;

      // Use AI to chat naturally or select template if enabled
      if (aiEnabled && openrouterApiKey) {
        try {
          // Get last user message for context
          const messages = await this.database.getMessagesByLead(lead.id);
          const lastUserMessage = messages.filter(m => m.sender === 'user').pop();
          const userMessage = lastUserMessage?.content || 'Hello';

          // Use AI to generate natural response or select template
          const aiResponse = await this.selectTemplateWithAI(userMessage, templates, openrouterApiKey, aiModel, primaryLink, backupLink);
          
          // Replace link placeholders
          message = this.replaceLinkPlaceholders(aiResponse, primaryLink, backupLink);
        } catch (aiError) {
          console.error('AI response failed, falling back to random template:', aiError);
          // Fallback to random template
          if (templates.length > 0) {
            const template = templates[Math.floor(Math.random() * templates.length)];
            message = this.replaceLinkPlaceholders(template, primaryLink, backupLink);
          } else {
            message = 'Thanks for your message!';
          }
        }
      } else {
        // Random template selection (original behavior)
        if (templates.length > 0) {
          const template = templates[Math.floor(Math.random() * templates.length)];
          message = this.replaceLinkPlaceholders(template, primaryLink, backupLink);
        } else {
          message = 'Thanks for your message!';
        }
      }

      // Send message
      await this.sendMessage(phoneNumber, message);

      // Update database
      const timestamp = new Date().toISOString();
      await this.database.createMessage(lead.id, 'shield', message, 'replied', timestamp);
      await this.database.incrementReplyCount(lead.id);

      await this.database.addLog('auto_reply_sent', { phoneNumber, leadId: lead.id, replyCount: lead.reply_count + 1 });
    } catch (error) {
      console.error('Error sending auto-reply:', error);
      await this.database.addLog('error', { error: error.message, context: 'sendAutoReply' });
    }
  }

  /**
   * Replace link placeholders in message
   */
  replaceLinkPlaceholders(message, primaryLink, backupLink) {
    // Replace {{primary_link}} or {{link}} with primary link
    message = message.replace(/\{\{primary_link\}\}/gi, primaryLink);
    message = message.replace(/\{\{link\}\}/gi, primaryLink); // Keep {{link}} for backward compatibility
    
    // Replace {{backup_link}} with backup link (if available)
    if (backupLink && backupLink.trim() !== '') {
      message = message.replace(/\{\{backup_link\}\}/gi, backupLink);
    } else {
      // If backup link not set, replace with primary link
      message = message.replace(/\{\{backup_link\}\}/gi, primaryLink);
    }
    
    return message;
  }

  async selectTemplateWithAI(userMessage, templates, apiKey, model = 'openai/gpt-3.5-turbo', primaryLink, backupLink) {
    // First, check if the user is asking about the link/product/service
    const linkKeywords = ['link', 'website', 'site', 'page', 'product', 'service', 'buy', 'purchase', 'order', 'check', 'visit', 'see', 'more', 'info', 'information', 'details'];
    const userMessageLower = userMessage.toLowerCase();
    const isAskingAboutLink = linkKeywords.some(keyword => userMessageLower.includes(keyword));
    
    // Extract meaningful keywords from templates (only business/product-related words)
    // Filter out common conversational words that shouldn't trigger templates
    const commonWords = ['thanks', 'thank', 'hello', 'hi', 'hey', 'check', 'visit', 'click', 'here', 'out', 'our', 'your', 'the', 'this', 'that', 'with', 'for', 'and', 'or', 'but', 'more', 'learn', 'interested', 'about'];
    const templateContent = templates.join(' ').toLowerCase();
    const templateWords = templateContent.split(/\s+/)
      .filter(word => word.length > 4) // Only words longer than 4 chars
      .filter(word => !commonWords.includes(word)) // Exclude common words
      .filter(word => /^[a-z]+$/.test(word)); // Only alphabetic words
    
    // Check if user message contains template-specific keywords
    const relatesToTemplate = templateWords.length > 0 && 
      templateWords.some(keyword => userMessageLower.includes(keyword));
    
    if (!isAskingAboutLink && !relatesToTemplate) {
      // User is just chatting - respond naturally without templates
      const naturalResponse = await this.generateNaturalResponse(userMessage, apiKey, model);
      return naturalResponse;
    }
    
    // User is asking about the link/product - use templates
    // Determine which link to use based on context
    const useBackupLink = this.shouldUseBackupLink(userMessage, backupLink);
    const linkToUse = useBackupLink && backupLink ? backupLink : primaryLink;
    const linkType = useBackupLink ? 'backup' : 'primary';
    
    const prompt = `You are a WhatsApp assistant. A customer sent this message: "${userMessage}"

Available response templates (use these ONLY if the customer is asking about the link, product, or service):
${templates.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Available links:
- Primary link: ${primaryLink}
${backupLink ? `- Backup link: ${backupLink}` : ''}

If the customer is asking about the link/product/service:
1. Select the template number (1-${templates.length}) that best matches their question
2. Choose which link to use (primary or backup) based on their question
3. In your response, use {{primary_link}} or {{backup_link}} placeholder

If they're just chatting casually, respond naturally without using templates.

Respond with either:
- A template number (1-${templates.length}) followed by "PRIMARY" or "BACKUP" to indicate which link (e.g., "2 PRIMARY" or "1 BACKUP")
- A natural human-like response if they're just chatting

Only respond with the number and link type, or your natural response, nothing else.`;

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
        max_tokens: 200,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter API error: ${response.statusText}`);
    }

    const data = await response.json();
    const aiResponse = data.choices[0].message.content.trim();
    
    // Check if response contains template number and link type (e.g., "2 PRIMARY" or "1 BACKUP")
    const templateMatch = aiResponse.match(/^(\d+)\s+(PRIMARY|BACKUP)$/i);
    if (templateMatch) {
      const selectedIndex = parseInt(templateMatch[1]);
      const linkType = templateMatch[2].toUpperCase();
      
      if (selectedIndex >= 1 && selectedIndex <= templates.length) {
        const template = templates[selectedIndex - 1];
        // Replace with appropriate placeholder
        if (linkType === 'BACKUP' && backupLink) {
          return template.replace(/\{\{primary_link\}\}|\{\{link\}\}/gi, '{{backup_link}}');
        } else {
          return template.replace(/\{\{backup_link\}\}/gi, '{{primary_link}}');
        }
      }
    }
    
    // Check if response is just a number (template selection, use primary link)
    const selectedIndex = parseInt(aiResponse);
    if (!isNaN(selectedIndex) && selectedIndex >= 1 && selectedIndex <= templates.length) {
      return templates[selectedIndex - 1];
    }
    
    // AI returned a natural response
    return aiResponse;
  }

  /**
   * Determine if backup link should be used based on user message
   */
  shouldUseBackupLink(userMessage, backupLink) {
    if (!backupLink || backupLink.trim() === '') return false;
    
    const userMessageLower = userMessage.toLowerCase();
    const backupKeywords = ['backup', 'alternative', 'other', 'different', 'another', 'else', 'second'];
    
    return backupKeywords.some(keyword => userMessageLower.includes(keyword));
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

  async sendMessage(phoneNumber, message) {
    if (!this.sock || !this.isConnected) {
      throw new Error('WhatsApp not connected');
    }

    const jid = `${phoneNumber}@s.whatsapp.net`;
    
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

  async sendManualMessage(phoneNumber, message) {
    try {
      // Normalize phone number using database method
      phoneNumber = this.database.normalizePhoneNumber(phoneNumber);
      console.log(`📤 Sending message to normalized phone: ${phoneNumber}`);
      
      // Send message via WhatsApp
      await this.sendMessage(phoneNumber, message);
      
      // Get or create lead using normalized phone number
      const lead = await this.database.getOrCreateLead(phoneNumber);
      console.log(`   ✅ Using lead: ${lead.id} (phone: ${lead.phone_number})`);
      
      // Store message with a unique identifier to prevent duplicates
      // Use current timestamp + message content as unique key
      const timestamp = new Date().toISOString();
      
      // Check if message already exists (prevent duplicate from messages.upsert event)
      const existingMessages = await this.database.getMessagesByLead(lead.id);
      const msgExists = existingMessages.some(m => 
        m.content === message && 
        m.sender === 'shield' &&
        Math.abs(new Date(m.timestamp).getTime() - new Date(timestamp).getTime()) < 5000 // Within 5 seconds
      );
      
      if (!msgExists) {
        const timestamp = new Date().toISOString();
        await this.database.createMessage(lead.id, 'shield', message, 'replied', timestamp);
      }
      await this.database.incrementReplyCount(lead.id);

      await this.database.addLog('manual_reply_sent', { phoneNumber, leadId: lead.id });
      return { success: true };
    } catch (error) {
      console.error('Error sending manual message:', error);
      await this.database.addLog('error', { error: error.message, context: 'sendManualMessage' });
      throw error;
    }
  }

  /**
   * Handle chats update from WhatsApp - stores immediately
   */
  async handleChatsUpdate(chats) {
    if (!chats || !Array.isArray(chats)) return;

    try {
      console.log(`📱 Received ${chats.length} chats from WhatsApp - storing with names and images...`);
      let contactsLoaded = 0;
      let contactsWithInfo = 0;

      for (const chat of chats) {
        try {
          const jid = chat.id;
          if (!jid || jid.includes('@g.us')) continue; // Skip groups
          
          let phoneNumber = jid.replace('@s.whatsapp.net', '');
          if (!phoneNumber) continue;
          
          // Normalize phone number
          phoneNumber = this.database.normalizePhoneNumber(phoneNumber);
          if (!phoneNumber) continue;

          // Get or create lead immediately
          let lead = await this.database.getLeadByPhone(phoneNumber);
          if (!lead) {
            lead = await this.database.createLead(phoneNumber);
          }

          // Fetch contact name (pushName) and profile picture from WhatsApp for ALL chats
          if (this.sock && this.isConnected) {
            try {
              let contactName = lead.contact_name;
              let profilePictureUrl = lead.profile_picture_url;
              let needsUpdate = false;

              // Get contact name from phonebook/contacts (always try to update)
              if (this.sock.contacts && this.sock.contacts[jid]) {
                const newContactName = this.sock.contacts[jid].name || 
                                      this.sock.contacts[jid].notify || 
                                      this.sock.contacts[jid].pushName || 
                                      null;
                if (newContactName && newContactName !== contactName) {
                  contactName = newContactName;
                  needsUpdate = true;
                }
              }
              
              // Try to get profile picture (always try if missing)
              if (!profilePictureUrl) {
                try {
                  profilePictureUrl = await this.sock.profilePictureUrl(jid, 'image');
                  if (profilePictureUrl) {
                    needsUpdate = true;
                  }
                } catch (picError) {
                  // Profile picture not available, skip
                }
              }

              // Update lead with contact info if we got any new info
              if (needsUpdate) {
                await this.database.updateLeadContactInfo(lead.id, contactName, profilePictureUrl);
                contactsWithInfo++;
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
        await this.database.addLog('chats_synced', { contacts: contactsLoaded, withInfo: contactsWithInfo });
      }
    } catch (error) {
      console.error('Error processing chats update:', error);
      await this.database.addLog('error', { error: error.message, context: 'handleChatsUpdate' });
    }
  }

  /**
   * Store messages from messages.upsert event (handles both new and historical messages)
   */
  async storeMessagesFromUpsert(m) {
    if (!m || !m.messages || !Array.isArray(m.messages)) return;

    try {
      let messagesStored = 0;

      for (const msg of m.messages) {
        try {
          const remoteJid = msg.key?.remoteJid;
          
          // Skip groups - check if JID contains @g.us (group identifier)
          if (!remoteJid || remoteJid.includes('@g.us')) {
            continue; // Skip all group messages
          }
          
          // Only process individual chats (@s.whatsapp.net)
          if (!remoteJid.includes('@s.whatsapp.net')) {
            continue; // Skip if not a standard WhatsApp number
          }
          
          let phoneNumber = remoteJid.replace('@s.whatsapp.net', '');
          if (!phoneNumber) continue;
          
          // Normalize phone number
          phoneNumber = this.database.normalizePhoneNumber(phoneNumber);
          if (!phoneNumber) continue;

          // Extract message content
          const messageText = msg.message?.conversation || 
                            msg.message?.extendedTextMessage?.text || 
                            msg.message?.imageMessage?.caption ||
                            msg.message?.videoMessage?.caption ||
                            '[Media]';

          if (!messageText || messageText.trim() === '') continue;

          // Get or create lead using normalized phone
          const lead = await this.database.getOrCreateLead(phoneNumber);
          
          // Check if message already exists (avoid duplicates)
          const existingMessages = await this.database.getMessagesByLead(lead.id);
          const msgTimestamp = msg.messageTimestamp 
            ? new Date(msg.messageTimestamp * 1000).toISOString()
            : new Date().toISOString();
          
          const msgExists = existingMessages.some(m => 
            m.content === messageText && m.timestamp === msgTimestamp
          );
          
          if (msgExists) continue;

          // Determine sender
          const sender = msg.key?.fromMe ? 'shield' : 'user';

          // Save message immediately to database (msgTimestamp already defined above)
          await this.database.createMessage(
            lead.id,
            sender,
            messageText,
            sender === 'shield' ? 'replied' : 'pending',
            msgTimestamp
          );
          messagesStored++;
        } catch (msgError) {
          // Skip individual message errors silently
        }
      }

      if (messagesStored > 0) {
        console.log(`✅ Stored ${messagesStored} messages in database`);
      }
    } catch (error) {
      console.error('Error storing messages from upsert:', error);
    }
  }

  /**
   * Handle contacts update from WhatsApp
   */
  async handleContactsUpdate(contacts) {
    if (!contacts || typeof contacts !== 'object') return;

    try {
      console.log(`📇 Received contacts from WhatsApp - fetching phone, name, and profile pictures...`);
      let contactsStored = 0;
      let contactsWithInfo = 0;

      for (const [jid, contact] of Object.entries(contacts)) {
        try {
          if (!jid || jid.includes('@g.us')) continue; // Skip groups
          
          let phoneNumber = jid.replace('@s.whatsapp.net', '');
          if (!phoneNumber) continue;
          
          // Normalize phone number
          phoneNumber = this.database.normalizePhoneNumber(phoneNumber);
          if (!phoneNumber) continue;

          // Get contact name (pushName) from contact object
          const contactName = contact?.name || contact?.notify || contact?.pushName || null;
          
          // Get or create lead using normalized phone
          let lead = await this.database.getLeadByPhone(phoneNumber);
          if (!lead) {
            lead = await this.database.createLead(phoneNumber, contactName);
          } else {
            // Update contact name if we have a new one
            if (contactName && contactName !== lead.contact_name) {
              await this.database.updateLeadContactInfo(lead.id, contactName, null);
            }
            // Normalize phone number if different
            const normalized = this.database.normalizePhoneNumber(lead.phone_number);
            if (normalized !== lead.phone_number && normalized !== '') {
              lead.phone_number = normalized;
              await this.database.db.write();
            }
          }

          // Fetch profile picture if we don't have it yet
          if (this.sock && this.isConnected && !lead.profile_picture_url) {
            try {
              const profilePictureUrl = await this.sock.profilePictureUrl(jid, 'image');
              if (profilePictureUrl) {
                await this.database.updateLeadContactInfo(lead.id, null, profilePictureUrl);
                contactsWithInfo++;
              }
            } catch (picError) {
              // Profile picture not available, skip
            }
          } else if (lead.profile_picture_url) {
            contactsWithInfo++;
          }

          contactsStored++;
        } catch (contactError) {
          console.error(`   ❌ Error processing contact ${jid}:`, contactError.message);
        }
      }

      if (contactsStored > 0) {
        console.log(`✅ Processed ${contactsStored} contacts (${contactsWithInfo} with profile pictures)`);
        await this.database.addLog('contacts_synced', { contacts: contactsStored, withPictures: contactsWithInfo });
      }
    } catch (error) {
      console.error('Error processing contacts update:', error);
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
      // Even if no socket, try to clean up session
      if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
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
      
      // Delete session folder completely - this ensures fresh QR on next connect
      if (this.fullSessionPath && existsSync(this.fullSessionPath)) {
        console.log('   🧹 Deleting session folder...');
        try {
          rmSync(this.fullSessionPath, { recursive: true, force: true });
          console.log('   ✅ Session folder deleted completely');
        } catch (cleanError) {
          console.error('   ⚠️ Failed to delete session folder:', cleanError.message);
          // Try again after a short delay
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
      });
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

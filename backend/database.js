import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';
import { PostgresDriver } from './db/postgres.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Database {
  constructor(dbPathOrOptions) {
    // PostgreSQL: persistent DB and session storage when DATABASE_URL is set
    if (typeof dbPathOrOptions === 'object' && dbPathOrOptions?.databaseUrl) {
      this.driver = new PostgresDriver(dbPathOrOptions.databaseUrl);
      this.db = null;
      return;
    }

    const dbPath = typeof dbPathOrOptions === 'string' ? dbPathOrOptions : 'shield.json';
    this.driver = null;

    // Ensure data directory exists
    const dbDir = join(__dirname, '..', 'data');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const fullPath = join(dbDir, dbPath);
    const adapter = new JSONFile(fullPath);
    this.db = new Low(adapter, {
      leads: [],
      messages: [],
      settings: {},
      bot_logs: []
    });

    this.init();
  }

  /** When using PostgreSQL, returns the pool for auth state. Otherwise null. */
  getPool() {
    return this.driver?.pool ?? null;
  }

  /** Clear Baileys session auth (PostgreSQL only; on logout). */
  async clearSessionAuth(sessionName = 'shield-session') {
    if (this.driver?.clearSessionAuth) return this.driver.clearSessionAuth(sessionName);
  }

  async init() {
    await this.db.read();
    
    // Initialize default settings if empty
    if (Object.keys(this.db.data.settings).length === 0) {
      this.db.data.settings = {
        max_replies_per_lead: '5',
        min_delay_seconds: '3',
        max_delay_seconds: '10',
        view_delay_min_seconds: '1',
        view_delay_max_seconds: '5',
        typing_indicator_enabled: 'true',
        auto_reply_enabled: 'true',
        primary_link: 'https://example.com',
        backup_link: '',
        bot_paused: 'false',
        ai_enabled: 'false',
        openrouter_api_key: '',
        ai_model: 'openai/gpt-3.5-turbo',
        keyword_replies: '[]',
        welcome_audio_path: '',
        saved_audios: '[]'
      };
      await this.db.write();
    } else {
      const defaults = {
        keyword_replies: '[]',
        welcome_audio_path: '',
        saved_audios: '[]',
        view_delay_min_seconds: '1',
        view_delay_max_seconds: '5',
        typing_indicator_enabled: 'true'
      };
      let changed = false;
      for (const [k, v] of Object.entries(defaults)) {
        if (this.db.data.settings[k] === undefined) {
          this.db.data.settings[k] = v;
          changed = true;
        }
      }
      // Migrate welcome_audio_path to saved_audios if we have one and saved_audios is empty
      const savedAudiosRaw = this.db.data.settings.saved_audios;
      let savedAudios = [];
      try {
        savedAudios = typeof savedAudiosRaw === 'string' ? JSON.parse(savedAudiosRaw || '[]') : (savedAudiosRaw || []);
      } catch (_) {}
      const welcomePath = this.db.data.settings.welcome_audio_path;
      if (savedAudios.length === 0 && welcomePath && typeof welcomePath === 'string' && welcomePath.trim()) {
        savedAudios = [{ id: randomUUID(), path: welcomePath }];
        this.db.data.settings.saved_audios = JSON.stringify(savedAudios);
        this.db.data.settings.welcome_audio_path = '';
        changed = true;
      }
      if (changed) await this.db.write();
    }
    
    console.log('Connected to JSON database');
  }

  // Lead operations
  /** Normalize JID by stripping device suffix but preserving original domain (@lid / @s.whatsapp.net). */
  normalizeJid(jid) {
    if (this.driver) return this.driver.normalizeJid(jid);
    if (!jid || typeof jid !== 'string') return null;
    const atIdx = jid.indexOf('@');
    if (atIdx < 0) return null;
    const phonePart = jid.slice(0, atIdx).split(':')[0];
    const domain = jid.slice(atIdx + 1);
    if (!domain) return null;
    const normalized = this.normalizePhoneNumber(phonePart);
    return normalized ? `${normalized}@${domain}` : null;
  }

  /** Build JID from phone, preserving existing domain when provided. */
  getCanonicalJid(phoneNumber, existingJid = null) {
    if (this.driver) return this.driver.getCanonicalJid(phoneNumber, existingJid);
    if (!phoneNumber) return null;
    const n = this.normalizePhoneNumber(phoneNumber);
    if (!n) return null;
    if (existingJid) {
      const normalizedExisting = this.normalizeJid(existingJid);
      if (normalizedExisting && normalizedExisting.includes('@')) {
        const domain = normalizedExisting.split('@')[1];
        if (domain) return `${n}@${domain}`;
      }
    }
    return `${n}@s.whatsapp.net`;
  }

  /** Same as normalizeJid: preserve original domain. */
  toCanonicalJid(jid) {
    if (this.driver) return this.driver.toCanonicalJid(jid);
    return this.normalizeJid(jid);
  }

  /** Single canonical form: no +, no spaces, no leading 0 (so 087544536539327 matches 87544536539327). */
  normalizePhoneNumber(phoneNumber) {
    if (this.driver) return this.driver.normalizePhoneNumber(phoneNumber);
    if (!phoneNumber) return '';
    // Keep digits only (strip @domain, :, spaces, symbols, letters, etc.)
    let normalized = String(phoneNumber).split('@')[0];
    if (normalized.includes(':')) normalized = normalized.split(':')[0];
    normalized = normalized.replace(/\D/g, '');
    // Strip leading 0 so "087544536539327" and "87544536539327" match (avoids duplicate when user messages first)
    if (normalized.length > 10 && normalized.startsWith('0')) normalized = normalized.slice(1);
    // Phone-like guard: avoid creating leads from junk ids
    if (normalized.length < 7 || normalized.length > 15) return '';
    return normalized;
  }

  async getLeadByPhone(phoneNumber, clientId = 'default') {
    if (this.driver) return this.driver.getLeadByPhone(phoneNumber, clientId);
    await this.db.read();
    const normalized = this.normalizePhoneNumber(phoneNumber);
    if (!normalized) return null;

    let lead = this.db.data.leads.find(l => l.phone_number === phoneNumber);
    if (lead) return lead;
    lead = this.db.data.leads.find(l => this.normalizePhoneNumber(l.phone_number) === normalized);
    if (lead) return lead;

    lead = this.db.data.leads.find(l => {
      const existingNorm = this.normalizePhoneNumber(l.phone_number);
      return existingNorm && (existingNorm.endsWith(normalized) || normalized.endsWith(existingNorm));
    });
    return lead || null;
  }

  async getLeadByJid(jid, clientId = 'default') {
    if (this.driver) return this.driver.getLeadByJid(jid, clientId);
    await this.db.read();
    const normalizedJid = this.normalizeJid(jid);
    if (!normalizedJid) return null;

    let lead = this.db.data.leads.find(l => l.jid === normalizedJid);
    if (lead) return lead;
    lead = this.db.data.leads.find(l => l.jid && this.normalizeJid(l.jid) === normalizedJid);
    if (lead) {
      lead.jid = normalizedJid;
      await this.db.write();
      return lead;
    }

    const phonePart = normalizedJid.slice(0, normalizedJid.indexOf('@'));
    const normalized = this.normalizePhoneNumber(phonePart);
    if (normalized) {
      lead = await this.getLeadByPhone(normalized);
      if (lead) {
        if (!lead.jid || this.normalizeJid(lead.jid) !== normalizedJid) {
          lead.jid = normalizedJid;
          await this.db.write();
        }
      }
    }
    return lead || null;
  }

  /** Find ALL leads that represent the same contact (by normalized phone or JID). Used to merge on incoming. */
  async findAllLeadsForContact(normalizedPhone, normalizedJid, clientId = 'default') {
    if (this.driver) return this.driver.findAllLeadsForContact(normalizedPhone, normalizedJid, clientId);
    await this.db.read();
    const normalized = this.normalizePhoneNumber(normalizedPhone);
    if (!normalized && !normalizedJid) return [];

    const ids = new Set();
    const out = [];
    for (const l of this.db.data.leads) {
      if (ids.has(l.id)) continue;
      const matchJid = normalizedJid && l.jid && this.normalizeJid(l.jid) === normalizedJid;
      const matchPhone = normalized && (() => {
        const existingNorm = this.normalizePhoneNumber(l.phone_number);
        if (!existingNorm) return false;
        return existingNorm === normalized || existingNorm.endsWith(normalized) || normalized.endsWith(existingNorm);
      })();
      if (matchJid || matchPhone) {
        ids.add(l.id);
        out.push(l);
      }
    }
    return out;
  }

  /** Merge multiple leads into one (messages, reply_count, contact info). Returns the primary lead. */
  async mergeLeads(leads, preferredPrimaryId = null, clientId = 'default') {
    if (this.driver) return this.driver.mergeLeads(leads, preferredPrimaryId, clientId);
    if (!leads || leads.length <= 1) return leads?.[0] || null;
    await this.db.read();

    // Primary: preferred id, or first with contact_name, or oldest created_at
    let primary = preferredPrimaryId ? leads.find(l => l.id === preferredPrimaryId) : null;
    if (!primary) primary = leads.find(l => l.contact_name || l.profile_picture_url) || leads[0];
    if (!primary) primary = leads[0];
    const primaryId = primary.id;
    const others = leads.filter(l => l.id !== primaryId);

    for (const other of others) {
      const msgs = this.db.data.messages.filter(m => m.lead_id === other.id);
      for (const m of msgs) m.lead_id = primaryId;
      primary.reply_count = (primary.reply_count || 0) + (other.reply_count || 0);
      if (!primary.contact_name && other.contact_name) primary.contact_name = other.contact_name;
      if (!primary.profile_picture_url && other.profile_picture_url) primary.profile_picture_url = other.profile_picture_url;
      if (other.created_at && new Date(other.created_at) < new Date(primary.created_at)) primary.created_at = other.created_at;
    }

    this.db.data.leads = this.db.data.leads.filter(l => l.id !== primaryId && !others.some(o => o.id === l.id));
    this.db.data.leads.push(primary);
    primary.updated_at = new Date().toISOString();
    await this.db.write();
    return primary;
  }

  /** Find or create lead. Never creates a duplicate: always finds by phone or JID first. JID is always ${phone}@s.whatsapp.net. */
  async createLead(phoneNumber, contactName = null, profilePictureUrl = null, jid = null, clientId = 'default') {
    if (this.driver) return this.driver.createLead(phoneNumber, contactName, profilePictureUrl, jid, clientId);
    await this.db.read();
    const normalizedPhone = this.normalizePhoneNumber(phoneNumber) || phoneNumber;
    const normalizedJid = (jid ? this.normalizeJid(jid) : null) || this.getCanonicalJid(normalizedPhone);

    let lead = await this.getLeadByPhone(normalizedPhone);
    if (lead) {
      let changed = false;
      if (normalizedJid && (!lead.jid || lead.jid !== normalizedJid)) {
        lead.jid = normalizedJid;
        changed = true;
      }
      if (contactName != null && lead.contact_name !== contactName) {
        lead.contact_name = contactName;
        changed = true;
      }
      if (profilePictureUrl != null && lead.profile_picture_url !== profilePictureUrl) {
        lead.profile_picture_url = profilePictureUrl;
        changed = true;
      }
      if (changed) {
        lead.updated_at = new Date().toISOString();
        await this.db.write();
      }
      return lead;
    }

    lead = await this.getLeadByJid(normalizedJid);
    if (lead) {
      let changed = false;
      if (lead.phone_number !== normalizedPhone) {
        lead.phone_number = normalizedPhone;
        changed = true;
      }
      if (contactName != null && lead.contact_name !== contactName) {
        lead.contact_name = contactName;
        changed = true;
      }
      if (profilePictureUrl != null && lead.profile_picture_url !== profilePictureUrl) {
        lead.profile_picture_url = profilePictureUrl;
        changed = true;
      }
      if (changed) {
        lead.updated_at = new Date().toISOString();
        await this.db.write();
      }
      return lead;
    }

    // Avoid race duplicate: re-check right before push (another call may have just created)
    await this.db.read();
    lead = await this.getLeadByPhone(normalizedPhone);
    if (lead) return lead;
    lead = await this.getLeadByJid(normalizedJid);
    if (lead) return lead;

    const id = randomUUID();
    const newLead = {
      id,
      phone_number: normalizedPhone,
      jid: normalizedJid || this.getCanonicalJid(normalizedPhone),
      contact_name: contactName || null,
      profile_picture_url: profilePictureUrl || null,
      reply_count: 0,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.db.data.leads.push(newLead);
    await this.db.write();
    return newLead;
  }

  async updateLeadJid(leadId, jid, clientId = 'default') {
    if (this.driver) return this.driver.updateLeadJid(leadId, jid, clientId);
    await this.db.read();
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (!lead) return null;
    const normalizedJid = this.toCanonicalJid(jid);
    if (normalizedJid && lead.jid !== normalizedJid) {
      lead.jid = normalizedJid;
      lead.updated_at = new Date().toISOString();
      await this.db.write();
    }
    return lead;
  }

  async updateLeadContactInfo(leadId, contactName, profilePictureUrl, jid = null, clientId = 'default') {
    if (this.driver) return this.driver.updateLeadContactInfo(leadId, contactName, profilePictureUrl, jid, clientId);
    await this.db.read();
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (lead) {
      if (contactName) lead.contact_name = contactName;
      if (profilePictureUrl) lead.profile_picture_url = profilePictureUrl;
      const canonical = this.toCanonicalJid(jid);
      if (canonical) lead.jid = canonical;
      lead.updated_at = new Date().toISOString();
      await this.db.write();
    }
    return lead;
  }

  async getOrCreateLead(phoneNumber, clientId = 'default') {
    if (this.driver) return this.driver.getOrCreateLead(phoneNumber, clientId);
    await this.db.read();
    // Normalize phone number first
    const normalized = this.normalizePhoneNumber(phoneNumber);
    
    // Try to find existing lead with normalized matching
    let lead = await this.getLeadByPhone(phoneNumber);
    
    if (!lead) {
      // Create new lead with normalized phone number
      lead = await this.createLead(normalized || phoneNumber);
    } else {
      // Update phone number to normalized format if different
      if (lead.phone_number !== normalized && normalized !== '') {
        lead.phone_number = normalized;
        await this.db.write();
      }
    }
    return lead;
  }

  async updateLeadStatus(leadId, status, clientId = 'default') {
    if (this.driver) return this.driver.updateLeadStatus(leadId, status, clientId);
    await this.db.read();
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (lead) {
      lead.status = status;
      lead.updated_at = new Date().toISOString();
      await this.db.write();
    }
  }

  async incrementReplyCount(leadId, clientId = 'default') {
    if (this.driver) return this.driver.incrementReplyCount(leadId, clientId);
    await this.db.read();
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (lead) {
      lead.reply_count = (lead.reply_count || 0) + 1;
      lead.status = 'replied';
      lead.updated_at = new Date().toISOString();
      await this.db.write();
    }
    return lead;
  }

  async getAllLeads(status = null, clientId = 'default') {
    if (this.driver) return this.driver.getAllLeads(status, clientId);
    // Always read fresh from disk to avoid stale data
    await this.db.read();
    let leads = [...this.db.data.leads];
    if (status) {
      leads = leads.filter(l => l.status === status);
    }
    // Sort by updated_at descending (most recent first)
    return leads.sort((a, b) => {
      const dateA = new Date(a.updated_at || a.created_at || 0);
      const dateB = new Date(b.updated_at || b.created_at || 0);
      return dateB.getTime() - dateA.getTime();
    });
  }

  async getLead(leadId, clientId = 'default') {
    if (this.driver) return this.driver.getLead(leadId, clientId);
    await this.db.read();
    return this.db.data.leads.find(l => l.id === leadId);
  }

  // Message operations
  async createMessage(leadId, sender, content, status = 'pending', messageTimestamp = null, clientId = 'default') {
    if (this.driver) return this.driver.createMessage(leadId, sender, content, status, messageTimestamp, clientId);
    await this.db.read();
    const id = randomUUID();
    const timestamp = messageTimestamp || new Date().toISOString();
    const message = {
      id,
      lead_id: leadId,
      sender,
      content,
      status,
      timestamp
    };
    this.db.data.messages.push(message);
    
    // Update lead's updated_at to move chat to top (use message timestamp)
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (lead) {
      lead.updated_at = timestamp; // Use message timestamp, not current time
    }
    
    await this.db.write();
    return message;
  }

  async getMessagesByLead(leadId, clientId = 'default') {
    if (this.driver) return this.driver.getMessagesByLead(leadId, clientId);
    await this.db.read();
    const messages = this.db.data.messages
      .filter(m => m.lead_id === leadId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Removed verbose logging - only log if needed for debugging
    // console.log(`📬 Retrieved ${messages.length} messages for lead ${leadId}`);
    return messages;
  }

  async deleteLead(leadId, clientId = 'default') {
    if (this.driver) return this.driver.deleteLead(leadId, clientId);
    await this.db.read();
    // Remove lead
    this.db.data.leads = this.db.data.leads.filter(l => l.id !== leadId);
    // Remove all messages for this lead
    this.db.data.messages = this.db.data.messages.filter(m => m.lead_id !== leadId);
    await this.db.write();
  }

  async clearAllMessages(clientId = 'default') {
    if (this.driver) return this.driver.clearAllMessages(clientId);
    try {
      await this.db.read();
      const messageCount = this.db.data.messages ? this.db.data.messages.length : 0;
      
      // Ensure messages array exists
      if (!this.db.data.messages) {
        this.db.data.messages = [];
      } else {
        this.db.data.messages = [];
      }
      
      await this.db.write();
      console.log(`🧹 Cleared ${messageCount} messages from database`);
      return messageCount;
    } catch (error) {
      console.error('❌ Error clearing messages:', error);
      throw error;
    }
  }

  /** Clear everything: all leads and all messages. UI will be empty until new messages arrive. */
  async clearAll(clientId = 'default') {
    if (this.driver) return this.driver.clearAll(clientId);
    try {
      await this.db.read();
      const leadCount = this.db.data.leads ? this.db.data.leads.length : 0;
      const messageCount = this.db.data.messages ? this.db.data.messages.length : 0;

      this.db.data.leads = [];
      this.db.data.messages = [];

      await this.db.write();
      console.log(`🧹 Cleared ${leadCount} leads and ${messageCount} messages - fresh start`);
      return { leadCount, messageCount };
    } catch (error) {
      console.error('❌ Error clearing all:', error);
      throw error;
    }
  }

  async updateMessageStatus(messageId, status, clientId = 'default') {
    if (this.driver) return this.driver.updateMessageStatus(messageId, status, clientId);
    await this.db.read();
    const message = this.db.data.messages.find(m => m.id === messageId);
    if (message) {
      message.status = status;
      await this.db.write();
    }
  }

  // Settings operations
  async getSetting(key, clientId = 'default') {
    if (this.driver) return this.driver.getSetting(key, clientId);
    await this.db.read();
    return this.db.data.settings[key] || null;
  }

  async setSetting(key, value, clientId = 'default') {
    if (this.driver) return this.driver.setSetting(key, value, clientId);
    await this.db.read();
    this.db.data.settings[key] = value;
    await this.db.write();
  }

  async getAllSettings(clientId = 'default') {
    if (this.driver) return this.driver.getAllSettings(clientId);
    await this.db.read();
    return { ...this.db.data.settings };
  }

  // Product information operations
  async getProductInfo(clientId = 'default') {
    if (this.driver) return this.driver.getProductInfo(clientId);
    return await this.getSetting('product_info', clientId) || '';
  }

  async setProductInfo(productInfo, clientId = 'default') {
    await this.setSetting('product_info', productInfo, clientId);
  }

  // Bot logs
  async addLog(action, details = null, clientId = 'default') {
    if (this.driver) return this.driver.addLog(action, details, clientId);
    await this.db.read();
    const log = {
      id: this.db.data.bot_logs.length + 1,
      action,
      details: details ? JSON.stringify(details) : null,
      timestamp: new Date().toISOString()
    };
    this.db.data.bot_logs.push(log);
    await this.db.write();
  }

  async getRecentLogs(limit = 20, clientId = 'default') {
    if (this.driver) return this.driver.getRecentLogs(limit, clientId);
    await this.db.read();
    return this.db.data.bot_logs
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  /** Prune messages older than N days to save space. No-op for JSON DB if days not set; use for Postgres. */
  async pruneOldMessages(olderThanDays = 5, clientId = 'default') {
    if (this.driver) return this.driver.pruneOldMessages(olderThanDays, clientId);
    try {
      await this.db.read();
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - olderThanDays);
      const before = (this.db.data.messages || []).length;
      this.db.data.messages = (this.db.data.messages || []).filter(
        (m) => new Date(m.timestamp) >= cutoff
      );
      const removed = before - this.db.data.messages.length;
      if (removed > 0) {
        await this.db.write();
        console.log(`🧹 Pruned ${removed} old messages (older than ${olderThanDays} days)`);
      }
      return removed;
    } catch (error) {
      console.error('❌ Error pruning messages:', error);
      return 0;
    }
  }

  close() {
    if (this.driver) return this.driver.close();
    return Promise.resolve();
  }
}

export default Database;

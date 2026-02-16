import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Database {
  constructor(dbPath) {
    // Ensure data directory exists
    const dbDir = join(__dirname, '..', 'data');
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
    }

    const fullPath = join(dbDir, dbPath || 'shield.json');
    const adapter = new JSONFile(fullPath);
    this.db = new Low(adapter, {
      leads: [],
      messages: [],
      settings: {},
      bot_logs: []
    });
    
    this.init();
  }

  async init() {
    await this.db.read();
    
    // Initialize default settings if empty
    if (Object.keys(this.db.data.settings).length === 0) {
      this.db.data.settings = {
        max_replies_per_lead: '5',
        min_delay_seconds: '3',
        max_delay_seconds: '10',
        auto_reply_enabled: 'true',
        primary_link: 'https://example.com',
        backup_link: '',
        bot_paused: 'false',
        ai_enabled: 'false',
        openrouter_api_key: '',
        ai_model: 'openai/gpt-3.5-turbo'
      };
      await this.db.write();
    }
    
    console.log('Connected to JSON database');
  }

  // Lead operations
  // Normalize phone number for consistent matching
  normalizePhoneNumber(phoneNumber) {
    if (!phoneNumber) return '';
    // Remove +, spaces, dashes, parentheses
    return phoneNumber.replace(/^\+/, '').replace(/[\s\-()]/g, '');
  }

  async getLeadByPhone(phoneNumber) {
    await this.db.read();
    const normalized = this.normalizePhoneNumber(phoneNumber);
    
    // First try exact match
    let lead = this.db.data.leads.find(l => l.phone_number === phoneNumber);
    
    // If not found, try normalized match
    if (!lead) {
      lead = this.db.data.leads.find(l => {
        const existingNormalized = this.normalizePhoneNumber(l.phone_number);
        return existingNormalized === normalized && normalized !== '';
      });
    }
    
    return lead || null;
  }

  async createLead(phoneNumber, contactName = null, profilePictureUrl = null) {
    await this.db.read();
    const id = randomUUID();
    const lead = {
      id,
      phone_number: phoneNumber,
      contact_name: contactName || null,
      profile_picture_url: profilePictureUrl || null,
      reply_count: 0,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    this.db.data.leads.push(lead);
    await this.db.write();
    return lead;
  }

  async updateLeadContactInfo(leadId, contactName, profilePictureUrl) {
    await this.db.read();
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (lead) {
      if (contactName) lead.contact_name = contactName;
      if (profilePictureUrl) lead.profile_picture_url = profilePictureUrl;
      lead.updated_at = new Date().toISOString();
      await this.db.write();
    }
    return lead;
  }

  async getOrCreateLead(phoneNumber) {
    await this.db.read();
    // Normalize phone number first
    const normalized = this.normalizePhoneNumber(phoneNumber);
    
    // Try to find existing lead with normalized matching
    let lead = this.getLeadByPhone(phoneNumber);
    
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

  async updateLeadStatus(leadId, status) {
    await this.db.read();
    const lead = this.db.data.leads.find(l => l.id === leadId);
    if (lead) {
      lead.status = status;
      lead.updated_at = new Date().toISOString();
      await this.db.write();
    }
  }

  async incrementReplyCount(leadId) {
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

  async getAllLeads(status = null) {
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

  async getLead(leadId) {
    await this.db.read();
    return this.db.data.leads.find(l => l.id === leadId);
  }

  // Message operations
  async createMessage(leadId, sender, content, status = 'pending', messageTimestamp = null) {
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

  async getMessagesByLead(leadId) {
    await this.db.read();
    const messages = this.db.data.messages
      .filter(m => m.lead_id === leadId)
      .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    
    // Removed verbose logging - only log if needed for debugging
    // console.log(`📬 Retrieved ${messages.length} messages for lead ${leadId}`);
    return messages;
  }

  async deleteLead(leadId) {
    await this.db.read();
    // Remove lead
    this.db.data.leads = this.db.data.leads.filter(l => l.id !== leadId);
    // Remove all messages for this lead
    this.db.data.messages = this.db.data.messages.filter(m => m.lead_id !== leadId);
    await this.db.write();
  }

  async updateMessageStatus(messageId, status) {
    await this.db.read();
    const message = this.db.data.messages.find(m => m.id === messageId);
    if (message) {
      message.status = status;
      await this.db.write();
    }
  }

  // Settings operations
  async getSetting(key) {
    await this.db.read();
    return this.db.data.settings[key] || null;
  }

  async setSetting(key, value) {
    await this.db.read();
    this.db.data.settings[key] = value;
    await this.db.write();
  }

  async getAllSettings() {
    await this.db.read();
    return { ...this.db.data.settings };
  }

  // Templates operations (stored in settings as JSON)
  async getTemplates() {
    const templatesJson = await this.getSetting('templates');
    if (templatesJson) {
      return JSON.parse(templatesJson);
    }
    return [
      'Hi! Thanks for reaching out. Check this out: {{link}}',
      'Hello! Interested? Visit: {{link}}',
      'Thanks for your message! Learn more here: {{link}}'
    ];
  }

  async setTemplates(templates) {
    await this.setSetting('templates', JSON.stringify(templates));
  }

  // Bot logs
  async addLog(action, details = null) {
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

  async getRecentLogs(limit = 20) {
    await this.db.read();
    return this.db.data.bot_logs
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);
  }

  close() {
    return Promise.resolve();
  }
}

export default Database;

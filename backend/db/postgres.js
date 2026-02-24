/**
 * PostgreSQL driver for Shield.
 * Used when DATABASE_URL is set. Provides persistent storage and session storage for production.
 */
import pg from 'pg';
import { randomUUID } from 'crypto';

const { Pool } = pg;

const DEFAULT_SETTINGS = {
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
  saved_audios: '[]',
};

export function createPool(databaseUrl) {
  return new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

export async function runMigrations(pool) {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        id TEXT PRIMARY KEY,
        phone_number TEXT NOT NULL,
        jid TEXT,
        contact_name TEXT,
        profile_picture_url TEXT,
        reply_count INTEGER DEFAULT 0,
        status TEXT DEFAULT 'pending',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        lead_id TEXT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        timestamp TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_lead_id ON messages(lead_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS bot_logs (
        id SERIAL PRIMARY KEY,
        action TEXT NOT NULL,
        details TEXT,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS auth_creds (
        session_name TEXT PRIMARY KEY,
        data JSONB NOT NULL
      );

      CREATE TABLE IF NOT EXISTS auth_keys (
        session_name TEXT NOT NULL,
        key_name TEXT NOT NULL,
        data JSONB,
        PRIMARY KEY (session_name, key_name)
      );
    `);
  } finally {
    client.release();
  }
}

/** Normalize JID (strip device suffix, keep domain). */
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const atIdx = jid.indexOf('@');
  if (atIdx < 0) return null;
  const phonePart = jid.slice(0, atIdx).split(':')[0];
  const domain = jid.slice(atIdx + 1);
  if (!domain) return null;
  const normalized = normalizePhoneNumber(phonePart);
  return normalized ? `${normalized}@${domain}` : null;
}

function normalizePhoneNumber(phoneNumber) {
  if (!phoneNumber) return '';
  let normalized = String(phoneNumber).split('@')[0];
  if (normalized.includes(':')) normalized = normalized.split(':')[0];
  normalized = normalized.replace(/\D/g, '');
  if (normalized.length > 10 && normalized.startsWith('0')) normalized = normalized.slice(1);
  if (normalized.length < 7 || normalized.length > 15) return '';
  return normalized;
}

function getCanonicalJid(phoneNumber, existingJid = null) {
  if (!phoneNumber) return null;
  const n = normalizePhoneNumber(phoneNumber);
  if (!n) return null;
  if (existingJid) {
    const norm = normalizeJid(existingJid);
    if (norm && norm.includes('@')) {
      const domain = norm.split('@')[1];
      if (domain) return `${n}@${domain}`;
    }
  }
  return `${n}@s.whatsapp.net`;
}

export class PostgresDriver {
  constructor(databaseUrl) {
    this.pool = createPool(databaseUrl);
    this.initPromise = this._init();
  }

  async _init() {
    await runMigrations(this.pool);
    await this._ensureDefaultSettings();
    console.log('Connected to PostgreSQL database');
  }

  async _ensureDefaultSettings() {
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT COUNT(*)::int AS c FROM settings');
      if (r.rows[0].c > 0) {
        const defaults = {
          keyword_replies: '[]',
          saved_audios: '[]',
          view_delay_min_seconds: '1',
          view_delay_max_seconds: '5',
          typing_indicator_enabled: 'true',
        };
        for (const [k, v] of Object.entries(defaults)) {
          await client.query(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
            [k, v]
          );
        }
        return;
      }
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        await client.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [k, v]);
      }
    } finally {
      client.release();
    }
  }

  _waitInit() {
    return this.initPromise;
  }

  normalizeJid(jid) {
    return normalizeJid(jid);
  }
  getCanonicalJid(phoneNumber, existingJid = null) {
    return getCanonicalJid(phoneNumber, existingJid);
  }
  toCanonicalJid(jid) {
    return normalizeJid(jid);
  }
  normalizePhoneNumber(phoneNumber) {
    return normalizePhoneNumber(phoneNumber);
  }

  async getLeadByPhone(phoneNumber) {
    await this._waitInit();
    const normalized = normalizePhoneNumber(phoneNumber);
    if (!normalized) return null;
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        'SELECT * FROM leads WHERE phone_number = $1 OR phone_number = $2 LIMIT 1',
        [phoneNumber, normalized]
      );
      if (r.rows.length > 0) return this._rowToLead(r.rows[0]);
      const r2 = await client.query('SELECT * FROM leads');
      for (const row of r2.rows) {
        const p = normalizePhoneNumber(row.phone_number);
        if (p === normalized || (p && normalized && (p.endsWith(normalized) || normalized.endsWith(p))))
          return this._rowToLead(row);
      }
      return null;
    } finally {
      client.release();
    }
  }

  _rowToLead(row) {
    return {
      id: row.id,
      phone_number: row.phone_number,
      jid: row.jid,
      contact_name: row.contact_name,
      profile_picture_url: row.profile_picture_url,
      reply_count: row.reply_count ?? 0,
      status: row.status || 'pending',
      created_at: row.created_at?.toISOString?.() || row.created_at,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  async getLeadByJid(jid) {
    await this._waitInit();
    const normalizedJid = normalizeJid(jid);
    if (!normalizedJid) return null;
    const client = await this.pool.connect();
    try {
      let r = await client.query('SELECT * FROM leads WHERE jid = $1 LIMIT 1', [normalizedJid]);
      if (r.rows.length > 0) return this._rowToLead(r.rows[0]);
      const phonePart = normalizedJid.slice(0, normalizedJid.indexOf('@'));
      const normalized = normalizePhoneNumber(phonePart);
      if (!normalized) return null;
      const lead = await this.getLeadByPhone(normalized);
      if (lead && lead.jid !== normalizedJid) {
        await client.query('UPDATE leads SET jid = $1, updated_at = NOW() WHERE id = $2', [normalizedJid, lead.id]);
        lead.jid = normalizedJid;
      }
      return lead;
    } finally {
      client.release();
    }
  }

  async findAllLeadsForContact(normalizedPhone, normalizedJid) {
    await this._waitInit();
    const normalized = normalizePhoneNumber(normalizedPhone);
    if (!normalized && !normalizedJid) return [];
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT * FROM leads');
      const out = [];
      const ids = new Set();
      for (const row of r.rows) {
        const lead = this._rowToLead(row);
        const matchJid = normalizedJid && lead.jid && normalizeJid(lead.jid) === normalizedJid;
        const p = normalizePhoneNumber(lead.phone_number);
        const matchPhone = normalized && p && (p === normalized || p.endsWith(normalized) || normalized.endsWith(p));
        if ((matchJid || matchPhone) && !ids.has(lead.id)) {
          ids.add(lead.id);
          out.push(lead);
        }
      }
      return out;
    } finally {
      client.release();
    }
  }

  async mergeLeads(leads, preferredPrimaryId = null) {
    if (!leads || leads.length <= 1) return leads?.[0] || null;
    await this._waitInit();
    let primary = preferredPrimaryId ? leads.find((l) => l.id === preferredPrimaryId) : null;
    if (!primary) primary = leads.find((l) => l.contact_name || l.profile_picture_url) || leads[0];
    if (!primary) primary = leads[0];
    const primaryId = primary.id;
    const others = leads.filter((l) => l.id !== primaryId);
    let totalReplies = (primary.reply_count || 0);
    let contactName = primary.contact_name;
    let profilePictureUrl = primary.profile_picture_url;
    const client = await this.pool.connect();
    try {
      for (const other of others) {
        await client.query('UPDATE messages SET lead_id = $1 WHERE lead_id = $2', [primaryId, other.id]);
        totalReplies += (other.reply_count || 0);
        if (other.contact_name && !contactName) contactName = other.contact_name;
        if (other.profile_picture_url && !profilePictureUrl) profilePictureUrl = other.profile_picture_url;
        await client.query('DELETE FROM leads WHERE id = $1', [other.id]);
      }
      await client.query(
        `UPDATE leads SET reply_count = $1, contact_name = COALESCE(NULLIF(contact_name,''), $2), profile_picture_url = COALESCE(NULLIF(profile_picture_url,''), $3), updated_at = NOW() WHERE id = $4`,
        [totalReplies, contactName, profilePictureUrl, primaryId]
      );
      const r = await client.query('SELECT * FROM leads WHERE id = $1', [primaryId]);
      return r.rows[0] ? this._rowToLead(r.rows[0]) : primary;
    } finally {
      client.release();
    }
  }

  async createLead(phoneNumber, contactName = null, profilePictureUrl = null, jid = null) {
    await this._waitInit();
    const normalizedPhone = normalizePhoneNumber(phoneNumber) || phoneNumber;
    const normalizedJid = (jid ? normalizeJid(jid) : null) || getCanonicalJid(normalizedPhone);

    let lead = await this.getLeadByPhone(normalizedPhone);
    if (lead) {
      const client = await this.pool.connect();
      try {
        await client.query(
          'UPDATE leads SET jid = COALESCE($1, jid), contact_name = COALESCE($2, contact_name), profile_picture_url = COALESCE($3, profile_picture_url), updated_at = NOW() WHERE id = $4',
          [normalizedJid, contactName, profilePictureUrl, lead.id]
        );
      } finally {
        client.release();
      }
      return this.getLeadByPhone(normalizedPhone);
    }

    lead = await this.getLeadByJid(normalizedJid);
    if (lead) {
      const client = await this.pool.connect();
      try {
        await client.query(
          'UPDATE leads SET phone_number = $1, contact_name = COALESCE($2, contact_name), profile_picture_url = COALESCE($3, profile_picture_url), updated_at = NOW() WHERE id = $4',
          [normalizedPhone, contactName, profilePictureUrl, lead.id]
        );
      } finally {
        client.release();
      }
      return this.getLeadByJid(normalizedJid);
    }

    const id = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO leads (id, phone_number, jid, contact_name, profile_picture_url, reply_count, status, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, 0, 'pending', NOW(), NOW())`,
        [id, normalizedPhone, normalizedJid, contactName, profilePictureUrl]
      );
    } finally {
      client.release();
    }
    return this.getLead(id);
  }

  async updateLeadJid(leadId, jid) {
    await this._waitInit();
    const normalizedJid = normalizeJid(jid);
    if (!normalizedJid) return null;
    const client = await this.pool.connect();
    try {
      await client.query('UPDATE leads SET jid = $1, updated_at = NOW() WHERE id = $2', [normalizedJid, leadId]);
    } finally {
      client.release();
    }
    return this.getLead(leadId);
  }

  async updateLeadContactInfo(leadId, contactName, profilePictureUrl, jid = null) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const updates = ['updated_at = NOW()'];
      const values = [];
      let i = 1;
      if (contactName) {
        updates.push(`contact_name = $${i++}`);
        values.push(contactName);
      }
      if (profilePictureUrl) {
        updates.push(`profile_picture_url = $${i++}`);
        values.push(profilePictureUrl);
      }
      if (jid && normalizeJid(jid)) {
        updates.push(`jid = $${i++}`);
        values.push(normalizeJid(jid));
      }
      values.push(leadId);
      await client.query(`UPDATE leads SET ${updates.join(', ')} WHERE id = $${i}`, values);
    } finally {
      client.release();
    }
    return this.getLead(leadId);
  }

  async getOrCreateLead(phoneNumber) {
    await this._waitInit();
    const normalized = normalizePhoneNumber(phoneNumber);
    let lead = await this.getLeadByPhone(phoneNumber);
    if (!lead) lead = await this.createLead(normalized || phoneNumber);
    else if (lead.phone_number !== normalized && normalized !== '') {
      const client = await this.pool.connect();
      try {
        await client.query('UPDATE leads SET phone_number = $1, updated_at = NOW() WHERE id = $2', [normalized, lead.id]);
      } finally {
        client.release();
      }
    }
    return lead;
  }

  async updateLeadStatus(leadId, status) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query('UPDATE leads SET status = $1, updated_at = NOW() WHERE id = $2', [status, leadId]);
    } finally {
      client.release();
    }
  }

  async incrementReplyCount(leadId) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query(
        "UPDATE leads SET reply_count = COALESCE(reply_count,0) + 1, status = 'replied', updated_at = NOW() WHERE id = $1",
        [leadId]
      );
    } finally {
      client.release();
    }
    return this.getLead(leadId);
  }

  async getAllLeads(status = null) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = status
        ? await client.query('SELECT * FROM leads WHERE status = $1 ORDER BY updated_at DESC', [status])
        : await client.query('SELECT * FROM leads ORDER BY updated_at DESC');
      return r.rows.map((row) => this._rowToLead(row));
    } finally {
      client.release();
    }
  }

  async getLead(leadId) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT * FROM leads WHERE id = $1', [leadId]);
      return r.rows[0] ? this._rowToLead(r.rows[0]) : null;
    } finally {
      client.release();
    }
  }

  async createMessage(leadId, sender, content, status = 'pending', messageTimestamp = null) {
    await this._waitInit();
    const id = randomUUID();
    const timestamp = messageTimestamp || new Date().toISOString();
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO messages (id, lead_id, sender, content, status, timestamp) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)',
        [id, leadId, sender, content, status, timestamp]
      );
      await client.query('UPDATE leads SET updated_at = $1::timestamptz WHERE id = $2', [timestamp, leadId]);
    } finally {
      client.release();
    }
    return { id, lead_id: leadId, sender, content, status, timestamp };
  }

  async getMessagesByLead(leadId) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        'SELECT id, lead_id, sender, content, status, timestamp FROM messages WHERE lead_id = $1 ORDER BY timestamp ASC',
        [leadId]
      );
      return r.rows.map((row) => ({
        id: row.id,
        lead_id: row.lead_id,
        sender: row.sender,
        content: row.content,
        status: row.status,
        timestamp: row.timestamp?.toISOString?.() || row.timestamp,
      }));
    } finally {
      client.release();
    }
  }

  async deleteLead(leadId) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM messages WHERE lead_id = $1', [leadId]);
      await client.query('DELETE FROM leads WHERE id = $1', [leadId]);
    } finally {
      client.release();
    }
  }

  async clearAllMessages() {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query('DELETE FROM messages RETURNING id');
      console.log(`🧹 Cleared ${r.rowCount} messages from database`);
      return r.rowCount;
    } finally {
      client.release();
    }
  }

  async clearAll() {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const rLeads = await client.query('DELETE FROM leads RETURNING id');
      const rMsg = await client.query('DELETE FROM messages RETURNING id');
      console.log(`🧹 Cleared ${rLeads.rowCount} leads and ${rMsg.rowCount} messages - fresh start`);
      return { leadCount: rLeads.rowCount, messageCount: rMsg.rowCount };
    } finally {
      client.release();
    }
  }

  async updateMessageStatus(messageId, status) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query('UPDATE messages SET status = $1 WHERE id = $2', [status, messageId]);
    } finally {
      client.release();
    }
  }

  async getSetting(key) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT value FROM settings WHERE key = $1', [key]);
      return r.rows[0]?.value ?? null;
    } finally {
      client.release();
    }
  }

  async setSetting(key, value) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, value]
      );
    } finally {
      client.release();
    }
  }

  async getAllSettings() {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query('SELECT key, value FROM settings');
      const out = {};
      for (const row of r.rows) out[row.key] = row.value;
      return out;
    } finally {
      client.release();
    }
  }

  async getProductInfo() {
    return (await this.getSetting('product_info')) || '';
  }

  async setProductInfo(productInfo) {
    return this.setSetting('product_info', productInfo);
  }

  async addLog(action, details = null) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query(
        'INSERT INTO bot_logs (action, details, timestamp) VALUES ($1, $2, NOW())',
        [action, details ? JSON.stringify(details) : null]
      );
    } finally {
      client.release();
    }
  }

  async getRecentLogs(limit = 20) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        'SELECT id, action, details, timestamp FROM bot_logs ORDER BY timestamp DESC LIMIT $1',
        [limit]
      );
      return r.rows.map((row) => ({
        id: row.id,
        action: row.action,
        details: row.details,
        timestamp: row.timestamp?.toISOString?.() || row.timestamp,
      }));
    } finally {
      client.release();
    }
  }

  /** Prune messages older than N days to save space. Returns number of rows deleted. */
  async pruneOldMessages(olderThanDays = 5) {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        "DELETE FROM messages WHERE timestamp < NOW() - ($1::text || ' days')::interval RETURNING id",
        [olderThanDays]
      );
      if (r.rowCount > 0) console.log(`🧹 Pruned ${r.rowCount} old messages (older than ${olderThanDays} days)`);
      return r.rowCount;
    } finally {
      client.release();
    }
  }

  getPool() {
    return this.pool;
  }

  /** Clear Baileys auth state for a session (on logout). */
  async clearSessionAuth(sessionName = 'shield-session') {
    await this._waitInit();
    const client = await this.pool.connect();
    try {
      await client.query('DELETE FROM auth_keys WHERE session_name = $1', [sessionName]);
      await client.query('DELETE FROM auth_creds WHERE session_name = $1', [sessionName]);
      console.log('🧹 Cleared session auth from PostgreSQL');
    } finally {
      client.release();
    }
  }

  async close() {
    await this.pool.end();
  }
}

/**
 * Merge duplicate leads caused by JID variants (e.g. phone:12@s.whatsapp.net vs phone@s.whatsapp.net).
 * Run ONCE after deploying JID normalization fixes. Backup your DB first.
 *
 * Usage: node cleanup-duplicates.js
 * (Stop the backend first; backup: cp data/shield.json data/shield.json.backup)
 */

import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || 'shield.json';
const file = join(__dirname, 'data', dbPath);
const adapter = new JSONFile(file);
const db = new Low(adapter, { leads: [], messages: [], settings: {}, bot_logs: [] });

/** Always ${phoneNumber}@s.whatsapp.net. No device suffix, no @lid. */
function normalizeJid(jid) {
  if (!jid || typeof jid !== 'string') return null;
  const atIdx = jid.indexOf('@');
  if (atIdx < 0) return null;
  const phonePart = jid.slice(0, atIdx).split(':')[0];
  const normalized = normalizePhone(phonePart);
  return normalized ? `${normalized}@s.whatsapp.net` : null;
}

function normalizePhone(phone) {
  if (!phone) return '';
  let n = String(phone).replace(/^\+/, '').replace(/[\s\-()]/g, '');
  if (n.includes(':')) n = n.split(':')[0];
  return n;
}

function toCanonicalJid(jid) {
  return normalizeJid(jid);
}

async function cleanupDuplicates() {
  await db.read();

  if (!db.data.leads) db.data.leads = [];
  if (!db.data.messages) db.data.messages = [];

  console.log('🧹 Duplicate lead cleanup\n');
  console.log(`   DB: ${file}`);
  console.log(`   Leads before: ${db.data.leads.length}`);
  console.log(`   Messages before: ${db.data.messages.length}\n`);

  const byPhone = new Map();
  for (const lead of db.data.leads) {
    const phone = normalizePhone(lead.phone_number);
    if (!phone) continue;
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(lead);
  }

  const toKeep = [];
  let removed = 0;

  for (const [phone, leads] of byPhone) {
    if (leads.length === 1) {
      const lead = leads[0];
      lead.jid = toCanonicalJid(lead.jid) || `${normalizePhone(lead.phone_number)}@s.whatsapp.net`;
      lead.phone_number = normalizePhone(lead.phone_number) || lead.phone_number;
      toKeep.push(lead);
      continue;
    }

    console.log(`🔀 ${leads.length} leads for phone ${phone}`);

    let primary = leads[0];
    for (const l of leads) {
      if (l.contact_name || l.profile_picture_url || l.jid) {
        primary = l;
        break;
      }
    }

    primary.jid = toCanonicalJid(primary.jid) || `${phone}@s.whatsapp.net`;
    primary.phone_number = normalizePhone(primary.phone_number) || primary.phone_number;

    for (const dup of leads) {
      if (dup.id === primary.id) continue;
      if (!primary.contact_name && dup.contact_name) primary.contact_name = dup.contact_name;
      if (!primary.profile_picture_url && dup.profile_picture_url) primary.profile_picture_url = dup.profile_picture_url;
      primary.reply_count = (primary.reply_count || 0) + (dup.reply_count || 0);
      if (dup.created_at && new Date(dup.created_at) < new Date(primary.created_at)) primary.created_at = dup.created_at;
      if (dup.updated_at && new Date(dup.updated_at) > new Date(primary.updated_at)) primary.updated_at = dup.updated_at;

      const msgCount = db.data.messages.filter(m => m.lead_id === dup.id).length;
      if (msgCount > 0) {
        db.data.messages.forEach(m => {
          if (m.lead_id === dup.id) m.lead_id = primary.id;
        });
        console.log(`   📨 Reassigned ${msgCount} messages from ${dup.id} → ${primary.id}`);
      }
      removed++;
      console.log(`   🗑️  Removed duplicate lead: ${dup.id}`);
    }
    toKeep.push(primary);
    console.log(`   ✅ Kept: ${primary.id} (${primary.contact_name || primary.phone_number})\n`);
  }

  db.data.leads = toKeep;
  await db.write();

  console.log('✅ Done\n');
  console.log(`   Leads after: ${db.data.leads.length}`);
  console.log(`   Leads removed: ${removed}`);
  console.log(`   Messages: ${db.data.messages.length}`);
  console.log('\n💡 Restart the backend to use the cleaned data.');
}

cleanupDuplicates().catch((err) => {
  console.error('❌', err);
  process.exit(1);
});

/**
 * Test script to verify WhatsApp connection setup
 * Run with: node test-connection.js
 */

import { fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { existsSync, readdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testConnection() {
  console.log('\n═══════════════════════════════════════');
  console.log('🧪 Testing WhatsApp Connection Setup');
  console.log('═══════════════════════════════════════\n');

  // Test 1: Fetch latest version
  console.log('1️⃣ Testing version fetch...');
  try {
    const versionData = await fetchLatestBaileysVersion();
    console.log('   ✅ Latest version:', versionData.version);
    console.log   ('   ✅ Version fetch successful\n');
  } catch (error) {
    console.error('   ❌ Version fetch failed:', error.message);
    return false;
  }

  // Test 2: Check session folder
  console.log('2️⃣ Testing session folder...');
  const sessionPath = join(__dirname, 'sessions', 'shield-session');
  const sessionDir = join(__dirname, 'sessions');
  
  if (existsSync(sessionPath)) {
    const files = readdirSync(sessionPath);
    console.log('   📂 Session folder exists');
    console.log('   📄 Files:', files.length);
    if (files.length > 0) {
      console.log('   📋 Files:', files.join(', '));
    }
  } else {
    console.log('   📂 Session folder does not exist (will be created on first run)');
  }
  console.log('   ✅ Session folder check complete\n');

  // Test 3: Clean session if needed
  console.log('3️⃣ Testing session cleanup...');
  if (existsSync(sessionPath)) {
    try {
      rmSync(sessionPath, { recursive: true, force: true });
      console.log('   ✅ Session folder cleaned');
    } catch (error) {
      console.error('   ⚠️ Could not clean session:', error.message);
    }
  } else {
    console.log('   ✅ No session to clean');
  }
  console.log('   ✅ Session cleanup test complete\n');

  // Test 4: Verify imports
  console.log('4️⃣ Testing imports...');
  try {
    const { useMultiFileAuthState } = await import('@whiskeysockets/baileys');
    console.log('   ✅ useMultiFileAuthState imported');
    
    const { makeWASocket } = await import('@whiskeysockets/baileys');
    console.log('   ✅ makeWASocket imported');
    
    const { DisconnectReason } = await import('@whiskeysockets/baileys');
    console.log('   ✅ DisconnectReason imported');
    
    console.log('   ✅ All imports successful\n');
  } catch (error) {
    console.error('   ❌ Import failed:', error.message);
    return false;
  }

  console.log('═══════════════════════════════════════');
  console.log('✅ All tests passed!');
  console.log('✅ Ready to initialize WhatsApp connection');
  console.log('═══════════════════════════════════════\n');

  return true;
}

testConnection().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  console.error('\n❌ Test failed:', error);
  process.exit(1);
});


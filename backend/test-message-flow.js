/**
 * Test Script: Message Flow Verification
 * 
 * This script tests the complete flow:
 * 1. Backend receives message from WhatsApp (messages.upsert)
 * 2. Backend processes and stores message
 * 3. Backend emits WebSocket event to frontend
 * 4. Frontend receives and displays message
 * 
 * Usage:
 *   cd backend
 *   node test-message-flow.js
 *   node test-message-flow.js --send <phoneNumber> "<message>"
 * 
 * Example:
 *   node test-message-flow.js --send 1234567890 "Hello test"
 */

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3002';

console.log('\n═══════════════════════════════════════════════════════════');
console.log('🧪 Testing Message Flow: WhatsApp → Backend → Frontend');
console.log('═══════════════════════════════════════════════════════════\n');

// Test 1: Check backend is running
async function testBackendHealth() {
  console.log('1️⃣ Testing backend health...');
  try {
    const res = await fetch(`${BACKEND_URL}/api/health`);
    if (res.ok) {
      const data = await res.json();
      console.log('   ✅ Backend is running');
      console.log(`   Status: ${data.status}`);
      return true;
    } else {
      console.log('   ❌ Backend returned error:', res.status);
      return false;
    }
  } catch (error) {
    console.log('   ❌ Backend not reachable:', error.message);
    console.log(`   💡 Make sure backend is running on ${BACKEND_URL}`);
    return false;
  }
}

// Test 2: Check WhatsApp connection status
async function testWhatsAppConnection() {
  console.log('\n2️⃣ Testing WhatsApp connection...');
  try {
    const res = await fetch(`${BACKEND_URL}/api/bot/status`);
    if (res.ok) {
      const data = await res.json();
      console.log(`   Status: ${data.status}`);
      console.log(`   Connected: ${data.isConnected}`);
      console.log(`   Connection Time: ${data.connectionTime ? new Date(data.connectionTime).toISOString() : 'Not set'}`);
      
      if (data.isConnected && data.status === 'connected') {
        console.log('   ✅ WhatsApp is connected');
        return { connected: true, connectionTime: data.connectionTime };
      } else {
        console.log('   ⚠️ WhatsApp is not connected');
        console.log('   💡 Connect WhatsApp first, then run this test');
        return { connected: false, connectionTime: null };
      }
    } else {
      console.log('   ❌ Failed to get status:', res.status);
      return { connected: false, connectionTime: null };
    }
  } catch (error) {
    console.log('   ❌ Error checking status:', error.message);
    return { connected: false, connectionTime: null };
  }
}

// Test 3: Check WebSocket listener status
async function testWebSocketListeners() {
  console.log('\n3️⃣ Testing WebSocket listeners...');
  try {
    const res = await fetch(`${BACKEND_URL}/api/debug/listeners`);
    if (res.ok) {
      const data = await res.json();
      console.log(`   Socket exists: ${data.socketExists}`);
      console.log(`   Listeners attached: ${data.listenersAttached}`);
      console.log(`   Socket user ID: ${data.socketUserId || 'none'}`);
      console.log(`   Message received count: ${data.messageReceivedCount || 0}`);
      console.log(`   Last message time: ${data.lastMessageTime ? new Date(data.lastMessageTime).toISOString() : 'never'}`);
      
      if (data.socketExists && data.listenersAttached) {
        console.log('   ✅ WebSocket listeners are attached');
        return true;
      } else {
        console.log('   ⚠️ WebSocket listeners may not be attached');
        return false;
      }
    } else {
      console.log('   ❌ Failed to check listeners:', res.status);
      return false;
    }
  } catch (error) {
    console.log('   ❌ Error checking listeners:', error.message);
    return false;
  }
}

// Test 4: Send a test message (manual)
async function testSendMessage(phoneNumber, message) {
  console.log('\n4️⃣ Testing message sending...');
  try {
    const res = await fetch(`${BACKEND_URL}/api/messages/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumber, message })
    });
    
    if (res.ok) {
      const data = await res.json();
      console.log('   ✅ Message sent successfully');
      console.log(`   Lead ID: ${data.leadId}`);
      return { success: true, leadId: data.leadId };
    } else {
      const error = await res.text();
      console.log('   ❌ Failed to send message:', res.status);
      console.log('   Error:', error.substring(0, 200));
      return { success: false };
    }
  } catch (error) {
    console.log('   ❌ Error sending message:', error.message);
    return { success: false };
  }
}

// Test 5: Check if message was stored
async function testMessageStored(leadId) {
  console.log('\n5️⃣ Testing message storage...');
  try {
    const res = await fetch(`${BACKEND_URL}/api/leads/${leadId}`);
    if (res.ok) {
      const data = await res.json();
      console.log(`   Lead found: ${data.id}`);
      console.log(`   Phone: ${data.phone_number}`);
      console.log(`   Messages: ${data.messages?.length || 0}`);
      
      if (data.messages && data.messages.length > 0) {
        const lastMessage = data.messages[data.messages.length - 1];
        console.log(`   Last message: "${lastMessage.content?.substring(0, 50)}"`);
        console.log(`   Sender: ${lastMessage.sender}`);
        console.log(`   Timestamp: ${lastMessage.timestamp}`);
        console.log('   ✅ Message stored in database');
        return true;
      } else {
        console.log('   ⚠️ No messages found in lead');
        return false;
      }
    } else {
      console.log('   ❌ Failed to get lead:', res.status);
      return false;
    }
  } catch (error) {
    console.log('   ❌ Error checking message:', error.message);
    return false;
  }
}

// Main test flow
async function runTests() {
  const results = {
    backendHealth: false,
    whatsappConnected: false,
    listenersAttached: false,
    messageSent: false,
    messageStored: false
  };

  // Test 1: Backend health
  results.backendHealth = await testBackendHealth();
  if (!results.backendHealth) {
    console.log('\n❌ Backend is not running. Start it with: cd backend && npm start');
    return;
  }

  // Test 2: WhatsApp connection
  const connectionStatus = await testWhatsAppConnection();
  results.whatsappConnected = connectionStatus.connected;
  
  if (!results.whatsappConnected) {
    console.log('\n⚠️ WhatsApp is not connected. Connect it first, then run tests.');
    console.log('   The remaining tests will still run but may fail.');
  }

  // Test 3: WebSocket listeners
  results.listenersAttached = await testWebSocketListeners();

  // Test 4 & 5: Send and verify message (only if connected)
  if (results.whatsappConnected) {
    console.log('\n📝 To test message sending:');
    console.log('   Run: node test-message-flow.js --send <phoneNumber> "<message>"');
    console.log('   Example: node test-message-flow.js --send 1234567890 "Test message"');
    
    // Check if --send flag is provided
    const args = process.argv.slice(2);
    const sendIndex = args.indexOf('--send');
    if (sendIndex !== -1 && args.length > sendIndex + 2) {
      const phoneNumber = args[sendIndex + 1];
      const message = args[sendIndex + 2];
      
      const sendResult = await testSendMessage(phoneNumber, message);
      results.messageSent = sendResult.success;
      
      if (sendResult.success && sendResult.leadId) {
        // Wait a bit for message to be stored
        await new Promise(resolve => setTimeout(resolve, 1000));
        results.messageStored = await testMessageStored(sendResult.leadId);
      }
    }
  }

  // Summary
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('📊 Test Summary');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`   Backend Health: ${results.backendHealth ? '✅' : '❌'}`);
  console.log(`   WhatsApp Connected: ${results.whatsappConnected ? '✅' : '❌'}`);
  console.log(`   Listeners Attached: ${results.listenersAttached ? '✅' : '❌'}`);
  console.log(`   Message Sent: ${results.messageSent ? '✅' : '⏭️'}`);
  console.log(`   Message Stored: ${results.messageStored ? '✅' : '⏭️'}`);
  console.log('\n💡 Manual Testing Steps:');
  console.log('   1. Send a message from your phone to the WhatsApp number');
  console.log('   2. Check backend console for: "🔔🔔🔔 messages.upsert EVENT FIRED"');
  console.log('   3. Check backend console for: "📡 Emitting WebSocket event: new_message"');
  console.log('   4. Check frontend console (browser) for: "📨 new_message event received"');
  console.log('   5. Verify message appears in UI');
  console.log('\n📋 Flow Documentation: See MESSAGE_FLOW.md');
  console.log('═══════════════════════════════════════════════════════════\n');
}

// Run tests
runTests().catch(error => {
  console.error('\n❌ Test script error:', error);
  process.exit(1);
});

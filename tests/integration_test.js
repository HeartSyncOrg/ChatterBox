/**
 * ChatterBox Automated Integration Test Suite
 * Tests: HTTP Security Headers, Socket.IO Messaging, Anti-Spam Rate Limits,
 * Channel Lifecycle, and WebRTC VoIP Signaling Protocol.
 */

const { io } = require('socket.io-client');
const http = require('http');

const SERVER_URL = process.env.TEST_URL || 'http://localhost:3001';

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  ✅ PASS: ${testName}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${testName}`);
    failed++;
  }
}

async function runHTTPTests() {
  console.log('\n--- 1. HTTP Endpoint & Security Headers Tests ---');

  return new Promise((resolve) => {
    http.get(SERVER_URL, (res) => {
      assert(res.statusCode === 200, 'GET / returns HTTP 200 OK');
      assert(res.headers['x-content-type-options'] === 'nosniff', 'Headers contain X-Content-Type-Options: nosniff');
      assert(res.headers['x-frame-options'] === 'SAMEORIGIN', 'Headers contain X-Frame-Options: SAMEORIGIN');
      assert(typeof res.headers['content-security-policy'] === 'string', 'Headers contain Content-Security-Policy');

      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        assert(body.includes('ChatterBox'), 'HTML body contains "ChatterBox" branding');
        assert(body.includes('joinVoiceTopBtn'), 'HTML body contains VoIP voice controls');
        assert(!body.includes('exportChatBtn'), 'HTML body does NOT contain removed export button');
        resolve();
      });
    }).on('error', (err) => {
      console.error('HTTP connection error:', err);
      failed++;
      resolve();
    });
  });
}

async function runRealtimeMessagingTests() {
  console.log('\n--- 2. Real-Time Messaging & Reactions Tests ---');

  return new Promise((resolve) => {
    const alice = io(SERVER_URL, { transports: ['websocket'] });
    const bob = io(SERVER_URL, { transports: ['websocket'] });

    let aliceJoined = false;
    let bobJoined = false;
    let messageId = null;

    alice.on('connect', () => {
      alice.emit('join_room', { username: 'Alice', room: 'testing-room' });
    });

    alice.on('joined_room_success', ({ user, room }) => {
      assert(user.username === 'Alice', 'Alice joined room successfully');
      assert(room === 'testing-room', 'Alice room verified as "testing-room"');
      aliceJoined = true;
      if (aliceJoined && bobJoined) sendTestMessage();
    });

    bob.on('connect', () => {
      bob.emit('join_room', { username: 'Bob', room: 'testing-room' });
    });

    bob.on('joined_room_success', ({ user }) => {
      assert(user.username === 'Bob', 'Bob joined room successfully');
      bobJoined = true;
      if (aliceJoined && bobJoined) sendTestMessage();
    });

    function sendTestMessage() {
      alice.emit('send_message', { text: 'Hello Bob from automated test!' });
    }

    bob.on('new_message', (msg) => {
      if (msg.username === 'Alice') {
        assert(msg.text === 'Hello Bob from automated test!', 'Bob received Alice\'s real-time message');
        assert(typeof msg.senderId === 'string', 'Message has opaque public senderId');
        messageId = msg.id;

        // Test reaction
        bob.emit('toggle_reaction', { messageId, emoji: '🔥' });
      }
    });

    alice.on('reaction_updated', ({ messageId: rMsgId, reactions }) => {
      if (rMsgId === messageId && reactions['🔥']) {
        assert(reactions['🔥'].length === 1, 'Alice received reaction update for "🔥"');
        alice.disconnect();
        bob.disconnect();
        resolve();
      }
    });
  });
}

async function runAntiSpamTests() {
  console.log('\n--- 3. Anti-Spam Rate Limiting & Duplicate Detection Tests ---');

  return new Promise((resolve) => {
    const charlie = io(SERVER_URL, { transports: ['websocket'] });

    charlie.on('connect', () => {
      charlie.emit('join_room', { username: 'Charlie', room: 'spam-test' });
    });

    charlie.on('joined_room_success', () => {
      charlie.once('spam_warning', ({ text, cooldown }) => {
        assert(typeof text === 'string' && cooldown > 0, `Spam burst warning triggered: "${text.substring(0, 35)}..." (${cooldown}s cooldown)`);
        charlie.disconnect();
        resolve();
      });

      // Rapid burst send (4 messages within 50ms triggers rate limiter)
      charlie.emit('send_message', { text: 'Burst message 1' });
      charlie.emit('send_message', { text: 'Burst message 2' });
      charlie.emit('send_message', { text: 'Burst message 3' });
      charlie.emit('send_message', { text: 'Burst message 4' });
    });
  });
}

async function runChannelLifecycleTests() {
  console.log('\n--- 4. Channel Lifecycle & Protection Tests ---');

  return new Promise((resolve) => {
    const dave = io(SERVER_URL, { transports: ['websocket'] });

    dave.on('connect', () => {
      dave.emit('join_room', { username: 'Dave', room: 'deletable-room' });
    });

    dave.on('joined_room_success', ({ room }) => {
      if (room === 'deletable-room') {
        assert(true, 'Dave created and joined custom room "deletable-room"');

        // Test protecting default channels
        dave.emit('delete_room', { room: 'general' });
      } else if (room === 'general') {
        assert(true, 'Dave was automatically moved to "general" after room deletion');
        dave.disconnect();
        resolve();
      }
    });

    dave.on('system_message', (msg) => {
      if (msg.text.includes('Protected default channels cannot be deleted')) {
        assert(true, 'Server correctly blocked deletion of protected "#general" channel');

        // Now test deleting custom room
        dave.emit('delete_room', { room: 'deletable-room' });
      }
    });

    dave.on('room_deleted', ({ deletedRoom, fallbackRoom }) => {
      assert(deletedRoom === 'deletable-room' && fallbackRoom === 'general', 'Received room_deleted broadcast event');
      dave.emit('join_room', { username: 'Dave', room: fallbackRoom });
    });
  });
}

async function runVoIPSignalingTests() {
  console.log('\n--- 5. WebRTC VoIP Signaling & Control Protocol Tests ---');

  return new Promise((resolve) => {
    const voiceAlice = io(SERVER_URL, { transports: ['websocket'] });
    const voiceBob = io(SERVER_URL, { transports: ['websocket'] });

    let aliceSocketId = null;
    let bobSocketId = null;

    voiceAlice.on('connect', () => {
      aliceSocketId = voiceAlice.id;
      voiceAlice.emit('join_room', { username: 'VoiceAlice', room: 'voip-test-room' });
    });

    voiceBob.on('connect', () => {
      bobSocketId = voiceBob.id;
      voiceBob.emit('join_room', { username: 'VoiceBob', room: 'voip-test-room' });
    });

    voiceAlice.on('joined_room_success', () => {
      // Alice joins voice call
      voiceAlice.emit('join_voice');
    });

    voiceBob.on('joined_room_success', () => {
      // Bob joins voice call after Alice
      setTimeout(() => {
        voiceBob.emit('join_voice');
      }, 300);
    });

    voiceAlice.on('voice_peer_joined', (peer) => {
      assert(peer.username === 'VoiceBob', 'Alice received voice_peer_joined for VoiceBob');

      // Alice sends WebRTC offer to Bob
      voiceAlice.emit('voice_offer', {
        targetSocketId: peer.socketId,
        offer: { type: 'offer', sdp: 'v=0 mock sdp for testing' },
      });
    });

    voiceBob.on('voice_offer', ({ senderSocketId, offer }) => {
      assert(offer.type === 'offer', 'Bob received voice_offer via Socket.IO signaling');

      // Bob answers Alice's offer
      voiceBob.emit('voice_answer', {
        targetSocketId: senderSocketId,
        answer: { type: 'answer', sdp: 'v=0 mock answer sdp' },
      });
    });

    voiceAlice.on('voice_answer', ({ senderSocketId, answer }) => {
      assert(answer.type === 'answer', 'Alice received voice_answer from Bob');

      // Alice sends ICE candidate
      voiceAlice.emit('voice_ice_candidate', {
        targetSocketId: senderSocketId,
        candidate: { candidate: 'candidate:mock', sdpMid: '0', sdpMLineIndex: 0 },
      });
    });

    voiceBob.on('voice_ice_candidate', ({ candidate }) => {
      assert(candidate.candidate === 'candidate:mock', 'Bob received voice_ice_candidate from Alice');

      // Test speaking indicator
      voiceAlice.emit('voice_speaking', { isSpeaking: true });
    });

    voiceBob.on('voice_peer_speaking', ({ isSpeaking }) => {
      assert(isSpeaking === true, 'Bob received voice_peer_speaking indicator');

      // Test mute toggle
      voiceAlice.emit('voice_mute_toggle', { isMuted: true });
    });

    voiceBob.on('voice_peer_muted', ({ isMuted }) => {
      assert(isMuted === true, 'Bob received voice_peer_muted event');

      // Alice leaves voice
      voiceAlice.emit('leave_voice');
    });

    voiceBob.on('voice_peer_left', () => {
      assert(true, 'Bob received voice_peer_left notification');

      voiceAlice.disconnect();
      voiceBob.disconnect();
      resolve();
    });
  });
}

async function runAllTests() {
  console.log('======================================================');
  console.log('    ChatterBox Comprehensive Automated Verification    ');
  console.log(`    Target Server: ${SERVER_URL}`);
  console.log('======================================================');

  const startTime = Date.now();

  await runHTTPTests();
  await runRealtimeMessagingTests();
  await runAntiSpamTests();
  await runChannelLifecycleTests();
  await runVoIPSignalingTests();

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);

  console.log('\n======================================================');
  console.log(`    Test Results: ${passed} Passed | ${failed} Failed (${duration}s)`);
  console.log('======================================================');

  if (failed === 0) {
    console.log('🎉 ALL SYSTEM CHECKS & REAL-TIME PROTOCOLS VERIFIED!\n');
    process.exit(0);
  } else {
    console.error(`💥 ${failed} test(s) failed.\n`);
    process.exit(1);
  }
}

runAllTests();

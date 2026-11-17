const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const compression = require('compression');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Security Headers with Helmet
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        connectSrc: ["'self'", "wss:", "ws:", "https:", "http:"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// Socket.IO Server Configuration
const io = new Server(server, {
  cors: {
    origin: '*',
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5,
});

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Enable HTTP compression
app.use(compression({
  level: 6,
  threshold: 1024,
}));

// Additional response headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve frontend assets
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

// In-Memory Data Storage
const users = new Map(); // socket.id -> { id, publicId, username, room, avatarColor, status, rateLimitWindow, msgCount, cooldownUntil, lastMsgText, dupCount }
const voiceUsers = new Map(); // socket.id -> { socketId, publicId, username, avatarColor, room, isMuted }
const defaultRooms = ['general', 'random', 'tech', 'lounge'];
const customRooms = new Set();
const messageHistory = new Map(); // roomName -> Array<Message>
const MAX_HISTORY = 120;

// Avatar colors
const AVATAR_COLORS = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
  '#EC4899', '#06B6D4', '#EF4444', '#14B8A6'
];

function getRandomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function getAllRooms() {
  return [
    ...defaultRooms.map(r => ({ name: r, isDefault: true })),
    ...Array.from(customRooms).map(r => ({ name: r, isDefault: false }))
  ];
}

function sanitizeText(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>]/g, '')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
    .replace(/(.)\1{14,}/g, '$1$1$1$1$1')
    .trim()
    .substring(0, maxLen);
}

function sanitizeIdentifier(str, maxLen = 24) {
  if (typeof str !== 'string') return '';
  return str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .substring(0, maxLen);
}

function getRoomUsers(roomName) {
  const roomUsers = [];
  for (const user of users.values()) {
    if (user.room === roomName) {
      roomUsers.push({
        id: user.publicId,
        username: user.username,
        avatarColor: user.avatarColor,
        status: user.status || 'online',
        inVoice: voiceUsers.has(user.id),
      });
    }
  }
  return roomUsers;
}

function getVoiceRoomUsers(roomName) {
  const vUsers = [];
  for (const vu of voiceUsers.values()) {
    if (vu.room === roomName) {
      vUsers.push({
        socketId: vu.socketId,
        id: vu.publicId,
        username: vu.username,
        avatarColor: vu.avatarColor,
        isMuted: !!vu.isMuted,
      });
    }
  }
  return vUsers;
}

function addMessageToHistory(room, msg) {
  if (!messageHistory.has(room)) {
    messageHistory.set(room, []);
  }
  const history = messageHistory.get(room);
  history.push(msg);
  if (history.length > MAX_HISTORY) {
    history.shift();
  }
}

// Anti-Spam Check
function verifySpam(user, text) {
  const now = Date.now();

  if (user.cooldownUntil && now < user.cooldownUntil) {
    const remainingSec = Math.ceil((user.cooldownUntil - now) / 1000);
    return {
      allowed: false,
      reason: `⏳ Spam protection active. Please wait ${remainingSec}s before sending another message.`,
      cooldown: remainingSec,
    };
  }

  if (user.lastMsgText && user.lastMsgText.toLowerCase() === text.toLowerCase()) {
    user.dupCount = (user.dupCount || 0) + 1;
    if (user.dupCount >= 3) {
      user.cooldownUntil = now + 4000;
      return {
        allowed: false,
        reason: '⚠️ Duplicate message flood detected. Please do not repeat the exact same text.',
        cooldown: 4,
      };
    }
  } else {
    user.dupCount = 0;
  }
  user.lastMsgText = text;

  if (!user.rateLimitWindow || now - user.rateLimitWindow > 2000) {
    user.rateLimitWindow = now;
    user.msgCount = 1;
    return { allowed: true };
  }

  user.msgCount = (user.msgCount || 0) + 1;
  if (user.msgCount > 3) {
    user.cooldownUntil = now + 5000;
    return {
      allowed: false,
      reason: '🚨 Rapid messaging detected! You are placed on a 5-second cooldown.',
      cooldown: 5,
    };
  }

  return { allowed: true };
}

io.on('connection', (socket) => {
  socket.emit('rooms_list', getAllRooms());

  // Join Room
  socket.on('join_room', ({ username, room }) => {
    const cleanUsername = sanitizeText(username, 24) || `User_${socket.id.substring(0, 4)}`;
    const normalizedRoom = sanitizeIdentifier(room, 24) || 'general';

    if (!defaultRooms.includes(normalizedRoom)) {
      if (customRooms.size < 60) {
        customRooms.add(normalizedRoom);
        io.emit('rooms_list', getAllRooms());
      }
    }

    const existingUser = users.get(socket.id);
    if (existingUser && existingUser.room) {
      const prevRoom = existingUser.room;
      socket.leave(prevRoom);

      socket.to(prevRoom).emit('system_message', {
        id: `sys-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        text: `${existingUser.username} left the room.`,
        timestamp: new Date().toISOString(),
      });
      io.to(prevRoom).emit('room_users', getRoomUsers(prevRoom));
    }

    const publicId = existingUser ? existingUser.publicId : crypto.randomBytes(8).toString('hex');
    const avatarColor = existingUser ? existingUser.avatarColor : getRandomColor();
    const currentStatus = existingUser ? existingUser.status : 'online';

    users.set(socket.id, {
      id: socket.id,
      publicId,
      username: cleanUsername,
      room: normalizedRoom,
      avatarColor,
      status: currentStatus,
      rateLimitWindow: 0,
      msgCount: 0,
      cooldownUntil: 0,
      lastMsgText: '',
      dupCount: 0,
    });

    socket.join(normalizedRoom);

    socket.emit('joined_room_success', {
      user: { id: publicId, username: cleanUsername, avatarColor, status: currentStatus },
      room: normalizedRoom,
      isDefault: defaultRooms.includes(normalizedRoom),
      history: messageHistory.get(normalizedRoom) || [],
      voiceUsers: getVoiceRoomUsers(normalizedRoom),
    });

    socket.to(normalizedRoom).emit('system_message', {
      id: `sys-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      text: `${cleanUsername} joined #${normalizedRoom}!`,
      timestamp: new Date().toISOString(),
    });

    io.to(normalizedRoom).emit('room_users', getRoomUsers(normalizedRoom));
  });

  // ================= VoIP Voice Chat Signaling ================= //

  // Join Voice Call in Channel
  socket.on('join_voice', () => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    // Get current peers in the room before adding the new user
    const existingPeers = getVoiceRoomUsers(user.room);

    voiceUsers.set(socket.id, {
      socketId: socket.id,
      publicId: user.publicId,
      username: user.username,
      avatarColor: user.avatarColor,
      room: user.room,
      isMuted: false,
    });

    // Send existing peers to the newly connected voice client
    socket.emit('voice_existing_peers', {
      peers: existingPeers,
      room: user.room,
    });

    // Notify other peers in this room that a new peer joined
    socket.to(user.room).emit('voice_peer_joined', {
      socketId: socket.id,
      id: user.publicId,
      username: user.username,
      avatarColor: user.avatarColor,
      isMuted: false,
    });

    io.to(user.room).emit('room_users', getRoomUsers(user.room));
    io.to(user.room).emit('voice_users_updated', getVoiceRoomUsers(user.room));
  });

  // WebRTC Offer Relay
  socket.on('voice_offer', ({ targetSocketId, offer }) => {
    const user = users.get(socket.id);
    if (!user) return;

    io.to(targetSocketId).emit('voice_offer', {
      senderSocketId: socket.id,
      id: user.publicId,
      username: user.username,
      avatarColor: user.avatarColor,
      offer,
    });
  });

  // WebRTC Answer Relay
  socket.on('voice_answer', ({ targetSocketId, answer }) => {
    io.to(targetSocketId).emit('voice_answer', {
      senderSocketId: socket.id,
      answer,
    });
  });

  // WebRTC ICE Candidate Relay
  socket.on('voice_ice_candidate', ({ targetSocketId, candidate }) => {
    io.to(targetSocketId).emit('voice_ice_candidate', {
      senderSocketId: socket.id,
      candidate,
    });
  });

  // Voice Speaking Indicator Relay
  socket.on('voice_speaking', ({ isSpeaking }) => {
    const vu = voiceUsers.get(socket.id);
    if (!vu) return;

    socket.to(vu.room).emit('voice_peer_speaking', {
      socketId: socket.id,
      id: vu.publicId,
      isSpeaking: !!isSpeaking,
    });
  });

  // Voice Mute State Relay
  socket.on('voice_mute_toggle', ({ isMuted }) => {
    const vu = voiceUsers.get(socket.id);
    if (!vu) return;

    vu.isMuted = !!isMuted;
    voiceUsers.set(socket.id, vu);

    io.to(vu.room).emit('voice_peer_muted', {
      socketId: socket.id,
      id: vu.publicId,
      isMuted: !!isMuted,
    });
  });

  // Leave Voice Call
  function handleLeaveVoice(sockId) {
    const vu = voiceUsers.get(sockId);
    if (!vu) return;

    voiceUsers.delete(sockId);

    io.to(vu.room).emit('voice_peer_left', {
      socketId: sockId,
      id: vu.publicId,
    });

    io.to(vu.room).emit('room_users', getRoomUsers(vu.room));
    io.to(vu.room).emit('voice_users_updated', getVoiceRoomUsers(vu.room));
  }

  socket.on('leave_voice', () => {
    handleLeaveVoice(socket.id);
  });

  // ================= End VoIP Signaling ================= //

  // Send Message
  socket.on('send_message', ({ text }) => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    const cleanText = sanitizeText(text, 600);
    if (!cleanText) return;

    const spamCheck = verifySpam(user, cleanText);
    if (!spamCheck.allowed) {
      socket.emit('spam_warning', {
        text: spamCheck.reason,
        cooldown: spamCheck.cooldown || 5,
      });
      return;
    }

    const message = {
      id: `msg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      senderId: user.publicId,
      username: user.username,
      avatarColor: user.avatarColor,
      text: cleanText,
      room: user.room,
      reactions: {},
      timestamp: new Date().toISOString(),
    };

    addMessageToHistory(user.room, message);
    io.to(user.room).emit('new_message', message);
  });

  // Message Reactions
  socket.on('toggle_reaction', ({ messageId, emoji }) => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    const history = messageHistory.get(user.room);
    if (!history) return;

    const msg = history.find(m => m.id === messageId);
    if (!msg) return;

    if (!msg.reactions) msg.reactions = {};
    const validEmojis = ['👍', '❤️', '🔥', '😂', '🎉', '🚀'];
    if (!validEmojis.includes(emoji)) return;

    if (!msg.reactions[emoji]) {
      msg.reactions[emoji] = [];
    }

    const userIndex = msg.reactions[emoji].indexOf(user.publicId);
    if (userIndex > -1) {
      msg.reactions[emoji].splice(userIndex, 1);
      if (msg.reactions[emoji].length === 0) {
        delete msg.reactions[emoji];
      }
    } else {
      msg.reactions[emoji].push(user.publicId);
    }

    io.to(user.room).emit('reaction_updated', {
      messageId,
      reactions: msg.reactions,
    });
  });

  // Delete Channel
  socket.on('delete_room', ({ room }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const normalizedRoom = sanitizeIdentifier(room, 24);
    if (!normalizedRoom || defaultRooms.includes(normalizedRoom)) {
      socket.emit('system_message', {
        id: `sys-${Date.now()}`,
        text: '❌ Protected default channels cannot be deleted.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (customRooms.has(normalizedRoom)) {
      customRooms.delete(normalizedRoom);
      messageHistory.delete(normalizedRoom);

      // Clean up voice users in deleted room
      for (const [sId, vu] of voiceUsers.entries()) {
        if (vu.room === normalizedRoom) {
          handleLeaveVoice(sId);
        }
      }

      io.emit('room_deleted', {
        deletedRoom: normalizedRoom,
        fallbackRoom: 'general',
      });

      io.emit('rooms_list', getAllRooms());

      io.in(normalizedRoom).socketsJoin('general');
      io.in(normalizedRoom).socketsLeave(normalizedRoom);

      for (const [sId, u] of users.entries()) {
        if (u.room === normalizedRoom) {
          u.room = 'general';
          users.set(sId, u);
        }
      }

      io.to('general').emit('system_message', {
        id: `sys-${Date.now()}`,
        text: `Channel #${normalizedRoom} was deleted by ${user.username}. Members moved to #general.`,
        timestamp: new Date().toISOString(),
      });
      io.to('general').emit('room_users', getRoomUsers('general'));
    }
  });

  // Clear Channel History
  socket.on('clear_room_history', () => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    messageHistory.set(user.room, []);

    io.to(user.room).emit('room_history_cleared', { room: user.room });

    io.to(user.room).emit('system_message', {
      id: `sys-${Date.now()}`,
      text: `🧹 Channel history was cleared by ${user.username}.`,
      timestamp: new Date().toISOString(),
    });
  });

  // User Status
  socket.on('update_status', ({ status }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const validStatuses = ['online', 'away', 'busy'];
    if (validStatuses.includes(status)) {
      user.status = status;
      users.set(socket.id, user);

      if (user.room) {
        io.to(user.room).emit('room_users', getRoomUsers(user.room));
      }
    }
  });

  // Typing state
  socket.on('typing', ({ isTyping }) => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    socket.to(user.room).emit('user_typing', {
      username: user.username,
      isTyping: !!isTyping,
    });
  });

  // Update username
  socket.on('update_username', ({ newUsername }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const cleanName = sanitizeText(newUsername, 24);
    if (!cleanName || cleanName === user.username) return;

    const oldName = user.username;
    user.username = cleanName;
    users.set(socket.id, user);

    const vu = voiceUsers.get(socket.id);
    if (vu) {
      vu.username = cleanName;
      voiceUsers.set(socket.id, vu);
    }

    socket.emit('username_updated', { username: cleanName });

    if (user.room) {
      io.to(user.room).emit('system_message', {
        id: `sys-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        text: `${oldName} changed their name to ${cleanName}.`,
        timestamp: new Date().toISOString(),
      });
      io.to(user.room).emit('room_users', getRoomUsers(user.room));
      if (vu) {
        io.to(user.room).emit('voice_users_updated', getVoiceRoomUsers(user.room));
      }
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    handleLeaveVoice(socket.id);

    const user = users.get(socket.id);
    if (user) {
      users.delete(socket.id);
      if (user.room) {
        socket.to(user.room).emit('system_message', {
          id: `sys-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
          text: `${user.username} left the chat.`,
          timestamp: new Date().toISOString(),
        });
        io.to(user.room).emit('room_users', getRoomUsers(user.room));
      }
    }
  });
});

// Port Handling
function startServer(port) {
  server.listen(port);
}

server.on('listening', () => {
  const addr = server.address();
  console.log(`🚀 Chat server running at http://localhost:${addr.port}`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    const nextPort = (err.port || PORT) + 1;
    console.warn(`Port ${PORT} in use, trying ${nextPort}...`);
    setTimeout(() => startServer(nextPort), 200);
  } else {
    console.error('Server error:', err);
  }
});

process.on('uncaughtException', (err) => {
  console.error('[Process] Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Process] Unhandled Rejection at:', promise, 'reason:', reason);
});

startServer(PORT);

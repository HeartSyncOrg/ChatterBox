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

// Optimize Socket.IO engine with strict payload bounds
const io = new Server(server, {
  cors: {
    origin: '*',
  },
  transports: ['websocket', 'polling'],
  pingInterval: 25000,
  pingTimeout: 20000,
  maxHttpBufferSize: 1e5, // 100KB max payload limit (prevents memory attacks)
});

const PORT = parseInt(process.env.PORT, 10) || 3000;

// Enable HTTP response compression
app.use(compression({
  level: 6,
  threshold: 1024,
}));

// Additional HTTP Security & Mobile caching headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  next();
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true,
}));

// In-memory data storage
const users = new Map(); // socket.id -> { id, publicId, username, room, avatarColor, rateLimitWindow, msgCount }
const defaultRooms = ['general', 'random', 'tech', 'lounge'];
const customRooms = new Set();
const messageHistory = new Map(); // roomName -> Array<Message>
const MAX_HISTORY = 100;

// Color palette for user avatars
const AVATAR_COLORS = [
  '#3B82F6', '#10B981', '#8B5CF6', '#F59E0B',
  '#EC4899', '#06B6D4', '#EF4444', '#14B8A6'
];

function getRandomColor() {
  return AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

function getAllRooms() {
  return Array.from(new Set([...defaultRooms, ...customRooms]));
}

// Sanitize user text inputs (prevents XSS, control chars, injections)
function sanitizeText(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/[<>]/g, '') // remove angle brackets
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, '') // remove non-printable control chars
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
        id: user.publicId, // Never expose raw socket.id
        username: user.username,
        avatarColor: user.avatarColor,
      });
    }
  }
  return roomUsers;
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

// Anti-flood rate limiting: max 4 messages per 2-second burst
function checkRateLimit(user) {
  const now = Date.now();
  if (!user.rateLimitWindow || now - user.rateLimitWindow > 2000) {
    user.rateLimitWindow = now;
    user.msgCount = 1;
    return true;
  }
  user.msgCount = (user.msgCount || 0) + 1;
  return user.msgCount <= 4;
}

io.on('connection', (socket) => {
  // Send available rooms list to newly connected client
  socket.emit('rooms_list', getAllRooms());

  // Handle user joining a room
  socket.on('join_room', ({ username, room }) => {
    const cleanUsername = sanitizeText(username, 24) || `User_${socket.id.substring(0, 4)}`;
    const normalizedRoom = sanitizeIdentifier(room, 24) || 'general';

    // Store custom room
    if (!defaultRooms.includes(normalizedRoom)) {
      if (customRooms.size < 50) { // Bound total active custom rooms to avoid memory bloat
        customRooms.add(normalizedRoom);
        io.emit('rooms_list', getAllRooms());
      }
    }

    // Leave previous room if any
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

    // Register user details with opaque publicId
    const publicId = existingUser ? existingUser.publicId : crypto.randomBytes(8).toString('hex');
    const avatarColor = existingUser ? existingUser.avatarColor : getRandomColor();

    users.set(socket.id, {
      id: socket.id,
      publicId,
      username: cleanUsername,
      room: normalizedRoom,
      avatarColor,
      rateLimitWindow: 0,
      msgCount: 0,
    });

    socket.join(normalizedRoom);

    // Send confirmation to user
    socket.emit('joined_room_success', {
      user: { id: publicId, username: cleanUsername, avatarColor },
      room: normalizedRoom,
      history: messageHistory.get(normalizedRoom) || [],
    });

    // Notify room participants
    socket.to(normalizedRoom).emit('system_message', {
      id: `sys-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
      text: `${cleanUsername} joined #${normalizedRoom}!`,
      timestamp: new Date().toISOString(),
    });

    io.to(normalizedRoom).emit('room_users', getRoomUsers(normalizedRoom));
  });

  // Handle sending chat message
  socket.on('send_message', ({ text }) => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    if (!checkRateLimit(user)) {
      socket.emit('system_message', {
        id: `sys-${Date.now()}`,
        text: '⚠️ Slow down! You are sending messages too quickly.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const cleanText = sanitizeText(text, 600);
    if (!cleanText) return;

    const message = {
      id: `msg-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
      senderId: user.publicId, // safe publicId
      username: user.username,
      avatarColor: user.avatarColor,
      text: cleanText,
      room: user.room,
      timestamp: new Date().toISOString(),
    };

    addMessageToHistory(user.room, message);
    io.to(user.room).emit('new_message', message);
  });

  // Handle typing state
  socket.on('typing', ({ isTyping }) => {
    const user = users.get(socket.id);
    if (!user || !user.room) return;

    socket.to(user.room).emit('user_typing', {
      username: user.username,
      isTyping: !!isTyping,
    });
  });

  // Handle username update
  socket.on('update_username', ({ newUsername }) => {
    const user = users.get(socket.id);
    if (!user) return;

    const cleanName = sanitizeText(newUsername, 24);
    if (!cleanName || cleanName === user.username) return;

    const oldName = user.username;
    user.username = cleanName;
    users.set(socket.id, user);

    socket.emit('username_updated', { username: cleanName });

    if (user.room) {
      io.to(user.room).emit('system_message', {
        id: `sys-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`,
        text: `${oldName} changed their name to ${cleanName}.`,
        timestamp: new Date().toISOString(),
      });
      io.to(user.room).emit('room_users', getRoomUsers(user.room));
    }
  });

  // Handle user disconnect
  socket.on('disconnect', () => {
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

// Graceful Port Selection
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

// Connect to Socket.io with optimized transports (prioritizing WebSocket)
const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

// State
let currentUser = {
  id: null,
  username: localStorage.getItem('pulsechat_username') || '',
  avatarColor: '#6366f1',
};
let currentRoom = localStorage.getItem('pulsechat_room') || 'general';
let availableRooms = [];
let soundEnabled = localStorage.getItem('pulsechat_sound') !== 'false';
let typingTimeout = null;
let isCurrentlyTyping = false;
let userScrolledUp = false;

// DOM Elements
const joinModal = document.getElementById('joinModal');
const joinForm = document.getElementById('joinForm');
const usernameInput = document.getElementById('usernameInput');
const initialRoomSelect = document.getElementById('initialRoomSelect');

const sidebar = document.getElementById('sidebar');
const sidebarBackdrop = document.getElementById('sidebarBackdrop');
const openSidebarBtn = document.getElementById('openSidebarBtn');
const closeSidebarBtn = document.getElementById('closeSidebarBtn');

const roomsList = document.getElementById('roomsList');
const usersList = document.getElementById('usersList');
const userCount = document.getElementById('userCount');
const newRoomBtn = document.getElementById('newRoomBtn');

const currentUserName = document.getElementById('currentUserName');
const currentUserAvatar = document.getElementById('currentUserAvatar');
const editNameBtn = document.getElementById('editNameBtn');

const roomTitle = document.getElementById('roomTitle');
const roomSubtitle = document.getElementById('roomSubtitle');
const connectionStatus = document.getElementById('connectionStatus');
const connectionText = document.getElementById('connectionText');
const soundToggleBtn = document.getElementById('soundToggleBtn');

const messagesContainer = document.getElementById('messagesContainer');
const messagesList = document.getElementById('messagesList');
const roomWelcomeBanner = document.getElementById('roomWelcomeBanner');
const welcomeRoomName = document.getElementById('welcomeRoomName');
const welcomeRoomNameSub = document.getElementById('welcomeRoomNameSub');
const scrollBottomBtn = document.getElementById('scrollBottomBtn');

const typingIndicator = document.getElementById('typingIndicator');
const typingText = document.getElementById('typingText');

const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const emojiToggleBtn = document.getElementById('emojiToggleBtn');
const emojiPicker = document.getElementById('emojiPicker');

// Singleton AudioContext (prevents memory leak & channel exhaustion)
let cachedAudioCtx = null;
function getAudioContext() {
  if (!cachedAudioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      cachedAudioCtx = new AudioContextClass();
    }
  }
  if (cachedAudioCtx && cachedAudioCtx.state === 'suspended') {
    cachedAudioCtx.resume().catch(() => {});
  }
  return cachedAudioCtx;
}

// Play notification chime using Web Audio API synth
function playNotificationSound() {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
    osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1); // A5

    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();
    osc.stop(ctx.currentTime + 0.25);
  } catch (err) {
    // Autoplay policy fallback
  }
}

// Helpers
function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].substring(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function formatTime(isoString) {
  const date = new Date(isoString);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function escapeHTML(str) {
  return str.replace(/[&<>'"]/g, 
    tag => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      "'": '&#39;',
      '"': '&quot;'
    }[tag] || tag)
  );
}

// Smart Smooth Scrolling
function isNearBottom() {
  const threshold = 150; // px from bottom
  return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight <= threshold;
}

function scrollToBottom(force = false) {
  if (force || !userScrolledUp) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    scrollBottomBtn.classList.remove('visible');
    userScrolledUp = false;
  }
}

// Detect user scrolling to avoid interrupting reading past messages
messagesContainer.addEventListener('scroll', () => {
  if (isNearBottom()) {
    userScrolledUp = false;
    scrollBottomBtn.classList.remove('visible');
  } else {
    userScrolledUp = true;
  }
}, { passive: true });

scrollBottomBtn.addEventListener('click', () => {
  messagesContainer.scrollTo({
    top: messagesContainer.scrollHeight,
    behavior: 'smooth',
  });
  scrollBottomBtn.classList.remove('visible');
  userScrolledUp = false;
});

// Update connection status badge
function updateConnectionUI(connected) {
  if (connected) {
    connectionStatus.className = 'connection-status-pill connected';
    connectionText.textContent = 'Connected';
  } else {
    connectionStatus.className = 'connection-status-pill disconnected';
    connectionText.textContent = 'Reconnecting...';
  }
}

// Render Rooms with DocumentFragment for performance
function renderRooms(rooms) {
  availableRooms = rooms;
  const frag = document.createDocumentFragment();
  const selectFrag = document.createDocumentFragment();

  rooms.forEach((room) => {
    // Modal select option
    const opt = document.createElement('option');
    opt.value = room;
    opt.textContent = `# ${room}`;
    if (room === currentRoom) opt.selected = true;
    selectFrag.appendChild(opt);

    // Sidebar room item
    const li = document.createElement('li');
    li.className = `room-item ${room === currentRoom ? 'active' : ''}`;
    li.innerHTML = `<span class="room-hash">#</span> <span>${escapeHTML(room)}</span>`;
    li.addEventListener('click', () => {
      switchRoom(room);
      closeMobileSidebar();
    });
    frag.appendChild(li);
  });

  initialRoomSelect.innerHTML = '';
  initialRoomSelect.appendChild(selectFrag);

  roomsList.innerHTML = '';
  roomsList.appendChild(frag);
}

// Render Room Users with DocumentFragment
function renderRoomUsers(users) {
  userCount.textContent = users.length;
  const frag = document.createDocumentFragment();

  users.forEach((user) => {
    const isMe = user.id === socket.id;
    const li = document.createElement('li');
    li.className = `user-item ${isMe ? 'is-me' : ''}`;

    const avatar = document.createElement('div');
    avatar.className = 'user-avatar-small';
    avatar.style.backgroundColor = user.avatarColor || '#6366f1';
    avatar.textContent = getInitials(user.username);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name-text';
    nameSpan.textContent = user.username;

    li.appendChild(avatar);
    li.appendChild(nameSpan);
    frag.appendChild(li);
  });

  usersList.innerHTML = '';
  usersList.appendChild(frag);
}

// Create DOM Message Row Element
function createMessageElement(msg) {
  const isOwn = msg.senderId === socket.id;

  const row = document.createElement('div');
  row.className = `message-row ${isOwn ? 'is-own' : ''}`;

  const avatar = document.createElement('div');
  avatar.className = 'msg-avatar';
  avatar.style.backgroundColor = msg.avatarColor || '#6366f1';
  avatar.textContent = getInitials(msg.username);

  const body = document.createElement('div');
  body.className = 'msg-body';

  const meta = document.createElement('div');
  meta.className = 'msg-meta';

  const name = document.createElement('span');
  name.className = 'msg-username';
  name.textContent = isOwn ? 'You' : msg.username;

  const time = document.createElement('span');
  time.className = 'msg-time';
  time.textContent = formatTime(msg.timestamp);

  meta.appendChild(name);
  meta.appendChild(time);

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.text;

  body.appendChild(meta);
  body.appendChild(bubble);

  row.appendChild(avatar);
  row.appendChild(body);

  return row;
}

// Render Single Message (with DOM node capping to prevent memory leaks)
const MAX_DOM_MESSAGES = 200;
function appendMessage(msg) {
  const elem = createMessageElement(msg);
  messagesList.appendChild(elem);

  // Keep DOM element count bounded
  while (messagesList.children.length > MAX_DOM_MESSAGES) {
    messagesList.removeChild(messagesList.firstChild);
  }

  const isOwn = msg.senderId === socket.id;

  if (isOwn || !userScrolledUp) {
    scrollToBottom(true);
  } else {
    // Show 'New messages' badge if user scrolled up
    scrollBottomBtn.classList.add('visible');
  }

  if (!isOwn) {
    playNotificationSound();
  }
}

// Render System Notice
function appendSystemNotice(text) {
  const div = document.createElement('div');
  div.className = 'system-notice';
  div.innerHTML = `<span class="system-notice-pill">${escapeHTML(text)}</span>`;
  messagesList.appendChild(div);

  if (!userScrolledUp) {
    scrollToBottom();
  }
}

// Switch Room
function switchRoom(newRoom) {
  if (newRoom === currentRoom && currentUser.username) return;
  currentRoom = newRoom;
  localStorage.setItem('pulsechat_room', currentRoom);

  // Update room header
  roomTitle.textContent = `# ${currentRoom}`;
  roomSubtitle.textContent = `Channel: ${currentRoom}`;
  welcomeRoomName.textContent = `#${currentRoom}`;
  welcomeRoomNameSub.textContent = `#${currentRoom}`;
  messageInput.placeholder = `Message #${currentRoom}... (Press Enter to send)`;

  // Clear messages list
  messagesList.innerHTML = '';
  scrollBottomBtn.classList.remove('visible');
  userScrolledUp = false;

  // Update active styling in sidebar
  document.querySelectorAll('.room-item').forEach((item) => {
    const isThis = item.textContent.replace('#', '').trim() === currentRoom;
    item.classList.toggle('active', isThis);
  });

  // Emit room join to socket
  socket.emit('join_room', {
    username: currentUser.username,
    room: currentRoom,
  });
}

// Mobile sidebar controls
function openMobileSidebar() {
  sidebar.classList.add('open');
  sidebarBackdrop.classList.add('show');
}

function closeMobileSidebar() {
  sidebar.classList.remove('open');
  sidebarBackdrop.classList.remove('show');
}

openSidebarBtn.addEventListener('click', openMobileSidebar);
closeSidebarBtn.addEventListener('click', closeMobileSidebar);
sidebarBackdrop.addEventListener('click', closeMobileSidebar);

// Touch swipe to close sidebar on mobile
let touchStartX = 0;
sidebar.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].clientX;
}, { passive: true });

sidebar.addEventListener('touchend', (e) => {
  const touchEndX = e.changedTouches[0].clientX;
  if (touchStartX - touchEndX > 50) {
    closeMobileSidebar();
  }
}, { passive: true });

// Sound toggle
function updateSoundButton() {
  soundToggleBtn.textContent = soundEnabled ? '🔔' : '🔕';
  soundToggleBtn.title = soundEnabled ? 'Mute Sounds' : 'Unmute Sounds';
}
soundToggleBtn.addEventListener('click', () => {
  soundEnabled = !soundEnabled;
  localStorage.setItem('pulsechat_sound', soundEnabled);
  updateSoundButton();
  if (soundEnabled) getAudioContext();
});
updateSoundButton();

// Edit Username
editNameBtn.addEventListener('click', () => {
  const newName = prompt('Enter new display name (max 30 chars):', currentUser.username);
  if (newName && newName.trim() && newName.trim() !== currentUser.username) {
    socket.emit('update_username', { newUsername: newName.trim() });
  }
});

// Create / Join Custom Room
newRoomBtn.addEventListener('click', () => {
  const roomName = prompt('Enter channel name (letters, numbers, dashes):');
  if (roomName && roomName.trim()) {
    const cleanRoom = roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').substring(0, 30);
    if (cleanRoom) {
      switchRoom(cleanRoom);
    }
  }
});

// Emoji Picker toggle & insertion
emojiToggleBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  emojiPicker.classList.toggle('show');
});

document.addEventListener('click', (e) => {
  if (!emojiPicker.contains(e.target) && e.target !== emojiToggleBtn) {
    emojiPicker.classList.remove('show');
  }
});

document.querySelectorAll('.emoji-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    messageInput.value += btn.textContent;
    messageInput.focus();
    emojiPicker.classList.remove('show');
  });
});

// Join modal form submit
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim().substring(0, 30);
  const selectedRoom = initialRoomSelect.value || 'general';

  if (!name) return;

  currentUser.username = name;
  currentRoom = selectedRoom;

  localStorage.setItem('pulsechat_username', name);
  localStorage.setItem('pulsechat_room', selectedRoom);

  joinModal.classList.add('hidden');
  getAudioContext(); // Initialize audio context on first user action

  switchRoom(currentRoom);
  messageInput.focus();
});

// Chat message form submit
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  // Clear typing status
  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    socket.emit('typing', { isTyping: false });
    clearTimeout(typingTimeout);
  }

  // Send message
  socket.emit('send_message', { text });
  messageInput.value = '';
  messageInput.focus();
});

// Throttled typing indicator
messageInput.addEventListener('input', () => {
  if (!isCurrentlyTyping && messageInput.value.trim().length > 0) {
    isCurrentlyTyping = true;
    socket.emit('typing', { isTyping: true });
  }

  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    if (isCurrentlyTyping) {
      isCurrentlyTyping = false;
      socket.emit('typing', { isTyping: false });
    }
  }, 1200);
});

// Socket Event Listeners
socket.on('connect', () => {
  updateConnectionUI(true);

  if (currentUser.username) {
    joinModal.classList.add('hidden');
    switchRoom(currentRoom);
  } else {
    joinModal.classList.remove('hidden');
    usernameInput.focus();
  }
});

socket.on('disconnect', () => {
  updateConnectionUI(false);
});

socket.on('rooms_list', (rooms) => {
  renderRooms(rooms);
});

// Batch render history with DocumentFragment for zero lag
socket.on('joined_room_success', ({ user, room, history }) => {
  currentUser.id = user.id;
  currentUser.username = user.username;
  currentUser.avatarColor = user.avatarColor;

  currentUserName.textContent = user.username;
  currentUserAvatar.textContent = getInitials(user.username);
  currentUserAvatar.style.backgroundColor = user.avatarColor;

  messagesList.innerHTML = '';
  if (history && history.length > 0) {
    const frag = document.createDocumentFragment();
    history.forEach((msg) => {
      frag.appendChild(createMessageElement(msg));
    });
    messagesList.appendChild(frag);
  }
  scrollToBottom(true);
});

socket.on('username_updated', ({ username }) => {
  currentUser.username = username;
  localStorage.setItem('pulsechat_username', username);
  currentUserName.textContent = username;
  currentUserAvatar.textContent = getInitials(username);
});

socket.on('new_message', (msg) => {
  appendMessage(msg);
});

socket.on('system_message', (sysMsg) => {
  appendSystemNotice(sysMsg.text);
});

socket.on('room_users', (users) => {
  renderRoomUsers(users);
});

socket.on('user_typing', ({ username, isTyping }) => {
  if (isTyping) {
    typingText.textContent = `${username} is typing...`;
    typingIndicator.classList.add('visible');
  } else {
    typingIndicator.classList.remove('visible');
  }
});

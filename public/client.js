// Connect to Socket.io with optimized transports
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
  status: localStorage.getItem('pulsechat_status') || 'online',
};
let currentRoom = localStorage.getItem('pulsechat_room') || 'general';
let availableRooms = [];
let soundEnabled = localStorage.getItem('pulsechat_sound') !== 'false';
let typingTimeout = null;
let isCurrentlyTyping = false;
let userScrolledUp = false;
let spamCooldownTimer = null;

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
const myStatusDot = document.getElementById('myStatusDot');
const statusSelect = document.getElementById('statusSelect');
const editNameBtn = document.getElementById('editNameBtn');

const roomTitle = document.getElementById('roomTitle');
const roomSubtitle = document.getElementById('roomSubtitle');
const connectionStatus = document.getElementById('connectionStatus');
const connectionText = document.getElementById('connectionText');
const soundToggleBtn = document.getElementById('soundToggleBtn');

const searchBoxWrap = document.getElementById('searchBoxWrap');
const searchInput = document.getElementById('searchInput');
const searchToggleBtn = document.getElementById('searchToggleBtn');
const clearChatBtn = document.getElementById('clearChatBtn');
const exportChatBtn = document.getElementById('exportChatBtn');

const messagesContainer = document.getElementById('messagesContainer');
const messagesList = document.getElementById('messagesList');
const roomWelcomeBanner = document.getElementById('roomWelcomeBanner');
const welcomeRoomName = document.getElementById('welcomeRoomName');
const welcomeRoomNameSub = document.getElementById('welcomeRoomNameSub');
const scrollBottomBtn = document.getElementById('scrollBottomBtn');

const spamBanner = document.getElementById('spamBanner');
const spamText = document.getElementById('spamText');
const spamCountdown = document.getElementById('spamCountdown');

const typingIndicator = document.getElementById('typingIndicator');
const typingText = document.getElementById('typingText');

const chatForm = document.getElementById('chatForm');
const messageInput = document.getElementById('messageInput');
const sendBtn = document.getElementById('sendBtn');
const emojiToggleBtn = document.getElementById('emojiToggleBtn');
const emojiPicker = document.getElementById('emojiPicker');

// Singleton AudioContext for synth sounds
let cachedAudioCtx = null;
function getAudioContext() {
  if (!cachedAudioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) cachedAudioCtx = new AudioContextClass();
  }
  if (cachedAudioCtx && cachedAudioCtx.state === 'suspended') {
    cachedAudioCtx.resume().catch(() => {});
  }
  return cachedAudioCtx;
}

function playNotificationSound(type = 'msg') {
  if (!soundEnabled) return;
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    if (type === 'warn') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(320, ctx.currentTime);
      osc.frequency.linearRampToValueAtTime(160, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.12, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.001, ctx.currentTime + 0.2);
    } else {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1); // A5
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
    }

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + (type === 'warn' ? 0.2 : 0.25));
  } catch (err) {}
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
  const threshold = 150;
  return messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight <= threshold;
}

function scrollToBottom(force = false) {
  if (force || !userScrolledUp) {
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    scrollBottomBtn.classList.remove('visible');
    userScrolledUp = false;
  }
}

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

// Update connection UI
function updateConnectionUI(connected) {
  if (connected) {
    connectionStatus.className = 'connection-status-pill connected';
    connectionText.textContent = 'Connected';
  } else {
    connectionStatus.className = 'connection-status-pill disconnected';
    connectionText.textContent = 'Reconnecting...';
  }
}

// Render Channels List with Deletion support
function renderRooms(rooms) {
  availableRooms = rooms;
  const frag = document.createDocumentFragment();
  const selectFrag = document.createDocumentFragment();

  rooms.forEach((r) => {
    const roomName = typeof r === 'string' ? r : r.name;
    const isDefault = typeof r === 'string' ? ['general', 'random', 'tech', 'lounge'].includes(r) : !!r.isDefault;

    // Modal option
    const opt = document.createElement('option');
    opt.value = roomName;
    opt.textContent = `# ${roomName}`;
    if (roomName === currentRoom) opt.selected = true;
    selectFrag.appendChild(opt);

    // Sidebar Row
    const row = document.createElement('li');
    row.className = `room-item-row ${roomName === currentRoom ? 'active' : ''}`;

    const content = document.createElement('div');
    content.className = 'room-item-content';
    content.innerHTML = `<span class="room-hash">#</span> <span>${escapeHTML(roomName)}</span>`;
    content.addEventListener('click', () => {
      switchRoom(roomName);
      closeMobileSidebar();
    });
    row.appendChild(content);

    // Delete Button (only on custom rooms)
    if (!isDefault) {
      const delBtn = document.createElement('button');
      delBtn.className = 'delete-room-btn';
      delBtn.title = `Delete #${roomName}`;
      delBtn.innerHTML = '🗑️';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (confirm(`Are you sure you want to delete channel #${roomName}?\nAll active members will be moved to #general.`)) {
          socket.emit('delete_room', { room: roomName });
        }
      });
      row.appendChild(delBtn);
    }

    frag.appendChild(row);
  });

  initialRoomSelect.innerHTML = '';
  initialRoomSelect.appendChild(selectFrag);

  roomsList.innerHTML = '';
  roomsList.appendChild(frag);
}

// Render Room Users
function renderRoomUsers(users) {
  userCount.textContent = users.length;
  const frag = document.createDocumentFragment();

  users.forEach((user) => {
    const isMe = user.id === currentUser.id;
    const li = document.createElement('li');
    li.className = `user-item ${isMe ? 'is-me' : ''}`;

    const avatarWrap = document.createElement('div');
    avatarWrap.className = 'user-avatar-wrap';

    const avatar = document.createElement('div');
    avatar.className = 'user-avatar-small';
    avatar.style.backgroundColor = user.avatarColor || '#6366f1';
    avatar.textContent = getInitials(user.username);

    const dot = document.createElement('div');
    dot.className = `user-status-dot ${user.status || 'online'}`;

    avatarWrap.appendChild(avatar);
    avatarWrap.appendChild(dot);

    const nameSpan = document.createElement('span');
    nameSpan.className = 'user-name-text';
    nameSpan.textContent = user.username;

    li.appendChild(avatarWrap);
    li.appendChild(nameSpan);
    frag.appendChild(li);
  });

  usersList.innerHTML = '';
  usersList.appendChild(frag);
}

// Create Message Element with Reaction Support
function createMessageElement(msg) {
  const isOwn = msg.senderId === currentUser.id;

  const row = document.createElement('div');
  row.className = `message-row ${isOwn ? 'is-own' : ''}`;
  row.dataset.msgId = msg.id;

  // Check mention of current user
  if (currentUser.username && msg.text.includes(`@${currentUser.username}`)) {
    row.classList.add('is-mentioned');
  }

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

  const bubbleWrap = document.createElement('div');
  bubbleWrap.className = 'msg-bubble-wrap';

  const bubble = document.createElement('div');
  bubble.className = 'msg-bubble';
  bubble.textContent = msg.text;

  // Quick reaction buttons on hover
  const quickReact = document.createElement('div');
  quickReact.className = 'msg-quick-react';
  ['👍', '❤️', '🔥', '😂'].forEach(emoji => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'react-quick-btn';
    btn.textContent = emoji;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      socket.emit('toggle_reaction', { messageId: msg.id, emoji });
    });
    quickReact.appendChild(btn);
  });

  bubbleWrap.appendChild(bubble);
  bubbleWrap.appendChild(quickReact);

  // Reactions pill container
  const reactionsBar = document.createElement('div');
  reactionsBar.className = 'msg-reactions-bar';
  renderReactionsBar(reactionsBar, msg.id, msg.reactions);

  body.appendChild(meta);
  body.appendChild(bubbleWrap);
  body.appendChild(reactionsBar);

  row.appendChild(avatar);
  row.appendChild(body);

  return row;
}

// Render Reaction Pills
function renderReactionsBar(container, msgId, reactions) {
  container.innerHTML = '';
  if (!reactions) return;

  Object.entries(reactions).forEach(([emoji, userList]) => {
    if (!userList || userList.length === 0) return;
    const isReactedByMe = userList.includes(currentUser.id);

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = `reaction-pill ${isReactedByMe ? 'reacted' : ''}`;
    pill.innerHTML = `<span>${emoji}</span> <span>${userList.length}</span>`;
    pill.title = `${userList.length} reaction${userList.length > 1 ? 's' : ''}`;
    pill.addEventListener('click', () => {
      socket.emit('toggle_reaction', { messageId: msgId, emoji });
    });
    container.appendChild(pill);
  });
}

// Append Single Message
const MAX_DOM_MESSAGES = 200;
function appendMessage(msg) {
  const elem = createMessageElement(msg);
  messagesList.appendChild(elem);

  while (messagesList.children.length > MAX_DOM_MESSAGES) {
    messagesList.removeChild(messagesList.firstChild);
  }

  const isOwn = msg.senderId === currentUser.id;
  if (isOwn || !userScrolledUp) {
    scrollToBottom(true);
  } else {
    scrollBottomBtn.classList.add('visible');
  }

  if (!isOwn) {
    playNotificationSound('msg');
  }
}

// System Notice
function appendSystemNotice(text) {
  const div = document.createElement('div');
  div.className = 'system-notice';
  div.innerHTML = `<span class="system-notice-pill">${escapeHTML(text)}</span>`;
  messagesList.appendChild(div);
  if (!userScrolledUp) scrollToBottom();
}

// Switch Room
function switchRoom(newRoom) {
  if (newRoom === currentRoom && currentUser.username) return;
  currentRoom = newRoom;
  localStorage.setItem('pulsechat_room', currentRoom);

  roomTitle.textContent = `# ${currentRoom}`;
  roomSubtitle.textContent = `Channel: ${currentRoom}`;
  welcomeRoomName.textContent = `#${currentRoom}`;
  welcomeRoomNameSub.textContent = `#${currentRoom}`;
  messageInput.placeholder = `Message #${currentRoom}... (Press Enter to send)`;

  messagesList.innerHTML = '';
  scrollBottomBtn.classList.remove('visible');
  userScrolledUp = false;

  document.querySelectorAll('.room-item-row').forEach((row) => {
    const isThis = row.textContent.replace('🗑️', '').replace('#', '').trim() === currentRoom;
    row.classList.toggle('active', isThis);
  });

  socket.emit('join_room', {
    username: currentUser.username,
    room: currentRoom,
  });
}

// Anti-Spam Cooldown Trigger
function handleSpamWarning(text, cooldownSec) {
  playNotificationSound('warn');
  spamText.textContent = text;
  spamCountdown.textContent = `${cooldownSec}s`;
  spamBanner.classList.add('show');

  messageInput.disabled = true;
  sendBtn.disabled = true;

  clearInterval(spamCooldownTimer);
  let remaining = cooldownSec;

  spamCooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(spamCooldownTimer);
      spamBanner.classList.remove('show');
      messageInput.disabled = false;
      sendBtn.disabled = false;
      messageInput.focus();
    } else {
      spamCountdown.textContent = `${remaining}s`;
    }
  }, 1000);
}

// Search / Filter Messages in Current Channel
searchToggleBtn.addEventListener('click', () => {
  searchBoxWrap.classList.toggle('active');
  if (searchBoxWrap.classList.contains('active')) {
    searchInput.focus();
  } else {
    searchInput.value = '';
    filterMessages('');
  }
});

searchInput.addEventListener('input', () => {
  filterMessages(searchInput.value.trim().toLowerCase());
});

function filterMessages(query) {
  document.querySelectorAll('.message-row').forEach((row) => {
    if (!query) {
      row.style.display = '';
    } else {
      const text = row.querySelector('.msg-bubble') ? row.querySelector('.msg-bubble').textContent.toLowerCase() : '';
      const user = row.querySelector('.msg-username') ? row.querySelector('.msg-username').textContent.toLowerCase() : '';
      row.style.display = (text.includes(query) || user.includes(query)) ? '' : 'none';
    }
  });
}

// Clear Channel Messages
clearChatBtn.addEventListener('click', () => {
  if (confirm(`Are you sure you want to clear chat history for #${currentRoom}?`)) {
    socket.emit('clear_room_history');
  }
});

// Export Chat History to .txt file
exportChatBtn.addEventListener('click', () => {
  const rows = document.querySelectorAll('.message-row');
  if (rows.length === 0) {
    alert('No messages to export in this channel.');
    return;
  }

  let textData = `=== ChatterBox - Channel #${currentRoom} History ===\nExported: ${new Date().toLocaleString()}\n\n`;
  rows.forEach((r) => {
    const user = r.querySelector('.msg-username') ? r.querySelector('.msg-username').textContent : '';
    const time = r.querySelector('.msg-time') ? r.querySelector('.msg-time').textContent : '';
    const bubble = r.querySelector('.msg-bubble') ? r.querySelector('.msg-bubble').textContent : '';
    textData += `[${time}] ${user}: ${bubble}\n`;
  });

  const blob = new Blob([textData], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ChatterBox-${currentRoom}-${Date.now()}.txt`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
});

// Status selection (Online / Away / Busy)
statusSelect.value = currentUser.status;
myStatusDot.className = `status-indicator-dot ${currentUser.status}`;

statusSelect.addEventListener('change', () => {
  const newStatus = statusSelect.value;
  currentUser.status = newStatus;
  localStorage.setItem('pulsechat_status', newStatus);
  myStatusDot.className = `status-indicator-dot ${newStatus}`;
  socket.emit('update_status', { status: newStatus });
});

// Mobile Sidebar Controls
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

// Mobile touch swipe left to close sidebar
let touchStartX = 0;
sidebar.addEventListener('touchstart', (e) => {
  touchStartX = e.changedTouches[0].clientX;
}, { passive: true });
sidebar.addEventListener('touchend', (e) => {
  if (touchStartX - e.changedTouches[0].clientX > 50) {
    closeMobileSidebar();
  }
}, { passive: true });

// Sound Toggle
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
  const newName = prompt('Enter new display name (max 24 chars):', currentUser.username);
  if (newName && newName.trim() && newName.trim() !== currentUser.username) {
    socket.emit('update_username', { newUsername: newName.trim() });
  }
});

// Create Custom Channel
newRoomBtn.addEventListener('click', () => {
  const roomName = prompt('Enter new channel name (letters, numbers, dashes):');
  if (roomName && roomName.trim()) {
    const cleanRoom = roomName.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '').substring(0, 24);
    if (cleanRoom) {
      switchRoom(cleanRoom);
    }
  }
});

// Emojis
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

// Join Form Submit
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = usernameInput.value.trim().substring(0, 24);
  const selectedRoom = initialRoomSelect.value || 'general';

  if (!name) return;

  currentUser.username = name;
  currentRoom = selectedRoom;

  localStorage.setItem('pulsechat_username', name);
  localStorage.setItem('pulsechat_room', selectedRoom);

  joinModal.classList.add('hidden');
  getAudioContext();

  switchRoom(currentRoom);
  messageInput.focus();
});

// Chat Form Submit
chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = messageInput.value.trim();
  if (!text) return;

  if (isCurrentlyTyping) {
    isCurrentlyTyping = false;
    socket.emit('typing', { isTyping: false });
    clearTimeout(typingTimeout);
  }

  socket.emit('send_message', { text });
  messageInput.value = '';
  messageInput.focus();
});

// Typing Debounce
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

// Socket Events
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

socket.on('reaction_updated', ({ messageId, reactions }) => {
  const row = document.querySelector(`.message-row[data-msg-id="${messageId}"]`);
  if (row) {
    const reactionsBar = row.querySelector('.msg-reactions-bar');
    if (reactionsBar) {
      renderReactionsBar(reactionsBar, messageId, reactions);
    }
  }
});

socket.on('spam_warning', ({ text, cooldown }) => {
  handleSpamWarning(text, cooldown);
});

socket.on('room_deleted', ({ deletedRoom, fallbackRoom }) => {
  if (currentRoom === deletedRoom) {
    switchRoom(fallbackRoom || 'general');
  }
});

socket.on('room_history_cleared', () => {
  messagesList.innerHTML = '';
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

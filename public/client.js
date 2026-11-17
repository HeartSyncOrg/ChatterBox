// Connect to Socket.io with optimized transports
const socket = io({
  transports: ['websocket', 'polling'],
  reconnectionDelay: 1000,
  reconnectionDelayMax: 5000,
  timeout: 20000,
});

// App State
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

// VoIP Voice State
let localVoiceStream = null;
let isVoiceConnected = false;
let isMicMuted = false;
let isDeafened = false;
let voicePeers = new Map(); // socketId -> { socketId, id, username, avatarColor, isMuted, isSpeaking }
let peerConnections = new Map(); // socketId -> RTCPeerConnection
let remoteAudioElements = new Map(); // socketId -> HTMLAudioElement
let peerVolumes = new Map(); // socketId -> volume 0 to 1
let speechAnalyser = null;
let speechInterval = null;

// Free Public STUN servers for WebRTC NAT traversal
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

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

const voiceCount = document.getElementById('voiceCount');
const voiceStatusBadge = document.getElementById('voiceStatusBadge');
const voiceUsersList = document.getElementById('voiceUsersList');
const voiceEmptyHint = document.getElementById('voiceEmptyHint');
const voiceConnectedBar = document.getElementById('voiceConnectedBar');
const voiceBarChannel = document.getElementById('voiceBarChannel');
const joinVoiceTopBtn = document.getElementById('joinVoiceTopBtn');
const micToggleBtn = document.getElementById('micToggleBtn');
const deafenToggleBtn = document.getElementById('deafenToggleBtn');
const leaveVoiceBtn = document.getElementById('leaveVoiceBtn');
const audioStreamsContainer = document.getElementById('audioStreamsContainer');

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
      osc.frequency.setValueAtTime(587.33, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.1);
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

function updateConnectionUI(connected) {
  if (connected) {
    connectionStatus.className = 'connection-status-pill connected';
    connectionText.textContent = 'Connected';
  } else {
    connectionStatus.className = 'connection-status-pill disconnected';
    connectionText.textContent = 'Reconnecting...';
  }
}

// Render Channels List
function renderRooms(rooms) {
  availableRooms = rooms;
  const frag = document.createDocumentFragment();
  const selectFrag = document.createDocumentFragment();

  rooms.forEach((r) => {
    const roomName = typeof r === 'string' ? r : r.name;
    const isDefault = typeof r === 'string' ? ['general', 'random', 'tech', 'lounge'].includes(r) : !!r.isDefault;

    const opt = document.createElement('option');
    opt.value = roomName;
    opt.textContent = `# ${roomName}`;
    if (roomName === currentRoom) opt.selected = true;
    selectFrag.appendChild(opt);

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
    nameSpan.textContent = user.username + (user.inVoice ? ' 🎙️' : '');

    li.appendChild(avatarWrap);
    li.appendChild(nameSpan);
    frag.appendChild(li);
  });

  usersList.innerHTML = '';
  usersList.appendChild(frag);
}

// ================= VoIP WebRTC Client Implementation ================= //

// Join Voice Call
async function startVoiceCall() {
  if (isVoiceConnected) {
    leaveVoiceCall();
    return;
  }

  try {
    // Request microphone access
    localVoiceStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (err) {
    alert('Could not access microphone: ' + (err.message || err.name) + '\nPlease check your microphone permissions.');
    return;
  }

  isVoiceConnected = true;
  isMicMuted = false;
  isDeafened = false;

  // Setup local speaking volume analyzer
  setupSpeechDetection(localVoiceStream);

  // Update UI to Voice Active
  voiceConnectedBar.classList.add('active');
  voiceBarChannel.textContent = `Voice: #${currentRoom}`;
  voiceStatusBadge.textContent = 'Connected';
  voiceStatusBadge.className = 'voice-badge active';
  joinVoiceTopBtn.classList.add('in-call');
  joinVoiceTopBtn.innerHTML = '<span>📞</span> <span>Disconnect Voice</span>';
  micToggleBtn.innerHTML = '🎙️';
  micToggleBtn.classList.remove('active-muted');

  // Notify socket server to join voice room
  socket.emit('join_voice');
}

// Leave Voice Call
function leaveVoiceCall() {
  if (!isVoiceConnected) return;

  // Stop local microphone tracks
  if (localVoiceStream) {
    localVoiceStream.getTracks().forEach((track) => track.stop());
    localVoiceStream = null;
  }

  if (speechInterval) {
    clearInterval(speechInterval);
    speechInterval = null;
  }

  // Close all peer connections
  peerConnections.forEach((pc) => pc.close());
  peerConnections.clear();

  // Remove remote audio elements
  remoteAudioElements.forEach((audio) => {
    audio.srcObject = null;
    audio.remove();
  });
  remoteAudioElements.clear();

  voicePeers.clear();
  renderVoiceUsers();

  isVoiceConnected = false;
  isMicMuted = false;
  isDeafened = false;

  voiceConnectedBar.classList.remove('active');
  voiceStatusBadge.textContent = 'Idle';
  voiceStatusBadge.className = 'voice-badge';
  joinVoiceTopBtn.classList.remove('in-call');
  joinVoiceTopBtn.innerHTML = '<span class="voice-icon-svg">🎙️</span> <span class="voice-join-text">Join Voice</span>';

  socket.emit('leave_voice');
}

// Toggle Mic Mute
function toggleMicMute() {
  if (!isVoiceConnected || !localVoiceStream) return;

  const audioTrack = localVoiceStream.getAudioTracks()[0];
  if (!audioTrack) return;

  isMicMuted = !isMicMuted;
  audioTrack.enabled = !isMicMuted;

  micToggleBtn.innerHTML = isMicMuted ? '🔇' : '🎙️';
  micToggleBtn.classList.toggle('active-muted', isMicMuted);

  socket.emit('voice_mute_toggle', { isMuted: isMicMuted });
}

// Toggle Deafen (Mutes all incoming audio)
function toggleDeafen() {
  if (!isVoiceConnected) return;

  isDeafened = !isDeafened;
  deafenToggleBtn.innerHTML = isDeafened ? '🔇' : '🔊';
  deafenToggleBtn.classList.toggle('active-muted', isDeafened);

  remoteAudioElements.forEach((audio, sockId) => {
    const savedVol = peerVolumes.has(sockId) ? peerVolumes.get(sockId) : 1;
    audio.volume = isDeafened ? 0 : savedVol;
  });
}

// Speech Detection Analyzer (Highlights avatar when speaking)
function setupSpeechDetection(stream) {
  try {
    const ctx = getAudioContext();
    if (!ctx) return;
    const source = ctx.createMediaStreamSource(stream);
    speechAnalyser = ctx.createAnalyser();
    speechAnalyser.fftSize = 512;
    source.connect(speechAnalyser);

    const dataArray = new Uint8Array(speechAnalyser.frequencyBinCount);
    let wasSpeaking = false;

    speechInterval = setInterval(() => {
      if (!isVoiceConnected || isMicMuted) {
        if (wasSpeaking) {
          wasSpeaking = false;
          socket.emit('voice_speaking', { isSpeaking: false });
          updateLocalAvatarSpeaking(false);
        }
        return;
      }

      speechAnalyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const average = sum / dataArray.length;
      const isSpeakingNow = average > 18; // Voice threshold

      if (isSpeakingNow !== wasSpeaking) {
        wasSpeaking = isSpeakingNow;
        socket.emit('voice_speaking', { isSpeaking: isSpeakingNow });
        updateLocalAvatarSpeaking(isSpeakingNow);
      }
    }, 120);
  } catch (err) {}
}

function updateLocalAvatarSpeaking(isSpeaking) {
  const myVoiceAvatar = document.querySelector(`.voice-user-card[data-socket-id="me"] .voice-avatar`);
  if (myVoiceAvatar) {
    myVoiceAvatar.classList.toggle('is-speaking', isSpeaking);
  }
}

// Create WebRTC Peer Connection with a Remote Peer
function createPeerConnection(targetSocketId) {
  if (peerConnections.has(targetSocketId)) {
    return peerConnections.get(targetSocketId);
  }

  const pc = new RTCPeerConnection(rtcConfig);
  peerConnections.set(targetSocketId, pc);

  // Add local microphone audio tracks
  if (localVoiceStream) {
    localVoiceStream.getTracks().forEach((track) => {
      pc.addTrack(track, localVoiceStream);
    });
  }

  // Handle ICE Candidates
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('voice_ice_candidate', {
        targetSocketId,
        candidate: event.candidate,
      });
    }
  };

  // Handle incoming remote audio stream
  pc.ontrack = (event) => {
    let audioElem = remoteAudioElements.get(targetSocketId);
    if (!audioElem) {
      audioElem = document.createElement('audio');
      audioElem.autoplay = true;
      audioElem.id = `remote_audio_${targetSocketId}`;
      audioStreamsContainer.appendChild(audioElem);
      remoteAudioElements.set(targetSocketId, audioElem);
    }
    audioElem.srcObject = event.streams[0];
    const initialVol = peerVolumes.has(targetSocketId) ? peerVolumes.get(targetSocketId) : 1;
    audioElem.volume = isDeafened ? 0 : initialVol;
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      cleanupPeer(targetSocketId);
    }
  };

  return pc;
}

function cleanupPeer(targetSocketId) {
  if (peerConnections.has(targetSocketId)) {
    peerConnections.get(targetSocketId).close();
    peerConnections.delete(targetSocketId);
  }
  if (remoteAudioElements.has(targetSocketId)) {
    const audio = remoteAudioElements.get(targetSocketId);
    audio.srcObject = null;
    audio.remove();
    remoteAudioElements.delete(targetSocketId);
  }
  voicePeers.delete(targetSocketId);
  renderVoiceUsers();
}

// Render Voice Users with Volume Sliders
function renderVoiceUsers() {
  voiceUsersList.innerHTML = '';
  const total = voicePeers.size + (isVoiceConnected ? 1 : 0);
  voiceCount.textContent = total;

  if (total === 0) {
    voiceEmptyHint.style.display = 'block';
    voiceUsersList.appendChild(voiceEmptyHint);
    return;
  }
  voiceEmptyHint.style.display = 'none';

  // 1. Render Local User Card if in voice
  if (isVoiceConnected) {
    const myCard = document.createElement('li');
    myCard.className = 'voice-user-card';
    myCard.dataset.socketId = 'me';

    myCard.innerHTML = `
      <div class="voice-user-header">
        <div class="voice-user-left">
          <div class="voice-avatar" style="background-color: ${currentUser.avatarColor || '#6366f1'}">${getInitials(currentUser.username)}</div>
          <span class="voice-user-name">${escapeHTML(currentUser.username)} (You)</span>
        </div>
        <span class="voice-mute-icon" id="myVoiceMuteIcon">${isMicMuted ? '🔇' : ''}</span>
      </div>
    `;
    voiceUsersList.appendChild(myCard);
  }

  // 2. Render Remote Voice Peers with Volume Controls
  voicePeers.forEach((peer) => {
    const card = document.createElement('li');
    card.className = 'voice-user-card';
    card.dataset.socketId = peer.socketId;

    const currentVolPct = Math.round((peerVolumes.has(peer.socketId) ? peerVolumes.get(peer.socketId) : 1) * 100);

    card.innerHTML = `
      <div class="voice-user-header">
        <div class="voice-user-left">
          <div class="voice-avatar ${peer.isSpeaking ? 'is-speaking' : ''}" style="background-color: ${peer.avatarColor || '#6366f1'}">${getInitials(peer.username)}</div>
          <span class="voice-user-name">${escapeHTML(peer.username)}</span>
        </div>
        <span class="voice-mute-icon">${peer.isMuted ? '🔇' : ''}</span>
      </div>
      <div class="voice-volume-row">
        <span class="vol-icon">🔉</span>
        <input type="range" class="vol-slider" min="0" max="100" value="${currentVolPct}">
        <span class="vol-pct">${currentVolPct}%</span>
      </div>
    `;

    // Hook up volume slider
    const slider = card.querySelector('.vol-slider');
    const pctSpan = card.querySelector('.vol-pct');
    slider.addEventListener('input', () => {
      const vol = slider.value / 100;
      peerVolumes.set(peer.socketId, vol);
      pctSpan.textContent = `${slider.value}%`;
      const remoteAudio = remoteAudioElements.get(peer.socketId);
      if (remoteAudio && !isDeafened) {
        remoteAudio.volume = vol;
      }
    });

    voiceUsersList.appendChild(card);
  });
}

// Voice Buttons Event Listeners
joinVoiceTopBtn.addEventListener('click', startVoiceCall);
leaveVoiceBtn.addEventListener('click', leaveVoiceCall);
micToggleBtn.addEventListener('click', toggleMicMute);
deafenToggleBtn.addEventListener('click', toggleDeafen);

// Voice Socket Signaling Handlers
socket.on('voice_existing_peers', async ({ peers, room }) => {
  for (const peer of peers) {
    voicePeers.set(peer.socketId, {
      ...peer,
      isSpeaking: false,
    });
    // Create WebRTC Offer to connect with peer
    const pc = createPeerConnection(peer.socketId);
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('voice_offer', {
        targetSocketId: peer.socketId,
        offer,
      });
    } catch (err) {
      console.error('Failed to create voice offer:', err);
    }
  }
  renderVoiceUsers();
});

socket.on('voice_peer_joined', (peer) => {
  voicePeers.set(peer.socketId, {
    ...peer,
    isSpeaking: false,
  });
  renderVoiceUsers();
});

socket.on('voice_offer', async ({ senderSocketId, offer, id, username, avatarColor }) => {
  voicePeers.set(senderSocketId, {
    socketId: senderSocketId,
    id,
    username,
    avatarColor,
    isMuted: false,
    isSpeaking: false,
  });
  renderVoiceUsers();

  const pc = createPeerConnection(senderSocketId);
  try {
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice_answer', {
      targetSocketId: senderSocketId,
      answer,
    });
  } catch (err) {
    console.error('Failed to handle voice offer:', err);
  }
});

socket.on('voice_answer', async ({ senderSocketId, answer }) => {
  const pc = peerConnections.get(senderSocketId);
  if (pc) {
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error('Failed to set remote voice answer:', err);
    }
  }
});

socket.on('voice_ice_candidate', async ({ senderSocketId, candidate }) => {
  const pc = peerConnections.get(senderSocketId);
  if (pc) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('Failed to add voice ICE candidate:', err);
    }
  }
});

socket.on('voice_peer_speaking', ({ socketId, isSpeaking }) => {
  const peer = voicePeers.get(socketId);
  if (peer) {
    peer.isSpeaking = isSpeaking;
    const card = document.querySelector(`.voice-user-card[data-socket-id="${socketId}"] .voice-avatar`);
    if (card) card.classList.toggle('is-speaking', isSpeaking);
  }
});

socket.on('voice_peer_muted', ({ socketId, isMuted }) => {
  const peer = voicePeers.get(socketId);
  if (peer) {
    peer.isMuted = isMuted;
    renderVoiceUsers();
  }
});

socket.on('voice_peer_left', ({ socketId }) => {
  cleanupPeer(socketId);
});

socket.on('voice_users_updated', (vUsers) => {
  // Update voice user list for room members not in the voice call
  if (!isVoiceConnected) {
    voiceUsersList.innerHTML = '';
    voiceCount.textContent = vUsers.length;
    if (vUsers.length === 0) {
      voiceEmptyHint.style.display = 'block';
      voiceUsersList.appendChild(voiceEmptyHint);
    } else {
      voiceEmptyHint.style.display = 'none';
      vUsers.forEach((vu) => {
        const item = document.createElement('li');
        item.className = 'voice-user-card';
        item.innerHTML = `
          <div class="voice-user-header">
            <div class="voice-user-left">
              <div class="voice-avatar" style="background-color: ${vu.avatarColor || '#6366f1'}">${getInitials(vu.username)}</div>
              <span class="voice-user-name">${escapeHTML(vu.username)}</span>
            </div>
            <span class="voice-mute-icon">${vu.isMuted ? '🔇' : ''}</span>
          </div>
        `;
        voiceUsersList.appendChild(item);
      });
    }
  }
});

// ================= End VoIP Implementation ================= //

// Create Message Element with Reaction Support
function createMessageElement(msg) {
  const isOwn = msg.senderId === currentUser.id;

  const row = document.createElement('div');
  row.className = `message-row ${isOwn ? 'is-own' : ''}`;
  row.dataset.msgId = msg.id;

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

function appendSystemNotice(text) {
  const div = document.createElement('div');
  div.className = 'system-notice';
  div.innerHTML = `<span class="system-notice-pill">${escapeHTML(text)}</span>`;
  messagesList.appendChild(div);
  if (!userScrolledUp) scrollToBottom();
}

function switchRoom(newRoom) {
  if (newRoom === currentRoom && currentUser.username) return;

  // If in voice, leave voice before switching channel
  if (isVoiceConnected) {
    leaveVoiceCall();
  }

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

// Status selection
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
  if (isVoiceConnected) {
    leaveVoiceCall();
  }
});

socket.on('rooms_list', (rooms) => {
  renderRooms(rooms);
});

socket.on('joined_room_success', ({ user, room, history, voiceUsers: vUsers }) => {
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

  if (vUsers) {
    renderVoiceUsers();
  }
});

socket.on('username_updated', ({ username }) => {
  currentUser.username = username;
  localStorage.setItem('pulsechat_username', username);
  currentUserName.textContent = username;
  currentUserAvatar.textContent = getInitials(username);
  renderVoiceUsers();
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

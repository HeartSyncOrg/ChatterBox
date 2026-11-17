# PulseChat ⚡

A modern, real-time multi-room web chat application built with **Node.js**, **Express**, and **Socket.IO**.

---

## ✨ Features

- **Real-Time Messaging**: Instant bi-directional communication using Socket.IO WebSockets.
- **Channels & Rooms**:
  - Pre-configured rooms: `#general`, `#random`, `#tech`, `#lounge`.
  - Dynamically create or join custom channels on the fly.
  - Recent message history per room (up to 100 messages retained in memory).
- **User Presence & Status**:
  - Live active member counter and participant list for the current channel.
  - Automatic avatar generation with initials and persistent color palettes.
  - System notices when users join, switch rooms, update names, or disconnect.
- **Typing Indicator**: Real-time debounced indicator showing when other participants are typing.
- **Audio Feedback**: Subtle, non-intrusive sound alerts powered by the native Web Audio API (toggleable on/off).
- **Quick Emojis**: One-click quick emoji picker for reactions and fun messages.
- **Responsive Modern UI**:
  - Dark sleek theme styled with clean typography and smooth transitions.
  - Full mobile responsiveness with a collapsible drawer sidebar.
  - Distinction between your sent messages and incoming messages.

---

## 📁 Project Structure

```text
HeartSyncOrg/
├── server.js          # Express server & Socket.IO event handlers
├── package.json       # Project dependencies and start scripts
├── README.md          # Project documentation
└── public/
    ├── index.html     # Semantic HTML layout and modals
    ├── style.css      # Dark-mode styling, animations, and responsiveness
    └── client.js      # Client-side Socket.IO logic, UI updates, and audio
```

---

## 🚀 Getting Started

### 1. Prerequisites
Ensure you have **Node.js** (v16+) installed.

### 2. Installation
Install the dependencies:
```bash
npm install
```

### 3. Run the Server
Start the chat server:
```bash
npm start
```

Open your browser and navigate to:
```text
http://localhost:3000
```

> **Tip**: Open two different browser tabs or an incognito window to simulate multiple users chatting in real-time!

---

## 🔌 Socket.IO Events Reference

| Event Name | Direction | Payload | Description |
|---|---|---|---|
| `join_room` | Client ➔ Server | `{ username, room }` | Joins a designated channel |
| `joined_room_success` | Server ➔ Client | `{ user, room, history }` | Confirms room join & sends history |
| `send_message` | Client ➔ Server | `{ text }` | Submits a chat message |
| `new_message` | Server ➔ Client | `{ id, username, text, ... }` | Broadcasts new message to room members |
| `typing` | Client ➔ Server | `{ isTyping }` | Emits user typing state |
| `user_typing` | Server ➔ Client | `{ username, isTyping }` | Notifies room participants of typing activity |
| `update_username` | Client ➔ Server | `{ newUsername }` | Changes display name |
| `room_users` | Server ➔ Client | `Array<User>` | Updates active user list in current room |
| `rooms_list` | Server ➔ Client | `Array<string>` | Lists all available channels |
| `system_message` | Server ➔ Client | `{ id, text, timestamp }` | Broadcasts join/leave/rename announcements |
# ChatterBox

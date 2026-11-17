# ChatterBox — Complete Repository Audit

**Date of Audit**: November 17, 2026  
**Auditor**: Senior Software Architect / Staff Full-Stack Engineer  
**Organization**: HeartSyncOrg  
**Repository**: ChatterBox  
**Commit Inspected**: `a1171a6` (HEAD on `main`)

---

## 1. Executive Summary

ChatterBox is currently an early-stage real-time web chat and VoIP voice proof-of-concept. It is implemented as a lightweight Node.js/Express monolith with Socket.IO for real-time messaging and signaling, accompanied by a vanilla JavaScript single-page client that establishes browser-to-browser WebRTC mesh audio calls.

While the current codebase demonstrates functional real-time text broadcast, WebRTC audio streaming, mobile-friendly CSS, and baseline anti-spam rate limiting, it operates entirely **in-memory without any database, authentication, or persistent storage**. Transitioning ChatterBox into a modern, production-grade social communication platform (unifying Discord-like communities, WhatsApp-like messaging, and Instagram/Snapchat-like social interaction) requires establishing a hardened architectural foundation, database persistence, proper authentication, and a modular architecture.

---

## 2. Codebase Inventory & Directory Structure

```text
ChatterBox/
├── .git/                     # Git version control metadata
├── .gitignore                # Git ignore rules (node_modules, logs, .env)
├── docs/                     # Architectural and audit documentation
│   ├── Repository_Audit.md
│   ├── Current_Architecture.md
│   ├── Technical_Debt.md
│   └── Implementation_Status.md
├── node_modules/             # Installed dependencies
├── package.json              # Dependency declarations and scripts
├── package-lock.json         # Pinned dependency lockfile
├── public/                   # Static frontend assets
│   ├── client.js             # Client-side UI & WebRTC VoIP logic (1,198 lines)
│   ├── index.html            # Single-page HTML layout (251 lines)
│   └── style.css             # Vanilla CSS styles & animations (1,416 lines)
├── README.md                 # Project overview and start instructions
└── server.js                 # Monolithic Express + Socket.IO server (623 lines)
```

**Total Line Count**: ~3,594 lines of code (excluding `package-lock.json` and `node_modules`).

---

## 3. Technology Stack Analysis

| Layer | Current Technology | Version | Assessment |
|---|---|---|---|
| **Runtime** | Node.js | v24.22.1 | Modern, active LTS runtime. |
| **Backend Framework** | Express | v5.3.0 | Modern Express 5.x. Handles HTTP static file serving and basic security middleware. |
| **Realtime Engine** | Socket.IO | v4.8.4 | Standard WebSocket with long-polling fallback. Operates as an event bus and WebRTC signaling server. |
| **HTTP Security** | Helmet | v8.3.0 | Configures Content Security Policy (CSP), HSTS, and frame protection. |
| **Compression** | Compression | v1.8.2 | Gzip/deflate response compression for HTTP static assets. |
| **Database** | **None** | — | **Critical Gap**: In-memory JavaScript `Map` and `Set` objects only. State is wiped on every restart. |
| **ORM / Migrations** | **None** | — | No schema management or data migration tooling. |
| **Authentication** | **None** | — | Ephemeral pseudonym stored in client `localStorage`. No credentials, hashing, JWT, or sessions. |
| **VoIP / Media** | WebRTC (Mesh) | Standard Browser API | Direct P2P audio mesh with Google public STUN servers. No SFU/MCU; bandwidth scales at $O(N^2)$. |
| **Frontend Framework** | Vanilla JS (ES6+) | Native Browser | Direct DOM manipulation. No component abstraction, virtual DOM, or declarative state management. |
| **Styling** | Vanilla CSS3 | Native CSS | Custom CSS with CSS variables, flexbox, grid, and media queries. Well-optimized for mobile. |
| **Build & Bundling** | **None** | — | Files are served unbundled. No TypeScript compiler, Vite, or Webpack. |
| **Testing** | **None** | — | No unit, integration, or E2E tests exist. `npm test` fails with default error. |

---

## 4. Dependencies & Package Health

### `package.json` Inspection
```json
{
  "name": "pulsechat",
  "version": "1.0.0",
  "description": "A modern, lightweight real-time chat system built with Node.js, Express, and Socket.IO.",
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "compression": "^1.8.2",
    "express": "^5.3.0",
    "helmet": "^8.3.0",
    "socket.io": "^4.8.4"
  }
}
```

### Observations:
1. **Naming Inconsistency**: Package name is declared as `"pulsechat"`, whereas the GitHub repository and product name is `"ChatterBox"`.
2. **Missing Scripts**: No `"build"`, `"test"`, `"lint"`, `"format"`, or `"dev"` scripts.
3. **Zero DevDependencies**: Missing essential engineering dependencies such as ESLint, Prettier, TypeScript, Jest/Vitest, or Supertest.
4. **Vulnerability Audit**: Running `npm audit` reports 0 vulnerabilities across 96 audited packages.

---

## 5. Persistence, State, and Memory Management

### Current In-Memory State (`server.js`):
- `users = new Map()`: Maps `socket.id` to `{ id, publicId, username, room, avatarColor, status, rateLimitWindow, msgCount, cooldownUntil, lastMsgText, dupCount }`.
- `voiceUsers = new Map()`: Maps `socket.id` to active VoIP participants.
- `customRooms = new Set()`: Stores user-created channels (capped at 60 to prevent unbounded memory growth).
- `messageHistory = new Map()`: Stores recent messages per channel (capped at 120 messages per channel).

### Risks & Limitations:
- **No Persistence**: Terminating the server immediately purges all user accounts, messages, and custom channels.
- **Horizontal Scaling Impossible**: State is tied to the memory space of a single Node.js process. Running multiple instances behind a load balancer will break room broadcasting and WebRTC signaling without a shared Redis adapter (`@socket.io/redis-adapter`).

---

## 6. Authentication and Authorization Inspection

### Current Identity Model:
- When a user loads `index.html`, a modal prompt asks for a "Display Name" and a starting channel.
- The name is stored in `localStorage` under `pulsechat_username`.
- The server generates an ephemeral random 8-byte hexadecimal ID (`crypto.randomBytes(8).toString('hex')`) designated as `user.publicId`.
- **There is no verification**: Anyone can claim any username. There are no passwords, OAuth providers, or session tokens.

### Current Authorization Model:
- **No Role-Based Access Control (RBAC)**: Any client can trigger `delete_room` or `clear_room_history`.
- Default channels (`general`, `random`, `tech`, `lounge`) have basic server-side name protection, but custom channels can be deleted by any participant.

---

## 7. Real-Time Messaging & Event Protocol

### Protocol:
Socket.IO over WebSocket (with HTTP long-polling fallback).

### Event Matrix:

| Event | Direction | Payload | Validation & Sanitization |
|---|---|---|---|
| `join_room` | Inbound | `{ username, room }` | Max 24 chars, control chars stripped, alphanumeric room name. |
| `joined_room_success` | Outbound | `{ user, room, isDefault, history, voiceUsers }` | Confirms channel join and returns recent history. |
| `send_message` | Inbound | `{ text }` | Max 600 chars, bracket stripping, rate limiting (3 msgs / 2s), duplicate filter. |
| `new_message` | Outbound | Message Object | Broadcasts message with ID, avatar color, timestamp, text, and empty reactions. |
| `toggle_reaction` | Inbound | `{ messageId, emoji }` | Validates against whitelist `['👍', '❤️', '🔥', '😂', '🎉', '🚀']`. |
| `reaction_updated` | Outbound | `{ messageId, reactions }` | Broadcasts updated reaction counts to room. |
| `delete_room` | Inbound | `{ room }` | Prevents deletion of default rooms; removes custom room and moves users to `#general`. |
| `clear_room_history` | Inbound | None | Wipes in-memory backlog for current room. |
| `typing` | Inbound | `{ isTyping }` | Throttled on client; relayed to other room participants. |
| `update_username` | Inbound | `{ newUsername }` | Max 24 chars; notifies room participants. |
| `update_status` | Inbound | `{ status }` | Validates against `['online', 'away', 'busy']`. |

---

## 8. Voice & VoIP Implementation

### Architecture:
- Full WebRTC Peer-to-Peer Mesh (client-to-client direct audio).
- Signaling mediated by Socket.IO:
  - `join_voice` -> `voice_existing_peers` -> `voice_peer_joined`
  - `voice_offer` <-> `voice_answer` <-> `voice_ice_candidate`
  - `voice_speaking` (volume threshold analyzer via Web Audio API)
  - `voice_mute_toggle`
  - `leave_voice` -> `voice_peer_left`
- Audio controls:
  - Local microphone mute (`track.enabled = false`).
  - Local deafen (sets all remote audio element volumes to `0`).
  - Remote per-user volume control (adjusts HTMLAudioElement `volume` property between `0.0` and `1.0`).
- STUN Infrastructure: Public Google STUN servers (`stun.l.google.com:19302`).

### Scalability Ceiling:
- In a full mesh topology, every participant maintains $(N - 1)$ bidirectional audio streams.
- For $N = 8$ users, each client must encode, encrypt, and upload 7 distinct audio streams ($7 \times 50\text{ kbps} \approx 350\text{ kbps}$ upstream per client, and $N(N-1) = 56$ streams across the room).
- Group voice calls beyond 4–6 participants will encounter network degradation on mobile and constrained connections.

---

## 9. UI/UX and Mobile Architecture

### Features Verified:
- **Mobile Responsive Layout**: Uses `100dvh` to handle virtual keyboard resizing on iOS Safari and Android Chrome.
- **Safe Area Insets**: Accommodates device notches and navigation bars via `env(safe-area-inset-top)` and `env(safe-area-inset-bottom)`.
- **Touch Targets**: Minimum 44px tap targets for buttons on mobile.
- **Drawer Navigation**: Collapsible sidebar with swipe-to-close gesture support.
- **Virtual Audio Elements**: Dynamically created `<audio autoplay>` elements appended to a hidden container.
- **Smart Auto-Scroll**: Avoids interrupting users when reading backlog by calculating viewport distance from bottom, with a floating "↓ New messages" badge.

---

## 10. Security and Privacy Audit

### Positive Controls in Place:
1. **Helmet Middleware**: Configures strict CSP, HSTS, frame-ancestors, and MIME sniffing protection.
2. **Input Sanitization**: Control characters (`\u0000-\u001F`) and HTML brackets (`<`, `>`) are stripped on input.
3. **XSS Protection**: Message rendering utilizes DOM `.textContent` rather than `.innerHTML`.
4. **Anti-Spam Controls**: Token bucket rate limiting (3 msgs / 2s), consecutive duplicate message blocking, and temporary 5-second mutes.
5. **Opaque Public IDs**: Client `socket.id` is not exposed in public message payloads.

### Vulnerabilities & Security Gaps:
1. **No End-to-End Encryption (E2EE)**: Messages and audio streams are unencrypted at the application layer. (Voice uses DTLS-SRTP mandated by WebRTC at the transport layer, but has no application-level E2EE identity verification).
2. **No User Authentication**: Identity spoofing is trivial because usernames are unauthenticated.
3. **No Granular Authorization**: Any client can issue `delete_room` or `clear_room_history` socket events.
4. **No Media Upload Validation**: The app currently does not support file attachments, which avoids storage vulnerabilities for now, but will require virus scanning, file type validation, and signed URLs when media is implemented.

---

## 11. Testing and CI/CD Status

- **Unit Tests**: 0 tests.
- **Integration Tests**: 0 tests.
- **End-to-End Tests**: 0 tests.
- **CI/CD Workflows**: None (`.github/workflows` does not exist).
- **Static Analysis**: No linter or type-checking configuration present.

---

## 12. Audit Summary & Conclusion

The existing ChatterBox codebase provides a clean, working prototype for real-time text broadcast and P2P VoIP audio. The architecture is well-written for what it is, but currently functions as a **single-node prototype with no persistence**.

To evolve ChatterBox into the requested multi-pillar social platform (Pillars A through E), the system requires:
1. A relational persistence layer (PostgreSQL) and caching layer (Redis).
2. An authentication & authorization framework (JWT / Sessions, Argon2 password hashing).
3. A modular domain-driven codebase separation (splitting `server.js` into modular routes, controllers, services, and models; splitting `client.js` into modular components).
4. Testing infrastructure and automated GitHub Actions CI.

# ChatterBox — Technical Debt Report

**Analysis of Architectural, Security, and Engineering Debt**  
**Version**: 1.0.0-poc  
**Date**: November 17, 2026  

---

## 1. Executive Summary

The ChatterBox repository currently represents an agile, functional proof-of-concept. However, it carries significant technical debt that prevents it from functioning as a scalable, multi-tenant social communication platform. This document enumerates all existing technical debt items, categorizing them by severity, risk, blast radius, and remediation strategy.

---

## 2. Debt Classification Matrix

| ID | Category | Severity | Description | Blast Radius | Remediation Effort |
|---|---|---|---|---|---|
| **TD-01** | Architecture | **CRITICAL** | Zero persistent database storage. All data resides in volatile process memory. | Total data loss on restart; zero horizontal scaling. | High |
| **TD-02** | Security | **CRITICAL** | Absence of authentication, password hashing, and user credential verification. | Trivial identity spoofing; zero account security. | High |
| **TD-03** | Authorization | **CRITICAL** | Lack of role-based access control (RBAC). Any client can delete rooms or wipe history. | Unauthorized channel deletion, denial of service. | Medium |
| **TD-04** | VoIP / Media | **HIGH** | Full WebRTC peer-to-peer mesh architecture scales at $O(N^2)$. | Quality degradation in group calls with $>4$ users. | High |
| **TD-05** | Maintainability | **HIGH** | Monolithic single-file backend (`server.js`) and frontend (`client.js`). | Code rot, high collision rate for teams, low testability. | Medium |
| **TD-06** | Type Safety | **HIGH** | Lack of static type checking (plain JavaScript without TypeScript). | Silent runtime type errors, difficult refactoring. | Medium |
| **TD-07** | Quality Assurance | **HIGH** | Complete absence of automated tests (unit, integration, or E2E). | Regressions undetectable prior to deployment. | Medium |
| **TD-08** | DevOps / CI | **MEDIUM** | No continuous integration (CI) workflows, Dockerfile, or linting. | Inconsistent developer environments, untracked builds. | Low |
| **TD-09** | Security / Crypto | **HIGH** | No End-to-End Encryption (E2EE) for text messages. | Plaintext exposure on server and signaling paths. | High |
| **TD-10** | Media Storage | **MEDIUM** | No file, image, or video attachment pipeline or object storage integration. | Inability to share media in chat or stories. | Medium |

---

## 3. Deep-Dive Debt Item Analysis

### TD-01: Zero Database Persistence (CRITICAL)
- **Current State**: `users`, `voiceUsers`, `customRooms`, and `messageHistory` are plain in-memory JavaScript `Map` and `Set` instances.
- **Problem**:
  1. Restarting the server or redeploying immediately terminates all sessions and erases all chat history.
  2. Memory usage grows linearly with messages and rooms until process heap limits trigger an out-of-memory crash.
  3. The server cannot be scaled horizontally across multiple instances because there is no shared database or Redis pub/sub layer.
- **Remediation**:
  - Introduce **PostgreSQL** for relational entities (Users, Profiles, Communities, Channels, Messages, Friendships, Audit Logs).
  - Introduce an ORM/Query Builder with migrations (e.g. Prisma or Drizzle ORM).
  - Introduce **Redis** for ephemeral presence, active socket mappings, rate limiting tokens, and Socket.IO multi-node clustering adapter.

---

### TD-02: Absence of Authentication & Credential Verification (CRITICAL)
- **Current State**: Users enter any display name in an unauthenticated modal prompt. The client stores it in browser `localStorage`.
- **Problem**:
  - Anyone can impersonate another user by entering the same display name.
  - No user ownership, no password recovery, and no multi-device support.
- **Remediation**:
  - Implement secure user registration and login with email/username.
  - Hash passwords using **Argon2id** or **bcrypt** with appropriate work factors.
  - Issue cryptographically signed **HTTP-only, Secure, SameSite JWT or session cookies** accompanied by refresh token rotation.
  - Authenticate Socket.IO connections via handshake middleware (`socket.use(...)`).

---

### TD-03: Lack of Role-Based Access Control (RBAC) (CRITICAL)
- **Current State**: Socket events `delete_room` and `clear_room_history` check only if the channel is not in `defaultRooms`. Any connected client can trigger them.
- **Problem**: A malicious or playful user can wipe history or delete channels created by others.
- **Remediation**:
  - Introduce structured permissions (`OWNER`, `ADMIN`, `MODERATOR`, `MEMBER`).
  - Verify channel ownership and role permissions in all mutation handlers before executing state updates.

---

### TD-04: Full WebRTC Mesh Scaling Limits (HIGH)
- **Current State**: WebRTC voice calling establishes direct peer-to-peer peer connections between every pair of users in a channel.
- **Problem**:
  - In a room of $N$ users, each client must upload and encode $(N - 1)$ audio streams and download $(N - 1)$ audio streams.
  - On mobile networks and smartphones, battery drain spikes and audio begins stuttering when $N > 4$ to $6$.
- **Remediation**:
  - Preserve the simple P2P mesh for **1-on-1 direct calls**.
  - For **group voice channels and video rooms**, evaluate and integrate an **SFU (Selective Forwarding Unit)** such as **LiveKit** or mediasoup, allowing each client to upload only 1 stream and download composite streams.

---

### TD-05: Monolithic Code Organization (HIGH)
- **Current State**:
  - `server.js` contains Express configuration, Helmet security, HTTP static serving, Socket.IO setup, anti-spam logic, text chat handlers, and WebRTC signaling (623 lines in a single file).
  - `client.js` contains UI controls, DOM element handlers, WebAudio synthesizers, anti-spam timers, Socket.IO listeners, and WebRTC peer connection logic (1,198 lines in a single file).
- **Problem**: High cognitive load, tight coupling, impossible to write isolated unit tests, and prone to merge conflicts in collaborative team environments.
- **Remediation**:
  - Refactor backend into a modular architecture:
    - `src/config/`: Configuration & environment loading.
    - `src/modules/auth/`: Authentication controllers, services, routes.
    - `src/modules/messages/`: Message processing, persistence, reactions.
    - `src/modules/channels/`: Channel management and permissions.
    - `src/modules/voice/`: WebRTC signaling and room routing.
    - `src/middleware/`: Rate limiting, authentication, error handling.
  - Refactor frontend into modern modular components or a structured framework.

---

### TD-06: Lack of Static Typing (TypeScript) (HIGH)
- **Current State**: 100% untyped JavaScript.
- **Problem**: Socket payload discrepancies, typos in event names (`voice_offer` vs `voice-offer`), and undefined property bugs are only caught at runtime.
- **Remediation**:
  - Introduce TypeScript configuration (`tsconfig.json`) across backend and frontend, sharing strict interface definitions for real-time events and data models.

---

### TD-07: Zero Test Coverage (HIGH)
- **Current State**: No test suite, test framework, or CI test pipeline.
- **Problem**: Any architectural improvement or feature addition risks breaking existing functionality undetected.
- **Remediation**:
  - Install **Vitest** or **Jest** for unit testing domain logic.
  - Install **Supertest** for testing HTTP REST endpoints.
  - Install **socket.io-client** integration tests to verify real-time signaling, messaging, and rate-limiting behaviors.

---

### TD-08: DevOps, Containerization & CI/CD (MEDIUM)
- **Current State**: No Dockerfile, `docker-compose.yml`, or GitHub Actions workflows.
- **Remediation**:
  - Create `Dockerfile` with multi-stage build.
  - Create `docker-compose.yml` defining Node.js, PostgreSQL, and Redis.
  - Add GitHub Actions CI workflow for linting, type-checking, and running automated test suites on pull requests.

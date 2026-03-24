# Architecture

Hopcode runs as two cooperating services, designed so the UI can restart without killing terminal sessions.

## Overview

```
Browser (xterm.js)
    │
    ├── HTTPS :3000 ──► UI Service (server-node.ts)
    │                      ├── Auth (cookie sessions)
    │                      ├── HTML / CSS / JS (inline)
    │                      ├── File browser API
    │                      ├── Voice WebSocket → Volcano ASR
    │                      └── Proxy ──► PTY Service
    │
    └── WSS /ws/:id ──► UI Service ──proxy──► PTY Service (pty-service.ts)
                                                ├── node-pty (bash/zsh)
                                                ├── xterm-headless (state)
                                                └── Scrollback serialization
```

## PTY Service (`src/pty-service.ts`)

Standalone daemon on `127.0.0.1:3002`. Manages terminal sessions.

- **HTTP API**
  - `GET /sessions` — list active sessions
  - `POST /sessions` — create a new session
  - `POST /sessions/:id/rename` — rename a session
  - `GET /sessions/:id/cwd` — get session working directory
- **WebSocket** `/ws/:sessionId` — bidirectional terminal I/O
- **Auth** — internal token (`x-pty-internal-token` header), not exposed to the internet
- **State** — each session has a `node-pty` process and an `xterm-headless` instance for scrollback serialization on reconnect

## UI Service (`src/server-node.ts`)

Public-facing server on port 3000. Serves the web interface.

- **Auth** — password from `AUTH_PASSWORD` env var, cookie-based sessions
- **HTML** — the entire frontend is inline in server-node.ts (single file deployment)
- **Voice** — Volcano ASR streaming via WebSocket (optional)
- **File browser** — filesystem operations (list, read, rename, delete, upload)
- **Terminal proxy** — transparently proxies WebSocket connections to PTY service

## Process Management

Both services are managed by pm2 via `ecosystem.config.cjs`:

```bash
# Start both services
pm2 start ecosystem.config.cjs

# Restart only UI (terminal sessions survive)
pm2 restart hopcode-ui

# Restart only PTY (caution: kills all sessions)
pm2 restart hopcode-pty
```

## Shared Code

`src/shared/protocol.ts` contains IPC types, port configuration, and the internal auth token helper shared between both services.

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `node-pty` | Spawn and manage pseudo-terminals |
| `@xterm/headless` | Server-side terminal state for scrollback |
| `@xterm/addon-serialize` | Serialize terminal state for reconnect |
| `ws` | WebSocket server (Node.js compatible) |

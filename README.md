<div align="center">

<img src="media/logo.svg" width="120" alt="Hopcode logo" />

# hopcode

**Hop into your code from anywhere.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![CI](https://github.com/hopcode-dev/hopcode/actions/workflows/ci.yml/badge.svg)](https://github.com/hopcode-dev/hopcode/actions/workflows/ci.yml)

<!-- TODO: Replace with actual demo GIF -->
<!-- ![hopcode demo](media/demo.gif) -->

A web-based terminal you can access from any device — with voice input, a file browser, and a mobile-first UI. Self-hosted, open source, single deploy.

[Quick Start](#quick-start) · [Features](#features) · [Docs](docs/) · [Contributing](CONTRIBUTING.md)

</div>

---

## Features

- **Code from anywhere** — access your dev machine from your phone, tablet, or any browser
- **Voice input** — hold to talk, speech goes straight to your terminal via streaming ASR
- **File browser** — Finder-style panel with swipe gestures, upload, rename, delete
- **File upload** — upload files from your device or paste images from clipboard
- **Session management** — multiple named sessions, reconnect without losing state
- **Mobile-first UI** — floating keys, swipe gestures, bottom bar, touch-optimized
- **Self-hosted** — your code stays on your machine, password-protected
- **Zero config** — works immediately, voice is optional

## Quick Start

```bash
git clone https://github.com/hopcode-dev/hopcode.git && cd hopcode && bun install && bun run go
```

A public HTTPS URL with an auth token is printed to your terminal — open it on your phone and you're in.

### Docker

```bash
docker build -t hopcode .
docker run -it --rm -v "$HOME":"$HOME" -w "$HOME" hopcode
```

The `-v` flag mounts your home directory into the container at the same path, so CLI tools (Claude Code, etc.) can access your files.

### Manual Setup

For more control (e.g. pm2 process management, custom password):

```bash
echo "AUTH_PASSWORD=yourpassword" > .env
pm2 start ecosystem.config.cjs
open http://localhost:3000
```

To expose via Cloudflare Tunnel manually:

```bash
AUTH_PASSWORD=yourpassword npx tsx src/server-node.ts --tunnel
```

## Why Hopcode?

| | Hopcode | SSH apps (Termius, Blink) | VS Code Server | Happy Coder |
|---|---|---|---|---|
| Voice input | Yes | No | No | No |
| File browser | Yes | No | Yes | No |
| Works in browser | Yes | No (native app) | Yes | Yes |
| Self-hosted | Yes | N/A | Yes | No |
| Any CLI tool | Yes | Yes | Yes | Claude only |
| Mobile UX | Built for it | Retrofitted | Not optimized | Built for it |
| Open source | MIT | No | Partially | No |

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_PASSWORD` | *(required)* | Login password |
| `PORT` | `3000` | UI service port |
| `SHELL_CMD` | `bash` | Shell to spawn |
| `VOLCANO_APP_ID` | — | Volcano Engine app ID (for voice) |
| `VOLCANO_TOKEN` | — | Volcano Engine token (for voice) |
| `VOLCANO_ASR_RESOURCE_ID` | `volc.bigasr.sauc.duration` | ASR resource ID |

## Architecture

Hopcode runs as two services so the UI can restart without killing terminal sessions:

```
Browser (xterm.js)
    │
    ├── :3000 → UI Service ─── auth, web UI, voice, file browser
    │               │
    │               └── proxy ──► PTY Service ─── node-pty, session state
    │                              :3002 (internal)
    │
    └── WebSocket ────────────► terminal I/O (proxied through UI)
```

- **UI Service** (`src/server-node.ts`) — public-facing, serves HTML, handles auth and voice
- **PTY Service** (`src/pty-service.ts`) — internal, manages terminal processes and scrollback

Both managed by pm2. See [docs/architecture.md](docs/architecture.md) for details.

## Voice Setup (Optional)

Voice uses [Volcano Engine](https://www.volcengine.com/) for streaming speech recognition. Hopcode works perfectly as a plain web terminal without it.

```bash
# Add to .env
VOLCANO_APP_ID=your_app_id
VOLCANO_TOKEN=your_token
```

Hold **Option** (Mac) or **Alt** (Windows/Linux) to record. On mobile, hold the voice bar.

## Contributing

Contributions welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before getting started.

## License

[MIT](LICENSE)

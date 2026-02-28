# hopcode

> Hop into your code from anywhere.

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

<!-- TODO: Add demo GIF here -->
<!-- ![hopcode demo](docs/demo.gif) -->

Remote terminal access from any device, with voice input for mobile. Self-hosted, open source, single container.

## Install

```bash
# One command
npx hopcode

# Or with Docker
docker run -p 3000:3000 -e AUTH_PASSWORD=mysecret hopcode
```

## Features

- **Code from anywhere** — access your dev machine from your phone, tablet, or any browser
- **Voice input** — hold Option/Alt to talk, text goes straight to your terminal
- **Mobile-optimized** — special keys, touch controls, responsive UI built for small screens
- **Session persistence** — reconnect without losing state, multiple sessions
- **Self-hosted** — your code stays on your machine, password-protected
- **Zero config** — works immediately, voice is optional

## Quick Start

```bash
# Clone and install
git clone https://github.com/hopcode-dev/hopcode.git
cd hopcode
npm install

# Start (password required)
AUTH_PASSWORD=mysecret npx tsx src/server-node.ts

# Open in browser
open http://localhost:3000
```

## Docker

```bash
# Build and run
docker build -t hopcode .
docker run -p 3000:3000 -e AUTH_PASSWORD=mysecret hopcode
```

## Remote Access

Expose your terminal over a Cloudflare Tunnel:

```bash
AUTH_PASSWORD=mysecret npx tsx src/server-node.ts --tunnel
```

Prints a public HTTPS URL you can open from your phone (password-protected).

## Why Hopcode?

| | Hopcode | SSH apps (Termius, Blink) | Happy Coder |
|---|---|---|---|
| Voice input | Yes | No | No |
| Works in browser | Yes | No (native app) | Yes |
| Self-hosted | Yes | N/A | No |
| Any CLI tool | Yes | Yes | Claude Code only |
| Mobile UX | Built for it | Retrofitted | Built for it |
| Open source | MIT | No | No |

## Voice Setup (Optional)

Voice uses [Volcano Engine](https://www.volcengine.com/) for speech recognition. Hopcode works perfectly as a plain web terminal without it.

To enable voice:

```bash
VOLCANO_APP_ID=your_app_id
VOLCANO_TOKEN=your_token
```

Hold **Option** (Mac) or **Alt** (Windows/Linux) to record. On mobile, hold the voice bar.

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `AUTH_PASSWORD` | *(required)* | Login password |
| `SHELL_CMD` | `bash` | Shell to spawn |
| `VOLCANO_APP_ID` | - | Volcano Engine app ID (for voice) |
| `VOLCANO_TOKEN` | - | Volcano Engine token (for voice) |
| `VOLCANO_ASR_RESOURCE_ID` | `volc.bigasr.sauc.duration` | ASR resource ID |
| `CLOUDFLARE_TUNNEL` | - | Set to `1` to enable tunnel |

## Architecture

```
Browser (xterm.js)
    |
    |-- WebSocket /ws/terminal --> node-pty (bash/zsh)
    |
    +-- WebSocket /ws/voice --> Volcano ASR --> text --> PTY
                                  (optional)

Server: Node.js + node-pty + xterm-headless (session persistence)
Tunnel: cloudflared (optional, --tunnel flag)
```

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE)

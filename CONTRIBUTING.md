# Contributing to Hopcode

Thanks for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/hopcode-dev/hopcode.git
cd hopcode

# Install dependencies (requires Bun)
bun install

# Create .env file
echo "AUTH_PASSWORD=dev" > .env

# Start both services with pm2
pm2 start ecosystem.config.cjs

# Or start manually (two terminals)
npx tsx src/pty-service.ts    # Terminal 1: PTY service on :3002
npx tsx src/server-node.ts    # Terminal 2: UI service on :3000
```

Open `http://localhost:3000` in your browser.

## Architecture

Hopcode runs as two services:

- **PTY Service** (`src/pty-service.ts`) — manages terminal sessions, runs on port 3002
- **UI Service** (`src/server-node.ts`) — serves the web UI, handles auth and voice, proxies to PTY service on port 3000

See [docs/architecture.md](docs/architecture.md) for details.

## Making Changes

1. **Open an issue first** — describe what you want to change and why
2. **Fork and branch** — create a feature branch from `master`
3. **Keep changes focused** — one feature or fix per PR
4. **Type check** — run `bunx tsc --noEmit` before submitting
5. **Test on mobile** — if your change touches the UI, test on a phone browser

## Pull Request Process

1. Fill out the PR template
2. Ensure `tsc --noEmit` passes
3. Describe what you changed and why
4. Link the related issue

## Code Style

- TypeScript, strict mode
- 2 space indentation
- No semicolons (follow existing style)
- Prefer `const` over `let`

## Reporting Bugs

Use the [bug report template](https://github.com/hopcode-dev/hopcode/issues/new?template=bug_report.md). Include your OS, browser, and device.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).

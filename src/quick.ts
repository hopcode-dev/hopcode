/**
 * hopcode quick launcher — one command to start everything
 *
 * Usage:
 *   bun run go          (or: npx tsx src/quick.ts)
 *
 * What it does:
 *   1. Generates a random AUTH_PASSWORD (unless already set)
 *   2. Starts PTY service + UI service + Cloudflare tunnel
 *   3. Prints a single URL with embedded auth token
 *   4. Open that URL on your phone → instant authenticated terminal
 */

import { spawn, execSync, type ChildProcess } from 'child_process';
import { createHmac, randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '..');
const TSX_CLI = resolve(PROJECT_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const PORT = parseInt(process.env.PORT || '3000');
const children: ChildProcess[] = [];
let shuttingDown = false;

function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill('SIGTERM'); } catch {}
  }
  // Force kill after 3s
  setTimeout(() => {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch {}
    }
    process.exit(0);
  }, 3000);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

function makeAuthToken(password: string, username: string): string {
  const hmac = createHmac('sha256', password).update(username).digest('hex');
  return `${username}:${hmac}`;
}

function preflight() {
  if (!existsSync(TSX_CLI)) {
    console.error('  tsx not found. Run: bun install');
    process.exit(1);
  }
}

async function main() {
  preflight();

  const password = process.env.AUTH_PASSWORD || randomBytes(16).toString('hex');
  const token = makeAuthToken(password, 'admin');
  const env = { ...process.env, AUTH_PASSWORD: password };

  // Start PTY service
  const pty = spawn('node', [TSX_CLI, 'src/pty-service.ts'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(pty);
  pty.stdout?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (!text.includes('ExperimentalWarning')) process.stderr.write(`[pty] ${text}`);
  });
  pty.stderr?.on('data', (d: Buffer) => {
    const text = d.toString();
    if (!text.includes('ExperimentalWarning')) process.stderr.write(`[pty] ${text}`);
  });
  pty.on('error', (err) => {
    console.error(`Failed to start PTY service: ${err.message}`);
  });
  pty.on('exit', (code, signal) => {
    if (!shuttingDown) console.error(`PTY service exited (code=${code}, signal=${signal})`);
  });

  // Start UI service with tunnel
  const ui = spawn('node', [TSX_CLI, 'src/server-node.ts', '--tunnel'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(ui);

  let tunnelUrl = '';

  function handleOutput(data: Buffer) {
    const text = data.toString();
    // Forward child output for debugging (filter noise)
    for (const line of text.split('\n')) {
      if (!line.trim() || line.includes('ExperimentalWarning')) continue;

      // Detect tunnel URL
      const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
      if (match && !tunnelUrl) {
        tunnelUrl = match[1]!;
        const fullUrl = `${tunnelUrl}/?token=${encodeURIComponent(token)}`;
        console.log(`
  \x1b[32m🐸 hopcode\x1b[0m

  Open on your phone:
  \x1b[1;4m${fullUrl}\x1b[0m

  Local: http://localhost:${PORT}
  Press Ctrl+C to stop
`);
      } else if (!tunnelUrl) {
        // Show child output until tunnel is established (helps debug startup issues)
        process.stderr.write(`[ui] ${line}\n`);
      }
    }
  }

  ui.stdout?.on('data', handleOutput);
  ui.stderr?.on('data', handleOutput);
  ui.on('error', (err) => {
    console.error(`Failed to start UI service: ${err.message}`);
  });
  ui.on('exit', (code, signal) => {
    if (!shuttingDown) {
      console.error(`UI service exited (code=${code}, signal=${signal})`);
      cleanup();
    }
  });

  // Print local URL while tunnel is connecting
  setTimeout(() => {
    if (!tunnelUrl && !shuttingDown) {
      console.log(`
  \x1b[32m🐸 hopcode\x1b[0m

  Starting tunnel... (this may take a moment)
  Local: http://localhost:${PORT}/?token=${encodeURIComponent(token)}
`);
    }
  }, 3000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});

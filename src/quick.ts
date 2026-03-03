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

import { spawn, type ChildProcess } from 'child_process';
import { createHmac, randomBytes } from 'crypto';

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

async function main() {
  const password = process.env.AUTH_PASSWORD || randomBytes(16).toString('hex');
  const token = makeAuthToken(password, 'admin');
  const env = { ...process.env, AUTH_PASSWORD: password };

  // Start PTY service
  const pty = spawn('npx', ['tsx', 'src/pty-service.ts'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(pty);
  pty.stderr?.on('data', (d: Buffer) => {
    const line = d.toString();
    if (!line.includes('ExperimentalWarning')) process.stderr.write(`[pty] ${line}`);
  });
  pty.on('exit', (code) => {
    if (!shuttingDown) console.error(`PTY service exited with code ${code}`);
  });

  // Start UI service with tunnel
  const ui = spawn('npx', ['tsx', 'src/server-node.ts', '--tunnel'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(ui);

  let tunnelUrl = '';

  function handleOutput(data: Buffer) {
    const text = data.toString();
    for (const line of text.split('\n')) {
      if (line.includes('ExperimentalWarning')) continue;

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
      }
    }
  }

  ui.stdout?.on('data', handleOutput);
  ui.stderr?.on('data', handleOutput);
  ui.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`UI service exited with code ${code}`);
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

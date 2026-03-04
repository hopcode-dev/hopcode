#!/usr/bin/env npx tsx
/**
 * Hopcode Self-Diagnose — checks the full service chain health
 * Usage:
 *   npx tsx src/diagnose.ts           # CLI output
 *   npx tsx src/diagnose.ts --json    # JSON output
 *   npx tsx src/diagnose.ts --watch 5 # repeat every 5s
 */

import 'dotenv/config';
import { createHmac } from 'crypto';
import { execSync } from 'child_process';
import WebSocket from 'ws';
import {
  PTY_SERVICE_PORT,
  PTY_INTERNAL_TOKEN_HEADER,
  getPtyInternalToken,
} from './shared/protocol.js';

// ─── Config ────────────────────────────────────────────────────────────

const UI_PORT = parseInt(process.env.PORT || '3000');
const PTY_PORT = PTY_SERVICE_PORT;
const PASSWORD = process.env.AUTH_PASSWORD || '';
const PTY_TOKEN = getPtyInternalToken();
const UI_BASE = `http://127.0.0.1:${UI_PORT}`;
const PTY_BASE = `http://127.0.0.1:${PTY_PORT}`;

// ─── Types ─────────────────────────────────────────────────────────────

export interface CheckResult {
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN';
  ms: number;
  detail?: string;
}

export interface DiagnoseReport {
  timestamp: string;
  checks: CheckResult[];
  summary: { total: number; passed: number; failed: number; warned: number };
}

// ─── Helpers ───────────────────────────────────────────────────────────

async function timedFetch(url: string, opts?: RequestInit, timeoutMs = 5000): Promise<{ resp: Response; ms: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const resp = await fetch(url, { ...opts, signal: controller.signal });
    return { resp, ms: performance.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

function makeAuthCookie(username = 'root'): string {
  const hmac = createHmac('sha256', PASSWORD).update(username).digest('hex');
  return `auth=${username}:${hmac}`;
}

// ─── Individual checks ────────────────────────────────────────────────

async function checkUIHealth(): Promise<CheckResult> {
  const name = 'UI Service';
  try {
    const { resp, ms } = await timedFetch(`${UI_BASE}/health`);
    const body = await resp.json() as any;
    if (resp.ok && body.status === 'ok') {
      return { name, status: 'PASS', ms };
    }
    return { name, status: 'FAIL', ms, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { name, status: 'FAIL', ms: 0, detail: e.cause?.code || e.message };
  }
}

async function checkPTYHealth(): Promise<CheckResult> {
  const name = 'PTY Service';
  try {
    const { resp, ms } = await timedFetch(`${PTY_BASE}/health`);
    const body = await resp.json() as any;
    if (resp.ok && body.status === 'ok') {
      return { name, status: 'PASS', ms };
    }
    return { name, status: 'FAIL', ms, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { name, status: 'FAIL', ms: 0, detail: e.cause?.code || e.message };
  }
}

async function checkUIToPTY(): Promise<CheckResult> {
  const name = 'UI→PTY Connectivity';
  try {
    const { resp, ms } = await timedFetch(`${PTY_BASE}/sessions`, {
      headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
    });
    if (resp.ok) {
      const sessions = await resp.json() as any[];
      return { name, status: 'PASS', ms, detail: `${sessions.length} session(s)` };
    }
    return { name, status: 'FAIL', ms, detail: `HTTP ${resp.status}` };
  } catch (e: any) {
    return { name, status: 'FAIL', ms: 0, detail: e.cause?.code || e.message };
  }
}

async function checkSessionCRUD(): Promise<CheckResult> {
  const name = 'Session CRUD';
  const diagId = `__diag_${Date.now()}`;
  const t0 = performance.now();
  try {
    // Create
    const createResp = await fetch(`${PTY_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN,
      },
      body: JSON.stringify({ id: diagId, owner: 'admin' }),
    });
    if (!createResp.ok) {
      return { name, status: 'FAIL', ms: performance.now() - t0, detail: `Create failed: ${createResp.status}` };
    }

    // Verify exists
    const listResp = await fetch(`${PTY_BASE}/sessions`, {
      headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
    });
    const list = await listResp.json() as any[];
    const found = list.some((s: any) => s.id === diagId);

    // Delete
    await fetch(`${PTY_BASE}/sessions/${encodeURIComponent(diagId)}`, {
      method: 'DELETE',
      headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
    });

    const ms = performance.now() - t0;
    if (found) {
      return { name, status: 'PASS', ms, detail: 'create→list→delete OK' };
    }
    return { name, status: 'FAIL', ms, detail: 'Session not found after create' };
  } catch (e: any) {
    // Try cleanup
    try {
      await fetch(`${PTY_BASE}/sessions/${encodeURIComponent(diagId)}`, {
        method: 'DELETE',
        headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
      });
    } catch {}
    return { name, status: 'FAIL', ms: performance.now() - t0, detail: e.cause?.code || e.message };
  }
}

async function checkTerminalWS(): Promise<CheckResult> {
  const name = 'Terminal WS Loopback';
  const diagId = `__diag_ws_${Date.now()}`;
  const MARKER = `__HOPCODE_DIAG_${Date.now()}__`;
  const t0 = performance.now();

  try {
    // Create a temp session
    const createResp = await fetch(`${PTY_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN,
      },
      body: JSON.stringify({ id: diagId, owner: 'admin' }),
    });
    if (!createResp.ok) {
      return { name, status: 'FAIL', ms: performance.now() - t0, detail: `Session create failed: ${createResp.status}` };
    }

    // Connect WS
    const result = await new Promise<CheckResult>((resolve) => {
      const wsTimeout = setTimeout(() => {
        ws.close();
        resolve({ name, status: 'FAIL', ms: performance.now() - t0, detail: 'WS timeout (5s)' });
      }, 5000);

      const ws = new WebSocket(
        `ws://127.0.0.1:${PTY_PORT}/ws/${encodeURIComponent(diagId)}`,
        { headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN } }
      );

      let sentCommand = false;
      let received = '';

      ws.on('open', () => {
        // Wait a bit for shell prompt, then send echo command
        setTimeout(() => {
          const cmd = JSON.stringify({ type: 'input', data: `echo ${MARKER}\n` });
          ws.send(cmd);
          sentCommand = true;
        }, 300);
      });

      ws.on('message', (data: Buffer | string) => {
        const msg = data.toString();
        received += msg;
        if (sentCommand && received.includes(MARKER)) {
          clearTimeout(wsTimeout);
          ws.close();
          resolve({ name, status: 'PASS', ms: performance.now() - t0, detail: 'echo loopback OK' });
        }
      });

      ws.on('error', (err: any) => {
        clearTimeout(wsTimeout);
        resolve({ name, status: 'FAIL', ms: performance.now() - t0, detail: err.message });
      });
    });

    // Cleanup
    await fetch(`${PTY_BASE}/sessions/${encodeURIComponent(diagId)}`, {
      method: 'DELETE',
      headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
    });

    return result;
  } catch (e: any) {
    try {
      await fetch(`${PTY_BASE}/sessions/${encodeURIComponent(diagId)}`, {
        method: 'DELETE',
        headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
      });
    } catch {}
    return { name, status: 'FAIL', ms: performance.now() - t0, detail: e.cause?.code || e.message };
  }
}

async function checkWSLatency(): Promise<CheckResult> {
  const name = 'WS Keystroke Latency';
  const diagId = `__diag_lat_${Date.now()}`;
  const ROUNDS = 5;
  const t0 = performance.now();

  try {
    // Create temp session
    const createResp = await fetch(`${PTY_BASE}/sessions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN,
      },
      body: JSON.stringify({ id: diagId, owner: 'admin' }),
    });
    if (!createResp.ok) {
      return { name, status: 'FAIL', ms: performance.now() - t0, detail: `Session create failed: ${createResp.status}` };
    }

    const result = await new Promise<CheckResult>((resolve) => {
      const wsTimeout = setTimeout(() => {
        ws.close();
        resolve({ name, status: 'FAIL', ms: performance.now() - t0, detail: 'WS timeout (8s)' });
      }, 8000);

      const ws = new WebSocket(
        `ws://127.0.0.1:${PTY_PORT}/ws/${encodeURIComponent(diagId)}`,
        { headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN } }
      );

      let phase: 'wait_ready' | 'measuring' | 'done' = 'wait_ready';
      let received = '';
      let roundIdx = 0;
      let roundStart = 0;
      const latencies: number[] = [];

      function marker(i: number) { return `__LAT_${diagId}_${i}__`; }

      function sendRound() {
        if (roundIdx >= ROUNDS) {
          phase = 'done';
          clearTimeout(wsTimeout);
          ws.close();
          latencies.sort((a, b) => a - b);
          const min = latencies[0];
          const max = latencies[latencies.length - 1];
          const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length;
          const status = avg > 50 ? 'WARN' : 'PASS';
          resolve({
            name, status,
            ms: avg,
            detail: `${ROUNDS}x echo: min=${min.toFixed(1)} avg=${avg.toFixed(1)} max=${max.toFixed(1)}ms`,
          });
          return;
        }
        received = '';
        roundStart = performance.now();
        ws.send(JSON.stringify({ type: 'input', data: `echo ${marker(roundIdx)}\n` }));
      }

      ws.on('open', () => {
        // Wait for shell prompt to be ready, then start measuring
        setTimeout(() => {
          phase = 'measuring';
          sendRound();
        }, 500);
      });

      ws.on('message', (data: Buffer | string) => {
        if (phase !== 'measuring') return;
        received += data.toString();
        if (received.includes(marker(roundIdx))) {
          latencies.push(performance.now() - roundStart);
          roundIdx++;
          // Small gap between rounds to let shell settle
          setTimeout(sendRound, 20);
        }
      });

      ws.on('error', (err: any) => {
        clearTimeout(wsTimeout);
        resolve({ name, status: 'FAIL', ms: performance.now() - t0, detail: err.message });
      });
    });

    // Cleanup
    await fetch(`${PTY_BASE}/sessions/${encodeURIComponent(diagId)}`, {
      method: 'DELETE',
      headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
    });

    return result;
  } catch (e: any) {
    try {
      await fetch(`${PTY_BASE}/sessions/${encodeURIComponent(diagId)}`, {
        method: 'DELETE',
        headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_TOKEN },
      });
    } catch {}
    return { name, status: 'FAIL', ms: performance.now() - t0, detail: e.cause?.code || e.message };
  }
}

async function checkPageLoad(): Promise<CheckResult> {
  const name = 'Page Load';
  const cookie = makeAuthCookie();
  try {
    // Test login page (no auth needed)
    const { resp: loginResp, ms: loginMs } = await timedFetch(`${UI_BASE}/login`);
    const loginSize = (await loginResp.text()).length;

    // Test terminal page (needs auth)
    const { resp: termResp, ms: termMs } = await timedFetch(`${UI_BASE}/terminal`, {
      headers: { Cookie: cookie },
      redirect: 'follow',
    });
    const termSize = (await termResp.text()).length;

    const totalMs = loginMs + termMs;
    return {
      name,
      status: totalMs > 2000 ? 'WARN' : 'PASS',
      ms: totalMs,
      detail: `login: ${Math.round(loginMs)}ms/${(loginSize / 1024).toFixed(1)}KB, terminal: ${Math.round(termMs)}ms/${(termSize / 1024).toFixed(1)}KB`,
    };
  } catch (e: any) {
    return { name, status: 'FAIL', ms: 0, detail: e.cause?.code || e.message };
  }
}

async function checkAuth(): Promise<CheckResult> {
  const name = 'Auth Verify';
  const t0 = performance.now();
  try {
    // Try root first (multi-user), fallback to admin (single-user)
    for (const user of ['root', 'admin']) {
      const cookie = makeAuthCookie(user);
      const { resp } = await timedFetch(`${UI_BASE}/terminal`, {
        headers: { Cookie: cookie },
        redirect: 'manual',
      });
      if (resp.status === 200) {
        return { name, status: 'PASS', ms: performance.now() - t0, detail: `HMAC token valid (user: ${user})` };
      }
    }
    return { name, status: 'FAIL', ms: performance.now() - t0, detail: 'Redirected to login — token rejected' };
  } catch (e: any) {
    return { name, status: 'FAIL', ms: performance.now() - t0, detail: e.cause?.code || e.message };
  }
}

async function checkMemory(): Promise<CheckResult> {
  const name = 'Memory Usage';
  const t0 = performance.now();
  try {
    // Try pm2 jlist first
    const pm2Out = execSync('pm2 jlist 2>/dev/null', { timeout: 3000 }).toString();
    const procs = JSON.parse(pm2Out) as any[];
    const ms = performance.now() - t0;
    const details: string[] = [];
    for (const p of procs) {
      const mem = p.monit?.memory;
      if (mem) {
        details.push(`${p.name}: ${(mem / 1024 / 1024).toFixed(1)}MB`);
      }
    }
    const totalMB = procs.reduce((s: number, p: any) => s + (p.monit?.memory || 0), 0) / 1024 / 1024;
    return {
      name,
      status: totalMB > 512 ? 'WARN' : 'PASS',
      ms,
      detail: details.join(', ') || `total: ${totalMB.toFixed(1)}MB`,
    };
  } catch {
    // Fallback: own process memory
    const mem = process.memoryUsage();
    const rss = mem.rss / 1024 / 1024;
    const heap = mem.heapUsed / 1024 / 1024;
    return {
      name,
      status: rss > 256 ? 'WARN' : 'PASS',
      ms: performance.now() - t0,
      detail: `diag process RSS: ${rss.toFixed(1)}MB, heap: ${heap.toFixed(1)}MB`,
    };
  }
}

async function checkEventLoop(): Promise<CheckResult> {
  const name = 'Event Loop Lag';
  const t0 = performance.now();
  const lag = await new Promise<number>((resolve) => {
    const start = performance.now();
    setTimeout(() => resolve(performance.now() - start), 0);
  });
  return {
    name,
    status: lag > 50 ? 'WARN' : 'PASS',
    ms: performance.now() - t0,
    detail: `${lag.toFixed(1)}ms lag`,
  };
}

async function checkDisk(): Promise<CheckResult> {
  const name = 'Disk Space';
  const t0 = performance.now();
  try {
    const dfOut = execSync("df -BM / | tail -1", { timeout: 3000 }).toString().trim();
    const parts = dfOut.split(/\s+/);
    // typical: /dev/sda1 100000M 60000M 40000M 60% /
    const availMB = parseInt(parts[3]) || 0;
    const usePct = parseInt(parts[4]) || 0;
    const ms = performance.now() - t0;
    return {
      name,
      status: usePct > 90 ? 'WARN' : 'PASS',
      ms,
      detail: `${availMB}MB available, ${usePct}% used`,
    };
  } catch (e: any) {
    return { name, status: 'WARN', ms: performance.now() - t0, detail: e.message };
  }
}

// ─── Runner ────────────────────────────────────────────────────────────

export async function runDiagnose(): Promise<DiagnoseReport> {
  const checks: CheckResult[] = [];

  // Run independent checks in parallel groups
  // Group 1: basic health (fast, independent)
  const [ui, pty] = await Promise.all([checkUIHealth(), checkPTYHealth()]);
  checks.push(ui, pty);

  // Group 2: depends on services being up
  const [uiPty, auth, pageLoad, memory, eventLoop, disk] = await Promise.all([
    checkUIToPTY(),
    checkAuth(),
    checkPageLoad(),
    checkMemory(),
    checkEventLoop(),
    checkDisk(),
  ]);
  checks.push(uiPty, auth, pageLoad, memory, eventLoop, disk);

  // Group 3: session CRUD (creates resources, run separately)
  checks.push(await checkSessionCRUD());

  // Group 4: WS loopback (slowest, depends on session create)
  checks.push(await checkTerminalWS());

  // Group 5: precise WS latency (multiple echo round-trips)
  checks.push(await checkWSLatency());

  const passed = checks.filter((c) => c.status === 'PASS').length;
  const failed = checks.filter((c) => c.status === 'FAIL').length;
  const warned = checks.filter((c) => c.status === 'WARN').length;

  return {
    timestamp: new Date().toISOString(),
    checks,
    summary: { total: checks.length, passed, failed, warned },
  };
}

// ─── CLI output ────────────────────────────────────────────────────────

function formatCLI(report: DiagnoseReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push('\x1b[1m🔍 Hopcode Self-Diagnose\x1b[0m');
  lines.push('========================');

  for (const c of report.checks) {
    const icon =
      c.status === 'PASS' ? '\x1b[32m[PASS]\x1b[0m' :
      c.status === 'WARN' ? '\x1b[33m[WARN]\x1b[0m' :
      '\x1b[31m[FAIL]\x1b[0m';
    const dots = '.'.repeat(Math.max(1, 28 - c.name.length));
    const msStr = `${Math.round(c.ms)}ms`;
    const detail = c.detail ? ` (${c.detail})` : '';
    lines.push(`${icon} ${c.name} ${dots} ${msStr}${detail}`);
  }

  lines.push('========================');
  const { total, passed, failed, warned } = report.summary;
  const counts: string[] = [];
  if (passed) counts.push(`\x1b[32m${passed} passed\x1b[0m`);
  if (warned) counts.push(`\x1b[33m${warned} warned\x1b[0m`);
  if (failed) counts.push(`\x1b[31m${failed} failed\x1b[0m`);
  lines.push(`${total} checks: ${counts.join(', ')}`);
  lines.push('');

  return lines.join('\n');
}

// ─── CLI entrypoint ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const jsonMode = args.includes('--json');
  const watchIdx = args.indexOf('--watch');
  const watchInterval = watchIdx >= 0 ? parseInt(args[watchIdx + 1]) || 10 : 0;

  const run = async () => {
    const report = await runDiagnose();
    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      process.stdout.write(formatCLI(report));
    }
    return report;
  };

  if (watchInterval > 0) {
    console.log(`Watching every ${watchInterval}s (Ctrl+C to stop)\n`);
    while (true) {
      await run();
      await new Promise((r) => setTimeout(r, watchInterval * 1000));
    }
  } else {
    const report = await run();
    process.exit(report.summary.failed > 0 ? 1 : 0);
  }
}

// Run if executed directly (not imported)
const isMain = process.argv[1]?.endsWith('diagnose.ts') || process.argv[1]?.endsWith('diagnose.js');
if (isMain) {
  main().catch((err) => {
    console.error('Diagnose fatal error:', err);
    process.exit(2);
  });
}

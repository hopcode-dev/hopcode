/**
 * PTY Service — main process that manages worker processes
 * Each session runs in an isolated worker process
 * Worker exit = automatic memory cleanup
 */

process.on('SIGPIPE', () => {});
process.on('uncaughtException', (err) => {
  if ((err as any)?.code === 'EPIPE') return;
  try { console.error('[pty-service] Uncaught exception:', err.message); } catch {}
});
process.on('unhandledRejection', (err: any) => {
  if (err?.code === 'EPIPE') return;
  try { console.error('[pty-service] Unhandled rejection:', err?.message || err); } catch {}
});

import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { fork, ChildProcess } from 'child_process';
import * as path from 'path';
import { fileURLToPath } from 'url';

import {
  PTY_SERVICE_PORT,
  PTY_INTERNAL_TOKEN_HEADER,
  getPtyInternalToken,
  type SessionInfo,
} from './shared/protocol.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL_TOKEN = getPtyInternalToken();

// --- Session (Worker) Management ---

interface Session {
  worker: ChildProcess;
  clients: Set<WebSocket>;
  name: string;
  owner: string;
  linuxUser: string;
  projectDir: string;
  createdAt: number;
  lastActivity: number;
  ready: boolean;
  pendingScrollback: ((data: string) => void)[];
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;

function createSession(id: string, owner: string = 'admin', linuxUser?: string, customName?: string, cwd?: string, projectDir?: string): Session {
  sessionCounter++;
  const name = customName || `Session ${sessionCounter}`;

  // Fork worker process
  const worker = fork(path.join(__dirname, 'pty-worker.ts'), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
  });

  const session: Session = {
    worker,
    clients: new Set(),
    name,
    owner,
    linuxUser: linuxUser || '',
    projectDir: projectDir || cwd || '',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ready: false,
    pendingScrollback: [],
  };

  // Handle messages from worker
  worker.on('message', (msg: any) => {
    switch (msg.type) {
      case 'ready':
        session.ready = true;
        session.name = msg.name || session.name;
        console.log(`[pty-service] Worker ready: ${id} - ${session.name}`);
        break;

      case 'output':
        // Broadcast to all connected clients
        const outputMsg = JSON.stringify({ type: 'output', data: msg.data });
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(outputMsg);
          }
        }
        break;

      case 'scrollback':
        // Send to pending scrollback requests
        for (const cb of session.pendingScrollback) {
          cb(msg.data);
        }
        session.pendingScrollback = [];
        break;

      case 'exit':
        console.log(`[pty-service] Worker exited: ${id} (code ${msg.code})`);
        // Notify all clients
        const exitMsg = JSON.stringify({ type: 'session_exit' });
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(exitMsg);
          }
          client.close();
        }
        sessions.delete(id);
        break;
    }
  });

  worker.on('error', (err) => {
    console.error(`[pty-service] Worker error: ${id}`, err.message);
  });

  worker.on('exit', (code) => {
    console.log(`[pty-service] Worker process exited: ${id} (code ${code})`);
    // Clean up if not already done
    if (sessions.has(id)) {
      for (const client of session.clients) {
        try {
          client.send(JSON.stringify({ type: 'session_exit' }));
          client.close();
        } catch {}
      }
      sessions.delete(id);
    }
  });

  // Send init message to worker
  worker.send({
    type: 'init',
    sessionId: id,
    owner,
    linuxUser,
    name,
    cwd,
  });

  sessions.set(id, session);
  console.log(`[pty-service] Created session: ${id} - ${name} (worker PID: ${worker.pid})`);

  return session;
}

function getSession(id: string): Session | undefined {
  return sessions.get(id);
}

// --- Internal token auth check ---

function checkToken(req: http.IncomingMessage): boolean {
  return req.headers[PTY_INTERNAL_TOKEN_HEADER] === INTERNAL_TOKEN;
}

// --- HTTP API ---

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // Health check (no auth needed)
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  // All other routes require internal token
  if (!checkToken(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // GET /sessions — list sessions
  if (pathname === '/sessions' && req.method === 'GET') {
    const ownerFilter = parsedUrl.searchParams.get('owner');
    let entries = Array.from(sessions.entries());
    if (ownerFilter) {
      entries = entries.filter(([, s]) => s.owner === ownerFilter);
    }
    const list: SessionInfo[] = entries.map(([id, s]) => ({
      id,
      name: s.name,
      owner: s.owner,
      projectDir: s.projectDir || undefined,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
      clientCount: s.clients.size,
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /sessions — create new session
  if (pathname === '/sessions' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const id = body.id;
        if (!id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id required' }));
          return;
        }
        const owner = body.owner || 'admin';
        const linuxUser = body.linuxUser || undefined;
        const session = createSession(id, owner, linuxUser, body.name, body.cwd, body.projectDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch (err: any) {
        console.error(`[pty-service] POST /sessions error:`, err.message || err);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    req.resume();
    return;
  }

  // POST /sessions/:id/rename
  const renameMatch = pathname.match(/^\/sessions\/([^/]+)\/rename$/);
  if (renameMatch && req.method === 'POST') {
    const sid = decodeURIComponent(renameMatch[1]!);
    const session = sessions.get(sid);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const { name } = JSON.parse(Buffer.concat(chunks).toString());
        const trimmed = (name || '').trim().substring(0, 100);
        if (!trimmed) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Name cannot be empty' }));
          return;
        }
        session.name = trimmed;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bad request' }));
      }
    });
    req.resume();
    return;
  }

  // GET /sessions/:id/cwd — get current working directory
  const cwdMatch = pathname.match(/^\/sessions\/([^/]+)\/cwd$/);
  if (cwdMatch && req.method === 'GET') {
    const sid = decodeURIComponent(cwdMatch[1]!);
    const session = sessions.get(sid);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    // CWD lookup is now done by reading /proc - we need worker PID
    try {
      const pid = session.worker.pid;
      if (pid) {
        const { promises: fs } = await import('fs');
        const cwd = await fs.readlink(`/proc/${pid}/cwd`).catch(() => process.env.HOME || '/');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cwd }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ cwd: process.env.HOME || '/' }));
      }
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cwd: process.env.HOME || '/' }));
    }
    return;
  }

  // DELETE /sessions/:id — kill session
  const deleteMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const sid = decodeURIComponent(deleteMatch[1]!);
    const session = sessions.get(sid);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    // Send shutdown to worker
    session.worker.send({ type: 'shutdown' });
    // Force kill after timeout
    setTimeout(() => {
      if (sessions.has(sid)) {
        session.worker.kill('SIGKILL');
        for (const client of session.clients) {
          try { client.close(); } catch {}
        }
        sessions.delete(sid);
      }
    }, 1000);
    console.log(`[pty-service] Session deleted: ${sid}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- WebSocket /ws/:sessionId ---

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const pathParts = url.pathname.split('/');
  const sessionId = decodeURIComponent(pathParts[2] || 'default');

  const session = getSession(sessionId);
  if (!session) {
    console.log(`[pty-service] Rejected WS: session ${sessionId} not found`);
    ws.close(4004, 'Session not found');
    return;
  }

  // Verify owner if provided
  const ownerParam = url.searchParams.get('owner');
  if (ownerParam && session.owner !== ownerParam) {
    console.log(`[pty-service] Rejected WS: owner mismatch for ${sessionId}`);
    ws.close(4003, 'Forbidden');
    return;
  }

  session.clients.add(ws);
  console.log(`[pty-service] Client connected: ${sessionId} (${session.clients.size} clients)`);

  // Send session info
  ws.send(JSON.stringify({ type: 'session_info', name: session.name }));

  // Request scrollback from worker (with timeout to prevent callback accumulation)
  const scrollbackCallback = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'scrollback', data }));
    }
  };
  session.pendingScrollback.push(scrollbackCallback);
  session.worker.send({ type: 'getScrollback' });

  // Timeout: remove callback if worker doesn't respond in 5s
  setTimeout(() => {
    const idx = session.pendingScrollback.indexOf(scrollbackCallback);
    if (idx !== -1) {
      session.pendingScrollback.splice(idx, 1);
    }
  }, 5000);

  ws.on('message', (message) => {
    // Check session still exists (may have been deleted if worker crashed)
    if (!sessions.has(sessionId)) {
      ws.close(4004, 'Session no longer exists');
      return;
    }
    try {
      const msg = JSON.parse(message.toString());
      session.lastActivity = Date.now();

      if (msg.type === 'input') {
        session.worker.send({ type: 'input', data: msg.data });
      } else if (msg.type === 'resize') {
        if (msg.cols > 0 && msg.rows > 0) {
          session.worker.send({ type: 'resize', cols: msg.cols, rows: msg.rows });
        }
      } else if (msg.type === 'asr') {
        console.log(`[pty-service] ASR input: "${msg.text}"`);
        session.worker.send({ type: 'input', data: msg.text + '\r' });
      }
    } catch (e) {
      console.error('[pty-service] Parse error:', e);
    }
  });

  ws.on('close', () => {
    // Check session still exists before cleanup
    if (sessions.has(sessionId)) {
      session.clients.delete(ws);
      console.log(`[pty-service] Client disconnected: ${sessionId} (${session.clients.size} clients)`);
    }
  });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  if (!checkToken(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (url.pathname.startsWith('/ws/')) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// --- Recording cleanup ---

const RECORDING_RETENTION_DAYS = parseInt(process.env.RECORDING_RETENTION_DAYS || '30');
const RECORDINGS_DIR = path.join(process.cwd(), 'data', 'recordings');

async function cleanOldRecordings() {
  try {
    const files = await fs.promises.readdir(RECORDINGS_DIR);
    const now = Date.now();
    const maxAge = RECORDING_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    let deleted = 0;
    for (const file of files) {
      if (!file.endsWith('.cast')) continue;
      const filePath = path.join(RECORDINGS_DIR, file);
      try {
        const stat = await fs.promises.stat(filePath);
        if (now - stat.mtimeMs > maxAge) {
          await fs.promises.unlink(filePath);
          deleted++;
        }
      } catch {}
    }
    if (deleted > 0) {
      console.log(`[pty-service] Cleaned ${deleted} old recording(s)`);
    }
  } catch {}
}

// Run cleanup every 6 hours
setInterval(cleanOldRecordings, 6 * 60 * 60 * 1000);
// Run once at startup
cleanOldRecordings();

// --- Start ---

server.listen(PTY_SERVICE_PORT, '127.0.0.1', () => {
  console.log(`[pty-service] Listening on 127.0.0.1:${PTY_SERVICE_PORT}`);
  console.log(`[pty-service] Worker isolation mode: each session runs in isolated process`);
  console.log(`[pty-service] Ready`);
});

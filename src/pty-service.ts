/**
 * PTY Service — manages worker processes
 * Session state lives in shared/pty-session.ts (can be hot-reloaded)
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
import {
  sessions,
  persistedSessions,
  SESSION_REGISTRY_FILE,
  getSession,
  saveSessionRegistry,
  loadSessionRegistry,
} from './shared/pty-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INTERNAL_TOKEN = getPtyInternalToken();

// --- Worker Management (stays in pty-service, not hot-reloaded) ---

interface WorkerHandle {
  pid: number;
  process: ChildProcess;
}

const workers = new Map<string, WorkerHandle>();

function forkWorker(sessionId: string): ChildProcess {
  return fork(path.join(__dirname, 'pty-worker.ts'), [], {
    execArgv: ['--import', 'tsx'],
    stdio: ['pipe', 'inherit', 'inherit', 'ipc'],
  });
}

function setupWorker(sessionId: string, worker: ChildProcess, owner: string, linuxUser?: string, name?: string, cwd?: string) {
  worker.on('message', (msg: any) => {
    const session = getSession(sessionId);
    if (!session) return;

    switch (msg.type) {
      case 'ready':
        session.ready = true;
        if (msg.name) session.name = msg.name;
        console.log(`[pty-service] Worker ready: ${sessionId} - ${session.name}`);
        break;

      case 'output': {
        const outMsg = JSON.stringify({ type: 'output', data: msg.data });
        for (const client of session.clients) {
          if (client.readyState === WebSocket.OPEN) client.send(outMsg);
        }
        break;
      }

      case 'scrollback':
        for (const cb of session.pendingScrollback) cb(msg.data);
        session.pendingScrollback = [];
        break;

      case 'exit':
        console.log(`[pty-service] Worker exited: ${sessionId} (code ${msg.code})`);
        for (const client of session.clients) {
          try { client.send(JSON.stringify({ type: 'session_exit' })); client.close(); } catch {}
        }
        sessions.delete(sessionId);
        persistedSessions.delete(sessionId);
        workers.delete(sessionId);
        saveSessionRegistry();
        break;
    }
  });

  worker.on('error', (err) => {
    console.error(`[pty-service] Worker error: ${sessionId}`, err.message);
  });

  worker.on('exit', (code) => {
    console.log(`[pty-service] Worker process exited: ${sessionId} (code ${code})`);
    const session = getSession(sessionId);
    if (session) {
      for (const client of session.clients) {
        try { client.send(JSON.stringify({ type: 'session_exit' })); client.close(); } catch {}
      }
      sessions.delete(sessionId);
      persistedSessions.delete(sessionId);
      workers.delete(sessionId);
      saveSessionRegistry();
    }
  });

  worker.send({ type: 'init', sessionId, owner, linuxUser, name, cwd });
}

// --- Create / Delete Session ---

function createSession(id: string, owner: string = 'admin', linuxUser?: string, customName?: string, cwd?: string, projectDir?: string) {
  const name = customName || `Session ${id.slice(-6)}`;
  const worker = forkWorker(id);
  const pid = worker.pid!;

  workers.set(id, { pid, process: worker });

  const session = {
    workerPid: pid,
    clients: new Set<WebSocket>(),
    name,
    owner,
    linuxUser: linuxUser || '',
    projectDir: projectDir || cwd || '',
    createdAt: Date.now(),
    lastActivity: Date.now(),
    ready: false,
    pendingScrollback: [] as ((data: string) => void)[],
  };

  setupWorker(id, worker, owner, linuxUser, name, cwd);
  sessions.set(id, session);
  console.log(`[pty-service] Created session: ${id} - ${name} (worker PID: ${pid})`);
  saveSessionRegistry();
  return session;
}

function killSession(sid: string) {
  const wh = workers.get(sid);
  if (wh) {
    wh.process.send!({ type: 'shutdown' } as any);
    setTimeout(() => {
      try { wh.process.kill('SIGKILL'); } catch {}
    }, 1000);
    workers.delete(sid);
  }
  sessions.delete(sid);
  persistedSessions.delete(sid);
  saveSessionRegistry();
}

// --- Internal token auth ---

function checkToken(req: http.IncomingMessage): boolean {
  return req.headers[PTY_INTERNAL_TOKEN_HEADER] === INTERNAL_TOKEN;
}

// --- HTTP API ---

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', sessions: sessions.size }));
    return;
  }

  if (!checkToken(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  // GET /sessions
  if (pathname === '/sessions' && req.method === 'GET') {
    const ownerFilter = parsedUrl.searchParams.get('owner');
    const ownerSet = ownerFilter ? new Set([ownerFilter]) : null;
    const list: SessionInfo[] = [];

    for (const [id, s] of sessions.entries()) {
      if (ownerSet && !ownerSet.has(s.owner)) continue;
      list.push({
        id,
        name: s.name,
        owner: s.owner,
        projectDir: s.projectDir || undefined,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
        clientCount: s.clients.size,
        active: true,
      });
    }

    for (const [id, ps] of persistedSessions.entries()) {
      if (sessions.has(id)) continue;
      if (ownerSet && !ownerSet.has(ps.owner)) continue;
      list.push({
        id: ps.id,
        name: ps.name,
        owner: ps.owner,
        projectDir: ps.projectDir || undefined,
        createdAt: ps.createdAt,
        lastActivity: ps.lastActivity,
        clientCount: 0,
        active: false,
      });
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(list));
    return;
  }

  // POST /sessions
  if (pathname === '/sessions' && req.method === 'POST') {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        if (!body.id) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id required' }));
          return;
        }
        createSession(body.id, body.owner || 'admin', body.linuxUser, body.name, body.cwd, body.projectDir);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: body.id }));
      } catch (e: any) {
        console.error('[pty-service] POST /sessions error:', e.message);
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
    const session = getSession(sid);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const { name } = JSON.parse(Buffer.concat(chunks).toString());
        session.name = (name || '').trim().slice(0, 100) || session.name;
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

  // GET /sessions/:id/cwd
  const cwdMatch = pathname.match(/^\/sessions\/([^/]+)\/cwd$/);
  if (cwdMatch && req.method === 'GET') {
    const sid = decodeURIComponent(cwdMatch[1]!);
    const session = getSession(sid);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const wh = workers.get(sid);
    try {
      const cwd = wh?.pid
        ? await fs.promises.readlink(`/proc/${wh.pid}/cwd`).catch(() => process.env.HOME || '/')
        : process.env.HOME || '/';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cwd }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ cwd: process.env.HOME || '/' }));
    }
    return;
  }

  // DELETE /sessions/:id
  const deleteMatch = pathname.match(/^\/sessions\/([^/]+)$/);
  if (deleteMatch && req.method === 'DELETE') {
    const sid = decodeURIComponent(deleteMatch[1]!);
    const isActive = sessions.has(sid);
    const isStale = persistedSessions.has(sid);
    if (!isActive && !isStale) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    if (isActive) killSession(sid);
    else { persistedSessions.delete(sid); saveSessionRegistry(); }
    console.log(`[pty-service] Session deleted: ${sid} (stale=${!isActive})`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// --- WebSocket /ws/:sessionId ---

const wss = new WebSocketServer({ noServer: true });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = decodeURIComponent(url.pathname.split('/')[2] || 'default');
  const session = getSession(sessionId);

  if (!session) {
    ws.close(4004, 'Session not found');
    return;
  }

  const ownerParam = url.searchParams.get('owner');
  if (ownerParam && session.owner !== ownerParam) {
    ws.close(4003, 'Forbidden');
    return;
  }

  session.clients.add(ws);
  console.log(`[pty-service] Client connected: ${sessionId} (${session.clients.size} clients)`);
  ws.send(JSON.stringify({ type: 'session_info', name: session.name }));

  const scrollbackCb = (data: string) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'scrollback', data }));
  };
  session.pendingScrollback.push(scrollbackCb);
  const wh = workers.get(sessionId);
  if (wh) wh.process.send!({ type: 'getScrollback' } as any);
  setTimeout(() => {
    const idx = session.pendingScrollback.indexOf(scrollbackCb);
    if (idx !== -1) session.pendingScrollback.splice(idx, 1);
  }, 5000);

  ws.on('message', (message) => {
    if (!sessions.has(sessionId)) { ws.close(4004); return; }
    try {
      const msg = JSON.parse(message.toString());
      session.lastActivity = Date.now();
      const wh = workers.get(sessionId);
      if (!wh) { ws.close(4004); return; }
      if (msg.type === 'input') {
        wh.process.send!({ type: 'input', data: msg.data } as any);
      } else if (msg.type === 'resize') {
        if (msg.cols > 0 && msg.rows > 0) wh.process.send!({ type: 'resize', cols: msg.cols, rows: msg.rows } as any);
      } else if (msg.type === 'asr') {
        wh.process.send!({ type: 'input', data: msg.text + '\r' } as any);
      }
    } catch (e) {
      console.error('[pty-service] Parse error:', e);
    }
  });

  ws.on('close', () => {
    if (sessions.has(sessionId)) {
      session.clients.delete(ws);
      console.log(`[pty-service] Client disconnected: ${sessionId} (${session.clients.size} clients)`);
    }
  });
});

server.on('upgrade', (request, socket, head) => {
  if (!checkToken(request)) { socket.write('HTTP/1.1 401\r\n\r\n'); socket.destroy(); return; }
  const url = new URL(request.url!, `http://${request.headers.host}`);
  if (url.pathname.startsWith('/ws/')) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
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
        if (now - stat.mtimeMs > maxAge) { await fs.promises.unlink(filePath); deleted++; }
      } catch {}
    }
    if (deleted > 0) console.log(`[pty-service] Cleaned ${deleted} old recording(s)`);
  } catch {}
}

setInterval(cleanOldRecordings, 6 * 60 * 60 * 1000);
cleanOldRecordings();
loadSessionRegistry();

server.listen(PTY_SERVICE_PORT, '127.0.0.1', () => {
  console.log(`[pty-service] Listening on 127.0.0.1:${PTY_SERVICE_PORT}`);
  console.log(`[pty-service] Ready`);
});

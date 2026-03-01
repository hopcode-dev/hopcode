/**
 * PTY Service — standalone daemon that manages terminal sessions
 * Runs on localhost:3001, internal token auth
 * UI service proxies browser connections to this service
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
import * as pty from 'node-pty';
import { WebSocketServer, WebSocket } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import xtermHeadless from '@xterm/headless';
const HeadlessTerminal = xtermHeadless.Terminal;
import { SerializeAddon } from '@xterm/addon-serialize';

import {
  PTY_SERVICE_PORT,
  PTY_INTERNAL_TOKEN_HEADER,
  getPtyInternalToken,
  type SessionInfo,
} from './shared/protocol.js';

const INTERNAL_TOKEN = getPtyInternalToken();

// --- PTY Session management (extracted from server-node.ts) ---

interface Session {
  pty: pty.IPty;
  clients: Set<WebSocket>;  // internal WS connections from UI service
  headlessTerm: InstanceType<typeof HeadlessTerminal>;
  serializeAddon: InstanceType<typeof SerializeAddon>;
  name: string;
  createdAt: number;
}

const sessions = new Map<string, Session>();
let sessionCounter = 0;

async function getSessionCwd(session: Session): Promise<string> {
  try {
    return await fs.promises.readlink('/proc/' + session.pty.pid + '/cwd');
  } catch {
    return process.env.HOME || '/';
  }
}

function createSession(id: string): Session {
  const ptyProcess = pty.spawn('/bin/bash', ['--login', '-i'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: process.env.HOME || '/',
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')
      ) as { [key: string]: string },
      TERM: 'xterm-256color',
      SHELL: '/bin/bash',
      PS1: '\\[\\033[32m\\]\\u\\[\\033[0m\\]:\\[\\033[34m\\]\\W\\[\\033[0m\\]\\$ ',
    },
  });

  sessionCounter++;

  const headlessTerm = new HeadlessTerminal({ cols: 120, rows: 30, scrollback: 500, allowProposedApi: true });
  const serializeAddon = new SerializeAddon();
  headlessTerm.loadAddon(serializeAddon);

  const session: Session = {
    pty: ptyProcess,
    clients: new Set(),
    headlessTerm,
    serializeAddon,
    name: `Session ${sessionCounter}`,
    createdAt: Date.now(),
  };

  console.log(`[pty-service] Created session: ${id} - ${session.name}`);

  // Broadcast PTY output to all connected internal WS clients
  ptyProcess.onData((data) => {
    session.headlessTerm.write(data);
    const message = JSON.stringify({ type: 'output', data });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    }
  });

  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[pty-service] PTY exited: ${id} (code ${exitCode})`);
    // Notify all clients
    const exitMsg = JSON.stringify({ type: 'session_exit' });
    for (const client of session.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(exitMsg);
      }
      client.close();
    }
    session.headlessTerm.dispose();
    sessions.delete(id);
  });

  sessions.set(id, session);
  return session;
}

function getSession(id: string): Session {
  return sessions.get(id) || createSession(id);
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
    res.end(JSON.stringify({ status: 'ok' }));
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

  // GET /sessions — list all sessions
  if (pathname === '/sessions' && req.method === 'GET') {
    const list: SessionInfo[] = Array.from(sessions.entries()).map(([id, s]) => ({
      id,
      name: s.name,
      createdAt: s.createdAt,
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
        createSession(id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id }));
      } catch {
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

  // GET /sessions/:id/cwd
  const cwdMatch = pathname.match(/^\/sessions\/([^/]+)\/cwd$/);
  if (cwdMatch && req.method === 'GET') {
    const sid = decodeURIComponent(cwdMatch[1]!);
    const session = sessions.get(sid);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    const cwd = await getSessionCwd(session);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cwd }));
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
  // /ws/:sessionId
  const sessionId = decodeURIComponent(pathParts[2] || 'default');

  const session = getSession(sessionId);
  session.clients.add(ws);
  console.log(`[pty-service] Client connected: ${sessionId} (${session.clients.size} clients)`);

  // Send session info
  ws.send(JSON.stringify({ type: 'session_info', name: session.name }));

  // Send scrollback
  try {
    const serialized = session.serializeAddon.serialize({ scrollback: 500 });
    if (serialized) {
      ws.send(JSON.stringify({ type: 'scrollback', data: serialized }));
    }
  } catch (e) {
    console.error('[pty-service] Serialize error:', e);
  }

  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      if (msg.type === 'input') {
        session.pty.write(msg.data);
      } else if (msg.type === 'resize') {
        if (msg.cols > 0 && msg.rows > 0) {
          try {
            session.pty.resize(msg.cols, msg.rows);
            session.headlessTerm.resize(msg.cols, msg.rows);
          } catch {}
        }
      } else if (msg.type === 'asr') {
        console.log(`[pty-service] ASR input: "${msg.text}"`);
        session.pty.write(msg.text + '\r');
      }
    } catch (e) {
      console.error('[pty-service] Parse error:', e);
    }
  });

  ws.on('close', () => {
    session.clients.delete(ws);
    console.log(`[pty-service] Client disconnected: ${sessionId} (${session.clients.size} clients)`);
  });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  // Check internal token
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

// Start — bind to localhost only (internal service)
server.listen(PTY_SERVICE_PORT, '127.0.0.1', () => {
  console.log(`[pty-service] Listening on 127.0.0.1:${PTY_SERVICE_PORT}`);
  console.log(`[pty-service] Ready`);
});

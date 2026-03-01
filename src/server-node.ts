/**
 * hopcode — UI service (code from anywhere, with voice input)
 * Proxies terminal connections to PTY service on localhost:3001
 */

// Prevent unhandled errors from crashing the server
// IMPORTANT: Ignore EPIPE errors to avoid infinite loop when stderr pipe breaks
// (console.error on broken pipe → EPIPE → uncaughtException → console.error → ...)
process.on('SIGPIPE', () => {}); // Ignore broken pipe signals
process.on('uncaughtException', (err) => {
  if ((err as any)?.code === 'EPIPE') return; // Silently ignore broken pipes
  try { console.error('Uncaught exception:', err.message); } catch {}
});
process.on('unhandledRejection', (err: any) => {
  if (err?.code === 'EPIPE') return;
  try { console.error('Unhandled rejection:', err?.message || err); } catch {}
});

import 'dotenv/config';
import * as http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes } from 'crypto';

import {
  PTY_SERVICE_PORT,
  PTY_INTERNAL_TOKEN_HEADER,
  getPtyInternalToken,
  type SessionInfo,
} from './shared/protocol.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '3000');
const PASSWORD = process.env.AUTH_PASSWORD;
if (!PASSWORD) {
  console.error('ERROR: AUTH_PASSWORD environment variable is required. Set it before starting the server.');
  console.error('  Example: AUTH_PASSWORD=your-secret-password npx tsx src/server-node.ts');
  process.exit(1);
}
const AUTH_TOKEN = 'hopcode_auth_' + Buffer.from(PASSWORD).toString('base64');

// --- Rate limiting for login attempts ---
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const loginAttempts = new Map<string, { count: number; firstAttempt: number }>();

function getClientIp(req: http.IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]!.trim();
  return req.socket.remoteAddress || 'unknown';
}

function isRateLimited(ip: string): boolean {
  const record = loginAttempts.get(ip);
  if (!record) return false;
  // Reset if window expired
  if (Date.now() - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return record.count >= LOGIN_MAX_ATTEMPTS;
}

function recordFailedLogin(ip: string): void {
  const record = loginAttempts.get(ip);
  if (!record || Date.now() - record.firstAttempt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAttempt: Date.now() });
  } else {
    record.count++;
  }
}

function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// Voice/ASR config
const VOLCANO_APP_ID = process.env.VOLCANO_APP_ID || '';
const VOLCANO_TOKEN = process.env.VOLCANO_TOKEN || '';
const VOLCANO_ASR_RESOURCE_ID = process.env.VOLCANO_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration';
const VOLCANO_ASR_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

// --- PTY service client ---
const PTY_INTERNAL_TOKEN = getPtyInternalToken();
const PTY_BASE_URL = `http://127.0.0.1:${PTY_SERVICE_PORT}`;

async function ptyFetch(urlPath: string, options?: RequestInit): Promise<Response> {
  const url = PTY_BASE_URL + urlPath;
  const headers = new Headers(options?.headers);
  headers.set(PTY_INTERNAL_TOKEN_HEADER, PTY_INTERNAL_TOKEN);
  return fetch(url, { ...options, headers });
}

// --- File browser helpers ---

function resolveSafePath(requestedPath: string): string {
  return path.resolve('/', requestedPath);
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain',
  '.md': 'text/markdown', '.csv': 'text/csv', '.log': 'text/plain',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.gz': 'application/gzip',
  '.tar': 'application/x-tar', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4',
  '.sh': 'text/x-shellscript', '.py': 'text/x-python', '.ts': 'text/typescript',
  '.tsx': 'text/typescript', '.jsx': 'application/javascript', '.rs': 'text/x-rust',
  '.go': 'text/x-go', '.java': 'text/x-java', '.c': 'text/x-c', '.cpp': 'text/x-c++',
  '.h': 'text/x-c', '.rb': 'text/x-ruby', '.yml': 'text/yaml', '.yaml': 'text/yaml',
  '.toml': 'text/plain', '.ini': 'text/plain', '.cfg': 'text/plain', '.conf': 'text/plain',
  '.env': 'text/plain', '.sql': 'text/x-sql', '.graphql': 'text/plain',
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isPreviewableImage(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'].includes(ext);
}

function isTextFile(filePath: string): boolean {
  const mime = getMimeType(filePath);
  return mime.startsWith('text/') || mime === 'application/json' || mime === 'application/javascript' || mime === 'application/xml';
}

// --- Volcano ASR streaming protocol (native TypeScript) ---

function buildFullClientRequest(payload: object): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
  const gzipped = zlib.gzipSync(jsonBytes);
  // Header: version=1|header_size=1, msg_type=1(FullClient)|flags=0, serial=1(JSON)|compress=1(gzip), reserved=0
  const header = Buffer.from([0x11, 0x10, 0x11, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(gzipped.length);
  return Buffer.concat([header, size, gzipped]);
}

function buildAudioRequest(audioData: Buffer, isLast: boolean): Buffer {
  // msg_type=0b0010(AudioOnly), flags: 0b0010=final, 0b0000=non-final
  const flags = isLast ? 0b0010 : 0b0000;
  const msgTypeFlags = (0b0010 << 4) | flags;
  const header = Buffer.from([0x11, msgTypeFlags, 0x00, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(audioData.length);
  return Buffer.concat([header, size, audioData]);
}

function parseAsrResponse(data: Buffer): { msgType: number; result?: any; error?: string } {
  if (data.length < 12) return { msgType: 0, error: 'Response too short' };
  const msgType = (data[1]! >> 4) & 0x0F;
  const compression = data[2]! & 0x0F;
  const payloadSize = data.readUInt32BE(8);
  let payload = data.subarray(12, 12 + payloadSize);
  if (compression === 1) {
    try { payload = zlib.gunzipSync(payload); } catch {}
  }
  try {
    const result = JSON.parse(payload.toString('utf-8'));
    return { msgType, result };
  } catch {
    return { msgType, error: 'Parse error' };
  }
}

interface AsrSession {
  volcanoWs: WebSocket | null;
  ready: boolean;
  pendingChunks: Buffer[];
  allChunks: Buffer[];       // all audio chunks for retry
  ended: boolean;            // whether asr_end was received
  retryCount: number;
  gotResult: boolean;        // whether we got a final ASR result
}

const ASR_MAX_RETRIES = 2;

function connectVolcano(asrSession: AsrSession, clientWs: WebSocket): void {
  asrSession.ready = false;
  asrSession.pendingChunks = [];

  const headers = {
    'X-Api-App-Key': VOLCANO_APP_ID,
    'X-Api-Access-Key': VOLCANO_TOKEN,
    'X-Api-Resource-Id': VOLCANO_ASR_RESOURCE_ID,
    'X-Api-Connect-Id': randomUUID(),
  };

  const volcanoWs = new WebSocket(VOLCANO_ASR_ENDPOINT, { headers });
  asrSession.volcanoWs = volcanoWs;

  function retryIfNeeded() {
    if (asrSession.gotResult) return; // already got a result, no need to retry
    if (asrSession.retryCount >= ASR_MAX_RETRIES) {
      console.error(`ASR: max retries (${ASR_MAX_RETRIES}) reached, giving up`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'ASR failed after retries' }));
      }
      return;
    }
    asrSession.retryCount++;
    console.log(`ASR: retrying (attempt ${asrSession.retryCount}/${ASR_MAX_RETRIES}), replaying ${asrSession.allChunks.length} buffered chunks`);
    setTimeout(() => connectVolcano(asrSession, clientWs), 500);
  }

  volcanoWs.on('open', () => {
    const initPayload = {
      user: { uid: randomUUID() },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
      request: {
        model_name: 'bigmodel',
        language: 'zh',
        enable_itn: true,
        enable_punc: true,
        result_type: 'full',
        show_utterances: true,
      },
    };
    volcanoWs.send(buildFullClientRequest(initPayload));
    asrSession.ready = true;

    // Replay all buffered audio from previous attempts + current pending
    const toSend = [...asrSession.allChunks, ...asrSession.pendingChunks];
    asrSession.pendingChunks = [];
    for (const chunk of toSend) {
      if (!asrSession.allChunks.includes(chunk)) {
        asrSession.allChunks.push(chunk);
      }
      const isLast = chunk.length === 0;
      volcanoWs.send(buildAudioRequest(chunk, isLast));
    }
    // If recording already ended, send final marker
    if (asrSession.ended && !toSend.some(c => c.length === 0)) {
      volcanoWs.send(buildAudioRequest(Buffer.alloc(0), true));
    }
    console.log(`ASR session connected to Volcano (sent ${toSend.length} chunks, retry=${asrSession.retryCount})`);
  });

  volcanoWs.on('message', (data: Buffer) => {
    try {
      const parsed = parseAsrResponse(Buffer.from(data));
      if (parsed.msgType === 15) {
        console.error('ASR server error:', parsed.result || parsed.error);
        retryIfNeeded();
        return;
      }
      if (parsed.msgType === 9 && parsed.result?.result) {
        const res = parsed.result.result;
        const text = (res.text || '').trim().replace(/[.。]$/, '');
        if (text && clientWs.readyState === WebSocket.OPEN) {
          const utterances = res.utterances || [];
          const definite = utterances.length > 0 && utterances[0].definite;
          clientWs.send(JSON.stringify({
            type: definite ? 'asr' : 'asr_partial',
            text,
          }));
          if (definite) {
            asrSession.gotResult = true;
            console.log(`ASR final: "${text}"`);
          }
        }
      }
    } catch (e) {
      console.error('ASR response error:', (e as Error).message);
    }
  });

  volcanoWs.on('error', (err) => {
    console.error('ASR WebSocket error:', err.message);
    retryIfNeeded();
  });

  volcanoWs.on('close', () => {
    asrSession.ready = false;
    console.log('ASR session closed');
    // If closed before getting a result and recording is done, retry
    if (asrSession.ended && !asrSession.gotResult) {
      retryIfNeeded();
    }
  });
}

function startAsrSession(clientWs: WebSocket): AsrSession {
  const asrSession: AsrSession = {
    volcanoWs: null, ready: false, pendingChunks: [],
    allChunks: [], ended: false, retryCount: 0, gotResult: false,
  };
  connectVolcano(asrSession, clientWs);
  return asrSession;
}

// Voice clients
const voiceClients = new Map<string, WebSocket>();

// Login page HTML
const loginHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Hopcode - Login</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; background: #1a1a2e; display: flex; align-items: center; justify-content: center; font-family: system-ui; padding: 16px; }
    .login-box { background: #16213e; padding: 40px; border-radius: 12px; border: 2px solid #0f3460; width: 100%; max-width: 400px; }
    h1 { color: #4ade80; margin-bottom: 24px; font-size: 24px; text-align: center; }
    input { width: 100%; padding: 12px 16px; font-size: 16px; border: none; border-radius: 8px; background: #1a1a2e; color: #e0e0e0; margin-bottom: 16px; }
    input:focus { outline: 2px solid #4ade80; }
    button { width: 100%; padding: 12px; font-size: 16px; border: none; border-radius: 8px; background: #4ade80; color: #000; cursor: pointer; font-weight: bold; }
    button:hover { background: #22c55e; }
    .error { color: #f87171; font-size: 14px; margin-bottom: 16px; text-align: center; display: none; }
    @media (max-width: 400px) {
      .login-box { padding: 24px; }
    }
  </style>
</head>
<body>
  <div class="login-box">
    <h1>Hopcode</h1>
    <div class="error" id="error">Incorrect password</div>
    <form onsubmit="return login()">
      <input type="password" id="password" placeholder="Password" autofocus>
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    function login() {
      const pwd = document.getElementById('password').value;
      fetch('/terminal/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: pwd }) })
        .then(r => r.json())
        .then(d => {
          if (d.success) {
            location.reload();
          } else {
            document.getElementById('error').textContent = d.error || 'Incorrect password';
            document.getElementById('error').style.display = 'block';
          }
        });
      return false;
    }
  </script>
</body>
</html>`;

// Session chooser HTML page - generated dynamically with server-side rendering
async function buildSessionsHtml(): Promise<string> {
  let sessionList: { id: string; name: string; createdAt: number; clients: number }[] = [];
  try {
    const resp = await ptyFetch('/sessions');
    if (resp.ok) {
      const list: SessionInfo[] = await resp.json() as SessionInfo[];
      sessionList = list.map(s => ({ id: s.id, name: s.name, createdAt: s.createdAt, clients: s.clientCount }));
    }
  } catch {}
  sessionList.sort((a, b) => b.createdAt - a.createdAt);

  function fmtAge(ts: number): string {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  let cardsHtml = '';
  if (sessionList.length === 0) {
    cardsHtml = '<div class="empty-state"><p>No active sessions</p><a class="new-btn" href="/terminal?action=new">Create your first session</a></div>';
  } else {
    for (const s of sessionList) {
      const cl = s.clients === 0 ? 'idle' : s.clients === 1 ? '1 client' : s.clients + ' clients';
      const badgeClass = s.clients > 0 ? ' active' : '';
      cardsHtml += `<a class="session-card" href="/terminal?session=${encodeURIComponent(s.id)}">
        <div class="session-info"><div class="session-name" data-session="${esc(s.id)}"><span class="session-name-text">${esc(s.name)}</span><button class="rename-btn" title="Rename session">&#9998;</button></div>
        <div class="session-meta">Created ${fmtAge(s.createdAt)}</div></div>
        <span class="session-badge${badgeClass}">${cl}</span></a>`;
    }
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Hopcode - Sessions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { min-height: 100%; background: #1a1a2e; font-family: system-ui; color: #e0e0e0; }
    .container { max-width: 700px; margin: 0 auto; padding: 24px; }
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; }
    h1 { color: #4ade80; font-size: 24px; }
    .new-btn {
      padding: 10px 20px; background: #4ade80; color: #000; border: none;
      border-radius: 8px; font-size: 16px; font-weight: bold; cursor: pointer;
      text-decoration: none; display: inline-block;
      -webkit-tap-highlight-color: transparent;
    }
    .new-btn:hover { background: #22c55e; }
    .session-list { display: grid; gap: 12px; }
    .session-card {
      background: #16213e; border: 2px solid #0f3460; border-radius: 12px;
      padding: 20px; cursor: pointer; transition: border-color 0.2s;
      display: flex; justify-content: space-between; align-items: center;
      text-decoration: none; color: inherit;
      -webkit-tap-highlight-color: transparent;
    }
    .session-card:hover, .session-card:active { border-color: #4ade80; }
    .session-info { flex: 1; min-width: 0; }
    .session-name { font-size: 18px; font-weight: 600; margin-bottom: 4px; }
    .session-meta { font-size: 13px; color: #888; }
    .session-badge {
      padding: 4px 10px; border-radius: 12px; font-size: 12px;
      background: #1a1a2e; color: #888; white-space: nowrap; margin-left: 12px;
    }
    .session-badge.active { background: #4ade80; color: #000; }
    .session-name { display: flex; align-items: center; gap: 8px; }
    .rename-btn {
      background: none; border: 1px solid #444; color: #888; border-radius: 4px;
      cursor: pointer; font-size: 13px; padding: 1px 5px; line-height: 1;
      opacity: 0; transition: opacity 0.15s;
      flex-shrink: 0;
    }
    .session-card:hover .rename-btn { opacity: 1; }
    .rename-btn:hover { color: #4ade80; border-color: #4ade80; }
    .session-name-input {
      background: #1a1a2e; color: #e0e0e0; border: 1px solid #4ade80; border-radius: 4px;
      font-size: inherit; font-weight: inherit; font-family: inherit; padding: 2px 6px;
      width: 100%; outline: none;
    }
    @media (max-width: 500px) {
      .rename-btn { opacity: 1; }
    }
    .empty-state { text-align: center; padding: 60px 20px; color: #666; }
    .empty-state p { margin-bottom: 16px; font-size: 18px; }
    @media (max-width: 500px) {
      .container { padding: 16px; }
      .session-name { font-size: 16px; }
      .session-card { padding: 16px; }
      h1 { font-size: 20px; }
      .new-btn { padding: 8px 14px; font-size: 14px; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Hopcode</h1>
      <a class="new-btn" href="/terminal?action=new">+ New Session</a>
    </div>
    <div class="session-list">${cardsHtml}</div>
  </div>
  <script>
    function startRename(nameEl) {
      if (nameEl.querySelector('input')) return;
      var textSpan = nameEl.querySelector('.session-name-text');
      var renameBtn = nameEl.querySelector('.rename-btn');
      var name = textSpan ? textSpan.textContent : nameEl.textContent;
      var sessionId = nameEl.getAttribute('data-session');
      var input = document.createElement('input');
      input.type = 'text';
      input.className = 'session-name-input';
      input.value = name;
      nameEl.textContent = '';
      nameEl.appendChild(input);
      input.focus();
      input.select();
      function restore(text) {
        nameEl.textContent = '';
        var span = document.createElement('span');
        span.className = 'session-name-text';
        span.textContent = text;
        nameEl.appendChild(span);
        var btn = document.createElement('button');
        btn.className = 'rename-btn';
        btn.title = 'Rename session';
        btn.innerHTML = '&#9998;';
        nameEl.appendChild(btn);
      }
      function save() {
        var newName = input.value.trim();
        if (!newName || newName === name) {
          restore(name);
          return;
        }
        fetch('/terminal/rename', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionId, name: newName })
        }).then(function(r) { return r.json(); }).then(function(d) {
          restore(d.success ? newName : name);
        }).catch(function() { restore(name); });
      }
      var committed = false;
      input.addEventListener('click', function(ev) { ev.preventDefault(); ev.stopPropagation(); });
      input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); committed = true; save(); }
        if (ev.key === 'Escape') { ev.preventDefault(); restore(name); }
      });
      input.addEventListener('blur', function() {
        if (!committed) restore(name);
      });
    }
    document.querySelectorAll('.session-card').forEach(function(card) {
      card.addEventListener('click', function(e) {
        var nameEl = card.querySelector('.session-name');
        if (!nameEl) return;
        var target = e.target;
        // Click on rename button or session name text triggers rename
        if (target.classList.contains('rename-btn') || target.classList.contains('session-name-text')) {
          e.preventDefault();
          startRename(nameEl);
        }
        // Click on input inside name — just prevent navigation
        if (target.classList.contains('session-name-input')) {
          e.preventDefault();
        }
      });
    });
  </script>
</body>
</html>`;
  return html;
}

// Terminal HTML page
const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Hopcode</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.min.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: #1a1a2e; }
    #container { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
    #terminal { flex: 1; padding: 8px; overflow: hidden; }
    .xterm-helper-textarea { opacity: 0 !important; caret-color: transparent !important; color: transparent !important; position: absolute !important; left: -9999px !important; }
    #voice-bar {
      background: #16213e; padding: 10px 16px; display: flex; align-items: center; gap: 10px;
      border-top: 2px solid #0f3460; color: #fff; font-family: system-ui;
      flex-shrink: 0; z-index: 60;
      -webkit-tap-highlight-color: transparent;
    }
    #voice-bar.recording { background: #1a3a2e; border-top-color: #4ade80; }
    #status { padding: 6px 12px; background: #333; border-radius: 20px; font-size: 14px; white-space: nowrap; text-align: center; }
    #status.recording { background: #4ade80; color: #000; animation: pulse 1s infinite; }
    @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }
    #text { flex: 1; font-size: 14px; color: #aaa; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 60px; }
    .font-btn { background: #333; border: none; color: #fff; width: 44px; height: 44px; border-radius: 6px; cursor: pointer; font-size: 18px; -webkit-tap-highlight-color: transparent; flex-shrink: 0; }
    .font-btn:hover { background: #444; }
    #font-size { color: #888; font-size: 12px; min-width: 36px; text-align: center; }
    #font-controls { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
    #back-btn { color: #4ade80; font-size: 11px; text-decoration: none; padding: 4px 6px; background: #1a1a2e; border-radius: 6px; white-space: nowrap; flex-shrink: 0; }
    .key-btn { background: #333; border: none; color: #fff; min-width: 40px; height: 36px; border-radius: 6px; cursor: pointer; font-size: 13px; font-family: system-ui; -webkit-tap-highlight-color: transparent; flex-shrink: 0; padding: 0 8px; }
    .key-btn:active { background: #4ade80; color: #000; }
    #special-keys { display: none; align-items: center; gap: 4px; flex: 1; }
    #bar-row1 { display: contents; }
    #bar-row2 { display: contents; }
    #scroll-bottom { background: #333; border: none; color: #fff; min-width: 36px; height: 36px; border-radius: 6px; cursor: pointer; font-size: 16px; -webkit-tap-highlight-color: transparent; flex-shrink: 0; padding: 0; }
    #scroll-bottom:active { background: #4ade80; color: #000; }
    #copy-overlay { display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; z-index: 100; background: #1a1a2e; color: #e0e0e0; font-family: Menlo, Monaco, "Courier New", monospace; font-size: 12px; padding: 8px; border: none; resize: none; white-space: pre; overflow: auto; -webkit-user-select: text; user-select: text; }
    #copy-overlay.active { display: block; }
    #floating-keys {
      position: fixed; right: 12px; top: 50%; transform: translateY(-50%);
      display: flex; flex-direction: column; gap: 10px; z-index: 50;
      pointer-events: none; transition: top 0.15s ease;
    }
    .float-key {
      width: 42px; height: 42px; border-radius: 10px; border: 2px solid rgba(255,255,255,0.45);
      background: rgba(22,33,62,0.6); color: rgba(74,222,128,0.85); font-size: 14px; font-weight: 600;
      font-family: system-ui; cursor: pointer; display: flex; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
      pointer-events: auto;
    }
    .float-key:active { background: rgba(74,222,128,0.8); color: #000; border-color: rgba(74,222,128,0.8); }
    .float-key:hover { border-color: rgba(74,222,128,0.5); color: rgba(224,224,224,0.8); }
    .float-key-config {
      display: none; position: fixed; z-index: 200; background: #16213e; border: 2px solid #4ade80;
      border-radius: 12px; padding: 16px; font-family: system-ui; color: #e0e0e0;
    }
    .float-key-config label { display: block; font-size: 13px; margin-bottom: 6px; color: #888; }
    .float-key-config input { width: 100%; padding: 8px; font-size: 16px; border: 1px solid #444; border-radius: 6px; background: #1a1a2e; color: #e0e0e0; outline: none; margin-bottom: 10px; }
    .float-key-config input:focus { border-color: #4ade80; }
    .float-key-config select { width: 100%; padding: 8px; font-size: 14px; border: 1px solid #444; border-radius: 6px; background: #1a1a2e; color: #e0e0e0; outline: none; margin-bottom: 10px; }
    .float-key-config .cfg-row { display: flex; gap: 8px; }
    .float-key-config button { flex: 1; padding: 8px; border: none; border-radius: 6px; font-size: 14px; cursor: pointer; font-weight: 600; }
    .float-key-config .cfg-save { background: #4ade80; color: #000; }
    .float-key-config .cfg-cancel { background: #333; color: #e0e0e0; }
    body.mobile #voice-bar { padding: 6px 6px; gap: 0; flex-direction: column; }
    body.mobile #bar-row1 { display: flex; align-items: center; gap: 4px; width: 100%; }
    body.mobile #bar-row2 { display: flex; align-items: center; gap: 4px; width: 100%; margin-top: 5px; }
    body.mobile #special-keys { display: flex; }
    body.mobile #status { font-size: 13px; padding: 8px; flex: 3; text-align: center; border-radius: 8px; }
    body.mobile #text { display: none; }
    body.mobile #font-controls { display: none; }
    body.mobile .key-btn { min-width: 0; flex: 1; padding: 0 4px; height: 34px; font-size: 12px; }
    .mobile-only { display: none; }
    body.mobile .mobile-only { display: inline-block; }
    body.mobile #back-btn { display: none; }
    body.mobile #scroll-bottom { display: none; }
    body.mobile #back-btn-mobile { padding: 4px 5px; font-size: 10px; flex-shrink: 0; color: #4ade80; text-decoration: none; background: #1a1a2e; border-radius: 6px; white-space: nowrap; }
    body.mobile #scroll-bottom-mobile { min-width: 0; height: 34px; font-size: 14px; flex: 1; background: #333; border: none; color: #fff; border-radius: 6px; cursor: pointer; -webkit-tap-highlight-color: transparent; padding: 0; }
    #voice-bar.collapsed { display: none; }
    /* --- File Browser --- */
    #file-browser {
      position: fixed; top: 0; right: -100%; width: 100%; max-width: 480px; height: 100%;
      background: #1a1a2e; z-index: 300; display: flex; flex-direction: column;
      transition: right 0.25s ease; border-left: 2px solid #0f3460;
      font-family: system-ui; color: #e0e0e0;
    }
    #file-browser.open { right: 0; }
    #fb-header {
      display: flex; align-items: center; gap: 8px; padding: 12px;
      background: rgba(22,33,62,0.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
      border-bottom: 1px solid rgba(15,52,96,0.5); flex-shrink: 0;
    }
    #fb-close { background: none; border: none; color: #e0e0e0; font-size: 24px; cursor: pointer; padding: 0 8px; line-height: 1; }
    #fb-title { flex: 1; font-size: 16px; font-weight: 600; text-align: center; }
    #fb-cwd-btn { font-size: 11px; padding: 4px 8px; height: 28px; min-width: 0; }
    #fb-breadcrumb {
      display: flex; align-items: center; gap: 2px; padding: 8px 12px; font-size: 12px;
      overflow-x: auto; white-space: nowrap; flex-shrink: 0; background: #111;
      scrollbar-width: none;
    }
    #fb-breadcrumb::-webkit-scrollbar { display: none; }
    .fb-crumb { color: #4ade80; cursor: pointer; padding: 2px 4px; border-radius: 3px; flex-shrink: 0; }
    .fb-crumb:hover { background: #333; }
    .fb-sep { color: #555; flex-shrink: 0; font-size: 14px; }
    #fb-error { display: none; padding: 12px; color: #f87171; font-size: 13px; background: #2a1a1a; }
    #fb-list { flex: 1; overflow-y: auto; overflow-x: hidden; }
    .fb-item {
      display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer;
      border-radius: 8px; margin: 2px 8px; transition: background 0.15s;
    }
    .fb-item:hover, .fb-item:active { background: rgba(255,255,255,0.06); }
    .fb-icon { font-size: 18px; flex-shrink: 0; width: 24px; text-align: center; line-height: 0; }
    .fb-info { flex: 1; min-width: 0; }
    .fb-name { font-size: 14px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fb-meta { font-size: 11px; color: #666; margin-top: 2px; }
    .fb-actions { display: flex; gap: 4px; flex-shrink: 0; }
    .fb-dl { background: #333; border: none; color: #4ade80; font-size: 11px; padding: 4px 8px; border-radius: 4px; cursor: pointer; min-width: 32px; min-height: 36px; }
    .fb-dl:active { background: #4ade80; color: #000; }
    #fb-text-preview { display: none; flex: 1; flex-direction: column; overflow: hidden; }
    #fb-text-header {
      display: flex; align-items: center; gap: 8px; padding: 8px 12px;
      background: #16213e; border-bottom: 1px solid #0f3460; flex-shrink: 0;
    }
    #fb-text-back { font-size: 11px; padding: 4px 8px; height: 28px; min-width: 0; }
    #fb-text-name { flex: 1; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #fb-text-dl { font-size: 11px; padding: 4px 8px; height: 28px; min-width: 0; }
    #fb-text-content {
      flex: 1; overflow: auto; padding: 12px; margin: 0; font-family: Menlo, Monaco, "Courier New", monospace;
      font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-all; color: #ccc;
    }
    #fb-preview {
      display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 400;
      background: rgba(0,0,0,0.95); flex-direction: column; align-items: center; justify-content: center;
    }
    #fb-preview.open { display: flex; }
    #fb-preview-close {
      position: absolute; top: 12px; right: 16px; background: none; border: none;
      color: #fff; font-size: 32px; cursor: pointer; z-index: 1; padding: 4px 12px;
    }
    #fb-preview-img { max-width: 95%; max-height: 75vh; object-fit: contain; }
    #fb-preview-info {
      display: flex; align-items: center; gap: 12px; margin-top: 16px; color: #ccc; font-size: 14px;
    }
    #fb-preview-dl { font-size: 12px; padding: 6px 12px; }
    body.mobile #file-browser { max-width: 100%; }
    #files-btn { font-size: 11px; padding: 0 6px; }
  </style>
</head>
<body>
  <div id="container">
    <div id="terminal"></div>
    <textarea id="copy-overlay" readonly></textarea>
    <div id="voice-bar">
      <div id="bar-row1">
        <a href="/terminal" id="back-btn">Sess</a>
        <div id="special-keys">
          <button class="key-btn" id="bar-hide-btn" style="font-size:16px">&#x25B8;</button>
          <button class="key-btn" data-key="esc">Esc</button>
          <button class="key-btn" data-key="tab">Tab</button>
          <button class="key-btn" data-key="up">&#x25B2;</button>
          <button class="key-btn" data-key="down">&#x25BC;</button>
        </div>
        <div id="font-controls">
          <button class="font-btn" onclick="changeFontSize(-2)">&#x2212;</button>
          <span id="font-size">21px</span>
          <button class="font-btn" onclick="changeFontSize(2)">+</button>
        </div>
      </div>
      <div id="bar-row2">
        <a href="/terminal" id="back-btn-mobile" class="mobile-only">Sess</a>
        <button id="files-btn" class="key-btn" title="Files">Files</button>
        <div id="status">Hold Option to speak</div>
        <div id="text"></div>
        <button id="scroll-bottom-mobile" class="mobile-only" title="Scroll to bottom">&#x21E9;</button>
        <button id="scroll-bottom" title="Scroll to bottom">&#x21E9;</button>
      </div>
    </div>
  </div>
  <div id="floating-keys"></div>
  <div class="float-key-config" id="fk-config">
    <label>Label</label>
    <input type="text" id="fk-cfg-label" maxlength="6" placeholder="e.g. Enter">
    <label>Action</label>
    <select id="fk-cfg-action">
      <option value="char">Type character(s)</option>
      <option value="enter">Enter</option>
      <option value="esc">Escape</option>
      <option value="tab">Tab</option>
      <option value="up">Arrow Up</option>
      <option value="down">Arrow Down</option>
      <option value="pageup">Page Up</option>
      <option value="pagedown">Page Down</option>
      <option value="ctrlc">Ctrl+C</option>
      <option value="ctrld">Ctrl+D</option>
      <option value="ctrlz">Ctrl+Z</option>
      <option value="togglebar">Toggle Bar</option>
    </select>
    <div id="fk-cfg-char-row">
      <label>Characters to send</label>
      <input type="text" id="fk-cfg-chars" placeholder="e.g. 1">
    </div>
    <div class="cfg-row">
      <button class="cfg-save" id="fk-cfg-save">Save</button>
      <button class="cfg-cancel" id="fk-cfg-cancel">Cancel</button>
    </div>
  </div>

  <div id="file-browser">
    <div id="fb-header">
      <button id="fb-close">&times;</button>
      <span id="fb-title">Files</span>
      <button id="fb-cwd-btn" class="key-btn" title="Go to PTY working directory">CWD</button>
    </div>
    <div id="fb-breadcrumb"></div>
    <div id="fb-error"></div>
    <div id="fb-list"></div>
    <div id="fb-text-preview">
      <div id="fb-text-header">
        <button id="fb-text-back" class="key-btn">&larr; Back</button>
        <span id="fb-text-name"></span>
        <button id="fb-text-dl" class="key-btn">&#x2193;</button>
      </div>
      <pre id="fb-text-content"></pre>
    </div>
  </div>
  <div id="fb-preview">
    <button id="fb-preview-close">&times;</button>
    <img id="fb-preview-img" />
    <div id="fb-preview-info">
      <span id="fb-preview-name"></span>
      <button id="fb-preview-dl" class="key-btn">&#x2193;</button>
    </div>
  </div>

  <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.min.js"></script>
  <script>
    window.onerror = function(msg, src, line) {
      document.getElementById('status').textContent = 'JS Error: ' + msg;
      document.getElementById('status').style.background = '#f87171';
    };

    const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    if (isMobile) document.body.classList.add('mobile');
    var savedFontSize = parseInt(localStorage.getItem('hopcode-font-size'));
    let fontSize = savedFontSize > 0 ? savedFontSize : (isMobile ? 14 : 21);
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 50000,
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#4ade80' }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    var termEl = document.getElementById('terminal');
    term.open(termEl);
    fitAddon.fit();
    var visibleRows = term.rows;

    // Hide xterm scrollbar but keep scrolling functional
    var xtermViewport = document.querySelector('.xterm-viewport');
    if (xtermViewport) {
      xtermViewport.style.scrollbarWidth = 'none';
      xtermViewport.style.webkitOverflowScrolling = 'touch';
    }
    var style = document.createElement('style');
    style.textContent = '.xterm-viewport::-webkit-scrollbar { display: none; }';
    document.head.appendChild(style);

    // Faster scrolling on mobile only (desktop uses xterm's default scroll)
    if (isMobile) {
      document.querySelector('.xterm-screen').addEventListener('wheel', function(e) {
        e.preventDefault();
        var lines = Math.round(e.deltaY / Math.abs(e.deltaY || 1)) * 5;
        term.scrollLines(lines);
      }, { passive: false });
    }

    // Touch scroll with momentum for mobile
    var touchLastY = 0;
    var touchVelocity = 0;
    var momentumId = 0;
    var xtermScreen = document.querySelector('.xterm-screen');
    if (isMobile && xtermScreen) {
      xtermScreen.addEventListener('touchstart', function(e) {
        cancelAnimationFrame(momentumId);
        touchLastY = e.touches[0].clientY;
        touchVelocity = 0;
      }, { passive: true });
      xtermScreen.addEventListener('touchmove', function(e) {
        e.preventDefault();
        var y = e.touches[0].clientY;
        var delta = touchLastY - y;
        touchVelocity = delta;
        var cellHeight = xtermScreen.offsetHeight / term.rows;
        var lines = Math.round(delta / cellHeight);
        if (lines !== 0) {
          term.scrollLines(lines);
          touchLastY = y;
          if (lines < 0 && xtermTextarea) xtermTextarea.blur();
        }
      }, { passive: false });
      xtermScreen.addEventListener('touchend', function() {
        // Momentum scrolling
        var v = touchVelocity;
        function momentumStep() {
          if (Math.abs(v) < 1) return;
          var cellHeight = xtermScreen.offsetHeight / term.rows;
          var lines = Math.round(v / cellHeight);
          if (lines !== 0) term.scrollLines(lines);
          v *= 0.92;
          momentumId = requestAnimationFrame(momentumStep);
        }
        momentumStep();
      }, { passive: true });
    }

    function getPtyRows() { return visibleRows; }

    // Scroll to cursor (bottom of terminal)
    function scrollToCursor() {
      term.scrollToBottom();
    }

    // Auto-scroll on new output
    var autoScroll = true;
    term.onScroll(function() {
      var buf = term.buffer.active;
      var viewportAtBottom = buf.viewportY >= buf.baseY;
      autoScroll = viewportAtBottom;
    });
    function doAutoScroll() {
      if (!autoScroll) return;
      term.scrollToBottom();
    }

    function changeFontSize(delta) {
      fontSize = Math.max(10, Math.min(40, fontSize + delta));
      term.options.fontSize = fontSize;
      localStorage.setItem('hopcode-font-size', String(fontSize));
      document.getElementById('font-size').textContent = fontSize + 'px';
      fitAddon.fit();
      visibleRows = term.rows;
      if (typeof termWs !== 'undefined' && termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: getPtyRows() }));
      }
    }

    // Session ID from URL
    const sessionId = new URLSearchParams(location.search).get('session');
    if (!sessionId) { location.href = '/terminal'; }

    // Terminal WebSocket with auto-reconnect
    var wsUrl = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws?session=' + sessionId;
    var termWs = null;
    var isReconnect = false;

    function connectTerminal() {
      document.getElementById('status').textContent = isReconnect ? 'Reconnecting...' : 'Connecting...';
      termWs = new WebSocket(wsUrl);
      termWs.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.type === 'session_info') {
          document.title = msg.name + ' - Hopcode';
        } else if (msg.type === 'scrollback') {
          // Scrollback replay: write with terminal hidden to avoid visual flicker
          const termEl = document.getElementById('terminal');
          termEl.style.visibility = 'hidden';
          if (isReconnect) term.reset();
          term.write(msg.data, () => {
            termEl.style.visibility = '';
            scrollToCursor();
          });
        } else if (msg.type === 'output') {
          term.write(msg.data, doAutoScroll);
        }
      };
      termWs.onopen = () => {
        document.getElementById('status').textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        document.getElementById('status').style.background = '';
        termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: getPtyRows() }));
      };
      termWs.onerror = () => {
        document.getElementById('status').textContent = 'WS error';
        document.getElementById('status').style.background = '#f87171';
      };
      termWs.onclose = (e) => {
        document.getElementById('status').textContent = 'Disconnected - reconnecting...';
        document.getElementById('status').style.background = '#f97316';
        isReconnect = true;
        setTimeout(connectTerminal, 2000);
      };
    }
    connectTerminal();

    function sendInput(data) {
      if (termWs && termWs.readyState === 1) {
        termWs.send(JSON.stringify({ type: 'input', data: data }));
      }
      autoScroll = true;
      scrollToCursor();
    }

    // Mobile autocomplete fix — three layers:
    // 1. beforeinput: intercept insertReplacementText (autocomplete), compute
    //    diff ourselves, send only the new chars, block onData for 100ms
    //    so xterm's accumulated textarea junk doesn't reach the terminal.
    // 2. onData prefix check: fallback for keyboards that don't fire
    //    insertReplacementText. Tracks current word in typingBuffer.
    // 3. Clear textarea on control chars (Enter, Ctrl+C) to prevent
    //    cross-command accumulation in the keyboard's backspace buffer.
    var isComposing = false;
    var compositionJustEnded = false;
    var typingBuffer = '';
    var typingBufferTimer = null;
    var DEL = String.fromCharCode(127);
    var blockOnDataUntil = 0;

    function resetTypingBuffer() {
      typingBuffer = '';
      if (typingBufferTimer) { clearTimeout(typingBufferTimer); typingBufferTimer = null; }
    }
    function appendToTypingBuffer(ch) {
      if (ch === ' ') {
        typingBuffer = '';
      } else {
        typingBuffer += ch;
      }
      if (typingBufferTimer) clearTimeout(typingBufferTimer);
      typingBufferTimer = setTimeout(resetTypingBuffer, 5000);
    }
    function isPrintableChar(d) {
      return d.length === 1 && d.charCodeAt(0) >= 32 && d.charCodeAt(0) !== 127;
    }
    function commonPrefixLen(a, b) {
      var len = Math.min(a.length, b.length);
      for (var i = 0; i < len; i++) { if (a[i] !== b[i]) return i; }
      return len;
    }

    var xtermTextarea = document.querySelector('.xterm-helper-textarea');
    if (xtermTextarea) {
      xtermTextarea.setAttribute('autocomplete', 'off');
      xtermTextarea.setAttribute('autocorrect', 'off');
      xtermTextarea.setAttribute('autocapitalize', 'off');
      xtermTextarea.setAttribute('spellcheck', 'false');

      // Intercept autocomplete BEFORE xterm processes it.
      // We compute the diff (new chars only) and send it ourselves,
      // then block onData so xterm's version (which may include accumulated
      // textarea content) doesn't reach the terminal.
      xtermTextarea.addEventListener('beforeinput', function(e) {
        if (e.inputType === 'insertReplacementText' && typingBuffer) {
          var replacement = e.data;
          if (!replacement && e.dataTransfer) {
            replacement = e.dataTransfer.getData('text/plain') || e.dataTransfer.getData('text');
          }
          if (replacement) {
            var cpLen = commonPrefixLen(typingBuffer, replacement);
            var extraBufferChars = typingBuffer.length - cpLen;
            var bs = '';
            for (var i = 0; i < extraBufferChars; i++) bs += DEL;
            var newPart = replacement.slice(cpLen);
            resetTypingBuffer();
            if (bs || newPart) sendInput(bs + newPart);
            blockOnDataUntil = Date.now() + 150;
          }
        }
      });

      xtermTextarea.addEventListener('compositionstart', function() {
        isComposing = true;
        resetTypingBuffer();
      });
      xtermTextarea.addEventListener('compositionend', function(e) {
        isComposing = false;
        compositionJustEnded = true;
        if (e.data) sendInput(e.data);
        setTimeout(function() { compositionJustEnded = false; }, 200);
      });
    }

    term.onData(function(data) {
      // Block when beforeinput already handled autocomplete
      if (Date.now() < blockOnDataUntil) return;
      if (compositionJustEnded) return;
      if (isComposing) return;

      // Single printable char — normal keystroke, track in buffer and send
      if (isPrintableChar(data)) {
        appendToTypingBuffer(data);
        sendInput(data);
        return;
      }

      // Multi-char data with active typing buffer — fallback autocomplete check
      if (data.length > 1 && typingBuffer) {
        var cpLen = commonPrefixLen(typingBuffer, data);
        if (cpLen >= 2) {
          var extraBufferChars = typingBuffer.length - cpLen;
          var bs = '';
          for (var i = 0; i < extraBufferChars; i++) bs += DEL;
          var newPart = data.slice(cpLen);
          resetTypingBuffer();
          if (bs || newPart) sendInput(bs + newPart);
          return;
        }
      }

      // Non-printable, paste, escape sequences, or no buffer match
      resetTypingBuffer();
      if (data) sendInput(data);
      // Clear textarea on control chars (Enter, Ctrl+C, Tab, etc.) to prevent
      // cross-command accumulation. Skip DEL/backspace so within-word editing works.
      if (xtermTextarea && !isComposing && data.length === 1 && data.charCodeAt(0) < 32) {
        setTimeout(function() { xtermTextarea.value = ''; }, 0);
      }
    });

    // Clipboard image paste → upload to server → insert path into terminal
    // Use capture phase (3rd arg = true) because xterm.js calls stopPropagation on paste
    document.addEventListener('paste', function(e) {
      if (!e.clipboardData || !e.clipboardData.items) return;
      var items = e.clipboardData.items;
      for (var i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image/') === 0) {
          e.preventDefault();
          e.stopPropagation();
          var blob = items[i].getAsFile();
          if (!blob) return;
          var statusEl = document.getElementById('status');
          var prevStatus = statusEl ? statusEl.textContent : '';
          if (statusEl) { statusEl.textContent = 'Uploading image...'; statusEl.style.background = '#60a5fa'; }
          fetch('/terminal/upload', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': blob.type },
            body: blob
          }).then(function(r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
          }).then(function(data) {
            if (data.error) throw new Error(data.error);
            if (data.path) sendInput(data.path + ' ');
            if (statusEl) { statusEl.textContent = 'Image uploaded'; statusEl.style.background = '#4ade80'; }
            setTimeout(function() { if (statusEl) { statusEl.textContent = prevStatus; statusEl.style.background = ''; } }, 2000);
          }).catch(function(err) {
            console.error('[paste] upload failed:', err);
            if (statusEl) { statusEl.textContent = 'Upload failed: ' + err.message; statusEl.style.background = '#f87171'; }
            setTimeout(function() { if (statusEl) { statusEl.textContent = prevStatus; statusEl.style.background = ''; } }, 5000);
          });
          return;
        }
      }
    }, true);

    // Fix mobile viewport height (100vh includes browser chrome)
    function setVh() {
      var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      document.getElementById('container').style.height = h + 'px';
    }
    if (isMobile) {
      setVh();
      if (window.visualViewport) window.visualViewport.addEventListener('resize', setVh);
    }

    // Debounced resize to avoid PTY redraw storms (e.g. mobile keyboard toggle)
    var resizeTimer = null;
    window.addEventListener('resize', () => {
      if (isMobile) setVh();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        visibleRows = term.rows;
        if (termWs && termWs.readyState === 1) {
          termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: getPtyRows() }));
        }
        autoScroll = true;
        scrollToCursor();
      }, 300);
    });

    // Special key buttons for mobile
    var keyMap = { esc: String.fromCharCode(27), tab: String.fromCharCode(9), up: String.fromCharCode(27) + '[A', down: String.fromCharCode(27) + '[B' };
    document.querySelectorAll('.key-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        resetTypingBuffer();
        var seq = keyMap[btn.getAttribute('data-key')];
        if (seq) sendInput(seq);
        if (isMobile && xtermTextarea) xtermTextarea.blur();
        else term.focus();
      });
    });


    // Bar collapse toggle (called from floating key)
    function toggleBar() {
      var bar = document.getElementById('voice-bar');
      bar.classList.toggle('collapsed');
      setTimeout(function() { fitAddon.fit(); visibleRows = term.rows; if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: getPtyRows() })); }, 100);
    }

    // Hide bar button in row1
    document.getElementById('bar-hide-btn').addEventListener('click', function(e) {
      e.preventDefault();
      toggleBar();
    });

    // Scroll to bottom buttons (desktop + mobile duplicate)
    function handleScrollBottom(e) {
      e.preventDefault();
      autoScroll = true;
      scrollToCursor();
      if (isMobile && xtermTextarea) xtermTextarea.blur();
      else term.focus();
    }
    document.getElementById('scroll-bottom').addEventListener('click', handleScrollBottom);
    var scrollBottomMobile = document.getElementById('scroll-bottom-mobile');
    if (scrollBottomMobile) scrollBottomMobile.addEventListener('click', handleScrollBottom);

    // Select/Copy mode: show terminal text in a selectable overlay
    var copyOverlay = document.getElementById('copy-overlay');
    var copyBtn = document.getElementById('copy-btn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (copyOverlay.classList.contains('active')) {
          copyOverlay.classList.remove('active');
          copyBtn.textContent = 'Sel';
          copyBtn.style.background = '';
          if (!isMobile) term.focus();
        } else {
          var buf = term.buffer.active;
          var lines = [];
          for (var i = 0; i < buf.length; i++) {
            var line = buf.getLine(i);
            if (line) lines.push(line.translateToString(true));
          }
          copyOverlay.value = lines.join(String.fromCharCode(10));
          copyOverlay.classList.add('active');
          copyOverlay.scrollTop = copyOverlay.scrollHeight;
          copyBtn.textContent = 'Back';
          copyBtn.style.background = '#4ade80';
          copyBtn.style.color = '#000';
        }
      });
    }

    // Voice setup - streaming ASR (sends PCM in real-time)
    const status = document.getElementById('status');
    const text = document.getElementById('text');
    let voiceWs, audioStream, audioContext, sourceNode, processorNode;
    let isRecording = false, audioReady = false;
    var pendingAsrText = ''; // Accumulate ASR text, send only when recording ends
    var asrFlushed = false; // Prevent flushing more than once per recording

    function flushAsrText() {
      if (asrFlushed) return;
      if (pendingAsrText && termWs && termWs.readyState === 1) {
        asrFlushed = true;
        text.textContent = pendingAsrText;
        status.textContent = 'Sending to terminal...';
        termWs.send(JSON.stringify({ type: 'asr', text: pendingAsrText }));
        setTimeout(function() { status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak'; }, 2000);
      } else {
        status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
      }
      pendingAsrText = '';
    }

    function connectVoice() {
      voiceWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws-voice');
      voiceWs.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (d.type === 'asr' && d.text) {
          clearTimeout(processingTimeout);
          pendingAsrText = d.text;
          text.textContent = d.text;
          // Don't send to terminal yet - wait for recording to fully end
          // If recording already ended (Processing state), flush now
          if (!isRecording && !stopRecTimer) {
            flushAsrText();
          }
        } else if (d.type === 'asr_partial' && d.text) {
          pendingAsrText = d.text;
          text.textContent = d.text;
        }
      };
      voiceWs.onclose = () => {
        // Reset all recording state
        clearTimeout(stopRecTimer);
        stopRecTimer = null;
        isRecording = false;
        releaseMic();
        status.classList.remove('recording');
        if (status.textContent === 'Processing...' || status.textContent === 'Finishing...' || status.textContent === 'Recording...') {
          status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        }
        setTimeout(connectVoice, 2000);
      };
    }

    async function acquireMic() {
      if (audioReady) return true;
      try {
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1 } });
        audioContext = new AudioContext({ sampleRate: 16000 });
        sourceNode = audioContext.createMediaStreamSource(audioStream);
        processorNode = audioContext.createScriptProcessor(4096, 1, 1);
        processorNode.onaudioprocess = function(e) {
          if (!isRecording || !voiceWs || voiceWs.readyState !== 1) return;
          var input = e.inputBuffer.getChannelData(0);
          var pcm = new Int16Array(input.length);
          for (var i = 0; i < input.length; i++) {
            pcm[i] = Math.max(-1, Math.min(1, input[i])) * (input[i] < 0 ? 0x8000 : 0x7FFF);
          }
          voiceWs.send(pcm.buffer);
        };
        sourceNode.connect(processorNode);
        processorNode.connect(audioContext.destination);
        audioReady = true;
        return true;
      } catch (e) {
        status.textContent = 'Mic error';
        return false;
      }
    }

    function releaseMic() {
      audioReady = false;
      if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
      if (processorNode) { try { processorNode.disconnect(); } catch {} processorNode = null; }
      if (audioStream) { audioStream.getTracks().forEach(function(t) { t.stop(); }); audioStream = null; }
      if (audioContext) { try { audioContext.close(); } catch {} audioContext = null; }
    }

    async function startRec() {
      if (isRecording) return;
      var ok = await acquireMic();
      if (!ok) return;
      if (audioContext.state === 'suspended') audioContext.resume();
      isRecording = true;
      asrFlushed = false;
      pendingAsrText = '';
      if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_start' }));
      status.textContent = 'Recording...';
      status.classList.add('recording');
      text.textContent = '';
    }

    var processingTimeout = null;
    var stopRecTimer = null;
    var stopRecRequestedAt = 0;
    function stopRec() {
      if (!isRecording) return;
      // Keep recording for 1000ms to capture trailing sound, then finalize
      if (!stopRecTimer) {
        stopRecRequestedAt = Date.now();
        status.textContent = 'Finishing...';
        status.classList.remove('recording');
        stopRecTimer = setTimeout(function() {
          stopRecTimer = null;
          if (!isRecording) return;
          isRecording = false;
          if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
          releaseMic();
          status.textContent = 'Processing...';
          clearTimeout(processingTimeout);
          processingTimeout = setTimeout(function() {
            // Safety: if no final ASR result after 10s, flush whatever we have
            if (status.textContent === 'Processing...') {
              flushAsrText();
            }
          }, 10000);
        }, 1000);
      }
    }

    let altDown = false, altDownTime = 0, altCombined = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' && !altDown) {
        altDown = true;
        altDownTime = Date.now();
        altCombined = false;
        startRec();
        e.preventDefault();
        e.stopPropagation();
      } else if (altDown && e.key !== 'Alt') {
        // Option combined with another key - cancel recording
        altCombined = true;
        if (isRecording) {
          stopRec();
          status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        }
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && altDown) {
        altDown = false;
        const holdDuration = Date.now() - altDownTime;
        if (altCombined || holdDuration < 800) {
          // Combined with other key or too short - discard
          if (isRecording) {
            stopRec();
            status.textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
          }
        } else {
          stopRec();
        }
        e.preventDefault();
        e.stopPropagation();
      }
    }, true);

    // Update font size display to match initial value
    document.getElementById('font-size').textContent = fontSize + 'px';

    // Mobile: entire voice bar is hold-to-speak (except font controls and back button)
    const voiceBar = document.getElementById('voice-bar');
    const fontControls = document.getElementById('font-controls');
    const backBtn = document.getElementById('back-btn');
    var backBtnMobile = document.getElementById('back-btn-mobile');
    var specialKeys = document.getElementById('special-keys');
    var scrollBtn = document.getElementById('scroll-bottom');
    var scrollBtnMobile = document.getElementById('scroll-bottom-mobile');
    var filesBtn = document.getElementById('files-btn');
    function isExcluded(el) {
      return (fontControls && fontControls.contains(el)) || (backBtn && backBtn.contains(el)) || (backBtnMobile && backBtnMobile.contains(el)) || (specialKeys && specialKeys.contains(el)) || (filesBtn && filesBtn.contains(el)) || (scrollBtnMobile && scrollBtnMobile.contains(el));
    }
    voiceBar.addEventListener('touchstart', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      startRec();
      voiceBar.classList.add('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchend', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      stopRec();
      voiceBar.classList.remove('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchcancel', () => {
      stopRec();
      voiceBar.classList.remove('recording');
    });

    // Update status text for mobile
    if (isMobile) {
      status.textContent = 'Hold here to speak';
    }

    // --- Floating quick-keys (customizable) ---
    var fkActionMap = {
      'char': function(chars) { return chars || ''; },
      'enter': function() { return String.fromCharCode(13); },
      'esc': function() { return String.fromCharCode(27); },
      'tab': function() { return String.fromCharCode(9); },
      'up': function() { return String.fromCharCode(27) + '[A'; },
      'down': function() { return String.fromCharCode(27) + '[B'; },
      'pageup': function() { return String.fromCharCode(27) + '[5~'; },
      'pagedown': function() { return String.fromCharCode(27) + '[6~'; },
      'ctrlc': function() { return String.fromCharCode(3); },
      'ctrld': function() { return String.fromCharCode(4); },
      'ctrlz': function() { return String.fromCharCode(26); },
      'togglebar': function() { return null; }
    };
    var fkDefaults = [
      { label: 'Bar', action: 'togglebar', chars: '' },
      { label: '1', action: 'char', chars: '1' },
      { label: '2', action: 'char', chars: '2' },
      { label: '3', action: 'char', chars: '3' },
      { label: 'Ret', action: 'enter', chars: '' }
    ];
    var fkStorageKey = 'hopcode_float_keys';
    function fkLoad() {
      try {
        var saved = localStorage.getItem(fkStorageKey);
        if (saved) return JSON.parse(saved);
      } catch {}
      return null;
    }
    function fkSave(keys) {
      try { localStorage.setItem(fkStorageKey, JSON.stringify(keys)); } catch {}
    }
    var fkVersion = 2;
    var fkSaved = fkLoad();
    var fkSavedVer = parseInt(localStorage.getItem('hopcode_float_keys_v')) || 0;
    var fkKeys = (fkSaved && fkSavedVer >= fkVersion) ? fkSaved : fkDefaults.slice();
    if (fkSavedVer < fkVersion) { localStorage.setItem('hopcode_float_keys_v', String(fkVersion)); fkSave(fkKeys); }
    var fkContainer = document.getElementById('floating-keys');
    var fkConfigEl = document.getElementById('fk-config');
    var fkConfigLabel = document.getElementById('fk-cfg-label');
    var fkConfigAction = document.getElementById('fk-cfg-action');
    var fkConfigChars = document.getElementById('fk-cfg-chars');
    var fkConfigCharRow = document.getElementById('fk-cfg-char-row');
    var fkConfigSave = document.getElementById('fk-cfg-save');
    var fkConfigCancel = document.getElementById('fk-cfg-cancel');
    var fkEditIdx = -1;
    var fkLongTimer = null;

    function fkRender() {
      fkContainer.innerHTML = '';
      fkKeys.forEach(function(k, i) {
        var btn = document.createElement('button');
        btn.className = 'float-key';
        btn.textContent = k.label;
        btn.addEventListener('mousedown', function() { fkLongTimer = setTimeout(function() { fkLongTimer = 'fired'; fkOpenConfig(i); }, 600); });
        btn.addEventListener('mouseup', function(e) { if (fkLongTimer === 'fired') { fkLongTimer = null; return; } clearTimeout(fkLongTimer); fkLongTimer = null; fkSend(k); });
        btn.addEventListener('mouseleave', function() { if (fkLongTimer !== 'fired') clearTimeout(fkLongTimer); fkLongTimer = null; });
        btn.addEventListener('touchstart', function(e) { e.preventDefault(); fkLongTimer = setTimeout(function() { fkLongTimer = 'fired'; fkOpenConfig(i); }, 600); }, { passive: false });
        btn.addEventListener('touchend', function(e) { e.preventDefault(); if (fkLongTimer === 'fired') { fkLongTimer = null; return; } clearTimeout(fkLongTimer); fkLongTimer = null; fkSend(k); }, { passive: false });
        btn.addEventListener('touchcancel', function() { if (fkLongTimer !== 'fired') clearTimeout(fkLongTimer); fkLongTimer = null; });
        fkContainer.appendChild(btn);
      });
    }

    function fkSend(k) {
      if (k.action === 'togglebar') { toggleBar(); return; }
      resetTypingBuffer();
      var fn = fkActionMap[k.action];
      if (fn) sendInput(fn(k.chars));
      if (isMobile && xtermTextarea) xtermTextarea.blur();
      else term.focus();
    }

    function fkOpenConfig(idx) {
      fkEditIdx = idx;
      var k = fkKeys[idx];
      fkConfigLabel.value = k.label;
      fkConfigAction.value = k.action;
      fkConfigChars.value = k.chars || '';
      fkConfigCharRow.style.display = k.action === 'char' ? '' : 'none';
      fkConfigEl.style.display = 'block';
      fkConfigEl.style.right = '76px';
      fkConfigEl.style.top = '50%';
      fkConfigEl.style.transform = 'translateY(-50%)';
      fkConfigLabel.focus();
    }

    fkConfigAction.addEventListener('change', function() {
      fkConfigCharRow.style.display = fkConfigAction.value === 'char' ? '' : 'none';
    });
    fkConfigSave.addEventListener('click', function() {
      if (fkEditIdx < 0) return;
      var label = fkConfigLabel.value.trim() || fkKeys[fkEditIdx].label;
      fkKeys[fkEditIdx] = { label: label, action: fkConfigAction.value, chars: fkConfigChars.value };
      fkSave(fkKeys);
      fkConfigEl.style.display = 'none';
      fkRender();
      if (!isMobile) term.focus();
    });
    fkConfigCancel.addEventListener('click', function() {
      fkConfigEl.style.display = 'none';
      if (!isMobile) term.focus();
    });

    fkRender();

    // Reposition floating keys when keyboard appears/disappears
    if (isMobile && window.visualViewport) {
      function repositionFloatKeys() {
        var vv = window.visualViewport;
        var visibleBottom = vv.offsetTop + vv.height;
        var midY = vv.offsetTop + vv.height / 2;
        fkContainer.style.top = midY + 'px';
      }
      window.visualViewport.addEventListener('resize', repositionFloatKeys);
      window.visualViewport.addEventListener('scroll', repositionFloatKeys);
    }

    // --- File Browser ---
    var fbPanel = document.getElementById('file-browser');
    var fbList = document.getElementById('fb-list');
    var fbBreadcrumb = document.getElementById('fb-breadcrumb');
    var fbError = document.getElementById('fb-error');
    var fbTextPreview = document.getElementById('fb-text-preview');
    var fbTextContent = document.getElementById('fb-text-content');
    var fbTextName = document.getElementById('fb-text-name');
    var fbPreview = document.getElementById('fb-preview');
    var fbPreviewImg = document.getElementById('fb-preview-img');
    var fbPreviewName = document.getElementById('fb-preview-name');
    var fbCurrentPath = '/';

    function fbOpen() {
      fbPanel.classList.add('open');
      fbTextPreview.style.display = 'none';
      fbList.style.display = '';
      fbError.style.display = 'none';
      var savedPath = '';
      try { savedPath = localStorage.getItem('hopcode_fb_path_' + sessionId) || ''; } catch {}
      fbLoadDir(savedPath);
    }
    function fbClose() { fbPanel.classList.remove('open'); }

    var fbBackIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#888"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';

    function fbLoadDir(dirPath) {
      var url = '/terminal/files?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(dirPath);
      fbError.style.display = 'none';
      fbList.innerHTML = '<div style="padding:20px;text-align:center;color:#666">Loading...</div>';
      fbTextPreview.style.display = 'none';
      fbList.style.display = '';
      fetch(url, { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.error) {
            if (dirPath) { fbLoadDir(''); return; }
            fbError.textContent = data.error; fbError.style.display = 'block'; fbList.innerHTML = ''; return;
          }
          fbCurrentPath = data.path;
          try { localStorage.setItem('hopcode_fb_path_' + sessionId, data.path); } catch {}
          fbBuildBreadcrumb(data.path);
          var html = '';
          if (data.path !== '/') {
            var parentPath = data.path.replace(/\\/[^\\/]+\\/?$/, '') || '/';
            html += '<div class="fb-item" onclick="fbLoadDir(\\''+fbEsc(parentPath)+'\\')"><span class="fb-icon">'+fbBackIcon+'</span><div class="fb-info"><div class="fb-name">..</div></div></div>';
          }
          data.items.forEach(function(item) {
            var fullPath = data.path === '/' ? '/' + item.name : data.path + '/' + item.name;
            var ep = fbEsc(fullPath);
            if (item.isDirectory) {
              html += '<div class="fb-item" onclick="fbLoadDir(\\''+ep+'\\')"><span class="fb-icon">'+fbGetIcon(item)+'</span><div class="fb-info"><div class="fb-name">'+fbEscHtml(item.name)+'</div><div class="fb-meta">'+fbFormatTime(item.modified)+'</div></div></div>';
            } else {
              var icon = fbGetIcon(item);
              var actions = '<div class="fb-actions"><button class="fb-dl" onclick="event.stopPropagation();fbDownload(\\''+ep+'\\')">&#x2193;</button></div>';
              var click = '';
              if (item.isImage) click = 'fbShowImagePreview(\\''+ep+'\\',\\''+fbEsc(item.name)+'\\')';
              else if (item.isText) click = 'fbShowTextPreview(\\''+ep+'\\',\\''+fbEsc(item.name)+'\\')';
              else click = 'fbDownload(\\''+ep+'\\')';
              html += '<div class="fb-item" onclick="'+click+'"><span class="fb-icon">'+icon+'</span><div class="fb-info"><div class="fb-name">'+fbEscHtml(item.name)+'</div><div class="fb-meta">'+fbFormatSize(item.size)+' &middot; '+fbFormatTime(item.modified)+'</div></div>'+actions+'</div>';
            }
          });
          fbList.innerHTML = html || '<div style="padding:20px;text-align:center;color:#666">Empty directory</div>';
        })
        .catch(function(e) {
          if (dirPath) { fbLoadDir(''); return; }
          fbError.textContent = 'Failed to load: ' + e.message; fbError.style.display = 'block'; fbList.innerHTML = '';
        });
    }

    function fbBuildBreadcrumb(p) {
      var parts = p.split('/').filter(Boolean);
      var html = '<span class="fb-crumb" onclick="fbLoadDir(\\'/\\')">/</span>';
      var acc = '';
      parts.forEach(function(part) {
        acc += '/' + part;
        var ep = fbEsc(acc);
        html += '<span class="fb-sep">&#x203A;</span><span class="fb-crumb" onclick="fbLoadDir(\\''+ep+'\\')">'+fbEscHtml(part)+'</span>';
      });
      fbBreadcrumb.innerHTML = html;
      fbBreadcrumb.scrollLeft = fbBreadcrumb.scrollWidth;
    }

    function fbShowImagePreview(filePath, name) {
      fbPreviewImg.src = '/terminal/preview?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(filePath);
      fbPreviewName.textContent = name;
      fbPreview.classList.add('open');
      fbPreview.onclick = function(e) { if (e.target === fbPreview) fbPreview.classList.remove('open'); };
    }

    function fbShowTextPreview(filePath, name) {
      fbTextName.textContent = name;
      fbTextContent.textContent = 'Loading...';
      fbList.style.display = 'none';
      fbTextPreview.style.display = 'flex';
      document.getElementById('fb-text-dl').onclick = function() { fbDownload(filePath); };
      fetch('/terminal/preview?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(filePath), { credentials: 'include' })
        .then(function(r) { return r.text(); })
        .then(function(text) { fbTextContent.textContent = text; })
        .catch(function(e) { fbTextContent.textContent = 'Error: ' + e.message; });
    }

    function fbDownload(filePath) {
      var a = document.createElement('a');
      a.href = '/terminal/download?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(filePath);
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    function fbGetIcon(item) {
      if (item.isDirectory) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="#60a5fa"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>';
      var name = (item.name || '').toLowerCase();
      if (item.isImage) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="18" height="18" rx="2" fill="#4ade80" opacity="0.3"/><circle cx="8.5" cy="8.5" r="1.5" fill="#4ade80"/><path d="M21 15l-5-5L5 21h14a2 2 0 002-2v-4z" fill="#4ade80"/></svg>';
      if (/\\.(js|ts|tsx|jsx|py|rb|go|rs|java|c|cpp|h|sh|lua|php|swift|kt)$/.test(name)) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#c084fc" opacity="0.3"/><path d="M14 2v6h6" stroke="#c084fc" stroke-width="1.5" fill="none"/><text x="12" y="17" text-anchor="middle" font-size="7" font-family="monospace" fill="#c084fc">&lt;/&gt;</text></svg>';
      if (/\\.(json|yaml|yml|toml|ini|cfg|conf|env|xml)$/.test(name)) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="#fb923c" stroke-width="1.5"/><path d="M12 1v3M12 20v3M4.22 4.22l2.12 2.12M17.66 17.66l2.12 2.12M1 12h3M20 12h3M4.22 19.78l2.12-2.12M17.66 6.34l2.12-2.12" stroke="#fb923c" stroke-width="1.5" stroke-linecap="round"/></svg>';
      if (item.isText) return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#e0e0e0" opacity="0.3"/><path d="M14 2v6h6" stroke="#e0e0e0" stroke-width="1.5" fill="none"/><line x1="8" y1="13" x2="16" y2="13" stroke="#e0e0e0" stroke-width="1" opacity="0.5"/><line x1="8" y1="16" x2="13" y2="16" stroke="#e0e0e0" stroke-width="1" opacity="0.5"/></svg>';
      return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6z" fill="#888" opacity="0.3"/><path d="M14 2v6h6" stroke="#888" stroke-width="1.5" fill="none"/></svg>';
    }

    function fbFormatSize(bytes) {
      if (bytes == null) return '';
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
      if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
      return (bytes / 1073741824).toFixed(1) + ' GB';
    }

    function fbFormatTime(ms) {
      if (!ms) return '';
      var d = new Date(ms);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    }

    function fbEsc(s) { return s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'"); }
    function fbEscHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

    // Wire up buttons
    document.getElementById('files-btn').addEventListener('click', function(e) {
      e.preventDefault();
      fbOpen();
      if (isMobile && xtermTextarea) xtermTextarea.blur();
    });
    document.getElementById('fb-close').addEventListener('click', fbClose);
    document.getElementById('fb-cwd-btn').addEventListener('click', function() { fbLoadDir(''); });
    document.getElementById('fb-text-back').addEventListener('click', function() {
      fbTextPreview.style.display = 'none';
      fbList.style.display = '';
    });
    document.getElementById('fb-preview-close').addEventListener('click', function() { fbPreview.classList.remove('open'); });
    document.getElementById('fb-preview-dl').addEventListener('click', function() {
      var src = fbPreviewImg.src;
      var a = document.createElement('a');
      a.href = src.replace('/terminal/preview', '/terminal/download');
      a.download = '';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    });

    // Right-edge swipe to open file browser
    var fbSwipeStartX = 0, fbSwipeStartY = 0, fbSwiping = false;
    termEl.addEventListener('touchstart', function(e) {
      var touch = e.touches[0];
      if (touch.clientX > window.innerWidth - 20 && !fbPanel.classList.contains('open')) {
        fbSwipeStartX = touch.clientX;
        fbSwipeStartY = touch.clientY;
        fbSwiping = true;
      }
    }, { passive: true });
    termEl.addEventListener('touchmove', function(e) {
      if (!fbSwiping) return;
      var dx = fbSwipeStartX - e.touches[0].clientX;
      var dy = Math.abs(e.touches[0].clientY - fbSwipeStartY);
      if (dx > 50 && dy < 100) {
        fbSwiping = false;
        fbOpen();
      }
    }, { passive: true });
    termEl.addEventListener('touchend', function() { fbSwiping = false; }, { passive: true });

    // Left-edge swipe inside file browser to close
    var fbCloseSwipeStartX = 0, fbCloseSwiping = false;
    fbPanel.addEventListener('touchstart', function(e) {
      var touch = e.touches[0];
      var panelRect = fbPanel.getBoundingClientRect();
      if (touch.clientX - panelRect.left < 20) {
        fbCloseSwipeStartX = touch.clientX;
        fbCloseSwiping = true;
      }
    }, { passive: true });
    fbPanel.addEventListener('touchmove', function(e) {
      if (!fbCloseSwiping) return;
      var dx = e.touches[0].clientX - fbCloseSwipeStartX;
      if (dx > 50) {
        fbCloseSwiping = false;
        fbClose();
      }
    }, { passive: true });
    fbPanel.addEventListener('touchend', function() { fbCloseSwiping = false; }, { passive: true });

    if (!isMobile) term.focus();
    connectVoice();
  </script>
</body>
</html>`;

// Helper: parse cookies
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const idx = c.indexOf('=');
      if (idx > 0) {
        const k = c.substring(0, idx).trim();
        const v = c.substring(idx + 1).trim();
        cookies[k] = v;
      }
    });
  }
  return cookies;
}

// Helper: check auth
function isAuthenticated(req: http.IncomingMessage): boolean {
  const cookies = parseCookies(req.headers.cookie);
  return cookies.auth === AUTH_TOKEN;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data:;");

  // Only log non-routine requests
  if (req.url !== '/health' && !req.url?.startsWith('/terminal?session=')) {
    console.log(`HTTP ${req.method} ${req.url}`);
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  // Handle login POST (accept both direct and proxy-rewritten paths)
  if ((req.url === '/login' || req.url === '/terminal/login') && req.method === 'POST') {
    const clientIp = getClientIp(req);
    if (isRateLimited(clientIp)) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Too many login attempts. Try again later.' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        const { password } = JSON.parse(body);
        if (password === PASSWORD) {
          clearLoginAttempts(clientIp);
          const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted;
          const securePart = isSecure ? ' Secure;' : '';
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `auth=${AUTH_TOKEN}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly;${securePart}`
          });
          res.end(JSON.stringify({ success: true }));
        } else {
          recordFailedLogin(clientIp);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false }));
        }
      } catch {
        res.writeHead(400);
        res.end('Bad request');
      }
    });
    req.resume(); // Ensure data flows even if buffered
    return;
  }

  // Handle session rename POST — proxy to PTY service
  if ((req.url === '/rename' || req.url === '/terminal/rename') && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const { session, name } = JSON.parse(Buffer.concat(chunks).toString());
        const resp = await ptyFetch(`/sessions/${encodeURIComponent(session)}/rename`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        const data = await resp.json();
        res.writeHead(resp.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Bad request' }));
      }
    });
    req.resume();
    return;
  }

  // Check authentication
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.auth !== AUTH_TOKEN) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(loginHtml);
    return;
  }

  // --- Authenticated routes below ---

  // --- File browser API ---
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;

  if ((pathname === '/terminal/files' || pathname === '/files') && req.method === 'GET') {
    try {
      const sid = parsedUrl.searchParams.get('session');
      if (!sid) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }

      let requestedPath = parsedUrl.searchParams.get('path') || '';
      let dirPath: string;
      if (!requestedPath) {
        // Get CWD from PTY service
        try {
          const cwdResp = await ptyFetch(`/sessions/${encodeURIComponent(sid)}/cwd`);
          if (cwdResp.ok) {
            const cwdData = await cwdResp.json() as { cwd: string };
            dirPath = cwdData.cwd;
          } else {
            dirPath = process.env.HOME || '/';
          }
        } catch {
          dirPath = process.env.HOME || '/';
        }
      } else {
        dirPath = resolveSafePath(requestedPath);
      }

      // Get CWD for response (may differ from dirPath)
      let sessionCwd = dirPath;
      if (requestedPath) {
        try {
          const cwdResp = await ptyFetch(`/sessions/${encodeURIComponent(sid)}/cwd`);
          if (cwdResp.ok) {
            const cwdData = await cwdResp.json() as { cwd: string };
            sessionCwd = cwdData.cwd;
          }
        } catch {}
      }

      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const items: any[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        let stat;
        try { stat = await fs.promises.stat(fullPath); } catch { continue; }
        items.push({
          name: entry.name,
          isDirectory: entry.isDirectory(),
          size: entry.isDirectory() ? null : stat.size,
          modified: stat.mtimeMs,
          isImage: !entry.isDirectory() && isPreviewableImage(entry.name),
          isText: !entry.isDirectory() && isTextFile(entry.name),
        });
      }
      // Sort: directories first, then alphabetical
      items.sort((a: any, b: any) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: dirPath, cwd: sessionCwd, items }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Failed to list directory' }));
    }
    return;
  }

  if ((pathname === '/terminal/download' || pathname === '/download') && req.method === 'GET') {
    try {
      const requestedPath = parsedUrl.searchParams.get('path') || '';
      if (!requestedPath) { res.writeHead(400); res.end('Path required'); return; }
      const filePath = resolveSafePath(requestedPath);

      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) { res.writeHead(400); res.end('Cannot download directory'); return; }

      const mime = getMimeType(filePath);
      const fileName = path.basename(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': 'attachment; filename="' + fileName.replace(/"/g, '\\"') + '"',
        'Content-Length': stat.size.toString(),
      });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
      stream.on('error', () => { try { res.end(); } catch {} });
    } catch (e: any) {
      res.writeHead(500); res.end(e.message || 'Download failed');
    }
    return;
  }

  if ((pathname === '/terminal/preview' || pathname === '/preview') && req.method === 'GET') {
    try {
      const requestedPath = parsedUrl.searchParams.get('path') || '';
      if (!requestedPath) { res.writeHead(400); res.end('Path required'); return; }
      const filePath = resolveSafePath(requestedPath);

      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) { res.writeHead(400); res.end('Cannot preview directory'); return; }

      const mime = getMimeType(filePath);
      const fileName = path.basename(filePath);

      if (isTextFile(filePath)) {
        // Text preview: limit to 1MB
        const MAX_TEXT = 1024 * 1024;
        if (stat.size > MAX_TEXT) {
          // Read first 1MB
          const fd = await fs.promises.open(filePath, 'r');
          const buf = Buffer.alloc(MAX_TEXT);
          await fd.read(buf, 0, MAX_TEXT, 0);
          await fd.close();
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="' + fileName.replace(/"/g, '\\"') + '"',
          });
          res.end(buf.toString('utf-8') + '\n\n--- truncated at 1MB ---');
        } else {
          res.writeHead(200, {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'inline; filename="' + fileName.replace(/"/g, '\\"') + '"',
          });
          const stream = fs.createReadStream(filePath);
          stream.pipe(res);
          stream.on('error', () => { try { res.end(); } catch {} });
        }
      } else {
        // Binary preview (images etc)
        res.writeHead(200, {
          'Content-Type': mime,
          'Content-Disposition': 'inline; filename="' + fileName.replace(/"/g, '\\"') + '"',
          'Content-Length': stat.size.toString(),
        });
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('error', () => { try { res.end(); } catch {} });
      }
    } catch (e: any) {
      res.writeHead(500); res.end(e.message || 'Preview failed');
    }
    return;
  }

  // --- Clipboard image upload ---
  if ((pathname === '/terminal/upload' || pathname === '/upload') && req.method === 'POST') {
    const UPLOAD_DIR = '/tmp/hopcode-clipboard';
    const contentType = req.headers['content-type'] || 'image/png';
    const extMap: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
      'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
    };
    const ext = extMap[contentType] || 'png';
    const fileName = `img-${Date.now()}.${ext}`;
    const filePath = path.join(UPLOAD_DIR, fileName);

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        await fs.promises.mkdir(UPLOAD_DIR, { recursive: true });
        await fs.promises.writeFile(filePath, Buffer.concat(chunks));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ path: filePath }));
      } catch (e: any) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Upload failed' }));
      }
    });
    req.resume();
    return;
  }

  // Everything goes through /terminal so the reverse proxy forwards it
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const action = url.searchParams.get('action');
  const sessionId = url.searchParams.get('session');

  // Create new session: /terminal?action=new — proxy to PTY service
  if (action === 'new') {
    const id = 'sess_' + randomBytes(12).toString('hex');
    try {
      await ptyFetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
    } catch (e) {
      console.error('Failed to create session via PTY service:', e);
    }
    res.writeHead(302, { 'Location': '/terminal?session=' + encodeURIComponent(id) });
    res.end();
    return;
  }

  // Terminal page: /terminal?session=xxx
  if (sessionId) {
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(indexHtml);
    return;
  }

  // Session chooser (default for /terminal with no params, or any other path)
  res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
  res.end(await buildSessionsHtml());
});

// Terminal WebSocket server — proxies to PTY service
const terminalWss = new WebSocketServer({ noServer: true });
terminalWss.on('connection', (clientWs: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';

  // Connect to PTY service WebSocket
  const ptyWsUrl = `ws://127.0.0.1:${PTY_SERVICE_PORT}/ws/${encodeURIComponent(sessionId)}`;
  const ptyWs = new WebSocket(ptyWsUrl, {
    headers: { [PTY_INTERNAL_TOKEN_HEADER]: PTY_INTERNAL_TOKEN },
  });

  let ptyReady = false;
  const pendingMessages: (string | Buffer)[] = [];

  ptyWs.on('open', () => {
    ptyReady = true;
    // Flush pending messages
    for (const msg of pendingMessages) {
      ptyWs.send(msg);
    }
    pendingMessages.length = 0;
    console.log(`Terminal proxy connected: ${sessionId}`);
  });

  // PTY service -> browser: transparent forward (preserve text/binary frame type)
  ptyWs.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  // Browser -> PTY service: transparent forward
  clientWs.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (ptyReady && ptyWs.readyState === WebSocket.OPEN) {
      ptyWs.send(data, { binary: isBinary });
    } else {
      pendingMessages.push(data);
    }
  });

  // Close handling
  clientWs.on('close', () => {
    console.log(`Terminal proxy client disconnected: ${sessionId}`);
    if (ptyWs.readyState === WebSocket.OPEN || ptyWs.readyState === WebSocket.CONNECTING) {
      ptyWs.close();
    }
  });

  ptyWs.on('close', () => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  ptyWs.on('error', (err) => {
    console.error(`PTY proxy error for ${sessionId}:`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  clientWs.on('error', (err) => {
    console.error(`Client proxy error for ${sessionId}:`, err.message);
    if (ptyWs.readyState === WebSocket.OPEN) {
      ptyWs.close();
    }
  });
});

// Voice WebSocket server - streaming ASR
const voiceWss = new WebSocketServer({ noServer: true });
voiceWss.on('connection', (ws) => {
  const id = Math.random().toString(36).substring(7);
  voiceClients.set(id, ws);
  console.log(`Voice client connected: ${id}`);

  let asrSession: AsrSession | null = null;

  ws.on('message', (message) => {
    try {
      // Detect JSON control messages: must be a string type, or a short Buffer starting with '{'
      const isJson = typeof message === 'string' ||
        (message instanceof Buffer && message.length < 512 && message[0] === 0x7b);
      if (isJson) {
        const msg = JSON.parse(message.toString());
        if (msg.type === 'asr_start') {
          // Start a new streaming ASR session
          if (asrSession?.volcanoWs) {
            try { asrSession.volcanoWs.close(); } catch {}
          }
          asrSession = startAsrSession(ws);
          console.log(`ASR streaming started for ${id}`);
        } else if (msg.type === 'asr_end') {
          // Send empty final chunk to signal end of audio
          if (asrSession) {
            asrSession.ended = true;
            if (asrSession.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
              asrSession.volcanoWs.send(buildAudioRequest(Buffer.alloc(0), true));
              console.log(`ASR streaming ended for ${id}`);
            } else {
              // Volcano not ready yet - mark pending end so it's sent after flush
              asrSession.pendingChunks.push(Buffer.alloc(0)); // sentinel for final
              console.log(`ASR end queued (Volcano not ready yet) for ${id}`);
            }
          }
        }
      } else if (message instanceof Buffer) {
        // Binary = raw PCM audio chunk, forward to Volcano
        if (asrSession) {
          const chunk = Buffer.from(message);
          asrSession.allChunks.push(chunk);
          if (asrSession.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
            asrSession.volcanoWs.send(buildAudioRequest(chunk, false));
          } else {
            // Buffer chunks while Volcano WebSocket is still connecting
            asrSession.pendingChunks.push(chunk);
          }
        }
      }
    } catch (e) {
      // Don't let parse errors kill the voice connection
      console.error(`Voice message error for ${id}:`, (e as Error).message);
    }
  });

  ws.on('close', () => {
    if (asrSession?.volcanoWs) {
      try { asrSession.volcanoWs.close(); } catch {}
    }
    voiceClients.delete(id);
    console.log(`Voice client disconnected: ${id}`);
  });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  // Verify authentication before allowing WebSocket upgrade
  if (!isAuthenticated(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  const url = new URL(request.url!, `http://${request.headers.host}`);

  // Accept both direct paths and proxy-rewritten paths:
  // Direct: /terminal/ws, /terminal/ws-voice
  // Via proxy (strips /terminal): /ws, /ws-voice
  // Legacy: /ws/terminal, /ws/voice
  const p = url.pathname;
  if (p === '/ws' || p === '/terminal/ws' || p === '/ws/terminal') {
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
  } else if (p === '/ws-voice' || p === '/terminal/ws-voice' || p === '/ws/voice') {
    voiceWss.handleUpgrade(request, socket, head, (ws) => {
      voiceWss.emit('connection', ws, request);
    });
  } else {
    socket.destroy();
  }
});

// Start
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════════════╗
║               hopcode                           ║
╠════════════════════════════════════════════════╣
║  Web UI:    http://localhost:${PORT}              ║
║  Terminal:  ws://localhost:${PORT}/ws/terminal    ║
║  Voice:     ws://localhost:${PORT}/ws/voice       ║
╚════════════════════════════════════════════════╝

=== Server ready ===
`);

  // Start Cloudflare Tunnel if requested via --tunnel flag or CLOUDFLARE_TUNNEL env
  const wantTunnel = process.argv.includes('--tunnel') || process.env.CLOUDFLARE_TUNNEL === '1';
  if (wantTunnel) {
    startCloudflareTunnel();
  }
});

function startCloudflareTunnel() {
  const tunnelProc = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let tunnelUrl = '';

  function parseLine(line: string) {
    // cloudflared prints the URL like: "https://xxx-yyy-zzz.trycloudflare.com"
    const match = line.match(/(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/);
    if (match && !tunnelUrl) {
      tunnelUrl = match[1]!;
      console.log(`
╔════════════════════════════════════════════════╗
║         Cloudflare Tunnel Active              ║
╠════════════════════════════════════════════════╣
║  Public URL: ${tunnelUrl}
╚════════════════════════════════════════════════╝
`);
    }
  }

  tunnelProc.stdout.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(parseLine);
  });
  tunnelProc.stderr.on('data', (data: Buffer) => {
    data.toString().split('\n').forEach(parseLine);
  });

  tunnelProc.on('error', (err) => {
    console.error('Failed to start cloudflared:', err.message);
    console.error('Install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/');
  });

  tunnelProc.on('exit', (code) => {
    console.error(`cloudflared exited with code ${code}`);
  });

  // Clean up tunnel on server exit
  process.on('SIGINT', () => { tunnelProc.kill(); process.exit(); });
  process.on('SIGTERM', () => { tunnelProc.kill(); process.exit(); });
}

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
import { spawn, execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as zlib from 'zlib';
import { fileURLToPath } from 'url';
import { randomUUID, randomBytes, createHmac } from 'crypto';

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
const LEGACY_AUTH_TOKEN = 'hopcode_auth_' + Buffer.from(PASSWORD).toString('base64');

// --- Multi-user support ---
interface UserConfig {
  password: string;
  linuxUser: string;
}

let usersConfig: Record<string, UserConfig> = {};
let isMultiUser = false;

function loadUsersConfig(): void {
  const usersPath = path.join(__dirname, '..', 'users.json');
  try {
    const data = fs.readFileSync(usersPath, 'utf-8');
    usersConfig = JSON.parse(data);
    isMultiUser = Object.keys(usersConfig).length > 0;
    if (isMultiUser) {
      console.log(`[auth] Multi-user mode: ${Object.keys(usersConfig).length} user(s) loaded from users.json`);
    }
  } catch {
    usersConfig = {};
    isMultiUser = false;
    console.log('[auth] Single-user mode (no users.json found)');
  }
}
loadUsersConfig();

function makeAuthToken(username: string): string {
  const hmac = createHmac('sha256', PASSWORD!).update(username).digest('hex');
  return `${username}:${hmac}`;
}

function verifyAuthToken(token: string): string | null {
  const colonIdx = token.indexOf(':');
  if (colonIdx < 1) return null;
  const username = token.substring(0, colonIdx);
  const expected = makeAuthToken(username);
  // Constant-time compare
  if (token.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0 ? username : null;
}

interface AuthInfo {
  authenticated: boolean;
  username: string;
  linuxUser: string;
}

function getAuthInfo(req: http.IncomingMessage): AuthInfo {
  const cookies = parseCookies(req.headers.cookie);
  const authCookie = cookies.auth || '';

  if (isMultiUser) {
    // Multi-user: verify HMAC token → extract username
    const username = verifyAuthToken(authCookie);
    if (username && usersConfig[username]) {
      return { authenticated: true, username, linuxUser: usersConfig[username]!.linuxUser };
    }
    return { authenticated: false, username: '', linuxUser: '' };
  } else {
    // Single-user: accept legacy token or new HMAC token
    if (authCookie === LEGACY_AUTH_TOKEN) {
      return { authenticated: true, username: 'admin', linuxUser: '' };
    }
    const username = verifyAuthToken(authCookie);
    if (username === 'admin') {
      return { authenticated: true, username: 'admin', linuxUser: '' };
    }
    return { authenticated: false, username: '', linuxUser: '' };
  }
}

// --- File permission checking for multi-user mode ---

interface UserPosixInfo {
  uid: number;
  gid: number;
  groups: number[];
}

const userPosixCache = new Map<string, UserPosixInfo>();

function getUserPosixInfo(linuxUser: string): UserPosixInfo | null {
  const cached = userPosixCache.get(linuxUser);
  if (cached) return cached;
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf-8');
    let uid = -1, gid = -1;
    for (const line of passwd.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === linuxUser) {
        uid = parseInt(parts[2]!);
        gid = parseInt(parts[3]!);
        break;
      }
    }
    if (uid < 0) return null;
    // Get supplementary groups
    let groups: number[] = [gid];
    try {
      const out = execFileSync('id', ['-G', linuxUser], { timeout: 2000 }).toString().trim();
      groups = out.split(/\s+/).map(Number).filter(n => !isNaN(n));
    } catch {}
    const info = { uid, gid, groups };
    userPosixCache.set(linuxUser, info);
    return info;
  } catch {
    return null;
  }
}

// Check Unix file permissions for a given user (owner/group/other + supplementary groups)
function checkPosixAccess(stat: fs.Stats, user: UserPosixInfo, mode: 'read' | 'write' | 'execute' | 'read+execute'): boolean {
  if (user.uid === 0) return true; // root bypasses all
  const bits = stat.mode;
  const checks = mode === 'read' ? [4] : mode === 'write' ? [2] : mode === 'execute' ? [1] : [4, 1];

  for (const bit of checks) {
    let allowed = false;
    if (stat.uid === user.uid) {
      allowed = (bits & (bit << 6)) !== 0;
    } else if (user.groups.includes(stat.gid)) {
      allowed = (bits & (bit << 3)) !== 0;
    } else {
      allowed = (bits & bit) !== 0;
    }
    if (!allowed) return false;
  }
  return true;
}

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
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.clone().text().catch(() => '');
    console.error(`[ptyFetch] ${options?.method || 'GET'} ${urlPath} → ${resp.status}: ${body}`);
  }
  return resp;
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

// Login page HTML — dynamic to support multi-user mode
function getLoginHtml(): string {
  const usernameField = isMultiUser
    ? `<input type="text" id="username" placeholder="Username" autofocus autocomplete="username" autocapitalize="off">`
    : '';
  const passwordAutofocus = isMultiUser ? '' : ' autofocus';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hopcode">
  <link rel="manifest" href="./manifest.json">
  <link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
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
      ${usernameField}
      <input type="password" id="password" placeholder="Password"${passwordAutofocus}>
      <button type="submit">Login</button>
    </form>
  </div>
  <script>
    function login() {
      var body = { password: document.getElementById('password').value };
      var uEl = document.getElementById('username');
      if (uEl) body.username = uEl.value;
      fetch('/terminal/login', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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
  <script>if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');</script>
</body>
</html>`;
}

// Session chooser HTML page - generated dynamically with server-side rendering
async function buildSessionsHtml(username?: string): Promise<string> {
  const isRoot = username === 'root';
  let sessionList: { id: string; name: string; owner: string; createdAt: number; lastActivity: number; clients: number }[] = [];
  try {
    // Root sees all sessions; other users see only their own
    const ownerQuery = isMultiUser && username && !isRoot ? `?owner=${encodeURIComponent(username)}` : '';
    const resp = await ptyFetch('/sessions' + ownerQuery);
    if (resp.ok) {
      const list: SessionInfo[] = await resp.json() as SessionInfo[];
      sessionList = list.map(s => ({ id: s.id, name: s.name, owner: s.owner, createdAt: s.createdAt, lastActivity: s.lastActivity, clients: s.clientCount }));
    }
  } catch {}
  sessionList.sort((a, b) => b.lastActivity - a.lastActivity);

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

  function renderCard(s: typeof sessionList[0]): string {
    const isActive = s.clients > 0;
    const barClass = isActive ? 'bar-active' : 'bar-idle';
    return `<a class="session-card" href="/terminal?session=${encodeURIComponent(s.id)}" data-session-id="${esc(s.id)}">
      <div class="card-bar ${barClass}"></div>
      <div class="session-info">
        <div class="session-name" data-session="${esc(s.id)}"><span class="session-name-text">${esc(s.name)}</span></div>
        <div class="session-meta">${fmtAge(s.lastActivity)}</div>
      </div>
      <button class="rename-btn" title="Rename session">&#9998;</button>
      <button class="delete-btn" title="Delete session">&times;</button>
    </a>`;
  }

  let cardsHtml = '';
  if (sessionList.length === 0) {
    cardsHtml = '<div class="empty-state"><p>No active sessions</p><p class="empty-sub">Create one to get started</p></div>';
  } else if (isRoot) {
    // Group by owner, root's own sessions first
    const groups = new Map<string, typeof sessionList>();
    for (const s of sessionList) {
      const arr = groups.get(s.owner) || [];
      arr.push(s);
      groups.set(s.owner, arr);
    }
    const sortedOwners = Array.from(groups.keys()).sort((a, b) => {
      if (a === 'root') return -1;
      if (b === 'root') return 1;
      return a.localeCompare(b);
    });
    for (const owner of sortedOwners) {
      const initial = owner.charAt(0).toUpperCase();
      const count = groups.get(owner)!.length;
      cardsHtml += `<div class="group-section">
        <div class="group-header" data-owner="${esc(owner)}">
          <div class="group-left">
            <span class="avatar">${initial}</span>
            <span class="group-name">${esc(owner)}</span>
            <span class="group-count">${count}</span>
          </div>
          <span class="group-chevron">&#9662;</span>
        </div>
        <div class="group-body">`;
      for (const s of groups.get(owner)!) cardsHtml += renderCard(s);
      cardsHtml += `</div></div>`;
    }
  } else {
    for (const s of sessionList) cardsHtml += renderCard(s);
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#111827">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hopcode">
  <link rel="manifest" href="./manifest.json">
  <link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
  <title>Hopcode - Sessions</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { min-height: 100%; background: #111827; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: #e5e7eb; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px 16px; }

    /* Header */
    .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
    .header-left { display: flex; align-items: center; gap: 10px; }
    .header-left h1 { color: #4ade80; font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
    .header-right { display: flex; align-items: center; gap: 8px; }
    .user-info { color: #6b7280; font-size: 12px; }
    .new-btn {
      padding: 6px 14px; background: #4ade80; color: #000; border: none;
      border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer;
      text-decoration: none; display: inline-block;
      -webkit-tap-highlight-color: transparent; transition: background 0.15s;
    }
    .new-btn:hover { background: #22c55e; }
    .logout-btn { color: #6b7280; font-size: 12px; text-decoration: none; padding: 4px 8px; border-radius: 6px; transition: all 0.15s; }
    .logout-btn:hover { color: #f87171; background: rgba(248,113,113,0.1); }

    /* Session list */
    .session-list { display: flex; flex-direction: column; gap: 6px; }

    /* Card */
    .session-card {
      display: flex; align-items: center; gap: 0;
      background: #1f2937; border-radius: 10px;
      text-decoration: none; color: inherit;
      transition: background 0.15s, transform 0.1s;
      -webkit-tap-highlight-color: transparent;
      position: relative; overflow: hidden;
    }
    .session-card:hover { background: #273548; }
    .session-card:active { transform: scale(0.985); }
    .card-bar { width: 4px; align-self: stretch; border-radius: 4px 0 0 4px; flex-shrink: 0; }
    .bar-active { background: #4ade80; }
    .bar-idle { background: #374151; }
    .session-info { flex: 1; min-width: 0; padding: 14px 12px; }
    .session-name { display: flex; align-items: center; }
    .session-name-text { font-size: 15px; font-weight: 600; color: #f3f4f6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { font-size: 12px; color: #6b7280; margin-top: 2px; }

    /* Card action buttons */
    .rename-btn, .delete-btn {
      background: none; border: none; color: #6b7280; line-height: 1;
      cursor: pointer; flex-shrink: 0;
      transition: opacity 0.15s, color 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .rename-btn { font-size: 16px; padding: 14px 4px 14px 8px; }
    .delete-btn { font-size: 20px; padding: 14px 14px 14px 4px; }
    .rename-btn:hover { color: #4ade80; }
    .delete-btn:hover { color: #f87171; }

    /* Rename input */
    .session-name-input {
      background: #111827; color: #f3f4f6; border: 1px solid #4ade80; border-radius: 4px;
      font-size: 15px; font-weight: 600; font-family: inherit; padding: 2px 6px;
      width: 100%; outline: none;
    }

    /* Group sections (root view) */
    .group-section { margin-bottom: 4px; }
    .group-header {
      display: flex; justify-content: space-between; align-items: center;
      padding: 10px 8px 6px; cursor: pointer;
      -webkit-tap-highlight-color: transparent; user-select: none;
    }
    .group-left { display: flex; align-items: center; gap: 8px; }
    .avatar {
      width: 26px; height: 26px; border-radius: 50%; background: #374151;
      display: flex; align-items: center; justify-content: center;
      font-size: 12px; font-weight: 700; color: #9ca3af; flex-shrink: 0;
    }
    .group-name { font-size: 13px; font-weight: 600; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.5px; }
    .group-count { font-size: 11px; color: #6b7280; background: #1f2937; padding: 1px 6px; border-radius: 8px; }
    .group-chevron { color: #6b7280; font-size: 12px; transition: transform 0.2s; padding: 0 4px; }
    .group-header.collapsed .group-chevron { transform: rotate(-90deg); }
    .group-body { display: flex; flex-direction: column; gap: 6px; }
    .group-body.collapsed { display: none; }

    /* Empty state */
    .empty-state { text-align: center; padding: 60px 20px; }
    .empty-state p { font-size: 16px; color: #6b7280; }
    .empty-sub { font-size: 13px; color: #4b5563; margin-top: 6px; }

    /* Delete confirm overlay */
    .confirm-overlay {
      position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 1000;
      background: rgba(0,0,0,0.5); display: flex; align-items: center; justify-content: center;
      animation: fadeIn 0.15s ease;
    }
    @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
    .confirm-box {
      background: #1f2937; border: 1px solid #374151; border-radius: 12px;
      padding: 20px; max-width: 320px; width: calc(100% - 40px); text-align: center;
    }
    .confirm-box p { font-size: 14px; color: #d1d5db; margin-bottom: 16px; }
    .confirm-box .confirm-name { color: #f3f4f6; font-weight: 600; }
    .confirm-btns { display: flex; gap: 10px; }
    .confirm-btns button {
      flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 14px;
      font-weight: 600; cursor: pointer; font-family: inherit;
    }
    .btn-cancel { background: #374151; color: #d1d5db; }
    .btn-cancel:hover { background: #4b5563; }
    .btn-delete { background: #dc2626; color: #fff; }
    .btn-delete:hover { background: #ef4444; }

    /* Swipe-to-delete (mobile) */
    .session-card.swiping { transition: none; }
    .session-card .swipe-bg {
      position: absolute; top: 0; right: 0; bottom: 0; width: 80px;
      background: #dc2626; display: flex; align-items: center; justify-content: center;
      color: #fff; font-size: 13px; font-weight: 600;
      opacity: 0; transition: opacity 0.15s; border-radius: 0 10px 10px 0;
    }
    .session-card.swiped .swipe-bg { opacity: 1; }

    /* Mobile */
    @media (max-width: 500px) {
      .container { padding: 14px 12px; }
      .header-left h1 { font-size: 18px; }
      .session-info { padding: 12px 10px; }
      .session-name-text { font-size: 14px; }
      .new-btn { padding: 6px 12px; font-size: 12px; }
      .delete-btn { opacity: 0.7; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-left">
        <h1>Hopcode</h1>
      </div>
      <div class="header-right">
        ${isMultiUser && username ? `<span class="user-info">${esc(username)}</span>` : ''}
        <a class="new-btn" href="/terminal?action=new">+ New</a>
        <a class="logout-btn" href="/terminal/logout">Logout</a>
      </div>
    </div>
    <div class="session-list">${cardsHtml}</div>
  </div>

  <script>
  (function() {
    // --- Double-click to rename ---
    function startRename(nameEl) {
      if (nameEl.querySelector('input')) return;
      var textSpan = nameEl.querySelector('.session-name-text');
      var name = textSpan ? textSpan.textContent : '';
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
      }
      function save() {
        var newName = input.value.trim();
        if (!newName || newName === name) { restore(name); return; }
        fetch('/terminal/rename', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sessionId, name: newName })
        }).then(function(r) { return r.json(); }).then(function(d) {
          restore(d.success ? newName : name);
        }).catch(function() { restore(name); });
      }
      var done = false;
      input.addEventListener('click', function(ev) { ev.preventDefault(); ev.stopPropagation(); });
      input.addEventListener('keydown', function(ev) {
        if (ev.key === 'Enter') { ev.preventDefault(); if (!done) { done = true; save(); } }
        if (ev.key === 'Escape') { ev.preventDefault(); if (!done) { done = true; restore(name); } }
      });
      input.addEventListener('blur', function() { if (!done) { done = true; save(); } });
    }

    // --- Delete confirmation ---
    function confirmDelete(sessionId, sessionName, cardEl) {
      var overlay = document.createElement('div');
      overlay.className = 'confirm-overlay';
      overlay.innerHTML = '<div class="confirm-box">' +
        '<p>Delete <span class="confirm-name">' + sessionName.replace(/</g,'&lt;') + '</span>?</p>' +
        '<div class="confirm-btns">' +
        '<button class="btn-cancel">Cancel</button>' +
        '<button class="btn-delete">Delete</button>' +
        '</div></div>';
      document.body.appendChild(overlay);
      overlay.querySelector('.btn-cancel').onclick = function() { overlay.remove(); };
      overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
      overlay.querySelector('.btn-delete').onclick = function() {
        fetch('/terminal/sessions/' + encodeURIComponent(sessionId), {
          method: 'DELETE', credentials: 'include'
        }).then(function(r) { return r.json(); }).then(function(d) {
          overlay.remove();
          if (d.success) {
            cardEl.style.transition = 'opacity 0.2s, transform 0.2s';
            cardEl.style.opacity = '0';
            cardEl.style.transform = 'translateX(40px)';
            setTimeout(function() { cardEl.remove(); }, 200);
          }
        }).catch(function() { overlay.remove(); });
      };
    }

    // --- Group collapse ---
    document.querySelectorAll('.group-header').forEach(function(hdr) {
      hdr.addEventListener('click', function() {
        hdr.classList.toggle('collapsed');
        var body = hdr.nextElementSibling;
        if (body) body.classList.toggle('collapsed');
      });
    });

    // --- Card events ---
    document.querySelectorAll('.session-card').forEach(function(card) {
      var dblClickTimer = null;
      var clickCount = 0;

      // Double-click on name to rename
      card.addEventListener('click', function(e) {
        var target = e.target;
        // Rename button
        if (target.classList.contains('rename-btn')) {
          e.preventDefault();
          e.stopPropagation();
          var nameEl = card.querySelector('.session-name');
          if (nameEl) startRename(nameEl);
          return;
        }
        // Delete button
        if (target.classList.contains('delete-btn')) {
          e.preventDefault();
          e.stopPropagation();
          var nameSpan = card.querySelector('.session-name-text');
          confirmDelete(card.getAttribute('data-session-id'), nameSpan ? nameSpan.textContent : '', card);
          return;
        }
        // Input inside rename
        if (target.classList.contains('session-name-input')) {
          e.preventDefault();
          return;
        }
        // Double-click on name area to rename
        var nameEl = card.querySelector('.session-name');
        if (nameEl && nameEl.contains(target)) {
          clickCount++;
          if (clickCount === 1) {
            e.preventDefault();
            dblClickTimer = setTimeout(function() {
              clickCount = 0;
              // Single click — navigate
              window.location.href = card.getAttribute('href');
            }, 250);
          } else if (clickCount === 2) {
            e.preventDefault();
            clearTimeout(dblClickTimer);
            clickCount = 0;
            startRename(nameEl);
          }
          return;
        }
      });

      // Mobile swipe-to-delete
      var startX = 0, currentX = 0, swiping = false;
      card.addEventListener('touchstart', function(e) {
        if (e.target.classList.contains('session-name-input')) return;
        startX = e.touches[0].clientX;
        currentX = startX;
        swiping = false;
      }, { passive: true });
      card.addEventListener('touchmove', function(e) {
        currentX = e.touches[0].clientX;
        var dx = startX - currentX;
        if (dx > 15) {
          swiping = true;
          card.classList.add('swiping');
          var offset = Math.min(dx, 80);
          card.style.transform = 'translateX(-' + offset + 'px)';
          if (dx > 60) card.classList.add('swiped');
          else card.classList.remove('swiped');
        }
      }, { passive: true });
      card.addEventListener('touchend', function(e) {
        if (!swiping) return;
        var dx = startX - currentX;
        card.classList.remove('swiping', 'swiped');
        card.style.transform = '';
        if (dx > 60) {
          var nameSpan = card.querySelector('.session-name-text');
          confirmDelete(card.getAttribute('data-session-id'), nameSpan ? nameSpan.textContent : '', card);
        }
      });
    });
  })();
  </script>
  <script>if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');</script>
</body>
</html>`;
  return html;
}

// Terminal HTML page
const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hopcode">
  <link rel="manifest" href="./manifest.json">
  <link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
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
    #app-menu { position:fixed;top:0;left:0;right:0;bottom:0;z-index:600; }
    .app-menu-backdrop { position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.5); }
    .app-menu-panel {
      position:absolute;bottom:80px;left:8px;background:#16213e;border:2px solid #0f3460;
      border-radius:12px;padding:6px 0;min-width:220px;max-width:300px;z-index:1;
      max-height:calc(100vh - 120px);overflow-y:auto;
    }
    .app-menu-item {
      display:flex;align-items:center;gap:10px;padding:12px 16px;color:#e0e0e0;font-size:14px;
      font-family:system-ui;cursor:pointer;text-decoration:none;
    }
    .app-menu-item:hover,.app-menu-item:active { background:rgba(255,255,255,0.06); }
    .app-menu-sep { height:1px;background:#0f3460;margin:4px 12px; }
    .app-menu-section { font-size:11px;color:#888;text-transform:uppercase;letter-spacing:0.5px;padding:8px 16px 2px; }
    .app-menu-row { display:flex;align-items:center; }
    .app-menu-btn {
      padding:6px 12px;background:#0f3460;color:#e0e0e0;border:none;border-radius:6px;
      font-size:13px;cursor:pointer;font-family:system-ui;
    }
    .app-menu-btn:active { background:#4ade80;color:#000; }
    .app-menu-fk-chip {
      display:flex;align-items:center;gap:4px;padding:4px 8px;background:#0f3460;border-radius:6px;
      font-size:13px;color:#e0e0e0;cursor:pointer;
    }
    .app-menu-fk-chip:active { background:#333; }
    .app-menu-fk-chip .fk-remove {
      color:#f87171;font-size:16px;line-height:1;cursor:pointer;margin-left:2px;
    }
    .app-menu-fk-chip.fk-dragging { opacity:0.4; }
    .app-menu-fk-chip .fk-grip { color:#555;font-size:14px;cursor:grab;margin-right:2px;-webkit-tap-highlight-color:transparent;touch-action:none; }
    .fk-drop-indicator { height:2px;background:#4ade80;border-radius:1px;margin:0 8px; }
    body.light-mode .app-menu-section { color:#999; }
    body.light-mode .app-menu-btn { background:#ddd;color:#333; }
    body.light-mode .app-menu-fk-chip { background:#ddd;color:#333; }
    body.light-mode { background:#f5f5f5; }
    body.light-mode #terminal { filter: invert(1) hue-rotate(180deg); }
    body.light-mode #voice-bar { background:rgba(240,240,240,0.95);border-top-color:#ccc; }
    body.light-mode .key-btn { background:#c8c8c8;color:#111; }
    body.light-mode .key-btn:active { background:#4ade80;color:#000; }
    body.light-mode #status { background:#c8c8c8;color:#111; }
    body.light-mode #status.recording { background:#4ade80;color:#000; }
    body.light-mode .font-btn { background:#c8c8c8;color:#111; }
    body.light-mode .font-btn:hover { background:#bbb; }
    body.light-mode .app-menu-panel { background:#fff;border-color:#ddd; }
    body.light-mode .app-menu-item { color:#333; }
    body.light-mode .app-menu-item:hover { background:rgba(0,0,0,0.05); }
    body.light-mode .app-menu-sep { background:#eee; }
    .key-btn { background: #333; border: none; color: #fff; min-width: 40px; height: 36px; border-radius: 6px; cursor: pointer; font-size: 14px; font-family: system-ui; -webkit-tap-highlight-color: transparent; flex-shrink: 0; padding: 0 8px; }
    .key-btn:active { background: #4ade80; color: #000; }
    #special-keys { display: none; align-items: center; gap: 4px; flex: 1; }
    #bar-row1 { display: contents; }
    #bar-row2 { display: contents; }
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
    .fk-hidden .float-key { display: none !important; }
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
    body.mobile .key-btn { min-width: 0; flex: 1; padding: 0 4px; height: 34px; font-size: 14px; }
    .mobile-only { display: none; }
    body.mobile .mobile-only { display: inline-block; }
    body.mobile #menu-btn { display: none; }
    body.mobile #menu-btn-mobile { font-size: 16px; min-width: 32px; }
    #voice-bar { transition: transform 0.3s ease, max-height 0.3s ease, padding 0.3s ease, border-width 0.3s ease; overflow: hidden; }
    #voice-bar.collapsed { transform: translateX(calc(100% + 2px)); max-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; border-top-width: 0 !important; }
    #bar-handle {
      display: none; width: 42px; height: 42px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.45);
      background: rgba(22,33,62,0.6); color: rgba(74,222,128,0.85); font-size: 16px; font-weight: 600;
      font-family: system-ui; cursor: pointer; align-items: center; justify-content: center;
      -webkit-tap-highlight-color: transparent; pointer-events: auto;
      margin-top: 12px;
    }
    #bar-handle:active { background: rgba(74,222,128,0.8); color: #000; border-color: rgba(74,222,128,0.8); }
    #bar-handle.visible { display: flex; }
    @supports (padding-top: env(safe-area-inset-top)) {
      #container { padding-top: env(safe-area-inset-top); }
      #voice-bar { padding-bottom: max(10px, env(safe-area-inset-bottom)); }
    }
    /* --- File Browser --- */
    #file-browser {
      position: fixed; top: 0; right: -100%; width: 100%; max-width: 480px; height: 100%;
      background: #1a1a2e; z-index: 300; display: flex; flex-direction: column;
      transition: right 0.25s ease; border-left: 2px solid #0f3460;
      font-family: system-ui; color: #e0e0e0;
    }
    #file-browser.open { right: 0; }
    #fb-drop-overlay {
      display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(74, 222, 128, 0.15); z-index: 10;
      flex-direction: column; align-items: center; justify-content: center;
      font-size: 18px; font-weight: 600; color: #4ade80;
      border: 3px dashed #4ade80; border-radius: 8px; margin: 4px;
      pointer-events: none;
    }
    #fb-drop-overlay.visible { display: flex; }
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

  </style>
</head>
<body>
  <div id="container">
    <div id="terminal"></div>
    <textarea id="copy-overlay" readonly></textarea>
    <div id="voice-bar">
      <div id="bar-row1">
        <button id="menu-btn" class="key-btn" style="font-size:16px;min-width:32px;">&#x22EF;</button>
        <div id="special-keys">
          <button class="key-btn" id="bar-hide-btn" style="font-size:14px;">&#x276F;</button>
          <button class="key-btn" data-key="esc">Esc</button>
          <button class="key-btn" data-key="tab">Tab</button>
          <button class="key-btn" data-key="up">&#x25B2;</button>
          <button class="key-btn" data-key="down">&#x25BC;</button>
          <button class="key-btn" id="paste-btn" title="Paste" style="font-size:16px;">&#x2398;</button>
          <button class="key-btn" id="scroll-bottom" title="Scroll to bottom" style="font-size:20px;">&#x21E9;</button>
        </div>
        <div id="font-controls">
          <button class="font-btn" onclick="changeFontSize(-2)">&#x2212;</button>
          <span id="font-size">21px</span>
          <button class="font-btn" onclick="changeFontSize(2)">+</button>
        </div>
      </div>
      <div id="bar-row2">
        <button id="menu-btn-mobile" class="key-btn mobile-only" style="font-size:16px;min-width:32px;">&#x22EF;</button>
        <div id="status">Hold Option to speak</div>
        <div id="text"></div>
        <button id="return-btn" class="key-btn" title="Return" style="font-size:20px;">&#x23CE;</button>
      </div>
    </div>
  </div>
  <div id="floating-keys"><button id="bar-handle">&#x2328;</button></div>
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
    <div id="fb-drop-overlay">Drop files here</div>
    <div id="fb-header">
      <button id="fb-close">&times;</button>
      <span id="fb-title">Files</span>
      <button id="fb-upload-btn" class="key-btn" title="Upload files" style="font-size:14px;">&#x2191;</button>
      <input type="file" id="fb-upload-input" multiple style="display:none;">
      <button id="fb-hidden-btn" class="key-btn" title="Toggle hidden files" style="font-size:10px;opacity:0.5">.*</button>
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

  <div id="app-menu" style="display:none;">
    <div class="app-menu-backdrop"></div>
    <div class="app-menu-panel">
      <a class="app-menu-item" href="/terminal">&#x2630; Sessions</a>
      <div class="app-menu-item" id="menu-files">&#x1F4C1; Files</div>
      <div class="app-menu-sep"></div>
      <div class="app-menu-section">Font Size</div>
      <div class="app-menu-row" style="padding:6px 16px;gap:10px;">
        <button class="app-menu-btn" id="menu-font-down">A&#x2212;</button>
        <span id="menu-font-val" style="font-size:14px;min-width:40px;text-align:center;color:#fff;font-weight:600;"></span>
        <button class="app-menu-btn" id="menu-font-up">A+</button>
      </div>
      <div class="app-menu-sep"></div>
      <div class="app-menu-section">Floating Keys</div>
      <div id="menu-fk-list" style="padding:6px 16px;display:flex;flex-direction:column;gap:4px;"></div>
      <div class="app-menu-row" style="padding:6px 16px;gap:8px;">
        <button class="app-menu-btn" id="menu-fk-add">+ Add</button>
        <button class="app-menu-btn" id="menu-fk-hide">Hide</button>
        <button class="app-menu-btn" id="menu-fk-reset" style="background:#333;color:#f87171;">Reset</button>
      </div>
      <div class="app-menu-sep"></div>
      <div class="app-menu-item" id="theme-toggle">&#x263E; Dark mode</div>
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
    var lastCols = term.cols, lastRows = 0;
    function sendResize() {
      var c = term.cols, r = getPtyRows();
      if (c === lastCols) return;
      lastCols = c; lastRows = r;
      if (termWs && termWs.readyState === 1) termWs.send(JSON.stringify({ type: 'resize', cols: c, rows: r }));
    }

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
    var cachedCellHeight = 0;
    function getCellHeight() {
      if (!cachedCellHeight && xtermScreen) cachedCellHeight = xtermScreen.offsetHeight / term.rows;
      return cachedCellHeight || 16;
    }
    if (isMobile && xtermScreen) {
      xtermScreen.addEventListener('touchstart', function(e) {
        cancelAnimationFrame(momentumId);
        touchLastY = e.touches[0].clientY;
        touchVelocity = 0;
        cachedCellHeight = xtermScreen.offsetHeight / term.rows;
      }, { passive: true });
      xtermScreen.addEventListener('touchmove', function(e) {
        e.preventDefault();
        var y = e.touches[0].clientY;
        var delta = touchLastY - y;
        touchVelocity = delta;
        var lines = Math.round(delta / getCellHeight());
        if (lines !== 0) {
          term.scrollLines(lines);
          touchLastY = y;
          if (lines < 0 && xtermTextarea) xtermTextarea.blur();
        }
      }, { passive: false });
      xtermScreen.addEventListener('touchend', function() {
        // Momentum scrolling
        var v = touchVelocity;
        var ch = getCellHeight();
        function momentumStep() {
          if (Math.abs(v) < 1) return;
          var lines = Math.round(v / ch);
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
      sendResize();
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
        } else if (msg.type === 'session_exit') {
          termWs.sessionExited = true;
          location.href = '/terminal';
          return;
        } else if (msg.type === 'output') {
          term.write(msg.data, doAutoScroll);
        }
      };
      termWs.onopen = () => {
        document.getElementById('status').textContent = isMobile ? 'Hold here to speak' : 'Hold Option to speak';
        document.getElementById('status').style.background = '';
        lastCols = 0; lastRows = 0; sendResize();
      };
      termWs.onerror = () => {
        document.getElementById('status').textContent = 'WS error';
        document.getElementById('status').style.background = '#f87171';
      };
      termWs.onclose = (e) => {
        if (termWs.sessionExited) return;
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
          pasteUploadFile(blob);
          return;
        }
      }
    }, true);

    // Fix mobile viewport height — only react to keyboard open/close (large changes), ignore address bar jitter
    var lastVh = 0;
    var containerEl = document.getElementById('container');
    var _vhRafPending = false;
    function setVh() {
      var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      if (lastVh && Math.abs(h - lastVh) < 50) return;
      lastVh = h;
      containerEl.style.height = h + 'px';
    }
    function setVhThrottled() {
      if (_vhRafPending) return;
      _vhRafPending = true;
      requestAnimationFrame(function() { _vhRafPending = false; setVh(); });
    }
    if (isMobile) {
      setVh();
      if (window.visualViewport) window.visualViewport.addEventListener('resize', setVhThrottled);
    }

    // Debounced resize to avoid PTY redraw storms (e.g. mobile keyboard toggle)
    var resizeTimer = null;
    window.addEventListener('resize', () => {
      if (isMobile) setVhThrottled();
      cachedCellHeight = 0; // invalidate cached cell height
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitAddon.fit();
        visibleRows = term.rows;
        cachedCellHeight = 0; // invalidate again after fit
        sendResize();
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


    // Paste button — popup textarea for manual paste
    var pasteOverlay = document.createElement('div');
    pasteOverlay.id = 'paste-overlay';
    pasteOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;background:rgba(0,0,0,0.8);flex-direction:column;align-items:center;justify-content:center;padding:20px;';
    pasteOverlay.innerHTML = '<div style="width:100%;max-width:480px;background:#16213e;border:2px solid #0f3460;border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;">'
      + '<div style="color:#e0e0e0;font-size:14px;font-family:system-ui;">Paste content here:</div>'
      + '<textarea id="paste-input" style="width:100%;height:120px;background:#1a1a2e;color:#e0e0e0;border:1px solid #333;border-radius:8px;padding:10px;font-family:monospace;font-size:14px;resize:vertical;outline:none;" placeholder="Long press or Ctrl+V to paste..."></textarea>'
      + '<div id="paste-file-preview" style="display:none;text-align:center;"><img id="paste-file-thumb" style="max-width:100%;max-height:120px;border-radius:6px;border:1px solid #333;"><div id="paste-file-icon" style="display:none;font-size:40px;padding:10px;">&#x1F4CE;</div><div id="paste-file-name" style="font-size:12px;color:#888;margin-top:4px;"></div></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;">'
      + '<button id="paste-file-btn" style="padding:8px 12px;background:#0f3460;color:#e0e0e0;border:none;border-radius:6px;font-size:13px;cursor:pointer;margin-right:auto;" title="Upload file">&#x1F4CE; File</button>'
      + '<input type="file" id="paste-file-input" style="display:none;">'
      + '<button id="paste-cancel" style="padding:8px 16px;background:#333;color:#e0e0e0;border:none;border-radius:6px;font-size:14px;cursor:pointer;">Cancel</button>'
      + '<button id="paste-send" style="padding:8px 16px;background:#4ade80;color:#000;border:none;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer;">Send</button>'
      + '</div></div>';
    document.body.appendChild(pasteOverlay);

    var pasteFileInput = document.getElementById('paste-file-input');
    var pasteFilePreview = document.getElementById('paste-file-preview');
    var pasteFileThumb = document.getElementById('paste-file-thumb');
    var pasteFileIcon = document.getElementById('paste-file-icon');
    var pasteFileName = document.getElementById('paste-file-name');
    var pasteFile = null;

    function pasteReset() {
      pasteFile = null;
      pasteFilePreview.style.display = 'none';
      pasteFileThumb.style.display = 'none';
      pasteFileThumb.src = '';
      pasteFileIcon.style.display = 'none';
      pasteFileName.textContent = '';
      pasteFileInput.value = '';
    }
    function pasteShow() {
      pasteReset();
      var inp = document.getElementById('paste-input');
      inp.value = '';
      pasteOverlay.style.display = 'flex';
      inp.focus();
    }
    function pasteHide() {
      pasteOverlay.style.display = 'none';
      pasteReset();
      term.focus();
    }
    function pasteUploadFile(file) {
      pasteHide();
      var statusEl = document.getElementById('status');
      var prevStatus = statusEl ? statusEl.textContent : '';
      if (statusEl) { statusEl.textContent = 'Uploading...'; statusEl.style.background = '#60a5fa'; }
      fetch('/terminal/upload', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: file
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(data) {
        if (data.error) throw new Error(data.error);
        if (data.path) sendInput(data.path + ' ');
        if (statusEl) { statusEl.textContent = 'Uploaded'; statusEl.style.background = '#4ade80'; }
        setTimeout(function() { if (statusEl) { statusEl.textContent = prevStatus; statusEl.style.background = ''; } }, 2000);
      }).catch(function(err) {
        if (statusEl) { statusEl.textContent = 'Upload failed: ' + err.message; statusEl.style.background = '#f87171'; }
        setTimeout(function() { if (statusEl) { statusEl.textContent = prevStatus; statusEl.style.background = ''; } }, 5000);
      });
    }
    document.getElementById('paste-btn').addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      pasteShow();
    });
    document.getElementById('paste-send').addEventListener('click', function() {
      if (pasteFile) {
        pasteUploadFile(pasteFile);
      } else {
        var text = document.getElementById('paste-input').value;
        pasteHide();
        if (text) sendInput(text);
      }
    });
    document.getElementById('paste-cancel').addEventListener('click', pasteHide);
    pasteOverlay.addEventListener('click', function(e) {
      if (e.target === pasteOverlay) pasteHide();
    });
    document.getElementById('paste-file-btn').addEventListener('click', function(e) {
      e.preventDefault();
      pasteFileInput.click();
    });
    pasteFileInput.addEventListener('change', function() {
      var file = pasteFileInput.files && pasteFileInput.files[0];
      if (!file) return;
      pasteFile = file;
      pasteFileName.textContent = file.name;
      if (file.type && file.type.indexOf('image/') === 0) {
        var reader = new FileReader();
        reader.onload = function(ev) {
          pasteFileThumb.src = ev.target.result;
          pasteFileThumb.style.display = '';
          pasteFileIcon.style.display = 'none';
          pasteFilePreview.style.display = 'block';
        };
        reader.readAsDataURL(file);
      } else {
        pasteFileThumb.style.display = 'none';
        pasteFileIcon.style.display = 'block';
        pasteFilePreview.style.display = 'block';
      }
    });

    // App menu (... button)
    var appMenu = document.getElementById('app-menu');
    function menuShow() {
      appMenu.style.display = 'block';
      document.getElementById('menu-font-val').textContent = fontSize + 'px';
      menuRenderFk();
    }
    function menuHide() { appMenu.style.display = 'none'; term.focus(); }
    document.getElementById('menu-btn').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); menuShow(); });
    document.getElementById('menu-btn-mobile').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); menuShow(); });
    appMenu.querySelector('.app-menu-backdrop').addEventListener('click', menuHide);

    // Menu: font size
    document.getElementById('menu-font-down').addEventListener('click', function(e) {
      e.stopPropagation();
      changeFontSize(-2);
      document.getElementById('menu-font-val').textContent = fontSize + 'px';
    });
    document.getElementById('menu-font-up').addEventListener('click', function(e) {
      e.stopPropagation();
      changeFontSize(2);
      document.getElementById('menu-font-val').textContent = fontSize + 'px';
    });

    // Menu: floating keys list
    var menuFkList = document.getElementById('menu-fk-list');
    var fkProtected = ['enter'];
    var fkDragIdx = -1;
    function menuRenderFk() {
      menuFkList.innerHTML = '';
      fkKeys.forEach(function(k, i) {
        var isLocked = fkProtected.indexOf(k.action) >= 0;
        var chip = document.createElement('div');
        chip.className = 'app-menu-fk-chip';
        chip.setAttribute('data-fk-idx', i);
        chip.draggable = true;
        chip.innerHTML = '<span class="fk-grip">&#x2630;</span><span style="flex:1;">' + (k.label || '?') + '</span>';
        if (isLocked) {
          chip.innerHTML += '<span style="font-size:10px;color:#888;">&#x1F512;</span>';
        } else {
          chip.innerHTML += '<span class="fk-remove">&times;</span>';
          chip.querySelector('.fk-remove').addEventListener('click', function(e) {
            e.stopPropagation();
            fkKeys.splice(i, 1);
            fkSave(fkKeys); fkRender(); menuRenderFk();
          });
        }
        chip.addEventListener('click', function(e) {
          if (e.target.classList.contains('fk-remove') || e.target.classList.contains('fk-grip')) return;
          e.stopPropagation();
          menuHide();
          fkOpenConfig(i);
        });
        // Drag (desktop)
        chip.addEventListener('dragstart', function(e) {
          fkDragIdx = i;
          chip.classList.add('fk-dragging');
          e.dataTransfer.effectAllowed = 'move';
        });
        chip.addEventListener('dragend', function() {
          chip.classList.remove('fk-dragging');
          fkDragIdx = -1;
          menuFkList.querySelectorAll('.fk-drop-indicator').forEach(function(el) { el.remove(); });
        });
        chip.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (fkDragIdx < 0 || fkDragIdx === i) return;
          menuFkList.querySelectorAll('.fk-drop-indicator').forEach(function(el) { el.remove(); });
          var rect = chip.getBoundingClientRect();
          var mid = rect.top + rect.height / 2;
          var ind = document.createElement('div');
          ind.className = 'fk-drop-indicator';
          if (e.clientY < mid) {
            menuFkList.insertBefore(ind, chip);
          } else {
            menuFkList.insertBefore(ind, chip.nextSibling);
          }
        });
        chip.addEventListener('drop', function(e) {
          e.preventDefault();
          if (fkDragIdx < 0 || fkDragIdx === i) return;
          var rect = chip.getBoundingClientRect();
          var mid = rect.top + rect.height / 2;
          var targetIdx = e.clientY < mid ? i : i + 1;
          if (targetIdx > fkDragIdx) targetIdx--;
          var item = fkKeys.splice(fkDragIdx, 1)[0];
          fkKeys.splice(targetIdx, 0, item);
          fkDragIdx = -1;
          fkSave(fkKeys); fkRender(); menuRenderFk();
        });
        // Touch drag (mobile)
        (function(chipEl, idx) {
          var touchStartY = 0, touchActive = false, clone = null, startScrollTop = 0;
          chipEl.addEventListener('pointerdown', function(e) {
            if (e.target.classList.contains('fk-remove')) return;
            if (e.pointerType === 'mouse') return; // mouse uses native drag
            touchStartY = e.clientY;
            startScrollTop = menuFkList.scrollTop;
            touchActive = false;
          });
          chipEl.addEventListener('pointermove', function(e) {
            if (e.pointerType === 'mouse') return;
            if (!touchActive && Math.abs(e.clientY - touchStartY) > 8) {
              touchActive = true;
              fkDragIdx = idx;
              chipEl.classList.add('fk-dragging');
              clone = chipEl.cloneNode(true);
              clone.style.cssText = 'position:fixed;left:' + chipEl.getBoundingClientRect().left + 'px;width:' + chipEl.offsetWidth + 'px;pointer-events:none;z-index:999;opacity:0.8;';
              document.body.appendChild(clone);
              chipEl.setPointerCapture(e.pointerId);
            }
            if (!touchActive) return;
            e.preventDefault();
            clone.style.top = (e.clientY - 18) + 'px';
            menuFkList.querySelectorAll('.fk-drop-indicator').forEach(function(el) { el.remove(); });
            var chips = menuFkList.querySelectorAll('.app-menu-fk-chip');
            for (var j = 0; j < chips.length; j++) {
              var r = chips[j].getBoundingClientRect();
              if (e.clientY >= r.top && e.clientY <= r.bottom) {
                var ind = document.createElement('div');
                ind.className = 'fk-drop-indicator';
                if (e.clientY < r.top + r.height / 2) {
                  menuFkList.insertBefore(ind, chips[j]);
                } else {
                  menuFkList.insertBefore(ind, chips[j].nextSibling);
                }
                break;
              }
            }
          });
          chipEl.addEventListener('pointerup', function(e) {
            if (!touchActive) return;
            touchActive = false;
            if (clone) { clone.remove(); clone = null; }
            chipEl.classList.remove('fk-dragging');
            // find drop target
            var chips = menuFkList.querySelectorAll('.app-menu-fk-chip');
            var targetIdx = fkDragIdx;
            for (var j = 0; j < chips.length; j++) {
              var r = chips[j].getBoundingClientRect();
              var ci = parseInt(chips[j].getAttribute('data-fk-idx'));
              if (e.clientY >= r.top && e.clientY <= r.bottom) {
                targetIdx = e.clientY < r.top + r.height / 2 ? ci : ci + 1;
                if (targetIdx > fkDragIdx) targetIdx--;
                break;
              }
            }
            if (targetIdx !== fkDragIdx) {
              var item = fkKeys.splice(fkDragIdx, 1)[0];
              fkKeys.splice(targetIdx, 0, item);
              fkSave(fkKeys); fkRender();
            }
            fkDragIdx = -1;
            menuFkList.querySelectorAll('.fk-drop-indicator').forEach(function(el) { el.remove(); });
            menuRenderFk();
          });
          chipEl.addEventListener('pointercancel', function() {
            if (clone) { clone.remove(); clone = null; }
            chipEl.classList.remove('fk-dragging');
            touchActive = false; fkDragIdx = -1;
            menuFkList.querySelectorAll('.fk-drop-indicator').forEach(function(el) { el.remove(); });
          });
        })(chip, i);
        menuFkList.appendChild(chip);
      });
      if (fkKeys.length === 0) {
        menuFkList.innerHTML = '<span style="color:#666;font-size:12px;">No floating keys</span>';
      }
    }
    document.getElementById('menu-fk-add').addEventListener('click', function(e) {
      e.stopPropagation();
      fkKeys.push({ label: 'New', action: 'char', chars: '' });
      fkSave(fkKeys);
      fkRender();
      menuHide();
      fkOpenConfig(fkKeys.length - 1);
    });
    document.getElementById('menu-fk-reset').addEventListener('click', function(e) {
      e.stopPropagation();
      fkKeys = fkDefaults.slice();
      fkSave(fkKeys);
      fkHidden = false;
      localStorage.setItem('hopcode_fk_hidden', '');
      fkRender();
      fkApplyVisibility();
      menuRenderFk();
    });

    // Theme toggle
    var isLight = localStorage.getItem('hopcode-theme') === 'light';
    var themeToggle = document.getElementById('theme-toggle');
    function applyTheme() {
      document.body.classList.toggle('light-mode', isLight);
      // Keep dark theme colors; CSS filter handles light mode inversion
      term.options.theme = { background: '#000', foreground: '#e0e0e0', cursor: isLight ? '#333' : '#4ade80' };
      themeToggle.innerHTML = isLight ? '&#x2600; Light mode' : '&#x263E; Dark mode';
    }
    applyTheme();
    themeToggle.addEventListener('click', function() {
      isLight = !isLight;
      localStorage.setItem('hopcode-theme', isLight ? 'light' : 'dark');
      applyTheme();
      menuHide();
    });

    // Bar collapse toggle (called from floating key or hide btn)
    function toggleBar() {
      var bar = document.getElementById('voice-bar');
      var handle = document.getElementById('bar-handle');
      bar.classList.toggle('collapsed');
      var isCollapsed = bar.classList.contains('collapsed');
      if (isCollapsed) {
        handle.classList.add('visible');
      } else {
        handle.classList.remove('visible');
      }
      setTimeout(function() { fitAddon.fit(); visibleRows = term.rows; }, 350);
    }

    // Hide bar button in row1
    document.getElementById('bar-hide-btn').addEventListener('click', function(e) {
      e.preventDefault();
      toggleBar();
    });

    // Bar handle (pull tab to restore bar)
    document.getElementById('bar-handle').addEventListener('click', function(e) {
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

    // Return button in row2
    document.getElementById('return-btn').addEventListener('click', function(e) {
      e.preventDefault();
      resetTypingBuffer();
      sendInput(String.fromCharCode(13));
      if (isMobile && xtermTextarea) xtermTextarea.blur();
      else term.focus();
    });

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
    var wantsToStop = false; // Track if stop was requested during async acquireMic
    var micReleaseTimer = null; // Delayed mic release

    var defaultStatusText = isMobile ? 'Hold here to speak' : 'Hold Option to speak';

    function flushAsrText() {
      if (asrFlushed) return;
      if (pendingAsrText && termWs && termWs.readyState === 1) {
        asrFlushed = true;
        text.textContent = pendingAsrText;
        status.textContent = 'Sending to terminal...';
        termWs.send(JSON.stringify({ type: 'asr', text: pendingAsrText }));
        setTimeout(function() { status.textContent = defaultStatusText; }, 2000);
      } else {
        status.textContent = defaultStatusText;
      }
      pendingAsrText = '';
    }

    function scheduleMicRelease() {
      clearTimeout(micReleaseTimer);
      micReleaseTimer = setTimeout(releaseMic, 60000);
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
        } else if (d.type === 'error') {
          // ASR failed — reset immediately instead of waiting for timeout
          clearTimeout(processingTimeout);
          flushAsrText();
        }
      };
      voiceWs.onclose = () => {
        // Reset all recording state
        clearTimeout(stopRecTimer);
        stopRecTimer = null;
        isRecording = false;
        wantsToStop = false;
        scheduleMicRelease();
        status.classList.remove('recording');
        if (status.textContent === 'Processing...' || status.textContent === 'Finishing...' || status.textContent === 'Recording...') {
          status.textContent = defaultStatusText;
        }
        setTimeout(connectVoice, 2000);
      };
    }

    async function acquireMic() {
      if (audioReady) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        status.textContent = window.isSecureContext ? 'Mic not available' : 'Mic needs HTTPS';
        return false;
      }
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
        if (e.name === 'NotAllowedError') {
          status.textContent = 'Mic denied - check browser settings';
        } else if (e.name === 'SecurityError') {
          status.textContent = 'Mic blocked - not secure context';
        } else {
          status.textContent = 'Mic error: ' + (e.message || e.name || 'unknown');
        }
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
      clearTimeout(micReleaseTimer);
      wantsToStop = false;
      var ok = await acquireMic();
      if (!ok) return;
      // Check if user released finger while we were acquiring mic
      if (wantsToStop) {
        wantsToStop = false;
        scheduleMicRelease();
        status.textContent = defaultStatusText;
        status.classList.remove('recording');
        return;
      }
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
      wantsToStop = true;
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
          scheduleMicRelease();
          status.textContent = 'Processing...';
          clearTimeout(processingTimeout);
          processingTimeout = setTimeout(function() {
            // Safety: if no final ASR result after 5s, flush whatever we have
            if (status.textContent === 'Processing...') {
              flushAsrText();
            }
          }, 5000);
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
          status.textContent = defaultStatusText;
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
            status.textContent = defaultStatusText;
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
    var menuBtn = document.getElementById('menu-btn');
    var menuBtnMobile = document.getElementById('menu-btn-mobile');
    var specialKeys = document.getElementById('special-keys');
    var returnBtn = document.getElementById('return-btn');
    function isExcluded(el) {
      return (fontControls && fontControls.contains(el)) || (menuBtn && menuBtn.contains(el)) || (menuBtnMobile && menuBtnMobile.contains(el)) || (specialKeys && specialKeys.contains(el)) || (returnBtn && returnBtn.contains(el));
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
      status.textContent = defaultStatusText;
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
      { label: 'Esc', action: 'esc', chars: '' },
      { label: 'Tab', action: 'tab', chars: '' },
      { label: '2', action: 'char', chars: '2' },
      { label: '3', action: 'char', chars: '3' },
      { label: '\u23CE', action: 'enter', chars: '' }
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
    var fkVersion = 7;
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
      var handle = document.getElementById('bar-handle');
      fkContainer.innerHTML = '';
      fkKeys.forEach(function(k, i) {
        var btn = document.createElement('button');
        btn.className = 'float-key';
        btn.textContent = k.label;
        if (k.action === 'enter') { btn.style.fontSize = '18px'; }
        btn.addEventListener('mousedown', function() { fkLongTimer = setTimeout(function() { fkLongTimer = 'fired'; fkOpenConfig(i); }, 600); });
        btn.addEventListener('mouseup', function(e) { if (fkLongTimer === 'fired') { fkLongTimer = null; return; } clearTimeout(fkLongTimer); fkLongTimer = null; fkSend(k); });
        btn.addEventListener('mouseleave', function() { if (fkLongTimer !== 'fired') clearTimeout(fkLongTimer); fkLongTimer = null; });
        btn.addEventListener('touchstart', function(e) { e.preventDefault(); fkLongTimer = setTimeout(function() { fkLongTimer = 'fired'; fkOpenConfig(i); }, 600); }, { passive: false });
        btn.addEventListener('touchend', function(e) { e.preventDefault(); if (fkLongTimer === 'fired') { fkLongTimer = null; return; } clearTimeout(fkLongTimer); fkLongTimer = null; fkSend(k); }, { passive: false });
        btn.addEventListener('touchcancel', function() { if (fkLongTimer !== 'fired') clearTimeout(fkLongTimer); fkLongTimer = null; });
        fkContainer.appendChild(btn);
      });
      fkContainer.appendChild(handle);
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

    // Floating keys hide/show
    var fkHidden = localStorage.getItem('hopcode_fk_hidden') === '1';
    var fkHideBtn = document.getElementById('menu-fk-hide');
    function fkApplyVisibility() {
      // Toggle visibility via class on container (avoids per-button DOM queries)
      fkContainer.classList.toggle('fk-hidden', fkHidden);
      fkHideBtn.textContent = fkHidden ? 'Show' : 'Hide';
    }
    fkApplyVisibility();
    fkHideBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      fkHidden = !fkHidden;
      localStorage.setItem('hopcode_fk_hidden', fkHidden ? '1' : '');
      fkApplyVisibility();
    });

    // Reposition floating keys when keyboard appears/disappears (throttled to 1 rAF)
    if (isMobile && window.visualViewport) {
      var _fkRafPending = false;
      function repositionFloatKeys() {
        if (_fkRafPending) return;
        _fkRafPending = true;
        requestAnimationFrame(function() {
          _fkRafPending = false;
          var vv = window.visualViewport;
          var barH = (voiceBar && !voiceBar.classList.contains('collapsed')) ? voiceBar.offsetHeight : 0;
          var midY = vv.offsetTop + (vv.height - barH) / 2;
          fkContainer.style.top = midY + 'px';
        });
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
    var fbShowHidden = false;
    var fbHiddenBtn = document.getElementById('fb-hidden-btn');

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
      var url = '/terminal/files?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(dirPath) + (fbShowHidden ? '&hidden=1' : '');
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
              var dtype = item.isImage ? 'image' : (item.isText ? 'text' : 'binary');
              html += '<div class="fb-item fb-file" data-path="'+fbEscHtml(fullPath)+'" data-name="'+fbEscHtml(item.name)+'" data-type="'+dtype+'"><span class="fb-icon">'+icon+'</span><div class="fb-info"><div class="fb-name">'+fbEscHtml(item.name)+'</div><div class="fb-meta">'+fbFormatSize(item.size)+' &middot; '+fbFormatTime(item.modified)+'</div></div>'+actions+'</div>';
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

    // Double-click on file → confirm then open/download
    fbList.addEventListener('dblclick', function(e) {
      var item = e.target.closest && e.target.closest('.fb-file');
      if (!item) return;
      var fp = item.getAttribute('data-path');
      var nm = item.getAttribute('data-name');
      var tp = item.getAttribute('data-type');
      if (tp === 'image') { fbShowImagePreview(fp, nm); return; }
      if (tp === 'text') { fbShowTextPreview(fp, nm); return; }
      if (confirm('Download ' + nm + '?')) fbDownload(fp);
    });

    // Long-press on filename → editable input for copying
    var fbLpTimer = null, fbLpItem = null, fbLpMoved = false;
    function fbLpClear() { clearTimeout(fbLpTimer); fbLpTimer = null; fbLpItem = null; }

    fbList.addEventListener('pointerdown', function(e) {
      var nameEl = e.target.closest && e.target.closest('.fb-name');
      if (!nameEl) return;
      fbLpMoved = false;
      fbLpItem = nameEl;
      fbLpTimer = setTimeout(function() {
        if (fbLpMoved || !fbLpItem) return;
        var name = fbLpItem.textContent;
        var inp = document.createElement('input');
        inp.type = 'text';
        inp.value = name;
        inp.readOnly = true;
        inp.style.cssText = 'width:100%;font-size:14px;background:#222;color:#4ade80;border:1px solid #4ade80;border-radius:4px;padding:2px 4px;outline:none;font-family:inherit;';
        var origEl = fbLpItem;
        origEl.textContent = '';
        origEl.appendChild(inp);
        inp.focus();
        inp.select();
        inp.addEventListener('blur', function() {
          origEl.textContent = name;
        });
        inp.addEventListener('keydown', function(ev) {
          if (ev.key === 'Escape' || ev.key === 'Enter') inp.blur();
          ev.stopPropagation();
        });
        // Prevent the parent click from firing
        origEl.closest('.fb-item').onclick = null;
      }, 500);
    });
    fbList.addEventListener('pointermove', function(e) {
      if (fbLpTimer) fbLpMoved = true;
    });
    fbList.addEventListener('pointerup', function() { fbLpClear(); });
    fbList.addEventListener('pointercancel', function() { fbLpClear(); });

    // Wire up buttons
    document.getElementById('menu-files').addEventListener('click', function(e) {
      e.preventDefault();
      menuHide();
      fbOpen();
      if (isMobile && xtermTextarea) xtermTextarea.blur();
    });
    document.getElementById('fb-close').addEventListener('click', fbClose);
    document.getElementById('fb-cwd-btn').addEventListener('click', function() { fbLoadDir(''); });
    var fbUploadInput = document.getElementById('fb-upload-input');
    document.getElementById('fb-upload-btn').addEventListener('click', function() { fbUploadInput.click(); });
    fbUploadInput.addEventListener('change', function() {
      if (fbUploadInput.files && fbUploadInput.files.length > 0) {
        fbUploadFiles(fbUploadInput.files);
        fbUploadInput.value = '';
      }
    });
    fbHiddenBtn.addEventListener('click', function() {
      fbShowHidden = !fbShowHidden;
      fbHiddenBtn.style.opacity = fbShowHidden ? '1' : '0.5';
      fbLoadDir(fbCurrentPath);
    });
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

    // --- File Browser: Drag-and-drop upload ---
    var fbDropOverlay = document.getElementById('fb-drop-overlay');
    var fbDragCounter = 0;

    fbPanel.addEventListener('dragenter', function(e) {
      e.preventDefault();
      fbDragCounter++;
      if (fbDragCounter === 1) fbDropOverlay.classList.add('visible');
    });
    fbPanel.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    fbPanel.addEventListener('dragleave', function(e) {
      e.preventDefault();
      fbDragCounter--;
      if (fbDragCounter <= 0) {
        fbDragCounter = 0;
        fbDropOverlay.classList.remove('visible');
      }
    });
    fbPanel.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      fbDragCounter = 0;
      fbDropOverlay.classList.remove('visible');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length === 0) return;
      fbUploadFiles(files);
    });

    // Also handle drop on the document body when file-browser is open
    // (in case the user drops slightly outside the panel)
    document.addEventListener('dragover', function(e) {
      if (fbPanel.classList.contains('open')) e.preventDefault();
    });
    document.addEventListener('drop', function(e) {
      if (fbPanel.classList.contains('open')) {
        e.preventDefault();
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) fbUploadFiles(files);
      }
    });

    function fbUploadFiles(files) {
      var total = files.length;
      var done = 0;
      var errors = [];
      fbError.textContent = 'Uploading ' + total + ' file' + (total > 1 ? 's' : '') + '...';
      fbError.style.display = 'block';
      fbError.style.color = '#4ade80';
      fbError.style.background = '#1a2a1a';
      for (var i = 0; i < files.length; i++) {
        (function(file) {
          fetch('/terminal/file-upload?path=' + encodeURIComponent(fbCurrentPath), {
            method: 'POST',
            credentials: 'include',
            headers: { 'X-Filename': encodeURIComponent(file.name) },
            body: file,
          })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            if (data.error) errors.push(file.name + ': ' + data.error);
            done++;
            fbError.textContent = 'Uploading... (' + done + '/' + total + ')';
            if (done === total) fbUploadDone(total, errors);
          })
          .catch(function(err) {
            errors.push(file.name + ': ' + err.message);
            done++;
            fbError.textContent = 'Uploading... (' + done + '/' + total + ')';
            if (done === total) fbUploadDone(total, errors);
          });
        })(files[i]);
      }
    }

    function fbUploadDone(total, errors) {
      if (errors.length === 0) {
        fbError.textContent = 'Uploaded ' + total + ' file' + (total > 1 ? 's' : '');
        fbError.style.color = '#4ade80';
        fbError.style.background = '#1a2a1a';
      } else {
        fbError.textContent = errors.join('; ');
        fbError.style.color = '#f87171';
        fbError.style.background = '#2a1a1a';
      }
      fbError.style.display = 'block';
      fbLoadDir(fbCurrentPath);
      setTimeout(function() {
        fbError.style.display = 'none';
        fbError.style.color = '#f87171';
        fbError.style.background = '#2a1a1a';
      }, 4000);
    }

    if (!isMobile) term.focus();
    connectVoice();
  </script>
  <script>if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');</script>
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

// Helper: check auth (backward compat wrapper)
function isAuthenticated(req: http.IncomingMessage): boolean {
  return getAuthInfo(req).authenticated;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws: wss:; img-src 'self' data:; manifest-src 'self';");

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
        const parsed = JSON.parse(body);
        const { password, username } = parsed;

        let loginOk = false;
        let tokenUsername = 'admin';

        if (isMultiUser) {
          // Multi-user: look up username in config
          if (username && usersConfig[username] && password === usersConfig[username]!.password) {
            loginOk = true;
            tokenUsername = username;
          }
        } else {
          // Single-user: just verify password
          if (password === PASSWORD) {
            loginOk = true;
            tokenUsername = 'admin';
          }
        }

        if (loginOk) {
          clearLoginAttempts(clientIp);
          const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted;
          const securePart = isSecure ? ' Secure;' : '';
          const authToken = makeAuthToken(tokenUsername);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': `auth=${authToken}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly;${securePart}`
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

  // Handle logout
  if (req.url === '/logout' || req.url === '/terminal/logout') {
    const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted;
    const securePart = isSecure ? ' Secure;' : '';
    res.writeHead(302, {
      'Location': '/terminal',
      'Set-Cookie': `auth=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly;${securePart}`,
    });
    res.end();
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

  // Handle session delete — proxy to PTY service
  const deleteSessionMatch = (req.url || '').match(/^(?:\/terminal)?\/sessions\/([^/?]+)$/);
  if (deleteSessionMatch && req.method === 'DELETE') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unauthorized' }));
      return;
    }
    const sessionId = decodeURIComponent(deleteSessionMatch[1]!);
    // Check ownership (non-root can only delete own sessions)
    const auth = getAuthInfo(req);
    if (auth.username !== 'root') {
      try {
        const listResp = await ptyFetch(`/sessions?owner=${encodeURIComponent(auth.username!)}`);
        if (listResp.ok) {
          const list: SessionInfo[] = await listResp.json() as SessionInfo[];
          if (!list.some(s => s.id === sessionId)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
            return;
          }
        }
      } catch {}
    }
    try {
      const resp = await ptyFetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
      const data = await resp.json();
      res.writeHead(resp.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Internal error' }));
    }
    return;
  }

  // --- Serve static PWA assets (no auth required) ---
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  // Strip /terminal prefix so PWA assets work behind reverse proxy
  const assetPath = pathname.startsWith('/terminal/') ? pathname.slice('/terminal'.length) : pathname;

  if (assetPath === '/manifest.json' || assetPath === '/sw.js' ||
      assetPath.startsWith('/icons/') || assetPath === '/favicon.ico') {
    const MIME_TYPES: Record<string, string> = {
      '.json': 'application/json',
      '.js': 'application/javascript',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.ico': 'image/x-icon',
    };
    // Map /favicon.ico to the 32px PNG
    const filePath = assetPath === '/favicon.ico'
      ? path.join(__dirname, '..', 'public', 'icons', 'favicon-32.png')
      : path.join(__dirname, '..', 'public', assetPath);
    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    try {
      const data = await fs.promises.readFile(filePath);
      const cacheControl = assetPath === '/sw.js' ? 'no-cache' : 'public, max-age=86400';
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
    return;
  }

  // URL token authentication: ?token=username:hmac → set cookie → redirect
  const tokenParam = parsedUrl.searchParams.get('token');
  if (tokenParam) {
    const username = verifyAuthToken(tokenParam);
    if (username) {
      const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.socket as any).encrypted;
      const securePart = isSecure ? ' Secure;' : '';
      const authToken = makeAuthToken(username);
      // Strip token param from URL to avoid leaking it in browser history
      parsedUrl.searchParams.delete('token');
      const cleanUrl = parsedUrl.pathname + (parsedUrl.search || '');
      res.writeHead(302, {
        'Location': cleanUrl || '/',
        'Set-Cookie': `auth=${authToken}; Path=/; Max-Age=86400; SameSite=Lax; HttpOnly;${securePart}`,
      });
      res.end();
      return;
    }
    // Invalid token — fall through to normal auth check
  }

  // Check authentication
  const auth = getAuthInfo(req);
  if (!auth.authenticated) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getLoginHtml());
    return;
  }

  // --- Authenticated routes below ---

  // --- File browser API ---

  if ((pathname === '/terminal/file-upload' || pathname === '/file-upload') && req.method === 'POST') {
    try {
      const targetDir = resolveSafePath(parsedUrl.searchParams.get('path') || '/');
      const rawFilename = req.headers['x-filename'] as string;
      let filename: string;
      try { filename = decodeURIComponent(rawFilename); } catch { filename = rawFilename; }
      if (!filename || filename.includes('/') || filename.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing X-Filename header' }));
        return;
      }

      // Verify target directory exists and is a directory
      const dirStat = await fs.promises.stat(targetDir);
      if (!dirStat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Target path is not a directory' }));
        return;
      }

      // Permission check: can user write to this directory?
      const posixUser = auth.linuxUser ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser && !checkPosixAccess(dirStat, posixUser, 'write')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Permission denied' }));
        return;
      }

      // Read raw body
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      const body = Buffer.concat(chunks);

      const filePath = path.join(targetDir, filename);
      await fs.promises.writeFile(filePath, body);

      // Multi-user: chown file to user's uid/gid
      if (posixUser) {
        try { fs.chownSync(filePath, posixUser.uid, posixUser.gid); } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: filePath }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Upload failed' }));
    }
    return;
  }

  if ((pathname === '/terminal/files' || pathname === '/files') && req.method === 'GET') {
    try {
      const sid = parsedUrl.searchParams.get('session');
      if (!sid) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }

      // Determine user's home directory for fallback
      const userHome = auth.linuxUser
        ? (auth.linuxUser === 'root' ? '/root' : `/home/${auth.linuxUser}`)
        : (process.env.HOME || '/');

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
            dirPath = userHome;
          }
        } catch {
          dirPath = userHome;
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

      // Permission check: can user read+execute (list) this directory?
      const posixUser = auth.linuxUser ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser) {
        const dirStat = await fs.promises.stat(dirPath);
        if (!checkPosixAccess(dirStat, posixUser, 'read+execute')) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Permission denied' }));
          return;
        }
      }

      const showHidden = parsedUrl.searchParams.get('hidden') === '1';
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      const items: any[] = [];
      for (const entry of entries) {
        if (!showHidden && entry.name.startsWith('.')) continue;
        const fullPath = path.join(dirPath, entry.name);
        let stat;
        try { stat = await fs.promises.stat(fullPath); } catch { continue; }
        // Filter: only show entries the user can at least stat
        if (posixUser && !checkPosixAccess(stat, posixUser, 'read')) continue;
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

      const posixUser = auth.linuxUser ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser && !checkPosixAccess(stat, posixUser, 'read')) {
        res.writeHead(403); res.end('Permission denied'); return;
      }

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

      const posixUser = auth.linuxUser ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser && !checkPosixAccess(stat, posixUser, 'read')) {
        res.writeHead(403); res.end('Permission denied'); return;
      }

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
    const userHome = auth.linuxUser
      ? (auth.linuxUser === 'root' ? '/root' : `/home/${auth.linuxUser}`)
      : '/tmp';
    const userDir = path.join(userHome, '.hopcode', 'uploads');
    const contentType = req.headers['content-type'] || 'application/octet-stream';
    // Use original filename from header if provided, otherwise derive from content-type
    const origName = req.headers['x-filename'] ? decodeURIComponent(req.headers['x-filename'] as string) : '';
    let fileName: string;
    if (origName) {
      // Sanitize: strip path separators, prepend timestamp to avoid collisions
      const safe = origName.replace(/[\/\\]/g, '_');
      fileName = `${Date.now()}-${safe}`;
    } else {
      const extMap: Record<string, string> = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif',
        'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg',
        'application/pdf': 'pdf', 'text/plain': 'txt', 'text/csv': 'csv',
        'application/json': 'json', 'application/zip': 'zip',
        'application/gzip': 'gz', 'application/x-tar': 'tar',
        'video/mp4': 'mp4', 'audio/mpeg': 'mp3', 'audio/wav': 'wav',
      };
      const ext = extMap[contentType] || 'bin';
      fileName = `file-${Date.now()}.${ext}`;
    }
    const filePath = path.join(userDir, fileName);

    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        await fs.promises.mkdir(userDir, { recursive: true, mode: 0o700 });
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
      const sessionBody: Record<string, string> = { id, owner: auth.username };
      if (auth.linuxUser) sessionBody.linuxUser = auth.linuxUser;
      const resp = await ptyFetch('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(sessionBody),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`Failed to create session on PTY service: status=${resp.status} body=${body}`);
      }
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
  res.end(await buildSessionsHtml(auth.username));
});

// Terminal WebSocket server — proxies to PTY service
const terminalWss = new WebSocketServer({ noServer: true });
terminalWss.on('connection', (clientWs: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';
  const wsAuth = getAuthInfo(req);

  // Connect to PTY service WebSocket, include owner for verification (root bypasses)
  const ownerQuery = isMultiUser && wsAuth.username !== 'root' ? `?owner=${encodeURIComponent(wsAuth.username)}` : '';
  const ptyWsUrl = `ws://127.0.0.1:${PTY_SERVICE_PORT}/ws/${encodeURIComponent(sessionId)}${ownerQuery}`;
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
      .-.   .-.
     ( o ) ( o )
      /  ¯¯¯¯  \\
     |   >__    |
      '--------'
    h o p c o d e

  http://localhost:${PORT}
`);

  // Start Cloudflare Tunnel if requested via --tunnel flag or CLOUDFLARE_TUNNEL env
  const wantTunnel = process.argv.includes('--tunnel') || process.env.CLOUDFLARE_TUNNEL === '1';
  if (wantTunnel) {
    startCloudflareTunnel();
  }
});

function startCloudflareTunnel() {
  // Use npx cloudflared so the npm package auto-downloads the binary if not present
  const tunnelProc = spawn('npx', ['cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], {
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

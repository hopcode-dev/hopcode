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
import { ClaudeProcess } from './easymode/claude-process.js';
import type { EasyClientMessage, EasyServerMessage } from './easymode/protocol.js';
import { setupProjectTemplate } from './templates/index.js';
import { getI18nScript, t } from './i18n.js';

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
  disabled?: boolean;
}

let usersConfig: Record<string, UserConfig> = {};
let isMultiUser = false;

// System administrators — full access to all sessions, recordings, user management
const ADMIN_USERS = new Set(['root', 'jack']);
function isAdminUser(username?: string): boolean {
  return !!username && ADMIN_USERS.has(username);
}

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

function saveUsersConfig(): void {
  const usersPath = path.join(__dirname, '..', 'users.json');
  try {
    fs.writeFileSync(usersPath, JSON.stringify(usersConfig, null, 2) + '\n', 'utf-8');
  } catch (e) {
    console.error('[auth] Failed to save users.json:', (e as Error).message);
  }
}

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

// --- Guest Token (stateless HMAC, 48h validity) ---

function makeGuestToken(sessionId: string, expiresAt: number): string {
  const payload = `guest:${sessionId}:${expiresAt}`;
  return createHmac('sha256', PASSWORD!).update(payload).digest('hex');
}

function verifyGuestToken(sessionId: string, token: string, expires: string): boolean {
  const expiresAt = parseInt(expires, 10);
  if (isNaN(expiresAt) || Date.now() > expiresAt) return false;
  const expected = makeGuestToken(sessionId, expiresAt);
  if (token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
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
    if (username && usersConfig[username] && !usersConfig[username]!.disabled) {
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

// TTS config
const VOLCANO_TTS_RESOURCE_ID = process.env.VOLCANO_RESOURCE_ID || 'seed-tts-2.0';
const VOLCANO_TTS_VOICE = process.env.VOLCANO_VOICE || 'zh_female_wanwanxiaohe_moon_bigtts';
const VOLCANO_TTS_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/tts/bidirection';

// --- PTY service client ---
const PTY_INTERNAL_TOKEN = getPtyInternalToken();
const PTY_BASE_URL = `http://127.0.0.1:${PTY_SERVICE_PORT}`;
const RECORDINGS_DIR = path.join(__dirname, '..', 'data', 'recordings');

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

// --- Session limit ---
const MAX_SESSIONS_PER_USER = 3;

async function checkSessionLimit(username: string): Promise<boolean> {
  if (isAdminUser(username)) return true;
  try {
    const resp = await ptyFetch(`/sessions?owner=${encodeURIComponent(username)}`);
    if (resp.ok) {
      const list = await resp.json() as any[];
      return list.length < MAX_SESSIONS_PER_USER;
    }
  } catch {}
  return true; // allow on error to avoid blocking
}

// --- File browser helpers ---

function getUserHome(linuxUser?: string): string {
  if (!linuxUser) return process.env.HOME || '/';
  return linuxUser === 'root' ? '/root' : `/home/${linuxUser}`;
}

/** Find a unique name by appending (1), (2), ... if the path already exists. */
async function autoRename(dir: string, baseName: string, isDir: boolean): Promise<string> {
  const candidate = path.join(dir, baseName);
  try {
    await fs.promises.access(candidate);
  } catch {
    return baseName; // doesn't exist, use as-is
  }
  // Split name and extension (for files only)
  let stem: string, ext: string;
  if (isDir) {
    stem = baseName;
    ext = '';
  } else {
    const dotIdx = baseName.lastIndexOf('.');
    if (dotIdx > 0) {
      stem = baseName.slice(0, dotIdx);
      ext = baseName.slice(dotIdx);
    } else {
      stem = baseName;
      ext = '';
    }
  }
  for (let i = 1; i <= 999; i++) {
    const newName = `${stem} (${i})${ext}`;
    try {
      await fs.promises.access(path.join(dir, newName));
    } catch {
      return newName;
    }
  }
  // Fallback: timestamp
  return `${stem} (${Date.now()})${ext}`;
}

// Map linuxUser -> Hopcode username for admin checks
function isAdminLinuxUser(linuxUser?: string): boolean {
  if (!linuxUser) return false;
  if (linuxUser === 'root') return true;
  // Check if any admin user maps to this linuxUser
  for (const [username, config] of Object.entries(usersConfig)) {
    if (config.linuxUser === linuxUser && ADMIN_USERS.has(username)) return true;
  }
  return false;
}

function resolveSafePath(requestedPath: string, linuxUser?: string): string {
  const resolved = path.resolve('/', requestedPath);
  // Admin users have full filesystem access
  if (isAdminLinuxUser(linuxUser)) return resolved;
  // Non-admin users are sandboxed to their home directory
  if (linuxUser) {
    const home = getUserHome(linuxUser);
    if (!resolved.startsWith(home + '/') && resolved !== home) {
      return home;
    }
  }
  return resolved;
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
  ready: boolean;            // Volcano connected and init sent, ready for audio
  allChunks: Buffer[];       // all audio chunks (kept for retry)
  pendingChunks: Buffer[];   // chunks buffered while Volcano is connecting
  ended: boolean;            // whether asr_end was received
  retryCount: number;
  gotResult: boolean;
  cancelled: boolean;
}

const ASR_MAX_RETRIES = 3;

function cancelAsrSession(session: AsrSession): void {
  session.cancelled = true;
  if (session.volcanoWs) {
    try { session.volcanoWs.removeAllListeners(); session.volcanoWs.close(); } catch {}
    session.volcanoWs = null;
  }
}

function connectVolcano(asrSession: AsrSession, clientWs: WebSocket): void {
  if (asrSession.cancelled) return;

  asrSession.ready = false;
  asrSession.pendingChunks = [];

  // Close old connection (for retries)
  if (asrSession.volcanoWs) {
    try { asrSession.volcanoWs.removeAllListeners(); asrSession.volcanoWs.close(); } catch {}
    asrSession.volcanoWs = null;
  }

  const volcanoWs = new WebSocket(VOLCANO_ASR_ENDPOINT, {
    headers: {
      'X-Api-App-Key': VOLCANO_APP_ID,
      'X-Api-Access-Key': VOLCANO_TOKEN,
      'X-Api-Resource-Id': VOLCANO_ASR_RESOURCE_ID,
      'X-Api-Connect-Id': randomUUID(),
    },
  });
  asrSession.volcanoWs = volcanoWs;

  let retried = false;
  function retryIfNeeded() {
    if (retried) return;
    retried = true;
    if (asrSession.cancelled || asrSession.gotResult) return;
    if (asrSession.retryCount >= ASR_MAX_RETRIES) {
      console.error(`ASR: max retries (${ASR_MAX_RETRIES}) reached, giving up`);
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'error', message: 'ASR failed after retries' }));
      }
      return;
    }
    asrSession.retryCount++;
    console.log(`ASR: retrying (attempt ${asrSession.retryCount}/${ASR_MAX_RETRIES}), replaying ${asrSession.allChunks.length} chunks`);
    setTimeout(() => connectVolcano(asrSession, clientWs), 1000);
  }

  volcanoWs.on('open', () => {
    if (asrSession.cancelled) { try { volcanoWs.close(); } catch {} return; }

    // Send init
    volcanoWs.send(buildFullClientRequest({
      user: { uid: randomUUID() },
      audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
      request: {
        model_name: 'bigmodel', language: 'zh',
        enable_itn: true, enable_punc: true,
        result_type: 'full', show_utterances: true,
      },
    }));

    // Immediately replay any buffered chunks, then mark ready for real-time
    for (const chunk of asrSession.allChunks) {
      volcanoWs.send(buildAudioRequest(chunk, false));
    }
    // Also flush any pending chunks that arrived during connection
    for (const chunk of asrSession.pendingChunks) {
      asrSession.allChunks.push(chunk);
      volcanoWs.send(buildAudioRequest(chunk, false));
    }
    asrSession.pendingChunks = [];
    asrSession.ready = true;

    // If recording already ended, send final marker
    if (asrSession.ended) {
      volcanoWs.send(buildAudioRequest(Buffer.alloc(0), true));
    }

    console.log(`ASR Volcano ready (sent ${asrSession.allChunks.length} chunks, retry=${asrSession.retryCount})`);
  });

  // Debounce definite results (batch replay can produce many rapid definites)
  let finalDebounce: ReturnType<typeof setTimeout> | null = null;
  let latestFinalText = '';

  volcanoWs.on('message', (data: Buffer) => {
    if (asrSession.cancelled || asrSession.volcanoWs !== volcanoWs) return;
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
          if (definite) {
            latestFinalText = text;
            // Send as partial so UI updates immediately
            clientWs.send(JSON.stringify({ type: 'asr_partial', text }));
            if (finalDebounce) clearTimeout(finalDebounce);
            finalDebounce = setTimeout(() => {
              asrSession.gotResult = true;
              clientWs.send(JSON.stringify({ type: 'asr', text: latestFinalText }));
              console.log(`ASR final: "${latestFinalText}"`);
              // Only close Volcano WS if user already stopped recording
              if (asrSession.ended) {
                try { volcanoWs.close(); } catch {}
              } else {
                // Reset for next utterance while user keeps talking
                asrSession.gotResult = false;
                latestFinalText = '';
              }
            }, 300);
          } else {
            clientWs.send(JSON.stringify({ type: 'asr_partial', text }));
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
    if (asrSession.cancelled || asrSession.volcanoWs !== volcanoWs) return;
    asrSession.ready = false;
    console.log('ASR session closed');
    if (asrSession.ended && !asrSession.gotResult) {
      retryIfNeeded();
    }
  });
}

// --- TTS via Volcano Engine BigModel (WebSocket bidirectional) ---
function synthesizeTts(text: string): Promise<Buffer> {
  if (!VOLCANO_APP_ID || !VOLCANO_TOKEN) {
    return Promise.reject(new Error('TTS not configured'));
  }

  // Strip markdown for cleaner speech
  let clean = text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\-*]\s+/gm, '')
    .replace(/^\d+\.\s+/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  if (!clean) return Promise.reject(new Error('Empty text'));

  // Limit to ~200 chars for reasonable TTS length
  if (clean.length > 200) {
    const sentences = clean.split(/(?<=[。！？!?.…])/);
    clean = '';
    for (const s of sentences) {
      if ((clean + s).length > 200) break;
      clean += s;
    }
    if (!clean) clean = text.substring(0, 200);
  }

  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const connectId = crypto.randomUUID();

  // Protocol constants
  const PROTOCOL_VERSION = 0b0001;
  const DEFAULT_HEADER_SIZE = 0b0001;
  const FULL_CLIENT_REQUEST = 0b0001;
  const AUDIO_ONLY_RESPONSE = 0b1011;
  const ERROR_INFORMATION = 0b1111;
  const MsgTypeFlagNoSeq = 0b0000;
  const MsgTypeFlagWithEvent = 0b0100;
  const JSON_SERIALIZATION = 0b0001;
  const NO_SERIALIZATION = 0b0000;
  const COMPRESSION_NO = 0b0000;

  const EVENT_StartSession = 100;
  const EVENT_FinishSession = 102;
  const EVENT_SessionStarted = 150;
  const EVENT_SessionFinished = 152;
  const EVENT_SessionFailed = 153;
  const EVENT_TaskRequest = 200;
  const EVENT_TTSResponse = 352;

  function buildHeader(mt: number, flags = MsgTypeFlagNoSeq, serial = NO_SERIALIZATION) {
    return new Uint8Array([
      (PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE,
      (mt << 4) | flags,
      (serial << 4) | COMPRESSION_NO,
      0
    ]);
  }
  function buildOptional(event: number, sid?: string) {
    const parts: number[] = [];
    const dv = new DataView(new ArrayBuffer(4));
    dv.setInt32(0, event, false);
    parts.push(...new Uint8Array(dv.buffer));
    if (sid) {
      const enc = new TextEncoder().encode(sid);
      const sz = new DataView(new ArrayBuffer(4));
      sz.setInt32(0, enc.length, false);
      parts.push(...new Uint8Array(sz.buffer));
      parts.push(...enc);
    }
    return new Uint8Array(parts);
  }
  function buildPayloadWithSize(payload: object) {
    const enc = new TextEncoder().encode(JSON.stringify(payload));
    const sz = new DataView(new ArrayBuffer(4));
    sz.setInt32(0, enc.length, false);
    const r = new Uint8Array(4 + enc.length);
    r.set(new Uint8Array(sz.buffer), 0);
    r.set(enc, 4);
    return r;
  }
  function buildMessage(header: Uint8Array, optional: Uint8Array, payload?: Uint8Array) {
    const total = header.length + optional.length + (payload?.length || 0);
    const r = new Uint8Array(total);
    let off = 0;
    r.set(header, off); off += header.length;
    r.set(optional, off); off += optional.length;
    if (payload) r.set(payload, off);
    return r;
  }
  function readInt32BE(data: Uint8Array, offset: number) {
    return new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
  }
  function readStringWithSize(data: Uint8Array, offset: number) {
    const size = readInt32BE(data, offset); offset += 4;
    offset += size;
    return { newOffset: offset };
  }
  function readPayloadWithSize(data: Uint8Array, offset: number) {
    const size = readInt32BE(data, offset); offset += 4;
    const payload = data.slice(offset, offset + size); offset += size;
    return { payload, newOffset: offset };
  }

  return new Promise((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    let sessionStarted = false;

    const ws = new WebSocket(VOLCANO_TTS_ENDPOINT, {
      headers: {
        'X-Api-App-Key': VOLCANO_APP_ID,
        'X-Api-Access-Key': VOLCANO_TOKEN,
        'X-Api-Resource-Id': VOLCANO_TTS_RESOURCE_ID,
        'X-Api-Connect-Id': connectId,
      }
    });

    const cleanup = () => {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    };
    const timeout = setTimeout(() => {
      cleanup();
      audioChunks.length > 0 ? resolve(Buffer.concat(audioChunks)) : reject(new Error('TTS timeout'));
    }, 30000);

    ws.on('open', () => {
      ws.send(buildMessage(
        buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION),
        buildOptional(EVENT_StartSession, sessionId),
        buildPayloadWithSize({
          user: { uid: 'hopcode' },
          event: EVENT_StartSession,
          namespace: 'BidirectionalTTS',
          req_params: {
            text: '',
            speaker: VOLCANO_TTS_VOICE,
            audio_params: { format: 'pcm', sample_rate: 24000, enable_timestamp: false },
            additions: JSON.stringify({ disable_markdown_filter: false }),
          }
        })
      ));
    });

    ws.on('message', (rawData: Buffer) => {
      try {
        const data = new Uint8Array(rawData);
        const hdr = {
          messageType: (data[1] >> 4) & 0x0f,
          messageTypeFlags: data[1] & 0x0f,
        };
        let offset = 4;

        if (hdr.messageTypeFlags === MsgTypeFlagWithEvent) {
          const eventType = readInt32BE(data, offset); offset += 4;

          if (eventType === EVENT_SessionStarted) {
            sessionStarted = true;
            const r1 = readStringWithSize(data, offset); offset = r1.newOffset;
            if (offset < data.length) { const r2 = readStringWithSize(data, offset); offset = r2.newOffset; }

            // Send text
            ws.send(buildMessage(
              buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION),
              buildOptional(EVENT_TaskRequest, sessionId),
              buildPayloadWithSize({
                user: { uid: 'hopcode' },
                event: EVENT_TaskRequest,
                namespace: 'BidirectionalTTS',
                req_params: {
                  text: clean,
                  speaker: VOLCANO_TTS_VOICE,
                  audio_params: { format: 'pcm', sample_rate: 24000, enable_timestamp: false },
                  additions: JSON.stringify({ disable_markdown_filter: false }),
                }
              })
            ));
            // Finish session
            setTimeout(() => {
              ws.send(buildMessage(
                buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION),
                buildOptional(EVENT_FinishSession, sessionId),
                buildPayloadWithSize({})
              ));
            }, 100);
          } else if (eventType === EVENT_TTSResponse && hdr.messageType === AUDIO_ONLY_RESPONSE) {
            const r1 = readStringWithSize(data, offset); offset = r1.newOffset;
            const { payload } = readPayloadWithSize(data, offset);
            audioChunks.push(Buffer.from(payload));
          } else if (eventType === EVENT_SessionFinished) {
            clearTimeout(timeout); cleanup();
            resolve(Buffer.concat(audioChunks));
          } else if (eventType === EVENT_SessionFailed) {
            clearTimeout(timeout); cleanup();
            reject(new Error('TTS session failed'));
          }
        } else if (hdr.messageType === ERROR_INFORMATION) {
          clearTimeout(timeout); cleanup();
          reject(new Error('TTS error'));
        }
      } catch (err) { /* ignore parse errors */ }
    });

    ws.on('error', (err: Error) => { clearTimeout(timeout); cleanup(); reject(err); });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (audioChunks.length > 0) resolve(Buffer.concat(audioChunks));
      else if (!sessionStarted) reject(new Error('TTS WS closed early'));
    });
  });
}

// Convert PCM (24kHz, 16-bit, mono) to WAV for browser playback
function pcmToWav(pcm: Buffer): Buffer {
  const sampleRate = 24000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const dataSize = pcm.length;
  const headerSize = 44;

  const wav = Buffer.alloc(headerSize + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);        // Subchunk1Size
  wav.writeUInt16LE(1, 20);         // AudioFormat (PCM)
  wav.writeUInt16LE(numChannels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcm.copy(wav, headerSize);
  return wav;
}

function startAsrSession(clientWs: WebSocket): AsrSession {
  const asrSession: AsrSession = {
    volcanoWs: null, ready: false, pendingChunks: [],
    allChunks: [], ended: false, retryCount: 0, gotResult: false,
    cancelled: false,
  };
  connectVolcano(asrSession, clientWs);
  return asrSession;
}

// Voice clients
const voiceClients = new Map<string, WebSocket>();

// Login page HTML — dynamic to support multi-user mode
function getLoginHtml(): string {
  const usernameField = isMultiUser
    ? `<input type="text" id="username" placeholder="Username" data-i18n-placeholder="login.placeholder_username" autofocus autocomplete="username" autocapitalize="off">`
    : '';
  const passwordAutofocus = isMultiUser ? '' : ' autofocus';
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hopcode">
  <link rel="manifest" href="./manifest.json">
  <link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
  <title>Hopcode - Login</title>
  <script>${getI18nScript()}</script>
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
    <h1 data-i18n="portal.heading">Hopcode</h1>
    <div class="error" id="error" data-i18n="login.error_incorrect">Incorrect password</div>
    <form onsubmit="return login()">
      ${usernameField}
      <input type="password" id="password" data-i18n-placeholder="login.placeholder_password" placeholder="Password"${passwordAutofocus}>
      <button type="submit" data-i18n="login.btn">Login</button>
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
            var ret = new URLSearchParams(location.search).get('return');
            if (ret && ret.startsWith('/')) { location.href = ret; } else { location.reload(); }
          } else {
            document.getElementById('error').textContent = d.error || _t('login.error_incorrect');
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
  const isRoot = isAdminUser(username);
  let sessionList: { id: string; name: string; owner: string; createdAt: number; lastActivity: number; clients: number; mode?: string; project?: string; sharedWith?: string[]; onlineUsers?: string[] }[] = [];
  try {
    // Root sees all sessions; other users see only their own
    const ownerQuery = isMultiUser && username && !isRoot ? `?owner=${encodeURIComponent(username)}` : '';
    const resp = await ptyFetch('/sessions' + ownerQuery);
    if (resp.ok) {
      const list: SessionInfo[] = await resp.json() as SessionInfo[];
      sessionList = list.map(s => ({ id: s.id, name: s.name, owner: s.owner, createdAt: s.createdAt, lastActivity: s.lastActivity, clients: s.clientCount }));
    }
  } catch {}
  // Append Easy Mode sessions
  for (const [id, info] of easySessions) {
    if (isMultiUser && username && !isRoot && info.owner !== username && !info.sharedWith.has(username)) continue;
    if (sessionList.some(s => s.id === id)) continue;
    const onlineUsers = Array.from(info.connectedUsers.keys());
    sessionList.push({ id, name: info.name, owner: info.owner, createdAt: info.createdAt, lastActivity: info.lastActivity || info.createdAt, clients: onlineUsers.length, mode: 'easy', project: info.project, sharedWith: info.sharedWith.size > 0 ? Array.from(info.sharedWith) : undefined, onlineUsers: onlineUsers.length > 0 ? onlineUsers : undefined });
  }
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
    const barClass = s.mode === 'easy' ? 'bar-easy' : (isActive ? 'bar-active' : 'bar-idle');
    const href = s.mode === 'easy'
      ? `/terminal/easy?session=${encodeURIComponent(s.id)}${s.project ? '&project=' + encodeURIComponent(s.project) : ''}`
      : `/terminal?session=${encodeURIComponent(s.id)}`;
    // Collaboration badge for shared sessions
    let collabBadge = '';
    if (s.sharedWith && s.sharedWith.length > 0) {
      const allMembers = [s.owner, ...s.sharedWith];
      const onlineSet = new Set(s.onlineUsers || []);
      const avatars = allMembers.slice(0, 3).map(u => {
        const initial = u.charAt(0).toUpperCase();
        const online = onlineSet.has(u) ? ' collab-online' : '';
        return '<span class="collab-avatar' + online + '" title="' + esc(u) + '">' + esc(initial) + '</span>';
      }).join('');
      const extra = allMembers.length > 3 ? '<span class="collab-extra">+' + (allMembers.length - 3) + '</span>' : '';
      collabBadge = '<div class="collab-badge">' + avatars + extra + '</div>';
    }
    const shareBtn = s.mode === 'easy' ? `<button class="share-btn" data-session-id="${esc(s.id)}" title="Share" onclick="event.preventDefault();event.stopPropagation();showShareModal('${esc(s.id)}','${esc(s.name)}')">&#x1F517;</button>` : '';
    return `<a class="session-card" href="${href}" data-session-id="${esc(s.id)}">
      <div class="card-bar ${barClass}"></div>
      <div class="session-info">
        <div class="session-name" data-session="${esc(s.id)}"><span class="session-name-text">${esc(s.name)}</span></div>
        <div class="session-meta">${fmtAge(s.lastActivity)}${collabBadge}</div>
      </div>
      ${shareBtn}
      <button class="rename-btn" data-i18n-title="portal.rename_title" title="Rename session">&#9998;</button>
      <button class="delete-btn" data-i18n-title="portal.delete_title" title="Delete session">&times;</button>
    </a>`;
  }

  let cardsHtml = '';
  if (sessionList.length === 0) {
    cardsHtml = '<div class="empty-state"><p data-i18n="portal.empty_title">No active sessions</p><p class="empty-sub" data-i18n="portal.empty_sub">Create one to get started</p></div>';
  } else if (isRoot) {
    // Group by owner, root's own sessions first
    const groups = new Map<string, typeof sessionList>();
    for (const s of sessionList) {
      const arr = groups.get(s.owner) || [];
      arr.push(s);
      groups.set(s.owner, arr);
    }
    const sortedOwners = Array.from(groups.keys()).sort((a, b) => {
      // Current admin user's sessions first, then other admins, then alphabetical
      if (a === username) return -1;
      if (b === username) return 1;
      if (isAdminUser(a) !== isAdminUser(b)) return isAdminUser(a) ? -1 : 1;
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
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hopcode">
  <link rel="manifest" href="./manifest.json">
  <link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
  <title>Hopcode - Sessions</title>
  <script>${getI18nScript()}</script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { min-height: 100%; background: #111827; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; color: #e5e7eb; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px 16px; }

    /* Header */
    .header { margin-bottom: 16px; }
    .header-row1 { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
    .header-brand { display: flex; align-items: center; gap: 8px; }
    .header-brand img { width: 28px; height: 28px; border-radius: 6px; }
    .header-brand h1 { color: #4ade80; font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
    .header-meta { display: flex; align-items: center; gap: 8px; }
    .user-info { color: #6b7280; font-size: 12px; }
    .admin-link { color: #60a5fa; font-size: 12px; text-decoration: none; padding: 4px 8px; border-radius: 6px; transition: all 0.15s; }
    .admin-link:hover { color: #93c5fd; background: rgba(96,165,250,0.1); }
    .logout-btn { color: #6b7280; font-size: 12px; text-decoration: none; padding: 4px 8px; border-radius: 6px; transition: all 0.15s; }
    .logout-btn:hover { color: #f87171; background: rgba(248,113,113,0.1); }
    .header-row2 { display: flex; align-items: center; justify-content: center; gap: 8px; }
    .mode-toggle { display: flex; background: #1f2937; border-radius: 8px; overflow: hidden; border: 1px solid #374151; flex-shrink: 0; }
    .mode-btn { padding: 6px 14px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; background: none; color: #6b7280; transition: all 0.15s; text-decoration: none; display: inline-block; -webkit-tap-highlight-color: transparent; white-space: nowrap; }
    .mode-btn.active { background: #3b82f6; color: #fff; }
    .mode-btn:not(.active):hover { color: #d1d5db; }
    .new-btn {
      padding: 6px 14px; background: #4ade80; color: #000; border: none;
      border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer;
      text-decoration: none; display: inline-block; white-space: nowrap;
      -webkit-tap-highlight-color: transparent; transition: background 0.15s;
    }
    .new-btn:hover { background: #22c55e; }
    .lang-btn { background: #1f2937; border: 1px solid #374151; color: #9ca3af; font-size: 12px; cursor: pointer; padding: 6px 10px; border-radius: 8px; font-weight: 600; white-space: nowrap; }

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
    .bar-easy { background: #60a5fa; }
    .session-info { flex: 1; min-width: 0; padding: 14px 12px; }
    .session-name { display: flex; align-items: center; }
    .session-name-text { font-size: 15px; font-weight: 600; color: #f3f4f6; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .session-meta { font-size: 12px; color: #6b7280; margin-top: 2px; display:flex; align-items:center; gap:6px; }
    .collab-badge { display:inline-flex; align-items:center; gap:0; margin-left:4px; }
    .collab-avatar { width:18px; height:18px; border-radius:50%; background:#4b5563; color:#fff; font-size:10px; font-weight:600; display:inline-flex; align-items:center; justify-content:center; margin-left:-4px; border:1.5px solid #1e293b; }
    .collab-avatar:first-child { margin-left:0; }
    .collab-avatar.collab-online { background:#22c55e; border-color:#166534; }
    .collab-extra { font-size:10px; color:#9ca3af; margin-left:3px; }

    /* Card action buttons */
    .rename-btn, .delete-btn, .share-btn {
      background: none; border: none; color: #6b7280; line-height: 1;
      cursor: pointer; flex-shrink: 0;
      transition: opacity 0.15s, color 0.15s;
      -webkit-tap-highlight-color: transparent;
    }
    .share-btn { font-size: 14px; padding: 14px 4px 14px 8px; }
    .share-btn:hover { color: #60a5fa; }
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
    .toast-msg {
      position: fixed; bottom: 40px; left: 50%; transform: translateX(-50%) translateY(20px);
      background: #1f2937; color: #e5e7eb; padding: 10px 24px; border-radius: 20px;
      font-size: 14px; opacity: 0; transition: opacity 0.3s, transform 0.3s;
      z-index: 2000; pointer-events: none; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }
    .toast-msg.show { opacity: 1; transform: translateX(-50%) translateY(0); }

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
      .header-brand h1 { font-size: 18px; }
      .header-row2 { flex-wrap: wrap; }
      .mode-btn { padding: 6px 10px; font-size: 12px; }
      .new-btn { padding: 6px 10px; font-size: 12px; }
      .session-info { padding: 12px 10px; }
      .session-name-text { font-size: 14px; }
      .delete-btn { opacity: 0.7; }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="header-row1">
        <div class="header-brand">
          <img src="./icons/favicon.svg" alt="">
          <h1 data-i18n="portal.heading">Hopcode</h1>
        </div>
        <div class="header-meta">
          ${isMultiUser && username ? `<span class="user-info">${esc(username)}</span>` : ''}
          ${isRoot ? `<a class="admin-link" href="/terminal/admin" data-i18n="portal.admin">Admin</a>` : ''}
          <button class="lang-btn" id="lang-toggle" onclick="_setLang(_lang==='en'?'zh':'en')">EN/中</button>
          <a class="logout-btn" href="/terminal/logout" data-i18n="portal.btn_logout">Logout</a>
        </div>
      </div>
      <div class="header-row2">
        <div class="mode-toggle">
          <a class="mode-btn" id="mode-easy" href="/terminal/easy" data-i18n="portal.mode_easy">Easy Mode</a>
          <a class="mode-btn" id="mode-pro" href="/terminal?action=new" data-i18n="portal.mode_pro">Pro Mode</a>
        </div>
        <a class="new-btn" id="new-project-btn" href="/terminal/easy" data-i18n="portal.btn_new_project">+ New Project</a>
      </div>
    </div>
    <div class="session-list">${cardsHtml}</div>
  </div>

  <script>
  (function() {
    // --- Mode toggle with localStorage ---
    var modeEasy = document.getElementById('mode-easy');
    var modePro = document.getElementById('mode-pro');
    var newBtn = document.getElementById('new-project-btn');
    var hasToggle = !!(modeEasy && modePro);
    var savedMode = hasToggle ? (localStorage.getItem('hopcode-mode') || 'easy') : 'pro';

    function setMode(mode) {
      savedMode = mode;
      localStorage.setItem('hopcode-mode', mode);
      if (hasToggle) {
        modeEasy.classList.toggle('active', mode === 'easy');
        modePro.classList.toggle('active', mode === 'pro');
      }
      if (newBtn) {
        newBtn.href = mode === 'easy' ? '/terminal/easy' : '/terminal?action=new';
      }
    }
    setMode(savedMode);
    if (modeEasy) modeEasy.addEventListener('click', function(e) { e.preventDefault(); setMode('easy'); });
    if (modePro) modePro.addEventListener('click', function(e) { e.preventDefault(); setMode('pro'); });

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
        '<p>' + _t('portal.confirm_delete', {name: sessionName.replace(/</g,'&lt;')}) + '</p>' +
        '<div class="confirm-btns">' +
        '<button class="btn-cancel">' + _t('cancel') + '</button>' +
        '<button class="btn-delete">' + _t('delete') + '</button>' +
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
            if (d.left) {
              showToast(_t('portal.left_session'));
            }
          }
        }).catch(function() { overlay.remove(); });
      };
    }

    function showToast(msg) {
      var toast = document.createElement('div');
      toast.className = 'toast-msg';
      toast.textContent = msg;
      document.body.appendChild(toast);
      setTimeout(function() { toast.classList.add('show'); }, 10);
      setTimeout(function() { toast.classList.remove('show'); setTimeout(function() { toast.remove(); }, 300); }, 2500);
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

  // --- QR Share Modal ---
  var _qrModal = null;
  function showShareModal(sessionId, sessionName) {
    // Create modal if not exists
    if (!_qrModal) {
      _qrModal = document.createElement('div');
      _qrModal.id = 'share-modal';
      _qrModal.innerHTML = '<div class="share-backdrop"></div><div class="share-box"><div class="share-close">&times;</div><div class="share-title"></div><div class="share-qr" id="share-qr"></div><div class="share-desc" data-i18n="portal.share_scan"></div><div class="share-actions"><button class="share-copy-btn" id="share-copy-btn" data-i18n="portal.share_copy">Copy Link</button></div></div>';
      document.body.appendChild(_qrModal);
      // Add styles
      var st = document.createElement('style');
      st.textContent = '#share-modal{position:fixed;inset:0;z-index:3000;display:flex;align-items:center;justify-content:center}.share-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.6)}.share-box{position:relative;background:#1f2937;border:1px solid #374151;border-radius:16px;padding:24px;max-width:340px;width:calc(100% - 40px);text-align:center;z-index:1}.share-close{position:absolute;top:10px;right:14px;font-size:22px;color:#6b7280;cursor:pointer}.share-close:hover{color:#f3f4f6}.share-title{font-size:16px;font-weight:600;color:#f3f4f6;margin-bottom:16px}.share-qr{display:flex;justify-content:center;margin-bottom:12px}.share-qr canvas,.share-qr img{border-radius:8px}.share-desc{font-size:13px;color:#9ca3af;margin-bottom:16px}.share-actions{display:flex;gap:10px;justify-content:center}.share-copy-btn{padding:10px 24px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}.share-copy-btn:hover{background:#2563eb}.share-copy-btn.copied{background:#22c55e}';
      document.head.appendChild(st);
      _qrModal.querySelector('.share-backdrop').addEventListener('click', function() { _qrModal.style.display = 'none'; });
      _qrModal.querySelector('.share-close').addEventListener('click', function() { _qrModal.style.display = 'none'; });
    }
    _qrModal.style.display = 'flex';
    _qrModal.querySelector('.share-title').textContent = _t('portal.share') + ': ' + sessionName;
    var qrContainer = document.getElementById('share-qr');
    qrContainer.innerHTML = '<div style="color:#6b7280;padding:20px;">Loading...</div>';

    // Fetch guest link
    fetch('/terminal/api/guest-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId: sessionId })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (!data.url) { qrContainer.innerHTML = '<div style="color:#f87171">Error: ' + (data.error || 'Unknown') + '</div>'; return; }
      var shareUrl = data.url;

      // Load qrcode-generator from CDN
      if (window.qrcode) {
        renderQR(shareUrl);
      } else {
        var sc = document.createElement('script');
        sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
        sc.onload = function() { renderQR(shareUrl); };
        sc.onerror = function() { qrContainer.innerHTML = '<div style="color:#f87171">Failed to load QR library</div>'; };
        document.head.appendChild(sc);
      }

      function renderQR(url) {
        var qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        qrContainer.innerHTML = qr.createSvgTag(5, 8);
        var svg = qrContainer.querySelector('svg');
        if (svg) { svg.style.borderRadius = '8px'; svg.style.background = '#fff'; svg.style.padding = '8px'; }
      }

      // Copy button
      var copyBtn = document.getElementById('share-copy-btn');
      copyBtn.onclick = function() {
        navigator.clipboard.writeText(shareUrl).then(function() {
          copyBtn.textContent = _t('portal.share_copied');
          copyBtn.classList.add('copied');
          setTimeout(function() { copyBtn.textContent = _t('portal.share_copy'); copyBtn.classList.remove('copied'); }, 2000);
        });
      };
    }).catch(function(err) {
      qrContainer.innerHTML = '<div style="color:#f87171">Error: ' + err.message + '</div>';
    });
  }
  </script>
  <script>if('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js');</script>
</body>
</html>`;
  return html;
}

// Easy Mode HTML page — terminal-free chat UI for beginners
// Guest error page
function getGuestErrorHtml(message: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hopcode</title>
<script>${getI18nScript()}</script>
<style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}.card{background:#fff;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}h2{margin:0 0 12px;font-size:20px}p{margin:0 0 24px;color:#86868b;font-size:15px;line-height:1.5}a{display:inline-block;padding:10px 24px;background:#007aff;color:#fff;border-radius:8px;text-decoration:none;font-size:15px}a:hover{background:#0066d6}</style></head>
<body><div class="card"><h2>${message}</h2><p></p><a href="/">${t('en', 'login.btn')}</a></div></body></html>`;
}

function getGuestLandingHtml(lang: string, sessionName: string, ownerName: string, guestUrl: string, loginReturnUrl: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<title>Hopcode - ${esc(t(lang, 'guest.landing_title'))}</title>
<script>${getI18nScript()}</script>
<link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,system-ui,'Segoe UI',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#667eea 0%,#764ba2 100%);padding:20px}
.landing{background:#fff;border-radius:20px;padding:36px 28px;max-width:380px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.2);text-align:center}
.landing-icon{font-size:48px;margin-bottom:16px}
.landing h2{font-size:20px;color:#1d1d1f;margin-bottom:6px;font-weight:700}
.landing .session-name{font-size:15px;color:#86868b;margin-bottom:4px}
.landing .owner-name{font-size:13px;color:#aeaeb2;margin-bottom:20px}
.landing .desc{font-size:14px;color:#636366;margin-bottom:24px;line-height:1.5}
.choice-btn{display:block;width:100%;padding:14px 20px;border-radius:12px;border:none;font-size:16px;font-weight:600;cursor:pointer;text-decoration:none;text-align:center;transition:all .15s ease;margin-bottom:12px}
.choice-btn:active{transform:scale(.97)}
.btn-login{background:#007aff;color:#fff}
.btn-login:hover{background:#0066d6}
.btn-guest{background:#f5f5f7;color:#1d1d1f;border:1px solid #d2d2d7}
.btn-guest:hover{background:#e8e8ed}
.choice-sub{font-size:12px;color:#aeaeb2;margin-top:-6px;margin-bottom:14px}
.divider{display:flex;align-items:center;gap:12px;margin:16px 0;color:#aeaeb2;font-size:13px}
.divider::before,.divider::after{content:'';flex:1;height:1px;background:#e5e5ea}
</style></head>
<body>
<div class="landing">
  <div class="landing-icon">&#x1F91D;</div>
  <h2>${esc(t(lang, 'guest.landing_title'))}</h2>
  <div class="session-name">${esc(sessionName)}</div>
  ${ownerName ? `<div class="owner-name">by ${esc(ownerName)}</div>` : ''}
  <div class="desc">${esc(t(lang, 'guest.landing_desc'))}</div>
  <a class="choice-btn btn-login" href="/?return=${encodeURIComponent(loginReturnUrl)}">${esc(t(lang, 'guest.login'))}</a>
  <div class="choice-sub">${esc(t(lang, 'guest.login_desc'))}</div>
  <div class="divider">${esc(t(lang, 'guest.or'))}</div>
  <a class="choice-btn btn-guest" href="${esc(guestUrl)}">${esc(t(lang, 'guest.join_as_guest'))}</a>
  <div class="choice-sub">${esc(t(lang, 'guest.join_guest_desc'))}</div>
</div>
</body></html>`;
}

interface GuestOptions {
  guestMode?: boolean;
  guestSessionId?: string;
  guestToken?: string;
  guestExpires?: string;
}

function getEasyModeHtml(auth: AuthInfo, guestOpts?: GuestOptions): string {
  const isGuest = guestOpts?.guestMode || false;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<title>Hopcode Easy Mode</title>
<script>${getI18nScript()}</script>
<link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
<link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<style>
* { margin:0; padding:0; box-sizing:border-box; -webkit-user-select:none; user-select:none; -webkit-touch-callout:none; }
#input-bar, #input-bar *, #quick-actions, #quick-actions *, #tab-bar, #tab-bar *, .fp-header, .fp-actions, .fp-actions * { -webkit-user-select:none !important; user-select:none !important; pointer-events:auto; }
html, body { height:100%; overflow:hidden; font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','Helvetica Neue',sans-serif; background:#f5f5f7; color:#1d1d1f; }
#msg-input, .msg, .msg *, #debug-log { -webkit-user-select:text; user-select:text; }

#app { display:flex; flex-direction:column; height:100%; height:100dvh; }

/* Top bar — hidden, controls moved to bottom menu */
#top-bar { display:none; }
#project-bar { display:none; }

/* Bottom menu sheet */
#menu-overlay { position:fixed; inset:0; background:rgba(0,0,0,0.3); z-index:150; display:none; }
#menu-overlay.show { display:block; }
#menu-sheet { position:fixed; left:0; right:0; bottom:0; background:#ffffff; border-top-left-radius:16px; border-top-right-radius:16px; z-index:151; transform:translateY(100%); transition:transform 0.25s ease; max-height:70vh; overflow-y:auto; padding-bottom:env(safe-area-inset-bottom, 12px); box-shadow:0 -4px 20px rgba(0,0,0,0.1); }
#menu-sheet.show { transform:translateY(0); }
#menu-sheet .menu-handle { width:36px; height:4px; background:#d2d2d7; border-radius:2px; margin:10px auto; }
.menu-section { padding:4px 0; }
.menu-section-title { padding:8px 20px 4px; font-size:11px; color:#86868b; text-transform:uppercase; letter-spacing:0.5px; }
#menu-projects-wrap { display:none; }
#menu-projects-wrap.open { display:block; }
.menu-item { display:flex; align-items:center; padding:12px 20px; gap:12px; cursor:pointer; font-size:14px; color:#1d1d1f; }
.menu-item:active { background:rgba(0,0,0,0.04); }
.menu-item .mi-icon { width:20px; text-align:center; color:#86868b; font-size:16px; flex-shrink:0; }
.menu-item .mi-label { flex:1; }
.menu-item .mi-badge { font-size:11px; color:#86868b; }
.menu-item .mi-arrow { color:#c7c7cc; font-size:12px; }
.menu-item.active .mi-label { color:#34c759; font-weight:600; }
.menu-item.active .mi-icon { color:#34c759; }
.menu-divider { height:1px; background:#e5e5ea; margin:4px 16px; }

/* Project/session list in menu */
.menu-proj-list { max-height:240px; overflow-y:auto; padding:2px 0; }
.menu-proj-item { display:flex; align-items:center; gap:8px; padding:10px 20px; cursor:pointer; font-size:14px; color:#1d1d1f; text-decoration:none; position:relative; }
.menu-proj-item:active { background:rgba(0,0,0,0.04); }
.menu-proj-item.current { color:#007aff; font-weight:600; }
.menu-proj-dot { width:6px; height:6px; border-radius:50%; background:#d2d2d7; flex-shrink:0; }
.menu-proj-dot.active { background:#34c759; }
.menu-proj-dot.current { background:#007aff; }
.menu-proj-name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.menu-proj-actions { display:none; gap:4px; flex-shrink:0; }
.menu-proj-item:hover .menu-proj-actions { display:flex; }
@media (pointer:coarse) { .menu-proj-actions { display:flex; } }
.menu-proj-act { background:none; border:none; color:#86868b; font-size:13px; cursor:pointer; padding:4px 6px; border-radius:4px; line-height:1; }
.menu-proj-act:active { background:rgba(0,0,0,0.06); }
.menu-proj-act.delete { color:#ff3b30; }
.menu-proj-rename-input { background:#f0f0f2; border:1.5px solid #007aff; border-radius:6px; color:#1d1d1f; font-size:14px; padding:4px 8px; flex:1; outline:none; font-family:inherit; }

/* Status in menu */
.menu-status { display:flex; align-items:center; gap:8px; padding:12px 20px; }
.menu-status .status-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
.menu-status .status-dot.green { background:#34c759; }
.menu-status .status-dot.yellow { background:#ff9f0a; animation:pulse 1.5s infinite; }
.menu-status .status-dot.red { background:#ff3b30; }
.menu-status .status-dot.blue { background:#007aff; animation:pulse 1.5s infinite; }
.menu-status .status-label { font-size:13px; color:#86868b; }

/* Font size controls in menu */
.menu-font-row { display:flex; align-items:center; gap:8px; padding:8px 20px; }
.menu-font-row .mf-label { font-size:13px; color:#86868b; min-width:60px; }
.menu-font-row .mf-btn { width:36px; height:36px; border-radius:8px; border:1px solid #d2d2d7; background:#ffffff; color:#1d1d1f; font-size:16px; cursor:pointer; display:flex; align-items:center; justify-content:center; }
.menu-font-row .mf-btn:active { background:#e5e5ea; }
.menu-font-row .mf-val { font-size:14px; color:#1d1d1f; min-width:40px; text-align:center; font-weight:600; }

/* Menu button in input bar */
#menu-btn { background:none; border:none; color:#86868b; }
#menu-btn svg { width:22px; height:22px; }
#menu-btn:active { color:#1d1d1f; }

/* Legacy — keep for JS but hide */
.top-btn { display:none; }
.project-chip { padding:4px 12px; border-radius:14px; font-size:13px; background:#e5e5ea; color:#86868b; border:1px solid #d2d2d7; cursor:pointer; white-space:nowrap; flex-shrink:0; }
.project-chip.active { background:#e3f2fd; color:#007aff; border-color:#007aff; }
.project-chip.add { color:#34c759; border-color:#34c759; background:#f0fff4; }

/* Tab bar */
#tab-bar { display:flex; flex-shrink:0; background:#ffffff; border-bottom:1px solid #e5e5ea; padding:0 12px; gap:0; }
.tab-item { flex:1; padding:8px 0; text-align:center; font-size:13px; color:#86868b; cursor:pointer; border-bottom:2px solid transparent; position:relative; }
.tab-item.active { color:#1d1d1f; border-bottom-color:#007aff; }
.tab-badge { position:absolute; top:4px; right:calc(50% - 28px); width:6px; height:6px; border-radius:50%; background:#007aff; display:none; }
.tab-badge.show { display:block; }

/* Preview frame */
#preview-container { display:none; flex:1; flex-direction:column; overflow:hidden; background:#ffffff; }
#preview-container.show { display:flex; }
#preview-bar { display:flex; align-items:center; padding:4px 10px; background:#f5f5f7; gap:6px; flex-shrink:0; border-bottom:1px solid #e5e5ea; flex-wrap:nowrap; }
#preview-bar-actions { display:flex; align-items:center; gap:6px; margin-left:auto; flex-shrink:0; }
#preview-nav { display:flex; gap:4px; overflow:hidden; min-width:0; flex:1; align-items:center; transition:all 0.2s; }
#preview-nav.collapsed { display:none; }
#preview-nav-toggle { font-size:10px; padding:3px 6px; transition:transform 0.2s; }
#preview-nav-toggle.collapsed { transform:rotate(-90deg); }
.preview-pill { display:inline-flex; align-items:center; padding:4px 8px; border-radius:12px; font-size:11px; cursor:pointer; border:1px solid #d2d2d7; max-width:120px; background:#e8f0fe; color:#1a73e8; font-family:'SF Mono',Monaco,monospace; transition:all 0.15s; flex-shrink:0; }
.preview-pill > span:first-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.preview-pill.more-pill { background:#f5f5f7; color:#86868b; border-color:#d2d2d7; font-family:system-ui; max-width:none; position:relative; }
.preview-more-menu { position:absolute; bottom:100%; left:0; background:#fff; border:1px solid #d2d2d7; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.12); padding:4px 0; z-index:50; min-width:160px; display:none; }
.preview-more-menu.show { display:block; }
.preview-more-item { padding:8px 14px; font-size:13px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; color:#1a73e8; }
.preview-more-item:hover { background:#f5f5f7; }
.preview-more-item.active { font-weight:600; }
.preview-pill:hover { background:#d2e3fc; border-color:#1a73e8; }
.preview-pill .pill-del { display:none; margin-left:2px; font-size:13px; line-height:1; color:inherit; opacity:0.5; cursor:pointer; }
.preview-pill:hover .pill-del { display:inline; }
.preview-pill .pill-del:hover { opacity:1; }
.preview-pill.active { background:#1a73e8; color:#fff; border-color:#1a73e8; }
.preview-pill.welcome-pill { background:#fef3c7; color:#92400e; border-color:#fbbf24; font-family:system-ui; }
.preview-pill.welcome-pill:hover { background:#fde68a; border-color:#f59e0b; }
.preview-pill.welcome-pill.active { background:#f59e0b; color:#fff; border-color:#f59e0b; }
/* Mobile preview dropdown */
.preview-dropdown-wrap { position:relative; min-width:0; flex:1; }
.preview-dropdown-btn { display:flex; align-items:center; gap:4px; background:#e8f0fe; border:1px solid #d2d2d7; border-radius:8px; padding:5px 10px; font-size:13px; color:#1a73e8; cursor:pointer; min-width:0; max-width:100%; font-family:'SF Mono',Monaco,monospace; }
.preview-dropdown-btn:active { background:#d2e3fc; }
.pdd-label { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; min-width:0; }
.pdd-arrow { font-size:8px; color:#86868b; flex-shrink:0; transition:transform 0.2s; }
.preview-dropdown-menu { display:none; position:fixed; left:8px; right:8px; background:#fff; border:1px solid #d2d2d7; border-radius:10px; box-shadow:0 4px 16px rgba(0,0,0,0.12); padding:4px 0; z-index:200; max-height:240px; overflow-y:auto; }
.preview-dropdown-menu.show { display:block; }
.pdd-item { display:flex; align-items:center; padding:10px 12px; font-size:13px; cursor:pointer; gap:8px; }
.pdd-item:active { background:#f5f5f7; }
.pdd-item.active { background:#e8f0fe; font-weight:600; color:#1a73e8; }
.pdd-item-label { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-family:'SF Mono',Monaco,monospace; }
.pdd-item-del { color:#ff3b30; font-size:18px; line-height:1; padding:0 4px; flex-shrink:0; opacity:0.6; }
.pdd-item-del:active { opacity:1; }

.preview-action { background:#ffffff; border:1px solid #d2d2d7; color:#86868b; border-radius:6px; padding:3px 10px; font-size:11px; cursor:pointer; white-space:nowrap; }
.preview-action:active { background:#e5e5ea; }
#preview-guide { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:20px; overflow-y:auto; }
#preview-frame { flex:1; border:none; background:#fff; display:none; }
#preview-frame.loaded { display:block; }
#preview-container.fullscreen { position:fixed; inset:0; z-index:9999; width:100vw; height:100vh; background:#fff; }
#preview-container.fullscreen #preview-bar { display:none !important; }
#preview-container.fullscreen #preview-frame { width:100%; height:100%; }
.fullscreen-exit { display:none; position:fixed; top:8px; right:8px; z-index:10000; background:rgba(0,0,0,0.5); color:#fff; border:none; border-radius:50%; width:32px; height:32px; font-size:16px; cursor:pointer; line-height:32px; text-align:center; opacity:0.4; transition:opacity 0.2s; }
.fullscreen-exit:hover { opacity:1; background:rgba(0,0,0,0.8); }
#preview-container.fullscreen .fullscreen-exit { display:block; }

/* Main content wrapper */
#main-content { display:flex; flex-direction:column; flex:1; overflow:hidden; min-height:0; }

/* Left panel (desktop: sidebar with files + chat) */
#left-panel { display:flex; flex-direction:column; flex:1; min-height:0; }

/* Chat area */
#chat-area { flex:1; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:8px; }
.msg { max-width:92%; padding:10px 14px; border-radius:18px; font-size:var(--easy-font-size, 15px); line-height:1.5; word-break:break-word; overflow-wrap:break-word; white-space:pre-wrap; animation:fadeIn 0.15s ease; }
@keyframes fadeIn { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:translateY(0); } }
.msg.user { align-self:flex-end; background:#95ec69; color:#1d1d1f; border-bottom-right-radius:6px; }
.msg-wrap { display:block; max-width:92%; align-self:flex-start; }
.msg-wrap .msg { display:inline-block; max-width:100%; text-align:left; }
.msg-wrap .msg-sender { font-size:12px; color:#999; margin-bottom:2px; padding-left:4px; }
.msg-wrap .msg.user { background:#e9e9eb; color:#1d1d1f; border-bottom-right-radius:18px; border-bottom-left-radius:6px; }
#participants-indicator { font-size:11px; color:#86868b; margin-left:8px; cursor:default; }
#participants-bar { display:none; padding:6px 12px; background:#f5f5f7; border-bottom:1px solid #e0e0e0; flex-shrink:0; overflow-x:auto; white-space:nowrap; -webkit-overflow-scrolling:touch; }
#participants-bar .p-chip { display:inline-flex; align-items:center; gap:4px; padding:3px 10px; margin-right:6px; background:#fff; border:1px solid #e0e0e0; border-radius:14px; font-size:12px; color:#1d1d1f; cursor:pointer; user-select:none; transition:background .15s; }
#participants-bar .p-chip:hover { background:#e8f0fe; border-color:#007aff; }
#participants-bar .p-chip:active { background:#d0e2ff; }
#participants-bar .p-chip .p-dot { width:6px; height:6px; border-radius:50%; background:#34c759; flex-shrink:0; }
#participants-bar .p-chip .p-role { font-size:10px; color:#86868b; }
#participants-bar .p-chip.offline { opacity:0.5; }
#participants-bar .p-chip .p-dot.offline { background:#c7c7cc; }
#participants-bar .p-chip.ai-chip { background:#f3e8ff; border-color:#c084fc; }
#participants-bar .p-chip.ai-chip:hover { background:#ede4ff; border-color:#a855f7; }
#participants-bar .p-dot.busy { background:#007aff; animation:pulse 1.5s infinite; }
#participants-bar .p-dot.queued { background:#ff9f0a; animation:pulse 1.5s infinite; }
#participants-bar .p-dot.error { background:#ff3b30; }
#participants-bar .p-dot.initializing { background:#ff9f0a; animation:pulse 1.5s infinite; }
.mention { color:#007aff; font-weight:500; }
.msg.mentioned { border-left:3px solid #007aff; padding-left:9px; }
#mention-dropdown { display:none; position:absolute; bottom:100%; left:0; right:0; background:#fff; border:1px solid #e0e0e0; border-radius:10px; max-height:200px; overflow-y:auto; z-index:1000; margin-bottom:4px; box-shadow:0 -4px 16px rgba(0,0,0,.12); }
.mention-item { display:flex; align-items:center; gap:8px; padding:10px 14px; cursor:pointer; font-size:14px; }
.mention-item:first-child { border-radius:10px 10px 0 0; }
.mention-item:last-child { border-radius:0 0 10px 10px; }
.mention-item:only-child { border-radius:10px; }
.mention-item.active, .mention-item:hover { background:#f0f0f5; }
.mention-avatar { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:13px; font-weight:600; color:#fff; flex-shrink:0; }
.mention-name { flex:1; }
.msg-wrap.assistant-wrap .msg-sender { color:#8e44ad; }
.msg-wrap.user-wrap { align-self:flex-end; text-align:right; }
.msg-wrap.user-wrap .msg-sender { padding-right:4px; color:#2e7d32; }
.msg-wrap.user-wrap .msg.user { display:inline-block; text-align:left; background:#95ec69; color:#1d1d1f; border-bottom-right-radius:6px; border-bottom-left-radius:18px; }
.msg.assistant { background:#e9e9eb; color:#1d1d1f; border-bottom-left-radius:6px; font-family:'SF Mono',Monaco,Consolas,monospace; font-size:var(--easy-font-size, 15px); max-width:98%; }
.msg.assistant.thinking-msg { background:#f5f5f5; color:#8e8e93; font-size:calc(var(--easy-font-size, 15px) - 1px); font-style:italic; }
.msg.system { align-self:center; background:none; color:#86868b; font-size:12px; text-align:center; padding:4px 8px; }
.msg.error { align-self:center; background:#fff0f0; color:#ff3b30; border:1px solid #ffcdd2; font-size:13px; }
.retry-msg { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:center; }
.retry-btn { background:#ff3b30; color:#fff; border:none; border-radius:14px; padding:4px 14px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; }
.retry-btn:hover { background:#e0332b; }
.retry-btn:disabled { background:#ccc; cursor:default; }
.suggest-msg { display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-content:center; background:#f0f7ff !important; border:1px solid #c8dff8; }
.suggest-btn { background:#007aff; color:#fff; border:none; border-radius:14px; padding:4px 14px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; }
.suggest-btn:hover { background:#0063d1; }
.suggest-btn:disabled { background:#ccc; cursor:default; }

/* Thinking/loading indicator — inside assistant msg bubble */
.thinking-placeholder { min-height:36px; display:flex; align-items:center; }
.dot-spinner { display:flex; gap:4px; }
.dot-spinner span { width:6px; height:6px; background:#c7c7cc; border-radius:50%; animation:bounce 1.2s infinite; }
.dot-spinner span:nth-child(2) { animation-delay:0.2s; }
.dot-spinner span:nth-child(3) { animation-delay:0.4s; }
@keyframes bounce { 0%,80%,100% { transform:translateY(0); } 40% { transform:translateY(-8px); } }

/* Quick actions */
#quick-actions { display:none; padding:6px 12px; flex-shrink:0; gap:6px; justify-content:center; flex-wrap:wrap; background:#f5f5f7; border-top:1px solid #e5e5ea; }
#quick-actions.show { display:flex; }
.qa-btn { padding:6px 16px; border-radius:8px; border:1px solid #d2d2d7; background:#ffffff; color:#1d1d1f; font-size:14px; cursor:pointer; }
.qa-btn:active { background:#e5e5ea; }
.qa-btn.allow { border-color:#34c759; color:#248a3d; }
.qa-btn.deny { border-color:#ff3b30; color:#ff3b30; }
.qa-btn.always { border-color:#007aff; color:#007aff; font-size:12px; }

/* Input bar */
#input-bar { display:flex; align-items:flex-end; padding:8px 10px; background:#ffffff; border-top:1px solid #e5e5ea; flex-shrink:0; gap:8px; padding-bottom:max(8px, env(safe-area-inset-bottom, 8px)); }
#msg-input { flex:1; background:#f0f0f2; color:#1d1d1f; border:1px solid #d2d2d7; border-radius:20px; padding:9px 16px; font-size:var(--easy-font-size, 15px); min-height:40px; max-height:120px; resize:none; outline:none; font-family:inherit; line-height:1.4; overflow-y:auto; scrollbar-width:none; }
#msg-input::-webkit-scrollbar { display:none; }
#msg-input::-webkit-resizer { display:none; }
#msg-input:focus { background:#ffffff; border-color:#007aff; box-shadow:0 0 0 3px rgba(0,122,255,0.15); }
#msg-input::placeholder { color:#86868b; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.input-btn { width:40px; height:40px; border-radius:50%; border:none; cursor:pointer; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
#upload-btn { background:none; color:#86868b; }
#upload-btn svg { width:22px; height:22px; }
#upload-btn:active { color:#1d1d1f; }
#send-btn { background:#007aff; color:#fff; display:none; }
#send-btn svg { width:20px; height:20px; }
#send-btn:active { background:#0055d4; }
#send-btn.show { display:flex; }
#voice-toggle { background:none; border:none; color:#86868b; }
#voice-toggle svg { width:26px; height:26px; }
#voice-toggle:active { color:#1d1d1f; }
#voice-toggle.active { color:#007aff; }
#hold-speak { display:none; flex:1; height:40px; border-radius:20px; border:1px solid #d2d2d7; background:#f0f0f2; color:#1d1d1f; font-size:15px; cursor:pointer; text-align:center; line-height:40px; touch-action:none; -webkit-touch-callout:none; }
#hold-speak:active, #hold-speak.recording { background:#ffecec; border-color:#ff3b30; color:#ff3b30; }
#hold-speak.show { display:block; }
@keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.7; } }
@keyframes guestCtaSlideUp { from { opacity:0; transform:translateX(-50%) translateY(30px); } to { opacity:1; transform:translateX(-50%) translateY(0); } }

/* Resize handles — hidden on mobile */
.resize-handle { display:none; }

/* Desktop split layout */
@media (min-width: 768px) {
  #main-content { flex-direction:row; }
  #left-panel { width:35%; min-width:260px; flex:none; border-right:none; background:#ffffff; display:flex; flex-direction:column; overflow:hidden; }
  #main-content #preview-container { flex:1; display:flex; min-width:200px; }
  #tab-bar { display:none !important; }
  #input-bar { display:flex !important; padding-bottom:12px; }
  #quick-actions.show { display:flex !important; }
  /* Finder file browser — inline on desktop (always visible in left-panel) */
  #files-panel { display:flex !important; position:static !important; width:100% !important; border-left:none !important; border-right:none !important; z-index:auto !important; border-bottom:none; height:40%; flex-shrink:0; min-height:80px; overflow:hidden; }
  #files-panel .fp-close { display:none; }
  #files-panel .fp-collapse { display:block !important; }
  #files-overlay { display:none !important; }
  /* Chat area fills remaining space */
  #chat-area { flex:1; min-height:100px; }
  /* Swap button visible on desktop */
  #preview-swap { display:inline-block !important; }
  /* Swapped layout */
  #main-content.swapped { flex-direction:row-reverse; }
  #main-content.swapped #left-panel { border-right:none; border-left:none; }
  /* Resize handles */
  .resize-handle { display:block; flex-shrink:0; }
  .resize-h { width:5px; cursor:col-resize; background:transparent; position:relative; }
  .resize-h::after { content:''; position:absolute; top:0; bottom:0; left:2px; width:1px; background:#e5e5ea; }
  .resize-h:hover::after, .resize-h.active::after { width:3px; left:1px; background:#007aff; border-radius:2px; }
  .resize-v { height:5px; cursor:row-resize; background:transparent; position:relative; }
  .resize-v::after { content:''; position:absolute; left:0; right:0; top:2px; height:1px; background:#e5e5ea; }
  .resize-v:hover::after, .resize-v.active::after { height:3px; top:1px; background:#007aff; border-radius:2px; }
  #menu-overlay { background:transparent; }
  #menu-sheet { left:auto; right:auto; width:280px; bottom:auto; top:auto; max-height:60vh; border-radius:10px; box-shadow:0 4px 24px rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.06); transform:scale(0.95); opacity:0; transition:transform 0.15s ease, opacity 0.15s ease; pointer-events:none; }
  #menu-sheet .menu-handle { display:none; }
  #menu-sheet.show { transform:scale(1); opacity:1; pointer-events:auto; }
}

/* Welcome screen */
#welcome-screen { display:flex; flex-direction:column; align-items:center; justify-content:center; flex:1; padding:24px 16px; overflow-y:auto; background:#f5f5f7; }
#welcome-screen { transition:opacity 0.2s ease; }
#welcome-screen.hidden { opacity:0; pointer-events:none; position:absolute; }
.welcome-greeting { font-size:24px; font-weight:700; color:#1d1d1f; margin-bottom:4px; text-align:center; }
.welcome-sub { font-size:15px; color:#86868b; margin-bottom:24px; text-align:center; line-height:1.4; }
.welcome-cards { display:flex; flex-direction:row; gap:12px; width:100%; max-width:900px; flex-wrap:wrap; justify-content:center; }
.welcome-card { background:#ffffff; border-radius:16px; padding:20px; cursor:pointer; border:1px solid #e5e5ea; transition:all 0.2s ease; box-shadow:0 1px 4px rgba(0,0,0,0.04); flex:1 1 200px; max-width:280px; }
.welcome-card:hover { border-color:#007aff; box-shadow:0 2px 12px rgba(0,122,255,0.12); transform:translateY(-1px); }
.welcome-card:active { transform:scale(0.98); }
.welcome-card .wc-icon { font-size:32px; margin-bottom:8px; }
.welcome-card .wc-title { font-size:16px; font-weight:600; color:#1d1d1f; margin-bottom:4px; }
.welcome-card .wc-desc { font-size:13px; color:#86868b; line-height:1.4; }
.welcome-card .wc-time { display:inline-block; margin-top:8px; font-size:11px; color:#007aff; background:#f0f5ff; padding:2px 8px; border-radius:10px; }
.welcome-skip { margin-top:20px; font-size:13px; color:#86868b; background:none; border:none; cursor:pointer; text-decoration:underline; }
.welcome-skip:hover { color:#1d1d1f; }
@media (min-width: 768px) {
  .welcome-cards { flex-direction:row; max-width:900px; }
  .welcome-card { max-width:260px; }
  .welcome-greeting { font-size:24px; }
}

/* Files panel (mobile: tab content, fills main area) */
#files-panel { display:none; flex-direction:column; flex:1; background:#ffffff; overflow:hidden; min-height:0; }
#files-panel.open { display:flex; }
#files-overlay { display:none; }
/* Hide close/collapse buttons on mobile when used as tab */
#files-panel .fp-close { display:none; }
#files-panel .fp-collapse { display:none; }
.fp-header { display:flex; align-items:center; padding:8px 12px; border-bottom:1px solid #e5e5ea; gap:8px; background:#f5f5f7; }
.fp-header .fp-title { flex:1; font-size:13px; font-weight:600; color:#1d1d1f; }
.fp-close { background:none; border:none; color:#86868b; font-size:20px; cursor:pointer; padding:4px; }
.fp-collapse { background:none; border:none; color:#86868b; font-size:12px; cursor:pointer; padding:4px 6px; transition:transform 0.2s; }
#files-panel.collapsed .fp-collapse { transform:rotate(-90deg); }
#files-panel.collapsed .fp-path,
#files-panel.collapsed .fp-list,
#files-panel.collapsed .fp-actions,
#files-panel.collapsed .file-access-request { display:none !important; }
#files-panel.collapsed { height:auto !important; min-height:0 !important; flex-shrink:0; }
#files-panel.collapsed + .resize-v { display:none !important; }
.fp-path { padding:4px 12px; font-size:11px; color:#86868b; background:#fafafa; border-bottom:1px solid #e5e5ea; word-break:break-all; font-family:'SF Mono',Monaco,monospace; }
.fp-list { flex:1; overflow-y:auto; padding:0; transition:background 0.15s, box-shadow 0.15s; }
.fp-list.fp-dragover { background:rgba(0,122,255,0.06); box-shadow:inset 0 0 0 2px #007aff; border-radius:8px; }
.fp-col-header { display:flex; align-items:center; padding:4px 12px; font-size:11px; color:#86868b; border-bottom:1px solid #e5e5ea; background:#fafafa; user-select:none; }
.fp-col-header .name { flex:1; }
.fp-col-header .date { width:90px; text-align:right; flex-shrink:0; }
.fp-item { display:flex; align-items:center; padding:4px 12px; gap:6px; cursor:pointer; font-size:13px; color:#1d1d1f; border-bottom:1px solid #f0f0f2; }
.fp-item:nth-child(even) { background:#fafafa; }
.fp-item:hover { background:#e8f0fe; }
.fp-item:active { background:#d0e0fc; }
.fp-item .icon { font-size:14px; width:16px; text-align:center; flex-shrink:0; }
.fp-item .name { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.fp-item .date { font-size:11px; color:#86868b; flex-shrink:0; width:90px; text-align:right; white-space:nowrap; }
.fp-item .fp-actions { display:flex; gap:4px; flex-shrink:0; margin-left:4px; }
.fp-item .fp-act { width:24px; height:24px; border:none; background:none; cursor:pointer; font-size:14px; padding:0; line-height:24px; text-align:center; border-radius:6px; color:#86868b; }
.fp-item .fp-act:hover { background:#e0e0e5; color:#1d1d1f; }
.fp-actions { display:flex; padding:6px 8px; gap:6px; border-top:1px solid #e5e5ea; background:#f5f5f7; }
.fp-actions button { flex:1; padding:5px; border-radius:6px; border:1px solid #d2d2d7; background:#ffffff; color:#1d1d1f; font-size:12px; cursor:pointer; }
.fp-actions button:active { background:#e5e5ea; }
.fp-back .name { color:#60a5fa; font-weight:500; }
.fp-back:hover { background:#e8f0fe; }
#files-panel.no-access .fp-actions { display:none; }
.file-access-request { display:flex; flex-direction:column; align-items:center; justify-content:center; padding:40px 20px; gap:16px; text-align:center; }
.file-access-icon { font-size:40px; opacity:0.6; }
.file-access-text { font-size:14px; color:#86868b; line-height:1.5; max-width:260px; }
.file-access-btn { padding:10px 24px; border-radius:20px; border:none; background:#007aff; color:#fff; font-size:14px; cursor:pointer; font-weight:500; }
.file-access-btn:active { background:#005ec4; }
.file-access-status { font-size:13px; color:#86868b; }
.file-access-grant { display:flex; align-items:center; gap:8px; padding:8px 12px; background:#f0f6ff; border-radius:10px; margin:4px 8px; font-size:13px; color:#1d1d1f; }
.file-grant-btn { padding:4px 12px; border-radius:12px; border:none; background:#34c759; color:#fff; font-size:12px; cursor:pointer; font-weight:500; white-space:nowrap; }
.file-grant-btn:active { background:#28a745; }

/* Apps panel */
#apps-panel { position:fixed; left:0; top:0; bottom:0; width:min(300px,80vw); background:#ffffff; border-right:1px solid #e5e5ea; transform:translateX(-100%); transition:transform 0.25s ease; z-index:100; display:flex; flex-direction:column; }
#apps-panel.open { transform:translateX(0); }
.app-item { display:flex; align-items:center; padding:10px 12px; gap:8px; border-bottom:1px solid #e5e5ea; cursor:pointer; font-size:14px; }
.app-item:active { background:#f0f0f2; }
.app-item .dot { width:8px; height:8px; border-radius:50%; background:#34c759; flex-shrink:0; }
.app-item .app-name { flex:1; }
.app-item .app-link { font-size:12px; color:#86868b; }

/* New project modal */
#new-project-modal { position:fixed; inset:0; background:rgba(0,0,0,0.3); z-index:200; display:none; align-items:center; justify-content:center; padding:20px; }
#new-project-modal.show { display:flex; }
.modal-box { background:#ffffff; border-radius:14px; padding:24px; width:min(360px,100%); box-shadow:0 10px 40px rgba(0,0,0,0.15); }
.modal-box h3 { font-size:17px; margin-bottom:16px; color:#1d1d1f; }
.modal-box input { width:100%; padding:10px 14px; border-radius:8px; border:1px solid #d2d2d7; background:#f5f5f7; color:#1d1d1f; font-size:15px; outline:none; margin-bottom:16px; }
.modal-box input:focus { border-color:#007aff; box-shadow:0 0 0 3px rgba(0,122,255,0.15); }
.modal-box .modal-btns { display:flex; gap:8px; justify-content:flex-end; }
.modal-box .modal-btns button { padding:8px 20px; border-radius:8px; border:none; font-size:14px; cursor:pointer; }
.modal-cancel { background:#e5e5ea; color:#1d1d1f; }
.modal-ok { background:#007aff; color:white; }
#invite-modal { position:fixed; inset:0; background:rgba(0,0,0,0.3); z-index:200; display:none; align-items:center; justify-content:center; padding:20px; }
#invite-modal.show { display:flex; }
.invite-box { background:#ffffff; border-radius:14px; padding:24px; width:min(400px,100%); box-shadow:0 10px 40px rgba(0,0,0,0.15); }
.invite-box h3 { font-size:17px; margin:0 0 8px; color:#1d1d1f; display:flex; align-items:center; gap:8px; }
.invite-desc { font-size:13px; color:#86868b; line-height:1.5; margin-bottom:16px; }
.invite-link-wrap { background:#f5f5f7; border:1px solid #d2d2d7; border-radius:10px; padding:10px 12px; margin-bottom:16px; }
.invite-link-label { font-size:11px; color:#86868b; margin-bottom:6px; }
.invite-link-row { display:flex; gap:8px; align-items:center; }
.invite-link-url { flex:1; font-size:13px; color:#1d1d1f; word-break:break-all; font-family:'SF Mono',Monaco,Consolas,monospace; background:white; padding:6px 10px; border-radius:6px; border:1px solid #e5e5ea; max-height:40px; overflow:hidden; }
.invite-copy-btn { background:#007aff; color:white; border:none; border-radius:8px; padding:8px 16px; font-size:13px; cursor:pointer; white-space:nowrap; flex-shrink:0; }
.invite-copy-btn:active { background:#0062cc; }
.invite-copy-btn.copied { background:#34c759; }
.invite-online { margin-bottom:16px; }
.invite-online-label { font-size:12px; color:#86868b; margin-bottom:8px; }
.invite-users { display:flex; flex-wrap:wrap; gap:6px; }
.invite-user-tag { display:inline-flex; align-items:center; gap:4px; background:#e8f5e9; color:#2e7d32; padding:4px 10px; border-radius:12px; font-size:12px; font-weight:500; }
.invite-user-tag::before { content:''; width:6px; height:6px; border-radius:50%; background:#34c759; }
.invite-user-tag.is-you { background:#e3f2fd; color:#1565c0; }
.invite-close { background:#e5e5ea; color:#1d1d1f; border:none; border-radius:8px; padding:8px 20px; font-size:14px; cursor:pointer; float:right; }
#collab-toast { position:fixed; top:60px; left:50%; transform:translateX(-50%); background:#1d1d1f; color:white; padding:8px 20px; border-radius:20px; font-size:13px; z-index:300; opacity:0; transition:opacity 0.3s; pointer-events:none; }
#collab-toast.show { opacity:1; }

/* Voice popup (Pro-style) */
#voice-popup {
  position:fixed; left:50%; top:40%; transform:translate(-50%,-50%);
  background:rgba(0,0,0,0.85); border:1px solid rgba(255,255,255,0.15); border-radius:16px;
  padding:16px 20px; min-width:200px; max-width:80vw; z-index:500;
  color:#fff; text-align:center;
  box-shadow:0 4px 24px rgba(0,0,0,0.5); transition:opacity 0.15s, transform 0.15s;
}
#voice-popup.hidden { display:none; }
#voice-popup.cancel { background:rgba(80,20,20,0.9); border-color:#ff3b30; }
#voice-popup.cancel #vp-dot { background:#ff3b30; animation:none; }
#voice-popup.cancel #vp-hint { color:#ff3b30; font-weight:600; }
#voice-popup.send-ready { background:rgba(0,60,40,0.9); border-color:#34c759; }
#voice-popup.send-ready #vp-dot { background:#34c759; }
#voice-popup.send-ready #vp-hint { color:#34c759; font-weight:600; }
#vp-indicator { margin-bottom:8px; }
#vp-dot { display:inline-block; width:12px; height:12px; border-radius:50%; background:#007aff; animation:pulse 1s infinite; }
#vp-text { font-size:16px; line-height:1.5; color:#fff; min-height:24px; max-height:30vh; overflow-y:auto; word-break:break-word; outline:none; border-radius:6px; padding:4px; }
#vp-text[contenteditable="true"] { border:1px solid #007aff; background:rgba(0,0,0,0.3); -webkit-user-select:text; user-select:text; cursor:text; }
#vp-hint { font-size:12px; color:rgba(255,255,255,0.5); margin-top:8px; }
#vp-actions { display:none; justify-content:center; gap:12px; margin-top:12px; }
#vp-actions button { border:none; border-radius:8px; padding:8px 20px; font-size:15px; font-weight:600; cursor:pointer; -webkit-tap-highlight-color:transparent; }
#vp-send { background:#007aff; color:#fff; }
#vp-send:active { background:#0055d4; }
#vp-cancel-btn { background:rgba(255,255,255,0.15); color:#fff; }
#vp-cancel-btn:active { background:rgba(255,255,255,0.25); }
#vp-text.listening::after { content:''; color:rgba(255,255,255,0.4); animation:pulse 1.2s infinite; }

/* Scrollbar — Mac style */
::-webkit-scrollbar { width:6px; }
::-webkit-scrollbar-track { background:transparent; }
::-webkit-scrollbar-thumb { background:#c7c7cc; border-radius:3px; }
::-webkit-scrollbar-thumb:hover { background:#a8a8ad; }

/* Status indicator */
#status-bar { display:none; }
#status-bar .status-dot { width:6px; height:6px; border-radius:50%; flex-shrink:0; }
#status-bar .status-dot.green { background:#34c759; }
#status-bar .status-dot.yellow { background:#ff9f0a; animation:pulse 1.5s infinite; }
#status-bar .status-dot.red { background:#ff3b30; }
#status-bar .status-dot.blue { background:#007aff; animation:pulse 1.5s infinite; }

/* Tool activity indicator */
.msg.tool-activity { align-self:flex-start; background:#f5f5f7; color:#86868b; font-size:12px; padding:6px 12px; border:1px solid #e5e5ea; border-radius:8px; display:flex; align-items:center; gap:4px; flex-wrap:wrap; }
.msg.tool-activity .tool-icon { font-size:14px; }
.msg.tool-activity .tool-detail { color:#636366; max-width:180px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.msg.tool-activity .tool-step { color:#aeaeb2; }
.msg.tool-activity .tool-timer { color:#aeaeb2; font-variant-numeric:tabular-nums; min-width:20px; }
.msg.tool-activity:not(.done) .tool-timer { animation:pulse-timer 2s infinite; }
@keyframes pulse-timer { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
.msg.tool-activity.done { opacity:0.5; transition:opacity 0.5s; }
.msg.tool-activity.done .tool-icon { color:#34c759; }
.tool-detail { display:none; font-size:11px; color:#86868b; margin-top:4px; white-space:pre-wrap; max-height:120px; overflow-y:auto; }
.tool-detail.show { display:block; }

/* Numbered choice buttons */
.choice-btn { padding:8px 16px; border-radius:8px; border:1px solid #d2d2d7; background:#ffffff; color:#1d1d1f; font-size:14px; cursor:pointer; text-align:left; width:100%; }
.choice-btn:active { background:#e5e5ea; }
.choice-btn .choice-num { color:#007aff; font-weight:600; margin-right:6px; }
.choice-btn.type-in { border-color:#007aff; color:#007aff; }

/* Cancel/Stop button */
#cancel-btn { display:none; background:#ffecec; color:#ff3b30; }
#cancel-btn svg { width:18px; height:18px; }
#cancel-btn:active { background:#ffd4d4; }
#cancel-btn.show { display:flex; }

/* Restart button */
.restart-btn { display:inline-block; padding:6px 16px; border-radius:8px; border:1px solid #d2d2d7; background:#ffffff; color:#007aff; font-size:13px; cursor:pointer; margin-top:4px; }
.restart-btn:active { background:#e5e5ea; }

/* Permission context */
.perm-context { font-size:12px; color:#86868b; margin-bottom:6px; line-height:1.4; }
.perm-context strong { color:#1d1d1f; }
.perm-context code { background:#f0f0f2; padding:1px 4px; border-radius:3px; font-size:11px; color:#007aff; }

/* Timeout warning */
.msg.warning { align-self:center; background:#fff8e1; color:#f57c00; border:1px solid #ffe082; font-size:12px; }

/* Debug log overlay */
#debug-log { position:fixed; bottom:0; left:0; right:0; max-height:35vh; overflow-y:auto; background:rgba(0,0,0,0.9); color:#0f0; font-family:monospace; font-size:10px; padding:4px 6px; z-index:9999; display:none; white-space:pre-wrap; word-break:break-all; line-height:1.3; }
#debug-log.show { display:block; }
</style>
</head>
<body>
<div id="app">
  <!-- Top bar -->
  <div id="top-bar">
    <img class="logo" src="./icons/favicon.svg" alt="Hopcode" style="width:24px;height:24px;">
    <span class="title">Hopcode<span class="subtitle">Easy</span></span>
    <button class="top-btn" id="apps-btn" title="My Apps">Apps</button>
    <button class="top-btn primary" id="pro-btn" title="Switch to Pro Mode">Pro</button>
  </div>

  <!-- Project bar -->
  <div id="project-bar">
    <div class="project-chip add" id="new-project-btn">+ New</div>
  </div>

  <!-- Status bar -->
  <div id="status-bar">
    <span class="status-dot yellow" id="status-dot"></span>
    <span id="status-text">Starting Claude...</span>
    <span id="participants-indicator" style="display:none"></span>
  </div>

  <!-- Tab bar (shown when preview URL exists) -->
  <div id="tab-bar">
    <span id="guest-badge" style="display:none; background:#ff9500; color:#fff; font-size:11px; font-weight:600; padding:2px 8px; border-radius:10px; margin-right:8px;" data-i18n="guest.badge">Guest</span>
    <div class="tab-item active" id="tab-chat"><span data-i18n="easy.tab.chat">Chat</span><span class="tab-badge" id="chat-badge"></span></div>
    <div class="tab-item" id="tab-files"><span data-i18n="easy.menu.files">Files</span><span class="tab-badge" id="files-badge"></span></div>
    <div class="tab-item" id="tab-preview"><span data-i18n="easy.tab.preview">Preview</span><span class="tab-badge" id="preview-badge"></span></div>
  </div>

  <!-- Main content (side-by-side on desktop) -->
  <div id="main-content">
  <div id="left-panel">
    <!-- Files panel (Finder-style on desktop, slide-in on mobile) -->
    <div id="files-panel">
      <div class="fp-header">
        <span class="fp-title">Files</span>
        <button class="fp-collapse" id="fp-collapse" title="Collapse">&#x25BC;</button>
        <button class="fp-close" id="fp-close">&times;</button>
      </div>
      <div class="fp-path" id="fp-path">~</div>
      <div class="fp-list" id="fp-list"></div>
      <div class="fp-actions">
        <button id="fp-upload-btn">Upload</button>
        <button id="fp-mkdir-btn">New Folder</button>
      </div>
    </div>
    <div class="resize-handle resize-v" id="resize-files-chat"></div>
    <!-- Welcome screen (placeholder, content moved to preview guide) -->
    <div id="welcome-screen" style="display:none"></div>
    <!-- Online users bar -->
    <div id="participants-bar"></div>
    <!-- Chat area -->
    <div id="chat-area">
    </div>
    <!-- Quick actions -->
    <div id="quick-actions"></div>
    <!-- Input bar -->
    <div id="input-bar" style="position:relative;">
    <div id="mention-dropdown"></div>
    <button class="input-btn" id="menu-btn" title="Menu"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/></svg></button>
    <button class="input-btn" id="voice-toggle" title="Voice/Keyboard"><svg id="vt-mic-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg><svg id="vt-kb-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8.01"/><line x1="10" y1="8" x2="10" y2="8.01"/><line x1="14" y1="8" x2="14" y2="8.01"/><line x1="18" y1="8" x2="18" y2="8.01"/><line x1="6" y1="12" x2="6" y2="12.01"/><line x1="10" y1="12" x2="10" y2="12.01"/><line x1="14" y1="12" x2="14" y2="12.01"/><line x1="18" y1="12" x2="18" y2="12.01"/><line x1="8" y1="16" x2="16" y2="16"/></svg></button>
    <button class="input-btn" id="cancel-btn" title="Stop"><svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg></button>
    <button id="hold-speak">Hold to speak</button>
    <textarea id="msg-input" rows="1" placeholder="" autocomplete="off"></textarea>
    <button class="input-btn" id="upload-btn" title="Upload file"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M12 16V8m0 0l-3 3m3-3l3 3"/></svg></button>
    <button class="input-btn" id="send-btn" title="Send"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg></button>
  </div>
  <!-- Guest CTA popup (hidden, shown after 5 min browsing) -->
  <div id="guest-cta" style="display:none; position:fixed; bottom:20px; left:50%; transform:translateX(-50%); z-index:200; width:calc(100% - 32px); max-width:380px;">
    <div style="background:linear-gradient(135deg,#007aff,#5856d6); border-radius:16px; padding:20px; box-shadow:0 8px 32px rgba(0,0,0,0.25); position:relative;">
      <button id="guest-cta-dismiss" style="position:absolute; top:8px; right:12px; background:none; border:none; color:rgba(255,255,255,0.6); font-size:20px; cursor:pointer; padding:4px;">&times;</button>
      <div style="color:#fff; font-size:16px; font-weight:600; margin-bottom:4px;" data-i18n="guest.cta_title">Like what you see?</div>
      <div style="color:rgba(255,255,255,0.8); font-size:13px; margin-bottom:12px;" data-i18n="guest.cta_desc">Sign up to create your own AI-powered projects</div>
      <a href="/" style="display:inline-block; background:#fff; color:#007aff; padding:10px 28px; border-radius:20px; font-size:15px; font-weight:600; text-decoration:none;" data-i18n="guest.cta_btn">Get Started</a>
    </div>
  </div>
  </div><!-- /left-panel -->
  <div class="resize-handle resize-h" id="resize-chat-preview"></div>
  <!-- Preview container -->
  <div id="preview-container">
    <button class="fullscreen-exit" id="fullscreen-exit">&#x2716;</button>
    <div id="preview-bar">
      <div id="preview-nav"></div>
      <div id="preview-bar-actions">
        <button class="preview-action" id="preview-nav-toggle" title="Toggle links" style="display:none;">&#x25BC;</button>
        <button class="preview-action" id="preview-swap" title="Swap panels" style="display:none;">&#x21C4;</button>
        <button class="preview-action" id="preview-share" data-i18n-title="easy.preview.share_title" data-i18n="easy.preview.share">Share</button>
        <button class="preview-action" id="preview-fullscreen" data-i18n-title="easy.preview.fullscreen">&#x26F6;</button>
        <button class="preview-action" id="preview-refresh" data-i18n="easy.preview.refresh">Refresh</button>
        <button class="preview-action" id="preview-open" data-i18n="easy.preview.open">Open</button>
      </div>
    </div>
    <div id="preview-guide">
      <div id="preview-welcome">
        <div class="welcome-greeting" data-i18n="easy.welcome.greeting">Welcome to Hopcode</div>
        <div class="welcome-sub" data-i18n="easy.welcome.sub">Pick a project and build something amazing with AI in under 5 minutes.</div>
        <div class="welcome-cards">
          <div class="welcome-card" data-task="dashboard">
            <div class="wc-icon">&#x1F4CA;</div>
            <div class="wc-title" data-i18n="easy.welcome.dashboard.title">Data Dashboard</div>
            <div class="wc-desc" data-i18n="easy.welcome.dashboard.desc">A beautiful sales analytics dashboard with interactive charts, KPI cards, and trend analysis.</div>
            <div class="wc-time" data-i18n="easy.welcome.dashboard.time">~3 min</div>
          </div>
          <div class="welcome-card" data-task="game">
            <div class="wc-icon">&#x1F3AE;</div>
            <div class="wc-title" data-i18n="easy.welcome.game.title">Classic Snake Game</div>
            <div class="wc-desc" data-i18n="easy.welcome.game.desc">A fully playable Snake game with score tracking, speed levels, and smooth animations.</div>
            <div class="wc-time" data-i18n="easy.welcome.game.time">~2 min</div>
          </div>
          <div class="welcome-card" data-task="portfolio">
            <div class="wc-icon">&#x1F310;</div>
            <div class="wc-title" data-i18n="easy.welcome.portfolio.title">Personal Portfolio</div>
            <div class="wc-desc" data-i18n="easy.welcome.portfolio.desc">A stunning personal website with smooth scroll animations, responsive design, and modern aesthetic.</div>
            <div class="wc-time" data-i18n="easy.welcome.portfolio.time">~3 min</div>
          </div>
        </div>
        <button class="welcome-skip" id="welcome-skip" data-i18n="easy.welcome.skip">Or just start chatting</button>
      </div>
    </div>
    <iframe id="preview-frame" allow="clipboard-read; clipboard-write"></iframe>
  </div>
  </div><!-- /main-content -->
</div><!-- /app -->

<!-- Bottom menu sheet -->
<div id="menu-overlay"></div>
<div id="menu-sheet">
  <div class="menu-handle"></div>
  <div class="menu-divider"></div>
  <div class="menu-section">
    <div class="menu-item" id="menu-home"><span class="mi-icon">&#x1F3E0;</span><span class="mi-label" data-i18n="easy.menu.home">Home</span><span class="mi-arrow">&#x203A;</span></div>
    <div class="menu-item" id="menu-files"><span class="mi-icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="#60a5fa"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg></span><span class="mi-label" data-i18n="easy.menu.files">Files</span><span class="mi-arrow">&#x203A;</span></div>
    <div class="menu-item" id="menu-apps"><span class="mi-icon">&#x2B50;</span><span class="mi-label" data-i18n="easy.menu.apps">Apps</span><span class="mi-arrow">&#x203A;</span></div>
    <div class="menu-item" id="menu-invite"><span class="mi-icon">&#x1F91D;</span><span class="mi-label" data-i18n="easy.copy_invite">Invite to collaborate</span></div>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-section">
    <div class="menu-font-row">
      <span class="mf-label" data-i18n="easy.menu.font_size">Font Size</span>
      <button class="mf-btn" id="menu-font-down">A&#x2212;</button>
      <span class="mf-val" id="menu-font-val">15px</span>
      <button class="mf-btn" id="menu-font-up">A+</button>
    </div>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-section">
    <div class="menu-item" id="menu-projects-title" style="cursor:pointer;"><span class="mi-icon">&#x1F4C2;</span><span class="mi-label" data-i18n="easy.menu.projects">Projects</span><span class="mi-arrow" id="menu-projects-arrow" style="font-size:10px;transition:transform 0.2s;">&#x25B8;</span></div>
    <div id="menu-projects-wrap">
      <div id="menu-projects" class="menu-proj-list"><div style="padding:8px 20px;color:#86868b;font-size:13px;" data-i18n="loading">Loading...</div></div>
      <div class="menu-item" id="menu-new-project"><span class="mi-icon" style="color:#34c759;">+</span><span class="mi-label" style="color:#34c759;" data-i18n="easy.menu.new_project">New Project</span></div>
    </div>
  </div>
  <div class="menu-divider"></div>
  <div class="menu-section">
    <div class="menu-item" onclick="_setLang(_lang==='en'?'zh':'en')"><span class="mi-icon">&#x1F310;</span><span class="mi-label" data-i18n="easy.menu.lang">Language</span><span class="mi-arrow" id="menu-lang-val" style="font-size:12px;color:#86868b;"></span></div>
    <div class="menu-item" id="menu-debug"><span class="mi-icon">&#x1F41B;</span><span class="mi-label">Debug Log</span></div>
  </div>
</div>

<!-- Files overlay (mobile only) -->
<div id="files-overlay"></div>

<!-- Apps panel -->
<div id="apps-panel">
  <div class="fp-header">
    <span class="fp-title">My Apps</span>
    <button class="fp-close" id="apps-close">&times;</button>
  </div>
  <div id="apps-list" style="flex:1;overflow-y:auto;"></div>
</div>

<!-- New project modal -->
<div id="new-project-modal">
  <div class="modal-box">
    <h3>New Project</h3>
    <input id="project-name-input" placeholder="Project name (e.g. sales-report)" autocomplete="off">
    <div class="modal-btns">
      <button class="modal-cancel" id="modal-cancel">Cancel</button>
      <button class="modal-ok" id="modal-ok">Create</button>
    </div>
  </div>
</div>

<div id="invite-modal">
  <div class="invite-box">
    <h3>&#x1F91D; <span data-i18n="easy.invite.title">Invite to Collaborate</span></h3>
    <div class="invite-desc" data-i18n="easy.invite.desc">Share this link — anyone who opens it can join this session in real time, chat together, and work on the same project with Claude.</div>
    <div id="invite-qr" style="text-align:center;margin-bottom:16px;"></div>
    <div class="invite-link-wrap">
      <div class="invite-link-label" data-i18n="easy.invite.link_label">Invite link</div>
      <div class="invite-link-row">
        <div class="invite-link-url" id="invite-url"></div>
        <button class="invite-copy-btn" id="invite-copy-btn" data-i18n="easy.invite.copy">Copy Link</button>
      </div>
    </div>
    <div class="invite-online">
      <div class="invite-online-label" data-i18n="easy.invite.online">Currently online</div>
      <div class="invite-users" id="invite-users"></div>
    </div>
    <button class="invite-close" id="invite-close" data-i18n="close">Close</button>
  </div>
</div>
<div id="collab-toast"></div>

<!-- Voice popup -->
<div id="voice-popup" class="hidden">
  <div id="vp-indicator"><span id="vp-dot"></span></div>
  <div id="vp-text"></div>
  <div id="vp-hint"></div>
  <div id="vp-actions">
    <button id="vp-cancel-btn" data-i18n="cancel">Cancel</button>
    <button id="vp-send" data-i18n="easy.voice.send">Send</button>
  </div>
</div>

<!-- Hidden file input for uploads -->
<input type="file" id="file-input-hidden" multiple style="display:none">

<!-- Debug log -->
<div id="debug-log"></div>

<script>
(function() {
  'use strict';
  var _isGuestMode = ${isGuest ? 'true' : 'false'};
  var _guestSessionId = ${isGuest ? JSON.stringify(guestOpts!.guestSessionId) : 'null'};
  var _guestToken = ${isGuest ? JSON.stringify(guestOpts!.guestToken) : 'null'};
  var _guestExpires = ${isGuest ? JSON.stringify(guestOpts!.guestExpires) : 'null'};
  // Stable guest ID persisted in localStorage to avoid join/leave churn on reconnect
  var _guestId = null;
  if (_isGuestMode) {
    _guestId = localStorage.getItem('hopcode_guest_id');
    if (!_guestId) {
      _guestId = Math.random().toString(36).substring(2, 8);
      localStorage.setItem('hopcode_guest_id', _guestId);
    }
  }

  var sessionId = _isGuestMode ? _guestSessionId : new URLSearchParams(location.search).get('session');
  if (!sessionId) return;

  var username = _isGuestMode ? ('guest_' + _guestId) : ${JSON.stringify(auth.username)};
  var linuxUser = ${JSON.stringify(auth.linuxUser || '')};
  var homeDir = linuxUser ? (linuxUser === 'root' ? '/root' : '/home/' + linuxUser) : '/root';

  // Session info (set by session_info WS message)
  var _sessionOwner = '';
  var _projectDir = '';
  var _isOwner = ${isGuest ? 'false' : 'true'};
  var _hasFileAccess = ${isGuest ? 'false' : 'true'};

  // Guest mode: hide interactive elements, delayed CTA
  if (_isGuestMode) {
    document.addEventListener('DOMContentLoaded', function() {
      // Hide input bar
      // Hide menu and voice buttons, keep input bar for chatting
      var menuBtn = document.getElementById('menu-btn');
      if (menuBtn) menuBtn.style.display = 'none';
      var voiceToggle = document.getElementById('voice-toggle');
      if (voiceToggle) voiceToggle.style.display = 'none';
      var uploadBtn = document.getElementById('upload-btn');
      if (uploadBtn) uploadBtn.style.display = 'none';
      // Show guest badge
      var badge = document.getElementById('guest-badge');
      if (badge) badge.style.display = '';
      // Delayed CTA: show after 5 minutes of cumulative browsing
      var GUEST_CTA_DELAY = 5 * 60 * 1000;
      var storageKey = 'hopcode_guest_time';
      var dismissKey = 'hopcode_guest_cta_dismissed';
      if (localStorage.getItem(dismissKey)) return; // already dismissed
      var elapsed = parseInt(localStorage.getItem(storageKey) || '0', 10);
      var startedAt = Date.now();
      var ctaTimer = setInterval(function() {
        var total = elapsed + (Date.now() - startedAt);
        localStorage.setItem(storageKey, String(total));
        if (total >= GUEST_CTA_DELAY) {
          clearInterval(ctaTimer);
          var cta = document.getElementById('guest-cta');
          if (cta && !localStorage.getItem(dismissKey)) {
            cta.style.display = '';
            cta.style.animation = 'guestCtaSlideUp 0.3s ease';
          }
        }
      }, 10000); // check every 10s
      // Dismiss handler
      var dismissBtn = document.getElementById('guest-cta-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', function() {
          var cta = document.getElementById('guest-cta');
          if (cta) cta.style.display = 'none';
          localStorage.setItem(dismissKey, '1');
          clearInterval(ctaTimer);
        });
      }
    });
  }

  // Debug log
  var dbgEl = document.getElementById('debug-log');
  var dbgBtn = document.getElementById('debug-toggle');
  var dbgLines = [];
  function dbg(msg) {
    console.log('[easy] ' + msg);
    dbgLines.push(msg);
    if (dbgLines.length > 80) dbgLines.shift();
    if (dbgEl) dbgEl.textContent = dbgLines.join('\\n');
    if (dbgEl) dbgEl.scrollTop = dbgEl.scrollHeight;
  }
  var menuDebugBtn = document.getElementById('menu-debug');
  if (menuDebugBtn) menuDebugBtn.addEventListener('click', function() {
    if (dbgEl) dbgEl.classList.toggle('show');
    menuHide();
  });

  // DOM refs
  var chatArea = document.getElementById('chat-area');
  var msgInput = document.getElementById('msg-input');
  var sendBtn = document.getElementById('send-btn');
  var voiceToggle = document.getElementById('voice-toggle');
  var holdSpeak = document.getElementById('hold-speak');
  var vtMicIcon = document.getElementById('vt-mic-icon');
  var vtKbIcon = document.getElementById('vt-kb-icon');
  var proBtn = document.getElementById('pro-btn');
  var appsBtn = document.getElementById('apps-btn');
  var filesPanel = document.getElementById('files-panel');
  var filesOverlay = document.getElementById('files-overlay');
  var fpList = document.getElementById('fp-list');
  var fpPath = document.getElementById('fp-path');
  var fpClose = document.getElementById('fp-close');
  var fpUploadBtn = document.getElementById('fp-upload-btn');
  var fpMkdirBtn = document.getElementById('fp-mkdir-btn');
  var fileInputHidden = document.getElementById('file-input-hidden');
  var appsPanel = document.getElementById('apps-panel');
  var appsList = document.getElementById('apps-list');
  var appsClose = document.getElementById('apps-close');
  var newProjectBtn = document.getElementById('new-project-btn');
  var projectBar = document.getElementById('project-bar');
  var newProjectModal = document.getElementById('new-project-modal');
  var projectNameInput = document.getElementById('project-name-input');
  var modalCancel = document.getElementById('modal-cancel');
  var modalOk = document.getElementById('modal-ok');
  var vpEl = document.getElementById('voice-popup');
  var vpText = document.getElementById('vp-text');
  var vpHint = document.getElementById('vp-hint');
  var vpActions = document.getElementById('vp-actions');
  var vpConfirmVisible = false;

  // Menu sheet refs
  var menuOverlay = document.getElementById('menu-overlay');
  var menuSheet = document.getElementById('menu-sheet');
  var menuStatusDot = document.getElementById('menu-status-dot');
  var menuStatusText = document.getElementById('menu-status-text');
  var menuProjects = document.getElementById('menu-projects');

  function menuShow(anchorEl) {
    if (anchorEl && window.innerWidth >= 768) {
      var r = anchorEl.getBoundingClientRect();
      menuSheet.style.position = 'fixed';
      menuSheet.style.left = r.left + 'px';
      menuSheet.style.bottom = (window.innerHeight - r.top + 4) + 'px';
      menuSheet.style.top = 'auto';
    } else {
      menuSheet.style.position = '';
      menuSheet.style.left = '';
      menuSheet.style.bottom = '';
      menuSheet.style.top = '';
    }
    menuOverlay.classList.add('show');
    menuSheet.classList.add('show');
  }
  function menuHide() {
    menuOverlay.classList.remove('show');
    menuSheet.classList.remove('show');
  }

  var menuBtn = document.getElementById('menu-btn');
  menuBtn.addEventListener('click', function(e) {
    e.preventDefault(); e.stopPropagation(); menuShow(menuBtn);
  });
  var menuProjectsTitle = document.getElementById('menu-projects-title');
  var menuProjectsWrap = document.getElementById('menu-projects-wrap');
  var menuProjectsArrow = document.getElementById('menu-projects-arrow');
  menuProjectsTitle.addEventListener('click', function() {
    var isOpen = menuProjectsWrap.classList.toggle('open');
    menuProjectsArrow.style.transform = isOpen ? 'rotate(90deg)' : '';
    if (isOpen) loadMenuProjects();
  });
  menuOverlay.addEventListener('click', function() { menuHide(); });
  document.getElementById('menu-home').addEventListener('click', function() {
    menuHide();
    window.location.href = '/terminal';
  });
  document.getElementById('menu-files').addEventListener('click', function() {
    menuHide();
    showTab('files');
  });
  document.getElementById('menu-apps').addEventListener('click', function() {
    menuHide();
    if (appsPanel) appsPanel.classList.toggle('show');
  });
  document.getElementById('menu-new-project').addEventListener('click', function() {
    menuHide();
    if (newProjectModal) newProjectModal.classList.add('show');
  });
  // Invite modal
  var inviteModal = document.getElementById('invite-modal');
  var inviteCopyBtn = document.getElementById('invite-copy-btn');
  var inviteUrlEl = document.getElementById('invite-url');
  var inviteUsersEl = document.getElementById('invite-users');
  var collabToast = document.getElementById('collab-toast');
  var _currentParticipants = [];
  var _collabToastTimer = null;

  // --- @ Mention ---
  var mentionDropdown = document.getElementById('mention-dropdown');
  var _mentionActive = false;
  var _mentionIdx = 0;
  var _mentionItems = [];
  var _mentionFlashTimer = null;
  var _originalTitle = document.title;
  var _avatarColors = ['#FF6B6B','#4ECDC4','#45B7D1','#96CEB4','#FFEAA7','#DDA0DD','#98D8C8','#F7DC6F','#BB8FCE','#85C1E9'];

  function getAvatarColor(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = ((hash << 5) - hash) + name.charCodeAt(i);
    return _avatarColors[Math.abs(hash) % _avatarColors.length];
  }

  function getMentionCandidates(query) {
    var assistantName = _t('easy.assistant_name') || '小码';
    var candidates = [{ name: assistantName, isAI: true }];
    for (var i = 0; i < _currentParticipants.length; i++) {
      if (_currentParticipants[i] !== username) {
        candidates.push({ name: _currentParticipants[i], isAI: false });
      }
    }
    if (!query) return candidates;
    var q = query.toLowerCase();
    return candidates.filter(function(c) { return c.name.toLowerCase().indexOf(q) !== -1; });
  }

  function showMentionDropdown(candidates) {
    if (!mentionDropdown || candidates.length === 0) { hideMentionDropdown(); return; }
    _mentionItems = candidates;
    _mentionIdx = 0;
    _mentionActive = true;
    mentionDropdown.innerHTML = '';
    for (var i = 0; i < candidates.length; i++) {
      var item = document.createElement('div');
      item.className = 'mention-item' + (i === 0 ? ' active' : '');
      item.dataset.idx = i;
      var avatar = document.createElement('div');
      avatar.className = 'mention-avatar';
      if (candidates[i].isAI) {
        avatar.style.background = '#8e44ad';
        avatar.textContent = '\\uD83E\\uDD16';
      } else {
        avatar.style.background = getAvatarColor(candidates[i].name);
        avatar.textContent = candidates[i].name.charAt(0).toUpperCase();
      }
      item.appendChild(avatar);
      var nameEl = document.createElement('span');
      nameEl.className = 'mention-name';
      nameEl.textContent = candidates[i].name;
      item.appendChild(nameEl);
      item.addEventListener('mousedown', function(e) {
        e.preventDefault(); // prevent blur
        var idx = parseInt(this.dataset.idx);
        insertMention(_mentionItems[idx].name);
      });
      mentionDropdown.appendChild(item);
    }
    mentionDropdown.style.display = 'block';
  }

  function hideMentionDropdown() {
    if (mentionDropdown) mentionDropdown.style.display = 'none';
    _mentionActive = false;
    _mentionItems = [];
    _mentionIdx = 0;
  }

  function insertMention(name) {
    var val = msgInput.value;
    var pos = msgInput.selectionStart;
    // Find the @ before cursor
    var before = val.substring(0, pos);
    var atIdx = before.lastIndexOf('@');
    if (atIdx === -1) { hideMentionDropdown(); return; }
    var after = val.substring(pos);
    msgInput.value = before.substring(0, atIdx) + '@' + name + ' ' + after;
    var newPos = atIdx + name.length + 2; // @name + space
    msgInput.selectionStart = msgInput.selectionEnd = newPos;
    msgInput.focus();
    hideMentionDropdown();
    updateSendBtn();
  }

  function startMentionFlash() {
    if (_mentionFlashTimer) return;
    var on = true;
    _mentionFlashTimer = setInterval(function() {
      document.title = on ? _t('easy.mention.title_alert') : _originalTitle;
      on = !on;
    }, 1000);
  }

  document.addEventListener('visibilitychange', function() {
    if (!document.hidden && _mentionFlashTimer) {
      clearInterval(_mentionFlashTimer);
      _mentionFlashTimer = null;
      document.title = _originalTitle;
    }
  });

  var _inviteUrl = '';
  function renderInviteQR(url) {
    var qrEl = document.getElementById('invite-qr');
    if (!qrEl) return;
    function doRender() {
      try {
        var qr = qrcode(0, 'M');
        qr.addData(url);
        qr.make();
        qrEl.innerHTML = qr.createSvgTag(4, 6);
        var svg = qrEl.querySelector('svg');
        if (svg) { svg.style.borderRadius = '12px'; svg.style.background = '#fff'; svg.style.padding = '8px'; svg.style.maxWidth = '200px'; svg.style.height = 'auto'; }
      } catch(e) { qrEl.innerHTML = ''; }
    }
    if (window.qrcode) { doRender(); } else {
      var sc = document.createElement('script');
      sc.src = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';
      sc.onload = doRender;
      sc.onerror = function() { qrEl.innerHTML = ''; };
      document.head.appendChild(sc);
    }
  }
  document.getElementById('menu-invite').addEventListener('click', function() {
    menuHide();
    renderInviteUsers();
    inviteModal.classList.add('show');
    // Fetch guest link from API
    var qrEl = document.getElementById('invite-qr');
    if (qrEl) qrEl.innerHTML = '<div style="color:#86868b;padding:12px;font-size:13px;">Loading...</div>';
    inviteUrlEl.textContent = '...';
    _inviteUrl = '';
    fetch('/terminal/api/guest-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sessionId: sessionId })
    }).then(function(r) { return r.json(); }).then(function(data) {
      if (data.url) {
        _inviteUrl = data.url;
        inviteUrlEl.textContent = data.url;
        renderInviteQR(data.url);
      } else {
        inviteUrlEl.textContent = location.href;
        _inviteUrl = location.href;
        renderInviteQR(location.href);
      }
    }).catch(function() {
      inviteUrlEl.textContent = location.href;
      _inviteUrl = location.href;
      renderInviteQR(location.href);
    });
  });
  inviteModal.addEventListener('click', function(e) {
    if (e.target === inviteModal) inviteModal.classList.remove('show');
  });
  document.getElementById('invite-close').addEventListener('click', function() {
    inviteModal.classList.remove('show');
  });
  inviteCopyBtn.addEventListener('click', function() {
    var url = _inviteUrl || location.href;
    var btn = inviteCopyBtn;
    function onCopied() {
      btn.textContent = _t('easy.copied_invite');
      btn.classList.add('copied');
      setTimeout(function() {
        btn.textContent = _t('easy.invite.copy');
        btn.classList.remove('copied');
      }, 2000);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(onCopied);
    } else {
      var ta = document.createElement('textarea');
      ta.value = url; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy');
      document.body.removeChild(ta);
      onCopied();
    }
  });

  function renderInviteUsers() {
    if (!inviteUsersEl) return;
    inviteUsersEl.innerHTML = '';
    if (_currentParticipants.length <= 1) {
      inviteUsersEl.innerHTML = '<span style="font-size:12px;color:#86868b;">' + _t('easy.invite.only_you') + '</span>';
      return;
    }
    for (var i = 0; i < _currentParticipants.length; i++) {
      var tag = document.createElement('span');
      tag.className = 'invite-user-tag' + (_currentParticipants[i] === username ? ' is-you' : '');
      tag.textContent = displayName(_currentParticipants[i]) + (_currentParticipants[i] === username ? ' (you)' : '');
      inviteUsersEl.appendChild(tag);
    }
  }

  function showCollabToast(text) {
    if (!collabToast) return;
    collabToast.textContent = text;
    collabToast.classList.add('show');
    if (_collabToastTimer) clearTimeout(_collabToastTimer);
    _collabToastTimer = setTimeout(function() { collabToast.classList.remove('show'); }, 3000);
  }

  // Font size controls — shared localStorage key with Pro Mode
  var easyFontKey = 'hopcode-font-size';
  var savedEasyFont = parseInt(localStorage.getItem(easyFontKey));
  var easyFontSize = savedEasyFont > 0 ? savedEasyFont : 15;
  var menuFontVal = document.getElementById('menu-font-val');

  function applyEasyFontSize() {
    document.querySelectorAll('.msg').forEach(function(el) { el.style.fontSize = easyFontSize + 'px'; });
    document.getElementById('msg-input').style.fontSize = easyFontSize + 'px';
    // Set CSS custom property so new messages also get the size
    document.documentElement.style.setProperty('--easy-font-size', easyFontSize + 'px');
    menuFontVal.textContent = easyFontSize + 'px';
    localStorage.setItem(easyFontKey, String(easyFontSize));
  }
  // Apply saved size on load
  applyEasyFontSize();

  document.getElementById('menu-font-down').addEventListener('click', function() {
    easyFontSize = Math.max(10, easyFontSize - 1);
    applyEasyFontSize();
  });
  document.getElementById('menu-font-up').addEventListener('click', function() {
    easyFontSize = Math.min(30, easyFontSize + 1);
    applyEasyFontSize();
  });

  // ---- Welcome screen (in preview panel) ----
  var welcomeEl = document.getElementById('preview-welcome');
  var welcomeSkip = document.getElementById('welcome-skip');
  var welcomeActive = true;
  var welcomeTaskPrompts = {
    dashboard: _t('easy.welcome.dashboard.prompt'),
    game: _t('easy.welcome.game.prompt'),
    portfolio: _t('easy.welcome.portfolio.prompt')
  };

  function dismissWelcome() {
    if (!welcomeActive) return;
    welcomeActive = false;
    welcomeEl.style.display = 'none';
  }

  // Don't dismiss welcome based on chat history — only dismiss when preview has content

  // Card click → send prompt + switch to chat
  var welcomeCards = document.querySelectorAll('.welcome-card');
  for (var wci = 0; wci < welcomeCards.length; wci++) {
    welcomeCards[wci].addEventListener('click', function(e) {
      var task = this.getAttribute('data-task');
      var prompt = welcomeTaskPrompts[task];
      if (!prompt) return;
      dismissWelcome();
      // Switch to chat tab
      if (tabChat) tabChat.click();
      // Wait for Claude to be ready and WS connected, then send
      function trySend(attempts) {
        if (!attempts) attempts = 0;
        if (attempts > 30) { dbg('trySend gave up after 30 attempts'); return; }
        if (state === 'ready' && ws && ws.readyState === 1) {
          // Don't render locally — server echoes user_message for multi-user consistency
          currentAssistantMsg = null;
          ws.send(JSON.stringify({ type: 'send', text: prompt }));
          dbg('trySend sent prompt: ' + prompt.substring(0, 40));
        } else {
          dbg('trySend waiting: state=' + state + ' ws=' + (ws ? ws.readyState : 'null') + ' attempt=' + attempts);
          setTimeout(function() { trySend(attempts + 1); }, 500);
        }
      }
      trySend(0);
    });
  }

  welcomeSkip.addEventListener('click', function() {
    dismissWelcome();
    if (tabChat) tabChat.click();
    msgInput.focus();
  });

  // Preview tab refs
  var tabBar = document.getElementById('tab-bar');
  var tabChat = document.getElementById('tab-chat');
  var tabFiles = document.getElementById('tab-files');
  var tabPreview = document.getElementById('tab-preview');
  var chatBadge = document.getElementById('chat-badge');
  var filesBadge = document.getElementById('files-badge');
  var previewBadge = document.getElementById('preview-badge');
  var previewContainer = document.getElementById('preview-container');
  var previewFrame = document.getElementById('preview-frame');
  var previewRefreshBtn = document.getElementById('preview-refresh');
  var previewOpenBtn = document.getElementById('preview-open');
  var currentPreviewUrl = '';
  var previewUrls = []; // all detected URLs, newest first
  var activeTab = 'chat'; // 'chat' | 'files' | 'preview'

  function isDesktop() { return window.innerWidth >= 768; }

  function showTab(tab) {
    activeTab = tab;
    if (isDesktop()) {
      // Desktop: both always visible, just update tab highlight
      chatArea.style.display = 'flex';
      previewContainer.classList.add('show');
      tabChat.classList.toggle('active', tab === 'chat');
      if (tabFiles) tabFiles.classList.toggle('active', tab === 'files');
      tabPreview.classList.toggle('active', tab === 'preview');
      if (tab === 'chat') autoScroll();
      return;
    }
    var leftPanel = document.getElementById('left-panel');
    var participantsBar = document.getElementById('participants-bar');
    var quickActions = document.getElementById('quick-actions');
    var inputBar = document.getElementById('input-bar');
    var resizeFilesChat = document.getElementById('resize-files-chat');
    // Reset all
    tabChat.classList.remove('active');
    if (tabFiles) tabFiles.classList.remove('active');
    tabPreview.classList.remove('active');
    leftPanel.style.display = 'none';
    previewContainer.classList.remove('show');
    if (filesPanel) { filesPanel.classList.remove('open'); filesPanel.style.display = 'none'; }

    if (tab === 'chat') {
      leftPanel.style.display = 'flex';
      chatArea.style.display = 'flex';
      if (participantsBar) participantsBar.style.display = '';
      if (quickActions) quickActions.style.display = '';
      if (inputBar) inputBar.style.display = '';
      if (resizeFilesChat) resizeFilesChat.style.display = 'none';
      tabChat.classList.add('active');
      chatBadge.classList.remove('show');
      autoScroll();
    } else if (tab === 'files') {
      if (tabFiles) tabFiles.classList.add('active');
      // Show left-panel but hide chat elements, show only files
      leftPanel.style.display = 'flex';
      chatArea.style.display = 'none';
      if (participantsBar) participantsBar.style.display = 'none';
      if (quickActions) quickActions.style.display = 'none';
      if (inputBar) inputBar.style.display = 'none';
      if (resizeFilesChat) resizeFilesChat.style.display = 'none';
      if (filesPanel) {
        filesPanel.style.display = 'flex';
        filesPanel.classList.add('open');
        if (typeof loadFiles === 'function') loadFiles(filePath);
      }
      if (filesBadge) filesBadge.classList.remove('show');
    } else if (tab === 'preview') {
      previewContainer.classList.add('show');
      tabPreview.classList.add('active');
      previewBadge.classList.remove('show');
    }
  }

  // Hard-refresh iframe: blank it first, then reload with cache-bust
  function hardRefreshPreview(url) {
    // Remove and re-create iframe to guarantee a full reload
    // Setting .src alone may not work after in-iframe navigation
    var parent = previewFrame.parentNode;
    var newFrame = document.createElement('iframe');
    newFrame.id = 'preview-frame';
    newFrame.className = previewFrame.className;
    var sep = url.indexOf('?') >= 0 ? '&' : '?';
    var finalUrl = url + sep + '_t=' + Date.now();
    // PDF: mobile browsers can't render PDF in iframe — use server-side PDF viewer page
    if (/\\.pdf(\\?|$)/i.test(url)) {
      finalUrl = '/terminal/pdf-viewer?url=' + encodeURIComponent(url);
    }
    newFrame.src = finalUrl;
    parent.replaceChild(newFrame, previewFrame);
    previewFrame = newFrame;
  }

  var previewNav = document.getElementById('preview-nav');
  var MAX_PREVIEW_PILLS = 20;

  var previewTitles = {}; // url -> page title
  function pillLabel(url) {
    if (previewTitles[url]) return previewTitles[url];
    try {
      var p = url.split('?')[0].replace(/\\/+$/, '');
      var name = p.split('/').pop() || url;
      if (name === 'index.html') {
        var parts = p.split('/');
        name = parts.length >= 2 ? parts[parts.length - 2] : name;
      }
      return name.replace(/\\.(html|htm)$/, '') || url.substring(0, 20);
    } catch(e) { return url.substring(0, 20); }
  }

  function selectPreviewPill(url) {
    currentPreviewUrl = url;
    hardRefreshPreview(url);
    previewFrame.classList.add('loaded');
    document.getElementById('preview-guide').style.display = 'none';
    if (welcomeActive) dismissWelcome();
    renderPreviewNav();
    // Persist user's selection so it survives page refresh
    var _persistUrls = previewUrls.filter(function(u) { return !_deletedPreviews[u]; });
    try { localStorage.setItem('easy_preview_' + sessionId, JSON.stringify({ urls: _persistUrls, current: currentPreviewUrl })); } catch(e) {}
  }

  var _deletedPreviews = {};
  try { _deletedPreviews = JSON.parse(localStorage.getItem('easy_preview_deleted_' + sessionId) || '{}'); } catch(e) {}

  function removePreviewUrl(url) {
    var idx = previewUrls.indexOf(url);
    if (idx >= 0) previewUrls.splice(idx, 1);
    // Remember deletion so server re-push doesn't bring it back
    _deletedPreviews[url] = 1;
    try { localStorage.setItem('easy_preview_deleted_' + sessionId, JSON.stringify(_deletedPreviews)); } catch(e) {}
    // If removing the active preview, switch to next available or clear
    if (url === currentPreviewUrl) {
      if (previewUrls.length > 0) {
        selectPreviewPill(previewUrls[0]);
      } else {
        currentPreviewUrl = '';
        previewFrame.src = 'about:blank';
        previewFrame.classList.remove('loaded');
        document.getElementById('preview-guide').style.display = '';
      }
    }
    renderPreviewNav();
  }

  function renderPreviewNav() {
    previewNav.innerHTML = '';
    // Clean up any previous dropdown menus appended to body
    var oldMenus = document.querySelectorAll('body > .preview-dropdown-menu');
    for (var m = 0; m < oldMenus.length; m++) oldMenus[m].remove();
    if (previewUrls.length === 0) {
      document.getElementById('preview-bar-actions').style.display = 'none';
      return;
    }

    var isMob = !isDesktop();

    if (isMob) {
      // Mobile: dropdown selector
      var wrap = document.createElement('div');
      wrap.className = 'preview-dropdown-wrap';
      var btn = document.createElement('button');
      btn.className = 'preview-dropdown-btn';
      var btnLabel = document.createElement('span');
      btnLabel.className = 'pdd-label';
      btnLabel.textContent = currentPreviewUrl ? pillLabel(currentPreviewUrl) : pillLabel(previewUrls[0]);
      btn.appendChild(btnLabel);
      var arrow = document.createElement('span');
      arrow.className = 'pdd-arrow';
      arrow.textContent = '\u25BC';
      btn.appendChild(arrow);
      wrap.appendChild(btn);

      var menu = document.createElement('div');
      menu.className = 'preview-dropdown-menu';
      for (var i = 0; i < previewUrls.length; i++) {
        (function(url) {
          var item = document.createElement('div');
          item.className = 'pdd-item' + (url === currentPreviewUrl ? ' active' : '');
          var label = document.createElement('span');
          label.className = 'pdd-item-label';
          label.textContent = pillLabel(url);
          item.appendChild(label);
          var del = document.createElement('span');
          del.className = 'pdd-item-del';
          del.textContent = '\u00D7';
          del.addEventListener('click', function(e) {
            e.stopPropagation();
            menu.classList.remove('show');
            removePreviewUrl(url);
          });
          item.appendChild(del);
          label.addEventListener('click', function(e) {
            e.stopPropagation();
            menu.classList.remove('show');
            selectPreviewPill(url);
          });
          menu.appendChild(item);
        })(previewUrls[i]);
      }
      // Append menu to body so it's not clipped by overflow:hidden containers
      document.body.appendChild(menu);
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        if (!menu.classList.contains('show')) {
          var rect = btn.getBoundingClientRect();
          menu.style.top = (rect.bottom + 4) + 'px';
        }
        menu.classList.toggle('show');
      });
      document.addEventListener('click', function() { menu.classList.remove('show'); });
      previewNav.appendChild(wrap);
    } else {
      // Desktop: horizontal pills
      var barEl = document.getElementById('preview-bar');
      var actionsEl = document.getElementById('preview-bar-actions');
      var availWidth = (barEl ? barEl.offsetWidth : 300) - (actionsEl ? actionsEl.offsetWidth : 0) - 24;
      var pillW = 90;
      var moreW = 38;
      var gapW = 4;

      var fitAll = Math.floor((availWidth + gapW) / (pillW + gapW));
      var maxVisible;
      if (previewUrls.length <= fitAll) {
        maxVisible = previewUrls.length;
      } else {
        maxVisible = Math.max(1, Math.floor((availWidth - moreW + gapW) / (pillW + gapW)));
      }

      var shown = previewUrls.slice(0, maxVisible);
      var overflow = previewUrls.slice(maxVisible);

      for (var i = 0; i < shown.length; i++) {
        (function(url) {
          var pill = document.createElement('span');
          pill.className = 'preview-pill' + (url === currentPreviewUrl ? ' active' : '');
          var label = document.createElement('span');
          label.textContent = pillLabel(url);
          pill.appendChild(label);
          pill.title = url;
          label.addEventListener('click', function() { selectPreviewPill(url); });
          var del = document.createElement('span');
          del.className = 'pill-del';
          del.textContent = '\u00D7';
          del.addEventListener('click', function(e) {
            e.stopPropagation();
            removePreviewUrl(url);
          });
          pill.appendChild(del);
          previewNav.appendChild(pill);
        })(shown[i]);
      }

      if (overflow.length > 0) {
        var moreBtn = document.createElement('span');
        moreBtn.className = 'preview-pill more-pill';
        moreBtn.textContent = '+' + overflow.length;
        var menu = document.createElement('div');
        menu.className = 'preview-more-menu';
        for (var j = 0; j < overflow.length; j++) {
          (function(url) {
            var item = document.createElement('div');
            item.className = 'preview-more-item' + (url === currentPreviewUrl ? ' active' : '');
            var itemLabel = document.createElement('span');
            itemLabel.textContent = pillLabel(url);
            itemLabel.style.flex = '1';
            item.appendChild(itemLabel);
            item.title = url;
            var itemDel = document.createElement('span');
            itemDel.className = 'pill-del';
            itemDel.textContent = '\u00D7';
            itemDel.style.display = 'inline';
            itemDel.addEventListener('click', function(e) {
              e.stopPropagation();
              menu.classList.remove('show');
              removePreviewUrl(url);
            });
            item.appendChild(itemDel);
            itemLabel.addEventListener('click', function(e) {
              e.stopPropagation();
              menu.classList.remove('show');
              selectPreviewPill(url);
            });
            menu.appendChild(item);
          })(overflow[j]);
        }
        moreBtn.appendChild(menu);
        moreBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          menu.classList.toggle('show');
        });
        document.addEventListener('click', function() { menu.classList.remove('show'); });
        previewNav.appendChild(moreBtn);
      }
    }

    document.getElementById('preview-bar-actions').style.display = 'flex';
    var toggleBtn = document.getElementById('preview-nav-toggle');
    if (toggleBtn) toggleBtn.style.display = (!isMob && previewUrls.length > 1) ? '' : 'none';
  }

  // Re-render on resize to adapt pill count
  window.addEventListener('resize', function() { if (previewUrls.length > 0) renderPreviewNav(); });

  // Toggle preview-nav visibility
  var navToggle = document.getElementById('preview-nav-toggle');
  var navCollapsed = false;
  navToggle.addEventListener('click', function() {
    navCollapsed = !navCollapsed;
    previewNav.classList.toggle('collapsed', navCollapsed);
    navToggle.classList.toggle('collapsed', navCollapsed);
  });

  // addOnly: add URL to list without switching active preview (used for reconnect hints)
  function setPreviewUrl(url, forceReload, addOnly) {
    if (!url) return;
    // Skip localhost/127.0.0.1 URLs — not reachable from client browser
    if (/^https?:\\/\\/(localhost|127\\.0\\.0\\.1)(:|\\/)/.test(url)) return;
    // Skip URLs the user has explicitly deleted
    if (_deletedPreviews[url]) return;
    // Add to list (dedup)
    var idx = previewUrls.indexOf(url);
    if (addOnly) {
      // Just ensure it's in the list, don't reorder or switch
      if (idx < 0) {
        previewUrls.push(url);
        if (previewUrls.length > MAX_PREVIEW_PILLS) previewUrls.length = MAX_PREVIEW_PILLS;
      }
    } else {
      // Remove duplicate if exists, then add to front (newest first)
      if (idx >= 0) previewUrls.splice(idx, 1);
      previewUrls.unshift(url);
      if (previewUrls.length > MAX_PREVIEW_PILLS) previewUrls.length = MAX_PREVIEW_PILLS;
      // Load the URL — hard refresh to bypass all caches
      if (url !== currentPreviewUrl || forceReload) {
        currentPreviewUrl = url;
        hardRefreshPreview(url);
      }
    }
    previewFrame.classList.add('loaded');
    document.getElementById('preview-guide').style.display = 'none';
    if (welcomeActive) dismissWelcome();
    renderPreviewNav();
    // Show badge on preview tab if we're on chat
    if (activeTab === 'chat' && !addOnly) {
      previewBadge.classList.add('show');
    }
    // Persist preview URLs (exclude deleted)
    var _persistUrls = previewUrls.filter(function(u) { return !_deletedPreviews[u]; });
    try { localStorage.setItem('easy_preview_' + sessionId, JSON.stringify({ urls: _persistUrls, current: currentPreviewUrl })); } catch(e) {}
  }

  // Restore preview URLs from localStorage on load (filter out deleted ones)
  try {
    var savedPreview = JSON.parse(localStorage.getItem('easy_preview_' + sessionId) || '');
    if (savedPreview && savedPreview.urls && savedPreview.urls.length > 0) {
      previewUrls = savedPreview.urls.filter(function(u) { return !_deletedPreviews[u]; });
      currentPreviewUrl = (!_deletedPreviews[savedPreview.current] && savedPreview.current) || previewUrls[0] || '';
      hardRefreshPreview(currentPreviewUrl);
      previewFrame.classList.add('loaded');
      document.getElementById('preview-guide').style.display = 'none';
      renderPreviewNav();
    }
  } catch(e) {}

  // Extract URL from text that looks like a generated site (localhost, tunnel, /serve/ etc.)
  function detectPreviewUrl(text) {
    var fixed = joinSplitUrls(text);
    // Check for /serve/ relative paths first (our built-in static serving)
    var serveMatch = fixed.match(/\\/serve\\/[^\\s<>'"\`]+/g);
    if (serveMatch) {
      return serveMatch[0].replace(/[.,;:!?)\`]+$/, '');
    }
    var urlMatch = fixed.match(/https?:\\/\\/[^\\s<>'"\`]+/g);
    if (!urlMatch) return null;
    for (var i = 0; i < urlMatch.length; i++) {
      var u = urlMatch[i].replace(/[.,;:!?)]+$/, '');
      // Skip localhost/127.0.0.1 — not reachable from client browser in Easy Mode
      if (/localhost|127\\.0\\.0\\.1/.test(u)) continue;
      // Match tunnel/dev URLs
      if (/trycloudflare|ngrok|loca\\.lt|\\d+\\.\\d+\\.\\d+\\.\\d+:\\d+/.test(u)) {
        return u;
      }
    }
    // Return last non-localhost URL if any
    for (var j = urlMatch.length - 1; j >= 0; j--) {
      var uu = urlMatch[j].replace(/[.,;:!?)]+$/, '');
      if (!/localhost|127\\.0\\.0\\.1/.test(uu)) return uu;
    }
    return null;
  }

  tabChat.addEventListener('click', function() { showTab('chat'); });
  if (tabFiles) tabFiles.addEventListener('click', function() { showTab('files'); });
  tabPreview.addEventListener('click', function() { showTab('preview'); });

  // On new session (welcome active), start on preview tab (mobile) so cards are visible
  if (welcomeActive) {
    showTab('preview');
  }

  // Desktop: init side-by-side and handle resize
  var desktopFilesLoaded = false;
  function applyDesktopLayout() {
    if (isDesktop()) {
      chatArea.style.display = 'flex';
      previewContainer.classList.add('show');
      document.getElementById('input-bar').style.display = '';
      document.getElementById('quick-actions').style.display = '';
      // Auto-load files in Finder panel on desktop (deferred until loadFiles is defined)
      if (!desktopFilesLoaded && window._loadFiles) {
        desktopFilesLoaded = true;
        window._loadFiles('');
      }
    } else {
      // Re-apply current tab for mobile
      showTab(activeTab);
    }
  }
  applyDesktopLayout();
  window.addEventListener('resize', applyDesktopLayout);
  // Capture page title from iframe after load
  function capturePreviewTitle() {
    try {
      var title = previewFrame.contentDocument && previewFrame.contentDocument.title;
      if (title && currentPreviewUrl) {
        previewTitles[currentPreviewUrl] = title;
        renderPreviewNav();
      }
    } catch(e) {} // cross-origin will throw
  }
  previewFrame.addEventListener('load', function() { setTimeout(capturePreviewTitle, 300); });
  // Initial pill render
  renderPreviewNav();
  var previewFullscreenBtn = document.getElementById('preview-fullscreen');
  previewRefreshBtn.addEventListener('click', function() {
    if (currentPreviewUrl) hardRefreshPreview(currentPreviewUrl);
  });
  previewOpenBtn.addEventListener('click', function() {
    if (currentPreviewUrl) window.open(currentPreviewUrl, '_blank');
  });
  var fullscreenExitBtn = document.getElementById('fullscreen-exit');
  function toggleFullscreen() {
    previewContainer.classList.toggle('fullscreen');
    previewFullscreenBtn.textContent = previewContainer.classList.contains('fullscreen') ? '\\u2716' : '\\u26F6';
  }
  previewFullscreenBtn.addEventListener('click', toggleFullscreen);
  fullscreenExitBtn.addEventListener('click', toggleFullscreen);

  // Share button — create shareable tunnel link
  var shareBtn = document.getElementById('preview-share');
  var shareTunnels = {}; // port → { url, pid }
  shareBtn.addEventListener('click', function() {
    if (!currentPreviewUrl) return;
    try {
      var u = new URL(currentPreviewUrl);
      var port = u.port || (u.protocol === 'https:' ? '443' : '80');
      if (shareTunnels[port]) {
        // Already tunneled — copy URL
        navigator.clipboard.writeText(shareTunnels[port]).then(function() {
          shareBtn.textContent = _t('copied');
          setTimeout(function() { shareBtn.textContent = _t('easy.preview.share'); }, 2000);
        });
        return;
      }
      shareBtn.textContent = _t('creating');
      shareBtn.disabled = true;
      fetch('/terminal/share', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: port })
      }).then(function(r) { return r.json(); }).then(function(data) {
        shareBtn.disabled = false;
        if (data.url) {
          shareTunnels[port] = data.url;
          navigator.clipboard.writeText(data.url).then(function() {
            shareBtn.textContent = _t('copied');
            setTimeout(function() { shareBtn.textContent = _t('easy.preview.share'); }, 2000);
          });
          // Also add tunnel URL as a preview pill
          setPreviewUrl(data.url);
        } else {
          shareBtn.textContent = 'Failed';
          setTimeout(function() { shareBtn.textContent = _t('easy.preview.share'); }, 2000);
        }
      }).catch(function() {
        shareBtn.disabled = false;
        shareBtn.textContent = 'Failed';
        setTimeout(function() { shareBtn.textContent = _t('easy.preview.share'); }, 2000);
      });
    } catch(e) {}
  });

  // State
  var ws = null;
  var currentAssistantMsg = null;
  var projects = JSON.parse(localStorage.getItem('easy_projects_' + username) || '[]');
  var activeProject = localStorage.getItem('easy_active_project_' + username) || '';
  // If URL has ?project=xxx from server session creation, adopt it
  var urlProject = new URLSearchParams(location.search).get('project');
  if (urlProject && projects.indexOf(urlProject) < 0) {
    projects.push(urlProject);
    localStorage.setItem('easy_projects_' + username, JSON.stringify(projects));
  }
  if (urlProject) {
    activeProject = urlProject;
    localStorage.setItem('easy_active_project_' + username, urlProject);
  }
  var filePath = homeDir;

  // ---- State Machine ----
  // States: 'initializing' | 'ready' | 'thinking' | 'tool_running' | 'error'
  var state = 'initializing';
  var stuckTimer = null;
  var voiceTriggered = false;

  // DOM refs for new elements
  var statusDot = document.getElementById('status-dot');
  var statusText = document.getElementById('status-text');
  var cancelBtn = document.getElementById('cancel-btn');
  var quickActions = document.getElementById('quick-actions');

  function setState(newState) {
    var prev = state;
    state = newState;
    dbg('state: ' + prev + ' -> ' + newState);

    // Update status bar
    var dotCls = 'status-dot';
    var text = '';
    switch (newState) {
      case 'initializing':
        dotCls += ' yellow'; text = _t('easy.status.initializing'); break;
      case 'ready':
        dotCls += ' green'; text = _t('easy.status.ready'); break;
      case 'thinking':
        dotCls += ' blue'; text = _t('easy.status.thinking'); break;
      case 'tool_running':
        dotCls += ' blue'; text = _t('easy.status.tool_running'); break;
      case 'queued':
        dotCls += ' yellow'; text = _t('easy.status.queued'); break;
      case 'error':
        dotCls += ' red'; text = _t('easy.status.error'); break;
    }
    statusDot.className = dotCls;
    statusText.textContent = text;

    // Update 小码 chip dot in participants bar
    var aiDot = document.getElementById('ai-chip-dot');
    if (aiDot) {
      aiDot.className = 'p-dot';
      switch (newState) {
        case 'ready': break; // green by default
        case 'thinking': case 'tool_running': aiDot.className = 'p-dot busy'; break;
        case 'queued': aiDot.className = 'p-dot queued'; break;
        case 'error': aiDot.className = 'p-dot error'; break;
        case 'initializing': aiDot.className = 'p-dot initializing'; break;
      }
    }

    // Update input placeholder & disabled state — always allow input (messages queue)
    msgInput.disabled = (newState === 'initializing' || newState === 'exited');
    if (newState === 'ready') {
      msgInput.placeholder = (('ontouchstart' in window || navigator.maxTouchPoints > 0) || window.innerWidth < 768 || msgInput.offsetWidth < 300) ? _t('easy.input.placeholder_mobile') : _t('easy.input.placeholder', {key: /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Option' : 'Alt'});
    } else if (newState === 'thinking' || newState === 'tool_running' || newState === 'queued') {
      msgInput.placeholder = _t('easy.input.placeholder_busy');
    } else {
      msgInput.placeholder = _t('easy.input.placeholder_mobile');
    }

    // Show/hide cancel (stop) button
    var isBusy = (newState === 'thinking' || newState === 'tool_running' || newState === 'queued');
    cancelBtn.classList.toggle('show', isBusy);
    voiceToggle.style.display = isBusy ? 'none' : 'flex';

    // Manage stuck timer
    clearTimeout(stuckTimer);
    if (newState === 'thinking' || newState === 'tool_running') {
      stuckTimer = setTimeout(function() {
        if (state === 'thinking' || state === 'tool_running') {
          addRetryMsg(_t('easy.msg.stuck'));
        }
      }, 180000);
    }

    // Show thinking animation for thinking & tool_running (not queued — that's just waiting)
    if (newState === 'thinking' || newState === 'tool_running') {
      showThinking();
    } else if (prev === 'thinking' || prev === 'tool_running') {
      hideThinking();
    }

    // Clear tool indicator when leaving tool_running
    if (prev === 'tool_running' && newState !== 'tool_running') {
      clearToolIndicator();
    }

    // On transition to ready, finalize current message
    if (newState === 'ready' && prev !== 'ready' && prev !== 'initializing') {
      currentAssistantMsg = null;
      _lastDetectedUrl = '';
      // Refresh files panel if visible
      refreshFilesDebounced();
    }
  }

  var _filesRefreshTimer = null;
  function refreshFilesDebounced() {
    if (_filesRefreshTimer) return; // already scheduled
    _filesRefreshTimer = setTimeout(function() {
      _filesRefreshTimer = null;
      if (isDesktop() || activeTab === 'files' || filesPanel.classList.contains('open')) {
        loadFiles(filePath);
      }
    }, 500);
  }

  // ---- WebSocket (connects to /ws-easy for structured JSON messaging) ----
  var wsRetryDelay = 1000;
  var _initialPreviewSync = false; // true during initial WS connect — preview_hints add to list without switching

  function connectWs() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var projectParam = new URLSearchParams(location.search).get('project') || '';
    var wsUrl = proto + '//' + location.host + '/terminal/ws-easy?session=' + encodeURIComponent(sessionId) + '&project=' + encodeURIComponent(projectParam);
    if (_isGuestMode && _guestToken) {
      wsUrl += '&guest_token=' + encodeURIComponent(_guestToken) + '&expires=' + encodeURIComponent(_guestExpires) + '&guest_id=' + encodeURIComponent(_guestId);
    }
    ws = new WebSocket(wsUrl);
    ws.onopen = function() {
      wsRetryDelay = 1000;
      // If user already has a saved preview, don't let reconnect hints override it
      _initialPreviewSync = currentPreviewUrl ? true : false;
      setTimeout(function() { _initialPreviewSync = false; }, 2000);
      dbg('ws connected');
    };
    ws.onmessage = function(e) {
      var d;
      try { d = JSON.parse(e.data); } catch { return; }
      dbg('ws msg: ' + d.type + (d.state ? ' state=' + d.state : '') + (d.text ? ' text=' + d.text.substring(0, 40) : ''));

      if (d.type === 'state') {
        setState(d.state);
      } else if (d.type === 'message') {
        // Complete message — create or update bubble
        if (d.id != null && currentAssistantMsg && currentAssistantMsg._msgId === d.id) {
          // Same bubble — update with final text (reconcile streaming)
          currentAssistantMsg._rawText = d.text;
          currentAssistantMsg.className = 'msg assistant' + (d.thinking ? ' thinking-msg' : '');
          currentAssistantMsg.innerHTML = linkify(d.text);
          saveChatHistory();
        } else {
          appendAssistantText(d.text, d.thinking);
          if (currentAssistantMsg && d.id != null) currentAssistantMsg._msgId = d.id;
        }
        if (voiceTriggered && !d.thinking) { voiceTriggered = false; playTts(d.text); }
        autoScroll();
      } else if (d.type === 'message_delta') {
        // Streaming delta — append text to current bubble
        if (currentAssistantMsg && currentAssistantMsg._isThinkingPlaceholder) {
          // First real content — replace spinner with text
          currentAssistantMsg._isThinkingPlaceholder = false;
          currentAssistantMsg.className = 'msg assistant';
          currentAssistantMsg._rawText = d.delta;
          currentAssistantMsg.innerHTML = linkify(d.delta);
          if (d.id != null) currentAssistantMsg._msgId = d.id;
        } else if (d.id != null && currentAssistantMsg && currentAssistantMsg._msgId === d.id) {
          // Append to existing bubble
          currentAssistantMsg._rawText = (currentAssistantMsg._rawText || '') + d.delta;
          currentAssistantMsg.innerHTML = linkify(currentAssistantMsg._rawText);
        } else {
          // No placeholder, no matching bubble — create new
          appendAssistantText(d.delta, false);
          if (currentAssistantMsg && d.id != null) currentAssistantMsg._msgId = d.id;
        }
        autoScroll();
      } else if (d.type === 'tool') {
        if (d.status === 'done') {
          clearToolIndicator();
          refreshFilesDebounced();
        } else {
          showToolActivity(d.name, d.detail);
        }
      } else if (d.type === 'preview_hint') {
        // Server detected new/modified HTML — auto-load preview
        // During initial reconnect, just add to list without switching active URL
        if (d.url) {
          setPreviewUrl(d.url, true, _initialPreviewSync);
        }
      } else if (d.type === 'preview_suggest') {
        // Non-previewable file generated — suggest HTML preview
        addPreviewSuggest(d.filename);
      } else if (d.type === 'user_message') {
        // Server echo of user message — WeChat group style
        var isSelf = d.sender === username;
        var isMentioned = d.text && d.text.match(new RegExp('@' + username + '(?![\\w\\u4e00-\\u9fff])'));
        if (isSelf) {
          var wrap = document.createElement('div');
          wrap.className = 'msg-wrap user-wrap';
          var nameTag = document.createElement('div');
          nameTag.className = 'msg-sender';
          nameTag.textContent = d.sender || username;
          wrap.appendChild(nameTag);
          var div = document.createElement('div');
          div.className = 'msg user';
          div._rawText = d.text;
          div._sender = d.sender;
          div.innerHTML = linkify(d.text);
          wrap.appendChild(div);
          chatArea.appendChild(wrap);
        } else {
          var wrap = document.createElement('div');
          wrap.className = 'msg-wrap';
          var nameTag = document.createElement('div');
          nameTag.className = 'msg-sender';
          nameTag.textContent = displayName(d.sender);
          wrap.appendChild(nameTag);
          var bubble = document.createElement('div');
          bubble.className = 'msg user' + (isMentioned ? ' mentioned' : '');
          bubble._rawText = d.text;
          bubble._sender = d.sender;
          bubble.innerHTML = linkify(d.text);
          wrap.appendChild(bubble);
          chatArea.appendChild(wrap);
          // Title flash when mentioned and page not visible
          if (isMentioned && document.hidden) { startMentionFlash(); }
        }
        currentAssistantMsg = null;
        autoScroll();
        saveChatHistory();
      } else if (d.type === 'participants') {
        updateParticipants(d.users);
      } else if (d.type === 'history') {
        // Server history is authoritative — clear chat and re-render from server
        if (d.messages && d.messages.length > 0) {
          // Remove all user/assistant messages (keep system messages like join/leave)
          var oldMsgs = chatArea.querySelectorAll('.msg.user, .msg.assistant, .msg-wrap');
          for (var k = 0; k < oldMsgs.length; k++) oldMsgs[k].remove();
          currentAssistantMsg = null;
          _suppressUrlDetection = true; // Don't detect URLs from history replay
          for (var i = 0; i < d.messages.length; i++) {
            var m = d.messages[i];
            if (m.role === 'user') {
              var isSelf = !m.sender || m.sender === username;
              if (isSelf) {
                var wrap = document.createElement('div');
                wrap.className = 'msg-wrap user-wrap';
                var nameTag = document.createElement('div');
                nameTag.className = 'msg-sender';
                nameTag.textContent = m.sender || username;
                wrap.appendChild(nameTag);
                var div = document.createElement('div');
                div.className = 'msg user';
                div._rawText = m.text;
                div._sender = m.sender || username;
                div.innerHTML = linkify(m.text);
                wrap.appendChild(div);
                chatArea.appendChild(wrap);
              } else {
                var wrap = document.createElement('div');
                wrap.className = 'msg-wrap';
                var nameTag = document.createElement('div');
                nameTag.className = 'msg-sender';
                nameTag.textContent = m.sender;
                wrap.appendChild(nameTag);
                var bubble = document.createElement('div');
                bubble.className = 'msg user';
                bubble._rawText = m.text;
                bubble._sender = m.sender;
                bubble.innerHTML = linkify(m.text);
                wrap.appendChild(bubble);
                chatArea.appendChild(wrap);
              }
            } else {
              appendAssistantText(m.text);
            }
            currentAssistantMsg = null;
          }
          _suppressUrlDetection = false;
          autoScroll();
          saveChatHistory();
        }
      } else if (d.type === 'session_info') {
        _sessionOwner = d.owner;
        _projectDir = d.projectDir;
        _isOwner = d.isOwner;
        _hasFileAccess = d.hasFileAccess;
        updateFileAccessUI();
        // Set page title to session name
        var titleName = d.sessionName || '';
        if (!titleName && d.projectDir) {
          var parts = d.projectDir.split('/').filter(Boolean);
          titleName = (parts[parts.length - 1] === 'workspace' && parts.length >= 2) ? parts[parts.length - 2] : parts[parts.length - 1];
        }
        if (titleName) {
          document.title = titleName + ' - Hopcode';
          _originalTitle = document.title;
        }
      } else if (d.type === 'file_access_request') {
        // Owner sees request — show grant prompt
        showFileAccessRequest(d.user);
      } else if (d.type === 'file_access_granted') {
        // User was granted file access
        _hasFileAccess = true;
        updateFileAccessUI();
      } else if (d.type === 'error') {
        addRetryMsg(d.message || _t('error_generic'));
      }
    };
    ws.onclose = function() {
      statusText.textContent = _t('easy.status.reconnecting');
      statusDot.className = 'status-dot yellow';
      setTimeout(connectWs, wsRetryDelay);
      wsRetryDelay = Math.min(wsRetryDelay * 1.5, 15000);
    };
  }

  function wsSend(msg) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(msg));
      dbg('wsSend: ' + JSON.stringify(msg).substring(0, 80));
    } else {
      dbg('wsSend DROPPED (ws not ready): ' + JSON.stringify(msg).substring(0, 80));
    }
  }

  var toolIcons = { Read: '\ud83d\udcc4', Write: '\u270f\ufe0f', Edit: '\u270f\ufe0f', Bash: '\u25b6', Glob: '\ud83d\udd0d', Grep: '\ud83d\udd0d', Agent: '\ud83e\udd16', WebFetch: '\ud83c\udf10', WebSearch: '\ud83c\udf10', NotebookEdit: '\ud83d\udcd3' };
  var toolStepCount = 0;

  function showToolActivity(name, detail) {
    var label = _t('tool.' + name) || name || _t('tool.working');
    var icon = toolIcons[name] || '\u2699\ufe0f';

    // Detail-only update for current tool
    if (detail && toolIndicatorEl && !toolIndicatorEl.classList.contains('done') && toolIndicatorEl._toolName === name) {
      var detailEl = toolIndicatorEl.querySelector('.tool-detail');
      if (detailEl) detailEl.textContent = detail;
      return;
    }

    // Reuse existing bubble: update content in place
    if (toolIndicatorEl && !toolIndicatorEl.classList.contains('done')) {
      // Stop old timer
      if (toolIndicatorEl._timerInterval) clearInterval(toolIndicatorEl._timerInterval);
      // Increment step count, update content
      toolStepCount++;
      toolIndicatorEl._toolName = name;
      toolIndicatorEl._startTime = Date.now();
      toolIndicatorEl.innerHTML = '<span class="tool-icon">' + icon + '</span> <span class="tool-label">' + escHtml(label) + '</span>' + (detail ? ' <span class="tool-detail">' + escHtml(detail) + '</span>' : '') + ' <span class="tool-step">\u00b7 ' + _t('easy.tool.step', {n: toolStepCount}) + '</span> <span class="tool-timer"></span>';
      var timerEl = toolIndicatorEl.querySelector('.tool-timer');
      toolIndicatorEl._timerInterval = setInterval(function() {
        timerEl.textContent = Math.floor((Date.now() - toolIndicatorEl._startTime) / 1000) + 's';
      }, 1000);
      autoScroll();
      return;
    }

    // First tool — create bubble
    toolStepCount = 1;
    var el = document.createElement('div');
    el.className = 'msg tool-activity';
    el._toolName = name;
    el._startTime = Date.now();
    el.innerHTML = '<span class="tool-icon">' + icon + '</span> <span class="tool-label">' + escHtml(label) + '</span>' + (detail ? ' <span class="tool-detail">' + escHtml(detail) + '</span>' : '') + ' <span class="tool-timer"></span>';
    chatArea.appendChild(el);
    var timerEl2 = el.querySelector('.tool-timer');
    el._timerInterval = setInterval(function() {
      timerEl2.textContent = Math.floor((Date.now() - el._startTime) / 1000) + 's';
    }, 1000);
    toolIndicatorEl = el;
    autoScroll();
  }

  // ---- Permission prompt UX (not needed with --dangerously-skip-permissions, kept as stub) ----
  function showNumberedChoices(choices) {
    quickActions.innerHTML = '';
    choices.forEach(function(c) {
      var btn = document.createElement('button');
      btn.className = 'choice-btn' + (c.isTypeIn ? ' type-in' : '');
      btn.innerHTML = '<span class="choice-num">' + c.num + '.</span> ' + escHtml(c.label);
      btn.onclick = function() {
        if (c.isTypeIn) {
          // Focus input and let user type
          hideQuickActions();
          msgInput.disabled = false;
          msgInput.placeholder = _t('easy.input.type_response');
          msgInput.focus();
        } else {
          hideQuickActions();
        }
      };
      quickActions.appendChild(btn);
    });
    quickActions.classList.add('show');
  }

  function showQuickActions(actions) {
    // Don't clear - may have context div already
    actions.forEach(function(a) {
      var btn = document.createElement('button');
      btn.className = 'qa-btn ' + a.cls;
      btn.textContent = a.label;
      btn.onclick = function() {
        hideQuickActions();
        setState('thinking');
      };
      quickActions.appendChild(btn);
    });
    quickActions.classList.add('show');
  }

  function hideQuickActions() {
    quickActions.innerHTML = '';
    quickActions.classList.remove('show');
  }

  // ---- Tool activity indicator (single reusable element) ----
  var toolIndicatorEl = null;

  function clearToolIndicator() {
    if (toolIndicatorEl) {
      if (toolIndicatorEl._timerInterval) clearInterval(toolIndicatorEl._timerInterval);
      if (toolStepCount > 1) {
        toolIndicatorEl.innerHTML = '\u2699\ufe0f ' + _t('easy.tool.done', {n: toolStepCount});
      } else {
        // Single step — just fade it
        var timerEl = toolIndicatorEl.querySelector('.tool-timer');
        if (timerEl && toolIndicatorEl._startTime) {
          timerEl.textContent = Math.floor((Date.now() - toolIndicatorEl._startTime) / 1000) + 's';
        }
      }
      toolIndicatorEl.classList.add('done');
    }
    toolIndicatorEl = null;
    toolStepCount = 0;
  }

  // ---- Chat history persistence ----
  var chatHistoryKey = 'easy_chat_' + sessionId;

  var _saveChatTimer = null;
  function saveChatHistory() {
    if (_saveChatTimer) return;
    _saveChatTimer = setTimeout(function() {
      _saveChatTimer = null;
      try {
        var msgs = [];
        var items = chatArea.querySelectorAll('.msg.user, .msg.assistant');
        for (var i = 0; i < items.length; i++) {
          var rawText = items[i]._rawText || items[i].textContent;
          var entry = { role: items[i].classList.contains('user') ? 'user' : 'assistant', text: rawText };
          if (items[i]._sender) entry.sender = items[i]._sender;
          msgs.push(entry);
        }
        if (msgs.length > 50) msgs = msgs.slice(-50);
        localStorage.setItem(chatHistoryKey, JSON.stringify(msgs));
      } catch(e) {}
    }, 2000);
  }

  function restoreChatHistory() {
    try {
      var raw = localStorage.getItem(chatHistoryKey);
      if (!raw) return;
      var msgs = JSON.parse(raw);
      if (!Array.isArray(msgs) || msgs.length === 0) return;
      _suppressUrlDetection = true;
      for (var i = 0; i < msgs.length; i++) {
        var m = msgs[i];
        if (m.role === 'assistant') {
          appendAssistantText(m.text);
          currentAssistantMsg = null;
        } else if (m.role === 'user') {
          var isSelf = !m.sender || m.sender === username;
          if (isSelf) {
            var wrap = document.createElement('div');
            wrap.className = 'msg-wrap user-wrap';
            var nameTag = document.createElement('div');
            nameTag.className = 'msg-sender';
            nameTag.textContent = m.sender || username;
            wrap.appendChild(nameTag);
            var div = document.createElement('div');
            div.className = 'msg user';
            div._rawText = m.text;
            div._sender = m.sender || username;
            div.innerHTML = linkify(m.text);
            wrap.appendChild(div);
            chatArea.appendChild(wrap);
          } else {
            var wrap = document.createElement('div');
            wrap.className = 'msg-wrap';
            var nameTag = document.createElement('div');
            nameTag.className = 'msg-sender';
            nameTag.textContent = m.sender;
            wrap.appendChild(nameTag);
            var bubble = document.createElement('div');
            bubble.className = 'msg user';
            bubble._rawText = m.text;
            bubble._sender = m.sender;
            bubble.innerHTML = linkify(m.text);
            wrap.appendChild(bubble);
            chatArea.appendChild(wrap);
          }
        }
      }
      _suppressUrlDetection = false;
      autoScroll();
    } catch(e) { _suppressUrlDetection = false; }
  }

  // ---- Linkify URLs in text (XSS-safe) ----
  // Join URLs that got split across lines (terminal 120-col wrap or Claude formatting)
  function joinSplitUrls(text) {
    var lines = text.split('\\n');
    var joined = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // If line contains a URL that ends at end-of-line without punctuation/space,
      // and next line starts with URL-valid chars — it's likely a wrapped URL
      while (i + 1 < lines.length && /https?:\\/\\/[^\\s]+[a-zA-Z0-9/\\-_~]$/.test(line.trimEnd())) {
        var nextTrimmed = lines[i + 1].trim();
        var nextWord = (nextTrimmed.split(/\\s/)[0] || '');
        if (nextWord && /^[a-zA-Z0-9\\-._~:/?#\\[\\]@!$&'()*+,;=%]+$/.test(nextWord)) {
          // Join: append next line's first word (or whole line if single word)
          if (nextWord === nextTrimmed) {
            line = line.trimEnd() + nextTrimmed;
            i++;
          } else {
            line = line.trimEnd() + nextWord;
            lines[i + 1] = nextTrimmed.substring(nextWord.length).trimStart();
            break;
          }
        } else {
          break;
        }
      }
      joined.push(line);
    }
    return joined.join('\\n');
  }

  function linkify(text) {
    var fixed = joinSplitUrls(text);
    var escaped = escHtml(fixed);
    var withLinks = escaped.replace(/(https?:\\/\\/[^\\s<>'"]+)/g, '<a href="$1" class="chat-link" style="color:#007aff;word-break:break-all;text-decoration:underline;">$1</a>');
    // Highlight @mentions
    return withLinks.replace(/@([\w\u4e00-\u9fff]+)/g, '<span class="mention">@$1</span>');
  }

  // Intercept link clicks in chat — open in preview instead of navigating away
  chatArea.addEventListener('click', function(e) {
    var a = e.target.closest && e.target.closest('a.chat-link');
    if (!a) return;
    e.preventDefault();
    setPreviewUrl(a.href, true);
    if (!isDesktop()) showTab('preview');
  });

  // ---- Participants ----
  // Display-friendly name: guest_xxx → "Guest"/"访客"
  function displayName(u) {
    if (u && u.startsWith('guest_')) return _t('guest.badge');
    return u;
  }

  function updateParticipants(users) {
    // users is now [{name, online}, ...] — extract online names for join/leave detection
    var onlineNames = [];
    for (var i = 0; i < users.length; i++) {
      if (users[i].online) onlineNames.push(users[i].name);
    }

    // Detect joins and leaves based on online status changes (skip first update)
    if (_currentParticipants.length > 0) {
      for (var i = 0; i < onlineNames.length; i++) {
        if (_currentParticipants.indexOf(onlineNames[i]) === -1 && onlineNames[i] !== username) {
          var name = displayName(onlineNames[i]);
          showCollabToast(_t('easy.participant.joined', { name: name }));
          addSystemMsg(_t('easy.participant.joined', { name: name }));
        }
      }
      for (var i = 0; i < _currentParticipants.length; i++) {
        if (onlineNames.indexOf(_currentParticipants[i]) === -1 && _currentParticipants[i] !== username) {
          var name = displayName(_currentParticipants[i]);
          showCollabToast(_t('easy.participant.left', { name: name }));
          addSystemMsg(_t('easy.participant.left', { name: name }));
        }
      }
    }
    _currentParticipants = onlineNames;

    // Status bar indicator — show online count
    var el = document.getElementById('participants-indicator');
    if (el) {
      if (users.length <= 1) {
        el.style.display = 'none';
      } else {
        el.style.display = 'inline';
        var onlineCount = onlineNames.length;
        el.textContent = onlineCount + '/' + users.length + ' ' + _t('easy.participants');
        el.title = users.map(function(u) { return displayName(u.name) + (u.online ? '' : ' (offline)'); }).join(', ');
      }
    }

    // Participants bar — always visible, 小码 first then users
    var bar = document.getElementById('participants-bar');
    if (bar) {
      bar.style.display = 'block';
      bar.innerHTML = '';

      // 小码 AI chip — always first
      var aiChip = document.createElement('span');
      aiChip.className = 'p-chip ai-chip';
      var aiDot = document.createElement('span');
      aiDot.className = 'p-dot';
      aiDot.id = 'ai-chip-dot';
      // Apply current state color
      if (state === 'thinking' || state === 'tool_running') aiDot.className = 'p-dot busy';
      else if (state === 'queued') aiDot.className = 'p-dot queued';
      else if (state === 'error') aiDot.className = 'p-dot error';
      else if (state === 'initializing') aiDot.className = 'p-dot initializing';
      aiChip.appendChild(aiDot);
      var aiName = document.createElement('span');
      aiName.textContent = _t('easy.assistant_name');
      aiChip.appendChild(aiName);
      // Click to @小码
      aiChip.addEventListener('click', function() {
        var cur = msgInput.value;
        var mention = '@' + _t('easy.assistant_name') + ' ';
        if (cur && !cur.endsWith(' ')) mention = ' ' + mention;
        msgInput.value = cur + mention;
        msgInput.focus();
        updateSendBtn();
      });
      bar.appendChild(aiChip);

      // Human users
      for (var i = 0; i < users.length; i++) {
        var u = users[i];
        var chip = document.createElement('span');
        chip.className = 'p-chip' + (u.online ? '' : ' offline');
        var dot = document.createElement('span');
        dot.className = 'p-dot' + (u.online ? '' : ' offline');
        chip.appendChild(dot);
        var nameSpan = document.createElement('span');
        nameSpan.textContent = displayName(u.name);
        chip.appendChild(nameSpan);
        // Role tag
        var roleText = '';
        if (_sessionOwner && u.name === _sessionOwner) roleText = _t('easy.participant.owner');
        else if (u.name === username) roleText = _t('easy.participant.you');
        if (roleText) {
          var role = document.createElement('span');
          role.className = 'p-role';
          role.textContent = '(' + roleText + ')';
          chip.appendChild(role);
        }
        // Click to @mention (skip self)
        if (u.name !== username) {
          chip.dataset.user = u.name;
          chip.addEventListener('click', function() {
            var uName = this.dataset.user;
            var dn = displayName(uName);
            var cur = msgInput.value;
            var mention = '@' + dn + ' ';
            if (cur && !cur.endsWith(' ')) mention = ' ' + mention;
            msgInput.value = cur + mention;
            msgInput.focus();
            updateSendBtn();
          });
        }
        bar.appendChild(chip);
      }
    }

    // Update invite modal if open
    if (inviteModal && inviteModal.classList.contains('show')) {
      renderInviteUsers();
    }
  }

  // Initial render: show 小码 chip before server sends participants
  updateParticipants([]);

  // ---- Chat messages ----
  function addUserMsg(text) {
    currentAssistantMsg = null;
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap user-wrap';
    var nameTag = document.createElement('div');
    nameTag.className = 'msg-sender';
    nameTag.textContent = username || _t('easy.you');
    wrap.appendChild(nameTag);
    var div = document.createElement('div');
    div.className = 'msg user';
    div._rawText = text;
    div._sender = username;
    div.innerHTML = linkify(text);
    wrap.appendChild(div);
    chatArea.appendChild(wrap);
    autoScroll();
    saveChatHistory();
  }

  var _lastDetectedUrl = '';
  var _suppressUrlDetection = false;
  function appendAssistantText(text, isThinking) {
    // Reuse thinking placeholder bubble if it exists (smooth transition, no flicker)
    if (currentAssistantMsg && currentAssistantMsg._isThinkingPlaceholder) {
      if (!text) {
        // Empty initial message — keep spinner, just assign msgId via caller
        return;
      }
      currentAssistantMsg._isThinkingPlaceholder = false;
      currentAssistantMsg.className = 'msg assistant' + (isThinking ? ' thinking-msg' : '');
      currentAssistantMsg._rawText = text;
      currentAssistantMsg.innerHTML = linkify(text);
    } else {
      // Wrap in msg-wrap with "小码" sender label
      var wrap = document.createElement('div');
      wrap.className = 'msg-wrap assistant-wrap';
      var nameTag = document.createElement('div');
      nameTag.className = 'msg-sender';
      nameTag.textContent = _t('easy.assistant_name');
      wrap.appendChild(nameTag);
      currentAssistantMsg = document.createElement('div');
      currentAssistantMsg.className = 'msg assistant' + (isThinking ? ' thinking-msg' : '');
      currentAssistantMsg._rawText = text;
      currentAssistantMsg.innerHTML = linkify(text);
      wrap.appendChild(currentAssistantMsg);
      chatArea.appendChild(wrap);
    }
    // Auto-detect preview URL — only trigger reload if URL changed
    // Skip during history replay to avoid re-adding old URLs
    if (!_suppressUrlDetection) {
      var detectedUrl = detectPreviewUrl(text);
      if (detectedUrl && detectedUrl !== _lastDetectedUrl) {
        _lastDetectedUrl = detectedUrl;
        setPreviewUrl(detectedUrl, true);
      }
      // Badge on chat tab if user is on preview
      if (activeTab === 'preview') chatBadge.classList.add('show');
    }
    saveChatHistory();
  }

  // Replace the current assistant message content (for streaming updates)
  function setAssistantText(text) {
    if (!currentAssistantMsg) {
      currentAssistantMsg = document.createElement('div');
      currentAssistantMsg.className = 'msg assistant';
      currentAssistantMsg._rawText = '';
      chatArea.appendChild(currentAssistantMsg);
    }
    currentAssistantMsg._rawText = text;
    currentAssistantMsg.innerHTML = linkify(text);
    var detectedUrl = detectPreviewUrl(text);
    if (detectedUrl && detectedUrl !== _lastDetectedUrl) {
      _lastDetectedUrl = detectedUrl;
      setPreviewUrl(detectedUrl, true);
    }
    if (activeTab === 'preview') chatBadge.classList.add('show');
    saveChatHistory();
  }

  function addSystemMsg(text) {
    var div = document.createElement('div');
    div.className = 'msg system';
    div.textContent = text;
    chatArea.appendChild(div);
    autoScroll();
  }

  function addErrorMsg(text) {
    var div = document.createElement('div');
    div.className = 'msg error';
    div.textContent = text;
    chatArea.appendChild(div);
    autoScroll();
  }

  function addWarningMsg(text) {
    // Don't add duplicate warnings
    var existing = chatArea.querySelectorAll('.msg.warning');
    for (var i = 0; i < existing.length; i++) {
      if (existing[i].textContent === text) return;
    }
    var div = document.createElement('div');
    div.className = 'msg warning';
    div.textContent = text;
    chatArea.appendChild(div);
    autoScroll();
  }

  function addRetryMsg(text) {
    var div = document.createElement('div');
    div.className = 'msg error retry-msg';
    var span = document.createElement('span');
    span.textContent = text;
    div.appendChild(span);
    var btn = document.createElement('button');
    btn.className = 'retry-btn';
    btn.textContent = _t('easy.msg.retry');
    btn.addEventListener('click', function() {
      btn.disabled = true;
      btn.textContent = _t('easy.msg.retrying');
      wsSend({ type: 'retry' });
    });
    div.appendChild(btn);
    chatArea.appendChild(div);
    autoScroll();
  }

  function addPreviewSuggest(filename) {
    var div = document.createElement('div');
    div.className = 'msg system suggest-msg';
    var span = document.createElement('span');
    span.textContent = _t('easy.msg.suggest_preview', { file: filename });
    div.appendChild(span);
    var btn = document.createElement('button');
    btn.className = 'suggest-btn';
    btn.textContent = _t('easy.msg.suggest_preview_btn');
    btn.addEventListener('click', function() {
      btn.disabled = true;
      btn.textContent = _t('easy.msg.suggest_preview_sent');
      var prompt = _t('easy.msg.suggest_preview_prompt', { file: filename });
      wsSend({ type: 'send', text: prompt });
    });
    div.appendChild(btn);
    chatArea.appendChild(div);
    autoScroll();
  }

  function addExitedMsg() {
    currentAssistantMsg = null;
    var div = document.createElement('div');
    div.className = 'msg system';
    div.innerHTML = _t('easy.msg.stopped') + ' <button class="restart-btn" id="restart-claude-btn">' + _t('easy.msg.restart') + '</button>';
    chatArea.appendChild(div);
    var restartBtn = document.getElementById('restart-claude-btn');
    if (restartBtn) {
      restartBtn.onclick = function() {
        restartClaude();
      };
    }
    autoScroll();
  }

  function restartClaude() {
    // With claude -p, no restart needed — just set ready
    currentAssistantMsg = null;
    setState('ready');
  }

  function showThinking() {
    // Create a placeholder assistant bubble with spinner inside
    // When the first message arrives, it replaces the spinner content in-place
    if (currentAssistantMsg && currentAssistantMsg._isThinkingPlaceholder) return;
    var wrap = document.createElement('div');
    wrap.className = 'msg-wrap assistant-wrap';
    var nameTag = document.createElement('div');
    nameTag.className = 'msg-sender';
    nameTag.textContent = _t('easy.assistant_name');
    wrap.appendChild(nameTag);
    var div = document.createElement('div');
    div.className = 'msg assistant thinking-placeholder';
    div.innerHTML = '<span class="dot-spinner"><span></span><span></span><span></span></span>';
    div._isThinkingPlaceholder = true;
    wrap.appendChild(div);
    chatArea.appendChild(wrap);
    currentAssistantMsg = div;
    autoScroll();
  }

  function hideThinking() {
    // Remove placeholder only if it wasn't replaced by real content
    if (currentAssistantMsg && currentAssistantMsg._isThinkingPlaceholder) {
      currentAssistantMsg.remove();
      currentAssistantMsg = null;
    }
  }

  var _scrollPending = false;
  function autoScroll() {
    if (_scrollPending) return;
    _scrollPending = true;
    requestAnimationFrame(function() {
      _scrollPending = false;
      chatArea.scrollTop = chatArea.scrollHeight;
    });
  }

  // TTS playback — fetch WAV from server and play
  var ttsAudio = null;
  function playTts(text) {
    if (!text || text.length < 2) return;
    // Stop any playing TTS
    if (ttsAudio) { try { ttsAudio.pause(); } catch(e){} ttsAudio = null; }
    fetch('/terminal/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ text: text })
    }).then(function(r) {
      if (!r.ok) throw new Error('TTS failed');
      return r.blob();
    }).then(function(blob) {
      var url = URL.createObjectURL(blob);
      ttsAudio = new Audio(url);
      ttsAudio.play().catch(function(e) { dbg('TTS play error: ' + e.message); });
      ttsAudio.onended = function() { URL.revokeObjectURL(url); ttsAudio = null; };
    }).catch(function(e) { dbg('TTS error: ' + e.message); });
  }

  // ---- Send message ----
  function sendMessage() {
    var text = msgInput.value.trim();
    dbg('sendMessage: text=' + (text ? text.substring(0, 30) : '(empty)') + ' state=' + state + ' ws=' + (ws ? ws.readyState : 'null'));
    if (!text) return;
    if (state === 'initializing' || state === 'exited') return;

    // Extract @mentions from text
    var mentionMatches = text.match(/@([\w\u4e00-\u9fff]+)/g);
    var mentions = mentionMatches ? mentionMatches.map(function(m) { return m.substring(1); }) : [];

    // Don't render locally — wait for server echo (user_message) for multi-user consistency
    currentAssistantMsg = null;
    var msg = { type: 'send', text: text };
    if (mentions.length > 0) msg.mentions = mentions;
    wsSend(msg);
    msgInput.value = '';
    msgInput.style.height = 'auto';
    hideMentionDropdown();
    updateSendBtn();
    // State will be set to 'thinking' by the server response
  }

  // Cancel button
  cancelBtn.addEventListener('click', function() {
    wsSend({ type: 'cancel' });
    addSystemMsg(_t('easy.msg.cancelled'));
    setState('ready');
  });

  // Input handlers
  function updateSendBtn() {
    var hasText = !!msgInput.value.trim();
    sendBtn.classList.toggle('show', hasText);
  }
  msgInput.addEventListener('input', function() {
    updateSendBtn();
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    // @ mention detection
    var val = msgInput.value;
    var pos = msgInput.selectionStart;
    var before = val.substring(0, pos);
    var match = before.match(/@([\w\u4e00-\u9fff]*)$/);
    if (match) {
      var candidates = getMentionCandidates(match[1]);
      showMentionDropdown(candidates);
    } else {
      hideMentionDropdown();
    }
  });

  var composing = false;
  msgInput.addEventListener('compositionstart', function() { composing = true; });
  msgInput.addEventListener('compositionend', function() { composing = false; });
  msgInput.addEventListener('keydown', function(e) {
    // @ mention dropdown navigation
    if (_mentionActive && _mentionItems.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        _mentionIdx = (_mentionIdx + 1) % _mentionItems.length;
        var items = mentionDropdown.querySelectorAll('.mention-item');
        for (var i = 0; i < items.length; i++) items[i].className = 'mention-item' + (i === _mentionIdx ? ' active' : '');
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        _mentionIdx = (_mentionIdx - 1 + _mentionItems.length) % _mentionItems.length;
        var items = mentionDropdown.querySelectorAll('.mention-item');
        for (var i = 0; i < items.length; i++) items[i].className = 'mention-item' + (i === _mentionIdx ? ' active' : '');
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(_mentionItems[_mentionIdx].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        hideMentionDropdown();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !composing && !e.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      voiceTriggered = false;
      sendMessage();
    }
  });

  sendBtn.addEventListener('touchstart', function(e) {
    e.preventDefault(); // prevent focus loss from input
  });
  sendBtn.addEventListener('touchend', function(e) {
    e.preventDefault();
    voiceTriggered = false;
    dbg('send touchend, input=' + JSON.stringify(msgInput.value) + ' state=' + state);
    sendMessage();
  });
  sendBtn.addEventListener('click', function(e) {
    voiceTriggered = false;
    dbg('send click, input=' + JSON.stringify(msgInput.value) + ' state=' + state);
    sendMessage();
  });

  // ---- Pro Mode ----
  proBtn.addEventListener('click', function() {
    location.href = '/terminal?session=' + encodeURIComponent(sessionId);
  });

  // ---- Projects (API-based session list) ----
  function renderProjects() {
    // Remove old chips (except new-project-btn)
    var chips = projectBar.querySelectorAll('.project-chip:not(.add)');
    for (var i = 0; i < chips.length; i++) chips[i].remove();

    projects.forEach(function(p) {
      var chip = document.createElement('div');
      chip.className = 'project-chip' + (p === activeProject ? ' active' : '');
      chip.textContent = p;
      chip.addEventListener('click', function() {
        switchProject(p);
      });
      projectBar.insertBefore(chip, newProjectBtn);
    });
  }

  function loadMenuProjects() {
    if (!menuProjects) return;
    fetch('/terminal/api/sessions', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        var sessions = (data.sessions || []).filter(function(s) { return s.mode === 'easy'; });
        sessions.sort(function(a, b) { return (b.lastActivity || b.createdAt || 0) - (a.lastActivity || a.createdAt || 0); });
        menuProjects.innerHTML = '';
        if (!sessions.length) {
          menuProjects.innerHTML = '<div style="padding:8px 20px;color:#86868b;font-size:13px;">' + _t('portal.empty_title') + '</div>';
          return;
        }
        sessions.forEach(function(s) {
          var isCurrent = s.id === sessionId;
          var item = document.createElement('a');
          item.className = 'menu-proj-item' + (isCurrent ? ' current' : '');
          item.href = '/terminal/easy?session=' + encodeURIComponent(s.id) + (s.project ? '&project=' + encodeURIComponent(s.project) : '');

          var dot = document.createElement('span');
          dot.className = 'menu-proj-dot' + (isCurrent ? ' current' : (s.clientCount > 0 || s.clients > 0 ? ' active' : ''));

          var nameEl = document.createElement('span');
          nameEl.className = 'menu-proj-name';
          nameEl.textContent = s.name || s.project || s.id;

          var actions = document.createElement('span');
          actions.className = 'menu-proj-actions';

          var renameBtn = document.createElement('button');
          renameBtn.className = 'menu-proj-act';
          renameBtn.textContent = '✎';
          renameBtn.addEventListener('click', function(e) {
            e.preventDefault(); e.stopPropagation();
            menuProjRename(s.id, item, nameEl);
          });

          var deleteBtn = document.createElement('button');
          deleteBtn.className = 'menu-proj-act delete';
          deleteBtn.textContent = '✕';
          deleteBtn.addEventListener('click', function(e) {
            e.preventDefault(); e.stopPropagation();
            menuProjDelete(s.id, s.name || s.project || s.id, item);
          });

          actions.appendChild(renameBtn);
          actions.appendChild(deleteBtn);
          item.appendChild(dot);
          item.appendChild(nameEl);
          item.appendChild(actions);
          menuProjects.appendChild(item);
        });
      })
      .catch(function() {
        menuProjects.innerHTML = '<div style="padding:8px 20px;color:#ff3b30;font-size:13px;">' + _t('easy.files.error_load') + '</div>';
      });
  }

  function menuProjRename(sid, item, nameEl) {
    var oldName = nameEl.textContent;
    var input = document.createElement('input');
    input.className = 'menu-proj-rename-input';
    input.value = oldName;
    nameEl.style.display = 'none';
    var actionsEl = item.querySelector('.menu-proj-actions');
    if (actionsEl) actionsEl.style.display = 'none';
    nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
    input.focus();
    input.select();
    function save() {
      var val = input.value.trim();
      if (input._done) return; input._done = true;
      input.remove();
      nameEl.style.display = '';
      if (actionsEl) actionsEl.style.display = '';
      if (val && val !== oldName) {
        nameEl.textContent = val;
        fetch('/terminal/rename', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ session: sid, name: val, oldName: oldName })
        });
        // Update local project list and page title if current session
        if (sid === sessionId) {
          var safeVal = val.replace(/[^a-zA-Z0-9_\\-\\u4e00-\\u9fff]/g, '-');
          var idx = projects.indexOf(activeProject);
          if (idx >= 0) projects[idx] = safeVal;
          activeProject = safeVal;
          localStorage.setItem('easy_projects_' + username, JSON.stringify(projects));
          localStorage.setItem('easy_active_project_' + username, safeVal);
          document.title = val + ' - Hopcode';
          _originalTitle = document.title;
          renderProjects();
        }
      }
    }
    input.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); });
    input.addEventListener('keydown', function(e) {
      e.stopPropagation();
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') { input._done = true; input.remove(); nameEl.style.display = ''; if (actionsEl) actionsEl.style.display = ''; }
    });
    input.addEventListener('blur', save);
  }

  function menuProjDelete(sid, name, item) {
    if (!confirm(_t('portal.confirm_delete', { name: name }))) return;
    item.style.opacity = '0.4';
    fetch('/terminal/sessions/' + encodeURIComponent(sid), {
      method: 'DELETE', credentials: 'include'
    }).then(function(r) {
      if (r.ok) {
        item.remove();
        if (sid === sessionId) location.href = '/terminal';
      } else { item.style.opacity = ''; }
    }).catch(function() { item.style.opacity = ''; });
  }

  function switchProject(name) {
    activeProject = name;
    localStorage.setItem('easy_active_project_' + username, name);
    location.href = '/terminal/easy';
  }

  newProjectBtn.addEventListener('click', function() {
    projectNameInput.value = '';
    newProjectModal.classList.add('show');
    projectNameInput.focus();
  });

  modalCancel.addEventListener('click', function() {
    newProjectModal.classList.remove('show');
  });

  modalOk.addEventListener('click', createProject);
  projectNameInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') createProject();
  });

  function createProject() {
    var name = projectNameInput.value.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
    if (!name) return;
    newProjectModal.classList.remove('show');
    if (projects.indexOf(name) < 0) {
      projects.push(name);
      localStorage.setItem('easy_projects_' + username, JSON.stringify(projects));
    }
    var codingDir = homeDir + '/coding';
    fetch('/terminal/mkdir?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(codingDir) + '&name=' + encodeURIComponent(name) + '&exists=rename', { method: 'POST' })
      .then(function() { switchProject(name); })
      .catch(function() { switchProject(name); });
  }

  renderProjects();

  // ---- Files panel ----
  var _fileAccessPending = false;

  function updateFileAccessUI() {
    if (_hasFileAccess) {
      // Has access — show normal file browser
      filesPanel.classList.remove('no-access');
      var reqPanel = document.getElementById('file-access-request');
      if (reqPanel) reqPanel.style.display = 'none';
      // Reload files if panel is visible
      if (isDesktop() || filesPanel.classList.contains('open')) {
        loadFiles('');
      }
    } else {
      // No access — show request UI
      filesPanel.classList.add('no-access');
      fpList.innerHTML = '';
      fpPath.textContent = '';
      var reqPanel = document.getElementById('file-access-request');
      if (!reqPanel) {
        reqPanel = document.createElement('div');
        reqPanel.id = 'file-access-request';
        reqPanel.className = 'file-access-request';
        reqPanel.innerHTML = '<div class="file-access-icon">&#128274;</div>' +
          '<div class="file-access-text">' + _t('easy.files.no_access') + '</div>' +
          '<button class="file-access-btn" id="request-access-btn">' + _t('easy.files.request_access') + '</button>' +
          '<div class="file-access-status" id="file-access-status" style="display:none;">' + _t('easy.files.access_pending') + '</div>';
        fpList.parentElement.insertBefore(reqPanel, fpList);
      }
      reqPanel.style.display = '';
      var reqBtn = document.getElementById('request-access-btn');
      var reqStatus = document.getElementById('file-access-status');
      if (_fileAccessPending) {
        reqBtn.style.display = 'none';
        reqStatus.style.display = '';
      }
      reqBtn.onclick = function() {
        wsSend({ type: 'request_file_access' });
        _fileAccessPending = true;
        reqBtn.style.display = 'none';
        reqStatus.style.display = '';
      };
    }
  }

  function showFileAccessRequest(user) {
    // Owner sees a prompt to grant access
    var div = document.createElement('div');
    div.className = 'msg system file-access-grant';
    div.innerHTML = '<span>' + _t('easy.files.grant_prompt', { user: escHtml(user) }) + '</span>' +
      '<button class="file-grant-btn" data-user="' + escHtml(user) + '">' + _t('easy.files.grant_btn') + '</button>';
    chatArea.appendChild(div);
    autoScroll();
    div.querySelector('.file-grant-btn').addEventListener('click', function() {
      wsSend({ type: 'grant_file_access', user: this.getAttribute('data-user') });
      div.innerHTML = '<span>' + _t('easy.files.granted', { user: escHtml(user) }) + '</span>';
    });
  }

  function openFiles() {
    if (isDesktop()) {
      if (!_hasFileAccess) { updateFileAccessUI(); return; }
      loadFiles('');
      return;
    }
    filesPanel.classList.add('open');
    filesOverlay.classList.add('show');
    if (!_hasFileAccess) { updateFileAccessUI(); return; }
    loadFiles('');
  }
  function closeFiles() {
    if (isDesktop()) return; // Never close on desktop
    filesPanel.classList.remove('open');
    filesOverlay.classList.remove('show');
  }
  fpClose.addEventListener('click', closeFiles);
  filesOverlay.addEventListener('click', closeFiles);

  // Collapse/expand files panel (desktop)
  var fpCollapseBtn = document.getElementById('fp-collapse');
  if (fpCollapseBtn) {
    var filesCollapsed = localStorage.getItem('easy_files_collapsed') === '1';
    if (filesCollapsed) filesPanel.classList.add('collapsed');
    fpCollapseBtn.addEventListener('click', function() {
      filesPanel.classList.toggle('collapsed');
      localStorage.setItem('easy_files_collapsed', filesPanel.classList.contains('collapsed') ? '1' : '0');
    });
  }

  function loadFiles(dir) {
    if (!_hasFileAccess) { updateFileAccessUI(); return; }
    // Sandbox: restrict to project directory (only when projectDir is known)
    var rootDir = _projectDir || '';
    if (rootDir && dir && !dir.startsWith(rootDir)) {
      dir = rootDir;
    }
    // Default to project root if no dir specified and we know projectDir
    if (!dir && rootDir) dir = rootDir;

    filePath = dir;
    fpPath.textContent = dir ? dir.replace(rootDir, _t('easy.files.project_root')) : _t('loading');
    fpList.innerHTML = '<div style="padding:20px;text-align:center;color:#86868b;">' + _t('loading') + '</div>';

    fetch('/terminal/files?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(dir))
      .then(function(r) { return r.json(); })
      .then(function(resp) {
        var items = resp.items || resp;
        if (resp.path) {
          filePath = resp.path;
          dir = resp.path;
        }
        // Enforce sandbox — if server returned path above project root, clamp
        if (rootDir && !dir.startsWith(rootDir)) {
          loadFiles(rootDir);
          return;
        }
        fpPath.textContent = dir.replace(rootDir, _t('easy.files.project_root')) || _t('easy.files.project_root');
        fpList.innerHTML = '';
        // Column header
        var colHdr = document.createElement('div');
        colHdr.className = 'fp-col-header';
        colHdr.innerHTML = '<span class="name">Name</span><span class="date">Modified</span>';
        fpList.appendChild(colHdr);
        // Back button (visible ← instead of ..)
        var canGoUp = rootDir ? (dir !== rootDir) : (dir !== '/' && dir !== homeDir);
        if (canGoUp) {
          var parent = dir.split('/').slice(0, -1).join('/') || '/';
          // Clamp parent to project root
          if (rootDir && !parent.startsWith(rootDir)) parent = rootDir;
          var up = document.createElement('div');
          up.className = 'fp-item fp-back';
          up.innerHTML = '<span class="icon"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M19 12H5M12 19l-7-7 7-7"/></svg></span><span class="name">' + _t('easy.files.back') + '</span><span class="date"></span>';
          up.addEventListener('click', function() { loadFiles(parent); });
          fpList.appendChild(up);
        }
        if (!items || !items.length) {
          var emptyDiv = document.createElement('div');
          emptyDiv.style.cssText = 'padding:20px;text-align:center;color:#86868b;';
          emptyDiv.textContent = _t('easy.files.empty');
          fpList.appendChild(emptyDiv);
          return;
        }
        // Sort: dirs first, then files
        items.sort(function(a,b) {
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        items.forEach(function(item) {
          var row = document.createElement('div');
          row.className = 'fp-item';
          var icon = item.isDirectory ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="#60a5fa"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>' : fileIcon(item.name);
          var dateStr = item.modified ? fmtDate(item.modified) : '';
          row.innerHTML = '<span class="icon">' + icon + '</span><span class="name">' + escHtml(item.name) + '</span><span class="date">' + dateStr + '</span>';

          if (item.isDirectory) {
            row.addEventListener('click', function() { loadFiles(dir + '/' + item.name); });
          } else {
            var preview = !item.isDirectory && canPreview(item.name);
            var acts = document.createElement('span');
            acts.className = 'fp-actions';

            if (preview) {
              // Preview button
              var pvBtn = document.createElement('button');
              pvBtn.className = 'fp-act';
              pvBtn.title = 'Preview';
              pvBtn.innerHTML = '&#9654;';  // ▶
              pvBtn.addEventListener('click', function(e) {
                e.stopPropagation();
                var url = makeServeUrl(dir, item.name);
                if (url) { setPreviewUrl(url, true); if (!isDesktop()) showTab('preview'); }
              });
              acts.appendChild(pvBtn);
            }

            // Download button
            var dlBtn = document.createElement('button');
            dlBtn.className = 'fp-act';
            dlBtn.title = 'Download';
            dlBtn.innerHTML = '&#8615;';  // ⇩
            dlBtn.addEventListener('click', function(e) {
              e.stopPropagation();
              var a = document.createElement('a');
              a.href = '/terminal/download?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(dir + '/' + item.name);
              a.download = item.name;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
            });
            acts.appendChild(dlBtn);
            row.appendChild(acts);

            // Row click: preview if possible, else download
            row.addEventListener('click', function() {
              if (preview) {
                var url = makeServeUrl(dir, item.name);
                if (url) { setPreviewUrl(url, true); if (!isDesktop()) showTab('preview'); }
              } else {
                var a = document.createElement('a');
                a.href = '/terminal/download?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(dir + '/' + item.name);
                a.download = item.name;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
              }
            });
          }
          fpList.appendChild(row);
        });
      })
      .catch(function() {
        fpList.innerHTML = '<div style="padding:20px;text-align:center;color:#ff3b30;">' + _t('easy.files.error_load') + '</div>';
      });
  }

  // Desktop: auto-load files panel (deferred to session_info for access control)
  window._loadFiles = loadFiles;
  if (isDesktop()) { desktopFilesLoaded = true; loadFiles(''); }

  var _previewExts = ['html','htm','svg','csv','md','png','jpg','jpeg','gif','webp','pdf'];
  function canPreview(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    return _previewExts.indexOf(ext) >= 0;
  }
  function makeServeUrl(dir, name) {
    if (!_projectDir) return '';
    var parts = _projectDir.split('/').filter(Boolean);
    // If _projectDir ends with /workspace, project name is the parent dir
    var project = (parts[parts.length - 1] === 'workspace' && parts.length >= 2)
      ? parts[parts.length - 2] : parts[parts.length - 1];
    if (!project) return '';
    var relPath = (dir + '/' + name).replace(_projectDir + '/', '');
    // If browsing inside workspace/, prefix the serve path with workspace/
    if (_projectDir.endsWith('/workspace') || _projectDir.endsWith('/workspace/')) relPath = 'workspace/' + relPath;
    var ext = (name.split('.').pop() || '').toLowerCase();
    var url = '/serve/' + project + '/' + relPath;
    if (ext === 'csv' || ext === 'md') url += '?render=1';
    return url;
  }

  function fileIcon(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    var icons = {
      html:'&#127760;', htm:'&#127760;', css:'&#127912;', js:'&#9889;', ts:'&#9889;', jsx:'&#9889;', tsx:'&#9889;',
      json:'&#128203;', md:'&#128221;', txt:'&#128221;', csv:'&#128202;',
      png:'&#127748;', jpg:'&#127748;', jpeg:'&#127748;', gif:'&#127748;', svg:'&#127748;', webp:'&#127748;', ico:'&#127748;',
      pdf:'&#128213;', zip:'&#128230;', gz:'&#128230;', tar:'&#128230;',
      py:'&#128013;', rb:'&#128142;', go:'&#128049;', rs:'&#9881;', java:'&#9749;', sh:'&#128424;', bash:'&#128424;',
    };
    return icons[ext] || '&#128196;';
  }

  function fmtDate(ms) {
    var d = new Date(ms);
    var now = new Date();
    var mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    var h = d.getHours(), m = d.getMinutes();
    var time = (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
    if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
      return time;
    }
    if (d.getFullYear() === now.getFullYear()) {
      return mon[d.getMonth()] + ' ' + d.getDate() + ' ' + time;
    }
    return d.getFullYear() + '-' + (d.getMonth()+1) + '-' + d.getDate();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + 'K';
    return (bytes / 1048576).toFixed(1) + 'M';
  }

  function escHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // File upload (from files panel — uses filePath which is the panel's current dir)
  fpUploadBtn.addEventListener('click', function() {
    fileInputHidden.dataset.dest = 'panel';
    fileInputHidden.click();
  });
  // Upload button in input bar — uses empty path so server resolves to PTY CWD
  document.getElementById('upload-btn').addEventListener('click', function() {
    fileInputHidden.dataset.dest = 'cwd';
    fileInputHidden.click();
  });
  fileInputHidden.addEventListener('change', function() {
    var files = fileInputHidden.files;
    if (!files.length) return;
    var dest = fileInputHidden.dataset.dest === 'panel' ? filePath : '';
    for (var i = 0; i < files.length; i++) {
      uploadFile(files[i], dest);
    }
    fileInputHidden.value = '';
  });

  // ---- Drag & drop on files panel ----
  var _dragCounter = 0;
  fpList.addEventListener('dragenter', function(e) {
    e.preventDefault(); e.stopPropagation();
    _dragCounter++;
    fpList.classList.add('fp-dragover');
  });
  fpList.addEventListener('dragleave', function(e) {
    e.preventDefault(); e.stopPropagation();
    _dragCounter--;
    if (_dragCounter <= 0) { _dragCounter = 0; fpList.classList.remove('fp-dragover'); }
  });
  fpList.addEventListener('dragover', function(e) {
    e.preventDefault(); e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });
  fpList.addEventListener('drop', function(e) {
    e.preventDefault(); e.stopPropagation();
    _dragCounter = 0;
    fpList.classList.remove('fp-dragover');
    if (!_hasFileAccess) return;
    var files = e.dataTransfer.files;
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      uploadFile(files[i], filePath);
    }
  });
  // Also allow drop on the whole files panel (header, path bar, etc.)
  filesPanel.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; });
  filesPanel.addEventListener('drop', function(e) {
    e.preventDefault(); e.stopPropagation();
    _dragCounter = 0;
    fpList.classList.remove('fp-dragover');
    if (!_hasFileAccess) return;
    var files = e.dataTransfer.files;
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) {
      uploadFile(files[i], filePath);
    }
  });

  var pendingUploads = [];
  var uploadBatchTimer = null;
  function uploadFile(file, destDir) {
    var url = '/terminal/file-upload?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(destDir);
    fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-Filename': encodeURIComponent(file.name) },
      body: file,
    })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) { addSystemMsg(_t('easy.msg.upload_failed') + file.name + ' - ' + data.error); return; }
        if (isDesktop() || filesPanel.classList.contains('open')) loadFiles(destDir);
        pendingUploads.push(data.path || (destDir + '/' + file.name));
        clearTimeout(uploadBatchTimer);
        uploadBatchTimer = setTimeout(function() {
          var paths = pendingUploads.slice();
          pendingUploads = [];
          var msg = _t('easy.msg.uploaded') + paths.join(', ');
          currentAssistantMsg = null;
          wsSend({ type: 'send', text: msg });
        }, 500);
      })
      .catch(function() { addSystemMsg(_t('easy.msg.upload_failed') + file.name); });
  }

  // New folder
  fpMkdirBtn.addEventListener('click', function() {
    var name = prompt(_t('easy.files.prompt_folder'));
    if (!name) return;
    fetch('/terminal/mkdir?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(filePath) + '&name=' + encodeURIComponent(name), { method: 'POST' })
      .then(function() { loadFiles(filePath); })
      .catch(function() { addSystemMsg(_t('failed')); });
  });

  // ---- Apps panel ----
  appsBtn.addEventListener('click', function() {
    appsPanel.classList.add('open');
    filesOverlay.classList.add('show');
    loadApps();
  });
  appsClose.addEventListener('click', function() {
    appsPanel.classList.remove('open');
    filesOverlay.classList.remove('show');
  });

  function loadApps() {
    appsList.innerHTML = '<div style="padding:20px;text-align:center;color:#6b7280;">Checking apps...</div>';
    // We don't have a direct API for pony-app list, so show instructions
    appsList.innerHTML = '<div style="padding:16px;font-size:13px;color:#9ca3af;line-height:1.6;">' +
      '<p style="margin-bottom:12px;">Ask Claude to deploy your app:</p>' +
      '<p style="color:#e0e0e0;margin-bottom:12px;">"Start a server on port 8001 and register it with pony-app"</p>' +
      '<p style="margin-bottom:8px;">Your apps will be available at:</p>' +
      '<p style="color:#60a5fa;word-break:break-all;">https://gotong.gizwitsapi.com/' + escHtml(linuxUser || username) + '/&lt;app-name&gt;/</p>' +
      '</div>';
  }

  // ---- Voice (ASR) — Pro-style unified ----
  var voiceWs = null;
  var audioStream = null, audioContext = null, sourceNode = null, processorNode = null;
  var audioReady = false;
  var isRecording = false;
  var wantsToStop = false;
  var micReleaseTimer = null;
  var pendingAsrText = '';
  var cancelledRec = false;
  var asrFlushed = false;
  var releaseFlushTimer = null;
  var trailingTimer = null;
  var voiceRetryDelay = 1000;
  var holdKeyName = /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Option' : 'Alt';

  function releaseMic() {
    audioReady = false;
    if (sourceNode) { try { sourceNode.disconnect(); } catch {} sourceNode = null; }
    if (processorNode) { try { processorNode.disconnect(); } catch {} processorNode = null; }
    if (audioStream) { audioStream.getTracks().forEach(function(t) { t.stop(); }); audioStream = null; }
    if (audioContext) { try { audioContext.close(); } catch {} audioContext = null; }
  }

  function scheduleMicRelease() {
    clearTimeout(micReleaseTimer);
    micReleaseTimer = setTimeout(releaseMic, 30000);
  }

  // Voice popup helpers
  function vpShow() {
    vpText.textContent = '';
    vpText.classList.add('listening');
    vpHint.textContent = _t('easy.voice.hint_default');
    vpHint.style.display = '';
    vpActions.style.display = 'none';
    vpEl.classList.remove('hidden', 'cancel', 'send-ready');
    vpConfirmVisible = false;
  }
  function vpHide() {
    vpEl.classList.add('hidden');
    vpEl.classList.remove('cancel', 'send-ready');
    vpActions.style.display = 'none';
    vpConfirmVisible = false;
    vpText.contentEditable = 'false';
  }
  function vpUpdate(txt) {
    vpText.textContent = txt;
    vpText.classList.remove('listening');
  }
  function vpSetCancel(on) {
    if (on) { vpEl.classList.add('cancel'); vpEl.classList.remove('send-ready'); vpHint.textContent = _t('easy.voice.hint_cancel'); }
    else { vpEl.classList.remove('cancel'); vpHint.textContent = _t('easy.voice.hint_default'); }
  }
  function vpShowConfirm() {
    vpActions.style.display = 'flex';
    vpEl.classList.remove('cancel', 'send-ready');
    vpConfirmVisible = true;
    vpText.contentEditable = 'true';
    setTimeout(function() { vpText.focus(); }, 100);
    var range = document.createRange();
    range.selectNodeContents(vpText);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    vpHint.textContent = _t('easy.voice.hint_confirm');
  }
  function vpSendAction() {
    vpConfirmVisible = false;
    vpText.contentEditable = 'false';
    var finalText = (vpText.textContent || '').trim();
    if (finalText && state === 'ready') {
      asrFlushed = true;
      currentAssistantMsg = null;
      wsSend({ type: 'send', text: finalText });
    }
    pendingAsrText = '';
    vpHide();
  }
  function vpDismiss() {
    vpConfirmVisible = false;
    vpText.contentEditable = 'false';
    pendingAsrText = '';
    asrFlushed = true;
    vpHide();
  }
  document.getElementById('vp-send').onclick = vpSendAction;
  document.getElementById('vp-cancel-btn').onclick = vpDismiss;

  // Keyboard shortcuts for confirm popup
  document.addEventListener('keydown', function(e) {
    if (!vpConfirmVisible) return;
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); vpSendAction(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); vpDismiss(); }
  }, true);

  function fillInputFromVoice(text) {
    // Switch to keyboard mode if in voice mode
    if (voiceMode) {
      voiceMode = false;
      holdSpeak.classList.remove('show');
      msgInput.style.display = '';
      vtMicIcon.style.display = '';
      vtKbIcon.style.display = 'none';
      voiceToggle.classList.remove('active');
    }
    msgInput.value = text;
    updateSendBtn();
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
    msgInput.focus();
    msgInput.selectionStart = msgInput.selectionEnd = text.length;
  }

  function flushAsrText() {
    if (asrFlushed) return;
    if (isRecording || altDown) return;
    if (pendingAsrText) {
      vpShowConfirm();
    } else {
      vpHide();
    }
  }

  function connectVoice() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    voiceWs = new WebSocket(proto + '//' + location.host + '/terminal/ws-voice');
    voiceWs.onopen = function() {
      voiceRetryDelay = 1000;
      if (isRecording && !cancelledRec) voiceWs.send(JSON.stringify({ type: 'asr_start' }));
    };
    voiceWs.onmessage = function(e) {
      var d = JSON.parse(e.data);
      if (cancelledRec) return;
      if (d.type === 'asr' && d.text) {
        clearTimeout(releaseFlushTimer);
        if (!vpConfirmVisible && d.text !== pendingAsrText) {
          pendingAsrText = d.text;
          vpUpdate(d.text);
        } else if (vpConfirmVisible) {
          pendingAsrText = d.text;
        }
        if (!asrFlushed) flushAsrText();
      } else if (d.type === 'asr_partial' && d.text) {
        if (!asrFlushed && !vpConfirmVisible) {
          pendingAsrText = d.text;
          vpUpdate(d.text);
        }
      } else if (d.type === 'error') {
        clearTimeout(releaseFlushTimer);
        if (pendingAsrText && !asrFlushed) {
          flushAsrText();
        } else {
          vpUpdate(_t('easy.voice.error'));
          setTimeout(vpHide, 2000);
        }
      }
    };
    voiceWs.onclose = function() {
      clearTimeout(releaseFlushTimer);
      clearTimeout(trailingTimer);
      isRecording = false;
      wantsToStop = false;
      cancelledRec = false;
      vpHide();
      scheduleMicRelease();
      voiceRetryDelay = Math.min((voiceRetryDelay || 1000) * 1.5, 15000);
      setTimeout(connectVoice, voiceRetryDelay);
    };
  }

  async function acquireMic() {
    if (audioReady) return true;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      addSystemMsg(window.isSecureContext ? _t('easy.voice.no_mic') : 'Mic requires HTTPS');
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
    } catch(err) {
      addSystemMsg(_t('easy.voice.no_mic'));
      return false;
    }
  }

  async function startRec() {
    if (isRecording) return;
    clearTimeout(micReleaseTimer);
    clearTimeout(releaseFlushTimer);
    clearTimeout(trailingTimer);
    wantsToStop = false;
    var ok = await acquireMic();
    if (!ok) return;
    if (audioContext.state === 'suspended') audioContext.resume();
    isRecording = true;
    asrFlushed = false;
    pendingAsrText = '';
    cancelledRec = false;
    if (voiceWs && voiceWs.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_start' }));
    if (wantsToStop) { stopRec(true); return; }
    holdSpeak.classList.add('recording');
    vpShow();
  }

  function stopRec(cancel) {
    wantsToStop = true;
    clearTimeout(trailingTimer);
    if (!isRecording) return;
    holdSpeak.classList.remove('recording');

    if (cancel) {
      isRecording = false;
      cancelledRec = true;
      asrFlushed = true;
      pendingAsrText = '';
      vpHide();
      if (voiceWs && voiceWs.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
      scheduleMicRelease();
      return;
    }

    // Trailing capture: keep recording 300ms to catch trailing speech
    trailingTimer = setTimeout(function() {
      isRecording = false;
      if (voiceWs && voiceWs.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
      scheduleMicRelease();

      if (asrFlushed) return;
      clearTimeout(releaseFlushTimer);
      if (pendingAsrText) {
        releaseFlushTimer = setTimeout(function() { if (!asrFlushed) flushAsrText(); }, 300);
      } else {
        releaseFlushTimer = setTimeout(function() { if (!asrFlushed) flushAsrText(); }, 3000);
      }
    }, 300);
  }

  // Voice toggle: switch between text input and hold-to-speak
  var voiceMode = false;
  voiceToggle.addEventListener('click', function() {
    voiceMode = !voiceMode;
    if (voiceMode) {
      holdSpeak.classList.add('show');
      msgInput.style.display = 'none';
      sendBtn.classList.remove('show');
      vtMicIcon.style.display = 'none';
      vtKbIcon.style.display = '';
      voiceToggle.classList.add('active');
    } else {
      holdSpeak.classList.remove('show');
      msgInput.style.display = '';
      vtMicIcon.style.display = '';
      vtKbIcon.style.display = 'none';
      voiceToggle.classList.remove('active');
      updateSendBtn();
      msgInput.focus();
    }
  });

  // Hold-to-speak button
  var micDown = false;
  var holdTouchStartY = 0;
  var holdSwipedCancel = false;
  holdSpeak.addEventListener('touchstart', function(e) {
    e.preventDefault();
    micDown = true;
    holdTouchStartY = e.touches[0].clientY;
    holdSwipedCancel = false;
    holdSpeak.textContent = _t('easy.btn.release_to_send');
    startRec();
  }, { passive: false });
  holdSpeak.addEventListener('touchmove', function(e) {
    if (!micDown) return;
    var dy = holdTouchStartY - e.touches[0].clientY;
    if (dy > 50 && !holdSwipedCancel) {
      holdSwipedCancel = true;
      holdSpeak.textContent = _t('easy.btn.release_to_cancel');
      vpSetCancel(true);
    } else if (dy <= 30 && holdSwipedCancel) {
      holdSwipedCancel = false;
      holdSpeak.textContent = _t('easy.btn.release_to_send');
      vpSetCancel(false);
    }
  }, { passive: true });
  holdSpeak.addEventListener('touchend', function(e) {
    e.preventDefault();
    if (!micDown) return;
    micDown = false;
    holdSpeak.textContent = _t('easy.btn.hold_to_speak');
    stopRec(holdSwipedCancel);
  }, { passive: false });
  holdSpeak.addEventListener('touchcancel', function() {
    micDown = false;
    holdSpeak.textContent = _t('easy.btn.hold_to_speak');
    stopRec(true);
  });
  holdSpeak.addEventListener('contextmenu', function(e) { e.preventDefault(); });
  // Mouse events for desktop
  holdSpeak.addEventListener('mousedown', function(e) {
    e.preventDefault();
    micDown = true;
    holdSwipedCancel = false;
    holdSpeak.textContent = _t('easy.btn.release_to_send');
    startRec();
  });
  document.addEventListener('mouseup', function() {
    if (!micDown) return;
    micDown = false;
    holdSpeak.textContent = _t('easy.btn.hold_to_speak');
    stopRec(holdSwipedCancel);
  });

  // ---- Option/Alt hold-to-speak ----
  var altDown = false, altDownTime = 0, altCombined = false;
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Alt' && !altDown) {
      altDown = true;
      altDownTime = Date.now();
      altCombined = false;
      if (vpConfirmVisible) { e.preventDefault(); e.stopPropagation(); return; }
      startRec();
      e.preventDefault();
      e.stopPropagation();
    } else if (altDown && e.key !== 'Alt') {
      altCombined = true;
      if (isRecording) stopRec(true);
    }
  }, true);
  document.addEventListener('keyup', function(e) {
    if (e.key === 'Alt' && altDown) {
      altDown = false;
      var holdDuration = Date.now() - altDownTime;
      e.preventDefault();
      e.stopPropagation();
      if (vpConfirmVisible) { vpSendAction(); return; }
      if (altCombined || holdDuration < 800) {
        if (isRecording) stopRec(true);
      } else {
        stopRec(false);
      }
    }
  }, true);

  // ---- Drag & drop upload ----
  document.addEventListener('dragover', function(e) { e.preventDefault(); });
  document.addEventListener('drop', function(e) {
    e.preventDefault();
    var files = e.dataTransfer.files;
    if (!files.length) return;
    for (var i = 0; i < files.length; i++) {
      uploadFile(files[i], '');
    }
    addSystemMsg(_t('easy.msg.uploading', {n: files.length}));
  });

  // ---- Init ----
  msgInput.placeholder = (('ontouchstart' in window || navigator.maxTouchPoints > 0) || window.innerWidth < 768 || msgInput.offsetWidth < 300) ? _t('easy.input.placeholder_mobile') : _t('easy.input.placeholder', {key: /Mac|iPhone|iPad/.test(navigator.userAgent) ? 'Option' : 'Alt'});
  restoreChatHistory();
  connectWs();
  connectVoice();

  // Mobile keyboard: resize #app to visual viewport so top bar stays visible
  var appEl = document.getElementById('app');
  if (window.visualViewport && appEl) {
    var _vvRaf = false;
    function syncAppHeight() {
      if (_vvRaf) return;
      _vvRaf = true;
      requestAnimationFrame(function() {
        _vvRaf = false;
        appEl.style.height = window.visualViewport.height + 'px';
        // Reset any page scroll caused by keyboard
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
      });
    }
    window.visualViewport.addEventListener('resize', syncAppHeight);
    window.visualViewport.addEventListener('scroll', function() {
      window.scrollTo(0, 0);
      document.documentElement.scrollTop = 0;
    });
    syncAppHeight();
  }

  // Set initial file path to project dir
  if (activeProject) {
    filePath = homeDir + '/coding/' + activeProject;
  }

  // Ensure coding dir exists
  fetch('/terminal/mkdir?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(homeDir) + '&name=coding&exists=skip', { method: 'POST' }).catch(function(){});

  // ---- Desktop swap + resize handles ----
  if (isDesktop()) {
    var mainContent = document.getElementById('main-content');
    var leftPanel = document.getElementById('left-panel');
    var previewContainer = document.getElementById('preview-container');
    var resizeChatPreview = document.getElementById('resize-chat-preview');
    var resizeFilesChat = document.getElementById('resize-files-chat');

    // Swap panels button
    var swapBtn = document.getElementById('preview-swap');
    if (localStorage.getItem('easy_swapped') === '1') { mainContent.classList.add('swapped'); document.body.classList.add('swapped'); }
    swapBtn.addEventListener('click', function() {
      mainContent.classList.toggle('swapped');
      document.body.classList.toggle('swapped');
      localStorage.setItem('easy_swapped', mainContent.classList.contains('swapped') ? '1' : '0');
    });

    function setupResize(handle, onMove) {
      if (!handle) return;
      function onDown(e) {
        e.preventDefault();
        handle.classList.add('active');
        var ev = e.touches ? e.touches[0] : e;
        onMove('start', ev.clientX, ev.clientY);
        document.addEventListener('mousemove', onDrag);
        document.addEventListener('mouseup', onUp);
        document.addEventListener('touchmove', onDrag, {passive:false});
        document.addEventListener('touchend', onUp);
        // Prevent iframe from stealing pointer events
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) iframes[i].style.pointerEvents = 'none';
      }
      function onDrag(e) {
        e.preventDefault();
        var ev = e.touches ? e.touches[0] : e;
        onMove('move', ev.clientX, ev.clientY);
      }
      function onUp() {
        handle.classList.remove('active');
        document.removeEventListener('mousemove', onDrag);
        document.removeEventListener('mouseup', onUp);
        document.removeEventListener('touchmove', onDrag);
        document.removeEventListener('touchend', onUp);
        var iframes = document.querySelectorAll('iframe');
        for (var i = 0; i < iframes.length; i++) iframes[i].style.pointerEvents = '';
        onMove('end', 0, 0);
      }
      handle.addEventListener('mousedown', onDown);
      handle.addEventListener('touchstart', onDown, {passive:false});
    }

    // Horizontal resize: left-panel vs preview
    setupResize(resizeChatPreview, function(phase, x) {
      if (phase === 'move') {
        var mcRect = mainContent.getBoundingClientRect();
        var swapped = mainContent.classList.contains('swapped');
        var newW = swapped ? (mcRect.right - x) : (x - mcRect.left);
        var minL = 260, minR = 200;
        newW = Math.max(minL, Math.min(mcRect.width - minR - 5, newW));
        leftPanel.style.width = newW + 'px';
        leftPanel.style.maxWidth = 'none';
        localStorage.setItem('easy_left_panel_w', String(newW));
      }
    });

    // Vertical resize: files-panel vs chat-area
    setupResize(resizeFilesChat, function(phase, x, y) {
      if (phase === 'move') {
        var newH = y - filesPanel.getBoundingClientRect().top;
        var maxH = leftPanel.offsetHeight - 200; // leave room for chat + input
        newH = Math.max(80, Math.min(maxH, newH));
        filesPanel.style.height = newH + 'px';
        localStorage.setItem('easy_files_panel_h', String(newH));
      }
    });

    // Restore saved sizes
    var savedLpW = parseInt(localStorage.getItem('easy_left_panel_w'));
    if (savedLpW > 0) { leftPanel.style.width = savedLpW + 'px'; leftPanel.style.maxWidth = 'none'; }
    var savedFpH = parseInt(localStorage.getItem('easy_files_panel_h'));
    if (savedFpH > 0) { filesPanel.style.height = savedFpH + 'px'; }
  }
})();
</script>
</body>
</html>`;
}

// Terminal HTML page
const indexHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
  <meta name="theme-color" content="#1a1a2e">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Hopcode">
  <link rel="manifest" href="./manifest.json">
  <link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="./icons/favicon-32.png">
  <link rel="apple-touch-icon" href="./icons/apple-touch-icon.png">
  <title>Hopcode</title>
  <script>${getI18nScript()}</script>
  <link rel="stylesheet" href="./vendor/xterm.css">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; background: #1a1a2e; }
    #container { display: flex; flex-direction: column; height: 100vh; height: 100dvh; }
    #terminal { flex: 1; padding: 8px; overflow: hidden; }
    .xterm-helper-textarea { opacity: 0 !important; caret-color: transparent !important; color: transparent !important; position: absolute !important; left: -9999px !important; }
    #voice-bar {
      background: #16213e; padding: 10px 16px; display: none; align-items: center; gap: 10px;
      border-top: 2px solid #0f3460; color: #fff; font-family: system-ui;
      flex-shrink: 0; z-index: 60;
      -webkit-tap-highlight-color: transparent;
    }
    #voice-bar.recording { background: #1a3a2e; border-top-color: #4ade80; }
    #voice-bar.cancel-zone { background: #3a1a1a; border-top-color: #f87171; }
    #voice-bar.cancel-zone #status { background: #f87171; color: #000; animation: none; }
    #voice-popup {
      position: fixed; left: 50%; top: 40%; transform: translate(-50%, -50%);
      background: rgba(22,33,62,0.95); border: 1px solid #0f3460; border-radius: 16px;
      padding: 16px 20px; min-width: 200px; max-width: 80vw; z-index: 500;
      font-family: system-ui; color: #e0e0e0; text-align: center;
      box-shadow: 0 4px 24px rgba(0,0,0,0.5); transition: opacity 0.15s, transform 0.15s;
    }
    #voice-popup.hidden { display: none; }
    #voice-popup.cancel { background: rgba(58,26,26,0.95); border-color: #f87171; }
    #voice-popup.cancel #vp-dot { background: #f87171; animation: none; }
    #voice-popup.cancel #vp-hint { color: #f87171; font-weight: 600; }
    #voice-popup.send-ready { background: rgba(26,58,46,0.95); border-color: #4ade80; }
    #voice-popup.send-ready #vp-dot { background: #4ade80; }
    #voice-popup.send-ready #vp-hint { color: #4ade80; font-weight: 600; }
    #vp-indicator { margin-bottom: 8px; }
    #vp-dot {
      display: inline-block; width: 12px; height: 12px; border-radius: 50%;
      background: #4ade80; animation: pulse 1s infinite;
    }
    #vp-text {
      font-size: 16px; line-height: 1.5; color: #fff; min-height: 24px;
      max-height: 30vh; overflow-y: auto; word-break: break-word;
      outline: none; border-radius: 6px; padding: 4px;
      -webkit-overflow-scrolling: touch; touch-action: pan-y; overscroll-behavior: contain;
    }
    #vp-text[contenteditable="true"] {
      border: 1px solid #4ade80; background: rgba(0,0,0,0.3);
      -webkit-user-select: text; user-select: text; cursor: text;
    }
    #vp-hint { font-size: 12px; color: #666; margin-top: 8px; }
    #vp-actions { display: none; justify-content: center; gap: 12px; margin-top: 12px; }
    #vp-actions button { border: none; border-radius: 8px; padding: 8px 20px; font-size: 15px; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; }
    #vp-send { background: #4ade80; color: #000; }
    #vp-send:active { background: #22c55e; }
    #vp-cancel { background: #555; color: #fff; }
    #vp-cancel:active { background: #444; }
    #vp-text.listening::after { content: 'Listening...'; color: #888; animation: pulse 1.2s infinite; }
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
    .app-menu-section.collapsible {
      cursor:pointer;display:flex;align-items:center;justify-content:space-between;padding:10px 16px;
      font-size:14px;color:#e0e0e0;text-transform:none;letter-spacing:0;font-family:system-ui;gap:6px;
    }
    .app-menu-section.collapsible:hover { background:rgba(255,255,255,0.06); }
    .app-menu-section.collapsible::after { content:'\\25B8';font-size:10px;color:#888; }
    .app-menu-section.collapsible.open::after { content:'\\25BE'; }
    body.light-mode .app-menu-section.collapsible { color:#333; }
    .app-menu-collapse { display:none; }
    .app-menu-collapse.open { display:block; }
    .app-menu-row { display:flex;align-items:center; }
    .app-menu-btn {
      padding:6px 12px;background:#0f3460;color:#e0e0e0;border:none;border-radius:6px;
      font-size:13px;cursor:pointer;font-family:system-ui;
    }
    .app-menu-btn:active { background:#4ade80;color:#000; }
    .menu-sess-list { max-height:200px;overflow-y:auto;padding:2px 0; }
    .menu-sess-item {
      display:flex;align-items:center;gap:8px;padding:6px 16px;color:#e0e0e0;font-size:13px;
      font-family:system-ui;cursor:pointer;text-decoration:none;overflow:hidden;
    }
    .menu-sess-item:hover,.menu-sess-item:active { background:rgba(255,255,255,0.06); }
    .menu-sess-item.current { background:rgba(74,222,128,0.12);color:#4ade80; }
    .menu-sess-name { overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1; }
    .menu-sess-owner { font-size:10px;color:#888;background:rgba(255,255,255,0.06);padding:1px 5px;border-radius:3px;flex-shrink:0; }
    body.light-mode .menu-sess-owner { background:rgba(0,0,0,0.06);color:#999; }
    .menu-sess-actions { display:none;gap:4px;flex-shrink:0; }
    .menu-sess-item:hover .menu-sess-actions { display:flex; }
    .menu-sess-act { background:none;border:none;color:#888;font-size:12px;cursor:pointer;padding:2px 4px;border-radius:3px;line-height:1; }
    .menu-sess-act:hover { color:#fff;background:rgba(255,255,255,0.1); }
    .menu-sess-act.kill { color:#f87171; }
    .menu-sess-act.kill:hover { background:rgba(248,113,113,0.15); }
    .menu-sess-rename-input {
      background:#0a1628;border:1px solid #4ade80;color:#e0e0e0;font-size:13px;font-family:system-ui;
      padding:2px 6px;border-radius:4px;outline:none;flex:1;min-width:0;
    }
    body.light-mode .menu-sess-rename-input { background:#fff;border-color:#16a34a;color:#333; }
    body.light-mode .menu-sess-act { color:#999; }
    body.light-mode .menu-sess-act:hover { color:#333;background:rgba(0,0,0,0.06); }
    .menu-sess-dot { width:6px;height:6px;border-radius:50%;flex-shrink:0; }
    .menu-sess-dot.active { background:#4ade80; }
    .menu-sess-dot.idle { background:#555; }
    .menu-sess-dot.easy { background:#60a5fa; }
    body.light-mode .menu-sess-item { color:#333; }
    body.light-mode .menu-sess-item.current { background:rgba(34,197,94,0.12);color:#16a34a; }
    body.light-mode .menu-sess-dot.idle { background:#bbb; }
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
    #copy-overlay { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; z-index: 500; background: rgba(0,0,0,0.95); flex-direction: column; }
    #copy-overlay.active { display: flex; }
    #copy-overlay pre { flex: 1; overflow: auto; margin: 0; padding: 8px; color: #e0e0e0; font: 12px Menlo, Monaco, "Courier New", monospace; white-space: pre; -webkit-user-select: text; user-select: text; -webkit-overflow-scrolling: touch; }
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
    /* --- Chat Mode --- */
    #chat-bar {
      display: flex; flex-direction: column; gap: 6px;
      background: #16213e; padding: 10px 12px 12px;
      border-top: 2px solid #0f3460; flex-shrink: 0; z-index: 60;
      font-family: system-ui; -webkit-tap-highlight-color: transparent;
    }
    #chat-bar .chat-input-row {
      display: flex; align-items: stretch; gap: 6px; width: 100%;
    }
    body.mobile #chat-menu-btn2 { display: none !important; }
    #chat-input {
      flex: 1; background: #111827; color: #e0e0e0; border: 1px solid #333;
      border-radius: 8px; padding: 10px 14px; font-size: 15px; font-family: system-ui;
      outline: none; resize: none; min-height: 40px; max-height: 120px;
      line-height: 1.4; overflow-y: auto; scrollbar-width: none;
    }
    #chat-input::-webkit-scrollbar { display: none; }
    #chat-input:focus { border-color: #4ade80; }
    #chat-input::placeholder { color: #555; }
    #chat-send-btn {
      padding: 0 14px; border-radius: 6px; border: none;
      background: #4ade80; color: #000; font-size: 14px; font-weight: 600; cursor: pointer;
      display: flex; align-items: center; justify-content: center; flex-shrink: 0;
      -webkit-tap-highlight-color: transparent;
    }
    #chat-send-btn:active { background: #22c55e; }
    #chat-send-btn:disabled { background: #333; color: #666; cursor: default; }
    #chat-voice-toggle.active { border-color: #4ade80; color: #4ade80; }
    #chat-hold-speak.recording { background: #4ade80; color: #000; border-color: #4ade80; }
    #chat-quick-actions {
      display: none; flex-wrap: wrap; gap: 6px; padding: 0 4px;
    }
    #chat-quick-actions.visible { display: flex; }
    .chat-quick-btn {
      padding: 6px 16px; border-radius: 16px; border: 1px solid #333;
      background: #1e293b; color: #e0e0e0; font-size: 14px; cursor: pointer;
      font-family: system-ui; -webkit-tap-highlight-color: transparent;
    }
    .chat-quick-btn:active { background: #334155; }
    .chat-quick-btn.primary { background: #4ade80; color: #000; border-color: #4ade80; font-weight: 600; }
    .chat-quick-btn.danger { border-color: #f87171; color: #f87171; }
    #menu-chat-toggle { cursor: pointer; }
    body.light-mode #chat-bar { background:rgba(240,240,240,0.95);border-top-color:#ccc; }
    body.light-mode #chat-input { background:#fff; color:#333; border-color:#ccc; }
    body.light-mode #chat-input::placeholder { color:#999; }
    body.light-mode .chat-quick-btn { background:#f0f0f0; color:#333; border-color:#ccc; }
    @supports (padding-top: env(safe-area-inset-top)) {
      #chat-bar { padding-bottom: max(8px, env(safe-area-inset-bottom)); }
    }
    body.mobile #voice-bar { display: flex; padding: 6px 6px; gap: 0; flex-direction: column; }
    body.mobile #bar-row1 { display: flex; align-items: center; gap: 4px; width: 100%; }
    body.mobile #special-keys { display: flex; }
    body.mobile #text { display: none; }
    body.mobile #font-controls { display: none; }
    body.mobile .desktop-paste-btn { display: none; }
    body.mobile .key-btn { min-width: 0; flex: 1; padding: 0 4px; height: 34px; font-size: 14px; }
    .mobile-only { display: none; }
    body.mobile .mobile-only { display: inline-block; }
    body.mobile #menu-btn { display: none; }
    #voice-bar { transition: transform 0.3s ease, max-height 0.3s ease, padding 0.3s ease, border-width 0.3s ease; overflow: hidden; }
    #voice-bar.collapsed { transform: translateX(calc(100% + 2px)); max-height: 0 !important; padding-top: 0 !important; padding-bottom: 0 !important; border-top-width: 0 !important; }
    #chat-bar.collapsed { display: none !important; }
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
      body.mobile #voice-bar { padding-bottom: max(6px, env(safe-area-inset-bottom)); }
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
    <div id="copy-overlay">
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #333;">
        <span style="color:#e0e0e0;font:13px system-ui;" data-i18n="pro.copy.title">Select &amp; Copy</span>
        <div style="display:flex;gap:8px;">
          <button id="copy-all-btn" style="padding:4px 10px;background:#0f3460;color:#e0e0e0;border:none;border-radius:4px;font-size:12px;cursor:pointer;" data-i18n="pro.copy.copy_all">Copy All</button>
          <button id="copy-close-btn" style="padding:4px 10px;background:#333;color:#e0e0e0;border:none;border-radius:4px;font-size:12px;cursor:pointer;" data-i18n="pro.copy.close">Close</button>
        </div>
      </div>
      <pre id="copy-content"></pre>
    </div>
    <div id="voice-bar">
      <div id="bar-row1">
        <button id="menu-btn" class="key-btn" style="min-width:28px;padding:2px 4px;"><svg viewBox="0 0 512 512" fill="none" style="width:24px;height:24px;vertical-align:middle;"><circle cx="185" cy="175" r="42" fill="#4ade80"/><circle cx="327" cy="175" r="42" fill="#4ade80"/><circle cx="185" cy="175" r="16" fill="#1a1a2e"/><circle cx="327" cy="175" r="16" fill="#1a1a2e"/><rect x="150" y="195" width="212" height="80" rx="40" fill="#4ade80"/><path d="M205 218L230 240L205 262" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M242 240L282 240" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round"/><rect x="175" y="290" width="162" height="45" rx="22" fill="#22c55e"/><rect x="165" y="340" width="50" height="20" rx="10" fill="#22c55e"/><rect x="297" y="340" width="50" height="20" rx="10" fill="#22c55e"/></svg></button>
        <div id="special-keys">
          <button id="chat-menu-btn" class="key-btn" style="min-width:28px;padding:2px 4px;"><svg viewBox="0 0 512 512" fill="none" style="width:24px;height:24px;vertical-align:middle;"><circle cx="185" cy="175" r="42" fill="#4ade80"/><circle cx="327" cy="175" r="42" fill="#4ade80"/><circle cx="185" cy="175" r="16" fill="#1a1a2e"/><circle cx="327" cy="175" r="16" fill="#1a1a2e"/><rect x="150" y="195" width="212" height="80" rx="40" fill="#4ade80"/><path d="M205 218L230 240L205 262" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M242 240L282 240" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round"/><rect x="175" y="290" width="162" height="45" rx="22" fill="#22c55e"/><rect x="165" y="340" width="50" height="20" rx="10" fill="#22c55e"/><rect x="297" y="340" width="50" height="20" rx="10" fill="#22c55e"/></svg></button>
          <button class="key-btn" data-key="esc">Esc</button>
          <button class="key-btn" data-key="tab">Tab</button>
          <button class="key-btn" data-key="up">&#x25B2;</button>
          <button class="key-btn" data-key="down">&#x25BC;</button>
          <button class="key-btn" id="return-btn" title="Return" style="font-size:20px;">&#x23CE;</button>
          <button class="key-btn" id="paste-btn" title="Paste" style="font-size:16px;">&#x2398;</button>
          <button class="key-btn" id="copy-btn" title="Select/Copy text">Sel</button>
          <button class="key-btn" id="scroll-bottom" title="Scroll to bottom" style="font-size:20px;">&#x21E9;</button>
        </div>
        <div id="font-controls" style="display:none;">
          <button class="font-btn" onclick="changeFontSize(-2)">&#x2212;</button>
          <span id="font-size">21px</span>
          <button class="font-btn" onclick="changeFontSize(2)">+</button>
        </div>
      </div>
      </div>
    <div id="chat-bar" class="active">
      <div id="status" style="display:none"></div>
      <div id="text" style="display:none"></div>
      <div id="chat-quick-actions"></div>
      <div class="chat-input-row">
        <button id="chat-menu-btn2" class="key-btn" style="min-width:28px;padding:2px 4px;width:34px;height:34px;border-radius:6px;border:1px solid #374151;background:transparent;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg viewBox="0 0 512 512" fill="none" style="width:24px;height:24px;"><circle cx="185" cy="175" r="42" fill="#4ade80"/><circle cx="327" cy="175" r="42" fill="#4ade80"/><circle cx="185" cy="175" r="16" fill="#1a1a2e"/><circle cx="327" cy="175" r="16" fill="#1a1a2e"/><rect x="150" y="195" width="212" height="80" rx="40" fill="#4ade80"/><path d="M205 218L230 240L205 262" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><path d="M242 240L282 240" stroke="#1a1a2e" stroke-width="8" stroke-linecap="round"/><rect x="175" y="290" width="162" height="45" rx="22" fill="#22c55e"/><rect x="165" y="340" width="50" height="20" rx="10" fill="#22c55e"/><rect x="297" y="340" width="50" height="20" rx="10" fill="#22c55e"/></svg></button>
        <button id="chat-voice-toggle" title="Switch voice/keyboard" style="width:34px;height:34px;border-radius:6px;border:1px solid #374151;background:transparent;color:#9ca3af;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg id="cvt-mic-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg><svg id="cvt-kb-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:none"><rect x="2" y="4" width="20" height="16" rx="2"/><line x1="6" y1="8" x2="6" y2="8.01"/><line x1="10" y1="8" x2="10" y2="8.01"/><line x1="14" y1="8" x2="14" y2="8.01"/><line x1="18" y1="8" x2="18" y2="8.01"/><line x1="6" y1="12" x2="6" y2="12.01"/><line x1="10" y1="12" x2="10" y2="12.01"/><line x1="14" y1="12" x2="14" y2="12.01"/><line x1="18" y1="12" x2="18" y2="12.01"/><line x1="8" y1="16" x2="16" y2="16"/></svg></button>
        <label for="chat-input" style="position:absolute;left:-9999px">Chat input</label>
        <textarea id="chat-input" name="chat-input" rows="1" placeholder="Message..." autocomplete="off"></textarea>
        <button id="chat-hold-speak" style="display:none;flex:1;height:34px;border-radius:8px;border:1px solid #374151;background:#1e293b;color:#9ca3af;font-size:14px;font-family:system-ui;cursor:pointer;-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;" data-i18n="pro.chat.hold_to_speak">Hold to speak</button>
        <button id="chat-upload-btn" title="Upload file" style="width:34px;height:34px;border-radius:6px;border:1px solid #374151;background:transparent;color:#9ca3af;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3m0 0l-4 4m4-4l4 4"/><path d="M2 17l.621 2.485A2 2 0 004.561 21h14.878a2 2 0 001.94-1.515L22 17"/></svg></button>
        <input type="file" id="chat-upload-input" multiple style="display:none;">
        <button id="chat-send-btn" disabled data-i18n="pro.chat.btn_send">Send</button>
      </div>
    </div>
  </div>
  <div id="voice-popup" class="hidden">
    <div id="vp-indicator"><span id="vp-dot"></span></div>
    <div id="vp-text"></div>
    <div id="vp-hint">&#x2191; Swipe up to cancel</div>
    <div id="vp-actions">
      <button id="vp-cancel" data-i18n="pro.vp.btn_cancel">Cancel</button>
      <button id="vp-send" data-i18n="pro.vp.btn_send">Send &#x23CE;</button>
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
    <div id="fb-drop-overlay" data-i18n="pro.fb.drop_here">Drop files here</div>
    <div id="fb-header">
      <button id="fb-close">&times;</button>
      <span id="fb-title" data-i18n="pro.fb.title">Files</span>
      <button id="fb-upload-btn" class="key-btn" data-i18n-title="pro.fb.upload" title="Upload files" style="font-size:14px;">&#x2191;</button>
      <input type="file" id="fb-upload-input" multiple style="display:none;">
      <button id="fb-mkdir-btn" class="key-btn" data-i18n-title="pro.fb.mkdir" title="New folder" style="font-size:12px;">+<svg width="12" height="12" viewBox="0 0 24 24" fill="#60a5fa"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg></button>
      <button id="fb-hidden-btn" class="key-btn" data-i18n-title="pro.fb.hidden" title="Toggle hidden files" style="font-size:10px;opacity:0.5">.*</button>
      <button id="fb-cwd-btn" class="key-btn" data-i18n-title="pro.fb.cwd" title="Go to PTY working directory" data-i18n="pro.fb.cwd">CWD</button>
    </div>
    <div id="fb-breadcrumb"></div>
    <div id="fb-pending-drop" style="display:none;padding:8px 12px;background:#1a2a1a;border-bottom:1px solid #0f3460;display:none;flex-direction:column;gap:6px;">
      <div style="color:#e0e0e0;font-size:12px;font-family:system-ui;" id="fb-pending-label">Drop files pending</div>
      <div style="display:flex;gap:6px;">
        <button id="fb-pending-upload" style="flex:1;padding:6px;background:#4ade80;color:#000;border:none;border-radius:4px;font-size:13px;font-weight:bold;cursor:pointer;" data-i18n="pro.fb.upload_here">Upload Here</button>
        <button id="fb-pending-cancel" style="padding:6px 12px;background:#333;color:#e0e0e0;border:none;border-radius:4px;font-size:13px;cursor:pointer;" data-i18n="cancel">Cancel</button>
      </div>
    </div>
    <div id="fb-error"></div>
    <div id="fb-list"></div>
    <div id="fb-text-preview">
      <div id="fb-text-header">
        <button id="fb-text-back" class="key-btn" data-i18n="pro.fb.back">&larr; Back</button>
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
      <div class="app-menu-section collapsible" data-collapse="menu-sessions-body" data-i18n="pro.menu.sessions">&#x1F4CB; Sessions</div>
      <div id="menu-sessions-body" class="app-menu-collapse">
        <div id="menu-sessions" class="menu-sess-list"><div style="padding:8px 16px;color:#888;font-size:13px;" data-i18n="loading">Loading...</div></div>
        <div style="padding:4px 16px 6px;">
          <button class="app-menu-btn" id="menu-new-session" style="width:100%" data-i18n="pro.menu.new_session">+ New Session</button>
        </div>
      </div>
      <div class="app-menu-sep"></div>
      <div class="app-menu-section collapsible" data-collapse="menu-terminal-body" data-i18n="pro.menu.terminal">&#x2699; Terminal</div>
      <div id="menu-terminal-body" class="app-menu-collapse">
        <div class="app-menu-row" style="padding:6px 16px;gap:10px;">
          <button class="app-menu-btn" id="menu-font-down">A&#x2212;</button>
          <span id="menu-font-val" style="font-size:14px;min-width:40px;text-align:center;color:#fff;font-weight:600;"></span>
          <button class="app-menu-btn" id="menu-font-up">A+</button>
          <span style="flex:1;"></span>
          <button class="app-menu-btn" id="theme-toggle">&#x263E;</button>
        </div>
      </div>
      <div class="app-menu-section collapsible" data-collapse="menu-fk-body" data-i18n="pro.menu.floating_keys">&#x2328; Floating Keys</div>
      <div id="menu-fk-body" class="app-menu-collapse">
        <div id="menu-fk-list" style="padding:6px 16px;display:flex;flex-direction:column;gap:4px;"></div>
        <div class="app-menu-row" style="padding:6px 16px;gap:8px;">
          <button class="app-menu-btn" id="menu-fk-add" data-i18n="pro.menu.fk_add">+ Add</button>
          <button class="app-menu-btn" id="menu-fk-hide" data-i18n="pro.menu.fk_hide">Hide</button>
          <button class="app-menu-btn" id="menu-fk-reset" style="background:#333;color:#f87171;" data-i18n="pro.menu.fk_reset">Reset</button>
        </div>
      </div>
      <div class="app-menu-sep"></div>
      <div class="app-menu-item" id="menu-files" data-i18n="pro.menu.files"><svg width="14" height="14" viewBox="0 0 24 24" fill="#60a5fa" style="vertical-align:-2px"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg> Files</div>
      <a class="app-menu-item" href="/terminal" style="text-decoration:none;" data-i18n="pro.menu.home">&#x1F3E0; Home</a>
      <div class="app-menu-item" id="menu-easy-mode" style="color:#60a5fa;" data-i18n="pro.menu.easy_mode">&#x1F438; Easy Mode</div>
      <div class="app-menu-sep"></div>
      <div class="app-menu-item" id="menu-lang-toggle" style="display:flex;align-items:center;justify-content:space-between;cursor:pointer;">
        <span data-i18n="pro.menu.lang">Language</span>
        <span style="font-size:13px;color:#60a5fa;" id="menu-lang-val">EN/中</span>
      </div>
      <div style="padding:8px 16px;display:flex;align-items:center;justify-content:flex-end;">
        <span id="menu-devtools-link" style="font-size:11px;color:#555;cursor:pointer;">DevTools</span>
      </div>
      <div id="menu-devtools-panel" style="display:none;padding:6px 16px 10px;">
        <div style="display:flex;align-items:center;gap:10px;">
          <span style="font-size:12px;color:#888;flex:1;">Input Log</span>
          <button id="menu-dbg-view" class="app-menu-btn" style="font-size:11px;padding:4px 10px;display:none;">View</button>
          <div id="menu-dbg-toggle" style="width:36px;height:20px;border-radius:10px;background:#333;position:relative;cursor:pointer;transition:background 0.2s;flex-shrink:0;">
            <div id="menu-dbg-knob" style="width:16px;height:16px;border-radius:8px;background:#888;position:absolute;top:2px;left:2px;transition:left 0.2s,background 0.2s;"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script src="./vendor/xterm.js"></script>
  <script src="./vendor/xterm-addon-fit.js"></script>
  <script src="./vendor/xterm-addon-webgl.js"></script>
  <script>
    window.onerror = function(msg, src, line, col) {
      var errText = 'JS L' + line + ':' + col + ' ' + msg;
      var el = document.getElementById('chat-hold-speak');
      if (el) { el.style.display = ''; el.textContent = errText; el.style.background = '#f87171'; el.style.color = '#fff'; el.style.fontSize = '10px'; el.style.height = 'auto'; }
      var inp = document.getElementById('chat-input');
      if (inp) inp.placeholder = errText;
    };

    const isMobile = ('ontouchstart' in window || navigator.maxTouchPoints > 0) && window.innerWidth < 768;
    if (isMobile) document.body.classList.add('mobile');
    var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
    var holdKeyName = isMac ? 'Option' : 'Alt';
    var _statusEl = document.getElementById('status');
    var _chatInput = document.getElementById('chat-input');
    var _holdSpeak = document.getElementById('chat-hold-speak');
    var defaultStatusText = _t('pro.status.hold_to_speak', {key: holdKeyName});
    var _defaultPlaceholder = isMobile ? _t('pro.chat.placeholder_mobile') : _t('pro.chat.placeholder', {key: holdKeyName, paste: isMac ? 'Cmd' : 'Ctrl'});
    var _currentStatus = '';
    function setStatus(text, bg) {
      _currentStatus = text || '';
      if (_statusEl) { _statusEl.textContent = text; _statusEl.style.background = bg || ''; }
      // Show status in placeholder when it's not the default
      var isDefault = !text || text === defaultStatusText;
      if (_chatInput) {
        _chatInput.placeholder = isDefault ? _defaultPlaceholder : text;
      }
      if (_holdSpeak && !isDefault) {
        _holdSpeak.textContent = text;
      }
    }
    setStatus(defaultStatusText);
    var savedFontSize = parseInt(localStorage.getItem('hopcode-font-size'));
    let fontSize = savedFontSize > 0 ? savedFontSize : (isMobile ? 14 : 21);
    const term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      fontSize: fontSize,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      scrollback: 1000,
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#4ade80' }
    });
    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    var termEl = document.getElementById('terminal');
    term.open(termEl);
    var hasWebGL = false;
    // WebGL disabled: may cause full-screen flicker on some systems
    // try { term.loadAddon(new WebglAddon.WebglAddon()); hasWebGL = true; } catch(e) {
    //   console.warn('WebGL addon failed, using DOM renderer:', e);
    //   term.options.scrollback = 500;
    // }
    fitAddon.fit();

    // Auto-copy selection to clipboard (desktop: mouse select → auto-copy)
    term.onSelectionChange(function() {
      var sel = term.getSelection();
      if (sel && navigator.clipboard) {
        navigator.clipboard.writeText(sel).catch(function() {});
      }
    });

    // --- Performance self-check: monitor write latency, auto-trim if degraded ---
    function perfWrite(data, cb) {
      term.write(data, cb);
      // Chat mode: detect permission prompts
      if (typeof chatDetectPrompts === 'function') {
        try { chatDetectPrompts(data); } catch(e) {}
      }
    }
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
      var touchTotalDelta = 0;
      var touchIsTap = true;
      xtermScreen.addEventListener('touchstart', function(e) {
        cancelAnimationFrame(momentumId);
        touchLastY = e.touches[0].clientY;
        touchVelocity = 0;
        touchTotalDelta = 0;
        touchIsTap = true;
        cachedCellHeight = xtermScreen.offsetHeight / term.rows;
      }, { passive: true });
      xtermScreen.addEventListener('touchmove', function(e) {
        e.preventDefault();
        touchIsTap = false;
        var y = e.touches[0].clientY;
        var delta = touchLastY - y;
        touchVelocity = delta;
        touchTotalDelta += delta;
        var lines = Math.round(delta / getCellHeight());
        if (lines !== 0) {
          term.scrollLines(lines);
          touchLastY = y;
          // Only blur (hide keyboard) on significant upward scroll (3+ lines total)
          if (touchTotalDelta < -getCellHeight() * 3 && xtermTextarea) xtermTextarea.blur();
        }
      }, { passive: false });
      xtermScreen.addEventListener('touchend', function() {
        if (touchIsTap) {
          // Tap on terminal = refocus (re-show keyboard)
          term.focus();
          return;
        }
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
    // autoScroll is only used by resize handler; writes use snapshot-based logic
    var autoScroll = true;
    term.onScroll(function() {
      var buf = term.buffer.active;
      autoScroll = buf.viewportY >= buf.baseY;
    });

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
    var outputRefocusTimer = null;
    var reconnectDelay = 2000;
    function connectTerminal() {
      setStatus(isReconnect ? _t('pro.status.reconnecting') : _t('pro.status.connecting'));
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
          // Snapshot viewport position before write to prevent animation-triggered scroll
          var buf = term.buffer.active;
          var wasAtBottom = buf.viewportY >= buf.baseY;
          var savedViewportY = buf.viewportY;
          perfWrite(msg.data, function() {
            if (wasAtBottom) {
              term.scrollToBottom();
            } else {
              var newBuf = term.buffer.active;
              var delta = newBuf.baseY - buf.baseY;
              term.scrollToLine(savedViewportY + delta);
            }
          });
          // Re-focus terminal after output settles (mobile loses focus during heavy output)
          clearTimeout(outputRefocusTimer);
          outputRefocusTimer = setTimeout(function() {
            if (document.activeElement !== xtermTextarea && !isMobile) {
              term.focus();
            }
          }, 300);
        }
      };
      termWs.onopen = () => {
        setStatus(defaultStatusText);
        reconnectDelay = 2000; // reset backoff on successful connection
        lastCols = 0; lastRows = 0; sendResize();
      };
      termWs.onerror = () => {
        setStatus(_t('pro.status.ws_error'), '#f87171');
      };
      termWs.onclose = (e) => {
        if (termWs.sessionExited) return;
        setStatus(_t('pro.status.reconnecting'), '#6b7280');
        isReconnect = true;
        setTimeout(connectTerminal, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 1.5, 30000); // backoff up to 30s
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

    // Mobile autocomplete fix — capture-phase input interception.
    // When Gboard/iOS autocomplete replaces text in xterm's textarea, we
    // intercept the input event BEFORE xterm reads it (capture phase on
    // parent element runs before target-phase on textarea). We compute
    // the diff, send the correction ourselves, then clear textarea so
    // xterm sees no change and fires no onData. No residuals, no blocking.
    var isComposing = false;
    var compositionJustEnded = false;
    var sentLine = '';
    var DEL = String.fromCharCode(127);
    var acHandled = false; // flag: we handled this input event, skip onData

    // Debug log system (DevTools)
    var dbgLines = [];
    var dbgEnabled = false;

    // Log overlay (shown when Log floating button is tapped)
    var dbgEl = document.createElement('div');
    dbgEl.id = 'ac-debug';
    dbgEl.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:600;background:rgba(0,0,0,0.95);display:none;flex-direction:column;';
    dbgEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;border-bottom:1px solid #333;">'
      + '<span style="color:#0f0;font:12px monospace;">Input Debug Log</span>'
      + '<div style="display:flex;gap:8px;">'
      + '<button id="dbg-copy" style="padding:4px 10px;background:#0f3460;color:#e0e0e0;border:none;border-radius:4px;font-size:12px;cursor:pointer;">Copy</button>'
      + '<button id="dbg-clear" style="padding:4px 10px;background:#333;color:#e0e0e0;border:none;border-radius:4px;font-size:12px;cursor:pointer;">Clear</button>'
      + '<button id="dbg-close" style="padding:4px 10px;background:#333;color:#e0e0e0;border:none;border-radius:4px;font-size:12px;cursor:pointer;">Close</button>'
      + '</div></div>'
      + '<pre id="dbg-content" style="flex:1;overflow:auto;margin:0;padding:8px;color:#0f0;font:10px monospace;white-space:pre-wrap;"></pre>';
    document.body.appendChild(dbgEl);

    var dbgContent = document.getElementById('dbg-content');

    function dbg(msg) {
      if (!dbgEnabled) return;
      dbgLines.push(Date.now() % 100000 + ' ' + msg);
      if (dbgLines.length > 200) dbgLines.shift();
    }

    function dbgShowOverlay() {
      dbgContent.textContent = dbgLines.join('\\n');
      dbgEl.style.display = 'flex';
      dbgContent.scrollTop = dbgContent.scrollHeight;
    }

    document.getElementById('dbg-close').addEventListener('click', function() {
      dbgEl.style.display = 'none';
      term.focus();
    });
    document.getElementById('dbg-clear').addEventListener('click', function() {
      dbgLines = [];
      dbgContent.textContent = '';
    });
    document.getElementById('dbg-copy').addEventListener('click', function() {
      var text = dbgLines.join('\\n');
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
          document.getElementById('dbg-copy').textContent = _t('copied');
          setTimeout(function() { document.getElementById('dbg-copy').textContent = 'Copy'; }, 1500);
        });
      }
    });

    // DevTools section in menu
    document.getElementById('menu-devtools-link').addEventListener('click', function() {
      var panel = document.getElementById('menu-devtools-panel');
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    var dbgToggleEl = document.getElementById('menu-dbg-toggle');
    var dbgKnobEl = document.getElementById('menu-dbg-knob');
    var dbgViewBtn = document.getElementById('menu-dbg-view');

    function dbgSetEnabled(on) {
      dbgEnabled = on;
      dbgToggleEl.style.background = on ? '#4ade80' : '#333';
      dbgKnobEl.style.left = on ? '18px' : '2px';
      dbgKnobEl.style.background = on ? '#fff' : '#888';
      dbgViewBtn.style.display = on ? 'inline-block' : 'none';
    }

    dbgToggleEl.addEventListener('click', function() { dbgSetEnabled(!dbgEnabled); });
    dbgViewBtn.addEventListener('click', function() { dbgShowOverlay(); });

    function commonPrefixLen(a, b) {
      var len = Math.min(a.length, b.length);
      for (var i = 0; i < len; i++) { if (a[i] !== b[i]) return i; }
      return len;
    }

    // Read current line text before cursor from xterm buffer (ground truth)
    function getBufferLine() {
      try {
        var buf = term.buffer.active;
        var line = buf.getLine(buf.cursorY);
        if (!line) return '';
        return line.translateToString(true, 0, buf.cursorX);
      } catch(e) { return ''; }
    }

    // Extract last word from a string (handles trailing spaces)
    function extractLastWord(str) {
      var trimmed = str.replace(/ +$/, '');
      var spIdx = trimmed.lastIndexOf(' ');
      return spIdx >= 0 ? trimmed.slice(spIdx + 1) : trimmed;
    }

    var prevTaVal = ''; // track previous textarea value to detect incremental vs autocomplete

    // Suppress helper: clear textarea, set acHandled, stop propagation
    function acSuppress(e) {
      xtermTextarea.value = '';
      prevTaVal = '';
      acHandled = true;
      setTimeout(function() { acHandled = false; }, 50);
      e.stopImmediatePropagation();
    }

    var xtermTextarea = document.querySelector('.xterm-helper-textarea');
    if (xtermTextarea) {
      xtermTextarea.setAttribute('autocomplete', 'off');
      xtermTextarea.setAttribute('autocorrect', 'off');
      xtermTextarea.setAttribute('autocapitalize', 'off');
      xtermTextarea.setAttribute('spellcheck', 'false');

      if (isMobile) {
        xtermTextarea.addEventListener('focus', function() {
          // Sync prevTaVal with actual textarea state on focus.
          // xterm may have modified textarea.value during output while we weren't tracking.
          prevTaVal = xtermTextarea.value;
          resetPageScroll();
          setTimeout(resetPageScroll, 50);
          setTimeout(resetPageScroll, 150);
        });
      }

      var lastCompositionData = '';

      xtermTextarea.addEventListener('compositionstart', function() {
        isComposing = true;
        // Sync prevTaVal before composition — xterm may have changed textarea
        // value (e.g. for IME context) without our input handler running.
        prevTaVal = xtermTextarea.value;
        dbg('COMP_START prevTaVal="' + prevTaVal + '"');
      });
      xtermTextarea.addEventListener('compositionend', function(e) {
        isComposing = false;
        compositionJustEnded = true;
        lastCompositionData = e.data || '';
        dbg('COMP_END data="' + (e.data||'') + '" sentLine="' + sentLine + '"');
        if (e.data) {
          sendInput(e.data);
          sentLine += e.data;
        }
        dbg('  -> sentLine="' + sentLine + '"');
        setTimeout(function() { compositionJustEnded = false; }, 200);
      });

      // Capture-phase input handler on the xterm CONTAINER (parent of textarea).
      // Capture on parent runs BEFORE target-phase handlers on the textarea,
      // so we get to inspect and modify textarea.value before xterm reads it.
      if (isMobile) {
        var xtermContainer = xtermTextarea.closest('.xterm');
        if (xtermContainer) {
          xtermContainer.addEventListener('input', function(e) {
            var newVal = xtermTextarea.value;
            dbg('INPUT val="' + newVal + '" prev="' + prevTaVal + '" compJE=' + compositionJustEnded + ' sent="' + sentLine + '"');

            if (isComposing) { dbg('  -> skip(composing)'); return; }
            if (e.target !== xtermTextarea) return;

            // During compositionJustEnded window: Gboard may echo the composed
            // word in textarea. Suppress to prevent xterm double-send.
            // Forward extra content (trailing space) or handle autocorrect.
            if (compositionJustEnded) {
              if (newVal.length > 1) {
                var composed = lastCompositionData;
                dbg('  -> compJE: composed="' + composed + '" newVal="' + newVal + '"');
                if (composed && newVal.indexOf(composed) === 0) {
                  var extra = newVal.slice(composed.length);
                  if (extra) { sendInput(extra); sentLine += extra; }
                } else if (composed && newVal.replace(/ +$/, '') !== composed) {
                  var bs = '';
                  for (var i = 0; i < composed.length; i++) bs += DEL;
                  sendInput(bs + newVal);
                  sentLine = sentLine.slice(0, sentLine.length - composed.length) + newVal;
                }
                acSuppress(e);
              } else {
                prevTaVal = newVal;
              }
              return;
            }

            // Single char or empty — normal typing, let xterm handle
            if (newVal.length <= 1) {
              prevTaVal = newVal;
              return;
            }

            // Incremental typing: Gboard appends 1 char to previous textarea value.
            // This is normal keystroke, NOT autocomplete. Let xterm handle.
            if (newVal.length === prevTaVal.length + 1 &&
                newVal.slice(0, prevTaVal.length) === prevTaVal) {
              dbg('  -> incremental +1, let xterm');
              prevTaVal = newVal;
              return;
            }

            // Incremental deletion (single backspace): let xterm handle
            // Only allow exactly 1 char deletion. Multi-char deletion is
            // autocorrect step 1 (e.g. "baad"->"ba") and must go through
            // non-incremental handler so the follow-up replace works correctly.
            if (newVal.length === prevTaVal.length - 1 &&
                prevTaVal.slice(0, newVal.length) === newVal) {
              dbg('  -> incremental del -1, let xterm');
              prevTaVal = newVal;
              return;
            }

            dbg('  -> NON-INCR prev="' + prevTaVal + '" new="' + newVal + '"');

            // Non-incremental change — autocomplete, autocorrect, or echo.
            // Use prevTaVal (actual previous textarea value) for diffing, not sentLine.
            // After acSuppress clears textarea, Gboard rebuilds shorter context that
            // diverges from sentLine, making sentLine-based diffs fail.

            // Echo detection: newVal is a suffix of sentLine (Gboard echoing confirmed word)
            var newTrimmed = newVal.replace(/ +$/, '');
            var sentTrimmed = sentLine.replace(/ +$/, '');
            if (newTrimmed.length > 0 && sentTrimmed.length >= newTrimmed.length &&
                sentTrimmed.slice(-newTrimmed.length) === newTrimmed) {
              var matchPos = sentTrimmed.length - newTrimmed.length;
              if (matchPos === 0 || sentTrimmed[matchPos - 1] === ' ') {
                dbg('  -> echo detected');
                var trailingNew = newVal.slice(newTrimmed.length);
                var trailingSent = sentLine.slice(sentTrimmed.length);
                if (trailingNew.length > trailingSent.length) {
                  var extra = trailingNew.slice(trailingSent.length);
                  sendInput(extra);
                  sentLine += extra;
                }
                acSuppress(e);
                return;
              }
            }

            // prevTaVal-based diff: always accurate since prevTaVal tracks actual textarea
            var pvCpLen = commonPrefixLen(prevTaVal, newVal);
            var pvToDelete = prevTaVal.length - pvCpLen;
            var pvToInsert = newVal.slice(pvCpLen);
            if (pvToDelete > 0 || pvToInsert.length > 0) {
              var bs = '';
              for (var i = 0; i < pvToDelete; i++) bs += DEL;
              dbg('  -> pv-diff del=' + pvToDelete + ' ins="' + pvToInsert + '"');
              sendInput(bs + pvToInsert);
              sentLine = sentLine.slice(0, Math.max(0, sentLine.length - pvToDelete)) + pvToInsert;
              acSuppress(e);
              return;
            }

            dbg('  -> fallthrough, let xterm');
            prevTaVal = newVal;
            // No match — could be paste or first input. Let xterm handle.
          }, true); // capture phase
        }
      }
    }

    term.onData(function(data) {
      var repr = data.length === 1 && data.charCodeAt(0) < 32 ? 'ctrl-' + data.charCodeAt(0) : data.length === 1 && data.charCodeAt(0) === 127 ? 'DEL' : data;
      dbg('ONDATA "' + repr + '" compJE=' + compositionJustEnded + ' composing=' + isComposing + ' acH=' + acHandled);
      if (compositionJustEnded) { dbg('  -> skip(compJE)'); return; }
      if (isComposing) { dbg('  -> skip(composing)'); return; }
      if (acHandled) { dbg('  -> skip(acHandled)'); return; }

      // Track sentLine for all printable data
      if (data.length === 1 && data.charCodeAt(0) >= 32 && data.charCodeAt(0) !== 127) {
        sentLine += data;
      } else if (data.length > 1) {
        // Multi-char data (e.g. paste) — track it too
        var allPrintable = true;
        for (var i = 0; i < data.length; i++) {
          var c = data.charCodeAt(i);
          if (c < 32 || c === 127) { allPrintable = false; break; }
        }
        if (allPrintable) sentLine += data;
        else sentLine = '';
      } else if (data.length === 1 && data.charCodeAt(0) === 127) {
        if (sentLine.length > 0) sentLine = sentLine.slice(0, -1);
      } else if (data.length === 1 && data.charCodeAt(0) < 32) {
        sentLine = '';
      }
      // Cap sentLine to prevent stale echo detection against old input
      if (sentLine.length > 200) sentLine = sentLine.slice(-100);

      sendInput(data);
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
    function resetPageScroll() {
      if (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop) {
        window.scrollTo(0, 0);
        document.documentElement.scrollTop = 0;
        document.body.scrollTop = 0;
      }
    }
    function setVh() {
      var h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
      if (lastVh && Math.abs(h - lastVh) < 50) return;
      lastVh = h;
      containerEl.style.height = h + 'px';
      resetPageScroll();
    }
    function setVhThrottled() {
      if (_vhRafPending) return;
      _vhRafPending = true;
      requestAnimationFrame(function() { _vhRafPending = false; setVh(); });
    }
    if (isMobile) {
      setVh();
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', setVhThrottled);
        // iOS scrolls the page when keyboard opens to keep focused element visible;
        // fight back by resetting scroll on every viewport scroll event
        window.visualViewport.addEventListener('scroll', function() {
          resetPageScroll();
        });
      }
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
        if (autoScroll) scrollToCursor();
      }, 300);
    });

    // Special key buttons for mobile
    var keyMap = { esc: String.fromCharCode(27), tab: String.fromCharCode(9), up: String.fromCharCode(27) + '[A', down: String.fromCharCode(27) + '[B' };
    document.querySelectorAll('.key-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.preventDefault();
        var seq = keyMap[btn.getAttribute('data-key')];
        if (seq) sendInput(seq);
        if (isMobile && xtermTextarea) xtermTextarea.blur();
        else term.focus();
      });
    });


    // Paste button — popup textarea for manual paste
    var pasteOverlay = document.createElement('div');
    pasteOverlay.id = 'paste-overlay';
    pasteOverlay.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;background:rgba(0,0,0,0.3);flex-direction:column;align-items:center;justify-content:center;padding:20px;';
    pasteOverlay.innerHTML = '<div style="width:100%;max-width:480px;background:#ffffff;border:1px solid #d2d2d7;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);">'
      + '<div style="color:#1d1d1f;font-size:14px;font-family:system-ui;" data-i18n="pro.paste.title">Paste content here:</div>'
      + '<textarea id="paste-input" style="width:100%;height:120px;background:#f5f5f7;color:#1d1d1f;border:1px solid #d2d2d7;border-radius:8px;padding:10px;font-family:monospace;font-size:14px;resize:vertical;outline:none;" data-i18n-placeholder="pro.paste.placeholder" placeholder="Long press or Ctrl+V to paste..."></textarea>'
      + '<div id="paste-file-preview" style="display:none;text-align:center;"><img id="paste-file-thumb" style="max-width:100%;max-height:120px;border-radius:6px;border:1px solid #d2d2d7;"><div id="paste-file-icon" style="display:none;font-size:40px;padding:10px;">&#x1F4CE;</div><div id="paste-file-name" style="font-size:12px;color:#86868b;margin-top:4px;"></div></div>'
      + '<div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;">'
      + '<button id="paste-file-btn" style="padding:8px 12px;background:#f0f0f2;color:#1d1d1f;border:1px solid #d2d2d7;border-radius:6px;font-size:13px;cursor:pointer;margin-right:auto;" data-i18n="pro.paste.btn_file">&#x1F4CE; File</button>'
      + '<input type="file" id="paste-file-input" style="display:none;">'
      + '<button id="paste-cancel" style="padding:8px 16px;background:#e5e5ea;color:#1d1d1f;border:none;border-radius:6px;font-size:14px;cursor:pointer;" data-i18n="cancel">Cancel</button>'
      + '<button id="paste-send" style="padding:8px 16px;background:#007aff;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:bold;cursor:pointer;" data-i18n="send">Send</button>'
      + '</div></div>';
    document.body.appendChild(pasteOverlay);
    _applyI18n(); // Apply i18n to dynamically created elements
    // Prevent xterm from stealing focus when interacting with paste overlay
    pasteOverlay.addEventListener('mousedown', function(e) { e.stopPropagation(); });
    pasteOverlay.addEventListener('touchstart', function(e) { e.stopPropagation(); });
    // Prevent xterm from stealing keystrokes while paste overlay is open
    pasteOverlay.addEventListener('keydown', function(e) { e.stopPropagation(); });
    pasteOverlay.addEventListener('keyup', function(e) { e.stopPropagation(); });
    pasteOverlay.addEventListener('keypress', function(e) { e.stopPropagation(); });

    // Upload chooser popup — shown when files are dropped outside file browser
    var uploadChooser = document.createElement('div');
    uploadChooser.id = 'upload-chooser';
    uploadChooser.style.cssText = 'display:none;position:fixed;top:0;left:0;right:0;bottom:0;z-index:500;background:rgba(0,0,0,0.3);flex-direction:column;align-items:center;justify-content:center;padding:20px;';
    uploadChooser.innerHTML = '<div style="width:100%;max-width:400px;background:#ffffff;border:1px solid #d2d2d7;border-radius:14px;padding:16px;display:flex;flex-direction:column;gap:12px;box-shadow:0 10px 40px rgba(0,0,0,0.15);">'
      + '<div style="color:#1d1d1f;font-size:14px;font-family:system-ui;font-weight:bold;" data-i18n="pro.upload.where">Where do you want to drop the file(s)?</div>'
      + '<div id="uc-file-list" style="color:#86868b;font-size:12px;font-family:monospace;max-height:80px;overflow-y:auto;padding:8px;background:#f5f5f7;border-radius:6px;border:1px solid #d2d2d7;"></div>'
      + '<div style="display:flex;flex-direction:column;gap:8px;">'
      + '<button id="uc-terminal" style="padding:10px 16px;background:#f0f0f2;color:#1d1d1f;border:1px solid #d2d2d7;border-radius:6px;font-size:14px;cursor:pointer;text-align:left;" data-i18n="pro.upload.to_terminal">&#x1F4CB; Paste to Terminal<span style="display:block;font-size:11px;color:#86868b;margin-top:2px;" data-i18n="pro.upload.to_terminal_sub">Upload to ~/.hopcode/uploads/, paste path into terminal</span></button>'
      + '<button id="uc-files" style="padding:10px 16px;background:#f0f0f2;color:#1d1d1f;border:1px solid #d2d2d7;border-radius:6px;font-size:14px;cursor:pointer;text-align:left;" data-i18n="pro.upload.to_files"><svg width="14" height="14" viewBox="0 0 24 24" fill="#60a5fa" style="vertical-align:-2px"><path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg> Save to Files<span style="display:block;font-size:11px;color:#86868b;margin-top:2px;" data-i18n="pro.upload.to_files_sub">Browse and choose a folder in the file browser</span></button>'
      + '</div>'
      + '<div style="display:flex;justify-content:flex-end;">'
      + '<button id="uc-cancel" style="padding:8px 16px;background:#e5e5ea;color:#1d1d1f;border:none;border-radius:6px;font-size:14px;cursor:pointer;" data-i18n="cancel">Cancel</button>'
      + '</div></div>';
    document.body.appendChild(uploadChooser);
    _applyI18n(); // Apply i18n to dynamically created elements

    var ucPendingFiles = null;
    var ucPendingEntries = null;

    function uploadChooserShow(files, entries) {
      ucPendingFiles = files;
      ucPendingEntries = entries;
      var listEl = document.getElementById('uc-file-list');
      var names = [];
      if (files && files.length > 0) {
        for (var i = 0; i < files.length; i++) names.push(files[i].name);
      } else if (entries) {
        for (var i = 0; i < entries.length; i++) names.push(entries[i].name + (entries[i].isDirectory ? '/' : ''));
      }
      listEl.textContent = names.join('\\n');
      uploadChooser.style.display = 'flex';
    }

    function uploadChooserHide() {
      uploadChooser.style.display = 'none';
      ucPendingFiles = null;
      ucPendingEntries = null;
      term.focus();
    }

    function isJunkFile(name) {
      return name === '.DS_Store' || name === 'Thumbs.db' || name === 'desktop.ini' || name === '._.DS_Store' || name.charAt(0) === '.' && name.indexOf('.swp') !== -1;
    }

    document.getElementById('uc-terminal').addEventListener('click', function() {
      var files = ucPendingFiles;
      var entries = ucPendingEntries;
      uploadChooserHide();
      if (entries && entries.length > 0) {
        // Collect actual files from entries (handles folders)
        fbCollectEntries(entries, function(collected) {
          for (var i = 0; i < collected.length; i++) {
            if (collected[i].file && !isJunkFile(collected[i].file.name)) pasteUploadFile(collected[i].file);
          }
        });
      } else if (files) {
        for (var i = 0; i < files.length; i++) {
          if (!isJunkFile(files[i].name)) pasteUploadFile(files[i]);
        }
      }
    });

    // Pending drop-upload state for file browser
    var fbPendingDropFiles = null;
    var fbPendingDropEntries = null;

    document.getElementById('uc-files').addEventListener('click', function() {
      fbPendingDropFiles = ucPendingFiles;
      fbPendingDropEntries = ucPendingEntries;
      uploadChooserHide();
      if (!fbPanel.classList.contains('open')) fbOpen();
      fbShowPendingBanner();
    });

    document.getElementById('uc-cancel').addEventListener('click', uploadChooserHide);
    uploadChooser.addEventListener('click', function(e) {
      if (e.target === uploadChooser) uploadChooserHide();
    });

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
      // Disable xterm textarea to prevent it stealing keystrokes
      if (xtermTextarea) { xtermTextarea.disabled = true; xtermTextarea.blur(); }
      setTimeout(function() { inp.focus(); }, 50);
    }
    function pasteHide() {
      pasteOverlay.style.display = 'none';
      pasteReset();
      if (xtermTextarea) xtermTextarea.disabled = false;
      term.focus();
    }
    function pasteUploadFile(file, extraText) {
      pasteHide();
      var prevStatus = _statusEl ? _statusEl.textContent : '';
      setStatus(_t('pro.status.uploading'), '#60a5fa');
      fetch('/terminal/upload', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
        body: file
      }).then(function(r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }).then(function(data) {
        if (data.error) throw new Error(data.error);
        // Combine text + file path if both present
        var combined = '';
        if (extraText && data.path) {
          combined = extraText + ' ' + data.path + ' ';
        } else if (data.path) {
          combined = data.path + ' ';
        }
        if (combined) sendInput(combined);
        setStatus(_t('pro.status.uploaded'), '#4ade80');
        setTimeout(function() { setStatus(prevStatus); }, 2000);
      }).catch(function(err) {
        setStatus(_t('pro.status.upload_failed') + ': ' + err.message, '#f87171');
        setTimeout(function() { setStatus(prevStatus); }, 5000);
      });
    }
    document.getElementById('paste-btn').addEventListener('click', function(e) {
      e.preventDefault();
      e.stopPropagation();
      pasteShow();
    });
    var pasteBtnDesktop = document.getElementById('paste-btn-desktop');
    if (pasteBtnDesktop) {
      pasteBtnDesktop.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        pasteShow();
      });
    }
    document.getElementById('paste-send').addEventListener('click', function() {
      var text = document.getElementById('paste-input').value;
      if (pasteFile) {
        // Upload file, passing text along to combine after upload
        pasteUploadFile(pasteFile, text || '');
      } else {
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
    function menuSessRename(sid, item) {
      var nameEl = item.querySelector('.menu-sess-name');
      var oldName = nameEl.textContent;
      var input = document.createElement('input');
      input.className = 'menu-sess-rename-input';
      input.value = oldName;
      nameEl.style.display = 'none';
      item.querySelector('.menu-sess-actions').style.display = 'none';
      nameEl.parentNode.insertBefore(input, nameEl.nextSibling);
      input.focus();
      input.select();
      function save() {
        var val = input.value.trim();
        if (input._done) return; input._done = true;
        input.remove();
        nameEl.style.display = '';
        if (val && val !== oldName) {
          nameEl.textContent = val;
          var safeVal = val.replace(/[^a-zA-Z0-9_\\-\\u4e00-\\u9fff]/g, '-');
          fetch('/terminal/rename', {
            method: 'POST', credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: sid, name: val, oldName: oldName })
          });
          // Update local project list if this is current session
          if (sid === sessionId) {
            var idx = projects.indexOf(oldName);
            if (idx >= 0) projects[idx] = safeVal;
            else projects.push(safeVal);
            localStorage.setItem('easy_projects_' + username, JSON.stringify(projects));
            activeProject = safeVal;
            localStorage.setItem('easy_active_project_' + username, safeVal);
            filePath = homeDir + '/coding/' + safeVal;
            renderProjects();
          }
        }
      }
      input.addEventListener('keydown', function(e) {
        e.stopPropagation();
        if (e.key === 'Enter') save();
        if (e.key === 'Escape') { input._done = true; input.remove(); nameEl.style.display = ''; }
      });
      input.addEventListener('blur', save);
    }
    function menuSessKill(sid, item) {
      if (!confirm(_t('pro.menu.confirm_delete'))) return;
      item.style.opacity = '0.4';
      fetch('/terminal/sessions/' + encodeURIComponent(sid), {
        method: 'DELETE', credentials: 'include'
      }).then(function(r) {
        if (r.ok) {
          item.remove();
          if (sid === sessionId) location.href = '/terminal';
        } else { item.style.opacity = ''; }
      }).catch(function() { item.style.opacity = ''; });
    }
    function menuLoadSessions() {
      var container = document.getElementById('menu-sessions');
      fetch('/terminal/api/sessions', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
          var currentUser = data.currentUser;
          initChatModeForUser(currentUser);
          var sessions = data.sessions;
          if (!sessions.length) {
            container.innerHTML = '<div style="padding:8px 16px;color:#888;font-size:13px;">' + _t('pro.menu.no_sessions') + '</div>';
            return;
          }
          container.innerHTML = '';
          sessions.forEach(function(s) {
            var a = document.createElement('a');
            a.className = 'menu-sess-item' + (s.id === sessionId ? ' current' : '');
            a.href = s.mode === 'easy'
              ? '/terminal/easy?session=' + encodeURIComponent(s.id) + (s.project ? '&project=' + encodeURIComponent(s.project) : '')
              : '/terminal?session=' + encodeURIComponent(s.id);
            var dot = document.createElement('span');
            dot.className = 'menu-sess-dot ' + (s.mode === 'easy' ? 'easy' : (s.clientCount > 0 || s.clients > 0 ? 'active' : 'idle'));
            var name = document.createElement('span');
            name.className = 'menu-sess-name';
            name.textContent = s.name || s.id;
            a.appendChild(dot);
            a.appendChild(name);
            if (data.isAdmin && s.owner && s.owner !== currentUser) {
              var ownerTag = document.createElement('span');
              ownerTag.className = 'menu-sess-owner';
              ownerTag.textContent = s.owner;
              a.appendChild(ownerTag);
            }
            var actions = document.createElement('span');
            actions.className = 'menu-sess-actions';
            var renameBtn = document.createElement('button');
            renameBtn.className = 'menu-sess-act';
            renameBtn.textContent = '✎';
            renameBtn.title = 'Rename';
            renameBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); menuSessRename(s.id, a); });
            var killBtn = document.createElement('button');
            killBtn.className = 'menu-sess-act kill';
            killBtn.textContent = '✕';
            killBtn.title = 'Delete';
            killBtn.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); menuSessKill(s.id, a); });
            actions.appendChild(renameBtn);
            actions.appendChild(killBtn);
            a.appendChild(actions);
            container.appendChild(a);
          });
        })
        .catch(function() {
          container.innerHTML = '<div style="padding:8px 16px;color:#f87171;font-size:13px;">Failed to load</div>';
        });
    }
    document.getElementById('menu-new-session').addEventListener('click', function(e) {
      e.stopPropagation();
      var btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = _t('creating');
      fetch('/terminal/api/sessions', { method: 'POST', credentials: 'include' })
        .then(function(r) {
          return r.json().then(function(data) { return { status: r.status, data: data }; });
        })
        .then(function(res) {
          if (res.data.id) {
            location.href = '/terminal?session=' + encodeURIComponent(res.data.id);
          } else {
            btn.disabled = false; btn.textContent = _t('pro.menu.new_session');
            if (res.status === 403 && res.data.error) alert(res.data.error);
          }
        })
        .catch(function() { btn.disabled = false; btn.textContent = _t('pro.menu.new_session'); });
    });
    function menuShow() {
      appMenu.style.display = 'block';
      document.getElementById('menu-font-val').textContent = fontSize + 'px';
      menuRenderFk();
      menuLoadSessions();
    }
    function menuHide() { appMenu.style.display = 'none'; if (!isMobile) term.focus(); }
    document.getElementById('menu-btn').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); menuShow(); });
    document.getElementById('chat-menu-btn').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); chatInput.blur(); menuShow(); });
    if (document.getElementById('chat-menu-btn2')) document.getElementById('chat-menu-btn2').addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); chatInput.blur(); menuShow(); });
    appMenu.querySelector('.app-menu-backdrop').addEventListener('click', menuHide);
    appMenu.querySelector('.app-menu-panel').addEventListener('click', function(e) {
      var sec = e.target.closest('.app-menu-section.collapsible');
      if (!sec) return;
      e.stopPropagation();
      var target = document.getElementById(sec.getAttribute('data-collapse'));
      if (target) { sec.classList.toggle('open'); target.classList.toggle('open'); }
    });

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
      themeToggle.innerHTML = isLight ? '&#x2600;' : '&#x263E;';
      themeToggle.title = isLight ? 'Switch to dark mode' : 'Switch to light mode';
    }
    applyTheme();
    themeToggle.addEventListener('click', function(e) {
      e.stopPropagation();
      isLight = !isLight;
      localStorage.setItem('hopcode-theme', isLight ? 'light' : 'dark');
      applyTheme();
    });

    // Bar collapse toggle (called from floating key or hide btn)
    function toggleBar() {
      var bar = document.getElementById('voice-bar');
      var handle = document.getElementById('bar-handle');
      bar.classList.toggle('collapsed');
      chatBar.classList.toggle('collapsed');
      var isCollapsed = bar.classList.contains('collapsed');
      if (isCollapsed) {
        handle.classList.add('visible');
      } else {
        handle.classList.remove('visible');
      }
      setTimeout(function() { fitAddon.fit(); visibleRows = term.rows; }, 350);
    }

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
      sendInput(String.fromCharCode(13));
      if (isMobile && xtermTextarea) xtermTextarea.blur();
      else term.focus();
    });

    // Select/Copy mode: show terminal text in a selectable overlay
    var copyOverlay = document.getElementById('copy-overlay');
    var copyContent = document.getElementById('copy-content');
    var copyBtn = document.getElementById('copy-btn');
    function copyOverlayShow() {
      var buf = term.buffer.active;
      var lines = [];
      for (var i = 0; i < buf.length; i++) {
        var line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true));
      }
      copyContent.textContent = lines.join(String.fromCharCode(10));
      copyOverlay.classList.add('active');
      copyContent.scrollTop = copyContent.scrollHeight;
    }
    function copyOverlayHide() {
      copyOverlay.classList.remove('active');
      term.focus();
    }
    if (copyBtn) {
      copyBtn.addEventListener('click', function(e) { e.preventDefault(); copyOverlayShow(); });
    }
    document.getElementById('copy-close-btn').addEventListener('click', copyOverlayHide);
    document.getElementById('copy-all-btn').addEventListener('click', function() {
      var text = copyContent.textContent;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(function() {
          var btn = document.getElementById('copy-all-btn');
          btn.textContent = _t('copied');
          setTimeout(function() { btn.textContent = _t('pro.copy.copy_all'); }, 1500);
        });
      }
    });

    // Voice setup - streaming ASR (sends PCM in real-time)
    // status proxy — routes .textContent through setStatus, .classList is no-op
    var status = {
      get textContent() { return _currentStatus; },
      set textContent(v) { setStatus(v); },
      classList: { add: function(){}, remove: function(){} },
      style: {}
    };
    const text = document.getElementById('text');
    let voiceWs, audioStream, audioContext, sourceNode, processorNode;
    let isRecording = false, audioReady = false;
    var pendingAsrText = ''; // Accumulate ASR text, send only when recording ends
    var asrFlushed = false; // Prevent flushing more than once per recording
    var wantsToStop = false; // Track if stop was requested during async acquireMic
    var micReleaseTimer = null; // Delayed mic release
    var cancelledRec = false; // Whether current recording was cancelled (swipe up / alt combo)
    var releaseFlushTimer = null; // Timer waiting for final result after release
    var touchStartY = 0; // touchstart Y for swipe detection
    var touchStartX = 0; // touchstart X for swipe detection
    var swipedToCancel = false; // Whether user swiped up into cancel zone
    var swipedToSend = false; // Whether user swiped right to send directly

    var vpEl = document.getElementById('voice-popup');
    var vpText = document.getElementById('vp-text');
    var vpHint = document.getElementById('vp-hint');
    var vpActions = document.getElementById('vp-actions');
    function vpShow() {
      vpText.textContent = '';
      vpText.classList.add('listening');
      vpHint.textContent = _t('pro.vp.hint_default');
      vpHint.style.display = '';
      vpActions.style.display = 'none';
      vpEl.classList.remove('hidden', 'cancel', 'send-ready');
    }
    function vpHide() { vpEl.classList.add('hidden'); vpEl.classList.remove('cancel', 'send-ready'); vpActions.style.display = 'none'; }
    function vpUpdate(txt) { vpText.textContent = txt; vpText.classList.remove('listening'); requestAnimationFrame(function() { vpText.scrollTop = vpText.scrollHeight; }); }
    function vpSetCancel(on) {
      if (on) {
        vpEl.classList.add('cancel');
        vpEl.classList.remove('send-ready');
        vpHint.textContent = _t('pro.vp.hint_cancel');
      } else {
        vpEl.classList.remove('cancel');
        vpHint.textContent = _t('pro.vp.hint_default');
      }
    }
    function vpSetSendReady(on) {
      if (on) {
        vpEl.classList.add('send-ready');
        vpEl.classList.remove('cancel');
        vpHint.textContent = _t('pro.vp.hint_send');
      } else {
        vpEl.classList.remove('send-ready');
        vpHint.textContent = _t('pro.vp.hint_default');
      }
    }

    function vpShowConfirm() {
      vpActions.style.display = 'flex';
      vpEl.classList.remove('cancel', 'send-ready');
      vpConfirmVisible = true;
      vpText.contentEditable = 'true';
      // Delay focus to avoid Alt keyup stealing focus on Windows
      setTimeout(function() { vpText.focus(); }, 100);
      // Place cursor at end of text
      var range = document.createRange();
      range.selectNodeContents(vpText);
      range.collapse(false);
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      if (isMobile) {
        vpHint.style.display = 'none';
      } else {
        vpHint.style.display = '';
        vpHint.textContent = _t('pro.vp.hint_confirm', {key: holdKeyName});
      }
    }

    function vpSend() {
      vpConfirmVisible = false;
      vpText.contentEditable = 'false';
      // Read edited text from popup
      var finalText = vpText.textContent.trim();
      if (finalText && termWs && termWs.readyState === 1) {
        asrFlushed = true;
        pendingAsrText = finalText;
        status.textContent = _t('pro.status.sending');
        // Send text as raw input + separate Enter, same as physical keyboard
        sendInput(pendingAsrText);
        setTimeout(function() { sendInput(String.fromCharCode(13)); }, 50);
        setTimeout(function() { status.textContent = defaultStatusText; }, 2000);
      }
      pendingAsrText = '';
      vpHide();
    }

    function vpDismiss() {
      vpConfirmVisible = false;
      vpText.contentEditable = 'false';
      pendingAsrText = '';
      asrFlushed = true;
      status.textContent = defaultStatusText;
      vpHide();
    }

    document.getElementById('vp-send').onclick = vpSend;
    document.getElementById('vp-cancel').onclick = vpDismiss;

    var vpConfirmVisible = false;

    // Keyboard shortcuts for confirm popup
    var ctrlAlone = false;
    document.addEventListener('keydown', function(e) {
      if (!vpConfirmVisible) return;
      if (e.key === 'Control') {
        ctrlAlone = true;
        // Don't prevent default — allow Ctrl+V etc. to work
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd combined with another key — let browser handle (paste, select all, etc.)
        ctrlAlone = false;
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        vpSend();
      } else {
        ctrlAlone = false;
      }
    }, true);
    document.addEventListener('keyup', function(e) {
      if (!vpConfirmVisible) return;
      if (e.key === 'Control' && ctrlAlone) {
        // Control released without combining — dismiss
        vpDismiss();
      }
      ctrlAlone = false;
    }, true);

    function flushAsrText() {
      if (asrFlushed) return;
      if (isRecording || altDown) return; // Still recording, wait for release
      if (pendingAsrText) {
        vpShowConfirm();
      } else {
        vpHide();
        status.textContent = defaultStatusText;
      }
    }

    function scheduleMicRelease() {
      clearTimeout(micReleaseTimer);
      micReleaseTimer = setTimeout(releaseMic, 30000);
    }

    function connectVoice() {
      voiceWs = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/terminal/ws-voice');
      voiceWs.onopen = () => {
        // If recording started before WS was ready, send asr_start now
        if (isRecording && !cancelledRec) {
          voiceWs.send(JSON.stringify({ type: 'asr_start' }));
        }
      };
      voiceWs.onmessage = (e) => {
        const d = JSON.parse(e.data);
        if (cancelledRec) return; // Recording was cancelled, ignore all results
        if (d.type === 'asr' && d.text) {
          clearTimeout(releaseFlushTimer);
          if (!vpConfirmVisible && d.text !== pendingAsrText) {
            pendingAsrText = d.text;
            vpUpdate(d.text);
          } else if (vpConfirmVisible) {
            pendingAsrText = d.text;
          }
          if (!asrFlushed) { directSendMode ? vpSend() : flushAsrText(); }
        } else if (d.type === 'asr_partial' && d.text) {
          if (!asrFlushed && !vpConfirmVisible) {
            pendingAsrText = d.text;
            vpUpdate(d.text);
          }
        } else if (d.type === 'error') {
          clearTimeout(releaseFlushTimer);
          if (pendingAsrText && !asrFlushed) {
            directSendMode ? vpSend() : flushAsrText();
          } else {
            // No text at all — show error in popup then hide
            vpUpdate('Voice recognition failed');
            vpText.style.color = '#f87171';
            status.textContent = defaultStatusText;
            setTimeout(function() { vpHide(); vpText.style.color = ''; }, 2000);
          }
        }
      };
      voiceWs.onclose = () => {
        // Reset all recording state
        clearTimeout(releaseFlushTimer);
        clearTimeout(trailingTimer);
        releaseFlushTimer = null;
        isRecording = false;
        wantsToStop = false;
        cancelledRec = false;
        swipedToCancel = false;
        vpHide();
        scheduleMicRelease();
        /* status recording class removed */
        if (status.textContent === _t('pro.status.processing') || status.textContent === 'Finishing...' || status.textContent === _t('pro.status.recording')) {
          status.textContent = defaultStatusText;
        }
        setTimeout(connectVoice, 2000);
      };
    }

    async function acquireMic() {
      if (audioReady) return true;
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        status.textContent = window.isSecureContext ? _t('pro.status.mic_not_available') : _t('pro.status.mic_needs_https');
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
          status.textContent = _t('pro.status.mic_denied');
        } else if (e.name === 'SecurityError') {
          status.textContent = _t('pro.status.mic_blocked');
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
      clearTimeout(releaseFlushTimer);
      clearTimeout(trailingTimer);
      wantsToStop = false;
      swipedToCancel = false;
      var ok = await acquireMic();
      if (!ok) return;
      if (audioContext.state === 'suspended') audioContext.resume();
      isRecording = true;
      asrFlushed = false;
      pendingAsrText = '';
      if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_start' }));
      cancelledRec = false; // Reset after asr_start so late results from cancelled session are ignored
      // If user released finger while we were acquiring mic, stop immediately
      // but don't return early — mic is now ready for next press
      if (wantsToStop) {
        stopRec(true, false);
        return;
      }
      status.textContent = _t('pro.status.recording');
      /* status recording class added */
      text.textContent = '';
      vpShow();
    }

    var trailingTimer = null;
    var directSendMode = false; // Whether to skip confirm and send directly
    function stopRec(cancel, directSend) {
      wantsToStop = true;
      clearTimeout(trailingTimer);
      if (!isRecording) return;
      /* status recording class removed */
      directSendMode = !!directSend;

      if (cancel) {
        // Cancel: discard all text, don't flush
        isRecording = false;
        cancelledRec = true;
        asrFlushed = true; // block any late flush
        pendingAsrText = '';
        text.textContent = '';
        vpHide();
        if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
        status.textContent = defaultStatusText;
        scheduleMicRelease();
        return;
      }

      // Normal release: keep capturing audio for 300ms to avoid cutting off trailing speech,
      // then send asr_end. UI already shows "processing" state.
      status.textContent = _t('pro.status.processing');
      trailingTimer = setTimeout(function() {
        isRecording = false;
        if (voiceWs?.readyState === 1) voiceWs.send(JSON.stringify({ type: 'asr_end' }));
        scheduleMicRelease();

        // Already got final result during trailing capture?
        if (asrFlushed) return;

        clearTimeout(releaseFlushTimer);
        if (pendingAsrText) {
          // Have partial text -- wait for final result before flushing
          // Direct send needs longer wait since user won't see confirm UI
          releaseFlushTimer = setTimeout(function() {
            if (!asrFlushed) { directSendMode ? vpSend() : flushAsrText(); }
          }, directSendMode ? 2000 : 300);
        } else {
          // No text yet -- wait longer for result
          releaseFlushTimer = setTimeout(function() {
            if (!asrFlushed) { directSendMode ? vpSend() : flushAsrText(); }
          }, 3000);
        }
      }, 300);
    }

    let altDown = false, altDownTime = 0, altCombined = false;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Alt' && !altDown) {
        altDown = true;
        altDownTime = Date.now();
        altCombined = false;

        if (vpConfirmVisible) {
          // Option pressed while confirm is showing
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        startRec();
        e.preventDefault();
        e.stopPropagation();
      } else if (altDown && e.key !== 'Alt') {
        // Option combined with another key - cancel recording
        altCombined = true;
        if (isRecording) stopRec(true, false);
      }
    }, true);
    document.addEventListener('keyup', (e) => {
      if (e.key === 'Alt' && altDown) {
        altDown = false;
        var holdDuration = Date.now() - altDownTime;
        e.preventDefault();
        e.stopPropagation();

        if (vpConfirmVisible) {
          // Tap Option = send
          vpSend();
          return;
        }

        if (altCombined || holdDuration < 800) {
          // Combined with other key or too short - cancel
          if (isRecording) stopRec(true, false);
        } else {
          stopRec(false, false);
        }
      }
    }, true);

    // Update font size display to match initial value
    document.getElementById('font-size').textContent = fontSize + 'px';

    // Mobile: entire voice bar is hold-to-speak (except font controls and back button)
    const voiceBar = document.getElementById('voice-bar');
    const fontControls = document.getElementById('font-controls');
    var menuBtn = document.getElementById('menu-btn');
    var specialKeys = document.getElementById('special-keys');
    var returnBtn = document.getElementById('return-btn');
    function isExcluded(el) {
      return (fontControls && fontControls.contains(el)) || (menuBtn && menuBtn.contains(el)) || (specialKeys && specialKeys.contains(el)) || (returnBtn && returnBtn.contains(el));
    }
    voiceBar.addEventListener('touchstart', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      swipedToCancel = false;
      swipedToSend = false;
      startRec();
      voiceBar.classList.add('recording');
    }, { passive: false });
    voiceBar.addEventListener('touchmove', (e) => {
      if (!isRecording) return;
      var dy = touchStartY - e.touches[0].clientY;
      var dx = e.touches[0].clientX - touchStartX;
      if (dy > 50 && !swipedToCancel) {
        swipedToCancel = true;
        swipedToSend = false;
        voiceBar.classList.add('cancel-zone');
        voiceBar.classList.remove('recording');
        status.textContent = '\u2191 Release to cancel';
        /* status recording class removed */
        vpSetCancel(true);
      } else if (dx > 60 && !swipedToSend && dy < 30) {
        swipedToSend = true;
        swipedToCancel = false;
        voiceBar.classList.remove('cancel-zone');
        voiceBar.classList.add('recording');
        status.textContent = '\u2192 Release to send';
        /* status recording class added */
        vpSetSendReady(true);
      } else if (dy <= 30 && dx <= 40 && (swipedToCancel || swipedToSend)) {
        swipedToCancel = false;
        swipedToSend = false;
        voiceBar.classList.remove('cancel-zone');
        voiceBar.classList.add('recording');
        status.textContent = _t('pro.status.recording');
        /* status recording class added */
        vpSetCancel(false);
        vpSetSendReady(false);
      }
    }, { passive: true });
    voiceBar.addEventListener('touchend', (e) => {
      if (isExcluded(e.target)) return;
      e.preventDefault();
      voiceBar.classList.remove('recording', 'cancel-zone');
      stopRec(swipedToCancel, swipedToSend);
    }, { passive: false });
    voiceBar.addEventListener('touchcancel', () => {
      voiceBar.classList.remove('recording', 'cancel-zone');
      stopRec(true, false);
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

    // --- Chat Mode ---
    var chatBar = document.getElementById('chat-bar');
    var chatInput = document.getElementById('chat-input');
    if (!isMobile) {
      var pasteKey = isMac ? 'Cmd' : 'Ctrl';
      chatInput.placeholder = _t('pro.chat.placeholder', {key: holdKeyName, paste: pasteKey});
    }
    var chatSendBtn = document.getElementById('chat-send-btn');
    var chatMicBtn = null; // removed from UI
    var chatQuickActions = document.getElementById('chat-quick-actions');
    var chatMenuToggle = document.getElementById('menu-chat-toggle');
    var chatMenuBtn = document.getElementById('chat-menu-btn');
    var chatVoiceToggle = document.getElementById('chat-voice-toggle');
    var chatHoldSpeak = document.getElementById('chat-hold-speak');
    var cvtMicIcon = document.getElementById('cvt-mic-icon');
    var cvtKbIcon = document.getElementById('cvt-kb-icon');
    var chatModeEnabled = true;
    var chatVoiceMode = false; // kept for compatibility

    // Auto-grow textarea + toggle send button
    chatInput.addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 120) + 'px';
      chatSendBtn.disabled = !this.value.trim();
    });

    // Send chat message to terminal
    function chatSend() {
      var text = chatInput.value.trim();
      if (!text) return;
      sendInput(text);
      setTimeout(function() { sendInput(String.fromCharCode(13)); }, 50);
      chatInput.value = '';
      chatInput.style.height = 'auto';
      chatSendBtn.disabled = true;
      autoScroll = true;
      scrollToCursor();
    }

    chatSendBtn.addEventListener('click', chatSend);
    chatInput.addEventListener('keydown', function(e) {
      e.stopPropagation(); // Prevent xterm from stealing keystrokes
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        chatSend();
      }
    });
    chatInput.addEventListener('keyup', function(e) { e.stopPropagation(); });
    chatInput.addEventListener('keypress', function(e) { e.stopPropagation(); });
    // Disable xterm textarea when chat input is focused to prevent double input
    chatInput.addEventListener('focus', function() {
      if (xtermTextarea) xtermTextarea.disabled = true;
    });
    chatInput.addEventListener('blur', function() {
      if (xtermTextarea) xtermTextarea.disabled = false;
    });

    // Voice toggle: switch between text input and hold-to-speak
    var chatVoiceMode = false;
    var chatHoldSpeak = document.getElementById('chat-hold-speak');
    if (chatVoiceToggle && chatHoldSpeak) {
      chatVoiceToggle.addEventListener('click', function() {
        chatVoiceMode = !chatVoiceMode;
        if (chatVoiceMode) {
          chatHoldSpeak.style.display = '';
          chatInput.style.display = 'none';
          chatSendBtn.style.display = 'none';
          cvtMicIcon.style.display = 'none';
          cvtKbIcon.style.display = '';
          chatVoiceToggle.classList.add('active');
        } else {
          chatHoldSpeak.style.display = 'none';
          chatInput.style.display = '';
          chatSendBtn.style.display = '';
          cvtMicIcon.style.display = '';
          cvtKbIcon.style.display = 'none';
          chatVoiceToggle.classList.remove('active');
          chatSendBtn.disabled = !chatInput.value.trim();
          chatInput.focus();
        }
      });

      // Hold-to-speak touch events
      var chatMicDown = false;
      var chatHoldStartY = 0;
      var chatHoldSwiped = false;
      chatHoldSpeak.addEventListener('touchstart', function(e) {
        e.preventDefault();
        chatMicDown = true;
        chatHoldStartY = e.touches[0].clientY;
        chatHoldSwiped = false;
        touchStartY = chatHoldStartY;
        touchStartX = e.touches[0].clientX;
        swipedToCancel = false;
        swipedToSend = false;
        chatHoldSpeak.textContent = _t('pro.chat.recording');
        chatHoldSpeak.classList.add('recording');
        startRec();
      }, { passive: false });
      chatHoldSpeak.addEventListener('touchmove', function(e) {
        if (!chatMicDown) return;
        var dy = chatHoldStartY - e.touches[0].clientY;
        if (dy > 50 && !chatHoldSwiped) {
          chatHoldSwiped = true;
          swipedToCancel = true;
          chatHoldSpeak.textContent = _t('easy.btn.release_to_cancel');
          vpSetCancel(true);
        } else if (dy <= 30 && chatHoldSwiped) {
          chatHoldSwiped = false;
          swipedToCancel = false;
          chatHoldSpeak.textContent = _t('pro.chat.recording');
          vpSetCancel(false);
        }
      }, { passive: true });
      chatHoldSpeak.addEventListener('touchend', function(e) {
        e.preventDefault();
        if (!chatMicDown) return;
        chatMicDown = false;
        chatHoldSpeak.textContent = _t('pro.chat.hold_to_speak');
        chatHoldSpeak.classList.remove('recording');
        stopRec(chatHoldSwiped, false);
      }, { passive: false });
      chatHoldSpeak.addEventListener('touchcancel', function() {
        chatMicDown = false;
        chatHoldSpeak.textContent = _t('pro.chat.hold_to_speak');
        chatHoldSpeak.classList.remove('recording');
        stopRec(true, false);
      });
      chatHoldSpeak.addEventListener('contextmenu', function(e) { e.preventDefault(); });
      // Desktop mouse hold
      chatHoldSpeak.addEventListener('mousedown', function(e) {
        e.preventDefault();
        chatMicDown = true;
        chatHoldSwiped = false;
        chatHoldSpeak.textContent = _t('pro.chat.recording');
        chatHoldSpeak.classList.add('recording');
        startRec();
      });
      document.addEventListener('mouseup', function() {
        if (!chatMicDown) return;
        chatMicDown = false;
        chatHoldSpeak.textContent = _t('pro.chat.hold_to_speak');
        chatHoldSpeak.classList.remove('recording');
        stopRec(chatHoldSwiped, false);
      });
    }

    // When in chat mode, voice result goes to chat input instead of terminal
    var chatModeVoiceIntercept = false;

    // Chat mode always enabled — setChatMode kept for compatibility
    function setChatMode(on) {
      chatModeEnabled = true;
      chatModeVoiceIntercept = true;
    }

    // Quick action buttons for y/n prompts
    function chatShowQuickActions(actions) {
      chatQuickActions.innerHTML = '';
      actions.forEach(function(a) {
        var btn = document.createElement('button');
        btn.className = 'chat-quick-btn' + (a.cls ? ' ' + a.cls : '');
        btn.textContent = a.label;
        btn.addEventListener('click', function() {
          sendInput(a.value);
          if (a.enter !== false) setTimeout(function() { sendInput(String.fromCharCode(13)); }, 50);
          chatQuickActions.classList.remove('visible');
        });
        chatQuickActions.appendChild(btn);
      });
      chatQuickActions.classList.add('visible');
    }

    // Detect permission prompts from terminal output
    var lastTermOutput = '';
    var origTermWrite = null;
    function chatDetectPrompts(data) {
      if (!chatModeEnabled) return;
      // Accumulate recent output (keep last 500 chars)
      lastTermOutput += (typeof data === 'string' ? data : '');
      if (lastTermOutput.length > 500) lastTermOutput = lastTermOutput.slice(-500);

      // Strip ANSI escape codes for matching
      var esc = String.fromCharCode(27);
      var ansiRe = new RegExp(esc + '[[[][0-9;]*[a-zA-Z]', 'g');
      var oscRe = new RegExp(esc + '[]][^' + String.fromCharCode(7) + ']*' + String.fromCharCode(7), 'g');
      var clean = lastTermOutput.replace(ansiRe, '').replace(oscRe, '');

      // Detect Claude Code permission prompt (Allow/Deny)
      var endsQ = clean.trim().slice(-5).indexOf('?') >= 0;
      if (/Allow|allow once|deny/i.test(clean) && endsQ) {
        chatShowQuickActions([
          { label: 'Yes (y)', value: 'y', cls: 'primary' },
          { label: 'Always allow', value: 'a', cls: 'primary' },
          { label: 'No (n)', value: 'n', cls: 'danger' },
        ]);
        lastTermOutput = '';
      }
      // Detect generic y/n prompt
      else if (clean.indexOf('(y/n)') >= 0 || clean.indexOf('[y/N]') >= 0 || clean.indexOf('[Y/n]') >= 0) {
        chatShowQuickActions([
          { label: 'Yes', value: 'y', cls: 'primary' },
          { label: 'No', value: 'n', cls: 'danger' },
        ]);
        lastTermOutput = '';
      }
      // Detect "Press Enter to continue"
      else if (/press enter|continue[?]/i.test(clean.trim().slice(-60))) {
        chatShowQuickActions([
          { label: 'Continue', value: String.fromCharCode(13), enter: false, cls: 'primary' },
        ]);
        lastTermOutput = '';
      }
    }



    var chatModeAllowed = true;
    function initChatModeForUser(user) {}

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
    function fbClose() {
      fbPanel.classList.remove('open');
      fbClearPendingDrop();
    }

    var fbPendingDropEl = document.getElementById('fb-pending-drop');
    var fbPendingLabel = document.getElementById('fb-pending-label');

    function fbShowPendingBanner() {
      if (!fbPendingDropFiles && !fbPendingDropEntries) return;
      var count = 0;
      if (fbPendingDropFiles && fbPendingDropFiles.length > 0) count = fbPendingDropFiles.length;
      else if (fbPendingDropEntries) count = fbPendingDropEntries.length;
      fbPendingLabel.textContent = _t('pro.fb.pending', {n: count});
      fbPendingDropEl.style.display = 'flex';
    }

    function fbClearPendingDrop() {
      fbPendingDropFiles = null;
      fbPendingDropEntries = null;
      fbPendingDropEl.style.display = 'none';
    }

    document.getElementById('fb-pending-upload').addEventListener('click', function() {
      var files = fbPendingDropFiles;
      var entries = fbPendingDropEntries;
      fbClearPendingDrop();
      if (entries && entries.length > 0) {
        var hasDir = false;
        for (var i = 0; i < entries.length; i++) {
          if (entries[i].isDirectory) { hasDir = true; break; }
        }
        if (hasDir) {
          fbCollectEntries(entries, function(collected) {
            if (collected.length > 0) fbUploadFilesWithPaths(collected);
          });
        } else if (files && files.length > 0) {
          fbUploadFiles(files);
        }
      } else if (files && files.length > 0) {
        fbUploadFiles(files);
      }
    });

    document.getElementById('fb-pending-cancel').addEventListener('click', function() {
      fbClearPendingDrop();
    });

    var fbBackIcon = '<svg width="20" height="20" viewBox="0 0 24 24" fill="#888"><path d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z"/></svg>';

    function fbLoadDir(dirPath) {
      var url = '/terminal/files?session=' + encodeURIComponent(sessionId) + '&path=' + encodeURIComponent(dirPath) + (fbShowHidden ? '&hidden=1' : '');
      fbError.style.display = 'none';
      fbList.innerHTML = '<div style="padding:20px;text-align:center;color:#666">' + _t('loading') + '</div>';
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
          fbList.innerHTML = html || '<div style="padding:20px;text-align:center;color:#666">' + _t('pro.fb.empty') + '</div>';
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
    document.getElementById('menu-easy-mode').addEventListener('click', function(e) {
      e.preventDefault();
      location.href = '/terminal/easy?session=' + encodeURIComponent(sessionId);
    });
    document.getElementById('menu-lang-toggle').addEventListener('click', function() {
      _setLang(_lang === 'en' ? 'zh' : 'en');
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
    // Chat upload button — pick files then show upload chooser dialog
    var chatUploadInput = document.getElementById('chat-upload-input');
    document.getElementById('chat-upload-btn').addEventListener('click', function() { chatUploadInput.click(); });
    chatUploadInput.addEventListener('change', function() {
      if (!chatUploadInput.files || chatUploadInput.files.length === 0) return;
      uploadChooserShow(chatUploadInput.files, null);
      chatUploadInput.value = '';
    });
    document.getElementById('fb-mkdir-btn').addEventListener('click', function() {
      var name = prompt(_t('pro.fb.folder_prompt'));
      if (!name || !name.trim()) return;
      name = name.trim();
      fetch('/terminal/mkdir?path=' + encodeURIComponent(fbCurrentPath) + '&name=' + encodeURIComponent(name) + '&exists=error', {
        method: 'POST',
        credentials: 'include',
      })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.error) {
          fbError.textContent = data.error;
          fbError.style.display = 'block';
          fbError.style.color = '#f87171';
          fbError.style.background = '#2a1a1a';
        } else {
          fbLoadDir(fbCurrentPath);
        }
      })
      .catch(function(err) {
        fbError.textContent = err.message;
        fbError.style.display = 'block';
        fbError.style.color = '#f87171';
        fbError.style.background = '#2a1a1a';
      });
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
      fbHandleDrop(e);
    });

    // Handle drop anywhere on the document
    // If file browser is open, drop goes directly to file browser
    // Otherwise, show chooser popup
    document.addEventListener('dragover', function(e) {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.indexOf('Files') !== -1) {
        e.preventDefault();
      }
    });
    document.addEventListener('drop', function(e) {
      if (!e.dataTransfer) return;
      // Always preventDefault first to stop browser from opening files in new tab
      e.preventDefault();
      var files = e.dataTransfer.files;
      var items = e.dataTransfer.items;
      // Extract entries before checking files (folders may have entries but no files)
      var entries = [];
      if (items) {
        for (var i = 0; i < items.length; i++) {
          var entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
          if (entry) entries.push(entry);
        }
      }
      if ((!files || files.length === 0) && entries.length === 0) return;
      if (fbPanel.classList.contains('open')) {
        // File browser is open — direct upload (existing behavior)
        fbHandleDrop(e);
      } else {
        // File browser closed — show chooser
        uploadChooserShow(files, entries.length > 0 ? entries : null);
      }
    });

    function fbHandleDrop(e) {
      var items = e.dataTransfer && e.dataTransfer.items;
      if (!items || items.length === 0) return;
      var entries = [];
      for (var i = 0; i < items.length; i++) {
        var entry = items[i].webkitGetAsEntry && items[i].webkitGetAsEntry();
        if (entry) entries.push(entry);
      }
      if (entries.length === 0) {
        // Fallback for browsers without webkitGetAsEntry
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) fbUploadFiles(files);
        return;
      }
      // Check if any entry is a directory
      var hasDir = false;
      for (var i = 0; i < entries.length; i++) {
        if (entries[i].isDirectory) { hasDir = true; break; }
      }
      if (!hasDir) {
        // Plain files only — use simple upload
        var files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) fbUploadFiles(files);
        return;
      }
      // Collect all files with relative paths from directory entries
      fbCollectEntries(entries, function(collected) {
        if (collected.length === 0) return;
        fbUploadFilesWithPaths(collected);
      });
    }

    function fbCollectEntries(entries, callback) {
      var result = [];
      var pending = entries.length;
      if (pending === 0) { callback(result); return; }
      function processEntry(entry, basePath) {
        if (entry.isFile) {
          if (isJunkFile(entry.name)) { pending--; if (pending === 0) callback(result); return; }
          entry.file(function(file) {
            result.push({ file: file, relativePath: basePath + file.name });
            pending--;
            if (pending === 0) callback(result);
          }, function() {
            pending--;
            if (pending === 0) callback(result);
          });
        } else if (entry.isDirectory) {
          var reader = entry.createReader();
          var allEntries = [];
          (function readAll() {
            reader.readEntries(function(batch) {
              if (batch.length === 0) {
                // Directory itself counts as needing mkdir; add marker
                result.push({ dir: true, relativePath: basePath + entry.name + '/' });
                pending--; // for original entry
                pending += allEntries.length;
                if (allEntries.length === 0 && pending === 0) { callback(result); return; }
                for (var i = 0; i < allEntries.length; i++) {
                  processEntry(allEntries[i], basePath + entry.name + '/');
                }
                if (pending === 0) callback(result);
              } else {
                for (var i = 0; i < batch.length; i++) allEntries.push(batch[i]);
                readAll();
              }
            }, function() {
              pending--;
              if (pending === 0) callback(result);
            });
          })();
        } else {
          pending--;
          if (pending === 0) callback(result);
        }
      }
      for (var i = 0; i < entries.length; i++) {
        processEntry(entries[i], '');
      }
    }

    function fbUploadFilesWithPaths(collected) {
      // Separate dirs and files
      var dirs = [];
      var files = [];
      for (var i = 0; i < collected.length; i++) {
        if (collected[i].dir) dirs.push(collected[i].relativePath);
        else files.push(collected[i]);
      }
      // Sort dirs by depth so parents are created first
      dirs.sort(function(a, b) { return a.split('/').length - b.split('/').length; });

      var total = files.length;
      fbError.textContent = 'Creating folders & uploading ' + total + ' file' + (total !== 1 ? 's' : '') + '...';
      fbError.style.display = 'block';
      fbError.style.color = '#4ade80';
      fbError.style.background = '#1a2a1a';

      // Create directories sequentially, track renames, then upload files
      var dirIdx = 0;
      var renameMap = {}; // original dir path -> actual dir path
      function remapPath(p) {
        // Apply rename map: check longest matching prefix first
        var keys = Object.keys(renameMap).sort(function(a, b) { return b.length - a.length; });
        for (var k = 0; k < keys.length; k++) {
          var orig = keys[k];
          if (p === orig) return renameMap[orig];
          if (p.indexOf(orig + '/') === 0) return renameMap[orig] + p.slice(orig.length);
        }
        return p;
      }
      function createNextDir() {
        if (dirIdx >= dirs.length) {
          uploadFilesParallel();
          return;
        }
        var dirRel = dirs[dirIdx];
        // dirRel ends with '/', strip it to get parent+name
        var stripped = dirRel.replace(/\\/$/, '');
        var parts = stripped.split('/');
        var folderName = parts.pop();
        var parentRel = parts.length > 0 ? parts.join('/') : '';
        // Remap parent in case a parent dir was renamed
        var remappedParentRel = parentRel ? remapPath(parentRel) : '';
        var parentPath = fbCurrentPath;
        if (remappedParentRel) parentPath = parentPath.replace(/\\/$/, '') + '/' + remappedParentRel;
        fetch('/terminal/mkdir?path=' + encodeURIComponent(parentPath) + '&name=' + encodeURIComponent(folderName), {
          method: 'POST', credentials: 'include'
        }).then(function(r) { return r.json(); }).then(function(data) {
          if (data && data.name && data.name !== folderName) {
            // Server renamed this dir — track it
            var actualRel = (remappedParentRel ? remappedParentRel + '/' : '') + data.name;
            renameMap[stripped] = actualRel;
          }
          dirIdx++;
          createNextDir();
        }).catch(function() {
          dirIdx++;
          createNextDir();
        });
      }

      function uploadFilesParallel() {
        if (files.length === 0) {
          fbUploadDone(0, []);
          return;
        }
        var done = 0;
        var errors = [];
        for (var i = 0; i < files.length; i++) {
          (function(entry) {
            // Determine upload directory from relativePath, applying renames
            var parts = entry.relativePath.split('/');
            parts.pop(); // remove filename
            var subDir = parts.length > 0 ? parts.join('/') : '';
            if (subDir) subDir = remapPath(subDir);
            var uploadPath = fbCurrentPath;
            if (subDir) uploadPath = uploadPath.replace(/\\/$/, '') + '/' + subDir;
            fetch('/terminal/file-upload?path=' + encodeURIComponent(uploadPath), {
              method: 'POST',
              credentials: 'include',
              headers: { 'X-Filename': encodeURIComponent(entry.file.name) },
              body: entry.file,
            })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              if (data.error) errors.push(entry.relativePath + ': ' + data.error);
              done++;
              fbError.textContent = 'Uploading... (' + done + '/' + total + ')';
              if (done === total) fbUploadDone(total, errors);
            })
            .catch(function(err) {
              errors.push(entry.relativePath + ': ' + err.message);
              done++;
              fbError.textContent = 'Uploading... (' + done + '/' + total + ')';
              if (done === total) fbUploadDone(total, errors);
            });
          })(files[i]);
        }
      }

      createNextDir();
    }

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

// --- Recordings playback page ---

function getAdminHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>Admin - Hopcode</title>
<link rel="icon" type="image/svg+xml" href="./icons/favicon.svg">
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#0f172a; color:#e2e8f0; min-height:100vh; }
.container { max-width:700px; margin:0 auto; padding:16px; }
.header { display:flex; align-items:center; justify-content:space-between; margin-bottom:24px; padding-bottom:16px; border-bottom:1px solid #1e293b; }
.header h1 { font-size:20px; font-weight:600; }
.back-link { color:#60a5fa; text-decoration:none; font-size:14px; }
.back-link:hover { color:#93c5fd; }

.create-form { background:#1e293b; border-radius:12px; padding:16px; margin-bottom:24px; }
.create-form h2 { font-size:15px; font-weight:600; margin-bottom:12px; color:#94a3b8; }
.form-row { display:flex; gap:10px; flex-wrap:wrap; }
.form-row input { flex:1; min-width:120px; padding:10px 12px; border-radius:8px; border:1px solid #334155; background:#0f172a; color:#e2e8f0; font-size:14px; outline:none; }
.form-row input:focus { border-color:#60a5fa; }
.form-row input::placeholder { color:#475569; }
.create-btn { padding:10px 20px; border-radius:8px; border:none; background:#3b82f6; color:#fff; font-size:14px; font-weight:600; cursor:pointer; white-space:nowrap; }
.create-btn:hover { background:#2563eb; }
.create-btn:disabled { opacity:0.5; cursor:not-allowed; }
.create-btn.loading { display:inline-flex; align-items:center; gap:6px; }
.spinner { display:inline-block; width:14px; height:14px; border:2px solid rgba(255,255,255,0.3); border-top-color:#fff; border-radius:50%; animation:spin 0.6s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }

.user-list { display:flex; flex-direction:column; gap:8px; }
.user-card { display:flex; align-items:center; background:#1e293b; border-radius:10px; padding:12px 16px; gap:12px; }
.user-card.disabled-user { opacity:0.5; }
.user-avatar { width:36px; height:36px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; color:#fff; flex-shrink:0; }
.user-info { flex:1; min-width:0; }
.user-name { font-size:15px; font-weight:600; display:flex; align-items:center; gap:6px; }
.user-detail { font-size:12px; color:#64748b; margin-top:2px; }
.badge { font-size:10px; padding:2px 6px; border-radius:4px; font-weight:600; }
.badge-admin { background:#3b82f6; color:#fff; }
.badge-disabled { background:#ef4444; color:#fff; }
.toggle-btn { padding:6px 14px; border-radius:6px; border:1px solid #334155; background:transparent; color:#94a3b8; font-size:13px; cursor:pointer; white-space:nowrap; }
.toggle-btn:hover { border-color:#60a5fa; color:#60a5fa; }
.toggle-btn.enable-btn { border-color:#22c55e; color:#22c55e; }
.toggle-btn.enable-btn:hover { background:rgba(34,197,94,0.1); }

.toast { position:fixed; bottom:30px; left:50%; transform:translateX(-50%) translateY(20px); background:#1e293b; color:#e2e8f0; padding:10px 24px; border-radius:20px; font-size:14px; opacity:0; transition:all 0.3s; z-index:100; box-shadow:0 4px 12px rgba(0,0,0,0.4); }
.toast.show { opacity:1; transform:translateX(-50%) translateY(0); }
.toast.error { border:1px solid #ef4444; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1 id="page-title">User Management</h1>
    <a class="back-link" href="/terminal" id="back-link">← Back</a>
  </div>

  <div class="create-form">
    <h2 id="create-title">Create User</h2>
    <div class="form-row">
      <input type="text" id="new-username" placeholder="Username" autocomplete="off" autocapitalize="off">
      <input type="text" id="new-password" placeholder="Password" autocomplete="off">
      <button class="create-btn" id="create-btn">Create</button>
    </div>
  </div>

  <div class="user-list" id="user-list"></div>
</div>

<div class="toast" id="toast"></div>

<script>
${getI18nScript()}
(function() {
  // i18n
  document.getElementById('page-title').textContent = _t('admin.title');
  document.getElementById('create-title').textContent = _t('admin.create_user');
  document.getElementById('back-link').textContent = '← ' + _t('admin.back');
  document.getElementById('new-username').placeholder = _t('admin.username');
  document.getElementById('new-password').placeholder = _t('admin.password');
  document.getElementById('create-btn').textContent = _t('admin.create_user');

  var colors = ['#3b82f6','#8b5cf6','#ec4899','#f59e0b','#10b981','#06b6d4','#ef4444','#84cc16'];
  function avatarColor(name) { var h = 0; for(var i=0;i<name.length;i++) h = name.charCodeAt(i) + ((h<<5)-h); return colors[Math.abs(h)%colors.length]; }

  function showToast(msg, isError) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    setTimeout(function(){ t.classList.add('show'); }, 10);
    setTimeout(function(){ t.classList.remove('show'); }, 2500);
  }

  function loadUsers() {
    fetch('/terminal/api/admin/users', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(users) {
        var list = document.getElementById('user-list');
        list.innerHTML = '';
        users.forEach(function(u) {
          var card = document.createElement('div');
          card.className = 'user-card' + (u.disabled ? ' disabled-user' : '');
          var initial = u.username.charAt(0).toUpperCase();
          var badges = '';
          if (u.isAdmin) badges += '<span class="badge badge-admin">' + _t('admin.admin_badge') + '</span>';
          if (u.disabled) badges += '<span class="badge badge-disabled">' + _t('admin.disabled') + '</span>';
          var btnHtml = '';
          if (!u.isAdmin) {
            if (u.disabled) {
              btnHtml = '<button class="toggle-btn enable-btn" data-user="' + u.username + '">' + _t('admin.enable') + '</button>';
            } else {
              btnHtml = '<button class="toggle-btn" data-user="' + u.username + '">' + _t('admin.disable') + '</button>';
            }
          }
          card.innerHTML = '<div class="user-avatar" style="background:' + avatarColor(u.username) + '">' + initial + '</div>' +
            '<div class="user-info"><div class="user-name">' + u.username + ' ' + badges + '</div>' +
            '<div class="user-detail">' + u.linuxUser + ' · ' + (u.disabled ? _t('admin.disabled') : _t('admin.enabled')) + '</div></div>' +
            btnHtml;
          list.appendChild(card);

          var btn = card.querySelector('.toggle-btn');
          if (btn) {
            btn.addEventListener('click', function() {
              var name = this.getAttribute('data-user');
              var msg = u.disabled ? _t('admin.confirm_enable', {name: name}) : _t('admin.confirm_disable', {name: name});
              if (!confirm(msg)) return;
              fetch('/terminal/api/admin/users/' + encodeURIComponent(name) + '/toggle', {
                method: 'PUT', credentials: 'include'
              }).then(function(r) { return r.json(); }).then(function(d) {
                if (d.success) {
                  showToast(_t('admin.updated', {name: name}));
                  loadUsers();
                } else {
                  showToast(d.error || 'Error', true);
                }
              });
            });
          }
        });
      });
  }

  document.getElementById('create-btn').addEventListener('click', function() {
    var username = document.getElementById('new-username').value.trim();
    var password = document.getElementById('new-password').value.trim();
    if (!username || !password) { showToast(_t('admin.error_empty'), true); return; }
    var btn = this;
    var origText = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>' + _t('admin.creating');
    btn.classList.add('loading');
    fetch('/terminal/api/admin/users', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username, password: password })
    }).then(function(r) { return r.json(); }).then(function(d) {
      btn.disabled = false;
      btn.textContent = origText;
      btn.classList.remove('loading');
      if (d.success) {
        showToast(_t('admin.created', {name: username}));
        document.getElementById('new-username').value = '';
        document.getElementById('new-password').value = '';
        loadUsers();
      } else {
        showToast(d.error || 'Error', true);
      }
    }).catch(function() { btn.disabled = false; btn.textContent = origText; btn.classList.remove('loading'); showToast('Error', true); });
  });

  loadUsers();
})();
</script>
</body>
</html>`;
}

function getRecordingsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Terminal Recordings</title>
<link rel="stylesheet" type="text/css" href="https://cdn.jsdelivr.net/npm/asciinema-player@3.9.0/dist/bundle/asciinema-player.css">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; padding: 16px; }
  h1 { font-size: 1.3em; margin-bottom: 12px; color: #4ecca3; }
  .back { display: inline-block; margin-bottom: 12px; color: #4ecca3; text-decoration: none; font-size: 0.9em; }
  .back:hover { text-decoration: underline; }
  .list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
  .item { background: #16213e; border-radius: 8px; padding: 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center; }
  .item:hover { background: #1a2744; }
  .item.active { border: 1px solid #4ecca3; }
  .item-info { flex: 1; }
  .item-title { font-weight: 600; font-size: 0.95em; }
  .item-meta { font-size: 0.8em; color: #888; margin-top: 2px; }
  .item-actions { display: flex; gap: 8px; }
  .btn-del { background: none; border: 1px solid #e74c3c; color: #e74c3c; border-radius: 4px; padding: 4px 8px; cursor: pointer; font-size: 0.8em; }
  .btn-del:hover { background: #e74c3c; color: #fff; }
  #player-wrap { display: none; margin-bottom: 16px; background: #0f0f23; border-radius: 8px; padding: 8px; }
  #player-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px; }
  #player-title { font-size: 0.9em; color: #4ecca3; }
  #wall-clock { font-size: 0.85em; color: #f0c040; font-variant-numeric: tabular-nums; }
  #time-seek { display: flex; align-items: center; gap: 6px; margin: 8px 0; flex-wrap: wrap; }
  #time-seek label { font-size: 0.8em; color: #aaa; }
  #time-seek input[type=range] { flex: 1; min-width: 120px; accent-color: #4ecca3; }
  #time-seek .ts-display { font-size: 0.8em; color: #ccc; font-variant-numeric: tabular-nums; min-width: 90px; }
  .seek-btns { display: flex; gap: 4px; flex-wrap: wrap; }
  .seek-btns button { background: #16213e; border: 1px solid #4ecca3; color: #4ecca3; border-radius: 4px; padding: 3px 8px; cursor: pointer; font-size: 0.75em; }
  .seek-btns button:hover { background: #4ecca3; color: #0f0f23; }
  .empty { color: #666; font-style: italic; padding: 20px; text-align: center; }
  .loading { color: #888; padding: 20px; text-align: center; }
</style>
</head>
<body>
<a class="back" href="/terminal">&larr; Back to Portal</a>
<h1>Terminal Recordings</h1>
<div id="player-wrap">
  <div id="player-header">
    <div id="player-title"></div>
    <div id="wall-clock"></div>
  </div>
  <div id="player"></div>
  <div id="time-seek">
    <label>Timeline:</label>
    <span class="ts-display" id="seek-time-start"></span>
    <input type="range" id="seek-slider" min="0" max="1000" value="0" step="1">
    <span class="ts-display" id="seek-time-end"></span>
  </div>
  <div class="seek-btns" id="seek-btns">
    <button data-delta="-60">&laquo; 1m</button>
    <button data-delta="-10">&lsaquo; 10s</button>
    <button data-delta="10">10s &rsaquo;</button>
    <button data-delta="60">1m &raquo;</button>
    <button data-delta="300">5m &raquo;&raquo;</button>
  </div>
</div>
<div id="list" class="list"><div class="loading">Loading...</div></div>
<script src="https://cdn.jsdelivr.net/npm/asciinema-player@3.9.0/dist/bundle/asciinema-player.min.js"></script>
<script>
(function() {
  const listEl = document.getElementById('list');
  const playerWrap = document.getElementById('player-wrap');
  const playerEl = document.getElementById('player');
  const playerTitle = document.getElementById('player-title');
  const wallClock = document.getElementById('wall-clock');
  const seekSlider = document.getElementById('seek-slider');
  const seekTimeStart = document.getElementById('seek-time-start');
  const seekTimeEnd = document.getElementById('seek-time-end');
  const seekBtns = document.getElementById('seek-btns');
  let currentPlayer = null;
  let currentRecTimestamp = 0;
  let rafId = null;
  let sliderDragging = false;

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' KB';
    return (bytes/(1024*1024)).toFixed(1) + ' MB';
  }

  function fmtDuration(sec) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
    return m + ':' + String(s).padStart(2, '0');
  }

  function fmtDate(ts) {
    return new Date(ts * 1000).toLocaleString();
  }

  function fmtWallTime(ts) {
    const d = new Date(ts * 1000);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString();
  }

  async function loadList() {
    try {
      const resp = await fetch('/terminal/api/recordings', { credentials: 'include' });
      const recordings = await resp.json();
      if (!recordings.length) {
        listEl.innerHTML = '<div class="empty">No recordings yet</div>';
        return;
      }
      listEl.innerHTML = '';
      for (const rec of recordings) {
        const item = document.createElement('div');
        item.className = 'item';
        item.dataset.id = rec.id;
        item.innerHTML =
          '<div class="item-info">' +
            '<div class="item-title">' + esc(rec.title) + '</div>' +
            '<div class="item-meta">' + fmtDate(rec.timestamp) + ' &middot; ' + fmtDuration(rec.duration) + ' &middot; ' + fmtSize(rec.size) + '</div>' +
          '</div>' +
          '<div class="item-actions">' +
            '<button class="btn-del" data-id="' + esc(rec.id) + '">Delete</button>' +
          '</div>';
        item.querySelector('.item-info').addEventListener('click', () => play(rec));
        item.querySelector('.btn-del').addEventListener('click', async (e) => {
          e.stopPropagation();
          if (!confirm('Delete this recording?')) return;
          await fetch('/terminal/api/recordings/' + encodeURIComponent(rec.id), { method: 'DELETE', credentials: 'include' });
          loadList();
        });
        listEl.appendChild(item);
      }
    } catch (e) {
      listEl.innerHTML = '<div class="empty">Failed to load recordings</div>';
    }
  }

  function stopTimeUpdate() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
  }

  function startTimeUpdate() {
    stopTimeUpdate();
    function tick() {
      if (!currentPlayer) return;
      try {
        const cur = currentPlayer.getCurrentTime() || 0;
        const dur = currentPlayer.getDuration() || 0;
        // Wall clock: recording start + elapsed
        wallClock.textContent = fmtWallTime(currentRecTimestamp + cur);
        // Slider
        if (!sliderDragging && dur > 0) {
          seekSlider.value = Math.round((cur / dur) * 1000);
        }
        // Time displays
        seekTimeStart.textContent = fmtDuration(cur);
        seekTimeEnd.textContent = fmtDuration(dur);
      } catch(e) {}
      rafId = requestAnimationFrame(tick);
    }
    rafId = requestAnimationFrame(tick);
  }

  function play(rec) {
    stopTimeUpdate();
    if (currentPlayer) { currentPlayer.dispose(); currentPlayer = null; }
    playerEl.innerHTML = '';
    playerWrap.style.display = 'block';
    playerTitle.textContent = rec.title + ' — ' + fmtDate(rec.timestamp);
    currentRecTimestamp = rec.timestamp;
    wallClock.textContent = fmtWallTime(rec.timestamp);
    seekSlider.value = 0;
    seekTimeStart.textContent = '0:00';
    seekTimeEnd.textContent = fmtDuration(rec.duration);
    // Highlight active item
    document.querySelectorAll('.item').forEach(el => el.classList.toggle('active', el.dataset.id === rec.id));
    currentPlayer = AsciinemaPlayer.create(
      '/terminal/api/recordings/' + encodeURIComponent(rec.id) + '.cast',
      playerEl,
      { fit: 'width', theme: 'monokai', idleTimeLimit: 3 }
    );
    currentPlayer.addEventListener('playing', startTimeUpdate);
    currentPlayer.addEventListener('pause', stopTimeUpdate);
    currentPlayer.addEventListener('ended', stopTimeUpdate);
    // Start updating immediately in case autoplay
    startTimeUpdate();
  }

  // Slider seek
  seekSlider.addEventListener('mousedown', () => { sliderDragging = true; });
  seekSlider.addEventListener('touchstart', () => { sliderDragging = true; }, {passive: true});
  seekSlider.addEventListener('input', () => {
    if (!currentPlayer) return;
    const dur = currentPlayer.getDuration() || 0;
    if (dur > 0) {
      const t = (seekSlider.value / 1000) * dur;
      seekTimeStart.textContent = fmtDuration(t);
      wallClock.textContent = fmtWallTime(currentRecTimestamp + t);
    }
  });
  function sliderSeek() {
    sliderDragging = false;
    if (!currentPlayer) return;
    const dur = currentPlayer.getDuration() || 0;
    if (dur > 0) {
      const t = (seekSlider.value / 1000) * dur;
      currentPlayer.seek(t);
    }
  }
  seekSlider.addEventListener('mouseup', sliderSeek);
  seekSlider.addEventListener('touchend', sliderSeek);

  // Button seek
  seekBtns.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !currentPlayer) return;
    const delta = parseInt(btn.dataset.delta);
    const cur = currentPlayer.getCurrentTime() || 0;
    const dur = currentPlayer.getDuration() || 1;
    const target = Math.max(0, Math.min(dur, cur + delta));
    currentPlayer.seek(target);
  });

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  loadList();
})();
</script>
</body>
</html>`;
}

// Pre-compress large HTML responses for faster delivery over slow networks
const indexHtmlGz = zlib.gzipSync(indexHtml);
const loginHtmlGz = new Map<string, Buffer>(); // cached per multi-user state
const vendorGzCache = new Map<string, { raw: Buffer; gz: Buffer }>(); // gzip cache for vendor files
const easyHtmlGzCache = new Map<string, Buffer>(); // gzip cache for Easy Mode HTML per user

// ---- Easy Mode Session Bootstrap ----
// Tracks server-side Claude startup for new easy sessions.
// Server connects to PTY, sends cd+claude, monitors output for ❯ prompt.
// Easy Mode: map of session ID → ClaudeProcess (manages claude -p subprocesses)
interface EasySessionInfo {
  cp: ClaudeProcess;
  owner: string;
  project: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  connectedUsers: Map<string, Set<WebSocket>>;  // username -> set of WS connections
  sharedWith: Set<string>;  // usernames who have ever joined (excluding owner)
  _fileAccessUsers: Set<string>;  // non-owner users granted file access
  _leaveTimers: Map<string, ReturnType<typeof setTimeout>>;  // debounce leave broadcasts
}
const easySessions = new Map<string, EasySessionInfo>();

// Persist easy session registry so sessions survive server restarts
const EASY_REGISTRY_FILE = path.join(process.env.HOME || '/root', '.hopcode', 'easy-sessions.json');

interface EasyRegistryEntry {
  id: string;
  owner: string;
  project: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  projectDir: string;
  sharedWith?: string[];
  fileAccessUsers?: string[];
}

function saveEasyRegistry(): void {
  try {
    const entries: EasyRegistryEntry[] = [];
    for (const [id, info] of easySessions) {
      entries.push({
        id,
        owner: info.owner,
        project: info.project,
        name: info.name,
        createdAt: info.createdAt,
        lastActivity: info.lastActivity,
        projectDir: info.cp.projectDir,
        sharedWith: info.sharedWith.size > 0 ? Array.from(info.sharedWith) : undefined,
        fileAccessUsers: info._fileAccessUsers.size > 0 ? Array.from(info._fileAccessUsers) : undefined,
      });
    }
    fs.mkdirSync(path.dirname(EASY_REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(EASY_REGISTRY_FILE, JSON.stringify(entries), 'utf-8');
  } catch (e) {
    console.error('[easy] Failed to save registry:', (e as Error).message);
  }
}

function loadEasyRegistry(): void {
  try {
    const data = JSON.parse(fs.readFileSync(EASY_REGISTRY_FILE, 'utf-8'));
    if (!Array.isArray(data)) return;
    for (const entry of data as EasyRegistryEntry[]) {
      if (easySessions.has(entry.id)) continue;
      // Create a ClaudeProcess — it will load history from .easy-state.json
      const noop = () => {};
      const cp = new ClaudeProcess(entry.id, entry.projectDir, noop);
      cp.removeListener(noop);
      const info: EasySessionInfo = {
        cp,
        owner: entry.owner,
        project: entry.project,
        name: entry.name,
        createdAt: entry.createdAt,
        lastActivity: entry.lastActivity,
        connectedUsers: new Map(),
        sharedWith: new Set(entry.sharedWith || []),
        _fileAccessUsers: new Set(entry.fileAccessUsers || []),
        _leaveTimers: new Map(),
      };
      easySessions.set(entry.id, info);
    }
    if (data.length > 0) {
      console.log(`[easy] Restored ${data.length} session(s) from registry`);
    }
  } catch {}

  // Also scan for orphan sessions (created before registry was added)
  scanOrphanEasySessions();
}

function scanOrphanEasySessions(): void {
  // Collect known projectDirs from existing sessions
  const knownDirs = new Set<string>();
  for (const [, info] of easySessions) knownDirs.add(info.cp.projectDir);

  // Scan all users' coding directories
  const homeDirs = [process.env.HOME || '/root'];
  try {
    const homeBase = '/home';
    for (const u of fs.readdirSync(homeBase)) {
      const p = path.join(homeBase, u);
      try { if (fs.statSync(p).isDirectory()) homeDirs.push(p); } catch {}
    }
  } catch {}

  let recovered = 0;
  for (const home of homeDirs) {
    const codingDir = path.join(home, 'coding');
    try {
      for (const proj of fs.readdirSync(codingDir)) {
        const projDir = path.join(codingDir, proj);
        if (knownDirs.has(projDir)) continue;
        const stateFile = path.join(projDir, '.easy-state.json');
        try {
          const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
          if (!state.claudeSessionId) continue;
          // Generate a session ID for this orphan
          const id = 'easy_' + randomBytes(12).toString('hex');
          const owner = home === (process.env.HOME || '/root') ? 'root' : path.basename(home);
          const noop = () => {};
          const cp = new ClaudeProcess(id, projDir, noop);
          cp.removeListener(noop);
          const stat = fs.statSync(stateFile);
          easySessions.set(id, {
            cp, owner, project: proj, name: proj,
            createdAt: stat.birthtimeMs || stat.mtimeMs,
            lastActivity: stat.mtimeMs,
            connectedUsers: new Map(),
            sharedWith: new Set(),
            _fileAccessUsers: new Set(),
            _leaveTimers: new Map(),
          });
          knownDirs.add(projDir);
          recovered++;
        } catch {}
      }
    } catch {}
  }
  if (recovered > 0) {
    console.log(`[easy] Recovered ${recovered} orphan session(s) from disk`);
    saveEasyRegistry();
  }
}

// Load on startup
loadEasyRegistry();

function sendHtml(req: http.IncomingMessage, res: http.ServerResponse, html: string, precompressed?: Buffer): void {
  const noCacheHeaders = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0', 'Pragma': 'no-cache', 'Expires': '0', 'Vary': 'Accept-Encoding' };
  const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
  if (acceptGzip && precompressed) {
    res.writeHead(200, { ...noCacheHeaders, 'Content-Encoding': 'gzip' });
    res.end(precompressed);
  } else if (acceptGzip) {
    const gz = zlib.gzipSync(html);
    res.writeHead(200, { ...noCacheHeaders, 'Content-Encoding': 'gzip' });
    res.end(gz);
  } else {
    res.writeHead(200, noCacheHeaders);
    res.end(html);
  }
}

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
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; connect-src 'self' ws: wss: https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' data:; worker-src 'self' blob:; manifest-src 'self'; frame-src *;");

  // Only log non-routine requests
  if (req.url !== '/health' && !req.url?.startsWith('/health/diagnose') && !req.url?.startsWith('/terminal?session=')) {
    console.log(`HTTP ${req.method} ${req.url}`);
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  if (req.url === '/health/diagnose' && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    try {
      const { runDiagnose } = await import('./diagnose.js');
      const report = await runDiagnose();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(report));
    } catch (err: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Diagnose failed', detail: err.message }));
    }
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
          if (username && usersConfig[username] && password === usersConfig[username]!.password && !usersConfig[username]!.disabled) {
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

  // POST /terminal/api/guest-link — generate guest share link for an Easy Mode session
  if ((req.url || '').match(/^(?:\/terminal)?\/api\/guest-link$/) && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      req.resume();
      return;
    }
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(body);
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sessionId required' }));
          return;
        }
        // Check ownership
        const info = easySessions.get(sessionId);
        if (!info) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session not found' }));
          return;
        }
        const glAuth = getAuthInfo(req);
        if (info.owner !== glAuth.username && !isAdminUser(glAuth.username)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Only session owner can share' }));
          return;
        }
        // Generate 48h guest token
        const expiresAt = Date.now() + 48 * 60 * 60 * 1000;
        const token = makeGuestToken(sessionId, expiresAt);
        // Build URL using request host
        const proto = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers['host'] || `localhost:${PORT}`;
        const url = `${proto}://${host}/terminal/guest?session=${encodeURIComponent(sessionId)}&token=${token}&expires=${expiresAt}`;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url, expiresAt }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid request body' }));
      }
    });
    return;
  }

  // GET /terminal/api/sessions — list sessions as JSON
  if ((req.url || '').match(/^(?:\/terminal)?\/api\/sessions(\?.*)?$/) && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const auth = getAuthInfo(req);
    try {
      const ownerParam = isMultiUser && auth.username && !isAdminUser(auth.username) ? `?owner=${encodeURIComponent(auth.username)}` : '';
      const resp = await ptyFetch(`/sessions${ownerParam}`);
      const sessions: any[] = await resp.json();
      // Append Easy Mode sessions
      for (const [id, info] of easySessions) {
        if (isMultiUser && !isAdminUser(auth.username) && info.owner !== auth.username) continue;
        // Don't duplicate if PTY session with same ID exists
        if (sessions.some((s: any) => s.id === id)) continue;
        sessions.push({
          id,
          name: info.name,
          owner: info.owner,
          clientCount: 0,
          mode: 'easy',
          project: info.project,
          createdAt: info.createdAt,
        });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ currentUser: auth.username, isAdmin: isAdminUser(auth.username), sessions }));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // POST /terminal/api/sessions — create new session, return JSON
  if ((req.url || '').match(/^(?:\/terminal)?\/api\/sessions$/) && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const auth = getAuthInfo(req);
    if (!(await checkSessionLimit(auth.username))) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `You can have up to ${MAX_SESSIONS_PER_USER} sessions. Please close an existing session first.` }));
      return;
    }
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
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Failed to create session', detail: body }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
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
        const { session, name, oldName: clientOldName } = JSON.parse(Buffer.concat(chunks).toString());

        // Easy sessions: handle locally, skip PTY service
        if (easySessions.has(session)) {
          const easyInfo = easySessions.get(session);
          if (easyInfo) {
            const oldName = easyInfo.name;
            easyInfo.name = name;
            // Rename project folder if name changed
            if (clientOldName && name !== clientOldName) {
              const safeName = name.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fff]/g, '-');
              const oldDir = easyInfo.cp.projectDir;
              const newDir = path.join(path.dirname(oldDir), safeName);
              try {
                if (fs.existsSync(oldDir) && !fs.existsSync(newDir)) {
                  fs.renameSync(oldDir, newDir);
                  easyInfo.cp.projectDir = newDir;
                  easyInfo.project = safeName;
                  setupProjectTemplate(newDir, easyInfo.owner, safeName);
                }
              } catch (e) {
                console.error('Failed to rename project folder:', e);
              }
            }
            saveEasyRegistry();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
          } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, error: 'Session not found' }));
          }
          return;
        }

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

  // Share: create Cloudflare tunnel for a local port
  if ((req.url === '/terminal/share' || req.url === '/share') && req.method === 'POST') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const { port } = JSON.parse(Buffer.concat(chunks).toString());
        if (!port) throw new Error('No port');
        // Use cloudflared quick tunnel (no account needed)
        const { execFile } = await import('child_process');
        const child = execFile('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { timeout: 15000 });
        let output = '';
        let tunnelUrl = '';
        const onData = (data: Buffer) => {
          output += data.toString();
          const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
          if (match) tunnelUrl = match[0];
        };
        child.stdout?.on('data', onData);
        child.stderr?.on('data', onData);
        // Wait for tunnel URL (up to 10s)
        await new Promise<void>((resolve) => {
          const check = setInterval(() => {
            if (tunnelUrl) { clearInterval(check); resolve(); }
          }, 300);
          setTimeout(() => { clearInterval(check); resolve(); }, 10000);
        });
        if (tunnelUrl) {
          // Keep tunnel process alive — store pid for cleanup
          console.log(`[share] Tunnel created: ${tunnelUrl} → port ${port} (pid ${child.pid})`);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ url: tunnelUrl, port }));
        } else {
          child.kill();
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Tunnel creation timeout' }));
        }
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message || 'Bad request' }));
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
    const auth = getAuthInfo(req);

    // Easy sessions: handle locally, skip PTY service
    if (easySessions.has(sessionId)) {
      const easyInfo = easySessions.get(sessionId);
      if (easyInfo) {
        const isOwnerOrAdmin = isAdminUser(auth.username) || easyInfo.owner === auth.username;
        if (!isOwnerOrAdmin) {
          // Shared user — just remove from sharedWith (leave session)
          if (auth.username && easyInfo.sharedWith.has(auth.username)) {
            easyInfo.sharedWith.delete(auth.username);
            easyInfo._fileAccessUsers.delete(auth.username);
            saveEasyRegistry();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, left: true }));
            return;
          }
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Forbidden' }));
          return;
        }
        // Owner/admin — actually delete the session
        const stateFile = path.join(easyInfo.cp.projectDir, '.easy-state.json');
        try { fs.unlinkSync(stateFile); } catch {}
        easyInfo.cp.dispose();
        easySessions.delete(sessionId);
        saveEasyRegistry();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    // PTY sessions: check ownership and proxy to PTY service
    if (!isAdminUser(auth.username)) {
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

  // --- Admin API (admin only) ---

  // GET /api/admin/users — list users
  if ((req.url || '').match(/^(?:\/terminal)?\/api\/admin\/users$/) && req.method === 'GET') {
    if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    const auth = getAuthInfo(req);
    if (!isAdminUser(auth.username)) { res.writeHead(403); res.end('Forbidden'); return; }
    const users = Object.entries(usersConfig).map(([name, cfg]) => ({
      username: name,
      linuxUser: cfg.linuxUser,
      disabled: !!cfg.disabled,
      isAdmin: ADMIN_USERS.has(name),
    }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(users));
    return;
  }

  // POST /api/admin/users — create user
  if ((req.url || '').match(/^(?:\/terminal)?\/api\/admin\/users$/) && req.method === 'POST') {
    if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    const auth = getAuthInfo(req);
    if (!isAdminUser(auth.username)) { res.writeHead(403); res.end('Forbidden'); return; }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', async () => {
      try {
        const { username: newUser, password: newPass } = JSON.parse(Buffer.concat(chunks).toString());
        if (!newUser || !newPass) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Username and password required' }));
          return;
        }
        if (usersConfig[newUser]) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'User already exists' }));
          return;
        }
        // Create Linux user + setup
        const { execSync } = await import('child_process');
        try {
          execSync(`id ${newUser}`, { stdio: 'ignore' });
        } catch {
          execSync(`useradd -m -s /bin/bash ${newUser}`);
          execSync(`echo '${newUser}:${newPass.replace(/'/g, "'\\''")}' | chpasswd`);
        }
        // Create coding dir
        const home = `/home/${newUser}`;
        fs.mkdirSync(`${home}/coding`, { recursive: true });
        // Claude CLI permissions
        const claudeDir = `${home}/.claude`;
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(`${claudeDir}/settings.json`, JSON.stringify({
          permissions: {
            allow: ['Read', 'Edit', 'Write', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'Bash'],
            deny: ['Bash(rm -rf *)', 'Bash(git push --force *)', 'Bash(git reset --hard *)', 'Bash(shutdown *)', 'Bash(reboot *)', 'Bash(mkfs *)', 'Bash(userdel *)', 'Bash(passwd *)', 'Bash(chown *)']
          }
        }, null, 2) + '\n');
        // chown
        try { execSync(`chown -R ${newUser}:${newUser} ${home}/.claude ${home}/coding`); } catch {}
        // Sudoers (minimal)
        const sudoersFile = `/etc/sudoers.d/${newUser}`;
        if (!fs.existsSync(sudoersFile)) {
          fs.writeFileSync(sudoersFile, `${newUser} ALL=(ALL) NOPASSWD: /usr/sbin/nginx -t\n${newUser} ALL=(ALL) NOPASSWD: /usr/bin/systemctl reload nginx\n`);
          fs.chmodSync(sudoersFile, 0o440);
        }
        // Add to users.json
        usersConfig[newUser] = { password: newPass, linuxUser: newUser };
        saveUsersConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: (e as Error).message }));
      }
    });
    return;
  }

  // PUT /api/admin/users/:username/toggle — enable/disable user
  const toggleMatch = (req.url || '').match(/^(?:\/terminal)?\/api\/admin\/users\/([^/]+)\/toggle$/);
  if (toggleMatch && req.method === 'PUT') {
    if (!isAuthenticated(req)) { res.writeHead(401); res.end('Unauthorized'); return; }
    const auth = getAuthInfo(req);
    if (!isAdminUser(auth.username)) { res.writeHead(403); res.end('Forbidden'); return; }
    const targetUser = decodeURIComponent(toggleMatch[1]!);
    if (!usersConfig[targetUser]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
      return;
    }
    // Don't allow disabling admin users
    if (ADMIN_USERS.has(targetUser)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cannot disable admin users' }));
      return;
    }
    usersConfig[targetUser]!.disabled = !usersConfig[targetUser]!.disabled;
    saveUsersConfig();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, disabled: !!usersConfig[targetUser]!.disabled }));
    return;
  }

  // --- Recordings API (root/admin only) ---

  // GET /terminal/api/recordings — list recordings
  if ((req.url || '').match(/^(?:\/terminal)?\/api\/recordings(\?.*)?$/) && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const recAuth = getAuthInfo(req);
    if (!isAdminUser(recAuth.username) && recAuth.username !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: admin access required' }));
      return;
    }
    try {
      const files = await fs.promises.readdir(RECORDINGS_DIR).catch(() => [] as string[]);
      const recordings: { id: string; title: string; timestamp: number; size: number; duration: number }[] = [];
      for (const file of files) {
        if (!file.endsWith('.cast')) continue;
        const filePath = path.join(RECORDINGS_DIR, file);
        try {
          const stat = await fs.promises.stat(filePath);
          // Read first line to get header
          const fd = await fs.promises.open(filePath, 'r');
          const buf = Buffer.alloc(1024);
          const { bytesRead } = await fd.read(buf, 0, 1024, 0);
          await fd.close();
          const firstLine = buf.subarray(0, bytesRead).toString().split('\n')[0];
          const header = JSON.parse(firstLine!);
          // Estimate duration from last line
          let duration = 0;
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const lines = content.trimEnd().split('\n');
            if (lines.length > 1) {
              const lastEvent = JSON.parse(lines[lines.length - 1]!);
              duration = lastEvent[0] || 0;
            }
          } catch {}
          recordings.push({
            id: file.replace('.cast', ''),
            title: header.title || file.replace('.cast', ''),
            timestamp: header.timestamp || Math.floor(stat.mtimeMs / 1000),
            size: stat.size,
            duration,
          });
        } catch {}
      }
      // Sort by timestamp descending
      recordings.sort((a, b) => b.timestamp - a.timestamp);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(recordings));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
    return;
  }

  // GET /terminal/api/recordings/:id.cast — stream .cast file
  const castMatch = (req.url || '').match(/^(?:\/terminal)?\/api\/recordings\/([^/]+)\.cast$/);
  if (castMatch && req.method === 'GET') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const castAuth = getAuthInfo(req);
    if (!isAdminUser(castAuth.username) && castAuth.username !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: admin access required' }));
      return;
    }
    const id = decodeURIComponent(castMatch[1]!);
    // Sanitize: only allow alphanumeric, underscore, dash
    if (!/^[\w-]+$/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid id' }));
      return;
    }
    const filePath = path.join(RECORDINGS_DIR, `${id}.cast`);
    try {
      const stat = await fs.promises.stat(filePath);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(filePath);
      stream.pipe(res);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recording not found' }));
    }
    return;
  }

  // DELETE /terminal/api/recordings/:id — delete recording
  const deleteRecMatch = (req.url || '').match(/^(?:\/terminal)?\/api\/recordings\/([^/]+)$/);
  if (deleteRecMatch && req.method === 'DELETE') {
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }
    const delRecAuth = getAuthInfo(req);
    if (!isAdminUser(delRecAuth.username) && delRecAuth.username !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Forbidden: admin access required' }));
      return;
    }
    const id = decodeURIComponent(deleteRecMatch[1]!);
    if (!/^[\w-]+$/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid id' }));
      return;
    }
    const filePath = path.join(RECORDINGS_DIR, `${id}.cast`);
    try {
      await fs.promises.unlink(filePath);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Recording not found' }));
    }
    return;
  }

  // --- Serve static PWA assets (no auth required) ---
  const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
  const pathname = parsedUrl.pathname;
  // Strip /terminal prefix so PWA assets work behind reverse proxy
  const assetPath = pathname.startsWith('/terminal/') ? pathname.slice('/terminal'.length) : pathname;

  // Serve vendor files from node_modules (xterm, etc.)
  if (assetPath.startsWith('/vendor/')) {
    const VENDOR_MAP: Record<string, string> = {
      '/vendor/xterm.css': 'node_modules/xterm/css/xterm.css',
      '/vendor/xterm.js': 'node_modules/xterm/lib/xterm.js',
      '/vendor/xterm-addon-fit.js': 'node_modules/xterm-addon-fit/lib/xterm-addon-fit.js',
      '/vendor/xterm-addon-webgl.js': 'node_modules/xterm-addon-webgl/lib/xterm-addon-webgl.js',
    };
    const vendorFile = VENDOR_MAP[assetPath];
    if (vendorFile) {
      // Serve with gzip if not cached yet
      if (!vendorGzCache.has(assetPath)) {
        try {
          const data = await fs.promises.readFile(path.join(__dirname, '..', vendorFile));
          vendorGzCache.set(assetPath, { raw: data, gz: zlib.gzipSync(data) });
        } catch {
          res.writeHead(404); res.end('Not found'); return;
        }
      }
      const cached = vendorGzCache.get(assetPath)!;
      const ext = path.extname(assetPath);
      const ct = ext === '.css' ? 'text/css' : 'application/javascript';
      const acceptGzip = (req.headers['accept-encoding'] || '').includes('gzip');
      if (acceptGzip) {
        res.writeHead(200, { 'Content-Type': ct, 'Content-Encoding': 'gzip', 'Cache-Control': 'public, max-age=604800, immutable', 'Vary': 'Accept-Encoding' });
        res.end(cached.gz);
      } else {
        res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'public, max-age=604800, immutable' });
        res.end(cached.raw);
      }
      return;
    }
  }

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

  // --- Guest route (before auth) ---
  if (pathname === '/terminal/guest' || pathname === '/guest') {
    const guestSession = parsedUrl.searchParams.get('session') || '';
    const guestToken = parsedUrl.searchParams.get('token') || '';
    const guestExpires = parsedUrl.searchParams.get('expires') || '';
    const langCookie = (req.headers.cookie || '').match(/hopcode-lang=(\w+)/);
    const lang = (langCookie && langCookie[1]) ? langCookie[1] : ((req.headers['accept-language'] || '').toLowerCase().startsWith('zh') ? 'zh' : 'en');

    if (!guestSession || !guestToken || !guestExpires) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getGuestErrorHtml(t(lang, 'guest.invalid')));
      return;
    }
    if (!verifyGuestToken(guestSession, guestToken, guestExpires)) {
      const expiresAt = parseInt(guestExpires, 10);
      const isExpired = !isNaN(expiresAt) && Date.now() > expiresAt;
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(getGuestErrorHtml(t(lang, isExpired ? 'guest.expired' : 'guest.invalid')));
      return;
    }

    // If user is already authenticated, redirect to the session as logged-in user
    const guestAuth = getAuthInfo(req);
    if (guestAuth.authenticated && guestAuth.username && !guestAuth.username.startsWith('guest_')) {
      // Add user to session's sharedWith so they have access
      const easySession = easySessions.get(guestSession);
      if (easySession) {
        easySession.sharedWith.add(guestAuth.username);
        easySession._fileAccessUsers.add(guestAuth.username);
      }
      const sessionProject = easySession?.project || '';
      const redirectUrl = `/terminal/easy?session=${encodeURIComponent(guestSession)}${sessionProject ? '&project=' + encodeURIComponent(sessionProject) : ''}`;
      res.writeHead(302, { 'Location': redirectUrl });
      res.end();
      return;
    }

    // Show landing page with login vs guest choice (unless ?join=guest)
    const joinMode = parsedUrl.searchParams.get('join');
    if (joinMode !== 'guest') {
      // Get session name for display
      const easySession = easySessions.get(guestSession);
      const sessionName = easySession?.name || guestSession;
      const ownerName = easySession?.owner || '';

      // Build the guest URL (same URL + join=guest)
      const guestUrl = `${pathname}?session=${encodeURIComponent(guestSession)}&token=${encodeURIComponent(guestToken)}&expires=${encodeURIComponent(guestExpires)}&join=guest`;
      // Build login URL that returns to the session after auth
      const returnUrl = `/terminal/easy?session=${encodeURIComponent(guestSession)}${easySession?.project ? '&project=' + encodeURIComponent(easySession.project) : ''}`;

      sendHtml(req, res, getGuestLandingHtml(lang, sessionName, ownerName, guestUrl, returnUrl));
      return;
    }

    // join=guest — serve guest Easy Mode page (can chat, no menu/files/voice)
    const guestAuthInfo: AuthInfo = { authenticated: true, username: 'guest_' + randomBytes(4).toString('hex'), linuxUser: '' };
    const guestHtml = getEasyModeHtml(guestAuthInfo, { guestMode: true, guestSessionId: guestSession, guestToken, guestExpires });
    sendHtml(req, res, guestHtml);
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

  // --- PDF viewer (public, wraps PDF in PDF.js for mobile browser support) ---
  if ((pathname === '/terminal/pdf-viewer' || pathname === '/pdf-viewer') && req.method === 'GET') {
    const pdfUrl = parsedUrl.searchParams.get('url') || '';
    if (!pdfUrl) { res.writeHead(400); res.end('Missing url param'); return; }
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#525659;overflow:hidden;font-family:-apple-system,system-ui,sans-serif}
#page-container{overflow:auto;height:100vh;padding:8px 0 56px;-webkit-overflow-scrolling:touch}
canvas{display:block;margin:4px auto;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.bar{position:fixed;bottom:0;left:0;right:0;background:rgba(50,54,57,.97);padding:8px 12px;display:flex;align-items:center;justify-content:center;gap:8px;z-index:10}
.bar button{background:#fff;border:none;border-radius:6px;padding:6px 12px;font-size:14px;cursor:pointer;min-width:36px}
.bar button:active{background:#ddd}
.bar span{color:#fff;font-size:13px;white-space:nowrap}
</style></head><body>
<div id="page-container"></div>
<div class="bar">
  <button id="prev">&#8592;</button>
  <span id="info">Loading...</span>
  <button id="next">&#8594;</button>
  <button id="zout">&minus;</button>
  <span id="zlabel">fit</span>
  <button id="zin">+</button>
</div>
<script type="module">
import{getDocument,GlobalWorkerOptions}from"https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.min.mjs";
GlobalWorkerOptions.workerSrc="https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.2.67/pdf.worker.min.mjs";
var pdfUrl=${JSON.stringify(pdfUrl)};
var container=document.getElementById("page-container");
var pdf=null,pageNum=1,scale=0,fitScale=1;
async function load(){
  pdf=await getDocument(pdfUrl).promise;
  // fit-width scale
  var p=await pdf.getPage(1);
  var vp=p.getViewport({scale:1});
  fitScale=Math.min((window.innerWidth-16)/vp.width,3);
  scale=fitScale;
  render();
}
async function render(){
  var page=await pdf.getPage(pageNum);
  var vp=page.getViewport({scale:scale});
  var c=document.createElement("canvas");c.width=vp.width;c.height=vp.height;
  container.innerHTML="";container.appendChild(c);
  await page.render({canvasContext:c.getContext("2d"),viewport:vp}).promise;
  document.getElementById("info").textContent=pageNum+"/"+pdf.numPages;
  document.getElementById("zlabel").textContent=Math.round(scale/fitScale*100)+"%";
}
document.getElementById("prev").onclick=function(){if(pageNum>1){pageNum--;render()}};
document.getElementById("next").onclick=function(){if(pdf&&pageNum<pdf.numPages){pageNum++;render()}};
document.getElementById("zin").onclick=function(){scale=Math.min(scale*1.25,fitScale*5);render()};
document.getElementById("zout").onclick=function(){scale=Math.max(scale/1.25,fitScale*0.25);render()};
load().catch(function(e){container.innerHTML='<p style="color:#fff;text-align:center;padding:40px">Failed to load PDF: '+e.message+'</p>'});
<\/script></body></html>`);
    return;
  }

  // --- /serve/ route (public, no auth required) ---
  // Static file serving for Easy Mode projects — moved before auth so guests/anonymous can access previews
  const serveMatchPre = pathname.match(/^\/(terminal\/)?serve\/([^/]+)(\/.*)?$/);
  if (serveMatchPre && (req.method === 'GET' || req.method === 'HEAD')) {
    // Allow embedding in iframe (preview panel)
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    const project = decodeURIComponent(serveMatchPre[2]!);
    const filePart = decodeURIComponent(serveMatchPre[3] || '/index.html');

    // Find project directory: collect all candidates
    const candidates: string[] = [];
    // 1. All easy session dirs matching this project name
    for (const [, eInfo] of easySessions) {
      if (eInfo.project === project || path.basename(eInfo.cp.projectDir) === project) {
        if (candidates.indexOf(eInfo.cp.projectDir) === -1) candidates.push(eInfo.cp.projectDir);
      }
    }
    // 2. All users' coding dirs
    try {
      for (const u of fs.readdirSync('/home')) {
        const c = path.join('/home', u, 'coding', project);
        if (candidates.indexOf(c) === -1) candidates.push(c);
      }
    } catch {}
    // 3. Root's coding dir
    const rootCandidate = path.join(process.env.HOME || '/root', 'coding', project);
    if (candidates.indexOf(rootCandidate) === -1) candidates.push(rootCandidate);

    // Find first candidate that has the requested file
    let projectRoot = candidates[0];
    if (projectRoot) {
      for (const c of candidates) {
        const testPath = path.resolve(c, '.' + filePart);
        if (testPath.startsWith(c + '/') || testPath === c) {
          try { fs.accessSync(testPath); projectRoot = c; break; } catch {}
        }
      }
      const filePath = path.resolve(projectRoot, '.' + filePart);

      // Security: if workspace/ exists, restrict serving to workspace/ only
      const wsExists = (() => { try { fs.statSync(path.join(projectRoot, 'workspace')); return true; } catch { return false; } })();
      const serveRoot = wsExists ? path.join(projectRoot, 'workspace') : projectRoot;
      if (!filePath.startsWith(serveRoot + '/') && filePath !== serveRoot) {
        if (wsExists && filePart && !filePart.startsWith('/workspace/')) {
          const wsFilePath = path.join(projectRoot, 'workspace', '.' + filePart);
          try {
            fs.accessSync(wsFilePath);
            const newUrl = '/serve/' + encodeURIComponent(project) + '/workspace' + filePart + (parsedUrl.search || '');
            res.writeHead(302, { 'Location': newUrl }); res.end(); return;
          } catch {}
        }
        res.writeHead(403); res.end('Forbidden'); return;
      }

      try {
        const stat = await fs.promises.stat(filePath);
        if (stat.isDirectory()) {
          const indexPath = path.join(filePath, 'index.html');
          try {
            await fs.promises.access(indexPath);
            res.writeHead(302, { 'Location': pathname + (pathname.endsWith('/') ? '' : '/') + 'index.html' });
            res.end(); return;
          } catch {
            res.writeHead(404); res.end('Not found'); return;
          }
        }
        const wantRender = parsedUrl.searchParams.get('render') === '1';
        const ext = path.extname(filePath).toLowerCase();
        if (wantRender && ext === '.csv') {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const rows = raw.split('\n').filter(r => r.trim());
          let table = '<table>';
          for (let i = 0; i < rows.length; i++) {
            const cells = rows[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
            const tag = i === 0 ? 'th' : 'td';
            table += '<tr>' + cells.map(c => `<${tag}>${c.replace(/</g,'&lt;')}</${tag}>`).join('') + '</tr>';
          }
          table += '</table>';
          const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;margin:16px;color:#1d1d1f}table{border-collapse:collapse;width:100%}th,td{border:1px solid #d2d2d7;padding:8px 12px;text-align:left;font-size:14px}th{background:#f5f5f7;font-weight:600}tr:nth-child(even){background:#fafafa}</style></head><body>${table}</body></html>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(html);
        } else if (wantRender && ext === '.md') {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const escHtml = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
          const lines = raw.split('\n');
          let html = '';
          let inList = false;
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { if (inList) { html += '</ul>'; inList = false; } html += '<br>'; continue; }
            if (trimmed.startsWith('# ')) { html += `<h1>${escHtml(trimmed.slice(2))}</h1>`; continue; }
            if (trimmed.startsWith('## ')) { html += `<h2>${escHtml(trimmed.slice(3))}</h2>`; continue; }
            if (trimmed.startsWith('### ')) { html += `<h3>${escHtml(trimmed.slice(4))}</h3>`; continue; }
            if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
              if (!inList) { html += '<ul>'; inList = true; }
              html += `<li>${escHtml(trimmed.slice(2))}</li>`;
              continue;
            }
            if (inList) { html += '</ul>'; inList = false; }
            let p = escHtml(trimmed);
            p = p.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
            p = p.replace(/\*(.+?)\*/g, '<em>$1</em>');
            p = p.replace(/`(.+?)`/g, '<code>$1</code>');
            p = p.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
            html += `<p>${p}</p>`;
          }
          if (inList) html += '</ul>';
          const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;margin:16px;color:#1d1d1f;line-height:1.6;max-width:720px}h1,h2,h3{margin:1em 0 .5em}code{background:#f5f5f7;padding:2px 6px;border-radius:4px;font-size:13px}a{color:#007aff}ul{padding-left:20px}li{margin:4px 0}</style></head><body>${html}</body></html>`;
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
          res.end(page);
        } else {
          const mime = getMimeType(filePath);
          res.writeHead(200, {
            'Content-Type': mime + (mime.startsWith('text/') ? '; charset=utf-8' : ''),
            'Cache-Control': 'no-cache',
          });
          fs.createReadStream(filePath).pipe(res);
        }
      } catch {
        res.writeHead(404); res.end('Not found');
      }
      return;
    }
    res.writeHead(404); res.end('Not found');
    return;
  }

  // Check authentication
  const auth = getAuthInfo(req);
  if (!auth.authenticated) {
    if (pathname !== '/' && pathname !== '/terminal' && pathname !== '/terminal/') {
      console.log(`[auth-fail] ${req.method} ${pathname} — no valid cookie`);
    }
    sendHtml(req, res, getLoginHtml());
    return;
  }

  // --- Authenticated routes below ---

  // --- File browser API ---

  if ((pathname === '/terminal/mkdir' || pathname === '/mkdir') && req.method === 'POST') {
    // Drain any request body
    req.resume();
    try {
      // Check easy session file access for shared users
      const mkSid = parsedUrl.searchParams.get('session');
      const mkEasy = mkSid ? easySessions.get(mkSid) : null;
      const mkEasyAccess = mkEasy && (mkEasy.owner === auth.username || isAdminUser(auth.username) || mkEasy._fileAccessUsers.has(auth.username || ''));
      const mkEasyDir = mkEasyAccess ? mkEasy.cp.projectDir : '';

      let parentDir: string;
      if (mkEasyAccess && mkEasyDir) {
        const resolved = path.resolve('/', parsedUrl.searchParams.get('path') || '/');
        parentDir = (resolved.startsWith(mkEasyDir + '/') || resolved === mkEasyDir) ? resolved : resolveSafePath(parsedUrl.searchParams.get('path') || '/', auth.linuxUser);
      } else {
        parentDir = resolveSafePath(parsedUrl.searchParams.get('path') || '/', auth.linuxUser);
      }

      const folderName = (parsedUrl.searchParams.get('name') || '').trim();
      if (!folderName || folderName.includes('/') || folderName.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid folder name' }));
        return;
      }
      const dirStat = await fs.promises.stat(parentDir);
      if (!dirStat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Parent path is not a directory' }));
        return;
      }
      const posixUser = (!mkEasyAccess && auth.linuxUser) ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser && !checkPosixAccess(dirStat, posixUser, 'write')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Permission denied' }));
        return;
      }
      const existsMode = parsedUrl.searchParams.get('exists') || 'rename'; // 'error' | 'rename' | 'skip'
      const target = path.join(parentDir, folderName);
      let actualName = folderName;
      let newDir = target;
      let alreadyExists = false;
      try { await fs.promises.access(target); alreadyExists = true; } catch {}
      if (alreadyExists) {
        if (existsMode === 'skip') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, path: target, name: folderName, existed: true }));
          return;
        }
        if (existsMode === 'error') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Folder already exists' }));
          return;
        }
        // rename mode: auto-rename
        actualName = await autoRename(parentDir, folderName, true);
        newDir = path.join(parentDir, actualName);
      }
      await fs.promises.mkdir(newDir, { recursive: false });
      if (posixUser) {
        try { fs.chownSync(newDir, posixUser.uid, posixUser.gid); } catch {}
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: newDir, name: actualName }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Failed to create folder' }));
    }
    return;
  }

  if ((pathname === '/terminal/file-upload' || pathname === '/file-upload') && req.method === 'POST') {
    try {
      let requestedPath = parsedUrl.searchParams.get('path') || '';
      let targetDir: string;
      if (!requestedPath) {
        // Resolve to PTY session CWD
        const sid = parsedUrl.searchParams.get('session') || 'default';
        try {
          const cwdResp = await ptyFetch(`/sessions/${encodeURIComponent(sid)}/cwd`);
          if (cwdResp.ok) {
            const cwdData = await cwdResp.json() as { cwd: string };
            targetDir = resolveSafePath(cwdData.cwd, auth.linuxUser);
          } else {
            targetDir = resolveSafePath('/', auth.linuxUser);
          }
        } catch {
          targetDir = resolveSafePath('/', auth.linuxUser);
        }
      } else {
        targetDir = resolveSafePath(requestedPath, auth.linuxUser);
      }
      const rawFilename = req.headers['x-filename'] as string;
      let filename: string;
      try { filename = decodeURIComponent(rawFilename); } catch { filename = rawFilename; }
      if (!filename || filename.includes('/') || filename.includes('\\')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing X-Filename header' }));
        return;
      }

      // Check Easy Mode session file access — skip posix check if authorized
      const uploadSid = parsedUrl.searchParams.get('session') || '';
      const uploadEasyInfo = uploadSid ? easySessions.get(uploadSid) : null;
      const uploadEasyAccess = uploadEasyInfo && (
        uploadEasyInfo.owner === auth.username ||
        isAdminUser(auth.username) ||
        uploadEasyInfo._fileAccessUsers.has(auth.username || '')
      );

      // Verify target directory exists and is a directory
      const dirStat = await fs.promises.stat(targetDir);
      if (!dirStat.isDirectory()) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Target path is not a directory' }));
        return;
      }

      // Permission check: can user write to this directory?
      // Skip posix check for Easy Mode sessions where user has file access
      const posixUser = auth.linuxUser ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser && !uploadEasyAccess && !checkPosixAccess(dirStat, posixUser, 'write')) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Permission denied' }));
        return;
      }

      // Read raw body (100MB limit)
      const MAX_UPLOAD = 100 * 1024 * 1024;
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of req) {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        totalSize += buf.length;
        if (totalSize > MAX_UPLOAD) {
          req.destroy();
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'File too large (max 100MB)' }));
          return;
        }
        chunks.push(buf);
      }
      const body = Buffer.concat(chunks);

      const actualName = await autoRename(targetDir, filename, false);
      const filePath = path.join(targetDir, actualName);
      await fs.promises.writeFile(filePath, body);

      // Multi-user: chown file to appropriate uid/gid
      // For Easy Mode uploads, use the session owner's uid/gid so files are owned correctly
      const chownUser = uploadEasyAccess && uploadEasyInfo
        ? getUserPosixInfo(uploadEasyInfo.owner)
        : posixUser;
      if (chownUser) {
        try { fs.chownSync(filePath, chownUser.uid, chownUser.gid); } catch {}
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: filePath, name: actualName }));
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

      // Check if this is an Easy Mode session and user has file access
      const easyInfo = easySessions.get(sid);
      const isEasyWithAccess = easyInfo && (
        easyInfo.owner === auth.username ||
        isAdminUser(auth.username) ||
        easyInfo._fileAccessUsers.has(auth.username || '')
      );
      const easyProjectDir = isEasyWithAccess ? easyInfo.cp.projectDir : '';

      // Determine user's home directory for fallback
      const userHome = getUserHome(auth.linuxUser);

      let requestedPath = parsedUrl.searchParams.get('path') || '';
      let dirPath: string;

      // For Easy Mode sessions with file access, lock to workspace/ subdir (output only)
      if (isEasyWithAccess && easyProjectDir) {
        const workspaceDir = path.join(easyProjectDir, 'workspace');
        // Use workspace/ if it exists, otherwise fall back to project root (old projects)
        let easyRoot = easyProjectDir;
        try { fs.statSync(workspaceDir); easyRoot = workspaceDir; } catch {}
        if (!requestedPath) {
          dirPath = easyRoot;
        } else {
          const resolved = path.resolve('/', requestedPath);
          // Allow paths within the workspace dir; clamp others
          if (resolved.startsWith(easyRoot + '/') || resolved === easyRoot) {
            dirPath = resolved;
          } else if (isAdminLinuxUser(auth.linuxUser)) {
            dirPath = resolved;
          } else {
            dirPath = easyRoot;
          }
        }
      } else if (!requestedPath) {
        // Get CWD from PTY service
        try {
          const cwdResp = await ptyFetch(`/sessions/${encodeURIComponent(sid)}/cwd`);
          if (cwdResp.ok) {
            const cwdData = await cwdResp.json() as { cwd: string };
            // Sandbox CWD to user's home for non-root users
            dirPath = resolveSafePath(cwdData.cwd, auth.linuxUser);
          } else {
            dirPath = userHome;
          }
        } catch {
          dirPath = userHome;
        }
      } else {
        dirPath = resolveSafePath(requestedPath, auth.linuxUser);
      }

      // Get CWD for response (may differ from dirPath)
      let sessionCwd = dirPath;
      if (requestedPath && !isEasyWithAccess) {
        try {
          const cwdResp = await ptyFetch(`/sessions/${encodeURIComponent(sid)}/cwd`);
          if (cwdResp.ok) {
            const cwdData = await cwdResp.json() as { cwd: string };
            sessionCwd = cwdData.cwd;
          }
        } catch {}
      }

      // Permission check: skip POSIX check for Easy Mode shared users (files owned by session owner)
      const skipPosixCheck = !!isEasyWithAccess;
      const posixUser = (!skipPosixCheck && auth.linuxUser) ? getUserPosixInfo(auth.linuxUser) : null;
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
        if (!showHidden && entry.name.toUpperCase() === 'CLAUDE.MD') continue;
        const fullPath = path.join(dirPath, entry.name);
        let stat;
        try { stat = await fs.promises.stat(fullPath); } catch { continue; }
        // Filter: only show entries the user can at least stat (skip for easy shared users)
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

      // Check easy session file access for shared users
      const dlSid = parsedUrl.searchParams.get('session');
      const dlEasy = dlSid ? easySessions.get(dlSid) : null;
      const dlEasyAccess = dlEasy && (dlEasy.owner === auth.username || isAdminUser(auth.username) || dlEasy._fileAccessUsers.has(auth.username || ''));
      const dlEasyDir = dlEasyAccess ? dlEasy.cp.projectDir : '';

      let filePath: string;
      if (dlEasyAccess && dlEasyDir) {
        const resolved = path.resolve('/', requestedPath);
        filePath = (resolved.startsWith(dlEasyDir + '/') || resolved === dlEasyDir) ? resolved : resolveSafePath(requestedPath, auth.linuxUser);
      } else {
        filePath = resolveSafePath(requestedPath, auth.linuxUser);
      }

      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) { res.writeHead(400); res.end('Cannot download directory'); return; }

      const posixUser = (!dlEasyAccess && auth.linuxUser) ? getUserPosixInfo(auth.linuxUser) : null;
      if (posixUser && !checkPosixAccess(stat, posixUser, 'read')) {
        res.writeHead(403); res.end('Permission denied'); return;
      }

      const mime = getMimeType(filePath);
      const fileName = path.basename(filePath);
      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(fileName),
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
    res.removeHeader('X-Frame-Options');
    res.removeHeader('Content-Security-Policy');
    try {
      const requestedPath = parsedUrl.searchParams.get('path') || '';
      if (!requestedPath) { res.writeHead(400); res.end('Path required'); return; }

      // Check easy session file access for shared users
      const pvSid = parsedUrl.searchParams.get('session');
      const pvEasy = pvSid ? easySessions.get(pvSid) : null;
      const pvEasyAccess = pvEasy && (pvEasy.owner === auth.username || isAdminUser(auth.username) || pvEasy._fileAccessUsers.has(auth.username || ''));
      const pvEasyDir = pvEasyAccess ? pvEasy.cp.projectDir : '';

      let filePath: string;
      if (pvEasyAccess && pvEasyDir) {
        const resolved = path.resolve('/', requestedPath);
        filePath = (resolved.startsWith(pvEasyDir + '/') || resolved === pvEasyDir) ? resolved : resolveSafePath(requestedPath, auth.linuxUser);
      } else {
        filePath = resolveSafePath(requestedPath, auth.linuxUser);
      }

      const stat = await fs.promises.stat(filePath);
      if (stat.isDirectory()) { res.writeHead(400); res.end('Cannot preview directory'); return; }

      const posixUser = (!pvEasyAccess && auth.linuxUser) ? getUserPosixInfo(auth.linuxUser) : null;
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

  // --- TTS endpoint ---
  if ((pathname === '/terminal/tts' || pathname === '/tts') && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const { text } = JSON.parse(body);
        if (!text) { res.writeHead(400); res.end('Missing text'); return; }
        const pcm = await synthesizeTts(text);
        const wav = pcmToWav(pcm);
        res.writeHead(200, {
          'Content-Type': 'audio/wav',
          'Content-Length': wav.length.toString(),
          'Cache-Control': 'no-cache',
        });
        res.end(wav);
      } catch (e: any) {
        console.error('TTS error:', e.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
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

    const MAX_UPLOAD = 100 * 1024 * 1024;
    const chunks: Buffer[] = [];
    let totalSize = 0;
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_UPLOAD && !aborted) {
        aborted = true;
        req.destroy();
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'File too large (max 100MB)' }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', async () => {
      if (aborted) return;
      try {
        await fs.promises.mkdir(userDir, { recursive: true, mode: 0o755 });
        await fs.promises.writeFile(filePath, Buffer.concat(chunks));
        // Multi-user: chown directory and file to user's uid/gid
        const posixUser = auth.linuxUser ? getUserPosixInfo(auth.linuxUser) : null;
        if (posixUser) {
          try { fs.chownSync(userDir, posixUser.uid, posixUser.gid); } catch {}
          try { fs.chownSync(path.join(userHome, '.hopcode'), posixUser.uid, posixUser.gid); } catch {}
          try { fs.chownSync(filePath, posixUser.uid, posixUser.gid); } catch {}
        }
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

  // Easy Mode: /terminal/easy, /easy, or any path with session=easy_*
  const easyUrlCheck = new URL(req.url || '/', `http://${req.headers.host}`);
  const easySessionCheck = easyUrlCheck.searchParams.get('session');
  const isProForced = easyUrlCheck.searchParams.get('mode') === 'pro';
  const isEasyRoute = !isProForced && (pathname === '/terminal/easy' || pathname === '/easy' ||
    (easySessionCheck && easySessionCheck.startsWith('easy_') && pathname !== '/terminal'));
  if (isEasyRoute) {
    if (!easySessionCheck) {
      // Check session limit before auto-creating
      if (!(await checkSessionLimit(auth.username))) {
        const limitHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Session Limit</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}.card{background:#fff;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}h2{margin:0 0 12px;font-size:20px}p{margin:0 0 24px;color:#86868b;font-size:15px;line-height:1.5}a{display:inline-block;padding:10px 24px;background:#007aff;color:#fff;border-radius:8px;text-decoration:none;font-size:15px}a:hover{background:#0066d6}</style></head><body><div class="card"><h2>Session Limit Reached</h2><p>You can have up to ${MAX_SESSIONS_PER_USER} sessions at the same time. Please close an existing session before creating a new one.</p><a href="/terminal">Back to Sessions</a></div></body></html>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(limitHtml);
        return;
      }
      // Auto-create easy session — no PTY needed, just project folder + ClaudeProcess
      const id = 'easy_' + randomBytes(12).toString('hex');
      const now = new Date();
      const dateSuffix = String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0')
        + '-' + String(now.getHours()).padStart(2, '0') + String(now.getMinutes()).padStart(2, '0');
      const projectName = 'project-' + dateSuffix + randomBytes(1).toString('hex').charAt(0);
      try {
        const homeDir = (!auth.linuxUser || auth.linuxUser === 'root') ? (process.env.HOME || '/root') : `/home/${auth.linuxUser}`;
        const projectDir = `${homeDir}/coding/${projectName}`;
        try {
          setupProjectTemplate(projectDir, auth.linuxUser || auth.username, projectName);
          console.log(`[easy] Project template created: ${projectDir}/CLAUDE.md`);
        } catch (e) {
          console.error('[easy] Failed to setup project template:', e);
        }
      } catch (e) {
        console.error('Failed to create easy session:', e);
      }
      res.writeHead(302, { 'Location': '/terminal/easy?session=' + encodeURIComponent(id) + '&project=' + encodeURIComponent(projectName) });
      res.end();
      return;
    }
    const cacheKey = auth.username || '_default';
    const easyHtml = getEasyModeHtml(auth);
    if (!easyHtmlGzCache.has(cacheKey)) {
      easyHtmlGzCache.set(cacheKey, zlib.gzipSync(easyHtml));
    }
    sendHtml(req, res, easyHtml, easyHtmlGzCache.get(cacheKey));
    return;
  }

  // Admin page: /terminal/admin (admin only)
  if (pathname === '/terminal/admin' || pathname === '/admin') {
    if (!isAdminUser(auth.username)) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: admin access required');
      return;
    }
    sendHtml(req, res, getAdminHtml());
    return;
  }

  // Recordings page: /terminal/recordings (root/admin only)
  if (pathname === '/terminal/recordings' || pathname === '/recordings') {
    if (!isAdminUser(auth.username) && auth.username !== 'admin') {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden: admin access required');
      return;
    }
    sendHtml(req, res, getRecordingsHtml());
    return;
  }

  // Everything goes through /terminal so the reverse proxy forwards it
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  const action = url.searchParams.get('action');
  const sessionId = url.searchParams.get('session');

  // Create new session: /terminal?action=new — proxy to PTY service
  if (action === 'new') {
    if (!(await checkSessionLimit(auth.username))) {
      const limitHtml = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Session Limit</title><style>body{font-family:-apple-system,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f7;color:#1d1d1f}.card{background:#fff;border-radius:16px;padding:40px;max-width:400px;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.08)}h2{margin:0 0 12px;font-size:20px}p{margin:0 0 24px;color:#86868b;font-size:15px;line-height:1.5}a{display:inline-block;padding:10px 24px;background:#007aff;color:#fff;border-radius:8px;text-decoration:none;font-size:15px}a:hover{background:#0066d6}</style></head><body><div class="card"><h2>Session Limit Reached</h2><p>You can have up to ${MAX_SESSIONS_PER_USER} sessions at the same time. Please close an existing session before creating a new one.</p><a href="/terminal">Back to Sessions</a></div></body></html>`;
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(limitHtml);
      return;
    }
    const id = 'sess_' + randomBytes(12).toString('hex');
    const proNow = new Date();
    const proSessionName = 'session-' + String(proNow.getMonth() + 1).padStart(2, '0') + String(proNow.getDate()).padStart(2, '0')
      + '-' + String(proNow.getHours()).padStart(2, '0') + String(proNow.getMinutes()).padStart(2, '0');
    try {
      const sessionBody: Record<string, string> = { id, name: proSessionName, owner: auth.username };
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
    sendHtml(req, res, indexHtml, indexHtmlGz);
    return;
  }

  // Session chooser (default for /terminal with no params, or any other path)
  sendHtml(req, res, await buildSessionsHtml(auth.username));
});

// Terminal WebSocket server — proxies to PTY service
const terminalWss = new WebSocketServer({ noServer: true });
terminalWss.on('connection', (clientWs: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';
  const wsAuth = getAuthInfo(req);
  // Connect to PTY service WebSocket, include owner for verification (root bypasses)
  const ownerQuery = isMultiUser && !isAdminUser(wsAuth.username) ? `?owner=${encodeURIComponent(wsAuth.username)}` : '';
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

  // PTY service -> browser: transparent forward + feed to easy processor
  ptyWs.on('message', (data: Buffer | string, isBinary: boolean) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data, { binary: isBinary });
    }
  });

  // Browser -> PTY service: transparent forward + notify easy processor
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

  ptyWs.on('close', (code) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      // If PTY closed unexpectedly (not from client disconnect), tell client session is gone
      if (code !== 1000) {
        try { clientWs.send(JSON.stringify({ type: 'session_exit' })); } catch {}
      }
      clientWs.close();
    }
  });

  ptyWs.on('error', (err) => {
    console.error(`PTY proxy error for ${sessionId}:`, err.message);
    if (clientWs.readyState === WebSocket.OPEN) {
      // Tell client session is gone so it stops retrying
      try { clientWs.send(JSON.stringify({ type: 'session_exit' })); } catch {}
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

// Easy Mode WebSocket server — claude -p structured JSON protocol
const easyWss = new WebSocketServer({ noServer: true });
easyWss.on('connection', (clientWs: WebSocket, req: http.IncomingMessage) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('session') || 'default';
  const projectParam = url.searchParams.get('project') || '';
  const isGuestWs = !!(req as any)._guestMode;
  const wsAuth = isGuestWs
    ? { authenticated: true, username: (req as any)._guestUsername || 'guest', linuxUser: '' }
    : getAuthInfo(req);

  // Guest: session must already exist
  if (isGuestWs && !easySessions.has(sessionId)) {
    clientWs.close(4004, 'Session not found');
    return;
  }

  // Get or create ClaudeProcess for this session
  let info = easySessions.get(sessionId);
  let cp: ClaudeProcess;
  // Per-client message sender
  const sendToClient = (msg: EasyServerMessage) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(msg));
    }
  };

  if (!info) {
    // New session — determine project directory from connecting user
    const homeDir = (!wsAuth.linuxUser || wsAuth.linuxUser === 'root')
      ? (process.env.HOME || '/root')
      : `/home/${wsAuth.linuxUser}`;
    const projectDir = projectParam
      ? `${homeDir}/coding/${projectParam}`
      : `${homeDir}`;
    cp = new ClaudeProcess(sessionId, projectDir, sendToClient);
    info = { cp, owner: wsAuth.username, project: projectParam, name: projectParam || sessionId, createdAt: Date.now(), lastActivity: Date.now(), connectedUsers: new Map(), sharedWith: new Set(), _fileAccessUsers: new Set(), _leaveTimers: new Map() };
    easySessions.set(sessionId, info);
    saveEasyRegistry();
    console.log(`[easy] Created ClaudeProcess for ${sessionId} in ${projectDir}`);
  } else {
    // Add this client as an additional listener (supports multiple browser tabs)
    cp = info.cp;
    cp.addListener(sendToClient);
    console.log(`[easy] Reconnected to ClaudeProcess for ${sessionId}`);
  }

  // Track connected user
  const connUser = wsAuth.username || 'anonymous';
  // Cancel any pending leave timer for this user (reconnect before timeout)
  const pendingLeave = info._leaveTimers.get(connUser);
  if (pendingLeave) {
    clearTimeout(pendingLeave);
    info._leaveTimers.delete(connUser);
  }
  const wasConnected = !!pendingLeave || (info.connectedUsers.has(connUser) && info.connectedUsers.get(connUser)!.size > 0);
  if (!info.connectedUsers.has(connUser)) {
    info.connectedUsers.set(connUser, new Set());
  }
  info.connectedUsers.get(connUser)!.add(clientWs);

  // Broadcast updated participants list to all connected clients
  // Includes all known users (owner + sharedWith) with online/offline status
  const broadcastParticipants = () => {
    const onlineSet = new Set(info!.connectedUsers.keys());
    // Collect all known users: owner first, then others
    const allUsers = new Set<string>();
    allUsers.add(info!.owner);
    for (const u of onlineSet) allUsers.add(u);
    for (const u of info!.sharedWith) allUsers.add(u);
    const users = Array.from(allUsers).map(name => ({ name, online: onlineSet.has(name) }));
    const msg = JSON.stringify({ type: 'participants', users });
    for (const wsSet of info!.connectedUsers.values()) {
      for (const ws of wsSet) {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
      }
    }
  };
  // Only broadcast if this is a genuinely new user (not a reconnect)
  if (!wasConnected) {
    broadcastParticipants();
  }

  // Track shared users (non-owner who joined)
  if (info && connUser !== info.owner && connUser !== 'anonymous' && !connUser.startsWith('guest_')) {
    if (!info.sharedWith.has(connUser)) {
      info.sharedWith.add(connUser);
      saveEasyRegistry();
    }
  }

  // Send session info (owner, projectDir, file access)
  const isOwner = connUser === info.owner;
  const fileAccessUsers = info._fileAccessUsers || new Set<string>();
  const hasFileAccess = isOwner || fileAccessUsers.has(connUser);
  // Expose workspace/ as the visible project dir (locks file panel to output dir)
  const wsDir = path.join(cp.projectDir, 'workspace');
  let visibleDir = cp.projectDir;
  try { fs.statSync(wsDir); visibleDir = wsDir; } catch {}
  clientWs.send(JSON.stringify({
    type: 'session_info',
    owner: info.owner,
    projectDir: visibleDir,
    sessionName: info.name || '',
    isOwner,
    hasFileAccess,
  }));

  // Send current state + history on connect
  const history = cp.getHistory();
  if (history.length > 0) {
    clientWs.send(JSON.stringify({ type: 'history', messages: history }));
  }
  // Send current state
  const initialState = cp.isActive() ? 'thinking' : 'ready';
  console.log(`[easy] ${sessionId} sending initial state: ${initialState} (activeChild=${cp.isActive()}, history=${history.length})`);
  clientWs.send(JSON.stringify({
    type: 'state',
    state: initialState,
  }));

  // Send all preview URLs so joining users see the same preview state
  if (cp.previewUrls && cp.previewUrls.length > 0) {
    // Send all URLs (oldest first so newest ends up on top in client)
    for (let i = cp.previewUrls.length - 1; i >= 0; i--) {
      clientWs.send(JSON.stringify({ type: 'preview_hint', url: cp.previewUrls[i] }));
    }
  } else if (cp.lastPreviewUrl) {
    clientWs.send(JSON.stringify({ type: 'preview_hint', url: cp.lastPreviewUrl }));
  }

  // Client messages
  clientWs.on('message', (data: Buffer | string) => {
    try {
      const raw = data.toString();
      console.log(`[easy] ${sessionId} recv from ${connUser}: ${raw.substring(0, 200)}`);
      const msg: EasyClientMessage = JSON.parse(raw);
      if (msg.type === 'send') {
        console.log(`[easy] ${sessionId} sendMessage from ${connUser}: ${msg.text.substring(0, 100)}`);
        if (info) { info.lastActivity = Date.now(); saveEasyRegistry(); }
        // Server-side fallback: extract mentions from text if client didn't send them
        let mentions = msg.mentions;
        if (!mentions) {
          const mentionMatches = msg.text.match(/@([\w\u4e00-\u9fff]+)/g);
          if (mentionMatches) mentions = mentionMatches.map((m: string) => m.substring(1));
        }
        // Pass participant count so claude-process can decide whether to invoke Claude
        const participantCount = info ? info.connectedUsers.size : 1;
        cp!.sendMessage(msg.text, connUser, mentions, participantCount);
      } else if (msg.type === 'cancel') {
        cp!.cancel();
      } else if (msg.type === 'retry') {
        cp!.retry();
      } else if (msg.type === 'request_file_access') {
        // Non-owner requests file access — notify all owner connections
        if (info && connUser !== info.owner) {
          const ownerSockets = info.connectedUsers.get(info.owner);
          if (ownerSockets) {
            const notification = JSON.stringify({ type: 'file_access_request', user: connUser });
            ownerSockets.forEach((ws) => { try { ws.send(notification); } catch(_){} });
          }
        }
      } else if (msg.type === 'grant_file_access') {
        // Owner grants file access to a user
        if (info && connUser === info.owner && msg.user) {
          info._fileAccessUsers.add(msg.user);
          saveEasyRegistry();
          // Notify all connections of the granted user
          const grantedSockets = info.connectedUsers.get(msg.user);
          if (grantedSockets) {
            const notification = JSON.stringify({ type: 'file_access_granted', user: msg.user });
            grantedSockets.forEach((ws) => { try { ws.send(notification); } catch(_){} });
          }
          // Also confirm to the owner
          clientWs.send(JSON.stringify({ type: 'file_access_granted', user: msg.user }));
        }
      }
    } catch (e) {
      console.error(`[easy] ${sessionId} message parse error:`, (e as Error).message);
    }
  });

  clientWs.on('close', () => {
    console.log(`[easy] Client disconnected: ${sessionId} user=${connUser}`);
    cp!.removeListener(sendToClient);
    // Remove this WS from connected users tracking
    const wsSet = info?.connectedUsers.get(connUser);
    if (wsSet) {
      wsSet.delete(clientWs);
      // If user has no more connections, debounce the leave broadcast
      // so reconnects don't trigger false join/leave notifications
      if (wsSet.size === 0 && info) {
        // DON'T delete from connectedUsers yet — keep the entry so reconnect
        // sees wasConnected=true and doesn't broadcast a spurious "joined"
        // Wait 60s before broadcasting leave — gives time to reconnect
        const timer = setTimeout(() => {
          info!._leaveTimers.delete(connUser);
          // Check they haven't reconnected in the meantime
          const currentSet = info!.connectedUsers.get(connUser);
          if (!currentSet || currentSet.size === 0) {
            info!.connectedUsers.delete(connUser);
            broadcastParticipants();
          }
        }, 60000);
        info._leaveTimers.set(connUser, timer);
      }
    }
    // Don't dispose ClaudeProcess — keep it alive for reconnect
  });

  clientWs.on('error', (err) => {
    console.error(`[easy] Client error for ${sessionId}:`, err.message);
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
          // Start a new streaming ASR session; cancel any previous one
          if (asrSession) cancelAsrSession(asrSession);
          asrSession = startAsrSession(ws);
          console.log(`ASR streaming started for ${id}`);
        } else if (msg.type === 'asr_end') {
          // Send final marker to Volcano
          if (asrSession) {
            asrSession.ended = true;
            if (asrSession.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
              asrSession.volcanoWs.send(buildAudioRequest(Buffer.alloc(0), true));
              console.log(`ASR streaming ended for ${id} (${asrSession.allChunks.length} chunks)`);
            } else {
              // connectVolcano's open handler will send final marker when it sees ended=true
              console.log(`ASR end received, Volcano not ready yet for ${id}`);
            }
          }
        }
      } else if (message instanceof Buffer) {
        // Binary = raw PCM audio chunk, forward to Volcano
        if (asrSession) {
          const chunk = Buffer.from(message);
          asrSession.allChunks.push(chunk);
          if (asrSession.ready && asrSession.volcanoWs?.readyState === WebSocket.OPEN) {
            // Real-time: forward directly
            asrSession.volcanoWs.send(buildAudioRequest(chunk, false));
          } else {
            // Buffer while Volcano is connecting
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
    if (asrSession) cancelAsrSession(asrSession);
    voiceClients.delete(id);
    console.log(`Voice client disconnected: ${id}`);
  });
});

// Handle WebSocket upgrade
server.on('upgrade', (request, socket, head) => {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const p = url.pathname;

  // Allow guest token auth for /ws-easy
  if (p === '/ws-easy' || p === '/terminal/ws-easy') {
    const guestToken = url.searchParams.get('guest_token');
    const guestExpires = url.searchParams.get('expires');
    const guestSession = url.searchParams.get('session');
    if (guestToken && guestExpires && guestSession) {
      if (verifyGuestToken(guestSession, guestToken, guestExpires)) {
        easyWss.handleUpgrade(request, socket, head, (ws) => {
          (request as any)._guestMode = true;
          // Use client-supplied stable guest_id, fallback to random
          const gid = url.searchParams.get('guest_id') || randomBytes(4).toString('hex');
          (request as any)._guestUsername = 'guest_' + gid;
          easyWss.emit('connection', ws, request);
        });
        return;
      }
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  // Verify authentication before allowing WebSocket upgrade
  if (!isAuthenticated(request)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  // Accept both direct paths and proxy-rewritten paths:
  // Direct: /terminal/ws, /terminal/ws-voice
  // Via proxy (strips /terminal): /ws, /ws-voice
  // Legacy: /ws/terminal, /ws/voice
  if (p === '/ws' || p === '/terminal/ws' || p === '/ws/terminal') {
    terminalWss.handleUpgrade(request, socket, head, (ws) => {
      terminalWss.emit('connection', ws, request);
    });
  } else if (p === '/ws-easy' || p === '/terminal/ws-easy') {
    easyWss.handleUpgrade(request, socket, head, (ws) => {
      easyWss.emit('connection', ws, request);
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

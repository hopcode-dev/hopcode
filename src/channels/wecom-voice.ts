/**
 * WeChat Work Voice Reply Module
 *
 * Pipeline: text → TTS (Volcano Engine) → PCM → AMR (ffmpeg) → upload → send
 * Ported from chief-oc/extensions/wecom/src/voice.ts
 */

import { execFile } from 'node:child_process';
import { writeFile, readFile, unlink } from 'node:fs/promises';
import { WebSocket } from 'ws';

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';

// Volcano Engine TTS config (reuse from .env)
const VOLCANO_APP_ID = process.env.VOLCANO_APP_ID || '';
const VOLCANO_TOKEN = process.env.VOLCANO_TOKEN || '';
const VOLCANO_TTS_RESOURCE_ID = process.env.VOLCANO_RESOURCE_ID || 'seed-tts-2.0';
const VOLCANO_VOICE = process.env.VOLCANO_VOICE || 'zh_female_wanwanxiaohe_moon_bigtts';

// WeCom API credentials
const WECOM_CORP_ID = process.env.WECOM_CORP_ID || '';
const WECOM_SECRET = process.env.WECOM_SECRET || '';
const WECOM_AGENT_ID = process.env.WECOM_AGENT_ID || '';

// Cached access token
let accessToken: string | null = null;
let tokenExpiry = 0;

const log = (msg: string) => console.log(`[wecom-voice] ${msg}`);

export function isVoiceReplyAvailable(): boolean {
  return Boolean(VOLCANO_APP_ID && VOLCANO_TOKEN && WECOM_CORP_ID && WECOM_SECRET && WECOM_AGENT_ID);
}

// ── WeCom Access Token ──

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiry - 60_000) return accessToken;
  const resp = await fetch(
    `${WECOM_API}/gettoken?corpid=${WECOM_CORP_ID}&corpsecret=${WECOM_SECRET}`,
    { signal: AbortSignal.timeout(10_000) },
  );
  const data = await resp.json() as any;
  if (data.errcode && data.errcode !== 0) throw new Error(`gettoken failed: ${data.errmsg}`);
  accessToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 7200) * 1000;
  return accessToken!;
}

// ── TTS (Volcano Engine Bidirectional WebSocket) ──

// Protocol constants
const PROTOCOL_VERSION = 0b0001;
const DEFAULT_HEADER_SIZE = 0b0001;
const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_RESPONSE = 0b1011;
const ERROR_INFORMATION = 0b1111;
const MsgTypeFlagNoSeq = 0b0000;
const MsgTypeFlagWithEvent = 0b0100;
const JSON_SERIALIZATION = 0b0001;
const COMPRESSION_NO = 0b0000;
const EVENT_StartSession = 100;
const EVENT_FinishSession = 102;
const EVENT_SessionStarted = 150;
const EVENT_SessionFinished = 152;
const EVENT_SessionFailed = 153;
const EVENT_TaskRequest = 200;
const EVENT_TTSResponse = 352;

function buildHeader(messageType: number, flags: number = MsgTypeFlagNoSeq, serial: number = 0): Uint8Array {
  return new Uint8Array([(PROTOCOL_VERSION << 4) | DEFAULT_HEADER_SIZE, (messageType << 4) | flags, (serial << 4) | COMPRESSION_NO, 0]);
}

function buildOptional(event: number, sessionId?: string): Uint8Array {
  const parts: number[] = [];
  const ev = new DataView(new ArrayBuffer(4)); ev.setInt32(0, event, false);
  parts.push(...new Uint8Array(ev.buffer));
  if (sessionId) {
    const sid = new TextEncoder().encode(sessionId);
    const sz = new DataView(new ArrayBuffer(4)); sz.setInt32(0, sid.length, false);
    parts.push(...new Uint8Array(sz.buffer), ...sid);
  }
  return new Uint8Array(parts);
}

function buildPayloadWithSize(payload: object): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const sz = new DataView(new ArrayBuffer(4)); sz.setInt32(0, bytes.length, false);
  const result = new Uint8Array(4 + bytes.length);
  result.set(new Uint8Array(sz.buffer), 0); result.set(bytes, 4);
  return result;
}

function buildMessage(header: Uint8Array, optional: Uint8Array, payload?: Uint8Array): Uint8Array {
  const total = header.length + optional.length + (payload?.length || 0);
  const result = new Uint8Array(total); let off = 0;
  result.set(header, off); off += header.length;
  result.set(optional, off); off += optional.length;
  if (payload) result.set(payload, off);
  return result;
}

function readInt32BE(data: Uint8Array, offset: number): number {
  return new DataView(data.buffer, data.byteOffset + offset, 4).getInt32(0, false);
}

function readStringWithSize(data: Uint8Array, offset: number): { value: string; newOffset: number } {
  const size = readInt32BE(data, offset); offset += 4;
  const value = new TextDecoder().decode(data.slice(offset, offset + size));
  return { value, newOffset: offset + size };
}

function readPayloadWithSize(data: Uint8Array, offset: number): { payload: Uint8Array; newOffset: number } {
  const size = readInt32BE(data, offset); offset += 4;
  return { payload: data.slice(offset, offset + size), newOffset: offset + size };
}

function synthesize(text: string): Promise<Buffer> {
  const sessionId = crypto.randomUUID().replace(/-/g, '');
  const connectId = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const audioChunks: Buffer[] = [];
    let sessionStarted = false;

    const ws = new WebSocket('wss://openspeech.bytedance.com/api/v3/tts/bidirection', {
      headers: {
        'X-Api-App-Key': VOLCANO_APP_ID,
        'X-Api-Access-Key': VOLCANO_TOKEN,
        'X-Api-Resource-Id': VOLCANO_TTS_RESOURCE_ID,
        'X-Api-Connect-Id': connectId,
      },
    });

    const cleanup = () => { if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(); };
    const timeout = setTimeout(() => {
      cleanup();
      audioChunks.length > 0 ? resolve(Buffer.concat(audioChunks)) : reject(new Error('TTS timeout'));
    }, 30000);

    const reqParams = {
      text: '', speaker: VOLCANO_VOICE,
      audio_params: { format: 'pcm', sample_rate: 24000, enable_timestamp: false },
      additions: JSON.stringify({ disable_markdown_filter: false }),
    };

    ws.on('open', () => {
      ws.send(buildMessage(
        buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION),
        buildOptional(EVENT_StartSession, sessionId),
        buildPayloadWithSize({ user: { uid: 'hopcode' }, event: EVENT_StartSession, namespace: 'BidirectionalTTS', req_params: reqParams }),
      ));
    });

    ws.on('message', (rawData: Buffer) => {
      try {
        const data = new Uint8Array(rawData);
        const msgType = (data[1]! >> 4) & 0x0f;
        const flags = data[1]! & 0x0f;
        let offset = 4;

        if (flags === MsgTypeFlagWithEvent) {
          const eventType = readInt32BE(data, offset); offset += 4;

          if (eventType === EVENT_SessionStarted) {
            sessionStarted = true;
            const { newOffset: off1 } = readStringWithSize(data, offset); offset = off1;
            if (offset < data.length) { const { newOffset: off2 } = readStringWithSize(data, offset); offset = off2; }

            // Send text
            ws.send(buildMessage(
              buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION),
              buildOptional(EVENT_TaskRequest, sessionId),
              buildPayloadWithSize({ user: { uid: 'hopcode' }, event: EVENT_TaskRequest, namespace: 'BidirectionalTTS', req_params: { ...reqParams, text } }),
            ));
            setTimeout(() => {
              ws.send(buildMessage(
                buildHeader(FULL_CLIENT_REQUEST, MsgTypeFlagWithEvent, JSON_SERIALIZATION),
                buildOptional(EVENT_FinishSession, sessionId),
                buildPayloadWithSize({}),
              ));
            }, 100);
          } else if (eventType === EVENT_TTSResponse && msgType === AUDIO_ONLY_RESPONSE) {
            const { newOffset: off1 } = readStringWithSize(data, offset); offset = off1;
            const { payload } = readPayloadWithSize(data, offset);
            audioChunks.push(Buffer.from(payload));
          } else if (eventType === EVENT_SessionFinished) {
            clearTimeout(timeout); cleanup(); resolve(Buffer.concat(audioChunks));
          } else if (eventType === EVENT_SessionFailed) {
            const { newOffset: off1 } = readStringWithSize(data, offset); offset = off1;
            let errorMsg = 'Session failed';
            if (offset < data.length) { const { value } = readStringWithSize(data, offset); errorMsg = value; }
            clearTimeout(timeout); cleanup(); reject(new Error(errorMsg));
          }
        } else if (msgType === ERROR_INFORMATION) {
          const errorCode = readInt32BE(data, offset); offset += 4;
          const { payload } = readPayloadWithSize(data, offset);
          clearTimeout(timeout); cleanup(); reject(new Error(`TTS error ${errorCode}: ${new TextDecoder().decode(payload)}`));
        }
      } catch {}
    });

    ws.on('error', (e: Error) => { clearTimeout(timeout); cleanup(); reject(e); });
    ws.on('close', () => {
      clearTimeout(timeout);
      if (audioChunks.length > 0) resolve(Buffer.concat(audioChunks));
      else if (!sessionStarted) reject(new Error('WS closed before session'));
    });
  });
}

// ── Audio conversion ──

function exec(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 30_000 }, (err) => err ? reject(err) : resolve());
  });
}

async function pcmToAmr(pcm: Buffer): Promise<Buffer> {
  const ts = Date.now();
  const pcmPath = `/tmp/tts-${ts}.pcm`;
  const amrPath = `/tmp/tts-${ts}.amr`;
  try {
    await writeFile(pcmPath, pcm);
    await exec('ffmpeg', ['-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcmPath, '-ar', '8000', '-ab', '12.2k', '-ac', '1', amrPath]);
    const amr = await readFile(amrPath);
    log(`PCM (${pcm.length}B) → AMR (${amr.length}B)`);
    return amr;
  } finally {
    await unlink(pcmPath).catch(() => {});
    await unlink(amrPath).catch(() => {});
  }
}

// ── Upload & Send ──

async function uploadVoiceMedia(amr: Buffer): Promise<string> {
  const token = await getAccessToken();
  const boundary = `----FormBoundary${Date.now()}`;
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="media"; filename="reply-${Date.now()}.amr"\r\nContent-Type: audio/amr\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, amr, footer]);

  const resp = await fetch(`${WECOM_API}/media/upload?access_token=${token}&type=voice`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json() as any;
  log(`Upload response: ${JSON.stringify(data)}`);
  if (data.errcode && data.errcode !== 0) throw new Error(`Upload failed: ${data.errmsg}`);
  return data.media_id;
}

async function sendVoiceMessage(userId: string, mediaId: string): Promise<void> {
  const token = await getAccessToken();
  const body = {
    touser: userId,
    msgtype: 'voice',
    agentid: parseInt(WECOM_AGENT_ID, 10),
    voice: { media_id: mediaId },
  };
  log(`Sending voice: ${JSON.stringify(body)}`);
  const resp = await fetch(`${WECOM_API}/message/send?access_token=${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await resp.json() as any;
  log(`Send voice response: ${JSON.stringify(data)}`);
  if (data.errcode && data.errcode !== 0) throw new Error(`Send voice failed: ${data.errmsg}`);
}

// ── Text processing ──

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*/g, '').replace(/\*/g, '')
    .replace(/#{1,6}\s?/g, '').replace(/`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[-•]\s/gm, '').replace(/^\d+\.\s/gm, '')
    .replace(/\|[^|]*\|/g, '').replace(/^[:\-\s|]+$/gm, '')
    .replace(/\n{2,}/g, '\n').trim();
}

function splitForTTS(text: string, maxLen = 180): string[] {
  const clean = stripMarkdown(text).replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const segments: string[] = [];
  let remaining = clean;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) { segments.push(remaining); break; }
    const chunk = remaining.substring(0, maxLen);
    const lastBreak = Math.max(
      chunk.lastIndexOf('。'), chunk.lastIndexOf('！'), chunk.lastIndexOf('？'),
      chunk.lastIndexOf('!'), chunk.lastIndexOf('?'),
    );
    if (lastBreak > maxLen / 3) {
      segments.push(remaining.substring(0, lastBreak + 1));
      remaining = remaining.substring(lastBreak + 1).trimStart();
    } else {
      const lastComma = Math.max(
        chunk.lastIndexOf('，'), chunk.lastIndexOf(','),
        chunk.lastIndexOf('；'), chunk.lastIndexOf(';'),
      );
      if (lastComma > maxLen / 3) {
        segments.push(remaining.substring(0, lastComma + 1));
        remaining = remaining.substring(lastComma + 1).trimStart();
      } else {
        segments.push(remaining.substring(0, maxLen));
        remaining = remaining.substring(maxLen).trimStart();
      }
    }
  }
  return segments;
}

// ── Public API ──

/**
 * Send voice reply after text reply (fire-and-forget).
 * text → TTS → PCM → AMR → upload → send as voice message(s)
 */
export async function sendVoiceReply(userId: string, responseText: string): Promise<void> {
  if (!responseText || !isVoiceReplyAvailable()) return;

  try {
    const segments = splitForTTS(responseText);
    if (segments.length === 0) return;

    log(`Voice reply for ${userId}: ${segments.length} segment(s), "${segments[0]!.substring(0, 50)}..."`);

    for (let i = 0; i < segments.length; i++) {
      const pcm = await synthesize(segments[i]!);
      const amr = await pcmToAmr(pcm);
      const mediaId = await uploadVoiceMedia(amr);
      await sendVoiceMessage(userId, mediaId);
      log(`Voice segment ${i + 1}/${segments.length} sent`);
    }
  } catch (err) {
    log(`Voice reply failed: ${err}`);
  }
}

/**
 * Volcano ASR diagnostic: tests real-time streaming vs batch replay.
 * Usage: npx tsx src/test-volcano.ts
 */
import { WebSocket } from 'ws';
import * as zlib from 'zlib';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// Load .env manually
const envPath = path.join(process.cwd(), '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^(\w+)=(.*)$/);
    if (m) process.env[m[1]!] = m[2]!;
  }
}

const APP_ID = process.env.VOLCANO_APP_ID!;
const TOKEN = process.env.VOLCANO_TOKEN!;
const RESOURCE_ID = process.env.VOLCANO_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration';
const ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';

function buildFullClientRequest(payload: object): Buffer {
  const jsonBytes = Buffer.from(JSON.stringify(payload), 'utf-8');
  const gzipped = zlib.gzipSync(jsonBytes);
  const header = Buffer.from([0x11, 0x10, 0x11, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(gzipped.length);
  return Buffer.concat([header, size, gzipped]);
}

function buildAudioRequest(audioData: Buffer, isLast: boolean): Buffer {
  const flags = isLast ? 0b0010 : 0b0000;
  const msgTypeFlags = (0b0010 << 4) | flags;
  const header = Buffer.from([0x11, msgTypeFlags, 0x00, 0x00]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(audioData.length);
  return Buffer.concat([header, size, audioData]);
}

function parseResponse(data: Buffer): { msgType: number; result?: any; error?: string } {
  if (data.length < 12) return { msgType: 0, error: 'Too short' };
  const msgType = (data[1]! >> 4) & 0x0F;
  const compression = data[2]! & 0x0F;
  const payloadSize = data.readUInt32BE(8);
  let payload = data.subarray(12, 12 + payloadSize);
  if (compression === 1) {
    try { payload = zlib.gunzipSync(payload); } catch {}
  }
  try {
    return { msgType, result: JSON.parse(payload.toString('utf-8')) };
  } catch {
    return { msgType, error: 'Parse error' };
  }
}

// Generate speech-like audio: 440Hz FM-modulated sine wave
function generateAudio(durationMs: number): Buffer {
  const sr = 16000;
  const n = Math.floor(sr * durationMs / 1000);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 440 + 200 * Math.sin(2 * Math.PI * 3 * t);
    const s = Math.sin(2 * Math.PI * f * t) * 0.5;
    buf.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return buf;
}

const initPayload = {
  user: { uid: randomUUID() },
  audio: { format: 'pcm', rate: 16000, bits: 16, channel: 1, codec: 'raw' },
  request: {
    model_name: 'bigmodel', language: 'zh',
    enable_itn: true, enable_punc: true,
    result_type: 'full', show_utterances: true,
  },
};

function makeWs() {
  return new WebSocket(ENDPOINT, {
    headers: {
      'X-Api-App-Key': APP_ID,
      'X-Api-Access-Key': TOKEN,
      'X-Api-Resource-Id': RESOURCE_ID,
      'X-Api-Connect-Id': randomUUID(),
    },
  });
}

function runTest(name: string, sendFn: (ws: WebSocket, audio: Buffer) => void): Promise<void> {
  console.log(`\n=== ${name} ===\n`);
  const audio = generateAudio(3000); // 3s of audio
  const chunkSize = 16000 * 2 * 200 / 1000; // 200ms chunks = 6400 bytes

  return new Promise((resolve) => {
    const ws = makeWs();
    const t0 = Date.now();
    const el = () => `${Date.now() - t0}ms`;
    let msgs = 0;

    ws.on('open', () => {
      console.log(`[${el()}] Connected`);
      ws.send(buildFullClientRequest(initPayload));
      console.log(`[${el()}] Init sent`);
      sendFn(ws, audio);
    });

    ws.on('message', (data: Buffer) => {
      msgs++;
      const p = parseResponse(Buffer.from(data));
      if (p.msgType === 15) {
        console.log(`[${el()}] ERROR: ${JSON.stringify(p.result || p.error)}`);
      } else if (p.msgType === 9) {
        const r = p.result?.result;
        const text = r?.text || '';
        const utt = r?.utterances || [];
        const def = utt.length > 0 && utt[0].definite;
        console.log(`[${el()}] #${msgs} definite=${def} "${text}"`);
      } else {
        console.log(`[${el()}] msgType=${p.msgType}`);
      }
    });

    ws.on('error', (e) => console.log(`[${el()}] Error: ${e.message}`));
    ws.on('close', (code) => {
      console.log(`[${el()}] Closed (${code}), ${msgs} messages total`);
      resolve();
    });

    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 15000);
  });
}

// ---- Tests ----

console.log('Volcano ASR Diagnostic');
console.log(`App ID: ${APP_ID?.substring(0, 8)}...`);

// Test 1: Real-time 200ms chunks
await runTest('Real-time streaming (200ms chunks at real-time pace)', (ws, audio) => {
  const chunkSize = 6400;
  const numChunks = Math.ceil(audio.length / chunkSize);
  let sent = 0;
  const iv = setInterval(() => {
    if (sent >= numChunks) {
      clearInterval(iv);
      ws.send(buildAudioRequest(Buffer.alloc(0), true));
      console.log(`  Final sent (${sent} chunks)`);
      return;
    }
    const off = sent * chunkSize;
    ws.send(buildAudioRequest(audio.subarray(off, Math.min(off + chunkSize, audio.length)), false));
    sent++;
    if (sent === 1) console.log(`  First chunk sent`);
  }, 200);
});

await new Promise(r => setTimeout(r, 2000));

// Test 2: Batch (all at once)
await runTest('Batch replay (all chunks at once)', (ws, audio) => {
  const chunkSize = 6400;
  const numChunks = Math.ceil(audio.length / chunkSize);
  for (let i = 0; i < numChunks; i++) {
    const off = i * chunkSize;
    ws.send(buildAudioRequest(audio.subarray(off, Math.min(off + chunkSize, audio.length)), false));
  }
  ws.send(buildAudioRequest(Buffer.alloc(0), true));
  console.log(`  All ${numChunks} chunks + final sent`);
});

await new Promise(r => setTimeout(r, 2000));

// Test 3: Init + immediate first chunk, then real-time
await runTest('Immediate first chunk + real-time', (ws, audio) => {
  const chunkSize = 6400;
  const numChunks = Math.ceil(audio.length / chunkSize);
  // Send first chunk immediately
  ws.send(buildAudioRequest(audio.subarray(0, chunkSize), false));
  console.log(`  First chunk sent immediately after init`);
  let sent = 1;
  const iv = setInterval(() => {
    if (sent >= numChunks) {
      clearInterval(iv);
      ws.send(buildAudioRequest(Buffer.alloc(0), true));
      console.log(`  Final sent (${sent} chunks)`);
      return;
    }
    const off = sent * chunkSize;
    ws.send(buildAudioRequest(audio.subarray(off, Math.min(off + chunkSize, audio.length)), false));
    sent++;
  }, 200);
});

await new Promise(r => setTimeout(r, 2000));

// Test 4: Delay 500ms after init, then send all (simulates our current behavior)
await runTest('500ms delay after init, then batch', (ws, audio) => {
  const chunkSize = 6400;
  const numChunks = Math.ceil(audio.length / chunkSize);
  setTimeout(() => {
    for (let i = 0; i < numChunks; i++) {
      const off = i * chunkSize;
      ws.send(buildAudioRequest(audio.subarray(off, Math.min(off + chunkSize, audio.length)), false));
    }
    ws.send(buildAudioRequest(Buffer.alloc(0), true));
    console.log(`  [500ms delay] All ${numChunks} chunks + final sent`);
  }, 500);
});

console.log('\n=== Done ===');
process.exit(0);

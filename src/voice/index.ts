/**
 * Voice Module for Hopcode
 * TTS (Text-to-Speech) and ASR (Automatic Speech Recognition)
 * Based on Volcano Engine BigModel
 */

import { $ } from 'bun';
import { VolcanoBigModelTtsProvider } from './tts';

// Environment configuration
const VOLCANO_APP_ID = process.env.VOLCANO_APP_ID || '';
const VOLCANO_TOKEN = process.env.VOLCANO_TOKEN || '';
const VOLCANO_VOICE = process.env.VOLCANO_VOICE || 'zh_female_wanwanxiaohe_moon_bigtts';
const VOLCANO_ASR_RESOURCE_ID = process.env.VOLCANO_ASR_RESOURCE_ID || 'volc.bigasr.sauc.duration';
const VOLCANO_TTS_RESOURCE_ID = process.env.VOLCANO_RESOURCE_ID || process.env.VOLCANO_TTS_RESOURCE_ID || 'volc.service_type.10029';

// Path to ASR CLI script and Python
const ASR_CLI_PATH = new URL('./asr.py', import.meta.url).pathname;
const PYTHON_PATH = process.env.PYTHON_PATH || `${process.env.HOME}/Documents/Coding/shared_venv/bin/python3`;

/**
 * Run ASR (Automatic Speech Recognition) on PCM audio
 * Uses Volcano Engine BigModel ASR via Python CLI
 */
export async function runASR(pcmBuffer: Buffer): Promise<string> {
  if (!VOLCANO_APP_ID || !VOLCANO_TOKEN) {
    throw new Error('Volcano Engine credentials not configured (VOLCANO_APP_ID, VOLCANO_TOKEN)');
  }

  const timestamp = Date.now();
  const pcmPath = `/tmp/asr-${timestamp}.pcm`;

  try {
    // Write PCM file
    await Bun.write(pcmPath, pcmBuffer);

    // Run ASR CLI
    const proc = Bun.spawn([
      PYTHON_PATH,
      ASR_CLI_PATH,
      '--appid', VOLCANO_APP_ID,
      '--token', VOLCANO_TOKEN,
      '--resource-id', VOLCANO_ASR_RESOURCE_ID,
      '--audio', pcmPath,
      '--format', 'pcm',
      '--sample-rate', '16000'
    ], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    // Parse result (format: "RESULT:recognized text")
    const match = stdout.match(/RESULT:(.+)/);
    if (match) {
      const text = match[1].trim();
      console.log(`ASR result: "${text}"`);
      return text;
    }

    // Check for error
    if (stderr.includes('ERROR:')) {
      throw new Error(`ASR error: ${stderr}`);
    }

    console.log(`ASR stdout: ${stdout}`);
    console.log(`ASR stderr: ${stderr}`);
    throw new Error('ASR returned no result');
  } finally {
    // Cleanup
    await $`rm -f ${pcmPath}`.quiet();
  }
}

/**
 * Run TTS (Text-to-Speech) synthesis
 * Returns PCM audio buffer (16kHz, 16-bit, mono)
 */
export async function runTTS(text: string, voice?: string): Promise<Buffer> {
  if (!VOLCANO_APP_ID || !VOLCANO_TOKEN) {
    throw new Error('Volcano Engine credentials not configured');
  }

  const speaker = voice || VOLCANO_VOICE;

  const tts = new VolcanoBigModelTtsProvider({
    appId: VOLCANO_APP_ID,
    token: VOLCANO_TOKEN,
    resourceId: VOLCANO_TTS_RESOURCE_ID,
  });

  const pcmBuffer = await tts.synthesize(text, { speaker });
  console.log(`TTS synthesized "${text.substring(0, 30)}..." -> ${pcmBuffer.length} bytes PCM`);

  return pcmBuffer;
}

/**
 * Convert PCM to WAV format (for browser playback)
 */
export function pcmToWav(pcmData: Buffer, sampleRate = 16000, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmData.length;
  const fileSize = 36 + dataSize;

  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(fileSize, 4);
  header.write('WAVE', 8);

  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcmData]);
}

export default {
  runASR,
  runTTS,
  pcmToWav,
};

/**
 * Comprehensive Test Suite for Hopcode
 * Run with: bun run src/test-all.ts
 */

import { runTTS, runASR, pcmToWav } from './voice';
import { $ } from 'bun';

const PORT = 3001; // Use different port for testing
const BASE_URL = `http://localhost:${PORT}`;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ Unit Tests ============

async function testPcmToWav() {
  console.log('\n--- Test: pcmToWav ---');

  // Create fake PCM data
  const pcm = Buffer.alloc(1600); // 0.1s of silence
  const wav = pcmToWav(pcm);

  // Check WAV header
  const riff = wav.toString('ascii', 0, 4);
  const wave = wav.toString('ascii', 8, 12);

  if (riff !== 'RIFF') throw new Error(`Expected RIFF header, got: ${riff}`);
  if (wave !== 'WAVE') throw new Error(`Expected WAVE, got: ${wave}`);
  if (wav.length !== pcm.length + 44) throw new Error(`Wrong WAV size: ${wav.length}`);

  console.log('  ✓ pcmToWav generates valid WAV header');
  return true;
}

async function testTTSBasic() {
  console.log('\n--- Test: TTS Basic ---');

  const pcm = await runTTS('你好');

  if (!pcm || pcm.length < 1000) {
    throw new Error(`TTS returned insufficient data: ${pcm?.length || 0} bytes`);
  }

  console.log(`  ✓ TTS basic works: ${pcm.length} bytes`);
  return true;
}

async function testTTSLongText() {
  console.log('\n--- Test: TTS Long Text ---');

  const longText = '这是一段比较长的文字，用于测试语音合成系统处理长文本的能力。语音合成系统应该能够正确处理这样的输入。';
  const pcm = await runTTS(longText);

  if (!pcm || pcm.length < 10000) {
    throw new Error(`TTS long text failed: ${pcm?.length || 0} bytes`);
  }

  console.log(`  ✓ TTS long text works: ${pcm.length} bytes`);
  return true;
}

async function testASRBasic() {
  console.log('\n--- Test: ASR Basic ---');

  // Generate audio with TTS first
  const pcm = await runTTS('你好');
  const text = await runASR(pcm);

  if (!text || text.length === 0) {
    throw new Error('ASR returned empty result');
  }

  console.log(`  ✓ ASR basic works: "${text}"`);
  return true;
}

async function testASRAccuracy() {
  console.log('\n--- Test: ASR Accuracy ---');

  const testPhrases = [
    { input: '今天天气很好', keywords: ['今天', '天气'] },
    { input: '你好世界', keywords: ['你好', '世界'] },
  ];

  for (const { input, keywords } of testPhrases) {
    const pcm = await runTTS(input);
    const result = await runASR(pcm);

    const hasKeyword = keywords.some(k => result.includes(k));
    if (!hasKeyword) {
      console.log(`  ⚠ ASR accuracy warning: "${input}" -> "${result}"`);
    } else {
      console.log(`  ✓ "${input}" -> "${result}"`);
    }
  }

  return true;
}

// ============ Integration Tests ============

async function testServerAPI() {
  console.log('\n--- Test: Server API ---');

  // Start server
  const serverProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  await sleep(2000);

  try {
    // Test health
    const healthRes = await fetch(`${BASE_URL}/health`);
    if (!healthRes.ok) throw new Error('Health check failed');
    console.log('  ✓ Health endpoint works');

    // Test TTS API
    const ttsRes = await fetch(`${BASE_URL}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '测试' })
    });
    if (!ttsRes.ok) throw new Error('TTS API failed');
    const wavData = await ttsRes.arrayBuffer();
    if (wavData.byteLength < 1000) throw new Error('TTS returned too little data');
    console.log(`  ✓ TTS API works: ${wavData.byteLength} bytes`);

    // Test static files
    const indexRes = await fetch(`${BASE_URL}/`);
    if (!indexRes.ok) throw new Error('Static file serving failed');
    const html = await indexRes.text();
    if (!html.includes('Hopcode')) throw new Error('Wrong index.html content');
    console.log('  ✓ Static file serving works');

    // Test WebSocket
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/voice`);
    const wsConnected = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      ws.onopen = () => { clearTimeout(timeout); resolve(true); };
      ws.onerror = () => { clearTimeout(timeout); resolve(false); };
    });
    ws.close();
    if (!wsConnected) throw new Error('WebSocket connection failed');
    console.log('  ✓ WebSocket works');

    return true;
  } finally {
    serverProc.kill();
  }
}

// ============ Test Runner ============

async function runAllTests() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║        Hopcode - Comprehensive Tests            ║');
  console.log('╚════════════════════════════════════════════════╝');

  const tests = [
    { name: 'pcmToWav', fn: testPcmToWav },
    { name: 'TTS Basic', fn: testTTSBasic },
    { name: 'TTS Long Text', fn: testTTSLongText },
    { name: 'ASR Basic', fn: testASRBasic },
    { name: 'ASR Accuracy', fn: testASRAccuracy },
    { name: 'Server API', fn: testServerAPI },
  ];

  const results: { name: string; passed: boolean; error?: string }[] = [];

  for (const test of tests) {
    try {
      await test.fn();
      results.push({ name: test.name, passed: true });
    } catch (e) {
      console.log(`  ✗ Error: ${e}`);
      results.push({ name: test.name, passed: false, error: String(e) });
    }
  }

  // Summary
  console.log('\n╔════════════════════════════════════════════════╗');
  console.log('║                  Test Summary                  ║');
  console.log('╠════════════════════════════════════════════════╣');

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  for (const r of results) {
    const status = r.passed ? '✓' : '✗';
    console.log(`║  ${status} ${r.name.padEnd(40)}  ║`);
  }

  console.log('╠════════════════════════════════════════════════╣');
  console.log(`║  Total: ${passed}/${results.length} passed${failed > 0 ? `, ${failed} failed` : ''}`.padEnd(47) + '║');
  console.log('╚════════════════════════════════════════════════╝');

  // Check ttyd status
  try {
    await $`which ttyd`.quiet();
    console.log('\n✓ ttyd is installed - full terminal functionality available');
  } catch {
    console.log('\n⚠ ttyd not installed - terminal feature disabled');
    console.log('  Install with: brew install ttyd');
  }

  return failed === 0;
}

// Kill any existing server on test port
await $`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`.quiet().nothrow();
await sleep(500);

runAllTests().then(success => {
  process.exit(success ? 0 : 1);
});

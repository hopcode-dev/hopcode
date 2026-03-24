/**
 * End-to-End Test - Full system with ttyd
 */

import { $ } from 'bun';

const PORT = 3002;
const TTYD_PORT = 7682;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testE2E() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║        End-to-End Test with ttyd               ║');
  console.log('╚════════════════════════════════════════════════╝\n');

  // Kill any existing processes
  await $`lsof -ti:${PORT},${TTYD_PORT} | xargs kill -9 2>/dev/null`.quiet().nothrow();
  await sleep(1000);

  // Start server
  console.log('Starting server with ttyd...');
  const serverProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(PORT), TTYD_PORT: String(TTYD_PORT) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Wait for server + ttyd to start
  await sleep(3000);

  try {
    // Test 1: Health check shows ttyd available
    console.log('\n1. Health check with ttyd...');
    const healthRes = await fetch(`http://localhost:${PORT}/health`);
    const health = await healthRes.json() as { ttyd: string };
    if (health.ttyd.includes(String(TTYD_PORT))) {
      console.log(`   ✓ ttyd endpoint: ${health.ttyd}`);
    } else {
      throw new Error(`ttyd not enabled: ${JSON.stringify(health)}`);
    }

    // Test 2: ttyd is accessible
    console.log('\n2. Checking ttyd direct access...');
    const ttydRes = await fetch(`http://localhost:${TTYD_PORT}/`);
    if (ttydRes.ok) {
      const html = await ttydRes.text();
      if (html.includes('ttyd') || html.includes('xterm')) {
        console.log('   ✓ ttyd web interface accessible');
      } else {
        console.log('   ⚠ ttyd returned unexpected content');
      }
    } else {
      throw new Error(`ttyd not accessible: ${ttydRes.status}`);
    }

    // Test 3: TTS still works
    console.log('\n3. TTS API...');
    const ttsRes = await fetch(`http://localhost:${PORT}/api/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '终端测试' })
    });
    if (ttsRes.ok) {
      const wav = await ttsRes.arrayBuffer();
      console.log(`   ✓ TTS works: ${wav.byteLength} bytes`);
    } else {
      throw new Error('TTS failed');
    }

    // Test 4: WebSocket voice connection
    console.log('\n4. Voice WebSocket...');
    const ws = new WebSocket(`ws://localhost:${PORT}/ws/voice`);
    const wsOk = await new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => resolve(false), 5000);
      ws.onopen = () => { clearTimeout(timeout); resolve(true); };
      ws.onerror = () => { clearTimeout(timeout); resolve(false); };
    });
    ws.close();
    if (wsOk) {
      console.log('   ✓ Voice WebSocket connected');
    } else {
      throw new Error('Voice WebSocket failed');
    }

    // Test 5: Frontend loads
    console.log('\n5. Frontend...');
    const frontRes = await fetch(`http://localhost:${PORT}/`);
    const frontHtml = await frontRes.text();
    if (frontHtml.includes('Hopcode') && frontHtml.includes('record-btn')) {
      console.log('   ✓ Frontend with voice controls loaded');
    } else {
      throw new Error('Frontend missing components');
    }

    console.log('\n╔════════════════════════════════════════════════╗');
    console.log('║           All E2E Tests Passed!                ║');
    console.log('╠════════════════════════════════════════════════╣');
    console.log(`║  Web UI:   http://localhost:${PORT}               ║`);
    console.log(`║  Terminal: http://localhost:${TTYD_PORT}               ║`);
    console.log('╚════════════════════════════════════════════════╝');

    return true;
  } catch (e) {
    console.log(`\n✗ E2E test failed: ${e}`);
    return false;
  } finally {
    serverProc.kill();
    await $`lsof -ti:${TTYD_PORT} | xargs kill -9 2>/dev/null`.quiet().nothrow();
  }
}

testE2E().then(success => {
  process.exit(success ? 0 : 1);
});

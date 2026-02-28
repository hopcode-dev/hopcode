/**
 * Server Integration Test
 * Tests all API endpoints
 */

const PORT = 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testServer() {
  console.log('=== Server Integration Test ===\n');

  // Start server in background
  console.log('Starting server...');
  const serverProc = Bun.spawn(['bun', 'run', 'src/server.ts'], {
    cwd: process.cwd(),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Wait for server to start
  await sleep(2000);

  let allPassed = true;

  try {
    // Test 1: Health check
    console.log('Test 1: Health check');
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const data = await res.json();
      if (res.ok && data.status === 'ok') {
        console.log(`  ✓ Health check passed: ${JSON.stringify(data)}`);
      } else {
        console.log(`  ✗ Health check failed: ${JSON.stringify(data)}`);
        allPassed = false;
      }
    } catch (e) {
      console.log(`  ✗ Health check error: ${e}`);
      allPassed = false;
    }

    // Test 2: Static file serving
    console.log('\nTest 2: Static file serving');
    try {
      const res = await fetch(`${BASE_URL}/`);
      const html = await res.text();
      if (res.ok && html.includes('Hopcode')) {
        console.log(`  ✓ Index page served (${html.length} bytes)`);
      } else {
        console.log(`  ✗ Index page failed`);
        allPassed = false;
      }
    } catch (e) {
      console.log(`  ✗ Static file error: ${e}`);
      allPassed = false;
    }

    // Test 3: TTS API
    console.log('\nTest 3: TTS API');
    try {
      const res = await fetch(`${BASE_URL}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '测试' })
      });
      if (res.ok) {
        const wav = await res.arrayBuffer();
        console.log(`  ✓ TTS API returned ${wav.byteLength} bytes WAV`);
      } else {
        const err = await res.json();
        console.log(`  ✗ TTS API failed: ${JSON.stringify(err)}`);
        allPassed = false;
      }
    } catch (e) {
      console.log(`  ✗ TTS API error: ${e}`);
      allPassed = false;
    }

    // Test 4: TTS API validation
    console.log('\nTest 4: TTS API validation');
    try {
      const res = await fetch(`${BASE_URL}/api/tts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (res.status === 400) {
        console.log(`  ✓ TTS validation works (returns 400 for missing text)`);
      } else {
        console.log(`  ✗ TTS validation failed: expected 400, got ${res.status}`);
        allPassed = false;
      }
    } catch (e) {
      console.log(`  ✗ TTS validation error: ${e}`);
      allPassed = false;
    }

    // Test 5: WebSocket connection
    console.log('\nTest 5: WebSocket connection');
    try {
      const ws = new WebSocket(`ws://localhost:${PORT}/ws/voice`);
      const connected = await new Promise<boolean>((resolve) => {
        const timeout = setTimeout(() => resolve(false), 5000);
        ws.onopen = () => {
          clearTimeout(timeout);
          resolve(true);
        };
        ws.onerror = () => {
          clearTimeout(timeout);
          resolve(false);
        };
      });

      if (connected) {
        // Wait for connected message
        const msg = await new Promise<any>((resolve) => {
          ws.onmessage = (e) => resolve(JSON.parse(e.data));
          setTimeout(() => resolve(null), 3000);
        });

        ws.close();

        if (msg?.type === 'connected') {
          console.log(`  ✓ WebSocket connected, client ID: ${msg.id}`);
        } else {
          console.log(`  ✗ WebSocket connected but no ID received`);
          allPassed = false;
        }
      } else {
        console.log(`  ✗ WebSocket connection failed`);
        allPassed = false;
      }
    } catch (e) {
      console.log(`  ✗ WebSocket error: ${e}`);
      allPassed = false;
    }

    // Test 6: 404 handling
    console.log('\nTest 6: 404 handling');
    try {
      const res = await fetch(`${BASE_URL}/nonexistent`);
      if (res.status === 404) {
        console.log(`  ✓ 404 handling works`);
      } else {
        console.log(`  ✗ 404 handling failed: expected 404, got ${res.status}`);
        allPassed = false;
      }
    } catch (e) {
      console.log(`  ✗ 404 error: ${e}`);
      allPassed = false;
    }

  } finally {
    // Stop server
    console.log('\nStopping server...');
    serverProc.kill();
  }

  console.log('\n' + (allPassed ? '✓ All tests passed!' : '✗ Some tests failed!'));
  return allPassed;
}

testServer().then(success => {
  process.exit(success ? 0 : 1);
});

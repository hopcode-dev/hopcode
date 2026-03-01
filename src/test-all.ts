/**
 * Comprehensive Test Suite for Hopcode
 * Run with: bun run src/test-all.ts
 */

import { $ } from 'bun';

const PORT = 3001; // Use different port for testing
const BASE_URL = `http://localhost:${PORT}`;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ Integration Tests ============

async function testServerAPI() {
  console.log('\n--- Test: Server API ---');

  // Start server
  const serverProc = Bun.spawn(['npx', 'tsx', 'src/server-node.ts'], {
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
  console.log('║        Hopcode - Comprehensive Tests          ║');
  console.log('╚════════════════════════════════════════════════╝');

  const tests = [
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

  return failed === 0;
}

// Kill any existing server on test port
await $`lsof -ti:${PORT} | xargs kill -9 2>/dev/null`.quiet().nothrow();
await sleep(500);

runAllTests().then(success => {
  process.exit(success ? 0 : 1);
});

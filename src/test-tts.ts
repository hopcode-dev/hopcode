/**
 * TTS Module Test
 */
import { runTTS, pcmToWav } from './voice';

async function testTTS() {
  console.log('=== TTS Test ===\n');

  const testCases = [
    '你好，这是语音测试。',
    'Hello, this is a voice test.',
    '一二三四五六七八九十',
  ];

  for (const text of testCases) {
    console.log(`Testing: "${text}"`);
    try {
      const startTime = Date.now();
      const pcm = await runTTS(text);
      const elapsed = Date.now() - startTime;

      console.log(`  ✓ PCM: ${pcm.length} bytes (${elapsed}ms)`);

      // Convert to WAV
      const wav = pcmToWav(pcm);
      console.log(`  ✓ WAV: ${wav.length} bytes`);

      // Save first test to file for manual verification
      if (text === testCases[0]) {
        await Bun.write('/tmp/test-tts.wav', wav);
        console.log('  ✓ Saved to /tmp/test-tts.wav');
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e}`);
      return false;
    }
  }

  console.log('\n✓ TTS tests passed!\n');
  return true;
}

testTTS().then(success => {
  process.exit(success ? 0 : 1);
});

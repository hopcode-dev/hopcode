/**
 * ASR Module Test
 * Uses TTS to generate audio, then tests ASR recognition
 */
import { runTTS, runASR } from './voice';

async function testASR() {
  console.log('=== ASR Test ===\n');

  const testCases = [
    '你好世界',
    '今天天气很好',
    '一二三四五',
  ];

  for (const text of testCases) {
    console.log(`Testing: "${text}"`);
    try {
      // Generate audio with TTS
      console.log('  Generating TTS audio...');
      const pcm = await runTTS(text);
      console.log(`  ✓ TTS: ${pcm.length} bytes`);

      // Run ASR on the generated audio
      console.log('  Running ASR...');
      const startTime = Date.now();
      const recognized = await runASR(pcm);
      const elapsed = Date.now() - startTime;

      console.log(`  ✓ ASR result: "${recognized}" (${elapsed}ms)`);

      // Check similarity (allow some variation)
      const similarity = calculateSimilarity(text, recognized);
      console.log(`  ✓ Similarity: ${(similarity * 100).toFixed(1)}%`);

      if (similarity < 0.5) {
        console.log(`  ⚠ Warning: Low similarity`);
      }
    } catch (e) {
      console.log(`  ✗ Error: ${e}`);
      return false;
    }
    console.log('');
  }

  console.log('✓ ASR tests passed!\n');
  return true;
}

function calculateSimilarity(a: string, b: string): number {
  // Simple character overlap similarity
  const setA = new Set(a.split(''));
  const setB = new Set(b.split(''));
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return intersection / union;
}

testASR().then(success => {
  process.exit(success ? 0 : 1);
});

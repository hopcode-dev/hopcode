import { test, expect, describe } from 'bun:test';
import { EasyModeProcessor } from './processor.js';
import { claudeProfile, getProfile } from './cli-profiles.js';
import type { EasyServerMessage } from './protocol.js';
import * as fs from 'fs';
import * as path from 'path';

function createProcessor() {
  const messages: EasyServerMessage[] = [];
  const processor = new EasyModeProcessor(claudeProfile, (msg) => {
    messages.push(msg);
  });
  return { processor, messages };
}

// Helper: replay .cast file output events into processor
function replayCastOutputs(filePath: string, processor: EasyModeProcessor): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n');
  const outputs: string[] = [];
  for (const line of lines) {
    if (line.startsWith('{')) continue; // skip header
    try {
      const [_ts, type, data] = JSON.parse(line);
      if (type === 'o') {
        outputs.push(data);
        processor.feedOutput(data);
      }
    } catch {}
  }
  return outputs;
}

describe('EasyModeProcessor', () => {
  test('initial state is initializing', () => {
    const { processor } = createProcessor();
    expect(processor.getState()).toBe('initializing');
    processor.dispose();
  });

  test('detects prompt and transitions to ready', async () => {
    const { processor, messages } = createProcessor();

    // Simulate Claude startup output with prompt char
    processor.feedOutput('Claude Code v1.0.0\r\n');
    processor.feedOutput('\u276f \r\n'); // ❯ prompt

    // Wait for debounce
    await new Promise(r => setTimeout(r, 200));

    expect(processor.getState()).toBe('ready');
    const stateMsg = messages.find(m => m.type === 'state' && m.state === 'ready');
    expect(stateMsg).toBeTruthy();
    const startedMsg = messages.find(m => m.type === 'cli_started');
    expect(startedMsg).toBeTruthy();

    processor.dispose();
  });

  test('transitions to thinking on user send', async () => {
    const { processor, messages } = createProcessor();

    // Force ready state
    processor.feedOutput('\u276f \r\n');
    await new Promise(r => setTimeout(r, 200));
    expect(processor.getState()).toBe('ready');

    // User sends message
    processor.notifyUserSend('hello');
    expect(processor.getState()).toBe('thinking');

    const thinkingMsg = messages.find(m => m.type === 'state' && m.state === 'thinking');
    expect(thinkingMsg).toBeTruthy();

    processor.dispose();
  });

  test('detects permission prompt', async () => {
    const { processor, messages } = createProcessor();

    // Force to thinking state
    processor.feedOutput('\u276f \r\n');
    await new Promise(r => setTimeout(r, 200));
    processor.notifyUserSend('edit file');

    // Simulate permission prompt
    processor.feedOutput('Bash: rm -rf /tmp/test\r\n');
    processor.feedOutput('  Allow   Deny\r\n');

    await new Promise(r => setTimeout(r, 1000));

    const permMsg = messages.find(m => m.type === 'permission');
    expect(permMsg).toBeTruthy();
    if (permMsg && permMsg.type === 'permission') {
      expect(permMsg.options).toHaveLength(3);
      expect(permMsg.options[0]?.label).toBe('Allow');
    }

    processor.dispose();
  });

  test('shell prompt pattern matches correctly', () => {
    // Verify the regex pattern works
    expect(claudeProfile.shellPromptPattern.test('$')).toBe(true);
    expect(claudeProfile.shellPromptPattern.test('$ ')).toBe(true);
    expect(claudeProfile.shellPromptPattern.test('#')).toBe(true);
    expect(claudeProfile.shellPromptPattern.test('# ')).toBe(true);
    expect(claudeProfile.shellPromptPattern.test('hello $')).toBe(false);
  });

  test('cleanOutput strips tool lines and UI elements', async () => {
    const { processor, messages } = createProcessor();

    // Get to ready state
    processor.feedOutput('\u276f \r\n');
    await new Promise(r => setTimeout(r, 200));

    // User sends
    processor.notifyUserSend('test');
    // Wait for grace period
    await new Promise(r => setTimeout(r, 1600));

    // Simulate realistic Claude response with tool + response using ● markers
    const response = [
      '\u25CF Read(src/file.ts)\r\n',           // ● tool invocation
      '\u23BF File contents here\r\n',           // ⎿ tool result
      '\u25CF Here is the answer to your question.\r\n',  // ● response
      '\u25CF This is the second line of the answer.\r\n', // ● response continued
      '\u276f \r\n',                              // ❯ prompt
    ].join('');
    processor.feedOutput(response);

    await new Promise(r => setTimeout(r, 1000));

    const msgEvent = messages.find(m => m.type === 'message');
    expect(msgEvent).toBeTruthy();
    if (msgEvent && msgEvent.type === 'message') {
      expect(msgEvent.text).toContain('Here is the answer');
      expect(msgEvent.text).toContain('second line');
      // Should NOT contain tool output
      expect(msgEvent.text).not.toContain('Read(');
      expect(msgEvent.text).not.toContain('File contents');
    }

    processor.dispose();
  });

  test('history is maintained across messages', async () => {
    const { processor } = createProcessor();

    // Get to ready
    processor.feedOutput('\u276f \r\n');
    await new Promise(r => setTimeout(r, 200));

    // Send message
    processor.notifyUserSend('hello');
    await new Promise(r => setTimeout(r, 1600));

    // Response with ● marker (like real Claude output)
    processor.feedOutput('\u25CF Hello! How can I help?\r\n\u276f \r\n');
    await new Promise(r => setTimeout(r, 1000));

    const history = processor.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0]?.role).toBe('user');
    expect(history[0]?.text).toBe('hello');

    processor.dispose();
  });

  test('getProfile returns claude by default', () => {
    const profile = getProfile('claude');
    expect(profile.id).toBe('claude');
    expect(profile.command).toBe('claude');

    const unknown = getProfile('unknown');
    expect(unknown.id).toBe('claude'); // fallback
  });
});

// Integration test with real .cast recordings
describe('EasyModeProcessor with recordings', () => {
  const recordingsDir = path.join(process.cwd(), 'data/recordings');

  test('processes cast file without crashing', async () => {
    const castFiles = fs.readdirSync(recordingsDir).filter(f => f.endsWith('.cast'));
    if (castFiles.length === 0) {
      console.log('No cast files found, skipping');
      return;
    }

    const castFile = path.join(recordingsDir, castFiles[0]!);
    const { processor, messages } = createProcessor();

    // Replay all output events
    replayCastOutputs(castFile, processor);

    // Wait for debounce
    await new Promise(r => setTimeout(r, 300));

    // Should have emitted some messages
    console.log(`Processed ${castFile}: ${messages.length} messages emitted`);
    console.log('Final state:', processor.getState());
    console.log('Message types:', messages.map(m => m.type));

    processor.dispose();
  });
});

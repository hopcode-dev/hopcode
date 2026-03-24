/**
 * EasyModeProcessor — server-side terminal output processing
 *
 * Maintains a headless xterm instance, applies CLI profile-driven state machine,
 * and emits structured messages for the Easy Mode client.
 */

// @ts-ignore — default export works at runtime with tsx
import xtermHeadless from '@xterm/headless';
const HeadlessTerminal = xtermHeadless.Terminal;

import type { CliProfile } from './cli-profiles.js';
import type { EasyState, EasyServerMessage } from './protocol.js';

interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  id: number;
}

export class EasyModeProcessor {
  private term: InstanceType<typeof HeadlessTerminal>;
  private profile: CliProfile;
  private state: EasyState = 'initializing';
  private messageId = 0;
  private promptLineY = -1;
  private lastSendTime = 0;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private graceRecheckTimer: ReturnType<typeof setTimeout> | null = null;
  private onMessage: (msg: EasyServerMessage) => void;
  private history: HistoryEntry[] = [];
  private sentEchoPatterns: string[] = [];
  private claudeStarted = false;
  private disposed = false;

  constructor(profile: CliProfile, onMessage: (msg: EasyServerMessage) => void) {
    this.profile = profile;
    this.onMessage = onMessage;
    this.term = new HeadlessTerminal({
      cols: 120,
      rows: 40,
      scrollback: 500,
      allowProposedApi: true,
    });
  }

  /** Feed live PTY output */
  feedOutput(data: string): void {
    if (this.disposed) return;
    this.term.write(data);
    this.scheduleCheck();
  }

  /** Feed scrollback on reconnect — then reconstruct history */
  feedScrollback(data: string): void {
    if (this.disposed) return;
    if (!data) return;

    this.term.write(data, () => {
      this.reconstructHistory();

      if (this.history.length > 0) {
        this.emit({ type: 'history', messages: this.history });
      }

      this.checkState();

      if (this.state === 'initializing') {
        this.claudeStarted = true;
        this.setState('ready');
        this.emit({ type: 'cli_started' });
      }
    });
  }

  /** Called when user sends a message — for echo suppression and state transition */
  notifyUserSend(text: string): void {
    this.lastSendTime = Date.now();
    this.sentEchoPatterns.push(text.trim());
    if (this.sentEchoPatterns.length > 5) {
      this.sentEchoPatterns.shift();
    }

    const id = ++this.messageId;
    this.history.push({ role: 'user', text, id });
    this.setState('thinking');
  }

  /** Clean up resources */
  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.graceRecheckTimer) clearTimeout(this.graceRecheckTimer);
    this.term.dispose();
  }

  /** Get current state */
  getState(): EasyState {
    return this.state;
  }

  /** Get conversation history (for reconnecting clients) */
  getHistory(): HistoryEntry[] {
    return this.history;
  }

  // --- Internal ---

  private emit(msg: EasyServerMessage): void {
    if (!this.disposed) {
      this.onMessage(msg);
    }
  }

  private setState(newState: EasyState): void {
    if (newState === this.state) return;
    this.state = newState;
    this.emit({ type: 'state', state: newState });
  }

  private scheduleCheck(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    // When waiting for Claude's response, use a longer settle time (400ms).
    // Spinner animation generates output every ~100ms; 400ms of silence = likely done.
    // Spinner remnants in buffer are stripped by cleanOutput, so we don't need to wait
    // for them to fully clear — just long enough for the prompt event to arrive.
    const isActive = this.state === 'thinking' || this.state === 'responding' || this.state === 'tool_running';
    const delay = isActive ? 400 : this.profile.outputDebounceMs;
    this.debounceTimer = setTimeout(() => this.checkState(), delay);
  }

  private checkState(): void {
    if (this.disposed) return;

    const buf = this.term.buffer.active;
    const rows = this.term.rows || 40;
    const viewStart = Math.max(0, buf.baseY);
    const viewEnd = viewStart + rows - 1;

    const allLines: string[] = [];
    let promptLine = -1;

    for (let i = viewStart; i <= viewEnd; i++) {
      const line = buf.getLine(i);
      if (!line) break;
      const text: string = line.translateToString(true);
      allLines.push(text);
      if (this.profile.promptPattern.test(text)) {
        promptLine = i;
      }
    }

    const allText = allLines.join('\n');

    // Grace period: ignore prompt for a bit after sending
    const graceOk = (Date.now() - this.lastSendTime) > this.profile.promptGraceMs;

    // With 800ms settle debounce, spinner animation has stopped by now.
    // Just need grace period to avoid matching echoed prompt right after send.
    const newPrompt = (promptLine >= 0 && graceOk) ? promptLine : -1;

    // If prompt found but blocked by grace, schedule recheck after grace expires
    if (promptLine >= 0 && !graceOk && !this.graceRecheckTimer) {
      const remaining = this.profile.promptGraceMs - (Date.now() - this.lastSendTime) + 100;
      this.graceRecheckTimer = setTimeout(() => {
        this.graceRecheckTimer = null;
        this.checkState();
      }, Math.max(remaining, 200));
    }

    this.processSignals(allText, allLines, newPrompt);
  }

  private processSignals(recentText: string, recentLines: string[], newPromptLine: number): void {
    // --- Initializing ---
    if (this.state === 'initializing') {
      if (this.profile.promptPattern.test(recentText) ||
          recentText.includes('\u273B') ||
          recentText.includes('Tips')) {
        this.claudeStarted = true;
        if (newPromptLine >= 0) {
          this.promptLineY = newPromptLine;
        }
        this.setState('ready');
        this.emit({ type: 'cli_started' });
      }
      return;
    }

    // --- Prompt detected → Claude finished ---
    if (newPromptLine >= 0) {
      if (this.graceRecheckTimer) { clearTimeout(this.graceRecheckTimer); this.graceRecheckTimer = null; }
      if (this.state === 'thinking' || this.state === 'responding' ||
          this.state === 'tool_running' || this.state === 'permission') {
        this.renderResponse(newPromptLine);
      } else {
        this.promptLineY = newPromptLine;
        if (this.state !== 'ready') this.setState('ready');
      }
      return;
    }

    // --- Permission prompt ---
    if (this.profile.permissionPattern.test(recentText)) {
      if (this.state !== 'permission') {
        this.setState('permission');
        let desc = '';
        for (const line of recentLines) {
          if (/\bAllow\b/.test(line)) break;
          if (line.trim().length > 3) desc = line.trim();
        }
        const resp = this.profile.permissionResponses;
        this.emit({
          type: 'permission',
          description: desc,
          options: [
            { label: 'Allow', keystroke: resp.allow, style: 'allow' },
            { label: 'Allow all similar', keystroke: resp.allowAll, style: 'always' },
            { label: 'Deny', keystroke: resp.deny, style: 'deny' },
          ],
        });
      }
      return;
    }

    // --- Shell prompt → CLI exited ---
    const lastLine = recentLines[recentLines.length - 1] ?? '';
    if (lastLine && this.profile.shellPromptPattern.test(lastLine.trim())) {
      this.setState('exited');
      this.emit({ type: 'cli_exited' });
      return;
    }

    // --- Tool detection ---
    if (this.state === 'thinking' || this.state === 'responding') {
      for (const line of recentLines) {
        if (this.profile.toolStartPattern.test(line)) {
          const match = line.match(this.profile.toolStartPattern);
          if (match && match[1]) {
            const toolName = match[1];
            const action = this.getToolAction(toolName);
            this.setState('tool_running');
            this.emit({ type: 'tool', name: toolName, detail: action, status: 'running' });
          }
          break;
        }
      }
    }

    // --- Update status ---
    if (this.state === 'ready' && (Date.now() - this.lastSendTime) < 5000) {
      this.setState('thinking');
    }
  }

  private getToolAction(name: string): string {
    const map: Record<string, string> = {
      Read: 'Reading file',
      Edit: 'Editing file',
      Write: 'Writing file',
      Bash: 'Running command',
      Glob: 'Searching files',
      Grep: 'Searching',
      Search: 'Searching',
      Agent: 'Working',
      WebFetch: 'Fetching web page',
      WebSearch: 'Searching web',
    };
    return map[name] || 'Working';
  }

  private renderResponse(promptAtLine: number): void {
    const buf = this.term.buffer.active;

    // Use saved promptLineY as the previous prompt position.
    // Scanning backwards for ❯ is unreliable because Claude's TUI shows
    // an intermediate ❯ (waiting prompt) during processing, which is
    // closer to the new prompt than the user's actual input line.
    let prevPrompt = this.promptLineY;

    // Fallback: if no saved position, scan backwards but skip prompts
    // within 6 lines of the current prompt (they're in the prompt area)
    if (prevPrompt < 0) {
      for (let i = promptAtLine - 7; i >= Math.max(0, buf.baseY); i--) {
        const line = buf.getLine(i);
        if (line && this.profile.promptPattern.test(line.translateToString(true))) {
          prevPrompt = i;
          break;
        }
      }
    }

    // Claude TUI uses aggressive cursor positioning — the raw buffer lines are a
    // mess of overlapping spinner, separator, and response text on the same rows.
    // Instead of reading raw lines between prompts, scan the viewport for response
    // markers (●) and extract clean text from those specific lines.
    const searchStart = prevPrompt >= 0 ? prevPrompt + 1 : Math.max(0, buf.baseY);
    const responseFragments: string[] = [];

    // Regex for box drawing chars that get mixed into response lines
    const boxDrawing = /[\u2500-\u257F\u256D-\u2570\u2502\u2503]/g;
    // Tool names that follow ● — these are tool invocations, not responses
    const toolNameRe = new RegExp(`^\\s*(${this.profile.toolNames.join('|')})[\\s(]`);

    for (let i = searchStart; i < promptAtLine; i++) {
      const line = buf.getLine(i);
      if (!line) break;
      let lt: string = line.translateToString(true);

      // Look for response marker ● (U+25CF) with actual content
      const bulletIdx = lt.indexOf('\u25CF');
      if (bulletIdx < 0) continue;

      // Extract text after ●, strip box drawing
      let after = lt.substring(bulletIdx + 1).replace(boxDrawing, '').trim();
      if (!after) continue;

      // Skip tool invocations: ● Bash(...), ● Read(...), etc.
      if (toolNameRe.test(after)) continue;

      // Skip if only symbols/whitespace remain
      if (!after.replace(/[\s\u25AA\u25A0\u2022\u00B7*·✶✻✽✢✷✹⊹∗◆◇○⦿⏺]/g, '').trim()) continue;

      // Strip any spinner remnants embedded in the text
      after = after.replace(/[*·✶✻✽✢✷✹⊹∗◆◇⬥⬦○◈⦿⏺]\s*[A-Z][a-z''\-]+\u2026/g, '').trim();
      if (after) responseFragments.push(after);
    }

    const text = responseFragments.join('\n').trim();
    console.log(`[EasyProc] renderResponse: prev=${prevPrompt} prompt=${promptAtLine} → "${text.substring(0, 200)}"`);

    if (text) {
      const id = ++this.messageId;
      this.history.push({ role: 'assistant', text, id });
      this.emit({ type: 'message', id, role: 'assistant', text });
    }

    this.promptLineY = promptAtLine;
    this.setState('ready');
  }

  /** Reconstruct conversation history from xterm buffer (for page refresh) */
  private reconstructHistory(): void {
    const buf = this.term.buffer.active;
    const totalLines = buf.baseY + (this.term.rows || 40);

    // Find all prompt lines
    const promptLines: number[] = [];
    for (let i = 0; i < totalLines; i++) {
      const line = buf.getLine(i);
      if (!line) break;
      if (this.profile.promptPattern.test(line.translateToString(true))) {
        promptLines.push(i);
      }
    }

    if (promptLines.length < 2) return;

    for (let pi = 0; pi < promptLines.length - 1; pi++) {
      const inputLineNum = promptLines[pi]!;
      const nextPromptNum = promptLines[pi + 1]!;

      // User input: text after prompt char
      const inputBufLine = buf.getLine(inputLineNum);
      if (!inputBufLine) continue;
      const inputText: string = inputBufLine.translateToString(true);
      const promptIdx = inputText.indexOf('\u276f');
      const userText = promptIdx >= 0 ? inputText.substring(promptIdx + 1).trim() : '';
      if (!userText) continue;

      // Response lines between prompts
      const respLines: string[] = [];
      for (let ri = inputLineNum + 1; ri < nextPromptNum; ri++) {
        const rl = buf.getLine(ri);
        if (!rl) break;
        const rt: string = rl.translateToString(true);
        if (rl.isWrapped && respLines.length > 0) {
          const lastIdx = respLines.length - 1;
          respLines[lastIdx] = (respLines[lastIdx] ?? '').replace(/\s+$/, '') + rt;
        } else {
          respLines.push(rt);
        }
      }

      const cleaned = this.cleanOutput(respLines);
      if (!cleaned) continue;

      const userId = ++this.messageId;
      this.history.push({ role: 'user', text: userText, id: userId });
      const assistantId = ++this.messageId;
      this.history.push({ role: 'assistant', text: cleaned, id: assistantId });
    }

    // Update promptLineY to last prompt
    const lastPrompt = promptLines[promptLines.length - 1];
    if (lastPrompt !== undefined) {
      this.promptLineY = lastPrompt;
    }
  }

  /** Clean terminal output lines using profile patterns */
  private cleanOutput(lines: string[]): string {
    const cleaned: string[] = [];

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i] ?? '';
      if (!line.trim()) { cleaned.push(''); continue; }

      // Strip spinner segments from line FIRST.
      // Claude TUI leaves spinner text fossilized in the buffer; it can appear
      // on the same line as response text due to cursor positioning/wrapping.
      // Pattern: symbol + optional space + CapitalizedWord… (e.g. "✶ Catapulting…", "* Undulating…")
      line = line.replace(/[*·✶✻✽✢✷✹⊹∗◆◇⬥⬦○◈⦿⏺]\s*[A-Z][a-z''\-]+\u2026/g, '');

      if (!line.trim()) continue;

      // Check skip patterns
      let skip = false;
      for (const pat of this.profile.skipPatterns) {
        if (pat.test(line)) { skip = true; break; }
      }
      if (skip) continue;

      // Special spinner check (needs length constraint) — catches remaining spinner-only lines
      const trimmed = line.trim();
      if (trimmed.length < this.profile.spinnerMaxLen &&
          trimmed.length > 2 &&
          this.profile.spinnerPattern.test(trimmed) &&
          !/for\s+\d/.test(trimmed)) {
        continue;
      }

      // Version/account line (Opus|Sonnet|Haiku with @)
      if (/Opus|Sonnet|Haiku|Claude Max|Claude Pro/i.test(line) && /@/.test(line)) continue;
      // Organization at end of line
      if (/Organization$/.test(line.trim())) continue;
      // Running + ↓
      if (/\(running\)/.test(line) && /\u2193/.test(line)) continue;

      // Apply clean patterns
      for (const cp of this.profile.cleanPatterns) {
        line = line.replace(cp.match, cp.replace);
      }

      // Skip if only whitespace/symbols remain
      if (!line.replace(/[\s\u25AA\u25A0\u2022\u00B7]/g, '').trim()) continue;

      cleaned.push(line);
    }

    let text = cleaned.join('\n');
    text = text.replace(/^\n+|\n+$/g, '');
    text = text.replace(/\n{3,}/g, '\n\n');

    // Remove echoed user input from first 3 lines
    if (this.sentEchoPatterns.length > 0) {
      const fl = text.split('\n');
      for (let j = 0; j < Math.min(3, fl.length); j++) {
        const flLine = fl[j] ?? '';
        for (const pat of this.sentEchoPatterns) {
          if (flLine.trim() === pat.trim()) fl[j] = '';
        }
      }
      text = fl.join('\n').replace(/^\n+/, '');
    }

    return text.trim();
  }
}

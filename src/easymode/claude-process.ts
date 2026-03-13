/**
 * ClaudeProcess — manages claude -p subprocess for Easy Mode.
 * Each user message spawns a new `claude -p` process with structured JSON output.
 * Multi-turn handled via --resume with the session UUID from the first response.
 */

import { spawn, ChildProcess } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import * as path from 'path';
import type { EasyServerMessage } from './protocol.js';

interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  id: number;
}

export class ClaudeProcess {
  sessionId: string;           // hopcode session ID (easy_xxx)
  claudeSessionId: string | null = null;  // UUID for --resume
  projectDir: string;
  activeChild: ChildProcess | null = null;
  history: HistoryEntry[] = [];
  private listeners = new Set<(msg: EasyServerMessage) => void>();
  private nextMsgId = 1;
  private disposed = false;
  private _lastStreamToolName = '';
  private _toolJsonBuf = '';
  private _knownPreviewFiles = new Map<string, number>(); // name -> mtime
  private static PREVIEW_EXTS = new Set(['.html', '.htm', '.svg', '.csv', '.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);

  private stateFile: string;

  constructor(
    sessionId: string,
    projectDir: string,
    onMessage: (msg: EasyServerMessage) => void,
  ) {
    this.sessionId = sessionId;
    this.projectDir = projectDir;
    this.listeners.add(onMessage);
    this.stateFile = path.join(projectDir, '.easy-state.json');
    this.loadState();
    this.snapshotPreviewFiles();
  }

  addListener(fn: (msg: EasyServerMessage) => void): void {
    this.listeners.add(fn);
  }

  removeListener(fn: (msg: EasyServerMessage) => void): void {
    this.listeners.delete(fn);
  }

  private broadcast(msg: EasyServerMessage): void {
    for (const fn of this.listeners) {
      try { fn(msg); } catch {}
    }
  }

  private loadState(): void {
    try {
      const data = JSON.parse(readFileSync(this.stateFile, 'utf-8'));
      if (data.claudeSessionId) this.claudeSessionId = data.claudeSessionId;
    } catch {}
  }

  private saveState(): void {
    try {
      writeFileSync(this.stateFile, JSON.stringify({ claudeSessionId: this.claudeSessionId }), 'utf-8');
    } catch {}
  }

  sendMessage(text: string): void {
    if (this.disposed) return;

    // Cancel any active child before starting new one
    if (this.activeChild) {
      const old = this.activeChild;
      this.activeChild = null;  // Detach so its close event won't send 'ready'
      try { old.kill('SIGKILL'); } catch {}
    }

    // Record user message in history
    const userEntry: HistoryEntry = { role: 'user', text, id: this.nextMsgId++ };
    this.history.push(userEntry);

    // Notify client: thinking state
    this.broadcast({ type: 'state', state: 'thinking' });

    // Build command args
    const args = [
      '-p', text,
      '--output-format', 'stream-json',
      '--verbose',
      '--model', 'sonnet',
      '--include-partial-messages',
      '--append-system-prompt',
      'You are action-oriented. When the user confirms, agrees, or says things like "好的"/"试试"/"做吧"/"go ahead"/"ok", treat it as a request to START DOING THE WORK immediately — write code, create files, build the thing. Never respond with just "ok let me know if you need help". Always take concrete action. Reply in the same language as the user.',
    ];

    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }

    // Ensure project directory exists
    try { mkdirSync(this.projectDir, { recursive: true }); } catch {}

    // Spawn claude process
    const env = { ...process.env };
    delete env.CLAUDECODE;  // prevent child inheriting parent's claude-code session

    console.log(`[claude-process] ${this.sessionId} spawning: claude ${args.join(' ').substring(0, 200)} cwd=${this.projectDir} resume=${this.claudeSessionId || 'none'}`);
    const child = spawn('claude', args, {
      cwd: this.projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeChild = child;
    console.log(`[claude-process] ${this.sessionId} spawned pid=${child.pid}`);

    let stdoutBuffer = '';
    let fullResponseText = '';
    let lastToolName = '';
    // Streaming state: accumulate deltas and broadcast incrementally
    let streamingText = '';
    let streamingMsgId = 0;
    let streamingIsThinking = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      // Process complete lines (NDJSON)
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';  // keep incomplete last line in buffer

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          this.handleStreamEvent(event, (text) => {
            fullResponseText = text;
          }, (toolName) => {
            lastToolName = toolName;
          }, {
            getStreamText: () => streamingText,
            setStreamText: (t: string) => { streamingText = t; },
            getMsgId: () => streamingMsgId,
            setMsgId: (id: number) => { streamingMsgId = id; },
            getIsThinking: () => streamingIsThinking,
            setIsThinking: (v: boolean) => { streamingIsThinking = v; },
            resetStream: () => { streamingText = ''; streamingMsgId = 0; streamingIsThinking = false; },
          });
        } catch {
          // Skip non-JSON lines
        }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.error(`[claude-process] ${this.sessionId} stderr: ${text}`);
      }
    });

    child.on('close', (code) => {
      // If this child was replaced by a newer one, ignore its close event
      const isCurrentChild = this.activeChild === child;
      if (isCurrentChild) this.activeChild = null;
      console.log(`[claude-process] ${this.sessionId} pid=${child.pid} close code=${code} current=${isCurrentChild} response=${fullResponseText.length}chars`);

      // Process any remaining buffer
      if (isCurrentChild && stdoutBuffer.trim()) {
        try {
          const event = JSON.parse(stdoutBuffer);
          this.handleStreamEvent(event, (text) => {
            fullResponseText = text;
          }, (toolName) => {
            lastToolName = toolName;
          }, {
            getStreamText: () => streamingText,
            setStreamText: (t: string) => { streamingText = t; },
            getMsgId: () => streamingMsgId,
            setMsgId: (id: number) => { streamingMsgId = id; },
            getIsThinking: () => streamingIsThinking,
            setIsThinking: (v: boolean) => { streamingIsThinking = v; },
            resetStream: () => { streamingText = ''; streamingMsgId = 0; streamingIsThinking = false; },
          });
        } catch {}
      }

      // If we have response text, record in history
      if (fullResponseText) {
        this.history.push({
          role: 'assistant',
          text: fullResponseText,
          id: this.nextMsgId++,
        });
      }

      // Check for new/modified previewable files and hint preview
      if (isCurrentChild) {
        const previewUrl = this.checkForNewPreviewFile();
        if (previewUrl) {
          this.broadcast({ type: 'preview_hint', url: previewUrl });
        }
        this.broadcast({ type: 'state', state: 'ready' });
      }

      if (code !== 0 && code !== null) {
        console.error(`[claude-process] ${this.sessionId} exited with code ${code}`);
      }
    });

    child.on('error', (err) => {
      if (this.activeChild !== child) return;  // replaced by newer child
      this.activeChild = null;
      console.error(`[claude-process] ${this.sessionId} spawn error:`, err.message);
      this.broadcast({ type: 'state', state: 'error' });
    });
  }

  private handleStreamEvent(
    event: any,
    setResponseText: (text: string) => void,
    setToolName: (name: string) => void,
    stream: {
      getStreamText: () => string;
      setStreamText: (t: string) => void;
      getMsgId: () => number;
      setMsgId: (id: number) => void;
      getIsThinking: () => boolean;
      setIsThinking: (v: boolean) => void;
      resetStream: () => void;
    },
  ): void {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system': {
        if (event.session_id) {
          this.claudeSessionId = event.session_id;
          this.saveState();
        }
        break;
      }

      case 'stream_event': {
        const ev = event.event;
        if (!ev) break;

        if (ev.type === 'content_block_start') {
          // New content block starting — could be text or tool_use
          if (ev.content_block?.type === 'tool_use') {
            stream.setIsThinking(true);
            const toolName = ev.content_block.name || 'tool';
            setToolName(toolName);
            this._lastStreamToolName = toolName;
            this._toolJsonBuf = '';
            this.broadcast({ type: 'tool', name: toolName, detail: '', status: 'running' });
            this.broadcast({ type: 'state', state: 'tool_running' });
          } else if (ev.content_block?.type === 'text') {
            // Start of text block — allocate message ID
            if (!stream.getMsgId()) {
              stream.setMsgId(this.nextMsgId++);
              // Send initial empty message to create the bubble
              this.broadcast({
                type: 'message',
                id: stream.getMsgId(),
                role: 'assistant',
                text: '',
                thinking: stream.getIsThinking(),
              });
            }
          }
        } else if (ev.type === 'content_block_delta') {
          const delta = ev.delta;
          if (delta?.type === 'text_delta' && delta.text) {
            // Accumulate text and send delta to client
            stream.setStreamText(stream.getStreamText() + delta.text);
            if (stream.getMsgId()) {
              this.broadcast({
                type: 'message_delta',
                id: stream.getMsgId(),
                delta: delta.text,
              });
            }
          } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
            // Accumulate tool input JSON to extract detail early
            if (!this._toolJsonBuf) this._toolJsonBuf = '';
            this._toolJsonBuf += delta.partial_json;
            // Try to extract detail from partial JSON
            const buf = this._toolJsonBuf;
            let detail = '';
            // file_path: "..."
            const fpMatch = buf.match(/"file_path"\s*:\s*"([^"]+)"/);
            if (fpMatch) detail = fpMatch[1].replace(/^.*\//, '');
            // command: "..."
            if (!detail) {
              const cmdMatch = buf.match(/"command"\s*:\s*"([^"]{1,60})/);
              if (cmdMatch) detail = cmdMatch[1];
            }
            // query/pattern: "..."
            if (!detail) {
              const qMatch = buf.match(/"(?:query|pattern|url)"\s*:\s*"([^"]{1,60})/);
              if (qMatch) detail = qMatch[1];
            }
            if (detail) {
              const lastTool = this._lastStreamToolName || 'tool';
              this.broadcast({ type: 'tool', name: lastTool, detail, status: 'running' });
            }
          }
        } else if (ev.type === 'content_block_stop') {
          // Block finished — text will be finalized in the 'assistant' event
        }
        break;
      }

      case 'assistant': {
        // Complete assistant message — finalize streaming
        const content = event.message?.content;
        if (!Array.isArray(content)) break;

        const textParts: string[] = [];
        let hasToolUse = false;
        for (const block of content) {
          if (block.type === 'text' && block.text) {
            textParts.push(block.text);
          } else if (block.type === 'tool_use') {
            hasToolUse = true;
            const toolName = block.name || 'tool';
            setToolName(toolName);
            let detail = '';
            if (typeof block.input === 'object' && block.input) {
              const inp = block.input as Record<string, unknown>;
              if (inp.file_path) detail = String(inp.file_path).replace(/^.*\//, '');
              else if (inp.command) detail = String(inp.command).substring(0, 60);
              else if (inp.pattern) detail = String(inp.pattern).substring(0, 60);
            }
            // Update tool with detail (streaming only had the name)
            this.broadcast({ type: 'tool', name: toolName, detail, status: 'running' });
          }
        }

        if (textParts.length > 0) {
          const text = textParts.join('\n').trim();
          setResponseText(text);

          // If we already streamed this text, just send a final update to ensure consistency
          if (stream.getMsgId()) {
            // Send final complete message to reconcile any missed deltas
            this.broadcast({
              type: 'message',
              id: stream.getMsgId(),
              role: 'assistant',
              text,
              thinking: hasToolUse,
            });
          } else {
            // No streaming happened (shouldn't occur with --include-partial-messages, but fallback)
            const msgId = this.nextMsgId++;
            this.broadcast({
              type: 'message',
              id: msgId,
              role: 'assistant',
              text,
              thinking: hasToolUse,
            });
          }
        }

        // Reset streaming state for next turn
        stream.resetStream();
        if (hasToolUse) {
          stream.setIsThinking(true);
        }
        break;
      }

      case 'user': {
        const userContent = event.message?.content;
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              this.broadcast({ type: 'tool', name: '', detail: '', status: 'done' });
            }
          }
        }
        stream.resetStream();
        this.broadcast({ type: 'state', state: 'thinking' });
        break;
      }

      case 'result': {
        if (event.session_id) {
          this.claudeSessionId = event.session_id;
          this.saveState();
        }
        if (event.subtype === 'error_max_turns') {
          if (event.result) setResponseText(event.result);
        } else if (event.subtype === 'error') {
          const errMsg = event.error || event.result || 'Unknown error';
          console.error(`[claude-process] ${this.sessionId} result error: ${errMsg}`);
        }
        break;
      }
    }
  }

  cancel(): void {
    if (this.activeChild) {
      // Send SIGINT to gracefully stop Claude
      this.activeChild.kill('SIGINT');
      // If it doesn't die in 3s, force kill
      const child = this.activeChild;
      setTimeout(() => {
        if (child && !child.killed) {
          child.kill('SIGKILL');
        }
      }, 3000);
    }
  }

  getHistory(): HistoryEntry[] {
    return [...this.history];
  }

  isActive(): boolean {
    return this.activeChild !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private isPreviewable(name: string): boolean {
    const ext = path.extname(name).toLowerCase();
    return ClaudeProcess.PREVIEW_EXTS.has(ext);
  }

  /** Scan project dir for new/modified previewable files. Returns serve URL of newest changed file, preferring HTML. */
  checkForNewPreviewFile(): string | null {
    try {
      const files = readdirSync(this.projectDir);
      // Collect all previewable files with mtime
      const candidates: { name: string; mtime: number; ext: string }[] = [];
      for (const f of files) {
        if (!this.isPreviewable(f)) continue;
        try {
          const st = statSync(path.join(this.projectDir, f));
          const prevMtime = this._knownPreviewFiles.get(f);
          // Only include new or modified files
          if (prevMtime === undefined || st.mtimeMs > prevMtime) {
            candidates.push({ name: f, mtime: st.mtimeMs, ext: path.extname(f).toLowerCase() });
          }
        } catch {}
      }
      // Update snapshot
      this.snapshotPreviewFiles();
      if (candidates.length === 0) return null;
      // Prefer HTML/HTM, then sort by mtime descending
      candidates.sort((a, b) => {
        const aHtml = (a.ext === '.html' || a.ext === '.htm') ? 1 : 0;
        const bHtml = (b.ext === '.html' || b.ext === '.htm') ? 1 : 0;
        if (aHtml !== bHtml) return bHtml - aHtml;
        return b.mtime - a.mtime;
      });
      const best = candidates[0];
      const project = path.basename(this.projectDir);
      // CSV and MD need a wrapper to render nicely
      if (best.ext === '.csv' || best.ext === '.md') {
        return '/serve/' + project + '/' + best.name + '?render=1';
      }
      return '/serve/' + project + '/' + best.name;
    } catch { return null; }
  }

  /** Snapshot current previewable files */
  snapshotPreviewFiles(): void {
    try {
      const files = readdirSync(this.projectDir);
      for (const f of files) {
        if (!this.isPreviewable(f)) continue;
        try { this._knownPreviewFiles.set(f, statSync(path.join(this.projectDir, f)).mtimeMs); } catch {}
      }
    } catch {}
  }
}

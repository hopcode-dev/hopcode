/**
 * ClaudeProcess — manages claude -p subprocess for Easy Mode.
 * Each user message spawns a new `claude -p` process with structured JSON output.
 * Multi-turn handled via --resume with the session UUID from the first response.
 */

import { spawn, ChildProcess } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
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
    ];

    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }

    // Ensure project directory exists
    try { mkdirSync(this.projectDir, { recursive: true }); } catch {}

    // Spawn claude process
    const env = { ...process.env };
    delete env.CLAUDECODE;  // prevent child inheriting parent's claude-code session

    console.log(`[claude-process] ${this.sessionId} spawning: claude ${args.slice(0, 3).join(' ')}... cwd=${this.projectDir}`);
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

      // Signal ready only if this is still the current child
      if (isCurrentChild) {
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
  ): void {
    if (!event || !event.type) return;

    switch (event.type) {
      case 'system': {
        // Capture session ID for --resume on subsequent messages
        if (event.session_id) {
          this.claudeSessionId = event.session_id;
          this.saveState();
        }
        break;
      }

      case 'assistant': {
        // Extract text and tool_use from content blocks
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
            // Extract a human-readable detail from the tool input
            let detail = '';
            if (typeof block.input === 'object' && block.input) {
              const inp = block.input as Record<string, unknown>;
              // Show file path for file tools, command for Bash, pattern for search
              if (inp.file_path) detail = String(inp.file_path).replace(/^.*\//, '');
              else if (inp.command) detail = String(inp.command).substring(0, 60);
              else if (inp.pattern) detail = String(inp.pattern).substring(0, 60);
            }
            this.broadcast({
              type: 'tool',
              name: toolName,
              detail,
              status: 'running',
            });
            this.broadcast({ type: 'state', state: 'tool_running' });
          }
        }

        if (textParts.length > 0) {
          const text = textParts.join('\n').trim();
          setResponseText(text);
          const msgId = this.nextMsgId++;
          // Text in same turn as tool_use = thinking/self-talk
          this.broadcast({
            type: 'message',
            id: msgId,
            role: 'assistant',
            text,
            thinking: hasToolUse,
          });
        }
        break;
      }

      case 'user': {
        // Tool results — Claude finished a tool, about to think again
        const userContent = event.message?.content;
        if (Array.isArray(userContent)) {
          for (const block of userContent) {
            if (block.type === 'tool_result') {
              const toolName = block.tool_use_id ? '' : 'tool';
              this.broadcast({
                type: 'tool',
                name: toolName,
                detail: '',
                status: 'done',
              });
            }
          }
        }
        // Back to thinking for next turn
        this.broadcast({ type: 'state', state: 'thinking' });
        break;
      }

      case 'result': {
        // Capture session ID from result for subsequent --resume
        if (event.session_id) {
          this.claudeSessionId = event.session_id;
          this.saveState();
        }

        if (event.subtype === 'error_max_turns') {
          // Claude hit max turns, treat as normal completion
          if (event.result) {
            setResponseText(event.result);
          }
        } else if (event.subtype === 'error') {
          const errMsg = event.error || event.result || 'Unknown error';
          console.error(`[claude-process] ${this.sessionId} result error: ${errMsg}`);
        }
        // ready state is sent on process close
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
}

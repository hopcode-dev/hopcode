/**
 * ClaudeProcess — manages claude -p subprocess for Easy Mode.
 * Each user message spawns a new `claude -p` process with structured JSON output.
 * Multi-turn handled via --resume with the session UUID from the first response.
 */

import { spawn, execFileSync, ChildProcess } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, unlinkSync } from 'fs';
import * as path from 'path';
import * as os from 'os';

const MCP_SERVER_SCRIPT = path.resolve(import.meta.dirname || __dirname, 'task-mcp-server.ts');
const BROWSER_MCP_SERVER_SCRIPT = path.resolve(import.meta.dirname || __dirname, 'browser-mcp-server.ts');
const WECHAT_MCP_SERVER_SCRIPT = path.resolve(import.meta.dirname || __dirname, 'wechat-mcp-server.ts');
const YUYI_SALES_MCP_SERVER_SCRIPT = path.resolve(import.meta.dirname || __dirname, 'yuyi-sales-mcp-server.ts');
const TESLA_MCP_SERVER_SCRIPT = '/home/chief/chief-workspace/tesla/mcp-server.mjs';
const SEARCH_MCP_SERVER_SCRIPT = path.resolve(import.meta.dirname || __dirname, 'search-mcp-server.ts');
import type { EasyServerMessage } from './protocol.js';
import { VersionTracker } from './version-tracker.js';

interface HistoryEntry {
  role: 'user' | 'assistant';
  text: string;
  id: number;
  sender?: string;
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
  private _knownAllFiles = new Set<string>(); // track all files to detect new ones
  private static PREVIEW_EXTS = new Set(['.html', '.htm', '.svg', '.csv', '.md', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
  private static PREVIEW_EXCLUDE = new Set(['claude.md', 'readme.md', 'license.md', 'changelog.md', 'contributing.md', 'code_of_conduct.md']);
  private _writtenFiles = new Set<string>(); // files Claude wrote via Write/Edit tools
  versionTracker: VersionTracker;
  // File types that are useful but browsers can't render — worth suggesting HTML preview
  private static SUGGEST_PREVIEW_EXTS = new Set([
    '.py', '.js', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml',
    '.xml', '.sql', '.sh', '.bash', '.zsh', '.go', '.rs', '.java', '.kt',
    '.c', '.cpp', '.h', '.rb', '.php', '.swift', '.r', '.lua', '.dart',
    '.css', '.scss', '.less', '.txt', '.log', '.env', '.ini', '.cfg',
    '.xlsx', '.xls', '.docx', '.doc', '.pptx', '.ppt',
  ]);
  lastPreviewUrl: string | null = null;
  previewUrls: string[] = [];  // all preview URLs in order (newest first)
  private _pendingContext: string[] = [];  // skipped messages to prepend on next Claude call
  private _lastSender = 'xiaoma';  // track who triggered the current Claude response
  private _messageQueue: { text: string; sender?: string; mentions?: string[]; participantCount: number }[] = [];
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleNotified = false;
  private static IDLE_TIMEOUT = 2 * 60 * 1000; // 2 min without output = stuck

  private stateFile: string;
  owner: string = '';
  linuxUser: string = '';
  providerEnv: Record<string, string> = {};

  constructor(
    sessionId: string,
    projectDir: string,
    onMessage: (msg: EasyServerMessage) => void,
  ) {
    this.sessionId = sessionId;
    this.projectDir = projectDir;
    this.listeners.add(onMessage);
    this.stateFile = path.join(projectDir, '.easy-state.json');
    this.versionTracker = new VersionTracker(projectDir);
    this.versionTracker.init().catch(e => console.error(`[version-tracker] init failed: ${e}`));
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
      if (Array.isArray(data.history)) {
        this.history = data.history;
        // Restore nextMsgId to be higher than any existing id
        for (const h of this.history) {
          if (h.id >= this.nextMsgId) this.nextMsgId = h.id + 1;
        }
      }
      if (data.lastPreviewUrl) this.lastPreviewUrl = data.lastPreviewUrl;
      if (Array.isArray(data.previewUrls)) this.previewUrls = data.previewUrls;
    } catch {}

    // Clean out any saved preview URLs pointing to excluded files (e.g. CLAUDE.md)
    const isExcludedUrl = (url: string) => {
      const filename = url.split('/').pop()?.split('?')[0] || '';
      return ClaudeProcess.PREVIEW_EXCLUDE.has(filename.toLowerCase()) || filename.startsWith('.');
    };
    this.previewUrls = this.previewUrls.filter(u => !isExcludedUrl(u));
    if (this.lastPreviewUrl && isExcludedUrl(this.lastPreviewUrl)) {
      this.lastPreviewUrl = this.previewUrls[0] || null;
    }

    // If no saved preview URL, scan for existing previewable files
    if (!this.lastPreviewUrl) {
      this.snapshotPreviewFiles();
      // Find the best existing previewable file in workspace/ (prefer HTML, newest mtime)
      try {
        const wsDir = this.workspaceDir;
        const files = readdirSync(wsDir);
        const candidates: { name: string; mtime: number; ext: string }[] = [];
        for (const f of files) {
          if (!this.isPreviewable(f)) continue;
          try {
            const st = statSync(path.join(wsDir, f));
            candidates.push({ name: f, mtime: st.mtimeMs, ext: path.extname(f).toLowerCase() });
          } catch {}
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => {
            const aHtml = (a.ext === '.html' || a.ext === '.htm') ? 1 : 0;
            const bHtml = (b.ext === '.html' || b.ext === '.htm') ? 1 : 0;
            if (aHtml !== bHtml) return bHtml - aHtml;
            return b.mtime - a.mtime;
          });
          const best = candidates[0];
          const project = path.basename(this.projectDir);
          const prefix = wsDir !== this.projectDir ? 'workspace/' : '';
          const url = (best.ext === '.csv' || best.ext === '.md')
            ? '/serve/' + project + '/' + prefix + best.name + '?render=1'
            : '/serve/' + project + '/' + prefix + best.name;
          this.addPreviewUrl(url);
          this.saveState();
        }
      } catch {}
    }
  }

  private addPreviewUrl(url: string): void {
    const idx = this.previewUrls.indexOf(url);
    if (idx >= 0) this.previewUrls.splice(idx, 1);
    this.previewUrls.unshift(url);
    if (this.previewUrls.length > 20) this.previewUrls.length = 20;
    this.lastPreviewUrl = url;
  }

  private saveState(): void {
    const data = JSON.stringify({
      claudeSessionId: this.claudeSessionId,
      history: this.history,
      lastPreviewUrl: this.lastPreviewUrl,
      previewUrls: this.previewUrls,
    });
    try {
      writeFileSync(this.stateFile, data, 'utf-8');
    } catch {
      // hopcode can't write to user project dirs — use sudo
      if (this.linuxUser && this.linuxUser !== 'root') {
        try {
          execFileSync('sudo', ['-u', this.linuxUser, 'tee', this.stateFile], {
            input: data, timeout: 3000, stdio: ['pipe', 'ignore', 'ignore'],
          });
        } catch {}
      }
    }
  }

  sendMessage(text: string, sender?: string, mentions?: string[], participantCount: number = 1): void {
    if (this.disposed) return;

    // Record user message in history and persist
    const userEntry: HistoryEntry = { role: 'user', text, id: this.nextMsgId++, sender };
    this.history.push(userEntry);
    this.saveState();

    // Broadcast user_message to all listeners (including sender — client waits for echo)
    this.broadcast({ type: 'user_message', id: userEntry.id, sender: sender || 'user', text });

    // Decide whether to invoke Claude:
    // - Single user: always invoke
    // - Multi-user (2+): invoke if @小码, OR if last message was from assistant (reply to 小码)
    //   Skip if @other_user without @小码, or unrelated chat
    const aiNames = ['小码', 'xiaoma'];
    const mentionsAI = mentions && mentions.some(m => aiNames.includes(m.toLowerCase()));
    if (participantCount > 1 && !mentionsAI) {
      // Check if this is a follow-up to 小码's last response (no @ but clearly replying to AI)
      const lastEntry = this.history.length >= 2 ? this.history[this.history.length - 2] : null; // -2 because current msg is already pushed
      const followingAssistant = lastEntry && lastEntry.role === 'assistant';
      const mentionsOther = mentions && mentions.length > 0; // explicitly @someone else
      if (!followingAssistant || mentionsOther) {
        // Pure human chat — skip Claude, buffer for context
        const contextLine = sender ? `[${sender}]: ${text}` : text;
        this._pendingContext.push(contextLine);
        this.broadcast({ type: 'state', state: 'ready' });
        return;
      }
      // followingAssistant && !mentionsOther → treat as reply to 小码, invoke Claude
    }

    // If Claude is busy, queue the message instead of killing the active process
    if (this.activeChild) {
      this._messageQueue.push({ text, sender, mentions, participantCount });
      console.log(`[claude-process] ${this.sessionId} queued message (${this._messageQueue.length} in queue) while claude is busy`);
      this.broadcast({ type: 'state', state: 'queued' });
      return;
    }

    this._spawnClaude(text, sender, mentions, participantCount);
  }

  /** Internal: spawn a claude -p subprocess with the given prompt */
  private _spawnClaude(text: string, sender?: string, mentions?: string[], participantCount: number = 1): void {
    // Track who triggered this Claude response (for version commit attribution)
    if (sender) this._lastSender = sender;
    // Notify client: thinking state
    this.broadcast({ type: 'state', state: 'thinking' });

    // Build prompt prefix based on @ mentions
    // Format: [sender → @小码]: text | [sender → @alice]: text | [sender]: text
    let promptText: string;
    if (sender) {
      if (mentions && mentions.length > 0) {
        const mentionStr = mentions.map(m => '@' + m).join(' ');
        promptText = `[${sender} → ${mentionStr}]: ${text}`;
      } else {
        promptText = `[${sender}]: ${text}`;
      }
    } else {
      promptText = text;
    }

    // Append any buffered context from skipped messages (as context block after the main message)
    if (this._pendingContext.length > 0) {
      const contextBlock = '\n\n[Recent chat while you were not mentioned:\n'
        + this._pendingContext.join('\n')
        + '\n]';
      promptText = promptText + contextBlock;
      this._pendingContext = [];
    }

    // Write MCP config for task scheduler (use absolute tsx path so non-root users don't need npx install)
    const tsxPath = path.resolve(import.meta.dirname || __dirname, '../../node_modules/.bin/tsx');
    const mcpConfig = {
      mcpServers: {
        'hopcode-tasks': {
          command: tsxPath,
          args: [MCP_SERVER_SCRIPT],
          env: {
            TASK_USER_HOME: this.linuxUser
              ? (this.linuxUser === 'root' ? '/root' : `/home/${this.linuxUser}`)
              : (process.env.HOME || '/root'),
          },
        },
        'browser-proxy': {
          command: tsxPath,
          args: [BROWSER_MCP_SERVER_SCRIPT],
        },
        'wechat': {
          command: tsxPath,
          args: [WECHAT_MCP_SERVER_SCRIPT],
        },
        'yuyi-sales': {
          command: tsxPath,
          args: [YUYI_SALES_MCP_SERVER_SCRIPT],
        },
        'search': {
          command: tsxPath,
          args: [SEARCH_MCP_SERVER_SCRIPT],
          env: {
            SEARXNG_URL: 'http://localhost:8888',
          },
        },
        // Tesla MCP - only for jack and root
        ...((['jack', 'root'].includes(this.owner)) ? {
          'tesla': {
            command: 'node',
            args: [TESLA_MCP_SERVER_SCRIPT],
          },
        } : {}),
      },
    };
    // Write to a tmp dir we control (hopcode service user can't write to user project dirs)
    const tmpDir = path.join(os.tmpdir(), 'hopcode-mcp');
    try { mkdirSync(tmpDir, { recursive: true }); } catch {}
    const mcpConfigPath = path.join(tmpDir, `${this.sessionId}.json`);
    try { writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig)); } catch {}

    // Build command args
    // Only pass --model if providerEnv has a base URL (i.e. ctok/custom provider).
    // For users with MiniMax configured in their own settings.json, let the settings take effect.
    const modelArg = this.providerEnv.ANTHROPIC_BASE_URL
      ? [(this.providerEnv.ANTHROPIC_DEFAULT_SONNET_MODEL ? 'sonnet' : 'MiniMax-M2.7-highspeed')]
      : [];
    const args = [
      '-p', promptText,
      '--output-format', 'stream-json',
      '--verbose',
      ...(modelArg.length ? ['--model', modelArg[0]] : []),
      '--include-partial-messages',
      '--mcp-config', mcpConfigPath,
      '--allowedTools',
      'mcp__hopcode-tasks__schedule_task', 'mcp__hopcode-tasks__list_tasks', 'mcp__hopcode-tasks__delete_task', 'mcp__hopcode-tasks__activate_task',
      'mcp__browser-proxy__browser_open', 'mcp__browser-proxy__browser_screenshot', 'mcp__browser-proxy__browser_click', 'mcp__browser-proxy__browser_type', 'mcp__browser-proxy__browser_key', 'mcp__browser-proxy__browser_scroll', 'mcp__browser-proxy__browser_navigate', 'mcp__browser-proxy__browser_evaluate', 'mcp__browser-proxy__browser_cookies', 'mcp__browser-proxy__browser_status', 'mcp__browser-proxy__browser_close', 'mcp__browser-proxy__browser_list',
      'mcp__wechat__wechat_login', 'mcp__wechat__wechat_status', 'mcp__wechat__wechat_send', 'mcp__wechat__wechat_read', 'mcp__wechat__wechat_contacts', 'mcp__wechat__wechat_search',
      ...(['jack', 'root', 'alex'].includes(this.owner) ? ['mcp__yuyi-sales__sales_attendance', 'mcp__yuyi-sales__sales_bd_activity', 'mcp__yuyi-sales__sales_shipment_stats', 'mcp__yuyi-sales__sales_activation_stats', 'mcp__yuyi-sales__sales_order_stats', 'mcp__yuyi-sales__sales_team_overview', 'mcp__yuyi-sales__sales_dealer_ranking', 'mcp__yuyi-sales__sales_daily_report'] : []),
      ...(['jack', 'root'].includes(this.owner) ? ['mcp__tesla__check_battery', 'mcp__tesla__wake_vehicle'] : []),
      'mcp__search__web_search',
      'mcp__search__news_search',
      '--append-system-prompt',
      `You are 小码 (Xiaoma), a friendly action-oriented AI assistant in Hopcode Easy Mode. When users confirm or agree (好的/试试/做吧/go ahead/ok), START DOING THE WORK immediately — write code, create files. Never just say "ok let me know". Be concise — this is a mobile chat UI. Reply in the same language as the user.

## File organization
- Final output (HTML, CSS, JS, images) → write to workspace/ subdirectory
- Working files (downloads, temp scripts, node_modules, backend code) → project root
- Never default to generic names like index.html. Name files to reflect the user's intent (e.g. workspace/weather-dashboard.html, workspace/doctor-consult.html)

## Image messages
When users send images via WeChat Work, the image is saved locally and the message contains the file path like [用户发送了一张图片: /path/to/image.jpg]. Use the Read tool to view the image and respond based on its content. You CAN read image files (PNG, JPG, etc.) — just use Read with the file path.

## Multi-user @ mention rules
Messages are formatted as: [sender → @mentions]: text  or  [sender]: text
- When @小码 appears in the message → you MUST respond (you were directly addressed)
- When a message immediately follows YOUR previous response and has no @ → treat it as a reply to you, respond normally
- When a message has no @ mentions and doesn't follow your response → read and understand for context, but only respond if the content clearly requires your input (e.g., a coding question, a request for help)
- When @someone_else appears without @小码 → stay silent unless the content directly involves work you are doing
- When in doubt, stay silent — it's better to wait to be asked than to interrupt a human conversation

## Scheduled tasks — MUST use MCP tools
IMPORTANT: You have MCP tools (schedule_task, list_tasks, delete_task, activate_task) for managing scheduled tasks. You MUST use these tools. NEVER write tasks.json directly — the MCP server handles it.
- One-shot timers ("30分钟后提醒") → schedule_task(type="delay", delay_minutes=30, ...)
- Recurring ("每天9点") → schedule_task(type="cron", cron_expr="0 9 * * *", ...)
- Fixed intervals ("每30分钟") → schedule_task(type="every", interval_minutes=30, ...)
- Tasks are per-user (not per-project) — they persist across project switches
- Only session owner can create tasks. If a guest asks, tell them to register.`,
    ];

    if (this.claudeSessionId) {
      args.push('--resume', this.claudeSessionId);
    }

    // Ensure project directory exists (create as the linux user if needed)
    try { mkdirSync(this.projectDir, { recursive: true }); } catch {
      if (this.linuxUser && this.linuxUser !== 'root') {
        try { execFileSync('sudo', ['-u', this.linuxUser, 'mkdir', '-p', this.projectDir], { timeout: 3000 }); } catch {}
      }
    }

    // Each user gets an isolated HOME so their ~/.claude/ session state, history,
    // and session-env files don't mix with other users running under the same process.
    // providerEnv may override HOME again (e.g. ctok uses its own directory).
    let claudeHome: string;
    if (this.providerEnv.HOME) {
      // Provider already sets a custom HOME (e.g. ctok)
      claudeHome = this.providerEnv.HOME;
    } else if (this.linuxUser && this.linuxUser !== 'root') {
      claudeHome = `/root/.claude-users/${this.linuxUser}`;
    } else {
      claudeHome = process.env.HOME || '/root';
    }

    // Bootstrap the isolated claude home on first use
    if (claudeHome !== (process.env.HOME || '/root')) {
      try {
        const settingsPath = `${claudeHome}/.claude/settings.json`;
        let needsBootstrap = false;
        try { readFileSync(settingsPath); } catch { needsBootstrap = true; }
        if (needsBootstrap) {
          mkdirSync(`${claudeHome}/.claude`, { recursive: true });
          const rootSettings = readFileSync('/root/.claude/settings.json', 'utf-8');
          writeFileSync(settingsPath, rootSettings);
          try {
            const mmKey = readFileSync('/root/.claude/minimax.key', 'utf-8');
            writeFileSync(`${claudeHome}/.claude/minimax.key`, mmKey);
          } catch {}
          try {
            const creds = readFileSync('/root/.claude/.credentials.json', 'utf-8');
            writeFileSync(`${claudeHome}/.claude/.credentials.json`, creds);
          } catch {}
          // chown entire claudeHome to the service process user so claude can read/write it
          try { execFileSync('chown', ['-R', 'hopcode:hopcode', claudeHome]); } catch {}
          console.log(`[claude-process] bootstrapped claude home for ${this.linuxUser}: ${claudeHome}`);
        }
      } catch (e) {
        console.error(`[claude-process] failed to bootstrap claude home for ${this.linuxUser}:`, e);
      }
    }

    // Spawn claude process (always as root — claude auth is under root's config)
    const env = { ...process.env, HOME: claudeHome, ...this.providerEnv };
    delete env.CLAUDECODE;  // prevent child inheriting parent's claude-code session
    // Remove empty-string overrides (used by ctok provider to clear MiniMax vars)
    for (const key of Object.keys(env)) {
      if (env[key] === '') delete env[key];
    }

    console.log(`[claude-process] ${this.sessionId} spawning: claude ${args.join(' ').substring(0, 200)} cwd=${this.projectDir} resume=${this.claudeSessionId || 'none'}`);
    console.log(`[claude-process] ${this.sessionId} ANTHROPIC_BASE_URL=${env.ANTHROPIC_BASE_URL} ANTHROPIC_MODEL=${env.ANTHROPIC_MODEL} providerEnv=${JSON.stringify(this.providerEnv)}`);
    const child = spawn(process.env.CLAUDE_BIN || 'claude', args, {
      cwd: this.projectDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.activeChild = child;
    console.log(`[claude-process] ${this.sessionId} spawned pid=${child.pid}`);

    // Idle detection: notify if no output for IDLE_TIMEOUT
    this._idleNotified = false;
    this._resetIdleTimer(child);

    let stdoutBuffer = '';
    let fullResponseText = '';
    let lastToolName = '';
    // Streaming state: accumulate deltas and broadcast incrementally
    let streamingText = '';
    let streamingMsgId = 0;
    let streamingIsThinking = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      this._resetIdleTimer(child);
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
      // Clear idle timer
      if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
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

      // If we have response text, record in history and persist
      if (fullResponseText) {
        this.history.push({
          role: 'assistant',
          text: fullResponseText,
          id: this.nextMsgId++,
        });
        this.saveState();
      }

      // Auto-commit workspace changes after Claude response
      if (isCurrentChild && fullResponseText) {
        const files = [...this._writtenFiles];
        const commitMsg = files.length > 0
          ? `Updated ${files.join(', ')}`
          : fullResponseText.slice(0, 80);
        this.versionTracker.commit(commitMsg, this._lastSender || 'xiaoma').catch(() => {});
      }

      // Check for new/modified previewable files and hint preview
      if (isCurrentChild) {
        const previewUrl = this.checkForNewPreviewFile();
        if (previewUrl) {
          this.addPreviewUrl(previewUrl);
          this.saveState();
          this.broadcast({ type: 'preview_hint', url: previewUrl });
        }

        // If no previewable file found, check for non-previewable files worth suggesting
        if (!previewUrl) {
          const suggestFile = this.checkForNonPreviewableFiles();
          if (suggestFile) {
            this.broadcast({ type: 'preview_suggest', filename: suggestFile });
          }
        }

        // Drain message queue: combine all queued messages and send to Claude
        if (this._messageQueue.length > 0) {
          const queued = this._messageQueue.splice(0);
          console.log(`[claude-process] ${this.sessionId} draining ${queued.length} queued messages`);

          let combinedText: string;
          if (queued.length === 1) {
            // Single queued message — send as-is
            const q = queued[0];
            combinedText = q.sender ? `[${q.sender}]: ${q.text}` : q.text;
          } else {
            // Multiple queued messages — format with order and dedup instructions
            const lines: string[] = [];
            lines.push(`[${queued.length} messages arrived while you were working. Read all in order (#1 earliest → #${queued.length} latest), then decide how to proceed. If the requests are clear and compatible, go ahead and execute. If there are contradictions, ambiguity, or you're unsure what the group actually wants, ask the group to clarify BEFORE doing any work.]`);
            for (let i = 0; i < queued.length; i++) {
              const q = queued[i];
              const prefix = q.sender ? `[${q.sender}]` : '';
              lines.push(`#${i + 1} ${prefix}: ${q.text}`);
            }
            combinedText = lines.join('\n');
          }

          const lastMsg = queued[queued.length - 1];
          this._spawnClaude(combinedText, undefined, lastMsg.mentions, lastMsg.participantCount);
        } else {
          this.broadcast({ type: 'state', state: 'ready' });
        }
      }

      if (isCurrentChild && code !== null && !fullResponseText) {
        if (code !== 0) {
          console.error(`[claude-process] ${this.sessionId} crashed with code ${code}`);
          // If resume failed (stale session), clear sessionId so next attempt starts fresh
          if (this.claudeSessionId) {
            console.log(`[claude-process] ${this.sessionId} clearing stale claudeSessionId ${this.claudeSessionId}`);
            this.claudeSessionId = null;
            this.saveState();
          }
          this.broadcast({ type: 'error', message: `Claude exited unexpectedly (code ${code}). You can retry your message.` });
        }
        // code=0 with no response: auth error already broadcast via result event
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
            if (fpMatch) {
              detail = fpMatch[1].replace(/^.*\//, '');
              // Track files Claude writes via Write/Edit (only in workspace/)
              const curTool = this._lastStreamToolName || '';
              if (curTool === 'Write' || curTool === 'Edit') {
                const filePath = fpMatch[1];
                if (filePath.includes('/workspace/') || filePath.startsWith('workspace/')) {
                  this._writtenFiles.add(path.basename(filePath));
                }
              }
            }
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
              if (inp.file_path) {
                detail = String(inp.file_path).replace(/^.*\//, '');
                // Track files Claude intentionally writes (Write/Edit tools, only in workspace/)
                if (toolName === 'Write' || toolName === 'Edit') {
                  const fp = String(inp.file_path);
                  if (fp.includes('/workspace/') || fp.startsWith('workspace/')) {
                    this._writtenFiles.add(path.basename(fp));
                  }
                }
              }
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
          if (!getResponseText()) {
            this.broadcast({ type: 'error', message: `Claude error: ${errMsg}` });
          }
        } else if (event.is_error) {
          const errMsg = event.result || 'Authentication failed — please login via terminal';
          this.broadcast({ type: 'error', message: errMsg });
        }
        break;
      }
    }
  }

  /** Inject a task result into chat history and broadcast to all listeners */
  injectTaskResult(taskName: string, text: string, isDraft: boolean): void {
    const prefix = isDraft ? `📋 测试预览 — ${taskName}` : `⏰ 定时任务 — ${taskName}`;
    const fullText = `${prefix}\n${text}`;

    // Add to history
    const entry: HistoryEntry = {
      role: 'assistant',
      text: fullText,
      id: this.nextMsgId++,
    };
    this.history.push(entry);
    this.saveState();

    // Broadcast as task_result (client renders specially)
    this.broadcast({
      type: 'task_result' as any,
      taskId: '',
      taskName,
      text,
      timestamp: Date.now(),
      isDraft,
    });
  }

  cancel(): void {
    // Clear queued messages — user wants to stop everything
    if (this._messageQueue.length > 0) {
      console.log(`[claude-process] ${this.sessionId} cancel: clearing ${this._messageQueue.length} queued messages`);
      this._messageQueue = [];
    }
    if (this._idleTimer) { clearTimeout(this._idleTimer); this._idleTimer = null; }
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

  /** Retry: find last user message in history and re-send to Claude */
  retry(): void {
    if (this.activeChild) return; // still running, nothing to retry
    // Find the last user message
    for (let i = this.history.length - 1; i >= 0; i--) {
      if (this.history[i].role === 'user') {
        const msg = this.history[i];
        console.log(`[claude-process] ${this.sessionId} retrying last user message: ${msg.text.substring(0, 80)}`);
        this._spawnClaude(msg.text, msg.sender);
        return;
      }
    }
  }

  /** Reset idle timer — called on spawn and on every stdout chunk */
  private _resetIdleTimer(child: ChildProcess): void {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    this._idleNotified = false;
    this._idleTimer = setTimeout(() => {
      if (this.activeChild === child) {
        console.warn(`[claude-process] ${this.sessionId} pid=${child.pid} idle for ${ClaudeProcess.IDLE_TIMEOUT / 1000}s, notifying users`);
        this._idleNotified = true;
        this.broadcast({ type: 'error', message: 'Claude has been idle — it may be stuck.' });
      }
    }, ClaudeProcess.IDLE_TIMEOUT);
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
    if (!ClaudeProcess.PREVIEW_EXTS.has(ext)) return false;
    // Exclude system/config markdown files
    if (ClaudeProcess.PREVIEW_EXCLUDE.has(name.toLowerCase())) return false;
    // Also exclude dotfiles like .claude.md
    if (name.startsWith('.')) return false;
    return true;
  }

  /** Get the workspace directory (output dir). Falls back to project root for old projects. */
  private get workspaceDir(): string {
    const ws = path.join(this.projectDir, 'workspace');
    try { statSync(ws); return ws; } catch { return this.projectDir; }
  }

  /** Scan workspace/ for new/modified previewable files that Claude explicitly wrote. */
  checkForNewPreviewFile(): string | null {
    try {
      const wsDir = this.workspaceDir;
      const files = readdirSync(wsDir);
      // Collect previewable files that Claude intentionally wrote (via Write/Edit tools)
      const candidates: { name: string; mtime: number; ext: string }[] = [];
      for (const f of files) {
        if (!this.isPreviewable(f)) continue;
        // Only auto-preview files Claude explicitly wrote, not downloaded/fetched files
        if (!this._writtenFiles.has(f)) continue;
        try {
          const st = statSync(path.join(wsDir, f));
          const prevMtime = this._knownPreviewFiles.get(f);
          // Only include new or modified files
          if (prevMtime === undefined || st.mtimeMs > prevMtime) {
            candidates.push({ name: f, mtime: st.mtimeMs, ext: path.extname(f).toLowerCase() });
          }
        } catch {}
      }
      // Update snapshot (tracks all files, not just written ones)
      this.snapshotPreviewFiles();
      // Clear written files for next turn
      this._writtenFiles.clear();
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
      // Build serve path: workspace/ prefix only if workspace dir exists
      const prefix = wsDir !== this.projectDir ? 'workspace/' : '';
      // CSV and MD need a wrapper to render nicely
      if (best.ext === '.csv' || best.ext === '.md') {
        return '/serve/' + project + '/' + prefix + best.name + '?render=1';
      }
      return '/serve/' + project + '/' + prefix + best.name;
    } catch { return null; }
  }

  /** Snapshot current previewable files in workspace/ */
  snapshotPreviewFiles(): void {
    try {
      const wsDir = this.workspaceDir;
      const files = readdirSync(wsDir);
      for (const f of files) {
        this._knownAllFiles.add(f);
        if (!this.isPreviewable(f)) continue;
        try { this._knownPreviewFiles.set(f, statSync(path.join(wsDir, f)).mtimeMs); } catch {}
      }
    } catch {}
  }

  /** Check for new files in workspace/ that browsers can't preview — suggest HTML conversion */
  checkForNonPreviewableFiles(): string | null {
    try {
      const wsDir = this.workspaceDir;
      const files = readdirSync(wsDir);
      for (const f of files) {
        if (this._knownAllFiles.has(f)) continue; // not new
        if (f.startsWith('.')) continue;
        const ext = path.extname(f).toLowerCase();
        if (ClaudeProcess.SUGGEST_PREVIEW_EXTS.has(ext)) {
          this._knownAllFiles.add(f);
          return f;
        }
      }
      for (const f of files) this._knownAllFiles.add(f);
    } catch {}
    return null;
  }
}

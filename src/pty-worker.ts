/**
 * PTY Worker — isolated process for a single terminal session
 * Spawned by pty-service.ts via fork()
 * Communicates via IPC messages
 */

process.on('SIGPIPE', () => {});
process.on('uncaughtException', (err) => {
  if ((err as any)?.code === 'EPIPE') return;
  try { console.error('[pty-worker] Uncaught exception:', err.message); } catch {}
  process.exit(1);
});

import * as pty from 'node-pty';
import * as fs from 'fs';
import * as path from 'path';
import xtermHeadless from '@xterm/headless';
const HeadlessTerminal = xtermHeadless.Terminal;
import { SerializeAddon } from '@xterm/addon-serialize';

// --- IPC Message Types ---

interface InitMessage {
  type: 'init';
  sessionId: string;
  owner: string;
  linuxUser?: string;
  name: string;
  cwd?: string;
}

interface InputMessage {
  type: 'input';
  data: string;
}

interface ResizeMessage {
  type: 'resize';
  cols: number;
  rows: number;
}

interface GetScrollbackMessage {
  type: 'getScrollback';
}

interface ShutdownMessage {
  type: 'shutdown';
}

type IncomingMessage = InitMessage | InputMessage | ResizeMessage | GetScrollbackMessage | ShutdownMessage;

// --- Worker State ---

let ptyProcess: pty.IPty | null = null;
let headlessTerm: InstanceType<typeof HeadlessTerminal> | null = null;
let serializeAddon: InstanceType<typeof SerializeAddon> | null = null;
let cursorHidden = false;
let sessionId = '';
let sessionName = '';

// --- Recording (asciicast v2) ---

const RECORDINGS_DIR = path.join(process.cwd(), 'data', 'recordings');
let recordingStream: fs.WriteStream | null = null;
let recordingStart = 0;

function initRecording(cols: number, rows: number, title: string) {
  try {
    fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
    const castPath = path.join(RECORDINGS_DIR, `${sessionId}.cast`);
    recordingStream = fs.createWriteStream(castPath, { flags: 'w' });
    recordingStart = Date.now();
    const header = JSON.stringify({
      version: 2,
      width: cols,
      height: rows,
      timestamp: Math.floor(recordingStart / 1000),
      title,
    });
    recordingStream.write(header + '\n');
    console.log(`[pty-worker] Recording started: ${castPath}`);
  } catch (e: any) {
    console.error(`[pty-worker] Failed to init recording: ${e.message}`);
    recordingStream = null;
  }
}

function recordEvent(type: 'o' | 'i' | 'r', data: string) {
  if (!recordingStream) return;
  const elapsed = (Date.now() - recordingStart) / 1000;
  const line = JSON.stringify([elapsed, type, data]);
  recordingStream.write(line + '\n');
}

function closeRecording() {
  if (recordingStream) {
    try { recordingStream.end(); } catch {}
    recordingStream = null;
    console.log(`[pty-worker] Recording closed: ${sessionId}`);
  }
}

// --- Send message to parent ---

function send(msg: object) {
  if (process.send) {
    process.send(msg);
  }
}

// --- Get CWD of PTY process ---

async function getCwd(): Promise<string> {
  if (!ptyProcess) return process.env.HOME || '/';
  try {
    const pid = ptyProcess.pid;
    // Try to find deepest child process's cwd
    const childrenData = await fs.promises.readFile(`/proc/${pid}/task/${pid}/children`, 'utf-8').catch(() => '');
    const childPids = childrenData.trim().split(/\s+/).filter(Boolean);
    if (childPids.length > 0) {
      let deepest = childPids[childPids.length - 1]!;
      for (let i = 0; i < 5; i++) {
        const gc = await fs.promises.readFile(`/proc/${deepest}/task/${deepest}/children`, 'utf-8').catch(() => '');
        const gcPids = gc.trim().split(/\s+/).filter(Boolean);
        if (gcPids.length === 0) break;
        deepest = gcPids[gcPids.length - 1]!;
      }
      return await fs.promises.readlink(`/proc/${deepest}/cwd`);
    }
    return await fs.promises.readlink(`/proc/${pid}/cwd`);
  } catch {
    return process.env.HOME || '/';
  }
}

// --- Initialize PTY ---

function initPty(msg: InitMessage) {
  sessionId = msg.sessionId;
  sessionName = msg.name;

  if (msg.linuxUser) {
    // Multi-user mode: spawn shell as target Linux user
    ptyProcess = pty.spawn('sudo', ['-i', '-u', msg.linuxUser], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      env: { TERM: 'xterm-256color' },
    });
    // su - resets CWD to home; if project cwd specified, cd into it after shell starts
    if (msg.cwd) {
      setTimeout(() => {
        try { ptyProcess!.write(`cd ${msg.cwd} 2>/dev/null && clear\n`); } catch {}
      }, 500);
    }
  } else {
    // Single-user mode
    ptyProcess = pty.spawn('/bin/bash', ['--login', '-i'], {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd: msg.cwd || process.env.HOME || '/',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([k]) => k !== 'CLAUDECODE')
        ) as { [key: string]: string },
        TERM: 'xterm-256color',
        SHELL: '/bin/bash',
        PS1: '\\[\\033[32m\\]\\u\\[\\033[0m\\]:\\[\\033[34m\\]\\W\\[\\033[0m\\]\\$ ',
      },
    });
  }

  headlessTerm = new HeadlessTerminal({ cols: 120, rows: 30, scrollback: 500, allowProposedApi: true });
  serializeAddon = new SerializeAddon();
  headlessTerm.loadAddon(serializeAddon);

  // Start recording
  initRecording(120, 30, `${sessionName} (${msg.owner})`);

  // Forward PTY output to parent (buffered to reduce flicker from rapid redraws)
  let outputBuf = '';
  let outputTimer: ReturnType<typeof setTimeout> | null = null;
  function flushOutput() {
    if (!outputBuf) return;
    const data = outputBuf;
    outputBuf = '';
    outputTimer = null;
    send({ type: 'output', data });
    recordEvent('o', data);
  }
  ptyProcess.onData((data) => {
    // Track cursor visibility
    if (data.includes('\x1b[?25l')) cursorHidden = true;
    if (data.includes('\x1b[?25h')) cursorHidden = false;
    headlessTerm!.write(data);
    outputBuf += data;
    if (!outputTimer) {
      outputTimer = setTimeout(flushOutput, 40);
    }
  });

  // Notify parent when PTY exits
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[pty-worker] PTY exited: ${sessionId} (code ${exitCode})`);
    closeRecording();
    send({ type: 'exit', code: exitCode });
    // Clean up and exit worker process
    if (headlessTerm) headlessTerm.dispose();
    process.exit(0);
  });

  console.log(`[pty-worker] Initialized: ${sessionId} - ${sessionName}`);
  send({ type: 'ready', name: sessionName });
}

// --- Handle messages from parent ---

process.on('message', async (msg: IncomingMessage) => {
  switch (msg.type) {
    case 'init':
      initPty(msg);
      break;

    case 'input':
      if (ptyProcess) {
        ptyProcess.write(msg.data);
        recordEvent('i', msg.data);
      }
      break;

    case 'resize':
      if (ptyProcess && msg.cols > 0 && msg.rows > 0) {
        if (msg.cols !== ptyProcess.cols || msg.rows !== ptyProcess.rows) {
          try {
            ptyProcess.resize(msg.cols, msg.rows);
            headlessTerm?.resize(msg.cols, msg.rows);
            recordEvent('r', `${msg.cols}x${msg.rows}`);
          } catch {}
        }
      }
      break;

    case 'getScrollback':
      if (serializeAddon) {
        try {
          let data = serializeAddon.serialize({ scrollback: 500 });
          if (cursorHidden) data += '\x1b[?25l';
          send({ type: 'scrollback', data, cursorHidden });
        } catch (e) {
          send({ type: 'scrollback', data: '', cursorHidden: false });
        }
      }
      break;

    case 'shutdown':
      console.log(`[pty-worker] Shutdown requested: ${sessionId}`);
      closeRecording();
      if (ptyProcess) {
        try { ptyProcess.kill(); } catch {}
      }
      setTimeout(() => process.exit(0), 500);
      break;
  }
});

// Handle parent disconnect
process.on('disconnect', () => {
  console.log(`[pty-worker] Parent disconnected, exiting: ${sessionId}`);
  closeRecording();
  if (ptyProcess) {
    try { ptyProcess.kill(); } catch {}
  }
  process.exit(0);
});

// Trim scrollback every hour to prevent memory bloat
setInterval(() => {
  if (headlessTerm && serializeAddon) {
    try {
      const recent = serializeAddon.serialize({ scrollback: 200 });
      headlessTerm.reset();
      headlessTerm.write(recent);
      console.log(`[pty-worker] Trimmed scrollback for ${sessionId}`);
    } catch (e) {
      // Ignore trim errors
    }
  }
}, 60 * 60 * 1000); // 1 hour

console.log('[pty-worker] Started, waiting for init message...');

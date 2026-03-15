#!/usr/bin/env npx tsx
/**
 * MCP Server for Easy Mode Scheduled Tasks.
 * Runs as a subprocess of claude -p, communicates via stdio JSON-RPC.
 * Reads/writes tasks.json in PROJECT_DIR (passed via env).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

const PROJECT_DIR = process.env.TASK_PROJECT_DIR || process.cwd();
const TASKS_FILE = path.join(PROJECT_DIR, 'tasks.json');
const MAX_TASKS = 10;

interface TaskDef {
  id: string;
  name: string;
  schedule: any;
  prompt: string;
  status: 'draft' | 'active';
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number | null;
  lastStatus?: string | null;
  consecutiveErrors?: number;
}

function readTasks(): TaskDef[] {
  try {
    return JSON.parse(fs.readFileSync(TASKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function writeTasks(tasks: TaskDef[]): void {
  fs.mkdirSync(path.dirname(TASKS_FILE), { recursive: true });
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'schedule_task',
    description: `Create a scheduled task. For one-shot timers ("30分钟后提醒"), use type="delay". For recurring ("每天9点"), use type="cron" or type="every". One-shot tasks run immediately as active. Recurring tasks start as draft — system runs a test first, user must approve before activating.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Short human-readable name for the task (e.g. "下班提醒", "天气检查")' },
        type: { type: 'string', enum: ['delay', 'cron', 'every'], description: 'delay=one-shot timer, cron=cron expression, every=fixed interval' },
        delay_minutes: { type: 'number', description: 'For type=delay: minutes from now to execute (e.g. 30, 60, 1440 for 24h)' },
        cron_expr: { type: 'string', description: 'For type=cron: standard 5-field cron expression in Asia/Shanghai timezone (e.g. "0 9 * * *" for daily 9am, "*/30 * * * *" for every 30min)' },
        interval_minutes: { type: 'number', description: 'For type=every: interval in minutes (minimum 1)' },
        prompt: { type: 'string', description: 'The instruction to execute when the task fires. Must be self-contained (>=30 chars) and not depend on conversation context.' },
      },
      required: ['name', 'type', 'prompt'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all scheduled tasks in this project.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'delete_task',
    description: 'Delete a scheduled task by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'activate_task',
    description: 'Activate a draft task after user approves the test run result.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The task ID to activate' },
      },
      required: ['id'],
    },
  },
];

// --- Tool handlers ---

function handleScheduleTask(input: any): string {
  const tasks = readTasks();
  if (tasks.length >= MAX_TASKS) {
    return `Error: Maximum ${MAX_TASKS} tasks reached. Delete some tasks first.`;
  }

  const { name, type, prompt } = input;
  if (!name || !type || !prompt) return 'Error: name, type, and prompt are required.';
  if (prompt.length < 30) return `Error: prompt too short (${prompt.length} chars). Must be ≥30 chars and self-contained.`;

  const id = name.replace(/[^a-zA-Z0-9\u4e00-\u9fff_-]/g, '-').substring(0, 30) + '-' + Date.now().toString(36);
  const now = Date.now();
  let schedule: any;
  let status: 'draft' | 'active';

  switch (type) {
    case 'delay': {
      const mins = input.delay_minutes;
      if (!mins || mins < 0.5) return 'Error: delay_minutes must be at least 0.5 (30 seconds).';
      schedule = { kind: 'delay', delayMs: Math.round(mins * 60 * 1000) };
      status = 'active'; // one-shot → active immediately
      break;
    }
    case 'cron': {
      const expr = input.cron_expr;
      if (!expr) return 'Error: cron_expr is required for type=cron.';
      schedule = { kind: 'cron', expr };
      status = 'draft'; // recurring → draft for test run
      break;
    }
    case 'every': {
      const mins = input.interval_minutes;
      if (!mins || mins < 1) return 'Error: interval_minutes must be at least 1.';
      schedule = { kind: 'every', everyMs: Math.round(mins * 60 * 1000) };
      status = 'draft'; // recurring → draft for test run
      break;
    }
    default:
      return `Error: unknown type "${type}". Use delay, cron, or every.`;
  }

  const task: TaskDef = {
    id,
    name,
    schedule,
    prompt,
    status,
    enabled: true,
    createdAt: now,
  };

  tasks.push(task);
  writeTasks(tasks);

  if (status === 'draft') {
    return `Created DRAFT task "${name}" (id=${id}). The system will run a test now — show the result to the user and ask if they want to activate it. Use activate_task to activate after user approval.`;
  } else {
    const delayMin = Math.round((schedule.delayMs || 0) / 60000);
    return `Created one-shot task "${name}" (id=${id}). It will fire in ${delayMin} minute(s).`;
  }
}

function handleListTasks(): string {
  const tasks = readTasks();
  if (tasks.length === 0) return 'No scheduled tasks.';
  const lines = tasks.map(t => {
    let sched = '';
    if (t.schedule.kind === 'cron') sched = `cron: ${t.schedule.expr}`;
    else if (t.schedule.kind === 'every') sched = `every ${Math.round((t.schedule.everyMs || 0) / 60000)}min`;
    else if (t.schedule.kind === 'delay') {
      const remaining = (t.createdAt + (t.schedule.delayMs || 0)) - Date.now();
      sched = remaining > 0 ? `in ${Math.round(remaining / 60000)}min` : 'pending execution';
    }
    return `- [${t.id}] "${t.name}" | ${sched} | status=${t.status} enabled=${t.enabled}`;
  });
  return lines.join('\n');
}

function handleDeleteTask(input: any): string {
  const tasks = readTasks();
  const idx = tasks.findIndex(t => t.id === input.id);
  if (idx < 0) return `Error: task "${input.id}" not found.`;
  const name = tasks[idx]!.name;
  tasks.splice(idx, 1);
  writeTasks(tasks);
  return `Deleted task "${name}".`;
}

function handleActivateTask(input: any): string {
  const tasks = readTasks();
  const task = tasks.find(t => t.id === input.id);
  if (!task) return `Error: task "${input.id}" not found.`;
  if (task.status === 'active') return `Task "${task.name}" is already active.`;
  task.status = 'active';
  writeTasks(tasks);
  return `Activated task "${task.name}". It is now scheduled and will run according to its schedule.`;
}

// --- JSON-RPC / MCP protocol ---

function sendResponse(id: string | number, result: any): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, result });
  process.stdout.write(msg + '\n');
}

function sendError(id: string | number | null, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  process.stdout.write(msg + '\n');
}

function sendNotification(method: string, params: any): void {
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  process.stdout.write(msg + '\n');
}

function handleRequest(req: any): void {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      sendResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'hopcode-tasks', version: '1.0.0' },
      });
      // Send initialized notification
      sendNotification('notifications/initialized', {});
      break;

    case 'tools/list':
      sendResponse(id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const toolName = params?.name;
      const toolInput = params?.arguments || {};
      let resultText = '';

      try {
        switch (toolName) {
          case 'schedule_task':
            resultText = handleScheduleTask(toolInput);
            break;
          case 'list_tasks':
            resultText = handleListTasks();
            break;
          case 'delete_task':
            resultText = handleDeleteTask(toolInput);
            break;
          case 'activate_task':
            resultText = handleActivateTask(toolInput);
            break;
          default:
            resultText = `Unknown tool: ${toolName}`;
        }
      } catch (e: any) {
        resultText = `Error: ${e.message}`;
      }

      sendResponse(id, {
        content: [{ type: 'text', text: resultText }],
      });
      break;
    }

    case 'notifications/cancelled':
    case 'notifications/initialized':
      // Ignore notifications
      break;

    default:
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
  }
}

// --- Main: read JSON-RPC from stdin ---

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line);
    handleRequest(req);
  } catch (e: any) {
    sendError(null, -32700, `Parse error: ${e.message}`);
  }
});

rl.on('close', () => process.exit(0));

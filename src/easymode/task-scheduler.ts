/**
 * TaskScheduler — manages scheduled/cron tasks for Easy Mode users.
 * Tasks are stored per-user in ~/.hopcode/tasks.json (not per-project).
 * Keyed by owner username — same user with multiple sessions shares one scheduler.
 * Supports: cron expressions, fixed intervals, one-shot timers.
 * Draft workflow: periodic tasks start as draft, auto-test-run, user activates.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { schedule as cronSchedule, validate as cronValidate } from 'node-cron';
import type { ScheduledTask } from 'node-cron';

// --- Types ---

export interface TaskSchedule {
  kind: 'cron' | 'every' | 'at' | 'delay';
  expr?: string;      // cron expression (kind=cron)
  everyMs?: number;    // interval ms (kind=every)
  at?: string;         // ISO 8601 datetime (kind=at)
  delayMs?: number;    // delay from creation time in ms (kind=delay)
}

export interface TaskDef {
  id: string;
  name: string;
  schedule: TaskSchedule;
  prompt: string;
  status: 'draft' | 'active';
  enabled: boolean;
  createdAt: number;
  lastRunAt?: number | null;
  lastStatus?: 'ok' | 'error' | null;
  lastError?: string | null;
  consecutiveErrors?: number;
}

export interface TaskRunResult {
  taskId: string;
  taskName: string;
  text: string;
  timestamp: number;
  isDraft: boolean;
  error?: string;
}

interface ActiveJob {
  task: TaskDef;
  cronJob?: ScheduledTask;
  intervalId?: ReturnType<typeof setInterval>;
  timeoutId?: ReturnType<typeof setTimeout>;
}

type TaskCallback = (result: TaskRunResult) => void;
type CountCallback = (count: number) => void;

const MAX_TASKS = 10;
const TASK_EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_ERRORS = 3;

interface OwnerState {
  userHome: string;
  jobs: Map<string, ActiveJob>;
  watcher?: fs.FSWatcher;
  callbacks: Set<TaskCallback>;       // all session callbacks for this owner
  countCallbacks: Set<CountCallback>;
  /** Directory containing .mcp-config.json for task execution */
  mcpConfigDir?: string;
}

export class TaskScheduler {
  private owners = new Map<string, OwnerState>();

  private tasksFilePath(userHome: string): string {
    return path.join(userHome, '.hopcode', 'tasks.json');
  }

  /**
   * Register a session for task scheduling. If this owner is already loaded,
   * just adds the callback. Otherwise loads tasks and starts scheduling.
   */
  loadForUser(owner: string, userHome: string, callback: TaskCallback, onCountChange?: CountCallback, mcpConfigDir?: string): void {
    let state = this.owners.get(owner);
    if (state) {
      // Owner already loaded — just add this session's callback
      state.callbacks.add(callback);
      if (onCountChange) state.countCallbacks.add(onCountChange);
      if (mcpConfigDir) state.mcpConfigDir = mcpConfigDir;
      // Send current count to new session
      if (onCountChange) onCountChange(this.getActiveCount(owner));
      return;
    }

    // First session for this owner — initialize
    state = {
      userHome,
      jobs: new Map(),
      callbacks: new Set([callback]),
      countCallbacks: onCountChange ? new Set([onCountChange]) : new Set(),
      mcpConfigDir,
    };
    this.owners.set(owner, state);

    const tasks = this.readTasks(userHome);
    this.syncJobs(owner, tasks);
    this.watchTasksFile(owner, userHome);
  }

  /**
   * Remove a session's callback. If no callbacks remain, stop everything for this owner.
   */
  removeCallback(owner: string, callback: TaskCallback, onCountChange?: CountCallback): void {
    const state = this.owners.get(owner);
    if (!state) return;
    state.callbacks.delete(callback);
    if (onCountChange) state.countCallbacks.delete(onCountChange);
    // Don't stop scheduling even if no UI is connected — tasks should keep running
  }

  // --- File I/O ---

  private readTasks(userHome: string): TaskDef[] {
    try {
      const raw = fs.readFileSync(this.tasksFilePath(userHome), 'utf-8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, MAX_TASKS).filter((t: any) =>
        t && t.id && t.name && t.schedule && t.prompt
      );
    } catch {
      return [];
    }
  }

  private writeTasks(userHome: string, tasks: TaskDef[]): void {
    const filePath = this.tasksFilePath(userHome);
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[task-scheduler] Failed to write ${filePath}:`, e);
    }
  }

  // --- Job sync ---

  private syncJobs(owner: string, tasks: TaskDef[]): void {
    const state = this.owners.get(owner);
    if (!state) return;
    const { jobs } = state;
    const prevCount = this.getActiveCount(owner);

    const taskIds = new Set(tasks.map(t => t.id));

    // Remove jobs for deleted tasks
    for (const [id, job] of jobs) {
      if (!taskIds.has(id)) {
        this.stopJob(job);
        jobs.delete(id);
      }
    }

    // Process each task
    for (const task of tasks) {
      const existing = jobs.get(task.id);

      // New draft → auto test run
      if (task.status === 'draft' && task.enabled && !existing) {
        console.log(`[task-scheduler] ${owner} new draft task "${task.name}" — running test`);
        jobs.set(task.id, { task });
        this.executeTask(owner, task, true);
        continue;
      }

      // Not active+enabled → stop if running
      if (task.status !== 'active' || !task.enabled) {
        if (existing) {
          this.stopJob(existing);
          existing.task = task;
        } else {
          jobs.set(task.id, { task });
        }
        continue;
      }

      // Active + enabled
      if (existing) {
        const scheduleChanged = JSON.stringify(existing.task.schedule) !== JSON.stringify(task.schedule);
        existing.task = task;
        if (scheduleChanged) {
          this.stopJob(existing);
          this.startJob(owner, existing);
        }
      } else {
        const job: ActiveJob = { task };
        jobs.set(task.id, job);
        this.startJob(owner, job);
      }
    }

    // Notify if active count changed
    const newCount = this.getActiveCount(owner);
    if (newCount !== prevCount) {
      for (const cb of state.countCallbacks) {
        try { cb(newCount); } catch {}
      }
    }
  }

  // --- Job scheduling ---

  private startJob(owner: string, job: ActiveJob): void {
    const { task } = job;
    const { schedule } = task;

    switch (schedule.kind) {
      case 'cron': {
        if (!schedule.expr || !cronValidate(schedule.expr)) {
          console.warn(`[task-scheduler] Invalid cron expression "${schedule.expr}" for task ${task.id}`);
          return;
        }
        job.cronJob = cronSchedule(schedule.expr, () => {
          this.executeTask(owner, task, false);
        }, { timezone: 'Asia/Shanghai' });
        console.log(`[task-scheduler] ${owner} scheduled cron "${task.name}" [${schedule.expr}]`);
        break;
      }
      case 'every': {
        const ms = schedule.everyMs;
        if (!ms || ms < 10000) {
          console.warn(`[task-scheduler] Invalid interval ${ms}ms for task ${task.id}`);
          return;
        }
        job.intervalId = setInterval(() => {
          this.executeTask(owner, task, false);
        }, ms);
        console.log(`[task-scheduler] ${owner} scheduled every ${ms}ms "${task.name}"`);
        break;
      }
      case 'at': {
        let atStr = schedule.at || '';
        const hasTz = /Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(atStr);
        if (atStr && !hasTz) atStr += 'Z';
        const targetTime = atStr ? new Date(atStr).getTime() : 0;
        const delay = targetTime - Date.now();
        console.log(`[task-scheduler] ${owner} at-task "${task.name}" target=${new Date(targetTime).toISOString()} delay=${Math.round(delay/1000)}s`);
        if (delay <= 0) {
          this.executeTask(owner, task, false);
          return;
        }
        job.timeoutId = setTimeout(() => {
          this.executeTask(owner, task, false);
        }, Math.min(delay, 2147483647));
        break;
      }
      case 'delay': {
        const delayMs = schedule.delayMs;
        if (!delayMs || delayMs < 5000) {
          console.warn(`[task-scheduler] Invalid delay ${delayMs}ms for task ${task.id}`);
          return;
        }
        const elapsed = Date.now() - (task.createdAt || Date.now());
        const remaining = delayMs - elapsed;
        if (remaining <= 0) {
          this.executeTask(owner, task, false);
          return;
        }
        job.timeoutId = setTimeout(() => {
          this.executeTask(owner, task, false);
        }, remaining);
        console.log(`[task-scheduler] ${owner} scheduled delay "${task.name}" in ${Math.round(remaining / 1000)}s`);
        break;
      }
    }
  }

  private stopJob(job: ActiveJob): void {
    if (job.cronJob) { job.cronJob.stop(); job.cronJob = undefined; }
    if (job.intervalId) { clearInterval(job.intervalId); job.intervalId = undefined; }
    if (job.timeoutId) { clearTimeout(job.timeoutId); job.timeoutId = undefined; }
  }

  // --- Task execution ---

  private async executeTask(owner: string, task: TaskDef, isDraft: boolean): Promise<void> {
    const state = this.owners.get(owner);
    if (!state) return;

    const taggedPrompt = isDraft
      ? `[Scheduled task test run "${task.name}"]: ${task.prompt}\n\nThis is a TEST RUN. Execute the task and show the result. The user will review before activating the schedule.`
      : `[Scheduled task "${task.name}"]: ${task.prompt}`;

    console.log(`[task-scheduler] ${owner} executing task "${task.name}" (draft=${isDraft})`);

    try {
      const result = await this.spawnClaudeForTask(state.userHome, taggedPrompt, owner, state.mcpConfigDir);

      if (!isDraft) {
        task.lastRunAt = Date.now();
        task.lastStatus = 'ok';
        task.lastError = null;
        task.consecutiveErrors = 0;
      }

      const runResult: TaskRunResult = {
        taskId: task.id,
        taskName: task.name,
        text: result || '(no output)',
        timestamp: Date.now(),
        isDraft,
      };

      // One-shot tasks: auto-remove after execution
      if (!isDraft && (task.schedule.kind === 'at' || task.schedule.kind === 'delay')) {
        this.removeTaskFromFile(state.userHome, task.id);
      } else if (!isDraft) {
        this.updateTaskInFile(state.userHome, task);
      }

      // Broadcast to all connected sessions for this owner
      for (const cb of state.callbacks) {
        try { cb(runResult); } catch {}
      }
    } catch (err: any) {
      console.error(`[task-scheduler] ${owner} task "${task.name}" failed:`, err.message);

      if (!isDraft) {
        task.lastRunAt = Date.now();
        task.lastStatus = 'error';
        task.lastError = err.message;
        task.consecutiveErrors = (task.consecutiveErrors || 0) + 1;

        if (task.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          task.enabled = false;
          console.warn(`[task-scheduler] ${owner} task "${task.name}" auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        }

        this.updateTaskInFile(state.userHome, task);

        if (!task.enabled) {
          const tasks = this.readTasks(state.userHome);
          this.syncJobs(owner, tasks);
        }
      }

      const runResult: TaskRunResult = {
        taskId: task.id,
        taskName: task.name,
        text: `Task failed: ${err.message}`,
        timestamp: Date.now(),
        isDraft,
        error: err.message,
      };

      for (const cb of state.callbacks) {
        try { cb(runResult); } catch {}
      }
    }
  }

  /**
   * Spawn an isolated claude -p process for task execution.
   */
  private spawnClaudeForTask(userHome: string, prompt: string, owner: string, mcpConfigDir?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const configDir = mcpConfigDir || userHome;
      const mcpConfigPath = path.join(configDir, '.mcp-config.json');
      const hasMcpConfig = fs.existsSync(mcpConfigPath);

      // Owner-based tool whitelist
      const allowedTools: string[] = [
        'mcp__hopcode-tasks__schedule_task', 'mcp__hopcode-tasks__list_tasks', 'mcp__hopcode-tasks__delete_task', 'mcp__hopcode-tasks__activate_task',
        'mcp__browser-proxy__browser_open', 'mcp__browser-proxy__browser_screenshot', 'mcp__browser-proxy__browser_click', 'mcp__browser-proxy__browser_type', 'mcp__browser-proxy__browser_key', 'mcp__browser-proxy__browser_navigate', 'mcp__browser-proxy__browser_evaluate', 'mcp__browser-proxy__browser_cookies', 'mcp__browser-proxy__browser_status', 'mcp__browser-proxy__browser_close', 'mcp__browser-proxy__browser_list', 'mcp__browser-proxy__browser_scroll',
        'mcp__wechat__wechat_login', 'mcp__wechat__wechat_status', 'mcp__wechat__wechat_send', 'mcp__wechat__wechat_read', 'mcp__wechat__wechat_contacts', 'mcp__wechat__wechat_search',
      ];
      if (['jack', 'root'].includes(owner)) {
        allowedTools.push('mcp__tesla__check_battery', 'mcp__tesla__wake_vehicle');
      }
      if (['jack', 'root', 'alex'].includes(owner)) {
        allowedTools.push('mcp__yuyi-sales__sales_attendance', 'mcp__yuyi-sales__sales_bd_activity', 'mcp__yuyi-sales__sales_shipment_stats', 'mcp__yuyi-sales__sales_activation_stats', 'mcp__yuyi-sales__sales_order_stats', 'mcp__yuyi-sales__sales_team_overview', 'mcp__yuyi-sales__sales_dealer_ranking', 'mcp__yuyi-sales__sales_daily_report');
      }

      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', 'sonnet',
        ...(hasMcpConfig ? ['--mcp-config', mcpConfigPath] : []),
        '--allowedTools', ...allowedTools,
      ];

      const env = { ...process.env };
      delete env.CLAUDECODE;

      const child = spawn('claude', args, {
        cwd: userHome,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      let fullText = '';
      let timedOut = false;

      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, TASK_EXECUTION_TIMEOUT);

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text' && block.text) {
                  fullText += (fullText ? '\n' : '') + block.text;
                }
              }
            }
          } catch {}
        }
      });

      child.stderr?.on('data', () => {});

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (timedOut) {
          reject(new Error('Task execution timed out (5 minutes)'));
        } else if (code !== 0 && !fullText) {
          reject(new Error(`claude exited with code ${code}`));
        } else {
          resolve(fullText);
        }
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  // --- File watching ---

  private watchTasksFile(owner: string, userHome: string): void {
    const state = this.owners.get(owner);
    if (!state) return;
    if (state.watcher) state.watcher.close();

    const dir = path.join(userHome, '.hopcode');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}

    let debounce: ReturnType<typeof setTimeout> | null = null;
    try {
      state.watcher = fs.watch(dir, (eventType, filename) => {
        if (filename !== 'tasks.json') return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          console.log(`[task-scheduler] ${owner} tasks.json changed, re-syncing`);
          const tasks = this.readTasks(userHome);
          this.syncJobs(owner, tasks);
        }, 500);
      });
    } catch (e) {
      console.error(`[task-scheduler] Failed to watch ${dir}:`, e);
    }
  }

  // --- File mutations ---

  private updateTaskInFile(userHome: string, task: TaskDef): void {
    const tasks = this.readTasks(userHome);
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...task };
      this.writeTasks(userHome, tasks);
    }
  }

  private removeTaskFromFile(userHome: string, taskId: string): void {
    const tasks = this.readTasks(userHome);
    const filtered = tasks.filter(t => t.id !== taskId);
    if (filtered.length !== tasks.length) {
      this.writeTasks(userHome, filtered);
    }
  }

  // --- Public API ---

  getTasks(owner: string): TaskDef[] {
    const state = this.owners.get(owner);
    if (!state) return [];
    return this.readTasks(state.userHome);
  }

  toggleTask(owner: string, taskId: string, enabled: boolean): void {
    const state = this.owners.get(owner);
    if (!state) return;
    const tasks = this.readTasks(state.userHome);
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      task.enabled = enabled;
      if (enabled) task.consecutiveErrors = 0;
      this.writeTasks(state.userHome, tasks);
      this.syncJobs(owner, tasks);
    }
  }

  deleteTask(owner: string, taskId: string): void {
    const state = this.owners.get(owner);
    if (!state) return;
    this.removeTaskFromFile(state.userHome, taskId);
    const tasks = this.readTasks(state.userHome);
    this.syncJobs(owner, tasks);
  }

  stopAll(owner: string): void {
    const state = this.owners.get(owner);
    if (!state) return;
    for (const job of state.jobs.values()) this.stopJob(job);
    state.jobs.clear();
    if (state.watcher) state.watcher.close();
    this.owners.delete(owner);
  }

  getActiveCount(owner: string): number {
    const state = this.owners.get(owner);
    if (!state) return 0;
    let count = 0;
    for (const job of state.jobs.values()) {
      if (job.task.status === 'active' && job.task.enabled) count++;
    }
    return count;
  }
}

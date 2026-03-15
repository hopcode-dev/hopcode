/**
 * TaskScheduler — manages scheduled/cron tasks for Easy Mode projects.
 * Tasks are defined in tasks.json per project directory.
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

const MAX_TASKS_PER_PROJECT = 10;
const TASK_EXECUTION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
const MAX_CONSECUTIVE_ERRORS = 3;

export class TaskScheduler {
  private jobs = new Map<string, Map<string, ActiveJob>>(); // sessionId -> taskId -> ActiveJob
  private watchers = new Map<string, fs.FSWatcher>(); // sessionId -> watcher
  private callbacks = new Map<string, TaskCallback>(); // sessionId -> callback
  private countCallbacks = new Map<string, CountCallback>(); // sessionId -> count change callback
  private projectDirs = new Map<string, string>(); // sessionId -> projectDir

  /**
   * Load tasks.json for a session and start scheduling active jobs.
   * Also watches the file for changes.
   */
  loadAndSync(sessionId: string, projectDir: string, callback: TaskCallback, onCountChange?: CountCallback): void {
    this.callbacks.set(sessionId, callback);
    if (onCountChange) this.countCallbacks.set(sessionId, onCountChange);
    this.projectDirs.set(sessionId, projectDir);

    const tasks = this.readTasksFile(projectDir);
    this.syncJobs(sessionId, projectDir, tasks);
    this.watchTasksFile(sessionId, projectDir);
  }

  /**
   * Read and parse tasks.json from project dir.
   */
  private readTasksFile(projectDir: string): TaskDef[] {
    const filePath = path.join(projectDir, 'tasks.json');
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // Validate and cap at MAX_TASKS
      return arr.slice(0, MAX_TASKS_PER_PROJECT).filter((t: any) =>
        t && t.id && t.name && t.schedule && t.prompt
      );
    } catch {
      return [];
    }
  }

  /**
   * Write tasks back to tasks.json.
   */
  private writeTasksFile(projectDir: string, tasks: TaskDef[]): void {
    const filePath = path.join(projectDir, 'tasks.json');
    try {
      fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[task-scheduler] Failed to write ${filePath}:`, e);
    }
  }

  /**
   * Sync in-memory jobs with the task definitions.
   * Creates new jobs, updates changed ones, removes deleted ones.
   */
  private syncJobs(sessionId: string, projectDir: string, tasks: TaskDef[]): void {
    if (!this.jobs.has(sessionId)) this.jobs.set(sessionId, new Map());
    const jobMap = this.jobs.get(sessionId)!;
    const prevCount = this.getActiveCount(sessionId);

    const taskIds = new Set(tasks.map(t => t.id));

    // Remove jobs for deleted tasks
    for (const [id, job] of jobMap) {
      if (!taskIds.has(id)) {
        this.stopJob(job);
        jobMap.delete(id);
      }
    }

    // Process each task
    for (const task of tasks) {
      const existing = jobMap.get(task.id);

      // Check for new draft tasks → auto test run
      if (task.status === 'draft' && task.enabled && !existing) {
        console.log(`[task-scheduler] ${sessionId} new draft task "${task.name}" — running test`);
        jobMap.set(task.id, { task });
        this.executeTask(sessionId, task, true);
        continue;
      }

      // Only schedule active + enabled tasks
      if (task.status !== 'active' || !task.enabled) {
        if (existing) {
          this.stopJob(existing);
          existing.task = task;
          // Keep in map but stopped
        } else {
          jobMap.set(task.id, { task });
        }
        continue;
      }

      // Active + enabled: create or update the scheduled job
      if (existing) {
        // Check if schedule changed
        const scheduleChanged = JSON.stringify(existing.task.schedule) !== JSON.stringify(task.schedule);
        existing.task = task;
        if (scheduleChanged) {
          this.stopJob(existing);
          this.startJob(sessionId, existing);
        }
      } else {
        const job: ActiveJob = { task };
        jobMap.set(task.id, job);
        this.startJob(sessionId, job);
      }
    }

    // Notify if active count changed
    const newCount = this.getActiveCount(sessionId);
    if (newCount !== prevCount) {
      const countCb = this.countCallbacks.get(sessionId);
      if (countCb) countCb(newCount);
    }
  }

  /**
   * Start scheduling a job based on its schedule type.
   */
  private startJob(sessionId: string, job: ActiveJob): void {
    const { task } = job;
    const { schedule } = task;

    switch (schedule.kind) {
      case 'cron': {
        if (!schedule.expr || !cronValidate(schedule.expr)) {
          console.warn(`[task-scheduler] Invalid cron expression "${schedule.expr}" for task ${task.id}`);
          return;
        }
        job.cronJob = cronSchedule(schedule.expr, () => {
          this.executeTask(sessionId, task, false);
        }, { timezone: 'Asia/Shanghai' });
        console.log(`[task-scheduler] ${sessionId} scheduled cron "${task.name}" [${schedule.expr}]`);
        break;
      }
      case 'every': {
        const ms = schedule.everyMs;
        if (!ms || ms < 10000) { // minimum 10 seconds
          console.warn(`[task-scheduler] Invalid interval ${ms}ms for task ${task.id}`);
          return;
        }
        job.intervalId = setInterval(() => {
          this.executeTask(sessionId, task, false);
        }, ms);
        console.log(`[task-scheduler] ${sessionId} scheduled every ${ms}ms "${task.name}"`);
        break;
      }
      case 'at': {
        // Ensure UTC interpretation: append Z if no timezone info
        // Timezone indicators: Z, +HH:MM, -HH:MM (but not the leading - of negative offset confused with date)
        let atStr = schedule.at || '';
        const hasTz = /Z$|[+-]\d{2}:\d{2}$|[+-]\d{4}$/.test(atStr);
        if (atStr && !hasTz) {
          atStr += 'Z';
        }
        const targetTime = atStr ? new Date(atStr).getTime() : 0;
        const delay = targetTime - Date.now();
        console.log(`[task-scheduler] ${sessionId} at-task "${task.name}" raw="${schedule.at}" parsed="${atStr}" target=${new Date(targetTime).toISOString()} delay=${Math.round(delay/1000)}s`);
        if (delay <= 0) {
          // Already past — execute immediately and remove
          console.log(`[task-scheduler] ${sessionId} at-task "${task.name}" is past due, executing now`);
          this.executeTask(sessionId, task, false);
          return;
        }
        job.timeoutId = setTimeout(() => {
          this.executeTask(sessionId, task, false);
        }, Math.min(delay, 2147483647)); // setTimeout max is ~24.8 days
        console.log(`[task-scheduler] ${sessionId} scheduled at "${task.name}" in ${Math.round(delay / 1000)}s`);
        break;
      }
      case 'delay': {
        // Simple delay from task creation time
        const delayMs = schedule.delayMs;
        if (!delayMs || delayMs < 5000) {
          console.warn(`[task-scheduler] Invalid delay ${delayMs}ms for task ${task.id}`);
          return;
        }
        const elapsed = Date.now() - (task.createdAt || Date.now());
        const remaining = delayMs - elapsed;
        if (remaining <= 0) {
          console.log(`[task-scheduler] ${sessionId} delay-task "${task.name}" already elapsed, executing now`);
          this.executeTask(sessionId, task, false);
          return;
        }
        job.timeoutId = setTimeout(() => {
          this.executeTask(sessionId, task, false);
        }, remaining);
        console.log(`[task-scheduler] ${sessionId} scheduled delay "${task.name}" in ${Math.round(remaining / 1000)}s`);
        break;
      }
    }
  }

  /**
   * Stop a job's timer/cron.
   */
  private stopJob(job: ActiveJob): void {
    if (job.cronJob) { job.cronJob.stop(); job.cronJob = undefined; }
    if (job.intervalId) { clearInterval(job.intervalId); job.intervalId = undefined; }
    if (job.timeoutId) { clearTimeout(job.timeoutId); job.timeoutId = undefined; }
  }

  /**
   * Execute a task by spawning claude -p.
   */
  private async executeTask(sessionId: string, task: TaskDef, isDraft: boolean): Promise<void> {
    const projectDir = this.projectDirs.get(sessionId);
    if (!projectDir) return;
    const callback = this.callbacks.get(sessionId);

    const taggedPrompt = isDraft
      ? `[Scheduled task test run "${task.name}"]: ${task.prompt}\n\nThis is a TEST RUN. Execute the task and show the result. The user will review before activating the schedule.`
      : `[Scheduled task "${task.name}"]: ${task.prompt}`;

    console.log(`[task-scheduler] ${sessionId} executing task "${task.name}" (draft=${isDraft})`);

    try {
      const result = await this.spawnClaudeForTask(projectDir, taggedPrompt);

      // Update task state
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

      // For at-tasks, auto-remove after execution
      if (!isDraft && (task.schedule.kind === 'at' || task.schedule.kind === 'delay')) {
        this.removeTaskFromFile(projectDir, task.id);
      } else if (!isDraft) {
        this.updateTaskInFile(projectDir, task);
      }

      if (callback) callback(runResult);
    } catch (err: any) {
      console.error(`[task-scheduler] ${sessionId} task "${task.name}" failed:`, err.message);

      if (!isDraft) {
        task.lastRunAt = Date.now();
        task.lastStatus = 'error';
        task.lastError = err.message;
        task.consecutiveErrors = (task.consecutiveErrors || 0) + 1;

        // Auto-disable after MAX_CONSECUTIVE_ERRORS
        if (task.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          task.enabled = false;
          console.warn(`[task-scheduler] ${sessionId} task "${task.name}" auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors`);
        }

        this.updateTaskInFile(projectDir, task);

        // Re-sync to stop the job if disabled
        if (!task.enabled) {
          const tasks = this.readTasksFile(projectDir);
          this.syncJobs(sessionId, projectDir, tasks);
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

      if (callback) callback(runResult);
    }
  }

  /**
   * Spawn an isolated claude -p process for task execution.
   * Returns the text output.
   */
  private spawnClaudeForTask(projectDir: string, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        '-p', prompt,
        '--output-format', 'stream-json',
        '--verbose',
        '--model', 'sonnet',
      ];

      const env = { ...process.env };
      delete env.CLAUDECODE;

      const child = spawn('claude', args, {
        cwd: projectDir,
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
            // Extract text from assistant messages
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

      child.stderr?.on('data', () => {}); // ignore stderr

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

  /**
   * Watch tasks.json for changes and re-sync.
   */
  private watchTasksFile(sessionId: string, projectDir: string): void {
    // Stop existing watcher
    const existing = this.watchers.get(sessionId);
    if (existing) existing.close();

    const filePath = path.join(projectDir, 'tasks.json');
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const watcher = fs.watch(projectDir, (eventType, filename) => {
        if (filename !== 'tasks.json') return;
        // Debounce: wait 500ms for writes to settle
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`[task-scheduler] ${sessionId} tasks.json changed, re-syncing`);
          const tasks = this.readTasksFile(projectDir);
          this.syncJobs(sessionId, projectDir, tasks);
        }, 500);
      });
      this.watchers.set(sessionId, watcher);
    } catch (e) {
      console.error(`[task-scheduler] Failed to watch ${projectDir}:`, e);
    }
  }

  /**
   * Update a single task's runtime state in tasks.json.
   */
  private updateTaskInFile(projectDir: string, task: TaskDef): void {
    const tasks = this.readTasksFile(projectDir);
    const idx = tasks.findIndex(t => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...task };
      this.writeTasksFile(projectDir, tasks);
    }
  }

  /**
   * Remove a task from tasks.json (for at-tasks after execution).
   */
  private removeTaskFromFile(projectDir: string, taskId: string): void {
    const tasks = this.readTasksFile(projectDir);
    const filtered = tasks.filter(t => t.id !== taskId);
    if (filtered.length !== tasks.length) {
      this.writeTasksFile(projectDir, filtered);
    }
  }

  // --- Public API for server integration ---

  /**
   * Get list of tasks for a session.
   */
  getTasks(sessionId: string): TaskDef[] {
    const projectDir = this.projectDirs.get(sessionId);
    if (!projectDir) return [];
    return this.readTasksFile(projectDir);
  }

  /**
   * Toggle a task's enabled state.
   */
  toggleTask(sessionId: string, taskId: string, enabled: boolean): void {
    const projectDir = this.projectDirs.get(sessionId);
    if (!projectDir) return;
    const tasks = this.readTasksFile(projectDir);
    const task = tasks.find(t => t.id === taskId);
    if (task) {
      task.enabled = enabled;
      // Reset error count when re-enabling
      if (enabled) task.consecutiveErrors = 0;
      this.writeTasksFile(projectDir, tasks);
      this.syncJobs(sessionId, projectDir, tasks);
    }
  }

  /**
   * Delete a task.
   */
  deleteTask(sessionId: string, taskId: string): void {
    const projectDir = this.projectDirs.get(sessionId);
    if (!projectDir) return;
    this.removeTaskFromFile(projectDir, taskId);
    const tasks = this.readTasksFile(projectDir);
    this.syncJobs(sessionId, projectDir, tasks);
  }

  /**
   * Stop all jobs and watcher for a session.
   */
  stopAll(sessionId: string): void {
    const jobMap = this.jobs.get(sessionId);
    if (jobMap) {
      for (const job of jobMap.values()) this.stopJob(job);
      jobMap.clear();
    }
    this.jobs.delete(sessionId);

    const watcher = this.watchers.get(sessionId);
    if (watcher) watcher.close();
    this.watchers.delete(sessionId);

    this.callbacks.delete(sessionId);
    this.projectDirs.delete(sessionId);
  }

  /**
   * Get count of active (scheduled) tasks for a session.
   */
  getActiveCount(sessionId: string): number {
    const jobMap = this.jobs.get(sessionId);
    if (!jobMap) return 0;
    let count = 0;
    for (const job of jobMap.values()) {
      if (job.task.status === 'active' && job.task.enabled) count++;
    }
    return count;
  }
}

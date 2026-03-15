/**
 * VersionTracker — Git-based file version management for Easy Mode sessions.
 *
 * Auto-commits workspace/ changes after each Claude response and file upload.
 * No tags — version history is just git log, browsed by date and description.
 * Users pick from a list by index; internally we resolve to commit hash.
 */

import { execFile } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

export interface VersionEntry {
  hash: string;          // internal git short hash
  message: string;
  author: string;
  timestamp: number;     // ms
  filesChanged: string[];
}

const GITIGNORE = `.easy-state.json
.mcp-config.json
.claude/
node_modules/
*.log
tasks.json
`;

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]} failed: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

export class VersionTracker {
  private projectDir: string;
  private initialized = false;
  private commitLock = false;

  constructor(projectDir: string) {
    this.projectDir = projectDir;
  }

  /** Initialize git repo if needed (idempotent) */
  async init(): Promise<void> {
    if (this.initialized) return;

    const gitDir = path.join(this.projectDir, '.git');
    if (!existsSync(gitDir)) {
      await git(['init'], this.projectDir);
      writeFileSync(path.join(this.projectDir, '.gitignore'), GITIGNORE);

      const wsDir = path.join(this.projectDir, 'workspace');
      if (existsSync(wsDir)) {
        await git(['add', 'workspace/', '.gitignore'], this.projectDir);
      } else {
        await git(['add', '.gitignore'], this.projectDir);
      }

      try {
        await git(['commit', '-m', '初始版本', '--author', 'system <system@hopcode>'], this.projectDir);
      } catch {
        // Nothing to commit — fine
      }
    }

    this.initialized = true;
  }

  /**
   * Commit all changes in workspace/.
   * Returns commit hash or null if nothing changed.
   */
  async commit(message: string, author: string): Promise<string | null> {
    if (this.commitLock) return null;
    this.commitLock = true;

    try {
      await this.init();

      const wsDir = path.join(this.projectDir, 'workspace');
      if (existsSync(wsDir)) {
        await git(['add', 'workspace/'], this.projectDir);
      }

      const status = await git(['diff', '--cached', '--name-only'], this.projectDir);
      if (!status.trim()) return null;

      const authorStr = `${author} <${author}@hopcode>`;
      await git(['commit', '-m', message, '--author', authorStr], this.projectDir);

      const hash = (await git(['rev-parse', '--short', 'HEAD'], this.projectDir)).trim();
      return hash;
    } catch (e: any) {
      if (e.message?.includes('nothing to commit')) return null;
      console.error(`[version-tracker] commit failed: ${e.message}`);
      return null;
    } finally {
      this.commitLock = false;
    }
  }

  /** Get recent commit history */
  async log(limit = 20): Promise<VersionEntry[]> {
    await this.init();

    try {
      const raw = await git([
        'log', `--max-count=${limit}`,
        '--format=%h|%an|%at|%s',
      ], this.projectDir);

      if (!raw.trim()) return [];

      const entries: VersionEntry[] = [];
      for (const line of raw.trim().split('\n')) {
        const [hash, author, tsStr, ...msgParts] = line.split('|');
        if (!hash) continue;

        let filesChanged: string[] = [];
        try {
          const nameOnly = await git(['diff-tree', '--no-commit-id', '--name-only', '-r', hash!], this.projectDir);
          filesChanged = nameOnly.trim().split('\n').filter(Boolean);
        } catch {}

        entries.push({
          hash: hash!,
          author: author || 'unknown',
          timestamp: parseInt(tsStr || '0', 10) * 1000,
          message: msgParts.join('|') || '',
          filesChanged,
        });
      }

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Restore workspace to a previous commit by hash.
   * Creates a new commit on top (never rewrites history).
   * Returns list of changed files.
   */
  async restore(commitHash: string): Promise<string[]> {
    await this.init();

    // Verify commit exists
    try {
      await git(['rev-parse', commitHash], this.projectDir);
    } catch {
      throw new Error('该版本不存在');
    }

    await git(['checkout', commitHash, '--', 'workspace/'], this.projectDir);

    const status = await git(['status', '--porcelain'], this.projectDir);
    const changedFiles = status.trim().split('\n')
      .filter(Boolean)
      .map(line => line.substring(3).trim());

    if (changedFiles.length === 0) return [];

    await git(['add', 'workspace/'], this.projectDir);
    await git([
      'commit', '-m', '还原到之前的版本',
      '--author', 'system <system@hopcode>',
    ], this.projectDir);

    return changedFiles;
  }

  /** Get commit history for a single file (path relative to projectDir, e.g. "workspace/index.html") */
  async fileLog(filePath: string, limit = 20): Promise<VersionEntry[]> {
    await this.init();

    try {
      const raw = await git([
        'log', `--max-count=${limit}`,
        '--format=%h|%an|%at|%s',
        '--', filePath,
      ], this.projectDir);

      if (!raw.trim()) return [];

      const entries: VersionEntry[] = [];
      for (const line of raw.trim().split('\n')) {
        const [hash, author, tsStr, ...msgParts] = line.split('|');
        if (!hash) continue;
        entries.push({
          hash: hash!,
          author: author || 'unknown',
          timestamp: parseInt(tsStr || '0', 10) * 1000,
          message: msgParts.join('|') || '',
          filesChanged: [filePath],
        });
      }
      return entries;
    } catch {
      return [];
    }
  }

  /** Restore a single file to a previous version. Returns the file path restored. */
  async restoreFile(filePath: string, commitHash: string): Promise<void> {
    await this.init();

    try {
      await git(['rev-parse', commitHash], this.projectDir);
    } catch {
      throw new Error('该版本不存在');
    }

    await git(['checkout', commitHash, '--', filePath], this.projectDir);
    await git(['add', filePath], this.projectDir);
    const fileName = filePath.replace('workspace/', '');
    await git([
      'commit', '-m', `Restored ${fileName}`,
      '--author', 'system <system@hopcode>',
    ], this.projectDir);
  }

  /** Get file content at a specific commit */
  async fileAt(filePath: string, commitHash: string): Promise<string> {
    await this.init();
    return git(['show', `${commitHash}:${filePath}`], this.projectDir);
  }
}

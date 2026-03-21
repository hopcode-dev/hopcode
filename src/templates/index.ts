/**
 * Easy Mode project template system.
 * Generates CLAUDE.md for new project folders based on user config.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface UserDeployConfig {
  portRange: [number, number];  // port range for full-scale apps
  appCommand: string;           // e.g. 'alex-app'
  liveUrlBase: string;          // e.g. 'https://gotong.gizwitsapi.com/alex/'
}

// User deployment configs — derived from their global CLAUDE.md
const userConfigs: Record<string, UserDeployConfig> = {
  alex: {
    portRange: [9001, 9999],
    appCommand: 'alex-app',
    liveUrlBase: 'https://gotong.gizwitsapi.com/alex/',
  },
  pony: {
    portRange: [8001, 8999],
    appCommand: 'pony-app',
    liveUrlBase: 'https://gotong.gizwitsapi.com/pony/',
  },
};

// Track assigned ports per user to avoid collisions within a session
const assignedPorts: Record<string, Set<number>> = {};

function getNextPort(username: string): number {
  const config = userConfigs[username];
  if (!config) return 8080;
  if (!assignedPorts[username]) assignedPorts[username] = new Set();
  const [min, max] = config.portRange;
  for (let p = min; p <= max; p++) {
    if (!assignedPorts[username]!.has(p)) {
      assignedPorts[username]!.add(p);
      return p;
    }
  }
  return min;
}

function getDeployInstructions(username: string, projectName: string, port: number): string {
  const config = userConfigs[username];
  if (!config) {
    return `To share externally, ask the user to click the Share button in the preview panel.`;
  }

  const appName = projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
  return `Register your app for a permanent shareable link:
\`\`\`bash
${config.appCommand} add ${appName} ${port}
\`\`\`
Your app will be live at: ${config.liveUrlBase}${appName}/

To remove later: \`${config.appCommand} remove ${appName}\``;
}

/**
 * Generate and write CLAUDE.md for a new easy mode project.
 */
export function setupProjectTemplate(
  projectDir: string,
  username: string,
  projectName: string,
): void {
  const templatePath = path.join(__dirname, 'easy-project-claude.md');

  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    // Fallback inline template if file not found
    template = `# Project Rules\n\nFiles are auto-served at: {{SERVE_URL}}\nJust create index.html and tell the user the URL.\n\n{{DEPLOY_INSTRUCTIONS}}`;
  }

  const port = getNextPort(username);
  const baseUrl = process.env.PUBLIC_URL || 'https://gotong.gizwitsapi.com';
  const serveUrl = `${baseUrl}/serve/${encodeURIComponent(projectName)}/workspace/`;
  const deployInstructions = getDeployInstructions(username, projectName, port);
  const liveUrl = config ? `${config.liveUrlBase}${projectName}/` : '';

  const content = template
    .replace(/\{\{SERVE_URL\}\}/g, serveUrl)
    .replace(/\{\{BASE_URL\}\}/g, baseUrl)
    .replace(/\{\{PROJECT_DIR\}\}/g, projectDir)
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PORT\}\}/g, String(port))
    .replace(/\{\{LIVE_URL\}\}/g, liveUrl)
    .replace(/\{\{APP_COMMAND\}\}/g, config?.appCommand || '')
    .replace(/\{\{DEPLOY_INSTRUCTIONS\}\}/g, deployInstructions);

  // Also copy user's global CLAUDE.md content if it exists
  const homeDir = username === 'root' ? '/root' : `/home/${username}`;
  const globalClaudeMd = path.join(homeDir, '.claude', 'CLAUDE.md');
  let globalContent = '';
  try {
    globalContent = fs.readFileSync(globalClaudeMd, 'utf-8');
  } catch {}

  // Write project CLAUDE.md: global rules + project-specific rules
  const finalContent = globalContent
    ? `${globalContent}\n\n---\n\n${content}`
    : content;

  const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  try {
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'workspace'), { recursive: true });
    } catch {
      // hopcode service user can't write to user home dirs — create as the linux user
      if (username && username !== 'root') {
        execFileSync('sudo', ['-u', username, 'mkdir', '-p', path.join(projectDir, 'workspace')], { timeout: 3000 });
      }
    }
    fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');
    // chown project dir to the linux user (so claude -p running as that user can read/write)
    if (username && username !== 'root') {
      try {
        execFileSync('chown', ['-R', `${username}:${username}`, projectDir], { timeout: 5000 });
      } catch (e) {
        console.error(`[template] chown failed for ${projectDir}:`, e);
      }
    }
  } catch (e) {
    console.error(`[template] Failed to write ${claudeMdPath}:`, e);
  }
}

/**
 * Get config for a user (for API use).
 */
export function getUserConfig(username: string): UserDeployConfig | null {
  return userConfigs[username] || null;
}

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

/**
 * Load user deployment configs from users.json
 */
function loadUserConfigs(): Record<string, UserDeployConfig> {
  const configs: Record<string, UserDeployConfig> = {};
  try {
    const usersPath = path.join(process.cwd(), 'users.json');
    const usersData = JSON.parse(fs.readFileSync(usersPath, 'utf-8'));

    for (const [username, userData] of Object.entries(usersData)) {
      const data = userData as any;
      if (data.portStart && data.portEnd) {
        configs[username] = {
          portRange: [data.portStart, data.portEnd],
          appCommand: `${username}-app`,
          liveUrlBase: `https://gotong.gizwitsapi.com/${username}/`,
        };
      }
    }
  } catch (e) {
    console.error('[template] Failed to load users.json:', e);
  }

  // Fallback to hardcoded configs for backward compatibility
  if (!configs['alex']) {
    configs['alex'] = {
      portRange: [9001, 9999],
      appCommand: 'alex-app',
      liveUrlBase: 'https://gotong.gizwitsapi.com/alex/',
    };
  }
  if (!configs['pony']) {
    configs['pony'] = {
      portRange: [8001, 8999],
      appCommand: 'pony-app',
      liveUrlBase: 'https://gotong.gizwitsapi.com/pony/',
    };
  }

  return configs;
}

// User deployment configs — loaded from users.json
const userConfigs: Record<string, UserDeployConfig> = loadUserConfigs();

// Track assigned ports per user to avoid collisions within a session
const assignedPorts: Record<string, Set<number>> = {};

function getNextPort(username: string, projectDir: string): number {
  const config = userConfigs[username];
  if (!config) return 8080;

  // Try to read existing port from CLAUDE.md
  const existingPort = readExistingPort(projectDir);
  if (existingPort) {
    // Track it so we don't assign it to other projects
    if (!assignedPorts[username]) assignedPorts[username] = new Set();
    assignedPorts[username]!.add(existingPort);
    return existingPort;
  }

  // Allocate new port
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

/**
 * Read existing port from CLAUDE.md if it exists
 */
function readExistingPort(projectDir: string): number | null {
  try {
    const claudeMdPath = path.join(projectDir, 'CLAUDE.md');
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    // Match patterns like: --port 6100 or --port 6700
    const portMatch = content.match(/--port\s+(\d+)/);
    if (portMatch) {
      return parseInt(portMatch[1], 10);
    }
  } catch {
    // File doesn't exist or can't be read
  }
  return null;
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
  sessionId?: string,
): void {
  const templatePath = path.join(__dirname, 'easy-project-claude.md');

  let template: string;
  try {
    template = fs.readFileSync(templatePath, 'utf-8');
  } catch {
    // Fallback inline template if file not found
    template = `# Project Rules\n\nFiles are auto-served at: {{SERVE_URL}}\nJust create index.html and tell the user the URL.\n\n{{DEPLOY_INSTRUCTIONS}}`;
  }

  const port = getNextPort(username, projectDir);
  const baseUrl = process.env.PUBLIC_URL || 'https://gotong.gizwitsapi.com';
  // Use session ID in serve URL so it's ASCII-safe (no Chinese in URL)
  const serveUrl = sessionId
    ? `${baseUrl}/serve/${sessionId}/workspace/`
    : `${baseUrl}/serve/${encodeURIComponent(projectName)}/workspace/`;
  const deployInstructions = getDeployInstructions(username, projectName, port);
  const userConfig = userConfigs[username];
  const liveUrl = userConfig ? `${userConfig.liveUrlBase}${projectName}/` : '';

  const content = template
    .replace(/\{\{SERVE_URL\}\}/g, serveUrl)
    .replace(/\{\{BASE_URL\}\}/g, baseUrl)
    .replace(/\{\{PROJECT_DIR\}\}/g, projectDir)
    .replace(/\{\{PROJECT_NAME\}\}/g, projectName)
    .replace(/\{\{PORT\}\}/g, String(port))
    .replace(/\{\{LIVE_URL\}\}/g, liveUrl)
    .replace(/\{\{APP_COMMAND\}\}/g, userConfig?.appCommand || '')
    .replace(/\{\{DEPLOY_INSTRUCTIONS\}\}/g, deployInstructions)
    .replace(/\{\{DATE\}\}/g, new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14));

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
  const rulesDir = path.join(projectDir, '.claude', 'rules');
  try {
    try {
      fs.mkdirSync(projectDir, { recursive: true });
      fs.mkdirSync(path.join(projectDir, 'workspace'), { recursive: true });
      fs.mkdirSync(rulesDir, { recursive: true });
    } catch {
      // hopcode service user can't write to user home dirs — create as the linux user
      if (username && username !== 'root') {
        execFileSync('sudo', ['-u', username, 'mkdir', '-p', path.join(projectDir, 'workspace')], { timeout: 3000 });
        execFileSync('sudo', ['-u', username, 'mkdir', '-p', rulesDir], { timeout: 3000 });
      }
    }
    // Copy rule files to project
    const templateRulesDir = path.join(__dirname, '.claude', 'rules');
    try {
      const ruleFiles = ['storage.md', 'coding-style.md', 'playwright.md', 'cloud-deploy.md'];
      for (const file of ruleFiles) {
        const src = path.join(templateRulesDir, file);
        const dst = path.join(rulesDir, file);
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst);
        }
      }
    } catch (e) {
      console.error('[template] Failed to copy rule files:', e);
    }
    fs.writeFileSync(claudeMdPath, finalContent, 'utf-8');
    // chown project dir to the linux user (so claude -p running as that user can read/write)
    if (username && username !== 'root') {
      try {
        execFileSync('sudo', ['chown', '-R', `${username}:${username}`, projectDir], { timeout: 5000 });
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

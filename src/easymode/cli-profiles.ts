/**
 * CLI Profile definitions — configurable patterns for different AI CLI tools
 */

export interface CliProfile {
  id: string;
  name: string;
  command: string;

  // Prompt detection
  promptPattern: RegExp;         // Response complete marker (e.g. ❯)
  shellPromptPattern: RegExp;    // CLI exited, back to shell

  // Activity detection
  spinnerPattern: RegExp;        // Active spinner (word + ellipsis)
  spinnerMaxLen: number;         // Max line length for spinner detection

  // Permission
  permissionPattern: RegExp;
  permissionResponses: { allow: string; allowAll: string; deny: string };

  // Lines to skip entirely
  skipPatterns: RegExp[];

  // Line-level cleaning (applied in order)
  cleanPatterns: { match: RegExp; replace: string }[];

  // Tool detection
  toolNames: string[];
  toolStartPattern: RegExp;      // Tool invocation line
  toolResultPattern: RegExp;     // Tool result prefix (⎿)
  toolOutputPattern: RegExp;     // Tool output marker (⏺)

  // Timing
  outputDebounceMs: number;      // Wait for output to stabilize
  promptGraceMs: number;         // Ignore prompt this long after sending

  // Status display text
  statusMessages: Record<string, string>;
}

// --- Built-in Claude profile ---

const CLAUDE_TOOL_NAMES = [
  'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'Search',
  'TodoRead', 'TodoWrite', 'Agent', 'WebFetch', 'WebSearch',
  'NotebookEdit', 'Skill', 'ToolSearch',
];

const TOOL_NAME_RE = CLAUDE_TOOL_NAMES.join('|');

export const claudeProfile: CliProfile = {
  id: 'claude',
  name: 'Claude Code',
  command: 'claude',

  promptPattern: /\u276f/,                     // ❯
  shellPromptPattern: /^[$#]\s*$/,

  spinnerPattern: /\w+\u2026/,                 // word + …
  spinnerMaxLen: 60,

  permissionPattern: /\bAllow\b[\s\S]*\bDeny\b/,
  permissionResponses: { allow: 'y\r', allowAll: 'Y\r', deny: 'n\r' },

  skipPatterns: [
    // Prompt line
    /^\s*[\u276f>]\s*$/,
    // Permission buttons
    /\bAllow\b.*\bDeny\b/,
    // Keyboard hints
    /esc\s*to\s*interrupt/i,
    /\?\s+for\s+shortcuts/,
    /accept\s*edits/i,
    /shift\+tab/i,
    // Spinner (short line with word + ellipsis, NOT timing)
    // Handled separately due to length check
    // Timing lines
    /^\s*\S\s*\w+ed for \d/,
    /Worked for \d/,
    // Command echo
    /^\s*cd\s+.*&&\s*claude/,
    // Box drawing + bullets
    /[\u2500-\u257F\u256D-\u2570].*[\u25AA\u25A0\u25CF]{2,}/,
    // Only box drawing chars
    /^[\s\u2500-\u257F\u256D-\u2570\u2502\u2503]+$/,
    // Box drawing corners/sides
    /[\u2502\u2503\u256D\u256E\u256F\u2570\u250C\u2510\u2514\u2518\u252C\u2534]/,
    // Tool result (⎿)
    /\u23BF/,
    // Tool invocation line (marker + ToolName)
    new RegExp(`^\\s*[^\\u4e00-\\u9fff\\w]*\\s*(${TOOL_NAME_RE})[\\s(]`),
    // Tool output marker (⏺)
    /^\s*\u23FA/,
    // Referenced file
    /Referenced file/,
    // Compact hints
    /ctrl\+o/,
    /Compacted\b/,
    /Conversation compacted/,
    // Welcome screen
    /Welcome back/i,
    /Tips for getting started/,
    /Run \/init/,
    /Recent activity/,
    /No recent activity/,
    // Version / account info
    /Claude Code v/,
    // Status lines
    /\u2193 to manage/,
    /background task/,
    // Ctrl+ hints
    /\(ctrl\+/,
    // Line counts
    /^\s*[+\-]?\d+\s+lines/,
    // Diff lines
    /^\s{2,}\d{2,}\s+[+\-]\s/,
    /^\s{4,}\d{2,}\s{2,}\S/,
  ],

  cleanPatterns: [
    // Remove leading marker chars (not CJK, not word, not brackets)
    { match: /^\s*[^\w\s<({[\u4e00-\u9fff]\s*/, replace: '' },
    // Remove box drawing chars
    { match: /[\u2500-\u257F\u256D-\u2570]/g, replace: '' },
    // Remove play/stop symbols
    { match: /[\u23F5\u23F9]+/g, replace: '' },
  ],

  toolNames: CLAUDE_TOOL_NAMES,
  toolStartPattern: new RegExp(`^\\s*[^\\u4e00-\\u9fff\\w]*\\s*(${TOOL_NAME_RE})[\\s(]`),
  toolResultPattern: /\u23BF/,
  toolOutputPattern: /^\s*\u23FA/,

  outputDebounceMs: 150,
  promptGraceMs: 1500,

  statusMessages: {
    initializing: 'Starting Claude...',
    ready: 'Ready',
    thinking: 'Claude is thinking...',
    responding: 'Claude is responding...',
    permission: 'Waiting for your decision...',
    tool_running: 'Claude is working...',
    exited: 'Claude has stopped',
    error: 'Error',
  },
};

// --- Built-in Aider profile (placeholder for Phase 3) ---

export const aiderProfile: CliProfile = {
  ...claudeProfile,
  id: 'aider',
  name: 'Aider',
  command: 'aider',
  promptPattern: /^[>]\s*/,
  statusMessages: {
    ...claudeProfile.statusMessages,
    initializing: 'Starting Aider...',
    thinking: 'Aider is thinking...',
    responding: 'Aider is responding...',
    tool_running: 'Aider is working...',
    exited: 'Aider has stopped',
  },
};

// --- Profile registry ---

const profiles = new Map<string, CliProfile>([
  ['claude', claudeProfile],
  ['aider', aiderProfile],
]);

export function getProfile(id: string): CliProfile {
  return profiles.get(id) || claudeProfile;
}

export function getAllProfiles(): CliProfile[] {
  return Array.from(profiles.values());
}

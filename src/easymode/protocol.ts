/**
 * Easy Mode structured message protocol
 * Server → Client and Client → Server message types
 */

// --- State ---

export type EasyState =
  | 'initializing'
  | 'ready'
  | 'thinking'
  | 'responding'
  | 'tool_running'
  | 'queued'
  | 'exited'
  | 'error';

// --- Server → Client Messages ---

export type EasyServerMessage =
  | { type: 'state'; state: EasyState }
  | { type: 'message'; id: number; role: 'assistant'; text: string; thinking?: boolean }
  | { type: 'message_delta'; id: number; delta: string }
  | { type: 'user_message'; id: number; sender: string; text: string }
  | { type: 'tool'; name: string; detail: string; status: 'running' | 'done' }
  | { type: 'preview_hint'; url: string }
  | { type: 'preview_suggest'; filename: string }
  | { type: 'participants'; users: { name: string; online: boolean }[] }
  | { type: 'history'; messages: { role: 'user' | 'assistant'; text: string; id: number; sender?: string }[] }
  | { type: 'session_info'; owner: string; projectDir: string; isOwner: boolean; hasFileAccess: boolean }
  | { type: 'file_access_request'; user: string }
  | { type: 'file_access_granted'; user: string }
  | { type: 'error'; message: string }
  | { type: 'task_result'; taskId: string; taskName: string; text: string; timestamp: number; isDraft: boolean }
  | { type: 'tasks_list'; tasks: { id: string; name: string; schedule: any; status: string; enabled: boolean; lastRunAt?: number | null }[] }
  | { type: 'task_count'; count: number }
  | { type: 'version_log_result'; entries: import('./version-tracker.js').VersionEntry[] }
  | { type: 'version_restored'; files: string[]; message: string }
  | { type: 'file_version_log_result'; filePath: string; entries: import('./version-tracker.js').VersionEntry[] }
  | { type: 'file_version_restored'; filePath: string; message: string };

// --- Client → Server Messages ---

export type EasyClientMessage =
  | { type: 'send'; text: string; mentions?: string[] }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'request_file_access' }
  | { type: 'grant_file_access'; user: string }
  | { type: 'list_tasks' }
  | { type: 'toggle_task'; taskId: string; enabled: boolean }
  | { type: 'delete_task'; taskId: string }
  | { type: 'version_log' }
  | { type: 'version_restore'; index: number }
  | { type: 'file_version_log'; filePath: string }
  | { type: 'file_version_restore'; filePath: string; index: number };

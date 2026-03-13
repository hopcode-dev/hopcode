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
  | { type: 'error'; message: string };

// --- Client → Server Messages ---

export type EasyClientMessage =
  | { type: 'send'; text: string; mentions?: string[] }
  | { type: 'cancel' }
  | { type: 'retry' }
  | { type: 'request_file_access' }
  | { type: 'grant_file_access'; user: string };

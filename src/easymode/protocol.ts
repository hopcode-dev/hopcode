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
  | { type: 'participants'; users: string[] }
  | { type: 'history'; messages: { role: 'user' | 'assistant'; text: string; id: number; sender?: string }[] }
  | { type: 'error'; message: string };

// --- Client → Server Messages ---

export type EasyClientMessage =
  | { type: 'send'; text: string; mentions?: string[] }
  | { type: 'cancel' };

/**
 * Shared protocol types and constants for PTY Service <-> UI Service IPC
 */

export const PTY_SERVICE_PORT = parseInt(process.env.PTY_SERVICE_PORT || '3002');
export const PTY_INTERNAL_TOKEN_HEADER = 'x-pty-internal-token';

// Generate a shared token from AUTH_PASSWORD for internal communication
export function getPtyInternalToken(): string {
  const password = process.env.AUTH_PASSWORD || '';
  return 'pty_internal_' + Buffer.from(password).toString('base64');
}

// Session info returned by PTY service
export interface SessionInfo {
  id: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  clientCount: number;
}

// Messages from PTY service -> UI service (over internal WS)
export type PtyOutMessage =
  | { type: 'session_info'; name: string }
  | { type: 'scrollback'; data: string }
  | { type: 'output'; data: string }
  | { type: 'session_exit' };

// Messages from UI service -> PTY service (over internal WS)
export type PtyInMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'asr'; text: string };

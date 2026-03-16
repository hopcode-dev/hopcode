/**
 * Channel abstraction — minimal interface for message transport.
 *
 * Ported from FlashClaw. Hopcode uses:
 * - WeComBot: Smart robot protocol (WebSocket long-connection)
 * - WeComApp: Enterprise app with direct callback (self-contained, no relay)
 */

/** Incoming message from a channel */
export interface IncomingMessage {
  /** User identifier */
  userId: string;
  /** Message text content */
  content: string;
  /** Message type */
  msgType: 'text' | 'voice' | 'image' | 'file';
  /** Chat/room ID (for group messages) */
  chatId?: string;
  /** Chat type */
  chatType: 'direct' | 'group';
  /** Request ID for reply correlation */
  reqId?: string;
  /** Message ID for dedup */
  msgId?: string;
  /** Channel-specific fields */
  raw?: Record<string, any>;
}

export type MessageHandler = (msg: IncomingMessage) => Promise<void>;

/** Channel interface — transport layer for messaging */
export interface Channel {
  /** Register a handler for incoming messages */
  onMessage(handler: MessageHandler): void;
  /** Send text to a user */
  sendText(userId: string, text: string): Promise<void>;
  /** Send text to a group chat (optional) */
  sendGroupText?(chatId: string, text: string): Promise<boolean>;
  /** Send a streaming text chunk (optional — for channels supporting streaming reply) */
  sendStreamChunk?(userId: string, streamId: string, content: string, finish: boolean): Promise<void>;
  /** Connect/start the channel */
  start(): Promise<void>;
  /** Disconnect/stop the channel */
  stop(): void;
}

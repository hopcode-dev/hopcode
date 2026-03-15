/**
 * WeChat Work Smart Robot — Long-Connection Protocol Client
 *
 * Connects directly to wss://openws.work.weixin.qq.com using Bot ID + Secret.
 * Protocol uses streaming reply format (msgtype: "stream").
 *
 * Ported from FlashClaw for Hopcode integration.
 */

import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import type { Channel, IncomingMessage, MessageHandler } from './types.js';

const WSS_URL = 'wss://openws.work.weixin.qq.com';
const PING_INTERVAL = 25_000;
const ACK_TIMEOUT = 5_000;
const RESPONSE_URL_TTL = 3500_000; // ~58 minutes (1h validity)

const CMD_SUBSCRIBE = 'aibot_subscribe';
const CMD_PING = 'ping';
const CMD_RESPONSE = 'aibot_respond_msg';
const CMD_CALLBACK = 'aibot_msg_callback';
const CMD_EVENT_CALLBACK = 'aibot_event_callback';

export interface WeComBotConfig {
  botId: string;
  botSecret: string;
  log?: (msg: string) => void;
}

export class WeComBot implements Channel {
  private ws: WebSocket | null = null;
  private messageHandler: MessageHandler | null = null;
  private isConnected = false;
  private disconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private subscribeReqId = '';
  private lastPingReqId = '';

  /** Active req_id per user — set during message processing for replies */
  private activeReqIds = new Map<string, string>();
  /** Stored response_url per user for proactive messages */
  private responseUrls = new Map<string, { url: string; ts: number }>();
  /** Pending ACK waiters keyed by req_id */
  private pendingAcks = new Map<string, { resolve: (f?: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Reply queue per req_id — ensures sequential sends with ACK */
  private replyQueues = new Map<string, Array<{ frame: any; resolve: (f?: any) => void; reject: (e: Error) => void }>>();
  /** Recent msg_ids for dedup */
  private recentMsgIds = new Set<string>();
  private recentMsgTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Stream ID counter */
  private streamCounter = 0;

  private botId: string;
  private botSecret: string;
  private log: (msg: string) => void;

  constructor(config: WeComBotConfig);
  /** @deprecated Use config object instead */
  constructor(botId: string, botSecret: string, log?: (msg: string) => void);
  constructor(configOrBotId: WeComBotConfig | string, botSecret?: string, logFn?: (msg: string) => void) {
    if (typeof configOrBotId === 'string') {
      this.botId = configOrBotId;
      this.botSecret = botSecret!;
      this.log = logFn ?? (() => {});
    } else {
      this.botId = configOrBotId.botId;
      this.botSecret = configOrBotId.botSecret;
      this.log = configOrBotId.log ?? (() => {});
    }
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  /** Mark a req_id as active for a user (call when starting to process a message) */
  setActiveReqId(userId: string, reqId: string): void {
    this.activeReqIds.set(userId, reqId);
  }

  /** Clear active req_id for a user (call when done processing) */
  clearActiveReqId(userId: string): void {
    this.activeReqIds.delete(userId);
  }

  /** Channel.start() — connect to WeChat Work */
  async start(): Promise<void> {
    return this.connect();
  }

  /** Channel.stop() — disconnect */
  stop(): void {
    this.disconnect();
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.log('Connecting to WeChat Work bot API...');
      if (this.ws) {
        try { this.ws.removeAllListeners(); this.ws.close(); } catch {}
        this.ws = null;
      }

      this.ws = new WebSocket(WSS_URL);

      this.ws.on('open', () => {
        this.log('WebSocket connected, subscribing...');
        this.subscribe();
      });

      let resolved = false;
      this.ws.on('message', async (raw) => {
        try {
          const data = JSON.parse(String(raw));
          await this.handleFrame(data, () => {
            if (!resolved) { resolved = true; resolve(); }
          }, (err) => {
            if (!resolved) { resolved = true; reject(err); }
          });
        } catch (e) {
          this.log(`Parse error: ${e}`);
        }
      });

      this.ws.on('close', (code) => {
        this.log(`WebSocket closed: ${code}`);
        this.isConnected = false;
        this.stopPing();
        this.clearPendingReplies('connection closed');
        if (!resolved) { resolved = true; reject(new Error(`WebSocket closed: ${code}`)); }
        this.scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        this.log(`WebSocket error: ${err.message}`);
        if (!resolved) { resolved = true; reject(err); }
      });
    });
  }

  disconnect(): void {
    this.disconnected = true;
    this.stopPing();
    this.clearPendingReplies('disconnected');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
  }

  // ── Send text to user ──

  async sendText(userId: string, content: string): Promise<void> {
    // During message processing: reply via WebSocket with active req_id
    const reqId = this.activeReqIds.get(userId);
    if (reqId) {
      const streamId = `stream_${crypto.randomUUID()}`;
      await this.enqueueReply(reqId, {
        msgtype: 'stream',
        stream: { id: streamId, content, finish: true },
      });
      return;
    }

    // Proactive (cron etc): try stored response_url
    const ru = this.responseUrls.get(userId);
    if (ru && Date.now() - ru.ts < RESPONSE_URL_TTL) {
      try {
        const resp = await fetch(ru.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ msgtype: 'markdown', markdown: { content } }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) {
          this.log(`response_url HTTP ${resp.status}: ${await resp.text().catch(() => '')}`);
        }
        this.responseUrls.delete(userId); // one-time use
        return;
      } catch (e) {
        this.log(`response_url send failed: ${e}`);
        this.responseUrls.delete(userId);
      }
    }

    const msg = `Cannot send proactive message to ${userId} — no active req_id or valid response_url`;
    this.log(`WARNING: ${msg}. Message: ${content.slice(0, 80)}`);
    throw new Error(msg);
  }

  // ── Streaming reply ──

  /** Send a stream chunk to a user. Same streamId = same message bubble. */
  async sendStreamChunk(userId: string, streamId: string, content: string, finish: boolean): Promise<void> {
    const reqId = this.activeReqIds.get(userId);
    if (!reqId) {
      // No active request — fall back to sendText for finish frame with content
      if (finish && content) await this.sendText(userId, content);
      return;
    }
    await this.enqueueReply(reqId, {
      msgtype: 'stream',
      stream: { id: streamId, content, finish },
    });
  }

  // ── Proactive push via aibot_send_msg ──

  async sendProactive(chatId: string, content: string, chatType: 1 | 2 = 2): Promise<boolean> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log(`Cannot send proactive message — WebSocket not connected`);
      return false;
    }
    const reqId = `send_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const frame = {
      cmd: 'aibot_send_msg',
      headers: { req_id: reqId },
      body: {
        chatid: chatId,
        chat_type: chatType,
        msgtype: 'markdown',
        markdown: { content },
      },
    };
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingAcks.delete(reqId);
        this.log(`Proactive send ACK timeout for ${chatId}`);
        resolve(false);
      }, ACK_TIMEOUT);
      this.pendingAcks.set(reqId, {
        resolve: (data?: any) => {
          const errcode = data?.errcode ?? -1;
          if (errcode === 0) {
            this.log(`Proactive sent to ${chatId}: ${content.slice(0, 60)}`);
            resolve(true);
          } else {
            this.log(`Proactive send error: errcode=${errcode} errmsg=${data?.errmsg}`);
            resolve(false);
          }
        },
        reject: () => resolve(false),
        timer,
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /** Send text to group chat via aibot_send_msg */
  async sendGroupText(chatId: string, content: string): Promise<boolean> {
    return this.sendProactive(chatId, content, 2);
  }

  // ── Internal protocol ──

  private subscribe(): void {
    this.subscribeReqId = `${CMD_SUBSCRIBE}_${Date.now()}`;
    this.sendFrame({
      cmd: CMD_SUBSCRIBE,
      headers: { req_id: this.subscribeReqId },
      body: { bot_id: this.botId, secret: this.botSecret },
    });
  }

  private async handleFrame(
    data: any,
    onConnected?: () => void,
    onFailed?: (e: Error) => void,
  ): Promise<void> {
    const cmd = String(data.cmd ?? '').trim().toLowerCase();
    const reqId = String(data.headers?.req_id ?? '').trim();

    // 1. Check if this is an ACK for a pending reply
    if (reqId && this.pendingAcks.has(reqId)) {
      this.handleReplyAck(reqId, data);
      return;
    }

    // 2. Pong response
    if (cmd === 'pong') return;

    // 3. Incoming user message
    if (cmd === CMD_CALLBACK || cmd === CMD_EVENT_CALLBACK) {
      await this.handleIncomingMessage(reqId, data.body, cmd);
      return;
    }

    // 4. Bare ACK frames (no cmd, have errcode)
    if (!cmd && typeof data.errcode === 'number') {
      const errcode = data.errcode;
      const errmsg = String(data.errmsg ?? '');

      // Subscribe ACK
      if (reqId === this.subscribeReqId || reqId.startsWith(`${CMD_SUBSCRIBE}_`)) {
        if (errcode === 0) {
          this.log('Subscribed to WeChat Work bot successfully');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.startPing();
          onConnected?.();
        } else {
          const err = new Error(`Subscribe failed: ${errmsg}`);
          this.log(err.message);
          onFailed?.(err);
        }
        return;
      }

      // Ping ACK
      if (reqId === this.lastPingReqId || reqId.startsWith(`${CMD_PING}_`)) {
        if (errcode !== 0) this.log(`Ping rejected: ${errmsg}`);
        return;
      }

      // Unknown bare ACK
      if (errcode !== 0) {
        this.log(`Command rejected reqId=${reqId}: errcode=${errcode} errmsg=${errmsg}`);
      }
    }
  }

  private async handleIncomingMessage(reqId: string, body: any, cmd: string): Promise<void> {
    if (!reqId || !body) return;

    // For event_callback without msgtype, it's an event — skip
    if (cmd === CMD_EVENT_CALLBACK && !body.msgtype) return;

    const userId = body.from?.userid;
    const chatId = body.chatid || body.from?.chatid || '';
    const msgId = body.msgid;
    const responseUrl = body.response_url;
    if (chatId) this.log(`Group message: chatId=${chatId}, from=${userId}`);

    // Extract quoted message content
    let quotedText = '';
    let quotedImageUrl = '';
    if (body.quote) {
      const qt = body.quote;
      if (qt.msgtype === 'text' && qt.text?.content) {
        quotedText = qt.text.content;
      } else if (qt.msgtype === 'markdown' && qt.markdown?.content) {
        quotedText = qt.markdown.content;
      } else if (qt.msgtype === 'image') {
        quotedImageUrl = qt.image?.url || qt.image?.img_url || '';
        this.log(`Quoted image: url=${quotedImageUrl ? 'yes' : 'no'}, keys=${JSON.stringify(Object.keys(qt.image || {}))}`);
      } else {
        this.log(`Quoted ${qt.msgtype}: ${JSON.stringify(qt).slice(0, 300)}`);
      }
    }

    const msgtype = body.msgtype || 'text';
    let content: string | undefined;
    let mediaId: string | undefined;
    let imageUrl: string | undefined;

    if (msgtype === 'voice') {
      content = body.voice?.content;
      mediaId = body.voice?.media_id;
      if (!userId || !content) {
        this.log(`Skipped voice message without content from ${userId || 'unknown'}`);
        return;
      }
      this.log(`Voice transcribed by WeCom: "${content}"`);
    } else if (msgtype === 'image') {
      imageUrl = body.image?.url || body.image?.img_url;
      mediaId = body.image?.media_id;
      const aeskey = body.image?.aeskey;
      this.log(`Image message from ${userId}: url=${imageUrl?.substring(0, 80)}..., aeskey=${aeskey ? `len=${aeskey.length} val=${aeskey.substring(0, 20)}...` : 'no'}`);
      if (!userId || (!imageUrl && !mediaId)) {
        this.log(`Skipped image message without url/media_id from ${userId || 'unknown'}`);
        return;
      }
      content = '';
    } else if (msgtype === 'text') {
      content = body.text?.content;
      if (!userId || !content) {
        this.log(`Skipped empty text message from ${userId || 'unknown'}`);
        return;
      }
      // Prepend quoted content for context
      if (quotedText) {
        content = `[引用: ${quotedText}]\n${content}`;
      }
    } else {
      this.log(`Skipped ${msgtype} message from ${userId || 'unknown'}`);
      return;
    }

    // Dedup by msgid
    if (msgId && this.recentMsgIds.has(msgId)) return;
    if (msgId) {
      this.recentMsgIds.add(msgId);
      const timer = setTimeout(() => {
        this.recentMsgIds.delete(msgId);
        this.recentMsgTimers.delete(msgId);
      }, 30_000);
      this.recentMsgTimers.set(msgId, timer);
    }

    // Store response_url for proactive use
    if (responseUrl) {
      this.responseUrls.set(userId, { url: responseUrl, ts: Date.now() });
    }

    if (this.messageHandler) {
      await this.messageHandler({
        userId,
        content: content || '',
        msgType: msgtype as 'text' | 'voice' | 'image',
        chatId: chatId || undefined,
        chatType: chatId ? 'group' : 'direct',
        reqId,
        msgId,
        raw: {
          responseUrl,
          mediaId,
          imageUrl,
          imageAesKey: msgtype === 'image' ? body.image?.aeskey : undefined,
          quotedImageUrl: quotedImageUrl || undefined,
          quotedImageAesKey: quotedImageUrl ? body.quote?.image?.aeskey : undefined,
          fromName: body.from?.name,
        },
      });
    }
  }

  // ── Reply queue (sequential sends with ACK) ──

  private async enqueueReply(reqId: string, body: Record<string, unknown>): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.log('Cannot respond: WebSocket not connected');
      return;
    }

    const frame = {
      cmd: CMD_RESPONSE,
      headers: { req_id: reqId },
      body,
    };

    return new Promise<void>((resolve, reject) => {
      const queue = this.replyQueues.get(reqId) ?? [];
      queue.push({ frame, resolve: resolve as any, reject });
      this.replyQueues.set(reqId, queue);
      if (queue.length === 1) {
        this.processReplyQueue(reqId);
      }
    });
  }

  private processReplyQueue(reqId: string): void {
    if (this.pendingAcks.has(reqId)) return;
    const queue = this.replyQueues.get(reqId);
    if (!queue || queue.length === 0) {
      this.replyQueues.delete(reqId);
      return;
    }

    const item = queue[0]!;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      queue.shift();
      item.reject(new Error('WebSocket not connected'));
      if (queue.length === 0) this.replyQueues.delete(reqId);
      else this.processReplyQueue(reqId);
      return;
    }

    const timer = setTimeout(() => {
      this.pendingAcks.delete(reqId);
      const q = this.replyQueues.get(reqId);
      if (q?.length) {
        q.shift();
        if (q.length === 0) this.replyQueues.delete(reqId);
      }
      this.log(`Reply ACK timeout for req_id=${reqId}`);
      item!.resolve();
      if (this.replyQueues.has(reqId)) {
        this.processReplyQueue(reqId);
      }
    }, ACK_TIMEOUT);

    this.pendingAcks.set(reqId, { resolve: item.resolve, reject: item.reject, timer });
    this.ws.send(JSON.stringify(item.frame));
  }

  private handleReplyAck(reqId: string, data: any): void {
    const pending = this.pendingAcks.get(reqId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingAcks.delete(reqId);

    const queue = this.replyQueues.get(reqId);
    if (queue?.length) {
      queue.shift();
      if (queue.length === 0) this.replyQueues.delete(reqId);
    }

    const errcode = data.errcode ?? -1;
    if (errcode === 0) {
      pending.resolve(data);
    } else {
      const errmsg = String(data.errmsg ?? 'unknown');
      this.log(`Reply ACK error: errcode=${errcode} errmsg=${errmsg}`);
      pending.resolve();
    }

    if (this.replyQueues.has(reqId)) {
      this.processReplyQueue(reqId);
    }
  }

  private clearPendingReplies(reason: string): void {
    for (const pending of this.pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingAcks.clear();
    for (const queue of this.replyQueues.values()) {
      for (const item of queue) {
        item.reject(new Error(reason));
      }
    }
    this.replyQueues.clear();
  }

  private sendFrame(data: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingInterval = setInterval(() => {
      this.lastPingReqId = `${CMD_PING}_${Date.now()}`;
      this.sendFrame({ cmd: CMD_PING, headers: { req_id: this.lastPingReqId } });
    }, PING_INTERVAL);
  }

  private stopPing(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.disconnected || this.reconnectAttempts >= 10) return;
    this.reconnectAttempts++;
    const delay = 5000 * Math.min(this.reconnectAttempts, 5);
    this.log(`Reconnecting in ${delay / 1000}s (${this.reconnectAttempts}/10)`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.disconnected) {
        this.connect().catch((e) => this.log(`Reconnect failed: ${e}`));
      }
    }, delay);
  }
}

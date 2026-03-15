/**
 * WeCom App Channel — direct enterprise app integration (self-contained)
 *
 * Receives messages via WeCom callback (HTTP) and sends via WeCom API.
 * No relay server needed — handles callback verification, AES decryption,
 * access token management, and message sending all in one.
 *
 * Ported from FlashClaw for Hopcode integration.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import type { Channel, IncomingMessage, MessageHandler } from './types.js';

const WECOM_API = 'https://qyapi.weixin.qq.com/cgi-bin';

export interface WeComAppConfig {
  /** Enterprise corp ID */
  corpId: string;
  /** App secret (for access_token) */
  corpSecret: string;
  /** Agent ID (numeric) */
  agentId: string;
  /** Callback verification token */
  callbackToken: string;
  /** Callback EncodingAESKey (43-char base64 string) */
  encodingAESKey: string;
  /** HTTP port for receiving callbacks (default: 3003) */
  callbackPort?: number;
  /** Callback URL path (default: /wecom/callback) */
  callbackPath?: string;
  /** Logger */
  log?: (msg: string) => void;
}

export class WeComApp implements Channel {
  private handler: MessageHandler | null = null;
  private server: http.Server | null = null;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  private corpId: string;
  private corpSecret: string;
  private agentId: string;
  private callbackToken: string;
  private aesKey: Buffer;
  private callbackPort: number;
  private callbackPath: string;
  private log: (msg: string) => void;

  /** Recent msg IDs for dedup */
  private recentMsgIds = new Set<string>();

  constructor(config: WeComAppConfig) {
    this.corpId = config.corpId;
    this.corpSecret = config.corpSecret;
    this.agentId = config.agentId;
    this.callbackToken = config.callbackToken;
    this.aesKey = Buffer.from(config.encodingAESKey + '=', 'base64');
    this.callbackPort = config.callbackPort ?? 3003;
    this.callbackPath = config.callbackPath ?? '/wecom/callback';
    this.log = config.log ?? (() => {});
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // Pre-fetch access token
    await this.getAccessToken();

    return new Promise<void>((resolve) => {
      this.server = http.createServer(async (req, res) => {
        const url = new URL(req.url || '/', `http://localhost:${this.callbackPort}`);

        if (url.pathname !== this.callbackPath) {
          res.writeHead(404);
          res.end('not found');
          return;
        }

        try {
          if (req.method === 'GET') {
            await this.handleVerify(url, res);
          } else if (req.method === 'POST') {
            await this.handleCallback(url, req, res);
          } else {
            res.writeHead(405);
            res.end();
          }
        } catch (err: any) {
          this.log(`Callback error: ${err.message || err}`);
          res.writeHead(500);
          res.end('error');
        }
      });

      this.server.listen(this.callbackPort, '0.0.0.0', () => {
        this.log(`WeComApp callback listening on :${this.callbackPort}${this.callbackPath}`);
        resolve();
      });
    });
  }

  stop(): void {
    this.server?.close();
    this.server = null;
  }

  // ── Send message via WeCom API ──

  async sendText(userId: string, text: string): Promise<void> {
    const token = await this.getAccessToken();
    const resp = await fetch(`${WECOM_API}/message/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        touser: userId,
        msgtype: 'text',
        agentid: this.agentId,
        text: { content: text },
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = await resp.json() as any;
    if (data.errcode && data.errcode !== 0) {
      // Token might be expired, retry once
      if (data.errcode === 40014 || data.errcode === 42001) {
        this.accessToken = null;
        const newToken = await this.getAccessToken();
        await fetch(`${WECOM_API}/message/send?access_token=${newToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            touser: userId,
            msgtype: 'text',
            agentid: this.agentId,
            text: { content: text },
          }),
          signal: AbortSignal.timeout(10_000),
        });
        return;
      }
      this.log(`WeComApp send error: ${data.errcode} ${data.errmsg}`);
    }
  }

  // ── Access token management ──

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.accessToken;
    }
    const resp = await fetch(
      `${WECOM_API}/gettoken?corpid=${this.corpId}&corpsecret=${this.corpSecret}`,
      { signal: AbortSignal.timeout(10_000) },
    );
    const data = await resp.json() as any;
    if (!data.access_token) {
      throw new Error(`Failed to get access_token: ${data.errcode} ${data.errmsg}`);
    }
    this.accessToken = data.access_token;
    this.tokenExpiresAt = Date.now() + (data.expires_in ?? 7200) * 1000;
    this.log('WeComApp access_token refreshed');
    return this.accessToken!;
  }

  // ── Callback: URL verification (GET) ──

  private async handleVerify(url: URL, res: http.ServerResponse): Promise<void> {
    const msgSignature = url.searchParams.get('msg_signature') || '';
    const timestamp = url.searchParams.get('timestamp') || '';
    const nonce = url.searchParams.get('nonce') || '';
    const echostr = url.searchParams.get('echostr') || '';

    if (!this.verifySignature(msgSignature, timestamp, nonce, echostr)) {
      this.log('WeComApp verify failed: invalid signature');
      res.writeHead(403);
      res.end('invalid signature');
      return;
    }

    const decrypted = this.decrypt(echostr);
    this.log('WeComApp URL verification successful');
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(decrypted);
  }

  // ── Callback: message (POST) ──

  private async handleCallback(url: URL, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const msgSignature = url.searchParams.get('msg_signature') || '';
    const timestamp = url.searchParams.get('timestamp') || '';
    const nonce = url.searchParams.get('nonce') || '';

    // Read body
    const body = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks).toString()));
      req.on('error', reject);
    });

    // Parse outer XML to get Encrypt field
    const encryptMatch = body.match(/<Encrypt><!\[CDATA\[(.*?)\]\]><\/Encrypt>/s)
      || body.match(/<Encrypt>(.*?)<\/Encrypt>/s);
    if (!encryptMatch) {
      this.log('WeComApp callback: no Encrypt field');
      res.writeHead(400);
      res.end('bad request');
      return;
    }
    const encrypted = encryptMatch[1]!;

    // Verify signature using encrypted content
    if (!this.verifySignature(msgSignature, timestamp, nonce, encrypted)) {
      this.log('WeComApp callback: invalid signature');
      res.writeHead(403);
      res.end('invalid signature');
      return;
    }

    // Respond immediately (WeCom requires fast response)
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('success');

    // Decrypt and process
    try {
      const xml = this.decrypt(encrypted!);
      const msg = this.parseXml(xml);
      await this.processMessage(msg);
    } catch (err: any) {
      this.log(`WeComApp decrypt/process error: ${err.message || err}`);
    }
  }

  // ── Message processing ──

  private async processMessage(msg: Record<string, string>): Promise<void> {
    if (!this.handler) return;

    const msgType = msg.MsgType || '';
    const userId = msg.FromUserName || '';
    const msgId = msg.MsgId || '';
    const agentId = msg.AgentID || '';

    // Filter by agentId if set
    if (this.agentId && agentId && agentId !== this.agentId) return;

    // Only handle text, voice, image
    if (!['text', 'voice', 'image'].includes(msgType)) {
      this.log(`WeComApp skipping ${msgType} message`);
      return;
    }

    // Dedup
    if (msgId && this.recentMsgIds.has(msgId)) return;
    if (msgId) {
      this.recentMsgIds.add(msgId);
      setTimeout(() => this.recentMsgIds.delete(msgId), 30_000);
    }

    let content = '';
    let incomingType: 'text' | 'voice' | 'image' = 'text';

    if (msgType === 'text') {
      content = msg.Content || '';
      if (!content) return;
      this.log(`WeComApp text from ${userId}: ${content.slice(0, 60)}`);
    } else if (msgType === 'voice') {
      content = msg.Recognition || '';
      incomingType = 'voice';
      if (!content) {
        this.log(`WeComApp voice without recognition from ${userId}`);
        return;
      }
      this.log(`WeComApp voice from ${userId}: ${content.slice(0, 60)}`);
    } else if (msgType === 'image') {
      incomingType = 'image';
      this.log(`WeComApp image from ${userId}`);
    }

    await this.handler({
      userId,
      content,
      msgType: incomingType,
      chatType: 'direct',
      msgId,
      raw: {
        agentId,
        mediaId: msg.MediaId,
        picUrl: msg.PicUrl,
        format: msg.Format,
      },
    });
  }

  // ── Crypto ──

  private verifySignature(signature: string, timestamp: string, nonce: string, data: string): boolean {
    const items = [this.callbackToken, timestamp, nonce, data].sort();
    const hash = crypto.createHash('sha1').update(items.join('')).digest('hex');
    return hash === signature;
  }

  private decrypt(encrypted: string): string {
    const iv = this.aesKey.subarray(0, 16);
    const decipher = crypto.createDecipheriv('aes-256-cbc', this.aesKey, iv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]);

    // Remove PKCS#7 padding
    const padLen = decrypted[decrypted.length - 1]!;
    const content = decrypted.subarray(0, decrypted.length - padLen);

    // Format: random(16) + msgLen(4, big-endian) + msg + corpId
    const msgLen = content.readUInt32BE(16);
    return content.subarray(20, 20 + msgLen).toString('utf-8');
  }

  private parseXml(xml: string): Record<string, string> {
    const result: Record<string, string> = {};
    const regex = /<(\w+)>(?:<!\[CDATA\[(.*?)\]\]>|(.*?))<\/\1>/gs;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(xml)) !== null) {
      result[match[1]!] = match[2] ?? match[3] ?? '';
    }
    return result;
  }
}

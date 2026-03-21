/**
 * WeComBridge — connects WeChat Work channels to Hopcode Easy Mode sessions.
 *
 * Handles:
 * - User binding (wecomUserId → hopcodeUsername via password verification)
 * - Session routing (most recent active session or manual switch)
 * - Group chat mapping (chatId → sessionId)
 * - Reply collection from ClaudeProcess and forwarding to channel
 * - Streaming replies for WeComBot
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { WeComBot } from './wecom-bot.js';
import { WeComApp } from './wecom-app.js';
import type { Channel, IncomingMessage } from './types.js';
import type { ClaudeProcess } from '../easymode/claude-process.js';
import type { EasyServerMessage } from '../easymode/protocol.js';
import { sendVoiceReply, isVoiceReplyAvailable } from './wecom-voice.js';

/** Mirrors EasySessionInfo from server-node.ts (subset needed by bridge) */
export interface BridgeSessionInfo {
  cp: ClaudeProcess;
  owner: string;
  project: string;
  name: string;
  createdAt: number;
  lastActivity: number;
  sharedWith: Set<string>;
}

/** Persistent bindings stored at ~/.hopcode/wecom-bindings.json */
interface BindingsData {
  bindings: Record<string, string>;       // wecomUserId → hopcodeUsername
  groupBindings: Record<string, string>;  // chatId → sessionId
}

const BINDINGS_FILE = path.join(process.env.HOME || '/root', '.hopcode', 'wecom-bindings.json');
const MAX_WECOM_TEXT = 2000; // WeCom text message char limit (conservative)

// Bot names in WeCom that should be treated as @小码 (the AI)
const BOT_NAMES = ['小码', 'xiaoma', '小云', 'xiaoyun'];

export class WeComBridge {
  private channels: Channel[] = [];
  private botChannel: WeComBot | null = null;
  private botChannels: Set<WeComBot> = new Set();
  private userLastBot: Map<string, WeComBot> = new Map(); // wecomUserId → last active bot
  private userLastActivity: Map<string, number> = new Map(); // wecomUserId → timestamp

  // Bindings
  private bindings = new Map<string, string>();       // wecomUserId → hopcodeUsername
  private activeSession = new Map<string, string>();  // wecomUserId → sessionId
  private groupBindings = new Map<string, string>();  // chatId → sessionId

  // Reply listeners (cleanup on stop)
  private replyListeners = new Map<string, (msg: EasyServerMessage) => void>();
  // Track voice requests — send voice reply when complete
  private voiceRequests = new Set<string>(); // listenerKey for pending voice replies
  // Track users awaiting project selection (bare number → switch)
  private awaitingSelection = new Map<string, number>(); // wecomUserId → timestamp

  private log: (msg: string) => void;

  constructor(
    private easySessions: Map<string, BridgeSessionInfo>,
    private saveRegistry: () => void,
    private createSession: (owner: string) => BridgeSessionInfo,
    private loadUsers: () => Record<string, { password: string; linuxUser?: string }>,
  ) {
    this.log = (msg: string) => console.log(`[wecom-bridge] ${msg}`);
    this.loadBindings();
  }

  // ── Lifecycle ──

  async start(): Promise<void> {
    // WeComBot (WebSocket long-connection) — supports multiple bots
    const botConfigs: { id: string; secret: string; label: string }[] = [];
    if (process.env.WECOM_BOT_ID && process.env.WECOM_BOT_SECRET) {
      botConfigs.push({ id: process.env.WECOM_BOT_ID, secret: process.env.WECOM_BOT_SECRET, label: 'primary' });
    }
    // Additional bots: WECOM_BOT_ID_2, WECOM_BOT_SECRET_2, etc.
    for (let i = 2; i <= 9; i++) {
      const id = process.env[`WECOM_BOT_ID_${i}`];
      const secret = process.env[`WECOM_BOT_SECRET_${i}`];
      if (id && secret) botConfigs.push({ id, secret, label: `bot-${i}` });
    }
    for (const cfg of botConfigs) {
      const bot = new WeComBot({
        botId: cfg.id,
        botSecret: cfg.secret,
        log: (msg) => console.log(`[wecom-bot:${cfg.label}] ${msg}`),
      });
      bot.onMessage((msg) => this.handleMessage(msg, bot).catch(e => this.log(`handleMessage error: ${e}`)));
      this.channels.push(bot);
      this.botChannels.add(bot);
      if (!this.botChannel) this.botChannel = bot; // first bot is the default for proactive messages
      try {
        await bot.start();
        this.log(`WeComBot (${cfg.label}) started: ${cfg.id.slice(0, 12)}...`);
      } catch (e) {
        this.log(`WeComBot (${cfg.label}) start failed: ${e}`);
      }
    }

    // WeComApp (HTTP callback)
    if (process.env.WECOM_CORP_ID && process.env.WECOM_SECRET) {
      const app = new WeComApp({
        corpId: process.env.WECOM_CORP_ID,
        corpSecret: process.env.WECOM_SECRET,
        agentId: process.env.WECOM_AGENT_ID || '',
        callbackToken: process.env.WECOM_CALLBACK_TOKEN || '',
        encodingAESKey: process.env.WECOM_CALLBACK_ENCODING_AES_KEY || '',
        callbackPort: parseInt(process.env.WECOM_CALLBACK_PORT || '3003'),
        log: (msg) => console.log(`[wecom-app] ${msg}`),
      });
      app.onMessage((msg) => this.handleMessage(msg, app).catch(e => this.log(`handleMessage error: ${e}`)));
      this.channels.push(app);
      try {
        await app.start();
        this.log('WeComApp channel started');
      } catch (e) {
        this.log(`WeComApp start failed: ${e}`);
      }
    }

    if (this.channels.length === 0) {
      this.log('No WeChat Work channels configured');
    }
  }

  stop(): void {
    for (const ch of this.channels) {
      try { ch.stop(); } catch {}
    }
    this.channels = [];
    this.botChannel = null;
    // Clean up reply listeners
    for (const [key, listener] of Array.from(this.replyListeners)) {
      const sessionId = key.split(':')[0]!;
      const info = this.easySessions.get(sessionId);
      if (info) info.cp.removeListener(listener);
    }
    this.replyListeners.clear();
  }

  // ── Message handling ──

  private async handleMessage(msg: IncomingMessage, channel: Channel): Promise<void> {
    const { userId, content, chatId, chatType } = msg;
    this.log(`handleMessage: userId=${userId} chatType=${chatType} content="${content.slice(0, 80)}"`);

    // For WeComBot, set active req_id for reply routing and track last active bot
    if (this.botChannels.has(channel as WeComBot)) {
      this.userLastBot.set(userId, channel as WeComBot);
      this.userLastActivity.set(userId, Date.now());
      if (msg.reqId) (channel as WeComBot).setActiveReqId(userId, msg.reqId);
    }

    try {
      // Group chat handling
      if (chatType === 'group' && chatId) {
        await this.handleGroupMessage(msg, channel);
        return;
      }

      // Direct message handling
      const hopcodeUser = this.bindings.get(userId);

      // Not bound — check for bind command or show instructions
      if (!hopcodeUser) {
        if (this.tryBindCommand(userId, content, channel)) return;
        await this.sendReply(channel, userId, chatId,
          '你好！请先绑定立码账号：\n\n发送：绑定 用户名:密码\n\n例如：绑定 xiaoming:abc123');
        return;
      }

      // Check for commands
      if (await this.handleCommand(userId, hopcodeUser, content, channel, chatId)) return;

      // Route to Easy Mode session (mark voice for voice reply)
      await this.routeToSession(userId, hopcodeUser, content, channel, chatId, msg, msg.msgType === 'voice');
    } finally {
      // Clear active req_id after processing (for non-streaming)
      // For streaming, it will be cleared when the reply finishes
    }
  }

  // ── Group chat ──

  /** Track group participants (chatId → Set of display names) */
  private groupParticipants = new Map<string, Set<string>>();

  private async handleGroupMessage(msg: IncomingMessage, channel: Channel): Promise<void> {
    const { userId, content, chatId } = msg;
    const hopcodeUser = this.bindings.get(userId);

    // Determine sender display name: bound username > WeCom name > userId
    const senderName = hopcodeUser || msg.raw?.fromName || userId;

    // Track group participants
    if (chatId) {
      if (!this.groupParticipants.has(chatId)) {
        this.groupParticipants.set(chatId, new Set());
      }
      this.groupParticipants.get(chatId)!.add(senderName);
    }

    // Handle group-level commands (only from bound users)
    if (hopcodeUser && chatId) {
      const trimmed = content.trim();

      // Bind group to a session: 绑定项目 <name/number>
      const bindGroupMatch = trimmed.match(/^绑定项目\s+(.+)$/);
      if (bindGroupMatch) {
        const target = bindGroupMatch[1]!.trim();
        const sessions = this.getUserSessions(hopcodeUser);
        let found: { id: string; name: string } | undefined;

        const num = parseInt(target);
        if (!isNaN(num) && num >= 1 && num <= sessions.length) {
          const s = sessions[num - 1]!;
          found = { id: s.id, name: s.name || s.project || s.id };
        }
        if (!found) {
          const s = sessions.find(s =>
            (s.name && s.name.includes(target)) ||
            (s.project && s.project.includes(target))
          );
          if (s) found = { id: s.id, name: s.name || s.project || s.id };
        }

        if (found) {
          this.groupBindings.set(chatId, found.id);
          this.saveBindings();
          await this.sendReply(channel, userId, chatId, `群聊已绑定到项目「${found.name}」`);
        } else {
          const sessionList = sessions.map((s, i) => `${i + 1}. ${s.name || s.project}`).join('\n');
          await this.sendReply(channel, userId, chatId,
            `未找到「${target}」。你的项目：\n${sessionList}\n\n发送「绑定项目 序号」绑定。`);
        }
        return;
      }
    }

    // First bound user in group auto-binds group to their active session
    if (hopcodeUser && chatId && !this.groupBindings.has(chatId)) {
      const sessionId = this.findActiveSession(hopcodeUser);
      if (sessionId) {
        this.groupBindings.set(chatId, sessionId);
        this.saveBindings();
        this.log(`Group ${chatId} auto-bound to session ${sessionId} by ${hopcodeUser}`);
      } else {
        // Create a new session for the user
        const info = this.createSession(hopcodeUser);
        const newId = [...this.easySessions.entries()].find(([, v]) => v === info)?.[0];
        if (newId) {
          this.groupBindings.set(chatId, newId);
          this.saveBindings();
          this.log(`Group ${chatId} auto-created session ${newId} for ${hopcodeUser}`);
        }
      }
    }

    // Check if group is bound to a session
    const sessionId = chatId ? this.groupBindings.get(chatId) : undefined;
    if (!sessionId) {
      // Not bound — need a bound user to join first
      if (!hopcodeUser) {
        // Unbound user in unbound group — silently ignore or prompt
        // Don't spam; just ignore for now
      }
      return;
    }

    const info = this.easySessions.get(sessionId);
    if (!info) return;

    // Add bound sender as guest if not owner
    if (hopcodeUser && hopcodeUser !== info.owner) {
      info.sharedWith.add(hopcodeUser);
      this.saveRegistry();
    }

    // Parse @mentions from message text
    // Match @name patterns (Chinese or English names, handles spaces)
    const mentionRegex = /@([\u4e00-\u9fa5a-zA-Z0-9_]+)/g;
    const rawMentions: string[] = [];
    let mentionMatch: RegExpExecArray | null;
    while ((mentionMatch = mentionRegex.exec(content)) !== null) {
      rawMentions.push(mentionMatch[1]!);
    }

    // Map bot names to 小码 (the AI name in ClaudeProcess)
    const mentions: string[] = [];
    for (const m of rawMentions) {
      if (BOT_NAMES.includes(m.toLowerCase())) {
        if (!mentions.includes('小码')) mentions.push('小码');
      } else {
        mentions.push(m);
      }
    }

    // Clean @mentions from content before sending to Claude
    let cleanContent = content;
    for (const name of BOT_NAMES) {
      cleanContent = cleanContent.replace(new RegExp(`@${name}\\s*`, 'gi'), '');
    }
    cleanContent = cleanContent.trim();
    // If only @小码 with no text, treat as "calling me" — prompt to continue or greet
    if (!cleanContent) {
      if (mentions.includes('小码')) {
        cleanContent = '(用户@了你，请根据上下文继续之前的话题，或主动打招呼介绍自己)';
      } else {
        return;
      }
    }

    // participantCount = actual tracked participants in this group
    const participantCount = this.groupParticipants.get(chatId!)?.size || 2;

    // Set up reply listener
    if (this.botChannels.has(channel as WeComBot) && msg.reqId) {
      this.setupStreamingReply(sessionId, userId, channel, msg.reqId, chatId);
    } else {
      this.setupNonStreamingReply(sessionId, userId, channel, chatId);
    }

    const groupBaseUrl = process.env.PUBLIC_URL || 'https://gotong.gizwitsapi.com';
    const groupWecomHint = `\n[This user is on WeChat Work — reply in text/markdown only. NO inline images. Share images as full clickable URLs using domain: ${groupBaseUrl}]`;
    info.cp.sendMessage(cleanContent + groupWecomHint, senderName, mentions, participantCount);
    info.lastActivity = Date.now();
    this.saveRegistry();
  }

  // ── Commands ──

  private tryBindCommand(userId: string, content: string, channel: Channel): boolean {
    // Support: 绑定 user pass | 绑定 user:pass | 绑定 user：pass
    const bindMatch = content.trim().match(/^绑定\s+(\S+?)[:\s：]+(\S+)$/);
    if (!bindMatch) return false;

    const [, username, password] = bindMatch as RegExpMatchArray;
    // Normalize full-width to half-width characters
    const normalizedPassword = password!.replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
    const users = this.loadUsers();
    const userEntry = users[username!];

    if (!userEntry || userEntry.password !== normalizedPassword) {
      this.sendReply(channel, userId, undefined, '绑定失败：用户名或密码错误。');
      return true;
    }

    this.bindings.set(userId, username!);
    this.saveBindings();
    this.log(`Bound wecom:${userId} → hopcode:${username}`);
    this.sendReply(channel, userId, undefined,
      `绑定成功！你已关联到立码用户「${username}」🎉\n\n直接给小码发消息就能对话了，和网页版 Easy Mode 一样。发「项目列表」查看你的项目，回复序号可以切换。如果还没有项目，发「新建项目」即可创建。在群聊中 @小码 就能让它参与讨论。\n\n常用命令：\n• 项目列表 — 查看项目\n• 版本 — 查看文件历史\n• 回滚 序号 — 还原到之前的版本\n• 解绑 — 解除账号关联\n\n语音消息也支持，小码会自动识别并回复。`);
    return true;
  }

  private async handleCommand(
    userId: string, hopcodeUser: string, content: string,
    channel: Channel, chatId?: string,
  ): Promise<boolean> {
    const trimmed = content.trim();

    // Unbind
    if (trimmed === '解绑') {
      this.bindings.delete(userId);
      this.activeSession.delete(userId);
      this.saveBindings();
      await this.sendReply(channel, userId, chatId, '已解除绑定。');
      return true;
    }

    // Bind command (already bound — re-bind)
    if (trimmed.startsWith('绑定 ')) {
      this.tryBindCommand(userId, content, channel);
      return true;
    }

    // List sessions
    if (trimmed === '项目列表' || trimmed === '我的项目') {
      const sessions = this.getUserSessions(hopcodeUser);
      if (sessions.length === 0) {
        await this.sendReply(channel, userId, chatId,
          '你还没有任何项目。发送「新建项目」创建一个。');
        return true;
      }

      // Verify active session owner matches (handles re-bind scenario)
      const cachedSessionId = this.activeSession.get(userId);
      const cachedSession = cachedSessionId ? this.easySessions.get(cachedSessionId) : null;
      const activeId = (cachedSession && cachedSession.owner === hopcodeUser)
        ? cachedSessionId
        : this.findActiveSession(hopcodeUser);
      const lines = sessions.map((s, i) => {
        const marker = s.id === activeId ? ' ← 当前' : '';
        return `${i + 1}. ${s.name || s.project || s.id}${marker}`;
      });
      await this.sendReply(channel, userId, chatId,
        `你的项目：\n${lines.join('\n')}\n\n回复序号切换项目。`);
      this.awaitingSelection.set(userId, Date.now());
      return true;
    }

    // Switch session: "切换 xxx" or bare number (only if recently asked for project list)
    {
      const switchMatch = trimmed.match(/^切换\s+(.+)$/);
      const target = switchMatch ? switchMatch[1]!.trim() : trimmed;
      const num = this.parseNumber(target);
      const sessions = this.getUserSessions(hopcodeUser);

      // Bare number only works within 60s of "项目列表"
      const awaiting = this.awaitingSelection.get(userId);
      const isAwaiting = awaiting && (Date.now() - awaiting < 60_000);
      if (switchMatch || (isAwaiting && num > 0 && num <= sessions.length)) {
        if (isAwaiting) this.awaitingSelection.delete(userId);
        let found: { id: string; name: string } | undefined;

        if (num >= 1 && num <= sessions.length) {
          const s = sessions[num - 1]!;
          found = { id: s.id, name: s.name || s.project || s.id };
        }

        // Try by name (only with "切换" prefix)
        if (!found && switchMatch) {
          const s = sessions.find(s =>
            (s.name && s.name.includes(target)) ||
            (s.project && s.project.includes(target))
          );
          if (s) found = { id: s.id, name: s.name || s.project || s.id };
        }

        if (found) {
          this.activeSession.set(userId, found.id);
          await this.sendReply(channel, userId, chatId, `已切换到项目「${found.name}」`);
          return true;
        } else if (switchMatch) {
          await this.sendReply(channel, userId, chatId,
            `未找到匹配的项目「${target}」。发送「项目列表」查看所有项目。`);
          return true;
        }
      }
    }

    // Version history
    if (trimmed === '版本' || trimmed === '历史' || trimmed === '版本历史') {
      // Verify active session owner matches (handles re-bind scenario)
      const cachedSessionId = this.activeSession.get(userId);
      const cachedSession = cachedSessionId ? this.easySessions.get(cachedSessionId) : null;
      const sessionId = (cachedSession && cachedSession.owner === hopcodeUser)
        ? cachedSessionId
        : this.findActiveSession(hopcodeUser);
      const sessionInfo = sessionId ? this.easySessions.get(sessionId) : null;
      if (!sessionInfo) {
        await this.sendReply(channel, userId, chatId, '没有活跃的项目。');
        return true;
      }
      const entries = await sessionInfo.cp.versionTracker.log(10);
      if (entries.length === 0) {
        await this.sendReply(channel, userId, chatId, '暂无版本记录。');
        return true;
      }
      const lines = entries.map((e, i) => {
        const date = new Date(e.timestamp);
        const timeStr = `${date.getMonth()+1}/${date.getDate()} ${date.getHours().toString().padStart(2,'0')}:${date.getMinutes().toString().padStart(2,'0')}`;
        const files = e.filesChanged.map(f => f.replace('workspace/', '')).join(', ');
        const label = i === 0 ? '(当前)' : '';
        return `${i + 1}. ${timeStr}  ${e.message} ${label}\n   ${e.author}${files ? ' · ' + files : ''}`;
      });
      await this.sendReply(channel, userId, chatId,
        `最近版本：\n${lines.join('\n')}\n\n发送「回滚 序号」还原，如「回滚 3」。`);
      return true;
    }

    // Version restore
    const rollbackMatch = trimmed.match(/^回滚\s+(\S+)$/);
    if (rollbackMatch) {
      const target = rollbackMatch[1]!.trim();
      // Verify active session owner matches (handles re-bind scenario)
      const cachedSessionId = this.activeSession.get(userId);
      const cachedSession = cachedSessionId ? this.easySessions.get(cachedSessionId) : null;
      const sessionId = (cachedSession && cachedSession.owner === hopcodeUser)
        ? cachedSessionId
        : this.findActiveSession(hopcodeUser);
      const sessionInfo = sessionId ? this.easySessions.get(sessionId) : null;
      if (!sessionInfo) {
        await this.sendReply(channel, userId, chatId, '没有活跃的项目。');
        return true;
      }
      if (hopcodeUser !== sessionInfo.owner) {
        await this.sendReply(channel, userId, chatId, '只有项目创建者可以回滚版本。');
        return true;
      }
      const idx = this.parseNumber(target);
      if (idx < 1) {
        await this.sendReply(channel, userId, chatId, '请输入序号，如「回滚 3」。发送「版本」查看列表。');
        return true;
      }
      try {
        const entries = await sessionInfo.cp.versionTracker.log(50);
        if (idx > entries.length) {
          await this.sendReply(channel, userId, chatId, `序号 ${idx} 不存在。发送「版本」查看列表。`);
          return true;
        }
        const hash = entries[idx - 1]!.hash;
        const files = await sessionInfo.cp.versionTracker.restore(hash);
        const fileList = files.map(f => f.replace('workspace/', '')).join(', ');
        await this.sendReply(channel, userId, chatId,
          `已还原。\n变更的文件：${fileList || '(无变化)'}`);
        // Notify Claude about the restore
        if (fileList) {
          sessionInfo.cp.sendMessage(`[系统通知] ${hopcodeUser} 还原了项目文件到之前的版本。变更的文件：${fileList}。请注意文件内容已变化。`, hopcodeUser);
        }
      } catch (e: any) {
        await this.sendReply(channel, userId, chatId, `回滚失败：${e.message}`);
      }
      return true;
    }

    // Create new session
    if (trimmed === '新建项目') {
      const info = this.createSession(hopcodeUser);
      this.activeSession.set(userId, [...this.easySessions.entries()]
        .find(([, v]) => v === info)?.[0] || '');
      await this.sendReply(channel, userId, chatId,
        `已创建新项目「${info.name || info.project}」并切换到该项目。`);
      return true;
    }

    return false;
  }

  // ── Image download ──

  /**
   * Download image from WeComBot URL, decrypt with AES key, save to workspace.
   * WeComBot images are AES-256-CBC encrypted. The aeskey is base64-encoded.
   * Decryption: key = base64decode(aeskey), IV = key[0:16], AES-256-CBC, PKCS7 padding.
   */
  private async downloadImage(imageUrl: string, aesKey: string | undefined, projectDir: string): Promise<string | null> {
    try {
      const resp = await fetch(imageUrl, { signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        this.log(`Image download failed: ${resp.status}`);
        return null;
      }

      let imageData = Buffer.from(await resp.arrayBuffer());
      this.log(`Image downloaded: ${imageData.length} bytes, aesKey=${aesKey ? `yes (len=${aesKey.length}, decoded=${Buffer.from(aesKey, 'base64').length})` : 'no'}`);

      // AES-256-CBC decryption (WeCom smart robot protocol, ported from yww-fc)
      // Only decrypt if data doesn't already look like an image
      const isImg = (b: Buffer) =>
        (b[0] === 0xff && b[1] === 0xd8) || // JPEG
        (b[0] === 0x89 && b[1] === 0x50) || // PNG
        (b[0] === 0x47 && b[1] === 0x49) || // GIF
        (b[0] === 0x52 && b[1] === 0x49);   // WebP

      if (aesKey && !isImg(imageData)) {
        try {
          const key = Buffer.from(aesKey + '=', 'base64');
          const iv = key.subarray(0, 16);
          const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
          decipher.setAutoPadding(false);
          const decrypted = Buffer.concat([decipher.update(imageData), decipher.final()]);

          // Remove PKCS#7 padding (32-byte blocks)
          const pad = decrypted[decrypted.length - 1]!;
          const unpadded = (pad > 0 && pad <= 32)
            ? decrypted.subarray(0, decrypted.length - pad)
            : decrypted;

          if (isImg(unpadded)) {
            imageData = unpadded;
          } else {
            // Envelope format: random(16) + msgLen(4, BE) + content + corpId
            const contentLen = decrypted.readUInt32BE(16);
            const envelope = decrypted.subarray(20, 20 + contentLen);
            if (contentLen > 0 && contentLen < decrypted.length && isImg(envelope)) {
              imageData = envelope;
            }
          }
          this.log(`Image decrypted: ${imageData.length} bytes`);
        } catch (e) {
          this.log(`AES decryption failed: ${e}, using raw data`);
        }
      }

      // Detect format from magic bytes
      let ext = '.jpg';
      if (imageData[0] === 0x89 && imageData[1] === 0x50) ext = '.png';
      else if (imageData[0] === 0x47 && imageData[1] === 0x49) ext = '.gif';
      else if (imageData[0] === 0x52 && imageData[1] === 0x49) ext = '.webp';

      const wsDir = path.join(projectDir, 'workspace');
      fs.mkdirSync(wsDir, { recursive: true });

      const filename = `wecom-img-${Date.now()}${ext}`;
      const filepath = path.join(wsDir, filename);
      fs.writeFileSync(filepath, imageData);

      this.log(`Image saved: ${filepath} (${imageData.length} bytes)`);
      return filepath;
    } catch (e) {
      this.log(`Image download error: ${e}`);
      return null;
    }
  }

  /** Download file from WeComBot URL, save to workspace with original filename */
  private async downloadFile(fileUrl: string, aesKey: string | undefined, projectDir: string, content: string): Promise<string | null> {
    try {
      const resp = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) {
        this.log(`File download failed: ${resp.status}`);
        return null;
      }

      let fileData = Buffer.from(await resp.arrayBuffer());

      // AES decryption if needed (same as image)
      if (aesKey) {
        try {
          const key = Buffer.from(aesKey + '=', 'base64');
          const iv = key.subarray(0, 16);
          const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
          decipher.setAutoPadding(false);
          const decrypted = Buffer.concat([decipher.update(fileData), decipher.final()]);
          const pad = decrypted[decrypted.length - 1]!;
          fileData = (pad > 0 && pad <= 32) ? decrypted.subarray(0, decrypted.length - pad) : decrypted;
        } catch (e) {
          this.log(`File AES decryption failed: ${e}, using raw data`);
        }
      }

      // Extract filename from content "[用户发送了文件: xxx.xlsx]"
      const nameMatch = content.match(/\[用户发送了文件: (.+?)\]/);
      const filename = nameMatch ? nameMatch[1] : `wecom-file-${Date.now()}`;

      const wsDir = path.join(projectDir, 'workspace');
      fs.mkdirSync(wsDir, { recursive: true });
      const filepath = path.join(wsDir, filename);
      fs.writeFileSync(filepath, fileData);

      this.log(`File saved: ${filepath} (${fileData.length} bytes)`);
      return filepath;
    } catch (e) {
      this.log(`File download error: ${e}`);
      return null;
    }
  }

  // ── Session routing ──

  private async routeToSession(
    userId: string, hopcodeUser: string, content: string,
    channel: Channel, chatId: string | undefined, msg: IncomingMessage,
    isVoice: boolean = false,
  ): Promise<void> {
    // Find target session
    let sessionId = this.activeSession.get(userId);
    // Also verify session owner matches the bound user (handles re-bind scenario)
    const existingSession = sessionId ? this.easySessions.get(sessionId) : null;
    if (!sessionId || !existingSession || existingSession.owner !== hopcodeUser) {
      sessionId = this.findActiveSession(hopcodeUser);
    }

    // No session — create one
    if (!sessionId) {
      const info = this.createSession(hopcodeUser);
      sessionId = [...this.easySessions.entries()]
        .find(([, v]) => v === info)?.[0];
      if (!sessionId) {
        await this.sendReply(channel, userId, chatId, '创建项目失败，请稍后再试。');
        return;
      }
      this.activeSession.set(userId, sessionId);
      await this.sendReply(channel, userId, chatId,
        `已自动创建项目「${info.name || info.project}」。`);
    }

    this.activeSession.set(userId, sessionId);

    const info = this.easySessions.get(sessionId);
    if (!info) return;

    // Handle image messages: download, decrypt, save, tell Claude to read it
    let messageContent = content;
    if (msg.msgType === 'image' && msg.raw?.imageUrl) {
      const imagePath = await this.downloadImage(
        msg.raw.imageUrl, msg.raw.imageAesKey, info.cp.projectDir,
      );
      if (imagePath) {
        messageContent = content
          ? `${content}\n\n[用户发送了一张图片: ${imagePath}]`
          : `[用户发送了一张图片: ${imagePath}]`;
      } else {
        messageContent = content || '[用户发送了一张图片，但下载失败]';
      }
    } else if (msg.msgType === 'file' && msg.raw?.imageUrl) {
      // File attachment (Excel, PDF, etc.) — download and save to workspace
      const filePath = await this.downloadFile(
        msg.raw.imageUrl, msg.raw.imageAesKey, info.cp.projectDir, content,
      );
      if (filePath) {
        messageContent = `[用户发送了文件: ${filePath}]。请读取该文件并根据内容进行处理。`;
      } else {
        messageContent = content || '[用户发送了文件，但下载失败]';
      }
    }

    // Don't send empty messages
    if (!messageContent) {
      this.log(`Skipping empty message from ${userId}`);
      return;
    }

    // Mark voice request for voice reply
    const listenerKey = `${sessionId}:${userId}`;
    if (isVoice && isVoiceReplyAvailable()) {
      this.voiceRequests.add(listenerKey);
    }

    // Only set up reply listener if Claude is not busy
    // If busy, the message will be queued and the existing listener will catch all replies
    if (!info.cp.isActive()) {
      if (this.botChannels.has(channel as WeComBot) && msg.reqId) {
        this.setupStreamingReply(sessionId, userId, channel, msg.reqId, chatId);
      } else {
        this.setupNonStreamingReply(sessionId, userId, channel, chatId);
      }
    }

    // Send to Claude (add WeChat format hint — no inline images)
    const baseUrl = process.env.PUBLIC_URL || 'https://gotong.gizwitsapi.com';
    const wecomHint = `\n[This user is on WeChat Work — reply in text/markdown only. NO inline images. Share images as full clickable URLs using domain: ${baseUrl}]`;
    info.cp.sendMessage(messageContent + wecomHint, hopcodeUser, undefined, 1);
    info.lastActivity = Date.now();
    this.saveRegistry();
  }

  // ── Reply collection ──

  /** Set up streaming reply for WeComBot (stream chunks as they arrive) */
  private setupStreamingReply(
    sessionId: string, wecomUserId: string, channel: Channel,
    reqId: string, chatId?: string,
  ): void {
    const listenerKey = `${sessionId}:${wecomUserId}`;
    this.cleanupListener(listenerKey, sessionId);

    let streamId = `ws_${crypto.randomUUID()}`;
    let accumulated = '';
    let streamedAny = false; // true once real text arrives (vs spinner/progress)
    let lastSentLength = 0;
    const CHUNK_INTERVAL = 500; // ms between stream updates (match FlashClaw)
    const MIN_FIRST_CHARS = 10; // wait for enough text before first visible update
    let chunkTimer: ReturnType<typeof setTimeout> | null = null;

    // Immediately show typing indicator (official WeChat Work spinner bubble)
    const bot = channel as WeComBot;
    bot.sendStreamChunk(wecomUserId, streamId, '', false).catch(() => {});

    const sendChunk = (finish: boolean) => {
      if (accumulated.length > lastSentLength || finish) {
        bot.sendStreamChunk(wecomUserId, streamId, accumulated, finish).catch(() => {});
        lastSentLength = accumulated.length;
      }
    };

    const listener = (msg: EasyServerMessage) => {
      if (msg.type === 'message_delta' && 'delta' in msg) {
        accumulated += msg.delta;
        streamedAny = true;
        // Wait for enough text before first visible update
        if (accumulated.length < MIN_FIRST_CHARS) return;
        // Throttle stream updates
        if (!chunkTimer) {
          chunkTimer = setTimeout(() => {
            chunkTimer = null;
            sendChunk(false);
          }, CHUNK_INTERVAL);
        }
      } else if (msg.type === 'tool' && msg.status === 'running' && msg.name) {
        // Show tool progress (transient — will be replaced by real text)
        if (!streamedAny) {
          const toolLabel = msg.detail ? `${msg.name}: ${msg.detail}` : msg.name;
          accumulated = `⏳ ${toolLabel}...`;
          sendChunk(false);
        }
      } else if (msg.type === 'message' && msg.role === 'assistant' && msg.text) {
        // Complete message — finalize this stream and start a new one for queued messages
        accumulated = msg.text;
        streamedAny = true;
        if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
        sendChunk(true);
        // Voice reply if user sent voice
        if (this.voiceRequests.has(listenerKey) && accumulated) {
          this.voiceRequests.delete(listenerKey);
          sendVoiceReply(wecomUserId, accumulated).catch(() => {});
        }
        // Reset for next queued message (new stream)
        streamId = `ws_${crypto.randomUUID()}`;
        accumulated = '';
        streamedAny = false;
        lastSentLength = 0;
      } else if (msg.type === 'state' && msg.state === 'ready') {
        // All done (including queued messages) — clean up
        if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
        // If there's unsent accumulated text, send it
        if (accumulated) {
          sendChunk(true);
        }
        bot.clearActiveReqId(wecomUserId);
        this.cleanupListener(listenerKey, sessionId);
      } else if (msg.type === 'error') {
        if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
        const errText = accumulated
          ? accumulated + '\n\n⚠️ ' + msg.message
          : '⚠️ ' + msg.message;
        bot.sendStreamChunk(wecomUserId, streamId, errText, true).catch(() => {});
        bot.clearActiveReqId(wecomUserId);
        this.cleanupListener(listenerKey, sessionId);
      }
    };

    const info = this.easySessions.get(sessionId);
    if (info) {
      info.cp.addListener(listener);
      this.replyListeners.set(listenerKey, listener);
    }
  }

  /** Set up non-streaming reply for WeComApp (accumulate full text, send at end) */
  private setupNonStreamingReply(
    sessionId: string, wecomUserId: string, channel: Channel,
    chatId?: string,
  ): void {
    const listenerKey = `${sessionId}:${wecomUserId}`;
    this.cleanupListener(listenerKey, sessionId);

    let fullText = '';

    const listener = (msg: EasyServerMessage) => {
      if (msg.type === 'message' && msg.role === 'assistant' && msg.text) {
        // Send each complete message immediately (handles queued messages)
        this.sendReply(channel, wecomUserId, chatId, msg.text).catch(() => {});
        if (this.voiceRequests.has(listenerKey)) {
          this.voiceRequests.delete(listenerKey);
          sendVoiceReply(wecomUserId, msg.text).catch(() => {});
        }
        fullText = msg.text;
      } else if (msg.type === 'state' && msg.state === 'ready') {
        this.cleanupListener(listenerKey, sessionId);
      } else if (msg.type === 'error') {
        const errText = fullText
          ? fullText + '\n\n⚠️ ' + msg.message
          : '⚠️ ' + msg.message;
        this.sendReply(channel, wecomUserId, chatId, errText).catch(() => {});
        this.voiceRequests.delete(listenerKey);
        this.cleanupListener(listenerKey, sessionId);
      }
    };

    const info = this.easySessions.get(sessionId);
    if (info) {
      info.cp.addListener(listener);
      this.replyListeners.set(listenerKey, listener);
    }
  }

  private cleanupListener(key: string, sessionId: string): void {
    const existing = this.replyListeners.get(key);
    if (existing) {
      const info = this.easySessions.get(sessionId);
      if (info) info.cp.removeListener(existing);
      this.replyListeners.delete(key);
    }
  }

  // ── Proactive notifications ──

  /** Send a notification to a Hopcode user via WeChat Work (for task results, etc.) */
  async notifyUser(hopcodeUsername: string, text: string): Promise<boolean> {
    // Find all wecomUserIds bound to this hopcode user, pick the most recently active one
    let bestUserId: string | null = null;
    let bestBot: WeComBot | null = null;
    let bestTime = 0;

    for (const [wid, huser] of this.bindings) {
      if (huser !== hopcodeUsername) continue;
      const lastTime = this.userLastActivity.get(wid) || 0;
      if (lastTime > bestTime || !bestUserId) {
        bestUserId = wid;
        bestBot = this.userLastBot.get(wid) || this.botChannel;
        bestTime = lastTime;
      }
    }

    if (!bestUserId || !bestBot) return false;

    // Try proactive send (single chat, chatType=1)
    try {
      return await bestBot.sendProactive(bestUserId, text, 1);
    } catch (e) {
      this.log(`notifyUser failed for ${hopcodeUsername}: ${e}`);
      return false;
    }
  }

  // ── Helpers ──

  /** Parse number from Arabic or Chinese digits. Returns 0 if not a number. */
  private parseNumber(s: string): number {
    if (/^\d+$/.test(s)) return parseInt(s, 10);
    const zhMap: Record<string, number> = {
      '一': 1, '二': 2, '三': 3, '四': 4, '五': 5,
      '六': 6, '七': 7, '八': 8, '九': 9, '十': 10,
      '①': 1, '②': 2, '③': 3, '④': 4, '⑤': 5,
      '⑥': 6, '⑦': 7, '⑧': 8, '⑨': 9, '⑩': 10,
    };
    return zhMap[s] || 0;
  }

  private getUserSessions(username: string): Array<{ id: string; name: string; project: string; lastActivity: number }> {
    const result: Array<{ id: string; name: string; project: string; lastActivity: number }> = [];
    for (const [id, info] of this.easySessions) {
      if (info.owner === username) {
        result.push({ id, name: info.name, project: info.project, lastActivity: info.lastActivity });
      }
    }
    // Sort by lastActivity descending
    result.sort((a, b) => b.lastActivity - a.lastActivity);
    return result;
  }

  private findActiveSession(username: string): string | undefined {
    const sessions = this.getUserSessions(username);
    return sessions.length > 0 ? sessions[0]!.id : undefined;
  }

  /** Send reply, splitting long text into multiple messages */
  private async sendReply(channel: Channel, userId: string, chatId?: string, text?: string): Promise<void> {
    if (!text) return;
    this.log(`sendReply: userId=${userId} text="${text.slice(0, 80)}"`);

    // For group chat, try sendGroupText first
    if (chatId && channel.sendGroupText) {
      const chunks = this.splitText(text);
      for (const chunk of chunks) {
        await channel.sendGroupText(chatId, chunk);
      }
      return;
    }

    const chunks = this.splitText(text);
    for (const chunk of chunks) {
      await channel.sendText(userId, chunk);
    }
  }

  /** Split text into chunks that fit WeChat Work message limits */
  private splitText(text: string): string[] {
    if (text.length <= MAX_WECOM_TEXT) return [text];

    const chunks: string[] = [];
    const paragraphs = text.split('\n\n');
    let current = '';

    for (const para of paragraphs) {
      if (current && (current.length + 2 + para.length) > MAX_WECOM_TEXT) {
        chunks.push(current);
        current = para;
      } else {
        current = current ? current + '\n\n' + para : para;
      }
      // If single paragraph exceeds limit, split by newlines
      while (current.length > MAX_WECOM_TEXT) {
        const cutPoint = current.lastIndexOf('\n', MAX_WECOM_TEXT);
        if (cutPoint > 0) {
          chunks.push(current.substring(0, cutPoint));
          current = current.substring(cutPoint + 1);
        } else {
          chunks.push(current.substring(0, MAX_WECOM_TEXT));
          current = current.substring(MAX_WECOM_TEXT);
        }
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  // ── Persistence ──

  private loadBindings(): void {
    try {
      const data: BindingsData = JSON.parse(fs.readFileSync(BINDINGS_FILE, 'utf-8'));
      if (data.bindings) {
        for (const [k, v] of Object.entries(data.bindings)) {
          this.bindings.set(k, v);
        }
      }
      if (data.groupBindings) {
        for (const [k, v] of Object.entries(data.groupBindings)) {
          this.groupBindings.set(k, v);
        }
      }
      this.log(`Loaded ${this.bindings.size} binding(s), ${this.groupBindings.size} group binding(s)`);
    } catch {
      // No bindings file yet — normal on first run
    }
  }

  private saveBindings(): void {
    try {
      const data: BindingsData = {
        bindings: Object.fromEntries(this.bindings),
        groupBindings: Object.fromEntries(this.groupBindings),
      };
      fs.mkdirSync(path.dirname(BINDINGS_FILE), { recursive: true });
      fs.writeFileSync(BINDINGS_FILE, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      this.log(`Failed to save bindings: ${e}`);
    }
  }
}

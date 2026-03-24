#!/usr/bin/env npx tsx
/**
 * MCP Server for WeChat messaging.
 * Thin HTTP client that talks to wechat-service (port 3005).
 */

import * as readline from 'readline';

const WECHAT_SERVICE = 'http://127.0.0.1:3005';

async function svcFetch(path: string, method = 'GET', body?: any): Promise<any> {
  const opts: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${WECHAT_SERVICE}${path}`, opts);
  return resp.json();
}

const TOOLS = [
  {
    name: 'wechat_login',
    description: 'Open WeChat Web login page. Returns a URL for the user to scan the QR code. After login, the session persists permanently.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wechat_status',
    description: 'Check if WeChat Web is logged in and online.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wechat_send',
    description: 'Send a message to a WeChat contact or group.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Contact or group name (e.g. "Alex Huang", "文件传输助手")' },
        message: { type: 'string', description: 'Message text to send' },
      },
      required: ['contact', 'message'],
    },
  },
  {
    name: 'wechat_read',
    description: 'Read recent messages from a contact or group chat.',
    inputSchema: {
      type: 'object',
      properties: {
        contact: { type: 'string', description: 'Contact or group name' },
        count: { type: 'number', description: 'Number of messages (default: 10)' },
      },
      required: ['contact'],
    },
  },
  {
    name: 'wechat_contacts',
    description: 'Get the list of recent chats.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'wechat_search',
    description: 'Search for contacts or groups by name.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
      },
      required: ['query'],
    },
  },
];

const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const err = (t: string) => ({ content: [{ type: 'text' as const, text: t }], isError: true });

async function handleTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'wechat_login': {
      const r = await svcFetch('/login', 'POST');
      if (r.already) return text(`WeChat is already logged in as: ${r.username}`);
      if (r.error) return err(`Login failed: ${r.error}`);
      return text(`Please scan the QR code to login:\n${r.viewUrl}\n\nAfter scanning, call wechat_status to confirm.`);
    }
    case 'wechat_status': {
      const r = await svcFetch('/status');
      if (r.loggedIn) return text(`WeChat online ✓ (${r.username}, ${r.chatCount} chats)`);
      return text(`WeChat offline. ${r.loginViewUrl ? 'QR code pending: ' + r.loginViewUrl : 'Call wechat_login to start.'}`);
    }
    case 'wechat_send': {
      const r = await svcFetch('/send', 'POST', { contact: args.contact, message: args.message });
      if (r.ok) return text(`Sent to ${args.contact}: "${args.message}"`);
      return err(r.error || 'Send failed');
    }
    case 'wechat_read': {
      const msgs = await svcFetch(`/messages/${encodeURIComponent(args.contact)}?count=${args.count || 10}`);
      if (!Array.isArray(msgs) || msgs.length === 0) return text('No messages found.');
      return text(msgs.join('\n'));
    }
    case 'wechat_contacts': {
      const contacts = await svcFetch('/contacts');
      if (!Array.isArray(contacts) || contacts.length === 0) return text('No recent chats.');
      return text(contacts.join('\n'));
    }
    case 'wechat_search': {
      // Search is same as contacts filtered - service doesn't have dedicated search yet
      // For now, use the contacts list
      const contacts = await svcFetch('/contacts');
      if (!Array.isArray(contacts)) return text('No results.');
      const filtered = contacts.filter((c: string) => c.toLowerCase().includes(args.query.toLowerCase()));
      return text(filtered.length > 0 ? filtered.join('\n') : `No contacts matching "${args.query}"`);
    }
    default:
      return err(`Unknown tool: ${name}`);
  }
}

// --- JSON-RPC stdio ---

function sendResponse(id: any, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: any, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handleRequest(req: any) {
  switch (req.method) {
    case 'initialize':
      sendResponse(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'wechat', version: '2.0.0' },
      });
      break;
    case 'notifications/initialized': break;
    case 'tools/list':
      sendResponse(req.id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const { name, arguments: args } = req.params;
      try {
        sendResponse(req.id, await handleTool(name, args || {}));
      } catch (e: any) {
        sendResponse(req.id, err(`Error: ${e.message}`));
      }
      break;
    }
    default:
      if (req.id) sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => { try { handleRequest(JSON.parse(line)); } catch {} });

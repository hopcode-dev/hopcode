#!/usr/bin/env npx tsx
/**
 * MCP Server for Browser Proxy.
 * Wraps the browser-proxy HTTP API (port 3004) as MCP tools for claude -p.
 * Communicates via stdio JSON-RPC 2.0.
 */

import * as readline from 'readline';

const BROWSER_PROXY_URL = 'http://127.0.0.1:3004';

// --- HTTP client for browser-proxy ---

async function proxyFetch(path: string, method = 'GET', body?: any): Promise<any> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const resp = await fetch(`${BROWSER_PROXY_URL}${path}`, opts);
  if (resp.headers.get('content-type')?.includes('image/')) {
    const buf = Buffer.from(await resp.arrayBuffer());
    return { _binary: true, data: buf.toString('base64'), mimeType: 'image/jpeg' };
  }
  return resp.json();
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'browser_open',
    description: 'Open a URL in a remote browser. Returns a token (for subsequent calls) and a viewUrl (for the user to see/interact with the browser). Use desktop=true for sites that require desktop UA (e.g. WeChat Web, admin panels).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to open' },
        desktop: { type: 'boolean', description: 'Use desktop viewport & UA (default: false = mobile iPhone)' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_screenshot',
    description: 'Take a screenshot of the current browser page. Returns a JPEG image that you can see and analyze.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token from browser_open' },
      },
      required: ['token'],
    },
  },
  {
    name: 'browser_click',
    description: 'Click at coordinates (x, y) on the page. Take a screenshot first to identify the correct coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
      },
      required: ['token', 'x', 'y'],
    },
  },
  {
    name: 'browser_type',
    description: 'Type text into the currently focused input field. Click the field first to focus it.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['token', 'text'],
    },
  },
  {
    name: 'browser_key',
    description: 'Press a keyboard key (Enter, Tab, Backspace, Escape, ArrowDown, etc.)',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
        key: { type: 'string', description: 'Key name (e.g. Enter, Tab, Backspace)' },
      },
      required: ['token', 'key'],
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page. Positive deltaY scrolls down, negative scrolls up.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
        deltaY: { type: 'number', description: 'Scroll amount (positive=down, negative=up). Typical: 500 for one screen.' },
      },
      required: ['token', 'deltaY'],
    },
  },
  {
    name: 'browser_navigate',
    description: 'Navigate to a new URL in the current session.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['token', 'url'],
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Execute JavaScript on the page and return the result. Useful for extracting text, filling forms, or interacting with complex UI components. The script must be an expression (not statements) — wrap in an IIFE if needed: (() => { ... })()',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
        script: { type: 'string', description: 'JavaScript expression to evaluate' },
      },
      required: ['token', 'script'],
    },
  },
  {
    name: 'browser_cookies',
    description: 'Export all cookies from the browser session. Useful after user logs in to capture auth tokens for API calls.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
      },
      required: ['token'],
    },
  },
  {
    name: 'browser_status',
    description: 'Get session status: current URL, page title, viewer count, expiry time.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
      },
      required: ['token'],
    },
  },
  {
    name: 'browser_close',
    description: 'Close a browser session and free resources.',
    inputSchema: {
      type: 'object',
      properties: {
        token: { type: 'string', description: 'Session token' },
      },
      required: ['token'],
    },
  },
  {
    name: 'browser_list',
    description: 'List all active browser sessions.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

// --- Tool handlers ---

async function handleTool(name: string, args: any): Promise<any> {
  switch (name) {
    case 'browser_open': {
      const result = await proxyFetch('/sessions', 'POST', { url: args.url, desktop: args.desktop || false });
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      return { content: [{ type: 'text', text: `Browser opened.\nToken: ${result.token}\nView URL: ${result.viewUrl}\nExpires in: ${result.expiresIn}s\n\nShare the View URL with the user if they need to interact (e.g. login, captcha).` }] };
    }

    case 'browser_screenshot': {
      const result = await proxyFetch(`/sessions/${args.token}/screenshot`);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      if (result._binary) {
        return { content: [{ type: 'image', data: result.data, mimeType: result.mimeType }] };
      }
      return { content: [{ type: 'text', text: 'Unexpected response' }], isError: true };
    }

    case 'browser_click': {
      // Send via WebSocket-like HTTP — use evaluate to trigger click
      const result = await proxyFetch(`/sessions/${args.token}/status`);
      if (result.error) return { content: [{ type: 'text', text: `Error: ${result.error}` }], isError: true };
      // Use a quick WS connection to send click
      await sendWsAction(args.token, { type: 'click', x: args.x, y: args.y });
      return { content: [{ type: 'text', text: `Clicked at (${args.x}, ${args.y})` }] };
    }

    case 'browser_type': {
      await sendWsAction(args.token, { type: 'evaluate', script: `(() => { const ed = document.activeElement; if (ed) { ed.focus(); } return 'focused'; })()` });
      await sleep(200);
      for (const ch of args.text) {
        await sendWsAction(args.token, { type: 'type', text: ch });
        await sleep(50);
      }
      return { content: [{ type: 'text', text: `Typed: "${args.text}"` }] };
    }

    case 'browser_key': {
      await sendWsAction(args.token, { type: 'key', key: args.key });
      return { content: [{ type: 'text', text: `Pressed: ${args.key}` }] };
    }

    case 'browser_scroll': {
      await sendWsAction(args.token, { type: 'scroll', x: 200, y: 400, deltaY: args.deltaY });
      return { content: [{ type: 'text', text: `Scrolled by ${args.deltaY}px` }] };
    }

    case 'browser_navigate': {
      await sendWsAction(args.token, { type: 'navigate', url: args.url });
      await sleep(2000);
      const status = await proxyFetch(`/sessions/${args.token}/status`);
      return { content: [{ type: 'text', text: `Navigated to: ${status.url}\nTitle: ${status.title}` }] };
    }

    case 'browser_evaluate': {
      const result = await evalOnPage(args.token, args.script);
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }] };
    }

    case 'browser_cookies': {
      const cookies = await proxyFetch(`/sessions/${args.token}/cookies`);
      if (cookies.error) return { content: [{ type: 'text', text: `Error: ${cookies.error}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(cookies, null, 2) }] };
    }

    case 'browser_status': {
      const status = await proxyFetch(`/sessions/${args.token}/status`);
      if (status.error) return { content: [{ type: 'text', text: `Error: ${status.error}` }], isError: true };
      return { content: [{ type: 'text', text: JSON.stringify(status, null, 2) }] };
    }

    case 'browser_close': {
      const result = await proxyFetch(`/sessions/${args.token}/close`, 'POST');
      return { content: [{ type: 'text', text: result.ok ? 'Session closed.' : `Error: ${result.error}` }] };
    }

    case 'browser_list': {
      const sessions = await proxyFetch('/sessions');
      if (!Array.isArray(sessions) || sessions.length === 0) {
        return { content: [{ type: 'text', text: 'No active browser sessions.' }] };
      }
      const lines = sessions.map((s: any) => `- ${s.token.slice(0, 8)}... | ${s.url} | viewers: ${s.viewers}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
}

// --- WebSocket helpers ---

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function sendWsAction(token: string, action: any): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3004/ws/${token}`);
    ws.onopen = () => {
      ws.send(JSON.stringify(action));
      setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 300);
    };
    ws.onerror = () => { reject(new Error('WS connection failed')); };
    setTimeout(() => { try { ws.close(); } catch {} resolve(); }, 3000);
  });
}

function evalOnPage(token: string, script: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:3004/ws/${token}`);
    let resolved = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'evaluate', script }));
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'eval_result' && !resolved) {
          resolved = true;
          try { ws.close(); } catch {}
          resolve(msg.error || msg.result);
        }
      } catch {}
    };
    setTimeout(() => { if (!resolved) { resolved = true; try { ws.close(); } catch {} resolve('Timeout'); } }, 10000);
  });
}

// --- JSON-RPC stdio transport ---

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
        serverInfo: { name: 'browser-proxy', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      // No response needed for notifications
      break;

    case 'tools/list':
      sendResponse(req.id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const { name, arguments: args } = req.params;
      try {
        const result = await handleTool(name, args || {});
        sendResponse(req.id, result);
      } catch (e: any) {
        sendResponse(req.id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        });
      }
      break;
    }

    default:
      if (req.id) {
        sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

// --- Main ---

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  try {
    const req = JSON.parse(line);
    handleRequest(req);
  } catch {
    // Ignore malformed input
  }
});

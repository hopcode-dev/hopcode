#!/usr/bin/env npx tsx
/**
 * Playwright MCP Server for XiaoMa debugging and verification.
 *
 * Design goals:
 * - Browser reuse: keep one page open across tool calls
 * - XiaoMa perspective: verify code works, find bugs
 * - Minimal 7 tools: navigate, click, fill, extract_text, screenshot, console_logs, network_errors
 *
 * Protocol: stdio JSON-RPC 2.0 (MCP 2024-11-05)
 */

import { chromium, type Browser, type Page, type ConsoleMessage, type Request } from 'playwright';
import * as readline from 'readline';

// --- Browser state (singleton, reused across calls) ---

let browser: Browser | null = null;
let page: Page | null = null;
let consoleBuffer: ConsoleMessage[] = [];
let networkErrors: string[] = [];

// --- Lifecycle: lazy browser start ---

async function ensureBrowser(): Promise<{ browser: Browser; page: Page }> {
  if (!browser || !page) {
    browser = await chromium.launch({
      headless: true,
      executablePath: '/opt/puppeteer-cache/chrome/linux-146.0.7680.31/chrome-linux64/chrome',
    });
    page = await browser.newPage();
    // Capture console logs
    consoleBuffer = [];
    networkErrors = [];
    page.on('console', (msg: ConsoleMessage) => {
      consoleBuffer.push(msg);
    });
    page.on('requestfailed', (req: Request) => {
      const failure = req.failure();
      if (failure?.errorText) {
        networkErrors.push(`${req.method()} ${req.url()} — ${failure.errorText}`);
      }
    });
  }
  return { browser, page };
}

async function closeBrowser(): Promise<void> {
  if (page) { await page.close(); page = null; }
  if (browser) { await browser.close(); browser = null; }
  consoleBuffer = [];
  networkErrors = [];
}

// --- Tool definitions ---

const TOOLS = [
  {
    name: 'playwright_navigate',
    description: 'Navigate to a URL. Starts a headless browser if not already started.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The URL to navigate to' },
      },
      required: ['url'],
    },
  },
  {
    name: 'playwright_click',
    description: 'Click an element by selector. Fails if element not found. Use extract_text first to verify the element exists.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, id (#id), aria-label [aria-label="x"], or text: "button text"' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'playwright_fill',
    description: 'Fill an input field by selector, then press Tab to leave the field.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or #id of the input field' },
        value: { type: 'string', description: 'Text to fill into the field' },
      },
      required: ['selector', 'value'],
    },
  },
  {
    name: 'playwright_extract_text',
    description: 'Extract text content from an element by selector. Returns all matching elements if multiple found.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector, id, aria-label, or text:' },
      },
      required: ['selector'],
    },
  },
  {
    name: 'playwright_screenshot',
    description: 'Take a screenshot of the current page. Returns an image for analysis.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Optional name for the screenshot (used in logs only)' },
      },
    },
  },
  {
    name: 'playwright_console_logs',
    description: 'Get all console messages captured since last call. Returns and CLEARS the buffer. Use first to check for JS errors.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'playwright_network_errors',
    description: 'Get all network request failures captured since browser start. Use to find 404s, failed resources, CORS errors.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'playwright_close',
    description: 'Close the browser and free resources. Call this when done debugging.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'playwright_evaluate',
    description: 'Execute JavaScript code in the page context. Returns the result. Useful for debugging data loading issues.',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'JavaScript expression to evaluate (e.g. "document.title", "fetch(\'data.json\').then(r=>r.json())")' },
      },
      required: ['expression'],
    },
  },
];

// --- Tool handlers ---

async function handleTool(name: string, args: any): Promise<any> {
  try {
    switch (name) {
      case 'playwright_navigate': {
        const { browser: b, page: p } = await ensureBrowser();
        const resp = await p.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
        const title = await p.title();
        const status = resp?.status() ?? 0;
        return {
          content: [{
            type: 'text',
            text: `Navigated to: ${args.url}\nStatus: ${status}\nTitle: ${title}\n\nTake a screenshot to see the page, or use extract_text to check specific elements.`,
          }],
        };
      }

      case 'playwright_click': {
        const { page: p } = await ensureBrowser();
        await p.click(args.selector, { timeout: 5000 });
        await p.waitForTimeout(500); // Let UI update
        return { content: [{ type: 'text', text: `Clicked: ${args.selector}` }] };
      }

      case 'playwright_fill': {
        const { page: p } = await ensureBrowser();
        await p.fill(args.selector, args.value, { timeout: 5000 });
        await p.keyboard.press('Tab'); // Leave field (triggers blur/validation)
        await p.waitForTimeout(300);
        return { content: [{ type: 'text', text: `Filled "${args.value}" into: ${args.selector}` }] };
      }

      case 'playwright_extract_text': {
        const { page: p } = await ensureBrowser();
        try {
          const text = await p.textContent(args.selector, { timeout: 5000 });
          return { content: [{ type: 'text', text: text ?? '' }] };
        } catch (e: any) {
          if (e.message?.includes('strict mode violation') || e.message?.includes('No elements found')) {
            return {
              content: [{ type: 'text', text: `No elements found for: ${args.selector}` }],
              isError: true,
            };
          }
          return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
        }
      }

      case 'playwright_screenshot': {
        const { page: p } = await ensureBrowser();
        const buffer = await p.screenshot({ type: 'jpeg', quality: 80 });
        const base64 = buffer.toString('base64');
        return {
          content: [{
            type: 'image',
            data: base64,
            mimeType: 'image/jpeg',
          }],
        };
      }

      case 'playwright_console_logs': {
        // Splice out and return all captured logs, then clear
        const logs = consoleBuffer.splice(0);
        if (logs.length === 0) {
          return { content: [{ type: 'text', text: '(no console messages)' }] };
        }
        const lines = logs.map(l => {
          const icon = l.type() === 'error' ? '❌' : l.type() === 'warn' ? '⚠️' : '  ';
          return `${icon} [${l.type()}] ${l.text()}`;
        });
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      case 'playwright_network_errors': {
        const errors = networkErrors.splice(0);
        if (errors.length === 0) {
          return { content: [{ type: 'text', text: '(no network errors)' }] };
        }
        return { content: [{ type: 'text', text: errors.join('\n') }] };
      }

      case 'playwright_close': {
        await closeBrowser();
        return { content: [{ type: 'text', text: 'Browser closed.' }] };
      }

      case 'playwright_evaluate': {
        const { page: p } = await ensureBrowser();
        const result = await p.evaluate(args.expression as string);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (e: any) {
    // Clean up on error
    if (name === 'playwright_navigate' || name === 'playwright_close') {
      // Don't close browser on navigate error — user might want to retry
    }
    // Provide more context for common errors
    let msg = e.message || String(e);
    if (msg.includes('Executable not found') || msg.includes('no chrome')) {
      msg = `Chrome not found at ${chromium.executablePath() || '/opt/puppeteer-cache/chrome/...'}. Try: npx playwright install chromium`;
    } else if (msg.includes('connect') && msg.includes('1150')) {
      msg = `Chrome failed to start. Check if Chrome is installed at the configured path.`;
    }
    return {
      content: [{ type: 'text', text: `Error: ${msg}` }],
      isError: true,
    };
  }
}

// --- JSON-RPC stdio transport ---

function sendResponse(id: any, result: any) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function sendError(id: any, code: number, message: string) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function handleRequest(req: any): void {
  switch (req.method) {
    case 'initialize':
      sendResponse(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'playwright', version: '1.0.0' },
      });
      break;

    case 'notifications/initialized':
      break;

    case 'tools/list':
      sendResponse(req.id, { tools: TOOLS });
      break;

    case 'tools/call': {
      const { name, arguments: args } = req.params;
      pendingCalls++;
      handleTool(name, args || {}).then(result => {
        pendingCalls--;
        sendResponse(req.id, result);
      }).catch((e: any) => {
        pendingCalls--;
        sendResponse(req.id, {
          content: [{ type: 'text', text: `Error: ${e.message}` }],
          isError: true,
        });
      });
      break;
    }

    default:
      if (req.id) sendError(req.id, -32601, `Method not found: ${req.method}`);
  }
}

// --- Main ---

let pendingCalls = 0;

// Read stdin line by line (handles both TTY and pipe mode)
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let lines = stdinBuffer.split('\n');
  stdinBuffer = lines.pop() || ''; // Keep incomplete line in buffer
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line);
      handleRequest(req);
    } catch {
      // Ignore malformed input
    }
  }
});

process.stdin.on('end', async () => {
  // Flush any remaining buffer
  if (stdinBuffer.trim()) {
    try {
      const req = JSON.parse(stdinBuffer);
      handleRequest(req);
    } catch {}
  }
  // Wait for any in-flight tool calls to finish before exiting
  while (pendingCalls > 0) {
    await new Promise(r => setTimeout(r, 100));
  }
  await closeBrowser();
  process.exit(0);
});

// Handle SIGTERM
process.on('SIGTERM', async () => {
  while (pendingCalls > 0) {
    await new Promise(r => setTimeout(r, 100));
  }
  await closeBrowser();
  process.exit(0);
});

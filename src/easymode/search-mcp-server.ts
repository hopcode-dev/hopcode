#!/usr/bin/env npx tsx
/**
 * Search MCP Server using SearXNG + Browser Proxy
 * Tools: web_search, news_search, browser_search
 */

import * as readline from 'readline';

const SEARXNG_URL = process.env.SEARXNG_URL || 'http://localhost:8888';

interface SearchResult {
  url: string;
  title: string;
  content: string;
  engine: string;
}

async function searxng(query: string, engines: string, numResults: number): Promise<string> {
  const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json&engines=${encodeURIComponent(engines)}&limit=${numResults}`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return '';

    const data = await resp.json() as { results?: SearchResult[] };
    const results = data.results || [];

    if (results.length === 0) return '';

    const lines: string[] = [`Search results for "${query}" (${results.length} found):\n`];
    for (const r of results.slice(0, numResults)) {
      lines.push(`## ${r.title || 'No title'}`);
      if (r.url) lines.push(`URL: ${r.url}`);
      if (r.content) lines.push(`Summary: ${r.content.slice(0, 200)}...`);
      lines.push('');
    }
    return lines.join('\n');
  } catch {
    return '';
  }
}

async function webSearchWithFallback(query: string, engines: string, numResults: number): Promise<string> {
  const result = await searxng(query, engines, numResults);
  if (result) return result;
  // SearXNG returned nothing — fall back to browser
  return browserSearch(query, numResults);
}

const WEB_ENGINES = 'brave,duckduckgo,sogou wechat';
const NEWS_ENGINES = 'bing news,brave.news,reuters';
const BROWSER_PROXY_URL = process.env.BROWSER_PROXY_URL || 'http://127.0.0.1:3004';

async function browserSearch(query: string, numResults: number): Promise<string> {
  try {
    const resp = await fetch(`${BROWSER_PROXY_URL}/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, n: numResults }),
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) return `Browser search failed: HTTP ${resp.status}`;
    const data = await resp.json() as { results?: { title: string; url: string; snippet: string }[]; error?: string };
    if (data.error) return `Browser search error: ${data.error}`;
    const results = data.results || [];
    if (results.length === 0) return `No results found for "${query}"`;
    const lines: string[] = [`Search results for "${query}" (${results.length} found):\n`];
    for (const r of results) {
      lines.push(`## ${r.title}`);
      if (r.url) lines.push(`URL: ${r.url}`);
      if (r.snippet) lines.push(`Summary: ${r.snippet}`);
      lines.push('');
    }
    return lines.join('\n');
  } catch (e: any) {
    return `Browser search error: ${e.message}`;
  }
}

const TOOLS = [
  {
    name: 'web_search',
    description: 'Search the web for general information, documentation, how-to guides, facts, WeChat public articles (公众号). Uses Brave + DuckDuckGo + Sogou WeChat. Do NOT use for breaking news or current events — use news_search instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        num_results: { type: 'number', description: 'Number of results to return (default: 10, max: 20)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'news_search',
    description: 'Search for latest news and current events. Uses Bing News + Brave News + Reuters. Use this for: breaking news, today\'s headlines, recent events, "最新新闻", "今日头条", "刚刚发生", stock/market news.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The news search query' },
        num_results: { type: 'number', description: 'Number of results to return (default: 10, max: 20)', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'browser_search',
    description: 'Search the web using a real browser (Bing). Use this when web_search returns poor results, for Chinese-language queries, or when fresh/reliable results are needed. Slower than web_search but bypasses anti-bot measures automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query' },
        num_results: { type: 'number', description: 'Number of results to return (default: 10, max: 20)', default: 10 },
      },
      required: ['query'],
    },
  },
];

function sendResponse(id: any, result: any) {
  console.log(JSON.stringify({ jsonrpc: '2.0', id, result }));
}

function sendNotification(method: string, params: any) {
  console.log(JSON.stringify({ jsonrpc: '2.0', method, params }));
}

function sendError(id: any, code: number, message: string) {
  console.log(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }));
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;

  try {
    const req = JSON.parse(line);

    if (req.method === 'initialize') {
      sendResponse(req.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'search', version: '1.0.0' },
      });
      sendNotification('notifications/initialized', {});
      return;
    }

    if (req.method === 'tools/list') {
      sendResponse(req.id, { tools: TOOLS });
      return;
    }

    if (req.method === 'tools/call') {
      const { name, arguments: args } = req.params;
      const query = args?.query || '';
      const numResults = Math.min(args?.num_results || 10, 20);

      if (name === 'web_search') {
        webSearchWithFallback(query, WEB_ENGINES, numResults).then((result) => {
          sendResponse(req.id, { content: [{ type: 'text', text: result }] });
        }).catch((e: Error) => sendError(req.id, -32603, e.message));
        return;
      }

      if (name === 'news_search') {
        webSearchWithFallback(query, NEWS_ENGINES, numResults).then((result) => {
          sendResponse(req.id, { content: [{ type: 'text', text: result }] });
        }).catch((e: Error) => sendError(req.id, -32603, e.message));
        return;
      }

      if (name === 'browser_search') {
        browserSearch(query, numResults).then((result) => {
          sendResponse(req.id, { content: [{ type: 'text', text: result }] });
        }).catch((e: Error) => sendError(req.id, -32603, e.message));
        return;
      }

      sendError(req.id, -32601, `Unknown tool: ${name}`);
      return;
    }

    // notifications/initialized or other methods - just ack
    if (req.id !== undefined) {
      sendResponse(req.id, null);
    }
  } catch (e: any) {
    sendError(null, -32700, `Parse error: ${e.message}`);
  }
});

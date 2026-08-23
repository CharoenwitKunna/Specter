#!/usr/bin/env node
// bridge.js — MCP server + HTTP bridge for Specter (hardened)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _port = parseInt(process.env.ATTK_PORT || '8765', 10);
if (!Number.isFinite(_port) || _port < 1024 || _port > 65535) {
  console.error(`[Specter] Invalid ATTK_PORT=${process.env.ATTK_PORT}, using 8765`);
  _port = 8765;
}
const PORT = _port;
const POLL_TIMEOUT = 25000;
const ENQUEUE_TIMEOUT = POLL_TIMEOUT + 10000;
const MAX_BODY = 1_000_000;
const VERSION = '1.2.0';
const startedAt = Date.now();

// --- auth token (optional but recommended) ---
const TOKEN_PATH = path.join(__dirname, '.specter-token');
let SPECTER_TOKEN = null;
try {
  if (fs.existsSync(TOKEN_PATH)) {
    SPECTER_TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } else {
    SPECTER_TOKEN = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_PATH, SPECTER_TOKEN, { mode: 0o600 });
    console.error(`[Specter] Generated token at ${TOKEN_PATH} — set header X-Specter-Token to use HTTP API`);
  }
} catch (e) {
  console.error('[Specter] token setup:', e.message);
}

function isValidToken(req) {
  if (!SPECTER_TOKEN) return true;
  const hdr = req.headers['x-specter-token'] || req.headers['x-attk-token'];
  // Allow extension poll without token (extension can't easily read token file); require token for /tool
  return true;
}

function requireTokenForTool(req, res) {
  if (!SPECTER_TOKEN) return true;
  const hdr = (req.headers['x-specter-token'] || req.headers['x-attk-token'] || '').trim();
  // If token exists, require it for /tool — but allow missing for backwards compat with warning
  if (!hdr) {
    console.error('[Specter] Warning: /tool without X-Specter-Token (set it for auth)');
    return true;
  }
  if (hdr !== SPECTER_TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Invalid X-Specter-Token' }));
    return false;
  }
  return true;
}

// --- tool definitions ---
const TOOLS = [
  { name: 'tab_navigate', description: 'Navigate the active/target tab to a new URL', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] } },
  { name: 'tab_eval', description: 'Evaluate arbitrary JavaScript expression in the active tab context and return value', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript expression' } }, required: ['code'] } },
  { name: 'tab_list', description: 'List all open tabs in current window with IDs, titles, URLs, and active states', inputSchema: { type: 'object', properties: {} } },
  { name: 'tab_switch', description: 'Switch agent target tab by tab ID (marks it with a purple [🤖 AI Worker] tab group so you know what it is working on)', inputSchema: { type: 'object', properties: { tabId: { type: 'number', description: 'ID of the tab to target' }, focusWindow: { type: 'boolean', description: 'Bring to foreground (default true, set false for silent background work)' } }, required: ['tabId'] } },
  { name: 'tab_new', description: 'Open a new tab with an optional URL (automatically joins the AI Worker group)', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Optional initial URL' }, active: { type: 'boolean', description: 'Focus the tab immediately (default true)' } } } },
  { name: 'tab_close', description: 'Close a tab by ID (or target tab if omitted)', inputSchema: { type: 'object', properties: { tabId: { type: 'number', description: 'Optional tab ID to close' } } } },
  { name: 'tab_snapshot', description: 'Snapshot of interactive elements on the active tab (like computer_use SOM) — ids, tags, text, selectors, rects, viewport, and in_viewport status. Includes elements below the fold and inside Shadow DOM.', inputSchema: { type: 'object', properties: { max: { type: 'number', description: 'max elements (default 80)' }, inViewportOnly: { type: 'boolean', description: 'Only return elements currently visible in viewport' } } } },
  { name: 'tab_scroll_into_view', description: 'Scroll an element into view by selector or snapshot ID', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, element: { type: 'number' } } } },
  { name: 'tab_query', description: 'Query elements by CSS selector on the active tab', inputSchema: { type: 'object', properties: { selector: { type: 'string' } }, required: ['selector'] } },
  { name: 'tab_get_text', description: 'Get visible text of the active tab', inputSchema: { type: 'object', properties: {} } },
  { name: 'tab_get_html', description: 'Get HTML of the active tab (truncated)', inputSchema: { type: 'object', properties: {} } },
  { name: 'tab_stats', description: 'Get page stats (links/images/headings/word count)', inputSchema: { type: 'object', properties: {} } },
  { name: 'tab_screenshot', description: 'Capture visible tab as an image for visual inspection', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'jpeg'] } } } },
  { name: 'click', description: 'Click an element by selector, coordinates (x,y), or snapshot/DOM ID', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, element: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, kind: { type: 'string', enum: ['click','right','double'] } } } },
  { name: 'type', description: 'Type text into an input or selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector','text'] } },
  { name: 'key', description: 'Send a keyboard key (Enter, Escape, Tab, ArrowDown, etc)', inputSchema: { type: 'object', properties: { key: { type: 'string' }, selector: { type: 'string' } }, required: ['key'] } },
  { name: 'scroll', description: 'Scroll page (direction: up/down/left/right, or into view of selector/element)', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up','down','left','right'] }, amount: { type: 'number' }, selector: { type: 'string' }, element: { type: 'number' } } } },
  { name: 'drag', description: 'Drag from source to target (selector or x,y)', inputSchema: { type: 'object', properties: { from_selector: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_selector: { type: 'string' }, to_x: { type: 'number' }, to_y: { type: 'number' } } } },
  { name: 'wait', description: 'Pause / sleep for a duration in milliseconds', inputSchema: { type: 'object', properties: { ms: { type: 'number', description: 'Milliseconds to wait' } }, required: ['ms'] } },
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));

function isAllowedHttpUrl(url) {
  if (!url) return false;
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; }
}

function toolToAction(name, args) {
  if (!TOOL_NAMES.has(name)) throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
  switch (name) {
    case 'tab_navigate': {
      if (!isAllowedHttpUrl(args.url)) throw Object.assign(new Error('tab_navigate only allows http/https URLs'), { status: 400 });
      return { action: 'navigate', url: args.url };
    }
    case 'tab_eval': return { action: 'tab_eval', code: args.code };
    case 'tab_list': return { action: 'list_tabs' };
    case 'tab_switch': return { action: 'switch_tab', tabId: args.tabId, focusWindow: args.focusWindow };
    case 'tab_new': {
      if (args.url && !isAllowedHttpUrl(args.url)) throw Object.assign(new Error('tab_new only allows http/https URLs'), { status: 400 });
      return { action: 'new_tab', url: args.url, active: args.active };
    }
    case 'tab_close': return { action: 'close_tab', tabId: args.tabId };
    case 'tab_snapshot': return { action: 'snapshot', max: args.max ?? 80, inViewportOnly: args.inViewportOnly };
    case 'tab_scroll_into_view': return { action: 'scroll_into_view', selector: args.selector, element: args.element };
    case 'tab_query': return { action: 'query', selector: args.selector };
    case 'tab_get_text': return { action: 'get_text' };
    case 'tab_get_html': return { action: 'get_html' };
    case 'tab_stats': return { action: 'get_stats' };
    case 'tab_screenshot': return { action: 'screenshot', format: args.format || 'png' };
    case 'click': {
      if (typeof args.element === 'number') return { action: 'click_id', element: args.element, kind: args.kind };
      if (typeof args.x === 'number' && typeof args.y === 'number') return { action: 'click_xy', x: args.x, y: args.y };
      return { action: 'click', selector: args.selector, kind: args.kind };
    }
    case 'type': return { action: 'type', selector: args.selector, text: args.text };
    case 'key': return { action: 'key', key: args.key, selector: args.selector };
    case 'scroll': {
      if (args.selector || typeof args.element === 'number') return { action: 'scroll_into_view', selector: args.selector, element: args.element };
      return { action: 'scroll', direction: args.direction || 'down', amount: args.amount ?? 400 };
    }
    case 'drag': return { action: 'drag', from_selector: args.from_selector, from_x: args.from_x, from_y: args.from_y, to_selector: args.to_selector, to_x: args.to_x, to_y: args.to_y };
    case 'wait': {
      const ms = args.ms;
      if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw Object.assign(new Error('wait ms must be 0-30000'), { status: 400 });
      return { action: 'wait', ms };
    }
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
  }
}

// --- polling queue ---
let nextId = 1;
const jobs = [];
const waiters = [];
const waitingCalls = new Map();

function enqueue(action) {
  if (jobs.length > 100) throw Object.assign(new Error('Queue full (100)'), { status: 429 });
  if (waitingCalls.size > 200) throw Object.assign(new Error('Too many pending calls (200)'), { status: 503 });
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      waitingCalls.delete(id);
      const i = jobs.findIndex(j => j.id === id);
      if (i !== -1) jobs.splice(i, 1);
      reject(Object.assign(new Error('Extension did not poll — is Specter loaded? (poll timeout)'), { status: 504 }));
    }, ENQUEUE_TIMEOUT);
    waitingCalls.set(id, { resolve: v => { clearTimeout(timer); waitingCalls.delete(id); resolve(v); }, reject: e => { clearTimeout(timer); waitingCalls.delete(id); reject(e); } });
    const job = { id, ...action };
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      if (!waiter.res.writableEnded) {
        waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
        waiter.res.end(JSON.stringify(job));
      }
    } else {
      jobs.push(job);
    }
  });
}

function takeJob() { return jobs.shift() || null; }
function completeJob(id, result) {
  if (typeof id !== 'number' || !Number.isFinite(id)) return false;
  const call = waitingCalls.get(id);
  if (call) { waitingCalls.delete(id); call.resolve(result); return true; }
  return false;
}

function handleCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin) {
    if (origin.startsWith('chrome-extension://')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Specter-Token, X-ATTK-Token');
      return true;
    } else {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'CORS: origin not allowed' }));
      return false;
    }
  }
  return true;
}

async function readBody(req, res, limit = MAX_BODY) {
  const cl = parseInt(req.headers['content-length'] || '0', 10);
  if (cl > limit) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: `Body too large (max ${limit})` }));
    return null;
  }
  let body = '';
  let size = 0;
  for await (const c of req) {
    body += c;
    size += Buffer.byteLength(c);
    if (size > limit) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: `Body too large (max ${limit})` }));
      return null;
    }
  }
  return body;
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  if (!handleCors(req, res)) return;
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/poll' && req.method === 'GET') {
    const job = takeJob();
    if (job) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(job));
    }
    const waiter = { res, timer: setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      try { if (!res.writableEnded) { res.writeHead(204); res.end(); } } catch {}
    }, POLL_TIMEOUT) };
    waiters.push(waiter);
    req.on('close', () => {
      clearTimeout(waiter.timer);
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
    });
    return;
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return;
    try {
      const data = JSON.parse(body);
      if (typeof data.id !== 'number') throw new Error('Missing numeric id');
      const delivered = completeJob(data.id, data.result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered }));
    } catch (e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (url.pathname === '/tool' && req.method === 'POST') {
    const body = await readBody(req, res);
    if (body === null) return;
    if (!requireTokenForTool(req, res)) return;
    try {
      const { tool, args } = JSON.parse(body || '{}');
      if (!tool) throw Object.assign(new Error('Missing "tool"'), { status: 400 });
      if (!TOOL_NAMES.has(tool)) throw Object.assign(new Error(`Unknown tool: ${tool}`), { status: 404 });
      const action = toolToAction(tool, args || {});
      if (action.action === 'wait') { await new Promise(r => setTimeout(r, action.ms)); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
      const result = await enqueue(action);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      const status = e.status || 500;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
    }
    return;
  }

  if (url.pathname === '/tools' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(TOOLS));
  }
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, version: VERSION, port: PORT, uptime: Math.round((Date.now() - startedAt)/1000), queued: jobs.length, pending: waitingCalls.size, waiters: waiters.length, polling: waiters.length > 0 }));
  }

  res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'Not found. GET /health  GET /poll  POST /result  POST /tool  GET /tools' }));
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`[Specter] Port ${PORT} in use. Kill the other bridge or set ATTK_PORT=8766`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[Specter] HTTP bridge on http://127.0.0.1:${PORT}  (health: /health  poll: /poll  tool: /tool)`);
});

// --- MCP stdio server ---
const mcp = new Server({ name: 'specter', version: VERSION }, { capabilities: { tools: {} } });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (!TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    const action = toolToAction(name, args || {});
    if (action.action === 'wait') { await new Promise(r => setTimeout(r, action.ms)); return { content: [{ type: 'text', text: `waited ${action.ms}ms` }], isError: false }; }
    const result = await enqueue(action);
    if (name === 'tab_screenshot' && result?.dataUrl) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/.exec(result.dataUrl);
      if (m) {
        return { content: [{ type: 'image', data: m[2], mimeType: m[1] }, { type: 'text', text: `Screenshot captured (${Math.round(m[2].length * 3 / 4 / 1024)} KB ${m[1]})` }], isError: false };
      }
    }
    let text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (text.length > 40000) text = text.slice(0, 40000) + '\n…(truncated)';
    const isError = result && typeof result === 'object' && result.ok === false;
    return { content: [{ type: 'text', text }], isError: Boolean(isError) };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

const isMCP = !process.stdin.isTTY;
if (isMCP) {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error('[Specter] MCP stdio connected');
} else {
  console.error('[Specter] HTTP-only mode (run with stdio pipe to enable MCP)');
  if (process.argv.includes('--mcp')) {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error('[Specter] MCP stdio connected (--mcp)');
  }
}

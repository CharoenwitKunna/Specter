#!/usr/bin/env node
// bridge.js — MCP server + HTTP bridge for Active Tab Toolkit
// Two transports: (1) MCP stdio for Claude Desktop / Codex / any MCP client
//                 (2) HTTP JSON on :8765 for local scripts/curl/hermes
//
// The bridge does NOT talk to Chrome directly via nativeMessaging (which needs registry setup).
// Instead it exposes HTTP endpoints that the extension's background can poll, OR more simply:
// the HTTP server IS the control plane — agents call it, and it returns instructions that
// a tiny helper polls. But we also support direct extension connection via WebSocket if available.
//
// Simplest working model: HTTP server is authoritative. Extension polls GET /poll, agents POST /tool.
// Also works as pure MCP stdio: tool calls execute via HTTP loopback to the extension's polling loop.
//
// For zero-setup AI control without polling delay, also try to connect via chrome.debugger if needed.
// Default: polling — no extra permissions.

import http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema, ListResourcesRequestSchema, ListPromptsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = parseInt(process.env.ATTK_PORT || '8765', 10);

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

// Map MCP tool name -> bridge action for the extension poll loop
function toolToAction(name, args) {
  switch (name) {
    case 'tab_navigate': return { action: 'navigate', url: args.url };
    case 'tab_eval': return { action: 'tab_eval', code: args.code };
    case 'tab_list': return { action: 'list_tabs' };
    case 'tab_switch': return { action: 'switch_tab', tabId: args.tabId, focusWindow: args.focusWindow };
    case 'tab_new': return { action: 'new_tab', url: args.url, active: args.active };
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
    case 'wait': return { action: 'wait', ms: args.ms };
    default: return { action: name, ...args };
  }
}

// --- polling queue (extension polls, agents push) ---
let nextId = 1;
const jobs = [];                 // queued actions waiting for the extension
const waiters = [];              // pending long-poll responses
const waitingCalls = new Map();  // id -> resolve(result)

function enqueue(action) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => {
      const i = jobs.findIndex(j => j.id === id);
      if (i !== -1) jobs.splice(i, 1);
      reject(new Error('Extension did not poll — is Active Tab Toolkit loaded? (poll timeout 35s)'));
    }, 35000);
    waitingCalls.set(id, { resolve: v => { clearTimeout(timer); resolve(v); } });
    const job = { id, ...action };
    const waiter = waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
      waiter.res.end(JSON.stringify(job));
    } else {
      jobs.push(job);
    }
  });
}

function takeJob() {
  return jobs.shift() || null;
}

function completeJob(id, result) {
  const call = waitingCalls.get(id);
  if (call) { waitingCalls.delete(id); call.resolve(result); return true; }
  return false;
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Extension long-polls here
  if (url.pathname === '/poll' && req.method === 'GET') {
    const job = takeJob();
    if (job) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(job));
    }
    const waiter = { res, timer: setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
      try { res.writeHead(204); res.end(); } catch {}
    }, 25000) };
    waiters.push(waiter);
    req.on('close', () => {
      clearTimeout(waiter.timer);
      const i = waiters.indexOf(waiter);
      if (i !== -1) waiters.splice(i, 1);
    });
    return;
  }

  if (url.pathname === '/result' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    try {
      const data = JSON.parse(body);
      const delivered = completeJob(data.id, data.result);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, delivered }));
    } catch (e) { res.writeHead(400); res.end(String(e.message)); }
    return;
  }

  // Agents POST tool calls here (alternative to MCP)
  if (url.pathname === '/tool' && req.method === 'POST') {
    let body = ''; for await (const c of req) body += c;
    try {
      const { tool, args } = JSON.parse(body || '{}');
      if (!tool) throw new Error('Missing "tool"');
      const action = toolToAction(tool, args || {});
      if (action.action === 'wait') { await new Promise(r => setTimeout(r, action.ms)); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
      const result = await enqueue(action);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
    return;
  }

  if (url.pathname === '/tools' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(TOOLS));
  }
  if (url.pathname === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, port: PORT, queued: jobs.length, polling: waiters.length > 0 }));
  }

  res.writeHead(404); res.end('Not found. GET /health  GET /poll  POST /result  POST /tool  GET /tools');
});

server.listen(PORT, '127.0.0.1', () => {
  console.error(`[active-tab-mcp] HTTP bridge on http://127.0.0.1:${PORT}  (health: /health  poll: /poll  tool: /tool)`);
});

// --- MCP stdio server ---
const mcp = new Server({ name: 'active-tab-toolkit', version: '1.1.0' }, { capabilities: { tools: {}, resources: {}, prompts: {} } });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    const action = toolToAction(name, args || {});
    if (action.action === 'wait') { await new Promise(r => setTimeout(r, action.ms)); return { content: [{ type: 'text', text: `waited ${action.ms}ms` }], isError: false }; }
    const result = await enqueue(action);
    // screenshots become real image blocks so vision models can read them
    if (name === 'tab_screenshot' && result?.dataUrl) {
      const m = /^data:(image\/[a-z]+);base64,(.*)$/.exec(result.dataUrl);
      if (m) {
        return {
          content: [
            { type: 'image', data: m[2], mimeType: m[1] },
            { type: 'text', text: `Screenshot captured (${Math.round(m[2].length * 3 / 4 / 1024)} KB ${m[1]})` }
          ],
          isError: false,
        };
      }
    }
    // keep text payloads bounded for the model context
    let text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    if (text.length > 40000) text = text.slice(0, 40000) + '\n…(truncated)';
    const isError = result && typeof result === 'object' && result.ok === false;
    return { content: [{ type: 'text', text }], isError: Boolean(isError) };
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true };
  }
});

// Only start MCP stdio if this process is being used as MCP server (stdio is a pipe, not tty)
// If run directly for HTTP, also start MCP in background so both work.
const isMCP = !process.stdin.isTTY;
if (isMCP) {
  const transport = new StdioServerTransport();
  await mcp.connect(transport);
  console.error('[active-tab-mcp] MCP stdio connected');
} else {
  console.error('[active-tab-mcp] HTTP-only mode (run with stdio pipe to enable MCP)');
  // still allow MCP via explicit --mcp flag
  if (process.argv.includes('--mcp')) {
    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    console.error('[active-tab-mcp] MCP stdio connected (--mcp)');
  }
}

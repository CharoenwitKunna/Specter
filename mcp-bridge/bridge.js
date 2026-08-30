#!/usr/bin/env node
// bridge.js — MCP server + HTTP bridge for Specter (hardened)
import http from 'node:http';
import https from 'node:https';
import WebSocket, { WebSocketServer } from 'ws';
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
const DEFAULT_WS_PORT = PORT < 65535 ? PORT + 1 : 8766;
let _wsPort = parseInt(process.env.SPECTER_WSS_PORT || String(DEFAULT_WS_PORT), 10);
if (!Number.isFinite(_wsPort) || _wsPort < 1024 || _wsPort > 65535) {
  console.error(`[Specter] Invalid SPECTER_WSS_PORT=${process.env.SPECTER_WSS_PORT}, using ${DEFAULT_WS_PORT}`);
  _wsPort = DEFAULT_WS_PORT;
}
const WS_PORT = _wsPort;
const POLL_TIMEOUT = 25000;
const ENQUEUE_TIMEOUT = POLL_TIMEOUT + 10000;
const WSS_ACK_TIMEOUT = 5000;
const WSS_HEARTBEAT_MS = 15000;
const WSS_DEAD_AFTER_MS = WSS_HEARTBEAT_MS * 3;
const MAX_QUEUE_JOBS = 100;
const MAX_PENDING_CALLS = 200;
// Screenshots are base64-encoded; allow bounded 8 MiB result payloads.
const MAX_BODY = 8_000_000;
// Bound memory even when a client submits many large actions/results.
const MAX_QUEUE_BYTES = 16 * 1024 * 1024;
const VERSION = '1.3.0';
const startedAt = Date.now();

// --- optional token auth (mcp-bridge/.specter-token via X-Specter-Token) ---
const TOKEN_PATH = path.join(__dirname, '.specter-token');
let TOKEN = '';
try {
  if (fs.existsSync(TOKEN_PATH)) {
    TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim();
    if (!TOKEN) throw new Error('empty token file');
  } else {
    TOKEN = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_PATH, TOKEN + '\n', { mode: 0o600 });
    // ensure permissions even if file existed with different umask
    try { fs.chmodSync(TOKEN_PATH, 0o600); } catch {}
    console.error(`[Specter] Token file created at ${TOKEN_PATH} (mode 0600)`);
  }
} catch (e) {
  console.error(`[Specter] Token init failed: ${e.message}`);
  TOKEN = '';
}

// --- tool definitions ---
const TOOLS = [
  { name: 'tab_navigate', description: 'Navigate the active/target tab to a new URL', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'URL to navigate to' } }, required: ['url'] } },
  { name: 'tab_eval', description: 'Evaluate JavaScript in the active tab. Requires explicit allowEval:true because this executes with page privileges.', inputSchema: { type: 'object', properties: { code: { type: 'string', description: 'JavaScript expression' }, allowEval: { type: 'boolean', const: true, description: 'Explicit consent for unrestricted page eval' } }, required: ['code', 'allowEval'] } },
  { name: 'tab_list', description: 'List all open tabs in current window with IDs, titles, URLs, and active states', inputSchema: { type: 'object', properties: {} } },
  { name: 'tab_switch', description: 'Switch agent target tab by tab ID (marks it with a green [👻 Specter] tab group so you know what it is working on)', inputSchema: { type: 'object', properties: { tabId: { type: 'number', description: 'ID of the tab to target' }, focusWindow: { type: 'boolean', description: 'Bring to foreground (default true, set false for silent background work)' } }, required: ['tabId'] } },
  { name: 'tab_new', description: 'Open a new tab with an optional URL (automatically joins the Specter group)', inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'Optional initial URL' }, active: { type: 'boolean', description: 'Focus the tab immediately (default true)' } } } },
  { name: 'tab_close', description: 'Close a tab by ID (or target tab if omitted)', inputSchema: { type: 'object', properties: { tabId: { type: 'number', description: 'Optional tab ID to close' } } } },
  { name: 'tab_snapshot', description: 'Snapshot of interactive elements on the active tab (like computer_use SOM) — ids, tags, text, selectors, rects, viewport, and in_viewport status. Includes elements below the fold and inside Shadow DOM.', inputSchema: { type: 'object', properties: { max: { type: 'number', description: 'max elements (default 80)' }, inViewportOnly: { type: 'boolean', description: 'Only return elements currently visible in viewport' }, frameId: { type: 'number', description: 'Optional Chrome frame ID' } } } },
  { name: 'tab_find', description: 'Find visible elements by human text, ARIA label, placeholder, title, or role; use before clicking dynamic pages', inputSchema: { type: 'object', properties: { text: { type: 'string' }, label: { type: 'string' }, role: { type: 'string' }, max: { type: 'number' }, frameId: { type: 'number' } } } },
  { name: 'tab_visual_snapshot', description: 'Capture a screenshot together with the current semantic element snapshot for visual fallback', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number', description: 'JPEG quality 30-90 (default 60)' }, max: { type: 'number' }, frameId: { type: 'number', description: 'Optional Chrome frame ID for the semantic snapshot' } } } },
  { name: 'tab_scroll_into_view', description: 'Scroll an element into view by selector or snapshot ID', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, element: { type: 'number' }, frameId: { type: 'number' } } } },
  { name: 'tab_query', description: 'Query elements by CSS selector on the active tab', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, frameId: { type: 'number' } }, required: ['selector'] } },
  { name: 'tab_get_text', description: 'Get visible text of the active tab', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, frameId: { type: 'number' } } } },
  { name: 'tab_get_html', description: 'Get HTML of the active tab (truncated)', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, frameId: { type: 'number' } } } },
  { name: 'tab_stats', description: 'Get page stats (links/images/headings/word count)', inputSchema: { type: 'object', properties: { frameId: { type: 'number' } } } },
  { name: 'tab_screenshot', description: 'Capture visible tab as a compressed image for visual inspection', inputSchema: { type: 'object', properties: { format: { type: 'string', enum: ['png', 'jpeg'] }, quality: { type: 'number', description: 'JPEG quality 30-90 (default 60)' } } } },
  { name: 'click', description: 'Click an element by selector, coordinates (x,y), snapshot/DOM ID, or semantic text/label/role', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, element: { type: 'number' }, text: { type: 'string' }, label: { type: 'string' }, role: { type: 'string' }, frameId: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, kind: { type: 'string', enum: ['click','right','double'] } } } },
  { name: 'type', description: 'Type text into an input or selector', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, frameId: { type: 'number' }, clear: { type: 'boolean', description: 'Clear existing value first' }, perChar: { type: 'boolean', default: true, description: 'Type character-by-character with per-char events (default true; set false for bulk insertion)' } }, required: ['selector','text'] } },
  { name: 'key', description: 'Send a keyboard key (Enter, Escape, Tab, ArrowDown, etc)', inputSchema: { type: 'object', properties: { key: { type: 'string' }, selector: { type: 'string' }, frameId: { type: 'number' } }, required: ['key'] } },
  { name: 'scroll', description: 'Scroll page (direction: up/down/left/right, or into view of selector/element)', inputSchema: { type: 'object', properties: { direction: { type: 'string', enum: ['up','down','left','right'] }, amount: { type: 'number' }, selector: { type: 'string' }, element: { type: 'number' }, frameId: { type: 'number' } } } },
  { name: 'drag', description: 'Drag from source to target (selector or x,y)', inputSchema: { type: 'object', properties: { from_selector: { type: 'string' }, from_x: { type: 'number' }, from_y: { type: 'number' }, to_selector: { type: 'string' }, to_x: { type: 'number' }, to_y: { type: 'number' }, frameId: { type: 'number' } } } },
  { name: 'wait', description: 'Pause / sleep for a duration in milliseconds', inputSchema: { type: 'object', properties: { ms: { type: 'number', description: 'Milliseconds to wait' } }, required: ['ms'] } },
  { name: 'wait_for', description: 'Wait until an element matching the selector exists in the target tab (polls the DOM)', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, timeoutMs: { type: 'number', description: 'Max wait in ms (default 10000, max 30000)' }, frameId: { type: 'number' } }, required: ['selector'] } },
  { name: 'downloads', description: 'List recent browser downloads and their current states', inputSchema: { type: 'object', properties: { limit: { type: 'number' }, state: { type: 'string', enum: ['in_progress', 'complete', 'interrupted'] } } } },
  { name: 'batch_actions', description: 'Run up to 50 safe browser actions sequentially on the locked target tab. Actions use the same tool names and arguments as the individual tools. Results include one entry per action; by default execution stops after the first failed action (set stopOnError:false or continueOnError:true to continue). Target-changing tools and unrestricted eval are not allowed inside a batch.', inputSchema: { type: 'object', properties: { actions: { type: 'array', minItems: 1, maxItems: 50, description: 'Ordered actions, each {tool:string,args:object}', items: { type: 'object', properties: { tool: { type: 'string' }, action: { type: 'string' }, type: { type: 'string' }, args: { type: 'object' } }, oneOf: [{ required: ['tool'] }, { required: ['action'] }, { required: ['type'] }] } }, stopOnError: { type: 'boolean', default: true, description: 'Stop after the first action whose result has ok:false (default true)' }, continueOnError: { type: 'boolean', description: 'Alias for stopOnError:false' } }, required: ['actions'] } },
];

const TOOL_NAMES = new Set(TOOLS.map(t => t.name));
const MAX_BATCH_ACTIONS = 50;
// Batches intentionally contain only operations against the already locked
// target. Navigation, tab management, downloads, screenshots, and eval are
// kept as individual calls so a batch cannot silently change its target or
// exfiltrate more data than the caller requested.
const BATCH_TOOLS = new Set([
  'tab_snapshot', 'tab_find', 'tab_scroll_into_view', 'tab_query',
  'tab_get_text', 'tab_get_html', 'tab_stats', 'click', 'type', 'key',
  'scroll', 'drag', 'wait', 'wait_for'
]);

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
    case 'tab_eval': {
      if (args.allowEval !== true) throw Object.assign(new Error('tab_eval requires allowEval:true'), { status: 400 });
      return { action: 'tab_eval', code: args.code, allowEval: true };
    }
    case 'tab_list': return { action: 'list_tabs' };
    case 'tab_switch': return { action: 'switch_tab', tabId: args.tabId, focusWindow: args.focusWindow };
    case 'tab_new': {
      if (args.url && !isAllowedHttpUrl(args.url)) throw Object.assign(new Error('tab_new only allows http/https URLs'), { status: 400 });
      return { action: 'new_tab', url: args.url, active: args.active };
    }
    case 'tab_close': return { action: 'close_tab', tabId: args.tabId };
    case 'tab_snapshot': return { action: 'snapshot', max: args.max ?? 80, inViewportOnly: args.inViewportOnly, frameId: args.frameId };
    case 'tab_find': return { action: 'find', text: args.text, label: args.label, role: args.role, max: args.max ?? 20, frameId: args.frameId };
    case 'tab_visual_snapshot': {
      const quality = args.quality ?? 60;
      if (!Number.isFinite(quality) || quality < 30 || quality > 90) throw Object.assign(new Error('quality must be 30-90'), { status: 400 });
      return { action: 'visual_snapshot', format: args.format || 'jpeg', quality, max: args.max ?? 80, frameId: args.frameId };
    }
    case 'tab_scroll_into_view': return { action: 'scroll_into_view', selector: args.selector, element: args.element, frameId: args.frameId };
    case 'tab_query': return { action: 'query', selector: args.selector, frameId: args.frameId };
    case 'tab_get_text': return { action: 'get_text', selector: args.selector, frameId: args.frameId };
    case 'tab_get_html': return { action: 'get_html', selector: args.selector, frameId: args.frameId };
    case 'tab_stats': return { action: 'get_stats', frameId: args.frameId };
    case 'tab_screenshot': {
      const quality = args.quality ?? 60;
      if (!Number.isFinite(quality) || quality < 30 || quality > 90) throw Object.assign(new Error('quality must be 30-90'), { status: 400 });
      return { action: 'screenshot', format: args.format || 'jpeg', quality };
    }
    case 'click': {
      if (args.text || args.label || args.role) return { action: 'click_semantic', text: args.text, label: args.label, role: args.role, frameId: args.frameId, kind: args.kind };
      if (typeof args.element === 'number') return { action: 'click_id', element: args.element, frameId: args.frameId, kind: args.kind };
      if (typeof args.x === 'number' && typeof args.y === 'number') return { action: 'click_xy', x: args.x, y: args.y, frameId: args.frameId, kind: args.kind };
      return { action: 'click', selector: args.selector, frameId: args.frameId, kind: args.kind };
    }
    case 'type': return { action: 'type', selector: args.selector, text: args.text, frameId: args.frameId, clear: args.clear === true, perChar: args.perChar !== false };
    case 'key': return { action: 'key', key: args.key, selector: args.selector, frameId: args.frameId };
    case 'scroll': {
      if (args.selector || typeof args.element === 'number') return { action: 'scroll_into_view', selector: args.selector, element: args.element, frameId: args.frameId };
      return { action: 'scroll', direction: args.direction || 'down', amount: args.amount ?? 400, frameId: args.frameId };
    }
    case 'drag': return { action: 'drag', from_selector: args.from_selector, from_x: args.from_x, from_y: args.from_y, to_selector: args.to_selector, to_x: args.to_x, to_y: args.to_y, frameId: args.frameId };
    case 'wait': {
      const ms = args.ms;
      if (!Number.isFinite(ms) || ms < 0 || ms > 30000) throw Object.assign(new Error('wait ms must be 0-30000'), { status: 400 });
      return { action: 'wait', ms };
    }
    case 'wait_for': {
      const timeoutMs = args.timeoutMs ?? 10000;
      if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) throw Object.assign(new Error('wait_for timeoutMs must be 0-30000'), { status: 400 });
      if (!args.selector) throw Object.assign(new Error('wait_for requires selector'), { status: 400 });
      return { action: 'wait_for', selector: args.selector, timeoutMs, frameId: args.frameId };
    }
    case 'batch_actions': {
      if (!Array.isArray(args.actions) || args.actions.length < 1 || args.actions.length > MAX_BATCH_ACTIONS) {
        throw Object.assign(new Error(`batch_actions requires 1-${MAX_BATCH_ACTIONS} actions`), { status: 400 });
      }
      if (args.stopOnError !== undefined && typeof args.stopOnError !== 'boolean') {
        throw Object.assign(new Error('stopOnError must be a boolean'), { status: 400 });
      }
      if (args.continueOnError !== undefined && typeof args.continueOnError !== 'boolean') {
        throw Object.assign(new Error('continueOnError must be a boolean'), { status: 400 });
      }
      if (args.stopOnError !== undefined && args.continueOnError !== undefined && args.stopOnError === args.continueOnError) {
        throw Object.assign(new Error('stopOnError and continueOnError disagree'), { status: 400 });
      }
      const stopOnError = args.stopOnError ?? (args.continueOnError === true ? false : true);
      const actions = args.actions.map((entry, index) => {
        if (!entry || typeof entry !== 'object') {
          throw Object.assign(new Error(`batch action ${index} requires a tool name`), { status: 400 });
        }
        // `{tool,args}` is the documented shape. Accepting `{action,...args}`
        // or `{type,...args}` as well keeps HTTP callers ergonomic without
        // exposing raw internal dispatcher actions to the extension.
        const tool = typeof entry.tool === 'string' ? entry.tool
          : (typeof entry.action === 'string' ? entry.action : entry.type);
        if (typeof tool !== 'string') {
          throw Object.assign(new Error(`batch action ${index} requires a tool name`), { status: 400 });
        }
        if (!BATCH_TOOLS.has(tool)) {
          throw Object.assign(new Error(`Tool ${tool} is not supported in batch_actions`), { status: 400 });
        }
        let childArgs = entry.args;
        if (childArgs === undefined) {
          childArgs = { ...entry };
          delete childArgs.tool;
          delete childArgs.action;
          delete childArgs.type;
        }
        if (!childArgs || typeof childArgs !== 'object' || Array.isArray(childArgs)) {
          throw Object.assign(new Error(`batch action ${index} args must be an object`), { status: 400 });
        }
        const normalized = toolToAction(tool, childArgs);
        if (normalized.frameId !== undefined && (!Number.isInteger(normalized.frameId) || normalized.frameId < 0)) {
          throw Object.assign(new Error(`batch action ${index} frameId must be a non-negative integer`), { status: 400 });
        }
        // Retain the public tool name for readable per-action results while
        // dispatching the already-validated internal action on the wire.
        return { ...normalized, batchTool: tool };
      });
      return { action: 'batch_actions', actions, stopOnError };
    }
    case 'downloads': {
      const limit = args.limit ?? 20;
      if (!Number.isFinite(limit) || limit < 1 || limit > 100) throw Object.assign(new Error('downloads limit must be 1-100'), { status: 400 });
      return { action: 'downloads', limit, state: args.state };
    }
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { status: 404 });
  }
}

// --- shared transport queue ---
let nextId = 1;
const jobs = [];
const waiters = [];
const waitingCalls = new Map();
const pendingJobs = new Map();
const wsInFlight = new Map();
let pendingBytes = 0;
let wsClient = null;
let wsHealthy = false;

function removePendingJob(id) {
  const job = pendingJobs.get(id);
  if (!job) return null;
  pendingJobs.delete(id);
  pendingBytes = Math.max(0, pendingBytes - job.bytes);
  const queued = jobs.findIndex(j => j.id === id);
  if (queued !== -1) jobs.splice(queued, 1);
  const inFlight = wsInFlight.get(id);
  if (inFlight) { clearTimeout(inFlight.timer); wsInFlight.delete(id); }
  return job;
}

function queueForFailover(job) {
  if (!pendingJobs.has(job.id) || jobs.some(j => j.id === job.id)) return;
  // The pending-call cap bounds this queue during a WSS failover. Do not drop
  // an already accepted job merely because several WSS jobs are requeued.
  jobs.push(job);
}

function sendWsJob(job) {
  if (!wsHealthy || wsClient?.readyState !== WebSocket.OPEN) {
    if (wsHealthy) wsHealthy = false;
    return false;
  }
  const wire = JSON.stringify({ type: 'job', job: { id: job.id, ...job.action } });
  if (Buffer.byteLength(wire) > MAX_BODY) return false;
  try {
    wsClient.send(wire);
    const socket = wsClient;
    const timer = setTimeout(() => {
      const item = wsInFlight.get(job.id);
      if (item?.socket === socket) {
        wsInFlight.delete(job.id);
        queueForFailover(job);
        // An unacknowledged job means the open socket is not useful. Force
        // failover so queued work is drained by HTTP or a fresh WSS session.
        if (wsClient === socket) {
          wsHealthy = false;
          try { socket.terminate(); } catch {}
        }
      }
    }, WSS_ACK_TIMEOUT);
    wsInFlight.set(job.id, { socket, timer, job });
    return true;
  } catch {
    wsHealthy = false;
    try { wsClient?.terminate(); } catch {}
    return false;
  }
}

function dispatchJob(job) {
  if (sendWsJob(job)) return;
  const waiter = waiters.shift();
  if (waiter && !waiter.res.writableEnded) {
    clearTimeout(waiter.timer);
    waiter.res.writeHead(200, { 'Content-Type': 'application/json' });
    waiter.res.end(JSON.stringify({ id: job.id, ...job.action }));
  } else {
    if (waiter) clearTimeout(waiter.timer);
    jobs.push(job);
  }
}

function flushQueuedJobs() {
  if (!wsHealthy) return;
  while (jobs.length) {
    const job = jobs.shift();
    if (!sendWsJob(job)) { jobs.unshift(job); break; }
  }
}

function enqueue(action) {
  if (jobs.length >= MAX_QUEUE_JOBS && !wsHealthy) throw Object.assign(new Error(`Queue full (${MAX_QUEUE_JOBS})`), { status: 429 });
  if (waitingCalls.size >= MAX_PENDING_CALLS) throw Object.assign(new Error(`Too many pending calls (${MAX_PENDING_CALLS})`), { status: 503 });
  const id = nextId++;
  const job = { id, action, bytes: Buffer.byteLength(JSON.stringify({ type: 'job', job: { id, ...action } })) };
  if (job.bytes > MAX_BODY) throw Object.assign(new Error(`Job too large (max ${MAX_BODY} bytes)`), { status: 413 });
  if (pendingBytes + job.bytes > MAX_QUEUE_BYTES) throw Object.assign(new Error(`Pending queue too large (max ${MAX_QUEUE_BYTES} bytes)`), { status: 429 });
  pendingJobs.set(id, job);
  pendingBytes += job.bytes;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removePendingJob(id);
      waitingCalls.delete(id);
      reject(Object.assign(new Error('Extension did not respond before the transport timeout'), { status: 504 }));
    }, ENQUEUE_TIMEOUT);
    waitingCalls.set(id, { resolve: v => { clearTimeout(timer); waitingCalls.delete(id); removePendingJob(id); resolve(v); }, reject: e => { clearTimeout(timer); waitingCalls.delete(id); removePendingJob(id); reject(e); } });
    dispatchJob(job);
  });
}

function takeJob() {
  const job = jobs.shift() || null;
  return job ? { id: job.id, ...job.action } : null;
}
function completeJob(id, result) {
  if (typeof id !== 'number' || !Number.isFinite(id)) return false;
  const call = waitingCalls.get(id);
  if (!call) return false;
  call.resolve(result);
  return true;
}

function handleCors(req, res) {
  const origin = req.headers.origin || '';
  if (origin) {
    if (origin.startsWith('chrome-extension://')) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Specter-Token, X-ATTK-Token, Authorization');
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

// --- simple rate limiting for /tool (sliding window, per-IP) ---
const RATE_WINDOW = 60_000;
const RATE_MAX = 120;
const rateHits = new Map(); // ip -> [timestamps]
function checkRateLimit(ip) {
  const now = Date.now();
  const hits = (rateHits.get(ip) || []).filter(t => now - t < RATE_WINDOW);
  if (hits.length >= RATE_MAX) return false;
  hits.push(now);
  rateHits.set(ip, hits);
  // occasional cleanup
  if (rateHits.size > 1000) {
    for (const [k, v] of rateHits) {
      if (!v.some(t => now - t < RATE_WINDOW)) rateHits.delete(k);
    }
  }
  return true;
}

// --- HTTP server ---
const server = http.createServer(async (req, res) => {
  if (!handleCors(req, res)) return;
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/poll' && req.method === 'GET') {
    // A healthy WSS connection is authoritative. Returning immediately keeps
    // stale pollers from competing with the fast transport during failover.
    if (wsHealthy) { res.writeHead(204); return res.end(); }
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
    if (TOKEN) {
      const hdrSpecter = req.headers['x-specter-token'];
      const hdrAttk = req.headers['x-attk-token'];
      const hdrAuth = req.headers['authorization'];
      let provided = '';
      if (typeof hdrSpecter === 'string' && hdrSpecter) provided = hdrSpecter.trim();
      else if (typeof hdrAttk === 'string' && hdrAttk) provided = hdrAttk.trim();
      else if (typeof hdrAuth === 'string' && hdrAuth) {
        const m = /^Bearer\s+(.+)$/i.exec(hdrAuth.trim());
        if (m) provided = m[1].trim();
      }
      // constant-time compare to avoid timing side-channel
      const ok = (() => {
        if (!provided) return false;
        const a = Buffer.from(provided);
        const b = Buffer.from(TOKEN);
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
      })();
      if (!ok) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
      }
    }
    if (!checkRateLimit(req.socket.remoteAddress || 'unknown')) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `Rate limit exceeded (${RATE_MAX} tool calls/min)` }));
    }
    const body = await readBody(req, res);
    if (body === null) return;
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
    return res.end(JSON.stringify({ ok: true, version: VERSION, port: PORT, wssPort: WS_PORT, wssHealthy: wsHealthy, uptime: Math.round((Date.now() - startedAt)/1000), queued: jobs.length, pending: waitingCalls.size, pendingBytes, waiters: waiters.length, polling: !wsHealthy && waiters.length > 0 }));
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

// Optional WSS fast path. HTTP polling remains the compatibility fallback.
const certPath = path.join(__dirname, 'certs');
try {
  const tls = { key: fs.readFileSync(path.join(certPath, 'localhost-key.pem')), cert: fs.readFileSync(path.join(certPath, 'localhost-cert.pem')) };
  const wssServer = https.createServer(tls);
  const wss = new WebSocketServer({ server: wssServer, path: '/ws', maxPayload: MAX_BODY });
  const requeueSocketJobs = (socket) => {
    for (const [id, item] of wsInFlight) {
      if (item.socket !== socket) continue;
      clearTimeout(item.timer);
      wsInFlight.delete(id);
      queueForFailover(item.job);
    }
  };
  const markSocketDead = (socket) => {
    const isCurrent = wsClient === socket;
    requeueSocketJobs(socket);
    if (!isCurrent) {
      // A replacement socket may already be healthy; drain jobs replayed from
      // the old connection onto it immediately.
      flushQueuedJobs();
      return;
    }
    wsHealthy = false;
    wsClient = null;
    // Wake the HTTP fallback immediately; the extension will reconnect with
    // backoff while this path drains jobs without losing accepted work.
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      try { if (!waiter.res.writableEnded) { waiter.res.writeHead(204); waiter.res.end(); } } catch {}
    }
  };
  wss.on('connection', (socket) => {
    if (wsClient && wsClient.readyState !== WebSocket.CLOSED) wsClient.close(1013, 'Replaced by newer extension connection');
    wsClient = socket;
    wsHealthy = true;
    socket.lastPongAt = Date.now();
    socket.on('pong', () => { socket.lastPongAt = Date.now(); });
    socket.on('message', raw => {
      try {
        if (Buffer.byteLength(raw) > MAX_BODY) return socket.close(1009, 'Message too large');
        const msg = JSON.parse(raw.toString());
        socket.lastPongAt = Date.now();
        if (msg.type === 'pong') return;
        if (msg.type === 'ack' && Number.isFinite(msg.id)) {
          const item = wsInFlight.get(msg.id);
          if (item?.socket === socket) { clearTimeout(item.timer); item.timer = null; item.acked = true; }
          return;
        }
        if (msg.type === 'result' && Number.isFinite(msg.id)) {
          completeJob(msg.id, msg.result);
          try { if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack', id: msg.id })); } catch {}
        }
      } catch (e) { console.error('[Specter] invalid WSS message:', e.message); }
    });
    socket.on('close', () => markSocketDead(socket));
    socket.on('error', () => markSocketDead(socket));
    try { socket.send(JSON.stringify({ type: 'ready', version: VERSION, heartbeatMs: WSS_HEARTBEAT_MS })); } catch { markSocketDead(socket); return; }
    flushQueuedJobs();
  });
  const heartbeat = setInterval(() => {
    if (!wsClient || wsClient.readyState !== WebSocket.OPEN) return;
    if (Date.now() - wsClient.lastPongAt > WSS_DEAD_AFTER_MS) {
      try { wsClient.terminate(); } catch {}
      return;
    }
    try {
      // Native ping catches half-open TCP connections; the JSON ping keeps the
      // protocol observable to browser clients that cannot issue native pings.
      wsClient.ping();
      wsClient.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
    } catch { markSocketDead(wsClient); }
  }, WSS_HEARTBEAT_MS);
  heartbeat.unref?.();
  // WSS is optional: a port collision must not take down the HTTP fallback.
  wssServer.on('error', e => console.error(`[Specter] WSS unavailable on ${WS_PORT}: ${e.message}`));
  wssServer.listen(WS_PORT, '127.0.0.1', () => console.error(`[Specter] WSS fast path on wss://127.0.0.1:${WS_PORT}/ws`));
} catch (e) { console.error(`[Specter] WSS disabled: ${e.message}`); }

// --- MCP stdio server ---
const mcp = new Server({ name: 'specter', version: VERSION }, { capabilities: { tools: {}, resources: {}, prompts: {} } });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [] }));
mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: [] }));
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  try {
    if (!TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
    const action = toolToAction(name, args || {});
    if (action.action === 'wait') { await new Promise(r => setTimeout(r, action.ms)); return { content: [{ type: 'text', text: `waited ${action.ms}ms` }], isError: false }; }
    const result = await enqueue(action);
    if ((name === 'tab_screenshot' || name === 'tab_visual_snapshot') && result?.dataUrl) {
      const m = /^data:(image\/[a-z0-9.+-]+);base64,(.*)$/.exec(result.dataUrl);
      if (m) {
        const snapshotText = name === 'tab_visual_snapshot' && result.snapshot ? `\nSemantic snapshot:\n${JSON.stringify(result.snapshot)}` : '';
        return { content: [{ type: 'image', data: m[2], mimeType: m[1] }, { type: 'text', text: `Screenshot captured (${Math.round(m[2].length * 3 / 4 / 1024)} KB ${m[1]})${snapshotText}` }], isError: false };
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

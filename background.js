// background.js — service worker + MCP bridge poll loop
// Port discovery: the bridge honors ATTK_PORT, so probe a small range on
// startup instead of hardcoding 8765 (avoids silent mismatch when the env var
// is changed). First /health that answers wins.
const BRIDGE_PORTS = [8765, 8766, 8767, 8768];
let WSS_URL = 'wss://127.0.0.1:8766/ws';
let wssSocket = null;
let wssHealthy = false;
let wssRetryTimer = null;
let wssRetryMs = 1000;
let wssLastPingAt = 0;
let BRIDGE_URL = 'http://127.0.0.1:8765';
let portResolved = false;
let portResolvedAt = 0;
const PORT_CACHE_MS = 30000;
const WSS_RETRY_MAX_MS = 30000;
const WSS_HEARTBEAT_TIMEOUT_MS = 50000;
const WSS_MAX_MESSAGE_BYTES = 8_000_000;

async function resolveBridgePort() {
  if (portResolved) {
    if (Date.now() - portResolvedAt < PORT_CACHE_MS) {
      try {
        const probe = await fetch(`${BRIDGE_URL}/health`, { signal: AbortSignal.timeout(1500) });
        if (probe.ok) {
          const d = await probe.json().catch(() => null);
          if (d?.ok) {
            if (Number.isFinite(d.wssPort)) WSS_URL = `wss://127.0.0.1:${d.wssPort}/ws`;
            return BRIDGE_URL;
          }
        }
      } catch {}
    }
    portResolved = false;
  }
  for (const p of BRIDGE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.ok && (data.version || data.port)) {
          BRIDGE_URL = `http://127.0.0.1:${p}`;
          if (Number.isFinite(data.wssPort)) WSS_URL = `wss://127.0.0.1:${data.wssPort}/ws`;
          else WSS_URL = `wss://127.0.0.1:${p + 1}/ws`;
          portResolved = true;
          portResolvedAt = Date.now();
          return BRIDGE_URL;
        }
      }
    } catch {}
  }
  return BRIDGE_URL; // fall back to default; poll loop will retry
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const wssCompleted = new Map();
const wssRunning = new Map();

async function postResult(id, result) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const base = await resolveBridgePort();
      const response = await fetch(`${base}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, result }),
        signal: AbortSignal.timeout(5000)
      });
      if (response.ok) return;
    } catch (e) {
      if (attempt === 2) console.debug('[Specter] WSS result fallback failed:', e.message);
    }
    if (attempt < 2) await sleep(250 * (attempt + 1));
  }
}

function sendWssResult(socket, id, result) {
  try {
    const payload = JSON.stringify({ type: 'result', id, result });
    if (new TextEncoder().encode(payload).byteLength <= WSS_MAX_MESSAGE_BYTES
      && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
      return;
    }
  } catch {}
  // The bridge requeues jobs when their WSS connection disappears. HTTP result
  // delivery lets an already-completed job win that race without losing work.
  postResult(id, result);
}

function scheduleWssReconnect() {
  if (wssRetryTimer) return;
  const delay = wssRetryMs;
  wssRetryMs = Math.min(WSS_RETRY_MAX_MS, wssRetryMs * 2);
  wssRetryTimer = setTimeout(() => { wssRetryTimer = null; connectWss(); }, delay);
}

async function connectWss() {
  if (wssSocket && (wssSocket.readyState === WebSocket.OPEN || wssSocket.readyState === WebSocket.CONNECTING)) return;
  try {
    await resolveBridgePort();
    const socket = new WebSocket(WSS_URL);
    wssSocket = socket;
    socket.onopen = () => {
      if (wssSocket !== socket) return;
      wssHealthy = true;
      wssLastPingAt = Date.now();
      stopPolling();
    };
    socket.onmessage = event => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'ping') {
          wssLastPingAt = Date.now();
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'pong', ts: msg.ts }));
          return;
        }
        if (msg.type === 'ready') {
          // Only reset backoff after the bridge handshake, not merely after a
          // TCP connection that may immediately flap.
          wssRetryMs = 1000;
          return;
        }
        if (msg.type === 'ack') return;
        if (msg.type !== 'job' || !msg.job || !Number.isFinite(msg.job.id) || typeof msg.job.action !== 'string') return;
        const id = msg.job.id;
        // ACK before executing. If a failover replays a completed job, return
        // its cached result rather than performing a click/type twice.
        if (wssCompleted.has(id)) {
          try { socket.send(JSON.stringify({ type: 'ack', id })); } catch {}
          sendWssResult(socket, id, wssCompleted.get(id));
          return;
        }
        try { socket.send(JSON.stringify({ type: 'ack', id })); } catch {}
        if (wssRunning.has(id)) {
          wssRunning.get(id).then(result => sendWssResult(socket, id, result), e => sendWssResult(socket, id, { ok: false, error: e.message }));
          return;
        }
        const running = runSerialized({ ...msg.job, source: 'wss' });
        wssRunning.set(id, running);
        running.then(result => {
          wssCompleted.set(id, result);
          while (wssCompleted.size > 200) wssCompleted.delete(wssCompleted.keys().next().value);
          sendWssResult(socket, id, result);
        }, e => sendWssResult(socket, id, { ok: false, error: e.message })).finally(() => wssRunning.delete(id));
      } catch (e) { console.debug('[Specter] WSS job failed:', e.message); }
    };
    socket.onclose = () => {
      if (socket._heartbeatTimer) clearInterval(socket._heartbeatTimer);
      if (wssSocket === socket) {
        wssSocket = null;
        wssHealthy = false;
        startPolling();
      }
      scheduleWssReconnect();
    };
    socket.onerror = () => { try { socket.close(); } catch { scheduleWssReconnect(); } };
    // A browser WebSocket does not expose native ping frames. Require the
    // bridge's application heartbeat and close a half-open connection.
    socket._heartbeatTimer = setInterval(() => {
      if (wssSocket !== socket) return clearInterval(socket._heartbeatTimer);
      if (Date.now() - wssLastPingAt > WSS_HEARTBEAT_TIMEOUT_MS) {
        try { socket.close(); } catch {}
      }
    }, Math.min(WSS_HEARTBEAT_TIMEOUT_MS, 15000));
  } catch {
    wssHealthy = false;
    startPolling();
    scheduleWssReconnect();
  }
}

let targetTabId = null;
let targetInvalidated = false;
let executionTail = Promise.resolve();
// Keep this allowlist in the extension too: callers can reach the service
// worker without going through bridge.js (for example via runtime messaging).
// A batch must operate on one already-selected target and may not change tabs,
// navigate, evaluate arbitrary page code, or capture large screenshots.
const BATCH_ACTIONS = new Set([
  'snapshot', 'find', 'scroll_into_view', 'query', 'get_text', 'get_html',
  'get_stats', 'click', 'click_semantic', 'click_id', 'click_xy', 'type',
  'key', 'scroll', 'drag', 'wait', 'wait_for', 'wait_for_network_idle', 'console_logs'
]);
const MAX_BATCH_ACTIONS = 50;
function runSerialized(job) {
  const run = executionTail.then(() => handleJob(job));
  executionTail = run.catch(() => {});
  return run;
}

// Ensure alarm is created and persistent across service worker reboots
function ensureAlarm() {
  chrome.alarms.get('attk-poll', (alarm) => {
    if (!alarm) {
      chrome.alarms.create('attk-poll', { periodInMinutes: 1 });
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Specter] installed');
  chrome.alarms.clear('attk-poll', () => {
    chrome.alarms.create('attk-poll', { periodInMinutes: 1 });
  });
});

ensureAlarm();

// Hydrate targetTabId from session storage reliably
async function getStoredTargetTabId() {
  if (targetTabId !== null) return targetTabId;
  try {
    const data = await chrome.storage.session.get('attk_targetTabId');
    if (data?.attk_targetTabId) {
      targetTabId = data.attk_targetTabId;
      return targetTabId;
    }
  } catch {}
  return null;
}

// Automatically clear targetTabId if the locked tab is closed
chrome.tabs.onRemoved.addListener((closedTabId) => {
  if (targetTabId === closedTabId) {
    targetInvalidated = true;
    setTargetTabId(null);
  }
});

async function setTargetTabId(id) {
  targetTabId = id;
  try {
    if (id) {
      await chrome.storage.session.set({ attk_targetTabId: id });
    } else {
      await chrome.storage.session.remove('attk_targetTabId');
    }
  } catch (e) {
    console.debug('[Specter] storage update failed:', e.message);
  }
}

function isAllowedUrl(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function isRestrictedUrl(url) {
  if (!url) return false;
  return url.startsWith('chrome://') || url.startsWith('edge://') || url.startsWith('chrome-extension://')
    || url.startsWith('about:') || url.startsWith('view-source:') || url.startsWith('chrome-untrusted://')
    || url.startsWith('file://') || url.startsWith('data:');
}

async function getTargetTab() {
  if (targetInvalidated) throw new Error('Target tab was closed; explicitly select a new tab with tab_switch');
  const storedId = await getStoredTargetTabId();
  // Never silently fall back to the active tab. A missing lock means there is
  // no automation target, which prevents an agent from leaking into another
  // tab after the locked tab is closed or unlocked.
  if (!storedId) {
    // Unlocked mode may operate on the active tab only when it is already
    // owned by Specter. Never fall back to an unrelated browser tab.
    const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (await isSpecterGroupTab(activeTab)) return activeTab;
    return null;
  }
  try {
    const tab = await chrome.tabs.get(storedId);
    if (tab) {
      // Keep the locked tab in Specter's group if the user moved it out.
      await markTabWithAgentGroup(tab.id);
      return tab;
    }
  } catch {
    await setTargetTabId(null);
  }
  return null;
}

async function getOrCreateAgentGroup(tabId) {
  if (!tabId) return;
  if (!chrome.tabGroups) return;
  try {
    const targetTab = await chrome.tabs.get(tabId);
    const windowId = targetTab.windowId;
    const windowTabs = await chrome.tabs.query({ windowId });
    let existingGroupId = null;
    for (const t of windowTabs) {
      if (t.groupId && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        try {
          const g = await chrome.tabGroups.get(t.groupId);
          if (g.title === '👻 Specter') {
            existingGroupId = t.groupId;
            break;
          }
        } catch {}
      }
    }
    if (existingGroupId) {
      if (targetTab.groupId !== existingGroupId) {
        await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroupId });
      }
      return existingGroupId;
    } else {
      const newGroupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(newGroupId, { title: '👻 Specter', color: 'green' });
      return newGroupId;
    }
  } catch (e) {
    console.debug('[Specter] tab group merge error:', e.message);
  }
}

async function markTabWithAgentGroup(tabId) {
  if (!tabId) return;
  await getOrCreateAgentGroup(tabId);
}

async function isSpecterGroupTab(tab) {
  if (!tab?.id || !chrome.tabGroups || !tab.groupId || tab.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) return false;
  try {
    const group = await chrome.tabGroups.get(tab.groupId);
    return group.title === '👻 Specter';
  } catch { return false; }
}

async function getSpecterGroupTabs() {
  const tabs = await chrome.tabs.query({});
  if (!chrome.tabGroups) return [];
  const owned = [];
  for (const tab of tabs) if (await isSpecterGroupTab(tab)) owned.push(tab);
  return owned;
}

async function unmarkTabFromAgentGroup(tabId) {
  // Never ungroup arbitrary user tabs. Specter may join an existing group,
  // so ownership cannot be inferred from the title alone.
  return tabId;
}

async function sendToActive(msg, timeoutMs = 30000) {
  const tab = await getTargetTab();
  if (!tab?.id) throw new Error('No target tab found');
  if (isRestrictedUrl(tab.url)) {
    throw new Error(`Cannot execute tools on restricted browser page (${tab.url})`);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' }, { frameId: Number.isInteger(msg.frameId) ? msg.frameId : 0 });
  } catch {
    // Inject into every frame so callers can explicitly address frame-local
    // content. Same-origin traversal remains available from the top frame.
    try {
      await chrome.scripting.executeScript({
        target: Number.isInteger(msg.frameId) ? { tabId: tab.id, frameIds: [msg.frameId] } : { tabId: tab.id, frameIds: [0] },
        files: ['content.js']
      });
    } catch (e) {
      throw new Error(`Cannot inject content script into tab ${tab.id} (${tab.url}): ${e.message}`);
    }
    // Inject MAIN-world probe for fetch/xhr/console telemetry without CSP interference
    try {
      await chrome.scripting.executeScript({
        target: Number.isInteger(msg.frameId) ? { tabId: tab.id, frameIds: [msg.frameId] } : { tabId: tab.id, frameIds: [0] },
        world: 'MAIN',
        func: () => {
          if (window.__specter_probe_installed) return;
          window.__specter_probe_installed = true;
          const token = document.documentElement?.getAttribute('data-specter-telemetry-token') || window.__SPECTER_TELEMETRY_TOKEN__;
          if (!token) return;
          const post = (subType, payload = null) => {
            try { window.postMessage({ type: '__SPECTER_TELEMETRY__', token, subType, payload }, '*'); } catch {}
          };

          if (typeof window.fetch === 'function') {
            const origFetch = window.fetch;
            window.fetch = function(...args) {
              let tracked = true;
              try {
                const u = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
                if (u.includes('127.0.0.1:8765') || u.includes('127.0.0.1:8766')) tracked = false;
              } catch {}
              if (tracked) post('req_start');
              let p;
              try {
                p = origFetch.apply(this, args);
              } catch (err) {
                if (tracked) post('req_finish');
                throw err;
              }
              return p.finally(() => {
                if (tracked) post('req_finish');
              });
            };
          }

          if (typeof window.XMLHttpRequest === 'function') {
            const origOpen = XMLHttpRequest.prototype.open;
            const origSend = XMLHttpRequest.prototype.send;
            XMLHttpRequest.prototype.open = function(method, url, ...rest) {
              this.__sp_track = !(typeof url === 'string' && (url.includes('127.0.0.1:8765') || url.includes('127.0.0.1:8766')));
              return origOpen.call(this, method, url, ...rest);
            };
            XMLHttpRequest.prototype.send = function(...args) {
              if (this.__sp_track) {
                this.__sp_done = false;
                post('req_start');
                const finish = () => {
                  if (!this.__sp_done) {
                    this.__sp_done = true;
                    post('req_finish');
                  }
                };
                this.addEventListener('loadend', finish, { once: true });
                this.addEventListener('error', finish, { once: true });
                this.addEventListener('abort', finish, { once: true });
              }
              try {
                return origSend.apply(this, args);
              } catch (err) {
                if (this.__sp_track && !this.__sp_done) {
                  this.__sp_done = true;
                  post('req_finish');
                }
                throw err;
              }
            };
          }

          function safeStr(val) {
            if (val === null || val === undefined) return String(val);
            if (typeof val === 'string') return val;
            if (val instanceof Error) return (val.name || 'Error') + ': ' + (val.message || '') + (val.stack ? '\n' + val.stack : '');
            try {
              const seen = new WeakSet();
              return JSON.stringify(val, (k, v) => {
                if (typeof v === 'object' && v !== null) {
                  if (seen.has(v)) return '[Circular]';
                  seen.add(v);
                }
                return v;
              });
            } catch { return String(val); }
          }

          if (typeof console === 'object') {
            ['error', 'warn', 'info'].forEach(level => {
              const orig = console[level];
              if (typeof orig === 'function') {
                console[level] = function(...args) {
                  try {
                    const text = args.map(safeStr).join(' ').slice(0, 2000);
                    post('console', { level, text });
                  } catch {}
                  return orig.apply(this, args);
                };
              }
            });
          }

          window.addEventListener('error', (e) => {
            try {
              const text = [e.message || 'Script error', e.filename ? 'at ' + e.filename + ':' + e.lineno : ''].filter(Boolean).join(' ');
              post('console', { level: 'uncaught_error', text });
            } catch {}
          });

          window.addEventListener('unhandledrejection', (e) => {
            try {
              const text = e.reason instanceof Error ? e.reason.message : safeStr(e.reason);
              post('console', { level: 'unhandled_rejection', text });
            } catch {}
          });
        }
      });
    } catch {}
    await sleep(50);
  }
  return new Promise((resolve, reject) => {
    let resolved = false;
    const sendOptions = Number.isInteger(msg.frameId) ? { frameId: msg.frameId } : undefined;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Content script communication timed out'));
      }
    }, timeoutMs);

    chrome.tabs.sendMessage(tab.id, msg, sendOptions, (res) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

async function waitForSelector(selector, timeoutMs = 10000, frameId) {
  const deadline = Date.now() + Math.min(timeoutMs, 30000);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await sendToActive({ type: 'CURSOR_QUERY', selector, frameId });
      if (res?.ok && res.count > 0) {
        return { ok: true, found: true, count: res.count, waitedMs: Math.min(timeoutMs, 30000) - (deadline - Date.now()) };
      }
      lastError = null;
    } catch (e) { lastError = e.message; }
    await sleep(300);
  }
  return { ok: false, found: false, error: lastError || `Element not found within ${timeoutMs}ms: ${selector}` };
}

async function handleJob(job) {
  const { id, action, source } = job;
  let result;
  try {
    switch (action) {
      case 'batch_actions': {
        if (!Array.isArray(job.actions) || job.actions.length < 1 || job.actions.length > MAX_BATCH_ACTIONS) {
          throw new Error(`batch_actions requires 1-${MAX_BATCH_ACTIONS} actions`);
        }
        if (job.stopOnError !== undefined && typeof job.stopOnError !== 'boolean') throw new Error('stopOnError must be a boolean');
        if (job.continueOnError !== undefined && typeof job.continueOnError !== 'boolean') throw new Error('continueOnError must be a boolean');
        if (job.stopOnError !== undefined && job.continueOnError !== undefined && job.stopOnError === job.continueOnError) throw new Error('stopOnError and continueOnError disagree');
        const stopOnError = job.stopOnError ?? (job.continueOnError === true ? false : true);
        const results = [];
        let failed = false;
        let firstFailureAt = null;
        let stoppedAt = null;
        for (let index = 0; index < job.actions.length; index++) {
          const child = job.actions[index];
          if (!child || typeof child !== 'object' || !BATCH_ACTIONS.has(child.action)
            || (child.frameId !== undefined && (!Number.isInteger(child.frameId) || child.frameId < 0))) {
            const error = { ok: false, error: !child || typeof child !== 'object' || !BATCH_ACTIONS.has(child.action)
              ? `Unsupported batch action at index ${index}`
              : `Invalid frameId at batch action index ${index}` };
            results.push({ index, action: child?.batchTool || child?.action || null, ok: false, result: error });
            failed = true;
            if (firstFailureAt === null) firstFailureAt = index;
            if (stopOnError) { stoppedAt = index; break; }
            continue;
          }
          // Invoke the normal dispatcher directly rather than queueing another
          // job. The parent already owns runSerialized(), so this preserves
          // ordering while keeping every child on the same locked target.
          const childResult = await handleJob({ ...child, id: `${id}:${index}`, source: 'internal' });
          const childFailed = childResult?.ok === false;
          results.push({ index, action: child.batchTool || child.action, ok: !childFailed, result: childResult });
          if (childFailed) {
            failed = true;
            if (firstFailureAt === null) firstFailureAt = index;
            if (stopOnError) { stoppedAt = index; break; }
          }
        }
        if (stoppedAt !== null && stoppedAt < job.actions.length - 1) {
          for (let index = results.length; index < job.actions.length; index++) {
            results.push({ index, action: job.actions[index]?.batchTool || job.actions[index]?.action || null, ok: false, skipped: true, result: null });
          }
        }
        result = { ok: !failed, results, stopped: stoppedAt !== null, stoppedAt, firstFailureAt };
        break;
      }
      case 'navigate': {
        if (!isAllowedUrl(job.url)) throw new Error('navigate only allows http/https URLs');
        const tab = await getTargetTab();
        if (!tab?.id) throw new Error('No target tab found to navigate');
        await chrome.tabs.update(tab.id, { url: job.url });
        await markTabWithAgentGroup(tab.id);
        result = { ok: true, url: job.url, tabId: tab.id };
        break;
      }
      case 'new_tab': {
        // Creating a tab is a target transition: keep the existing tab in the
        // Specter group, but move the lock to the newly-created tab so the
        // caller can use it immediately. `active:false` keeps the browser
        // selection unchanged while still allowing background automation.
        const createOptions = { active: job.active !== false };
        if (job.url !== undefined) {
          if (!isAllowedUrl(job.url)) throw new Error('new_tab only allows http/https URLs');
          createOptions.url = job.url;
        }
        const tab = await chrome.tabs.create(createOptions);
        if (!tab?.id) throw new Error('Browser did not return the new tab');
        await markTabWithAgentGroup(tab.id);
        targetInvalidated = false;
        await setTargetTabId(tab.id);
        result = { ok: true, tabId: tab.id, targetTabId: tab.id, active: tab.active === true, url: tab.url || job.url || '' };
        break;
      }
      case 'add_to_group': {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab?.id) throw new Error('No active tab found');
        await markTabWithAgentGroup(tab.id);
        // Adding a tab to the group selects it only when no tab is locked.
        const currentTarget = await getStoredTargetTabId();
        if (!currentTarget) {
          targetInvalidated = false;
          await setTargetTabId(tab.id);
        }
        result = { ok: true, tabId: tab.id, targetTabId: currentTarget || tab.id };
        break;
      }
      case 'list_tabs': {
        const currentId = await getStoredTargetTabId();
        // Specter owns every tab inside its named group, but nothing outside it.
        const tabs = await getSpecterGroupTabs();
        result = {
          ok: true,
          targetTabId: currentId,
          tabs: tabs.map(t => ({
            id: t.id,
            index: t.index,
            windowId: t.windowId,
            title: t.title,
            url: t.url,
            active: t.active,
            isTarget: t.id === currentId
          }))
        };
        break;
      }
      case 'switch_tab': {
        const tabId = typeof job.tabId === 'number' ? job.tabId : (job.tabId ? parseInt(job.tabId, 10) : null);
        const prevTargetId = await getStoredTargetTabId();
        if (prevTargetId && tabId !== null && tabId !== prevTargetId) {
          throw new Error(`Specter is locked to tab ${prevTargetId}; unlock it before selecting another tab`);
        }
        if (tabId !== null) {
          let tab;
          try { tab = await chrome.tabs.get(tabId); } catch { throw new Error(`Target tab ${tabId} does not exist`); }
          if (!(await isSpecterGroupTab(tab))) throw new Error('Specter can only switch to tabs inside the 👻 Specter group');
        }
        if (prevTargetId && prevTargetId !== tabId) {
          await unmarkTabFromAgentGroup(prevTargetId);
        }
        targetInvalidated = false;
        await setTargetTabId(tabId);
        if (tabId) {
          await markTabWithAgentGroup(tabId);
          if (job.focusWindow !== false) {
            await chrome.tabs.update(tabId, { active: true });
          }
        }
        result = { ok: true, targetTabId: tabId };
        break;
      }
      case 'close_tab': {
        const currentTab = await getTargetTab();
        const tabId = job.tabId ? (typeof job.tabId === 'number' ? job.tabId : parseInt(job.tabId, 10)) : currentTab?.id;
        if (!tabId) throw new Error('No target tab found to close');
        const currentTarget = await getStoredTargetTabId();
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!(await isSpecterGroupTab(tab))) throw new Error('Specter can only close tabs inside the 👻 Specter group');
        if (currentTarget && currentTarget !== tabId) throw new Error(`Specter is locked to tab ${currentTarget}; cannot close another tab`);
        if (currentTarget === tabId) await setTargetTabId(null);
        await chrome.tabs.remove(tabId);
        result = { ok: true, closedTabId: tabId };
        break;
      }
      case 'tab_eval': {
        if (job.allowEval !== true) throw new Error('tab_eval requires explicit allowEval:true');
        const tab = await getTargetTab();
        if (!tab?.id) throw new Error('No target tab found for eval');
        if (isRestrictedUrl(tab.url)) throw new Error(`Cannot execute eval on restricted browser page (${tab.url})`);
        const execResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (code) => {
            let fn;
            try { fn = new Function('return (' + code + ')'); }
            catch { try { fn = new Function(code); } catch (e) { return { ok: false, error: e.message }; } }
            try {
              const val = fn();
              try { structuredClone(val); return { ok: true, value: val }; }
              catch { return { ok: true, value: String(val) }; }
            } catch (e) { return { ok: false, error: e.message }; }
          },
          args: [job.code]
        });
        if (!execResults || !execResults[0]) {
          throw new Error('Script execution returned no results');
        }
        result = execResults[0].result;
        break;
      }
      case 'find': result = await sendToActive({ type: 'CURSOR_FIND', text: job.text, label: job.label, role: job.role, max: job.max ?? 20, frameId: job.frameId }); break;
      case 'click_semantic': result = await sendToActive({ type: 'CURSOR_CLICK_SEMANTIC', text: job.text, label: job.label, role: job.role, frameId: job.frameId, kind: job.kind || 'click', duration: job.duration || 520 }); break;
      case 'click': result = await sendToActive({ type: 'CURSOR_CLICK', selector: job.selector, frameId: job.frameId, kind: job.kind || 'click', duration: job.duration || 520 }); break;
      case 'click_xy': result = await sendToActive({ type: 'CURSOR_CLICK_EL', x: job.x, y: job.y, frameId: job.frameId, kind: job.kind || 'click', duration: job.duration || 520 }); break;
      case 'type': result = await sendToActive({ type: 'CURSOR_TYPE', selector: job.selector, text: job.text, frameId: job.frameId, clear: job.clear === true, perChar: job.perChar !== false }); break;
      case 'key': result = await sendToActive({ type: 'CURSOR_KEY', key: job.key, selector: job.selector, frameId: job.frameId }); break;
      case 'scroll': result = await sendToActive({ type: 'CURSOR_SCROLL', direction: job.direction || 'down', amount: job.amount ?? 400, frameId: job.frameId }); break;
      case 'som': result = await sendToActive({ type: 'CURSOR_SOM_TOGGLE', frameId: job.frameId }); break;
      case 'get_text': result = await sendToActive({ type: 'GET_TEXT', selector: job.selector, frameId: job.frameId }); break;
      case 'get_html': result = await sendToActive({ type: 'GET_HTML', selector: job.selector, frameId: job.frameId }); break;
      case 'get_stats': result = await sendToActive({ type: 'GET_STATS', frameId: job.frameId }); break;
      case 'query': result = await sendToActive({ type: 'CURSOR_QUERY', selector: job.selector, frameId: job.frameId }); break;
      case 'snapshot': result = await sendToActive({ type: 'CURSOR_SNAPSHOT', max: job.max ?? 80, inViewportOnly: job.inViewportOnly, frameId: job.frameId }); break;
      case 'scroll_into_view': result = await sendToActive({ type: 'CURSOR_SCROLL_INTO_VIEW', selector: job.selector, element: job.element, frameId: job.frameId }); break;
      case 'downloads': {
        if (!chrome.downloads) throw new Error('Downloads permission is not available; reload the extension after updating the manifest');
        const query = { limit: Math.min(100, Math.max(1, job.limit ?? 20)), orderBy: ['-startTime'] };
        if (job.state) query.state = job.state;
        const items = await chrome.downloads.search(query);
        result = { ok: true, downloads: items.map(d => ({ id: d.id, url: d.url, filename: d.filename, state: d.state, progress: d.bytesReceived, totalBytes: d.totalBytes, startTime: d.startTime, endTime: d.endTime, error: d.error || null })) };
        break;
      }
      case 'visual_snapshot': {
        const tab = await getTargetTab();
        if (!tab?.id) throw new Error('No target tab found for visual snapshot');
        if (isRestrictedUrl(tab.url)) throw new Error(`Cannot screenshot restricted page (${tab.url})`);
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        const needsSwitch = !activeTab || activeTab.id !== tab.id;
        if (needsSwitch) { await chrome.tabs.update(tab.id, { active: true }); await sleep(150); }
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: job.format || 'jpeg', quality: job.quality ?? 60 });
          const snapshot = await sendToActive({ type: 'CURSOR_SNAPSHOT', max: job.max ?? 80, inViewportOnly: true, frameId: job.frameId });
          result = { ok: true, dataUrl, snapshot, switched: needsSwitch };
        } finally { if (needsSwitch && activeTab?.id) { try { await chrome.tabs.update(activeTab.id, { active: true }); } catch {} } }
        break;
      }
      case 'screenshot': {
        const tab = await getTargetTab();
        if (!tab?.id) throw new Error('No target tab found for screenshot');
        if (isRestrictedUrl(tab.url)) throw new Error(`Cannot screenshot restricted page (${tab.url})`);
        // captureVisibleTab only captures the ACTIVE tab of the window. If the
        // agent's target is a background tab, activate it briefly, capture,
        // then restore the previously active tab — all without raising the
        // browser window itself.
        const [activeTab] = await chrome.tabs.query({ active: true, windowId: tab.windowId });
        const needsSwitch = !activeTab || activeTab.id !== tab.id;
        if (needsSwitch) {
          await chrome.tabs.update(tab.id, { active: true });
          await sleep(150); // allow render without a long focus stall
        }
        try {
          const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: job.format || 'jpeg', quality: job.quality ?? 60 });
          result = { ok: true, dataUrl, switched: needsSwitch };
        } finally {
          if (needsSwitch && activeTab?.id) {
            try { await chrome.tabs.update(activeTab.id, { active: true }); } catch {}
          }
        }
        break;
      }
      case 'click_id': result = await sendToActive({ type: 'CURSOR_CLICK_ID', element: job.element, frameId: job.frameId, kind: job.kind || 'click' }); break;
      case 'wait': {
        if (!Number.isFinite(job.ms) || job.ms < 0 || job.ms > 30000) throw new Error('wait ms must be 0-30000');
        await sleep(job.ms);
        result = { ok: true, waitedMs: job.ms };
        break;
      }
      case 'wait_for': result = await waitForSelector(job.selector, job.timeoutMs ?? 10000, job.frameId); break;
      case 'wait_for_network_idle': result = await sendToActive({ type: 'CURSOR_NETWORK_IDLE', idleMs: job.idleMs ?? 500, timeoutMs: job.timeoutMs ?? 15000, frameId: job.frameId }); break;
      case 'console_logs': result = await sendToActive({ type: 'CURSOR_CONSOLE_LOGS', types: job.types, clear: job.clear === true, frameId: job.frameId }); break;
      case 'drag': result = await sendToActive({ type: 'CURSOR_DRAG', from_selector: job.from_selector, from_x: job.from_x, from_y: job.from_y, to_selector: job.to_selector, to_x: job.to_x, to_y: job.to_y, duration: job.duration, frameId: job.frameId }); break;
      default: throw new Error('Unknown action: ' + action);
    }
  } catch (e) { result = { ok: false, error: e.message }; }

  // Deliver result back to bridge if not an internal popup call.
  // Delivery must never throw past this point — a lost /result POST means the
  // caller hangs until its timeout, so failures are logged and retried once.
  if (source !== 'popup' && source !== 'internal' && source !== 'wss') {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const post = await fetch(`${await resolveBridgePort()}/result`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, result })
        });
        if (post.ok) break;
      } catch (e) {
        console.debug('[Specter] result delivery failed:', e.message);
      }
      await sleep(500);
    }
  }
  return result;
}

// --- MV3-safe poll loop (fallback only) ---
let polling = false;
let pollAbort = null;

function stopPolling() {
  polling = false;
  try { pollAbort?.abort(); } catch {}
  pollAbort = null;
}

function startPolling() {
  if (!wssHealthy) pollLoop();
}

async function pollOnce() {
  if (wssHealthy) return;
  const controller = new AbortController();
  pollAbort = controller;
  const timeout = setTimeout(() => controller.abort(), 26000);
  try {
    const res = await fetch(`${await resolveBridgePort()}/poll`, { signal: controller.signal });
    if (res.status === 204) {
      await sleep(200);
      return;
    }
    if (res.status !== 200) {
      if (!wssHealthy) await sleep(3000);
      return;
    }
    const job = await res.json();
    if (job?.action && !wssHealthy) {
      // If a WSS result raced with failover, avoid executing the same click or
      // typing operation a second time when its requeued copy is polled.
      if (wssCompleted.has(job.id)) await postResult(job.id, wssCompleted.get(job.id));
      else await runSerialized(job);
    }
  } catch {
    if (!wssHealthy) await sleep(3000);
  } finally {
    clearTimeout(timeout);
    if (pollAbort === controller) pollAbort = null;
  }
}

async function pollLoop() {
  if (polling || wssHealthy) return;
  polling = true;
  try {
    while (polling && !wssHealthy) await pollOnce();
  } finally {
    polling = false;
    pollAbort = null;
  }
}

// Re-kick entry points
chrome.alarms?.onAlarm?.addListener(a => { if (a.name === 'attk-poll') pollLoop(); });
chrome.runtime.onStartup?.addListener?.(() => setTimeout(pollLoop, 800));
setTimeout(pollLoop, 1200);
setTimeout(connectWss, 1500);

// Merged message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  pollLoop();
  (async () => {
    try {
      if (msg.type === 'MCP' || msg.mcp) {
        const cmd = msg.mcp || msg;
        const action = cmd.action || cmd.tool;
        if (action === 'bridge_status') {
          const storedPort = await resolveBridgePort();
          const p = parseInt(new URL(storedPort).port || '8765', 10);
          let wPort = p < 65535 ? p + 1 : 8766;
          try {
            const parsedWs = new URL(WSS_URL);
            if (parsedWs.port) wPort = parseInt(parsedWs.port, 10);
          } catch {}
          return sendResponse({
            ok: true,
            result: {
              port: p,
              wssPort: wPort,
              wssHealthy: wssHealthy,
              reachable: portResolved
            }
          });
        }
        const job = { id: Date.now(), action, source: msg.source || cmd.source || 'internal', ...cmd };
        const res = await runSerialized(job);
        return sendResponse({ ok: true, result: res });
      }
      if (msg.type?.startsWith('CURSOR_') || msg.type?.startsWith('GET_') || msg.type === 'PING') {
        const res = await sendToActive(msg);
        return sendResponse(res);
      }
    } catch (e) { sendResponse({ ok: false, error: e.message }); }
  })();
  return true;
});

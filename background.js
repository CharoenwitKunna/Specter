// background.js — service worker + MCP bridge poll loop
const BRIDGE_URL = 'http://127.0.0.1:8765';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let targetTabId = null;

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
  const storedId = await getStoredTargetTabId();
  if (storedId) {
    try {
      const tab = await chrome.tabs.get(storedId);
      if (tab) return tab;
    } catch {
      await setTargetTabId(null);
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab?.id) {
    await setTargetTabId(tab.id);
    return tab;
  }
  const [anyTab] = await chrome.tabs.query({ active: true });
  if (anyTab?.id) {
    await setTargetTabId(anyTab.id);
    return anyTab;
  }
  return null;
}

async function getOrCreateAgentGroup(tabId) {
  if (!tabId) return;
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

async function unmarkTabFromAgentGroup(tabId) {
  if (!tabId) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      await chrome.tabs.ungroup(tabId);
    }
  } catch (e) {
    console.debug('[Specter] tab ungroup skipped:', e.message);
  }
}

async function sendToActive(msg, timeoutMs = 30000) {
  const tab = await getTargetTab();
  if (!tab?.id) throw new Error('No target tab found');
  if (isRestrictedUrl(tab.url)) {
    throw new Error(`Cannot execute tools on restricted browser page (${tab.url})`);
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await sleep(200);
  }
  return new Promise((resolve, reject) => {
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Content script communication timed out'));
      }
    }, timeoutMs);

    chrome.tabs.sendMessage(tab.id, msg, (res) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

async function handleJob(job) {
  const { id, action, source } = job;
  let result;
  try {
    switch (action) {
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
        if (job.url && !isAllowedUrl(job.url)) throw new Error('new_tab only allows http/https URLs');
        const shouldBeActive = job.active === true;
        const [activeBefore] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const tab = await chrome.tabs.create({ url: job.url || 'about:blank', active: shouldBeActive });
        await setTargetTabId(tab.id);
        await markTabWithAgentGroup(tab.id);
        if (!shouldBeActive && activeBefore?.id && activeBefore.id !== tab.id) {
          try { await chrome.tabs.update(activeBefore.id, { active: true }); } catch {}
        }
        result = { ok: true, tabId: tab.id, url: tab.url || job.url || 'about:blank' };
        break;
      }
      case 'list_tabs': {
        const tabs = await chrome.tabs.query({});
        const currentId = await getStoredTargetTabId();
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
        if (prevTargetId && prevTargetId !== tabId) {
          await unmarkTabFromAgentGroup(prevTargetId);
        }
        await setTargetTabId(tabId);
        if (tabId) {
          await markTabWithAgentGroup(tabId);
          if (job.focusWindow !== false) {
            await chrome.tabs.update(tabId, { active: true });
          }
        } else {
          try {
            const groups = await chrome.tabGroups.query({ title: '👻 Specter' });
            for (const g of groups) {
              const gTabs = await chrome.tabs.query({ groupId: g.id });
              const tabIds = gTabs.map(t => t.id);
              if (tabIds.length > 0) {
                await chrome.tabs.ungroup(tabIds);
              }
            }
          } catch (e) {
            console.debug('[Specter] ungroup all skipped:', e.message);
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
        if (currentTarget === tabId) await setTargetTabId(null);
        await chrome.tabs.remove(tabId);
        result = { ok: true, closedTabId: tabId };
        break;
      }
      case 'tab_eval': {
        const tab = await getTargetTab();
        if (!tab?.id) throw new Error('No target tab found for eval');
        if (isRestrictedUrl(tab.url)) throw new Error(`Cannot execute eval on restricted browser page (${tab.url})`);
        const execResults = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (code) => {
            try {
              const fn = new Function('return (' + code + ')');
              const val = fn();
              try {
                structuredClone(val);
                return { ok: true, value: val };
              } catch {
                return { ok: true, value: String(val) };
              }
            } catch (e) {
              try {
                const fnBlock = new Function(code);
                const val = fnBlock();
                try {
                  structuredClone(val);
                  return { ok: true, value: val };
                } catch {
                  return { ok: true, value: String(val) };
                }
              } catch (e2) {
                return { ok: false, error: e2.message };
              }
            }
          },
          args: [job.code]
        });
        if (!execResults || !execResults[0]) {
          throw new Error('Script execution returned no results');
        }
        result = execResults[0].result;
        break;
      }
      case 'click': result = await sendToActive({ type: 'CURSOR_CLICK', selector: job.selector, kind: job.kind || 'click', duration: job.duration || 520 }); break;
      case 'click_xy': result = await sendToActive({ type: 'CURSOR_CLICK_EL', x: job.x, y: job.y, duration: job.duration || 520 }); break;
      case 'type': result = await sendToActive({ type: 'CURSOR_TYPE', selector: job.selector, text: job.text }); break;
      case 'key': result = await sendToActive({ type: 'CURSOR_KEY', key: job.key, selector: job.selector }); break;
      case 'scroll': result = await sendToActive({ type: 'CURSOR_SCROLL', direction: job.direction || 'down', amount: job.amount ?? 400 }); break;
      case 'som': result = await sendToActive({ type: 'CURSOR_SOM_TOGGLE' }); break;
      case 'get_text': result = await sendToActive({ type: 'GET_TEXT', selector: job.selector }); break;
      case 'get_html': result = await sendToActive({ type: 'GET_HTML', selector: job.selector }); break;
      case 'get_stats': result = await sendToActive({ type: 'GET_STATS' }); break;
      case 'query': result = await sendToActive({ type: 'CURSOR_QUERY', selector: job.selector }); break;
      case 'snapshot': result = await sendToActive({ type: 'CURSOR_SNAPSHOT', max: job.max ?? 80, inViewportOnly: job.inViewportOnly }); break;
      case 'scroll_into_view': result = await sendToActive({ type: 'CURSOR_SCROLL_INTO_VIEW', selector: job.selector, element: job.element }); break;
      case 'screenshot': {
        const tab = await getTargetTab();
        if (!tab?.id) throw new Error('No target tab found for screenshot');
        if (isRestrictedUrl(tab.url)) throw new Error(`Cannot screenshot restricted page (${tab.url})`);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: job.format || 'png' });
        result = { ok: true, dataUrl };
        break;
      }
      case 'click_id': result = await sendToActive({ type: 'CURSOR_CLICK_ID', element: job.element, kind: job.kind || 'click' }); break;
      case 'drag': result = await sendToActive({ type: 'CURSOR_DRAG', from_selector: job.from_selector, from_x: job.from_x, from_y: job.from_y, to_selector: job.to_selector, to_x: job.to_x, to_y: job.to_y, duration: job.duration }); break;
      default: throw new Error('Unknown action: ' + action);
    }
  } catch (e) { result = { ok: false, error: e.message }; }

  // Deliver result back to bridge if not an internal popup call
  if (source !== 'popup' && source !== 'internal') {
    try {
      await fetch(`${BRIDGE_URL}/result`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, result })
      });
    } catch (e) {
      console.debug('[Specter] result delivery failed:', e.message);
    }
  }
  return result;
}

// --- MV3-safe poll loop ---
let polling = false;

async function pollOnce() {
  try {
    const res = await fetch(`${BRIDGE_URL}/poll`, { signal: AbortSignal.timeout(26000) });
    if (res.status === 204) {
      await sleep(200);
      return;
    }
    if (res.status !== 200) {
      await sleep(3000);
      return;
    }
    const job = await res.json();
    if (job?.action) {
      await handleJob(job);
    }
  } catch {
    await sleep(3000);
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (polling) {
      await pollOnce();
    }
  } finally {
    polling = false;
  }
}

// Re-kick entry points
chrome.alarms?.onAlarm?.addListener(a => { if (a.name === 'attk-poll') pollLoop(); });
chrome.runtime.onStartup?.addListener?.(() => setTimeout(pollLoop, 800));
setTimeout(pollLoop, 1200);

// Merged message listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  pollLoop();
  (async () => {
    try {
      if (msg.type === 'MCP' || msg.mcp) {
        const cmd = msg.mcp || msg;
        const action = cmd.action || cmd.tool;
        const job = { id: Date.now(), action, source: msg.source || cmd.source || 'internal', ...cmd };
        const res = await handleJob(job);
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

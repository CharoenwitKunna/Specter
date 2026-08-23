// background.js — service worker + MCP bridge poll loop
const BRIDGE_URL = 'http://127.0.0.1:8765';

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Active Tab Toolkit] installed');
  try { chrome.contextMenus.create({ id: 'attk-copy-url', title: 'Copy page URL (Active Tab Toolkit)', contexts: ['page'] }); } catch {}
});

chrome.contextMenus?.onClicked?.addListener((info, tab) => {
  if (info.menuItemId === 'attk-copy-url' && tab?.url) {
    chrome.scripting.executeScript({ target: { tabId: tab.id }, func: (url) => navigator.clipboard.writeText(url), args: [tab.url] });
  }
});

let targetTabId = null; // Stays focused on the assigned tab even when user switches to YouTube!

// Load stored targetTabId on service worker start
chrome.storage.session.get('attk_targetTabId').then(({ attk_targetTabId }) => {
  if (attk_targetTabId) targetTabId = attk_targetTabId;
}).catch(() => {});

async function setTargetTabId(id) {
  targetTabId = id;
  try {
    if (id) await chrome.storage.session.set({ attk_targetTabId: id });
    else await chrome.storage.session.remove('attk_targetTabId');
  } catch {}
}

async function getTargetTab() {
  if (targetTabId) {
    try {
      const tab = await chrome.tabs.get(targetTabId);
      if (tab) return tab;
    } catch {
      await setTargetTabId(null);
    }
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) await setTargetTabId(tab.id);
  return tab;
}

async function getOrCreateAgentGroup(tabId) {
  if (!tabId) return;
  try {
    const targetTab = await chrome.tabs.get(tabId);
    const windowId = targetTab.windowId;

    // 1. Find ANY tab in this window that already belongs to a group titled '🤖 AI Worker'
    const windowTabs = await chrome.tabs.query({ windowId });
    let existingGroupId = null;

    for (const t of windowTabs) {
      if (t.groupId && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        try {
          const g = await chrome.tabGroups.get(t.groupId);
          if (g.title === '👻 Specter' || g.title === '🤖 AI Worker') {
            existingGroupId = t.groupId;
            break;
          }
        } catch {}
      }
    }

    if (existingGroupId) {
      // Join the existing group directly
      await chrome.tabs.group({ tabIds: [tabId], groupId: existingGroupId });
      return existingGroupId;
    } else {
      // Create a brand new group only if none exists
      const newGroupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(newGroupId, { title: '👻 Specter', color: 'green' });
      return newGroupId;
    }
  } catch (e) {
    console.debug('tab group merge error:', e.message);
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
    console.debug('tab ungroup skipped:', e.message);
  }
}

async function sendToActive(msg, timeoutMs = 30000) {
  const tab = await getTargetTab();
  if (!tab?.id) throw new Error('No target tab found');
  if (tab.url?.startsWith('chrome://') || tab.url?.startsWith('edge://') || tab.url?.startsWith('chrome-extension://')) {
    throw new Error(`Cannot execute tools on restricted browser page (${tab.url})`);
  }
  try { await chrome.tabs.sendMessage(tab.id, { type: 'PING' }); } catch {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
    await new Promise(r => setTimeout(r, 200));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('content timeout')), timeoutMs);
    chrome.tabs.sendMessage(tab.id, msg, (res) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (res?.error) return reject(new Error(res.error));
      resolve(res);
    });
  });
}

async function handleJob(job) {
  const { id, action } = job;
  let result;
  try {
    switch (action) {
      case 'navigate': {
        const tab = await getTargetTab();
        await chrome.tabs.update(tab.id, { url: job.url });
        await markTabWithAgentGroup(tab.id);
        result = { ok: true, url: job.url, tabId: tab.id };
        break;
      }
      case 'new_tab': {
        const [activeBefore] = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = await chrome.tabs.create({ url: job.url || 'about:blank', active: false });
        await setTargetTabId(tab.id);
        await markTabWithAgentGroup(tab.id);
        // Force focus to remain on the user's active tab (e.g. YouTube) so Chrome never shifts focus
        if (activeBefore?.id && activeBefore.id !== tab.id) {
          try { await chrome.tabs.update(activeBefore.id, { active: true }); } catch {}
        }
        result = { ok: true, tabId: tab.id, url: tab.url };
        break;
      }
      case 'list_tabs': {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        result = {
          ok: true,
          targetTabId,
          tabs: tabs.map(t => ({ id: t.id, index: t.index, title: t.title, url: t.url, active: t.active, isTarget: t.id === targetTabId }))
        };
        break;
      }
      case 'switch_tab': {
        const tabId = typeof job.tabId === 'number' ? job.tabId : (job.tabId ? parseInt(job.tabId, 10) : null);
        if (targetTabId && targetTabId !== tabId) {
          await unmarkTabFromAgentGroup(targetTabId);
        }
        await setTargetTabId(tabId);
        if (tabId) {
          await markTabWithAgentGroup(tabId);
          if (job.focusWindow !== false) {
            await chrome.tabs.update(tabId, { active: true });
          }
        } else {
          // If unsetting target, ungroup all tabs in the AI group
          try {
            const groups = await chrome.tabGroups.query({ title: '🤖 AI Worker' });
            for (const g of groups) {
              const gTabs = await chrome.tabs.query({ groupId: g.id });
              for (const t of gTabs) await chrome.tabs.ungroup(t.id);
            }
          } catch (e) {
            console.debug('ungroup all skipped:', e.message);
          }
        }
        result = { ok: true, targetTabId: tabId };
        break;
      }
      case 'close_tab': {
        const tabId = job.tabId ? (typeof job.tabId === 'number' ? job.tabId : parseInt(job.tabId, 10)) : (await getTargetTab()).id;
        if (targetTabId === tabId) await setTargetTabId(null);
        await chrome.tabs.remove(tabId);
        result = { ok: true, closedTabId: tabId };
        break;
      }
      case 'tab_eval': {
        const tab = await getTargetTab();
        const [{ result: evalRes }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          func: (code) => {
            try {
              const fn = new Function('return (' + code + ')');
              return { ok: true, value: fn() };
            } catch (e) {
              try {
                const fnBlock = new Function(code);
                return { ok: true, value: fnBlock() };
              } catch (e2) {
                return { ok: false, error: e2.message };
              }
            }
          },
          args: [job.code]
        });
        result = evalRes;
        break;
      }
      case 'click': result = await sendToActive({ type: 'CURSOR_CLICK', selector: job.selector, kind: job.kind || 'click', duration: job.duration || 520 }); break;
      case 'click_xy': result = await sendToActive({ type: 'CURSOR_CLICK_EL', x: job.x, y: job.y, duration: job.duration || 520 }); break;
      case 'move': result = await sendToActive({ type: 'CURSOR_MOVE', selector: job.selector, x: job.x, y: job.y, duration: job.duration || 520 }); break;
      case 'type': result = await sendToActive({ type: 'CURSOR_TYPE', selector: job.selector, text: job.text }); break;
      case 'key': result = await sendToActive({ type: 'CURSOR_KEY', key: job.key, selector: job.selector }); break;
      case 'scroll': result = await sendToActive({ type: 'CURSOR_SCROLL', direction: job.direction || 'down', amount: job.amount ?? 400 }); break;
      case 'som': result = await sendToActive({ type: 'CURSOR_SOM_TOGGLE' }); break;
      case 'hide_cursor': result = await sendToActive({ type: 'CURSOR_HIDE' }); break;
      case 'get_text': result = await sendToActive({ type: 'GET_TEXT' }); break;
      case 'get_html': result = await sendToActive({ type: 'GET_HTML' }); break;
      case 'get_stats': result = await sendToActive({ type: 'GET_STATS' }); break;
      case 'query': result = await sendToActive({ type: 'CURSOR_QUERY', selector: job.selector }); break;
      case 'snapshot': result = await sendToActive({ type: 'CURSOR_SNAPSHOT', max: job.max ?? 80, inViewportOnly: job.inViewportOnly }); break;
      case 'scroll_into_view': result = await sendToActive({ type: 'CURSOR_SCROLL_INTO_VIEW', selector: job.selector, element: job.element }); break;
      case 'screenshot': {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: job.format || 'png' });
        result = { ok: true, dataUrl }; // full data URL — MCP turns it into an image block
        break;
      }
      case 'click_id': result = await sendToActive({ type: 'CURSOR_CLICK_ID', element: job.element, kind: job.kind || 'click' }); break;
      case 'drag': result = await sendToActive({ type: 'CURSOR_DRAG', from_selector: job.from_selector, from_x: job.from_x, from_y: job.from_y, to_selector: job.to_selector, to_x: job.to_x, to_y: job.to_y, duration: job.duration }); break;
      default: throw new Error('Unknown action: ' + action);
    }
  } catch (e) { result = { ok: false, error: e.message }; }
  // deliver result back to bridge
  try {
    await fetch(`${BRIDGE_URL}/result`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, result }) });
  } catch {}
  return result;
}

// --- MV3-safe poll loop ---
// Service workers get killed after ~30s idle, which would silently kill AI control.
// Fix: (1) one in-flight long-poll fetch keeps the worker alive while waiting,
//      (2) chrome.alarms re-kicks the loop if the worker was suspended,
//      (3) any incoming message also re-kicks it.
let polling = false;

async function pollOnce() {
  try {
    const res = await fetch(`${BRIDGE_URL}/poll`);
    if (res.status === 200) {
      const job = await res.json();
      if (job?.action) handleJob(job); // async — don't block next poll
    }
    // 204 = no job; loop continues immediately
  } catch {
    // bridge not running — back off
    await new Promise(r => setTimeout(r, 3000));
  }
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (true) {
    try { await pollOnce(); } catch {}
  }
}
// re-kick entry points
chrome.alarms?.create('attk-poll', { periodInMinutes: 0.5 });
chrome.alarms?.onAlarm?.addListener(a => { if (a.name === 'attk-poll') pollLoop(); });
chrome.runtime.onStartup?.addListener?.(() => setTimeout(pollLoop, 800));
setTimeout(pollLoop, 1200);
// also re-kick whenever the popup or anything messages us
chrome.runtime.onMessage.addListener(() => { pollLoop(); });

// also handle direct messages (popup + external)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === 'CAPTURE_VISIBLE') {
        const dataUrl = await chrome.tabs.captureVisibleTab({ format: msg.format || 'png', quality: msg.quality ?? 92 });
        return sendResponse({ ok: true, dataUrl });
      }
      if (msg.type === 'MCP' || msg.mcp) {
        const cmd = msg.mcp || msg;
        const action = cmd.action || cmd.tool;
        const job = { id: Date.now(), action, ...cmd };
        // normalize
        const map = { click:'click', click_xy:'click_xy', move:'move', type:'type', key:'key', scroll:'scroll', som:'som', hide_cursor:'hide_cursor', get_text:'get_text', get_html:'get_html', get_stats:'get_stats', query:'query', snapshot:'snapshot', screenshot:'screenshot', navigate:'navigate' };
        job.action = map[action] || action;
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

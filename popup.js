// popup.js — lightweight status & tab manager for Specter
let currentTargetId = null;

const BRIDGE_PORTS = [8765, 8766, 8767, 8768];
let cachedBridgeUrl = null;
let cachedBridgeAt = 0;
const BRIDGE_CACHE_MS = 10000;

async function getBridgeUrl() {
  if (cachedBridgeUrl && Date.now() - cachedBridgeAt < BRIDGE_CACHE_MS) {
    try {
      const probe = await fetch(`${cachedBridgeUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (probe.ok) {
        const d = await probe.json().catch(() => null);
        if (d?.ok) return cachedBridgeUrl;
      }
    } catch {}
    cachedBridgeUrl = null;
  }
  for (const p of BRIDGE_PORTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/health`, { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.ok) {
          cachedBridgeUrl = `http://127.0.0.1:${p}`;
          cachedBridgeAt = Date.now();
          const portTag = document.querySelector('.port-tag');
          if (portTag) portTag.textContent = `127.0.0.1:${p}`;
          return cachedBridgeUrl;
        }
      }
    } catch {}
  }
  const fallback = cachedBridgeUrl || `http://127.0.0.1:${BRIDGE_PORTS[0]}`;
  const portTag = document.querySelector('.port-tag');
  if (portTag) {
    try {
      const u = new URL(fallback);
      portTag.textContent = u.host;
    } catch {
      portTag.textContent = fallback.replace(/^https?:\/\//, '');
    }
  }
  return fallback;
}

async function updateUI() {
  // Get background info
  chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'list_tabs' } }, (res) => {
    if (chrome.runtime.lastError || !res?.ok || !res?.result?.tabs) return;
    const { targetTabId, tabs } = res.result;
    currentTargetId = targetTabId;

    const lockBtn = document.getElementById('btn-toggle-lock');
    const btnIcon = lockBtn?.querySelector('.btn-icon');
    const btnText = lockBtn?.querySelector('.btn-text');
    const targetTab = tabs.find(t => t.id === targetTabId);

    if (targetTab) {
      document.getElementById('target-id').textContent = `#${targetTab.id}`;
      document.getElementById('target-title').textContent = targetTab.title || 'Untitled Tab';
      document.getElementById('target-url').textContent = targetTab.url || '—';
      document.getElementById('target-url').title = targetTab.url || '';

      // Update Button to Unlock
      if (btnIcon) btnIcon.textContent = '🔓';
      if (btnText) btnText.textContent = 'Unlock Tab';
      lockBtn.className = 'btn btn-danger';
    } else {
      document.getElementById('target-id').textContent = '—';
      document.getElementById('target-title').textContent = 'No tab locked';
      document.getElementById('target-url').textContent = 'Click Lock to attach';
      document.getElementById('target-url').title = '';

      // Update Button to Lock
      if (btnIcon) btnIcon.textContent = '🎯';
      if (btnText) btnText.textContent = 'Lock Current Tab';
      lockBtn.className = 'btn btn-primary';
    }
  });
}

function setStatus(msg, ms = 2500) {
  const el = document.getElementById('status');
  if (!el) return;
  el.textContent = msg;
  if (ms) {
    setTimeout(() => {
      if (el.textContent === msg) el.textContent = 'Ready';
    }, ms);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  updateUI();

  // Toggle Lock/Unlock Button
  document.getElementById('btn-toggle-lock').addEventListener('click', async () => {
    if (currentTargetId) {
      chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'switch_tab', tabId: null } }, () => {
        if (chrome.runtime.lastError) {
          setStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }
        setStatus('Unlocked target');
        currentTargetId = null;
        updateUI();
      });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        setStatus('No active tab found');
        return;
      }
      chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'switch_tab', tabId: tab.id, focusWindow: false } }, () => {
        if (chrome.runtime.lastError) {
          setStatus('Error: ' + chrome.runtime.lastError.message);
          return;
        }
        setStatus('Locked to Specter group');
        currentTargetId = tab.id;
        updateUI();
      });
    }
  });

  // Group the current tab for visual organization. This never changes the
  // locked automation target.
  document.getElementById('btn-add-group').addEventListener('click', async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) {
      setStatus('No active tab found');
      return;
    }
    chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'add_to_group' } }, () => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      setStatus('Added and selected current tab');
      updateUI();
    });
  });

  // Focus Worker Tab (including window focus)
  document.getElementById('btn-highlight-target').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'list_tabs' } }, (res) => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      const targetId = res?.result?.targetTabId;
      if (targetId) {
        chrome.tabs.get(targetId, (tab) => {
          if (chrome.runtime.lastError || !tab) {
            setStatus('Target tab closed');
            return;
          }
          chrome.tabs.update(targetId, { active: true });
          if (tab.windowId) {
            chrome.windows.update(tab.windowId, { focused: true });
          }
          setStatus('Focused worker tab');
        });
      } else {
        setStatus('No target tab set');
      }
    });
  });

  // Toggle Numbers (SOM)
  document.getElementById('btn-toggle-som').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'som' } }, () => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      setStatus('Toggled SOM numbers');
    });
  });

  // Copy Target URL
  document.getElementById('btn-copy-url').addEventListener('click', async () => {
    const urlEl = document.getElementById('target-url');
    const url = urlEl?.title || urlEl?.textContent;
    if (url && url !== '—' && !url.startsWith('Click Lock')) {
      try {
        await navigator.clipboard.writeText(url);
        setStatus('Copied URL');
      } catch (e) {
        setStatus('Copy failed');
      }
    }
  });
});

// popup.js — lightweight status & tab manager for Specter
let currentTargetId = null;

async function updateUI() {
  // Check Bridge status
  try {
    const controller = new AbortController();
    const _to = setTimeout(() => controller.abort(), 1000);
    let res;
    try {
      res = await fetch('http://127.0.0.1:8765/health', { signal: controller.signal });
    } finally {
      clearTimeout(_to);
    }
    const data = await res.json();
    const badge = document.getElementById('bridge-badge');
    const label = badge?.querySelector('.status-label');
    if (data.ok) {
      badge.className = 'status-pill online';
      if (label) label.textContent = data.polling ? 'Active' : 'Connected';
    } else {
      badge.className = 'status-pill offline';
      if (label) label.textContent = 'Error';
    }
  } catch {
    const badge = document.getElementById('bridge-badge');
    const label = badge?.querySelector('.status-label');
    if (badge) badge.className = 'status-pill offline';
    if (label) label.textContent = 'Offline';
  }

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

  // Create New Dedicated Worker Tab
  document.getElementById('btn-create-worker').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MCP', source: 'popup', mcp: { action: 'new_tab', url: 'https://google.com', active: false } }, () => {
      if (chrome.runtime.lastError) {
        setStatus('Error: ' + chrome.runtime.lastError.message);
        return;
      }
      setStatus('Created worker tab');
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

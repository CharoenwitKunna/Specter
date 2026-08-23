// popup.js — lightweight status & tab manager for AI Worker
let currentTargetId = null;

async function updateUI() {
  // Check Bridge status
  try {
    const controller = new AbortController();
    const _to = setTimeout(() => controller.abort(), 1000);
    let res;
    try { res = await fetch('http://127.0.0.1:8765/health', { signal: controller.signal }); } finally { clearTimeout(_to); }
    const data = await res.json();
    const badge = document.getElementById('bridge-badge');
    if (data.ok) {
      badge.textContent = data.polling ? 'Bridge: Active (Connected)' : 'Bridge: Active (Waiting)';
      badge.className = 'badge online';
    } else {
      badge.textContent = 'Bridge: Error';
      badge.className = 'badge offline';
    }
  } catch {
    const badge = document.getElementById('bridge-badge');
    badge.textContent = 'Bridge: Offline';
    badge.className = 'badge offline';
  }

  // Get background info
  chrome.runtime.sendMessage({ type: 'MCP', mcp: { action: 'list_tabs' } }, (res) => {
    if (chrome.runtime.lastError || !res?.ok || !res?.result?.tabs) return;
    const { targetTabId, tabs } = res.result;
    currentTargetId = targetTabId;

    const lockBtn = document.getElementById('btn-toggle-lock');
    const targetTab = tabs.find(t => t.id === targetTabId);

    if (targetTab) {
      document.getElementById('target-id').textContent = `ID: ${targetTab.id}`;
      document.getElementById('target-title').textContent = targetTab.title || 'Untitled Tab';
      document.getElementById('target-url').textContent = targetTab.url || '—';
      document.getElementById('target-url').title = targetTab.url || '';
      
      // Update Button to Unlock
      lockBtn.textContent = '🔓 Unlock Tab';
      lockBtn.className = 'btn danger';
    } else {
      const activeTab = tabs.find(t => t.active);
      document.getElementById('target-id').textContent = '—';
      document.getElementById('target-title').textContent = 'No tab locked';
      document.getElementById('target-url').textContent = activeTab ? `Current: ${activeTab.title?.slice(0, 30)}...` : 'Click Lock to attach';
      
      // Update Button to Lock
      lockBtn.textContent = '🎯 Lock Current Tab';
      lockBtn.className = 'btn primary';
    }
  });
}

function setStatus(msg, ms = 2000) {
  const el = document.getElementById('status');
  el.textContent = msg;
  if (ms) setTimeout(() => { if (el.textContent === msg) el.textContent = 'Ready'; }, ms);
}

document.addEventListener('DOMContentLoaded', () => {
  updateUI();

  // Toggle Lock/Unlock Button
  document.getElementById('btn-toggle-lock').addEventListener('click', async () => {
    if (currentTargetId) {
      const idToUnlock = currentTargetId;
      chrome.runtime.sendMessage({ type: 'MCP', mcp: { action: 'switch_tab', tabId: null } }, async () => {
        if (chrome.runtime.lastError) { setStatus('Error: ' + chrome.runtime.lastError.message); return; }
        try { await chrome.tabs.ungroup(idToUnlock); } catch {}
        setStatus('Unlocked tab & removed group');
        currentTargetId = null;
        updateUI();
      });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      chrome.runtime.sendMessage({ type: 'MCP', mcp: { action: 'switch_tab', tabId: tab.id, focusWindow: false } }, () => {
        if (chrome.runtime.lastError) { setStatus('Error: ' + chrome.runtime.lastError.message); return; }
        setStatus('Locked tab & added to AI Worker!');
        currentTargetId = tab.id;
        updateUI();
      });
    }
  });

  // Create New Dedicated Worker Tab
  document.getElementById('btn-create-worker').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MCP', mcp: { action: 'new_tab', url: 'https://google.com', active: false } }, () => {
      if (chrome.runtime.lastError) { setStatus('Error: ' + chrome.runtime.lastError.message); return; }
      setStatus('Created worker tab!');
      updateUI();
    });
  });

  // Focus Worker Tab
  document.getElementById('btn-highlight-target').addEventListener('click', async () => {
    chrome.runtime.sendMessage({ type: 'MCP', mcp: { action: 'list_tabs' } }, (res) => {
      if (chrome.runtime.lastError) { setStatus('Error: ' + chrome.runtime.lastError.message); return; }
      const targetId = res?.result?.targetTabId;
      if (targetId) {
        chrome.tabs.update(targetId, { active: true });
        setStatus('Focused target tab');
      } else {
        setStatus('No target tab set');
      }
    });
  });

  // Toggle Numbers (SOM)
  document.getElementById('btn-toggle-som').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'MCP', mcp: { action: 'som' } }, () => {
      if (chrome.runtime.lastError) { setStatus('Error: ' + chrome.runtime.lastError.message); return; }
      setStatus('Toggled SOM numbers');
    });
  });

  // Copy Target URL
  document.getElementById('btn-copy-url').addEventListener('click', async () => {
    const url = document.getElementById('target-url').textContent;
    if (url && url !== '—' && !url.startsWith('Current:')) {
      try { await navigator.clipboard.writeText(url); setStatus('Copied URL'); } catch (e) { setStatus('Copy failed: ' + (e?.message || e)); }
    }
  });
});

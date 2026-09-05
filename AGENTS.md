# AGENTS.md

Instructions and operational constraints for AI agents interacting with or developing Specter.

---

## Project Overview

Specter is a background browser automation system composed of:
1. **Manifest V3 Chrome Extension** (`manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.js`)
2. **MCP Bridge** (`mcp-bridge/bridge.js` running on Node.js, default port `8765`)

The system enables LLM agents to inspect and drive browser tabs with a visible ghost cursor and zero user-focus disruption.

---

## Architecture & Communication Flow

```
Agent (Claude / LLM / Hermes)
      │ (MCP stdio or HTTP POST /tool)
      ▼
mcp-bridge (Node.js :8765)
      │ (WSS /ws heartbeat + ACKs; HTTP /poll and POST /result fallback)
      ▼
background.js (Chrome MV3 Service Worker)
      │ (chrome.scripting.executeScript / chrome.tabs.sendMessage)
      ▼
content.js (Injected into active/target tab)
```

---

## Key Agent Rules & Constraints

### 1. Process Management
- **Never kill `node.exe` globally** (`taskkill /F /IM node.exe`). Only kill the specific bridge PID to avoid terminating unrelated agent or system runtimes.
- Bridge defaults to port `8765` (configurable via `PORT` env var).

### 2. Tab Isolation & User Ergonomics
- Always respect the target tab lock stored in `chrome.storage.session`.
- Agent tabs must remain grouped inside the green `[👻 Specter]` tab group.
- Do not focus or foreground the browser window when performing background actions.

### 3. DOM & Interaction Guidelines
- **Input on modern web frameworks (React/Vue/Angular)**: Use standard prototype setter bypass (`Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val)`) followed by `input` and `change` event dispatches.
- **Mouse clicks**: Always trigger the full event chain (`pointerdown` -> `mousedown` -> `pointerup` -> `mouseup` -> `click`).
- **Shadow DOM**: Content scripts must traverse open shadow roots using recursive `shadowRoot` tree walkers.
- **Dynamic Scrolling**: Use `waitForScrollEnd` or check `in_viewport` flags from `tab_snapshot` before clicking elements.

### 4. Security & Endpoints
- Restricted URLs (`chrome://`, `edge://`, `chrome-extension://`, `about:`, `file:`) are strictly forbidden and guarded.
- All bridge requests have a 1MB payload cap and standard JSON error response contracts (`400`, `404`, `413`, `429`, `503`).

---

## Available MCP / HTTP Tools

| Tool | Parameters | Function |
|---|---|---|
| `tab_navigate` | `url` | Navigate current target tab |
| `tab_new` | `url`, `active` | Open a new tab in the Specter group and move the target lock to it (`active:false` keeps it backgrounded) |
| `tab_close` | `tabId` (optional) | Close tab |
| `tab_list` | — | List all open tabs |
| `tab_switch` | `tabId` | Switch target tab focus |
| `tab_snapshot` | — | Extract numbered DOM elements with coordinates and selectors |
| `tab_query` | `selector` | Query specific elements by CSS |
| `tab_eval` | `code` | Execute JavaScript in target tab |
| `tab_get_text` | `selector` (optional) | Extract text content |
| `tab_get_html` | `selector` (optional) | Extract raw HTML |
| `tab_stats` | — | Page title, URL, viewport dimensions, ready state |
| `tab_screenshot` | `quality` (optional) | Capture viewport screenshot |
| `tab_scroll_into_view`| `selector` or `snapshotId` | Scroll element into visible area |
| `click` | `selector`, `snapshotId`, or `x`/`y`, `button`, `clickCount` | Click with ghost cursor animation |
| `type` | `text`, `selector`, `clear` | Type into input/textarea |
| `key` | `key`, `code`, `modifiers` | Dispatch keyboard event |
| `scroll` | `direction`, `amount`, `selector` | Scroll viewport or container |
| `drag` | `from`, `to`, `duration` | Smooth drag and drop glide |
| `wait` | `ms` | Delay bridge execution |

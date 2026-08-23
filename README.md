# Specter

Ghost-cursor browser automation for AI agents. Chrome extension + MCP server that lets any LLM see and drive a real browser tab — with a visible ghost cursor, silent background execution, and zero focus stealing.

```
┌──────────────┐   MCP / HTTP    ┌─────────────────┐   chrome.*    ┌──────────────┐
│  AI Agent    │ ──────────────> │  mcp-bridge     │ ────────────> │  Specter ext │
│ (Claude, etc)│ <────────────── │  (Node, :8765)  │ <──────────── │  (MV3)       │
└──────────────┘                 └─────────────────┘               └──────────────┘
                                                                        │
                                                                        ▼
                                                                  [👻 Specter] tab
```

## How it works

1. The Node bridge (`mcp-bridge/bridge.js`) exposes MCP stdio **and** an HTTP JSON API on `127.0.0.1:8765`.
2. The extension's service worker long-polls the bridge, executes jobs in the active tab via `chrome.scripting`, and posts results back.
3. Agent-owned tabs are grouped under a green `[👻 Specter]` tab group so you always know what it's touching. You keep browsing — YouTube keeps playing.

## Tools

| Tool | Description |
|------|-------------|
| `tab_navigate` | Navigate target tab to a URL |
| `tab_new` / `tab_close` | Open / close tabs (background by default) |
| `tab_list` / `tab_switch` | Enumerate tabs, retarget the worker |
| `tab_snapshot` | Structured element map: ids, selectors, rects, `in_viewport` flag |
| `tab_query` | CSS query with rects and generated selectors |
| `tab_eval` | Run JavaScript in the page, get the result back |
| `tab_get_text` / `tab_get_html` / `tab_stats` | Page content extraction |
| `tab_screenshot` | Visible-tab capture (MCP image block for vision models) |
| `click` | By selector, snapshot id, or x/y — right/double supported |
| `type` / `key` | Framework-safe typing (React/Vue setter bypass), key events |
| `scroll` | Pixel scroll or scroll-into-view |
| `drag` | Press → eased glide → release, selector or coordinates |
| `wait` | Sleep between actions |

Selectors pierce open shadow roots; elements below the fold are auto-scrolled into view before interaction.

## Setup

**Bridge:**
```bash
cd mcp-bridge
npm install
node bridge.js
```

**Extension:** load this folder as an unpacked extension at `chrome://extensions` (Developer mode → Load unpacked).

**Claude Desktop / any MCP client:**
```json
{
  "mcpServers": {
    "specter": {
      "command": "node",
      "args": ["C:/path/to/BrowerExtension/mcp-bridge/bridge.js"]
    }
  }
}
```

**HTTP (curl or any agent runtime):**
```bash
curl -X POST http://127.0.0.1:8765/tool \
  -H 'Content-Type: application/json' \
  -d '{"tool":"click","args":{"selector":"button.submit"}}'
```

## Notes

- Target tab is persisted across service-worker suspensions (`chrome.storage.session`).
- New tabs open silently in the Specter group — your focused tab never changes.
- Restricted pages (`chrome://`, `edge://`) are rejected cleanly.

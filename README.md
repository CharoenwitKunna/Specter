# Specter

[![M8ven Score](https://m8ven.ai/badge/mcp/charoenwitkunna-specter-tc1rph)](https://m8ven.ai/mcp/charoenwitkunna-specter-tc1rph)

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
2. The extension connects to the bridge over a local WSS fast path (`wss://127.0.0.1:8766/ws` by default, or `SPECTER_WSS_PORT`) when available, with HTTP long-polling as a compatibility fallback. WSS uses application heartbeat and job ACKs; accepted jobs are requeued on disconnect and the extension stops polling while WSS is healthy. It executes jobs in the target tab via `chrome.scripting` and posts results back.
3. Agent-owned tabs are grouped under a green `[👻 Specter]` tab group so you always know what it's touching. You keep browsing — YouTube keeps playing.

## Tools

| Tool | Description |
|------|-------------|
| `tab_navigate` | Navigate target tab to a URL |
| `tab_new` / `tab_close` | Open / close tabs (background by default) |
| `tab_list` / `tab_switch` | Enumerate tabs, retarget the worker |
| `tab_snapshot` | Structured element map: ids, selectors, rects, `in_viewport` flag |
| `tab_find` | Find visible elements by text, accessible label, placeholder, title, or role |
| `tab_visual_snapshot` | Screenshot plus semantic element metadata for visual fallback |
| `tab_eval` | Run JavaScript in the page (requires explicit `allowEval: true` consent) |
| `tab_get_text` / `tab_get_html` / `tab_stats` | Page content extraction |
| `tab_screenshot` | Visible-tab capture (MCP image block for vision models) |
| `click` | By selector, snapshot id, or x/y — right/double supported |
| `type` / `key` | Framework-safe typing (React/Vue setter bypass), key events |
| `scroll` | Pixel scroll or scroll-into-view |
| `drag` | Press → eased glide → release, selector or coordinates |
| `wait_for_network_idle` | Wait until in-flight fetch and XHR network requests settle (zero active requests for idleMs) |
| `tab_console_logs` | Retrieve buffered console logs (`error`, `warn`, `info`, uncaught exceptions) |
| `batch_actions` | Run up to 50 safe DOM/browser actions sequentially on the locked target; returns per-action results and stops on failure by default (`stopOnError:false` continues). |
| `wait` | Sleep between actions (server-side `ms` delay; no tab round-trip — port `ATTK_PORT` on bridge, default 8765). MCP/HTTP `wait` avoids polling timeout. |

Selectors pierce open shadow roots; elements below the fold are auto-scrolled into view before interaction.

### Batch actions

`batch_actions` accepts an ordered `actions` array whose entries use the individual tool shape, for example `{ "tool": "click", "args": { "selector": "button.next" } }`. It supports inspection and interaction tools (`tab_snapshot`, `tab_find`, `tab_get_text`, `tab_get_html`, `tab_stats`, `click`, `type`, `key`, `scroll`, `drag`, `wait`, and `wait_for`). Every action runs serially against the persisted target tab and keeps its `frameId` when supplied. Tab switching/creation/closing, navigation, screenshots, and unrestricted `tab_eval` are intentionally rejected inside a batch. Results contain an entry for every action plus `stopped`/`stoppedAt`; actions not reached after a stop are marked `skipped:true`. Set `stopOnError:false` (or `continueOnError:true`) to run all actions after failures.

```json
{"tool":"batch_actions","args":{"stopOnError":true,"actions":[
  {"tool":"click","args":{"selector":"button.open"}},
  {"tool":"wait_for","args":{"selector":".dialog"}},
  {"tool":"type","args":{"selector":"input[name=q]","text":"specter"}},
  {"tool":"key","args":{"key":"Enter"}}
]}}
```

## Setup

**Bridge (Windows):**
```bash
cd mcp-bridge
npm install
node bridge.js
```

The bridge generates a self-signed localhost certificate in `mcp-bridge/certs/` for WSS. Chrome may require the generated certificate to be trusted in the local certificate store; otherwise the extension automatically continues using the HTTP polling fallback. WSS reconnects with bounded exponential backoff; HTTP queue capacity is bounded to 100 jobs/16 MiB (200 total pending calls), with 429/503 responses when saturated.
or double-click `start.bat`.

**Extension:** load this folder as an unpacked extension at `chrome://extensions` (Developer mode → Load unpacked).

**Claude Desktop / any MCP client:**
```json
{
  "mcpServers": {
    "specter": {
      "command": "node",
      "args": ["C:/path/to/Specter/mcp-bridge/bridge.js"]
    }
  }
}
```

**HTTP (curl or any agent runtime):**
```bash
curl -X POST http://127.0.0.1:8765/tool \
  -H 'Content-Type: application/json' \
  -H "X-Specter-Token: $(cat mcp-bridge/.specter-token)" \
  -d '{"tool":"click","args":{"selector":"button.submit"}}'
```

## Notes

- Target tab is persisted across service-worker suspensions (`chrome.storage.session`).
- Specter owns every tab in the green `👻 Specter` tab group. Actions never fall back to an unrelated active tab, and tabs outside the group are hidden from `tab_list`.
- When a tab is locked, it is exclusive: Specter cannot switch to or close any other tab, even one in the Specter group. Unlock first to choose another owned tab.
- `tab_new` creates a tab in the Specter group and atomically moves the target lock to it, so the agent can use the new tab immediately. Pass `active:false` to keep it in the background.
- Use **Add current tab to group** to add a tab. If no tab is locked, it becomes the target; an existing lock remains exclusive.
- Restricted pages (`chrome://`, `edge://`) are rejected cleanly.
- Content scripts inject on demand (PING-fail fallback) instead of every page you browse.

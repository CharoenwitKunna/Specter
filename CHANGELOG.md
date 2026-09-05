# Changelog

All notable changes to the Specter browser extension and MCP bridge are documented in this file.

## Unreleased

### Added
- Added standard `LICENSE` (MIT) file.
- Added verified M8ven Trust Index badge to README.
- Added explicit tool safety annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) across all 26 MCP tools in `bridge.js` to meet M8ven and MCP client catalog specifications.
- Added contract test verifying all 26 tools declare all 4 hints.

### Fixed
- Fixed Content Security Policy (CSP) blocking inline telemetry scripts on strict pages by injecting MAIN-world probes via `chrome.scripting.executeScript`.
- Authenticated extension telemetry messages using a generated per-session postMessage token (`data-specter-telemetry-token`) to prevent message spoofing and cross-script races.
- Fixed network idle detection (`wait_for_network_idle`) race condition during page transitions by waiting on document `readyState` and properly clearing pending idle timers on active requests.
- Eliminated duplicate console logging between isolated content script and MAIN-world probe.
- Guarded XMLHttpRequest tracking state with reuse safety checks (`__sp_done`).

### Added
- Added the safe `batch_actions` MCP/HTTP tool for up to 50 serialized DOM interactions against the persisted target tab, with per-action results and configurable stop/continue behavior. Target-changing operations, screenshots, downloads, and unrestricted eval are rejected inside batches.
- Preserved explicit `frameId` routing across batched inspection and interaction actions.
- Hardened the WSS fast path with application heartbeat, job/result ACKs, bounded exponential reconnect backoff, and replay-safe result caching.

### Reliability
- WSS-dispatched jobs are requeued on disconnect or ACK timeout and fail over to HTTP polling; polling is stopped while WSS is healthy.
- Added pending job/byte bounds and exposed WSS/queue state through `/health`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.2.1] - 2026-08-23

### Security & Hardening
- **Bridge Auth**: Added auto-generated bearer token authentication (`mcp-bridge/.specter-token`) for `/tool` HTTP endpoint via `X-Specter-Token` header.
- **CORS Restricted**: Replaced wildcard CORS with strict origin checking.
- **Payload Limits**: Added 1MB request body size cap to prevent memory exhaustion (returns `413 Payload Too Large`).
- **Input Validation**: Added URL validation restricting navigation to `http:` and `https:`, and validated integer ranges for `wait` delays (0–30,000ms).
- **Extension CSP**: Hardened extension page Content Security Policy in `manifest.json` (`script-src 'self'; object-src 'none'; base-uri 'none'`).

### Bridge Improvements
- Added `/health` endpoint returning server uptime, version, and pending job count.
- Standardized HTTP error responses (`400`, `404`, `413`, `429`, `503`) with structured JSON bodies.
- Implemented queue rate-limiting and backpressure caps (100 -> 429 Too Many Requests, 200 -> 503 Service Unavailable).
- Fixed potential memory leak in `waitingCalls` during timeout cleanup.
- Improved port validation and explicit `EADDRINUSE` handling.
- Optimized polling timeouts (poll wait 25s, enqueue timeout 35s).
- Added `mcp-bridge/start.sh` for Unix/macOS environments.

### Background Service Worker
- Fixed poll loop error recovery using `AbortSignal.timeout` and structured `finally` cleanup.
- Merged duplicate `chrome.runtime.onMessage` listeners into a single dispatcher.
- Improved keep-alive alarms with explicit clear + recreate logic (1-minute period).
- Enhanced URL safety checks (`isAllowedUrl` / `isRestrictedUrl`) preventing accidental access to `chrome://`, `edge://`, and file URLs.
- Screenshot captures now validate target `windowId` and guard against restricted internal pages.

### Content Script & Interaction Engine
- **Pointer Events**: Upgraded synthetic mouse interactions to standard `PointerEvent` sequence (`pointerdown` -> `mousedown` -> `pointerup` -> `mouseup` -> `click`).
- **React / Vue Input Compatibility**: Improved `setNativeValue` using prototype descriptor chain (`Object.getPrototypeOf`) to ensure controlled inputs update cleanly without synthetic event drops.
- **Typing Engine**: Added support for `<select>` value changes and improved `Range` / `InputEvent` dispatching.
- **Shadow DOM**: Unified root-walking traversal to seamlessly query across open shadow DOM boundaries.
- **Smooth Scrolling**: Added `waitForScrollEnd` to wait for DOM scroll settlement before dispatching clicks or snapshot captures.
- **CSS Selector Generator**: Enhanced selector path generation for SVG elements and capped traversal depth to 8 levels for optimal query performance.
- **SOM & Highlighting**: Added automatic cleanup timer (`somTimer`) for numbered overlays and wrapped highlight operations in `try...finally`.

### UI & Popup
- Updated extension icons with clean, transparent RGBA PNGs (16x16, 32x32, 48x48, 128x128).
- Fixed popup flexbox layout clipping on small screens (`min-width: 0`, `overflow: hidden`, odd grid-item spanning).
- Added fallback handling for clipboard operations and runtime errors in popup.

---

## [1.2.0] - 2026-08-23

### Added
- Initial release of **Specter**: Ghost-cursor browser automation & MCP bridge for AI agents.
- **Manifest V3 Extension**: Lightweight Chrome extension with on-demand content script injection and zero persistent performance overhead.
- **MCP Bridge (`mcp-bridge/bridge.js`)**: Dual-mode bridge providing both Model Context Protocol (stdio) and HTTP JSON API on `127.0.0.1:8765`.
- **19 Typed Agent Tools**:
  - Tab Management: `tab_navigate`, `tab_new`, `tab_close`, `tab_list`, `tab_switch`.
  - DOM & Inspection: `tab_snapshot`, `tab_query`, `tab_eval`, `tab_get_text`, `tab_get_html`, `tab_stats`.
  - Visuals: `tab_screenshot` (MCP image blocks for vision models).
  - Actions: `click`, `type`, `key`, `scroll`, `drag`, `tab_scroll_into_view`, `wait`.
- **Ghost Cursor Engine**: Visual glide cursor overlay, element highlight halos, and click ripple effects showing real-time agent intent without moving the OS mouse.
- **Tab Group Isolation**: Automatic placement of agent-controlled tabs in a dedicated green `[👻 Specter]` tab group to prevent interference with user browsing.
- **Persistent Tab Targeting**: Target tab lock maintained across background worker lifecycle using `chrome.storage.session`.

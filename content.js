// content.js — Active Tab Toolkit (computer_use-style ghost cursor)
(() => {
  if (window.__attk_injected) return;
  window.__attk_injected = true;

  // --- Network Idle Tracking ---
  let activeNetworkRequests = 0;
  const networkIdleWaiters = new Set();

  function onRequestStarted() {
    activeNetworkRequests++;
  }

  function onRequestFinished() {
    activeNetworkRequests = Math.max(0, activeNetworkRequests - 1);
    if (activeNetworkRequests === 0) {
      for (const waiter of networkIdleWaiters) {
        waiter.check();
      }
    }
  }

  // --- Main-world Telemetry Bridge ---
  // In MV3, window.fetch, window.XMLHttpRequest, and page console.error occur in
  // the 'MAIN' execution world. We use a secure per-instance token so rogue page
  // scripts cannot forge telemetry messages.
  const TELEMETRY_MSG_TYPE = '__SPECTER_TELEMETRY__';
  const TELEMETRY_TOKEN = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  try {
    document.documentElement.setAttribute('data-specter-telemetry-token', TELEMETRY_TOKEN);
  } catch {}

  function setupMainWorldTelemetry() {
    // Listen for telemetry events dispatched from the page's MAIN world with matching token
    window.addEventListener('message', (event) => {
      if (event.source !== window || !event.data || event.data.type !== TELEMETRY_MSG_TYPE) return;
      if (event.data.token !== TELEMETRY_TOKEN) return;
      const { subType, payload } = event.data;
      if (subType === 'req_start') {
        onRequestStarted();
      } else if (subType === 'req_finish') {
        onRequestFinished();
      } else if (subType === 'console') {
        recordConsoleEntry(payload.level, [payload.text]);
      }
    });

    // Fallback inline script injection for MAIN world if scripting.executeScript hasn't run yet
    try {
      const probeScript = document.createElement('script');
      probeScript.setAttribute('data-attk-internal', 'true');
      probeScript.textContent = `(${function(tok) {
        if (window.__specter_probe_installed) return;
        window.__specter_probe_installed = true;
        const MSG_TYPE = '__SPECTER_TELEMETRY__';
        const post = (subType, payload = null) => {
          try { window.postMessage({ type: MSG_TYPE, token: tok, subType, payload }, '*'); } catch {}
        };

        // 1. Fetch interception
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

        // 2. XHR interception
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

        // 3. Console & Error interception
        function safeStr(val) {
          if (val === null || val === undefined) return String(val);
          if (typeof val === 'string') return val;
          if (val instanceof Error) return (val.name || 'Error') + ': ' + (val.message || '') + (val.stack ? '\\n' + val.stack : '');
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
      }}('${TELEMETRY_TOKEN}');`;
      (document.head || document.documentElement).appendChild(probeScript);
      probeScript.remove();
    } catch {}
  }

  setupMainWorldTelemetry();

  function waitForNetworkIdle(idleMs = 500, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const startTime = performance.now();
      const deadline = startTime + Math.min(Math.max(100, timeoutMs), 60000);
      let idleTimer = null;
      let settled = false;

      const finish = (timedOut = false) => {
        if (settled) return;
        settled = true;
        if (idleTimer) clearTimeout(idleTimer);
        networkIdleWaiters.delete(waiter);
        const duration = Math.round(performance.now() - startTime);
        resolve({
          ok: !timedOut,
          waitedMs: duration,
          inFlight: activeNetworkRequests,
          timedOut
        });
      };

      const isDocumentReady = () => document.readyState === 'complete' || document.readyState === 'interactive';

      const waiter = {
        check() {
          if (settled) return;
          if (activeNetworkRequests === 0 && isDocumentReady()) {
            if (!idleTimer) {
              idleTimer = setTimeout(() => finish(false), idleMs);
            }
          } else {
            if (idleTimer) {
              clearTimeout(idleTimer);
              idleTimer = null;
            }
          }
        }
      };

      networkIdleWaiters.add(waiter);
      const maxTimer = setTimeout(() => finish(true), Math.max(0, deadline - performance.now()));

      // Check if network is already idle and DOM is ready, or wait for readyState
      const tryInitialIdle = () => {
        if (activeNetworkRequests === 0 && isDocumentReady()) {
          idleTimer = setTimeout(() => {
            clearTimeout(maxTimer);
            finish(false);
          }, idleMs);
        }
      };

      if (!isDocumentReady()) {
        document.addEventListener('readystatechange', tryInitialIdle, { once: true });
      } else {
        tryInitialIdle();
      }
    });
  }

  // --- Console Logs & Error Telemetry ---
  const MAX_CONSOLE_LOGS = 100;
  const consoleLogBuffer = [];

  function safeSerialize(val) {
    if (val === null || val === undefined) return String(val);
    if (typeof val === 'string') return val;
    if (val instanceof Error) return `${val.name}: ${val.message}${val.stack ? '\n' + val.stack : ''}`;
    try {
      const seen = new WeakSet();
      return JSON.stringify(val, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          if (value instanceof HTMLElement) {
            const id = value.id ? `#${value.id}` : '';
            const cls = value.className && typeof value.className === 'string' ? `.${value.className.trim().split(/\s+/).join('.')}` : '';
            return `<${value.tagName.toLowerCase()}${id}${cls}>`;
          }
        }
        return value;
      });
    } catch {
      try {
        if (typeof val === 'object') {
          const summary = {};
          for (const k of ['message', 'name', 'status', 'code', 'data']) {
            if (val[k] !== undefined) summary[k] = val[k];
          }
          if (Object.keys(summary).length > 0) return JSON.stringify(summary);
        }
      } catch {}
      return String(val);
    }
  }

  function recordConsoleEntry(type, args) {
    const entry = {
      type,
      timestamp: Date.now(),
      text: args.map(safeSerialize).join(' ').slice(0, 2000)
    };
    consoleLogBuffer.push(entry);
    if (consoleLogBuffer.length > MAX_CONSOLE_LOGS) consoleLogBuffer.shift();
  }

  function getConsoleLogs(types = null, clear = false) {
    let logs = consoleLogBuffer;
    if (types && Array.isArray(types) && types.length > 0) {
      const typeSet = new Set(types.map(t => String(t).toLowerCase()));
      logs = logs.filter(l => typeSet.has(l.type));
    }
    const result = [...logs];
    if (clear) {
      consoleLogBuffer.length = 0;
    }
    return { ok: true, count: result.length, logs: result };
  }

  // CSS.escape polyfill for older pages / edge contexts where CSS is undefined
  if (typeof CSS === 'undefined' || !CSS.escape) {
    const _cssEscape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
    if (typeof CSS === 'undefined') {
      // eslint-disable-next-line no-global-assign
      self.CSS = { escape: _cssEscape };
    } else if (!CSS.escape) {
      CSS.escape = _cssEscape;
    }
  }

  // Keep overlay identifiers instance-local: pages occasionally use generic IDs
  // such as "activity" or "cursor" themselves.
  const overlayToken = Math.random().toString(36).slice(2, 10);
  const overlayId = role => `__attk-${role}-${overlayToken}`;
  const CURSOR_HOTSPOT = { x: 2, y: 2 };
  let cursorEl = null;
  let cursorFadeTimer = null;
  let activityEl = null;
  let activityHideTimer = null;
  let typingPreviewEl = null;
  let typingPreviewHideTimer = null;
  let typingPreviewAnchor = null;
  let styleEl = null;
  let highlightEl = null;
  let activeInputTagEl = null;
  let overlayRepositionFrame = null;
  let overlayResizeObserver = null;
  let typingQueue = Promise.resolve();

  function reducedMotion() {
    try { return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true; } catch { return false; }
  }

  function scrollBehavior() { return reducedMotion() ? 'instant' : 'smooth'; }

  function motionDelay(ms) { return reducedMotion() ? 0 : ms; }

  // DOM inspection is frequently requested in bursts (for example a snapshot
  // followed by find/query). Keep those reads cheap, but never retain a
  // result for long enough to make a detached element actionable. Mutation
  // and layout revisions are deliberately separate: scrolling changes rects,
  // while DOM changes can invalidate both selectors and query results.
  const DOM_QUERY_CACHE_MS = 200;
  const SNAPSHOT_CACHE_MS = 150;
  const SELECTOR_CACHE_MS = 500;
  const MAX_TRAVERSAL_ROOTS = 128;
  const MAX_TRAVERSAL_NODES = 20000;
  const MAX_TRAVERSAL_DEPTH = 16;
  let domRevision = 0;
  let layoutRevision = 0;
  let selectorCache = new WeakMap();
  let queryCache = new WeakMap();
  let snapshotCache = null;
  let cacheObserver = null;
  const observedRoots = new WeakSet();

  function invalidateDomCaches() {
    domRevision++;
    selectorCache = new WeakMap();
    queryCache = new WeakMap();
    snapshotCache = null;
  }

  function invalidateLayoutCaches() {
    layoutRevision++;
    snapshotCache = null;
  }

  function observeCacheRoot(root) {
    if (!cacheObserver || !root || observedRoots.has(root)) return;
    try {
      cacheObserver.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
      observedRoots.add(root);
    } catch {}
  }

  function installCacheInvalidation() {
    if (typeof MutationObserver === 'function') {
      try {
        const observer = new MutationObserver(records => {
          // Extension overlays are intentionally ignored. Their mutations do
          // not affect page selectors or page query results.
          if (records.length && records.every(record => {
            const target = record.target;
            // A highlighted page element is still a layout anchor, not an
            // extension overlay; observe its framework/layout mutations.
            if (target?.classList?.contains('__attk-hl')) return false;
            if (isInternalNode(target)) return true;
            if (record.type === 'childList') {
              const nodes = [...record.addedNodes, ...record.removedNodes];
              return nodes.length > 0 && nodes.every(isInternalNode);
            }
            return false;
          })) return;
          invalidateDomCaches();
          scheduleOverlayReposition();
        });
        cacheObserver = observer;
        observeCacheRoot(document);
      } catch {}
    }
    try {
      window.addEventListener('scroll', () => {
        invalidateLayoutCaches();
        if (typingPreviewEl || activeInputTagEl) scheduleOverlayReposition();
      }, { passive: true });
      document.addEventListener('scroll', () => {
        invalidateLayoutCaches();
        if (typingPreviewEl || activeInputTagEl) scheduleOverlayReposition();
      }, { capture: true, passive: true });
      window.addEventListener('resize', () => {
        invalidateLayoutCaches();
        if (typingPreviewEl || activeInputTagEl) scheduleOverlayReposition();
      }, { passive: true });
    } catch {}
  }

  // A per-operation context ensures each element has one geometry read and
  // one selector computation even when multiple response fields need them.
  function inspectionContext() {
    const rects = new WeakMap();
    const selectors = new WeakMap();
    return {
      rect(el) {
        if (!rects.has(el)) rects.set(el, el.getBoundingClientRect());
        return rects.get(el);
      },
      selector(el) {
        if (!selectors.has(el)) selectors.set(el, cssPath(el));
        return selectors.get(el);
      }
    };
  }

  // --- styles ---
  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = overlayId('style');
    styleEl.setAttribute('data-attk-role', 'style');
    styleEl.setAttribute('data-attk-internal', 'true');
    styleEl.textContent = `
      [data-attk-role="cursor"] {
        position: fixed;
        left: -100px;
        top: -100px;
        width: 28px;
        height: 28px;
        pointer-events: none !important;
        z-index: 2147483647;
        will-change: left, top, transform, opacity;
        filter: drop-shadow(0 2px 8px rgba(103,232,176,.7)) drop-shadow(0 0 16px rgba(103,232,176,.45));
        transition: left 520ms cubic-bezier(.2,.8,.2,1), top 520ms cubic-bezier(.2,.8,.2,1), transform 120ms ease, opacity 250ms ease;
        opacity: 1;
        contain: layout style paint;
      }
      [data-attk-role="cursor"].hidden {
        opacity: 0;
      }
      [data-attk-role="cursor"] .c-arrow {
        width: 28px;
        height: 28px;
        transform-origin: 2px 2px;
        transition: transform 120ms ease;
      }
      [data-attk-role="cursor"].clicking .c-arrow {
        transform: scale(.82);
      }
      [data-attk-role="ripple"] {
        position: fixed;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 2px solid #67e8b0;
        pointer-events: none !important;
        z-index: 2147483646;
        transform: translate(-50%,-50%) scale(.3);
        opacity: .9;
        animation: __attk-ripple .45s ease-out forwards;
      }
      @keyframes __attk-ripple {
        to { transform: translate(-50%,-50%) scale(1.8); opacity: 0; }
      }
      .__attk-hl {
        outline: 2px solid #67e8b0 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(103,232,176,.22) !important;
        transition: outline .15s;
      }
      [data-attk-role="activity"] {
        position: fixed;
        top: 16px;
        right: 18px;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 10px 7px 9px;
        color: #082017;
        background: #67e8b0;
        border: 1px solid rgba(255,255,255,.85);
        border-radius: 999px;
        box-shadow: 0 4px 18px rgba(8,32,23,.28), 0 0 18px rgba(103,232,176,.3);
        font: 700 11px/1 system-ui, -apple-system, sans-serif;
        pointer-events: none !important;
        z-index: 2147483647;
        animation: __attk-activity-in .18s ease-out;
      }
      [data-attk-role="activity"] .a-icon { font-size: 13px; }
      [data-attk-role="activity"] .a-dots { display: inline-flex; gap: 2px; align-items: end; height: 12px; }
      [data-attk-role="activity"] .a-dots i {
        display: block;
        width: 3px;
        height: 5px;
        border-radius: 2px;
        background: #082017;
        animation: __attk-key .72s ease-in-out infinite;
      }
      [data-attk-role="activity"] .a-dots i:nth-child(2) { animation-delay: .12s; }
      [data-attk-role="activity"] .a-dots i:nth-child(3) { animation-delay: .24s; }
      @keyframes __attk-key {
        0%, 100% { height: 5px; opacity: .45; }
        45% { height: 12px; opacity: 1; }
      }
      @keyframes __attk-activity-in {
        from { opacity: 0; transform: translateY(-5px) scale(.96); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        [data-attk-role], [data-attk-role] * {
          animation: none !important;
          transition: none !important;
        }
        [data-attk-role="ripple"] { display: none !important; }
        .__attk-input-tag, .__attk-hl { animation: none !important; transition: none !important; }
      }
      [data-attk-role="typing-preview"] {
        position: fixed;
        max-width: min(320px, calc(100vw - 24px));
        padding: 10px 13px;
        color: #f8fffc;
        /* Opaque fallback keeps text legible when backdrop-filter is unavailable. */
        background: #173d30;
        border: 1px solid rgba(255,255,255,.62);
        border-radius: 14px;
        box-shadow: inset 0 1px 0 rgba(255,255,255,.34), 0 8px 28px rgba(0,0,0,.28), 0 0 20px rgba(103,232,176,.22);
        font: 11px/1.35 system-ui, -apple-system, sans-serif;
      }
      @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        [data-attk-role="typing-preview"] {
          background: linear-gradient(135deg, rgba(255,255,255,.22), rgba(103,232,176,.10) 48%, rgba(8,32,23,.34));
          backdrop-filter: blur(16px) saturate(145%);
          -webkit-backdrop-filter: blur(16px) saturate(145%);
        }
      }
      [data-attk-role="typing-preview"] {
        pointer-events: none !important;
        z-index: 2147483647;
        animation: __attk-preview-in .16s ease-out;
      }
      [data-attk-role="typing-preview"]::before {
        content: '';
        position: absolute;
        top: 5px;
        left: 16px;
        right: 16px;
        height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,.7), transparent);
      }
      [data-attk-role="typing-preview"]::after {
        content: '';
        position: absolute;
        left: var(--attk-arrow-left, 18px);
        bottom: -7px;
        width: 12px;
        height: 12px;
        background: #2d5f4d;
        border-right: 1px solid rgba(255,255,255,.62);
        border-bottom: 1px solid rgba(255,255,255,.62);
        transform: rotate(45deg);
      }
      @supports ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
        [data-attk-role="typing-preview"]::after { backdrop-filter: blur(16px); }
      }
      [data-attk-role="typing-preview"].below::after {
        top: -7px;
        bottom: auto;
        transform: rotate(225deg);
      }
      [data-attk-role="typing-preview"] .p-text {
        overflow: hidden;
        display: block;
        color: #f8fffc;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      [data-attk-role="typing-preview"].typing-active .p-text::after {
        content: '';
        display: inline-block;
        width: 2px;
        height: 13px;
        margin-left: 5px;
        vertical-align: -2px;
        border-radius: 2px;
        background: #b8ffdc;
        animation: __attk-caret .72s step-end infinite;
      }
      @keyframes __attk-preview-in {
        from { opacity: 0; transform: translateY(4px) scale(.97); }
        to { opacity: 1; transform: translateY(0) scale(1); }
      }
      @keyframes __attk-caret {
        0%, 45% { opacity: 1; }
        46%, 100% { opacity: 0; }
      }
      .__attk-input-focused {
        outline: 2px solid #67e8b0 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(103,232,176,.35), 0 0 12px rgba(103,232,176,.5) !important;
        transition: box-shadow .2s ease, outline .2s ease !important;
      }
      .__attk-input-tag {
        position: fixed;
        background: #67e8b0;
        color: #082017;
        font: 700 10px/14px ui-monospace, SFMono-Regular, Consolas, sans-serif;
        padding: 2px 6px;
        border-radius: 4px;
        pointer-events: none !important;
        z-index: 2147483647;
        box-shadow: 0 2px 8px rgba(0,0,0,.4);
        opacity: 1;
        transition: opacity 200ms ease;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function showActivity(label = 'Typing') {
    ensureStyle();
    if (activityHideTimer) {
      clearTimeout(activityHideTimer);
      activityHideTimer = null;
    }
    if (!activityEl || !activityEl.isConnected) {
      activityEl = document.createElement('div');
      activityEl.id = overlayId('activity');
      activityEl.setAttribute('data-attk-role', 'activity');
      activityEl.setAttribute('data-attk-internal', 'true');
      activityEl.setAttribute('role', 'status');
      activityEl.setAttribute('aria-live', 'polite');
      activityEl.setAttribute('aria-atomic', 'true');
      (document.body || document.documentElement).appendChild(activityEl);
    }
    activityEl.replaceChildren();
    const icon = document.createElement('span');
    icon.className = 'a-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = '⌨';
    const labelEl = document.createElement('span');
    labelEl.textContent = String(label) + '...';
    const dots = document.createElement('span');
    dots.className = 'a-dots';
    dots.setAttribute('aria-hidden', 'true');
    dots.append(document.createElement('i'), document.createElement('i'), document.createElement('i'));
    activityEl.append(icon, labelEl, dots);
  }

  function hideActivity(delay = 500) {
    if (!activityEl) return;
    if (activityHideTimer) clearTimeout(activityHideTimer);
    activityHideTimer = setTimeout(() => {
      activityEl?.remove();
      activityEl = null;
      activityHideTimer = null;
    }, motionDelay(delay));
  }

  function renderTypingPreview(text, active = false) {
    if (!typingPreviewEl) return;
    typingPreviewEl.classList.toggle('typing-active', active);
    typingPreviewEl.classList.toggle('typing-preparing', !active);
    typingPreviewEl.dataset.phase = active ? 'active' : 'preparing';
    const textEl = document.createElement('span');
    textEl.className = 'p-text';
    // Do not mask or redact values: the owner explicitly wants the complete
    // value visible in the preview (CSS ellipsis still handles very long text).
    textEl.textContent = String(text);
    typingPreviewEl.replaceChildren(textEl);
    scheduleOverlayReposition();
  }

  function positionTypingPreview() {
    const preview = typingPreviewEl;
    const anchor = typingPreviewAnchor;
    if (!preview || !preview.isConnected || !anchor || !anchor.isConnected) return;
    const rect = anchor.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return;
    const margin = 10;
    const gap = 10;
    const viewportWidth = Math.max(1, window.innerWidth || document.documentElement.clientWidth || 1);
    const viewportHeight = Math.max(1, window.innerHeight || document.documentElement.clientHeight || 1);
    const availableWidth = Math.max(1, viewportWidth - margin * 2);
    const width = Math.min(preview.offsetWidth || 320, availableWidth);
    const height = preview.offsetHeight || 42;
    const anchorX = rect.left + rect.width / 2;
    const roomAbove = rect.top - margin;
    const roomBelow = viewportHeight - rect.bottom - margin;
    const above = roomAbove >= height + gap || roomAbove >= roomBelow;
    const unclampedTop = above ? rect.top - height - gap : rect.bottom + gap;
    const topLimit = Math.max(margin, viewportHeight - height - margin);
    const leftLimit = Math.max(margin, viewportWidth - width - margin);
    const top = Math.max(margin, Math.min(topLimit, unclampedTop));
    const left = Math.max(margin, Math.min(leftLimit, anchorX - width / 2));
    const arrowLeft = Math.max(6, Math.min(Math.max(6, width - 18), anchorX - left - 6));
    preview.classList.toggle('below', !above);
    preview.style.setProperty('--attk-arrow-left', arrowLeft + 'px');
    preview.style.left = left + 'px';
    preview.style.top = top + 'px';
  }

  function showTypingPreview(el, text) {
    ensureStyle();
    if (typingPreviewHideTimer) clearTimeout(typingPreviewHideTimer);
    typingPreviewAnchor = el;
    if (!typingPreviewEl || !typingPreviewEl.isConnected) {
      typingPreviewEl = document.createElement('div');
      typingPreviewEl.id = overlayId('typing-preview');
      typingPreviewEl.setAttribute('data-attk-role', 'typing-preview');
      typingPreviewEl.setAttribute('data-attk-internal', 'true');
      typingPreviewEl.setAttribute('role', 'status');
      typingPreviewEl.setAttribute('aria-live', 'polite');
      typingPreviewEl.setAttribute('aria-atomic', 'true');
      (document.body || document.documentElement).appendChild(typingPreviewEl);
    }
    renderTypingPreview(text, false);
    positionTypingPreview();
  }

  function showTypingInProgress(text) {
    if (!typingPreviewEl) return;
    renderTypingPreview(String(text), true);
  }

  function hideTypingPreview(delay = 650) {
    if (!typingPreviewEl) return;
    if (typingPreviewHideTimer) clearTimeout(typingPreviewHideTimer);
    typingPreviewHideTimer = setTimeout(() => {
      typingPreviewEl?.remove();
      typingPreviewEl = null;
      typingPreviewAnchor = null;
      typingPreviewHideTimer = null;
    }, motionDelay(delay));
  }

  function repositionInputIndicator() {
    const current = activeInputTagEl;
    if (!current?.el?.isConnected || !current.tag?.isConnected) return;
    const rect = current.el.getBoundingClientRect();
    const tagRect = current.tag.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth || 1;
    const vh = window.innerHeight || document.documentElement.clientHeight || 1;
    current.tag.style.left = Math.max(4, Math.min(vw - tagRect.width - 4, rect.left)) + 'px';
    current.tag.style.top = Math.max(2, Math.min(vh - tagRect.height - 2, rect.top - tagRect.height - 4)) + 'px';
  }

  function scheduleOverlayReposition() {
    if (!typingPreviewEl && !activeInputTagEl) return;
    if (overlayRepositionFrame) return;
    const run = () => {
      overlayRepositionFrame = null;
      positionTypingPreview();
      repositionInputIndicator();
    };
    if (typeof requestAnimationFrame === 'function') overlayRepositionFrame = requestAnimationFrame(run);
    else run();
  }

  function scheduleCursorFade(delay = 1200) {
    if (cursorFadeTimer) {
      clearTimeout(cursorFadeTimer);
      cursorFadeTimer = null;
    }
    cursorFadeTimer = setTimeout(() => {
      if (cursorEl) {
        cursorEl.classList.add('hidden');
      }
      cursorFadeTimer = null;
    }, delay);
  }

  function ensureCursor() {
    ensureStyle();
    if (cursorFadeTimer) {
      clearTimeout(cursorFadeTimer);
      cursorFadeTimer = null;
    }
    if (cursorEl && cursorEl.isConnected) {
      cursorEl.classList.remove('hidden');
      return cursorEl;
    }
    cursorEl = document.createElement('div');
    cursorEl.id = overlayId('cursor');
    cursorEl.setAttribute('data-attk-role', 'cursor');
    cursorEl.setAttribute('data-attk-internal', 'true');
    cursorEl.setAttribute('aria-hidden', 'true');
    cursorEl.innerHTML = `<svg class="c-arrow" viewBox="0 0 28 28" fill="none" aria-hidden="true"><path d="M2 2 L2 22 L9 16 L12 24 L15 23 L11.5 15 L21 15 Z" fill="#67e8b0" stroke="white" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    cursorEl.style.left = '-100px';
    cursorEl.style.top = '-100px';
    (document.body || document.documentElement).appendChild(cursorEl);
    return cursorEl;
  }

  function ripple(x, y) {
    if (reducedMotion()) return;
    const r = document.createElement('div');
    r.id = overlayId('ripple');
    r.setAttribute('data-attk-role', 'ripple');
    r.setAttribute('data-attk-internal', 'true');
    r.setAttribute('aria-hidden', 'true');
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    (document.body || document.documentElement).appendChild(r);
    setTimeout(() => { if (r.parentNode) r.remove(); }, 500);
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function toPlainRect(r) {
    if (!r) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0 };
    return {
      x: r.left ?? r.x ?? 0,
      y: r.top ?? r.y ?? 0,
      width: r.width ?? 0,
      height: r.height ?? 0,
      top: r.top ?? 0,
      right: r.right ?? 0,
      bottom: r.bottom ?? 0,
      left: r.left ?? 0
    };
  }

  function isInternalNode(node) {
    if (!node || !node.nodeType) return false;
    if (node.hasAttribute && node.hasAttribute('data-attk-internal')) return true;
    if (node.classList && node.classList.contains('__attk-hl')) return true;
    return false;
  }

  function isElementVisible(el, rect = null) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch {}
    }
    const r = rect || el.getBoundingClientRect();
    if (r.width <= 1 || r.height <= 1) return false;
    try {
      const style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
    } catch {}
    return true;
  }

  function waitForScrollEnd(el, timeout = 900) {
    if (reducedMotion()) return Promise.resolve();
    return new Promise(resolve => {
      let lastRect = el ? el.getBoundingClientRect() : null;
      let stableFrames = 0;
      let done = false;
      let timer = null;
      const startTime = performance.now();

      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('scrollend', finish);
        document.removeEventListener('scrollend', finish);
        if (timer) clearTimeout(timer);
        resolve();
      };

      window.addEventListener('scrollend', finish, { once: true, passive: true });
      document.addEventListener('scrollend', finish, { once: true, passive: true });
      timer = setTimeout(finish, timeout);

      const tick = () => {
        if (done) return;
        const elapsed = performance.now() - startTime;
        if (elapsed > timeout) return finish();

        if (el) {
          const r = el.getBoundingClientRect();
          if (lastRect &&
              Math.abs(r.top - lastRect.top) < 0.5 &&
              Math.abs(r.left - lastRect.left) < 0.5 &&
              Math.abs(r.width - lastRect.width) < 0.5 &&
              Math.abs(r.height - lastRect.height) < 0.5) {
            // Require at least 60ms elapsed before stability counts (prevents premature exit before animation starts)
            if (elapsed > 60) {
              stableFrames++;
              if (stableFrames >= 4) return finish();
            }
          } else {
            stableFrames = 0;
            lastRect = r;
          }
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  }

  function getCenter(el) {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    return { x, y, rect: r };
  }

  function showHighlight(el) {
    clearHighlight();
    if (!el || el === document.documentElement || el === document.body || isInternalNode(el)) return;
    try {
      el.classList.add('__attk-hl');
      highlightEl = el;
    } catch {}
  }

  function clearHighlight() {
    if (highlightEl) {
      try { highlightEl.classList.remove('__attk-hl'); } catch {}
    }
    highlightEl = null;
  }

  async function glideTo(x, y, dur = 520) {
    const c = ensureCursor();
    // The SVG path's actual tip is (2, 2), so position the element by its
    // hotspot rather than making the visible arrow miss the event point.
    const targetLeft = x - CURSOR_HOTSPOT.x;
    const targetTop = y - CURSOR_HOTSPOT.y;
    const curLeft = parseFloat(c.style.left) || 0;
    const curTop = parseFloat(c.style.top) || 0;
    const dist = Math.hypot(targetLeft - curLeft, targetTop - curTop);
    const d = reducedMotion() ? 0 : Math.min(900, Math.max(dur, Math.round(dist * 0.75)));
    c.style.transitionDuration = d + 'ms';
    c.style.left = targetLeft + 'px';
    c.style.top = targetTop + 'px';
    if (d) await sleep(d + 30);
  }

  // --- event dispatching ---
  function firePointerAndMouse(el, type, x, y, btn = 0, detail = 1) {
    if (!el || isInternalNode(el)) return;
    const buttons = (type === 'mousedown' || type === 'pointerdown') ? (btn === 2 ? 2 : 1) : (type === 'mousemove' || type === 'pointermove' ? (btn === 2 ? 2 : 1) : 0);
    const screenX = (window.screenX || 0) + x;
    const screenY = (window.screenY || 0) + y;
    const pageX = (window.scrollX || 0) + x;
    const pageY = (window.scrollY || 0) + y;

    const commonInit = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail,
      clientX: x,
      clientY: y,
      screenX,
      screenY,
      button: btn,
      buttons
    };

    const pointerTypeMap = {
      mouseover: 'pointerover',
      mouseenter: 'pointerenter',
      mousemove: 'pointermove',
      mousedown: 'pointerdown',
      mouseup: 'pointerup',
      mouseout: 'pointerout',
      mouseleave: 'pointerleave'
    };

    if (pointerTypeMap[type]) {
      try {
        const pe = new PointerEvent(pointerTypeMap[type], {
          ...commonInit,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          width: 1,
          height: 1,
          pressure: (type === 'mousedown' || type === 'pointerdown') ? 0.5 : 0
        });
        el.dispatchEvent(pe);
      } catch {}
    }

    try {
      // In modern browsers, click, dblclick, contextmenu MUST strictly be MouseEvent
      // to comply with UI Events spec and allow React/Vue delegated synthetic event systems to work.
      const ev = new MouseEvent(type, commonInit);

      // Polyfill pageX/pageY if browser didn't populate from clientX
      if (ev.pageX === 0 && pageX !== 0) {
        Object.defineProperty(ev, 'pageX', { value: pageX });
        Object.defineProperty(ev, 'pageY', { value: pageY });
      }
      el.dispatchEvent(ev);
    } catch {}
  }

  function resolveTargetAt(x, y, fallbackEl) {
    let rawTarget = document.elementFromPoint(x, y);
    // Penetrate Shadow DOM roots if target is a shadow host
    while (rawTarget && rawTarget.shadowRoot) {
      const inner = rawTarget.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === rawTarget) break;
      rawTarget = inner;
    }
    if (!rawTarget || isInternalNode(rawTarget)) return fallbackEl;
    if (fallbackEl) {
      if (fallbackEl === rawTarget || fallbackEl.contains(rawTarget) || rawTarget.contains(fallbackEl)) return rawTarget;
      return fallbackEl;
    }
    return rawTarget;
  }

  async function doClick(selectorOrEl, opts = {}) {
    const { clickKind = 'click', duration = 520, scroll = true } = opts;
    let el = typeof selectorOrEl === 'string' ? queryDeep(selectorOrEl) : selectorOrEl;
    if (!el) throw new Error('Element not found: ' + selectorOrEl);

    let center = getCenter(el);
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const alreadyInView = center.rect.top >= 0 && center.rect.bottom <= vh && center.rect.left >= 0 && center.rect.right <= vw;

    if (scroll && !alreadyInView) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: scrollBehavior() });
      await waitForScrollEnd(el);
      center = getCenter(el);
    }

    showHighlight(el);
    try {
      await glideTo(center.x, center.y, duration);
      const c = ensureCursor();
      c.classList.add('clicking');
      ripple(center.x, center.y);
      await sleep(motionDelay(80));

      const target = resolveTargetAt(center.x, center.y, el);

      if (clickKind === 'right') {
        firePointerAndMouse(target, 'mouseover', center.x, center.y, 2);
        firePointerAndMouse(target, 'mousemove', center.x, center.y, 2);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 2);
        await sleep(motionDelay(50));
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 2);
        firePointerAndMouse(target, 'contextmenu', center.x, center.y, 2);
      } else if (clickKind === 'double') {
        firePointerAndMouse(target, 'mouseover', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousemove', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'click', center.x, center.y, 0, 1);
        await sleep(motionDelay(120));
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 0, 2);
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 0, 2);
        firePointerAndMouse(target, 'click', center.x, center.y, 0, 2);
        firePointerAndMouse(target, 'dblclick', center.x, center.y, 0, 2);
      } else {
        firePointerAndMouse(target, 'mouseover', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousemove', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 0, 1);
        try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch {}
        await sleep(motionDelay(50));
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'click', center.x, center.y, 0, 1);

        // Native default action activation: synthetic MouseEvent('click') does not trigger
        // native browser navigation (<a href>), checkbox/radio toggle, or form submission in Chromium.
        // Call el.click() if default wasn't prevented and element has a native click handler.
        try {
          const isNativeControl = target.matches?.('a[href], button, input, select, textarea, [role="button"], [role="checkbox"], [role="link"]') ||
                                  el.matches?.('a[href], button, input, select, textarea, [role="button"], [role="checkbox"], [role="link"]');
          if (isNativeControl) {
            const clickTarget = (typeof target.click === 'function') ? target : el;
            if (typeof clickTarget.click === 'function') {
              clickTarget.click();
            }
          }
        } catch {}
      }

      await sleep(motionDelay(100));
      c.classList.remove('clicking');
      await sleep(motionDelay(120));

      return {
        ok: true,
        x: center.x,
        y: center.y,
        tag: el.tagName ? el.tagName.toLowerCase() : '',
        text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 80)
      };
    } finally {
      clearHighlight();
      scheduleCursorFade(1200);
      // A click may update framework state without changing DOM attributes.
      invalidateDomCaches();
    }
  }

  // Prototype setter bypass for React 16+, Vue 3, Svelte, Angular
  function setNativeValue(element, value) {
    if (!element) return;
    const proto = element instanceof HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;

    let descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (!descriptor || !descriptor.set) {
      let cur = element;
      while (cur) {
        descriptor = Object.getOwnPropertyDescriptor(cur, 'value');
        if (descriptor && descriptor.set) break;
        cur = Object.getPrototypeOf(cur);
      }
    }

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  function showActiveInputIndicator(el) {
    removeActiveInputIndicator();
    if (!el || isInternalNode(el)) return;
    try {
      el.classList.add('__attk-input-focused');
      const tag = document.createElement('div');
      tag.className = '__attk-input-tag';
      tag.setAttribute('data-attk-internal', 'true');
      tag.setAttribute('role', 'status');
      tag.setAttribute('aria-live', 'polite');
      const label = el.getAttribute('placeholder') || el.name || el.id || el.tagName.toLowerCase();
      tag.textContent = '✏️ ' + (label.length > 25 ? label.slice(0, 22) + '...' : label);
      (document.body || document.documentElement).appendChild(tag);
      activeInputTagEl = { el, tag };
      if (typeof ResizeObserver === 'function') {
        try {
          overlayResizeObserver?.disconnect();
          overlayResizeObserver = new ResizeObserver(scheduleOverlayReposition);
          overlayResizeObserver.observe(el);
        } catch {}
      }
      scheduleOverlayReposition();
    } catch {}
  }

  function removeActiveInputIndicator(delay = 1400) {
    if (activeInputTagEl) {
      const { el, tag } = activeInputTagEl;
      activeInputTagEl = null;
      overlayResizeObserver?.disconnect();
      overlayResizeObserver = null;
      setTimeout(() => {
        try { el?.classList.remove('__attk-input-focused'); } catch {}
        try { tag?.remove(); } catch {}
      }, motionDelay(delay));
    }
  }

  function typeCharEvents(el, ch) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, code: getEventCode(ch), bubbles: true, cancelable: true, composed: true }));
    const beforeEvent = new InputEvent('beforeinput', {
      bubbles: true, cancelable: true, composed: true,
      inputType: 'insertText', data: ch
    });
    if (el.dispatchEvent(beforeEvent)) {
      setNativeValue(el, el.value + ch);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: ch }));
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, code: getEventCode(ch), bubbles: true, cancelable: true, composed: true }));
  }

  async function doTypeExclusive(selector, text, opts = {}) {
    const requestedText = String(text ?? '');
    let el = typeof selector === 'string' ? queryDeep(selector) : selector;
    if (!el) throw new Error('Element not found: ' + selector);

    el.scrollIntoView({ block: 'center', inline: 'center', behavior: scrollBehavior() });
    await waitForScrollEnd(el);
    const { x, y } = getCenter(el);

    showHighlight(el);
    showActiveInputIndicator(el);
    showTypingPreview(el, requestedText);
    await sleep(motionDelay(400));
    try {
      await glideTo(x, y, 250);
      const target = resolveTargetAt(x, y, el);
      firePointerAndMouse(target, 'mouseover', x, y);
      firePointerAndMouse(target, 'mousedown', x, y);
      firePointerAndMouse(target, 'mouseup', x, y);
      firePointerAndMouse(target, 'click', x, y);
      try { if (typeof el.focus === 'function') el.focus(); } catch {}
      await sleep(motionDelay(50));
      // "Preparing" ends only once the target is focused and mutation is next.
      const perChar = opts.perChar !== false;
      showTypingInProgress(perChar ? '' : requestedText);
      showActivity('Typing');

      const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';

      if (el.tagName === 'SELECT') {
        let matchedVal = requestedText;
        for (const opt of el.options) {
          if (opt.value === requestedText || opt.text === requestedText || opt.text.trim().toLowerCase() === requestedText.trim().toLowerCase()) {
            matchedVal = opt.value;
            break;
          }
        }
        setNativeValue(el, matchedVal);
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else if (isContentEditable) {
        el.focus();
        // Dispatch keydown for realism
        el.dispatchEvent(new KeyboardEvent('keydown', { key: requestedText.length === 1 ? requestedText : 'Unidentified', bubbles: true, cancelable: true, composed: true }));

        const beforeEvent = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: requestedText
        });
        const notCancelled = el.dispatchEvent(beforeEvent);

        if (notCancelled) {
          let inserted = false;
          try {
            inserted = document.execCommand('insertText', false, requestedText);
          } catch {}

          if (!inserted) {
            const sel = window.getSelection();
            if (sel && sel.rangeCount > 0) {
              const range = sel.getRangeAt(0);
              range.deleteContents();
              const textNode = document.createTextNode(requestedText);
              range.insertNode(textNode);
              range.setStartAfter(textNode);
              range.setEndAfter(textNode);
              sel.removeAllRanges();
              sel.addRange(range);
            } else {
              const textNode = document.createTextNode(requestedText);
              el.appendChild(textNode);
            }
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: requestedText }));
        }
        el.dispatchEvent(new KeyboardEvent('keyup', { key: requestedText.length === 1 ? requestedText : 'Unidentified', bubbles: true, composed: true }));
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.focus();

        // Optional: clear existing value first
        if (opts.clear && el.value) {
          setNativeValue(el, '');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
        }

        const inputType = (el.getAttribute('type') || '').toLowerCase();
        const atomicOnlyTypes = ['number', 'date', 'time', 'datetime-local', 'month', 'week', 'range', 'color'];
        const effectivePerChar = perChar && !el.readOnly && !atomicOnlyTypes.includes(inputType);

        if (effectivePerChar) {
          let typed = '';
          for (const ch of requestedText) {
            typeCharEvents(el, ch);
            typed += ch;
            showTypingInProgress(typed);
            if (!reducedMotion()) await sleep(18); // human-ish cadence; keeps autocomplete handlers happy
          }
        } else {
        // 1. keydown
        el.dispatchEvent(new KeyboardEvent('keydown', { key: requestedText.length === 1 ? requestedText : 'Unidentified', bubbles: true, cancelable: true, composed: true }));

        // 2. beforeinput (BEFORE value mutation per W3C specification)
        const beforeEvent = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: text
        });
        const notCancelled = el.dispatchEvent(beforeEvent);

        // 3. Mutate value with framework prototype bypass
        if (notCancelled) {
          setNativeValue(el, requestedText);
          // 4. input event
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: requestedText }));
        }

        // 5. keyup & change
        el.dispatchEvent(new KeyboardEvent('keyup', { key: requestedText.length === 1 ? requestedText : 'Unidentified', bubbles: true, cancelable: true, composed: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else {
        throw new Error('Element is not typable: <' + el.tagName?.toLowerCase() + '>');
      }

      return { ok: true, textLength: requestedText.length };
    } finally {
      hideActivity(500);
      removeActiveInputIndicator(1400);
      clearHighlight();
      hideTypingPreview(650);
      scheduleCursorFade(1200);
      // Value properties are not observable by MutationObserver.
      invalidateDomCaches();
    }
  }

  // Serialize typing operations so overlapping MCP messages cannot interleave
  // keystrokes, indicators, previews, or cleanup timers.
  async function doType(selector, text, opts = {}) {
    const previous = typingQueue;
    let release;
    typingQueue = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await doTypeExclusive(selector, text, opts);
    } finally {
      release();
    }
  }

  // --- robust css path generator (with shadow DOM support and internal class filtering) ---
  function cssPathWithinRoot(el, root) {
    if (!el || el === root || el === document.documentElement || el === document.body) return '';
    if (el.id && !el.id.startsWith('__attk')) {
      return '#' + CSS.escape(el.id);
    }
    let path = '';
    let cur = el;
    let depth = 0;
    while (cur && cur !== root && cur !== document.documentElement && cur !== document.body && depth < 8) {
      if (cur !== el && cur.id && !cur.id.startsWith('__attk')) {
        path = '#' + CSS.escape(cur.id) + (path ? ' > ' + path : '');
        return path;
      }
      let sel = cur.tagName.toLowerCase();
      const classAttr = cur.getAttribute ? cur.getAttribute('class') : null;
      let classStr = (classAttr && typeof classAttr === 'string' && classAttr.trim()) ? classAttr : (typeof cur.className === 'string' ? cur.className : '');
      if (classStr) {
        // Strip extension-internal classes
        const classes = classStr.trim().split(/\s+/).filter(c => c && !c.startsWith('__attk-')).slice(0, 2);
        if (classes.length > 0) {
          sel += classes.map(c => '.' + CSS.escape(c)).join('');
        }
      }
      const parent = cur.parentElement || (cur.parentNode instanceof ShadowRoot || cur.parentNode instanceof DocumentFragment ? cur.parentNode : null);
      if (parent && parent.children) {
        let count = 0;
        let index = 0;
        for (let i = 0; i < parent.children.length; i++) {
          const child = parent.children[i];
          if (child.tagName === cur.tagName) {
            count++;
            if (child === cur) index = count;
          }
        }
        if (count > 1 && index > 0) {
          sel += `:nth-of-type(${index})`;
        }
      }
      path = sel + (path ? ' > ' + path : '');
      cur = parent;
      depth++;
    }
    return path;
  }

  function cssPath(el) {
    if (!el || isInternalNode(el)) return '';
    const now = performance.now();
    const cached = selectorCache.get(el);
    if (cached && cached.revision === domRevision && now - cached.at < SELECTOR_CACHE_MS) {
      return cached.value;
    }

    const root = el.getRootNode ? el.getRootNode() : document;
    let value = '';
    if (root instanceof ShadowRoot) {
      const host = root.host;
      const hostPath = cssPath(host);
      const childPath = cssPathWithinRoot(el, root);
      value = hostPath ? `${hostPath} >>> ${childPath}` : childPath;
    } else {
      value = cssPathWithinRoot(el, document);
    }
    selectorCache.set(el, { value, revision: domRevision, at: now });
    return value;
  }

  // --- scrolling & keyboard helpers ---
  async function doScroll(direction = 'down', amount = 400) {
    const dx = { left: -amount, right: amount }[direction] ?? 0;
    const dy = { up: -amount, down: amount }[direction] ?? 0;
    window.scrollBy({ left: dx, top: dy, behavior: scrollBehavior() });
    await waitForScrollEnd(null, 600);
    invalidateLayoutCaches();
    return { ok: true, scrollY: window.scrollY, scrollX: window.scrollX };
  }

  function getKeyCode(key) {
    const map = {
      Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
      Space: 32, ' ': 32, Home: 36, End: 35, PageUp: 33, PageDown: 34
    };
    if (map[key]) return map[key];
    if (key.length === 1) return key.toUpperCase().charCodeAt(0);
    return 0;
  }

  function getEventCode(key) {
    if (key === ' ') return 'Space';
    if (key === 'Enter' || key === 'Tab' || key === 'Escape' || key === 'Backspace' || key === 'Delete') return key;
    if (key.startsWith('Arrow')) return key;
    if (key.length === 1) {
      if (/[a-zA-Z]/.test(key)) return 'Key' + key.toUpperCase();
      if (/[0-9]/.test(key)) return 'Digit' + key;
    }
    return key;
  }

  function doKey(keyOrCombo, selector, modifiers = []) {
    let rawKey = keyOrCombo || 'Enter';
    let mods = Array.isArray(modifiers) ? [...modifiers] : [];

    // Support combo strings like "Control+Enter" or "Ctrl+Shift+A"
    if (typeof rawKey === 'string' && rawKey.includes('+')) {
      const parts = rawKey.split('+').map(p => p.trim());
      rawKey = parts.pop();
      for (const part of parts) {
        const lower = part.toLowerCase();
        if ((lower === 'ctrl' || lower === 'control') && !mods.includes('Control')) mods.push('Control');
        else if (lower === 'alt' && !mods.includes('Alt')) mods.push('Alt');
        else if (lower === 'shift' && !mods.includes('Shift')) mods.push('Shift');
        else if ((lower === 'meta' || lower === 'command' || lower === 'cmd') && !mods.includes('Meta')) mods.push('Meta');
      }
    }

    let el = selector ? queryDeep(selector) : document.activeElement;
    if (!el || el === document.body || isInternalNode(el)) el = document.activeElement || document.body;
    try { if (typeof el.focus === 'function') el.focus(); } catch {}

    const code = getEventCode(rawKey);
    const keyCode = getKeyCode(rawKey);
    const ctrlKey = mods.includes('Control') || mods.includes('Ctrl');
    const altKey = mods.includes('Alt');
    const shiftKey = mods.includes('Shift');
    const metaKey = mods.includes('Meta');

    const init = {
      key: rawKey,
      code,
      keyCode,
      which: keyCode,
      ctrlKey,
      altKey,
      shiftKey,
      metaKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };

    const downEv = new KeyboardEvent('keydown', init);
    const notCancelled = el.dispatchEvent(downEv);

    if (rawKey.length === 1 || rawKey === 'Enter') {
      try { el.dispatchEvent(new KeyboardEvent('keypress', init)); } catch {}
    }

    el.dispatchEvent(new KeyboardEvent('keyup', init));

    if (rawKey === 'Enter' && notCancelled) {
      if (el.tagName === 'INPUT') {
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        if (el.form && typeof el.form.requestSubmit === 'function') {
          try { el.form.requestSubmit(); } catch {}
        }
      }
    }

    // Keyboard handlers can update application state without a DOM mutation.
    invalidateDomCaches();
    return { ok: true, key, code };
  }

  function semanticCandidates({ text = '', role = '', label = '', max = 20 } = {}, inspect = null) {
    const wantedText = String(text || '').trim().toLowerCase();
    const wantedLabel = String(label || '').trim().toLowerCase();
    const wantedRole = String(role || '').trim().toLowerCase();
    const sels = 'a[href], button, input, textarea, select, [role], [aria-label], [title], [onclick], [tabindex]:not([tabindex="-1"])';
    const matches = queryAllDeep(document, sels).filter(el => {
      if (isInternalNode(el) || !isElementVisible(el, inspect?.rect(el))) return false;
      const elRole = (el.getAttribute('role') || el.tagName || '').toLowerCase();
      const elLabel = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().toLowerCase();
      const elText = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
      return (!wantedRole || elRole === wantedRole)
        && (!wantedText || elText === wantedText || elText.includes(wantedText))
        && (!wantedLabel || elLabel === wantedLabel || elLabel.includes(wantedLabel));
    });
    const exact = matches.filter(el => {
      const elText = (el.innerText || el.value || el.textContent || '').trim().toLowerCase();
      const elLabel = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().toLowerCase();
      return (wantedText && elText === wantedText) || (wantedLabel && elLabel === wantedLabel);
    });
    return (exact.length ? exact : matches).slice(0, Math.min(Math.max(1, max | 0), 50));
  }

  function doFind(opts = {}) {
    try {
      const inspect = inspectionContext();
      const snapMap = (window.__attk_snapMap instanceof Map) ? window.__attk_snapMap : (window.__attk_snapMap = new Map());
      const candidates = semanticCandidates(opts, inspect);
      const items = candidates.map((el, index) => {
        const r = inspect.rect(el);
        const sel = inspect.selector(el);
        snapMap.set(index + 1, { el, selector: sel });
        return {
          index: index + 1,
          tag: el.tagName?.toLowerCase() || '',
          role: el.getAttribute('role') || el.tagName?.toLowerCase() || '',
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 160),
          label: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '',
          selector: sel,
          rect: toPlainRect(r),
          in_viewport: r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth
        };
      });
      return { ok: true, count: items.length, items };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  // --- shadow DOM & iframe tree walker ---
  // Use an explicit worklist and visited set instead of recursive generators.
  // Besides avoiding repeated work for shared/odd DOM implementations, this
  // puts hard limits on hostile pages with very large frame/shadow trees.
  function* walkRoots(root = document, limits = {}) {
    if (!root) return;
    const maxRoots = Math.min(limits.maxRoots ?? MAX_TRAVERSAL_ROOTS, MAX_TRAVERSAL_ROOTS);
    const maxNodes = Math.min(limits.maxNodes ?? MAX_TRAVERSAL_NODES, MAX_TRAVERSAL_NODES);
    const maxDepth = Math.min(limits.maxDepth ?? MAX_TRAVERSAL_DEPTH, MAX_TRAVERSAL_DEPTH);
    const pending = [{ root, depth: 0 }];
    const visitedRoots = new Set();
    let traversedNodes = 0;

    while (pending.length && visitedRoots.size < maxRoots) {
      // LIFO keeps the historical depth-first ordering (important for stable
      // snapshot IDs) without recursive generator frames.
      const current = pending.pop();
      if (!current?.root || visitedRoots.has(current.root)) continue;
      visitedRoots.add(current.root);
      observeCacheRoot(current.root);
      yield current.root;
      if (current.depth >= maxDepth || traversedNodes >= maxNodes) continue;

      try {
        const ownerDocument = current.root.ownerDocument || document;
        const walker = ownerDocument.createTreeWalker(current.root, NodeFilter.SHOW_ELEMENT, {
          acceptNode(node) {
            if (isInternalNode(node)) return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
          }
        });
        const children = [];
        let node;
        while ((node = walker.nextNode())) {
          if (++traversedNodes > maxNodes) break;
          if (node.shadowRoot) children.push({ root: node.shadowRoot, depth: current.depth + 1 });
          if (node.tagName === 'IFRAME' || node.tagName === 'FRAME') {
            try {
              const doc = node.contentDocument || node.contentWindow?.document;
              if (doc) children.push({ root: doc, depth: current.depth + 1 });
            } catch {}
          }
        }
        // Push reverse so the first discovered nested root is visited first.
        for (let i = children.length - 1; i >= 0; i--) pending.push(children[i]);
      } catch {}
    }
  }

  function queryAllDeep(root, selector) {
    const searchRoot = root || document;
    const results = [];
    if (!selector || typeof selector !== 'string') return results;
    const cacheSelector = selector.trim();
    if (!cacheSelector) return results;
    const now = performance.now();
    let bySelector = queryCache.get(searchRoot);
    if (!bySelector) {
      bySelector = new Map();
      queryCache.set(searchRoot, bySelector);
    }
    const cached = bySelector.get(cacheSelector);
    if (cached && cached.revision === domRevision && now - cached.at < DOM_QUERY_CACHE_MS) {
      // A mutation callback can be delayed by a microtask. Never return a
      // detached node even during that small window.
      return cached.results.filter(el => el && el.isConnected && !isInternalNode(el));
    }

    if (cacheSelector.includes('>>>')) {
      const parts = cacheSelector.split('>>>').map(s => s.trim()).filter(Boolean);
      let currentRoots = [searchRoot];
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const isLast = i === parts.length - 1;
        const nextElements = [];
        const seenPart = new Set();

        for (const r of currentRoots) {
          for (const subRoot of walkRoots(r)) {
            try {
              const matched = subRoot.querySelectorAll(part);
              for (let m = 0; m < matched.length; m++) {
                const el = matched[m];
                if (!isInternalNode(el) && !seenPart.has(el)) {
                  seenPart.add(el);
                  nextElements.push(el);
                }
              }
            } catch {}
          }
        }

        if (isLast) {
          bySelector.set(cacheSelector, { results: nextElements, revision: domRevision, at: now });
          return nextElements;
        }

        currentRoots = nextElements.map(el => el.shadowRoot || el).filter(Boolean);
        if (currentRoots.length === 0) break;
      }
      bySelector.set(cacheSelector, { results: [], revision: domRevision, at: now });
      return [];
    }

    const seen = new Set();
    for (const r of walkRoots(searchRoot)) {
      try {
        const found = r.querySelectorAll(cacheSelector);
        for (let i = 0; i < found.length; i++) {
          const el = found[i];
          if (!isInternalNode(el) && !seen.has(el)) {
            seen.add(el);
            results.push(el);
          }
        }
      } catch {}
    }
    bySelector.set(cacheSelector, { results, revision: domRevision, at: now });
    return results;
  }

  function queryDeep(selector) {
    if (!selector || typeof selector !== 'string') return null;
    const cleanSel = selector.trim();

    if (cleanSel.includes('>>>')) {
      const parts = cleanSel.split('>>>').map(s => s.trim()).filter(Boolean);
      let curRoot = document;
      let foundEl = null;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        foundEl = null;
        for (const r of walkRoots(curRoot)) {
          try {
            const match = r.querySelector(part);
            if (match && !isInternalNode(match)) {
              foundEl = match;
              break;
            }
          } catch {}
        }
        if (!foundEl) return null;
        if (i === parts.length - 1) return foundEl;
        curRoot = foundEl.shadowRoot || foundEl;
      }
      return foundEl;
    }

    for (const r of walkRoots(document)) {
      try {
        const el = r.querySelector(cleanSel);
        if (el && !isInternalNode(el)) return el;
      } catch {}
    }
    return null;
  }

  function doSnapshot(max = 80, inViewportOnly = false) {
    max = Math.min(Math.max(1, max | 0), 80);
    const now = performance.now();
    if (snapshotCache && snapshotCache.url === location.href
      && snapshotCache.revision === domRevision
      && snapshotCache.layoutRevision === layoutRevision
      && snapshotCache.max === max
      && snapshotCache.inViewportOnly === Boolean(inViewportOnly)
      && now - snapshotCache.at < SNAPSHOT_CACHE_MS
      && snapshotCache.entries.every(entry => entry.el?.isConnected && !isInternalNode(entry.el))) {
      const snapMap = (window.__attk_snapMap instanceof Map) ? window.__attk_snapMap : (window.__attk_snapMap = new Map());
      snapMap.clear();
      snapMap.__pageUrl = location.href;
      snapshotCache.entries.forEach((entry, i) => snapMap.set(i + 1, { el: entry.el, selector: entry.selector }));
      return snapshotCache.result;
    }

    const sels = 'a[href], button, [role="button"], [role="checkbox"], [role="radio"], [role="switch"], [role="tab"], [role="menuitem"], [role="combobox"], [role="option"], [role="link"], input, textarea, select, summary, label[for], [onclick], [tabindex]:not([tabindex="-1"])';
    const allEls = queryAllDeep(document.body || document.documentElement, sels);
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    const inspect = inspectionContext();
    const entries = [];

    // queryAllDeep already deduplicates across document, shadow, and frame
    // roots. Read geometry once, then reuse it for filtering and serialization.
    for (const el of allEls) {
      if (isInternalNode(el)) continue;
      const r = inspect.rect(el);
      if (r.width <= 2 || r.height <= 2 || !isElementVisible(el, r)) continue;
      const inView = r.bottom >= 0 && r.top <= vh && r.right >= 0 && r.left <= vw;
      if (inViewportOnly && !inView) continue;
      entries.push({ el, selector: inspect.selector(el), rect: r, inView });
      if (entries.length >= max) break;
    }

    const snapMap = (window.__attk_snapMap instanceof Map) ? window.__attk_snapMap : (window.__attk_snapMap = new Map());
    snapMap.clear();
    snapMap.__pageUrl = location.href;
    entries.forEach((entry, i) => snapMap.set(i + 1, { el: entry.el, selector: entry.selector }));

    const result = {
      ok: true,
      url: location.href,
      title: document.title,
      viewport: {
        w: vw,
        h: vh,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        devicePixelRatio: window.devicePixelRatio || 1,
        pageHeight: document.documentElement?.scrollHeight || document.body?.scrollHeight || 0
      },
      elements: entries.map((entry, i) => ({
        id: i + 1,
        tag: entry.el.tagName ? entry.el.tagName.toLowerCase() : '',
        text: (entry.el.innerText || entry.el.value || entry.el.placeholder || entry.el.getAttribute('aria-label') || entry.el.getAttribute('title') || '').trim().slice(0, 80),
        selector: entry.selector,
        in_viewport: entry.inView,
        rect: {
          x: entry.rect.left,
          y: entry.rect.top,
          width: entry.rect.width,
          height: entry.rect.height,
          page_y: entry.rect.top + window.scrollY
        },
        href: entry.el.href || null
      }))
    };
    snapshotCache = {
      at: now,
      url: location.href,
      revision: domRevision,
      layoutRevision,
      max,
      inViewportOnly: Boolean(inViewportOnly),
      entries,
      result
    };
    return result;
  }

  // --- element-id click & drag ---
  async function doClickId(id, kind = 'click') {
    const map = window.__attk_snapMap;
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    if (!(map instanceof Map) || !map.has(numId)) {
      throw new Error(`Unknown element id ${numId} — run tab_snapshot first`);
    }
    let { el, selector } = map.get(numId);
    if (!el || !el.isConnected) {
      el = selector ? queryDeep(selector) : null;
      if (!el) {
        map.delete(numId);
        const navNote = map.__pageUrl && map.__pageUrl !== location.href
          ? ' — page navigated since snapshot (was ' + map.__pageUrl + '), take a new tab_snapshot'
          : '';
        throw new Error(`Element ${numId} left the page and selector (${selector}) no longer matches${navNote}`);
      }
    }
    return await doClick(el, { clickKind: kind, duration: 520 });
  }

  async function resolvePoint(src) {
    if (src.from_selector) {
      const el = queryDeep(src.from_selector);
      if (!el) throw new Error('Not found: ' + src.from_selector);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: scrollBehavior() });
      await waitForScrollEnd(el);
      return getCenter(el);
    }
    if (typeof src.from_x === 'number' && typeof src.from_y === 'number') {
      return { x: src.from_x, y: src.from_y };
    }
    throw new Error('Provide from_selector or from_x/from_y');
  }

  async function doDrag(msg) {
    const from = await resolvePoint(msg);
    let toX = msg.to_x;
    let toY = msg.to_y;
    if (msg.to_selector) {
      const el2 = queryDeep(msg.to_selector);
      if (!el2) throw new Error('Not found: ' + msg.to_selector);
      el2.scrollIntoView({ block: 'center', inline: 'center', behavior: scrollBehavior() });
      await waitForScrollEnd(el2);
      const c2 = getCenter(el2);
      toX = c2.x;
      toY = c2.y;
    } else if (typeof toX !== 'number' || typeof toY !== 'number') {
      throw new Error('Provide to_selector or to_x/to_y');
    }

    const c = ensureCursor();
    const startTarget = resolveTargetAt(from.x, from.y, document.body);
    showHighlight(startTarget);

    try {
      await glideTo(from.x, from.y, 420);

      // Start drag sequence
      firePointerAndMouse(startTarget, 'mouseover', from.x, from.y);
      firePointerAndMouse(startTarget, 'mousemove', from.x, from.y);
      firePointerAndMouse(startTarget, 'mousedown', from.x, from.y);

      let dataTransfer = null;
      try {
        if (typeof DataTransfer === 'function') {
          dataTransfer = new DataTransfer();
          startTarget.dispatchEvent(new DragEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer,
            clientX: from.x,
            clientY: from.y
          }));
        }
      } catch {}

      c.classList.add('clicking');
      // Disable transition delay during manual frame stepping
      c.style.transitionDuration = '0ms';

      const dur = msg.duration ?? 700;
      const steps = reducedMotion() ? 1 : Math.max(8, Math.min(35, Math.round(dur / 25)));

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
        const x = from.x + (toX - from.x) * ease;
        const y = from.y + (toY - from.y) * ease;
        c.style.left = (x - CURSOR_HOTSPOT.x) + 'px';
        c.style.top = (y - CURSOR_HOTSPOT.y) + 'px';

        const over = resolveTargetAt(x, y, null);
        if (over) {
          firePointerAndMouse(over, 'mousemove', x, y);
          if (dataTransfer) {
            try {
              over.dispatchEvent(new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                composed: true,
                dataTransfer,
                clientX: x,
                clientY: y
              }));
            } catch {}
          }
        }
        if (!reducedMotion()) await sleep(dur / steps);
      }

      // Re-enable smooth transition
      c.style.transitionDuration = '120ms';

      const endTarget = resolveTargetAt(toX, toY, document.body);
      if (dataTransfer && endTarget) {
        try {
          endTarget.dispatchEvent(new DragEvent('drop', {
            bubbles: true,
            cancelable: true,
            composed: true,
            dataTransfer,
            clientX: toX,
            clientY: toY
          }));
          startTarget.dispatchEvent(new DragEvent('dragend', {
            bubbles: true,
            composed: true,
            dataTransfer,
            clientX: toX,
            clientY: toY
          }));
        } catch {}
      }

      firePointerAndMouse(endTarget, 'mouseup', toX, toY);
      ripple(toX, toY);
      c.classList.remove('clicking');
      await sleep(motionDelay(100));

      return { ok: true, from, to: { x: toX, y: toY } };
    } finally {
      clearHighlight();
      scheduleCursorFade(1200);
      invalidateDomCaches();
    }
  }

  // --- message router ---
  installCacheInvalidation();

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') {
      sendResponse({ ok: false, error: 'Invalid message payload' });
      return false;
    }

    (async () => {
      try {
        if (msg.type === 'PING') {
          return sendResponse({ ok: true });
        }

        if (msg.type === 'GET_TEXT') {
          const el = msg.selector ? queryDeep(msg.selector) : (document.body || document.documentElement);
          if (!el) throw new Error('Element not found: ' + msg.selector);
          return sendResponse({ ok: true, text: (el.innerText || el.textContent || '').slice(0, 50000) });
        }

        if (msg.type === 'GET_HTML') {
          const el = msg.selector ? queryDeep(msg.selector) : document.documentElement;
          if (!el) throw new Error('Element not found: ' + msg.selector);
          return sendResponse({ ok: true, html: (el.outerHTML || '').slice(0, 200000) });
        }

        if (msg.type === 'GET_STATS') {
          const bodyText = document.body ? (document.body.innerText || '') : '';
          return sendResponse({
            ok: true,
            links: queryAllDeep(document, 'a[href]').length,
            images: queryAllDeep(document, 'img').length,
            headings: queryAllDeep(document, 'h1,h2,h3,h4,h5,h6').length,
            words: bodyText.trim().split(/\s+/).filter(Boolean).length
          });
        }

        if (msg.type === 'CURSOR_CLICK') {
          ensureCursor();
          const res = await doClick(msg.selector, { clickKind: msg.kind || 'click', duration: msg.duration || 520 });
          return sendResponse(res);
        }

        if (msg.type === 'CURSOR_CLICK_EL') {
          ensureCursor();
          const x = msg.x;
          const y = msg.y;
          await glideTo(x, y, msg.duration || 520);
          const c = ensureCursor();
          c.classList.add('clicking');
          ripple(x, y);
          await sleep(motionDelay(80));
          const target = resolveTargetAt(x, y, null);
          if (!target) throw new Error(`No clickable element at (${x}, ${y})`);
          if (target.disabled || target.getAttribute('aria-disabled') === 'true') throw new Error('Target element is disabled');
          const btn = msg.kind === 'right' ? 2 : 0;
          const detail = msg.kind === 'double' ? 2 : 1;
          if (target) {
            firePointerAndMouse(target, 'mouseover', x, y, btn, detail);
            firePointerAndMouse(target, 'mousemove', x, y, btn, detail);
            firePointerAndMouse(target, 'mousedown', x, y, btn, detail);
            await sleep(motionDelay(50));
            firePointerAndMouse(target, 'mouseup', x, y, btn, detail);
            if (msg.kind === 'right') {
              firePointerAndMouse(target, 'contextmenu', x, y, 2);
            } else {
              firePointerAndMouse(target, 'click', x, y, 0, detail);
              if (msg.kind === 'double') {
                await sleep(motionDelay(120));
                firePointerAndMouse(target, 'mousedown', x, y, 0, 2);
                firePointerAndMouse(target, 'mouseup', x, y, 0, 2);
                firePointerAndMouse(target, 'click', x, y, 0, 2);
                firePointerAndMouse(target, 'dblclick', x, y, 0, 2);
              } else if (typeof target.click === 'function' && target.matches?.('a[href], button, input, select, textarea, [role="button"]')) {
                try { target.click(); } catch {}
              }
            }
          }
          c.classList.remove('clicking');
          scheduleCursorFade(1200);
          invalidateDomCaches();
          return sendResponse({ ok: true, x, y, dispatched: true, tag: target.tagName ? target.tagName.toLowerCase() : 'body' });
        }

        if (msg.type === 'CURSOR_TYPE') {
          let target = msg.selector;
          if (typeof msg.element === 'number') {
            const snap = window.__attk_snapMap?.get(msg.element);
            if (snap?.el) target = snap.el;
            else if (snap?.selector) target = snap.selector;
          }
          const res = await doType(target, msg.text, { clear: msg.clear === true, perChar: msg.perChar !== false });
          return sendResponse(res);
        }

        if (msg.type === 'CURSOR_SCROLL') {
          const res = await doScroll(msg.direction || 'down', msg.amount ?? 400);
          return sendResponse(res);
        }

        if (msg.type === 'CURSOR_KEY') {
          return sendResponse(doKey(msg.key, msg.selector, msg.modifiers));
        }

        if (msg.type === 'WAIT_FOR_SELECTOR') {
          const el = queryDeep(msg.selector);
          return sendResponse({ ok: true, found: Boolean(el && isElementVisible(el)) });
        }

        if (msg.type === 'CURSOR_FIND') {
          return sendResponse(doFind(msg));
        }

        if (msg.type === 'CURSOR_SNAPSHOT') {
          return sendResponse(doSnapshot(msg.max ?? 80, msg.inViewportOnly));
        }

        if (msg.type === 'CURSOR_SCROLL_INTO_VIEW') {
          const snapId = typeof msg.element === 'string' ? parseInt(msg.element, 10) : msg.element;
          let el = snapId && window.__attk_snapMap?.get(snapId)?.el;
          if (!el && msg.selector) el = queryDeep(msg.selector);
          if (!el) throw new Error('Element not found');
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: scrollBehavior() });
          await waitForScrollEnd(el);
          invalidateLayoutCaches();
          return sendResponse({
            ok: true,
            scrollY: window.scrollY,
            scrollX: window.scrollX,
            rect: toPlainRect(el.getBoundingClientRect())
          });
        }

        if (msg.type === 'CURSOR_CLICK_ID') {
          const r = await doClickId(msg.element, msg.kind || 'click');
          return sendResponse(r);
        }

        if (msg.type === 'CURSOR_CLICK_SEMANTIC') {
          const matches = semanticCandidates(msg);
          if (!matches.length) throw new Error('No visible element matched the semantic target');
          if (matches.length > 1) throw new Error(`Ambiguous semantic target: ${matches.length} visible elements matched; refine text, label, role, or use tab_find first`);
          const r = await doClick(matches[0], { clickKind: msg.kind || 'click', duration: msg.duration || 520 });
          return sendResponse({ ...r, matched: { text: (matches[0].innerText || matches[0].textContent || '').trim().slice(0, 120), selector: cssPath(matches[0]) } });
        }

        if (msg.type === 'CURSOR_DRAG') {
          const r = await doDrag(msg);
          return sendResponse(r);
        }

        if (msg.type === 'CURSOR_NETWORK_IDLE') {
          const r = await waitForNetworkIdle(msg.idleMs ?? 500, msg.timeoutMs ?? 15000);
          return sendResponse(r);
        }

        if (msg.type === 'CURSOR_CONSOLE_LOGS') {
          const r = getConsoleLogs(msg.types, msg.clear === true);
          return sendResponse(r);
        }

        throw new Error('Unknown message type: ' + msg.type);
      } catch (e) {
        sendResponse({ ok: false, error: e.message });
      }
    })();

    return true; // Keep asynchronous message channel open
  });

  console.debug('[Active Tab Toolkit] content ready', location.href);
})();

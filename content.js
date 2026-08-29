// content.js — Active Tab Toolkit (computer_use-style ghost cursor)
(() => {
  if (window.__attk_injected) return;
  window.__attk_injected = true;

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

  let cursorEl = null;
  let cursorFadeTimer = null;
  let styleEl = null;
  let somActive = false;
  let somEls = [];
  let highlightEl = null;

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
            if (isInternalNode(target)) return true;
            if (record.type === 'childList') {
              const nodes = [...record.addedNodes, ...record.removedNodes];
              return nodes.length > 0 && nodes.every(isInternalNode);
            }
            return false;
          })) return;
          invalidateDomCaches();
        });
        cacheObserver = observer;
        observeCacheRoot(document);
      } catch {}
    }
    try {
      window.addEventListener('scroll', invalidateLayoutCaches, { passive: true });
      // Capture element-scrolling too; scroll events on nested containers do
      // not reliably bubble to window but still move snapshot rectangles.
      document.addEventListener('scroll', invalidateLayoutCaches, { capture: true, passive: true });
      window.addEventListener('resize', invalidateLayoutCaches, { passive: true });
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
    styleEl.id = '__attk-style';
    styleEl.textContent = `
      #__attk-cursor {
        position: fixed;
        left: -100px;
        top: -100px;
        width: 28px;
        height: 28px;
        pointer-events: none !important;
        z-index: 2147483647;
        will-change: left, top, transform, opacity;
        filter: drop-shadow(0 2px 8px rgba(16,185,129,.7)) drop-shadow(0 0 16px rgba(16,185,129,.45));
        transition: left 520ms cubic-bezier(.2,.8,.2,1), top 520ms cubic-bezier(.2,.8,.2,1), transform 120ms ease, opacity 250ms ease;
        opacity: 1;
      }
      #__attk-cursor.hidden {
        opacity: 0;
      }
      #__attk-cursor .c-arrow {
        width: 28px;
        height: 28px;
        transform-origin: 2px 2px;
        transition: transform 120ms ease;
      }
      #__attk-cursor.clicking .c-arrow {
        transform: scale(.82);
      }
      #__attk-cursor .c-dot {
        position: absolute;
        left: 2px;
        top: 2px;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: #fff;
        box-shadow: 0 0 0 2px #10b981;
      }
      #__attk-ripple {
        position: fixed;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        border: 2px solid #10b981;
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
        outline: 2px solid #10b981 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 6px rgba(16,185,129,.22) !important;
        transition: outline .15s;
      }
      .__attk-input-focused {
        outline: 2px solid #10b981 !important;
        outline-offset: 2px !important;
        box-shadow: 0 0 0 4px rgba(16,185,129,.35), 0 0 12px rgba(16,185,129,.5) !important;
        transition: box-shadow .2s ease, outline .2s ease !important;
      }
      .__attk-input-tag {
        position: fixed;
        background: #10b981;
        color: #042316;
        font: 700 10px/14px ui-monospace, SFMono-Regular, Consolas, sans-serif;
        padding: 2px 6px;
        border-radius: 4px;
        pointer-events: none !important;
        z-index: 2147483647;
        box-shadow: 0 2px 8px rgba(0,0,0,.4);
        opacity: 1;
        transition: opacity 200ms ease;
      }
      .__attk-som {
        position: fixed;
        min-width: 20px;
        height: 20px;
        padding: 0 5px;
        border-radius: 10px;
        background: #10b981;
        color: #042316;
        font: 700 11px/20px system-ui, -apple-system, sans-serif;
        text-align: center;
        pointer-events: none !important;
        z-index: 2147483645;
        transform: translate(-50%,-50%);
        box-shadow: 0 2px 8px rgba(0,0,0,.35);
        border: 1px solid rgba(255,255,255,.9);
        user-select: none;
      }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
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
    cursorEl.id = '__attk-cursor';
    cursorEl.setAttribute('data-attk-internal', 'true');
    cursorEl.innerHTML = `<svg class="c-arrow" viewBox="0 0 28 28" fill="none"><path d="M2 2 L2 22 L9 16 L12 24 L15 23 L11.5 15 L21 15 Z" fill="#10b981" stroke="white" stroke-width="1.6" stroke-linejoin="round"/><circle class="c-dot" cx="2" cy="2" r="0"/></svg>`;
    cursorEl.style.left = '-100px';
    cursorEl.style.top = '-100px';
    (document.body || document.documentElement).appendChild(cursorEl);
    return cursorEl;
  }

  function ripple(x, y) {
    const r = document.createElement('div');
    r.id = '__attk-ripple';
    r.setAttribute('data-attk-internal', 'true');
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
    if (node.id && (node.id === '__attk-cursor' || node.id === '__attk-ripple' || node.id === '__attk-style')) return true;
    if (node.classList && (node.classList.contains('__attk-som') || node.classList.contains('__attk-hl'))) return true;
    if (node.hasAttribute && node.hasAttribute('data-attk-internal')) return true;
    return false;
  }

  function isElementVisible(el, rect = null) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
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
    const curLeft = parseFloat(c.style.left) || 0;
    const curTop = parseFloat(c.style.top) || 0;
    const dist = Math.hypot(x - curLeft, y - curTop);
    const d = Math.min(900, Math.max(dur, Math.round(dist * 0.75)));
    c.style.transitionDuration = d + 'ms';
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    await sleep(d + 30);
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
      // In modern browsers, PointerEvent is a subclass of MouseEvent
      const isPointerCapable = typeof PointerEvent === 'function';
      const ev = (isPointerCapable && (type === 'click' || type === 'dblclick' || type === 'contextmenu'))
        ? new PointerEvent(type, { ...commonInit, pointerId: 1, pointerType: 'mouse', isPrimary: true })
        : new MouseEvent(type, commonInit);

      // Polyfill pageX/pageY if browser didn't populate from clientX
      if (ev.pageX === 0 && pageX !== 0) {
        Object.defineProperty(ev, 'pageX', { value: pageX });
        Object.defineProperty(ev, 'pageY', { value: pageY });
      }
      el.dispatchEvent(ev);
    } catch {}
  }

  function resolveTargetAt(x, y, fallbackEl) {
    const rawTarget = document.elementFromPoint(x, y);
    if (!rawTarget || isInternalNode(rawTarget)) return fallbackEl;
    if (fallbackEl) {
      if (fallbackEl.contains(rawTarget) || rawTarget.contains(fallbackEl)) return rawTarget;
      return fallbackEl;
    }
    return rawTarget;
  }

  async function doClick(selectorOrEl, opts = {}) {
    const { clickKind = 'click', duration = 520, scroll = true } = opts;
    let el = typeof selectorOrEl === 'string' ? queryDeep(selectorOrEl) : selectorOrEl;
    if (!el) throw new Error('Element not found: ' + selectorOrEl);

    if (scroll) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      await waitForScrollEnd(el);
    }

    let center = getCenter(el);
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;
    if (center.rect.top < 0 || center.rect.bottom > vh || center.rect.left < 0 || center.rect.right > vw) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await waitForScrollEnd(el);
      center = getCenter(el);
    }

    showHighlight(el);
    try {
      await glideTo(center.x, center.y, duration);
      const c = ensureCursor();
      c.classList.add('clicking');
      ripple(center.x, center.y);
      await sleep(80);

      const target = resolveTargetAt(center.x, center.y, el);

      if (clickKind === 'right') {
        firePointerAndMouse(target, 'mouseover', center.x, center.y, 2);
        firePointerAndMouse(target, 'mousemove', center.x, center.y, 2);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 2);
        await sleep(50);
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 2);
        firePointerAndMouse(target, 'contextmenu', center.x, center.y, 2);
      } else if (clickKind === 'double') {
        firePointerAndMouse(target, 'mouseover', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousemove', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'click', center.x, center.y, 0, 1);
        await sleep(60);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 0, 2);
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 0, 2);
        firePointerAndMouse(target, 'click', center.x, center.y, 0, 2);
        firePointerAndMouse(target, 'dblclick', center.x, center.y, 0, 2);
      } else {
        firePointerAndMouse(target, 'mouseover', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousemove', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'mousedown', center.x, center.y, 0, 1);
        await sleep(50);
        firePointerAndMouse(target, 'mouseup', center.x, center.y, 0, 1);
        firePointerAndMouse(target, 'click', center.x, center.y, 0, 1);
        try { if (typeof el.focus === 'function') el.focus({ preventScroll: true }); } catch {}
      }

      await sleep(100);
      c.classList.remove('clicking');
      await sleep(120);

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

  let activeInputTagEl = null;

  function showActiveInputIndicator(el) {
    removeActiveInputIndicator();
    if (!el || isInternalNode(el)) return;
    try {
      el.classList.add('__attk-input-focused');
      const r = el.getBoundingClientRect();
      const tag = document.createElement('div');
      tag.className = '__attk-input-tag';
      tag.setAttribute('data-attk-internal', 'true');
      const label = el.getAttribute('placeholder') || el.name || el.id || el.tagName.toLowerCase();
      tag.textContent = '✏️ ' + (label.length > 25 ? label.slice(0, 22) + '...' : label);
      tag.style.left = Math.max(4, r.left) + 'px';
      tag.style.top = Math.max(2, r.top - 20) + 'px';
      (document.body || document.documentElement).appendChild(tag);
      activeInputTagEl = { el, tag };
    } catch {}
  }

  function removeActiveInputIndicator(delay = 1400) {
    if (activeInputTagEl) {
      const { el, tag } = activeInputTagEl;
      activeInputTagEl = null;
      setTimeout(() => {
        try { el?.classList.remove('__attk-input-focused'); } catch {}
        try { tag?.remove(); } catch {}
      }, delay);
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

  async function doType(selector, text, opts = {}) {
    let el = typeof selector === 'string' ? queryDeep(selector) : selector;
    if (!el) throw new Error('Element not found: ' + selector);

    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await waitForScrollEnd(el);
    const { x, y } = getCenter(el);

    showHighlight(el);
    showActiveInputIndicator(el);
    try {
      await glideTo(x, y, 250);
      const target = resolveTargetAt(x, y, el);
      firePointerAndMouse(target, 'mouseover', x, y);
      firePointerAndMouse(target, 'mousedown', x, y);
      firePointerAndMouse(target, 'mouseup', x, y);
      firePointerAndMouse(target, 'click', x, y);
      try { if (typeof el.focus === 'function') el.focus(); } catch {}
      await sleep(50);

      const isContentEditable = el.isContentEditable || el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '';

      if (el.tagName === 'SELECT') {
        let matched = false;
        for (const opt of el.options) {
          if (opt.value === text || opt.text === text || opt.text.trim().toLowerCase() === text.trim().toLowerCase()) {
            el.value = opt.value;
            matched = true;
            break;
          }
        }
        if (!matched) el.value = text;
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else if (isContentEditable) {
        el.focus();
        // Dispatch keydown for realism
        el.dispatchEvent(new KeyboardEvent('keydown', { key: text.length === 1 ? text : 'Unidentified', bubbles: true, cancelable: true, composed: true }));

        const beforeEvent = new InputEvent('beforeinput', {
          bubbles: true,
          cancelable: true,
          composed: true,
          inputType: 'insertText',
          data: text
        });
        const notCancelled = el.dispatchEvent(beforeEvent);

        if (notCancelled) {
          let inserted = false;
          try {
            inserted = document.execCommand('insertText', false, text);
          } catch {}

          if (!inserted) {
            const range = document.createRange();
            range.selectNodeContents(el);
            const sel = window.getSelection();
            if (sel) {
              sel.removeAllRanges();
              sel.addRange(range);
              range.deleteContents();
              const textNode = document.createTextNode(text);
              range.insertNode(textNode);
              range.setStartAfter(textNode);
              range.setEndAfter(textNode);
              sel.removeAllRanges();
              sel.addRange(range);
            }
          }
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        }
        el.dispatchEvent(new KeyboardEvent('keyup', { key: text.length === 1 ? text : 'Unidentified', bubbles: true, composed: true }));
      } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        el.focus();

        // Optional: clear existing value first
        if (opts.clear && el.value) {
          setNativeValue(el, '');
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));
        }

        if (opts.perChar && !el.readOnly) {
          for (const ch of text) {
            typeCharEvents(el, ch);
            await sleep(18); // human-ish cadence; keeps autocomplete handlers happy
          }
        } else {
        // 1. keydown
        el.dispatchEvent(new KeyboardEvent('keydown', { key: text.length === 1 ? text : 'Unidentified', bubbles: true, cancelable: true, composed: true }));

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
          setNativeValue(el, text);
          // 4. input event
          el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
        }

        // 5. keyup & change
        el.dispatchEvent(new KeyboardEvent('keyup', { key: text.length === 1 ? text : 'Unidentified', bubbles: true, cancelable: true, composed: true }));
        }
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else {
        throw new Error('Element is not typable: <' + el.tagName?.toLowerCase() + '>');
      }

      return { ok: true, textLength: text.length };
    } finally {
      clearHighlight();
      scheduleCursorFade(1200);
      // Value properties are not observable by MutationObserver.
      invalidateDomCaches();
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
      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === cur.tagName);
        if (siblings.length > 1) {
          sel += `:nth-of-type(${siblings.indexOf(cur) + 1})`;
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

  // --- SOM overlay (numbered interactables) ---
  function toggleSOM() {
    if (somActive) {
      somEls.forEach(n => { if (n.parentNode) n.remove(); });
      somEls = [];
      somActive = false;
      return { ok: true, active: false };
    }
    ensureStyle();
    const sels = 'a[href], button, [role="button"], input, textarea, select, [onclick], [tabindex]:not([tabindex="-1"])';
    const inspect = inspectionContext();
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const els = queryAllDeep(document, sels).filter(el => {
      if (isInternalNode(el)) return false;
      const r = inspect.rect(el);
      return r.width > 4 && r.height > 4 && r.top >= -200 && r.top < vh + 200 && isElementVisible(el, r);
    }).slice(0, 60);

    somEls = els.map((el, i) => {
      const r = inspect.rect(el);
      const n = document.createElement('div');
      n.className = '__attk-som';
      n.setAttribute('data-attk-internal', 'true');
      n.textContent = i + 1;
      n.style.left = (r.left + Math.min(18, r.width / 2)) + 'px';
      n.style.top = (r.top + 8) + 'px';
      const sel = cssPath(el);
      n.dataset.selector = sel;
      n.title = sel;
      (document.body || document.documentElement).appendChild(n);
      return n;
    });
    somActive = true;
    return { ok: true, active: true, count: els.length };
  }

  // --- scrolling & keyboard helpers ---
  async function doScroll(direction = 'down', amount = 400) {
    const dx = { left: -amount, right: amount }[direction] ?? 0;
    const dy = { up: -amount, down: amount }[direction] ?? 0;
    window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
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

  function doKey(key, selector) {
    let el = selector ? queryDeep(selector) : document.activeElement;
    if (!el || el === document.body || isInternalNode(el)) el = document.activeElement || document.body;
    try { if (typeof el.focus === 'function') el.focus(); } catch {}

    const code = getEventCode(key);
    const keyCode = getKeyCode(key);
    const init = {
      key,
      code,
      keyCode,
      which: keyCode,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window
    };

    const downEv = new KeyboardEvent('keydown', init);
    const notCancelled = el.dispatchEvent(downEv);

    if (key.length === 1 || key === 'Enter') {
      try { el.dispatchEvent(new KeyboardEvent('keypress', init)); } catch {}
    }

    el.dispatchEvent(new KeyboardEvent('keyup', init));

    if (key === 'Enter' && notCancelled) {
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
      const items = semanticCandidates(opts, inspect).map((el, index) => {
        const r = inspect.rect(el);
        return {
          index,
          tag: el.tagName?.toLowerCase() || '',
          role: el.getAttribute('role') || el.tagName?.toLowerCase() || '',
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 160),
          label: el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || '',
          selector: inspect.selector(el),
          rect: toPlainRect(r),
          in_viewport: r.bottom >= 0 && r.top <= innerHeight && r.right >= 0 && r.left <= innerWidth
        };
      });
      return { ok: true, count: items.length, items };
    } catch (e) { return { ok: false, error: e.message }; }
  }

  function doQuery(sel) {
    try {
      const els = queryAllDeep(document, sel).filter(el => !isInternalNode(el));
      if (!els.length) return { ok: true, count: 0, items: [] };
      const inspect = inspectionContext();
      return {
        ok: true,
        count: els.length,
        items: els.slice(0, 20).map((el, i) => ({
          index: i,
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 120),
          rect: toPlainRect(inspect.rect(el)),
          selector: inspect.selector(el)
        }))
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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

    const sels = 'a[href], button, [role="button"], input, textarea, select, h1, h2, h3, [onclick], [tabindex]:not([tabindex="-1"])';
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
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
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
      el2.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
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
      const steps = Math.max(8, Math.min(35, Math.round(dur / 25)));

      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // easeInOutQuad
        const x = from.x + (toX - from.x) * ease;
        const y = from.y + (toY - from.y) * ease;
        c.style.left = x + 'px';
        c.style.top = y + 'px';

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
        await sleep(dur / steps);
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
      await sleep(100);

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
          await sleep(80);
          const rawTarget = document.elementFromPoint(x, y);
          if (!rawTarget || isInternalNode(rawTarget)) throw new Error(`No clickable element at (${x}, ${y})`);
          const target = resolveTargetAt(x, y, null);
          if (!target || target === document.documentElement || target === document.body) throw new Error(`No clickable element at (${x}, ${y})`);
          if (target.disabled || target.getAttribute('aria-disabled') === 'true') throw new Error('Target element is disabled');
          const btn = msg.kind === 'right' ? 2 : 0;
          const detail = msg.kind === 'double' ? 2 : 1;
          if (target) {
            firePointerAndMouse(target, 'mouseover', x, y, btn, detail);
            firePointerAndMouse(target, 'mousemove', x, y, btn, detail);
            firePointerAndMouse(target, 'mousedown', x, y, btn, detail);
            await sleep(50);
            firePointerAndMouse(target, 'mouseup', x, y, btn, detail);
            if (msg.kind === 'right') {
              firePointerAndMouse(target, 'contextmenu', x, y, 2);
            } else {
              firePointerAndMouse(target, 'click', x, y, 0, detail);
              if (msg.kind === 'double') {
                firePointerAndMouse(target, 'mousedown', x, y, 0, 2);
                firePointerAndMouse(target, 'mouseup', x, y, 0, 2);
                firePointerAndMouse(target, 'click', x, y, 0, 2);
                firePointerAndMouse(target, 'dblclick', x, y, 0, 2);
              }
            }
          }
          c.classList.remove('clicking');
          scheduleCursorFade(1200);
          invalidateDomCaches();
          return sendResponse({ ok: true, x, y, dispatched: true, tag: target.tagName.toLowerCase() });
        }

        if (msg.type === 'CURSOR_TYPE') {
          const res = await doType(msg.selector, msg.text, { clear: msg.clear === true, perChar: msg.perChar === true });
          return sendResponse(res);
        }

        if (msg.type === 'CURSOR_SCROLL') {
          const res = await doScroll(msg.direction || 'down', msg.amount ?? 400);
          return sendResponse(res);
        }

        if (msg.type === 'CURSOR_KEY') {
          return sendResponse(doKey(msg.key, msg.selector));
        }

        if (msg.type === 'CURSOR_QUERY') {
          return sendResponse(doQuery(msg.selector));
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
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
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

        if (msg.type === 'CURSOR_SOM_TOGGLE') {
          const r = toggleSOM();
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

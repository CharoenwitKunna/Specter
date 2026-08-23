// content.js — Active Tab Toolkit (computer_use-style ghost cursor)
(() => {
  if (window.__attk_injected) return;
  window.__attk_injected = true;

  let cursorEl = null;
  let cursorFadeTimer = null;
  let styleEl = null;
  let somActive = false;
  let somEls = [];
  let highlightEl = null;

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

  function isElementVisible(el) {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
      } catch {}
    }
    const r = el.getBoundingClientRect();
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

  async function doType(selector, text, opts = {}) {
    let el = typeof selector === 'string' ? queryDeep(selector) : selector;
    if (!el) throw new Error('Element not found: ' + selector);

    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await waitForScrollEnd(el);
    const { x, y } = getCenter(el);

    showHighlight(el);
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
        el.dispatchEvent(new KeyboardEvent('keyup', { key: text.length === 1 ? text : 'Unidentified', bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
      } else {
        throw new Error('Element is not typable: <' + el.tagName?.toLowerCase() + '>');
      }

      return { ok: true, textLength: text.length };
    } finally {
      clearHighlight();
      scheduleCursorFade(1200);
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
    const root = el.getRootNode ? el.getRootNode() : document;
    if (root instanceof ShadowRoot) {
      const host = root.host;
      const hostPath = cssPath(host);
      const childPath = cssPathWithinRoot(el, root);
      return hostPath ? `${hostPath} >>> ${childPath}` : childPath;
    }
    return cssPathWithinRoot(el, document);
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
    const els = queryAllDeep(document, sels).filter(el => {
      if (isInternalNode(el)) return false;
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || document.documentElement.clientHeight;
      return r.width > 4 && r.height > 4 && r.top >= -200 && r.top < vh + 200 && isElementVisible(el);
    }).slice(0, 60);

    somEls = els.map((el, i) => {
      const r = el.getBoundingClientRect();
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

    return { ok: true, key, code };
  }

  function doQuery(sel) {
    try {
      const els = queryAllDeep(document, sel).filter(el => !isInternalNode(el));
      if (!els.length) return { ok: true, count: 0, items: [] };
      return {
        ok: true,
        count: els.length,
        items: els.slice(0, 20).map((el, i) => ({
          index: i,
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          text: (el.innerText || el.value || el.textContent || '').trim().slice(0, 120),
          rect: toPlainRect(el.getBoundingClientRect()),
          selector: cssPath(el)
        }))
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // --- shadow DOM tree walker ---
  function* walkRoots(root = document) {
    if (!root) return;
    yield root;
    try {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          if (isInternalNode(node)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        if (node.shadowRoot) {
          yield* walkRoots(node.shadowRoot);
        }
      }
    } catch {}
  }

  function queryAllDeep(root, selector) {
    const results = [];
    if (!selector || typeof selector !== 'string') return results;
    for (const r of walkRoots(root || document)) {
      try {
        const found = r.querySelectorAll(selector);
        for (let i = 0; i < found.length; i++) {
          if (!isInternalNode(found[i])) results.push(found[i]);
        }
      } catch {}
    }
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
    const sels = 'a[href], button, [role="button"], input, textarea, select, h1, h2, h3, [onclick], [tabindex]:not([tabindex="-1"])';
    const allEls = queryAllDeep(document.body || document.documentElement, sels);
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth || document.documentElement.clientWidth;

    const els = allEls.filter(el => {
      if (isInternalNode(el)) return false;
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2) return false;
      if (!isElementVisible(el)) return false;

      if (inViewportOnly) {
        return r.bottom >= 0 && r.top <= vh && r.right >= 0 && r.left <= vw;
      }
      return true;
    }).slice(0, max);

    const snapMap = (window.__attk_snapMap instanceof Map) ? window.__attk_snapMap : (window.__attk_snapMap = new Map());
    snapMap.clear();
    els.forEach((el, i) => snapMap.set(i + 1, { el, selector: cssPath(el) }));

    return {
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
      elements: els.map((el, i) => {
        const r = el.getBoundingClientRect();
        const inView = r.bottom >= 0 && r.top <= vh && r.right >= 0 && r.left <= vw;
        return {
          id: i + 1,
          tag: el.tagName ? el.tagName.toLowerCase() : '',
          text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 80),
          selector: cssPath(el),
          in_viewport: inView,
          rect: {
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height,
            page_y: r.top + window.scrollY
          },
          href: el.href || null
        };
      })
    };
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
        throw new Error(`Element ${numId} left the page and selector (${selector}) no longer matches`);
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
    }
  }

  // --- message router ---
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
          const target = resolveTargetAt(x, y, document.body);
          if (target) {
            firePointerAndMouse(target, 'mouseover', x, y);
            firePointerAndMouse(target, 'mousemove', x, y);
            firePointerAndMouse(target, 'mousedown', x, y);
            await sleep(50);
            firePointerAndMouse(target, 'mouseup', x, y);
            firePointerAndMouse(target, 'click', x, y);
          }
          c.classList.remove('clicking');
          scheduleCursorFade(1200);
          return sendResponse({ ok: true, x, y });
        }

        if (msg.type === 'CURSOR_TYPE') {
          const res = await doType(msg.selector, msg.text);
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

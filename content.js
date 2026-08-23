// content.js — Active Tab Toolkit (computer_use-style ghost cursor)
(() => {
  if (window.__attk_injected) return;
  window.__attk_injected = true;

  let cursorEl = null, styleEl = null, pickerActive = false, somActive = false;
  let somEls = [], highlightEl = null, tooltipEl = null;
  let lastX = 0, lastY = 0;

  // --- styles ---
  function ensureStyle() {
    if (styleEl) return;
    styleEl = document.createElement('style');
    styleEl.id = '__attk-style';
    styleEl.textContent = `
      #__attk-cursor{position:fixed;left:0;top:0;width:28px;height:28px;pointer-events:none;z-index:2147483647;will-change:left,top,transform;filter:drop-shadow(0 2px 8px rgba(16,185,129,.7)) drop-shadow(0 0 16px rgba(16,185,129,.45));transition:left 520ms cubic-bezier(.2,.8,.2,1), top 520ms cubic-bezier(.2,.8,.2,1), transform 120ms ease;}
      #__attk-cursor .c-arrow{width:28px;height:28px;transform-origin:2px 2px;transition:transform 120ms ease;}
      #__attk-cursor.clicking .c-arrow{transform:scale(.82);}
      #__attk-cursor .c-dot{position:absolute;left:2px;top:2px;width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #10b981;}
      #__attk-ripple{position:fixed;width:36px;height:36px;border-radius:50%;border:2px solid #10b981;pointer-events:none;z-index:2147483646;transform:translate(-50%,-50%) scale(.3);opacity:.9;animation:__attk-ripple .45s ease-out forwards;}
      @keyframes __attk-ripple{to{transform:translate(-50%,-50%) scale(1.8);opacity:0;}}
      .__attk-hl{outline:2px solid #10b981 !important;outline-offset:2px !important;box-shadow:0 0 0 6px rgba(16,185,129,.22) !important;transition:outline .15s;}
      .__attk-som{position:absolute;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#10b981;color:#042316;font:700 11px/20px system-ui,sans-serif;text-align:center;pointer-events:none;z-index:2147483645;transform:translate(-50%,-50%);box-shadow:0 2px 8px rgba(0,0,0,.35);border:1px solid rgba(255,255,255,.9);}
      #__attk-tooltip{position:fixed;pointer-events:none;z-index:2147483647;background:#0b120e;color:#e8f5ec;border:1px solid #1f3829;border-radius:8px;padding:6px 8px;font:11px/1.3 ui-monospace,monospace;max-width:320px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;box-shadow:0 8px 24px rgba(0,0,0,.4);}
      #__attk-picker-hint{position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;background:#10b981;color:#042316;font:700 12px system-ui,sans-serif;padding:8px 14px;border-radius:20px;box-shadow:0 4px 16px rgba(16,185,129,.6);pointer-events:none;}
    `;
    document.documentElement.appendChild(styleEl);
  }

  function ensureCursor() {
    ensureStyle();
    if (cursorEl) return cursorEl;
    cursorEl = document.createElement('div');
    cursorEl.id = '__attk-cursor';
    cursorEl.innerHTML = `<svg class="c-arrow" viewBox="0 0 28 28" fill="none"><path d="M2 2 L2 22 L9 16 L12 24 L15 23 L11.5 15 L21 15 Z" fill="#10b981" stroke="white" stroke-width="1.6" stroke-linejoin="round"/><circle class="c-dot" cx="2" cy="2" r="0"/></svg>`;
    // start off-screen
    cursorEl.style.left = '-100px';
    cursorEl.style.top = '-100px';
    document.documentElement.appendChild(cursorEl);
    return cursorEl;
  }

  function ripple(x, y) {
    const r = document.createElement('div');
    r.id = '__attk-ripple';
    r.style.left = x + 'px';
    r.style.top = y + 'px';
    document.documentElement.appendChild(r);
    setTimeout(() => r.remove(), 500);
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function getCenter(el) {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: r };
  }

  function showHighlight(el) {
    clearHighlight();
    if (!el || el === document.documentElement || el === document.body) return;
    el.classList.add('__attk-hl');
    highlightEl = el;
  }
  function clearHighlight() {
    if (highlightEl) highlightEl.classList.remove('__attk-hl');
    highlightEl = null;
  }

  async function glideTo(x, y, dur = 520) {
    const c = ensureCursor();
    // if first time, jump near target then glide from offset for realism
    const curLeft = parseFloat(c.style.left) || x;
    const curTop = parseFloat(c.style.top) || y;
    const dist = Math.hypot(x - curLeft, y - curTop);
    // far distance = longer duration
    const d = Math.min(900, Math.max(dur, dist * 0.9));
    c.style.transitionDuration = d + 'ms';
    // slight arc: offset mid
    c.style.left = x + 'px';
    c.style.top = y + 'px';
    lastX = x; lastY = y;
    await sleep(d + 40);
  }

  function fireMouse(el, type, x, y, btn = 0) {
    const ev = new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: btn, buttons: type === 'mousedown' ? 1 : 0 });
    el.dispatchEvent(ev);
  }

  async function doClick(selectorOrEl, opts = {}) {
    const { clickKind = 'click', duration = 520, scroll = true } = opts;
    let el = typeof selectorOrEl === 'string' ? queryDeep(selectorOrEl) : selectorOrEl;
    if (!el) throw new Error('Element not found: ' + selectorOrEl);
    if (scroll) {
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
      await sleep(350);
    }
    // Re-verify position after scroll
    let center = getCenter(el);
    if (center.rect.top < 0 || center.rect.bottom > innerHeight || center.rect.left < 0 || center.rect.right > innerWidth) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      await sleep(100);
      center = getCenter(el);
    }
    showHighlight(el);
    await glideTo(center.x, center.y, duration);
    const c = ensureCursor();
    c.classList.add('clicking');
    ripple(center.x, center.y);
    await sleep(90);

    const target = document.elementFromPoint(center.x, center.y) || el;
    if (clickKind === 'right') {
      fireMouse(target, 'mousedown', center.x, center.y, 2);
      fireMouse(target, 'mouseup', center.x, center.y, 2);
      fireMouse(target, 'contextmenu', center.x, center.y, 2);
    } else if (clickKind === 'double') {
      fireMouse(target, 'mousedown', center.x, center.y, 0);
      fireMouse(target, 'mouseup', center.x, center.y, 0);
      fireMouse(target, 'click', center.x, center.y, 0);
      await sleep(60);
      fireMouse(target, 'mousedown', center.x, center.y, 0);
      fireMouse(target, 'mouseup', center.x, center.y, 0);
      fireMouse(target, 'click', center.x, center.y, 0);
      fireMouse(target, 'dblclick', center.x, center.y, 0);
    } else {
      fireMouse(target, 'mouseover', center.x, center.y);
      fireMouse(target, 'mousemove', center.x, center.y);
      fireMouse(target, 'mousedown', center.x, center.y);
      await sleep(55);
      fireMouse(target, 'mouseup', center.x, center.y);
      fireMouse(target, 'click', center.x, center.y);
      try { el.focus?.({ preventScroll: true }); } catch {}
      if (el.tagName === 'A' && el.href && !el.getAttribute('onclick')) {
        // Fallback for native navigation if event.preventDefault wasn't called
        // el.click() handled by event cascade
      }
    }
    await sleep(120);
    c.classList.remove('clicking');
    await sleep(180);
    clearHighlight();
    return { ok: true, x: center.x, y: center.y, tag: el.tagName, text: (el.innerText || el.value || '').slice(0, 80) };
  }

  function setNativeValue(element, value) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  async function doType(selector, text) {
    let el = document.querySelector(selector);
    if (!el) throw new Error('Element not found: ' + selector);
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    await sleep(150);
    const { x, y } = getCenter(el);
    showHighlight(el);
    await glideTo(x, y, 250);
    const target = document.elementFromPoint(x, y) || el;
    fireMouse(target, 'mousedown', x, y);
    fireMouse(target, 'mouseup', x, y);
    fireMouse(target, 'click', x, y);
    try { el.focus(); } catch {}
    await sleep(50);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
      if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        // React/Vue setter bypass + native event cascade
        setNativeValue(el, text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    } else {
      throw new Error('Element is not typable');
    }
    clearHighlight();
    return { ok: true, textLength: text.length };
  }

  function cssPath(el) {
    if (!el) return '';
    if (el.id) return '#' + CSS.escape(el.id);
    let path = '';
    let cur = el;
    let depth = 0;
    while (cur && cur !== document.body && depth < 5) {
      let sel = cur.tagName.toLowerCase();
      if (cur.className && typeof cur.className === 'string') {
        const cls = cur.className.trim().split(/\s+/).slice(0,2).map(c=>'.'+CSS.escape(c)).join('');
        if (cls) sel += cls;
      }
      const parent = cur.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c=>c.tagName===cur.tagName);
        if (siblings.length > 1) sel += `:nth-of-type(${siblings.indexOf(cur)+1})`;
      }
      path = sel + (path ? ' > ' + path : '');
      cur = parent;
      depth++;
    }
    return path;
  }

  // --- picker ---
  function enterPicker() {
    if (pickerActive) return;
    pickerActive = true;
    ensureStyle();
    const hint = document.createElement('div');
    hint.id = '__attk-picker-hint';
    hint.textContent = 'Hover an element → click to select  •  ESC to cancel';
    document.documentElement.appendChild(hint);
    tooltipEl = document.createElement('div');
    tooltipEl.id = '__attk-tooltip';
    tooltipEl.style.display = 'none';
    document.documentElement.appendChild(tooltipEl);

    let current = null;
    const onMove = (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!el || el.closest('#__attk-cursor, #__attk-tooltip, #__attk-picker-hint, #__attk-style')) return;
      if (current !== el) {
        clearHighlight();
        current = el;
        showHighlight(el);
        tooltipEl.textContent = `${el.tagName.toLowerCase()}${el.id ? '#'+el.id : ''}${el.className ? '.'+String(el.className).split(/\s+/).slice(0,2).join('.') : ''}  →  ${cssPath(el)}`;
        tooltipEl.style.display = 'block';
      }
      tooltipEl.style.left = (e.clientX + 14) + 'px';
      tooltipEl.style.top = (e.clientY + 14) + 'px';
    };
    const onClick = async (e) => {
      e.preventDefault(); e.stopPropagation();
      const el = current;
      exitPicker();
      if (!el) return;
      const sel = cssPath(el);
      // notify popup via storage + message
      try { await chrome.storage.local.set({ __attk_lastPick: sel }); } catch {}
      // ghost-click it for demo
      try { await doClick(el, { duration: 420 }); } catch {}
      // also try to ping runtime (popup may be listening via storage)
      try { chrome.runtime.sendMessage({ type: 'PICKED', selector: sel }); } catch {}
    };
    const onKey = (e) => { if (e.key === 'Escape') exitPicker(); };
    function exitPicker() {
      pickerActive = false;
      clearHighlight();
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKey, true);
      document.getElementById('__attk-picker-hint')?.remove();
      tooltipEl?.remove(); tooltipEl = null;
      current = null;
    }
    // expose for message handler
    window.__attk_exitPicker = exitPicker;
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
  }

  function exitPickerExternal() {
    try { window.__attk_exitPicker?.(); } catch {}
    document.getElementById('__attk-picker-hint')?.remove();
    tooltipEl?.remove();
    clearHighlight();
    pickerActive = false;
  }

  // --- SOM overlay (numbered interactables) ---
  function toggleSOM() {
    if (somActive) {
      somEls.forEach(n => n.remove()); somEls = []; somActive = false; return { ok: true, active: false };
    }
    const sels = 'a[href], button, [role="button"], input, textarea, select, [onclick], [tabindex]:not([tabindex="-1"])';
    const els = [...document.querySelectorAll(sels)].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 4 && r.height > 4 && r.top >= -200 && r.top < innerHeight + 200 && getComputedStyle(el).visibility !== 'hidden';
    }).slice(0, 60);
    somEls = els.map((el, i) => {
      const r = el.getBoundingClientRect();
      const n = document.createElement('div');
      n.className = '__attk-som';
      n.textContent = i + 1;
      n.style.left = (r.left + Math.min(18, r.width/2)) + 'px';
      n.style.top = (r.top + Math.min(18, r.height/2)) + window.scrollY + 'px';
      // adjust for fixed vs absolute: use fixed
      n.style.position = 'fixed';
      n.style.top = (r.top + 8) + 'px';
      n.dataset.selector = cssPath(el);
      n.title = cssPath(el);
      document.documentElement.appendChild(n);
      return n;
    });
    somActive = true;
    // auto-hide after 8s
    setTimeout(() => { if (somActive) { somEls.forEach(n=>n.remove()); somEls=[]; somActive=false; } }, 8000);
    return { ok: true, active: true, count: els.length };
  }

  async function hideCursor() {
    cursorEl?.remove(); cursorEl = null;
    document.getElementById('__attk-ripple')?.remove();
    clearHighlight();
    return { ok: true };
  }

  // --- extra handlers for MCP bridge ---
  function doScroll(direction='down', amount=400) {
    const dx = { left: -amount, right: amount }[direction] ?? 0;
    const dy = { up: -amount, down: amount }[direction] ?? 0;
    window.scrollBy({ left: dx, top: dy, behavior: 'smooth' });
    return { ok: true, scrollY: window.scrollY, scrollX: window.scrollX };
  }
  function doKey(key, selector) {
    let el = selector ? document.querySelector(selector) : document.activeElement;
    if (!el || el === document.body) el = document.body;
    try { el.focus?.(); } catch {}
    const ev = (t) => new KeyboardEvent(t, { key, code: key, bubbles: true, cancelable: true });
    el.dispatchEvent(ev('keydown')); el.dispatchEvent(ev('keypress')); el.dispatchEvent(ev('keyup'));
    if (key === 'Enter' && el.tagName === 'INPUT') el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, key };
  }
  function doQuery(sel) {
    try {
      const els = [...document.querySelectorAll(sel)];
      if (!els.length) return { ok: true, count: 0, items: [] };
      return { ok: true, count: els.length, items: els.slice(0, 20).map((el,i)=>({ index:i, tag:el.tagName.toLowerCase(), text:(el.innerText||el.value||'').slice(0,120), rect:el.getBoundingClientRect(), selector: cssPath(el) })) };
    } catch (e) { return { error: e.message }; }
  }
  function queryAllDeep(root, selector) {
    let results = [...root.querySelectorAll(selector)];
    const treeWalker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = treeWalker.nextNode();
    while (node) {
      if (node.shadowRoot) {
        results = results.concat(queryAllDeep(node.shadowRoot, selector));
      }
      node = treeWalker.nextNode();
    }
    return results;
  }

  function queryDeep(selector) {
    if (selector.includes('>>>')) {
      const parts = selector.split('>>>').map(s => s.trim());
      let cur = document;
      for (let i = 0; i < parts.length; i++) {
        const el = cur.querySelector(parts[i]);
        if (!el) return null;
        if (i === parts.length - 1) return el;
        cur = el.shadowRoot || el;
      }
      return null;
    }
    let el = document.querySelector(selector);
    if (el) return el;
    // Fallback: search open shadow roots
    const treeWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let node = treeWalker.nextNode();
    while (node) {
      if (node.shadowRoot) {
        el = node.shadowRoot.querySelector(selector);
        if (el) return el;
      }
      node = treeWalker.nextNode();
    }
    return null;
  }

  function doSnapshot(max=80, inViewportOnly=false) {
    const sels = 'a[href], button, [role="button"], input, textarea, select, h1,h2,h3, [onclick], [tabindex]:not([tabindex="-1"])';
    const allEls = queryAllDeep(document.body || document.documentElement, sels);
    
    const els = allEls.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width <= 2 || r.height <= 2 || getComputedStyle(el).visibility === 'hidden' || getComputedStyle(el).display === 'none') {
        return false;
      }
      if (inViewportOnly) {
        return r.bottom >= 0 && r.top <= window.innerHeight && r.right >= 0 && r.left <= window.innerWidth;
      }
      return true;
    }).slice(0, max);

    // remember elements by id so agents can click by id (computer_use style)
    const snapMap = (window.__attk_snapMap instanceof Map) ? window.__attk_snapMap : (window.__attk_snapMap = new Map());
    snapMap.clear();
    els.forEach((el, i) => snapMap.set(i + 1, { el, selector: cssPath(el) }));
    
    return {
      ok: true,
      url: location.href,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight, scrollX: window.scrollX, scrollY: window.scrollY, pageHeight: document.body?.scrollHeight || 0 },
      elements: els.map((el, i) => {
        const r = el.getBoundingClientRect();
        const inView = r.bottom >= 0 && r.top <= window.innerHeight && r.right >= 0 && r.left <= window.innerWidth;
        return {
          id: i + 1,
          tag: el.tagName.toLowerCase(),
          text: (el.innerText || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().slice(0, 80),
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

  // --- element-id click + drag (computer_use style) ---
  async function doClickId(id, kind='click') {
    const map = window.__attk_snapMap;
    const numId = typeof id === 'string' ? parseInt(id, 10) : id;
    if (!(map instanceof Map) || !map.has(numId)) throw new Error('Unknown element id ' + numId + ' — run tab_snapshot first');
    let { el, selector } = map.get(numId);
    if (!el.isConnected) {
      el = selector ? queryDeep(selector) : null;
      if (!el) { map.delete(numId); throw new Error('Element ' + numId + ' left the page and its selector no longer matches'); }
    }
    return doClick(el, { clickKind: kind, duration: 520 });
  }

  async function resolvePoint(src) {
    if (src.from_selector) {
      const el = document.querySelector(src.from_selector);
      if (!el) throw new Error('Not found: ' + src.from_selector);
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(320);
      const c = getCenter(el);
      return c;
    }
    if (typeof src.from_x === 'number' && typeof src.from_y === 'number') return { x: src.from_x, y: src.from_y };
    throw new Error('Provide from_selector or from_x/from_y');
  }

  async function doDrag(msg) {
    const from = await resolvePoint(msg);
    let toX = msg.to_x, toY = msg.to_y;
    if (msg.to_selector) {
      const el2 = document.querySelector(msg.to_selector);
      if (!el2) throw new Error('Not found: ' + msg.to_selector);
      el2.scrollIntoView({ block: 'center', behavior: 'smooth' });
      await sleep(320);
      const c2 = getCenter(el2);
      toX = c2.x; toY = c2.y;
    } else if (typeof toX !== 'number' || typeof toY !== 'number') {
      throw new Error('Provide to_selector or to_x/to_y');
    }
    ensureCursor();
    showHighlight(document.elementFromPoint(from.x, from.y));
    await glideTo(from.x, from.y, 420);
    const target0 = document.elementFromPoint(from.x, from.y) || document.body;
    fireMouse(target0, 'mouseover', from.x, from.y);
    fireMouse(target0, 'mousemove', from.x, from.y);
    fireMouse(target0, 'mousedown', from.x, from.y);
    ensureCursor().classList.add('clicking');
    const dur = msg.duration ?? 700;
    const steps = Math.max(6, Math.min(30, Math.round(dur / 28)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2*t*t : -1 + (4 - 2*t)*t; // easeInOutQuad
      const x = from.x + (toX - from.x) * ease;
      const y = from.y + (toY - from.y) * ease;
      ensureCursor().style.left = x + 'px';
      ensureCursor().style.top = y + 'px';
      const over = document.elementFromPoint(x, y);
      if (over) fireMouse(over, 'mousemove', x, y);
      await sleep(dur / steps);
    }
    const target1 = document.elementFromPoint(toX, toY) || document.body;
    fireMouse(target1, 'mouseup', toX, toY);
    ripple(toX, toY);
    ensureCursor().classList.remove('clicking');
    clearHighlight();
    return { ok: true, from, to: { x: toX, y: toY } };
  }

  // --- message router ---
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    (async () => {
      try {
        if (msg.type === 'GET_TEXT') return sendResponse({ text: document.body.innerText.slice(0, 50000) });
        if (msg.type === 'GET_HTML') return sendResponse({ html: document.documentElement.outerHTML.slice(0, 200000) });
        if (msg.type === 'GET_STATS') return sendResponse({ links: document.querySelectorAll('a[href]').length, images: document.images.length, headings: document.querySelectorAll('h1,h2,h3,h4,h5,h6').length, words: document.body.innerText.trim().split(/\s+/).filter(Boolean).length });
        if (msg.type === 'CURSOR_CLICK') {
          ensureCursor();
          const res = await doClick(msg.selector, { clickKind: msg.kind || 'click', duration: msg.duration || 520 });
          return sendResponse(res);
        }
        if (msg.type === 'CURSOR_CLICK_EL') {
          ensureCursor();
          const x = msg.x, y = msg.y;
          await glideTo(x, y, msg.duration || 520);
          const c = ensureCursor(); c.classList.add('clicking'); ripple(x, y); await sleep(90);
          const target = document.elementFromPoint(x, y);
          if (target) { fireMouse(target,'mousedown',x,y); fireMouse(target,'mouseup',x,y); fireMouse(target,'click',x,y); }
          c.classList.remove('clicking');
          return sendResponse({ ok: true, x, y });
        }
        if (msg.type === 'CURSOR_MOVE') {
          ensureCursor();
          let x, y;
          if (msg.selector) {
            const el = document.querySelector(msg.selector);
            if (!el) throw new Error('Not found: '+msg.selector);
            el.scrollIntoView({block:'center',behavior:'smooth'}); await sleep(300);
            const c = getCenter(el); x=c.x; y=c.y; showHighlight(el); await glideTo(x,y,msg.duration||520); await sleep(200); clearHighlight();
          } else { x=msg.x; y=msg.y; await glideTo(x,y,msg.duration||520); }
          return sendResponse({ ok:true, x, y });
        }
        if (msg.type === 'CURSOR_TYPE') {
          const res = await doType(msg.selector, msg.text);
          return sendResponse(res);
        }
        if (msg.type === 'CURSOR_SCROLL') { return sendResponse(doScroll(msg.direction||'down', msg.amount??400)); }
        if (msg.type === 'CURSOR_KEY') { return sendResponse(doKey(msg.key, msg.selector)); }
        if (msg.type === 'CURSOR_QUERY') { return sendResponse(doQuery(msg.selector)); }
        if (msg.type === 'CURSOR_SNAPSHOT') { return sendResponse(doSnapshot(msg.max??80, msg.inViewportOnly)); }
        if (msg.type === 'CURSOR_SCROLL_INTO_VIEW') {
          let el = msg.element && window.__attk_snapMap?.get(msg.element)?.el;
          if (!el && msg.selector) el = queryDeep(msg.selector);
          if (!el) throw new Error('Element not found');
          el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
          await sleep(300);
          return sendResponse({ ok: true, scrollY: window.scrollY, scrollX: window.scrollX, rect: el.getBoundingClientRect() });
        }
        if (msg.type === 'CURSOR_CLICK_ID') { const r = await doClickId(msg.element, msg.kind || 'click'); return sendResponse(r); }
        if (msg.type === 'CURSOR_DRAG') { const r = await doDrag(msg); return sendResponse(r); }
        if (msg.type === 'CURSOR_PICK_START') { enterPicker(); return sendResponse({ ok:true }); }
        if (msg.type === 'CURSOR_PICK_CANCEL') { exitPickerExternal(); return sendResponse({ ok:true }); }
        if (msg.type === 'CURSOR_SOM_TOGGLE') { const r=toggleSOM(); return sendResponse(r); }
        if (msg.type === 'CURSOR_HIDE') { const r=await hideCursor(); return sendResponse(r); }
        if (msg.type === 'PING') return sendResponse({ ok:true });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  });

  console.debug('[Active Tab Toolkit] content ready', location.href);
})();

/* === 1. Polyfill (only what old browsers lack) === */

  /* --- IE9 classList polyfill (IE10+ have it; IE9 has nothing) ---
   * Minimal implementation covering add/remove/contains/toggle.
   * Only installs if Element.prototype.classList is absent.
   *
   * IMPORTANT: Caching strategy avoids re-entrant Object.defineProperty on
   * the 'classList' property name itself — inside the prototype getter we
   * MUST NOT call Object.defineProperty(this, 'classList', ...) because
   * IE9 re-triggers the prototype getter during the operation, causing
   * infinite recursion / stack overflow at ClassList constructor + getter.
   * Instead we stash the per-element ClassList instance under a plain
   * expando property name (__cl__) that's never defined via defineProperty.
   * The prototype getter always runs but the heavy ClassList object is
   * built at most once per element. */
  (function () {
    if (typeof Element === 'undefined') return; /* non-DOM env */
    if ('classList' in document.documentElement) return; /* already supported */
    var kTest = /^\s+|\s+$/g, kTrim = /\s+/;
    var CACHE_KEY = '__cl__'; /* plain expando, never Object.defineProperty'd */
    function tokens(s) { return (s || '').replace(kTest, '').split(kTrim); }
    function ClassList(el) { this._el = el; }
    ClassList.prototype = {
      add: function () {
        var cls = this._el.className, list = tokens(cls), changed = false, i, j, tok;
        for (i = 0; i < arguments.length; i++) {
          tok = String(arguments[i]);
          if (!tok) continue;
          for (j = 0; j < list.length; j++) if (list[j] === tok) break;
          if (j === list.length) { list.push(tok); changed = true; }
        }
        if (changed) this._el.className = list.join(' ');
      },
      remove: function () {
        var cls = this._el.className, list = tokens(cls), changed = false, i, j, tok;
        for (i = 0; i < arguments.length; i++) {
          tok = String(arguments[i]);
          for (j = 0; j < list.length; j++) {
            if (list[j] === tok) { list.splice(j, 1); j--; changed = true; }
          }
        }
        if (changed) this._el.className = list.join(' ');
      },
      contains: function (cls) {
        var list = tokens(this._el.className), tok = String(cls);
        for (var i = 0; i < list.length; i++) if (list[i] === tok) return true;
        return false;
      },
      toggle: function (cls, force) {
        var exists = this.contains(cls), add = (typeof force === 'boolean') ? force : !exists;
        if (add) { if (!exists) this.add(cls); return true; }
        else { if (exists) this.remove(cls); return false; }
      }
    };
    /* On some IE9 document modes Object.defineProperty on a DOM prototype
     * can itself misbehave (throw or silently ignore or recurse). Fall back
     * to __defineGetter__ (IE8/9 legacy hook) if the standard way throws.
     * In the getter we only access CACHE_KEY (a plain property on the
     * element instance) — never 'classList' — so no re-entrancy. */
    function install(getterFn) {
      try {
        Object.defineProperty(Element.prototype, 'classList', {
          get: getterFn,
          configurable: true
        });
      } catch (defErr) {
        try {
          /* IE9 legacy accessor hook */
          Element.prototype.__defineGetter__('classList', getterFn);
        } catch (gErr) {
          /* Give up on prototype injection — install a wrapper function.
           * Consumer code uses el.classList.METHOD() so a function-valued
           * classList would break calls. Instead, at first interaction
           * below we do nothing here; user will see feature not work rather
           * than crash on load. */
        }
      }
    }
    install(function () {
      var inst = this[CACHE_KEY];
      if (!inst) {
        inst = new ClassList(this);
        try { this[CACHE_KEY] = inst; } catch (expandoErr) { /* won't cache, still return fresh */ }
      }
      return inst;
    });
  })();

  /* --- IE9 pointer-events feature detection + JS forwarding ---
   * IE9 ignores pointer-events:none on HTML elements, so overlay/hud blocks
   * clicks on the canvas. We detect the bug and install a click-forwarder
   * that re-dispatches the event to the element beneath (document.elementFromPoint).
   * This is the lightest fix: no need to restructure DOM/z-index. */
  (function () {
    var el = document.createElement('div');
    if (!('pointerEvents' in el.style) && !('msPointerEvents' in el.style)) {
      window._ie9NoPointerEvents = true;
    }
  })();
  function installPointerEventsFallback() {
    if (!window._ie9NoPointerEvents) return;
    var targets = [document.getElementById('hud'), document.querySelector('.overlay')];
    for (var ti = 0; ti < targets.length; ti++) {
      (function (layer) {
        if (!layer) return;
        /* Only forward when the real event target IS the layer itself — i.e.
         * the user clicked on a transparent/uncovered part of overlay/hud.
         * If the target is a child (e.g. a button inside .screen), the normal
         * DOM event flow already delivers it — forwarding would double-fire. */
        function forward(e) {
          var realTarget = e.target || e.srcElement;
          if (realTarget !== layer) return;
          /* Find the topmost element that would be under the cursor if this
           * layer wasn't here. Temporarily hide this layer, probe, restore. */
          var prevDisplay = layer.style.display;
          var below;
          try {
            layer.style.display = 'none';
            below = document.elementFromPoint(e.clientX, e.clientY);
          } finally {
            layer.style.display = prevDisplay;
          }
          if (!below || below === layer) return;
          /* Re-dispatch a synthetic mouse event at the newly revealed element
           * so that its own handlers (canvas mouse/tap binding, buttons etc.)
           * see the interaction exactly as if the layer hadn't intercepted. */
          var evtName = e.type;
          try {
            var ev;
            if (document.createEvent) {
              ev = document.createEvent('MouseEvents');
              ev.initMouseEvent(evtName, true, true, window, 1,
                e.clientX, e.clientY, e.clientX, e.clientY,
                e.ctrlKey, e.altKey, e.shiftKey, e.metaKey, 0, null);
              below.dispatchEvent(ev);
            }
          } catch (err) { /* swallow */ }
          /* Stop the original event so the layer doesn't also claim it. */
          try { e.stopPropagation(); e.preventDefault(); } catch (err2) {}
        }
        /* Forward all primary mouse interaction events. mousemove is critical
         * for slide-note drag tracking in gameplay. contextmenu / dblclick
         * omitted (they aren't used by this app). */
        ['mousedown', 'mouseup', 'click', 'mousemove', 'mouseover', 'mouseout'].forEach(
          function (evtName) {
            layer.addEventListener(evtName, forward, true);
          }
        );
      })(targets[ti]);
    }
  }

  var rAF = window.requestAnimationFrame
    || window.webkitRequestAnimationFrame
    || window.mozRequestAnimationFrame
    || function (cb) { return window.setTimeout(cb, 16); };
  var cAF = window.cancelAnimationFrame
    || window.webkitCancelAnimationFrame
    || window.mozCancelAnimationFrame
    || function (id) { window.clearTimeout(id); };
  if (!Math.hypot) {
    Math.hypot = function () {
      var sum = 0;
      for (var i = 0; i < arguments.length; i++) sum += arguments[i] * arguments[i];
      return Math.sqrt(sum);
    };
  }
  if (!Array.isArray) {
    Array.isArray = function (o) { return Object.prototype.toString.call(o) === '[object Array]'; };
  }
  var now = (window.performance && performance.now)
    ? function () { return performance.now(); }
    : function () { return new Date().getTime(); };

  /* --- Integer thousands-separator formatter.
   *   Why not Number.prototype.toLocaleString()?
   *   IE9 / IE10 ship a non-standard locale formatter that appends ".00"
   *   to integer values (old NumberFormat defaulted to fractionDigits:2).
   *   Modern browsers agree that toLocaleString() on an integer shows no
   *   decimals, but we can't rely on that on IE<11, so we hand-roll a
   *   small, deterministic formatter that never touches browser locale. */
  function formatInt(n) {
    var v = Math.round(Number(n) || 0);
    var sign = v < 0 ? '-' : '';
    var s = String(Math.abs(v));
    var out = '';
    for (var i = s.length - 1, j = 0; i >= 0; i--, j++) {
      if (j > 0 && j % 3 === 0) out = ',' + out;
      out = s.charAt(i) + out;
    }
    return sign + out;
  }

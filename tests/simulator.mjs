import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

export const LIGHTBOX_CODE = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/js/lightbox.js"), "utf8");
export const DEBUG_CODE = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/js/lightbox-debug.js"), "utf8");

export function parseTransform(tr) {
  let tx = 0, ty = 0, sx = 1, sy = 1;
  const mT = /translate3d\(\s*([-\d.e]+)px,\s*([-\d.e]+)px/.exec(tr || "");
  if (mT) { tx = parseFloat(mT[1]); ty = parseFloat(mT[2]); }
  const mS = /scale\(\s*([-\d.e]+)(?:,\s*([-\d.e]+))?\)/.exec(tr || "");
  if (mS) { sx = parseFloat(mS[1]); sy = mS[2] !== undefined ? parseFloat(mS[2]) : sx; }
  return { tx, ty, sx, sy };
}

export function createSimulator({
  w = 1440,
  h = 900,
  tileCount = 10,
  scrollY = 0,
  loadDebug = false,
  reducedMotion = false,
  hasScrollEnd = true,
  decodeMode = "immediate", // "immediate" | "delayed" | "manual"
  decodeDelayMs = 200,
  threadedCompositor = true,
  tileDims = null,
  tileRects = null,
} = {}) {
  let now = 1000, rafId = 1, timerId = 1, selectedIdx = -1;
  let counting = false, layoutDirty = false;
  let recording = false, userInputActive = false;
  const rafs = new Map(), timers = new Map(), closeEvents = [];
  const resizeCallbacks = [];
  const decodedUrls = [], pendingDecodes = [], trace = [];
  const stats = {
    layoutReads: 0,
    layoutWrites: 0,
    forcedReflows: 0,
    transformWrites: 0,
    shadeWrites: 0,
    hiddenMapWrites: 0,
    interventions: 0,
  };

  function onRead() {
    if (!counting) return;
    stats.layoutReads++;
    if (layoutDirty) { stats.forcedReflows++; layoutDirty = false; }
  }
  function onLayoutWrite() {
    if (!counting) return;
    stats.layoutWrites++;
    layoutDirty = true;
  }

  let queuedTrackScroll = false;
  let compositorSnap = null;
  let trackMomentum = null;

  function mk(tag, cls = []) {
    const ls = new Map(), attrs = new Map(), children = [], classes = new Set(cls);
    const props = new Map();
    let scrollLeft = 0, scrollTop = 0;
    let _w = "", _h = "", _ov = "", _br = "", _tr = "", _l = "", _t = "", _sst = "";
    const style = {
      get width() { return _w; }, set width(v) { _w = v; onLayoutWrite(); },
      get height() { return _h; }, set height(v) { _h = v; onLayoutWrite(); },
      get overflow() { return _ov; },
      set overflow(v) {
        _ov = v;
        onLayoutWrite();
        if (el === track && v === "hidden") {
          compositorSnap = null;
          if (trackMomentum) trackMomentum.onTrack = false;
        }
      },
      get borderRadius() { return _br; }, set borderRadius(v) { _br = v; onLayoutWrite(); },
      get left() { return _l; }, set left(v) { _l = v; if (counting && tag === "span" && map.hidden) stats.hiddenMapWrites++; else onLayoutWrite(); },
      get top() { return _t; }, set top(v) { _t = v; if (counting && tag === "span" && map.hidden) stats.hiddenMapWrites++; else onLayoutWrite(); },
      get transform() { return _tr; }, set transform(v) { _tr = v; if (counting) stats.transformWrites++; },
      get scrollSnapType() { return _sst; }, set scrollSnapType(v) { _sst = v; },
      set cssText(v) { if (!v) { _w = _h = _ov = _br = _tr = _l = _t = ""; props.clear(); } },
      setProperty(k, v) { props.set(k, String(v)); if (counting && k === "--shade") stats.shadeWrites++; },
      getPropertyValue(k) { return props.get(k) || ""; },
      removeProperty(k) { props.delete(k); },
    };
    const el = {
      tagName: tag.toUpperCase(),
      dataset: {},
      get className() { return [...classes].join(" "); },
      set className(v) { classes.clear(); for (const c of String(v).split(/\s+/).filter(Boolean)) classes.add(c); },
      children, hidden: false, parentElement: null,
      textContent: "", src: "", currentSrc: "", alt: "", href: "", value: "", type: "",
      min: "", max: "", step: "", loading: "lazy", decoding: "async",
      get clientWidth() { onRead(); return w; },
      get clientHeight() { onRead(); return h; },
      get scrollLeft() { return scrollLeft; },
      set scrollLeft(v) {
        const max = Math.max(0, (parseFloat(children[0]?.style?.width || w) || w) - w);
        const next = Math.max(0, Math.min(max, v));
        if (el === track && next !== scrollLeft && !compositorSnap?.committing) queuedTrackScroll = true;
        scrollLeft = next;
      },
      get scrollTop() { return scrollTop; },
      set scrollTop(v) {
        const max = Math.max(0, (parseFloat(children[0]?.style?.height || h) || h) - h);
        const next = Math.max(0, Math.min(max, v));
        if (el === track && next !== scrollTop && !compositorSnap?.committing) queuedTrackScroll = true;
        scrollTop = next;
      },
      style,
      classList: {
        add: c => classes.add(c),
        remove: c => classes.delete(c),
        contains: c => classes.has(c),
        toggle: (c, f) => (f === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : (f ? classes.add(c) : classes.delete(c))),
      },
      get firstElementChild() { return children[0] || null; },
      get lastElementChild() { return children[children.length - 1] || null; },
      replaceChildren(...ns) { children.length = 0; for (const n of ns) { n.parentElement = el; children.push(n); } },
      append(...ns) {
        for (const n of ns) {
          if (n.parentElement) { const j = n.parentElement.children.indexOf(n); if (j >= 0) n.parentElement.children.splice(j, 1); }
          n.parentElement = el;
          children.push(n);
        }
      },
      prepend(...ns) {
        for (const n of [...ns].reverse()) {
          if (n.parentElement) { const j = n.parentElement.children.indexOf(n); if (j >= 0) n.parentElement.children.splice(j, 1); }
          n.parentElement = el;
          children.unshift(n);
        }
      },
      insertBefore(n, ref) {
        n.parentElement = el;
        const i = children.indexOf(ref);
        if (i >= 0) children.splice(i, 0, n); else children.push(n);
      },
      remove() {
        if (el.parentElement) { const j = el.parentElement.children.indexOf(el); if (j >= 0) el.parentElement.children.splice(j, 1); el.parentElement = null; }
      },
      contains(n) { return n === el || children.some(c => c.contains?.(n)); },
      closest(sel) {
        const clsName = sel.startsWith(".") ? sel.slice(1) : null;
        for (let cur = el; cur; cur = cur.parentElement) {
          if (clsName && cur.classList.contains(clsName)) return cur;
        }
        return null;
      },
      matches(sel) {
        return sel.split(",").map(s => s.trim().toUpperCase()).includes(el.tagName);
      },
      getAttribute: k => attrs.get(k) ?? null,
      setAttribute: (k, v) => attrs.set(k, String(v)),
      getBoundingClientRect() {
        onRead();
        if (el._rect) return el._rect;
        if (classes.has("lb-debug")) return { left: 0, top: 0, right: w, bottom: classes.has("collapsed") ? 28 : 235, width: w, height: classes.has("collapsed") ? 28 : 235 };
        const bw = parseFloat(_w || w), bh = parseFloat(_h || h);
        const { tx, ty, sx, sy } = parseTransform(_tr);
        return { left: tx, top: ty, right: tx + bw * sx, bottom: ty + bh * sy, width: bw * sx, height: bh * sy };
      },
      setPointerCapture() {},
      addEventListener(type, fn) { if (!ls.has(type)) ls.set(type, []); ls.get(type).push(fn); },
      dispatch(type, ev = {}) {
        ev.cancelable ??= true;
        ev.preventDefault = () => { if (!ev.cancelable) stats.interventions++; else ev.defaultPrevented = true; };
        ev.stopPropagation ??= () => {};
        ev.timeStamp ??= now;
        ev.target ??= el;
        for (const fn of (ls.get(type) || [])) fn(ev);
        if (typeof el["on" + type] === "function") el["on" + type](ev);
        return ev;
      },
      querySelector(sel) {
        if (sel === ".stage") return stage;
        if (sel === ".track") return track;
        if (sel === ".track-space") return trackSpace;
        if (sel === ".viewport") return viewport;
        if (sel === ".minimap") return map;
        if (sel === "img") return mapImg;
        if (sel === "span") return bounds;
        if (sel === "#notice") return notice;
        if (sel === ".frame.current") return frames.find(f => f.classList.contains("current")) || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ".frame") return frames;
        if (sel === ".snap") return trackSpace.children.filter(c => c.classList.contains("snap"));
        return [];
      },
    };
    return el;
  }

  const docEl = mk("html"), head = mk("head"), body = mk("body"), dialog = mk("dialog");
  dialog.open = false;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => {
    closeEvents.push({
      inViewer: tiles[selectedIdx]?.classList.contains("in-viewer"),
      debugInBody: body.firstElementChild?.classList?.contains("lb-debug") || false,
      debugH: docEl.style.getPropertyValue("--lb-debug-h"),
      scrollY: winObj.scrollY,
    });
    dialog.open = false;
    setTimeoutMock(() => dialog.dispatch("close"), 0);
  };
  const stage = mk("div", ["stage"]);
  const track = mk("div", ["track"]);
  const trackSpace = mk("div", ["track-space"]);
  const viewport = mk("div", ["viewport"]);
  stage._rect = viewport._rect = { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
  const frames = [mk("div", ["frame"]), mk("div", ["frame"]), mk("div", ["frame"])];
  const map = mk("div", ["minimap"]), mapImg = mk("img"), bounds = mk("span"), notice = mk("p");
  map._rect = { left: w - 156, top: h - 108, right: w - 12, bottom: h - 12, width: 144, height: 96 };
  bounds._rect = { left: w - 100, top: h - 70, right: w - 60, bottom: h - 40, width: 40, height: 30 };
  track.append(trackSpace);
  trackSpace.append(viewport);
  viewport.append(...frames, map);
  dialog.append(stage, notice);
  body.append(dialog);

  const tiles = Array.from({ length: tileCount }, (_, i) => {
    const a = mk("a");
    a.href = `img/medium-res/${i}.jpg`;
    const col = i % 4, row = Math.floor(i / 4);
    const [tw, th] = tileDims ? tileDims(i) : (i % 2 ? [1280, 1920] : [1920, 1280]);
    const rw = Math.round(152 * tw / th), rh = 152;
    a._rect = tileRects
      ? tileRects(i, tw, th)
      : { left: 8 + col * 240, top: 88 + row * 180, width: rw, height: rh, right: 8 + col * 240 + rw, bottom: 88 + row * 180 + rh };
    const img = mk("img");
    img.src = `img/low-res/${i}.jpg`;
    img.currentSrc = img.src;
    img.alt = `Photo ${i}`;
    img.setAttribute("width", String(tw));
    img.setAttribute("height", String(th));
    img.decode = () => Promise.resolve();
    a.append(img);
    return a;
  });

  let openCb, lastFocusedTile = -1;
  const photoGrid = {
    tiles,
    select(i) {
      if (selectedIdx >= 0) tiles[selectedIdx].classList.remove("in-viewer");
      selectedIdx = i;
      tiles[i].classList.add("in-viewer");
    },
    restore() {
      if (selectedIdx >= 0) {
        tiles[selectedIdx].classList.remove("in-viewer");
        lastFocusedTile = selectedIdx;
      }
    },
    onOpen(cb) { openCb = cb; },
  };

  function setTimeoutMock(fn, ms = 0) { const id = timerId++; timers.set(id, { fn, at: now + ms }); return id; }
  function clearTimeoutMock(id) { timers.delete(id); }

  class FakeImage {
    constructor() { this.alt = ""; this.src = ""; this.decoding = "auto"; this.draggable = true; }
    decode() {
      decodedUrls.push(this.src);
      if (decodeMode === "immediate") return Promise.resolve();
      if (decodeMode === "delayed") {
        const delay = this.src.includes("medium-res/") ? decodeDelayMs : Math.min(16, decodeDelayMs);
        return new Promise((resolve, reject) => {
          const entry = { img: this, src: this.src, resolve, reject, settled: false };
          pendingDecodes.push(entry);
          setTimeoutMock(() => {
            if (!entry.settled) { entry.settled = true; resolve(); }
          }, delay);
        });
      }
      return new Promise((resolve, reject) => {
        pendingDecodes.push({ img: this, src: this.src, resolve, reject, settled: false });
      });
    }
    remove() { this._removed = true; }
  }

  const store = new Map();
  const winObj = mk("window");
  winObj.scrollY = scrollY;
  if (hasScrollEnd) winObj.onscrollend = null;

  const ctx = {
    console, Math, Number, Object, Array, Map, Set, Promise, JSON, String, parseFloat, NaN, URLSearchParams,
    Image: FakeImage,
    window: winObj,
    document: {
      documentElement: docEl,
      head,
      body,
      querySelector: sel => sel === "dialog" ? dialog : sel === "dialog[open]" ? (dialog.open ? dialog : null) : null,
      createElement: tag => mk(tag),
      createElementNS: (_ns, tag) => mk(tag),
    },
    localStorage: { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    matchMedia: () => ({ matches: reducedMotion }),
    performance: { now: () => now },
    requestAnimationFrame(fn) { const id = rafId++; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    setInterval: () => 1,
    clearInterval: () => {},
    ResizeObserver: class {
      constructor(cb) { this.cb = cb; }
      observe() { resizeCallbacks.push(this.cb); }
      disconnect() {
        const i = resizeCallbacks.indexOf(this.cb);
        if (i >= 0) resizeCallbacks.splice(i, 1);
      }
    },
    photoGrid,
  };
  vm.createContext(ctx);
  vm.runInContext(LIGHTBOX_CODE, ctx);
  if (loadDebug) vm.runInContext(DEBUG_CODE, ctx);
  const lightbox = vm.runInContext("lightbox", ctx);

  function currentFrame() { return frames.find(f => f.classList.contains("current")) || frames[1]; }

  function sampleFrame(tag = "frame") {
    if (!recording) return;
    const active = currentFrame();
    const bw = parseFloat(active.style.width || 0);
    const bh = parseFloat(active.style.height || 0);
    const { tx, ty, sx, sy } = parseTransform(active.style.transform);
    const shadeRaw = dialog.style.getPropertyValue("--shade");
    const rect = { left: tx, top: ty, width: bw * sx, height: bh * sy, right: tx + bw * sx, bottom: ty + bh * sy };
    trace.push({
      t: now,
      tag,
      state: lightbox.state,
      edge: lightbox.lastEdge,
      open: dialog.open,
      scrollY: winObj.scrollY,
      activeAlt: active.firstElementChild?.alt || "",
      activeSrc: active.lastElementChild?.src || "",
      childCount: active.children.length,
      tx, ty, sx, sy,
      shade: shadeRaw === "" ? 1 : parseFloat(shadeRaw),
      page: lightbox.telemetry.page,
      scale: lightbox.telemetry.scale,
      trackLeft: track.scrollLeft,
      trackTop: track.scrollTop,
      rect,
      userInput: userInputActive,
    });
  }

  function snapMode() {
    if (track.style.scrollSnapType === "none" || track.classList.contains("free")) return "none";
    if (track.classList.contains("snap-both")) return "both";
    return "x";
  }

  function snapTargets() {
    const visible = trackSpace.querySelectorAll(".snap").filter(s => !s.hidden);
    const xs = [...new Set(visible.map(s => parseFloat(s.style.left) || 0))].sort((a, b) => a - b);
    const ys = [...new Set(visible.map(s => parseFloat(s.style.top) || 0))].sort((a, b) => a - b);
    return { xs, ys };
  }

  function nearestTarget(val, candidates) {
    let best = candidates[0], bestDist = Math.abs(val - best);
    for (const c of candidates) {
      const d = Math.abs(val - c);
      if (d < bestDist) { best = c; bestDist = d; }
    }
    return best;
  }

  function tickCompositor() {
    // 1) In-flight macOS momentum (continues onto window if dialog closes!)
    if (trackMomentum) {
      trackMomentum.vx *= trackMomentum.decay;
      trackMomentum.vy *= trackMomentum.decay;
      const done = Math.hypot(trackMomentum.vx, trackMomentum.vy) < 0.8;
      if (done) {
        const wasOnTrack = trackMomentum.onTrack;
        trackMomentum = null;
        if (wasOnTrack && !compositorSnap && dialog.open && hasScrollEnd) {
          track.dispatch("scrollend");
          sampleFrame("scrollend");
        }
      } else if (dialog.open && trackMomentum.onTrack && track.style.overflow !== "hidden") {
        wheelTick(trackMomentum.vx, trackMomentum.vy, { cancelable: false, recordAsInput: false });
      } else {
        // Momentum spills onto window after dialog closes or while closing
        const ev = winObj.dispatch("wheel", { deltaX: trackMomentum.vx, deltaY: trackMomentum.vy, deltaMode: 0, cancelable: true });
        if (!ev.defaultPrevented && !dialog.open) {
          winObj.scrollY = Math.max(0, winObj.scrollY + trackMomentum.vy);
        }
        sampleFrame("window-momentum");
      }
    }

    // 2) In-flight Blink compositor scroll-snap curve (zero wheel events).
    // Models Blink's real threaded compositor: once a snap curve starts, the compositor
    // keeps committing its curve frames over synchronous main-thread scrollLeft resets
    // (unless overflow: hidden tears down the scroll node or user input takes over).
    if (compositorSnap) {
      if (track.style.overflow === "hidden" || !dialog.open) {
        compositorSnap = null;
      } else {
        compositorSnap.step++;
        const p = Math.min(1, compositorSnap.step / compositorSnap.frames);
        const ease = 1 - (1 - p) ** 3;
        compositorSnap.committing = true;
        if (compositorSnap.targetX !== null) {
          track.scrollLeft = compositorSnap.startX + (compositorSnap.targetX - compositorSnap.startX) * ease;
        }
        if (compositorSnap.targetY !== null) {
          track.scrollTop = compositorSnap.startY + (compositorSnap.targetY - compositorSnap.startY) * ease;
        }
        compositorSnap.committing = false;
        queuedTrackScroll = false;
        track.dispatch("scroll");
        sampleFrame("compositor-snap");
        if (p >= 1) {
          compositorSnap = null;
          if (!trackMomentum && hasScrollEnd) {
            track.dispatch("scrollend");
            sampleFrame("scrollend");
          }
        }
      }
    } else if (queuedTrackScroll) {
      // Async browser scroll event queued by a programmatic scrollLeft/scrollTop write
      queuedTrackScroll = false;
      if (dialog.open && track.style.overflow !== "hidden") {
        track.dispatch("scroll");
        sampleFrame("async-scroll");
      }
    }
  }

  function stepFrame(dt = 16) {
    now += dt;
    tickCompositor();
    for (const [id, t] of [...timers.entries()].filter(([, t]) => t.at <= now)) { timers.delete(id); t.fn(); }
    const due = [...rafs.entries()];
    rafs.clear();
    for (const [, fn] of due) fn(now);
    sampleFrame("raf");
  }

  function advance(ms, dt = 16) {
    for (let t = 0; t < ms; t += dt) stepFrame(dt);
  }

  function wheelTick(dx, dy = 0, { cancelable = false, ctrlKey = false, metaKey = false, clientX = w / 2, clientY = h / 2, discrete = false, recordAsInput = true } = {}) {
    const prevInput = userInputActive;
    if (recordAsInput) userInputActive = true;
    if (recordAsInput) {
      compositorSnap = null;
      trackMomentum = null;
    }

    if (!dialog.open) {
      const ev = winObj.dispatch("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, ctrlKey, metaKey, clientX, clientY, cancelable });
      if (!ev.defaultPrevented && !ctrlKey && !metaKey) {
        winObj.scrollY = Math.max(0, winObj.scrollY + dy);
      }
      sampleFrame("window-wheel");
      userInputActive = prevInput;
      return ev;
    }

    const ev = stage.dispatch("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, ctrlKey, metaKey, clientX, clientY, cancelable });
    // Wheel bubbles to window (matching real DOM)
    if (!ev.defaultPrevented) {
      winObj.dispatch("wheel", ev);
    }
    if (!ev.defaultPrevented && !ctrlKey && !metaKey && track.style.overflow !== "hidden") {
      const mode = snapMode();
      const { ys } = snapTargets();
      // Model Blink's real scroll-snap-type: both mandatory single-Y-snap bug:
      // when only one Y snap target exists at scrollTop and a discrete vertical wheel arrives
      // while scrollY > 0, Blink rejects Y scroll on .track (consumes 0px).
      if (mode === "both" && discrete && dx === 0 && dy < 0 && ys.length === 1 && Math.abs(track.scrollTop - ys[0]) < 1 && winObj.scrollY > 0) {
        // Track refuses Y scroll -> would chain if background isn't locked
        sampleFrame("track-refused-y");
        userInputActive = prevInput;
        return ev;
      }
      const oldL = track.scrollLeft, oldT = track.scrollTop;
      track.scrollLeft += dx;
      track.scrollTop += dy;
      queuedTrackScroll = false;
      if (track.scrollLeft !== oldL || track.scrollTop !== oldT) {
        track.dispatch("scroll");
      }
    }
    sampleFrame("wheel");
    userInputActive = prevInput;
    return ev;
  }

  function releaseTrackpad({ vx = 0, vy = 0, snapFrames = 14, decay = 0.84 } = {}) {
    userInputActive = false;
    const mode = snapMode();
    const { xs, ys } = snapTargets();
    const hasXSnap = mode !== "none" && xs.length > 0;
    const hasYSnap = mode === "both" && ys.length > 0;
    const targetX = hasXSnap ? nearestTarget(track.scrollLeft + vx * 5, xs) : track.scrollLeft;
    const targetY = hasYSnap ? nearestTarget(track.scrollTop + vy * 5, ys) : track.scrollTop;

    const snapX = hasXSnap && Math.abs(targetX - track.scrollLeft) > 0.5;
    const snapY = hasYSnap && Math.abs(targetY - track.scrollTop) > 0.5;
    const hasFreeY = !hasYSnap && Math.abs(vy) >= 1;
    const hasFreeX = !hasXSnap && Math.abs(vx) >= 1;

    if (threadedCompositor && (snapX || snapY)) {
      compositorSnap = {
        startX: track.scrollLeft,
        startY: track.scrollTop,
        targetX: snapX ? targetX : null,
        targetY: snapY ? targetY : null,
        step: 0,
        frames: snapFrames,
        committing: false,
      };
    }
    if (hasFreeX || hasFreeY) {
      trackMomentum = { vx: hasFreeX ? vx : 0, vy: hasFreeY ? vy : 0, decay, onTrack: track.style.overflow !== "hidden" };
    } else if (!compositorSnap && hasScrollEnd) {
      setTimeoutMock(() => {
        if (dialog.open) {
          track.dispatch("scrollend");
          sampleFrame("scrollend");
        }
      }, 16);
    }
  }

  function triggerResize(newW, newH) {
    w = newW;
    h = newH;
    stage._rect = viewport._rect = { left: 0, top: 0, right: w, bottom: h, width: w, height: h };
    for (const cb of [...resizeCallbacks]) cb();
    sampleFrame("resize");
  }

  function resolveDecode(substr) {
    let count = 0;
    for (const entry of pendingDecodes) {
      if (!entry.settled && (!substr || entry.src.includes(substr))) {
        entry.settled = true;
        entry.resolve();
        count++;
      }
    }
    return count;
  }

  function rejectDecode(substr) {
    let count = 0;
    for (const entry of pendingDecodes) {
      if (!entry.settled && (!substr || entry.src.includes(substr))) {
        entry.settled = true;
        entry.reject(new Error("decode failed"));
        count++;
      }
    }
    return count;
  }

  function pointerEvent(type, ev = {}) {
    if (type === "pointerdown" || type === "pointermove") userInputActive = true;
    if (type === "pointerup" || type === "pointercancel" || type === "lostpointercapture") userInputActive = false;
    const res = stage.dispatch(type, ev);
    sampleFrame(type);
    return res;
  }

  // Semantic, aspect-ratio-agnostic hit-target helpers
  function hitPhoto(u = 0.5, v = 0.5) {
    const cur = currentFrame();
    const r = cur.getBoundingClientRect();
    return { clientX: r.left + r.width * u, clientY: r.top + r.height * v, target: cur };
  }

  function hitBackdrop() {
    const cur = currentFrame();
    const r = cur.getBoundingClientRect();
    if (r.left > 8) return { clientX: r.left / 2, clientY: h / 2, target: stage };
    if (r.right < w - 8) return { clientX: (r.right + w) / 2, clientY: h / 2, target: stage };
    if (r.top > 8) return { clientX: w / 2, clientY: r.top / 2, target: stage };
    if (r.bottom < h - 8) return { clientX: w / 2, clientY: (r.bottom + h) / 2, target: stage };
    return null;
  }

  function hitMinimap(u = 0.5, v = 0.5) {
    const r = map.getBoundingClientRect();
    return { clientX: r.left + r.width * u, clientY: r.top + r.height * v, target: map };
  }

  // Center-proximity dominant photo (invariant to portrait-vs-landscape pixel area)
  function dominantPhoto() {
    let bestAlt = "", bestDist = Infinity;
    for (const f of frames) {
      if (f.hidden || !f.firstElementChild) continue;
      const r = f.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const dist = Math.abs(cx - w / 2);
      if (dist < bestDist) { bestDist = dist; bestAlt = f.firstElementChild.alt; }
    }
    return bestAlt;
  }

  // Realistic macOS trackpad flick with active burst + decaying momentum tail (scrollend only after tail finishes)
  function macosTrackpadFlick({ vx = 0, vy = 0, burstFrames = 3, cancelableFirst = true, decay = 0.90 } = {}) {
    for (let i = 0; i < burstFrames; i++) {
      wheelTick(vx, vy, { cancelable: cancelableFirst && i === 0, recordAsInput: true });
      stepFrame(16);
    }
    releaseTrackpad({ vx, vy, decay });
  }

  // Replay a real browser-recorded JSON trace (from ?debug Rec) with exact millisecond timestamps and compositor scroll positions
  function replayRecordedEvents(events, { fromT = -Infinity, toT = Infinity, originSl = null, originSt = null } = {}) {
    const slice = events.filter(ev => ev.t >= fromT && ev.t <= toT);
    if (!slice.length) return;
    // Align recorded scroll coordinates to the simulator's live track origin when stage height differs (e.g. ?debug bar)
    const firstOpen = events.find(ev => ev.open && ev.state === "viewing" && typeof ev.sl === "number" && ev.sl > 0);
    const refSl = originSl ?? firstOpen?.sl ?? track.scrollLeft;
    const refSt = originSt ?? firstOpen?.st ?? track.scrollTop;
    const simSl0 = Math.max(0, (parseFloat(trackSpace.style.width) - w) / 2);
    const simSt0 = Math.max(0, parseFloat(trackSpace.style.height) - h);
    const mapSl = sl => refSl > 0 ? Math.round((sl / refSl) * simSl0) : sl;
    const mapSt = st => refSt > 0 ? Math.round((st / refSt) * simSt0) : st;
    const stepExact = ms => {
      let rem = ms;
      while (rem > 0) { const step = Math.min(16, rem); stepFrame(step); rem -= step; }
    };
    let lastT = slice[0].t;
    for (const ev of slice) {
      const dt = Math.max(0, ev.t - lastT);
      if (dt > 0) stepExact(dt);
      lastT = ev.t;
      if (ev.type === "wheel") {
        const cx = (ev.stageUV?.[0] ?? 0.5) * w, cy = (ev.stageUV?.[1] ?? 0.5) * h;
        const stillOpen = dialog.open && lightbox.state !== "closing";
        if (stillOpen && !ev.cancelable && typeof ev.sl === "number" && typeof ev.st === "number") {
          track.scrollLeft = mapSl(ev.sl);
          track.scrollTop = mapSt(ev.st);
        }
        const payload = {
          deltaX: ev.dx || 0, deltaY: ev.dy || 0, deltaMode: 0,
          ctrlKey: Boolean(ev.ctrl), metaKey: Boolean(ev.meta),
          cancelable: Boolean(ev.cancelable), clientX: cx, clientY: cy,
          ...(typeof ev.momentum === "boolean" ? { momentum: ev.momentum } : {}),
        };
        if (stillOpen) {
          const res = stage.dispatch("wheel", payload);
          if (!res.defaultPrevented && ev.cancelable && typeof ev.sl === "number" && typeof ev.st === "number") {
            track.scrollLeft = mapSl(ev.sl);
            track.scrollTop = mapSt(ev.st);
          }
        } else {
          winObj.dispatch("wheel", payload);
        }
        sampleFrame("trace:wheel");
      } else if (ev.type === "scroll") {
        if (dialog.open && lightbox.state !== "closing") {
          if (typeof ev.sl === "number") track.scrollLeft = mapSl(ev.sl);
          if (typeof ev.st === "number") track.scrollTop = mapSt(ev.st);
          track.dispatch("scroll");
          sampleFrame("trace:scroll");
        }
      } else if (ev.type === "scrollend") {
        if (dialog.open && lightbox.state !== "closing") {
          if (typeof ev.sl === "number") track.scrollLeft = mapSl(ev.sl);
          if (typeof ev.st === "number") track.scrollTop = mapSt(ev.st);
          track.dispatch("scrollend");
          sampleFrame("trace:scrollend");
        }
      } else if (ev.type === "keydown") {
        winObj.dispatch("keydown", {
          key: ev.key, shiftKey: Boolean(ev.shift), ctrlKey: Boolean(ev.ctrl),
          metaKey: Boolean(ev.meta), altKey: Boolean(ev.altKey), target: dialog,
        });
        sampleFrame("trace:keydown");
      }
    }
  }

  function startRecording() { trace.length = 0; recording = true; sampleFrame("start"); }
  function stopRecording() { recording = false; return [...trace]; }
  function setUserInput(v) { userInputActive = v; }

  function measureHotPath(fn) {
    for (const k of Object.keys(stats)) stats[k] = 0;
    layoutDirty = false;
    counting = true;
    const t0 = performance.now();
    fn();
    const ms = performance.now() - t0;
    counting = false;
    return { ms, ...stats };
  }

  return {
    docEl, head, body, dialog, stage, track, trackSpace, viewport, frames, map, bounds, notice, tiles,
    closeEvents, decodedUrls, pendingDecodes, trace, lightbox, win: winObj,
    get lastFocusedTile() { return lastFocusedTile; },
    open: i => openCb(i), currentFrame, stepFrame, advance, wheelTick, releaseTrackpad, pointerEvent,
    hitPhoto, hitBackdrop, hitMinimap, dominantPhoto, macosTrackpadFlick, replayRecordedEvents,
    triggerResize, resolveDecode, rejectDecode, startRecording, stopRecording, setUserInput,
    measureHotPath, getNow: () => now,
  };
}

// --- Layer 1: Per-frame visual invariant assertions ---

export function assertNoBlankFrames(framesLog) {
  for (const f of framesLog) {
    if (!f.open || f.state === "closed") continue;
    assert.ok(f.childCount >= 1, `Blank frame at t=${f.t} (state=${f.state}, edge=${f.edge})`);
    assert.ok(f.activeSrc.length > 0, `Empty img src at t=${f.t} (state=${f.state})`);
  }
}

export function assertNoStateOscillation(framesLog) {
  // Within any contiguous autonomous (userInput === false) run, once a state is left it must not be re-entered.
  let seen = new Set(), current = null, seq = [];
  for (const f of framesLog) {
    if (f.userInput) {
      seen = new Set();
      current = null;
      seq = [];
      continue;
    }
    if (f.state !== current) {
      if (seen.has(f.state)) {
        assert.fail(`State oscillation detected without user input: ${[...seq, f.state].join(" -> ")} at t=${f.t}`);
      }
      if (current !== null) seen.add(current);
      current = f.state;
      seq.push(f.state);
    }
  }
}

export function assertMonotonicAutonomous(framesLog, prop, { eps = 0.5 } = {}) {
  // Check monotonicity of `tx`, `ty`, `sx`, `page`, `scale`, or `shade` during autonomous frames
  // for a single photo (resets cleanly if activeAlt changes or userInput toggles).
  let prev = null, dir = 0;
  for (const f of framesLog) {
    if (f.userInput || !f.open) { prev = null; dir = 0; continue; }
    if (prev && prev.activeAlt === f.activeAlt) {
      const delta = f[prop] - prev[prop];
      if (Math.abs(delta) > eps) {
        const stepDir = Math.sign(delta);
        if (dir !== 0 && stepDir !== dir) {
          assert.fail(
            `Non-monotonic ${prop} reversal at t=${f.t} (state=${f.state}, edge=${f.edge}): ` +
            `${prev[prop].toFixed(2)} -> ${f[prop].toFixed(2)} (expected dir ${dir > 0 ? "+" : "-"})`
          );
        }
        dir = stepDir;
      }
    } else {
      dir = 0;
    }
    prev = f;
  }
}

export function assertMaxAutonomousJump(framesLog, { maxTx = 180, maxScale = 0.2 } = {}) {
  let prev = null;
  for (const f of framesLog) {
    if (f.userInput || !f.open) { prev = null; continue; }
    if (prev && prev.activeAlt === f.activeAlt) {
      const dtx = Math.abs(f.tx - prev.tx);
      const ds = Math.abs(f.sx - prev.sx);
      assert.ok(
        dtx <= maxTx,
        `Frame-to-frame tx teleport at t=${f.t} (state=${f.state}, edge=${f.edge}): ` +
        `${prev.tx.toFixed(1)} -> ${f.tx.toFixed(1)} (|dtx|=${dtx.toFixed(1)} > ${maxTx})`
      );
      assert.ok(
        ds <= maxScale,
        `Frame-to-frame scale jump at t=${f.t} (state=${f.state}, edge=${f.edge}): ` +
        `${prev.sx.toFixed(3)} -> ${f.sx.toFixed(3)} (|ds|=${ds.toFixed(3)} > ${maxScale})`
      );
    }
    prev = f;
  }
}

export function assertFrame0Continuity(beforeRect, afterRect, eps = 1.0) {
  for (const k of ["left", "top", "width", "height"]) {
    const diff = Math.abs(afterRect[k] - beforeRect[k]);
    assert.ok(diff <= eps, `Frame-0 continuity broken on ${k}: ${beforeRect[k].toFixed(2)} -> ${afterRect[k].toFixed(2)} (diff=${diff.toFixed(2)})`);
  }
}

export function assertScrollYConstant(framesLog, expectedScrollY) {
  for (const f of framesLog) {
    assert.equal(f.scrollY, expectedScrollY, `Background scrollY drifted at t=${f.t} (state=${f.state}): ${f.scrollY} !== ${expectedScrollY}`);
  }
}

export function assertResponsivePull(framesLog, { afterT, maxLagMs = 48, maxScale = 0.95, label = "pull" } = {}) {
  const windowFrames = framesLog.filter(f => f.t >= afterT && f.t <= afterT + maxLagMs);
  assert.ok(windowFrames.length > 0, `${label}: no frames recorded in [${afterT}, ${afterT + maxLagMs}]`);
  const responded = windowFrames.some(f => f.scale < maxScale || f.state === "pulling" || f.state === "closing" || !f.open);
  assert.ok(
    responded,
    `${label}: photo stayed FROZEN after downward swipe (scales=[${windowFrames.map(f => f.scale.toFixed(2)).join(",")}], states=[${windowFrames.map(f => f.state).join(",")}])`
  );
}

export function assertNoWallFreeze(framesLog, { afterT, maxFrozenMs = 450, label = "release" } = {}) {
  // After an aggressive released flick hits scrollTop <= 1, the viewer must transition to closing/closed
  // within maxFrozenMs rather than sitting frozen motionless for a 1.2s macOS momentum tail.
  const wallFrame = framesLog.find(f => f.t >= afterT && f.open && f.trackTop <= 1);
  if (!wallFrame) return;
  const closedOrClosing = framesLog.find(f => f.t >= wallFrame.t && (f.state === "closing" || !f.open));
  const waited = closedOrClosing ? closedOrClosing.t - wallFrame.t : (framesLog[framesLog.length - 1].t - wallFrame.t);
  assert.ok(
    closedOrClosing && waited <= maxFrozenMs,
    `${label}: photo froze at scrollTop=0 for ${waited}ms (limit ${maxFrozenMs}ms) during momentum tail`
  );
}

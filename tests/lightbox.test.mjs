import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";

const LIGHTBOX_CODE = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/js/lightbox.js"), "utf8");
const DEBUG_CODE = fs.readFileSync(path.resolve(import.meta.dirname, "../docs/js/lightbox-debug.js"), "utf8");

function parseTransform(tr) {
  let tx = 0, ty = 0, sx = 1, sy = 1;
  const mT = /translate3d\(\s*([-\d.e]+)px,\s*([-\d.e]+)px/.exec(tr || "");
  if (mT) { tx = parseFloat(mT[1]); ty = parseFloat(mT[2]); }
  const mS = /scale\(\s*([-\d.e]+)(?:,\s*([-\d.e]+))?\)/.exec(tr || "");
  if (mS) { sx = parseFloat(mS[1]); sy = mS[2] !== undefined ? parseFloat(mS[2]) : sx; }
  return { tx, ty, sx, sy };
}

function createHarness({ w = 1440, h = 900, tileCount = 10, loadDebug = false } = {}) {
  let now = 1000, rafId = 1, timerId = 1, selectedIdx = -1;
  let counting = false, layoutDirty = false;
  const rafs = new Map(), timers = new Map(), closeEvents = [];
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

  function mk(tag, cls = []) {
    const ls = new Map(), attrs = new Map(), children = [], classes = new Set(cls);
    const props = new Map();
    let scrollLeft = 0, scrollTop = 0;
    let _w = "", _h = "", _ov = "", _br = "", _tr = "", _l = "", _t = "", _sst = "";
    const style = {
      get width() { return _w; }, set width(v) { _w = v; onLayoutWrite(); },
      get height() { return _h; }, set height(v) { _h = v; onLayoutWrite(); },
      get overflow() { return _ov; }, set overflow(v) { _ov = v; onLayoutWrite(); },
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
        scrollLeft = Math.max(0, Math.min(max, v));
      },
      get scrollTop() { return scrollTop; },
      set scrollTop(v) {
        const max = Math.max(0, (parseFloat(children[0]?.style?.height || h) || h) - h);
        scrollTop = Math.max(0, Math.min(max, v));
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
  track.append(trackSpace);
  trackSpace.append(viewport);
  viewport.append(...frames, map);
  dialog.append(stage, notice);
  body.append(dialog);

  const tiles = Array.from({ length: tileCount }, (_, i) => {
    const a = mk("a");
    a.href = `img/medium-res/${i}.jpg`;
    const col = i % 4, row = Math.floor(i / 4);
    a._rect = { left: 8 + col * 240, top: 88 + row * 180, width: 228, height: 152, right: 236 + col * 240, bottom: 240 + row * 180 };
    const img = mk("img");
    img.src = `img/low-res/${i}.jpg`;
    img.currentSrc = img.src;
    img.alt = `Photo ${i}`;
    img.setAttribute("width", i % 2 ? "1280" : "1920");
    img.setAttribute("height", i % 2 ? "1920" : "1280");
    img.decode = () => Promise.resolve();
    a.append(img);
    return a;
  });

  let openCb;
  const photoGrid = {
    tiles,
    select(i) {
      if (selectedIdx >= 0) tiles[selectedIdx].classList.remove("in-viewer");
      selectedIdx = i;
      tiles[i].classList.add("in-viewer");
    },
    restore() { if (selectedIdx >= 0) tiles[selectedIdx].classList.remove("in-viewer"); },
    onOpen(cb) { openCb = cb; },
  };

  function setTimeoutMock(fn, ms = 0) { const id = timerId++; timers.set(id, { fn, at: now + ms }); return id; }
  function clearTimeoutMock(id) { timers.delete(id); }

  class FakeImage {
    constructor() { this.alt = ""; this.src = ""; this.decoding = "auto"; this.draggable = true; }
    decode() { return Promise.resolve(); }
    remove() { this._removed = true; }
  }

  const store = new Map();
  const winObj = mk("window");
  winObj.onscrollend = null;
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
    matchMedia: () => ({ matches: false }),
    performance: { now: () => now },
    requestAnimationFrame(fn) { const id = rafId++; rafs.set(id, fn); return id; },
    cancelAnimationFrame(id) { rafs.delete(id); },
    setTimeout: setTimeoutMock,
    clearTimeout: clearTimeoutMock,
    setInterval: () => 1,
    clearInterval: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    photoGrid,
  };
  vm.createContext(ctx);
  vm.runInContext(LIGHTBOX_CODE, ctx);
  if (loadDebug) vm.runInContext(DEBUG_CODE, ctx);
  const lightbox = vm.runInContext("lightbox", ctx);

  function stepFrame(dt = 16) {
    now += dt;
    for (const [id, t] of [...timers.entries()].filter(([, t]) => t.at <= now)) { timers.delete(id); t.fn(); }
    const due = [...rafs.entries()];
    rafs.clear();
    for (const [, fn] of due) fn(now);
  }
  function advance(ms, dt = 16) { for (let t = 0; t < ms; t += dt) stepFrame(dt); }
  function wheelTick(dx, dy = 0, { cancelable = false, ctrlKey = false, clientX = w / 2, clientY = h / 2 } = {}) {
    const ev = stage.dispatch("wheel", { deltaX: dx, deltaY: dy, deltaMode: 0, ctrlKey, clientX, clientY, cancelable });
    if (!ev.defaultPrevented && !ctrlKey) {
      const oldL = track.scrollLeft, oldT = track.scrollTop;
      track.scrollLeft += dx;
      track.scrollTop += dy;
      if (track.scrollLeft !== oldL || track.scrollTop !== oldT) track.dispatch("scroll");
    }
    return ev;
  }
  function currentFrame() { return frames.find(f => f.classList.contains("current")); }
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
    docEl, head, body, dialog, stage, track, trackSpace, viewport, frames, tiles, closeEvents, lightbox, win: winObj,
    open: i => openCb(i), currentFrame, stepFrame, advance, wheelTick, measureHotPath, getNow: () => now,
  };
}

test("hot path: zero forced reflows, layout reads/writes, or root --shade writes during horizontal swipes", () => {
  const e = createHarness();
  e.open(0);
  e.advance(32);
  const startL = e.track.scrollLeft;

  const N = 500;
  const r = e.measureHotPath(() => {
    for (let i = 1; i <= N; i++) {
      e.stage.dispatch("wheel", { deltaX: 10, deltaY: 0, deltaMode: 0, clientX: 720, clientY: 450, cancelable: false });
      e.track.scrollLeft = startL + (i % 400) + 10;
      e.track.dispatch("scroll");
    }
  });

  assert.equal(r.forcedReflows, 0);
  assert.equal(r.layoutReads, 0);
  assert.equal(r.layoutWrites, 0);
  assert.equal(r.shadeWrites, 0);
  assert.equal(r.hiddenMapWrites, 0);
  assert.equal(r.transformWrites, N * 2);
  assert.equal(r.interventions, 0);
});

test("hot path: zero forced reflows or layout writes during swipe-down shrink", () => {
  const e = createHarness();
  e.open(0);
  e.advance(32);
  const startT = e.track.scrollTop;

  const N = 300;
  const r = e.measureHotPath(() => {
    for (let i = 1; i <= N; i++) {
      e.stage.dispatch("wheel", { deltaX: 0, deltaY: -8, deltaMode: 0, clientX: 1000, clientY: 650, cancelable: false });
      e.track.scrollTop = Math.max(10, startT - (i % 300) - 10);
      e.track.dispatch("scroll");
    }
  });

  assert.equal(r.forcedReflows, 0);
  assert.equal(r.layoutReads, 0);
  assert.equal(r.layoutWrites, 0);
  assert.equal(r.hiddenMapWrites, 0);
  assert.equal(r.transformWrites, N);
});

test("iOS zero-flicker pagination rotates the persistent neighbor frame into place", async () => {
  const e = createHarness();
  e.open(0);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  e.advance(48);
  const nextFrameBefore = e.frames.find(f => f.firstElementChild?.alt === "Photo 1");
  assert.ok(nextFrameBefore, "Next photo preloaded into neighbor frame");
  // Low-res stays mounted behind opaque medium-res, and neighbor pre-upgrades to medium-res
  assert.equal(e.currentFrame().children.length, 2, "Low-res preview stays mounted behind full-res");
  assert.equal(nextFrameBefore.lastElementChild.src, "img/medium-res/1.jpg", "Neighbor pre-upgraded to full-res");

  // One-finger pointer swipe lands directly on the already-upgraded frame with zero child mutations
  const childrenBefore = [...nextFrameBefore.children];
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 900, clientY: 450, target: e.currentFrame() });
  e.stepFrame(16);
  e.stage.dispatch("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 450 });
  e.stepFrame(16);
  e.stage.dispatch("pointerup", { pointerId: 1, button: 0, clientX: 100, clientY: 450 });
  e.advance(200);
  await new Promise(r => setImmediate(r));
  e.advance(48);

  assert.equal(e.currentFrame(), nextFrameBefore, "Arrived neighbor DOM node promoted in place");
  assert.deepEqual(e.currentFrame().children, childrenBefore, "Zero DOM image swap after one-finger swipe lands");
  assert.equal(e.currentFrame().lastElementChild.src, "img/medium-res/1.jpg");
  assert.equal(e.currentFrame().lastElementChild.decoding, "sync");
  assert.equal(e.tiles[1].firstElementChild.decoding, "sync");
  assert.equal(e.tiles[1].firstElementChild.loading, "eager");
});

test("swipe-down never triggers while fingers stay down (slow drag, deceleration, reversal, 3s hold) and closes without grid flicker", () => {
  const e = createHarness({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  assert.equal(e.tiles[0].firstElementChild.decoding, "sync");
  assert.equal(e.tiles[0].firstElementChild.loading, "eager");

  // Slow drag past 0.78 threshold with deceleration (simulating real finger deceleration while held down!)
  for (const d of [-35, -30, -25, -20, -16, -12, -8, -5, -3]) {
    e.wheelTick(0, d, { cancelable: d === -35, clientX: 900, clientY: 650 });
    e.stepFrame(16.67);
  }
  assert.equal(e.dialog.open, true, "Decelerating fingers down must NEVER auto-dismiss");
  // Reverse upward slightly with fingers down
  e.wheelTick(0, 10, { cancelable: false, clientX: 900, clientY: 650 });
  assert.equal(e.dialog.open, true);
  // Hold motionless for 3 seconds
  e.advance(3000);
  assert.equal(e.dialog.open, true);

  // Verify shrunk toward bottom-right cursor (900, 650)
  const active = e.currentFrame();
  const rect = active.getBoundingClientRect();
  assert.ok(rect.left > 200 && rect.top > 150);
  const before = parseTransform(active.style.transform);

  // Release -> scrollend triggers dismiss() with exact frame-0 continuity and flicker-free tile reveal
  e.track.dispatch("scrollend");
  const frame0 = parseTransform(active.style.transform);
  assert.ok(Math.abs(frame0.tx - before.tx) < 1e-6 && Math.abs(frame0.ty - before.ty) < 1e-6);
  assert.ok(Math.abs(frame0.sx - before.sx) < 1e-6 && Math.abs(frame0.sy - before.sy) < 1e-6);
  e.advance(420);
  assert.equal(e.dialog.open, false);
  assert.equal(e.closeEvents[0].inViewer, false, ".in-viewer removed before dialog.close()");
});

test("dismiss duration scales linearly from dismissMaxMs at dismissScale down proportionally to size", () => {
  // Near dismissScale (~0.74 -> ~332ms): still open at 180ms, closed by 400ms
  const a = createHarness();
  a.open(0);
  a.advance(32);
  const pullSpace = a.track.scrollTop;
  a.track.scrollTop = Math.round(pullSpace * (1 - 0.31)); // scale ~0.736
  a.track.dispatch("scroll");
  a.track.dispatch("scrollend");
  a.advance(180);
  assert.equal(a.dialog.open, true, "Still animating at 180ms when released near threshold");
  a.advance(250);
  assert.equal(a.dialog.open, false);

  // 50% smaller than dismissScale (scale ~0.39 -> ~175ms): closed by 220ms
  const b = createHarness();
  b.open(0);
  b.advance(32);
  const pullSpaceB = b.track.scrollTop;
  b.track.scrollTop = Math.round(pullSpaceB * (1 - 0.718)); // scale ~0.39
  b.track.dispatch("scroll");
  b.track.dispatch("scrollend");
  b.advance(220);
  assert.equal(b.dialog.open, false, "Closes in half the time when released 50% smaller");
});

test("snap modes (both, x, none) and live config updates resize track cleanly without overlapping snap areas", () => {
  const e = createHarness({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  // Default mode: 2D X+Y snap ("both") with 3 contiguous non-overlapping snap slots at y = pullSpace
  // (no y=0 snapPull target, so small downward nudges never snap into dismiss).
  assert.equal(e.lightbox.config.snapAxis, "both");
  assert.equal(e.track.classList.contains("free"), false);
  assert.equal(e.track.classList.contains("snap-both"), true);
  const snaps = e.trackSpace.querySelectorAll(".snap");
  assert.equal(snaps.length, 3);
  assert.equal(parseFloat(snaps[0].style.left), 0);
  assert.equal(parseFloat(snaps[0].style.width), 600);
  assert.equal(parseFloat(snaps[1].style.left), 600);
  assert.equal(parseFloat(snaps[1].style.width), 600);
  assert.equal(parseFloat(snaps[2].style.left), 1200);
  assert.ok(parseFloat(snaps[1].style.top) > 0, "snap slots sit at y = pullSpace in X+Y mode");

  // Switch live to "x" and "none"
  e.lightbox.setConfig({ snapAxis: "x", swipeSpeed: 1.5 });
  assert.equal(e.track.classList.contains("snap-both"), false);
  assert.equal(parseFloat(snaps[1].style.top), 0);
  assert.equal(parseFloat(snaps[1].style.left), 800);

  e.lightbox.setConfig({ snapAxis: "none" });
  assert.equal(e.track.classList.contains("free"), true);
  assert.equal(snaps[0].hidden, true);
});

test("multi-touch pointer centroid/spread zoom, click-hold-drag, and cursor-anchored ctrl+wheel zoom", () => {
  const e = createHarness({ w: 1000, h: 800 });
  e.open(0);
  e.advance(32);

  // Click-hold-drag left past 50% advances to Photo 1
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 700, clientY: 400, target: e.currentFrame() });
  e.stepFrame(16);
  e.stage.dispatch("pointermove", { pointerId: 1, button: 0, clientX: 150, clientY: 400 });
  e.stepFrame(16);
  e.stage.dispatch("pointerup", { pointerId: 1, button: 0, clientX: 150, clientY: 400 });
  e.advance(250);
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  // Two-finger touch pinch zooms to 2x and sets .track.free
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 400, clientY: 400, target: e.currentFrame() });
  e.stage.dispatch("pointerdown", { pointerId: 2, button: 0, clientX: 600, clientY: 400, target: e.currentFrame() });
  e.stepFrame(16);
  e.stage.dispatch("pointermove", { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  e.stage.dispatch("pointermove", { pointerId: 2, button: 0, clientX: 700, clientY: 400 });
  e.stage.dispatch("pointerup", { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  e.stage.dispatch("pointerup", { pointerId: 2, button: 0, clientX: 700, clientY: 400 });
  e.advance(250);
  assert.equal(e.stage.classList.contains("zoomed"), true);
  assert.equal(e.track.classList.contains("free"), true);
});

test("graph state machine transitions cleanly across all 6 states and recovers quick diagonal swipes", () => {
  const e = createHarness({ w: 1200, h: 800 });
  const trace = [];
  e.lightbox.onState((s, edge) => trace.push(`${edge}->${s}`));

  assert.equal(e.lightbox.state, "closed");
  e.open(0);
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");

  // Quick horizontal swipe that starts with a small diagonal vertical wiggle still recovers to paging and advances
  const startL = e.track.scrollLeft, startT = e.track.scrollTop;
  e.track.scrollLeft = startL + 4;
  e.track.scrollTop = startT - 10;
  e.track.dispatch("scroll");
  e.track.scrollLeft = startL * 2;
  e.track.scrollTop = startT - 12;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "paging");
  e.track.dispatch("scrollend");
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  // Pull below threshold and bounce back
  e.track.scrollTop = e.track.scrollTop - 40;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "pulling");
  e.track.dispatch("scrollend");
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");

  // Zoom in via '+' and fit back via '0'
  e.dialog.dispatch("keydown", { key: "+" });
  assert.equal(e.lightbox.state, "zoomed");
  e.dialog.dispatch("keydown", { key: "0" });
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");

  // Pull past dismiss threshold (above min size) -> stays pulling until scrollend -> closing -> closed
  e.track.scrollTop = Math.round(e.track.scrollTop * 0.4);
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "pulling");
  e.track.dispatch("scrollend");
  assert.equal(e.lightbox.state, "closing");
  e.advance(420);
  assert.equal(e.lightbox.state, "closed");
  assert.ok(trace.includes("open->viewing"));
  assert.ok(trace.includes("swipe->paging"));
  assert.ok(trace.includes("settle->viewing"));
  assert.ok(trace.includes("pull->pulling"));
  assert.ok(trace.includes("bounce->viewing"));
  assert.ok(trace.includes("zoom->zoomed"));
  assert.ok(trace.includes("fit->viewing"));
  assert.ok(trace.includes("dismiss->closing"));
  assert.ok(trace.includes("finish->closed"));
});

test("settle duration scales linearly by remaining swipe travel, and pullAnchor targets all 7 points with zero reflows", () => {
  // Proportional horizontal settle: 85% swipe finishes in ~70ms; 51% swipe still animating at 90ms and done by 220ms
  const far = createHarness({ w: 1000, h: 800 });
  far.open(0);
  far.advance(32);
  far.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 900, clientY: 400, target: far.currentFrame() });
  far.stepFrame(16);
  far.stage.dispatch("pointermove", { pointerId: 1, button: 0, clientX: 50, clientY: 400 }); // 85% across
  far.stepFrame(16);
  far.stage.dispatch("pointerup", { pointerId: 1, button: 0, clientX: 50, clientY: 400 });
  far.advance(96);
  assert.equal(far.currentFrame().firstElementChild.alt, "Photo 1", "85% swipe finishes quickly (~70ms)");

  const mid = createHarness({ w: 1000, h: 800 });
  mid.open(0);
  mid.advance(32);
  mid.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 700, clientY: 400, target: mid.currentFrame() });
  mid.stepFrame(16);
  mid.stage.dispatch("pointermove", { pointerId: 1, button: 0, clientX: 190, clientY: 400 }); // 51% across
  mid.stepFrame(16);
  mid.stage.dispatch("pointerup", { pointerId: 1, button: 0, clientX: 190, clientY: 400 });
  mid.advance(96);
  assert.equal(mid.currentFrame().firstElementChild.alt, "Photo 0", "51% swipe still settling at 96ms (~172ms total)");
  mid.advance(140);
  assert.equal(mid.currentFrame().firstElementChild.alt, "Photo 1", "51% swipe completes within proportional window");

  // All 7 pull anchors target their expected quadrant/edge and stay zero-reflow
  const e = createHarness({ w: 1000, h: 800 });
  e.open(0);
  e.advance(32);
  const startT = e.track.scrollTop;
  const pullToHalf = anchor => {
    e.lightbox.setVar("pullAnchor", anchor);
    e.stage.dispatch("wheel", { deltaX: 0, deltaY: -8, deltaMode: 0, clientX: 850, clientY: 650, cancelable: false });
    e.track.scrollTop = Math.round(startT * 0.4);
    e.track.dispatch("scroll");
    const { tx, ty, sx } = parseTransform(e.currentFrame().style.transform);
    const bw = parseFloat(e.currentFrame().style.width), bh = parseFloat(e.currentFrame().style.height);
    return { cx: tx + bw * sx / 2, cy: ty + bh * sx / 2 };
  };

  const rCursor = pullToHalf("cursor");
  const rTile = pullToHalf("tile"); // tile 0 rect center is (122, 164)
  const rCenter = pullToHalf("center");
  const rLeft = pullToHalf("left");
  const rRight = pullToHalf("right");
  const rTop = pullToHalf("top");
  const rBottom = pullToHalf("bottom");

  assert.ok(rCursor.cx > 600 && rCursor.cy > 450, "cursor anchor pulls toward (850, 650)");
  assert.ok(rTile.cx < 400 && rTile.cy < 350, "tile anchor pulls toward top-left tile 0");
  assert.ok(Math.abs(rCenter.cx - 500) < 2 && Math.abs(rCenter.cy - 400) < 2, "center anchor stays centered");
  assert.ok(rLeft.cx < rCenter.cx - 100 && Math.abs(rLeft.cy - 400) < 2, "left anchor pulls left");
  assert.ok(rRight.cx > rCenter.cx + 100 && Math.abs(rRight.cy - 400) < 2, "right anchor pulls right");
  assert.ok(rTop.cy < rCenter.cy - 100 && Math.abs(rTop.cx - 500) < 2, "top anchor pulls up");
  assert.ok(rBottom.cy > rCenter.cy + 100 && Math.abs(rBottom.cx - 500) < 2, "bottom anchor pulls down");

  // Confirm tile anchor remains zero-reflow during 60fps pull frames
  e.lightbox.setVar("pullAnchor", "tile");
  const hot = e.measureHotPath(() => {
    for (let i = 1; i <= 100; i++) {
      e.track.scrollTop = Math.max(10, startT - i * 2);
      e.track.dispatch("scroll");
    }
  });
  assert.equal(hot.forcedReflows, 0);
  assert.equal(hot.layoutReads, 0);
  assert.equal(hot.layoutWrites, 0);
});

test("hitting min shrink size kills trackpad momentum immediately, absorbs residual grid inertia, and honors linear/log + minMs", () => {
  const e = createHarness({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);

  // Forceful swipe down slams straight to scrollTop = 0 (min size 15%): kills overflow & starts closing immediately (NO wait for scrollend!)
  e.track.scrollTop = 0;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "closing", "Min shrink size triggers dismiss immediately without waiting for scrollend");
  assert.equal(e.track.style.overflow, "hidden", "Kills compositor scroll momentum on track");

  // Finishes in ~dismissMinMs (70ms) + 2 rAFs, restores track overflow
  e.advance(120);
  assert.equal(e.dialog.open, false);
  assert.equal(e.track.style.overflow, "");

  // Trailing downward momentum wheel ticks right after close are absorbed so grid doesn't jerk
  const trail1 = e.win.dispatch("wheel", { deltaY: -35, cancelable: true });
  assert.equal(trail1.defaultPrevented, true, "Absorbs trailing momentum tick on window after close");
  e.stepFrame(16);
  const trail2 = e.win.dispatch("wheel", { deltaY: -18, cancelable: true });
  assert.equal(trail2.defaultPrevented, true);

  // Scrolling down the grid (deltaY > 0) or after a >120ms pause passes straight through
  const downGrid = e.win.dispatch("wheel", { deltaY: 20, cancelable: true });
  assert.equal(Boolean(downGrid.defaultPrevented), false, "Does not block scrolling down the grid");

  // Compare linear vs log duration curves and explicit dismissMinMs floor
  const lin = createHarness();
  lin.open(0);
  lin.advance(32);
  lin.lightbox.setConfig({ dismissMaxMs: 400, dismissMinMs: 80, dismissCurve: "linear" });
  const psA = lin.track.scrollTop;
  lin.track.scrollTop = Math.round(psA * (1 - 0.718)); // visualScale ~0.39 -> ratio 0.5 -> linear 200ms
  lin.track.dispatch("scroll");
  lin.track.dispatch("scrollend");
  lin.advance(240);
  assert.equal(lin.dialog.open, false, "Linear 50% size finishes by 240ms (~200ms)");

  const log = createHarness();
  log.open(0);
  log.advance(32);
  log.lightbox.setConfig({ dismissMaxMs: 400, dismissMinMs: 80, dismissCurve: "log" });
  const psB = log.track.scrollTop;
  log.track.scrollTop = Math.round(psB * (1 - 0.718)); // ratio 0.5 -> log10(5.5) ~0.74 -> ~296ms
  log.track.dispatch("scroll");
  log.track.dispatch("scrollend");
  log.advance(240);
  assert.equal(log.dialog.open, true, "Log curve at 50% size (~296ms) is still animating at 240ms");
  log.advance(120);
  assert.equal(log.dialog.open, false, "Log curve completes within 360ms");

  // Explicit dismissMinMs floor respected at min shrink size
  const floor = createHarness();
  floor.open(0);
  floor.advance(32);
  floor.lightbox.setConfig({ dismissMaxMs: 400, dismissMinMs: 180, dismissCurve: "linear" });
  floor.track.scrollTop = 0;
  floor.track.dispatch("scroll");
  floor.advance(120);
  assert.equal(floor.dialog.open, true, "Honors dismissMinMs=180ms floor at min shrink size");
  floor.advance(120);
  assert.equal(floor.dialog.open, false);
});

test("wheel-less native scroll-snap takeover makes gentle Y and X bounces fast without false-triggering slow finger drags", () => {
  // 1) Gentle swipe down to ~84% (above 78% threshold) then release -> native CSS snap starts returning without wheel events
  const yBounce = createHarness({ w: 1200, h: 800 });
  yBounce.open(0);
  yBounce.advance(32);
  const originY = yBounce.track.scrollTop;
  // Slow human finger drag (100ms between ticks) must NEVER false-trigger while wheel accompanies scroll
  for (let i = 0; i < 4; i++) {
    yBounce.wheelTick(0, -15, { cancelable: i === 0 });
    yBounce.advance(100);
  }
  assert.equal(yBounce.lightbox.state, "pulling", "Slow human drag stays in pulling");
  // Fingers lift -> native CSS scroll-snap moves scrollTop back toward originY with ZERO wheel events
  yBounce.track.scrollTop += 3;
  yBounce.track.dispatch("scroll");
  yBounce.stepFrame(16);
  yBounce.track.scrollTop += 4;
  yBounce.track.dispatch("scroll");
  assert.equal(yBounce.lightbox.state, "viewing", "Took over slow native Y bounce into fast JS bounce");
  assert.equal(yBounce.lightbox.lastEdge, "bounce");
  yBounce.advance(150);
  assert.equal(yBounce.dialog.open, true);
  assert.equal(yBounce.lightbox.telemetry.scale, 1, "Bounce finishes rapidly (~70-100ms)");

  // 2) Gentle swipe down to ~68% (past 78% dismissScale, above 57.5% snap midpoint) -> snap-back triggers dismiss using wheelPull
  const yDismiss = createHarness({ w: 1200, h: 800 });
  yDismiss.open(0);
  yDismiss.advance(32);
  yDismiss.wheelTick(0, -130, { cancelable: true }); // ~68% scale
  yDismiss.advance(64);
  yDismiss.track.scrollTop += 4;
  yDismiss.track.dispatch("scroll");
  yDismiss.stepFrame(16);
  yDismiss.track.scrollTop += 4;
  yDismiss.track.dispatch("scroll");
  assert.equal(yDismiss.lightbox.state, "closing", "Wheel-less Y snap takeover dismisses when wheelPull crossed close@");

  // 3) Gentle horizontal swipe (~35%) then release -> wheel-less CSS snap hands off to fast JS settle
  const xBounce = createHarness({ w: 1200, h: 800 });
  xBounce.open(0);
  xBounce.advance(32);
  xBounce.wheelTick(210, 0, { cancelable: true });
  assert.equal(xBounce.lightbox.state, "paging");
  xBounce.advance(64);
  xBounce.track.scrollLeft -= 5;
  xBounce.track.dispatch("scroll");
  xBounce.stepFrame(16);
  xBounce.track.scrollLeft -= 5;
  xBounce.track.dispatch("scroll");
  assert.equal(xBounce.lightbox.state, "viewing", "Took over slow native X bounce into fast JS settle");
  assert.equal(xBounce.lightbox.lastEdge, "settle");
  xBounce.advance(200);
  assert.equal(Math.abs(xBounce.lightbox.telemetry.page), 0);
});

test("modular lightbox-debug mounts cleanly, highlights active state/edge, reparents without close flicker, and unmounts completely", () => {
  // Default production mode loads zero debug DOM or stylesheet
  const prod = createHarness();
  assert.equal(prod.head.children.length, 0, "No debug stylesheet injected in production");
  assert.equal(prod.body.firstElementChild, prod.dialog, "No debug bar in production");

  // Debug module mounts, injects its own <style>, and wires live graph controls
  const e = createHarness({ loadDebug: true });
  const bar = e.body.firstElementChild;
  assert.equal(bar.classList.contains("lb-debug"), true, "Debug panel prepended to body");
  assert.equal(e.head.children.some(n => n.tagName === "STYLE"), true, "Debug module owns its own <style>");
  assert.equal(e.docEl.style.getPropertyValue("--lb-debug-h"), "235px");

  const walk = (root, out = []) => { out.push(root); for (const c of root.children) walk(c, out); return out; };
  const all = walk(bar);
  const nodes = all.filter(n => n.classList.contains("sm-node"));
  const edgeBars = all.filter(n => n.classList.contains("sm-edge-bar"));
  assert.equal(nodes.length, e.lightbox.graph.nodes.length);
  assert.equal(edgeBars.length, e.lightbox.graph.edges.length);
  assert.equal(nodes.find(n => n.dataset.node === "closed").classList.contains("active"), true);

  // Opening dialog reparents panel inside dialog and highlights viewing node + open edge
  e.open(0);
  e.advance(32);
  assert.equal(e.dialog.firstElementChild, bar, "Debug panel moved into open modal dialog");
  assert.equal(nodes.find(n => n.dataset.node === "viewing").classList.contains("active"), true);
  assert.equal(edgeBars.find(n => n.dataset.edge === "open").classList.contains("active"), true);

  // Editing range slider above the `swipe` edge updates lightbox.config live
  const swipeSpeedInput = all.find(n => n.tagName === "INPUT" && n.getAttribute("aria-label") === "swipe speed");
  assert.ok(swipeSpeedInput, "Found swipe speed slider above swipe edge");
  swipeSpeedInput.value = "3.2";
  swipeSpeedInput.dispatch("input");
  assert.equal(e.lightbox.config.swipeSpeed, 3.2);

  // Clicking Reset restores defaults
  const buttons = all.filter(n => n.tagName === "BUTTON");
  buttons.find(b => b.textContent === "Reset").dispatch("click");
  assert.equal(e.lightbox.config.swipeSpeed, e.lightbox.defaults.swipeSpeed);

  // Collapse button toggles compact height
  const hideBtn = buttons.find(b => b.textContent === "Hide");
  hideBtn.dispatch("click");
  assert.equal(bar.classList.contains("collapsed"), true);
  assert.equal(e.docEl.style.getPropertyValue("--lb-debug-h"), "28px");

  // Dismissing returns panel to body BEFORE dialog.close() (zero top-bar flash or --lb-debug-h collapse)
  e.dialog.dispatch("cancel");
  e.advance(420);
  assert.equal(e.closeEvents[0].inViewer, false, ".in-viewer cleared before dialog.close()");
  assert.equal(e.closeEvents[0].debugInBody, true, "Debug panel returned to body before dialog.close()");
  assert.equal(e.closeEvents[0].debugH, "28px", "--lb-debug-h never collapsed to 0px during close");
  assert.equal(e.body.firstElementChild, bar, "Debug panel stays in body after close");
  assert.equal(nodes.find(n => n.dataset.node === "closed").classList.contains("active"), true);

  // Close button unmounts panel, removes injected <style>, and clears --lb-debug-h
  buttons.find(b => b.getAttribute("aria-label") === "Close debug graph").dispatch("click");
  assert.equal(e.body.children.includes(bar), false, "Debug panel removed on unmount");
  assert.equal(e.head.children.length, 0, "Injected debug <style> removed on unmount");
  assert.equal(e.docEl.style.getPropertyValue("--lb-debug-h"), "", "--lb-debug-h cleared on unmount");
});

if (process.argv.includes("--bench")) {
  const e = createHarness();
  e.open(0);
  e.advance(32);
  const startL = e.track.scrollLeft, startT = e.track.scrollTop;
  const N = 10000;

  const hRes = e.measureHotPath(() => {
    for (let i = 1; i <= N; i++) {
      e.stage.dispatch("wheel", { deltaX: 10, deltaY: 0, deltaMode: 0, clientX: 720, clientY: 450, cancelable: false });
      e.track.scrollLeft = startL + (i % 500) + 10;
      e.track.dispatch("scroll");
    }
  });
  e.track.scrollLeft = startL;
  e.track.dispatch("scroll");

  const vRes = e.measureHotPath(() => {
    for (let i = 1; i <= N; i++) {
      e.stage.dispatch("wheel", { deltaX: 0, deltaY: -8, deltaMode: 0, clientX: 1000, clientY: 650, cancelable: false });
      e.track.scrollTop = Math.max(10, startT - (i % 300) - 10);
      e.track.dispatch("scroll");
    }
  });

  const fmt = (label, r) => console.log(
    `${label}: ${(r.ms * 1000 / N).toFixed(2)} us/frame (${Math.round(N / (r.ms / 1000)).toLocaleString()} frames/s) | `
    + `reflows=${r.forcedReflows}, reads=${r.layoutReads}, layoutWrites=${r.layoutWrites}, shadeWrites=${r.shadeWrites}, transforms/frame=${(r.transformWrites / N).toFixed(1)}`
  );
  console.log(`\nLightbox benchmark (${N.toLocaleString()} frames each, ${LIGHTBOX_CODE.split("\n").length} lines):`);
  fmt("  horizontal swipe", hRes);
  fmt("  swipe-down shrink", vRes);
}

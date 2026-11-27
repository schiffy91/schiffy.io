// Lightbox viewer: 6-state machine, 3 rotated GPU slides, native X scroll-snap + trackpad/touch gestures.

const lightbox = (() => {
  const SWIPE_SPEED = 2, PULL_SPEED = 1.5, DISMISS_SCALE = .78, MAX_ZOOM = 8;
  const SETTLE_MS = 350, DISMISS_MS = 350, MIN_MS = 70, EASE = 3;

  const mk = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });
  const ensure = (parent, cls) => parent.querySelector("." + cls) || (el => (parent.append(el), el))(mk("div", cls));
  const dialog = document.querySelector("dialog");
  const stage = dialog.querySelector(".stage");
  for (const el of stage.querySelectorAll(".neighbor")) el.remove();
  const track = ensure(stage, "track");
  const trackSpace = ensure(track, "track-space");
  const viewport = ensure(trackSpace, "viewport");
  const map = dialog.querySelector(".minimap");
  if (map && map.parentElement !== viewport) viewport.append(map);
  for (const el of Array.from(stage.children)) {
    if (el.classList?.contains("frame")) viewport.insertBefore(el, map);
  }
  while (viewport.querySelectorAll(".frame").length < 3) viewport.insertBefore(mk("div", "frame"), map);
  const [snapPrev, snapCurr, snapNext] = Array.from({ length: 3 }, () => {
    const el = mk("div", "snap");
    el.setAttribute("aria-hidden", "true");
    trackSpace.insertBefore(el, viewport);
    return el;
  });
  const slides = Array.from(viewport.querySelectorAll(".frame"), element => ({
    element, index: -1, ratio: 1, full: false, loading: -1,
    w: 0, h: 0, tx: NaN, ty: NaN, scale: NaN, opacity: 1, clipped: false,
  }));
  const mapImg = map.querySelector("img");
  const bounds = map.querySelector("span");
  const notice = dialog.querySelector("#notice");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const hasScrollEnd = "onscrollend" in window;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const fitted = { zoom: 1, x: 0, y: 0, page: 0, pull: 0 };
  const view = { ...fitted };
  const stageBox = { left: 0, top: 0, w: 0, h: 0, cursor: null, minScale: .15 };
  const cache = { synced: -1, layoutKey: "", shade: null, zoomed: null, mapHidden: null };
  const input = {
    pointers: new Map(), seen: new Map(), gesture: null, lastTap: null, pinch: null,
    pinchTimer: 0, scrollTimer: 0, ghostTimer: 0, wheelPinching: false, lastPinch: 0,
    trackMeta: null, axis: null, scrolled: false, lastWheel: 0,
    absorbUntil: 0, lastAbsorbed: 0, inertia: null, ignoreSnapUntil: 0,
  };
  const telemetry = { scale: 1, page: 0 };
  const warmed = new Set();
  const anims = [0, 0]; // [0] = main tween, [1] = horizontal page glide

  let state = "closed", lastEdge = null, index = 0, pending = null, upgradeTimer = 0;
  const isOpen = () => state !== "closed" && state !== "closing";
  const stopAnim = (slot = 0) => { cancelAnimationFrame(anims[slot]); anims[slot] = 0; };
  const stopAll = () => { stopAnim(0); stopAnim(1); };

  const EDGES = {
    open:    ["viewing", ["closed"], ({ position }) => openPhoto(position, 0)],
    swipe:   ["paging",  ["viewing", "paging", "pulling"]],
    settle:  ["viewing", ["paging", "viewing"], ({ step = 0, target = null, immediate = false }) => {
      if (immediate && step) return openPhoto(index + step, step);
      if (step) return animateTo(target, () => openPhoto(index + step, step));
      if (target) return animateTo(target);
      if (view.page || view.pull) { view.page = view.pull = 0; draw(); }
      syncTrack();
    }],
    pull:    ["pulling", ["viewing", "pulling", "paging", "zoomed"]],
    bounce:  ["viewing", ["pulling", "paging"], ({ target = fitted }) => {
      stopAnim(1);
      const meta = input.trackMeta;
      if (meta && track.scrollLeft !== meta.originX) {
        track.scrollLeft = meta.left = meta.lastSl = meta.originX;
        input.ignoreSnapUntil = performance.now() + 260;
      }
      animateTo(target);
    }],
    dismiss: ["closing", ["pulling", "viewing", "paging", "zoomed"], () => runDismiss()],
    zoom:    ["zoomed",  ["viewing", "zoomed", "paging", "pulling"]],
    fit:     ["viewing", ["zoomed", "viewing", "pulling"], ({ animate = true }) => {
      resetTrackInput();
      if (animate) return animateTo(fitted);
      Object.assign(view, fitted);
      draw();
      syncTrack();
    }],
    finish:  ["closed",  ["closing"], () => finishClose()],
  };

  function transition(edgeId, payload = {}) {
    const edge = EDGES[edgeId];
    if (!edge || !edge[1].includes(state)) return false;
    state = edge[0];
    lastEdge = edgeId;
    edge[2]?.(payload);
    return true;
  }

  // --- Pure-GPU layout, rendering & tween engine ---

  const wrap = pos => ((pos % photoGrid.tiles.length) + photoGrid.tiles.length) % photoGrid.tiles.length;
  const tile = (offset = 0) => photoGrid.tiles[wrap(index + offset)];
  const previewUrl = img => img.currentSrc || img.src;
  const makeImg = (src, alt = "", decoding = "sync") => Object.assign(new Image(), { alt, draggable: false, decoding, src });
  const pullDistance = (h = stageBox.h) => Math.max(1, Math.round(h * .65));
  const minScale = () => (cache.synced !== index && syncGrid(), stageBox.minScale);
  const dismissThreshold = () => Math.max(DISMISS_SCALE, Math.min(.96, minScale() + .04));
  const pullScaleFor = (pull, span = pullDistance()) => {
    const min = minScale();
    return clamp(1 - (1 - min) * clamp(pull / span, 0, 1), min, 1);
  };

  function measureStage() {
    const r = stage.getBoundingClientRect();
    stageBox.left = r.left;
    stageBox.top = r.top;
    stageBox.w = r.width || stage.clientWidth;
    stageBox.h = r.height || stage.clientHeight;
  }

  function geometry(zoom = view.zoom, aspect = slides[1].ratio) {
    if (!stageBox.w || !stageBox.h) measureStage();
    const { w, h } = stageBox;
    const width = Math.min(w, h * aspect) * zoom, height = width / aspect;
    return {
      w, h, width, height,
      limitX: zoom > 1 ? Math.max(0, (width - w) / 2) : 0,
      limitY: zoom > 1 ? Math.max(0, (height - h) / 2) : 0,
    };
  }

  function syncGrid(force = false) {
    if (!force && cache.synced === index) return;
    cache.synced = index;
    photoGrid.select(index);
    const r = stageBox.w && stageBox.h ? tile()?.getBoundingClientRect() : null;
    const fit = r?.width && r?.height ? geometry(1) : null;
    stageBox.minScale = fit?.width && fit?.height
      ? clamp(Math.min(r.width / fit.width, r.height / fit.height), .05, .95)
      : .15;
    const img = tile().firstElementChild;
    if (img) { img.loading = "eager"; img.decoding = "sync"; img.decode?.().catch(() => {}); }
  }

  function trackCursor(event) {
    if (!stageBox.w || !stageBox.h) return;
    stageBox.cursor = {
      x: clamp(event.clientX - stageBox.left, 0, stageBox.w),
      y: clamp(event.clientY - stageBox.top, 0, stageBox.h),
    };
  }

  function renderSlide(slide, width, height, tx, ty, scale = 1, opacity = 1) {
    const s = slide.element.style;
    if (slide.w !== width || slide.h !== height) {
      slide.w = width; slide.h = height;
      s.width = width + "px"; s.height = height + "px";
    }
    if (slide.clipped) { slide.clipped = false; s.overflow = s.borderRadius = ""; }
    if (slide.opacity !== opacity) { slide.opacity = opacity; s.opacity = opacity === 1 ? "" : String(opacity); }
    if (slide.tx !== tx || slide.ty !== ty || slide.scale !== scale) {
      slide.tx = tx; slide.ty = ty; slide.scale = scale;
      s.transform = scale === 1
        ? `translate3d(${tx}px, ${ty}px, 0)`
        : `translate3d(${tx}px, ${ty}px, 0) scale(${scale}, ${scale})`;
    }
  }

  const lerp = (a, b, t) => a + (b - a) * t;

  function draw() {
    const { w, h, width, height } = geometry();
    if (!w || !h) return;
    const { x, y, zoom, page, pull } = view;
    const shrinking = pull > 0 && zoom >= 1 && width && height;
    const pullScale = shrinking ? pullScaleFor(pull, pullDistance(h)) : 1;
    const effectiveScale = Math.min(zoom, pullScale);
    const shade = clamp(1 - 1.6 * (1 - effectiveScale), 0, 1);
    if (shade < 1) syncGrid();

    const neighborAlpha = shrinking ? clamp((pullScale - dismissThreshold()) / Math.max(.05, 1 - dismissThreshold()), 0, 1) : 1;
    for (const [s, off] of [[slides[0], page > 0 ? page - w : -w], [slides[2], page < 0 ? page + w : w]]) {
      const sw = Math.min(w, h * s.ratio), sh = sw / s.ratio;
      renderSlide(s, sw, sh, (w - sw) / 2 + off, (h - sh) / 2, 1, neighborAlpha);
    }

    if (shrinking) {
      const ax = stageBox.cursor ? stageBox.cursor.x : w / 2;
      const ay = stageBox.cursor ? stageBox.cursor.y : h / 2;
      renderSlide(slides[1], width, height, ax + ((w - width) / 2 + x + page - ax) * pullScale, ay + ((h - height) / 2 + y - ay) * pullScale, pullScale);
    } else {
      renderSlide(slides[1], width, height, (w - width) / 2 + x + page, (h - height) / 2 + y);
    }

    if (shade !== cache.shade) { cache.shade = shade; dialog.style.setProperty("--shade", shade); }
    const mapHidden = zoom <= 1 || !!(page || pull || state === "closing");
    if (mapHidden !== cache.mapHidden) { cache.mapHidden = mapHidden; map.hidden = mapHidden; }
    if (!mapHidden) {
      const left = .5 - (w / 2 + x) / width, top = .5 - (h / 2 + y) / height, b = bounds.style;
      b.left = clamp(left, 0, 1) * 100 + "%";
      b.top = clamp(top, 0, 1) * 100 + "%";
      b.width = (clamp(left + w / width, 0, 1) - clamp(left, 0, 1)) * 100 + "%";
      b.height = (clamp(top + h / height, 0, 1) - clamp(top, 0, 1)) * 100 + "%";
    }
    const zoomed = zoom > 1;
    if (zoomed !== cache.zoomed) { cache.zoomed = zoomed; stage.classList.toggle("zoomed", zoomed); }
    telemetry.scale = effectiveScale;
    telemetry.page = page;
  }

  const settled = target => Object.keys(target).every(k => Math.abs(view[k] - target[k]) < (k === "zoom" ? .001 : .5));
  const scaleMs = (ratio, maxMs = SETTLE_MS, minMs = MIN_MS) =>
    Math.max(1, Math.round(clamp(maxMs * clamp(ratio, 0, 1), Math.min(minMs, maxMs), maxMs)));

  function withinPhoto() {
    const { limitX, limitY } = geometry();
    return { x: clamp(view.x, -limitX, limitX), y: clamp(view.y, -limitY, limitY), page: 0, pull: 0 };
  }

  function scaleAt(zoom, from, to, start = view) {
    const factor = zoom / start.zoom;
    view.x = to.x - view.page - (from.x - start.x - view.page) * factor;
    view.y = to.y - view.pull - (from.y - start.y - view.pull) * factor;
    view.zoom = zoom;
  }

  function applyPinch(zoom, from, to, start = view, min = minScale()) {
    scaleAt(clamp(zoom, min, MAX_ZOOM), from, to, start);
    if (view.zoom >= 1) Object.assign(view, withinPhoto());
    if (view.zoom > 1) transition("zoom");
    else if (view.zoom < 1) transition("pull");
  }

  function runTween(slot, duration, onStep, onDone, syncFirst = true) {
    stopAnim(slot);
    const since = performance.now(), instant = reducedMotion.matches || duration <= 0;
    function tick(now) {
      const t = instant ? 1 : clamp((now - since) / duration, 0, 1);
      if (onStep(1 - (1 - t) ** EASE, t) === false) { anims[slot] = 0; return; }
      if (t < 1) anims[slot] = requestAnimationFrame(tick);
      else { anims[slot] = 0; onDone?.(); }
    }
    if (syncFirst || instant) tick(since);
    else anims[slot] = requestAnimationFrame(tick);
  }

  function startPageGlide(fromPage = view.page) {
    stopAnim(1);
    if (Math.abs(fromPage) < 1 || reducedMotion.matches) { view.page = 0; return; }
    view.page = fromPage;
    runTween(1, scaleMs(Math.abs(fromPage) / Math.max(1, geometry().w), 220, 120), (ease, t) => {
      if (!dialog.open || !isOpen() || input.axis === "x") return false;
      view.page = t >= 1 ? 0 : fromPage * (1 - ease);
      draw();
    }, null, false);
  }

  function animateTo(target, done) {
    stopAnim(1);
    const start = { ...view }, keys = Object.keys(target), { w, h } = geometry();
    const ratio = Math.max(
      "page" in target && w ? Math.abs(target.page - start.page) / w : 0,
      "pull" in target && h ? Math.abs(target.pull - start.pull) / pullDistance(h) : 0,
      "x" in target && w ? Math.abs(target.x - start.x) / w : 0,
      "y" in target && h ? Math.abs(target.y - start.y) / h : 0,
      "zoom" in target ? Math.abs(target.zoom - start.zoom) / Math.max(1, start.zoom, target.zoom) : 0,
    );
    runTween(0, settled(target) ? 0 : scaleMs(ratio), (ease, t) => {
      const k = 1 - ease;
      for (const key of keys) view[key] = target[key] + (start[key] - target[key]) * k;
      if (t < 1 || !done) draw();
    }, done || syncTrack);
  }

  function finishPinch(animate) {
    if (!isOpen() || input.pointers.size) return;
    if (view.zoom < dismissThreshold()) transition("dismiss");
    else if (view.zoom < 1) transition("bounce", { target: fitted });
    else if (view.zoom < 1.05) transition("fit", { animate: view.zoom > 1 });
    else if (animate) animateTo(withinPhoto());
    else syncTrack();
  }

  function zoomTo(zoom, anchor = { x: 0, y: 0 }) {
    if (!isOpen() || input.pointers.size) return;
    resetTrackInput();
    stopAnim(0);
    promoteDominant(false);
    const nextZoom = clamp(zoom, 1, MAX_ZOOM);
    scaleAt(nextZoom, anchor, anchor);
    Object.assign(view, withinPhoto());
    if (nextZoom > 1) { transition("zoom"); draw(); syncTrack(); }
    else transition("fit", { animate: false });
  }

  // --- Slide & dialog lifecycle ---

  function loadSlide(slide, position, preload = false) {
    if (slide.index === position && slide.element.firstElementChild) return;
    const thumb = photoGrid.tiles[position].firstElementChild;
    const image = makeImg(previewUrl(thumb), thumb.alt);
    slide.index = position;
    slide.ratio = Number(thumb.getAttribute("width")) / Number(thumb.getAttribute("height"));
    slide.full = false; slide.loading = -1;
    slide.element.replaceChildren(image);
    if (preload) image.decode().catch(() => {});
  }

  function prewarmLowRes(center, dir) {
    if (photoGrid.tiles.length <= 3) return;
    for (const off of (dir ? [dir * 2, dir * 3] : [2, -2, 3])) {
      const src = previewUrl(photoGrid.tiles[wrap(center + off)].firstElementChild);
      if (src && !warmed.has(src)) { warmed.add(src); makeImg(src, "", "async").decode?.().catch(() => {}); }
    }
  }

  async function upgradeSlide(slide, position, showError = false) {
    if (slide.index !== position || slide.full || slide.loading === position) return true;
    const link = photoGrid.tiles[position], full = makeImg(link.href, link.firstElementChild.alt);
    slide.loading = position;
    if (showError) pending = full;
    try {
      await full.decode();
      if (!dialog.open || state === "closing" || slide.index !== position || slide.full) return false;
      if (showError && pending !== full) return false;
      // Keep preview behind opaque full-res until rotation to avoid a 1-frame black flash on 120Hz/WebKit.
      slide.element.append(full);
      slide.full = true;
      if (slide === slides[1]) mapImg.src = full.src;
      return true;
    } catch {
      if (showError && pending === full) notice.textContent = "Couldn’t load the full-size photograph.";
      return false;
    } finally {
      if (slide.loading === position) slide.loading = -1;
    }
  }

  async function runUpgrades(active, pos) {
    if (!dialog.open || state === "closing" || active !== slides[1] || active.index !== pos) return;
    if (!active.full) await upgradeSlide(active, pos, true);
    if (dialog.open && state !== "closing" && photoGrid.tiles.length > 1 && active === slides[1] && active.index === pos) {
      upgradeSlide(slides[2], slides[2].index);
      upgradeSlide(slides[0], slides[0].index);
    }
  }

  function mountSlides(target, step, opening) {
    clearTimeout(upgradeTimer); upgradeTimer = 0;
    const count = photoGrid.tiles.length;
    if (!opening && count > 1) {
      if (step === 1 || (!step && slides[2].index === target)) slides.push(slides.shift());
      else if (step === -1 || (!step && slides[0].index === target)) slides.unshift(slides.pop());
    }
    index = target;
    slides[0].element.hidden = slides[2].element.hidden = count <= 1;
    loadSlide(slides[1], index);
    if (count > 1) {
      loadSlide(slides[0], wrap(index - 1), true);
      loadSlide(slides[2], wrap(index + 1), true);
      prewarmLowRes(index, step);
    }
    slides.forEach((s, i) => s.element.classList.toggle("current", i === 1));
    const link = tile(), thumb = link.firstElementChild, active = slides[1];
    map.style.setProperty("--ratio", active.ratio);
    mapImg.src = active.full ? (pending = null, link.href) : (active.element.lastElementChild?.src || previewUrl(thumb));
    notice.textContent = "";
    if (!opening && thumb) { thumb.loading = "eager"; thumb.decoding = "sync"; thumb.decode?.().catch(() => {}); }
    if (opening) return () => runUpgrades(active, index);
    upgradeTimer = setTimeout(() => { upgradeTimer = 0; runUpgrades(active, index); }, 90);
    return null;
  }

  function promoteDominant(keepOffset = false) {
    const w = stageBox.w || geometry().w;
    if (!w || photoGrid.tiles.length <= 1 || Math.abs(view.page) <= w / 2) return 0;
    const step = view.page < 0 ? 1 : -1;
    const carry = keepOffset ? clamp(view.page + step * w, -w, w) : 0;
    mountSlides(wrap(index + step), step, false);
    view.page = carry;
    if (input.trackMeta) input.trackMeta.promoted = true;
    return step;
  }

  function absorbIntoZoom() {
    promoteDominant(false);
    if (view.pull > 0 && view.zoom >= 1) { view.zoom = pullScaleFor(view.pull); view.pull = 0; }
    view.page = 0;
  }

  function openPhoto(position, step = 0) {
    if (state === "closing") return;
    stopAll();
    resetTrackInput();
    input.pointers.clear();
    input.seen.clear();
    input.lastTap = null;
    const opening = !dialog.open;
    const startUpgrades = mountSlides(wrap(position), step, opening);
    Object.assign(view, fitted);
    if (opening) { dialog.showModal(); measureStage(); syncGrid(true); }
    draw();
    syncTrack();
    startUpgrades?.();
  }

  function runDismiss() {
    if (!dialog.open) return;
    stopAll();
    clearTimeout(upgradeTimer); upgradeTimer = 0;
    if (promoteDominant(true)) draw();
    const now = performance.now();
    if (view.pull > 0 || view.zoom < 1) {
      input.absorbUntil = Math.max(input.absorbUntil, now + 1800);
      input.lastAbsorbed = now;
    }
    resetTrackInput();
    track.style.overflow = "hidden";
    input.pointers.clear();
    input.seen.clear();
    syncGrid();
    const active = slides[1], returning = active.element;
    const vpRect = viewport.getBoundingClientRect();
    const from = returning.getBoundingClientRect(), to = tile().getBoundingClientRect();
    if (!from.width || !from.height || !to.width || !to.height) {
      tile().classList.remove("in-viewer");
      if (input.absorbUntil) input.lastAbsorbed = performance.now();
      return dialog.close();
    }
    const startShade = cache.shade ?? 1;
    map.hidden = cache.mapHidden = true;
    slides[0].element.hidden = slides[2].element.hidden = true;
    const baseW = active.w || from.width, baseH = active.h || from.height;
    const duration = scaleMs((from.width / (geometry(1).width || baseW)) / DISMISS_SCALE, DISMISS_MS);
    active.clipped = true;
    returning.style.overflow = "hidden";
    runTween(0, duration, ease => {
      const x = lerp(from.left, to.left, ease) - vpRect.left, y = lerp(from.top, to.top, ease) - vpRect.top;
      const sx = lerp(from.width, to.width, ease) / baseW, sy = lerp(from.height, to.height, ease) / baseH;
      returning.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
      returning.style.borderRadius = (5 * ease / Math.min(sx, sy)) + "px";
      dialog.style.setProperty("--shade", startShade * (1 - ease));
    }, () => {
      tile().classList.remove("in-viewer");
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (input.absorbUntil) input.lastAbsorbed = performance.now();
        dialog.close();
      }));
    });
  }

  function finishClose() {
    stopAll();
    clearTimeout(upgradeTimer); upgradeTimer = 0;
    resetTrackInput();
    input.pointers.clear();
    input.seen.clear();
    track.style.overflow = "";
    if (input.absorbUntil) {
      const now = performance.now();
      input.absorbUntil = Math.max(input.absorbUntil, now + 1500);
      input.lastAbsorbed = now;
    }
    pending = input.trackMeta = input.axis = null;
    input.scrolled = false; input.lastWheel = input.ignoreSnapUntil = 0;
    Object.assign(stageBox, { w: 0, h: 0, cursor: null, minScale: .15 });
    Object.assign(cache, { synced: -1, layoutKey: "", shade: null, zoomed: null, mapHidden: null });
    telemetry.scale = 1; telemetry.page = 0;
    for (const s of slides) {
      Object.assign(s, { index: -1, full: false, clipped: false, loading: -1, w: 0, h: 0, tx: NaN, ty: NaN, scale: NaN, opacity: 1 });
      s.element.style.cssText = "";
      s.element.replaceChildren();
    }
    photoGrid.restore();
  }

  // --- Pointer gestures (touchscreens & mouse drag) ---

  const stagePoint = e => ({ x: e.clientX - stageBox.left - stageBox.w / 2, y: e.clientY - stageBox.top - stageBox.h / 2 });

  function measurePointers() {
    let x = 0, y = 0, sq = 0;
    for (const p of input.pointers.values()) { x += p.clientX; y += p.clientY; }
    x /= input.pointers.size; y /= input.pointers.size;
    for (const p of input.pointers.values()) sq += (p.clientX - x) ** 2 + (p.clientY - y) ** 2;
    return { x: x - stageBox.left - stageBox.w / 2, y: y - stageBox.top - stageBox.h / 2, spread: Math.sqrt(sq / input.pointers.size) };
  }

  function rebase(fresh = false) {
    input.gesture.start = input.gesture.last = measurePointers();
    input.gesture.baseline = { ...view };
    input.gesture.axis = fresh ? null : (view.page ? "x" : view.pull ? "y" : null);
    input.gesture.cancelled = false;
  }

  function mapPoint(event) {
    const r = map.getBoundingClientRect(), { width, height } = geometry();
    return [(.5 - (event.clientX - r.left) / r.width) * width, (.5 - (event.clientY - r.top) / r.height) * height];
  }

  function moveOnMap(event) {
    const [mx, my] = mapPoint(event);
    view.x = mx + input.gesture.mapX;
    view.y = my + input.gesture.mapY;
    Object.assign(view, withinPhoto());
  }

  function toggleDoubleTap(event) {
    if (!isOpen() || input.pointers.size) return;
    input.lastTap = null;
    resetTrackInput();
    stopAll();
    if (view.zoom > 1) return transition("fit", { animate: true });
    promoteDominant(false);
    const pt = stagePoint(event), { limitX, limitY } = geometry(2);
    transition("zoom");
    animateTo({
      zoom: 2,
      x: clamp(-pt.x * 2, -limitX, limitX),
      y: clamp(-pt.y * 2, -limitY, limitY),
      page: 0,
      pull: 0,
    });
  }

  function runPanMomentum(vx0, vy0) {
    stopAnim(0);
    if (reducedMotion.matches) { Object.assign(view, withinPhoto()); draw(); syncTrack(); return; }
    let vx = clamp(vx0, -4.5, 4.5), vy = clamp(vy0, -4.5, 4.5), prev = performance.now();
    const stepAxis = (pos, v, limit, dt) => {
      if (limit <= 0) return [0, 0];
      const clamped = clamp(pos, -limit, limit), over = pos - clamped;
      if (Math.abs(over) > .25) {
        if (v * over > 0) {
          v = v * Math.exp(-dt / 42) - over * .0005 * dt;
        } else {
          const omega = .016;
          v += (-omega * omega * over - 2 * omega * v) * dt;
          if (over * (over + v * dt) <= 0) return [clamped, 0];
        }
        return [pos + v * dt, v];
      }
      v *= Math.exp(-dt / 280);
      return [clamped + v * dt, v];
    };
    function tick(now) {
      if (!dialog.open || !isOpen() || view.zoom <= 1) { anims[0] = 0; return; }
      const dt = clamp(now - prev, 1, 32);
      prev = now;
      const { limitX, limitY } = geometry();
      [view.x, vx] = stepAxis(view.x, vx, limitX, dt);
      [view.y, vy] = stepAxis(view.y, vy, limitY, dt);
      const overX = view.x - clamp(view.x, -limitX, limitX);
      const overY = view.y - clamp(view.y, -limitY, limitY);
      if (Math.abs(overX) < .5 && Math.abs(overY) < .5 && Math.hypot(vx, vy) < .04) {
        Object.assign(view, withinPhoto());
        anims[0] = 0;
        draw();
        syncTrack();
        return;
      }
      draw();
      anims[0] = requestAnimationFrame(tick);
    }
    anims[0] = requestAnimationFrame(tick);
  }

  function dragBy(dx, dy, axis, touch = false) {
    const { w, h, limitX, limitY } = geometry(), horiz = axis === "x", zoomed = view.zoom > 1;
    if (zoomed && touch) {
      const band = (pos, delta, limit) => {
        if (limit <= 0) return 0;
        const over = pos - clamp(pos, -limit, limit);
        if (over && delta * over > 0) delta *= .35 / (1 + Math.abs(over) / 140);
        return pos + delta;
      };
      view.x = band(view.x, dx, limitX);
      view.y = band(view.y, dy, limitY);
      return;
    }
    const x = view.x + dx + (horiz && !zoomed ? view.page : 0);
    const y = view.y + dy + (!horiz && !zoomed ? view.pull : 0);
    view.x = clamp(x, Math.min(view.x, -limitX), Math.max(view.x, limitX));
    view.y = clamp(y, Math.min(view.y, -limitY), Math.max(view.y, limitY));
    if (zoomed || view.zoom !== 1) return;
    if (horiz && photoGrid.tiles.length > 1) view.page = clamp(x - view.x, -w, w);
    if (!horiz) view.pull = clamp(y - view.y, 0, pullDistance(h));
  }

  const project = (history, now, value, slot) => {
    const [time, page, pull] = history[0], dt = now - time;
    return value + (dt > 0 && dt < 120 ? (value - (slot === "page" ? page : pull)) / dt * 160 : 0);
  };

  stage.onpointerdown = event => {
    if (!isOpen() || event.button !== 0) return;
    trackCursor(event);
    resetTrackInput();
    stopAll();
    if (input.scrolled) syncTrack();
    // A primary touch pointer always starts a fresh touch sequence; purge any ghost pointers dropped by mobile browsers.
    if (event.pointerType === "touch" && event.isPrimary) {
      for (const [id, p] of input.pointers) if (p.pointerType === "touch") { input.pointers.delete(id); input.seen.delete(id); }
    }
    input.pointers.delete(event.pointerId);
    input.pointers.set(event.pointerId, event);
    input.seen.set(event.pointerId, performance.now());
    try { stage.setPointerCapture(event.pointerId); } catch {}
    if (input.pointers.size === 1) {
      const onMap = map.contains(event.target);
      input.gesture = {
        tap: true, backdrop: !onMap && !slides[1].element.contains(event.target),
        touch: event.pointerType === "touch", history: [], onMap,
      };
      if (onMap) {
        const g = bounds.getBoundingClientRect(), [mx, my] = mapPoint(event);
        const inside = event.clientX >= g.left && event.clientX <= g.right && event.clientY >= g.top && event.clientY <= g.bottom;
        input.gesture.mapX = inside ? view.x - mx : 0;
        input.gesture.mapY = inside ? view.y - my : 0;
        moveOnMap(event);
        draw();
      }
    } else {
      input.gesture ??= { tap: false, backdrop: false, touch: event.pointerType === "touch", history: [], onMap: false };
      input.gesture.tap = input.gesture.onMap = false;
      input.lastTap = null;
      if (input.pointers.size === 2) absorbIntoZoom();
    }
    rebase(input.pointers.size === 1);
    input.gesture.history = [[event.timeStamp, view.page, view.pull, view.x, view.y]];
  };

  stage.onpointermove = event => {
    if (isOpen()) trackCursor(event);
    if (!input.pointers.has(event.pointerId)) return;
    input.pointers.delete(event.pointerId);
    input.pointers.set(event.pointerId, event);
    input.seen.set(event.pointerId, performance.now());
    const g = input.gesture, point = measurePointers(), last = g.last;
    if (g.onMap) {
      moveOnMap(event);
    } else if (input.pointers.size > 1) {
      const zoom = g.start.spread ? g.baseline.zoom * point.spread / g.start.spread : g.baseline.zoom;
      scaleAt(clamp(zoom, minScale(), MAX_ZOOM), g.start, point, g.baseline);
      if (!g.start.spread && point.spread) rebase();
      if (view.zoom > 1) transition("zoom");
      else if (view.zoom < 1) transition("pull");
    } else {
      if (!g.axis) {
        const dx = point.x - g.start.x, dy = point.y - g.start.y;
        if (g.tap && Math.hypot(dx, dy) < 5) return;
        g.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
        if (g.axis === "y" && view.zoom <= 1) {
          promoteDominant(true);
          if (Math.abs(view.page) >= 1) startPageGlide(view.page);
        }
      }
      g.tap = false;
      dragBy(point.x - last.x, point.y - last.y, g.axis, g.touch);
      if (view.zoom <= 1) {
        if (g.axis === "y" && view.pull) transition("pull");
        else if (g.axis === "x" && view.page) transition("swipe");
      }
    }
    g.last = point;
    while (g.history.length && event.timeStamp - g.history[0][0] >= 100) g.history.shift();
    if (g.history.length >= 16) g.history.shift();
    g.history.push([event.timeStamp, view.page, view.pull, view.x, view.y]);
    draw();
  };

  function release(event, cancelled) {
    if (!input.pointers.delete(event.pointerId)) return;
    input.seen.delete(event.pointerId);
    const g = input.gesture;
    if (!g) return syncTrack();
    g.cancelled ||= cancelled;
    if (input.pointers.size) return rebase();
    if (!g.cancelled) {
      if (g.tap && !g.onMap) {
        if (input.lastTap && event.timeStamp - input.lastTap.time < 320 && Math.hypot(event.clientX - input.lastTap.x, event.clientY - input.lastTap.y) < 28 && (!g.backdrop || view.zoom > 1)) {
          g.doubleTapped = true;
          return toggleDoubleTap(event);
        }
        input.lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
        if (g.backdrop && view.zoom === 1) return transition("dismiss");
      } else input.lastTap = null;
      if (view.zoom < dismissThreshold() || (view.zoom <= 1 && view.pull > 8 && project(g.history, event.timeStamp, view.pull, "pull") > stageBox.h * .2)) {
        return transition("dismiss");
      }
      const dir = Math.sign(view.page);
      if (view.zoom <= 1 && g.axis === "x" && dir * project(g.history, event.timeStamp, view.page, "page") > stageBox.w / 2) {
        return transition("settle", { step: -dir, target: { page: dir * stageBox.w, pull: 0 } });
      }
    }
    if (state === "pulling") return transition("bounce", { target: view.zoom < 1 ? fitted : withinPhoto() });
    if (state === "paging") return transition("settle", { target: withinPhoto() });
    if (view.zoom > 1) {
      if (view.zoom < 1.05) return transition("fit", { animate: true });
      if (!g.cancelled && g.touch && !g.onMap && g.history.length) {
        const first = g.history[0], last = g.history[g.history.length - 1];
        const dt = event.timeStamp - first[0], idle = event.timeStamp - last[0];
        const vx = dt >= 8 && dt < 140 && idle < 65 ? (view.x - first[3]) / dt : 0;
        const vy = dt >= 8 && dt < 140 && idle < 65 ? (view.y - first[4]) / dt : 0;
        const { limitX, limitY } = geometry();
        const over = Math.abs(view.x) > limitX + .5 || Math.abs(view.y) > limitY + .5;
        if (over || Math.hypot(vx, vy) > .15) return runPanMomentum(vx, vy);
      }
      return animateTo(withinPhoto());
    }
    if (state !== "viewing" || !settled(fitted)) return transition("fit", { animate: !settled(fitted) });
    syncTrack();
  }

  stage.onpointerup = stage.onlostpointercapture = e => release(e, false);
  stage.onpointercancel = e => release(e, true);
  window.addEventListener?.("pointerup", e => release(e, false));
  window.addEventListener?.("pointercancel", e => release(e, true));

  // Reconcile against OS touch count so a dropped mobile pointerup can never strand a ghost finger in input.pointers.
  const flushStalePointers = (cancelled = false, touchOnly = false) => {
    if (!input.pointers.size) return;
    const stale = [...input.pointers.values()].filter(p => !touchOnly || p.pointerType === "touch");
    for (const p of stale) {
      release({ pointerId: p.pointerId, clientX: p.clientX, clientY: p.clientY, timeStamp: performance.now() }, cancelled);
    }
  };
  const trimGhostTouches = (live, tap = false) => {
    const touchIds = [];
    for (const [id, p] of input.pointers) if (p.pointerType === "touch") touchIds.push(id);
    const excess = touchIds.length - live;
    if (excess <= 0) return;
    for (let i = 0; i < excess; i++) {
      input.pointers.delete(touchIds[i]);
      input.seen.delete(touchIds[i]);
    }
    if (!input.pointers.size) return;
    if (input.pointers.size === 1) {
      const [only] = input.pointers.values();
      const onMap = map.contains(only.target);
      input.gesture = {
        tap, backdrop: !onMap && !slides[1].element.contains(only.target),
        touch: only.pointerType === "touch",
        history: [[only.timeStamp, view.page, view.pull, view.x, view.y]], onMap, mapX: 0, mapY: 0,
      };
      rebase(true);
    } else {
      rebase(false);
    }
  };
  const reconcileTouches = (type, event) => {
    if (!event.touches || !input.pointers.size) return;
    const live = event.touches.length;
    if (type === "touchend" || type === "touchcancel") {
      clearTimeout(input.ghostTimer);
      input.ghostTimer = setTimeout(() => {
        if (live === 0) flushStalePointers(false, true);
        else trimGhostTouches(live);
      }, 60);
      return;
    }
    if (type === "touchstart") { clearTimeout(input.ghostTimer); return trimGhostTouches(live, true); }
    let touchCount = 0, oldestId = null;
    for (const [id, p] of input.pointers) {
      if (p.pointerType === "touch") {
        if (!touchCount) oldestId = id;
        touchCount++;
      }
    }
    if (touchCount <= live) clearTimeout(input.ghostTimer);
    else if (performance.now() - (input.seen.get(oldestId) ?? 0) >= 80) {
      clearTimeout(input.ghostTimer);
      trimGhostTouches(live);
    }
  };
  for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
    window.addEventListener?.(type, e => reconcileTouches(type, e), { passive: true });
  }
  window.addEventListener?.("blur", () => flushStalePointers(true));
  document.addEventListener?.("visibilitychange", () => { if (document.hidden) flushStalePointers(true); });

  // --- Trackpad native X scroll-snap, zoom & momentum guard ---

  function resetTrackInput() {
    clearTimeout(input.pinchTimer);
    clearTimeout(input.scrollTimer);
    clearTimeout(input.ghostTimer);
    stopAnim(1);
    input.pinch = input.inertia = null;
    input.wheelPinching = false;
    input.ignoreSnapUntil = 0;
  }

  function syncTrack() {
    if (!dialog.open || state === "closing") return;
    const { w, h, limitX, limitY } = geometry();
    if (!w || !h) return;
    const zoomed = view.zoom > 1, hasNeighbors = !zoomed && photoGrid.tiles.length > 1;
    const padX = hasNeighbors ? Math.max(1, Math.round(w / SWIPE_SPEED)) : 0;
    const pullSpan = pullDistance(h), pullSpace = zoomed ? 0 : Math.max(1, Math.round(pullSpan / PULL_SPEED));
    const key = `${w}:${h}:${limitX}:${limitY}:${zoomed}:${hasNeighbors}`;
    const layoutChanged = key !== cache.layoutKey;
    if (layoutChanged) {
      cache.layoutKey = key;
      track.style.scrollSnapType = "none";
      track.style.setProperty("--w", w + "px");
      track.style.setProperty("--h", h + "px");
      track.classList.toggle("free", zoomed);
      trackSpace.style.width = (padX * 2 + w + limitX * 2) + "px";
      trackSpace.style.height = (pullSpace + h + limitY * 2) + "px";
      snapPrev.hidden = snapNext.hidden = !hasNeighbors;
      snapCurr.hidden = zoomed;
      if (!zoomed) {
        for (const [el, x, sw] of [[snapPrev, 0, padX], [snapCurr, padX, padX || w], [snapNext, padX * 2, w]]) {
          el.style.left = x + "px"; el.style.top = "0"; el.style.width = sw + "px"; el.style.height = "100%";
        }
      }
    }
    const originX = padX + limitX, originY = pullSpace + limitY;
    track.scrollLeft = Math.round(originX - view.x - view.page / SWIPE_SPEED);
    track.scrollTop = Math.round(originY - view.y - view.pull / PULL_SPEED);
    if (layoutChanged) { void track.scrollLeft; track.style.scrollSnapType = ""; }
    input.trackMeta = {
      w, h, limitX, limitY, padX, pullSpan, pullSpace, hasNeighbors, originX, originY, pullBase: originY,
      left: track.scrollLeft, top: track.scrollTop, lastSl: track.scrollLeft, lastSt: track.scrollTop,
      promoted: false, lockedY: false,
    };
    input.axis = input.inertia = null;
    input.scrolled = false;
    stopAnim(1);
    clearTimeout(input.scrollTimer);
  }

  function onTrackScroll() {
    const meta = input.trackMeta;
    if (!dialog.open || !isOpen() || input.pointers.size || input.pinch || input.wheelPinching || view.zoom < 1 || !meta) return;
    const { w, limitX, limitY, padX, originX, originY, pullSpan, hasNeighbors, left, top } = meta;
    const sl = track.scrollLeft, st = track.scrollTop, now = performance.now(), wheelActive = now - input.lastWheel < 45;
    if (!wheelActive && ((anims[0] && lastEdge === "bounce") || now < input.ignoreSnapUntil)) {
      meta.lastSl = sl; meta.lastSt = st; return;
    }
    if (!input.scrolled && Math.abs(sl - left) < 1 && Math.abs(st - top) < 1) return;
    const prevSl = meta.lastSl, prevSt = meta.lastSt;
    meta.lastSl = sl; meta.lastSt = st;
    input.scrolled = true;
    stopAnim(0);
    const zoomed = view.zoom > 1, canPage = hasNeighbors && !zoomed;
    const dx = originX - sl, dy = originY - st;
    const x = clamp(dx, -limitX, limitX), y = clamp(dy, -limitY, limitY);
    const remX = canPage ? dx - x : 0, remY = zoomed ? 0 : Math.max(0, dy - y);
    const rawPage = canPage ? clamp(remX * SWIPE_SPEED, -w, w) : 0;
    const pullFor = base => zoomed ? 0 : pullSpan * clamp((base - st) / Math.max(1, base - limitY), 0, 1);
    let rawPull = pullFor(meta.pullBase);
    if (!input.axis && (remX || remY)) {
      if (Math.hypot(remX, remY) >= 8) {
        input.axis = Math.abs(remX) >= remY ? "x" : "y";
        if (input.axis === "y" && rawPull >= 30) meta.lockedY = true;
      }
    } else if (!meta.promoted && !meta.lockedY && input.axis === "y" && rawPull < 30 && Math.abs(remX) > remY * 2 && Math.abs(remX) > 24) {
      input.axis = "x";
    } else if (input.axis === "x" && (
      remY >= 48 ||
      (wheelActive && prevSt - st >= 4 && (prevSt - st) > Math.abs(sl - prevSl) * 1.2 && remY >= (Math.abs(sl - originX) >= padX - 4 ? 16 : 32))
    )) {
      input.axis = "y";
      meta.lockedY = true;
      meta.pullBase = prevSt > limitY ? Math.min(originY, prevSt) : originY;
      rawPull = pullFor(meta.pullBase);
      promoteDominant(true);
      if (Math.abs(view.page) >= 1) startPageGlide(view.page);
    } else if (!meta.promoted && !meta.lockedY && input.axis && !remX && !remY) {
      input.axis = null;
    }
    const axis = input.axis || (Math.abs(remX) >= remY ? "x" : "y");
    if (axis === "y" && rawPull >= 30) meta.lockedY = true;
    view.x = x; view.y = y;
    if (axis === "x") { stopAnim(1); view.page = rawPage; }
    else if (view.page && !anims[1]) startPageGlide(view.page);
    view.pull = axis === "y" ? rawPull : 0;
    if (!zoomed && input.axis === "y" && !wheelActive && st === prevSt && sl !== prevSl) return onTrackScrollEnd();
    if (!zoomed) {
      if (axis === "y" && view.pull) { if (state !== "pulling") transition("pull"); }
      else if (axis === "x" && view.page) { if (state !== "paging") transition("swipe"); }
    }
    draw();
    if (!hasScrollEnd) { clearTimeout(input.scrollTimer); input.scrollTimer = setTimeout(onTrackScrollEnd, 150); }
  }

  function onTrackScrollEnd() {
    clearTimeout(input.scrollTimer);
    const meta = input.trackMeta;
    if (!dialog.open || !isOpen() || input.pointers.size || input.pinch || input.wheelPinching || view.zoom < 1 || !meta || !input.scrolled) return;
    const { padX, pullSpan, hasNeighbors } = meta, sl = track.scrollLeft, st = track.scrollTop, axis = input.axis;
    meta.left = meta.lastSl = sl; meta.top = meta.lastSt = st;
    input.scrolled = false; input.axis = null;
    if (view.zoom > 1) return;
    const edgeStep = hasNeighbors ? (sl >= padX * 2 - 2 ? 1 : sl <= 2 ? -1 : 0) : 0;
    if (axis === "y") {
      if (pullScaleFor(view.pull, pullSpan) < dismissThreshold()) return transition("dismiss");
      if (!meta.promoted && !meta.lockedY && !view.pull && edgeStep) return transition("settle", { step: edgeStep, immediate: true });
      return transition("bounce", { target: withinPhoto() });
    }
    if (hasNeighbors) return transition("settle", edgeStep ? { step: edgeStep, immediate: true } : {});
    if (view.pull) return transition("bounce", { target: withinPhoto() });
    syncTrack();
  }

  // Detect released 60Hz/120Hz+ macOS momentum coasting against scrollTop=0 while keeping manual holds open.
  function detectWallInertia(event, now) {
    if (view.zoom > 1 || input.axis !== "y" || event.deltaY >= 0 || -event.deltaY < Math.abs(event.deltaX)) {
      input.inertia = null;
      return false;
    }
    const atWall = track.scrollTop <= 1;
    if (atWall && event.momentum === true) return true;
    const ady = -event.deltaY, dx = event.deltaX, adx = Math.abs(dx), w = input.inertia;
    const maxDrop = w ? Math.max(2, w.prevDy * .18) : 0;
    const dxOk = !w || (adx <= w.prevAdx && (!adx || !w.prevDx || Math.sign(dx) === Math.sign(w.prevDx)));
    if (!w || now - w.lastT > 45 || ady > w.prevDy || (w.prevDy - ady) > maxDrop || !dxOk) {
      input.inertia = {
        startT: now, startDy: ady, prevDy: ady, prevDx: dx, prevAdx: adx,
        lastT: now, count: 1, drops: 0, pureY: adx === 0, wallHits: atWall ? 1 : 0,
      };
      return false;
    }
    if (ady < w.prevDy) w.drops++;
    if (adx > 0) w.pureY = false;
    if (atWall) w.wallHits++;
    w.prevDy = ady; w.prevDx = dx; w.prevAdx = adx; w.lastT = now; w.count++;
    if (!atWall || w.wallHits < 2) return false;
    const elapsed = now - w.startT, dropped = w.startDy - ady;
    const decay100 = elapsed > 0 ? Math.pow(ady / w.startDy, 100 / elapsed) : 1;
    const fast = elapsed >= 38 && w.count >= 4 && w.drops >= 2 && w.startDy >= 14
      && dropped >= Math.max(2, w.startDy * .07) && decay100 >= .42 && decay100 <= .90;
    const gentle = w.pureY && elapsed >= 75 && w.count >= 6 && w.drops >= 2 && w.startDy >= 4
      && dropped >= 2 && decay100 >= .42 && decay100 <= .88;
    return fast || gentle;
  }

  track.addEventListener("scroll", onTrackScroll, { passive: true });
  if (hasScrollEnd) track.addEventListener("scrollend", onTrackScrollEnd);
  window.addEventListener?.("wheel", event => {
    if (!input.absorbUntil) return;
    const now = performance.now();
    if (dialog.open) {
      input.lastAbsorbed = now;
      if (state === "closing" && event.cancelable) event.preventDefault();
      return;
    }
    if (now > input.absorbUntil || now - input.lastAbsorbed > 120 || event.deltaY > 0) { input.absorbUntil = 0; return; }
    input.lastAbsorbed = now;
    if (event.cancelable) event.preventDefault();
  }, { passive: false });

  stage.addEventListener("wheel", event => {
    if (!isOpen() || input.pointers.size) { if (event.cancelable) event.preventDefault(); return; }
    trackCursor(event);
    const now = performance.now();
    if (!event.ctrlKey && !event.metaKey) {
      if (input.wheelPinching) {
        if (now - input.lastPinch < 60) { if (event.cancelable) event.preventDefault(); return; }
        clearTimeout(input.pinchTimer);
        input.wheelPinching = false;
        if (view.zoom < 1) { finishPinch(false); if (event.cancelable) event.preventDefault(); return; }
        syncTrack();
      }
      const gap = now - input.lastWheel, meta = input.trackMeta;
      input.lastWheel = now;
      input.ignoreSnapUntil = 0;
      if (!hasScrollEnd && input.scrolled) { clearTimeout(input.scrollTimer); input.scrollTimer = setTimeout(onTrackScrollEnd, 150); }
      if (event.cancelable && input.scrolled && meta?.hasNeighbors && input.axis !== "y") {
        const pullDown = event.deltaY < 0 && -event.deltaY > Math.abs(event.deltaX) * 1.5, sl = track.scrollLeft;
        const step = (sl >= meta.padX * 2 - 4 && gap >= 80 && event.deltaX > 0) || (pullDown && sl > meta.padX * 1.5) ? 1
          : (sl <= 4 && gap >= 80 && event.deltaX < 0) || (pullDown && sl < meta.padX * .5) ? -1 : 0;
        if (step) {
          const carry = pullDown ? clamp(view.page + step * meta.w, -meta.w, meta.w) : 0;
          transition("settle", { step, immediate: true });
          if (pullDown) {
            input.axis = "y"; input.scrolled = true;
            if (input.trackMeta) input.trackMeta.lockedY = input.trackMeta.promoted = true;
            if (Math.abs(carry) >= 1) { startPageGlide(carry); draw(); }
          }
          return;
        }
      }
      if (detectWallInertia(event, now)) {
        input.scrolled = false; input.axis = null;
        if (event.cancelable) event.preventDefault();
        return void transition("dismiss");
      }
      if (event.cancelable && meta && Math.abs(event.deltaY) > Math.abs(event.deltaX)) {
        const st = track.scrollTop, maxSt = meta.pullSpace + meta.limitY * 2;
        if ((st <= 0 && event.deltaY < 0) || (st >= maxSt && event.deltaY > 0)) event.preventDefault();
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    const startingPinch = !input.wheelPinching;
    resetTrackInput();
    input.axis = null; input.scrolled = false; input.wheelPinching = true; input.lastPinch = now;
    stopAnim(0);
    if (startingPinch) absorbIntoZoom();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stageBox.h : 1;
    const factor = event.ctrlKey && event.deltaMode === 0 ? .01 : .004;
    const anchor = stagePoint(event);
    applyPinch(view.zoom * Math.exp(-event.deltaY * unit * factor), anchor, anchor, view, event.ctrlKey ? minScale() : 1);
    draw();
    input.pinchTimer = setTimeout(() => { input.wheelPinching = false; finishPinch(false); }, 140);
  }, { passive: false });

  stage.addEventListener("gesturestart", event => {
    event.preventDefault();
    if (!isOpen() || input.pointers.size) return;
    resetTrackInput(); stopAnim(0); absorbIntoZoom();
    input.pinch = { baseline: { ...view }, start: stagePoint(event) };
  });
  stage.addEventListener("gesturechange", event => {
    event.preventDefault();
    if (!input.pinch || !isOpen() || input.pointers.size) return;
    applyPinch(input.pinch.baseline.zoom * event.scale, input.pinch.start, stagePoint(event), input.pinch.baseline);
    draw();
  });
  stage.addEventListener("gestureend", event => {
    event.preventDefault();
    if (!input.pinch) return;
    input.pinch = null;
    finishPinch(true);
  });

  // --- Dialog, keyboard & resize bindings ---

  photoGrid.onOpen(position => transition("open", { position }));
  stage.ondblclick = event => {
    const g = input.gesture;
    if (isOpen() && !input.pointers.size && g?.tap && !g.onMap && !g.doubleTapped && (!g.backdrop || view.zoom > 1)) {
      toggleDoubleTap(event);
    }
  };
  dialog.oncancel = event => { event.preventDefault(); transition("dismiss"); };
  dialog.onclose = () => {
    if (dialog.open) return;
    if (!transition("finish")) { state = "closed"; lastEdge = "finish"; finishClose(); }
  };
  dialog.onkeydown = event => {
    if (!isOpen() || input.pointers.size || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target?.matches?.("input, select, textarea")) return;
    if (view.zoom > 1 && event.key.startsWith("Arrow")) {
      view.x += ({ ArrowLeft: stageBox.w / 5, ArrowRight: -stageBox.w / 5 })[event.key] || 0;
      view.y += ({ ArrowUp: stageBox.h / 5, ArrowDown: -stageBox.h / 5 })[event.key] || 0;
      zoomTo(view.zoom);
    } else {
      switch (event.key) {
        case "ArrowLeft": transition("settle", { step: -1, immediate: true }); break;
        case "ArrowRight": transition("settle", { step: 1, immediate: true }); break;
        case "+": case "=": zoomTo(view.zoom * 1.5); break;
        case "-": zoomTo(view.zoom / 1.5); break;
        case "0": transition("fit", { animate: true }); break;
        default: return;
      }
    }
    event.preventDefault();
  };

  function refreshLayout() {
    if (!dialog.open || state === "closing") return;
    measureStage();
    syncGrid(true);
    if (input.pointers.size) rebase();
    else Object.assign(view, withinPhoto());
    draw();
    if (!input.pointers.size && !input.pinch && !input.wheelPinching) syncTrack();
  }
  new ResizeObserver(refreshLayout).observe(stage);

  return {
    telemetry, refreshLayout,
    get state() { return state; },
    get lastEdge() { return lastEdge; },
  };
})();

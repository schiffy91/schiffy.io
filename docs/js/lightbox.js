// Lightbox viewer built as a graph-based state machine.
// Nodes (states): closed, viewing, paging, pulling, zoomed, closing.
// Edges (ops + live vars): open, swipe, settle, pull, bounce, dismiss, zoom, fit, finish.
// Hot path: 3 persistent .frame slides rotated in place, cached stageBox, transforms-only draw().

const lightbox = (() => {
  const dialog = document.querySelector("dialog");
  const stage = dialog.querySelector(".stage");
  const track = stage.querySelector(".track");
  const trackSpace = track.querySelector(".track-space");
  const viewport = trackSpace.querySelector(".viewport");
  const [snapPrev, snapCurr, snapNext, snapPull] = Array.from({ length: 4 }, () => {
    const el = document.createElement("div");
    el.className = "snap";
    el.setAttribute("aria-hidden", "true");
    trackSpace.insertBefore(el, viewport);
    return el;
  });
  const slides = Array.from(viewport.querySelectorAll(".frame"), element => ({
    element, index: -1, ratio: 1, full: false,
    w: 0, h: 0, tx: NaN, ty: NaN, scale: NaN, clipped: false,
  }));
  const map = viewport.querySelector(".minimap");
  const mapImg = map.querySelector("img");
  const bounds = map.querySelector("span");
  const notice = dialog.querySelector("#notice");

  const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const hasScrollEnd = "onscrollend" in window;
  const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
  const fitted = { zoom: 1, x: 0, y: 0, page: 0, pull: 0, fade: 0 };
  const view = { ...fitted };
  const stageBox = { left: 0, top: 0, w: 0, h: 0, cursor: null, tileAnchor: null };
  const cache = { synced: -1, layoutKey: "", shade: null, zoomed: null, mapHidden: null };
  const input = {
    pointers: new Map(), gesture: null, lastTap: null, pinch: null,
    pinchTimer: 0, scrollTimer: 0, wheelPinching: false, lastPinch: 0,
    trackMeta: null, axis: null, scrolled: false, lastWheel: 0,
    absorbUntil: 0, lastAbsorbed: 0,
  };
  const listeners = { state: new Set(), toggle: new Set() };
  const telemetry = { drawUs: 0, scale: 1, page: 0 };

  let state = "closed", lastEdge = null, index = 0, pending = null, animation = 0;
  const isOpen = () => state !== "closed" && state !== "closing";

  // --- Declarative State Graph (single source of truth for runtime + visualizer) ---

  const numVar = (label, value, min, max, step, fmt) => ({ type: "range", label, value, default: value, min, max, step, fmt });
  const optVar = (label, value, options) => ({ type: "select", label, value, default: value, options });
  const curveOpts = [["linear", "linear"], ["log", "log"]];
  const anchorOpts = [
    ["cursor", "cursor"], ["tile", "grid tile"], ["center", "center"],
    ["left", "left"], ["right", "right"], ["top", "top"], ["bottom", "bottom"],
  ];

  const graph = {
    nodes: [
      { id: "closed",  label: "Closed"  },
      { id: "viewing", label: "Viewing" },
      { id: "paging",  label: "Paging"  },
      { id: "pulling", label: "Pulling" },
      { id: "zoomed",  label: "Zoomed"  },
      { id: "closing", label: "Closing" },
    ],
    edges: [
      {
        id: "open", from: "closed", to: "viewing", label: "open",
        vars: {},
        op: ({ position }) => openPhoto(position, 0),
      },
      {
        id: "swipe", from: "viewing", to: "paging", label: "swipe",
        allowFrom: ["viewing", "paging", "pulling"],
        vars: {
          swipeSpeed: numVar("speed", 2.0, .5, 4, .1, v => v.toFixed(1) + "x"),
          snapAxis:   optVar("snap", "x", [["x", "X"], ["both", "X+Y"], ["none", "off"]]),
        },
      },
      {
        id: "settle", from: "paging", to: "viewing", label: "settle",
        allowFrom: ["paging", "viewing", "zoomed"],
        vars: {
          settleMs:    numVar("max", 350, 80, 600, 10, v => Math.round(v) + "ms"),
          settleMinMs: numVar("min", 70, 20, 250, 10, v => Math.round(v) + "ms"),
          settleCurve: optVar("curve", "linear", curveOpts),
          easePower:   numVar("ease", 3.0, 1.5, 5, .5, v => "^" + v.toFixed(1)),
        },
        op: ({ step = 0, target = null, immediate = false } = {}) => {
          if (immediate && step) return openPhoto(index + step, step);
          if (step) return animateTo(target, () => openPhoto(index + step, step));
          if (target) return animateTo(target);
          if (view.page || view.pull) { view.page = view.pull = 0; draw(); }
          syncTrack();
        },
      },
      {
        id: "pull", from: "viewing", to: "pulling", label: "pull",
        allowFrom: ["viewing", "pulling", "zoomed"],
        vars: {
          pullSpeed:  numVar("speed", 1.5, .5, 4, .1, v => v.toFixed(1) + "x"),
          pullAnchor: optVar("anchor", "cursor", anchorOpts),
        },
      },
      {
        id: "bounce", from: "pulling", to: "viewing", label: "bounce",
        vars: {},
        op: ({ target = fitted } = {}) => animateTo(target),
      },
      {
        id: "dismiss", from: "pulling", to: "closing", label: "dismiss",
        allowFrom: ["pulling", "viewing", "paging", "zoomed"],
        vars: {
          dismissScale: numVar("close@", .78, .4, .94, .02, v => Math.round(v * 100) + "%"),
          dismissCurve: optVar("curve", "linear", curveOpts),
          dismissMaxMs: numVar("max", 350, 80, 600, 10, v => Math.round(v) + "ms"),
          dismissMinMs: numVar("min", 70, 20, 250, 10, v => Math.round(v) + "ms"),
        },
        op: () => runDismiss(),
      },
      {
        id: "zoom", from: "viewing", to: "zoomed", label: "zoom",
        allowFrom: ["viewing", "zoomed", "paging", "pulling"],
        vars: {
          zoomSpeed: numVar("speed", 1.0, .4, 2.5, .1, v => v.toFixed(1) + "x"),
          maxZoom:   numVar("max", 8, 2, 12, 1, v => Math.round(v) + "x"),
        },
      },
      {
        id: "fit", from: "zoomed", to: "viewing", label: "fit",
        allowFrom: ["zoomed", "viewing", "pulling"],
        vars: {},
        op: ({ animate = true } = {}) => {
          if (animate) return animateTo(fitted);
          Object.assign(view, fitted);
          draw();
          syncTrack();
        },
      },
      {
        id: "finish", from: "closing", to: "closed", label: "close",
        vars: {},
        op: () => finishClose(),
      },
    ],
  };

  const edgeById = new Map(graph.edges.map(e => [e.id, e]));
  const params = {}, defaults = {}, varSpec = new Map();
  for (const edge of graph.edges) {
    for (const [key, spec] of Object.entries(edge.vars)) {
      params[key] = spec.value;
      defaults[key] = spec.default;
      varSpec.set(key, spec);
    }
  }
  Object.freeze(defaults);

  const emitState = () => { for (const fn of listeners.state) fn(state, lastEdge); };
  const emitToggle = open => { for (const fn of listeners.toggle) fn(open, dialog); };

  function transition(edgeId, payload) {
    const edge = edgeById.get(edgeId);
    if (!edge || !(edge.allowFrom || [edge.from]).includes(state)) return false;
    const changed = state !== edge.to || lastEdge !== edgeId;
    state = edge.to;
    lastEdge = edgeId;
    if (changed) emitState();
    edge.op?.(payload || {});
    return true;
  }

  function setVar(key, value) {
    const spec = varSpec.get(key);
    if (!spec) return false;
    if (spec.type === "range") {
      if (typeof value !== "number" || !Number.isFinite(value)) return false;
      value = clamp(value, spec.min, spec.max);
    } else if (!spec.options.some(([opt]) => opt === value)) {
      return false;
    }
    spec.value = params[key] = value;
    if (dialog.open && state !== "closing") {
      if (key === "maxZoom" && view.zoom > params.maxZoom) {
        view.zoom = params.maxZoom;
        Object.assign(view, withinPhoto());
      }
      draw();
      if (!input.pointers.size && !input.pinch && !input.wheelPinching) syncTrack();
    }
    return true;
  }

  const setConfig = patch => Object.entries(patch).reduce((ok, [k, v]) => setVar(k, v) || ok, false);
  const resetVars = () => setConfig(defaults);

  // --- Pure-GPU layout, rendering & tween engine ---

  const wrap = pos => ((pos % photoGrid.tiles.length) + photoGrid.tiles.length) % photoGrid.tiles.length;
  const tile = (offset = 0) => photoGrid.tiles[wrap(index + offset)];
  const previewUrl = img => img.currentSrc || img.src;
  const pullDistance = (h = stageBox.h) => Math.max(1, Math.round(h * .65));
  const pullScaleFor = (pull, span = pullDistance()) => clamp(1 - .85 * clamp(pull / span, 0, 1), .15, 1);

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
    return { w, h, width, height, limitX: Math.max(0, (width - w) / 2), limitY: Math.max(0, (height - h) / 2) };
  }

  function syncGrid(force = false) {
    if (!force && cache.synced === index) return;
    cache.synced = index;
    photoGrid.select(index);
    const r = stageBox.w && stageBox.h ? tile()?.getBoundingClientRect() : null;
    stageBox.tileAnchor = r && r.width && r.height
      ? { x: clamp(r.left + r.width / 2 - stageBox.left, 0, stageBox.w), y: clamp(r.top + r.height / 2 - stageBox.top, 0, stageBox.h) }
      : null;
    const img = tile().firstElementChild;
    if (img) {
      img.loading = "eager";
      img.decoding = "sync";
      img.decode?.().catch(() => {});
    }
  }

  function trackCursor(event) {
    if (!stageBox.w || !stageBox.h) return;
    stageBox.cursor = {
      x: clamp(event.clientX - stageBox.left, 0, stageBox.w),
      y: clamp(event.clientY - stageBox.top, 0, stageBox.h),
    };
  }

  function pullOrigin(w, h) {
    const c = stageBox.cursor, t = stageBox.tileAnchor;
    switch (params.pullAnchor) {
      case "tile":   return t ? [clamp(t.x, 0, w), clamp(t.y, 0, h)] : [w / 2, h / 2];
      case "center": return [w / 2, h / 2];
      case "left":   return [0, h / 2];
      case "right":  return [w, h / 2];
      case "top":    return [w / 2, 0];
      case "bottom": return [w / 2, h];
      default:       return c ? [clamp(c.x, 0, w), clamp(c.y, 0, h)] : [w / 2, h / 2];
    }
  }

  function renderSlide(slide, width, height, tx, ty, scale = 1) {
    const s = slide.element.style;
    if (slide.w !== width || slide.h !== height) {
      slide.w = width; slide.h = height;
      s.width = width + "px"; s.height = height + "px";
    }
    if (slide.clipped) {
      slide.clipped = false;
      s.overflow = s.borderRadius = "";
    }
    if (slide.tx !== tx || slide.ty !== ty || slide.scale !== scale) {
      slide.tx = tx; slide.ty = ty; slide.scale = scale;
      s.transform = scale === 1
        ? `translate3d(${tx}px, ${ty}px, 0)`
        : `translate3d(${tx}px, ${ty}px, 0) scale(${scale}, ${scale})`;
    }
  }

  function draw() {
    const t0 = performance.now();
    const { w, h, width, height } = geometry();
    if (!w || !h) return;
    const { x, y, zoom, page, pull, fade } = view;
    const shrinking = pull > 0 && zoom >= 1 && !page && width && height;
    const pullScale = shrinking ? pullScaleFor(pull, pullDistance(h)) : 1;
    const effectiveScale = Math.min(zoom, pullScale);
    const shade = clamp(1 - Math.max(fade, 1.6 * (1 - effectiveScale)), 0, 1);
    if (shade < 1) syncGrid();

    const leftW = Math.min(w, h * slides[0].ratio), leftH = leftW / slides[0].ratio;
    const rightW = Math.min(w, h * slides[2].ratio), rightH = rightW / slides[2].ratio;
    renderSlide(slides[0], leftW, leftH, (w - leftW) / 2 + (page > 0 ? page - w : -w), (h - leftH) / 2);
    renderSlide(slides[2], rightW, rightH, (w - rightW) / 2 + (page < 0 ? page + w : w), (h - rightH) / 2);

    if (shrinking) {
      const [ax, ay] = pullOrigin(w, h);
      renderSlide(slides[1], width, height, ax + ((w - width) / 2 + x - ax) * pullScale, ay + ((h - height) / 2 + y - ay) * pullScale, pullScale);
    } else {
      renderSlide(slides[1], width, height, (w - width) / 2 + x + page, (h - height) / 2 + y);
    }

    if (shade !== cache.shade) {
      cache.shade = shade;
      dialog.style.setProperty("--shade", shade);
    }
    const mapHidden = zoom <= 1 || !!(page || pull || state === "closing");
    if (mapHidden !== cache.mapHidden) {
      cache.mapHidden = mapHidden;
      map.hidden = mapHidden;
    }
    if (!mapHidden) {
      const left = .5 - (w / 2 + x) / width, top = .5 - (h / 2 + y) / height;
      const b = bounds.style;
      b.left = clamp(left, 0, 1) * 100 + "%";
      b.top = clamp(top, 0, 1) * 100 + "%";
      b.width = (clamp(left + w / width, 0, 1) - clamp(left, 0, 1)) * 100 + "%";
      b.height = (clamp(top + h / height, 0, 1) - clamp(top, 0, 1)) * 100 + "%";
    }
    const zoomed = zoom > 1;
    if (zoomed !== cache.zoomed) {
      cache.zoomed = zoomed;
      stage.classList.toggle("zoomed", zoomed);
    }
    telemetry.drawUs = (performance.now() - t0) * 1000;
    telemetry.scale = effectiveScale;
    telemetry.page = page;
  }

  const settled = target => Object.keys(target).every(k => Math.abs(view[k] - target[k]) < (k === "zoom" || k === "fade" ? .001 : .5));

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

  function scaledDuration(ratio, maxMs, minMs, curve) {
    const p = clamp(ratio, 0, 1);
    const f = curve === "log" ? Math.log1p(9 * p) / Math.LN10 : p;
    return Math.max(1, Math.round(clamp(maxMs * f, Math.min(minMs, maxMs), maxMs)));
  }

  function travelRatio(start, target) {
    const { w, h } = geometry();
    let ratio = 0;
    if ("page" in target && w) ratio = Math.max(ratio, Math.abs(target.page - start.page) / w);
    if ("pull" in target && h) ratio = Math.max(ratio, Math.abs(target.pull - start.pull) / pullDistance(h));
    if ("x" in target && w) ratio = Math.max(ratio, Math.abs(target.x - start.x) / w);
    if ("y" in target && h) ratio = Math.max(ratio, Math.abs(target.y - start.y) / h);
    if ("zoom" in target) ratio = Math.max(ratio, Math.abs(target.zoom - start.zoom) / Math.max(1, start.zoom, target.zoom));
    return clamp(ratio, 0, 1);
  }

  function tween(duration, onStep, onDone) {
    cancelAnimationFrame(animation);
    const since = performance.now(), instant = reducedMotion.matches || duration <= 0;
    const power = params.easePower;
    function tick(now) {
      const t = instant ? 1 : clamp((now - since) / duration, 0, 1);
      onStep(1 - (1 - t) ** power, t);
      if (t < 1) animation = requestAnimationFrame(tick);
      else onDone();
    }
    tick(since);
  }

  function animateTo(target, done) {
    const start = { ...view }, keys = Object.keys(target);
    const duration = settled(target) ? 0 : scaledDuration(travelRatio(start, target), params.settleMs, params.settleMinMs, params.settleCurve);
    tween(
      duration,
      (ease, t) => {
        const k = 1 - ease;
        for (const key of keys) view[key] = target[key] + (start[key] - target[key]) * k;
        if (t < 1 || !done) draw();
      },
      done || syncTrack,
    );
  }

  function syncZoomState() {
    if (view.zoom > 1) transition("zoom");
    else if (view.zoom < 1) transition("pull");
  }

  function finishPinch(animate) {
    if (!isOpen() || input.pointers.size) return;
    if (view.zoom < params.dismissScale) transition("dismiss");
    else if (view.zoom < 1) transition("bounce", { target: fitted });
    else if (view.zoom === 1) transition("fit", { animate: false });
    else if (animate) animateTo(withinPhoto());
    else syncTrack();
  }

  function zoomTo(zoom, anchor = { x: 0, y: 0 }) {
    if (!isOpen() || input.pointers.size) return;
    cancelAnimationFrame(animation);
    const nextZoom = clamp(zoom, 1, params.maxZoom);
    scaleAt(nextZoom, anchor, anchor);
    Object.assign(view, withinPhoto());
    if (nextZoom > 1) { transition("zoom"); draw(); syncTrack(); }
    else transition("fit", { animate: false });
  }

  // --- Slide & dialog lifecycle (invoked by graph edges) ---

  function loadSlide(slide, position, preload = false) {
    if (slide.index === position && slide.element.firstElementChild) return;
    const thumb = photoGrid.tiles[position].firstElementChild;
    const image = new Image();
    image.alt = thumb.alt;
    image.draggable = false;
    image.decoding = "sync";
    image.src = previewUrl(thumb);
    slide.index = position;
    slide.ratio = Number(thumb.getAttribute("width")) / Number(thumb.getAttribute("height"));
    slide.full = false;
    slide.element.replaceChildren(image);
    if (preload) image.decode().catch(() => {});
  }

  async function upgradeSlide(slide, position, showError = false) {
    if (slide.index !== position || slide.full) return true;
    const link = photoGrid.tiles[position], thumb = link.firstElementChild;
    const full = new Image();
    if (showError) pending = full;
    full.alt = thumb.alt;
    full.draggable = false;
    full.decoding = "sync";
    full.src = link.href;
    try {
      await full.decode();
      if (!dialog.open || state === "closing" || slide.index !== position || slide.full) return false;
      if (showError && pending !== full) return false;
      // Keep the low-res preview mounted behind the opaque full-res image until the slide
      // rotates out; removing it mid-upload causes a 1-frame black flash on 120Hz/WebKit.
      slide.element.append(full);
      slide.full = true;
      if (slide === slides[1]) mapImg.src = full.src;
      return true;
    } catch {
      if (showError && pending === full) notice.textContent = "Couldn’t load the full-size photograph.";
      return false;
    }
  }

  async function openPhoto(position, step = 0) {
    if (state === "closing") return;
    cancelAnimationFrame(animation);
    resetTrackInput();
    input.pointers.clear();
    input.lastTap = null;
    const target = wrap(position), count = photoGrid.tiles.length, opening = !dialog.open;
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
    }
    for (let i = 0; i < slides.length; i++) slides[i].element.classList.toggle("current", i === 1);
    const link = tile(), thumb = link.firstElementChild, active = slides[1];
    map.style.setProperty("--ratio", active.ratio);
    mapImg.src = active.element.lastElementChild?.src || previewUrl(thumb);
    notice.textContent = "";
    Object.assign(view, fitted);
    if (opening) {
      dialog.showModal();
      emitToggle(true);
      measureStage();
      syncGrid(true);
    } else if (thumb) {
      thumb.loading = "eager";
      thumb.decoding = "sync";
      thumb.decode?.().catch(() => {});
    }
    draw();
    syncTrack();
    if (active.full) {
      pending = null;
      mapImg.src = link.href;
    } else {
      await upgradeSlide(active, index, true);
    }
    // Pre-upgrade adjacent slides to full-res once the current photo is ready so one-finger
    // swipes land directly on an already-composited full-res layer with zero post-settle swap.
    if (dialog.open && state !== "closing" && count > 1 && active === slides[1] && active.index === index) {
      upgradeSlide(slides[2], slides[2].index);
      upgradeSlide(slides[0], slides[0].index);
    }
  }

  function runDismiss() {
    if (!dialog.open) return;
    cancelAnimationFrame(animation);
    resetTrackInput();
    track.style.overflow = "hidden";
    input.pointers.clear();
    syncGrid();
    const active = slides[1], returning = active.element;
    const vpRect = viewport.getBoundingClientRect();
    const from = returning.getBoundingClientRect(), to = tile().getBoundingClientRect();
    if (!from.width || !from.height || !to.width || !to.height) {
      tile().classList.remove("in-viewer");
      emitToggle(false);
      return dialog.close();
    }
    const startShade = cache.shade ?? 1;
    map.hidden = cache.mapHidden = true;
    slides[0].element.hidden = slides[2].element.hidden = true;
    const baseW = active.w || from.width, baseH = active.h || from.height;
    const fromX = from.left - vpRect.left, fromY = from.top - vpRect.top;
    const toX = to.left - vpRect.left, toY = to.top - vpRect.top;
    const fromSX = from.width / baseW, fromSY = from.height / baseH;
    const toSX = to.width / baseW, toSY = to.height / baseH;
    const visualScale = from.width / (geometry(1).width || baseW);
    const duration = scaledDuration(visualScale / params.dismissScale, params.dismissMaxMs, params.dismissMinMs, params.dismissCurve);
    active.clipped = true;
    returning.style.overflow = "hidden";
    tween(
      duration,
      ease => {
        const x = fromX + (toX - fromX) * ease, y = fromY + (toY - fromY) * ease;
        const sx = fromSX + (toSX - fromSX) * ease, sy = fromSY + (toSY - fromSY) * ease;
        returning.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${sx}, ${sy})`;
        returning.style.borderRadius = (5 * ease / Math.min(sx, sy)) + "px";
        dialog.style.setProperty("--shade", startShade * (1 - ease));
      },
      () => {
        // Reveal the tile and reparent the top panel back to <body> BEFORE dialog.close()
        // so neither the photo nor the top bar can flash or drop --tuner-h to 0px.
        tile().classList.remove("in-viewer");
        emitToggle(false);
        requestAnimationFrame(() => requestAnimationFrame(() => dialog.close()));
      },
    );
  }

  function finishClose() {
    resetTrackInput();
    track.style.overflow = "";
    if (input.absorbUntil) input.lastAbsorbed = performance.now();
    pending = input.trackMeta = input.axis = null;
    input.scrolled = false;
    stageBox.w = stageBox.h = 0;
    stageBox.cursor = stageBox.tileAnchor = null;
    cache.synced = -1;
    cache.layoutKey = "";
    cache.shade = cache.zoomed = cache.mapHidden = null;
    telemetry.scale = 1;
    telemetry.page = 0;
    for (const s of slides) {
      s.index = -1; s.full = s.clipped = false;
      s.w = s.h = 0; s.tx = s.ty = s.scale = NaN;
      s.element.style.cssText = "";
      s.element.replaceChildren();
    }
    emitToggle(false);
    photoGrid.restore();
  }

  // --- Pointer gestures (touchscreens & mouse drag) ---

  const stagePoint = e => ({ x: e.clientX - stageBox.left - stageBox.w / 2, y: e.clientY - stageBox.top - stageBox.h / 2 });

  // Multi-touch centroid and RMS spread relative to stage center (works for any finger count n >= 1).
  function measurePointers() {
    let x = 0, y = 0, sq = 0;
    for (const p of input.pointers.values()) { x += p.clientX; y += p.clientY; }
    x /= input.pointers.size; y /= input.pointers.size;
    for (const p of input.pointers.values()) sq += (p.clientX - x) ** 2 + (p.clientY - y) ** 2;
    return { x: x - stageBox.left - stageBox.w / 2, y: y - stageBox.top - stageBox.h / 2, spread: Math.sqrt(sq / input.pointers.size) };
  }

  function rebase() {
    input.gesture.start = input.gesture.last = measurePointers();
    input.gesture.baseline = { ...view };
    input.gesture.axis = view.page ? "x" : view.pull ? "y" : null;
  }

  function moveOnMap(event) {
    const r = map.getBoundingClientRect(), { width, height } = geometry();
    view.x = (.5 - (event.clientX - r.left) / r.width) * width + input.gesture.mapX;
    view.y = (.5 - (event.clientY - r.top) / r.height) * height + input.gesture.mapY;
    Object.assign(view, withinPhoto());
  }

  function dragBy(dx, dy, axis) {
    const { w, h, limitX, limitY } = geometry(), horiz = axis === "x";
    const x = view.x + dx + (horiz ? view.page : 0);
    const y = view.y + dy + (horiz ? 0 : view.pull);
    view.x = clamp(x, Math.min(view.x, -limitX), Math.max(view.x, limitX));
    view.y = clamp(y, Math.min(view.y, -limitY), Math.max(view.y, limitY));
    if (horiz && photoGrid.tiles.length > 1) view.page = clamp(x - view.x, -w, w);
    if (!horiz) view.pull = clamp(y - view.y, 0, pullDistance(h));
  }

  function project(history, now, value, slot) {
    const [time, page, pull] = history[0], dt = now - time;
    return value + (dt > 0 && dt < 120 ? (value - (slot === "page" ? page : pull)) / dt * 160 : 0);
  }

  stage.onpointerdown = event => {
    if (!isOpen() || event.button !== 0) return;
    trackCursor(event);
    resetTrackInput();
    cancelAnimationFrame(animation);
    if (input.scrolled) syncTrack();
    input.pointers.set(event.pointerId, event);
    stage.setPointerCapture(event.pointerId);
    if (input.pointers.size === 1) {
      const onMap = map.contains(event.target);
      input.gesture = { tap: true, backdrop: !onMap && !slides[1].element.contains(event.target), history: [], onMap };
      if (onMap) {
        const r = map.getBoundingClientRect(), g = bounds.getBoundingClientRect(), { width, height } = geometry();
        const inside = event.clientX >= g.left && event.clientX <= g.right && event.clientY >= g.top && event.clientY <= g.bottom;
        input.gesture.mapX = inside ? view.x - (.5 - (event.clientX - r.left) / r.width) * width : 0;
        input.gesture.mapY = inside ? view.y - (.5 - (event.clientY - r.top) / r.height) * height : 0;
        moveOnMap(event);
        draw();
      }
    } else {
      input.gesture.tap = input.gesture.onMap = false;
      input.lastTap = null;
    }
    rebase();
    input.gesture.history = [[event.timeStamp, view.page, view.pull]];
  };

  stage.onpointermove = event => {
    if (isOpen()) trackCursor(event);
    if (!input.pointers.has(event.pointerId)) return;
    input.pointers.set(event.pointerId, event);
    const g = input.gesture, point = measurePointers(), last = g.last;
    if (g.onMap) {
      moveOnMap(event);
    } else if (input.pointers.size > 1) {
      const zoom = g.start.spread ? g.baseline.zoom * point.spread / g.start.spread : g.baseline.zoom;
      scaleAt(clamp(zoom, .15, params.maxZoom), g.start, point, g.baseline);
      if (!g.start.spread && point.spread) rebase();
      syncZoomState();
    } else {
      if (!g.axis) {
        const dx = point.x - g.start.x, dy = point.y - g.start.y;
        if (g.tap && Math.hypot(dx, dy) < 5) return;
        g.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
      }
      g.tap = false;
      dragBy(point.x - last.x, point.y - last.y, g.axis);
      if (view.page) transition("swipe");
      else if (view.pull) transition("pull");
    }
    g.last = point;
    g.history = g.history.filter(([time]) => event.timeStamp - time < 100);
    g.history.push([event.timeStamp, view.page, view.pull]);
    draw();
  };

  function release(event, cancelled) {
    if (!input.pointers.delete(event.pointerId)) return;
    const g = input.gesture;
    g.cancelled ||= cancelled;
    if (input.pointers.size) return rebase();
    if (!g.cancelled) {
      if (g.tap && !g.onMap) {
        if (input.lastTap && event.timeStamp - input.lastTap.time < 320 && Math.hypot(event.clientX - input.lastTap.x, event.clientY - input.lastTap.y) < 28) {
          input.lastTap = null;
          return transition("fit", { animate: true });
        }
        input.lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
        if (g.backdrop && view.zoom === 1) return transition("dismiss");
      } else input.lastTap = null;
      if (view.zoom < params.dismissScale || (view.pull > 8 && project(g.history, event.timeStamp, view.pull, "pull") > stageBox.h * .2)) {
        return transition("dismiss");
      }
      const dir = Math.sign(view.page);
      if (g.axis === "x" && dir * project(g.history, event.timeStamp, view.page, "page") > stageBox.w / 2) {
        return transition("settle", { step: -dir, target: { page: dir * stageBox.w, pull: 0 } });
      }
    }
    if (state === "pulling") return transition("bounce", { target: view.zoom < 1 ? fitted : withinPhoto() });
    if (state === "paging") return transition("settle", { target: withinPhoto() });
    if (view.zoom > 1) return animateTo(withinPhoto());
    if (!settled(fitted)) return transition("fit", { animate: true });
    syncTrack();
  }

  stage.onpointerup = e => release(e, false);
  stage.onpointercancel = stage.onlostpointercapture = e => release(e, true);

  // --- Trackpad native scroll-snap, zoom & momentum guard ---

  function resetTrackInput() {
    clearTimeout(input.pinchTimer);
    clearTimeout(input.scrollTimer);
    input.pinch = null;
    input.wheelPinching = false;
  }

  function syncTrack() {
    if (!dialog.open || state === "closing") return;
    const { w, h, limitX, limitY } = geometry();
    if (!w || !h) return;
    const hasNeighbors = photoGrid.tiles.length > 1;
    const mode = (limitX > 0 || limitY > 0) ? "none" : params.snapAxis;
    const free = mode === "none", both = mode === "both";
    const { swipeSpeed, pullSpeed } = params;
    const padX = hasNeighbors ? Math.max(1, Math.round(w / swipeSpeed)) : 0;
    const pullSpan = pullDistance(h), pullSpace = Math.max(1, Math.round(pullSpan / pullSpeed));
    const key = `${w}:${h}:${limitX}:${limitY}:${hasNeighbors}:${mode}:${swipeSpeed}:${pullSpeed}`;
    const layoutChanged = key !== cache.layoutKey;
    if (layoutChanged) {
      cache.layoutKey = key;
      track.style.scrollSnapType = "none";
      track.style.setProperty("--w", w + "px");
      track.style.setProperty("--h", h + "px");
      track.classList.toggle("free", free);
      track.classList.toggle("snap-both", both);
      trackSpace.style.width = (padX * 2 + w + limitX * 2) + "px";
      trackSpace.style.height = (pullSpace + h + limitY * 2) + "px";
      snapPrev.hidden = snapNext.hidden = !hasNeighbors || free;
      snapCurr.hidden = free;
      snapPull.hidden = !both;
      if (!free) {
        const y = both ? pullSpace : 0, sh = both ? h + "px" : "100%";
        for (const [el, x, sw] of [[snapPrev, 0, padX], [snapCurr, padX, padX], [snapNext, padX * 2, w]]) {
          el.style.left = x + "px"; el.style.top = y + "px";
          el.style.width = sw + "px"; el.style.height = sh;
        }
        if (both) {
          snapPull.style.left = padX + "px"; snapPull.style.top = "0px";
          snapPull.style.width = padX + "px"; snapPull.style.height = pullSpace + "px";
        }
      }
    }
    const originX = padX + limitX, originY = pullSpace + limitY;
    track.scrollLeft = Math.round(originX - view.x - view.page / swipeSpeed);
    track.scrollTop = Math.round(originY - view.y - view.pull / pullSpeed);
    if (layoutChanged) { void track.scrollLeft; track.style.scrollSnapType = ""; }
    input.trackMeta = {
      w, h, limitX, limitY, padX, pullSpan, pullSpace, hasNeighbors, free, both, swipeSpeed, pullSpeed,
      originX, originY, left: track.scrollLeft, top: track.scrollTop,
    };
    input.axis = null;
    input.scrolled = false;
    clearTimeout(input.scrollTimer);
  }

  function onTrackScroll() {
    const meta = input.trackMeta;
    if (!dialog.open || !isOpen() || input.pointers.size || input.pinch || input.wheelPinching || !meta) return;
    const { w, limitX, limitY, originX, originY, pullSpan, hasNeighbors, swipeSpeed, pullSpeed, left, top } = meta;
    const sl = track.scrollLeft, st = track.scrollTop;
    if (!input.scrolled && Math.abs(sl - left) < 1 && Math.abs(st - top) < 1) return;
    input.scrolled = true;
    cancelAnimationFrame(animation);
    const dx = originX - sl, dy = originY - st;
    const x = clamp(dx, -limitX, limitX), y = clamp(dy, -limitY, limitY);
    const remX = hasNeighbors ? dx - x : 0, remY = Math.max(0, dy - y);
    const rawPage = hasNeighbors ? clamp(remX * swipeSpeed, -w, w) : 0;
    const rawPull = clamp(remY * pullSpeed, 0, pullSpan);
    if (!input.axis && (remX || remY)) {
      if (Math.hypot(remX, remY) >= 8) input.axis = Math.abs(remX) >= remY ? "x" : "y";
    } else if (input.axis === "y" && rawPull < 30 && Math.abs(remX) > remY * 2 && Math.abs(remX) > 24) {
      input.axis = "x";
    } else if (input.axis && !remX && !remY) {
      input.axis = null;
    }
    const axis = input.axis || (Math.abs(remX) >= remY ? "x" : "y");
    view.x = x; view.y = y;
    view.page = axis === "x" ? rawPage : 0;
    view.pull = axis === "y" ? rawPull : 0;
    if (view.zoom <= 1) {
      if (view.page && state !== "paging") transition("swipe");
      else if (view.pull && state !== "pulling") transition("pull");
    }
    draw();
    if (axis === "y" && view.zoom <= 1 && (st <= 1 || rawPull >= pullSpan - 1)) {
      input.scrolled = false;
      input.axis = null;
      const now = performance.now();
      input.absorbUntil = now + 1800;
      input.lastAbsorbed = now;
      return void transition("dismiss");
    }
    if (!hasScrollEnd) {
      clearTimeout(input.scrollTimer);
      input.scrollTimer = setTimeout(onTrackScrollEnd, 150);
    }
  }

  function onTrackScrollEnd() {
    clearTimeout(input.scrollTimer);
    const meta = input.trackMeta;
    if (!dialog.open || !isOpen() || input.pointers.size || input.pinch || input.wheelPinching || !meta || !input.scrolled) return;
    const { w, padX, pullSpan, hasNeighbors, free, both } = meta;
    const sl = track.scrollLeft, st = track.scrollTop, axis = input.axis;
    input.scrolled = false;
    input.axis = null;
    if (axis === "y") {
      if ((both && st <= 2) || pullScaleFor(view.pull, pullSpan) < params.dismissScale) return transition("dismiss");
      if (!free && hasNeighbors && sl >= padX * 2 - 2) return transition("settle", { step: 1, immediate: true });
      if (!free && hasNeighbors && sl <= 2) return transition("settle", { step: -1, immediate: true });
      return transition("bounce", { target: withinPhoto() });
    }
    if (!free && hasNeighbors) {
      if (sl >= padX * 2 - 2) return transition("settle", { step: 1, immediate: true });
      if (sl <= 2) return transition("settle", { step: -1, immediate: true });
      return transition("settle");
    }
    const dir = Math.sign(view.page);
    if (axis === "x" && hasNeighbors && dir && Math.abs(view.page) > w / 2) {
      return transition("settle", { step: -dir, target: { page: dir * w, pull: 0 } });
    }
    if (view.page) return transition("settle", { target: withinPhoto() });
    if (view.pull) return transition("bounce", { target: withinPhoto() });
    syncTrack();
  }

  track.addEventListener("scroll", onTrackScroll, { passive: true });
  if (hasScrollEnd) track.addEventListener("scrollend", onTrackScrollEnd);
  window.addEventListener?.("wheel", event => {
    if (!input.absorbUntil) return;
    const now = performance.now();
    if (now > input.absorbUntil || now - input.lastAbsorbed > 120 || event.deltaY >= 0) {
      input.absorbUntil = 0;
      return;
    }
    input.lastAbsorbed = now;
    if (!dialog.open && event.cancelable) event.preventDefault();
  }, { passive: false });

  stage.addEventListener("wheel", event => {
    if (!isOpen() || input.pointers.size) {
      if (event.cancelable) event.preventDefault();
      return;
    }
    trackCursor(event);
    const now = performance.now();
    if (!event.ctrlKey && !event.metaKey) {
      if (input.wheelPinching) {
        if (now - input.lastPinch < 60) { if (event.cancelable) event.preventDefault(); return; }
        clearTimeout(input.pinchTimer);
        input.wheelPinching = false;
        if (view.zoom >= 1) syncTrack();
      }
      const gap = now - input.lastWheel, meta = input.trackMeta;
      input.lastWheel = now;
      if (event.cancelable && gap >= 80 && input.scrolled && meta && !meta.free && meta.hasNeighbors && input.axis !== "y") {
        if (track.scrollLeft >= meta.padX * 2 - 4 && event.deltaX > 0) return void transition("settle", { step: 1, immediate: true });
        if (track.scrollLeft <= 4 && event.deltaX < 0) return void transition("settle", { step: -1, immediate: true });
      }
      return;
    }
    if (event.cancelable) event.preventDefault();
    resetTrackInput();
    input.axis = null;
    input.scrolled = false;
    input.wheelPinching = true;
    input.lastPinch = now;
    cancelAnimationFrame(animation);
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stageBox.h : 1;
    const factor = (event.ctrlKey && event.deltaMode === 0 ? .01 : .004) * params.zoomSpeed;
    const anchor = stagePoint(event);
    scaleAt(clamp(view.zoom * Math.exp(-event.deltaY * unit * factor), event.ctrlKey ? .15 : 1, params.maxZoom), anchor, anchor);
    if (view.zoom >= 1) Object.assign(view, withinPhoto());
    syncZoomState();
    draw();
    input.pinchTimer = setTimeout(() => { input.wheelPinching = false; finishPinch(false); }, 140);
  }, { passive: false });

  stage.addEventListener("gesturestart", event => {
    event.preventDefault();
    if (!isOpen() || input.pointers.size) return;
    resetTrackInput();
    cancelAnimationFrame(animation);
    input.pinch = { baseline: { ...view }, start: stagePoint(event) };
  });
  stage.addEventListener("gesturechange", event => {
    event.preventDefault();
    if (!input.pinch || !isOpen() || input.pointers.size) return;
    scaleAt(clamp(input.pinch.baseline.zoom * event.scale, .15, params.maxZoom), input.pinch.start, stagePoint(event), input.pinch.baseline);
    if (view.zoom >= 1) Object.assign(view, withinPhoto());
    syncZoomState();
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
  stage.ondblclick = () => {
    if (isOpen() && !input.pointers.size && input.gesture?.tap && !input.gesture.onMap) transition("fit", { animate: true });
  };
  dialog.oncancel = event => { event.preventDefault(); transition("dismiss"); };
  dialog.onclose = () => {
    if (dialog.open) return;
    if (!transition("finish")) { state = "closed"; lastEdge = "finish"; emitState(); finishClose(); }
  };
  dialog.onkeydown = event => {
    if (!isOpen() || input.pointers.size || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target?.matches?.("input, select, textarea")) return;
    if (event.shiftKey && view.zoom > 1 && event.key.startsWith("Arrow")) {
      view.x += ({ ArrowLeft: stageBox.w / 5, ArrowRight: -stageBox.w / 5 })[event.key] || 0;
      view.y += ({ ArrowUp: stageBox.h / 5, ArrowDown: -stageBox.h / 5 })[event.key] || 0;
      zoomTo(view.zoom);
    } else {
      switch (event.key) {
        case "ArrowLeft": transition("settle", { step: -1, immediate: true }); break;
        case "ArrowRight": transition("settle", { step: 1, immediate: true }); break;
        case "+":
        case "=": zoomTo(view.zoom * 1.5); break;
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

  const api = {
    graph, defaults, config: params, telemetry,
    get state() { return state; },
    get lastEdge() { return lastEdge; },
    setVar, setConfig, resetVars, refreshLayout,
    onState(fn) { listeners.state.add(fn); return () => listeners.state.delete(fn); },
    onToggle(fn) { listeners.toggle.add(fn); return () => listeners.toggle.delete(fn); },
    debug() {
      if (typeof lightboxDebug !== "undefined") return lightboxDebug.mount(api);
      if (document.querySelector('script[src="js/lightbox-debug.js"]')) return null;
      const script = document.createElement("script");
      script.src = "js/lightbox-debug.js";
      document.head.append(script);
      return script;
    },
  };
  if (typeof location !== "undefined" && new URLSearchParams(location.search).has("debug")) api.debug();
  return api;
})();

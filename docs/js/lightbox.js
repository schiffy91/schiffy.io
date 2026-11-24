const dialog = document.querySelector("dialog");
const stage = dialog.querySelector(".stage");
const frame = stage.querySelector(".frame");
const previous = stage.querySelector(".previous");
const next = stage.querySelector(".next");
const map = stage.querySelector(".minimap");
const bounds = map.querySelector("span");
const notice = dialog.querySelector("#notice");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const clamp = (n, min, max) => Math.max(min, Math.min(max, n));
const fitted = { zoom: 1, x: 0, y: 0, page: 0, pull: 0, fade: 0 };
const view = { ...fitted };
const pointers = new Map();
let index = 0, ratio = 1, pending, animation, closing = false;
let gesture, lastTap;

function tile(offset = 0) {
  const tiles = photoGrid.tiles;
  return tiles[(index + offset + tiles.length) % tiles.length];
}

function geometry(zoom = view.zoom) {
  const w = stage.clientWidth, h = stage.clientHeight;
  const width = Math.min(w, h * ratio) * zoom, height = width / ratio;
  return { w, h, width, height, limitX: Math.max(0, (width - w) / 2), limitY: Math.max(0, (height - h) / 2) };
}

function draw() {
  const { w, h, width, height } = geometry();
  const { x, y, zoom, page, pull, fade } = view;
  frame.style.width = width + "px";
  frame.style.height = height + "px";
  frame.style.transform = `translate(${(w - width) / 2 + x + page}px, ${(h - height) / 2 + y + pull}px)`;
  previous.style.transform = `translateX(${page - w}px)`;
  next.style.transform = `translateX(${page + w}px)`;
  dialog.style.setProperty("--shade", clamp(1 - Math.max(fade, 1.6 * (1 - zoom), 1.6 * pull / h), 0, 1));
  map.hidden = zoom <= 1 || !!(page || pull || closing);
  const left = .5 - (w / 2 + x) / width, top = .5 - (h / 2 + y) / height;
  bounds.style.left = clamp(left, 0, 1) * 100 + "%";
  bounds.style.top = clamp(top, 0, 1) * 100 + "%";
  bounds.style.width = (clamp(left + w / width, 0, 1) - clamp(left, 0, 1)) * 100 + "%";
  bounds.style.height = (clamp(top + h / height, 0, 1) - clamp(top, 0, 1)) * 100 + "%";
  stage.classList.toggle("zoomed", zoom > 1);
}

// Only releases animate. A new press picks up the last rendered position.
function settle(target, done) {
  cancelAnimationFrame(animation);
  const start = { ...view }, since = performance.now();
  function tick(now) {
    const t = reducedMotion.matches ? 1 : Math.min(1, (now - since) / 210);
    for (const key of Object.keys(target)) view[key] = target[key] + (start[key] - target[key]) * (1 - t) ** 3;
    draw();
    if (t < 1) animation = requestAnimationFrame(tick);
    else done?.();
  }
  tick(since);
}

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

function zoomTo(zoom, anchor = { x: 0, y: 0 }) {
  if (closing || pointers.size) return;
  cancelAnimationFrame(animation);
  scaleAt(clamp(zoom, 1, 8), anchor, anchor);
  Object.assign(view, withinPhoto());
  draw();
}

async function show(position) {
  if (closing) return;
  cancelAnimationFrame(animation);
  pointers.clear();
  lastTap = null;
  index = (position + photoGrid.tiles.length) % photoGrid.tiles.length;
  const link = tile(), thumbnail = link.firstElementChild;
  const preview = thumbnail.cloneNode(false);
  preview.removeAttribute("srcset");
  preview.src = thumbnail.currentSrc || thumbnail.src;
  preview.loading = "eager";
  preview.draggable = false;
  frame.replaceChildren(preview);
  for (const [image, offset] of [[previous, -1], [next, 1]]) {
    const neighbor = tile(offset).firstElementChild;
    image.src = neighbor.currentSrc || neighbor.src;
  }
  ratio = Number(thumbnail.getAttribute("width")) / Number(thumbnail.getAttribute("height"));
  map.style.setProperty("--ratio", ratio);
  map.querySelector("img").src = preview.src;
  notice.textContent = "";
  Object.assign(view, fitted);
  if (!dialog.open) dialog.showModal();
  photoGrid.select(index);
  draw();
  const full = new Image();
  pending = full;
  full.alt = thumbnail.alt;
  full.draggable = false;
  full.src = link.href;
  try {
    await full.decode();
    if (pending !== full) return;
    frame.replaceChildren(full);
    map.querySelector("img").src = full.src;
  } catch {
    if (pending === full) notice.textContent = "Couldn’t load the full-size photograph.";
  }
}

function dismiss() {
  if (closing || !dialog.open) return;
  closing = true;
  dialog.classList.add("returning");
  pointers.clear();
  const target = tile().getBoundingClientRect(), stageRect = stage.getBoundingClientRect();
  const { width, height } = geometry(1);
  settle({ zoom: Math.min(target.width / width, target.height / height),
    x: target.left + target.width / 2 - stageRect.left - stageRect.width / 2,
    y: target.top + target.height / 2 - stageRect.top - stageRect.height / 2,
    page: 0, pull: 0, fade: 1 }, () => dialog.close());
}

// Coordinates relative to the stage center. RMS spread works for any finger count.
function measure() {
  const rect = stage.getBoundingClientRect();
  let x = 0, y = 0, squares = 0;
  for (const p of pointers.values()) { x += p.clientX; y += p.clientY; }
  x /= pointers.size;
  y /= pointers.size;
  for (const p of pointers.values()) squares += (p.clientX - x) ** 2 + (p.clientY - y) ** 2;
  return { x: x - rect.left - rect.width / 2, y: y - rect.top - rect.height / 2, spread: Math.sqrt(squares / pointers.size) };
}

function rebase() {
  gesture.start = gesture.last = measure();
  gesture.baseline = { ...view };
  gesture.axis = null;
}

function moveOnMap(event) {
  const rect = map.getBoundingClientRect(), { width, height } = geometry();
  view.x = (.5 - (event.clientX - rect.left) / rect.width) * width + gesture.mapX;
  view.y = (.5 - (event.clientY - rect.top) / rect.height) * height + gesture.mapY;
  Object.assign(view, withinPhoto());
}

stage.onpointerdown = event => {
  if (closing || event.button !== 0) return;
  cancelAnimationFrame(animation);
  pointers.set(event.pointerId, event);
  stage.setPointerCapture(event.pointerId);
  if (pointers.size === 1) {
    gesture = { tap: true, backdrop: event.target === stage, history: [], onMap: map.contains(event.target) };
    if (gesture.onMap) {
      const rect = map.getBoundingClientRect(), { width, height } = geometry();
      const grip = bounds.getBoundingClientRect();
      const inside = event.clientX >= grip.left && event.clientX <= grip.right && event.clientY >= grip.top && event.clientY <= grip.bottom;
      gesture.mapX = inside ? view.x - (.5 - (event.clientX - rect.left) / rect.width) * width : 0;
      gesture.mapY = inside ? view.y - (.5 - (event.clientY - rect.top) / rect.height) * height : 0;
      moveOnMap(event);
      draw();
    }
  } else {
    gesture.tap = gesture.onMap = false;
    lastTap = null;
  }
  rebase();
  gesture.history = [[event.timeStamp, view.page, view.pull]];
};

function dragBy(dx, dy) {
  const { w, h, limitX, limitY } = geometry();
  const horizontal = gesture.axis === "x";
  const x = view.x + dx + (horizontal ? view.page : 0);
  const y = view.y + dy + (horizontal ? 0 : view.pull);
  // A pinch may leave the image outside its pan limits. Never jump on handoff.
  view.x = clamp(x, Math.min(view.x, -limitX), Math.max(view.x, limitX));
  view.y = clamp(y, Math.min(view.y, -limitY), Math.max(view.y, limitY));
  if (horizontal && photoGrid.tiles.length > 1) view.page = clamp(x - view.x, -w, w);
  if (!horizontal) view.pull = clamp(y - view.y, 0, h);
}

stage.onpointermove = event => {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, event);
  const point = measure(), last = gesture.last;
  if (gesture.onMap) moveOnMap(event);
  else if (pointers.size > 1) {
    const { start, baseline } = gesture;
    const zoom = start.spread ? baseline.zoom * point.spread / start.spread : baseline.zoom;
    scaleAt(clamp(zoom, .15, 8), start, point, baseline);
    if (!start.spread && point.spread) rebase();
  } else {
    if (!gesture.axis) {
      const dx = point.x - gesture.start.x, dy = point.y - gesture.start.y;
      if (gesture.tap && Math.hypot(dx, dy) < 5) return;
      gesture.axis = Math.abs(dx) >= Math.abs(dy) ? "x" : "y";
    }
    gesture.tap = false;
    dragBy(point.x - last.x, point.y - last.y);
  }
  gesture.last = point;
  gesture.history = gesture.history.filter(([time]) => event.timeStamp - time < 100);
  gesture.history.push([event.timeStamp, view.page, view.pull]);
  draw();
};

function release(event, cancelled) {
  if (!pointers.delete(event.pointerId)) return;
  gesture.cancelled ||= cancelled;
  if (pointers.size) {
    rebase();
    return;
  }
  const [time, page, pull] = gesture.history[0];
  const dt = event.timeStamp - time;
  const project = (value, before) => value + (dt > 0 && dt < 120 ? (value - before) / dt * 160 : 0);
  if (!gesture.cancelled) {
    if (gesture.tap && !gesture.onMap) {
      if (lastTap && event.timeStamp - lastTap.time < 320 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 28) {
        lastTap = null;
        return settle(fitted);
      }
      lastTap = { time: event.timeStamp, x: event.clientX, y: event.clientY };
      if (gesture.backdrop && view.zoom === 1) return dismiss();
    } else lastTap = null;
    if (view.zoom < .78 || (view.pull > 8 && project(view.pull, pull) > stage.clientHeight * .22)) return dismiss();
    const direction = Math.sign(view.page);
    if (gesture.axis === "x" && direction * project(view.page, page) > stage.clientWidth / 2) {
      return settle({ page: direction * stage.clientWidth }, () => show(index - direction));
    }
  }
  settle(view.zoom < 1 ? fitted : withinPhoto());
}

stage.onpointerup = event => release(event, false);
stage.onpointercancel = stage.onlostpointercapture = event => release(event, true);
stage.onwheel = event => {
  event.preventDefault();
  const rect = stage.getBoundingClientRect();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1;
  zoomTo(view.zoom * Math.exp(-event.deltaY * unit * .002), { x: event.clientX - rect.left - rect.width / 2, y: event.clientY - rect.top - rect.height / 2 });
};
photoGrid.onOpen(show);
stage.ondblclick = () => {
  if (!closing && !pointers.size && gesture?.tap && !gesture.onMap) settle(fitted);
};
dialog.oncancel = event => { event.preventDefault(); dismiss(); };
dialog.onclose = () => {
  if (dialog.open) return;
  dialog.classList.remove("returning");
  pending = null;
  closing = false;
  frame.replaceChildren();
  photoGrid.restore();
};
dialog.onkeydown = event => {
  if (closing || pointers.size || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.shiftKey && view.zoom > 1 && event.key.startsWith("Arrow")) {
    const { w, h } = geometry();
    view.x += ({ ArrowLeft: w / 5, ArrowRight: -w / 5 })[event.key] || 0;
    view.y += ({ ArrowUp: h / 5, ArrowDown: -h / 5 })[event.key] || 0;
    zoomTo(view.zoom);
  } else {
    switch (event.key) {
      case "ArrowLeft": show(index - 1); break;
      case "ArrowRight": show(index + 1); break;
      case "+":
      case "=": zoomTo(view.zoom * 1.5); break;
      case "-": zoomTo(view.zoom / 1.5); break;
      case "0": settle(fitted); break;
      default: return;
    }
  }
  event.preventDefault();
};
new ResizeObserver(() => {
  if (!dialog.open || closing) return;
  photoGrid.select(index);
  if (pointers.size) rebase();
  else Object.assign(view, withinPhoto());
  draw();
}).observe(stage);

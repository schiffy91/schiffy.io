const gallery = document.querySelector(".gallery");
const photos = Array.from(gallery.children);

// Shuffle once. The layout, tab order and viewer all use this same sequence.
for (let i = photos.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [photos[i], photos[j]] = [photos[j], photos[i]];
}
gallery.replaceChildren(...photos);

const dialog = document.querySelector("dialog");
const stage = dialog.querySelector(".stage");
const frame = dialog.querySelector(".frame");
const map = dialog.querySelector(".minimap");
const bounds = map.querySelector("span");
const counter = document.querySelector("#counter");
const fit = document.querySelector("#fit");
const smaller = document.querySelector("#smaller");
const larger = document.querySelector("#larger");
const notice = document.querySelector("#notice");
const maxZoom = 8;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

let index = 0;
let pending;
let zoom = 1;
let centerX = 0.5;
let centerY = 0.5;
let drag;

function draw() {
  if (!dialog.open) return;
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (!width || !height) return;
  const photo = photos[index].firstElementChild;
  const ratio = photo.getAttribute("width") / photo.getAttribute("height");
  const imageWidth = Math.min(width, height * ratio) * zoom;
  const imageHeight = imageWidth / ratio;
  const visibleX = Math.min(1, width / imageWidth);
  const visibleY = Math.min(1, height / imageHeight);
  centerX = clamp(centerX, visibleX / 2, 1 - visibleX / 2);
  centerY = clamp(centerY, visibleY / 2, 1 - visibleY / 2);

  frame.style.width = imageWidth + "px";
  frame.style.height = imageHeight + "px";
  frame.style.transform = `translate(${width / 2 - centerX * imageWidth}px, ${height / 2 - centerY * imageHeight}px)`;
  bounds.style.left = (centerX - visibleX / 2) * 100 + "%";
  bounds.style.top = (centerY - visibleY / 2) * 100 + "%";
  bounds.style.width = visibleX * 100 + "%";
  bounds.style.height = visibleY * 100 + "%";
  map.hidden = zoom === 1;
  stage.classList.toggle("zoomed", zoom > 1);
  fit.textContent = Math.round(zoom * 100) + "%";
  smaller.disabled = zoom === 1;
  larger.disabled = zoom === maxZoom;
}

function setZoom(value, x = stage.clientWidth / 2, y = stage.clientHeight / 2) {
  const next = clamp(value, 1, maxZoom);
  const rect = frame.getBoundingClientRect();
  // Keep the image point beneath the pointer fixed as the scale changes.
  centerX += (x - stage.clientWidth / 2) / rect.width * (1 - zoom / next);
  centerY += (y - stage.clientHeight / 2) / rect.height * (1 - zoom / next);
  zoom = next;
  draw();
}

async function show(position) {
  index = (position + photos.length) % photos.length;
  const link = photos[index];
  const tile = link.firstElementChild;
  const preview = new Image();
  preview.src = tile.currentSrc || tile.src;
  preview.alt = tile.alt;
  preview.draggable = false;
  frame.replaceChildren(preview);
  map.querySelector("img").src = preview.src;
  map.style.setProperty("--ratio", tile.getAttribute("width") / tile.getAttribute("height"));
  zoom = 1;
  centerX = centerY = 0.5;
  drag = null;
  counter.textContent = `${index + 1} / ${photos.length}`;
  notice.textContent = "";
  if (!dialog.open) dialog.showModal();
  draw();

  const full = new Image();
  pending = full;
  full.alt = tile.alt;
  full.draggable = false;
  full.src = link.href;
  try {
    await full.decode();
    if (pending === full && dialog.open) {
      frame.replaceChildren(full);
      map.querySelector("img").src = full.src;
    }
  } catch {
    if (pending === full && dialog.open) notice.textContent = "Couldn’t load the full-size photograph.";
  }
}

gallery.addEventListener("click", event => {
  const link = event.target.closest("a");
  if (!link || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  show(photos.indexOf(link));
});

document.querySelector("#previous").onclick = () => show(index - 1);
document.querySelector("#next").onclick = () => show(index + 1);
document.querySelector("#close").onclick = () => dialog.close();
fit.onclick = () => setZoom(1);
smaller.onclick = () => setZoom(zoom / 1.5);
larger.onclick = () => setZoom(zoom * 1.5);

dialog.addEventListener("close", () => {
  if (dialog.open) return;
  pending = drag = null;
  frame.replaceChildren();
  map.querySelector("img").removeAttribute("src");
});

stage.addEventListener("wheel", event => {
  event.preventDefault();
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
  const rect = stage.getBoundingClientRect();
  setZoom(zoom * Math.exp(-event.deltaY * unit * .002), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

function moveOnMap(event) {
  const rect = map.getBoundingClientRect();
  centerX = (event.clientX - rect.left) / rect.width + drag.offsetX;
  centerY = (event.clientY - rect.top) / rect.height + drag.offsetY;
  draw();
}

stage.addEventListener("pointerdown", event => {
  if (!event.isPrimary || event.button !== 0) return;
  const onMap = map.contains(event.target);
  if (!onMap && event.target === stage && zoom === 1) {
    dialog.close();
    return;
  }
  if (zoom === 1) return;
  drag = { id: event.pointerId, onMap, x: event.clientX, y: event.clientY, offsetX: 0, offsetY: 0 };
  stage.setPointerCapture(event.pointerId);
  if (onMap) {
    const rect = bounds.getBoundingClientRect();
    if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
      const overview = map.getBoundingClientRect();
      drag.offsetX = centerX - (event.clientX - overview.left) / overview.width;
      drag.offsetY = centerY - (event.clientY - overview.top) / overview.height;
    }
    moveOnMap(event);
  }
});

stage.addEventListener("pointermove", event => {
  if (drag?.id !== event.pointerId) return;
  if (drag.onMap) return moveOnMap(event);
  const rect = frame.getBoundingClientRect();
  centerX -= (event.clientX - drag.x) / rect.width;
  centerY -= (event.clientY - drag.y) / rect.height;
  drag.x = event.clientX;
  drag.y = event.clientY;
  draw();
});
stage.addEventListener("lostpointercapture", () => { drag = null; });

dialog.addEventListener("keydown", event => {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.shiftKey && zoom > 1 && event.key.startsWith("Arrow")) {
    const rect = frame.getBoundingClientRect();
    if (event.key === "ArrowLeft") centerX -= stage.clientWidth / rect.width / 5;
    if (event.key === "ArrowRight") centerX += stage.clientWidth / rect.width / 5;
    if (event.key === "ArrowUp") centerY -= stage.clientHeight / rect.height / 5;
    if (event.key === "ArrowDown") centerY += stage.clientHeight / rect.height / 5;
    draw();
    event.preventDefault();
    return;
  }
  switch (event.key) {
    case "ArrowLeft": show(index - 1); break;
    case "ArrowRight": show(index + 1); break;
    case "+": case "=": setZoom(zoom * 1.5); break;
    case "-": setZoom(zoom / 1.5); break;
    case "0": setZoom(1); break;
    default: return;
  }
  event.preventDefault();
});
new ResizeObserver(draw).observe(stage);

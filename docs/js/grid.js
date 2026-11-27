// One order for the layout, keyboard focus, progressive LoD loading, and lightbox.
const photoGrid = (() => {
  const gallery = document.querySelector(".gallery");
  const tiles = Array.from(gallery.children);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  gallery.replaceChildren(...tiles);

  const visible = new Set();
  const upgradeQueue = new Set();
  const MAX_UPGRADES = 6;
  let inflightThumbs = 0, inflightUpgrades = 0, selected;

  function pumpUpgrades() {
    if (inflightThumbs > 0) return;
    while (inflightUpgrades < MAX_UPGRADES && upgradeQueue.size) {
      let next = null;
      for (const img of upgradeQueue) {
        if (visible.has(img)) { next = img; break; }
      }
      if (!next) { upgradeQueue.clear(); break; }
      upgradeQueue.delete(next);
      const hi = next.dataset.src;
      if (!hi || next.dataset.lod === "2") continue;
      next.dataset.lod = "2";
      inflightUpgrades++;
      const loader = new Image();
      loader.decoding = "async";
      loader.src = hi;
      const done = () => { inflightUpgrades--; pumpUpgrades(); };
      loader.decode().then(() => { next.src = hi; done(); }, () => {
        if (loader.complete && loader.naturalWidth) next.src = hi;
        else next.dataset.lod = "1";
        done();
      });
    }
  }

  function loadThumb(img, priority = "auto") {
    if (!img || img.dataset.lod) return;
    const thumb = img.dataset.thumb || img.dataset.src;
    if (!thumb) return;
    img.dataset.lod = "1";
    if (priority !== "auto") img.fetchPriority = priority;
    inflightThumbs++;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      inflightThumbs = Math.max(0, inflightThumbs - 1);
      if (visible.has(img) && img.dataset.src) upgradeQueue.add(img);
      pumpUpgrades();
    };
    img.addEventListener("load", finish, { once: true });
    img.addEventListener("error", finish, { once: true });
    img.src = thumb;
    if (img.complete) finish();
  }

  function ensureTile(tile) {
    const img = tile?.firstElementChild;
    if (!img) return;
    visible.add(img);
    if (!img.dataset.lod) loadThumb(img, "high");
    else if (img.dataset.lod === "1" && img.dataset.src) { upgradeQueue.add(img); pumpUpgrades(); }
  }

  if ("IntersectionObserver" in window) {
    const thumbObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        loadThumb(entry.target.firstElementChild, "high");
        thumbObserver.unobserve(entry.target);
      }
    }, { rootMargin: "400px 0px" });

    const upgradeObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const img = entry.target.firstElementChild;
        if (entry.isIntersecting) {
          visible.add(img);
          if (!img.dataset.lod) loadThumb(img, "high");
          else if (img.dataset.lod === "1" && img.dataset.src) upgradeQueue.add(img);
        } else {
          visible.delete(img);
          upgradeQueue.delete(img);
        }
      }
      pumpUpgrades();
    }, { rootMargin: "150px 0px" });

    for (const tile of tiles) {
      thumbObserver.observe(tile);
      upgradeObserver.observe(tile);
    }
  } else {
    for (const tile of tiles) ensureTile(tile);
  }

  function select(index) {
    selected?.classList.remove("in-viewer");
    selected = tiles[index];
    selected.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    selected.classList.add("in-viewer");
    ensureTile(selected);
  }

  function restore() {
    selected.classList.remove("in-viewer");
    selected.focus({ preventScroll: true });
  }

  function onOpen(open) {
    gallery.addEventListener("click", event => {
      const link = event.target.closest("a");
      if (!link || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      open(tiles.indexOf(link));
    });
  }
  return { tiles, select, restore, onOpen };
})();

// One order for the layout, keyboard focus, and lightbox.
const photoGrid = (() => {
  const gallery = document.querySelector(".gallery");
  const tiles = Array.from(gallery.children);
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [tiles[i], tiles[j]] = [tiles[j], tiles[i]];
  }
  gallery.replaceChildren(...tiles);
  let selected;

  function select(index) {
    selected?.classList.remove("in-viewer");
    selected = tiles[index];
    selected.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    selected.classList.add("in-viewer");
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

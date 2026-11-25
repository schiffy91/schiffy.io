// Optional live state-graph debugger for lightbox.js.
// Self-contained: injects its own stylesheet, pins to the top, pushes layout down,
// and cleans up completely on unmount(). Load via `?debug` or `lightbox.debug()`.

const lightboxDebug = (() => {
  const STORAGE_KEY = "schiffy-lightbox-graph-v1";
  const SVG_NS = "http://www.w3.org/2000/svg";
  const W = 1060, H = 204;

  const nodePos = {
    closed:  [52,  46],
    closing: [52,  174],
    viewing: [448, 92],
    pulling: [448, 174],
    paging:  [996, 44],
    zoomed:  [996, 174],
  };
  const edgeGeom = {
    open:    { d: "M 93 46 Q 250 42 407 82",    bar: [250, 44]  },
    finish:  { d: "M 52 160 L 52 60",           bar: [52,  120] },
    pull:    { d: "M 424 106 Q 402 133 424 160", bar: [244, 102] },
    bounce:  { d: "M 468 160 Q 486 133 468 106", bar: [522, 152] },
    dismiss: { d: "M 407 174 L 93 174",         bar: [250, 168] },
    swipe:   { d: "M 489 80 Q 722 22 955 38",   bar: [722, 34]  },
    settle:  { d: "M 955 52 Q 722 118 489 92",  bar: [722, 91]  },
    zoom:    { d: "M 489 98 Q 722 142 955 166", bar: [722, 130] },
    fit:     { d: "M 955 182 Q 722 204 489 104", bar: [722, 166] },
  };

  const STYLE = `
html { scroll-padding-top: var(--lb-debug-h, 0px); }
body { padding-top: var(--lb-debug-h, 0px); }
.stage { top: var(--lb-debug-h, 0px); }
.lb-debug {
  position: fixed; top: 0; left: 0; right: 0; z-index: 20;
  background: #14171c; color: #e6ebf2; border-bottom: 1px solid #2b323d;
  font: 11px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; user-select: none;
}
.lb-debug-head {
  display: flex; align-items: center; gap: 10px; padding: 5px 12px;
  border-bottom: 1px solid #232933;
}
.lb-debug.collapsed .lb-debug-head { border-bottom: 0; }
.lb-debug.collapsed .lb-debug-scroll { display: none; }
.lb-debug-title { font-weight: 600; color: #c7d2e0; letter-spacing: .02em; }
.lb-debug-state {
  padding: 2px 7px; border-radius: 999px; background: #1f334d;
  border: 1px solid #4c86cc; color: #9ecbff; font-weight: 600;
}
.lb-debug-last { color: #8c98a8; }
.lb-debug-live { margin-left: auto; color: #8c98a8; white-space: nowrap; }
.lb-debug button, .lb-debug select {
  font: inherit; color: #e6ebf2; background: #232a34;
  border: 1px solid #3a4352; border-radius: 4px; padding: 1px 6px; cursor: pointer;
}
.lb-debug button:hover { background: #2f3846; }
.lb-debug-scroll { overflow-x: auto; overflow-y: hidden; }
.sm-board { position: relative; margin: 0 auto; }
.sm-svg { position: absolute; inset: 0; pointer-events: none; overflow: visible; }
.sm-edge { fill: none; stroke: #4b5565; stroke-width: 1.5; transition: stroke .12s; }
.sm-edge.active { stroke: #7ab7ff; stroke-width: 2.2; }
.sm-node {
  position: absolute; transform: translate(-50%, -50%); width: 82px; height: 28px;
  display: grid; place-items: center; border-radius: 14px;
  background: #1d222b; border: 1.5px solid #3c4657; color: #b7c2d0; font-weight: 600;
  transition: border-color .12s, background .12s, color .12s;
}
.sm-node.active { background: #1b314d; border-color: #7ab7ff; color: #fff; box-shadow: 0 0 0 2px #7ab7ff33; }
.sm-edge-bar {
  position: absolute; transform: translate(-50%, -100%);
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 6px;
  border-radius: 5px; background: rgb(20 23 28 / .92); border: 1px solid #2b323d; white-space: nowrap;
}
.sm-edge-bar.two-row { flex-wrap: wrap; justify-content: center; max-width: 300px; row-gap: 2px; padding: 2px 7px; }
.sm-edge-bar.active { border-color: #5a96e0; background: #192638; }
.sm-edge-name { color: #8fa3bc; font-weight: 600; }
.sm-edge-bar.active .sm-edge-name { color: #9ecbff; }
.sm-var { display: inline-flex; align-items: center; gap: 3px; color: #9aa7b8; }
.sm-var-key { color: #7e8b9c; }
.sm-var input[type="range"] { width: 38px; accent-color: #7ab7ff; margin: 0; }
.sm-var-val { min-width: 3em; text-align: right; color: #cde2ff; }
.sm-var select { padding: 1px 4px; line-height: 1.2; }`;

  let activeCleanup = null;

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const svgEl = (tag, attrs = {}) => {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    return node;
  };

  function unmount() {
    activeCleanup?.();
    activeCleanup = null;
  }

  function mount(lb = typeof lightbox !== "undefined" ? lightbox : null) {
    if (!lb?.graph) return null;
    unmount();

    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (saved && typeof saved === "object") lb.setConfig(saved);
    } catch {}
    const persist = () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(lb.config)); } catch {}
    };

    const style = el("style", "", STYLE);
    style.setAttribute("data-lightbox-debug", "");
    document.head.append(style);

    const panel = el("aside", "lb-debug");
    panel.setAttribute("aria-label", "Lightbox state graph");

    const head = el("div", "lb-debug-head");
    const badge = el("span", "lb-debug-state", lb.state);
    const edgeBadge = el("span", "lb-debug-last", "");
    const live = el("span", "lb-debug-live", "");
    const resetBtn = el("button", "", "Reset");
    resetBtn.type = "button";
    const toggleBtn = el("button", "", "Hide");
    toggleBtn.type = "button";
    const closeBtn = el("button", "", "×");
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close debug graph");
    head.append(el("strong", "lb-debug-title", "State Graph"), badge, edgeBadge, live, resetBtn, toggleBtn, closeBtn);
    panel.append(head);

    const scrollWrap = el("div", "lb-debug-scroll");
    const board = el("div", "sm-board");
    board.style.width = W + "px";
    board.style.height = H + "px";

    const svg = svgEl("svg", { class: "sm-svg", width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const defs = svgEl("defs");
    for (const [id, fill] of [["sm-arrow", "#5d6878"], ["sm-arrow-on", "#7ab7ff"]]) {
      const marker = svgEl("marker", {
        id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: "auto",
      });
      marker.append(svgEl("path", { d: "M 0 1 L 7 4 L 0 7 z", fill }));
      defs.append(marker);
    }
    svg.append(defs);
    board.append(svg);

    const nodeEls = new Map();
    for (const node of lb.graph.nodes) {
      const [x, y] = nodePos[node.id] || [0, 0];
      const box = el("div", "sm-node", node.label);
      box.dataset.node = node.id;
      box.style.left = x + "px";
      box.style.top = y + "px";
      board.append(box);
      nodeEls.set(node.id, box);
    }

    const edgePaths = new Map(), edgeBars = new Map(), varInputs = new Map();
    for (const edge of lb.graph.edges) {
      const geom = edgeGeom[edge.id];
      if (!geom) continue;
      const path = svgEl("path", { class: "sm-edge", d: geom.d, "marker-end": "url(#sm-arrow)" });
      path.dataset.edge = edge.id;
      svg.append(path);
      edgePaths.set(edge.id, path);

      const vars = Object.entries(edge.vars);
      const cls = vars.length > 2 ? "sm-edge-bar has-vars two-row" : vars.length ? "sm-edge-bar has-vars" : "sm-edge-bar";
      const bar = el("div", cls);
      bar.dataset.edge = edge.id;
      bar.style.left = geom.bar[0] + "px";
      bar.style.top = geom.bar[1] + "px";
      bar.append(el("span", "sm-edge-name", edge.label));

      for (const [key, spec] of vars) {
        const ctrl = el("label", "sm-var");
        ctrl.append(el("span", "sm-var-key", spec.label));
        if (spec.type === "range") {
          const input = el("input");
          input.type = "range";
          input.min = String(spec.min);
          input.max = String(spec.max);
          input.step = String(spec.step);
          input.value = String(spec.value);
          input.setAttribute("aria-label", `${edge.label} ${spec.label}`);
          const val = el("span", "sm-var-val", spec.fmt(spec.value));
          input.addEventListener("input", () => {
            lb.setVar(key, Number(input.value));
            val.textContent = spec.fmt(lb.config[key]);
            persist();
          });
          ctrl.append(input, val);
          varInputs.set(key, { input, val, spec });
        } else if (spec.type === "select") {
          const select = el("select");
          select.setAttribute("aria-label", `${edge.label} ${spec.label}`);
          for (const [optVal, optLabel] of spec.options) {
            const opt = el("option", "", optLabel);
            opt.value = optVal;
            select.append(opt);
          }
          select.value = String(spec.value);
          select.addEventListener("change", () => {
            lb.setVar(key, select.value);
            persist();
          });
          ctrl.append(select);
          varInputs.set(key, { input: select, spec });
        }
        bar.append(ctrl);
      }

      board.append(bar);
      edgeBars.set(edge.id, bar);
    }

    scrollWrap.append(board);
    panel.append(scrollWrap);
    const openDialog = document.querySelector("dialog[open]");
    (openDialog || document.body).prepend(panel);

    function syncHeight() {
      const h = Math.ceil(panel.getBoundingClientRect().height);
      if (!h) return;
      document.documentElement.style.setProperty("--lb-debug-h", h + "px");
      lb.refreshLayout?.();
    }

    function renderState(activeState, activeEdge) {
      badge.textContent = activeState;
      edgeBadge.textContent = activeEdge ? `via ${activeEdge}` : "";
      for (const [id, box] of nodeEls) box.classList.toggle("active", id === activeState);
      for (const [id, path] of edgePaths) {
        const on = id === activeEdge;
        path.classList.toggle("active", on);
        path.setAttribute("marker-end", on ? "url(#sm-arrow-on)" : "url(#sm-arrow)");
      }
      for (const [id, bar] of edgeBars) bar.classList.toggle("active", id === activeEdge);
    }

    resetBtn.addEventListener("click", () => {
      lb.resetVars();
      for (const [key, ref] of varInputs) {
        const value = lb.config[key];
        ref.input.value = String(value);
        if (ref.val) ref.val.textContent = ref.spec.fmt(value);
      }
      persist();
    });
    toggleBtn.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("collapsed");
      toggleBtn.textContent = collapsed ? "Graph" : "Hide";
      syncHeight();
    });
    closeBtn.addEventListener("click", event => { event.stopPropagation(); unmount(); });

    renderState(lb.state, lb.lastEdge);
    syncHeight();
    const ro = new ResizeObserver(syncHeight);
    ro.observe(panel);
    const offState = lb.onState(renderState);
    const offToggle = lb.onToggle((open, dialog) => {
      const target = open ? dialog : document.body;
      if (panel.parentElement !== target) target.prepend(panel);
      syncHeight();
    });
    const timer = setInterval(() => {
      const { drawUs, scale, page } = lb.telemetry;
      live.textContent = `scale ${scale.toFixed(2)} | page ${Math.round(page)}px | draw ${drawUs.toFixed(0)}us`;
    }, 100);

    activeCleanup = () => {
      clearInterval(timer);
      ro.disconnect?.();
      offState?.();
      offToggle?.();
      panel.remove();
      style.remove();
      document.documentElement.style.removeProperty?.("--lb-debug-h");
      lb.refreshLayout?.();
    };
    return { panel, unmount };
  }

  if (typeof lightbox !== "undefined") mount(lightbox);
  return { mount, unmount };
})();

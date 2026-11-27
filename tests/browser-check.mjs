import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const DOCS_DIR = path.resolve(import.meta.dirname, "../docs");
const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "google-chrome",
  "chromium",
].filter(Boolean);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function findChrome() {
  for (const bin of CHROME_CANDIDATES) {
    if (bin.startsWith("/") && fs.existsSync(bin)) return bin;
  }
  throw new Error("Could not locate Chrome/Chromium binary. Set CHROME_BIN to override.");
}

function startStaticServer(root) {
  const requests = [];
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const urlPath = (req.url || "/").split("?")[0];
      requests.push(urlPath);
      const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
      const file = path.resolve(root, rel);
      if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port, requests }));
  });
}

async function launchChrome(chromeBin) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "schiffy-chrome-"));
  const proc = spawn(chromeBin, [
    "--headless=new",
    "--disable-gpu-sandbox",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,800",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ], { stdio: ["ignore", "pipe", "pipe"] });

  const wsUrl = await new Promise((resolve, reject) => {
    let stderr = "";
    const timer = setTimeout(() => reject(new Error(`Timed out starting Chrome:\n${stderr}`)), 15000);
    proc.stderr.on("data", chunk => {
      stderr += chunk.toString();
      const m = /DevTools listening on (ws:\/\/[^\s]+)/.exec(stderr);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    proc.once("exit", code => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}):\n${stderr}`)); });
  });

  const base = wsUrl.replace(/^ws:/, "http:").replace(/\/devtools\/browser\/.*$/, "");
  const targets = await (await fetch(`${base}/json/list`)).json();
  const pageTarget = targets.find(t => t.type === "page") || targets[0];
  const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let nextId = 1;
  const inflight = new Map();
  const errors = [];
  ws.onmessage = msg => {
    const data = JSON.parse(msg.data);
    if (data.id && inflight.has(data.id)) {
      const { resolve, reject } = inflight.get(data.id);
      inflight.delete(data.id);
      if (data.error) reject(new Error(`${data.error.code}: ${data.error.message}`));
      else resolve(data.result);
    } else if (data.method === "Runtime.exceptionThrown") {
      errors.push(data.params.exceptionDetails.text || "Runtime exception");
    } else if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
      errors.push(data.params.args.map(a => a.value ?? a.description).join(" "));
    }
  };

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    inflight.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

  const evalJs = async expr => {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };

  const close = () => {
    try { ws.close(); } catch {}
    try { proc.kill("SIGKILL"); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch {}
  };

  return { send, evalJs, errors, close };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function assertNoOscillation(samples, label) {
  // Normal single gesture cycle is viewing -> paging -> viewing (or viewing -> pulling -> viewing).
  // Oscillation is re-entering an active gesture state (paging/pulling) a second time without new input.
  let activeVisits = 0, cur = null, seq = [];
  for (const s of samples) {
    if (s.state !== cur) {
      if (s.state === "paging" || s.state === "pulling") {
        activeVisits++;
        if (activeVisits > 1) {
          assert.fail(`${label}: state oscillation ${[...seq, s.state].join(" -> ")} at t=${Math.round(s.t)}`);
        }
      }
      cur = s.state;
      seq.push(s.state);
    }
  }
}

function assertBoundedMotion(samples, label, maxStepPx = 220) {
  let prev = null;
  for (const s of samples) {
    if (prev && prev.alt === s.alt && prev.open && s.open) {
      const dx = Math.abs(s.left - prev.left);
      assert.ok(dx <= maxStepPx, `${label}: frame jump |dx|=${dx.toFixed(1)}px (${prev.left.toFixed(1)} -> ${s.left.toFixed(1)})`);
    }
    prev = s;
  }
}

function assertMonotonicReturn(samples, peakIndex, targetLeft, label) {
  const after = samples.slice(peakIndex);
  let prevDist = Math.abs(after[0].left - targetLeft);
  for (let i = 1; i < after.length; i++) {
    const dist = Math.abs(after[i].left - targetLeft);
    assert.ok(
      dist <= prevDist + 1.5,
      `${label}: non-monotonic bounce return at sample ${i} (dist ${prevDist.toFixed(1)} -> ${dist.toFixed(1)}, left=${after[i].left.toFixed(1)}, target=${targetLeft.toFixed(1)})`
    );
    prevDist = dist;
  }
}

async function run() {
  const chromeBin = findChrome();
  const { server, port, requests } = await startStaticServer(DOCS_DIR);
  const chrome = await launchChrome(chromeBin);

  try {
    await chrome.send("Page.enable");
    await chrome.send("Runtime.enable");
    await chrome.send("Emulation.setDeviceMetricsOverride", {
      width: 1280, height: 800, deviceScaleFactor: 2, mobile: false,
    });

    await chrome.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
    await sleep(800);

    // 0) Progressive 3-tier LoD: thumbnails load first, visible tiles upgrade to low-res, zero offscreen preload waste
    const thumbReqs = requests.filter(u => u.includes("/thumbnail/"));
    const lowReqs = requests.filter(u => u.includes("/low-res/"));
    const medReqs = requests.filter(u => u.includes("/medium-res/"));
    const firstThumbIdx = requests.findIndex(u => u.includes("/thumbnail/"));
    const firstLowIdx = requests.findIndex(u => u.includes("/low-res/"));
    assert.ok(thumbReqs.length > 0, "LoD: thumbnails loaded on initial viewport");
    assert.ok(lowReqs.length > 0, "LoD: visible tiles upgraded to low-res");
    assert.equal(medReqs.length, 0, "LoD: zero medium-res downloaded on initial grid load");
    assert.ok(firstThumbIdx >= 0 && firstThumbIdx < firstLowIdx, `LoD: thumbnails start before low-res (${firstThumbIdx} < ${firstLowIdx})`);
    assert.ok(lowReqs.length < 40, `LoD: shuffle-before-load avoids downloading offscreen low-res (${lowReqs.length}/88)`);
    const gridAudit = await chrome.evalJs(`(() => {
      const imgs = [...document.querySelectorAll(".gallery img")];
      const visible = imgs.filter(img => {
        const r = img.getBoundingClientRect();
        return r.bottom > 0 && r.top < window.innerHeight;
      });
      return {
        visibleCount: visible.length,
        broken: visible.filter(img => !img.complete || img.naturalWidth === 0).length,
        upgraded: visible.filter(img => img.src.includes("/low-res/")).length,
      };
    })()`);
    assert.ok(gridAudit.visibleCount > 0, "LoD: visible tiles rendered");
    assert.equal(gridAudit.broken, 0, "LoD: zero broken visible tiles");
    assert.equal(gridAudit.upgraded, gridAudit.visibleCount, `LoD: all visible tiles upgraded to low-res (${gridAudit.upgraded}/${gridAudit.visibleCount})`);
    console.log(`PASS progressive-lod: ${thumbReqs.length} thumbs -> ${lowReqs.length} low-res (0 medium-res), ${gridAudit.upgraded}/${gridAudit.visibleCount} visible upgraded, 0 broken`);

    // Install real rAF frame recorder
    await chrome.evalJs(`(() => {
      window.__rec = { active: false, frames: [] };
      const tick = () => {
        if (window.__rec.active) {
          const d = document.querySelector("dialog");
          const cur = document.querySelector(".frame.current");
          const tr = document.querySelector(".track");
          const r = cur ? cur.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
          window.__rec.frames.push({
            t: performance.now(),
            state: lightbox.state,
            edge: lightbox.lastEdge,
            open: d.open,
            scrollY: window.scrollY,
            alt: cur?.firstElementChild?.alt || "",
            childCount: cur?.children.length || 0,
            left: r.left, top: r.top, width: r.width, height: r.height,
            scale: lightbox.telemetry.scale,
            page: lightbox.telemetry.page,
            trackLeft: tr ? tr.scrollLeft : 0,
            trackTop: tr ? tr.scrollTop : 0,
          });
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })()`);

    const startRec = () => chrome.evalJs(`window.__rec.frames = []; window.__rec.active = true;`);
    const stopRec = () => chrome.evalJs(`window.__rec.active = false; window.__rec.frames;`);

    const openAt500 = async () => {
      await chrome.evalJs(`window.scrollTo(0, 500)`);
      await sleep(80);
      const opened = await chrome.evalJs(`(() => {
        const links = [...document.querySelectorAll(".gallery a")];
        const visible = links.find(a => { const r = a.getBoundingClientRect(); return r.top >= 40 && r.bottom <= 760; });
        visible.click();
        return { alt: visible.querySelector("img").alt, scrollY: window.scrollY };
      })()`);
      await sleep(120);
      const info = await chrome.evalJs(`(() => {
        const cur = document.querySelector(".frame.current");
        const r = cur.getBoundingClientRect();
        return {
          alt: cur.firstElementChild.alt,
          left: r.left, width: r.width, height: r.height,
          trackClass: document.querySelector(".track").className,
          scrollY: window.scrollY,
        };
      })()`);
      assert.equal(info.trackClass, "track", "Default .track class must be 'track' (snap x, never free/snap-both)");
      assert.equal(info.scrollY, 500);
      return info;
    };

    // 1) Half-swipe left & right continuous trackpad/compositor bounce at scrollY = 500
    const start = await openAt500();
    for (const [label, xDistance] of [["half-swipe-left", -180], ["half-swipe-right", 180]]) {
      await startRec();
      await chrome.send("Input.synthesizeScrollGesture", {
        x: 640, y: 400, xDistance, yDistance: 0, speed: 900, gestureSourceType: "mouse", preventFling: true,
      });
      await sleep(550);
      const frames = await stopRec();
      assert.ok(frames.length >= 15, `${label}: expected >= 15 rAF samples, got ${frames.length}`);
      for (const f of frames) {
        assert.equal(f.scrollY, 500, `${label}: scrollY drifted to ${f.scrollY}`);
        assert.ok(f.childCount >= 1, `${label}: blank frame`);
      }
      assertNoOscillation(frames, label);
      assertBoundedMotion(frames, label);

      // Find peak displacement during half-swipe and verify monotonic bounce back to start.left
      let peakIdx = 0, peakDisp = 0;
      for (let i = 0; i < frames.length; i++) {
        const disp = Math.abs(frames[i].left - start.left);
        if (disp > peakDisp) { peakDisp = disp; peakIdx = i; }
      }
      assert.ok(peakDisp > 80, `${label}: photo actually moved mid-swipe (peak=${peakDisp.toFixed(1)}px)`);
      assertMonotonicReturn(frames, peakIdx, start.left, label);
      const last = frames[frames.length - 1];
      assert.equal(last.alt, start.alt, `${label}: stayed on starting photo`);
      assert.equal(last.state, "viewing", `${label}: settled cleanly to viewing`);
      assert.ok(Math.abs(last.left - start.left) < 1.5, `${label}: returned to origin (${last.left} vs ${start.left})`);
      console.log(`PASS ${label}: ${frames.length} rAF frames, peak=${peakDisp.toFixed(1)}px, 0 oscillation, scrollY=500`);
    }

    // 2) Full horizontal turn via continuous trackpad/compositor gesture
    await startRec();
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: -420, yDistance: 0, speed: 1200, gestureSourceType: "mouse", preventFling: true,
    });
    await sleep(550);
    const turnFrames = await stopRec();
    assertNoOscillation(turnFrames, "full-turn");
    for (const f of turnFrames) assert.equal(f.scrollY, 500);
    const afterTurn = turnFrames[turnFrames.length - 1];
    assert.notEqual(afterTurn.alt, start.alt, "full-turn: advanced to next photo");
    assert.equal(afterTurn.state, "viewing");
    console.log(`PASS full-turn: ${turnFrames.length} rAF frames, ${start.alt} -> ${afterTurn.alt}, scrollY=500`);

    // 3) Gentle swipe-down bounce at scrollY = 500
    await startRec();
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: 0, yDistance: 70, speed: 600, gestureSourceType: "mouse", preventFling: true,
    });
    await sleep(550);
    const pullFrames = await stopRec();
    assertNoOscillation(pullFrames, "gentle-pull");
    for (const f of pullFrames) assert.equal(f.scrollY, 500);
    const minScale = Math.min(...pullFrames.map(f => f.scale));
    assert.ok(minScale < 0.96, `gentle-pull: shrank visibly (minScale=${minScale.toFixed(3)})`);
    assert.equal(pullFrames[pullFrames.length - 1].state, "viewing");
    assert.equal(pullFrames[pullFrames.length - 1].scale, 1);
    console.log(`PASS gentle-pull: ${pullFrames.length} rAF frames, minScale=${minScale.toFixed(3)} -> 1.000, scrollY=500`);

    // 4) Hold at min grid size while pointer/fingers drag down past max pull + verify boundary wheel never drifts scrollY
    const holdTile = await chrome.evalJs(`(() => {
      const t = document.querySelector(".gallery .in-viewer").getBoundingClientRect();
      return { width: t.width, height: t.height };
    })()`);
    // Boundary wheel upward at rest (scrollTop === maxSt) must not drift scrollY
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 120 });
    await sleep(60);
    assert.equal(await chrome.evalJs(`window.scrollY`), 500, "boundary-wheel-up: scrollY stayed 500");
    await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 640, y: 80, button: "left", clickCount: 1 });
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 780, button: "left", buttons: 1 });
    await sleep(250);
    const heldAtMin = await chrome.evalJs(`(() => {
      const r = document.querySelector(".frame.current").getBoundingClientRect();
      return { open: document.querySelector("dialog").open, state: lightbox.state, width: r.width, height: r.height };
    })()`);
    assert.equal(heldAtMin.open, true, "hold-at-min: stays open while held past min size");
    assert.equal(heldAtMin.state, "pulling", "hold-at-min: stays in pulling while held");
    assert.ok(
      Math.abs(heldAtMin.width - holdTile.width) < 1.5 && Math.abs(heldAtMin.height - holdTile.height) < 1.5,
      `hold-at-min: held size ${heldAtMin.width.toFixed(1)}x${heldAtMin.height.toFixed(1)} matches grid tile ${holdTile.width.toFixed(1)}x${holdTile.height.toFixed(1)}`
    );
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 640, y: 80, button: "left", buttons: 1 });
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 80, button: "left", clickCount: 1 });
    await sleep(300);
    console.log(`PASS hold-at-min: held at grid size ${heldAtMin.width.toFixed(1)}x${heldAtMin.height.toFixed(1)} without auto-closing`);

    // 5) Forceful swipe-down dismiss + trailing inertia wheel ticks at scrollY = 500
    await startRec();
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: 0, yDistance: 500, speed: 1800, gestureSourceType: "mouse",
    });
    for (let i = 0; i < 3; i++) {
      await sleep(20);
      await chrome.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: -60 });
    }
    await sleep(600);
    const dismissFrames = await stopRec();
    for (const f of dismissFrames) {
      if (f.scrollY !== 500) {
        console.error("scrollY drift frames:", dismissFrames.slice(Math.max(0, dismissFrames.indexOf(f) - 4), dismissFrames.indexOf(f) + 4));
        assert.equal(f.scrollY, 500, `forceful-dismiss: scrollY drifted to ${f.scrollY} (open=${f.open}, state=${f.state})`);
      }
    }
    const closed = dismissFrames[dismissFrames.length - 1];
    assert.equal(closed.open, false, "forceful-dismiss: dialog closed");
    assert.equal(closed.state, "closed");

    // Gallery scrolls down normally after 200ms pause
    await sleep(200);
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 120 });
    await sleep(120);
    const scrollAfter = await chrome.evalJs(`window.scrollY`);
    assert.ok(scrollAfter > 500, `Post-close gallery scroll works (scrollY=${scrollAfter})`);
    console.log(`PASS forceful-dismiss: ${dismissFrames.length} rAF frames, scrollY stayed 500 -> ${scrollAfter} after pause`);

    // 5) Drag-down mid-horizontal-swipe (pointer) -> monotonic shrink with zero 1.0 strobe
    await openAt500();
    await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 760, y: 400, button: "left", clickCount: 1 });
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 520, y: 400, button: "left", buttons: 1 });
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 520, y: 400, button: "left", clickCount: 1 });
    await sleep(24); // mid-settle
    await startRec();
    await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 600, y: 350, button: "left", clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await chrome.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 600, y: 350 + i * 16, button: "left", buttons: 1 });
      await sleep(16);
    }
    await sleep(140);
    await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 600, y: 446, button: "left", clickCount: 1 });
    await sleep(400);
    const crossFrames = await stopRec();
    const minCrossScale = Math.min(...crossFrames.map(f => f.scale));
    assert.ok(minCrossScale < 0.92, `cross-axis: shrank smoothly (minScale=${minCrossScale.toFixed(3)})`);
    assert.equal(crossFrames[crossFrames.length - 1].state, "viewing");
    assert.equal(crossFrames[crossFrames.length - 1].scale, 1);
    console.log(`PASS drag-down-mid-swipe: ${crossFrames.length} rAF frames, minScale=${minCrossScale.toFixed(3)} -> 1.000`);

    // 6) Pinch-out min size matches the photo's live grid tile size (within 1.5px)
    const tileSize = await chrome.evalJs(`(() => {
      const t = document.querySelector(".gallery .in-viewer").getBoundingClientRect();
      return { width: t.width, height: t.height };
    })()`);
    for (let i = 0; i < 25; i++) {
      await chrome.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: 120, modifiers: 2, // Ctrl=2
      });
    }
    const pinched = await chrome.evalJs(`(() => {
      const r = document.querySelector(".frame.current").getBoundingClientRect();
      return { width: r.width, height: r.height };
    })()`);
    assert.ok(
      Math.abs(pinched.width - tileSize.width) < 1.5 && Math.abs(pinched.height - tileSize.height) < 1.5,
      `pinch-min-size: expected ${tileSize.width.toFixed(1)}x${tileSize.height.toFixed(1)}, got ${pinched.width.toFixed(1)}x${pinched.height.toFixed(1)}`
    );
    console.log(`PASS pinch-min-size: ${pinched.width.toFixed(1)}x${pinched.height.toFixed(1)} matches grid tile ${tileSize.width.toFixed(1)}x${tileSize.height.toFixed(1)}`);

    // 7) Zoomed in via trackpad pinch (ctrl+wheel) AND '+' key: swiping hard past edges pans only and never paginates
    await chrome.send("Input.dispatchKeyEvent", { type: "keyDown", key: "0", text: "0" });
    await sleep(300);
    const zoomedAlt = await chrome.evalJs(`document.querySelector(".frame.current img").alt`);
    for (let i = 0; i < 8; i++) {
      await chrome.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 640, y: 400, deltaX: 0, deltaY: -18, modifiers: 2, // Ctrl=2 (trackpad pinch-in)
      });
      await sleep(12);
    }
    await sleep(40); // swipe immediately right after pinch
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: -900, yDistance: 0, speed: 1800, gestureSourceType: "mouse",
    });
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: 0, yDistance: 700, speed: 1800, gestureSourceType: "mouse",
    });
    await sleep(300);
    const afterZoomPan = await chrome.evalJs(`({
      open: document.querySelector("dialog").open,
      state: lightbox.state,
      alt: document.querySelector(".frame.current img")?.alt,
      page: lightbox.telemetry.page,
    })`);
    assert.equal(afterZoomPan.open, true, "zoomed-pan: stayed open");
    assert.equal(afterZoomPan.state, "zoomed", "zoomed-pan: stayed zoomed");
    assert.equal(afterZoomPan.alt, zoomedAlt, "zoomed-pan: never paginated after trackpad pinch-in + two-finger swipe");
    assert.equal(afterZoomPan.page, 0, "zoomed-pan: page stayed 0");
    console.log(`PASS zoomed-no-paginate: trackpad pinch-in + hard two-finger swipe stayed on ${afterZoomPan.alt} (state=${afterZoomPan.state}, page=0)`);

    // 8) Mid-flick horizontal pagination (> 50% across) + immediate swipe-down keeps the NEW dominant photo
    await chrome.send("Input.dispatchKeyEvent", { type: "keyDown", key: "0", text: "0" });
    await sleep(300);
    const beforeMidFlick = await chrome.evalJs(`({
      curr: document.querySelector(".frame.current img")?.alt,
      next: [...document.querySelectorAll(".frame")].find(f => !f.classList.contains("current") && parseFloat(f.style.transform.match(/translate3d\\(([-\\d.]+)/)?.[1] || 0) > 400)?.firstElementChild?.alt,
    })`);
    // Flick > 65% into next slide (preventFling so it sits mid-snap), then immediately pull straight down
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: -420, yDistance: 0, speed: 2400, gestureSourceType: "mouse", preventFling: true,
    });
    await chrome.send("Input.synthesizeScrollGesture", {
      x: 640, y: 400, xDistance: 0, yDistance: 70, speed: 900, gestureSourceType: "mouse", preventFling: true,
    });
    await sleep(450);
    const afterMidFlick = await chrome.evalJs(`({
      open: document.querySelector("dialog").open,
      state: lightbox.state,
      alt: document.querySelector(".frame.current img")?.alt,
    })`);
    assert.equal(afterMidFlick.open, true, "mid-flick-pull: gentle pull bounced open");
    assert.equal(afterMidFlick.alt, beforeMidFlick.next, `mid-flick-pull: kept new dominant photo ${beforeMidFlick.next} (never reverted to ${beforeMidFlick.curr})`);
    console.log(`PASS mid-flick-swipe-down: stayed on new photo ${afterMidFlick.alt} (did not revert to ${beforeMidFlick.curr})`);

    // 9) Double-click on full-screen image zooms smoothly to 2x centered on tap point (edge-clamped), second double-click returns to 1x
    const dblBefore = await chrome.evalJs(`(() => {
      const r = document.querySelector(".frame.current").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    })()`);
    const clickX = Math.round(dblBefore.left + dblBefore.width * 0.25);
    const clickY = Math.round(dblBefore.top + dblBefore.height * 0.35);
    for (const clickCount of [1, 2]) {
      await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: clickX, y: clickY, button: "left", clickCount });
      await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: clickX, y: clickY, button: "left", clickCount });
      await sleep(50);
    }
    await sleep(420);
    const dblZoomed = await chrome.evalJs(`(() => {
      const r = document.querySelector(".frame.current").getBoundingClientRect();
      return { state: lightbox.state, left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    })()`);
    assert.equal(dblZoomed.state, "zoomed", "double-click: zoomed in to 2x without double-toggling");
    assert.ok(Math.abs(dblZoomed.width - dblBefore.width * 2) < 2, `double-click: exact 2x width (${dblZoomed.width.toFixed(1)} vs ${(dblBefore.width * 2).toFixed(1)})`);
    if (dblZoomed.width >= 1280) assert.ok(dblZoomed.left <= 1 && dblZoomed.right >= 1279, `double-click: no horizontal edge void (${dblZoomed.left.toFixed(1)}..${dblZoomed.right.toFixed(1)})`);
    if (dblZoomed.height >= 800) assert.ok(dblZoomed.top <= 1 && dblZoomed.bottom >= 799, `double-click: no vertical edge void (${dblZoomed.top.toFixed(1)}..${dblZoomed.bottom.toFixed(1)})`);
    await sleep(360);
    for (const clickCount of [1, 2]) {
      await chrome.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 640, y: 400, button: "left", clickCount });
      await chrome.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 640, y: 400, button: "left", clickCount });
      await sleep(50);
    }
    await sleep(420);
    const dblReset = await chrome.evalJs(`({ state: lightbox.state, width: document.querySelector(".frame.current").getBoundingClientRect().width })`);
    assert.equal(dblReset.state, "viewing", "double-click: second double-click returned to 1x viewing");
    assert.ok(Math.abs(dblReset.width - dblBefore.width) < 2, "double-click: width returned to 1x");
    console.log(`PASS double-click-2x: ${dblBefore.width.toFixed(0)}px -> ${dblZoomed.width.toFixed(0)}px (2x) -> ${dblReset.width.toFixed(0)}px (1x)`);

    assert.equal(chrome.errors.length, 0, `Zero console/runtime errors (got: ${chrome.errors.join("; ")})`);
    console.log("\nALL REAL-CHROME rAF FRAME CHECKS PASSED (0 errors).");
  } finally {
    chrome.close();
    server.closeAllConnections?.();
    server.close();
  }
}

run().then(() => process.exit(0)).catch(err => {
  console.error("REAL-CHROME CHECK FAILED:", err);
  process.exit(1);
});

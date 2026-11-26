import test from "node:test";
import assert from "node:assert/strict";
import {
  LIGHTBOX_CODE,
  parseTransform,
  createSimulator,
  assertNoBlankFrames,
  assertNoStateOscillation,
  assertMonotonicAutonomous,
  assertMaxAutonomousJump,
  assertFrame0Continuity,
  assertScrollYConstant,
} from "./simulator.mjs";

// =============================================================================
// Layer 2: Pure State-Machine & Math Atoms
// =============================================================================

test("state machine: legal transitions across all 6 states, illegal inputs are no-ops, clean cancel and reopen", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  const trace = [];
  e.lightbox.onState((s, edge) => trace.push(`${edge}->${s}`));

  // Closed state: keyboard, wheel, pointer, and double-click are pure no-ops
  assert.equal(e.lightbox.state, "closed");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.dialog.dispatch("keydown", { key: "+" });
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 600, clientY: 400, target: e.stage });
  e.stage.dispatch("dblclick");
  assert.equal(e.lightbox.state, "closed");
  assert.equal(trace.length, 0);

  // setVar rejects invalid values and clamps ranges
  assert.equal(e.lightbox.setVar("unknownKey", 1), false);
  assert.equal(e.lightbox.setVar("swipeSpeed", NaN), false);
  assert.equal(e.lightbox.setVar("swipeSpeed", Infinity), false);
  assert.equal(e.lightbox.setVar("snapAxis", "invalid"), false);
  assert.equal(e.lightbox.setVar("swipeSpeed", 999), true);
  assert.equal(e.lightbox.config.swipeSpeed, 4);
  e.lightbox.resetVars();
  assert.equal(e.lightbox.config.swipeSpeed, e.lightbox.defaults.swipeSpeed);

  // Open -> viewing -> paging -> viewing -> pulling -> viewing -> zoomed -> viewing -> closing -> closed
  e.open(0);
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");

  const startL = e.track.scrollLeft, startT = e.track.scrollTop;
  e.track.scrollLeft = startL + 100;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "paging");
  e.track.scrollLeft = startL * 2;
  e.track.dispatch("scroll");
  e.track.dispatch("scrollend");
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  e.track.scrollTop = e.track.scrollTop - 40;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "pulling");
  e.track.dispatch("scrollend");
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");

  e.dialog.dispatch("keydown", { key: "+" });
  assert.equal(e.lightbox.state, "zoomed");
  e.dialog.dispatch("keydown", { key: "0" });
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");

  // Dismiss from viewing enters closing; inputs during closing are ignored
  e.dialog.dispatch("cancel");
  assert.equal(e.lightbox.state, "closing");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.dialog.dispatch("keydown", { key: "+" });
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 600, clientY: 400, target: e.currentFrame() });
  assert.equal(e.lightbox.state, "closing");
  e.advance(420);
  assert.equal(e.lightbox.state, "closed");

  // Dismiss works cleanly from paging, pulling, and zoomed, and reopening starts fresh
  for (const setup of [
    () => { e.wheelTick(120, 0, { cancelable: true }); assert.equal(e.lightbox.state, "paging"); },
    () => { e.wheelTick(0, -60, { cancelable: true }); assert.equal(e.lightbox.state, "pulling"); },
    () => { e.dialog.dispatch("keydown", { key: "+" }); assert.equal(e.lightbox.state, "zoomed"); },
  ]) {
    e.open(2);
    e.advance(32);
    setup();
    e.dialog.dispatch("cancel");
    assert.equal(e.lightbox.state, "closing");
    e.advance(420);
    assert.equal(e.lightbox.state, "closed");
    e.open(3);
    e.advance(32);
    assert.equal(e.lightbox.state, "viewing");
    assert.equal(e.lightbox.telemetry.page, 0);
    assert.equal(e.lightbox.telemetry.scale, 1);
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 3");
    e.dialog.dispatch("cancel");
    e.advance(420);
  }

  for (const expected of [
    "open->viewing", "swipe->paging", "settle->viewing",
    "pull->pulling", "bounce->viewing", "zoom->zoomed",
    "fit->viewing", "dismiss->closing", "finish->closed",
  ]) {
    assert.ok(trace.includes(expected), `Expected transition ${expected}`);
  }
});

test("geometry precision: portrait, square, ultrawide, and fractional viewports stay snapped (not .free) at zoom=1", () => {
  const dims = [
    [1280, 1920], // 2:3 portrait (rounds (h*r)/r > h at h=800)
    [1080, 1920], // 9:16 portrait
    [1000, 1000], // square
    [2560, 900],  // ultrawide
    [1920, 1280], // 3:2 landscape
    [1333, 2000], // odd portrait
  ];
  for (const [vw, vh] of [[1280, 800], [1366, 768], [393, 852], [1117, 733]]) {
    const e = createSimulator({ w: vw, h: vh, tileCount: dims.length, tileDims: i => dims[i] });
    e.open(0);
    e.advance(32);
    for (let i = 0; i < dims.length; i++) {
      assert.equal(e.track.classList.contains("free"), false, `Tile ${i} (${dims[i]}) at ${vw}x${vh} must not drop into .free`);
      assert.equal(e.lightbox.config.snapAxis, "x");
      e.dialog.dispatch("keydown", { key: "ArrowRight" });
      e.advance(16);
    }
  }
});

test("snap modes (x, both, none) and live config updates resize track cleanly without overlapping snap areas", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  assert.equal(e.lightbox.config.snapAxis, "x");
  assert.equal(e.track.classList.contains("free"), false);
  assert.equal(e.track.classList.contains("snap-both"), false);
  const snaps = e.trackSpace.querySelectorAll(".snap");
  assert.equal(snaps.length, 3);
  assert.equal(parseFloat(snaps[0].style.left), 0);
  assert.equal(parseFloat(snaps[0].style.width), 600);
  assert.equal(parseFloat(snaps[1].style.left), 600);
  assert.equal(parseFloat(snaps[1].style.width), 600);
  assert.equal(parseFloat(snaps[2].style.left), 1200);
  assert.equal(parseFloat(snaps[1].style.top), 0);

  e.lightbox.setConfig({ snapAxis: "both", swipeSpeed: 1.5 });
  assert.equal(e.track.classList.contains("snap-both"), true);
  assert.ok(parseFloat(snaps[1].style.top) > 0);
  assert.equal(parseFloat(snaps[1].style.left), 800);

  e.lightbox.setConfig({ snapAxis: "none" });
  assert.equal(e.track.classList.contains("free"), true);
  assert.equal(snaps[0].hidden, true);
});

test("math atoms: 7 pull anchors (zero reflow), linear/log curves, minMs floor, and reduced motion", () => {
  const e = createSimulator({ w: 1000, h: 800 });
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
  const rTile = pullToHalf("tile");
  const rCenter = pullToHalf("center");
  const rLeft = pullToHalf("left");
  const rRight = pullToHalf("right");
  const rTop = pullToHalf("top");
  const rBottom = pullToHalf("bottom");

  assert.ok(rCursor.cx > 600 && rCursor.cy > 450);
  assert.ok(rTile.cx < 400 && rTile.cy < 350);
  assert.ok(Math.abs(rCenter.cx - 500) < 2 && Math.abs(rCenter.cy - 400) < 2);
  assert.ok(rLeft.cx < rCenter.cx - 100 && Math.abs(rLeft.cy - 400) < 2);
  assert.ok(rRight.cx > rCenter.cx + 100 && Math.abs(rRight.cy - 400) < 2);
  assert.ok(rTop.cy < rCenter.cy - 100 && Math.abs(rTop.cx - 500) < 2);
  assert.ok(rBottom.cy > rCenter.cy + 100 && Math.abs(rBottom.cx - 500) < 2);

  // Tile anchor remains zero-reflow during 60fps pull frames
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

  // Linear vs log dismiss curves and dismissMinMs floor
  const runCurve = (curve, minMs = 80) => {
    const s = createSimulator();
    s.open(0);
    s.advance(32);
    s.lightbox.setConfig({ dismissMaxMs: 400, dismissMinMs: minMs, dismissCurve: curve });
    const ps = s.track.scrollTop;
    s.track.scrollTop = Math.round(ps * (1 - 0.718)); // visualScale ~0.39 -> ratio 0.5
    s.track.dispatch("scroll");
    s.track.dispatch("scrollend");
    return s;
  };
  const lin = runCurve("linear");
  lin.advance(240);
  assert.equal(lin.dialog.open, false, "Linear 50% size (~200ms) finishes by 240ms");

  const log = runCurve("log");
  log.advance(240);
  assert.equal(log.dialog.open, true, "Log 50% size (~296ms) still animating at 240ms");
  log.advance(120);
  assert.equal(log.dialog.open, false, "Log curve completes within 360ms");

  const floor = createSimulator();
  floor.open(0);
  floor.advance(32);
  floor.lightbox.setConfig({ dismissMaxMs: 400, dismissMinMs: 180, dismissCurve: "linear" });
  floor.track.scrollTop = 0;
  floor.track.dispatch("scroll");
  assert.equal(floor.lightbox.state, "pulling", "Holds at min size while fingers stay down");
  floor.track.dispatch("scrollend");
  assert.equal(floor.lightbox.state, "closing", "Dismisses on release from min size");
  floor.advance(120);
  assert.equal(floor.dialog.open, true, "Honors dismissMinMs=180ms floor");
  floor.advance(120);
  assert.equal(floor.dialog.open, false);

  // Reduced motion closes immediately (2 rAFs)
  const rm = createSimulator({ reducedMotion: true });
  rm.open(0);
  rm.advance(32);
  rm.dialog.dispatch("cancel");
  rm.advance(48);
  assert.equal(rm.dialog.open, false, "Reduced motion completes dismiss in <=48ms");
});

test("min size when pinching or swiping down matches the photo's exact grid tile size across slides and resizes", () => {
  // Custom tile sizes: Photo 0 (landscape 3:2) = 360x240 in grid; Photo 1 (portrait 2:3) = 220x330 in grid
  const rects = [
    { left: 20, top: 100, width: 360, height: 240, right: 380, bottom: 340 },
    { left: 400, top: 100, width: 220, height: 330, right: 620, bottom: 430 },
  ];
  const e = createSimulator({
    w: 1200, h: 800, tileCount: 4,
    tileRects: i => rects[i % 2],
  });
  e.open(0);
  e.advance(32);
  // Photo 0 fitted in 1200x800 is 1200x800 -> grid tile is 360x240 -> minScale = 0.30

  // 1) Ctrl+wheel pinch out clamps strictly at grid tile size (360x240)
  for (let i = 0; i < 20; i++) {
    e.wheelTick(0, 120, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  }
  let r = e.currentFrame().getBoundingClientRect();
  assert.ok(Math.abs(r.width - 360) < 1 && Math.abs(r.height - 240) < 1, `Ctrl+wheel pinch min matches grid tile (${r.width.toFixed(1)}x${r.height.toFixed(1)} vs 360x240)`);
  assert.ok(Math.abs(e.lightbox.telemetry.scale - 0.3) < 0.002);
  e.dialog.dispatch("keydown", { key: "0" });
  e.advance(250);

  // 2) Safari gesturechange pinch out clamps strictly at grid tile size (360x240)
  e.stage.dispatch("gesturestart", { clientX: 600, clientY: 400, scale: 1 });
  e.stage.dispatch("gesturechange", { clientX: 600, clientY: 400, scale: 0.05 });
  r = e.currentFrame().getBoundingClientRect();
  assert.ok(Math.abs(r.width - 360) < 1 && Math.abs(r.height - 240) < 1, `Safari gesture pinch min matches grid tile (${r.width.toFixed(1)}x${r.height.toFixed(1)})`);
  e.stage.dispatch("gesturechange", { clientX: 600, clientY: 400, scale: 1 });
  e.stage.dispatch("gestureend", { clientX: 600, clientY: 400, scale: 1 });
  e.advance(250);

  // 3) 2-finger touch pinch out clamps strictly at grid tile size (360x240)
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 200, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 1000, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 590, clientY: 400 });
  e.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 610, clientY: 400 });
  r = e.currentFrame().getBoundingClientRect();
  assert.ok(Math.abs(r.width - 360) < 1 && Math.abs(r.height - 240) < 1, `2-finger touch pinch min matches grid tile (${r.width.toFixed(1)}x${r.height.toFixed(1)})`);
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 200, clientY: 400 });
  e.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 1000, clientY: 400 });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 200, clientY: 400 });
  e.pointerEvent("pointerup", { pointerId: 2, button: 0, clientX: 1000, clientY: 400 });
  e.advance(250);

  // 4) 1-finger drag-down max pull clamps strictly at grid tile size (360x240)
  e.pointerEvent("pointerdown", { pointerId: 3, button: 0, clientX: 600, clientY: 50, target: e.currentFrame() });
  e.pointerEvent("pointermove", { pointerId: 3, button: 0, clientX: 600, clientY: 900 });
  r = e.currentFrame().getBoundingClientRect();
  assert.ok(Math.abs(r.width - 360) < 1 && Math.abs(r.height - 240) < 1, `Pointer pull-down min matches grid tile (${r.width.toFixed(1)}x${r.height.toFixed(1)})`);
  e.pointerEvent("pointercancel", { pointerId: 3, button: 0, clientX: 600, clientY: 900 });
  e.advance(250);

  // 5) Navigate to Photo 1 (portrait 533.33x800, grid tile 220x330 -> minScale = 0.4125) and swipe down / pinch out
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.advance(32);
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  // Trackpad pull just above st=1 approaches exact grid tile size (220x330), never smaller
  e.track.scrollTop = 2;
  e.track.dispatch("scroll");
  r = e.currentFrame().getBoundingClientRect();
  assert.ok(r.width >= 219.5 && r.width <= 226 && r.height >= 329.5 && r.height <= 339, `Photo 1 trackpad pull stops at its grid tile size (${r.width.toFixed(1)}x${r.height.toFixed(1)} vs 220x330)`);

  // Ctrl+wheel pinch on Photo 1 clamps right at 220x330
  e.track.scrollTop = e.track.scrollTop + 400;
  e.track.dispatch("scroll");
  for (let i = 0; i < 20; i++) {
    e.wheelTick(0, 120, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  }
  r = e.currentFrame().getBoundingClientRect();
  assert.ok(Math.abs(r.width - 220) < 1 && Math.abs(r.height - 330) < 1, `Photo 1 pinch min matches its grid tile (${r.width.toFixed(1)}x${r.height.toFixed(1)} vs 220x330)`);
});

// =============================================================================
// Layer 3: Threaded Compositor & Input Simulator Cascades (with Layer 1 Invariants)
// =============================================================================

test("compositor: half-swipe left and right bounce back monotonically with zero state oscillation or tx flicker", () => {
  for (const dir of [1, -1]) {
    const e = createSimulator({ w: 1200, h: 800, scrollY: 500, threadedCompositor: true });
    e.open(0);
    e.advance(32);
    e.startRecording();

    // Swipe ~38% of a slide across 6 trackpad frames (228px on padX=600)
    for (let i = 0; i < 6; i++) {
      e.wheelTick(dir * 38, 0, { cancelable: i === 0 });
      e.stepFrame(16);
    }
    assert.equal(e.lightbox.state, "paging");

    // Release fingers -> compositor runs native scroll-snap back to originX
    e.releaseTrackpad({ snapFrames: 14 });
    e.advance(450);

    const framesLog = e.stopRecording();
    assertNoBlankFrames(framesLog);
    assertNoStateOscillation(framesLog);
    assertMonotonicAutonomous(framesLog, "tx", { eps: 0.5 });
    assertMaxAutonomousJump(framesLog, { maxTx: 140, maxScale: 0.1 });
    assertScrollYConstant(framesLog, 500);

    assert.equal(e.lightbox.state, "viewing");
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0");
    assert.equal(e.lightbox.telemetry.page, 0);
  }
});

test("compositor: mid-swipe reversal across center with fingers down tracks smoothly with zero flicker", () => {
  const e = createSimulator({ w: 1200, h: 800, scrollY: 500, threadedCompositor: true });
  e.open(0);
  e.advance(32);
  e.startRecording();

  // Swipe 42% left, pause briefly (64ms with fingers down), reverse across 0% to 42% right, then release
  for (let i = 0; i < 6; i++) { e.wheelTick(42, 0, { cancelable: i === 0 }); e.stepFrame(16); }
  e.advance(64);
  for (let i = 0; i < 12; i++) { e.wheelTick(-42, 0, { cancelable: false }); e.stepFrame(16); }
  assert.ok(e.lightbox.telemetry.page > 200, "Tracked smoothly past center into right neighbor");

  e.releaseTrackpad({ snapFrames: 14 });
  e.advance(450);

  const framesLog = e.stopRecording();
  assertNoBlankFrames(framesLog);
  assertNoStateOscillation(framesLog);
  assertMonotonicAutonomous(framesLog, "tx", { eps: 0.5 });
  assertMaxAutonomousJump(framesLog, { maxTx: 140, maxScale: 0.1 });
  assertScrollYConstant(framesLog, 500);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0");
});

test("compositor: full horizontal turn (left and right) stays monotonic on compositor with zero premature scrollLeft reset", () => {
  const e = createSimulator({ w: 1200, h: 800, scrollY: 500, threadedCompositor: true });
  e.open(0);
  e.advance(32);
  const originX = e.track.scrollLeft;
  e.startRecording();

  // Swipe 65% left across 6 frames then release -> compositor finishes turn to padX * 2
  for (let i = 0; i < 6; i++) { e.wheelTick(65, 0, { cancelable: i === 0 }); e.stepFrame(16); }
  assert.equal(e.lightbox.state, "paging");
  e.releaseTrackpad({ snapFrames: 12 });
  e.advance(80); // mid-turn: must NOT have reset scrollLeft back to originX
  assert.ok(e.track.scrollLeft > originX + 350, "Native forward X snap stays on compositor without reset");
  e.advance(300);

  const framesLog = e.stopRecording();
  assertNoBlankFrames(framesLog);
  assertNoStateOscillation(framesLog);
  assertMonotonicAutonomous(framesLog, "tx", { eps: 0.5 });
  assertScrollYConstant(framesLog, 500);
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(e.lightbox.state, "viewing");
});

test("compositor: catching an in-flight horizontal bounce with fingers (trackpad or pointer) keeps frame-0 continuity", () => {
  // 1) Trackpad catch mid-bounce
  const t = createSimulator({ w: 1200, h: 800, threadedCompositor: true });
  t.open(0);
  t.advance(32);
  t.startRecording();
  for (let i = 0; i < 5; i++) { t.wheelTick(45, 0, { cancelable: i === 0 }); t.stepFrame(16); }
  t.releaseTrackpad({ snapFrames: 16 });
  t.advance(80); // partway back toward center
  const pageBeforeCatch = t.lightbox.telemetry.page;
  assert.ok(pageBeforeCatch < -50, "Still mid-bounce before catch");
  // Fingers catch and push forward into next photo
  for (let i = 0; i < 8; i++) { t.wheelTick(50, 0, { cancelable: i === 0 }); t.stepFrame(16); }
  t.releaseTrackpad({ snapFrames: 12 });
  t.advance(400);
  const tLog = t.stopRecording();
  assertNoBlankFrames(tLog);
  assertNoStateOscillation(tLog);
  assert.equal(t.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(t.lightbox.state, "viewing");

  // 2) 1-finger pointer catch mid-settle
  const p = createSimulator({ w: 1200, h: 800 });
  p.open(0);
  p.advance(32);
  p.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 700, clientY: 400, target: p.currentFrame() });
  p.stepFrame(16);
  p.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 460, clientY: 400 });
  p.stepFrame(16);
  p.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 460, clientY: 400 });
  p.stepFrame(16);
  const rectBefore = p.currentFrame().getBoundingClientRect();
  p.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 500, clientY: 400, target: p.currentFrame() });
  const rectAfter = p.currentFrame().getBoundingClientRect();
  assertFrame0Continuity(rectBefore, rectAfter, 1.0);
});

test("blast swipes with slow 200ms decodes, out-of-order stale decode protection, and decode error notice", async () => {
  // 1) Delayed 200ms decodes during 8 forward + 4 reverse blast
  const e = createSimulator({ w: 1200, h: 800, tileCount: 15, decodeMode: "delayed", decodeDelayMs: 200 });
  e.open(0);
  e.advance(32);
  e.startRecording();
  e.decodedUrls.length = 0;

  for (let i = 0; i < 8; i++) { e.dialog.dispatch("keydown", { key: "ArrowRight" }); e.advance(30); }
  for (let i = 0; i < 4; i++) { e.dialog.dispatch("keydown", { key: "ArrowLeft" }); e.advance(30); }
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 4");
  const fullDuringBlast = e.decodedUrls.filter(u => u.includes("medium-res/"));
  assert.equal(fullDuringBlast.length, 0, "Zero full-res decodes fired for intermediate slides during blast");
  assert.ok(e.decodedUrls.some(u => u.includes("low-res/")), "Prewarmed low-res ahead during blast");

  // Pause -> debounce fires at 90ms + 200ms decode completes
  e.advance(350);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  assert.equal(e.currentFrame().lastElementChild.src, "img/medium-res/4.jpg");
  assertNoBlankFrames(e.stopRecording());

  // 2) Out-of-order stale decode resolution never overwrites active slide; active decode failure sets notice without blanking
  const m = createSimulator({ w: 1200, h: 800, tileCount: 6, decodeMode: "manual" });
  m.open(0);
  m.advance(32);
  m.dialog.dispatch("keydown", { key: "ArrowRight" });
  m.advance(120); // triggers medium-res/1.jpg decode while medium-res/0.jpg is still pending
  m.resolveDecode("medium-res/0.jpg");
  await new Promise(r => setImmediate(r));
  assert.equal(m.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(m.currentFrame().lastElementChild.src, "img/low-res/1.jpg", "Stale Photo 0 decode ignored");

  m.rejectDecode("medium-res/1.jpg");
  await new Promise(r => setImmediate(r));
  assert.ok(m.notice.textContent.length > 0, "Decode failure displays notice");
  assert.equal(m.currentFrame().children.length, 1, "Low-res preview stays visible on full-res error");
});

test("edge-arrived swipe before scrollend commits cleanly on next swipe OR downward pull, and diagonal wiggle recovers", () => {
  // 1) Arrived at snap edge -> next swipe immediately advances to Photo 2
  const a = createSimulator({ w: 1200, h: 800 });
  a.open(0);
  a.advance(32);
  const padX = a.track.scrollLeft;
  a.wheelTick(padX, 0, { cancelable: true });
  assert.equal(a.track.scrollLeft, padX * 2);
  a.advance(96); // gap >= 80 before scrollend
  a.wheelTick(40, 0, { cancelable: true });
  assert.equal(a.currentFrame().firstElementChild.alt, "Photo 1");

  // 2) Arrived at snap edge -> immediate downward pull commits Photo 1 and shrinks Photo 1
  const b = createSimulator({ w: 1200, h: 800 });
  b.open(0);
  b.advance(32);
  b.wheelTick(padX, 0, { cancelable: true });
  b.stepFrame(32);
  b.wheelTick(0, -24, { cancelable: true });
  assert.equal(b.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(b.lightbox.state, "pulling");

  // 3) Quick diagonal horizontal swipe with initial vertical wiggle recovers to paging with zero shrink flash
  const c = createSimulator({ w: 1200, h: 800 });
  c.open(0);
  c.advance(32);
  const startL = c.track.scrollLeft, startT = c.track.scrollTop;
  c.track.scrollLeft = startL + 4;
  c.track.scrollTop = startT - 10;
  c.track.dispatch("scroll");
  c.track.scrollLeft = startL * 2;
  c.track.scrollTop = startT - 12;
  c.track.dispatch("scroll");
  assert.equal(c.lightbox.state, "paging");
  assert.equal(c.lightbox.telemetry.scale, 1);
  c.track.dispatch("scrollend");
  c.advance(32);
  assert.equal(c.currentFrame().firstElementChild.alt, "Photo 1");
});

test("swipe-down lifecycle: gentle bounce, moderate dismiss, forceful immediate dismiss, fingers-held 3s, and !hasScrollEnd fallback", () => {
  // 1) Gentle pull at scrollY=500 -> monotonic bounce back to full size
  const gentle = createSimulator({ w: 1200, h: 800, scrollY: 500 });
  gentle.open(0);
  gentle.advance(32);
  gentle.startRecording();
  gentle.wheelTick(0, -45, { cancelable: true, discrete: true });
  assert.equal(gentle.lightbox.state, "pulling");
  assert.ok(gentle.lightbox.telemetry.scale < 1, "Shrank on discrete -45 wheel at scrollY=500");
  gentle.releaseTrackpad({ vy: 0 });
  gentle.advance(300);
  const gLog = gentle.stopRecording();
  assertNoBlankFrames(gLog);
  assertNoStateOscillation(gLog);
  assertMonotonicAutonomous(gLog, "sx", { eps: 0.002 });
  assertScrollYConstant(gLog, 500);
  assert.equal(gentle.dialog.open, true);
  assert.equal(gentle.lightbox.state, "viewing");
  assert.equal(gentle.lightbox.telemetry.scale, 1);

  // 2) Fingers-held slow drag past close@, deceleration, reversal, 3s motionless hold -> never auto-dismisses
  const held = createSimulator({ w: 1200, h: 800, scrollY: 500 });
  held.open(0);
  held.advance(32);
  for (const d of [-35, -30, -25, -20, -16, -12, -8, -5, -3]) {
    held.wheelTick(0, d, { cancelable: d === -35, clientX: 900, clientY: 650 });
    held.stepFrame(16.67);
  }
  assert.equal(held.dialog.open, true);
  held.wheelTick(0, 10, { cancelable: false, clientX: 900, clientY: 650 });
  held.advance(3000);
  assert.equal(held.dialog.open, true, "3s motionless hold past close@ must NEVER auto-dismiss");

  const rectBefore = held.currentFrame().getBoundingClientRect();
  held.track.dispatch("scrollend");
  const rectFrame0 = held.currentFrame().getBoundingClientRect();
  assertFrame0Continuity(rectBefore, rectFrame0, 0.5);
  held.advance(420);
  assert.equal(held.dialog.open, false);
  assert.equal(held.closeEvents[0].inViewer, false, ".in-viewer cleared before dialog.close()");
  assert.equal(held.win.scrollY, 500);

  // 3) Swiping all the way down to min grid size holds while fingers stay down (even continuing to push down),
  //    can reverse back up, and only snaps back to grid on release with post-close momentum absorbed
  const force = createSimulator({ w: 1200, h: 800, scrollY: 500 });
  force.open(0);
  force.advance(32);
  force.startRecording();
  force.wheelTick(0, -180, { cancelable: true });
  force.wheelTick(0, -240, { cancelable: false }); // hits st === 0 (grid tile min size)
  assert.equal(force.track.scrollTop, 0);
  assert.equal(force.lightbox.state, "pulling", "Holds at min grid size while fingers stay down");
  assert.equal(force.dialog.open, true);
  // Continuing to push down past min size and holding motionless must NEVER auto-close
  for (let i = 0; i < 6; i++) {
    force.wheelTick(0, -40, { cancelable: false });
    force.stepFrame(16);
  }
  force.advance(1000);
  assert.equal(force.lightbox.state, "pulling", "Still holding at min size after continued downward push + 1s hold");
  assert.equal(force.dialog.open, true);

  // Release fingers -> scrollend triggers dismiss and post-close momentum is absorbed without moving scrollY
  force.track.dispatch("scrollend");
  assert.equal(force.lightbox.state, "closing");
  assert.equal(force.track.style.overflow, "hidden");
  force.releaseTrackpad({ vy: -45, decay: 0.88 });
  force.advance(450);
  const fLog = force.stopRecording();
  assertNoStateOscillation(fLog);
  assertScrollYConstant(fLog, 500);
  assert.equal(force.dialog.open, false);
  assert.equal(force.track.style.overflow, "");

  // Normal downward gallery scroll passes straight through right after close
  force.wheelTick(0, 120, { cancelable: true });
  assert.equal(force.win.scrollY, 620, "Gallery scrolls down immediately after close");

  // 4) !hasScrollEnd fallback timer stays open while pushing at st === 0, then bounces/dismisses after fingers stop
  const noSE = createSimulator({ w: 1200, h: 800, hasScrollEnd: false });
  noSE.open(0);
  noSE.advance(32);
  noSE.wheelTick(0, -400, { cancelable: true });
  for (let i = 0; i < 4; i++) {
    noSE.advance(80);
    noSE.wheelTick(0, -30, { cancelable: false });
  }
  assert.equal(noSE.lightbox.state, "pulling", "Fallback timer stays open while fingers keep pushing at st=0");
  noSE.advance(450);
  assert.equal(noSE.dialog.open, false, "Fallback timer dismisses once fingers lift");
});

test("mid-pull dismiss keeps wheel absorber armed across closing animation and blocks post-close gallery bleed", () => {
  const e = createSimulator({ w: 1200, h: 800, scrollY: 500 });
  e.open(0);
  e.advance(32);

  e.wheelTick(0, -130, { cancelable: true });
  e.track.dispatch("scrollend");
  assert.equal(e.lightbox.state, "closing");

  const duringZero = e.win.dispatch("wheel", { deltaX: 3, deltaY: 0, cancelable: true });
  assert.equal(duringZero.defaultPrevented, true);
  const duringPos = e.win.dispatch("wheel", { deltaY: 12, cancelable: true });
  assert.equal(duringPos.defaultPrevented, true);

  e.advance(420);
  assert.equal(e.dialog.open, false);

  const trail1 = e.win.dispatch("wheel", { deltaY: -28, cancelable: true });
  assert.equal(trail1.defaultPrevented, true);
  e.stepFrame(16);
  const trailNoise = e.win.dispatch("wheel", { deltaX: -4, deltaY: 0, cancelable: true });
  assert.equal(trailNoise.defaultPrevented, true);
  e.stepFrame(16);
  const trail2 = e.win.dispatch("wheel", { deltaY: -12, cancelable: true });
  assert.equal(trail2.defaultPrevented, true);

  // Scrolling down the gallery immediately disarms
  const down = e.win.dispatch("wheel", { deltaY: 18, cancelable: true });
  assert.equal(Boolean(down.defaultPrevented), false);
  const afterDisarm = e.win.dispatch("wheel", { deltaY: -18, cancelable: true });
  assert.equal(Boolean(afterDisarm.defaultPrevented), false);
});

test("cross-axis gestures: drag-down mid-horizontal-swipe (pointer & trackpad) shrinks smoothly without strobe", () => {
  // 1) 1-finger pointer grabs mid-settle and drags straight down
  const p = createSimulator({ w: 1200, h: 800 });
  p.open(0);
  p.advance(32);
  p.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 700, clientY: 400, target: p.currentFrame() });
  p.stepFrame(16);
  p.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 460, clientY: 400 });
  p.stepFrame(16);
  p.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 460, clientY: 400 });
  p.stepFrame(16);
  assert.ok(Math.abs(p.lightbox.telemetry.page) > 40);

  p.startRecording();
  p.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 600, clientY: 300, target: p.currentFrame() });
  let prevScale = 1;
  for (let i = 1; i <= 5; i++) {
    p.stepFrame(16);
    p.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 600, clientY: 300 + i * 16 });
    assert.equal(p.lightbox.state, "pulling");
    assert.ok(p.lightbox.telemetry.scale < prevScale, "Scale shrinks monotonically without 1.0 strobe");
    prevScale = p.lightbox.telemetry.scale;
  }
  p.advance(140);
  p.pointerEvent("pointerup", { pointerId: 2, button: 0, clientX: 600, clientY: 380 });
  p.advance(250);
  const pLog = p.stopRecording();
  assertNoBlankFrames(pLog);
  assertNoStateOscillation(pLog);
  assert.equal(p.lightbox.state, "viewing");
  assert.equal(p.lightbox.telemetry.scale, 1);
  assert.equal(p.lightbox.telemetry.page, 0);

  // 2) Trackpad drag-down mid-horizontal-swipe switches cleanly from paging -> pulling with smooth page decay
  const t = createSimulator({ w: 1200, h: 800 });
  t.open(0);
  t.advance(32);
  t.wheelTick(120, 0, { cancelable: true });
  t.stepFrame(16);
  assert.equal(t.lightbox.state, "paging");
  const pageBefore = Math.abs(t.lightbox.telemetry.page);
  for (let i = 0; i < 4; i++) {
    t.wheelTick(0, -14, { cancelable: false });
    t.stepFrame(16);
  }
  assert.equal(t.lightbox.state, "pulling");
  assert.ok(t.lightbox.telemetry.scale < 1);
  assert.ok(Math.abs(t.lightbox.telemetry.page) < pageBefore);
});

test("zoom, pan, pinch (touch, ctrl+wheel, Safari gesture), double-tap fit, and minimap", () => {
  const e = createSimulator({ w: 1000, h: 800 });
  e.open(0);
  e.advance(32);

  // 1) Click-hold-drag left past 50% advances to Photo 1
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 700, clientY: 400, target: e.currentFrame() });
  e.stepFrame(16);
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 150, clientY: 400 });
  e.stepFrame(16);
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 150, clientY: 400 });
  e.advance(250);
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  // 2) Two-finger touch pinch zooms to 2x, shows minimap, sets .track.free
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 400, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 600, clientY: 400, target: e.currentFrame() });
  e.stepFrame(16);
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  e.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 700, clientY: 400 });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  e.pointerEvent("pointerup", { pointerId: 2, button: 0, clientX: 700, clientY: 400 });
  e.advance(250);
  assert.equal(e.lightbox.state, "zoomed");
  assert.equal(e.stage.classList.contains("zoomed"), true);
  assert.equal(e.track.classList.contains("free"), true);
  assert.equal(e.map.hidden, false, "Minimap visible when zoomed");

  // Minimap pointer drag pans cleanly within bounds
  e.pointerEvent("pointerdown", { pointerId: 3, button: 0, clientX: 900, clientY: 740, target: e.map });
  e.pointerEvent("pointermove", { pointerId: 3, button: 0, clientX: 920, clientY: 750 });
  e.pointerEvent("pointerup", { pointerId: 3, button: 0, clientX: 920, clientY: 750 });
  assert.equal(e.lightbox.state, "zoomed");

  // Double-tap resets zoom cleanly to viewing and hides minimap
  e.pointerEvent("pointerdown", { pointerId: 4, button: 0, clientX: 500, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 4, button: 0, clientX: 500, clientY: 400 });
  e.advance(80);
  e.pointerEvent("pointerdown", { pointerId: 5, button: 0, clientX: 500, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 5, button: 0, clientX: 500, clientY: 400 });
  e.advance(250);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.map.hidden, true);

  // 3) Ctrl+wheel zoom in and pinch below 1x -> bounce back to viewing
  const zEv = e.wheelTick(0, -100, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  assert.equal(zEv.defaultPrevented, true);
  assert.equal(e.lightbox.state, "zoomed");
  e.advance(200);
  e.dialog.dispatch("keydown", { key: "0" });
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");

  // 4) Safari gesturestart/change/end pinch out below dismissScale closes cleanly
  e.stage.dispatch("gesturestart", { clientX: 500, clientY: 400, scale: 1 });
  e.stage.dispatch("gesturechange", { clientX: 500, clientY: 400, scale: 0.65 });
  assert.equal(e.lightbox.state, "pulling");
  e.stage.dispatch("gestureend", { clientX: 500, clientY: 400, scale: 0.65 });
  assert.equal(e.lightbox.state, "closing");
  e.advance(420);
  assert.equal(e.dialog.open, false);
});

test("zoomed in: trackpad scroll, pointer drag, and arrow keys pan within bounds and never paginate or pull-dismiss", () => {
  // Test both landscape (Photo 0) and portrait (Photo 1, where slight zoom has limitX=0)
  for (const startIdx of [0, 1]) {
    const e = createSimulator({ w: 1200, h: 800 });
    e.open(startIdx);
    e.advance(32);
    const startAlt = `Photo ${startIdx}`;
    assert.equal(e.currentFrame().firstElementChild.alt, startAlt);

    // Zoom in slightly on portrait (1.5x -> limitX=0, limitY>0) and 2.25x on landscape
    e.dialog.dispatch("keydown", { key: "+" });
    if (startIdx === 0) e.dialog.dispatch("keydown", { key: "+" });
    assert.equal(e.lightbox.state, "zoomed");

    // 1) Huge trackpad swipes left, right, and up past all edges must NEVER paginate or pull-dismiss
    for (const [dx, dy] of [[900, 0], [-1800, 0], [0, -900]]) {
      e.wheelTick(dx, dy, { cancelable: true });
      e.track.dispatch("scrollend");
      e.advance(200);
      assert.equal(e.lightbox.state, "zoomed", `Stays zoomed after wheel (${dx},${dy})`);
      assert.equal(e.currentFrame().firstElementChild.alt, startAlt, `Never paginates while zoomed (${dx},${dy})`);
      assert.equal(e.lightbox.telemetry.page, 0);
      assert.equal(e.dialog.open, true);
    }

    // 2) Huge 1-finger drags left, right, and down past edges must NEVER paginate or pull-dismiss
    for (const [x1, y1, x2, y2] of [[900, 400, 50, 400], [50, 400, 1150, 400], [600, 50, 600, 750]]) {
      e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: x1, clientY: y1, target: e.currentFrame() });
      e.stepFrame(16);
      e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: x2, clientY: y2 });
      e.stepFrame(16);
      e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: x2, clientY: y2 });
      e.advance(250);
      assert.equal(e.lightbox.state, "zoomed");
      assert.equal(e.currentFrame().firstElementChild.alt, startAlt, "Pointer drag while zoomed never paginates");
      assert.equal(e.lightbox.telemetry.page, 0);
      assert.equal(e.dialog.open, true);
    }

    // 3) Arrow keys pan while zoomed instead of paginating away
    e.dialog.dispatch("keydown", { key: "ArrowRight" });
    e.dialog.dispatch("keydown", { key: "ArrowLeft" });
    assert.equal(e.lightbox.state, "zoomed");
    assert.equal(e.currentFrame().firstElementChild.alt, startAlt, "Arrow keys do not paginate while zoomed");

    // 4) Fitting back to 1x immediately restores normal pagination
    e.dialog.dispatch("keydown", { key: "0" });
    e.advance(250);
    assert.equal(e.lightbox.state, "viewing");
    assert.equal(e.track.classList.contains("free"), false);

    // 5) Trackpad pinch-in (ctrl+wheel) followed immediately (20ms + 70ms + 200ms) by two-finger swipe never paginates
    for (let i = 0; i < 6; i++) {
      e.wheelTick(0, -18, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
      e.stepFrame(16);
    }
    assert.equal(e.lightbox.state, "zoomed");
    e.stepFrame(20); // within 60ms wheelPinching window
    e.wheelTick(400, 0, { cancelable: true });
    e.advance(64); // crosses 60ms -> syncTrack() locks out padX
    e.wheelTick(600, 0, { cancelable: true });
    e.track.dispatch("scrollend");
    e.advance(200);
    assert.equal(e.lightbox.state, "zoomed");
    assert.equal(e.currentFrame().firstElementChild.alt, startAlt, "Pinch-in + immediate two-finger swipe never paginates");
    assert.equal(e.lightbox.telemetry.page, 0);

    // Fit back to 1x -> ArrowRight paginates cleanly again
    e.dialog.dispatch("keydown", { key: "0" });
    e.advance(250);
    e.dialog.dispatch("keydown", { key: "ArrowRight" });
    e.advance(32);
    assert.equal(e.currentFrame().firstElementChild.alt, `Photo ${startIdx + 1}`, "Pagination works again at 1x");
  }
});

test("ResizeObserver mid-viewing, mid-zoom, and mid-drag keeps geometry valid", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);

  e.triggerResize(900, 700);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(parseFloat(e.currentFrame().style.width), 900);

  e.dialog.dispatch("keydown", { key: "+" });
  e.triggerResize(1100, 600);
  assert.equal(e.lightbox.state, "zoomed");

  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 500, clientY: 300, target: e.currentFrame() });
  e.triggerResize(1280, 800);
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 500, clientY: 300 });
  e.advance(250);
  assert.equal(e.dialog.open, true);
});

test("iOS zero-flicker pagination rotates persistent neighbor frame with zero DOM swap", async () => {
  const e = createSimulator();
  e.open(0);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  e.advance(48);
  const nextFrameBefore = e.frames.find(f => f.firstElementChild?.alt === "Photo 1");
  assert.ok(nextFrameBefore);
  assert.equal(e.currentFrame().children.length, 2, "Low-res stays mounted behind full-res");
  assert.equal(nextFrameBefore.lastElementChild.src, "img/medium-res/1.jpg", "Neighbor pre-upgraded");

  const childrenBefore = [...nextFrameBefore.children];
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 900, clientY: 450, target: e.currentFrame() });
  e.stepFrame(16);
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 450 });
  e.stepFrame(16);
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 100, clientY: 450 });
  e.advance(200);
  await new Promise(r => setImmediate(r));
  e.advance(48);

  assert.equal(e.currentFrame(), nextFrameBefore);
  assert.deepEqual(e.currentFrame().children, childrenBefore, "Zero DOM image swap on one-finger swipe");
  assert.equal(e.currentFrame().lastElementChild.decoding, "sync");
  assert.equal(e.tiles[1].firstElementChild.decoding, "sync");
  assert.equal(e.tiles[1].firstElementChild.loading, "eager");
});

test("hot path: zero forced reflows, layout reads/writes, or root --shade writes during swipes and pulls", () => {
  const e = createSimulator();
  e.open(0);
  e.advance(32);
  const startL = e.track.scrollLeft, startT = e.track.scrollTop;

  const hRes = e.measureHotPath(() => {
    for (let i = 1; i <= 500; i++) {
      e.stage.dispatch("wheel", { deltaX: 10, deltaY: 0, deltaMode: 0, clientX: 720, clientY: 450, cancelable: false });
      e.track.scrollLeft = startL + (i % 400) + 10;
      e.track.dispatch("scroll");
    }
  });
  assert.equal(hRes.forcedReflows, 0);
  assert.equal(hRes.layoutReads, 0);
  assert.equal(hRes.layoutWrites, 0);
  assert.equal(hRes.shadeWrites, 0);
  assert.equal(hRes.hiddenMapWrites, 0);
  assert.equal(hRes.transformWrites, 1000);
  assert.equal(hRes.interventions, 0);

  e.track.scrollLeft = startL;
  e.track.dispatch("scroll");

  const vRes = e.measureHotPath(() => {
    for (let i = 1; i <= 300; i++) {
      e.stage.dispatch("wheel", { deltaX: 0, deltaY: -8, deltaMode: 0, clientX: 1000, clientY: 650, cancelable: false });
      e.track.scrollTop = Math.max(10, startT - (i % 300) - 10);
      e.track.dispatch("scroll");
    }
  });
  assert.equal(vRes.forcedReflows, 0);
  assert.equal(vRes.layoutReads, 0);
  assert.equal(vRes.layoutWrites, 0);
  assert.equal(vRes.hiddenMapWrites, 0);
  assert.equal(vRes.transformWrites, 300);
});

test("modular lightbox-debug mounts cleanly, highlights active state/edge, reparents without close flicker, and unmounts completely", () => {
  const prod = createSimulator();
  assert.equal(prod.head.children.length, 0);
  assert.equal(prod.body.firstElementChild, prod.dialog);

  const e = createSimulator({ loadDebug: true });
  const bar = e.body.firstElementChild;
  assert.equal(bar.classList.contains("lb-debug"), true);
  assert.equal(e.head.children.some(n => n.tagName === "STYLE"), true);
  assert.equal(e.docEl.style.getPropertyValue("--lb-debug-h"), "235px");

  const walk = (root, out = []) => { out.push(root); for (const c of root.children) walk(c, out); return out; };
  const all = walk(bar);
  const nodes = all.filter(n => n.classList.contains("sm-node"));
  const edgeBars = all.filter(n => n.classList.contains("sm-edge-bar"));
  assert.equal(nodes.length, e.lightbox.graph.nodes.length);
  assert.equal(edgeBars.length, e.lightbox.graph.edges.length);

  e.open(0);
  e.advance(32);
  assert.equal(e.dialog.firstElementChild, bar);
  assert.equal(nodes.find(n => n.dataset.node === "viewing").classList.contains("active"), true);
  assert.equal(edgeBars.find(n => n.dataset.edge === "open").classList.contains("active"), true);

  const swipeSpeedInput = all.find(n => n.tagName === "INPUT" && n.getAttribute("aria-label") === "swipe speed");
  swipeSpeedInput.value = "3.2";
  swipeSpeedInput.dispatch("input");
  assert.equal(e.lightbox.config.swipeSpeed, 3.2);

  const buttons = all.filter(n => n.tagName === "BUTTON");
  buttons.find(b => b.textContent === "Reset").dispatch("click");
  assert.equal(e.lightbox.config.swipeSpeed, e.lightbox.defaults.swipeSpeed);

  buttons.find(b => b.textContent === "Hide").dispatch("click");
  assert.equal(bar.classList.contains("collapsed"), true);
  assert.equal(e.docEl.style.getPropertyValue("--lb-debug-h"), "28px");

  e.dialog.dispatch("cancel");
  e.advance(420);
  assert.equal(e.closeEvents[0].inViewer, false);
  assert.equal(e.closeEvents[0].debugInBody, true);
  assert.equal(e.closeEvents[0].debugH, "28px");

  buttons.find(b => b.getAttribute("aria-label") === "Close debug graph").dispatch("click");
  assert.equal(e.body.children.includes(bar), false);
  assert.equal(e.head.children.length, 0);
  assert.equal(e.docEl.style.getPropertyValue("--lb-debug-h"), "");
});

if (process.argv.includes("--bench")) {
  const e = createSimulator();
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

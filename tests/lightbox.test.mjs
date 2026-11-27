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

  // Closed state: keyboard, wheel, pointer, and double-click are pure no-ops
  assert.equal(e.lightbox.state, "closed");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.dialog.dispatch("keydown", { key: "+" });
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 600, clientY: 400, target: e.stage });
  e.stage.dispatch("dblclick");
  assert.equal(e.lightbox.state, "closed");
  assert.equal(e.lightbox.lastEdge, null);

  // Open -> viewing -> paging -> viewing -> pulling -> viewing -> zoomed -> viewing -> closing -> closed
  e.open(0);
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.lightbox.lastEdge, "open");

  const startL = e.track.scrollLeft;
  e.track.scrollLeft = startL + 100;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "paging");
  assert.equal(e.lightbox.lastEdge, "swipe");
  e.track.scrollLeft = startL * 2;
  e.track.dispatch("scroll");
  e.track.dispatch("scrollend");
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.lightbox.lastEdge, "settle");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  e.track.scrollTop = e.track.scrollTop - 40;
  e.track.dispatch("scroll");
  assert.equal(e.lightbox.state, "pulling");
  assert.equal(e.lightbox.lastEdge, "pull");
  e.track.dispatch("scrollend");
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.lightbox.lastEdge, "bounce");

  e.dialog.dispatch("keydown", { key: "+" });
  assert.equal(e.lightbox.state, "zoomed");
  assert.equal(e.lightbox.lastEdge, "zoom");
  e.dialog.dispatch("keydown", { key: "0" });
  e.advance(200);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.lightbox.lastEdge, "fit");

  // Dismiss from viewing enters closing; inputs during closing are ignored
  e.dialog.dispatch("cancel");
  assert.equal(e.lightbox.state, "closing");
  assert.equal(e.lightbox.lastEdge, "dismiss");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.dialog.dispatch("keydown", { key: "+" });
  e.stage.dispatch("pointerdown", { pointerId: 1, button: 0, clientX: 600, clientY: 400, target: e.currentFrame() });
  assert.equal(e.lightbox.state, "closing");
  e.advance(420);
  assert.equal(e.lightbox.state, "closed");
  assert.equal(e.lightbox.lastEdge, "finish");

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
      e.dialog.dispatch("keydown", { key: "ArrowRight" });
      e.advance(16);
    }
  }
});

test("snap track places 3 non-overlapping horizontal snap areas and disables snap when zoomed", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  assert.equal(e.track.classList.contains("free"), false);
  const snaps = e.trackSpace.querySelectorAll(".snap");
  assert.equal(snaps.length, 3);
  assert.equal(parseFloat(snaps[0].style.left), 0);
  assert.equal(parseFloat(snaps[0].style.width), 600);
  assert.equal(parseFloat(snaps[1].style.left), 600);
  assert.equal(parseFloat(snaps[1].style.width), 600);
  assert.equal(parseFloat(snaps[2].style.left), 1200);
  assert.equal(parseFloat(snaps[1].style.top), 0);

  e.dialog.dispatch("keydown", { key: "+" });
  assert.equal(e.track.classList.contains("free"), true);
  assert.equal(snaps[0].hidden, true);
});

test("math atoms: cursor pull anchor (zero reflow), scaled linear dismiss, minMs floor, and reduced motion", () => {
  const e = createSimulator({ w: 1000, h: 800 });
  e.open(0);
  e.advance(32);
  const startT = e.track.scrollTop;
  e.stage.dispatch("wheel", { deltaX: 0, deltaY: -8, deltaMode: 0, clientX: 850, clientY: 650, cancelable: false });
  e.track.scrollTop = Math.round(startT * 0.4);
  e.track.dispatch("scroll");
  const { tx, ty, sx } = parseTransform(e.currentFrame().style.transform);
  const bw = parseFloat(e.currentFrame().style.width), bh = parseFloat(e.currentFrame().style.height);
  const cx = tx + bw * sx / 2, cy = ty + bh * sx / 2;
  assert.ok(cx > 600 && cy > 450, "Pull shrinks toward cursor anchor");

  // Cursor pull remains zero-reflow during 60fps pull frames
  const hot = e.measureHotPath(() => {
    for (let i = 1; i <= 100; i++) {
      e.track.scrollTop = Math.max(10, startT - i * 2);
      e.track.dispatch("scroll");
    }
  });
  assert.equal(hot.forcedReflows, 0);
  assert.equal(hot.layoutReads, 0);
  assert.equal(hot.layoutWrites, 0);

  // Scaled linear dismiss from 50% size (~175ms) finishes cleanly by 240ms
  const lin = createSimulator();
  lin.open(0);
  lin.advance(32);
  const ps = lin.track.scrollTop;
  lin.track.scrollTop = Math.round(ps * (1 - 0.718));
  lin.track.dispatch("scroll");
  lin.track.dispatch("scrollend");
  lin.advance(240);
  assert.equal(lin.dialog.open, false, "Linear 50% size dismiss finishes by 240ms");

  // Min-size dismiss honors 70ms duration floor while holding open until release
  const floor = createSimulator();
  floor.open(0);
  floor.advance(32);
  floor.track.scrollTop = 0;
  floor.track.dispatch("scroll");
  assert.equal(floor.lightbox.state, "pulling", "Holds at min size while fingers stay down");
  floor.track.dispatch("scrollend");
  assert.equal(floor.lightbox.state, "closing", "Dismisses on release from min size");
  floor.advance(48);
  assert.equal(floor.dialog.open, true, "Honors MIN_MS=70ms floor");
  floor.advance(80);
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

test("double-click / double-tap toggles 2x zoom centered on tap point with graceful edge clamping and no double-toggle", () => {
  // 1) Landscape 3:2 photo (1200x800 in 1200x800 viewport -> 2x is 2400x1600, limitX=600, limitY=400)
  const e = createSimulator({ w: 1200, h: 800, tileDims: i => i === 0 ? [1800, 1200] : [1200, 1800] });
  e.open(0);
  e.advance(32);

  // Double-click off-center detail at (420, 320) -> pt = (-180, -80); also dispatch browser dblclick right after pointerup #2
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 420, clientY: 320, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 420, clientY: 320 });
  e.advance(90);
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 420, clientY: 320, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 420, clientY: 320 });
  e.stage.dispatch("dblclick", { clientX: 420, clientY: 320 }); // must NOT double-toggle back to 1x!
  e.advance(380);

  assert.equal(e.lightbox.state, "zoomed", "Double-click zoomed in to 2x and did not double-toggle");
  assert.equal(e.map.hidden, false);
  const r1 = e.currentFrame().getBoundingClientRect();
  assert.ok(Math.abs(r1.width - 2400) < 1 && Math.abs(r1.height - 1600) < 1, `Zoomed to exact 2x (${r1.width}x${r1.height})`);
  // Tapped point (-180, -80) moves to viewport center: left = (1200-2400)/2 + 360 = -240, top = (800-1600)/2 + 160 = -240
  assert.ok(Math.abs(r1.left - -240) < 1.5, `Tapped X centered cleanly (left=${r1.left})`);
  assert.ok(Math.abs(r1.top - -240) < 1.5, `Tapped Y centered cleanly (top=${r1.top})`);

  // Double-click again while zoomed -> returns cleanly to 1x viewing
  e.advance(400);
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 600, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 600, clientY: 400 });
  e.advance(90);
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 600, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 600, clientY: 400 });
  e.stage.dispatch("dblclick", { clientX: 600, clientY: 400 });
  e.advance(380);
  assert.equal(e.lightbox.state, "viewing");
  assert.ok(Math.abs(e.currentFrame().getBoundingClientRect().width - 1200) < 1);

  // Double-click near top-left corner (60, 40) -> clamped gracefully flush with viewport edge (no void!)
  e.advance(400);
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 60, clientY: 40, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 60, clientY: 40 });
  e.advance(90);
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 60, clientY: 40, target: e.currentFrame() });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 60, clientY: 40 });
  e.advance(380);
  const rEdge = e.currentFrame().getBoundingClientRect();
  assert.equal(e.lightbox.state, "zoomed");
  assert.ok(Math.abs(rEdge.left - 0) < 1.5 && Math.abs(rEdge.top - 0) < 1.5, `Corner double-click clamped flush to edge (${rEdge.left}, ${rEdge.top})`);

  // 2) Portrait 2:3 photo (533.3x800 -> at 2x is 1066.7x1600, limitX=0, limitY=400)
  const p = createSimulator({ w: 1200, h: 800, tileDims: () => [1200, 1800] });
  p.open(0);
  p.advance(32);
  p.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "touch", clientX: 580, clientY: 100, target: p.currentFrame() });
  p.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "touch", clientX: 580, clientY: 100 });
  p.advance(90);
  p.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "touch", clientX: 580, clientY: 100, target: p.currentFrame() });
  p.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "touch", clientX: 580, clientY: 100 });
  p.advance(380);
  const rp = p.currentFrame().getBoundingClientRect();
  assert.equal(p.lightbox.state, "zoomed");
  assert.ok(Math.abs(rp.left - (1200 - rp.width) / 2) < 1.5, `Portrait stays horizontally centered when 2x fits width (left=${rp.left})`);
  assert.ok(Math.abs(rp.top - 0) < 1.5, `Portrait top edge clamped flush (top=${rp.top})`);
});

test("mobile touch-only zoomed pan momentum with edge rubber-banding (desktop mouse stops cleanly without momentum or overscroll)", () => {
  // Desktop mouse: zero momentum and zero overscroll past edges
  const desk = createSimulator({ w: 1200, h: 800, tileDims: () => [1800, 1200] });
  desk.open(0);
  desk.advance(32);
  desk.dialog.dispatch("keydown", { key: "+" }); // 1.5x
  desk.dialog.dispatch("keydown", { key: "+" }); // 2.25x -> 2700x1800, limitX=750
  desk.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 600, clientY: 400, target: desk.currentFrame() });
  desk.stepFrame(16);
  desk.pointerEvent("pointermove", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 720, clientY: 400 });
  desk.stepFrame(16);
  desk.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 720, clientY: 400 });
  const deskAtRelease = desk.currentFrame().getBoundingClientRect().left;
  desk.advance(400);
  assert.ok(Math.abs(desk.currentFrame().getBoundingClientRect().left - deskAtRelease) < 0.5, "Desktop mouse drag has zero post-release momentum");

  // Desktop mouse hard drag past edge stays strictly clamped (left <= 0)
  desk.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 100, clientY: 400, target: desk.currentFrame() });
  desk.stepFrame(16);
  desk.pointerEvent("pointermove", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 1150, clientY: 400 });
  assert.ok(desk.currentFrame().getBoundingClientRect().left <= 0.5, "Desktop mouse drag never rubber-bands past edge");
  desk.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "mouse", clientX: 1150, clientY: 400 });

  // Mobile touch: interior fling coasts smoothly with momentum
  const mob = createSimulator({ w: 1200, h: 800, tileDims: () => [1800, 1200] });
  mob.open(0);
  mob.advance(32);
  mob.dialog.dispatch("keydown", { key: "+" });
  mob.dialog.dispatch("keydown", { key: "+" }); // 2.25x -> limitX=750, starts centered (left = -750)
  mob.pointerEvent("pointerdown", { pointerId: 1, button: 0, pointerType: "touch", clientX: 500, clientY: 400, target: mob.currentFrame() });
  mob.stepFrame(16);
  mob.pointerEvent("pointermove", { pointerId: 1, button: 0, pointerType: "touch", clientX: 560, clientY: 400 });
  mob.stepFrame(16);
  mob.pointerEvent("pointermove", { pointerId: 1, button: 0, pointerType: "touch", clientX: 620, clientY: 400 });
  mob.pointerEvent("pointerup", { pointerId: 1, button: 0, pointerType: "touch", clientX: 620, clientY: 400 });
  const mobAtRelease = mob.currentFrame().getBoundingClientRect().left;
  mob.advance(800);
  const mobFinal = mob.currentFrame().getBoundingClientRect().left;
  assert.ok(mobFinal - mobAtRelease > 100, `Mobile touch fling coasted with momentum (${mobAtRelease.toFixed(1)} -> ${mobFinal.toFixed(1)})`);
  assert.ok(mobFinal <= 0.5, "Settled cleanly inside photo bounds");

  // Mobile touch hard fling into left edge rubber-bands past edge then settles cleanly back to left=0 without oscillation
  mob.startRecording();
  mob.pointerEvent("pointerdown", { pointerId: 2, button: 0, pointerType: "touch", clientX: 200, clientY: 400, target: mob.currentFrame() });
  for (let i = 1; i <= 5; i++) {
    mob.stepFrame(16);
    mob.pointerEvent("pointermove", { pointerId: 2, button: 0, pointerType: "touch", clientX: 200 + i * 160, clientY: 400 });
  }
  const overDuringDrag = mob.currentFrame().getBoundingClientRect().left;
  assert.ok(overDuringDrag > 5, `Mobile touch drag rubber-banded past edge (left=${overDuringDrag.toFixed(1)}px)`);
  mob.pointerEvent("pointerup", { pointerId: 2, button: 0, pointerType: "touch", clientX: 1000, clientY: 400 });
  mob.advance(900);
  const rubberLog = mob.stopRecording();
  const peakLeft = Math.max(...rubberLog.map(f => f.rect.left));
  assert.ok(peakLeft > overDuringDrag, `Fling coasted slightly deeper into rubber band (${overDuringDrag.toFixed(1)} -> ${peakLeft.toFixed(1)}px)`);
  const endLeft = mob.currentFrame().getBoundingClientRect().left;
  assert.ok(Math.abs(endLeft - 0) < 0.5, `Rubber-band settled back to exact edge (left=${endLeft.toFixed(2)})`);
  // Verify no oscillation past edge into interior after bouncing back
  const peakIdx = rubberLog.findIndex(f => f.rect.left === peakLeft);
  for (let i = peakIdx + 1; i < rubberLog.length; i++) {
    assert.ok(rubberLog[i].rect.left >= -0.5, `Rubber-band return never bounced back past edge into interior (left=${rubberLog[i].rect.left})`);
  }
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

test("mobile lockup recovery: dropped pointerup, ghost touch pointers, throwing capture, near-1x zoom, and cancelled 2nd finger", () => {
  // 1) Dropped pointerup on 2nd finger after pinching lower recovers via touchend zero-finger watchdog and dismisses
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    e.pointerEvent("pointerdown", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 60, clientY: 426, target: frame });
    e.pointerEvent("pointerdown", { pointerId: 2, pointerType: "touch", isPrimary: false, button: 0, clientX: 333, clientY: 426, target: frame });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    e.pointerEvent("pointermove", { pointerId: 2, pointerType: "touch", isPrimary: false, button: 0, clientX: 228, clientY: 426 });
    assert.ok(e.lightbox.telemetry.scale < 0.78, "Pinched below dismiss threshold");
    // Only finger 1 gets pointerup; finger 2 drops pointerup and only OS touchend (0 touches) fires
    e.pointerEvent("pointerup", { pointerId: 1, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    e.win.dispatch("touchend", { touches: [] });
    e.advance(80);
    assert.equal(e.lightbox.state, "closing", "Zero-touch watchdog flushes ghost pointer and dismisses");
    e.advance(420);
    assert.equal(e.dialog.open, false);
  }

  // 2) Dropped pointerup with NO touchend recovers on next primary touch so 1-finger swipe paginates instead of zooming
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    // Ghost pointer stranded without pointerup or touchend
    e.pointerEvent("pointerdown", { pointerId: 10, pointerType: "touch", isPrimary: true, button: 0, clientX: 200, clientY: 426, target: frame });
    e.stepFrame(16);
    // Next real single-finger swipe left with isPrimary: true must purge ghost and change photo
    e.pointerEvent("pointerdown", { pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, clientX: 340, clientY: 426, target: frame });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, clientX: 40, clientY: 426 });
    assert.equal(e.lightbox.state, "paging", "Single-finger swipe enters paging instead of ghost pinch-zoom");
    assert.equal(e.lightbox.telemetry.scale, 1);
    e.pointerEvent("pointerup", { pointerId: 11, pointerType: "touch", isPrimary: true, button: 0, clientX: 40, clientY: 426 });
    e.advance(420);
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1", "Photo changes cleanly after ghost purge");
  }

  // 3) Worst-case WebKit bug: dropped pointerup AND next single touch arrives with isPrimary: false -> touchstart reconciles
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    e.pointerEvent("pointerdown", { pointerId: 20, pointerType: "touch", isPrimary: true, button: 0, clientX: 200, clientY: 426, target: frame });
    e.advance(100);
    e.pointerEvent("pointerdown", { pointerId: 21, pointerType: "touch", isPrimary: false, button: 0, clientX: 340, clientY: 426, target: frame });
    e.win.dispatch("touchstart", { touches: [{}] });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 21, pointerType: "touch", isPrimary: false, button: 0, clientX: 40, clientY: 426 });
    assert.equal(e.lightbox.state, "paging", "touchstart live=1 trims ghost even when isPrimary is false");
    e.pointerEvent("pointerup", { pointerId: 21, pointerType: "touch", isPrimary: false, button: 0, clientX: 40, clientY: 426 });
    e.advance(420);
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");
  }

  // 4) Dropped pointerup on 2nd finger while 1st finger stays down recovers via touchend(live=1), then lifting 1st dismisses
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    e.pointerEvent("pointerdown", { pointerId: 30, pointerType: "touch", isPrimary: true, button: 0, clientX: 60, clientY: 426, target: frame });
    e.pointerEvent("pointerdown", { pointerId: 31, pointerType: "touch", isPrimary: false, button: 0, clientX: 333, clientY: 426, target: frame });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 30, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    e.pointerEvent("pointermove", { pointerId: 31, pointerType: "touch", isPrimary: false, button: 0, clientX: 228, clientY: 426 });
    // Finger 31 drops pointerup; finger 30 keeps moving slightly, OS reports touches.length === 1
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 30, pointerType: "touch", isPrimary: true, button: 0, clientX: 166, clientY: 426 });
    e.win.dispatch("touchend", { touches: [{}] });
    e.advance(80);
    // Lifting remaining finger 30 must now reach size===0 and dismiss
    e.pointerEvent("pointerup", { pointerId: 30, pointerType: "touch", isPrimary: true, button: 0, clientX: 166, clientY: 426 });
    assert.equal(e.lightbox.state, "closing", "Dismisses once remaining live finger lifts");
    e.advance(420);
    assert.equal(e.dialog.open, false);
  }

  // 5) Throwing setPointerCapture + off-stage window pointerup still dismisses immediately
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.stage.setPointerCapture = () => { throw new Error("NotFoundError"); };
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    e.pointerEvent("pointerdown", { pointerId: 40, pointerType: "touch", isPrimary: true, button: 0, clientX: 60, clientY: 426, target: frame });
    e.pointerEvent("pointerdown", { pointerId: 41, pointerType: "touch", isPrimary: false, button: 0, clientX: 333, clientY: 426, target: frame });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 40, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    e.pointerEvent("pointermove", { pointerId: 41, pointerType: "touch", isPrimary: false, button: 0, clientX: 228, clientY: 426 });
    e.pointerEvent("pointerup", { pointerId: 40, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    e.win.dispatch("pointerup", { pointerId: 41, pointerType: "touch", isPrimary: false, button: 0, clientX: 228, clientY: 426 });
    assert.equal(e.lightbox.state, "closing");
    e.advance(420);
    assert.equal(e.dialog.open, false);
  }

  // 6) Zombie near-1x zoom (1.03x) and exact-1x release from zoomed snap cleanly to viewing so swipe & pull work
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    e.pointerEvent("pointerdown", { pointerId: 50, pointerType: "touch", isPrimary: true, button: 0, clientX: 146, clientY: 426, target: frame });
    e.pointerEvent("pointerdown", { pointerId: 51, pointerType: "touch", isPrimary: false, button: 0, clientX: 246, clientY: 426, target: frame });
    e.stepFrame(16);
    // Zoom in to 2x, then back down to 1.03x
    e.pointerEvent("pointermove", { pointerId: 50, pointerType: "touch", isPrimary: true, button: 0, clientX: 96, clientY: 426 });
    e.pointerEvent("pointermove", { pointerId: 51, pointerType: "touch", isPrimary: false, button: 0, clientX: 296, clientY: 426 });
    assert.equal(e.lightbox.state, "zoomed");
    e.pointerEvent("pointermove", { pointerId: 50, pointerType: "touch", isPrimary: true, button: 0, clientX: 144.5, clientY: 426 });
    e.pointerEvent("pointermove", { pointerId: 51, pointerType: "touch", isPrimary: false, button: 0, clientX: 247.5, clientY: 426 });
    e.pointerEvent("pointerup", { pointerId: 50, pointerType: "touch", isPrimary: true, button: 0, clientX: 144.5, clientY: 426 });
    e.pointerEvent("pointerup", { pointerId: 51, pointerType: "touch", isPrimary: false, button: 0, clientX: 247.5, clientY: 426 });
    e.advance(250);
    assert.equal(e.lightbox.state, "viewing", "Near-1x zoom snaps back to viewing");
    assert.equal(e.lightbox.telemetry.scale, 1);
    // Swipe left immediately advances photo
    e.pointerEvent("pointerdown", { pointerId: 52, pointerType: "touch", isPrimary: true, button: 0, clientX: 340, clientY: 426, target: frame });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 52, pointerType: "touch", isPrimary: true, button: 0, clientX: 40, clientY: 426 });
    e.pointerEvent("pointerup", { pointerId: 52, pointerType: "touch", isPrimary: true, button: 0, clientX: 40, clientY: 426 });
    e.advance(420);
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");
  }

  // 7) Cancelled 2nd finger, lostpointercapture, and window blur never block dismiss or trap pointers
  {
    const e = createSimulator({ w: 393, h: 852 });
    e.open(0);
    e.advance(32);
    const frame = e.currentFrame();
    e.pointerEvent("pointerdown", { pointerId: 60, pointerType: "touch", isPrimary: true, button: 0, clientX: 60, clientY: 426, target: frame });
    e.pointerEvent("pointerdown", { pointerId: 61, pointerType: "touch", isPrimary: false, button: 0, clientX: 333, clientY: 426, target: frame });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 60, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    e.pointerEvent("pointermove", { pointerId: 61, pointerType: "touch", isPrimary: false, button: 0, clientX: 228, clientY: 426 });
    // 2nd finger is cancelled, 1st finger releases normally via lostpointercapture -> still dismisses
    e.pointerEvent("pointercancel", { pointerId: 61, pointerType: "touch", isPrimary: false, button: 0, clientX: 228, clientY: 426 });
    e.stage.dispatch("lostpointercapture", { pointerId: 60, pointerType: "touch", isPrimary: true, button: 0, clientX: 165, clientY: 426 });
    assert.equal(e.lightbox.state, "closing");
    e.advance(420);
    assert.equal(e.dialog.open, false);

    // Reopen, strand a pointer, blur window -> flushes cleanly so next drag works
    e.open(0);
    e.advance(32);
    e.pointerEvent("pointerdown", { pointerId: 70, pointerType: "touch", isPrimary: true, button: 0, clientX: 200, clientY: 426, target: e.currentFrame() });
    e.win.dispatch("blur");
    e.advance(32);
    e.pointerEvent("pointerdown", { pointerId: 71, pointerType: "touch", isPrimary: false, button: 0, clientX: 340, clientY: 426, target: e.currentFrame() });
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 71, pointerType: "touch", isPrimary: false, button: 0, clientX: 40, clientY: 426 });
    assert.equal(e.lightbox.state, "paging", "Window blur flushed stale pointer");
  }
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

import test from "node:test";
import assert from "node:assert/strict";
import {
  createSimulator,
  assertNoBlankFrames,
  assertNoStateOscillation,
  assertMaxAutonomousJump,
  assertFrame0Continuity,
  assertScrollYConstant,
} from "./simulator.mjs";

// Helper: flick horizontally into neighbor (dir: 1 -> Photo 1, -1 -> prev photo) to `frac` of padX (e.g. 0.72)
function setupMidFlick(e, { dir = 1, frac = 0.75, release = true } = {}) {
  const padX = e.track.scrollLeft;
  const total = Math.round(padX * frac);
  const steps = 6;
  const stepDx = Math.round(total / steps);
  for (let i = 0; i < steps; i++) {
    e.wheelTick(dir * stepDx, 0, { cancelable: i === 0 });
    e.stepFrame(16);
  }
  if (release) {
    e.releaseTrackpad({ snapFrames: 14 });
    e.stepFrame(16); // compositor snap in flight toward neighbor
  }
  return { padX };
}

// =============================================================================
// Y1: Mid-flick horizontal pagination (> 50% across toward n+1 or n-1) x X
// =============================================================================

test("Y1 x X1: swiping down while flicked > 50% to next or prev photo keeps the new dominant photo (never reverts to previous)", () => {
  for (const [dir, expectedAlt] of [[1, "Photo 1"], [-1, "Photo 9"]]) {
    for (const cancelable of [true, false]) {
      const e = createSimulator({ w: 1200, h: 800, tileCount: 10, scrollY: 500 });
      e.open(0);
      e.advance(32);
      setupMidFlick(e, { dir, frac: 0.75, release: cancelable });
      assert.equal(e.lightbox.state, "paging");

      e.startRecording();
      // User gently swipes straight down (~60px total -> scale ~0.86 > close@) while Photo 1 (or Photo 9) fills 75% of the viewport
      for (let i = 0; i < 5; i++) {
        e.wheelTick(0, -12, { cancelable: cancelable && i === 0 });
        e.stepFrame(16);
      }

      assert.equal(e.lightbox.state, "pulling", `dir=${dir} cancelable=${cancelable}: entered pulling`);
      assert.equal(
        e.currentFrame().firstElementChild.alt, expectedAlt,
        `dir=${dir} cancelable=${cancelable}: primary image stayed ${expectedAlt} instead of reverting to Photo 0`
      );
      assert.ok(e.lightbox.telemetry.scale < 0.95, "Dominant photo shrank visibly");

      // Releasing gently bounces back to the NEW dominant photo (never Photo 0 or double-advancing to Photo 2!)
      e.track.dispatch("scrollend");
      e.advance(300);
      const log = e.stopRecording();
      assertNoBlankFrames(log);
      assertNoStateOscillation(log);
      assertScrollYConstant(log, 500);
      assert.equal(e.lightbox.state, "viewing");
      assert.equal(e.currentFrame().firstElementChild.alt, expectedAlt, "Bounce landed cleanly on dominant photo");
      assert.equal(e.lightbox.telemetry.scale, 1);
      assert.equal(e.lightbox.telemetry.page, 0);
    }
  }
});

test("Y1 x X1 (deep pull + cancel back up): reversing a mid-flick pull back to full size never double-advances or jumps slides", () => {
  const e = createSimulator({ w: 1200, h: 800, tileCount: 10, scrollY: 500 });
  e.open(0);
  e.advance(32);
  setupMidFlick(e, { dir: 1, frac: 0.85, release: false });

  // Single-stroke L-drag down (cancelable: false) promotes Photo 1 without resetting track.scrollLeft
  for (let i = 0; i < 6; i++) { e.wheelTick(0, -18, { cancelable: false }); e.stepFrame(16); }
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(e.lightbox.state, "pulling");

  // User changes mind and drags all the way back up to 100% scale, then releases
  for (let i = 0; i < 8; i++) { e.wheelTick(0, 18, { cancelable: false }); e.stepFrame(16); }
  e.track.dispatch("scrollend");
  e.advance(300);
  assert.equal(e.dialog.open, true);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1", "Never double-advanced to Photo 2 or reverted to Photo 0");
  assert.equal(e.lightbox.telemetry.page, 0);
  assert.equal(e.lightbox.telemetry.scale, 1);
});

test("Y1 x X1 (dismiss): deep mid-flick pull-down dismisses the dominant photo cleanly", () => {
  const e = createSimulator({ w: 1200, h: 800, tileCount: 10, scrollY: 500 });
  e.open(0);
  e.advance(32);
  setupMidFlick(e, { dir: 1, frac: 0.78, release: true });

  for (let i = 0; i < 8; i++) { e.wheelTick(0, -28, { cancelable: i === 0 }); e.stepFrame(16); }
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(e.lightbox.state, "pulling");

  const rectBefore = e.currentFrame().getBoundingClientRect();
  e.track.dispatch("scrollend");
  assert.equal(e.lightbox.state, "closing");
  assertFrame0Continuity(rectBefore, e.currentFrame().getBoundingClientRect(), 1.0);
  e.advance(420);
  assert.equal(e.dialog.open, false);
  assert.equal(e.win.scrollY, 500);
});

test("Y1 x X1 (continuity & neighbor glide): swiping down mid-pagination has zero vertical pop and glides exiting image off smoothly", () => {
  for (const cancelable of [false, true]) {
    const e = createSimulator({ w: 1200, h: 800, tileCount: 10, scrollY: 500 });
    e.open(0);
    e.advance(32);
    // Swipe right ~65% across WITH realistic diagonal Y drift (-4px/tick) during horizontal pagination
    for (let i = 0; i < 6; i++) {
      e.wheelTick(65, -4, { cancelable: i === 0 });
      e.stepFrame(8);
    }
    if (cancelable) {
      e.releaseTrackpad({ snapFrames: 20 });
      e.stepFrame(8);
    }
    assert.equal(e.lightbox.state, "paging");
    const slideNextBefore = e.frames.find(f => f.firstElementChild?.alt === "Photo 1");
    const slidePrevBefore = e.frames.find(f => f.firstElementChild?.alt === "Photo 0");
    assert.ok(slideNextBefore && slidePrevBefore);
    const nextRectBefore = slideNextBefore.getBoundingClientRect();
    const prevRectBefore = slidePrevBefore.getBoundingClientRect();
    assert.ok(prevRectBefore.right > 100, `cancelable=${cancelable}: Photo 0 still visible on left before pull`);

    // Start 120Hz downward swipe (-12px/8ms)
    let switched = false;
    let firstPullNextRect = null, firstPullPrevRect = null, firstPullPrevOpacity = null;
    for (let i = 0; i < 8; i++) {
      e.wheelTick(0, -12, { cancelable: cancelable && i === 0 });
      if (!switched && (e.lightbox.state === "pulling" || e.currentFrame().firstElementChild?.alt === "Photo 1")) {
        switched = true;
        const curNext = e.frames.find(f => f.firstElementChild?.alt === "Photo 1");
        const curPrev = e.frames.find(f => f.firstElementChild?.alt === "Photo 0");
        firstPullNextRect = curNext.getBoundingClientRect();
        firstPullPrevRect = curPrev.getBoundingClientRect();
        firstPullPrevOpacity = curPrev.style.opacity === "" ? 1 : parseFloat(curPrev.style.opacity);
      }
      e.stepFrame(8);
    }
    assert.ok(switched, `cancelable=${cancelable}: transitioned cleanly to Photo 1 pull`);
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

    // Frame-0 continuity on handoff: no vertical pop from stale Y drift and no horizontal teleport!
    const dTop = Math.abs(firstPullNextRect.top - nextRectBefore.top);
    const dLeft = Math.abs(firstPullNextRect.left - nextRectBefore.left);
    assert.ok(dTop < 25, `cancelable=${cancelable}: no jarring vertical jump on handoff (dTop=${dTop.toFixed(1)}px)`);
    assert.ok(dLeft < 40, `cancelable=${cancelable}: no horizontal teleport on handoff (dLeft=${dLeft.toFixed(1)}px)`);

    // Exiting Photo 0 must NOT disappear in 1 frame on handoff
    assert.ok(firstPullPrevRect.right > 50, `cancelable=${cancelable}: Photo 0 stayed on screen on frame 0 (right=${firstPullPrevRect.right.toFixed(1)})`);
    assert.ok(firstPullPrevOpacity >= 0.7, `cancelable=${cancelable}: Photo 0 stayed visible on frame 0 (opacity=${firstPullPrevOpacity})`);

    // Over the next 260ms, page glides smoothly to 0 even with fingers held still
    e.advance(260);
    assert.equal(e.lightbox.telemetry.page, 0, `cancelable=${cancelable}: horizontal glide finished cleanly to page=0`);
  }
});

test("Y1/Y2 x X1 (cancel & bounce-back): swipe right -> down -> back up or shallow bounce NEVER lands between two images", () => {
  // Subcase A: swipe right 40% (fingers down) -> pull down -> push back UP to full screen (fingers still down)
  const holdUp = createSimulator({ w: 1200, h: 800, tileCount: 10, scrollY: 500 });
  holdUp.open(0);
  holdUp.advance(32);
  setupMidFlick(holdUp, { dir: 1, frac: 0.40, release: false });
  assert.equal(holdUp.lightbox.state, "paging");
  // Pull down past threshold, let page glide finish
  for (let i = 0; i < 10; i++) { holdUp.wheelTick(0, -18, { cancelable: false }); holdUp.stepFrame(16); }
  holdUp.advance(240);
  assert.equal(holdUp.lightbox.state, "pulling");
  assert.equal(holdUp.lightbox.telemetry.page, 0);
  // Push fingers all the way back UP to full screen without lifting!
  for (let i = 0; i < 14; i++) {
    holdUp.wheelTick(0, 18, { cancelable: false });
    holdUp.stepFrame(16);
    assert.equal(holdUp.lightbox.telemetry.page, 0, `push-back-up tick ${i}: never jumped back between two images (page=${holdUp.lightbox.telemetry.page})`);
  }
  assert.equal(holdUp.lightbox.telemetry.scale, 1);
  // Now lift fingers -> Blink horizontal snap runs from off-snap sl; must NEVER jump between two images!
  holdUp.startRecording();
  holdUp.releaseTrackpad({ snapFrames: 12 });
  holdUp.advance(400);
  const upLog = holdUp.stopRecording();
  for (const f of upLog) {
    assert.ok(Math.abs(f.page) < 2, `post-push-up release jumped between images (page=${f.page.toFixed(1)} at t=${f.t})`);
  }
  assert.equal(holdUp.lightbox.state, "viewing");
  assert.equal(holdUp.currentFrame().firstElementChild.alt, "Photo 0");
  assert.equal(holdUp.lightbox.telemetry.scale, 1);

  // Subcase B: swipe right 40% OR 72% (fingers down) -> shallow pull -> lift fingers (bounce back while sl snaps!)
  for (const [frac, expectedAlt] of [[0.40, "Photo 0"], [0.72, "Photo 1"]]) {
    const bounce = createSimulator({ w: 1200, h: 800, tileCount: 10, scrollY: 500 });
    bounce.open(0);
    bounce.advance(32);
    setupMidFlick(bounce, { dir: 1, frac, release: false });
    for (let i = 0; i < 5; i++) { bounce.wheelTick(0, -14, { cancelable: false }); bounce.stepFrame(16); }
    bounce.advance(240); // glide finished, held at shallow scale ~0.88
    assert.equal(bounce.lightbox.state, "pulling");
    assert.equal(bounce.lightbox.telemetry.page, 0);

    // Lift fingers: Blink runs horizontal snap on off-snap sl while bounce animates back to scale=1!
    bounce.startRecording();
    bounce.releaseTrackpad({ snapFrames: 14 });
    bounce.advance(500);
    const bLog = bounce.stopRecording();
    assertNoBlankFrames(bLog);
    for (const f of bLog) {
      assert.ok(Math.abs(f.page) < 2, `frac=${frac}: bounce-back jumped between two images (page=${f.page.toFixed(1)} at t=${f.t})`);
    }
    assert.equal(bounce.lightbox.state, "viewing");
    assert.equal(bounce.currentFrame().firstElementChild.alt, expectedAlt);
    assert.equal(bounce.lightbox.telemetry.scale, 1);
    assert.equal(bounce.lightbox.telemetry.page, 0);
  }
});

test("Y1 x X3: pinching in or out while mid-flick > 50% zooms/shrinks the dominant photo (never reverts to previous)", () => {
  // Pinch IN while 75% into Photo 1 -> zooms Photo 1
  const zIn = createSimulator({ w: 1200, h: 800 });
  zIn.open(0);
  zIn.advance(32);
  setupMidFlick(zIn, { dir: 1, frac: 0.75, release: true });
  zIn.wheelTick(0, -25, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  assert.equal(zIn.lightbox.state, "zoomed");
  assert.equal(zIn.currentFrame().firstElementChild.alt, "Photo 1", "Pinch-in mid-flick keeps Photo 1");
  assert.equal(zIn.lightbox.telemetry.page, 0);

  // Pinch OUT while 75% into Photo 1 -> shrinks Photo 1 cleanly with page=0
  const zOut = createSimulator({ w: 1200, h: 800 });
  zOut.open(0);
  zOut.advance(32);
  setupMidFlick(zOut, { dir: 1, frac: 0.75, release: true });
  zOut.wheelTick(0, 25, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  assert.equal(zOut.lightbox.state, "pulling");
  assert.equal(zOut.currentFrame().firstElementChild.alt, "Photo 1", "Pinch-out mid-flick shrinks Photo 1");
  assert.equal(zOut.lightbox.telemetry.page, 0);

  // Safari gesturestart mid-flick > 50% keeps Photo 1
  const saf = createSimulator({ w: 1200, h: 800 });
  saf.open(0);
  saf.advance(32);
  setupMidFlick(saf, { dir: 1, frac: 0.75, release: true });
  saf.stage.dispatch("gesturestart", { clientX: 600, clientY: 400, scale: 1 });
  saf.stage.dispatch("gesturechange", { clientX: 600, clientY: 400, scale: 1.5 });
  assert.equal(saf.lightbox.state, "zoomed");
  assert.equal(saf.currentFrame().firstElementChild.alt, "Photo 1");
});

test("Y1 x X4: 1-finger pointer drag down while mid-flick > 50% keeps and shrinks the dominant photo", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  // 1-finger swipe 75% across -> release -> grab mid-settle and drag down
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 1000, clientY: 400, target: e.currentFrame() });
  e.stepFrame(16);
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 400 }); // -900px = 75%
  e.stepFrame(16);
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 100, clientY: 400 });
  e.stepFrame(16);

  e.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 600, clientY: 200, target: e.currentFrame() });
  for (let i = 1; i <= 5; i++) {
    e.stepFrame(16);
    e.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 600, clientY: 200 + i * 20 });
  }
  assert.equal(e.lightbox.state, "pulling");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1", "Pointer drag down mid-flick keeps Photo 1");
  assert.ok(e.lightbox.telemetry.scale < 0.95);
});

test("Y1 x X6: pressing + or Escape while mid-flick > 50% acts on the dominant photo", () => {
  const z = createSimulator({ w: 1200, h: 800 });
  z.open(0);
  z.advance(32);
  setupMidFlick(z, { dir: 1, frac: 0.78, release: true });
  z.dialog.dispatch("keydown", { key: "+" });
  assert.equal(z.lightbox.state, "zoomed");
  assert.equal(z.currentFrame().firstElementChild.alt, "Photo 1", "+ mid-flick zooms dominant Photo 1");
  assert.equal(z.lightbox.telemetry.page, 0);

  const esc = createSimulator({ w: 1200, h: 800 });
  esc.open(0);
  esc.advance(32);
  setupMidFlick(esc, { dir: 1, frac: 0.78, release: true });
  esc.dialog.dispatch("cancel");
  assert.equal(esc.lightbox.state, "closing");
  assert.equal(esc.currentFrame().firstElementChild.alt, "Photo 1", "Escape mid-flick dismisses dominant Photo 1");
  esc.advance(420);
  assert.equal(esc.dialog.open, false);
});

// =============================================================================
// Y2: Mid-half-swipe (< 50% across) x X
// =============================================================================

test("Y2 x X1/X2/X3/X6: interrupting a < 50% half-swipe keeps Photo 0 cleanly across pull-down, reversal, pinch, and keys", () => {
  // Y2 x X1: swipe down while only 30% across -> stays on Photo 0 (still 70% of screen)
  const pull = createSimulator({ w: 1200, h: 800 });
  pull.open(0);
  pull.advance(32);
  setupMidFlick(pull, { dir: 1, frac: 0.30, release: true });
  for (let i = 0; i < 5; i++) { pull.wheelTick(0, -18, { cancelable: i === 0 }); pull.stepFrame(16); }
  assert.equal(pull.lightbox.state, "pulling");
  assert.equal(pull.currentFrame().firstElementChild.alt, "Photo 0", "< 50% mid-swipe pull stays on Photo 0");
  pull.track.dispatch("scrollend");
  pull.advance(300);
  assert.equal(pull.lightbox.state, "viewing");
  assert.equal(pull.currentFrame().firstElementChild.alt, "Photo 0");

  // Y2 x X2: reverse direction mid-half-swipe bounce -> smooth tracking into prev slide
  const rev = createSimulator({ w: 1200, h: 800, tileCount: 10 });
  rev.open(2);
  rev.advance(32);
  rev.startRecording();
  setupMidFlick(rev, { dir: 1, frac: 0.32, release: true });
  for (let i = 0; i < 12; i++) { rev.wheelTick(-55, 0, { cancelable: i === 0 }); rev.stepFrame(16); }
  rev.releaseTrackpad({ snapFrames: 12 });
  rev.advance(400);
  const log = rev.stopRecording();
  assertNoBlankFrames(log);
  assertNoStateOscillation(log);
  assert.equal(rev.currentFrame().firstElementChild.alt, "Photo 1");
  assert.equal(rev.lightbox.state, "viewing");

  // Y2 x X3: pinch-in while 30% across -> stays on Photo 0 cleanly
  const pinch = createSimulator({ w: 1200, h: 800 });
  pinch.open(0);
  pinch.advance(32);
  setupMidFlick(pinch, { dir: 1, frac: 0.30, release: true });
  pinch.wheelTick(0, -25, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  assert.equal(pinch.lightbox.state, "zoomed");
  assert.equal(pinch.currentFrame().firstElementChild.alt, "Photo 0");
  assert.equal(pinch.lightbox.telemetry.page, 0);
});

// =============================================================================
// Y4 & Y5: Mid-vertical pull-down / Mid-vertical bounce x X
// =============================================================================

test("Y4 x X3: pinching out or in while pulled down absorbs pull scale seamlessly with zero scale strobe", () => {
  // Pinch OUT while pulled down to ~0.72 scale -> scale must stay continuous (NOT jump 0.72 -> 0.99!)
  const pOut = createSimulator({ w: 1200, h: 800 });
  pOut.open(0);
  pOut.advance(32);
  for (let i = 0; i < 6; i++) { pOut.wheelTick(0, -22, { cancelable: i === 0 }); pOut.stepFrame(16); }
  const scaleBefore = pOut.lightbox.telemetry.scale;
  assert.ok(scaleBefore < 0.85, `Pulled down to ${scaleBefore.toFixed(3)}`);

  pOut.wheelTick(0, 5, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  const scaleAfter = pOut.lightbox.telemetry.scale;
  assert.ok(
    Math.abs(scaleAfter - scaleBefore) < 0.08 && scaleAfter <= scaleBefore,
    `Pinch-out from pull stayed continuous without strobe (${scaleBefore.toFixed(3)} -> ${scaleAfter.toFixed(3)})`
  );

  // Safari gesturestart/change from pulled-down state also absorbs pull scale smoothly
  const saf = createSimulator({ w: 1200, h: 800 });
  saf.open(0);
  saf.advance(32);
  for (let i = 0; i < 6; i++) { saf.wheelTick(0, -22, { cancelable: i === 0 }); saf.stepFrame(16); }
  const safBefore = saf.lightbox.telemetry.scale;
  saf.stage.dispatch("gesturestart", { clientX: 600, clientY: 400, scale: 1 });
  saf.stage.dispatch("gesturechange", { clientX: 600, clientY: 400, scale: 0.95 });
  const safAfter = saf.lightbox.telemetry.scale;
  assert.ok(
    Math.abs(safAfter - safBefore * 0.95) < 0.04,
    `Safari pinch-out from pull absorbed pull scale (${safBefore.toFixed(3)} -> ${safAfter.toFixed(3)})`
  );

  // 2-finger touch pinch from pulled-down state absorbs pull scale smoothly
  const touch = createSimulator({ w: 1200, h: 800 });
  touch.open(0);
  touch.advance(32);
  for (let i = 0; i < 6; i++) { touch.wheelTick(0, -22, { cancelable: i === 0 }); touch.stepFrame(16); }
  const tBefore = touch.lightbox.telemetry.scale;
  touch.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 500, clientY: 400, target: touch.currentFrame() });
  touch.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 700, clientY: 400, target: touch.currentFrame() });
  touch.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 505, clientY: 400 });
  touch.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 695, clientY: 400 });
  const tAfter = touch.lightbox.telemetry.scale;
  assert.ok(
    Math.abs(tAfter - tBefore * 0.95) < 0.04,
    `2-finger pinch from pull absorbed pull scale (${tBefore.toFixed(3)} -> ${tAfter.toFixed(3)})`
  );
});

test("Y4 x X2/X6: deep pull blocks accidental horizontal pagination and Arrow keys, while small pull recovers to horizontal swipe", () => {
  // Deep pull (~0.70 scale) + horizontal wiggle stays in pulling (does not pop to 100% and paginate)
  const deep = createSimulator({ w: 1200, h: 800 });
  deep.open(0);
  deep.advance(32);
  for (let i = 0; i < 5; i++) { deep.wheelTick(0, -26, { cancelable: i === 0 }); deep.stepFrame(16); }
  assert.equal(deep.lightbox.state, "pulling");
  deep.wheelTick(120, 0, { cancelable: false });
  assert.equal(deep.lightbox.state, "pulling", "Deep pull ignores accidental horizontal wiggle");
  assert.ok(deep.lightbox.telemetry.scale < 0.9);
  deep.dialog.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(deep.lightbox.state, "pulling", "ArrowRight is ignored while pulling");
  assert.equal(deep.currentFrame().firstElementChild.alt, "Photo 0");

  // Tiny initial pull (< 30px rawPull) + strong horizontal swipe recovers cleanly into paging
  const tiny = createSimulator({ w: 1200, h: 800 });
  tiny.open(0);
  tiny.advance(32);
  tiny.wheelTick(0, -10, { cancelable: true });
  tiny.wheelTick(60, 0, { cancelable: false });
  assert.equal(tiny.lightbox.state, "paging", "Small pull recovers cleanly into horizontal swipe");
  assert.equal(tiny.lightbox.telemetry.scale, 1);
});

test("Y5 x X1/X2/X3: interrupting an in-flight vertical bounce animation with pull, swipe, or pinch behaves cleanly", () => {
  // Y5 x X1: pull down again mid-bounce
  const rePull = createSimulator({ w: 1200, h: 800 });
  rePull.open(0);
  rePull.advance(32);
  rePull.wheelTick(0, -50, { cancelable: true });
  rePull.track.dispatch("scrollend");
  rePull.stepFrame(16); // mid-bounce back to 1.0
  assert.equal(rePull.lightbox.state, "viewing");
  rePull.wheelTick(0, -120, { cancelable: true });
  assert.equal(rePull.lightbox.state, "pulling");
  assert.ok(rePull.lightbox.telemetry.scale < 0.8);

  // Y5 x X2: swipe horizontally mid-bounce
  const swipe = createSimulator({ w: 1200, h: 800 });
  swipe.open(0);
  swipe.advance(32);
  swipe.wheelTick(0, -45, { cancelable: true });
  swipe.track.dispatch("scrollend");
  swipe.stepFrame(16);
  for (let i = 0; i < 6; i++) { swipe.wheelTick(70, 0, { cancelable: i === 0 }); swipe.stepFrame(16); }
  assert.equal(swipe.lightbox.state, "paging");
  assert.equal(swipe.lightbox.telemetry.scale, 1);
});

// =============================================================================
// Y6: Mid-pinch (wheelPinching < 60ms, 60..140ms) x X
// =============================================================================

test("Y6 x X1/X2/X6: switching from pinch-out (zoom < 1) straight into scroll or keys never strands zoom < 1", () => {
  // Pinch OUT to ~0.88 (above dismissScale), then 75ms later (before 140ms pinchTimer!) start swiping
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  e.wheelTick(0, 14, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 }); // zoom ~0.87
  assert.equal(e.lightbox.state, "pulling");
  assert.ok(e.lightbox.telemetry.scale < 1 && e.lightbox.telemetry.scale > 0.78);

  e.advance(75); // > 60ms guard, < 140ms pinchTimer
  e.wheelTick(40, 0, { cancelable: true }); // non-ctrl wheel clears pinchTimer -> must finishPinch, not strand zoom < 1!
  e.advance(350);
  assert.equal(e.dialog.open, true);
  assert.equal(e.lightbox.state, "viewing", "Never stranded in pulling/zoom<1 when switching from pinch-out to wheel");
  assert.equal(e.lightbox.telemetry.scale, 1);

  // Pressing '0' mid-wheelPinch cancels pending pinchTimer cleanly
  const k = createSimulator({ w: 1200, h: 800 });
  k.open(0);
  k.advance(32);
  k.wheelTick(0, 40, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 }); // zoom ~0.67 (< close@)
  assert.equal(k.lightbox.state, "pulling");
  k.dialog.dispatch("keydown", { key: "0" }); // explicitly fit back to 1x BEFORE 140ms pinchTimer fires!
  k.advance(350);
  assert.equal(k.dialog.open, true, "Stale pinchTimer after pressing '0' must NOT dismiss the photo");
  assert.equal(k.lightbox.state, "viewing");
  assert.equal(k.lightbox.telemetry.scale, 1);
});

// =============================================================================
// Y7 & Y8 & Y9: Zoomed / Mid-fit tween / Mid-closing x X
// =============================================================================

test("Y7 x X1..X6: zoomed state blocks all pagination/pull-dismiss across wheel, pointer, and arrows, while pinch-out exits cleanly", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  e.dialog.dispatch("keydown", { key: "+" });
  assert.equal(e.lightbox.state, "zoomed");

  // Trackpad pan past edges + pointer drag past edges + arrows -> stays zoomed on Photo 0
  e.wheelTick(800, -800, { cancelable: true });
  e.track.dispatch("scrollend");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 900, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 50, clientY: 400 });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 50, clientY: 400 });
  e.advance(250);
  assert.equal(e.lightbox.state, "zoomed");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0");
  assert.equal(e.lightbox.telemetry.page, 0);

  // Continuous pinch-out from zoomed (1.5x -> 0.5x) crosses 1x cleanly into pulling -> dismisses on release
  for (let i = 0; i < 12; i++) {
    e.wheelTick(0, 10, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
    e.stepFrame(16);
  }
  assert.equal(e.lightbox.state, "pulling");
  e.advance(200); // pinchTimer fires finishPinch -> dismiss
  assert.equal(e.lightbox.state, "closing");
  e.advance(420);
  assert.equal(e.dialog.open, false);
});

test("Y8 x X1/X3/X6: interrupting an in-flight fit animation with pinch, Escape, or ResizeObserver stays consistent", () => {
  const e = createSimulator({ w: 1200, h: 800 });
  e.open(0);
  e.advance(32);
  e.dialog.dispatch("keydown", { key: "+" });
  e.dialog.dispatch("keydown", { key: "+" });
  e.dialog.dispatch("keydown", { key: "0" }); // starts fit tween from 2.25 -> 1
  e.stepFrame(16); // mid-fit tween (view.zoom still > 1)

  // Pinch in mid-fit resumes zooming cleanly without jumping back
  e.wheelTick(0, -15, { ctrlKey: true, cancelable: true, clientX: 600, clientY: 400 });
  assert.equal(e.lightbox.state, "zoomed");

  // ResizeObserver mid-fit tween keeps valid geometry
  e.dialog.dispatch("keydown", { key: "0" });
  e.stepFrame(16);
  e.triggerResize(960, 640);
  e.advance(300);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.lightbox.telemetry.scale, 1);

  // Escape mid-fit closes cleanly
  e.dialog.dispatch("keydown", { key: "+" });
  e.dialog.dispatch("keydown", { key: "0" });
  e.stepFrame(16);
  e.dialog.dispatch("cancel");
  assert.equal(e.lightbox.state, "closing");
  e.advance(420);
  assert.equal(e.dialog.open, false);
});

test("Y9 x X1..X7: every input during closing animation is ignored, scrollY stays locked, and immediate reopen starts clean", () => {
  const e = createSimulator({ w: 1200, h: 800, scrollY: 500 });
  e.open(0);
  e.advance(32);
  e.wheelTick(0, -150, { cancelable: true });
  e.track.dispatch("scrollend");
  assert.equal(e.lightbox.state, "closing");
  e.startRecording();

  // Blast every possible interrupting input during the closing animation
  e.wheelTick(200, 0, { cancelable: true });
  e.wheelTick(0, -200, { cancelable: true });
  e.wheelTick(0, -40, { ctrlKey: true, cancelable: true });
  e.stage.dispatch("gesturestart", { clientX: 600, clientY: 400, scale: 1 });
  e.stage.dispatch("gesturechange", { clientX: 600, clientY: 400, scale: 2 });
  e.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 600, clientY: 400, target: e.currentFrame() });
  e.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  e.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 300, clientY: 400 });
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  e.dialog.dispatch("keydown", { key: "+" });
  e.dialog.dispatch("keydown", { key: "0" });
  e.stage.dispatch("dblclick");
  e.triggerResize(1000, 700);
  assert.equal(e.lightbox.state, "closing", "No input may hijack closing state");

  e.advance(420);
  const log = e.stopRecording();
  assertScrollYConstant(log, 500);
  assert.equal(e.lightbox.state, "closed");
  assert.equal(e.dialog.open, false);

  // Immediate reopen starts cleanly at viewing, scale=1, page=0
  e.open(4);
  e.advance(32);
  assert.equal(e.lightbox.state, "viewing");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 4");
  assert.equal(e.lightbox.telemetry.scale, 1);
  assert.equal(e.lightbox.telemetry.page, 0);
});

test("multi-touch & pointer permutations: 2nd finger during horizontal/vertical drag, 1-finger lift after pinch, minimap interruption, and resize mid-flick", () => {
  // 1) Y1/Y3 x X5: 1-finger swipe > 50% across + 2nd finger touches down -> promotes Photo 1 and zooms Photo 1
  const pH = createSimulator({ w: 1200, h: 800 });
  pH.open(0);
  pH.advance(32);
  pH.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 1000, clientY: 400, target: pH.currentFrame() });
  pH.stepFrame(16);
  pH.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 150, clientY: 400 }); // 70% across to Photo 1
  pH.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 350, clientY: 400, target: pH.currentFrame() });
  pH.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 400 });
  pH.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 450, clientY: 400 });
  assert.equal(pH.currentFrame().firstElementChild.alt, "Photo 1", "2nd finger mid-swipe promotes dominant Photo 1");
  assert.equal(pH.lightbox.state, "zoomed");
  assert.equal(pH.lightbox.telemetry.page, 0);

  // 2) Y4 x X5: 1-finger pull-down + 2nd finger touches down -> absorbs pull scale without strobe
  const pV = createSimulator({ w: 1200, h: 800 });
  pV.open(0);
  pV.advance(32);
  pV.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 600, clientY: 150, target: pV.currentFrame() });
  pV.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 600, clientY: 360 });
  const pullBefore = pV.lightbox.telemetry.scale;
  assert.ok(pullBefore < 0.85);
  pV.pointerEvent("pointerdown", { pointerId: 2, button: 0, clientX: 800, clientY: 360, target: pV.currentFrame() });
  pV.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 605, clientY: 360 });
  pV.pointerEvent("pointermove", { pointerId: 2, button: 0, clientX: 795, clientY: 360 });
  const pinchAfter = pV.lightbox.telemetry.scale;
  assert.ok(Math.abs(pinchAfter - pullBefore * 0.95) < 0.04, `2nd finger mid-pull kept continuous scale (${pullBefore.toFixed(3)} -> ${pinchAfter.toFixed(3)})`);

  // 3) Y6 x X4: 2-finger pinch out (< 1x) -> lift 1 finger -> moving remaining finger never paginates
  pV.pointerEvent("pointerup", { pointerId: 2, button: 0, clientX: 795, clientY: 360 });
  pV.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 100, clientY: 360 });
  assert.equal(pV.lightbox.telemetry.page, 0, "Remaining 1 finger while pinched < 1 never paginates");
  pV.pointerEvent("pointerup", { pointerId: 1, button: 0, clientX: 100, clientY: 360 });
  pV.advance(420);

  // 4) Y7-map x X6: Escape mid-minimap drag closes cleanly without throwing
  const m = createSimulator({ w: 1200, h: 800 });
  m.open(0);
  m.advance(32);
  m.dialog.dispatch("keydown", { key: "+" });
  m.pointerEvent("pointerdown", { pointerId: 1, button: 0, clientX: 1100, clientY: 740, target: m.map });
  m.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: 1120, clientY: 750 });
  m.dialog.dispatch("cancel");
  assert.equal(m.lightbox.state, "closing");
  m.advance(420);
  assert.equal(m.dialog.open, false);

  // 5) Y1 x X7: ResizeObserver mid-flick keeps valid geometry and never crashes
  const rz = createSimulator({ w: 1200, h: 800 });
  rz.open(0);
  rz.advance(32);
  setupMidFlick(rz, { dir: 1, frac: 0.72, release: true });
  rz.triggerResize(900, 650);
  rz.advance(300);
  assert.equal(rz.dialog.open, true);
  assert.equal(rz.lightbox.telemetry.scale, 1);

  // 6) Pushing vertically against .track boundaries (st === 0 or st === maxSt) calls preventDefault so Chrome never chains to window.scrollY
  const bnd = createSimulator({ w: 1200, h: 800, scrollY: 500 });
  bnd.open(0);
  bnd.advance(32);
  const upAtRest = bnd.wheelTick(0, 60, { cancelable: true });
  assert.equal(upAtRest.defaultPrevented, true, "Blocks upward scroll chaining at max scrollTop");
  bnd.wheelTick(0, -400, { cancelable: true }); // reaches st === 0
  assert.equal(bnd.track.scrollTop, 0);
  const pastMin = bnd.wheelTick(0, -60, { cancelable: true });
  assert.equal(pastMin.defaultPrevented, true, "Blocks downward scroll chaining when held at st === 0");
  assert.equal(bnd.win.scrollY, 500);
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSimulator,
  assertNoBlankFrames,
  assertNoStateOscillation,
  assertScrollYConstant,
  assertResponsivePull,
  assertNoWallFreeze,
} from "./simulator.mjs";

const TRACES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "traces");

const MIXED_DIMS = [
  [1920, 1280], // 0: 3:2 landscape
  [1280, 1920], // 1: 2:3 portrait
  [2560, 1080], // 2: 21:9 ultrawide (letterboxed top/bottom)
  [1080, 1920], // 3: 9:16 tall portrait (pillarboxed left/right)
  [1000, 1000], // 4: 1:1 square
  [1920, 1280], // 5: landscape
];

// =============================================================================
// Section A: Aspect-ratio & semantic hit-target tests (portrait / landscape / ultrawide / square)
// =============================================================================

test("semantic hit targets: backdrop click vs photo click and drag behave consistently across portrait, landscape, ultrawide, and square", () => {
  const e = createSimulator({ w: 1280, h: 800, tileCount: MIXED_DIMS.length, tileDims: i => MIXED_DIMS[i] });

  for (let i = 0; i < 5; i++) {
    e.open(i);
    e.advance(32);

    // 1) Tapping center of photo never dismisses, regardless of aspect ratio
    const photoPt = e.hitPhoto(0.5, 0.5);
    e.pointerEvent("pointerdown", { pointerId: 1, button: 0, ...photoPt });
    e.pointerEvent("pointerup", { pointerId: 1, button: 0, ...photoPt });
    e.advance(420);
    assert.equal(e.dialog.open, true, `Photo ${i} (${MIXED_DIMS[i]}): photo tap must stay open`);

    // 2) Tapping semantic backdrop (pillarbox on portrait/square, letterbox on ultrawide) dismisses at 1x
    const bgPt = e.hitBackdrop();
    assert.ok(bgPt, `Photo ${i} (${MIXED_DIMS[i]}) has backdrop margin in 1280x800`);
    // While zoomed in, backdrop tap must NOT dismiss
    e.dialog.dispatch("keydown", { key: "+" });
    e.pointerEvent("pointerdown", { pointerId: 2, button: 0, ...bgPt });
    e.pointerEvent("pointerup", { pointerId: 2, button: 0, ...bgPt });
    e.advance(420);
    assert.equal(e.dialog.open, true, `Photo ${i}: backdrop tap while zoomed must NOT dismiss`);
    e.dialog.dispatch("keydown", { key: "0" });
    e.advance(250);

    // At 1x, backdrop tap dismisses cleanly
    e.pointerEvent("pointerdown", { pointerId: 3, button: 0, ...bgPt });
    e.pointerEvent("pointerup", { pointerId: 3, button: 0, ...bgPt });
    e.advance(420);
    assert.equal(e.dialog.open, false, `Photo ${i}: backdrop tap at 1x dismisses cleanly`);
    assert.equal(e.lastFocusedTile, i, `Photo ${i}: focus restored to active tile on close`);
  }
});

test("aspect-ratio dominance: center-proximity oracle handles tall portrait next to ultrawide without area bias", () => {
  // Photo 3 (9:16 portrait, 450px wide) next to Photo 2 (21:9 ultrawide, 1280px wide)
  const e = createSimulator({ w: 1280, h: 800, tileCount: MIXED_DIMS.length, tileDims: i => MIXED_DIMS[i] });
  e.open(3); // 9:16 tall portrait
  e.advance(32);

  // Swipe 35% right toward Photo 2 (ultrawide): Photo 3 still owns viewport center despite smaller pixel area
  const padX = e.track.scrollLeft;
  e.wheelTick(-Math.round(padX * 0.35), 0, { cancelable: true });
  assert.equal(e.dominantPhoto(), "Photo 3", "35% toward ultrawide still keeps tall portrait dominant");

  // Swipe 65% right toward Photo 2 (ultrawide): Photo 2 now owns viewport center
  e.wheelTick(-Math.round(padX * 0.35), 0, { cancelable: false });
  assert.equal(e.dominantPhoto(), "Photo 2", "70% toward ultrawide switches dominance to Photo 2");
});

// =============================================================================
// Section B: Full Keyboard Suite + Keyboard x Gesture Permutations
// =============================================================================

test("keyboard: navigation, wrap-around, zoom caps, modifier passthrough, focus restore, and debug input safety", () => {
  const e = createSimulator({ w: 1280, h: 800, tileCount: 6, tileDims: i => MIXED_DIMS[i], loadDebug: true });
  e.open(0);
  e.advance(32);

  // Wrap-around ArrowLeft from 0 -> 5, ArrowRight from 5 -> 0
  e.dialog.dispatch("keydown", { key: "ArrowLeft" });
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 5");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0");

  // ArrowUp / ArrowDown at 1x are clean no-ops (not defaultPrevented)
  const upAt1x = e.dialog.dispatch("keydown", { key: "ArrowUp" });
  assert.equal(Boolean(upAt1x.defaultPrevented), false);
  assert.equal(e.lightbox.state, "viewing");

  // Modifier shortcuts (Ctrl/Meta/Alt) pass straight through to browser
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    for (const key of ["ArrowRight", "ArrowLeft", "+", "-", "0"]) {
      const ev = e.dialog.dispatch("keydown", { key, ...mod });
      assert.equal(Boolean(ev.defaultPrevented), false, `Modifier ${JSON.stringify(mod)} + ${key} passes through`);
    }
  }
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0");

  // Keydown inside debug <input> / <select> is never hijacked by lightbox
  const debugInput = { matches: sel => sel.includes("input") };
  const inInput = e.dialog.dispatch("keydown", { key: "ArrowRight", target: debugInput });
  assert.equal(Boolean(inInput.defaultPrevented), false, "Debug input keydown is never hijacked");
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0");

  // Zoom in with + and = up to maxZoom cap, pan in all 4 directions with Arrow keys, then zoom back to 1x with -
  e.dialog.dispatch("keydown", { key: "+" });
  e.dialog.dispatch("keydown", { key: "=" });
  assert.equal(e.lightbox.state, "zoomed");
  for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
    const ev = e.dialog.dispatch("keydown", { key });
    assert.equal(ev.defaultPrevented, true);
    assert.equal(e.lightbox.state, "zoomed");
    assert.equal(e.currentFrame().firstElementChild.alt, "Photo 0", `${key} pans when zoomed instead of paginating`);
  }
  // '-' repeatedly returns cleanly to 1x viewing and re-enables ArrowRight pagination
  for (let i = 0; i < 6; i++) e.dialog.dispatch("keydown", { key: "-" });
  assert.equal(e.lightbox.state, "viewing");
  e.dialog.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(e.currentFrame().firstElementChild.alt, "Photo 1");

  // Escape closes and restores focus to Photo 1
  e.dialog.dispatch("cancel");
  e.advance(420);
  assert.equal(e.dialog.open, false);
  assert.equal(e.lastFocusedTile, 1);
});

test("keyboard x gesture permutations: Escape/keys during pointer hold, pinch, pull, mid-flick, fit, and closing", () => {
  // 1) Escape while 1-finger pointer is held down closes cleanly and leaves zero stuck pointers on reopen
  const p = createSimulator({ w: 1280, h: 800, tileCount: 6, tileDims: i => MIXED_DIMS[i] });
  p.open(1); // portrait
  p.advance(32);
  const pt = p.hitPhoto(0.5, 0.5);
  p.pointerEvent("pointerdown", { pointerId: 1, button: 0, ...pt });
  p.pointerEvent("pointermove", { pointerId: 1, button: 0, clientX: pt.clientX, clientY: pt.clientY + 120, target: pt.target });
  assert.equal(p.lightbox.state, "pulling");
  p.dialog.dispatch("cancel");
  assert.equal(p.lightbox.state, "closing");
  p.advance(420);
  assert.equal(p.dialog.open, false);
  assert.equal(p.lastFocusedTile, 1);
  // Reopen -> wheel works immediately (proves no stuck pointers!)
  p.open(2);
  p.advance(32);
  p.wheelTick(0, -45, { cancelable: true });
  assert.equal(p.lightbox.state, "pulling");
  p.dialog.dispatch("cancel");
  p.advance(420);

  // 2) Rapid keyboard ArrowRight blast followed immediately by trackpad pull-down works on the arrived photo
  const k = createSimulator({ w: 1280, h: 800, tileCount: 6, tileDims: i => MIXED_DIMS[i] });
  k.open(0);
  k.advance(32);
  for (let i = 0; i < 3; i++) { k.dialog.dispatch("keydown", { key: "ArrowRight" }); k.stepFrame(16); }
  assert.equal(k.currentFrame().firstElementChild.alt, "Photo 3");
  k.wheelTick(0, -80, { cancelable: true });
  assert.equal(k.lightbox.state, "pulling");
  assert.equal(k.currentFrame().firstElementChild.alt, "Photo 3");
  assert.ok(k.lightbox.telemetry.scale < 0.9);

  // 3) Keyboard '+', '-', '0', 'ArrowRight' while mid-pull-down
  k.dialog.dispatch("keydown", { key: "ArrowRight" }); // ignored while pulling
  assert.equal(k.currentFrame().firstElementChild.alt, "Photo 3");
  k.dialog.dispatch("keydown", { key: "0" }); // fits back cleanly
  k.advance(250);
  assert.equal(k.lightbox.state, "viewing");
  assert.equal(k.lightbox.telemetry.scale, 1);

  // 4) Keyboard '+' mid-vertical-pull enters zoomed cleanly with pull cleared
  k.wheelTick(0, -90, { cancelable: true });
  assert.equal(k.lightbox.state, "pulling");
  k.dialog.dispatch("keydown", { key: "+" });
  assert.equal(k.lightbox.state, "zoomed");
  assert.equal(k.lightbox.telemetry.scale, 1);

  // 5) Keyboard 'ArrowRight' mid-fit animation cleanly cancels fit and advances
  k.dialog.dispatch("keydown", { key: "0" });
  k.stepFrame(16); // mid-fit tween while zoom is still > 1 -> ArrowRight pans rather than breaking
  k.dialog.dispatch("keydown", { key: "ArrowRight" });
  assert.equal(k.dialog.open, true);
});

// =============================================================================
// Section C: Adversarial Momentum & Liveness Matrix (reproduces exact user freeze!)
// =============================================================================

test("liveness repro: swipe right then aggressive swipe down (all delays & cancelable modes) responds within 2 frames and never freezes during momentum", () => {
  const orientations = [0, 1, 2]; // landscape, portrait, ultrawide
  const delays = [0, 16, 48, 96];
  const cancelables = [true, false];

  for (const startIdx of orientations) {
    for (const delay of delays) {
      for (const cancelable of cancelables) {
        const label = `idx=${startIdx} delay=${delay}ms cancelable=${cancelable}`;
        const e = createSimulator({ w: 1280, h: 800, tileCount: MIXED_DIMS.length, tileDims: i => MIXED_DIMS[i], scrollY: 500 });
        e.open(startIdx);
        e.advance(32);

        // Step 1: Flick right aggressively to paginate to previous photo (scrollLeft moves toward 0)
        e.macosTrackpadFlick({ vx: -130, vy: 0, burstFrames: 4, cancelableFirst: true });
        if (delay > 0) e.advance(delay);

        const expectedPhoto = e.dominantPhoto();
        e.startRecording();
        const pullStartT = e.getNow();

        // Step 2: Aggressive swipe down (-140px/frame, slamming scrollTop -> 0 with real decaying macOS momentum!)
        e.macosTrackpadFlick({ vx: 0, vy: -140, burstFrames: 3, cancelableFirst: cancelable, decay: 0.90 });
        e.advance(1400);

        const log = e.stopRecording();
        assertNoBlankFrames(log);
        assertScrollYConstant(log, 500);
        // Liveness 1: photo MUST visibly respond within 48ms (never stay frozen at scale=1 during momentum!)
        assertResponsivePull(log, { afterT: pullStartT, maxLagMs: 48, maxScale: 0.95, label });
        // Dominant photo identity: first pulling/closing frame must act on expectedPhoto, not revert
        const firstPull = log.find(f => f.t >= pullStartT && (f.state === "pulling" || f.state === "closing"));
        assert.ok(firstPull, `${label}: entered pulling or closing`);
        assert.equal(firstPull.activeAlt, expectedPhoto, `${label}: acted on dominant photo ${expectedPhoto}`);
        // Liveness 2: released aggressive flick hitting scrollTop=0 must NOT sit frozen for 1s waiting on momentum tail!
        assertNoWallFreeze(log, { afterT: pullStartT, maxFrozenMs: 450, label });
        assert.equal(e.dialog.open, false, `${label}: closed cleanly`);
      }
    }
  }
});

test("wall momentum detector distinguishes steady/jittery manual finger pushing from decaying macOS momentum", () => {
  // 1) Slow/jittery manual pushing and motionless hold at scrollTop=0 NEVER auto-dismiss while fingers stay down
  const manual = createSimulator({ w: 1280, h: 800, scrollY: 500 });
  manual.open(0);
  manual.advance(32);
  manual.wheelTick(0, -400, { cancelable: true }); // reaches scrollTop=0
  assert.equal(manual.track.scrollTop, 0);
  assert.equal(manual.lightbox.state, "pulling");

  // Jittery human pushing + steady pushing + lateral wobble + slow deceleration all hold cleanly at min size
  for (const [dx, dy] of [
    [0, -18], [0, -24], [0, -15], [0, -26],
    [0, -20], [0, -20], [0, -20], [0, -20],
    [-1, -10], [-1, -10], [-1, -9], [-1, -9], [-1, -8], [-1, -8], [-1, -7], [-1, -7],
    [0, -16], [0, -12], [0, -8], [0, -4],
  ]) {
    manual.wheelTick(dx, dy, { cancelable: false });
    manual.stepFrame(16);
  }
  manual.advance(2000);
  assert.equal(manual.dialog.open, true, "Manual pushing & 2s motionless hold at min size stays open");
  assert.equal(manual.lightbox.state, "pulling");

  // Reversing upward grows photo back up cleanly
  manual.wheelTick(0, 120, { cancelable: false });
  assert.ok(manual.lightbox.telemetry.scale > 0.35, "Reversing upward from min size grows photo smoothly");

  // 2) Native WheelEvent.momentum === true at scrollTop=0 dismisses immediately on tick 1
  const native = createSimulator({ w: 1280, h: 800, scrollY: 500 });
  native.open(0);
  native.advance(32);
  native.wheelTick(0, -400, { cancelable: true });
  native.stage.dispatch("wheel", { deltaX: 0, deltaY: -35, deltaMode: 0, cancelable: false, momentum: true });
  assert.equal(native.lightbox.state, "closing", "Native WheelEvent.momentum=true at wall dismisses immediately");
  native.advance(420);
  assert.equal(native.dialog.open, false);
  assert.equal(native.win.scrollY, 500);
});

test("real macOS 120Hz trace replay: swipe right -> aggressive swipe down, medium re-flick, gentle tail, and post-lift snap", () => {
  const realTrace = JSON.parse(fs.readFileSync(path.join(TRACES_DIR, "macos-swipe-right-then-down.json"), "utf8"));
  const [vw, vh] = realTrace.viewport;

  // 1) Verbatim full replay (Flick #1): swipe right -> swipe aggressively down hits st=0 at t=1667, must dismiss within ~50ms (not 1,383ms!)
  const full = createSimulator({ w: vw, h: vh, scrollY: 500, tileDims: i => i === 0 ? [1500, 1000] : [1730, 1000] });
  full.open(0);
  full.advance(32);
  full.startRecording();
  full.replayRecordedEvents(realTrace.events, { fromT: 1238, toT: 3060 });
  full.advance(420);
  const fullLog = full.stopRecording();
  assertNoBlankFrames(fullLog);
  assertScrollYConstant(fullLog, 500);
  assertNoWallFreeze(fullLog, { afterT: 0, maxFrozenMs: 80, label: "real-macos-flick-1" });
  const closing1 = fullLog.find(f => f.state === "closing");
  assert.ok(closing1, "Flick #1 entered closing");
  assert.equal(closing1.activeAlt, "Photo 1", "Flick #1 dismissed the new dominant Photo 1 (did not revert to Photo 0)");
  assert.equal(full.dialog.open, false, "Flick #1 closed cleanly");

  // 2) Verbatim Flick #2 (t=1818..3051): manual fingers-down re-swipe MUST stay held through t=1966, then 120Hz momentum (startDy=20 with flat plateaus) MUST dismiss within ~60ms
  const flick2 = createSimulator({ w: vw, h: vh, scrollY: 500, tileDims: i => i === 0 ? [1500, 1000] : [1730, 1000] });
  flick2.open(1);
  flick2.advance(32);
  // Bring cleanly to min size (st=0) with off-snap sl=1240 as at t=1818
  flick2.wheelTick(0, -500, { cancelable: true });
  flick2.advance(16);
  flick2.track.scrollLeft = 1240;
  assert.equal(flick2.lightbox.state, "pulling");

  // Replay manual fingers-down re-swipe (t=1818..1966): must NOT auto-close while fingers are down!
  flick2.replayRecordedEvents(realTrace.events, { fromT: 1818, toT: 1966 });
  assert.equal(flick2.lightbox.state, "pulling", "Manual re-swipe (t=1818..1966) stayed held at min size");
  assert.equal(flick2.dialog.open, true);

  // Now replay the 120Hz released momentum tail (t=1967..2833)
  flick2.startRecording();
  const tailStartT = flick2.getNow();
  flick2.replayRecordedEvents(realTrace.events, { fromT: 1967, toT: 2833 });
  flick2.advance(420);
  const log2 = flick2.stopRecording();
  assertScrollYConstant(log2, 500);
  assertNoWallFreeze(log2, { afterT: tailStartT, maxFrozenMs: 80, label: "real-macos-flick-2-120hz" });
  assert.equal(flick2.dialog.open, false, "Flick #2 closed promptly without 1.1s momentum freeze");

  // 3) Gentle 120Hz momentum tail starting at dy=-8 (t=2143..2833) also dismisses cleanly (~90ms, not 900ms!)
  const gentle = createSimulator({ w: vw, h: vh, scrollY: 500 });
  gentle.open(1);
  gentle.advance(32);
  gentle.wheelTick(0, -500, { cancelable: true });
  gentle.advance(60); // pause before gentle flick tail
  gentle.startRecording();
  const gStart = gentle.getNow();
  gentle.replayRecordedEvents(realTrace.events, { fromT: 2143, toT: 2833 });
  gentle.advance(420);
  const gLog = gentle.stopRecording();
  assertNoWallFreeze(gLog, { afterT: gStart, maxFrozenMs: 120, label: "real-macos-gentle-tail-dy8" });
  assert.equal(gentle.dialog.open, false);

  // 4) Zero-momentum gentle lift after holding motionless 2s at min size with off-snap sl (t=2858..3051):
  //    must dismiss as soon as post-lift horizontal snap starts (~60ms), not wait 217ms for sl -> 1298!
  const snapLift = createSimulator({ w: vw, h: vh, scrollY: 500 });
  snapLift.open(1);
  snapLift.advance(32);
  snapLift.wheelTick(0, -500, { cancelable: true });
  snapLift.track.scrollLeft = 1247;
  snapLift.advance(2000); // hold motionless 2 seconds
  assert.equal(snapLift.lightbox.state, "pulling", "2s motionless hold stays open");
  snapLift.startRecording();
  const snapStart = snapLift.getNow();
  snapLift.replayRecordedEvents(realTrace.events, { fromT: 2858, toT: 3051 });
  snapLift.advance(420);
  const snapLog = snapLift.stopRecording();
  assertNoWallFreeze(snapLog, { afterT: snapStart, maxFrozenMs: 60, label: "real-macos-post-lift-x-snap" });
  assert.equal(snapLift.dialog.open, false);
});

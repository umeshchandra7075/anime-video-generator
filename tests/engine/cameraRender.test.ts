import { describe, it, expect } from "vitest";
import { getBinaries } from "../../src/lib/engine/binaries";
import { execFileSync } from "node:child_process";
import { buildCameraFilter, evalCamera } from "../../src/lib/engine/camera";
import type { CameraPlan } from "../../src/lib/engine/types";

const W = 640, H = 360, FPS = 25;
/** Renders a black frame with a white 40x40 marker at (mx,my) through the generated camera filter; returns marker bbox per requested frame. */
function render(plan: CameraPlan, mx: number, my: number, frames: number[], dur = 2.4) {
  const filter = buildCameraFilter(plan, { width: W, height: H, fps: FPS });
  const out = execFileSync(getBinaries().ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `color=c=black:s=${W}x${H}:r=${FPS}:d=${dur},drawbox=x=${mx - 20}:y=${my - 20}:w=40:h=40:color=white:t=fill,${filter}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 });
  const fs = W * H;
  return frames.map((f) => {
    let x0 = W, x1 = -1, y0 = H, y1 = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (out[f * fs + y * W + x]! > 128) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { w: x1 - x0 + 1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
  });
}

describe("FFmpeg camera output matches the reference model", () => {
  it("zoomIn: marker grows exactly as evalCamera predicts (frame 0, mid, end)", () => {
    const plan: CameraPlan = { shot: "MEDIUM", baseZoom: 1, focusX: 0.5, focusY: 0.5, moves: [{ type: "zoomIn", start: 0, end: 2, amount: 1.5 }], reason: "test" };
    const frames = [0, 25, 49];
    const got = render(plan, W / 2, H / 2, frames);
    frames.forEach((f, i) => {
      const z = evalCamera(plan, f / FPS).zoom;
      expect(Math.abs(got[i]!.w - 40 * z)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(got[i]!.cx - W / 2)).toBeLessThanOrEqual(1.5);
    });
    expect(got[2]!.w).toBeGreaterThan(got[0]!.w * 1.35);
  });
  it("focusTransition: the marker glides to frame centre as the camera re-centres on it", () => {
    const plan: CameraPlan = { shot: "TWO_SHOT", baseZoom: 1.5, focusX: 0.5, focusY: 0.5, moves: [{ type: "focusTransition", start: 0.4, end: 1.6, amount: 0, toX: 0.35, toY: 0.5 }], reason: "test" };
    const mx = Math.round(0.35 * W);
    const frames = [0, 45];
    const got = render(plan, mx, H / 2, frames);
    // before: marker sits left of centre; after: centred within a couple of px
    expect(got[0]!.cx).toBeLessThan(W / 2 - 40);
    expect(Math.abs(got[1]!.cx - W / 2)).toBeLessThanOrEqual(3);
    for (const [i, f] of frames.entries()) expect(Math.abs(got[i]!.cx - ((evalCamera(plan, f / FPS).cx === 0.5 ? mx : mx) - (evalCamera(plan, f / FPS).cx * W - W / evalCamera(plan, f / FPS).zoom / 2)) * evalCamera(plan, f / FPS).zoom)).toBeLessThanOrEqual(4);
  });
  it("shake displaces the frame only inside its window and settles back", () => {
    const plan: CameraPlan = { shot: "DYNAMIC", baseZoom: 1.2, focusX: 0.5, focusY: 0.5, moves: [{ type: "shake", start: 0.8, end: 1.3, amount: 0.02 }], reason: "test" };
    const got = render(plan, W / 2, H / 2, [5, 22, 24, 40, 55]);
    expect(Math.abs(got[0]!.cx - W / 2)).toBeLessThanOrEqual(1.5);   // before shake
    expect(Math.abs(got[4]!.cx - W / 2)).toBeLessThanOrEqual(1.5);   // after shake
    const moved = [got[1]!, got[2]!].some((g) => Math.abs(g.cx - W / 2) > 2 || Math.abs(g.cy - H / 2) > 2);
    expect(moved).toBe(true);
  });
  it("the output is always exactly WxH", () => {
    const plan: CameraPlan = { shot: "WIDE", baseZoom: 1.12, focusX: 0.5, focusY: 0.5, moves: [{ type: "zoomOut", start: 0, end: 2, amount: 1 }], reason: "t" };
    const out = execFileSync(getBinaries().ffmpeg, ["-v", "error", "-f", "lavfi", "-i", `testsrc=s=${W}x${H}:r=${FPS}:d=1,${buildCameraFilter(plan, { width: W, height: H, fps: FPS })}`, "-f", "rawvideo", "-pix_fmt", "gray", "-"], { maxBuffer: 1 << 28 });
    expect(out.length).toBe(W * H * FPS);
  });
});

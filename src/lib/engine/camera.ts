// Deterministic camera planning. Same scene context => same plan, always
// (no randomness). Every rule records WHY it fired in `plan.reason`.
import type { CameraMove, CameraPlan, Emotion, SfxType } from "./types";

export interface CameraSegmentInfo { characterId: string; start: number; end: number; emotion: Emotion; intensity: number }
export interface CameraContext {
  duration: number;
  segments: CameraSegmentInfo[];
  onScreen: string[]; // character ids, left-to-right
  positions?: Record<string, { x: number; y: number }>;
  sceneText: string; // description + mood + location + explicit camera hint
  sfxTypes: Array<{ type: SfxType; startTime: number }>;
  isFirstScene: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const r3 = (x: number) => Math.round(x * 1000) / 1000;

export function characterPosition(ctx: Pick<CameraContext, "onScreen" | "positions">, id: string): { x: number; y: number } {
  const explicit = ctx.positions?.[id];
  if (explicit) return explicit;
  const n = Math.max(1, ctx.onScreen.length);
  const idx = Math.max(0, ctx.onScreen.indexOf(id));
  return { x: n === 1 ? 0.5 : 0.28 + (0.44 * idx) / (n - 1), y: 0.42 };
}

function dominantEmotion(segs: CameraSegmentInfo[]): { emotion: Emotion; weight: number } | null {
  const acc = new Map<Emotion, number>();
  for (const s of segs) acc.set(s.emotion, (acc.get(s.emotion) ?? 0) + s.intensity * (s.end - s.start));
  let best: { emotion: Emotion; weight: number } | null = null;
  for (const [emotion, weight] of [...acc.entries()].sort((a, b) => a[0].localeCompare(b[0]))) if (!best || weight > best.weight) best = { emotion, weight };
  return best;
}

export function planCamera(ctx: CameraContext): CameraPlan {
  const D = Math.max(0.5, ctx.duration);
  const text = ctx.sceneText.toLowerCase();
  const speakers = [...new Set(ctx.segments.map((s) => s.characterId).filter((id) => id !== "narrator"))];
  const primary = speakers[0] ?? ctx.onScreen[0];
  const pos = primary ? characterPosition(ctx, primary) : { x: 0.5, y: 0.45 };
  const impacts = ctx.sfxTypes.filter((s) => s.type === "sword" || s.type === "impact" || s.type === "explosion");

  // 1. ACTION
  if (impacts.length > 0 || /\b(fight|battle|attack|chase|running|explod\w*|sword|clash|duel|punch|strike)\b/.test(text)) {
    const moves: CameraMove[] = [{ type: "zoomIn", start: 0, end: Math.min(1.2, D), amount: 1.14 }];
    for (const s of impacts) moves.push({ type: "shake", start: clamp(s.startTime, 0, D - 0.1), end: clamp(s.startTime + 0.35, 0.1, D), amount: 0.007 });
    return { shot: "DYNAMIC", baseZoom: 1.04, focusX: 0.5, focusY: 0.5, moves, reason: "action" };
  }
  // 2. ESTABLISHING
  if (ctx.segments.length === 0 && (ctx.isFirstScene || /establish|skyline|landscape|cityscape|panorama|wide shot|aerial/.test(text))) {
    return { shot: "WIDE", baseZoom: 1.12, focusX: 0.5, focusY: 0.5, moves: [{ type: "zoomOut", start: 0, end: D, amount: 1.0 }], reason: "establishing" };
  }
  const dom = dominantEmotion(ctx.segments);
  const peak = ctx.segments.reduce((m, s) => Math.max(m, s.intensity), 0);
  // 3. EMOTIONAL -> slow close-up
  if (dom && (["sad", "crying", "romantic", "fear"].includes(dom.emotion) || (peak >= 0.85 && speakers.length <= 1))) {
    return { shot: peak >= 0.85 ? "EXTREME_CLOSEUP" : "CLOSEUP", baseZoom: 1.12, focusX: pos.x, focusY: Math.min(pos.y, 0.4), moves: [{ type: "zoomIn", start: 0, end: D, amount: peak >= 0.85 ? 1.34 : 1.26 }], reason: "emotional" };
  }
  // 4. CONFRONTATION -> gradual push-in
  if (dom && ["angry", "shouting", "determined"].includes(dom.emotion)) {
    return { shot: "MEDIUM", baseZoom: 1.04, focusX: pos.x, focusY: pos.y, moves: [{ type: "zoomIn", start: 0, end: D, amount: 1.22 }], reason: "confrontation" };
  }
  // 5. CONVERSATION -> two-shot, focus eases to whoever speaks
  if (speakers.length >= 2) {
    const moves: CameraMove[] = [];
    for (const s of ctx.segments) {
      if (s.characterId === "narrator") continue;
      const p = characterPosition(ctx, s.characterId);
      // only real changes of speaker move the camera: no jitter on same-speaker lines
      const prev = moves[moves.length - 1];
      if (prev && prev.toX !== undefined && Math.abs(prev.toX - (0.5 + (p.x - 0.5) * 0.35)) < 0.005) continue;
      moves.push({ type: "focusTransition", start: clamp(s.start - 0.15, 0, D - 0.4), end: clamp(s.start + 0.35, 0.4, D), amount: 0, toX: r3(0.5 + (p.x - 0.5) * 0.35), toY: 0.47 });
    }
    return { shot: "TWO_SHOT", baseZoom: 1.1, focusX: 0.5, focusY: 0.47, moves, reason: "conversation" };
  }
  // 6. DEFAULT
  return { shot: "MEDIUM", baseZoom: 1.0, focusX: pos.x, focusY: pos.y, moves: [{ type: "zoomIn", start: 0, end: D, amount: 1.06 }], reason: "default" };
}

// ---------------------------------------------------------------------------
// Reference evaluation + FFmpeg expression generated from the SAME numbers.
// ---------------------------------------------------------------------------
const sm = (u: number) => { const c = clamp(u, 0, 1); return c * c * (3 - 2 * c); };

interface Segment { s: number; e: number; d: number }
interface Compiled { zoom0: number; cx0: number; cy0: number; zoomSegs: Segment[]; cxSegs: Segment[]; cySegs: Segment[]; shakes: Array<{ s: number; e: number; a: number; phase: number }> }

export function compileCamera(plan: CameraPlan): Compiled {
  const c: Compiled = { zoom0: plan.baseZoom, cx0: plan.focusX, cy0: plan.focusY, zoomSegs: [], cxSegs: [], cySegs: [], shakes: [] };
  let z = plan.baseZoom, cx = plan.focusX, cy = plan.focusY;
  const moves = [...plan.moves].sort((a, b) => a.start - b.start);
  moves.forEach((m, i) => {
    const seg = (d: number): Segment => ({ s: m.start, e: Math.max(m.end, m.start + 0.05), d });
    switch (m.type) {
      case "zoomIn": case "zoomOut": c.zoomSegs.push(seg(m.amount - z)); z = m.amount; break;
      case "panLeft": c.cxSegs.push(seg(-m.amount)); cx -= m.amount; break;
      case "panRight": c.cxSegs.push(seg(m.amount)); cx += m.amount; break;
      case "panUp": c.cySegs.push(seg(-m.amount)); cy -= m.amount; break;
      case "panDown": c.cySegs.push(seg(m.amount)); cy += m.amount; break;
      case "track": case "focusTransition": {
        const tx = m.toX ?? cx, ty = m.toY ?? cy;
        c.cxSegs.push(seg(tx - cx)); c.cySegs.push(seg(ty - cy)); cx = tx; cy = ty; break;
      }
      case "shake": c.shakes.push({ s: m.start, e: Math.max(m.end, m.start + 0.05), a: m.amount, phase: i * 1.7 }); break;
    }
  });
  return c;
}

export function evalCamera(plan: CameraPlan, t: number): { zoom: number; cx: number; cy: number; shakeX: number; shakeY: number } {
  const c = compileCamera(plan);
  const sum = (segs: Segment[]) => segs.reduce((a, g) => a + g.d * sm((t - g.s) / (g.e - g.s)), 0);
  let sx = 0, sy = 0;
  for (const k of c.shakes) if (t >= k.s && t <= k.e) { const env = 1 - (t - k.s) / (k.e - k.s); sx += k.a * env * Math.sin(2 * Math.PI * 23 * t + k.phase); sy += k.a * env * Math.cos(2 * Math.PI * 19 * t + k.phase); }
  return { zoom: c.zoom0 + sum(c.zoomSegs), cx: c.cx0 + sum(c.cxSegs), cy: c.cy0 + sum(c.cySegs), shakeX: sx, shakeY: sy };
}

const f = (x: number) => Number(x.toFixed(5)).toString();

/** zoompan filter for a video input already rendered at >= output size. `T` = on/fps. */
export function buildCameraFilter(plan: CameraPlan, o: { width: number; height: number; fps: number }): string {
  const c = compileCamera(plan);
  const T = `(on/${o.fps})`;
  const smE = (s: number, e: number) => `(pow(clip((${T}-${f(s)})/${f(e - s)},0,1),2)*(3-2*clip((${T}-${f(s)})/${f(e - s)},0,1)))`;
  const sumE = (base: number, segs: Segment[]) => [f(base), ...segs.map((g) => `${f(g.d)}*${smE(g.s, g.e)}`)].join("+");
  const shakeTerm = (fnName: "sin" | "cos", hz: number) => c.shakes.map((k) => `${f(k.a)}*between(${T},${f(k.s)},${f(k.e)})*(1-(${T}-${f(k.s)})/${f(k.e - k.s)})*${fnName}(2*PI*${hz}*${T}+${f(k.phase)})`).join("+") || "0";
  const z = `max(1,${sumE(c.zoom0, c.zoomSegs)})`;
  const cx = `(${sumE(c.cx0, c.cxSegs)}+${shakeTerm("sin", 23)})`;
  const cy = `(${sumE(c.cy0, c.cySegs)}+${shakeTerm("cos", 19)})`;
  const x = `max(0,min(iw-iw/zoom,${cx}*iw-iw/zoom/2))`;
  const y = `max(0,min(ih-ih/zoom,${cy}*ih-ih/zoom/2))`;
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${o.width}x${o.height}:fps=${o.fps}`;
}

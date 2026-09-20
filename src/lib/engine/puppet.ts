// 2D puppet compositor: drives LAYERED character art from the master timeline
// (mouth sprites from the viseme track, expression sprites from actor spans,
// eyelid sprite on blinks, head/body motion from breathe/nod/gesture events).
//
// REQUIREMENT: this needs layered art (a rig). The image providers in this
// project return flat pictures, so this path only applies to characters that
// have a RigSpec. It does NOT segment a flat AI image into layers.
import type { FacialExpression, SceneTimeline, Viseme } from "./types";
import { visemeAt } from "./visemes";

export interface Rect { x: number; y: number; w: number; h: number } // normalized to frame width/height (top-left origin)
export interface Sprite extends Rect { file: string }
export interface RigSpec {
  characterId: string;
  body?: Sprite; // cut-out with alpha; gets breathing only
  head?: Sprite; // cut-out with alpha; face layers follow it (bob / nod / gesture)
  eyesClosed?: Sprite; // shown during blinks
  expressions?: Partial<Record<FacialExpression, Sprite>>; // eyes+brows variants, shown during matching actor spans
  mouth: { rect: Rect; sprites: Partial<Record<Viseme, string>> };
}

const FALLBACK: Record<Viseme, Viseme[]> = {
  REST: [], MBP: ["REST"], FV: ["MBP", "REST"], TH: ["TD", "EH"], TD: ["EH", "REST"], KG: ["EH", "AA"], CHJ: ["OO", "EH"], SZ: ["EE", "IH"],
  AE: ["EH", "AA"], AA: ["AE", "EH"], EH: ["AE", "IH"], EE: ["IH", "EH"], IH: ["EE", "EH"], OH: ["OO", "AA"], OO: ["OH", "WQ"], WQ: ["OO", "OH"],
};
export function resolveMouthSprite(rig: RigSpec, v: Viseme): { file: string; approximatedFrom: Viseme | null } | null {
  const direct = rig.mouth.sprites[v];
  if (direct) return { file: direct, approximatedFrom: null };
  for (const alt of FALLBACK[v]) { const f = rig.mouth.sprites[alt]; if (f) return { file: f, approximatedFrom: alt }; }
  const rest = rig.mouth.sprites.REST;
  return rest ? { file: rest, approximatedFrom: "REST" } : null;
}

export interface PuppetBuild { inputArgs: string[]; filter: string; outLabel: string; inputCount: number; approximatedVisemes: string[] }
const f5 = (x: number) => Number(x.toFixed(5)).toString();
const win = (s: number, e: number) => `between(t,${f5(s)},${f5(e)})`;

export function buildPuppetGraph(rigs: RigSpec[], tl: SceneTimeline, o: { width: number; height: number; fps: number; firstInputIndex: number; baseLabel: string }): PuppetBuild {
  const { width: W, height: H, fps } = o;
  const inputArgs: string[] = [];
  const chains: string[] = [];
  const approximated = new Set<string>();
  let idx = o.firstInputIndex, label = o.baseLabel, ov = 0;

  const addSprite = (file: string, rect: Rect, offX: string, offY: string, enable?: string) => {
    inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", f5(tl.duration), "-i", file);
    const i = idx++;
    const pw = Math.max(2, Math.round(rect.w * W)), ph = Math.max(2, Math.round(rect.h * H));
    chains.push(`[${i}:v]format=rgba,scale=${pw}:${ph}[sp${i}]`);
    const next = `pv${ov++}`;
    const x = `${Math.round(rect.x * W)}+(${offX})`, y = `${Math.round(rect.y * H)}+(${offY})`;
    chains.push(`[${label}][sp${i}]overlay=x='${x}':y='${y}':eval=frame:format=auto${enable ? `:enable='${enable}'` : ""}[${next}]`);
    label = next;
  };

  for (const rig of rigs) {
    const track = tl.actors.find((a) => a.characterId === rig.characterId);
    const ev = track?.events ?? [];
    const breathe = ev.find((e) => e.kind === "breathe");
    const A = Number(breathe?.params?.amplitude ?? 0.004), P = Number(breathe?.params?.periodSec ?? 4);
    const breathY = breathe ? `${f5(A * H)}*sin(2*PI*t/${f5(P)})` : "0";
    const nodY = ev.filter((e) => e.kind === "nod").map((e) => `${win(e.start, e.end)}*${f5(Number(e.params?.amplitude ?? 0.5) * H * 0.02)}*sin(PI*(t-${f5(e.start)})/${f5(e.end - e.start)})`);
    const gesX = ev.filter((e) => e.kind === "gesture").map((e) => `${win(e.start, e.end)}*${f5(Number(e.params?.amplitude ?? 0.5) * W * 0.004)}*sin(2*PI*1.3*t)`);
    const gesY = ev.filter((e) => e.kind === "gesture").map((e) => `${win(e.start, e.end)}*${f5(Number(e.params?.amplitude ?? 0.5) * H * 0.003)}*sin(2*PI*2.1*t)`);
    const headX = gesX.join("+") || "0";
    const headY = [breathY, ...nodY, ...gesY].join("+");
    const faceX = rig.head ? headX : "0", faceY = rig.head ? headY : "0";

    if (rig.body) addSprite(rig.body.file, rig.body, "0", breathY);
    if (rig.head) addSprite(rig.head.file, rig.head, headX, headY);
    // expression layers: enabled during spans with that expression
    for (const [expr, sprite] of Object.entries(rig.expressions ?? {})) {
      if (!sprite) continue;
      const wins = (track?.spans ?? []).filter((s) => s.expression === expr).map((s) => win(s.start, s.end));
      if (wins.length) addSprite(sprite.file, sprite, faceX, faceY, wins.join("+"));
    }
    if (rig.eyesClosed) {
      const wins = ev.filter((e) => e.kind === "blink").map((e) => win(e.start, e.end));
      if (wins.length) addSprite(rig.eyesClosed.file, rig.eyesClosed, faceX, faceY, wins.join("+"));
    }
    // mouth: REST is always drawn; every other viseme only inside its intervals, from the SAME viseme track the timeline exposes
    const restSprite = resolveMouthSprite(rig, "REST");
    if (restSprite) addSprite(restSprite.file, rig.mouth.rect, faceX, faceY);
    const byFile = new Map<string, string[]>();
    for (const vt of tl.visemes.filter((v) => v.characterId === rig.characterId)) {
      for (const iv of vt.intervals) {
        if (iv.viseme === "REST") continue;
        const r = resolveMouthSprite(rig, iv.viseme);
        if (!r) continue;
        if (r.approximatedFrom) approximated.add(`${iv.viseme}->${r.approximatedFrom}`);
        (byFile.get(r.file) ?? byFile.set(r.file, []).get(r.file)!).push(win(iv.start, iv.end));
      }
    }
    for (const [file, wins] of byFile) addSprite(file, rig.mouth.rect, faceX, faceY, wins.join("+"));
  }
  return { inputArgs, filter: chains.join(";"), outLabel: label, inputCount: idx - o.firstInputIndex, approximatedVisemes: [...approximated].sort() };
}
export { visemeAt };

import type { SceneTimeline } from "./types";
import { NARRATOR_ID } from "./types";

export function srtTime(sec: number): string {
  const total = Math.max(0, Math.round(sec * 1000));
  const ms = total % 1000, s = Math.floor(total / 1000) % 60, m = Math.floor(total / 60000) % 60, h = Math.floor(total / 3600000);
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`;
}

function wrap(text: string, width = 42): string {
  const words = text.split(/\s+/); const lines: string[] = []; let cur = "";
  for (const w of words) { if ((cur + " " + w).trim().length > width && cur) { lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }
  if (cur) lines.push(cur);
  return lines.join("\n");
}

/** Cues use the EXACT measured segment windows from the master timeline (scene offsets = cumulative frame-exact durations). */
export function buildSrt(timelines: SceneTimeline[]): string {
  const cues: string[] = [];
  let offset = 0, n = 1;
  for (const tl of timelines) {
    for (const s of tl.segments) {
      const text = s.characterId === NARRATOR_ID ? s.text : `${s.speakerName}: ${s.text}`;
      cues.push(`${n++}\n${srtTime(offset + s.startTime)} --> ${srtTime(offset + s.endTime)}\n${wrap(text)}\n`);
    }
    offset += tl.duration;
  }
  return cues.join("\n");
}

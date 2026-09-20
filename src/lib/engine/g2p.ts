// Approximate grapheme -> viseme rules. This is NOT a phoneme recogniser and
// NOT a full pronunciation dictionary: it maps spelling to the mouth shape a
// listener would expect, which is what a 2D mouth rig needs. Accuracy is
// bounded by English spelling irregularity; timing accuracy comes from the
// audio (see visemes.ts), not from these rules.
import type { Viseme } from "./types";

export interface PhonUnit { viseme: Viseme; weight: number; charStart: number; charEnd: number }
export interface WordUnits { word: string; charStart: number; charEnd: number; units: PhonUnit[] }
export type G2PSupport = "full" | "unsupported";

const W = { vowel: 1.0, long: 1.4, stop: 0.5, fric: 0.7, liquid: 0.6, glide: 0.5, h: 0.3 };

interface Sym { v: Viseme | null; w: number; len: number } // len = graphemes consumed

// ---- English -------------------------------------------------------------
const EN_DIGRAPHS: Array<[string, Viseme | null, number]> = [
  ["tch", "CHJ", W.fric], ["dge", "CHJ", W.fric],
  ["th", "TH", W.fric], ["sh", "CHJ", W.fric], ["ch", "CHJ", W.fric], ["ph", "FV", W.fric], ["ck", "KG", W.stop],
  ["ng", "KG", W.stop], ["qu", "WQ", W.glide], ["wh", "WQ", W.glide], ["zh", "CHJ", W.fric],
  ["ee", "EE", W.long], ["ea", "EE", W.long], ["oo", "OO", W.long], ["ou", "OH", W.long], ["ow", "OH", W.long],
  ["oa", "OH", W.long], ["ai", "EH", W.long], ["ay", "EH", W.long], ["ei", "EH", W.long], ["ey", "EH", W.long],
  ["au", "AA", W.long], ["aw", "AA", W.long], ["oi", "OH", W.long], ["oy", "OH", W.long], ["ew", "OO", W.long],
  ["eu", "OO", W.long], ["ie", "EE", W.long], ["ue", "OO", W.long],
];
const EN_SINGLE: Record<string, [Viseme | null, number]> = {
  a: ["AE", W.vowel], e: ["EH", W.vowel], i: ["IH", W.vowel], o: ["OH", W.vowel], u: ["AA", W.vowel],
  b: ["MBP", W.stop], m: ["MBP", W.stop], p: ["MBP", W.stop],
  f: ["FV", W.fric], v: ["FV", W.fric],
  d: ["TD", W.stop], t: ["TD", W.stop], n: ["TD", W.liquid], l: ["TD", W.liquid],
  k: ["KG", W.stop], g: ["KG", W.stop], q: ["KG", W.stop], c: ["KG", W.stop],
  s: ["SZ", W.fric], z: ["SZ", W.fric], x: ["SZ", W.fric], j: ["CHJ", W.fric],
  r: ["OO", W.liquid], w: ["WQ", W.glide], y: ["EE", W.glide], h: [null, W.h],
};

function enSymbolAt(word: string, i: number): Sym {
  const rest = word.slice(i);
  for (const [g, v, w] of EN_DIGRAPHS) {
    if (rest.startsWith(g)) {
      if (g === "dge") return { v, w, len: 2 }; // "dg" carries the sound; final e handled as silent
      return { v, w, len: g.length };
    }
  }
  const ch = word[i]!;
  // soft c / g before e,i,y
  if ((ch === "c" || ch === "g") && /^[eiy]/.test(word.slice(i + 1))) return { v: ch === "c" ? "SZ" : "CHJ", w: W.fric, len: 1 };
  // initial silent letters: kn-, wr-, gn-
  if (i === 0 && /^(kn|gn|wr)/.test(word)) return { v: null, w: 0, len: 1 };
  // silent final e after a consonant when an earlier vowel exists (make, time) - NOT the/she/be, whose e is the only vowel
  if (ch === "e" && i === word.length - 1 && i >= 2 && !/[aeiouy]/.test(word[i - 1]!) && /[aeiouy]/.test(word.slice(0, i - 1))) return { v: null, w: 0, len: 1 };
  // gh not at word start is usually silent (night, though)
  if (ch === "g" && word[i + 1] === "h" && i > 0) return { v: null, w: 0, len: 2 };
  const s = EN_SINGLE[ch];
  return s ? { v: s[0], w: s[1], len: 1 } : { v: null, w: 0, len: 1 };
}

// ---- Pure-vowel Latin languages (es, it, pt, id, ja romaji, ...) --------
const PURE_VOWEL: Record<string, Viseme> = { a: "AA", e: "EH", i: "EE", o: "OH", u: "OO" };
const PURE_DIGRAPHS: Array<[string, Viseme | null, number]> = [
  ["sh", "CHJ", W.fric], ["ch", "CHJ", W.fric], ["ts", "SZ", W.fric], ["ny", "TD", W.liquid], ["ll", "TD", W.liquid], ["rr", "OO", W.liquid], ["qu", "KG", W.stop],
];
function pureSymbolAt(word: string, i: number): Sym {
  const rest = word.slice(i);
  for (const [g, v, w] of PURE_DIGRAPHS) if (rest.startsWith(g)) return { v, w, len: g.length };
  const ch = word[i]!;
  const vv = PURE_VOWEL[ch];
  if (vv) return { v: vv, w: W.vowel, len: 1 };
  const s = EN_SINGLE[ch];
  if (ch === "h") return { v: null, w: 0, len: 1 };
  return s ? { v: s[0], w: s[1], len: 1 } : { v: null, w: 0, len: 1 };
}

// ---- Japanese kana -> romaji -> pure-vowel ------------------------------
const ROWS: Array<[string, string[]]> = [
  ["", ["a", "i", "u", "e", "o"]], ["k", ["ka", "ki", "ku", "ke", "ko"]], ["g", ["ga", "gi", "gu", "ge", "go"]],
  ["s", ["sa", "shi", "su", "se", "so"]], ["z", ["za", "ji", "zu", "ze", "zo"]], ["t", ["ta", "chi", "tsu", "te", "to"]],
  ["d", ["da", "ji", "zu", "de", "do"]], ["n", ["na", "ni", "nu", "ne", "no"]], ["h", ["ha", "hi", "fu", "he", "ho"]],
  ["b", ["ba", "bi", "bu", "be", "bo"]], ["p", ["pa", "pi", "pu", "pe", "po"]], ["m", ["ma", "mi", "mu", "me", "mo"]],
  ["r", ["ra", "ri", "ru", "re", "ro"]],
];
const HIRA_ROWS = ["あいうえお", "かきくけこ", "がぎぐげご", "さしすせそ", "ざじずぜぞ", "たちつてと", "だぢづでど", "なにぬねの", "はひふへほ", "ばびぶべぼ", "ぱぴぷぺぽ", "まみむめも", "らりるれろ"];
const KANA_MAP = new Map<string, string>();
HIRA_ROWS.forEach((chars, ri) => [...chars].forEach((c, ci) => KANA_MAP.set(c, ROWS[ri]![1][ci]!)));
KANA_MAP.set("や", "ya"); KANA_MAP.set("ゆ", "yu"); KANA_MAP.set("よ", "yo"); KANA_MAP.set("わ", "wa"); KANA_MAP.set("を", "o"); KANA_MAP.set("ん", "n'");
const SMALL: Record<string, string> = { "ゃ": "ya", "ゅ": "yu", "ょ": "yo" };

function kataToHira(s: string): string {
  return s.replace(/[\u30A1-\u30F6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
}
const HAS_CJK_IDEOGRAPH = /[\u3400-\u9FFF\uF900-\uFAFF]/;
const IS_KANA_OR_LONG = /[\u3040-\u30FF\u31F0-\u31FF\uFF66-\uFF9F]/;

/** Converts kana text to romaji, keeping char offsets per emitted syllable. */
function kanaToRomajiUnits(word: string): Array<{ romaji: string; charStart: number; charEnd: number }> {
  const hira = kataToHira(word.normalize("NFKC"));
  const out: Array<{ romaji: string; charStart: number; charEnd: number }> = [];
  const chars = [...hira];
  let idx = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    const start = idx; idx += c.length;
    if (c === "っ") { out.push({ romaji: "_", charStart: start, charEnd: idx }); continue; }
    if (c === "ー") { out.push({ romaji: "-", charStart: start, charEnd: idx }); continue; }
    const base = KANA_MAP.get(c);
    if (!base) continue;
    const next = chars[i + 1];
    if (next && SMALL[next]) {
      const y = SMALL[next]!;
      const cons = base === "shi" ? "sh" : base === "chi" ? "ch" : base === "ji" ? "j" : base.slice(0, -1);
      out.push({ romaji: cons + y.slice(1), charStart: start, charEnd: idx + next.length });
      idx += next.length; i++;
    } else out.push({ romaji: base, charStart: start, charEnd: idx });
  }
  return out;
}

export function languageSupport(language: string, text: string): G2PSupport {
  const lang = (language || "en").toLowerCase().split(/[-_]/)[0]!;
  if (lang === "ja") return HAS_CJK_IDEOGRAPH.test(text) ? "unsupported" : (IS_KANA_OR_LONG.test(text) || /[A-Za-z]/.test(text) ? "full" : "unsupported");
  if (["en", "es", "it", "pt", "id", "ms", "tl", "fil", "de", "fr", "nl", "sv", "no", "da", "pl", "tr", "vi", "sw"].includes(lang)) return /[A-Za-z]/.test(text) ? "full" : "unsupported";
  return "unsupported"; // zh, ko, hi, te, ar, ru ... -> energy-only mouth
}

/** Words + their viseme units. Offsets index into `text` (UTF-16 code units). */
export function textToWordUnits(text: string, language: string): { words: WordUnits[]; support: G2PSupport } {
  const support = languageSupport(language, text);
  if (support === "unsupported") return { words: [], support };
  const lang = (language || "en").toLowerCase().split(/[-_]/)[0]!;
  const words: WordUnits[] = [];
  const re = /[\p{L}\p{M}][\p{L}\p{M}']*/gu;
  for (const m of text.matchAll(re)) {
    const raw = m[0]; const base = m.index ?? 0;
    const units: PhonUnit[] = [];
    if (IS_KANA_OR_LONG.test(raw) && lang === "ja") {
      for (const syl of kanaToRomajiUnits(raw)) {
        if (syl.romaji === "_") { units.push({ viseme: "REST", weight: 0.5, charStart: base + syl.charStart, charEnd: base + syl.charEnd }); continue; }
        if (syl.romaji === "-") { const last = units[units.length - 1]; if (last) last.weight += 0.8; continue; }
        if (syl.romaji === "n'") { units.push({ viseme: "MBP", weight: 0.6, charStart: base + syl.charStart, charEnd: base + syl.charEnd }); continue; }
        for (let i = 0; i < syl.romaji.length;) {
          const s = pureSymbolAt(syl.romaji, i); i += s.len;
          if (s.v) units.push({ viseme: s.v, weight: s.w, charStart: base + syl.charStart, charEnd: base + syl.charEnd });
        }
      }
    } else {
      const w = raw.toLowerCase().replace(/'/g, "");
      const symAt = lang === "en" ? enSymbolAt : pureSymbolAt;
      for (let i = 0; i < w.length;) {
        const s = symAt(w, i);
        if (s.v) units.push({ viseme: s.v, weight: s.w, charStart: base + i, charEnd: base + Math.min(raw.length, i + s.len) });
        i += s.len;
      }
    }
    if (units.length === 0) units.push({ viseme: "EH", weight: W.vowel, charStart: base, charEnd: base + raw.length });
    words.push({ word: raw, charStart: base, charEnd: base + raw.length, units });
  }
  return { words, support };
}

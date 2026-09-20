import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { OpenAITtsProvider } from "../../src/lib/ai/providers/openai/openai-tts-provider";
import { ProviderAuthError, ProviderNotConfiguredError, ProviderRequestError, ProviderTimeoutError } from "../../src/lib/ai/errors/provider-errors";

const realFetch = globalThis.fetch;
let calls: Array<{ url: string; init: RequestInit }> = [];
function stub(res: () => Promise<Response> | Response) { calls = []; (globalThis as { fetch: unknown }).fetch = async (url: string, init: RequestInit) => { calls.push({ url, init }); return res(); }; }
const ok = () => new Response(new Uint8Array([1, 2, 3]), { status: 200 });
const req = { text: "Hello", language: "en", voiceGender: "neutral" as const, voiceStyle: "calm" };

describe("OpenAITtsProvider", () => {
  beforeEach(() => { process.env.OPENAI_API_KEY = "k"; delete process.env.OPENAI_TTS_MODEL; });
  afterEach(() => { globalThis.fetch = realFetch; });
  it("reports a clear not-configured error without an API key", async () => {
    delete process.env.OPENAI_API_KEY;
    await expect(new OpenAITtsProvider().synthesize(req)).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
  it("sends the character's voice, clamped speed and delivery instructions (gpt-4o-mini-tts)", async () => {
    stub(ok);
    const p = new OpenAITtsProvider();
    expect(p.capabilities.instructions).toBe(true);
    const r = await p.synthesize({ ...req, voiceId: "nova", speed: 9, instructions: "Speak angrily." });
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body).toMatchObject({ voice: "nova", speed: 4, instructions: "Speak angrily.", input: "Hello", response_format: "mp3" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
    expect(Buffer.from(r.audioBase64, "base64")).toEqual(Buffer.from([1, 2, 3]));
  });
  it("does NOT send instructions to a model that does not support them (tts-1)", async () => {
    process.env.OPENAI_TTS_MODEL = "tts-1"; stub(ok);
    const p = new OpenAITtsProvider();
    expect(p.capabilities.instructions).toBe(false);
    await p.synthesize({ ...req, instructions: "Speak angrily." });
    expect("instructions" in JSON.parse(calls[0]!.init.body as string)).toBe(false);
  });
  it("maps 401 -> auth error, 500 -> request error with status, hang -> timeout", async () => {
    stub(() => new Response("no", { status: 401 }));
    await expect(new OpenAITtsProvider().synthesize(req)).rejects.toBeInstanceOf(ProviderAuthError);
    stub(() => new Response("boom", { status: 503 }));
    await expect(new OpenAITtsProvider().synthesize(req)).rejects.toBeInstanceOf(ProviderRequestError);
    (globalThis as { fetch: unknown }).fetch = (_u: string, init: RequestInit) => new Promise((_, rej) => (init.signal as AbortSignal).addEventListener("abort", () => rej(new Error("aborted"))));
    await expect(new OpenAITtsProvider().synthesize({ ...req, timeoutMs: 30 })).rejects.toBeInstanceOf(ProviderTimeoutError);
  });
});

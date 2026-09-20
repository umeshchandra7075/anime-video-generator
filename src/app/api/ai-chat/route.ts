import { NextRequest } from "next/server";
import { z } from "zod";
import { requireVerifiedAuth, clientIp } from "@/lib/auth/context";
import { ProviderFactory } from "@/lib/ai/factory/provider-factory";
import { checkRateLimit } from "@/lib/auth/rateLimit";
import { ok, fail } from "@/lib/api/response";
import { Errors } from "@/lib/api/errors";
import { ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";

const schema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(2000),
      }),
    )
    .min(1)
    .max(20), // caps both request size and provider cost per call
});

export async function POST(req: NextRequest) {
  try {
    const ctx = await requireVerifiedAuth(req);

    const rl = await checkRateLimit({
      key: `ai-chat:${ctx.userId}:${clientIp(req)}`,
      limit: 20,
      windowSeconds: 3600,
    });
    if (!rl.allowed) throw Errors.rateLimited(rl.retryAfterSeconds);

    const body = await req.json().catch(() => null);
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw Errors.validation("Invalid chat request.");

    const textProvider = ProviderFactory.getTextProvider();

    try {
      const reply = await textProvider.chat(parsed.data.messages);
      return ok({ reply });
    } catch (err) {
      if (err instanceof ProviderNotConfiguredError) {
        throw Errors.providerNotConfigured(err.provider);
      }
      if (err instanceof ProviderRequestError) {
        throw Errors.providerError("AI service is temporarily unavailable. Please try again shortly.");
      }
      throw err;
    }
  } catch (err) {
    return fail(err);
  }
}

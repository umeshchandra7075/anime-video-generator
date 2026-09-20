import { ProviderAuthError, ProviderNotConfiguredError, ProviderRequestError } from "@/lib/ai/errors/provider-errors";
import { logger } from "@/lib/logger";

const PROVIDER_NAME = "openai";

export function getOpenAiConfig() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new ProviderNotConfiguredError(PROVIDER_NAME);
  const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
  return { apiKey, baseUrl };
}

export async function openAiFetch(path: string, body: unknown): Promise<any> {
  const { apiKey, baseUrl } = getOpenAiConfig();

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new ProviderRequestError(PROVIDER_NAME, "Network error contacting OpenAI.");
  }

  if (res.status === 401 || res.status === 403) {
    throw new ProviderAuthError(PROVIDER_NAME);
  }

  if (!res.ok) {
    // Log details server-side only - never forward raw provider responses
    // (which can contain internal identifiers) to end users.
    const bodyText = await res.text().catch(() => "");
    logger.warn({ status: res.status, provider: PROVIDER_NAME, bodyText }, "provider_request_failed");
    throw new ProviderRequestError(
      PROVIDER_NAME,
      `OpenAI request failed with status ${res.status}.`,
      res.status,
    );
  }

  return res.json();
}

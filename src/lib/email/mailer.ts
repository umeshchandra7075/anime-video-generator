import { Resend } from "resend";
import { logger } from "@/lib/logger";

function getClient(): Resend | null {
  const apiKey = process.env.EMAIL_API_KEY;
  if (!apiKey) return null;
  return new Resend(apiKey);
}

async function send(to: string, subject: string, html: string) {
  const client = getClient();
  const from = process.env.EMAIL_FROM_ADDRESS ?? "no-reply@example.com";

  if (!client) {
    // Explicit, visible fallback rather than pretending the email sent.
    logger.warn({ to, subject }, "EMAIL_API_KEY not configured - email NOT sent");
    if (process.env.NODE_ENV !== "production") {
      // Helpful for local development only.
      // eslint-disable-next-line no-console
      console.log(`[DEV EMAIL - NOT SENT] To: ${to} | Subject: ${subject}\n${html}`);
    }
    return;
  }

  await client.emails.send({ from, to, subject, html });
}

export async function sendVerificationEmail(to: string, verifyUrl: string) {
  await send(
    to,
    "Verify your Anime Video Generator account",
    `<p>Welcome! Please verify your email by clicking the link below:</p>
     <p><a href="${verifyUrl}">${verifyUrl}</a></p>
     <p>This link expires in 24 hours.</p>`,
  );
}

export async function sendPasswordResetEmail(to: string, resetUrl: string) {
  await send(
    to,
    "Reset your Anime Video Generator password",
    `<p>We received a request to reset your password. Click below to continue:</p>
     <p><a href="${resetUrl}">${resetUrl}</a></p>
     <p>If you didn't request this, you can safely ignore this email. This link expires in 1 hour.</p>`,
  );
}

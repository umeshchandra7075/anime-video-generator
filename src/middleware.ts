import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Content-Security-Policy is generated per-request here (not as a static
 * header in next.config.js) so each response gets a fresh nonce.
 *
 * The dev/production split matters: Next's webpack dev server wraps modules
 * in eval() for fast rebuilds and source maps. A CSP without 'unsafe-eval'
 * in development silently blocks that eval, which means NO client
 * JavaScript executes at all - the page renders (server HTML) but every
 * click handler is dead and nothing you do in the browser ever reaches the
 * network tab. That failure mode looks exactly like "the page loads but
 * clicking the button does nothing." Production never needs eval, so
 * 'unsafe-eval' is never present there.
 */
export function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV !== "production";

  const scriptSrc = isDev ? `script-src 'self' 'nonce-${nonce}' 'unsafe-eval'` : `script-src 'self' 'nonce-${nonce}'`;
  // Next's dev server also opens a WebSocket for HMR (webpack-hmr) - CSP has
  // to explicitly allow it in dev or the connection is blocked (this alone
  // doesn't kill click handlers, but it does break fast refresh).
  const connectSrc = isDev ? "connect-src 'self' https: ws: wss:" : "connect-src 'self' https:";

  const csp = [
    "default-src 'self'",
    "img-src 'self' data: https:",
    "media-src 'self' https:",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'", // Tailwind/inline React styles need this regardless of environment
    connectSrc,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  return response;
}

export const config = {
  matcher: [
    // Apply to everything except static assets and image optimization output.
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};

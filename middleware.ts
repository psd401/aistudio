import { authMiddleware } from "@/auth";
import { NextResponse } from "next/server";
import { getArtifactSandboxOrigin } from "@/lib/content/artifact-sandbox-config";

// Public paths that don't require authentication
const PUBLIC_PATHS = [
  "/",
  "/signout",
  "/api/auth",
  "/api/public",
  "/api/health",
  "/api/healthz", // Lightweight health check for ECS/Docker
  "/api/ping",
  "/api/auth/federated-signout",
  "/api/assistant-architect/execute/scheduled", // Internal JWT auth for scheduled executions
  // SECURITY: All routes under /api/v1/* MUST use withApiAuth() wrapper.
  // This bypass only skips NextAuth session checks — API routes handle their own auth.
  "/api/v1", // External API routes handle their own auth via Bearer token (#677)
  "/api/mcp", // MCP endpoint handles its own auth via Bearer token (#686)
  "/api/oauth", // OAuth2/OIDC endpoints handle their own auth (#686)
  "/.well-known", // OIDC discovery document (#686)
  "/auth/error",
  // Agent Workspace OAuth bootstrap (#912) — all three endpoints authenticate
  // via signed tokens in the URL or a Bearer shared-secret from the agent
  // runtime. A PSD session is not required (and would be impossible on the
  // first visit, since consent happens outside the PSD web session).
  "/api/agent", // Agent-to-Next.js endpoints use Bearer shared-secret auth
  "/agent-connect", // Consent page and OAuth callback — signed JWT in URL
  // Canva consent flow (#1176): the /agent-connect-canva page authenticates via
  // the signed consent JWT in the URL and the callback via the one-time nonce +
  // PKCE verifier — a PSD web session is not required (and the OAuth callback
  // must stay reachable even if the user's session lapsed during the external
  // Canva authorize step). The match is `=== path || startsWith(path + "/")`, so
  // this single entry covers both /agent-connect-canva and …/callback while NOT
  // matching the separate /agent-connect exact route.
  "/agent-connect-canva",
  // Atrium public reader (#1057): /p/[slug] is the anonymous public_web reader
  // route (spec §20). It is world-readable by design — the page itself gates
  // strictly on visibility_level='public' + a live public_web publication and
  // consults no session — so it must NOT be redirected to sign-in. A non-public
  // or unpublished slug 404s (existence-masking), never redirects.
  "/p",
  // SEO endpoints (#1059): sitemap enumerates ONLY objects passing the exact
  // /p/[slug] public gate (app/sitemap.ts); robots.txt points crawlers at it.
  // Both must be crawler-reachable without a session or the /p/ content is
  // undiscoverable.
  "/sitemap.xml",
  "/robots.txt",
];

// Atrium artifact sandbox (#1052): the app embeds an <iframe> pointing at a
// SEPARATE origin that runs untrusted artifact code (spec §19.2/§28.1). The app's
// own CSP `frame-src` must explicitly allow that origin, or the browser blocks
// the frame. The origin (`ATRIUM_SANDBOX_ORIGIN`) is a CloudFront domain injected
// by the CDK deploy — known only at runtime — so the CSP is built HERE (middleware
// runs per request and can read runtime env) instead of in next.config (which is
// evaluated at build time).
//
// SINGLE SOURCE OF TRUTH: the origin is resolved via `getArtifactSandboxOrigin()`
// from artifact-sandbox-config.ts — the SAME resolver the iframe `src` uses. This
// guarantees the CSP `frame-src` entry and the iframe `src` resolve to byte-
// identical origins (including the same env-var priority and the same-origin
// fail-closed guard). A divergent local resolver here previously read the env vars
// in the opposite priority order, so a mixed local/CDK env could allowlist origin
// A while the iframe pointed at origin B → the browser silently blocks the frame.
// The shared module is Edge-Runtime safe (only `URL` + `process.env`).
//
// Built once at module init; the sandbox origin is stable for the process life.
// frame-src keeps 'self' + the Canva embed origin and appends the sandbox origin
// only when configured (otherwise the artifact preview frame is simply blocked,
// matching the component's fail-closed behavior).
const SANDBOX_FRAME_ORIGIN = getArtifactSandboxOrigin();
const FRAME_SRC = ["'self'", "https://www.canva.com", ...(SANDBOX_FRAME_ORIGIN ? [SANDBOX_FRAME_ORIGIN] : [])].join(" ");
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.amazonaws.com; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data: https: blob:; " +
  "font-src 'self' data:; " +
  "connect-src 'self' https://*.amazonaws.com wss://*.amazonaws.com https://api.anthropic.com https://api.openai.com; " +
  `frame-src ${FRAME_SRC}; ` +
  "frame-ancestors 'none';";

export default authMiddleware((req) => {
  const { nextUrl, auth } = req;
  const isLoggedIn = !!auth;

  // Check if path is public
  const isPublicPath = PUBLIC_PATHS.some(path => 
    nextUrl.pathname === path || nextUrl.pathname.startsWith(path + "/")
  );

  // Create response with security headers
  let response: NextResponse;
  // Track whether this is a passthrough (NextResponse.next()) response.
  // next.config.mjs headers() applies to passthrough responses, so HSTS and
  // Referrer-Policy are already set globally there. Only set them here on
  // direct responses (401s, redirects) to avoid duplicate headers that violate
  // RFC 6797 and could confuse security scanners.
  let isPassthrough = false;

  // Allow public paths
  if (isPublicPath) {
    response = NextResponse.next();
    isPassthrough = true;
  }
  // Allow static assets
  else if (
    nextUrl.pathname.startsWith("/_next") ||
    nextUrl.pathname.startsWith("/static") ||
    nextUrl.pathname.match(/\.(jpg|jpeg|png|gif|ico|css|js)$/i)
  ) {
    response = NextResponse.next();
    isPassthrough = true;
  }
  // Handle API routes differently - return 401 instead of redirecting
  else if (!isLoggedIn && nextUrl.pathname.startsWith("/api/")) {
    response = NextResponse.json(
      { error: "Unauthorized" },
      { status: 401 }
    );
  }
  // Redirect unauthenticated users to sign-in for non-API routes
  else if (!isLoggedIn) {
    response = NextResponse.redirect(new URL(`/api/auth/signin?callbackUrl=${encodeURIComponent(nextUrl.pathname)}`, nextUrl));
  }
  else {
    response = NextResponse.next();
    isPassthrough = true;
  }

  // Add security headers to all responses
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  // CSP is set here (not next.config) so frame-src can include the runtime-known
  // Atrium sandbox origin. Single source → no intersection with a build-time
  // policy. See next.config.mjs note (#1052).
  response.headers.set('Content-Security-Policy', CONTENT_SECURITY_POLICY);

  // HSTS and Referrer-Policy: set only on direct responses (401s, redirects)
  // where next.config.mjs headers() does not apply. The ALB terminates TLS;
  // HSTS tells browsers to always use HTTPS when connecting to the ALB.
  // Passthrough responses receive these headers from next.config.mjs headers().
  if (!isPassthrough) {
    response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  }

  return response;
});

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/auth (NextAuth routes)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     */
    "/((?!api/auth|_next/static|_next/image|favicon.ico).*)",
  ],
};

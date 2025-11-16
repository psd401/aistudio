import { authMiddleware } from "@/auth";
import { NextResponse } from "next/server";

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
  "/auth/error",
];

export default authMiddleware((req) => {
  const { nextUrl, auth } = req;
  const isLoggedIn = !!auth;

  // Check if path is public
  const isPublicPath = PUBLIC_PATHS.some(path => 
    nextUrl.pathname === path || nextUrl.pathname.startsWith(path + "/")
  );

  // Create response with security headers
  let response: NextResponse;

  // Allow public paths
  if (isPublicPath) {
    response = NextResponse.next();
  }
  // Allow static assets
  else if (
    nextUrl.pathname.startsWith("/_next") ||
    nextUrl.pathname.startsWith("/static") ||
    nextUrl.pathname.match(/\.(jpg|jpeg|png|gif|ico|css|js)$/i)
  ) {
    response = NextResponse.next();
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
  }

  // Add security headers to all responses
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  response.headers.set('Pragma', 'no-cache');
  response.headers.set('Expires', '0');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('X-XSS-Protection', '1; mode=block');
  
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
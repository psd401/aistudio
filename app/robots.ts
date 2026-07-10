/**
 * robots.txt for the app — Epic #1059 (Atrium public reader SEO).
 *
 * Allow-all: the only anonymously readable pages are the Atrium public reader
 * (`/p/[slug]`) and the landing page; everything else redirects crawlers to
 * sign-in (middleware), so a broad allow costs nothing and never needs updating
 * as public surfaces are added. Points crawlers at /sitemap.xml, which
 * enumerates exactly the live public_web publications.
 *
 * `force-dynamic`: the sitemap URL is built from the runtime
 * `ATRIUM_PUBLIC_BASE_URL` (the same env the reader links use), which is not
 * available at image build time — so resolve it per request. When it is unset,
 * the sitemap line is simply omitted (fail soft).
 */

import type { MetadataRoute } from "next";

export const dynamic = "force-dynamic";

export default function robots(): MetadataRoute.Robots {
  const base = process.env.ATRIUM_PUBLIC_BASE_URL?.replace(/\/$/, "");
  return {
    rules: {
      userAgent: "*",
      allow: "/",
    },
    ...(base ? { sitemap: `${base}/sitemap.xml` } : {}),
  };
}

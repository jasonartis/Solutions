import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-tools indicator is a fixed-position overlay (bottom-left
  // by default) that can sit on top of real page content and intercept clicks
  // — a real Playwright actionability hazard in dev mode, never present in
  // production (this key is a no-op on `next build`/`next start`).
  devIndicators: false,
  experimental: {
    // Next's default caps a Server Action's request body at 1 MB, which refused
    // every picture over that (visual messaging uploads). The browser shrinks
    // pictures to <= 3.2 MB first (modules/visual-messaging/ui/image-shrink.ts);
    // 4 MB leaves room for the multipart wrapper and stays under Vercel's ~4.5 MB
    // request-body ceiling, which no setting here can raise.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;

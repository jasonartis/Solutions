import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The floating dev-tools indicator is a fixed-position overlay (bottom-left
  // by default) that can sit on top of real page content and intercept clicks
  // — a real Playwright actionability hazard in dev mode, never present in
  // production (this key is a no-op on `next build`/`next start`).
  devIndicators: false,
};

export default nextConfig;

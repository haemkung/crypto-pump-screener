import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloudflare / OpenNext: avoid Node-only image optimizer defaults
  images: {
    unoptimized: true,
  },
};

export default nextConfig;

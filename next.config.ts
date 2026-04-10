import type { NextConfig } from "next";

const config: NextConfig = {
  // The `kb/` directory is user content, not part of the build graph.
  // Next.js should not try to watch or compile anything in it.
  experimental: {
    serverActions: { bodySizeLimit: "5mb" },
  },
};

export default config;

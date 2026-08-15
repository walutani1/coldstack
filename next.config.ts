import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Server Actions cap request bodies at 1MB by default. The Zapmail
    // profile-image upload allows images up to 2MB (validated in the action),
    // so raise the limit with multipart headroom or a valid image is rejected
    // by the framework before the action runs.
    serverActions: {
      bodySizeLimit: "3mb",
    },
  },
  // The tab moved from /prospects to /enrichment, matching what the tables
  // have always been called underneath. Old bookmarks and deep links to a
  // workbook or table keep working. /api/prospects/run-tick is a different
  // path and is deliberately untouched.
  async redirects() {
    return [
      { source: "/prospects", destination: "/enrichment", permanent: false },
      { source: "/prospects/:path*", destination: "/enrichment/:path*", permanent: false },
    ];
  },
};

export default nextConfig;

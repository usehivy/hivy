import { withSentryConfig } from "@sentry/nextjs"

/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // No image optimization: logos load directly from their src (local
    // /logomarks/* from the app origin, integration logos from the connections
    // host). Keeps the prebuilt image domain-agnostic without a remotePatterns
    // allowlist or a custom loader.
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      {
        source: "/ingest/array/:path*",
        destination: "https://us-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/ingest/:path*",
        destination: "https://us.i.posthog.com/:path*",
      },
    ]
  },
  async redirects() {
    return [
      {
        source: "/demo",
        destination: "https://hivy.zohobookings.com/#/discovery-call",
        permanent: false,
      },
    ]
  },
  reactStrictMode: false,
  skipTrailingSlashRedirect: true,
  // Base44 preview: allow the sandbox preview origin for dev assets/HMR.
  allowedDevOrigins: process.env.BASE44_PUBLIC_HOST_SUFFIX
    ? ["3000-" + process.env.BASE44_PUBLIC_HOST_SUFFIX]
    : [],
}

export default withSentryConfig(nextConfig, {
  // For all available options, see:
  // https://www.npmjs.com/package/@sentry/webpack-plugin#options

  url: process.env.HIVY_SENTRY_URL ?? "https://sentry.usehivy.com/",

  // Bugsink accepts Sentry-compatible source map uploads, but it does not use
  // Sentry org/project values for matching. Debug IDs injected into source maps
  // are the important part.
  org: process.env.HIVY_SENTRY_ORG ?? "bugsinkhasnoorgs",

  project: process.env.HIVY_SENTRY_PROJECT ?? "ignoredfornow",

  telemetry: true,

  // Only print logs for uploading source maps in CI
  silent: !process.env.CI,

  // For all available options, see:
  // https://docs.sentry.io/platforms/javascript/guides/nextjs/manual-setup/

  // Upload a larger set of source maps for prettier stack traces (increases build time)
  widenClientFileUpload: true,

  // Route browser requests to Sentry through a Next.js rewrite to circumvent ad-blockers.
  // This can increase your server load as well as your hosting bill.
  // Note: Check that the configured route will not match with your Next.js middleware, otherwise reporting of client-
  // side errors will fail.
  tunnelRoute: "/monitoring",

  webpack: {
    // Enables automatic instrumentation of Vercel Cron Monitors. (Does not yet work with App Router route handlers.)
    // See the following for more information:
    // https://docs.sentry.io/product/crons/
    // https://vercel.com/docs/cron-jobs
    automaticVercelMonitors: true,

    // Tree-shaking options for reducing bundle size
    treeshake: {
      // Automatically tree-shake Sentry logger statements to reduce bundle size
      removeDebugLogging: true,
    },
  },
})

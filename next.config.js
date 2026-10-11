/** @type {import('next').NextConfig} */

const isProd = process.env.NODE_ENV === 'production';

/**
 * Content-Security-Policy (Phase 11).
 *
 * - script-src needs 'unsafe-inline' because Next.js 14 emits inline
 *   bootstrap scripts (a nonce-based policy would require dynamic rendering
 *   of every page). 'unsafe-eval' is added in development only (React
 *   refresh needs it).
 * - AI-generated games render in a sandboxed <iframe srcdoc> with their own
 *   stricter CSP (src/lib/games/preview.ts); a srcdoc frame also inherits
 *   this policy, so frame-src allows about:/blob:/data:.
 * - connect-src 'self': the browser/WebView only ever talks to this app's
 *   own API. Every third-party call (AI providers, search, Google Play
 *   verification) is made server-side, so no provider hosts appear here —
 *   and no API key can be used from the client.
 * - frame-ancestors 'none' mirrors X-Frame-Options: DENY.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isProd ? '' : " 'unsafe-eval'"}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self' about: blob: data:",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  { key: 'Content-Security-Policy', value: csp },
  { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ...(isProd ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

const nextConfig = {
  reactStrictMode: true,
  // Never expose server secrets to the client bundle.
  // Only variables explicitly prefixed with NEXT_PUBLIC_ are exposed by Next.js.
  poweredByHeader: false,
  compress: true,
  productionBrowserSourceMaps: false,
  // Smaller client bundles: lucide-react ships hundreds of icons.
  experimental: {
    optimizePackageImports: ['lucide-react'],
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders,
      },
      {
        // Immutable, hashed build assets can be cached hard (faster repeat loads on phones).
        source: '/_next/static/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
      },
      {
        source: '/icons/:path*',
        headers: [{ key: 'Cache-Control', value: 'public, max-age=86400' }],
      },
    ];
  },
};

module.exports = nextConfig;

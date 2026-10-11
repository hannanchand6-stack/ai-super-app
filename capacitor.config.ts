import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor (Android) shell configuration.
 *
 * ARCHITECTURE: this app is a Next.js SERVER app (API routes, Prisma, NextAuth,
 * server-side AI keys), so it cannot be exported to static files and bundled
 * inside the APK. The Android app is a native shell whose WebView loads the
 * deployed HTTPS site (`server.url`). Consequences, all intentional:
 *   - NO secret ever ships in the APK: API keys, DB credentials and Google
 *     Play service-account JSON live only on the server.
 *   - Requests are same-origin to that site, so the CSRF/origin check, cookies
 *     and CSP in the web app work unchanged.
 *   - Web changes go live without a new APK; native changes (billing plugin)
 *     need a new build.
 *
 * Set CAP_SERVER_URL to the production https:// URL before `npx cap sync android`.
 * (Must equal NEXTAUTH_URL on the server.)
 */
const serverUrl = process.env.CAP_SERVER_URL;

if (!serverUrl) {
  throw new Error('CAP_SERVER_URL is not set. Export your deployed HTTPS URL, e.g. CAP_SERVER_URL=https://app.example.com');
}
if (!/^https:\/\//i.test(serverUrl) && process.env.CAP_ALLOW_CLEARTEXT_DEV !== 'true') {
  throw new Error('CAP_SERVER_URL must be https:// (set CAP_ALLOW_CLEARTEXT_DEV=true ONLY for a local debug build).');
}
const devCleartext = process.env.CAP_ALLOW_CLEARTEXT_DEV === 'true';

const config: CapacitorConfig = {
  appId: process.env.CAP_APP_ID || 'com.aisuperapp.app', // must match GOOGLE_PLAY_PACKAGE_NAME on the server
  appName: 'AI Super App',
  // Capacitor requires a webDir even when server.url is used; this folder only holds a tiny offline fallback page.
  webDir: 'mobile/www',
  server: {
    url: serverUrl,
    cleartext: devCleartext,
    androidScheme: 'https',
    // The WebView may only navigate inside our own host; any other link opens in the system browser.
    allowNavigation: [new URL(serverUrl).host],
    errorPath: 'offline.html',
  },
  android: {
    allowMixedContent: false,
    webContentsDebugEnabled: devCleartext, // never true in release builds
    loggingBehavior: devCleartext ? 'debug' : 'none',
  },
};

export default config;

/** @type {import('next').NextConfig} */
// PAGES=1 switches to a static export for GitHub Pages. Gated on an env var so
// `npm run dev` and `npm start` keep their normal behaviour — a prototype that
// can only be built one way is a prototype nobody runs locally.
const pages = process.env.PAGES === '1';

const nextConfig = {
  // A prototype, not a product: no telemetry, no image optimisation server.
  images: { unoptimized: true },
  /*
   * `next dev` binds to localhost and treats a request from 127.0.0.1 as a
   * different host, answering 403 for every /_next/static chunk. The page still
   * server-renders, so the symptom is subtle: the HTML looks right and nothing
   * hydrates, which reads as "the data layer did not fetch" rather than "the
   * bundle never loaded". Both browser suites drive 127.0.0.1, so this is a
   * prerequisite for any of them to be meaningful.
   */
  allowedDevOrigins: ['127.0.0.1'],
  ...(pages ? {
    output: 'export',
    // Pages serves a project site from /<repo>/, so every asset and link needs
    // the prefix or the CSS 404s and the rail stops navigating.
    basePath: '/HAFleet',
    assetPrefix: '/HAFleet',
    // Pages has no rewrite layer, so /resources must resolve as a directory
    // with an index.html rather than a bare file.
    trailingSlash: true,
  } : {}),
};
export default nextConfig;

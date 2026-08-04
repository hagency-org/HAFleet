/** @type {import('next').NextConfig} */
const nextConfig = {
  // A prototype, not a product: no telemetry, no image optimisation server.
  images: { unoptimized: true },
};
export default nextConfig;

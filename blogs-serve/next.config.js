/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // No React devtools needed — pages are pure server-rendered HTML strings.
  compress: true,
};

module.exports = nextConfig;

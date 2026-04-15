/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Required for GitHub Pages: export a fully static site instead of a server-rendered build.
  // GitHub Pages has no Node.js server, so every page must be pre-rendered to HTML at build time.
  output: 'export',

  // The repo is published at https://tj60647.github.io/Virtual-Colloquy-Direction-Indicator/
  // so all asset and link paths need the repo name as a prefix.
  // Remove or override this value if the site is ever served from a custom domain at the root.
  basePath: '/Virtual-Colloquy-Direction-Indicator',
};

export default nextConfig;

/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3", "sqlite-vec", "node-llama-cpp"],
  },
};

export default nextConfig;

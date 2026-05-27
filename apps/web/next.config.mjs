import createNextIntlPlugin from "next-intl/plugin";

const withNextIntl = createNextIntlPlugin("./src/i18n/request.ts");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@vtm/shared"],
  // Silero VAD ships WASM + ONNX runtime; both need to be served from /public
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      path: false,
      crypto: false
    };
    return config;
  },
  experimental: {
    // Required for AudioWorklet imports in dev
    esmExternals: true
  }
};

export default withNextIntl(nextConfig);

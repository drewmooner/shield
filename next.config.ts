import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    const raw = process.env.BACKEND_URL || process.env.NEXT_PUBLIC_API_URL || "";
    const normalized = raw ? raw.replace(/\/api\/?$/, "") : "";
    const backendUrl = normalized || (process.env.NODE_ENV === "development" ? "http://localhost:3002" : "");

    if (!backendUrl) {
      // Avoid broken localhost rewrites in production when API env vars are missing.
      return [];
    }

    return [
      {
        source: '/api/:path*',
        destination: `${backendUrl}/api/:path*`,
      },
      // Socket.IO rewrite - needed for WebSocket connections
      {
        source: '/socket.io/:path*',
        destination: `${backendUrl}/socket.io/:path*`,
      },
    ];
  },
};

export default nextConfig;

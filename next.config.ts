import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // For production: Use NEXT_PUBLIC_API_URL if set (e.g. https://your-backend.up.railway.app/api)
    // If unset at build time, rewrites point to localhost → ECONNREFUSED on Railway.
    const raw = process.env.NEXT_PUBLIC_API_URL || '';
    const backendUrl = raw ? raw.replace(/\/api\/?$/, '') : 'http://localhost:3002';
    
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

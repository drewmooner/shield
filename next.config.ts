import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async rewrites() {
    // For production: Use NEXT_PUBLIC_API_URL if set (Railway backend)
    // For development: Use localhost
    const backendUrl = process.env.NEXT_PUBLIC_API_URL 
      ? process.env.NEXT_PUBLIC_API_URL.replace('/api', '') // Remove /api if present
      : 'http://localhost:3002';
    
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

'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

let globalSocket: Socket | null = null;
let connectionCount = 0;

function getSocketUrl(): string {
  if (typeof window === 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL?.replace(/\/api\/?$/, '') || 'http://localhost:3002';
  }

  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl && !apiUrl.startsWith('/')) {
    return apiUrl.replace(/\/api\/?$/, '');
  }

  // Connect directly to backend - rewrites can fail with Socket.IO polling
  const host = window.location.hostname;
  const port = 3002;
  return `http://${host}:${port}`;
}

function getOrCreateSocket(): Socket {
  if (globalSocket) {
    console.log('♻️ Reusing existing socket:', globalSocket.id);
    return globalSocket;
  }

  const url = getSocketUrl();
  console.log('🔌 Creating Socket.IO connection (polling) to:', url);

  globalSocket = io(url, {
    // ✅ Use polling only (more reliable, was working perfectly before)
    transports: ['polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    path: '/socket.io/',
    autoConnect: true,
    timeout: 20000,
    forceNew: false,
    upgrade: false, // Disable upgrade to websocket
  });

  globalSocket.on('connect', () => {
    console.log('✅ Socket.IO connected (polling):', globalSocket?.id);
  });

  globalSocket.on('disconnect', (reason) => {
    console.log('❌ Socket.IO disconnected:', reason);
  });

  let errorLogged = false;
  globalSocket.on('connect_error', (error) => {
    // Only log error once to reduce spam
    if (!errorLogged) {
      console.error('❌ Socket.IO connection error:', error.message);
      console.error('   💡 Backend not running? Start it with: cd backend && npm start');
      errorLogged = true;
    }
  });
  
  globalSocket.on('connect', () => {
    errorLogged = false; // Reset on successful connection
  });

  return globalSocket;
}

export function useSocket(consumerName: string = 'Unknown') {
  const [connected, setConnected] = useState<boolean>(
    () => globalSocket?.connected ?? false
  );

  useEffect(() => {
    const socket = getOrCreateSocket();
    connectionCount++;
    setConnected(socket.connected);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      connectionCount--;

      if (connectionCount <= 0) {
        globalSocket?.close();
        globalSocket = null;
        connectionCount = 0;
      }
    };
  }, [consumerName]);

  return { socket: globalSocket ?? getOrCreateSocket(), connected };
}

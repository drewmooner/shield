'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { getToken } from './auth';

let globalSocket: Socket | null = null;
let connectionCount = 0;

function getSocketUrl(): string {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl && !apiUrl.startsWith('/')) {
    return apiUrl.replace(/\/api\/?$/, '');
  }
  if (typeof window === 'undefined') {
    return 'http://localhost:3002';
  }
  return `${window.location.origin}/api`.replace(/\/api\/?$/, '') || 'http://localhost:3002';
}

function getOrCreateSocket(): Socket {
  if (globalSocket) return globalSocket;
  const url = getSocketUrl();
  const token = getToken();
  globalSocket = io(url, {
    auth: token ? { token } : {},
    transports: ['polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity,
    path: '/socket.io/',
    autoConnect: true,
    timeout: 20000,
    forceNew: false,
    upgrade: false,
  });

  globalSocket.on('connect', () => {
    console.log('✅ Socket.IO connected (polling):', globalSocket?.id);
  });

  globalSocket.on('disconnect', (reason) => {
    console.log('❌ Socket.IO disconnected:', reason);
  });

  let errorLogged = false;
  globalSocket.on('connect_error', (error) => {
    if (!errorLogged) {
      console.error('❌ Socket.IO connection error:', error.message);
      errorLogged = true;
    }
  });
  globalSocket.on('connect', () => {
    errorLogged = false;
  });

  return globalSocket;
}

export function useSocket(consumerName: string = 'Unknown') {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [connected, setConnected] = useState<boolean>(false);

  useEffect(() => {
    const s = getOrCreateSocket();
    setSocket(s);
    connectionCount++;
    setConnected(s.connected);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      connectionCount--;
      if (connectionCount <= 0) {
        globalSocket?.close();
        globalSocket = null;
        connectionCount = 0;
      }
    };
  }, [consumerName]);

  return {
    socket,
    connected,
  };
}

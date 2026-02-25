'use client';

import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { ensureClientId } from './api';

let globalSocket: Socket | null = null;
let connectionCount = 0;
let globalClientId: string | null = null;

function getSocketUrl(): string {
  // Use same backend as API (Render when NEXT_PUBLIC_API_URL is set on Vercel)
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  if (apiUrl && !apiUrl.startsWith('/')) {
    return apiUrl.replace(/\/api\/?$/, '');
  }
  if (typeof window === 'undefined') {
    return 'http://localhost:3002';
  }
  return `${window.location.origin}/api`.replace(/\/api\/?$/, '') || 'http://localhost:3002';
}

function getOrCreateSocket(clientId: string): Socket {
  if (globalSocket && globalClientId === clientId) {
    return globalSocket;
  }
  if (globalSocket) {
    globalSocket.close();
    globalSocket = null;
  }
  globalClientId = clientId;
  const url = getSocketUrl();
  globalSocket = io(url, {
    auth: { clientId },
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
  const [clientId, setClientId] = useState<string | null>(null);
  const [connected, setConnected] = useState<boolean>(false);

  useEffect(() => {
    ensureClientId().then(setClientId);
  }, []);

  useEffect(() => {
    if (!clientId) return;
    const socket = getOrCreateSocket(clientId);
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
        globalClientId = null;
        connectionCount = 0;
      }
    };
  }, [clientId, consumerName]);

  return {
    socket: clientId ? getOrCreateSocket(clientId) : null,
    connected,
  };
}

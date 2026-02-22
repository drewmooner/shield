'use client';

import { createContext, useContext, ReactNode } from 'react';
import { useSocket } from '../lib/useSocket';
import { Socket } from 'socket.io-client';

interface SocketContextValue {
  socket: Socket | null;
  connected: boolean;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  // ✅ Call useSocket ONLY HERE - once for the entire app
  const { socket, connected } = useSocket('AppRoot');

  console.log('🌐 SocketProvider render - connected:', connected);

  return (
    <SocketContext.Provider value={{ socket, connected }}>
      {children}
    </SocketContext.Provider>
  );
}

// ✅ Export a hook for components to consume the socket
export function useSocketContext() {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocketContext must be used within SocketProvider');
  }
  return context;
}

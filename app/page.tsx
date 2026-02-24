'use client';

import { useState, useEffect } from 'react';
import QRAuth from './components/QRAuth';
import Nav from './components/Nav';
import StatusBar from './components/StatusBar';
import Dashboard from './components/Dashboard';
import { getBotStatus } from './lib/api';
import { useSocketContext } from './providers/SocketProvider';

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const { socket, connected: socketConnected } = useSocketContext();

  // Check connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      try {
        const status = await getBotStatus();
        setIsConnected(status.status === 'connected' && status.isConnected);
      } catch (err) {
        console.error('Error checking connection:', err);
        setIsConnected(false);
      } finally {
        setChecking(false);
      }
    };

    checkConnection();
  }, []);

  // Listen for status updates via WebSocket
  useEffect(() => {
    if (!socket || !socketConnected) return;

    const handleStatusUpdate = (data: Record<string, unknown>) => {
      setIsConnected(data.status === 'connected' && Boolean(data.isConnected));
    };

    socket.on('status_update', handleStatusUpdate);

    return () => {
      socket.off('status_update', handleStatusUpdate);
    };
  }, [socket, socketConnected]);

  // Show loading while checking initial status
  if (checking) {
  return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-zinc-900 dark:border-zinc-50 mx-auto mb-4"></div>
          <p className="text-zinc-600 dark:text-zinc-400">Checking connection...</p>
        </div>
      </div>
    );
  }

  // Show QR code screen if not connected
  if (!isConnected) {
    return <QRAuth onConnected={() => setIsConnected(true)} />;
  }

  // Show dashboard if connected
  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-black">
      <Nav />
      <div className="flex-1 flex flex-col lg:ml-0">
        <StatusBar />
        <main className="flex-1 overflow-y-auto">
          <Dashboard />
        </main>
      </div>
    </div>
  );
}

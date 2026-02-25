'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import QRAuth from './components/QRAuth';
import Nav from './components/Nav';
import StatusBar from './components/StatusBar';
import Dashboard from './components/Dashboard';
import { getBotStatus } from './lib/api';
import { useSocketContext } from './providers/SocketProvider';

const INITIAL_CHECK_TIMEOUT_MS = 10_000;

export default function Home() {
  const [isConnected, setIsConnected] = useState(false);
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [hasBeenConnected, setHasBeenConnected] = useState(false);
  const [checking, setChecking] = useState(true);
  const { socket, connected: socketConnected } = useSocketContext();
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onConnected = useCallback(() => {
    setIsConnected(true);
    setHasBeenConnected(true);
  }, []);

  // Check connection status on mount (with timeout so we never hang)
  useEffect(() => {
    let cancelled = false;

    const checkConnection = async () => {
      try {
        const status = await getBotStatus();
        if (cancelled) return;
        const connected = status.status === 'connected' && Boolean(status.isConnected);
        setIsConnected(connected);
        if (connected) setHasBeenConnected(true);
        const reconnecting = status.status === 'reconnecting' || status.status === 'connecting';
        setIsReconnecting(reconnecting);
      } catch (err) {
        if (!cancelled) {
          console.error('Error checking connection:', err);
          setIsConnected(false);
          setIsReconnecting(false);
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };

    timeoutRef.current = setTimeout(() => {
      setChecking((c) => {
        if (c) console.warn('Initial connection check timed out – showing UI');
        return false;
      });
    }, INITIAL_CHECK_TIMEOUT_MS);

    checkConnection();

    return () => {
      cancelled = true;
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, []);

  // Listen for status updates via WebSocket
  useEffect(() => {
    if (!socket || !socketConnected) return;

    const handleStatusUpdate = (data: Record<string, unknown>) => {
      const status = data.status as string | undefined;
      const connected = status === 'connected' && Boolean(data.isConnected);
      const reconnecting = status === 'reconnecting' || status === 'connecting';

      setIsConnected(connected);
      setIsReconnecting(reconnecting);
      if (connected) setHasBeenConnected(true);
    };

    socket.on('status_update', handleStatusUpdate);

    return () => {
      socket.off('status_update', handleStatusUpdate);
    };
  }, [socket, socketConnected]);

  // Show dashboard if connected OR reconnecting (after we've been connected once) – keeps Shield UI visible during flapping
  const showDashboard = isConnected || (isReconnecting && hasBeenConnected);

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

  // Show QR code screen only when not connected and not reconnecting (or never connected yet)
  if (!showDashboard) {
    return <QRAuth onConnected={onConnected} />;
  }

  // Show dashboard (connected or reconnecting – StatusBar shows reconnecting state)
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

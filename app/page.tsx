'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import QRAuth from './components/QRAuth';
import Nav from './components/Nav';
import StatusBar from './components/StatusBar';
import Dashboard from './components/Dashboard';
import { getBotStatus } from './lib/api';
import { useSocketContext } from './providers/SocketProvider';
import { useAuth } from './providers/AuthProvider';
import { useRouter } from 'next/navigation';

const INITIAL_CHECK_TIMEOUT_MS = 5_000;

export default function Home() {
  const router = useRouter();
  const { isAuthenticated, loading: authLoading } = useAuth();
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

  useEffect(() => {
    if (!authLoading && !isAuthenticated) router.replace('/login');
  }, [authLoading, isAuthenticated, router]);

  // Check connection status on mount (short timeout so QR screen shows quickly)
  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
    let cancelled = false;
    const ac = new AbortController();
    const timeoutId = setTimeout(() => ac.abort(), INITIAL_CHECK_TIMEOUT_MS);

    const checkConnection = async () => {
      try {
        const status = await getBotStatus({ signal: ac.signal });
        if (cancelled) return;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
        clearTimeout(timeoutId);
        const connected = status.status === 'connected' && Boolean(status.isConnected);
        setIsConnected(connected);
        if (connected) setHasBeenConnected(true);
        const reconnecting = status.status === 'reconnecting' || status.status === 'connecting';
        setIsReconnecting(reconnecting);
      } catch (err) {
        if (!cancelled) {
          if ((err as Error).name !== 'AbortError') console.error('Error checking connection:', err);
          setIsConnected(false);
          setIsReconnecting(false);
        }
      } finally {
        if (!cancelled) {
          if (timeoutRef.current) clearTimeout(timeoutRef.current);
          timeoutRef.current = null;
          setChecking(false);
        }
      }
    };

    timeoutRef.current = setTimeout(() => {
      ac.abort();
      setChecking((c) => {
        if (c) console.warn('Initial connection check timed out – showing UI');
        return false;
      });
    }, INITIAL_CHECK_TIMEOUT_MS);

    checkConnection();

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      ac.abort();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [authLoading, isAuthenticated]);

  // Listen for status updates via WebSocket
  useEffect(() => {
    if (authLoading || !isAuthenticated) return;
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
  }, [authLoading, isAuthenticated, socket, socketConnected]);

  // Show dashboard if connected OR reconnecting (after we've been connected once) – keeps Shield UI visible during flapping
  const showDashboard = isConnected || (isReconnecting && hasBeenConnected);

  // Keep splash while auth state initializes or redirecting to login.
  if (authLoading || !isAuthenticated || checking) {
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

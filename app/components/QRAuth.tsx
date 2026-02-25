'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode.react';
import { useSocketContext } from '../providers/SocketProvider';
import { getBotStatus, reconnectBot } from '../lib/api';

interface BotStatus {
  status: string;
  qr?: string;
  isConnected?: boolean;
  timestamp?: string;
  reconnectAttempts?: number;
  reason?: string;
}

export default function QRAuth({ onConnected }: { onConnected: () => void }) {
  const [status, setStatus] = useState<BotStatus>({ status: 'initializing' });
  const [error, setError] = useState<string | null>(null);
  const { socket, connected } = useSocketContext();

  // Per-request timeout (fail fast so we can retry sooner)
  const REQUEST_TIMEOUT_MS = 8000;
  // Short delays between retries (1s, 2s, 3s) so QR shows sooner when backend is up
  const retryDelayMs = (attempt: number) => 1000 * (attempt + 1);

  const checkStatus = async (retries: number, cancelled: { current: boolean }): Promise<boolean> => {
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (cancelled.current) return false;
      try {
        const ctrl = new AbortController();
        const id = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
        const data = await getBotStatus({ signal: ctrl.signal });
        clearTimeout(id);
        if (cancelled.current) return false;
        setStatus(data);
        setError(null);
        if (data.status === 'connected' && data.isConnected) {
          onConnected();
        }
        return true;
      } catch (err: unknown) {
        if (cancelled.current) return false;
        const msg = (err instanceof Error ? err.message : String(err)) || '';
        const isRetryable = msg.includes('503') || msg.includes('502');
        if (isRetryable && attempt < retries) {
          await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
          continue;
        }
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
          continue;
        }
        setError('Failed to connect to backend. The service may be starting (wait and retry), or check that the backend URL is correct.');
        console.error('Backend connection error:', err);
        return false;
      }
    }
    return false;
  };

  // Single status check on mount; ignore results if effect cleaned up (avoids race with old requests)
  useEffect(() => {
    const cancelled = { current: false };
    checkStatus(4, cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [onConnected]);

  // Set up WebSocket listener for real-time status updates
  useEffect(() => {
    if (!socket || !connected) return;

    const handleStatusUpdate = (data: BotStatus) => {
      // Keep showing last QR when backend sends qr_ready without new qr (e.g. qr_regenerating)
      setStatus((prev) => {
        const next = { ...data };
        if (data.status === 'qr_ready' && !next.qr && prev.qr) next.qr = prev.qr;
        return next;
      });
      setError(null);

      if (data.status === 'connected' && data.isConnected) {
        onConnected();
      }
    };

    socket.on('status_update', handleStatusUpdate);

    return () => {
      socket.off('status_update', handleStatusUpdate);
    };
  }, [socket, connected, onConnected]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-6 sm:p-8 text-center w-full max-w-md">
          <div className="mb-4">
            <svg 
              className="w-12 h-12 mx-auto text-zinc-400 dark:text-zinc-600" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414" 
              />
            </svg>
          </div>
          <h2 className="text-lg font-semibold mb-3 text-black dark:text-zinc-50">
            Service Temporarily Unavailable
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400 mb-6">
            We&apos;re having trouble connecting right now. Please try again in a moment.
          </p>
          <button
            onClick={() => {
              setError(null);
              setStatus({ status: 'initializing' });
              checkStatus(4, { current: false });
            }}
            className="px-6 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  // Show QR screen for qr_ready (and when reconnecting but we still have a QR – seamless refresh)
  const qrValue = status.qr;
  const showQr = (status.status === 'qr_ready' || (status.status === 'reconnecting' && qrValue)) && qrValue;
  const isRefreshingQr = status.reason === 'qr_regenerating';
  if (showQr && qrValue) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-6 sm:p-8 text-center w-full max-w-md">
          <h1 className="text-xl sm:text-2xl font-semibold mb-2 text-black dark:text-zinc-50">
            Shield WhatsApp Login
          </h1>
          <p className="text-sm sm:text-base text-zinc-600 dark:text-zinc-400 mb-4 sm:mb-6">
            {isRefreshingQr ? 'Refreshing QR code...' : 'Scan this QR code with WhatsApp to connect'}
          </p>
          <div className="flex justify-center mb-4 sm:mb-6 p-2 sm:p-4 bg-white rounded-lg">
            <QRCode value={qrValue} size={Math.min(256, typeof window !== 'undefined' ? window.innerWidth - 80 : 256)} />
          </div>
          <p className="text-sm text-zinc-500 dark:text-zinc-500">
            Open WhatsApp → Settings → Linked Devices → Link a Device
          </p>
        </div>
      </div>
    );
  }

  if (status.status === 'connecting' || status.status === 'initializing') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-zinc-900 dark:border-zinc-50 mx-auto mb-4"></div>
          <p className="text-zinc-600 dark:text-zinc-400">
            {status.status === 'initializing' ? 'Initializing...' : 'Connecting...'}
          </p>
        </div>
      </div>
    );
  }

  if (status.status === 'reconnecting') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-zinc-900 dark:border-zinc-50 mx-auto mb-4"></div>
          <p className="text-zinc-600 dark:text-zinc-400">
            Reconnecting... (Attempt {status.reconnectAttempts || 0})
          </p>
        </div>
      </div>
    );
  }

  if (status.status === 'disconnected' || status.status === 'error') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black p-4">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-6 sm:p-8 text-center w-full max-w-md">
          <h2 className="text-xl font-semibold mb-4 text-red-600 dark:text-red-400">
            Connection Failed
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400 mb-6">
            {status.status === 'disconnected' 
              ? 'WhatsApp connection was lost. Please reconnect.'
              : 'An error occurred. Please try again.'}
          </p>
          <button
            onClick={async () => {
              try {
                await reconnectBot();
                setError(null);
                checkStatus(4, { current: false }).catch(() => {});
              } catch (err) {
                console.error(err);
              }
            }}
            className="px-6 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
          >
            Reconnect
          </button>
        </div>
      </div>
    );
  }

  // Show current status with reconnect option
  return (
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black p-4">
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-6 sm:p-8 text-center w-full max-w-md">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-zinc-900 dark:border-zinc-50 mx-auto mb-4"></div>
        <h2 className="text-xl font-semibold mb-2 text-black dark:text-zinc-50">
          Status: {status.status || 'unknown'}
        </h2>
        <p className="text-zinc-600 dark:text-zinc-400 mb-4">
          {status.qr ? 'QR code expired. Reconnecting...' : 'Waiting for QR code from backend...'}
        </p>
        <p className="text-xs text-zinc-500 dark:text-zinc-400 mb-4">
          Check backend terminal - QR code should appear there
        </p>
        <button
          onClick={async () => {
            try {
              await reconnectBot();
              setTimeout(() => window.location.reload(), 1000);
            } catch (err) {
              console.error('Reconnect error:', err);
            }
          }}
          className="px-6 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
        >
          Reconnect / Get New QR
        </button>
      </div>
    </div>
  );
}


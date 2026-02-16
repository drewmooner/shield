'use client';

import { useEffect, useState } from 'react';
import QRCode from 'qrcode.react';

const API_URL = typeof window !== 'undefined' 
  ? (process.env.NEXT_PUBLIC_API_URL || '/api')
  : 'http://localhost:3002/api';

interface BotStatus {
  status: string;
  qr?: string;
  isConnected?: boolean;
  timestamp?: string;
  reconnectAttempts?: number;
}

export default function QRAuth({ onConnected }: { onConnected: () => void }) {
  const [status, setStatus] = useState<BotStatus>({ status: 'initializing' });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const checkStatus = async () => {
      try {
        const res = await fetch(`${API_URL}/bot/status`);
        if (!res.ok) {
          throw new Error(`Backend returned ${res.status}`);
        }
        const data = await res.json();
        console.log('Bot status:', data); // Debug log
        console.log('Status:', data.status, 'QR:', data.qr ? `Present (${data.qr.substring(0, 20)}...)` : 'Missing', 'isConnected:', data.isConnected);
        setStatus(data);
        setError(null);

        if (data.status === 'connected' && data.isConnected) {
          onConnected();
        }
      } catch (err) {
        setError('Failed to connect to backend. Make sure the backend is running on port 3002.');
        console.error('Backend connection error:', err);
      }
    };

    // Check immediately
    checkStatus();
    // Then check again after 500ms for faster initial load
    setTimeout(checkStatus, 500);
    // Then poll every 1 second
    const interval = setInterval(checkStatus, 1000);

    return () => clearInterval(interval);
  }, [onConnected]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 text-center max-w-md">
          <div className="mb-4">
            <svg 
              className="w-16 h-16 mx-auto text-zinc-400 dark:text-zinc-600" 
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
          <h2 className="text-xl font-semibold mb-2 text-black dark:text-zinc-50">
            Backend Service Unavailable
          </h2>
          <p className="text-zinc-600 dark:text-zinc-400 mb-4">
            We're unable to connect to the backend service right now. This could be temporary.
          </p>
          <div className="bg-zinc-50 dark:bg-zinc-800 rounded-lg p-4 mb-6 text-left">
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-2">
              <strong className="text-zinc-900 dark:text-zinc-50">What this means:</strong>
            </p>
            <ul className="text-sm text-zinc-600 dark:text-zinc-400 space-y-1 list-disc list-inside">
              <li>The backend server may be starting up</li>
              <li>The service might be temporarily unavailable</li>
              <li>Please check your connection and try again</li>
            </ul>
          </div>
          <button
            onClick={() => {
              setError(null);
              setStatus({ status: 'initializing' });
            }}
            className="px-6 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 transition-colors"
          >
            Retry Connection
          </button>
          <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-4">
            Backend URL: {API_URL}
          </p>
        </div>
      </div>
    );
  }

  if (status.status === 'qr_ready' && status.qr) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 text-center max-w-md">
          <h1 className="text-2xl font-semibold mb-2 text-black dark:text-zinc-50">
            Shield WhatsApp Login
          </h1>
          <p className="text-zinc-600 dark:text-zinc-400 mb-6">
            Scan this QR code with WhatsApp to connect
          </p>
          <div className="flex justify-center mb-6 p-4 bg-white rounded-lg">
            <QRCode value={status.qr} size={256} />
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
      <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
        <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 text-center max-w-md">
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
                await fetch(`${API_URL}/bot/reconnect`, { method: 'POST' });
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
    <div className="flex min-h-screen items-center justify-center bg-zinc-50 dark:bg-black">
      <div className="bg-white dark:bg-zinc-900 rounded-lg shadow-lg p-8 text-center max-w-md">
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
                    const res = await fetch(`${API_URL}/bot/reconnect`, { method: 'POST' });
                    if (!res.ok) {
                      const text = await res.text();
                      throw new Error(`Reconnect failed: ${res.status} ${text.substring(0, 100)}`);
                    }
                    const contentType = res.headers.get('content-type');
                    let data;
                    if (contentType && contentType.includes('application/json')) {
                      data = await res.json();
                    } else {
                      const text = await res.text();
                      console.error('Invalid response:', text);
                      data = { success: false };
                    }
              console.log('Reconnect response:', data);
              // Force status check after reconnect
              setTimeout(() => {
                window.location.reload();
              }, 1000);
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


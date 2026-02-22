'use client';

import { useEffect, useState } from 'react';
import { getBotStatus, pauseBot, resumeBot, disconnectBot, getLogs } from '../lib/api';
import { useSocketContext } from '../providers/SocketProvider';

export default function StatusBar() {
  const [status, setStatus] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(false);
  const [recentLogs, setRecentLogs] = useState<Record<string, unknown>[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const { socket, connected } = useSocketContext();

  const updateStatus = async () => {
    const data = await getBotStatus();
    setStatus(data);
    
    // Get recent logs
    try {
      const logs = await getLogs(15);
      setRecentLogs(logs);
    } catch (err) {
      console.error('Failed to fetch logs:', err);
    }
  };

  useEffect(() => {
    updateStatus();
  }, []);

  // Set up WebSocket listeners for real-time status updates
  useEffect(() => {
    if (!socket || !connected) return;

    const handleStatusUpdate = (data: Record<string, unknown>) => {
      setStatus(data);
    };

    const handleBotStatusChanged = () => {
      updateStatus();
    };

    socket.on('status_update', handleStatusUpdate);
    socket.on('bot_status_changed', handleBotStatusChanged);

    return () => {
      socket.off('status_update', handleStatusUpdate);
      socket.off('bot_status_changed', handleBotStatusChanged);
    };
  }, [socket, connected]);

  const handlePauseResume = async () => {
    setLoading(true);
    try {
      if (status.bot_paused === 'true') {
        await resumeBot();
      } else {
        await pauseBot();
      }
      const data = await getBotStatus();
      setStatus(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('⚠️ Are you sure you want to disconnect Shield?\n\n' +
                 'This will:\n' +
                 '• Unlink this device from your WhatsApp\n' +
                 '• Delete the session completely\n' +
                 '• Require you to scan QR code again to reconnect\n\n' +
                 'Continue?')) {
      return;
    }
    setLoading(true);
    try {
      console.log('Disconnecting...');
      await disconnectBot();
      console.log('Disconnect call completed, waiting for confirmation...');
      
      // Wait for logout to complete and session to be deleted
      // Poll status to detect when disconnected
      let attempts = 0;
      const maxAttempts = 15; // 15 seconds max wait
      
      while (attempts < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        try {
          const data = await getBotStatus();
          setStatus(data);
          
          // Check if disconnected
          if (data.status === 'disconnected' || (!data.isConnected && data.status !== 'connecting')) {
            console.log('Disconnect confirmed!');
            // Reload page to show QR code screen
            window.location.reload();
            return;
          }
        } catch (err) {
          console.error('Error checking status:', err);
        }
        attempts++;
      }
      
      // If we get here, force reload anyway
      console.log('Timeout waiting for disconnect confirmation, reloading...');
      window.location.reload();
    } catch (err) {
      console.error(err);
      alert('❌ Failed to disconnect. Please try again.');
      setLoading(false);
    }
  };

  const isPaused = status.bot_paused === 'true';
  const isConnected = status.status === 'connected' && status.isConnected === true;
  const isReconnecting = status.status === 'reconnecting' || status.status === 'connecting';

  const getStatusColor = () => {
    // Red if paused (even if connected) or disconnected
    if (isPaused || !isConnected) return 'bg-red-500';
    if (isReconnecting) return 'bg-yellow-500';
    // Green only if connected AND not paused
    if (isConnected && !isPaused) return 'bg-green-500';
    return 'bg-red-500';
  };

  return (
    <div className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800">
      <div className="px-4 py-3">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
          <div className="flex items-center gap-2 sm:gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className={`w-2 h-2 rounded-full ${getStatusColor()}`} />
              <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                Shield
              </span>
            </div>
            <button
              onClick={() => setShowLogs(!showLogs)}
              className="text-xs px-2 py-1 bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 transition-colors"
            >
              {showLogs ? 'Hide' : 'Show'} Logs ({recentLogs.length})
            </button>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <button
              onClick={handlePauseResume}
              disabled={loading || !isConnected}
              className="px-3 sm:px-4 py-1.5 text-xs sm:text-sm rounded-lg bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPaused ? 'Resume' : 'Pause'}
            </button>
            {isConnected && (
              <button
                onClick={handleDisconnect}
                disabled={loading}
                className="px-3 sm:px-4 py-1.5 text-xs sm:text-sm rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Disconnect
              </button>
            )}
          </div>
        </div>
      </div>
      
      {showLogs && (
        <div className="border-t border-zinc-200 dark:border-zinc-800 px-4 py-2 max-h-48 overflow-y-auto bg-zinc-50 dark:bg-zinc-950">
          <div className="space-y-1">
            {recentLogs.length === 0 ? (
              <p className="text-xs text-zinc-500 dark:text-zinc-400">No logs available</p>
            ) : (
              recentLogs.slice(0, 15).map((log) => (
                <div key={log.id} className="text-xs text-zinc-600 dark:text-zinc-400 flex items-center gap-2">
                  <span className="text-zinc-400 dark:text-zinc-500">
                    {new Date(log.timestamp).toLocaleString()}
                  </span>
                  <span className="font-medium">{log.action.replace(/_/g, ' ')}</span>
                  {log.details && typeof log.details === 'object' && (
                    <span className="text-zinc-500 dark:text-zinc-500">
                      {JSON.stringify(log.details).substring(0, 50)}
                    </span>
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}


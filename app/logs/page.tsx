'use client';

import { useEffect, useState } from 'react';
import { getLogs } from '../lib/api';

interface Log {
  id: number;
  action: string;
  details: string | object | null;
  timestamp: string;
}

export default function LogsPage() {
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLogs();
    const interval = setInterval(loadLogs, 5000);
    return () => clearInterval(interval);
  }, []);

  const loadLogs = async () => {
    try {
      const data = await getLogs(100);
      setLogs(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getActionColor = (action: string) => {
    if (action.includes('error')) return 'text-red-600 dark:text-red-400';
    if (action.includes('connected') || action.includes('reply_sent'))
      return 'text-green-600 dark:text-green-400';
    if (action.includes('received')) return 'text-blue-600 dark:text-blue-400';
    return 'text-zinc-600 dark:text-zinc-400';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900 dark:border-zinc-50"></div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6">
      <h1 className="text-xl sm:text-2xl font-bold mb-4 sm:mb-6 text-black dark:text-zinc-50">Activity Logs</h1>
      <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="bg-zinc-100 dark:bg-zinc-800">
              <tr>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs sm:text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Time
                </th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs sm:text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Action
                </th>
                <th className="px-2 sm:px-4 py-2 sm:py-3 text-left text-xs sm:text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Details
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {logs.map((log) => (
                <tr key={log.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-800">
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
                    {new Date(log.timestamp).toLocaleString()}
                  </td>
                  <td className={`px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm font-medium ${getActionColor(log.action)}`}>
                    {log.action.replace(/_/g, ' ')}
                  </td>
                  <td className="px-2 sm:px-4 py-2 sm:py-3 text-xs sm:text-sm text-zinc-600 dark:text-zinc-400">
                    {log.details ? (
                      <pre className="text-xs whitespace-pre-wrap break-words">
                        {typeof log.details === 'string' 
                          ? JSON.stringify(JSON.parse(log.details), null, 2)
                          : JSON.stringify(log.details, null, 2)}
                      </pre>
                    ) : (
                      '-'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}


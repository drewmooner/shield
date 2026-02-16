'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getLeads, exportChatLogs } from '../lib/api';

interface Lead {
  id: string;
  phone_number: string;
  contactName?: string;
  profilePictureUrl?: string | null;
  reply_count: number;
  status: string;
  created_at: string;
  updated_at: string;
  lastMessage?: {
    content: string;
    timestamp: string;
    sender: string;
  } | null;
}

export default function Dashboard() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadLeads();
    // Poll every 100ms for immediate real-time updates
    const interval = setInterval(loadLeads, 100);
    return () => clearInterval(interval);
  }, [filter]);

  const loadLeads = async () => {
    try {
      // Add timestamp to prevent caching
      const data = await getLeads(filter === 'all' ? undefined : filter);
      // Force state update even if data appears same (React might skip update)
      setLeads([...data]);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'completed':
        return 'bg-green-100 dark:bg-green-900 text-green-800 dark:text-green-200';
      case 'replied':
        return 'bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200';
      default:
        return 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900 dark:border-zinc-50"></div>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-black dark:text-zinc-50">Chats</h1>
        <div className="flex gap-2">
            <button
              onClick={() => setFilter('all')}
              className={`px-4 py-2 rounded-lg text-sm ${
                filter === 'all'
                  ? 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
              }`}
            >
              All
            </button>
            <button
              onClick={() => setFilter('pending')}
              className={`px-4 py-2 rounded-lg text-sm ${
                filter === 'pending'
                  ? 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
              }`}
            >
              Pending
            </button>
            <button
              onClick={() => setFilter('replied')}
              className={`px-4 py-2 rounded-lg text-sm ${
                filter === 'replied'
                  ? 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
              }`}
            >
              Replied
            </button>
            <button
              onClick={() => setFilter('completed')}
              className={`px-4 py-2 rounded-lg text-sm ${
                filter === 'completed'
                  ? 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
                  : 'bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-400'
              }`}
            >
              Completed
            </button>
          </div>
        </div>

      {leads.length === 0 ? (
        <div className="text-center py-12 text-zinc-500 dark:text-zinc-400">
          No chats found
        </div>
      ) : (
        <div className="space-y-2">
          {leads.map((lead) => (
            <Link
              key={lead.id}
              href={`/lead/${lead.id}`}
              className="block bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-4 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors"
            >
              <div className="flex items-center justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    {/* Profile Picture */}
                    <div className="flex-shrink-0">
                      {lead.profilePictureUrl ? (
                        <img 
                          src={lead.profilePictureUrl} 
                          alt={lead.contactName || lead.phone_number}
                          className="w-10 h-10 rounded-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                            e.currentTarget.nextElementSibling.style.display = 'flex';
                          }}
                        />
                      ) : null}
                      <div 
                        className={`w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-sm font-medium text-zinc-600 dark:text-zinc-400 ${lead.profilePictureUrl ? 'hidden' : ''}`}
                      >
                        {(lead.contactName || lead.phone_number).charAt(0).toUpperCase()}
                      </div>
                    </div>
                    
                    {/* Contact Name */}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-black dark:text-zinc-50 block truncate">
                        {lead.contactName || lead.phone_number}
                      </span>
                      {lead.contactName && lead.contactName !== lead.phone_number && (
                        <span className="text-xs text-zinc-500 dark:text-zinc-400 block">
                          {lead.phone_number}
                        </span>
                      )}
                    </div>
                    <span
                      className={`text-xs px-2 py-1 rounded ${getStatusColor(lead.status)}`}
                    >
                      {lead.status}
                    </span>
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {lead.reply_count} replies
                    </span>
                  </div>
                  {lead.lastMessage && (
                    <p className="text-sm text-zinc-600 dark:text-zinc-400 truncate">
                      <span className="font-medium">
                        {lead.lastMessage.sender === 'user' ? 'User' : 'Shield'}:
                      </span>{' '}
                      {lead.lastMessage.content}
                    </p>
                  )}
                </div>
                <div className="text-xs text-zinc-500 dark:text-zinc-400 ml-4">
                  {new Date(lead.updated_at).toLocaleDateString()}
                </div>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

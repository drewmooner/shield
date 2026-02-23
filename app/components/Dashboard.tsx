'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getLeads, exportChatLogs } from '../lib/api';
import { useSocketContext } from '../providers/SocketProvider';

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

interface LeadWithUnread extends Lead {
  hasNewMessage?: boolean;
  lastViewedMessageId?: string;
}

export default function Dashboard() {
  const [leads, setLeads] = useState<LeadWithUnread[]>([]);
  const [filter, setFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [backendError, setBackendError] = useState(false);
  const [lastMessageIds, setLastMessageIds] = useState<Record<string, string>>({});
  const { socket, connected } = useSocketContext();

  useEffect(() => {
    loadLeads();
  }, [filter]);

  // ─── Refresh UI when WebSocket connects ──────────────────────────────────
  useEffect(() => {
    if (connected) {
      console.log('🔄 Dashboard: WebSocket connected - refreshing leads...');
      // Clear old leads and reload fresh data
      setLeads([]);
      setLastMessageIds({});
      loadLeads();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]); // loadLeads is stable enough, no need to include

  // Set up WebSocket listeners
  useEffect(() => {
    if (!socket || !connected) return;

    const handleLeadsChanged = () => {
      setLeads([]); // Clear immediately so UI shows empty
      loadLeads();
    };

    const handleNewMessage = (data: Record<string, unknown>) => {
      console.log('📨 Dashboard: New message received for lead:', data?.leadId);
      loadLeads();
    };

    socket.on('leads_changed', handleLeadsChanged);
    socket.on('new_message', handleNewMessage);
    
    // Log WebSocket connection status
    console.log('📡 Dashboard WebSocket listeners attached');

    return () => {
      socket.off('leads_changed', handleLeadsChanged);
      socket.off('new_message', handleNewMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, connected]); // filter is handled by loadLeads closure, loadLeads is stable

  const loadLeads = async () => {
    try {
      // Add timestamp to prevent caching
      const data = await getLeads(filter === 'all' ? undefined : filter) as Lead[];
      
      // Check for new messages by comparing last message IDs
      setLastMessageIds(prev => {
        const newIds: Record<string, string> = { ...prev };
        const leadsWithUnread: LeadWithUnread[] = data.map(lead => {
          const lastMessageId = lead.lastMessage 
            ? `${lead.id}-${lead.lastMessage.timestamp}-${lead.lastMessage.content.substring(0, 20)}`
            : null;
          
          const previousLastMessageId = prev[lead.id];
          const hasNewMessage = lastMessageId && lastMessageId !== previousLastMessageId && 
                               lead.lastMessage?.sender === 'user';
          
          // Update last message ID tracking
          if (lastMessageId) {
            newIds[lead.id] = lastMessageId;
          }
          
          return {
            ...lead,
            hasNewMessage: hasNewMessage || false,
            lastViewedMessageId: previousLastMessageId ?? undefined
          };
        });
        
        // Force state update even if data appears same (React might skip update)
        setLeads(leadsWithUnread);
        return newIds;
      });
      
      setBackendError(false);
    } catch (err) {
      console.error(err);
      setBackendError(true);
    } finally {
      setLoading(false);
    }
  };

  const getStatusDotColor = (lead: LeadWithUnread) => {
    // Green dot = new unread messages
    if (lead.hasNewMessage) {
      return 'bg-green-500';
    }
    // Blue dot = bot has replied
    if (lead.status === 'replied') {
      return 'bg-blue-500';
    }
    // Yellow dot = viewed but bot hasn't replied yet (pending)
    if (lead.status === 'pending') {
      return 'bg-yellow-500';
    }
    // Green dot for completed (optional, or you can use a different color)
    if (lead.status === 'completed') {
      return 'bg-green-500';
    }
    // Default to yellow for pending
    return 'bg-yellow-500';
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
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-black dark:text-zinc-50">Chats</h1>
        <div className="flex gap-2 flex-wrap">

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

      {backendError ? (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-6 text-center">
          <div className="mb-3">
            <svg 
              className="w-10 h-10 mx-auto text-yellow-600 dark:text-yellow-400" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={2} 
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" 
              />
            </svg>
          </div>
          <p className="text-yellow-700 dark:text-yellow-400 mb-4">
            Unable to load chats. Please try again.
          </p>
          <button
            onClick={loadLeads}
            className="px-4 py-2 bg-yellow-600 dark:bg-yellow-500 text-white rounded-lg hover:bg-yellow-700 dark:hover:bg-yellow-600 transition-colors"
          >
            Retry
          </button>
        </div>
      ) : leads.length === 0 ? (
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
                    {/* Profile Picture with Status Dot Indicator */}
                    <div className="flex-shrink-0 relative">
                      {lead.profilePictureUrl ? (
                        <img 
                          src={lead.profilePictureUrl} 
                          alt={lead.contactName || lead.phone_number}
                          className="w-10 h-10 rounded-full object-cover"
                          onError={(e) => {
                            e.currentTarget.style.display = 'none';
                            const nextSibling = e.currentTarget.nextElementSibling as HTMLElement | null;
                            if (nextSibling) {
                              nextSibling.style.display = 'flex';
                            }
                          }}
                        />
                      ) : null}
                      <div 
                        className={`w-10 h-10 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-sm font-medium text-zinc-600 dark:text-zinc-400 ${lead.profilePictureUrl ? 'hidden' : ''}`}
                      >
                        {(lead.contactName || lead.phone_number).charAt(0).toUpperCase()}
                      </div>
                      {/* Status dot indicator: Green (new), Yellow (pending), Blue (replied) */}
                      <div className={`absolute -top-0.5 -right-0.5 w-3 h-3 ${getStatusDotColor(lead)} rounded-full border-2 border-white dark:border-zinc-900 ${lead.hasNewMessage ? 'animate-pulse' : ''}`}></div>
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
                    <span className="text-xs text-zinc-500 dark:text-zinc-400">
                      {lead.reply_count} replies
                    </span>
                  </div>
                  {lead.lastMessage && (
                    <p className={`text-sm truncate ${lead.hasNewMessage ? 'font-semibold text-black dark:text-zinc-50' : 'text-zinc-600 dark:text-zinc-400'}`}>
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

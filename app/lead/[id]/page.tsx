'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getLead, sendMessage, completeLead, deleteLead } from '../../lib/api';
import { useSocketContext } from '../../providers/SocketProvider';

interface Message {
  id: string;
  sender: string;
  content: string;
  timestamp: string;
  status: string;
}

interface Lead {
  id: string;
  phone_number: string;
  contactName?: string;
  profilePictureUrl?: string | null;
  reply_count: number;
  status: string;
  messages: Message[];
}

export default function LeadDetailPage() {
  const params = useParams();
  const router = useRouter();
  const leadId = params.id as string;

  const [lead, setLead] = useState<Lead | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [newMessageIndicator, setNewMessageIndicator] = useState(false);

  const chatContainerRef = useRef<HTMLDivElement>(null);
  const shouldAutoScrollRef = useRef(true);
  const previousMessageCountRef = useRef(0);
  const pendingTempIdsRef = useRef<Set<string>>(new Set());

  // ✅ Track when WebSocket connection was established
  const connectionTimestampRef = useRef<number | null>(null);

  const { socket, connected } = useSocketContext();

  // ─── Scroll helpers ───────────────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      if (chatContainerRef.current) {
        chatContainerRef.current.scrollTop = chatContainerRef.current.scrollHeight;
      }
    });
  }, []);

  const isNearBottom = useCallback(() => {
    if (!chatContainerRef.current) return true;
    const { scrollHeight, scrollTop, clientHeight } = chatContainerRef.current;
    return scrollHeight - scrollTop - clientHeight < 100;
  }, []);

  useEffect(() => {
    const container = chatContainerRef.current;
    if (!container) return;
    const handleScroll = () => {
      shouldAutoScrollRef.current = isNearBottom();
    };
    container.addEventListener('scroll', handleScroll, { passive: true });
    return () => container.removeEventListener('scroll', handleScroll);
  }, [isNearBottom]);

  // ─── Load lead ────────────────────────────────────────────────────────────
  const loadLead = useCallback(async () => {
    try {
      setLoading(true);
      const data: Lead = await getLead(leadId);
      
      // Filter messages on frontend (only show messages after connection, with 5 second buffer)
      // Use current value of connectionTimestampRef at call time (refs don't need to be in deps)
      const currentConnectionTime = connectionTimestampRef.current;
      if (currentConnectionTime && data.messages) {
        const bufferWindow = 5000; // 5 seconds buffer to account for timing differences
        const connectionTimeWithBuffer = currentConnectionTime - bufferWindow;
        
        const beforeFilter = data.messages.length;
        data.messages = data.messages.filter(msg => {
          const msgTime = new Date(msg.timestamp).getTime();
          return msgTime >= connectionTimeWithBuffer;
        });
        
        if (beforeFilter !== data.messages.length) {
          console.log(`📊 Filtered ${beforeFilter - data.messages.length} old messages (before connection)`);
        }
      }
      
      setLead(data);
      console.log(`✅ Loaded lead ${leadId} with ${data.messages?.length || 0} messages`);
    } catch (err: any) {
      console.error('❌ loadLead error:', err);
      if (err.message?.includes('404') || err.message?.includes('Lead not found')) {
        router.push('/');
      }
    } finally {
      setLoading(false);
    }
  }, [leadId, router]); // connectionTimestampRef is a ref, doesn't need to be in deps

  useEffect(() => {
    loadLead();
  }, [loadLead]);

  // ─── Record connection timestamp from backend (WhatsApp connection time, not WebSocket) ─────────────
  useEffect(() => {
    const checkInitialStatus = async () => {
      if (connectionTimestampRef.current) return;
      try {
        const res = await fetch('/api/bot/status');
        if (res.ok) {
          const data = await res.json();
          if (data.status === 'connected' && data.isConnected && data.connectionTime) {
            const backendConnectionTime = typeof data.connectionTime === 'number'
              ? data.connectionTime
              : new Date(data.connectionTime).getTime();
            connectionTimestampRef.current = backendConnectionTime;
            console.log('🕐 WhatsApp already connected (from API), using backend timestamp');
            console.log(`   Backend connectionTime: ${new Date(backendConnectionTime).toISOString()}`);
          }
        }
      } catch (err) {
        console.error('Failed to check initial status:', err);
      }
    };

    if (connected) checkInitialStatus();

    if (!socket || !connected) return;

    const handleStatusUpdate = (data: any) => {
      if (data.status === 'connected' && data.isConnected && data.connectionTime && !connectionTimestampRef.current) {
        const backendConnectionTime = typeof data.connectionTime === 'number'
          ? data.connectionTime
          : new Date(data.connectionTime).getTime();
        connectionTimestampRef.current = backendConnectionTime;
        console.log('🕐 WhatsApp connected (backend timestamp), refreshing messages...');
        console.log(`   Backend connectionTime: ${new Date(backendConnectionTime).toISOString()}`);
        loadLead();
      }
    };

    socket.on('status_update', handleStatusUpdate);
    return () => socket.off('status_update', handleStatusUpdate);
  }, [socket, connected, loadLead]);

  // ─── Merge incoming messages without blowing away optimistic ones ─────────
  const mergeMessages = useCallback((serverMessages: Message[]) => {
    setLead(prev => {
      if (!prev) return prev;
      const optimistic = prev.messages.filter(m => pendingTempIdsRef.current.has(m.id));
      const serverIds = new Set(serverMessages.map(m => m.id));
      const safeOptimistic = optimistic.filter(m => !serverIds.has(m.id));
      return {
        ...prev,
        messages: [...serverMessages, ...safeOptimistic],
      };
    });
  }, []);

  // ─── WebSocket listeners ───────────────────────────────────────────────────
  useEffect(() => {
    if (!socket || !connected) return;

    const handleNewMessage = async (data: any) => {
      console.log('📨 new_message event received:', data);
      console.log('   Full event data:', JSON.stringify(data, null, 2));

      // Filter: only process messages that arrived AFTER connection (with 5 second buffer to account for timing)
      if (connectionTimestampRef.current && data?.message?.timestamp) {
        const messageTime = new Date(data.message.timestamp).getTime();
        const bufferWindow = 5000; // 5 seconds buffer to account for timing differences
        const connectionTimeWithBuffer = connectionTimestampRef.current - bufferWindow;
        
        if (messageTime < connectionTimeWithBuffer) {
          console.log('⏭️ Skipping old message (before connection time)');
          console.log(`   Message time: ${new Date(messageTime).toISOString()}`);
          console.log(`   Connection time: ${new Date(connectionTimestampRef.current).toISOString()}`);
          return;
        }
      }

      if (String(data?.leadId) !== String(leadId)) {
        console.log(`⏭️ Message for different lead (received: ${data?.leadId}, current: ${leadId}), skipping`);
        return;
      }
      
      console.log(`✅ Message matches current lead: ${leadId}`);

      // Add message to UI
      if (data?.message) {
        console.log('📝 Message payload:', {
          id: data.message.id,
          sender: data.message.sender,
          content: data.message.content?.substring(0, 50),
          timestamp: data.message.timestamp
        });
        
        setLead(prev => {
          if (!prev) {
            loadLead();
            return prev;
          }
          
          if (prev.messages.some(m => m.id === data.message.id)) return prev;
          
          const newMessages = [...prev.messages, data.message];
          return { ...prev, messages: newMessages };
        });

        // Refresh from server to ensure UI stays in sync (handles any state edge cases)
        setTimeout(() => loadLead(), 200);

        if (data.message.sender === 'user') {
          setNewMessageIndicator(true);
          setTimeout(() => setNewMessageIndicator(false), 3000);
        }
      } else {
        // Fallback: reload lead if no message payload
        console.log('⚠️ No message payload in event, reloading lead...');
        loadLead();
      }
    };

    const handleLeadUpdated = async (updatedLead: any) => {
      if (updatedLead?.id !== leadId) return;
      console.log('📋 lead_updated event');
      const fresh: Lead = await getLead(leadId);
      mergeMessages(fresh.messages);
    };

    socket.on('new_message', handleNewMessage);
    socket.on('lead_updated', handleLeadUpdated);
    
    // ✅ DEBUG: Listen for ALL socket events to see what's coming through
    const debugHandler = (eventName: string, ...args: any[]) => {
      if (eventName === 'new_message') {
        console.log('🔍 DEBUG: Raw new_message event:', args);
      }
    };
    socket.onAny(debugHandler);
    
    console.log('📡 WebSocket listeners attached for lead:', leadId);
    console.log('   Socket connected:', socket.connected);
    console.log('   Socket ID:', socket.id);

    return () => {
      socket.off('new_message', handleNewMessage);
      socket.off('lead_updated', handleLeadUpdated);
      socket.offAny(debugHandler);
    };
  }, [socket, connected, leadId, mergeMessages, loadLead]);

  // ─── Auto-scroll when messages change ────────────────────────────────────
  useEffect(() => {
    if (!lead?.messages) return;
    const count = lead.messages.length;
    const hasNew = count > previousMessageCountRef.current;
    previousMessageCountRef.current = count;

    if (hasNew && shouldAutoScrollRef.current) {
      scrollToBottom();
    }
  }, [lead?.messages, scrollToBottom]);

  // ─── Send message ─────────────────────────────────────────────────────────
  const handleSend = async () => {
    if (!message.trim() || !lead || sending) return;

    const messageContent = message.trim();
    const tempId = `temp-${Date.now()}-${Math.random()}`;

    const optimisticMessage: Message = {
      id: tempId,
      sender: 'shield',
      content: messageContent,
      timestamp: new Date().toISOString(),
      status: 'sending',
    };

    pendingTempIdsRef.current.add(tempId);

    setLead(prev => {
      if (!prev) return prev;
      return { ...prev, messages: [...prev.messages, optimisticMessage] };
    });
    setMessage('');
    setSending(true);
    shouldAutoScrollRef.current = true;
    scrollToBottom();

    try {
      await sendMessage(lead.phone_number, messageContent);
      setLead(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: prev.messages.map(m =>
            m.id === tempId ? { ...m, status: 'replied' } : m
          ),
        };
      });
    } catch (err) {
      console.error('Send failed:', err);
      pendingTempIdsRef.current.delete(tempId);
      setLead(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          messages: prev.messages.filter(m => m.id !== tempId),
        };
      });
      setMessage(messageContent);
    } finally {
      setSending(false);
    }
  };

  // ─── Other actions ────────────────────────────────────────────────────────
  const handleComplete = async () => {
    if (!lead) return;
    try {
      await completeLead(lead.id);
      router.push('/');
    } catch (err) {
      console.error(err);
    }
  };

  const handleDelete = async () => {
    if (!lead) return;
    if (!confirm(`Delete chat with ${lead.contactName || lead.phone_number}? This cannot be undone.`)) return;
    try {
      await deleteLead(lead.id);
      router.push('/');
    } catch (err) {
      console.error(err);
      alert('Failed to delete chat. Please try again.');
    }
  };

  const handleExport = async () => {
    if (!lead) return;
    try {
      const payload = {
        exportDate: new Date().toISOString(),
        phoneNumber: lead.phone_number,
        messages: lead.messages.map(msg => ({
          phoneNumber: lead.phone_number,
          sender: msg.sender,
          content: msg.content,
          timestamp: msg.timestamp,
          status: msg.status,
        })),
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `shield-chat-${lead.phone_number}-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      alert('Failed to export chat');
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900 dark:border-zinc-50" />
      </div>
    );
  }

  if (!lead) {
    return <div className="p-6">Lead not found</div>;
  }

  const displayName = lead.contactName || lead.phone_number;

  return (
    <div className="flex flex-col h-screen">
      {/* ── Header ── */}
      <div className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 p-4 sm:p-5 md:p-6">
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 max-w-6xl mx-auto w-full">
          <div className="flex items-center gap-3">
            {/* Avatar */}
            <div className="flex-shrink-0 relative w-12 h-12">
              {lead.profilePictureUrl && (
                <img
                  src={lead.profilePictureUrl}
                  alt={displayName}
                  className="absolute inset-0 w-12 h-12 rounded-full object-cover"
                  onError={e => (e.currentTarget.style.display = 'none')}
                />
              )}
              <div className="w-12 h-12 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-lg font-medium text-zinc-600 dark:text-zinc-400">
                {displayName.charAt(0).toUpperCase()}
              </div>
            </div>

            {/* Info */}
            <div>
              <button
                onClick={() => router.back()}
                className="text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-zinc-50 mb-1 text-sm"
              >
                ← Back
              </button>
              <h1 className="text-xl font-bold text-black dark:text-zinc-50">{displayName}</h1>
              {lead.contactName && lead.contactName !== lead.phone_number && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">{lead.phone_number}</p>
              )}
              <div className="flex items-center gap-2">
                <p className="text-sm text-zinc-500 dark:text-zinc-400">
                  {lead.reply_count} replies • {lead.status}
                </p>
                <div
                  className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-400'}`}
                  title={connected ? 'Connected' : 'Disconnected'}
                />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex gap-2 flex-wrap">
            {lead.status !== 'completed' && (
              <button
                onClick={handleComplete}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
              >
                Mark Complete
              </button>
            )}
            <button
              onClick={handleExport}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              Export Chat
            </button>
            <button
              onClick={handleDelete}
              className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
            >
              Delete Chat
            </button>
          </div>
        </div>
      </div>

      {/* ── New Message Banner ── */}
      {newMessageIndicator && (
        <div className="bg-green-500 text-white px-4 py-2 text-sm text-center animate-pulse">
          <div className="flex items-center justify-center gap-2">
            <div className="w-2 h-2 bg-white rounded-full" />
            <span>New message received</span>
            <div className="w-2 h-2 bg-white rounded-full" />
          </div>
        </div>
      )}

      {/* ── Messages ── */}
      <div
        ref={chatContainerRef}
        className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 space-y-3 sm:space-y-4"
      >
        {lead.messages.length === 0 && (
          <div className="flex items-center justify-center h-full text-zinc-400 text-sm">
            No messages yet. Say something!
          </div>
        )}

        {lead.messages.map(msg => (
          <div
            key={msg.id}
            className={`flex ${msg.sender === 'user' ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-[85%] sm:max-w-[75%] md:max-w-[65%] lg:max-w-[55%] rounded-lg p-3 sm:p-4 transition-opacity duration-200 ${
                msg.sender === 'user'
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-black dark:text-zinc-50'
                  : 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
              } ${msg.status === 'sending' ? 'opacity-60' : 'opacity-100'}`}
            >
              <div className="flex items-start gap-2">
                <p className="text-sm sm:text-base break-words">{msg.content}</p>
                {msg.status === 'sending' && (
                  <svg className="animate-spin h-4 w-4 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
              </div>
              <p className="text-xs sm:text-sm mt-1.5 sm:mt-2 opacity-60">
                {msg.status === 'sending' ? 'Sending…' : new Date(msg.timestamp).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* ── Input ── */}
      <div className="bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 p-3 sm:p-4 md:p-6">
        <div className="flex gap-2 max-w-4xl mx-auto">
          <input
            type="text"
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            placeholder="Type a message..."
            disabled={sending}
            className="flex-1 px-4 sm:px-5 py-2.5 sm:py-3 text-sm sm:text-base border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-500 disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={sending || !message.trim()}
            className="px-5 sm:px-6 md:px-8 py-2.5 sm:py-3 text-sm sm:text-base font-medium bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

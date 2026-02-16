'use client';

import { useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { getLead, sendMessage, completeLead, exportChatLogs, deleteLead } from '../../lib/api';

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
  const [lead, setLead] = useState<Lead | null>(null);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    loadLead(); // Load once on mount
    
    // Poll every 5 seconds instead of 100ms
    const interval = setInterval(loadLead, 5000);
    return () => clearInterval(interval);
  }, [params.id]);

  const loadLead = async () => {
    try {
      const data = await getLead(params.id as string);
      console.log('🔍 Lead data:', data);
      console.log('🔍 Messages array:', data?.messages);
      console.log('🔍 Messages count:', data?.messages?.length);
      setLead(data);
    } catch (err: any) {
      console.error('❌ Frontend error:', err);
      // If lead not found, redirect to dashboard
      if (err.message?.includes('404') || err.message?.includes('Lead not found')) {
        console.log('⚠️ Lead not found, redirecting to dashboard...');
        router.push('/');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleSend = async () => {
    if (!message.trim() || !lead) return;
    setSending(true);
    try {
      await sendMessage(lead.phone_number, message);
      setMessage('');
      // Immediately refresh to show sent message
      await loadLead();
      // Also refresh again after a short delay to catch any delayed updates
      setTimeout(() => loadLead(), 500);
    } catch (err) {
      console.error(err);
    } finally {
      setSending(false);
    }
  };

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
    if (!confirm(`Are you sure you want to delete this chat with ${lead.contactName || lead.phone_number}? This cannot be undone.`)) {
      return;
    }
    try {
      await deleteLead(lead.id);
      router.push('/');
    } catch (err) {
      console.error(err);
      alert('Failed to delete chat. Please try again.');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-zinc-900 dark:border-zinc-50"></div>
      </div>
    );
  }

  if (!lead) {
    return <div className="p-6">Lead not found</div>;
  }

  return (
    <div className="flex flex-col h-screen">
      <div className="bg-white dark:bg-zinc-900 border-b border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Profile Picture */}
            <div className="flex-shrink-0">
              {lead.profilePictureUrl ? (
                <img 
                  src={lead.profilePictureUrl} 
                  alt={lead.contactName || lead.phone_number}
                  className="w-12 h-12 rounded-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                    e.currentTarget.nextElementSibling.style.display = 'flex';
                  }}
                />
              ) : null}
              <div 
                className={`w-12 h-12 rounded-full bg-zinc-200 dark:bg-zinc-800 flex items-center justify-center text-lg font-medium text-zinc-600 dark:text-zinc-400 ${lead.profilePictureUrl ? 'hidden' : ''}`}
              >
                {(lead.contactName || lead.phone_number).charAt(0).toUpperCase()}
              </div>
            </div>
            
            {/* Contact Info */}
            <div>
              <button
                onClick={() => router.back()}
                className="text-zinc-600 dark:text-zinc-400 hover:text-black dark:hover:text-zinc-50 mb-1 text-sm"
              >
                ← Back
              </button>
              <h1 className="text-xl font-bold text-black dark:text-zinc-50">
                {lead.contactName || lead.phone_number}
              </h1>
              {lead.contactName && lead.contactName !== lead.phone_number && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  {lead.phone_number}
                </p>
              )}
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                {lead.reply_count} replies • {lead.status}
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            {lead.status !== 'completed' && (
              <button
                onClick={handleComplete}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
              >
                Mark Complete
              </button>
            )}
            <button
              onClick={handleDelete}
              className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm hover:bg-red-700"
            >
              Delete Chat
            </button>
            <button
              onClick={async () => {
                try {
                  // Export only this lead's messages
                  const allLeads = await fetch('/api/leads').then(r => r.json());
                  const currentLead = allLeads.find((l: any) => l.id === lead.id);
                  if (currentLead) {
                    const messages = lead.messages.map((msg: any) => ({
                      phoneNumber: lead.phone_number,
                      sender: msg.sender,
                      content: msg.content,
                      timestamp: msg.timestamp,
                      status: msg.status
                    }));
                    
                    const dataStr = JSON.stringify({
                      exportDate: new Date().toISOString(),
                      phoneNumber: lead.phone_number,
                      messages
                    }, null, 2);
                    const blob = new Blob([dataStr], { type: 'application/json' });
                    const url = window.URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `shield-chat-${lead.phone_number}-${new Date().toISOString().split('T')[0]}.json`;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    window.URL.revokeObjectURL(url);
                  }
                } catch (err) {
                  console.error(err);
                  alert('Failed to export chat');
                }
              }}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
            >
              Export Chat
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {lead.messages.map((msg) => (
          <div
            key={msg.id}
            className={`flex ${msg.sender === 'user' ? 'justify-start' : 'justify-end'}`}
          >
            <div
              className={`max-w-[70%] rounded-lg p-3 ${
                msg.sender === 'user'
                  ? 'bg-zinc-100 dark:bg-zinc-800 text-black dark:text-zinc-50'
                  : 'bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black'
              }`}
            >
              <p className="text-sm">{msg.content}</p>
              <p className="text-xs mt-1 opacity-70">
                {new Date(msg.timestamp).toLocaleString()}
              </p>
            </div>
          </div>
        ))}
      </div>

      <div className="bg-white dark:bg-zinc-900 border-t border-zinc-200 dark:border-zinc-800 p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && handleSend()}
            placeholder="Type a message..."
            className="flex-1 px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 focus:outline-none focus:ring-2 focus:ring-zinc-500"
          />
          <button
            onClick={handleSend}
            disabled={sending || !message.trim()}
            className="px-6 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}


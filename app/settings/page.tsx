'use client';

import { useEffect, useState, useRef } from 'react';
import { getSettings, updateSettings, exportChatLogs, refreshContactNames, uploadAudio, getAudioFileUrl } from '../lib/api';
import { useSocketContext } from '../providers/SocketProvider';

interface KeywordReply {
  id: string;
  keyword: string;
  message: string;
  replyType: 'text' | 'audio';
}

function parseKeywordReplies(v: unknown): KeywordReply[] {
  const mapEntry = (e: Record<string, unknown>) => ({
    id: (e.id as string) || crypto.randomUUID(),
    keyword: (e.keyword as string) || '',
    message: (e.message as string) || '',
    replyType: (e.replyType === 'audio' ? 'audio' : 'text') as 'text' | 'audio',
  });
  if (Array.isArray(v)) {
    return v.map((e: Record<string, unknown>) => mapEntry(e));
  }
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr.map((e: Record<string, unknown>) => mapEntry(e)) : [];
    } catch {
      return [];
    }
  }
  return [];
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<Record<string, unknown>>({});
  const [productInfo, setProductInfo] = useState<string>('');
  const [keywordReplies, setKeywordReplies] = useState<KeywordReply[]>([]);
  const [audioSaving, setAudioSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { socket, connected } = useSocketContext();

  useEffect(() => {
    loadSettings();
  }, []);

  // Listen for WebSocket settings updates
  useEffect(() => {
    if (!socket || !connected) return;

    const handleSettingsUpdate = (data: Record<string, unknown>) => {
      setSettings(data);
      setProductInfo((data.product_info as string) || '');
      setKeywordReplies(parseKeywordReplies(data.keyword_replies));
    };

    socket.on('settings_updated', handleSettingsUpdate);

    return () => {
      socket.off('settings_updated', handleSettingsUpdate);
    };
  }, [socket, connected]);

  const loadSettings = async () => {
    try {
      const data = await getSettings();
      setSettings(data);
      setProductInfo((data.product_info as string) || '');
      setKeywordReplies(parseKeywordReplies(data.keyword_replies));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Don't send API key or model to backend (they're managed via environment variables)
      const { openrouter_api_key, ai_model, ...settingsToSave } = settings;
      await updateSettings({
        ...settingsToSave,
        product_info: productInfo,
        keyword_replies: keywordReplies,
      });
      console.log('✅ Settings saved');
    } catch (err) {
      console.error(err);
      alert('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const addKeywordReply = () => {
    setKeywordReplies([...keywordReplies, { id: crypto.randomUUID(), keyword: '', message: '', replyType: 'text' as const }]);
  };

  const updateKeywordReply = (id: string, field: 'keyword' | 'message' | 'replyType', value: string) => {
    setKeywordReplies(keywordReplies.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const removeKeywordReply = (id: string) => {
    setKeywordReplies(keywordReplies.filter((r) => r.id !== id));
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunks, { type: 'audio/ogg;codecs=opus' });
        const file = new File([blob], 'recording.ogg', { type: 'audio/ogg' });
        setAudioSaving(true);
        try {
          const res = await uploadAudio(file);
          setSettings((prev) => ({ ...prev, welcome_audio_path: (res as { path?: string }).path || 'audio/welcome.ogg' }));
          alert('Audio saved. It will be sent when you\'re inactive.');
        } catch (err) {
          console.error(err);
          alert('Failed to save recording');
        } finally {
          setAudioSaving(false);
        }
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch (err) {
      console.error(err);
      alert('Microphone access needed to record');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && recording) {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
      setRecording(false);
    }
  };

  const handleAudioUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !file.type.startsWith('audio/')) {
      alert('Please select an audio file');
      return;
    }
    setAudioSaving(true);
    try {
      const res = await uploadAudio(file);
      setSettings((prev) => ({ ...prev, welcome_audio_path: (res as { path?: string }).path || 'audio/welcome.ogg' }));
      alert('Audio saved.');
    } catch (err) {
      console.error(err);
      alert('Failed to upload audio');
    } finally {
      setAudioSaving(false);
      e.target.value = '';
    }
  };

  // Auto-save auto-reply toggle immediately (merged with AI - one toggle controls both)
  const handleAutoReplyToggle = async (enabled: boolean) => {
    const previousSettings = { ...settings };
    // When auto-reply is enabled, also enable AI (they're merged now)
    const newSettings = { 
      ...settings, 
      auto_reply_enabled: enabled ? 'true' : 'false',
      ai_enabled: enabled ? 'true' : 'false' // Sync AI with auto-reply
    };
    setSettings(newSettings);
    
    // Save immediately
    setSaving(true);
    try {
      const { openrouter_api_key, ai_model, ...settingsToSave } = newSettings;
      await updateSettings({
        ...settingsToSave,
        product_info: productInfo,
        keyword_replies: keywordReplies,
      });
      console.log(`✅ Auto-reply ${enabled ? 'enabled' : 'disabled'} - takes effect immediately`);
    } catch (err) {
      console.error('Failed to save auto-reply setting:', err);
      // Revert on error
      setSettings(previousSettings);
      alert('Failed to update auto-reply setting. Please try again.');
    } finally {
      setSaving(false);
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
    <div className="p-4 sm:p-6 max-w-4xl">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <h1 className="text-xl sm:text-2xl font-bold text-black dark:text-zinc-50">Settings</h1>
        <div className="flex gap-2 flex-wrap">
          <button
            onClick={async () => {
              try {
                await exportChatLogs('json');
              } catch (err) {
                console.error(err);
                alert('Failed to export logs');
              }
            }}
            className="px-4 py-2 rounded-lg text-sm bg-blue-600 text-white hover:bg-blue-700 transition-colors"
          >
            Export JSON
          </button>
          <button
            onClick={async () => {
              try {
                await exportChatLogs('csv');
              } catch (err) {
                console.error(err);
                alert('Failed to export logs');
              }
            }}
            className="px-4 py-2 rounded-lg text-sm bg-green-600 text-white hover:bg-green-700 transition-colors"
          >
            Export CSV
          </button>
          <button
            onClick={async () => {
              if (!confirm('This will refresh all contact names directly from WhatsApp. This may take a few moments. Continue?')) {
                return;
              }
              try {
                const result = await refreshContactNames();
                alert(`Contact names refreshed!\nUpdated: ${result.updated || 0}\nErrors: ${result.errors || 0}\nTotal: ${result.total || 0}`);
                // Reload page to show updated names
                window.location.reload();
              } catch (err: unknown) {
                console.error(err);
                const msg = err instanceof Error ? err.message : String(err);
                alert(`Failed to refresh contact names: ${msg}`);
              }
            }}
            className="px-4 py-2 rounded-lg text-sm bg-purple-600 text-white hover:bg-purple-700 transition-colors"
          >
            Refresh Contact Names
          </button>
        </div>
      </div>

      <div className="space-y-6">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">Links</h2>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                Primary Link
              </label>
              <input
                type="text"
                value={settings.primary_link || ''}
                onChange={(e) => setSettings({ ...settings, primary_link: e.target.value })}
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
                placeholder="https://example.com"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                Backup Link
              </label>
              <input
                type="text"
                value={settings.backup_link || ''}
                onChange={(e) => setSettings({ ...settings, backup_link: e.target.value })}
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
                placeholder="https://backup.com"
              />
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">Product Information</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Enter information about your product or service here. The AI will use this information to answer customer questions when AI is enabled.
          </p>
          <textarea
            value={productInfo}
            onChange={(e) => setProductInfo(e.target.value)}
            rows={8}
            className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 resize-y"
            placeholder="Enter product/service information, features, pricing, etc. This will be used by AI to answer customer questions."
          />
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-2 text-black dark:text-zinc-50">Keyword & Replies</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            When auto-reply is on, the bot checks keywords first (exact match, case-insensitive). Reply can be text or the pre-recorded audio. Use one entry as welcome—e.g. keyword &quot;hi&quot; or &quot;start&quot;. Toggle auto-reply off to stop all keyword and AI replies.
          </p>
          <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-700">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800/50">
                  <th className="text-left py-3 px-4 font-medium text-zinc-700 dark:text-zinc-300 w-28">Keyword</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-700 dark:text-zinc-300 w-28">Reply with</th>
                  <th className="text-left py-3 px-4 font-medium text-zinc-700 dark:text-zinc-300">Reply message / Audio</th>
                  <th className="text-right py-3 px-4 font-medium text-zinc-700 dark:text-zinc-300 w-24">Actions</th>
                </tr>
              </thead>
              <tbody>
                {keywordReplies.map((row) => (
                  <tr key={row.id} className="border-b border-zinc-100 dark:border-zinc-800">
                    <td className="py-2 px-4">
                      <input
                        type="text"
                        value={row.keyword}
                        onChange={(e) => updateKeywordReply(row.id, 'keyword', e.target.value)}
                        placeholder="e.g. hi, price"
                        className="w-full px-3 py-1.5 border border-zinc-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 text-sm"
                      />
                    </td>
                    <td className="py-2 px-4">
                      <select
                        value={row.replyType}
                        onChange={(e) => updateKeywordReply(row.id, 'replyType', e.target.value)}
                        className="w-full px-3 py-1.5 border border-zinc-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 text-sm"
                      >
                        <option value="text">Text</option>
                        <option value="audio">Audio</option>
                      </select>
                    </td>
                    <td className="py-2 px-4">
                      {row.replyType === 'audio' ? (
                        <span className="text-zinc-500 dark:text-zinc-400 text-sm">Pre-recorded audio (saved below)</span>
                      ) : (
                        <textarea
                          value={row.message}
                          onChange={(e) => updateKeywordReply(row.id, 'message', e.target.value)}
                          placeholder="Reply when this keyword is sent"
                          rows={2}
                          className="w-full px-3 py-1.5 border border-zinc-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 text-sm resize-y"
                        />
                      )}
                    </td>
                    <td className="py-2 px-4 text-right">
                      <button
                        type="button"
                        onClick={() => removeKeywordReply(row.id)}
                        className="text-red-600 dark:text-red-400 hover:underline text-sm"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <button
            type="button"
            onClick={addKeywordReply}
            className="mt-3 px-4 py-2 rounded-lg text-sm bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
          >
            + Add keyword reply
          </button>
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-2 text-black dark:text-zinc-50">Pre-recorded audio</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Record or upload an audio message. When &quot;Send when inactive&quot; is on, the bot will send this audio if you haven&apos;t replied within the set minutes.
          </p>
          <div className="flex flex-wrap items-center gap-3 mb-4">
            {!recording ? (
              <button
                type="button"
                onClick={startRecording}
                disabled={audioSaving}
                className="px-4 py-2 rounded-lg text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                Record
              </button>
            ) : (
              <button
                type="button"
                onClick={stopRecording}
                className="px-4 py-2 rounded-lg text-sm bg-red-600 text-white hover:bg-red-700"
              >
                Stop & save
              </button>
            )}
            <label className="px-4 py-2 rounded-lg text-sm bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 cursor-pointer">
              Upload file
              <input type="file" accept="audio/*" onChange={handleAudioUpload} className="hidden" disabled={audioSaving} />
            </label>
          </div>
          {(settings.welcome_audio_path as string) && (
            <audio controls src={`${getAudioFileUrl()}?t=${Date.now()}`} className="w-full max-w-md mb-4" />
          )}
          <div className="space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.send_audio_when_inactive === 'true'}
                onChange={(e) => setSettings({ ...settings, send_audio_when_inactive: e.target.checked ? 'true' : 'false' })}
                className="rounded border-zinc-300 dark:border-zinc-600"
              />
              <span className="text-sm text-zinc-700 dark:text-zinc-300">Send when inactive</span>
            </label>
            <div className="flex items-center gap-2">
              <label className="text-sm text-zinc-700 dark:text-zinc-300">After</label>
              <input
                type="number"
                min={1}
                max={60}
                value={settings.inactive_minutes ?? 5}
                onChange={(e) => setSettings({ ...settings, inactive_minutes: e.target.value })}
                className="w-16 px-2 py-1 border border-zinc-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 text-sm"
              />
              <span className="text-sm text-zinc-600 dark:text-zinc-400">minutes without reply</span>
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">Delay Settings</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                Min Delay (seconds)
              </label>
              <input
                type="number"
                value={settings.min_delay_seconds || 3}
                onChange={(e) =>
                  setSettings({ ...settings, min_delay_seconds: e.target.value })
                }
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                Max Delay (seconds)
              </label>
              <input
                type="number"
                value={settings.max_delay_seconds || 10}
                onChange={(e) =>
                  setSettings({ ...settings, max_delay_seconds: e.target.value })
                }
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
              />
            </div>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">Auto-Reply Settings</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <label className="block text-sm font-medium mb-1 text-zinc-700 dark:text-zinc-300">
                  Enable Auto-Reply
                </label>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  When enabled, Shield will automatically respond to incoming messages. If OpenRouter API key is configured, AI will be used for intelligent responses. Otherwise, a simple acknowledgment message will be sent.
                </p>
                {saving && (
                  <p className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                    Saving...
                  </p>
                )}
              </div>
              <label className="relative inline-flex items-center cursor-pointer flex-shrink-0 ml-4">
                <input
                  type="checkbox"
                  checked={settings.auto_reply_enabled === 'true'}
                  onChange={(e) => handleAutoReplyToggle(e.target.checked)}
                  disabled={saving}
                  className="sr-only peer"
                />
                <div className={`w-11 h-6 bg-zinc-300 dark:bg-zinc-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-zinc-300 dark:peer-focus:ring-zinc-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600 ${saving ? 'opacity-50 cursor-not-allowed' : ''}`}></div>
              </label>
            </div>
          </div>
        </div>

        <div className="flex justify-end">
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-6 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200 disabled:opacity-50"
          >
            {saving ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

'use client';

import { useEffect, useState, useRef } from 'react';
import { getSettings, updateSettings, uploadAudio, getAudioBlobUrl, deleteAudio, renameAudio } from '../lib/api';
import { useSocketContext } from '../providers/SocketProvider';
import { useAuth } from '../providers/AuthProvider';

interface SavedAudio {
  id: string;
  path: string;
  name?: string;
}

interface KeywordReply {
  id: string;
  keyword: string;
  message: string;
  replyType: 'text' | 'audio';
  audioId?: string;
}

function AudioPlayerWithAuth({ audioId, className }: { audioId: string; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let blobUrl: string | null = null;
    getAudioBlobUrl(audioId)
      .then((url) => {
        blobUrl = url;
        setSrc(url);
        setError(false);
      })
      .catch(() => setError(true));
    return () => {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [audioId]);
  if (error) return <span className="text-sm text-zinc-500">Failed to load audio</span>;
  if (!src) return <span className="text-sm text-zinc-500">Loading…</span>;
  return <audio controls src={src} className={className} />;
}

function parseKeywordReplies(v: unknown): KeywordReply[] {
  const mapEntry = (e: Record<string, unknown>) => ({
    id: (e.id as string) || crypto.randomUUID(),
    keyword: (e.keyword as string) || '',
    message: (e.message as string) || '',
    replyType: (e.replyType === 'audio' ? 'audio' : 'text') as 'text' | 'audio',
    audioId: (e.audioId as string) || undefined,
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
  const [keywordReplies, setKeywordReplies] = useState<KeywordReply[]>([]);
  const [savedAudios, setSavedAudios] = useState<SavedAudio[]>([]);
  const [audioSaving, setAudioSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioListRef = useRef<HTMLUListElement>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [keywordSaveStatus, setKeywordSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [delayMin, setDelayMin] = useState<string>('3');
  const [delayMax, setDelayMax] = useState<string>('10');
  const [viewDelayMin, setViewDelayMin] = useState<string>('1');
  const [viewDelayMax, setViewDelayMax] = useState<string>('5');
  const { socket, connected } = useSocketContext();
  const { user, isAuthenticated, logout } = useAuth();

  function applyDelayFromData(data: Record<string, unknown>) {
    setDelayMin(String(Number(data.min_delay_seconds) || 3));
    setDelayMax(String(Number(data.max_delay_seconds) || 10));
    setViewDelayMin(String(Number(data.view_delay_min_seconds) || 1));
    setViewDelayMax(String(Number(data.view_delay_max_seconds) || 5));
  }

  useEffect(() => {
    loadSettings();
  }, []);

  // Listen for WebSocket settings updates
  useEffect(() => {
    if (!socket || !connected) return;

    const handleSettingsUpdate = (data: Record<string, unknown>) => {
      setSettings(data);
      setKeywordReplies(parseKeywordReplies(data.keyword_replies));
      setSavedAudios(parseSavedAudios(data.saved_audios));
      applyDelayFromData(data);
    };

    socket.on('settings_updated', handleSettingsUpdate);

    return () => {
      socket.off('settings_updated', handleSettingsUpdate);
    };
  }, [socket, connected]);

  function parseSavedAudios(v: unknown): SavedAudio[] {
    const toList = (value: unknown): SavedAudio[] => {
      if (!Array.isArray(value)) return [];
      return value as SavedAudio[];
    };
    if (Array.isArray(v)) return toList(v);
    if (typeof v === 'string') {
      try {
        const arr = JSON.parse(v);
        return toList(arr);
      } catch {
        return [];
      }
    }
    return [];
  }

  const loadSettings = async () => {
    try {
      const data = await getSettings();
      setSettings(data);
      setKeywordReplies(parseKeywordReplies(data.keyword_replies));
      setSavedAudios(parseSavedAudios(data.saved_audios));
      applyDelayFromData(data);
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
      const minDelay = Number(delayMin) || 3;
      const maxDelay = Number(delayMax) || 10;
      const viewMin = Number(viewDelayMin) || 1;
      const viewMax = Number(viewDelayMax) || 5;
      await updateSettings({
        ...settingsToSave,
        keyword_replies: keywordReplies,
        min_delay_seconds: minDelay,
        max_delay_seconds: maxDelay,
        view_delay_min_seconds: viewMin,
        view_delay_max_seconds: viewMax,
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

  const updateKeywordReply = (id: string, field: 'keyword' | 'message' | 'replyType' | 'audioId', value: string) => {
    setKeywordReplies(keywordReplies.map((r) => (r.id === id ? { ...r, [field]: value } : r)));
  };

  const removeKeywordReply = (id: string) => {
    setKeywordReplies(keywordReplies.filter((r) => r.id !== id));
  };

  const saveKeywords = async () => {
    setKeywordSaveStatus('saving');
    try {
      const { openrouter_api_key, ai_model, ...settingsToSave } = settings;
      await updateSettings({
        ...settingsToSave,
        keyword_replies: keywordReplies,
      });
      setKeywordSaveStatus('saved');
      setTimeout(() => setKeywordSaveStatus('idle'), 2000);
    } catch (err) {
      console.error(err);
      alert('Failed to save keywords');
      setKeywordSaveStatus('idle');
    }
  };

  const refreshAudioList = async () => {
    setAudioSaving(true);
    try {
      const data = await getSettings(true);
      setSavedAudios(parseSavedAudios(data.saved_audios));
      setSettings(data);
    } catch (err) {
      console.error(err);
    } finally {
      setAudioSaving(false);
    }
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
          const res = await uploadAudio(file) as { success?: boolean; id?: string; path?: string };
          const id = res?.id ?? (res as Record<string, string>)?.['id'];
          const path = res?.path ?? (res as Record<string, string>)?.['path'];
          if (id) {
            setSavedAudios((prev) => [...prev, { id, path: path || `audio/${id}.ogg` }]);
          }
          const data = await getSettings(true);
          setSettings(data);
          setSavedAudios(parseSavedAudios(data.saved_audios));
          setTimeout(() => audioListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
          alert('Audio saved. Use it in Keyword & Replies by choosing "Reply with: Audio".');
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
      const res = await uploadAudio(file) as { success?: boolean; id?: string; path?: string };
      const id = res?.id ?? (res as Record<string, string>)?.['id'];
      const path = res?.path ?? (res as Record<string, string>)?.['path'];
      if (id) {
        setSavedAudios((prev) => [...prev, { id, path: path || `audio/${id}.ogg` }]);
      }
      const data = await getSettings(true);
      setSettings(data);
      setSavedAudios(parseSavedAudios(data.saved_audios));
      setTimeout(() => audioListRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
      alert('Audio saved.');
    } catch (err) {
      console.error(err);
      alert('Failed to upload audio');
    } finally {
      setAudioSaving(false);
      e.target.value = '';
    }
  };

  const handleDeleteAudio = async (audioId: string) => {
    if (!confirm('Delete this audio?')) return;
    setAudioSaving(true);
    try {
      await deleteAudio(audioId);
      setSavedAudios((prev) => prev.filter((a) => a.id !== audioId));
    } catch (err) {
      console.error(err);
      alert('Failed to delete audio');
    } finally {
      setAudioSaving(false);
    }
  };

  const handleAudioNameChange = (audioId: string, name: string) => {
    setSavedAudios((prev) => prev.map((a) => (a.id === audioId ? { ...a, name } : a)));
  };

  const handleAudioNameBlur = async (audioId: string, name: string) => {
    const trimmed = name.trim();
    try {
      await renameAudio(audioId, trimmed);
    } catch (err) {
      console.error(err);
      alert('Failed to rename audio');
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
      const { openrouter_api_key, ai_model, ...settingsToSave } = newSettings as Record<string, unknown>;
      await updateSettings({
        ...settingsToSave,
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
      </div>

      <div className="space-y-6">
        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Keyword & Replies</h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={saveKeywords}
                disabled={keywordSaveStatus === 'saving' || saving}
                className="px-3 py-1.5 rounded-lg text-sm bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                {keywordSaveStatus === 'saving' ? 'Saving…' : keywordSaveStatus === 'saved' ? 'Saved' : 'Save changes'}
              </button>
            </div>
          </div>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            When auto-reply is on, the bot checks keywords first (exact match, case-insensitive). Reply can be text or the pre-recorded audio. Edit rows below and click <strong>Save changes</strong> to keep updates (including removals).
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
                        <select
                          value={row.audioId || ''}
                          onChange={(e) => updateKeywordReply(row.id, 'audioId', e.target.value)}
                          className="w-full px-3 py-1.5 border border-zinc-300 dark:border-zinc-600 rounded bg-white dark:bg-zinc-900 text-black dark:text-zinc-50 text-sm"
                        >
                          <option value="">Select audio…</option>
                          {savedAudios.map((a) => {
                            const label = a.name && a.name.trim().length > 0
                              ? a.name
                              : `Audio ${a.id.slice(0, 8)}`;
                            return (
                              <option key={a.id} value={a.id}>
                                {label}
                              </option>
                            );
                          })}
                        </select>
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
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={addKeywordReply}
              className="px-4 py-2 rounded-lg text-sm bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 transition-colors"
            >
              + Add keyword reply
            </button>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">Click &quot;Save changes&quot; above after adding or removing rows.</span>
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-2 text-black dark:text-zinc-50">Pre-recorded audios</h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Record or upload audios. Each is sent only when a keyword is triggered—choose &quot;Reply with: Audio&quot; and pick an audio above.
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
            <button
              type="button"
              onClick={refreshAudioList}
              disabled={audioSaving}
              className="px-4 py-2 rounded-lg text-sm bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-600 disabled:opacity-50"
            >
              Refresh list
            </button>
          </div>
          <ul ref={audioListRef} className="space-y-2">
            {savedAudios.map((a) => (
              <li
                key={a.id}
                className="flex flex-col sm:flex-row sm:items-center gap-2 py-1.5 px-3 rounded-lg bg-zinc-50 dark:bg-zinc-800/50 border border-zinc-200 dark:border-zinc-700"
              >
                <div className="flex-1 flex flex-col gap-1">
                  <input
                    type="text"
                    value={a.name ?? ''}
                    onChange={(e) => handleAudioNameChange(a.id, e.target.value)}
                    onBlur={(e) => handleAudioNameBlur(a.id, e.target.value)}
                    placeholder={`Audio ${a.id.slice(0, 8)}`}
                    className="w-full px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-900 text-sm text-black dark:text-zinc-50"
                  />
                  <AudioPlayerWithAuth audioId={a.id} className="max-w-sm h-8" />
                </div>
                <button
                  type="button"
                  onClick={() => handleDeleteAudio(a.id)}
                  disabled={audioSaving}
                  className="self-start sm:self-auto p-1.5 rounded text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/30 disabled:opacity-50"
                  title="Delete this audio"
                  aria-label="Delete this audio"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/></svg>
                </button>
              </li>
            ))}
          </ul>
          {savedAudios.length === 0 && (
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-2">No audios yet. Record or upload one above.</p>
          )}
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">Delay Settings</h2>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                Reply delay — Min (seconds)
              </label>
              <input
                type="number"
                min={0}
                value={delayMin}
                onChange={(e) => setDelayMin(e.target.value)}
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                Reply delay — Max (seconds)
              </label>
              <input
                type="number"
                min={0}
                value={delayMax}
                onChange={(e) => setDelayMax(e.target.value)}
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                View delay — Min (seconds)
              </label>
              <input
                type="number"
                min={0}
                value={viewDelayMin}
                onChange={(e) => setViewDelayMin(e.target.value)}
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
              />
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Before marking message as read</p>
            </div>
            <div>
              <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                View delay — Max (seconds)
              </label>
              <input
                type="number"
                min={0}
                value={viewDelayMax}
                onChange={(e) => setViewDelayMax(e.target.value)}
                className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
              />
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">Before marking message as read</p>
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
                  When enabled, Shield will automatically respond to incoming messages using your current auto-reply setup.
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

        {isAuthenticated && user && (
          <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6 mt-6">
            <h2 className="text-lg font-semibold mb-2 text-black dark:text-zinc-50">Account</h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
              Signed in as <span className="font-medium text-zinc-900 dark:text-zinc-50">{user.email}</span>
            </p>
            <button
              type="button"
              onClick={() => {
                if (confirm('Log out of Shield? You will need to sign in again to access your bot.')) {
                  logout();
                }
              }}
              className="px-4 py-2 rounded-lg text-sm bg-zinc-200 dark:bg-zinc-700 text-zinc-800 dark:text-zinc-200 hover:bg-red-100 dark:hover:bg-red-900/30 hover:text-red-700 dark:hover:text-red-400 transition-colors"
            >
              Log out
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

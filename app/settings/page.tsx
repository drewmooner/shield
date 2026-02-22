'use client';

import { useEffect, useState } from 'react';
import { getSettings, updateSettings, exportChatLogs, refreshContactNames } from '../lib/api';
import { useSocketContext } from '../providers/SocketProvider';

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({});
  const [productInfo, setProductInfo] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const { socket, connected } = useSocketContext();

  useEffect(() => {
    loadSettings();
  }, []);

  // Listen for WebSocket settings updates
  useEffect(() => {
    if (!socket || !connected) return;

    const handleSettingsUpdate = (data: any) => {
      setSettings(data);
      setProductInfo(data.product_info || '');
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
      setProductInfo(data.product_info || '');
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
      });
      // Settings will be updated via WebSocket event, no need to reload
      console.log(`✅ Auto-reply ${settings.auto_reply_enabled === 'true' ? 'enabled' : 'disabled'} - takes effect immediately`);
    } catch (err) {
      console.error(err);
      alert('Failed to save settings');
    } finally {
      setSaving(false);
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
      });
      // Settings will sync via WebSocket event - no need to reload
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
              } catch (err: any) {
                console.error(err);
                alert(`Failed to refresh contact names: ${err.message}`);
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

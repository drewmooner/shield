'use client';

import { useEffect, useState } from 'react';
import { getSettings, updateSettings, exportChatLogs } from '../lib/api';

export default function SettingsPage() {
  const [settings, setSettings] = useState<any>({});
  const [templates, setTemplates] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [newTemplate, setNewTemplate] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editValue, setEditValue] = useState('');

  useEffect(() => {
    loadSettings();
  }, []);

  const loadSettings = async () => {
    try {
      const data = await getSettings();
      setSettings(data);
      setTemplates(data.templates || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await updateSettings({
        ...settings,
        templates,
      });
      alert('Settings saved!');
    } catch (err) {
      console.error(err);
      alert('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const addTemplate = () => {
    if (newTemplate.trim()) {
      setTemplates([...templates, newTemplate]);
      setNewTemplate('');
    }
  };

  const removeTemplate = (index: number) => {
    setTemplates(templates.filter((_, i) => i !== index));
  };

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditValue(templates[index]);
  };

  const saveEdit = (index: number) => {
    if (editValue.trim()) {
      const newTemplates = [...templates];
      newTemplates[index] = editValue.trim();
      setTemplates(newTemplates);
      setEditingIndex(null);
      setEditValue('');
    }
  };

  const cancelEdit = () => {
    setEditingIndex(null);
    setEditValue('');
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
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">AI Settings</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-sm font-medium mb-1 text-zinc-700 dark:text-zinc-300">
                  Enable AI Responses
                </label>
                <p className="text-xs text-zinc-500 dark:text-zinc-400">
                  When enabled, Shield will use AI to respond naturally to conversations and intelligently select templates when users ask about links/products.
                </p>
              </div>
              <label className="relative inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.ai_enabled === 'true'}
                  onChange={(e) =>
                    setSettings({ ...settings, ai_enabled: e.target.checked ? 'true' : 'false' })
                  }
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-zinc-300 dark:bg-zinc-700 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-zinc-300 dark:peer-focus:ring-zinc-800 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-zinc-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-green-600"></div>
              </label>
            </div>
            {settings.ai_enabled === 'true' && (
              <div className="mt-4 pt-4 border-t border-zinc-200 dark:border-zinc-700">
                <div className="mb-4">
                  <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                    OpenRouter API Key
                  </label>
                  <input
                    type="password"
                    value={settings.openrouter_api_key || ''}
                    onChange={(e) => setSettings({ ...settings, openrouter_api_key: e.target.value })}
                    className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
                    placeholder="sk-or-v1-..."
                  />
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                    Get your API key from{' '}
                    <a href="https://openrouter.ai" target="_blank" rel="noopener noreferrer" className="text-blue-600 dark:text-blue-400 hover:underline">
                      openrouter.ai
                    </a>
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-2 text-zinc-700 dark:text-zinc-300">
                    AI Model
                  </label>
                  <select
                    value={settings.ai_model || 'openai/gpt-3.5-turbo'}
                    onChange={(e) => setSettings({ ...settings, ai_model: e.target.value })}
                    className="w-full px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
                  >
                    <option value="openai/gpt-3.5-turbo">GPT-3.5 Turbo</option>
                    <option value="openai/gpt-4">GPT-4</option>
                    <option value="anthropic/claude-3-haiku">Claude 3 Haiku</option>
                    <option value="anthropic/claude-3-opus">Claude 3 Opus</option>
                    <option value="google/gemini-pro">Gemini Pro</option>
                  </select>
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 text-black dark:text-zinc-50">
            Message Templates
          </h2>
          <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
            Use link placeholders in your templates:
            <br />
            • <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{'{{primary_link}}'}</code> or <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{'{{link}}'}</code> for primary link
            <br />
            • <code className="bg-zinc-100 dark:bg-zinc-800 px-1 rounded">{'{{backup_link}}'}</code> for backup link
            <br />
            The AI will automatically choose which link to use based on the user's question.
          </p>
          <div className="space-y-2 mb-4">
            {templates.map((template, index) => (
              <div key={index} className="flex items-center gap-2">
                {editingIndex === index ? (
                  <>
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="flex-1 px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
                      autoFocus
                    />
                    <button
                      onClick={() => saveEdit(index)}
                      className="px-3 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700"
                    >
                      Save
                    </button>
                    <button
                      onClick={cancelEdit}
                      className="px-3 py-2 bg-zinc-600 text-white rounded-lg hover:bg-zinc-700"
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <>
                    <input
                      type="text"
                      value={template}
                      readOnly
                      className="flex-1 px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-zinc-50 dark:bg-zinc-800 text-black dark:text-zinc-50 cursor-not-allowed"
                    />
                    <button
                      onClick={() => startEdit(index)}
                      className="px-3 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
                    >
                      Edit
                    </button>
                    <button
                      onClick={() => removeTemplate(index)}
                      className="px-3 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newTemplate}
              onChange={(e) => setNewTemplate(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && addTemplate()}
              placeholder="New template..."
              className="flex-1 px-4 py-2 border border-zinc-300 dark:border-zinc-700 rounded-lg bg-white dark:bg-zinc-900 text-black dark:text-zinc-50"
            />
            <button
              onClick={addTemplate}
              className="px-4 py-2 bg-zinc-900 dark:bg-zinc-50 text-white dark:text-black rounded-lg hover:bg-zinc-800 dark:hover:bg-zinc-200"
            >
              Add
            </button>
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


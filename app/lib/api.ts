function getApiUrl() {
  // In browser: use NEXT_PUBLIC_API_URL so production (Vercel) points to Render backend
  // Set NEXT_PUBLIC_API_URL=https://your-app.onrender.com/api on Vercel
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL || '/api';
  }
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3002/api';
}

const API_URL = getApiUrl();

const CLIENT_ID_KEY = 'shield_client_id';

/** Sync: returns stored client ID or null (call ensureClientId() first for API/socket). */
export function getClientId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(CLIENT_ID_KEY);
}

/** Ensures we have a client ID (fetch from backend if missing), stores it, returns it. */
export async function ensureClientId(): Promise<string> {
  if (typeof window !== 'undefined') {
    const stored = localStorage.getItem(CLIENT_ID_KEY);
    if (stored) return stored;
  }
  const res = await fetch(`${API_URL}/client/id`, { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to get client ID');
  const { clientId } = await res.json();
  if (typeof window !== 'undefined' && clientId) {
    localStorage.setItem(CLIENT_ID_KEY, clientId);
  }
  return clientId || 'default';
}

async function fetchWithClientId(url: string, options: RequestInit = {}): Promise<Response> {
  const clientId = await ensureClientId();
  const headers = new Headers(options.headers);
  headers.set('X-Client-Id', clientId);
  return fetch(url, { ...options, headers });
}

export async function getBotStatus(options?: { signal?: AbortSignal }) {
  const url = `${API_URL}/bot/status`;
  const res = await fetchWithClientId(url, {
    cache: 'no-store',
    signal: options?.signal,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Backend not responding: ${res.status} ${res.statusText} - ${text.substring(0, 100)}`);
  }
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return res.json();
  } else {
    const text = await res.text();
    throw new Error(`Invalid response: ${text.substring(0, 100)}`);
  }
}

async function safeJsonResponse(res: Response) {
  const contentType = res.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return res.json();
  } else {
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Request failed: ${res.status} ${res.statusText} - ${text.substring(0, 200)}`);
    }
    throw new Error(`Invalid JSON response: ${text.substring(0, 200)}`);
  }
}

export async function pauseBot() {
  const res = await fetchWithClientId(`${API_URL}/bot/pause`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to pause: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function resumeBot() {
  const res = await fetchWithClientId(`${API_URL}/bot/resume`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to resume: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function reconnectBot() {
  const res = await fetchWithClientId(`${API_URL}/bot/reconnect`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to reconnect: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function getLeads(status?: string) {
  const url = status ? `${API_URL}/leads?status=${status}` : `${API_URL}/leads`;
  const res = await fetchWithClientId(url, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get leads: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function getLead(id: string) {
  const res = await fetchWithClientId(`${API_URL}/leads/${id}`, {
    cache: 'no-store',
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get lead: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function completeLead(id: string) {
  const res = await fetchWithClientId(`${API_URL}/leads/${id}/complete`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to complete lead: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function deleteLead(id: string) {
  const res = await fetchWithClientId(`${API_URL}/leads/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete lead: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function clearAllMessages() {
  const res = await fetchWithClientId(`${API_URL}/messages/clear`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to clear messages: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function sendMessage(phoneNumber: string, message: string, leadId?: string) {
  const res = await fetchWithClientId(`${API_URL}/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phoneNumber, message, leadId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to send message: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function getSettings(noCache = false) {
  const res = await fetchWithClientId(`${API_URL}/settings${noCache ? `?t=${Date.now()}` : ''}`, {
    ...(noCache ? { cache: 'no-store' as RequestCache } : {}),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get settings: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function updateSettings(settings: Record<string, unknown>) {
  const res = await fetchWithClientId(`${API_URL}/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update settings: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function getLogs(limit = 50) {
  const res = await fetchWithClientId(`${API_URL}/logs?limit=${limit}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get logs: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function disconnectBot() {
  const res = await fetchWithClientId(`${API_URL}/bot/disconnect`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to disconnect: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function exportChatLogs(format: 'json' | 'csv' = 'json') {
  try {
    const url = `${API_URL}/export/logs?format=${format}`;
    console.log('Exporting from:', url);
    const res = await fetchWithClientId(url);
    if (!res.ok) {
      const errorText = await res.text();
      console.error('Export error:', res.status, errorText);
      throw new Error(`Export failed: ${res.status} ${res.statusText}`);
    }
    const blob = await res.blob();
    const downloadUrl = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = downloadUrl;
    a.download = `shield-logs-${new Date().toISOString().split('T')[0]}.${format}`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(downloadUrl);
  } catch (error) {
    console.error('Export error:', error);
    throw error;
  }
}

export async function refreshContactNames() {
  const res = await fetchWithClientId(`${API_URL}/contacts/refresh`, { method: 'POST' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to refresh contact names: ${res.status} ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export function getAudioFileUrl(id: string): string {
  const base = typeof window !== 'undefined' ? (process.env.NEXT_PUBLIC_API_URL || window.location.origin) : '';
  const api = base ? base.replace(/\/api\/?$/, '') || base : '';
  const path = api ? `${api}/api/settings/audio/file?id=${encodeURIComponent(id)}` : `/api/settings/audio/file?id=${encodeURIComponent(id)}`;
  return path;
}

export async function uploadAudio(file: File) {
  const formData = new FormData();
  formData.append('audio', file);
  const res = await fetchWithClientId(`${API_URL}/settings/audio`, { method: 'POST', body: formData });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}

export async function deleteAudio(id: string) {
  const res = await fetchWithClientId(`${API_URL}/settings/audio/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Delete failed: ${text.substring(0, 100)}`);
  }
  return safeJsonResponse(res);
}
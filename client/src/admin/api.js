import { storage } from '../storage';

function buildUrl(path, params = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v !== undefined && v !== null && v !== '') {
      qs.set(k, String(v));
    }
  }
  const query = qs.toString();
  return query ? `${path}${path.includes('?') ? '&' : '?'}${query}` : path;
}

export const adminApi = {
  getToken() {
    return storage.get('token');
  },
  setToken(token) {
    storage.set('token', token);
  },
  clearToken() {
    storage.remove('token', 'active_room', 'session_id');
  },

  async request(path, { method = 'GET', body = undefined, params = null } = {}) {
    const token = this.getToken();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const url = params ? buildUrl(path, params) : path;
    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      const err = new Error(`Respon server tidak valid (${res.status}).`);
      err.status = res.status;
      throw err;
    }

    if (!res.ok || data.success === false) {
      const err = new Error(data.error || `Permintaan gagal (${res.status}).`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  },

  get(path, params) {
    return this.request(path, { method: 'GET', params });
  },
  post(path, body) {
    return this.request(path, { method: 'POST', body });
  },
  patch(path, body) {
    return this.request(path, { method: 'PATCH', body });
  },
  put(path, body) {
    return this.request(path, { method: 'PUT', body });
  },
  del(path) {
    return this.request(path, { method: 'DELETE' });
  },

  async downloadCsv(path, params, fallbackFilename = 'export.csv') {
    const token = this.getToken();
    const url = buildUrl(path, params);
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      let msg = `Gagal mengunduh CSV (${res.status}).`;
      try {
        const parsed = JSON.parse(txt);
        if (parsed?.error) msg = parsed.error;
      } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const disp = res.headers.get('Content-Disposition') || '';
    const match = /filename="?([^"]+)"?/i.exec(disp);
    a.href = objectUrl;
    a.download = match ? match[1] : fallbackFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }
};

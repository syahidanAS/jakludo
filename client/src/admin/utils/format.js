export function formatIdr(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

export function formatNumber(value) {
  return Number(value || 0).toLocaleString('id-ID');
}

export function formatDateTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return String(iso);
  }
}

export function formatRelativeTime(iso) {
  if (!iso) return '-';
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  if (!Number.isFinite(ms)) return '-';
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (diffSec < 60) return `${diffSec} dtk lalu`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin} mnt lalu`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr} jam lalu`;
  return `${Math.floor(diffHr / 24)} hr lalu`;
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}h ${h}j ${m}m`;
  if (h > 0) return `${h}j ${m}m`;
  return `${m}m ${s % 60}d`;
}

export const ADMIN_PASSWORD_RULES = [
  { key: 'length', label: 'Min 8 karakter', test: p => p.length >= 8 },
  { key: 'lower', label: 'Huruf kecil (a-z)', test: p => /[a-z]/.test(p) },
  { key: 'upper', label: 'Huruf besar (A-Z)', test: p => /[A-Z]/.test(p) },
  { key: 'digit', label: 'Angka (0-9)', test: p => /[0-9]/.test(p) },
  { key: 'symbol', label: 'Simbol (!@#$...)', test: p => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(p) }
];

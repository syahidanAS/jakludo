import React, { useEffect, useState } from 'react';
import AdminModal from './AdminModal';

export default function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Konfirmasi',
  variant = 'danger',
  requireReason = false,
  reasonLabel = 'Alasan (Wajib untuk Audit)',
  defaultReason = '',
  reasonPlaceholder = 'Tulis alasan tindakan ini...',
  busy = false
}) {
  const [reason, setReason] = useState(defaultReason);
  const [err, setErr] = useState('');

  useEffect(() => {
    if (isOpen) {
      setReason(defaultReason || '');
      setErr('');
    }
  }, [isOpen, defaultReason]);

  const handleConfirm = e => {
    e.preventDefault();
    const clean = reason.trim();
    if (requireReason && !clean) {
      setErr('Alasan wajib diisi sebelum melanjutkan.');
      return;
    }
    onConfirm?.(clean);
  };

  const btnClass =
    variant === 'danger'
      ? 'adm-btn adm-btn--danger'
      : variant === 'warning'
      ? 'adm-btn adm-btn--warning'
      : 'adm-btn adm-btn--primary';

  return (
    <AdminModal isOpen={isOpen} onClose={busy ? undefined : onClose} title={title} size="sm">
      <form onSubmit={handleConfirm} className="adm-form">
        <p className="adm-confirm-msg">{message}</p>

        {(requireReason || defaultReason) && (
          <div className="adm-field">
            <label className="adm-label">{reasonLabel}</label>
            <textarea
              className="adm-textarea"
              rows={3}
              value={reason}
              onChange={e => {
                setReason(e.target.value);
                if (err) setErr('');
              }}
              placeholder={reasonPlaceholder}
              required={requireReason}
              disabled={busy}
            />
          </div>
        )}

        {err && <p className="adm-alert adm-alert--danger">{err}</p>}

        <div className="adm-row-actions adm-row-actions--end">
          <button type="button" className="adm-btn adm-btn--secondary" onClick={onClose} disabled={busy}>
            Batal
          </button>
          <button type="submit" className={btnClass} disabled={busy}>
            {busy ? 'Memproses...' : confirmLabel}
          </button>
        </div>
      </form>
    </AdminModal>
  );
}

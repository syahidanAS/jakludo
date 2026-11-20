import React from 'react';
import Icon from './Icon';
import { sound } from '../sound';

// Bar peringatan di bagian atas aplikasi bagi akun login yang belum melengkapi alamat email
export default function EmailReminderBanner({ user, hidden = false, onOpenEditEmail, onDismiss }) {
  if (!user || hidden || String(user.email || '').trim().length > 0) {
    return null;
  }

  return (
    <div className="email-alert-bar" role="alert">
      <div className="email-alert-bar__inner">
        <div className="email-alert-bar__content">
          <span className="email-alert-bar__icon" aria-hidden="true">
            <Icon name="warning" size={18} />
          </span>
          <p className="email-alert-bar__text">
            <strong>Alamat email belum dilengkapi.</strong> Segera isi alamat email di profil akunmu untuk keamanan dan pemulihan akun.
          </p>
        </div>
        <div className="email-alert-bar__actions">
          <button
            type="button"
            className="btn btn--primary btn--sm email-alert-bar__cta"
            onClick={() => {
              sound.playClick();
              onOpenEditEmail?.();
            }}
          >
            <Icon name="mail" size={15} />
            <span>Lengkapi Email</span>
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--plain email-alert-bar__close"
            aria-label="Tutup pengingat email sementara"
            title="Tutup sementara"
            onClick={() => {
              sound.playClick();
              onDismiss?.();
            }}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

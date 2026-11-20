import React, { useEffect, useState } from 'react';
import { adminApi } from './api';
import AdminIcon from './components/AdminIcons';
import playgoLogo from '../assets/playgo-logo-sm.webp';

function loadRecaptchaScript(siteKey) {
  if (!siteKey || typeof window === 'undefined') return Promise.resolve(null);
  if (window.grecaptcha) return Promise.resolve(window.grecaptcha);

  return new Promise(resolve => {
    const scriptId = 'google-recaptcha-v3-script';
    let script = document.getElementById(scriptId);
    if (script) {
      if (window.grecaptcha) return resolve(window.grecaptcha);
      script.addEventListener('load', () => resolve(window.grecaptcha));
      script.addEventListener('error', () => resolve(null));
      return;
    }
    script = document.createElement('script');
    script.id = scriptId;
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`;
    script.async = true;
    script.onload = () => resolve(window.grecaptcha);
    script.onerror = () => resolve(null);
    document.head.appendChild(script);
  });
}

async function executeRecaptcha(siteKey, action) {
  if (!siteKey || typeof window === 'undefined') return null;
  try {
    await loadRecaptchaScript(siteKey);
    if (!window.grecaptcha) return null;
    return new Promise(resolve => {
      try {
        window.grecaptcha.ready(async () => {
          try {
            const token = await window.grecaptcha.execute(siteKey, { action });
            resolve(token);
          } catch {
            resolve(null);
          }
        });
      } catch {
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

export default function AdminLogin({ nonAdminUser = null, onLoginSuccess, onSwitchAccount, theme, onToggleTheme }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [recaptchaCfg, setRecaptchaCfg] = useState({ enabled: false, siteKey: '' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    fetch('/api/auth/recaptcha/config')
      .then(r => r.json())
      .then(data => {
        if (active && data?.success && data.enabled && data.siteKey) {
          setRecaptchaCfg({ enabled: true, siteKey: data.siteKey });
          loadRecaptchaScript(data.siteKey);
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  const handleSubmit = async e => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Username dan password wajib diisi.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      let recaptchaToken = null;
      if (recaptchaCfg.enabled && recaptchaCfg.siteKey) {
        recaptchaToken = await executeRecaptcha(recaptchaCfg.siteKey, 'login');
      }

      const data = await adminApi.post('/api/auth/login', {
        username: username.trim(),
        password,
        recaptchaToken
      });

      const user = data.user;
      if (!user || (!user.isAdmin && user.role !== 'admin')) {
        // Cabut token non-admin yang baru dibuat agar tidak meninggalkan sesi non-admin
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${data.token}` }
        }).catch(() => {});
        throw new Error('Akun ini terdaftar sebagai pemain biasa dan tidak memiliki hak akses Admin CMS.');
      }

      adminApi.setToken(data.token);
      onLoginSuccess?.(user);
    } catch (err) {
      setError(err.message || 'Gagal masuk ke Admin CMS.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="adm-login-wrap">
      <div className="adm-login-topbar">
        <a href="/" className="adm-btn adm-btn--ghost adm-btn--sm">
          ← Kembali ke PlayGo
        </a>
        <button
          type="button"
          className="adm-icon-btn"
          aria-label={theme === 'dark' ? 'Ganti ke tema terang' : 'Ganti ke tema gelap'}
          onClick={onToggleTheme}
        >
          <AdminIcon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
        </button>
      </div>

      <section className="adm-login-card" aria-label="Login Admin CMS">
        <div className="adm-login-brand">
          <img src={playgoLogo} alt="PlayGo" className="adm-login-logo" width="48" height="48" />
          <div>
            <h1>
              Play<span>Go</span> Admin CMS
            </h1>
            <p>Panel Kontrol Terpisah · Operasional &amp; Monitoring</p>
          </div>
        </div>

        {nonAdminUser ? (
          <div className="adm-stack">
            <div className="adm-alert adm-alert--danger" role="alert">
              <strong>Akses Ditolak (403)</strong>
              <div>
                Kamu sedang login sebagai <strong>@{nonAdminUser.username}</strong> (role: <code>{nonAdminUser.role || 'player'}</code>).
                Halaman ini hanya dapat diakses oleh akun dengan role <code>admin</code>.
              </div>
            </div>
            <div className="adm-row-actions">
              <button type="button" className="adm-btn adm-btn--primary" onClick={onSwitchAccount}>
                Keluar &amp; Masuk Akun Admin
              </button>
              <a href="/" className="adm-btn adm-btn--secondary">
                Kembali ke PlayGo
              </a>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="adm-form">
            <div className="adm-field">
              <label htmlFor="adm-login-username" className="adm-label">
                Username Admin
              </label>
              <input
                id="adm-login-username"
                type="text"
                className="adm-input"
                autoComplete="username"
                placeholder="Masukkan username admin"
                value={username}
                onChange={e => setUsername(e.target.value)}
                disabled={submitting}
                required
              />
            </div>

            <div className="adm-field">
              <label htmlFor="adm-login-password" className="adm-label">
                Password
              </label>
              <div className="adm-password-wrap">
                <input
                  id="adm-login-password"
                  type={showPassword ? 'text' : 'password'}
                  className="adm-input"
                  autoComplete="current-password"
                  placeholder="Masukkan password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  disabled={submitting}
                  required
                />
                <button
                  type="button"
                  className="adm-btn adm-btn--ghost adm-btn--sm"
                  onClick={() => setShowPassword(v => !v)}
                >
                  {showPassword ? 'Sembunyikan' : 'Lihat'}
                </button>
              </div>
            </div>

            {error && (
              <div className="adm-alert adm-alert--danger" role="alert">
                {error}
              </div>
            )}

            <button type="submit" className="adm-btn adm-btn--primary adm-btn--block" disabled={submitting}>
              <AdminIcon name="shield" size={17} />
              <span>{submitting ? 'Memverifikasi Akses...' : 'Masuk ke Admin CMS'}</span>
            </button>

            <p className="adm-muted adm-login-hint">
              Hanya akun dengan role <code>admin</code> atau username terdaftar di <code>ADMIN_USERNAMES</code> yang dapat mengakses panel ini.
            </p>
          </form>
        )}
      </section>
    </main>
  );
}

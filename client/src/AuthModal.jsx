import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import Modal from './components/Modal';
import Icon from './components/Icon';
import { sound } from './sound';

function GoogleIcon({ size = 20 }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" focusable="false">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
    </svg>
  );
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Respon server tidak valid (${res.status}).`);
  }
  if (!res.ok || !data.success) throw new Error(data.error || 'Permintaan gagal. Coba lagi.');
  return data;
}

// Aturan password sama dengan validasi server (server/db.js)
const PASSWORD_RULES = [
  { key: 'length', label: 'Minimal 8 karakter', test: p => p.length >= 8 },
  { key: 'lower', label: 'Huruf kecil (a-z)', test: p => /[a-z]/.test(p) },
  { key: 'upper', label: 'Huruf besar (A-Z)', test: p => /[A-Z]/.test(p) },
  { key: 'digit', label: 'Angka (0-9)', test: p => /[0-9]/.test(p) },
  { key: 'symbol', label: 'Simbol (@, #, $, dll)', test: p => /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?~`]/.test(p) }
];

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
          } catch (err) {
            console.warn('[reCAPTCHA execute error]', err);
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

function PasswordField({ id, label, value, onChange, autoComplete, describedBy, disabled }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field__with-action">
        <input
          id={id}
          className="input"
          type={visible ? 'text' : 'password'}
          value={value}
          onChange={e => onChange(e.target.value)}
          autoComplete={autoComplete}
          aria-describedby={describedBy}
          disabled={disabled}
          required
        />
        <button type="button" className="icon-btn icon-btn--plain" aria-pressed={visible} aria-label={visible ? 'Sembunyikan password' : 'Tampilkan password'} onClick={() => setVisible(v => !v)}>
          <Icon name={visible ? 'eye-off' : 'eye'} size={18} />
        </button>
      </div>
    </div>
  );
}

export default function AuthModal({ isOpen, onClose, onLoginSuccess }) {
  const [tab, setTab] = useState('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleConfig, setGoogleConfig] = useState({ enabled: false, clientId: '' });
  const [recaptchaConfig, setRecaptchaConfig] = useState({ enabled: false, siteKey: '' });
  const [googleHelpOpen, setGoogleHelpOpen] = useState(false);
  const [gisReady, setGisReady] = useState(false);
  const googleBtnRef = useRef(null);
  const ids = { user: useId(), pass: useId(), confirm: useId(), rules: useId(), hint: useId() };

  // Ambil konfigurasi Google Client ID & reCAPTCHA v3 dari server saat modal terbuka
  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetch('/api/auth/google/config')
      .then(res => res.json())
      .then(data => {
        if (active && data?.success) {
          setGoogleConfig({ enabled: Boolean(data.enabled), clientId: data.clientId || '' });
        }
      })
      .catch(() => {});

    fetch('/api/auth/recaptcha/config')
      .then(res => res.json())
      .then(data => {
        if (active && data?.success) {
          setRecaptchaConfig({ enabled: Boolean(data.enabled), siteKey: data.siteKey || '' });
          if (data.siteKey) {
            loadRecaptchaScript(data.siteKey).catch(() => {});
          }
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [isOpen]);

  const handleGoogleResponse = async response => {
    if (!response?.credential) return;
    setLoading(true);
    setError('');
    sound.playClick();
    try {
      const data = await postJson('/api/auth/google', { credential: response.credential });
      onLoginSuccess(data.user, data.token);
    } catch (err) {
      setError(err.message || 'Gagal masuk dengan akun Google.');
    } finally {
      setLoading(false);
    }
  };

  // Inisialisasi Google Identity Services (GIS) jika Google Client ID terkonfigurasi
  useEffect(() => {
    if (!isOpen || !googleConfig.clientId || typeof window === 'undefined') {
      setGisReady(false);
      return;
    }

    let cancelled = false;
    const tryInitGsi = () => {
      if (cancelled || !window.google?.accounts?.id || !googleBtnRef.current) return;
      try {
        window.google.accounts.id.initialize({
          client_id: googleConfig.clientId,
          callback: handleGoogleResponse,
          auto_select: false,
          cancel_on_tap_outside: true
        });

        // Bersihkan render sebelumnya agar tidak bertumpuk
        googleBtnRef.current.innerHTML = '';
        window.google.accounts.id.renderButton(googleBtnRef.current, {
          theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline',
          size: 'large',
          width: 320,
          text: tab === 'register' ? 'signup_with' : 'signin_with',
          shape: 'rectangular',
          logo_alignment: 'left'
        });
        setGisReady(true);
      } catch (err) {
        console.warn('[Google GIS init]', err);
      }
    };

    if (window.google?.accounts?.id) {
      tryInitGsi();
    } else {
      const interval = setInterval(() => {
        if (window.google?.accounts?.id) {
          clearInterval(interval);
          tryInitGsi();
        }
      }, 250);
      return () => {
        cancelled = true;
        clearInterval(interval);
      };
    }

    return () => {
      cancelled = true;
    };
  }, [isOpen, googleConfig.clientId, tab]);

  useEffect(() => {
    if (isOpen) {
      setError('');
      setConfirmPassword('');
      setGoogleHelpOpen(false);
    }
  }, [isOpen, tab]);

  const rules = useMemo(() => PASSWORD_RULES.map(r => ({ ...r, ok: r.test(password) })), [password]);
  const passwordOk = rules.every(r => r.ok);
  const matches = confirmPassword.length > 0 && password === confirmPassword;
  const isRegister = tab === 'register';

  const switchTab = next => {
    setTab(next);
    setError('');
  };

  const handleCustomGoogleClick = () => {
    setError('');
    sound.playClick();
    if (googleConfig.clientId && window.google?.accounts?.id) {
      window.google.accounts.id.prompt();
    } else {
      setGoogleHelpOpen(prev => !prev);
    }
  };

  const handleSimulatedGoogleLogin = async () => {
    setLoading(true);
    setError('');
    sound.playClick();
    try {
      const uniqueSuffix = Date.now().toString(36);
      const mockPayload = {
        sub: 'mock_google_' + uniqueSuffix,
        email: `pemain_${uniqueSuffix}@gmail.com`,
        name: 'Pemain Google',
        picture: null
      };
      const token = 'mock_google_token_' + btoa(JSON.stringify(mockPayload));
      const data = await postJson('/api/auth/google', { credential: token });
      onLoginSuccess(data.user, data.token);
    } catch (err) {
      setError(err.message || 'Gagal simulasi login Google.');
    } finally {
      setLoading(false);
    }
  };

  const submit = async e => {
    e.preventDefault();
    const name = username.trim();
    if (!name || !password) return setError('Username dan password wajib diisi.');
    if (isRegister) {
      if (!/^[a-zA-Z0-9_]{3,20}$/.test(name)) return setError('Username 3-20 karakter: huruf, angka, atau garis bawah (_).');
      if (!passwordOk) return setError('Password belum memenuhi semua syarat di bawah.');
      if (!matches) return setError('Ketik ulang password belum sama.');
    }

    setLoading(true);
    setError('');
    sound.playClick();
    try {
      const action = isRegister ? 'register' : 'login';
      const recaptchaToken = await executeRecaptcha(recaptchaConfig.siteKey, action);

      const payload = isRegister
        ? { username: name, password, name, recaptchaToken }
        : { username: name, password, recaptchaToken };

      const data = await postJson(isRegister ? '/api/auth/register' : '/api/auth/login', payload);
      onLoginSuccess(data.user, data.token);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      icon="🎲"
      title={isRegister ? 'Daftar akun PlayGo' : 'Masuk ke PlayGo'}
      subtitle={isRegister ? 'Satu akun PlayGo untuk semua game, Coins, item toko, dan peringkat.' : 'Masuk untuk memilih game, membuat room, dan mengumpulkan Coins.'}
    >
      <div className="tabs" role="tablist" aria-label="Pilih masuk atau daftar">
        <button type="button" role="tab" aria-selected={!isRegister} className="tabs__tab" onClick={() => switchTab('login')}>Masuk</button>
        <button type="button" role="tab" aria-selected={isRegister} className="tabs__tab" onClick={() => switchTab('register')}>Daftar</button>
      </div>

      {/* Bagian Login / Daftar dengan Google */}
      <div className="google-auth-box">
        {googleConfig.clientId && (
          <div ref={googleBtnRef} className="google-gis-container" aria-label="Sign in with Google" />
        )}

        {/* Tombol kustom Google bila tombol GIS bawaan belum dirender atau Client ID belum diisi */}
        {(!googleConfig.clientId || !window.google?.accounts?.id) && (
          <button
            type="button"
            className="btn btn--google btn--lg btn--block"
            onClick={handleCustomGoogleClick}
            disabled={loading}
          >
            <GoogleIcon size={22} />
            <span>{isRegister ? 'Daftar dengan Google' : 'Masuk dengan Google'}</span>
          </button>
        )}

        {googleHelpOpen && (
          <div className="google-help-card" role="region" aria-label="Panduan Konfigurasi Google Client ID">
            <strong>ℹ️ Konfigurasi Google Client ID</strong>
            <p className="muted">
              Untuk mengaktifkan autentikasi akun Google resmi di PlayGo, buat <em>OAuth 2.0 Client ID</em> di <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud Console</a> dan tambahkan di file <code>.env</code>:
            </p>
            <code>GOOGLE_CLIENT_ID=xxxxxxxxxxxx.apps.googleusercontent.com</code>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={handleSimulatedGoogleLogin}
              disabled={loading}
              style={{ marginTop: 'var(--space-2)' }}
            >
              🚀 Coba Login Google Simulasi (Demo)
            </button>
          </div>
        )}
      </div>

      <div className="auth-divider">
        <span>atau dengan username &amp; password</span>
      </div>

      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor={ids.user}>Username</label>
          <input
            id={ids.user}
            className="input"
            value={username}
            onChange={e => setUsername(isRegister ? e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '') : e.target.value)}
            maxLength={20}
            autoComplete="username"
            autoCapitalize="none"
            aria-describedby={isRegister ? ids.hint : undefined}
            disabled={loading}
            required
          />
          {isRegister && <p id={ids.hint} className="field__hint">Huruf kecil, angka, dan garis bawah (_), 3-20 karakter.</p>}
        </div>

        <PasswordField
          id={ids.pass}
          label="Password"
          value={password}
          onChange={setPassword}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          describedBy={isRegister ? ids.rules : undefined}
          disabled={loading}
        />

        {isRegister && (
          <>
            <ul id={ids.rules} className="checklist" aria-label="Syarat password">
              {rules.map(r => (
                <li key={r.key} className={r.ok ? 'is-ok' : ''}>
                  <span aria-hidden="true">{r.ok ? '✓' : '○'}</span> {r.label}
                  <span className="sr-only">{r.ok ? ', terpenuhi' : ', belum terpenuhi'}</span>
                </li>
              ))}
            </ul>
            <PasswordField
              id={ids.confirm}
              label="Ketik ulang password"
              value={confirmPassword}
              onChange={setConfirmPassword}
              autoComplete="new-password"
              disabled={loading}
            />
            {confirmPassword && (
              <p className={`field__hint ${matches ? 'is-ok' : 'is-error'}`} role="status">
                {matches ? 'Password sudah sama.' : 'Password belum sama.'}
              </p>
            )}
          </>
        )}

        {error && <p className="alert alert--error" role="alert">{error}</p>}

        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={loading}>
          {loading ? (isRegister ? 'Mendaftarkan...' : 'Memeriksa...') : isRegister ? 'Buat akun' : 'Masuk'}
        </button>

        {recaptchaConfig.enabled && (
          <p className="auth__recaptcha-notice">
            Dilindungi oleh reCAPTCHA v3 &amp; berlaku{' '}
            <a href="https://policies.google.com/privacy" target="_blank" rel="noreferrer">
              Privasi
            </a>{' '}
            serta{' '}
            <a href="https://policies.google.com/terms" target="_blank" rel="noreferrer">
              Ketentuan
            </a>{' '}
            Google.
          </p>
        )}
      </form>
    </Modal>
  );
}

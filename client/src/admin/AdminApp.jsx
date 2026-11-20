import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from './api';
import AdminLogin from './AdminLogin';
import AdminIcon from './components/AdminIcons';
import Badge from './components/Badge';
import { ADMIN_MODULES, resolveModuleFromPath } from './modules/registry';
import OverviewModule from './modules/OverviewModule';
import UsersModule from './modules/UsersModule';
import RoomsModule from './modules/RoomsModule';
import FinanceModule from './modules/FinanceModule';
import playgoLogo from '../assets/playgo-logo-sm.webp';

function getSavedTheme() {
  try {
    const val = localStorage.getItem('playgo_admin_theme');
    return val === 'light' || val === 'dark' ? val : 'dark';
  } catch {
    return 'dark';
  }
}

export default function AdminApp() {
  const [theme, setTheme] = useState(getSavedTheme);
  const [authChecking, setAuthChecking] = useState(() => Boolean(adminApi.getToken()));
  const [currentUser, setCurrentUser] = useState(null);
  const [nonAdminUser, setNonAdminUser] = useState(null);

  const [activeModule, setActiveModule] = useState(() =>
    typeof window !== 'undefined' ? resolveModuleFromPath(window.location.pathname) : 'overview'
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toasts, setToasts] = useState([]);

  useEffect(() => {
    document.documentElement.dataset.adminTheme = theme;
    try {
      localStorage.setItem('playgo_admin_theme', theme);
    } catch {}
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => (t === 'dark' ? 'light' : 'dark'));
  }, []);

  const pushToast = useCallback((type, message) => {
    if (!message) return;
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setToasts(prev => [...prev.slice(-3), { id, type, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 4200);
  }, []);

  // Verifikasi sesi saat pertama kali dimuat
  useEffect(() => {
    const token = adminApi.getToken();
    if (!token) {
      setAuthChecking(false);
      return;
    }
    let active = true;
    adminApi
      .get('/api/auth/me')
      .then(data => {
        if (!active) return;
        if (data?.user && (data.user.isAdmin || data.user.role === 'admin')) {
          setCurrentUser(data.user);
          setNonAdminUser(null);
        } else if (data?.user) {
          setNonAdminUser(data.user);
          setCurrentUser(null);
        } else {
          adminApi.clearToken();
        }
      })
      .catch(err => {
        if (!active) return;
        if (err.status === 401) {
          adminApi.clearToken();
          setCurrentUser(null);
          setNonAdminUser(null);
        }
      })
      .finally(() => {
        if (active) setAuthChecking(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Sinkronkan History API (/admin, /admin/users, /admin/rooms, /admin/finance)
  useEffect(() => {
    const onPopState = () => {
      setActiveModule(resolveModuleFromPath(window.location.pathname));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigateModule = useCallback(moduleId => {
    const mod = ADMIN_MODULES.find(m => m.id === moduleId && m.ready);
    if (!mod) return;
    setActiveModule(mod.id);
    setSidebarOpen(false);
    if (window.location.pathname !== mod.path) {
      window.history.pushState({ moduleId: mod.id }, '', mod.path);
    }
  }, []);

  const handleLogout = useCallback(() => {
    const token = adminApi.getToken();
    if (token) {
      fetch('/api/auth/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      }).catch(() => {});
    }
    adminApi.clearToken();
    setCurrentUser(null);
    setNonAdminUser(null);
  }, []);

  if (authChecking) {
    return (
      <main className="adm-login-wrap">
        <div className="adm-loading-box" role="status">
          <span className="adm-spinner" /> Memverifikasi sesi Admin CMS...
        </div>
      </main>
    );
  }

  if (!currentUser) {
    return (
      <AdminLogin
        nonAdminUser={nonAdminUser}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSwitchAccount={handleLogout}
        onLoginSuccess={user => {
          setCurrentUser(user);
          setNonAdminUser(null);
          pushToast('success', `Selamat datang kembali, @${user.username}!`);
        }}
      />
    );
  }

  const currentModMeta = ADMIN_MODULES.find(m => m.id === activeModule) || ADMIN_MODULES[0];
  const groups = ['Operasional Inti', 'Modul Berikutnya'];

  return (
    <div className="adm-shell">
      {sidebarOpen && <div className="adm-sidebar-backdrop" onClick={() => setSidebarOpen(false)} aria-hidden="true" />}

      <aside className={`adm-sidebar ${sidebarOpen ? 'is-open' : ''}`} aria-label="Navigasi Admin CMS">
        <div className="adm-sidebar__brand">
          <img src={playgoLogo} alt="PlayGo" width="36" height="36" className="adm-sidebar__logo" />
          <div>
            <div className="adm-sidebar__title">
              Play<span>Go</span> CMS
            </div>
            <div className="adm-sidebar__ver">Admin Console v1</div>
          </div>
          <button
            type="button"
            className="adm-icon-btn adm-sidebar__close"
            aria-label="Tutup menu"
            onClick={() => setSidebarOpen(false)}
          >
            <AdminIcon name="x" size={18} />
          </button>
        </div>

        <nav className="adm-nav">
          {groups.map(groupName => (
            <div key={groupName} className="adm-nav__group">
              <div className="adm-nav__group-label">{groupName}</div>
              {ADMIN_MODULES.filter(m => m.group === groupName).map(mod => {
                const isActive = mod.id === activeModule;
                return (
                  <button
                    key={mod.id}
                    type="button"
                    disabled={!mod.ready}
                    className={`adm-nav__item ${isActive ? 'is-active' : ''} ${!mod.ready ? 'is-soon' : ''}`}
                    onClick={() => mod.ready && navigateModule(mod.id)}
                  >
                    <AdminIcon name={mod.icon} size={18} />
                    <span className="adm-nav__label">{mod.label}</span>
                    {!mod.ready && <Badge tone="neutral">Segera</Badge>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="adm-sidebar__footer">
          <a href="/" className="adm-nav__link">
            <AdminIcon name="external" size={16} />
            <span>Buka Platform PlayGo</span>
          </a>

          <div className="adm-sidebar__user">
            <div className="adm-avatar-mini">{(currentUser.name || currentUser.username || 'A').slice(0, 1).toUpperCase()}</div>
            <div className="adm-sidebar__user-meta">
              <strong>{currentUser.name}</strong>
              <span>@{currentUser.username} · ADMIN</span>
            </div>
            <button type="button" className="adm-icon-btn" title="Keluar" aria-label="Keluar akun" onClick={handleLogout}>
              <AdminIcon name="logout" size={17} />
            </button>
          </div>
        </div>
      </aside>

      <div className="adm-main">
        <header className="adm-topbar">
          <div className="adm-topbar__left">
            <button
              type="button"
              className="adm-icon-btn adm-topbar__menu"
              aria-label="Buka navigasi"
              onClick={() => setSidebarOpen(true)}
            >
              <AdminIcon name="menu" size={20} />
            </button>
            <div>
              <h1 className="adm-topbar__title">{currentModMeta.label}</h1>
              <p className="adm-topbar__sub">{currentModMeta.subtitle}</p>
            </div>
          </div>

          <div className="adm-topbar__right">
            <button
              type="button"
              className="adm-icon-btn"
              title={theme === 'dark' ? 'Tema Terang' : 'Tema Gelap'}
              aria-label="Ganti tema Admin CMS"
              onClick={toggleTheme}
            >
              <AdminIcon name={theme === 'dark' ? 'sun' : 'moon'} size={18} />
            </button>
          </div>
        </header>

        <main className="adm-content">
          {activeModule === 'overview' && <OverviewModule onNavigate={navigateModule} onToast={pushToast} />}
          {activeModule === 'users' && <UsersModule currentUser={currentUser} onToast={pushToast} />}
          {activeModule === 'rooms' && <RoomsModule onToast={pushToast} />}
          {activeModule === 'finance' && <FinanceModule onToast={pushToast} />}
        </main>
      </div>

      {/* Toast Notifications */}
      {toasts.length > 0 && (
        <div className="adm-toasts" aria-live="polite">
          {toasts.map(t => (
            <div key={t.id} className={`adm-toast adm-toast--${t.type}`}>
              <span>{t.message}</span>
              <button
                type="button"
                className="adm-icon-btn"
                aria-label="Tutup notifikasi"
                onClick={() => setToasts(prev => prev.filter(x => x.id !== t.id))}
              >
                <AdminIcon name="x" size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminApp from './AdminApp';
import './styles/admin.css';

class AdminErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[AdminCMS ErrorBoundary]', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="adm-crash">
        <div className="adm-crash-card">
          <h1>Terjadi Gangguan pada Admin CMS</h1>
          <p>{this.state.error.message || 'Kesalahan render yang tidak terduga.'}</p>
          <div className="adm-row-actions">
            <button
              type="button"
              className="adm-btn adm-btn--primary"
              onClick={() => {
                window.location.href = '/admin';
              }}
            >
              Muat Ulang CMS
            </button>
            <a href="/" className="adm-btn adm-btn--secondary">
              Kembali ke PlayGo
            </a>
          </div>
        </div>
      </main>
    );
  }
}

createRoot(document.getElementById('admin-root')).render(
  <AdminErrorBoundary>
    <AdminApp />
  </AdminErrorBoundary>
);

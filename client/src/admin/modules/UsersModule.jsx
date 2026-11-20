import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../api';
import AdminIcon from '../components/AdminIcons';
import AdminModal from '../components/AdminModal';
import ConfirmDialog from '../components/ConfirmDialog';
import KpiCard from '../components/KpiCard';
import Pagination from '../components/Pagination';
import Badge, { gameBadgeTone, statusBadgeTone } from '../components/Badge';
import { ADMIN_PASSWORD_RULES, formatDateTime, formatIdr, formatNumber } from '../utils/format';

const EMPTY_CREATE_FORM = {
  username: '',
  name: '',
  email: '',
  password: '',
  role: 'player',
  points: 200,
  diamonds: 0
};

export default function UsersModule({ currentUser, onToast }) {
  const [usersData, setUsersData] = useState({
    items: [],
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 1,
    summary: {}
  });
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('all');
  const [authFilter, setAuthFilter] = useState('all');
  const [sortBy, setSortBy] = useState('createdAt');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  // Create modal
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState(EMPTY_CREATE_FORM);
  const [createBusy, setCreateBusy] = useState(false);

  // Detail modal
  const [detailData, setDetailData] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Edit modal
  const [editTarget, setEditTarget] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [editCatalog, setEditCatalog] = useState([]);
  const [editBusy, setEditBusy] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteBusy, setDeleteBusy] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      setQ(searchInput.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    try {
      const res = await adminApi.get('/api/admin/users', {
        q,
        role: roleFilter,
        authType: authFilter,
        sortBy,
        sortDir,
        page,
        pageSize
      });
      setUsersData(res);
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [q, roleFilter, authFilter, sortBy, sortDir, page, pageSize, onToast]);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  const openDetail = async user => {
    setDetailLoading(true);
    setDetailData({ user });
    try {
      const res = await adminApi.get(`/api/admin/users/${encodeURIComponent(user.id)}`);
      setDetailData(res);
    } catch (err) {
      onToast?.('error', err.message);
      setDetailData(null);
    } finally {
      setDetailLoading(false);
    }
  };

  const openEdit = async user => {
    setEditBusy(true);
    setEditTarget(user);
    setEditForm({
      id: user.id,
      name: user.name || '',
      username: user.username || '',
      email: user.email || '',
      role: user.role || (user.isAdmin ? 'admin' : 'player'),
      newPassword: '',
      points: Number(user.points ?? 0),
      diamonds: Number(user.diamonds ?? 0),
      diamondReason: '',
      items: { ...(user.inventory || {}) }
    });
    try {
      const res = await adminApi.get(`/api/admin/users/${encodeURIComponent(user.id)}`);
      setEditCatalog(res.itemCatalog || []);
      setEditForm(f =>
        f
          ? {
              ...f,
              points: Number(res.user?.points ?? f.points),
              diamonds: Number(res.user?.diamonds ?? f.diamonds),
              items: { ...(res.inventory || {}) }
            }
          : f
      );
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setEditBusy(false);
    }
  };

  const handleCreateSubmit = async e => {
    e.preventDefault();
    setCreateBusy(true);
    try {
      const res = await adminApi.post('/api/admin/users', {
        username: createForm.username.trim(),
        name: createForm.name.trim(),
        email: createForm.email.trim() || null,
        password: createForm.password,
        role: createForm.role,
        points: Number(createForm.points || 0),
        diamonds: Number(createForm.diamonds || 0)
      });
      onToast?.('success', `User @${res.user.username} berhasil dibuat.`);
      setCreateOpen(false);
      setCreateForm(EMPTY_CREATE_FORM);
      loadUsers();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setCreateBusy(false);
    }
  };

  const handleEditSubmit = async e => {
    e.preventDefault();
    if (!editForm || !editTarget) return;
    setEditBusy(true);
    try {
      const payload = {
        name: editForm.name.trim(),
        username: editForm.username.trim(),
        email: editForm.email.trim(),
        role: editForm.role,
        points: Number(editForm.points),
        diamonds: Number(editForm.diamonds),
        diamondReason: editForm.diamondReason.trim(),
        items: editForm.items
      };
      if (editForm.newPassword) {
        payload.newPassword = editForm.newPassword;
      }
      const res = await adminApi.patch(`/api/admin/users/${encodeURIComponent(editTarget.id)}`, payload);
      onToast?.('success', `Data @${res.user.username} berhasil diperbarui.`);
      setEditTarget(null);
      setEditForm(null);
      loadUsers();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setEditBusy(false);
    }
  };

  const handleRevokeSessions = async userId => {
    setEditBusy(true);
    try {
      const res = await adminApi.post(`/api/admin/users/${encodeURIComponent(userId)}/revoke-sessions`, {});
      onToast?.('success', `${res.revokedCount} sesi login berhasil dicabut.`);
      loadUsers();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setEditBusy(false);
    }
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      await adminApi.del(`/api/admin/users/${encodeURIComponent(deleteTarget.id)}`);
      onToast?.('success', `Akun @${deleteTarget.username} telah dihapus.`);
      setDeleteTarget(null);
      loadUsers();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setDeleteBusy(false);
    }
  };

  const summary = usersData.summary || {};

  return (
    <div className="adm-stack-lg">
      {/* KPI Strip */}
      <section className="adm-kpi-grid" aria-label="Ringkasan Akun Pengguna">
        <KpiCard
          label="Total Akun"
          value={formatNumber(summary.totalUsers)}
          sublabel={`${formatNumber(summary.adminCount)} Admin · ${formatNumber(summary.playerCount)} Pemain`}
          icon="users"
          tone="info"
        />
        <KpiCard
          label="Login Google OAuth"
          value={formatNumber(summary.googleCount)}
          sublabel="Akun terhubung Google"
          icon="shield"
          tone="neutral"
        />
        <KpiCard
          label="Total Coins Beredar"
          value={formatNumber(summary.totalCoins)}
          sublabel="Akumulasi saldo Coins seluruh user"
          icon="wallet"
          tone="brand"
        />
        <KpiCard
          label="Total Diamonds Beredar"
          value={formatNumber(summary.totalDiamonds)}
          sublabel="Akumulasi saldo Diamonds seluruh user"
          icon="layers"
          tone="success"
        />
      </section>

      {/* Filter & Actions Bar */}
      <section className="adm-card">
        <div className="adm-toolbar adm-toolbar--between">
          <div className="adm-filters">
            <div className="adm-search-box">
              <AdminIcon name="search" size={16} />
              <input
                type="search"
                className="adm-input adm-input--search"
                placeholder="Cari username, nama, email, referral..."
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                aria-label="Cari pengguna"
              />
            </div>

            <select
              className="adm-select"
              aria-label="Filter role"
              value={roleFilter}
              onChange={e => {
                setRoleFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Semua Role</option>
              <option value="admin">Admin</option>
              <option value="player">Player</option>
            </select>

            <select
              className="adm-select"
              aria-label="Filter autentikasi"
              value={authFilter}
              onChange={e => {
                setAuthFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="all">Semua Auth</option>
              <option value="password">Password</option>
              <option value="google">Google OAuth</option>
            </select>

            <select
              className="adm-select"
              aria-label="Urutkan berdasarkan"
              value={`${sortBy}:${sortDir}`}
              onChange={e => {
                const [by, dir] = e.target.value.split(':');
                setSortBy(by);
                setSortDir(dir);
                setPage(1);
              }}
            >
              <option value="createdAt:desc">Terbaru Daftar</option>
              <option value="createdAt:asc">Terlama Daftar</option>
              <option value="points:desc">Coins Tertinggi</option>
              <option value="diamonds:desc">Diamonds Tertinggi</option>
              <option value="wins:desc">Menang Terbanyak</option>
              <option value="username:asc">Username (A-Z)</option>
            </select>
          </div>

          <div className="adm-row-actions">
            <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={loadUsers} disabled={loading}>
              <AdminIcon name="refresh" size={15} />
              <span>Refresh</span>
            </button>
            <button
              type="button"
              className="adm-btn adm-btn--primary adm-btn--sm"
              onClick={() => {
                setCreateForm(EMPTY_CREATE_FORM);
                setCreateOpen(true);
              }}
            >
              <AdminIcon name="plus" size={15} />
              <span>Tambah User</span>
            </button>
          </div>
        </div>

        {/* Table */}
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Pengguna</th>
                <th>Email &amp; Auth</th>
                <th>Role</th>
                <th>Saldo Coins</th>
                <th>Diamonds</th>
                <th>Referral</th>
                <th>Terdaftar</th>
                <th className="adm-th-actions">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {loading && usersData.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="adm-table__empty">
                    Memuat data pengguna...
                  </td>
                </tr>
              ) : usersData.items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="adm-table__empty">
                    Tidak ada pengguna yang cocok dengan filter.
                  </td>
                </tr>
              ) : (
                usersData.items.map(u => {
                  const isSelf = u.id === currentUser?.id;
                  return (
                    <tr key={u.id}>
                      <td>
                        <div className="adm-user-cell">
                          <div className="adm-avatar-mini">{(u.name || u.username || 'P').slice(0, 1).toUpperCase()}</div>
                          <div>
                            <div className="adm-user-cell__name">
                              {u.name} {isSelf && <Badge tone="info">Anda</Badge>}
                            </div>
                            <div className="adm-muted">@{u.username}</div>
                          </div>
                        </div>
                      </td>
                      <td>
                        <div>{u.email || <span className="adm-muted">-</span>}</div>
                        <div className="adm-muted">
                          {u.authType === 'google' || u.googleLinked ? 'Google' : 'Password'}
                          {u.activeSessionsCount > 0 && ` · ${u.activeSessionsCount} sesi`}
                        </div>
                      </td>
                      <td>
                        <Badge tone={u.isAdmin ? 'brand' : 'neutral'}>{u.isAdmin ? 'ADMIN' : 'PLAYER'}</Badge>
                      </td>
                      <td className="adm-num">
                        <strong>{formatNumber(u.points)}</strong>
                      </td>
                      <td className="adm-num">
                        <strong className="adm-text-cyan">{formatNumber(u.diamonds)}</strong>
                      </td>
                      <td>
                        <code className="adm-code">{u.referralCode || '-'}</code>
                        <div className="adm-muted">{u.referralCount || 0} undangan</div>
                      </td>
                      <td className="adm-muted">{formatDateTime(u.createdAt)}</td>
                      <td>
                        <div className="adm-row-actions adm-row-actions--end">
                          <button
                            type="button"
                            className="adm-btn adm-btn--ghost adm-btn--xs"
                            title="Detail pengguna"
                            onClick={() => openDetail(u)}
                          >
                            <AdminIcon name="eye" size={14} />
                            <span>Detail</span>
                          </button>
                          <button
                            type="button"
                            className="adm-btn adm-btn--secondary adm-btn--xs"
                            title="Edit pengguna"
                            onClick={() => openEdit(u)}
                          >
                            <AdminIcon name="edit" size={14} />
                            <span>Edit</span>
                          </button>
                          <button
                            type="button"
                            className="adm-btn adm-btn--danger-ghost adm-btn--xs"
                            title={isSelf ? 'Tidak dapat menghapus akun sendiri' : 'Hapus pengguna'}
                            disabled={isSelf}
                            onClick={() => setDeleteTarget(u)}
                          >
                            <AdminIcon name="trash" size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <Pagination
          page={usersData.page}
          totalPages={usersData.totalPages}
          total={usersData.total}
          pageSize={pageSize}
          onPageChange={p => setPage(p)}
          onPageSizeChange={sz => {
            setPageSize(sz);
            setPage(1);
          }}
        />
      </section>

      {/* Modal Tambah User */}
      <AdminModal
        isOpen={createOpen}
        onClose={() => !createBusy && setCreateOpen(false)}
        title="Tambah Pengguna Baru"
        subtitle="Buat akun pemain atau admin langsung dari CMS"
        size="md"
      >
        <form onSubmit={handleCreateSubmit} className="adm-form">
          <div className="adm-form-grid">
            <div className="adm-field">
              <label className="adm-label">Username *</label>
              <input
                type="text"
                className="adm-input"
                placeholder="huruf/angka/underscore (3-20)"
                value={createForm.username}
                onChange={e => setCreateForm(f => ({ ...f, username: e.target.value }))}
                required
              />
            </div>
            <div className="adm-field">
              <label className="adm-label">Nama Tampilan</label>
              <input
                type="text"
                className="adm-input"
                placeholder="Opsional (default username)"
                value={createForm.name}
                onChange={e => setCreateForm(f => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="adm-field">
              <label className="adm-label">Email</label>
              <input
                type="email"
                className="adm-input"
                placeholder="opsional@email.com"
                value={createForm.email}
                onChange={e => setCreateForm(f => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="adm-field">
              <label className="adm-label">Role Akun</label>
              <select
                className="adm-select"
                value={createForm.role}
                onChange={e => setCreateForm(f => ({ ...f, role: e.target.value }))}
              >
                <option value="player">Player (Pemain)</option>
                <option value="admin">Admin CMS</option>
              </select>
            </div>
            <div className="adm-field">
              <label className="adm-label">Coins Awal</label>
              <input
                type="number"
                className="adm-input"
                min={0}
                value={createForm.points}
                onChange={e => setCreateForm(f => ({ ...f, points: e.target.value }))}
              />
            </div>
            <div className="adm-field">
              <label className="adm-label">Diamonds Awal</label>
              <input
                type="number"
                className="adm-input"
                min={0}
                value={createForm.diamonds}
                onChange={e => setCreateForm(f => ({ ...f, diamonds: e.target.value }))}
              />
            </div>
          </div>

          <div className="adm-field">
            <label className="adm-label">Password *</label>
            <input
              type="text"
              className="adm-input"
              placeholder="Contoh: PlayGo123!"
              value={createForm.password}
              onChange={e => setCreateForm(f => ({ ...f, password: e.target.value }))}
              required
            />
            <div className="adm-rules-row">
              {ADMIN_PASSWORD_RULES.map(r => {
                const ok = r.test(createForm.password);
                return (
                  <span key={r.key} className={`adm-rule-chip ${ok ? 'is-ok' : ''}`}>
                    {ok ? '✓' : '•'} {r.label}
                  </span>
                );
              })}
            </div>
          </div>

          <div className="adm-row-actions adm-row-actions--end">
            <button type="button" className="adm-btn adm-btn--secondary" onClick={() => setCreateOpen(false)} disabled={createBusy}>
              Batal
            </button>
            <button type="submit" className="adm-btn adm-btn--primary" disabled={createBusy}>
              {createBusy ? 'Menyimpan...' : 'Buat Pengguna'}
            </button>
          </div>
        </form>
      </AdminModal>

      {/* Modal Detail User */}
      <AdminModal
        isOpen={Boolean(detailData)}
        onClose={() => setDetailData(null)}
        title={`Detail Pengguna: ${detailData?.user?.name || ''}`}
        subtitle={`@${detailData?.user?.username || ''} · ID: ${detailData?.user?.id || ''}`}
        size="lg"
      >
        {detailLoading ? (
          <div className="adm-loading-box">Memuat profil lengkap...</div>
        ) : (
          detailData?.user && (
            <div className="adm-stack">
              <div className="adm-detail-grid">
                <div className="adm-detail-box">
                  <span className="adm-muted">Role &amp; Auth</span>
                  <div>
                    <Badge tone={detailData.user.isAdmin ? 'brand' : 'neutral'}>{detailData.user.role}</Badge>{' '}
                    <Badge tone="neutral">{detailData.user.authType}</Badge>
                  </div>
                </div>
                <div className="adm-detail-box">
                  <span className="adm-muted">Saldo</span>
                  <div>
                    <strong>{formatNumber(detailData.user.points)} Coins</strong> ·{' '}
                    <strong className="adm-text-cyan">{formatNumber(detailData.user.diamonds)} Diamonds</strong>
                  </div>
                </div>
                <div className="adm-detail-box">
                  <span className="adm-muted">Statistik &amp; Referral</span>
                  <div>
                    {detailData.user.wins || 0} Menang / {detailData.user.matchesPlayed || 0} Match · Kode{' '}
                    <code className="adm-code">{detailData.user.referralCode}</code>
                  </div>
                </div>
                <div className="adm-detail-box">
                  <span className="adm-muted">Status Room Aktif</span>
                  <div>
                    {detailData.activeRoom ? (
                      <span>
                        <Badge tone={gameBadgeTone(detailData.activeRoom.game)}>{detailData.activeRoom.gameLabel}</Badge>{' '}
                        <code>#{detailData.activeRoom.code}</code> ({detailData.activeRoom.status})
                      </span>
                    ) : (
                      <span className="adm-muted">Tidak berada di room mana pun</span>
                    )}
                  </div>
                </div>
              </div>

              <div className="adm-section-block">
                <h4>Inventaris Item Strategi</h4>
                <div className="adm-chips-wrap">
                  {(detailData.itemCatalog || []).map(it => (
                    <span key={it.id} className="adm-pill-info">
                      {it.name}: <strong>{detailData.inventory?.[it.id] || 0}</strong>
                    </span>
                  ))}
                </div>
              </div>

              <div className="adm-section-block">
                <h4>Order Top-Up Terbaru</h4>
                {(detailData.recentOrders || []).length === 0 ? (
                  <p className="adm-muted">Belum ada order top-up.</p>
                ) : (
                  <div className="adm-table-wrap">
                    <table className="adm-table adm-table--compact">
                      <thead>
                        <tr>
                          <th>Order ID</th>
                          <th>Paket</th>
                          <th>Nominal</th>
                          <th>Status</th>
                          <th>Waktu</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailData.recentOrders.map(o => (
                          <tr key={`${o.kind}-${o.orderId}`}>
                            <td className="adm-mono">{o.orderId}</td>
                            <td>{o.rewardLabel}</td>
                            <td className="adm-num">{formatIdr(o.amountIdr)}</td>
                            <td>
                              <Badge tone={statusBadgeTone(o.status)}>{o.status}</Badge>
                            </td>
                            <td className="adm-muted">{formatDateTime(o.createdAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )
        )}
      </AdminModal>

      {/* Modal Edit User */}
      <AdminModal
        isOpen={Boolean(editTarget && editForm)}
        onClose={() => !editBusy && setEditTarget(null)}
        title={`Edit Pengguna: @${editTarget?.username || ''}`}
        subtitle={`ID: ${editTarget?.id || ''}`}
        size="lg"
      >
        {editForm && (
          <form onSubmit={handleEditSubmit} className="adm-form">
            <div className="adm-form-grid">
              <div className="adm-field">
                <label className="adm-label">Username *</label>
                <input
                  type="text"
                  className="adm-input"
                  value={editForm.username}
                  onChange={e => setEditForm(f => ({ ...f, username: e.target.value }))}
                  required
                />
              </div>
              <div className="adm-field">
                <label className="adm-label">Nama Tampilan *</label>
                <input
                  type="text"
                  className="adm-input"
                  value={editForm.name}
                  onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))}
                  required
                />
              </div>
              <div className="adm-field">
                <label className="adm-label">Email</label>
                <input
                  type="email"
                  className="adm-input"
                  placeholder="Kosongkan untuk menghapus email"
                  value={editForm.email}
                  onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))}
                />
              </div>
              <div className="adm-field">
                <label className="adm-label">Role Akun</label>
                <select
                  className="adm-select"
                  value={editForm.role}
                  disabled={editTarget?.id === currentUser?.id}
                  onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))}
                >
                  <option value="player">Player (Pemain)</option>
                  <option value="admin">Admin CMS</option>
                </select>
                {editTarget?.id === currentUser?.id && (
                  <span className="adm-muted">Tidak dapat menurunkan role akun Anda sendiri.</span>
                )}
              </div>
              <div className="adm-field">
                <label className="adm-label">Saldo Coins</label>
                <input
                  type="number"
                  className="adm-input"
                  min={0}
                  value={editForm.points}
                  onChange={e => setEditForm(f => ({ ...f, points: e.target.value }))}
                />
              </div>
              <div className="adm-field">
                <label className="adm-label">Saldo Diamonds</label>
                <input
                  type="number"
                  className="adm-input"
                  min={0}
                  value={editForm.diamonds}
                  onChange={e => setEditForm(f => ({ ...f, diamonds: e.target.value }))}
                />
              </div>
            </div>

            <div className="adm-form-grid">
              <div className="adm-field">
                <label className="adm-label">Reset Password Baru (Opsional)</label>
                <input
                  type="text"
                  className="adm-input"
                  placeholder="Kosongkan jika tidak ingin mengubah password"
                  value={editForm.newPassword}
                  onChange={e => setEditForm(f => ({ ...f, newPassword: e.target.value }))}
                />
                {editForm.newPassword && (
                  <div className="adm-rules-row">
                    {ADMIN_PASSWORD_RULES.map(r => {
                      const ok = r.test(editForm.newPassword);
                      return (
                        <span key={r.key} className={`adm-rule-chip ${ok ? 'is-ok' : ''}`}>
                          {ok ? '✓' : '•'} {r.label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
              <div className="adm-field">
                <label className="adm-label">Alasan Perubahan Diamonds (Audit)</label>
                <input
                  type="text"
                  className="adm-input"
                  placeholder="Misal: Koreksi manual / kompensasi kendala"
                  value={editForm.diamondReason}
                  onChange={e => setEditForm(f => ({ ...f, diamondReason: e.target.value }))}
                />
              </div>
            </div>

            {editCatalog.length > 0 && (
              <div className="adm-section-block">
                <h4>Stok Item Strategi</h4>
                <div className="adm-items-grid">
                  {editCatalog.map(it => (
                    <div key={it.id} className="adm-field">
                      <label className="adm-label">{it.name}</label>
                      <input
                        type="number"
                        className="adm-input"
                        min={0}
                        max={100000}
                        value={editForm.items?.[it.id] ?? 0}
                        onChange={e =>
                          setEditForm(f => ({
                            ...f,
                            items: { ...(f.items || {}), [it.id]: Number(e.target.value || 0) }
                          }))
                        }
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="adm-toolbar adm-toolbar--between">
              <button
                type="button"
                className="adm-btn adm-btn--warning adm-btn--sm"
                disabled={editBusy}
                onClick={() => handleRevokeSessions(editTarget.id)}
              >
                <AdminIcon name="key" size={14} />
                <span>Cabut Semua Sesi Login</span>
              </button>
              <div className="adm-row-actions">
                <button
                  type="button"
                  className="adm-btn adm-btn--secondary"
                  disabled={editBusy}
                  onClick={() => setEditTarget(null)}
                >
                  Batal
                </button>
                <button type="submit" className="adm-btn adm-btn--primary" disabled={editBusy}>
                  {editBusy ? 'Menyimpan...' : 'Simpan Perubahan'}
                </button>
              </div>
            </div>
          </form>
        )}
      </AdminModal>

      {/* Dialog Konfirmasi Hapus User */}
      <ConfirmDialog
        isOpen={Boolean(deleteTarget)}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteConfirm}
        title="Hapus Pengguna Permanen"
        message={`Apakah Anda yakin ingin menghapus akun @${deleteTarget?.username} (${deleteTarget?.name})? Seluruh sesi login, saldo, dan riwayat akun di database akan terhapus permanen.`}
        confirmLabel="Hapus Permanen"
        variant="danger"
        busy={deleteBusy}
      />
    </div>
  );
}

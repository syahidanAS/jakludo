import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../api';
import AdminIcon from '../components/AdminIcons';
import AdminModal from '../components/AdminModal';
import ConfirmDialog from '../components/ConfirmDialog';
import LiveRoomSpectatorModal from '../components/LiveRoomSpectatorModal';
import KpiCard from '../components/KpiCard';
import Badge, { gameBadgeTone, statusBadgeTone } from '../components/Badge';
import { formatDateTime, formatDuration, formatNumber, formatRelativeTime } from '../utils/format';

export default function RoomsModule({ onToast }) {
  const [data, setData] = useState({ rooms: [], summary: {} });
  const [loading, setLoading] = useState(true);
  const [gameFilter, setGameFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [q, setQ] = useState('');
  const [pollMs, setPollMs] = useState(5000);

  const [inspectRoom, setInspectRoom] = useState(null);
  const [inspectLoading, setInspectLoading] = useState(false);
  const [watchRoom, setWatchRoom] = useState(null);

  const [closeTarget, setCloseTarget] = useState(null);
  const [closeBusy, setCloseBusy] = useState(false);

  const loadRooms = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true);
    try {
      const res = await adminApi.get('/api/admin/rooms', {
        game: gameFilter,
        status: statusFilter,
        q: q.trim()
      });
      setData(res);
    } catch (err) {
      if (!silent) onToast?.('error', err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [gameFilter, statusFilter, q, onToast]);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  useEffect(() => {
    if (!pollMs) return undefined;
    const timer = setInterval(() => loadRooms({ silent: true }), pollMs);
    return () => clearInterval(timer);
  }, [pollMs, loadRooms]);

  const handleInspect = async room => {
    setInspectRoom(room);
    setInspectLoading(true);
    try {
      const res = await adminApi.get(`/api/admin/rooms/${encodeURIComponent(room.game)}/${encodeURIComponent(room.code)}`);
      setInspectRoom(res.room);
    } catch (err) {
      onToast?.('error', err.message);
      setInspectRoom(null);
    } finally {
      setInspectLoading(false);
    }
  };

  const handleForceClose = async reason => {
    if (!closeTarget) return;
    setCloseBusy(true);
    try {
      const res = await adminApi.post(
        `/api/admin/rooms/${encodeURIComponent(closeTarget.game)}/${encodeURIComponent(closeTarget.code)}/close`,
        { reason }
      );
      onToast?.('success', res.message);
      setCloseTarget(null);
      if (inspectRoom && inspectRoom.code === closeTarget.code && inspectRoom.game === closeTarget.game) {
        setInspectRoom(null);
      }
      loadRooms();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setCloseBusy(false);
    }
  };

  const summary = data.summary || {};
  const queues = summary.matchmakingQueues || {};

  return (
    <div className="adm-stack-lg">
      {/* KPI */}
      <section className="adm-kpi-grid" aria-label="Ringkasan Room Aktif">
        <KpiCard
          label="Total Room Aktif"
          value={formatNumber(summary.totalRooms)}
          sublabel={`Ludo ${summary.byGame?.ludo || 0} · Quiz ${summary.byGame?.quiz || 0} · Chess ${summary.byGame?.chess || 0} · Snakes ${summary.byGame?.snakes || 0}`}
          icon="radio"
          tone="brand"
        />
        <KpiCard
          label="Pemain Manusia Online"
          value={`${formatNumber(summary.totalConnectedHumans)} / ${formatNumber(summary.totalHumans)}`}
          sublabel={`${formatNumber(summary.totalBots)} AI Bot aktif di meja`}
          icon="users"
          tone="success"
        />
        <KpiCard
          label="Antrean Matchmaking"
          value={formatNumber((queues.quiz || 0) + (queues.chess || 0) + (queues.snakes || 0))}
          sublabel={`Quiz: ${queues.quiz || 0} · Chess: ${queues.chess || 0} · Snakes: ${queues.snakes || 0}`}
          icon="layers"
          tone="info"
        />
        <KpiCard
          label="Status Server Engine"
          value={formatDuration(summary.serverUptimeSec)}
          sublabel={`RAM RSS: ${summary.memoryRssMb || 0} MB`}
          icon="shield"
          tone="neutral"
        />
      </section>

      <section className="adm-card">
        <div className="adm-toolbar adm-toolbar--between">
          <div className="adm-filters">
            <div className="adm-pills">
              {[
                { id: 'all', label: 'Semua Game' },
                { id: 'ludo', label: 'JakLudo' },
                { id: 'quiz', label: 'Monster Quiz' },
                { id: 'chess', label: 'Chess Master' },
                { id: 'snakes', label: 'Ular Tangga' }
              ].map(tab => (
                <button
                  key={tab.id}
                  type="button"
                  className={`adm-btn adm-btn--sm ${gameFilter === tab.id ? 'adm-btn--primary' : 'adm-btn--secondary'}`}
                  onClick={() => setGameFilter(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <select
              className="adm-select"
              aria-label="Filter status room"
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
            >
              <option value="all">Semua Status</option>
              <option value="lobby">Lobby / Menunggu</option>
              <option value="playing">Sedang Main</option>
              <option value="finished">Selesai</option>
            </select>

            <div className="adm-search-box">
              <AdminIcon name="search" size={16} />
              <input
                type="search"
                className="adm-input adm-input--search"
                placeholder="Cari kode room atau pemain..."
                value={q}
                onChange={e => setQ(e.target.value)}
              />
            </div>
          </div>

          <div className="adm-row-actions">
            <span className="adm-pill-info" title="Interval auto-refresh">
              {pollMs > 0 && <span className="adm-dot adm-dot--online" />}
              <select
                className="adm-select adm-select--inline"
                aria-label="Auto refresh"
                value={pollMs}
                onChange={e => setPollMs(Number(e.target.value))}
              >
                <option value={0}>Auto: Off</option>
                <option value={5000}>Live 5d</option>
                <option value={10000}>Live 10d</option>
                <option value={30000}>Live 30d</option>
              </select>
            </span>

            <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={() => loadRooms()} disabled={loading}>
              <AdminIcon name="refresh" size={15} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Rooms Table */}
        <div className="adm-table-wrap">
          <table className="adm-table">
            <thead>
              <tr>
                <th>Game</th>
                <th>Kode Room</th>
                <th>Status &amp; Tipe</th>
                <th>Daftar Pemain</th>
                <th>Progres Pertandingan</th>
                <th>Terakhir Update</th>
                <th className="adm-th-actions">Aksi</th>
              </tr>
            </thead>
            <tbody>
              {loading && (data.rooms || []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="adm-table__empty">
                    Memuat room aktif...
                  </td>
                </tr>
              ) : (data.rooms || []).length === 0 ? (
                <tr>
                  <td colSpan={7} className="adm-table__empty">
                    Saat ini tidak ada room aktif yang cocok dengan filter.
                  </td>
                </tr>
              ) : (
                (data.rooms || []).map(r => (
                  <tr key={`${r.game}-${r.code}`}>
                    <td>
                      <Badge tone={gameBadgeTone(r.game)}>{r.gameLabel}</Badge>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="adm-code-btn"
                        title="Klik untuk menyalin kode room"
                        onClick={() => {
                          navigator.clipboard?.writeText(r.code);
                          onToast?.('success', `Kode room ${r.code} disalin.`);
                        }}
                      >
                        #{r.code}
                      </button>
                    </td>
                    <td>
                      <Badge tone={statusBadgeTone(r.status)}>{r.status.toUpperCase()}</Badge>
                      <div className="adm-muted">{r.roomType}</div>
                    </td>
                    <td>
                      <div className="adm-players-chips">
                        {(r.players || []).map((p, idx) => (
                          <span
                            key={`${p.id || idx}`}
                            className={`adm-player-chip ${p.isBot ? 'is-bot' : p.connected ? 'is-online' : 'is-offline'}`}
                          >
                            <span className="adm-dot" />
                            <span>{p.name}</span>
                            {p.isBot && <small>BOT</small>}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>{r.progressLabel}</td>
                    <td className="adm-muted" title={formatDateTime(r.updatedAt || r.createdAt)}>
                      {formatRelativeTime(r.updatedAt || r.createdAt)}
                    </td>
                    <td>
                      <div className="adm-row-actions adm-row-actions--end">
                        <button
                          type="button"
                          className="adm-btn adm-btn--primary adm-btn--xs"
                          title="Masuk & pantau permainan realtime secara senyap"
                          onClick={() => setWatchRoom(r)}
                        >
                          <AdminIcon name="radio" size={14} />
                          <span>Pantau Live</span>
                        </button>
                        <button
                          type="button"
                          className="adm-btn adm-btn--secondary adm-btn--xs"
                          onClick={() => handleInspect(r)}
                        >
                          <AdminIcon name="eye" size={14} />
                          <span>Inspect</span>
                        </button>
                        <button
                          type="button"
                          className="adm-btn adm-btn--danger-ghost adm-btn--xs"
                          onClick={() => setCloseTarget(r)}
                        >
                          <AdminIcon name="stop" size={14} />
                          <span>Tutup</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Modal Inspect Room */}
      <AdminModal
        isOpen={Boolean(inspectRoom)}
        onClose={() => setInspectRoom(null)}
        title={`Inspeksi Room ${inspectRoom?.gameLabel || ''} #${inspectRoom?.code || ''}`}
        subtitle={`Room ID: ${inspectRoom?.roomId || '-'} · Status: ${inspectRoom?.status || '-'}`}
        size="lg"
      >
        {inspectLoading ? (
          <div className="adm-loading-box">Memuat detail room...</div>
        ) : (
          inspectRoom && (
            <div className="adm-stack">
              <div className="adm-detail-grid">
                <div className="adm-detail-box">
                  <span className="adm-muted">Game &amp; Tipe</span>
                  <div>
                    <Badge tone={gameBadgeTone(inspectRoom.game)}>{inspectRoom.gameLabel}</Badge>{' '}
                    <strong>{inspectRoom.roomType}</strong>
                  </div>
                </div>
                <div className="adm-detail-box">
                  <span className="adm-muted">Progres</span>
                  <div>{inspectRoom.progressLabel}</div>
                </div>
              </div>

              <div className="adm-section-block">
                <h4>Daftar Pemain ({inspectRoom.players?.length || 0})</h4>
                <div className="adm-table-wrap">
                  <table className="adm-table adm-table--compact">
                    <thead>
                      <tr>
                        <th>Nama</th>
                        <th>Username / ID</th>
                        <th>Tipe</th>
                        <th>Koneksi</th>
                        <th>Info</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(inspectRoom.players || []).map((p, i) => (
                        <tr key={`${p.id || i}`}>
                          <td>
                            <strong>{p.name}</strong> {p.isHost && <Badge tone="brand">HOST</Badge>}
                          </td>
                          <td className="adm-mono">{p.username ? `@${p.username}` : p.userId || p.id || '-'}</td>
                          <td>{p.isBot ? 'AI Bot' : 'Human'}</td>
                          <td>
                            <Badge tone={p.connected ? 'success' : 'warning'}>
                              {p.connected ? 'Terhubung' : 'Terputus'}
                            </Badge>
                          </td>
                          <td className="adm-muted">
                            {p.color && `Warna: ${p.color} `}
                            {p.hp !== undefined && `HP: ${p.hp}/${p.maxHp || 100} `}
                            {p.position !== undefined && `Petak: ${p.position} `}
                            {p.rating && `Elo: ${p.rating}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="adm-section-block">
                <h4>Metadata &amp; Riwayat Aktivitas</h4>
                <pre className="adm-pre">{JSON.stringify(inspectRoom.metadata || {}, null, 2)}</pre>
              </div>

              <div className="adm-row-actions adm-row-actions--end">
                <button
                  type="button"
                  className="adm-btn adm-btn--primary"
                  onClick={() => {
                    const target = inspectRoom;
                    setInspectRoom(null);
                    setWatchRoom(target);
                  }}
                >
                  <AdminIcon name="radio" size={16} />
                  <span>Pantau Live (Senyap)</span>
                </button>
                <button
                  type="button"
                  className="adm-btn adm-btn--danger"
                  onClick={() => setCloseTarget(inspectRoom)}
                >
                  <AdminIcon name="stop" size={16} />
                  <span>Tutup Paksa Room</span>
                </button>
              </div>
            </div>
          )
        )}
      </AdminModal>

      {/* Modal Pantau Live Realtime (Mode Senyap) */}
      <LiveRoomSpectatorModal
        room={watchRoom}
        onClose={() => setWatchRoom(null)}
        onToast={onToast}
        onRequestCloseRoom={target => setCloseTarget(target)}
      />

      {/* Dialog Tutup Paksa Room */}
      <ConfirmDialog
        isOpen={Boolean(closeTarget)}
        onClose={() => setCloseTarget(null)}
        onConfirm={handleForceClose}
        title={`Tutup Paksa Room #${closeTarget?.code || ''}`}
        message={`Menutup room ${closeTarget?.gameLabel || ''} #${closeTarget?.code || ''} akan langsung mengeluarkan semua pemain (${closeTarget?.humansCount || 0} manusia) dan mengirim notifikasi ke layar mereka.`}
        confirmLabel="Tutup Room Sekarang"
        variant="danger"
        requireReason
        reasonLabel="Alasan Penutupan (dikirim ke pemain)"
        defaultReason="Room ditutup oleh administrator untuk pemeliharaan."
        busy={closeBusy}
      />
    </div>
  );
}

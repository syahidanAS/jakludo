import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../api';
import AdminIcon from '../components/AdminIcons';
import KpiCard from '../components/KpiCard';
import Badge, { gameBadgeTone, statusBadgeTone } from '../components/Badge';
import { formatDateTime, formatDuration, formatIdr, formatNumber, formatRelativeTime } from '../utils/format';

export default function OverviewModule({ onNavigate, onToast }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await adminApi.get('/api/admin/overview');
      setData(res);
    } catch (err) {
      setError(err.message);
      onToast?.('error', err.message);
    } finally {
      setLoading(false);
    }
  }, [onToast]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading && !data) {
    return (
      <div className="adm-loading-box" role="status">
        <span className="adm-spinner" /> Memuat ringkasan sistem PlayGo...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="adm-alert adm-alert--danger">
        <div>{error}</div>
        <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={load}>
          Coba Lagi
        </button>
      </div>
    );
  }

  const users = data?.usersSummary || {};
  const rooms = data?.roomsSummary || {};
  const finance = data?.financeSummary || {};
  const health = data?.serverHealth || {};
  const dailyRevenue = finance.recentDailyRevenue || [];
  const maxDaily = Math.max(1, ...dailyRevenue.map(d => Number(d.revenueIdr || 0)));

  return (
    <div className="adm-stack-lg">
      <div className="adm-toolbar adm-toolbar--between">
        <div className="adm-row-actions">
          <span className="adm-pill-info">
            <span className="adm-dot adm-dot--online" />
            Gateway: <strong>{String(health.activeGateway || 'midtrans').toUpperCase()}</strong>
          </span>
          <span className="adm-pill-info">
            DB: <strong>{String(health.dbEngine || '-').toUpperCase()}</strong>
          </span>
          <span className="adm-pill-info">
            Uptime: <strong>{formatDuration(health.uptimeSec)}</strong> · RAM <strong>{health.memoryRssMb || 0} MB</strong>
          </span>
        </div>
        <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={load} disabled={loading}>
          <AdminIcon name="refresh" size={15} />
          <span>{loading ? 'Menyegarkan...' : 'Refresh Data'}</span>
        </button>
      </div>

      {/* KPI Utama */}
      <section className="adm-kpi-grid" aria-label="Ringkasan Metrik Utama">
        <KpiCard
          label="Total Pengguna"
          value={formatNumber(users.totalUsers)}
          sublabel={`${formatNumber(users.adminCount)} Admin · ${formatNumber(users.playerCount)} Pemain (${formatNumber(users.googleCount)} Google)`}
          icon="users"
          tone="info"
        />
        <KpiCard
          label="Room Aktif Saat Ini"
          value={formatNumber(rooms.totalRooms)}
          sublabel={`${formatNumber(rooms.totalConnectedHumans)} Pemain Online · ${formatNumber(rooms.totalBots)} Bot`}
          icon="radio"
          tone="success"
        />
        <KpiCard
          label="Total Pendapatan Top-Up"
          value={formatIdr(finance.totalRevenueIdr)}
          sublabel={`Hari ini: ${formatIdr(finance.todayRevenueIdr)} · ${formatNumber(finance.paidOrdersCount)} Order Lunas`}
          icon="wallet"
          tone="brand"
        />
        <KpiCard
          label="Order Pending & Sirkulasi"
          value={`${formatNumber(finance.pendingOrdersCount)} Pending`}
          sublabel={`${formatNumber(finance.totalCoinsCirculating)} Coins · ${formatNumber(finance.totalDiamondsCirculating)} Diamonds`}
          icon="layers"
          tone={finance.pendingOrdersCount > 0 ? 'warning' : 'neutral'}
        />
      </section>

      {/* Grid Dua Kolom: Distribusi Room + Grafik Pendapatan 7 Hari */}
      <div className="adm-two-col">
        <section className="adm-card">
          <div className="adm-card__head">
            <div>
              <h3>Room Aktif per Game &amp; Antrean Matchmaking</h3>
              <p className="adm-muted">Status realtime arena multiplayer di memori server</p>
            </div>
            <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => onNavigate('rooms')}>
              Monitor Room →
            </button>
          </div>
          <div className="adm-game-bars">
            {[
              { id: 'ludo', label: 'JakLudo', count: rooms.byGame?.ludo || 0, queue: 0 },
              { id: 'quiz', label: 'Monster Quiz', count: rooms.byGame?.quiz || 0, queue: rooms.matchmakingQueues?.quiz || 0 },
              { id: 'chess', label: 'Chess Master', count: rooms.byGame?.chess || 0, queue: rooms.matchmakingQueues?.chess || 0 },
              { id: 'snakes', label: 'Ular Tangga', count: rooms.byGame?.snakes || 0, queue: rooms.matchmakingQueues?.snakes || 0 }
            ].map(g => (
              <div key={g.id} className="adm-game-row">
                <div className="adm-game-row__left">
                  <Badge tone={gameBadgeTone(g.id)}>{g.label}</Badge>
                  {g.queue > 0 && <span className="adm-muted">Antrean MM: {g.queue}</span>}
                </div>
                <div className="adm-game-row__right">
                  <strong>{g.count} Room</strong>
                </div>
              </div>
            ))}
          </div>
          <div className="adm-mini-stats">
            <div>
              <span className="adm-muted">Di Lobby</span>
              <strong>{formatNumber(rooms.byStatus?.lobby || 0)}</strong>
            </div>
            <div>
              <span className="adm-muted">Sedang Main</span>
              <strong>{formatNumber(rooms.byStatus?.playing || 0)}</strong>
            </div>
            <div>
              <span className="adm-muted">Selesai</span>
              <strong>{formatNumber(rooms.byStatus?.finished || 0)}</strong>
            </div>
          </div>
        </section>

        <section className="adm-card">
          <div className="adm-card__head">
            <div>
              <h3>Pendapatan Top-Up 7 Hari Terakhir (WIB)</h3>
              <p className="adm-muted">Total bulan ini: {formatIdr(finance.monthRevenueIdr)}</p>
            </div>
            <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => onNavigate('finance')}>
              Buka Keuangan →
            </button>
          </div>
          <div className="adm-chart" role="img" aria-label="Grafik pendapatan 7 hari terakhir">
            {dailyRevenue.map(d => {
              const pct = d.revenueIdr > 0 ? Math.max(8, Math.round((d.revenueIdr / maxDaily) * 100)) : 3;
              return (
                <div key={d.date} className="adm-chart__col" title={`${d.date}: ${formatIdr(d.revenueIdr)} (${d.ordersCount} order)`}>
                  <div className="adm-chart__amt">{d.revenueIdr > 0 ? `${Math.round(d.revenueIdr / 1000)}rb` : '0'}</div>
                  <div className="adm-chart__track">
                    <div
                      className={`adm-chart__bar ${d.revenueIdr > 0 ? 'is-filled' : ''}`}
                      style={{ height: `${pct}%` }}
                    />
                  </div>
                  <div className="adm-chart__label">{d.label}</div>
                </div>
              );
            })}
          </div>
        </section>
      </div>

      {/* Grid Dua Kolom: Order Terbaru + Log Audit Admin Terbaru */}
      <div className="adm-two-col">
        <section className="adm-card">
          <div className="adm-card__head">
            <div>
              <h3>Order Top-Up Terbaru</h3>
              <p className="adm-muted">Gabungan order Diamonds &amp; Coins</p>
            </div>
            <button type="button" className="adm-btn adm-btn--ghost adm-btn--sm" onClick={() => onNavigate('finance')}>
              Semua Transaksi →
            </button>
          </div>
          <div className="adm-table-wrap">
            <table className="adm-table adm-table--compact">
              <thead>
                <tr>
                  <th>Order</th>
                  <th>User</th>
                  <th>Nominal</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {(data?.recentOrders || []).length === 0 ? (
                  <tr>
                    <td colSpan={4} className="adm-table__empty">
                      Belum ada order top-up tercatat.
                    </td>
                  </tr>
                ) : (
                  (data?.recentOrders || []).map(ord => (
                    <tr key={`${ord.kind}-${ord.orderId}`}>
                      <td>
                        <div className="adm-mono">{ord.orderId}</div>
                        <div className="adm-muted">{ord.rewardLabel}</div>
                      </td>
                      <td>@{ord.username}</td>
                      <td className="adm-num">{formatIdr(ord.amountIdr)}</td>
                      <td>
                        <Badge tone={statusBadgeTone(ord.status)}>{ord.status}</Badge>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="adm-card">
          <div className="adm-card__head">
            <div>
              <h3>Log Aktivitas Admin CMS</h3>
              <p className="adm-muted">Rekaman aksi operasional pada sesi server saat ini</p>
            </div>
          </div>
          {(data?.recentAuditLogs || []).length === 0 ? (
            <p className="adm-empty-note">Belum ada perubahan admin yang tercatat pada sesi server ini.</p>
          ) : (
            <ul className="adm-audit-list">
              {(data?.recentAuditLogs || []).map(log => (
                <li key={log.id} className="adm-audit-item">
                  <div className="adm-audit-item__top">
                    <Badge tone="neutral">{log.action}</Badge>
                    <span className="adm-muted" title={formatDateTime(log.timestamp)}>
                      {formatRelativeTime(log.timestamp)}
                    </span>
                  </div>
                  <div className="adm-audit-item__msg">{log.summary}</div>
                  <div className="adm-muted">oleh @{log.adminUsername}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import { adminApi } from '../api';
import AdminIcon from '../components/AdminIcons';
import AdminModal from '../components/AdminModal';
import ConfirmDialog from '../components/ConfirmDialog';
import KpiCard from '../components/KpiCard';
import Pagination from '../components/Pagination';
import Badge, { statusBadgeTone } from '../components/Badge';
import { formatDateTime, formatIdr, formatNumber } from '../utils/format';

export default function FinanceModule({ onToast }) {
  const [subTab, setSubTab] = useState('orders'); // 'orders' | 'ledger' | 'callbacks' | 'adjust'
  const [summary, setSummary] = useState({});

  // Orders state
  const [ordersData, setOrdersData] = useState({ items: [], total: 0, page: 1, totalPages: 1, filteredRevenueIdr: 0 });
  const [ordersLoading, setOrdersLoading] = useState(true);
  const [orderSearchInput, setOrderSearchInput] = useState('');
  const [orderQ, setOrderQ] = useState('');
  const [kindFilter, setKindFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [gatewayFilter, setGatewayFilter] = useState('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [orderPage, setOrderPage] = useState(1);
  const [orderPageSize, setOrderPageSize] = useState(20);

  // Order detail & action modals
  const [orderDetail, setOrderDetail] = useState(null);
  const [orderAction, setOrderAction] = useState(null); // { type: 'approve' | 'cancel', order }
  const [orderActionBusy, setOrderActionBusy] = useState(false);

  // Ledger state
  const [ledgerData, setLedgerData] = useState({ items: [], total: 0, page: 1, totalPages: 1 });
  const [ledgerLoading, setLedgerLoading] = useState(false);
  const [ledgerQ, setLedgerQ] = useState('');
  const [txTypeFilter, setTxTypeFilter] = useState('all');
  const [ledgerPage, setLedgerPage] = useState(1);

  // Callback logs state
  const [callbacks, setCallbacks] = useState([]);
  const [callbacksLoading, setCallbacksLoading] = useState(false);
  const [cbQ, setCbQ] = useState('');
  const [cbValidFilter, setCbValidFilter] = useState('all');
  const [cbDetail, setCbDetail] = useState(null);

  // Adjust balance form
  const [adjustForm, setAdjustForm] = useState({
    targetUser: '',
    currency: 'diamonds',
    mode: 'delta',
    txType: 'ADMIN_ADJUSTMENT',
    amount: 10,
    reason: ''
  });
  const [adjustBusy, setAdjustBusy] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setOrderQ(orderSearchInput.trim());
      setOrderPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [orderSearchInput]);

  const loadSummary = useCallback(async () => {
    try {
      const res = await adminApi.get('/api/admin/finance/summary');
      setSummary(res.summary || {});
    } catch {}
  }, []);

  const loadOrders = useCallback(async () => {
    setOrdersLoading(true);
    try {
      const res = await adminApi.get('/api/admin/finance/orders', {
        q: orderQ,
        kind: kindFilter,
        status: statusFilter,
        gateway: gatewayFilter,
        dateFrom,
        dateTo,
        page: orderPage,
        pageSize: orderPageSize
      });
      setOrdersData(res);
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setOrdersLoading(false);
    }
  }, [orderQ, kindFilter, statusFilter, gatewayFilter, dateFrom, dateTo, orderPage, orderPageSize, onToast]);

  const loadLedger = useCallback(async () => {
    setLedgerLoading(true);
    try {
      const res = await adminApi.get('/api/admin/finance/ledger', {
        q: ledgerQ.trim(),
        txType: txTypeFilter,
        page: ledgerPage,
        pageSize: 25
      });
      setLedgerData(res);
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setLedgerLoading(false);
    }
  }, [ledgerQ, txTypeFilter, ledgerPage, onToast]);

  const loadCallbacks = useCallback(async () => {
    setCallbacksLoading(true);
    try {
      const res = await adminApi.get('/api/admin/finance/callbacks', {
        q: cbQ.trim(),
        validOnly: cbValidFilter,
        limit: 100
      });
      setCallbacks(res.logs || []);
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setCallbacksLoading(false);
    }
  }, [cbQ, cbValidFilter, onToast]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  useEffect(() => {
    if (subTab === 'orders') loadOrders();
    else if (subTab === 'ledger') loadLedger();
    else if (subTab === 'callbacks') loadCallbacks();
  }, [subTab, loadOrders, loadLedger, loadCallbacks]);

  const openOrderDetail = async ord => {
    setOrderDetail({ order: ord, callbackLogs: [] });
    try {
      const res = await adminApi.get(`/api/admin/finance/orders/${ord.kind}/${encodeURIComponent(ord.orderId)}`);
      setOrderDetail(res);
    } catch (err) {
      onToast?.('error', err.message);
    }
  };

  const handleVerifyGateway = async ord => {
    try {
      const res = await adminApi.post(`/api/admin/finance/orders/${ord.kind}/${encodeURIComponent(ord.orderId)}/verify`, {});
      if (res.verifiedWithGateway) {
        onToast?.('success', `Order ${ord.orderId} terkonfirmasi LUNAS di gateway!`);
      } else {
        onToast?.('info', `Status order ${ord.orderId}: ${res.order?.status || ord.status}`);
      }
      loadOrders();
      loadSummary();
    } catch (err) {
      onToast?.('error', err.message);
    }
  };

  const handleConfirmOrderAction = async reason => {
    if (!orderAction) return;
    const { type, order } = orderAction;
    setOrderActionBusy(true);
    try {
      const endpoint =
        type === 'approve'
          ? `/api/admin/finance/orders/${order.kind}/${encodeURIComponent(order.orderId)}/approve`
          : `/api/admin/finance/orders/${order.kind}/${encodeURIComponent(order.orderId)}/cancel`;
      await adminApi.post(endpoint, { reason });
      onToast?.(
        'success',
        type === 'approve'
          ? `Order ${order.orderId} berhasil ditandai PAID & saldo dikreditkan.`
          : `Order ${order.orderId} dibatalkan.`
      );
      setOrderAction(null);
      setOrderDetail(null);
      loadOrders();
      loadSummary();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setOrderActionBusy(false);
    }
  };

  const handleExportCsv = async () => {
    try {
      await adminApi.downloadCsv('/api/admin/finance/orders/export', {
        q: orderQ,
        kind: kindFilter,
        status: statusFilter,
        gateway: gatewayFilter,
        dateFrom,
        dateTo
      });
      onToast?.('success', 'Laporan transaksi CSV berhasil diunduh.');
    } catch (err) {
      onToast?.('error', err.message);
    }
  };

  const handleAdjustSubmit = async e => {
    e.preventDefault();
    setAdjustBusy(true);
    try {
      const res = await adminApi.post('/api/admin/finance/adjust', {
        targetUser: adjustForm.targetUser.trim(),
        currency: adjustForm.currency,
        mode: adjustForm.currency === 'coins' ? adjustForm.mode : 'delta',
        txType: adjustForm.txType,
        amount: Number(adjustForm.amount),
        reason: adjustForm.reason.trim()
      });
      onToast?.(
        'success',
        `Penyesuaian ${adjustForm.currency} untuk @${res.user?.username} berhasil disimpan.`
      );
      setAdjustForm(f => ({ ...f, reason: '' }));
      loadSummary();
    } catch (err) {
      onToast?.('error', err.message);
    } finally {
      setAdjustBusy(false);
    }
  };

  return (
    <div className="adm-stack-lg">
      {/* KPI Keuangan */}
      <section className="adm-kpi-grid" aria-label="Ringkasan Keuangan Platform">
        <KpiCard
          label="Total Pendapatan Sukses"
          value={formatIdr(summary.totalRevenueIdr)}
          sublabel={`${formatNumber(summary.paidOrdersCount)} Order Lunas · Bulan ini ${formatIdr(summary.monthRevenueIdr)}`}
          icon="wallet"
          tone="brand"
        />
        <KpiCard
          label="Pendapatan Hari Ini (WIB)"
          value={formatIdr(summary.todayRevenueIdr)}
          sublabel={`Diamonds ${formatIdr(summary.diamondOrdersRevenueIdr)} · Coins ${formatIdr(summary.coinOrdersRevenueIdr)}`}
          icon="grid"
          tone="success"
        />
        <KpiCard
          label="Menunggu Pembayaran"
          value={`${formatNumber(summary.pendingOrdersCount)} Order`}
          sublabel={`${formatNumber(summary.failedOrCancelledCount)} Gagal / Batal / Kedaluwarsa`}
          icon="alert"
          tone={summary.pendingOrdersCount > 0 ? 'warning' : 'neutral'}
        />
        <KpiCard
          label="Ekonomi &amp; Refund"
          value={`${formatNumber(summary.totalDiamondsCirculating)} 💎`}
          sublabel={`${formatNumber(summary.totalCoinsCirculating)} Coins · ${formatNumber(summary.totalRefundsCount)} Refund`}
          icon="layers"
          tone="info"
        />
      </section>

      {/* Sub-Tabs Navigation */}
      <div className="adm-subtabs" role="tablist">
        {[
          { id: 'orders', label: 'Order Pembayaran' },
          { id: 'ledger', label: 'Ledger Mutasi Diamonds' },
          { id: 'callbacks', label: 'Log Webhook Gateway' },
          { id: 'adjust', label: 'Penyesuaian Saldo & Refund' }
        ].map(t => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={subTab === t.id}
            className={`adm-btn ${subTab === t.id ? 'adm-btn--primary' : 'adm-btn--secondary'}`}
            onClick={() => setSubTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* TAB 1: ORDER PEMBAYARAN */}
      {subTab === 'orders' && (
        <section className="adm-card">
          <div className="adm-toolbar adm-toolbar--between">
            <div className="adm-filters">
              <div className="adm-search-box">
                <AdminIcon name="search" size={16} />
                <input
                  type="search"
                  className="adm-input adm-input--search"
                  placeholder="Order ID, username, metode, ref..."
                  value={orderSearchInput}
                  onChange={e => setOrderSearchInput(e.target.value)}
                />
              </div>

              <select
                className="adm-select"
                aria-label="Filter jenis paket"
                value={kindFilter}
                onChange={e => {
                  setKindFilter(e.target.value);
                  setOrderPage(1);
                }}
              >
                <option value="all">Semua Paket</option>
                <option value="diamond">Top-Up Diamonds</option>
                <option value="coin">Top-Up Coins</option>
              </select>

              <select
                className="adm-select"
                aria-label="Filter status order"
                value={statusFilter}
                onChange={e => {
                  setStatusFilter(e.target.value);
                  setOrderPage(1);
                }}
              >
                <option value="all">Semua Status</option>
                <option value="PAID">PAID (Lunas)</option>
                <option value="PENDING">PENDING</option>
                <option value="CANCELLED">CANCELLED</option>
                <option value="EXPIRED">EXPIRED</option>
                <option value="FAILED">FAILED</option>
              </select>

              <select
                className="adm-select"
                aria-label="Filter payment gateway"
                value={gatewayFilter}
                onChange={e => {
                  setGatewayFilter(e.target.value);
                  setOrderPage(1);
                }}
              >
                <option value="all">Semua Gateway</option>
                <option value="midtrans">Midtrans</option>
                <option value="doku">DOKU</option>
                <option value="duitku">Duitku</option>
              </select>

              <input
                type="date"
                className="adm-input adm-input--date"
                aria-label="Tanggal dari"
                value={dateFrom}
                onChange={e => {
                  setDateFrom(e.target.value);
                  setOrderPage(1);
                }}
              />
              <input
                type="date"
                className="adm-input adm-input--date"
                aria-label="Tanggal sampai"
                value={dateTo}
                onChange={e => {
                  setDateTo(e.target.value);
                  setOrderPage(1);
                }}
              />
            </div>

            <div className="adm-row-actions">
              <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={handleExportCsv}>
                <AdminIcon name="download" size={15} />
                <span>Export CSV</span>
              </button>
              <button
                type="button"
                className="adm-btn adm-btn--secondary adm-btn--sm"
                onClick={() => {
                  loadOrders();
                  loadSummary();
                }}
                disabled={ordersLoading}
              >
                <AdminIcon name="refresh" size={15} />
                <span>Refresh</span>
              </button>
            </div>
          </div>

          <div className="adm-filter-summary">
            Total Lunas (Sesuai Filter): <strong>{formatIdr(ordersData.filteredRevenueIdr)}</strong>
          </div>

          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Order ID &amp; Waktu</th>
                  <th>Pemain</th>
                  <th>Item / Paket</th>
                  <th>Gateway &amp; Kanal</th>
                  <th>Nominal</th>
                  <th>Status</th>
                  <th className="adm-th-actions">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {ordersLoading && ordersData.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="adm-table__empty">
                      Memuat daftar order pembayaran...
                    </td>
                  </tr>
                ) : ordersData.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="adm-table__empty">
                      Tidak ada order yang cocok dengan filter.
                    </td>
                  </tr>
                ) : (
                  ordersData.items.map(ord => (
                    <tr key={`${ord.kind}-${ord.orderId}`}>
                      <td>
                        <div className="adm-mono">{ord.orderId}</div>
                        <div className="adm-muted">{formatDateTime(ord.createdAt)}</div>
                      </td>
                      <td>
                        <div>
                          <strong>@{ord.username}</strong>
                        </div>
                        <div className="adm-muted">{ord.playerName}</div>
                      </td>
                      <td>
                        <Badge tone={ord.kind === 'diamond' ? 'info' : 'brand'}>
                          {ord.kind === 'diamond' ? 'DIAMOND' : 'COINS'}
                        </Badge>{' '}
                        <strong>{ord.rewardLabel}</strong>
                        <div className="adm-muted">{ord.packageName}</div>
                      </td>
                      <td>
                        <div>
                          <strong className="adm-upper">{ord.gateway}</strong> · {ord.paymentMethodName}
                        </div>
                        {ord.vaNumber && <div className="adm-mono adm-muted">VA: {ord.vaNumber}</div>}
                      </td>
                      <td className="adm-num">
                        <strong>{formatIdr(ord.amountIdr)}</strong>
                      </td>
                      <td>
                        <Badge tone={statusBadgeTone(ord.status)}>{ord.status}</Badge>
                      </td>
                      <td>
                        <div className="adm-row-actions adm-row-actions--end">
                          <button
                            type="button"
                            className="adm-btn adm-btn--ghost adm-btn--xs"
                            onClick={() => openOrderDetail(ord)}
                          >
                            <AdminIcon name="eye" size={14} />
                            <span>Detail</span>
                          </button>
                          {ord.status === 'PENDING' && (
                            <>
                              <button
                                type="button"
                                className="adm-btn adm-btn--secondary adm-btn--xs"
                                title="Verifikasi langsung dengan API Payment Gateway"
                                onClick={() => handleVerifyGateway(ord)}
                              >
                                Cek Gateway
                              </button>
                              <button
                                type="button"
                                className="adm-btn adm-btn--primary adm-btn--xs"
                                onClick={() => setOrderAction({ type: 'approve', order: ord })}
                              >
                                <AdminIcon name="check" size={14} />
                                <span>Lunas</span>
                              </button>
                              <button
                                type="button"
                                className="adm-btn adm-btn--danger-ghost adm-btn--xs"
                                onClick={() => setOrderAction({ type: 'cancel', order: ord })}
                              >
                                <AdminIcon name="x" size={14} />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <Pagination
            page={ordersData.page}
            totalPages={ordersData.totalPages}
            total={ordersData.total}
            pageSize={orderPageSize}
            onPageChange={p => setOrderPage(p)}
            onPageSizeChange={sz => {
              setOrderPageSize(sz);
              setOrderPage(1);
            }}
          />
        </section>
      )}

      {/* TAB 2: LEDGER MUTASI */}
      {subTab === 'ledger' && (
        <section className="adm-card">
          <div className="adm-toolbar adm-toolbar--between">
            <div className="adm-filters">
              <div className="adm-search-box">
                <AdminIcon name="search" size={16} />
                <input
                  type="search"
                  className="adm-input adm-input--search"
                  placeholder="Cari username, ref, deskripsi..."
                  value={ledgerQ}
                  onChange={e => {
                    setLedgerQ(e.target.value);
                    setLedgerPage(1);
                  }}
                />
              </div>
              <select
                className="adm-select"
                value={txTypeFilter}
                onChange={e => {
                  setTxTypeFilter(e.target.value);
                  setLedgerPage(1);
                }}
              >
                <option value="all">Semua Tipe Mutasi</option>
                <option value="TOPUP">TOPUP</option>
                <option value="CONVERSION">CONVERSION</option>
                <option value="SKIN_PURCHASE">SKIN_PURCHASE</option>
                <option value="REFUND">REFUND</option>
                <option value="ADMIN_ADJUSTMENT">ADMIN_ADJUSTMENT</option>
              </select>
            </div>
            <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={loadLedger} disabled={ledgerLoading}>
              <AdminIcon name="refresh" size={15} />
              <span>Refresh</span>
            </button>
          </div>

          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>User</th>
                  <th>Tipe</th>
                  <th>Mutasi</th>
                  <th>Saldo (Sebelum ➔ Sesudah)</th>
                  <th>Keterangan</th>
                </tr>
              </thead>
              <tbody>
                {ledgerLoading && ledgerData.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="adm-table__empty">
                      Memuat ledger mutasi...
                    </td>
                  </tr>
                ) : ledgerData.items.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="adm-table__empty">
                      Belum ada mutasi tercatat.
                    </td>
                  </tr>
                ) : (
                  ledgerData.items.map(tx => (
                    <tr key={tx.id}>
                      <td className="adm-muted">{formatDateTime(tx.createdAt)}</td>
                      <td>
                        <strong>@{tx.username}</strong>
                      </td>
                      <td>
                        <Badge tone={tx.txType === 'TOPUP' || tx.txType === 'REFUND' ? 'success' : tx.txType === 'ADMIN_ADJUSTMENT' ? 'brand' : 'info'}>
                          {tx.txType}
                        </Badge>
                      </td>
                      <td className="adm-num">
                        <strong className={tx.amount >= 0 ? 'adm-text-green' : 'adm-text-red'}>
                          {tx.amount >= 0 ? `+${tx.amount}` : tx.amount} 💎
                        </strong>
                      </td>
                      <td className="adm-num">
                        {tx.previousBalance} ➔ <strong>{tx.newBalance}</strong>
                      </td>
                      <td>
                        <div>{tx.description || '-'}</div>
                        {tx.referenceId && <div className="adm-mono adm-muted">Ref: {tx.referenceId}</div>}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <Pagination
            page={ledgerData.page}
            totalPages={ledgerData.totalPages}
            total={ledgerData.total}
            pageSize={25}
            onPageChange={p => setLedgerPage(p)}
          />
        </section>
      )}

      {/* TAB 3: LOG WEBHOOK */}
      {subTab === 'callbacks' && (
        <section className="adm-card">
          <div className="adm-toolbar adm-toolbar--between">
            <div className="adm-filters">
              <div className="adm-search-box">
                <AdminIcon name="search" size={16} />
                <input
                  type="search"
                  className="adm-input adm-input--search"
                  placeholder="Cari Order ID / status webhook..."
                  value={cbQ}
                  onChange={e => setCbQ(e.target.value)}
                />
              </div>
              <select className="adm-select" value={cbValidFilter} onChange={e => setCbValidFilter(e.target.value)}>
                <option value="all">Semua Signature</option>
                <option value="valid">Signature Valid</option>
                <option value="invalid">Signature Ditolak</option>
              </select>
            </div>
            <button type="button" className="adm-btn adm-btn--secondary adm-btn--sm" onClick={loadCallbacks} disabled={callbacksLoading}>
              <AdminIcon name="refresh" size={15} />
              <span>Refresh</span>
            </button>
          </div>

          <div className="adm-table-wrap">
            <table className="adm-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Order ID</th>
                  <th>Gateway</th>
                  <th>Signature</th>
                  <th>Status Proses</th>
                  <th className="adm-th-actions">Payload</th>
                </tr>
              </thead>
              <tbody>
                {callbacks.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="adm-table__empty">
                      Belum ada log webhook callback tercatat.
                    </td>
                  </tr>
                ) : (
                  callbacks.map(log => (
                    <tr key={log.id}>
                      <td className="adm-muted">{formatDateTime(log.createdAt)}</td>
                      <td className="adm-mono">{log.orderId || '-'}</td>
                      <td className="adm-upper">{log.gateway}</td>
                      <td>
                        <Badge tone={log.signatureValid ? 'success' : 'danger'}>
                          {log.signatureValid ? 'VALID' : 'INVALID'}
                        </Badge>
                      </td>
                      <td>
                        <div>{log.processingStatus}</div>
                        {log.notes && <div className="adm-muted">{log.notes}</div>}
                      </td>
                      <td className="adm-th-actions">
                        <button type="button" className="adm-btn adm-btn--ghost adm-btn--xs" onClick={() => setCbDetail(log)}>
                          JSON
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* TAB 4: PENYESUAIAN SALDO & REFUND */}
      {subTab === 'adjust' && (
        <section className="adm-card adm-card--narrow">
          <div className="adm-card__head">
            <div>
              <h3>Penyesuaian Saldo &amp; Refund Manual</h3>
              <p className="adm-muted">Mutasi Diamonds tercatat permanen ke ledger audit, dan mutasi Coins tersinkronisasi atomic ke PostgreSQL.</p>
            </div>
          </div>

          <form onSubmit={handleAdjustSubmit} className="adm-form">
            <div className="adm-form-grid">
              <div className="adm-field">
                <label className="adm-label">Target User (Username atau User ID) *</label>
                <input
                  type="text"
                  className="adm-input"
                  placeholder="Contoh: syahidan atau user_..."
                  value={adjustForm.targetUser}
                  onChange={e => setAdjustForm(f => ({ ...f, targetUser: e.target.value }))}
                  required
                />
              </div>

              <div className="adm-field">
                <label className="adm-label">Mata Uang</label>
                <select
                  className="adm-select"
                  value={adjustForm.currency}
                  onChange={e => setAdjustForm(f => ({ ...f, currency: e.target.value }))}
                >
                  <option value="diamonds">Diamonds 💎 (Dual Ledger)</option>
                  <option value="coins">Coins 🪙 (Reguler)</option>
                </select>
              </div>

              {adjustForm.currency === 'diamonds' ? (
                <div className="adm-field">
                  <label className="adm-label">Tipe Transaksi Audit</label>
                  <select
                    className="adm-select"
                    value={adjustForm.txType}
                    onChange={e => setAdjustForm(f => ({ ...f, txType: e.target.value }))}
                  >
                    <option value="ADMIN_ADJUSTMENT">ADMIN_ADJUSTMENT (+ / -)</option>
                    <option value="REFUND">REFUND (Hanya +)</option>
                  </select>
                </div>
              ) : (
                <div className="adm-field">
                  <label className="adm-label">Mode Pengaturan Coins</label>
                  <select
                    className="adm-select"
                    value={adjustForm.mode}
                    onChange={e => setAdjustForm(f => ({ ...f, mode: e.target.value }))}
                  >
                    <option value="delta">Tambah / Kurang (+/-)</option>
                    <option value="set">Atur Nilai Pasti</option>
                  </select>
                </div>
              )}

              <div className="adm-field">
                <label className="adm-label">
                  {adjustForm.currency === 'coins' && adjustForm.mode === 'set'
                    ? 'Nilai Saldo Coins Akhir *'
                    : 'Jumlah Perubahan (+ untuk tambah, - untuk kurang) *'}
                </label>
                <input
                  type="number"
                  className="adm-input"
                  value={adjustForm.amount}
                  onChange={e => setAdjustForm(f => ({ ...f, amount: e.target.value }))}
                  required
                />
              </div>
            </div>

            <div className="adm-field">
              <label className="adm-label">Alasan Penyesuaian / Refund (Wajib untuk Audit) *</label>
              <textarea
                className="adm-textarea"
                rows={3}
                placeholder="Jelaskan alasan mutasi manual (misal: Refund gangguan top-up order #...)"
                value={adjustForm.reason}
                onChange={e => setAdjustForm(f => ({ ...f, reason: e.target.value }))}
                required
              />
            </div>

            <div className="adm-row-actions adm-row-actions--end">
              <button type="submit" className="adm-btn adm-btn--primary" disabled={adjustBusy}>
                {adjustBusy ? 'Memproses Mutasi...' : 'Eksekusi Penyesuaian Saldo'}
              </button>
            </div>
          </form>
        </section>
      )}

      {/* Modal Detail Order */}
      <AdminModal
        isOpen={Boolean(orderDetail)}
        onClose={() => setOrderDetail(null)}
        title={`Detail Transaksi ${orderDetail?.order?.orderId || ''}`}
        subtitle={`${orderDetail?.order?.kind === 'diamond' ? 'Top-Up Diamonds' : 'Top-Up Coins'} · Gateway: ${orderDetail?.order?.gateway || '-'}`}
        size="lg"
      >
        {orderDetail?.order && (
          <div className="adm-stack">
            <div className="adm-detail-grid">
              <div className="adm-detail-box">
                <span className="adm-muted">Status &amp; Nominal</span>
                <div>
                  <Badge tone={statusBadgeTone(orderDetail.order.status)}>{orderDetail.order.status}</Badge>{' '}
                  <strong>{formatIdr(orderDetail.order.amountIdr)}</strong>
                </div>
              </div>
              <div className="adm-detail-box">
                <span className="adm-muted">Pemain</span>
                <div>
                  <strong>@{orderDetail.order.username}</strong> ({orderDetail.order.playerName})
                </div>
              </div>
              <div className="adm-detail-box">
                <span className="adm-muted">Paket &amp; Item</span>
                <div>
                  {orderDetail.order.packageName} ({orderDetail.order.rewardLabel})
                </div>
              </div>
              <div className="adm-detail-box">
                <span className="adm-muted">Metode &amp; Referensi</span>
                <div>
                  {orderDetail.order.paymentMethodName}{' '}
                  {orderDetail.order.vaNumber && <code className="adm-code">VA: {orderDetail.order.vaNumber}</code>}
                </div>
              </div>
            </div>

            {orderDetail.order.failureReason && (
              <div className="adm-alert adm-alert--danger">
                <strong>Catatan Status:</strong> {orderDetail.order.failureReason}
              </div>
            )}

            <div className="adm-section-block">
              <h4>Log Callback Gateway untuk Order Ini</h4>
              {(orderDetail.callbackLogs || []).length === 0 ? (
                <p className="adm-muted">Belum ada webhook callback yang masuk untuk order ini.</p>
              ) : (
                <pre className="adm-pre">{JSON.stringify(orderDetail.callbackLogs, null, 2)}</pre>
              )}
            </div>

            {orderDetail.order.status === 'PENDING' && (
              <div className="adm-row-actions adm-row-actions--end">
                <button
                  type="button"
                  className="adm-btn adm-btn--secondary"
                  onClick={() => handleVerifyGateway(orderDetail.order)}
                >
                  Cek Status Gateway
                </button>
                <button
                  type="button"
                  className="adm-btn adm-btn--danger"
                  onClick={() => setOrderAction({ type: 'cancel', order: orderDetail.order })}
                >
                  Batalkan Order
                </button>
                <button
                  type="button"
                  className="adm-btn adm-btn--primary"
                  onClick={() => setOrderAction({ type: 'approve', order: orderDetail.order })}
                >
                  Tandai Lunas Manual
                </button>
              </div>
            )}
          </div>
        )}
      </AdminModal>

      {/* Modal JSON Webhook Callback */}
      <AdminModal
        isOpen={Boolean(cbDetail)}
        onClose={() => setCbDetail(null)}
        title={`Payload Webhook ${cbDetail?.orderId || cbDetail?.id || ''}`}
        subtitle={`Gateway: ${cbDetail?.gateway || '-'} · Valid: ${cbDetail?.signatureValid ? 'Ya' : 'Tidak'}`}
        size="md"
      >
        <pre className="adm-pre">{JSON.stringify(cbDetail || {}, null, 2)}</pre>
      </AdminModal>

      {/* Dialog Konfirmasi Approve / Cancel Order */}
      <ConfirmDialog
        isOpen={Boolean(orderAction)}
        onClose={() => setOrderAction(null)}
        onConfirm={handleConfirmOrderAction}
        title={
          orderAction?.type === 'approve'
            ? `Konfirmasi Pelunasan Manual (${orderAction?.order?.orderId || ''})`
            : `Batalkan Order (${orderAction?.order?.orderId || ''})`
        }
        message={
          orderAction?.type === 'approve'
            ? `Apakah pembayaran sebesar ${formatIdr(orderAction?.order?.amountIdr)} untuk @${orderAction?.order?.username} sudah benar-benar masuk? Saldo ${orderAction?.order?.rewardLabel} akan dikreditkan seketika.`
            : `Order ${orderAction?.order?.orderId} milik @${orderAction?.order?.username} akan ditandai CANCELLED dan tidak dapat diselesaikan lagi.`
        }
        confirmLabel={orderAction?.type === 'approve' ? 'Ya, Tandai Lunas' : 'Ya, Batalkan Order'}
        variant={orderAction?.type === 'approve' ? 'primary' : 'danger'}
        requireReason
        reasonLabel="Catatan Audit Admin (Wajib)"
        reasonPlaceholder={
          orderAction?.type === 'approve'
            ? 'Contoh: Dana sudah masuk mutasi BCA tanggal ...'
            : 'Contoh: Order kadaluarsa / dibatalkan atas permintaan user'
        }
        busy={orderActionBusy}
      />
    </div>
  );
}

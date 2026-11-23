import React, { useCallback, useEffect, useRef, useState } from 'react';
import Modal from './components/Modal';
import Icon from './components/Icon';
import { LudoSkinPreview, LUDO_SKIN_META, resolveSkinKey } from './components/game/LudoSkinPawn';
import { useItemCatalogState } from './items';
import { sound } from './sound';
import { storage } from './storage';

function formatIdr(value) {
  return `Rp ${Number(value || 0).toLocaleString('id-ID')}`;
}

function formatDateTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('id-ID', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return iso;
  }
}

function txTypeLabel(type) {
  switch (type) {
    case 'TOPUP':
      return { label: 'Top-Up Diamonds', tone: 'success' };
    case 'CONVERSION':
      return { label: 'Konversi Diamonds → Coins', tone: 'info' };
    case 'SKIN_PURCHASE':
      return { label: 'Beli Skin Ludo', tone: 'warning' };
    case 'REFUND':
      return { label: 'Refund', tone: 'brand' };
    case 'ADMIN_ADJUSTMENT':
      return { label: 'Penyesuaian Admin', tone: 'neutral' };
    default:
      return { label: type || '-', tone: 'neutral' };
  }
}

function orderStatusTone(status) {
  switch (status) {
    case 'PAID':
      return 'success';
    case 'PENDING':
      return 'warning';
    case 'FAILED':
    case 'CANCELLED':
    case 'EXPIRED':
      return 'error';
    default:
      return 'neutral';
  }
}

function methodCategoryLabel(category) {
  if (category === 'qris') return 'QRIS';
  if (category === 'ewallet') return 'E-Wallet';
  return 'Virtual Account';
}

const DEFAULT_MIDTRANS_METHODS = [
  {
    code: 'bca_va',
    label: 'BCA Virtual Account',
    category: 'va',
    bank: 'BCA',
    badge: 'Populer',
    description: 'Transfer via myBCA, BCA Mobile, KlikBCA, atau ATM BCA.'
  },
  {
    code: 'bni_va',
    label: 'BNI Virtual Account',
    category: 'va',
    bank: 'BNI',
    badge: 'VA',
    description: 'Transfer via Wondr by BNI, BNI Mobile, atau ATM BNI.'
  },
  {
    code: 'bri_va',
    label: 'BRI Virtual Account (BRIVA)',
    category: 'va',
    bank: 'BRI',
    badge: 'VA',
    description: 'Transfer via BRImo, Internet Banking BRI, atau ATM BRI.'
  },
  {
    code: 'qris',
    label: 'QRIS (Semua E-Wallet & Bank)',
    category: 'qris',
    bank: 'QRIS',
    badge: 'Instan',
    description: 'Scan QR dari GoPay, OVO, DANA, ShopeePay, BCA Mobile, Livin, dll.'
  },
  {
    code: 'gopay',
    label: 'GoPay E-Wallet',
    category: 'ewallet',
    bank: 'GoPay',
    badge: 'Instan',
    description: 'Bayar instan via aplikasi GoPay atau scan kode QR.'
  },
  {
    code: 'shopeepay',
    label: 'ShopeePay E-Wallet',
    category: 'ewallet',
    bank: 'ShopeePay',
    badge: 'Instan',
    description: 'Bayar langsung melalui aplikasi Shopee / ShopeePay.'
  },
  {
    code: 'dana',
    label: 'DANA E-Wallet',
    category: 'ewallet',
    bank: 'DANA',
    badge: 'E-Wallet',
    description: 'Scan QRIS resmi PlayGo langsung dari aplikasi DANA kamu.'
  },
  {
    code: 'ovo',
    label: 'OVO E-Wallet',
    category: 'ewallet',
    bank: 'OVO',
    badge: 'E-Wallet',
    description: 'Scan QRIS resmi PlayGo langsung dari aplikasi OVO kamu.'
  }
];

const DEFAULT_DUITKU_METHODS = DEFAULT_MIDTRANS_METHODS;

function openDokuCheckout(paymentUrl) {
  if (!paymentUrl) return false;
  if (typeof window.loadJokulCheckout === 'function') {
    try {
      window.loadJokulCheckout(paymentUrl);
      return true;
    } catch (e) {
      console.warn('[DOKU] loadJokulCheckout failed:', e);
    }
  }

  const isProd = !paymentUrl.includes('sandbox.doku.com');
  const scriptUrl = isProd
    ? 'https://jokul.doku.com/jokul-checkout-js/v1/jokul-checkout-1.0.0.js'
    : 'https://sandbox.doku.com/jokul-checkout-js/v1/jokul-checkout-1.0.0.js';

  let existing = document.querySelector(`script[src="${scriptUrl}"]`);
  if (!existing) {
    const script = document.createElement('script');
    script.src = scriptUrl;
    script.async = true;
    script.onload = () => {
      if (typeof window.loadJokulCheckout === 'function') {
        try {
          window.loadJokulCheckout(paymentUrl);
        } catch {}
      }
    };
    document.head.appendChild(script);
  }
  return false;
}

function DuitkuPaymentPanel({
  payment,
  verifying,
  cancelling,
  copiedField,
  onCopy,
  onCheckStatus,
  onCancelOrder,
  onBack
}) {
  if (!payment) return null;
  const qrSrc =
    payment.qrCodeUrl ||
    (payment.qrString
      ? `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(payment.qrString)}`
      : null);

  return (
    <div className="topup-modal-view">
      <div className="topup-summary-box">
        <div className="mp-payment-meta">
          <div className="shop-item__badges">
            <span className="badge badge--warning">Menunggu Pembayaran</span>
          </div>
          <h4>{payment.title}</h4>
          <div className="muted mp-payment-ids">
            <span>Order ID: <code className="code-text">{payment.orderId}</code></span>
            {payment.reference && <span> · Ref: <code className="code-text">{payment.reference}</code></span>}
          </div>
          <div className="muted mp-payment-method-line">
            Metode: <strong>{payment.paymentMethodName || payment.paymentMethod || 'Pembayaran Online'}</strong>
          </div>
        </div>
        <div className="mp-payment-amount-col">
          <span className="muted">Total Tagihan</span>
          <strong className="mp-payment-amount">{formatIdr(payment.amountIdr)}</strong>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onCopy(String(payment.amountIdr), 'amount')}
          >
            {copiedField === 'amount' ? '✓ Nominal Disalin' : 'Salin Nominal'}
          </button>
        </div>
      </div>

      <div className="mp-payment-screen">
        {payment.deeplinkUrl && (
          <div className="mp-payment-block mp-deeplink-block">
            <h4>Buka Aplikasi {payment.bank || payment.paymentMethodName || 'E-Wallet'}</h4>
            <p className="muted mp-payment-hint">
              Ketuk tombol di bawah untuk membuka aplikasi <strong>{payment.bank || 'E-Wallet'}</strong> di ponsel atau simulator pembayaran Midtrans Sandbox.
            </p>
            <div className="mp-payment-actions" style={{ marginBottom: 'var(--space-2)' }}>
              <a
                href={payment.deeplinkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--primary"
                style={{ textDecoration: 'none' }}
              >
                Buka Aplikasi {payment.bank || 'E-Wallet'} ↗
              </a>
            </div>
          </div>
        )}

        {qrSrc && (
          <div className="mp-payment-block">
            <h4>
              {payment.bank === 'DANA'
                ? 'Scan QRIS via Aplikasi DANA'
                : payment.bank === 'OVO'
                ? 'Scan QRIS via Aplikasi OVO'
                : 'Scan QRIS untuk Menyelesaikan Pembayaran'}
            </h4>
            <div className="topup-qr-container">
              <img src={qrSrc} alt="Kode QRIS PlayGo" className="topup-qr-image" />
              <div className="mp-qr-caption">
                {payment.bank === 'DANA'
                  ? 'DANA E-Wallet · QRIS Midtrans Resmi'
                  : payment.bank === 'OVO'
                  ? 'OVO E-Wallet · QRIS Midtrans Resmi'
                  : 'PlayGo Indonesia · QRIS Midtrans Sandbox'}
              </div>
            </div>
            <p className="muted mp-payment-hint">
              {payment.bank === 'DANA'
                ? 'Buka aplikasi DANA di ponselmu, pilih icon Scan / Bayar, lalu arahkan kamera ke kode QR di atas.'
                : payment.bank === 'OVO'
                ? 'Buka aplikasi OVO di ponselmu, pilih icon Pay / Scan, lalu arahkan kamera ke kode QR di atas.'
                : 'Buka aplikasi GoPay, OVO, DANA, ShopeePay, BCA Mobile, Livin by Mandiri, atau aplikasi perbankan apa pun yang mendukung QRIS, lalu pindai kode QR di atas.'}
            </p>
            {payment.qrString && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => onCopy(payment.qrString, 'qr')}
              >
                {copiedField === 'qr' ? '✓ Kode QRIS Disalin' : 'Salin Kode QRIS'}
              </button>
            )}
          </div>
        )}

        {payment.vaNumber && (
          <div className="mp-payment-block">
            <h4>Transfer ke {payment.bank || payment.paymentMethodName || 'Virtual Account'}</h4>
            <div className="topup-va-display">
              <span className="muted">Nomor Virtual Account</span>
              <span className="topup-va-number">{payment.vaNumber}</span>
              <button
                type="button"
                className="btn btn--secondary topup-copy-btn"
                onClick={() => onCopy(payment.vaNumber, 'va')}
              >
                {copiedField === 'va' ? '✓ Nomor VA Disalin!' : 'Salin Nomor Virtual Account'}
              </button>
            </div>
            <p className="muted mp-payment-hint">
              Transfer sesuai nominal pas sebesar <strong>{formatIdr(payment.amountIdr)}</strong> via ATM, mobile banking, atau internet banking {payment.bank || 'terkait'}. Saldo otomatis bertambah begitu pembayaran terkonfirmasi.
            </p>
          </div>
        )}

        {payment.gateway === 'doku' && payment.paymentUrl && (
          <div className="mp-payment-url-box">
            <h4>Pembayaran Resmi DOKU</h4>
            <p className="muted mp-payment-hint">
              Klik tombol di bawah jika jendela checkout belum terbuka.
            </p>
            <div className="mp-payment-actions" style={{ marginBottom: 'var(--space-2)' }}>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => openDokuCheckout(payment.paymentUrl)}
              >
                Buka Pop-up Modal DOKU ↗
              </button>
            </div>
          </div>
        )}

        <div className="topup-live-indicator">
          <span className="topup-live-dot" />
          <span>Memantau status pembayaran secara otomatis...</span>
        </div>

        <div className="mp-payment-actions">
          <button
            type="button"
            className="btn btn--primary"
            disabled={verifying}
            onClick={onCheckStatus}
          >
            {verifying ? 'Memeriksa...' : 'Cek Status Pembayaran'}
          </button>
          {onCancelOrder && (
            <button
              type="button"
              className="btn btn--ghost"
              disabled={cancelling || verifying}
              onClick={onCancelOrder}
            >
              {cancelling ? 'Membatalkan...' : 'Batalkan Pesanan'}
            </button>
          )}
          <button
            type="button"
            className="btn btn--secondary"
            onClick={onBack}
          >
            ← Kembali ke Paket
          </button>
        </div>
      </div>
    </div>
  );
}

function LegacyShopItemCard({ item, points, ownedCount, currentUser, buyingId, onBuy }) {
  const canAfford = points >= item.price;
  const isBusy = buyingId === item.id;
  // Batas pembelian per item per bulan (dihitung server, dikirim di objek user)
  const monthlyLimit = Number(currentUser?.itemPurchaseLimit || 0);
  const boughtThisMonth = Number(currentUser?.itemPurchasesThisMonth?.[item.id] || 0);
  const remainingThisMonth = monthlyLimit ? Math.max(0, monthlyLimit - boughtThisMonth) : null;
  const limitReached = remainingThisMonth === 0;
  const disabled = !currentUser || !canAfford || isBusy || limitReached;

  return (
    <li className={`shop-item card mp-product-card shop-item--${item.game || 'ludo'}`}>
      <div className="shop-item__head">
        <span className="shop-item__icon" aria-hidden="true">{item.icon || '🎁'}</span>
        <div className="shop-item__title-wrap">
          <strong>{item.name}</strong>
          <div className="shop-item__badges">
            {item.badge && (
              <span className="badge" style={{ '--badge-color': item.badgeColor || 'var(--brand)' }}>
                {item.badge}
              </span>
            )}
            {currentUser && ownedCount > 0 && (
              <span className="badge badge--success">Dimiliki: {ownedCount}</span>
            )}
          </div>
        </div>
      </div>

      <p className="shop-item__desc">{item.description}</p>
      {item.highlight && <p className="shop-item__highlight muted">{item.highlight}</p>}
      {currentUser && remainingThisMonth !== null && (
        <p className={`shop-item__quota ${limitReached ? 'is-empty' : ''}`}>
          {limitReached
            ? `Batas bulan ini tercapai (${monthlyLimit}/${monthlyLimit}). Bisa dibeli lagi bulan depan.`
            : `Sisa pembelian bulan ini: ${remainingThisMonth}/${monthlyLimit}`}
        </p>
      )}

      <div className="shop-item__foot">
        <span className="shop-item__price">
          <Icon name="coin" size={16} /> <strong>{item.price}</strong> Coins
        </span>
        <button
          type="button"
          className={`btn btn--sm ${canAfford && currentUser && !limitReached ? 'btn--primary' : 'btn--secondary'}`}
          disabled={disabled}
          onClick={() => onBuy(item)}
        >
          {isBusy
            ? 'Membeli...'
            : !currentUser
            ? 'Perlu Login'
            : limitReached
            ? 'Batas Bulanan'
            : !canAfford
            ? 'Coins Kurang'
            : 'Beli Item'}
        </button>
      </div>
    </li>
  );
}

function UnifiedTopupSection({
  mode,
  packages,
  selectedPkg,
  onSelectPkg,
  methods,
  selectedMethodCode,
  onSelectMethod,
  selectedMethodObj,
  activePayment,
  verifyingPayment,
  checkingOrderId,
  copiedField,
  onCopy,
  onCheckStatus,
  onCancelOrder,
  onBackPayment,
  currentUser,
  onOpenAuth,
  submitting,
  onSubmitTopup
}) {
  const isCoins = mode === 'coins';
  const [checkoutPkg, setCheckoutPkg] = useState(null);
  const [activeMethod, setActiveMethod] = useState(selectedMethodCode || 'qris');
  const [methodCategoryFilter, setMethodCategoryFilter] = useState('all');
  const [localSubmitting, setLocalSubmitting] = useState(false);

  useEffect(() => {
    if (selectedMethodCode) setActiveMethod(selectedMethodCode);
  }, [selectedMethodCode]);

  const handleOpenCheckout = pkg => {
    if (!currentUser) {
      onOpenAuth?.();
      return;
    }
    sound.playClick();
    onSelectPkg?.(pkg.id);
    setCheckoutPkg(pkg);
  };

  const handleConfirmCheckout = async () => {
    if (!checkoutPkg || localSubmitting) return;
    setLocalSubmitting(true);
    try {
      onSelectMethod?.(activeMethod);
      const ok = await onSubmitTopup(checkoutPkg, activeMethod);
      if (ok) {
        setCheckoutPkg(null);
      }
    } catch {} finally {
      setLocalSubmitting(false);
    }
  };

  const visibleMethods = (methods || []).filter(m => {
    if (methodCategoryFilter === 'all') return true;
    if (methodCategoryFilter === 'qris') return m.category === 'qris';
    if (methodCategoryFilter === 'va') return m.category === 'va';
    if (methodCategoryFilter === 'ewallet') return m.category === 'ewallet';
    return true;
  });

  const activeMethodObj = (methods || []).find(m => m.code === activeMethod) || selectedMethodObj || null;

  return (
    <section className="card mp-topup-card" aria-label={isCoins ? 'Top-Up Coins' : 'Top-Up Diamonds'}>
      <div className="mp-card-head mp-card-head--topup">
        <div>
          <h3 className="shop__group-title">
            <Icon name={isCoins ? 'coin' : 'diamond'} size={18} />
            <span>{isCoins ? 'Top-Up Coins PlayGo (Reguler)' : 'Top-Up Diamonds Premium'}</span>
          </h3>
          <p className="shop__group-desc">
            Pilih paket yang kamu butuhkan, bayar instan via Midtrans Core API (BCA VA, BNI VA, BRI VA, QRIS, GoPay, DANA, OVO, ShopeePay).
          </p>
        </div>
        <span className="badge badge--diamond">Midtrans Core API</span>
      </div>

      {activePayment?.mode === mode ? (
        <DuitkuPaymentPanel
          payment={activePayment}
          verifying={verifyingPayment && checkingOrderId === activePayment.orderId}
          cancelling={checkingOrderId === activePayment.orderId && !verifyingPayment}
          copiedField={copiedField}
          onCopy={onCopy}
          onCheckStatus={() => onCheckStatus(activePayment.orderId, false)}
          onCancelOrder={() => onCancelOrder(activePayment.orderId)}
          onBack={onBackPayment}
        />
      ) : (
        <div className="mp-diamond-pkg-grid" role="list" aria-label={isCoins ? 'Pilihan paket Coins' : 'Pilihan paket Diamonds'}>
          {packages.map(pkg => {
            const totalD = Number(pkg.diamonds || 0) + Number(pkg.bonusDiamonds || 0);
            const isBusy = (submitting && selectedPkg?.id === pkg.id) || (localSubmitting && checkoutPkg?.id === pkg.id);
            return (
              <div key={pkg.id} className="mp-diamond-pkg">
                <div className="mp-diamond-pkg__top">
                  <span
                    className={`shop-item__icon ${isCoins ? '' : 'shop-item__icon--diamond'}`}
                    aria-hidden="true"
                  >
                    <Icon name={isCoins ? (pkg.icon === 'crown' ? 'crown' : 'coin') : 'diamond'} size={22} />
                  </span>
                  <div className="shop-item__badges">
                    {pkg.badge && <span className="badge badge--popular">{pkg.badge}</span>}
                  </div>
                </div>

                <div className="mp-diamond-pkg__body">
                  <div className="mp-diamond-pkg__qty">
                    {isCoins ? pkg.name : `${totalD} Diamonds`}
                  </div>
                  <div className="mp-diamond-pkg__name">
                    {isCoins
                      ? pkg.description
                      : `${pkg.name}${pkg.bonusDiamonds > 0 ? ` (+${pkg.bonusDiamonds} Bonus)` : ''}`}
                  </div>
                </div>

                <div className="mp-diamond-pkg__foot">
                  <strong className="topup-price">
                    {isCoins ? (pkg.formattedPrice || formatIdr(pkg.price)) : formatIdr(pkg.priceIdr)}
                  </strong>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    disabled={isBusy}
                    onClick={() => handleOpenCheckout(pkg)}
                  >
                    {isBusy ? 'Memproses...' : !currentUser ? 'Login' : isCoins ? 'Top Up Coin' : 'Top Up Diamond'}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {checkoutPkg && (
        <Modal
          isOpen={Boolean(checkoutPkg)}
          open={Boolean(checkoutPkg)}
          onClose={() => setCheckoutPkg(null)}
          title={`Pilih Metode Pembayaran (${isCoins ? checkoutPkg.name : `${Number(checkoutPkg.diamonds || 0) + Number(checkoutPkg.bonusDiamonds || 0)} Diamonds`})`}
          subtitle="Midtrans Core API Sandbox"
          size="md"
        >
          <div className="mp-checkout-modal-content" style={{ display: 'grid', gap: 'var(--space-3)' }}>
            <div className="mp-checkout-pkg-summary" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-3)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
              <div>
                <strong style={{ fontSize: 'var(--fs-md)' }}>{checkoutPkg.name}</strong>
                <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                  {isCoins ? checkoutPkg.description : `${checkoutPkg.diamonds} Diamonds ${checkoutPkg.bonusDiamonds > 0 ? `(+${checkoutPkg.bonusDiamonds} Bonus)` : ''}`}
                </div>
              </div>
              <strong className="topup-price" style={{ fontSize: 'var(--fs-lg)' }}>
                {isCoins ? (checkoutPkg.formattedPrice || formatIdr(checkoutPkg.price)) : formatIdr(checkoutPkg.priceIdr)}
              </strong>
            </div>

            <div className="mp-method-selector-section">
              <div className="mp-step-head mp-step-head--between" style={{ marginBottom: 'var(--space-2)' }}>
                <h4 style={{ margin: 0, fontSize: 'var(--fs-sm)' }}>Pilih Channel Pembayaran:</h4>
                <div className="skin-filter-pills">
                  {[
                    { id: 'all', label: 'Semua' },
                    { id: 'qris', label: 'QRIS' },
                    { id: 'va', label: 'Virtual Account' },
                    { id: 'ewallet', label: 'E-Wallet' }
                  ].map(cat => (
                    <button
                      key={cat.id}
                      type="button"
                      className={`btn btn--sm ${methodCategoryFilter === cat.id ? 'btn--primary' : 'btn--ghost'}`}
                      onClick={() => setMethodCategoryFilter(cat.id)}
                    >
                      {cat.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="mp-method-grid" role="radiogroup" aria-label="Metode Pembayaran">
                {visibleMethods.map(method => {
                  const isSelected = activeMethod === method.code;
                  return (
                    <button
                      key={method.code}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={`mp-method-card ${isSelected ? 'is-selected' : ''}`}
                      onClick={() => {
                        sound.playClick();
                        setActiveMethod(method.code);
                      }}
                    >
                      <div className="mp-method-card__top">
                        <span className="mp-method-tag">{methodCategoryLabel(method.category)}</span>
                        {method.badge && (
                          <span className={`badge ${method.badge === 'Instan' ? 'badge--success' : 'badge--popular'}`}>
                            {method.badge}
                          </span>
                        )}
                      </div>
                      <strong className="mp-method-card__label">{method.label}</strong>
                      <span className="muted mp-method-card__desc">{method.description}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mp-checkout-bar" style={{ marginTop: 'var(--space-2)' }}>
              <div className="mp-checkout-bar__info">
                <span>Total Pembayaran ({activeMethodObj?.label || 'Midtrans'}):</span>
                <strong className="mp-payment-amount">
                  {isCoins ? (checkoutPkg.formattedPrice || formatIdr(checkoutPkg.price)) : formatIdr(checkoutPkg.priceIdr)}
                </strong>
              </div>
              <div className="mp-checkout-bar__cta">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm"
                  onClick={() => setCheckoutPkg(null)}
                >
                  Batal
                </button>
                <button
                  type="button"
                  className="btn btn--primary btn--sm"
                  disabled={localSubmitting}
                  onClick={handleConfirmCheckout}
                >
                  {localSubmitting ? 'Memproses...' : 'Bayar Sekarang ↗'}
                </button>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

function UnifiedOrderHistoryPanel({
  orders,
  checkingOrderId,
  onOpenInstruction,
  onVerifyOrder,
  onCancelOrder
}) {
  if (!orders.length) return null;
  return (
    <div className="econ-orders-panel card">
      <div className="section-head">
        <h3>Riwayat Order Pembayaran Top-Up</h3>
        <span className="muted">{orders.length} pesanan terbaru</span>
      </div>
      <div className="tx-table-wrap">
        <table className="tx-table">
          <thead>
            <tr>
              <th>Order ID</th>
              <th>Paket</th>
              <th>Metode</th>
              <th>Harga</th>
              <th>Status</th>
              <th>Waktu</th>
              <th>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {orders.slice(0, 20).map(ord => (
              <tr key={ord.displayId}>
                <td className="code-text">{ord.displayId}</td>
                <td>{ord.displayPackage}</td>
                <td>{ord.paymentMethodName || ord.paymentMethod || '-'}</td>
                <td>{formatIdr(ord.displayAmount)}</td>
                <td>
                  <span className={`badge badge--${orderStatusTone(ord.displayStatus)}`}>
                    {ord.displayStatus}
                  </span>
                </td>
                <td>{formatDateTime(ord.createdAt)}</td>
                <td>
                  <div className="tx-actions">
                    {ord.displayStatus === 'PENDING' && (
                      <>
                        {(ord.vaNumber || ord.qrCodeUrl || ord.qrString || ord.paymentUrl) && (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            onClick={() => onOpenInstruction(ord, ord.kind)}
                          >
                            Lihat Instruksi
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          disabled={checkingOrderId === ord.displayId}
                          onClick={() => onVerifyOrder(ord)}
                        >
                          {checkingOrderId === ord.displayId ? '...' : 'Cek Status'}
                        </button>
                        <button
                          type="button"
                          className="btn btn--ghost btn--sm"
                          disabled={checkingOrderId === ord.displayId}
                          onClick={() => onCancelOrder(ord)}
                        >
                          Batal
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function ShopModal({
  isOpen = true,
  onClose,
  currentUser,
  onUpdateUser,
  authToken,
  initialGame = 'all',
  initialTab = null,
  initialSkinId = null,
  onOpenAuth
}) {
  const catalog = useItemCatalogState();
  const token = authToken || storage.get('token') || '';
  const isAdmin = Boolean(currentUser?.isAdmin || currentUser?.role === 'admin');

  const [activeTab, setActiveTab] = useState(
    initialTab || (initialGame === 'quiz' || initialGame === 'chess' ? 'items' : 'skins')
  );
  const [feedback, setFeedback] = useState(null);

  // Dual currency economy state
  const [wallet, setWallet] = useState(null);
  const [economySettings, setEconomySettings] = useState({
    coinsPerDiamond: 100,
    minConvertDiamonds: 10,
    maxConvertDiamonds: 50,
    conversionEnabled: true
  });
  const [diamondPackages, setDiamondPackages] = useState([]);
  const [paymentOrders, setPaymentOrders] = useState([]);
  const [skins, setSkins] = useState([]);
  const [equippedSkinId, setEquippedSkinId] = useState(null);
  const [transactions, setTransactions] = useState([]);
  const [txTypeFilter, setTxTypeFilter] = useState('');

  // Skin Marketplace Filters & Interactive Preview
  const [skinFilter, setSkinFilter] = useState('all');
  const [skinQuery, setSkinQuery] = useState('');
  const [inspectedSkinId, setInspectedSkinId] = useState(initialSkinId || null);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
    if (initialSkinId) setInspectedSkinId(initialSkinId);
  }, [initialTab, initialSkinId]);

  // Conversion & Payment Gateway Direct API Top-Up State
  const [duitkuMethods, setDuitkuMethods] = useState(DEFAULT_MIDTRANS_METHODS);
  const [paymentMethod, setPaymentMethod] = useState('qris');
  const [selectedPkgId, setSelectedPkgId] = useState('');
  const [selectedCoinPkgId, setSelectedCoinPkgId] = useState('');
  const [creatingOrderPkgId, setCreatingOrderPkgId] = useState('');
  const [checkingOrderId, setCheckingOrderId] = useState('');
  const [activePayment, setActivePayment] = useState(null);
  const [verifyingPayment, setVerifyingPayment] = useState(false);
  const [copiedField, setCopiedField] = useState('');
  const [confirmSkin, setConfirmSkin] = useState(null);
  const [skinActionId, setSkinActionId] = useState('');

  // Legacy Coins Shop & Coins Top-Up
  const [legacyCategory, setLegacyCategory] = useState(
    initialGame === 'quiz' || initialGame === 'chess' ? initialGame : 'all'
  );
  const [legacyPackages, setLegacyPackages] = useState([]);
  const [coinPaymentOrders, setCoinPaymentOrders] = useState([]);
  const [buyingLegacyId, setBuyingLegacyId] = useState('');
  const [topupLegacyId, setTopupLegacyId] = useState('');

  // Admin state
  const [adminOverview, setAdminOverview] = useState(null);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminSubTab, setAdminSubTab] = useState('config');
  const [adminSettingsForm, setAdminSettingsForm] = useState({
    coinsPerDiamond: 100,
    minConvertDiamonds: 10,
    maxConvertDiamonds: 50,
    conversionEnabled: true
  });
  const [adminPkgForm, setAdminPkgForm] = useState({
    id: '',
    name: '',
    diamonds: 10,
    bonusDiamonds: 0,
    priceIdr: 5000,
    badge: '',
    sortOrder: 5,
    isActive: true
  });
  const [adminSkinForm, setAdminSkinForm] = useState({
    id: '',
    name: '',
    description: '',
    priceDiamonds: 25,
    rarity: 'Rare',
    assetKey: 'classic_gold',
    accentColor: '#38bdf8',
    sortOrder: 8,
    isActive: true
  });
  const [adminAdjustForm, setAdminAdjustForm] = useState({
    userId: '',
    amount: 10,
    txType: 'ADMIN_ADJUSTMENT',
    reason: ''
  });

  const authHeaders = useCallback(() => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = `Bearer ${token}`;
    return h;
  }, [token]);

  const loadEconomyData = useCallback(async () => {
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [pkgRes, skinRes] = await Promise.all([
        fetch('/api/economy/packages', { headers }),
        fetch('/api/economy/skins', { headers })
      ]);
      const pkgData = await pkgRes.json().catch(() => ({}));
      const skinData = await skinRes.json().catch(() => ({}));

      if (pkgRes.ok && pkgData.success) {
        const pkgs = pkgData.packages || [];
        setDiamondPackages(pkgs);
        setSelectedPkgId(prev => {
          if (prev && pkgs.some(p => p.id === prev)) return prev;
          return pkgs.find(p => p.id === 'pkg_popular')?.id || pkgs[0]?.id || '';
        });
        if (Array.isArray(pkgData.paymentMethods) && pkgData.paymentMethods.length > 0) {
          setDuitkuMethods(pkgData.paymentMethods);
        }
        if (pkgData.settings) {
          setEconomySettings(pkgData.settings);
        }
        if (pkgData.wallet) setWallet(pkgData.wallet);
      }
      if (skinRes.ok && skinData.success) {
        setSkins(skinData.skins || []);
        setEquippedSkinId(skinData.equippedSkinId || null);
      }

      if (token) {
        const [wRes, txRes, ordRes, coinOrdRes] = await Promise.all([
          fetch('/api/economy/wallet', { headers }),
          fetch(`/api/economy/transactions${txTypeFilter ? `?txType=${encodeURIComponent(txTypeFilter)}` : ''}`, { headers }),
          fetch('/api/economy/topup/history', { headers }),
          fetch('/api/topup/history', { headers })
        ]);
        const wData = await wRes.json().catch(() => ({}));
        const txData = await txRes.json().catch(() => ({}));
        const ordData = await ordRes.json().catch(() => ({}));
        const coinOrdData = await coinOrdRes.json().catch(() => ({}));
        if (wRes.ok && wData.success) {
          setWallet(wData.wallet);
          if (wData.user) onUpdateUser?.(wData.user);
        }
        if (txRes.ok && txData.success) {
          setTransactions(txData.transactions || []);
        }
        if (ordRes.ok && ordData.success) {
          setPaymentOrders(ordData.orders || []);
        }
        if (coinOrdRes.ok && coinOrdData.success) {
          setCoinPaymentOrders(coinOrdData.orders || []);
        }
      }
    } catch {
      // Abaikan gangguan jaringan sementara
    }
  }, [token, txTypeFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadLegacyTopup = useCallback(async () => {
    try {
      const res = await fetch('/api/topup/config');
      const data = await res.json().catch(() => ({}));
      if (data?.success) {
        const cPkgs = data.packages || [];
        setLegacyPackages(cPkgs);
        setSelectedCoinPkgId(prev => {
          if (prev && cPkgs.some(p => p.id === prev)) return prev;
          return cPkgs.find(p => p.id === 'diamond_120')?.id || cPkgs[0]?.id || '';
        });
        if (Array.isArray(data.paymentMethods) && data.paymentMethods.length > 0) {
          setDuitkuMethods(data.paymentMethods);
        }
      }
    } catch {}
  }, []);

  const loadLivePaymentMethods = useCallback(async amountIdr => {
    try {
      const amount = Math.max(1000, Number(amountIdr) || 10000);
      const res = await fetch(`/api/economy/payment-methods?amount=${encodeURIComponent(amount)}`);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data?.success && Array.isArray(data.methods) && data.methods.length > 0) {
        setDuitkuMethods(data.methods);
        setPaymentMethod(prev => (data.methods.some(m => m.code === prev) ? prev : data.methods[0].code));
      }
    } catch {}
  }, []);

  const loadAdminOverview = useCallback(async () => {
    if (!token || !isAdmin) return;
    setAdminLoading(true);
    try {
      const res = await fetch('/api/admin/economy/overview?limit=80', {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setAdminOverview(data);
        if (data.settings) setAdminSettingsForm(data.settings);
      }
    } catch {} finally {
      setAdminLoading(false);
    }
  }, [token, isAdmin]);

  useEffect(() => {
    if (!isOpen) return;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    loadEconomyData();
    loadLegacyTopup();
    if (isAdmin && activeTab === 'admin') {
      loadAdminOverview();
    }
  }, [isOpen, loadEconomyData, loadLegacyTopup, isAdmin, activeTab, loadAdminOverview]);

  const selectedPkg =
    diamondPackages.find(p => p.id === selectedPkgId) ||
    diamondPackages[0] ||
    null;

  const selectedCoinPkg =
    legacyPackages.find(p => p.id === selectedCoinPkgId) ||
    legacyPackages[0] ||
    null;

  const activeTopupAmountIdr =
    activeTab === 'coins' ? selectedCoinPkg?.price : selectedPkg?.priceIdr;

  useEffect(() => {
    if (!isOpen || (activeTab !== 'diamonds' && activeTab !== 'coins')) return;
    if (activeTopupAmountIdr) {
      loadLivePaymentMethods(activeTopupAmountIdr);
    }
  }, [isOpen, activeTab, activeTopupAmountIdr, loadLivePaymentMethods]);

  useEffect(() => {
    if (!isOpen) return undefined;
    const onKey = e => {
      if (e.key === 'Escape' && !confirmSkin) {
        onClose?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, confirmSkin, onClose]);

  const verifyDiamondOrder = useCallback(async (orderId, silentIfPending = false) => {
    if (!orderId) return;
    setCheckingOrderId(orderId);
    setVerifyingPayment(true);
    try {
      const res = await fetch(`/api/economy/topup/status/${encodeURIComponent(orderId)}`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        if (data.wallet) setWallet(data.wallet);
        if (data.order?.status === 'PAID') {
          sound.playShopPurchase();
          setActivePayment(prev => (prev?.orderId === orderId ? null : prev));
          setFeedback({
            type: 'success',
            message: `Pembayaran ${orderId} terkonfirmasi LUNAS! +${data.order.totalDiamonds} Diamonds telah masuk ke akunmu.`
          });
          await loadEconomyData();
        } else if (['FAILED', 'EXPIRED', 'CANCELLED'].includes(data.order?.status)) {
          setActivePayment(prev => (prev?.orderId === orderId ? null : prev));
          setFeedback({
            type: 'error',
            message: `Pesanan ${orderId} berstatus ${data.order.status}.`
          });
          await loadEconomyData();
        } else if (!silentIfPending) {
          setFeedback({
            type: 'info',
            message: `Status order ${orderId}: masih menunggu pembayaran (${data.order?.status || 'PENDING'}).`
          });
          await loadEconomyData();
        }
      }
    } catch {} finally {
      setCheckingOrderId('');
      setVerifyingPayment(false);
    }
  }, [token, loadEconomyData]);

  const verifyLegacyCoinsOrder = useCallback(async (orderId, silentIfPending = false) => {
    if (!orderId) return;
    setCheckingOrderId(orderId);
    setVerifyingPayment(true);
    try {
      const res = await fetch('/api/topup/verify', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ orderId })
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success && data.status === 'success') {
        sound.playShopPurchase();
        if (data.user) onUpdateUser?.(data.user);
        setActivePayment(prev => (prev?.orderId === orderId ? null : prev));
        setFeedback({
          type: 'success',
          message: `Pembayaran Coins ${orderId} terkonfirmasi! +${data.coins || data.diamonds} Coins telah ditambahkan.`
        });
        await loadEconomyData();
      } else if (!silentIfPending) {
        setFeedback({
          type: 'info',
          message: data.message || `Pesanan ${orderId} masih menunggu pembayaran.`
        });
      }
    } catch {} finally {
      setCheckingOrderId('');
      setVerifyingPayment(false);
    }
  }, [authHeaders, loadEconomyData, onUpdateUser]);

  // Realtime auto-polling ke backend saat layar instruksi pembayaran Duitku API terbuka
  const activePaymentRef = useRef(activePayment);
  activePaymentRef.current = activePayment;
  useEffect(() => {
    if (!isOpen || !activePayment?.orderId) return undefined;
    const orderId = activePayment.orderId;
    const mode = activePayment.mode;
    const timer = setInterval(() => {
      const cur = activePaymentRef.current;
      if (!cur || cur.orderId !== orderId) return;
      if (mode === 'diamonds') {
        verifyDiamondOrder(orderId, true);
      } else {
        verifyLegacyCoinsOrder(orderId, true);
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [isOpen, activePayment?.orderId, activePayment?.mode, verifyDiamondOrder, verifyLegacyCoinsOrder]);

  if (!isOpen) return null;

  const points = Number(wallet?.coins ?? currentUser?.points ?? 0);
  const diamonds = Number(wallet?.diamonds ?? currentUser?.diamonds ?? 0);
  const ownedItems = currentUser?.inventory || {};

  const copyToClipboard = async (text, field) => {
    if (!text) return;
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      sound.playClick();
      setCopiedField(field);
      setTimeout(() => setCopiedField(''), 2200);
    } catch {}
  };

  // ---- DUITKU DIRECT API v2 DIAMOND TOP-UP ----
  const handleCreateDiamondTopup = async (pkg, methodOverride) => {
    if (!pkg) return false;
    if (!currentUser) {
      setFeedback({ type: 'error', message: 'Silakan login terlebih dahulu untuk top-up Diamonds.' });
      return false;
    }
    const chosenMethod = methodOverride || paymentMethod || 'qris';
    setCreatingOrderPkgId(pkg.id);
    setFeedback(null);
    sound.playClick();
    try {
      const res = await fetch('/api/economy/topup/create', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ packageId: pkg.id, paymentMethod: chosenMethod })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal membuat tagihan top-up Diamonds.');

      const order = data.order;
      const inv = data.invoice || {};
      const selectedMethodObj = duitkuMethods.find(m => m.code === (inv.paymentMethod || chosenMethod));
      const payUrl = inv.paymentUrl || order.paymentUrl || null;

      setActivePayment({
        mode: 'diamonds',
        orderId: order.id,
        reference: inv.reference || order.gatewayReference,
        title: `${order.packageName} (${order.totalDiamonds} Diamonds)`,
        amountIdr: order.amountIdr,
        paymentMethod: inv.paymentMethod || order.paymentMethod || chosenMethod,
        paymentMethodName: inv.paymentMethodName || selectedMethodObj?.label || order.paymentMethod,
        paymentCategory: inv.paymentCategory || selectedMethodObj?.category || 'va',
        bank: inv.bank || selectedMethodObj?.bank || null,
        vaNumber: inv.vaNumber || order.vaNumber || null,
        qrString: inv.qrString || order.qrString || null,
        qrCodeUrl: inv.qrCodeUrl || order.qrCodeUrl || null,
        deeplinkUrl: inv.deeplinkUrl || order.deeplinkUrl || null,
        paymentUrl: payUrl,
        gateway: order.gateway || inv.gateway,
        status: order.status
      });

      if (payUrl && (order.gateway === 'doku' || inv.gateway === 'doku')) {
        openDokuCheckout(payUrl);
      }

      setFeedback({
        type: 'info',
        message: `Tagihan ${order.id} (${formatIdr(order.amountIdr)}) siap dibayar.`
      });
      loadEconomyData();
      return true;
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
      return false;
    } finally {
      setCreatingOrderPkgId('');
    }
  };

  const openOrderInstruction = (ord, mode = 'diamonds') => {
    if (!ord) return;
    sound.playClick();
    const raw = ord.rawCreateResponse || {};
    const methodObj = duitkuMethods.find(m => m.code === ord.paymentMethod);
    const id = ord.id || ord.orderId;
    const isCoins = mode === 'coins';
    const payUrl = ord.paymentUrl || raw.paymentUrl || null;
    setActiveTab(isCoins ? 'coins' : 'diamonds');
    setActivePayment({
      mode: isCoins ? 'coins' : 'diamonds',
      orderId: id,
      reference: ord.gatewayReference || ord.reference || raw.reference || null,
      title: isCoins
        ? ord.packageName || `${ord.coins} Coins`
        : `${ord.packageName} (${ord.totalDiamonds} Diamonds)`,
      amountIdr: ord.amountIdr ?? ord.grossAmount,
      paymentMethod: ord.paymentMethod || raw.paymentMethod,
      paymentMethodName: ord.paymentMethodName || raw.paymentMethodName || methodObj?.label || ord.paymentMethod,
      paymentCategory: ord.paymentCategory || raw.paymentCategory || methodObj?.category || 'va',
      bank: ord.bank || raw.bank || methodObj?.bank || null,
      vaNumber: ord.vaNumber || raw.vaNumber || null,
      qrString: ord.qrString || raw.qrString || null,
      qrCodeUrl: ord.qrCodeUrl || raw.qrCodeUrl || null,
      deeplinkUrl: ord.deeplinkUrl || raw.deeplinkUrl || null,
      paymentUrl: payUrl,
      gateway: ord.gateway || raw.gateway || null,
      status: ord.status
    });
    if (payUrl && (ord.gateway === 'doku' || raw.gateway === 'doku')) {
      openDokuCheckout(payUrl);
    }
    window.scrollTo({ top: 180, behavior: 'smooth' });
  };

  const cancelOrderRequest = async (orderId, endpoint) => {
    setCheckingOrderId(orderId);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ orderId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal membatalkan order.');
      setActivePayment(prev => (prev?.orderId === orderId ? null : prev));
      setFeedback({ type: 'info', message: `Order ${orderId} dibatalkan.` });
      await loadEconomyData();
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setCheckingOrderId('');
    }
  };

  const cancelDiamondOrder = orderId => cancelOrderRequest(orderId, '/api/economy/topup/cancel');
  const cancelLegacyCoinsOrder = orderId => cancelOrderRequest(orderId, '/api/topup/cancel');

  // ---- LUDO SKIN PURCHASE & EQUIP ----
  const executeBuySkin = async skin => {
    if (!skin || !currentUser) return;
    setSkinActionId(skin.id);
    setFeedback(null);
    sound.playClick();
    try {
      const res = await fetch('/api/economy/skins/purchase', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          skinId: skin.id,
          idempotencyKey: `skin_${skin.id}_${Date.now()}`
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal membeli skin.');
      sound.playShopPurchase();
      if (data.wallet) setWallet(data.wallet);
      if (data.user) onUpdateUser?.(data.user);
      setConfirmSkin(null);
      setFeedback({
        type: 'success',
        message: `Selamat! Skin "${skin.name}" sekarang menjadi milikmu. Klik Pasang untuk memakainya di JakLudo!`
      });
      await loadEconomyData();
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
      setConfirmSkin(null);
    } finally {
      setSkinActionId('');
    }
  };

  const handleEquipSkin = async skinId => {
    if (!currentUser) return;
    setSkinActionId(skinId || 'default');
    setFeedback(null);
    sound.playClick();
    try {
      const res = await fetch('/api/economy/skins/equip', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ skinId })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal memasang skin.');
      sound.playShopPurchase();
      setEquippedSkinId(data.equippedSkinId || null);
      if (data.user) onUpdateUser?.(data.user);
      setFeedback({
        type: 'success',
        message: data.equippedSkin
          ? `Skin "${data.equippedSkin.name}" aktif untuk bidak JakLudo kamu!`
          : 'Skin bidak dikembalikan ke Standar PlayGo.'
      });
      await loadEconomyData();
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setSkinActionId('');
    }
  };

  // ---- LEGACY COINS SHOP & DIRECT API TOP-UP ----
  const buyLegacyItem = async item => {
    setBuyingLegacyId(item.id);
    setFeedback(null);
    sound.playClick();
    try {
      const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ itemId: item.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Pembelian gagal.');
      sound.playShopPurchase();
      setFeedback({ type: 'success', message: `${item.name} berhasil dibeli.` });
      if (data.user) onUpdateUser?.(data.user);
      loadEconomyData();
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setBuyingLegacyId('');
    }
  };

  const handleLegacyTopup = async (pkg, methodOverride) => {
    if (!pkg) return false;
    if (!currentUser) {
      setFeedback({ type: 'error', message: 'Silakan login terlebih dahulu.' });
      return false;
    }
    const chosenMethod = methodOverride || paymentMethod || 'qris';
    setTopupLegacyId(pkg.id);
    setFeedback(null);
    sound.playClick();
    try {
      const res = await fetch('/api/topup/create', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ packageId: pkg.id, paymentMethod: chosenMethod })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal membuat tagihan top up Coins.');

      const methodObj = duitkuMethods.find(m => m.code === (data.paymentMethod || chosenMethod));
      const payUrl = data.paymentUrl || data.payment?.paymentUrl || null;

      setActivePayment({
        mode: 'coins',
        orderId: data.orderId,
        reference: data.reference || null,
        title: `${pkg.name}`,
        amountIdr: pkg.price,
        paymentMethod: data.paymentMethod || chosenMethod,
        paymentMethodName: data.paymentMethodName || methodObj?.label || data.paymentMethod,
        paymentCategory: data.paymentCategory || methodObj?.category || 'va',
        bank: data.bank || methodObj?.bank || null,
        vaNumber: data.vaNumber || data.payment?.vaNumber || null,
        qrString: data.qrString || data.payment?.qrString || null,
        qrCodeUrl: data.qrCodeUrl || data.payment?.qrCodeUrl || null,
        deeplinkUrl: data.deeplinkUrl || data.payment?.deeplinkUrl || null,
        paymentUrl: payUrl,
        gateway: data.gateway || data.payment?.gateway || null,
        status: 'PENDING'
      });

      if (payUrl && (data.gateway === 'doku' || data.payment?.gateway === 'doku')) {
        openDokuCheckout(payUrl);
      }

      setFeedback({
        type: 'info',
        message: `Tagihan Coins ${data.orderId} (${pkg.formattedPrice}) siap dibayar.`
      });
      loadEconomyData();
      return true;
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
      return false;
    } finally {
      setTopupLegacyId('');
    }
  };

  // ---- ADMIN ACTIONS ----
  const saveAdminSettings = async e => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/economy/settings', {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({
          coinsPerDiamond: Number(adminSettingsForm.coinsPerDiamond),
          minConvertDiamonds: Number(adminSettingsForm.minConvertDiamonds),
          maxConvertDiamonds: Number(adminSettingsForm.maxConvertDiamonds),
          conversionEnabled: Boolean(adminSettingsForm.conversionEnabled)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal menyimpan pengaturan konversi.');
      setFeedback({ type: 'success', message: 'Pengaturan konversi Coins → Diamonds diperbarui.' });
      await Promise.all([loadAdminOverview(), loadEconomyData()]);
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const saveAdminPackage = async e => {
    e.preventDefault();
    setFeedback(null);
    try {
      const url = adminPkgForm.id
        ? `/api/admin/economy/packages/${encodeURIComponent(adminPkgForm.id)}`
        : '/api/admin/economy/packages';
      const method = adminPkgForm.id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify({
          name: adminPkgForm.name,
          diamonds: Number(adminPkgForm.diamonds),
          bonusDiamonds: Number(adminPkgForm.bonusDiamonds || 0),
          priceIdr: Number(adminPkgForm.priceIdr),
          badge: adminPkgForm.badge,
          sortOrder: Number(adminPkgForm.sortOrder || 10),
          isActive: Boolean(adminPkgForm.isActive)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal menyimpan paket Diamond.');
      setFeedback({ type: 'success', message: `Paket "${data.package?.name}" berhasil disimpan.` });
      await Promise.all([loadAdminOverview(), loadEconomyData()]);
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const saveAdminSkin = async e => {
    e.preventDefault();
    setFeedback(null);
    try {
      const url = adminSkinForm.id
        ? `/api/admin/economy/skins/${encodeURIComponent(adminSkinForm.id)}`
        : '/api/admin/economy/skins';
      const method = adminSkinForm.id ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify({
          name: adminSkinForm.name,
          description: adminSkinForm.description,
          priceDiamonds: Number(adminSkinForm.priceDiamonds),
          rarity: adminSkinForm.rarity,
          assetKey: adminSkinForm.assetKey,
          accentColor: adminSkinForm.accentColor,
          sortOrder: Number(adminSkinForm.sortOrder || 10),
          isActive: Boolean(adminSkinForm.isActive)
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal menyimpan Skin Ludo.');
      setFeedback({ type: 'success', message: `Skin "${data.skin?.name}" berhasil disimpan.` });
      await Promise.all([loadAdminOverview(), loadEconomyData()]);
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const submitAdminAdjustment = async e => {
    e.preventDefault();
    setFeedback(null);
    try {
      const res = await fetch('/api/admin/economy/wallets/adjust', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          username: adminAdjustForm.userId,
          amount: Number(adminAdjustForm.amount),
          txType: adminAdjustForm.txType,
          reason: adminAdjustForm.reason
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Gagal menyesuaikan saldo Diamonds.');
      setFeedback({
        type: 'success',
        message: `Saldo Diamonds pemain berhasil disesuaikan (${data.transaction?.amount > 0 ? '+' : ''}${data.transaction?.amount} Diamonds).`
      });
      setAdminAdjustForm(prev => ({ ...prev, reason: '' }));
      await Promise.all([loadAdminOverview(), loadEconomyData()]);
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    }
  };

  const queryLower = skinQuery.trim().toLowerCase();
  const visibleSkins = skins.filter(s => {
    if (skinFilter === 'owned' && !s.owned) return false;
    if (['Common', 'Rare', 'Epic', 'Legendary'].includes(skinFilter) && s.rarity !== skinFilter) return false;
    if (queryLower && !s.name.toLowerCase().includes(queryLower) && !String(s.description || '').toLowerCase().includes(queryLower)) {
      return false;
    }
    return true;
  });

  const activeSkinObj = skins.find(s => s.id === equippedSkinId) || currentUser?.equippedLudoSkin || null;
  const showcaseSkin =
    skins.find(s => s.id === inspectedSkinId) ||
    activeSkinObj ||
    skins.find(s => s.id === 'legendary_diamond') ||
    skins[0] ||
    null;


  const combinedPaymentOrders = [
    ...paymentOrders.map(ord => ({
      ...ord,
      kind: 'diamonds',
      displayId: ord.id,
      displayPackage: `${ord.packageName} (${ord.totalDiamonds} 💎)`,
      displayAmount: ord.amountIdr,
      displayStatus: String(ord.status || 'PENDING').toUpperCase()
    })),
    ...coinPaymentOrders.map(ord => {
      const rawSt = String(ord.status || 'pending').toUpperCase();
      return {
        ...ord,
        id: ord.orderId || ord.id,
        kind: 'coins',
        displayId: ord.orderId || ord.id,
        displayPackage: `${ord.packageName || `${ord.coins} Coins`} 🪙`,
        displayAmount: ord.grossAmount ?? ord.amountIdr,
        displayStatus: rawSt === 'SUCCESS' ? 'PAID' : rawSt
      };
    })
  ].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));

  const selectedMethodObj = duitkuMethods.find(m => m.code === paymentMethod) || duitkuMethods[0] || null;
  const verifyOrderFromHistory = ord =>
    ord.kind === 'coins' ? verifyLegacyCoinsOrder(ord.displayId) : verifyDiamondOrder(ord.displayId);
  const cancelOrderFromHistory = ord =>
    ord.kind === 'coins' ? cancelLegacyCoinsOrder(ord.displayId) : cancelDiamondOrder(ord.displayId);

  const catalogItems = Array.isArray(catalog?.items) ? catalog.items : [];
  const ludoItems = catalogItems.filter(i => (i.game || 'ludo') === 'ludo');
  const quizItems = catalogItems.filter(i => i.game === 'quiz');
  const chessItems = catalogItems.filter(i => i.game === 'chess');
  const legacyGroups = [
    {
      key: 'ludo',
      name: 'JakLudo — Item & Taktik',
      desc: 'Dipakai langsung saat bermain JakLudo dari tab Item di panel kanan atau di bawah papan.',
      icon: 'dice',
      badge: 'Coins',
      items: ludoItems
    },
    {
      key: 'quiz',
      name: 'Monster Quiz Battle — Bantuan Duel',
      desc: 'Bantuan pintar untuk menaklukkan soal cepat di Monster Quiz Battle.',
      icon: 'swords',
      badge: 'Coins',
      items: quizItems
    },
    {
      key: 'chess',
      name: 'Chess Master — Bantuan Analisis',
      desc: 'Dipakai saat giliranmu di Chess Master lewat tombol Hint di bawah papan.',
      icon: 'bulb',
      badge: 'Coins',
      items: chessItems
    }
  ].filter(g => g.items.length > 0 && (legacyCategory === 'all' || legacyCategory === g.key));

  const navItems = [
    { id: 'skins', icon: 'pawn', label: 'Skin Bidak Ludo', count: skins.length },
    { id: 'diamonds', icon: 'diamond', label: 'Top-Up Diamonds 💎', count: diamondPackages.length },
    { id: 'items', icon: 'shop', label: 'Item Game', count: catalogItems.length },
    { id: 'coins', icon: 'coin', label: 'Coins', count: legacyPackages.length },
    { id: 'wallet', icon: 'trophy', label: 'Dompet & Riwayat', count: null },
    ...(isAdmin ? [{ id: 'admin', icon: 'crown', label: 'Admin Ekonomi', count: null }] : [])
  ];

  return (
    <main className="marketplace-page" id="main">
      {/* ================= HERO HEADER & WALLET ================= */}
      <section className="mp-hero card" aria-label="Header PlayGo Marketplace">
        <div className="mp-hero__top">
          <div className="mp-hero__brand">
            <button
              type="button"
              className="btn btn--secondary btn--sm mp-back-btn"
              onClick={() => {
                sound.playClick();
                onClose?.();
              }}
            >
              ← Kembali
            </button>
            <div>
              <h1 className="mp-hero__title">PlayGo Marketplace</h1>
              <p className="mp-hero__subtitle">
                Belanja Skin Bidak JakLudo, tukar Diamonds jadi Coins, Top-Up Coins &amp; Diamonds instan, dan lengkapi item permainanmu.
              </p>
            </div>
          </div>

          {!currentUser && onOpenAuth && (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                sound.playClick();
                onOpenAuth();
              }}
            >
              Masuk untuk Transaksi
            </button>
          )}
        </div>

        <div className="mp-wallet-cards">
          <div className="mp-wallet-card mp-wallet-card--coins">
            <span className="mp-wallet-card__icon"><Icon name="coin" size={24} /></span>
            <div className="mp-wallet-card__meta">
              <span className="econ-currency-label">Coins Standar</span>
              <strong className="econ-currency-value">{points.toLocaleString('id-ID')}</strong>
            </div>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                sound.playClick();
                setActiveTab('coins');
              }}
            >
              + Coins
            </button>
          </div>

          <div className="mp-wallet-card mp-wallet-card--diamonds">
            <span className="mp-wallet-card__icon"><Icon name="diamond" size={24} /></span>
            <div className="mp-wallet-card__meta">
              <span className="econ-currency-label">Diamonds Premium</span>
              <strong className="econ-currency-value">{diamonds.toLocaleString('id-ID')}</strong>
            </div>
            <button
              type="button"
              className="btn btn--primary btn--sm"
              onClick={() => {
                sound.playClick();
                setActiveTab('diamonds');
              }}
            >
              + Isi / Tukar 💎
            </button>
          </div>

          <div className="mp-wallet-card mp-wallet-card--skin">
            <LudoSkinPreview skin={activeSkinObj} size={44} teamColor="blue" />
            <div className="mp-wallet-card__meta">
              <span className="econ-currency-label">Skin JakLudo Terpasang</span>
              <strong className="econ-currency-value econ-currency-value--sm">
                {activeSkinObj?.name || 'Standar PlayGo'}
              </strong>
            </div>
            {equippedSkinId && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                disabled={skinActionId === 'default'}
                onClick={() => handleEquipSkin(null)}
              >
                Lepas
              </button>
            )}
          </div>
        </div>
      </section>

      {feedback && (
        <p className={`alert alert--${feedback.type === 'success' ? 'success' : feedback.type === 'info' ? 'info' : 'error'} mp-feedback`} role="alert">
          {feedback.message}
        </p>
      )}

      {/* ================= MARKETPLACE SIDEBAR + CONTENT STAGE ================= */}
      <div className="mp-layout">
        <aside className="mp-sidebar" aria-label="Navigasi Kategori Marketplace">
          <nav className="mp-nav card" role="tablist" aria-label="Menu Ekonomi PlayGo">
            {navItems.map(item => (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={activeTab === item.id}
                className={`mp-nav__item ${activeTab === item.id ? 'is-active' : ''}`}
                onClick={() => {
                  sound.playClick();
                  setActiveTab(item.id);
                  setFeedback(null);
                }}
              >
                <span className="mp-nav__left">
                  <Icon name={item.icon} size={17} />
                  <span>{item.label}</span>
                </span>
                {item.count !== null && <span className="mp-nav__count">{item.count}</span>}
              </button>
            ))}
          </nav>

          <div className="mp-tips card">
            <h4>Info Kurs &amp; Pembayaran</h4>
            <ul>
              <li>Menang Match = <strong>+30 Coins</strong></li>
              <li>Bonus Harian = <strong>+5 Coins</strong></li>
              <li>Pembayaran mudah via <strong>QRIS, Virtual Account, &amp; E-Wallet</strong></li>
            </ul>
          </div>
        </aside>

        <div className="mp-stage">
          {/* ================= TAB 1: JAKLUDO SKIN SHOP ================= */}
          {activeTab === 'skins' && (
            <section className="mp-section" aria-label="Toko Skin Bidak JakLudo">
              {showcaseSkin && (
                <div
                  className="mp-skin-showcase card"
                  style={{ '--skin-accent': showcaseSkin.accentColor || '#38bdf8' }}
                >
                  <div className="mp-skin-showcase__previews">
                    <LudoSkinPreview skin={showcaseSkin} size={64} teamColor="red" />
                    <LudoSkinPreview skin={showcaseSkin} size={64} teamColor="blue" />
                    <LudoSkinPreview skin={showcaseSkin} size={64} teamColor="green" />
                    <LudoSkinPreview skin={showcaseSkin} size={64} teamColor="yellow" />
                  </div>
                  <div className="mp-skin-showcase__info">
                    <div className="mp-skin-showcase__badges">
                      <span className="badge badge--diamond">Pratinjau 4 Tim</span>
                      <span className={`rarity-badge rarity-badge--${String(showcaseSkin.rarity).toLowerCase()}`}>
                        {showcaseSkin.rarity}
                      </span>
                      {LUDO_SKIN_META[resolveSkinKey(showcaseSkin)]?.abilityLabel && (
                        <span className="badge badge--ocean-ability">
                          🌊 {LUDO_SKIN_META[resolveSkinKey(showcaseSkin)].abilityLabel}
                        </span>
                      )}
                      {showcaseSkin.equipped && <span className="badge badge--success">✓ Terpasang</span>}
                    </div>
                    <h2>{showcaseSkin.name}</h2>
                    <p className="muted">{showcaseSkin.description}</p>
                    <div className="mp-skin-showcase__actions">
                      <span className="mp-price-tag">
                        <Icon name="diamond" size={16} /> <strong>{showcaseSkin.priceDiamonds}</strong> Diamonds
                      </span>
                      {showcaseSkin.owned ? (
                        showcaseSkin.equipped ? (
                          <button
                            type="button"
                            className="btn btn--secondary btn--sm"
                            disabled={skinActionId === showcaseSkin.id}
                            onClick={() => handleEquipSkin(null)}
                          >
                            TERPASANG (Lepas)
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="btn btn--primary btn--sm"
                            disabled={skinActionId === showcaseSkin.id}
                            onClick={() => handleEquipSkin(showcaseSkin.id)}
                          >
                            PASANG KE JAKLUDO
                          </button>
                        )
                      ) : currentUser ? (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          disabled={diamonds < Number(showcaseSkin.priceDiamonds) || skinActionId === showcaseSkin.id}
                          onClick={() => setConfirmSkin(showcaseSkin)}
                        >
                          {diamonds >= Number(showcaseSkin.priceDiamonds)
                            ? `BELI SKIN (${showcaseSkin.priceDiamonds} 💎)`
                            : 'Diamonds Kurang'}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => onOpenAuth?.()}
                        >
                          Login untuk Beli
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="mp-toolbar card">
                <div className="skin-filter-pills">
                  {[
                    { id: 'all', label: `Semua (${skins.length})` },
                    { id: 'owned', label: `Dimiliki (${skins.filter(s => s.owned).length})` },
                    { id: 'Common', label: 'Common' },
                    { id: 'Rare', label: 'Rare' },
                    { id: 'Epic', label: 'Epic' },
                    { id: 'Legendary', label: 'Legendary' }
                  ].map(f => (
                    <button
                      key={f.id}
                      type="button"
                      className={`btn btn--sm ${skinFilter === f.id ? 'btn--primary' : 'btn--ghost'}`}
                      onClick={() => setSkinFilter(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>

                <input
                  type="search"
                  className="input input--sm mp-search"
                  placeholder="Cari skin bidak..."
                  value={skinQuery}
                  onChange={e => setSkinQuery(e.target.value)}
                  aria-label="Cari skin bidak Ludo"
                />
              </div>

              {visibleSkins.length === 0 ? (
                <div className="card mp-empty-state">
                  <p className="muted">Tidak ada skin yang cocok dengan filter ini.</p>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => {
                      setSkinFilter('all');
                      setSkinQuery('');
                    }}
                  >
                    Tampilkan Semua Skin
                  </button>
                </div>
              ) : (
                <ul className="mp-skin-grid">
                  {visibleSkins.map(skin => {
                    const isBusy = skinActionId === skin.id;
                    const canAfford = diamonds >= Number(skin.priceDiamonds);
                    const abilityLabel = LUDO_SKIN_META[resolveSkinKey(skin)]?.abilityLabel || null;
                    return (
                      <li
                        key={skin.id}
                        className={`mp-skin-card ${skin.equipped ? 'is-equipped' : ''} ${skin.owned ? 'is-owned' : ''}`}
                        style={{ '--skin-accent': skin.accentColor || '#38bdf8' }}
                        onMouseEnter={() => setInspectedSkinId(skin.id)}
                        onFocus={() => setInspectedSkinId(skin.id)}
                      >
                        <div className="mp-skin-card__visual">
                          <div className="mp-skin-card__badges">
                            <span className={`rarity-badge rarity-badge--${String(skin.rarity).toLowerCase()}`}>
                              {skin.rarity}
                            </span>
                            {abilityLabel && (
                              <span className="badge badge--ocean-ability">🌊 {abilityLabel}</span>
                            )}
                            {skin.equipped ? (
                              <span className="badge badge--success">✓ DIPAKAI</span>
                            ) : skin.owned ? (
                              <span className="badge badge--diamond">✓ OWNED</span>
                            ) : null}
                          </div>

                          <div className="mp-skin-card__medallion">
                            <LudoSkinPreview skin={skin} size={74} teamColor="blue" />
                          </div>

                          <div className="mp-skin-card__team-dots" aria-hidden="true">
                            <span className="mp-team-dot mp-team-dot--red" />
                            <span className="mp-team-dot mp-team-dot--blue" />
                            <span className="mp-team-dot mp-team-dot--green" />
                            <span className="mp-team-dot mp-team-dot--yellow" />
                          </div>
                        </div>

                        <div className="mp-skin-card__body">
                          <h3 className="mp-skin-card__title">{skin.name}</h3>
                          <p className="mp-skin-card__desc">{skin.description}</p>
                        </div>

                        <div className="mp-skin-card__foot">
                          <div className="skin-card__price">
                            <Icon name="diamond" size={15} /> <strong>{skin.priceDiamonds}</strong> Diamonds
                          </div>

                          <div className="mp-skin-card__cta">
                            {skin.owned ? (
                              skin.equipped ? (
                                <button
                                  type="button"
                                  className="btn btn--secondary btn--sm btn--block"
                                  disabled={isBusy}
                                  onClick={() => handleEquipSkin(null)}
                                >
                                  {isBusy ? '...' : 'TERPASANG (Lepas)'}
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="btn btn--primary btn--sm btn--block"
                                  disabled={isBusy}
                                  onClick={() => handleEquipSkin(skin.id)}
                                >
                                  {isBusy ? 'Memasang...' : 'PASANG SKIN'}
                                </button>
                              )
                            ) : !currentUser ? (
                              <button
                                type="button"
                                className="btn btn--secondary btn--sm btn--block"
                                onClick={() => onOpenAuth?.()}
                              >
                                Login untuk Beli
                              </button>
                            ) : (
                              <button
                                type="button"
                                className={`btn btn--sm btn--block ${canAfford ? 'btn--primary' : 'btn--secondary'}`}
                                disabled={!canAfford || isBusy}
                                onClick={() => {
                                  sound.playClick();
                                  setConfirmSkin(skin);
                                }}
                              >
                                {canAfford ? `BELI (${skin.priceDiamonds} 💎)` : 'Diamonds Kurang'}
                              </button>
                            )}
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}

              <Modal
                isOpen={!!confirmSkin}
                onClose={() => !skinActionId && setConfirmSkin(null)}
                size="sm"
                title="Konfirmasi Pembelian Skin"
                subtitle="Pastikan pilihan skin bidak JakLudo kamu sebelum membayar dengan Diamonds."
                footer={
                  confirmSkin && (
                    <>
                      <button
                        type="button"
                        className="btn btn--secondary"
                        disabled={!!skinActionId}
                        onClick={() => setConfirmSkin(null)}
                      >
                        Batal
                      </button>
                      <button
                        type="button"
                        className="btn btn--primary"
                        disabled={skinActionId === confirmSkin.id || diamonds < confirmSkin.priceDiamonds}
                        onClick={() => executeBuySkin(confirmSkin)}
                      >
                        {skinActionId === confirmSkin.id ? 'Memproses...' : `Beli Sekarang (${confirmSkin.priceDiamonds} 💎)`}
                      </button>
                    </>
                  )
                }
              >
                {confirmSkin && (
                  <div className="skin-confirm-box">
                    <div className="skin-confirm-preview">
                      <LudoSkinPreview skin={confirmSkin} size={64} teamColor="red" />
                      <LudoSkinPreview skin={confirmSkin} size={64} teamColor="blue" />
                      <LudoSkinPreview skin={confirmSkin} size={64} teamColor="green" />
                      <LudoSkinPreview skin={confirmSkin} size={64} teamColor="yellow" />
                    </div>
                    <div className="skin-confirm-details">
                      <strong>{confirmSkin.name}</strong>
                      <span className={`rarity-badge rarity-badge--${String(confirmSkin.rarity).toLowerCase()}`}>
                        {confirmSkin.rarity}
                      </span>
                      <div className="skin-confirm-math">
                        <div><span>Harga Skin</span><strong>{confirmSkin.priceDiamonds} Diamonds</strong></div>
                        <div><span>Saldo Saat Ini</span><strong>{diamonds} Diamonds</strong></div>
                        <div><span>Sisa Setelah Beli</span><strong>{Math.max(0, diamonds - confirmSkin.priceDiamonds)} Diamonds</strong></div>
                      </div>
                    </div>
                  </div>
                )}
              </Modal>
            </section>
          )}

          {/* ================= TAB 2: TOP-UP DIAMONDS (konversi ke Coins sudah ditutup) ================= */}
          {activeTab === 'diamonds' && (
            <div className="mp-section">
              {/* 2. Top-Up Diamonds via Payment Gateway */}
              <UnifiedTopupSection
                mode="diamonds"
                packages={diamondPackages}
                selectedPkg={selectedPkg}
                onSelectPkg={setSelectedPkgId}
                methods={duitkuMethods}
                selectedMethodCode={paymentMethod}
                onSelectMethod={setPaymentMethod}
                selectedMethodObj={selectedMethodObj}
                activePayment={activePayment}
                verifyingPayment={verifyingPayment}
                checkingOrderId={checkingOrderId}
                copiedField={copiedField}
                onCopy={copyToClipboard}
                onCheckStatus={verifyDiamondOrder}
                onCancelOrder={cancelDiamondOrder}
                onBackPayment={() => setActivePayment(null)}
                currentUser={currentUser}
                onOpenAuth={onOpenAuth}
                submitting={Boolean(selectedPkg && creatingOrderPkgId === selectedPkg.id)}
                onSubmitTopup={handleCreateDiamondTopup}
              />

              {/* 3. Riwayat Order Pembayaran Top-Up (Diamonds & Coins) */}
              {currentUser && (
                <UnifiedOrderHistoryPanel
                  orders={combinedPaymentOrders}
                  checkingOrderId={checkingOrderId}
                  onOpenInstruction={openOrderInstruction}
                  onVerifyOrder={verifyOrderFromHistory}
                  onCancelOrder={cancelOrderFromHistory}
                />
              )}
            </div>
          )}

          {/* ================= TAB 3: ITEM GAME ================= */}
          {activeTab === 'items' && (
            <section className="mp-section" aria-label="Item Game">
              <div className="mp-toolbar card">
                <div className="skin-filter-pills">
                  {[
                    { id: 'all', label: `Semua (${catalogItems.length})` },
                    { id: 'ludo', label: `JakLudo (${ludoItems.length})` },
                    { id: 'quiz', label: `Monster Quiz (${quizItems.length})` },
                    { id: 'chess', label: `Chess Master (${chessItems.length})` }
                  ].map(f => (
                    <button
                      key={f.id}
                      type="button"
                      className={`btn btn--sm ${legacyCategory === f.id ? 'btn--primary' : 'btn--ghost'}`}
                      onClick={() => setLegacyCategory(f.id)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              </div>

              {legacyGroups.map(group => (
                <section key={group.key} className="card mp-section-card">
                  <div className={`shop__group-header ${group.key === 'quiz' ? 'shop__group-header--quiz' : ''}`}>
                    <div>
                      <h3 className="shop__group-title">
                        <Icon name={group.icon} size={18} />
                        <span>{group.name}</span>
                      </h3>
                      <p className="shop__group-desc">{group.desc}</p>
                    </div>
                    <span className="badge badge--brand">{group.badge}</span>
                  </div>
                  <ul className="mp-pkg-grid">
                    {group.items.map(item => (
                      <LegacyShopItemCard
                        key={item.id}
                        item={item}
                        points={points}
                        ownedCount={ownedItems[item.id] || 0}
                        currentUser={currentUser}
                        buyingId={buyingLegacyId}
                        onBuy={buyLegacyItem}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </section>
          )}

          {/* ================= TAB 4: COINS TOP-UP ================= */}
          {activeTab === 'coins' && (
            <section className="mp-section" aria-label="Top Up Coins">
              <UnifiedTopupSection
                mode="coins"
                packages={legacyPackages}
                selectedPkg={selectedCoinPkg}
                onSelectPkg={setSelectedCoinPkgId}
                methods={duitkuMethods}
                selectedMethodCode={paymentMethod}
                onSelectMethod={setPaymentMethod}
                selectedMethodObj={selectedMethodObj}
                activePayment={activePayment}
                verifyingPayment={verifyingPayment}
                checkingOrderId={checkingOrderId}
                copiedField={copiedField}
                onCopy={copyToClipboard}
                onCheckStatus={verifyLegacyCoinsOrder}
                onCancelOrder={cancelLegacyCoinsOrder}
                onBackPayment={() => setActivePayment(null)}
                currentUser={currentUser}
                onOpenAuth={onOpenAuth}
                submitting={Boolean(selectedCoinPkg && topupLegacyId === selectedCoinPkg.id)}
                onSubmitTopup={handleLegacyTopup}
              />

              {currentUser && (
                <UnifiedOrderHistoryPanel
                  orders={combinedPaymentOrders}
                  checkingOrderId={checkingOrderId}
                  onOpenInstruction={openOrderInstruction}
                  onVerifyOrder={verifyOrderFromHistory}
                  onCancelOrder={cancelOrderFromHistory}
                />
              )}
            </section>
          )}

          {/* ================= TAB 4: WALLET & IMMUTABLE TRANSACTIONS ================= */}
          {activeTab === 'wallet' && (
            <section className="mp-section" aria-label="Dompet Diamond dan Riwayat Transaksi">
              {!currentUser ? (
                <div className="card mp-empty-state">
                  <p className="muted">Silakan login untuk melihat detail dompet dan riwayat transaksi Diamonds kamu.</p>
                  {onOpenAuth && (
                    <button type="button" className="btn btn--primary btn--sm" onClick={onOpenAuth}>
                      Masuk Sekarang
                    </button>
                  )}
                </div>
              ) : (
                <>
                  <div className="wallet-kpi-grid">
                    <div className="wallet-kpi card">
                      <span className="muted">Saldo Diamonds</span>
                      <strong>{diamonds.toLocaleString('id-ID')} 💎</strong>
                    </div>
                    <div className="wallet-kpi card">
                      <span className="muted">Total Top-Up</span>
                      <strong>{Number(wallet?.totalPurchased || 0).toLocaleString('id-ID')} 💎</strong>
                    </div>
                    <div className="wallet-kpi card">
                      <span className="muted">Hasil Konversi Coins</span>
                      <strong>{Number(wallet?.totalConverted || 0).toLocaleString('id-ID')} 💎</strong>
                    </div>
                    <div className="wallet-kpi card">
                      <span className="muted">Total Terpakai</span>
                      <strong>{Number(wallet?.totalSpent || 0).toLocaleString('id-ID')} 💎</strong>
                    </div>
                  </div>

                  {/* Kartu Program Kode Referral */}
                  {currentUser?.referralCode && (
                    <div className="card mp-section-card" style={{ marginBottom: 'var(--space-4)' }}>
                      <div className="section-head">
                        <div>
                          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <Icon name="crown" size={18} />
                            <span>Program Kode Referral</span>
                            <span className="badge badge--success">+50 Coins / Pendaftar</span>
                          </h3>
                          <p className="muted" style={{ margin: '4px 0 0', fontSize: 'var(--fs-xs)' }}>
                            Ajak teman bermain di PlayGo! Setiap pemain baru yang mendaftar menggunakan kodemu akan memberimu hadiah 50 Coins secara instan.
                          </p>
                        </div>
                      </div>
                      <div className="wallet-kpi-grid" style={{ marginTop: 'var(--space-3)' }}>
                        <div className="wallet-kpi card">
                          <span className="muted">Kode Referral Kamu</span>
                          <strong style={{ letterSpacing: '1px', color: 'var(--color-primary)' }}>{currentUser.referralCode}</strong>
                        </div>
                        <div className="wallet-kpi card">
                          <span className="muted">Teman Berhasil Diajak</span>
                          <strong>{currentUser.referralCount || 0} Orang</strong>
                        </div>
                        <div className="wallet-kpi card">
                          <span className="muted">Total Hadiah Referral</span>
                          <strong>+{(currentUser.referralBonusCoins || 0).toLocaleString('id-ID')} Coins</strong>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 'var(--space-2)', marginTop: 'var(--space-3)', flexWrap: 'wrap' }}>
                        <button
                          type="button"
                          className="btn btn--secondary btn--sm"
                          onClick={() => {
                            navigator.clipboard?.writeText(currentUser.referralCode);
                            setFeedback({ type: 'success', message: `Kode referral "${currentUser.referralCode}" berhasil disalin!` });
                          }}
                        >
                          Salin Kode ({currentUser.referralCode})
                        </button>
                        <button
                          type="button"
                          className="btn btn--primary btn--sm"
                          onClick={() => {
                            const link = `${window.location.origin}/?ref=${encodeURIComponent(currentUser.referralCode)}`;
                            navigator.clipboard?.writeText(link);
                            setFeedback({ type: 'success', message: 'Link pendaftaran referral berhasil disalin ke clipboard!' });
                          }}
                        >
                          Salin Link Undangan 🔗
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="card mp-section-card">
                    <div className="section-head">
                      <h3>Riwayat Transaksi Diamonds</h3>
                      <select
                        className="input input--sm"
                        value={txTypeFilter}
                        onChange={e => setTxTypeFilter(e.target.value)}
                        aria-label="Filter tipe transaksi"
                      >
                        <option value="">Semua Transaksi</option>
                        <option value="TOPUP">Top-Up Diamonds</option>
                        <option value="CONVERSION">Konversi 💎 ↔ 🪙</option>
                        <option value="SKIN_PURCHASE">Beli Skin Ludo</option>
                        <option value="REFUND">Refund</option>
                        <option value="ADMIN_ADJUSTMENT">Penyesuaian Admin</option>
                      </select>
                    </div>

                    {transactions.length === 0 ? (
                      <p className="muted">Belum ada transaksi Diamonds.</p>
                    ) : (
                      <div className="tx-table-wrap">
                        <table className="tx-table">
                          <thead>
                            <tr>
                              <th>Waktu</th>
                              <th>Tipe</th>
                              <th>Jumlah</th>
                              <th>Saldo (Sebelum → Sesudah)</th>
                              <th>Keterangan</th>
                            </tr>
                          </thead>
                          <tbody>
                            {transactions.map(tx => {
                              const meta = txTypeLabel(tx.txType);
                              return (
                                <tr key={tx.id}>
                                  <td>{formatDateTime(tx.createdAt)}</td>
                                  <td><span className={`badge badge--${meta.tone}`}>{meta.label}</span></td>
                                  <td className={tx.amount >= 0 ? 'tx-plus' : 'tx-minus'}>
                                    {tx.amount >= 0 ? `+${tx.amount}` : tx.amount} 💎
                                  </td>
                                  <td>{tx.previousBalance} → <strong>{tx.newBalance}</strong></td>
                                  <td>
                                    <div>{tx.description}</div>
                                    {tx.referenceId && <span className="muted code-text">Ref: {tx.referenceId}</span>}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                </>
              )}
            </section>
          )}

          {/* ================= TAB 5: ADMIN ECONOMY DASHBOARD ================= */}
          {activeTab === 'admin' && isAdmin && (
            <section className="mp-section" aria-label="Dashboard Admin Ekonomi">
              <div className="mp-toolbar card">
                <div className="admin-subtabs">
                  {[
                    { id: 'config', label: '⚙️ Kurs Konversi' },
                    { id: 'packages', label: '📦 Paket Top-Up' },
                    { id: 'skins', label: '🎨 Kelola Skin' },
                    { id: 'adjust', label: '💎 Penyesuaian Saldo' },
                    { id: 'logs', label: '📋 Riwayat & Log Pembayaran' }
                  ].map(s => (
                    <button
                      key={s.id}
                      type="button"
                      className={`btn btn--sm ${adminSubTab === s.id ? 'btn--primary' : 'btn--secondary'}`}
                      onClick={() => setAdminSubTab(s.id)}
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <button type="button" className="btn btn--ghost btn--sm" onClick={loadAdminOverview} disabled={adminLoading}>
                  {adminLoading ? 'Memuat...' : 'Refresh'}
                </button>
              </div>

              {adminOverview?.summary && (
                <div className="wallet-kpi-grid">
                  <div className="wallet-kpi card">
                    <span className="muted">Diamonds Beredar</span>
                    <strong>{adminOverview.summary.totalDiamondsCirculating.toLocaleString('id-ID')} 💎</strong>
                  </div>
                  <div className="wallet-kpi card">
                    <span className="muted">Order Top-Up Lunas</span>
                    <strong>{adminOverview.summary.totalPaidOrders} Order</strong>
                  </div>
                  <div className="wallet-kpi card">
                    <span className="muted">Total Revenue Top-Up</span>
                    <strong>{formatIdr(adminOverview.summary.totalRevenueIdr)}</strong>
                  </div>
                  <div className="wallet-kpi card">
                    <span className="muted">Skin Terjual / Konversi</span>
                    <strong>{adminOverview.summary.totalSkinsSold} Skin · {adminOverview.summary.totalConversions} Konv</strong>
                  </div>
                </div>
              )}

              {adminSubTab === 'config' && (
                <form className="card admin-econ-form" onSubmit={saveAdminSettings}>
                  <h3>Pengaturan Kurs Diamonds ↔ Coins</h3>
                  <p className="muted">
                    Konversi Diamonds → Coins sudah ditutup untuk pemain (ditolak server). Kurs di bawah hanya
                    berlaku untuk penukaran Coins → Diamonds lewat API.
                  </p>
                  <div className="admin-form-grid">
                    <label>
                      <span>Coins per 1 Diamond</span>
                      <input
                        type="number"
                        className="input"
                        min={1}
                        value={adminSettingsForm.coinsPerDiamond}
                        onChange={e => setAdminSettingsForm(f => ({ ...f, coinsPerDiamond: e.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Minimum Konversi (Diamonds)</span>
                      <input
                        type="number"
                        className="input"
                        min={1}
                        value={adminSettingsForm.minConvertDiamonds}
                        onChange={e => setAdminSettingsForm(f => ({ ...f, minConvertDiamonds: e.target.value }))}
                      />
                    </label>
                    <label>
                      <span>Maksimum Konversi (Diamonds)</span>
                      <input
                        type="number"
                        className="input"
                        min={1}
                        value={adminSettingsForm.maxConvertDiamonds}
                        onChange={e => setAdminSettingsForm(f => ({ ...f, maxConvertDiamonds: e.target.value }))}
                      />
                    </label>
                    <label className="admin-checkbox-label">
                      <input
                        type="checkbox"
                        checked={Boolean(adminSettingsForm.conversionEnabled)}
                        onChange={e => setAdminSettingsForm(f => ({ ...f, conversionEnabled: e.target.checked }))}
                      />
                      <span>Aktifkan Fitur Konversi</span>
                    </label>
                  </div>
                  <button type="submit" className="btn btn--primary">Simpan Pengaturan</button>
                </form>
              )}

              {adminSubTab === 'packages' && (
                <div className="mp-section">
                  <form className="card admin-econ-form" onSubmit={saveAdminPackage}>
                    <h3>{adminPkgForm.id ? `Edit Paket (${adminPkgForm.id})` : 'Tambah Paket Diamond Baru'}</h3>
                    <div className="admin-form-grid">
                      <label>
                        <span>Nama Paket</span>
                        <input className="input" value={adminPkgForm.name} onChange={e => setAdminPkgForm(f => ({ ...f, name: e.target.value }))} required />
                      </label>
                      <label>
                        <span>Diamonds</span>
                        <input type="number" className="input" min={1} value={adminPkgForm.diamonds} onChange={e => setAdminPkgForm(f => ({ ...f, diamonds: e.target.value }))} required />
                      </label>
                      <label>
                        <span>Bonus Diamonds</span>
                        <input type="number" className="input" min={0} value={adminPkgForm.bonusDiamonds} onChange={e => setAdminPkgForm(f => ({ ...f, bonusDiamonds: e.target.value }))} />
                      </label>
                      <label>
                        <span>Harga (IDR)</span>
                        <input type="number" className="input" min={1000} value={adminPkgForm.priceIdr} onChange={e => setAdminPkgForm(f => ({ ...f, priceIdr: e.target.value }))} required />
                      </label>
                      <label>
                        <span>Badge Promo</span>
                        <input className="input" value={adminPkgForm.badge} onChange={e => setAdminPkgForm(f => ({ ...f, badge: e.target.value }))} />
                      </label>
                      <label className="admin-checkbox-label">
                        <input type="checkbox" checked={Boolean(adminPkgForm.isActive)} onChange={e => setAdminPkgForm(f => ({ ...f, isActive: e.target.checked }))} />
                        <span>Aktif Dijual</span>
                      </label>
                    </div>
                    <div className="admin-form-actions">
                      <button type="submit" className="btn btn--primary">Simpan Paket</button>
                      {adminPkgForm.id && (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => setAdminPkgForm({ id: '', name: '', diamonds: 10, bonusDiamonds: 0, priceIdr: 5000, badge: '', sortOrder: 5, isActive: true })}
                        >
                          Mode Tambah Baru
                        </button>
                      )}
                    </div>
                  </form>

                  <div className="card tx-table-wrap">
                    <table className="tx-table">
                      <thead>
                        <tr><th>Paket</th><th>Diamonds</th><th>Harga IDR</th><th>Status</th><th>Aksi</th></tr>
                      </thead>
                      <tbody>
                        {(adminOverview?.packages || []).map(p => (
                          <tr key={p.id}>
                            <td><strong>{p.name}</strong> {p.badge && <span className="badge">{p.badge}</span>}</td>
                            <td>{p.diamonds}{p.bonusDiamonds > 0 ? ` (+${p.bonusDiamonds})` : ''} 💎</td>
                            <td>{formatIdr(p.priceIdr)}</td>
                            <td><span className={`badge ${p.isActive ? 'badge--success' : ''}`}>{p.isActive ? 'Aktif' : 'Nonaktif'}</span></td>
                            <td>
                              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAdminPkgForm({ ...p })}>
                                Edit
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {adminSubTab === 'skins' && (
                <div className="mp-section">
                  <form className="card admin-econ-form" onSubmit={saveAdminSkin}>
                    <h3>{adminSkinForm.id ? `Edit Skin (${adminSkinForm.id})` : 'Tambah Skin Bidak Ludo Baru'}</h3>
                    <div className="admin-form-grid">
                      <label>
                        <span>Nama Skin</span>
                        <input className="input" value={adminSkinForm.name} onChange={e => setAdminSkinForm(f => ({ ...f, name: e.target.value }))} required />
                      </label>
                      <label>
                        <span>Harga (10–50 Diamonds)</span>
                        <input type="number" className="input" min={10} max={50} value={adminSkinForm.priceDiamonds} onChange={e => setAdminSkinForm(f => ({ ...f, priceDiamonds: e.target.value }))} required />
                      </label>
                      <label>
                        <span>Rarity</span>
                        <select className="input" value={adminSkinForm.rarity} onChange={e => setAdminSkinForm(f => ({ ...f, rarity: e.target.value }))}>
                          <option value="Common">Common</option>
                          <option value="Rare">Rare</option>
                          <option value="Epic">Epic</option>
                          <option value="Legendary">Legendary</option>
                        </select>
                      </label>
                      <label>
                        <span>Template Visual</span>
                        <select className="input" value={adminSkinForm.assetKey} onChange={e => setAdminSkinForm(f => ({ ...f, assetKey: e.target.value }))}>
                          <option value="classic_gold">Classic Gold</option>
                          <option value="ruby_crystal">Ruby Crystal</option>
                          <option value="ocean_blue">Ocean Blue</option>
                          <option value="emerald_green">Emerald Green</option>
                          <option value="galaxy_purple">Galaxy Purple</option>
                          <option value="fire_phoenix">Fire Phoenix</option>
                          <option value="legendary_diamond">Legendary Diamond</option>
                        </select>
                      </label>
                      <label>
                        <span>Deskripsi</span>
                        <input className="input" value={adminSkinForm.description} onChange={e => setAdminSkinForm(f => ({ ...f, description: e.target.value }))} />
                      </label>
                      <label className="admin-checkbox-label">
                        <input type="checkbox" checked={Boolean(adminSkinForm.isActive)} onChange={e => setAdminSkinForm(f => ({ ...f, isActive: e.target.checked }))} />
                        <span>Aktif di Shop</span>
                      </label>
                    </div>
                    <div className="admin-form-actions">
                      <button type="submit" className="btn btn--primary">Simpan Skin</button>
                      {adminSkinForm.id && (
                        <button
                          type="button"
                          className="btn btn--ghost"
                          onClick={() => setAdminSkinForm({ id: '', name: '', description: '', priceDiamonds: 25, rarity: 'Rare', assetKey: 'classic_gold', accentColor: '#38bdf8', sortOrder: 8, isActive: true })}
                        >
                          Mode Tambah Baru
                        </button>
                      )}
                    </div>
                  </form>

                  <div className="card tx-table-wrap">
                    <table className="tx-table">
                      <thead>
                        <tr><th>Skin</th><th>Rarity</th><th>Harga</th><th>Status</th><th>Aksi</th></tr>
                      </thead>
                      <tbody>
                        {(adminOverview?.skins || []).map(s => (
                          <tr key={s.id}>
                            <td><strong>{s.name}</strong></td>
                            <td>{s.rarity}</td>
                            <td>{s.priceDiamonds} 💎</td>
                            <td><span className={`badge ${s.isActive ? 'badge--success' : ''}`}>{s.isActive ? 'Aktif' : 'Nonaktif'}</span></td>
                            <td>
                              <button type="button" className="btn btn--secondary btn--sm" onClick={() => setAdminSkinForm({ ...s })}>
                                Edit
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {adminSubTab === 'adjust' && (
                <form className="card admin-econ-form" onSubmit={submitAdminAdjustment}>
                  <h3>Penyesuaian / Refund Saldo Diamonds Pemain</h3>
                  <div className="admin-form-grid">
                    <label>
                      <span>Username atau User ID Pemain</span>
                      <input className="input" placeholder="contoh: alice" value={adminAdjustForm.userId} onChange={e => setAdminAdjustForm(f => ({ ...f, userId: e.target.value }))} required />
                    </label>
                    <label>
                      <span>Tipe Transaksi</span>
                      <select className="input" value={adminAdjustForm.txType} onChange={e => setAdminAdjustForm(f => ({ ...f, txType: e.target.value }))}>
                        <option value="ADMIN_ADJUSTMENT">Penyesuaian Saldo (+ / -)</option>
                        <option value="REFUND">Refund (+)</option>
                      </select>
                    </label>
                    <label>
                      <span>Jumlah Diamonds (+ tambah / - kurang)</span>
                      <input type="number" className="input" value={adminAdjustForm.amount} onChange={e => setAdminAdjustForm(f => ({ ...f, amount: e.target.value }))} required />
                    </label>
                    <label>
                      <span>Alasan Audit (Wajib)</span>
                      <input className="input" placeholder="Alasan penyesuaian saldo" value={adminAdjustForm.reason} onChange={e => setAdminAdjustForm(f => ({ ...f, reason: e.target.value }))} required />
                    </label>
                  </div>
                  <button type="submit" className="btn btn--primary">Eksekusi Penyesuaian Saldo</button>
                </form>
              )}

              {adminSubTab === 'logs' && (
                <div className="mp-section">
                  <div className="card tx-table-wrap">
                    <h4>Transaksi Diamonds Terbaru</h4>
                    <table className="tx-table">
                      <thead>
                        <tr><th>Waktu</th><th>Pemain</th><th>Tipe</th><th>Jumlah</th><th>Keterangan</th></tr>
                      </thead>
                      <tbody>
                        {(adminOverview?.transactions || []).slice(0, 25).map(t => (
                          <tr key={t.id}>
                            <td>{formatDateTime(t.createdAt)}</td>
                            <td>{t.username}</td>
                            <td>{t.txType}</td>
                            <td className={t.amount >= 0 ? 'tx-plus' : 'tx-minus'}>{t.amount >= 0 ? `+${t.amount}` : t.amount} 💎</td>
                            <td>{t.description}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="card tx-table-wrap">
                    <h4>Log Notifikasi Pembayaran</h4>
                    <table className="tx-table">
                      <thead>
                        <tr><th>Waktu</th><th>Order ID</th><th>Sig Valid</th><th>Result</th><th>Status Proses</th></tr>
                      </thead>
                      <tbody>
                        {(adminOverview?.callbackLogs || []).slice(0, 20).map(l => (
                          <tr key={l.id}>
                            <td>{formatDateTime(l.createdAt)}</td>
                            <td className="code-text">{l.orderId || '-'}</td>
                            <td>{l.signatureValid ? '✅ Valid' : '❌ Ditolak'}</td>
                            <td>{l.resultCode || '-'}</td>
                            <td>{l.processingStatus} — <span className="muted">{l.notes}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>
    </main>
  );
}

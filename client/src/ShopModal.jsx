import React, { useEffect, useState, useRef } from 'react';
import Modal from './components/Modal';
import Icon from './components/Icon';
import { sound } from './sound';
import { storage } from './storage';
import { useItemCatalogState } from './items';

const KIND_LABELS = {
  active: 'Dipakai manual saat bertanding',
  passive: 'Bekerja otomatis',
  reactive: 'Muncul pilihan saat dibutuhkan'
};

const DEFAULT_DIAMOND_PACKAGES = [
  {
    id: 'diamond_50',
    name: '50 Diamond',
    diamonds: 50,
    price: 5000,
    formattedPrice: 'Rp 5.000',
    subtitle: 'Paket pemula',
    description: 'Paket pemula',
    badge: null,
    icon: 'diamond'
  },
  {
    id: 'diamond_120',
    name: '120 Diamond',
    diamonds: 120,
    price: 10000,
    formattedPrice: 'Rp 10.000',
    subtitle: 'Paket hemat',
    description: 'Paket hemat',
    badge: 'Populer',
    icon: 'diamond'
  },
  {
    id: 'diamond_260',
    name: '260 Diamond',
    diamonds: 260,
    price: 20000,
    formattedPrice: 'Rp 20.000',
    subtitle: 'Paket reguler',
    description: 'Paket reguler',
    badge: null,
    icon: 'diamond'
  },
  {
    id: 'diamond_700',
    name: '700 Diamond',
    diamonds: 700,
    price: 50000,
    formattedPrice: 'Rp 50.000',
    subtitle: 'Paket premium',
    description: 'Paket premium',
    badge: 'Bonus 100',
    icon: 'diamond'
  },
  {
    id: 'diamond_1500',
    name: '1.500 Diamond',
    diamonds: 1500,
    price: 100000,
    formattedPrice: 'Rp 100.000',
    subtitle: 'Paket besar',
    description: 'Paket besar',
    badge: 'Bonus 250',
    icon: 'crown'
  },
  {
    id: 'diamond_3250',
    name: '3.250 Diamond',
    diamonds: 3250,
    price: 200000,
    formattedPrice: 'Rp 200.000',
    subtitle: 'Paket sultan',
    description: 'Paket sultan',
    badge: 'Bonus 750',
    icon: 'crown'
  }
];

const DEFAULT_PAYMENT_METHODS = [
  {
    id: 'qris',
    name: 'QRIS (Semua E-Wallet & M-Banking)',
    description: 'Scan langsung via GoPay, OVO, DANA, ShopeePay, BCA Mobile, Livin, dll.',
    icon: 'qr',
    badge: 'Instan'
  },
  {
    id: 'bca_va',
    name: 'BCA Virtual Account',
    description: 'Transfer 24 jam via BCA Mobile, myBCA, KlikBCA, atau ATM BCA.',
    icon: 'bank',
    badge: 'Populer'
  },
  {
    id: 'mandiri_va',
    name: 'Mandiri Virtual Account',
    description: 'Transfer via Livin by Mandiri atau ATM Mandiri.',
    icon: 'bank'
  },
  {
    id: 'bni_va',
    name: 'BNI Virtual Account',
    description: 'Transfer via BNI Mobile Banking, Internet Banking, atau ATM BNI.',
    icon: 'bank'
  },
  {
    id: 'bri_va',
    name: 'BRI Virtual Account (BRIVA)',
    description: 'Transfer via BRImo, Internet Banking BRI, atau ATM BRI.',
    icon: 'bank'
  },
  {
    id: 'permata_va',
    name: 'Permata Virtual Account',
    description: 'Transfer via PermataMobile X atau ATM Bersama / ALTO / Prima.',
    icon: 'bank'
  },
  {
    id: 'doku_va',
    name: 'Doku Virtual Account (Bank Lain)',
    description: 'Transfer dari bank lain via ATM Bersama, Prima, atau ALTO.',
    icon: 'bank'
  },
  {
    id: 'doku_checkout',
    name: 'Doku Checkout (Semua Metode)',
    description: 'Buka halaman resmi Doku lengkap dengan Kartu Kredit & E-Wallet.',
    icon: 'card'
  }
];

function ShopItemCard({ item, points, ownedCount, currentUser, buyingId, onBuy }) {
  const affordable = points >= item.price;
  const isQuizItem = item.game === 'quiz';
  return (
    <li className="shop-item card">
      <div className="shop-item__head">
        <span className="shop-item__icon" aria-hidden="true">
          <Icon name={item.icon || item.id} size={26} />
        </span>
        <div>
          <div className="shop-item__title-row">
            <h3>{item.name}</h3>
            <span className={`badge ${isQuizItem ? 'badge--info' : 'badge--brand'}`}>
              {isQuizItem ? 'Monster Quiz Battle' : 'JakLudo'}
            </span>
          </div>
          <p className="muted">
            {isQuizItem ? 'Dipakai saat menjawab soal (50:50)' : KIND_LABELS[item.kind] || 'Bekerja otomatis'} · dimiliki {ownedCount}
          </p>
        </div>
      </div>
      <p className="shop-item__desc">{item.description}</p>
      {item.highlight && <p className="shop-item__note">{item.highlight}</p>}
      <div className="shop-item__buy">
        <span className="shop-item__price">
          <Icon name="diamond" size={16} /> {item.price} poin
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!currentUser || !affordable || buyingId === item.id}
          onClick={() => onBuy(item)}
        >
          {buyingId === item.id ? 'Membeli...' : !currentUser ? 'Masuk dulu' : affordable ? `Beli ${item.name}` : 'Poin kurang'}
        </button>
      </div>
    </li>
  );
}

function TopupPackageCard({ pkg, currentUser, onSelectPackage }) {
  const isSultan = pkg.id === 'diamond_3250';
  const isPopular = pkg.id === 'diamond_120' || pkg.badge === 'Populer';
  const isBonus = Boolean(pkg.badge && pkg.badge.startsWith('Bonus'));
  const badgeClass = isSultan ? 'badge--sultan' : isBonus ? 'badge--bonus' : isPopular ? 'badge--popular' : 'badge--info';

  return (
    <li className={`shop-item card shop-item--topup ${isPopular ? 'shop-item--topup-popular' : ''}`}>
      <div className="shop-item__head">
        <span className="shop-item__icon" aria-hidden="true" style={{ color: isSultan ? '#f59e0b' : '#8b5cf6' }}>
          <Icon name={pkg.icon || 'diamond'} size={28} />
        </span>
        <div>
          <div className="shop-item__title-row">
            <h3>{pkg.name}</h3>
            {pkg.badge && <span className={`badge ${badgeClass}`}>{pkg.badge}</span>}
          </div>
          <p className="muted">{pkg.subtitle || pkg.description || 'Doku Payment'}</p>
        </div>
      </div>
      <div className="shop-item__buy">
        <div className="topup-card__price">
          {pkg.formattedPrice}
        </div>
        <button
          type="button"
          className={`btn ${isPopular || isSultan ? 'btn--primary' : 'btn--secondary'}`}
          disabled={!currentUser}
          onClick={() => onSelectPackage(pkg)}
        >
          {!currentUser ? 'Masuk dulu' : `Beli (${pkg.formattedPrice})`}
        </button>
      </div>
    </li>
  );
}

export default function ShopModal({
  isOpen,
  onClose,
  asPage = false,
  currentUser,
  onUpdateUser,
  authToken,
  initialGame = 'all'
}) {
  const [buying, setBuying] = useState(null);
  const [topupLoading, setTopupLoading] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(initialGame || 'all');
  const [diamondPackages, setDiamondPackages] = useState(DEFAULT_DIAMOND_PACKAGES);
  const [paymentMethods, setPaymentMethods] = useState(DEFAULT_PAYMENT_METHODS);

  // State untuk alur Midtrans Core API Checkout
  const [checkoutPackage, setCheckoutPackage] = useState(null);
  const [selectedMethodId, setSelectedMethodId] = useState('qris');
  const [activePayment, setActivePayment] = useState(null);
  const [copied, setCopied] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const catalog = useItemCatalogState();
  const pollingRef = useRef(null);

  useEffect(() => {
    if (isOpen && initialGame) {
      setSelectedCategory(initialGame);
    }
    if (!isOpen) {
      setCheckoutPackage(null);
      setActivePayment(null);
      setFeedback(null);
    }
  }, [isOpen, initialGame]);

  useEffect(() => {
    if (!isOpen) return;
    let active = true;
    fetch('/api/topup/config')
      .then(res => res.json())
      .then(data => {
        if (!active || !data.success) return;
        if (Array.isArray(data.packages) && data.packages.length > 0) {
          setDiamondPackages(data.packages);
        }
        if (Array.isArray(data.paymentMethods) && data.paymentMethods.length > 0) {
          setPaymentMethods(data.paymentMethods);
        }
      })
      .catch(() => {});
    return () => { active = false; };
  }, [isOpen]);

  const points = currentUser?.points ?? 0;
  const owned = currentUser?.inventory || {};

  const ludoItems = catalog.items.filter(it => it.game !== 'quiz');
  const quizItems = catalog.items.filter(it => it.game === 'quiz');

  const groups = [
    {
      key: 'ludo',
      name: 'JakLudo (Papan Ludo)',
      icon: 'dice',
      badge: `${ludoItems.length} Item`,
      desc: 'Item taktik & perlindungan bidak untuk pertandingan papan JakLudo.',
      items: ludoItems
    },
    {
      key: 'quiz',
      name: 'Monster Quiz Battle',
      icon: 'swords',
      badge: `${quizItems.length} Item`,
      desc: 'Item bantuan eliminasi jawaban (50:50) untuk duel kuis pengetahuan & matematika.',
      items: quizItems
    }
  ];

  const visibleGroups = selectedCategory === 'all'
    ? groups.filter(g => g.items.length > 0)
    : selectedCategory === 'topup'
      ? []
      : groups.filter(g => g.key === selectedCategory);

  const buy = async item => {
    setBuying(item.id);
    setFeedback(null);
    sound.playClick();
    try {
      const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken || storage.get('token')}` },
        body: JSON.stringify({ itemId: item.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || 'Pembelian gagal. Coba lagi.');
      sound.playShopPurchase();
      setFeedback({ type: 'success', message: `${item.name} berhasil dibeli. Sisa poin: ${data.user?.points ?? points - item.price}.` });
      if (data.user) onUpdateUser?.(data.user);
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setBuying(null);
    }
  };

  // Mulai alur checkout Midtrans Core API
  const handleSelectPackage = pkg => {
    if (!currentUser) {
      setFeedback({ type: 'error', message: 'Silakan login terlebih dahulu untuk melakukan top up diamonds.' });
      return;
    }
    sound.playClick();
    setCheckoutPackage(pkg);
    setSelectedMethodId('qris');
    setActivePayment(null);
    setFeedback(null);
  };

  // Eksekusi charge Midtrans Core API
  const handleChargePayment = async () => {
    if (!currentUser || !checkoutPackage) return;
    setTopupLoading(true);
    setFeedback(null);
    sound.playClick();
    const token = authToken || storage.get('token');

    try {
      const res = await fetch('/api/topup/charge', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
          packageId: checkoutPackage.id,
          methodId: selectedMethodId
        })
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Gagal membuat tagihan pembayaran Midtrans Core API.');
      }

      setActivePayment({
        ...data.payment,
        diamonds: checkoutPackage.diamonds,
        packageName: checkoutPackage.name
      });
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setTopupLoading(false);
    }
  };

  // Verifikasi status pembayaran Core API (Manual atau Polling)
  const verifyCurrentOrder = async (isManual = false) => {
    if (!activePayment?.orderId) return;
    if (isManual) setVerifying(true);
    const token = authToken || storage.get('token');

    try {
      const res = await fetch('/api/topup/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ orderId: activePayment.orderId })
      });

      const data = await res.json().catch(() => ({}));
      if (data?.status === 'success' && data.user) {
        sound.playShopPurchase();
        const diamondsAdded = activePayment.diamonds || checkoutPackage?.diamonds || 0;
        setFeedback({
          type: 'success',
          message: `Pembayaran berhasil! +${diamondsAdded} Diamonds telah ditambahkan ke akunmu.`
        });
        if (data.user) onUpdateUser?.(data.user);
        setActivePayment(null);
        setCheckoutPackage(null);
      } else if (isManual) {
        setFeedback({
          type: 'info',
          message: 'Pembayaran belum terdeteksi. Silakan selesaikan transaksi sesuai instruksi.'
        });
      }
    } catch (err) {
      if (isManual) {
        setFeedback({ type: 'error', message: err.message || 'Gagal mengecek status pembayaran.' });
      }
    } finally {
      if (isManual) setVerifying(false);
    }
  };

  // Realtime Polling saat layar pembayaran Core API sedang aktif
  useEffect(() => {
    if (!activePayment?.orderId) {
      if (pollingRef.current) clearInterval(pollingRef.current);
      return;
    }

    pollingRef.current = setInterval(() => {
      verifyCurrentOrder(false);
    }, 3000);

    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, [activePayment]);

  const copyToClipboard = async text => {
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
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {}
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      asPage={asPage}
      size="lg"
      icon="shop"
      title="Toko item"
      subtitle={currentUser ? `Saldo kamu: ${points.toLocaleString('id-ID')} Diamonds (Poin)` : 'Masuk dulu untuk membeli item atau top up.'}
    >
      {feedback && (
        <p className={`alert alert--${feedback.type === 'success' ? 'success' : feedback.type === 'info' ? 'info' : 'error'} shop__feedback`} role="alert">
          {feedback.message}
        </p>
      )}

      {/* ========================================================
          SUB-VIEW 1: LAYAR PEMBAYARAN AKTIF (CORE API RESULT)
         ======================================================== */}
      {activePayment && (
        <div className="topup-modal-view">
          <div className="topup-summary-box">
            <div>
              <strong>{activePayment.packageName || `${activePayment.diamonds} Diamonds`}</strong>
              <div className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                Order ID: <code style={{ userSelect: 'all' }}>{activePayment.orderId}</code>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 'var(--fs-lg)', fontWeight: 800, color: '#8b5cf6' }}>
                Rp {activePayment.grossAmount?.toLocaleString('id-ID')}
              </div>
              <span className="badge badge--popular">Menunggu Pembayaran</span>
            </div>
          </div>

          <div className="topup-pay-screen">
            {/* TAMPILAN 1A: DOKU CHECKOUT URL */}
            {activePayment.checkoutUrl && (
              <div className="topup-checkout-box" style={{ textAlign: 'center', padding: 'var(--space-4)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)' }}>
                <h4 style={{ margin: '0 0 var(--space-2)' }}>Halaman Pembayaran Doku Checkout Siap</h4>
                <p className="muted" style={{ margin: '0 0 var(--space-3)', maxWidth: 440, fontSize: 'var(--fs-sm)' }}>
                  Klik tombol di bawah untuk membuka halaman pembayaran Doku resmi yang aman. Anda dapat membayar dengan Kartu Kredit, E-Wallet, atau Bank.
                </p>
                <a
                  href={activePayment.checkoutUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn btn--primary"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: '8px', padding: '12px 24px', fontSize: 'var(--fs-md)', textDecoration: 'none' }}
                >
                  <span>Buka Halaman Pembayaran Doku ↗</span>
                </a>
              </div>
            )}

            {/* TAMPILAN 1B: QRIS */}
            {activePayment.qrCodeUrl && (
              <>
                <h4 style={{ margin: 0 }}>Scan QRIS untuk Menyelesaikan Pembayaran</h4>
                <div className="topup-qr-container">
                  <img
                    src={activePayment.qrCodeUrl}
                    alt="QRIS Doku PlayGo"
                    className="topup-qr-image"
                  />
                  <div style={{ fontWeight: 700, fontSize: 'var(--fs-sm)', color: '#333' }}>
                    NMID: PlayGo Indonesia (Doku)
                  </div>
                </div>
                <p className="muted" style={{ fontSize: 'var(--fs-sm)', margin: 0, maxWidth: 440 }}>
                  Buka aplikasi <strong>GoPay, OVO, DANA, ShopeePay, LinkAja, BCA Mobile, Livin by Mandiri</strong>, atau aplikasi perbankan apa pun yang mendukung QRIS, lalu arahkan kamera ke kode QR di atas.
                </p>
              </>
            )}

            {/* TAMPILAN 1C: VIRTUAL ACCOUNT (BCA, MANDIRI, BNI, BRI, PERMATA, DOKU) */}
            {activePayment.vaNumber && (
              <>
                <h4 style={{ margin: 0 }}>
                  Transfer ke {activePayment.bank?.toUpperCase()} Virtual Account
                </h4>
                <div className="topup-va-display">
                  <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>
                    Nomor Virtual Account ({activePayment.bank?.toUpperCase()}):
                  </span>
                  <span className="topup-va-number">{activePayment.vaNumber}</span>
                  <button
                    type="button"
                    className="btn btn--secondary topup-copy-btn"
                    onClick={() => copyToClipboard(activePayment.vaNumber)}
                  >
                    {copied ? '✓ Berhasil Disalin!' : '📋 Salin Nomor VA'}
                  </button>
                </div>
                <p className="muted" style={{ fontSize: 'var(--fs-xs)', margin: 0, maxWidth: 440 }}>
                  Total tagihan pas: <strong>Rp {activePayment.grossAmount?.toLocaleString('id-ID')}</strong>. Verifikasi otomatis 24 jam tanpa perlu upload bukti transfer.
                </p>
              </>
            )}

            {/* TAMPILAN 1C: MANDIRI BILL */}
            {activePayment.billKey && activePayment.billerCode && (
              <>
                <h4 style={{ margin: 0 }}>Pembayaran Mandiri Bill (Livin by Mandiri)</h4>
                <div className="topup-va-display">
                  <div>
                    <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Kode Perusahaan / Biller:</span>
                    <div style={{ fontSize: 'var(--fs-md)', fontWeight: 800 }}>{activePayment.billerCode}</div>
                  </div>
                  <div style={{ marginTop: 'var(--space-2)' }}>
                    <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Kode Bayar / Bill Key:</span>
                    <span className="topup-va-number">{activePayment.billKey}</span>
                  </div>
                  <button
                    type="button"
                    className="btn btn--secondary topup-copy-btn"
                    onClick={() => copyToClipboard(activePayment.billKey)}
                  >
                    {copied ? '✓ Berhasil Disalin!' : '📋 Salin Kode Bayar'}
                  </button>
                </div>
              </>
            )}

            {/* Indikator Realtime Auto-Polling */}
            <div className="topup-live-indicator">
              <span className="topup-live-dot" />
              <span>Memeriksa pembayaran otomatis... Diamonds akan langsung masuk saat lunas.</span>
            </div>

            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'center' }}>
              <button
                type="button"
                className="btn btn--primary"
                disabled={verifying}
                onClick={() => verifyCurrentOrder(true)}
              >
                {verifying ? 'Mengecek...' : '🔄 Cek Status Pembayaran'}
              </button>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => {
                  sound.playClick();
                  setActivePayment(null);
                }}
              >
                Ganti Metode / Batal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ========================================================
          SUB-VIEW 2: PILIH METODE PEMBAYARAN CORE API (CHECKOUT)
         ======================================================== */}
      {!activePayment && checkoutPackage && (
        <div className="topup-modal-view">
          <div className="topup-summary-box">
            <div>
              <span className="badge badge--brand">Pilihan Paket</span>
              <h3 style={{ margin: '4px 0 0' }}>{checkoutPackage.name}</h3>
              <p className="muted" style={{ margin: 0, fontSize: 'var(--fs-xs)' }}>
                +{checkoutPackage.diamonds} Diamonds (Poin PlayGo)
              </p>
            </div>
            <div style={{ textAlign: 'right' }}>
              <span className="muted" style={{ fontSize: 'var(--fs-xs)' }}>Total Bayar:</span>
              <div style={{ fontSize: 'var(--fs-xl)', fontWeight: 800, color: '#8b5cf6' }}>
                {checkoutPackage.formattedPrice}
              </div>
            </div>
          </div>

          <div>
            <h4 style={{ margin: '0 0 var(--space-2)' }}>Pilih Metode Pembayaran (Doku Payment Gateway):</h4>
            <div className="topup-methods-grid">
              {paymentMethods.map(m => {
                const isSelected = selectedMethodId === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    className={`topup-method-btn ${isSelected ? 'topup-method-btn--active' : ''}`}
                    onClick={() => {
                      sound.playClick();
                      setSelectedMethodId(m.id);
                    }}
                  >
                    <span style={{ fontSize: '1.4rem' }}>
                      {m.id === 'qris' ? '📱' : m.id === 'doku_checkout' ? '💳' : '🏦'}
                    </span>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <strong style={{ fontSize: 'var(--fs-sm)' }}>{m.name}</strong>
                        {m.badge && (
                          <span className={`badge ${m.badge === 'Instan' ? 'badge--success' : 'badge--popular'}`} style={{ fontSize: '10px' }}>
                            {m.badge}
                          </span>
                        )}
                      </div>
                      <div className="muted" style={{ fontSize: 'var(--fs-xs)', marginTop: '2px' }}>
                        {m.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
            <button
              type="button"
              className="btn btn--secondary"
              onClick={() => {
                sound.playClick();
                setCheckoutPackage(null);
              }}
            >
              ← Kembali ke Toko
            </button>
            <button
              type="button"
              className="btn btn--primary"
              disabled={topupLoading}
              onClick={handleChargePayment}
            >
              {topupLoading ? 'Memproses Tagihan...' : `Bayar Sekarang (${checkoutPackage.formattedPrice})`}
            </button>
          </div>
        </div>
      )}

      {/* ========================================================
          SUB-VIEW 3: KATALOG TOKO & DAFTAR PAKET TOPUP
         ======================================================== */}
      {!activePayment && !checkoutPackage && (
        <>
          {catalog.status === 'loading' && (
            <p className="state-msg" role="status"><span className="spinner" aria-hidden="true" /> Memuat item...</p>
          )}
          {catalog.status === 'error' && (
            <div className="state-msg" role="alert">
              <p>Daftar item gagal dimuat.</p>
              <button type="button" className="btn btn--secondary" onClick={catalog.retry}>Coba lagi</button>
            </div>
          )}
          {catalog.status === 'ready' && catalog.items.length === 0 && (
            <p className="state-msg">Belum ada item di toko.</p>
          )}

          {catalog.status === 'ready' && (
            <div className="tabs shop__filter-tabs" role="tablist" aria-label="Filter kategori toko">
              <button
                type="button"
                role="tab"
                aria-selected={selectedCategory === 'all'}
                className="tabs__tab"
                onClick={() => {
                  sound.playClick();
                  setSelectedCategory('all');
                }}
              >
                Semua ({catalog.items.length + diamondPackages.length})
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={selectedCategory === 'topup'}
                className="tabs__tab"
                onClick={() => {
                  sound.playClick();
                  setSelectedCategory('topup');
                }}
              >
                <Icon name="diamond" size={16} />
                <span>Top Up Diamonds</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={selectedCategory === 'ludo'}
                className="tabs__tab"
                onClick={() => {
                  sound.playClick();
                  setSelectedCategory('ludo');
                }}
              >
                <Icon name="dice" size={16} />
                <span>JakLudo ({ludoItems.length})</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={selectedCategory === 'quiz'}
                className="tabs__tab"
                onClick={() => {
                  sound.playClick();
                  setSelectedCategory('quiz');
                }}
              >
                <Icon name="swords" size={16} />
                <span>Monster Quiz ({quizItems.length})</span>
              </button>
            </div>
          )}

          {/* Bagian Top Up Diamonds (Muncul di tab 'all' atau tab khusus 'topup') */}
          {(selectedCategory === 'all' || selectedCategory === 'topup') && (
            <section className="shop__group" aria-label="Top Up Diamonds Doku">
              <div className="shop__group-header shop__group-header--topup">
                <div>
                  <h3 className="shop__group-title">
                    <Icon name="diamond" size={20} />
                    <span>Top Up Diamonds PlayGo</span>
                  </h3>
                  <p className="shop__group-desc">
                    Beli diamonds/points instan via Doku Payment Gateway (QRIS, Virtual Account &amp; Checkout).
                  </p>
                </div>
                <span className="badge badge--popular">
                  Doku Payment
                </span>
              </div>

              <ul className="shop__items">
                {diamondPackages.map(pkg => (
                  <TopupPackageCard
                    key={pkg.id}
                    pkg={pkg}
                    currentUser={currentUser}
                    onSelectPackage={handleSelectPackage}
                  />
                ))}
              </ul>

              <div className="shop__midtrans-banner">
                <span>🛡️ Pembayaran otomatis terverifikasi via <strong>Doku Payment Gateway</strong></span>
                <span>QRIS · BCA VA · Mandiri VA · BNI VA · BRI VA · Permata · Doku VA · Checkout</span>
              </div>
            </section>
          )}

          {/* Bagian Item Game (JakLudo & Monster Quiz) */}
          {visibleGroups.map(group => (
            <section key={group.key} className="shop__group" aria-label={group.name}>
              <div className={`shop__group-header ${group.key === 'quiz' ? 'shop__group-header--quiz' : ''}`}>
                <div>
                  <h3 className="shop__group-title">
                    <Icon name={group.icon} size={18} />
                    <span>{group.name}</span>
                  </h3>
                  <p className="shop__group-desc">{group.desc}</p>
                </div>
                <span className={`badge ${group.key === 'quiz' ? 'badge--info' : 'badge--brand'}`}>
                  {group.badge}
                </span>
              </div>

              <ul className="shop__items">
                {group.items.map(item => (
                  <ShopItemCard
                    key={item.id}
                    item={item}
                    points={points}
                    ownedCount={owned[item.id] || 0}
                    currentUser={currentUser}
                    buyingId={buying}
                    onBuy={buy}
                  />
                ))}
              </ul>
            </section>
          ))}

          <section className="shop__earn" aria-labelledby="earn-title">
            <h3 id="earn-title">Cara dapat poin PlayGo</h3>
            <ul>
              <li>Top up instan: <strong>100 diamonds = Rp 50.000</strong>, <strong>300 diamonds = Rp 150.000</strong>, <strong>550 diamonds = Rp 500.000</strong></li>
              <li>Menang <strong>Monster Quiz Battle</strong>: <strong>+30 poin</strong></li>
              <li>Peringkat 1 <strong>JakLudo</strong>: <strong>+30 poin</strong></li>
              <li>Peringkat 2 <strong>JakLudo</strong>: <strong>+20 poin</strong> (main 4 orang) atau <strong>+15</strong> (main 3 orang)</li>
              <li>Peringkat 3 <strong>JakLudo</strong> (main 4 orang): <strong>+15 poin</strong></li>
              <li>Peringkat terakhir <strong>JakLudo</strong>: <strong>+5 poin</strong></li>
              <li>Bonus harian: <strong>+5 poin</strong> untuk pertandingan pertama yang kamu selesaikan tiap hari</li>
              <li>Bonus akun baru: <strong>200 poin</strong></li>
            </ul>
            <p className="muted">Poin / Diamonds dapat digunakan untuk membeli item di JakLudo maupun Hints Jawaban di Monster Quiz Battle.</p>
          </section>
        </>
      )}
    </Modal>
  );
}

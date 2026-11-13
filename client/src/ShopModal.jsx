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

function loadMidtransSnap(snapJsUrl, clientKey) {
  return new Promise((resolve, reject) => {
    if (window.snap) return resolve(window.snap);
    const scriptId = 'midtrans-snap-script';
    let script = document.getElementById(scriptId);
    if (script) {
      if (window.snap) return resolve(window.snap);
      script.addEventListener('load', () => resolve(window.snap));
      script.addEventListener('error', () => reject(new Error('Gagal memuat Snap Midtrans')));
      return;
    }
    script = document.createElement('script');
    script.id = scriptId;
    script.src = snapJsUrl || 'https://app.sandbox.midtrans.com/snap/snap.js';
    if (clientKey) script.setAttribute('data-client-key', clientKey);
    script.async = true;
    script.onload = () => {
      if (window.snap) resolve(window.snap);
      else reject(new Error('Midtrans Snap tidak tersedia'));
    };
    script.onerror = () => reject(new Error('Koneksi Midtrans Snap gagal'));
    document.head.appendChild(script);
  });
}

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

function TopupPackageCard({ pkg, currentUser, topupLoadingId, onTopup }) {
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
          <p className="muted">{pkg.subtitle || pkg.description || 'Midtrans Snap'}</p>
        </div>
      </div>
      <div className="shop-item__buy">
        <div className="topup-card__price">
          {pkg.formattedPrice}
        </div>
        <button
          type="button"
          className={`btn ${isPopular || isSultan ? 'btn--primary' : 'btn--secondary'}`}
          disabled={!currentUser || topupLoadingId === pkg.id}
          onClick={() => onTopup(pkg)}
        >
          {topupLoadingId === pkg.id ? 'Memproses...' : !currentUser ? 'Masuk dulu' : `Beli (${pkg.formattedPrice})`}
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
  const [topupLoadingId, setTopupLoadingId] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState(initialGame || 'all');
  const [diamondPackages, setDiamondPackages] = useState(DEFAULT_DIAMOND_PACKAGES);
  const [snapConfig, setSnapConfig] = useState(null);

  const catalog = useItemCatalogState();

  useEffect(() => {
    if (isOpen && initialGame) {
      setSelectedCategory(initialGame);
    }
    if (!isOpen) {
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
        setSnapConfig(data);
        if (data.snapJsUrl && data.clientKey) {
          loadMidtransSnap(data.snapJsUrl, data.clientKey).catch(() => {});
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

  const handleTopup = async pkg => {
    if (!currentUser) {
      setFeedback({ type: 'error', message: 'Silakan login terlebih dahulu untuk melakukan top up diamonds.' });
      return;
    }
    setTopupLoadingId(pkg.id);
    setFeedback(null);
    sound.playClick();
    const token = authToken || storage.get('token');

    try {
      const res = await fetch('/api/topup/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ packageId: pkg.id })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Gagal memulai transaksi top up.');
      }

      const snapJsUrl = data.snapJsUrl || snapConfig?.snapJsUrl;
      const clientKey = data.clientKey || snapConfig?.clientKey;
      await loadMidtransSnap(snapJsUrl, clientKey);

      if (!window.snap) {
        throw new Error('Midtrans Snap tidak dapat dimuat di browser.');
      }

      window.snap.pay(data.snapToken || data.token, {
        onSuccess: async () => {
          try {
            const verifyRes = await fetch('/api/topup/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ orderId: data.orderId })
            });
            const verifyData = await verifyRes.json().catch(() => ({}));
            sound.playShopPurchase();
            setFeedback({
              type: 'success',
              message: `Pembayaran berhasil! +${pkg.diamonds} Diamonds telah ditambahkan ke akunmu.`
            });
            if (verifyData.user) onUpdateUser?.(verifyData.user);
          } catch {
            setFeedback({
              type: 'success',
              message: `Pembayaran berhasil diterima oleh Midtrans!`
            });
          }
        },
        onPending: () => {
          setFeedback({
            type: 'info',
            message: `Pesanan ${data.orderId} sedang menunggu pembayaran. Selesaikan pembayaran sesuai instruksi Midtrans.`
          });
        },
        onError: () => {
          setFeedback({
            type: 'error',
            message: 'Pembayaran Midtrans gagal atau dibatalkan.'
          });
        },
        onClose: async () => {
          try {
            const checkRes = await fetch('/api/topup/verify', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
              body: JSON.stringify({ orderId: data.orderId })
            });
            const checkData = await checkRes.json().catch(() => ({}));
            if (checkData?.status === 'success' && checkData.user) {
              sound.playShopPurchase();
              setFeedback({
                type: 'success',
                message: `Pembayaran berhasil! +${pkg.diamonds} Diamonds telah ditambahkan ke akunmu.`
              });
              onUpdateUser?.(checkData.user);
            }
          } catch {}
        }
      });
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setTopupLoadingId(null);
    }
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
        <section className="shop__group" aria-label="Top Up Diamonds Midtrans Snap">
          <div className="shop__group-header shop__group-header--topup">
            <div>
              <h3 className="shop__group-title">
                <Icon name="diamond" size={20} />
                <span>Top Up Diamonds PlayGo</span>
              </h3>
              <p className="shop__group-desc">
                Beli diamonds/points instan via Midtrans Snap (QRIS, GoPay, ShopeePay &amp; Virtual Account).
              </p>
            </div>
            <span className="badge badge--popular">
              Midtrans Snap
            </span>
          </div>

          <ul className="shop__items">
            {diamondPackages.map(pkg => (
              <TopupPackageCard
                key={pkg.id}
                pkg={pkg}
                currentUser={currentUser}
                topupLoadingId={topupLoadingId}
                onTopup={handleTopup}
              />
            ))}
          </ul>

          <div className="shop__midtrans-banner">
            <span>🛡️ Pembayaran resmi &amp; otomatis terverifikasi via <strong>Midtrans Snap</strong></span>
            <span>QRIS · GoPay · ShopeePay · BCA VA · BRI VA · BNI VA · Mandiri · Kartu Kredit</span>
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
          <li>Top up instan: <strong>50 diamonds = Rp 5.000</strong>, <strong>120 diamonds = Rp 10.000</strong>, <strong>260 diamonds = Rp 20.000</strong>, <strong>700 diamonds = Rp 50.000</strong>, <strong>1.500 diamonds = Rp 100.000</strong>, <strong>3.250 diamonds = Rp 200.000</strong></li>
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
    </Modal>
  );
}

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
    name: '50 Coins',
    diamonds: 50,
    price: 5000,
    formattedPrice: 'Rp 5.000',
    subtitle: 'Paket pemula',
    description: 'Paket pemula',
    badge: null,
    icon: 'coin'
  },
  {
    id: 'diamond_120',
    name: '120 Coins',
    diamonds: 120,
    price: 10000,
    formattedPrice: 'Rp 10.000',
    subtitle: 'Paket hemat',
    description: 'Paket hemat',
    badge: 'Populer',
    icon: 'coin'
  },
  {
    id: 'diamond_260',
    name: '260 Coins',
    diamonds: 260,
    price: 20000,
    formattedPrice: 'Rp 20.000',
    subtitle: 'Paket reguler',
    description: 'Paket reguler',
    badge: null,
    icon: 'coin'
  },
  {
    id: 'diamond_700',
    name: '700 Coins',
    diamonds: 700,
    price: 50000,
    formattedPrice: 'Rp 50.000',
    subtitle: 'Paket premium',
    description: 'Paket premium',
    badge: 'Bonus 100',
    icon: 'coin'
  },
  {
    id: 'diamond_1500',
    name: '1.500 Coins',
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
    name: '3.250 Coins',
    diamonds: 3250,
    price: 200000,
    formattedPrice: 'Rp 200.000',
    subtitle: 'Paket sultan',
    description: 'Paket sultan',
    badge: 'Bonus 750',
    icon: 'crown'
  }
];

function loadDuitkuPop(popJsUrl) {
  return new Promise((resolve, reject) => {
    if (window.checkout && window.checkout.process) return resolve(window.checkout);
    const scriptId = 'duitku-pop-script';
    let script = document.getElementById(scriptId);
    if (script) {
      if (window.checkout && window.checkout.process) return resolve(window.checkout);
      script.addEventListener('load', () => resolve(window.checkout));
      script.addEventListener('error', () => reject(new Error('Gagal memuat Duitku POP')));
      return;
    }
    script = document.createElement('script');
    script.id = scriptId;
    script.src = popJsUrl || 'https://app-sandbox.duitku.com/lib/js/duitku.js';
    script.async = true;
    script.onload = () => {
      if (window.checkout && window.checkout.process) resolve(window.checkout);
      else reject(new Error('Duitku POP tidak tersedia'));
    };
    script.onerror = () => reject(new Error('Koneksi Duitku POP gagal'));
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
          <Icon name="coin" size={16} /> {item.price} Coins
        </span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!currentUser || !affordable || buyingId === item.id}
          onClick={() => onBuy(item)}
        >
          {buyingId === item.id ? 'Membeli...' : !currentUser ? 'Masuk dulu' : affordable ? `Beli ${item.name}` : 'Coins kurang'}
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
        <span className="shop-item__icon" aria-hidden="true" style={{ color: isSultan ? '#f59e0b' : '#eab308' }}>
          <Icon name={pkg.icon || 'coin'} size={28} />
        </span>
        <div>
          <div className="shop-item__title-row">
            <h3>{pkg.name}</h3>
            {pkg.badge && <span className={`badge ${badgeClass}`}>{pkg.badge}</span>}
          </div>
          <p className="muted">{pkg.subtitle || pkg.description || 'Duitku Payment'}</p>
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
  const [popConfig, setPopConfig] = useState(null);

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
        setPopConfig(data);
        if (data.popJsUrl) {
          loadDuitkuPop(data.popJsUrl).catch(() => {});
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
      setFeedback({ type: 'success', message: `${item.name} berhasil dibeli. Sisa Coins: ${data.user?.points ?? points - item.price}.` });
      if (data.user) onUpdateUser?.(data.user);
    } catch (err) {
      setFeedback({ type: 'error', message: err.message });
    } finally {
      setBuying(null);
    }
  };

  const handleTopup = async pkg => {
    if (!currentUser) {
      setFeedback({ type: 'error', message: 'Silakan login terlebih dahulu untuk melakukan top up Coins.' });
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

      const popJsUrl = data.popJsUrl || popConfig?.popJsUrl;
      try {
        await loadDuitkuPop(popJsUrl);
      } catch (err) {
        console.warn('Gagal memuat Duitku POP script:', err.message);
      }

      if (window.checkout && window.checkout.process && data.reference) {
        window.checkout.process(data.reference, {
          defaultLanguage: 'id',
          successEvent: async function () {
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
                message: `Pembayaran berhasil! +${pkg.diamonds || pkg.coins} Coins telah ditambahkan ke akunmu.`
              });
              if (verifyData.user) onUpdateUser?.(verifyData.user);
            } catch {
              setFeedback({
                type: 'success',
                message: 'Pembayaran berhasil diterima oleh Duitku!'
              });
            }
          },
          pendingEvent: function () {
            setFeedback({
              type: 'info',
              message: `Pesanan ${data.orderId} sedang menunggu pembayaran. Selesaikan pembayaran sesuai instruksi Duitku.`
            });
          },
          errorEvent: function () {
            setFeedback({
              type: 'error',
              message: 'Pembayaran Duitku gagal atau dibatalkan.'
            });
          },
          closeEvent: async function () {
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
                  message: `Pembayaran berhasil! +${pkg.diamonds || pkg.coins} Coins telah ditambahkan ke akunmu.`
                });
                onUpdateUser?.(checkData.user);
              }
            } catch {}
          }
        });
      } else if (data.paymentUrl) {
        window.open(data.paymentUrl, '_blank');
        setFeedback({
          type: 'info',
          message: 'Halaman pembayaran Duitku telah dibuka di tab baru. Silakan selesaikan pembayaran.'
        });
      } else {
        throw new Error('Duitku checkout tidak tersedia.');
      }
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
      subtitle={currentUser ? `Saldo kamu: ${points.toLocaleString('id-ID')} Coins` : 'Masuk dulu untuk membeli item atau top up.'}
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
            <Icon name="coin" size={16} />
            <span>Top Up Coins</span>
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

      {/* Bagian Top Up Coins (Muncul di tab 'all' atau tab khusus 'topup') */}
      {(selectedCategory === 'all' || selectedCategory === 'topup') && (
        <section className="shop__group" aria-label="Top Up Coins Duitku POP">
          <div className="shop__group-header shop__group-header--topup">
            <div>
              <h3 className="shop__group-title">
                <Icon name="coin" size={20} />
                <span>Top Up Coins PlayGo</span>
              </h3>
              <p className="shop__group-desc">
                Beli Coins instan via Duitku (QRIS, E-Wallet &amp; Virtual Account).
              </p>
            </div>
            <span className="badge badge--popular">
              Duitku POP
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

          <div className="shop__duitku-banner">
            <span>🛡️ Pembayaran resmi &amp; otomatis terverifikasi via <strong>Duitku</strong></span>
            <span>QRIS · GoPay · OVO · DANA · ShopeePay · BCA VA · BRI VA · BNI VA · Mandiri · Gerai Retail</span>
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
        <h3 id="earn-title">Cara dapat Coins PlayGo</h3>
        <ul>
          <li>Top up instan: <strong>50 Coins = Rp 5.000</strong>, <strong>120 Coins = Rp 10.000</strong>, <strong>260 Coins = Rp 20.000</strong>, <strong>700 Coins = Rp 50.000</strong>, <strong>1.500 Coins = Rp 100.000</strong>, <strong>3.250 Coins = Rp 200.000</strong></li>
          <li>Menang <strong>Monster Quiz Battle</strong>: <strong>+30 Coins</strong></li>
          <li>Peringkat 1 <strong>JakLudo</strong>: <strong>+30 Coins</strong></li>
          <li>Peringkat 2 <strong>JakLudo</strong>: <strong>+20 Coins</strong> (main 4 orang) atau <strong>+15</strong> (main 3 orang)</li>
          <li>Peringkat 3 <strong>JakLudo</strong> (main 4 orang): <strong>+15 Coins</strong></li>
          <li>Peringkat terakhir <strong>JakLudo</strong>: <strong>+5 Coins</strong></li>
          <li>Bonus harian: <strong>+5 Coins</strong> untuk pertandingan pertama yang kamu selesaikan tiap hari</li>
          <li>Bonus akun baru: <strong>200 Coins</strong></li>
        </ul>
        <p className="muted">Coins dapat digunakan untuk membeli item di JakLudo maupun Hints Jawaban di Monster Quiz Battle.</p>
      </section>
    </Modal>
  );
}

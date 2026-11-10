import React, { useState } from 'react';
import Modal from './components/Modal';
import Icon from './components/Icon';
import { sound } from './sound';
import { storage } from './storage';
import { useItemCatalogState } from './items';

const KIND_LABELS = {
  active: 'Dipakai manual di giliranmu',
  passive: 'Bekerja otomatis',
  reactive: 'Muncul pilihan saat dibutuhkan'
};

export default function ShopModal({ isOpen, onClose, currentUser, onUpdateUser, authToken }) {
  const [buying, setBuying] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const catalog = useItemCatalogState();

  const points = currentUser?.points ?? 0;
  const owned = currentUser?.inventory || {};

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

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="lg"
      icon="shop"
      title="Toko item"
      subtitle={currentUser ? `Poin kamu: ${points.toLocaleString('id-ID')}` : 'Masuk dulu untuk membeli item.'}
    >
      {feedback && (
        <p className={`alert alert--${feedback.type === 'success' ? 'success' : 'error'} shop__feedback`} role={feedback.type === 'success' ? 'status' : 'alert'}>
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

      <ul className="shop__items">
        {catalog.items.map(item => {
          const affordable = points >= item.price;
          return (
            <li key={item.id} className="shop-item card">
              <div className="shop-item__head">
                <span className="shop-item__icon" aria-hidden="true">
                  <Icon name={item.icon || item.id} size={26} />
                </span>
                <div>
                  <h3>{item.name}</h3>
                  <p className="muted">{KIND_LABELS[item.kind] || 'Bekerja otomatis'} · dimiliki {owned[item.id] || 0}</p>
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
                  disabled={!currentUser || !affordable || buying === item.id}
                  onClick={() => buy(item)}
                >
                  {buying === item.id ? 'Membeli...' : !currentUser ? 'Masuk dulu' : affordable ? `Beli ${item.name}` : 'Poin kurang'}
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <section className="shop__earn" aria-labelledby="earn-title">
        <h3 id="earn-title">Cara dapat poin</h3>
        <ul>
          <li>Peringkat 1: <strong>+30 poin</strong></li>
          <li>Peringkat 2: <strong>+20 poin</strong> (main 4 orang) atau <strong>+15</strong> (main 3 orang)</li>
          <li>Peringkat 3 (main 4 orang): <strong>+15 poin</strong></li>
          <li>Peringkat terakhir: <strong>+5 poin</strong></li>
          <li>Bonus akun baru: <strong>200 poin</strong></li>
        </ul>
        <p className="muted">Peringkat dihitung dari jumlah bidak yang sudah finish saat ada pemenang. Poin hanya dihitung untuk pertandingan bersama minimal satu pemain lain (bukan hanya bot).</p>
      </section>
    </Modal>
  );
}

import React, { useEffect, useRef, useState } from 'react';
import Modal from '../Modal';
import Icon from '../Icon';
import ThemeToggle from '../ThemeToggle';
import { NetworkIndicator } from '../NetworkStatus';
import { sound } from '../../sound';

// Header ringkas saat bermain: kode room, sinyal, toko, suara, dan keluar (dengan konfirmasi)
export default function GameHeader({ room, isOut = false, audio, network, theme, onOpenShop, onOpenAudio, onLeave, leaveRequest = 0 }) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  // Tombol Back browser/HP saat bermain membuka konfirmasi (atau langsung keluar jika sudah OUT menonton).
  // Tiap permintaan (nomor leaveRequest) diproses tepat sekali. Dimulai dari nilai saat komponen dipasang
  // supaya permintaan lama tidak terulang saat masuk ulang ke room. onLeave lewat ref: fungsinya dibuat
  // ulang tiap render App, dan bila jadi dependensi efek, popup akan terbuka lagi di setiap render.
  const handledLeaveRequest = useRef(leaveRequest);
  const onLeaveRef = useRef(onLeave);
  onLeaveRef.current = onLeave;
  useEffect(() => {
    if (!leaveRequest || leaveRequest === handledLeaveRequest.current) return;
    handledLeaveRequest.current = leaveRequest;
    if (isOut) onLeaveRef.current();
    else setConfirmLeave(true);
  }, [leaveRequest, isOut]);
  const muted = audio.bgmMuted && audio.sfxMuted;

  return (
    <header className="game-header">
      <div className="game-header__room">
        <span className="muted">Room</span> <strong className="code-text">{room.code}</strong>
        {isOut && <span className="badge badge--info">👀 Menonton</span>}
        {room.settings?.blackHole && (
          <span className="badge badge--warning">
            <Icon name="vortex" size={14} /> Black Hole
          </span>
        )}
      </div>
      <div className="game-header__actions">
        <NetworkIndicator {...network} />
        <button
          type="button"
          className="icon-btn"
          aria-label="Toko item"
          title="Toko item"
          onClick={() => {
            sound.playClick();
            onOpenShop();
          }}
        >
          <Icon name="shop" size={20} />
        </button>
        <button type="button" className="icon-btn" aria-label="Pengaturan suara" title="Pengaturan suara" onClick={onOpenAudio}>
          <Icon name={muted ? 'volume-off' : 'volume-on'} size={20} />
        </button>
        <ThemeToggle theme={theme} />
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => (isOut ? onLeave() : setConfirmLeave(true))}
        >
          {isOut ? 'Keluar menonton' : 'Keluar'}
        </button>
      </div>

      <Modal
        isOpen={confirmLeave && !isOut}
        onClose={() => setConfirmLeave(false)}
        size="sm"
        title="Keluar dari permainan?"
        subtitle="Keluar di tengah permainan berarti menyerah (OUT). Kamu tetap bisa masuk lagi nanti untuk menonton jalannya pertandingan."
        footer={
          <>
            <button type="button" className="btn btn--secondary" onClick={() => setConfirmLeave(false)}>Tetap main</button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                setConfirmLeave(false);
                onLeave();
              }}
            >
              Menyerah dan keluar
            </button>
          </>
        }
      >
        <p className="muted">Kalau koneksimu hanya sedang tidak stabil, cukup tutup halaman ini. Kursimu tetap aman dan kamu bisa masuk lagi dari beranda.</p>
      </Modal>
    </header>
  );
}

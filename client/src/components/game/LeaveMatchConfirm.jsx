import React from 'react';
import Modal from '../Modal';

// Konfirmasi sebelum keluar dari pertandingan yang sedang berjalan (Ular Tangga, Monster Quiz).
// Mencegah pemain kalah hanya karena tidak sengaja menekan tombol Keluar.
export default function LeaveMatchConfirm({ isOpen, onCancel, onConfirm, subtitle }) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      size="sm"
      title="Keluar dari permainan?"
      subtitle={subtitle || 'Keluar di tengah permainan berarti menyerah dan dihitung kalah.'}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onCancel}>
            Tetap main
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm}>
            Menyerah dan keluar
          </button>
        </>
      }
    >
      <p className="muted">Kalau koneksimu hanya sedang tidak stabil, cukup tutup halaman ini dan masuk lagi dari beranda.</p>
    </Modal>
  );
}

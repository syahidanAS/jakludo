import React, { useEffect, useState } from 'react';
import Modal from '../Modal';
import { itemStock } from '../../items';

// Popup untuk pemilik perisai reaktif (mis. Universal Shield) saat bidaknya terancam.
// Tidak bisa ditutup tanpa memilih: kalau waktu habis, server otomatis memakai perisai.
export default function ShieldPrompt({ room, playerId, catalog, onDecide }) {
  const pending = room.pendingShield;
  const mine = pending && pending.playerId === playerId;
  const [deadline, setDeadline] = useState(0);
  const [now, setNow] = useState(Date.now());

  // Sisa waktu dihitung dari jam lokal agar tidak terpengaruh selisih jam server
  useEffect(() => {
    if (!mine) return undefined;
    setDeadline(Date.now() + (pending.remainingMs || 0));
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [mine, pending?.id]);

  if (!mine) return null;

  const isSkinShield = pending.source === 'skinShield';
  const item = isSkinShield ? null : catalog.find(i => i.id === pending.itemId);
  const name = item?.name || 'perisai';
  const me = room.players.find(p => p.id === playerId);
  const stock = itemStock(me, pending.itemId).count;
  const attacker = room.players.find(p => p.id === pending.attackerId);
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  const skinCharges = pending.charges ?? me?.skinShield?.charges ?? 1;
  const skinMaxCharges = pending.maxCharges ?? me?.skinShield?.max ?? 3;
  const skinName = pending.skinName || me?.skinShield?.skinName || 'Skin';

  const threat = pending.event === 'forceReturn'
    ? `${attacker?.name || 'Lawan'} memakai Force Return ke bidak ${pending.pawnIdx + 1} milikmu.`
    : pending.event === 'stomp'
    ? `${attacker?.name || 'Lawan'} menginjak bidak ${pending.pawnIdx + 1} milikmu.`
    : `Bidak ${pending.pawnIdx + 1} milikmu mendarat di Black Hole.`;

  return (
    <Modal
      isOpen
      size="sm"
      icon={isSkinShield ? '🛡️' : (item?.icon || '🔰')}
      title={isSkinShield ? 'Aktifkan Anti-Eliminasi?' : `Pakai ${name}?`}
      subtitle={threat}
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={() => onDecide(false)}>
            {isSkinShield ? 'Jangan pakai' : 'Simpan perisai'}
          </button>
          <button type="button" className="btn btn--primary" onClick={() => onDecide(true)}>
            {isSkinShield ? 'Pakai Anti-Eliminasi' : `Pakai ${name}`}
          </button>
        </>
      }
    >
      {isSkinShield ? (
        <>
          <p>
            Kalau dipakai, bidakmu tetap aman di posisi sekarang dan tidak pulang ke markas.
            Skill <strong>{skinName}</strong> ini hanya berlaku di permainan ini dan terisi +1
            setiap kali bidakmu masuk garis finish (maks. {skinMaxCharges}).
          </p>
          <p className="muted" role="timer" aria-live="off">
            Sisa skill {skinCharges}/{skinMaxCharges}. Jika tidak dikonfirmasi dalam {seconds} detik, skill tidak digunakan.
          </p>
        </>
      ) : (
        <>
          <p>
            {pending.event === 'forceReturn'
              ? 'Kalau dipakai, bidakmu tetap di tempat. Kalau disimpan, bidakmu pulang ke markas.'
              : 'Kalau dipakai, bidakmu tidak tersedot. Kalau disimpan, bidakmu kembali ke markas.'}
          </p>
          <p className="muted" role="timer" aria-live="off">
            Sisa {stock} perisai. Otomatis dipakai dalam {seconds} detik.
          </p>
        </>
      )}
    </Modal>
  );
}

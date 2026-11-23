import React from 'react';
import Modal from './Modal';
import { LudoSkinTokenInner } from './game/LudoSkinPawn';
import { hasOceanBlueHintAbility } from '../utils/oceanBlueHints.mjs';

const OCEAN_BLUE_SKIN = {
  id: 'ocean_blue',
  name: 'Ocean Blue',
  assetKey: 'ocean_blue',
  accentColor: '#0ea5e9'
};

export default function OceanBluePromoModal({
  isOpen,
  onClose,
  user,
  onOpenShop,
  onPlayLudo
}) {
  const isEquipped = hasOceanBlueHintAbility(user?.equippedLudoSkin);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      icon="🌊"
      title="Skin Ocean Blue"
      subtitle="Kemampuan baru di JakLudo"
      className="ocean-intro-modal"
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Nanti saja
          </button>
          {isEquipped ? (
            <button type="button" className="btn btn--primary" onClick={onPlayLudo}>
              Main JakLudo
            </button>
          ) : (
            <button type="button" className="btn btn--primary" onClick={onOpenShop}>
              Lihat di Toko
            </button>
          )}
        </>
      }
    >
      <div className="ocean-intro-modal__body">
        <div className="ocean-intro-modal__meta">
          <span className="badge badge--info">Hint Langkah Terbaik</span>
          {isEquipped ? (
            <span className="badge badge--success">Sedang kamu pakai</span>
          ) : (
            <span className="badge">20 Diamonds</span>
          )}
        </div>

        <div className="ocean-board-card" aria-hidden="true">
          <div className="ocean-board-strip">
            <div className="ocean-board-tile">
              <div className="ocean-spot-pawn ocean-spot-pawn--1" data-skin="ocean_blue">
                <LudoSkinTokenInner skin={OCEAN_BLUE_SKIN} number={2} />
                <span className="ocean-spot-rank ocean-spot-rank--1">#1</span>
              </div>
            </div>

            <div className="ocean-board-tile ocean-board-tile--home">
              <div className="ocean-spot-pawn ocean-spot-pawn--2" data-skin="ocean_blue">
                <LudoSkinTokenInner skin={OCEAN_BLUE_SKIN} number={4} />
                <span className="ocean-spot-rank ocean-spot-rank--2">#2</span>
              </div>
            </div>

            <div className="ocean-board-tile ocean-board-tile--star">
              <span className="ocean-board-tile__star">★</span>
              <div className="ocean-spot-pawn ocean-spot-pawn--3" data-skin="ocean_blue">
                <LudoSkinTokenInner skin={OCEAN_BLUE_SKIN} number={1} />
                <span className="ocean-spot-rank ocean-spot-rank--3">#3</span>
              </div>
            </div>

            <div className="ocean-board-tile ocean-board-tile--hole">
              <span className="ocean-board-tile__hole">🕳️</span>
            </div>
          </div>

          <div className="ocean-board-caption">
            <span className="ocean-board-note ocean-board-note--1">
              <strong>#1</strong> Makan lawan
            </span>
            <span className="ocean-board-note">
              <strong>#2</strong> Jalur aman
            </span>
            <span className="ocean-board-note">
              <strong>#3</strong> Petak ★
            </span>
          </div>
        </div>

        <p className="ocean-intro-modal__desc">
          {isEquipped ? (
            <>
              Skin Ocean Blue yang sedang kamu pakai kini otomatis menyorot bidak dengan peluang posisi paling menguntungkan saat giliranmu. Jika ada lebih dari dua pilihan bagus, urutannya langsung ditandai dari <strong>#1</strong>, <strong>#2</strong>, sampai <strong>#3</strong>.
            </>
          ) : (
            <>
              Saat giliranmu di JakLudo, bidak dengan posisi paling menguntungkan otomatis menyala. Kalau ada lebih dari dua opsi bagus, urutannya langsung ditandai dari <strong>#1</strong>, <strong>#2</strong>, sampai <strong>#3</strong>—mulai dari peluang makan lawan, masuk jalur aman, sampai menghindari Black Hole.
            </>
          )}
        </p>
      </div>
    </Modal>
  );
}

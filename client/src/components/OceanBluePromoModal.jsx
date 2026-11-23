import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import { LudoSkinTokenInner, resolveSkinKey } from './game/LudoSkinPawn';
import { hasOceanBlueHintAbility } from '../utils/oceanBlueHints.mjs';

const OCEAN_BLUE_SKIN = {
  id: 'ocean_blue',
  name: 'Ocean Blue',
  assetKey: 'ocean_blue',
  accentColor: '#0ea5e9'
};

const EMERALD_GREEN_SKIN = {
  id: 'emerald_green',
  name: 'Emerald Green',
  assetKey: 'emerald_green',
  accentColor: '#10b981'
};

const GALAXY_PURPLE_SKIN = {
  id: 'galaxy_purple',
  name: 'Galaxy Purple',
  assetKey: 'galaxy_purple',
  accentColor: '#8b5cf6'
};

export default function OceanBluePromoModal({
  isOpen,
  onClose,
  user,
  onOpenShop,
  onPlayLudo
}) {
  const [activeTab, setActiveTab] = useState('shield');
  const [selectedShieldSkin, setSelectedShieldSkin] = useState('emerald_green');

  useEffect(() => {
    if (isOpen) setActiveTab('shield');
  }, [isOpen]);

  const equippedKey = resolveSkinKey(user?.equippedLudoSkin);
  const hasShieldEquipped = equippedKey === 'emerald_green' || equippedKey === 'galaxy_purple';
  const hasOceanEquipped = hasOceanBlueHintAbility(user?.equippedLudoSkin);
  const isActiveEquipped = activeTab === 'shield' ? hasShieldEquipped : hasOceanEquipped;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      icon={activeTab === 'shield' ? '🛡️' : '🌊'}
      title="Kemampuan Skin JakLudo"
      subtitle={activeTab === 'shield' ? 'Emerald Green & Galaxy Purple' : 'Skin Ocean Blue'}
      className="ocean-intro-modal"
      footer={
        <>
          <button type="button" className="btn btn--secondary" onClick={onClose}>
            Nanti saja
          </button>
          {isActiveEquipped ? (
            <button type="button" className="btn btn--primary" onClick={onPlayLudo}>
              Main JakLudo
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => onOpenShop(activeTab === 'shield' ? selectedShieldSkin : 'ocean_blue')}
            >
              Lihat di Toko
            </button>
          )}
        </>
      }
    >
      <div className="ocean-intro-modal__body">
        <div className="skin-intro-tabs" role="tablist" aria-label="Pilih kemampuan skin">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'shield'}
            className={`skin-intro-tab ${activeTab === 'shield' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('shield')}
          >
            🛡️ Anti-Eliminasi
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'ocean'}
            className={`skin-intro-tab ${activeTab === 'ocean' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('ocean')}
          >
            🌊 Hint Langkah
          </button>
        </div>

        {activeTab === 'shield' ? (
          <>
            <div className="ocean-intro-modal__meta">
              <span className="badge badge--emerald-ability">🛡️ Anti-Eliminasi</span>
              <button
                type="button"
                className={`skin-intro-pick ${selectedShieldSkin === 'emerald_green' ? 'is-selected' : ''}`}
                onClick={() => setSelectedShieldSkin('emerald_green')}
              >
                Emerald Green · 25 💎
              </button>
              <button
                type="button"
                className={`skin-intro-pick skin-intro-pick--galaxy ${selectedShieldSkin === 'galaxy_purple' ? 'is-selected' : ''}`}
                onClick={() => setSelectedShieldSkin('galaxy_purple')}
              >
                Galaxy Purple · 30 💎
              </button>
              {hasShieldEquipped && <span className="badge badge--success">Sedang kamu pakai</span>}
            </div>

            <div className="ocean-board-card" aria-hidden="true">
              <div className="ocean-board-strip">
                <div className="ocean-board-tile">
                  <div className="ocean-spot-pawn shield-spot-pawn--emerald" data-skin="emerald_green">
                    <LudoSkinTokenInner skin={EMERALD_GREEN_SKIN} number={1} />
                    <span className="ocean-spot-rank shield-spot-badge shield-spot-badge--emerald">🛡️</span>
                  </div>
                </div>

                <div className="ocean-board-tile">
                  <div className="ocean-spot-pawn shield-spot-pawn--galaxy" data-skin="galaxy_purple">
                    <LudoSkinTokenInner skin={GALAXY_PURPLE_SKIN} number={3} />
                    <span className="ocean-spot-rank shield-spot-badge shield-spot-badge--galaxy">⚡</span>
                  </div>
                </div>

                <div className="ocean-board-tile ocean-board-tile--star">
                  <span className="ocean-board-tile__star">★</span>
                  <span className="shield-finish-recharge">+1</span>
                </div>

                <div className="ocean-board-tile ocean-board-tile--charge">
                  <strong className="shield-charge-ratio">1→3</strong>
                  <span className="shield-charge-note">maks. 3</span>
                </div>
              </div>

              <div className="ocean-board-caption">
                <span className="ocean-board-note ocean-board-note--emerald">
                  <strong>1x</strong> Awal laga
                </span>
                <span className="ocean-board-note">
                  <strong>+1</strong> Masuk finish
                </span>
                <span className="ocean-board-note">
                  <strong>Maks. 3</strong> 1 laga saja
                </span>
              </div>
            </div>

            <p className="ocean-intro-modal__desc">
              {hasShieldEquipped ? (
                <>
                  Skin <strong>{equippedKey === 'galaxy_purple' ? 'Galaxy Purple' : 'Emerald Green'}</strong> yang sedang kamu pakai memberimu skill <strong>Anti-Eliminasi</strong> saat diinjak atau terkena <strong>Force Return</strong> lawan. Setiap mau dipakai akan muncul konfirmasi lebih dulu, bertambah <strong>+1</strong> saat bidakmu masuk garis finish (maks. <strong>3</strong>), dan hanya berlaku di pertandingan tersebut.
                </>
              ) : (
                <>
                  Melindungi bidak dari eliminasi lawan, baik saat <strong>diinjak</strong> maupun terkena <strong>Force Return</strong>. Saat terancam muncul konfirmasi sebelum skill aktif—mulai dengan <strong>1x</strong> pakai, terisi <strong>+1</strong> setiap bidak masuk garis finish (maks. <strong>3</strong>), dan hanya berlaku dalam 1 pertandingan saja.
                </>
              )}
            </p>
          </>
        ) : (
          <>
            <div className="ocean-intro-modal__meta">
              <span className="badge badge--info">Hint Langkah Terbaik</span>
              {hasOceanEquipped ? (
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
              {hasOceanEquipped ? (
                <>
                  Skin Ocean Blue yang sedang kamu pakai kini otomatis menyorot bidak dengan peluang posisi paling menguntungkan saat giliranmu. Jika ada lebih dari dua pilihan bagus, urutannya langsung ditandai dari <strong>#1</strong>, <strong>#2</strong>, sampai <strong>#3</strong>.
                </>
              ) : (
                <>
                  Saat giliranmu di JakLudo, bidak dengan posisi paling menguntungkan otomatis menyala. Kalau ada lebih dari dua opsi bagus, urutannya langsung ditandai dari <strong>#1</strong>, <strong>#2</strong>, sampai <strong>#3</strong>—mulai dari peluang makan lawan, masuk jalur aman, sampai menghindari Black Hole.
                </>
              )}
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

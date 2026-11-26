import React, { useEffect, useState } from 'react';
import Modal from './Modal';
import { LudoSkinTokenInner, resolveSkinKey } from './game/LudoSkinPawn';
import { hasOceanBlueHintAbility } from '../utils/oceanBlueHints.mjs';

const FIRE_PHOENIX_SKIN = {
  id: 'fire_phoenix',
  name: 'Fire Phoenix',
  assetKey: 'fire_phoenix',
  accentColor: '#f97316'
};

const LEGENDARY_DIAMOND_SKIN = {
  id: 'legendary_diamond',
  name: 'Legendary Diamond',
  assetKey: 'legendary_diamond',
  accentColor: '#38bdf8'
};

const CLASSIC_GOLD_SKIN = {
  id: 'classic_gold',
  name: 'Classic Gold',
  assetKey: 'classic_gold',
  accentColor: '#f59e0b'
};

const RUBY_CRYSTAL_SKIN = {
  id: 'ruby_crystal',
  name: 'Ruby Crystal',
  assetKey: 'ruby_crystal',
  accentColor: '#ef4444'
};

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
  const [activeTab, setActiveTab] = useState('all');
  const [selectedComboSkin, setSelectedComboSkin] = useState('fire_phoenix');
  const [selectedInvisibleSkin, setSelectedInvisibleSkin] = useState('classic_gold');
  const [selectedShieldSkin, setSelectedShieldSkin] = useState('emerald_green');

  useEffect(() => {
    if (isOpen) setActiveTab('all');
  }, [isOpen]);

  const equippedKey = resolveSkinKey(user?.equippedLudoSkin);
  const hasComboEquipped = equippedKey === 'fire_phoenix' || equippedKey === 'legendary_diamond';
  const hasInvisibleEquipped = hasComboEquipped || equippedKey === 'classic_gold' || equippedKey === 'ruby_crystal';
  const hasShieldEquipped = hasComboEquipped || equippedKey === 'emerald_green' || equippedKey === 'galaxy_purple';
  const hasOceanEquipped = hasOceanBlueHintAbility(user?.equippedLudoSkin);
  const isActiveEquipped =
    activeTab === 'all'
      ? hasComboEquipped
      : activeTab === 'invisible'
      ? hasInvisibleEquipped
      : activeTab === 'shield'
      ? hasShieldEquipped
      : hasOceanEquipped;

  const targetShopSkin =
    activeTab === 'all'
      ? selectedComboSkin
      : activeTab === 'invisible'
      ? selectedInvisibleSkin
      : activeTab === 'shield'
      ? selectedShieldSkin
      : 'ocean_blue';

  const modalIcon =
    activeTab === 'all' ? '👑' : activeTab === 'invisible' ? '👻' : activeTab === 'shield' ? '🛡️' : '🌊';
  const modalSubtitle =
    activeTab === 'all'
      ? 'Fire Phoenix & Legendary Diamond'
      : activeTab === 'invisible'
      ? 'Classic Gold & Ruby Crystal'
      : activeTab === 'shield'
      ? 'Emerald Green & Galaxy Purple'
      : 'Skin Ocean Blue';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      size="sm"
      icon={modalIcon}
      title="Kemampuan Skin JakLudo"
      subtitle={modalSubtitle}
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
              onClick={() => onOpenShop(targetShopSkin)}
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
            aria-selected={activeTab === 'all'}
            className={`skin-intro-tab ${activeTab === 'all' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('all')}
          >
            👑 All Skills
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'invisible'}
            className={`skin-intro-tab ${activeTab === 'invisible' ? 'is-active' : ''}`}
            onClick={() => setActiveTab('invisible')}
          >
            👻 Invisible
          </button>
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

        {activeTab === 'all' ? (
          <>
            <div className="ocean-intro-modal__meta">
              <span className="badge badge--phoenix-ability">👑 All Skills (3-in-1)</span>
              <button
                type="button"
                className={`skin-intro-pick skin-intro-pick--phoenix ${selectedComboSkin === 'fire_phoenix' ? 'is-selected' : ''}`}
                onClick={() => setSelectedComboSkin('fire_phoenix')}
              >
                Fire Phoenix · 40 💎
              </button>
              <button
                type="button"
                className={`skin-intro-pick skin-intro-pick--diamond ${selectedComboSkin === 'legendary_diamond' ? 'is-selected' : ''}`}
                onClick={() => setSelectedComboSkin('legendary_diamond')}
              >
                Legendary Diamond · 50 💎
              </button>
              {hasComboEquipped && <span className="badge badge--success">Sedang kamu pakai</span>}
            </div>

            <div className="ocean-board-card" aria-hidden="true">
              <div className="ocean-board-strip">
                <div className="ocean-board-tile">
                  <div className="ocean-spot-pawn combo-spot-pawn--phoenix" data-skin="fire_phoenix">
                    <LudoSkinTokenInner skin={FIRE_PHOENIX_SKIN} number={1} />
                    <span className="ocean-spot-rank combo-spot-badge--phoenix">#1</span>
                  </div>
                </div>

                <div className="ocean-board-tile">
                  <div className="ocean-spot-pawn combo-spot-pawn--diamond" data-skin="legendary_diamond">
                    <LudoSkinTokenInner skin={LEGENDARY_DIAMOND_SKIN} number={4} />
                    <span className="ocean-spot-rank combo-spot-badge--diamond">🛡️</span>
                  </div>
                </div>

                <div className="ocean-board-tile ocean-board-tile--combo-ghost">
                  <strong className="invisible-charge-ratio">👻 2x</strong>
                  <span className="invisible-charge-note">Invisible</span>
                </div>

                <div className="ocean-board-tile ocean-board-tile--combo-shield">
                  <strong className="shield-charge-ratio">🛡️ 1→3</strong>
                  <span className="shield-charge-note">Anti-Elim</span>
                </div>
              </div>

              <div className="ocean-board-caption">
                <span className="ocean-board-note ocean-board-note--phoenix">
                  <strong>🌊 #1-#3</strong> Hint Terbaik
                </span>
                <span className="ocean-board-note">
                  <strong>🛡️ Maks. 3</strong> Anti-Eliminasi
                </span>
                <span className="ocean-board-note">
                  <strong>👻 2x</strong> Invisible
                </span>
              </div>
            </div>

            <p className="ocean-intro-modal__desc">
              {hasComboEquipped ? (
                <>
                  Skin <strong>{equippedKey === 'legendary_diamond' ? 'Legendary Diamond' : 'Fire Phoenix'}</strong> yang sedang kamu pakai menggabungkan seluruh kemampuan skin JakLudo sekaligus: <strong>Hint Langkah Terbaik</strong>, <strong>Anti-Eliminasi</strong> (1x awal laga, +1 tiap bidak finish, maks. 3), dan <strong>Invisible</strong> (2x per laga).
                </>
              ) : (
                <>
                  Menggabungkan semua kemampuan skin JakLudo dalam satu bidak: <strong>Hint Langkah Terbaik (#1-#3)</strong>, <strong>Anti-Eliminasi</strong> (konfirmasi saat diinjak/Force Return, 1→3 per laga), dan <strong>Invisible</strong> (2x per laga selama 1 putaran).
                </>
              )}
            </p>
          </>
        ) : activeTab === 'invisible' ? (
          <>
            <div className="ocean-intro-modal__meta">
              <span className="badge badge--gold-ability">👻 Invisible (2x)</span>
              <button
                type="button"
                className={`skin-intro-pick skin-intro-pick--gold ${selectedInvisibleSkin === 'classic_gold' ? 'is-selected' : ''}`}
                onClick={() => setSelectedInvisibleSkin('classic_gold')}
              >
                Classic Gold · 10 💎
              </button>
              <button
                type="button"
                className={`skin-intro-pick skin-intro-pick--ruby ${selectedInvisibleSkin === 'ruby_crystal' ? 'is-selected' : ''}`}
                onClick={() => setSelectedInvisibleSkin('ruby_crystal')}
              >
                Ruby Crystal · 15 💎
              </button>
              {hasInvisibleEquipped && <span className="badge badge--success">Aktif di skinmu</span>}
            </div>

            <div className="ocean-board-card" aria-hidden="true">
              <div className="ocean-board-strip">
                <div className="ocean-board-tile">
                  <div className="ocean-spot-pawn invisible-spot-pawn invisible-spot-pawn--gold" data-skin="classic_gold">
                    <LudoSkinTokenInner skin={CLASSIC_GOLD_SKIN} number={2} />
                    <span className="ocean-spot-rank invisible-spot-badge--gold">👻</span>
                  </div>
                </div>

                <div className="ocean-board-tile">
                  <div className="ocean-spot-pawn invisible-spot-pawn invisible-spot-pawn--ruby" data-skin="ruby_crystal">
                    <LudoSkinTokenInner skin={RUBY_CRYSTAL_SKIN} number={4} />
                    <span className="ocean-spot-rank invisible-spot-badge--ruby">👻</span>
                  </div>
                </div>

                <div className="ocean-board-tile ocean-board-tile--star">
                  <span className="ocean-board-tile__star">★</span>
                  <span className="shield-charge-note">1 putaran</span>
                </div>

                <div className="ocean-board-tile ocean-board-tile--ghost">
                  <strong className="invisible-charge-ratio">2x</strong>
                  <span className="invisible-charge-note">per laga</span>
                </div>
              </div>

              <div className="ocean-board-caption">
                <span className="ocean-board-note ocean-board-note--gold">
                  <strong>2x</strong> Batas pakai
                </span>
                <span className="ocean-board-note">
                  <strong>1 putaran</strong> Tersembunyi
                </span>
                <span className="ocean-board-note">
                  <strong>Aman</strong> Force Return
                </span>
              </div>
            </div>

            <p className="ocean-intro-modal__desc">
              {hasInvisibleEquipped ? (
                <>
                  Skin yang sedang kamu pakai memiliki skill <strong>Invisible</strong>. Aktifkan di giliranmu sebelum melempar dadu agar seluruh bidakmu tidak terlihat musuh selama <strong>1 putaran</strong> penuh (tetap tereliminasi jika kebetulan diinjak musuh). Maksimal <strong>2 kali</strong> penggunaan per permainan.
                </>
              ) : (
                <>
                  Sembunyikan seluruh posisi bidakmu dari layar musuh—tidak terlihat langkahnya dan tidak bisa ditarget <strong>Force Return</strong> selama <strong>1 putaran</strong> penuh (tetap tereliminasi jika kebetulan diinjak musuh). Aktifkan sebelum melempar dadu, berlaku maksimal <strong>2 kali</strong> saja per permainan.
                </>
              )}
            </p>
          </>
        ) : activeTab === 'shield' ? (
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
              {hasShieldEquipped && <span className="badge badge--success">Aktif di skinmu</span>}
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
                  Skin yang sedang kamu pakai memberimu skill <strong>Anti-Eliminasi</strong> saat diinjak atau terkena <strong>Force Return</strong> lawan. Setiap mau dipakai akan muncul konfirmasi lebih dulu, bertambah <strong>+1</strong> saat bidakmu masuk garis finish (maks. <strong>3</strong>), dan hanya berlaku di pertandingan tersebut.
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
                <span className="badge badge--success">Aktif di skinmu</span>
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
                  Skin yang sedang kamu pakai kini otomatis menyorot bidak dengan peluang posisi paling menguntungkan saat giliranmu. Jika ada lebih dari dua pilihan bagus, urutannya langsung ditandai dari <strong>#1</strong>, <strong>#2</strong>, sampai <strong>#3</strong>.
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

import React from 'react';

export const LUDO_SKIN_META = {
  classic_gold: {
    id: 'classic_gold',
    name: 'Classic Gold',
    rarity: 'Common',
    accent: '#f59e0b',
    ringColor: '#fde68a',
    glow: 'rgba(245, 158, 11, 0.5)',
    abilityIcon: '👻',
    abilityTone: 'gold',
    abilityLabel: 'Invisible (2x)',
    abilityDetail: 'Bidak tidak terlihat musuh & kebal target Force Return selama 1 putaran (maks. 2x per game, tetap tereliminasi bila kebetulan diinjak).'
  },
  ruby_crystal: {
    id: 'ruby_crystal',
    name: 'Ruby Crystal',
    rarity: 'Common',
    accent: '#ef4444',
    ringColor: '#fecaca',
    glow: 'rgba(239, 68, 68, 0.5)',
    abilityIcon: '👻',
    abilityTone: 'ruby',
    abilityLabel: 'Invisible (2x)',
    abilityDetail: 'Bidak tidak terlihat musuh & kebal target Force Return selama 1 putaran (maks. 2x per game, tetap tereliminasi bila kebetulan diinjak).'
  },
  ocean_blue: {
    id: 'ocean_blue',
    name: 'Ocean Blue',
    rarity: 'Rare',
    accent: '#0ea5e9',
    ringColor: '#bae6fd',
    glow: 'rgba(14, 165, 233, 0.55)',
    abilityIcon: '🌊',
    abilityTone: 'ocean',
    abilityLabel: 'Hint Langkah Terbaik',
    abilityDetail: 'Menyorot bidak dengan peluang posisi paling menguntungkan dan mengurutkannya (#1, #2, #3) saat giliranmu.'
  },
  emerald_green: {
    id: 'emerald_green',
    name: 'Emerald Green',
    rarity: 'Rare',
    accent: '#10b981',
    ringColor: '#a7f3d0',
    glow: 'rgba(16, 185, 129, 0.55)',
    abilityIcon: '🛡️',
    abilityTone: 'emerald',
    abilityLabel: 'Anti-Eliminasi (Maks. 3)',
    abilityDetail: 'Menahan eliminasi dari injakan & Force Return dengan konfirmasi (1x awal laga, +1 tiap bidak finish, maks. 3, hanya 1 laga).'
  },
  galaxy_purple: {
    id: 'galaxy_purple',
    name: 'Galaxy Purple',
    rarity: 'Epic',
    accent: '#8b5cf6',
    ringColor: '#ddd6fe',
    glow: 'rgba(139, 92, 246, 0.6)',
    abilityIcon: '🛡️',
    abilityTone: 'galaxy',
    abilityLabel: 'Anti-Eliminasi (Maks. 3)',
    abilityDetail: 'Menahan eliminasi dari injakan & Force Return dengan konfirmasi (1x awal laga, +1 tiap bidak finish, maks. 3, hanya 1 laga).'
  },
  fire_phoenix: {
    id: 'fire_phoenix',
    name: 'Fire Phoenix',
    rarity: 'Epic',
    accent: '#f97316',
    ringColor: '#fed7aa',
    glow: 'rgba(249, 115, 22, 0.65)',
    abilityIcon: '🔥',
    abilityTone: 'phoenix',
    abilityLabel: 'All Skills (3-in-1)',
    abilityDetail: 'Gabungan semua skill: Hint Langkah Terbaik, Anti-Eliminasi (1x awal, +1 tiap finish, maks. 3), dan Invisible (2x per game).'
  },
  legendary_diamond: {
    id: 'legendary_diamond',
    name: 'Legendary Diamond',
    rarity: 'Legendary',
    accent: '#38bdf8',
    ringColor: '#e0f2fe',
    glow: 'rgba(56, 189, 248, 0.75)',
    abilityIcon: '💎',
    abilityTone: 'diamond',
    abilityLabel: 'All Skills (3-in-1)',
    abilityDetail: 'Gabungan semua skill: Hint Langkah Terbaik, Anti-Eliminasi (1x awal, +1 tiap finish, maks. 3), dan Invisible (2x per game).'
  }
};

export function resolveSkinKey(skin) {
  if (!skin) return '';
  if (typeof skin === 'string') return skin;
  return skin.assetKey || skin.id || '';
}

export function getSkinAbilityInfo(skin) {
  const meta = LUDO_SKIN_META[resolveSkinKey(skin)];
  if (!meta?.abilityLabel) {
    return {
      hasSkill: false,
      icon: '✨',
      tone: 'neutral',
      label: 'Kosmetik Eksklusif',
      detail: 'Tampilan bidak khusus tanpa skill aktif.'
    };
  }
  return {
    hasSkill: true,
    icon: meta.abilityIcon || '✨',
    tone: meta.abilityTone || 'ocean',
    label: meta.abilityLabel,
    detail: meta.abilityDetail || ''
  };
}

function SkinMotifSvg({ skinKey, accentColor }) {
  switch (skinKey) {
    case 'classic_gold':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <circle cx="12" cy="12" r="10.2" fill="rgba(251,191,36,0.22)" stroke="#fde68a" strokeWidth="1.4" />
          <path d="M5.5 16.5L4.5 8.5L9 11.5L12 6.5L15 11.5L19.5 8.5L18.5 16.5H5.5Z" fill="#fde047" stroke="#b45309" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
      );
    case 'ruby_crystal':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <polygon points="12,3 19.5,9.5 16.5,20 7.5,20 4.5,9.5" fill="rgba(244,63,94,0.3)" stroke="#fecdd3" strokeWidth="1.4" />
          <polygon points="12,5.5 17,10 14.8,18 9.2,18 7,10" fill="#fb7185" stroke="#9f1239" strokeWidth="1.1" />
          <polyline points="7,10 17,10" stroke="#ffe4e6" strokeWidth="1.1" />
        </svg>
      );
    case 'ocean_blue':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="rgba(14,165,233,0.28)" stroke="#bae6fd" strokeWidth="1.4" />
          <path d="M12 4.8C15 9 17.5 11.8 17.5 14.8A5.5 5.5 0 1 1 6.5 14.8C6.5 11.8 9 9 12 4.8Z" fill="#38bdf8" stroke="#0369a1" strokeWidth="1.2" />
          <circle cx="10.5" cy="14" r="1.4" fill="#e0f2fe" />
        </svg>
      );
    case 'emerald_green':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <polygon points="12,3.5 19,8 19,16 12,20.5 5,16 5,8" fill="rgba(16,185,129,0.28)" stroke="#a7f3d0" strokeWidth="1.4" />
          <polygon points="12,6.2 16.2,9.2 16.2,14.8 12,17.8 7.8,14.8 7.8,9.2" fill="#34d399" stroke="#047857" strokeWidth="1.1" />
        </svg>
      );
    case 'galaxy_purple':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="rgba(139,92,246,0.3)" stroke="#ddd6fe" strokeWidth="1.3" />
          <ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(-24 12 12)" fill="none" stroke="#e9d5ff" strokeWidth="1.4" />
          <polygon points="12,6.8 13.4,10.5 17.2,10.7 14.2,13 15.2,16.8 12,14.6 8.8,16.8 9.8,13 6.8,10.7 10.6,10.5" fill="#c4b5fd" stroke="#5b21b6" strokeWidth="0.9" />
        </svg>
      );
    case 'fire_phoenix':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <circle cx="12" cy="12" r="10" fill="rgba(249,115,22,0.3)" stroke="#fed7aa" strokeWidth="1.3" />
          <path d="M12.5 4.2C14.8 7 18.2 9.2 17.2 14.2C16.6 17.3 14.4 19.2 12 19.2C8.8 19.2 6.8 16.6 6.8 13.7C6.8 11.1 8.4 9.2 9.4 7.8C9.6 9.4 10.6 10.2 11.4 9.5C11.1 7.6 11.7 5.6 12.5 4.2Z" fill="#fb923c" stroke="#9a3412" strokeWidth="1.1" />
          <path d="M12 12.2C13.4 13.4 13.9 15 12.9 16.5C12.3 17.3 11 17.2 10.6 16.1C10.2 15 10.8 13.5 12 12.2Z" fill="#fef08a" />
        </svg>
      );
    case 'legendary_diamond':
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <polygon points="7,4.2 17,4.2 21,9.5 12,20.5 3,9.5" fill="rgba(56,189,248,0.38)" stroke="#f0f9ff" strokeWidth="1.5" />
          <polyline points="3,9.5 21,9.5" stroke="#bae6fd" strokeWidth="1.2" />
          <polyline points="8.5,4.2 7.5,9.5 12,20.5 16.5,9.5 15.5,4.2" stroke="#e0f2fe" strokeWidth="1.1" />
          <path d="M12 6.5L13 8.8L15.3 9L13.5 10.5L14 12.8L12 11.5L10 12.8L10.5 10.5L8.7 9L11 8.8Z" fill="#ffffff" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" className="pawn-skin-svg" aria-hidden="true">
          <circle cx="12" cy="12" r="9.5" fill="rgba(255,255,255,0.22)" stroke={accentColor || '#fbbf24'} strokeWidth="1.5" />
          <polygon points="12,5.5 14.3,10 19,10.7 15.5,14 16.4,18.7 12,16.4 7.6,18.7 8.5,14 5,10.7 9.7,10" fill={accentColor || '#fbbf24'} />
        </svg>
      );
  }
}

export function LudoSkinTokenInner({ skin, number }) {
  const skinKey = resolveSkinKey(skin);
  if (!skinKey) {
    return <span className="pawn-inner">{number}</span>;
  }

  const meta = LUDO_SKIN_META[skinKey] || {};
  const accent = skin?.accentColor || meta.accent || '#fbbf24';

  return (
    <span
      className={`pawn-inner pawn-inner--skinned pawn-skin--${skinKey}`}
      style={{ '--skin-accent': accent }}
      title={skin?.name || meta.name || skinKey}
    >
      {skin?.imageUrl ? (
        <img src={skin.imageUrl} alt="" className="pawn-skin-img" />
      ) : (
        <SkinMotifSvg skinKey={skinKey} accentColor={accent} />
      )}
      <span className="pawn-skin-num">{number}</span>
    </span>
  );
}

export function LudoSkinBaseEmblem({ skin, style }) {
  const skinKey = resolveSkinKey(skin);
  if (!skinKey) return null;

  const meta = LUDO_SKIN_META[skinKey] || {};
  const accent = skin?.accentColor || meta.accent || '#fbbf24';

  return (
    <span className="base-skin-emblem" style={style} aria-hidden="true">
      <SkinMotifSvg skinKey={skinKey} accentColor={accent} />
    </span>
  );
}

export function LudoSkinPreview({ skin, size = 56, teamColor = 'blue' }) {
  const skinKey = resolveSkinKey(skin);
  const meta = LUDO_SKIN_META[skinKey] || {};
  const accent = skin?.accentColor || meta.accent || '#fbbf24';

  return (
    <div
      className={`skin-preview skin-preview--${teamColor} ${skinKey ? `skin-preview--${skinKey}` : ''}`}
      style={{ width: size, height: size, '--skin-accent': accent }}
    >
      {skinKey ? (
        <LudoSkinTokenInner skin={skin} number={1} />
      ) : (
        <span className="pawn-inner">1</span>
      )}
    </div>
  );
}

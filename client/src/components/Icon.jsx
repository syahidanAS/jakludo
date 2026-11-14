import React from 'react';

// Pemetaan emoji lama / nama item ke nama ikon vektor bertema papan JakLudo
const EMOJI_TO_ICON = {
  '👥': 'friends',
  '💬': 'chat',
  '🏪': 'shop',
  '🛒': 'shop',
  '🏆': 'trophy',
  '👑': 'crown',
  '💎': 'coin',
  '🪙': 'coin',
  '💰': 'coin',
  '🎲': 'dice',
  '🔔': 'bell',
  '🔊': 'volume-on',
  '🔇': 'volume-off',
  '☀️': 'sun',
  '🌙': 'moon',
  '🌗': 'theme-auto',
  '📷': 'camera',
  '🎙️': 'mic',
  '📲': 'install',
  '🛡️': 'shield',
  '🔰': 'shield-universal',
  '⚡': 'bolt',
  '🕳️': 'vortex',
  '📊': 'chart',
  '⚠️': 'warning',
  '👁️': 'eye',
  '🙈': 'eye-off',
  '✕': 'close',
  '✓': 'check',
  '🥇': 'medal-1',
  '🥈': 'medal-2',
  '🥉': 'medal-3',
  '🎯': 'pawn',
  '🤖': 'bot',
  '🔄': 'extra-turn',
  '💥': 'force-return',
  '💡': 'bulb',
  '❤️': 'heart',
  '✏️': 'edit',
  '🚪': 'logout',
  '♟️': 'chess',
  '♞': 'chess',
  '🏳️': 'flag',
  '⏱️': 'clock',
  '🐍': 'snakes',
  '🪜': 'snakes'
};

export function resolveIconName(nameOrEmoji) {
  if (!nameOrEmoji) return null;
  const clean = String(nameOrEmoji).trim();
  return EMOJI_TO_ICON[clean] || clean;
}

// Set ikon vektor kustom bertema papan permainan JakLudo (garis tinta tegas 2.2px + aksen duotone hangat)
export default function Icon({ name, size = 20, className = '', label }) {
  const resolved = resolveIconName(name);
  if (!resolved) return null;

  const a11yProps = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': 'true', focusable: 'false' };

  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: '2.2',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    className: `jl-icon jl-icon--${resolved} ${className}`.trim(),
    ...a11yProps
  };

  switch (resolved) {
    case 'home':
      return (
        <svg {...common}>
          <path d="M3.5 10.5 12 3.5l8.5 7v9a1.5 1.5 0 0 1-1.5 1.5h-14A1.5 1.5 0 0 1 3.5 19.5v-9Z" />
          <path d="M9.5 21v-6a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v6" />
        </svg>
      );

    case 'friends':
      return (
        <svg {...common}>
          <circle cx="9" cy="7.5" r="3.5" fill="var(--brand-soft)" />
          <path d="M2.5 19.5c0-3.1 2.9-5.5 6.5-5.5s6.5 2.4 6.5 5.5" fill="var(--brand-soft)" />
          <circle cx="17" cy="8.5" r="2.8" />
          <path d="M16 14.2c3 .3 5.5 2.3 5.5 5.3" />
        </svg>
      );

    case 'user-plus':
      return (
        <svg {...common}>
          <circle cx="9.5" cy="8" r="3.5" fill="var(--brand-soft)" />
          <path d="M3 19.5c0-3.2 2.9-5.5 6.5-5.5s6.5 2.3 6.5 5.5" />
          <path d="M19 8v6M16 11h6" />
        </svg>
      );

    case 'chat':
      return (
        <svg {...common}>
          <path
            d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5v-8Z"
            fill="var(--brand-soft)"
          />
          <circle cx="8.5" cy="9.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="12" cy="9.5" r="1" fill="currentColor" stroke="none" />
          <circle cx="15.5" cy="9.5" r="1" fill="currentColor" stroke="none" />
        </svg>
      );

    case 'shop':
      return (
        <svg {...common}>
          <path d="M3 9.5 4.8 4h14.4L21 9.5" fill="var(--brand-soft)" />
          <path d="M3 9.5c0 1.4 1.1 2.5 2.5 2.5S8 10.9 8 9.5c0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5c0 1.4 1.1 2.5 2.5 2.5s2.5-1.1 2.5-2.5c0 1.4 1.1 2.5 2.5 2.5S21 10.9 21 9.5" />
          <path d="M5 12v8h14v-8" />
          <rect x="9.5" y="14.5" width="5" height="5.5" fill="var(--brand-soft)" />
        </svg>
      );

    case 'trophy':
      return (
        <svg {...common}>
          <path d="M7 4h10v5a5 5 0 0 1-10 0V4Z" fill="var(--brand-soft)" />
          <path d="M7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3" />
          <path d="M12 14v4M8 20h8" />
        </svg>
      );

    case 'crown':
      return (
        <svg {...common}>
          <path d="m3 17 2-10 4.5 4L12 5l2.5 6L19 7l2 10H3Z" fill="var(--brand-soft)" />
          <path d="M4 20h16" />
        </svg>
      );

    case 'coin':
    case 'coins':
    case 'diamond':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="9" fill="var(--brand-soft)" />
          <circle cx="12" cy="12" r="6.2" strokeWidth="1.5" />
          <path d="M12 7.8l1.1 2.7 2.9.2-2.3 1.9.8 2.8-2.5-1.6-2.5 1.6.8-2.8-2.3-1.9 2.9-.2Z" fill="currentColor" stroke="none" />
        </svg>
      );

    case 'dice':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="var(--brand-soft)" />
          <circle cx="8.5" cy="8.5" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="15.5" cy="8.5" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="8.5" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
          <circle cx="15.5" cy="15.5" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );

    case 'bell':
      return (
        <svg {...common}>
          <path
            d="M6 10a6 6 0 0 1 12 0c0 4.5 2 6 2 6H4s2-1.5 2-6Z"
            fill="var(--brand-soft)"
          />
          <path d="M10 19a2 2 0 0 0 4 0" />
        </svg>
      );

    case 'volume-on':
      return (
        <svg {...common}>
          <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="var(--brand-soft)" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" />
        </svg>
      );

    case 'volume-off':
      return (
        <svg {...common}>
          <path d="M11 5 6 9H3v6h3l5 4V5Z" fill="var(--brand-soft)" />
          <path d="m16 9 5 6M21 9l-5 6" />
        </svg>
      );

    case 'sun':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="4.5" fill="var(--brand-soft)" />
          <path d="M12 2.5v2.5M12 19v2.5M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2.5 12H5M19 12h2.5M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
        </svg>
      );

    case 'moon':
      return (
        <svg {...common}>
          <path
            d="M20.5 14.5A8.5 8.5 0 0 1 9.5 3.5a8.5 8.5 0 1 0 11 11Z"
            fill="var(--brand-soft)"
          />
        </svg>
      );

    case 'theme-auto':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M12 3.5a8.5 8.5 0 0 1 0 17V3.5Z" fill="var(--brand-soft)" />
        </svg>
      );

    case 'camera':
      return (
        <svg {...common}>
          <path
            d="M4 8h3l1.8-2.5h6.4L17 8h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z"
            fill="var(--brand-soft)"
          />
          <circle cx="12" cy="13.5" r="3.5" />
        </svg>
      );

    case 'mic':
      return (
        <svg {...common}>
          <rect x="9" y="3" width="6" height="11" rx="3" fill="var(--brand-soft)" />
          <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
        </svg>
      );

    case 'heart':
      return (
        <svg {...common}>
          <path
            d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"
            fill="var(--danger-soft)"
          />
        </svg>
      );

    case 'play':
      return (
        <svg {...common}>
          <polygon points="6 4 20 12 6 20 6 4" fill="currentColor" />
        </svg>
      );

    case 'pause':
      return (
        <svg {...common}>
          <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" />
          <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" />
        </svg>
      );

    case 'send':
      return (
        <svg {...common}>
          <path d="m21 3-9.5 18-2.8-7.7L1 10.5 21 3Z" fill="var(--brand-soft)" />
          <path d="M21 3 8.7 13.3" />
        </svg>
      );

    case 'install':
      return (
        <svg {...common}>
          <rect x="6" y="2.5" width="12" height="19" rx="2.5" fill="var(--brand-soft)" />
          <path d="M12 8v6M9.5 11.5 12 14l2.5-2.5M10 18h4" />
        </svg>
      );

    case 'shield-universal':
      // Perisai serbaguna (Universal Shield): bintang menandakan melindungi dari semua serangan
      return (
        <svg {...common}>
          <path
            d="M12 3 4.5 6v5.5c0 5 3.2 8.5 7.5 9.5 4.3-1 7.5-4.5 7.5-9.5V6L12 3Z"
            fill="var(--brand-soft)"
          />
          <path d="m12 7.8 1.25 2.55 2.8.4-2.03 1.98.48 2.8L12 14.2l-2.5 1.33.48-2.8-2.03-1.98 2.8-.4L12 7.8Z" />
        </svg>
      );

    case 'shield':
      return (
        <svg {...common}>
          <path
            d="M12 3 4.5 6v5.5c0 5 3.2 8.5 7.5 9.5 4.3-1 7.5-4.5 7.5-9.5V6L12 3Z"
            fill="var(--brand-soft)"
          />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );

    case 'bolt':
    case 'extra-turn':
      return (
        <svg {...common}>
          <polygon points="13 2 4 14 11 14 10 22 20 10 13 10 13 2" fill="var(--brand-soft)" />
        </svg>
      );

    case 'force-return':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" fill="var(--brand-soft)" />
          <path d="m9 9 6 6M15 9l-6 6" />
        </svg>
      );

    case 'vortex':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" fill="var(--brand-soft)" />
          <circle cx="12" cy="12" r="4.5" />
          <circle cx="12" cy="12" r="1.5" fill="currentColor" />
        </svg>
      );

    case 'chart':
      return (
        <svg {...common}>
          <rect x="4" y="12" width="4" height="8" rx="1" fill="var(--brand-soft)" />
          <rect x="10" y="6" width="4" height="14" rx="1" fill="var(--brand-soft)" />
          <rect x="16" y="9" width="4" height="11" rx="1" fill="var(--brand-soft)" />
        </svg>
      );

    case 'warning':
      return (
        <svg {...common}>
          <path
            d="M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"
            fill="var(--brand-soft)"
          />
          <path d="M12 9v4.5M12 17h.01" />
        </svg>
      );

    case 'eye':
      return (
        <svg {...common}>
          <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" fill="var(--brand-soft)" />
          <circle cx="12" cy="12" r="3" />
        </svg>
      );

    case 'eye-off':
      return (
        <svg {...common}>
          <path d="M3 3l18 18M10.6 10.6a2.5 2.5 0 0 0 3.5 3.5" />
          <path d="M6.5 6.7C4 8.3 2 12 2 12s3.6 6.5 10 6.5c2 0 3.8-.6 5.3-1.5M14.5 5.8A10 10 0 0 1 22 12s-1.2 2.4-3.3 4.3" />
        </svg>
      );

    case 'close':
      return (
        <svg {...common}>
          <path d="M6 6l12 12M18 6 6 18" />
        </svg>
      );

    case 'check':
      return (
        <svg {...common}>
          <path d="m5 12.5 4.5 4.5L19 7.5" />
        </svg>
      );

    case 'plus':
      return (
        <svg {...common}>
          <path d="M12 5v14M5 12h14" />
        </svg>
      );

    case 'arrow-left':
      return (
        <svg {...common}>
          <path d="M19 12H5M11 6l-6 6 6 6" />
        </svg>
      );

    case 'reply':
      return (
        <svg {...common}>
          <path d="M9 14 4 9l5-5" />
          <path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11" />
        </svg>
      );

    case 'logout':
      return (
        <svg {...common}>
          <path d="M9 20H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5M21 12H9" />
        </svg>
      );

    case 'lock':
      return (
        <svg {...common}>
          <rect x="5" y="11" width="14" height="10" rx="2" fill="var(--brand-soft)" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
      );

    case 'mail':
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" fill="var(--brand-soft)" />
          <path d="m3 7 9 6 9-6" />
        </svg>
      );

    case 'edit':
      return (
        <svg {...common}>
          <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4 11.5-11.5Z" fill="var(--brand-soft)" />
        </svg>
      );

    case 'crop':
      return (
        <svg {...common}>
          <path d="M6.5 3v12.5a2 2 0 0 0 2 2H21" />
          <path d="M3 6.5h12.5a2 2 0 0 1 2 2V21" />
        </svg>
      );

    case 'rotate':
      return (
        <svg {...common}>
          <path d="M20 7.5a8.5 8.5 0 1 0 2 5.5" />
          <path d="M20 3v4.5h-4.5" />
        </svg>
      );

    case 'medal-1':
    case 'medal-2':
    case 'medal-3': {
      const rankNum = resolved.slice(-1);
      return (
        <svg {...common}>
          <path d="m8 3 4 5 4-5" />
          <circle cx="12" cy="14" r="6.5" fill="var(--brand-soft)" />
          <text
            x="12"
            y="16.5"
            textAnchor="middle"
            fontSize="8.5"
            fontWeight="800"
            fill="currentColor"
            stroke="none"
          >
            {rankNum}
          </text>
        </svg>
      );
    }

    case 'pawn':
    case 'target':
      return (
        <svg {...common}>
          <circle cx="12" cy="7.5" r="3.5" fill="var(--brand-soft)" />
          <path d="M7.5 19.5 9.2 12h5.6l1.7 7.5H7.5Z" fill="var(--brand-soft)" />
          <path d="M5.5 19.5h13" />
        </svg>
      );

    case 'bot':
      return (
        <svg {...common}>
          <path d="M12 3v3" />
          <rect x="4.5" y="6" width="15" height="13" rx="3" fill="var(--brand-soft)" />
          <circle cx="9.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <circle cx="14.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
          <path d="M9 16h6" />
        </svg>
      );

    case 'swords':
    case 'battle':
      return (
        <svg {...common}>
          <path d="M14.5 17.5 3 6V3h3l11.5 11.5" fill="var(--brand-soft)" />
          <path d="M13 19l6-6" />
          <path d="M16 16l4 4" />
          <path d="M19 21l2-2" />
          <path d="M9.5 17.5 21 6V3h-3L6.5 14.5" fill="var(--brand-soft)" />
          <path d="M11 19l-6-6" />
          <path d="M8 16l-4 4" />
          <path d="M5 21l-2-2" />
        </svg>
      );

    case 'bulb':
    case 'quizHint':
    case 'hint':
      return (
        <svg {...common}>
          <path
            d="M9 18h6M10 21h4M8.5 14.5A6 6 0 1 1 15.5 14.5c-.7.6-1.3 1.5-1.5 2.5h-4c-.2-1-.8-1.9-1.5-2.5Z"
            fill="var(--brand-soft)"
          />
          <path d="M12 8v3" />
        </svg>
      );

    case 'chess':
    case 'knight':
      return (
        <svg {...common}>
          <path
            d="M7 20h10M8 17h8l-1-4.5c1.8-.8 3-2.5 3-4.8 0-2.6-2.1-4.7-4.7-4.7-.8 0-1.5.2-2.2.6L9.5 2.5 8 5.2C6.5 6.4 6 8.2 6 9.8l2.5 1.2L7 13.5 9.5 14 8 17Z"
            fill="var(--brand-soft)"
          />
          <circle cx="11.5" cy="7.5" r="0.9" fill="currentColor" stroke="none" />
        </svg>
      );

    case 'flag':
      return (
        <svg {...common}>
          <path d="M5 21V4" />
          <path d="M5 4h12l-2.5 4.5L17 13H5" fill="var(--brand-soft)" />
        </svg>
      );

    case 'clock':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="8.5" fill="var(--brand-soft)" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );

    case 'download':
      return (
        <svg {...common}>
          <path d="M12 3v12m0 0-4-4m4 4 4-4" />
          <path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2" />
        </svg>
      );

    case 'snakes':
    case 'ladder':
      return (
        <svg {...common}>
          <path d="M6 3v18M13 3v18M6 7h7M6 12h7M6 17h7" />
          <path d="M17 4c2.5 1.5 2.5 4.5 0 6s-2.5 4.5 0 6 2.5 3.5 0 5" />
          <circle cx="17" cy="4" r="1.2" fill="currentColor" stroke="none" />
        </svg>
      );

    default:
      return null;
  }
}

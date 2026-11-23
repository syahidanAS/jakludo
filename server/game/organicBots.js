// Identitas pemain organik & generator avatar SVG deterministik untuk matchmaking JakLudo.
const crypto = require('crypto');
const { nextFreeColor } = require('./rules');

const ORGANIC_PERSONAS = Object.freeze([
  { name: 'bang_iki', username: 'bang_iki' },
  { name: 'nadz.id', username: 'nadz.id' },
  { name: 'dimss_07', username: 'dimss_07' },
  { name: 'caca_aja', username: 'caca_aja' },
  { name: 'kopisusu_', username: 'kopisusu_' },
  { name: 'dika_skuy', username: 'dika_skuy' },
  { name: 'rara_uwu', username: 'rara_uwu' },
  { name: 'kuy_mabar', username: 'kuy_mabar' },
  { name: 'yogzz_', username: 'yogzz_' },
  { name: 'ndut_jkt', username: 'ndut_jkt' },
  { name: 'fajar_gg', username: 'fajar_gg' },
  { name: 'ayuu.px', username: 'ayuu.px' },
  { name: 'bagas_kuy', username: 'bagas_kuy' },
  { name: 'tiara_id', username: 'tiara_id' },
  { name: 'ejaa_99', username: 'ejaa_99' },
  { name: 'dindaa.z', username: 'dindaa.z' },
  { name: 'bimzz_op', username: 'bimzz_op' },
  { name: 'alyaa_x', username: 'alyaa_x' },
  { name: 'kepin_pro', username: 'kepin_pro' },
  { name: 'intan_kuy', username: 'intan_kuy' },
  { name: 'gilang.sl', username: 'gilang.sl' },
  { name: 'citra_ez', username: 'citra_ez' },
  { name: 'putra_04', username: 'putra_04' },
  { name: 'siti_mabar', username: 'siti_mabar' },
  { name: 'dika_jkt', username: 'dika_jkt' },
  { name: 'mayaa.p', username: 'mayaa.p' },
  { name: 'bayu_gas', username: 'bayu_gas' },
  { name: 'vina_zz', username: 'vina_zz' },
  { name: 'hen_wkwk', username: 'hen_wkwk' },
  { name: 'laras_oy', username: 'laras_oy' },
  { name: 'ilham_21', username: 'ilham_21' },
  { name: 'nisaa_ku', username: 'nisaa_ku' },
  { name: 'arif_gas', username: 'arif_gas' },
  { name: 'tari_uwu', username: 'tari_uwu' },
  { name: 'melati.gg', username: 'melati.gg' },
  { name: 'santai_bro', username: 'santai_bro' }
]);

function pickOrganicPersona(usedNames = new Set(), usedUsernames = new Set()) {
  const candidates = ORGANIC_PERSONAS.filter(
    p => !usedNames.has(p.name.toLowerCase()) && !usedUsernames.has(p.username.toLowerCase())
  );
  if (candidates.length > 0) {
    return candidates[crypto.randomInt(0, candidates.length)];
  }
  const base = ORGANIC_PERSONAS[crypto.randomInt(0, ORGANIC_PERSONAS.length)];
  const suffix = String(crypto.randomInt(10, 99));
  return {
    name: `${base.name.slice(0, 12)}${suffix}`,
    username: `${base.username.slice(0, 14)}${suffix}`
  };
}

function createOrganicBotPlayer(room) {
  const usedNames = new Set((room?.players || []).map(p => String(p.name || '').toLowerCase()).filter(Boolean));
  const usedUsernames = new Set((room?.players || []).map(p => String(p.username || '').toLowerCase()).filter(Boolean));
  const persona = pickOrganicPersona(usedNames, usedUsernames);
  const id = 'p_' + crypto.randomBytes(6).toString('hex');
  const color = nextFreeColor(room?.players || []);

  return {
    id,
    userId: null,
    username: persona.username,
    name: persona.name,
    avatar: `/api/avatars/ava/${encodeURIComponent(persona.username)}.svg`,
    color,
    isHost: false,
    isBot: true,
    organicBot: true,
    isLudoKing: false,
    equippedSkin: null,
    connected: true,
    autoPlayCount: 0,
    isOut: false,
    items: {}
  };
}

const AVATAR_BG = ['#dbeafe', '#fce7f3', '#dcfce7', '#fef3c7', '#ede9fe', '#e0f2fe', '#ffedd5', '#f3e8ff'];
const SKIN_TONES = ['#f5d0b5', '#e8b896', '#d49a6a', '#f0c4a0', '#c68652'];
const HAIR_COLORS = ['#1e293b', '#3f2a1d', '#0f172a', '#5c3a21', '#2b2420'];
const SHIRT_COLORS = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0284c7', '#db2777', '#0f766e'];

function hashSeed(seed) {
  const str = String(seed || 'player');
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function renderOrganicAvatarSvg(seed) {
  const h = hashSeed(seed);
  const bg = AVATAR_BG[h % AVATAR_BG.length];
  const skin = SKIN_TONES[(h >>> 4) % SKIN_TONES.length];
  const hair = HAIR_COLORS[(h >>> 8) % HAIR_COLORS.length];
  const shirt = SHIRT_COLORS[(h >>> 12) % SHIRT_COLORS.length];
  const hairStyle = (h >>> 16) % 5;
  const mouthStyle = (h >>> 20) % 3;
  const hasGlasses = ((h >>> 23) & 3) === 0;

  let hairBack = '';
  let hairFront = '';
  if (hairStyle === 0) {
    hairFront = `<path d="M36 52 C36 28, 92 28, 92 52 C85 40, 43 40, 36 52 Z" fill="${hair}" />`;
  } else if (hairStyle === 1) {
    hairBack = `<path d="M32 54 C30 22, 98 22, 96 54 L98 94 C88 86, 40 86, 30 94 Z" fill="${hair}" />`;
    hairFront = `<path d="M36 48 C46 34, 82 34, 92 48 C78 44, 50 44, 36 48 Z" fill="${hair}" />`;
  } else if (hairStyle === 2) {
    hairFront = `<path d="M35 54 C35 24, 93 22, 93 52 C84 36, 68 42, 54 36 C44 42, 38 46, 35 54 Z" fill="${hair}" />`;
  } else if (hairStyle === 3) {
    hairBack = `<circle cx="64" cy="24" r="11" fill="${hair}" />`;
    hairFront = `<path d="M36 52 C36 28, 92 28, 92 52 C80 39, 48 39, 36 52 Z" fill="${hair}" />`;
  } else {
    hairFront = `<path d="M37 52 C38 26, 90 26, 91 52 C86 43, 72 37, 64 43 C54 37, 42 43, 37 52 Z" fill="${hair}" />`;
  }

  let mouth = '';
  if (mouthStyle === 0) {
    mouth = `<path d="M55 75 Q64 82 73 75" fill="none" stroke="#7c2d12" stroke-width="2.6" stroke-linecap="round" />`;
  } else if (mouthStyle === 1) {
    mouth = `<path d="M54 74 Q64 84 74 74 Z" fill="#ffffff" stroke="#7c2d12" stroke-width="1.8" stroke-linejoin="round" />`;
  } else {
    mouth = `<path d="M57 76 Q64 79 71 76" fill="none" stroke="#7c2d12" stroke-width="2.4" stroke-linecap="round" />`;
  }

  const glasses = hasGlasses
    ? `<g fill="none" stroke="#1e293b" stroke-width="2.2"><circle cx="53" cy="60" r="7.5" /><circle cx="75" cy="60" r="7.5" /><line x1="60.5" y1="60" x2="67.5" y2="60" /></g>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Avatar">
  <rect width="128" height="128" rx="64" fill="${bg}" />
  ${hairBack}
  <path d="M24 128 C26 98, 44 90, 64 90 C84 90, 102 98, 104 128 Z" fill="${shirt}" />
  <rect x="56" y="78" width="16" height="16" rx="6" fill="${skin}" />
  <circle cx="38" cy="61" r="5" fill="${skin}" />
  <circle cx="90" cy="61" r="5" fill="${skin}" />
  <circle cx="64" cy="59" r="26" fill="${skin}" />
  ${hairFront}
  <circle cx="53" cy="60" r="3" fill="#1e293b" />
  <circle cx="75" cy="60" r="3" fill="#1e293b" />
  <circle cx="54" cy="59" r="1" fill="#ffffff" />
  <circle cx="76" cy="59" r="1" fill="#ffffff" />
  ${glasses}
  ${mouth}
</svg>`;
}

module.exports = {
  ORGANIC_PERSONAS,
  pickOrganicPersona,
  createOrganicBotPlayer,
  renderOrganicAvatarSvg
};

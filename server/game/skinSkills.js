// Skill khusus skin per pertandingan JakLudo (non-persistent: tidak disimpan ke database akun).
// Emerald Green & Galaxy Purple: skill Anti-Eliminasi terhadap injakan dan Force Return lawan.
// Classic Gold & Ruby Crystal: skill Invisible (tidak terlihat oleh musuh) maksimal 2x per pertandingan.

const ANTI_ELIMINATION_SKINS = new Set(['emerald_green', 'galaxy_purple', 'fire_phoenix', 'legendary_diamond']);
const MAX_SKIN_SHIELD_CHARGES = 3;
const SKIN_ANTI_ELIMINATION_ID = 'skinAntiElimination';

const INVISIBLE_SKINS = new Set(['classic_gold', 'ruby_crystal', 'fire_phoenix', 'legendary_diamond']);
const MAX_SKIN_INVISIBLE_CHARGES = 2;
const SKIN_INVISIBLE_ID = 'skinInvisible';

function resolveSkinKey(skin) {
  if (!skin) return '';
  if (typeof skin === 'string') return skin;
  return skin.assetKey || skin.id || '';
}

function hasAntiEliminationSkin(skin) {
  return ANTI_ELIMINATION_SKINS.has(resolveSkinKey(skin));
}

function hasInvisibleSkin(skin) {
  return INVISIBLE_SKINS.has(resolveSkinKey(skin));
}

function skinDisplayName(skin) {
  const key = resolveSkinKey(skin);
  if (key === 'emerald_green') return 'Emerald Green';
  if (key === 'galaxy_purple') return 'Galaxy Purple';
  if (key === 'classic_gold') return 'Classic Gold';
  if (key === 'ruby_crystal') return 'Ruby Crystal';
  if (key === 'fire_phoenix') return 'Fire Phoenix';
  if (key === 'legendary_diamond') return 'Legendary Diamond';
  return skin?.name || 'Skin';
}

function canUseSkinAntiElimination(player) {
  return Boolean(
    player &&
    !player.isOut &&
    player.skinShieldEnabled &&
    hasAntiEliminationSkin(player.equippedSkin) &&
    Number(player.skinShieldCharges || 0) > 0
  );
}

function isSkinInvisibleActive(player) {
  return Boolean(
    player &&
    !player.isOut &&
    player.skinInvisibleEnabled &&
    hasInvisibleSkin(player.equippedSkin) &&
    player.skinInvisibleActive
  );
}

function isPlayerInvisibleTo(player, viewerId, { revealInvisible = false } = {}) {
  return Boolean(
    !revealInvisible &&
    viewerId &&
    player &&
    player.id !== viewerId &&
    isSkinInvisibleActive(player)
  );
}

function canUseSkinInvisible(player) {
  return Boolean(
    player &&
    !player.isOut &&
    player.skinInvisibleEnabled &&
    hasInvisibleSkin(player.equippedSkin) &&
    !player.skinInvisibleActive &&
    Number(player.skinInvisibleCharges || 0) > 0
  );
}

function initPlayerSkinSkill(player) {
  if (!player) return;
  const shieldEnabled = hasAntiEliminationSkin(player.equippedSkin);
  player.skinShieldEnabled = shieldEnabled;
  player.skinShieldCharges = shieldEnabled ? 1 : 0;

  const invisibleEnabled = hasInvisibleSkin(player.equippedSkin);
  player.skinInvisibleEnabled = invisibleEnabled;
  player.skinInvisibleCharges = invisibleEnabled ? MAX_SKIN_INVISIBLE_CHARGES : 0;
  player.skinInvisibleActive = false;
}

function clearPlayerSkinSkill(player) {
  if (!player) return;
  player.skinShieldEnabled = false;
  player.skinShieldCharges = 0;

  player.skinInvisibleEnabled = false;
  player.skinInvisibleCharges = 0;
  player.skinInvisibleActive = false;
}

function rechargeSkinAntiElimination(player) {
  if (!player || player.isOut || !player.skinShieldEnabled || !hasAntiEliminationSkin(player.equippedSkin)) {
    return { gained: false, charges: 0, max: MAX_SKIN_SHIELD_CHARGES };
  }
  const current = Math.max(0, Number(player.skinShieldCharges || 0));
  if (current >= MAX_SKIN_SHIELD_CHARGES) {
    player.skinShieldCharges = MAX_SKIN_SHIELD_CHARGES;
    return { gained: false, charges: MAX_SKIN_SHIELD_CHARGES, max: MAX_SKIN_SHIELD_CHARGES };
  }
  player.skinShieldCharges = current + 1;
  return { gained: true, charges: player.skinShieldCharges, max: MAX_SKIN_SHIELD_CHARGES };
}

function consumeSkinAntiElimination(player) {
  if (!canUseSkinAntiElimination(player)) return false;
  player.skinShieldCharges = Math.max(0, Number(player.skinShieldCharges || 0) - 1);
  return true;
}

function consumeSkinInvisible(player) {
  if (!canUseSkinInvisible(player)) return false;
  player.skinInvisibleCharges = Math.max(0, Number(player.skinInvisibleCharges || 0) - 1);
  player.skinInvisibleActive = true;
  return true;
}

function expireSkinInvisible(player) {
  if (!player?.skinInvisibleActive) return false;
  player.skinInvisibleActive = false;
  return true;
}

function publicSkinShield(player, room) {
  if (!player?.skinShieldEnabled || !hasAntiEliminationSkin(player.equippedSkin)) return null;
  if (!room?.started || room?.winner) return null;
  return {
    active: true,
    charges: Math.max(0, Math.min(MAX_SKIN_SHIELD_CHARGES, Number(player.skinShieldCharges || 0))),
    max: MAX_SKIN_SHIELD_CHARGES,
    skinKey: resolveSkinKey(player.equippedSkin),
    skinName: skinDisplayName(player.equippedSkin)
  };
}

function publicSkinInvisible(player, room) {
  if (!player?.skinInvisibleEnabled || !hasInvisibleSkin(player.equippedSkin)) return null;
  if (!room?.started || room?.winner) return null;
  return {
    active: true,
    isInvisible: isSkinInvisibleActive(player),
    charges: Math.max(0, Math.min(MAX_SKIN_INVISIBLE_CHARGES, Number(player.skinInvisibleCharges || 0))),
    max: MAX_SKIN_INVISIBLE_CHARGES,
    skinKey: resolveSkinKey(player.equippedSkin),
    skinName: skinDisplayName(player.equippedSkin)
  };
}

module.exports = {
  ANTI_ELIMINATION_SKINS,
  MAX_SKIN_SHIELD_CHARGES,
  SKIN_ANTI_ELIMINATION_ID,
  INVISIBLE_SKINS,
  MAX_SKIN_INVISIBLE_CHARGES,
  SKIN_INVISIBLE_ID,
  resolveSkinKey,
  hasAntiEliminationSkin,
  hasInvisibleSkin,
  skinDisplayName,
  canUseSkinAntiElimination,
  isSkinInvisibleActive,
  isPlayerInvisibleTo,
  canUseSkinInvisible,
  initPlayerSkinSkill,
  clearPlayerSkinSkill,
  rechargeSkinAntiElimination,
  consumeSkinAntiElimination,
  consumeSkinInvisible,
  expireSkinInvisible,
  publicSkinShield,
  publicSkinInvisible
};

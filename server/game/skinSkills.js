// Skill khusus skin per pertandingan JakLudo (non-persistent: tidak disimpan ke database akun).
// Emerald Green & Galaxy Purple: skill Anti-Eliminasi terhadap injakan dan Force Return lawan.

const ANTI_ELIMINATION_SKINS = new Set(['emerald_green', 'galaxy_purple']);
const MAX_SKIN_SHIELD_CHARGES = 3;
const SKIN_ANTI_ELIMINATION_ID = 'skinAntiElimination';

function resolveSkinKey(skin) {
  if (!skin) return '';
  if (typeof skin === 'string') return skin;
  return skin.assetKey || skin.id || '';
}

function hasAntiEliminationSkin(skin) {
  return ANTI_ELIMINATION_SKINS.has(resolveSkinKey(skin));
}

function skinDisplayName(skin) {
  const key = resolveSkinKey(skin);
  if (key === 'emerald_green') return 'Emerald Green';
  if (key === 'galaxy_purple') return 'Galaxy Purple';
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

function initPlayerSkinSkill(player) {
  if (!player) return;
  const enabled = hasAntiEliminationSkin(player.equippedSkin);
  player.skinShieldEnabled = enabled;
  player.skinShieldCharges = enabled ? 1 : 0;
}

function clearPlayerSkinSkill(player) {
  if (!player) return;
  player.skinShieldEnabled = false;
  player.skinShieldCharges = 0;
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

module.exports = {
  ANTI_ELIMINATION_SKINS,
  MAX_SKIN_SHIELD_CHARGES,
  SKIN_ANTI_ELIMINATION_ID,
  resolveSkinKey,
  hasAntiEliminationSkin,
  skinDisplayName,
  canUseSkinAntiElimination,
  initPlayerSkinSkill,
  clearPlayerSkinSkill,
  rechargeSkinAntiElimination,
  consumeSkinAntiElimination,
  publicSkinShield
};

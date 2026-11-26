// Force Return: pulangkan 1 bidak lawan di lintasan langsung ke markas.
// Hanya bisa didapat dengan membeli di toko. Lawan yang punya perisai untuk event 'forceReturn'
// (mis. Universal Shield) boleh memilih menahannya.
const { isSkinInvisibleActive } = require('../game/skinSkills');

module.exports = {
  id: 'forceReturn',
  name: 'Force Return',
  icon: '⚡',
  price: 100,
  kind: 'active',
  target: 'opponentPawn',
  attack: 'forceReturn',
  sound: 'thunder',
  badge: 'Eliminasi Instan',
  badgeColor: '#f59e0b',
  highlight: 'Dipakai di giliranmu sebelum melempar dadu',
  description: 'Pulangkan 1 bidak lawan di lintasan langsung ke markas. Dipakai di giliranmu sebelum melempar dadu, dan hanya jika minimal 1 bidakmu sudah keluar dari markas. Lawan yang punya Universal Shield bisa memilih menahannya.',

  canUse({ room, player }) {
    // 44 = finish: bidak yang sudah finish tidak dihitung sebagai bidak di papan
    if (!(room.pawns[player.id] || []).some(v => v >= 1 && v < 44)) return 'keluarkan dulu minimal 1 bidakmu dari markas.';
    const onTrackOpponents = room.players.filter(
      p => p.id !== player.id && (room.pawns[p.id] || []).some(v => v >= 1 && v <= 39)
    );
    if (onTrackOpponents.length === 0) return 'tidak ada bidak lawan di luar markas.';
    if (!onTrackOpponents.some(p => !isSkinInvisibleActive(p))) {
      return 'semua bidak lawan di lintasan sedang tidak terlihat (Invisible).';
    }
    return null;
  },

  use(ctx) {
    const { player, target, game, room } = ctx;
    const fromVal = room.pawns[target.player.id][target.pawnIdx];
    game.sendPawnHome(target.player, target.pawnIdx);
    game.recordCapture(target.player, { isForceReturn: true });
    game.addHistory(`⚡ FORCE RETURN! ${player.name} memulangkan bidak ${target.pawnIdx + 1} milik ${target.player.name} ke markas!`);
    game.setMessage(`⚡ Force Return! ${player.name} mengeliminasi bidak ${target.player.name}! Silakan lempar dadu.`);
    game.announce({
      title: 'FORCE RETURN DIEKSEKUSI!',
      text: `${player.name} melancarkan eliminasi langsung terhadap bidak ${target.player.name}!`,
      pawn: { player: target.player, pawnIdx: target.pawnIdx, val: fromVal }
    });
  }
};

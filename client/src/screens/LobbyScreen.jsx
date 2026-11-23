import React, { useEffect, useState } from 'react';
import Icon from '../components/Icon';
import PlayerAvatar from '../components/PlayerAvatar';
import { isAvatarUrl } from '../social/media';
import { sound } from '../sound';
import { copyOrShareRoom } from '../utils/shareRoom';

// Di HP pakai menu bagikan bawaan; selain itu salin ke clipboard (dengan cadangan untuk http/in-app browser)
async function copyOrShare(room) {
  const res = await copyOrShareRoom({ game: 'ludo', roomCode: room.code });
  return res.status;
}

function PlayerSlot({ player, index, playerId, onViewProfile }) {
  if (!player) {
    return (
      <li className="slot slot--empty">
        <span className="avatar" aria-hidden="true">+</span>
        <span>
          <strong>Kursi kosong</strong>
          <span className="muted">Menunggu pemain {index + 1}</span>
        </span>
      </li>
    );
  }
  const role = player.isBot ? 'Bot komputer' : player.username ? `@${player.username}` : 'Tamu';
  const canInspect = !player.isBot && !!player.userId && !!onViewProfile;
  return (
    <li className={`slot color-${player.color} ${player.connected === false && !player.isBot ? 'slot--offline' : ''}`}>
      <PlayerAvatar
        avatar={player.avatar}
        name={player.name}
        size={40}
        fallback={player.isBot ? <Icon name="bot" size={18} /> : player.name.slice(0, 1).toUpperCase()}
      />
      <span className="slot__text">
        <strong className="slot__name">
          {canInspect ? (
            <button
              type="button"
              className="user-link"
              onClick={() => {
                sound.playClick();
                onViewProfile(player.userId);
              }}
            >
              {player.name}
            </button>
          ) : (
            player.name
          )}
          {player.id === playerId && <span className="badge">Kamu</span>}
          {player.isHost && <span className="badge badge--brand">Host</span>}
          {player.isLudoKing && (
            <span className="badge badge--warning">
              <Icon name="crown" size={14} /> King
            </span>
          )}
          {player.equippedSkin && (
            <span className="badge badge--diamond" title={`Skin Bidak: ${player.equippedSkin.name}`}>
              💎 {player.equippedSkin.name}
            </span>
          )}
        </strong>
        <span className="muted">{role}</span>
      </span>
      <span className={`slot__status ${player.connected === false && !player.isBot ? 'is-offline' : ''}`}>
        {player.connected === false && !player.isBot ? 'Terputus' : 'Siap'}
      </span>
    </li>
  );
}

export default function LobbyScreen({ room, me, playerId, currentUser, error, actions, social, onOpenFriends, onOpenShop, onViewProfile }) {
  const [copyState, setCopyState] = useState('');
  const [groupMembers, setGroupMembers] = useState([]);
  const [inviteStatus, setInviteStatus] = useState({}); // { [userId]: 'sending' | 'sent' }
  const [inviteError, setInviteError] = useState('');
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [invitingAll, setInvitingAll] = useState(false);
  const [quickInviteMsg, setQuickInviteMsg] = useState('');
  const [matchmakingBusy, setMatchmakingBusy] = useState(false);
  const [matchmakingError, setMatchmakingError] = useState('');
  const [remainingSec, setRemainingSec] = useState(() =>
    room.matchmaking?.remainingMs ? Math.ceil(room.matchmaking.remainingMs / 1000) : 0
  );

  const safeZones = room.settings?.safeZones !== false;
  const blackHole = !!room.settings?.blackHole;
  const blackHoleMode = room.settings?.blackHoleMode === 'random' ? 'random' : 'static';
  const count = room.players.length;
  const isHost = !!me?.isHost;
  const isSearching = !!room.matchmaking?.active;
  const effectiveTarget = selectedTarget && selectedTarget >= count ? selectedTarget : null;
  const activeTarget = room.matchmaking?.targetPlayers || effectiveTarget || 4;
  const slotIndices = Array.from({ length: activeTarget }, (_, i) => i);

  useEffect(() => {
    if (!room.matchmaking?.active) {
      setRemainingSec(0);
      return undefined;
    }
    const initial = Math.max(0, Math.ceil((room.matchmaking.remainingMs || 0) / 1000));
    setRemainingSec(initial);
    const id = setInterval(() => {
      setRemainingSec(s => (s > 0 ? s - 1 : 0));
    }, 1000);
    return () => clearInterval(id);
  }, [room.matchmaking?.active, room.matchmaking?.targetPlayers, room.matchmaking?.remainingMs]);

  // Jika ini Match Grup, ambil daftar anggota grup agar bisa diundang langsung dari lobby
  const getGroupFn = social?.actions?.getGroup;
  useEffect(() => {
    const groupId = room.group?.id;
    if (!groupId || !getGroupFn) {
      setGroupMembers([]);
      return undefined;
    }
    let cancelled = false;
    getGroupFn(groupId)
      .then(detail => {
        if (!cancelled && Array.isArray(detail?.members)) {
          setGroupMembers(detail.members);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [room.group?.id, getGroupFn]);

  const onInviteUser = async userId => {
    if (!social?.actions?.inviteToRoom) return;
    sound.playClick();
    setInviteError('');
    setInviteStatus(prev => ({ ...prev, [userId]: 'sending' }));
    try {
      await social.actions.inviteToRoom(userId);
      setInviteStatus(prev => ({ ...prev, [userId]: 'sent' }));
      setTimeout(() => {
        setInviteStatus(prev => {
          const next = { ...prev };
          delete next[userId];
          return next;
        });
      }, 4000);
    } catch (err) {
      setInviteStatus(prev => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setInviteError(err.message);
    }
  };

  // Kandidat yang bisa diundang: anggota grup (jika Match Grup) atau daftar teman
  const playerUserIds = new Set(room.players.map(p => p.userId).filter(Boolean));
  const playerUsernames = new Set(room.players.map(p => p.username?.toLowerCase()).filter(Boolean));
  const rawPool = room.group ? groupMembers : social?.friends || [];
  const invitableList = rawPool.filter(u => {
    if (!u?.userId) return false;
    if (currentUser && u.userId === currentUser.id) return false;
    if (playerUserIds.has(u.userId)) return false;
    if (u.username && playerUsernames.has(u.username.toLowerCase())) return false;
    return true;
  });

  const onShare = async () => {
    sound.playClick();
    setQuickInviteMsg('');
    try {
      const result = await copyOrShare(room);
      if (result === 'copied') {
        setCopyState('Link undangan tersalin');
        setTimeout(() => setCopyState(''), 2000);
      }
    } catch {
      setCopyState('Gagal menyalin. Salin link dari bilah alamat browser.');
    }
  };

  const onQuickInvite = async () => {
    sound.playClick();
    setQuickInviteMsg('');
    setCopyState('');
    setInvitingAll(true);
    try {
      const res = actions.inviteAllFriends ? await actions.inviteAllFriends() : { ok: false, invitedCount: 0 };
      if (res?.ok && res.invitedCount > 0) {
        setQuickInviteMsg(`Undangan dikirim ke ${res.invitedCount} teman online!`);
        setTimeout(() => setQuickInviteMsg(''), 3500);
        return;
      }
      const shareRes = await copyOrShare(room);
      if (shareRes === 'copied') {
        setQuickInviteMsg('Link undangan tersalin — bagikan ke temanmu!');
        setTimeout(() => setQuickInviteMsg(''), 3500);
      }
    } catch {
      try {
        const shareRes = await copyOrShare(room);
        if (shareRes === 'copied') {
          setQuickInviteMsg('Link undangan tersalin — bagikan ke temanmu!');
          setTimeout(() => setQuickInviteMsg(''), 3500);
        }
      } catch {
        setCopyState('Gagal menyalin. Salin link dari bilah alamat browser.');
      }
    } finally {
      setInvitingAll(false);
    }
  };

  const onFindRandom = async () => {
    if (!effectiveTarget || matchmakingBusy || !actions.findRandomPlayers) return;
    sound.playClick();
    setMatchmakingError('');
    setMatchmakingBusy(true);
    try {
      const res = await actions.findRandomPlayers(effectiveTarget);
      if (!res?.ok) {
        setMatchmakingError(res?.error || 'Gagal mencari pemain acak.');
      }
    } catch (err) {
      setMatchmakingError(err?.message || 'Gagal mencari pemain acak.');
    } finally {
      setMatchmakingBusy(false);
    }
  };

  return (
    <main className="lobby" id="main">
      <section className="lobby__code card card--focus">
        {room.group && (
          <span className="badge badge--brand lobby__group-badge">
            <Icon name="trophy" size={14} /> Match Grup: {room.group.name} · Khusus anggota grup
          </span>
        )}
        <p className="muted">Kode room</p>
        <p className="lobby__code-value code-text" aria-label={`Kode room ${room.code.split('').join(' ')}`}>{room.code}</p>
        <p className="muted lobby__code-hint">
          {room.group
            ? `Hanya anggota grup "${room.group.name}" yang bisa masuk ke room ini.`
            : 'Undang teman langsung dalam 1 klik atau bagikan kode ini (maksimal 4 pemain).'}
        </p>
        <div className="lobby__code-actions">
          <button
            type="button"
            className="btn btn--primary btn--block"
            disabled={invitingAll || count >= 4}
            onClick={onQuickInvite}
          >
            {invitingAll ? 'Mengundang teman...' : 'Undang Teman Bermain'}
          </button>
          <button type="button" className="btn btn--secondary btn--block" onClick={onShare}>
            Salin link undangan
          </button>
        </div>
        <p className="lobby__copy-state" role="status">{quickInviteMsg || copyState}</p>
      </section>

      {isHost && !room.group && (
        <section className="lobby__matchmaking card" aria-labelledby="matchmaking-title">
          <div className="section-head">
            <h2 id="matchmaking-title">Cari Pemain Acak</h2>
            <span className="badge">{isSearching ? `${count}/${room.matchmaking.targetPlayers}` : '2–4 Pemain'}</span>
          </div>

          {!isSearching ? (
            <div className="lobby__matchmaking-controls">
              <p className="muted lobby__matchmaking-desc">
                Pilih jumlah pemain dulu, lalu biarkan sistem mencarikan lawan main secara acak.
              </p>

              <div className="lobby__matchmaking-label">
                <span>Pilih jumlah pemain</span>
                <div className="segmented segmented--3" role="radiogroup" aria-label="Pilih jumlah pemain">
                  {[2, 3, 4].map(n => (
                    <button
                      key={n}
                      type="button"
                      role="radio"
                      aria-checked={effectiveTarget === n}
                      disabled={n < count}
                      className="segmented__option"
                      onClick={() => {
                        sound.playClick();
                        setMatchmakingError('');
                        setSelectedTarget(n);
                      }}
                    >
                      {n} Pemain
                    </button>
                  ))}
                </div>
              </div>

              {matchmakingError && <p className="alert alert--error" role="alert">{matchmakingError}</p>}

              <button
                type="button"
                className="btn btn--primary btn--block"
                disabled={!effectiveTarget || matchmakingBusy || count >= 4}
                onClick={onFindRandom}
              >
                {matchmakingBusy
                  ? 'Mencari lawan...'
                  : effectiveTarget && count === effectiveTarget
                  ? `Mulai Main (${effectiveTarget} Pemain)`
                  : effectiveTarget
                  ? `Cari Pemain Acak (${effectiveTarget} Pemain)`
                  : 'Cari Pemain Acak'}
              </button>

              {!effectiveTarget && (
                <p className="muted lobby__matchmaking-note">
                  Pilih jumlah pemain (2, 3, atau 4) dulu untuk mencari lawan acak.
                </p>
              )}
            </div>
          ) : (
            <div className="lobby__searching" role="status">
              <div className="lobby__searching-status">
                <span className="spinner" aria-hidden="true" />
                <div>
                  <strong>Mencari pemain acak...</strong>
                  <span className="muted">
                    {count}/{room.matchmaking.targetPlayers} pemain siap
                    {remainingSec > 0 ? ` · ${remainingSec} dtk` : ''}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={() => {
                  sound.playClick();
                  actions.cancelRandomMatch?.();
                }}
              >
                Batalkan pencarian
              </button>
            </div>
          )}
        </section>
      )}

      <section className="lobby__players card" aria-labelledby="players-title">
        <div className="section-head">
          <h2 id="players-title">Pemain</h2>
          <span className="badge">{count} / {activeTarget}</span>
        </div>
        <ul className="slots">
          {slotIndices.map(i => (
            <PlayerSlot
              key={i}
              index={i}
              player={room.players[i]}
              playerId={playerId}
              onViewProfile={onViewProfile}
            />
          ))}
        </ul>
        {onOpenShop && (
          <div className="lobby__skin-bar">
            <span className="muted">
              Skin Bidak:{' '}
              <strong>{currentUser?.equippedLudoSkin?.name || me?.equippedSkin?.name || 'Standar PlayGo'}</strong>
            </span>
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => {
                sound.playClick();
                onOpenShop();
              }}
            >
              🎨 Skin Bidak &amp; Diamond
            </button>
          </div>
        )}
      </section>

      <section className="lobby__settings card" aria-labelledby="settings-title">
        <h2 id="settings-title">Aturan room</h2>
        <div className="setting">
          <div>
            <strong>Zona aman</strong>
            <p className="muted">{safeZones ? 'Bidak di petak bintang tidak bisa dimakan.' : 'Semua petak bisa dimakan (hardcore).'}</p>
          </div>
          {isHost ? (
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={safeZones}
              aria-label="Zona aman"
              disabled={isSearching}
              onClick={actions.toggleSafeZones}
            >
              <span className="switch__thumb" />
            </button>
          ) : (
            <span className={`badge ${safeZones ? 'badge--success' : ''}`}>{safeZones ? 'Aktif' : 'Nonaktif'}</span>
          )}
        </div>
        <div className="setting">
          <div>
            <strong>
              Black Hole <Icon name="vortex" size={16} />
            </strong>
            <p className="muted">{blackHole ? 'Bidak yang mendarat di lubang hitam kembali ke markas.' : 'Lubang hitam tidak dipakai.'}</p>
          </div>
          {isHost ? (
            <button
              type="button"
              className="switch"
              role="switch"
              aria-checked={blackHole}
              aria-label="Black Hole"
              disabled={isSearching}
              onClick={actions.toggleBlackHole}
            >
              <span className="switch__thumb" />
            </button>
          ) : (
            <span className={`badge ${blackHole ? 'badge--warning' : ''}`}>{blackHole ? 'Aktif' : 'Nonaktif'}</span>
          )}
        </div>
        {blackHole && (
          <fieldset className="setting setting--sub" disabled={!isHost || isSearching}>
            <legend className="setting__legend">Lokasi Black Hole</legend>
            <div className="segmented" role="radiogroup" aria-label="Lokasi Black Hole">
              {[
                { value: 'static', label: 'Tetap' },
                { value: 'random', label: 'Acak' }
              ].map(opt => (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={blackHoleMode === opt.value}
                  className="segmented__option"
                  onClick={() => isHost && !isSearching && blackHoleMode !== opt.value && actions.setBlackHoleMode(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            <p className="muted setting__hint">
              {blackHoleMode === 'random'
                ? 'Acak: setiap satu putaran, tiap lubang pindah ke petak kosong lain di garisnya.'
                : 'Tetap: empat lubang di petak yang sama sepanjang permainan.'}
            </p>
          </fieldset>
        )}
        <p className="setting__note muted">Kotak start hanya aman bagi warnanya sendiri. Bidak warna lain yang singgah di sana bisa dimakan.</p>
      </section>

      {social && (
        <section className="lobby__invite card" aria-labelledby="invite-friends-title">
          <div className="section-head">
            <h2 id="invite-friends-title">
              {room.group ? `Undang teman (${room.group.name})` : 'Undang teman'}
            </h2>
            {!room.group && onOpenFriends && (
              <button
                type="button"
                className="btn btn--secondary btn--sm"
                onClick={onOpenFriends}
              >
                <Icon name="friends" size={16} />
                <span>Kelola teman</span>
              </button>
            )}
          </div>
          {inviteError && (
            <p className="alert alert--error" role="alert">
              {inviteError}
            </p>
          )}
          {invitableList.length === 0 ? (
            <p className="social-empty muted">
              {room.group
                ? 'Semua anggota grup sudah berada di room ini atau belum ada anggota lain.'
                : 'Belum ada teman untuk diundang. Tambah teman dulu lewat menu Teman.'}
            </p>
          ) : (
            <ul className="social-list">
              {invitableList.map(u => {
                const state = inviteStatus[u.userId];
                return (
                  <li key={u.userId} className="social-row">
                    <div className="social-avatar-wrap">
                      {isAvatarUrl(u.avatar) ? (
                        <img src={u.avatar} alt="" width="38" height="38" className="social-avatar" />
                      ) : (
                        <span className="social-avatar" aria-hidden="true">
                          {u.name?.slice(0, 1).toUpperCase() || <Icon name="pawn" size={16} />}
                        </span>
                      )}
                      <span
                        className={`status-dot ${u.online ? 'status-dot--online' : 'status-dot--offline'}`}
                        aria-hidden="true"
                      />
                    </div>
                    <div className="social-row__info">
                      <strong>
                        {onViewProfile ? (
                          <button
                            type="button"
                            className="user-link"
                            onClick={() => {
                              sound.playClick();
                              onViewProfile(u.userId);
                            }}
                          >
                            {u.name}
                          </button>
                        ) : (
                          u.name
                        )}
                      </strong>
                      <span className="muted">
                        @{u.username} ·{' '}
                        <span className={u.online ? 'text-online' : ''}>
                          {u.online ? 'Online' : 'Offline'}
                        </span>
                      </span>
                    </div>
                    <div className="social-row__actions">
                      <button
                        type="button"
                        className="btn btn--secondary btn--sm"
                        disabled={!!state || count >= 4}
                        onClick={() => onInviteUser(u.userId)}
                      >
                        {state === 'sending'
                          ? 'Mengirim...'
                          : state === 'sent'
                          ? 'Terkirim ✓'
                          : 'Undang'}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}

      <section className="lobby__start">
        {error && <p className="alert alert--error" role="alert">{error}</p>}
        {isHost ? (
          <>
            <button
              type="button"
              className="btn btn--primary btn--lg btn--block"
              disabled={count < 2 || isSearching}
              onClick={actions.startGame}
            >
              Mulai permainan
            </button>
            {count < 2 && !isSearching && (
              <p className="muted lobby__hint">
                Butuh minimal 2 pemain. Undang teman atau pilih jumlah pemain untuk cari lawan acak.
              </p>
            )}
          </>
        ) : (
          <p className="lobby__waiting" role="status">
            {isSearching ? 'Host sedang mencarikan pemain acak...' : 'Menunggu host memulai permainan...'}
          </p>
        )}
        <button type="button" className="btn btn--ghost btn--block" onClick={actions.leaveRoom}>Keluar dari room</button>
      </section>
    </main>
  );
}

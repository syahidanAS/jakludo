import React, { useEffect, useMemo, useState } from 'react';
import Icon from '../components/Icon';
import Modal from '../components/Modal';
import PlayerAvatar from '../components/PlayerAvatar';
import ChatPanel from '../components/game/ChatPanel';
import ChessBoard from '../components/chess/ChessBoard';
import { CHESS_TIME_CONTROLS } from '../hooks/useChessMaster';
import { sound } from '../sound';
import chessMasterLogo from '../assets/chess-master-logo.webp';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const REACTIONS = ['🎲', '🔥', '👏', '😂', '😭', '👑'];
const CHESS_QUICK_CHATS = ['Good Game! 👏', 'Langkah bagus! 🔥', 'Skak! 👑', 'Ampun master! 😂', 'Ayo cepat jalan! ⚡'];

export function formatChessClock(ms) {
  const safe = Math.max(0, Math.floor(Number(ms) || 0));
  const totalSeconds = Math.floor(safe / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((safe % 1000) / 100);

  if (totalSeconds < 10 && safe > 0) {
    return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (s < 60) return `${s}d`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}d` : `${m}m`;
}

function formatResultReason(reason) {
  switch (reason) {
    case 'checkmate':
      return 'Skakmat (Checkmate)';
    case 'timeout':
      return 'Waktu Habis (Timeout)';
    case 'resigned':
      return 'Menyerah (Resignation)';
    case 'stalemate':
      return 'Pat (Stalemate)';
    case 'threefold_repetition':
      return 'Pengulangan 3 Kali (Threefold Repetition)';
    case 'insufficient_material':
      return 'Bidak Tidak Cukup (Insufficient Material)';
    case 'fifty_move_rule':
      return 'Aturan 50 Langkah (50-Move Rule)';
    case 'draw_agreement':
      return 'Kesepakatan Remis (Draw Agreement)';
    case 'abandoned':
      return 'Lawan Terputus (Forfeit)';
    case 'draw':
      return 'Remis (Draw)';
    default:
      return reason || 'Selesai';
  }
}

function groupMovePairs(moves = []) {
  const pairs = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({
      moveNumber: Math.floor(i / 2) + 1,
      white: moves[i] || null,
      black: moves[i + 1] || null
    });
  }
  return pairs;
}

const PIECE_NAMES_ID = {
  p: 'Pion',
  n: 'Kuda',
  b: 'Gajah',
  r: 'Benteng',
  q: 'Menteri',
  k: 'Raja'
};

function describeChessMove(mv, totalMoves = 0) {
  if (!mv) {
    return {
      title: 'Posisi Awal Permainan',
      detail: 'Kedua pemain siap di posisi standar. Putih memegang giliran pertama.',
      tag: 'Pembukaan',
      tagType: 'neutral'
    };
  }

  const san = String(mv.san || '');
  const sideLabel = mv.color === 'w' ? 'Putih' : 'Hitam';
  const moveNum = Math.floor(((mv.ply || 1) - 1) / 2) + 1;
  const prefix = mv.color === 'w' ? `${moveNum}. ${san}` : `${moveNum}... ${san}`;

  const isCheckmate = san.includes('#');
  const isCheck = !isCheckmate && san.includes('+');
  const isCapture = Boolean(mv.captured) || san.includes('x');
  const isCastleKingside = san.startsWith('O-O') && !san.startsWith('O-O-O');
  const isCastleQueenside = san.startsWith('O-O-O');
  const isPromotion = Boolean(mv.promotion) || san.includes('=');

  const pieceKey = String(mv.piece || '').toLowerCase();
  const pieceName = PIECE_NAMES_ID[pieceKey] || (
    san[0] === 'N' ? 'Kuda' :
    san[0] === 'B' ? 'Gajah' :
    san[0] === 'R' ? 'Benteng' :
    san[0] === 'Q' ? 'Menteri' :
    san[0] === 'K' ? 'Raja' : 'Pion'
  );
  const capturedName = mv.captured ? PIECE_NAMES_ID[String(mv.captured).toLowerCase()] || 'bidak lawan' : 'bidak lawan';
  const promoName = mv.promotion ? PIECE_NAMES_ID[String(mv.promotion).toLowerCase()] || 'Menteri' : 'Menteri';

  let actionDesc = '';
  if (isCastleKingside) {
    actionDesc = `${sideLabel} melakukan Rokade Pendek (O-O) untuk mengamankan Raja dan mengaktifkan Benteng.`;
  } else if (isCastleQueenside) {
    actionDesc = `${sideLabel} melakukan Rokade Panjang (O-O-O) ke sisi Menteri.`;
  } else if (isCapture) {
    actionDesc = `${sideLabel} menggerakkan ${pieceName} dari ${mv.from || '-'} ke ${mv.to || '-'} dan memakan ${capturedName}.`;
  } else {
    actionDesc = `${sideLabel} menggerakkan ${pieceName} dari petak ${mv.from || '-'} ke ${mv.to || '-'}.`;
  }

  if (isPromotion) {
    actionDesc += ` Pion dipromosikan menjadi ${promoName}!`;
  }
  if (isCheckmate) {
    actionDesc += ' Langkah ini menghasilkan SKAKMAT dan mengakhiri permainan!';
  } else if (isCheck) {
    actionDesc += ' Raja lawan kini dalam ancaman SKAK!';
  }

  let tag = 'Langkah Taktis';
  let tagType = 'neutral';
  if (isCheckmate) {
    tag = '👑 Langkah Penentu (Skakmat)';
    tagType = 'win';
  } else if (isCheck) {
    tag = '⚠️ Serangan Skak';
    tagType = 'warn';
  } else if (isPromotion) {
    tag = '⭐ Promosi Pion';
    tagType = 'win';
  } else if (isCastleKingside || isCastleQueenside) {
    tag = '🛡️ Rokade Raja';
    tagType = 'info';
  } else if (isCapture) {
    tag = '⚔️ Pertukaran Bidak';
    tagType = 'capture';
  } else if ((mv.ply || 0) <= 10) {
    tag = '📖 Fase Pembukaan';
    tagType = 'info';
  } else if (totalMoves > 0 && mv.ply === totalMoves) {
    tag = '🏁 Langkah Terakhir';
    tagType = 'warn';
  }

  return {
    title: `Langkah ${mv.ply}/${totalMoves || mv.ply}: ${prefix}`,
    detail: actionDesc,
    tag,
    tagType
  };
}

function computeMatchReviewStats(moves = []) {
  const stats = {
    totalPlies: moves.length,
    totalTurns: Math.ceil(moves.length / 2),
    whiteCaptures: 0,
    blackCaptures: 0,
    whiteChecks: 0,
    blackChecks: 0,
    promotions: 0
  };
  for (const m of moves) {
    const san = String(m.san || '');
    const isCap = Boolean(m.captured) || san.includes('x');
    const isChk = san.includes('+') || san.includes('#');
    const isPromo = Boolean(m.promotion) || san.includes('=');
    if (m.color === 'w') {
      if (isCap) stats.whiteCaptures += 1;
      if (isChk) stats.whiteChecks += 1;
    } else {
      if (isCap) stats.blackCaptures += 1;
      if (isChk) stats.blackChecks += 1;
    }
    if (isPromo) stats.promotions += 1;
  }
  return stats;
}

export default function ChessMasterScreen({
  chess,
  currentUser,
  onBackToMenu,
  onOpenAuth,
  onOpenShop,
  onOpenAudio,
  onViewProfile
}) {
  const [hubTab, setHubTab] = useState('leaderboard'); // 'leaderboard' | 'history'
  const [showAllTimeControls, setShowAllTimeControls] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmResign, setConfirmResign] = useState(false);
  const [manualFlip, setManualFlip] = useState(false);
  const [viewingPly, setViewingPly] = useState(null); // null = live
  const [mobileMovesOpen, setMobileMovesOpen] = useState(false);
  const [showResultModal, setShowResultModal] = useState(false);
  const [reviewMode, setReviewMode] = useState(false);
  const [autoPlayReview, setAutoPlayReview] = useState(false);
  const [autoPlayReplay, setAutoPlayReplay] = useState(false);

  const {
    room,
    joinCode,
    setJoinCode,
    timeControl,
    setTimeControl,
    preferredSide,
    setPreferredSide,
    searching,
    error,
    notice,
    matchResult,
    whiteTimeMs,
    blackTimeMs,
    profile,
    recentMatches,
    leaderboard,
    leaderboardMeta,
    replayMatch,
    replayPly,
    setReplayPly,
    chats = [],
    unreadChats = 0,
    chatOpen = false,
    actions
  } = chess;

  // Reset ply history view ke live ketika ada langkah baru
  useEffect(() => {
    setViewingPly(null);
    setConfirmResign(false);
  }, [room?.match?.moveVersion, room?.phase]);

  // Saat permainan selesai, otomatis tutup gameplay dengan Modal Pemenang
  useEffect(() => {
    if (room?.phase === 'completed') {
      setShowResultModal(true);
      setReviewMode(false);
      setAutoPlayReview(false);
    } else {
      setShowResultModal(false);
      setReviewMode(false);
      setAutoPlayReview(false);
    }
  }, [room?.phase, room?.match?.id]);

  const handleCopyCode = () => {
    if (!room?.code) return;
    navigator.clipboard?.writeText(room.code);
    setCopied(true);
    sound.playClick();
    setTimeout(() => setCopied(false), 2000);
  };

  // Identifikasi posisi pemain di dalam match
  const match = room?.match || null;
  const myUserId = currentUser?.id;
  const myColor = useMemo(() => {
    if (!match || !myUserId) return 'w';
    if (match.whitePlayer?.userId === myUserId) return 'w';
    if (match.blackPlayer?.userId === myUserId) return 'b';
    return 'w';
  }, [match, myUserId]);

  const boardOrientation = useMemo(() => {
    const base = myColor === 'b' ? 'b' : 'w';
    if (!manualFlip) return base;
    return base === 'w' ? 'b' : 'w';
  }, [myColor, manualFlip]);

  const topPlayer = boardOrientation === 'w' ? match?.blackPlayer : match?.whitePlayer;
  const bottomPlayer = boardOrientation === 'w' ? match?.whitePlayer : match?.blackPlayer;
  const topColor = boardOrientation === 'w' ? 'b' : 'w';
  const bottomColor = boardOrientation === 'w' ? 'w' : 'b';
  const topClockMs = topColor === 'w' ? whiteTimeMs : blackTimeMs;
  const bottomClockMs = bottomColor === 'w' ? whiteTimeMs : blackTimeMs;

  const moves = match?.moves || [];
  const movePairs = useMemo(() => groupMovePairs(moves), [moves]);
  const activeReviewPly = viewingPly === null ? moves.length : Math.max(0, Math.min(moves.length, viewingPly));
  const currentReviewMove = activeReviewPly > 0 ? moves[activeReviewPly - 1] || null : null;
  const currentReviewMoveInfo = useMemo(
    () => describeChessMove(currentReviewMove, moves.length),
    [currentReviewMove, moves.length]
  );
  const reviewStats = useMemo(() => computeMatchReviewStats(moves), [moves]);

  // Auto-play untuk Review Permainan di layar match
  useEffect(() => {
    if (!autoPlayReview) return undefined;
    if (moves.length === 0) {
      setAutoPlayReview(false);
      return undefined;
    }
    const timer = setInterval(() => {
      setViewingPly(prev => {
        const cur = prev === null ? moves.length : prev;
        if (cur >= moves.length) {
          setAutoPlayReview(false);
          return moves.length;
        }
        sound.playHop();
        return cur + 1;
      });
    }, 850);
    return () => clearInterval(timer);
  }, [autoPlayReview, moves.length]);

  // FEN yang ditampilkan di papan (bisa live atau saat menavigasi langkah sebelumnya)
  const displayedFen = useMemo(() => {
    if (!match) return INITIAL_FEN;
    if (viewingPly === null || viewingPly >= moves.length) {
      return match.fen || INITIAL_FEN;
    }
    if (viewingPly <= 0) return INITIAL_FEN;
    return moves[viewingPly - 1]?.fenAfter || match.fen || INITIAL_FEN;
  }, [match, moves, viewingPly]);

  const displayedLastMove = useMemo(() => {
    if (!match) return null;
    if (viewingPly === null || viewingPly >= moves.length) {
      return match.lastMove || null;
    }
    if (viewingPly <= 0) return null;
    const mv = moves[viewingPly - 1];
    return mv ? { from: mv.from, to: mv.to, san: mv.san, color: mv.color } : null;
  }, [match, moves, viewingPly]);

  const isLiveBoard = viewingPly === null || viewingPly >= moves.length;

  // Replay modal state
  const replayMoves = replayMatch?.moves || [];
  const replayPairs = useMemo(() => groupMovePairs(replayMoves), [replayMoves]);
  const replayCurrentMove =
    replayPly > 0 && replayMoves.length > 0
      ? replayMoves[Math.min(replayPly, replayMoves.length) - 1] || null
      : null;
  const replayMoveInfo = useMemo(
    () => describeChessMove(replayCurrentMove, replayMoves.length),
    [replayCurrentMove, replayMoves.length]
  );
  const replayStats = useMemo(() => computeMatchReviewStats(replayMoves), [replayMoves]);

  useEffect(() => {
    if (!replayMatch) setAutoPlayReplay(false);
  }, [replayMatch]);

  useEffect(() => {
    if (!autoPlayReplay || !replayMatch) return undefined;
    if (replayMoves.length === 0) {
      setAutoPlayReplay(false);
      return undefined;
    }
    const timer = setInterval(() => {
      setReplayPly(prev => {
        if (prev >= replayMoves.length) {
          setAutoPlayReplay(false);
          return replayMoves.length;
        }
        sound.playHop();
        return prev + 1;
      });
    }, 850);
    return () => clearInterval(timer);
  }, [autoPlayReplay, replayMatch, replayMoves.length, setReplayPly]);

  const replayFen = useMemo(() => {
    if (!replayMatch) return INITIAL_FEN;
    if (replayPly <= 0) return INITIAL_FEN;
    if (replayPly >= replayMoves.length) return replayMatch.fen || INITIAL_FEN;
    return replayMoves[replayPly - 1]?.fenAfter || replayMatch.fen || INITIAL_FEN;
  }, [replayMatch, replayMoves, replayPly]);

  const replayLastMove = useMemo(() => {
    if (!replayMatch || replayPly <= 0) return null;
    const mv = replayMoves[Math.min(replayPly, replayMoves.length) - 1];
    return mv ? { from: mv.from, to: mv.to, san: mv.san, color: mv.color } : null;
  }, [replayMatch, replayMoves, replayPly]);

  const myRating = profile?.rating ?? 1200;
  const myHighest = profile?.highestRating ?? 1200;
  const myTotalGames = profile?.totalGames ?? 0;
  const myWins = profile?.wins ?? 0;
  const myLosses = profile?.losses ?? 0;
  const myDraws = profile?.draws ?? 0;
  const myWinRate = profile?.winRate ?? 0;
  const myStreak = profile?.currentStreak ?? 0;

  // ==========================================
  // RENDER 1: ACTIVE / COMPLETED MATCH SCREEN
  // ==========================================
  if (room && (room.phase === 'playing' || room.phase === 'completed') && match) {
    const isMyTurn = room.phase === 'playing' && match.turn === myColor;
    const pendingDrawOffer = match.drawOffer;
    const hasIncomingDrawOffer = pendingDrawOffer && pendingDrawOffer.byUserId !== myUserId;
    const hasOutgoingDrawOffer = pendingDrawOffer && pendingDrawOffer.byUserId === myUserId;
    const rematchRequestedByMe = (room.rematchRequests || []).includes(myUserId);
    const rematchRequestedByOpponent = (room.rematchRequests || []).some(id => id !== myUserId);

    const endSummary = matchResult || match.completedPayload || null;
    const resultCode = endSummary?.result || match.result || '';
    const resultReasonCode = endSummary?.resultReason || match.resultReason || '';
    const winnerId = endSummary?.winnerId || match.winnerId || null;
    const isDraw = Boolean(
      room.phase === 'completed' && (!winnerId || resultCode === '1/2-1/2' || resultReasonCode === 'draw')
    );
    const winnerSide =
      resultCode === '1-0'
        ? 'w'
        : resultCode === '0-1'
        ? 'b'
        : winnerId && match.whitePlayer?.userId === winnerId
        ? 'w'
        : winnerId && match.blackPlayer?.userId === winnerId
        ? 'b'
        : null;
    const winnerPlayer =
      winnerSide === 'w'
        ? match.whitePlayer
        : winnerSide === 'b'
        ? match.blackPlayer
        : null;
    const loserPlayer =
      winnerSide === 'w'
        ? match.blackPlayer
        : winnerSide === 'b'
        ? match.whitePlayer
        : null;
    const iWon = Boolean(
      (winnerId && winnerId === myUserId) || (winnerSide && winnerSide === myColor && !isDraw)
    );
    const whiteDelta = endSummary?.whiteRatingChange ?? match.whiteRatingChange ?? 0;
    const blackDelta = endSummary?.blackRatingChange ?? match.blackRatingChange ?? 0;
    const myDelta = myColor === 'w' ? whiteDelta : blackDelta;

    const startGameReview = (startFromPly = 0) => {
      sound.playClick();
      setShowResultModal(false);
      setReviewMode(true);
      setAutoPlayReview(false);
      setViewingPly(startFromPly);
    };

    return (
      <div className="cm-screen cm-screen--match">
        {/* Topbar Match */}
        <header className="cm-topbar">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => {
              if (room.phase === 'playing') {
                setConfirmResign(true);
              } else {
                actions.leaveRoom();
              }
            }}
          >
            <Icon name="arrow-left" size={16} />
            <span>{room.phase === 'playing' ? 'Keluar / Menyerah' : 'Ke Lobby Catur'}</span>
          </button>

          <div className="cm-topbar__brand">
            <Icon name="chess" size={18} />
            <strong>Chess Master</strong>
            <span className="cm-tc-pill">{match.timeControl}</span>
          </div>

          <div className="cm-topbar__right">
            <span className={`cm-conn-dot ${room.players?.every(p => p.connected) ? 'is-online' : 'is-warn'}`}>
              {room.players?.every(p => p.connected) ? 'Terhubung' : 'Reconnecting'}
            </span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenAudio} aria-label="Pengaturan Suara">
              <Icon name="volume-on" size={16} />
            </button>
          </div>
        </header>

        {error && <div className="cm-toast cm-toast--error">{error}</div>}
        {notice && <div className="cm-toast cm-toast--notice">{notice}</div>}

        {/* Tawaran Remis (Draw Offer) Masuk */}
        {room.phase === 'playing' && hasIncomingDrawOffer && (
          <div className="cm-draw-banner">
            <span>🤝 Lawan menawarkan Remis (Draw). Terima?</span>
            <div className="cm-draw-banner__actions">
              <button type="button" className="btn btn--primary btn--sm" onClick={actions.acceptDraw}>
                Terima
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={actions.declineDraw}>
                Tolak
              </button>
            </div>
          </div>
        )}

        <div className="cm-match-layout">
          {/* Kolom Papan Utama */}
          <div className="cm-board-column">
            {/* Bar Lawan (Atas Papan) */}
            <div className={`cm-player-bar ${room.phase === 'playing' && match.turn === topColor ? 'is-active-turn' : ''}`}>
              <div className="cm-player-bar__info">
                <PlayerAvatar player={topPlayer || { name: 'Lawan', avatar: '♟️' }} size={38} />
                <div className="cm-player-bar__meta">
                  <div className="cm-player-bar__name-row">
                    <strong className="cm-player-bar__name">{topPlayer?.name || 'Lawan'}</strong>
                    <span className="cm-player-bar__rating">({topPlayer?.rating || 1200})</span>
                    <span className={`cm-color-badge cm-color-badge--${topColor}`}>
                      {topColor === 'w' ? 'Putih' : 'Hitam'}
                    </span>
                  </div>
                  <div className="cm-player-bar__sub">
                    {!topPlayer?.connected ? (
                      <span className="cm-status-tag cm-status-tag--danger">Terputus — Menunggu Reconnect</span>
                    ) : room.phase === 'playing' && match.turn === topColor ? (
                      <span className="cm-status-tag cm-status-tag--turn">Sedang Melangkah...</span>
                    ) : (
                      <span className="cm-status-tag">Menunggu</span>
                    )}
                  </div>
                </div>
              </div>

              <div
                className={[
                  'cm-clock',
                  room.phase === 'playing' && match.turn === topColor ? 'cm-clock--active' : '',
                  topClockMs < 30000 ? 'cm-clock--low' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Icon name="clock" size={15} />
                <span>{formatChessClock(topClockMs)}</span>
              </div>
            </div>

            {/* Peringatan jika sedang melihat langkah masa lalu */}
            {!isLiveBoard && (
              <div className="cm-history-preview-bar">
                <span>Melihat langkah ke-{viewingPly} dari {moves.length}</span>
                <button type="button" className="btn btn--primary btn--sm" onClick={() => setViewingPly(null)}>
                  Kembali ke Posisi Live
                </button>
              </div>
            )}

            {/* Papan Catur 8x8 */}
            <div className="cm-board-stage">
              <ChessBoard
                fen={displayedFen}
                orientation={boardOrientation}
                myColor={myColor}
                interactive={room.phase === 'playing' && isLiveBoard}
                lastMove={displayedLastMove}
                onMove={actions.submitMove}
              />
            </div>

            {/* Bar Pemain Saat Ini (Bawah Papan) */}
            <div className={`cm-player-bar ${room.phase === 'playing' && match.turn === bottomColor ? 'is-active-turn' : ''}`}>
              <div className="cm-player-bar__info">
                <PlayerAvatar player={bottomPlayer || currentUser || { name: 'Kamu', avatar: '♟️' }} size={38} />
                <div className="cm-player-bar__meta">
                  <div className="cm-player-bar__name-row">
                    <strong className="cm-player-bar__name">
                      {bottomPlayer?.name || currentUser?.name || 'Kamu'}
                    </strong>
                    <span className="cm-player-bar__rating">({bottomPlayer?.rating || myRating})</span>
                    <span className={`cm-color-badge cm-color-badge--${bottomColor}`}>
                      {bottomColor === 'w' ? 'Putih' : 'Hitam'}
                    </span>
                  </div>
                  <div className="cm-player-bar__sub">
                    {room.phase === 'playing' ? (
                      isMyTurn ? (
                        <span className="cm-status-tag cm-status-tag--turn">
                          {match.inCheck ? '⚠️ RAJA SKAK! Giliranmu!' : 'Giliranmu Melangkah'}
                        </span>
                      ) : (
                        <span className="cm-status-tag">Menunggu langkah lawan...</span>
                      )
                    ) : (
                      <span className="cm-status-tag">Pertandingan Selesai</span>
                    )}
                  </div>
                </div>
              </div>

              <div
                className={[
                  'cm-clock',
                  room.phase === 'playing' && match.turn === bottomColor ? 'cm-clock--active' : '',
                  bottomClockMs < 30000 ? 'cm-clock--low' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Icon name="clock" size={15} />
                <span>{formatChessClock(bottomClockMs)}</span>
              </div>
            </div>

            {/* Panel Review Permainan Interaktif (Muncul saat game selesai atau mode review aktif) */}
            {(room.phase === 'completed' || reviewMode) && (
              <div className="cm-review-panel" role="region" aria-label="Review Permainan Catur">
                <div className="cm-review-panel__head">
                  <div className="cm-review-panel__title-group">
                    <span className="cm-review-badge">🔍 REVIEW PERMAINAN</span>
                    <span className={`cm-review-tag cm-review-tag--${currentReviewMoveInfo.tagType}`}>
                      {currentReviewMoveInfo.tag}
                    </span>
                  </div>
                  {room.phase === 'completed' && (
                    <button
                      type="button"
                      className="btn btn--primary btn--sm"
                      onClick={() => {
                        sound.playClick();
                        setAutoPlayReview(false);
                        setShowResultModal(true);
                      }}
                    >
                      🏆 Lihat Pemenang
                    </button>
                  )}
                </div>

                <div className="cm-review-commentary">
                  <strong>{currentReviewMoveInfo.title}</strong>
                  <p>{currentReviewMoveInfo.detail}</p>
                </div>

                {moves.length > 0 && (
                  <>
                    <div className="cm-review-slider-row">
                      <span>Awal</span>
                      <input
                        type="range"
                        min={0}
                        max={moves.length}
                        value={activeReviewPly}
                        onChange={e => {
                          setAutoPlayReview(false);
                          setViewingPly(Number(e.target.value));
                        }}
                        className="cm-review-slider"
                        aria-label="Timeline langkah permainan"
                      />
                      <span>Akhir ({moves.length})</span>
                    </div>

                    <div className="cm-review-controls">
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={activeReviewPly <= 0}
                        onClick={() => {
                          setAutoPlayReview(false);
                          setViewingPly(0);
                        }}
                        title="Ke Posisi Awal"
                      >
                        |&lt; Awal
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={activeReviewPly <= 0}
                        onClick={() => {
                          setAutoPlayReview(false);
                          setViewingPly(Math.max(0, activeReviewPly - 1));
                        }}
                        title="Langkah Sebelumnya"
                      >
                        &lt; Mundur
                      </button>
                      <button
                        type="button"
                        className={`btn btn--sm ${autoPlayReview ? 'btn--danger' : 'btn--primary'}`}
                        onClick={() => {
                          sound.playClick();
                          if (!autoPlayReview && activeReviewPly >= moves.length) {
                            setViewingPly(0);
                          }
                          setAutoPlayReview(v => !v);
                        }}
                      >
                        {autoPlayReview ? '⏸️ Jeda' : '▶️ Putar Otomatis'}
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={activeReviewPly >= moves.length}
                        onClick={() => {
                          setAutoPlayReview(false);
                          setViewingPly(Math.min(moves.length, activeReviewPly + 1));
                        }}
                        title="Langkah Berikutnya"
                      >
                        Maju &gt;
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        disabled={activeReviewPly >= moves.length}
                        onClick={() => {
                          setAutoPlayReview(false);
                          setViewingPly(moves.length);
                        }}
                        title="Ke Langkah Terakhir"
                      >
                        Akhir &gt;|
                      </button>
                    </div>

                    <div className="cm-review-chips" role="list" aria-label="Daftar langkah cepat">
                      <button
                        type="button"
                        className={`cm-review-chip ${activeReviewPly === 0 ? 'is-active' : ''}`}
                        onClick={() => {
                          setAutoPlayReview(false);
                          setViewingPly(0);
                        }}
                      >
                        Mulai
                      </button>
                      {moves.map(m => {
                        const moveNo = Math.floor(((m.ply || 1) - 1) / 2) + 1;
                        const label = m.color === 'w' ? `${moveNo}. ${m.san}` : `${moveNo}... ${m.san}`;
                        return (
                          <button
                            key={m.ply}
                            type="button"
                            className={`cm-review-chip ${activeReviewPly === m.ply ? 'is-active' : ''}`}
                            onClick={() => {
                              setAutoPlayReview(false);
                              setViewingPly(m.ply);
                            }}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Bar Tombol Aksi Mobile & Desktop Cepat */}
            <div className="cm-action-strip">
              <button
                type="button"
                className="btn btn--ghost btn--sm cm-mobile-moves-btn"
                onClick={() => setMobileMovesOpen(true)}
              >
                <span>📜 Notasi ({moves.length})</span>
              </button>

              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => {
                  sound.playClick();
                  setManualFlip(f => !f);
                }}
                title="Putar Papan"
              >
                <Icon name="rotate" size={15} />
                <span>Putar Papan</span>
              </button>

              {room.phase === 'completed' && (
                <>
                  <button
                    type="button"
                    className="btn btn--secondary btn--sm"
                    onClick={() => startGameReview(0)}
                  >
                    <span>🔍 Review dari Awal</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary btn--sm"
                    onClick={() => {
                      sound.playClick();
                      setAutoPlayReview(false);
                      setShowResultModal(true);
                    }}
                  >
                    <span>🏆 Hasil &amp; Pemenang</span>
                  </button>
                </>
              )}

              {room.phase === 'playing' && (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={Boolean(hasOutgoingDrawOffer)}
                    onClick={actions.offerDraw}
                  >
                    <span>🤝 {hasOutgoingDrawOffer ? 'Remis Diajukan' : 'Tawarkan Remis'}</span>
                  </button>

                  {!confirmResign ? (
                    <button
                      type="button"
                      className="btn btn--danger btn--sm"
                      onClick={() => setConfirmResign(true)}
                    >
                      <Icon name="flag" size={15} />
                      <span>Menyerah</span>
                    </button>
                  ) : (
                    <div className="cm-resign-confirm">
                      <span>Yakin menyerah?</span>
                      <button
                        type="button"
                        className="btn btn--danger btn--sm"
                        onClick={() => {
                          setConfirmResign(false);
                          actions.resign();
                        }}
                      >
                        Ya, Menyerah
                      </button>
                      <button
                        type="button"
                        className="btn btn--ghost btn--sm"
                        onClick={() => setConfirmResign(false)}
                      >
                        Batal
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Bar Reaksi Emoticon & Tombol Obrolan (seperti JakLudo) */}
            <div className="turn-panel__toolbar" style={{ width: '100%' }}>
              <div className="reaction-row" role="group" aria-label="Kirim reaksi">
                {REACTIONS.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    className="icon-btn icon-btn--plain"
                    aria-label={`Kirim reaksi ${emoji}`}
                    onClick={() => actions.sendReaction(emoji)}
                  >
                    <span aria-hidden="true">{emoji}</span>
                  </button>
                ))}
              </div>
              <div className="turn-panel__tools">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Buka obrolan${unreadChats ? `, ${unreadChats} pesan baru` : ''}`}
                  onClick={() => {
                    sound.playClick();
                    actions.setChatOpen(true);
                  }}
                >
                  <span aria-hidden="true">💬</span>
                  {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
                </button>
              </div>
            </div>
          </div>

          {/* Panel Kanan (Desktop): Notasi SAN, Navigasi Langkah, Hasil Pertandingan, & Obrolan */}
          <aside className="cm-side-panel">
            <div className="cm-side-card">
              <div className="cm-side-card__head">
                <div>
                  <strong>Notasi Langkah (SAN)</strong>
                  <span className="cm-side-card__sub">{moves.length} ply</span>
                </div>
                {room.phase === 'completed' && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => actions.downloadPgn(match.id)}
                  >
                    <Icon name="download" size={14} />
                    <span>PGN</span>
                  </button>
                )}
              </div>

              {/* Navigasi Riwayat Langkah */}
              <div className="cm-ply-nav">
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={moves.length === 0 || viewingPly === 0}
                  onClick={() => setViewingPly(0)}
                  title="Posisi Awal"
                >
                  |&lt;
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={moves.length === 0 || viewingPly === 0}
                  onClick={() =>
                    setViewingPly(prev => Math.max(0, (prev === null ? moves.length : prev) - 1))
                  }
                  title="Langkah Sebelumnya"
                >
                  &lt;
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={isLiveBoard}
                  onClick={() =>
                    setViewingPly(prev => {
                      if (prev === null) return null;
                      return prev + 1 >= moves.length ? null : prev + 1;
                    })
                  }
                  title="Langkah Berikutnya"
                >
                  &gt;
                </button>
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  disabled={isLiveBoard}
                  onClick={() => setViewingPly(null)}
                  title="Posisi Terbaru"
                >
                  &gt;|
                </button>
              </div>

              <div className="cm-moves-list">
                {movePairs.length === 0 ? (
                  <p className="cm-moves-empty">Belum ada langkah. Putih melangkah lebih dulu.</p>
                ) : (
                  movePairs.map(pair => (
                    <div key={pair.moveNumber} className="cm-move-row">
                      <span className="cm-move-num">{pair.moveNumber}.</span>
                      <button
                        type="button"
                        className={`cm-move-san ${
                          (viewingPly ?? moves.length) === pair.white?.ply ? 'is-active' : ''
                        }`}
                        onClick={() => setViewingPly(pair.white?.ply)}
                      >
                        {pair.white?.san || ''}
                      </button>
                      {pair.black ? (
                        <button
                          type="button"
                          className={`cm-move-san ${
                            (viewingPly ?? moves.length) === pair.black?.ply ? 'is-active' : ''
                          }`}
                          onClick={() => setViewingPly(pair.black?.ply)}
                        >
                          {pair.black.san}
                        </button>
                      ) : (
                        <span className="cm-move-san cm-move-san--placeholder">...</span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Kartu Hasil Pertandingan & Rematch */}
            {room.phase === 'completed' && (
              <div className={`cm-result-card ${iWon ? 'is-win' : isDraw ? 'is-draw' : 'is-loss'}`}>
                <div className="cm-result-card__badge">
                  {iWon ? '🏆 KEMENANGAN!' : isDraw ? '🤝 REMIS (DRAW)' : '⚔️ PERTANDINGAN SELESAI'}
                </div>
                <h3 className="cm-result-card__title">
                  {winnerPlayer
                    ? `Pemenang: ${winnerPlayer.name} (${winnerSide === 'w' ? 'Putih' : 'Hitam'})`
                    : 'Pertandingan Berakhir Remis'}
                </h3>
                <p className="cm-result-card__sub">
                  {resultCode} · {formatResultReason(resultReasonCode)}
                </p>

                <div className="cm-result-card__elo">
                  <div>
                    <span>Perubahan Rating Elo</span>
                    <strong className={myDelta > 0 ? 'is-pos' : myDelta < 0 ? 'is-neg' : ''}>
                      {myDelta > 0 ? `+${myDelta}` : myDelta ?? 0} Elo
                    </strong>
                  </div>
                  {iWon && endSummary?.rewardCoins > 0 && (
                    <div className="cm-result-card__coins">
                      <Icon name="coin" size={16} />
                      <span>+{endSummary.rewardCoins} Coins</span>
                    </div>
                  )}
                </div>

                <div className="cm-result-card__actions">
                  <button
                    type="button"
                    className="btn btn--secondary btn--block"
                    onClick={() => startGameReview(0)}
                  >
                    🔍 Review Permainan ({moves.length} Langkah)
                  </button>
                  <button
                    type="button"
                    className="btn btn--primary btn--block"
                    onClick={actions.requestRematch}
                  >
                    {rematchRequestedByMe
                      ? 'Menunggu Lawan Menerima Rematch...'
                      : rematchRequestedByOpponent
                      ? '⚡ Terima Tantangan Rematch!'
                      : '🔄 Tantang Rematch'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--block"
                    onClick={() => actions.downloadPgn(match.id)}
                  >
                    <Icon name="download" size={16} />
                    <span>Unduh Notasi PGN</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--block"
                    onClick={actions.leaveRoom}
                  >
                    Kembali ke Lobby Chess Master
                  </button>
                </div>
              </div>
            )}

            {/* Panel Obrolan Desktop (seperti JakLudo) */}
            <div className="cm-side-card show-desktop">
              <div className="cm-side-card__head">
                <strong>💬 Obrolan Room</strong>
              </div>
              <ChatPanel
                chats={chats}
                playerId={myUserId}
                onSend={actions.sendChat}
                quickChats={CHESS_QUICK_CHATS}
              />
            </div>
          </aside>
        </div>

        {/* MODAL UTAMA HASIL PERTANDINGAN & SIAPA PEMENANG (Otomatis menutup gameplay saat selesai) */}
        {room.phase === 'completed' && showResultModal && (
          <div
            className="modal-backdrop cm-gameover-backdrop"
            role="dialog"
            aria-modal="true"
            aria-labelledby="cm-gameover-title"
          >
            <div
              className={`modal-sheet cm-gameover-modal ${
                iWon ? 'is-win' : isDraw ? 'is-draw' : 'is-loss'
              }`}
              onClick={e => e.stopPropagation()}
            >
              <button
                type="button"
                className="cm-gameover-close"
                aria-label="Tutup modal dan masuk ke Review Permainan"
                onClick={() => startGameReview(moves.length)}
              >
                <Icon name="close" size={18} />
              </button>

              <div className="cm-gameover-hero">
                <div className="cm-gameover-emblem" aria-hidden="true">
                  {isDraw ? '🤝' : iWon ? '🏆' : '👑'}
                </div>
                <span className="cm-gameover-kicker">
                  {isDraw
                    ? 'PERTANDINGAN REMIS (DRAW)'
                    : iWon
                    ? 'SELAMAT! KAMU MENANG!'
                    : 'PERTANDINGAN SELESAI'}
                </span>
                <h2 id="cm-gameover-title" className="cm-gameover-title">
                  {isDraw
                    ? 'Tidak Ada Pemenang (Remis)'
                    : `Pemenang: ${winnerPlayer?.name || 'Pemain'}`}
                </h2>
                <p className="cm-gameover-reason">
                  {resultCode ? `${resultCode} · ` : ''}
                  {formatResultReason(resultReasonCode)}
                </p>
              </div>

              {/* Kartu Highlight Pemenang */}
              {!isDraw && winnerPlayer && (
                <div className="cm-winner-spotlight">
                  <div className="cm-winner-spotlight__avatar-wrap">
                    <PlayerAvatar player={winnerPlayer} size={56} />
                    <span className="cm-winner-crown" aria-hidden="true">👑</span>
                  </div>
                  <div className="cm-winner-spotlight__info">
                    <span className="cm-winner-spotlight__label">PEMENANG PERTANDINGAN</span>
                    <strong className="cm-winner-spotlight__name">
                      {winnerPlayer.name}
                      {winnerPlayer.userId === myUserId ? ' (Kamu)' : ''}
                    </strong>
                    <div className="cm-winner-spotlight__tags">
                      <span className={`cm-color-badge cm-color-badge--${winnerSide}`}>
                        Bidak {winnerSide === 'w' ? 'Putih ♔' : 'Hitam ♚'}
                      </span>
                      <span className="cm-winner-spotlight__elo">
                        Rating {winnerSide === 'w'
                          ? endSummary?.whiteRatingAfter || winnerPlayer.rating || 1200
                          : endSummary?.blackRatingAfter || winnerPlayer.rating || 1200}{' '}
                        Elo
                      </span>
                    </div>
                  </div>
                  {iWon && endSummary?.rewardCoins > 0 && (
                    <div className="cm-winner-spotlight__reward">
                      <Icon name="coin" size={18} />
                      <span>+{endSummary.rewardCoins} Coins</span>
                    </div>
                  )}
                </div>
              )}

              {/* Perbandingan Kedua Pemain (Putih vs Hitam) */}
              <div className="cm-gameover-versus">
                <div className={`cm-gameover-player ${winnerSide === 'w' ? 'is-winner' : ''}`}>
                  <PlayerAvatar player={match.whitePlayer || { name: 'Putih' }} size={40} />
                  <div className="cm-gameover-player__meta">
                    <strong>
                      {match.whitePlayer?.name || 'Putih'}
                      {winnerSide === 'w' && ' 🏆'}
                    </strong>
                    <span>
                      ♔ Putih · {endSummary?.whiteRatingAfter || match.whitePlayer?.rating || 1200} Elo{' '}
                      <em className={whiteDelta > 0 ? 'is-pos' : whiteDelta < 0 ? 'is-neg' : ''}>
                        ({whiteDelta > 0 ? `+${whiteDelta}` : whiteDelta})
                      </em>
                    </span>
                  </div>
                </div>

                <span className="cm-gameover-vs-badge">VS</span>

                <div className={`cm-gameover-player ${winnerSide === 'b' ? 'is-winner' : ''}`}>
                  <PlayerAvatar player={match.blackPlayer || { name: 'Hitam' }} size={40} />
                  <div className="cm-gameover-player__meta">
                    <strong>
                      {match.blackPlayer?.name || 'Hitam'}
                      {winnerSide === 'b' && ' 🏆'}
                    </strong>
                    <span>
                      ♚ Hitam · {endSummary?.blackRatingAfter || match.blackPlayer?.rating || 1200} Elo{' '}
                      <em className={blackDelta > 0 ? 'is-pos' : blackDelta < 0 ? 'is-neg' : ''}>
                        ({blackDelta > 0 ? `+${blackDelta}` : blackDelta})
                      </em>
                    </span>
                  </div>
                </div>
              </div>

              {/* Ringkasan Statistik Pertandingan untuk Review */}
              <div className="cm-gameover-stats">
                <div className="cm-gameover-stat">
                  <span>Total Langkah</span>
                  <strong>{reviewStats.totalTurns} langkah ({reviewStats.totalPlies} ply)</strong>
                </div>
                <div className="cm-gameover-stat">
                  <span>Makan Bidak (P/H)</span>
                  <strong>{reviewStats.whiteCaptures} / {reviewStats.blackCaptures}</strong>
                </div>
                <div className="cm-gameover-stat">
                  <span>Serangan Skak</span>
                  <strong>{reviewStats.whiteChecks + reviewStats.blackChecks}x</strong>
                </div>
                <div className="cm-gameover-stat">
                  <span>Mode Waktu</span>
                  <strong>{match.timeControl}</strong>
                </div>
              </div>

              {/* Tombol Aksi Utama: Review Permainan, Rematch, PGN, & Lobby */}
              <div className="cm-gameover-actions">
                <button
                  type="button"
                  className="btn btn--secondary btn--lg btn--block cm-btn-review"
                  onClick={() => startGameReview(0)}
                >
                  🔍 Review Permainan (Analisis Langkah demi Langkah)
                </button>

                <button
                  type="button"
                  className="btn btn--primary btn--lg btn--block"
                  onClick={() => {
                    sound.playClick();
                    actions.requestRematch();
                  }}
                >
                  {rematchRequestedByMe
                    ? '⏳ Menunggu Lawan Menerima Rematch...'
                    : rematchRequestedByOpponent
                    ? '⚡ Terima Tantangan Rematch Sekarang!'
                    : '🔄 Main Lagi (Tantang Rematch)'}
                </button>

                <div className="cm-gameover-actions__row">
                  <button
                    type="button"
                    className="btn btn--ghost btn--block"
                    onClick={() => actions.downloadPgn(match.id)}
                  >
                    <Icon name="download" size={16} />
                    <span>Unduh PGN</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--block"
                    onClick={actions.leaveRoom}
                  >
                    🏠 Ke Lobby Catur
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        <Modal
          isOpen={Boolean(chatOpen)}
          onClose={() => actions.setChatOpen(false)}
          variant="sheet"
          title="Obrolan room"
          icon="💬"
        >
          <ChatPanel
            chats={chats}
            playerId={myUserId}
            onSend={actions.sendChat}
            quickChats={CHESS_QUICK_CHATS}
          />
        </Modal>

        {/* Drawer Riwayat Langkah untuk Mobile */}
        {mobileMovesOpen && (
          <div className="modal-backdrop" onClick={() => setMobileMovesOpen(false)}>
            <div className="modal-sheet cm-mobile-moves-sheet" onClick={e => e.stopPropagation()}>
              <div className="cm-side-card__head">
                <strong>Riwayat Langkah ({moves.length} ply)</strong>
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setMobileMovesOpen(false)}>
                  <Icon name="close" size={16} />
                </button>
              </div>
              <div className="cm-moves-list">
                {movePairs.length === 0 ? (
                  <p className="cm-moves-empty">Belum ada langkah.</p>
                ) : (
                  movePairs.map(pair => (
                    <div key={pair.moveNumber} className="cm-move-row">
                      <span className="cm-move-num">{pair.moveNumber}.</span>
                      <button
                        type="button"
                        className="cm-move-san"
                        onClick={() => {
                          setViewingPly(pair.white?.ply);
                          setMobileMovesOpen(false);
                        }}
                      >
                        {pair.white?.san || ''}
                      </button>
                      <button
                        type="button"
                        className="cm-move-san"
                        onClick={() => {
                          if (pair.black) {
                            setViewingPly(pair.black.ply);
                            setMobileMovesOpen(false);
                          }
                        }}
                      >
                        {pair.black?.san || ''}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ==========================================
  // RENDER 2: PRIVATE ROOM LOBBY (WAITING ROOM)
  // ==========================================
  if (room && room.phase === 'lobby') {
    const isHost = room.hostUserId === myUserId;
    const mePlayer = room.players?.find(p => p.userId === myUserId);
    const opponentPlayer = room.players?.find(p => p.userId !== myUserId);

    return (
      <div className="cm-screen cm-screen--room-lobby">
        <header className="cm-topbar">
          <button type="button" className="btn btn--ghost btn--sm" onClick={actions.leaveRoom}>
            <Icon name="arrow-left" size={16} />
            <span>Tinggalkan Room</span>
          </button>
          <div className="cm-topbar__brand">
            <Icon name="chess" size={18} />
            <strong>Private Room · Chess Master</strong>
          </div>
          <div className="cm-topbar__right">
            <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenAudio}>
              <Icon name="volume-on" size={16} />
            </button>
          </div>
        </header>

        {error && <div className="cm-toast cm-toast--error">{error}</div>}
        {notice && <div className="cm-toast cm-toast--notice">{notice}</div>}

        <div className="cm-private-lobby">
          <div className="cm-room-code-box">
            <span className="cm-room-code-box__label">Kode Private Room</span>
            <strong className="cm-room-code-box__code">{room.code}</strong>
            <p className="cm-room-code-box__hint">
              Bagikan kode ini kepada temanmu untuk berduel catur secara langsung.
            </p>
            <button type="button" className="btn btn--primary btn--sm" onClick={handleCopyCode}>
              {copied ? '✓ Kode Tersalin!' : '📋 Salin Kode Room'}
            </button>
          </div>

          {/* Pengaturan Room (Host) */}
          <div className="cm-room-config-card">
            <h3>Pengaturan Pertandingan</h3>
            <div className="cm-config-group">
              <label>Time Control</label>
              <div className="cm-tc-grid">
                {CHESS_TIME_CONTROLS.map(tc => (
                  <button
                    key={tc.id}
                    type="button"
                    disabled={!isHost}
                    className={`cm-tc-btn ${room.timeControl === tc.id ? 'is-selected' : ''}`}
                    onClick={() => actions.updateRoomConfig({ timeControl: tc.id })}
                  >
                    <strong>{tc.label}</strong>
                    <span>{tc.category.toUpperCase()}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="cm-config-group">
              <label>Pilihan Bidak Host</label>
              <div className="cm-side-picker">
                {[
                  { id: 'random', label: '🎲 Acak' },
                  { id: 'w', label: '♔ Putih' },
                  { id: 'b', label: '♚ Hitam' }
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    disabled={!isHost}
                    className={`cm-side-btn ${room.preferredSide === opt.id ? 'is-selected' : ''}`}
                    onClick={() => actions.updateRoomConfig({ preferredSide: opt.id })}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Slot Kedua Pemain */}
          <div className="cm-lobby-slots">
            <div className={`cm-lobby-slot ${mePlayer?.ready ? 'is-ready' : ''}`}>
              <PlayerAvatar player={mePlayer || currentUser || { name: 'Kamu' }} size={48} />
              <div className="cm-lobby-slot__info">
                <strong>{mePlayer?.name || currentUser?.name} (Kamu)</strong>
                <span>Rating Elo: {mePlayer?.rating || myRating}</span>
              </div>
              <span className={`badge ${mePlayer?.ready ? 'badge--success' : 'badge--muted'}`}>
                {mePlayer?.ready ? '✓ Siap' : 'Belum Siap'}
              </span>
            </div>

            <div className="cm-lobby-vs">VS</div>

            <div className={`cm-lobby-slot ${opponentPlayer?.ready ? 'is-ready' : ''}`}>
              {opponentPlayer ? (
                <>
                  <PlayerAvatar player={opponentPlayer} size={48} />
                  <div className="cm-lobby-slot__info">
                    <strong>{opponentPlayer.name}</strong>
                    <span>Rating Elo: {opponentPlayer.rating || 1200}</span>
                  </div>
                  <span className={`badge ${opponentPlayer.ready ? 'badge--success' : 'badge--muted'}`}>
                    {opponentPlayer.ready ? '✓ Siap' : 'Belum Siap'}
                  </span>
                </>
              ) : (
                <div className="cm-lobby-slot__empty">
                  <span>Menunggu pemain kedua bergabung dengan kode <strong>{room.code}</strong>...</span>
                </div>
              )}
            </div>
          </div>

          <div className="cm-private-lobby__footer">
            <div className="turn-panel__toolbar" style={{ width: '100%', marginBottom: '0.6rem' }}>
              <div className="reaction-row" role="group" aria-label="Kirim reaksi">
                {REACTIONS.map(emoji => (
                  <button
                    key={emoji}
                    type="button"
                    className="icon-btn icon-btn--plain"
                    aria-label={`Kirim reaksi ${emoji}`}
                    onClick={() => actions.sendReaction(emoji)}
                  >
                    <span aria-hidden="true">{emoji}</span>
                  </button>
                ))}
              </div>
              <div className="turn-panel__tools">
                <button
                  type="button"
                  className="icon-btn"
                  aria-label={`Buka obrolan${unreadChats ? `, ${unreadChats} pesan baru` : ''}`}
                  onClick={() => {
                    sound.playClick();
                    actions.setChatOpen(true);
                  }}
                >
                  <span aria-hidden="true">💬</span>
                  {unreadChats > 0 && <span className="count-badge" aria-hidden="true">{unreadChats}</span>}
                </button>
              </div>
            </div>

            <button
              type="button"
              className={`btn btn--lg btn--block ${mePlayer?.ready ? 'btn--ghost' : 'btn--primary'}`}
              onClick={() => actions.toggleReady(!mePlayer?.ready)}
            >
              {mePlayer?.ready ? 'Batal Siap' : '✓ Siap Bermain!'}
            </button>
            <p className="cm-private-lobby__note">
              Pertandingan otomatis dimulai segera setelah kedua pemain menekan tombol Siap.
            </p>
          </div>
        </div>

        <Modal
          isOpen={Boolean(chatOpen)}
          onClose={() => actions.setChatOpen(false)}
          variant="sheet"
          title="Obrolan room"
          icon="💬"
        >
          <ChatPanel
            chats={chats}
            playerId={myUserId}
            onSend={actions.sendChat}
            quickChats={CHESS_QUICK_CHATS}
          />
        </Modal>
      </div>
    );
  }

  // ==========================================
  // RENDER 3: CHESS MASTER MAIN LOBBY
  // ==========================================
  const visibleTimeControls = showAllTimeControls
    ? CHESS_TIME_CONTROLS
    : CHESS_TIME_CONTROLS.filter(tc => tc.featured);

  return (
    <div className="cm-screen cm-screen--lobby">
      {/* Topbar Lobby */}
      <header className="cm-topbar">
        <button type="button" className="btn btn--ghost btn--sm" onClick={onBackToMenu}>
          <Icon name="arrow-left" size={16} />
          <span>PlayGo Hub</span>
        </button>

        <div className="cm-topbar__brand">
          <Icon name="chess" size={18} />
          <strong>Chess Master</strong>
        </div>

        <div className="cm-topbar__right">
          {currentUser ? (
            <button type="button" className="cm-coins-pill" onClick={onOpenShop} title="Top Up Coins">
              <Icon name="coin" size={15} />
              <strong>{(currentUser.points || 0).toLocaleString('id-ID')}</strong>
              <span>Coins</span>
            </button>
          ) : (
            <button type="button" className="btn btn--primary btn--sm" onClick={() => onOpenAuth?.('login')}>
              Masuk
            </button>
          )}
          <button type="button" className="btn btn--ghost btn--sm" onClick={onOpenAudio} aria-label="Suara">
            <Icon name="volume-on" size={16} />
          </button>
        </div>
      </header>

      {error && <div className="cm-toast cm-toast--error">{error}</div>}
      {notice && <div className="cm-toast cm-toast--notice">{notice}</div>}

      <div className="cm-lobby-container">
        {/* Hero Banner + Player Profile Summary */}
        <section className="cm-hero-card">
          <div className="cm-hero-card__art">
            <img src={chessMasterLogo} alt="Chess Master PlayGo" className="cm-hero-card__img" />
            <span className="cm-hero-card__tag">Strategy / Board Game</span>
          </div>

          <div className="cm-hero-card__body">
            <div className="cm-hero-card__heading">
              <h1>Chess Master</h1>
              <p className="cm-hero-card__tagline">Master the Board. Rule the Game.</p>
              <p className="cm-hero-card__desc">
                Challenge your friends in classic online chess. Sistem rating Elo resmi, validasi server penuh,
                dan hadiah <strong>+15 Coins</strong> setiap menang!
              </p>
            </div>

            {/* Statistik Pemain Saat Ini */}
            <div className="cm-profile-strip">
              <div className="cm-profile-strip__user">
                <PlayerAvatar
                  player={currentUser || { name: 'Tamu', avatar: '♟️' }}
                  size={44}
                  onClick={() => currentUser && onViewProfile?.(currentUser.id)}
                />
                <div>
                  <strong>{currentUser?.name || 'Pemain Tamu'}</strong>
                  <span>Puncak Rating: {myHighest} Elo</span>
                </div>
              </div>

              <div className="cm-profile-metrics">
                <div className="cm-metric">
                  <span>Rating Elo</span>
                  <strong className="cm-metric--elo">{myRating}</strong>
                </div>
                <div className="cm-metric">
                  <span>Total Match</span>
                  <strong>{myTotalGames}</strong>
                </div>
                <div className="cm-metric">
                  <span>M / K / S</span>
                  <strong>
                    {myWins} / {myLosses} / {myDraws}
                  </strong>
                </div>
                <div className="cm-metric">
                  <span>Win Rate</span>
                  <strong>{myWinRate}%</strong>
                </div>
                <div className="cm-metric">
                  <span>Streak</span>
                  <strong>🔥 {myStreak}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Grid Mode Permainan: Quick Match & Private Room */}
        <section className="cm-modes-grid">
          {/* Card 1: Quick Match + Time Control */}
          <div className="cm-mode-card cm-mode-card--primary">
            <div className="cm-mode-card__head">
              <div>
                <span className="cm-mode-badge">ONLINE MULTIPLAYER</span>
                <h2>Quick Match</h2>
                <p>Cari lawan seimbang secara otomatis berdasarkan rating Elo.</p>
              </div>
            </div>

            <div className="cm-tc-section">
              <div className="cm-tc-section__top">
                <span>Pilih Time Control</span>
                <button
                  type="button"
                  className="cm-link-btn"
                  onClick={() => setShowAllTimeControls(v => !v)}
                >
                  {showAllTimeControls ? 'Tampilkan Utama (5+0 & 10+0)' : 'Semua Mode Waktu (Bullet/Blitz/Rapid)'}
                </button>
              </div>

              <div className="cm-tc-grid">
                {visibleTimeControls.map(tc => (
                  <button
                    key={tc.id}
                    type="button"
                    disabled={searching}
                    className={`cm-tc-btn ${timeControl === tc.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      sound.playClick();
                      setTimeControl(tc.id);
                    }}
                  >
                    <strong>{tc.label}</strong>
                    <span>{tc.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {searching ? (
              <div className="cm-searching-box">
                <div className="cm-spinner" />
                <div>
                  <strong>Mencari lawan ({timeControl})...</strong>
                  <span>Menyesuaikan pemain dengan rating di sekitar {myRating} Elo</span>
                </div>
                <button type="button" className="btn btn--danger btn--sm" onClick={actions.cancelMatchmaking}>
                  Batal
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn btn--primary btn--lg btn--block cm-play-now-btn"
                onClick={() => actions.startMatchmaking(timeControl)}
              >
                <Icon name="chess" size={20} />
                <span>Play Now ({timeControl})</span>
              </button>
            )}
          </div>

          {/* Card 2: Private Room (Create & Join) */}
          <div className="cm-mode-card">
            <div className="cm-mode-card__head">
              <div>
                <span className="cm-mode-badge cm-mode-badge--alt">DUEL TEMAN</span>
                <h2>Private Room</h2>
                <p>Buat room dengan kode unik atau bergabung ke room temanmu.</p>
              </div>
            </div>

            <div className="cm-side-picker-wrap">
              <span className="cm-field-label">Preferensi Warna Bidak</span>
              <div className="cm-side-picker">
                {[
                  { id: 'random', label: '🎲 Acak' },
                  { id: 'w', label: '♔ Putih' },
                  { id: 'b', label: '♚ Hitam' }
                ].map(opt => (
                  <button
                    key={opt.id}
                    type="button"
                    className={`cm-side-btn ${preferredSide === opt.id ? 'is-selected' : ''}`}
                    onClick={() => {
                      sound.playClick();
                      setPreferredSide(opt.id);
                    }}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              className="btn btn--secondary btn--block"
              onClick={() => actions.createRoom({ timeControl, preferredSide })}
            >
              + Create Private Room
            </button>

            <div className="cm-divider">
              <span>ATAU MASUKKAN KODE</span>
            </div>

            <form
              className="cm-join-form"
              onSubmit={e => {
                e.preventDefault();
                actions.joinRoomByCode();
              }}
            >
              <input
                type="text"
                className="input cm-join-input"
                placeholder="KODE ROOM (mis. A7K9Q)"
                maxLength={8}
                value={joinCode}
                onChange={e => setJoinCode(e.target.value.toUpperCase())}
              />
              <button type="submit" className="btn btn--primary">
                Join Room
              </button>
            </form>
          </div>
        </section>

        {/* Section Bawah: Chess Leaderboard & Riwayat Pertandingan */}
        <section className="cm-hub-card">
          <div className="cm-hub-tabs">
            <button
              type="button"
              className={`cm-hub-tab ${hubTab === 'leaderboard' ? 'is-active' : ''}`}
              onClick={() => setHubTab('leaderboard')}
            >
              <Icon name="trophy" size={16} />
              <span>Leaderboard Rating Elo</span>
            </button>
            <button
              type="button"
              className={`cm-hub-tab ${hubTab === 'history' ? 'is-active' : ''}`}
              onClick={() => setHubTab('history')}
            >
              <Icon name="clock" size={16} />
              <span>Riwayat Pertandingan ({recentMatches.length})</span>
            </button>
          </div>

          {hubTab === 'leaderboard' ? (
            <div className="cm-leaderboard-pane">
              {leaderboardMeta.myEntry && (
                <div className="cm-my-rank-banner">
                  <span>Peringkatmu Saat Ini: <strong>#{leaderboardMeta.myEntry.rank}</strong></span>
                  <span>Rating: <strong>{leaderboardMeta.myEntry.rating} Elo</strong> · Win Rate {leaderboardMeta.myEntry.winRate}%</span>
                </div>
              )}

              {leaderboard.length === 0 ? (
                <p className="cm-empty-state">
                  Belum ada pemain di papan peringkat Chess Master. Mainkan pertandingan pertamamu!
                </p>
              ) : (
                <div className="cm-table-wrap">
                  <table className="cm-table">
                    <thead>
                      <tr>
                        <th>Rank</th>
                        <th>Pemain</th>
                        <th>Rating</th>
                        <th>Match</th>
                        <th>Win Rate</th>
                      </tr>
                    </thead>
                    <tbody>
                      {leaderboard.map(entry => (
                        <tr
                          key={entry.userId}
                          className={entry.userId === myUserId ? 'is-me' : ''}
                          onClick={() => onViewProfile?.(entry.userId)}
                        >
                          <td className="cm-table__rank">#{entry.rank}</td>
                          <td>
                            <div className="cm-table__player">
                              <PlayerAvatar player={entry} size={30} />
                              <strong>{entry.name}</strong>
                            </div>
                          </td>
                          <td>
                            <strong className="cm-elo-pill">{entry.rating}</strong>
                          </td>
                          <td>{entry.totalGames}</td>
                          <td>{entry.winRate}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {leaderboardMeta.totalPages > 1 && (
                <div className="cm-pagination">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={leaderboardMeta.page <= 1}
                    onClick={() => actions.loadLeaderboardPage(leaderboardMeta.page - 1)}
                  >
                    &lt; Sebelumnya
                  </button>
                  <span>
                    Halaman {leaderboardMeta.page} / {leaderboardMeta.totalPages}
                  </span>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={leaderboardMeta.page >= leaderboardMeta.totalPages}
                    onClick={() => actions.loadLeaderboardPage(leaderboardMeta.page + 1)}
                  >
                    Berikutnya &gt;
                  </button>
                </div>
              )}
            </div>
          ) : (
            <div className="cm-history-pane">
              {!currentUser ? (
                <p className="cm-empty-state">Silakan masuk untuk melihat riwayat pertandingan caturmu.</p>
              ) : recentMatches.length === 0 ? (
                <p className="cm-empty-state">Belum ada riwayat pertandingan yang selesai.</p>
              ) : (
                <div className="cm-history-list">
                  {recentMatches.map(item => {
                    const isWhite = item.whitePlayer?.userId === myUserId;
                    const opponent = isWhite ? item.blackPlayer : item.whitePlayer;
                    const myWin = item.winnerId === myUserId;
                    const isDrawMatch = !item.winnerId || item.result === '1/2-1/2';
                    const ratingDelta = isWhite ? item.whiteRatingChange : item.blackRatingChange;

                    return (
                      <div key={item.id} className="cm-history-item">
                        <div className="cm-history-item__left">
                          <span
                            className={`cm-outcome-badge ${
                              myWin ? 'is-win' : isDrawMatch ? 'is-draw' : 'is-loss'
                            }`}
                          >
                            {myWin ? 'MENANG' : isDrawMatch ? 'REMIS' : 'KALAH'}
                          </span>
                          <div>
                            <div className="cm-history-item__vs">
                              <strong>vs {opponent?.name || 'Lawan'}</strong>
                              <span className={`cm-color-badge cm-color-badge--${isWhite ? 'w' : 'b'}`}>
                                {isWhite ? 'Putih' : 'Hitam'}
                              </span>
                              <span className="cm-tc-pill">{item.timeControl}</span>
                            </div>
                            <div className="cm-history-item__meta">
                              <span>{formatResultReason(item.resultReason)}</span>
                              <span>· {item.movesCount || 0} langkah</span>
                              <span>· Durasi {formatDuration(item.durationSeconds)}</span>
                            </div>
                          </div>
                        </div>

                        <div className="cm-history-item__right">
                          <strong
                            className={`cm-rating-delta ${
                              ratingDelta > 0 ? 'is-pos' : ratingDelta < 0 ? 'is-neg' : ''
                            }`}
                          >
                            {ratingDelta > 0 ? `+${ratingDelta}` : ratingDelta || 0} Elo
                          </strong>
                          <div className="cm-history-item__btns">
                            <button
                              type="button"
                              className="btn btn--secondary btn--sm"
                              onClick={() => actions.openReplay(item.id)}
                            >
                              🔍 Review Permainan
                            </button>
                            <button
                              type="button"
                              className="btn btn--ghost btn--sm"
                              onClick={() => actions.downloadPgn(item.id)}
                            >
                              PGN
                            </button>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      </div>

      {/* Modal Review & Replay Pertandingan */}
      {replayMatch && (
        <div className="modal-backdrop" onClick={actions.closeReplay}>
          <div className="modal-sheet cm-replay-modal" onClick={e => e.stopPropagation()}>
            <div className="cm-side-card__head">
              <div>
                <strong>
                  🔍 Review Permainan: {replayMatch.whitePlayer?.name} (Putih) vs {replayMatch.blackPlayer?.name} (Hitam)
                </strong>
                <span className="cm-side-card__sub">
                  {replayMatch.result} · {formatResultReason(replayMatch.resultReason)} · {replayStats.totalTurns} langkah ({replayStats.totalPlies} ply)
                </span>
              </div>
              <button type="button" className="btn btn--ghost btn--sm" onClick={actions.closeReplay}>
                <Icon name="close" size={16} />
              </button>
            </div>

            <div className="cm-replay-body">
              <div className="cm-replay-board">
                <ChessBoard
                  fen={replayFen}
                  orientation="w"
                  interactive={false}
                  lastMove={replayLastMove}
                />

                <div className="cm-review-commentary">
                  <div className="cm-review-panel__title-group" style={{ marginBottom: 4 }}>
                    <span className={`cm-review-tag cm-review-tag--${replayMoveInfo.tagType}`}>
                      {replayMoveInfo.tag}
                    </span>
                  </div>
                  <strong>{replayMoveInfo.title}</strong>
                  <p>{replayMoveInfo.detail}</p>
                </div>

                {replayMoves.length > 0 && (
                  <div className="cm-review-slider-row">
                    <span>0</span>
                    <input
                      type="range"
                      min={0}
                      max={replayMoves.length}
                      value={replayPly}
                      onChange={e => {
                        setAutoPlayReplay(false);
                        setReplayPly(Number(e.target.value));
                      }}
                      className="cm-review-slider"
                      aria-label="Timeline review langkah"
                    />
                    <span>{replayMoves.length}</span>
                  </div>
                )}

                <div className="cm-ply-nav">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={replayPly <= 0}
                    onClick={() => {
                      setAutoPlayReplay(false);
                      setReplayPly(0);
                    }}
                  >
                    |&lt; Awal
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={replayPly <= 0}
                    onClick={() => {
                      setAutoPlayReplay(false);
                      setReplayPly(p => Math.max(0, p - 1));
                    }}
                  >
                    &lt; Mundur
                  </button>
                  <button
                    type="button"
                    className={`btn btn--sm ${autoPlayReplay ? 'btn--danger' : 'btn--primary'}`}
                    onClick={() => {
                      sound.playClick();
                      if (!autoPlayReplay && replayPly >= replayMoves.length) {
                        setReplayPly(0);
                      }
                      setAutoPlayReplay(v => !v);
                    }}
                  >
                    {autoPlayReplay ? '⏸️ Jeda' : '▶️ Putar'}
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={replayPly >= replayMoves.length}
                    onClick={() => {
                      setAutoPlayReplay(false);
                      setReplayPly(p => Math.min(replayMoves.length, p + 1));
                    }}
                  >
                    Maju &gt;
                  </button>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    disabled={replayPly >= replayMoves.length}
                    onClick={() => {
                      setAutoPlayReplay(false);
                      setReplayPly(replayMoves.length);
                    }}
                  >
                    Akhir &gt;|
                  </button>
                </div>
              </div>

              <div className="cm-replay-moves">
                <div className="cm-moves-list">
                  {replayPairs.map(pair => (
                    <div key={pair.moveNumber} className="cm-move-row">
                      <span className="cm-move-num">{pair.moveNumber}.</span>
                      <button
                        type="button"
                        className={`cm-move-san ${replayPly === pair.white?.ply ? 'is-active' : ''}`}
                        onClick={() => {
                          setAutoPlayReplay(false);
                          setReplayPly(pair.white?.ply || 0);
                        }}
                      >
                        {pair.white?.san || ''}
                      </button>
                      {pair.black && (
                        <button
                          type="button"
                          className={`cm-move-san ${replayPly === pair.black?.ply ? 'is-active' : ''}`}
                          onClick={() => {
                            setAutoPlayReplay(false);
                            setReplayPly(pair.black?.ply || 0);
                          }}
                        >
                          {pair.black.san}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="btn btn--primary btn--sm btn--block"
                  onClick={() => actions.downloadPgn(replayMatch.id)}
                >
                  <Icon name="download" size={14} />
                  <span>Download PGN</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


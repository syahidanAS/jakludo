import React, { useEffect, useState, useRef, useMemo } from 'react';
import {
  COLORS,
  START_TILES,
  TRACK_COORDS,
  SAFE_TRACK_INDICES,
  getPawnCoord
} from './boardConstants';
import { sound } from './sound';
import { HudTimer } from './components/game/TurnTimer';

// Pemetaan sudut layar (Top-Left, Top-Right, Bottom-Left, Bottom-Right)
// berdasarkan sudut rotasi papan agar badge nama pemain selalu sejajar dengan letak markasnya
function getCornerColors(rotation) {
  switch (rotation) {
    case 90:
      return { tl: 'red', tr: 'green', bl: 'blue', br: 'yellow' };
    case 180:
      return { tl: 'blue', tr: 'red', bl: 'yellow', br: 'green' };
    case 270:
      return { tl: 'yellow', tr: 'blue', bl: 'green', br: 'red' };
    case 0:
    default:
      return { tl: 'green', tr: 'yellow', bl: 'red', br: 'blue' };
  }
}

// Wrapper: room bisa null sebelum data pertama datang. Hook ada di LudoBoardView,
// jadi return lebih awal di sini tidak melanggar aturan hooks React.
// Di-memo: papan tidak perlu digambar ulang saat hanya chat/reaksi yang berubah
const LudoBoard = React.memo(function LudoBoard(props) {
  if (!props.room) return null;
  return <LudoBoardView {...props} />;
});
export default LudoBoard;

// Indeks lintasan per petak "baris,kolom", dihitung sekali (bukan findIndex di tiap petak)
const TRACK_INDEX_BY_CELL = new Map(TRACK_COORDS.map(([r, c], i) => [`${r},${c}`, i]));

function LudoBoardView({
  room,
  myPlayerId,
  isMyTurn,
  movablePawns = [],
  onMovePawn,
  targeting = false,
  onSelectTarget
}) {
  const [animPawn, setAnimPawn] = useState(null);
  const activeAnimId = useRef(null);
  // Event yang sudah ada saat papan pertama kali tampil (mis. saat reconnect) dianggap sudah diputar
  const lastPlayedCaptureIdRef = useRef(room.lastCapture?.id ?? null);
  const lastPlayedBlackHoleIdRef = useRef(room.lastBlackHole?.id ?? null);
  const lastPlayedGoalIdRef = useRef(room.lastGoal?.id ?? null);

  const currentTurnPlayer = room.players[room.turn];
  const safeZonesActive = room.settings?.safeZones !== false;
  const blackHoleActive = !!room.settings?.blackHole;
  // Posisi Black Hole dikirim server (bisa berpindah tiap putaran pada mode acak)
  const blackHoles = room.blackHoles || [];

  // Perspektif pemain: Base milik pemain lokal selalu berada di pojok kanan bawah
  const myPlayer = room.players?.find(p => p.id === myPlayerId);
  const myColor = myPlayer?.color;
  const BOARD_ROTATION = {
    blue: 0,
    yellow: 90,
    green: 180,
    red: 270
  };
  const boardRotation = myColor ? (BOARD_ROTATION[myColor] ?? 0) : 0;
  const counterStyle = boardRotation !== 0 ? { transform: `rotate(${-boardRotation}deg)` } : undefined;

  // Hitung kotak tujuan mana saja yang bisa dilewati / dituju oleh bidak pemain aktif
  const validTargets = useMemo(() => {
    if (!isMyTurn || room.dice === null || !myColor || !movablePawns.length) return {};
    const targets = {};
    const myPawns = room.pawns[myPlayerId] || [0, 0, 0, 0];

    movablePawns.forEach(pawnIdx => {
      const currentVal = myPawns[pawnIdx];
      let targetCoord = null;
      let targetVal = 0;

      if (currentVal === 0) {
        // Keluar markas menuju petak start
        targetVal = 1;
        targetCoord = START_TILES[myColor];
      } else {
        // Melangkah maju
        targetVal = currentVal + room.dice;
        targetCoord = getPawnCoord(myColor, targetVal);
      }

      if (targetCoord) {
        const key = `${targetCoord[0]},${targetCoord[1]}`;
        targets[key] = {
          pawnIdx,
          targetVal,
          isExit: currentVal === 0
        };
      }
    });

    return targets;
  }, [isMyTurn, room.dice, myColor, myPlayerId, room.pawns, movablePawns]);

  // Animasi langkah demi langkah saat menerima animatingMove dari server
  useEffect(() => {
    const move = room.animatingMove;
    if (!move || !move.id || activeAnimId.current === move.id) return;

    activeAnimId.current = move.id;

    const stepsSequence = [];
    if (move.from === 0) {
      stepsSequence.push(1);
    } else {
      for (let s = move.from + 1; s <= move.to; s++) {
        stepsSequence.push(s);
      }
    }

    if (stepsSequence.length === 0) return;

    let stepIdx = 0;
    const hopTimers = [];
    setAnimPawn({
      playerId: move.playerId,
      pawnIdx: move.pawnIdx,
      currentVal: stepsSequence[0],
      isHopping: true,
      stepIdx: 0
    });
    sound.playStep(0);

    const stepInterval = setInterval(() => {
      stepIdx++;
      if (stepIdx < stepsSequence.length) {
        sound.playStep(stepIdx);
        setAnimPawn({
          playerId: move.playerId,
          pawnIdx: move.pawnIdx,
          currentVal: stepsSequence[stepIdx],
          isHopping: true,
          stepIdx
        });

        hopTimers.push(setTimeout(() => {
          setAnimPawn(prev => prev ? { ...prev, isHopping: false } : null);
        }, 160));
      } else {
        clearInterval(stepInterval);
        sound.playStepLand();
        setAnimPawn({
          playerId: move.playerId,
          pawnIdx: move.pawnIdx,
          currentVal: move.to,
          isHopping: false,
          stepIdx
        });
      }
    }, 220);

    return () => {
      clearInterval(stepInterval);
      hopTimers.forEach(clearTimeout);
    };
  }, [room.animatingMove]);

  // Saat server selesai memproses animasi, bersihkan animPawn
  useEffect(() => {
    if (!room.animatingMove) {
      setAnimPawn(null);
      activeAnimId.current = null;
    }
  }, [room.animatingMove]);

  // Cek capture effect (bidak terinjak & dieliminasi lawan) - diputar tepat 1 kali per event
  useEffect(() => {
    if (room.lastCapture && room.lastCapture.id && room.lastCapture.id !== lastPlayedCaptureIdRef.current) {
      lastPlayedCaptureIdRef.current = room.lastCapture.id;
      sound.playFunnyElimination();
    }
  }, [room.lastCapture]);

  // Cek Black Hole effect (bidak tersedot ke lubang hitam) - diputar tepat 1 kali per event
  useEffect(() => {
    if (room.lastBlackHole && room.lastBlackHole.id && room.lastBlackHole.id !== lastPlayedBlackHoleIdRef.current) {
      lastPlayedBlackHoleIdRef.current = room.lastBlackHole.id;
      sound.playFunnyBlackHole();
    }
  }, [room.lastBlackHole]);

  // Cek Goal Finish effect (bidak berhasil masuk ke tengah garis akhir)
  useEffect(() => {
    if (room.lastGoal && room.lastGoal.id && room.lastGoal.id !== lastPlayedGoalIdRef.current) {
      lastPlayedGoalIdRef.current = room.lastGoal.id;
      sound.playGoalCelebration();
    }
  }, [room.lastGoal]);

  // Kumpulkan posisi semua bidak yang ada di luar markas (val > 0)
  const pawnsByCoord = {};
  for (const player of room.players) {
    const pList = room.pawns[player.id] || [];
    pList.forEach((rawVal, pIdx) => {
      let effectiveVal = rawVal;
      let isHopping = false;

      if (animPawn && animPawn.playerId === player.id && animPawn.pawnIdx === pIdx) {
        effectiveVal = animPawn.currentVal;
        isHopping = animPawn.isHopping;
      } else if (room.animatingMove && room.animatingMove.playerId === player.id && room.animatingMove.pawnIdx === pIdx) {
        effectiveVal = room.animatingMove.from;
      }

      if (effectiveVal > 0) {
        const coord = getPawnCoord(player.color, effectiveVal);
        if (coord) {
          const key = `${coord[0]},${coord[1]}`;
          if (!pawnsByCoord[key]) pawnsByCoord[key] = [];
          pawnsByCoord[key].push({
            player,
            pawnIdx: pIdx,
            val: effectiveVal,
            isHopping,
            isMine: player.id === myPlayerId,
            canMove: isMyTurn && player.id === myPlayerId && movablePawns.includes(pIdx) && !room.animatingMove
          });
        }
      }
    });
  }

  // Hitung berapa banyak bidak masing-masing warna yang sudah finish (val === 44)
  const finishedCounts = {};
  COLORS.forEach(c => (finishedCounts[c] = 0));
  for (const player of room.players) {
    const pList = room.pawns[player.id] || [];
    finishedCounts[player.color] = pList.filter(v => v === 44).length;
  }

  const handlePawnClick = (pawnIdx, canMove) => {
    if (canMove && onMovePawn && !room.animatingMove) {
      sound.playClick();
      onMovePawn(pawnIdx);
    }
  };

  // Render Base Home Quadrant (Markas 4x4 bersih, proporsional)
  const renderBase = (color, rStart, cStart) => {
    const player = room.players.find(p => p.color === color);
    const pawns = player ? room.pawns[player.id] || [0, 0, 0, 0] : [0, 0, 0, 0];
    const isThisPlayerTurn = currentTurnPlayer?.color === color;

    return (
      <div
        key={`base-${color}`}
        className={`board-base base-${color} ${isThisPlayerTurn ? 'base-active-turn' : ''} ${player?.isOut ? 'base-player-out' : ''} ${!player ? 'base-empty' : ''}`}
        style={{
          gridRow: `${rStart + 1} / span 4`,
          gridColumn: `${cStart + 1} / span 4`
        }}
      >
        <div className="base-inner-card">
          <div className="base-yard" style={counterStyle}>
            {[0, 1, 2, 3].map(pawnIdx => {
              const rawVal = pawns[pawnIdx];
              const isPawnOut = (animPawn && animPawn.playerId === player?.id && animPawn.pawnIdx === pawnIdx)
                ? animPawn.currentVal >= 1
                : rawVal >= 1;
              const inBase = !isPawnOut;
              const canMove = inBase && isMyTurn && player?.id === myPlayerId && movablePawns.includes(pawnIdx) && !room.animatingMove;

              return (
                <div key={pawnIdx} className={`yard-slot yard-slot-${color}`}>
                  {/* Warna tanpa pemain/bot: markas tetap ada tapi tanpa bidak */}
                  {inBase && player && (
                    <button
                      type="button"
                      className={`pawn-token pawn-${color} ${canMove ? 'pawn-can-move pulse-anim' : ''}`}
                      onClick={() => handlePawnClick(pawnIdx, canMove)}
                      disabled={!canMove}
                      aria-label={canMove ? `Jalankan bidak ${pawnIdx + 1} keluar markas` : `Bidak ${pawnIdx + 1} ${player?.name || ''} di markas`}
                    >
                      {/* base-yard sudah diputar balik; jangan putar lagi agar angka tidak miring */}
                      <span className="pawn-inner">
                        {pawnIdx + 1}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // Render petak lintasan 11x11
  const renderCell = (r, c) => {
    const isBaseTL = r < 4 && c < 4;
    const isBaseTR = r < 4 && c >= 7;
    const isBaseBL = r >= 7 && c < 4;
    const isBaseBR = r >= 7 && c >= 7;
    const isCenter = r === 5 && c === 5;

    if (isBaseTL || isBaseTR || isBaseBR || isBaseBL || isCenter) {
      return null;
    }

    // Kotak Start masing-masing warna
    let startColor = null;
    if (r === START_TILES.red[0] && c === START_TILES.red[1]) startColor = 'red';
    else if (r === START_TILES.green[0] && c === START_TILES.green[1]) startColor = 'green';
    else if (r === START_TILES.yellow[0] && c === START_TILES.yellow[1]) startColor = 'yellow';
    else if (r === START_TILES.blue[0] && c === START_TILES.blue[1]) startColor = 'blue';

    // Jalur Runway menuju Goal (Home Path)
    let homeColor = null;
    if (c === 5 && r >= 6 && r <= 9) homeColor = 'red';
    else if (r === 5 && c >= 1 && c <= 4) homeColor = 'green';
    else if (c === 5 && r >= 1 && r <= 4) homeColor = 'yellow';
    else if (r === 5 && c >= 6 && c <= 9) homeColor = 'blue';

    const trackIdx = TRACK_INDEX_BY_CELL.get(`${r},${c}`) ?? -1;
    const isBlackHole = blackHoleActive && trackIdx !== -1 && blackHoles.includes(trackIdx);
    // Petak start tidak diberi bintang: hanya aman bagi pemilik warnanya, bukan zona aman bersama
    const isStar = trackIdx !== -1 && !startColor && SAFE_TRACK_INDICES.includes(trackIdx);

    const cellPawns = pawnsByCoord[`${r},${c}`] || [];

    // Cek apakah petak ini adalah petak tujuan (target hint highlight)
    const targetInfo = validTargets[`${r},${c}`];
    const isValidTarget = !!targetInfo;

    let cellClass = 'board-cell';
    if (homeColor) cellClass += ` cell-home-${homeColor}`;
    if (startColor) cellClass += ` cell-start cell-start-${startColor}`;
    if (isStar && safeZonesActive) cellClass += ' cell-safe-star';
    if (isBlackHole) cellClass += ' cell-black-hole';
    if (isValidTarget) cellClass += ' cell-valid-target';

    return (
      <div
        key={`cell-${r}-${c}`}
        className={cellClass}
        style={{ gridRow: r + 1, gridColumn: c + 1 }}
      >
        {/* Petak tujuan hanya penanda, bukan tombol: bidak dipilih dengan mengetuk bidaknya */}
        {isValidTarget && (
          <span className="target-tile" aria-hidden="true">
            <span className="target-dot" />
          </span>
        )}

        {isStar && safeZonesActive && (
          <span className="cell-icon star-icon" style={counterStyle} aria-hidden="true">★</span>
        )}
        {isBlackHole && !cellPawns.length && (
          <span className="cell-icon blackhole-icon" style={counterStyle} role="img" aria-label="Black Hole">
            🕳️
          </span>
        )}

        {cellPawns.length > 0 && (
          <div className={`pawn-cluster cluster-size-${Math.min(cellPawns.length, 4)}`}>
            {cellPawns.map(({ player, pawnIdx, val, isHopping, canMove }, idx) => {
              const isTarget = targeting && player.id !== myPlayerId && val >= 1 && val <= 39;
              const isInteractive = canMove || isTarget;

              let btnClass = `pawn-token pawn-${player.color}`;
              if (canMove) btnClass += ' pawn-can-move pulse-anim';
              if (isHopping) btnClass += ' pawn-stepping';
              if (isTarget) btnClass += ' pawn-target pulse-target';

              return (
                <button
                  key={`${player.id}-${pawnIdx}`}
                  type="button"
                  className={btnClass}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (isTarget) {
                      sound.playClick();
                      onSelectTarget && onSelectTarget(player.id, pawnIdx);
                      return;
                    }
                    handlePawnClick(pawnIdx, canMove);
                  }}
                  disabled={!isInteractive}
                  aria-label={
                    isTarget
                      ? `Pilih bidak ${pawnIdx + 1} milik ${player.name} sebagai target`
                      : canMove
                      ? `Jalankan bidak ${pawnIdx + 1}`
                      : `Bidak ${pawnIdx + 1} milik ${player.name}`
                  }
                  style={{ zIndex: isHopping ? 100 : (isTarget ? 90 : 10 + idx) }}
                >
                  <span className="pawn-inner" style={counterStyle}>{pawnIdx + 1}</span>
                  {isTarget && <span className="pawn-target-crosshair" aria-hidden="true">🎯</span>}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // Render Kotak Tengah (Finish Goal 1x1 pada r=5, c=5)
  const isGoalTarget = !!validTargets['5,5'];
  const renderCenterGoal = () => {
    return (
      <div
        className={`board-center-goal ${isGoalTarget ? 'cell-valid-target' : ''}`}
        style={{
          gridRow: '6 / span 1',
          gridColumn: '6 / span 1'
        }}
      >
        <div className="goal-triangle goal-green">
          <span className="goal-counter" style={counterStyle}>{finishedCounts.green > 0 ? finishedCounts.green : ''}</span>
        </div>
        <div className="goal-triangle goal-yellow">
          <span className="goal-counter" style={counterStyle}>{finishedCounts.yellow > 0 ? finishedCounts.yellow : ''}</span>
        </div>
        <div className="goal-triangle goal-blue">
          <span className="goal-counter" style={counterStyle}>{finishedCounts.blue > 0 ? finishedCounts.blue : ''}</span>
        </div>
        <div className="goal-triangle goal-red">
          <span className="goal-counter" style={counterStyle}>{finishedCounts.red > 0 ? finishedCounts.red : ''}</span>
        </div>
        <div className="goal-center-point" />

        {isGoalTarget && (
          <span className="target-tile" aria-hidden="true">
            <span className="target-dot" />
          </span>
        )}
      </div>
    );
  };

  // Render Card/Badge Profil Pemain di 4 sudut luar papan (HUD)
  // Teks selalu horizontal, tajam, rapi, dan tidak miring karena tidak diputar oleh rotasi board
  const renderPlayerHudCard = (color) => {
    const player = room.players.find(p => p.color === color);
    const isThisPlayerTurn = currentTurnPlayer?.color === color;
    const isMe = player?.id === myPlayerId;
    const pawns = player ? room.pawns[player.id] || [0, 0, 0, 0] : [0, 0, 0, 0];
    const finishedCount = pawns.filter(v => v === 44).length;
    const homeCount = pawns.filter(v => v === 0).length;

    return (
      <div
        key={`hud-${color}`}
        className={`player-hud-card hud-${color} ${isThisPlayerTurn ? 'hud-active-turn' : ''} ${player?.isOut ? 'hud-player-out' : ''}`}
      >
        {player && room.turnClock?.playerId === player.id && <HudTimer key={room.turnClock.id} clock={room.turnClock} />}
        <div className={`hud-avatar color-${color}`} aria-hidden="true">
          {player ? player.name.charAt(0).toUpperCase() : '?'}
          {isThisPlayerTurn && <span className="hud-turn-pulse" />}
        </div>
        <div className="hud-info">
          <div className="hud-name-row">
            <strong className="hud-player-name">{player ? player.name : 'Kursi kosong'}</strong>
            {isMe && <span className="hud-tag you-tag">KAMU</span>}
            {player?.isBot && <span className="hud-tag bot-tag">BOT</span>}
            {player?.isLudoKing && <span className="hud-tag king-tag">👑</span>}
          </div>
          <div className="hud-sub-row">
            {!player ? (
              <span className="hud-stats-text">Tidak ada pemain</span>
            ) : player.isOut ? (
              <span className="hud-out-tag">❌ OUT</span>
            ) : player && !player.connected && !player.isBot ? (
              <span className="hud-offline-tag">📶 Terputus</span>
            ) : player?.autoPlayCount > 0 ? (
              <span className="hud-auto-tag">Auto {player.autoPlayCount}/3</span>
            ) : isThisPlayerTurn ? (
              <span className="hud-active-text">Giliran jalan...</span>
            ) : (
              <span className="hud-stats-text">
                {finishedCount > 0 ? `★ ${finishedCount} finish` : `${homeCount} di markas`}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  const corners = getCornerColors(boardRotation);

  return (
    <div className="ludo-arena-frame">
      {/* HUD Bar Atas: Sudut Kiri Atas (TL) & Kanan Atas (TR) */}
      <div className="board-hud-row board-hud-top">
        {renderPlayerHudCard(corners.tl)}
        {renderPlayerHudCard(corners.tr)}
      </div>

      {/* Papan Ludo 11x11 */}
      <div className="ludo-board-container">
        <div
          className="ludo-board"
          style={{
            transform: `rotate(${boardRotation}deg)`,
            transition: 'transform 0.45s cubic-bezier(0.16, 1, 0.3, 1)'
          }}
        >
          {/* 4 Markas Pojok (4x4) */}
          {renderBase('green', 0, 0)}
          {renderBase('yellow', 0, 7)}
          {renderBase('red', 7, 0)}
          {renderBase('blue', 7, 7)}

          {/* 11x11 Petak Lintasan */}
          {Array.from({ length: 11 }, (_, r) =>
            Array.from({ length: 11 }, (_, c) => renderCell(r, c))
          )}

          {/* Finish Goal Tengah (1x1) */}
          {renderCenterGoal()}
        </div>
      </div>

      {/* HUD Bar Bawah: Sudut Kiri Bawah (BL) & Kanan Bawah (BR, selalu KAMU) */}
      <div className="board-hud-row board-hud-bottom">
        {renderPlayerHudCard(corners.bl)}
        {renderPlayerHudCard(corners.br)}
      </div>
    </div>
  );
}

import React, { useEffect, useMemo, useState } from 'react';
import { Chess } from 'chess.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

const PROMOTION_PIECES = [
  { code: 'q', label: 'Menteri (Q)' },
  { code: 'r', label: 'Benteng (R)' },
  { code: 'b', label: 'Gajah (B)' },
  { code: 'n', label: 'Kuda (N)' }
];

// Set SVG Bidak Catur Staunton Klasik dengan kontras tinggi (Putih Gading vs Hitam Obsidian)
export function ChessPieceSvg({ color, type, className = '' }) {
  const isWhite = color === 'w';
  const fill = isWhite ? '#FFFDF7' : '#1E2430';
  const stroke = isWhite ? '#1E2430' : '#0F131A';
  const innerStroke = isWhite ? '#334155' : '#94A3B8';
  const accentFill = isWhite ? '#F1ECE1' : '#334155';

  switch (type) {
    case 'p':
      return (
        <svg viewBox="0 0 45 45" className={`cm-piece-svg ${className}`.trim()} aria-hidden="true">
          <path
            d="M 22.5,9 C 19.5,9 17,11.5 17,14.5 C 17,16.8 18.4,18.7 20.4,19.5 C 17.5,21.2 15.5,24.5 15.5,29 L 29.5,29 C 29.5,24.5 27.5,21.2 24.6,19.5 C 26.6,18.7 28,16.8 28,14.5 C 28,11.5 25.5,9 22.5,9 z"
            fill={fill}
            stroke={stroke}
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          <path
            d="M 12.5,33 L 32.5,33 C 33.5,33 34,34.5 34,36.5 L 11,36.5 C 11,34.5 11.5,33 12.5,33 z"
            fill={fill}
            stroke={stroke}
            strokeWidth="2.2"
            strokeLinejoin="round"
          />
          <line x1="15.5" y1="29" x2="29.5" y2="29" stroke={innerStroke} strokeWidth="1.6" />
        </svg>
      );

    case 'r':
      return (
        <svg viewBox="0 0 45 45" className={`cm-piece-svg ${className}`.trim()} aria-hidden="true">
          <g fill={fill} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 9,39 L 36,39 L 36,36 L 9,36 L 9,39 z" />
            <path d="M 12,36 L 12,32 L 33,32 L 33,36 L 12,36 z" />
            <path d="M 14,29.5 L 14,16.5 L 31,16.5 L 31,29.5 L 14,29.5 z" />
            <path d="M 14,16.5 L 11,14 L 34,14 L 31,16.5 L 14,16.5 z" />
            <path d="M 11,14 L 11,9 L 15,9 L 15,11 L 20,11 L 20,9 L 25,9 L 25,11 L 30,11 L 30,9 L 34,9 L 34,14" />
            <path d="M 12,32 L 14,29.5 L 31,29.5 L 33,32 L 12,32 z" />
          </g>
          <line x1="15" y1="19.5" x2="30" y2="19.5" stroke={innerStroke} strokeWidth="1.5" strokeLinecap="round" />
          <line x1="15" y1="27" x2="30" y2="27" stroke={innerStroke} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case 'n':
      return (
        <svg viewBox="0 0 45 45" className={`cm-piece-svg ${className}`.trim()} aria-hidden="true">
          <g fill={fill} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 22,10 C 32.5,11 38.5,18 38,39 L 15,39 C 15,30 25,32.5 23,18" />
            <path d="M 24,18 C 24.38,20.91 18.45,25.37 16,27 C 13,29 13.18,31.34 11,31 C 9.958,30.06 12.41,27.96 11,28 C 10,28 11.19,29.23 10,30 C 9,30 5.997,31 6,26 C 6,24 12,14 12,14 C 12,14 13.89,12.1 14,10.5 C 13.27,9.506 13.5,8.5 13.5,7.5 C 14.5,6.5 16.5,10 16.5,10 L 18.5,10 C 18.5,10 19.28,8.008 21,7 C 22,7 22,10 22,10" />
            <path d="M 9.5,39 L 35.5,39 L 35.5,36 L 9.5,36 L 9.5,39 z" />
          </g>
          <circle cx="15.5" cy="14.5" r="1.4" fill={innerStroke} />
          <path d="M 29,16 C 32,20 33,27 33,34" fill="none" stroke={innerStroke} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case 'b':
      return (
        <svg viewBox="0 0 45 45" className={`cm-piece-svg ${className}`.trim()} aria-hidden="true">
          <g fill={fill} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 9,36 C 12.39,35.03 19.11,36.43 22.5,34 C 25.89,36.43 32.61,35.03 36,36 C 36,36 37.65,36.54 39,38 C 38.32,38.97 37.35,38.99 36,38.5 C 32.61,37.53 25.89,38.96 22.5,37.5 C 19.11,38.96 12.39,37.53 9,38.5 C 7.646,38.99 6.677,38.97 6,38 C 7.354,36.06 9,36 9,36 z" />
            <path d="M 15,32 C 17.5,34.5 27.5,34.5 30,32 C 30.5,30.5 30,30 30,30 C 30,27.5 27.5,26 27.5,26 C 33,24.5 33.5,14.5 22.5,10.5 C 11.5,14.5 12,24.5 17.5,26 C 17.5,26 15,27.5 15,30 C 15,30 14.5,30.5 15,32 z" />
            <circle cx="22.5" cy="8" r="2.3" />
          </g>
          <path d="M 17.5,26 L 27.5,26 M 15,30 L 30,30 M 22.5,15.5 L 22.5,20.5 M 20,18 L 25,18" stroke={innerStroke} strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      );

    case 'q':
      return (
        <svg viewBox="0 0 45 45" className={`cm-piece-svg ${className}`.trim()} aria-hidden="true">
          <g fill={fill} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 9,26 C 17.5,24.5 30,24.5 36,26 L 38.5,13.5 L 31,25 L 30.7,10.9 L 25.5,24.5 L 22.5,10 L 19.5,24.5 L 14.3,10.9 L 14,25 L 6.5,13.5 L 9,26 z" />
            <path d="M 9,26 C 9,28 10.5,28 11.5,30 C 12.5,31.5 12.5,31 12,33.5 C 10.5,34.5 11,36 11,36 C 9.5,37.5 11,38.5 11,38.5 C 17.5,39.5 27.5,39.5 34,38.5 C 34,38.5 35.5,37.5 34,36 C 34,36 34.5,34.5 33,33.5 C 32.5,31 32.5,31.5 33.5,30 C 34.5,28 36,28 36,26 C 27.5,24.5 17.5,24.5 9,26 z" />
            <circle cx="6" cy="12" r="1.8" />
            <circle cx="14" cy="9" r="1.8" />
            <circle cx="22.5" cy="8" r="1.8" />
            <circle cx="31" cy="9" r="1.8" />
            <circle cx="39" cy="12" r="1.8" />
          </g>
          <path d="M 11.5,30 C 15,29 30,29 33.5,30 M 12,33.5 C 18,32.5 27,32.5 33,33.5" fill="none" stroke={innerStroke} strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      );

    case 'k':
      return (
        <svg viewBox="0 0 45 45" className={`cm-piece-svg ${className}`.trim()} aria-hidden="true">
          <g fill={fill} stroke={stroke} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M 22.5,11.63 L 22.5,6" />
            <path d="M 20,8 L 25,8" />
            <path
              d="M 22.5,25 C 22.5,25 27,17.5 25.5,14.5 C 25.5,14.5 24.5,12 22.5,12 C 20.5,12 19.5,14.5 19.5,14.5 C 18,17.5 22.5,25 22.5,25"
              fill={accentFill}
            />
            <path d="M 11.5,37 C 17,40.5 27,40.5 32.5,37 L 32.5,30 C 32.5,30 41.5,25.5 38.5,19.5 C 34.5,13 25,16 22.5,23.5 L 22.5,27 L 22.5,23.5 C 19,16 9.5,13 6.5,19.5 C 3.5,25.5 11.5,29.5 11.5,29.5 L 11.5,37 z" />
          </g>
          <path
            d="M 11.5,30 C 17,27 27,27 32.5,30 M 11.5,33.5 C 17,30.5 27,30.5 32.5,33.5"
            fill="none"
            stroke={innerStroke}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      );

    default:
      return null;
  }
}

export default function ChessBoard({
  fen,
  orientation = 'w',
  myColor = null,
  interactive = false,
  lastMove = null,
  onMove
}) {
  const [selectedSquare, setSelectedSquare] = useState(null);
  const [dragFromSquare, setDragFromSquare] = useState(null);
  const [dragOverSquare, setDragOverSquare] = useState(null);
  const [pendingPromotion, setPendingPromotion] = useState(null); // { from, to, color }

  // Parse posisi FEN menggunakan chess.js untuk mencari langkah legal dan status skak
  const boardAnalysis = useMemo(() => {
    const chess = new Chess();
    try {
      if (fen && fen !== 'start') {
        chess.load(fen);
      }
    } catch (_) {
      // Fallback ke posisi awal jika FEN tidak valid
    }

    const turn = chess.turn();
    const inCheck = chess.inCheck();
    const isCheckmate = chess.isCheckmate();
    const board2D = chess.board();
    const squaresMap = {};
    let kingInCheckSquare = null;

    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const sq = `${FILES[f]}${RANKS[r]}`;
        const piece = board2D[r][f];
        squaresMap[sq] = piece;
        if (piece && piece.type === 'k' && piece.color === turn && inCheck) {
          kingInCheckSquare = sq;
        }
      }
    }

    return {
      chess,
      turn,
      inCheck,
      isCheckmate,
      squaresMap,
      kingInCheckSquare
    };
  }, [fen]);

  // Reset seleksi saat posisi papan berubah
  useEffect(() => {
    setSelectedSquare(null);
    setDragFromSquare(null);
    setDragOverSquare(null);
    setPendingPromotion(null);
  }, [fen]);

  const canInteractWithTurn = useMemo(() => {
    if (!interactive) return false;
    if (!myColor) return false;
    return boardAnalysis.turn === myColor;
  }, [interactive, myColor, boardAnalysis.turn]);

  // Daftar langkah legal untuk kotak yang sedang dipilih
  const legalMovesForSelected = useMemo(() => {
    const activeSq = selectedSquare || dragFromSquare;
    if (!activeSq || !canInteractWithTurn) return [];
    try {
      return boardAnalysis.chess.moves({ square: activeSq, verbose: true }) || [];
    } catch (_) {
      return [];
    }
  }, [selectedSquare, dragFromSquare, canInteractWithTurn, boardAnalysis]);

  const legalTargetsMap = useMemo(() => {
    const map = {};
    for (const m of legalMovesForSelected) {
      if (!map[m.to]) {
        map[m.to] = {
          to: m.to,
          isCapture: Boolean(m.captured) || m.flags?.includes('e'),
          isPromotion: Boolean(m.promotion) || m.flags?.includes('p')
        };
      }
    }
    return map;
  }, [legalMovesForSelected]);

  const attemptMove = (fromSq, toSq) => {
    if (!canInteractWithTurn || !fromSq || !toSq || fromSq === toSq) return false;
    const moves = boardAnalysis.chess.moves({ square: fromSq, verbose: true }) || [];
    const matching = moves.filter(m => m.to === toSq);
    if (matching.length === 0) return false;

    const isPromo = matching.some(m => Boolean(m.promotion) || m.flags?.includes('p'));
    if (isPromo) {
      setPendingPromotion({ from: fromSq, to: toSq, color: boardAnalysis.turn });
      setSelectedSquare(null);
      return true;
    }

    setSelectedSquare(null);
    onMove?.({ from: fromSq, to: toSq, promotion: 'q' });
    return true;
  };

  const handleSquareClick = sq => {
    if (!canInteractWithTurn) return;
    if (pendingPromotion) {
      setPendingPromotion(null);
      return;
    }

    const pieceOnSq = boardAnalysis.squaresMap[sq];

    // Jika sudah ada bidak yang dipilih dan klik mengarah ke kotak langkah legal
    if (selectedSquare && legalTargetsMap[sq]) {
      attemptMove(selectedSquare, sq);
      return;
    }

    // Jika klik bidak milik sendiri -> pilih / batalkan pilih
    if (pieceOnSq && pieceOnSq.color === myColor) {
      setSelectedSquare(prev => (prev === sq ? null : sq));
      return;
    }

    setSelectedSquare(null);
  };

  const handleDragStart = (e, sq) => {
    if (!canInteractWithTurn) {
      e.preventDefault();
      return;
    }
    const piece = boardAnalysis.squaresMap[sq];
    if (!piece || piece.color !== myColor) {
      e.preventDefault();
      return;
    }
    setDragFromSquare(sq);
    setSelectedSquare(sq);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', sq);
      } catch (_) {}
    }
  };

  const handleDragOver = (e, sq) => {
    if (!dragFromSquare) return;
    e.preventDefault();
    if (dragOverSquare !== sq) {
      setDragOverSquare(sq);
    }
  };

  const handleDrop = (e, sq) => {
    e.preventDefault();
    const fromSq = dragFromSquare || (e.dataTransfer ? e.dataTransfer.getData('text/plain') : null);
    setDragFromSquare(null);
    setDragOverSquare(null);
    if (fromSq && sq && fromSq !== sq) {
      attemptMove(fromSq, sq);
    }
  };

  const handleDragEnd = () => {
    setDragFromSquare(null);
    setDragOverSquare(null);
  };

  const confirmPromotion = pieceCode => {
    if (!pendingPromotion) return;
    const { from, to } = pendingPromotion;
    setPendingPromotion(null);
    onMove?.({ from, to, promotion: pieceCode });
  };

  const orderedRanks = orientation === 'b' ? [...RANKS].reverse() : RANKS;
  const orderedFiles = orientation === 'b' ? [...FILES].reverse() : FILES;

  return (
    <div className="cm-board-frame">
      <div
        className={`cm-board-grid ${canInteractWithTurn ? 'is-my-turn' : ''}`}
        role="grid"
        aria-label="Papan Catur 8x8"
      >
        {orderedRanks.map((rank, rIdx) =>
          orderedFiles.map((file, fIdx) => {
            const sq = `${file}${rank}`;
            const fileIndex = FILES.indexOf(file);
            const rankIndex = RANKS.indexOf(rank);
            const isLight = (fileIndex + rankIndex) % 2 === 0;
            const piece = boardAnalysis.squaresMap[sq];
            const isSelected = selectedSquare === sq || dragFromSquare === sq;
            const isLastMove = lastMove && (lastMove.from === sq || lastMove.to === sq);
            const isKingInCheck = boardAnalysis.kingInCheckSquare === sq;
            const isKingCheckmated = isKingInCheck && boardAnalysis.isCheckmate;
            const legalTarget = legalTargetsMap[sq];
            const isDragHover = dragOverSquare === sq && Boolean(legalTarget);

            const showRankLabel = fIdx === 0;
            const showFileLabel = rIdx === 7;

            const canDragPiece = canInteractWithTurn && piece && piece.color === myColor;

            return (
              <div
                key={sq}
                role="gridcell"
                aria-label={`Petak ${sq}${piece ? ` ${piece.color === 'w' ? 'Putih' : 'Hitam'} ${piece.type.toUpperCase()}` : ''}`}
                data-square={sq}
                className={[
                  'cm-square',
                  isLight ? 'cm-square--light' : 'cm-square--dark',
                  isSelected ? 'cm-square--selected' : '',
                  isLastMove ? 'cm-square--last-move' : '',
                  isKingInCheck ? 'cm-square--in-check' : '',
                  isKingCheckmated ? 'cm-square--checkmated' : '',
                  legalTarget ? 'cm-square--legal' : '',
                  isDragHover ? 'cm-square--drag-over' : '',
                  canDragPiece ? 'cm-square--playable' : ''
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => handleSquareClick(sq)}
                onDragOver={e => handleDragOver(e, sq)}
                onDrop={e => handleDrop(e, sq)}
              >
                {showRankLabel && <span className="cm-coord cm-coord--rank">{rank}</span>}
                {showFileLabel && <span className="cm-coord cm-coord--file">{file}</span>}

                {legalTarget && !legalTarget.isCapture && <span className="cm-legal-dot" />}
                {legalTarget && legalTarget.isCapture && <span className="cm-legal-ring" />}

                {piece && (
                  <div
                    className={`cm-piece-wrap ${canDragPiece ? 'is-draggable' : ''}`}
                    draggable={Boolean(canDragPiece)}
                    onDragStart={e => handleDragStart(e, sq)}
                    onDragEnd={handleDragEnd}
                  >
                    <ChessPieceSvg color={piece.color} type={piece.type} />
                  </div>
                )}

                {isKingCheckmated && (
                  <span className="cm-checkmate-badge" title="Checkmate">
                    ✕
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* Dialog Promosi Pion */}
      {pendingPromotion && (
        <div className="cm-promo-backdrop" onClick={() => setPendingPromotion(null)}>
          <div className="cm-promo-dialog" onClick={e => e.stopPropagation()}>
            <div className="cm-promo-title">Pilih Bidak Promosi</div>
            <div className="cm-promo-grid">
              {PROMOTION_PIECES.map(item => (
                <button
                  key={item.code}
                  type="button"
                  className="cm-promo-btn"
                  onClick={() => confirmPromotion(item.code)}
                >
                  <ChessPieceSvg color={pendingPromotion.color} type={item.code} />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


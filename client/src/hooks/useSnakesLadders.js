import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from '../storage';
import { sound } from '../sound';
import { triggerConfetti } from '../confetti';

const SNAKES_ROOM_KEY = 'active_snakes_room';

export const DEFAULT_LADDERS = Object.freeze({
  4: 14,
  9: 31,
  20: 38,
  28: 84,
  40: 59,
  51: 67,
  63: 81,
  71: 91
});

export const DEFAULT_SNAKES = Object.freeze({
  17: 7,
  54: 34,
  62: 19,
  64: 60,
  87: 24,
  93: 73,
  95: 75,
  99: 78
});

export function useSnakesLadders({ socket, authToken, currentUser, onUpdateUser, onNeedLogin, active }) {
  const [room, setRoom] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchStartedAt, setSearchStartedAt] = useState(null);
  const [searchElapsedSec, setSearchElapsedSec] = useState(0);
  const [searchTimeoutSec, setSearchTimeoutSec] = useState(15);
  const [matchAnnouncement, setMatchAnnouncement] = useState(null); // { type: 'human' | 'bot', message, opponent }

  const [rolling, setRolling] = useState(false);
  const [diceValue, setDiceValue] = useState(null);
  const [animatingMove, setAnimatingMove] = useState(false);
  const [animatedPositions, setAnimatedPositions] = useState({});
  const [boardEffect, setBoardEffect] = useState(null); // { type: 'ladder' | 'snake' | 'overshoot', from, to, playerName }

  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [matchResult, setMatchResult] = useState(null);

  // Statistik pemain, riwayat pertandingan, & leaderboard
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [leaderboardMeta, setLeaderboardMeta] = useState({ total: 0, page: 1, limit: 20, totalPages: 1, myEntry: null });
  const [loadingMeta, setLoadingMeta] = useState(false);

  // Obrolan room & notifikasi chat (gaya JakLudo)
  const [chats, setChats] = useState([]);
  const [unreadChats, setUnreadChats] = useState(0);
  const [chatToast, setChatToast] = useState(null);
  const [chatOpen, setChatOpenState] = useState(false);

  const chatOpenRef = useRef(false);
  const chatToastTimerRef = useRef(null);
  const errorTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const effectTimerRef = useRef(null);
  const announcementTimerRef = useRef(null);
  const animTimersRef = useRef([]);
  const animatingRef = useRef(false);
  const lastFinishedRoomRef = useRef('');
  const roomCodeRef = useRef('');
  roomCodeRef.current = room?.code || '';

  const clearAnimTimers = useCallback(() => {
    for (const t of animTimersRef.current) {
      clearTimeout(t);
    }
    animTimersRef.current = [];
    animatingRef.current = false;
    setAnimatingMove(false);
  }, []);

  const showError = useCallback(msg => {
    if (!msg) return;
    setError(String(msg));
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(''), 5000);
  }, []);

  const showNotice = useCallback((msg, duration = 4000) => {
    if (!msg) {
      setNotice('');
      return;
    }
    setNotice(String(msg));
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current);
    if (duration > 0) {
      noticeTimerRef.current = setTimeout(() => setNotice(''), duration);
    }
  }, []);

  const showBoardEffect = useCallback((effect, duration = 2600) => {
    setBoardEffect(effect);
    if (effectTimerRef.current) clearTimeout(effectTimerRef.current);
    if (effect && duration > 0) {
      effectTimerRef.current = setTimeout(() => setBoardEffect(null), duration);
    }
  }, []);

  const dropStaleRoom = useCallback(
    reason => {
      clearAnimTimers();
      storage.remove(SNAKES_ROOM_KEY);
      setRoom(null);
      setSearching(false);
      setSearchStartedAt(null);
      setMatchResult(null);
      setRolling(false);
      setDiceValue(null);
      setAnimatedPositions({});
      setBoardEffect(null);
      setChats([]);
      setUnreadChats(0);
      setChatToast(null);
      setChatOpenState(false);
      chatOpenRef.current = false;
      if (reason) showError(reason);
    },
    [clearAnimTimers, showError]
  );

  const fetchSnakesMeta = useCallback(async (page = 1) => {
    const token = authToken || storage.get('token');
    setLoadingMeta(true);
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [lbRes, profRes] = await Promise.all([
        fetch(`/api/games/snakes-and-ladders/leaderboard?page=${page}&limit=20`, { headers })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null),
        token
          ? fetch('/api/games/snakes-and-ladders/history?limit=15', { headers })
              .then(r => (r.ok ? r.json() : null))
              .catch(() => null)
          : Promise.resolve(null)
      ]);
      if (lbRes?.success) {
        setLeaderboard(Array.isArray(lbRes.entries) ? lbRes.entries : []);
        setLeaderboardMeta({
          total: lbRes.total || 0,
          page: lbRes.page || 1,
          limit: lbRes.limit || 20,
          totalPages: lbRes.totalPages || 1,
          myEntry: lbRes.myEntry || null
        });
      }
      if (profRes?.success) {
        if (profRes.stats) setStats(profRes.stats);
        if (Array.isArray(profRes.history)) setHistory(profRes.history);
      }
    } finally {
      setLoadingMeta(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (active) {
      fetchSnakesMeta(1);
    }
  }, [active, currentUser?.id, fetchSnakesMeta]);

  // Timer pencarian lawan (detik berjalan selama searching)
  useEffect(() => {
    if (!searching || !searchStartedAt) {
      setSearchElapsedSec(0);
      return undefined;
    }
    const update = () => {
      setSearchElapsedSec(Math.max(0, Math.floor((Date.now() - searchStartedAt) / 1000)));
    };
    update();
    const id = setInterval(update, 250);
    return () => clearInterval(id);
  }, [searching, searchStartedAt]);

  // Aktifkan BGM saat berada di dalam room aktif
  useEffect(() => {
    if (!active) return undefined;
    sound.setInRoom(Boolean(room?.code));
    return () => {
      sound.setInRoom(false);
    };
  }, [active, room?.code]);

  // Reconnect otomatis ke room Ular Tangga aktif saat socket tersambung kembali
  useEffect(() => {
    if (!socket) return undefined;
    const tryRejoin = () => {
      const savedCode = storage.get(SNAKES_ROOM_KEY);
      const token = authToken || storage.get('token');
      if (!savedCode || !token) return;
      socket.emit('snakes:room:join', { code: savedCode, token }, res => {
        if (res?.ok) return;
        if (roomCodeRef.current === savedCode) {
          dropStaleRoom('Room Ular Tangga sudah tidak tersedia.');
        } else {
          storage.remove(SNAKES_ROOM_KEY);
        }
      });
    };
    socket.on('connect', tryRejoin);
    if (socket.connected) tryRejoin();
    return () => socket.off('connect', tryRejoin);
  }, [socket, authToken, dropStaleRoom]);

  // Listener Socket.IO untuk seluruh event Snakes and Ladders
  useEffect(() => {
    if (!socket) return undefined;

    const syncPositionsFromRoom = nextRoom => {
      if (!nextRoom?.players) return;
      if (animatingRef.current) return;
      const map = {};
      for (const p of nextRoom.players) {
        map[p.id] = Number(p.position) || 0;
      }
      setAnimatedPositions(map);
    };

    const onSearching = payload => {
      setSearching(true);
      setSearchStartedAt(payload?.queuedAt || Date.now());
      setSearchTimeoutSec(payload?.timeoutSeconds || 15);
      setMatchAnnouncement(null);
    };

    const onHumanFound = payload => {
      setSearching(false);
      setSearchStartedAt(null);
      sound.playJoinNotification?.();
      setMatchAnnouncement({
        type: 'human',
        message: payload?.message || 'Lawan ditemukan!',
        opponent: payload?.opponent || null
      });
      if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
      announcementTimerRef.current = setTimeout(() => setMatchAnnouncement(null), 4000);
    };

    const onBotFallback = payload => {
      setSearching(false);
      setSearchStartedAt(null);
      sound.playClick?.();
      setMatchAnnouncement({
        type: 'bot',
        message: payload?.message || 'Memulai pertandingan dengan pemain komputer',
        opponent: payload?.opponent || {
          player_type: 'bot',
          display_name: 'Pemain Komputer',
          avatar: null
        }
      });
      if (announcementTimerRef.current) clearTimeout(announcementTimerRef.current);
      announcementTimerRef.current = setTimeout(() => setMatchAnnouncement(null), 4500);
    };

    const onCancelled = payload => {
      setSearching(false);
      setSearchStartedAt(null);
      if (payload?.reason === 'expired') {
        showNotice(payload?.message || 'Waktu pencarian lawan habis.');
      }
    };

    const onRoomCreated = payload => {
      if (payload?.roomCode) {
        storage.set(SNAKES_ROOM_KEY, payload.roomCode);
      }
    };

    const onGameStarted = payload => {
      clearAnimTimers();
      setSearching(false);
      setSearchStartedAt(null);
      setMatchResult(null);
      setRolling(false);
      setDiceValue(null);
      setBoardEffect(null);
      if (payload?.players) {
        const initMap = {};
        for (const p of payload.players) {
          initMap[p.id] = 0;
        }
        setAnimatedPositions(initMap);
      }
      sound.playClick?.();
    };

    const onTurnChanged = () => {
      // Giliran berpindah
    };

    const onDiceRolled = payload => {
      if (!payload) return;
      setRolling(true);
      setDiceValue(payload.dice);
      const t = setTimeout(() => {
        setRolling(false);
      }, 580);
      animTimersRef.current.push(t);
    };

    const onPlayerMoved = payload => {
      if (!payload) return;
      const { playerId, displayName, from, stepTo, to, moved, overshoot, stepPath, ladder, snake } = payload;

      // Jalankan animasi langkah demi langkah setelah dadu mendarat (~580ms)
      clearAnimTimers();
      animatingRef.current = true;
      setAnimatingMove(true);

      const diceLandDelay = 580;

      if (overshoot || !moved) {
        const t = setTimeout(() => {
          showBoardEffect({
            type: 'overshoot',
            from,
            to: from,
            playerName: displayName
          }, 2200);
          animatingRef.current = false;
          setAnimatingMove(false);
        }, diceLandDelay);
        animTimersRef.current.push(t);
        return;
      }

      const steps = Array.isArray(stepPath) && stepPath.length > 0 ? stepPath : [stepTo];
      const stepInterval = 145;

      steps.forEach((sq, idx) => {
        const t = setTimeout(() => {
          sound.playStep?.() || sound.playClick?.();
          setAnimatedPositions(prev => ({ ...prev, [playerId]: sq }));
        }, diceLandDelay + idx * stepInterval);
        animTimersRef.current.push(t);
      });

      const afterStepsDelay = diceLandDelay + steps.length * stepInterval + 160;

      if (ladder) {
        const tLadder = setTimeout(() => {
          sound.playCheer?.() || sound.playWin?.();
          setAnimatedPositions(prev => ({ ...prev, [playerId]: ladder.to }));
          showBoardEffect({
            type: 'ladder',
            from: ladder.from,
            to: ladder.to,
            playerName: displayName
          }, 2600);
        }, afterStepsDelay);
        const tDone = setTimeout(() => {
          animatingRef.current = false;
          setAnimatingMove(false);
        }, afterStepsDelay + 450);
        animTimersRef.current.push(tLadder, tDone);
      } else if (snake) {
        const tSnake = setTimeout(() => {
          sound.playMonsterHurt?.() || sound.playClick?.();
          setAnimatedPositions(prev => ({ ...prev, [playerId]: snake.to }));
          showBoardEffect({
            type: 'snake',
            from: snake.from,
            to: snake.to,
            playerName: displayName
          }, 2600);
        }, afterStepsDelay);
        const tDone = setTimeout(() => {
          animatingRef.current = false;
          setAnimatingMove(false);
        }, afterStepsDelay + 450);
        animTimersRef.current.push(tSnake, tDone);
      } else {
        const tDone = setTimeout(() => {
          setAnimatedPositions(prev => ({ ...prev, [playerId]: to }));
          animatingRef.current = false;
          setAnimatingMove(false);
        }, afterStepsDelay);
        animTimersRef.current.push(tDone);
      }
    };

    const onPlayerWon = payload => {
      if (!payload) return;
      const winKey = `${payload.roomId}_${payload.finishedAt}`;
      if (lastFinishedRoomRef.current === winKey) return;
      lastFinishedRoomRef.current = winKey;

      const finishDelay = animatingRef.current ? 1200 : 300;
      const t = setTimeout(() => {
        setMatchResult(payload);
        if (currentUser?.id && payload.winnerUserId === currentUser.id) {
          sound.playWin?.();
          triggerConfetti();
          if (payload.rewardCoins > 0) {
            onUpdateUser?.(prev =>
              prev ? { ...prev, points: (prev.points || 0) + Number(payload.rewardCoins) } : prev
            );
          }
        } else {
          sound.playMonsterDefeat?.() || sound.playClick?.();
        }
        fetchSnakesMeta(1);
      }, finishDelay);
      animTimersRef.current.push(t);
    };

    const onGameFinished = payload => {
      if (payload && !matchResult) {
        onPlayerWon(payload);
      }
    };

    const onPlayerDisconnected = payload => {
      if (payload?.displayName) {
        showNotice(`${payload.displayName} terputus. Menunggu sambungan ulang...`, 5000);
      }
    };

    const onPlayerReconnected = payload => {
      if (payload?.displayName) {
        showNotice(`${payload.displayName} kembali terhubung!`, 3500);
      }
    };

    const onRoomState = nextRoom => {
      if (!nextRoom) return;
      setRoom(nextRoom);
      setSearching(false);
      setSearchStartedAt(null);
      if (nextRoom.code) {
        storage.set(SNAKES_ROOM_KEY, nextRoom.code);
      }
      if (Array.isArray(nextRoom.chats)) {
        setChats(nextRoom.chats);
      }
      if (nextRoom.lastRoll?.dice && !rolling) {
        setDiceValue(nextRoom.lastRoll.dice);
      }
      syncPositionsFromRoom(nextRoom);
      if (nextRoom.status === 'finished' && nextRoom.winner) {
        setMatchResult(prev => prev || {
          roomId: nextRoom.id,
          roomCode: nextRoom.code,
          winnerPlayerId: nextRoom.winnerPlayerId,
          winnerUserId: nextRoom.winnerUserId,
          winner: nextRoom.winner,
          opponentType: nextRoom.opponentType,
          durationSeconds: nextRoom.durationSeconds,
          totalTurns: nextRoom.turnNumber,
          rewardCoins: nextRoom.rewardCoins || 0,
          finishedAt: nextRoom.finishedAt
        });
      } else if (nextRoom.status !== 'finished') {
        setMatchResult(null);
      }
    };

    const onRoomClosed = payload => {
      if (payload?.roomCode && roomCodeRef.current && payload.roomCode !== roomCodeRef.current) return;
      dropStaleRoom(payload?.reason || 'Room Ular Tangga ditutup.');
    };

    const onChatMessage = msg => {
      if (!msg) return;
      setChats(prev => [...prev.slice(-49), msg]);
      const isFromMe = currentUser && String(msg.senderId) === String(currentUser.id);
      if (!isFromMe) {
        sound.playChatNotification?.();
      }
      if (!chatOpenRef.current && !isFromMe) {
        setUnreadChats(n => n + 1);
        setChatToast(msg);
        if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
        chatToastTimerRef.current = setTimeout(() => setChatToast(null), 4000);
      }
    };

    const onLeaderboardUpdate = data => {
      if (data && Array.isArray(data.entries)) {
        setLeaderboard(data.entries);
      }
    };

    socket.on('matchmaking.searching', onSearching);
    socket.on('matchmaking.human_found', onHumanFound);
    socket.on('matchmaking.bot_fallback', onBotFallback);
    socket.on('matchmaking.cancelled', onCancelled);
    socket.on('game.room_created', onRoomCreated);
    socket.on('game.started', onGameStarted);
    socket.on('game.turn_changed', onTurnChanged);
    socket.on('game.dice_rolled', onDiceRolled);
    socket.on('game.player_moved', onPlayerMoved);
    socket.on('game.player_won', onPlayerWon);
    socket.on('game.finished', onGameFinished);
    socket.on('game.player_disconnected', onPlayerDisconnected);
    socket.on('game.player_reconnected', onPlayerReconnected);
    socket.on('snakes:room:state', onRoomState);
    socket.on('snakes:room:closed', onRoomClosed);
    socket.on('snakes:chat_message', onChatMessage);
    socket.on('snakes:leaderboard:update', onLeaderboardUpdate);

    return () => {
      socket.off('matchmaking.searching', onSearching);
      socket.off('matchmaking.human_found', onHumanFound);
      socket.off('matchmaking.bot_fallback', onBotFallback);
      socket.off('matchmaking.cancelled', onCancelled);
      socket.off('game.room_created', onRoomCreated);
      socket.off('game.started', onGameStarted);
      socket.off('game.turn_changed', onTurnChanged);
      socket.off('game.dice_rolled', onDiceRolled);
      socket.off('game.player_moved', onPlayerMoved);
      socket.off('game.player_won', onPlayerWon);
      socket.off('game.finished', onGameFinished);
      socket.off('game.player_disconnected', onPlayerDisconnected);
      socket.off('game.player_reconnected', onPlayerReconnected);
      socket.off('snakes:room:state', onRoomState);
      socket.off('snakes:room:closed', onRoomClosed);
      socket.off('snakes:chat_message', onChatMessage);
      socket.off('snakes:leaderboard:update', onLeaderboardUpdate);
    };
  }, [socket, currentUser, rolling, matchResult, clearAnimTimers, dropStaleRoom, fetchSnakesMeta, onUpdateUser, showBoardEffect, showNotice]);

  // ==========================================
  // ACTIONS
  // ==========================================

  const requireAuthToken = useCallback(() => {
    const token = authToken || storage.get('token');
    if (!token || !currentUser) {
      onNeedLogin?.();
      return null;
    }
    return token;
  }, [authToken, currentUser, onNeedLogin]);

  const startQuickMatch = useCallback(() => {
    const token = requireAuthToken();
    if (!token || !socket) return;
    sound.playClick?.();
    setError('');
    setMatchResult(null);
    socket.emit('snakes:matchmaking:join', { token }, res => {
      if (!res?.ok) {
        if (res?.code === 'ALREADY_IN_GAME' && res?.room) {
          setRoom(res.room);
          if (res.room.code) storage.set(SNAKES_ROOM_KEY, res.room.code);
          return;
        }
        setSearching(false);
        showError(res?.error || 'Gagal memulai pencarian lawan.');
        return;
      }
      if (res.matched && res.room) {
        setSearching(false);
        setRoom(res.room);
        if (res.room.code) storage.set(SNAKES_ROOM_KEY, res.room.code);
      } else {
        setSearching(true);
        setSearchStartedAt(res.queuedAt || Date.now());
        setSearchTimeoutSec(res.timeoutSeconds || 15);
      }
    });
  }, [requireAuthToken, socket, showError]);

  const cancelMatchmaking = useCallback(() => {
    const token = authToken || storage.get('token');
    sound.playClick?.();
    setSearching(false);
    setSearchStartedAt(null);
    if (!socket || !token) return;
    socket.emit('snakes:matchmaking:cancel', { token });
  }, [authToken, socket]);

  const createPrivateRoom = useCallback(
    (options = {}) => {
      const token = requireAuthToken();
      if (!token || !socket) return Promise.resolve({ ok: false });
      sound.playClick?.();
      setError('');
      return new Promise(resolve => {
        socket.emit('snakes:room:create', { ...options, token }, res => {
          if (!res?.ok) {
            showError(res?.error || 'Gagal membuat Private Room.');
            resolve(res || { ok: false });
            return;
          }
          if (res.room) {
            setRoom(res.room);
            storage.set(SNAKES_ROOM_KEY, res.room.code);
          }
          resolve(res);
        });
      });
    },
    [requireAuthToken, socket, showError]
  );

  const joinRoomByCode = useCallback(
    customCode => {
      const token = requireAuthToken();
      if (!token || !socket) return;
      const targetCode = String(customCode || joinCode || '').trim().toUpperCase();
      if (!targetCode) {
        showError('Masukkan kode room 5 karakter.');
        return;
      }
      sound.playClick?.();
      setError('');
      socket.emit('snakes:room:join', { code: targetCode, token }, res => {
        if (!res?.ok) {
          showError(res?.error || 'Gagal bergabung ke room.');
          return;
        }
        if (res.room) {
          setRoom(res.room);
          storage.set(SNAKES_ROOM_KEY, res.room.code);
          setJoinCode('');
        }
      });
    },
    [requireAuthToken, socket, joinCode, showError]
  );

  const startPrivateRoom = useCallback(() => {
    const token = requireAuthToken();
    if (!token || !socket || !room?.code) return;
    sound.playClick?.();
    socket.emit('snakes:room:start', { code: room.code, token }, res => {
      if (!res?.ok) {
        showError(res?.error || 'Gagal memulai permainan.');
      }
    });
  }, [requireAuthToken, socket, room?.code, showError]);

  const rollDice = useCallback(() => {
    const token = requireAuthToken();
    if (!token || !socket || !room?.code) return;
    if (rolling || animatingMove || !room.isMyTurn || room.status !== 'playing') return;

    socket.emit('snakes:roll', { roomId: room.id, roomCode: room.code, token }, res => {
      if (!res?.ok) {
        showError(res?.error || 'Gagal melempar dadu.');
      }
    });
  }, [requireAuthToken, socket, room, rolling, animatingMove, showError]);

  const requestRematch = useCallback(() => {
    const token = requireAuthToken();
    if (!token || !socket || !room?.code) return;
    sound.playClick?.();
    socket.emit('snakes:rematch', { roomId: room.id, roomCode: room.code, token }, res => {
      if (!res?.ok) {
        showError(res?.error || 'Gagal meminta tanding ulang.');
      } else if (!res.restarted) {
        showNotice('Permintaan Main Lagi dikirim. Menunggu lawan...', 4000);
      }
    });
  }, [requireAuthToken, socket, room, showError, showNotice]);

  const leaveRoom = useCallback(() => {
    const token = authToken || storage.get('token');
    const code = room?.code || storage.get(SNAKES_ROOM_KEY);
    clearAnimTimers();
    storage.remove(SNAKES_ROOM_KEY);
    setRoom(null);
    setMatchResult(null);
    setRolling(false);
    setDiceValue(null);
    setAnimatedPositions({});
    setBoardEffect(null);
    setChats([]);
    setUnreadChats(0);
    setChatToast(null);
    setChatOpenState(false);
    chatOpenRef.current = false;
    if (socket && code) {
      socket.emit('snakes:room:leave', { code, token });
    }
    fetchSnakesMeta(1);
  }, [authToken, room?.code, socket, clearAnimTimers, fetchSnakesMeta]);

  const setChatOpen = useCallback(open => {
    const val = Boolean(open);
    chatOpenRef.current = val;
    setChatOpenState(val);
    if (val) {
      setUnreadChats(0);
      setChatToast(null);
    }
  }, []);

  const dismissChatToast = useCallback(() => {
    setChatToast(null);
  }, []);

  const sendChat = useCallback(
    (text, replyToId = null) => {
      const token = authToken || storage.get('token');
      if (!socket || !room?.code || !token) return;
      const clean = String(text || '').trim();
      if (!clean) return;
      socket.emit('snakes:chat', { code: room.code, text: clean, replyToId, token }, res => {
        if (res && !res.ok && res.error) showError(res.error);
      });
    },
    [authToken, socket, room?.code, showError]
  );

  const sendReaction = useCallback(
    emoji => {
      const token = authToken || storage.get('token');
      if (!socket || !room?.code || !token) return;
      sound.playClick?.();
      socket.emit('snakes:reaction', { code: room.code, emoji, token });
    },
    [authToken, socket, room?.code]
  );

  return {
    room,
    joinCode,
    searching,
    searchElapsedSec,
    searchTimeoutSec,
    matchAnnouncement,
    rolling,
    diceValue,
    animatingMove,
    animatedPositions,
    boardEffect,
    error,
    notice,
    matchResult,
    stats,
    history,
    leaderboard,
    leaderboardMeta,
    loadingMeta,
    chats,
    unreadChats,
    chatToast,
    chatOpen,
    actions: {
      setJoinCode,
      startQuickMatch,
      cancelMatchmaking,
      createPrivateRoom,
      joinRoomByCode,
      startPrivateRoom,
      rollDice,
      requestRematch,
      leaveRoom,
      fetchSnakesMeta,
      sendChat,
      sendReaction,
      setChatOpen,
      dismissChatToast
    }
  };
}


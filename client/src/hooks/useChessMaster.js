import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from '../storage';
import { sound } from '../sound';
import { triggerConfetti } from '../confetti';

const CHESS_ROOM_KEY = 'active_chess_room';

export const CHESS_TIME_CONTROLS = [
  { id: '5+0', label: '5+0', category: 'blitz', initialMs: 300000, incrementMs: 0, featured: true, desc: '5 Menit Blitz' },
  { id: '10+0', label: '10+0', category: 'rapid', initialMs: 600000, incrementMs: 0, featured: true, desc: '10 Menit Rapid' },
  { id: '1+0', label: '1+0', category: 'bullet', initialMs: 60000, incrementMs: 0, featured: false, desc: '1 Menit Bullet' },
  { id: '2+1', label: '2+1', category: 'bullet', initialMs: 120000, incrementMs: 1000, featured: false, desc: '2m + 1d Bullet' },
  { id: '3+0', label: '3+0', category: 'blitz', initialMs: 180000, incrementMs: 0, featured: false, desc: '3 Menit Blitz' },
  { id: '3+2', label: '3+2', category: 'blitz', initialMs: 180000, incrementMs: 2000, featured: false, desc: '3m + 2d Blitz' },
  { id: '10+5', label: '10+5', category: 'rapid', initialMs: 600000, incrementMs: 5000, featured: false, desc: '10m + 5d Rapid' }
];

export function useChessMaster({ socket, authToken, currentUser, onUpdateUser, onNeedLogin, active }) {
  const [room, setRoom] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [timeControl, setTimeControl] = useState('5+0');
  const [preferredSide, setPreferredSide] = useState('random');
  const [botDifficulty, setBotDifficulty] = useState('medium');
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [matchResult, setMatchResult] = useState(null);

  // Jam berjalan realtime yang disinkronkan dari timestamp server
  const [whiteTimeMs, setWhiteTimeMs] = useState(300000);
  const [blackTimeMs, setBlackTimeMs] = useState(300000);

  // Data profil catur, riwayat pertandingan, & leaderboard Elo
  const [profile, setProfile] = useState(null);
  const [recentMatches, setRecentMatches] = useState([]);
  const [ratingHistory, setRatingHistory] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [leaderboardMeta, setLeaderboardMeta] = useState({ total: 0, page: 1, limit: 20, totalPages: 1, myEntry: null });
  const [loadingMeta, setLoadingMeta] = useState(false);

  // Modal Replay & Analisis Pertandingan
  const [replayMatch, setReplayMatch] = useState(null);
  const [replayPly, setReplayPly] = useState(0);
  const [loadingReplay, setLoadingReplay] = useState(false);

  // Obrolan room & notifikasi chat
  const [chats, setChats] = useState([]);
  const [unreadChats, setUnreadChats] = useState(0);
  const [chatToast, setChatToast] = useState(null);
  const [chatOpen, setChatOpenState] = useState(false);

  const serverOffsetRef = useRef(0);
  const chatOpenRef = useRef(false);
  const chatToastTimerRef = useRef(null);
  const lastCompletedMatchRef = useRef('');
  const errorTimerRef = useRef(null);
  const noticeTimerRef = useRef(null);
  const roomCodeRef = useRef('');
  roomCodeRef.current = room?.code || '';

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

  const syncServerClock = useCallback(serverNow => {
    if (typeof serverNow === 'number' && Number.isFinite(serverNow)) {
      serverOffsetRef.current = serverNow - Date.now();
    }
  }, []);

  const dropStaleRoom = useCallback(
    reason => {
      storage.remove(CHESS_ROOM_KEY);
      setRoom(null);
      setSearching(false);
      setMatchResult(null);
      setNotice('');
      setChats([]);
      setUnreadChats(0);
      setChatToast(null);
      setChatOpenState(false);
      chatOpenRef.current = false;
      showError(reason);
    },
    [showError]
  );

  const fetchChessMeta = useCallback(async (page = 1) => {
    const token = authToken || storage.get('token');
    setLoadingMeta(true);
    try {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [lbRes, profRes] = await Promise.all([
        fetch(`/api/chess/leaderboard?page=${page}&limit=20`, { headers })
          .then(r => (r.ok ? r.json() : null))
          .catch(() => null),
        token
          ? fetch('/api/chess/profile', { headers })
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
        if (profRes.profile) setProfile(profRes.profile);
        if (Array.isArray(profRes.recentMatches)) setRecentMatches(profRes.recentMatches);
        if (Array.isArray(profRes.ratingHistory)) setRatingHistory(profRes.ratingHistory);
      }
    } finally {
      setLoadingMeta(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (active) {
      fetchChessMeta(1);
    }
  }, [active, currentUser?.id, fetchChessMeta]);

  // Reconnect otomatis ke room Chess Master aktif jika socket sempat terputus
  useEffect(() => {
    if (!socket) return undefined;
    const tryRejoin = () => {
      const savedCode = storage.get(CHESS_ROOM_KEY);
      const token = authToken || storage.get('token');
      if (!savedCode || !token) return;
      socket.emit('chess:room:join', { code: savedCode, token }, res => {
        if (res?.ok) return;
        if (roomCodeRef.current === savedCode) {
          dropStaleRoom('Room catur sudah tidak tersedia.');
        } else {
          storage.remove(CHESS_ROOM_KEY);
        }
      });
    };
    socket.on('connect', tryRejoin);
    if (socket.connected) tryRejoin();
    return () => socket.off('connect', tryRejoin);
  }, [socket, authToken, dropStaleRoom]);

  useEffect(() => {
    if (!socket) return undefined;
    const onRoomClosed = payload => {
      if (payload?.roomCode && roomCodeRef.current && payload.roomCode !== roomCodeRef.current) return;
      dropStaleRoom(payload?.reason || 'Room Chess Master ditutup.');
    };
    socket.on('chess:room:closed', onRoomClosed);
    return () => socket.off('chess:room:closed', onRoomClosed);
  }, [socket, dropStaleRoom]);

  // Kalkulasi jam berjalan berdasarkan state server (tanpa mempercayai timer lokal untuk timeout)
  useEffect(() => {
    if (!room?.match) {
      const tc = CHESS_TIME_CONTROLS.find(t => t.id === (room?.timeControl || timeControl)) || CHESS_TIME_CONTROLS[0];
      setWhiteTimeMs(tc.initialMs);
      setBlackTimeMs(tc.initialMs);
      return undefined;
    }

    const updateClocks = () => {
      const m = room.match;
      if (room.phase !== 'playing') {
        setWhiteTimeMs(Math.max(0, m.whiteTimeMs ?? 0));
        setBlackTimeMs(Math.max(0, m.blackTimeMs ?? 0));
        return;
      }
      const nowServer = Date.now() + serverOffsetRef.current;
      const elapsed = m.turnStartedAt ? Math.max(0, nowServer - m.turnStartedAt) : 0;
      if (m.turn === 'w') {
        setWhiteTimeMs(Math.max(0, (m.whiteTimeMs ?? 0) - elapsed));
        setBlackTimeMs(Math.max(0, m.blackTimeMs ?? 0));
      } else {
        setWhiteTimeMs(Math.max(0, m.whiteTimeMs ?? 0));
        setBlackTimeMs(Math.max(0, (m.blackTimeMs ?? 0) - elapsed));
      }
    };

    updateClocks();
    const id = setInterval(updateClocks, 100);
    return () => clearInterval(id);
  }, [room, timeControl]);

  // Listener Socket.IO untuk semua event Chess Master
  useEffect(() => {
    if (!socket) return undefined;

    const onRoomState = nextRoom => {
      if (!nextRoom) return;
      syncServerClock(nextRoom.serverNow);
      setRoom(nextRoom);
      setSearching(false);
      if (Array.isArray(nextRoom.chats)) {
        setChats(nextRoom.chats);
      }
      if (nextRoom.code) {
        storage.set(CHESS_ROOM_KEY, nextRoom.code);
      }
      if (nextRoom.timeControl) {
        setTimeControl(nextRoom.timeControl);
      }
      if (nextRoom.preferredSide) {
        setPreferredSide(nextRoom.preferredSide);
      }
      if (nextRoom.phase === 'lobby' || nextRoom.phase === 'playing') {
        if (nextRoom.phase === 'lobby') setMatchResult(null);
      }
      if (nextRoom.phase === 'completed' && nextRoom.match?.completedPayload) {
        setMatchResult(nextRoom.match.completedPayload);
      }
    };

    const onMatchFound = payload => {
      syncServerClock(payload?.serverNow);
      setSearching(false);
      sound.playQuizCountdown?.(true);
    };

    const onPlayerJoined = payload => {
      syncServerClock(payload?.serverNow);
      sound.playClick();
    };

    const onMatchStarted = payload => {
      syncServerClock(payload?.serverNow);
      setSearching(false);
      setMatchResult(null);
      sound.playClick();
    };

    const onMoveMade = payload => {
      syncServerClock(payload?.serverNow);
      const mv = payload?.move;
      if (mv) {
        if (mv.isCheckmate || mv.isCheck) {
          sound.playMonsterAttack?.();
        } else if (mv.captured) {
          sound.playMonsterHurt?.();
        } else {
          sound.playClick();
        }
      }
      setRoom(prev => {
        if (!prev || prev.code !== payload?.roomCode || !prev.match) return prev;
        return {
          ...prev,
          serverNow: payload.serverNow,
          match: {
            ...prev.match,
            fen: payload.fen,
            turn: payload.turn,
            moveVersion: payload.moveVersion,
            whiteTimeMs: payload.whiteTimeMs,
            blackTimeMs: payload.blackTimeMs,
            turnStartedAt: payload.serverNow,
            inCheck: Boolean(mv?.isCheck),
            isCheckmate: Boolean(mv?.isCheckmate),
            lastMove: mv ? { from: mv.from, to: mv.to, san: mv.san, color: mv.color } : prev.match.lastMove,
            drawOffer: null,
            moves: [...(prev.match.moves || []), mv].filter(Boolean)
          }
        };
      });
    };

    const onClockUpdated = payload => {
      syncServerClock(payload?.serverNow);
      setRoom(prev => {
        if (!prev || prev.code !== payload?.roomCode || !prev.match) return prev;
        return {
          ...prev,
          serverNow: payload.serverNow,
          match: {
            ...prev.match,
            whiteTimeMs: payload.whiteTimeMs ?? prev.match.whiteTimeMs,
            blackTimeMs: payload.blackTimeMs ?? prev.match.blackTimeMs,
            turn: payload.turn ?? prev.match.turn,
            turnStartedAt: payload.serverNow
          }
        };
      });
    };

    const onDrawOffered = payload => {
      syncServerClock(payload?.serverNow);
      sound.playClick();
      if (payload?.byUserId !== currentUser?.id) {
        showNotice(`${payload?.byName || 'Lawan'} menawarkan remis (Draw).`, 10000);
      } else {
        showNotice('Tawaran remis dikirim ke lawan.', 4000);
      }
    };

    const onDrawAccepted = () => {
      showNotice('Tawaran remis diterima! Pertandingan berakhir seri.', 5000);
    };

    const onDrawDeclined = payload => {
      if (payload?.reason === 'expired') {
        showNotice('Tawaran remis kedaluwarsa.', 3500);
      } else {
        showNotice('Tawaran remis ditolak.', 3500);
      }
    };

    const onPlayerResigned = payload => {
      showNotice(`${payload?.resignedName || 'Pemain'} menyerah (Resign).`, 5000);
    };

    const onMatchCompleted = payload => {
      if (!payload?.matchId || lastCompletedMatchRef.current === payload.matchId) return;
      lastCompletedMatchRef.current = payload.matchId;

      syncServerClock(payload.serverNow);
      setMatchResult(payload);

      if (currentUser?.id && payload.winnerId === currentUser.id) {
        sound.playWin();
        triggerConfetti();
        if (payload.winnerReward?.user) {
          onUpdateUser?.(payload.winnerReward.user);
        } else if (payload.rewardCoins) {
          onUpdateUser?.(prev =>
            prev ? { ...prev, points: (prev.points || 0) + Number(payload.rewardCoins) } : prev
          );
        }
      } else {
        sound.playClick();
      }

      fetchChessMeta(1);
    };

    const onRematchRequested = payload => {
      if (payload?.byUserId !== currentUser?.id) {
        showNotice(`${payload?.byName || 'Lawan'} mengajak Rematch! Klik Rematch untuk menerima.`, 8000);
      } else {
        showNotice('Permintaan Rematch dikirim. Menunggu lawan...', 5000);
      }
    };

    const onPlayerDisconnected = payload => {
      if (payload?.game !== 'chess' && !roomCodeRef.current) return;
      if (!payload?.name) return;
      showNotice(`${payload.name} terputus. Menunggu sambungan ulang (45 detik)...`, 10000);
    };

    const onPlayerReconnected = payload => {
      if (payload?.game !== 'chess' && !roomCodeRef.current) return;
      if (!payload?.name) return;
      showNotice(`${payload.name} tersambung kembali!`, 3500);
    };

    const onLeaderboardUpdate = data => {
      if (data && Array.isArray(data.entries)) {
        setLeaderboard(data.entries);
        setLeaderboardMeta({
          total: data.total || 0,
          page: data.page || 1,
          limit: data.limit || 20,
          totalPages: data.totalPages || 1,
          myEntry: data.myEntry || null
        });
      }
    };

    const onChatMessage = msg => {
      if (!msg) return;
      setChats(prev => [...prev.slice(-49), msg]);
      if (msg.senderId === currentUser?.id) return;
      sound.playChatNotification();
      if (!chatOpenRef.current) setUnreadChats(n => n + 1);
      setChatToast(msg);
      if (chatToastTimerRef.current) clearTimeout(chatToastTimerRef.current);
      chatToastTimerRef.current = setTimeout(() => setChatToast(null), 4200);
    };

    socket.on('chess:room:state', onRoomState);
    socket.on('MatchFound', onMatchFound);
    socket.on('PlayerJoined', onPlayerJoined);
    socket.on('MatchStarted', onMatchStarted);
    socket.on('ChessMoveMade', onMoveMade);
    socket.on('ClockUpdated', onClockUpdated);
    socket.on('DrawOffered', onDrawOffered);
    socket.on('DrawAccepted', onDrawAccepted);
    socket.on('DrawDeclined', onDrawDeclined);
    socket.on('PlayerResigned', onPlayerResigned);
    socket.on('MatchCompleted', onMatchCompleted);
    socket.on('RematchRequested', onRematchRequested);
    socket.on('PlayerDisconnected', onPlayerDisconnected);
    socket.on('PlayerReconnected', onPlayerReconnected);
    socket.on('chess:leaderboard:update', onLeaderboardUpdate);
    socket.on('chess:chat_message', onChatMessage);

    return () => {
      socket.off('chess:room:state', onRoomState);
      socket.off('MatchFound', onMatchFound);
      socket.off('PlayerJoined', onPlayerJoined);
      socket.off('MatchStarted', onMatchStarted);
      socket.off('ChessMoveMade', onMoveMade);
      socket.off('ClockUpdated', onClockUpdated);
      socket.off('DrawOffered', onDrawOffered);
      socket.off('DrawAccepted', onDrawAccepted);
      socket.off('DrawDeclined', onDrawDeclined);
      socket.off('PlayerResigned', onPlayerResigned);
      socket.off('MatchCompleted', onMatchCompleted);
      socket.off('RematchRequested', onRematchRequested);
      socket.off('PlayerDisconnected', onPlayerDisconnected);
      socket.off('PlayerReconnected', onPlayerReconnected);
      socket.off('chess:leaderboard:update', onLeaderboardUpdate);
      socket.off('chess:chat_message', onChatMessage);
    };
  }, [socket, currentUser?.id, onUpdateUser, syncServerClock, showNotice, fetchChessMeta]);

  // ==========================================
  // AKSI PEMAIN
  // ==========================================

  const ensureAuth = useCallback(() => {
    const token = authToken || storage.get('token');
    if (!currentUser || !token) {
      onNeedLogin?.();
      return null;
    }
    return token;
  }, [authToken, currentUser, onNeedLogin]);

  const startMatchmaking = useCallback(
    customTimeControl => {
      const token = ensureAuth();
      if (!token || !socket) return;
      const tc = customTimeControl || timeControl || '5+0';
      sound.playClick();
      setError('');
      setSearching(true);
      socket.emit('chess:matchmaking:join', { token, timeControl: tc }, res => {
        if (!res?.ok) {
          setSearching(false);
          showError(res?.error || 'Gagal mencari lawan.');
        } else if (res.matched && res.room) {
          setSearching(false);
        }
      });
    },
    [ensureAuth, socket, timeControl, showError]
  );

  const cancelMatchmaking = useCallback(() => {
    const token = authToken || storage.get('token');
    sound.playClick();
    setSearching(false);
    if (socket) {
      socket.emit('chess:matchmaking:leave', { token });
    }
  }, [socket, authToken]);

  const playVsBot = useCallback(
    opts => {
      const token = ensureAuth();
      if (!token || !socket) return;
      sound.playClick();
      setError('');
      setSearching(false);
      const tc = opts?.timeControl || timeControl || '5+0';
      const side = opts?.preferredSide || preferredSide || 'random';
      const diff = opts?.difficulty || botDifficulty || 'medium';
      const fromQueue = Boolean(opts?.fromQueue);
      socket.emit(
        'chess:bot:play',
        { token, timeControl: tc, preferredSide: side, difficulty: diff, fromQueue },
        res => {
          if (!res?.ok) {
            showError(res?.error || 'Gagal memulai pertandingan melawan Bot.');
          }
        }
      );
    },
    [ensureAuth, socket, timeControl, preferredSide, botDifficulty, showError]
  );

  const createRoom = useCallback(
    opts => {
      const token = ensureAuth();
      if (!token || !socket) return;
      sound.playClick();
      setError('');
      const tc = opts?.timeControl || timeControl || '5+0';
      const side = opts?.preferredSide || preferredSide || 'random';
      const groupId = typeof opts?.groupId === 'string' && opts.groupId ? opts.groupId : undefined;
      socket.emit(
        'chess:room:create',
        { token, timeControl: tc, preferredSide: side, groupId },
        res => {
          if (!res?.ok) showError(res?.error || 'Gagal membuat Private Room.');
        }
      );
    },
    [ensureAuth, socket, timeControl, preferredSide, showError]
  );

  const joinRoomByCode = useCallback(
    customCode => {
      const token = ensureAuth();
      if (!token || !socket) return;
      const clean = String(customCode ?? joinCode ?? '').trim().toUpperCase();
      if (!clean) {
        showError('Masukkan kode room terlebih dahulu.');
        return;
      }
      sound.playClick();
      setError('');
      socket.emit('chess:room:join', { code: clean, token }, res => {
        if (!res?.ok) showError(res?.error || 'Gagal bergabung ke room.');
      });
    },
    [ensureAuth, socket, joinCode, showError]
  );

  const updateRoomConfig = useCallback(
    ({ timeControl: nextTc, preferredSide: nextSide }) => {
      const token = ensureAuth();
      if (!token || !socket || !room) return;
      sound.playClick();
      if (nextTc) setTimeControl(nextTc);
      if (nextSide) setPreferredSide(nextSide);
      socket.emit(
        'chess:room:config',
        {
          code: room.code,
          token,
          ...(nextTc ? { timeControl: nextTc } : {}),
          ...(nextSide ? { preferredSide: nextSide } : {})
        },
        res => {
          if (!res?.ok) showError(res?.error);
        }
      );
    },
    [ensureAuth, socket, room, showError]
  );

  const toggleReady = useCallback(
    explicitReady => {
      const token = ensureAuth();
      if (!token || !socket || !room) return;
      sound.playClick();
      socket.emit(
        'chess:player:ready',
        {
          code: room.code,
          token,
          ...(explicitReady !== undefined ? { ready: Boolean(explicitReady) } : {})
        },
        res => {
          if (!res?.ok) showError(res?.error);
        }
      );
    },
    [ensureAuth, socket, room, showError]
  );

  const submitMove = useCallback(
    ({ from, to, promotion = 'q' }, cb) => {
      const token = ensureAuth();
      if (!token || !socket || !room || room.phase !== 'playing') return;
      socket.emit(
        'chess:move',
        {
          code: room.code,
          matchId: room.match?.id,
          token,
          from,
          to,
          promotion,
          moveVersion: room.match?.moveVersion
        },
        res => {
          if (!res?.ok) {
            showError(res?.error || 'Langkah tidak sah.');
          }
          if (typeof cb === 'function') cb(res);
        }
      );
    },
    [ensureAuth, socket, room, showError]
  );

  const offerDraw = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket || !room || room.phase !== 'playing') return;
    sound.playClick();
    socket.emit('chess:draw:offer', { code: room.code, matchId: room.match?.id, token }, res => {
      if (!res?.ok) showError(res?.error);
    });
  }, [ensureAuth, socket, room, showError]);

  const acceptDraw = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket || !room || room.phase !== 'playing') return;
    sound.playClick();
    socket.emit('chess:draw:accept', { code: room.code, matchId: room.match?.id, token }, res => {
      if (!res?.ok) showError(res?.error);
    });
  }, [ensureAuth, socket, room, showError]);

  const declineDraw = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket || !room || room.phase !== 'playing') return;
    sound.playClick();
    socket.emit('chess:draw:decline', { code: room.code, matchId: room.match?.id, token }, res => {
      if (!res?.ok) showError(res?.error);
    });
  }, [ensureAuth, socket, room, showError]);

  const resign = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket || !room || room.phase !== 'playing') return;
    sound.playClick();
    socket.emit('chess:resign', { code: room.code, matchId: room.match?.id, token }, res => {
      if (!res?.ok) showError(res?.error);
    });
  }, [ensureAuth, socket, room, showError]);

  const requestRematch = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket || !room || room.phase !== 'completed') return;
    sound.playClick();
    socket.emit('chess:rematch', { code: room.code, matchId: room.match?.id, token }, res => {
      if (!res?.ok) showError(res?.error);
    });
  }, [ensureAuth, socket, room, showError]);

  const leaveRoom = useCallback(() => {
    const token = authToken || storage.get('token');
    sound.playClick();
    storage.remove(CHESS_ROOM_KEY);
    if (socket && room?.code) {
      socket.emit('chess:room:leave', { code: room.code, token });
    }
    setRoom(null);
    setSearching(false);
    setMatchResult(null);
    setNotice('');
    setChats([]);
    setUnreadChats(0);
    setChatToast(null);
    setChatOpenState(false);
    chatOpenRef.current = false;
    fetchChessMeta(1);
  }, [socket, room?.code, authToken, fetchChessMeta]);

  const sendReaction = useCallback(
    emoji => {
      const token = ensureAuth();
      if (!token || !socket || !room) return;
      sound.playClick();
      socket.emit('chess:reaction', { code: room.code, token, emoji });
    },
    [ensureAuth, socket, room]
  );

  const sendChat = useCallback(
    (text, replyTo = null) => {
      const token = ensureAuth();
      if (!token || !socket || !room) return false;
      const clean = String(text || '').trim();
      if (!clean) return false;
      sound.playClick();
      const payload = {
        code: room.code,
        token,
        text: clean,
        ...(replyTo?.id !== undefined && replyTo?.id !== null ? { replyToId: replyTo.id } : {})
      };
      socket.emit('chess:chat', payload, res => {
        if (res && !res.ok && res.error) showError(res.error);
      });
      return true;
    },
    [ensureAuth, socket, room, showError]
  );

  const setChatOpen = useCallback(open => {
    const isOpen = Boolean(open);
    chatOpenRef.current = isOpen;
    setChatOpenState(isOpen);
    if (isOpen) setUnreadChats(0);
  }, []);

  const dismissChatToast = useCallback(() => {
    setChatToast(null);
  }, []);

  const openReplay = useCallback(async matchId => {
    if (!matchId) return;
    sound.playClick();
    setLoadingReplay(true);
    try {
      const res = await fetch(`/api/chess/matches/${encodeURIComponent(matchId)}`).then(r =>
        r.ok ? r.json() : null
      );
      if (res?.success && res.match) {
        setReplayMatch(res.match);
        setReplayPly(res.match.moves?.length || 0);
      } else {
        showError('Detail pertandingan tidak ditemukan.');
      }
    } catch (_) {
      showError('Gagal memuat detail pertandingan.');
    } finally {
      setLoadingReplay(false);
    }
  }, [showError]);

  const closeReplay = useCallback(() => {
    sound.playClick();
    setReplayMatch(null);
    setReplayPly(0);
  }, []);

  const downloadPgn = useCallback(matchId => {
    if (!matchId) return;
    sound.playClick();
    window.open(`/api/chess/matches/${encodeURIComponent(matchId)}/pgn`, '_blank', 'noopener,noreferrer');
  }, []);

  return {
    room,
    joinCode,
    setJoinCode,
    timeControl,
    setTimeControl,
    preferredSide,
    setPreferredSide,
    botDifficulty,
    setBotDifficulty,
    searching,
    error,
    notice,
    matchResult,
    whiteTimeMs,
    blackTimeMs,
    profile,
    recentMatches,
    ratingHistory,
    leaderboard,
    leaderboardMeta,
    loadingMeta,
    replayMatch,
    replayPly,
    setReplayPly,
    loadingReplay,
    chats,
    unreadChats,
    chatToast,
    chatOpen,
    actions: {
      startMatchmaking,
      cancelMatchmaking,
      playVsBot,
      createRoom,
      joinRoomByCode,
      updateRoomConfig,
      toggleReady,
      submitMove,
      offerDraw,
      acceptDraw,
      declineDraw,
      resign,
      requestRematch,
      leaveRoom,
      sendChat,
      sendReaction,
      setChatOpen,
      dismissChatToast,
      openReplay,
      closeReplay,
      downloadPgn,
      loadLeaderboardPage: fetchChessMeta,
      refreshMeta: () => fetchChessMeta(leaderboardMeta.page || 1)
    }
  };
}


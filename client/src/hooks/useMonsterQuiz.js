import { useCallback, useEffect, useRef, useState } from 'react';
import { storage } from '../storage';
import { sound } from '../sound';
import { triggerConfetti } from '../confetti';
import { QUIZ_MONSTERS } from '../quiz/monsters';

const QUIZ_ROOM_KEY = 'active_quiz_room';

// Hook state & komunikasi realtime Monster Quiz Battle
export function useMonsterQuiz({ socket, authToken, currentUser, onUpdateUser, onNeedLogin, active }) {
  const [room, setRoom] = useState(null);
  const [joinCode, setJoinCode] = useState('');
  const [selectedMonsterId, setSelectedMonsterId] = useState(QUIZ_MONSTERS[0].id);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [roundResult, setRoundResult] = useState(null);
  const [matchResult, setMatchResult] = useState(null);
  const [remainingMs, setRemainingMs] = useState(0);
  const [countdownSec, setCountdownSec] = useState(0);

  // State animasi per slot (0, 1, 2): 'idle' | 'attack' | 'hurt' | 'victory' | 'defeat'
  const [slotAnim, setSlotAnim] = useState({ 0: 'idle', 1: 'idle', 2: 'idle' });
  // Angka damage melayang: { targetSlot: 0 | 1 | 2, targetSlots?: number[], amount: 10, key: roundId }
  const [damagePopup, setDamagePopup] = useState(null);

  // Statistik pribadi, riwayat pertandingan, & leaderboard Monster Quiz Battle
  const [stats, setStats] = useState(null);
  const [history, setHistory] = useState([]);
  const [leaderboard, setLeaderboard] = useState([]);
  const [loadingStats, setLoadingStats] = useState(false);

  // Obrolan room & notifikasi chat
  const [chats, setChats] = useState([]);
  const [unreadChats, setUnreadChats] = useState(0);
  const [chatToast, setChatToast] = useState(null);
  const [chatOpen, setChatOpenState] = useState(false);

  // Selisih jam server vs klien (serverNow - Date.now()) agar countdown 15 detik akurat
  const serverOffsetRef = useRef(0);
  const chatOpenRef = useRef(false);
  const chatToastTimerRef = useRef(null);
  // Deduplikasi event round/attack/damage berdasarkan roundId
  const lastHandledRoundRef = useRef('');
  const lastHandledAttackRef = useRef('');
  const lastHandledFinishRef = useRef('');
  const animTimerRef = useRef(null);
  const errorTimerRef = useRef(null);

  const showError = useCallback(msg => {
    if (!msg) return;
    setError(String(msg));
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(''), 5000);
  }, []);

  // Room di server sudah tidak ada (ditutup atau server restart): keluar dari layar room yang basi
  const roomCodeRef = useRef('');
  roomCodeRef.current = room?.code || '';
  const dropStaleRoom = useCallback(
    reason => {
      storage.remove(QUIZ_ROOM_KEY);
      setRoom(null);
      setSearching(false);
      setRoundResult(null);
      setMatchResult(null);
      setDamagePopup(null);
      setNotice('');
      setChats([]);
      setUnreadChats(0);
      setChatToast(null);
      setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
      showError(reason);
    },
    [showError]
  );

  const syncServerClock = useCallback(serverNow => {
    if (typeof serverNow === 'number' && Number.isFinite(serverNow)) {
      serverOffsetRef.current = serverNow - Date.now();
    }
  }, []);

  const fetchQuizMeta = useCallback(async () => {
    const token = authToken || storage.get('token');
    setLoadingStats(true);
    try {
      const [lbRes, statsRes] = await Promise.all([
        fetch('/api/quiz/leaderboard').then(r => (r.ok ? r.json() : null)).catch(() => null),
        token
          ? fetch('/api/quiz/stats', { headers: { Authorization: `Bearer ${token}` } })
              .then(r => (r.ok ? r.json() : null))
              .catch(() => null)
          : Promise.resolve(null)
      ]);
      if (lbRes?.success && Array.isArray(lbRes.leaderboard)) {
        setLeaderboard(lbRes.leaderboard);
      }
      if (statsRes?.success) {
        if (statsRes.stats) setStats(statsRes.stats);
        if (Array.isArray(statsRes.history)) setHistory(statsRes.history);
      }
    } finally {
      setLoadingStats(false);
    }
  }, [authToken]);

  useEffect(() => {
    if (active) {
      fetchQuizMeta();
    }
  }, [active, currentUser?.id, fetchQuizMeta]);

  // Otomatis rejoin room Monster Quiz yang masih aktif saat socket tersambung kembali
  useEffect(() => {
    if (!socket) return undefined;
    const tryRejoin = () => {
      const savedCode = storage.get(QUIZ_ROOM_KEY);
      const token = authToken || storage.get('token');
      if (!savedCode || !token) return;
      socket.emit('quiz:room:join', { code: savedCode, token }, res => {
        if (res?.ok) return;
        if (roomCodeRef.current === savedCode) {
          dropStaleRoom('Room kuis sudah tidak tersedia (mungkin server baru diperbarui). Pertandingan itu tidak dihitung.');
        } else {
          storage.remove(QUIZ_ROOM_KEY);
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
      dropStaleRoom(payload?.reason || 'Room kuis ditutup.');
    };
    socket.on('quiz:room:closed', onRoomClosed);
    return () => socket.off('quiz:room:closed', onRoomClosed);
  }, [socket, dropStaleRoom]);

  // Timer visual 15 detik pertanyaan & countdown 3 detik sebelum pertandingan dimulai
  useEffect(() => {
    if (!room) {
      setRemainingMs(0);
      setCountdownSec(0);
      return undefined;
    }

    const updateClocks = () => {
      const nowServer = Date.now() + serverOffsetRef.current;

      if (room.phase === 'countdown' && room.countdownEndsAt) {
        const rem = Math.max(0, room.countdownEndsAt - nowServer);
        setCountdownSec(Math.ceil(rem / 1000));
      } else {
        setCountdownSec(0);
      }

      if (room.phase === 'question' && room.match?.question?.deadlineAt) {
        const rem = Math.max(0, room.match.question.deadlineAt - nowServer);
        setRemainingMs(rem);
      } else if (room.phase !== 'question') {
        setRemainingMs(0);
      }
    };

    updateClocks();
    const id = setInterval(updateClocks, 100);
    return () => clearInterval(id);
  }, [room]);

  // Pasang seluruh event listener realtime Monster Quiz Battle
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
        storage.set(QUIZ_ROOM_KEY, nextRoom.code);
      }
      const me = nextRoom.players?.find(p => p.userId === currentUser?.id);
      if (me?.monsterId) {
        setSelectedMonsterId(me.monsterId);
      }
      if (nextRoom.phase === 'lobby') {
        setRoundResult(null);
        setMatchResult(null);
        setDamagePopup(null);
        setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
      }
    };

    const onRoomCreated = payload => {
      if (payload?.room) onRoomState(payload.room);
    };

    const onRoomJoined = payload => {
      setSearching(false);
      if (payload?.room && payload.userId === currentUser?.id) {
        onRoomState(payload.room);
      }
    };

    const onGameStarted = payload => {
      syncServerClock(payload?.serverNow);
      setSearching(false);
      setRoundResult(null);
      setMatchResult(null);
      setDamagePopup(null);
      setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
      sound.playQuizCountdown(true);
    };

    const onQuestionStarted = payload => {
      syncServerClock(payload?.serverNow);
      setRoundResult(null);
      setDamagePopup(null);
      setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
      sound.playClick();
    };

    const onAnswerResult = payload => {
      if (!payload?.roundId) return;
      // Cegah pemrosesan ganda untuk ronde yang sama
      if (lastHandledRoundRef.current === payload.roundId) return;
      lastHandledRoundRef.current = payload.roundId;

      syncServerClock(payload.serverNow);
      setRoundResult(payload);

      const myAns = currentUser?.id ? payload.answers?.[currentUser.id] : null;
      if (myAns?.isCorrect) {
        sound.playQuizCorrect();
      } else {
        sound.playQuizWrong();
      }
    };

    const onMonsterAttacked = payload => {
      const eventKey = payload?.eventId || payload?.roundId;
      if (!eventKey || lastHandledAttackRef.current === eventKey) return;
      lastHandledAttackRef.current = eventKey;

      const attackerSlot = payload.attackerSlot ?? 0;
      const targetSlot = payload.targetSlot ?? (attackerSlot === 0 ? 1 : 0);
      const attackerSlots = Array.isArray(payload.attackerSlots) && payload.attackerSlots.length > 0
        ? payload.attackerSlots
        : [attackerSlot];
      const targetSlots = Array.isArray(payload.targetSlots) && payload.targetSlots.length > 0
        ? payload.targetSlots
        : [targetSlot];

      sound.playMonsterAttack();
      setTimeout(() => sound.playMonsterHurt(), 220);

      const nextAnim = { 0: 'idle', 1: 'idle', 2: 'idle' };
      attackerSlots.forEach(s => { nextAnim[s] = 'attack'; });
      targetSlots.forEach(s => { nextAnim[s] = 'hurt'; });
      setSlotAnim(nextAnim);
      setDamagePopup({
        targetSlot,
        targetSlots,
        amount: payload.damage || 10,
        key: eventKey
      });

      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      animTimerRef.current = setTimeout(() => {
        setSlotAnim(prev =>
          prev[0] === 'victory' || prev[1] === 'victory' || prev[2] === 'victory'
            ? prev
            : { 0: 'idle', 1: 'idle', 2: 'idle' }
        );
        setDamagePopup(null);
      }, 2400);
    };

    const onMonsterDamaged = payload => {
      const eventKey = payload?.eventId || payload?.roundId;
      if (!eventKey) return;
      const targetSlot = payload.targetSlot ?? 1;
      const targetSlots = Array.isArray(payload.targetSlots) && payload.targetSlots.length > 0
        ? payload.targetSlots
        : [targetSlot];
      setDamagePopup(prev =>
        prev?.key === eventKey
          ? prev
          : {
              targetSlot,
              targetSlots,
              amount: payload.damage || 10,
              key: eventKey
            }
      );
    };

    const onGameFinished = payload => {
      if (!payload?.matchId || lastHandledFinishRef.current === payload.matchId) return;
      lastHandledFinishRef.current = payload.matchId;

      syncServerClock(payload.serverNow);
      setMatchResult(payload);

      if (animTimerRef.current) clearTimeout(animTimerRef.current);

      const p0 = payload.players?.find(p => p.slot === 0);
      const p1 = payload.players?.find(p => p.slot === 1);
      const p2 = payload.players?.find(p => p.slot === 2);

      if (payload.winnerUserId) {
        setSlotAnim({
          0: p0?.userId === payload.winnerUserId ? 'victory' : 'defeat',
          1: p1?.userId === payload.winnerUserId ? 'victory' : 'defeat',
          2: p2?.userId === payload.winnerUserId ? 'victory' : 'defeat'
        });
      } else {
        setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
      }

      if (currentUser?.id && payload.winnerUserId === currentUser.id) {
        sound.playWin();
        triggerConfetti();
        if (payload.winnerReward?.user) {
          onUpdateUser?.(payload.winnerReward.user);
        } else if (payload.rewardPoints) {
          onUpdateUser?.(prev =>
            prev ? { ...prev, points: (prev.points || 0) + Number(payload.rewardPoints) } : prev
          );
        }
      }

      if (currentUser?.id && payload.stats?.[currentUser.id]) {
        setStats(payload.stats[currentUser.id]);
      }
      fetchQuizMeta();
    };

    const onPlayerDisconnected = payload => {
      if (!payload?.name) return;
      setNotice(`${payload.name} terputus. Menunggu sambungan ulang (30 detik)...`);
    };

    const onPlayerReconnected = payload => {
      if (!payload?.name) return;
      setNotice(`${payload.name} berhasil tersambung kembali!`);
      setTimeout(() => setNotice(''), 3500);
    };

    const onLeaderboardUpdate = list => {
      if (Array.isArray(list)) setLeaderboard(list);
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

    socket.on('quiz:room:state', onRoomState);
    socket.on('room.created', onRoomCreated);
    socket.on('room.joined', onRoomJoined);
    socket.on('game.started', onGameStarted);
    socket.on('question.started', onQuestionStarted);
    socket.on('answer.result', onAnswerResult);
    socket.on('monster.attacked', onMonsterAttacked);
    socket.on('monster.damaged', onMonsterDamaged);
    socket.on('game.finished', onGameFinished);
    socket.on('player.disconnected', onPlayerDisconnected);
    socket.on('player.reconnected', onPlayerReconnected);
    socket.on('quiz:leaderboard:update', onLeaderboardUpdate);
    socket.on('quiz:chat_message', onChatMessage);

    return () => {
      socket.off('quiz:room:state', onRoomState);
      socket.off('room.created', onRoomCreated);
      socket.off('room.joined', onRoomJoined);
      socket.off('game.started', onGameStarted);
      socket.off('question.started', onQuestionStarted);
      socket.off('answer.result', onAnswerResult);
      socket.off('monster.attacked', onMonsterAttacked);
      socket.off('monster.damaged', onMonsterDamaged);
      socket.off('game.finished', onGameFinished);
      socket.off('player.disconnected', onPlayerDisconnected);
      socket.off('player.reconnected', onPlayerReconnected);
      socket.off('quiz:leaderboard:update', onLeaderboardUpdate);
      socket.off('quiz:chat_message', onChatMessage);
    };
  }, [socket, currentUser?.id, onUpdateUser, syncServerClock, fetchQuizMeta]);

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

  const createRoom = useCallback(
    groupId => {
      const token = ensureAuth();
      if (!token || !socket) return;
      sound.playClick();
      setError('');
      const cleanGroupId = typeof groupId === 'string' && groupId ? groupId : undefined;
      socket.emit('quiz:room:create', { token, monsterId: selectedMonsterId, groupId: cleanGroupId }, res => {
        if (!res?.ok) showError(res?.error || 'Gagal membuat room.');
      });
    },
    [ensureAuth, socket, selectedMonsterId, showError]
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
      socket.emit('quiz:room:join', { code: clean, token, monsterId: selectedMonsterId }, res => {
        if (!res?.ok) showError(res?.error || 'Gagal bergabung ke room.');
      });
    },
    [ensureAuth, socket, joinCode, selectedMonsterId, showError]
  );

  const startMatchmaking = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket) return;
    sound.playClick();
    setError('');
    setSearching(true);
    socket.emit('quiz:matchmaking:join', { token, monsterId: selectedMonsterId }, res => {
      if (!res?.ok) {
        setSearching(false);
        showError(res?.error || 'Gagal mencari lawan.');
      } else if (res.matched && res.room) {
        setSearching(false);
      }
    });
  }, [ensureAuth, socket, selectedMonsterId, showError]);

  const cancelMatchmaking = useCallback(() => {
    const token = authToken || storage.get('token');
    sound.playClick();
    setSearching(false);
    if (socket) {
      socket.emit('quiz:matchmaking:leave', { token });
    }
  }, [socket, authToken]);

  const selectMonster = useCallback(
    monsterId => {
      sound.playClick();
      setSelectedMonsterId(monsterId);
      const token = authToken || storage.get('token');
      if (socket && room) {
        socket.emit('quiz:monster:select', { code: room.code, token, monsterId }, res => {
          if (!res?.ok) showError(res?.error);
        });
      }
    },
    [socket, room, authToken, showError]
  );

  const toggleReady = useCallback(
    explicitReady => {
      const token = ensureAuth();
      if (!token || !socket || !room) return;
      sound.playClick();
      socket.emit(
        'quiz:player:ready',
        {
          code: room.code,
          token,
          monsterId: selectedMonsterId,
          ...(explicitReady !== undefined ? { ready: Boolean(explicitReady) } : {})
        },
        res => {
          if (!res?.ok) showError(res?.error);
        }
      );
    },
    [ensureAuth, socket, room, selectedMonsterId, showError]
  );

  const submitAnswer = useCallback(
    selectedIndex => {
      const token = ensureAuth();
      if (!token || !socket || !room || room.phase !== 'question') return;
      const q = room.match?.question;
      if (!q) return;
      if (room.match?.mySubmittedIndex !== null && room.match?.mySubmittedIndex !== undefined) {
        return;
      }
      sound.playClick();
      socket.emit(
        'quiz:answer:submit',
        {
          code: room.code,
          token,
          roundNo: q.roundNo,
          questionId: q.id,
          selectedIndex
        },
        res => {
          if (!res?.ok) showError(res?.error);
        }
      );
    },
    [ensureAuth, socket, room, showError]
  );

  const useHint = useCallback(() => {
    const token = ensureAuth();
    if (!token || !socket || !room || room.phase !== 'question') return;
    if (room.match?.mySubmittedIndex !== null && room.match?.mySubmittedIndex !== undefined) {
      return;
    }
    if ((room.match?.myEliminatedOptions || []).length > 0) {
      return;
    }
    sound.playClick();
    socket.emit(
      'quiz:hint:use',
      {
        code: room.code,
        token
      },
      res => {
        if (!res?.ok) {
          showError(res?.error || 'Gagal menggunakan Hints Jawaban.');
          return;
        }
        sound.playShopPurchase();
        if (res.user) {
          onUpdateUser?.(res.user);
        }
      }
    );
  }, [ensureAuth, socket, room, onUpdateUser, showError]);

  const playAgain = useCallback(() => {
    setRoundResult(null);
    setMatchResult(null);
    setDamagePopup(null);
    setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
    toggleReady(true);
  }, [toggleReady]);

  const leaveRoom = useCallback(() => {
    const token = authToken || storage.get('token');
    sound.playClick();
    storage.remove(QUIZ_ROOM_KEY);
    if (socket && room?.code) {
      socket.emit('quiz:room:leave', { code: room.code, token });
    }
    setRoom(null);
    setSearching(false);
    setRoundResult(null);
    setMatchResult(null);
    setDamagePopup(null);
    setNotice('');
    setChats([]);
    setUnreadChats(0);
    setChatToast(null);
    setChatOpenState(false);
    chatOpenRef.current = false;
    setSlotAnim({ 0: 'idle', 1: 'idle', 2: 'idle' });
    fetchQuizMeta();
  }, [socket, room?.code, authToken, fetchQuizMeta]);

  const sendReaction = useCallback(
    emoji => {
      const token = ensureAuth();
      if (!token || !socket || !room) return;
      sound.playClick();
      socket.emit('quiz:reaction', { code: room.code, token, emoji });
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
      socket.emit('quiz:chat', payload, res => {
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

  return {
    room,
    joinCode,
    setJoinCode,
    selectedMonsterId,
    searching,
    error,
    notice,
    roundResult,
    matchResult,
    remainingMs,
    countdownSec,
    slotAnim,
    damagePopup,
    stats,
    history,
    leaderboard,
    loadingStats,
    chats,
    unreadChats,
    chatToast,
    chatOpen,
    actions: {
      createRoom,
      joinRoomByCode,
      startMatchmaking,
      cancelMatchmaking,
      selectMonster,
      toggleReady,
      submitAnswer,
      useHint,
      playAgain,
      leaveRoom,
      sendChat,
      sendReaction,
      setChatOpen,
      dismissChatToast,
      refreshStats: fetchQuizMeta
    }
  };
}


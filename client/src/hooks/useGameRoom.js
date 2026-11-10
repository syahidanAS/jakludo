import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { storage } from '../storage';
import { sound } from '../sound';
import { triggerConfetti } from '../confetti';
import { notify } from '../notifications';

const roomFromUrl = () => new URLSearchParams(location.search).get('room') || '';

// Koneksi socket, state room, chat, notifikasi permainan, dan semua aksi pemain
export function useGameRoom({ authToken, currentUser, onNeedLogin }) {
  // WebSocket dicoba lebih dulu (lebih stabil lewat tunnel/proxy), polling hanya cadangan
  const socket = useMemo(() => io({
    autoConnect: true,
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 3000
  }), []);

  const [screen, setScreen] = useState('home');
  const [code, setCode] = useState(roomFromUrl);
  const [room, setRoom] = useState(null);
  const [playerId, setPlayerId] = useState('');
  const [error, setError] = useState('');
  const [chats, setChats] = useState([]);
  const [unreadChats, setUnreadChats] = useState(0);
  const [chatToast, setChatToast] = useState(null);
  const [reactions, setReactions] = useState([]);
  const [memberNotice, setMemberNotice] = useState(null);
  const [itemNotice, setItemNotice] = useState(null);
  // Item aktif yang sedang menunggu pemain memilih target (id item), null jika tidak ada
  const [itemTargeting, setItemTargeting] = useState(null);

  const chatOpenRef = useRef(false);
  const chatToastTimer = useRef(null);
  const errorTimer = useRef(null);
  const hasCelebrated = useRef(false);
  const lastItemEventId = useRef(null);
  const lastCaptureId = useRef(null);
  const turnNotified = useRef(false);
  // Saat baru masuk/kembali ke room, event item lama tidak boleh diputar ulang
  const seedEvents = useRef(false);
  const playerIdRef = useRef('');
  playerIdRef.current = playerId;

  const showError = useCallback(message => {
    setError(message);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setError(''), 5000);
  }, []);

  const resetRoomState = useCallback(() => {
    setRoom(null);
    setChats([]);
    setPlayerId('');
    setUnreadChats(0);
    setItemTargeting(null);
    setScreen('home');
  }, []);

  // Gabung (ulang) ke room setiap kali socket tersambung: saat halaman dibuka (link undangan /
  // sesi tersimpan) dan setelah koneksi sempat putus, karena server memberi socket id baru.
  const rejoinRef = useRef(null);
  rejoinRef.current = () => {
    const savedRoom = storage.get('active_room') || roomFromUrl();
    if (!savedRoom) return;
    socket.emit('room:join', {
      code: savedRoom,
      sessionId: storage.get('session_id'),
      token: storage.get('token') || authToken,
      name: currentUser?.name || 'Pemain'
    });
  };

  useEffect(() => {
    const onConnect = () => rejoinRef.current();
    socket.on('connect', onConnect);
    if (socket.connected) onConnect();
    return () => socket.off('connect', onConnect);
  }, [socket]);

  useEffect(() => {
    const handlers = {
      'room:joined': d => {
        seedEvents.current = true;
        setPlayerId(d.playerId);
        setCode(d.code);
        if (d.sessionId) storage.set('session_id', d.sessionId);
        storage.set('active_room', d.code);
        history.replaceState({}, '', `?room=${d.code}`);
        setScreen('room');
        setError('');
        if (d.reconnected) sound.playClick();
      },

      'room:update': updated => {
        if (seedEvents.current) {
          seedEvents.current = false;
          lastItemEventId.current = updated.lastItemEvent?.id ?? null;
          lastCaptureId.current = updated.lastCapture?.id ?? null;
          // Kembali ke room yang sudah selesai tidak perlu memutar ulang perayaan menang
          hasCelebrated.current = !!updated.winner;
        }
        setRoom(updated);

        if (updated.winner) {
          if (!hasCelebrated.current) {
            hasCelebrated.current = true;
            sound.playWin();
            triggerConfetti();
          }
        } else {
          hasCelebrated.current = false;
        }

        const me = updated.players?.find(p => p.id === playerIdRef.current);
        if (me?.isOut) storage.remove('active_room');
      },

      'room:chats': list => setChats(Array.isArray(list) ? list : []),

      'room:chat_message': msg => {
        setChats(prev => [...prev.slice(-49), msg]);
        if (msg.senderId === playerIdRef.current) return;
        sound.playChatNotification();
        if (!chatOpenRef.current) setUnreadChats(n => n + 1);
        setChatToast(msg);
        if (chatToastTimer.current) clearTimeout(chatToastTimer.current);
        chatToastTimer.current = setTimeout(() => setChatToast(null), 4200);
      },

      'room:reaction': reaction => {
        setReactions(prev => [...prev.slice(-8), reaction]);
        setTimeout(() => setReactions(prev => prev.filter(r => r.id !== reaction.id)), 2600);
      },

      'room:member_joined': data => {
        if (data.playerId === socket.id) return; // Notifikasi untuk diri sendiri tidak perlu
        sound.playJoinNotification();
        const id = Date.now() + Math.random();
        setMemberNotice({
          id,
          avatar: data.avatar || '🎲',
          text: data.reconnected ? `${data.name} kembali masuk` : `${data.name} bergabung ke room`
        });
        setTimeout(() => setMemberNotice(prev => (prev?.id === id ? null : prev)), 3500);
      },

      // Room dihapus server (mis. semua pemain OUT): kembali ke beranda dengan alasannya
      'room:closed': ({ reason } = {}) => {
        storage.remove('active_room', 'session_id');
        if (location.search.includes('room=')) history.replaceState({}, '', location.pathname);
        setCode('');
        resetRoomState();
        showError(reason || 'Room sudah ditutup.');
      },

      'room:error': err => {
        showError(err);
        if (err.includes('tab atau perangkat lain')) {
          // Sesi diambil alih tab lain: jangan hapus sesi tersimpan yang kini dipakai tab tersebut
          resetRoomState();
          return;
        }
        if (err.includes('tidak ditemukan') || err.includes('OUT') || err.includes('penuh')) {
          storage.remove('active_room');
          if (location.search.includes('room=')) {
            history.replaceState({}, '', location.pathname);
            setCode('');
          }
          // Room sudah tidak ada / tidak bisa dimasuki: jangan biarkan pemain di layar room yang basi
          resetRoomState();
        }
      }
    };

    for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);
    return () => {
      for (const [event, fn] of Object.entries(handlers)) socket.off(event, fn);
    };
  }, [socket, showError, resetRoomState]);

  // Pengumuman item ke semua pemain (perisai aktif, item dipakai)
  useEffect(() => {
    const event = room?.lastItemEvent;
    if (!event || event.id === lastItemEventId.current) return undefined;
    lastItemEventId.current = event.id;
    setItemNotice({ id: event.id, icon: event.icon, title: event.title, text: event.text });
    if (event.sound === 'thunder') sound.playThunder();
    else sound.playJoinNotification();
    const timer = setTimeout(() => setItemNotice(null), 5500);
    return () => clearTimeout(timer);
  }, [room?.lastItemEvent]);

  // Musik latar hanya berbunyi di dalam room
  useEffect(() => {
    sound.setInRoom(screen === 'room');
  }, [screen]);

  // ---------- Turunan state ----------

  const me = room?.players?.find(p => p.id === playerId) || null;
  const currentTurnPlayer = room?.players?.[room.turn] || null;
  const isTurn = !!currentTurnPlayer && currentTurnPlayer.id === playerId;
  const canAct = isTurn && room?.dice === null && !room?.rolling && !room?.animatingMove && !room?.pendingShield;

  // Bidak yang boleh dijalankan dihitung server (satu sumber aturan main)
  const movablePawns = useMemo(
    () => (isTurn && room?.dice !== null && !room?.animatingMove ? room?.movable || [] : []),
    [room, isTurn]
  );

  // Mode pilih target item batal otomatis saat giliran lewat atau dadu sudah dilempar
  useEffect(() => {
    if (!isTurn || room?.dice !== null) setItemTargeting(null);
  }, [isTurn, room?.dice]);

  // Notifikasi browser: giliran mengocok dadu. Jika giliran datang saat tab masih dilihat lalu pemain
  // pindah tab, notifikasi tetap dikirim saat tab disembunyikan (sekali per giliran).
  useEffect(() => {
    if (!canAct || room?.winner || me?.isOut) {
      turnNotified.current = false;
      return undefined;
    }
    const send = async () => {
      if (turnNotified.current) return;
      const res = await notify('🎲 Giliranmu!', {
        body: `Silahkan kocok dadu di room ${room?.code}. Jangan sampai giliranmu dijalankan otomatis.`,
        tag: `jakludo-turn-${room?.code}`
      });
      if (res.ok) turnNotified.current = true;
    };
    send();
    const onHide = () => { if (document.visibilityState === 'hidden') send(); };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('blur', send);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('blur', send);
    };
  }, [canAct, room?.winner, room?.code, me?.isOut]);

  // Notifikasi browser: ada bidak yang diinjak / dipulangkan ke markas
  useEffect(() => {
    const cap = room?.lastCapture;
    if (!cap || cap.id === lastCaptureId.current) return;
    lastCaptureId.current = cap.id;
    const myName = me?.name;
    const iAmDefender = cap.defenderId ? cap.defenderId === playerId : cap.defender === myName;
    const iAmAttacker = cap.attackerId ? cap.attackerId === playerId : cap.attacker === myName;
    const how = cap.isForceReturn ? 'memakai Force Return pada' : 'menginjak';
    let title = '⚔️ Bidak diinjak!';
    let body = `${cap.attacker} ${how} bidak ${cap.defender}. Bidaknya kembali ke markas.`;
    if (iAmDefender) {
      title = '😱 Bidakmu diinjak!';
      body = `${cap.attacker} ${how} bidakmu. Bidakmu kembali ke markas.`;
    } else if (iAmAttacker) {
      title = '🔥 Kamu menginjak bidak lawan!';
      body = `Bidak ${cap.defender} kembali ke markas.`;
    }
    notify(title, { body, tag: `jakludo-capture-${room?.code}` });
  }, [room?.lastCapture, room?.code, playerId, me?.name]);

  // ---------- Aksi ----------

  const requireLogin = () => {
    if (currentUser) return true;
    showError('Masuk atau daftar akun JakLudo dulu untuk bermain.');
    onNeedLogin?.();
    return false;
  };

  const createRoom = groupId => {
    if (!requireLogin()) return;
    sound.playClick();
    setError('');
    socket.emit('room:create', {
      name: currentUser.name,
      token: authToken,
      groupId: typeof groupId === 'string' && groupId ? groupId : undefined
    });
  };

  const joinRoom = targetCode => {
    if (!requireLogin()) return;
    const clean = String(targetCode || code || '').trim().toUpperCase();
    if (!clean) return showError('Kode room wajib diisi.');
    sound.playClick();
    setError('');
    socket.emit('room:join', { name: currentUser.name, token: authToken, sessionId: storage.get('session_id'), code: clean });
  };

  const leaveRoom = () => {
    sound.playClick();
    const currentCode = room?.code || code;
    storage.remove('active_room', 'session_id');
    if (currentCode) socket.emit('room:leave', { code: currentCode });
    resetRoomState();
    setCode('');
    setError('');
    history.replaceState({}, '', location.pathname);
  };

  const emitWithClick = (event, payload) => {
    sound.playClick();
    socket.emit(event, payload);
  };

  const movePawn = useCallback(pawnIdx => {
    socket.emit('game:move', { pawn: pawnIdx });
  }, [socket]);

  // Auto-move: jika hanya ada 1 bidak yang bisa jalan, jalankan otomatis
  useEffect(() => {
    if (!isTurn || room?.dice === null || room?.rolling || room?.animatingMove || movablePawns.length !== 1) return undefined;
    const timer = setTimeout(() => movePawn(movablePawns[0]), 380);
    return () => clearTimeout(timer);
  }, [isTurn, room?.dice, room?.rolling, room?.animatingMove, movablePawns, movePawn]);

  // Stabil (lewat ref) supaya papan yang di-memo tidak ikut render ulang tiap state lain berubah
  const itemTargetingRef = useRef(itemTargeting);
  itemTargetingRef.current = itemTargeting;
  const selectTarget = useCallback((targetPlayerId, targetPawnIdx) => {
    sound.playClick();
    if (!itemTargetingRef.current) return;
    socket.emit('game:use_item', { itemId: itemTargetingRef.current, target: { playerId: targetPlayerId, pawnIdx: targetPawnIdx } });
    setItemTargeting(null);
  }, [socket]);

  const actions = {
    createRoom,
    joinRoom,
    leaveRoom,
    setCode,
    addBot: () => emitWithClick('room:add_bot'),
    removeBot: () => emitWithClick('room:remove_bot'),
    toggleSafeZones: () => emitWithClick('room:update_settings', { safeZones: room?.settings?.safeZones === false }),
    toggleBlackHole: () => emitWithClick('room:update_settings', { blackHole: !room?.settings?.blackHole }),
    setBlackHoleMode: mode => emitWithClick('room:update_settings', { blackHoleMode: mode }),
    startGame: () => emitWithClick('game:start'),
    restartGame: () => emitWithClick('game:restart'),
    rollDice: () => socket.emit('game:roll'),
    movePawn,
    selectTarget,
    setItemTargeting,
    useItem: itemId => socket.emit('game:use_item', { itemId }),
    decideShield: use => emitWithClick('game:shield_decision', { use }),
    sendReaction: emoji => emitWithClick('game:reaction', { emoji }),
    sendChat: text => {
      const clean = String(text || '').trim();
      if (!clean) return false;
      emitWithClick('room:chat', { text: clean });
      return true;
    },
    setChatOpen: open => {
      chatOpenRef.current = open;
      if (open) setUnreadChats(0);
    },
    dismissChatToast: () => setChatToast(null),
    dismissItemNotice: () => setItemNotice(null)
  };

  return {
    socket,
    screen,
    code,
    room,
    playerId,
    me,
    currentTurnPlayer,
    isTurn,
    canAct,
    movablePawns,
    error,
    chats,
    unreadChats,
    chatToast,
    reactions,
    memberNotice,
    itemNotice,
    itemTargeting,
    actions
  };
}

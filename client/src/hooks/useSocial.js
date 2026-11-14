import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { storage } from '../storage';
import { sound } from '../sound';
import { notify } from '../notifications';
import {
  isAvatarUrl,
  uploadDirectMedia,
  uploadGroupAvatarMedia,
  uploadGroupMedia,
  uploadUserAvatar
} from '../social/media';

function formatMessageNotifBody(msg) {
  if (!msg) return 'Pesan baru';
  if (msg.type === 'image') return msg.text ? `📷 Foto: ${msg.text}` : '📷 Mengirim foto';
  if (msg.type === 'audio') return msg.text ? `🎙️ Pesan suara: ${msg.text}` : '🎙️ Mengirim pesan suara';
  if (msg.type === 'match') {
    const gameLabel = msg.match?.gameType === 'quiz' ? 'Monster Quiz Battle' : 'JakLudo';
    return `${msg.match?.gameType === 'quiz' ? '🐉' : '🎲'} Mengajak Match Grup ${gameLabel}! Kode room: ${msg.match?.code || ''}`;
  }
  return msg.text || 'Pesan baru';
}

// Hook fitur sosial: teman, chat private, grup, undangan grup, chat grup, avatar S3, dan notifikasi browser
export function useSocial({ socket, authToken, currentUser, onUpdateUser, onCropAvatar }) {
  const [friends, setFriends] = useState([]);
  const [incoming, setIncoming] = useState([]);
  const [outgoing, setOutgoing] = useState([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [unreadDmByFriend, setUnreadDmByFriend] = useState({});

  const [groups, setGroups] = useState([]);
  const [groupInvites, setGroupInvites] = useState([]);
  const [mediaEnabled, setMediaEnabled] = useState(false);
  const [groupsLoading, setGroupsLoading] = useState(false);

  const [roomInvite, setRoomInvite] = useState(null);

  const tokenRef = useRef(authToken);
  tokenRef.current = authToken;
  const userRef = useRef(currentUser);
  userRef.current = currentUser;
  const onUpdateUserRef = useRef(onUpdateUser);
  onUpdateUserRef.current = onUpdateUser;
  const onCropAvatarRef = useRef(onCropAvatar);
  onCropAvatarRef.current = onCropAvatar;
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const activeDmFriendIdRef = useRef('');

  const hadTokenRef = useRef(false);
  const roomInviteTimerRef = useRef(null);
  const groupListenersRef = useRef(new Set());
  const friendsFetchRef = useRef(null);
  const groupsFetchRef = useRef(null);

  const getToken = useCallback(() => tokenRef.current || storage.get('token') || '', []);

  const apiFetch = useCallback(async (url, options = {}) => {
    const token = getToken();
    const headers = {
      ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    };
    let res;
    try {
      res = await fetch(url, { ...options, headers });
    } catch {
      throw new Error('Gagal terhubung ke server. Pastikan server backend (npm run dev) sedang berjalan.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.success) {
      throw new Error(data?.error || 'Permintaan gagal. Periksa koneksi lalu coba lagi.');
    }
    return data;
  }, [getToken]);

  const loadFriends = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setFriends([]);
      setIncoming([]);
      setOutgoing([]);
      return;
    }
    if (friendsFetchRef.current) return friendsFetchRef.current;
    setFriendsLoading(true);
    const promise = (async () => {
      try {
        const data = await apiFetch('/api/friends');
        setFriends(Array.isArray(data.friends) ? data.friends : []);
        setIncoming(Array.isArray(data.incoming) ? data.incoming : []);
        setOutgoing(Array.isArray(data.outgoing) ? data.outgoing : []);
      } catch {
        // Abaikan error pemuatan latar belakang
      } finally {
        friendsFetchRef.current = null;
        setFriendsLoading(false);
      }
    })();
    friendsFetchRef.current = promise;
    return promise;
  }, [apiFetch, getToken]);

  const loadGroups = useCallback(async () => {
    const token = getToken();
    if (!token) {
      setGroups([]);
      setGroupInvites([]);
      return;
    }
    if (groupsFetchRef.current) return groupsFetchRef.current;
    setGroupsLoading(true);
    const promise = (async () => {
      try {
        const [groupsRes, invitesRes] = await Promise.all([
          apiFetch('/api/groups'),
          apiFetch('/api/group-invites')
        ]);
        setGroups(Array.isArray(groupsRes.groups) ? groupsRes.groups : []);
        setMediaEnabled(Boolean(groupsRes.mediaEnabled));
        setGroupInvites(Array.isArray(invitesRes.invites) ? invitesRes.invites : []);
      } catch {
        // Abaikan error pemuatan latar belakang
      } finally {
        groupsFetchRef.current = null;
        setGroupsLoading(false);
      }
    })();
    groupsFetchRef.current = promise;
    return promise;
  }, [apiFetch, getToken]);

  // Identifikasi socket setiap kali tersambung atau token berubah, dan kirim social:logout saat keluar
  useEffect(() => {
    if (!socket) return undefined;

    const identify = () => {
      const token = tokenRef.current;
      if (token) {
        socket.emit('social:identify', { token });
      }
    };

    if (authToken) {
      hadTokenRef.current = true;
      if (socket.connected) identify();
      loadFriends();
      loadGroups();
    } else {
      if (hadTokenRef.current && socket.connected) {
        socket.emit('social:logout');
      }
      hadTokenRef.current = false;
      setFriends([]);
      setIncoming([]);
      setOutgoing([]);
      setUnreadDmByFriend({});
      setGroups([]);
      setGroupInvites([]);
      setRoomInvite(null);
    }

    socket.on('connect', identify);
    return () => {
      socket.off('connect', identify);
    };
  }, [socket, authToken, loadFriends, loadGroups]);

  const emitGroupEvent = useCallback((event, payload) => {
    groupListenersRef.current.forEach(fn => {
      try {
        fn(event, payload);
      } catch (err) {
        console.error('Social listener error:', err);
      }
    });
  }, []);

  // Pasang listener event socket sosial & notifikasi browser
  useEffect(() => {
    if (!socket) return undefined;

    const onSocialSync = payload => {
      if (!payload) return;
      if (Array.isArray(payload.friends)) setFriends(payload.friends);
      if (Array.isArray(payload.incoming)) setIncoming(payload.incoming);
      if (Array.isArray(payload.outgoing)) setOutgoing(payload.outgoing);
      if (Array.isArray(payload.groups)) setGroups(payload.groups);
      if (typeof payload.mediaEnabled === 'boolean') setMediaEnabled(payload.mediaEnabled);
      if (Array.isArray(payload.invites)) setGroupInvites(payload.invites);
    };

    const onFriendsChanged = payload => {
      if (payload && Array.isArray(payload.friends)) {
        setFriends(payload.friends);
        if (Array.isArray(payload.incoming)) setIncoming(payload.incoming);
        if (Array.isArray(payload.outgoing)) setOutgoing(payload.outgoing);
      } else {
        loadFriends();
      }
    };

    const onFriendRequest = payload => {
      const from = payload?.from;
      if (!from || from.userId === userRef.current?.id) return;
      sound.playJoinNotification();
      notify('👋 Permintaan Pertemanan Baru', {
        body: `${from.name} (@${from.username}) ingin berteman denganmu di JakLudo.`,
        tag: `jakludo-freq-${from.userId}`,
        icon: isAvatarUrl(from.avatar) ? from.avatar : undefined,
        force: true
      });
    };

    const onFriendAccepted = payload => {
      const by = payload?.by;
      if (!by || by.userId === userRef.current?.id) return;
      sound.playJoinNotification();
      notify('🤝 Pertemanan Diterima!', {
        body: `${by.name} (@${by.username}) menerima permintaan pertemananmu. Yuk sapa lewat chat!`,
        tag: `jakludo-facc-${by.userId}`,
        icon: isAvatarUrl(by.avatar) ? by.avatar : undefined,
        force: true
      });
    };

    const onDmMessage = message => {
      if (!message?.id) return;
      const myId = userRef.current?.id;
      const otherId = message.senderId === myId ? message.recipientId : message.senderId;

      setFriends(prev =>
        prev.map(f =>
          f.userId === otherId
            ? {
                ...f,
                lastMessage: {
                  id: message.id,
                  senderId: message.senderId,
                  type: message.type,
                  text: message.text || '',
                  createdAt: message.createdAt
                }
              }
            : f
        )
      );

      if (message.senderId && message.senderId !== myId) {
        sound.playChatNotification();
        if (activeDmFriendIdRef.current !== message.senderId) {
          setUnreadDmByFriend(prev => ({
            ...prev,
            [message.senderId]: (prev[message.senderId] || 0) + 1
          }));
        }
        notify(`💬 ${message.sender?.name || 'Teman'} (@${message.sender?.username || 'teman'})`, {
          body: formatMessageNotifBody(message),
          tag: `jakludo-dm-${message.senderId}`,
          icon: isAvatarUrl(message.sender?.avatar) ? message.sender.avatar : undefined,
          force: true
        });
      }

      emitGroupEvent('dm:message', message);
    };

    const onGroupsChanged = payload => {
      if (payload && Array.isArray(payload.groups)) {
        setGroups(payload.groups);
        if (typeof payload.mediaEnabled === 'boolean') setMediaEnabled(payload.mediaEnabled);
        if (Array.isArray(payload.invites)) setGroupInvites(payload.invites);
      } else {
        loadGroups();
      }
    };

    const onGroupInvite = payload => {
      const inv = payload?.invite;
      if (!inv?.group || !inv?.inviter) return;
      sound.playJoinNotification();
      notify('📩 Undangan Grup Baru', {
        body: `${inv.inviter.name} (@${inv.inviter.username}) mengundangmu ke grup "${inv.group.name}".`,
        tag: `jakludo-ginv-${inv.id}`,
        icon: isAvatarUrl(inv.inviter.avatar) ? inv.inviter.avatar : undefined,
        force: true
      });
    };

    const onGroupMessage = message => {
      if (!message?.groupId) return;
      setGroups(prev =>
        prev.map(g => (g.id === message.groupId ? { ...g, lastMessage: message } : g))
      );
      if (message.sender?.userId && message.sender.userId !== userRef.current?.id) {
        sound.playChatNotification();
        const grp = groupsRef.current.find(g => g.id === message.groupId);
        const groupTitle = grp?.name ? `Grup ${grp.name}` : 'Chat Grup';
        notify(
          message.type === 'system'
            ? `👥 ${groupTitle}`
            : `👥 ${groupTitle} · ${message.sender.name}`,
          {
            body: formatMessageNotifBody(message),
            tag: `jakludo-gmsg-${message.groupId}`,
            icon: isAvatarUrl(message.sender.avatar) ? message.sender.avatar : undefined,
            force: true
          }
        );
      }
      emitGroupEvent('group:message', message);
    };

    const onGroupUpdated = payload => {
      loadGroups();
      emitGroupEvent('group:updated', payload);
    };

    const onGroupRemoved = payload => {
      loadGroups();
      emitGroupEvent('group:removed', payload);
    };

    const onGroupLeaderboard = payload => {
      emitGroupEvent('group:leaderboard', payload);
    };

    const onGlobalLeaderboard = payload => {
      emitGroupEvent('leaderboard:update', payload);
    };

    const onRoomInvite = payload => {
      if (!payload?.code) return;
      sound.playJoinNotification();
      const gameType = payload.gameType === 'quiz' ? 'quiz' : 'ludo';
      const gameName = gameType === 'quiz' ? 'Monster Quiz Battle' : 'JakLudo';
      const invite = {
        id: Date.now() + Math.random(),
        code: payload.code,
        gameType,
        gameName,
        from: payload.from || null,
        group: payload.group || null
      };
      setRoomInvite(invite);
      if (roomInviteTimerRef.current) clearTimeout(roomInviteTimerRef.current);
      roomInviteTimerRef.current = setTimeout(() => {
        setRoomInvite(prev => (prev?.id === invite.id ? null : prev));
      }, 15000);

      notify(`${gameType === 'quiz' ? '🐉' : '🎲'} Undangan Bermain ${gameName}!`, {
        body: `${payload.from?.name || 'Teman'} mengundangmu masuk ke room ${payload.code}${
          payload.group?.name ? ` (Match Grup ${payload.group.name})` : ''
        }.`,
        tag: `jakludo-rinv-${payload.code}`,
        icon: isAvatarUrl(payload.from?.avatar) ? payload.from.avatar : undefined,
        force: true
      });
    };

    socket.on('social:sync', onSocialSync);
    socket.on('friends:changed', onFriendsChanged);
    socket.on('friend:request', onFriendRequest);
    socket.on('friend:accepted', onFriendAccepted);
    socket.on('dm:message', onDmMessage);
    socket.on('groups:changed', onGroupsChanged);
    socket.on('group:invite', onGroupInvite);
    socket.on('group:message', onGroupMessage);
    socket.on('group:updated', onGroupUpdated);
    socket.on('group:removed', onGroupRemoved);
    socket.on('group:leaderboard', onGroupLeaderboard);
    socket.on('leaderboard:update', onGlobalLeaderboard);
    socket.on('room:invite', onRoomInvite);

    return () => {
      socket.off('social:sync', onSocialSync);
      socket.off('friends:changed', onFriendsChanged);
      socket.off('friend:request', onFriendRequest);
      socket.off('friend:accepted', onFriendAccepted);
      socket.off('dm:message', onDmMessage);
      socket.off('groups:changed', onGroupsChanged);
      socket.off('group:invite', onGroupInvite);
      socket.off('group:message', onGroupMessage);
      socket.off('group:updated', onGroupUpdated);
      socket.off('group:removed', onGroupRemoved);
      socket.off('group:leaderboard', onGroupLeaderboard);
      socket.off('leaderboard:update', onGlobalLeaderboard);
      socket.off('room:invite', onRoomInvite);
    };
  }, [socket, loadFriends, loadGroups, emitGroupEvent]);

  // ---------- Aksi Teman & Chat Private ----------

  const sendFriendRequest = useCallback(async username => {
    const clean = String(username || '').trim().replace(/^@/, '');
    if (!clean) throw new Error('Username wajib diisi.');
    const data = await apiFetch('/api/friends/request', {
      method: 'POST',
      body: JSON.stringify({ username: clean })
    });
    await loadFriends();
    return data;
  }, [apiFetch, loadFriends]);

  const acceptFriendRequest = useCallback(async userId => {
    await apiFetch(`/api/friends/${encodeURIComponent(userId)}/accept`, { method: 'POST' });
    await loadFriends();
  }, [apiFetch, loadFriends]);

  const removeFriend = useCallback(async userId => {
    await apiFetch(`/api/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    await loadFriends();
  }, [apiFetch, loadFriends]);

  const setActiveDmFriend = useCallback(friendId => {
    const clean = String(friendId || '');
    activeDmFriendIdRef.current = clean;
    if (clean) {
      setUnreadDmByFriend(prev => {
        if (!prev[clean]) return prev;
        const next = { ...prev };
        delete next[clean];
        return next;
      });
    }
  }, []);

  const getDirectMessages = useCallback(async (friendId, before = '', limit = 30) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    const data = await apiFetch(
      `/api/friends/${encodeURIComponent(friendId)}/messages?${params.toString()}`
    );
    if (typeof data.mediaEnabled === 'boolean') setMediaEnabled(data.mediaEnabled);
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      hasMore: Boolean(data.hasMore)
    };
  }, [apiFetch]);

  const sendDirectMessage = useCallback(async (friendId, text, replyToId = null) => {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Pesan tidak boleh kosong.');
    if (clean.length > 1000) throw new Error('Pesan maksimal 1000 karakter.');
    const resolvedReplyId =
      replyToId && typeof replyToId === 'object' ? replyToId.replyToId || replyToId.id || null : replyToId;
    const payload = resolvedReplyId ? { text: clean, replyToId: resolvedReplyId } : { text: clean };
    const data = await apiFetch(`/api/friends/${encodeURIComponent(friendId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return data.message;
  }, [apiFetch]);

  const sendDirectMedia = useCallback(async (friendId, { file, kind, durationMs, text, replyToId = null }) => {
    return uploadDirectMedia({
      friendId,
      token: getToken(),
      file,
      kind,
      durationMs,
      text,
      replyToId
    });
  }, [getToken]);

  const uploadAvatar = useCallback(async file => {
    let targetFile = file;
    let preCropped = false;
    if (onCropAvatarRef.current) {
      targetFile = await onCropAvatarRef.current({
        file,
        title: 'Potong foto profil',
        subtitle: 'Geser, perbesar, atau putar foto sebelum diterapkan sebagai avatar.'
      });
      if (!targetFile) return null;
      preCropped = true;
    }
    const token = getToken();
    const updatedUser = await uploadUserAvatar({
      token,
      file: targetFile,
      preCropped
    });
    if (updatedUser && onUpdateUserRef.current) {
      onUpdateUserRef.current(updatedUser);
    }
    if (socket?.connected && token) {
      socket.emit('room:sync_profile', { token });
    }
    return updatedUser;
  }, [getToken, socket]);

  const getUserProfile = useCallback(async userIdOrUsername => {
    const clean = String(userIdOrUsername || '').trim();
    if (!clean) throw new Error('Pemain tidak ditemukan.');
    const data = await apiFetch(`/api/users/${encodeURIComponent(clean)}/profile`);
    return data.profile;
  }, [apiFetch]);

  const uploadGroupAvatar = useCallback(async (groupId, file) => {
    let targetFile = file;
    let preCropped = false;
    if (onCropAvatarRef.current) {
      targetFile = await onCropAvatarRef.current({
        file,
        title: 'Potong foto ava grup',
        subtitle: 'Geser, perbesar, atau putar foto sebelum diterapkan ke grup.'
      });
      if (!targetFile) return null;
      preCropped = true;
    }
    const updatedGroup = await uploadGroupAvatarMedia({
      groupId,
      token: getToken(),
      file: targetFile,
      preCropped
    });
    await loadGroups();
    return updatedGroup;
  }, [getToken, loadGroups]);

  // ---------- Aksi Grup ----------

  const createGroup = useCallback(async name => {
    const clean = String(name || '').trim();
    if (clean.length < 3 || clean.length > 40) {
      throw new Error('Nama grup harus 3 sampai 40 karakter.');
    }
    const data = await apiFetch('/api/groups', {
      method: 'POST',
      body: JSON.stringify({ name: clean })
    });
    await loadGroups();
    return data.group;
  }, [apiFetch, loadGroups]);

  const getGroup = useCallback(async groupId => {
    const data = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}`);
    return data.group;
  }, [apiFetch]);

  const renameGroup = useCallback(async (groupId, name) => {
    const clean = String(name || '').trim();
    if (clean.length < 3 || clean.length > 40) {
      throw new Error('Nama grup harus 3 sampai 40 karakter.');
    }
    const data = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: clean })
    });
    await loadGroups();
    return data.group;
  }, [apiFetch, loadGroups]);

  const deleteGroup = useCallback(async groupId => {
    await apiFetch(`/api/groups/${encodeURIComponent(groupId)}`, { method: 'DELETE' });
    await loadGroups();
  }, [apiFetch, loadGroups]);

  const inviteToGroup = useCallback(async (groupId, username) => {
    const clean = String(username || '').trim().replace(/^@/, '');
    if (!clean) throw new Error('Username wajib diisi.');
    const data = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}/invites`, {
      method: 'POST',
      body: JSON.stringify({ username: clean })
    });
    return data.invite;
  }, [apiFetch]);

  const acceptGroupInvite = useCallback(async inviteId => {
    const data = await apiFetch(`/api/group-invites/${encodeURIComponent(inviteId)}/accept`, {
      method: 'POST'
    });
    await loadGroups();
    return data.group;
  }, [apiFetch, loadGroups]);

  const declineGroupInvite = useCallback(async inviteId => {
    await apiFetch(`/api/group-invites/${encodeURIComponent(inviteId)}/decline`, {
      method: 'POST'
    });
    await loadGroups();
  }, [apiFetch, loadGroups]);

  const setMemberRole = useCallback(async (groupId, userId, role) => {
    const data = await apiFetch(
      `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ role })
      }
    );
    return data.group;
  }, [apiFetch]);

  const removeMember = useCallback(async (groupId, userId) => {
    await apiFetch(
      `/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
      { method: 'DELETE' }
    );
    await loadGroups();
  }, [apiFetch, loadGroups]);

  const getMessages = useCallback(async (groupId, before = '', limit = 30) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (before) params.set('before', before);
    const data = await apiFetch(
      `/api/groups/${encodeURIComponent(groupId)}/messages?${params.toString()}`
    );
    return {
      messages: Array.isArray(data.messages) ? data.messages : [],
      hasMore: Boolean(data.hasMore)
    };
  }, [apiFetch]);

  const sendMessage = useCallback(async (groupId, text, replyToId = null) => {
    const clean = String(text || '').trim();
    if (!clean) throw new Error('Pesan tidak boleh kosong.');
    if (clean.length > 1000) throw new Error('Pesan maksimal 1000 karakter.');
    const resolvedReplyId =
      replyToId && typeof replyToId === 'object' ? replyToId.replyToId || replyToId.id || null : replyToId;
    const payload = resolvedReplyId ? { text: clean, replyToId: resolvedReplyId } : { text: clean };
    const data = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}/messages`, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    return data.message;
  }, [apiFetch]);

  const sendMedia = useCallback(async (groupId, { file, kind, durationMs, text, replyToId = null }) => {
    return uploadGroupMedia({
      groupId,
      token: getToken(),
      file,
      kind,
      durationMs,
      text,
      replyToId
    });
  }, [getToken]);

  const getGroupLeaderboard = useCallback(async groupId => {
    const data = await apiFetch(`/api/groups/${encodeURIComponent(groupId)}/leaderboard`);
    return Array.isArray(data.leaderboard) ? data.leaderboard : [];
  }, [apiFetch]);

  // ---------- Undangan Room ----------

  const inviteToRoom = useCallback(userId => {
    return new Promise((resolve, reject) => {
      if (!socket || !socket.connected) {
        reject(new Error('Koneksi terputus. Coba lagi sebentar.'));
        return;
      }
      socket.emit('room:invite', { userId }, res => {
        if (res?.ok) resolve(res);
        else reject(new Error(res?.error || 'Gagal mengirim undangan.'));
      });
    });
  }, [socket]);

  const dismissRoomInvite = useCallback(() => {
    if (roomInviteTimerRef.current) clearTimeout(roomInviteTimerRef.current);
    setRoomInvite(null);
  }, []);

  const subscribeGroupEvents = useCallback(listener => {
    groupListenersRef.current.add(listener);
    return () => groupListenersRef.current.delete(listener);
  }, []);

  const totalUnreadDm = useMemo(
    () => Object.values(unreadDmByFriend).reduce((acc, n) => acc + Number(n || 0), 0),
    [unreadDmByFriend]
  );

  const actions = useMemo(
    () => ({
      getToken,
      reloadFriends: loadFriends,
      reloadGroups: loadGroups,
      sendFriendRequest,
      acceptFriendRequest,
      removeFriend,
      setActiveDmFriend,
      getDirectMessages,
      sendDirectMessage,
      sendDirectMedia,
      uploadAvatar,
      getUserProfile,
      uploadGroupAvatar,
      createGroup,
      getGroup,
      renameGroup,
      deleteGroup,
      inviteToGroup,
      acceptGroupInvite,
      declineGroupInvite,
      setMemberRole,
      removeMember,
      getMessages,
      sendMessage,
      sendMedia,
      getGroupLeaderboard,
      inviteToRoom,
      dismissRoomInvite
    }),
    [
      getToken,
      loadFriends,
      loadGroups,
      sendFriendRequest,
      acceptFriendRequest,
      removeFriend,
      setActiveDmFriend,
      getDirectMessages,
      sendDirectMessage,
      sendDirectMedia,
      uploadAvatar,
      getUserProfile,
      uploadGroupAvatar,
      createGroup,
      getGroup,
      renameGroup,
      deleteGroup,
      inviteToGroup,
      acceptGroupInvite,
      declineGroupInvite,
      setMemberRole,
      removeMember,
      getMessages,
      sendMessage,
      sendMedia,
      getGroupLeaderboard,
      inviteToRoom,
      dismissRoomInvite
    ]
  );

  return {
    friends,
    incoming,
    outgoing,
    friendsLoading,
    unreadDmByFriend,
    totalUnreadDm,
    groups,
    groupInvites,
    mediaEnabled,
    groupsLoading,
    roomInvite,
    friendBadgeCount: incoming.length + totalUnreadDm,
    groupBadgeCount: groupInvites.length,
    subscribeGroupEvents,
    actions
  };
}

// Penyimpanan & logika fitur sosial: pertemanan, grup, undangan grup, chat (teks, foto, voice note, match),
// dan query leaderboard per anggota grup dari tabel leaderboard tunggal. Terintegrasi dengan PostgreSQL & MinIO S3.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const storage = require('../lib/storage');
const media = require('../lib/media');

const LOCAL_SOCIAL_FILE = path.join(db.DATA_DIR, 'jakludo-social.json');

const state = {
  friendships: new Map(),      // "low:high" -> { userLow, userHigh, requesterId, status, createdAt, updatedAt }
  directMessages: new Map(),   // "low:high" -> Array<dmRow> (urut lama -> baru)
  groups: new Map(),           // groupId -> { id, name, ownerId, createdAt }
  groupMembers: new Map(),     // groupId -> Map<userId, { groupId, userId, role, joinedAt }>
  groupInvites: new Map(),     // inviteId -> { id, groupId, inviterId, inviteeId, createdAt }
  groupMessages: new Map()     // groupId -> Array<msgRow> (urut lama -> baru)
};

// Kehadiran online per userId -> Set<socketId>
const onlineSockets = new Map();
// Cache audio MP3 siap putar di memori (maks 30 pesan terakhir) agar playback cepat & mendukung Range request
const audioPlayCache = new Map();
// Cache buffer avatar di memori (maks 100 avatar) agar pemuatan foto profil instan
const avatarBufferCache = new Map();

function pairKey(a, b) {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function pairOrder(a, b) {
  return a < b ? [a, b] : [b, a];
}

function persistLocalSocial() {
  if (db.getPool()) return;
  try {
    const dump = {
      friendships: Array.from(state.friendships.values()),
      directMessages: Array.from(state.directMessages.values()).flat(),
      groups: Array.from(state.groups.values()),
      groupMembers: Array.from(state.groupMembers.values()).flatMap(m => Array.from(m.values())),
      groupInvites: Array.from(state.groupInvites.values()),
      groupMessages: Array.from(state.groupMessages.values()).flat()
    };
    fs.writeFileSync(LOCAL_SOCIAL_FILE, JSON.stringify(dump));
  } catch (err) {
    console.error('[SOCIAL LOCAL]', err.message);
  }
}

function bootstrapLocalSocial() {
  if (!fs.existsSync(LOCAL_SOCIAL_FILE)) return;
  try {
    const dump = JSON.parse(fs.readFileSync(LOCAL_SOCIAL_FILE, 'utf8'));
    for (const f of dump.friendships || []) {
      state.friendships.set(pairKey(f.userLow, f.userHigh), f);
    }
    for (const dm of dump.directMessages || []) {
      const pk = dm.pairKey || pairKey(dm.senderId, dm.recipientId);
      if (!state.directMessages.has(pk)) state.directMessages.set(pk, []);
      state.directMessages.get(pk).push(dm);
    }
    for (const list of state.directMessages.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
    for (const g of dump.groups || []) {
      state.groups.set(g.id, g);
      if (!state.groupMembers.has(g.id)) state.groupMembers.set(g.id, new Map());
      if (!state.groupMessages.has(g.id)) state.groupMessages.set(g.id, []);
    }
    for (const m of dump.groupMembers || []) {
      if (!state.groupMembers.has(m.groupId)) state.groupMembers.set(m.groupId, new Map());
      state.groupMembers.get(m.groupId).set(m.userId, m);
    }
    for (const inv of dump.groupInvites || []) {
      state.groupInvites.set(inv.id, inv);
    }
    for (const msg of dump.groupMessages || []) {
      if (!state.groupMessages.has(msg.groupId)) state.groupMessages.set(msg.groupId, []);
      state.groupMessages.get(msg.groupId).push(msg);
    }
    for (const list of state.groupMessages.values()) {
      list.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    }
  } catch {
    // Abaikan jika gagal dibaca
  }
}

bootstrapLocalSocial();

async function hydrateFromPostgres() {
  const pool = db.getPool();
  if (!pool) return;

  state.friendships.clear();
  state.directMessages.clear();
  state.groups.clear();
  state.groupMembers.clear();
  state.groupInvites.clear();
  state.groupMessages.clear();

  const [friendsRes, dmRes, groupsRes, membersRes, invitesRes, msgsRes] = await Promise.all([
    pool.query('SELECT * FROM friendships'),
    pool.query('SELECT * FROM direct_messages ORDER BY created_at ASC, id ASC'),
    pool.query('SELECT * FROM groups'),
    pool.query('SELECT * FROM group_members'),
    pool.query('SELECT * FROM group_invites'),
    pool.query('SELECT * FROM group_messages ORDER BY created_at ASC, id ASC')
  ]);

  for (const r of friendsRes.rows) {
    state.friendships.set(pairKey(r.user_low, r.user_high), {
      userLow: r.user_low,
      userHigh: r.user_high,
      requesterId: r.requester_id,
      status: r.status,
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    });
  }
  for (const r of dmRes.rows) {
    const pk = r.pair_key || pairKey(r.sender_id, r.recipient_id);
    if (!state.directMessages.has(pk)) state.directMessages.set(pk, []);
    state.directMessages.get(pk).push({
      id: r.id,
      pairKey: pk,
      senderId: r.sender_id,
      recipientId: r.recipient_id,
      type: r.type,
      text: r.text || '',
      mediaKey: r.media_key || null,
      mediaMime: r.media_mime || null,
      mediaSize: r.media_size ? Number(r.media_size) : null,
      mediaWidth: r.media_width ? Number(r.media_width) : null,
      mediaHeight: r.media_height ? Number(r.media_height) : null,
      mediaDurationMs: r.media_duration_ms ? Number(r.media_duration_ms) : null,
      replyToId: r.reply_to_id || null,
      createdAt: Number(r.created_at)
    });
  }
  for (const r of groupsRes.rows) {
    state.groups.set(r.id, {
      id: r.id,
      name: r.name,
      ownerId: r.owner_id,
      avatar: r.avatar || null,
      createdAt: Number(r.created_at)
    });
    state.groupMembers.set(r.id, new Map());
    state.groupMessages.set(r.id, []);
  }
  for (const r of membersRes.rows) {
    if (!state.groupMembers.has(r.group_id)) state.groupMembers.set(r.group_id, new Map());
    state.groupMembers.get(r.group_id).set(r.user_id, {
      groupId: r.group_id,
      userId: r.user_id,
      role: r.role,
      joinedAt: Number(r.joined_at)
    });
  }
  for (const r of invitesRes.rows) {
    state.groupInvites.set(r.id, {
      id: r.id,
      groupId: r.group_id,
      inviterId: r.inviter_id,
      inviteeId: r.invitee_id,
      createdAt: Number(r.created_at)
    });
  }
  for (const r of msgsRes.rows) {
    if (!state.groupMessages.has(r.group_id)) state.groupMessages.set(r.group_id, []);
    state.groupMessages.get(r.group_id).push({
      id: r.id,
      groupId: r.group_id,
      senderId: r.sender_id || null,
      type: r.type,
      text: r.text || '',
      mediaKey: r.media_key || null,
      mediaMime: r.media_mime || null,
      mediaSize: r.media_size ? Number(r.media_size) : null,
      mediaWidth: r.media_width ? Number(r.media_width) : null,
      mediaHeight: r.media_height ? Number(r.media_height) : null,
      mediaDurationMs: r.media_duration_ms ? Number(r.media_duration_ms) : null,
      matchCode: r.match_code || null,
      replyToId: r.reply_to_id || null,
      createdAt: Number(r.created_at)
    });
  }
}

// ==========================================
// KEHADIRAN ONLINE & ROOM SOCKET.IO
// ==========================================

function getIo() {
  const gameStore = require('../game/store');
  return gameStore.getIo();
}

function isUserOnline(userId) {
  const set = onlineSockets.get(userId);
  return Boolean(set && set.size > 0);
}

function userSummary(userId) {
  if (!userId) return null;
  const u = db.getUserById(userId);
  if (!u) return null;
  return {
    userId: u.id,
    username: u.username,
    name: u.name,
    avatar: u.avatar || '🎯',
    online: isUserOnline(u.id)
  };
}

function emitToUser(userId, event, payload = {}) {
  const io = getIo();
  if (!io || !userId) return;
  if (event === 'friends:changed' && (!payload || Object.keys(payload).length === 0)) {
    io.to(`user:${userId}`).emit(event, listFriends(userId));
    return;
  }
  if (event === 'groups:changed' && (!payload || Object.keys(payload).length === 0)) {
    Promise.resolve(listUserGroups(userId))
      .then(grpData => {
        const invData = listUserGroupInvites(userId);
        io.to(`user:${userId}`).emit(event, { ...grpData, ...invData });
      })
      .catch(() => {
        io.to(`user:${userId}`).emit(event, {});
      });
    return;
  }
  io.to(`user:${userId}`).emit(event, payload);
}

function emitToGroup(groupId, event, payload = {}) {
  const io = getIo();
  if (!io || !groupId) return;
  if (event === 'groups:changed' && (!payload || Object.keys(payload).length === 0)) {
    const members = state.groupMembers.get(groupId);
    if (members) {
      for (const uid of members.keys()) {
        emitToUser(uid, 'groups:changed');
      }
    }
    return;
  }
  io.to(`group:${groupId}`).emit(event, payload);
}

function joinUserSocketsToGroup(userId, groupId) {
  const io = getIo();
  const sockets = onlineSockets.get(userId);
  if (!io || !sockets) return;
  for (const sid of sockets) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.join(`group:${groupId}`);
  }
}

function leaveUserSocketsFromGroup(userId, groupId) {
  const io = getIo();
  const sockets = onlineSockets.get(userId);
  if (!io || !sockets) return;
  for (const sid of sockets) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) sock.leave(`group:${groupId}`);
  }
}

function notifyAcceptedFriendsPresence(userId) {
  for (const f of state.friendships.values()) {
    if (f.status !== 'accepted') continue;
    if (f.userLow === userId) emitToUser(f.userHigh, 'friends:changed');
    else if (f.userHigh === userId) emitToUser(f.userLow, 'friends:changed');
  }
}

function identifySocket(socket, token) {
  const user = typeof token === 'string' ? db.getUserByToken(token) : null;
  if (!user) return null;

  if (socket.data.userId && socket.data.userId !== user.id) {
    detachSocket(socket);
  }

  const wasOnline = isUserOnline(user.id);
  socket.data.userId = user.id;
  if (!onlineSockets.has(user.id)) onlineSockets.set(user.id, new Set());
  onlineSockets.get(user.id).add(socket.id);

  socket.join(`user:${user.id}`);
  for (const [groupId, members] of state.groupMembers.entries()) {
    if (members.has(user.id)) socket.join(`group:${groupId}`);
  }

  if (!wasOnline) notifyAcceptedFriendsPresence(user.id);

  // Kirim snapshot awal via WebSocket agar klien tidak perlu spam HTTP fetch
  Promise.resolve(listUserGroups(user.id))
    .then(grpData => {
      socket.emit('social:sync', {
        ...listFriends(user.id),
        ...grpData,
        ...listUserGroupInvites(user.id)
      });
    })
    .catch(() => {});

  return user;
}

function detachSocket(socket) {
  const userId = socket.data?.userId;
  if (!userId) return;

  socket.leave(`user:${userId}`);
  for (const groupId of state.groupMembers.keys()) {
    socket.leave(`group:${groupId}`);
  }
  delete socket.data.userId;

  const set = onlineSockets.get(userId);
  if (set) {
    set.delete(socket.id);
    if (set.size === 0) {
      onlineSockets.delete(userId);
      notifyAcceptedFriendsPresence(userId);
    }
  }
}

// ==========================================
// PERTEMANAN (FRIENDS)
// ==========================================

function areFriends(userA, userB) {
  if (!userA || !userB || userA === userB) return false;
  const f = state.friendships.get(pairKey(userA, userB));
  return Boolean(f && f.status === 'accepted');
}

function listFriends(userId) {
  const friends = [];
  const incoming = [];
  const outgoing = [];

  for (const f of state.friendships.values()) {
    if (f.userLow !== userId && f.userHigh !== userId) continue;
    const otherId = f.userLow === userId ? f.userHigh : f.userLow;
    const summary = userSummary(otherId);
    if (!summary) continue;

    if (f.status === 'accepted') {
      const dmList = state.directMessages.get(pairKey(userId, otherId)) || [];
      const lastRaw = dmList.length > 0 ? dmList[dmList.length - 1] : null;
      const lastMessage = lastRaw
        ? {
            id: lastRaw.id,
            senderId: lastRaw.senderId,
            type: lastRaw.type,
            text: lastRaw.text || '',
            createdAt: new Date(lastRaw.createdAt).toISOString()
          }
        : null;
      friends.push({ ...summary, lastMessage });
    } else if (f.requesterId === userId) {
      outgoing.push({ ...summary, requestedAt: new Date(f.createdAt).toISOString() });
    } else {
      incoming.push({ ...summary, requestedAt: new Date(f.createdAt).toISOString() });
    }
  }

  friends.sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
  return { friends, incoming, outgoing };
}

function requestFriend(userId, rawUsername) {
  const clean = String(rawUsername || '').trim().replace(/^@/, '');
  if (!clean) return { error: 'Username teman wajib diisi.' };

  const target = db.getUserByUsername(clean);
  if (!target) return { error: `Pengguna @${clean} tidak ditemukan.` };
  if (target.id === userId) return { error: 'Tidak bisa menambahkan diri sendiri sebagai teman.' };

  const [userLow, userHigh] = pairOrder(userId, target.id);
  const key = `${userLow}:${userHigh}`;
  const existing = state.friendships.get(key);
  const now = Date.now();

  if (existing) {
    if (existing.status === 'accepted') {
      return { error: `Kamu dan @${target.username} sudah berteman.` };
    }
    if (existing.requesterId === userId) {
      return { error: `Permintaan pertemanan ke @${target.username} sudah dikirim.` };
    }
    // Lawan sudah lebih dulu mengirim permintaan ke kita -> otomatis terima!
    existing.status = 'accepted';
    existing.updatedAt = now;
    persistLocalSocial();
    db.execPg(
      'UPDATE friendships SET status = $1, updated_at = $2 WHERE user_low = $3 AND user_high = $4',
      ['accepted', now, userLow, userHigh]
    );
    emitToUser(userId, 'friends:changed');
    emitToUser(target.id, 'friends:changed');
    emitToUser(target.id, 'friend:accepted', { by: userSummary(userId) });
    return { status: 'accepted', user: userSummary(target.id) };
  }

  const row = {
    userLow,
    userHigh,
    requesterId: userId,
    status: 'pending',
    createdAt: now,
    updatedAt: now
  };
  state.friendships.set(key, row);
  persistLocalSocial();
  db.execPg(
    `INSERT INTO friendships (user_low, user_high, requester_id, status, created_at, updated_at)
     VALUES ($1, $2, $3, 'pending', $4, $5)
     ON CONFLICT (user_low, user_high) DO UPDATE SET
       requester_id = EXCLUDED.requester_id,
       status = EXCLUDED.status,
       updated_at = EXCLUDED.updated_at`,
    [userLow, userHigh, userId, now, now]
  );

  emitToUser(userId, 'friends:changed');
  emitToUser(target.id, 'friends:changed');
  emitToUser(target.id, 'friend:request', { from: userSummary(userId) });
  return { status: 'pending', user: userSummary(target.id) };
}

function acceptFriend(userId, otherUserId) {
  if (!otherUserId || otherUserId === userId) return { error: 'Pengguna tidak valid.' };
  const [userLow, userHigh] = pairOrder(userId, otherUserId);
  const key = `${userLow}:${userHigh}`;
  const existing = state.friendships.get(key);

  if (!existing || existing.status !== 'pending' || existing.requesterId !== otherUserId) {
    return { error: 'Permintaan pertemanan tidak ditemukan.' };
  }

  existing.status = 'accepted';
  existing.updatedAt = Date.now();
  persistLocalSocial();
  db.execPg(
    'UPDATE friendships SET status = $1, updated_at = $2 WHERE user_low = $3 AND user_high = $4',
    ['accepted', existing.updatedAt, userLow, userHigh]
  );

  emitToUser(userId, 'friends:changed');
  emitToUser(otherUserId, 'friends:changed');
  emitToUser(otherUserId, 'friend:accepted', { by: userSummary(userId) });
  return { success: true };
}

function removeFriend(userId, otherUserId) {
  if (!otherUserId || otherUserId === userId) return { error: 'Pengguna tidak valid.' };
  const [userLow, userHigh] = pairOrder(userId, otherUserId);
  const key = `${userLow}:${userHigh}`;
  if (!state.friendships.delete(key)) {
    return { error: 'Data pertemanan tidak ditemukan.' };
  }
  persistLocalSocial();
  db.execPg('DELETE FROM friendships WHERE user_low = $1 AND user_high = $2', [userLow, userHigh]);
  emitToUser(userId, 'friends:changed');
  emitToUser(otherUserId, 'friends:changed');
  return { success: true };
}

// ==========================================
// GRUP & ANGGOTA
// ==========================================

function validateGroupName(name) {
  const clean = String(name || '').trim();
  if (clean.length < 3 || clean.length > 40) {
    return { valid: false, error: 'Nama grup harus berisi 3 sampai 40 karakter.' };
  }
  return { valid: true, cleanName: clean };
}

function isGroupMember(groupId, userId) {
  if (!groupId || !userId) return false;
  return Boolean(state.groupMembers.get(groupId)?.has(userId));
}

function getMemberRole(groupId, userId) {
  return state.groupMembers.get(groupId)?.get(userId)?.role || null;
}

function getGroupBasic(groupId) {
  const g = state.groups.get(groupId);
  return g ? { id: g.id, name: g.name, avatar: g.avatar || null } : null;
}

function resolveReplyId(list, replyToId) {
  if (!replyToId) return null;
  const cleanId = String(replyToId).trim();
  if (!cleanId) return null;
  return (list || []).some(m => m.id === cleanId) ? cleanId : null;
}

function buildReplySummary(list, replyToId) {
  if (!replyToId) return null;
  const target = (list || []).find(m => m.id === replyToId);
  if (!target) {
    return { id: replyToId, type: 'text', senderId: null, sender: null, text: '' };
  }
  const sender = target.senderId ? userSummary(target.senderId) : null;
  let snippet = String(target.text || '').trim().slice(0, 120);
  if (!snippet) {
    if (target.type === 'image') snippet = '📷 Foto';
    else if (target.type === 'audio') snippet = '🎤 Voice note';
    else if (target.type === 'match') snippet = '🎲 Match Grup';
  }
  return {
    id: target.id,
    type: target.type,
    senderId: target.senderId || null,
    sender,
    text: snippet
  };
}

async function formatMessage(msg) {
  if (!msg) return null;
  let mediaObj = null;
  if (msg.mediaKey) {
    const url = await storage.signMediaUrl(msg.mediaKey);
    mediaObj = {
      url,
      streamUrl: msg.type === 'audio' ? `/api/groups/${msg.groupId}/messages/${msg.id}/audio` : null,
      mime: msg.mediaMime || 'application/octet-stream',
      size: msg.mediaSize || 0,
      width: msg.mediaWidth ?? null,
      height: msg.mediaHeight ?? null,
      durationMs: msg.mediaDurationMs ?? null
    };
  }
  const replyTo = msg.replyToId
    ? buildReplySummary(state.groupMessages.get(msg.groupId), msg.replyToId)
    : null;
  let matchObj = null;
  if (msg.matchCode) {
    const rawCode = String(msg.matchCode);
    const sepIdx = rawCode.indexOf(':');
    const gameType = sepIdx !== -1 ? rawCode.slice(0, sepIdx) : (msg.matchGameType || 'ludo');
    const cleanCode = sepIdx !== -1 ? rawCode.slice(sepIdx + 1) : rawCode;
    const cleanGameType = gameType === 'quiz' ? 'quiz' : gameType === 'snakes' ? 'snakes' : 'ludo';
    matchObj = {
      code: cleanCode,
      gameType: cleanGameType,
      gameName:
        cleanGameType === 'quiz'
          ? 'Monster Quiz Battle'
          : cleanGameType === 'snakes'
          ? 'Ular Tangga'
          : 'JakLudo'
    };
  }
  return {
    id: msg.id,
    groupId: msg.groupId,
    type: msg.type,
    sender: msg.senderId ? userSummary(msg.senderId) : null,
    text: msg.text || '',
    media: mediaObj,
    match: matchObj,
    replyToId: msg.replyToId || null,
    replyTo,
    createdAt: new Date(msg.createdAt).toISOString()
  };
}

function appendRawGroupMessage({ groupId, senderId = null, type, text = '', mediaKey = null, mediaMime = null, mediaSize = null, mediaWidth = null, mediaHeight = null, mediaDurationMs = null, matchCode = null, replyToId = null }) {
  const id = 'msg_' + crypto.randomUUID();
  const createdAt = Date.now();
  const row = {
    id,
    groupId,
    senderId,
    type,
    text: String(text || '').slice(0, 1000),
    mediaKey,
    mediaMime,
    mediaSize,
    mediaWidth,
    mediaHeight,
    mediaDurationMs,
    matchCode,
    replyToId: replyToId || null,
    createdAt
  };
  if (!state.groupMessages.has(groupId)) state.groupMessages.set(groupId, []);
  state.groupMessages.get(groupId).push(row);
  persistLocalSocial();

  db.execPg(
    `INSERT INTO group_messages
      (id, group_id, sender_id, type, text, media_key, media_mime, media_size, media_width, media_height, media_duration_ms, match_code, reply_to_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [id, groupId, senderId, type, row.text, mediaKey, mediaMime, mediaSize, mediaWidth, mediaHeight, mediaDurationMs, matchCode, row.replyToId, createdAt]
  );

  return row;
}

async function broadcastNewGroupMessage(row) {
  const formatted = await formatMessage(row);
  emitToGroup(row.groupId, 'group:message', formatted);
  emitToGroup(row.groupId, 'groups:changed');
  return formatted;
}

async function listUserGroups(userId) {
  const summaries = [];
  for (const [groupId, members] of state.groupMembers.entries()) {
    const me = members.get(userId);
    if (!me) continue;
    const g = state.groups.get(groupId);
    if (!g) continue;
    const msgs = state.groupMessages.get(groupId) || [];
    const lastRaw = msgs.length > 0 ? msgs[msgs.length - 1] : null;
    const lastMessage = lastRaw ? await formatMessage(lastRaw) : null;
    summaries.push({
      id: g.id,
      name: g.name,
      avatar: g.avatar || null,
      role: me.role,
      memberCount: members.size,
      createdAt: new Date(g.createdAt).toISOString(),
      lastMessage,
      _sortTime: lastRaw ? lastRaw.createdAt : g.createdAt
    });
  }
  summaries.sort((a, b) => b._sortTime - a._sortTime);
  for (const s of summaries) delete s._sortTime;
  return {
    groups: summaries,
    mediaEnabled: storage.isMediaEnabled()
  };
}

function getGroupDetail(groupId, userId) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };
  const membersMap = state.groupMembers.get(groupId);
  const myMember = membersMap?.get(userId);
  if (!myMember) return { error: 'Kamu bukan anggota grup ini.', status: 403 };

  const roleWeight = { owner: 0, admin: 1, member: 2 };
  const members = [];
  for (const m of membersMap.values()) {
    const summary = userSummary(m.userId);
    if (!summary) continue;
    members.push({
      ...summary,
      role: m.role,
      joinedAt: new Date(m.joinedAt).toISOString()
    });
  }
  members.sort((a, b) => (roleWeight[a.role] ?? 9) - (roleWeight[b.role] ?? 9) || a.name.localeCompare(b.name));

  const pendingInvites = [];
  for (const inv of state.groupInvites.values()) {
    if (inv.groupId !== groupId) continue;
    const invitee = userSummary(inv.inviteeId);
    const inviter = userSummary(inv.inviterId);
    if (!invitee || !inviter) continue;
    pendingInvites.push({
      id: inv.id,
      invitee,
      inviter,
      createdAt: new Date(inv.createdAt).toISOString()
    });
  }

  return {
    group: {
      id: g.id,
      name: g.name,
      avatar: g.avatar || null,
      ownerId: g.ownerId,
      role: myMember.role,
      createdAt: new Date(g.createdAt).toISOString(),
      members,
      pendingInvites
    }
  };
}

async function createGroup(userId, { name }) {
  const valid = validateGroupName(name);
  if (!valid.valid) return { error: valid.error };

  const creator = db.getUserById(userId);
  if (!creator) return { error: 'Pengguna tidak ditemukan.' };

  const id = 'grp_' + crypto.randomUUID();
  const now = Date.now();
  const groupRow = { id, name: valid.cleanName, ownerId: userId, avatar: null, createdAt: now };
  const memberRow = { groupId: id, userId, role: 'owner', joinedAt: now };

  state.groups.set(id, groupRow);
  state.groupMembers.set(id, new Map([[userId, memberRow]]));
  state.groupMessages.set(id, []);
  persistLocalSocial();

  await db.execPgTransaction(async client => {
    await client.query(
      'INSERT INTO groups (id, name, owner_id, created_at) VALUES ($1, $2, $3, $4)',
      [id, valid.cleanName, userId, now]
    );
    await client.query(
      'INSERT INTO group_members (group_id, user_id, role, joined_at) VALUES ($1, $2, $3, $4)',
      [id, userId, 'owner', now]
    );
  });

  joinUserSocketsToGroup(userId, id);
  const sysMsg = appendRawGroupMessage({
    groupId: id,
    senderId: userId,
    type: 'system',
    text: `🎉 Grup "${valid.cleanName}" dibuat oleh ${creator.name}.`
  });
  await broadcastNewGroupMessage(sysMsg);

  return getGroupDetail(id, userId);
}

async function renameGroup(groupId, actorId, { name }) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };
  const role = getMemberRole(groupId, actorId);
  if (role !== 'owner' && role !== 'admin') {
    return { error: 'Hanya owner atau admin yang dapat mengubah nama grup.', status: 403 };
  }
  const valid = validateGroupName(name);
  if (!valid.valid) return { error: valid.error };

  g.name = valid.cleanName;
  persistLocalSocial();
  db.execPg('UPDATE groups SET name = $1 WHERE id = $2', [valid.cleanName, groupId]);

  const actor = db.getUserById(actorId);
  const sysMsg = appendRawGroupMessage({
    groupId,
    senderId: actorId,
    type: 'system',
    text: `✏️ ${actor?.name || 'Admin'} mengubah nama grup menjadi "${valid.cleanName}".`
  });
  await broadcastNewGroupMessage(sysMsg);
  emitToGroup(groupId, 'group:updated', { groupId });

  return getGroupDetail(groupId, actorId);
}

function deleteGroup(groupId, actorId) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (g.ownerId !== actorId) {
    return { error: 'Hanya pembuat grup (owner) yang dapat menghapus grup.', status: 403 };
  }

  const members = Array.from(state.groupMembers.get(groupId)?.keys() || []);
  const msgs = state.groupMessages.get(groupId) || [];
  const invitedUsers = [];
  for (const [invId, inv] of state.groupInvites.entries()) {
    if (inv.groupId === groupId) {
      invitedUsers.push(inv.inviteeId);
      state.groupInvites.delete(invId);
    }
  }

  // Hapus file media & avatar grup di MinIO secara asinkron
  const grpAvatarKey = extractAvatarKey(g.avatar);
  if (grpAvatarKey) {
    avatarBufferCache.delete(grpAvatarKey);
    storage.deleteMedia(grpAvatarKey);
  }
  for (const m of msgs) {
    if (m.mediaKey) storage.deleteMedia(m.mediaKey);
  }

  state.groups.delete(groupId);
  state.groupMembers.delete(groupId);
  state.groupMessages.delete(groupId);
  persistLocalSocial();

  db.execPg('DELETE FROM groups WHERE id = $1', [groupId]);

  emitToGroup(groupId, 'group:removed', { groupId });
  emitToGroup(groupId, 'groups:changed');
  for (const uid of members) leaveUserSocketsFromGroup(uid, groupId);
  for (const uid of invitedUsers) emitToUser(uid, 'groups:changed');

  return { success: true };
}

function inviteToGroup(groupId, inviterId, { username }) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (!isGroupMember(groupId, inviterId)) {
    return { error: 'Hanya anggota grup yang dapat mengundang pemain lain.', status: 403 };
  }

  const clean = String(username || '').trim().replace(/^@/, '');
  if (!clean) return { error: 'Username wajib diisi.' };
  const invitee = db.getUserByUsername(clean);
  if (!invitee) return { error: `Pengguna @${clean} tidak ditemukan.` };

  if (isGroupMember(groupId, invitee.id)) {
    return { error: `@${invitee.username} sudah menjadi anggota grup ini.` };
  }
  for (const inv of state.groupInvites.values()) {
    if (inv.groupId === groupId && inv.inviteeId === invitee.id) {
      return { error: `@${invitee.username} sudah memiliki undangan yang menunggu konfirmasi.` };
    }
  }

  const id = 'ginv_' + crypto.randomUUID();
  const createdAt = Date.now();
  const row = { id, groupId, inviterId, inviteeId: invitee.id, createdAt };
  state.groupInvites.set(id, row);
  persistLocalSocial();

  db.execPg(
    `INSERT INTO group_invites (id, group_id, inviter_id, invitee_id, created_at)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (group_id, invitee_id) DO NOTHING`,
    [id, groupId, inviterId, invitee.id, createdAt]
  );

  emitToUser(invitee.id, 'groups:changed');
  emitToUser(invitee.id, 'group:invite', {
    invite: {
      id,
      group: { id: g.id, name: g.name, avatar: g.avatar || null },
      inviter: userSummary(inviterId),
      createdAt: new Date(createdAt).toISOString()
    }
  });
  emitToGroup(groupId, 'group:updated', { groupId });

  return {
    invite: {
      id,
      invitee: userSummary(invitee.id),
      inviter: userSummary(inviterId),
      createdAt: new Date(createdAt).toISOString()
    }
  };
}

function listUserGroupInvites(userId) {
  const invites = [];
  for (const inv of state.groupInvites.values()) {
    if (inv.inviteeId !== userId) continue;
    const g = state.groups.get(inv.groupId);
    const members = state.groupMembers.get(inv.groupId);
    const inviter = userSummary(inv.inviterId);
    if (!g || !inviter) continue;
    invites.push({
      id: inv.id,
      group: { id: g.id, name: g.name, avatar: g.avatar || null, memberCount: members ? members.size : 1 },
      inviter,
      createdAt: new Date(inv.createdAt).toISOString()
    });
  }
  invites.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { invites };
}

async function acceptGroupInvite(inviteId, userId) {
  const inv = state.groupInvites.get(inviteId);
  if (!inv || inv.inviteeId !== userId) {
    return { error: 'Undangan grup tidak ditemukan atau sudah tidak berlaku.', status: 404 };
  }
  const g = state.groups.get(inv.groupId);
  if (!g) {
    state.groupInvites.delete(inviteId);
    return { error: 'Grup sudah tidak ada.', status: 404 };
  }

  state.groupInvites.delete(inviteId);
  const now = Date.now();
  if (!state.groupMembers.has(g.id)) state.groupMembers.set(g.id, new Map());
  state.groupMembers.get(g.id).set(userId, {
    groupId: g.id,
    userId,
    role: 'member',
    joinedAt: now
  });
  persistLocalSocial();

  await db.execPgTransaction(async client => {
    await client.query('DELETE FROM group_invites WHERE id = $1', [inviteId]);
    await client.query(
      `INSERT INTO group_members (group_id, user_id, role, joined_at)
       VALUES ($1, $2, 'member', $3)
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [g.id, userId, now]
    );
  });

  joinUserSocketsToGroup(userId, g.id);
  const user = db.getUserById(userId);
  const sysMsg = appendRawGroupMessage({
    groupId: g.id,
    senderId: userId,
    type: 'system',
    text: `👋 ${user?.name || 'Pemain'} bergabung ke grup.`
  });
  await broadcastNewGroupMessage(sysMsg);
  emitToUser(userId, 'groups:changed');
  emitToGroup(g.id, 'group:updated', { groupId: g.id });

  return getGroupDetail(g.id, userId);
}

function declineGroupInvite(inviteId, userId) {
  const inv = state.groupInvites.get(inviteId);
  if (!inv || inv.inviteeId !== userId) {
    return { error: 'Undangan grup tidak ditemukan.', status: 404 };
  }
  state.groupInvites.delete(inviteId);
  persistLocalSocial();
  db.execPg('DELETE FROM group_invites WHERE id = $1', [inviteId]);

  emitToUser(userId, 'groups:changed');
  emitToGroup(inv.groupId, 'group:updated', { groupId: inv.groupId });
  return { success: true };
}

async function setMemberRole(groupId, actorId, targetUserId, { role }) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (g.ownerId !== actorId) {
    return { error: 'Hanya pembuat grup (owner) yang dapat mengatur peran admin.', status: 403 };
  }
  if (targetUserId === actorId) {
    return { error: 'Peran owner tidak dapat diubah.' };
  }
  if (role !== 'admin' && role !== 'member') {
    return { error: 'Peran harus admin atau member.' };
  }

  const members = state.groupMembers.get(groupId);
  const target = members?.get(targetUserId);
  if (!target) return { error: 'Anggota tidak ditemukan di grup ini.', status: 404 };

  target.role = role;
  persistLocalSocial();
  db.execPg(
    'UPDATE group_members SET role = $1 WHERE group_id = $2 AND user_id = $3',
    [role, groupId, targetUserId]
  );

  const targetUser = db.getUserById(targetUserId);
  const sysMsg = appendRawGroupMessage({
    groupId,
    senderId: actorId,
    type: 'system',
    text: role === 'admin'
      ? `🛡️ ${targetUser?.name || 'Anggota'} diangkat menjadi Admin grup.`
      : `👤 ${targetUser?.name || 'Anggota'} sekarang menjadi Member biasa.`
  });
  await broadcastNewGroupMessage(sysMsg);
  emitToGroup(groupId, 'group:updated', { groupId });

  return getGroupDetail(groupId, actorId);
}

async function removeGroupMember(groupId, actorId, targetUserId) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };

  const members = state.groupMembers.get(groupId);
  const actor = members?.get(actorId);
  const target = members?.get(targetUserId);
  if (!actor) return { error: 'Kamu bukan anggota grup ini.', status: 403 };
  if (!target) return { error: 'Anggota tidak ditemukan di grup ini.', status: 404 };

  const isSelf = actorId === targetUserId;
  if (isSelf) {
    if (actor.role === 'owner') {
      return { error: 'Owner tidak bisa keluar dari grup. Hapus grup jika ingin membubarkannya.' };
    }
  } else {
    if (actor.role === 'member') {
      return { error: 'Hanya owner atau admin yang dapat mengeluarkan anggota.', status: 403 };
    }
    if (actor.role === 'admin' && target.role !== 'member') {
      return { error: 'Admin hanya dapat mengeluarkan member biasa.', status: 403 };
    }
  }

  members.delete(targetUserId);
  persistLocalSocial();
  db.execPg('DELETE FROM group_members WHERE group_id = $1 AND user_id = $2', [groupId, targetUserId]);

  leaveUserSocketsFromGroup(targetUserId, groupId);
  emitToUser(targetUserId, 'group:removed', { groupId });
  emitToUser(targetUserId, 'groups:changed');

  const targetUser = db.getUserById(targetUserId);
  const sysMsg = appendRawGroupMessage({
    groupId,
    senderId: actorId,
    type: 'system',
    text: isSelf
      ? `🚪 ${targetUser?.name || 'Anggota'} keluar dari grup.`
      : `🚫 ${targetUser?.name || 'Anggota'} dikeluarkan dari grup.`
  });
  await broadcastNewGroupMessage(sysMsg);
  emitToGroup(groupId, 'group:updated', { groupId });

  return { success: true };
}

// ==========================================
// PESAN GRUP (TEKS, FOTO, VOICE NOTE, MATCH)
// ==========================================

async function listGroupMessages(groupId, userId, { before, limit = 30 } = {}) {
  if (!state.groups.has(groupId)) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (!isGroupMember(groupId, userId)) return { error: 'Kamu bukan anggota grup ini.', status: 403 };

  const all = state.groupMessages.get(groupId) || [];
  const cap = Math.max(1, Math.min(50, Number(limit) || 30));
  let endIdx = all.length;
  if (before) {
    const foundIdx = all.findIndex(m => m.id === before);
    if (foundIdx !== -1) endIdx = foundIdx;
  }
  const startIdx = Math.max(0, endIdx - cap);
  const slice = all.slice(startIdx, endIdx);
  const messages = await Promise.all(slice.map(formatMessage));

  return {
    messages,
    hasMore: startIdx > 0
  };
}

async function sendGroupTextMessage(groupId, userId, { text, replyToId = null }) {
  if (!state.groups.has(groupId)) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (!isGroupMember(groupId, userId)) return { error: 'Kamu bukan anggota grup ini.', status: 403 };

  const clean = String(text || '').trim();
  if (!clean) return { error: 'Pesan tidak boleh kosong.' };
  if (clean.length > 1000) return { error: 'Pesan maksimal 1.000 karakter.' };

  const validReplyId = resolveReplyId(state.groupMessages.get(groupId), replyToId);
  const row = appendRawGroupMessage({
    groupId,
    senderId: userId,
    type: 'text',
    text: clean,
    replyToId: validReplyId
  });
  const message = await broadcastNewGroupMessage(row);
  return { message };
}

async function sendGroupMediaMessage(groupId, userId, { kind, buffer, durationMs, text, replyToId = null }) {
  if (!state.groups.has(groupId)) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (!isGroupMember(groupId, userId)) return { error: 'Kamu bukan anggota grup ini.', status: 403 };
  if (!storage.isMediaEnabled()) {
    return { error: 'Penyimpanan media MinIO belum dikonfigurasi di server.', status: 503 };
  }
  if (kind !== 'image' && kind !== 'audio') {
    return { error: 'Jenis media harus berupa image (foto) atau audio (voice note).' };
  }

  let processed;
  try {
    if (kind === 'image') {
      processed = await media.compressImage(buffer);
    } else {
      processed = await media.compressAudio(buffer, durationMs);
    }
  } catch (err) {
    return { error: err.message || 'Gagal memproses file media.' };
  }

  let uploaded;
  try {
    uploaded = await storage.uploadMedia({
      groupId,
      kind,
      ext: processed.ext,
      buffer: processed.buffer,
      mime: processed.mime
    });
  } catch (err) {
    console.error('[MINIO UPLOAD ERROR]', err);
    return { error: 'Gagal mengunggah file media ke penyimpanan objek.', status: 502 };
  }

  const cleanCaption = String(text || '').trim().slice(0, 300);
  const validReplyId = resolveReplyId(state.groupMessages.get(groupId), replyToId);
  const row = appendRawGroupMessage({
    groupId,
    senderId: userId,
    type: kind,
    text: cleanCaption,
    mediaKey: uploaded.key,
    mediaMime: processed.mime,
    mediaSize: uploaded.size,
    mediaWidth: processed.width ?? null,
    mediaHeight: processed.height ?? null,
    mediaDurationMs: processed.durationMs ?? null,
    replyToId: validReplyId
  });

  const message = await broadcastNewGroupMessage(row);
  return { message };
}

async function getGroupMessageAudio(groupId, messageId, userId) {
  if (!state.groups.has(groupId)) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (!isGroupMember(groupId, userId)) return { error: 'Kamu bukan anggota grup ini.', status: 403 };

  const list = state.groupMessages.get(groupId) || [];
  const msg = list.find(m => m.id === messageId && m.type === 'audio');
  if (!msg || !msg.mediaKey) return { error: 'Voice note tidak ditemukan.', status: 404 };

  if (audioPlayCache.has(messageId)) {
    return audioPlayCache.get(messageId);
  }

  let rawBuffer;
  try {
    rawBuffer = await storage.getMediaBuffer(msg.mediaKey);
  } catch (err) {
    console.error('[MINIO GET AUDIO ERROR]', err);
    return { error: 'Gagal mengambil voice note dari penyimpanan objek.', status: 502 };
  }
  if (!rawBuffer || rawBuffer.length === 0) {
    return { error: 'File voice note kosong atau tidak ditemukan di MinIO.', status: 404 };
  }

  const playable = await media.ensurePlayableAudio(rawBuffer, msg.mediaMime);
  if (audioPlayCache.size >= 30) {
    const oldestKey = audioPlayCache.keys().next().value;
    audioPlayCache.delete(oldestKey);
  }
  audioPlayCache.set(messageId, playable);
  return playable;
}

async function postGroupMatchMessage(groupId, creatorUserId, roomCode, gameType = 'ludo') {
  if (!state.groups.has(groupId)) return null;
  const creator = db.getUserById(creatorUserId);
  const cleanGame = gameType === 'quiz' ? 'quiz' : gameType === 'snakes' ? 'snakes' : 'ludo';
  const gameName =
    cleanGame === 'quiz'
      ? 'Monster Quiz Battle (Maks 3 Pemain)'
      : cleanGame === 'snakes'
      ? 'Ular Tangga (Maks 4 Pemain)'
      : 'JakLudo';
  const icon = cleanGame === 'quiz' ? '🐉' : cleanGame === 'snakes' ? '🐍' : '🎲';
  const storedMatchCode =
    cleanGame === 'quiz'
      ? `quiz:${roomCode}`
      : cleanGame === 'snakes'
      ? `snakes:${roomCode}`
      : roomCode;
  const row = appendRawGroupMessage({
    groupId,
    senderId: creatorUserId,
    type: 'match',
    text: `${icon} ${creator?.name || 'Anggota'} membuat Match Grup ${gameName}! Kode room: ${roomCode}`,
    matchCode: storedMatchCode
  });
  return broadcastNewGroupMessage(row);
}

// ==========================================
// LEADERBOARD GRUP (QUERY DARI LEADERBOARD GLOBAL)
// ==========================================

function notifyGroupLeaderboardUpdated(groupId) {
  if (!groupId || !state.groups.has(groupId)) return;
  emitToGroup(groupId, 'group:leaderboard', { groupId });
}

async function getGroupLeaderboard(groupId, userId) {
  if (!state.groups.has(groupId)) return { error: 'Grup tidak ditemukan.', status: 404 };
  if (!isGroupMember(groupId, userId)) return { error: 'Kamu bukan anggota grup ini.', status: 403 };

  const pool = db.getPool();
  const rows = [];

  if (pool) {
    await db.flush();
    const { rows: pgRows } = await pool.query(
      `SELECT
         u.id AS user_id,
         u.username,
         u.name,
         COALESCE(u.avatar, l.avatar, '🎯') AS avatar,
         COALESCE(l.wins, 0) AS wins,
         COALESCE(l.matches_played, 0) AS matches_played,
         COALESCE(l.points, 200) AS points
       FROM group_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN leaderboard l ON l.user_id = gm.user_id
       WHERE gm.group_id = $1`,
      [groupId]
    );
    for (const r of pgRows) {
      const wins = Number(r.wins || 0);
      const matchesPlayed = Number(r.matches_played || 0);
      const points = Number(r.points || 0);
      const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0;
      rows.push({
        userId: r.user_id,
        username: r.username,
        name: r.name,
        avatar: r.avatar || '🎯',
        wins,
        matchesPlayed,
        points,
        winRate,
        isLudoKing: db.checkIsLudoKing(r.user_id)
      });
    }
  } else {
    const membersMap = state.groupMembers.get(groupId) || new Map();
    const globalById = new Map(db.getLeaderboard().map(e => [e.userId, e]));

    for (const uid of membersMap.keys()) {
      const u = db.getUserById(uid);
      if (!u) continue;
      const gEntry = globalById.get(uid);
      const wins = gEntry ? gEntry.wins : 0;
      const matchesPlayed = gEntry ? gEntry.matchesPlayed : 0;
      const points = gEntry ? gEntry.points : (u.points ?? 200);
      const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0;
      rows.push({
        userId: u.id,
        username: u.username,
        name: u.name,
        avatar: u.avatar || '🎯',
        wins,
        matchesPlayed,
        points,
        winRate,
        isLudoKing: db.checkIsLudoKing(u.id)
      });
    }
  }

  rows.sort((a, b) =>
    b.wins - a.wins ||
    b.points - a.points ||
    b.winRate - a.winRate ||
    a.name.localeCompare(b.name)
  );

  return {
    leaderboard: rows.map((r, idx) => ({ ...r, rank: idx + 1 }))
  };
}

// ==========================================
// CHAT PRIVATE ANTAR TEMAN (DIRECT MESSAGES)
// ==========================================

async function formatDirectMessage(msg) {
  if (!msg) return null;
  let mediaObj = null;
  if (msg.mediaKey) {
    const url = await storage.signMediaUrl(msg.mediaKey);
    const otherId = msg.senderId;
    mediaObj = {
      url,
      streamUrl: msg.type === 'audio' ? `/api/dm/${msg.id}/audio` : null,
      friendStreamUrl: msg.type === 'audio' ? `/api/friends/${otherId}/messages/${msg.id}/audio` : null,
      mime: msg.mediaMime || 'application/octet-stream',
      size: msg.mediaSize || 0,
      width: msg.mediaWidth ?? null,
      height: msg.mediaHeight ?? null,
      durationMs: msg.mediaDurationMs ?? null
    };
  }
  const replyTo = msg.replyToId
    ? buildReplySummary(state.directMessages.get(msg.pairKey), msg.replyToId)
    : null;
  return {
    id: msg.id,
    pairKey: msg.pairKey,
    senderId: msg.senderId,
    recipientId: msg.recipientId,
    type: msg.type,
    sender: userSummary(msg.senderId),
    recipient: userSummary(msg.recipientId),
    text: msg.text || '',
    media: mediaObj,
    replyToId: msg.replyToId || null,
    replyTo,
    createdAt: new Date(msg.createdAt).toISOString()
  };
}

function appendRawDirectMessage({
  senderId,
  recipientId,
  type,
  text = '',
  mediaKey = null,
  mediaMime = null,
  mediaSize = null,
  mediaWidth = null,
  mediaHeight = null,
  mediaDurationMs = null,
  replyToId = null
}) {
  const id = 'dm_' + crypto.randomUUID();
  const createdAt = Date.now();
  const pk = pairKey(senderId, recipientId);
  const row = {
    id,
    pairKey: pk,
    senderId,
    recipientId,
    type,
    text: String(text || '').slice(0, 1000),
    mediaKey,
    mediaMime,
    mediaSize,
    mediaWidth,
    mediaHeight,
    mediaDurationMs,
    replyToId: replyToId || null,
    createdAt
  };
  if (!state.directMessages.has(pk)) state.directMessages.set(pk, []);
  state.directMessages.get(pk).push(row);
  persistLocalSocial();

  db.execPg(
    `INSERT INTO direct_messages
      (id, pair_key, sender_id, recipient_id, type, text, media_key, media_mime, media_size, media_width, media_height, media_duration_ms, reply_to_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      pk,
      senderId,
      recipientId,
      type,
      row.text,
      mediaKey,
      mediaMime,
      mediaSize,
      mediaWidth,
      mediaHeight,
      mediaDurationMs,
      row.replyToId,
      createdAt
    ]
  );

  return row;
}

async function broadcastNewDirectMessage(row) {
  const formatted = await formatDirectMessage(row);
  emitToUser(row.senderId, 'dm:message', formatted);
  emitToUser(row.recipientId, 'dm:message', formatted);
  emitToUser(row.senderId, 'friends:changed');
  emitToUser(row.recipientId, 'friends:changed');
  return formatted;
}

async function listDirectMessages(userId, friendId, { before, limit = 30 } = {}) {
  if (!areFriends(userId, friendId)) {
    return { error: 'Kamu hanya dapat berkirim pesan private dengan teman.', status: 403 };
  }
  const pk = pairKey(userId, friendId);
  const all = state.directMessages.get(pk) || [];
  const cap = Math.max(1, Math.min(50, Number(limit) || 30));
  let endIdx = all.length;
  if (before) {
    const foundIdx = all.findIndex(m => m.id === before);
    if (foundIdx !== -1) endIdx = foundIdx;
  }
  const startIdx = Math.max(0, endIdx - cap);
  const slice = all.slice(startIdx, endIdx);
  const messages = await Promise.all(slice.map(formatDirectMessage));

  return {
    messages,
    hasMore: startIdx > 0,
    mediaEnabled: storage.isMediaEnabled()
  };
}

async function sendDirectTextMessage(userId, friendId, { text, replyToId = null }) {
  if (!areFriends(userId, friendId)) {
    return { error: 'Kamu hanya dapat berkirim pesan private dengan teman.', status: 403 };
  }
  const clean = String(text || '').trim();
  if (!clean) return { error: 'Pesan tidak boleh kosong.' };
  if (clean.length > 1000) return { error: 'Pesan maksimal 1.000 karakter.' };

  const pk = pairKey(userId, friendId);
  const validReplyId = resolveReplyId(state.directMessages.get(pk), replyToId);
  const row = appendRawDirectMessage({
    senderId: userId,
    recipientId: friendId,
    type: 'text',
    text: clean,
    replyToId: validReplyId
  });
  const message = await broadcastNewDirectMessage(row);
  return { message };
}

async function sendDirectMediaMessage(userId, friendId, { kind, buffer, durationMs, text, replyToId = null }) {
  if (!areFriends(userId, friendId)) {
    return { error: 'Kamu hanya dapat berkirim pesan private dengan teman.', status: 403 };
  }
  if (!storage.isMediaEnabled()) {
    return { error: 'Penyimpanan media MinIO belum dikonfigurasi di server.', status: 503 };
  }
  if (kind !== 'image' && kind !== 'audio') {
    return { error: 'Jenis media harus berupa image (foto) atau audio (voice note).' };
  }

  let processed;
  try {
    if (kind === 'image') {
      processed = await media.compressImage(buffer);
    } else {
      processed = await media.compressAudio(buffer, durationMs);
    }
  } catch (err) {
    return { error: err.message || 'Gagal memproses file media.' };
  }

  const pk = pairKey(userId, friendId);
  let uploaded;
  try {
    uploaded = await storage.uploadMedia({
      pairKey: pk,
      kind,
      ext: processed.ext,
      buffer: processed.buffer,
      mime: processed.mime
    });
  } catch (err) {
    console.error('[MINIO DM UPLOAD ERROR]', err);
    return { error: 'Gagal mengunggah file media ke penyimpanan objek.', status: 502 };
  }

  const cleanCaption = String(text || '').trim().slice(0, 300);
  const validReplyId = resolveReplyId(state.directMessages.get(pk), replyToId);
  const row = appendRawDirectMessage({
    senderId: userId,
    recipientId: friendId,
    type: kind,
    text: cleanCaption,
    mediaKey: uploaded.key,
    mediaMime: processed.mime,
    mediaSize: uploaded.size,
    mediaWidth: processed.width ?? null,
    mediaHeight: processed.height ?? null,
    mediaDurationMs: processed.durationMs ?? null,
    replyToId: validReplyId
  });

  const message = await broadcastNewDirectMessage(row);
  return { message };
}

async function getDirectMessageAudio(messageId, userId) {
  let found = null;
  for (const list of state.directMessages.values()) {
    const m = list.find(item => item.id === messageId && item.type === 'audio');
    if (m) {
      found = m;
      break;
    }
  }
  if (!found || !found.mediaKey) {
    return { error: 'Voice note tidak ditemukan.', status: 404 };
  }
  if (found.senderId !== userId && found.recipientId !== userId) {
    return { error: 'Kamu tidak memiliki akses ke pesan ini.', status: 403 };
  }

  if (audioPlayCache.has(messageId)) {
    return audioPlayCache.get(messageId);
  }

  let rawBuffer;
  try {
    rawBuffer = await storage.getMediaBuffer(found.mediaKey);
  } catch (err) {
    console.error('[MINIO GET DM AUDIO ERROR]', err);
    return { error: 'Gagal mengambil voice note dari penyimpanan objek.', status: 502 };
  }
  if (!rawBuffer || rawBuffer.length === 0) {
    return { error: 'File voice note kosong atau tidak ditemukan di MinIO.', status: 404 };
  }

  const playable = await media.ensurePlayableAudio(rawBuffer, found.mediaMime);
  if (audioPlayCache.size >= 30) {
    const oldestKey = audioPlayCache.keys().next().value;
    audioPlayCache.delete(oldestKey);
  }
  audioPlayCache.set(messageId, playable);
  return playable;
}

// ==========================================
// FOTO PROFIL (AVATAR) USER DI MINIO S3
// ==========================================

function extractAvatarKey(avatarUrl) {
  if (!avatarUrl || typeof avatarUrl !== 'string') return null;
  const match = /[?&]key=([^&]+)/.exec(avatarUrl);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

async function uploadUserAvatar(userId, buffer) {
  const user = db.getUserById(userId);
  if (!user) return { error: 'Pengguna tidak ditemukan.', status: 404 };
  if (!storage.isMediaEnabled()) {
    return { error: 'Penyimpanan objek MinIO S3 belum dikonfigurasi di server.', status: 503 };
  }

  let processed;
  try {
    processed = await media.compressAvatar(buffer);
  } catch (err) {
    return { error: err.message || 'Gagal mengompres foto profil.' };
  }

  let uploaded;
  try {
    uploaded = await storage.uploadMedia({
      userId,
      kind: 'avatar',
      ext: processed.ext,
      buffer: processed.buffer,
      mime: processed.mime
    });
  } catch (err) {
    console.error('[MINIO AVATAR UPLOAD ERROR]', err);
    return { error: 'Gagal mengunggah foto profil ke MinIO S3.', status: 502 };
  }

  const oldKey = extractAvatarKey(user.avatar);
  if (oldKey && oldKey !== uploaded.key) {
    avatarBufferCache.delete(oldKey);
    storage.deleteMedia(oldKey);
  }

  if (avatarBufferCache.size >= 100) {
    const oldest = avatarBufferCache.keys().next().value;
    avatarBufferCache.delete(oldest);
  }
  avatarBufferCache.set(uploaded.key, { buffer: processed.buffer, mime: processed.mime });

  const avatarUrl = `/api/users/${encodeURIComponent(userId)}/avatar?key=${encodeURIComponent(uploaded.key)}`;
  const updatedUser = db.updateUserAvatar(userId, avatarUrl);

  // Beritahu teman dan grup agar tampilan avatar langsung diperbarui secara realtime
  notifyAcceptedFriendsPresence(userId);
  for (const [groupId, members] of state.groupMembers.entries()) {
    if (members.has(userId)) {
      emitToGroup(groupId, 'group:updated', { groupId });
    }
  }

  return { user: updatedUser, avatarUrl };
}

async function getUserAvatarBuffer(userId, requestedKey = '') {
  const user = db.getUserById(userId);
  if (!user) return { error: 'Pengguna tidak ditemukan.', status: 404 };

  const key = String(requestedKey || extractAvatarKey(user.avatar) || '').trim();
  const expectedPrefix = `avatars/${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}/`;
  if (!key || !key.startsWith(expectedPrefix)) {
    return { error: 'Foto profil tidak ditemukan.', status: 404 };
  }

  if (avatarBufferCache.has(key)) {
    return avatarBufferCache.get(key);
  }

  let rawBuffer;
  try {
    rawBuffer = await storage.getMediaBuffer(key);
  } catch (err) {
    console.error('[MINIO GET AVATAR ERROR]', err);
    return { error: 'Gagal memuat foto profil dari MinIO S3.', status: 502 };
  }
  if (!rawBuffer || rawBuffer.length === 0) {
    return { error: 'Foto profil tidak ditemukan di penyimpanan objek.', status: 404 };
  }

  const entry = { buffer: rawBuffer, mime: 'image/webp' };
  if (avatarBufferCache.size >= 100) {
    const oldest = avatarBufferCache.keys().next().value;
    avatarBufferCache.delete(oldest);
  }
  avatarBufferCache.set(key, entry);
  return entry;
}

// ==========================================
// FOTO PROFIL (AVATAR) GRUP DI MINIO S3
// ==========================================

async function uploadGroupAvatar(groupId, actorId, buffer) {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };
  const role = getMemberRole(groupId, actorId);
  if (role !== 'owner' && role !== 'admin') {
    return { error: 'Hanya owner atau admin yang dapat mengubah foto profil grup.', status: 403 };
  }
  if (!storage.isMediaEnabled()) {
    return { error: 'Penyimpanan objek MinIO S3 belum dikonfigurasi di server.', status: 503 };
  }

  let processed;
  try {
    processed = await media.compressAvatar(buffer);
  } catch (err) {
    return { error: err.message || 'Gagal mengompres foto profil grup.' };
  }

  let uploaded;
  try {
    uploaded = await storage.uploadMedia({
      groupId,
      kind: 'group_avatar',
      ext: processed.ext,
      buffer: processed.buffer,
      mime: processed.mime
    });
  } catch (err) {
    console.error('[MINIO GROUP AVATAR UPLOAD ERROR]', err);
    return { error: 'Gagal mengunggah foto profil grup ke MinIO S3.', status: 502 };
  }

  const oldKey = extractAvatarKey(g.avatar);
  if (oldKey && oldKey !== uploaded.key) {
    avatarBufferCache.delete(oldKey);
    storage.deleteMedia(oldKey);
  }

  if (avatarBufferCache.size >= 100) {
    const oldest = avatarBufferCache.keys().next().value;
    avatarBufferCache.delete(oldest);
  }
  avatarBufferCache.set(uploaded.key, { buffer: processed.buffer, mime: processed.mime });

  const avatarUrl = `/api/groups/${encodeURIComponent(groupId)}/avatar?key=${encodeURIComponent(uploaded.key)}`;
  g.avatar = avatarUrl;
  persistLocalSocial();
  db.execPg('UPDATE groups SET avatar = $1 WHERE id = $2', [avatarUrl, groupId]);

  const actor = db.getUserById(actorId);
  const sysMsg = appendRawGroupMessage({
    groupId,
    senderId: actorId,
    type: 'system',
    text: `🖼️ ${actor?.name || 'Admin'} memperbarui foto profil grup.`
  });
  await broadcastNewGroupMessage(sysMsg);
  emitToGroup(groupId, 'group:updated', { groupId });

  return getGroupDetail(groupId, actorId);
}

async function getGroupAvatarBuffer(groupId, requestedKey = '') {
  const g = state.groups.get(groupId);
  if (!g) return { error: 'Grup tidak ditemukan.', status: 404 };

  const key = String(requestedKey || extractAvatarKey(g.avatar) || '').trim();
  const expectedPrefix = `group-avatars/${String(groupId).replace(/[^a-zA-Z0-9_-]/g, '')}/`;
  if (!key || !key.startsWith(expectedPrefix)) {
    return { error: 'Foto profil grup tidak ditemukan.', status: 404 };
  }

  if (avatarBufferCache.has(key)) {
    return avatarBufferCache.get(key);
  }

  let rawBuffer;
  try {
    rawBuffer = await storage.getMediaBuffer(key);
  } catch (err) {
    console.error('[MINIO GET GROUP AVATAR ERROR]', err);
    return { error: 'Gagal memuat foto profil grup dari MinIO S3.', status: 502 };
  }
  if (!rawBuffer || rawBuffer.length === 0) {
    return { error: 'Foto profil grup tidak ditemukan di penyimpanan objek.', status: 404 };
  }

  const entry = { buffer: rawBuffer, mime: 'image/webp' };
  if (avatarBufferCache.size >= 100) {
    const oldest = avatarBufferCache.keys().next().value;
    avatarBufferCache.delete(oldest);
  }
  avatarBufferCache.set(key, entry);
  return entry;
}

// ==========================================
// PROFIL PUBLIK PEMAIN
// ==========================================

function getUserPublicProfile(targetIdOrUsername, viewerUserId = null) {
  const clean = String(targetIdOrUsername || '').trim();
  if (!clean) return { error: 'Pemain tidak ditemukan.', status: 404 };

  let target = db.getUserById(clean);
  if (!target) {
    target = db.getUserByUsername(clean.replace(/^@/, ''));
  }
  if (!target) return { error: 'Pemain tidak ditemukan.', status: 404 };

  const lbList = db.getLeaderboard();
  const lbEntry = lbList.find(e => e.userId === target.id);
  const wins = lbEntry ? lbEntry.wins : 0;
  const matchesPlayed = lbEntry ? lbEntry.matchesPlayed : 0;
  const points = lbEntry ? lbEntry.points : target.points ?? 200;
  const winRate = matchesPlayed > 0 ? Math.round((wins / matchesPlayed) * 100) : 0;
  const rank = lbEntry ? lbEntry.rank : null;
  const isLudoKing = db.checkIsLudoKing(target.id);

  let friendCount = 0;
  for (const f of state.friendships.values()) {
    if (f.status === 'accepted' && (f.userLow === target.id || f.userHigh === target.id)) {
      friendCount++;
    }
  }

  let groupCount = 0;
  const sharedGroups = [];
  for (const [groupId, members] of state.groupMembers.entries()) {
    if (!members.has(target.id)) continue;
    groupCount++;
    if (viewerUserId && viewerUserId !== target.id && members.has(viewerUserId)) {
      const g = state.groups.get(groupId);
      if (g) {
        sharedGroups.push({ id: g.id, name: g.name, avatar: g.avatar || null });
      }
    }
  }

  let friendshipStatus = 'none';
  if (viewerUserId) {
    if (viewerUserId === target.id) {
      friendshipStatus = 'self';
    } else {
      const f = state.friendships.get(pairKey(viewerUserId, target.id));
      if (f) {
        if (f.status === 'accepted') friendshipStatus = 'friends';
        else if (f.requesterId === viewerUserId) friendshipStatus = 'outgoing_pending';
        else friendshipStatus = 'incoming_pending';
      }
    }
  }

  return {
    profile: {
      userId: target.id,
      username: target.username,
      name: target.name,
      avatar: target.avatar || '🎯',
      email: viewerUserId === target.id ? (target.email || '') : undefined,
      hasPassword: viewerUserId === target.id ? Boolean(target.passwordHash) : undefined,
      authType: viewerUserId === target.id ? target.authType : undefined,
      online: isUserOnline(target.id),
      createdAt: target.createdAt || null,
      isLudoKing,
      isSelf: viewerUserId === target.id,
      rank,
      wins,
      matchesPlayed,
      winRate,
      points,
      friendCount,
      groupCount,
      stats: {
        rank,
        wins,
        matchesPlayed,
        winRate,
        points,
        friendCount,
        groupCount
      },
      friendshipStatus,
      sharedGroups
    }
  };
}

module.exports = {
  hydrateFromPostgres,
  identifySocket,
  detachSocket,
  isUserOnline,
  userSummary,
  emitToUser,
  emitToGroup,
  areFriends,
  listFriends,
  requestFriend,
  acceptFriend,
  removeFriend,
  isGroupMember,
  getGroupBasic,
  listUserGroups,
  getGroupDetail,
  createGroup,
  renameGroup,
  deleteGroup,
  inviteToGroup,
  listUserGroupInvites,
  acceptGroupInvite,
  declineGroupInvite,
  setMemberRole,
  removeGroupMember,
  listGroupMessages,
  sendGroupTextMessage,
  sendGroupMediaMessage,
  getGroupMessageAudio,
  postGroupMatchMessage,
  notifyGroupLeaderboardUpdated,
  getGroupLeaderboard,
  listDirectMessages,
  sendDirectTextMessage,
  sendDirectMediaMessage,
  getDirectMessageAudio,
  uploadUserAvatar,
  getUserAvatarBuffer,
  uploadGroupAvatar,
  getGroupAvatarBuffer,
  getUserPublicProfile
};


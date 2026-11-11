// Integration test fitur sosial: pertemanan, undangan room, grup (owner/admin/member),
// chat grup, kompresi media (foto WebP & voice note) ke MinIO S3, match khusus grup, dan leaderboard grup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jakludo-social-'));
process.env.JAKLUDO_DATA_DIR = dataDir;

const { io: ioClient } = require('socket.io-client');
const { server, rooms, shutdown } = require('../index');
const db = require('../db');
const storage = require('../lib/storage');
const engine = require('../game/engine');

let url;
const clients = [];
const uploadedObjects = new Map();

test.before(async () => {
  storage.setMockAdapter({
    async upload({ key, buffer, mime }) {
      uploadedObjects.set(key, { buffer, mime });
    },
    async get(key) {
      const entry = uploadedObjects.get(key);
      return entry ? entry.buffer : null;
    },
    async signUrl(key) {
      return `https://minio.local/jakludo/${key}?X-Amz-Expires=600`;
    },
    async delete(key) {
      uploadedObjects.delete(key);
    }
  });
  await new Promise(resolve => server.listen(0, resolve));
  url = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  storage.setMockAdapter(null);
  clients.forEach(c => c.close());
  await shutdown();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function connect() {
  const c = ioClient(url, { forceNew: true, transports: ['websocket'] });
  clients.push(c);
  return new Promise(resolve => c.on('connect', () => resolve(c)));
}

const once = (c, ev) => new Promise(resolve => c.once(ev, resolve));
const wait = ms => new Promise(r => setTimeout(r, ms));

let seq = 0;
async function register(prefix = 'user') {
  const username = `${prefix}_${++seq}`;
  const res = await fetch(`${url}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'Rahasia#123', name: username.toUpperCase() })
  });
  return res.json();
}

function apiFetch(token, method, route, body) {
  return fetch(`${url}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  }).then(async r => ({ status: r.status, ...(await r.json()) }));
}

test('sistem pertemanan via username dan undang teman ke room match', async () => {
  const alice = await register('alice');
  const bob = await register('bob');
  const charlie = await register('charlie');

  // Alice mengirim permintaan pertemanan ke Bob menggunakan username
  const req1 = await apiFetch(alice.token, 'POST', '/api/friends/request', { username: bob.user.username });
  assert.equal(req1.success, true);
  assert.equal(req1.status, 'pending');

  const bobList = await apiFetch(bob.token, 'GET', '/api/friends');
  assert.equal(bobList.incoming.length, 1);
  assert.equal(bobList.incoming[0].userId, alice.user.id);

  // Bob menerima permintaan Alice
  const acc = await apiFetch(bob.token, 'POST', `/api/friends/${alice.user.id}/accept`);
  assert.equal(acc.success, true);

  const aliceFriends = await apiFetch(alice.token, 'GET', '/api/friends');
  assert.equal(aliceFriends.friends.length, 1);
  assert.equal(aliceFriends.friends[0].username, bob.user.username);

  // Socket identifikasi & undang Bob ke room match
  const sockAlice = await connect();
  const sockBob = await connect();
  sockAlice.emit('social:identify', { token: alice.token });
  sockBob.emit('social:identify', { token: bob.token });
  await wait(50);

  sockAlice.emit('room:create', { token: alice.token, name: alice.user.name });
  const joined = await once(sockAlice, 'room:joined');

  // Mengundang Charlie (bukan teman) harus ditolak
  const badInv = await new Promise(resolve =>
    sockAlice.emit('room:invite', { userId: charlie.user.id }, resolve)
  );
  assert.equal(badInv.ok, false);

  // Mengundang Bob (teman online) berhasil dan diterima lewat event room:invite
  const inviteReceived = once(sockBob, 'room:invite');
  const goodInv = await new Promise(resolve =>
    sockAlice.emit('room:invite', { userId: bob.user.id }, resolve)
  );
  assert.equal(goodInv.ok, true);
  const invitePayload = await inviteReceived;
  assert.equal(invitePayload.code, joined.code);
  assert.equal(invitePayload.from.username, alice.user.username);
});

test('grup: owner, admin, dan member bisa invite; aturan peran & kick berjalan sesuai hak akses', async () => {
  const owner = await register('owner');
  const member1 = await register('mem1');
  const member2 = await register('mem2');

  // Buat grup
  const created = await apiFetch(owner.token, 'POST', '/api/groups', { name: 'Klub Ludo Jakarta' });
  assert.equal(created.success, true);
  const groupId = created.group.id;
  assert.equal(created.group.role, 'owner');

  // Owner mengundang member1
  const inv1 = await apiFetch(owner.token, 'POST', `/api/groups/${groupId}/invites`, { username: member1.user.username });
  assert.equal(inv1.success, true);

  const m1Invites = await apiFetch(member1.token, 'GET', '/api/group-invites');
  assert.equal(m1Invites.invites.length, 1);

  const acc1 = await apiFetch(member1.token, 'POST', `/api/group-invites/${m1Invites.invites[0].id}/accept`);
  assert.equal(acc1.success, true);
  assert.equal(acc1.group.members.length, 2);

  // Member biasa (member1) mengundang member2 (sesuai spesifikasi: admin dan member bisa invite member lain)
  const inv2 = await apiFetch(member1.token, 'POST', `/api/groups/${groupId}/invites`, { username: member2.user.username });
  assert.equal(inv2.success, true);

  const m2Invites = await apiFetch(member2.token, 'GET', '/api/group-invites');
  await apiFetch(member2.token, 'POST', `/api/group-invites/${m2Invites.invites[0].id}/accept`);

  // Member biasa tidak boleh mengeluarkan member lain
  const forbiddenKick = await apiFetch(member1.token, 'DELETE', `/api/groups/${groupId}/members/${member2.user.id}`);
  assert.equal(forbiddenKick.status, 403);

  // Owner mengangkat member1 menjadi admin
  const promoted = await apiFetch(owner.token, 'PATCH', `/api/groups/${groupId}/members/${member1.user.id}`, { role: 'admin' });
  assert.equal(promoted.success, true);

  // Admin sekarang boleh mengeluarkan member2 (member biasa)
  const adminKick = await apiFetch(member1.token, 'DELETE', `/api/groups/${groupId}/members/${member2.user.id}`);
  assert.equal(adminKick.success, true);

  // Owner tidak boleh keluar sendiri tanpa menghapus grup
  const ownerLeave = await apiFetch(owner.token, 'DELETE', `/api/groups/${groupId}/members/${owner.user.id}`);
  assert.equal(ownerLeave.success, false);
});

test('chat grup: kirim teks, kompresi foto (WebP) & voice note ke MinIO dengan presigned URL', async () => {
  const u = await register('chatter');
  const { group } = await apiFetch(u.token, 'POST', '/api/groups', { name: 'Grup Media' });

  // Kirim pesan teks
  const txtRes = await apiFetch(u.token, 'POST', `/api/groups/${group.id}/messages`, { text: 'Halo semuanya!' });
  assert.equal(txtRes.success, true);
  assert.equal(txtRes.message.type, 'text');
  assert.equal(txtRes.message.text, 'Halo semuanya!');

  // Buat gambar PNG 2400x1200 lalu unggah -> harus dikompresi ke WebP <= 1600px dan diunggah ke MinIO
  const pngBuffer = await sharp({
    create: { width: 2400, height: 1200, channels: 3, background: { r: 255, g: 98, b: 0 } }
  }).png().toBuffer();

  const imgForm = new FormData();
  imgForm.append('kind', 'image');
  imgForm.append('text', 'Foto papan');
  imgForm.append('file', new Blob([pngBuffer], { type: 'image/png' }), 'photo.png');

  const imgRes = await fetch(`${url}/api/groups/${group.id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u.token}` },
    body: imgForm
  }).then(r => r.json());

  assert.equal(imgRes.success, true);
  assert.equal(imgRes.message.type, 'image');
  assert.equal(imgRes.message.media.mime, 'image/webp');
  assert.equal(imgRes.message.media.width, 1600);
  assert.equal(imgRes.message.media.height, 800);
  assert.match(imgRes.message.media.url, /^https:\/\/minio\.local\/jakludo\/groups\//);

  // Unggah voice note (PCM WAV 8kHz mono valid -> dikompresi oleh ffmpeg ke Opus WebM atau fallback)
  const pcmDataSize = 1600;
  const wavHeader = Buffer.alloc(44);
  wavHeader.write('RIFF', 0);
  wavHeader.writeUInt32LE(36 + pcmDataSize, 4);
  wavHeader.write('WAVE', 8);
  wavHeader.write('fmt ', 12);
  wavHeader.writeUInt32LE(16, 16);     // Subchunk1Size (PCM)
  wavHeader.writeUInt16LE(1, 20);      // AudioFormat (1 = PCM)
  wavHeader.writeUInt16LE(1, 22);      // NumChannels (1 = mono)
  wavHeader.writeUInt32LE(8000, 24);   // SampleRate
  wavHeader.writeUInt32LE(16000, 28);  // ByteRate
  wavHeader.writeUInt16LE(2, 32);      // BlockAlign
  wavHeader.writeUInt16LE(16, 34);     // BitsPerSample
  wavHeader.write('data', 36);
  wavHeader.writeUInt32LE(pcmDataSize, 40);
  const validWav = Buffer.concat([wavHeader, Buffer.alloc(pcmDataSize, 0)]);

  const audioForm = new FormData();
  audioForm.append('kind', 'audio');
  audioForm.append('durationMs', '4500');
  audioForm.append('file', new Blob([validWav], { type: 'audio/wav' }), 'vn.wav');

  const audioRes = await fetch(`${url}/api/groups/${group.id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u.token}` },
    body: audioForm
  }).then(r => r.json());

  assert.equal(audioRes.success, true);
  assert.equal(audioRes.message.type, 'audio');
  assert.equal(audioRes.message.media.durationMs, 4500);
  assert.match(audioRes.message.media.url, /X-Amz-Expires=600/);

  // Endpoint stream playback voice note mengembalikan audio siap putar + mendukung Range
  const streamRes = await fetch(
    `${url}/api/groups/${group.id}/messages/${audioRes.message.id}/audio?token=${encodeURIComponent(u.token)}`,
    { headers: { Range: 'bytes=0-63' } }
  );
  assert.equal(streamRes.status, 206);
  assert.equal(streamRes.headers.get('accept-ranges'), 'bytes');
  const chunk = Buffer.from(await streamRes.arrayBuffer());
  assert.ok(chunk.length > 0 && chunk.length <= 64);
});

test('match grup hanya untuk anggota, poin & dadu sama dengan permainan biasa, dan tercatat di leaderboard grup', async () => {
  const p1 = await register('grp_p1');
  const p2 = await register('grp_p2');
  const outsider = await register('outsider');

  const { group } = await apiFetch(p1.token, 'POST', '/api/groups', { name: 'Liga Internal' });
  const inv = await apiFetch(p1.token, 'POST', `/api/groups/${group.id}/invites`, { username: p2.user.username });
  await apiFetch(p2.token, 'POST', `/api/group-invites/${inv.invite.id}/accept`);

  const globalBeforeP1 = db.getLeaderboard().find(e => e.userId === p1.user.id).points;

  // Buat match khusus grup
  const s1 = await connect();
  s1.emit('room:create', { token: p1.token, name: p1.user.name, groupId: group.id });
  const { code } = await once(s1, 'room:joined');

  // Pemain luar grup (outsider) ditolak masuk
  const sOut = await connect();
  const errPromise = once(sOut, 'room:error');
  sOut.emit('room:join', { code, token: outsider.token, name: outsider.user.name });
  assert.match(await errPromise, /khusus untuk anggota grup/);

  // Anggota grup (p2) berhasil masuk
  const s2 = await connect();
  s2.emit('room:join', { code, token: p2.token, name: p2.user.name });
  await once(s2, 'room:joined');

  const room = rooms.get(code);
  s1.emit('game:start');
  await wait(60);
  clearTimeout(room.turnTimer);

  // Dadu seimbang juga dipakai di room grup (catatan lemparan per pemain)
  s1.emit('game:roll');
  await wait(900);
  clearTimeout(room.turnTimer);
  assert.equal(room.players[0].diceStats.total, 1);

  // P1 memenangkan match grup
  engine.declareWinner(room, room.players[0]);
  await wait(80);

  // Poin global bertambah seperti permainan biasa: peringkat 1 dari 2 pemain (+30) + bonus harian (+5)
  const globalAfterP1 = db.getLeaderboard().find(e => e.userId === p1.user.id).points;
  assert.equal(globalAfterP1, globalBeforeP1 + 35, 'match grup memberi poin global yang sama');
  assert.deepEqual(room.matchResult.awards[room.players[0].id], { points: 30, dailyBonus: 5 });

  // Leaderboard grup mencatat poin peringkat yang sama (tanpa bonus harian): P1 +30, P2 +5
  const grpLb = await apiFetch(p1.token, 'GET', `/api/groups/${group.id}/leaderboard`);
  assert.equal(grpLb.success, true);
  assert.equal(grpLb.leaderboard[0].userId, p1.user.id);
  assert.equal(grpLb.leaderboard[0].wins, 1);
  assert.equal(grpLb.leaderboard[0].points, 30);
  assert.equal(grpLb.leaderboard[1].userId, p2.user.id);
  assert.equal(grpLb.leaderboard[1].wins, 0);
  assert.equal(grpLb.leaderboard[1].points, 5);
});

test('chat private antar teman, unggah avatar S3 terkompresi, dan event notifikasi realtime', async () => {
  const u1 = await register('dm_u1');
  const u2 = await register('dm_u2');
  const stranger = await register('dm_stranger');

  const sock1 = await connect();
  const sock2 = await connect();
  sock1.emit('social:identify', { token: u1.token });
  sock2.emit('social:identify', { token: u2.token });
  await wait(40);

  // 1) Unggah foto profil (avatar) 1000x600 -> otomatis di-crop & dikompres ke 256x256 WebP di MinIO S3
  const rawAvatar = await sharp({
    create: { width: 1000, height: 600, channels: 3, background: { r: 20, g: 140, b: 220 } }
  }).png().toBuffer();

  const avForm = new FormData();
  avForm.append('file', new Blob([rawAvatar], { type: 'image/png' }), 'profile.png');

  const avRes = await fetch(`${url}/api/auth/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u1.token}` },
    body: avForm
  }).then(r => r.json());

  assert.equal(avRes.success, true);
  assert.match(avRes.user.avatar, /^\/api\/users\/user_.*\/avatar\?key=avatars%2F/);

  // Ambil gambar avatar lewat endpoint publik -> harus berupa WebP 256x256
  const getAvRes = await fetch(`${url}${avRes.user.avatar}`);
  assert.equal(getAvRes.status, 200);
  assert.equal(getAvRes.headers.get('content-type'), 'image/webp');
  const avMeta = await sharp(Buffer.from(await getAvRes.arrayBuffer())).metadata();
  assert.equal(avMeta.format, 'webp');
  assert.equal(avMeta.width, 256);
  assert.equal(avMeta.height, 256);

  // 2) Event notifikasi permintaan pertemanan (friend:request & friend:accepted)
  const freqEvent = once(sock2, 'friend:request');
  await apiFetch(u1.token, 'POST', '/api/friends/request', { username: u2.user.username });
  const freqPayload = await freqEvent;
  assert.equal(freqPayload.from.userId, u1.user.id);

  const faccEvent = once(sock1, 'friend:accepted');
  await apiFetch(u2.token, 'POST', `/api/friends/${u1.user.id}/accept`);
  const faccPayload = await faccEvent;
  assert.equal(faccPayload.by.userId, u2.user.id);

  // 3) Chat private ke bukan teman harus ditolak
  const badDm = await apiFetch(u1.token, 'POST', `/api/friends/${stranger.user.id}/messages`, { text: 'Halo' });
  assert.equal(badDm.status, 403);

  // 4) Chat private antar teman (teks + foto WebP + realtime dm:message)
  const dmEvent = once(sock2, 'dm:message');
  const dmTxt = await apiFetch(u1.token, 'POST', `/api/friends/${u2.user.id}/messages`, {
    text: 'Halo bro, main Ludo yuk!'
  });
  assert.equal(dmTxt.success, true);
  assert.equal(dmTxt.message.text, 'Halo bro, main Ludo yuk!');
  const receivedDm = await dmEvent;
  assert.equal(receivedDm.id, dmTxt.message.id);
  assert.equal(receivedDm.sender.userId, u1.user.id);

  // Kirim foto di chat private
  const dmImgForm = new FormData();
  dmImgForm.append('kind', 'image');
  dmImgForm.append('text', 'Screenshot skor');
  dmImgForm.append('file', new Blob([rawAvatar], { type: 'image/png' }), 'shot.png');

  const dmImgRes = await fetch(`${url}/api/friends/${u1.user.id}/media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u2.token}` },
    body: dmImgForm
  }).then(r => r.json());

  assert.equal(dmImgRes.success, true);
  assert.equal(dmImgRes.message.type, 'image');
  assert.equal(dmImgRes.message.media.mime, 'image/webp');
  assert.match(dmImgRes.message.media.url, /^https:\/\/minio\.local\/jakludo\/dm\//);

  // Riwayat chat private memuat kedua pesan
  const dmHistory = await apiFetch(u1.token, 'GET', `/api/friends/${u2.user.id}/messages`);
  assert.equal(dmHistory.success, true);
  assert.equal(dmHistory.messages.length, 2);

  // 5) Buat grup, undang u2, angkat u2 menjadi Admin, lalu Admin mengganti foto ava grup
  const grpRes = await apiFetch(u1.token, 'POST', '/api/groups', { name: 'Klub Ludo Nasional' });
  assert.equal(grpRes.success, true);
  const groupId = grpRes.group.id;

  const invRes = await apiFetch(u1.token, 'POST', `/api/groups/${groupId}/invites`, {
    username: u2.user.username
  });
  await apiFetch(u2.token, 'POST', `/api/group-invites/${invRes.invite.id}/accept`);

  // Member biasa belum boleh mengganti foto ava grup (403)
  const memberAvForm = new FormData();
  memberAvForm.append('file', new Blob([rawAvatar], { type: 'image/png' }), 'grp.png');
  const forbiddenAv = await fetch(`${url}/api/groups/${groupId}/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u2.token}` },
    body: memberAvForm
  });
  assert.equal(forbiddenAv.status, 403);

  // Owner mengangkat u2 menjadi Admin
  await apiFetch(u1.token, 'PATCH', `/api/groups/${groupId}/members/${u2.user.id}`, { role: 'admin' });

  // Sekarang Admin (u2) mengganti foto ava grup -> dikompres 256x256 WebP di MinIO S3
  const adminAvForm = new FormData();
  adminAvForm.append('file', new Blob([rawAvatar], { type: 'image/png' }), 'grp.png');
  const grpAvRes = await fetch(`${url}/api/groups/${groupId}/avatar`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${u2.token}` },
    body: adminAvForm
  }).then(r => r.json());

  assert.equal(grpAvRes.success, true);
  assert.match(grpAvRes.group.avatar, /^\/api\/groups\/grp_.*\/avatar\?key=group-avatars%2F/);

  const getGrpAv = await fetch(`${url}${grpAvRes.group.avatar}`);
  assert.equal(getGrpAv.status, 200);
  assert.equal(getGrpAv.headers.get('content-type'), 'image/webp');
  const grpAvMeta = await sharp(Buffer.from(await getGrpAv.arrayBuffer())).metadata();
  assert.equal(grpAvMeta.format, 'webp');
  assert.equal(grpAvMeta.width, 256);
  assert.equal(grpAvMeta.height, 256);

  // 6) Lihat profil pemain lain (GET /api/users/:userId/profile)
  const profRes = await apiFetch(u2.token, 'GET', `/api/users/${u1.user.id}/profile`);
  assert.equal(profRes.success, true);
  assert.equal(profRes.profile.userId, u1.user.id);
  assert.equal(profRes.profile.username, u1.user.username);
  assert.equal(profRes.profile.friendshipStatus, 'friends');
  assert.equal(profRes.profile.friendCount, 1);
  assert.equal(profRes.profile.groupCount, 1);
  assert.equal(profRes.profile.sharedGroups.length, 1);
  assert.equal(profRes.profile.sharedGroups[0].id, groupId);
  assert.equal(profRes.profile.sharedGroups[0].avatar, grpAvRes.group.avatar);
});

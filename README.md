# JakLudo — React + Socket.IO

Game Ludo multiplayer realtime dengan React/Vite di sisi klien dan Node/Express/Socket.IO di sisi server. Room dibuat oleh server dan undangan memakai URL `?room=KODEROOM`. Satu room maksimal 4 pemain (manusia atau bot).

## Menjalankan secara lokal

Butuh Node.js 20+ dan PostgreSQL (opsional untuk test lokal, wajib untuk produksi lewat `DATABASE_URL`).

```bash
npm ci
cp .env.example .env
# Sesuaikan DATABASE_URL di .env, lalu jalankan migrasi:
npm run db:migrate
npm run dev
```

Buka http://localhost:5173. Untuk mencoba multiplayer, buka URL yang sama di beberapa profil browser atau perangkat.

## Test

```bash
npm test
```

Test memakai `node:test`: aturan main di `server/rules.test.js` dan integration test socket/HTTP di `server/server.test.js`. Test memakai folder data sementara, sehingga data di `server/data` tidak tersentuh.

## Production

```bash
npm run build
npm start
```

Server melayani folder `dist` dan Socket.IO pada `PORT` (default 5172). Panduan Docker + Nginx ada di [DEPLOYMENT.md](DEPLOYMENT.md).

Variabel lingkungan:

| Variabel | Default | Kegunaan |
| :--- | :--- | :--- |
| `PORT` | `5172` | Port HTTP/Socket.IO |
| `TRUST_PROXY` | `0` | Set `1` jika di belakang Nginx agar rate limit login memakai IP asli |
| `CORS_ORIGIN` | kosong | Daftar origin (dipisah koma) bila klien di-host di domain lain |
| `DATABASE_URL` | kosong | URL koneksi PostgreSQL (`postgresql://user:pass@host:5432/jakludo`) |
| `PGSSLMODE` | kosong | Set `require` atau `verify-full` jika PostgreSQL mewajibkan koneksi SSL |
| `JAKLUDO_DATA_DIR` | `server/data` | Folder data untuk backup & sumber migrasi otomatis `jakludo.db` lama |
| `S3_ENDPOINT` | kosong | Endpoint internal/publik MinIO S3 (`https://minio.contoh.com`) untuk unggah foto & voice note grup |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | Endpoint publik MinIO yang dipakai menandatangani presigned URL untuk browser pemain |
| `S3_ACCESS_KEY` | kosong | Access Key MinIO S3 |
| `S3_SECRET_KEY` | kosong | Secret Key MinIO S3 |
| `S3_BUCKET` | `jakludo` | Nama bucket privat di MinIO |
| `S3_REGION` | `us-east-1` | Region S3 / MinIO |
| `S3_FORCE_PATH_STYLE` | `true` | Path-style URL untuk kompatibilitas MinIO |

## Fitur Sosial, Grup & MinIO Media

- **Pertemanan & Undangan Match (`username`)**: Pemain terdaftar dapat menambah teman menggunakan `username`, melihat status online realtime, dan mengundang teman atau anggota grup langsung ke dalam lobby room.
- **Grup & Peran (`owner`, `admin`, `member`)**:
  - Semua anggota (`owner`, `admin`, `member`) dapat mengundang pemain lain ke grup melalui `username`.
  - `owner` (pembuat grup) dapat mengangkat/menurunkan `admin`, mengubah nama grup, mengeluarkan anggota, dan membubarkan grup.
  - `admin` dapat mengubah nama grup dan mengeluarkan `member` biasa.
- **Chat Grup, Foto & Voice Note Terkompresi (MinIO S3)**:
  - **Kompresi 2 Lapis**: Foto diperkecil di sisi browser (Canvas WebP maks 1600px, kualitas 0.75) lalu divalidasi & dikompres ulang di server dengan `sharp` (WebP kualitas 75, orientasi otomatis, tanpa EXIF). Voice note direkam di browser dengan `MediaRecorder` Opus 24 kbps (maks 2 menit) lalu dikompres ulang di server dengan `ffmpeg` (`libopus` 24 kbps mono WebM).
  - **Bucket Privat + Presigned URL**: File disimpan di bucket MinIO privat pada key `groups/<groupId>/<yyyy-mm>/<uuid>.<ext>` dan diakses melalui *presigned GET URL* berumur 10 menit yang hanya diberikan kepada anggota grup.
- **Match Khusus Grup & Leaderboard Grup**: Anggota grup dapat membuat room khusus grup (`room:create` dengan `groupId`). Hanya anggota grup tersebut yang dapat bergabung dan kartu undangan otomatis dikirim ke chat grup. Selain itu, aturan main, dadu, dan poin sama persis dengan room biasa: hasilnya menambah poin/leaderboard global (termasuk bonus harian) dan juga dicatat di `group_leaderboard` grup tersebut dengan poin peringkat yang sama (tanpa bonus harian).

## Migrasi Database (SQLite -> PostgreSQL)

Saat pertama kali dijalankan dengan `DATABASE_URL`, server otomatis:
1. Menerapkan seluruh file skema SQL di `server/migrations/*.sql` (dilacak pada tabel `schema_migrations` dengan PostgreSQL *advisory lock*).
2. Jika menemukan file SQLite lama (`server/data/jakludo.db`) atau JSON lama, seluruh data (`users`, `user_items`, `sessions`, `leaderboard`, `rooms`) otomatis dipindahkan ke PostgreSQL dalam satu transaksi idempoten, lalu file lama diubah namanya menjadi `jakludo.db.migrated-<timestamp>`.

Kamu juga bisa menjalankan migrasi atau mengecek status secara manual:
```bash
npm run db:migrate                              # jalankan skema + impor server/data/jakludo.db
node server/migrate.js --from-sqlite path.db    # impor eksplisit dari file SQLite tertentu
npm run db:status                               # cek versi migrasi & jumlah baris di PostgreSQL
npm run backup                                  # backup PostgreSQL (pg_dump / JSON)
```

## Aturan dadu

Dadu JakLudo bukan dadu random murni. Tujuannya tiga hal sekaligus:

1. **Adil**: tiap angka tetap keluar sekitar 1/6 dalam jangka panjang, dan keberuntungan antar pemain dalam satu permainan tidak timpang.
2. **Tidak terlalu random**: tidak ada pemain yang menunggu puluhan lemparan untuk keluar markas.
3. **Tidak gampang ditebak**: pemain yang mencatat semua lemparannya tetap tidak bisa yakin angka berikutnya.

Kodenya ada di `server/game/rules.js` (`captureFaces`, `diceWeights`, `rollWeighted`) dan dipanggil dari `handleRoll` di `server/game/engine.js`. Semua pengaturan ada di `DICE` pada `server/game/config.js`.

Aturan ini berlaku sama untuk room biasa dan room grup.

### Rumus

Setiap lemparan, server menghitung bobot untuk angka 1–6, lalu mengambil satu angka dengan sumber acak `crypto`:

```
bobot(f) = e^(beta × (n/6 − jumlah f yang sudah keluar))      koreksi defisit
         × (1 + gamma) × chainDecay^streak  jika f bisa makan  dorongan makan yang meluruh
```

- `n` = jumlah lemparan pemain itu di permainan ini.
- `streak` = berapa kali pemain itu makan berturut-turut di lemparannya sendiri. Rantai putus setiap kali lemparannya tidak makan, termasuk lemparan tanpa langkah dan hangus 3× angka 6.
- Kenaikan peluang angka makan dibatasi `maxAdd` poin persen.

| Pengaturan | Nilai | Arti | Nilai netral |
|---|---|---|---|
| `beta` | 0,3 | kekuatan koreksi defisit | 0 |
| `gamma` | 0,4 | dorongan untuk angka yang bisa memakan lawan | 0 |
| `maxAdd` | 0,06 | kenaikan maksimum peluang makan (6 poin persen) | 1 |
| `chainDecay` | 0,5 | pengali tiap makan beruntun | 1 |

`beta: 0, gamma: 0, chainDecay: 1` = dadu random murni seperti dulu.

Catatan lemparan (`diceStats`) disimpan per pemain, di-reset saat permainan mulai, ikut snapshot room di SQLite, dan **tidak dikirim ke klien**.

### 1. Koreksi defisit

Angka yang jarang keluar untuk pemain itu di permainan ini mendapat bobot sedikit lebih besar. Peluangnya tetap acak di setiap lemparan, tapi nasib buruk yang panjang pelan-pelan dikoreksi.

Simulasi 400–600 ribu lemparan per skema, satu permainan dihitung 50 lemparan per pemain:

| Skema | Permainan 4 pemain timpang 2×* | Terlama menunggu keluar markas | Tebakan terbaik benar** | Lemparan bisa ditebak ≥ 40% yakin |
|---|---|---|---|---|
| Random murni (dulu) | 48,5–51,8% | 35–42 lemparan | 16,7% | 0% |
| Kantong 1–6 dikocok | 0% | 9 | 40,8% | 33,3% |
| Kantong 12, sisakan 3 | 8,2% | 17 | 26,2% | 14,1% |
| Random teredam | 32,5% | 23 | 20,5% | 0% |
| Defisit β 0,20 | 5,8% | 28 | 22,2% | 0% |
| **Defisit β 0,30 (dipakai)** | **1,3%** | **22** | **24,1%** | **0,3%** |
| Defisit β 0,45 | 0,1% | 20 | 26,3% | 2,8% |

\* satu pemain mendapat angka 6 minimal dua kali lipat pemain lain.
\*\* penebak sempurna yang tahu rumus dan seluruh riwayat lemparan pemain itu; ini batas atas.

Kenapa "tebakan benar 24%" aman: di Ludo pemain wajib melempar setiap giliran, jadi tidak ada keputusan yang bisa memanfaatkan tebakan. Pemain biasa yang tidak mencatat semua lemparannya tetap menebak di sekitar 16,7%.

### 2. Dorongan makan yang meluruh

Sebelum dadu keluar, server mencari angka yang membuat salah satu bidak memakan bidak lawan (`captureFaces`). Bidak lawan yang terlindungi tidak dihitung: bidak di petak start warnanya sendiri, atau di petak bintang saat safe zone aktif.

Pengali angka makan turun setengah setiap kali pemain makan beruntun:

| Makan beruntun sebelumnya | Pengali | Peluang jika 1 angka bisa makan | Peluang jika 2 angka bisa makan |
|---|---|---|---|
| 0 (makan pertama) | 1,4 | 21,9% (normal 16,7%) | 39,3%, kena batas +6 poin (normal 33,3%) |
| 1 (makan kedua) | 0,7 | 12,3% | 25,9% |
| 2 (makan ketiga) | 0,35 | 6,5% | 14,9% |
| 3 (makan keempat) | 0,175 | 3,4% | 8,0% |

Angka di tabel dihitung tanpa koreksi defisit; di permainan, koreksi defisit menggeser sedikit naik atau turun.

#### Hasil di permainan penuh

Simulasi 3.000 permainan penuh per varian dengan aturan asli `rules.js`: 4 bot memakai AI JakLudo, safe zone aktif, Black Hole mati, bonus giliran dan hangus 3× angka 6 ikut dihitung.

| Dadu | Makan per permainan | Giliran dengan ≥ 2 makan | Permainan dengan giliran ≥ 3 makan | Permainan dengan 3 lemparan sendiri beruntun makan |
|---|---|---|---|---|
| Random murni (dulu) | 35,0 | 3,91 | 37,1% | 26,9% |
| Dorongan tanpa peluruhan (versi awal) | 45,4 | 5,40 | 52,1% | 40,1% |
| Redam ×0,4 setelah 2 makan | 45,0 | 4,75 | 32,6% | 14,5% |
| Meluruh d = 0,6 | 44,4 | 4,29 | 31,1% | 16,2% |
| **Meluruh d = 0,5 (dipakai)** | **44,1** | **3,91** | **27,2%** | **10,6%** |
| Meluruh d = 0,4 | 43,8 | 3,57 | 21,1% | 6,2% |

Dengan `chainDecay` 0,5:

- Makan sedikit lebih sering daripada dadu random murni (44 vs 35 per permainan), jadi permainan lebih seru.
- Makan 2 kali dalam satu giliran sama seringnya dengan dadu random murni.
- Makan 3 kali beruntun justru lebih jarang daripada dadu random murni (27% vs 37% permainan).
- Peluang menang tiap kursi tetap sekitar 25%, dan frekuensi tiap angka tetap 16,6–16,7%.

Biayanya, permainan sekitar 8–12% lebih panjang karena lebih banyak bidak yang dipulangkan ke markas.

### Dampak ke aturan lain

- **Hangus 3× angka 6** tetap bisa terjadi, hanya sedikit lebih jarang (sekitar 3,8 → 2,6 per 1.000 lemparan).
- **Keluar markas dengan 1 atau 6**: rata-rata tetap 3 lemparan; kasus terburuk turun dari 35–42 menjadi sekitar 22 lemparan.
- **Lemparan bonus, auto-play (AFK/terputus), dan bot** memakai dadu yang sama.
- **Reconnect dan restart server** tidak mengubah apa pun, karena catatan lemparan ikut snapshot room.

### Menyetel ulang

| Kalau terasa… | Ubah |
|---|---|
| makan terlalu sering secara umum | turunkan `gamma` (mis. 0,25) |
| makan beruntun masih terlalu sering | turunkan `chainDecay` (mis. 0,4) |
| keberuntungan antar pemain masih timpang | naikkan `beta` (mis. 0,35); di atas 0,45 dadu mulai lebih mudah ditebak |
| ingin kembali ke dadu biasa | `beta: 0, gamma: 0, chainDecay: 1` |

### Batasan

- Semua angka berasal dari simulasi Node.js, bukan data permainan sungguhan. Simulasi permainan penuh memakai 4 bot yang selalu mengejar lawan, jadi jumlah makan bersama pemain manusia akan lebih kecil; perbandingan antar varian tetap berlaku.
- Selisih antar putaran simulasi sekitar ±2 poin persen.
- Black Hole tidak ikut disimulasikan.

## Arsitektur singkat

```
server/
  index.js            bootstrap: Express, Socket.IO, inisialisasi PostgreSQL, restore room, shutdown
  db.js               PostgreSQL (pg.Pool) + write-through state: user, sesi, leaderboard, stok item, room
  migrate.js          migrasi skema SQL berversi & migrasi data dari SQLite (jakludo.db) ke PostgreSQL
  migrations/         file skema SQL berurutan (001_initial_schema.sql, dst.)
  backup.js           backup database tanpa menghentikan server (npm run backup)
  http/routes.js      REST API: auth, leaderboard, room aktif, toko
  realtime/socket.js  event Socket.IO -> aksi lobby/engine
  game/
    config.js         semua angka waktu & batas permainan
    rules.js          aturan main murni (gerak bidak, safe zone, pilihan bot)
    store.js          state room, broadcast ke klien, snapshot, siklus hidup room
    lobby.js          buat room, join/reconnect, bot, pemain keluar/terputus
    engine.js         giliran, dadu, langkah bidak, pemakaian item, keputusan perisai
    inventory.js      stok item per pemain (milik akun vs gratis dari pertandingan)
  items/
    index.js          registry & kontrak item
    *.js              satu file per item toko
```

Server mengirim daftar bidak yang boleh jalan (`room.movable`) dan katalog item (`/api/shop/items`) ke klien, jadi aturan dan item hanya didefinisikan di satu tempat.

### Menambah item toko baru

1. Buat file baru di `server/items/`, misalnya `double-dice.js`, yang meng-export definisi item: data toko (`id`, `name`, `icon`, `price`, `description`), `kind` (`active` / `passive` / `reactive`), lalu:
   - `use(ctx)` untuk item aktif (dipakai lewat tombol, sebelum melempar dadu), opsional `target: 'opponentPawn'`, `canUse(ctx)`, dan `attack: 'forceReturn'` jika serangannya boleh ditahan perisai lawan;
   - `hooks` untuk item pasif yang bereaksi otomatis pada event permainan (`capture`, `blackHole`);
   - `protects` + `protect(ctx)` untuk item reaktif: saat event di `protects` (`forceReturn`, `blackHole`) mengenai bidak pemiliknya, pemain mendapat popup untuk memakai item atau tidak (bot dan pemain terputus otomatis memakai, waktu habis juga berarti dipakai).
   Kontrak lengkap dan helper yang tersedia di `ctx` ada di komentar `server/items/index.js`.
2. Daftarkan di array `ITEMS` pada `server/items/index.js`.

Toko, inventaris, tombol pemakaian, dan stok di database ikut menyesuaikan tanpa mengubah file lain. Kalau item butuh event permainan baru, tambahkan satu pemanggilan `runItemHooks(room, player, '<event>', data)` di `server/game/engine.js`.

Room aktif berjalan di memori dan disimpan sebagai snapshot ke SQLite setiap ada perubahan, sehingga restart atau deploy ulang tidak menghapus permainan. Pemain tinggal tersambung ulang ke kursinya. Siklus hidup room:
- Lobby tanpa pemain yang tersambung dihapus setelah 5 menit. Kursi pembuat room ditahan selama room masih ada, kursi pemain lain ditahan 2 menit.
- Permainan yang sedang berjalan hanya dihapus jika semua pemain manusia sudah OUT.
- Permainan yang selesai dihapus 5 menit kemudian (memberi waktu untuk "Main Lagi").

Untuk menjalankan lebih dari satu instance, dibutuhkan adapter Socket.IO bersama dan penyimpanan room terpusat.

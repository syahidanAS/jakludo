# Peluang dadu JakLudo

Dadu JakLudo bukan dadu random murni. Tujuannya tiga hal sekaligus:

1. **Adil**: tiap angka tetap keluar sekitar 1/6 dalam jangka panjang, dan keberuntungan antar pemain dalam satu permainan tidak timpang.
2. **Tidak terlalu random**: tidak ada pemain yang menunggu puluhan lemparan untuk keluar markas.
3. **Tidak gampang ditebak**: pemain yang mencatat semua lemparannya tetap tidak bisa yakin angka berikutnya.

Kodenya ada di `server/game/rules.js` (`captureFaces`, `diceWeights`, `rollWeighted`) dan dipanggil dari `handleRoll` di `server/game/engine.js`. Semua pengaturan ada di `DICE` pada `server/game/config.js`.

## Rumus

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

## 1. Koreksi defisit

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

## 2. Dorongan makan yang meluruh

Sebelum dadu keluar, server mencari angka yang membuat salah satu bidak memakan bidak lawan (`captureFaces`). Bidak lawan yang terlindungi tidak dihitung: bidak di petak start warnanya sendiri, atau di petak bintang saat safe zone aktif.

Pengali angka makan turun setengah setiap kali pemain makan beruntun:

| Makan beruntun sebelumnya | Pengali | Peluang jika 1 angka bisa makan | Peluang jika 2 angka bisa makan |
|---|---|---|---|
| 0 (makan pertama) | 1,4 | 21,9% (normal 16,7%) | 39,3%, kena batas +6 poin (normal 33,3%) |
| 1 (makan kedua) | 0,7 | 12,3% | 25,9% |
| 2 (makan ketiga) | 0,35 | 6,5% | 14,9% |
| 3 (makan keempat) | 0,175 | 3,4% | 8,0% |

Angka di tabel dihitung tanpa koreksi defisit; di permainan, koreksi defisit menggeser sedikit naik atau turun.

### Hasil di permainan penuh

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

## Dampak ke aturan lain

- **Hangus 3× angka 6** tetap bisa terjadi, hanya sedikit lebih jarang (sekitar 3,8 → 2,6 per 1.000 lemparan).
- **Keluar markas dengan 1 atau 6**: rata-rata tetap 3 lemparan; kasus terburuk turun dari 35–42 menjadi sekitar 22 lemparan.
- **Lemparan bonus, auto-play (AFK/terputus), dan bot** memakai dadu yang sama.
- **Reconnect dan restart server** tidak mengubah apa pun, karena catatan lemparan ikut snapshot room.

## Menyetel ulang

| Kalau terasa… | Ubah |
|---|---|
| makan terlalu sering secara umum | turunkan `gamma` (mis. 0,25) |
| makan beruntun masih terlalu sering | turunkan `chainDecay` (mis. 0,4) |
| keberuntungan antar pemain masih timpang | naikkan `beta` (mis. 0,35); di atas 0,45 dadu mulai lebih mudah ditebak |
| ingin kembali ke dadu biasa | `beta: 0, gamma: 0, chainDecay: 1` |

## Batasan

- Semua angka berasal dari simulasi Node.js, bukan data permainan sungguhan. Simulasi permainan penuh memakai 4 bot yang selalu mengejar lawan, jadi jumlah makan bersama pemain manusia akan lebih kecil; perbandingan antar varian tetap berlaku.
- Selisih antar putaran simulasi sekitar ±2 poin persen.
- Black Hole tidak ikut disimulasikan.

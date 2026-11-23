-- Perbarui deskripsi skin Ocean Blue agar mencantumkan kemampuan Hint Langkah Terbaik
UPDATE ludo_skins
SET
  description = 'Bidak biru samudra dengan inti mutiara laut. Dilengkapi kemampuan Hint Langkah Terbaik yang menyalakan bidak paling menguntungkan berurutan dari peluang tertinggi.',
  updated_at = NOW()
WHERE
  id = 'ocean_blue'
  AND description = 'Bidak biru samudra dengan inti mutiara laut yang tenang dan berkelas.';

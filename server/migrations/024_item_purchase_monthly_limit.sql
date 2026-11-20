-- Migrasi 024: Batas pembelian item toko per pemain per bulan (WIB), agar unsur pay-to-win terkendali.
-- Satu baris per (pemain, item, bulan 'YYYY-MM'). Penghitung dinaikkan dalam transaksi pembelian
-- dengan syarat masih di bawah batas, jadi pembelian paralel tidak bisa menembus batas.
CREATE TABLE IF NOT EXISTS item_purchase_monthly (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL,
  period CHAR(7) NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, item_id, period)
);

CREATE INDEX IF NOT EXISTS item_purchase_monthly_period_idx ON item_purchase_monthly (period);

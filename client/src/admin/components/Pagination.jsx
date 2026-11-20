import React from 'react';

export default function Pagination({ page, totalPages, total, pageSize, onPageChange, onPageSizeChange }) {
  if (!total && total !== 0) return null;

  return (
    <div className="adm-pagination">
      <div className="adm-pagination__info">
        Menampilkan halaman <strong>{page}</strong> dari <strong>{totalPages}</strong> ({total.toLocaleString('id-ID')} data)
      </div>
      <div className="adm-pagination__controls">
        {onPageSizeChange && (
          <select
            className="adm-select adm-select--sm"
            aria-label="Jumlah data per halaman"
            value={pageSize}
            onChange={e => onPageSizeChange(Number(e.target.value))}
          >
            {[10, 20, 50, 100].map(sz => (
              <option key={sz} value={sz}>
                {sz} / hal
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="adm-btn adm-btn--secondary adm-btn--sm"
          disabled={page <= 1}
          onClick={() => onPageChange(page - 1)}
        >
          ← Sebelumnya
        </button>
        <button
          type="button"
          className="adm-btn adm-btn--secondary adm-btn--sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Berikutnya →
        </button>
      </div>
    </div>
  );
}

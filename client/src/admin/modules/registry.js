export const ADMIN_MODULES = [
  {
    id: 'overview',
    path: '/admin',
    group: 'Operasional Inti',
    label: 'Ringkasan',
    subtitle: 'Statistik platform, kesehatan server, dan aktivitas terbaru',
    icon: 'grid',
    ready: true
  },
  {
    id: 'users',
    path: '/admin/users',
    group: 'Operasional Inti',
    label: 'Manajemen User',
    subtitle: 'CRUD akun pemain & admin, saldo, inventaris, dan kontrol sesi',
    icon: 'users',
    ready: true
  },
  {
    id: 'rooms',
    path: '/admin/rooms',
    group: 'Operasional Inti',
    label: 'Room Aktif',
    subtitle: 'Monitoring realtime room JakLudo, Quiz, Chess Master & Ular Tangga',
    icon: 'radio',
    ready: true
  },
  {
    id: 'finance',
    path: '/admin/finance',
    group: 'Operasional Inti',
    label: 'Transaksi & Keuangan',
    subtitle: 'Order top-up, verifikasi gateway, ledger mutasi, webhook & penyesuaian saldo',
    icon: 'wallet',
    ready: true
  },
  {
    id: 'catalog',
    path: '/admin/catalog',
    group: 'Modul Berikutnya',
    label: 'Katalog, Paket & Skin',
    subtitle: 'Pengaturan kurs, paket top-up, item & skin Ludo (juga tersedia di Toko PlayGo)',
    icon: 'layers',
    ready: false
  },
  {
    id: 'security',
    path: '/admin/security',
    group: 'Modul Berikutnya',
    label: 'Audit & Pengaturan',
    subtitle: 'Pengaturan sistem, moderasi referral, dan riwayat audit terpusat',
    icon: 'shield',
    ready: false
  }
];

export function resolveModuleFromPath(pathname) {
  const clean = String(pathname || '/admin').replace(/\/+$/, '') || '/admin';
  const found = ADMIN_MODULES.find(m => m.path === clean && m.ready);
  return found ? found.id : 'overview';
}

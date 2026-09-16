# KARSA Finance System — Supabase Complete

Versi ini mempertahankan struktur KARSA Finance sebelumnya dan diperbaiki agar frontend konsisten dengan schema Supabase.

## Login
- Tidak ada form Daftar/Registrasi publik.
- Buat akun dari Supabase Dashboard → Authentication → Users.
- Isi `config.js` dengan Project URL + Publishable key/anon public key.
- Jangan pernah menaruh service_role/secret key di frontend.

## Database
Jalankan `supabase-schema-complete.sql` di Supabase SQL Editor. Script ini:
- membuat tabel finance, inventory, HPP, jurnal, audit;
- membuat Chart of Accounts;
- membuat Kas Utama dan Bank Utama jika belum ada;
- membuat profile untuk Auth user yang sudah ada;
- membuat RPC atomic untuk transaksi kas, penjualan, dan pembelian;
- memasang RLS dasar.

## Export
- CSV per modul untuk Excel/Google Sheets.
- XLSX multi-sheet untuk Excel dan Google Sheets.
- Workbook menyertakan sheet data + sheet rumus kas, HPP, jurnal, dan laba/rugi.

## Catatan
Untuk laporan resmi perpajakan/akuntansi perusahaan, lakukan review oleh orang yang bertanggung jawab atas pembukuan perusahaan.

## V3 — Finance hardening
Jalankan `supabase-schema-v3.sql` setelah `supabase-schema-complete.sql`. Migrasi ini menambahkan:
- Penambahan dan pengurangan saldo awal Kas/Bank dengan jurnal otomatis.
- Pembuatan rekening Kas/Bank baru.
- Pembayaran Piutang dan Hutang dengan jurnal + mutasi kas.
- Stok masuk/keluar/penyesuaian yang memperbarui stok produk secara atomik.
- Item produk pada penjualan/pembelian dan penghitungan HPP saat item penjualan dicatat.
- View HPP dengan field ukuran, kain, stok, reorder, dan status produk.

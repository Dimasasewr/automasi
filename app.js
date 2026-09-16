/* KARSA Finance System — production-style client layer
   Supabase Auth + PostgreSQL + double-entry journals + CSV/XLSX export.
   No public registration: users are created in Supabase Authentication. */
(() => {
  'use strict';

  const SB_URL = String(window.KARSA_CONFIG?.SUPABASE_URL || '').trim();
  const SB_KEY = String(window.KARSA_CONFIG?.SUPABASE_KEY || '').trim();
  const DEMO_MODE = Boolean(window.KARSA_CONFIG?.DEMO_MODE);
  const state = {
    transactions: [], sales: [], purchases: [], ar: [], ap: [], arPayments: [], apPayments: [],
    products: [], hpp: [], journals: [], journalLines: [], accounts: [], cashAccounts: [], costComponents: [], stockMovements: [], profile: null, saleItems: [], purchaseItems: []
  };
  let sb = null;
  let user = null;
  let toastTimer = null;

  const $ = id => document.getElementById(id);
  const num = v => {
    const n = Number(String(v ?? '').replace(/[^0-9.-]/g, ''));
    return Number.isFinite(n) ? n : 0;
  };
  const money = v => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num(v));
  const dateToday = () => new Date().toISOString().slice(0, 10);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
  const slug = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'data';
  const configured = () => !!(SB_URL && SB_KEY && !/PASTE_/i.test(SB_URL) && !/PASTE_/i.test(SB_KEY));

  function toast(text, ok = true) {
    const el = $('toast'); if (!el) return;
    el.textContent = text; el.classList.toggle('error', !ok); el.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
  }
  function authMessage(text, ok = false) {
    const el = $('authMessage'); if (!el) return;
    el.textContent = text; el.className = 'auth-message ' + (ok ? 'ok' : 'error');
  }
  function setLoader(text) { if ($('loaderStatus')) $('loaderStatus').textContent = text; }
  function showLoader(on) { $('loader')?.classList.toggle('hidden', !on); }
  function showAuth() { $('auth')?.classList.remove('hidden'); $('app')?.classList.add('hidden'); }
  function showApp() { $('auth')?.classList.add('hidden'); $('app')?.classList.remove('hidden'); }

  function errorText(error) {
    if (!error) return 'Terjadi kesalahan.';
    return error.message || error.details || error.hint || 'Terjadi kesalahan pada Supabase.';
  }
  async function withTimeout(promise, ms = 12000, label = 'Permintaan Supabase') {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout setelah ${Math.round(ms / 1000)} detik.`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async function query(table, columns = '*', order = 'created_at', ascending = false) {
    let q = sb.from(table).select(columns);
    if (order) q = q.order(order, { ascending });
    const { data, error } = await withTimeout(q, 12000, `Memuat ${table}`);
    if (error) throw error;
    return data || [];
  }
  async function insert(table, row) {
    const payload = { ...row };
    if (user && ['transactions','sales','purchases','ar_payments','ap_payments','products','stock_movements','journal_headers'].includes(table)) payload.created_by = user.id;
    const { data, error } = await withTimeout(sb.from(table).insert(payload).select().single(), 12000, `Menyimpan ${table}`);
    if (error) throw error;
    return data;
  }

  async function loadAll() {
    const tasks = [
      ['transactions','transactions','transaction_date'], ['sales','sales','sale_date'], ['purchases','purchases','purchase_date'],
      ['accounts_receivable','ar','invoice_date'], ['accounts_payable','ap','invoice_date'], ['ar_payments','arPayments','payment_date'],
      ['ap_payments','apPayments','payment_date'], ['products','products','created_at'], ['accounts','accounts','code'],
      ['cash_accounts','cashAccounts','created_at'], ['journal_headers','journals','journal_date'],
      ['v_product_hpp','hpp','name'], ['product_cost_components','costComponents','created_at'], ['stock_movements','stockMovements','movement_date'], ['sale_items','saleItems','created_at'], ['purchase_items','purchaseItems','created_at']
    ];

    const results = await Promise.allSettled(tasks.map(([table, key, order]) => query(table, '*', order, false)));
    const warnings = [];
    results.forEach((result, i) => {
      const [table, key] = tasks[i];
      if (result.status === 'fulfilled') {
        state[key] = result.value || [];
      } else {
        state[key] = [];
        warnings.push(`${table}: ${errorText(result.reason)}`);
        console.warn('[KARSA Finance] Gagal memuat', table, result.reason);
      }
    });

    try {
      state.journalLines = await query('journal_lines', '*', 'line_no', true);
    } catch (e) {
      state.journalLines = [];
      warnings.push(`journal_lines: ${errorText(e)}`);
    }

    try {
      const { data, error } = await withTimeout(
        sb.from('profiles').select('*').eq('id', user.id).maybeSingle(),
        12000,
        'Memuat profile'
      );
      if (error) throw error;
      state.profile = data;
    } catch (e) {
      state.profile = null;
      console.warn('[KARSA Finance] Profile tidak dapat dimuat:', e);
    }

    window.KARSA_STATE = state;
    return warnings;
  }

  function account(code) { return state.accounts.find(a => a.code === code); }
  function accountId(code) { return account(code)?.id || null; }
  function cashId() { return state.cashAccounts[0]?.id || null; }
  function ensureAccount(code, label) { const id = accountId(code); if (!id) throw new Error(`Akun ${code} (${label}) belum ada. Jalankan SQL database KARSA terlebih dahulu.`); return id; }
  function ensureCash() { const id = cashId(); if (!id) throw new Error('Belum ada Kas/Bank. Buat minimal satu rekening di Supabase atau jalankan SQL setup KARSA.'); return id; }
  function nextNo(prefix, rows, field) {
    const max = rows.reduce((m, r) => { const x = String(r[field] || '').match(/(\d+)$/); return x ? Math.max(m, Number(x[1])) : m; }, 0);
    return `${prefix}-${String(max + 1).padStart(5, '0')}`;
  }

  async function createJournal({ type, date, description, sourceType, sourceId, lines }) {
    const clean = lines.filter(x => num(x.debit) > 0 || num(x.credit) > 0).map((x, i) => ({ ...x, debit: num(x.debit), credit: num(x.credit), line_no: i + 1 }));
    const debit = clean.reduce((s, x) => s + x.debit, 0);
    const credit = clean.reduce((s, x) => s + x.credit, 0);
    if (!clean.length) throw new Error('Jurnal tidak memiliki baris.');
    if (Math.abs(debit - credit) > 0.01) throw new Error(`Jurnal tidak balance. Debit ${money(debit)} ≠ Kredit ${money(credit)}.`);
    for (const line of clean) if (!line.account_id) throw new Error('Ada akun jurnal yang belum tersedia. Jalankan SQL setup.');
    const header = await insert('journal_headers', {
      journal_no: nextNo('JRN', state.journals, 'journal_no'), journal_date: date || dateToday(), journal_type: type,
      source_type: sourceType || null, source_id: sourceId || null, description, status: 'posted'
    });
    const { error } = await withTimeout(sb.from('journal_lines').insert(clean.map(x => ({ journal_id: header.id, line_no: x.line_no, account_id: x.account_id, description: x.description || description, debit: x.debit, credit: x.credit }))), 12000, 'Menyimpan detail jurnal');
    if (error) throw error;
    return header;
  }

  async function addCashTransaction(data) {
    const amount = num(data.cash_in) || num(data.cash_out);
    const direction = num(data.cash_in) > 0 ? 'in' : 'out';
    if ((num(data.cash_in) > 0) === (num(data.cash_out) > 0)) throw new Error('Isi salah satu: Uang Masuk atau Uang Keluar.');
    const { data: row, error } = await withTimeout(sb.rpc('post_cash_transaction', {
      p_date: data.transaction_date || dateToday(), p_direction: direction, p_category: data.category, p_amount: amount,
      p_cash_account_id: data.cash_account_id || null, p_description: String(data.description || '').trim(),
      p_reference: data.reference_no || null, p_pic: data.pic || null
    }), 12000, 'Menyimpan transaksi kas');
    if (error) throw error;
    return row;
  }

  function formField(label, name, type = 'text', value = '', extra = '') {
    return `<div class="field"><label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label></div>`;
  }
  function selectField(label, name, options, value = '', extra = '') {
    return `<div class="field"><label>${esc(label)}<select name="${esc(name)}" ${extra}><option value="">Pilih...</option>${options.map(o => `<option value="${esc(o.value)}" ${String(o.value)===String(value)?'selected':''}>${esc(o.label)}</option>`).join('')}</select></label></div>`;
  }
  function modal(title, eyebrow, html, onSubmit) {
    $('modalEyebrow').textContent = eyebrow; $('modalTitle').textContent = title; $('modalForm').innerHTML = html + '<div class="form-actions"><button type="button" class="close-form" id="cancelForm">Batal</button><button class="gold-btn" type="submit">Simpan & Posting</button></div>';
    $('modal').classList.remove('hidden');
    $('cancelForm').onclick = closeModal;
    $('modalForm').onsubmit = async e => { e.preventDefault(); const fd = new FormData(e.currentTarget); try { await onSubmit(fd); closeModal(); await refresh(); toast('Data berhasil disimpan.'); } catch (err) { toast(errorText(err), false); } };
  }
  function closeModal() { $('modal')?.classList.add('hidden'); $('modalForm').innerHTML = ''; }

  function cashOptions() { return state.cashAccounts.filter(c=>c.active!==false).map(c => ({ value: c.id, label: `${c.name} (${c.account_type === 'bank' ? 'Bank' : 'Kas'})` })); }
  function productOptions(){return state.products.filter(p=>p.active!==false).map(p=>({value:p.id,label:`${p.sku} — ${p.name} (stok ${num(p.stock_qty)})`}));}
  function transactionModal() {
    const cash = cashOptions();
    modal('Tambah transaksi', 'TRANSACTION', `<div class="form-grid">
      ${formField('Tanggal','transaction_date','date',dateToday(),'required')}
      ${selectField('Jenis','direction',[{value:'in',label:'Uang Masuk'},{value:'out',label:'Uang Keluar'}],'in','required')}
      ${selectField('Kategori','category',[{value:'Penjualan',label:'Penjualan'},{value:'Modal',label:'Modal'},{value:'Pelunasan Piutang',label:'Pelunasan Piutang'},{value:'Pendapatan Lain',label:'Pendapatan Lain'},{value:'Pembelian',label:'Pembelian'},{value:'Pengeluaran',label:'Pengeluaran'},{value:'Bayar Hutang',label:'Bayar Hutang'},{value:'Prive',label:'Prive'}],'','required')}
      ${formField('Nominal','amount','number','','min="0" step="0.01" required')}
      ${selectField('Kas / Bank','cash_account_id',cash,'',cash.length?'required':'')}
      ${formField('Referensi','reference_no','text','','placeholder="Invoice / bukti"')}
      ${formField('PIC','pic','text','','placeholder="Nama PIC"')}
      <div class="field full"><label>Keterangan<textarea name="description" rows="3" required></textarea></label></div>
    </div>`, async fd => {
      const direction=fd.get('direction'), amount=num(fd.get('amount')); if(amount<=0)throw new Error('Nominal harus lebih dari 0.');
      await addCashTransaction({transaction_date:fd.get('transaction_date'),category:fd.get('category'),description:fd.get('description'),cash_account_id:fd.get('cash_account_id'),cash_in:direction==='in'?amount:0,cash_out:direction==='out'?amount:0,reference_no:fd.get('reference_no'),pic:fd.get('pic'),source_type:'manual'});
    });
  }
  function openingModal(){
    modal('Kelola saldo awal','OPENING BALANCE',`<div class="notice">Saldo awal adalah saldo yang menjadi titik awal Kas/Bank. <b>Penambahan</b> menaikkan saldo awal; <b>Pengurangan</b> menurunkannya. Sistem otomatis membuat jurnal penyesuaian agar pembukuan tetap balance.</div><div class="form-grid">
      ${selectField('Kas / Bank','cash_account_id',cashOptions(),'','required')}
      ${selectField('Aksi','direction',[{value:'increase',label:'Penambahan saldo awal'},{value:'decrease',label:'Pengurangan saldo awal'}],'increase','required')}
      ${formField('Nominal','amount','number','','min="0.01" step="0.01" required')}
      ${formField('Tanggal','date','date',dateToday(),'required')}
      <div class="field full"><label>Catatan<textarea name="note" rows="3" placeholder="Contoh: koreksi saldo pembukaan rekening"></textarea></label></div>
    </div>`,async fd=>{const amount=num(fd.get('amount'));if(amount<=0)throw new Error('Nominal harus lebih dari 0.');const {error}=await withTimeout(sb.rpc('post_opening_balance_adjustment',{p_cash_account_id:fd.get('cash_account_id'),p_direction:fd.get('direction'),p_amount:amount,p_date:fd.get('date')||dateToday(),p_note:fd.get('note')||null}),12000,'Mengubah saldo awal');if(error)throw error;});
  }
  function cashAccountModal(){
    modal('Tambah Kas / Bank','CASH ACCOUNT',`<div class="form-grid">${formField('Nama Rekening','name','text','','placeholder="Kas Utama / BCA / Mandiri" required')}${selectField('Jenis','account_type',[{value:'cash',label:'Kas'},{value:'bank',label:'Bank'}],'bank','required')}${formField('Saldo Awal','opening_balance','number','0','min="0" step="0.01"') }<div class="field full"><div class="notice">Jika saldo awal diisi, sistem langsung membuat jurnal pembukaan.</div></div></div>`,async fd=>{const amount=num(fd.get('opening_balance'));const {error}=await withTimeout(sb.rpc('create_cash_account',{p_name:fd.get('name'),p_account_type:fd.get('account_type'),p_opening_balance:amount}),12000,'Membuat Kas/Bank');if(error)throw error;});
  }
  function saleModal(){
    modal('Tambah penjualan','SALES',`<div class="form-grid">
      ${formField('Tanggal','sale_date','date',dateToday(),'required')}${formField('Pelanggan','customer_name','text','','placeholder="Nama pelanggan"')}
      ${formField('Total Penjualan','total','number','','min="0" step="0.01" required')}${formField('Dibayar','paid','number','0','min="0" step="0.01" required')}
      ${formField('Jatuh Tempo','due_date','date')}${selectField('Kas / Bank','cash_account_id',cashOptions())}
      <div class="field full"><label>Item produk <span class="field-help">Satu per baris: SKU | Qty | Harga jual. Boleh kosong jika hanya mencatat total.</span><textarea name="items" rows="5" placeholder="KLS-001 | 2 | 125000"></textarea></label></div>
    </div>`,async fd=>{
      const total=num(fd.get('total')),paid=num(fd.get('paid'));if(total<=0)throw new Error('Total penjualan harus lebih dari 0.');if(paid<0||paid>total)throw new Error('Nominal dibayar tidak valid.');
      const items=parseItems(String(fd.get('items')||''),'sale');
      const {error}=await withTimeout(sb.rpc('post_sale_v2',{p_date:fd.get('sale_date')||dateToday(),p_customer:fd.get('customer_name')||null,p_total:total,p_paid:paid,p_due:fd.get('due_date')||null,p_cash_account_id:fd.get('cash_account_id')||null,p_items:items}),15000,'Menyimpan penjualan');if(error)throw error;
    });
  }
  function purchaseModal(){
    modal('Tambah pembelian','PURCHASES',`<div class="form-grid">
      ${formField('Tanggal','purchase_date','date',dateToday(),'required')}${formField('Supplier','supplier_name','text','','placeholder="Nama supplier"')}
      ${formField('Total Pembelian','total','number','','min="0" step="0.01" required')}${formField('Dibayar','paid','number','0','min="0" step="0.01" required')}
      ${formField('Jatuh Tempo','due_date','date')}${selectField('Kas / Bank','cash_account_id',cashOptions())}
      <div class="field full"><label>Item pembelian <span class="field-help">Satu per baris: SKU | Qty | Harga modal. SKU boleh kosong untuk biaya/bahan non-stok.</span><textarea name="items" rows="5" placeholder="KLS-001 | 10 | 70000\nBahan kain | 5 | 25000"></textarea></label></div>
    </div>`,async fd=>{
      const total=num(fd.get('total')),paid=num(fd.get('paid'));if(total<=0)throw new Error('Total pembelian harus lebih dari 0.');if(paid<0||paid>total)throw new Error('Nominal dibayar tidak valid.');
      const items=parseItems(String(fd.get('items')||''),'purchase');
      const {error}=await withTimeout(sb.rpc('post_purchase_v2',{p_date:fd.get('purchase_date')||dateToday(),p_supplier:fd.get('supplier_name')||null,p_total:total,p_paid:paid,p_due:fd.get('due_date')||null,p_cash_account_id:fd.get('cash_account_id')||null,p_items:items}),15000,'Menyimpan pembelian');if(error)throw error;
    });
  }
  function parseItems(text,type){
    const out=[];for(const line of text.split('\n').map(x=>x.trim()).filter(Boolean)){const parts=line.split('|').map(x=>x.trim());if(parts.length<3)throw new Error('Format item salah. Gunakan SKU | Qty | Harga.');const key=parts[0],qty=num(parts[1]),price=num(parts[2]);if(qty<=0)throw new Error('Qty item harus lebih dari 0.');if(type==='sale'){const prod=state.products.find(p=>p.sku.toLowerCase()===key.toLowerCase()||p.id===key);if(!prod)throw new Error(`SKU ${key} tidak ditemukan.`);out.push({product_id:prod.id,qty,unit_price:price||num(prod.selling_price)});}else{const prod=state.products.find(p=>p.sku.toLowerCase()===key.toLowerCase()||p.id===key);out.push({product_id:prod?.id||null,description:prod?.name||key,qty,unit_cost:price});}}return out;
  }
  function productModal(){
    modal('Tambah produk & HPP','PRODUCT / HPP',`<div class="form-grid">
      ${formField('SKU','sku','text','','required')}${formField('Nama Produk','name','text','','required')}${formField('Ukuran','size','text','','placeholder="S / M / L / XL"')}${formField('Jenis Kain','fabric_type','text')}
      ${formField('Harga Jual','selling_price','number','0','min="0" step="0.01" required')}${formField('Stok Awal','stock_qty','number','0','min="0" step="0.001"')}${formField('Batas Reorder','reorder_level','number','0','min="0" step="0.001"')}
      <div class="field full"><label>Komponen HPP <span class="field-help">nama|kelompok|qty|harga satuan</span><textarea name="components" rows="8" placeholder="Kain Utama|bahan|1|45000\nPackaging|packaging|1|500\nProduksi|produksi|1|15000"></textarea></label></div>
    </div>`,async fd=>{
      const row=await insert('products',{sku:fd.get('sku').trim(),name:fd.get('name').trim(),size:fd.get('size')||null,fabric_type:fd.get('fabric_type')||null,selling_price:num(fd.get('selling_price')),stock_qty:num(fd.get('stock_qty')),reorder_level:num(fd.get('reorder_level')),active:true});
      const lines=String(fd.get('components')||'').split('\n').map(x=>x.trim()).filter(Boolean),allowed=new Set(['bahan','produksi','packaging','aksesoris']);
      for(const line of lines){const [name,group='bahan',qty='1',cost='0']=line.split('|').map(x=>x.trim());if(!name)continue;await insert('product_cost_components',{product_id:row.id,component_group:allowed.has(group.toLowerCase())?group.toLowerCase():'bahan',component_name:name,unit:'pcs',qty:num(qty),unit_cost:num(cost)});}
      if(num(fd.get('stock_qty'))>0){await insert('stock_movements',{movement_no:nextNo('STK',state.stockMovements,'movement_no'),movement_date:dateToday(),product_id:row.id,movement_type:'in',qty:num(fd.get('stock_qty')),unit_cost:0,source_type:'opening',note:'Stok awal',created_by:user?.id});}
    });
  }
  function stockMovementModal(){
    modal('Penyesuaian stok','STOCK',`<div class="form-grid">${selectField('Produk','product_id',productOptions(),'','required')}${selectField('Jenis','movement_type',[{value:'in',label:'Stok Masuk'},{value:'out',label:'Stok Keluar'},{value:'adjustment',label:'Setel stok akhir'}],'in','required')}${formField('Qty','qty','number','','min="0.001" step="0.001" required')}${formField('Harga per Unit','unit_cost','number','0','min="0" step="0.01"')}${formField('Tanggal','movement_date','date',dateToday(),'required')}<div class="field full"><label>Catatan<textarea name="note" rows="3"></textarea></label></div></div>`,async fd=>{const {error}=await withTimeout(sb.rpc('post_stock_movement',{p_product_id:fd.get('product_id'),p_type:fd.get('movement_type'),p_qty:num(fd.get('qty')),p_unit_cost:num(fd.get('unit_cost')),p_date:fd.get('movement_date')||dateToday(),p_note:fd.get('note')||null}),12000,'Menyimpan stok');if(error)throw error;});
  }
  function arPaymentModal(){
    const rows=state.ar.filter(x=>num(x.amount)-num(x.paid)>0);modal('Terima pembayaran piutang','RECEIVABLES',`<div class="form-grid">${selectField('Piutang','ar_id',rows.map(r=>({value:r.id,label:`${r.customer_name} — ${r.reference_no||'-'} — sisa ${money(num(r.amount)-num(r.paid))}`})),'','required')}${formField('Nominal','amount','number','','min="0.01" step="0.01" required')}${formField('Tanggal','date','date',dateToday(),'required')}${selectField('Kas / Bank','cash_account_id',cashOptions(),'','required')}${formField('Referensi','reference','text','','placeholder="Bukti pembayaran"')}</div>`,async fd=>{const {error}=await withTimeout(sb.rpc('post_ar_payment',{p_ar_id:fd.get('ar_id'),p_amount:num(fd.get('amount')),p_date:fd.get('date')||dateToday(),p_cash_account_id:fd.get('cash_account_id'),p_reference:fd.get('reference')||null}),12000,'Menyimpan pembayaran piutang');if(error)throw error;});
  }
  function apPaymentModal(){
    const rows=state.ap.filter(x=>num(x.amount)-num(x.paid)>0);modal('Bayar hutang','PAYABLES',`<div class="form-grid">${selectField('Hutang','ap_id',rows.map(r=>({value:r.id,label:`${r.supplier_name} — ${r.reference_no||'-'} — sisa ${money(num(r.amount)-num(r.paid))}`})),'','required')}${formField('Nominal','amount','number','','min="0.01" step="0.01" required')}${formField('Tanggal','date','date',dateToday(),'required')}${selectField('Kas / Bank','cash_account_id',cashOptions(),'','required')}${formField('Referensi','reference','text','','placeholder="Bukti pembayaran"')}</div>`,async fd=>{const {error}=await withTimeout(sb.rpc('post_ap_payment',{p_ap_id:fd.get('ap_id'),p_amount:num(fd.get('amount')),p_date:fd.get('date')||dateToday(),p_cash_account_id:fd.get('cash_account_id'),p_reference:fd.get('reference')||null}),12000,'Menyimpan pembayaran hutang');if(error)throw error;});
  }

  function renderTable(target, headers, rows, empty='Belum ada data.') {
    const el=$(target); if(!el)return;
    if(!rows.length){el.innerHTML=`<div class="empty">${esc(empty)}</div>`;return;}
    el.innerHTML=`<table><thead><tr>${headers.map(h=>`<th>${esc(h.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${headers.map(h=>`<td>${h.render ? h.render(r) : esc(r[h.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }
  // Safe table helper (separate from renderTable to keep cell callbacks readable).
  function table(target, columns, rows, empty='Belum ada data.') {
    const el=$(target); if(!el)return;
    if(!rows.length){el.innerHTML=`<div class="empty">${esc(empty)}</div>`;return;}
    el.innerHTML=`<table><thead><tr>${columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${columns.map(c=>`<td>${c.render?c.render(row):esc(row[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  const ui={filters:{transactions:'',sales:'',purchases:'',ar:'',ap:'',stock:''}};
  function filtered(rows,key,fields){const q=(ui.filters[key]||'').toLowerCase().trim();if(!q)return rows;return rows.filter(r=>fields.some(f=>String(r[f]??'').toLowerCase().includes(q)));}
  function renderTools(id,key,placeholder){const el=$(id);if(!el)return;el.innerHTML=`<input class="tool-search" id="search-${key}" type="search" placeholder="${esc(placeholder)}" value="${esc(ui.filters[key]||'')}"><span class="tool-count" id="count-${key}"></span>`;const input=$(`search-${key}`);input.oninput=()=>{ui.filters[key]=input.value;renderAll();setTimeout(()=>{$(`search-${key}`)?.focus();$(`search-${key}`)?.setSelectionRange(input.value.length,input.value.length)},0);};}
  function renderDashboard(){
    const t=state.transactions.filter(x=>x.status==='posted'), opening=state.cashAccounts.reduce((s,x)=>s+num(x.opening_balance),0), inSum=t.reduce((s,x)=>s+num(x.cash_in),0), outSum=t.reduce((s,x)=>s+num(x.cash_out),0), ar=state.ar.reduce((s,x)=>s+Math.max(0,num(x.amount)-num(x.paid)),0), ap=state.ap.reduce((s,x)=>s+Math.max(0,num(x.amount)-num(x.paid)),0), bal=opening+inSum-outSum;
    ['sBalance','heroBalance'].forEach(id=>$(id)&&($(id).textContent=money(bal)));if($('sIn'))$('sIn').textContent=money(inSum);if($('sOut'))$('sOut').textContent=money(outSum);if($('sAR'))$('sAR').textContent=money(ar);if($('sAP'))$('sAP').textContent=money(ap);
    table('recent',[{label:'ID',render:r=>`<span class="badge">${esc(r.transaction_no)}</span>`},{label:'Tanggal',render:r=>esc(r.transaction_date)},{label:'Keterangan',render:r=>esc(r.description)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.cash_in)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.cash_out)}</span>`}],t.slice(0,8));
    $('controlList').innerHTML=[`<div class="attention-item"><div class="bar"></div><div><strong>${state.cashAccounts.length} Kas/Bank aktif</strong><small>Saldo awal ${money(opening)} · berjalan ${money(bal)}</small></div></div>`,`<div class="attention-item"><div class="bar"></div><div><strong>${state.journals.length} jurnal</strong><small>Jurnal berpasangan tersimpan di database.</small></div></div>`,`<div class="attention-item"><div class="bar ${ar>0?'red':''}"></div><div><strong>${money(ar)} piutang tersisa</strong><small>${state.ar.filter(x=>num(x.amount)-num(x.paid)>0).length} tagihan belum lunas.</small></div></div>`,`<div class="attention-item"><div class="bar ${ap>0?'red':''}"></div><div><strong>${money(ap)} hutang tersisa</strong><small>${state.ap.filter(x=>num(x.amount)-num(x.paid)>0).length} kewajiban belum lunas.</small></div></div>`].join('');
  }
  function renderCash(){
    const totalIn=state.transactions.reduce((s,x)=>s+num(x.cash_in),0),totalOut=state.transactions.reduce((s,x)=>s+num(x.cash_out),0),opening=state.cashAccounts.reduce((s,x)=>s+num(x.opening_balance),0),balance=opening+totalIn-totalOut;
    $('cashCards').innerHTML=`<div class="stat-card"><span>Saldo Awal</span><strong>${money(opening)}</strong><small>Dapat ditambah/dikurangi lewat menu ☰</small></div><div class="stat-card"><span>Uang Masuk</span><strong>${money(totalIn)}</strong></div><div class="stat-card"><span>Uang Keluar</span><strong>${money(totalOut)}</strong></div><div class="stat-card"><span>Saldo Berjalan</span><strong>${money(balance)}</strong></div>`;
    const accountRows=state.cashAccounts.map(c=>{const ins=state.transactions.filter(t=>t.cash_account_id===c.id).reduce((s,t)=>s+num(t.cash_in),0),outs=state.transactions.filter(t=>t.cash_account_id===c.id).reduce((s,t)=>s+num(t.cash_out),0);return {...c,ins,outs,balance:num(c.opening_balance)+ins-outs};});
    table('cashTable',[{label:'Rekening',render:r=>`<b>${esc(r.name)}</b>`},{label:'Jenis',render:r=>esc(r.account_type==='bank'?'Bank':'Kas')},{label:'Saldo Awal',render:r=>money(r.opening_balance)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.ins)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.outs)}</span>`},{label:'Saldo Akhir',render:r=>`<strong>${money(r.balance)}</strong>`}],accountRows,'Belum ada rekening Kas/Bank.');
    const wrap=$('cashTable');if(wrap){wrap.innerHTML+=`<div class="section-subtitle">Mutasi Kas & Bank</div>`;const tx=state.transactions.filter(x=>x.status==='posted');const div=document.createElement('div');div.className='table-wrap';wrap.appendChild(div);renderTableElement(div,[{label:'Tanggal',render:r=>esc(r.transaction_date)},{label:'Rekening',render:r=>esc(state.cashAccounts.find(c=>c.id===r.cash_account_id)?.name||'-')},{label:'Keterangan',render:r=>esc(r.description)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.cash_in)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.cash_out)}</span>`}],tx);}
  }
  function renderTableElement(el,columns,rows,empty='Belum ada data.'){if(!rows.length){el.innerHTML=`<div class="empty">${esc(empty)}</div>`;return;}el.innerHTML=`<table><thead><tr>${columns.map(c=>`<th>${esc(c.label)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${columns.map(c=>`<td>${c.render?c.render(r):esc(r[c.key])}</td>`).join('')}</tr>`).join('')}</tbody></table>`;}
  function renderTransactions(){const rows=filtered(state.transactions,'transactions',['transaction_no','transaction_date','category','description','reference_no','pic']);renderTools('trxTools','transactions','Cari ID, kategori, keterangan…');$('count-transactions').textContent=`${rows.length} dari ${state.transactions.length}`;table('trxTable',[{label:'ID',render:r=>`<span class="badge">${esc(r.transaction_no)}</span>`},{label:'Tanggal',render:r=>esc(r.transaction_date)},{label:'Kategori',render:r=>esc(r.category)},{label:'Keterangan',render:r=>esc(r.description)},{label:'Masuk',render:r=>`<span class="money-in">${money(r.cash_in)}</span>`},{label:'Keluar',render:r=>`<span class="money-out">${money(r.cash_out)}</span>`},{label:'Status',render:r=>esc(r.status)}],rows);}
  function renderSales(){const rows=filtered(state.sales,'sales',['sale_no','sale_date','customer_name','status']);renderTools('salesTools','sales','Cari nomor, pelanggan, tanggal…');$('count-sales').textContent=`${rows.length} dari ${state.sales.length}`;table('salesTable',[{label:'No',render:r=>`<span class="badge">${esc(r.sale_no)}</span>`},{label:'Tanggal',render:r=>esc(r.sale_date)},{label:'Customer',render:r=>esc(r.customer_name||'-')},{label:'Total',render:r=>money(r.total)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.total)-num(r.paid))},{label:'Status',render:r=>esc(r.status)}],rows);}
  function renderPurchases(){const rows=filtered(state.purchases,'purchases',['purchase_no','purchase_date','supplier_name','status']);renderTools('purchaseTools','purchases','Cari nomor, supplier, tanggal…');$('count-purchases').textContent=`${rows.length} dari ${state.purchases.length}`;table('purchaseTable',[{label:'No',render:r=>`<span class="badge">${esc(r.purchase_no)}</span>`},{label:'Tanggal',render:r=>esc(r.purchase_date)},{label:'Supplier',render:r=>esc(r.supplier_name||'-')},{label:'Total',render:r=>money(r.total)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.total)-num(r.paid))},{label:'Status',render:r=>esc(r.status)}],rows);}
  function renderAR(){const rows=filtered(state.ar,'ar',['customer_name','reference_no','invoice_date','due_date','status']);renderTools('arTools','ar','Cari customer, invoice, jatuh tempo…');$('count-ar').textContent=`${rows.length} dari ${state.ar.length}`;table('arTable',[{label:'Customer',render:r=>esc(r.customer_name)},{label:'Referensi',render:r=>esc(r.reference_no||'-')},{label:'Tanggal',render:r=>esc(r.invoice_date)},{label:'Total',render:r=>money(r.amount)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.amount)-num(r.paid))},{label:'Jatuh Tempo',render:r=>esc(r.due_date||'-')},{label:'Status',render:r=>esc(r.status)}],rows);}
  function renderAP(){const rows=filtered(state.ap,'ap',['supplier_name','reference_no','invoice_date','due_date','status']);renderTools('apTools','ap','Cari supplier, invoice, jatuh tempo…');$('count-ap').textContent=`${rows.length} dari ${state.ap.length}`;table('apTable',[{label:'Supplier',render:r=>esc(r.supplier_name)},{label:'Referensi',render:r=>esc(r.reference_no||'-')},{label:'Tanggal',render:r=>esc(r.invoice_date)},{label:'Total',render:r=>money(r.amount)},{label:'Dibayar',render:r=>money(r.paid)},{label:'Sisa',render:r=>money(num(r.amount)-num(r.paid))},{label:'Jatuh Tempo',render:r=>esc(r.due_date||'-')},{label:'Status',render:r=>esc(r.status)}],rows);}
  function renderStock(){const base=state.hpp.length?state.hpp:state.products.map(p=>({...p,hpp_per_unit:0,estimated_profit:num(p.selling_price),margin_percent:p.selling_price?100:0}));const rows=filtered(base,'stock',['sku','name','size','fabric_type']);renderTools('stockTools','stock','Cari SKU, produk, kain…');$('count-stock').textContent=`${rows.length} dari ${state.products.length}`;table('stockTable',[{label:'SKU',render:r=>`<span class="badge">${esc(r.sku)}</span>`},{label:'Produk',render:r=>esc(r.name)},{label:'Ukuran',render:r=>esc(r.size||'-')},{label:'Kain',render:r=>esc(r.fabric_type||'-')},{label:'Stok',render:r=>num(r.stock_qty)},{label:'HPP/Unit',render:r=>money(r.hpp_per_unit)},{label:'Harga Jual',render:r=>money(r.selling_price)},{label:'Laba/Unit',render:r=>money(r.estimated_profit)},{label:'Margin',render:r=>`${num(r.margin_percent).toFixed(2)}%`}],rows);}
  function renderJournal(){const rows=state.journals.map(h=>{const ls=state.journalLines.filter(l=>l.journal_id===h.id);return {...h,lines:ls};});table('journalTable',[{label:'No',render:r=>`<span class="badge">${esc(r.journal_no)}</span>`},{label:'Tanggal',render:r=>esc(r.journal_date)},{label:'Jenis',render:r=>esc(r.journal_type)},{label:'Keterangan',render:r=>esc(r.description)},{label:'Debit',render:r=>money(r.lines.reduce((s,l)=>s+num(l.debit),0))},{label:'Kredit',render:r=>money(r.lines.reduce((s,l)=>s+num(l.credit),0))},{label:'Balance',render:r=>{const d=r.lines.reduce((s,l)=>s+num(l.debit),0),c=r.lines.reduce((s,l)=>s+num(l.credit),0);return Math.abs(d-c)<.01?'<span class="badge ok-badge">BALANCE</span>':'<span class="badge danger-badge">SELISIH</span>';}}],rows);}
  function renderReports(){
    const lines=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h})));const value=(type)=>lines.reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);if(type==='revenue')return s+(a?.account_type==='revenue'?num(l.credit)-num(l.debit):0);if(type==='cogs')return s+(a?.account_type==='cogs'?num(l.debit)-num(l.credit):0);return s+(a?.account_type==='expense'?num(l.debit)-num(l.credit):0)},0);const revenue=value('revenue'),cogs=value('cogs'),expense=value('expense'),gross=revenue-cogs,net=gross-expense;
    $('reportCards').innerHTML=`<div class="stat-card"><span>Pendapatan</span><strong>${money(revenue)}</strong></div><div class="stat-card"><span>HPP</span><strong>${money(cogs)}</strong></div><div class="stat-card"><span>Laba Kotor</span><strong>${money(gross)}</strong></div><div class="stat-card"><span>Beban</span><strong>${money(expense)}</strong></div><div class="stat-card"><span>Laba Bersih</span><strong>${money(net)}</strong></div>`;
    table('reportTable',[{label:'Laporan',render:r=>esc(r.name)},{label:'Nilai',render:r=>money(r.value)}],[{name:'Pendapatan',value:revenue},{name:'HPP',value:cogs},{name:'Laba Kotor',value:gross},{name:'Beban Operasional',value:expense},{name:'Laba Bersih',value:net}]);
    if($('reportDetail'))$('reportDetail').innerHTML=`<div class="notice"><b>Kontrol:</b> seluruh jurnal diproses dengan prinsip debit = kredit. Saldo kas = saldo awal + uang masuk − uang keluar. Laba bersih = pendapatan − HPP − beban.</div>`;
  }
  function renderAll(){renderDashboard();renderCash();renderTransactions();renderSales();renderPurchases();renderAR();renderAP();renderStock();renderJournal();renderReports();}

  function csvEscape(v){return `"${String(v??'').replace(/"/g,'""')}"`;}
  function downloadCSV(filename, rows){
    if(!rows.length){toast('Tidak ada data untuk diexport.',false);return;}
    const headers=Object.keys(rows[0]); const text=[headers.map(csvEscape).join(','),...rows.map(r=>headers.map(h=>csvEscape(r[h])).join(','))].join('\r\n');
    const blob=new Blob(['\ufeff'+text],{type:'text/csv;charset=utf-8'}); const a=document.createElement('a'); const url=URL.createObjectURL(blob); a.href=url;a.download=filename;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),500);
  }
  function journalExportRows(){return state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({journal_no:h.journal_no,tanggal:h.journal_date,jenis:h.journal_type,referensi:h.source_type||'',keterangan:h.description,akun:state.accounts.find(a=>a.id===l.account_id)?.code||'',nama_akun:state.accounts.find(a=>a.id===l.account_id)?.name||'',debit:num(l.debit),kredit:num(l.credit),status:h.status})));}
  function exportData(type){
    const map={transactions:state.transactions,journal:journalExportRows(),sales:state.sales,purchases:state.purchases,ar:state.ar,ap:state.ap,stock:state.hpp};
    if(type==='xlsx'){exportWorkbook();return;}
    if(type==='all'){downloadCSV(`KARSA-Finance-Semua-${dateToday()}.csv`,state.transactions);return;}
    downloadCSV(`KARSA-Finance-${slug(type)}-${dateToday()}.csv`,map[type]||[]);
  }
  function exportWorkbook(){
    if(!window.XLSX){toast('Library Excel belum termuat. Pastikan koneksi internet tersedia.',false);return;}
    const wb=XLSX.utils.book_new();
    const add=(name,rows)=>{const data=rows.length?rows:[{Keterangan:'Tidak ada data'}];XLSX.utils.book_append_sheet(wb,XLSX.utils.json_to_sheet(data),name.slice(0,31));};
    add('Petunjuk',[{Item:'KARSA Finance',Keterangan:'Workbook export dari Supabase'},{Item:'Saldo',Keterangan:'Saldo Awal + Uang Masuk - Uang Keluar'},{Item:'HPP',Keterangan:'Qty x Harga Satuan; total produk = SUM komponen'},{Item:'Laba Bersih',Keterangan:'Pendapatan - HPP - Beban'},{Item:'Spreadsheet',Keterangan:'File XLSX dapat dibuka/import ke Google Sheets.'}]);
    add('Transaksi',state.transactions);add('Penjualan',state.sales);add('Pembelian',state.purchases);add('Piutang',state.ar);add('Hutang',state.ap);add('Produk_HPP',state.hpp);add('Komponen_HPP',state.costComponents);add('Stok',state.stockMovements);add('Jurnal',journalExportRows());add('Akun',state.accounts);add('Kas_Bank',state.cashAccounts);

    const cashSheet=[['Rekening','Saldo Awal','Uang Masuk','Uang Keluar','Saldo Akhir']];
    state.cashAccounts.forEach((c,i)=>{
      const row=i+2, ins=state.transactions.filter(t=>t.cash_account_id===c.id).reduce((s,t)=>s+num(t.cash_in),0), outs=state.transactions.filter(t=>t.cash_account_id===c.id).reduce((s,t)=>s+num(t.cash_out),0);
      cashSheet.push([c.name,num(c.opening_balance),ins,outs,null]);
      cashSheet[cashSheet.length-1][4]={f:`B${row}+C${row}-D${row}`};
    });
    const wsCash=XLSX.utils.aoa_to_sheet(cashSheet);XLSX.utils.book_append_sheet(wb,wsCash,'Rumus_Kas');

    const hppSheet=[['SKU','Produk','Harga Jual','HPP/Unit','Laba/Unit','Margin %']];
    state.hpp.forEach((p,i)=>{const r=i+2;hppSheet.push([p.sku,p.name,num(p.selling_price),num(p.hpp_per_unit),null,null]);hppSheet[hppSheet.length-1][4]={f:`C${r}-D${r}`};hppSheet[hppSheet.length-1][5]={f:`IF(C${r}>0,E${r}/C${r},0)`};});
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(hppSheet),'Rumus_HPP');

    const journalRows=journalExportRows();
    const jr=[['Jurnal','Debit','Kredit','Selisih']];
    journalRows.forEach((x,i)=>{const r=i+2;jr.push([x.journal_no,num(x.debit),num(x.kredit),null]);jr[jr.length-1][3]={f:`B${r}-C${r}`};});
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(jr),'Rumus_Jurnal');

    const rev=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='revenue'?num(l.credit)-num(l.debit):0)},0);
    const cogs=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='cogs'?num(l.debit)-num(l.credit):0)},0);
    const expense=state.journals.flatMap(h=>state.journalLines.filter(l=>l.journal_id===h.id).map(l=>({...l,h}))).reduce((s,l)=>{const a=state.accounts.find(x=>x.id===l.account_id);return s+(a?.account_type==='expense'?num(l.debit)-num(l.credit):0)},0);
    const lr=[['Komponen','Nilai'],['Pendapatan',null],['HPP',null],['Laba Kotor',null],['Beban',null],['Laba Bersih',null]];
    lr[1][1]={f:`SUMIF(Jurnal!G:G,"Penjualan",Jurnal!I:I)`};
    // The exact current journal totals are also stored in a formula-friendly snapshot below.
    lr[2][1]={f:`SUMIF(Jurnal!G:G,"HPP",Jurnal!H:H)`}; lr[3][1]={f:'B2-B3'}; lr[4][1]={f:`SUMIF(Jurnal!G:G,"Beban*",Jurnal!H:H)`}; lr[5][1]={f:'B4-B5'};
    // Jurnal uses nama_akun in column G and debit/kredit in H/I; the snapshot is kept alongside for portability.
    lr.push(['Snapshot Pendapatan',rev],['Snapshot HPP',cogs],['Snapshot Beban',expense]);
    XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet(lr),'Laba_Rugi');
    XLSX.writeFile(wb,`KARSA-Finance-${dateToday()}.xlsx`);toast('Workbook Excel berhasil dibuat. XLSX dapat dibuka di Microsoft Excel atau Google Sheets.');
  }

  function go(page){
    document.querySelectorAll('.nav-item').forEach(x=>x.classList.toggle('active',x.dataset.page===page));
    document.querySelectorAll('.view').forEach(x=>x.classList.toggle('active',x.id===page));
    const title=[...document.querySelectorAll('.nav-item')].find(x=>x.dataset.page===page); $('pageTitle').textContent=title?title.textContent.replace(/^./,'').trim():page;
    window.scrollTo({top:0,behavior:'smooth'}); closeMenu();
  }
  async function refresh(){
    if(!sb || !user) return;
    try {
      const warnings = await loadAll();
      try { renderAll(); } catch(e) { console.error('[KARSA Finance] Render error:', e); toast('Data masuk, tetapi sebagian tampilan gagal dirender: '+errorText(e), false); }
      updateProfile();
      if(warnings.length) console.warn('[KARSA Finance] Data warning:', warnings);
      return warnings;
    } catch(e) {
      console.error('[KARSA Finance] Refresh error:', e);
      toast('Gagal memuat ulang data: '+errorText(e), false);
      throw e;
    }
  }
  function updateProfile(){const name=state.profile?.full_name||user?.email?.split('@')[0]||'Finance';if($('profileName'))$('profileName').textContent=name;if($('profileEmail'))$('profileEmail').textContent=user?.email||'-';if($('avatar'))$('avatar').textContent=name.slice(0,2).toUpperCase();}

  let loginBusy = false;
  let handledSessionId = null;

  async function login(){
    if(!configured()) throw new Error('Supabase belum dikonfigurasi. Isi config.js dengan Project URL dan Publishable/anon public key.');
    if(!sb) throw new Error('Koneksi Supabase belum siap. Tunggu sebentar lalu coba lagi.');
    if(loginBusy) return;

    const email = $('loginEmail')?.value.trim() || '';
    const password = $('loginPass')?.value || '';
    if(!email || !password) throw new Error('Email dan password wajib diisi.');

    loginBusy = true;
    const button = $('loginForm')?.querySelector('button[type="submit"]');
    if(button){ button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = 'Menghubungkan…'; }
    authMessage('Menghubungkan ke Supabase…', true);

    try {
      const result = await withTimeout(
        sb.auth.signInWithPassword({ email, password }),
        15000,
        'Login Supabase'
      );
      const { data, error } = result;
      if(error) throw error;
      if(!data?.session) throw new Error('Login belum menghasilkan session.');

      // Jangan menunggu loadAll di dalam callback auth.
      user = data.session.user;
      await handleSession(data.session);
    } finally {
      loginBusy = false;
      if(button){ button.disabled = false; button.textContent = button.dataset.originalText || 'Masuk ke Finance'; }
    }
  }

  async function logout(){
    if(!sb) return;
    try { await withTimeout(sb.auth.signOut(), 10000, 'Logout Supabase'); }
    finally { user = null; handledSessionId = null; showAuth(); showLoader(false); }
  }

  async function handleSession(session){
    if(!session?.user){
      handledSessionId = null;
      user = null;
      showLoader(false);
      showAuth();
      return;
    }

    user = session.user;
    const sessionId = session.access_token || session.user.id;
    if (handledSessionId === sessionId) return;
    handledSessionId = sessionId;
    // Tampilkan area aplikasi segera supaya UI tidak pernah terkunci di loader.
    showLoader(false);
    showAuth();
    authMessage('');

    try {
      setLoader('Memuat data Finance…');
      const warnings = await loadAll();
      try { updateProfile(); renderAll(); }
      catch (renderError) {
        console.error('[KARSA Finance] Render error:', renderError);
        toast('Login berhasil. Sebagian tampilan belum dapat dirender.', false);
      }
      showApp();
      if(warnings.length) toast('Login berhasil. Beberapa data belum termuat; cek Console untuk detail.', false);
    } catch(e) {
      console.error('[KARSA Finance] loadAll error:', e);
      // Login tetap dianggap berhasil meskipun data database bermasalah.
      showApp();
      toast(`Login berhasil, tetapi data belum termuat: ${errorText(e)}`, false);
    } finally {
      showLoader(false);
    }
  }

  function openMenu(){ $('sidebar')?.classList.add('open'); $('menuBackdrop')?.classList.remove('hidden'); $('menuBtn')?.setAttribute('aria-expanded','true'); document.body.classList.add('menu-open'); }
  function closeMenu(){ $('sidebar')?.classList.remove('open'); $('menuBackdrop')?.classList.add('hidden'); $('menuBtn')?.setAttribute('aria-expanded','false'); document.body.classList.remove('menu-open'); }
  function bind(){
    $('loginForm')?.addEventListener('submit',async e=>{e.preventDefault();try{await login();}catch(err){authMessage(errorText(err),false);}});
    $('logout')?.addEventListener('click',async()=>{try{await logout();}catch(e){toast(errorText(e),false);}});
    $('closeModal')?.addEventListener('click',closeModal);$('modal')?.addEventListener('click',e=>{if(e.target.id==='modal')closeModal();});
    $('menuBtn')?.addEventListener('click',()=>{$('sidebar')?.classList.contains('open')?closeMenu():openMenu();});$('menuBackdrop')?.addEventListener('click',closeMenu);
    document.querySelectorAll('.nav-item').forEach(b=>b.addEventListener('click',()=>go(b.dataset.page)));
    document.querySelectorAll('.menu-action').forEach(b=>b.addEventListener('click',()=>{const a=b.dataset.action;closeMenu();({transaction:transactionModal,opening:openingModal,sale:saleModal,purchase:purchaseModal,product:productModal}[a]||(()=>{}))();}));
    $('refreshBtn')?.addEventListener('click',async()=>{try{await refresh();toast('Data berhasil dimuat ulang.');}catch(e){}});
    $('openingAdd')?.addEventListener('click',openingModal);$('cashAccountAdd')?.addEventListener('click',cashAccountModal);$('cashAdd')?.addEventListener('click',transactionModal);$('trxAdd')?.addEventListener('click',transactionModal);$('saleAdd')?.addEventListener('click',saleModal);$('purchaseAdd')?.addEventListener('click',purchaseModal);$('productAdd')?.addEventListener('click',productModal);$('stockMoveAdd')?.addEventListener('click',stockMovementModal);$('arPayAdd')?.addEventListener('click',arPaymentModal);$('apPayAdd')?.addEventListener('click',apPaymentModal);$('heroAdd')?.addEventListener('click',transactionModal);$('quickBtn')?.addEventListener('click',transactionModal);$('journalRefresh')?.addEventListener('click',refresh);
    document.querySelectorAll('[data-go]').forEach(b=>b.addEventListener('click',()=>go(b.dataset.go)));document.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',()=>exportData(b.dataset.export)));
    setInterval(()=>{if($('clock'))$('clock').textContent=new Intl.DateTimeFormat('id-ID',{dateStyle:'medium',timeStyle:'short'}).format(new Date());},1000);
  }
  async function init(){
    bind();
    showLoader(true);
    setLoader('Memeriksa konfigurasi…');

    if(!configured()){
      showLoader(false);
      showAuth();
      authMessage('Supabase belum dikonfigurasi. Buka config.js lalu isi Project URL dan Publishable/anon public key.');
      return;
    }

    if(!window.supabase?.createClient){
      showLoader(false);
      showAuth();
      authMessage('Library Supabase gagal dimuat. Pastikan koneksi internet aktif lalu refresh halaman.');
      return;
    }

    try {
      sb = window.supabase.createClient(SB_URL, SB_KEY, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });

      // Listener auth TIDAK boleh menunggu query database di dalam callback.
      sb.auth.onAuthStateChange((_event, session) => {
        setTimeout(() => {
          handleSession(session).catch(e => {
            console.error('[KARSA Finance] Session handler error:', e);
            showLoader(false);
            if(session?.user) showApp(); else showAuth();
            toast(errorText(e), false);
          });
        }, 0);
      });

      setLoader('Memeriksa session…');
      const { data, error } = await withTimeout(
        sb.auth.getSession(),
        10000,
        'Pemeriksaan session'
      );
      if(error) throw error;

      if(data?.session){
        await handleSession(data.session);
      } else {
        user = null;
        showLoader(false);
        showAuth();
      }
    } catch(err) {
      console.error('[KARSA Finance] Init error:', err);
      showLoader(false);
      showAuth();
      authMessage(errorText(err), false);
    }
  }
  window.KARSA={state,refresh,login,logout,downloadCSV,exportWorkbook,exportData,money};
  document.addEventListener('DOMContentLoaded',init);
})();

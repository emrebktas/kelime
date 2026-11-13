// FSP kurs okuyucusu: kişiye özel kurs paketi (fsp_library) — bölümler, arama, görseller,
// paragraf çevirisi (fsp-ai, Gemini), seslendirme, seçilen kelimeyi desteye ekleme, paylaşım kodu.
// İçerik telifli kurs materyali olabilir: sadece sahibi ve kodla katılanlar görür; depoya girmez.

let C = null;
const K = {
  libs: null, libId: null, lib: null, ch: 0, q: '', urls: {}, urlAt: 0, blobs: {}, busy: false, sel: null, tocOpen: false,
};
const TR_KEY = 'kelime.kurs.tr';
const DECK = 'FSP Kurs';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function initKurs(ctx) {
  C = ctx;
  C.main.addEventListener('click', onClick);
  C.main.addEventListener('input', onInput);
  C.main.addEventListener('change', onChange);
  document.addEventListener('selectionchange', onSelection);
}

/* ------------------------------------------------------------------ önbellek (cihazda) */

const cacheKey = (id) => `kelime.kurs.${id}`;
function readCache(id) {
  try { return JSON.parse(localStorage.getItem(cacheKey(id)) || 'null'); } catch { return null; }
}
function writeCache(lib) {
  try { localStorage.setItem(cacheKey(lib.id), JSON.stringify(lib)); } catch { /* yer yoksa önemli değil */ }
}
let trCache = null;
function trs() {
  if (!trCache) { try { trCache = JSON.parse(localStorage.getItem(TR_KEY) || '{}'); } catch { trCache = {}; } }
  return trCache;
}
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
function saveTr(text, tr) {
  const c = trs();
  c[hash(text)] = tr;
  const keys = Object.keys(c);
  if (keys.length > 3000) for (const k of keys.slice(0, keys.length - 3000)) delete c[k];
  try { localStorage.setItem(TR_KEY, JSON.stringify(c)); } catch { /* yer yoksa sadece bu oturumda */ }
}

/* ------------------------------------------------------------------ giriş noktası */

export function kursHtml() {
  return '<div id="kurs-root" class="kurs"><div class="muted">Yükleniyor…</div></div>';
}

export async function mountKurs() {
  const root = document.getElementById('kurs-root');
  if (!root) return;
  if (!C.sync.user()) {
    root.innerHTML = '<div class="panel empty">Kurs içeriği kişiye özeldir; görmek için <button class="linkish" data-act="account">giriş yap</button>.</div>';
    return;
  }
  try {
    if (!K.libs) K.libs = await C.sync.listLibraries();
  } catch (e) {
    root.innerHTML = `<div class="panel empty">Kurslar yüklenemedi: ${esc(e.message)}</div>`;
    return;
  }
  if (K.libs === null) {
    root.innerHTML = '<div class="panel empty">Kurs özelliği için sunucuda FSP kurs SQL dosyası (20261024000000_fsp_kurs.sql) çalıştırılmalı.</div>';
    return;
  }
  if (!K.libs.length) { renderEmpty(); return; }
  if (!K.libs.some((l) => l.id === K.libId)) K.libId = K.libs[0].id;
  await openLib(K.libId);
}

function renderEmpty() {
  const root = document.getElementById('kurs-root');
  if (!root) return;
  root.innerHTML = `
    <section class="panel kurs-empty">
      <h3>Kurs notların burada</h3>
      <p>Kurs scriptini bir kez içe aktarırsın: bölüm bölüm okursun, arar, paragrafları Türkçeye çevirir, seslendirir ve seçtiğin kelimeleri desteye eklersin. İçerik sadece sana ve paylaşım kodu verdiğin kişilere görünür.</p>
      <div class="kurs-empty-actions">
        <label class="btn primary kurs-file">＋ Kurs paketini içe aktar (.zip)<input type="file" accept=".zip,application/zip" data-k="import" hidden></label>
        <button data-k="join">Paylaşım koduyla katıl</button>
      </div>
    </section>`;
}

async function openLib(id) {
  const root = document.getElementById('kurs-root');
  const meta = K.libs.find((l) => l.id === id);
  let lib = readCache(id);
  if (!lib || lib.updated_at !== meta.updated_at) {
    if (root) root.innerHTML = '<div class="muted">Kurs indiriliyor…</div>';
    lib = await C.sync.getLibrary(id);
    writeCache(lib);
  }
  K.libId = id;
  K.lib = lib;
  K.ch = Math.min(Number(C.prefs.kursCh?.[id] ?? 0), lib.content.chapters.length - 1);
  render();
}

/* ------------------------------------------------------------------ çizim */

const isOwner = () => K.lib && K.lib.owner_id === C.sync.user()?.id;

function render() {
  const root = document.getElementById('kurs-root');
  if (!root || !K.lib) return;
  const chs = K.lib.content.chapters;
  const ch = chs[K.ch];
  const meta = K.libs.find((l) => l.id === K.libId) || {};
  root.innerHTML = `
    <div class="kurs-bar">
      ${K.libs.length > 1 ? `<select data-k="lib">${K.libs.map((l) => `<option value="${l.id}" ${l.id === K.libId ? 'selected' : ''}>${esc(l.title)}</option>`).join('')}</select>` : `<b class="kurs-title">${esc(K.lib.title)}</b>`}
      <span class="spacer"></span>
      <button class="ghost kurs-toc-btn" data-k="toc">☰ Bölümler</button>
      ${isOwner() ? `<button data-k="share">${meta.share_code ? 'Paylaşım kodu' : 'Paylaş'}</button>
        <label class="btn kurs-file" title="Paketi yeniden yükle (aynı başlık güncellenir)">↻ Güncelle<input type="file" accept=".zip,application/zip" data-k="import" hidden></label>
        <button class="ghost danger-ghost" data-k="delete">Sil</button>`
      : '<button class="ghost" data-k="leave">Kurstan ayrıl</button>'}
      <button class="ghost" data-k="join">Kodla katıl</button>
    </div>
    <div class="kurs-layout ${K.tocOpen ? 'toc-open' : ''}">
      <aside class="kurs-toc">
        <input type="search" id="kurs-q" placeholder="Kursta ara…" value="${esc(K.q)}">
        <div id="kurs-toc-list">${tocHtml()}</div>
      </aside>
      <article class="panel kurs-body" id="kurs-body">
        ${K.q.trim().length >= 2 ? searchHtml() : chapterHtml(ch)}
      </article>
    </div>
    <div class="kurs-selpop hidden" id="kurs-selpop"><button data-k="add-sel"></button></div>`;
  loadImages();
}

function tocHtml() {
  return `<ol class="kurs-chs">${K.lib.content.chapters.map((c, i) => `
    <li><button class="${i === K.ch && K.q.trim().length < 2 ? 'on' : ''}" data-k="ch" data-i="${i}">
      <span lang="de">${esc(c.title)}</span><small>${esc(c.tr || '')}</small></button></li>`).join('')}</ol>`;
}

function blockHtml(b, i) {
  const tools = `<span class="kb-tools"><button class="icon-btn" data-k="say" data-i="${i}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button><button class="icon-btn kb-tr-btn" data-k="tr" data-i="${i}" title="Türkçeye çevir" aria-label="Türkçeye çevir">TR</button></span>`;
  const cached = b.x ? trs()[hash(b.x)] : null;
  const tr = cached ? `<div class="kb-tr" id="kb-tr-${i}">${esc(cached)}</div>` : `<div class="kb-tr hidden" id="kb-tr-${i}"></div>`;
  if (b.t === 'img') return `<figure class="kb-img" data-bi="${i}"><img data-src="${esc(b.src)}" alt="${esc(b.cap || '')}" ${b.w ? `width="${b.w}" height="${b.h}"` : ''} loading="lazy">${b.cap ? `<figcaption>${esc(b.cap)}</figcaption>` : ''}</figure>`;
  if (b.t === 'h') return `<h3 class="kb-h" data-bi="${i}" lang="de">${esc(b.x)}</h3>`;
  if (b.t === 'li') return `<div class="kb kb-li" data-bi="${i}"><div class="kb-row"><span class="kb-dot">•</span><span class="kb-x" lang="de">${esc(b.x)}</span>${tools}</div>${tr}</div>`;
  return `<div class="kb" data-bi="${i}"><div class="kb-row"><p class="kb-x" lang="de">${esc(b.x)}</p>${tools}</div>${tr}</div>`;
}

function chapterHtml(ch) {
  const n = K.lib.content.chapters.length;
  return `
    <header class="kurs-ch-head"><span class="muted">Bölüm ${K.ch + 1} / ${n}</span><h2 lang="de">${esc(ch.title)}</h2>${ch.tr ? `<p class="muted">${esc(ch.tr)}</p>` : ''}
      <button class="ghost kurs-tr-all" data-k="tr-all">Bölümü Türkçeye çevir</button></header>
    <div class="kurs-blocks" data-ch="${K.ch}">${ch.blocks.map(blockHtml).join('')}</div>
    <nav class="kurs-nav">
      ${K.ch > 0 ? `<button data-k="ch" data-i="${K.ch - 1}">← ${esc(K.lib.content.chapters[K.ch - 1].title)}</button>` : '<span></span>'}
      ${K.ch < n - 1 ? `<button class="primary" data-k="ch" data-i="${K.ch + 1}">${esc(K.lib.content.chapters[K.ch + 1].title)} →</button>` : ''}
    </nav>`;
}

function searchHtml() {
  const q = K.q.trim().toLocaleLowerCase('de');
  const hits = [];
  K.lib.content.chapters.forEach((c, ci) => c.blocks.forEach((b, bi) => {
    const t = b.x || b.cap || '';
    const at = t.toLocaleLowerCase('de').indexOf(q);
    if (at >= 0 && hits.length < 200) hits.push({ ci, bi, t, at });
  }));
  if (!hits.length) return '<p class="muted">Sonuç yok.</p>';
  return `<p class="muted">${hits.length}${hits.length === 200 ? '+' : ''} sonuç</p><div class="kurs-hits">${hits.map((h) => {
    const s = Math.max(0, h.at - 60);
    const snip = `${s ? '…' : ''}${esc(h.t.slice(s, h.at))}<mark>${esc(h.t.slice(h.at, h.at + q.length))}</mark>${esc(h.t.slice(h.at + q.length, h.at + q.length + 120))}`;
    return `<button class="kurs-hit" data-k="hit" data-ci="${h.ci}" data-bi="${h.bi}"><small>${esc(K.lib.content.chapters[h.ci].title)}</small><span lang="de">${snip}</span></button>`;
  }).join('')}</div>`;
}

/* ------------------------------------------------------------------ görseller (süreli adresler) */

async function loadImages() {
  const imgs = [...document.querySelectorAll('#kurs-body img[data-src]')];
  if (!imgs.length) return;
  if (Date.now() - K.urlAt > 50 * 60 * 1000) { K.urls = {}; K.urlAt = Date.now(); }
  // CSP img-src sadece 'self' ve blob: izin verir: görseller fetch ile indirilip blob adresiyle gösterilir
  const key = (p) => `${K.libId}/${p}`;
  const need = [...new Set(imgs.map((i) => i.dataset.src).filter((p) => !K.blobs[key(p)] && !K.urls[p]))];
  try {
    if (need.length) Object.assign(K.urls, await C.sync.libraryUrls(K.libId, need));
  } catch (e) { console.warn('Görsel adresleri alınamadı', e); }
  await Promise.all(imgs.map(async (i) => {
    const p = i.dataset.src;
    if (!K.blobs[key(p)] && K.urls[p]) {
      try {
        const r = await fetch(K.urls[p]);
        if (r.ok) K.blobs[key(p)] = URL.createObjectURL(await r.blob());
      } catch { /* çevrimdışı */ }
    }
    if (K.blobs[key(p)] && i.isConnected) i.src = K.blobs[key(p)];
  }));
}

/* ------------------------------------------------------------------ çeviri */

const blockAt = (i) => K.lib.content.chapters[K.ch].blocks[Number(i)];

async function translate(i, quiet) {
  const b = blockAt(i);
  const box = document.getElementById(`kb-tr-${i}`);
  if (!b?.x || !box) return;
  const cached = trs()[hash(b.x)];
  if (cached) {
    if (!quiet) box.classList.toggle('hidden');
    else box.classList.remove('hidden');
    box.textContent = cached;
    return;
  }
  box.classList.remove('hidden');
  box.textContent = 'Çevriliyor…';
  try {
    const res = await C.sync.fspAi({ action: 'translate', text: b.x }, 45_000);
    saveTr(b.x, res.tr);
    if (document.getElementById(`kb-tr-${i}`) === box) box.textContent = res.tr;
  } catch (e) {
    box.textContent = e.message || String(e);
    box.classList.add('err');
  }
}

async function translateAll() {
  if (K.busy) return;
  K.busy = true;
  const blocks = K.lib.content.chapters[K.ch].blocks;
  const todo = blocks.map((b, i) => [b, i]).filter(([b]) => b.x && b.t !== 'img' && b.t !== 'h');
  const wait = C.toast(`Bölüm çevriliyor… (${todo.length} paragraf)`, 'info', 600_000);
  let n = 0;
  try {
    for (const [, i] of todo) {
      if (!document.getElementById(`kb-tr-${i}`)) break; // bölüm değişti
      await translate(i, true);
      n++;
      wait.textContent = `Bölüm çevriliyor… ${n} / ${todo.length}`;
    }
  } finally {
    wait.remove();
    K.busy = false;
  }
}

/* ------------------------------------------------------------------ seçili kelimeyi desteye ekleme */

function onSelection() {
  const pop = document.getElementById('kurs-selpop');
  if (!pop) return;
  const sel = window.getSelection();
  const text = sel?.toString().replace(/\s+/g, ' ').trim() || '';
  const inBody = sel?.rangeCount && document.getElementById('kurs-body')?.contains(sel.anchorNode);
  if (!inBody || !text || text.length > 60 || text.split(' ').length > 4) { pop.classList.add('hidden'); K.sel = null; return; }
  K.sel = text.replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  if (!K.sel) { pop.classList.add('hidden'); return; }
  const r = sel.getRangeAt(0).getBoundingClientRect();
  pop.querySelector('button').textContent = `＋ “${K.sel}” desteye ekle`;
  pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 240, r.left))}px`;
  pop.style.top = `${r.bottom + 8}px`;
  pop.classList.remove('hidden');
}

function addSelected() {
  if (!K.sel) return;
  let deck = C.state.decks.find((d) => d.name === DECK && d.role !== 'viewer');
  if (!deck) deck = C.store.createDeck({ name: DECK, language: 'de' });
  C.addWordsToDeck(deck, [K.sel]);
  window.getSelection()?.removeAllRanges();
  document.getElementById('kurs-selpop')?.classList.add('hidden');
}

/* ------------------------------------------------------------------ paket içe aktarma (.zip, sıkıştırmasız) */

function readStoredZip(buf) {
  const v = new DataView(buf);
  const files = {};
  let p = 0;
  const dec = new TextDecoder();
  while (p + 30 <= buf.byteLength && v.getUint32(p, true) === 0x04034b50) {
    const flags = v.getUint16(p + 6, true);
    const method = v.getUint16(p + 8, true);
    const size = v.getUint32(p + 18, true);
    const nameLen = v.getUint16(p + 26, true);
    const extraLen = v.getUint16(p + 28, true);
    const name = dec.decode(new Uint8Array(buf, p + 30, nameLen));
    if (method !== 0 || flags & 8) throw new Error('Paket biçimi desteklenmiyor (sıkıştırmasız .zip gerekli).');
    const start = p + 30 + nameLen + extraLen;
    files[name] = new Uint8Array(buf, start, size);
    p = start + size;
  }
  return files;
}

function validContent(c) {
  return c && c.format === 'kelime-kurs' && Array.isArray(c.chapters) && c.chapters.length
    && c.chapters.every((ch) => typeof ch.title === 'string' && Array.isArray(ch.blocks));
}

async function importPackage(file) {
  if (!file) return;
  if (!C.sync.user()) { C.toast('Önce giriş yap.', 'info'); return; }
  const files = readStoredZip(await file.arrayBuffer());
  if (!files['content.json']) throw new Error('Pakette content.json yok.');
  const content = JSON.parse(new TextDecoder().decode(files['content.json']));
  if (!validContent(content)) throw new Error('Bu bir Kelime kurs paketi değil.');
  const title = String(content.title || file.name.replace(/\.zip$/i, '')).slice(0, 200);
  const same = (K.libs || []).find((l) => l.title === title && l.owner_id === C.sync.user().id);
  if (same && !(await C.confirmBox(`“${title}” zaten var. İçeriği bu paketle güncellensin mi?`, { ok: 'Güncelle' }))) return;
  const wait = C.toast('Kurs yükleniyor…', 'info', 600_000);
  try {
    const id = await C.sync.saveLibrary({ id: same?.id, title, content });
    const imgs = Object.keys(files).filter((n) => n.startsWith('img/'));
    for (let i = 0; i < imgs.length; i++) {
      wait.textContent = `Görseller yükleniyor… ${i + 1} / ${imgs.length}`;
      await C.sync.uploadLibraryFile(id, imgs[i], new Blob([files[imgs[i]]], { type: 'image/webp' }), 'image/webp');
    }
    try { localStorage.removeItem(cacheKey(id)); } catch { /* yok say */ }
    K.libs = null;
    K.libId = id;
    C.toast(`Kurs hazır: ${content.chapters.length} bölüm, ${imgs.length} görsel.`, 'success', 5000);
  } finally {
    wait.remove();
  }
  await mountKurs();
}

/* ------------------------------------------------------------------ paylaşım */

function shareModal() {
  const meta = K.libs.find((l) => l.id === K.libId);
  const form = C.openModal(`
    <h2>Kursu paylaş</h2>
    <p class="muted" style="font-size:13px">Bu kodu verdiğin kişiler uygulamada <b>FSP → Kurs → Kodla katıl</b> ile kursu görebilir (sadece okuma). Kodu yenilersen eski kod geçersiz olur; katılmış olanlar kalır.</p>
    <div class="kurs-code">${meta.share_code ? `<b>${esc(meta.share_code)}</b><button type="button" data-copy>Kopyala</button>` : '<span class="muted">Henüz kod yok.</span>'}</div>
    <div class="modal-actions"><button type="button" data-new>${meta.share_code ? 'Kodu yenile' : 'Kod oluştur'}</button><span class="spacer"></span><button type="button" class="primary" data-close>Tamam</button></div>`);
  form.querySelector('[data-copy]')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(meta.share_code).then(() => C.toast('Kod kopyalandı.', 'success', 1500));
  });
  form.querySelector('[data-new]').addEventListener('click', () => C.guard(async () => {
    meta.share_code = await C.sync.libraryNewCode(K.libId);
    shareModal(); // openModal önceki pencereyi kapatır
  }));
}

function joinModal() {
  C.openModal(`
    <h2>Kursa katıl</h2>
    <label>Paylaşım kodu<input name="code" autocomplete="off" autofocus placeholder="ör. 7KQ2MX9P"></label>
    <div class="modal-actions"><button type="button" data-close>Vazgeç</button><button type="submit" class="primary">Katıl</button></div>`, {
    onSubmit: async (f) => {
      const id = await C.sync.joinLibrary(f.code.value.trim());
      K.libs = null;
      K.libId = id;
      C.toast('Kursa katıldın.', 'success');
      mountKurs();
    },
  });
}

/* ------------------------------------------------------------------ olaylar */

function onClick(e) {
  const el = e.target.closest('[data-k]');
  if (!el || !document.getElementById('kurs-root')?.contains(el) && el.dataset.k !== 'add-sel') return;
  const k = el.dataset.k;
  if (el.tagName === 'INPUT' || el.tagName === 'SELECT') return;
  C.guard(async () => {
    switch (k) {
      case 'ch':
        K.ch = Number(el.dataset.i);
        K.q = '';
        K.tocOpen = false;
        C.prefs.kursCh = { ...(C.prefs.kursCh || {}), [K.libId]: K.ch };
        C.savePrefs();
        render();
        document.getElementById('kurs-body')?.scrollIntoView({ block: 'start' });
        C.main.scrollTop = 0;
        break;
      case 'hit': {
        K.ch = Number(el.dataset.ci);
        K.q = '';
        render();
        const t = document.querySelector(`#kurs-body [data-bi="${el.dataset.bi}"]`);
        t?.scrollIntoView({ block: 'center' });
        t?.classList.add('flash');
        break;
      }
      case 'toc': K.tocOpen = !K.tocOpen; document.querySelector('.kurs-layout')?.classList.toggle('toc-open', K.tocOpen); break;
      case 'say': C.speak(blockAt(el.dataset.i).x, 'de'); break;
      case 'tr': await translate(el.dataset.i); break;
      case 'tr-all': await translateAll(); break;
      case 'add-sel': addSelected(); break;
      case 'share': shareModal(); break;
      case 'join': joinModal(); break;
      case 'leave':
        if (await C.confirmBox('Bu kurstan ayrılırsın; tekrar görmek için yeni bir kod gerekir.', { ok: 'Ayrıl', danger: true })) {
          await C.sync.leaveLibrary(K.libId);
          K.libs = null; K.lib = null;
          mountKurs();
        }
        break;
      case 'delete':
        if (await C.confirmBox('Kurs ve tüm görselleri kalıcı olarak silinecek. Katılan kişiler de artık göremez.', { ok: 'Kalıcı olarak sil', danger: true })) {
          const paths = [...new Set(K.lib.content.chapters.flatMap((c) => c.blocks.filter((b) => b.src).map((b) => b.src)))];
          await C.sync.deleteLibrary(K.libId, paths);
          try { localStorage.removeItem(cacheKey(K.libId)); } catch { /* yok say */ }
          K.libs = null; K.lib = null;
          C.toast('Kurs silindi.', 'success');
          mountKurs();
        }
        break;
      default: break;
    }
  });
}

function onChange(e) {
  const el = e.target.closest?.('[data-k]');
  if (!el || !document.getElementById('kurs-root')?.contains(el)) return;
  if (el.dataset.k === 'import') { const f = el.files?.[0]; el.value = ''; C.guard(() => importPackage(f)); }
  if (el.dataset.k === 'lib') C.guard(() => openLib(el.value));
}

function onInput(e) {
  if (e.target.id !== 'kurs-q') return;
  K.q = e.target.value;
  const body = document.getElementById('kurs-body');
  if (body) { body.innerHTML = K.q.trim().length >= 2 ? searchHtml() : chapterHtml(K.lib.content.chapters[K.ch]); loadImages(); }
  const toc = document.getElementById('kurs-toc-list');
  if (toc) toc.innerHTML = tocHtml();
}

// FSP alıştırma modülü: Vokabeltrainer, Grammatik alıştırmaları ve Fehlerheft (deneme raporlarındaki hatalar).
// fsp.js bu modülü initTrain(ctx) ile bağlar; sekmede trainHtml(sub) yer tutucusu çizilir, ardından mountTrain(sub) çağrılır.
// Olay delegasyonu kendi önekini kullanır: data-tr (eylem), data-tri (sıra no), data-trv (değer), data-tr-in (giriş alanı).

let C = null;
const T = {
  sub: 'vokabel',
  voc: { items: null, mode: 'mix', kat: '', src: '', len: 20, session: null, pending: false },
  gram: { data: null, topicId: null, run: null, pending: false },
  feh: { kat: '', showFixed: false, open: null, input: '', check: null, pending: false, limit: 40 },
};
const DECK = 'FSP Wiederholen';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ARTS = ['der', 'die', 'das'];
const MODES = [
  ['mix', 'Karışık'], ['de-tr', 'DE → TR'], ['tr-de', 'TR → DE'], ['umg-fach', 'Umgangssprache → Fachsprache'],
  ['artikel', 'Artikel (der/die/das)'], ['luecke', 'Lückentext'], ['mc', 'Çoktan seçmeli'], ['satz', 'Cümle kur'],
];
const FKAT = ['Grammatik', 'Wortschatz', 'Fachsprache', 'Satzbau/Register', 'Konjunktiv', 'Rechtschreibung', 'Medizinisch', 'Kommunikation'];

export function initTrain(ctx) {
  C = ctx;
  C.main.addEventListener('click', onClick);
  C.main.addEventListener('keydown', onKey);
  C.main.addEventListener('change', onChange);
}

/* ------------------------------------------------------------------ yardımcılar */

/** Toleranslı karşılaştırma için: küçük harf, aksan/umlaut/ß, tırnak ve noktalama farkları yok sayılır. */
function norm(s) {
  return String(s ?? '').toLocaleLowerCase('de').replace(/ß/g, 'ss').replace(/ı/g, 'i')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .replace(/[„“”"'‚‘’«»`´]/g, '').replace(/[.,;:!?()[\]{}–—\-/…]/g, ' ')
    .replace(/\s+/g, ' ').trim();
}
/** Levenshtein uzaklığı (yazım hatası toleransı için). */
function lev(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** Normalize edilmiş iki metin aynı mı ya da küçük bir yazım hatası kadar mı farklı? 'exact' | 'typo' | null */
function close(input, target) {
  const a = norm(input); const b = norm(target);
  if (!a || !b) return null;
  if (a === b) return 'exact';
  const tol = b.length >= 10 ? 2 : b.length >= 5 ? 1 : 0;
  return tol && lev(a, b) <= tol ? 'typo' : null;
}
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
};
function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
const dateStr = (t) => (t ? new Date(t * 1000).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const scoreClass = (n) => (n >= 70 ? 'good' : n >= 60 ? 'mid' : 'bad');
const sayBtn = (text) => (text ? `<button type="button" class="icon-btn ftr-say" data-tr="say" data-trv="${esc(text)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button>` : '');
const root = () => document.getElementById('tr-root');
const words = (s) => String(s || '').trim().split(/\s+/).filter(Boolean).length;
function savePrefs() { try { C.savePrefs(); } catch (e) { console.error(e); } }

/* ------------------------------------------------------------------ giriş noktası */

export function trainHtml(sub) {
  return `<div id="tr-root" class="ftr" data-sub="${esc(sub || T.sub)}"><div class="muted">Yükleniyor…</div></div>`;
}

export async function mountTrain(sub) {
  if (sub) T.sub = sub;
  const el = root();
  if (!el) return;
  try {
    if (T.sub === 'vokabel') await loadVocab();
    else if (T.sub === 'grammatik') await loadGrammar();
  } catch (e) {
    console.error(e);
    el.innerHTML = `<div class="panel empty">İçerik yüklenemedi: ${esc(e.message || e)}</div>`;
    return;
  }
  render();
}

function render() {
  const el = root();
  if (!el) return;
  el.dataset.sub = T.sub;
  el.innerHTML = { vokabel: vocHtml, grammatik: gramHtml, fehler: fehHtml }[T.sub]?.() || '';
  const focus = el.querySelector('[data-tr-focus]');
  if (focus) focus.focus({ preventScroll: true });
}

/* ================================================================== VOKABELTRAINER */

/** "die Karies" → { artikel: 'die', wort: 'Karies' } */
function splitArt(s) {
  const m = String(s || '').trim().match(/^(der|die|das)\s+(.+)$/i);
  return m ? { artikel: m[1].toLowerCase(), wort: m[2].trim() } : { artikel: '', wort: String(s || '').trim() };
}
const full = (it) => (it.artikel ? `${it.artikel} ${it.wort}` : it.wort);

async function loadVocab() {
  if (T.voc.items) return;
  const out = [];
  const seen = new Set();
  const push = (it) => {
    if (!it.wort) return;
    const k = norm(full(it));
    if (seen.has(k)) return;
    seen.add(k);
    out.push(it);
  };
  // 1) Gizli kurs paketi (varsa)
  let study = null;
  try { study = C.getStudy ? await C.getStudy() : null; } catch (e) { console.warn('Kurs paketi okunamadı', e); }
  for (const v of (Array.isArray(study?.vokabeln) ? study.vokabeln : [])) {
    const sp = splitArt(v.wort);
    const artikel = ARTS.includes(String(v.artikel || '').toLowerCase()) ? String(v.artikel).toLowerCase() : sp.artikel;
    push({
      id: String(v.id || `v-${hash(full({ artikel, wort: sp.wort }))}`), wort: sp.wort, artikel, plural: v.plural || '',
      tr: v.tr || '', erklaerung_de: v.erklaerung_de || '', synonyme: Array.isArray(v.synonyme) ? v.synonyme : [],
      beispiel_de: v.beispiel_de || '', patient: v.patient || '', kategorie: v.kategorie || 'Allgemein',
      source: v.source === 'ek' ? 'ek' : 'kurs', wortart: v.wortart || (artikel ? 'Nomen' : ''),
    });
  }
  // 2) Yedek: herkese açık rehberdeki Fachbegriffe (kurstan değil → 'ek')
  try {
    const g = await fetch('content/fsp-guide.json').then((r) => (r.ok ? r.json() : null));
    for (const t of (g?.terms || [])) {
      const sp = splitArt(t.fach);
      push({
        id: `g-${hash(norm(t.fach))}`, wort: sp.wort, artikel: sp.artikel, plural: '', tr: t.tr || '', erklaerung_de: '',
        synonyme: [], beispiel_de: '', patient: t.umgang || '', kategorie: t.kat || 'Allgemein', source: 'ek',
        wortart: sp.artikel ? 'Nomen' : '',
      });
    }
  } catch (e) { console.warn('fsp-guide.json okunamadı', e); }
  T.voc.items = out;
}

/** Örnek cümlede kelimeyi bulur → { before, token, after } ya da null */
function clozeOf(it) {
  const s = it.beispiel_de;
  if (!s || !it.wort) return null;
  const w = it.wort.toLocaleLowerCase('de');
  if (/\s/.test(w)) { // çok kelimeli ifade: birebir geçiyorsa
    const at = s.toLocaleLowerCase('de').indexOf(w);
    return at < 0 ? null : { before: s.slice(0, at), token: s.slice(at, at + w.length), after: s.slice(at + w.length) };
  }
  const re = /[A-Za-zÄÖÜäöüß]+(?:-[A-Za-zÄÖÜäöüß]+)*/g;
  const stem = w.slice(0, Math.max(4, w.length - 3));
  let best = null;
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const t = m[0].toLocaleLowerCase('de');
    if (t === w) { best = m; break; }
    if (!best && w.length >= 4 && t.startsWith(stem) && t.length <= w.length + 4) best = m;
  }
  return best ? { before: s.slice(0, best.index), token: best[0], after: s.slice(best.index + best[0].length) } : null;
}

function modesFor(it) {
  const m = [];
  if (it.tr) m.push('de-tr', 'tr-de', 'mc');
  if (it.patient && norm(it.patient) !== norm(full(it))) m.push('umg-fach');
  if (ARTS.includes(it.artikel)) m.push('artikel');
  if (clozeOf(it)) m.push('luecke');
  m.push('satz');
  return m;
}

function vocPool() {
  const v = T.voc;
  return (v.items || []).filter((it) => (!v.kat || it.kategorie === v.kat) && (!v.src || it.source === v.src));
}
const wrongMap = () => (C.prefs.fspWrong && typeof C.prefs.fspWrong === 'object' ? C.prefs.fspWrong : {});

function pickOptions(it, pool, label) {
  const right = label(it);
  const sameKat = shuffle(pool.filter((x) => x !== it && x.kategorie === it.kategorie));
  const others = shuffle(pool.filter((x) => x !== it && x.kategorie !== it.kategorie));
  const seen = new Set([norm(right)]);
  const opts = [right];
  for (const x of [...sameKat, ...others]) {
    const l = label(x);
    if (!l || seen.has(norm(l))) continue;
    seen.add(norm(l));
    opts.push(l);
    if (opts.length === 4) break;
  }
  return shuffle(opts);
}

function makeQ(it, mode, pool) {
  const q = { it, mode, done: false, ok: null, given: '', note: '', check: null, shown: false };
  if (mode === 'mc') q.options = pickOptions(it, pool.filter((x) => x.tr), (x) => x.tr);
  if (mode === 'umg-fach') q.options = pickOptions(it, pool, full);
  if (mode === 'luecke') q.cloze = clozeOf(it);
  return q;
}

function startSession(onlyIds = null) {
  const v = T.voc;
  const all = vocPool();
  const pool = onlyIds ? (v.items || []).filter((it) => onlyIds.includes(it.id)) : all;
  const fits = (it) => (v.mode === 'mix' ? modesFor(it).some((m) => m !== 'satz') : modesFor(it).includes(v.mode));
  const eligible = pool.filter(fits);
  if (!eligible.length) { C.toast('Bu filtre ve alıştırma türü için uygun kelime yok.', 'info'); return; }
  const len = onlyIds ? eligible.length : Math.min(v.len, eligible.length);
  // Sık yanlış bilinenler öne alınır (en fazla oturumun yarısı)
  const w = wrongMap();
  const weak = shuffle(eligible.filter((it) => w[it.id] > 0)).sort((a, b) => w[b.id] - w[a.id]).slice(0, Math.ceil(len / 2));
  const rest = shuffle(eligible.filter((it) => !weak.includes(it))).slice(0, len - weak.length);
  const optPool = all.length >= 4 ? all : v.items || [];
  const qs = shuffle([...weak, ...rest]).map((it) => {
    const ms = v.mode === 'mix' ? modesFor(it).filter((m) => m !== 'satz') : [v.mode];
    return makeQ(it, ms[Math.floor(Math.random() * ms.length)], optPool);
  });
  v.session = { qs, i: 0, finished: false, added: 0 };
  render();
}

function vocHtml() {
  const v = T.voc;
  if (!v.items?.length) return '<div class="panel empty">Kelime listesi bulunamadı. Kurs paketi yüklendiğinde burada kurs kelimeleri de görünür.</div>';
  if (v.session) return v.session.finished ? vocResultHtml() : vocQuestionHtml();
  return vocSetupHtml();
}

function vocSetupHtml() {
  const v = T.voc;
  const pool = vocPool();
  const kats = [...new Set(v.items.filter((it) => !v.src || it.source === v.src).map((it) => it.kategorie))].sort((a, b) => a.localeCompare(b, 'de'));
  const nKurs = v.items.filter((it) => it.source === 'kurs').length;
  const w = wrongMap();
  const weak = v.items.filter((it) => w[it.id] > 0).sort((a, b) => w[b.id] - w[a.id]);
  return `
    <section class="panel ftr-setup">
      <h3>Vokabeltrainer</h3>
      <p class="muted">${v.items.length} kelime${nKurs ? ` · ${nKurs} tanesi kurstan` : ' · kurs paketi yok, rehberdeki Fachbegriffe kullanılıyor'}. Yanlış bildiklerin otomatik olarak “${esc(DECK)}” destesine eklenir ve sonraki oturumlarda önce sorulur.</p>
      <div class="ftr-field"><span class="ftr-lbl">Alıştırma türü</span>
        <div class="chips">${MODES.map(([k, l]) => `<button type="button" class="chip ${v.mode === k ? 'on' : ''}" data-tr="v-mode" data-trv="${k}">${esc(l)}</button>`).join('')}</div></div>
      ${nKurs ? `<div class="ftr-field"><span class="ftr-lbl">Kaynak</span>
        <div class="chips">${[['', 'Tümü'], ['kurs', 'Kurs'], ['ek', 'Ek']].map(([k, l]) => `<button type="button" class="chip ${v.src === k ? 'on' : ''}" data-tr="v-src" data-trv="${k}">${l}</button>`).join('')}</div></div>` : ''}
      <div class="ftr-field"><span class="ftr-lbl">Kategori</span>
        <div class="chips">${['', ...kats].map((k) => `<button type="button" class="chip ${v.kat === k ? 'on' : ''}" data-tr="v-kat" data-trv="${esc(k)}">${k ? esc(k) : 'Tümü'}</button>`).join('')}</div></div>
      <div class="ftr-field"><span class="ftr-lbl">Oturum uzunluğu</span>
        <div class="chips">${[10, 20, 40].map((n) => `<button type="button" class="chip ${v.len === n ? 'on' : ''}" data-tr="v-len" data-trv="${n}">${n} soru</button>`).join('')}</div></div>
      <div class="ftr-actions"><span class="muted">${pool.length} kelime seçili</span>
        <button class="primary" data-tr="v-start" ${pool.length ? '' : 'disabled'}>Başla</button></div>
    </section>
    ${weak.length ? `<section class="panel">
      <div class="ftr-sec-head"><h3>Sık yanlış bildiklerin <span class="muted">(${weak.length})</span></h3>
        <button data-tr="v-weak">Sadece bunları çalış</button></div>
      <div class="ftr-weak">${weak.slice(0, 24).map((it) => `<span class="ftr-weak-i" title="${esc(it.tr)}"><b lang="de">${esc(full(it))}</b> <span class="sc bad">${w[it.id]}×</span></span>`).join('')}</div>
    </section>` : ''}`;
}

function progressHtml(i, n, extra = '') {
  return `<div class="ftr-top"><span class="muted">${Math.min(i + 1, n)} / ${n}</span>
    <div class="ftr-progress"><span style="width:${Math.round((i / n) * 100)}%"></span></div>${extra}</div>`;
}

function vocQuestionHtml() {
  const s = T.voc.session;
  const q = s.qs[s.i];
  const it = q.it;
  const okN = s.qs.filter((x) => x.ok === true).length;
  const head = progressHtml(s.i, s.qs.length, `<span class="sc good" title="Doğru">${okN}</span><button class="ghost" data-tr="v-end">Bitir</button>`);
  const label = { 'de-tr': 'Türkçesi ne?', 'tr-de': 'Almancası ne? (artikeliyle)', mc: 'Doğru anlamı seç', 'umg-fach': 'Hasta böyle diyor; Fachsprache karşılığı hangisi?',
    artikel: 'Artikel hangisi?', luecke: 'Boşluğu doldur', satz: 'Bu kelimeyle Almanca bir cümle kur' }[q.mode];
  let prompt = '';
  let body = '';
  const dis = q.done ? 'disabled' : '';
  const input = (ph) => `<div class="ftr-ans"><input type="text" data-tr-in="voc" placeholder="${esc(ph)}" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(q.given)}" ${dis} ${q.done ? '' : 'data-tr-focus'}>
      ${q.done ? '' : '<button class="primary" data-tr="v-check">Kontrol et</button><button class="ghost" data-tr="v-skip">Bilmiyorum</button>'}</div>`;
  const opts = (list, right) => `<div class="ftr-opts">${list.map((o) => {
    const cls = q.done ? (norm(o) === norm(right) ? 'right' : norm(o) === norm(q.given) ? 'wrong' : '') : '';
    return `<button type="button" class="ftr-opt ${cls}" data-tr="v-opt" data-trv="${esc(o)}" ${dis}>${esc(o)}</button>`;
  }).join('')}</div>`;
  switch (q.mode) {
    case 'de-tr': prompt = `<span lang="de">${esc(full(it))}</span>${sayBtn(full(it))}`; body = input('Türkçe anlamı…'); break;
    case 'tr-de': prompt = `<span>${esc(it.tr)}</span>`; body = input('z. B. die Karies'); break;
    case 'mc': prompt = `<span lang="de">${esc(full(it))}</span>${sayBtn(full(it))}`; body = opts(q.options, it.tr); break;
    case 'umg-fach': prompt = `<span lang="de">„${esc(it.patient)}“</span>${sayBtn(it.patient)}`; body = opts(q.options, full(it)); break;
    case 'artikel':
      prompt = `<span lang="de">${esc(it.wort)}</span>`;
      body = `${it.tr ? `<p class="muted ftr-hint">${esc(it.tr)}</p>` : ''}<div class="ftr-opts ftr-arts">${ARTS.map((a) => {
        const cls = q.done ? (a === it.artikel ? 'right' : a === q.given ? 'wrong' : '') : '';
        return `<button type="button" class="ftr-opt ftr-art-${a} ${cls}" data-tr="v-opt" data-trv="${a}" ${dis}>${a}</button>`;
      }).join('')}</div>`;
      break;
    case 'luecke': {
      const c = q.cloze;
      prompt = `<span lang="de" class="ftr-cloze">${esc(c.before)}<span class="ftr-gap">${q.done ? esc(c.token) : '_____'}</span>${esc(c.after)}</span>`;
      body = `<p class="muted ftr-hint">İpucu: ${esc(it.tr || '—')} · ${esc(c.token[0])}… (${c.token.length} harf)</p>${input('Eksik kelime…')}`;
      break;
    }
    case 'satz':
      prompt = `<span lang="de">${esc(full(it))}</span>${sayBtn(full(it))}`;
      body = `${it.tr ? `<p class="muted ftr-hint">${esc(it.tr)}${it.erklaerung_de ? ` · <span lang="de">${esc(it.erklaerung_de)}</span>` : ''}</p>` : ''}
        <textarea data-tr-in="satz" rows="3" placeholder="Bir ya da iki cümle yaz… (Ctrl+Enter: kontrol)" spellcheck="false" ${q.done ? 'disabled' : 'data-tr-focus'}>${esc(q.given)}</textarea>
        ${q.done ? '' : `<div class="ftr-actions">
          ${C.sync.user() ? `<button class="primary" data-tr="v-ai" ${T.voc.pending ? 'disabled' : ''}>${T.voc.pending ? 'Değerlendiriliyor…' : 'AI ile kontrol et'}</button>` : ''}
          ${q.shown ? '<button data-tr="v-self" data-trv="1">✓ Doğru kurdum</button><button data-tr="v-self" data-trv="0">✗ Kuramadım</button>'
            : '<button data-tr="v-show">Örneği göster</button>'}</div>`}
        ${q.shown && !q.done ? exampleHtml(it) : ''}`;
      break;
    default: break;
  }
  return `<section class="panel ftr-q">
    ${head}
    <div class="ftr-q-lbl muted">${esc(label)}${it.kategorie ? ` · <span class="badge">${esc(it.kategorie)}</span>` : ''}${it.source === 'kurs' ? ' <span class="badge ftr-kurs">kurs</span>' : ''}</div>
    <div class="ftr-prompt">${prompt}</div>
    ${body}
    ${q.done ? feedbackHtml(q) : ''}
  </section>`;
}

function exampleHtml(it) {
  return it.beispiel_de ? `<div class="ftr-example"><span class="muted">Örnek:</span> <span lang="de">${esc(it.beispiel_de)}</span>${sayBtn(it.beispiel_de)}</div>` : '<p class="muted">Bu kelime için örnek cümle yok.</p>';
}

function feedbackHtml(q) {
  const it = q.it;
  const ch = q.check;
  const info = [
    it.plural ? `<div><span class="muted">Plural:</span> <span lang="de">${esc(it.plural)}</span></div>` : '',
    it.erklaerung_de && q.mode !== 'satz' ? `<div lang="de">${esc(it.erklaerung_de)}</div>` : '',
    it.patient && q.mode !== 'umg-fach' ? `<div><span class="muted">Hastaya:</span> <span lang="de">${esc(it.patient)}</span></div>` : '',
    it.synonyme?.length ? `<div><span class="muted">Eş anlamlı:</span> <span lang="de">${esc(it.synonyme.join(', '))}</span></div>` : '',
  ].join('');
  return `<div class="ftr-fb ${q.ok ? 'ok' : 'no'}">
    <div class="ftr-fb-h"><b>${q.ok ? '✓ Doğru' : '✗ Yanlış'}</b>${q.note ? ` <span class="muted">${esc(q.note)}</span>` : ''}</div>
    ${ch ? `<div class="ftr-ai"><span class="sc ${scoreClass(ch.punkte)}">${ch.punkte}</span> ${esc(ch.feedback)}
      ${ch.korrigiert ? `<div class="ftr-fix"><span class="muted">Düzeltilmiş:</span> <span lang="de">${esc(ch.korrigiert)}</span>${sayBtn(ch.korrigiert)}</div>` : ''}</div>` : ''}
    <div class="ftr-right"><b lang="de">${esc(full(it))}</b>${sayBtn(full(it))} <span class="muted">— ${esc(it.tr)}</span></div>
    ${info ? `<div class="ftr-info">${info}</div>` : ''}
    ${it.beispiel_de ? exampleHtml(it) : ''}
    <div class="ftr-actions">
      ${!q.ok && q.given && q.mode !== 'satz' && !['mc', 'umg-fach', 'artikel'].includes(q.mode) ? '<button class="ghost" data-tr="v-override">Aslında doğruydu</button>' : ''}
      <button class="primary" data-tr="v-next" data-tr-focus>${T.voc.session.i + 1 >= T.voc.session.qs.length ? 'Sonuçları gör' : 'Devam →'}</button>
    </div>
  </div>`;
}

/** Yazılı cevabı değerlendirir → { ok, note } */
function judge(q, given) {
  const it = q.it;
  if (q.mode === 'de-tr') {
    const alts = String(it.tr).replace(/\([^)]*\)/g, ' ').split(/[,;/]| veya | ya da /).map((s) => s.trim()).filter(Boolean);
    const hits = [...alts, it.tr].map((a) => close(given, a));
    if (hits.includes('exact')) return { ok: true, note: '' };
    if (hits.includes('typo')) return { ok: true, note: 'Küçük bir yazım farkı var.' };
    return { ok: false, note: '' };
  }
  if (q.mode === 'tr-de') {
    const g = splitArt(given);
    const hit = close(g.wort, it.wort) || (it.synonyme || []).map((s) => close(g.wort, splitArt(s).wort)).find(Boolean);
    if (!hit) return { ok: false, note: '' };
    if (it.artikel && g.artikel && g.artikel !== it.artikel) return { ok: false, note: `Kelime doğru ama artikel “${it.artikel}” olmalı.` };
    const notes = [];
    if (it.artikel && !g.artikel) notes.push(`Artikeli de öğren: ${it.artikel}.`);
    if (hit === 'typo') notes.push('Küçük bir yazım farkı var.');
    if (!close(g.wort, it.wort)) notes.push('Eş anlamlı bir kelime yazdın.');
    return { ok: true, note: notes.join(' ') };
  }
  if (q.mode === 'luecke') {
    const t = close(given, q.cloze.token);
    if (t === 'exact') return { ok: true, note: '' };
    if (close(given, it.wort) === 'exact' && norm(it.wort) !== norm(q.cloze.token)) return { ok: true, note: `Cümledeki doğru hâli: ${q.cloze.token}` };
    if (t) return { ok: true, note: 'Küçük bir yazım farkı var.' };
    return { ok: false, note: '' };
  }
  return { ok: false, note: '' };
}

/** Bir sorunun sonucunu kaydeder: yanlışsa sayaç + “FSP Wiederholen” destesi. */
function settle(q, ok, note = '') {
  q.done = true;
  q.ok = ok;
  q.note = note;
  const w = { ...wrongMap() };
  if (ok) {
    if (w[q.it.id] > 0) { w[q.it.id] -= 1; if (!w[q.it.id]) delete w[q.it.id]; }
  } else {
    w[q.it.id] = (w[q.it.id] || 0) + 1;
    if (addToDeck(q.it)) T.voc.session.added++;
  }
  C.prefs.fspWrong = w;
  savePrefs();
}

function wiederholenDeck() {
  const decks = C.store.getDecks();
  const own = decks.find((d) => d.name === DECK && d.role !== 'viewer');
  if (own) return own;
  return C.store.createDeck({ name: DECK, language: 'de' });
}
function addToDeck(it) {
  try {
    const deck = wiederholenDeck();
    const r = C.store.importCards({ deck_id: deck.id }, [{ word: full(it), translation: it.tr, sentence: it.beispiel_de, notes: it.erklaerung_de }]);
    return r.added > 0;
  } catch (e) {
    console.error(e);
    C.toast(`Desteye eklenemedi: ${e.message || e}`, 'error');
    return false;
  }
}

function vocResultHtml() {
  const s = T.voc.session;
  const done = s.qs.filter((q) => q.done);
  const ok = done.filter((q) => q.ok).length;
  const pct = done.length ? Math.round((ok / done.length) * 100) : 0;
  const wrong = done.filter((q) => !q.ok);
  return `<section class="panel ftr-result">
      <div class="ftr-score ${scoreClass(pct)}"><b>${ok}</b><span>/ ${done.length}</span></div>
      <div><h3>Oturum bitti</h3><p class="muted">%${pct} doğru.${s.added ? ` ${s.added} kelime “${esc(DECK)}” destesine eklendi.` : ''}${wrong.length ? ' Yanlışların bir sonraki oturumda önce sorulacak.' : ''}</p></div>
    </section>
    ${wrong.length ? `<section class="panel"><h3>Yanlış bildiklerin</h3><div class="ftr-list">${wrong.map((q) => `
      <div class="ftr-row"><b lang="de">${esc(full(q.it))}</b>${sayBtn(full(q.it))}<span class="muted">${esc(q.it.tr)}</span>${q.given ? `<span class="ftr-given">senin cevabın: ${esc(q.given)}</span>` : ''}</div>`).join('')}</div></section>` : ''}
    <div class="ftr-actions">
      ${wrong.length ? '<button data-tr="v-retry">Yanlışları tekrar çalış</button>' : ''}
      <button data-tr="v-setup">Ayarlar</button>
      <button class="primary" data-tr="v-start">Yeni oturum</button>
    </div>`;
}

async function vocAi() {
  const s = T.voc.session;
  const q = s?.qs[s.i];
  if (!q || T.voc.pending) return;
  const answer = (C.main.querySelector('[data-tr-in="satz"]')?.value || '').trim();
  q.given = answer;
  if (words(answer) < 4) { C.toast('Önce en az 4 kelimelik bir cümle yaz.', 'info'); return; }
  T.voc.pending = true;
  render();
  try {
    const res = await C.sync.fspAi({ action: 'answer', question: `Bilden Sie einen Satz mit „${full(q.it)}“ (${q.it.tr}).`, model: q.it.beispiel_de || '', answer, kind: 'arzt' }, 60_000);
    const ch = res?.check;
    if (!ch) throw new Error('Değerlendirme alınamadı.');
    if (T.voc.session === s && s.qs[s.i] === q && !q.done) { q.check = ch; settle(q, ch.punkte >= 60, ch.punkte >= 60 ? '' : 'Cümle tam olmadı; düzeltilmiş hâline bak.'); }
  } finally {
    T.voc.pending = false;
    if (T.sub === 'vokabel') render();
  }
}

function vocClick(act, el) {
  const v = T.voc;
  const s = v.session;
  const q = s && !s.finished ? s.qs[s.i] : null;
  switch (act) {
    case 'v-mode': v.mode = el.dataset.trv; render(); break;
    case 'v-src': v.src = el.dataset.trv; if (v.kat && !vocPool().length) v.kat = ''; render(); break;
    case 'v-kat': v.kat = el.dataset.trv; render(); break;
    case 'v-len': v.len = Number(el.dataset.trv) || 20; render(); break;
    case 'v-start': startSession(); break;
    case 'v-weak': { const w = wrongMap(); startSession(v.items.filter((it) => w[it.id] > 0).map((it) => it.id)); break; }
    case 'v-retry': startSession(s.qs.filter((x) => x.done && !x.ok).map((x) => x.it.id)); break;
    case 'v-setup': v.session = null; render(); break;
    case 'v-end':
      if (s.qs.some((x) => x.done)) { s.finished = true; C.refreshDecks?.(); } else v.session = null;
      render();
      break;
    case 'v-check': {
      if (!q || q.done) return;
      const given = (C.main.querySelector('[data-tr-in="voc"]')?.value || '').trim();
      if (!given) { C.toast('Önce cevabını yaz ya da “Bilmiyorum”a bas.', 'info'); return; }
      q.given = given;
      const r = judge(q, given);
      settle(q, r.ok, r.note);
      render();
      break;
    }
    case 'v-skip': if (q && !q.done) { q.given = ''; settle(q, false, ''); render(); } break;
    case 'v-opt': {
      if (!q || q.done) return;
      q.given = el.dataset.trv;
      const right = q.mode === 'mc' ? q.it.tr : q.mode === 'artikel' ? q.it.artikel : full(q.it);
      settle(q, norm(q.given) === norm(right), '');
      render();
      break;
    }
    case 'v-show': if (q) { q.given = C.main.querySelector('[data-tr-in="satz"]')?.value || q.given; q.shown = true; render(); } break;
    case 'v-self': if (q && !q.done) { q.given = C.main.querySelector('[data-tr-in="satz"]')?.value || q.given; settle(q, el.dataset.trv === '1', 'Kendi değerlendirmen.'); render(); } break;
    case 'v-ai': return vocAi();
    case 'v-override': {
      if (!q || q.ok) return;
      q.ok = true;
      q.note = 'Doğru sayıldı.';
      const w = { ...wrongMap() };
      if (w[q.it.id] > 0) { w[q.it.id] -= 1; if (!w[q.it.id]) delete w[q.it.id]; }
      C.prefs.fspWrong = w;
      savePrefs();
      render();
      break;
    }
    case 'v-next':
      if (!q || !q.done) return;
      if (s.i + 1 >= s.qs.length) { s.finished = true; C.refreshDecks?.(); } else s.i++;
      render();
      break;
    default: break;
  }
  return undefined;
}

/* ================================================================== GRAMMATİK */

async function loadGrammar() {
  if (T.gram.data) return;
  const tr = C.loadTraining ? await C.loadTraining() : null;
  T.gram.data = Array.isArray(tr?.grammar) ? tr.grammar : [];
}
const gramScores = () => (C.prefs.fspGrammar && typeof C.prefs.fspGrammar === 'object' ? C.prefs.fspGrammar : {});
const topicOf = (id) => (T.gram.data || []).find((t) => t.id === id) || null;

function gramHtml() {
  const g = T.gram;
  if (!g.data.length) return '<div class="panel empty">Gramer içeriği henüz yok.</div>';
  const t = topicOf(g.topicId);
  if (!t) return gramListHtml();
  if (g.run) return g.run.i >= g.run.items.length ? gramResultHtml(t) : gramExerciseHtml(t);
  return gramTopicHtml(t);
}

function gramListHtml() {
  const sc = gramScores();
  return `<div class="ftr-topics">${T.gram.data.map((t) => {
    const s = sc[t.id];
    const n = t.uebungen?.length || 0;
    const pct = s && s.done ? Math.round((s.correct / s.done) * 100) : null;
    return `<button type="button" class="panel ftr-topic" data-tr="g-open" data-trv="${esc(t.id)}">
      <span class="ftr-topic-h"><b lang="de">${esc(t.title_de)}</b>${pct !== null ? `<span class="sc ${scoreClass(pct)}">${s.correct}/${s.done}</span>` : ''}</span>
      <span class="muted">${esc(t.title_tr || '')}</span>
      <span class="ftr-topic-n muted">${n} alıştırma</span></button>`;
  }).join('')}</div>`;
}

function gramTopicHtml(t) {
  const n = t.uebungen?.length || 0;
  const s = gramScores()[t.id];
  return `<section class="panel ftr-gram">
      <div class="ftr-sec-head"><button class="ghost" data-tr="g-back">← Konular</button>${s ? `<span class="muted">Son skor: ${s.correct}/${s.done}</span>` : ''}</div>
      <h2 lang="de">${esc(t.title_de)}</h2>${t.title_tr ? `<p class="muted">${esc(t.title_tr)}</p>` : ''}
      <div class="ftr-expl">${esc(t.erklaerung_tr || '').replace(/\n/g, '<br>')}</div>
      ${t.beispiele?.length ? `<h3>Örnekler</h3><ul class="ftr-ex">${t.beispiele.map((b) => `<li><span lang="de">${esc(b)}</span>${sayBtn(b)}</li>`).join('')}</ul>` : ''}
      <div class="ftr-actions">${n ? `<button class="primary" data-tr="g-start">Alıştırmalara başla (${n})</button>` : '<span class="muted">Bu konuda alıştırma yok.</span>'}</div>
    </section>`;
}

/** Seçmeli alıştırmada doğru seçeneğin sırası */
function choiceIndex(u) {
  const opts = u.optionen || [];
  if (typeof u.loesung === 'number') return u.loesung;
  const l = norm(u.loesung);
  let i = opts.findIndex((o) => norm(o) === l);
  if (i < 0) {
    let best = -1;
    opts.forEach((o, k) => { const n = norm(o); if (n && l.includes(n) && (best < 0 || n.length > norm(opts[best]).length)) best = k; });
    i = best;
  }
  return i;
}
const solutionText = (u) => (u.typ === 'choice' && typeof u.loesung === 'number' ? (u.optionen || [])[u.loesung] : u.loesung) || '';

function gramJudge(u, given) {
  const alts = String(u.loesung || '').split(/\s\/\s|\|/).map((s) => s.trim()).filter(Boolean);
  for (const a of alts) {
    const c = close(given, a);
    if (c === 'exact') return { ok: true, note: '' };
    if (c === 'typo' && u.typ === 'cloze') return { ok: true, note: 'Küçük bir yazım farkı var.' };
  }
  if (u.typ === 'cloze') {
    // Boşluklu cümlede boşluğu cevapla doldurup çözümle karşılaştır
    const gap = /_{2,}|…|\.\.\./;
    if (gap.test(u.aufgabe || '')) {
      const filled = String(u.aufgabe).replace(gap, given).split(/→|->/)[0];
      if (alts.some((a) => close(filled, a) === 'exact')) return { ok: true, note: '' };
    }
  }
  if (u.typ === 'transform') {
    // Uzun cümlelerde 40 karakter başına bir harf farkına izin verilir
    const a = norm(given);
    if (alts.some((x) => { const b = norm(x); return lev(a, b) <= Math.floor(b.length / 40); })) return { ok: true, note: 'Küçük bir yazım farkı var.' };
  }
  return { ok: false, note: '' };
}

function gramExerciseHtml(t) {
  const g = T.gram;
  const run = g.run;
  const u = run.items[run.i];
  const r = run.res[run.i] || null;
  const dis = r ? 'disabled' : '';
  let body = '';
  if (u.typ === 'choice') {
    const ci = choiceIndex(u);
    body = `<div class="ftr-opts">${(u.optionen || []).map((o, k) => {
      const cls = r ? (k === ci ? 'right' : String(k) === r.given ? 'wrong' : '') : '';
      return `<button type="button" class="ftr-opt ${cls}" data-tr="g-opt" data-tri="${k}" lang="de" ${dis}>${esc(o)}</button>`;
    }).join('')}</div>`;
  } else {
    const ta = u.typ === 'transform';
    body = `${ta ? `<textarea data-tr-in="gram" rows="3" placeholder="Dönüştürülmüş cümle… (Ctrl+Enter: kontrol)" spellcheck="false" ${dis} ${r ? '' : 'data-tr-focus'}>${esc(r?.given || run.draft || '')}</textarea>`
      : `<input type="text" data-tr-in="gram" placeholder="Cevabın…" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(r?.given || run.draft || '')}" ${dis} ${r ? '' : 'data-tr-focus'}>`}
      ${r ? '' : '<div class="ftr-actions"><button class="primary" data-tr="g-check">Kontrol et</button><button class="ghost" data-tr="g-skip">Çözümü göster</button></div>'}`;
  }
  const fb = r ? `<div class="ftr-fb ${r.ok ? 'ok' : 'no'}">
      <div class="ftr-fb-h"><b>${r.ok ? '✓ Doğru' : '✗ Tam eşleşmedi'}</b>${r.note ? ` <span class="muted">${esc(r.note)}</span>` : ''}</div>
      ${r.check ? `<div class="ftr-ai"><span class="sc ${scoreClass(r.check.punkte)}">${r.check.punkte}</span> ${esc(r.check.feedback)}
        ${r.check.korrigiert ? `<div class="ftr-fix"><span class="muted">Düzeltilmiş:</span> <span lang="de">${esc(r.check.korrigiert)}</span></div>` : ''}</div>` : ''}
      <div class="ftr-right"><span class="muted">Çözüm:</span> <b lang="de">${esc(solutionText(u))}</b>${sayBtn(solutionText(u))}</div>
      ${u.erklaerung_tr ? `<p class="ftr-expl-s">${esc(u.erklaerung_tr)}</p>` : ''}
      <div class="ftr-actions">
        ${!r.ok && r.given && u.typ === 'transform' && !r.check && C.sync.user() ? `<button data-tr="g-ai" ${g.pending ? 'disabled' : ''}>${g.pending ? 'Değerlendiriliyor…' : 'AI ile kontrol'}</button>` : ''}
        ${!r.ok && r.given && u.typ !== 'choice' ? '<button class="ghost" data-tr="g-override">Doğru say</button>' : ''}
        <button class="primary" data-tr="g-next" ${g.pending ? '' : 'data-tr-focus'}>${run.i + 1 >= run.items.length ? 'Sonuç' : 'Sonraki →'}</button>
      </div></div>` : '';
  return `<section class="panel ftr-q">
    ${progressHtml(run.i, run.items.length, '<button class="ghost" data-tr="g-quit">Bitir</button>')}
    <div class="ftr-q-lbl muted"><span lang="de">${esc(t.title_de)}</span> · ${{ cloze: 'Boşluk doldur', transform: 'Dönüştür', choice: 'Seç' }[u.typ] || esc(u.typ)}</div>
    <div class="ftr-prompt ftr-prompt-s" lang="de">${esc(u.aufgabe)}</div>
    ${body}${fb}
  </section>`;
}

function gramResultHtml(t) {
  const run = T.gram.run;
  const done = run.res.filter(Boolean);
  const ok = done.filter((r) => r.ok).length;
  const pct = done.length ? Math.round((ok / done.length) * 100) : 0;
  return `<section class="panel ftr-result">
      <div class="ftr-score ${scoreClass(pct)}"><b>${ok}</b><span>/ ${done.length}</span></div>
      <div><h3 lang="de">${esc(t.title_de)}</h3><p class="muted">%${pct} doğru.</p></div>
    </section>
    <div class="ftr-actions"><button data-tr="g-back">Konular</button><button data-tr="g-open" data-trv="${esc(t.id)}">Konu anlatımı</button><button class="primary" data-tr="g-start">Tekrar</button></div>`;
}

function saveGramScore() {
  const run = T.gram.run;
  if (!run || run.saved) return;
  const done = run.res.filter(Boolean);
  if (!done.length) return;
  run.saved = true;
  C.prefs.fspGrammar = { ...gramScores(), [T.gram.topicId]: { done: done.length, correct: done.filter((r) => r.ok).length, at: Math.floor(Date.now() / 1000) } };
  savePrefs();
}

async function gramAi() {
  const g = T.gram;
  const run = g.run;
  const r = run?.res[run.i];
  const u = run?.items[run.i];
  if (!r || g.pending) return;
  if (words(r.given) < 4) { C.toast('AI kontrolü için cevap en az 4 kelime olmalı.', 'info'); return; }
  g.pending = true;
  render();
  try {
    const res = await C.sync.fspAi({ action: 'answer', question: u.aufgabe, model: solutionText(u), answer: r.given, kind: 'arzt' }, 60_000);
    if (!res?.check) throw new Error('Değerlendirme alınamadı.');
    r.check = res.check;
    if (res.check.punkte >= 70) { r.ok = true; r.note = 'AI cevabını kabul etti.'; }
  } finally {
    g.pending = false;
    if (T.sub === 'grammatik') render();
  }
}

function gramClick(act, el) {
  const g = T.gram;
  const run = g.run;
  const u = run ? run.items[run.i] : null;
  switch (act) {
    case 'g-open': saveGramScore(); g.topicId = el.dataset.trv; g.run = null; render(); break;
    case 'g-back': saveGramScore(); g.topicId = null; g.run = null; render(); break;
    case 'g-start': {
      const t = topicOf(g.topicId);
      if (!t?.uebungen?.length) return;
      g.run = { items: t.uebungen, i: 0, res: [], draft: '', saved: false };
      render();
      break;
    }
    case 'g-quit': saveGramScore(); run.i = run.items.length; render(); break;
    case 'g-opt': {
      if (!u || run.res[run.i]) return;
      const k = Number(el.dataset.tri);
      run.res[run.i] = { ok: k === choiceIndex(u), given: String(k), note: '' };
      render();
      break;
    }
    case 'g-check': {
      if (!u || run.res[run.i]) return;
      const given = (C.main.querySelector('[data-tr-in="gram"]')?.value || '').trim();
      if (!given) { C.toast('Önce cevabını yaz.', 'info'); return; }
      run.res[run.i] = { ...gramJudge(u, given), given };
      render();
      break;
    }
    case 'g-skip': if (u && !run.res[run.i]) { run.res[run.i] = { ok: false, given: '', note: '' }; render(); } break;
    case 'g-override': { const r = run?.res[run.i]; if (r) { r.ok = true; r.note = 'Doğru sayıldı.'; render(); } break; }
    case 'g-ai': return gramAi();
    case 'g-next':
      if (!run?.res[run.i]) return;
      run.i++;
      run.draft = '';
      if (run.i >= run.items.length) saveGramScore();
      render();
      break;
    default: break;
  }
  return undefined;
}

/* ================================================================== FEHLERHEFT */

/** Düzeltme türünü (typ + açıklama) Fehlerheft kategorisine eşler. */
function katOf(typ, text) {
  const rules = [
    [/konjunktiv|indirekt|dolayli/, 'Konjunktiv'],
    [/recht|ortho|schreib|tippf|zeichensetz|yazim|imla|noktalama|buyuk harf/, 'Rechtschreibung'],
    [/fach|termin|terim/, 'Fachsprache'],
    [/register|stil|satzbau|wortstell|syntax|hoflich|umgang|cumle yapisi|sozcuk sirasi|kelime sirasi|uslup/, 'Satzbau/Register'],
    [/wortwahl|wortschatz|lexik|vokab|ausdruck|kolloka|kelime secimi|sozcuk secimi/, 'Wortschatz'],
    [/medizin|inhalt|diagnos|therap|anamnes|befund|tibbi|icerik/, 'Medizinisch'],
    [/kommunik|empath|gesprach|iletisim|empati/, 'Kommunikation'],
    [/grammat|kasus|artikel|verb|prapos|deklin|konjug|tempus|plural|gramer|cekim|fiil|edat/, 'Grammatik'],
  ];
  for (const src of [norm(typ), norm(text)]) {
    if (!src) continue;
    const hit = rules.find(([re]) => re.test(src));
    if (hit) return hit[1];
  }
  return 'Grammatik';
}
/** Rapor kategori adını (ör. "Kommunikation", "Therapieplan") Fehlerheft kategorisine eşler. */
function katOfCategory(name) {
  const n = norm(name);
  if (/indirekt|konjunktiv/.test(n)) return 'Konjunktiv';
  if (/fachsprache/.test(n)) return 'Fachsprache';
  if (/kommunikation|gesprachsstruktur|ruckfragen/.test(n)) return 'Kommunikation';
  if (/anamnese|aufklarung|befund|therapie|diagnos|fallvorstellung/.test(n)) return 'Medizinisch';
  if (/sprache|grammat/.test(n)) return 'Grammatik';
  return null;
}

function collectErrors() {
  const map = new Map();
  const notes = [];
  const fehlend = new Map();
  for (const a of C.store.listFsp('attempt')) {
    const r = a.data?.report;
    if (!r) continue;
    const at = r.at || a.data.finishedAt || a.edited_at || a.created_at;
    const c = a.data.case || {};
    const where = `${c.title || c.patient?.name || 'Vaka'}${a.data.part ? ` · Teil ${a.data.part}` : ''}`;
    const besser = Array.isArray(r.besser) ? r.besser : [];
    for (const k of (Array.isArray(r.korrekturen) ? r.korrekturen : [])) {
      if (!k?.original && !k?.korrigiert) continue;
      const key = `k${hash(`${norm(k.original)}|${norm(k.korrigiert)}`)}`;
      const old = map.get(key);
      if (old) { old.n++; if (at > old.at) { old.at = at; old.where = where; } continue; }
      const alt = besser.find((b) => b.statt && k.original && (norm(b.statt).includes(norm(k.original)) || norm(k.original).includes(norm(b.statt))));
      map.set(key, { key, original: k.original || '', korrigiert: k.korrigiert || '', typ: k.typ || '', erklaerung: k.erklaerung || '',
        besser: alt?.besser || '', warum: alt?.warum || '', kat: katOf(k.typ, k.erklaerung), at, where, n: 1 });
    }
    for (const k of (Array.isArray(r.kategorien) ? r.kategorien : [])) {
      const kat = katOfCategory(k.name);
      if (!kat || typeof k.punkte !== 'number' || k.punkte >= 70 || !k.kommentar) continue;
      notes.push({ key: `n${hash(`${a.id}|${k.name}`)}`, note: true, name: k.name, punkte: k.punkte, kommentar: k.kommentar, kat, at, where, n: 1 });
    }
    for (const f of (Array.isArray(r.fehlend) ? r.fehlend : [])) {
      const nk = norm(f);
      if (!nk) continue;
      const o = fehlend.get(nk);
      if (o) o.n++; else fehlend.set(nk, { text: f, n: 1 });
    }
  }
  return { errors: [...map.values(), ...notes].sort((x, y) => y.at - x.at), fehlend: [...fehlend.values()].sort((x, y) => y.n - x.n) };
}
const fixedSet = () => new Set(Array.isArray(C.prefs.fspFixed) ? C.prefs.fspFixed : []);

function fehHtml() {
  const f = T.feh;
  const { errors, fehlend } = collectErrors();
  if (!errors.length && !fehlend.length) {
    return '<div class="panel empty">Henüz hata yok. Bir vakada Teil 1, 2 ya da 3 denemesini bitirip değerlendirince düzeltmeler burada toplanır.</div>';
  }
  const fixed = fixedSet();
  const open = errors.filter((e) => !fixed.has(e.key));
  const counts = Object.fromEntries(FKAT.map((k) => [k, 0]));
  open.forEach((e) => { counts[e.kat] = (counts[e.kat] || 0) + 1; });
  const ranked = FKAT.filter((k) => counts[k]).sort((a, b) => counts[b] - counts[a]);
  const max = Math.max(1, ...Object.values(counts));
  const list = errors.filter((e) => (f.showFixed || !fixed.has(e.key)) && (!f.kat || e.kat === f.kat));
  const repeated = open.filter((e) => e.n > 1).length;
  return `
    <section class="panel ftr-stats">
      <div class="ftr-sec-head"><h3>Hata türleri</h3><span class="muted">${open.length} açık · ${errors.length - open.length} öğrenildi${repeated ? ` · ${repeated} tekrarlayan` : ''}</span></div>
      ${ranked.length ? `<p class="muted ftr-top3">En sık: ${ranked.slice(0, 3).map((k) => `<b>${esc(k)}</b> (${counts[k]})`).join(', ')}</p>` : ''}
      <div class="ftr-bars">${FKAT.map((k) => `
        <button type="button" class="ftr-bar-row ${f.kat === k ? 'on' : ''}" data-tr="f-kat" data-trv="${esc(k)}" ${counts[k] ? '' : 'disabled'}>
          <span class="ftr-bar-l">${esc(k)}</span><span class="ftr-bar"><i style="width:${Math.round((counts[k] / max) * 100)}%"></i></span><b>${counts[k]}</b></button>`).join('')}</div>
    </section>
    <div class="ftr-filter">
      <div class="chips"><button type="button" class="chip ${f.kat ? '' : 'on'}" data-tr="f-kat" data-trv="">Tümü</button>${f.kat ? `<button type="button" class="chip on" data-tr="f-kat" data-trv="">${esc(f.kat)} ✕</button>` : ''}</div>
      <label class="radio"><input type="checkbox" data-tr-chk="fixed" ${f.showFixed ? 'checked' : ''}> Öğrendiklerimi de göster</label>
    </div>
    <div class="ftr-errs">${list.slice(0, f.limit).map((e) => errHtml(e, fixed.has(e.key))).join('') || '<div class="panel empty">Bu kategoride açık hata yok.</div>'}</div>
    ${list.length > f.limit ? `<div class="ftr-actions"><button data-tr="f-more">Daha fazla göster (${list.length - f.limit})</button></div>` : ''}
    ${fehlend.length ? `<section class="panel"><h3>Sık unutulanlar <span class="muted">(eksik kalan anamnez/içerik maddeleri)</span></h3>
      <ul class="ftr-miss">${fehlend.slice(0, 15).map((x) => `<li><span lang="de">${esc(x.text)}</span>${x.n > 1 ? ` <span class="sc bad">${x.n}×</span>` : ''}</li>`).join('')}</ul></section>` : ''}`;
}

function errHtml(e, isFixed) {
  const f = T.feh;
  const meta = `<div class="ftr-err-meta muted"><span class="badge">${esc(e.kat)}</span>${e.typ ? ` <span>${esc(e.typ)}</span>` : ''} · ${esc(e.where)} · ${dateStr(e.at)}${e.n > 1 ? ` · <b>${e.n}×</b>` : ''}</div>`;
  const fixBtn = `<button class="ghost ${isFixed ? '' : 'ftr-learned'}" data-tr="f-fix" data-trv="${e.key}">${isFixed ? '↺ Tekrar aç' : '✓ Öğrendim'}</button>`;
  if (e.note) {
    return `<article class="panel ftr-err ${isFixed ? 'fixed' : ''}">${meta}
      <div class="ftr-note"><b lang="de">${esc(e.name)}</b> <span class="sc ${scoreClass(e.punkte)}">${e.punkte}</span><p>${esc(e.kommentar)}</p></div>
      <div class="ftr-actions">${fixBtn}</div></article>`;
  }
  const open = f.open === e.key;
  const ch = open ? f.check : null;
  return `<article class="panel ftr-err ${isFixed ? 'fixed' : ''}">${meta}
    <div class="ftr-err-l"><span class="ftr-tag">Benim cümlem</span><del lang="de">${esc(e.original)}</del></div>
    ${e.erklaerung ? `<p class="ftr-err-x">${esc(e.erklaerung)}</p>` : ''}
    <div class="ftr-err-l"><span class="ftr-tag ok">Doğrusu</span><ins lang="de">${esc(e.korrigiert)}</ins>${sayBtn(e.korrigiert)}</div>
    ${e.besser ? `<div class="ftr-err-l"><span class="ftr-tag alt">Daha iyi</span><span lang="de">${esc(e.besser)}</span>${sayBtn(e.besser)}${e.warum ? `<small class="muted"> — ${esc(e.warum)}</small>` : ''}</div>` : ''}
    ${open ? `<div class="ftr-prac">
      <p class="muted">Yanlış cümleyi düzelt ve aynı yapıyla yeni, doğru bir cümle kur.</p>
      <div class="ftr-prac-src" lang="de">${esc(e.original)}</div>
      <textarea data-tr-in="feh" rows="3" placeholder="Düzeltilmiş cümle + benzer yeni bir cümle… (Ctrl+Enter: kontrol)" spellcheck="false" data-tr-focus>${esc(f.input)}</textarea>
      ${ch ? `<div class="ftr-ai"><span class="sc ${scoreClass(ch.punkte)}">${ch.punkte}</span> ${esc(ch.feedback)}
        ${ch.fehlend?.length ? `<div class="muted">Eksik: ${ch.fehlend.map(esc).join(' · ')}</div>` : ''}
        ${ch.korrigiert ? `<div class="ftr-fix"><span class="muted">Düzeltilmiş:</span> <span lang="de">${esc(ch.korrigiert)}</span>${sayBtn(ch.korrigiert)}</div>` : ''}</div>` : ''}
      <div class="ftr-actions">
        ${C.sync.user() ? `<button class="primary" data-tr="f-check" ${f.pending ? 'disabled' : ''}>${f.pending ? 'Değerlendiriliyor…' : 'Kontrol et (AI)'}</button>` : '<span class="muted">AI kontrolü için giriş yap.</span>'}
        <button class="ghost" data-tr="f-close">Kapat</button>
      </div></div>` : ''}
    <div class="ftr-actions">${open ? '' : `<button data-tr="f-prac" data-trv="${e.key}">Benzer alıştırma üret</button>`}${fixBtn}</div>
  </article>`;
}

async function fehCheck() {
  const f = T.feh;
  if (f.pending || !f.open) return;
  const e = collectErrors().errors.find((x) => x.key === f.open);
  if (!e) return;
  const answer = (C.main.querySelector('[data-tr-in="feh"]')?.value || '').trim();
  f.input = answer;
  if (words(answer) < 4) { C.toast('Önce düzeltilmiş cümleyi ve yeni bir cümle yaz.', 'info'); return; }
  f.pending = true;
  render();
  const key = f.open;
  try {
    const res = await C.sync.fspAi({ action: 'answer', question: `Korrigiere den Satz und bilde einen ähnlichen Satz richtig: ${e.original}`,
      model: e.korrigiert, answer, kind: 'arzt' }, 60_000);
    if (!res?.check) throw new Error('Değerlendirme alınamadı.');
    if (f.open === key) f.check = res.check;
  } finally {
    f.pending = false;
    if (T.sub === 'fehler') render();
  }
}

function fehClick(act, el) {
  const f = T.feh;
  switch (act) {
    case 'f-kat': f.kat = f.kat === el.dataset.trv ? '' : el.dataset.trv; f.limit = 40; render(); break;
    case 'f-more': f.limit += 40; render(); break;
    case 'f-fix': {
      const s = fixedSet();
      const k = el.dataset.trv;
      if (s.has(k)) s.delete(k); else s.add(k);
      C.prefs.fspFixed = [...s];
      savePrefs();
      if (f.open === k) { f.open = null; f.check = null; f.input = ''; }
      render();
      break;
    }
    case 'f-prac':
      if (f.pending) return;
      f.open = el.dataset.trv; f.input = ''; f.check = null;
      render();
      break;
    case 'f-close': if (!f.pending) { f.open = null; f.check = null; f.input = ''; render(); } break;
    case 'f-check': return fehCheck();
    default: break;
  }
  return undefined;
}

/* ------------------------------------------------------------------ olaylar */

function onClick(e) {
  const el = e.target.closest('[data-tr]');
  if (!el || !C.main.contains(el) || !el.closest('#tr-root')) return;
  const act = el.dataset.tr;
  if (act === 'say') { C.speak(el.dataset.trv, 'de'); return; }
  C.guard(async () => {
    if (act.startsWith('v-')) await vocClick(act, el);
    else if (act.startsWith('g-')) await gramClick(act, el);
    else if (act.startsWith('f-')) await fehClick(act, el);
  });
}

function onKey(e) {
  const el = e.target.closest?.('[data-tr-in]');
  if (!el || !el.closest('#tr-root') || e.key !== 'Enter' || e.isComposing) return;
  const isArea = el.tagName === 'TEXTAREA';
  if (isArea && !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  const kind = el.dataset.trIn;
  const btn = {
    voc: '[data-tr="v-check"]', satz: C.sync.user() ? '[data-tr="v-ai"]' : '[data-tr="v-show"]',
    gram: '[data-tr="g-check"]', feh: '[data-tr="f-check"]',
  }[kind];
  root()?.querySelector(btn)?.click();
}

function onChange(e) {
  const el = e.target.closest?.('[data-tr-chk]');
  if (!el || !el.closest('#tr-root')) return;
  if (el.dataset.trChk === 'fixed') { T.feh.showFixed = el.checked; render(); }
}

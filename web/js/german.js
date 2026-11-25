import { ic } from './icons.js';
// Almanca gramer bölümü: A1–C2 seviyeleri, her seviyede konular (anlatım + alıştırmalar) ve seviye karışık testi.
// İçerik web/content/german/<seviye>.json dosyalarından gelir (Türkçe özgün anlatım; kaynaklara bağlantı verilir).
// İlerleme yalnızca bu cihazda (localStorage) tutulur; eşitlenmez.
// app.js bu modüle ortak yardımcıları initGerman(ctx) ile verir.

let C = null;
export const LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const LEVEL_NAME = { A1: 'Başlangıç', A2: 'Temel', B1: 'Orta', B2: 'Orta üstü', C1: 'İleri', C2: 'Ustalık' };
const PKEY = 'kelime.german';
const MIX_N = 12;

const G = {
  level: 'A1', data: {}, topicId: null, tab: 'learn',
  ex: null, // { list, i, answered, right, picked, order: [], source: 'topic'|'mix' }
  prog: load(),
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// İçerik depodan gelir (kullanıcı girdisi değil): sadece sınırlı biçim etiketlerine izin verilir
const rich = (s) => esc(s).replace(/&lt;(\/?)(b|i|u|em|strong|mark|br|small|sup)&gt;/g, '<$1$2>');
const shuffle = (a) => { const r = [...a]; for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; } return r; };

function load() {
  try { return { done: {}, best: {}, level: 'A1', ...JSON.parse(localStorage.getItem(PKEY) || '{}') }; } catch { return { done: {}, best: {}, level: 'A1' }; }
}
function save() {
  try { localStorage.setItem(PKEY, JSON.stringify(G.prog)); } catch { /* gizli pencere: ilerleme tutulmaz */ }
}

/** Cevap karşılaştırması: büyük/küçük harf, boşluk ve noktalama farkı önemsiz; ae/oe/ue/ss yazımı da kabul. */
export function norm(s) {
  return String(s ?? '').toLowerCase().normalize('NFC')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[.,!?;:„“”"'’()–-]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ------------------------------------------------------------------ başlatma */

export function initGerman(ctx) {
  C = ctx;
  G.level = LEVELS.includes(G.prog.level) ? G.prog.level : 'A1';
  C.main.addEventListener('click', onClick);
}

const inGerman = () => String(C.state.view).startsWith('german');

function setView(view, title) {
  C.leaveStudy();
  C.state.view = view;
  document.body.classList.remove('menu-open');
  C.renderSidebar();
  C.setTitle(title);
}

async function levelData(lv) {
  if (G.data[lv]) return G.data[lv];
  const res = await fetch(`content/german/${lv.toLowerCase()}.json`);
  if (!res.ok) throw new Error(String(res.status));
  G.data[lv] = await res.json();
  return G.data[lv];
}

const head = (title, sub, back, extra = '') => `
  <header class="deck-head">
    <button class="icon-btn head-btn" data-de="${back}" title="Geri (Esc)" aria-label="Geri">${back === 'home' ? C.ICON.home : C.ICON.back.replace(/width="16" height="16"[^>]*/, '')}</button>
    <div class="deck-title"><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
    ${extra}
  </header>`;

/* ------------------------------------------------------------------ seviye + konu listesi */

export async function showGerman(level) {
  if (level && LEVELS.includes(level)) { G.level = level; G.prog.level = level; save(); }
  G.ex = null;
  setView('german', 'Almanca');
  C.main.innerHTML = '<div class="page"><div class="muted">Yükleniyor…</div></div>';
  let d;
  try { d = await levelData(G.level); } catch {
    C.main.innerHTML = `<div class="page">${head('Almanca gramer', '', 'home')}<div class="panel empty">İçerik yüklenemedi. İnternet bağlantını kontrol edip tekrar dene.</div></div>`;
    return;
  }
  if (C.state.view !== 'german') return;
  const topics = d.topics || [];
  const doneN = topics.filter((t) => G.prog.done[t.id]).length;
  const pct = topics.length ? Math.round((doneN / topics.length) * 100) : 0;
  C.main.innerHTML = `
    <div class="page de-page">
      ${head('Almanca gramer', 'A1–C2 · konu anlatımı ve alıştırmalar', 'home')}
      <div class="de-levels" role="tablist" aria-label="Seviye">
        ${LEVELS.map((lv) => `<button role="tab" class="de-lv ${lv === G.level ? 'on' : ''}" aria-selected="${lv === G.level}" data-de="level" data-lv="${lv}">
          <b>${lv}</b><small>${LEVEL_NAME[lv]}</small></button>`).join('')}
      </div>
      <section class="panel de-intro">
        <div class="de-intro-top">
          <div><h2>${esc(d.level)} · ${esc(d.title || LEVEL_NAME[d.level])}</h2><p class="muted">${rich(d.intro || '')}</p></div>
          <div class="de-ring" style="--p:${pct}" title="Tamamlanan konular"><b>${doneN}/${topics.length}</b></div>
        </div>
        <div class="de-intro-actions">
          <button class="primary" data-de="mix" ${topics.length ? '' : 'disabled'}>${ic('play')} ${esc(d.level)} karışık test</button>
          ${G.prog.best[`mix-${d.level}`] != null ? `<span class="muted">En iyi: %${G.prog.best[`mix-${d.level}`]}</span>` : ''}
        </div>
      </section>
      <div class="de-topics">
        ${topics.map((t, i) => {
          const best = G.prog.best[t.id];
          return `<button class="de-topic ${G.prog.done[t.id] ? 'done' : ''}" data-de="topic" data-id="${esc(t.id)}">
            <span class="de-num">${G.prog.done[t.id] ? ic('check') : i + 1}</span>
            <span class="de-tt"><b>${esc(t.title)}</b><small class="muted">${esc(t.de || '')}</small>
              <span class="de-sum">${rich(t.summary || '')}</span></span>
            <span class="de-meta"><span class="badge">${(t.exercises || []).length} alıştırma</span>${best != null ? `<span class="de-best">%${best}</span>` : ''}</span>
          </button>`;
        }).join('')}
      </div>
      ${d.sources?.length ? `<p class="muted de-src">Kaynaklar: ${d.sources.map((s) => `<a href="${esc(s.u)}" target="_blank" rel="noopener">${esc(s.n)}</a>`).join(' · ')}</p>` : ''}
    </div>`;
}

/* ------------------------------------------------------------------ konu sayfası */

function topicById(id) {
  return (G.data[G.level]?.topics || []).find((t) => t.id === id);
}

function say(text) {
  return `<button type="button" class="icon-btn small de-say" data-de="say" data-text="${esc(text)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button>`;
}

function blockHtml(b) {
  const h = b.h ? `<h3>${rich(b.h)}</h3>` : '';
  switch (b.type) {
    case 'table':
      return `<section class="de-block">${h}<div class="de-tablewrap"><table class="de-table">
        ${b.head ? `<thead><tr>${b.head.map((c) => `<th>${rich(c)}</th>`).join('')}</tr></thead>` : ''}
        <tbody>${b.rows.map((r) => `<tr>${r.map((c, i) => (i === 0 && b.head ? `<th scope="row">${rich(c)}</th>` : `<td>${rich(c)}</td>`)).join('')}</tr>`).join('')}</tbody>
      </table></div>${b.note ? `<p class="muted de-note">${rich(b.note)}</p>` : ''}</section>`;
    case 'examples':
      return `<section class="de-block">${h}<ul class="de-ex-list">${b.items.map(([de, tr]) => `
        <li>${say(de.replace(/<[^>]+>/g, ''))}<span><span class="de-de" lang="de">${rich(de)}</span><small class="muted">${rich(tr || '')}</small></span></li>`).join('')}</ul></section>`;
    case 'tip':
      return `<aside class="de-callout tip">${ic('bulb')}<div>${b.h ? `<b>${rich(b.h)}</b>` : ''}<p>${rich(b.text)}</p></div></aside>`;
    case 'tr':
      return `<aside class="de-callout tr"><span class="de-flag">TR</span><div><b>${rich(b.h || 'Türkçeyle karşılaştır')}</b><p>${rich(b.text)}</p></div></aside>`;
    case 'list':
      return `<section class="de-block">${h}<ul class="de-ul">${b.items.map((x) => `<li>${rich(x)}</li>`).join('')}</ul></section>`;
    default:
      return `<section class="de-block">${h}${String(b.text || '').split('\n\n').map((p) => `<p>${rich(p)}</p>`).join('')}</section>`;
  }
}

export async function showGermanTopic(id, tab = 'learn') {
  try { await levelData(G.level); } catch { showGerman(); return; }
  const t = topicById(id);
  if (!t) { showGerman(); return; }
  G.topicId = id;
  G.tab = tab;
  if (tab !== 'practice') G.ex = null;
  setView('german-topic', t.title);
  const exN = (t.exercises || []).length;
  C.main.innerHTML = `
    <div class="page de-page de-lesson">
      ${head(t.title, `${G.level} · ${t.de || ''}`, 'back', `<button class="icon-btn de-done-btn ${G.prog.done[t.id] ? 'on' : ''}" data-de="toggle-done" title="Tamamlandı olarak işaretle" aria-pressed="${!!G.prog.done[t.id]}">${ic('check')}</button>`)}
      <div class="de-tabs" role="tablist">
        <button role="tab" class="${tab === 'learn' ? 'on' : ''}" aria-selected="${tab === 'learn'}" data-de="tab" data-tab="learn">${ic('book')} Konu anlatımı</button>
        <button role="tab" class="${tab === 'practice' ? 'on' : ''}" aria-selected="${tab === 'practice'}" data-de="tab" data-tab="practice">${ic('pen')} Alıştırmalar <span class="badge">${exN}</span></button>
      </div>
      <div id="de-body">${tab === 'practice' ? practiceHtml(t) : learnHtml(t)}</div>
    </div>`;
  C.main.scrollTop = 0;
  window.scrollTo?.(0, 0);
}

function learnHtml(t) {
  const blocks = (t.blocks || []).map(blockHtml).join('');
  const mistakes = t.mistakes?.length ? `
    <section class="de-block"><h3>Sık yapılan hatalar</h3>
      <div class="de-mistakes">${t.mistakes.map(([bad, good, why]) => `
        <div class="de-mk"><span class="de-bad" lang="de">${rich(bad)}</span><span class="de-good" lang="de">${rich(good)}</span>${why ? `<small class="muted">${rich(why)}</small>` : ''}</div>`).join('')}
      </div></section>` : '';
  const links = t.links?.length ? `
    <section class="de-block de-links"><h3>Kaynaklar ve ek alıştırmalar</h3>
      <ul>${t.links.map((l) => `<li><a href="${esc(l.u)}" target="_blank" rel="noopener">${esc(l.n)}</a>${l.d ? ` <small class="muted">· ${esc(l.d)}</small>` : ''}</li>`).join('')}</ul></section>` : '';
  return `<article class="de-article">
    ${t.summary ? `<p class="de-lead">${rich(t.summary)}</p>` : ''}
    ${blocks}${mistakes}
    <div class="de-next"><button class="primary" data-de="tab" data-tab="practice">${ic('pen')} Alıştırmalara geç</button></div>
    ${links}
  </article>`;
}

/* ------------------------------------------------------------------ alıştırmalar */

function startEx(list, source, key) {
  G.ex = { list: shuffle(list), i: 0, answered: false, right: 0, picked: null, order: [], source, key, wrong: [] };
}

function practiceHtml(t) {
  if (!G.ex || G.ex.key !== t.id) startEx(t.exercises || [], 'topic', t.id);
  return exHtml();
}

export async function startGermanMix() {
  let d;
  try { d = await levelData(G.level); } catch { return; }
  const pool = (d.topics || []).flatMap((t) => (t.exercises || []).map((e) => ({ ...e, topic: t.title })));
  G.topicId = null;
  startEx(shuffle(pool).slice(0, MIX_N), 'mix', `mix-${G.level}`);
  setView('german-mix', `${G.level} karışık test`);
  renderMix();
}

function renderMix() {
  C.main.innerHTML = `<div class="page de-page de-lesson">
    ${head(`${G.level} karışık test`, `${G.ex.list.length} soru · tüm konulardan`, 'back')}
    <div id="de-body">${exHtml()}</div></div>`;
}

function renderEx() {
  const body = C.main.querySelector('#de-body');
  if (body) body.innerHTML = exHtml();
  body?.querySelector('.de-gap input:not([disabled])')?.focus();
}

function exHtml() {
  const X = G.ex;
  if (!X.list.length) return '<div class="panel empty">Bu konu için henüz alıştırma yok.</div>';
  if (X.i >= X.list.length) return resultHtml();
  const e = X.list[X.i];
  const pct = Math.round((X.i / X.list.length) * 100);
  const kind = { choice: 'Doğru seçeneği işaretle', gap: 'Boşluğu doldur', order: 'Kelimeleri doğru sıraya koy' }[e.t] || '';
  let bodyHtml = '';
  if (e.t === 'choice') {
    bodyHtml = `<p class="de-q" lang="de">${qHtml(e.q)}</p>
      <div class="de-opts">${e.o.map((o, k) => {
        let cls = '';
        if (X.answered) cls = o === e.a ? 'right' : (o === X.picked ? 'wrong' : 'dim');
        return `<button class="de-opt ${cls}" data-de="pick" data-k="${k}" ${X.answered ? 'disabled' : ''} lang="de"><span class="de-key">${k + 1}</span>${esc(o)}</button>`;
      }).join('')}</div>`;
  } else if (e.t === 'gap') {
    const ok = X.answered && X.picked === true;
    bodyHtml = `<p class="de-q" lang="de">${qHtml(e.q)}</p>
      <form class="de-gap" data-de-form="gap" autocomplete="off">
        <input type="text" lang="de" spellcheck="false" autocapitalize="off" placeholder="Cevabını yaz…" value="${esc(X.typed || '')}" ${X.answered ? `disabled class="${ok ? 'right' : 'wrong'}"` : ''} aria-label="Cevap">
        ${X.answered ? '' : '<button class="primary" type="submit">Kontrol et</button>'}
      </form>
      ${e.h && !X.answered ? `<p class="muted de-hint">İpucu: ${rich(e.h)}</p>` : ''}
      <div class="de-umlaut">${['ä', 'ö', 'ü', 'ß', 'Ä', 'Ö', 'Ü'].map((u) => `<button type="button" data-de="uml" data-u="${u}" ${X.answered ? 'disabled' : ''}>${u}</button>`).join('')}</div>`;
  } else if (e.t === 'order') {
    if (!X.pool) X.pool = shuffle(e.w.map((w, k) => ({ w, k })));
    const used = new Set(X.order);
    bodyHtml = `${e.q ? `<p class="muted">${rich(e.q)}</p>` : ''}
      <div class="de-built ${X.answered ? (X.picked ? 'right' : 'wrong') : ''}" lang="de">${X.order.length ? X.order.map((k, n) => `<button class="de-chip on" data-de="unchip" data-n="${n}" ${X.answered ? 'disabled' : ''}>${esc(e.w[k])}</button>`).join('') : '<span class="muted">Aşağıdaki kelimelere dokun…</span>'}</div>
      <div class="de-pool" lang="de">${X.pool.map(({ w, k }) => `<button class="de-chip" data-de="chip" data-k="${k}" ${used.has(k) || X.answered ? 'disabled' : ''}>${esc(w)}</button>`).join('')}</div>
      ${X.answered ? '' : `<div class="de-row"><button data-de="order-clear" ${X.order.length ? '' : 'disabled'}>Temizle</button><button class="primary" data-de="order-check" ${X.order.length === e.w.length ? '' : 'disabled'}>Kontrol et</button></div>`}`;
  }
  let fb = '';
  if (X.answered) {
    const ok = e.t === 'choice' ? X.picked === e.a : X.picked === true;
    const sol = e.t === 'gap' ? fillQ(e.q, e.a[0]) : e.t === 'order' ? esc(orderAnswer(e)) : '';
    fb = `<div class="de-fb ${ok ? 'ok' : 'no'}" role="status">
      <b>${ok ? 'Doğru!' : 'Yanlış'}</b>
      ${!ok && sol ? `<p lang="de">Doğrusu: <span class="de-de">${sol}</span></p>` : ''}
      ${e.x ? `<p>${rich(e.x)}</p>` : ''}
      <button class="primary" data-de="next">${X.i + 1 < X.list.length ? 'Sonraki soru' : 'Sonucu gör'} →</button>
    </div>`;
  }
  return `<section class="panel de-ex">
    <div class="de-ex-top"><span class="muted">Soru ${X.i + 1} / ${X.list.length}</span><span class="de-kind">${kind}</span>${e.topic ? `<span class="badge">${esc(e.topic)}</span>` : ''}<span class="de-score">${X.right} doğru</span></div>
    <div class="by-progress de-prog"><span style="width:${pct}%"></span></div>
    ${bodyHtml}${fb}
  </section>`;
}

const orderAnswer = (e) => e.a;
// "___" boşluğu vurgulu gösterilir
const qHtml = (q) => rich(q).replace(/_{2,}/g, '<span class="de-blank">&nbsp;</span>');
const fillQ = (q, a) => rich(q).replace(/_{2,}/, `<mark>${esc(a)}</mark>`);

function resultHtml() {
  const X = G.ex;
  const pct = Math.round((X.right / X.list.length) * 100);
  const prev = G.prog.best[X.key];
  if (prev == null || pct > prev) G.prog.best[X.key] = pct;
  if (X.source === 'topic' && pct >= 80) G.prog.done[X.key] = true;
  save();
  const msg = pct >= 90 ? 'Harika! Bu konu oturmuş.' : pct >= 70 ? 'İyi gidiyor. Yanlışlara bir göz at.' : pct >= 50 ? 'Fena değil; anlatımı tekrar okuyup yeniden dene.' : 'Anlatıma geri dönüp tabloları gözden geçir, sonra tekrar dene.';
  return `<section class="panel de-result">
    <div class="de-ring big" style="--p:${pct}"><b>%${pct}</b></div>
    <h2>${X.right} / ${X.list.length} doğru</h2>
    <p class="muted">${msg}${X.source === 'topic' && pct >= 80 ? ' Konu tamamlandı olarak işaretlendi.' : ''}</p>
    ${X.wrong.length ? `<div class="de-wrong"><h3>Yanlış yaptıkların</h3><ul>${X.wrong.map((e) => `<li lang="de">${e.t === 'gap' ? fillQ(e.q, e.a[0]) : e.t === 'choice' ? fillQ(e.q, e.a) : esc(e.a)}${e.x ? `<small class="muted">${rich(e.x)}</small>` : ''}</li>`).join('')}</ul></div>` : ''}
    <div class="de-row center">
      <button class="primary" data-de="retry">${ic('undo')} Tekrar çöz</button>
      ${X.source === 'topic' ? '<button data-de="tab" data-tab="learn">Anlatıma dön</button>' : ''}
      <button data-de="back">Konu listesi</button>
    </div>
  </section>`;
}

function answer(ok, extra = {}) {
  const X = G.ex;
  Object.assign(X, extra, { answered: true });
  if (ok) X.right += 1; else X.wrong.push(X.list[X.i]);
  renderEx();
  C.main.querySelector('.de-fb [data-de="next"]')?.focus({ preventScroll: true });
}

function nextQ() {
  const X = G.ex;
  X.i += 1;
  Object.assign(X, { answered: false, picked: null, order: [], pool: null, typed: '' });
  renderEx();
}

/* ------------------------------------------------------------------ olaylar */

async function onClick(e) {
  if (!inGerman()) return;
  const el = e.target.closest('[data-de]');
  if (!el) return;
  const act = el.dataset.de;
  const X = G.ex;
  const cur = X && X.i < X.list.length ? X.list[X.i] : null;
  switch (act) {
    case 'home': C.showHome(); break;
    case 'back': germanBack(); break;
    case 'level': showGerman(el.dataset.lv); break;
    case 'topic': showGermanTopic(el.dataset.id); break;
    case 'tab': {
      if (C.state.view === 'german-mix') { showGerman(); break; }
      if (el.dataset.tab === 'practice' && G.ex?.i >= G.ex?.list.length) G.ex = null;
      showGermanTopic(G.topicId, el.dataset.tab);
      break;
    }
    case 'mix': startGermanMix(); break;
    case 'say': C.speak(el.dataset.text, 'de'); break;
    case 'toggle-done': {
      const id = G.topicId;
      if (G.prog.done[id]) delete G.prog.done[id]; else G.prog.done[id] = true;
      save();
      el.classList.toggle('on', !!G.prog.done[id]);
      el.setAttribute('aria-pressed', String(!!G.prog.done[id]));
      C.toast(G.prog.done[id] ? 'Konu tamamlandı olarak işaretlendi.' : 'İşaret kaldırıldı.', 'success');
      break;
    }
    case 'pick': if (cur && !X.answered) { const o = cur.o[+el.dataset.k]; answer(o === cur.a, { picked: o }); } break;
    case 'uml': {
      const inp = C.main.querySelector('.de-gap input');
      if (!inp || inp.disabled) break;
      const s = inp.selectionStart ?? inp.value.length;
      inp.value = inp.value.slice(0, s) + el.dataset.u + inp.value.slice(inp.selectionEnd ?? s);
      inp.focus();
      inp.setSelectionRange(s + 1, s + 1);
      break;
    }
    case 'chip': if (cur && !X.answered) { X.order.push(+el.dataset.k); renderEx(); } break;
    case 'unchip': if (cur && !X.answered) { X.order.splice(+el.dataset.n, 1); renderEx(); } break;
    case 'order-clear': if (cur) { X.order = []; renderEx(); } break;
    case 'order-check': if (cur && !X.answered) checkOrder(cur); break;
    case 'next': nextQ(); break;
    case 'retry': startEx(X.list, X.source, X.key); renderEx(); break;
    default: break;
  }
}

function checkOrder(e) {
  const built = norm(G.ex.order.map((k) => e.w[k]).join(' '));
  const ok = [e.a, ...(e.alt || [])].some((a) => norm(a) === built);
  answer(ok, { picked: ok });
}

function checkGap(form) {
  const X = G.ex;
  const e = X.list[X.i];
  const val = form.querySelector('input').value;
  if (!val.trim()) return;
  const ok = e.a.some((a) => norm(a) === norm(val));
  answer(ok, { picked: ok, typed: val });
}

document.addEventListener('submit', (ev) => {
  const form = ev.target.closest?.('[data-de-form="gap"]');
  if (!form || !C || !inGerman()) return;
  ev.preventDefault();
  if (G.ex && !G.ex.answered) checkGap(form);
});

/** Seçim yapıldıktan sonra Enter → sonraki soru (app.js klavye kısayolundan çağrılır). */
export function germanKey(e) {
  if (!inGerman() || !G.ex) return false;
  const X = G.ex;
  if (e.key === 'Enter' && X.answered && X.i < X.list.length) { e.preventDefault(); nextQ(); return true; }
  const cur = X.list[X.i];
  if (/^[1-9]$/.test(e.key) && !X.answered && cur?.t === 'choice' && cur.o[+e.key - 1] != null && document.activeElement?.tagName !== 'INPUT') {
    answer(cur.o[+e.key - 1] === cur.a, { picked: cur.o[+e.key - 1] }); return true;
  }
  return false;
}

/** Esc / geri: işlenirse true. */
export function germanBack() {
  const v = C?.state.view;
  if (v === 'german-topic' || v === 'german-mix') { showGerman(); return true; }
  if (v === 'german') { C.showHome(); return true; }
  return false;
}

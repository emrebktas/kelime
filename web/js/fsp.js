import { initKurs, kursHtml, mountKurs, getStudy } from './kurs.js';
import { initTrain, trainHtml, mountTrain } from './fsp-train.js';
import { initLearn, learnHtml, mountLearn, learnBack } from './fsp-learn.js';
// Fachsprachprüfung (FSP) Zahnmedizin: hasta görüşmesi (Teil 1), Arztbrief (Teil 2), Arzt-Arzt-Gespräch (Teil 3),
// değerlendirme, Fachbegriffe ve rehber. Yapay zekâ sunucudaki fsp-ai fonksiyonundan (Gemini) gelir.
// app.js bu modüle ortak yardımcıları initFsp(ctx) ile verir.

let C = null; // app.js'ten gelen yardımcılar
let content = null; // { cases, guide }
const ui = { tab: 'panel', subs: { train: 'anamnese', ref: 'nachschlagen' }, fach: '', termQ: '', termKat: '', attemptId: null, pending: false, tick: null, rec: null, saveT: null,
  bySec: 'fragen', byTopic: '', byQ: '', byTr: true, practice: null };

const PARTS = {
  1: { label: 'Teil 1 · Patientengespräch', short: 'Gespräch', minutes: 20, icon: 'talk' },
  2: { label: 'Teil 2 · Arztbrief', short: 'Arztbrief', minutes: 20, icon: 'doc' },
  3: { label: 'Teil 3 · Arzt-Arzt-Gespräch', short: 'Oberarzt', minutes: 20, icon: 'steth' },
};
const BRIEF = [
  ['aktuell', 'Aktuelle Anamnese', 'Anlass der Vorstellung, Beschwerden (Lokalisation, Beginn, Charakter, Intensität, Auslöser…), bisherige Maßnahmen'],
  ['allgemein', 'Allgemeinanamnese', 'Vorerkrankungen, Medikamente mit Dosis, Allergien, Noxen, Sozial- und Familienanamnese'],
  ['befund', 'Röntgenbefund / Befund', 'Was zeigt das Röntgenbild, klinischer Befund'],
  ['therapie', 'Therapieplan', 'Verdachtsdiagnose, Differentialdiagnosen, weitere Diagnostik, geplante Therapie, Aufklärung'],
];
const FACH = ['Endodontie', 'Parodontologie', 'Oralchirurgie', 'Prothetik', 'Funktionsdiagnostik', 'Kinderzahnheilkunde', 'Implantologie', 'Kieferorthopädie', 'Zahnerhaltung'];
const DECK_NAME = 'FSP Zahnmedizin';
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

// Zorluk seviyeleri (Teil 1 hasta ve Teil 3 Oberarzt). Anahtarlar fsp-ai'deki enum ile aynı olmalı.
const LEVELS = [
  ['anfaenger', 'Anfänger', 'Yavaş ve kısa cümleler; hasta terimleri sorar, küçük ipuçları verir'],
  ['mittel', 'Mittelstufe', 'Standart: hasta yalnızca sorulana cevap verir'],
  ['fortgeschritten', 'Fortgeschritten', 'Doğal konuşma dili, dolaylı cevaplar; hasta araya kendi sorularını sokar'],
  ['pruefung', 'Prüfungssimulation', 'Gerçek sınav: ipucu yok, endişeli/zorlayıcı hasta, eleştirel Oberarzt'],
];
const levelOf = (v) => (LEVELS.some(([k]) => k === v) ? v : 'mittel');
const levelLabel = (v) => LEVELS.find(([k]) => k === levelOf(v))[1];

// Tam sınav simülasyonu: aşamalar, süreler (dakika) ve bölüm ağırlıkları
const EXAM_PHASES = [['prep', 'Vorbereitung'], ['t1', 'Teil 1'], ['t2', 'Teil 2'], ['t3', 'Teil 3'], ['eval', 'Bewertung'], ['done', 'Ergebnis']];
const EXAM_MIN = { prep: 15, t1: 20, t2: 20, t3: 20 };
const EXAM_W = { 1: 0.35, 2: 0.3, 3: 0.35 };
const phaseLabel = (ph) => (EXAM_PHASES.find(([k]) => k === ph) || ['', ''])[1];
const isExam = (a) => a?.data?.mode === 'exam';
const extCases = new Map(); // başka modüllerden (startCaseFromObject) gelen vakalar

let training = null;
async function loadTraining() {
  if (training) return training;
  try {
    const r = await fetch('content/fsp-training.json');
    if (r.ok) training = await r.json();
  } catch { /* çevrimdışı */ }
  return training;
}

// Sekmeler: üst düzey + alt sekmeli gruplar (Antrenman, Başvuru)
const SUBS = {
  train: [['anamnese', 'Anamnez & Aufklärung'], ['vokabel', 'Kelime'], ['grammatik', 'Gramer'], ['fehler', 'Hata defteri']],
  ref: [['nachschlagen', 'Başvuru'], ['terms', 'Fachbegriffe'], ['guide', 'Rehber']],
};

/** Diğer modüllerden sekme geçişi: goTab('learn','krankheiten'), goTab('bayern'), goTab('deck', id)… */
function goTab(tab, sub) {
  if (tab === 'deck') { if (sub) C.openDeck?.(sub); return; }
  if (tab === 'learn') {
    if (sub === 'anamnese') { ui.tab = 'train'; ui.subs.train = 'anamnese'; }
    else if (sub === 'nachschlagen') { ui.tab = 'ref'; ui.subs.ref = 'nachschlagen'; }
    else ui.tab = sub || 'panel';
  } else if (SUBS[tab]) { ui.tab = tab; if (sub) ui.subs[tab] = sub; }
  else ui.tab = tab;
  if (C.state.view === 'fsp') renderHub(); else showFsp();
}

export function initFsp(ctx) {
  C = ctx;
  Object.assign(ctx, { getStudy, loadTraining, startCase: (c, part) => startCaseFromObject(c, part), goTab });
  initKurs(ctx);
  initTrain(ctx);
  initLearn(ctx);
  // Sınav ekranı stilleri ayrı dosyada (index.html'e dokunmadan yüklenir)
  if (!document.querySelector('link[data-fsp-exam]')) {
    const l = document.createElement('link');
    l.rel = 'stylesheet';
    l.href = 'fsp-exam.css';
    l.dataset.fspExam = '';
    document.head.appendChild(l);
  }
  C.main.addEventListener('click', onClick);
  C.main.addEventListener('keydown', onKey);
  C.main.addEventListener('input', onInput);
  C.main.addEventListener('change', onChange);
}

async function load() {
  if (content) return content;
  const get = (f) => fetch(f).then((r) => { if (!r.ok) throw new Error(); return r.json(); });
  const [cases, guide, bayern] = await Promise.all([get('content/fsp-cases.json'), get('content/fsp-guide.json'),
    get('content/fsp-bayern.json').catch(() => null)]);
  content = { cases: [...(bayern?.cases || []), ...(cases.cases || [])], guide, bayern };
  return content;
}

const { esc } = { esc: (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) };
const now = () => Math.floor(Date.now() / 1000);
const fmtClock = (sec) => `${sec < 0 ? '+' : ''}${Math.floor(Math.abs(sec) / 60)}:${String(Math.abs(sec) % 60).padStart(2, '0')}`;
const dateStr = (t) => new Date(t * 1000).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const scoreClass = (n) => (n >= 70 ? 'good' : n >= 60 ? 'mid' : 'bad');

/* ------------------------------------------------------------------ veri */

function allCases() {
  const own = C.store.listFsp('case').map((r) => ({ ...r.data, id: r.id, custom: true }));
  return [...own, ...(content?.cases || [])];
}
// Dış modüllerden gelen ya da artık listede olmayan vakalar için deneme kaydındaki kopyaya düşer
const caseById = (id) => allCases().find((c) => c.id === id) || extCases.get(id)
  || attempts().find((a) => a.data.caseId === id && a.data.case)?.data.case || null;
const attempts = () => C.store.listFsp('attempt');
// Tek bölüm denemeleri (tam sınavlar hariç)
const attemptsOf = (caseId, part) => attempts().filter((a) => !isExam(a) && a.data.caseId === caseId && (!part || a.data.part === part));
function bestScore(caseId, part) {
  const s = attemptsOf(caseId, part).map((a) => a.data.report?.gesamt).filter((n) => typeof n === 'number');
  return s.length ? Math.max(...s) : null;
}
const current = () => (ui.attemptId ? C.store.getFsp(ui.attemptId) : null);
function saveAttempt(data) { C.store.updateFsp(ui.attemptId, data); }

/* ------------------------------------------------------------------ ana sayfa (sekmeler) */

export async function showFsp(tab) {
  C.leaveStudy();
  stopRun();
  if (tab) ui.tab = tab;
  C.state.view = 'fsp';
  document.body.classList.remove('menu-open');
  C.renderSidebar();
  C.setTitle('FSP Zahnmedizin');
  C.main.innerHTML = '<div class="page"><div class="muted">Yükleniyor…</div></div>';
  try { await load(); } catch {
    C.main.innerHTML = '<div class="page"><div class="panel empty">FSP içerikleri yüklenemedi.</div></div>';
    return;
  }
  if (C.state.view !== 'fsp') return;
  renderHub();
}

function renderHub() {
  const tabs = [['panel', 'compass', 'Panel'], ['cases', 'tooth', 'Vakalar'], ...(content.bayern ? [['bayern', 'pin', 'Bayern']] : []),
    ['krankheiten', 'steth', 'Krankheitsbilder'], ['train', 'talk', 'Antrenman'], ['kurs', 'doc', 'Kurs'], ['ref', 'book', 'Başvuru'],
    ['history', 'chart', 'Geçmiş']];
  if (!tabs.some(([k]) => k === ui.tab)) ui.tab = 'panel';
  const sub = SUBS[ui.tab] ? ui.subs[ui.tab] : null;
  const body = {
    panel: () => learnHtml('panel'), krankheiten: () => learnHtml('krankheiten'), cases: casesHtml, bayern: bayernHtml,
    kurs: kursHtml, history: historyHtml,
    train: () => (sub === 'anamnese' ? learnHtml('anamnese') : trainHtml(sub)),
    ref: () => (sub === 'nachschlagen' ? learnHtml('nachschlagen') : sub === 'terms' ? termsHtml() : guideHtml()),
  }[ui.tab];
  C.main.innerHTML = `
    <div class="page fsp-page">
      <header class="deck-head">
        <button class="icon-btn head-btn" data-act="home" title="Ana sayfaya dön (Esc)" aria-label="Ana sayfaya dön">${C.ICON.home}</button>
        <div class="deck-title">
          <h1>FSP Zahnmedizin</h1>
          <div class="sub">Fachsprachprüfung · Hasta görüşmesi, Arztbrief, Arzt-Arzt-Gespräch</div>
        </div>
        ${ui.tab === 'cases' || ui.tab === 'bayern' ? '<button data-f="exam-new" title="15 dk hazırlık + Teil 1, 2, 3 (3 × 20 dk)">⏱ Tam sınav</button>' : ''}
        ${ui.tab === 'cases' ? '<button class="primary" data-f="new-case">✦ Yeni vaka (AI)</button>' : ''}
      </header>
      <div class="seg tabs fsp-tabs" role="tablist">${tabs.map(([k, ic, l]) => `<button type="button" role="tab" data-f="tab" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${C.ICON[ic]}${l}</button>`).join('')}</div>
      ${sub ? `<div class="chips fsp-subtabs">${SUBS[ui.tab].map(([k, l]) => `<button type="button" class="chip ${sub === k ? 'on' : ''}" data-f="sub" data-sub="${k}">${l}</button>`).join('')}</div>` : ''}
      <div id="fsp-body">${body()}</div>
    </div>`;
  if (ui.tab === 'kurs') { C.guard(mountKurs); return; }
  if (ui.tab === 'panel' || ui.tab === 'krankheiten') { C.guard(() => mountLearn(ui.tab)); return; }
  if (ui.tab === 'train') { C.guard(() => (sub === 'anamnese' ? mountLearn('anamnese') : mountTrain(sub))); return; }
  if (ui.tab === 'ref' && sub === 'nachschlagen') { C.guard(() => mountLearn('nachschlagen')); return; }
  if (!C.sync.user()) {
    C.$('#fsp-body').insertAdjacentHTML('afterbegin', '<div class="panel fsp-note">Simülasyon ve değerlendirme yapay zekâyla çalışır; kullanmak için <button class="linkish" data-act="account">giriş yap</button>. Fachbegriffe ve rehber girişsiz de açık.</div>');
  }
}

function casesHtml() {
  const list = allCases().filter((c) => !ui.fach || (ui.fach === 'Bayern' ? c.bundesland === 'Bayern' : c.fachgebiet === ui.fach));
  const fachs = [...new Set(allCases().map((c) => c.fachgebiet))];
  return `
    <div class="chips">${['', ...(content.bayern ? ['Bayern'] : []), ...fachs].map((f) => `<button type="button" class="chip ${ui.fach === f ? 'on' : ''} ${f === 'Bayern' ? 'chip-by' : ''}" data-f="fach" data-fach="${esc(f)}">${f ? esc(f) : 'Tümü'}</button>`).join('')}</div>
    ${levelBarHtml()}
    <div class="fsp-grid">${list.map(caseCardHtml).join('') || '<div class="panel empty">Bu alanda vaka yok.</div>'}</div>`;
}

function caseCardHtml(c) {
      const p = c.patient || {};
      const tried = attemptsOf(c.id).length > 0;
      return `<article class="panel fsp-case">
        <div class="fc-top"><span class="badge">${esc(c.fachgebiet)}</span>${c.custom ? '<span class="fc-own">✦ senin vakan</span>' : ''}${c.bundesland ? `<span class="fc-by" title="München raporlarında ${c.freq} kez">${C.ICON.pin}${esc(c.bundesland)} · ${c.freq}×</span>` : ''}
          ${c.custom ? `<button class="icon-btn fc-del" data-f="del-case" data-case="${c.id}" title="Vakayı sil" aria-label="Vakayı sil">${C.ICON.trash}</button>` : ''}</div>
        <h3>${esc(p.name)}${p.age ? `, ${p.age}` : ''}</h3>
        <div class="muted fc-job">${esc(p.job)}</div>
        <p class="fc-complaint">${esc(c.complaint)}</p>
        <details class="fc-dx" ${tried ? '' : ''}><summary>Tanıyı göster</summary>${esc(c.title)}</details>
        <div class="fc-parts">${[1, 2, 3].map((n) => {
          const b = bestScore(c.id, n);
          return `<button class="fc-part" data-f="start" data-case="${c.id}" data-part="${n}" title="${PARTS[n].label}">
            <span class="fc-part-l">${C.ICON[PARTS[n].icon]}${n} · ${PARTS[n].short}</span>${b !== null ? `<b class="sc ${scoreClass(b)}">${b}</b>` : ''}</button>`;
        }).join('')}</div>
        <button class="fx-card-exam" data-f="exam-case" data-case="${c.id}" title="Bu vakayla 15 dk hazırlık + 3 bölüm">⏱ Tam sınav</button>
      </article>`;
}

/** Zorluk seçimi (Teil 1 ve 3 için; tercih olarak saklanır, yeni denemeye kaydedilir) */
function levelBarHtml() {
  const cur = levelOf(C.prefs.fspLevel);
  return `<div class="fx-levelbar"><span class="fx-levelbar-l">Zorluk <small class="muted">(Teil 1 ve 3)</small></span>
    <div class="fx-levels" role="radiogroup">${LEVELS.map(([k, l, h]) => `<button type="button" role="radio" aria-checked="${cur === k}" class="${cur === k ? 'on' : ''}" data-f="level" data-level="${k}" title="${esc(h)}">${l}</button>`).join('')}</div>
    <span class="muted fx-level-hint">${esc(LEVELS.find(([k]) => k === cur)[2])}</span></div>`;
}

function historyHtml() {
  const list = attempts();
  if (!list.length) return '<div class="panel empty">Henüz deneme yok. Bir vaka seçip başla.</div>';
  const done = list.filter((a) => a.data.report);
  const mean = (s) => (s.length ? Math.round(s.reduce((x, y) => x + y, 0) / s.length) : null);
  const avg = (part) => mean(done.filter((a) => !isExam(a) && a.data.part === part).map((a) => a.data.report.gesamt));
  const exams = done.filter(isExam);
  return `
    <div class="fsp-stats ${exams.length ? 'fx-4' : ''}">${[1, 2, 3].map((n) => {
      const a = avg(n);
      return `<div class="stat-card"><span class="stat-label">${PARTS[n].label}</span><b class="stat-big">${a ?? '—'}</b><span class="muted">${done.filter((x) => !isExam(x) && x.data.part === n).length} değerlendirme · ortalama</span></div>`;
    }).join('')}${exams.length ? `<div class="stat-card fx-stat-exam"><span class="stat-label">Tam sınav</span><b class="stat-big">${mean(exams.map((a) => a.data.report.gesamt))}</b><span class="muted">${exams.length} sınav · ortalama</span></div>` : ''}</div>
    <div class="fsp-hist">${list.map((a) => {
      const d = a.data;
      const r = d.report;
      const exam = isExam(a);
      const tag = exam
        ? `<span class="badge fx-exam-badge">⏱ Tam sınav</span>`
        : `<span class="badge">${PARTS[d.part]?.label || ''}</span>${d.part !== 2 && d.level ? `<span class="fx-lvl-tag">${levelLabel(d.level)}</span>` : ''}`;
      return `<div class="fh-row ${exam ? 'fx-hist-exam' : ''}">
        <button class="fh-open" data-f="open" data-attempt="${a.id}">
          <span class="fh-title">${esc(d.case?.patient?.name || '')} · ${esc(d.case?.title || '')}</span>
          <span class="fh-meta">${tag}<span class="muted">${dateStr(a.created_at)}</span>
            ${r ? `<span class="sc ${scoreClass(r.gesamt)}">${r.gesamt}</span><span class="muted">${esc(r.ergebnis)}${exam ? ' (tahmin)' : ''}</span>`
    : `<span class="fh-open-tag">${exam ? `devam ediyor · ${phaseLabel(d.phase)}` : 'devam ediyor'}</span>`}</span>
        </button>
        <button class="icon-btn" data-f="del-attempt" data-attempt="${a.id}" title="Sil" aria-label="Sil">${C.ICON.trash}</button>
      </div>`;
    }).join('')}</div>`;
}

function filteredTerms() {
  const q = ui.termQ.trim().toLocaleLowerCase('de');
  return content.guide.terms.filter((t) => (!ui.termKat || t.kat === ui.termKat)
    && (!q || `${t.fach} ${t.umgang} ${t.tr}`.toLocaleLowerCase('de').includes(q)));
}

function termsHtml() {
  const kats = [...new Set(content.guide.terms.map((t) => t.kat))];
  return `
    <p class="muted fsp-lead">Sınavda hastaya tıp terimiyle değil, günlük dille anlatman beklenir. Oberarzt da bir terimi hastaya nasıl açıklayacağını sorabilir.</p>
    <div class="fsp-term-tools">
      <input type="search" id="fsp-term-q" placeholder="Ara: Pulpitis, Zahnfleisch, çürük…" value="${esc(ui.termQ)}">
      <button data-f="terms-all">＋ Listeyi “${DECK_NAME}” destesine ekle</button>
    </div>
    <div class="chips">${['', ...kats].map((k) => `<button type="button" class="chip ${ui.termKat === k ? 'on' : ''}" data-f="kat" data-kat="${esc(k)}">${k ? esc(k) : 'Tümü'}</button>`).join('')}</div>
    <div id="fsp-terms">${termRows()}</div>`;
}

function termRows() {
  const list = filteredTerms();
  return list.length ? `<div class="fsp-terms">${list.map((t, i) => `
    <div class="ft-row">
      <div class="ft-fach"><b>${esc(t.fach)}</b><button class="icon-btn ft-say" data-f="say" data-text="${esc(t.fach)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button></div>
      <div class="ft-umg">${esc(t.umgang)}</div>
      <div class="ft-tr muted">${esc(t.tr)}</div>
      <button class="icon-btn" data-f="term-add" data-i="${content.guide.terms.indexOf(t)}" title="Desteye ekle" aria-label="Desteye ekle">＋</button>
    </div>`).join('')}</div>` : '<div class="panel empty">Sonuç yok.</div>';
}

function guideHtml() {
  const g = content.guide;
  const say = (s) => `<button class="icon-btn ft-say" data-f="say" data-text="${esc(s)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button>`;
  return `
    <section class="panel fsp-guide"><h3>${esc(g.exam.title)}</h3><ul>${g.exam.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></section>
    <h3 class="fsp-h">Anamnez rehberi (Teil 1)</h3>
    ${g.anamnesis.map((s) => `<details class="panel fsp-guide"><summary><b>${esc(s.topic)}</b></summary><ul class="say-list">${s.items.map((i) => `<li>${say(i)}<span>${esc(i)}</span></li>`).join('')}</ul></details>`).join('')}
    <h3 class="fsp-h">Kalıp ifadeler (Teil 2 ve 3)</h3>
    ${g.phrases.map((s) => `<details class="panel fsp-guide"><summary><b>${esc(s.topic)}</b></summary><ul class="say-list">${s.items.map((i) => `<li>${say(i)}<span>${esc(i)}</span></li>`).join('')}</ul></details>`).join('')}`;
}

/* ------------------------------------------------------------------ deneme başlat / aç */

function startAttempt(caseId, part) {
  const c = caseById(caseId);
  if (!c) throw new Error('Vaka bulunamadı.');
  if (part !== 2 && !C.sync.user()) { C.toast('Simülasyon için giriş yapman gerekiyor.', 'info'); return; }
  const open = attemptsOf(caseId, part).find((a) => !a.data.report);
  if (open) return openAttempt(open.id);
  const p = c.patient || {};
  const first = part === 1
    ? [{ role: 'model', text: c.greeting || 'Guten Tag.' }]
    : part === 3
      ? [{ role: 'model', text: oberarztHello(p) }]
      : [];
  // Teil 2 ve 3 için aynı vakanın son Teil 1 notları ve konuşması bilgi olarak taşınır
  const prev = attemptsOf(caseId, 1)[0]?.data;
  const rec = C.store.createFsp('attempt', {
    caseId, part, case: stripCase(c), messages: first, brief: {}, notes: prev?.notes || '',
    level: levelOf(C.prefs.fspLevel),
    konjunktiv: C.prefs.fspKonj !== false, startedAt: now(), report: null,
  });
  openAttempt(rec.id);
}

const oberarztHello = (p) => `Guten Tag, Frau Kollegin, Herr Kollege. Sie haben heute ${p?.name ? p.name.replace(/^Herr /, 'Herrn ') : 'den Patienten'} gesehen. Bitte stellen Sie mir den Fall vor.`;

/**
 * Başka modüller (ör. Krankheitsbilder kütüphanesi) için: verilen vaka nesnesiyle simülasyonu başlatır.
 * caseObj = SCHEMA.md'deki `sim` biçimi + id/title/fachgebiet. part: 1 | 2 | 3 | 'exam' (tam sınav).
 */
export async function startCaseFromObject(caseObj, part = 1) {
  if (!caseObj || typeof caseObj !== 'object' || !caseObj.facts) throw new Error('Vaka bilgisi eksik (facts yok).');
  try { await load(); } catch { /* içerik yüklenemese de dış vaka çalışır */ }
  const id = String(caseObj.id || `ext-${Date.now().toString(36)}`);
  const c = { ...caseObj, id, title: caseObj.title || caseObj.expected?.diagnosis || 'Fall', fachgebiet: caseObj.fachgebiet || caseObj.fach || '', patient: caseObj.patient || {} };
  extCases.set(id, c);
  if (part === 'exam') return startExam(id);
  const n = Number(part);
  return startAttempt(id, [1, 2, 3].includes(n) ? n : 1);
}

function stripCase(c) {
  const { custom, ...rest } = c;
  return rest;
}

export function openAttempt(id) {
  const a = C.store.getFsp(id);
  if (!a) throw new Error('Deneme bulunamadı.');
  C.leaveStudy();
  stopRun();
  ui.attemptId = id;
  C.state.view = 'fsp-run';
  document.body.classList.remove('menu-open');
  C.renderSidebar();
  C.setTitle(isExam(a) ? 'Prüfungssimulation' : PARTS[a.data.part]?.label || 'FSP');
  renderRun();
  if (!a.data.report) ui.tick = setInterval(tickClock, 1000);
  if (isExam(a) && a.data.phase === 'eval') runExamEval(); // yarım kalan değerlendirmeyi sürdür
}

function stopRun() {
  clearInterval(ui.tick);
  ui.tick = null;
  ui.rec?.stop();
  ui.rec = null;
  flushSave();
}

/* ------------------------------------------------------------------ deneme ekranı */

function renderRun() {
  const a = current();
  if (!a) return;
  if (isExam(a)) { renderExam(); return; }
  const d = a.data;
  const c = d.case;
  const p = c.patient || {};
  const lvl = d.part !== 2 && !d.report
    ? `<select class="fx-level-sel" data-f="run-level" title="Zorluk (sonraki cevaplardan itibaren)" aria-label="Zorluk">${LEVELS.map(([k, l]) => `<option value="${k}" ${levelOf(d.level) === k ? 'selected' : ''}>${l}</option>`).join('')}</select>` : '';
  const head = `
    <header class="deck-head fsp-run-head">
      <button class="icon-btn head-btn" data-f="back" title="Vakalara dön (Esc)" aria-label="Vakalara dön">${C.ICON.back}</button>
      <div class="deck-title"><h1>${esc(p.name)}${p.age ? `, ${p.age}` : ''}</h1>
        <div class="sub">${PARTS[d.part].label} · ${esc(c.fachgebiet)}${d.part !== 2 && d.report && d.level ? ` · ${levelLabel(d.level)}` : ''}</div></div>
      <div class="head-actions">${lvl}
        ${d.report ? `
          <button data-f="again">↻ Tekrar dene</button>
          ${d.part < 3 ? `<button class="primary" data-f="next">${C.ICON[PARTS[d.part + 1].icon]}${PARTS[d.part + 1].short} →</button>` : ''}`
        : `<span class="fsp-clock" id="fsp-clock"></span>
          <button class="primary" data-f="finish">${d.part === 2 ? 'Teslim et ve değerlendir' : 'Bitir ve değerlendir'}</button>`}
      </div>
    </header>`;
  let body;
  if (d.report) body = reportHtml(d);
  else if (d.part === 2) body = briefHtml(d);
  else body = chatHtml(d);
  C.main.innerHTML = `<div class="page fsp-run fsp-p${d.part} ${d.report ? 'has-report' : ''}">${head}${body}</div>`;
  tickClock();
  if (!d.report && d.part !== 2) scrollChat();
}

function sideHtml(d) {
  const c = d.case;
  const p = c.patient || {};
  const prev = attemptsOf(d.caseId, 1).find((a) => a.id !== ui.attemptId && a.data.messages?.length > 1)?.data;
  const blocks = [];
  blocks.push(`<section class="panel fsp-side-card"><h3>${d.part === 1 ? 'Hasta' : 'Vaka'}</h3>
    <dl><dt>Hasta</dt><dd>${esc(p.name)}${p.age ? `, ${p.age} yaş` : ''}</dd><dt>Meslek</dt><dd>${esc(p.job)}</dd><dt>Başvuru</dt><dd>${esc(c.complaint)}</dd></dl></section>`);
  if (d.part !== 1) {
    blocks.push(`<section class="panel fsp-side-card"><h3>Röntgen / klinik bulgu</h3><p class="fsp-xray">${esc(c.xray)}</p></section>`);
    if (prev) {
      blocks.push(`<details class="panel fsp-side-card"><summary><b>Teil 1 konuşman</b></summary><div class="fsp-transcript">${prev.messages.map((m) => `<p><b>${m.role === 'user' ? 'Du' : 'Patient'}:</b> ${esc(m.text)}</p>`).join('')}</div></details>`);
    } else {
      blocks.push(`<details class="panel fsp-side-card" ${d.part === 2 ? 'open' : ''}><summary><b>Anamnez bilgileri</b></summary><p class="muted" style="font-size:12.5px">Bu vakada Teil 1'i yapmadın; anamnez bilgileri not hâlinde veriliyor.</p><pre class="fsp-facts">${esc(c.facts)}</pre></details>`);
    }
  }
  blocks.push(`<section class="panel fsp-side-card"><h3>Notlar</h3><textarea id="fsp-notes" rows="6" placeholder="Görüşme sırasında not al (Teil 2 ve 3'te de görünür)">${esc(d.notes || '')}</textarea></section>`);
  const g = content?.guide;
  if (g && d.part === 1) {
    blocks.push(`<details class="panel fsp-side-card"><summary><b>Anamnez başlıkları</b></summary><ul class="fsp-check">${g.anamnesis.map((s) => `<li>${esc(s.topic)}</li>`).join('')}</ul>
      <p class="muted" style="font-size:12.5px">Ayrıntılı soru örnekleri Rehber sekmesinde.</p></details>`);
  }
  if (g && d.part === 3) {
    const ph = g.phrases.find((x) => x.topic === 'Arzt-Arzt-Gespräch');
    if (ph) blocks.push(`<details class="panel fsp-side-card"><summary><b>Kalıp ifadeler</b></summary><ul class="say-list">${ph.items.map((i) => `<li><span>${esc(i)}</span></li>`).join('')}</ul></details>`);
  }
  return `<aside class="fsp-side">${blocks.join('')}</aside>`;
}

function chatHtml(d) {
  const who = d.part === 1 ? 'Patient' : 'Oberarzt';
  const last = d.messages[d.messages.length - 1];
  const voice = C.prefs.fspVoice !== false;
  return `<div class="fsp-split">
    <section class="fsp-chat">
      <div class="fsp-msgs" id="fsp-msgs">
        ${d.messages.map((m) => `<div class="fm ${m.role === 'user' ? 'me' : 'ai'}">
          ${m.role === 'user' ? '' : `<span class="fm-who" lang="de">${who}</span>`}
          <div class="fm-bubble">${esc(m.text)}</div>
          ${m.role === 'user' ? '' : `<button class="icon-btn fm-say" data-f="say" data-text="${esc(m.text)}" title="Tekrar dinle" aria-label="Tekrar dinle">${C.ICON.speaker}</button>`}
        </div>`).join('')}
        ${ui.pending ? `<div class="fm ai"><span class="fm-who" lang="de">${who}</span><div class="fm-bubble typing"><i></i><i></i><i></i></div></div>` : ''}
        ${!ui.pending && last?.role === 'user' ? '<div class="fm-retry"><button data-f="retry">Cevap gelmedi · tekrar dene</button></div>' : ''}
        ${d.oberarztDone ? `<div class="fm-end">Oberarzt görüşmeyi bitirdi. Şimdi “${d.mode === 'exam' ? 'Sınavı bitir' : 'Bitir ve değerlendir'}”e bas.</div>` : ''}
      </div>
      <div class="fsp-composer">
        <textarea id="fsp-input" rows="2" placeholder="${d.part === 1 ? 'Hastaya sor… (Enter gönderir, Shift+Enter yeni satır)' : 'Vakayı sun ya da soruyu cevapla…'}" ${ui.pending ? 'disabled' : ''}></textarea>
        <div class="fsp-comp-tools">
          ${SR ? `<button type="button" class="icon-btn fsp-mic" data-f="mic" title="Konuşarak yaz (Almanca)" aria-label="Mikrofon">${C.ICON.mic}</button>` : ''}
          <label class="fsp-voice" title="${who} cevaplarını sesli oku"><input type="checkbox" data-f="voice" ${voice ? 'checked' : ''}> ${C.ICON.speaker}</label>
          <button class="primary" data-f="send" ${ui.pending ? 'disabled' : ''}>Gönder</button>
        </div>
      </div>
    </section>
    ${d.mode === 'exam' ? examSideHtml(d) : sideHtml(d)}
  </div>`;
}

function briefHtml(d) {
  const b = d.brief || {};
  return `<div class="fsp-split">
    <section class="fsp-brief">
      <label class="radio fsp-konj"><input type="checkbox" data-f="konj" ${d.konjunktiv ? 'checked' : ''}> Anamnez bölümlerinde dolaylı anlatım (Konjunktiv I) bekleniyor</label>
      ${BRIEF.map(([k, label, hint]) => `
        <label class="fsp-sec"><span class="fs-label">${label} <small class="muted" id="fsp-wc-${k}">${wc(b[k])} kelime</small></span>
          <textarea data-brief="${k}" rows="${k === 'aktuell' || k === 'therapie' ? 7 : 5}" placeholder="${esc(hint)}" spellcheck="false">${esc(b[k] || '')}</textarea></label>`).join('')}
      <p class="muted" style="font-size:12.5px">Gerçek sınavda çoğu odada el yazısıyla yazılır; burada yazım denetimi kapalı.</p>
    </section>
    ${d.mode === 'exam' ? examSideHtml(d) : sideHtml(d)}
  </div>`;
}

const wc = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

/** d.report'u gösterir. rk: tam sınavda bölüm numarası (kelime ekleme düğmeleri doğru rapora gitsin diye). */
function reportHtml(d, rk = '') {
  const r = { kategorien: [], fehlend: [], korrekturen: [], besser: [], staerken: [], vokabeln: [], uebung: [], ...d.report };
  const rkAttr = rk ? ` data-rk="${rk}"` : '';
  const ref = d.part === 2
    ? `<details class="panel"><summary><b>Arztbrief'in</b></summary>${BRIEF.map(([k, label]) => `<h4>${label}</h4><p class="fsp-pre">${esc(d.brief?.[k] || '—')}</p>`).join('')}</details>`
    : `<details class="panel"><summary><b>Konuşma kaydı</b> <span class="muted">(${d.messages.length} mesaj)</span></summary><div class="fsp-transcript">${d.messages.map((m) => `<p><b>${m.role === 'user' ? 'Du' : d.part === 1 ? 'Patient' : 'Oberarzt'}:</b> ${esc(m.text)}</p>`).join('')}</div></details>`;
  return `<div class="fsp-report">
    <section class="panel fr-top">
      <div class="fr-score ${scoreClass(r.gesamt)}"><b>${r.gesamt}</b><span>/100</span></div>
      <div class="fr-sum"><span class="fr-res ${scoreClass(r.gesamt)}">${esc(r.ergebnis)}</span>
        <p>${esc(r.fazit)}</p>
        <span class="muted fr-meta">${d.durationSec ? `Süre ${fmtClock(d.durationSec)} · ` : ''}${dateStr(r.at || now())}</span></div>
    </section>
    ${r.kategorien.length ? `<section class="panel fr-cats">${r.kategorien.map((k) => `
      <div class="fr-cat"><div class="fr-cat-h"><b>${esc(k.name)}</b><span class="sc ${scoreClass(k.punkte)}">${k.punkte}</span></div>
        <div class="fr-bar"><i class="${scoreClass(k.punkte)}" style="width:${k.punkte}%"></i></div>
        <p class="muted">${esc(k.kommentar)}</p></div>`).join('')}</section>` : ''}
    ${r.fehlend.length ? `<section class="panel"><h3>${d.part === 1 ? 'Sorulmayan / eksik kalanlar' : 'Eksik içerik'}</h3><ul class="fr-miss">${r.fehlend.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    ${r.korrekturen.length ? `<section class="panel"><h3>Düzeltmeler <span class="muted">(${r.korrekturen.length})</span></h3>${r.korrekturen.map((k) => `
      <div class="fr-fix"><div><del>${esc(k.original)}</del></div><div><ins>${esc(k.korrigiert)}</ins>${k.typ ? ` <span class="badge">${esc(k.typ)}</span>` : ''}</div>
        ${k.erklaerung ? `<p class="muted">${esc(k.erklaerung)}</p>` : ''}</div>`).join('')}</section>` : ''}
    ${r.abschnitte?.length ? `<section class="panel"><h3>Düzeltilmiş Arztbrief</h3>${r.abschnitte.map((s) => `<h4>${esc(s.name)}</h4><p class="fsp-pre">${esc(s.verbessert)}</p>`).join('')}</section>` : ''}
    ${r.besser.length ? `<section class="panel"><h3>Daha iyi ifade</h3>${r.besser.map((b) => `
      <div class="fr-fix">${b.statt ? `<div class="muted">„${esc(b.statt)}“</div>` : ''}<div><b>${esc(b.besser)}</b> <button class="icon-btn ft-say" data-f="say" data-text="${esc(b.besser)}" aria-label="Seslendir">${C.ICON.speaker}</button></div>
        ${b.warum ? `<p class="muted">${esc(b.warum)}</p>` : ''}</div>`).join('')}</section>` : ''}
    ${r.staerken.length ? `<section class="panel"><h3>İyi yaptıkların</h3><ul>${r.staerken.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    ${uebungHtml(r.uebung)}
    ${r.vokabeln.length ? `<section class="panel"><div class="sec-head"><h3>Faydalı kelimeler</h3><button data-f="vocab-all"${rkAttr}>＋ Hepsini “${DECK_NAME}” destesine ekle</button></div>
      <div class="fsp-terms">${r.vokabeln.map((v, i) => `<div class="ft-row"><div class="ft-fach"><b>${esc(v.de)}</b><button class="icon-btn ft-say" data-f="say" data-text="${esc(v.de)}" aria-label="Seslendir">${C.ICON.speaker}</button></div><div class="ft-tr muted">${esc(v.tr)}</div><button class="icon-btn" data-f="vocab-add" data-i="${i}"${rkAttr} title="Desteye ekle" aria-label="Desteye ekle">＋</button></div>`).join('')}</div></section>` : ''}
    ${ref}
  </div>`;
}

/** Rapordaki hata türüne göre alıştırmalar; çözüm açılır kutuda gizli. Eski raporlarda alan yok → boş. */
function uebungHtml(list) {
  if (!Array.isArray(list) || !list.length) return '';
  return `<section class="panel fx-uebung"><h3>Alıştırmalar <span class="muted">· en sık hata türüne göre</span></h3>
    ${list.map((u, i) => `<div class="fx-ue">
      <div class="fx-ue-h"><span class="fx-ue-n">${i + 1}</span>${u.fokus ? `<span class="badge">${esc(u.fokus)}</span>` : ''}</div>
      <p class="fx-ue-q" lang="de">${esc(u.aufgabe)}</p>
      <details class="fx-ue-sol"><summary>Çözümü göster</summary>
        <p lang="de"><b>${esc(u.loesung)}</b> <button type="button" class="icon-btn ft-say" data-f="say" data-text="${esc(u.loesung)}" aria-label="Seslendir">${C.ICON.speaker}</button></p>
        ${u.erklaerung_tr ? `<p class="muted">${esc(u.erklaerung_tr)}</p>` : ''}</details>
    </div>`).join('')}</section>`;
}

/* ------------------------------------------------------------------ süre */

function tickClock() {
  const el = document.getElementById('fsp-clock');
  const a = current();
  if (!a || a.data.report) return;
  if (isExam(a)) {
    // Tam sınav: her aşamanın kendi süresi var; süre dolunca aşama kendiliğinden kapanır
    const mins = EXAM_MIN[a.data.phase];
    if (!mins) return;
    const left = mins * 60 - (now() - a.data.phaseStartedAt);
    if (el) {
      el.textContent = `⏱ ${fmtClock(Math.max(0, left))}`;
      el.classList.toggle('over', left < 60);
    }
    if (left <= 0 && !ui.advancing && C.state.view === 'fsp-run') examAdvance(true);
    return;
  }
  if (!el) return;
  const left = PARTS[a.data.part].minutes * 60 - (now() - a.data.startedAt);
  el.textContent = `⏱ ${fmtClock(left)}`;
  el.classList.toggle('over', left < 0);
}

/* ------------------------------------------------------------------ sohbet */

function scrollChat() {
  const box = document.getElementById('fsp-msgs');
  if (box) box.scrollTop = box.scrollHeight;
}

async function send(text) {
  const a = current();
  if (!a || ui.pending) return;
  // Tam sınavda konuşmalar m1 (Teil 1) ve m3 (Teil 3) alanlarında, tek bölümde messages alanında
  const exam = isExam(a);
  if (exam && !['t1', 't3'].includes(a.data.phase)) return;
  const phase = a.data.phase;
  const key = exam ? (phase === 't1' ? 'm1' : 'm3') : 'messages';
  const part = exam ? (phase === 't1' ? 1 : 3) : a.data.part;
  const d = { ...a.data, [key]: [...(a.data[key] || [])] };
  if (text) d[key].push({ role: 'user', text, at: now() });
  saveAttempt(d);
  ui.pending = true;
  renderRun();
  try {
    const res = await C.sync.fspAi({
      action: part === 1 ? 'patient' : 'oberarzt', case: d.case, level: exam ? 'pruefung' : levelOf(d.level),
      history: d[key].map(({ role, text: t }) => ({ role, text: t })),
    }, 60_000);
    const cur = current();
    if (!cur || cur.id !== a.id) return;
    const next = { ...cur.data, [key]: [...(cur.data[key] || []), { role: 'model', text: res.reply, at: now() }] };
    if (res.done) next.oberarztDone = true;
    saveAttempt(next);
    // Süre dolup aşama değiştiyse eski bölümün cevabını seslendirme
    if (C.prefs.fspVoice !== false && (!exam || cur.data.phase === phase)) C.speak(res.reply, 'de');
  } catch (e) {
    C.toast(e.message || String(e), 'error', 5000);
  } finally {
    ui.pending = false;
    if (C.state.view === 'fsp-run' && ui.attemptId === a.id) {
      renderRun();
      document.getElementById('fsp-input')?.focus();
    }
  }
}

function sendFromInput() {
  const box = document.getElementById('fsp-input');
  const text = box?.value.trim();
  if (!text) return;
  ui.rec?.stop();
  box.value = '';
  send(text);
}

function toggleMic(btn, target = 'fsp-input') {
  if (ui.rec) { ui.rec.stop(); return; }
  const box = document.getElementById(target);
  if (!SR || !box) return;
  const rec = new SR();
  rec.lang = 'de-DE';
  rec.interimResults = true;
  rec.continuous = true;
  const base = box.value ? `${box.value.trimEnd()} ` : '';
  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    box.value = base + finalText + interim;
    if (target === 'pr-answer' && ui.practice) ui.practice.answer = box.value;
  };
  rec.onerror = (e) => {
    if (e.error === 'not-allowed') C.toast('Mikrofon izni verilmedi.', 'error');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') C.toast(`Ses tanıma hatası: ${e.error}`, 'error');
  };
  rec.onend = () => { ui.rec = null; btn.classList.remove('on'); };
  try { rec.start(); } catch { return; }
  C.stopSpeech?.();
  ui.rec = rec;
  btn.classList.add('on');
}

/* ------------------------------------------------------------------ değerlendirme */

async function finish() {
  const a = current();
  if (!a || ui.pending) return;
  flushSave();
  const d = current().data;
  if (d.part === 2) {
    const total = BRIEF.reduce((n, [k]) => n + wc(d.brief?.[k]), 0);
    if (total < 30) { C.toast('Arztbrief çok kısa; önce bölümleri doldur.', 'info'); return; }
  } else if (d.messages.filter((m) => m.role === 'user').length < 3) {
    C.toast('Değerlendirme için konuşma çok kısa.', 'info');
    return;
  } else if (d.part === 3 && !d.oberarztDone && !(await C.confirmBox('Oberarzt henüz tüm sorularını sormadı. Yine de bitirilsin mi?', { ok: 'Bitir ve değerlendir' }))) {
    return;
  }
  ui.rec?.stop();
  ui.pending = true;
  const wait = C.toast('Değerlendiriliyor… bu 30–90 saniye sürebilir.', 'info', 120_000);
  C.$$('[data-f=finish]').forEach((b) => { b.disabled = true; b.textContent = 'Değerlendiriliyor…'; });
  try {
    const res = await C.sync.fspAi({
      action: 'evaluate', part: d.part, case: d.case, konjunktiv: !!d.konjunktiv,
      ...(d.part === 2 ? { brief: d.brief } : { history: d.messages.map(({ role, text }) => ({ role, text })) }),
    }, 170_000);
    const cur = current();
    if (!cur || cur.id !== a.id) return;
    saveAttempt({ ...cur.data, report: res.report, durationSec: now() - cur.data.startedAt, finishedAt: now() });
    clearInterval(ui.tick);
    ui.tick = null;
  } catch (e) {
    C.toast(e.message || String(e), 'error', 6000);
  } finally {
    wait.remove();
    ui.pending = false;
    if (C.state.view === 'fsp-run' && ui.attemptId === a.id) { renderRun(); C.main.scrollTop = 0; window.scrollTo(0, 0); }
  }
}

/* ------------------------------------------------------------------ kayıt (not, brief) */

function scheduleSave() {
  clearTimeout(ui.saveT);
  ui.saveT = setTimeout(flushSave, 600);
}
function flushSave() {
  clearTimeout(ui.saveT);
  ui.saveT = null;
  const a = current();
  if (!a || a.data.report) return;
  const notes = document.getElementById('fsp-notes');
  const brief = { ...(a.data.brief || {}) };
  let changed = false;
  C.$$('[data-brief]').forEach((t) => { if (brief[t.dataset.brief] !== t.value) { brief[t.dataset.brief] = t.value; changed = true; } });
  if (notes && notes.value !== (a.data.notes || '')) changed = true;
  if (changed) saveAttempt({ ...a.data, brief, notes: notes ? notes.value : a.data.notes });
}
export const flushFsp = flushSave;

/* ------------------------------------------------------------------ desteye ekleme */

function fspDeck(name = DECK_NAME) {
  const own = C.state.decks.find((d) => d.name === name && d.role !== 'viewer');
  if (own) return own;
  return C.store.createDeck({ name, language: 'de' });
}
function addCards(items, name = DECK_NAME) {
  if (!items.length) return;
  const deck = fspDeck(name);
  const r = C.store.importCards({ deck_id: deck.id }, items);
  C.refreshDecks();
  C.toast(r.added ? `${r.added} kart “${name}” destesine eklendi${r.updated ? ` (${r.updated} tanesi güncellendi)` : ''}.` : 'Bunlar destede zaten var.', 'success');
}
const BY_DECK = 'FSP Bayern · Fragen';
const qCard = (q) => ({ word: q.de, translation: q.tr, sentence: q.a, notes: q.atr });
const termCard = (t) => ({ word: t.fach, translation: t.tr, sentence: '', notes: `Für Patienten: ${t.umgang}` });

/* ------------------------------------------------------------------ olaylar */

function onClick(e) {
  const el = e.target.closest('[data-f]');
  if (!el || !C.main.contains(el)) return;
  const f = el.dataset.f;
  if (el.tagName === 'INPUT') return; // onChange halleder
  C.guard(async () => {
    switch (f) {
      case 'tab': flushSave(); ui.tab = el.dataset.tab; renderHub(); break;
      case 'sub': ui.subs[ui.tab] = el.dataset.sub; renderHub(); break;
      case 'fach': ui.fach = el.dataset.fach; renderHub(); break;
      case 'by-sec': ui.bySec = el.dataset.sec; ui.practice = null; renderHub(); break;
      case 'by-topic': ui.byTopic = el.dataset.topic; renderHub(); break;
      case 'by-tr': ui.byTr = !ui.byTr; renderHub(); break;
      case 'by-add': addCards([qCard(byItem(el.dataset.id))], BY_DECK); break;
      case 'by-add-all': addCards(byList().map(qCard), BY_DECK); break;
      case 'by-practice': startPractice(el.dataset.id); break;
      case 'pr-reveal': ui.practice.revealed = true; renderHub(); break;
      case 'pr-next': nextPractice(el.dataset.ok === '1'); break;
      case 'pr-exit': ui.practice = null; renderHub(); break;
      case 'pr-check': await checkAnswer(); break;
      case 'pr-mic': toggleMic(el, 'pr-answer'); break;
      case 'kat': ui.termKat = el.dataset.kat; renderHub(); break;
      case 'start': await load(); startAttempt(el.dataset.case, Number(el.dataset.part)); break;
      case 'open': await load(); openAttempt(el.dataset.attempt); break;
      case 'back': leaveRun(); break;
      case 'level': C.prefs.fspLevel = levelOf(el.dataset.level); C.savePrefs(); renderHub(); break;
      case 'exam-new': await load(); examModal(); break;
      case 'exam-case': await load(); startExam(el.dataset.case); break;
      case 'exam-next': await examAdvance(false); break;
      case 'exam-retry': runExamEval(); break;
      case 'exam-again': await load(); examModal(current()?.data.caseId); break;
      case 'say': C.speak(el.dataset.text, 'de'); break;
      case 'send': sendFromInput(); break;
      case 'retry': send(''); break;
      case 'mic': toggleMic(el); break;
      case 'finish': await finish(); break;
      case 'again': { const d = current().data; startAttempt(d.caseId, d.part); break; }
      case 'next': { const d = current().data; startAttempt(d.caseId, d.part + 1); break; }
      case 'del-attempt':
        if (await C.confirmBox('Bu deneme ve değerlendirmesi silinecek.', { ok: 'Sil', danger: true })) { C.store.deleteFsp(el.dataset.attempt); renderHub(); }
        break;
      case 'del-case':
        if (await C.confirmBox('Bu vaka silinecek. Denemelerin geçmişte kalır.', { ok: 'Sil', danger: true })) { C.store.deleteFsp(el.dataset.case); renderHub(); }
        break;
      case 'new-case': newCaseModal(); break;
      case 'term-add': addCards([termCard(content.guide.terms[Number(el.dataset.i)])]); break;
      case 'terms-all': addCards(filteredTerms().map(termCard)); break;
      case 'vocab-add': { const v = repOf(el).vokabeln[Number(el.dataset.i)]; addCards([{ word: v.de, translation: v.tr }]); break; }
      case 'vocab-all': addCards(repOf(el).vokabeln.map((v) => ({ word: v.de, translation: v.tr }))); break;
      default: break;
    }
  });
}

function onChange(e) {
  const el = e.target.closest('[data-f]');
  if (!el || !C.main.contains(el)) return;
  if (el.dataset.f === 'voice') { C.prefs.fspVoice = el.checked; C.savePrefs(); if (!el.checked) C.stopSpeech?.(); }
  if (el.dataset.f === 'run-level') {
    const a = current();
    const level = levelOf(el.value);
    C.prefs.fspLevel = level;
    C.savePrefs();
    if (a && !isExam(a)) { flushSave(); saveAttempt({ ...current().data, level }); }
  }
  if (el.dataset.f === 'konj') {
    C.prefs.fspKonj = el.checked;
    C.savePrefs();
    flushSave();
    const a = current();
    if (a) saveAttempt({ ...a.data, konjunktiv: el.checked });
  }
}

function onInput(e) {
  if (e.target.id === 'by-q') {
    ui.byQ = e.target.value;
    const box = document.getElementById('by-list');
    if (box) box.innerHTML = byRows();
    return;
  }
  if (e.target.id === 'pr-answer' && ui.practice) { ui.practice.answer = e.target.value; return; }
  if (e.target.id === 'fsp-term-q') {
    ui.termQ = e.target.value;
    const box = document.getElementById('fsp-terms');
    if (box) box.innerHTML = termRows();
    return;
  }
  if (e.target.dataset?.brief) {
    const w = document.getElementById(`fsp-wc-${e.target.dataset.brief}`);
    if (w) w.textContent = `${wc(e.target.value)} kelime`;
    scheduleSave();
  } else if (e.target.id === 'fsp-notes') scheduleSave();
}

function onKey(e) {
  if (e.target.id === 'fsp-input' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendFromInput();
  }
}

/** Esc / Android geri tuşu: işlenirse true. */
export function fspBack() {
  if (C.state.view === 'fsp-run') { leaveRun(); return true; }
  if (C.state.view === 'fsp') { if (!learnBack()) C.showHome(); return true; }
  return false;
}

/** Başka cihazdan veri gelince: açık ekranı (yazım sırasında bozmadan) tazeler. */
export function fspRemote() {
  if (C.state.view === 'fsp') renderHub();
  else if (C.state.view === 'fsp-run' && !current()) showFsp();
}

/* ------------------------------------------------------------------ Bayern: raporlardan soru bankası, hasta soruları, vakalar, ipuçları */

const BY_SECS = [['fragen', 'Teil 3 soruları'], ['patient', 'Hasta soruları (Teil 1)'], ['faelle', 'Sık çıkan vakalar'], ['tipps', 'İpuçları']];
const known = () => new Set(C.prefs.fspKnown || []);
const byPool = () => (ui.bySec === 'patient' ? content.bayern.patient : content.bayern.questions);
const byItem = (id) => [...content.bayern.questions, ...content.bayern.patient].find((q) => q.id === id);
function byList() {
  const q = ui.byQ.trim().toLocaleLowerCase('de');
  return byPool()
    .filter((x) => ui.bySec === 'patient' || !ui.byTopic || x.topic === ui.byTopic)
    .filter((x) => !q || `${x.de} ${x.tr} ${x.a}`.toLocaleLowerCase('de').includes(q))
    .sort((a, b) => (b.n || 0) - (a.n || 0));
}

function bayernHtml() {
  const b = content.bayern;
  const head = `
    <section class="panel by-intro">
      <div class="by-stats"><b>${b.reports}</b><span>rapor</span><b>${b.cases.length}</b><span>vaka tipi</span><b>${b.questions.length}</b><span>Teil 3 sorusu</span><b>${b.patient.length}</b><span>hasta sorusu</span></div>
      <p>${esc(b.intro)}</p>
      <p class="muted by-period">${esc(b.title)} · ${esc(b.period)}</p>
    </section>
    <div class="chips by-secs">${BY_SECS.map(([k, l]) => `<button type="button" class="chip ${ui.bySec === k ? 'on' : ''}" data-f="by-sec" data-sec="${k}">${l}</button>`).join('')}</div>`;
  if (ui.practice) return head + practiceHtml();
  if (ui.bySec === 'faelle') {
    const cs = [...b.cases].sort((x, y) => y.freq - x.freq);
    return `${head}<p class="muted fsp-lead">Raporlarda en sık çıkan vaka tipleri. Her biri Teil 1, 2 ve 3 olarak simüle edilebilir; hasta, raporlardaki gibi sorular soruyor.</p>
      ${levelBarHtml()}
      <div class="fsp-grid">${cs.map(caseCardHtml).join('')}</div>`;
  }
  if (ui.bySec === 'tipps') {
    return `${head}<div class="by-tips">${b.tips.map((t, i) => `<section class="panel by-tip"><span class="by-num">${i + 1}</span><div><h3>${esc(t.t)}</h3><p>${esc(t.d)}</p></div></section>`).join('')}</div>`;
  }
  const topics = ui.bySec === 'fragen'
    ? `<div class="chips">${[{ key: '', name: 'Tümü' }, ...b.topics].map((t) => {
      const n = t.key ? b.questions.filter((q) => q.topic === t.key).length : b.questions.length;
      return `<button type="button" class="chip ${ui.byTopic === t.key ? 'on' : ''}" data-f="by-topic" data-topic="${t.key}">${esc(t.name)} <small>${n}</small></button>`;
    }).join('')}</div>` : '';
  const k = known();
  const pool = byPool();
  const done = pool.filter((q) => k.has(q.id)).length;
  return `${head}
    <div class="by-tools">
      <input type="search" id="by-q" placeholder="Soru ara (Almanca ya da Türkçe)…" value="${esc(ui.byQ)}">
      <button class="primary" data-f="by-practice">▶ Pratik yap</button>
      <button data-f="by-add-all" title="Filtredeki soruları kart olarak ekler; tekrar sistemiyle çalışırsın">＋ Desteye ekle</button>
      <button class="ghost" data-f="by-tr">${ui.byTr ? 'Türkçeyi gizle' : 'Türkçeyi göster'}</button>
    </div>
    <div class="by-progress"><span style="width:${pool.length ? Math.round((done / pool.length) * 100) : 0}%"></span></div>
    <p class="muted by-prog-l">${done} / ${pool.length} soruyu “bildim” olarak işaretledin.</p>
    ${topics}
    <div id="by-list">${byRows()}</div>`;
}

function byRows() {
  const k = known();
  const list = byList();
  if (!list.length) return '<div class="panel empty">Sonuç yok.</div>';
  const say = (s) => `<button class="icon-btn ft-say" data-f="say" data-text="${esc(s)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button>`;
  return `<div class="by-list">${list.map((q) => `
    <details class="panel by-q ${k.has(q.id) ? 'is-known' : ''}">
      <summary>
        <span class="by-q-main"><span class="by-q-de" lang="de">${esc(q.de)}</span>${ui.byTr ? `<span class="by-q-tr">${esc(q.tr)}</span>` : ''}</span>
        <span class="by-q-meta">${q.n ? `<span class="by-freq" title="Raporlarda geçme sayısı">${q.n}×</span>` : ''}${k.has(q.id) ? '<span class="by-ok">✓</span>' : ''}</span>
      </summary>
      <div class="by-a">
        <div class="by-a-de" lang="de">${say(q.a)}<p>${esc(q.a)}</p></div>
        ${ui.byTr ? `<p class="by-a-tr">${esc(q.atr)}</p>` : ''}
        <div class="by-a-actions"><button data-f="by-practice" data-id="${q.id}">${C.ICON.mic}Cevaplamayı dene</button><button data-f="by-add" data-id="${q.id}">＋ Desteye ekle</button>${say(q.de)}</div>
      </div>
    </details>`).join('')}</div>`;
}

function startPractice(id) {
  const k = known();
  let order = byList().map((q) => q.id);
  if (id) order = [id, ...order.filter((x) => x !== id)];
  else order = [...order.filter((x) => !k.has(x)), ...order.filter((x) => k.has(x))];
  if (!order.length) { C.toast('Bu filtrede soru yok.', 'info'); return; }
  ui.practice = { order, i: 0, revealed: false, answer: '', check: null, ok: 0 };
  renderHub();
  if (C.prefs.fspVoice !== false) C.speak(byItem(order[0]).de, 'de');
}

function nextPractice(ok) {
  const p = ui.practice;
  const id = p.order[p.i];
  const k = known();
  if (ok) { k.add(id); p.ok++; } else k.delete(id);
  C.prefs.fspKnown = [...k];
  C.savePrefs();
  p.i++;
  p.revealed = false;
  p.answer = '';
  p.check = null;
  ui.rec?.stop();
  if (p.i >= p.order.length) {
    C.toast(`Bitti: ${p.ok} / ${p.order.length} soruyu bildin.`, 'success', 5000);
    ui.practice = null;
  } else if (C.prefs.fspVoice !== false) C.speak(byItem(p.order[p.i]).de, 'de');
  renderHub();
}

function practiceHtml() {
  const p = ui.practice;
  const q = byItem(p.order[p.i]);
  const say = (s) => `<button class="icon-btn ft-say" data-f="say" data-text="${esc(s)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button>`;
  const ch = p.check;
  return `
    <section class="panel by-practice">
      <div class="pr-top"><span class="muted">${p.i + 1} / ${p.order.length}</span>
        <div class="by-progress"><span style="width:${Math.round((p.i / p.order.length) * 100)}%"></span></div>
        <button class="ghost" data-f="pr-exit">Bitir</button></div>
      <div class="pr-q"><span lang="de">${esc(q.de)}</span>${say(q.de)}</div>
      ${ui.byTr ? `<p class="pr-tr">${esc(q.tr)}</p>` : ''}
      <label class="pr-label">Cevabın <small class="muted">(Almanca yaz ya da mikrofonla söyle; boş da bırakabilirsin)</small></label>
      <div class="pr-ans">
        <textarea id="pr-answer" rows="4" placeholder="${ui.bySec === 'patient' ? 'Hastaya günlük dille cevap ver…' : 'Meslektaşına tıp diliyle cevap ver…'}">${esc(p.answer)}</textarea>
        ${SR ? `<button type="button" class="icon-btn fsp-mic" data-f="pr-mic" title="Konuşarak cevapla (Almanca)" aria-label="Mikrofon">${C.ICON.mic}</button>` : ''}
      </div>
      ${ch ? `<div class="pr-check"><div class="pr-check-h"><span class="sc ${scoreClass(ch.punkte)}">${ch.punkte}</span><b>Yapay zekâ değerlendirmesi</b></div>
        <p>${esc(ch.feedback)}</p>
        ${ch.fehlend?.length ? `<p class="muted"><b>Eksik:</b> ${ch.fehlend.map(esc).join(' · ')}</p>` : ''}
        ${ch.korrigiert ? `<div class="pr-fix"><span class="muted">Düzeltilmiş hâli:</span><p lang="de">${esc(ch.korrigiert)}</p></div>` : ''}</div>` : ''}
      ${p.revealed ? `<div class="pr-model"><div class="by-a-de" lang="de">${say(q.a)}<p>${esc(q.a)}</p></div>${ui.byTr ? `<p class="by-a-tr">${esc(q.atr)}</p>` : ''}</div>` : ''}
      <div class="pr-actions">
        ${C.sync.user() ? `<button data-f="pr-check" ${ui.pending ? 'disabled' : ''}>${ui.pending ? 'Değerlendiriliyor…' : 'Cevabımı kontrol et (AI)'}</button>` : ''}
        ${p.revealed ? `<button data-f="pr-next" data-ok="0">↺ Tekrar sor</button><button class="primary" data-f="pr-next" data-ok="1">✓ Bildim</button>`
          : '<button class="primary" data-f="pr-reveal">Örnek cevabı göster</button>'}
      </div>
    </section>`;
}

async function checkAnswer() {
  const p = ui.practice;
  if (!p || ui.pending) return;
  const answer = (document.getElementById('pr-answer')?.value || p.answer || '').trim();
  if (answer.split(/\s+/).length < 4) { C.toast('Önce birkaç cümleyle cevap ver.', 'info'); return; }
  const q = byItem(p.order[p.i]);
  ui.rec?.stop();
  ui.pending = true;
  p.answer = answer;
  renderHub();
  try {
    const res = await C.sync.fspAi({ action: 'answer', question: q.de, model: q.a, answer, kind: ui.bySec === 'patient' ? 'patient' : 'arzt' }, 60_000);
    if (ui.practice === p) { p.check = res.check; p.revealed = true; }
  } catch (e) {
    C.toast(e.message || String(e), 'error', 5000);
  } finally {
    ui.pending = false;
    if (C.state.view === 'fsp' && ui.tab === 'bayern') renderHub();
  }
}

/* ------------------------------------------------------------------ tam sınav simülasyonu */
// Kayıt: attempt, data.mode = 'exam'. Aşamalar: prep → t1 → t2 → t3 → eval → done.
// data: { caseId, case, level:'pruefung', phase, phaseStartedAt, phases{ph:{start,end}}, notes, brief, m1, m3, oberarztDone,
//         konjunktiv, reports{1,2,3}, report (bitince birleşik rapor; geçmiş ve diğer modüllerle uyum için) }

const repOf = (el) => {
  const d = current().data;
  return (el.dataset.rk ? d.reports?.[el.dataset.rk] : d.report) || { vokabeln: [] };
};

function examModal(caseId = '') {
  if (!C.sync.user()) { C.toast('Sınav simülasyonu için giriş yapman gerekiyor.', 'info'); return; }
  const cs = allCases();
  C.openModal(`
    <h2>Tam sınav simülasyonu</h2>
    <p class="muted" style="font-size:13px">Gerçek sınav düzeni: 15 dk hazırlık, ardından Teil 1 (hasta görüşmesi), Teil 2 (Arztbrief) ve Teil 3 (Oberarzt), her biri 20 dk.
      Süre dolunca bölüm kendiliğinden kapanır. Teil 1'de ipucu paneli yok, hasta “Prüfungssimulation” seviyesinde; Teil 2'de konuşma kaydı değil, yalnızca notların görünür.</p>
    <label>Vaka<select name="pick">
      ${content?.bayern ? '<option value="bayern">Rastgele · Bayern vakaları</option>' : ''}
      <option value="all">Rastgele · tüm vakalar</option>
      <optgroup label="Belirli bir vaka">${cs.map((c) => `<option value="id:${esc(c.id)}" ${c.id === caseId ? 'selected' : ''}>${esc(c.fachgebiet)} · ${esc(c.patient?.name || '')} – ${esc(String(c.complaint || '').slice(0, 70))}</option>`).join('')}</optgroup>
    </select></label>
    <p class="muted" style="font-size:12.5px">Tanı gizli kalır. Sınavdan çıkarsan süre işlemeye devam eder; Geçmiş sekmesinden geri dönebilirsin.</p>
    <div class="modal-actions"><button type="button" data-close>Vazgeç</button><button type="submit" class="primary">Sınavı başlat</button></div>`, {
    onSubmit: (form) => {
      const v = form.pick.value;
      let id = v.startsWith('id:') ? v.slice(3) : '';
      if (!id) {
        const pool = cs.filter((c) => v !== 'bayern' || c.bundesland === 'Bayern');
        const examined = new Set(attempts().filter(isExam).map((a) => a.data.caseId));
        const fresh = pool.filter((c) => !examined.has(c.id));
        const from = fresh.length ? fresh : pool;
        id = from[Math.floor(Math.random() * from.length)]?.id;
      }
      if (!id) { C.toast('Uygun vaka bulunamadı.', 'info'); return false; }
      C.guard(() => startExam(id));
      return true;
    },
  });
}

function startExam(caseId) {
  if (!C.sync.user()) { C.toast('Sınav simülasyonu için giriş yapman gerekiyor.', 'info'); return; }
  const c = caseById(caseId);
  if (!c) throw new Error('Vaka bulunamadı.');
  const open = attempts().find((a) => isExam(a) && a.data.caseId === caseId && !a.data.report);
  if (open) { C.toast('Bu vakada yarım kalan sınavın açıldı.', 'info'); openAttempt(open.id); return; }
  const t = now();
  const rec = C.store.createFsp('attempt', {
    mode: 'exam', caseId, case: stripCase(c), level: 'pruefung',
    phase: 'prep', phaseStartedAt: t, phases: {}, startedAt: t,
    notes: '', brief: {}, konjunktiv: C.prefs.fspKonj !== false,
    m1: [{ role: 'model', text: c.greeting || 'Guten Tag.' }],
    m3: [{ role: 'model', text: oberarztHello(c.patient) }],
    oberarztDone: false, reports: {}, report: null,
  });
  openAttempt(rec.id);
}

/** Sınavdaki bir bölümü tek bölüm ekranlarının beklediği biçime çevirir. */
function examView(d, n) {
  const ph = d.phases?.[`t${n}`];
  return {
    ...d, part: n, messages: n === 1 ? d.m1 || [] : n === 3 ? d.m3 || [] : [], report: d.reports?.[n] || null,
    oberarztDone: n === 3 && d.oberarztDone, durationSec: ph ? ph.end - ph.start : 0,
  };
}

/** Esc / geri: sınav sürüyorsa onay ister. */
function leaveRun() {
  const a = current();
  if (isExam(a) && !a.data.report && ['prep', 't1', 't2', 't3'].includes(a.data.phase)) {
    if (ui.leaving) return;
    ui.leaving = true;
    C.confirmBox('Sınav devam ediyor. Çıkarsan süre işlemeye devam eder; Geçmiş sekmesinden geri dönebilirsin.', { ok: 'Sınavdan çık', danger: true, title: 'Sınavdan çıkılsın mı?' })
      .then((ok) => { if (ok && C.state.view === 'fsp-run' && ui.attemptId === a.id) showFsp(); })
      .finally(() => { ui.leaving = false; });
    return;
  }
  showFsp();
}

/** Sonraki aşamaya geçer. auto: süre doldu (onay sorulmaz). */
async function examAdvance(auto) {
  const a = current();
  if (!isExam(a) || a.data.report) return;
  const from = a.data.phase;
  const order = EXAM_PHASES.map(([k]) => k);
  const nextPh = order[order.indexOf(from) + 1];
  if (!EXAM_MIN[from] || !nextPh) return;
  if (!auto) {
    const msg = { t1: 'Teil 1 bitecek ve Teil 2 (Arztbrief) başlayacak. Hastayla görüşmeye geri dönemezsin.',
      t2: 'Arztbrief teslim edilecek ve Teil 3 (Oberarzt) başlayacak. Mektubu artık değiştiremezsin.',
      t3: 'Sınav bitecek ve üç bölüm sırayla değerlendirilecek.' }[from];
    if (msg && !(await C.confirmBox(msg, { ok: from === 't3' ? 'Sınavı bitir' : 'Devam', title: 'Emin misin?' }))) return;
  }
  if (ui.advancing) return;
  ui.advancing = true;
  try {
    flushSave();
    ui.rec?.stop();
    const cur = C.store.getFsp(a.id);
    if (!cur || cur.data.phase !== from || cur.data.report) return; // bu arada başka yoldan geçilmiş
    const t = now();
    C.store.updateFsp(a.id, { ...cur.data, phase: nextPh, phaseStartedAt: t, phases: { ...(cur.data.phases || {}), [from]: { start: cur.data.phaseStartedAt, end: t } } });
    if (auto) C.toast(`Süre doldu. ${nextPh === 'eval' ? 'Değerlendirme' : phaseLabel(nextPh)} başlıyor.`, 'info', 5000);
    C.stopSpeech?.();
    if (C.state.view === 'fsp-run' && ui.attemptId === a.id) { renderRun(); window.scrollTo(0, 0); }
    if (nextPh === 'eval') runExamEval();
  } finally {
    ui.advancing = false;
  }
}

const emptyReport = (n, why) => ({
  part: n, gesamt: 0, ergebnis: 'nicht bestanden', fazit: why, kategorien: [], fehlend: [], korrekturen: [], besser: [],
  staerken: [], vokabeln: [], uebung: [], abschnitte: [], at: now(), empty: true,
});

async function evalExamPart(d, n) {
  const v = examView(d, n);
  if (n === 2) {
    if (BRIEF.reduce((s, [k]) => s + wc(d.brief?.[k]), 0) < 15) return emptyReport(2, 'Arztbrief boş ya da çok kısa teslim edildi; bu bölüm 0 puan sayıldı.');
  } else if (v.messages.filter((m) => m.role === 'user').length < 2) {
    return emptyReport(n, 'Bu bölümde değerlendirilecek kadar konuşma yok; 0 puan sayıldı.');
  }
  const res = await C.sync.fspAi({
    action: 'evaluate', part: n, case: d.case, konjunktiv: !!d.konjunktiv, level: 'pruefung',
    ...(n === 2 ? { brief: d.brief } : { history: v.messages.map(({ role, text }) => ({ role, text })) }),
  }, 170_000);
  return res.report;
}

/** Üç bölümü sırayla değerlendirir; her sonuç hemen kaydedilir, böylece hata/çıkış sonrası kaldığı yerden sürer. */
async function runExamEval() {
  const id = ui.attemptId;
  if (ui.examEval || !id) return;
  ui.examEval = id;
  ui.examErr = '';
  const view = () => C.state.view === 'fsp-run' && ui.attemptId === id;
  try {
    for (const n of [1, 2, 3]) {
      const a = C.store.getFsp(id);
      if (!a || a.data.report) return;
      if (a.data.reports?.[n]) continue;
      ui.examNow = n;
      if (view()) renderRun();
      const rep = await evalExamPart(a.data, n);
      const cur = C.store.getFsp(id);
      if (!cur) return;
      C.store.updateFsp(id, { ...cur.data, reports: { ...(cur.data.reports || {}), [n]: rep } });
    }
    const cur = C.store.getFsp(id);
    if (!cur || cur.data.report) return;
    const t = now();
    C.store.updateFsp(id, { ...cur.data, report: mergedReport(cur.data), phase: 'done', finishedAt: t, durationSec: t - cur.data.startedAt });
    if (ui.attemptId === id) { clearInterval(ui.tick); ui.tick = null; }
    if (!view()) C.toast('Sınav değerlendirmen hazır (Geçmiş sekmesi).', 'success', 6000);
  } catch (e) {
    ui.examErr = e.message || String(e);
    C.toast(ui.examErr, 'error', 6000);
  } finally {
    ui.examEval = null;
    ui.examNow = 0;
    if (view()) { renderRun(); window.scrollTo(0, 0); }
  }
}

/* ---- sonuç hesabı */

const catName = (s) => String(s || '').replace(/\s*\(.*\)\s*$/, '').trim();
const CAT_TIPS = [
  ['grammatik', 'Her gün 10 dakika: Konjunktiv I, Perfekt/Präteritum ve yan cümlede fiilin sona gitmesi. Raporlardaki düzeltmeleri desteye ekleyip tekrar et.'],
  ['wortschatz', 'Her vakadan 10 Redemittel çıkar ve desteye ekle; aynı fiili tekrarlamak yerine angeben, berichten, schildern gibi eş anlamlıları kullan.'],
  ['medizinische fachsprache', 'Fachbegriff ↔ günlük dil çiftlerini çalış (Fachbegriffe sekmesi): hastaya günlük dil, Oberarzt’a terim.'],
  ['fachsprache', 'Fachbegriff ↔ günlük dil çiftlerini çalış (Fachbegriffe sekmesi): hastaya günlük dil, Oberarzt’a terim.'],
  ['flüssigkeit', 'Mikrofonla sesli cevap ver (Bayern soru bankası). Duraksamada “Lassen Sie mich kurz überlegen …” gibi kalıplar kullan.'],
  ['verständlichkeit', 'Kısa, tek bilgi taşıyan cümleler kur; önemli bilgiyi başa koy, ara ara özetle.'],
  ['gesprächsführung', 'Açık soruyla başla, kapalı sorularla netleştir; konu geçişlerini duyur (“Jetzt habe ich noch Fragen zu Ihren Medikamenten.”) ve sonunda özetle.'],
  ['vollständigkeit der anamnese', 'Sabit bir sıra ezberle: aktuelle Beschwerden (W-Fragen) → Vorerkrankungen → Medikamente → Allergien → Noxen → Sozial-/Familienanamnese. Hazırlıkta bu başlıkları notuna yaz.'],
  ['struktur', 'Fallvorstellung ve Arztbrief için aynı iskelet: Patient – Anlass – Anamnese – Befund – Verdacht – DD – Diagnostik – Therapie.'],
  ['medizinische plausibilität', 'Her vaka için Verdacht, iki DD, ileri tanı ve tedaviyi gerekçesiyle birer cümlede söylemeyi çalış (Kurs sekmesi).'],
  ['professionelle kommunikation', 'Empati kalıpları (“Ich verstehe Ihre Sorge …”), tutarlı Sie-Form ve kollegial ton; hastanın endişesini önce karşıla, sonra açıkla.'],
  ['indirekte rede', 'Konjunktiv I çekimi (er habe, sei, nehme) ve “Der Patient gab an, …” kalıplarını çalış.'],
  ['röntgenbefund', 'Befund kalıplarını çalış: “Im OPG zeigt sich eine periapikale Aufhellung an Zahn 36.”'],
  ['therapieplan', 'Therapieplan’ı adım adım ve Passiv ile yaz: “Es wird eine Wurzelkanalbehandlung durchgeführt.”'],
  ['anamnese', 'Teil 1 sırasında notları Arztbrief başlıklarına göre al; Arztbrief’te tam cümle ve dolaylı anlatım kullan.'],
  ['allgemeinanamnese', 'Vorerkrankungen, Medikamente (doz ile), Allergien ve Noxen’i eksiksiz ve tam cümleyle yaz.'],
];
const tipFor = (name) => {
  const n = catName(name).toLocaleLowerCase('de');
  return (CAT_TIPS.find(([k]) => n === k) || CAT_TIPS.find(([k]) => n.includes(k)) || [])[1]
    || 'Raporlardaki düzeltmeleri ve alıştırmaları tekrar et; aynı türde bir vakayı “Fortgeschritten” seviyesinde yeniden dene.';
};

function examSummary(d) {
  const reps = [1, 2, 3].map((n) => d.reports?.[n] || emptyReport(n, ''));
  const scores = reps.map((r) => r.gesamt);
  const gesamt = Math.round(scores[0] * EXAM_W[1] + scores[1] * EXAM_W[2] + scores[2] * EXAM_W[3]);
  const min = Math.min(...scores);
  // Tahmin kuralı: toplam ≥ 70 ve hiçbir bölüm 60'ın altında değil → bestanden; toplam ≥ 60 → knapp
  const ergebnis = gesamt >= 70 && min >= 60 ? 'bestanden' : gesamt >= 60 ? 'knapp' : 'nicht bestanden';
  const cats = new Map();
  reps.forEach((r, i) => (r.kategorien || []).forEach((k) => {
    const name = catName(k.name);
    if (!name) return;
    const e = cats.get(name) || { name, sum: 0, n: 0, parts: [] };
    e.sum += k.punkte; e.n++; e.parts.push(i + 1);
    cats.set(name, e);
  }));
  const kategorien = [...cats.values()].map((e) => ({ name: e.name, punkte: Math.round(e.sum / e.n), kommentar: `Teil ${e.parts.join(', ')}` }));
  // En önemli eksikler: her bölümün listesinden sırayla (model en önemlileri başa yazar)
  const top = [];
  const seen = new Set();
  for (let i = 0; top.length < 5 && i < 30; i++) {
    reps.forEach((r, j) => {
      const x = r.fehlend?.[i];
      if (x && top.length < 5 && !seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); top.push({ text: x, part: j + 1 }); }
    });
  }
  const weakest = [...kategorien].sort((a, b) => a.punkte - b.punkte).slice(0, 3);
  const tipps = weakest.map((k) => ({ name: k.name, punkte: k.punkte, tip: tipFor(k.name) }));
  const lowPart = scores.indexOf(min) + 1;
  if (min < 60) tipps.unshift({ name: PARTS[lowPart].label, punkte: min, tip: `En zayıf bölümün ${PARTS[lowPart].label}. Bu bölümü tek başına ${lowPart === 2 ? 'birkaç vakayla' : '“Fortgeschritten” seviyesinde'} tekrar çalış; gerçek sınavda tek bir zayıf bölüm sonucu düşürebilir.` });
  return { reps, scores, gesamt, ergebnis, kategorien, top, tipps };
}

/** Sınavın birleşik raporu: data.report biçimiyle uyumlu (geçmiş, istatistik ve diğer modüller için). */
function mergedReport(d) {
  const s = examSummary(d);
  const all = (f) => s.reps.flatMap((r) => r[f] || []);
  const vok = [];
  all('vokabeln').forEach((v) => { if (!vok.some((x) => x.de === v.de)) vok.push(v); });
  return {
    part: 0, exam: true, gesamt: s.gesamt, ergebnis: s.ergebnis,
    fazit: `Tam sınav (tahmin): Teil 1 ${s.scores[0]} · Teil 2 ${s.scores[1]} · Teil 3 ${s.scores[2]}.`,
    teile: { 1: s.scores[0], 2: s.scores[1], 3: s.scores[2] }, gewichte: EXAM_W,
    kategorien: s.kategorien, fehlend: all('fehlend'), korrekturen: all('korrekturen'), besser: all('besser'),
    staerken: all('staerken'), vokabeln: vok.slice(0, 30), uebung: all('uebung'), abschnitte: [], at: now(),
  };
}

/* ---- ekranlar */

function renderExam() {
  const a = current();
  const d = a.data;
  const c = d.case;
  const p = c.patient || {};
  const ph = d.report ? 'done' : d.phase;
  const idx = EXAM_PHASES.findIndex(([k]) => k === ph);
  const btn = { prep: 'Teil 1’e başla →', t1: 'Teil 1’i bitir →', t2: 'Arztbrief’i teslim et →', t3: 'Sınavı bitir ve değerlendir' }[ph];
  const head = `
    <header class="deck-head fsp-run-head">
      <button class="icon-btn head-btn" data-f="back" title="Vakalara dön (Esc)" aria-label="Vakalara dön">${C.ICON.back}</button>
      <div class="deck-title"><h1>Prüfungssimulation</h1>
        <div class="sub">${esc(p.name)}${p.age ? `, ${p.age}` : ''} · ${phaseLabel(ph)}${EXAM_MIN[ph] ? ` · ${EXAM_MIN[ph]} dk` : ''}</div></div>
      <div class="head-actions">
        ${btn ? `<span class="fsp-clock" id="fsp-clock"></span><button class="primary" data-f="exam-next">${btn}</button>` : ''}
        ${ph === 'done' ? '<button data-f="exam-again">↻ Yeni sınav</button>' : ''}
      </div>
    </header>
    <ol class="fx-steps">${EXAM_PHASES.map(([k, l], i) => `<li class="${i < idx ? 'done' : i === idx ? 'on' : ''}"><span>${i + 1}</span>${l}</li>`).join('')}</ol>`;
  let body;
  if (ph === 'prep') body = prepHtml(d);
  else if (ph === 't1') body = chatHtml(examView(d, 1));
  else if (ph === 't2') body = briefHtml(examView(d, 2));
  else if (ph === 't3') body = chatHtml(examView(d, 3));
  else if (ph === 'eval') body = evalHtml(d);
  else body = examResultHtml(d);
  const pcls = { t1: 'fsp-p1', t2: 'fsp-p2', t3: 'fsp-p3' }[ph] || '';
  C.main.innerHTML = `<div class="page fsp-run fx-exam fx-${ph} ${pcls} ${d.report ? 'has-report' : ''}">${head}${body}</div>`;
  tickClock();
  if (ph === 't1' || ph === 't3') scrollChat();
}

function prepHtml(d) {
  const c = d.case;
  const p = c.patient || {};
  return `<div class="fsp-split">
    <section class="panel fx-prep">
      <h3>Anamnesebogen</h3>
      <dl class="fx-form">
        <dt>Name</dt><dd>${esc(p.name) || '—'}</dd>
        <dt>Alter</dt><dd>${p.age ? `${p.age} Jahre` : '—'}</dd>
        <dt>Vorstellungsgrund</dt><dd>${esc(c.complaint) || '—'}</dd>
        <dt>Röntgen / Befund</dt><dd class="fsp-xray">${esc(c.xray) || '—'}</dd>
      </dl>
      <div class="fx-prep-tips">
        <b>Hazırlıkta yapılacaklar</b>
        <ul>
          <li>Anamnez başlıklarını sırayla not al (Beschwerden, Vorerkrankungen, Medikamente, Allergien, Noxen, Sozial/Familie).</li>
          <li>Röntgen bulgusunu Almanca bir cümleyle söylemeyi dene; olası Verdacht ve DD’leri düşün.</li>
          <li>Hastanın sorabileceği soruları ve günlük dildeki açıklamalarını not et.</li>
        </ul>
        <p class="muted">Teil 1’de ipucu paneli yok; Teil 2’de konuşma kaydı değil, yalnızca bu notlar görünür.</p>
      </div>
    </section>
    <aside class="fsp-side"><section class="panel fsp-side-card"><h3>Notlar</h3>
      <textarea id="fsp-notes" rows="16" placeholder="Hazırlık notların (sınav boyunca görünür)">${esc(d.notes || '')}</textarea></section></aside>
  </div>`;
}

/** Sınavda yan panel: yalnızca form bilgisi, (Teil 2'den itibaren) röntgen ve notlar. Leitfaden ve Teil 1 kaydı yok. */
function examSideHtml(v) {
  const c = v.case;
  const p = c.patient || {};
  const blocks = [`<section class="panel fsp-side-card"><h3>Anamnesebogen</h3>
    <dl><dt>Patient</dt><dd>${esc(p.name)}${p.age ? `, ${p.age} J.` : ''}</dd><dt>Anlass</dt><dd>${esc(c.complaint)}</dd></dl></section>`];
  if (v.part >= 2 && c.xray) blocks.push(`<section class="panel fsp-side-card"><h3>Röntgen / klinik bulgu</h3><p class="fsp-xray">${esc(c.xray)}</p></section>`);
  if (v.part === 3 && BRIEF.some(([k]) => v.brief?.[k])) {
    blocks.push(`<details class="panel fsp-side-card"><summary><b>Arztbrief’in</b></summary>${BRIEF.map(([k, label]) => (v.brief?.[k] ? `<h4>${label}</h4><p class="fsp-pre">${esc(v.brief[k])}</p>` : '')).join('')}</details>`);
  }
  blocks.push(`<section class="panel fsp-side-card"><h3>Notlar</h3><textarea id="fsp-notes" rows="${v.part === 2 ? 12 : 8}" placeholder="${v.part === 1 ? 'Not al — Teil 2 ve 3’te yalnızca bu notlar görünür' : 'Notların'}">${esc(v.notes || '')}</textarea></section>`);
  return `<aside class="fsp-side">${blocks.join('')}</aside>`;
}

function evalHtml(d) {
  const st = (n) => {
    const r = d.reports?.[n];
    if (r) return `<span class="sc ${scoreClass(r.gesamt)}">${r.gesamt}</span>`;
    if (ui.examEval && ui.examNow === n) return '<span class="fx-spin" aria-hidden="true"></span><span class="muted">değerlendiriliyor…</span>';
    return '<span class="muted">bekliyor</span>';
  };
  return `<section class="panel fx-eval">
    <h3>Değerlendirme</h3>
    <p class="muted">Üç bölüm sırayla değerlendiriliyor; her biri 30–90 saniye sürebilir. Bu ekrandan çıkabilirsin, değerlendirme kaydedilir.</p>
    <ul class="fx-eval-list">${[1, 2, 3].map((n) => `<li><span>${C.ICON[PARTS[n].icon]}${PARTS[n].label}</span>${st(n)}</li>`).join('')}</ul>
    ${!ui.examEval ? `<div class="fx-eval-err">${ui.examErr ? `<p class="muted">${esc(ui.examErr)}</p>` : ''}<button class="primary" data-f="exam-retry">Değerlendirmeyi ${ui.examErr ? 'tekrar dene' : 'sürdür'}</button></div>` : ''}
  </section>`;
}

function examResultHtml(d) {
  const s = examSummary(d);
  const durs = (n) => { const ph = d.phases?.[`t${n}`]; return ph ? fmtClock(ph.end - ph.start) : '—'; };
  return `<div class="fsp-report fx-result">
    <section class="panel fr-top">
      <div class="fr-score ${scoreClass(s.gesamt)}"><b>${s.gesamt}</b><span>/100</span></div>
      <div class="fr-sum"><h2 class="fx-result-h">Prüfungsergebnis</h2>
        <span class="fr-res ${scoreClass(s.gesamt)}">${esc(s.ergebnis)}</span> <span class="fx-guess">tahmin</span>
        <p class="muted fx-disclaimer">Bu sonuç yapay zekâ değerlendirmesine dayanan bir <b>tahmindir</b>; gerçek sınavın kararını vermez. Ağırlıklı toplam: Teil 1 %${EXAM_W[1] * 100}, Teil 2 %${EXAM_W[2] * 100}, Teil 3 %${EXAM_W[3] * 100}. “bestanden” tahmini için toplam ≥ 70 ve her bölüm ≥ 60 aranır.</p>
        <span class="muted fr-meta">${d.durationSec ? `Toplam süre ${fmtClock(d.durationSec)} · ` : ''}${esc(d.case?.title || '')} · ${dateStr(d.report?.at || now())}</span></div>
    </section>
    <section class="fx-parts">${[1, 2, 3].map((n) => {
      const r = s.reps[n - 1];
      return `<div class="panel fx-part"><span class="fx-part-l">${C.ICON[PARTS[n].icon]}${PARTS[n].label}</span>
        <b class="sc ${scoreClass(r.gesamt)}">${r.gesamt}</b>
        <span class="muted">${esc(r.ergebnis)} · ağırlık %${EXAM_W[n] * 100} · süre ${durs(n)}</span>
        ${r.fazit ? `<p>${esc(r.fazit)}</p>` : ''}</div>`;
    }).join('')}</section>
    ${s.kategorien.length ? `<section class="panel fr-cats"><h3 class="fx-sec-h">Kategori ortalamaları</h3>${s.kategorien.map((k) => `
      <div class="fr-cat"><div class="fr-cat-h"><b>${esc(k.name)}</b><span class="sc ${scoreClass(k.punkte)}">${k.punkte}</span></div>
        <div class="fr-bar"><i class="${scoreClass(k.punkte)}" style="width:${k.punkte}%"></i></div>
        <p class="muted">${esc(k.kommentar)}</p></div>`).join('')}</section>` : ''}
    ${s.top.length ? `<section class="panel"><h3>En önemli 5 eksik</h3><ol class="fx-top">${s.top.map((x) => `<li><span>${esc(x.text)}</span> <span class="badge">Teil ${x.part}</span></li>`).join('')}</ol></section>` : ''}
    ${s.tipps.length ? `<section class="panel"><h3>Gelişim önerileri</h3><ul class="fx-tips">${s.tipps.map((t) => `<li><b>${esc(t.name)}</b> <span class="sc ${scoreClass(t.punkte)}">${t.punkte}</span><p>${esc(t.tip)}</p></li>`).join('')}</ul></section>` : ''}
    <h3 class="fsp-h">Bölüm raporları</h3>
    ${[1, 2, 3].map((n) => {
      const v = examView(d, n);
      return v.report ? `<details class="panel fx-part-rep"><summary><b>${PARTS[n].label}</b> <span class="sc ${scoreClass(v.report.gesamt)}">${v.report.gesamt}</span></summary>${reportHtml(v, n)}</details>` : '';
    }).join('')}
    ${d.notes ? `<details class="panel"><summary><b>Notların</b></summary><p class="fsp-pre">${esc(d.notes)}</p></details>` : ''}
  </div>`;
}

/* ------------------------------------------------------------------ yeni vaka (yapay zekâ) */

function newCaseModal() {
  if (!C.sync.user()) { C.toast('Vaka üretmek için giriş yapman gerekiyor.', 'info'); return; }
  C.openModal(`
    <h2>Yeni vaka oluştur</h2>
    <p class="muted" style="font-size:13px">Yapay zekâ sana özel, uydurma kişilerle yeni bir sınav vakası hazırlar. İstersen sınava girenlerin anlattığı bir vakanın notlarını da yapıştırabilirsin; vaka buna göre kurulur.</p>
    <label>Alan<select name="fach"><option value="">Rastgele</option>${FACH.map((f) => `<option>${f}</option>`).join('')}</select></label>
    <label>Notlar <small>(isteğe bağlı)</small><textarea name="hint" rows="6" maxlength="6000" placeholder="Ör. 60 yaşında hasta, 18 numarada zonklayan ağrı, Marcumar kullanıyor, penisilin alerjisi…"></textarea></label>
    <div class="modal-actions"><button type="button" data-close>Vazgeç</button><button type="submit" class="primary">Oluştur</button></div>`, {
    onSubmit: (form) => {
      const fach = form.fach.value;
      const hint = form.hint.value.trim();
      const wait = C.toast('Vaka hazırlanıyor… (20–60 sn)', 'info', 120_000);
      C.sync.fspAi({ action: 'case', fachgebiet: fach, hint }, 120_000)
        .then((res) => {
          const rec = C.store.createFsp('case', { ...res.case, createdBy: 'ai' });
          C.toast(`Yeni vaka hazır: ${res.case.patient?.name || ''}`, 'success');
          if (C.state.view === 'fsp') { ui.tab = 'cases'; ui.fach = ''; renderHub(); }
          return rec;
        })
        .catch((e) => C.toast(e.message || String(e), 'error', 6000))
        .finally(() => wait.remove());
    },
  });
}

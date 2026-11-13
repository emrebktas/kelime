import { initKurs, kursHtml, mountKurs } from './kurs.js';
// Fachsprachprüfung (FSP) Zahnmedizin: hasta görüşmesi (Teil 1), Arztbrief (Teil 2), Arzt-Arzt-Gespräch (Teil 3),
// değerlendirme, Fachbegriffe ve rehber. Yapay zekâ sunucudaki fsp-ai fonksiyonundan (Gemini) gelir.
// app.js bu modüle ortak yardımcıları initFsp(ctx) ile verir.

let C = null; // app.js'ten gelen yardımcılar
let content = null; // { cases, guide }
const ui = { tab: 'cases', fach: '', termQ: '', termKat: '', attemptId: null, pending: false, tick: null, rec: null, saveT: null,
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

export function initFsp(ctx) {
  C = ctx;
  initKurs(ctx);
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
const caseById = (id) => allCases().find((c) => c.id === id) || null;
const attempts = () => C.store.listFsp('attempt');
const attemptsOf = (caseId, part) => attempts().filter((a) => a.data.caseId === caseId && (!part || a.data.part === part));
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
  const tabs = [['cases', 'tooth', 'Vakalar'], ...(content.bayern ? [['bayern', 'pin', 'Bayern']] : []), ['kurs', 'doc', 'Kurs'], ['history', 'chart', 'Geçmiş'],
    ['terms', 'book', 'Fachbegriffe'], ['guide', 'compass', 'Rehber']];
  C.main.innerHTML = `
    <div class="page fsp-page">
      <header class="deck-head">
        <button class="icon-btn head-btn" data-act="home" title="Ana sayfaya dön (Esc)" aria-label="Ana sayfaya dön">${C.ICON.home}</button>
        <div class="deck-title">
          <h1>FSP Zahnmedizin</h1>
          <div class="sub">Fachsprachprüfung · Hasta görüşmesi, Arztbrief, Arzt-Arzt-Gespräch</div>
        </div>
        ${ui.tab === 'cases' ? '<button class="primary" data-f="new-case">✦ Yeni vaka (AI)</button>' : ''}
      </header>
      <div class="seg tabs fsp-tabs" role="tablist">${tabs.map(([k, ic, l]) => `<button type="button" role="tab" data-f="tab" data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${C.ICON[ic]}${l}</button>`).join('')}</div>
      <div id="fsp-body">${{ cases: casesHtml, bayern: bayernHtml, kurs: kursHtml, history: historyHtml, terms: termsHtml, guide: guideHtml }[ui.tab]()}</div>
    </div>`;
  if (ui.tab === 'kurs') { C.guard(mountKurs); return; }
  if (!C.sync.user()) {
    C.$('#fsp-body').insertAdjacentHTML('afterbegin', '<div class="panel fsp-note">Simülasyon ve değerlendirme yapay zekâyla çalışır; kullanmak için <button class="linkish" data-act="account">giriş yap</button>. Fachbegriffe ve rehber girişsiz de açık.</div>');
  }
}

function casesHtml() {
  const list = allCases().filter((c) => !ui.fach || (ui.fach === 'Bayern' ? c.bundesland === 'Bayern' : c.fachgebiet === ui.fach));
  const fachs = [...new Set(allCases().map((c) => c.fachgebiet))];
  return `
    <div class="chips">${['', ...(content.bayern ? ['Bayern'] : []), ...fachs].map((f) => `<button type="button" class="chip ${ui.fach === f ? 'on' : ''} ${f === 'Bayern' ? 'chip-by' : ''}" data-f="fach" data-fach="${esc(f)}">${f ? esc(f) : 'Tümü'}</button>`).join('')}</div>
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
      </article>`;
}

function historyHtml() {
  const list = attempts();
  if (!list.length) return '<div class="panel empty">Henüz deneme yok. Bir vaka seçip başla.</div>';
  const done = list.filter((a) => a.data.report);
  const avg = (part) => {
    const s = done.filter((a) => a.data.part === part).map((a) => a.data.report.gesamt);
    return s.length ? Math.round(s.reduce((x, y) => x + y, 0) / s.length) : null;
  };
  return `
    <div class="fsp-stats">${[1, 2, 3].map((n) => {
      const a = avg(n);
      return `<div class="stat-card"><span class="stat-label">${PARTS[n].label}</span><b class="stat-big">${a ?? '—'}</b><span class="muted">${done.filter((x) => x.data.part === n).length} değerlendirme · ortalama</span></div>`;
    }).join('')}</div>
    <div class="fsp-hist">${list.map((a) => {
      const d = a.data;
      const r = d.report;
      return `<div class="fh-row">
        <button class="fh-open" data-f="open" data-attempt="${a.id}">
          <span class="fh-title">${esc(d.case?.patient?.name || '')} · ${esc(d.case?.title || '')}</span>
          <span class="fh-meta"><span class="badge">${PARTS[d.part].label}</span><span class="muted">${dateStr(a.created_at)}</span>
            ${r ? `<span class="sc ${scoreClass(r.gesamt)}">${r.gesamt}</span><span class="muted">${esc(r.ergebnis)}</span>` : '<span class="fh-open-tag">devam ediyor</span>'}</span>
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
      ? [{ role: 'model', text: `Guten Tag, Frau Kollegin, Herr Kollege. Sie haben heute ${p.name ? p.name.replace(/^Herr /, 'Herrn ') : 'den Patienten'} gesehen. Bitte stellen Sie mir den Fall vor.` }]
      : [];
  // Teil 2 ve 3 için aynı vakanın son Teil 1 notları ve konuşması bilgi olarak taşınır
  const prev = attemptsOf(caseId, 1)[0]?.data;
  const rec = C.store.createFsp('attempt', {
    caseId, part, case: stripCase(c), messages: first, brief: {}, notes: prev?.notes || '',
    konjunktiv: C.prefs.fspKonj !== false, startedAt: now(), report: null,
  });
  openAttempt(rec.id);
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
  C.setTitle(PARTS[a.data.part].label);
  renderRun();
  if (!a.data.report) ui.tick = setInterval(tickClock, 1000);
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
  const d = a.data;
  const c = d.case;
  const p = c.patient || {};
  const head = `
    <header class="deck-head fsp-run-head">
      <button class="icon-btn head-btn" data-f="back" title="Vakalara dön (Esc)" aria-label="Vakalara dön">${C.ICON.back}</button>
      <div class="deck-title"><h1>${esc(p.name)}${p.age ? `, ${p.age}` : ''}</h1>
        <div class="sub">${PARTS[d.part].label} · ${esc(c.fachgebiet)}</div></div>
      <div class="head-actions">
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
        ${d.oberarztDone ? '<div class="fm-end">Oberarzt görüşmeyi bitirdi. Şimdi “Bitir ve değerlendir”e bas.</div>' : ''}
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
    ${sideHtml(d)}
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
    ${sideHtml(d)}
  </div>`;
}

const wc = (s) => (String(s || '').trim().match(/\S+/g) || []).length;

function reportHtml(d) {
  const r = d.report;
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
    ${r.vokabeln.length ? `<section class="panel"><div class="sec-head"><h3>Faydalı kelimeler</h3><button data-f="vocab-all">＋ Hepsini “${DECK_NAME}” destesine ekle</button></div>
      <div class="fsp-terms">${r.vokabeln.map((v, i) => `<div class="ft-row"><div class="ft-fach"><b>${esc(v.de)}</b><button class="icon-btn ft-say" data-f="say" data-text="${esc(v.de)}" aria-label="Seslendir">${C.ICON.speaker}</button></div><div class="ft-tr muted">${esc(v.tr)}</div><button class="icon-btn" data-f="vocab-add" data-i="${i}" title="Desteye ekle" aria-label="Desteye ekle">＋</button></div>`).join('')}</div></section>` : ''}
    ${ref}
  </div>`;
}

/* ------------------------------------------------------------------ süre */

function tickClock() {
  const el = document.getElementById('fsp-clock');
  const a = current();
  if (!el || !a || a.data.report) return;
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
  const d = { ...a.data, messages: [...a.data.messages] };
  if (text) d.messages.push({ role: 'user', text, at: now() });
  saveAttempt(d);
  ui.pending = true;
  renderRun();
  try {
    const res = await C.sync.fspAi({ action: d.part === 1 ? 'patient' : 'oberarzt', case: d.case, history: d.messages.map(({ role, text: t }) => ({ role, text: t })) }, 60_000);
    const cur = current();
    if (!cur || cur.id !== a.id) return;
    const next = { ...cur.data, messages: [...cur.data.messages, { role: 'model', text: res.reply, at: now() }] };
    if (res.done) next.oberarztDone = true;
    saveAttempt(next);
    if (C.prefs.fspVoice !== false) C.speak(res.reply, 'de');
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
      case 'back': showFsp(); break;
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
      case 'vocab-add': { const v = current().data.report.vokabeln[Number(el.dataset.i)]; addCards([{ word: v.de, translation: v.tr }]); break; }
      case 'vocab-all': addCards(current().data.report.vokabeln.map((v) => ({ word: v.de, translation: v.tr }))); break;
      default: break;
    }
  });
}

function onChange(e) {
  const el = e.target.closest('[data-f]');
  if (!el || !C.main.contains(el)) return;
  if (el.dataset.f === 'voice') { C.prefs.fspVoice = el.checked; C.savePrefs(); if (!el.checked) C.stopSpeech?.(); }
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
  if (C.state.view === 'fsp-run') { showFsp(); return true; }
  if (C.state.view === 'fsp') { C.showHome(); return true; }
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

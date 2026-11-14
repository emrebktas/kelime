// FSP öğrenme merkezi: Lernplan & ilerleme paneli, Krankheitsbilder kütüphanesi, Anamnese-Trainer
// (soru kalıpları, sesli tekrar, Umgangssprache → Fachsprache, Aufklärung ve Arztbrief alıştırmaları) ve başvuru (Nachschlagen).
// fsp.js bu modüle ctx'i initLearn(ctx) ile verir; olaylar ctx.main üzerinde `data-lx` önekiyle dinlenir.
// Beklenen ek ctx alanları: getStudy() (gizli paket ya da null), loadTraining() (fsp-training.json),
// startCase(caseObj, part), goTab(tab, sub).

let C = null;
const L = {
  sub: 'panel',
  study: undefined, // getStudy() sonucu (null = paket yok)
  training: undefined,
  guide: undefined,
  bayern: undefined,
  // Krankheitsbilder
  kr: { q: '', fach: '', fav: false, sel: null }, // sel: { type: 'd'|'r', id }
  quiz: null, // { id, answers: { [qi]: seçilen } }
  // Anamnese
  an: { sec: 'fragen', sit: '', checked: {}, drill: null, umg: null, sel: null, text: '', check: null, warn: [], revealed: false },
  // Nachschlagen
  ns: { tab: 'abkuerzungen', q: '' },
  pending: false,
  rec: null,
  noteT: null,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const DECK = 'FSP Kurs';
const arr = (x) => (Array.isArray(x) ? x : []);
const scoreClass = (n) => (n >= 70 ? 'good' : n >= 60 ? 'mid' : 'bad');
const avgOf = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);
const DAY = 86400000;

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const dayStart = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const dayOfYear = (d = new Date()) => Math.floor((dayStart(d) - new Date(d.getFullYear(), 0, 1)) / DAY);
const fmtDate = (sec) => new Date(sec * 1000).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });

function say(text) {
  if (!text) return '';
  return `<button type="button" class="icon-btn lx-say" data-lx="say" data-text="${esc(text)}" title="Seslendir" aria-label="Seslendir">${C.ICON.speaker}</button>`;
}
function srcBadge(src) {
  if (!src) return '';
  return src === 'kurs' ? '<span class="lx-src kurs" title="Kurs scriptinden">Kurs</span>' : '<span class="lx-src ek" title="Kursta yok; genel bilgiyle eklendi">Ek</span>';
}
const root = () => document.getElementById('lx-root');

/* ------------------------------------------------------------------ giriş */

export function initLearn(ctx) {
  C = ctx;
  C.main.addEventListener('click', onClick);
  C.main.addEventListener('input', onInput);
  C.main.addEventListener('change', onChange);
  // Enter ile kontrol (tek satırlık Umgangssprache alanı)
  C.main.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.target?.id !== 'lx-umg-in') return;
    e.preventDefault();
    root()?.querySelector(L.an.umg?.res ? '[data-lx="umg-next"]' : '[data-lx="umg-check"]')?.click();
  });
}

export function learnHtml(sub) {
  L.sub = ['panel', 'krankheiten', 'anamnese', 'nachschlagen'].includes(sub) ? sub : 'panel';
  return `<div id="lx-root" class="lx" data-sub="${L.sub}"><div class="muted">Yükleniyor…</div></div>`;
}

export async function mountLearn(sub) {
  if (sub) L.sub = sub;
  stopMic();
  await loadData();
  render();
}

/** Esc / geri tuşu: açık detay ya da alıştırma varsa kapatır ve true döner. */
export function learnBack() {
  if (L.sub === 'krankheiten' && L.kr.sel) { L.kr.sel = null; L.quiz = null; render(); return true; }
  if (L.sub === 'anamnese' && (L.an.sel || L.an.drill || L.an.umg)) { resetAnTask(); L.an.drill = null; L.an.umg = null; render(); return true; }
  return false;
}

async function loadData() {
  const tasks = [];
  {
    // Paket sonradan yüklenebilir: her açılışta yeniden sorulur (getStudy önbelleği ana modülde)
    tasks.push(Promise.resolve().then(() => C.getStudy?.()).then((s) => { L.study = s || null; }).catch(() => { L.study = null; }));
  }
  if (L.training == null && L.sub === 'nachschlagen') {
    tasks.push(Promise.resolve().then(() => C.loadTraining?.()).then((t) => { L.training = t || null; }).catch(() => { L.training = null; }));
  }
  if (L.guide === undefined && L.sub === 'anamnese') {
    tasks.push(fetch('content/fsp-guide.json').then((r) => (r.ok ? r.json() : null)).then((g) => { L.guide = g; }).catch(() => { L.guide = null; }));
  }
  if (L.bayern === undefined && L.sub === 'panel') {
    tasks.push(fetch('content/fsp-bayern.json').then((r) => (r.ok ? r.json() : null)).then((b) => { L.bayern = b; }).catch(() => { L.bayern = null; }));
  }
  await Promise.all(tasks);
}

const diseases = () => arr(L.study?.diseases);
const risks = () => arr(L.study?.risks);

function render() {
  const el = root();
  if (!el) return;
  el.dataset.sub = L.sub;
  const fn = { panel: panelHtml, krankheiten: krHtml, anamnese: anHtml, nachschlagen: nsHtml }[L.sub];
  el.innerHTML = fn();
}

function emptyHtml(title, text) {
  return `<section class="panel lx-empty"><h3>${esc(title)}</h3><p class="muted">${text}</p></section>`;
}
const NO_STUDY = 'Bu bölüm kişiye özel kurs paketindeki çalışma verisini kullanır. <b>Kurs</b> sekmesinden kurs paketini içe aktar ya da paylaşım koduyla bir kursa katıl; ardından burası dolar.';

/* ================================================================== PANEL: Lernplan & Fortschritt */

const attempts = () => { try { return C.store.listFsp('attempt'); } catch { return []; } };
const reported = () => attempts().filter((a) => a.data?.report && typeof a.data.report.gesamt === 'number');
const fspDecks = () => arr(C.state.decks).filter((d) => /fsp/i.test(d.name || ''));
const deckDue = (d) => (d.new || 0) + (d.learn || 0) + (d.review || 0);
const examDate = () => (C.prefs.fspExamDate ? new Date(`${C.prefs.fspExamDate}T00:00:00`) : null);
const goalMin = () => Math.max(10, Math.min(600, Number(C.prefs.fspDailyMin) || 60));
const knownSet = () => new Set(arr(C.prefs.fspKnown));

function daysLeft() {
  const d = examDate();
  if (!d || Number.isNaN(d.getTime())) return null;
  return Math.round((dayStart(d) - dayStart()) / DAY);
}

function vocabStats() {
  let total = 0; let learned = 0;
  for (const d of fspDecks()) {
    try {
      const st = C.store.getDeckStats(d.id);
      total += st.total;
      learned += st.young + st.mature;
    } catch { /* erişilemeyen deste */ }
  }
  return { total, learned };
}

function categoryAverages() {
  const m = new Map();
  for (const a of reported()) {
    for (const k of arr(a.data.report.kategorien)) {
      if (!k?.name || typeof k.punkte !== 'number') continue;
      if (!m.has(k.name)) m.set(k.name, []);
      m.get(k.name).push(k.punkte);
    }
  }
  return [...m.entries()].map(([name, s]) => ({ name, avg: avgOf(s), n: s.length })).sort((a, b) => a.avg - b.avg);
}

function readiness() {
  const reps = reported().sort((a, b) => b.created_at - a.created_at);
  const last5 = avgOf(reps.slice(0, 5).map((a) => a.data.report.gesamt)) ?? 0;
  const bank = arr(L.bayern?.questions);
  const k = knownSet();
  const cover = bank.length ? Math.round((100 * bank.filter((q) => k.has(q.id)).length) / bank.length) : Math.min(100, k.size);
  const v = vocabStats();
  const vocab = v.total ? Math.round((100 * v.learned) / v.total) : 0;
  const fachs = new Set(reps.map((a) => a.data.case?.fachgebiet).filter(Boolean));
  const target = Math.max(5, new Set(diseases().map((d) => d.fach).filter(Boolean)).size || 8);
  const variety = Math.min(100, Math.round((100 * fachs.size) / target));
  const total = Math.round(0.5 * last5 + 0.2 * cover + 0.15 * vocab + 0.15 * variety);
  return { total, last5, cover, vocab, variety, n: Math.min(5, reps.length), fachs: fachs.size, target };
}

/** Bugünkü görevleri üretir. Her görev: { key, title, detail, done, auto }. */
function todayTasks() {
  const tk = todayKey();
  const marks = C.prefs.fspTasks?.[tk] || {};
  const all = attempts();
  const doy = dayOfYear();
  const out = [];

  // 1) Vaka simülasyonu: en az çalışılan / en zayıf alan
  const ds = diseases().filter((d) => d.sim);
  const fachList = [...new Set(ds.map((d) => d.fach).filter(Boolean))];
  const stat = (f) => {
    const xs = all.filter((a) => a.data?.case?.fachgebiet === f);
    return { n: xs.length, avg: avgOf(xs.map((a) => a.data.report?.gesamt).filter((x) => typeof x === 'number')) ?? 0 };
  };
  const weakFach = fachList.map((f) => ({ f, ...stat(f) })).sort((a, b) => a.n - b.n || a.avg - b.avg)[0]?.f || '';
  const partCount = [1, 2, 3].map((p) => all.filter((a) => a.data?.part === p).length);
  const part = partCount.indexOf(Math.min(...partCount)) + 1;
  const pool = ds.filter((d) => d.fach === weakFach);
  const dis = pool.find((d) => !all.some((a) => a.data?.caseId === `kb-${d.id}`)) || pool[doy % Math.max(1, pool.length)] || null;
  const caseDoneToday = all.some((a) => a.data?.report && dayStart(new Date(a.created_at * 1000)).getTime() === dayStart().getTime());
  out.push({
    key: 'case',
    title: dis ? `Vaka simülasyonu: ${dis.title_de} (Teil ${part})` : 'Bir vaka simülasyonu çöz',
    detail: dis ? `En az çalıştığın alan: ${weakFach}` : 'Vakalar sekmesinden bir vaka seç',
    data: dis ? { id: dis.id, part } : null,
    done: !!marks.case || caseDoneToday,
    auto: caseDoneToday,
  });

  // 2) Teil 3 soruları
  const bank = arr(L.bayern?.questions);
  const k = knownSet();
  const open = bank.filter((q) => !k.has(q.id)).length;
  const n = Math.max(3, Math.min(15, Math.round(goalMin() / 6)));
  out.push({
    key: 'teil3',
    title: `${bank.length ? Math.min(n, open || n) : n} Teil 3 sorusu çalış`,
    detail: bank.length ? `Soru bankasında ${open} / ${bank.length} soru henüz “bildim” değil` : 'Bayern soru bankası',
    done: !!marks.teil3,
  });

  // 3) Kelime tekrarı
  const decks = fspDecks();
  const due = decks.reduce((s, d) => s + deckDue(d), 0);
  const top = [...decks].sort((a, b) => deckDue(b) - deckDue(a))[0];
  out.push({
    key: 'vocab',
    title: decks.length ? `Kelime tekrarı: ${due} kart bekliyor` : 'Kelime tekrarı',
    detail: decks.length ? decks.map((d) => `${d.name} (${deckDue(d)})`).join(' · ') : 'Henüz FSP destesi yok; Krankheitsbilder’den Fachbegriffe ekleyebilirsin',
    data: top ? { deck: top.id } : null,
    done: !!marks.vocab || (decks.length > 0 && due === 0),
    auto: decks.length > 0 && due === 0,
  });

  // 4) Arztbrief ya da Aufklärung (gün gün dönüşümlü)
  const briefe = arr(L.study?.briefe);
  const aufk = arr(L.study?.aufklaerung);
  const useBrief = briefe.length && (doy % 2 === 0 || !aufk.length);
  const item = useBrief ? briefe[doy % briefe.length] : aufk.length ? aufk[doy % aufk.length] : null;
  out.push({
    key: 'write',
    title: item ? (useBrief ? `Arztbrief yaz: ${item.title || item.id}` : `Aufklärung: ${item.title_de}`) : 'Bir Arztbrief ya da Aufklärung metni yaz',
    detail: item ? (useBrief ? 'Notlardan tam Arztbrief' : item.aufgabe_tr || 'Hastaya günlük dille anlat') : 'Kurs paketi yüklenince görev seçilir',
    data: item ? { sec: useBrief ? 'brief' : 'aufkl', id: item.id } : null,
    done: !!marks.write,
  });

  // 5) Risikopatient kartı
  const quiz = C.prefs.fspQuiz || {};
  const rs = risks();
  const unscored = rs.filter((x) => !quiz[x.id]);
  const rk = unscored.length ? unscored[doy % unscored.length] : [...rs].sort((a, b) => quiz[a.id].last - quiz[b.id].last)[0];
  out.push({
    key: 'risk',
    title: rk ? `Risikopatient: ${rk.title_de}` : 'Bir Risikopatient kartı çalış',
    detail: rk ? (quiz[rk.id] ? `Son quiz: %${quiz[rk.id].last}` : 'Henüz quiz çözülmedi') : 'Kurs paketi yüklenince kart seçilir',
    data: rk ? { id: rk.id } : null,
    done: !!marks.risk,
  });
  return out;
}

const FOCUS = [
  ['Teil 1 · Anamnese', 'Anamnez soruları + 1 hasta görüşmesi'],
  ['Teil 2 · Arztbrief', 'Bir vakadan Arztbrief yaz'],
  ['Teil 3 · Fallvorstellung', 'Teil 3 soruları + vaka sunumu'],
  ['Risikopatienten', 'Risk kartları ve quiz'],
  ['Aufklärung', 'Hastaya tedaviyi günlük dille anlat'],
  ['Krankheitsbilder', 'İki hastalık tablosunu tekrar et'],
  ['Probe-Prüfung', 'Teil 1–3 ardışık, süreli'],
];

function weekPlan() {
  const left = daysLeft();
  const g = goalMin();
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(dayStart().getTime() + i * DAY);
    const dl = left === null ? null : left - i;
    let factor = 1; let level = 'Düzenli'; let focus = FOCUS[(dayOfYear(d)) % FOCUS.length];
    if (dl === null) { level = 'Düzenli'; } else if (dl < 0) { level = 'Sınav sonrası'; factor = 0.3; } else if (dl === 0) {
      level = 'Sınav günü'; factor = 0; focus = ['Sınav', 'Başarılar! Sabah kısa bir ısınma yeter.'];
    } else if (dl === 1) {
      level = 'Dinlen'; factor = 0.5; focus = ['Hafif tekrar', 'Kalıp ifadeler ve Redemittel; erken yat'];
    } else if (dl <= 7) {
      level = 'Son hafta'; factor = 1.5; if (dl % 2 === 0) focus = FOCUS[6];
    } else if (dl <= 30) { level = 'Yoğun'; factor = 1.3; } else if (dl > 90) { level = 'Temel'; factor = 0.8; }
    out.push({ d, level, min: Math.round((g * factor) / 5) * 5, focus, today: i === 0 });
  }
  return out;
}

function panelHtml() {
  const left = daysLeft();
  const tasks = todayTasks();
  const doneN = tasks.filter((t) => t.done).length;
  const reps = reported();
  const solved = new Set(reps.map((a) => a.data.caseId)).size;
  const partAvg = [1, 2, 3].map((p) => avgOf(reps.filter((a) => a.data.part === p).map((a) => a.data.report.gesamt)));
  const exams = attempts().filter((a) => a.data?.mode === 'exam');
  const cats = categoryAverages();
  const weak = cats.slice(0, 3);
  const strong = [...cats].reverse().slice(0, 3);
  const rd = readiness();
  const v = vocabStats();
  const known = knownSet().size;
  const wrong = arr(C.prefs.fspWrong).length;

  // Tekrar edilmesi gereken konular: sık eksik kalanlar, zayıf kategoriler, düşük quiz
  const miss = new Map();
  for (const a of reps.slice(0, 15)) for (const f of arr(a.data.report.fehlend)) { const s = String(f).trim(); if (s) miss.set(s, (miss.get(s) || 0) + 1); }
  const missTop = [...miss.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
  const quiz = C.prefs.fspQuiz || {};
  const lowQuiz = risks().filter((r) => quiz[r.id] && quiz[r.id].last < 70);

  const cd = left === null ? '<span class="muted">Sınav tarihini gir; plan buna göre yoğunlaşır.</span>'
    : left > 0 ? `<b class="lx-cd-n">${left}</b><span>gün kaldı</span>` : left === 0 ? '<b class="lx-cd-n">Bugün</b><span>sınav günü — başarılar!</span>' : '<span class="muted">Sınav tarihi geçti; yeni tarihi gir.</span>';

  return `
    <section class="panel lx-plan-head">
      <div class="lx-cd">${cd}</div>
      <div class="lx-settings">
        <label>Sınav tarihi<input type="date" data-lx="exam-date" value="${esc(C.prefs.fspExamDate || '')}"></label>
        <label>Günlük hedef (dk)<input type="number" min="10" max="600" step="5" data-lx="goal" value="${goalMin()}"></label>
      </div>
    </section>

    <div class="lx-cols">
      <section class="panel lx-today">
        <div class="lx-h"><h3>Bugünkü görevler</h3><span class="muted">${doneN} / ${tasks.length}</span></div>
        <div class="by-progress lx-prog"><span style="width:${Math.round((doneN / tasks.length) * 100)}%"></span></div>
        <ul class="lx-tasks">${tasks.map((t) => `
          <li class="${t.done ? 'done' : ''}">
            <button type="button" class="lx-check ${t.done ? 'on' : ''}" data-lx="task-done" data-key="${t.key}" ${t.auto ? 'disabled title="Otomatik işaretlendi"' : 'title="Tamamlandı olarak işaretle"'} aria-label="Tamamlandı">${t.done ? '✓' : ''}</button>
            <button type="button" class="lx-task" data-lx="task-go" data-key="${t.key}">
              <b>${esc(t.title)}</b><small class="muted">${esc(t.detail)}</small></button>
          </li>`).join('')}</ul>
      </section>

      <section class="panel lx-ready">
        <div class="lx-h"><h3>Sınava hazır olma</h3><span class="lx-tag">tahmin</span></div>
        <div class="lx-ring" style="--p:${rd.total}"><b>%${rd.total}</b></div>
        <ul class="lx-formula">
          <li><span>Son ${rd.n || 5} değerlendirme ortalaması</span><b>${rd.last5}</b><small>× %50</small></li>
          <li><span>Teil 3 soru bankası kapsaması</span><b>${rd.cover}</b><small>× %20</small></li>
          <li><span>FSP destelerinde öğrenilen kelime</span><b>${rd.vocab}</b><small>× %15</small></li>
          <li><span>Vaka çeşitliliği (${rd.fachs} / ${rd.target} alan)</span><b>${rd.variety}</b><small>× %15</small></li>
        </ul>
        <p class="muted lx-note">Bu bir tahmindir: kendi değerlendirmelerinden ve ilerlemenden hesaplanır, gerçek sınav sonucunu garanti etmez.</p>
      </section>
    </div>

    <section class="panel">
      <div class="lx-h"><h3>Haftalık plan</h3>${left !== null && left > 0 ? `<span class="muted">Sınava ${left} gün</span>` : ''}</div>
      <div class="lx-week">${weekPlan().map((w) => `
        <div class="lx-day ${w.today ? 'today' : ''}">
          <span class="lx-day-n">${w.d.toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric' })}</span>
          <b>${esc(w.focus[0])}</b><small class="muted">${esc(w.focus[1])}</small>
          <span class="lx-day-m">${w.min ? `${w.min} dk` : '—'} · ${esc(w.level)}</span>
        </div>`).join('')}</div>
    </section>

    <section class="panel">
      <h3>İstatistikler</h3>
      <div class="lx-stats">
        <div class="lx-stat"><b>${solved}</b><span>çözülen vaka</span></div>
        ${[1, 2, 3].map((p, i) => `<div class="lx-stat"><b>${partAvg[i] ?? '—'}</b><span>Teil ${p} ortalaması</span></div>`).join('')}
        <div class="lx-stat"><b>${v.learned}</b><span>öğrenilen kelime${v.total ? ` / ${v.total}` : ''}</span></div>
        <div class="lx-stat"><b>${known}</b><span>“bildim” soru</span></div>
        <div class="lx-stat"><b>${wrong}</b><span>yanlış / tekrar sorusu</span></div>
      </div>
      ${cats.length ? `<div class="lx-sw">
        <div><h4>Güçlü yönler</h4>${strong.map((c) => `<div class="lx-cat"><span>${esc(c.name)}</span><b class="sc ${scoreClass(c.avg)}">${c.avg}</b></div>`).join('')}</div>
        <div><h4>Zayıf yönler</h4>${weak.map((c) => `<div class="lx-cat"><span>${esc(c.name)}</span><b class="sc ${scoreClass(c.avg)}">${c.avg}</b></div>`).join('')}</div>
      </div>` : '<p class="muted">Güçlü ve zayıf yönler, değerlendirilmiş denemelerden sonra görünür.</p>'}
    </section>

    <section class="panel">
      <h3>Sınav simülasyonu sonuçları</h3>
      ${exams.length ? `<div class="lx-exams">${exams.map((a) => {
        const r = a.data.report;
        return `<div class="lx-exam"><span>${esc(a.data.case?.title || a.data.case?.patient?.name || 'Sınav')}</span><span class="muted">${fmtDate(a.created_at)}</span>${r && typeof r.gesamt === 'number' ? `<b class="sc ${scoreClass(r.gesamt)}">${r.gesamt}</b>` : '<span class="muted">devam ediyor</span>'}</div>`;
      }).join('')}</div>` : '<p class="muted">Henüz sınav modunda bir deneme yok.</p>'}
    </section>

    <section class="panel">
      <h3>Tekrar edilmesi gereken konular</h3>
      ${missTop.length || weak.length || lowQuiz.length || wrong ? `<ul class="lx-review">
        ${weak.filter((c) => c.avg < 70).map((c) => `<li><span class="lx-src ek">Kategori</span>${esc(c.name)} <span class="muted">(ort. ${c.avg})</span></li>`).join('')}
        ${missTop.map(([s, n]) => `<li><span class="lx-src kurs">Eksik</span>${esc(s)} <span class="muted">(${n}×)</span></li>`).join('')}
        ${lowQuiz.map((r) => `<li><button type="button" class="linkish" data-lx="open-risk" data-id="${esc(r.id)}">${esc(r.title_de)}</button> <span class="muted">quiz %${quiz[r.id].last}</span></li>`).join('')}
        ${wrong ? `<li><button type="button" class="linkish" data-lx="go" data-tab="bayern">${wrong} soruyu yanlış cevapladın — tekrar et</button></li>` : ''}
      </ul>` : '<p class="muted">Şimdilik yok. Vaka çözdükçe raporlardaki eksikler burada toplanır.</p>'}
    </section>`;
}

function setTaskDone(key, val) {
  const tk = todayKey();
  const all = { ...(C.prefs.fspTasks || {}) };
  // Eski günleri temizle (son 30 gün kalsın)
  const cut = todayKey(new Date(Date.now() - 30 * DAY));
  for (const k of Object.keys(all)) if (k < cut) delete all[k];
  all[tk] = { ...(all[tk] || {}), [key]: val };
  C.prefs.fspTasks = all;
  C.savePrefs();
}

function goTask(key) {
  const t = todayTasks().find((x) => x.key === key);
  if (!t) return;
  switch (key) {
    case 'case': {
      const d = t.data && diseases().find((x) => x.id === t.data.id);
      if (d) simulate(d, t.data.part);
      else C.goTab?.('cases');
      break;
    }
    case 'teil3': C.goTab?.('bayern'); break;
    case 'vocab':
      if (t.data?.deck) C.goTab?.('deck', t.data.deck);
      else C.goTab?.('learn', 'krankheiten');
      break;
    case 'write':
      resetAnTask();
      if (t.data) { L.an.sec = t.data.sec; L.an.sel = t.data.id; }
      L.sub = 'anamnese';
      C.goTab?.('learn', 'anamnese');
      break;
    case 'risk':
      L.kr.sel = t.data ? { type: 'r', id: t.data.id } : null;
      L.quiz = null;
      L.sub = 'krankheiten';
      C.goTab?.('learn', 'krankheiten');
      break;
    default: break;
  }
}

/* ================================================================== KRANKHEITSBILDER */

const D_SECS = [
  ['definition', 'Definition'], ['ursachen', 'Ursachen'], ['symptome', 'Symptome'], ['anamnese_fragen', 'Anamnesefragen'],
  ['untersuchung', 'Klinische Untersuchung'], ['diagnostik', 'Diagnostik'], ['differential', 'Differentialdiagnosen'],
  ['therapie', 'Therapie'], ['komplikationen', 'Komplikationen'], ['prognose', 'Prognose'], ['fachbegriffe', 'Fachbegriffe'],
  ['patientenformulierungen', 'Patientenformulierungen'], ['fsp_fragen', 'FSP-Fragen'], ['arzt_arzt', 'Arzt-Arzt-Gespräch (Muster)'],
  ['arztbrief', 'Arztbrief (Muster)'], ['aufklaerung', 'Patientenaufklärung'],
];
const favs = () => new Set(arr(C.prefs.fspFav));

function krFiltered() {
  const q = L.kr.q.trim().toLocaleLowerCase('de');
  const f = favs();
  const hit = (x) => !q || JSON.stringify([x.title_de, x.title_tr, x.fach, x.gruppe, x.definition, x.beschreibung, x.symptome]).toLocaleLowerCase('de').includes(q);
  const fav = (x, t) => !L.kr.fav || f.has(`${t}:${x.id}`);
  const showD = L.kr.fach !== '__risk';
  const showR = !L.kr.fach || L.kr.fach === '__risk';
  return {
    d: showD ? diseases().filter((x) => (!L.kr.fach || x.fach === L.kr.fach) && hit(x) && fav(x, 'd')) : [],
    r: showR ? risks().filter((x) => hit(x) && fav(x, 'r')) : [],
  };
}

function krHtml() {
  if (!diseases().length && !risks().length) return emptyHtml('Krankheitsbilder', NO_STUDY);
  if (L.kr.sel) {
    const x = L.kr.sel.type === 'r' ? risks().find((r) => r.id === L.kr.sel.id) : diseases().find((d) => d.id === L.kr.sel.id);
    if (x) return L.kr.sel.type === 'r' ? riskDetail(x) : diseaseDetail(x);
    L.kr.sel = null;
  }
  const fachs = [...new Set(diseases().map((d) => d.fach).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  return `
    <div class="lx-tools">
      <input type="search" id="lx-kr-q" placeholder="Ara: Perikoronitis, apse, Marcumar…" value="${esc(L.kr.q)}">
      <button type="button" class="chip ${L.kr.fav ? 'on' : ''}" data-lx="kr-fav-filter">★ Favoriler</button>
    </div>
    <div class="chips">${[['', 'Tümü'], ...fachs.map((f) => [f, f]), ...(risks().length ? [['__risk', 'Risikopatienten']] : [])]
      .map(([k, l]) => `<button type="button" class="chip ${L.kr.fach === k ? 'on' : ''}" data-lx="kr-fach" data-fach="${esc(k)}">${esc(l)}</button>`).join('')}</div>
    <div id="lx-kr-list">${krListHtml()}</div>`;
}

function krListHtml() {
  const { d, r } = krFiltered();
  const f = favs();
  const card = (x, t) => `
    <article class="panel lx-card">
      <button type="button" class="lx-card-main" data-lx="kr-open" data-type="${t}" data-id="${esc(x.id)}">
        <span class="lx-card-top"><span class="badge">${esc(t === 'r' ? x.gruppe || 'Risiko' : x.fach || '')}</span>${srcBadge(x.source)}${arr(x.ek_fields).length ? '<span class="lx-ek-dot" title="Bazı alanlar ek bilgiyle tamamlandı">+Ek</span>' : ''}</span>
        <b lang="de">${esc(x.title_de)}</b><small class="muted">${esc(x.title_tr || '')}</small>
      </button>
      <button type="button" class="icon-btn lx-star ${f.has(`${t}:${x.id}`) ? 'on' : ''}" data-lx="fav" data-key="${t}:${esc(x.id)}" title="Favori" aria-label="Favori">${f.has(`${t}:${x.id}`) ? '★' : '☆'}</button>
    </article>`;
  if (!d.length && !r.length) return '<div class="panel empty">Sonuç yok.</div>';
  return `${d.length ? `<div class="lx-grid">${d.map((x) => card(x, 'd')).join('')}</div>` : ''}
    ${r.length ? `<h3 class="lx-group">Risikopatienten</h3><div class="lx-grid">${r.map((x) => card(x, 'r')).join('')}</div>` : ''}`;
}

function textBlock(t) {
  if (!t) return '';
  return `<div class="lx-de" lang="de">${say(t)}<p>${esc(t)}</p></div>`;
}
function listBlock(xs, speak = true) {
  return `<ul class="lx-list">${arr(xs).map((s) => `<li>${speak ? say(s) : ''}<span lang="de">${esc(s)}</span></li>`).join('')}</ul>`;
}

function secBody(x, key) {
  const v = x[key];
  switch (key) {
    case 'fachbegriffe':
      return `<div class="lx-terms">${arr(v).map((t, i) => `<div class="lx-term">
          <div><b lang="de">${esc(t.de)}</b> ${say(t.de)}</div>
          <small class="muted">${esc(t.tr || '')}${t.patient ? ` · Patient: <span lang="de">${esc(t.patient)}</span>` : ''}</small>
          <button type="button" class="icon-btn" data-lx="term-add" data-id="${esc(x.id)}" data-i="${i}" title="“${DECK}” destesine ekle" aria-label="Desteye ekle">＋</button>
        </div>`).join('')}</div>
        ${arr(v).length > 1 ? `<button type="button" data-lx="terms-all" data-id="${esc(x.id)}">＋ Tümünü “${DECK}” destesine ekle</button>` : ''}`;
    case 'patientenformulierungen':
      return `<div class="lx-terms">${arr(v).map((p) => `<div class="lx-pf"><span lang="de">„${esc(p.patient)}“</span>${say(p.patient)}<span class="lx-arrow">→</span><b lang="de">${esc(p.fach)}</b></div>`).join('')}</div>`;
    case 'fsp_fragen':
      return arr(v).map((q) => `<details class="lx-qa"><summary lang="de">${esc(q.q)} ${say(q.q)}</summary>${textBlock(q.a)}</details>`).join('');
    default:
      return Array.isArray(v) ? listBlock(v) : textBlock(v);
  }
}

function hasVal(v) { return Array.isArray(v) ? v.length > 0 : !!(v && String(v).trim()); }

function diseaseDetail(x) {
  const ek = new Set(arr(x.ek_fields));
  const f = favs();
  const note = C.prefs.fspNotes?.[x.id] || '';
  return `
    <div class="lx-detail-head">
      <button type="button" class="icon-btn head-btn" data-lx="kr-back" title="Listeye dön (Esc)" aria-label="Listeye dön">${C.ICON.back}</button>
      <div class="lx-dt">
        <h2 lang="de">${esc(x.title_de)} ${say(x.title_de)}</h2>
        <div class="muted">${esc(x.title_tr || '')} · ${esc(x.fach || '')} ${srcBadge(x.source)}</div>
      </div>
      <button type="button" class="icon-btn lx-star ${f.has(`d:${x.id}`) ? 'on' : ''}" data-lx="fav" data-key="d:${esc(x.id)}" title="Favori" aria-label="Favori">${f.has(`d:${x.id}`) ? '★' : '☆'}</button>
    </div>
    ${x.sim ? `<section class="panel lx-sim"><b>Bu vakayı simüle et</b>
      <div class="lx-sim-btns">${[[1, 'Teil 1 · Gespräch'], [2, 'Teil 2 · Arztbrief'], [3, 'Teil 3 · Oberarzt']].map(([p, l]) => `<button type="button" data-lx="sim" data-id="${esc(x.id)}" data-part="${p}">${C.ICON.talk}${l}</button>`).join('')}</div></section>` : ''}
    <div class="lx-secs">${D_SECS.filter(([k]) => hasVal(x[k])).map(([k, l], i) => `
      <details class="panel lx-sec" ${i < 2 ? 'open' : ''}>
        <summary><b>${l}</b>${ek.has(k) ? '<span class="lx-src ek" title="Kursta yok; genel bilgiyle eklendi">Ek</span>' : ''}</summary>
        <div class="lx-sec-body">${secBody(x, k)}</div>
      </details>`).join('')}</div>
    <section class="panel lx-notes"><h3>Kişisel notun</h3>
      <textarea data-lx="note" data-id="${esc(x.id)}" rows="4" placeholder="Bu konuyla ilgili kendi notların (otomatik kaydedilir)">${esc(note)}</textarea></section>`;
}

function riskDetail(x) {
  const f = favs();
  const sc = C.prefs.fspQuiz?.[x.id];
  const lists = [['risiken', 'Risiken'], ['fragen', 'Fragen an den Patienten'], ['massnahmen', 'Maßnahmen'], ['meiden', 'Vermeiden'], ['la_hinweise', 'Lokalanästhesie-Hinweise']];
  return `
    <div class="lx-detail-head">
      <button type="button" class="icon-btn head-btn" data-lx="kr-back" title="Listeye dön (Esc)" aria-label="Listeye dön">${C.ICON.back}</button>
      <div class="lx-dt">
        <h2 lang="de">${esc(x.title_de)} ${say(x.title_de)}</h2>
        <div class="muted">${esc(x.title_tr || '')} · ${esc(x.gruppe || 'Risikopatient')} ${srcBadge(x.source)}</div>
      </div>
      <button type="button" class="icon-btn lx-star ${f.has(`r:${x.id}`) ? 'on' : ''}" data-lx="fav" data-key="r:${esc(x.id)}" title="Favori" aria-label="Favori">${f.has(`r:${x.id}`) ? '★' : '☆'}</button>
    </div>
    ${x.beschreibung ? `<section class="panel">${textBlock(x.beschreibung)}</section>` : ''}
    <div class="lx-secs">${lists.filter(([k]) => hasVal(x[k])).map(([k, l], i) => `
      <details class="panel lx-sec" ${i < 2 ? 'open' : ''}><summary><b>${l}</b></summary><div class="lx-sec-body">${listBlock(x[k])}</div></details>`).join('')}
      ${x.aufklaerung_teil1 ? `<details class="panel lx-sec"><summary><b>Aufklärung (Teil 1, für den Patienten)</b></summary><div class="lx-sec-body">${textBlock(x.aufklaerung_teil1)}</div></details>` : ''}
      ${x.aufklaerung_teil3 ? `<details class="panel lx-sec"><summary><b>Teil 3 (Arzt-Arzt)</b></summary><div class="lx-sec-body">${textBlock(x.aufklaerung_teil3)}</div></details>` : ''}
    </div>
    ${arr(x.quiz).length ? quizHtml(x, sc) : ''}`;
}

function quizHtml(x, sc) {
  if (!L.quiz || L.quiz.id !== x.id) L.quiz = { id: x.id, answers: {} };
  const qs = arr(x.quiz);
  const ans = L.quiz.answers;
  const answered = Object.keys(ans).length;
  const correct = qs.filter((q, i) => ans[i] === q.correct).length;
  return `<section class="panel lx-quiz">
    <div class="lx-h"><h3>Quiz</h3>${sc ? `<span class="muted">Son: %${sc.last} · En iyi: %${sc.best}</span>` : ''}</div>
    ${qs.map((q, i) => {
      const a = ans[i];
      return `<div class="lx-qz">
        <p lang="de"><b>${i + 1}.</b> ${esc(q.q)}</p>
        <div class="lx-opts">${arr(q.options).map((o, j) => {
          const cls = a === undefined ? '' : j === q.correct ? 'right' : j === a ? 'wrong' : 'dim';
          return `<button type="button" class="lx-opt ${cls}" data-lx="quiz" data-q="${i}" data-o="${j}" ${a !== undefined ? 'disabled' : ''} lang="de">${esc(o)}</button>`;
        }).join('')}</div>
        ${a !== undefined ? `<p class="lx-qz-fb ${a === q.correct ? 'ok' : 'no'}">${a === q.correct ? '✓ Doğru.' : '✗ Yanlış.'} ${esc(q.explain_tr || '')}</p>` : ''}
      </div>`;
    }).join('')}
    ${answered === qs.length ? `<div class="lx-qz-end"><b class="sc ${scoreClass(Math.round((100 * correct) / qs.length))}">%${Math.round((100 * correct) / qs.length)}</b><span>${correct} / ${qs.length} doğru</span><button type="button" data-lx="quiz-reset">↺ Tekrar çöz</button></div>` : ''}
  </section>`;
}

function answerQuiz(qi, oi) {
  const x = risks().find((r) => r.id === L.quiz?.id);
  if (!x || L.quiz.answers[qi] !== undefined) return;
  L.quiz.answers[qi] = oi;
  const qs = arr(x.quiz);
  if (Object.keys(L.quiz.answers).length === qs.length) {
    const pct = Math.round((100 * qs.filter((q, i) => L.quiz.answers[i] === q.correct).length) / qs.length);
    const prev = C.prefs.fspQuiz?.[x.id];
    C.prefs.fspQuiz = { ...(C.prefs.fspQuiz || {}), [x.id]: { last: pct, best: Math.max(pct, prev?.best ?? 0), at: Math.floor(Date.now() / 1000) } };
    C.savePrefs();
  }
  render();
}

function simulate(d, part) {
  if (!d?.sim) { C.toast('Bu tablo için simülasyon verisi yok.', 'info'); return; }
  if (!C.startCase) { C.toast('Simülasyon bu sürümde başlatılamıyor.', 'error'); return; }
  C.startCase({ ...d.sim, id: `kb-${d.id}`, title: d.title_de, fachgebiet: d.fach }, Number(part) || 1);
}

function fsDeck() {
  let deck = arr(C.state.decks).find((d) => d.name === DECK && d.role !== 'viewer');
  if (!deck) deck = C.store.createDeck({ name: DECK, language: 'de' });
  return deck;
}

function addTerms(list) {
  const cards = list.filter((t) => t?.de).map((t) => ({ word: t.de, translation: t.tr || '', notes: t.patient ? `Patient: ${t.patient}` : '' }));
  if (!cards.length) return;
  const deck = fsDeck();
  const r = C.store.importCards({ deck_id: deck.id }, cards);
  C.refreshDecks?.();
  C.toast(r.added ? `${r.added} kart “${DECK}” destesine eklendi${r.updated ? `, ${r.updated} güncellendi` : ''}.` : 'Bu kartlar destede zaten var (güncellendi).', 'success');
}

function toggleFav(key) {
  const f = favs();
  if (f.has(key)) f.delete(key); else f.add(key);
  C.prefs.fspFav = [...f];
  C.savePrefs();
  render();
}

function saveNote(id, text) {
  clearTimeout(L.noteT);
  L.noteT = setTimeout(() => {
    const notes = { ...(C.prefs.fspNotes || {}) };
    if (text.trim()) notes[id] = text; else delete notes[id];
    C.prefs.fspNotes = notes;
    C.savePrefs();
  }, 600);
}

/* ================================================================== ANAMNESE-TRAINER */

const AN_SECS = [['fragen', 'Soru kalıpları'], ['drill', 'Sesli tekrar'], ['umg', 'Umgangssprache → Fachsprache'], ['gespr', 'Gesprächsführung'], ['aufkl', 'Aufklärung'], ['brief', 'Arztbrief']];

function situations() {
  const s = arr(L.study?.anamnese?.situations);
  if (s.length) return s;
  // Yedek: herkese açık rehberdeki anamnez başlıkları (Türkçe karşılık yok)
  return arr(L.guide?.anamnesis).map((t, i) => ({ id: `g${i}`, title_de: t.topic, title_tr: '', source: 'ek', questions: arr(t.items).map((de) => ({ de })) }));
}

function resetAnTask() {
  stopMic();
  L.an.sel = null; L.an.text = ''; L.an.check = null; L.an.warn = []; L.an.revealed = false;
}

function anHtml() {
  const sits = situations();
  const hasStudy = !!L.study;
  const secs = AN_SECS.filter(([k]) => {
    if (k === 'umg') return arr(L.study?.anamnese?.umgangssprache).length;
    if (k === 'gespr') return arr(L.study?.anamnese?.gespraechsfuehrung).length;
    if (k === 'aufkl') return arr(L.study?.aufklaerung).length;
    if (k === 'brief') return arr(L.study?.briefe).length;
    return sits.length;
  });
  if (!secs.length) return emptyHtml('Anamnese-Trainer', NO_STUDY);
  if (!secs.some(([k]) => k === L.an.sec)) L.an.sec = secs[0][0];
  const body = { fragen: anFragenHtml, drill: anDrillHtml, umg: anUmgHtml, gespr: anGesprHtml, aufkl: anAufklHtml, brief: anBriefHtml }[L.an.sec]();
  return `
    ${hasStudy ? '' : '<div class="panel lx-hint">Kurs paketi yüklenmediği için genel rehberdeki soru kalıpları gösteriliyor; Aufklärung ve Arztbrief alıştırmaları paketle açılır.</div>'}
    <div class="chips lx-an-secs">${secs.map(([k, l]) => `<button type="button" class="chip ${L.an.sec === k ? 'on' : ''}" data-lx="an-sec" data-sec="${k}">${l}</button>`).join('')}</div>
    ${body}`;
}

function sitSelect() {
  const sits = situations();
  if (!sits.some((s) => s.id === L.an.sit)) L.an.sit = sits[0]?.id || '';
  return `<div class="chips">${sits.map((s) => `<button type="button" class="chip ${L.an.sit === s.id ? 'on' : ''}" data-lx="an-sit" data-id="${esc(s.id)}" title="${esc(s.title_tr || '')}">${esc(s.title_de)}</button>`).join('')}</div>`;
}
const curSit = () => situations().find((s) => s.id === L.an.sit) || situations()[0];

function anFragenHtml() {
  const head = sitSelect();
  const s = curSit();
  if (!s) return head;
  const ch = L.an.checked[s.id] || {};
  const qs = arr(s.questions);
  const n = qs.filter((_, i) => ch[i]).length;
  return `${head}
    <section class="panel">
      <div class="lx-h"><h3 lang="de">${esc(s.title_de)}</h3>${srcBadge(s.source)}<span class="muted">${n} / ${qs.length}</span>
        <button type="button" class="ghost" data-lx="an-uncheck">Sıfırla</button></div>
      <ul class="lx-checklist">${qs.map((q, i) => `
        <li class="${ch[i] ? 'done' : ''}">
          <button type="button" class="lx-check ${ch[i] ? 'on' : ''}" data-lx="an-check" data-i="${i}" aria-label="Sordum">${ch[i] ? '✓' : ''}</button>
          <div class="lx-cl-txt">${q.w ? `<span class="lx-w">${esc(q.w)}</span>` : ''}<span lang="de">${esc(q.de)}</span>${q.tr ? `<small class="muted">${esc(q.tr)}${q.ziel_tr ? ` · ${esc(q.ziel_tr)}` : ''}</small>` : ''}</div>
          ${say(q.de)}
        </li>`).join('')}</ul>
    </section>`;
}

/* --- toleranslı karşılaştırma */
function norm(s) {
  return String(s || '').toLocaleLowerCase('de').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
/** Hedef kelimelerin kaçı (küçük yazım hatalarına izin vererek) cevapta var: 0–100 ve eksik kelimeler. */
function compare(answer, target) {
  const a = norm(answer).split(' ').filter(Boolean);
  const t = norm(target).split(' ').filter(Boolean);
  if (!t.length) return { pct: 0, missing: [] };
  const missing = [];
  let hit = 0;
  for (const w of t) {
    const tol = w.length > 7 ? 2 : w.length > 3 ? 1 : 0;
    if (a.some((x) => lev(x, w) <= tol)) hit++; else missing.push(w);
  }
  return { pct: Math.round((100 * hit) / t.length), missing };
}
const verdict = (p) => (p >= 80 ? ['good', 'Çok iyi'] : p >= 55 ? ['mid', 'Yaklaştın'] : ['bad', 'Tekrar dene']);

function anDrillHtml() {
  const head = sitSelect();
  const s = curSit();
  const qs = arr(s?.questions).filter((q) => q.tr);
  if (!qs.length) return `${head}<div class="panel empty">Bu durumda Türkçe karşılığı olan soru yok; sesli tekrar için kurs paketi gerekir.</div>`;
  if (!L.an.drill || L.an.drill.sit !== s.id) L.an.drill = { sit: s.id, i: 0, text: '', res: null, ok: 0 };
  const d = L.an.drill;
  const q = qs[d.i % qs.length];
  return `${head}
    <section class="panel lx-drill">
      <div class="pr-top"><span class="muted">${(d.i % qs.length) + 1} / ${qs.length}</span>
        <div class="by-progress"><span style="width:${Math.round(((d.i % qs.length) / qs.length) * 100)}%"></span></div></div>
      <p class="lx-drill-tr">${esc(q.tr)}</p>
      ${q.w ? `<span class="lx-w">${esc(q.w)}</span>` : ''}
      <label class="pr-label">Almancasını söyle ya da yaz</label>
      <div class="pr-ans">
        <textarea id="lx-drill-in" rows="2" lang="de" placeholder="Almanca soru kalıbı…">${esc(d.text)}</textarea>
        ${micBtn('lx-drill-in')}
      </div>
      ${d.res ? `<div class="lx-res"><span class="sc ${verdict(d.res.pct)[0]}">%${d.res.pct}</span><b>${verdict(d.res.pct)[1]}</b>
          ${d.res.missing.length ? `<small class="muted">Eksik/farklı: ${d.res.missing.map(esc).join(', ')}</small>` : ''}</div>
        <div class="lx-de" lang="de">${say(q.de)}<p><b>${esc(q.de)}</b></p></div>` : ''}
      <div class="pr-actions">
        ${d.res ? `<button type="button" class="primary" data-lx="drill-next">Sonraki →</button>` : `<button type="button" data-lx="drill-skip">Göster</button><button type="button" class="primary" data-lx="drill-check">Kontrol et</button>`}
      </div>
    </section>`;
}

function anUmgHtml() {
  const list = arr(L.study?.anamnese?.umgangssprache);
  if (!L.an.umg) L.an.umg = { i: 0, text: '', res: null };
  const u = L.an.umg;
  const x = list[u.i % list.length];
  return `
    <section class="panel lx-drill">
      <div class="pr-top"><span class="muted">${(u.i % list.length) + 1} / ${list.length}</span>
        <div class="by-progress"><span style="width:${Math.round(((u.i % list.length) / list.length) * 100)}%"></span></div>${srcBadge(x.source)}</div>
      <p class="muted">Hasta diyor ki:</p>
      <div class="lx-de lx-quote" lang="de">${say(x.patient)}<p>„${esc(x.patient)}“</p></div>
      <label class="pr-label">Fachsprache karşılığı</label>
      <div class="pr-ans"><input type="text" id="lx-umg-in" lang="de" autocomplete="off" placeholder="ör. pulsierender Schmerz" value="${esc(u.text)}"></div>
      ${u.res ? `<div class="lx-res"><span class="sc ${verdict(u.res.pct)[0]}">%${u.res.pct}</span><b>${verdict(u.res.pct)[1]}</b></div>
        <div class="lx-de" lang="de">${say(x.fach)}<p><b>${esc(x.fach)}</b>${x.tr ? ` <span class="muted">· ${esc(x.tr)}</span>` : ''}</p></div>` : ''}
      <div class="pr-actions">${u.res ? '<button type="button" class="primary" data-lx="umg-next">Sonraki →</button>' : '<button type="button" data-lx="umg-skip">Göster</button><button type="button" class="primary" data-lx="umg-check">Kontrol et</button>'}</div>
    </section>
    <details class="panel"><summary><b>Tüm liste</b> <span class="muted">(${list.length})</span></summary>
      <div class="lx-terms">${list.map((p) => `<div class="lx-pf"><span lang="de">„${esc(p.patient)}“</span><span class="lx-arrow">→</span><b lang="de">${esc(p.fach)}</b>${say(p.fach)}${srcBadge(p.source)}</div>`).join('')}</div></details>`;
}

function anGesprHtml() {
  const list = arr(L.study?.anamnese?.gespraechsfuehrung);
  return `<section class="panel"><h3>Gesprächsführung</h3><p class="muted">Görüşmeyi yönlendirmek için hazır cümleler.</p>
    <ul class="lx-gl">${list.map((g) => `<li><small class="muted">${esc(g.situation_tr || '')}</small><div class="lx-de" lang="de">${say(g.de)}<p>${esc(g.de)}</p></div>${srcBadge(g.source)}</li>`).join('')}</ul></section>`;
}

function micBtn(target) {
  return SR ? `<button type="button" class="icon-btn fsp-mic ${L.rec?.target === target ? 'on' : ''}" data-lx="mic" data-target="${target}" title="Konuşarak yaz (Almanca)" aria-label="Mikrofon">${C.ICON.mic}</button>` : '';
}

function taskListHtml(items, label) {
  return `<div class="lx-tasklist">${items.map((x) => `
    <button type="button" class="panel lx-tl" data-lx="an-open" data-id="${esc(x.id)}">
      <span class="lx-card-top">${srcBadge(x.source)}</span>
      <b lang="de">${esc(x.title_de || x.title || x.id)}</b><small class="muted">${esc(x.aufgabe_tr || x.title_tr || label)}</small>
    </button>`).join('')}</div>`;
}

function checkHtml() {
  const ch = L.an.check;
  if (!ch) return '';
  return `<div class="pr-check"><div class="pr-check-h"><span class="sc ${scoreClass(ch.punkte)}">${ch.punkte}</span><b>Yapay zekâ değerlendirmesi</b></div>
    <p>${esc(ch.feedback)}</p>
    ${arr(ch.fehlend).length ? `<p class="muted"><b>Eksik:</b> ${ch.fehlend.map(esc).join(' · ')}</p>` : ''}
    ${ch.korrigiert ? `<div class="pr-fix"><span class="muted">Düzeltilmiş hâli:</span><p lang="de">${esc(ch.korrigiert)}</p></div>` : ''}</div>`;
}

function anAufklHtml() {
  const items = arr(L.study?.aufklaerung);
  const x = items.find((a) => a.id === L.an.sel);
  if (!x) return `<p class="muted lx-lead">Bir konu seç, hastaya günlük dille anlat (yaz ya da konuş). Yapay zekâ örnek metne göre puanlar; tıp terimi kullanırsan uyarılırsın.</p>${taskListHtml(items, 'Hastaya anlat')}`;
  return `
    <div class="lx-detail-head">
      <button type="button" class="icon-btn head-btn" data-lx="an-close" title="Listeye dön (Esc)" aria-label="Listeye dön">${C.ICON.back}</button>
      <div class="lx-dt"><h2 lang="de">${esc(x.title_de)}</h2><div class="muted">${esc(x.title_tr || '')} ${srcBadge(x.source)}</div></div>
    </div>
    <section class="panel">
      <p class="lx-task-tr"><b>Görev:</b> ${esc(x.aufgabe_tr || 'Hastaya anlat')}</p>
      ${arr(x.kernpunkte).length || arr(x.risiken).length ? `<details class="lx-hint-d"><summary>İpucu: ana noktalar</summary>
        ${arr(x.kernpunkte).length ? `<h4>Kernpunkte</h4>${listBlock(x.kernpunkte, false)}` : ''}
        ${arr(x.risiken).length ? `<h4>Risiken</h4>${listBlock(x.risiken, false)}` : ''}</details>` : ''}
      ${arr(x.verbotene_fachbegriffe).length ? `<p class="muted lx-forbid">Kaçınılacak terimler: ${x.verbotene_fachbegriffe.map((t) => `<span lang="de">${esc(t)}</span>`).join(', ')}</p>` : ''}
      <div class="pr-ans">
        <textarea id="lx-an-text" rows="8" lang="de" placeholder="Hastaya Almanca, günlük dille anlat…">${esc(L.an.text)}</textarea>
        ${micBtn('lx-an-text')}
      </div>
      ${L.an.warn.length ? `<div class="lx-warn">⚠ Hastaya şu tıp terimlerini kullandın: ${L.an.warn.map((w) => `<b lang="de">${esc(w)}</b>`).join(', ')}. Günlük dille açıkla.</div>` : ''}
      ${checkHtml()}
      ${L.an.revealed ? `<div class="pr-model"><h4>Örnek metin</h4>${textBlock(x.muster)}</div>` : ''}
      <div class="pr-actions">
        ${C.sync.user() ? `<button type="button" class="primary" data-lx="an-check-ai" ${L.pending ? 'disabled' : ''}>${L.pending ? 'Değerlendiriliyor…' : 'Kontrol et (AI)'}</button>` : '<span class="muted">AI kontrolü için giriş yap.</span>'}
        ${L.an.revealed ? '' : '<button type="button" data-lx="an-reveal">Örnek metni göster</button>'}
      </div>
    </section>`;
}

function anBriefHtml() {
  const items = arr(L.study?.briefe);
  const x = items.find((a) => a.id === L.an.sel);
  if (!x) return `<p class="muted lx-lead">Ham notlardan tam bir Arztbrief yaz. Yapay zekâ örnek mektuba göre kontrol eder; ardından örnek gösterilir.</p>${taskListHtml(items, 'Arztbrief')}`;
  return `
    <div class="lx-detail-head">
      <button type="button" class="icon-btn head-btn" data-lx="an-close" title="Listeye dön (Esc)" aria-label="Listeye dön">${C.ICON.back}</button>
      <div class="lx-dt"><h2 lang="de">${esc(x.title || x.id)}</h2><div class="muted">Arztbrief ${srcBadge(x.source)}</div></div>
    </div>
    <section class="panel">
      <h4>Stichpunkte</h4>
      <pre class="lx-pre" lang="de">${esc(x.stichpunkte || '')}</pre>
      ${arr(x.abschnitte).length ? `<p class="muted">Bölümler: ${x.abschnitte.map(esc).join(' · ')}</p>` : ''}
      <textarea id="lx-an-text" rows="12" lang="de" placeholder="Sehr geehrte Frau Kollegin, sehr geehrter Herr Kollege, …">${esc(L.an.text)}</textarea>
      ${checkHtml()}
      ${L.an.revealed ? `<div class="pr-model"><h4>Örnek Arztbrief</h4>${textBlock(x.muster)}</div>` : ''}
      <div class="pr-actions">
        ${C.sync.user() ? `<button type="button" class="primary" data-lx="an-check-ai" ${L.pending ? 'disabled' : ''}>${L.pending ? 'Değerlendiriliyor…' : 'Kontrol et (AI)'}</button>` : '<span class="muted">AI kontrolü için giriş yap.</span>'}
        ${L.an.revealed ? '' : '<button type="button" data-lx="an-reveal">Örnek mektubu göster</button>'}
      </div>
    </section>`;
}

function forbiddenUsed(text, list) {
  const t = String(text || '').toLocaleLowerCase('de');
  return arr(list).filter((w) => w && t.includes(String(w).toLocaleLowerCase('de')));
}

async function checkAn() {
  if (L.pending) return;
  const isBrief = L.an.sec === 'brief';
  const x = arr(isBrief ? L.study?.briefe : L.study?.aufklaerung).find((a) => a.id === L.an.sel);
  if (!x) return;
  const answer = (document.getElementById('lx-an-text')?.value || L.an.text || '').trim();
  L.an.text = answer;
  if (answer.split(/\s+/).length < 8) { C.toast('Önce birkaç cümle yaz.', 'info'); return; }
  stopMic();
  if (!isBrief) L.an.warn = forbiddenUsed(answer, x.verbotene_fachbegriffe);
  L.pending = true;
  render();
  try {
    const question = isBrief ? `Arztbrief schreiben: ${x.title || x.id}\nStichpunkte: ${x.stichpunkte || ''}` : `${x.aufgabe_tr || ''} / ${x.title_de}`;
    const res = await C.sync.fspAi({ action: 'answer', question, model: x.muster || '', answer, kind: isBrief ? 'arzt' : 'patient' }, 90_000);
    if (L.an.sel === x.id) { L.an.check = res?.check || null; L.an.revealed = true; }
  } catch (e) {
    C.toast(e.message || String(e), 'error', 5000);
  } finally {
    L.pending = false;
    if (root() && L.sub === 'anamnese') render();
  }
}

/* --- mikrofon (Web Speech, de-DE) */
function stopMic() {
  try { L.rec?.r.stop(); } catch { /* yok say */ }
  L.rec = null;
}
function toggleMic(btn) {
  const target = btn.dataset.target;
  if (L.rec) { const same = L.rec.target === target; stopMic(); btn.classList.remove('on'); if (same) return; }
  const box = document.getElementById(target);
  if (!SR || !box) return;
  const r = new SR();
  r.lang = 'de-DE';
  r.interimResults = true;
  r.continuous = true;
  const base = box.value ? `${box.value.trimEnd()} ` : '';
  let finalText = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
      else interim += e.results[i][0].transcript;
    }
    box.value = base + finalText + interim;
    syncText(box);
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed') C.toast('Mikrofon izni verilmedi.', 'error');
    else if (e.error !== 'no-speech' && e.error !== 'aborted') C.toast(`Ses tanıma hatası: ${e.error}`, 'error');
  };
  r.onend = () => { if (L.rec?.r === r) L.rec = null; btn.classList.remove('on'); };
  try { r.start(); } catch { return; }
  C.stopSpeech?.();
  L.rec = { r, target };
  btn.classList.add('on');
}

function syncText(el) {
  if (el.id === 'lx-an-text') L.an.text = el.value;
  else if (el.id === 'lx-drill-in' && L.an.drill) L.an.drill.text = el.value;
  else if (el.id === 'lx-umg-in' && L.an.umg) L.an.umg.text = el.value;
}

/* ================================================================== NACHSCHLAGEN */

const NS_TABS = [
  ['abkuerzungen', 'Abkürzungen'], ['laborwerte', 'Laborwerte'], ['medikamente', 'Medikamente'], ['schmerz', 'Schmerz'],
  ['untersuchung', 'Untersuchung'], ['schwierige_gespraeche', 'Schwierige Gespräche'], ['redemittel', 'Redemittel'],
  ['fehler_tipps', 'Fehler & Tipps'], ['quellen', 'Quellen'],
];

function nsData(tab) {
  const t = L.training || {};
  if (tab === 'medikamente') return arr(L.study?.medikamente);
  if (tab === 'schmerz') {
    const s = t.schmerz;
    if (!s) return [];
    return [
      ...(s.skala_tr ? [{ _kind: 'skala', tr: s.skala_tr }] : []),
      ...arr(s.qualitaeten).map((q) => ({ _kind: 'qual', ...q })),
      ...arr(s.fragen).map((f) => ({ _kind: 'frage', de: f })),
    ];
  }
  return arr(t[tab]);
}

function nsRowText(tab, x) {
  return JSON.stringify(x).toLocaleLowerCase('de');
}

function nsRow(tab, x) {
  const src = srcBadge(x.source || (tab === 'medikamente' ? '' : 'ek'));
  switch (tab) {
    case 'abkuerzungen':
      return `<div class="lx-row"><b class="lx-abk">${esc(x.abk)}</b><span lang="de">${esc(x.voll)}</span>${say(x.voll)}<small class="muted">${esc(x.tr || '')}</small>${src}</div>`;
    case 'laborwerte':
      return `<div class="lx-row lx-row-col"><div><b lang="de">${esc(x.name)}</b> <span class="lx-norm">${esc(x.norm || '')} ${esc(x.einheit || '')}</span>${src}</div>
        ${x.bedeutung_tr ? `<small>${esc(x.bedeutung_tr)}</small>` : ''}${x.zahnarzt_tr ? `<small class="muted">Diş hekimi için: ${esc(x.zahnarzt_tr)}</small>` : ''}</div>`;
    case 'medikamente':
      return `<details class="lx-row lx-med"><summary><b lang="de">${esc(x.name)}</b> <span class="muted">${esc(x.klasse || '')}</span>${src}</summary>
        ${x.tr ? `<p class="muted">${esc(x.tr)}</p>` : ''}
        ${x.wirkung ? `<h4>Wirkung</h4>${textBlock(x.wirkung)}` : ''}
        ${arr(x.indikation).length ? `<h4>Indikation</h4>${listBlock(x.indikation)}` : ''}
        ${arr(x.kontraindikation).length ? `<h4>Kontraindikation</h4>${listBlock(x.kontraindikation)}` : ''}
        ${x.dosierung ? `<h4>Dosierung</h4>${textBlock(x.dosierung)}` : ''}
        ${arr(x.hinweise).length ? `<h4>Hinweise</h4>${listBlock(x.hinweise)}` : ''}</details>`;
    case 'schmerz':
      if (x._kind === 'skala') return `<div class="lx-row"><span>${esc(x.tr)}</span></div>`;
      if (x._kind === 'qual') return `<div class="lx-row"><b lang="de">${esc(x.de)}</b>${say(x.de)}<small class="muted">${esc(x.tr || '')}${x.hinweis_tr ? ` · ${esc(x.hinweis_tr)}` : ''}</small></div>`;
      return `<div class="lx-row"><span lang="de">${esc(x.de)}</span>${say(x.de)}</div>`;
    case 'untersuchung':
      return `<div class="lx-row">${x.bereich ? `<span class="badge">${esc(x.bereich)}</span>` : ''}<span lang="de">${esc(x.de)}</span>${say(x.de)}<small class="muted">${esc(x.tr || '')}</small>${src}</div>`;
    case 'schwierige_gespraeche':
      return `<div class="lx-row lx-row-col"><b>${esc(x.situation_tr)}</b>${x.strategie_tr ? `<small>${esc(x.strategie_tr)}</small>` : ''}${listBlock(x.redemittel)}${src}</div>`;
    case 'redemittel':
      return `<div class="lx-row">${x.bereich ? `<span class="badge">${esc(x.bereich)}</span>` : ''}<span lang="de">${esc(x.de)}</span>${say(x.de)}<small class="muted">${esc(x.tr || '')}</small>${src}</div>`;
    case 'fehler_tipps':
      return `<div class="lx-row"><span>💡 ${esc(x.tr)}</span>${src}</div>`;
    case 'quellen':
      return `<div class="lx-row"><span>${esc(x.titel)}</span>${x.url && /^https?:\/\//.test(x.url) ? `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.url)}</a>` : ''}</div>`;
    default: return '';
  }
}

function nsHtml() {
  const tabs = NS_TABS.filter(([k]) => nsData(k).length);
  if (!tabs.length) return emptyHtml('Nachschlagen', 'Başvuru içeriği (fsp-training.json) yüklenemedi. İnternet bağlantını kontrol edip tekrar dene.');
  if (!tabs.some(([k]) => k === L.ns.tab)) L.ns.tab = tabs[0][0];
  return `
    <div class="lx-tools"><input type="search" id="lx-ns-q" placeholder="Tüm başvuruda ara: INR, Articain, pochend…" value="${esc(L.ns.q)}"></div>
    <div class="chips">${tabs.map(([k, l]) => `<button type="button" class="chip ${L.ns.tab === k && !L.ns.q.trim() ? 'on' : ''}" data-lx="ns-tab" data-tab="${k}">${l} <small>${nsData(k).length}</small></button>`).join('')}</div>
    <div id="lx-ns-body">${nsBodyHtml()}</div>`;
}

function nsBodyHtml() {
  const q = L.ns.q.trim().toLocaleLowerCase('de');
  if (q.length >= 2) {
    const groups = NS_TABS.map(([k, l]) => [k, l, nsData(k).filter((x) => nsRowText(k, x).includes(q))]).filter((g) => g[2].length);
    if (!groups.length) return '<div class="panel empty">Sonuç yok.</div>';
    return groups.map(([k, l, xs]) => `<section class="panel lx-ns-sec"><h3>${l} <small class="muted">${xs.length}</small></h3>${xs.map((x) => nsRow(k, x)).join('')}</section>`).join('');
  }
  const k = L.ns.tab;
  const l = NS_TABS.find((t) => t[0] === k)?.[1] || '';
  const def = k === 'medikamente' ? '' : '<span class="lx-src ek" title="Kurs metninden kopyalanmadı; genel kaynaklardan">Ek</span>';
  return `<section class="panel lx-ns-sec"><div class="lx-h"><h3>${l}</h3>${def}</div>${nsData(k).map((x) => nsRow(k, x)).join('')}</section>`;
}

/* ================================================================== olaylar */

function inRoot(el) { return !!root()?.contains(el); }

function onClick(e) {
  const el = e.target.closest('[data-lx]');
  if (!el || !inRoot(el)) return;
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return;
  const k = el.dataset.lx;
  if (k === 'say' && el.closest('summary')) e.preventDefault(); // <details> açılıp kapanmasın
  C.guard(async () => {
    switch (k) {
      case 'say': C.speak(el.dataset.text, 'de'); break;
      case 'go': C.goTab?.(el.dataset.tab, el.dataset.sub); break;
      // panel
      case 'task-done': {
        const t = todayTasks().find((x) => x.key === el.dataset.key);
        setTaskDone(el.dataset.key, !t?.done);
        render();
        break;
      }
      case 'task-go': goTask(el.dataset.key); break;
      case 'open-risk':
        L.kr.sel = { type: 'r', id: el.dataset.id }; L.quiz = null; L.sub = 'krankheiten';
        C.goTab?.('learn', 'krankheiten');
        break;
      // krankheiten
      case 'kr-fach': L.kr.fach = el.dataset.fach; render(); break;
      case 'kr-fav-filter': L.kr.fav = !L.kr.fav; render(); break;
      case 'kr-open': L.kr.sel = { type: el.dataset.type, id: el.dataset.id }; L.quiz = null; render(); C.main.scrollTop = 0; break;
      case 'kr-back': L.kr.sel = null; L.quiz = null; render(); break;
      case 'fav': toggleFav(el.dataset.key); break;
      case 'sim': simulate(diseases().find((d) => d.id === el.dataset.id), el.dataset.part); break;
      case 'term-add': {
        const d = diseases().find((x) => x.id === el.dataset.id);
        const t = arr(d?.fachbegriffe)[Number(el.dataset.i)];
        if (t) addTerms([t]);
        break;
      }
      case 'terms-all': addTerms(arr(diseases().find((x) => x.id === el.dataset.id)?.fachbegriffe)); break;
      case 'quiz': answerQuiz(Number(el.dataset.q), Number(el.dataset.o)); break;
      case 'quiz-reset': if (L.quiz) L.quiz.answers = {}; render(); break;
      // anamnese
      case 'an-sec': resetAnTask(); L.an.sec = el.dataset.sec; render(); break;
      case 'an-sit': L.an.sit = el.dataset.id; L.an.drill = null; render(); break;
      case 'an-check': {
        const s = curSit();
        const ch = { ...(L.an.checked[s.id] || {}) };
        ch[el.dataset.i] = !ch[el.dataset.i];
        L.an.checked[s.id] = ch;
        render();
        break;
      }
      case 'an-uncheck': L.an.checked[curSit().id] = {}; render(); break;
      case 'drill-check': case 'drill-skip': {
        const d = L.an.drill;
        const q = arr(curSit()?.questions).filter((x) => x.tr)[d.i % arr(curSit()?.questions).filter((x) => x.tr).length];
        d.text = document.getElementById('lx-drill-in')?.value || '';
        stopMic();
        d.res = k === 'drill-skip' && !d.text.trim() ? { pct: 0, missing: [] } : compare(d.text, q.de);
        render();
        if (C.prefs.fspVoice !== false) C.speak(q.de, 'de');
        break;
      }
      case 'drill-next': L.an.drill.i++; L.an.drill.text = ''; L.an.drill.res = null; render(); document.getElementById('lx-drill-in')?.focus(); break;
      case 'umg-check': case 'umg-skip': {
        const list = arr(L.study?.anamnese?.umgangssprache);
        const u = L.an.umg;
        const x = list[u.i % list.length];
        u.text = document.getElementById('lx-umg-in')?.value || '';
        // Fachbegriff çoğu zaman parantezli alternatif içerir: "Schluckbeschwerden (Dysphagie)" — en iyi eşleşme alınır
        const alts = [x.fach, ...String(x.fach).split(/[()/,;]/)].map((s) => s.trim()).filter(Boolean);
        u.res = !u.text.trim() ? { pct: 0, missing: [] } : alts.map((a) => compare(u.text, a)).sort((a, b) => b.pct - a.pct)[0];
        render();
        break;
      }
      case 'umg-next': L.an.umg.i++; L.an.umg.text = ''; L.an.umg.res = null; render(); document.getElementById('lx-umg-in')?.focus(); break;
      case 'an-open': resetAnTask(); L.an.sel = el.dataset.id; render(); C.main.scrollTop = 0; break;
      case 'an-close': resetAnTask(); render(); break;
      case 'an-reveal':
        L.an.text = document.getElementById('lx-an-text')?.value || L.an.text;
        if (L.an.sec === 'aufkl') {
          const x = arr(L.study?.aufklaerung).find((a) => a.id === L.an.sel);
          L.an.warn = forbiddenUsed(L.an.text, x?.verbotene_fachbegriffe);
        }
        L.an.revealed = true; render();
        break;
      case 'an-check-ai': await checkAn(); break;
      case 'mic': toggleMic(el); break;
      // nachschlagen
      case 'ns-tab': L.ns.tab = el.dataset.tab; L.ns.q = ''; render(); break;
      default: break;
    }
  });
}

function onInput(e) {
  const el = e.target;
  if (!inRoot(el)) return;
  if (el.id === 'lx-kr-q') {
    L.kr.q = el.value;
    const box = document.getElementById('lx-kr-list');
    if (box) box.innerHTML = krListHtml();
  } else if (el.id === 'lx-ns-q') {
    L.ns.q = el.value;
    const box = document.getElementById('lx-ns-body');
    if (box) box.innerHTML = nsBodyHtml();
    root()?.querySelectorAll('[data-lx="ns-tab"]').forEach((b) => b.classList.toggle('on', !L.ns.q.trim() && b.dataset.tab === L.ns.tab));
  } else if (el.dataset.lx === 'note') {
    saveNote(el.dataset.id, el.value);
  } else {
    syncText(el);
  }
}

function onChange(e) {
  const el = e.target;
  if (!inRoot(el) || !el.dataset?.lx) return;
  if (el.dataset.lx === 'exam-date') {
    C.prefs.fspExamDate = el.value || null;
    C.savePrefs();
    render();
  } else if (el.dataset.lx === 'goal') {
    C.prefs.fspDailyMin = Math.max(10, Math.min(600, Number(el.value) || 60));
    C.savePrefs();
    render();
  }
}


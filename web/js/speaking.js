import { ic } from './icons.js';
// IELTS Speaking sınav simülasyonu: Part 1 (röportaj), Part 2 (1 dk hazırlık + 2 dk konuşma), Part 3 (tartışma).
// Sorular sesli sorulur; cevap hem ses kaydı (MediaRecorder) hem de metin (tarayıcının konuşma tanıması) olarak saklanır.
// Veriler yalnızca bu cihazdaki ayrı bir IndexedDB'de durur (ses dosyaları büyük olduğu için eşitlenmez).
// Yapay zekâ değerlendirmesi sunucudaki kelime-ai fonksiyonundan gelir (action: speaking).
// app.js bu modüle ortak yardımcıları initSpeaking(ctx) ile verir.

let C = null; // app.js'ten gelen yardımcılar
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const P2_PREP = 60; // saniye
const P2_TALK = 120;
const ANSWER_MAX = 150; // Part 1/3 cevabı için güvenlik sınırı (saniye)
const LANG = 'en-GB';

const MODES = [
  ['full', 'Tam sınav', 'Part 1 → 2 → 3'],
  ['p1', 'Sadece Part 1', 'Kısa röportaj soruları'],
  ['p2', 'Sadece Part 2', '1 dk hazırlık + 2 dk konuşma'],
  ['p3', 'Sadece Part 3', 'Tartışma soruları'],
];
const PART_NAME = { 1: 'Part 1 · Röportaj', 2: 'Part 2 · Uzun konuşma', 3: 'Part 3 · Tartışma' };
const CRIT = {
  fluency: ['Fluency & Coherence', 'Akıcılık ve tutarlılık'],
  lexical: ['Lexical Resource', 'Kelime kaynağı'],
  grammar: ['Grammatical Range & Accuracy', 'Dilbilgisi çeşitliliği ve doğruluğu'],
};
const ERR_TYPE = { grammar: 'gramer', vocabulary: 'kelime', collocation: 'birliktelik', other: 'diğer' };

const ui = { tests: [], attempts: [], cur: null, edit: new Set(), pending: false, urls: [], saveT: null, setupId: null };
let run = null; // süren sınav (mikrofon, sayaç, kayıt)

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clock = (sec) => `${Math.floor(Math.max(0, sec) / 60)}:${String(Math.floor(Math.max(0, sec) % 60)).padStart(2, '0')}`;
const dateStr = (t) => new Date(t).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' });
const wordCount = (t) => (String(t || '').trim() ? String(t).trim().split(/\s+/).length : 0);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

/* ------------------------------------------------------------------ yerel veri (ayrı IndexedDB) */

let dbp = null;
function db() {
  dbp ||= new Promise((res, rej) => {
    const r = indexedDB.open('kelime-speaking', 1);
    r.onupgradeneeded = () => {
      for (const s of ['tests', 'attempts', 'audio']) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
async function dbDo(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = t.onabort = () => rej(t.error);
  });
}
const dbAll = (s) => dbDo(s, 'readonly', (o) => o.getAll());
const dbGet = (s, k) => dbDo(s, 'readonly', (o) => o.get(k));
const dbPut = (s, k, v) => dbDo(s, 'readwrite', (o) => o.put(v, k));
const dbDel = (s, k) => dbDo(s, 'readwrite', (o) => o.delete(k));
const dbDelRange = (s, from, to) => dbDo(s, 'readwrite', (o) => o.delete(IDBKeyRange.bound(from, to)));

/* ------------------------------------------------------------------ soru metni ayrıştırma */

/**
 * "PART 1 / PART 2 / PART 3" biçimindeki metni testlere çevirir (her "PART 1" yeni test başlatır).
 * Satır sonlarında bölünmüş cümleleri birleştirir; Part 3'te numaralar yeniden başlasa da sıralı listeler.
 */
export function parseTests(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  const raws = [];
  let cur = null;
  let part = 0;
  for (const l of lines) {
    const h = /^(?:speaking\s*)?part\s*([123])\s*[:.\-–]?\s*$/i.exec(l);
    if (h) {
      part = Number(h[1]);
      if (part === 1 || !cur) { cur = { 1: [], 2: [], 3: [] }; raws.push(cur); }
      continue;
    }
    if (!cur || !part || /^speaking$/i.test(l) || /^please answer/i.test(l)) continue;
    cur[part].push(l);
  }
  const clean = (s) => s.replace(/\s+/g, ' ').replace(/'\s+s\b/g, "'s").replace(/\s+([?.,!])/g, '$1').trim();
  const questions = (ls) => {
    const out = [];
    for (const l of ls) {
      const m = /^(\d+)\s*[.)]\s*(.*)$/.exec(l);
      if (m) out.push(m[2]);
      else if (out.length) out[out.length - 1] += ` ${l}`;
    }
    return out.map(clean).filter(Boolean);
  };
  const tests = [];
  for (const raw of raws) {
    const p1 = questions(raw[1]);
    const p3 = questions(raw[3]);
    const joined = raw[2].join('\n');
    const split = joined.split(/you\s+should\s+say\s*:?/i);
    const topic = clean(split[0] || '');
    const bullets = [];
    if (split.length > 1) {
      for (const l of split.slice(1).join(' ').split('\n').map((x) => x.trim()).filter(Boolean)) {
        if (!bullets.length || /^(what|who|whom|whose|where|when|why|how|which|and\b|if\b|whether)/i.test(l)) bullets.push(l);
        else bullets[bullets.length - 1] += ` ${l}`;
      }
    }
    if (!p1.length && !topic && !p3.length) continue;
    tests.push({ p1, p2: { topic, bullets: bullets.map(clean).filter(Boolean) }, p3 });
  }
  return tests;
}

const shortTitle = (t) => {
  const s = String(t.p2.topic || '').replace(/^describe\s+/i, '').replace(/[.:]$/, '');
  const cut = s.length > 56 ? `${s.slice(0, 54).trim()}…` : s;
  return cut ? cut[0].toUpperCase() + cut.slice(1) : 'Speaking testi';
};

// Sesli okunurken "[Why?]" gibi yönlendirme ipuçları atlanır, "[TV and radio]" gibi seçenekler okunur
const spoken = (q) => q.replace(/\[([^\]]*)\]/g, (m, a) => (/^why/i.test(a.trim()) ? '' : a)).replace(/\s+/g, ' ').trim();

/* ------------------------------------------------------------------ başlatma */

export function initSpeaking(ctx) {
  C = ctx;
  C.main.addEventListener('click', onClick);
  C.main.addEventListener('input', onInput);
}

const inSpeaking = () => String(C.state.view).startsWith('speaking');
const head = (title, sub, extra = '', back = 'home') => `
  <header class="deck-head">
    <button class="icon-btn head-btn" data-sp="${back}" title="Geri (Esc)" aria-label="Geri">${back === 'home' ? C.ICON.home : C.ICON.back.replace(/width="16" height="16"[^>]*/, '')}</button>
    <div class="deck-title"><h1>${esc(title)}</h1><div class="sub">${esc(sub)}</div></div>
    ${extra}
  </header>`;

async function reload() {
  ui.tests = (await dbAll('tests')).sort((a, b) => a.created - b.created);
  ui.attempts = (await dbAll('attempts')).sort((a, b) => b.created - a.created);
}

function setView(view, title) {
  C.leaveStudy();
  C.state.view = view;
  document.body.classList.remove('menu-open');
  C.renderSidebar();
  C.setTitle(title);
}

/* ------------------------------------------------------------------ liste */

export async function showSpeaking() {
  stopRun();
  freeUrls();
  setView('speaking', 'Speaking');
  C.main.innerHTML = '<div class="page"><div class="muted">Yükleniyor…</div></div>';
  try { await reload(); } catch {
    C.main.innerHTML = '<div class="page"><div class="panel empty">Yerel veritabanı açılamadı (gizli pencere olabilir).</div></div>';
    return;
  }
  if (C.state.view !== 'speaking') return;
  const done = ui.attempts.filter((a) => a.report).length;
  C.main.innerHTML = `
    <div class="page">
      ${head('Speaking', `IELTS Speaking · ${ui.tests.length} test · ${ui.attempts.length} deneme`, '<button class="primary" data-sp="import">+ Test ekle</button>')}
      ${ui.tests.length ? `<div class="essay-list">${ui.tests.map((t) => {
        const tries = ui.attempts.filter((a) => a.testId === t.id);
        const best = Math.max(0, ...tries.map((a) => a.report?.overall || 0));
        return `<button class="essay-item" data-sp="setup" data-id="${t.id}">
          <span class="ei-title">${esc(t.title)}</span>
          <span class="ei-meta"><span class="badge">Part 1 · ${t.p1.length} soru</span><span class="badge">Part 2 · kart</span><span class="badge">Part 3 · ${t.p3.length} soru</span>
            ${tries.length ? `<span class="muted">${tries.length} deneme</span>` : '<span class="muted">denenmedi</span>'}
            ${best ? `<span class="ei-ok">en iyi ${best.toFixed(1)}</span>` : ''}</span>
        </button>`;
      }).join('')}</div>` : `<div class="panel empty">Henüz test yok. “+ Test ekle” ile soruları yapıştır ya da bir metin dosyası seç.</div>`}
      ${ui.attempts.length ? `<h2 class="sp-h2">Geçmiş denemeler${done ? ` <small class="muted">· ${done} değerlendirildi</small>` : ''}</h2>
        <div class="essay-list">${ui.attempts.map((a) => `<button class="essay-item" data-sp="result" data-id="${a.id}">
          <span class="ei-title">${esc(a.testTitle)}</span>
          <span class="ei-meta"><span class="badge">${esc(modeLabel(a.mode))}</span>
            ${a.report ? `<span class="ei-ok">Band ${a.report.overall.toFixed(1)}</span>` : '<span class="muted">değerlendirilmedi</span>'}
            <span class="muted">${a.answers.length} cevap · ${dateStr(a.created)}${a.finished ? '' : ' · yarım kaldı'}</span></span>
        </button>`).join('')}</div>` : ''}
    </div>`;
}

const modeLabel = (m) => (MODES.find(([k]) => k === m) || MODES[0])[1];

/* ------------------------------------------------------------------ test ekleme */

function importModal() {
  const form = C.openModal(`
    <h2>Speaking testi ekle</h2>
    <p class="muted" style="font-size:13px">Soruları <b>PART 1 / PART 2 / PART 3</b> başlıklarıyla yapıştır. Her “PART 1” yeni bir test başlatır; birden çok testi arka arkaya yapıştırabilirsin.
      Sorular yalnızca bu cihazda saklanır.</p>
    <label>Sorular<textarea name="txt" rows="10" placeholder="PART 1&#10;1. What's your favourite fruit?&#10;...&#10;PART 2&#10;Describe a time when...&#10;You should say:&#10;what...&#10;and explain...&#10;PART 3&#10;1. ..."></textarea></label>
    <div class="rd-import"><button type="button" data-pick>${ic('upload')} Metin dosyası seç</button></div>
    <input type="file" accept=".txt,text/plain" hidden id="sp-file">
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">Ekle</button>
    </div>`, {
    onSubmit: async (f) => {
      const tests = parseTests(f.txt.value);
      if (!tests.length) { C.toast('Soru bulunamadı. “PART 1”, “PART 2”, “PART 3” başlıklarını kontrol et.', 'info', 4500); return false; }
      let n = ui.tests.length;
      for (const t of tests) {
        n++;
        const rec = { id: uuid(), title: `Test ${n} · ${shortTitle(t)}`, created: Date.now() + n, ...t };
        await dbPut('tests', rec.id, rec);
      }
      C.toast(`${tests.length} test eklendi.`, 'success');
      showSpeaking();
    },
  });
  form.querySelector('[data-pick]').addEventListener('click', () => form.querySelector('#sp-file').click());
  form.querySelector('#sp-file').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (f) form.txt.value = await f.text();
  });
}

/* ------------------------------------------------------------------ başlamadan önce */

async function showSetup(id) {
  const t = ui.tests.find((x) => x.id === id) || (await dbGet('tests', id));
  if (!t) { showSpeaking(); return; }
  ui.setupId = id;
  ui.mode = ui.mode || 'full';
  setView('speaking-setup', 'Speaking');
  const voice = C.prefs.spVoice !== false;
  const text = C.prefs.spText !== false;
  C.main.innerHTML = `
    <div class="page essay-page">
      ${head(t.title, 'Sınav simülasyonu', '', 'hub')}
      <div class="panel sp-setup">
        <h3>Nasıl işleyecek?</h3>
        <ul class="sp-how">
          <li><b>Part 1:</b> ${t.p1.length} kısa soru. Her cevabı bitirince “Sonraki” de.</li>
          <li><b>Part 2:</b> konu kartı gelir; <b>1 dakika hazırlık</b> (not alabilirsin), sonra <b>2 dakika konuşma</b>. Süre dolunca kayıt kendiliğinden durur.</li>
          <li><b>Part 3:</b> ${t.p3.length} tartışma sorusu.</li>
          <li>Konuşman hem <b>ses kaydı</b> hem <b>metin</b> olarak saklanır; bitince dinleyip yapay zekâ değerlendirmesi alabilirsin.</li>
        </ul>
        <div class="sp-modes" role="radiogroup" aria-label="Bölüm">${MODES.map(([k, n, d]) => `
          <label class="sp-mode ${ui.mode === k ? 'on' : ''}"><input type="radio" name="mode" value="${k}" data-sp-mode ${ui.mode === k ? 'checked' : ''}><b>${n}</b><small>${d}</small></label>`).join('')}
        </div>
        <label class="sp-check"><input type="checkbox" data-sp-opt="spVoice" ${voice ? 'checked' : ''}> <span>Sınav görevlisi soruları sesli okusun</span></label>
        <label class="sp-check"><input type="checkbox" data-sp-opt="spText" ${text ? 'checked' : ''}> <span>Soru metni ekranda görünsün <small class="muted">(gerçek sınavda görünmez)</small></span></label>
        ${SR ? '' : '<p class="sp-warn">Bu tarayıcı konuşmayı canlı yazıya çevirmiyor. Ses yine kaydedilir ama metin boş kalır; Chrome ya da Edge kullan veya metni sonradan elle yaz.</p>'}
        <p class="muted" style="font-size:13px">Başlayınca tarayıcı mikrofon izni isteyecek. Sessiz bir yerde, hoparlör yerine kulaklıkla çalışman tanımayı iyileştirir.</p>
        <div class="sp-actions">
          <button class="primary big" data-sp="start" data-id="${t.id}">${ic('mic')} Sınavı başlat</button>
          <button class="danger-ghost" data-sp="del-test" data-id="${t.id}">Testi sil</button>
        </div>
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ sınav akışı */

const INTRO = {
  1: "Good morning. Let's begin. I'm going to ask you some questions about yourself and some familiar topics.",
  2: "Now I'm going to give you a topic, and I'd like you to talk about it for one to two minutes. Before you talk, you'll have one minute to think about what you're going to say, and you can make some notes if you wish. Here's your topic.",
  3: "Thank you. We've been talking about a particular topic, and now I'd like to discuss some more general questions related to it.",
};

function buildSteps(t, mode) {
  const s = [];
  if (mode === 'full' || mode === 'p1') t.p1.forEach((q, i) => s.push({ part: 1, q, n: i + 1, of: t.p1.length, intro: i === 0 ? INTRO[1] : '' }));
  if ((mode === 'full' || mode === 'p2') && t.p2.topic) s.push({ part: 2, q: t.p2.topic, bullets: t.p2.bullets, n: 1, of: 1, intro: INTRO[2] });
  if (mode === 'full' || mode === 'p3') t.p3.forEach((q, i) => s.push({ part: 3, q, n: i + 1, of: t.p3.length, intro: i === 0 ? INTRO[3] : '' }));
  return s;
}

async function voicesReady() {
  const ss = window.speechSynthesis;
  if (!ss || ss.getVoices().length) return;
  await new Promise((res) => { ss.onvoiceschanged = res; setTimeout(res, 1500); });
}
function pickVoice() {
  const en = (window.speechSynthesis?.getVoices() || []).filter((v) => /^en[-_]/i.test(v.lang));
  const gb = en.filter((v) => /^en[-_]GB/i.test(v.lang));
  return gb.find((v) => /natural|online|google/i.test(v.name)) || gb[0] || en.find((v) => /natural|online|google/i.test(v.name)) || en[0] || null;
}

/** Sınav görevlisi konuşur; bitince (ya da atlanınca) çözülür. Kayıt, konuşma bitmeden başlamaz. */
function say(text) {
  return new Promise((res) => {
    const ss = window.speechSynthesis;
    const r = run;
    if (!r?.voice || !ss || !text) { res(); return; }
    const u = new SpeechSynthesisUtterance(text);
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = LANG;
    u.rate = 0.92;
    let done = false;
    const fin = () => { if (done) return; done = true; clearTimeout(guard); if (r.stopSay === cancel) r.stopSay = null; res(); };
    const guard = setTimeout(fin, 4000 + text.length * 110); // bazı tarayıcılarda "bitti" olayı gelmez
    const cancel = () => { ss.cancel(); fin(); };
    r.stopSay = cancel;
    u.onend = u.onerror = fin;
    ss.cancel();
    ss.speak(u);
  });
}

function beep(freq = 880, ms = 180) {
  try {
    const ac = (beep.ac ||= new AudioContext());
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.frequency.value = freq;
    g.gain.value = 0.07;
    o.connect(g);
    g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + ms / 1000);
  } catch { /* ses çıkışı yok */ }
}

async function startRun(testId) {
  const t = ui.tests.find((x) => x.id === testId);
  if (!t) return;
  const steps = buildSteps(t, ui.mode);
  if (!steps.length) { C.toast('Bu testte seçilen bölüm için soru yok.', 'info'); return; }
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    C.toast('Bu tarayıcı ses kaydını desteklemiyor.', 'error', 5000);
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    C.toast('Mikrofona erişilemedi. Tarayıcının adres çubuğundan mikrofon iznini ver.', 'error', 6000);
    return;
  }
  await voicesReady();
  const voice = C.prefs.spVoice !== false && !!window.speechSynthesis;
  run = {
    token: (run?.token || 0) + 1, test: t, mode: ui.mode, steps, i: -1, stream, voice,
    showText: C.prefs.spText !== false || !voice, phase: 'ask', step: null, cap: null, clockT: null,
    attempt: { id: uuid(), testId: t.id, testTitle: t.title, mode: ui.mode, created: Date.now(), finished: false, answers: [], report: null },
    notes: '', analyser: null,
  };
  try {
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(stream);
    run.analyser = ac.createAnalyser();
    run.analyser.fftSize = 512;
    src.connect(run.analyser);
    run.ac = ac;
  } catch { /* seviye göstergesi olmadan devam */ }
  setView('speaking-run', 'Speaking');
  nextStep();
}

function stopRun() {
  const r = run;
  run = null;
  if (!r) return;
  r.token++;
  clearInterval(r.clockT);
  r.stopSay?.();
  window.speechSynthesis?.cancel();
  if (r.cap) {
    r.cap.active = false;
    try { r.cap.sr?.abort(); } catch { /* */ }
    try { if (r.cap.mr?.state !== 'inactive') r.cap.mr.stop(); } catch { /* */ }
  }
  r.stream?.getTracks().forEach((t) => t.stop());
  r.ac?.close().catch(() => {});
}

async function nextStep() {
  const r = run;
  if (!r) return;
  r.i++;
  if (r.i >= r.steps.length) { finishRun(); return; }
  const st = r.steps[r.i];
  const tk = r.token;
  const alive = () => run === r && r.token === tk;
  r.step = st;
  r.notes = '';
  r.phase = 'ask';
  renderRun();
  if (st.intro) await say(st.intro);
  if (!alive()) return;
  if (st.part === 2) {
    await prep();
    if (!alive()) return;
    await capture(P2_TALK, true);
  } else {
    await say(spoken(st.q));
    if (!alive()) return;
    await capture(ANSWER_MAX, false);
  }
  if (alive()) nextStep();
}

/** Saat: sayaç ve ilerleme çubuğunu günceller; süre dolunca onEnd çağrılır. */
function runClock(total, down, onEnd) {
  const r = run;
  clearInterval(r.clockT);
  const t0 = Date.now();
  const tick = () => {
    if (run !== r) return;
    const el = (Date.now() - t0) / 1000;
    const clk = document.getElementById('sp-clock');
    if (clk) clk.textContent = clock(down ? Math.ceil(total - el) : el);
    const bar = document.getElementById('sp-bar');
    if (bar) bar.style.width = `${Math.min(100, (el / total) * 100)}%`;
    if (r.analyser) {
      const d = new Uint8Array(r.analyser.fftSize);
      r.analyser.getByteTimeDomainData(d);
      let m = 0;
      for (const v of d) m = Math.max(m, Math.abs(v - 128));
      document.getElementById('sp-meter')?.style.setProperty('--lv', Math.min(1, m / 60).toFixed(2));
    }
    if (el >= total) { clearInterval(r.clockT); onEnd?.(); }
  };
  r.clockT = setInterval(tick, 200);
  tick();
}

/** Part 2: 1 dakika hazırlık (not alanıyla). */
function prep() {
  return new Promise((resolve) => {
    const r = run;
    r.phase = 'prep';
    renderRun();
    const go = () => { clearInterval(r.clockT); r.advance = null; beep(); resolve(); };
    r.advance = go;
    runClock(P2_PREP, true, go);
  });
}

/** Bir cevabı kaydeder (ses + canlı yazı); kullanıcı bitirince ya da süre dolunca çözülür. */
function capture(limit, countdown) {
  return new Promise((resolve) => {
    const r = run;
    r.phase = 'answer';
    startCapture(r);
    renderRun();
    let ended = false;
    const end = async () => {
      if (ended || run !== r) return;
      ended = true;
      clearInterval(r.clockT);
      r.advance = null;
      const btn = document.querySelector('[data-sp=next]');
      if (btn) { btn.disabled = true; btn.textContent = 'Kaydediliyor…'; }
      if (countdown) beep(660, 260);
      await saveAnswer(r, await stopCapture(r));
      resolve();
    };
    r.advance = end;
    runClock(limit, countdown, end);
  });
}

function startCapture(r) {
  const cap = { t0: Date.now(), chunks: [], final: '', interim: '', stamps: [], first: null, active: true, sr: null, mr: null, fails: 0, lastStart: 0, off: false };
  r.cap = cap;
  try {
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported(m));
    cap.mr = new MediaRecorder(r.stream, mime ? { mimeType: mime } : undefined);
    cap.mr.ondataavailable = (e) => { if (e.data?.size) cap.chunks.push(e.data); };
    cap.mr.start(1000);
  } catch { cap.mr = null; }
  startRecognition(r, cap);
}

// Chrome sürekli dinlemede bile sessizlik/ağ yüzünden kendiliğinden durur: cevap sürdükçe yeniden başlatılır.
function startRecognition(r, cap) {
  if (!SR || !cap.active || cap.off) return;
  const sr = new SR();
  sr.lang = LANG;
  sr.continuous = true;
  sr.interimResults = true;
  sr.maxAlternatives = 1;
  cap.sr = sr;
  cap.lastStart = Date.now();
  sr.onresult = (e) => {
    const now = Date.now();
    cap.stamps.push(now);
    if (cap.first === null) cap.first = now;
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) cap.final += `${e.results[i][0].transcript} `;
      else interim += e.results[i][0].transcript;
    }
    cap.interim = interim;
    const live = document.getElementById('sp-live');
    if (live) live.textContent = `${cap.final}${interim}`.trim() || '…';
  };
  sr.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      cap.off = true;
      C.toast('Konuşma tanıma izni yok; ses kaydedilmeye devam ediyor, metni sonradan yazabilirsin.', 'info', 5000);
    }
  };
  sr.onend = () => {
    if (!cap.active || cap.sr !== sr || cap.off) return;
    if (Date.now() - cap.lastStart < 700) cap.fails++; else cap.fails = 0;
    if (cap.fails >= 4) {
      cap.off = true;
      C.toast('Canlı yazıya çevirme çalışmıyor (internet?). Ses kaydediliyor; metni sonradan yazabilirsin.', 'info', 5000);
      return;
    }
    setTimeout(() => { if (run === r && cap.active) startRecognition(r, cap); }, 120);
  };
  try { sr.start(); } catch { /* zaten çalışıyor */ }
}

async function stopCapture(r) {
  const cap = r.cap;
  cap.active = false;
  const srDone = new Promise((res) => {
    if (!cap.sr) { res(); return; }
    let d = false;
    const fin = () => { if (!d) { d = true; res(); } };
    cap.sr.onend = fin;
    try { cap.sr.stop(); } catch { fin(); }
    setTimeout(fin, 1500);
  });
  const mrDone = new Promise((res) => {
    if (!cap.mr || cap.mr.state === 'inactive') { res(); return; }
    cap.mr.onstop = res;
    try { cap.mr.stop(); } catch { res(); }
    setTimeout(res, 2000);
  });
  await Promise.all([srDone, mrDone]);
  const end = Date.now();
  if (cap.interim.trim()) cap.final += ` ${cap.interim}`;
  const text = cap.final.replace(/\s+/g, ' ').trim();
  const words = wordCount(text);
  const secs = (end - cap.t0) / 1000;
  const speakSecs = cap.first ? (end - cap.first) / 1000 : secs;
  let pauses = 0;
  let maxGap = 0;
  for (let i = 1; i < cap.stamps.length; i++) {
    const g = (cap.stamps[i] - cap.stamps[i - 1]) / 1000;
    if (g > 2.5) pauses++;
    maxGap = Math.max(maxGap, g);
  }
  return {
    text, words, secs: Math.round(secs), wpm: words && speakSecs > 3 ? Math.round(words / (speakSecs / 60)) : null,
    latency: cap.first ? Math.round(((cap.first - cap.t0) / 1000) * 10) / 10 : null,
    pauses, maxGap: Math.round(maxGap * 10) / 10,
    blob: cap.chunks.length ? new Blob(cap.chunks, { type: cap.mr?.mimeType || 'audio/webm' }) : null,
  };
}

async function saveAnswer(r, a) {
  const st = r.step;
  const idx = r.attempt.answers.length;
  const rec = { part: st.part, n: st.n, q: st.q, text: a.text, words: a.words, secs: a.secs, wpm: a.wpm, latency: a.latency,
    pauses: a.pauses, maxGap: a.maxGap, notes: st.part === 2 ? r.notes.trim() : '', audio: !!a.blob, ext: a.blob?.type || '' };
  r.attempt.answers.push(rec);
  try {
    if (a.blob) await dbPut('audio', `${r.attempt.id}:${idx}`, a.blob);
    await dbPut('attempts', r.attempt.id, r.attempt);
  } catch { C.toast('Kayıt cihaza yazılamadı (depolama dolu olabilir).', 'error', 5000); }
}

async function finishRun() {
  const r = run;
  if (!r) return;
  r.attempt.finished = true;
  try { await dbPut('attempts', r.attempt.id, r.attempt); } catch { /* yukarıda uyarıldı */ }
  const id = r.attempt.id;
  stopRun();
  C.toast('Sınav bitti, cevapların kaydedildi.', 'success');
  showResult(id);
}

/* ------------------------------------------------------------------ sınav ekranı */

function renderRun() {
  const r = run;
  if (!r || !r.step) return;
  const st = r.step;
  const live = r.cap?.active ? `${r.cap.final}${r.cap.interim}`.trim() : '';
  const status = {
    ask: ['ask', 'Sınav görevlisi konuşuyor…'],
    prep: ['prep', 'Hazırlık süresi'],
    answer: ['rec', st.part === 2 ? 'Konuş — kayıt alınıyor' : 'Sıra sende — kayıt alınıyor'],
  }[r.phase];
  const total = r.steps.length;
  const showQ = r.showText;
  C.main.innerHTML = `
    <div class="page sp-run">
      <div class="sp-top">
        <span class="badge">${PART_NAME[st.part]}</span>
        <span class="muted">${st.part === 2 ? 'konu kartı' : `soru ${st.n}/${st.of}`} · adım ${r.i + 1}/${total}</span>
        <button class="icon-btn" data-sp="exit" title="Sınavdan çık (Esc)" aria-label="Sınavdan çık">✕</button>
      </div>
      <div class="sp-stage ${status[0]}">
        <div class="sp-status"><span class="sp-dot" id="sp-meter"></span><span>${status[1]}</span>
          ${r.phase === 'ask' ? '' : `<b class="sp-clock" id="sp-clock">${r.phase === 'prep' ? '1:00' : st.part === 2 ? '2:00' : '0:00'}</b>`}</div>
        ${r.phase === 'ask' ? '' : '<div class="sp-barwrap"><div class="sp-bar" id="sp-bar"></div></div>'}
        ${st.part === 2 ? cueCard(st, showQ || r.phase !== 'ask') : (showQ ? `<p class="sp-q">${esc(st.q)}</p>` : '<p class="sp-q muted">Soruyu dinle…</p>')}
        ${r.phase === 'prep' || (r.phase === 'answer' && st.part === 2) ? `
          <label class="sp-notes">Notların${r.phase === 'prep' ? ' <small class="muted">(1 dakika hazırlan; konuşurken de görünür)</small>' : ''}
            <textarea data-sp-notes rows="4" placeholder="Anahtar kelimeler, sıra, örnekler…" ${r.phase === 'prep' ? 'autofocus' : ''}>${esc(r.notes)}</textarea></label>` : ''}
        ${r.phase === 'answer' ? `<div class="sp-livebox"><span class="muted">Canlı metin</span><p id="sp-live">${esc(live) || '…'}</p></div>` : ''}
      </div>
      <div class="sp-actions">
        ${r.phase === 'ask' ? '<button data-sp="skip">Soruyu atla (konuşmayı kes)</button>' : ''}
        ${r.phase === 'prep' ? `<button class="primary big" data-sp="next">Hazırım, konuşmaya başla</button>` : ''}
        ${r.phase === 'answer' ? `<button class="primary big" data-sp="next">${r.i + 1 >= total ? 'Cevabı bitir ve sınavı tamamla' : st.part === 2 ? 'Konuşmayı bitir' : 'Sonraki soru'}</button>` : ''}
      </div>
    </div>`;
}

function cueCard(st, show) {
  if (!show) return '<p class="sp-q muted">Soruyu dinle…</p>';
  return `<div class="sp-card"><p class="sp-q">${esc(st.q)}</p>
    <p class="muted" style="margin:0">You should say:</p>
    <ul>${st.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul></div>`;
}

async function exitRun() {
  if (!run) return;
  const n = run.attempt.answers.length;
  const ok = await C.confirmBox(n ? 'Sınavı yarıda bırakıp çıkmak istiyor musun? Şimdiye kadarki cevapların kaydedilir.' : 'Sınavdan çıkmak istiyor musun?',
    { ok: 'Çık', danger: true });
  if (!ok || !run) return;
  const id = run.attempt.id;
  stopRun();
  if (n) showResult(id); else showSpeaking();
}

/* ------------------------------------------------------------------ sonuç ekranı */

function freeUrls() {
  ui.urls.forEach((u) => URL.revokeObjectURL(u));
  ui.urls = [];
}

async function showResult(id) {
  stopRun();
  freeUrls();
  const a = await dbGet('attempts', id);
  if (!a) { showSpeaking(); return; }
  ui.cur = a;
  ui.edit = new Set();
  setView('speaking-result', 'Speaking');
  renderResult();
  attachAudio(a);
}

async function attachAudio(a) {
  for (let i = 0; i < a.answers.length; i++) {
    if (!a.answers[i].audio) continue;
    const blob = await dbGet('audio', `${a.id}:${i}`).catch(() => null);
    const el = document.getElementById(`sp-au-${i}`);
    if (!blob || !el || ui.cur !== a) continue;
    const url = URL.createObjectURL(blob);
    ui.urls.push(url);
    el.src = url;
  }
}

function markText(text, errors) {
  const low = text.toLowerCase();
  const ranges = [];
  for (const e of errors) {
    const needle = e.original.toLowerCase();
    let from = 0;
    let at = -1;
    while ((at = low.indexOf(needle, from)) >= 0) {
      const end = at + needle.length;
      if (!ranges.some(([s, f]) => at < f && end > s)) { ranges.push([at, end, e]); break; }
      from = at + 1;
    }
  }
  ranges.sort((x, y) => x[0] - y[0]);
  let out = '';
  let pos = 0;
  for (const [s, f, e] of ranges) {
    out += esc(text.slice(pos, s));
    out += `<mark title="${esc(`→ ${e.correction}${e.explanation ? ` — ${e.explanation}` : ''}`)}">${esc(text.slice(s, f))}</mark>`;
    pos = f;
  }
  return out + esc(text.slice(pos));
}

function renderResult() {
  const a = ui.cur;
  if (!a) return;
  const total = a.answers.reduce((t, x) => t + x.secs, 0);
  const words = a.answers.reduce((t, x) => t + wordCount(x.text), 0);
  const parts = [1, 2, 3].filter((p) => a.answers.some((x) => x.part === p));
  C.main.innerHTML = `
    <div class="page sp-result">
      ${head(a.testTitle, `${modeLabel(a.mode)} · ${dateStr(a.created)}`, '', 'hub')}
      <div class="sp-stats">
        <div class="tile"><b>${clock(total)}</b><span class="muted">konuşma süresi</span></div>
        <div class="tile"><b>${words}</b><span class="muted">kelime</span></div>
        <div class="tile"><b>${a.answers.length}</b><span class="muted">cevap</span></div>
        <div class="tile"><b>${a.report ? a.report.overall.toFixed(1) : '—'}</b><span class="muted">tahmini band</span></div>
      </div>
      ${a.report ? reportHtml(a.report) : `<div class="panel sp-cta">
        <h3>IELTS examiner değerlendirmesi</h3>
        <p class="muted">Metin dökümün, IELTS Speaking band tanımlayıcılarına göre bir examiner gibi puanlanır: Fluency &amp; Coherence, Lexical Resource, Grammatical Range &amp; Accuracy. Hataların cümleler içinde işaretlenir.
          <br><b>Not:</b> Telaffuz metinden ölçülemez; genel band bu üç ölçütün ortalamasıdır. Başlamadan önce aşağıdaki metinleri gözden geçir; tanıma hatası varsa düzeltebilirsin.</p>
        <button class="primary" data-sp="evaluate" ${ui.pending ? 'disabled' : ''}>${ui.pending ? 'Değerlendiriliyor…' : 'Yapay zekâ ile değerlendir'}</button>
      </div>`}
      ${parts.map((p) => `
        <h2 class="sp-h2">${PART_NAME[p]}</h2>
        ${a.answers.map((x, i) => (x.part !== p ? '' : answerHtml(x, i, a))).join('')}`).join('')}
      <div class="sp-actions">
        ${a.report ? `<button data-sp="evaluate" ${ui.pending ? 'disabled' : ''}>${ui.pending ? 'Değerlendiriliyor…' : 'Yeniden değerlendir'}</button>` : ''}
        <button class="primary" data-sp="setup" data-id="${a.testId}">Aynı testi tekrar dene</button>
        <button class="danger-ghost" data-sp="del-attempt">Denemeyi sil</button>
      </div>
    </div>`;
}

function answerHtml(x, i, a) {
  const errs = a.report?.errors || [];
  const editing = ui.edit.has(i) || !x.text || !errs.length;
  const stats = [`${x.secs} sn`, `${wordCount(x.text)} kelime`, x.wpm ? `${x.wpm} kelime/dk` : '', x.latency !== null && x.latency !== undefined ? `ilk ses ${x.latency} sn` : '',
    x.pauses ? `${x.pauses} uzun duraklama (en uzun ${x.maxGap} sn)` : ''].filter(Boolean);
  return `<div class="panel sp-ans">
    <p class="sp-aq"><b>${x.part === 2 ? 'Konu' : `Soru ${x.n}`}:</b> ${esc(x.q)}</p>
    ${x.audio ? `<audio id="sp-au-${i}" controls preload="metadata"></audio>` : '<p class="muted">Bu cevap için ses kaydı yok.</p>'}
    <div class="sp-chips">${stats.map((s) => `<span class="badge">${esc(s)}</span>`).join('')}</div>
    ${x.notes ? `<details class="sp-notes-saved"><summary>Hazırlık notların</summary><p>${esc(x.notes)}</p></details>` : ''}
    ${editing
      ? `<textarea class="sp-tr" data-sp-tr="${i}" rows="${Math.min(14, Math.max(3, Math.ceil(x.text.length / 90)))}" placeholder="${SR ? 'Metin tanınamadı. Ne söylediğini buraya yazabilirsin.' : 'Konuşmanın metnini buraya yazabilirsin.'}">${esc(x.text)}</textarea>`
      : `<div class="sp-tr-view">${markText(x.text, errs)}</div><button type="button" class="link" data-sp="edit-tr" data-i="${i}">Metni düzenle</button>`}
  </div>`;
}

function reportHtml(r) {
  const crit = Object.entries(CRIT).map(([k, [en, tr]]) => {
    const c = r.criteria[k];
    return `<div class="sp-crit"><div class="rp-crit-head"><span><b>${en}</b> <small class="muted">${tr}</small></span><b class="rp-score">${c.band.toFixed(1)}</b></div>
      <p>${esc(c.comment)}</p>
      ${c.evidence.length ? `<ul class="sp-ev">${c.evidence.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>` : ''}
      ${c.next_band ? `<p class="muted"><b>Bir üst band için:</b> ${esc(c.next_band)}</p>` : ''}</div>`;
  }).join('');
  const list = (arr) => (arr?.length ? `<ul>${arr.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>` : '');
  return `<div class="panel sp-report">
    <div class="sp-overall"><b class="sp-band">${r.overall.toFixed(1)}</b>
      <div><b>Tahmini genel band</b><p class="muted">Telaffuz hariç üç ölçütün ortalaması (IELTS gibi en yakın yarım banda yuvarlanır). Gerçek sınavda dördüncü ölçüt olan telaffuz da puana girer.</p></div></div>
    ${r.summary ? `<p>${esc(r.summary)}</p>` : ''}
    <div class="sp-crits">${crit}
      <div class="sp-crit dim"><div class="rp-crit-head"><span><b>Pronunciation</b> <small class="muted">Telaffuz</small></span><b class="rp-score">—</b></div>
        <p>${esc(r.pronunciation?.comment || 'Telaffuz yalnızca metinden değerlendirilemez; kayıtlarını kendin dinle ya da bir öğretmene dinlet.')}</p>
        ${r.pronunciation?.watch?.length ? `<ul class="sp-ev">${r.pronunciation.watch.map((w) => `<li>“${esc(w.heard)}”${w.likely ? ` → ${esc(w.likely)}` : ''}${w.note ? ` — ${esc(w.note)}` : ''}</li>`).join('')}</ul>` : ''}</div></div>
    ${r.parts?.length ? `<h3>Bölümlere göre</h3>${r.parts.map((p) => `<p><b>${PART_NAME[p.part]}:</b> ${esc(p.comment)}</p>`).join('')}` : ''}
    <div class="sp-two">
      ${r.strengths?.length ? `<div><h3>Güçlü yönler</h3>${list(r.strengths)}</div>` : ''}
      ${r.improvements?.length ? `<div><h3>Geliştirilecekler</h3>${list(r.improvements)}</div>` : ''}
    </div>
    ${r.errors?.length ? `<h3>Hatalar <small class="muted">(metinlerde sarı işaretli)</small></h3>
      <div class="sp-errs">${r.errors.map((e) => `<div class="sp-err"><span class="sp-orig">${esc(e.original)}</span> <span class="muted">→</span> <b>${esc(e.correction)}</b>
        <span class="badge">${esc(ERR_TYPE[e.type] || e.type)}</span>${e.explanation ? `<p class="muted">${esc(e.explanation)}</p>` : ''}</div>`).join('')}</div>` : ''}
    ${r.upgrades?.length ? `<h3>Daha iyi ifadeler</h3>
      <div class="sp-errs">${r.upgrades.map((u) => `<div class="sp-err"><span class="sp-orig">${esc(u.original)}</span> <span class="muted">→</span> <b>${esc(u.better)}</b>${u.why ? `<p class="muted">${esc(u.why)}</p>` : ''}</div>`).join('')}</div>` : ''}
    ${r.model_answer ? `<h3>Örnek cevap <small class="muted">(senin fikirlerinle, ~band 7-8)</small></h3>
      <p class="muted"><b>${esc(r.model_answer.question)}</b></p><blockquote class="sp-model">${esc(r.model_answer.answer)}</blockquote>` : ''}
    ${r.practice_plan?.length ? `<h3>Bu hafta için çalışma planı</h3>${list(r.practice_plan)}` : ''}
  </div>`;
}

async function evaluate() {
  const a = ui.cur;
  if (!a || ui.pending) return;
  if (a.answers.reduce((t, x) => t + wordCount(x.text), 0) < 60) {
    C.toast('Değerlendirme için metin çok kısa (en az ~60 kelime). Metinleri aşağıdan tamamlayabilirsin.', 'info', 5000);
    return;
  }
  ui.pending = true;
  renderResult();
  C.toast('Değerlendiriliyor… bu 30–90 saniye sürebilir.', 'info', 6000);
  try {
    const report = await C.sync.aiSpeakingReport(a.answers.map((x) => ({
      part: x.part, q: x.q, text: x.text, secs: x.secs, words: wordCount(x.text), wpm: x.wpm, latency: x.latency,
      pauses: x.pauses, maxGap: x.maxGap, notes: x.notes,
    })));
    a.report = { ...report, at: Date.now() };
    await dbPut('attempts', a.id, a);
    C.toast('Değerlendirme hazır.', 'success');
  } catch (e) {
    C.toast(e.message || 'Değerlendirme başarısız.', 'error', 6000);
  } finally {
    ui.pending = false;
    if (ui.cur === a && C.state.view === 'speaking-result') { renderResult(); attachAudio(a); }
  }
}

/* ------------------------------------------------------------------ olaylar */

async function onClick(e) {
  if (!inSpeaking()) return;
  const el = e.target.closest('[data-sp]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.sp) {
    case 'home': C.showHome(); break;
    case 'hub': showSpeaking(); break;
    case 'import': importModal(); break;
    case 'setup': showSetup(id); break;
    case 'result': showResult(id); break;
    case 'start': startRun(id); break;
    case 'skip': run?.stopSay?.(); break;
    case 'next': run?.advance?.(); break;
    case 'exit': exitRun(); break;
    case 'evaluate': evaluate(); break;
    case 'edit-tr': ui.edit.add(Number(el.dataset.i)); renderResult(); attachAudio(ui.cur); break;
    case 'del-test':
      if (await C.confirmBox('Bu test silinsin mi? Bu testteki geçmiş denemelerin korunur.', { ok: 'Sil', danger: true })) {
        await dbDel('tests', id);
        showSpeaking();
      }
      break;
    case 'del-attempt':
      if (ui.cur && await C.confirmBox('Bu deneme (ses kayıtları ve değerlendirme dahil) kalıcı olarak silinsin mi?', { ok: 'Sil', danger: true })) {
        await dbDelRange('audio', `${ui.cur.id}:`, `${ui.cur.id}:￿`).catch(() => {});
        await dbDel('attempts', ui.cur.id);
        showSpeaking();
      }
      break;
    default:
  }
}

function onInput(e) {
  if (!inSpeaking()) return;
  const t = e.target;
  if (t.matches?.('[data-sp-mode]')) {
    ui.mode = t.value;
    C.main.querySelectorAll('.sp-mode').forEach((l) => l.classList.toggle('on', l.contains(t)));
  } else if (t.matches?.('[data-sp-opt]')) {
    C.prefs[t.dataset.spOpt] = t.checked;
    C.savePrefs();
  } else if (t.matches?.('[data-sp-notes]') && run) {
    run.notes = t.value;
  } else if (t.matches?.('[data-sp-tr]') && ui.cur) {
    const x = ui.cur.answers[Number(t.dataset.spTr)];
    if (!x) return;
    x.text = t.value;
    clearTimeout(ui.saveT);
    const cur = ui.cur;
    ui.saveT = setTimeout(() => dbPut('attempts', cur.id, cur).catch(() => {}), 500);
  }
}

/** Esc / geri: işlenirse true. */
export function speakingBack() {
  const v = C.state.view;
  if (v === 'speaking-run') { exitRun(); return true; }
  if (v === 'speaking-setup' || v === 'speaking-result') { showSpeaking(); return true; }
  if (v === 'speaking') { C.showHome(); return true; }
  return false;
}

/** Sekme/pencere kapanırken ya da başka ekrana geçilirken: kayıt ve mikrofon serbest bırakılır. */
export function leaveSpeaking() {
  stopRun();
  freeUrls();
}

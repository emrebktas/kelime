'use strict';

/* =========================================================== yardımcılar */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nowSec = () => Math.floor(Date.now() / 1000);

// [kod, Türkçe ad, konuşma dili etiketi]
const LANGS = [
  ['en', 'İngilizce', 'en-GB'], ['de', 'Almanca', 'de-DE'], ['fr', 'Fransızca', 'fr-FR'],
  ['es', 'İspanyolca', 'es-ES'], ['it', 'İtalyanca', 'it-IT'], ['nl', 'Felemenkçe', 'nl-NL'],
  ['pt', 'Portekizce', 'pt-PT'], ['ru', 'Rusça', 'ru-RU'], ['ar', 'Arapça', 'ar-SA'],
  ['ja', 'Japonca', 'ja-JP'], ['zh', 'Çince', 'zh-CN'], ['ko', 'Korece', 'ko-KR'], ['tr', 'Türkçe', 'tr-TR'],
];
const LANG_WORDS = {
  english: 'en', ingilizce: 'en', german: 'de', almanca: 'de', deutsch: 'de', french: 'fr', fransızca: 'fr',
  spanish: 'es', ispanyolca: 'es', italian: 'it', italyanca: 'it', russian: 'ru', rusça: 'ru', turkish: 'tr', türkçe: 'tr',
};
const langInfo = (code) => LANGS.find((l) => l[0] === code) || [code, (code || '?').toUpperCase(), code];
const langName = (code) => langInfo(code)[1];
const DIRECTIONS = { front: 'Kelime → Türkçe', back: 'Türkçe → Kelime', mixed: 'Karışık' };

const ICON = {
  speaker: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 18-6-6 6-6"/></svg>',
};

const prefs = (() => {
  try { return JSON.parse(localStorage.getItem('kelime.prefs')) || {}; } catch { return {}; }
})();
const savePrefs = () => { try { localStorage.setItem('kelime.prefs', JSON.stringify(prefs)); } catch { /* yok say */ } };

const state = {
  view: 'home',       // home | deck | study
  decks: [],
  deckId: null,
  search: '',
  cards: new Map(),
  selected: new Set(),
  study: null,        // { res, flipped, reverse, busy, timer }
};
const main = $('#main');
const deckById = (id) => state.decks.find((d) => d.id === id);

async function api(name, ...args) {
  const res = await window.pywebview.api[name](...args);
  if (res && res.ok === false) throw new Error(res.error);
  return res ? res.data : undefined;
}

function toast(msg, kind = 'info', ms = 3200) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-root').append(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 260); }, ms);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { console.error(e); toast(e.message || String(e), 'error', 5000); }
}

/* =========================================================== tema / ses */

function applyTheme() {
  const mode = prefs.theme || 'system';
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('#btn-theme').textContent = { system: '◐ Sistem', light: '☀ Açık', dark: '☾ Koyu' }[mode];
  $('#btn-autospeak').textContent = prefs.autoSpeak ? '🔊 Oto ses: açık' : '🔈 Oto ses: kapalı';
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

let voices = [];
const loadVoices = () => { voices = speechSynthesis.getVoices(); };
speechSynthesis.addEventListener('voiceschanged', loadVoices);
loadVoices();
const warnedLangs = new Set();

// Doğal (çevrimiçi) ses: mp3 data URL'leri; Python tarafı diske de önbelleğe alır.
const audioCache = new Map();
let currentAudio = null;
let speakToken = 0;

function getAudio(text, lang) {
  const key = `${lang}|${text}`;
  if (!audioCache.has(key)) {
    audioCache.set(key, api('tts', text, lang).catch(() => { audioCache.delete(key); return null; }));
  }
  return audioCache.get(key);
}

function prefetchAudio(card, lang) {
  if (!card) return;
  getAudio(card.word, lang);
  if (card.sentence) getAudio(card.sentence, lang);
}

function stopSpeech() {
  speakToken++;
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  speechSynthesis.cancel();
}

async function speak(text, lang) {
  if (!text) return;
  stopSpeech();
  const token = speakToken;
  const url = await getAudio(text, lang);
  if (token !== speakToken) return;
  if (url) {
    currentAudio = new Audio(url);
    currentAudio.play().catch(() => {});
    return;
  }
  localSpeak(text, lang);
}

// İnternet yoksa: sadece o dile ait yerel Windows sesiyle oku (başka aksana düşme).
function localSpeak(text, lang) {
  const tag = langInfo(lang)[2] || lang;
  const base = tag.split('-')[0].toLowerCase();
  const norm = (v) => v.lang.toLowerCase().replace('_', '-');
  const cands = voices.filter((v) => norm(v).startsWith(base));
  const voice = cands.find((v) => norm(v) === tag.toLowerCase()) || cands[0];
  if (!voice) {
    if (!warnedLangs.has(base)) {
      warnedLangs.add(base);
      toast(`Seslendirme için internet gerekli: bilgisayarda ${langName(lang)} ses paketi yüklü değil.`, 'info', 6000);
    }
    return;
  }
  const u = new SpeechSynthesisUtterance(text);
  u.lang = tag;
  u.voice = voice;
  u.rate = 0.95;
  speechSynthesis.speak(u);
}

/* =========================================================== modal */

let modalOnClose = null;

function openModal(html, { onSubmit, onClose, wide } = {}) {
  closeModal();
  const root = $('#modal-root');
  root.innerHTML = `<div class="backdrop"><form class="modal ${wide ? 'wide' : ''}" novalidate>${html}</form></div>`;
  const form = $('form', root);
  modalOnClose = onClose || null;
  $('.backdrop', root).addEventListener('mousedown', (e) => { if (e.target === e.currentTarget) closeModal(); });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    try {
      const r = await onSubmit?.(form);
      if (r !== false) closeModal();
    } catch (err) {
      toast(err.message || String(err), 'error', 5000);
    } finally {
      delete form.dataset.busy;
    }
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); form.requestSubmit(); }
  });
  $$('[data-close]', form).forEach((b) => b.addEventListener('click', closeModal));
  setTimeout(() => ($('[autofocus]', form) || $('input,textarea,select,button', form))?.focus(), 0);
  return form;
}

function closeModal() {
  const cb = modalOnClose;
  modalOnClose = null;
  $('#modal-root').innerHTML = '';
  cb?.();
}
const modalOpen = () => !!$('#modal-root .backdrop');

function confirmBox(message, { ok = 'Evet', danger = false, title = 'Emin misin?' } = {}) {
  return new Promise((resolve) => {
    let yes = false;
    openModal(`
      <h2>${esc(title)}</h2>
      <p class="muted">${esc(message)}</p>
      <div class="modal-actions">
        <button type="button" data-close>Vazgeç</button>
        <button type="submit" class="${danger ? 'danger' : 'primary'}" autofocus>${esc(ok)}</button>
      </div>`, { onSubmit: () => { yes = true; }, onClose: () => resolve(yes) });
  });
}

const langOptions = (sel) => {
  const list = LANGS.some((l) => l[0] === sel) ? LANGS : [...LANGS, [sel, sel.toUpperCase()]];
  return list.map(([c, n]) => `<option value="${esc(c)}" ${c === sel ? 'selected' : ''}>${esc(n)} (${esc(c)})</option>`).join('');
};
const dirOptions = (sel) => Object.entries(DIRECTIONS)
  .map(([v, n]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${n}</option>`).join('');

/* =========================================================== kenar çubuğu */

const num = (n, cls) => `<span class="${n ? cls : 'zero'}">${n}</span>`;

async function refreshDecks() {
  state.decks = await api('get_decks');
  renderSidebar();
}

function renderSidebar() {
  $('#deck-list').innerHTML = state.decks.length
    ? state.decks.map((d) => `
      <button class="deck-item ${d.id === state.deckId && state.view !== 'home' ? 'active' : ''}" data-deck="${d.id}" title="${esc(d.name)}">
        <span class="deck-name">${esc(d.name)}</span>
        <span class="lang">${esc(d.language.toUpperCase())}</span>
        <span class="counts">${num(d.new, 'n-new')}${num(d.learn, 'n-learn')}${num(d.review, 'n-review')}</span>
      </button>`).join('')
    : '<div class="empty-side">Henüz deste yok. “+ Yeni deste” ile oluştur ya da bir JSON dosyası içe aktar.</div>';
}

/* =========================================================== ana sayfa */

const EXAMPLE_JSON = `{
  "deck": "IELTS Kelimeler",
  "language": "en",
  "cards": [
    {
      "word": "abundant",
      "translation": "bol, bereketli",
      "sentence": "The region has abundant natural resources.",
      "synonyms": ["plentiful", "ample", "copious"]
    }
  ]
}`;

function showHome() {
  leaveStudy();
  state.view = 'home';
  renderSidebar();
  const due = state.decks.reduce((a, d) => a + d.new + d.learn + d.review, 0);
  main.innerHTML = `
    <div class="page">
      <div class="hero">
        <div>
          <h1>Merhaba 👋</h1>
          <div class="muted">${state.decks.length
            ? (due ? `Bugün toplam <b>${due}</b> kart seni bekliyor.` : 'Bugünlük her şey tamam. Harika iş!')
            : 'Başlamak için bir deste oluştur ya da JSON dosyası içe aktar.'}</div>
        </div>
        <div class="head-actions">
          <button data-act="import">JSON içe aktar</button>
          <button class="primary" data-act="new-deck">+ Yeni deste</button>
        </div>
      </div>
      ${state.decks.length ? `<div class="tiles">${state.decks.map((d) => `
        <button class="tile" data-deck="${d.id}">
          <span class="t-name">${esc(d.name)}</span>
          <span class="t-sub">${esc(langName(d.language))} · ${d.total} kart</span>
          <span class="counts">${num(d.new, 'n-new')}${num(d.learn, 'n-learn')}${num(d.review, 'n-review')}</span>
        </button>`).join('')}</div>` : ''}
      <div class="panel">
        <h3>JSON formatı</h3>
        <div class="muted">Dosyayı pencereye sürükleyip bırakabilir ya da “İçe aktar” butonunu kullanabilirsin.
          Alan adları esnektir: <code>word</code>/<code>kelime</code>, <code>translation</code>/<code>turkish</code>,
          <code>sentence</code>/<code>example</code>, <code>synonyms</code>. Bunların dışındaki alanlar
          (ör. <code>article</code>, <code>plural</code>) kartın arkasında ek bilgi olarak gösterilir.
          Sadece kart dizisi (<code>[ {...}, {...} ]</code>) de kabul edilir.</div>
        <pre class="code">${esc(EXAMPLE_JSON)}</pre>
      </div>
    </div>`;
}

/* =========================================================== deste sayfası */

async function openDeck(id) {
  leaveStudy();
  if (state.deckId !== id) { state.search = ''; state.selected.clear(); }
  state.deckId = id;
  state.view = 'deck';
  prefs.lastDeck = id;
  savePrefs();
  renderSidebar();
  await renderDeck();
}

async function renderDeck() {
  const d = deckById(state.deckId);
  if (!d) return showHome();
  const st = await api('get_deck_stats', d.id);
  if (state.view !== 'deck' || state.deckId !== d.id) return;
  main.innerHTML = `
    <div class="page">
      <header class="deck-head">
        <div>
          <h1>${esc(d.name)}</h1>
          <div class="sub">
            <span class="badge">${esc(langName(d.language))}</span>
            <span>${d.total} kart · günde ${d.new_per_day} yeni · ${DIRECTIONS[d.direction] || ''}</span>
          </div>
        </div>
        <div class="head-actions">
          <button data-act="import-into">İçe aktar</button>
          <button data-act="export">Dışa aktar</button>
          <button data-act="edit-deck">Ayarlar</button>
          <button class="danger-ghost" data-act="delete-deck">Sil</button>
        </div>
      </header>

      <section class="study-panel">
        <div class="due-grid">
          <div class="due new"><b>${d.new}</b><span>Yeni</span></div>
          <div class="due learn"><b>${d.learn}</b><span>Öğreniliyor</span></div>
          <div class="due review"><b>${d.review}</b><span>Tekrar</span></div>
        </div>
        <div class="grow"></div>
        <button class="primary big" data-act="study">Çalışmaya başla <kbd>Enter</kbd></button>
        <div class="mini-stats">
          <span>Bugün: <b>${st.today}</b> cevap${st.today ? ` · <b>%${st.today_correct}</b> doğru` : ''}</span>
          <span>Yeni: <b>${st.new}</b></span>
          <span>Öğreniliyor: <b>${st.learning}</b></span>
          <span>Genç: <b>${st.young}</b></span>
          <span>Olgun (21+ gün): <b>${st.mature}</b></span>
        </div>
      </section>

      <section>
        <div class="cards-toolbar">
          <input id="card-search" type="search" placeholder="Kartlarda ara…  (Ctrl+F)" value="${esc(state.search)}">
          <button class="primary" data-act="add-card">+ Kart ekle <kbd>N</kbd></button>
        </div>
        <div id="bulk"></div>
        <div id="card-table"></div>
      </section>
    </div>`;
  let t;
  $('#card-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.search = e.target.value; loadCards(); }, 160);
  });
  await loadCards();
}

function stateBadge(c) {
  if (c.state === 0) return '<span class="st new">Yeni</span>';
  if (c.state === 1 || c.state === 3) return '<span class="st learn">Öğreniliyor</span>';
  const diff = c.due - nowSec();
  const label = diff <= 0 ? 'Bugün' : (diff < 86400 ? 'Yarın' : `${Math.ceil(diff / 86400)} gün sonra`);
  return `<span class="st review" title="Aralık: ${c.ivl} gün · ${c.reps} tekrar · ${c.lapses} unutma">${label}</span>`;
}

async function loadCards() {
  const deckId = state.deckId;
  const res = await api('list_cards', deckId, state.search, 1000);
  if (state.view !== 'deck' || state.deckId !== deckId) return;
  state.cards = new Map(res.cards.map((c) => [c.id, c]));
  for (const id of [...state.selected]) if (!state.cards.has(id)) state.selected.delete(id);
  const box = $('#card-table');
  if (!res.cards.length) {
    box.innerHTML = `<div class="table-wrap"><div class="empty">${state.search
      ? 'Aramayla eşleşen kart yok.'
      : 'Bu deste boş. “+ Kart ekle” ile kart ekle ya da bir JSON dosyası içe aktar.'}</div></div>`;
  } else {
    box.innerHTML = `
      <div class="table-wrap">
        <table class="cards">
          <thead><tr>
            <th class="chk"><input type="checkbox" id="chk-all" title="Tümünü seç"></th>
            <th>Kelime</th><th>Türkçesi</th><th>Eş anlamlılar</th><th class="c-state">Durum</th>
          </tr></thead>
          <tbody>${res.cards.map((c) => `
            <tr data-card="${c.id}" class="${state.selected.has(c.id) ? 'sel' : ''}">
              <td class="chk"><input type="checkbox" data-chk="${c.id}" ${state.selected.has(c.id) ? 'checked' : ''}></td>
              <td class="w" title="${esc(c.word)}">${esc(c.word)}</td>
              <td title="${esc(c.translation)}">${esc(c.translation)}</td>
              <td class="muted">${esc(c.synonyms.join(', '))}</td>
              <td class="c-state">${stateBadge(c)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
        ${res.total > res.cards.length ? `<div class="table-note">${res.total} karttan ilk ${res.cards.length} tanesi gösteriliyor. Daraltmak için arama kullan.</div>` : ''}
      </div>`;
  }
  renderBulk();
}

function renderBulk() {
  const box = $('#bulk');
  if (!box) return;
  const n = state.selected.size;
  const all = $('#chk-all');
  if (all) {
    all.checked = n > 0 && n === state.cards.size;
    all.indeterminate = n > 0 && n < state.cards.size;
  }
  if (!n) { box.innerHTML = ''; return; }
  const others = state.decks.filter((d) => d.id !== state.deckId);
  box.innerHTML = `
    <div class="bulk">
      <span class="sel-n">${n} kart seçili</span>
      <button class="ghost" data-act="bulk-reset" title="Çalışma ilerlemesini sıfırla, yeni kart yap">Sıfırla</button>
      ${others.length ? `<select id="bulk-move"><option value="">Başka desteye taşı…</option>
        ${others.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>` : ''}
      <button class="danger-ghost" data-act="bulk-delete">Sil</button>
      <span style="flex:1"></span>
      <button class="ghost" data-act="bulk-clear">Seçimi kaldır</button>
    </div>`;
  $('#bulk-move')?.addEventListener('change', (e) => {
    const target = +e.target.value;
    if (!target) return;
    guard(async () => {
      const r = await api('move_cards', [...state.selected], target);
      toast(`${r.moved} kart taşındı${r.skipped ? `, ${r.skipped} kart hedefte zaten olduğu için atlandı` : ''}.`, 'success');
      state.selected.clear();
      await refreshDecks();
      await renderDeck();
    });
  });
}

/* =========================================================== formlar */

function deckForm(deck) {
  const d = deck || { name: '', language: 'en', new_per_day: 20, direction: 'front' };
  openModal(`
    <h2>${deck ? 'Deste ayarları' : 'Yeni deste'}</h2>
    <label>Ad<input name="name" value="${esc(d.name)}" placeholder="ör. IELTS Academic, Goethe B1" autofocus></label>
    <div class="row2">
      <label>Dil<select name="language">${langOptions(d.language)}</select></label>
      <label>Günlük yeni kart<input name="new_per_day" type="number" min="0" max="9999" value="${d.new_per_day}"></label>
    </div>
    <label>Kart yönü<select name="direction">${dirOptions(d.direction)}</select></label>
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">${deck ? 'Kaydet' : 'Oluştur'}</button>
    </div>`, {
    onSubmit: async (f) => {
      const data = Object.fromEntries(new FormData(f));
      data.new_per_day = parseInt(data.new_per_day, 10) || 0;
      if (!data.name.trim()) { toast('Deste adı boş olamaz.', 'error'); return false; }
      const saved = deck ? await api('update_deck', deck.id, data) : await api('create_deck', data);
      await refreshDecks();
      await openDeck(saved.id);
    },
  });
}

const parseExtra = (text) => Object.fromEntries((text || '').split('\n')
  .map((l) => l.split(/:(.*)/s).map((s) => s.trim()))
  .filter(([k, v]) => k && v));

function cardForm(card, deckId, after) {
  const c = card || { word: '', translation: '', sentence: '', synonyms: [], notes: '', extra: {} };
  const extraText = Object.entries(c.extra || {}).map(([k, v]) => `${k}: ${v}`).join('\n');
  const form = openModal(`
    <h2>${card ? 'Kartı düzenle' : 'Yeni kart'}</h2>
    <div class="row2">
      <label>Kelime<input name="word" value="${esc(c.word)}" autofocus></label>
      <label>Türkçesi<input name="translation" value="${esc(c.translation)}"></label>
    </div>
    <label>Örnek cümle<textarea name="sentence" rows="2">${esc(c.sentence)}</textarea></label>
    <label>Eş anlamlılar <small>virgülle ayır</small><input name="synonyms" value="${esc(c.synonyms.join(', '))}"></label>
    <label>Not<textarea name="notes" rows="2">${esc(c.notes)}</textarea></label>
    <details ${extraText ? 'open' : ''}>
      <summary>Ek alanlar</summary>
      <textarea name="extra" rows="3" placeholder="artikel: der&#10;plural: die Hunde">${esc(extraText)}</textarea>
    </details>
    <div class="modal-actions">
      ${card ? '<button type="button" class="danger-ghost" data-act="modal-delete">Sil</button><span class="spacer"></span>' : ''}
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">${card ? 'Kaydet' : 'Ekle'} <kbd>Ctrl+Enter</kbd></button>
    </div>`, {
    wide: true,
    onSubmit: async (f) => {
      const fd = Object.fromEntries(new FormData(f));
      const data = {
        id: card?.id, deck_id: deckId,
        word: fd.word.trim(), translation: fd.translation.trim(), sentence: fd.sentence.trim(),
        synonyms: fd.synonyms.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
        notes: fd.notes.trim(), extra: parseExtra(fd.extra),
      };
      if (!data.word) { toast('Kelime boş olamaz.', 'error'); return false; }
      const saved = await api('save_card', data);
      await after?.(saved);
      if (!card) {
        // Yeni kart: form açık kalsın, art arda ekleme yapılabilsin
        toast(`“${saved.word}” eklendi.`, 'success', 1800);
        f.reset();
        $('details', f).open = false;
        $('[name=word]', f).focus();
        return false;
      }
    },
  });
  $('[data-act=modal-delete]', form)?.addEventListener('click', async () => {
    if (!(await confirmBox(`“${c.word}” kartı silinecek.`, { ok: 'Sil', danger: true }))) return cardForm(card, deckId, after);
    await guard(async () => {
      await api('delete_cards', [card.id]);
      toast('Kart silindi.');
      await after?.(null);
    });
  });
}

/* =========================================================== içe aktarma */

function normLang(v) {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  return LANG_WORDS[s] || s.split(/[-_]/)[0].slice(0, 12);
}

function guessLang(cards) {
  const words = cards.slice(0, 40).map((c) => {
    if (!c || typeof c !== 'object') return '';
    const k = Object.keys(c).find((x) => ['word', 'term', 'front', 'kelime', 'wort'].includes(x.toLowerCase()));
    return k ? String(c[k]) : '';
  });
  const de = words.filter((w) => /[äöüß]/i.test(w) || /^(der|die|das)\s/i.test(w)).length;
  return de >= Math.max(1, words.length * 0.15) ? 'de' : 'en';
}

function parseImport(text, filename) {
  let data;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) { throw new Error(`JSON okunamadı: ${e.message}`); }
  const base = filename.replace(/\.[^.]+$/, '');
  const pick = (o, ...keys) => {
    for (const k of keys) {
      const hit = Object.keys(o).find((x) => x.toLowerCase() === k);
      if (hit !== undefined) return o[hit];
    }
  };
  const one = (o, fallback) => {
    if (Array.isArray(o)) return { name: fallback, language: guessLang(o), cards: o };
    if (!o || typeof o !== 'object') return null;
    const cards = pick(o, 'cards', 'words', 'kartlar', 'kelimeler', 'items', 'vocabulary');
    if (!Array.isArray(cards)) return null;
    return {
      name: String(pick(o, 'deck', 'name', 'deste', 'title', 'klasör', 'klasor') || fallback),
      language: normLang(pick(o, 'language', 'lang', 'dil')) || guessLang(cards),
      cards,
    };
  };
  let decks = [];
  const multi = data && !Array.isArray(data) && typeof data === 'object' ? pick(data, 'decks', 'desteler') : null;
  if (Array.isArray(multi)) decks = multi.map((d, i) => one(d, `${base} ${i + 1}`)).filter(Boolean);
  else { const d = one(data, base); if (d) decks = [d]; }
  // { "abandon": { "translation": ... }, ... } biçimi
  if (!decks.length && data && typeof data === 'object' && !Array.isArray(data)) {
    const entries = Object.entries(data);
    if (entries.length && entries.every(([, v]) => v && typeof v === 'object' && !Array.isArray(v))) {
      const cards = entries.map(([k, v]) => ({ word: k, ...v }));
      decks = [{ name: base, language: guessLang(cards), cards }];
    }
  }
  if (!decks.length) throw new Error('Dosyada kart listesi bulunamadı. Örnek format için ana sayfaya bak.');
  return decks;
}

function sampleOf(cards) {
  const c = cards.find((x) => x && typeof x === 'object');
  if (!c) return '';
  return Object.entries(c).slice(0, 4).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
}

async function importFlow(presetDeckId) {
  const f = await api('pick_import_file');
  if (f) importText(f.name, f.text, presetDeckId);
}

function importText(filename, text, presetDeckId) {
  let decks;
  try { decks = parseImport(text, filename); } catch (e) { toast(e.message, 'error', 6000); return; }
  const finish = async (results) => {
    const sum = results.reduce((a, r) => ({ added: a.added + r.added, updated: a.updated + r.updated, skipped: a.skipped + r.skipped }), { added: 0, updated: 0, skipped: 0 });
    toast(`${sum.added} kart eklendi${sum.updated ? `, ${sum.updated} kart güncellendi` : ''}${sum.skipped ? `, ${sum.skipped} geçersiz kayıt atlandı` : ''}.`, 'success', 4500);
    await refreshDecks();
    await openDeck(results[results.length - 1].deck_id);
  };
  const findDeck = (name) => state.decks.find((d) => d.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'));

  if (decks.length > 1) {
    openModal(`
      <h2>İçe aktar</h2>
      <p class="muted">${esc(filename)} içinde ${decks.length} deste bulundu. Aynı isimli deste varsa kartlar onun içine eklenir.</p>
      <ul class="import-list">${decks.map((d) => `
        <li><span><b>${esc(d.name)}</b> <span class="muted">· ${esc(langName(d.language))}</span></span>
        <span class="muted">${d.cards.length} kart · ${findDeck(d.name) ? 'mevcut desteye' : 'yeni deste'}</span></li>`).join('')}
      </ul>
      <div class="modal-actions">
        <button type="button" data-close>Vazgeç</button>
        <button type="submit" class="primary">İçe aktar</button>
      </div>`, {
      onSubmit: async () => {
        const results = [];
        for (const d of decks) results.push(await api('import_cards', { name: d.name, language: d.language }, d.cards));
        await finish(results);
      },
    });
    return;
  }

  const d = decks[0];
  const match = presetDeckId ? deckById(presetDeckId) : findDeck(d.name);
  const useExisting = !!match;
  const form = openModal(`
    <h2>İçe aktar</h2>
    <p class="muted">${esc(filename)} · <b>${d.cards.length}</b> kart bulundu.</p>
    ${d.cards.length ? `<div class="sample">${esc(sampleOf(d.cards))}</div>` : ''}
    <div class="import-option ${useExisting ? 'disabled' : ''}" data-opt="new">
      <label class="radio"><input type="radio" name="mode" value="new" ${useExisting ? '' : 'checked'}> Yeni deste oluştur</label>
      <div class="row2">
        <label>Ad<input name="name" value="${esc(d.name)}"></label>
        <label>Dil<select name="language">${langOptions(d.language)}</select></label>
      </div>
    </div>
    ${state.decks.length ? `
    <div class="import-option ${useExisting ? '' : 'disabled'}" data-opt="existing">
      <label class="radio"><input type="radio" name="mode" value="existing" ${useExisting ? 'checked' : ''}> Mevcut desteye ekle</label>
      <select name="deck_id">${state.decks.map((x) => `<option value="${x.id}" ${match && x.id === match.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    </div>` : ''}
    <p class="muted" style="font-size:12.5px">Destede zaten olan kelimelerin içeriği güncellenir, çalışma ilerlemesi korunur.</p>
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">İçe aktar</button>
    </div>`, {
    onSubmit: async (f) => {
      const fd = Object.fromEntries(new FormData(f));
      const target = fd.mode === 'existing'
        ? { deck_id: +fd.deck_id }
        : { name: fd.name.trim() || d.name, language: fd.language };
      await finish([await api('import_cards', target, d.cards)]);
    },
  });
  $$('input[name=mode]', form).forEach((r) => r.addEventListener('change', () => {
    $$('.import-option', form).forEach((o) => o.classList.toggle('disabled', o.dataset.opt !== r.value));
  }));
}

/* =========================================================== çalışma */

function wordForms(word) {
  const w = word.trim();
  const forms = [w];
  const parts = w.split(/\s+/);
  if (parts.length > 1 && /^(der|die|das|ein|eine|the|to|a|an|le|la|les|l'|el|los|las|il|lo|sich)$/i.test(parts[0])) {
    forms.push(parts.slice(1).join(' '));
  }
  return forms.filter((f) => f.length > 1).sort((a, b) => b.length - a.length);
}

// Cümlede kelimeyi (ve çekimli hâlini: abandon → abandoned) bulup işaretler.
function markWord(sentence, word, repl) {
  const forms = wordForms(word);
  let html = esc(sentence);
  let hit = false;
  if (forms.length) {
    const re = new RegExp(`(?<![\\p{L}])(?:${forms.map((f) => reEsc(esc(f))).join('|')})\\p{L}*`, 'giu');
    html = html.replace(re, (m) => { hit = true; return repl(m); });
  }
  return { html: html.replace(/\n/g, '<br>'), hit };
}

function renderFaces(card, reverse, flipped) {
  const speakBtn = (act, small) => `<button type="button" class="icon-btn ${small ? 'small' : ''}" data-act="${act}" title="Seslendir${act === 'speak' ? ' (R)' : ''}">${ICON.speaker}</button>`;
  const word = `<div class="word">${esc(card.word)}${speakBtn('speak')}</div>`;
  const sentence = card.sentence
    ? `<div class="sentence">${markWord(card.sentence, card.word, (m) => `<mark>${m}</mark>`).html} ${speakBtn('speak-sentence', true)}</div>` : '';
  const syn = card.synonyms.length
    ? `<div class="synonyms"><span class="label">Eş anlamlılar:</span>${card.synonyms.map((s) => `<span class="chip">${esc(s)}</span>`).join('')}</div>` : '';
  const notes = card.notes ? `<div class="notes">${esc(card.notes)}</div>` : '';
  const extraEntries = Object.entries(card.extra || {});
  const extra = extraEntries.length
    ? `<dl class="extra">${extraEntries.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';

  let front;
  let back;
  if (!reverse) {
    front = word;
    back = (card.translation ? `<div class="translation">${esc(card.translation)}</div>` : '') + sentence + syn + notes + extra;
  } else {
    const blanked = card.sentence ? markWord(card.sentence, card.word, () => '<span class="blank">&nbsp;</span>') : null;
    front = `<div class="translation-big">${esc(card.translation || '—')}</div>`
      + (blanked?.hit ? `<div class="sentence hint">${blanked.html}</div>` : '');
    back = word + sentence + syn + notes + extra;
  }
  return `<div class="face front">${front}</div>${flipped ? `<div class="divider"></div><div class="face back">${back}</div>` : ''}`;
}

function leaveStudy() {
  if (state.study?.timer) clearTimeout(state.study.timer);
  state.study = null;
  stopSpeech();
}

async function startStudy() {
  const deckId = state.deckId;
  const res = await api('next_card', deckId);
  leaveStudy();
  state.view = 'study';
  renderSidebar();
  showStudyCard(res);
}

function showStudyCard(res) {
  const deck = deckById(state.deckId);
  if (state.study?.timer) clearTimeout(state.study.timer);
  const reverse = deck?.direction === 'back' || (deck?.direction === 'mixed' && Math.random() < 0.5);
  state.study = { res, flipped: false, reverse, busy: false, timer: null };
  renderStudy();
  prefetchAudio(res.card, deck?.language);
  if (res.card && !reverse && prefs.autoSpeak) speak(res.card.word, deck.language);
}

function renderStudy() {
  const s = state.study;
  const deck = deckById(state.deckId);
  const { res } = s;
  const card = res.card;
  const cur = card ? (card.state === 0 ? 'new' : card.state === 2 ? 'review' : 'learn') : '';
  const c = res.counts;
  let body;
  let bar = '';
  if (!card) {
    const left = res.next_due ? res.next_due - nowSec() : 0;
    body = `
      <div class="done">
        <div class="big-emoji">🎉</div>
        <h2>Bu deste için bugünlük bu kadar!</h2>
        <p class="muted">${res.next_due
          ? `Sıradaki öğrenme kartı yaklaşık ${Math.max(1, Math.round(left / 60))} dakika sonra hazır olacak; bu ekran açık kalırsa kendiliğinden gelir.`
          : 'Yarın yeni kartlar ve tekrarlar seni bekliyor.'}</p>
        <button class="primary" data-act="back-deck">Desteye dön <kbd>Esc</kbd></button>
      </div>`;
    if (res.next_due) {
      // öğrenme kartı "öne alma" penceresine (20 dk) girince otomatik yenile
      const wait = Math.max(5, left - 20 * 60 + 2) * 1000;
      s.timer = setTimeout(() => guard(async () => {
        if (state.study === s) showStudyCard(await api('next_card', state.deckId));
      }), Math.min(wait, 2 ** 31 - 1));
    }
  } else {
    body = `<div class="card-stage"><div class="flash">${renderFaces(card, s.reverse, s.flipped)}</div></div>`;
    bar = s.flipped
      ? `<div class="answer-bar">${[[1, 'Tekrar', 'again'], [2, 'Zor', 'hard'], [3, 'İyi', 'good'], [4, 'Kolay', 'easy']].map(([r, label, cls]) => `
          <button class="rate ${cls}" data-act="rate" data-r="${r}">
            <span class="ivl">${esc(res.previews[r])}</span><span>${label}</span><kbd>${r}</kbd>
          </button>`).join('')}</div>`
      : '<div class="answer-bar"><button class="primary big" data-act="flip">Cevabı göster <kbd>Space</kbd></button></div>';
  }
  main.innerHTML = `
    <div class="study">
      <div class="study-top">
        <button class="ghost" data-act="back-deck" title="Desteye dön (Esc)">${ICON.back.replace('<svg', '<svg width="16" height="16" style="vertical-align:-3px"')} ${esc(deck?.name || '')}</button>
        <span class="spacer"></span>
        <div class="study-counts">
          <span class="n-new ${cur === 'new' ? 'cur' : ''}" title="Yeni">${c.new}</span>
          <span class="n-learn ${cur === 'learn' ? 'cur' : ''}" title="Öğreniliyor">${c.learn}</span>
          <span class="n-review ${cur === 'review' ? 'cur' : ''}" title="Tekrar">${c.review}</span>
        </div>
        <span class="spacer"></span>
        <button class="icon-btn" data-act="undo" title="Son cevabı geri al (Ctrl+Z)">${ICON.undo}</button>
        ${card ? `<button class="icon-btn" data-act="edit-current" title="Kartı düzenle (E)">${ICON.edit}</button>` : ''}
      </div>
      ${body}
      ${bar}
      ${card ? '<div class="shortcuts">Space: çevir / İyi · 1–4: cevap · R: seslendir · E: düzenle · Ctrl+Z: geri al · Esc: çık</div>' : ''}
    </div>`;
}

function flip() {
  const s = state.study;
  if (!s?.res.card || s.flipped) return;
  s.flipped = true;
  renderStudy();
  if (s.reverse && prefs.autoSpeak) speak(s.res.card.word, deckById(state.deckId)?.language);
}

async function rate(r) {
  const s = state.study;
  if (!s?.res.card || !s.flipped || s.busy) return;
  s.busy = true;
  await guard(async () => {
    const res = await api('answer', s.res.card.id, r, state.deckId);
    if (state.study !== s) return;
    showStudyCard(res);
    refreshDecks();
  });
  s.busy = false;
}

async function undo() {
  if (state.view !== 'study') return;
  await guard(async () => {
    const res = await api('undo', state.deckId);
    showStudyCard(res);
    refreshDecks();
    toast('Son cevap geri alındı.', 'info', 1500);
  });
}

function editCurrent() {
  const s = state.study;
  if (!s?.res.card) return;
  cardForm(s.res.card, state.deckId, async (saved) => {
    if (state.study !== s) return;
    if (!saved) { showStudyCard(await api('next_card', state.deckId)); refreshDecks(); return; }
    s.res.card = saved;
    renderStudy();
  });
}

function backToDeck() {
  leaveStudy();
  guard(async () => { await refreshDecks(); await openDeck(state.deckId); });
}

/* =========================================================== olaylar */

document.addEventListener('click', (e) => {
  const chkCell = e.target.closest('td.chk, th.chk');
  if (chkCell) {
    if (e.target.tagName !== 'INPUT') chkCell.querySelector('input')?.click();
    return;
  }
  const el = e.target.closest('[data-act], [data-deck], [data-card]');
  if (!el || el.closest('#modal-root') && !el.dataset.act) return;
  if (el.dataset.deck) return guard(() => openDeck(+el.dataset.deck));
  if (el.dataset.card && !el.dataset.act) {
    const card = state.cards.get(+el.dataset.card);
    if (card) cardForm(card, state.deckId, async () => { await refreshDecks(); await renderDeck(); });
    return;
  }
  const deck = deckById(state.deckId);
  const act = el.dataset.act;
  guard(async () => {
    switch (act) {
      case 'home': showHome(); break;
      case 'new-deck': deckForm(); break;
      case 'import': await importFlow(state.view === 'home' ? null : state.deckId); break;
      case 'import-into': await importFlow(state.deckId); break;
      case 'theme': {
        const order = ['system', 'light', 'dark'];
        prefs.theme = order[(order.indexOf(prefs.theme || 'system') + 1) % 3];
        savePrefs(); applyTheme(); break;
      }
      case 'toggle-autospeak': prefs.autoSpeak = !prefs.autoSpeak; savePrefs(); applyTheme(); break;
      case 'edit-deck': deckForm(deck); break;
      case 'delete-deck':
        if (await confirmBox(`“${deck.name}” destesi ve içindeki ${deck.total} kart kalıcı olarak silinecek.`, { ok: 'Desteyi sil', danger: true })) {
          await api('delete_deck', deck.id);
          state.deckId = null;
          await refreshDecks();
          showHome();
        }
        break;
      case 'export': {
        const path = await api('export_deck', deck.id);
        if (path) toast(`Kaydedildi: ${path}`, 'success', 5000);
        break;
      }
      case 'add-card': cardForm(null, state.deckId, async () => { await refreshDecks(); await renderDeck(); }); break;
      case 'study': await startStudy(); break;
      case 'back-deck': backToDeck(); break;
      case 'flip': flip(); break;
      case 'rate': await rate(+el.dataset.r); break;
      case 'undo': await undo(); break;
      case 'edit-current': editCurrent(); break;
      case 'speak': if (state.study?.res.card) speak(state.study.res.card.word, deck?.language); break;
      case 'speak-sentence': if (state.study?.res.card) speak(state.study.res.card.sentence, deck?.language); break;
      case 'bulk-clear': state.selected.clear(); await loadCards(); break;
      case 'bulk-reset':
        if (await confirmBox(`${state.selected.size} kartın çalışma ilerlemesi sıfırlanacak.`, { ok: 'Sıfırla' })) {
          await api('reset_cards', [...state.selected]);
          state.selected.clear();
          await refreshDecks(); await renderDeck();
        }
        break;
      case 'bulk-delete':
        if (await confirmBox(`${state.selected.size} kart kalıcı olarak silinecek.`, { ok: 'Sil', danger: true })) {
          await api('delete_cards', [...state.selected]);
          state.selected.clear();
          await refreshDecks(); await renderDeck();
        }
        break;
      default: break;
    }
  });
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.id === 'chk-all') {
    if (t.checked) state.cards.forEach((_, id) => state.selected.add(id)); else state.selected.clear();
    $$('input[data-chk]').forEach((c) => { c.checked = t.checked; c.closest('tr').classList.toggle('sel', t.checked); });
    renderBulk();
  } else if (t.dataset.chk) {
    const id = +t.dataset.chk;
    if (t.checked) state.selected.add(id); else state.selected.delete(id);
    t.closest('tr').classList.toggle('sel', t.checked);
    renderBulk();
  }
});

document.addEventListener('keydown', (e) => {
  if (modalOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    return;
  }
  const tag = document.activeElement?.tagName;
  const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  const key = e.key.toLowerCase();

  if (e.ctrlKey && key === 'n') { e.preventDefault(); deckForm(); return; }
  if (e.ctrlKey && key === 'o') { e.preventDefault(); guard(() => importFlow(state.view === 'home' ? null : state.deckId)); return; }

  if (state.view === 'study') {
    if (typing) return;
    const s = state.study;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (!s?.res.card) { if (e.key === 'Enter') backToDeck(); return; }
      if (!s.flipped) flip(); else rate(3);
    } else if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault(); rate(+e.key);
    } else if (e.ctrlKey && key === 'z') {
      e.preventDefault(); undo();
    } else if (key === 'r' && !e.ctrlKey) {
      if (s?.res.card) speak(s.res.card.word, deckById(state.deckId)?.language);
    } else if (key === 'e' && !e.ctrlKey) {
      e.preventDefault(); editCurrent();
    } else if (e.key === 'Escape') {
      backToDeck();
    }
  } else if (state.view === 'deck') {
    if (e.ctrlKey && key === 'f') { e.preventDefault(); $('#card-search')?.focus(); $('#card-search')?.select(); return; }
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (e.key === 'Enter' && tag !== 'BUTTON') { e.preventDefault(); guard(startStudy); }
    else if (key === 'n' && !e.ctrlKey) { e.preventDefault(); cardForm(null, state.deckId, async () => { await refreshDecks(); await renderDeck(); }); }
  }
});

// Sürükle-bırak ile JSON içe aktarma
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (state.view === 'study') { toast('İçe aktarmak için önce çalışmadan çık.', 'info'); return; }
  importText(file.name, await file.text(), state.view === 'deck' ? state.deckId : null);
});

/* =========================================================== başlangıç */

let started = false;
async function init() {
  if (started) return;
  started = true;
  applyTheme();
  await guard(refreshDecks);
  if (prefs.lastDeck && deckById(prefs.lastDeck)) await guard(() => openDeck(prefs.lastDeck));
  else showHome();
}

applyTheme();
if (window.pywebview?.api?.get_decks) init();
else window.addEventListener('pywebviewready', init);

import * as store from './store.js';
import * as sync from './sync.js';
import { nowSec } from './srs.js';

// Android uygulaması (Capacitor) içinde mi çalışıyoruz? Orada bazı işler yerel eklentilerle yapılır.
const Cap = window.Capacitor;
const isNative = !!Cap?.isNativePlatform?.();
const plugin = (name) => (isNative ? Cap.registerPlugin(name) : null);
const NativeTTS = plugin('TextToSpeech');
const NativeApp = plugin('App');
const NativeFS = plugin('Filesystem');
const NativeShare = plugin('Share');
const NativeNotif = plugin('LocalNotifications');

// Başka bir sitenin içine gömülmeyi engelle (tıklama tuzağına karşı)
if (window.top !== window.self) {
  document.documentElement.innerHTML = '';
  window.top.location = window.self.location.href;
  throw new Error('Kelime başka bir sayfanın içinde çalışmaz.');
}

/* =========================================================== yardımcılar */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
const ROLES = { owner: 'Sahip', editor: 'Düzenleyebilir', viewer: 'Görüntüleyebilir' };

const svg = (body, extra = '') => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}>${body}</svg>`;
const ICON = {
  speaker: svg('<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>'),
  undo: svg('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-3"/>'),
  edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>'),
  back: svg('<path d="m15 18-6-6 6-6"/>', 'width="16" height="16" style="vertical-align:-3px"'),
  users: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>', 'class="shared-ic"'),
  usersMenu: svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>'),
  home: svg('<path d="m3 10 9-7 9 7"/><path d="M5 9v11h5v-6h4v6h5V9"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  sliders: svg('<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>'),
  history: svg('<path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/>'),
  upload: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5"/><path d="M12 3v12"/>'),
  download: svg('<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>'),
  trash: svg('<path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>'),
  leave: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
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
  profileName: '',
};
const main = $('#main');
const deckById = (id) => state.decks.find((d) => d.id === id);
const isMobile = () => matchMedia('(max-width: 760px)').matches;

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

function timeAgo(date) {
  const s = Math.round((Date.now() - new Date(date).getTime()) / 1000);
  if (s < 45) return 'az önce';
  if (s < 3600) return `${Math.round(s / 60)} dk önce`;
  if (s < 86400) return `${Math.round(s / 3600)} sa önce`;
  return new Date(date).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });
}

/* =========================================================== tema / ses */

function applyTheme() {
  const mode = prefs.theme || 'system';
  const dark = mode === 'dark' || (mode === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('meta[name=theme-color]').content = dark ? '#221f1b' : '#d5ccbb';
  $('#btn-theme').textContent = { system: '◐ Sistem', light: '☀ Açık', dark: '☾ Koyu' }[mode];
  const vol = Math.round((prefs.volume ?? 1) * 100);
  $('#btn-autospeak').textContent = `${vol === 0 ? '🔇' : prefs.autoSpeak ? '🔊' : '🔈'} Ses %${vol}`;
  $('#btn-autospeak').title = `Seslendirme ayarları · otomatik seslendirme ${prefs.autoSpeak ? 'açık' : 'kapalı'}`;
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// Android'in uygulama içi tarayıcısında web seslendirmesi olmayabilir; orada yerel eklenti kullanılır
const webSpeech = 'speechSynthesis' in window ? window.speechSynthesis : null;
let voices = [];
const loadVoices = () => { voices = webSpeech?.getVoices() || []; };
webSpeech?.addEventListener?.('voiceschanged', loadVoices);
loadVoices();
const warnedLangs = new Set();

// O dilin en kaliteli sesini seç (Edge'in "Natural", Apple'ın "Enhanced", Google sesleri...).
function pickVoice(lang) {
  const tag = (langInfo(lang)[2] || lang).toLowerCase();
  const base = tag.split('-')[0];
  const norm = (v) => v.lang.toLowerCase().replace('_', '-');
  const score = (v) => (norm(v) === tag ? 4 : 0) + (/natural|neural|online|enhanced|premium|siri/i.test(v.name) ? 2 : 0)
    + (/google/i.test(v.name) ? 1 : 0);
  return voices.filter((v) => norm(v).split('-')[0] === base).sort((a, b) => score(b) - score(a))[0] || null;
}

function stopSpeech() {
  if (NativeTTS) NativeTTS.stop().catch(() => {});
  else webSpeech?.cancel();
}

// Android: telefonun kendi metin okuma motoru (Google TTS vb.)
const nativeLangChecked = new Map();
async function nativeSpeak(text, lang) {
  const tag = langInfo(lang)[2] || lang;
  if (!nativeLangChecked.has(tag)) {
    const ok = await NativeTTS.isLanguageSupported({ lang: tag }).then((r) => r.supported).catch(() => true);
    nativeLangChecked.set(tag, ok);
    if (!ok) {
      toast(`Telefonda ${langName(lang)} ses verisi yok. Ayarlar › Sistem › Dil › Metin okuma çıkışı bölümünden ${langName(lang)} sesini indirebilirsin.`, 'info', 7000);
    }
  }
  if (!nativeLangChecked.get(tag)) return;
  try {
    await NativeTTS.stop().catch(() => {});
    await NativeTTS.speak({ text, lang: tag, rate: speechRate(), volume: speechVolume(), pitch: 1.0, category: 'playback' });
  } catch (e) {
    console.warn('Seslendirme hatası', e);
  }
}

function speak(text, lang) {
  if (!text) return;
  if (NativeTTS) { nativeSpeak(text, lang); return; }
  if (!webSpeech) { toast('Bu cihazda seslendirme desteklenmiyor.', 'info'); return; }
  if (!voices.length) loadVoices();
  const voice = pickVoice(lang);
  if (!voice) {
    const base = (langInfo(lang)[2] || lang).split('-')[0];
    if (!warnedLangs.has(base)) {
      warnedLangs.add(base);
      toast(`Bu cihazda ${langName(lang)} ses bulunamadı. Cihazın konuşma ayarlarından ${langName(lang)} ses paketi ekleyebilirsin.`, 'info', 6000);
    }
    return;
  }
  stopSpeech();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.volume = speechVolume();
  u.rate = speechRate();
  webSpeech.speak(u);
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const speechVolume = () => clamp(prefs.volume ?? 1, 0, 1);
const speechRate = () => clamp(prefs.rate ?? 0.95, 0.5, 1.5);

function speechSettingsModal() {
  const lang = deckById(state.deckId)?.language || 'en';
  const sample = { en: 'abundant', de: 'die Erfahrung', fr: 'bonjour', es: 'hola', it: 'ciao' }[lang] || 'hello';
  const form = openModal(`
    <h2>Seslendirme</h2>
    <label class="radio"><input type="checkbox" name="auto" ${prefs.autoSpeak ? 'checked' : ''}>
      Kart açılınca kelimeyi otomatik seslendir</label>
    <label>Ses seviyesi <small id="vol-val">%${Math.round(speechVolume() * 100)}</small>
      <input type="range" name="volume" min="0" max="100" step="5" value="${Math.round(speechVolume() * 100)}"></label>
    <label>Konuşma hızı <small id="rate-val">${speechRate().toFixed(2)}×</small>
      <input type="range" name="rate" min="50" max="150" step="5" value="${Math.round(speechRate() * 100)}"></label>
    <p class="muted" style="font-size:12.5px">Bu ses seviyesi cihazın genel sesinden bağımsızdır. Bazı tarayıcılar (özellikle iPhone/iPad'de Safari) ses seviyesi ayarını desteklemez; orada cihazın kendi ses tuşlarını kullan.</p>
    <div class="modal-actions">
      <button type="button" data-try>▶ Dene</button>
      <span class="spacer"></span>
      <button type="submit" class="primary">Tamam</button>
    </div>`, { onSubmit: () => {} });
  const save = () => {
    prefs.autoSpeak = $('[name=auto]', form).checked;
    prefs.volume = +$('[name=volume]', form).value / 100;
    prefs.rate = +$('[name=rate]', form).value / 100;
    $('#vol-val', form).textContent = `%${Math.round(prefs.volume * 100)}`;
    $('#rate-val', form).textContent = `${prefs.rate.toFixed(2)}×`;
    savePrefs();
    applyTheme();
  };
  form.addEventListener('input', save);
  // Kaydırıcı bırakılınca örnek kelimeyi yeni ayarla oku
  $$('input[type=range]', form).forEach((r) => r.addEventListener('change', () => speak(sample, lang)));
  $('[data-try]', form).addEventListener('click', () => speak(sample, lang));
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
    $$('button[type=submit]', form).forEach((b) => { b.disabled = true; });
    try {
      const r = await onSubmit?.(form);
      if (r !== false) closeModal();
    } catch (err) {
      toast(err.message || String(err), 'error', 5000);
    } finally {
      delete form.dataset.busy;
      $$('button[type=submit]', form).forEach((b) => { b.disabled = false; });
    }
  });
  form.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); form.requestSubmit(); }
  });
  $$('[data-close]', form).forEach((b) => b.addEventListener('click', closeModal));
  if (!isMobile()) setTimeout(() => ($('[autofocus]', form) || $('input,textarea,select,button', form))?.focus(), 0);
  return form;
}

function closeModal() {
  const cb = modalOnClose;
  modalOnClose = null;
  const wasOpen = modalOpen();
  $('#modal-root').innerHTML = '';
  cb?.();
  // Pencere açıkken gelen uzak değişiklikleri şimdi ekrana yansıt
  if (wasOpen && remoteDirty && !modalOpen()) onRemoteChange();
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

/* =========================================================== kenar çubuğu ve hesap */

const num = (n, cls) => `<span class="${n ? cls : 'zero'}">${n}</span>`;

function refreshDecks() {
  state.decks = store.getDecks();
  renderSidebar();
}

function renderSidebar() {
  $('#deck-list').innerHTML = state.decks.length
    ? state.decks.map((d) => `
      <button class="deck-item ${d.id === state.deckId && state.view !== 'home' ? 'active' : ''}" data-deck="${d.id}" title="${esc(d.name)}">
        <span class="deck-name">${esc(d.name)}</span>
        <span class="meta">${d.shared || d.role !== 'owner' ? ICON.users : ''}<span class="lang">${esc(d.language.toUpperCase())}</span></span>
        <span class="counts">${num(d.new, 'n-new')}${num(d.learn, 'n-learn')}${num(d.review, 'n-review')}</span>
      </button>`).join('')
    : '<div class="empty-side">Henüz deste yok. “+ Yeni deste” ile oluştur ya da bir JSON dosyası içe aktar.</div>';
  $('#btn-join').classList.toggle('hidden', !sync.enabled);
  $('#nav-essays')?.classList.toggle('active', state.view === 'essays' || state.view === 'essay');
  renderAccount();
}

function syncLine() {
  const s = sync.status;
  if (s.state === 'disabled') return { dot: '', text: 'Sadece bu cihazda' };
  if (s.state === 'signed-out') return { dot: '', text: 'Senkron için giriş yap' };
  if (s.state === 'syncing') return { dot: 'syncing', text: 'Eşitleniyor…' };
  if (s.state === 'offline') return { dot: 'offline', text: s.pending ? 'Çevrimdışı · değişiklikler bekliyor' : 'Çevrimdışı' };
  if (s.state === 'error') return { dot: 'error', text: `Senkron hatası: ${s.error}` };
  if (s.pending) return { dot: 'pending', text: 'Değişiklikler gönderilecek' };
  if (s.lastSync) return { dot: 'ok', text: `Eşitlendi · ${timeAgo(s.lastSync)}` };
  return { dot: 'syncing', text: 'Bağlanıyor…' };
}

function renderAccount() {
  const u = sync.user();
  const name = u ? (state.profileName || u.user_metadata?.display_name || u.email.split('@')[0]) : '';
  const line = syncLine();
  $('#account-btn').innerHTML = u
    ? `<span class="avatar">${esc(name.charAt(0).toLocaleUpperCase('tr'))}</span>
       <span class="acc-name">${esc(name)}</span>
       <span class="acc-sync" title="${esc(line.text)}"><span class="dot ${line.dot}"></span>${esc(line.text)}</span>`
    : `<span class="avatar off">?</span>
       <span class="acc-name">${sync.enabled ? 'Giriş yap' : 'Hesapsız mod'}</span>
       <span class="acc-sync">${esc(line.text)}</span>`;
  $('#topbar-sync').innerHTML = u && line.dot ? `<span class="dot ${line.dot}" title="${esc(line.text)}"></span>` : '';
}
setInterval(renderAccount, 30_000);

function authModal(tab = 'signin') {
  if (!sync.enabled) return accountModal();
  const signup = tab === 'signup';
  const form = openModal(`
    <h2>${signup ? 'Hesap oluştur' : 'Giriş yap'}</h2>
    <div class="tabs">
      <button type="button" data-tab="signin" class="${signup ? '' : 'on'}">Giriş yap</button>
      <button type="button" data-tab="signup" class="${signup ? 'on' : ''}">Kayıt ol</button>
    </div>
    <p class="muted" style="font-size:13px">Hesabınla desteler ve çalışma ilerlemen tüm cihazlarında eşitlenir, desteleri başkalarıyla paylaşabilirsin.</p>
    ${signup ? '<label>Adın<input name="name" autocomplete="nickname" placeholder="Paylaşılan destelerde görünür" autofocus></label>' : ''}
    <label>E-posta<input name="email" type="email" autocomplete="email" ${signup ? '' : 'autofocus'}></label>
    <label>Şifre<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="6"></label>
    ${signup ? '' : '<button type="button" class="link-btn" data-forgot>Şifremi unuttum</button>'}
    ${store.getDecks().length && store.isLocalUser() ? '<div class="info-box">Bu cihazdaki desteler giriş yaptığın hesaba aktarılacak.</div>' : ''}
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">${signup ? 'Kayıt ol' : 'Giriş yap'}</button>
    </div>`, {
    onSubmit: async (f) => {
      const fd = Object.fromEntries(new FormData(f));
      const email = fd.email.trim();
      if (!email || !fd.password) { toast('E-posta ve şifre gerekli.', 'error'); return false; }
      if (signup) {
        const { needsConfirm } = await sync.signUp(email, fd.password, (fd.name || '').trim() || email.split('@')[0]);
        if (needsConfirm) {
          openModal(`<h2>E-postanı onayla</h2>
            <p>${esc(email)} adresine bir onay bağlantısı gönderdik. Bağlantıya tıkladıktan sonra buradan giriş yapabilirsin.</p>
            <div class="modal-actions"><button type="submit" class="primary">Tamam</button></div>`, { onSubmit: () => authModal('signin') });
          return false;
        }
      } else {
        await sync.signIn(email, fd.password);
      }
      toast('Giriş yapıldı. Veriler eşitleniyor…', 'success');
    },
  });
  $$('[data-tab]', form).forEach((b) => b.addEventListener('click', () => authModal(b.dataset.tab)));
  $('[data-forgot]', form)?.addEventListener('click', () => guard(async () => {
    const email = $('[name=email]', form).value.trim();
    if (!email) { toast('Önce e-posta adresini yaz.', 'info'); return; }
    await sync.sendPasswordReset(email);
    toast('Şifre sıfırlama bağlantısı e-postana gönderildi.', 'success', 5000);
  }));
}

function recoveryModal() {
  openModal(`
    <h2>Yeni şifre belirle</h2>
    <label>Yeni şifre<input name="password" type="password" autocomplete="new-password" minlength="6" autofocus></label>
    <div class="modal-actions"><button type="submit" class="primary">Kaydet</button></div>`, {
    onSubmit: async (f) => {
      await sync.updatePassword($('[name=password]', f).value);
      toast('Şifren güncellendi.', 'success');
    },
  });
}

function accountModal() {
  const u = sync.user();
  if (sync.enabled && !u) return authModal();
  const line = syncLine();
  const form = openModal(`
    <h2>${u ? 'Hesap ve cihaz' : 'Bu cihaz'}</h2>
    ${u ? `
      <label>Adın <small>paylaşılan destelerde ve geçmişte görünür</small>
        <input name="name" value="${esc(state.profileName || u.user_metadata?.display_name || '')}"></label>
      <div class="muted" style="font-size:13px">${esc(u.email)}</div>` : `
      <div class="info-box">Senkron yapılandırılmadığı için veriler sadece bu cihazda saklanıyor.</div>`}
    ${u ? `<label>Çalışma panosunda beni kimler görsün?
      <select name="visibility">
        <option value="shared" ${board.myVisibility === 'shared' ? 'selected' : ''}>Ortak destede olduklarım</option>
        <option value="everyone" ${board.myVisibility === 'everyone' ? 'selected' : ''}>Uygulamayı kullanan herkes</option>
        <option value="nobody" ${board.myVisibility === 'nobody' ? 'selected' : ''}>Kimse (sadece ben)</option>
      </select></label>` : ''}
    <label>Cihaz adı <small>değişiklik geçmişinde görünür</small>
      <input name="device" value="${esc(store.deviceName())}"></label>
    ${u ? `<div style="display:flex;align-items:center;gap:8px;font-size:13px">
      <span class="dot ${line.dot}"></span><span style="flex:1">${esc(line.text)}</span>
      <button type="button" data-sync>Şimdi eşitle</button></div>` : ''}
    <div style="display:flex;gap:8px;flex-wrap:wrap">
      <button type="button" data-backup>Tüm verileri yedekle (JSON)</button>
    </div>
    <div class="modal-actions">
      ${u ? '<button type="button" class="danger-ghost" data-logout>Çıkış yap</button><span class="spacer"></span>' : ''}
      <button type="button" data-close>Kapat</button>
      <button type="submit" class="primary">Kaydet</button>
    </div>`, {
    onSubmit: async (f) => {
      const fd = Object.fromEntries(new FormData(f));
      store.setDeviceName(fd.device);
      if (u && fd.visibility && fd.visibility !== board.myVisibility) {
        await sync.setBoardVisibility(fd.visibility);
        board.myVisibility = fd.visibility;
        if (state.view === 'home') loadBoard();
      }
      if (u && fd.name.trim() && fd.name.trim() !== state.profileName) {
        await sync.updateProfile(fd.name.trim());
        state.profileName = fd.name.trim();
      }
      renderAccount();
      toast('Kaydedildi.', 'success', 1500);
    },
  });
  $('[data-sync]', form)?.addEventListener('click', () => guard(async () => { await sync.syncNow(); accountModal(); }));
  $('[data-backup]', form).addEventListener('click', () => guard(
    () => download(`kelime-yedek-${new Date().toISOString().slice(0, 10)}.json`, store.exportBackup()),
  ));
  $('[data-logout]', form)?.addEventListener('click', () => guard(async () => {
    const pending = store.hasUnsynced();
    const ok = await confirmBox(pending
      ? 'Henüz sunucuya gönderilmemiş değişiklikler var ve çıkış yaparsan kaybolacaklar. Yine de çıkılsın mı?'
      : 'Bu cihazdaki veriler temizlenecek. Tekrar giriş yaptığında hepsi sunucudan geri gelir.', { ok: 'Çıkış yap', danger: pending });
    if (!ok) return accountModal();
    await sync.signOut();
    state.deckId = null;
    refreshDecks();
    showHome();
    toast('Çıkış yapıldı.');
  }));
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

function setTitle(t) { $('#topbar-title').textContent = t; }

function showHome() {
  leaveStudy();
  state.view = 'home';
  renderSidebar();
  setTitle('Kelime');
  const due = state.decks.reduce((a, d) => a + d.new + d.learn + d.review, 0);
  main.innerHTML = `
    <div class="page">
      <div class="hero">
        <div>
          <h1>Merhaba${state.profileName ? `, ${esc(state.profileName)}` : ''} 👋</h1>
          <div class="muted">${state.decks.length
            ? (due ? `Bugün toplam <b>${due}</b> kart seni bekliyor.` : 'Bugünlük her şey tamam. Harika iş!')
            : 'Başlamak için bir deste oluştur ya da JSON dosyası içe aktar.'}</div>
        </div>
        <div class="head-actions">
          ${sync.enabled && !sync.user() ? '<button data-act="account">Giriş yap / Kayıt ol</button>' : ''}
          ${sync.enabled ? '<button data-act="join">Kodla katıl</button>' : ''}
          <button data-act="import">JSON içe aktar</button>
          <button class="primary" data-act="new-deck">+ Yeni deste</button>
        </div>
      </div>
      ${studyTimePanel()}
      ${sync.enabled && sync.user() ? '<section class="panel board" id="board"><div class="muted">Pano yükleniyor…</div></section>' : ''}
      ${state.decks.length ? `<div class="tiles">${state.decks.map((d) => `
        <button class="tile" data-deck="${d.id}">
          <span class="t-name">${esc(d.name)}</span>
          <span class="t-sub">${esc(langName(d.language))} · ${d.total} kart${d.role !== 'owner' ? ` · ${ROLES[d.role]}` : d.shared ? ' · paylaşılıyor' : ''}</span>
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
  loadBoard();
}

/* =========================================================== deste sayfası */

function openDeck(id) {
  leaveStudy();
  if (state.deckId !== id) { state.search = ''; state.selected.clear(); }
  state.deckId = id;
  state.view = 'deck';
  prefs.lastDeck = id;
  savePrefs();
  document.body.classList.remove('menu-open');
  renderSidebar();
  renderDeck();
}

function renderDeck() {
  const d = deckById(state.deckId);
  if (!d) return showHome();
  const st = store.getDeckStats(d.id);
  const editable = d.role !== 'viewer';
  const signedIn = !!sync.user();
  setTitle(d.name);
  main.innerHTML = `
    <div class="page">
      <header class="deck-head">
        <button class="icon-btn head-btn" data-act="home" title="Ana sayfaya dön (Esc)" aria-label="Ana sayfaya dön">${ICON.home}</button>
        <div class="deck-title">
          <h1>${esc(d.name)}</h1>
          <div class="sub">
            <span class="badge">${esc(langName(d.language))}</span>
            ${d.role !== 'owner' ? `<span class="badge role-badge">Ortak · ${ROLES[d.role]}</span>` : d.shared ? '<span class="badge role-badge">Paylaşılıyor</span>' : ''}
            <span>${d.total} kart · günde ${d.new_per_day} yeni · ${DIRECTIONS[d.direction] || ''}</span>
          </div>
        </div>
        <div class="menu-wrap">
          <button class="icon-btn head-btn" data-act="deck-menu" title="Deste işlemleri" aria-label="Deste işlemleri" aria-haspopup="menu">${ICON.gear}</button>
          <div class="menu-pop hidden" id="deck-menu" role="menu">
            <button role="menuitem" data-act="edit-deck">${ICON.sliders}<span>Deste ayarları</span></button>
            ${sync.enabled ? `<button role="menuitem" data-act="share">${ICON.usersMenu}<span>${d.role === 'owner' ? 'Paylaş' : 'Üyeler'}</span></button>` : ''}
            ${signedIn ? `<button role="menuitem" data-act="history">${ICON.history}<span>Değişiklik geçmişi</span></button>` : ''}
            <hr>
            ${editable ? `<button role="menuitem" data-act="import-into">${ICON.upload}<span>İçe aktar</span></button>` : ''}
            <button role="menuitem" data-act="export">${ICON.download}<span>Dışa aktar</span></button>
            <hr>
            <button role="menuitem" class="danger" data-act="delete-deck">${d.role === 'owner' ? ICON.trash : ICON.leave}<span>${d.role === 'owner' ? 'Desteyi sil' : 'Desteden ayrıl'}</span></button>
          </div>
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
          <input id="card-search" type="search" placeholder="Kartlarda ara…" value="${esc(state.search)}">
          ${editable && sync.enabled ? '<button class="ai-btn" data-act="ai-bulk" title="Kelime listesinden yapay zekâyla kart oluştur">✨ Listeden ekle</button>' : ''}
          ${editable ? '<button class="primary" data-act="add-card">+ Kart ekle <kbd>N</kbd></button>' : ''}
        </div>
        <div id="bulk"></div>
        <div id="card-table"></div>
      </section>
    </div>`;
  let t;
  $('#card-search').addEventListener('input', (e) => {
    clearTimeout(t);
    t = setTimeout(() => { state.search = e.target.value; loadCards(); }, 120);
  });
  loadCards();
}

function stateBadge(c) {
  if (c.state === 0) return '<span class="st new">Yeni</span>';
  if (c.state === 1 || c.state === 3) return '<span class="st learn">Öğreniliyor</span>';
  const diff = c.due - nowSec();
  const label = diff <= 0 ? 'Bugün' : (diff < 86400 ? 'Yarın' : `${Math.ceil(diff / 86400)} gün sonra`);
  return `<span class="st review" title="Aralık: ${c.ivl} gün · ${c.reps} tekrar · ${c.lapses} unutma">${label}</span>`;
}

function loadCards() {
  const deckId = state.deckId;
  const res = store.listCards(deckId, state.search, 1000);
  state.cards = new Map(res.cards.map((c) => [c.id, c]));
  for (const id of [...state.selected]) if (!state.cards.has(id)) state.selected.delete(id);
  const box = $('#card-table');
  if (!box) return;
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
            <th>Kelime</th><th>Türkçesi</th><th class="c-syn">Eş anlamlılar</th><th class="c-state">Durum</th>
          </tr></thead>
          <tbody>${res.cards.map((c) => `
            <tr data-card="${c.id}" class="${state.selected.has(c.id) ? 'sel' : ''}">
              <td class="chk"><input type="checkbox" data-chk="${c.id}" ${state.selected.has(c.id) ? 'checked' : ''}></td>
              <td class="w" title="${esc(c.word)}">${esc(c.word)}</td>
              <td title="${esc(c.translation)}">${esc(c.translation)}</td>
              <td class="muted c-syn">${esc(c.synonyms.join(', '))}</td>
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
  const editable = store.canEdit(state.deckId);
  const others = state.decks.filter((d) => d.id !== state.deckId && d.role !== 'viewer');
  box.innerHTML = `
    <div class="bulk">
      <span class="sel-n">${n} kart seçili</span>
      <button class="ghost" data-act="bulk-reset" title="Çalışma ilerlemesini sıfırla, yeni kart yap">Sıfırla</button>
      ${others.length ? '<button class="ghost" data-act="bulk-copy" title="Seçili kartları başka destelere kopyala">Destelere kopyala…</button>' : ''}
      ${editable ? '<button class="danger-ghost" data-act="bulk-delete">Sil</button>' : ''}
      <span style="flex:1"></span>
      <button class="ghost" data-act="bulk-clear">Seçimi kaldır</button>
    </div>`;
}

/** Kartları bir ya da birden çok desteye kopyalar (isteğe bağlı: bu desteden kaldır = taşı). */
function copyCardsModal(ids, after) {
  const targets = state.decks.filter((d) => d.id !== state.deckId && d.role !== 'viewer');
  if (!targets.length) { toast('Kopyalanacak başka bir deste yok. Önce yeni bir deste oluştur.', 'info'); return; }
  const canRemove = store.canEdit(state.deckId);
  const label = ids.length === 1 ? `“${state.cards.get(ids[0])?.word || 'Kart'}”` : `${ids.length} kart`;
  const form = openModal(`
    <h2>${esc(label)} → başka destelere</h2>
    <p class="muted" style="font-size:13px">Kart bu destede kalır; seçtiğin her desteye bir kopyası eklenir.
      Kopyanın çalışma ilerlemesi yeni destede sıfırdan başlar. Hedefte aynı kelime varsa o deste atlanır.</p>
    <div class="task-choices">${targets.map((d) => `
      <label class="radio task-choice"><input type="checkbox" name="target" value="${d.id}">
        <span><b>${esc(d.name)}</b><small>${esc(langName(d.language))} · ${d.total} kart</small></span></label>`).join('')}
    </div>
    ${canRemove ? '<label class="radio" style="font-size:13px"><input type="checkbox" name="move"> Bu desteden kaldır (taşı)</label>' : ''}
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary" id="copy-submit">Kopyala</button>
    </div>`, {
    onSubmit: (f) => {
      const tids = [...f.querySelectorAll('[name=target]:checked')].map((x) => x.value);
      if (!tids.length) { toast('En az bir deste seç.', 'info'); return false; }
      const move = !!f.move?.checked;
      const r = store.copyCards(ids, tids);
      if (move) store.deleteCards(ids);
      const where = tids.length === 1 ? `“${deckById(tids[0])?.name}” destesine` : `${tids.length} desteye`;
      toast(`${r.copied} kopya ${where} eklendi${move ? ', kartlar bu desteden kaldırıldı' : ''}${r.skipped ? ` (${r.skipped} tanesi hedefte zaten vardı)` : ''}.`, 'success', 5000);
      state.selected.clear();
      refreshDecks();
      if (state.view === 'deck') renderDeck(); // çalışma ekranından açıldıysa çalışmayı bölme
      after?.();
    },
  });
  form.move?.addEventListener('change', () => { $('#copy-submit', form).textContent = form.move.checked ? 'Taşı' : 'Kopyala'; });
}

/* =========================================================== formlar */

function deckForm(deck) {
  const d = deck || { name: '', language: 'en', new_per_day: 20, direction: 'front', role: 'owner' };
  const lockMeta = d.role !== 'owner';
  openModal(`
    <h2>${deck ? 'Deste ayarları' : 'Yeni deste'}</h2>
    <label>Ad<input name="name" value="${esc(d.name)}" placeholder="ör. IELTS Academic, Goethe B1" ${lockMeta ? 'disabled' : 'autofocus'}></label>
    <div class="row2">
      <label>Dil<select name="language" ${lockMeta ? 'disabled' : ''}>${langOptions(d.language)}</select></label>
      <label>Günlük yeni kart<input name="new_per_day" type="number" inputmode="numeric" min="0" max="9999" value="${d.new_per_day}"></label>
    </div>
    <label>Kart yönü<select name="direction">${dirOptions(d.direction)}</select></label>
    ${lockMeta ? '<p class="muted" style="font-size:12.5px">Adı ve dili sadece deste sahibi değiştirebilir. Günlük yeni kart sayısı ve kart yönü sana özeldir.</p>' : ''}
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">${deck ? 'Kaydet' : 'Oluştur'}</button>
    </div>`, {
    onSubmit: (f) => {
      const data = Object.fromEntries(new FormData(f));
      if (!lockMeta && !data.name.trim()) { toast('Deste adı boş olamaz.', 'error'); return false; }
      const saved = deck ? store.updateDeck(deck.id, data) : store.createDeck(data);
      refreshDecks();
      openDeck(saved.id);
    },
  });
}

const parseExtra = (text) => Object.fromEntries((text || '').split('\n')
  .map((l) => l.split(/:(.*)/s).map((s) => s.trim()))
  .filter(([k, v]) => k && v));

function cardForm(card, deckId, after) {
  const readOnly = !store.canEdit(deckId);
  const c = card || { word: '', translation: '', sentence: '', synonyms: [], notes: '', extra: {} };
  const extraText = extraToText(c.extra);
  const dis = readOnly ? 'disabled' : '';
  const form = openModal(`
    <h2>${readOnly ? 'Kart' : card ? 'Kartı düzenle' : 'Yeni kart'}</h2>
    <div class="row2">
      <label>Kelime<input name="word" value="${esc(c.word)}" autofocus ${dis}></label>
      <label>Türkçesi<input name="translation" value="${esc(c.translation)}" ${dis}></label>
    </div>
    ${!readOnly && sync.enabled ? `<div class="ai-row">
      <button type="button" class="ai-btn" data-ai>✨ Yapay zekâ ile doldur</button>
      <span class="muted">${card ? 'Boş alanları doldurur; hepsi doluysa yeniden üretir.' : 'Kelimeyi yaz, Tab’a bas: gerisi kendiliğinden dolar.'}</span>
    </div>` : ''}
    <label>Örnek cümle<textarea name="sentence" rows="2" ${dis}>${esc(c.sentence)}</textarea></label>
    <label>Eş anlamlılar <small>virgülle ayır</small><input name="synonyms" value="${esc(c.synonyms.join(', '))}" ${dis}></label>
    <label>Not<textarea name="notes" rows="2" ${dis}>${esc(c.notes)}</textarea></label>
    <details ${extraText ? 'open' : ''}>
      <summary>Ek alanlar</summary>
      <textarea name="extra" rows="3" placeholder="artikel: der&#10;plural: die Hunde" ${dis}>${esc(extraText)}</textarea>
    </details>
    ${readOnly ? '<p class="muted" style="font-size:12.5px">Bu destede sadece görüntüleme yetkin var.</p>' : ''}
    <div class="modal-actions">
      ${card && !readOnly ? '<button type="button" class="danger-ghost" data-act-modal="delete">Sil</button>' : ''}
      ${card && state.decks.some((d) => d.id !== deckId && d.role !== 'viewer') ? '<button type="button" class="ghost" data-act-modal="copy">Destelere kopyala…</button>' : ''}
      ${card ? '<span class="spacer"></span>' : ''}
      <button type="button" data-close>${readOnly ? 'Kapat' : 'Vazgeç'}</button>
      ${readOnly ? '' : `<button type="submit" class="primary">${card ? 'Kaydet' : 'Ekle'} <kbd>Ctrl+Enter</kbd></button>`}
    </div>`, {
    wide: true,
    onSubmit: async (f) => {
      if (readOnly) return;
      const fd = Object.fromEntries(new FormData(f));
      const data = {
        id: card?.id, deck_id: deckId,
        word: fd.word.trim(), translation: fd.translation.trim(), sentence: fd.sentence.trim(),
        synonyms: fd.synonyms.split(/[,;]/).map((s) => s.trim()).filter(Boolean),
        notes: fd.notes.trim(), extra: parseExtra(fd.extra),
      };
      if (!data.word) { toast('Kelime boş olamaz.', 'error'); return false; }
      const saved = store.saveCard(data);
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
  const aiBtn = $('[data-ai]', form);
  if (aiBtn) {
    aiBtn.addEventListener('click', () => aiFillForm(form, deckId, !card, false));
    // Yeni kartta kelime yazılıp alandan çıkılınca (Tab) ve henüz anlam yazılmadıysa otomatik doldur
    if (!card) {
      $('[name=word]', form).addEventListener('change', () => {
        if (!$('[name=translation]', form).value.trim() && sync.user()) aiFillForm(form, deckId, true, true);
      });
    }
  }
  $('[data-act-modal=copy]', form)?.addEventListener('click', () => copyCardsModal([card.id]));
  $('[data-act-modal=delete]', form)?.addEventListener('click', async () => {
    if (!(await confirmBox(`“${c.word}” kartı silinecek.`, { ok: 'Sil', danger: true }))) return cardForm(card, deckId, after);
    await guard(async () => {
      store.deleteCards([card.id]);
      toast('Kart silindi.');
      await after?.(null);
    });
  });
}

/* =========================================================== yapay zekâ */

const coreWord = (w) => w.trim().toLocaleLowerCase().replace(/^(der|die|das|the|to|a|an|sich)\s+/, '');

/** Kart penceresindeki alanları yapay zekâyla doldurur. */
async function aiFillForm(form, deckId, isNew, auto) {
  const wordInput = $('[name=word]', form);
  const btn = $('[data-ai]', form);
  const word = wordInput.value.trim();
  if (!word) { if (!auto) toast('Önce kelimeyi yaz.', 'info'); return; }
  if (!sync.user()) { toast('Yapay zekâ ile doldurmak için giriş yapman gerekiyor.', 'info'); return; }
  if (btn.disabled) return;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = '✨ Hazırlanıyor…';
  form.classList.add('ai-busy');
  try {
    const [c] = await sync.aiCards([word], deckById(deckId)?.language || 'en');
    if (!c) throw new Error('Yapay zekâ bu kelime için kart üretemedi.');
    // Beklerken pencere kapandıysa ya da kelime değiştiyse sonucu kullanma
    if (!form.isConnected || wordInput.value.trim() !== word) return;
    const fields = { translation: c.translation, sentence: c.sentence, synonyms: c.synonyms.join(', '), extra: extraToText(c.extra) };
    const empty = Object.keys(fields).filter((k) => !$(`[name=${k}]`, form).value.trim());
    for (const k of (empty.length ? empty : Object.keys(fields))) {
      if (fields[k]) $(`[name=${k}]`, form).value = fields[k];
    }
    if (fields.extra) $('details', form).open = true;
    // Temel hâl (ör. Gebäude → das Gebäude, went → go) yeni kartta kelimenin yerine geçer
    if (isNew && c.word && c.word !== word) {
      wordInput.value = c.word;
      if (coreWord(c.word) !== coreWord(word)) toast(`Kelime “${c.word}” olarak düzeltildi.`, 'info', 3500);
    }
  } catch (e) {
    toast(e.message, 'error', 6000);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    form.classList.remove('ai-busy');
  }
}

// "Listeden ekle" kutusundaki örnekler, destenin diline göre
const AI_EXAMPLES = {
  en: ['abandon', 'mitigate', 'ubiquitous'],
  de: ['die Wohnung', 'sich bewerben', 'allerdings'],
  fr: ['le logement', 'néanmoins', 'se souvenir'],
  es: ['la vivienda', 'sin embargo', 'aprovechar'],
  it: ["l'abitazione", 'tuttavia', 'approfittare'],
  nl: ['de woning', 'echter', 'solliciteren'],
  pt: ['a moradia', 'no entanto', 'aproveitar'],
  ru: ['квартира', 'однако', 'стремиться'],
  tr: ['ev', 'ancak', 'başvurmak'],
};

/** Kelime listesinden toplu kart oluşturma: önce önizleme, sonra seçilenleri ekleme. */
function aiBulkModal(deck) {
  if (!sync.user()) {
    toast('Yapay zekâ için önce giriş yapmalısın.', 'info');
    return authModal();
  }
  const BATCH = 10;
  const MAX = 100;
  let results = null; // önizlemedeki kartlar
  const existing = new Set(store.listCards(deck.id, '', Infinity).cards.map((c) => store.wordKey(c.word)));
  const form = openModal(`
    <h2>✨ Kelime listesinden kart oluştur</h2>
    <p class="muted" style="font-size:13px">Kelimeleri alt alta ya da virgülle ayırarak yaz. Yapay zekâ her biri için Türkçe anlam,
      ${esc(langName(deck.language))} örnek cümle ve eş anlamlıları hazırlar; eklemeden önce kontrol edebilirsin.</p>
    <label>Kelimeler <small>en fazla ${MAX}</small><textarea name="words" rows="3" class="autogrow"
      placeholder="${esc((AI_EXAMPLES[deck.language] || AI_EXAMPLES.en).join('\n'))}" autofocus></textarea></label>
    <div id="ai-progress" class="muted" style="font-size:13px"></div>
    <div id="ai-preview"></div>
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary" id="ai-submit">Oluştur</button>
    </div>`, {
    wide: true,
    onSubmit: async (f) => {
      if (results) {
        const picked = results.filter((_, i) => $(`[data-pick="${i}"]`, f)?.checked);
        if (!picked.length) { toast('Eklenecek kart seçilmedi.', 'info'); return false; }
        const r = store.importCards({ deck_id: deck.id }, picked.map((c) => ({
          word: c.word, translation: c.translation, sentence: c.sentence, synonyms: c.synonyms, ...c.extra,
        })));
        toast(`${r.added} kart eklendi.`, 'success');
        refreshDecks();
        renderDeck();
        return;
      }
      const words = [...new Map(f.words.value.split(/[\n,;]+/).map((w) => w.trim()).filter(Boolean)
        .map((w) => [store.wordKey(w), w])).values()];
      if (!words.length) { toast('En az bir kelime yaz.', 'info'); return false; }
      if (words.length > MAX) { toast(`Bir seferde en fazla ${MAX} kelime.`, 'error'); return false; }
      const progress = $('#ai-progress', f);
      const cards = [];
      for (let i = 0; i < words.length; i += BATCH) {
        progress.textContent = `Hazırlanıyor… ${Math.min(i + BATCH, words.length)}/${words.length} kelime`;
        try {
          cards.push(...await sync.aiCards(words.slice(i, i + BATCH), deck.language));
        } catch (e) {
          toast(e.message, 'error', 6000);
          if (!cards.length) { progress.textContent = ''; return false; }
          break;
        }
      }
      results = cards;
      const dup = (c) => existing.has(store.wordKey(c.word));
      progress.textContent = `${cards.length} kart hazır. Eklemek istemediklerinin işaretini kaldır.`;
      $('#ai-preview', f).innerHTML = `
        <div class="table-wrap ai-preview"><table class="cards"><tbody>${cards.map((c, i) => `
          <tr><td class="chk"><input type="checkbox" data-pick="${i}" ${dup(c) ? '' : 'checked'}></td>
            <td><b>${esc(c.word)}</b>${dup(c) ? ' <span class="muted">(destede var)</span>' : ''}
              <div class="muted">${esc(c.translation)}</div>
              <div class="ai-sentence">${esc(c.sentence)}</div></td></tr>`).join('')}
        </tbody></table></div>`;
      f.words.closest('label').classList.add('hidden');
      $('#ai-submit', f).textContent = 'Seçilenleri ekle';
      return false;
    },
  });
  // Kutu küçük başlar, yazdıkça büyür (en fazla ~10 satır)
  const box = form.words;
  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight + 2, 240)}px`;
  });
  return form;
}

/* =========================================================== paylaşım ve geçmiş */

async function shareModal(deck) {
  if (!sync.user()) {
    toast('Paylaşmak için önce giriş yapmalısın.', 'info');
    return authModal();
  }
  const isOwner = deck.role === 'owner';
  if (isOwner && !deck.share_code) {
    await sync.syncNow();
    refreshDecks();
    deck = deckById(deck.id) || deck;
    if (!deck.share_code) { toast('Deste henüz sunucuya yüklenemedi. İnternet bağlantını kontrol et.', 'error'); return; }
  }
  const form = openModal(`
    <h2>${isOwner ? 'Desteyi paylaş' : 'Deste üyeleri'}</h2>
    ${isOwner ? `
      <p class="muted" style="font-size:13px">Bu kodu verdiğin kişi “Kodla katıl” diyerek desteye katılır.
        Kartlar herkes için ortaktır, herkesin çalışma ilerlemesi ayrıdır.</p>
      <div class="share-code"><code>${esc(deck.share_code)}</code>
        <button type="button" data-copy>Kopyala</button>
        <button type="button" class="ghost" data-regen title="Eski kod geçersiz olur">Yenile</button></div>` : ''}
    <h3 style="font-size:14px;margin-top:4px">Üyeler</h3>
    <ul class="member-list" id="members"><li class="muted">Yükleniyor…</li></ul>
    ${isOwner ? '<p class="muted" style="font-size:12.5px">Yeni katılanlar görüntüleyici olarak başlar. Düzenleme yetkisi verdiğin kişiler kart ekleyip düzenleyebilir.</p>' : ''}
    <div class="modal-actions"><button type="button" data-close>Kapat</button></div>`, { wide: true });

  const renderMembers = async () => {
    const list = await sync.fetchMembers(deck.id);
    const me = sync.user().id;
    $('#members', form).innerHTML = list.map((m) => {
      const name = m.profiles?.display_name || 'Kullanıcı';
      const role = isOwner && m.role !== 'owner'
        ? `<select data-role="${m.user_id}">${['editor', 'viewer'].map((r) => `<option value="${r}" ${r === m.role ? 'selected' : ''}>${ROLES[r]}</option>`).join('')}</select>
           <button type="button" class="icon-btn small" data-remove="${m.user_id}" title="Desteden çıkar">✕</button>`
        : `<span class="muted" style="font-size:13px">${ROLES[m.role]}</span>`;
      return `<li><span class="avatar">${esc(name.charAt(0).toLocaleUpperCase('tr'))}</span>
        <span class="m-name">${esc(name)}${m.user_id === me ? ' <span class="muted">(sen)</span>' : ''}</span>${role}</li>`;
    }).join('');
  };
  await guard(renderMembers);

  $('[data-copy]', form)?.addEventListener('click', () => guard(async () => {
    await navigator.clipboard.writeText(deck.share_code);
    toast('Kod kopyalandı.', 'success', 1500);
  }));
  $('[data-regen]', form)?.addEventListener('click', () => guard(async () => {
    const code = await sync.regenerateShareCode(deck.id);
    deck = { ...deck, share_code: code };
    $('.share-code code', form).textContent = code;
    refreshDecks();
    toast('Yeni kod oluşturuldu. Eski kod artık çalışmaz.', 'success');
  }));
  form.addEventListener('change', (e) => {
    const uid = e.target.dataset.role;
    if (uid) guard(async () => { await sync.setMemberRole(deck.id, uid, e.target.value); toast('Yetki güncellendi.', 'success', 1500); });
  });
  form.addEventListener('click', (e) => {
    const uid = e.target.closest('[data-remove]')?.dataset.remove;
    if (!uid) return;
    guard(async () => {
      const code = await sync.removeMember(deck.id, uid);
      refreshDecks();
      deck = { ...deck, share_code: code || deckById(deck.id)?.share_code || deck.share_code };
      $('.share-code code', form).textContent = deck.share_code;
      await renderMembers();
      toast('Üye çıkarıldı. Paylaşım kodu da yenilendi; eski kod artık çalışmaz.', 'success', 5000);
    });
  });
}

const FIELD_LABELS = {
  word: 'Kelime', translation: 'Türkçesi', sentence: 'Örnek cümle', synonyms: 'Eş anlamlılar',
  notes: 'Not', extra: 'Ek alanlar', name: 'Ad', language: 'Dil', role: 'Yetki',
};

function diffValue(field, v) {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'role') return ROLES[v] || v;
  if (field === 'language') return langName(v);
  if (Array.isArray(v)) return v.join(', ') || '—';
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${x}`).join(', ') || '—';
  return String(v);
}

function describeChange(ch, count = 1) {
  const w = `“${esc(ch.summary)}”`;
  const actor = ch.profiles?.display_name || 'Biri';
  switch (`${ch.entity}:${ch.action}`) {
    case 'deck:create': return 'desteyi oluşturdu';
    case 'deck:update': return 'deste bilgilerini değiştirdi';
    case 'deck:delete': return 'desteyi sildi';
    case 'card:create': return count > 1 ? `<b>${count}</b> kart ekledi` : `${w} kartını ekledi`;
    case 'card:update': return `${w} kartını düzenledi`;
    case 'card:delete': return count > 1 ? `<b>${count}</b> kart sildi` : `${w} kartını sildi`;
    case 'card:restore': return `${w} kartını geri getirdi`;
    case 'card:move_in': return `${w} kartını bu desteye taşıdı`;
    case 'card:move_out': return `${w} kartını başka bir desteye taşıdı`;
    case 'member:join': return actor === ch.summary ? 'desteye katıldı' : `${esc(ch.summary)} desteye katıldı`;
    case 'member:leave': return actor === ch.summary ? 'desteden ayrıldı' : `<b>${esc(ch.summary)}</b> kişisini desteden çıkardı`;
    case 'member:role': return `<b>${esc(ch.summary)}</b> kişisinin yetkisini değiştirdi`;
    default: return `${esc(ch.action)} (${esc(ch.entity)})`;
  }
}

// Aynı kişinin aynı cihazdan art arda yaptığı toplu ekleme/silmeleri tek satırda topla.
function groupChanges(rows) {
  const out = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    const bulk = r.entity === 'card' && (r.action === 'create' || r.action === 'delete');
    if (bulk && last && last.entity === r.entity && last.action === r.action && last.user_id === r.user_id
      && last.device === r.device && Math.abs(new Date(last.at) - new Date(r.at)) < 5 * 60_000) {
      last.count++;
      if (last.words.length < 6) last.words.push(r.summary);
      continue;
    }
    out.push({ ...r, count: 1, words: [r.summary] });
  }
  return out;
}

async function historyModal(deck) {
  const form = openModal(`
    <h2>Değişiklik geçmişi</h2>
    <p class="muted" style="font-size:13px">${esc(deck.name)} destesinde kim, hangi cihazdan, neyi değiştirdi.</p>
    <div class="history" id="history"><div class="muted">Yükleniyor…</div></div>
    <div class="modal-actions"><button type="button" data-close>Kapat</button></div>`, { wide: true });
  try {
    await sync.syncNow();
    const rows = groupChanges(await sync.fetchHistory(deck.id));
    let day = '';
    $('#history', form).innerHTML = rows.length ? rows.map((ch) => {
      const d = new Date(ch.at);
      const dayLabel = d.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
      const head = dayLabel !== day ? `<div class="day">${esc(dayLabel)}</div>` : '';
      day = dayLabel;
      const name = ch.profiles?.display_name || 'Silinmiş kullanıcı';
      const diff = ch.diff ? Object.entries(ch.diff).map(([f, [a, b]]) => `<div class="h-diff">${esc(FIELD_LABELS[f] || f)}: <del>${esc(diffValue(f, a))}</del> → <ins>${esc(diffValue(f, b))}</ins></div>`).join('') : '';
      const words = ch.count > 1 ? `<div class="h-diff">${ch.words.map(esc).join(', ')}${ch.count > ch.words.length ? '…' : ''}</div>` : '';
      return `${head}<div class="h-item">
        <span class="avatar">${esc(name.charAt(0).toLocaleUpperCase('tr'))}</span>
        <div class="h-who"><b>${esc(name)}</b>${ch.device ? ` · ${esc(ch.device)}` : ''} · ${d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</div>
        <div class="h-what">${describeChange(ch, ch.count)}</div>
        <div>${diff}${words}</div>
      </div>`;
    }).join('') : '<div class="muted">Henüz kayıtlı bir değişiklik yok.</div>';
  } catch (e) {
    $('#history', form).innerHTML = `<div class="muted">Geçmiş yüklenemedi: ${esc(e.message)}</div>`;
  }
}

function joinModal() {
  if (!sync.user()) {
    toast('Bir desteye katılmak için önce giriş yapmalısın.', 'info');
    return authModal();
  }
  openModal(`
    <h2>Kodla desteye katıl</h2>
    <p class="muted" style="font-size:13px">Deste sahibinden aldığın paylaşım kodunu gir.</p>
    <label>Paylaşım kodu<input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="16"
      style="font:600 20px ui-monospace,Consolas,monospace;letter-spacing:.1em;text-transform:uppercase" autofocus></label>
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">Katıl</button>
    </div>`, {
    onSubmit: async (f) => {
      const code = $('[name=code]', f).value.trim();
      if (!code) return false;
      const deckId = await sync.joinDeck(code);
      refreshDecks();
      const d = deckById(deckId);
      toast(d ? `“${d.name}” destesine katıldın.` : 'Desteye katıldın.', 'success');
      if (d) openDeck(deckId);
    },
  });
}

/* =========================================================== içe / dışa aktarma */

async function download(filename, obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2);
  if (NativeFS && NativeShare) {
    // Android: dosyayı geçici klasöre yaz, paylaş menüsüyle kaydet/gönder (Drive, Dosyalar, WhatsApp...)
    const { uri } = await NativeFS.writeFile({ path: filename, data: text, directory: 'CACHE', encoding: 'utf8' });
    try {
      await NativeShare.share({ title: filename, files: [uri], dialogTitle: 'Dosyayı kaydet ya da gönder' });
    } catch (e) {
      if (!/cancel/i.test(e?.message || '')) throw e;
    }
    return;
  }
  const blob = new Blob([text], { type: filename.endsWith('.txt') ? 'text/plain;charset=utf-8' : 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // Android'in dosya seçicisi .json uzantısını tanımayabiliyor; orada filtreleme yapma
    if (!isNative) input.accept = '.json,application/json,text/plain';
    input.onchange = async () => {
      const f = input.files[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}

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
      new_per_day: o.new_per_day, direction: o.direction,
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
  return { decks, backup: data?.format === 'kelime-backup' };
}

function sampleOf(cards) {
  const c = cards.find((x) => x && typeof x === 'object');
  if (!c) return '';
  return Object.entries(c).filter(([k]) => k !== 'srs').slice(0, 4)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`).join(' · ');
}

async function importFlow(presetDeckId) {
  const f = await pickFile();
  if (f) importText(f.name, f.text, presetDeckId);
}

function importText(filename, text, presetDeckId) {
  let parsed;
  try { parsed = parseImport(text, filename); } catch (e) { toast(e.message, 'error', 6000); return; }
  const { decks, backup } = parsed;
  const finish = (results) => {
    const sum = results.reduce((a, r) => ({ added: a.added + r.added, updated: a.updated + r.updated, skipped: a.skipped + r.skipped }), { added: 0, updated: 0, skipped: 0 });
    toast(`${sum.added} kart eklendi${sum.updated ? `, ${sum.updated} kart güncellendi` : ''}${sum.skipped ? `, ${sum.skipped} geçersiz kayıt atlandı` : ''}.`, 'success', 4500);
    refreshDecks();
    openDeck(results[results.length - 1].deck_id);
  };
  const findDeck = (name) => state.decks.find((d) => d.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr'));
  const targetOf = (d) => ({ name: d.name, language: d.language, new_per_day: d.new_per_day, direction: d.direction });

  if (decks.length > 1 || backup) {
    openModal(`
      <h2>${backup ? 'Yedeği geri yükle' : 'İçe aktar'}</h2>
      <p class="muted">${esc(filename)} içinde ${decks.length} deste bulundu. Aynı isimli deste varsa kartlar onun içine eklenir.
        ${backup ? 'Çalışma ilerlemesi de aktarılır (henüz çalışılmamış kartlar için).' : ''}</p>
      <ul class="import-list">${decks.map((d) => `
        <li><span><b>${esc(d.name)}</b> <span class="muted">· ${esc(langName(d.language))}</span></span>
        <span class="muted">${d.cards.length} kart · ${findDeck(d.name) ? 'mevcut desteye' : 'yeni deste'}</span></li>`).join('')}
      </ul>
      <div class="modal-actions">
        <button type="button" data-close>Vazgeç</button>
        <button type="submit" class="primary">İçe aktar</button>
      </div>`, {
      onSubmit: () => finish(decks.map((d) => store.importCards(targetOf(d), d.cards))),
    });
    return;
  }

  const d = decks[0];
  const editableDecks = state.decks.filter((x) => x.role !== 'viewer');
  const presetOk = presetDeckId && editableDecks.some((x) => x.id === presetDeckId);
  const match = presetOk ? deckById(presetDeckId) : findDeck(d.name);
  const useExisting = !!match && match.role !== 'viewer';
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
    ${editableDecks.length ? `
    <div class="import-option ${useExisting ? '' : 'disabled'}" data-opt="existing">
      <label class="radio"><input type="radio" name="mode" value="existing" ${useExisting ? 'checked' : ''}> Mevcut desteye ekle</label>
      <select name="deck_id">${editableDecks.map((x) => `<option value="${x.id}" ${match && x.id === match.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    </div>` : ''}
    <p class="muted" style="font-size:12.5px">Destede zaten olan kelimelerin içeriği güncellenir, çalışma ilerlemesi korunur.</p>
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">İçe aktar</button>
    </div>`, {
    onSubmit: (f) => {
      const fd = Object.fromEntries(new FormData(f));
      const target = fd.mode === 'existing'
        ? { deck_id: fd.deck_id }
        : { name: fd.name.trim() || d.name, language: fd.language };
      finish([store.importCards(target, d.cards)]);
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

// Ek alanların (JSON'dan ya da yapay zekâdan) kartta görünen adları
const EXTRA_LABELS = { type: 'Tür', plural: 'Çoğul', forms: 'Çekim', article: 'Artikel', gender: 'Cinsiyet', level: 'Seviye' };
// Düzenleme penceresinde de aynı Türkçe adlar
function extraToText(extra) {
  return Object.entries(extra || {}).map(([k, v]) => `${EXTRA_LABELS[k.toLowerCase()] || k}: ${v}`).join('\n');
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
    ? `<dl class="extra">${extraEntries.map(([k, v]) => `<dt>${esc(EXTRA_LABELS[k.toLowerCase()] || k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : '';

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
  leaveEssay();
  if (state.study?.timer) clearTimeout(state.study.timer);
  state.study = null;
  stopSpeech();
}

function startStudy() {
  const res = store.nextCard(state.deckId);
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
      s.timer = setTimeout(() => guard(() => {
        if (state.study === s) showStudyCard(store.nextCard(state.deckId));
      }), Math.min(wait, 2 ** 31 - 1));
    }
  } else {
    body = `<div class="card-stage"><div class="flash ${s.flipped ? '' : 'tappable'}" ${s.flipped ? '' : 'data-act="flip"'}>${renderFaces(card, s.reverse, s.flipped)}</div></div>`;
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
        <button class="ghost" data-act="back-deck" title="Desteye dön (Esc)">${ICON.back} ${esc(deck?.name || '')}</button>
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

function rate(r) {
  const s = state.study;
  if (!s?.res.card || !s.flipped || s.busy) return;
  s.busy = true;
  guard(() => {
    const res = store.answer(s.res.card.id, r, state.deckId);
    if (state.study !== s) return;
    showStudyCard(res);
    refreshDecks();
  });
  s.busy = false;
}

function undo() {
  if (state.view !== 'study') return;
  guard(() => {
    const res = store.undo(state.deckId);
    showStudyCard(res);
    refreshDecks();
    toast('Son cevap geri alındı.', 'info', 1500);
  });
}

function editCurrent() {
  const s = state.study;
  if (!s?.res.card) return;
  cardForm(s.res.card, state.deckId, (saved) => {
    if (state.study !== s) return;
    if (!saved) { showStudyCard(store.nextCard(state.deckId)); refreshDecks(); return; }
    s.res.card = { ...s.res.card, ...saved };
    renderStudy();
  });
}

function backToDeck() {
  leaveStudy();
  refreshDecks();
  openDeck(state.deckId);
}

/* =========================================================== çalışma sayacı */

// Sayacın durumu cihazda tutulur; uygulama kapanıp açılsa da kaldığı yerden devam eder.
// Duvar saatine göre hesaplandığı için arka planda geçen süre de sayılır.
const TIMER_KEY = 'kelime.timer';
const TIMER_NOTIF_ID = 4242;
const TIMER_PRESETS = [15, 25, 45, 60, 90];
const timer = (() => {
  const base = { status: 'idle', planned: 25, startedAt: 0, runStart: 0, elapsed: 0 };
  try { return { ...base, ...JSON.parse(localStorage.getItem(TIMER_KEY)) }; } catch { return base; }
})();
const saveTimer = () => { try { localStorage.setItem(TIMER_KEY, JSON.stringify(timer)); } catch { /* yok say */ } };
const timerElapsed = () => timer.elapsed + (timer.status === 'running' ? Date.now() - timer.runStart : 0);
const timerRemaining = () => Math.max(0, timer.planned * 60_000 - timerElapsed());
const liveSec = () => (timer.status === 'idle' ? 0 : Math.floor(timerElapsed() / 1000));

function fmtClock(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
}
function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  if (m < 1) return sec > 0 ? '<1 dk' : '0 dk';
  const h = Math.floor(m / 60);
  return h ? `${h} sa${m % 60 ? ` ${m % 60} dk` : ''}` : `${m} dk`;
}

let timerTick = null;
function syncTimerTick() {
  clearInterval(timerTick);
  timerTick = timer.status === 'running' ? setInterval(onTimerTick, 1000) : null;
}
function onTimerTick() {
  if (timer.status === 'running' && timerRemaining() <= 0) { timerFinish(true); return; }
  renderTimer();
}

function timerStart() {
  if (timer.status === 'idle') { timer.startedAt = Date.now(); timer.elapsed = 0; }
  timer.status = 'running';
  timer.runStart = Date.now();
  saveTimer();
  syncTimerTick();
  scheduleTimerAlert();
  renderTimer();
  sync.heartbeat().catch(() => {});
}

function timerPause() {
  if (timer.status !== 'running') return;
  timer.elapsed = timerElapsed();
  timer.status = 'paused';
  saveTimer();
  syncTimerTick();
  cancelTimerAlert();
  renderTimer();
  sync.heartbeat().catch(() => {});
}

function timerReset() {
  Object.assign(timer, { status: 'idle', startedAt: 0, runStart: 0, elapsed: 0 });
  saveTimer();
  syncTimerTick();
  cancelTimerAlert();
  sync.heartbeat().catch(() => {});
}

/** Oturumu bitirir ve kaydeder. completed: süre doldu (erken bitirme değil). */
function timerFinish(completed) {
  if (timer.status === 'idle') return;
  const plannedMs = timer.planned * 60_000;
  const actualMs = completed ? plannedMs : timerElapsed();
  // Uygulama kapalıyken dolduysa bitiş anı, gerçek dolma anıdır
  const endedAt = completed && timer.status === 'running' ? timer.runStart + (plannedMs - timer.elapsed) : Date.now();
  const planned = timer.planned;
  const startedAt = timer.startedAt;
  timerReset();
  if (actualMs >= 60_000) {
    store.addSession({ startedAt, endedAt, plannedMin: planned, actualSec: Math.round(actualMs / 1000) });
  } else if (!completed) {
    toast('1 dakikadan kısa oturumlar kaydedilmez.', 'info');
  }
  renderTimer();
  refreshStudyTime();
  if (completed) {
    timerAlarm();
    const msg = `${planned} dakikalık çalışma tamamlandı. Bugün toplam ${fmtDur(store.studyStats().today)}.`;
    if (!isNative && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('Süre doldu 🎉', { body: msg, icon: 'icons/icon-192.png' });
    }
    if (!modalOpen() || $('#tm-display')) {
      openModal(`
        <div style="text-align:center;font-size:44px">🎉</div>
        <h2 style="text-align:center">Süre doldu!</h2>
        <p class="muted" style="text-align:center">${esc(msg)}</p>
        <div class="modal-actions">
          <button type="button" data-close>Tamam</button>
          <button type="submit" class="primary">Yeniden başlat (${planned} dk)</button>
        </div>`, { onSubmit: () => { timer.planned = planned; timerStart(); } });
    } else {
      toast(`Süre doldu! ${msg}`, 'success', 8000);
    }
  } else if (actualMs >= 60_000) {
    toast(`Oturum kaydedildi: ${fmtDur(Math.round(actualMs / 1000))}.`, 'success');
  }
}

// Kısa üç bip + titreşim
function timerAlarm() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.35, 0.7].forEach((t) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 880;
      o.connect(g);
      g.connect(ctx.destination);
      g.gain.setValueAtTime(0.0001, ctx.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + t + 0.3);
      o.start(ctx.currentTime + t);
      o.stop(ctx.currentTime + t + 0.32);
    });
  } catch { /* ses çalınamadı */ }
  navigator.vibrate?.([250, 120, 250, 120, 250]);
}

// Android: süre dolunca uygulama kapalı ya da ekran kilitliyken de bildirim gelsin
async function scheduleTimerAlert() {
  if (NativeNotif) {
    try {
      const perm = await NativeNotif.checkPermissions();
      if (perm.display !== 'granted' && (await NativeNotif.requestPermissions()).display !== 'granted') return;
      await NativeNotif.cancel({ notifications: [{ id: TIMER_NOTIF_ID }] }).catch(() => {});
      await NativeNotif.schedule({
        notifications: [{
          id: TIMER_NOTIF_ID,
          title: 'Süre doldu 🎉',
          body: `${timer.planned} dakikalık çalışma tamamlandı.`,
          schedule: { at: new Date(Date.now() + timerRemaining()), allowWhileIdle: true },
        }],
      });
    } catch (e) { console.warn('Bildirim planlanamadı', e); }
  } else if ('Notification' in window && Notification.permission === 'default') {
    // Bilgisayarda: sekme arka plandayken süre dolunca sistem bildirimi için izin iste
    Notification.requestPermission().catch(() => {});
  }
}
function cancelTimerAlert() {
  NativeNotif?.cancel({ notifications: [{ id: TIMER_NOTIF_ID }] }).catch(() => {});
}

/** Sol menüdeki sayaç kutusu, mobil üst çubuk göstergesi ve açık sayaç penceresi. */
function renderTimer() {
  const stats = store.studyStats(liveSec());
  const idle = timer.status === 'idle';
  const left = fmtClock(timerRemaining());
  const pct = idle ? 0 : Math.min(100, (timerElapsed() / (timer.planned * 60_000)) * 100);
  const widget = $('#timer-widget');
  widget.classList.toggle('running', timer.status === 'running');
  widget.classList.toggle('paused', timer.status === 'paused');
  widget.innerHTML = idle
    ? `<span class="tw-icon">⏱</span><span class="tw-main">Çalışma sayacı</span>
       <span class="tw-sub">Bugün <b>${fmtDur(stats.today)}</b>${stats.streak > 1 ? ` · 🔥 ${stats.streak} gün` : ''}</span>`
    : `<span class="tw-icon">${timer.status === 'paused' ? '⏸' : '⏱'}</span><span class="tw-main tw-clock">${left}</span>
       <span class="tw-sub">${timer.status === 'paused' ? 'Duraklatıldı' : `${timer.planned} dk oturum`} · Bugün <b>${fmtDur(stats.today)}</b></span>
       <span class="tw-bar"><span style="width:${pct}%"></span></span>`;
  const chip = $('#timer-chip');
  chip.textContent = idle ? '⏱' : `${timer.status === 'paused' ? '⏸' : '⏱'} ${left}`;
  chip.classList.toggle('active', !idle);
  document.title = timer.status === 'running' ? `${left} · Kelime` : 'Kelime';
  const home = $('#home-today');
  if (home) home.textContent = fmtDur(stats.today);
  if ($('#tm-display')) renderTimerModal(false);
  renderEssayTimerBtn();
}

function timerModal() {
  const form = openModal(`
    <h2>⏱ Çalışma sayacı</h2>
    <div class="tm-display" id="tm-display"></div>
    <div class="tm-progress"><span id="tm-bar"></span></div>
    <div id="tm-setup">
      <label>Süre <small><b id="tm-min">${timer.planned}</b> dakika</small>
        <input type="range" id="tm-range" min="1" max="180" step="1" value="${timer.planned}"></label>
      <div class="tm-presets">${TIMER_PRESETS.map((m) => `<button type="button" data-tm-preset="${m}">${m} dk</button>`).join('')}
        <input type="number" id="tm-number" min="1" max="180" inputmode="numeric" value="${timer.planned}" title="Dakika (1-180)"></div>
    </div>
    <div class="tm-actions" id="tm-actions"></div>
    <div class="tm-summary" id="tm-summary"></div>
    <h3 class="tm-h">Geçmiş</h3>
    <div class="tm-history" id="tm-history"></div>
    <div class="modal-actions"><button type="button" data-close>Kapat</button></div>`, { wide: true });

  const setPlanned = (m) => {
    timer.planned = Math.min(180, Math.max(1, Math.round(Number(m) || 1)));
    saveTimer();
    $('#tm-range', form).value = timer.planned;
    $('#tm-number', form).value = timer.planned;
    $('#tm-min', form).textContent = timer.planned;
    renderTimerModal(false);
  };
  $('#tm-range', form).addEventListener('input', (e) => setPlanned(e.target.value));
  $('#tm-number', form).addEventListener('change', (e) => setPlanned(e.target.value));
  form.addEventListener('click', (e) => {
    const preset = e.target.closest('[data-tm-preset]')?.dataset.tmPreset;
    if (preset) return setPlanned(preset);
    const act = e.target.closest('[data-tm]')?.dataset.tm;
    if (act === 'start' || act === 'resume') timerStart();
    else if (act === 'pause') timerPause();
    else if (act === 'finish') timerFinish(false);
    else if (act === 'cancel') {
      confirmBox('Bu oturum kaydedilmeden iptal edilecek.', { ok: 'İptal et', danger: true }).then((yes) => {
        if (yes) { timerReset(); renderTimer(); }
        timerModal();
      });
      return;
    } else {
      const del = e.target.closest('[data-tm-del]')?.dataset.tmDel;
      if (del) {
        confirmBox('Bu oturum geçmişten silinecek.', { ok: 'Sil', danger: true }).then((yes) => {
          if (yes) { store.deleteSession(del); refreshStudyTime(); renderTimer(); }
          timerModal();
        });
      }
      return;
    }
    renderTimerModal(true);
  });
  renderTimerModal(true);
}

/** full: butonları ve geçmişi de yeniden çiz (her saniye sadece saat güncellenir). */
function renderTimerModal(full) {
  const idle = timer.status === 'idle';
  $('#tm-display').textContent = fmtClock(idle ? timer.planned * 60_000 : timerRemaining());
  $('#tm-display').classList.toggle('paused', timer.status === 'paused');
  $('#tm-bar').style.width = `${idle ? 0 : Math.min(100, (timerElapsed() / (timer.planned * 60_000)) * 100)}%`;
  const st = store.studyStats(liveSec());
  $('#tm-summary').innerHTML = `<span>Bugün <b>${fmtDur(st.today)}</b></span><span>Bu hafta <b>${fmtDur(st.weekTotal)}</b></span>
    <span>🔥 Seri <b>${st.streak} gün</b></span>`;
  if (!full) return;
  $('#tm-setup').classList.toggle('hidden', !idle);
  $('#tm-actions').innerHTML = idle
    ? '<button type="button" class="primary big" data-tm="start">▶ Başlat</button>'
    : `${timer.status === 'running'
      ? '<button type="button" class="big" data-tm="pause">⏸ Duraklat</button>'
      : '<button type="button" class="primary big" data-tm="resume">▶ Devam et</button>'}
       <button type="button" class="big" data-tm="finish" title="Şu ana kadarki süreyi kaydet">✓ Bitir ve kaydet</button>
       <button type="button" class="danger-ghost" data-tm="cancel">İptal</button>`;
  renderTimerHistory();
}

function renderTimerHistory() {
  const box = $('#tm-history');
  if (!box) return;
  const sessions = store.listSessions(30);
  if (!sessions.length) {
    box.innerHTML = '<div class="muted" style="font-size:13px">Henüz kayıtlı oturum yok. İlk oturumunu başlat!</div>';
    return;
  }
  const groups = new Map();
  for (const s of sessions) {
    const k = store.dayKey(s.started_at * 1000);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(s);
  }
  const time = (sec) => new Date(sec * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  box.innerHTML = [...groups.values()].map((list) => {
    const total = list.reduce((a, s) => a + s.actual_sec, 0);
    const label = new Date(list[0].started_at * 1000).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long' });
    return `<div class="tm-day"><span>${esc(label)}</span><b>${fmtDur(total)}</b></div>
      ${list.map((s) => `<div class="tm-item">
        <span>${time(s.started_at)} – ${time(s.ended_at)}</span>
        <span><b>${fmtDur(s.actual_sec)}</b>${s.actual_sec < s.planned_min * 60 - 30 ? ` <span class="muted">/ ${s.planned_min} dk</span>` : ''}</span>
        <span class="muted tm-dev">${esc(s.device || '')}</span>
        <button type="button" class="icon-btn small" data-tm-del="${s.id}" title="Sil">✕</button>
      </div>`).join('')}`;
  }).join('');
}

/* ---- çalışma panosu: bugün kim ne kadar çalıştı (motivasyon) */

const board = { myVisibility: 'shared', timer: null };
const ONLINE_WINDOW = 150 * 1000; // son 2,5 dakikada sinyal gelmişse çevrimiçi

async function loadBoard() {
  const box = $('#board');
  if (!box) return;
  clearTimeout(board.timer);
  const since = new Date();
  since.setHours(0, 0, 0, 0);
  let rows;
  try {
    rows = await sync.fetchBoard(since);
  } catch (e) {
    box.innerHTML = `<div class="muted">Pano yüklenemedi: ${esc(e.message)}</div>`;
    return;
  }
  if (!$('#board')) return; // bu arada başka ekrana geçildi
  if (rows === null) { box.remove(); return; } // sunucuda pano henüz kurulmadı
  const me = rows.find((r) => r.is_me);
  if (me) board.myVisibility = me.visibility;
  const now = Date.now();
  const live = (r) => (r.studying_since ? Math.max(0, Math.floor(now / 1000) - Number(r.studying_since)) : 0);
  const list = rows.map((r) => ({
    ...r,
    // kendi satırında cihazdaki gerçek değerleri kullan (henüz eşitlenmemiş olabilir)
    seconds: r.is_me ? store.studyStats(liveSec()).today : r.seconds_today + live(r),
    online: r.is_me || (r.last_seen && now - new Date(r.last_seen).getTime() < ONLINE_WINDOW),
    studying: r.is_me ? timer.status === 'running' : !!r.studying_since && now - new Date(r.last_seen).getTime() < ONLINE_WINDOW,
  })).sort((a, b) => b.seconds - a.seconds || b.words_today - a.words_today);
  const others = list.filter((r) => !r.is_me).length;
  box.innerHTML = `
    <div class="board-head">
      <h3>👥 Bugün</h3>
      <span class="muted">${others ? `${list.filter((r) => r.online && !r.is_me).length} kişi çevrimiçi` : ''}</span>
    </div>
    <div class="board-list">${list.map((r, i) => `
      <div class="board-row ${r.is_me ? 'me' : ''}">
        <span class="board-rank">${i + 1}</span>
        <span class="avatar sm">${esc((r.display_name || '?').charAt(0).toLocaleUpperCase('tr'))}<i class="presence ${r.online ? 'on' : ''}" title="${r.online ? 'Çevrimiçi' : 'Çevrimdışı'}"></i></span>
        <span class="board-name">${esc(r.display_name || 'Kullanıcı')}${r.is_me ? ' <span class="muted">(sen)</span>' : ''}
          ${r.studying ? '<span class="board-live">⏱ çalışıyor</span>' : ''}</span>
        <span class="board-stat" title="Bugün eklenen kelime">📝 <b>${r.words_today}</b></span>
        <span class="board-stat" title="Bugün çalışma süresi">⏱ <b>${fmtDur(r.seconds)}</b></span>
      </div>`).join('')}
    </div>
    ${others ? '' : `<p class="muted board-empty">Henüz burada sadece sen varsın. Bir desteni paylaş (deste › ⚙ › Paylaş) ya da hesap ayarlarından panoda görünürlüğünü “Herkes” yap; arkadaşların burada görünsün.</p>`}`;
  // Ana sayfa açıkken dakikada bir yenile
  board.timer = setTimeout(() => { if (state.view === 'home' && !document.hidden) loadBoard(); }, 60_000);
}

/** Ana sayfadaki "Bugün çalıştın" kutusu. */
function studyTimePanel() {
  const st = store.studyStats(liveSec());
  const max = Math.max(...st.week.map((d) => d.sec), 1);
  const days = ['Pz', 'Pt', 'Sa', 'Ça', 'Pe', 'Cu', 'Ct'];
  return `
    <section class="panel study-time" id="study-time">
      <div class="st-today">
        <span class="muted">Bugün çalıştın</span>
        <b id="home-today">${fmtDur(st.today)}</b>
        <span class="muted st-meta">${st.streak ? `🔥 ${st.streak} gün üst üste · ` : ''}Bu hafta ${fmtDur(st.weekTotal)}</span>
        <button class="primary" data-act="timer">${timer.status === 'idle' ? '⏱ Sayacı başlat' : '⏱ Sayacı aç'}</button>
      </div>
      <div class="st-week" title="Son 7 gün">
        ${st.week.map((d) => `<div class="st-day ${d.today ? 'today' : ''}" title="${esc(d.date.toLocaleDateString('tr-TR', { day: 'numeric', month: 'long' }))}: ${fmtDur(d.sec)}">
          <span class="st-val">${d.sec >= 60 ? Math.round(d.sec / 60) : ''}</span>
          <span class="st-bar"><span style="height:${Math.max(d.sec ? 6 : 0, (d.sec / max) * 100)}%"></span></span>
          <span class="st-lbl">${days[d.date.getDay()]}</span>
        </div>`).join('')}
      </div>
    </section>`;
}

function refreshStudyTime() {
  const el = $('#study-time');
  if (el) el.outerHTML = studyTimePanel();
  renderTimerHistory();
}

/* =========================================================== IELTS yazıları */

const ESSAY_TASKS = {
  task2: { label: 'Task 2 · Essay', min: 250, max: 320, minutes: 40 },
  task1: { label: 'Academic Task 1 · Rapor', min: 150, max: 200, minutes: 20 },
  gt1: { label: 'General Task 1 · Mektup', min: 150, max: 200, minutes: 20 },
  free: { label: 'Serbest yazı', min: 0, max: 0, minutes: 0 },
};

// IELTS sayımı: boşlukla ayrılan her parça bir kelimedir (bilgisayarlı sınavdaki sayaç gibi).
// İçinde harf ya da rakam olmayan parçalar (–, &, ...) kelime sayılmaz.
// Böylece don't, well-known, 2020, 45% tek kelime; a, the ve dolgu kelimeleri de sayılır.
const essayTokens = (text) => text.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
const normToken = (t) => t.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');

/** Sorudan aynen kopyalanmış görünen kelimeler: soruyla ortak, en az 6 kelimelik ardışık diziler. */
function copiedFromPrompt(tokens, prompt) {
  const N = 6;
  const p = essayTokens(prompt).map(normToken).filter(Boolean);
  if (p.length < N || tokens.length < N) return { count: 0, phrases: [] };
  const grams = new Set();
  for (let i = 0; i + N <= p.length; i++) grams.add(p.slice(i, i + N).join(' '));
  const words = tokens.map(normToken);
  const marked = new Array(words.length).fill(false);
  for (let i = 0; i + N <= words.length; i++) {
    if (grams.has(words.slice(i, i + N).join(' '))) for (let j = i; j < i + N; j++) marked[j] = true;
  }
  const phrases = [];
  let run = [];
  marked.forEach((m, i) => {
    if (m) run.push(tokens[i]);
    if ((!m || i === marked.length - 1) && run.length) { phrases.push(run.join(' ')); run = []; }
  });
  return { count: marked.filter(Boolean).length, phrases };
}

const FILLERS = ['very', 'really', 'basically', 'actually', 'literally', 'just', 'stuff', 'things', 'thing',
  'a lot of', 'lots of', 'kind of', 'sort of', 'you know', 'i mean', 'etc'];
const STOPWORDS = new Set(('a an the and or but if so of to in on at by for with from as is are was were be been being '
  + 'this that these those it its they them their there here he she his her we our you your i me my not no can could '
  + 'will would should may might must do does did have has had which who whom what when where why how than then also '
  + 'more most some any such into about over after before between because while all each other many much very').split(' '));

export function analyzeEssay(body, prompt) {
  const tokens = essayTokens(body);
  const copied = copiedFromPrompt(tokens, prompt || '');
  const lower = ` ${body.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ')} `;
  const fillers = FILLERS.map((f) => [f, (lower.match(new RegExp(` ${f} `, 'g')) || []).length]).filter(([, n]) => n);
  const freq = new Map();
  for (const t of tokens) {
    const w = normToken(t);
    if (w.length > 2 && !STOPWORDS.has(w) && !/^\d+$/.test(w)) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const repeated = [...freq].filter(([, n]) => n >= 4).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const blocks = body.split(/\n\s*\n/).filter((b) => b.trim());
  const lines = body.split('\n').filter((l) => l.trim());
  return {
    words: tokens.length,
    net: tokens.length - copied.count,
    copied,
    fillers,
    repeated,
    paragraphs: blocks.length > 1 ? blocks.length : lines.length,
    sentences: (body.match(/[\p{L}\p{N})"'”’][.!?]+(?=\s|$)/gu) || []).length,
  };
}

const essayTitle = (e) => e.title.trim() || (e.body.trim() ? `${essayTokens(e.body).slice(0, 6).join(' ')}…` : 'Başlıksız yazı');

function showEssays() {
  leaveStudy();
  state.view = 'essays';
  document.body.classList.remove('menu-open');
  renderSidebar();
  setTitle('Yazılarım');
  const essays = store.listEssays();
  main.innerHTML = `
    <div class="page">
      <header class="deck-head">
        <button class="icon-btn head-btn" data-act="home" title="Ana sayfaya dön (Esc)" aria-label="Ana sayfaya dön">${ICON.home}</button>
        <div class="deck-title">
          <h1>Yazılarım</h1>
          <div class="sub">IELTS Writing · ${essays.length} yazı</div>
        </div>
        <button class="primary" data-act="essay-new">+ Yeni yazı</button>
      </header>
      ${essays.length ? `<div class="essay-list">${essays.map((e) => {
        const t = ESSAY_TASKS[e.task] || ESSAY_TASKS.free;
        const ok = !t.min || e.words >= t.min;
        return `<button class="essay-item" data-essay="${e.id}">
          <span class="ei-title">${esc(essayTitle(e))}</span>
          <span class="ei-meta"><span class="badge">${esc(t.label)}</span>
            <span class="${ok ? 'ei-ok' : 'ei-short'}">${e.words}${t.min ? ` / ${t.min}` : ''} kelime</span>
            <span class="muted">${new Date(e.edited_at * 1000).toLocaleDateString('tr-TR', { day: 'numeric', month: 'short', year: 'numeric' })}</span></span>
          ${e.body.trim() ? `<span class="ei-preview">${esc(e.body.trim().slice(0, 160))}</span>` : ''}
        </button>`;
      }).join('')}</div>` : '<div class="panel empty">Henüz yazı yok. “+ Yeni yazı” ile ilk essay’ini yaz.</div>'}
      <details class="panel ielts-rules">
        <summary><b>IELTS’te kelimeler nasıl sayılır?</b></summary>
        <ul>
          <li>Yazdığın <b>her kelime sayılır</b>: <i>a, the, and, in</i> gibi küçük kelimeler ve <i>actually, basically, really</i> gibi dolgu kelimeleri de. Dolgu kelimeleri sayıya eklenir ama puanına katkı yapmaz; gereksizse çıkar.</li>
          <li>Kısaltmalar (<i>don't, it's</i>) <b>tek kelime</b> sayılır. Akademik yazıda kısaltma kullanmaman önerilir.</li>
          <li>Tireli kelimeler (<i>well-known, long-term</i>) <b>tek kelime</b> sayılır.</li>
          <li>Rakamla yazılan sayılar (<i>2020, 45%</i>) <b>tek kelime</b> sayılır.</li>
          <li><b>Sorudan aynen kopyaladığın ifadeler sayılmaz.</b> Soruyu “Soru metni” alanına yapıştırırsan uygulama kopya kısımları bulup sayıdan düşer.</li>
          <li>Alt sınır: Task 1 için <b>150</b>, Task 2 için <b>250</b> kelime. Altında kalırsan puan kaybedersin. Üst sınır yok, ama çok uzun yazmak zaman kaybettirir ve hata riskini artırır.</li>
          <li>Task 2’de başlık yazmana gerek yok.</li>
          <li>Bilgisayarlı sınavdaki sayaç boşlukla ayrılan her parçayı bir kelime sayar; bu uygulama da aynı şekilde sayar.</li>
        </ul>
      </details>
    </div>`;
}

function newEssayModal() {
  openModal(`
    <h2>Yeni yazı</h2>
    <div class="task-choices">${Object.entries(ESSAY_TASKS).map(([k, t], i) => `
      <label class="radio task-choice"><input type="radio" name="task" value="${k}" ${i === 0 ? 'checked' : ''}>
        <span><b>${esc(t.label)}</b><small>${t.min ? `en az ${t.min} kelime · ${t.minutes} dk` : 'kelime sınırı yok'}</small></span></label>`).join('')}
    </div>
    <div class="modal-actions">
      <button type="button" data-close>Vazgeç</button>
      <button type="submit" class="primary">Yazmaya başla</button>
    </div>`, {
    onSubmit: (f) => { openEssay(store.createEssay(new FormData(f).get('task')).id); },
  });
}

let essaySaveTimer = null;
function openEssay(id) {
  const e = store.getEssay(id);
  if (!e) return showEssays();
  leaveStudy();
  state.view = 'essay';
  state.essayId = id;
  document.body.classList.remove('menu-open');
  renderSidebar();
  setTitle(essayTitle(e));
  main.innerHTML = `
    <div class="page essay-page">
      <header class="deck-head">
        <button class="icon-btn head-btn" data-act="essays" title="Yazılarıma dön (Esc)" aria-label="Yazılarıma dön">${ICON.back.replace(/width="16" height="16"[^>]*/, '')}</button>
        <div class="deck-title"><input id="es-title" class="es-title" placeholder="Başlık (isteğe bağlı)" maxlength="200" value="${esc(e.title)}"></div>
        <div class="menu-wrap">
          <button class="icon-btn head-btn" data-act="deck-menu" title="Yazı işlemleri" aria-label="Yazı işlemleri" aria-haspopup="menu">${ICON.gear}</button>
          <div class="menu-pop hidden" id="deck-menu" role="menu">
            <button role="menuitem" data-act="essay-copy">${ICON.edit}<span>Metni kopyala</span></button>
            <button role="menuitem" data-act="essay-export">${ICON.download}<span>Metin dosyası olarak indir</span></button>
            <hr>
            <button role="menuitem" class="danger" data-act="essay-delete">${ICON.trash}<span>Yazıyı sil</span></button>
          </div>
        </div>
      </header>
      <div class="es-toolbar">
        <select id="es-task">${Object.entries(ESSAY_TASKS).map(([k, t]) => `<option value="${k}" ${k === e.task ? 'selected' : ''}>${esc(t.label)}</option>`).join('')}</select>
        <button type="button" data-act="essay-timer" id="es-timer-btn"></button>
        <select id="es-deck" title="Önerilerde kullanılacak kelime destesi">${essayDeckOptions()}</select>
        <span class="spacer"></span>
        <button type="button" class="ai-btn" data-act="essay-report" id="es-report-btn">🎓 IELTS analizi</button>
      </div>
      <div class="es-toggles" role="group" aria-label="Yazarken gösterilecekler">
        <label class="es-toggle" title="Üstteki canlı kelime sayacı ve hedef çubuğu"><input type="checkbox" id="es-counter-on" ${prefs.essayCounter !== false ? 'checked' : ''}><span>Kelime sayacı</span></label>
        <label class="es-toggle" title="Sorudan kopya, dolgu kelimeleri ve tekrar eden kelimeler"><input type="checkbox" id="es-tips-on" ${prefs.essayTips !== false ? 'checked' : ''}><span>Öneriler</span></label>
        <label class="es-toggle" title="Destendeki kelimelerin eş anlamlılarını yazında bulup o kelimeyi önerir"><input type="checkbox" id="es-vocab-on" ${prefs.essayVocab !== false ? 'checked' : ''}><span>Deste kelimeleri</span></label>
        <label class="es-toggle" title="Yazarken dilbilgisi ve yazım hatalarını işaretler (LanguageTool)"><input type="checkbox" id="es-grammar-on" ${prefs.essayGrammar !== false ? 'checked' : ''}><span>Canlı dilbilgisi</span></label>
        <label class="es-toggle" title="Tarayıcının kırmızı yazım altı çizgisi (sınavda yoktur)"><input type="checkbox" id="es-spell" ${prefs.essaySpell ? 'checked' : ''}><span>Yazım denetimi</span></label>
      </div>
      <section class="es-prompt-box ${e.prompt ? '' : 'editing'} ${e.prompt && prefs.essayPromptHidden ? 'collapsed' : ''}" id="es-prompt-box">
        <div class="es-prompt-head">
          <button type="button" class="es-prompt-title" data-pa="collapse" title="Gizle / göster"><span class="chev">▾</span> Soru / görev metni</button>
          <small class="muted">isteğe bağlı · sorudan kopyalanan kısımlar sayılmaz</small>
          <span class="spacer"></span>
          <button type="button" class="es-prompt-btn pa-edit" data-pa="edit">Düzenle</button>
          <button type="button" class="primary es-prompt-btn pa-done" data-pa="done">Bitti</button>
        </div>
        <div class="es-prompt-view" id="es-prompt-view" title="Düzenlemek için çift tıkla"></div>
        <textarea id="es-prompt" class="es-prompt-input" rows="3" maxlength="5000"
          placeholder="IELTS sorusunu buraya yapıştır, sonra “Bitti”ye bas…">${esc(e.prompt)}</textarea>
      </section>
      <div class="es-status" id="es-status"></div>
      <div class="es-editor">
        <div class="es-backdrop es-text" id="es-backdrop" aria-hidden="true"></div>
        <textarea id="es-body" class="es-body es-text" lang="en" spellcheck="${prefs.essaySpell ? 'true' : 'false'}" autocapitalize="sentences"
          placeholder="Yazmaya başla… Paragraflar arasında bir satır boşluk bırak.">${esc(e.body)}</textarea>
      </div>
      <div class="es-grammar" id="es-grammar"></div>
      <div class="es-vocab" id="es-vocab"></div>
      <div class="es-insights" id="es-insights"></div>
      <div id="es-report"></div>
    </div>`;

  const body = $('#es-body');
  const title = $('#es-title');
  const prompt = $('#es-prompt');
  const task = $('#es-task');
  let saved = true;
  const save = () => {
    clearTimeout(essaySaveTimer);
    const a = analyzeEssay(body.value, prompt.value);
    store.saveEssay(id, { title: title.value, prompt: prompt.value, body: body.value, task: task.value, words: a.words });
    saved = true;
    renderEssayStatus(a, task.value, saved);
  };
  const changed = () => {
    saved = false;
    renderEssayStatus(analyzeEssay(body.value, prompt.value), task.value, saved);
    clearTimeout(essaySaveTimer);
    essaySaveTimer = setTimeout(save, 600);
  };
  for (const el of [body, title, prompt]) el.addEventListener('input', changed);
  body.addEventListener('input', () => { autoGrow(body); renderGrammar(); scheduleGrammar(); });
  // Soru metni: düzenlerken kutu, bitince okunaklı metin olarak gösterilir
  const promptBox = $('#es-prompt-box');
  const renderPromptView = () => {
    const v = prompt.value.trim();
    $('#es-prompt-view').innerHTML = v.split(/\n\s*\n/).filter(Boolean)
      .map((p) => `<p>${esc(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  };
  const setPromptEditing = (on, focus = true) => {
    if (!on && !prompt.value.trim()) on = true; // boşken yazma kutusu açık kalsın
    promptBox.classList.toggle('editing', on);
    if (on) {
      promptBox.classList.remove('collapsed');
      autoGrow(prompt);
      if (focus) prompt.focus();
    } else {
      renderPromptView();
    }
  };
  renderPromptView();
  prompt.addEventListener('input', () => autoGrow(prompt));
  // Kutudan çıkınca (ör. yazı alanına geçince) okuma görünümüne dön
  prompt.addEventListener('blur', (ev) => {
    if (!ev.relatedTarget?.closest?.('#es-prompt-box')) setPromptEditing(false);
  });
  $('#es-prompt-view').addEventListener('dblclick', () => setPromptEditing(true));
  promptBox.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-pa]')?.dataset.pa;
    if (act === 'edit') setPromptEditing(true);
    else if (act === 'done') { setPromptEditing(false); body.focus(); }
    else if (act === 'collapse' && !promptBox.classList.contains('editing')) {
      promptBox.classList.toggle('collapsed');
      prefs.essayPromptHidden = promptBox.classList.contains('collapsed');
      savePrefs();
    }
  });

  // Kelime sayacı ve öneriler ayrı ayrı açılıp kapatılır; tercih cihazda hatırlanır
  $('#es-deck').addEventListener('change', (ev) => {
    prefs.essayDeck = ev.target.value;
    savePrefs();
    renderEssayStatus(analyzeEssay(body.value, prompt.value), task.value, saved);
  });
  for (const [boxId, key] of [['es-counter-on', 'essayCounter'], ['es-tips-on', 'essayTips'], ['es-vocab-on', 'essayVocab']]) {
    $(`#${boxId}`).addEventListener('change', (ev) => {
      prefs[key] = ev.target.checked;
      savePrefs();
      renderEssayStatus(analyzeEssay(body.value, prompt.value), task.value, saved);
    });
  }
  $('#es-grammar-on').addEventListener('change', (ev) => {
    prefs.essayGrammar = ev.target.checked;
    savePrefs();
    grammar.matches = [];
    renderGrammar();
    if (ev.target.checked) scheduleGrammar(true);
  });
  task.addEventListener('change', () => { save(); renderEssayTimerBtn(); });
  title.addEventListener('change', () => setTitle(essayTitle(store.getEssay(id))));
  $('#es-spell').addEventListener('change', (ev) => {
    prefs.essaySpell = ev.target.checked;
    savePrefs();
    body.spellcheck = ev.target.checked;
    body.blur();
    body.focus();
  });
  // Sayfadan çıkarken bekleyen kaydı hemen yaz
  state.flushEssay = () => { if (!saved && store.getEssay(id)) save(); };
  renderEssayStatus(analyzeEssay(body.value, prompt.value), task.value, true);
  renderEssayTimerBtn();
  autoGrow(body);
  grammar.matches = [];
  grammar.ignored = new Set();
  renderGrammar();
  scheduleGrammar(true);
  renderEssayReport();
  if (!isMobile()) body.focus();
}

function renderEssayTimerBtn() {
  const btn = $('#es-timer-btn');
  if (!btn) return;
  const t = ESSAY_TASKS[$('#es-task').value];
  btn.classList.toggle('hidden', !t.minutes);
  btn.textContent = timer.status === 'idle' ? `⏱ ${t.minutes} dk sınav süresi başlat` : `⏱ Sayaç: ${fmtClock(timerRemaining())}`;
}

function renderEssayStatus(a, taskKey, saved) {
  const t = ESSAY_TASKS[taskKey] || ESSAY_TASKS.free;
  const n = a.net;
  const pct = t.min ? Math.min(100, (n / t.min) * 100) : 0;
  const level = !t.min ? 'free' : n < t.min ? 'short' : t.max && n > t.max + 60 ? 'long' : 'ok';
  const hint = !t.min ? '' : level === 'short' ? `${t.min - n} kelime daha` : level === 'long' ? 'Uzun: zaman ve hata riski' : 'Hedefe ulaştın ✓';
  const showCounter = prefs.essayCounter !== false;
  $('#es-status').classList.toggle('es-status-min', !showCounter);
  $('#es-status').innerHTML = !showCounter ? `
    <div class="es-meta"><span class="muted">Kelime sayacı gizli</span><span id="es-grammar-state"></span>
      <span class="muted">${saved ? '✓ Kaydedildi' : 'Kaydediliyor…'}</span></div>` : `
    <div class="es-count es-${level}">
      <b>${n}</b><span>${t.min ? ` / ${t.min}` : ''} kelime</span>
      ${a.copied.count ? `<small title="Sorudan kopyalanmış görünen kelimeler sayılmaz">(${a.words} − ${a.copied.count} kopya)</small>` : ''}
    </div>
    ${t.min ? `<div class="es-bar es-${level}"><span style="width:${pct}%"></span></div>` : ''}
    <div class="es-meta">
      ${hint ? `<span class="es-hint es-${level}">${hint}</span>` : ''}
      <span>${a.paragraphs} paragraf · ${a.sentences} cümle</span>
      <span id="es-grammar-state"></span>
      <span class="muted">${saved ? '✓ Kaydedildi' : 'Kaydediliyor…'}</span>
    </div>`;
  const tips = [];
  if (a.copied.count) {
    tips.push(`<div class="es-tip warn"><b>Sorudan kopyalanmış görünen ${a.copied.count} kelime sayılmaz.</b> Soruyu kendi cümlelerinle yeniden ifade et (paraphrase):
      ${a.copied.phrases.slice(0, 3).map((p) => `<q>${esc(p)}</q>`).join(' ')}</div>`);
  }
  if (a.fillers.length) {
    tips.push(`<div class="es-tip"><b>Dolgu kelimeleri</b> (sayılır ama puana katkı yapmaz): ${a.fillers.map(([f, c]) => `<span class="chip">${esc(f)} ×${c}</span>`).join(' ')}</div>`);
  }
  if (a.repeated.length) {
    tips.push(`<div class="es-tip"><b>Çok tekrar edilenler</b> (eş anlamlılarla çeşitlendir): ${a.repeated.map(([w, c]) => `<span class="chip">${esc(w)} ×${c}</span>`).join(' ')}</div>`);
  }
  $('#es-insights').innerHTML = prefs.essayTips !== false ? tips.join('') : '';
  renderVocabHints();
  setGrammarState(grammar.state);
}

/* ---- canlı dilbilgisi denetimi (LanguageTool) */

const LT_URL = 'https://api.languagetool.org/v2/check';
const LT_MIN_GAP = 3500; // ücretsiz API: dakikada ~20 istek
const grammar = { matches: [], ignored: new Set(), timer: null, last: 0, seq: 0, state: '' };
const grammarOn = () => prefs.essayGrammar !== false;

function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}

function scheduleGrammar(now = false) {
  clearTimeout(grammar.timer);
  if (!grammarOn() || !$('#es-body')) return;
  grammar.timer = setTimeout(runGrammar, now ? 0 : 1500);
}

async function runGrammar() {
  const body = $('#es-body');
  if (!body || !grammarOn()) return;
  const text = body.value;
  if (!text.trim()) { grammar.matches = []; setGrammarState(''); renderGrammar(); return; }
  if (!navigator.onLine) { setGrammarState('offline'); return; }
  if (text.length > 18000) { setGrammarState('long'); return; }
  const wait = LT_MIN_GAP - (Date.now() - grammar.last);
  if (wait > 0) { grammar.timer = setTimeout(runGrammar, wait); return; }
  grammar.last = Date.now();
  const seq = ++grammar.seq;
  setGrammarState('checking');
  try {
    const res = await fetch(LT_URL, { method: 'POST', body: new URLSearchParams({ text, language: 'en-GB', level: 'default' }) });
    if (res.status === 429) { setGrammarState('limit'); grammar.timer = setTimeout(runGrammar, 30_000); return; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (seq !== grammar.seq || !$('#es-body')) return; // bu arada yeni bir denetim başladı
    grammar.matches = (data.matches || []).map((m) => ({
      offset: m.offset, length: m.length, text: text.substr(m.offset, m.length),
      message: m.message, replacements: (m.replacements || []).slice(0, 3).map((r) => r.value),
      type: m.rule?.issueType === 'misspelling' ? 'spelling' : ['style', 'typographical', 'whitespace'].includes(m.rule?.issueType) ? 'style' : 'grammar',
      rule: m.rule?.id || '',
    })).filter((m) => m.length > 0);
    setGrammarState('ok');
  } catch (e) {
    console.warn('Dilbilgisi denetimi yapılamadı', e);
    setGrammarState('error');
  }
  renderGrammar();
}

// Metin değiştiyse eski konumlar kayar: sadece hâlâ aynı yerde duran ve yoksayılmayan uyarıları göster
function liveMatches() {
  const text = $('#es-body')?.value || '';
  return grammar.matches.filter((m) => text.substr(m.offset, m.length) === m.text && !grammar.ignored.has(`${m.rule}|${m.text}`));
}

function setGrammarState(st) {
  grammar.state = st;
  const el = $('#es-grammar-state');
  if (!el) return;
  const n = liveMatches().length;
  el.className = `es-gstate ${st === 'ok' && n ? 'has' : ''}`;
  el.textContent = !grammarOn() ? '' : {
    checking: 'Dilbilgisi denetleniyor…',
    ok: n ? `${n} dilbilgisi uyarısı` : 'Dilbilgisi ✓',
    offline: 'Dilbilgisi: çevrimdışı',
    limit: 'Dilbilgisi: kısa bir mola (sınır)',
    error: 'Dilbilgisi denetlenemedi',
    long: 'Dilbilgisi: metin çok uzun',
  }[st] || '';
}

const LT_LABEL = { spelling: 'Yazım', grammar: 'Dilbilgisi', style: 'Üslup' };

function renderGrammar() {
  const body = $('#es-body');
  const back = $('#es-backdrop');
  const panel = $('#es-grammar');
  if (!body || !back || !panel) return;
  const text = body.value;
  const list = grammarOn() ? liveMatches().sort((a, b) => a.offset - b.offset) : [];
  // Arka katman: metnin şeffaf kopyası, hatalı kısımlar dalgalı çizgiyle
  let html = '';
  let pos = 0;
  for (const m of list) {
    if (m.offset < pos) continue;
    html += esc(text.slice(pos, m.offset)) + `<mark class="lt-${m.type}">${esc(m.text)}</mark>`;
    pos = m.offset + m.length;
  }
  back.innerHTML = `${html}${esc(text.slice(pos))}\n`;
  setGrammarState(grammar.state);
  panel.innerHTML = list.length ? `
    <div class="es-tip lt-list"><b>Dilbilgisi ve yazım uyarıları</b>
      ${list.slice(0, 30).map((m) => {
        const i = grammar.matches.indexOf(m);
        const before = text.slice(Math.max(0, m.offset - 30), m.offset);
        const after = text.slice(m.offset + m.length, m.offset + m.length + 30);
        return `<div class="lt-item">
          <button type="button" class="lt-ctx" data-act="lt-goto" data-i="${i}" title="Metinde göster">
            <span class="lt-tag lt-${m.type}">${LT_LABEL[m.type]}</span>
            …${esc(before)}<mark class="lt-${m.type}">${esc(m.text)}</mark>${esc(after)}…</button>
          <div class="lt-msg">${esc(m.message)}</div>
          <div class="lt-acts">${m.replacements.map((r, k) => `<button type="button" class="lt-fix" data-act="lt-fix" data-i="${i}" data-r="${k}">${esc(r) || '(sil)'}</button>`).join('')}
            <button type="button" class="ghost lt-ign" data-act="lt-ignore" data-i="${i}">Yoksay</button></div>
        </div>`;
      }).join('')}
    </div>` : '';
}

function grammarGoto(i) {
  const m = grammar.matches[i];
  if (m) selectInEssay(m.offset, m.length);
}

/** Yazı alanında bir aralığı seçer ve ekranın ortasına getirir. */
function selectInEssay(offset, length) {
  const body = $('#es-body');
  if (!body) return;
  body.focus();
  body.setSelectionRange(offset, offset + length);
  const m = { offset };
  // Seçili yeri ekranın ortasına getir (alan kendi kendine büyüdüğü için sayfa kayar)
  const before = body.value.slice(0, m.offset).split('\n').length;
  const lineH = parseFloat(getComputedStyle(body).lineHeight) || 28;
  main.scrollTo({ top: body.offsetTop + before * lineH - main.clientHeight / 2, behavior: 'smooth' });
}

function grammarFix(i, k) {
  const m = grammar.matches[i];
  const body = $('#es-body');
  if (!m || !body || body.value.substr(m.offset, m.length) !== m.text) return;
  const rep = m.replacements[k] ?? '';
  body.setRangeText(rep, m.offset, m.offset + m.length, 'end');
  // Sonraki uyarıların konumunu kaydır; asıl güncel liste bir sonraki denetimde gelir
  const delta = rep.length - m.length;
  grammar.matches = grammar.matches.filter((x) => x !== m).map((x) => (x.offset > m.offset ? { ...x, offset: x.offset + delta } : x));
  body.dispatchEvent(new Event('input'));
}

/* ---- deste kelimeleri: yazıda kullanılabilecek, çalıştığın kelimeler */

function defaultEssayDeck() {
  const en = state.decks.filter((d) => d.language === 'en');
  return en.length > 1 ? 'all' : en[0]?.id || state.decks[0]?.id || '';
}
const essayDeckSel = () => {
  const v = prefs.essayDeck ?? defaultEssayDeck();
  return v === '' || v === 'all' || deckById(v) ? v : defaultEssayDeck();
};
function essayDeckOptions() {
  const sel = essayDeckSel();
  const en = state.decks.filter((d) => d.language === 'en');
  return `<option value="" ${sel === '' ? 'selected' : ''}>📚 Deste seçilmedi</option>
    ${en.length > 1 ? `<option value="all" ${sel === 'all' ? 'selected' : ''}>📚 Tüm İngilizce desteler</option>` : ''}
    ${state.decks.map((d) => `<option value="${d.id}" ${sel === d.id ? 'selected' : ''}>📚 ${esc(d.name)}</option>`).join('')}`;
}

let vocabCache = { key: '', entries: [] };
/** Seçili destenin kartlarından: kelimenin kendisi ve eş anlamlıları için aranacak kalıplar. */
function vocabEntries() {
  const sel = essayDeckSel();
  const decks = sel === 'all' ? state.decks.filter((d) => d.language === 'en') : state.decks.filter((d) => d.id === sel);
  const key = `${sel}|${decks.map((d) => `${d.id}:${d.total}`).join(',')}|${store.getMeta().cursors?.cards || ''}`;
  if (vocabCache.key === key) return vocabCache.entries;
  const entries = [];
  for (const d of decks) {
    for (const c of store.listCards(d.id, '', Infinity).cards) {
      const forms = wordForms(c.word);
      if (!forms.length) continue;
      const own = new Set(forms.map((f) => f.toLowerCase()));
      entries.push({
        word: c.word,
        translation: c.translation,
        // hâlâ öğrendiğin kelimeler önce önerilir
        learning: c.state !== 2 || c.ivl < 21,
        usedRe: new RegExp(`(?<![\\p{L}])(?:${forms.map(reEsc).join('|')})\\p{L}*`, 'iu'),
        syns: (c.synonyms || [])
          .filter((x) => x.length > 2 && x.split(/\s+/).length <= 3 && !own.has(x.toLowerCase()))
          .map((x) => ({ s: x, re: new RegExp(`(?<![\\p{L}])${reEsc(x)}(?:s|es|d|ed|ing)?(?![\\p{L}])`, 'giu') })),
      });
    }
  }
  vocabCache = { key, entries };
  return entries;
}

/** Yazıda kullanılan deste kelimeleri ve eş anlamlısı yazılmış (yerine deste kelimesi önerilebilecek) yerler. */
function analyzeVocab(body) {
  const entries = vocabEntries();
  if (!entries.length) return null;
  const used = [];
  const swaps = [];
  for (const e of entries) {
    if (e.usedRe.test(body)) { used.push(e); continue; }
    const hits = [];
    for (const { s: syn, re } of e.syns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) hits.push({ syn, offset: m.index, length: m[0].length, text: m[0] });
    }
    if (hits.length) swaps.push({ ...e, hits: hits.sort((a, b) => a.offset - b.offset) });
  }
  swaps.sort((a, b) => (b.learning - a.learning) || (b.hits.length - a.hits.length));
  return { used, swaps: swaps.slice(0, 10) };
}

function renderVocabHints() {
  const box = $('#es-vocab');
  const body = $('#es-body');
  if (!box || !body) return;
  const sel = essayDeckSel();
  if (prefs.essayVocab === false || !body.value.trim() || !sel) { box.innerHTML = ''; return; }
  const v = analyzeVocab(body.value);
  if (!v) { box.innerHTML = ''; return; }
  const deckName = sel === 'all' ? 'İngilizce destelerin' : deckById(sel)?.name || '';
  box.innerHTML = `
    <div class="es-tip vocab">
      <b>📚 Destendeki kelimeler</b> <span class="muted">· ${esc(deckName)}</span>
      ${v.used.length ? `<div class="vc-used">Bu yazıda kullandıkların: ${v.used.slice(0, 12).map((e) => `<span class="chip vc-ok">✓ ${esc(e.word)}</span>`).join(' ')}</div>` : ''}
      ${v.swaps.length ? `<div class="vc-head muted">Şu kelimelerin yerine çalıştığın kelimeyi kullanabilirsin:</div>
        <div class="vc-list">${v.swaps.map((sw) => `
          <div class="vc-item">
            <button type="button" class="vc-from" data-act="vc-goto" data-o="${sw.hits[0].offset}" data-l="${sw.hits[0].length}" title="Metinde göster">“${esc(sw.hits[0].text)}”${sw.hits.length > 1 ? ` ×${sw.hits.length}` : ''}</button>
            <span class="vc-arrow">→</span>
            <b class="vc-to">${esc(sw.word)}</b>
            ${sw.translation ? `<span class="muted vc-tr">${esc(sw.translation)}</span>` : ''}
            ${sw.learning ? '<span class="vc-tag">öğreniyorsun</span>' : ''}
          </div>`).join('')}</div>`
        : `<div class="muted vc-head">${v.used.length ? 'Harika! ' : ''}Yazdıkça, destendeki kelimelerin eş anlamlılarını kullandığın yerlerde burada öneri çıkar. Daha fazlası için 🎓 IELTS analizi.</div>`}
    </div>`;
}

/** Yapay zekâ analizi için hedef kelimeler: önce hâlâ öğrenilenler (en fazla 80). */
function essayTargetWords() {
  if (prefs.essayVocab === false || !essayDeckSel()) return [];
  return [...vocabEntries()].sort((a, b) => b.learning - a.learning).slice(0, 80)
    .map((e) => ({ word: e.word, translation: e.translation || '' }));
}

/* ---- IELTS analiz raporu (yapay zekâ) */

const CRITERIA = (taskName) => [
  ['task', taskName, taskName === 'Task Achievement' ? 'Görevi karşılama' : 'Soruya yanıt'],
  ['coherence', 'Coherence & Cohesion', 'Tutarlılık ve bağlantı'],
  ['lexical', 'Lexical Resource', 'Kelime kullanımı'],
  ['grammar', 'Grammatical Range & Accuracy', 'Dilbilgisi çeşitliliği ve doğruluğu'],
];
const ERR_TYPES = { grammar: 'Dilbilgisi', vocabulary: 'Kelime', spelling: 'Yazım', punctuation: 'Noktalama', style: 'Üslup' };

let reportBusy = false;
async function runEssayReport() {
  if (reportBusy) return;
  state.flushEssay?.();
  const e = store.getEssay(state.essayId);
  if (!e) return;
  if (!sync.user()) { toast('IELTS analizi için giriş yapman gerekiyor.', 'info'); return authModal(); }
  const a = analyzeEssay(e.body, e.prompt);
  if (a.words < 30) { toast('Analiz için en az 30 kelime yaz.', 'info'); return; }
  const t = ESSAY_TASKS[e.task] || ESSAY_TASKS.task2;
  if (t.min && a.net < t.min) {
    const ok = await confirmBox(`Yazın ${a.net} kelime; ${t.label} için alt sınır ${t.min}. IELTS'te bu, görev puanını düşürür ve analizde de öyle değerlendirilir. Yine de analiz edilsin mi?`, { ok: 'Analiz et', title: 'Kelime sınırının altında' });
    if (!ok) return;
  }
  reportBusy = true;
  // Analiz uzun sürebilir: arka plandayken bitince sistem bildirimi için (bilgisayarda) izin iste
  if (NativeNotif) NativeNotif.checkPermissions().then((p) => p.display !== 'granted' && NativeNotif.requestPermissions()).catch(() => {});
  else if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  const started = Date.now();
  const tick = setInterval(() => {
    const btn = $('#es-report-btn');
    if (btn) btn.textContent = `🎓 Analiz ediliyor… ${Math.round((Date.now() - started) / 1000)} sn`;
  }, 1000);
  const btn = $('#es-report-btn');
  if (btn) { btn.disabled = true; btn.textContent = '🎓 Analiz ediliyor…'; }
  const box = $('#es-report');
  if (box) box.innerHTML = '<div class="panel es-report-wait">🎓 Yazın IELTS ölçütlerine göre değerlendiriliyor. Bu genelde 20-60 saniye sürer; bu sırada yazmaya devam edebilirsin.</div>';
  try {
    const report = await sync.aiEssayReport({ task: e.task, prompt: e.prompt, body: e.body, targetWords: essayTargetWords() });
    store.saveEssayReport(e.id, report);
    const here = state.view === 'essay' && state.essayId === e.id;
    if (here) {
      renderEssayReport();
      $('#es-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    notifyReport(e.id, `Tahmini Band ${report.overall.toFixed(1)} · ${essayTitle(store.getEssay(e.id) || e)}`, true, here);
  } catch (err) {
    toast(err.message, 'error', 7000);
    renderEssayReport();
    notifyReport(e.id, err.message, false, false);
  } finally {
    clearInterval(tick);
    reportBusy = false;
    const b = $('#es-report-btn');
    if (b) { b.disabled = false; b.textContent = '🎓 IELTS analizi'; }
  }
}

/**
 * Analiz bitince haber ver: uygulama içinde kalıcı bildirim (hangi ekranda olursan ol),
 * uygulama arka plandaysa sistem bildirimi (bilgisayarda tarayıcı, Android'de bildirim çubuğu).
 */
export function notifyReport(essayId, detail, ok, alreadyHere) {
  $('#report-banner')?.remove();
  const el = document.createElement('div');
  el.id = 'report-banner';
  el.className = `update-banner report-banner ${ok ? '' : 'failed'}`;
  el.innerHTML = `
    <div class="ub-text"><b>${ok ? '🎓 IELTS analizi bitti' : '🎓 IELTS analizi tamamlanamadı'}</b>
      <div class="muted">${esc(detail)}</div></div>
    <div class="ub-actions">
      <button class="ghost" data-rb="close">Kapat</button>
      ${ok && !alreadyHere ? '<button class="primary" data-rb="open">Raporu aç</button>' : ''}
    </div>`;
  el.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-rb]')?.dataset.rb;
    if (!act) return;
    el.remove();
    if (act === 'open' && store.getEssay(essayId)) {
      openEssay(essayId);
      setTimeout(() => $('#es-report')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
    }
  });
  document.body.append(el);
  // Rapor zaten ekrandaysa bildirim bir süre sonra kendiliğinden kapanır
  if (alreadyHere) setTimeout(() => el.remove(), 9000);

  if (!document.hidden) return;
  const title = ok ? '🎓 IELTS analizi bitti' : 'IELTS analizi tamamlanamadı';
  if (NativeNotif) {
    NativeNotif.schedule({ notifications: [{ id: 4243, title, body: detail, schedule: { at: new Date(Date.now() + 500) } }] }).catch(() => {});
  } else if ('Notification' in window && Notification.permission === 'granted') {
    const n = new Notification(title, { body: detail, icon: 'icons/icon-192.png', tag: 'kelime-report' });
    n.onclick = () => { window.focus(); n.close(); if (ok && store.getEssay(essayId)) openEssay(essayId); };
  }
}

function renderEssayReport() {
  const box = $('#es-report');
  const e = store.getEssay(state.essayId);
  if (!box || !e) return;
  const r = e.report;
  if (!r) { box.innerHTML = ''; return; }
  const changed = (e.edited_at || 0) > (e.report_at || 0);
  const when = new Date((e.report_at || 0) * 1000).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
  const bandBar = (b) => `<span class="rp-bar"><span style="width:${(b / 9) * 100}%"></span></span>`;
  const list = (title, items, cls = '') => (items?.length ? `<div class="rp-block ${cls}"><h4>${title}</h4><ul>${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  box.innerHTML = `
    <section class="panel es-report">
      <div class="rp-head">
        <div class="rp-band"><b>${r.overall.toFixed(1)}</b><span>/ 9</span></div>
        <div class="rp-title">
          <h3>Tahmini IELTS bandı</h3>
          <span class="muted">${esc(when)} · ${r.words} kelimeyle · ${r.descriptor_source === 'official-2023' ? 'IELTS resmi band tanımlayıcılarına (Mayıs 2023) göre' : 'IELTS band tanımlayıcılarının özetine göre'} yapay zekâ değerlendirmesi; resmi puan değildir</span>
          ${changed ? '<span class="rp-stale">Yazı bu analizden sonra değişti</span>' : ''}
        </div>
        <button type="button" data-act="essay-report">↻ Yeniden analiz et</button>
      </div>
      <div class="rp-criteria">${CRITERIA(r.criterion_name || 'Task Response').map(([k, en, tr]) => {
        const c = r.criteria?.[k];
        return c ? `<div class="rp-crit">
          <div class="rp-crit-head"><span><b>${esc(en)}</b> <small class="muted">${esc(tr)}</small></span><b class="rp-score">${c.band.toFixed(1)}</b></div>
          ${bandBar(c.band)}
          <p>${esc(c.comment)}</p>
          ${c.descriptor ? `<p class="rp-desc"><b>Band tanımlayıcısına göre:</b> ${esc(c.descriptor)}</p>` : ''}
          ${c.evidence?.length ? `<div class="rp-evidence">${c.evidence.map((q) => `<button type="button" data-act="rp-goto" data-text="${esc(q)}" title="Metinde göster"><q>${esc(q)}</q></button>`).join('')}</div>` : ''}
          ${c.next_band && c.band < 9 ? `<p class="rp-next"><b>Band ${Math.min(9, Math.floor(c.band) + 1)} için:</b> ${esc(c.next_band)}</p>` : ''}
        </div>` : '';
      }).join('')}</div>
      ${r.summary ? `<p class="rp-summary">${esc(r.summary)}</p>` : ''}
      <div class="rp-cols">${list('✅ Güçlü yanlar', r.strengths, 'good')}${list('🔧 Geliştirilecekler', r.improvements, 'warn')}</div>
      ${r.errors?.length ? `<div class="rp-block"><h4>✏️ Hatalar ve doğruları <small class="muted">(metinde göstermek için tıkla)</small></h4>
        <div class="rp-errors">${r.errors.map((x) => `
          <button type="button" class="rp-err" data-act="rp-goto" data-text="${esc(x.original)}">
            <span class="rp-etype">${esc(ERR_TYPES[x.type] || x.type)}</span>
            <span><del>${esc(x.original)}</del> → <ins>${esc(x.correction)}</ins></span>
            ${x.explanation ? `<small>${esc(x.explanation)}</small>` : ''}
          </button>`).join('')}</div></div>` : ''}
      ${r.vocab_suggestions?.length ? `<div class="rp-block"><h4>📚 Destendeki kelimelerle yazabileceklerin <small class="muted">(metinde göstermek için tıkla)</small></h4>
        <div class="rp-errors">${r.vocab_suggestions.map((x) => `
          <button type="button" class="rp-err rp-vocab" data-act="rp-goto" data-text="${esc(x.original)}">
            <span class="rp-etype">${esc(x.word)}</span>
            <span><del>${esc(x.original)}</del><br><ins>${esc(x.suggestion)}</ins></span>
            ${x.why ? `<small>${esc(x.why)}</small>` : ''}
          </button>`).join('')}</div></div>` : ''}
      ${list('🚀 Daha yüksek band için', r.band9_tips)}
      ${r.improved_sentence ? `<div class="rp-block"><h4>✨ Örnek: cümleni yükselt</h4>
        <div class="rp-example"><del>${esc(r.improved_sentence.original)}</del><ins>${esc(r.improved_sentence.improved)}</ins></div></div>` : ''}
    </section>`;
}

function reportGoto(text) {
  const body = $('#es-body');
  if (!body || !text) return;
  const i = body.value.indexOf(text);
  if (i < 0) { toast('Bu ifade metinde artık bulunamadı (düzeltilmiş olabilir).', 'info'); return; }
  grammarGoto(grammar.matches.push({ offset: i, length: text.length, text, message: '', replacements: [], type: 'grammar', rule: '__goto' }) - 1);
  grammar.matches.pop();
}

function leaveEssay() {
  clearTimeout(grammar.timer);
  state.flushEssay?.();
  state.flushEssay = null;
}

/* =========================================================== Android güncelleme bildirimi */

const RELEASES_API = 'https://api.github.com/repos/emrebktas/kelime/releases/latest';
const APK_URL = 'https://github.com/emrebktas/kelime/releases/latest/download/kelime.apk';
const UPDATE_CHECK_EVERY = 6 * 3600 * 1000;
let updateCheckedAt = 0;
let updateDismissed = false;

/** Android uygulamasında GitHub'daki son APK sürümünü kendi sürümüyle karşılaştırır. */
async function checkForUpdate() {
  if (!NativeApp || updateDismissed || !navigator.onLine) return;
  if (Date.now() - updateCheckedAt < UPDATE_CHECK_EVERY) return;
  updateCheckedAt = Date.now();
  try {
    const [info, release] = await Promise.all([
      NativeApp.getInfo(),
      fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } }).then((r) => (r.ok ? r.json() : null)),
    ]);
    // Etiket: android-v1.0.<derleme no>; uygulamanın derleme numarası (versionCode) ile karşılaştırılır
    const latest = Number(/^android-v\d+\.\d+\.(\d+)$/.exec(release?.tag_name || '')?.[1]);
    const current = Number(info.build);
    if (!latest || !current || latest <= current) return;
    const notes = (release.body || '').split('\n').filter((l) => l.startsWith('- ')).slice(0, 4).map((l) => l.slice(2));
    showUpdateBanner(`1.0.${latest}`, info.version, notes);
  } catch (e) {
    console.warn('Güncelleme kontrolü yapılamadı', e);
  }
}

export function showUpdateBanner(newVersion, currentVersion, notes = []) {
  if ($('#update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.innerHTML = `
    <div class="ub-text">
      <b>Yeni sürüm hazır: ${esc(newVersion)}</b> <span class="muted">· şu an ${esc(currentVersion)}</span>
      ${notes.length ? `<ul>${notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    </div>
    <div class="ub-actions">
      <button class="ghost" data-ub="later">Sonra</button>
      <button class="primary" data-ub="go">İndir</button>
    </div>`;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-ub]')?.dataset.ub;
    if (!act) return;
    updateDismissed = true;
    el.remove();
    // Uygulama dışındaki adresler Android'de telefonun tarayıcısında açılır; APK oradan iner
    if (act === 'go') location.href = APK_URL;
  });
  document.body.append(el);
}

/* =========================================================== uzaktan gelen değişiklikler */

let remoteTimer = null;
let remoteDirty = false;
function onRemoteChange() {
  remoteDirty = true;
  clearTimeout(remoteTimer);
  remoteTimer = setTimeout(() => {
    refreshDecks();
    renderTimer();
    refreshStudyTime();
    if (modalOpen()) return;
    remoteDirty = false;
    if (state.view === 'deck') {
      if (!deckById(state.deckId)) { toast('Bu desteye artık erişimin yok.', 'info'); showHome(); return; }
      if (document.activeElement?.id === 'card-search') loadCards(); else renderDeck();
    } else if (state.view === 'essays') {
      showEssays();
    } else if (state.view === 'essay') {
      // Yazarken ekranı yenileme; sadece başka cihazda değiştiyse ve şu an yazılmıyorsa
      if (!store.getEssay(state.essayId)) { toast('Bu yazı başka bir cihazda silindi.', 'info'); showEssays(); return; }
      const active = document.activeElement;
      if (!active || !['es-body', 'es-title', 'es-prompt'].includes(active.id)) openEssay(state.essayId);
    } else if (state.view === 'home') {
      showHome();
    } else if (state.view === 'study') {
      if (!deckById(state.deckId)) { toast('Bu desteye artık erişimin yok.', 'info'); showHome(); return; }
      const s = state.study;
      const cur = s?.res.card && store.listCards(state.deckId, '', Infinity).cards.find((c) => c.id === s.res.card.id);
      if (s?.res.card && !cur) { showStudyCard(store.nextCard(state.deckId)); return; }
      if (s?.res.card && cur) { s.res.card = { ...s.res.card, ...cur, state: s.res.card.state }; }
      if (s && !s.res.card) { showStudyCard(store.nextCard(state.deckId)); return; }
      renderStudy();
    }
  }, 150);
}

/* =========================================================== olaylar */

const deckMenu = () => $('#deck-menu');
const deckMenuOpen = () => deckMenu() && !deckMenu().classList.contains('hidden');
function toggleDeckMenu(open) {
  const m = deckMenu();
  if (!m) return;
  m.classList.toggle('hidden', !open);
  $('[data-act=deck-menu]')?.setAttribute('aria-expanded', String(open));
  if (open) m.querySelector('button')?.focus({ preventScroll: true });
}

document.addEventListener('click', (e) => {
  // Deste menüsü: ⚙ dışında bir yere (ya da bir seçeneğe) tıklanınca kapanır
  if (deckMenuOpen() && !e.target.closest('[data-act=deck-menu]')) toggleDeckMenu(false);
  const chkCell = e.target.closest('td.chk, th.chk');
  if (chkCell) {
    if (e.target.tagName !== 'INPUT') chkCell.querySelector('input')?.click();
    return;
  }
  const el = e.target.closest('[data-act], [data-deck], [data-card], [data-essay]');
  if (!el || (el.closest('#modal-root') && !el.dataset.act)) return;
  if (el.dataset.deck) return guard(() => openDeck(el.dataset.deck));
  if (el.dataset.essay) return guard(() => openEssay(el.dataset.essay));
  if (el.dataset.card && !el.dataset.act) {
    const card = state.cards.get(el.dataset.card);
    if (card) cardForm(card, state.deckId, () => { refreshDecks(); renderDeck(); });
    return;
  }
  const deck = deckById(state.deckId);
  const act = el.dataset.act;
  if (act !== 'menu') document.body.classList.remove('menu-open');
  guard(async () => {
    switch (act) {
      case 'menu': document.body.classList.toggle('menu-open'); break;
      case 'deck-menu': toggleDeckMenu(!deckMenuOpen()); break;
      case 'menu-close': break;
      case 'home': showHome(); break;
      case 'new-deck': deckForm(); break;
      case 'import': await importFlow(state.view === 'home' ? null : state.deckId); break;
      case 'import-into': await importFlow(state.deckId); break;
      case 'join': joinModal(); break;
      case 'account': accountModal(); break;
      case 'theme': {
        const order = ['system', 'light', 'dark'];
        prefs.theme = order[(order.indexOf(prefs.theme || 'system') + 1) % 3];
        savePrefs(); applyTheme(); break;
      }
      case 'speech-settings': speechSettingsModal(); break;
      case 'timer': timerModal(); break;
      case 'essays': showEssays(); break;
      case 'essay-new': newEssayModal(); break;
      case 'essay-timer': {
        const t = ESSAY_TASKS[$('#es-task')?.value] || ESSAY_TASKS.task2;
        if (timer.status !== 'idle') { timerModal(); break; }
        timer.planned = t.minutes;
        timerStart();
        toast(`${t.minutes} dakikalık sınav süresi başladı. Süre dolunca uyarılacaksın.`, 'success');
        $('#es-body')?.focus();
        break;
      }
      case 'essay-report': await runEssayReport(); break;
      case 'lt-goto': grammarGoto(+el.dataset.i); break;
      case 'lt-fix': grammarFix(+el.dataset.i, +el.dataset.r); break;
      case 'lt-ignore': {
        const m = grammar.matches[+el.dataset.i];
        if (m) grammar.ignored.add(`${m.rule}|${m.text}`);
        renderGrammar();
        break;
      }
      case 'rp-goto': reportGoto(el.dataset.text); break;
      case 'vc-goto': selectInEssay(+el.dataset.o, +el.dataset.l); break;
      case 'essay-copy': {
        await navigator.clipboard.writeText($('#es-body').value);
        toast('Metin kopyalandı.', 'success', 1500);
        break;
      }
      case 'essay-export': {
        state.flushEssay?.();
        const es = store.getEssay(state.essayId);
        const name = (essayTitle(es).replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'essay').slice(0, 60);
        const parts = [es.title, es.prompt && `[Soru]\n${es.prompt}`, es.body, `— ${es.words} kelime`].filter(Boolean);
        const text = parts.join('\n\n');
        await download(`${name}.txt`, text);
        break;
      }
      case 'essay-delete':
        if (await confirmBox('Bu yazı kalıcı olarak silinecek.', { ok: 'Sil', danger: true })) {
          state.flushEssay = null;
          store.deleteEssay(state.essayId);
          showEssays();
        }
        break;
      case 'edit-deck': deckForm(deck); break;
      case 'share': await shareModal(deck); break;
      case 'history': await historyModal(deck); break;
      case 'delete-deck': {
        const owner = deck.role === 'owner';
        const msg = owner
          ? `“${deck.name}” destesi ve içindeki ${deck.total} kart kalıcı olarak silinecek${deck.shared ? '. Deste paylaşıldığı herkesten de kaldırılacak' : ''}.`
          : `“${deck.name}” destesinden ayrılacaksın. Bu destedeki çalışma ilerlemen silinecek; tekrar katılmak için paylaşım kodu gerekir.`;
        if (await confirmBox(msg, { ok: owner ? 'Desteyi sil' : 'Desteden ayrıl', danger: true })) {
          store.deleteDeck(deck.id);
          state.deckId = null;
          refreshDecks();
          showHome();
        }
        break;
      }
      case 'export': {
        const safe = deck.name.replace(/[^\p{L}\p{N} _-]+/gu, '_').trim() || 'deste';
        await download(`${safe}.json`, store.exportDeck(deck.id));
        break;
      }
      case 'ai-bulk': aiBulkModal(deck); break;
      case 'add-card': cardForm(null, state.deckId, () => { refreshDecks(); renderDeck(); }); break;
      case 'study': startStudy(); break;
      case 'back-deck': backToDeck(); break;
      case 'flip': flip(); break;
      case 'rate': rate(+el.dataset.r); break;
      case 'undo': undo(); break;
      case 'edit-current': editCurrent(); break;
      case 'speak': if (state.study?.res.card) speak(state.study.res.card.word, deck?.language); break;
      case 'speak-sentence': if (state.study?.res.card) speak(state.study.res.card.sentence, deck?.language); break;
      case 'bulk-clear': state.selected.clear(); loadCards(); break;
      case 'bulk-copy': copyCardsModal([...state.selected]); break;
      case 'bulk-reset':
        if (await confirmBox(`${state.selected.size} kartın çalışma ilerlemesi sıfırlanacak.`, { ok: 'Sıfırla' })) {
          store.resetCards([...state.selected]);
          state.selected.clear();
          refreshDecks(); renderDeck();
        }
        break;
      case 'bulk-delete':
        if (await confirmBox(`${state.selected.size} kart kalıcı olarak silinecek.`, { ok: 'Sil', danger: true })) {
          store.deleteCards([...state.selected]);
          state.selected.clear();
          refreshDecks(); renderDeck();
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
    const id = t.dataset.chk;
    if (t.checked) state.selected.add(id); else state.selected.delete(id);
    t.closest('tr').classList.toggle('sel', t.checked);
    renderBulk();
  }
});

document.addEventListener('keydown', (e) => {
  if (deckMenuOpen()) {
    if (e.key === 'Escape') { e.preventDefault(); toggleDeckMenu(false); $('[data-act=deck-menu]')?.focus(); }
    return;
  }
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
  } else if (state.view === 'essay') {
    if (e.ctrlKey && key === 's') { e.preventDefault(); state.flushEssay?.(); toast('Kaydedildi.', 'success', 1200); return; }
    if (e.key === 'Escape') {
      if (typing) document.activeElement.blur();
      else showEssays();
    }
  } else if (state.view === 'essays') {
    if (e.key === 'Escape' && !typing) showHome();
  } else if (state.view === 'deck') {
    if (e.ctrlKey && key === 'f') { e.preventDefault(); $('#card-search')?.focus(); $('#card-search')?.select(); return; }
    if (typing) {
      if (e.key === 'Escape') document.activeElement.blur();
      return;
    }
    if (e.key === 'Escape') { e.preventDefault(); showHome(); }
    else if (e.key === 'Enter' && tag !== 'BUTTON') { e.preventDefault(); guard(startStudy); }
    else if (key === 'n' && !e.ctrlKey && store.canEdit(state.deckId)) {
      e.preventDefault();
      cardForm(null, state.deckId, () => { refreshDecks(); renderDeck(); });
    }
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

async function loadProfile() {
  if (!sync.user()) { state.profileName = ''; return; }
  try { state.profileName = (await sync.getProfile())?.display_name || ''; } catch { /* çevrimdışı */ }
  renderAccount();
}

async function init() {
  applyTheme();
  await store.open();
  store.onRemoteChange(onRemoteChange);
  sync.setPresenceProvider(() => (timer.status === 'running' ? Math.floor((Date.now() - timerElapsed()) / 1000) : null));
  sync.onStatus(() => renderAccount());
  sync.onAuth((session, event) => {
    if (event === 'PASSWORD_RECOVERY') recoveryModal();
    loadProfile();
    refreshDecks();
    if (state.view === 'home') showHome();
  });
  // Önce cihazdaki verilerle hemen aç. Senkron arka planda başlar: oturumun süresi dolmuşken
  // çevrimdışıysak Supabase oturumu yenilemeyi uzun süre dener; arayüz bunu beklememeli.
  refreshDecks();
  if (prefs.lastDeck && deckById(prefs.lastDeck)) openDeck(prefs.lastDeck);
  else showHome();
  sync.init()
    .then(() => { refreshDecks(); renderAccount(); loadProfile(); })
    .catch((e) => console.warn('Senkron başlatılamadı', e));
  // Sayaç: uygulama kapalıyken süre dolduysa şimdi bitir, çalışıyorsa saymaya devam et
  syncTimerTick();
  onTimerTick();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) state.flushEssay?.(); // telefonda uygulama arka plana geçerken yazıyı kaydet
    else onTimerTick();
  });
  addEventListener('pagehide', () => state.flushEssay?.());
  if (NativeApp) {
    // Android geri tuşu: önce pencere/menü kapanır, sonra bir üst ekrana dönülür, en son uygulamadan çıkılır
    NativeApp.addListener('backButton', () => {
      if (modalOpen()) closeModal();
      else if (document.body.classList.contains('menu-open')) document.body.classList.remove('menu-open');
      else if (state.view === 'study') backToDeck();
      else if (state.view === 'deck') showHome();
      else NativeApp.exitApp();
    });
    NativeApp.addListener('resume', () => { sync.schedule(0); checkForUpdate(); onTimerTick(); });
    setTimeout(checkForUpdate, 3000);
  }
  // Android uygulamasında dosyalar zaten pakette; önbellek işçisine gerek yok
  if (!isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        // Uygulama öne geldiğinde yeni sürüm var mı diye bak
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      })
      .catch((e) => console.warn('Service worker kaydedilemedi', e));
    // Yeni sürüm devreye girdi: kendiliğinden yenileme (yazı yazıyor olabilir), haber ver
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) showReloadBanner(); });
  }
}

function showReloadBanner() {
  if ($('#update-banner')) return;
  const el = document.createElement('div');
  el.id = 'update-banner';
  el.className = 'update-banner';
  el.innerHTML = `
    <div class="ub-text"><b>Uygulama güncellendi</b> <span class="muted">· yeni sürümü görmek için yenile</span></div>
    <div class="ub-actions">
      <button class="ghost" data-ub="later">Sonra</button>
      <button class="primary" data-ub="go">Yenile</button>
    </div>`;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('[data-ub]')?.dataset.ub;
    if (!act) return;
    el.remove();
    if (act === 'go') { state.flushEssay?.(); store.flush().finally(() => location.reload()); }
  });
  document.body.append(el);
}

init().catch((e) => {
  console.error(e);
  main.innerHTML = `<div class="page"><h1>Uygulama açılamadı</h1><p class="muted">${esc(e.message || e)}</p></div>`;
});

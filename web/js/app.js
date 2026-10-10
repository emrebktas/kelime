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
  $('meta[name=theme-color]').content = dark ? '#181a20' : '#eceef3';
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
        <div>
          <h1>${esc(d.name)}</h1>
          <div class="sub">
            <span class="badge">${esc(langName(d.language))}</span>
            ${d.role !== 'owner' ? `<span class="badge role-badge">Ortak · ${ROLES[d.role]}</span>` : d.shared ? '<span class="badge role-badge">Paylaşılıyor</span>' : ''}
            <span>${d.total} kart · günde ${d.new_per_day} yeni · ${DIRECTIONS[d.direction] || ''}</span>
          </div>
        </div>
        <div class="head-actions">
          ${editable ? '<button data-act="import-into">İçe aktar</button>' : ''}
          <button data-act="export">Dışa aktar</button>
          ${sync.enabled ? `<button data-act="share">${d.role === 'owner' ? 'Paylaş' : 'Üyeler'}</button>` : ''}
          ${signedIn ? '<button data-act="history">Geçmiş</button>' : ''}
          <button data-act="edit-deck">Ayarlar</button>
          <button class="danger-ghost" data-act="delete-deck">${d.role === 'owner' ? 'Sil' : 'Ayrıl'}</button>
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
      ${editable && others.length ? `<select id="bulk-move"><option value="">Başka desteye taşı…</option>
        ${others.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select>` : ''}
      ${editable ? '<button class="danger-ghost" data-act="bulk-delete">Sil</button>' : ''}
      <span style="flex:1"></span>
      <button class="ghost" data-act="bulk-clear">Seçimi kaldır</button>
    </div>`;
  $('#bulk-move')?.addEventListener('change', (e) => {
    const target = e.target.value;
    if (!target) return;
    guard(() => {
      const r = store.moveCards([...state.selected], target);
      toast(`${r.moved} kart taşındı${r.skipped ? `, ${r.skipped} kart hedefte zaten olduğu için atlandı` : ''}.`, 'success');
      state.selected.clear();
      refreshDecks();
      renderDeck();
    });
  });
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
      ${card && !readOnly ? '<button type="button" class="danger-ghost" data-act-modal="delete">Sil</button><span class="spacer"></span>' : ''}
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
  const text = JSON.stringify(obj, null, 2);
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
  const blob = new Blob([text], { type: 'application/json' });
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
    if (modalOpen()) return;
    remoteDirty = false;
    if (state.view === 'deck') {
      if (!deckById(state.deckId)) { toast('Bu desteye artık erişimin yok.', 'info'); showHome(); return; }
      if (document.activeElement?.id === 'card-search') loadCards(); else renderDeck();
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

document.addEventListener('click', (e) => {
  const chkCell = e.target.closest('td.chk, th.chk');
  if (chkCell) {
    if (e.target.tagName !== 'INPUT') chkCell.querySelector('input')?.click();
    return;
  }
  const el = e.target.closest('[data-act], [data-deck], [data-card]');
  if (!el || (el.closest('#modal-root') && !el.dataset.act)) return;
  if (el.dataset.deck) return guard(() => openDeck(el.dataset.deck));
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
  sync.onStatus(() => renderAccount());
  sync.onAuth((session, event) => {
    if (event === 'PASSWORD_RECOVERY') recoveryModal();
    loadProfile();
    refreshDecks();
    if (state.view === 'home') showHome();
  });
  await sync.init();
  refreshDecks();
  if (prefs.lastDeck && deckById(prefs.lastDeck)) openDeck(prefs.lastDeck);
  else showHome();
  loadProfile();
  if (NativeApp) {
    // Android geri tuşu: önce pencere/menü kapanır, sonra bir üst ekrana dönülür, en son uygulamadan çıkılır
    NativeApp.addListener('backButton', () => {
      if (modalOpen()) closeModal();
      else if (document.body.classList.contains('menu-open')) document.body.classList.remove('menu-open');
      else if (state.view === 'study') backToDeck();
      else if (state.view === 'deck') showHome();
      else NativeApp.exitApp();
    });
    NativeApp.addListener('resume', () => { sync.schedule(0); checkForUpdate(); });
    setTimeout(checkForUpdate, 3000);
  }
  // Android uygulamasında dosyalar zaten pakette; önbellek işçisine gerek yok
  if (!isNative && 'serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker kaydedilemedi', e));
  }
}

init().catch((e) => {
  console.error(e);
  main.innerHTML = `<div class="page"><h1>Uygulama açılamadı</h1><p class="muted">${esc(e.message || e)}</p></div>`;
});

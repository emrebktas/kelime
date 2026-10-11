// Supabase ile hesap, senkron, paylaşım ve değişiklik geçmişi

import * as store from './store.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY, SITE_URL } from './config.js';

// Geliştirmede (sadece localhost) config.js yerine tarayıcıda bir test sunucusu tanımlanabilir:
// localStorage['kelime.config'] = '{"url": "...", "key": "..."}'
const isDevHost = ['localhost', '127.0.0.1'].includes(location.hostname);
const cfg = isDevHost ? (() => {
  try { return JSON.parse(localStorage.getItem('kelime.config')) || {}; } catch { return {}; }
})() : {};
const URL_ = cfg.url || SUPABASE_URL;
const KEY_ = cfg.key || SUPABASE_ANON_KEY;

export const enabled = !!(URL_ && KEY_ && window.supabase);
let client = null;
let session = null;

export const status = { state: enabled ? 'signed-out' : 'disabled', lastSync: null, error: null, pending: false };
const statusListeners = new Set();
const authListeners = new Set();
export const onStatus = (fn) => statusListeners.add(fn);
export const onAuth = (fn) => authListeners.add(fn);
function setStatus(patch) {
  Object.assign(status, patch);
  statusListeners.forEach((fn) => fn(status));
}

export const user = () => session?.user || null;

/* ------------------------------------------------------------------ hata mesajları */

const MESSAGES = [
  [/invalid login credentials/i, 'E-posta ya da şifre hatalı.'],
  [/already registered|already been registered/i, 'Bu e-posta ile zaten bir hesap var. Giriş yapmayı dene.'],
  [/email not confirmed/i, 'E-posta adresin henüz onaylanmadı. Gelen kutundaki onay bağlantısına tıkla.'],
  [/password should be at least|weak password/i, 'Şifre en az 6 karakter olmalı.'],
  [/unable to validate email|invalid email|email address .* is invalid/i, 'Geçerli bir e-posta adresi gir.'],
  [/email rate limit|over_email_send_rate_limit/i, 'Onay e-postası gönderme sınırı doldu (ücretsiz Supabase saatte birkaç e-posta gönderebiliyor). Biraz sonra tekrar dene; sorun sürerse uygulama yöneticisi e-posta onayını kapatabilir.'],
  [/rate limit|too many/i, 'Çok fazla deneme yapıldı, biraz bekleyip tekrar dene.'],
  [/failed to send a request to the edge function/i, 'Yapay zekâ servisine ulaşılamadı. İnternet bağlantını kontrol et.'],
  [/failed to fetch|network|load failed/i, 'Sunucuya ulaşılamadı. İnternet bağlantını kontrol et.'],
  [/jwt|token/i, 'Oturum süresi doldu, tekrar giriş yap.'],
];
export function message(err) {
  const raw = err?.message || String(err);
  const hit = MESSAGES.find(([re]) => re.test(raw));
  return hit ? hit[1] : raw;
}
const ok = ({ data, error }) => { if (error) throw error; return data; };

/* ------------------------------------------------------------------ başlangıç ve oturum */

export async function init() {
  if (!enabled) return;
  client = window.supabase.createClient(URL_, KEY_, {
    auth: { persistSession: true, autoRefreshToken: true, storageKey: 'kelime.auth', detectSessionInUrl: true },
  });
  const { data } = await client.auth.getSession();
  handleSession(data.session, 'INITIAL');
  // Supabase, bu geri çağırma içinde başka istek beklenmesini önermiyor; işi sıraya at.
  client.auth.onAuthStateChange((event, s) => setTimeout(() => handleSession(s, event), 0));
  addEventListener('online', () => schedule(0));
  addEventListener('offline', () => setStatus({ state: session ? 'offline' : status.state }));
  addEventListener('focus', () => schedule(300));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(300); });
  setInterval(() => schedule(0), 60_000);
  store.onLocalChange(() => { setStatus({ pending: true }); schedule(1500); });
}

function handleSession(s, event) {
  const prev = session?.user?.id || null;
  session = s;
  const uid = s?.user?.id || null;
  if (uid) {
    if (uid !== prev) store.setUser(uid);
    if (status.state === 'signed-out' || status.state === 'disabled') setStatus({ state: 'idle' });
    schedule(0);
  } else {
    setStatus({ state: 'signed-out' });
  }
  if (uid !== prev || event === 'PASSWORD_RECOVERY' || event === 'USER_UPDATED') {
    authListeners.forEach((fn) => fn(session, event));
  }
}

// Android uygulamasının adresi (https://localhost) e-postadan açılamaz; orada web adresini kullan.
const redirectTo = () => (window.Capacitor?.isNativePlatform?.() ? SITE_URL : location.origin + location.pathname);

export async function signUp(email, password, displayName) {
  try {
    const { data, error } = await client.auth.signUp({
      email, password, options: { data: { display_name: displayName }, emailRedirectTo: redirectTo() },
    });
    if (error) throw error;
    return { needsConfirm: !data.session };
  } catch (e) { throw new Error(message(e)); }
}

export async function signIn(email, password) {
  try { ok(await client.auth.signInWithPassword({ email, password })); } catch (e) { throw new Error(message(e)); }
}

export async function sendPasswordReset(email) {
  try { ok(await client.auth.resetPasswordForEmail(email, { redirectTo: redirectTo() })); } catch (e) { throw new Error(message(e)); }
}

export async function updatePassword(password) {
  try { ok(await client.auth.updateUser({ password })); } catch (e) { throw new Error(message(e)); }
}

/** Çıkış yapar ve bu cihazdaki verileri temizler (veriler sunucuda kalır). */
export async function signOut() {
  try { await client.auth.signOut(); } catch { /* çevrimdışıysa da yerelde çık */ }
  store.signOutLocal();
  session = null;
  setStatus({ state: 'signed-out', lastSync: null, pending: false });
  authListeners.forEach((fn) => fn(null, 'SIGNED_OUT'));
}

export async function getProfile() {
  const u = user();
  if (!u) return null;
  return ok(await client.from('profiles').select('display_name').eq('id', u.id).maybeSingle());
}

export async function updateProfile(displayName) {
  ok(await client.from('profiles').update({ display_name: displayName }).eq('id', user().id));
}

/* ------------------------------------------------------------------ senkron */

let syncing = false;
let again = false;
let timer = null;

export function schedule(delay = 0) {
  if (!session) return;
  clearTimeout(timer);
  timer = setTimeout(syncNow, delay);
}

export async function syncNow() {
  if (!session) return;
  if (!navigator.onLine) { setStatus({ state: 'offline', pending: store.hasUnsynced() }); return; }
  if (syncing) { again = true; return; }
  syncing = true;
  setStatus({ state: 'syncing' });
  try {
    await push();
    await pull();
    await push();
    setStatus({ state: 'ok', lastSync: new Date(), error: null });
  } catch (e) {
    console.error('Senkron hatası', e);
    setStatus({ state: 'error', error: message(e) });
  } finally {
    syncing = false;
    setStatus({ pending: store.hasUnsynced() });
    if (again) { again = false; schedule(300); }
  }
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const isRejected = (e) => ['42501', '23503', '23514', 'PGRST116'].includes(e?.code);

/**
 * Bir tablonun değişmiş satırlarını gönderir. Yetki ya da bütünlük hatası veren satırlar
 * tek tek denenir; reddedilenler bırakılır ve sunucudaki sürüm geri çekilir.
 */
async function pushTable(localTable, rows, send, size = 300) {
  for (const part of chunks(rows, size)) {
    const { error } = await send(part);
    if (!error) { store.markClean(localTable, part); continue; }
    if (!isRejected(error) && part.length === 1) throw error;
    for (const row of part) {
      const res = await send([row]);
      if (!res.error) store.markClean(localTable, [row]);
      else if (isRejected(res.error)) {
        console.warn('Sunucu değişikliği reddetti, sunucu sürümü kullanılacak', res.error, row.rec);
        store.markClean(localTable, [row]);
        if (row.rec.deck_id) store.forgetFullSynced(row.rec.deck_id);
      } else throw res.error;
    }
  }
}

async function push() {
  const uid = store.uid();
  const dev = store.deviceName();

  const decks = store.dirtyRows('decks');
  const foreign = decks.filter((r) => r.rec.owner_id !== uid);
  if (foreign.length) store.markClean('decks', foreign);
  await pushTable('decks', decks.filter((r) => r.rec.owner_id === uid), (part) => client.from('decks').upsert(
    part.map(({ rec }) => ({ id: rec.id, name: rec.name, language: rec.language, deleted: !!rec.deleted, updated_device: dev })),
  ), 100);

  for (const row of store.dirtyRows('members')) {
    if (row.rec.user_id !== uid) { store.markClean('members', [row]); continue; }
    const { error } = await client.from('deck_members')
      .update({ new_per_day: row.rec.new_per_day, direction: row.rec.direction, removed: !!row.rec.removed })
      .eq('deck_id', row.rec.deck_id).eq('user_id', uid);
    if (error && !isRejected(error)) throw error;
    store.markClean('members', [row]);
  }

  await pushTable('cards', store.dirtyRows('cards'), (part) => client.from('cards').upsert(
    part.map(({ rec }) => ({
      id: rec.id, deck_id: rec.deck_id, word: rec.word, translation: rec.translation || '', sentence: rec.sentence || '',
      synonyms: rec.synonyms || [], notes: rec.notes || '', extra: rec.extra || {}, position: rec.position || 0,
      deleted: !!rec.deleted, updated_device: dev,
    })),
  ));

  await pushTable('states', store.dirtyRows('states'), (part) => client.from('card_states').upsert(
    part.map(({ rec }) => ({
      user_id: uid, card_id: rec.card_id, deck_id: rec.deck_id, state: rec.state, due: rec.due, ivl: rec.ivl,
      ease: Math.round(rec.ease * 1000) / 1000, step: rec.step, reps: rec.reps, lapses: rec.lapses,
    })),
  ), 500);

  await optionalTable(() => pushTable('sessions', store.dirtyRows('sessions'), (part) => client.from('study_sessions').upsert(
    part.map(({ rec }) => ({
      id: rec.id, user_id: uid, started_at: rec.started_at, ended_at: rec.ended_at, planned_min: rec.planned_min,
      actual_sec: rec.actual_sec, device: rec.device || dev, deleted: !!rec.deleted,
    })),
  ), 200), 'study_sessions');

  await optionalTable(() => pushTable('essays', store.dirtyRows('essays'), (part) => client.from('essays').upsert(
    part.map(({ rec }) => ({
      id: rec.id, user_id: uid, title: rec.title || '', task: rec.task, prompt: rec.prompt || '', body: rec.body || '',
      words: rec.words || 0, created_at: rec.created_at, edited_at: rec.edited_at, deleted: !!rec.deleted,
    })),
  ), 20), 'essays');

  await pushTable('revlog', store.dirtyRows('revlog'), (part) => client.from('revlog').upsert(
    part.map(({ rec }) => ({
      id: rec.id, user_id: uid, card_id: rec.card_id, deck_id: rec.deck_id, time: rec.time, rating: rec.rating,
      state_before: rec.state_before, ivl: rec.ivl, undone: !!rec.undone, device: rec.device || dev,
    })),
  ), 500);
}

const PULL_TABLES = ['deck_members', 'decks', 'cards', 'card_states', 'revlog', 'study_sessions', 'essays'];
const OWN_TABLES = ['card_states', 'revlog', 'study_sessions', 'essays'];
const OPTIONAL_TABLES = ['study_sessions', 'essays'];

// Sonradan eklenen tablolar (ör. study_sessions) sunucuda henüz oluşturulmadıysa
// senkronun geri kalanı bozulmasın: o tablo bu oturumda atlanır, veriler cihazda bekler.
let missingTables = new Set();
const isMissingTable = (e) => ['PGRST205', '42P01'].includes(e?.code);
async function optionalTable(fn, name) {
  if (missingTables.has(name)) return;
  try { await fn(); } catch (e) {
    if (!isMissingTable(e)) throw e;
    missingTables.add(name);
    console.warn(`Sunucuda ${name} tablosu yok; ilgili SQL çalıştırılınca eşitlenecek.`);
  }
}
const PAGE = 1000;
const toMs = (ts) => Date.parse(String(ts).replace(/(\.\d{3})\d+/, '$1'));

async function pullAll(table, filter) {
  let from = 0;
  let last = null;
  for (;;) {
    let q = client.from(table).select('*').order('updated_at').range(from, from + PAGE - 1);
    q = filter(q);
    const rows = ok(await q);
    store.applyRemote(table, rows);
    if (rows.length) last = rows[rows.length - 1].updated_at;
    if (rows.length < PAGE) return last;
    from += PAGE;
  }
}

async function pull() {
  const uid = store.uid();
  const meta = store.getMeta();
  const firstPull = !meta.cursors.cards;
  for (const table of PULL_TABLES) {
    const pullOne = async () => {
      const cursor = store.getMeta().cursors[table];
      // 2 dk geriden başla: aynı anda işlenen işlemler kaçmasın (tekrar gelen satırlar zararsız)
      const since = cursor ? new Date(toMs(cursor) - 120_000).toISOString() : null;
      const last = await pullAll(table, (q) => {
        if (since) q = q.gt('updated_at', since);
        if (OWN_TABLES.includes(table)) q = q.eq('user_id', uid);
        return q;
      });
      if (last && (!cursor || toMs(last) > toMs(cursor))) store.setMeta({ cursors: { ...store.getMeta().cursors, [table]: last } });
    };
    if (OPTIONAL_TABLES.includes(table)) await optionalTable(pullOne, table);
    else await pullOne();
  }
  // Yeni katılınan (ya da yeniden indirilmesi gereken) destelerin tüm içeriği
  for (const deckId of store.decksNeedingFullSync()) {
    if (!firstPull) {
      await pullAll('decks', (q) => q.eq('id', deckId));
      await pullAll('deck_members', (q) => q.eq('deck_id', deckId));
      await pullAll('cards', (q) => q.eq('deck_id', deckId));
    }
    store.markFullSynced(deckId);
  }
}

/* ------------------------------------------------------------------ yapay zekâ */

/** Kelimeler için kart içeriği üretir (sunucudaki kelime-ai fonksiyonu, NVIDIA API). */
export async function aiCards(words, language) {
  if (!enabled || !session) throw new Error('Yapay zekâ ile doldurmak için giriş yapman gerekiyor.');
  if (!navigator.onLine) throw new Error('Yapay zekâ için internet bağlantısı gerekiyor.');
  const timeout = new Promise((_, reject) => setTimeout(
    () => reject(new Error('Yapay zekâ çok uzun sürdü. Biraz sonra tekrar dene.')), 120_000));
  const { data, error } = await Promise.race([
    client.functions.invoke('kelime-ai', { body: { words, language } }), timeout]);
  if (error) {
    let msg = error.message;
    try { msg = (await error.context?.json?.())?.error || msg; } catch { /* gövde JSON değil */ }
    throw new Error(message({ message: msg }));
  }
  return data?.cards || [];
}

/* ------------------------------------------------------------------ paylaşım ve geçmiş */

async function rpc(name, args) {
  try { return ok(await client.rpc(name, args)); } catch (e) { throw new Error(message(e)); }
}

export async function joinDeck(code) {
  const deckId = await rpc('join_deck', { code: code.trim() });
  if (!deckId) throw new Error('Bu kodla bir deste bulunamadı. Kodu kontrol et.');
  store.forgetFullSynced(deckId);
  await syncNow();
  return deckId;
}

export async function fetchMembers(deckId) {
  try {
    return ok(await client.from('deck_members').select('user_id, role, joined_at, profiles(display_name)')
      .eq('deck_id', deckId).eq('removed', false).order('joined_at'));
  } catch (e) { throw new Error(message(e)); }
}

export async function setMemberRole(deckId, userId, role) {
  await rpc('set_member_role', { p_deck: deckId, p_user: userId, p_role: role });
}

/** Üyeyi çıkarır; paylaşım kodu da yenilenir. Yeni kodu döndürür. */
export async function removeMember(deckId, userId) {
  const code = await rpc('remove_member', { p_deck: deckId, p_user: userId });
  await syncNow();
  return code;
}

export async function regenerateShareCode(deckId) {
  const code = await rpc('regenerate_share_code', { p_deck: deckId });
  await syncNow();
  return code;
}

export async function fetchHistory(deckId, limit = 300) {
  try {
    return ok(await client.from('changes').select('id, entity, action, summary, diff, device, at, user_id, profiles(display_name)')
      .eq('deck_id', deckId).order('at', { ascending: false }).limit(limit));
  } catch (e) { throw new Error(message(e)); }
}

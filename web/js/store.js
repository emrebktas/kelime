// Yerel veri katmanı: tüm veri bellekte tutulur, IndexedDB'ye yazılır.
// Değişen kayıtlar `_dirty` ile işaretlenir; sync.js bunları sunucuya gönderir.

import * as srs from './srs.js';

const DB_NAME = 'kelime';
const TABLES = ['decks', 'members', 'cards', 'states', 'revlog', 'sessions', 'essays'];
const LOCAL_UID = 'local';

const mem = Object.fromEntries(TABLES.map((t) => [t, new Map()]));
let idb = null;
let meta = { uid: LOCAL_UID, cursors: {}, fullSynced: [], device: '' };
let lastUndo = null;
let revCounter = Date.now();

const localListeners = new Set();
const remoteListeners = new Set();
export const onLocalChange = (fn) => localListeners.add(fn);
export const onRemoteChange = (fn) => remoteListeners.add(fn);
let notifyQueued = false;
function notifyLocal() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => { notifyQueued = false; localListeners.forEach((fn) => fn()); });
}

/* ------------------------------------------------------------------ IndexedDB */

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = tx.onabort = () => rej(tx.error); });

export async function open() {
  idb = await new Promise((res, rej) => {
    // Sürüm 2: çalışma sayacı oturumları, 3: yazılar; eksik tablolar oluşturulur, veriler korunur
    const r = indexedDB.open(DB_NAME, 3);
    r.onupgradeneeded = () => {
      for (const t of [...TABLES, 'meta']) if (!r.result.objectStoreNames.contains(t)) r.result.createObjectStore(t);
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const tx = idb.transaction([...TABLES, 'meta']);
  await Promise.all(TABLES.map(async (t) => {
    const os = tx.objectStore(t);
    const [keys, vals] = await Promise.all([req(os.getAllKeys()), req(os.getAll())]);
    keys.forEach((k, i) => mem[t].set(k, vals[i]));
  }));
  const saved = await req(tx.objectStore('meta').get('meta'));
  if (saved) meta = { ...meta, ...saved };
  if (!meta.device) { meta.device = defaultDeviceName(); saveMeta(); }
  navigator.storage?.persist?.().catch(() => {});
  addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });
}

const pending = new Map();
let flushTimer = null;
function persist(table, key, value) {
  pending.set(`${table}\u0000${key}`, { table, key, value });
  if (!flushTimer) flushTimer = setTimeout(flush, 40);
}
function saveMeta() { persist('meta', 'meta', meta); }

export async function flush() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!pending.size || !idb) return;
  const items = [...pending.values()];
  pending.clear();
  const tx = idb.transaction([...TABLES, 'meta'], 'readwrite');
  for (const { table, key, value } of items) {
    const os = tx.objectStore(table);
    if (value === null) os.delete(key); else os.put(value, key);
  }
  await txDone(tx);
}

function setRec(table, key, rec, dirty = true) {
  if (dirty) { rec._dirty = true; rec._rev = ++revCounter; }
  mem[table].set(key, rec);
  persist(table, key, rec);
  if (dirty) notifyLocal();
}
function delRec(table, key) {
  if (!mem[table].has(key)) return;
  mem[table].delete(key);
  persist(table, key, null);
}

/* ------------------------------------------------------------------ kullanıcı / cihaz */

export const uid = () => meta.uid;
export const isLocalUser = () => meta.uid === LOCAL_UID;
export const deviceName = () => meta.device;
export function setDeviceName(name) {
  meta.device = String(name || '').trim().slice(0, 60) || defaultDeviceName();
  saveMeta();
}
export const getMeta = () => meta;
export function setMeta(patch) { Object.assign(meta, patch); saveMeta(); }

function defaultDeviceName() {
  const ua = navigator.userAgent;
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone'
    : /Macintosh|Mac OS X/i.test(ua) ? 'Mac' : /Windows/i.test(ua) ? 'Windows' : /Linux/i.test(ua) ? 'Linux' : 'Cihaz';
  const br = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return br ? `${os} · ${br}` : os;
}

/** Giriş yapan kullanıcıyı ayarlar. Girişsiz oluşturulan veriler hesaba aktarılır. */
export function setUser(newUid) {
  if (meta.uid === newUid) return false;
  if (meta.uid === LOCAL_UID) adoptLocal(newUid);
  else wipe();
  meta.uid = newUid;
  meta.cursors = {};
  meta.fullSynced = [];
  saveMeta();
  return true;
}

function adoptLocal(newUid) {
  for (const d of mem.decks.values()) if (d.owner_id === LOCAL_UID) setRec('decks', d.id, { ...d, owner_id: newUid });
  for (const [key, m] of [...mem.members]) {
    if (m.user_id !== LOCAL_UID) continue;
    delRec('members', key);
    setRec('members', `${m.deck_id}|${newUid}`, { ...m, user_id: newUid });
  }
  for (const [key, s] of mem.states) setRec('states', key, { ...s, user_id: newUid });
  for (const [key, r] of mem.revlog) setRec('revlog', key, { ...r, user_id: newUid });
  for (const [key, s] of mem.sessions) setRec('sessions', key, { ...s, user_id: newUid });
  for (const [key, e] of mem.essays) setRec('essays', key, { ...e, user_id: newUid });
}

/** Çıkış: cihazdaki tüm veriyi siler. */
export function signOutLocal() {
  wipe();
  meta.uid = LOCAL_UID;
  meta.cursors = {};
  meta.fullSynced = [];
  saveMeta();
}

function wipe() {
  for (const t of TABLES) for (const key of [...mem[t].keys()]) delRec(t, key);
  lastUndo = null;
}

export const hasUnsynced = () => TABLES.some((t) => [...mem[t].values()].some((r) => r._dirty));

/* ------------------------------------------------------------------ sync arayüzü */

export function dirtyRows(table) {
  const out = [];
  for (const [key, rec] of mem[table]) if (rec._dirty) out.push({ key, rec, rev: rec._rev });
  return out;
}

export function markClean(table, rows) {
  for (const { key, rev } of rows) {
    const r = mem[table].get(key);
    if (r && r._rev === rev) {
      r._dirty = false;
      r._server = true;
      if (['cards', 'sessions', 'essays'].includes(table) && r.deleted) delRec(table, key);
      else persist(table, key, r);
    }
  }
}

/** Sunucudan gelen satırları uygular. Henüz gönderilmemiş yerel değişiklikler korunur. */
export function applyRemote(table, rows) {
  let changed = false;
  for (const r of rows) {
    if (table === 'decks') {
      if (mem.decks.get(r.id)?._dirty) continue;
      setRec('decks', r.id, { id: r.id, owner_id: r.owner_id, name: r.name, language: r.language,
        share_code: r.share_code, deleted: r.deleted, _server: true }, false);
      if (r.deleted) purgeDeckContent(r.id);
    } else if (table === 'deck_members') {
      const key = `${r.deck_id}|${r.user_id}`;
      if (mem.members.get(key)?._dirty) continue;
      setRec('members', key, { deck_id: r.deck_id, user_id: r.user_id, role: r.role, new_per_day: r.new_per_day,
        direction: r.direction, removed: r.removed, _server: true }, false);
      if (r.user_id === meta.uid && r.removed) {
        purgeDeckContent(r.deck_id);
        meta.fullSynced = meta.fullSynced.filter((id) => id !== r.deck_id);
        saveMeta();
      }
    } else if (table === 'cards') {
      if (mem.cards.get(r.id)?._dirty) continue;
      if (r.deleted) { delRec('cards', r.id); }
      else {
        setRec('cards', r.id, { id: r.id, deck_id: r.deck_id, word: r.word, wkey: wordKey(r.word),
          translation: r.translation, sentence: r.sentence, synonyms: r.synonyms || [], notes: r.notes,
          extra: r.extra || {}, position: r.position, deleted: false, _server: true }, false);
      }
    } else if (table === 'card_states') {
      if (r.user_id !== meta.uid || mem.states.get(r.card_id)?._dirty) continue;
      setRec('states', r.card_id, { user_id: r.user_id, card_id: r.card_id, deck_id: r.deck_id, state: r.state,
        due: Number(r.due), ivl: r.ivl, ease: r.ease, step: r.step, reps: r.reps, lapses: r.lapses, _server: true }, false);
    } else if (table === 'essays') {
      if (r.user_id !== meta.uid || mem.essays.get(r.id)?._dirty) continue;
      if (r.deleted) delRec('essays', r.id);
      else {
        setRec('essays', r.id, { id: r.id, user_id: r.user_id, title: r.title, task: r.task, prompt: r.prompt, body: r.body,
          words: r.words, created_at: Number(r.created_at), edited_at: Number(r.edited_at), deleted: false, _server: true }, false);
      }
    } else if (table === 'study_sessions') {
      if (r.user_id !== meta.uid || mem.sessions.get(r.id)?._dirty) continue;
      if (r.deleted) delRec('sessions', r.id);
      else {
        setRec('sessions', r.id, { id: r.id, user_id: r.user_id, started_at: Number(r.started_at), ended_at: Number(r.ended_at),
          planned_min: r.planned_min, actual_sec: r.actual_sec, device: r.device, deleted: false, _server: true }, false);
      }
    } else if (table === 'revlog') {
      if (r.user_id !== meta.uid || mem.revlog.get(r.id)?._dirty) continue;
      setRec('revlog', r.id, { id: r.id, user_id: r.user_id, card_id: r.card_id, deck_id: r.deck_id, time: Number(r.time),
        rating: r.rating, state_before: r.state_before, ivl: r.ivl, undone: r.undone, device: r.device, _server: true }, false);
    }
    changed = true;
  }
  if (changed) remoteListeners.forEach((fn) => fn(table));
}

/** Bir destenin kartlarını ve ilerlemesini cihazdan siler (deste silindi / desteden çıkıldı). */
function purgeDeckContent(deckId) {
  for (const [key, c] of [...mem.cards]) if (c.deck_id === deckId) delRec('cards', key);
  for (const [key, s] of [...mem.states]) if (s.deck_id === deckId) delRec('states', key);
  for (const [key, r] of [...mem.revlog]) if (r.deck_id === deckId && !r._dirty) delRec('revlog', key);
}

/** Üyesi olduğum ama içeriği henüz tamamen indirilmemiş desteler. */
export function decksNeedingFullSync() {
  return [...mem.members.values()]
    .filter((m) => m.user_id === meta.uid && !m.removed && !meta.fullSynced.includes(m.deck_id))
    .map((m) => m.deck_id);
}
export function markFullSynced(deckId) {
  if (!meta.fullSynced.includes(deckId)) { meta.fullSynced.push(deckId); saveMeta(); }
}
export function forgetFullSynced(deckId) {
  meta.fullSynced = meta.fullSynced.filter((id) => id !== deckId);
  saveMeta();
}

/* ------------------------------------------------------------------ yardımcılar */

const uuid = () => crypto.randomUUID();
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Veritabanındaki uzunluk sınırlarıyla aynı (supabase/migrations/*_guvenlik.sql)
const LIMITS = { deckName: 100, word: 300, translation: 2000, sentence: 5000, notes: 5000, synonyms: 5000, extra: 10000 };
const cut = (s, n) => (s.length > n ? s.slice(0, n) : s);
function limitList(list, max) {
  const out = [];
  for (const s of list) {
    if (JSON.stringify([...out, s]).length > max) break;
    out.push(s);
  }
  return out;
}
function limitExtra(extra) {
  const out = {};
  for (const [k, v] of Object.entries(extra)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[cut(k, 100)] = cut(v, 2000);
    if (JSON.stringify(out).length > LIMITS.extra) { delete out[cut(k, 100)]; break; }
  }
  return out;
}
/** Kart içeriğini sunucunun kabul edeceği uzunluklara indirir. */
function limitCard(c) {
  return {
    ...c,
    translation: cut(c.translation || '', LIMITS.translation),
    sentence: cut(c.sentence || '', LIMITS.sentence),
    notes: cut(c.notes || '', LIMITS.notes),
    synonyms: limitList(c.synonyms || [], LIMITS.synonyms),
    extra: limitExtra(c.extra || {}),
  };
}
export const wordKey = (w) => clean(w).toLocaleLowerCase();

function toText(v, sep = ', ') {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.filter((x) => x !== null && String(x).trim()).map((x) => String(x).trim()).join(sep);
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v).trim();
}
function toList(v) {
  if (v === null || v === undefined) return [];
  const items = Array.isArray(v) ? v.map((x) => String(x ?? '')) : String(v).replace(/;/g, ',').split(',');
  const seen = new Set();
  const out = [];
  for (const it of items.map((s) => s.trim())) {
    const k = it.toLocaleLowerCase();
    if (it && !seen.has(k)) { seen.add(k); out.push(it); }
  }
  return out;
}

const FIELD_ALIASES = {
  word: ['word', 'term', 'front', 'kelime', 'wort', 'vocabulary', 'vocab'],
  translation: ['translation', 'turkish', 'tr', 'türkçe', 'turkce', 'meaning', 'anlam', 'anlamı', 'back', 'çeviri', 'ceviri'],
  sentence: ['sentence', 'sentences', 'example', 'examples', 'example_sentence', 'cümle', 'cumle', 'örnek', 'ornek', 'satz', 'beispiel'],
  synonyms: ['synonyms', 'synonym', 'syn', 'eş anlamlılar', 'eş_anlamlılar', 'es_anlamlilar', 'eşanlamlılar', 'synonyme'],
  notes: ['notes', 'note', 'not', 'notlar'],
};
const ALIAS = new Map(Object.entries(FIELD_ALIASES).flatMap(([f, as]) => as.map((a) => [a, f])));
const SKIP_KEYS = new Set(['srs', 'id']);

export function normalizeCard(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = { word: '', translation: '', sentence: '', synonyms: [], notes: '', extra: {} };
  for (const [k, v] of Object.entries(raw)) {
    const key = String(k).trim().toLocaleLowerCase();
    if (SKIP_KEYS.has(key)) continue;
    const f = ALIAS.get(key);
    if (f === 'synonyms') out.synonyms = toList(v);
    else if (f === 'sentence') out.sentence = toText(v, '\n');
    else if (f) out[f] = toText(v);
    else if (v !== null && v !== '' && !(Array.isArray(v) && !v.length) && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)) {
      out.extra[String(k)] = toText(v);
    }
  }
  out.word = cut(clean(out.word), LIMITS.word);
  return out.word ? limitCard(out) : null;
}

/* ------------------------------------------------------------------ erişim kontrolü */

const memberKey = (deckId, user = meta.uid) => `${deckId}|${user}`;
function myMember(deckId) {
  const m = mem.members.get(memberKey(deckId));
  return m && !m.removed ? m : null;
}
function activeDeck(id) {
  const d = mem.decks.get(id);
  return d && !d.deleted && myMember(id) ? d : null;
}
function deckOrThrow(id) {
  const d = activeDeck(id);
  if (!d) throw new Error('Deste bulunamadı.');
  return d;
}
export function canEdit(deckId) {
  const m = myMember(deckId);
  return !!m && (m.role === 'owner' || m.role === 'editor');
}
function requireEdit(deckId) {
  if (!canEdit(deckId)) throw new Error('Bu destede düzenleme yetkin yok, sadece görüntüleyebilirsin.');
}
const deckCards = (deckId) => [...mem.cards.values()].filter((c) => c.deck_id === deckId && !c.deleted);
const stateOf = (cardId) => mem.states.get(cardId) || null;

function cardView(c) {
  const s = stateOf(c.id) || srs.emptyState();
  return {
    id: c.id, deck_id: c.deck_id, word: c.word, translation: c.translation || '', sentence: c.sentence || '',
    synonyms: c.synonyms || [], notes: c.notes || '', extra: c.extra || {}, position: c.position,
    state: s.state, due: s.due, ivl: s.ivl, ease: s.ease, step: s.step, reps: s.reps, lapses: s.lapses,
  };
}

function newTodayMap(today) {
  const out = new Map();
  for (const r of mem.revlog.values()) {
    if (r.time >= today && r.state_before === 0 && !r.undone && r.user_id === meta.uid) {
      out.set(r.deck_id, (out.get(r.deck_id) || 0) + 1);
    }
  }
  return out;
}

function countsFor(deckId, now = srs.nowSec(), newToday = null) {
  let total = 0; let nw = 0; let learn = 0; let review = 0;
  for (const c of mem.cards.values()) {
    if (c.deck_id !== deckId || c.deleted) continue;
    total++;
    const s = stateOf(c.id);
    if (!s || s.state === 0) nw++;
    else if (s.state === 1 || s.state === 3) learn++;
    else if (s.due <= now) review++;
  }
  const m = myMember(deckId);
  const used = (newToday || newTodayMap(srs.dayStart(now))).get(deckId) || 0;
  return { total, new: Math.min(nw, Math.max(0, (m?.new_per_day ?? 20) - used)), learn, review };
}

/* ------------------------------------------------------------------ desteler */

export function getDecks() {
  const now = srs.nowSec();
  const newToday = newTodayMap(srs.dayStart(now));
  const memberCount = new Map();
  for (const m of mem.members.values()) if (!m.removed) memberCount.set(m.deck_id, (memberCount.get(m.deck_id) || 0) + 1);
  return [...mem.decks.values()]
    .filter((d) => activeDeck(d.id))
    .map((d) => {
      const m = myMember(d.id);
      return {
        id: d.id, name: d.name, language: d.language, share_code: d.share_code, owner_id: d.owner_id,
        role: m.role, new_per_day: m.new_per_day, direction: m.direction,
        shared: (memberCount.get(d.id) || 0) > 1, synced: !!d._server,
        ...countsFor(d.id, now, newToday),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'tr', { sensitivity: 'base' }));
}

function cleanDeckFields(data) {
  const f = {};
  if ('name' in data) {
    f.name = clean(data.name);
    if (!f.name) throw new Error('Deste adı boş olamaz.');
    if (f.name.length > LIMITS.deckName) throw new Error(`Deste adı en fazla ${LIMITS.deckName} karakter olabilir.`);
  }
  if ('language' in data) f.language = (String(data.language || '').trim().toLowerCase() || 'en').slice(0, 12);
  if ('new_per_day' in data) f.new_per_day = Math.max(0, Math.min(9999, parseInt(data.new_per_day, 10) || 0));
  if ('direction' in data) f.direction = ['front', 'back', 'mixed'].includes(data.direction) ? data.direction : 'front';
  return f;
}

function checkDeckName(name, excludeId = null) {
  const key = name.toLocaleLowerCase();
  const hit = [...mem.decks.values()].find((d) => d.id !== excludeId && activeDeck(d.id) && d.name.toLocaleLowerCase() === key);
  if (hit) throw new Error(`“${name}” adında bir deste zaten var.`);
}

function findDeckByName(name) {
  const key = clean(name).toLocaleLowerCase();
  return [...mem.decks.values()].find((d) => activeDeck(d.id) && d.name.toLocaleLowerCase() === key) || null;
}

export function createDeck(data) {
  const f = cleanDeckFields({ language: 'en', new_per_day: 20, direction: 'front', ...data });
  if (!f.name) throw new Error('Deste adı boş olamaz.');
  checkDeckName(f.name);
  const id = uuid();
  setRec('decks', id, { id, owner_id: meta.uid, name: f.name, language: f.language, share_code: null, deleted: false });
  setRec('members', memberKey(id), { deck_id: id, user_id: meta.uid, role: 'owner', new_per_day: f.new_per_day,
    direction: f.direction, removed: false });
  return getDecks().find((d) => d.id === id);
}

export function updateDeck(id, data) {
  const d = deckOrThrow(id);
  const m = myMember(id);
  const f = cleanDeckFields(data);
  const renamed = ('name' in f && f.name !== d.name) || ('language' in f && f.language !== d.language);
  if (renamed) {
    if (m.role !== 'owner') throw new Error('Destenin adını ve dilini sadece sahibi değiştirebilir.');
    if ('name' in f) checkDeckName(f.name, id);
    setRec('decks', id, { ...d, name: f.name ?? d.name, language: f.language ?? d.language });
  }
  if (('new_per_day' in f && f.new_per_day !== m.new_per_day) || ('direction' in f && f.direction !== m.direction)) {
    setRec('members', memberKey(id), { ...m, new_per_day: f.new_per_day ?? m.new_per_day, direction: f.direction ?? m.direction });
  }
  return getDecks().find((x) => x.id === id);
}

/** Sahipse desteyi siler, değilse desteden ayrılır. */
export function deleteDeck(id) {
  const d = deckOrThrow(id);
  const m = myMember(id);
  if (m.role === 'owner') {
    if (!d._server) {
      purgeDeckContent(id);
      delRec('decks', id);
      for (const key of [...mem.members.keys()]) if (key.startsWith(`${id}|`)) delRec('members', key);
    } else {
      setRec('decks', id, { ...d, deleted: true });
      purgeDeckContent(id);
    }
  } else {
    setRec('members', memberKey(id), { ...m, removed: true });
    purgeDeckContent(id);
    forgetFullSynced(id);
  }
  lastUndo = null;
  return true;
}

export function getDeckStats(deckId) {
  deckOrThrow(deckId);
  const today = srs.dayStart(srs.nowSec());
  const st = { total: 0, new: 0, learning: 0, young: 0, mature: 0, today: 0, today_correct: 0 };
  for (const c of deckCards(deckId)) {
    st.total++;
    const s = stateOf(c.id);
    if (!s || s.state === 0) st.new++;
    else if (s.state === 1 || s.state === 3) st.learning++;
    else if (s.ivl >= 21) st.mature++;
    else st.young++;
  }
  let ok = 0;
  for (const r of mem.revlog.values()) {
    if (r.deck_id === deckId && r.time >= today && !r.undone && r.user_id === meta.uid) {
      st.today++;
      if (r.rating > 1) ok++;
    }
  }
  st.today_correct = st.today ? Math.round((100 * ok) / st.today) : 0;
  return st;
}

/* ------------------------------------------------------------------ kartlar */

export function listCards(deckId, query = '', limit = 1000) {
  deckOrThrow(deckId);
  const q = query.trim().toLocaleLowerCase();
  let cards = deckCards(deckId);
  if (q) {
    cards = cards.filter((c) => [c.word, c.translation, c.sentence, (c.synonyms || []).join(' ')]
      .some((s) => (s || '').toLocaleLowerCase().includes(q)));
  }
  cards.sort((a, b) => a.position - b.position);
  return { total: cards.length, cards: cards.slice(0, limit).map(cardView) };
}

const maxPosition = (deckId) => deckCards(deckId).reduce((m, c) => Math.max(m, c.position || 0), 0);

export function saveCard(data) {
  const word = clean(data.word);
  if (!word) throw new Error('Kelime boş olamaz.');
  if (word.length > LIMITS.word) throw new Error(`Kelime en fazla ${LIMITS.word} karakter olabilir.`);
  for (const f of ['translation', 'sentence', 'notes']) {
    if (String(data[f] || '').length > LIMITS[f]) throw new Error(`Bu alan en fazla ${LIMITS[f]} karakter olabilir.`);
  }
  const key = wordKey(word);
  const existing = data.id ? mem.cards.get(data.id) : null;
  if (data.id && (!existing || existing.deleted)) throw new Error('Kart bulunamadı.');
  const deckId = existing ? existing.deck_id : data.deck_id;
  deckOrThrow(deckId);
  requireEdit(deckId);
  if (deckCards(deckId).some((c) => c.wkey === key && c.id !== data.id)) throw new Error(`“${word}” bu destede zaten var.`);
  const extra = Object.fromEntries(Object.entries(data.extra || {})
    .map(([k, v]) => [String(k).trim(), String(v).trim()]).filter(([k]) => k));
  const rec = limitCard({
    ...(existing || { id: uuid(), deck_id: deckId, position: maxPosition(deckId) + 1 }),
    word, wkey: key, translation: toText(data.translation), sentence: toText(data.sentence, '\n'),
    synonyms: toList(data.synonyms), notes: toText(data.notes), extra, deleted: false,
  });
  setRec('cards', rec.id, rec);
  return cardView(rec);
}

export function deleteCards(ids) {
  for (const id of ids) {
    const c = mem.cards.get(id);
    if (!c || c.deleted) continue;
    requireEdit(c.deck_id);
    // Silme işareti; sunucuya gönderildikten sonra cihazdan da kaldırılır (markClean)
    setRec('cards', id, { ...c, deleted: true });
  }
  lastUndo = null;
  return ids.length;
}

export function resetCards(ids) {
  for (const id of ids) {
    const s = stateOf(id);
    if (s && s.state !== 0) setRec('states', id, { ...s, ...srs.emptyState() });
  }
  lastUndo = null;
  return ids.length;
}

export function moveCards(ids, targetDeckId) {
  deckOrThrow(targetDeckId);
  requireEdit(targetDeckId);
  const taken = new Set(deckCards(targetDeckId).map((c) => c.wkey));
  let moved = 0;
  let pos = maxPosition(targetDeckId);
  for (const id of ids) {
    const c = mem.cards.get(id);
    if (!c || c.deleted || c.deck_id === targetDeckId) continue;
    requireEdit(c.deck_id);
    if (taken.has(c.wkey)) continue;
    taken.add(c.wkey);
    setRec('cards', id, { ...c, deck_id: targetDeckId, position: ++pos });
    const s = stateOf(id);
    if (s) setRec('states', id, { ...s, deck_id: targetDeckId });
    moved++;
  }
  lastUndo = null;
  return { moved, skipped: ids.length - moved };
}

/* ------------------------------------------------------------------ içe / dışa aktarma */

function resolveTarget(target) {
  if (target.deck_id) {
    deckOrThrow(target.deck_id);
    requireEdit(target.deck_id);
    return target.deck_id;
  }
  const name = clean(target.name) || 'İçe aktarılan';
  const found = findDeckByName(name);
  if (found) { requireEdit(found.id); return found.id; }
  const extra = {};
  if (target.new_per_day !== undefined) extra.new_per_day = target.new_per_day;
  if (target.direction) extra.direction = target.direction;
  return createDeck({ name, language: target.language || 'en', ...extra }).id;
}

/** Kartları desteye ekler; aynı kelime varsa boş olmayan alanlarını günceller, ilerlemeyi korur. */
export function importCards(target, rawCards) {
  if (!Array.isArray(rawCards)) throw new Error('Kart listesi bulunamadı.');
  const deckId = resolveTarget(target);
  const known = new Map(deckCards(deckId).map((c) => [c.wkey, c]));
  let pos = maxPosition(deckId);
  let added = 0; let updated = 0; let skipped = 0;
  for (const raw of rawCards) {
    const c = normalizeCard(raw);
    if (!c) { skipped++; continue; }
    const key = wordKey(c.word);
    const old = known.get(key);
    let rec;
    if (old) {
      rec = { ...old, word: c.word, translation: c.translation || old.translation, sentence: c.sentence || old.sentence,
        synonyms: c.synonyms.length ? c.synonyms : old.synonyms, notes: c.notes || old.notes,
        extra: Object.keys(c.extra).length ? c.extra : old.extra };
      updated++;
    } else {
      rec = { id: uuid(), deck_id: deckId, position: ++pos, word: c.word, wkey: key, translation: c.translation,
        sentence: c.sentence, synonyms: c.synonyms, notes: c.notes, extra: c.extra, deleted: false };
      added++;
    }
    setRec('cards', rec.id, rec);
    known.set(key, rec);
    // Yedekten gelen çalışma ilerlemesi (sadece henüz çalışılmamış kartlara uygulanır)
    const s = raw && raw.srs;
    if (s && typeof s === 'object' && !(stateOf(rec.id)?.state > 0)) {
      setRec('states', rec.id, { user_id: meta.uid, card_id: rec.id, deck_id: deckId, ...srs.emptyState(),
        ...pick(s, ['state', 'due', 'ivl', 'ease', 'step', 'reps', 'lapses']) });
    }
  }
  return { deck_id: deckId, added, updated, skipped };
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => typeof o[k] === 'number').map((k) => [k, o[k]]));

export function exportDeck(deckId, withProgress = false) {
  const d = deckOrThrow(deckId);
  const m = myMember(deckId);
  const cards = deckCards(deckId).sort((a, b) => a.position - b.position).map((c) => {
    const item = { word: c.word, translation: c.translation, sentence: c.sentence, synonyms: c.synonyms };
    if (c.notes) item.notes = c.notes;
    Object.assign(item, c.extra);
    const s = stateOf(c.id);
    if (withProgress && s && s.state > 0) item.srs = pick(s, ['state', 'due', 'ivl', 'ease', 'step', 'reps', 'lapses']);
    return item;
  });
  const out = { deck: d.name, language: d.language, cards };
  if (withProgress) Object.assign(out, { new_per_day: m.new_per_day, direction: m.direction });
  return out;
}

export function exportBackup() {
  return {
    format: 'kelime-backup', version: 1, exported_at: new Date().toISOString(),
    decks: getDecks().map((d) => exportDeck(d.id, true)),
  };
}

/* ------------------------------------------------------------------ çalışma */

function payload(deckId, card) {
  const now = srs.nowSec();
  const counts = countsFor(deckId, now);
  if (!card) {
    let next = null;
    for (const c of deckCards(deckId)) {
      const s = stateOf(c.id);
      if (s && (s.state === 1 || s.state === 3) && (next === null || s.due < next)) next = s.due;
    }
    return { card: null, counts, next_due: next, now };
  }
  const v = cardView(card);
  return { card: v, counts, previews: srs.previews(v, now), now };
}

export function nextCard(deckId) {
  const deck = deckOrThrow(deckId);
  const m = myMember(deck.id);
  const now = srs.nowSec();
  const learning = []; const reviews = []; const news = [];
  for (const c of deckCards(deckId)) {
    const s = stateOf(c.id);
    if (!s || s.state === 0) news.push(c);
    else if (s.state === 1 || s.state === 3) learning.push([c, s.due]);
    else if (s.due <= now) reviews.push(c);
  }
  learning.sort((a, b) => a[1] - b[1]);
  if (learning.length && learning[0][1] <= now) return payload(deckId, learning[0][0]);
  const used = newTodayMap(srs.dayStart(now)).get(deckId) || 0;
  const nNew = Math.min(news.length, Math.max(0, m.new_per_day - used));
  const nRev = reviews.length;
  if (nNew && (!nRev || Math.random() < nNew / (nNew + nRev))) {
    news.sort((a, b) => a.position - b.position);
    return payload(deckId, news[0]);
  }
  if (nRev) {
    const minDue = Math.min(...reviews.map((c) => stateOf(c.id).due));
    const pool = reviews.filter((c) => stateOf(c.id).due === minDue);
    return payload(deckId, pool[Math.floor(Math.random() * pool.length)]);
  }
  if (learning.length && learning[0][1] <= now + srs.LEARN_AHEAD) return payload(deckId, learning[0][0]);
  return payload(deckId, null);
}

export function answer(cardId, rating, deckId) {
  rating = Number(rating);
  if (![1, 2, 3, 4].includes(rating)) throw new Error('Geçersiz cevap.');
  const c = mem.cards.get(cardId);
  if (!c || c.deleted) throw new Error('Kart bulunamadı.');
  const prev = stateOf(cardId);
  const s = prev || { user_id: meta.uid, card_id: cardId, deck_id: c.deck_id, ...srs.emptyState() };
  const now = srs.nowSec();
  const upd = srs.schedule(s, rating, now);
  const revId = uuid();
  setRec('revlog', revId, { id: revId, user_id: meta.uid, card_id: cardId, deck_id: c.deck_id, time: now, rating,
    state_before: s.state, ivl: upd.ivl, undone: false, device: meta.device });
  setRec('states', cardId, { ...s, ...upd, user_id: meta.uid, deck_id: c.deck_id, reps: s.reps + 1 });
  lastUndo = { cardId, prev: prev ? { ...prev } : null, revId };
  return nextCard(deckId);
}

export function undo(deckId) {
  if (!lastUndo) throw new Error('Geri alınacak bir cevap yok.');
  const { cardId, prev, revId } = lastUndo;
  lastUndo = null;
  const cur = stateOf(cardId);
  const restored = prev ? { ...prev } : { ...(cur || {}), user_id: meta.uid, card_id: cardId, ...srs.emptyState() };
  delete restored._dirty;
  setRec('states', cardId, restored);
  const r = mem.revlog.get(revId);
  if (r) setRec('revlog', revId, { ...r, undone: true });
  const c = mem.cards.get(cardId);
  if (!c || c.deleted || c.deck_id !== deckId) return nextCard(deckId);
  return payload(deckId, c);
}

/* ------------------------------------------------------------------ çalışma sayacı */

const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(n) || 0)));

/** Tamamlanan bir sayaç oturumunu kaydeder (zamanlar milisaniye). */
export function addSession({ startedAt, endedAt, plannedMin, actualSec }) {
  const id = uuid();
  const rec = {
    id, user_id: meta.uid,
    started_at: Math.floor(startedAt / 1000), ended_at: Math.floor(endedAt / 1000),
    planned_min: clampInt(plannedMin, 1, 180), actual_sec: clampInt(actualSec, 0, 86400),
    device: meta.device, deleted: false,
  };
  setRec('sessions', id, rec);
  return rec;
}

export function deleteSession(id) {
  const s = mem.sessions.get(id);
  if (s) setRec('sessions', id, { ...s, deleted: true });
}

/** Son `days` günün oturumları, yeniden eskiye. */
export function listSessions(days = 30) {
  const since = Math.floor(startOfDay(new Date()).getTime() / 1000) - (days - 1) * 86400;
  return [...mem.sessions.values()]
    .filter((s) => !s.deleted && s.started_at >= since)
    .sort((a, b) => b.started_at - a.started_at);
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
export const dayKey = (date) => {
  const d = new Date(date);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/**
 * Çalışma süresi özeti. `liveSec`: şu an çalışan sayacın süresi (bugüne canlı eklenir).
 * Oturum, başladığı güne sayılır.
 */
export function studyStats(liveSec = 0) {
  const byDay = new Map();
  for (const s of mem.sessions.values()) {
    if (s.deleted) continue;
    const k = dayKey(s.started_at * 1000);
    byDay.set(k, (byDay.get(k) || 0) + s.actual_sec);
  }
  const today = startOfDay(new Date());
  const todayKey = dayKey(today);
  byDay.set(todayKey, (byDay.get(todayKey) || 0) + liveSec);

  const week = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    week.push({ date: d, sec: byDay.get(dayKey(d)) || 0, today: i === 0 });
  }
  // Seri: bugünden (bugün henüz çalışılmadıysa dünden) geriye, en az 1 dk çalışılan ardışık günler
  let streak = 0;
  const d = new Date(today);
  if ((byDay.get(todayKey) || 0) < 60) d.setDate(d.getDate() - 1);
  while ((byDay.get(dayKey(d)) || 0) >= 60) {
    streak++;
    d.setDate(d.getDate() - 1);
  }
  return {
    today: byDay.get(todayKey) || 0,
    week,
    weekTotal: week.reduce((a, x) => a + x.sec, 0),
    streak,
  };
}

/* ------------------------------------------------------------------ yazılar (IELTS essay) */

export const ESSAY_TASKS = ['task2', 'task1', 'gt1', 'free'];
const ESSAY_LIMITS = { title: 200, prompt: 5000, body: 50000 };

export function listEssays() {
  return [...mem.essays.values()].filter((e) => !e.deleted).sort((a, b) => b.edited_at - a.edited_at);
}

export function getEssay(id) {
  const e = mem.essays.get(id);
  return e && !e.deleted ? e : null;
}

export function createEssay(task = 'task2') {
  const now = Math.floor(Date.now() / 1000);
  const id = uuid();
  const rec = { id, user_id: meta.uid, title: '', task: ESSAY_TASKS.includes(task) ? task : 'task2', prompt: '', body: '',
    words: 0, created_at: now, edited_at: now, deleted: false };
  setRec('essays', id, rec);
  return rec;
}

/** Yazının alanlarını günceller (title, task, prompt, body, words). */
export function saveEssay(id, patch) {
  const e = getEssay(id);
  if (!e) throw new Error('Yazı bulunamadı.');
  const next = { ...e };
  for (const k of ['title', 'prompt', 'body']) if (k in patch) next[k] = cut(String(patch[k] ?? ''), ESSAY_LIMITS[k]);
  if ('task' in patch && ESSAY_TASKS.includes(patch.task)) next.task = patch.task;
  if ('words' in patch) next.words = Math.max(0, Math.round(Number(patch.words) || 0));
  if (['title', 'task', 'prompt', 'body', 'words'].every((k) => next[k] === e[k])) return e;
  next.edited_at = Math.floor(Date.now() / 1000);
  setRec('essays', id, next);
  return next;
}

export function deleteEssay(id) {
  const e = mem.essays.get(id);
  if (e) setRec('essays', id, { ...e, deleted: true });
}

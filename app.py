"""Kelime — Anki tarzı kelime kartı uygulaması (masaüstü).

Arayüz: ui/ klasöründeki HTML/CSS/JS (pywebview + Edge WebView2).
Veri:   data/kelime.db (SQLite).
"""
import base64
import functools
import hashlib
import json
import os
import random
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta

import webview

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "kelime.db")
UI_DIR = os.path.join(BASE_DIR, "ui")
ICON_PATH = os.path.join(BASE_DIR, "assets", "kelime.ico")
TTS_DIR = os.path.join(DATA_DIR, "tts")

# Microsoft doğal (neural) sesleri — edge-tts ile, internet gerektirir; sonuçlar önbelleğe alınır
TTS_VOICES = {
    "en": "en-GB-SoniaNeural", "de": "de-DE-KatjaNeural", "fr": "fr-FR-DeniseNeural",
    "es": "es-ES-ElviraNeural", "it": "it-IT-ElsaNeural", "nl": "nl-NL-ColetteNeural",
    "pt": "pt-PT-RaquelNeural", "ru": "ru-RU-SvetlanaNeural", "ar": "ar-SA-ZariyahNeural",
    "ja": "ja-JP-NanamiNeural", "zh": "zh-CN-XiaoxiaoNeural", "ko": "ko-KR-SunHiNeural",
    "tr": "tr-TR-EmelNeural",
}
TTS_RATE = "-5%"

# Kart durumları
NEW, LEARNING, REVIEW, RELEARNING = 0, 1, 2, 3

# Zamanlama ayarları (Anki varsayılanlarına yakın)
DAY_CUTOFF_HOUR = 4          # gün sabah 04:00'te döner
LEARN_STEPS = [1, 10]        # dakika
RELEARN_STEPS = [10]         # dakika
GRADUATING_IVL = 1           # gün
EASY_IVL = 4                 # gün
LEARN_AHEAD = 20 * 60        # saniye: başka kart kalmadıysa öğrenme kartlarını öne al
MAX_IVL = 36500

SCHEMA = """
CREATE TABLE IF NOT EXISTS decks(
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    language TEXT NOT NULL DEFAULT 'en',
    new_per_day INTEGER NOT NULL DEFAULT 20,
    direction TEXT NOT NULL DEFAULT 'front',
    created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards(
    id INTEGER PRIMARY KEY,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    word TEXT NOT NULL,
    wkey TEXT NOT NULL,
    translation TEXT NOT NULL DEFAULT '',
    sentence TEXT NOT NULL DEFAULT '',
    synonyms TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}',
    state INTEGER NOT NULL DEFAULT 0,
    due INTEGER NOT NULL DEFAULT 0,
    ivl INTEGER NOT NULL DEFAULT 0,
    ease REAL NOT NULL DEFAULT 2.5,
    step INTEGER NOT NULL DEFAULT 0,
    reps INTEGER NOT NULL DEFAULT 0,
    lapses INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL DEFAULT 0,
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cards_queue ON cards(deck_id, state, due);
CREATE INDEX IF NOT EXISTS idx_cards_wkey ON cards(deck_id, wkey);
CREATE TABLE IF NOT EXISTS revlog(
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL,
    deck_id INTEGER NOT NULL,
    time INTEGER NOT NULL,
    rating INTEGER NOT NULL,
    state_before INTEGER NOT NULL,
    ivl INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revlog_deck ON revlog(deck_id, time);
"""

# JSON içe aktarmada kabul edilen alan adları (küçük harfe çevrilerek eşleştirilir)
FIELD_ALIASES = {
    "word": ("word", "term", "front", "kelime", "wort", "vocabulary", "vocab"),
    "translation": ("translation", "turkish", "tr", "türkçe", "turkce", "meaning", "anlam",
                    "anlamı", "back", "çeviri", "ceviri"),
    "sentence": ("sentence", "sentences", "example", "examples", "example_sentence", "cümle",
                 "cumle", "örnek", "ornek", "satz", "beispiel"),
    "synonyms": ("synonyms", "synonym", "syn", "eş anlamlılar", "eş_anlamlılar", "es_anlamlilar",
                 "eşanlamlılar", "synonyme"),
    "notes": ("notes", "note", "not", "notlar"),
}
ALIAS_TO_FIELD = {a: f for f, aliases in FIELD_ALIASES.items() for a in aliases}


# ---------------------------------------------------------------- yardımcılar

def now_ts():
    return int(time.time())


def day_start(ts):
    """Verilen anın ait olduğu 'çalışma gününün' başlangıcı (04:00)."""
    dt = datetime.fromtimestamp(ts)
    cut = dt.replace(hour=DAY_CUTOFF_HOUR, minute=0, second=0, microsecond=0)
    if dt < cut:
        cut -= timedelta(days=1)
    return int(cut.timestamp())


def word_key(word):
    return " ".join(word.split()).casefold()


def to_text(value, sep=", "):
    if value is None:
        return ""
    if isinstance(value, (list, tuple)):
        return sep.join(str(v).strip() for v in value if v is not None and str(v).strip())
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value).strip()


def to_list(value):
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        items = [str(v).strip() for v in value if v is not None]
    else:
        items = str(value).replace(";", ",").split(",")
    seen, out = set(), []
    for item in (i.strip() for i in items):
        if item and item.casefold() not in seen:
            seen.add(item.casefold())
            out.append(item)
    return out


def normalize_card(raw):
    """JSON'dan gelen tek bir kartı standart alanlara çevirir. Geçersizse None."""
    if not isinstance(raw, dict):
        return None
    out = {"word": "", "translation": "", "sentence": "", "synonyms": [], "notes": "", "extra": {}}
    for key, value in raw.items():
        field = ALIAS_TO_FIELD.get(str(key).strip().casefold())
        if field == "synonyms":
            out["synonyms"] = to_list(value)
        elif field == "sentence":
            out["sentence"] = to_text(value, sep="\n")
        elif field:
            out[field] = to_text(value)
        elif value not in (None, "", [], {}):
            out["extra"][str(key)] = to_text(value)
    out["word"] = " ".join(out["word"].split())
    return out if out["word"] else None


def fmt_seconds(secs):
    secs = max(0, secs)
    if secs < 60:
        return "<1 dk"
    if secs < 3600:
        return f"{round(secs / 60)} dk"
    if secs < 86400:
        return f"{round(secs / 3600)} sa"
    return fmt_days(secs / 86400)


def fmt_days(days):
    if days < 30:
        return f"{round(days)} g"
    if days < 365:
        return f"{days / 30:.1f}".rstrip("0").rstrip(".") + " ay"
    return f"{days / 365:.1f}".rstrip("0").rstrip(".") + " yıl"


def schedule(card, rating, now, fuzz=True):
    """Bir cevaptan sonra kartın yeni zamanlama alanlarını döndürür.
    rating: 1=Tekrar, 2=Zor, 3=İyi, 4=Kolay"""
    state, ivl, ease = card["state"], card["ivl"], card["ease"]
    step, lapses = card["step"], card["lapses"]
    today = day_start(now)

    def to_review(days):
        days = max(1, min(MAX_IVL, days))
        if fuzz and days >= 3:
            days *= random.uniform(0.95, 1.05)
        days = int(round(days))
        return dict(state=REVIEW, due=today + days * 86400, ivl=days, ease=ease, step=0, lapses=lapses)

    def learn(new_state, new_step, secs):
        return dict(state=new_state, due=now + int(secs), ivl=ivl, ease=ease, step=new_step, lapses=lapses)

    if state in (NEW, LEARNING, RELEARNING):
        relearn = state == RELEARNING
        steps = RELEARN_STEPS if relearn else LEARN_STEPS
        st = RELEARNING if relearn else LEARNING
        step = 0 if state == NEW else min(step, len(steps) - 1)
        if rating == 1:
            return learn(st, 0, steps[0] * 60)
        if rating == 2:
            nxt = steps[step + 1] if step + 1 < len(steps) else steps[step] * 1.5
            return learn(st, step, (steps[step] + nxt) / 2 * 60)
        if rating == 3:
            if step + 1 < len(steps):
                return learn(st, step + 1, steps[step + 1] * 60)
            return to_review(ivl if relearn else GRADUATING_IVL)
        return to_review(ivl + 1 if relearn else EASY_IVL)

    # REVIEW
    if rating == 1:
        lapses += 1
        ease = max(1.3, ease - 0.2)
        ivl = max(1, round(ivl * 0.25))
        return learn(RELEARNING, 0, RELEARN_STEPS[0] * 60)
    if rating == 2:
        ease = max(1.3, ease - 0.15)
        return to_review(max(ivl + 1, ivl * 1.2))
    if rating == 3:
        return to_review(max(ivl + 1, ivl * ease))
    days = max(ivl + 2, ivl * ease * 1.3)
    ease += 0.15
    return to_review(days)


def card_dict(row):
    d = dict(row)
    d.pop("wkey", None)
    d["synonyms"] = json.loads(d.get("synonyms") or "[]")
    d["extra"] = json.loads(d.get("extra") or "{}")
    return d


def exposed(fn):
    """API metodunu {ok, data} / {ok, error} zarfına sarar."""
    @functools.wraps(fn)
    def wrapper(self, *args):
        try:
            return {"ok": True, "data": fn(self, *args)}
        except Exception as exc:  # noqa: BLE001 - hatayı arayüze ilet
            return {"ok": False, "error": str(exc) or exc.__class__.__name__}
    return wrapper


# ---------------------------------------------------------------- veritabanı

class Store:
    def __init__(self, path):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self.conn = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self.conn.row_factory = sqlite3.Row
        self.lock = threading.RLock()
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA foreign_keys=ON")
        self.conn.executescript(SCHEMA)

    def rows(self, sql, *args):
        return self.conn.execute(sql, args).fetchall()

    def row(self, sql, *args):
        return self.conn.execute(sql, args).fetchone()

    def scalar(self, sql, *args):
        r = self.conn.execute(sql, args).fetchone()
        return r[0] if r else None

    def run(self, sql, *args):
        return self.conn.execute(sql, args)

    def transaction(self):
        store = self

        class _Tx:
            def __enter__(self):
                store.lock.acquire()
                store.conn.execute("BEGIN")

            def __exit__(self, exc_type, *_):
                try:
                    store.conn.execute("ROLLBACK" if exc_type else "COMMIT")
                finally:
                    store.lock.release()

        return _Tx()


# ---------------------------------------------------------------- arayüz API'si

class Api:
    def __init__(self, store):
        self._db = store
        self._window = None
        self._undo = None  # (kartın önceki hali, revlog id)

    # ---- desteler

    def _deck(self, deck_id):
        d = self._db.row("SELECT * FROM decks WHERE id=?", deck_id)
        if not d:
            raise ValueError("Deste bulunamadı.")
        return d

    def _new_today(self, deck_id, today):
        return self._db.scalar(
            "SELECT COUNT(*) FROM revlog WHERE deck_id=? AND state_before=0 AND time>=?",
            deck_id, today) or 0

    def _counts(self, deck_id, deck=None):
        now = now_ts()
        deck = deck or self._deck(deck_id)
        r = self._db.row(
            """SELECT COUNT(*) total, IFNULL(SUM(state=0),0) new,
                      IFNULL(SUM(state IN (1,3)),0) learn,
                      IFNULL(SUM(state=2 AND due<=?),0) review
               FROM cards WHERE deck_id=?""", now, deck_id)
        new_left = max(0, deck["new_per_day"] - self._new_today(deck_id, day_start(now)))
        return {"total": r["total"], "new": min(r["new"], new_left), "learn": r["learn"], "review": r["review"]}

    @exposed
    def get_decks(self):
        with self._db.lock:
            now = now_ts()
            today = day_start(now)
            counts = {r["deck_id"]: r for r in self._db.rows(
                """SELECT deck_id, COUNT(*) total, SUM(state=0) new, SUM(state IN (1,3)) learn,
                          SUM(state=2 AND due<=?) review
                   FROM cards GROUP BY deck_id""", now)}
            new_today = {r[0]: r[1] for r in self._db.rows(
                "SELECT deck_id, COUNT(*) FROM revlog WHERE state_before=0 AND time>=? GROUP BY deck_id", today)}
            out = []
            for d in self._db.rows("SELECT * FROM decks ORDER BY name COLLATE NOCASE"):
                c = counts.get(d["id"])
                new_left = max(0, d["new_per_day"] - new_today.get(d["id"], 0))
                out.append({**dict(d),
                            "total": c["total"] if c else 0,
                            "new": min(c["new"], new_left) if c else 0,
                            "learn": c["learn"] if c else 0,
                            "review": c["review"] if c else 0})
            return out

    def _clean_deck_fields(self, data):
        fields = {}
        if "name" in data:
            name = " ".join(str(data["name"]).split())
            if not name:
                raise ValueError("Deste adı boş olamaz.")
            fields["name"] = name
        if "language" in data:
            fields["language"] = (str(data["language"]).strip().lower() or "en")[:12]
        if "new_per_day" in data:
            fields["new_per_day"] = max(0, min(9999, int(data["new_per_day"] or 0)))
        if "direction" in data:
            fields["direction"] = data["direction"] if data["direction"] in ("front", "back", "mixed") else "front"
        return fields

    def _check_deck_name(self, name, exclude_id=None):
        for r in self._db.rows("SELECT id, name FROM decks"):
            if r["id"] != exclude_id and r["name"].casefold() == name.casefold():
                raise ValueError(f"“{name}” adında bir deste zaten var.")

    def _create_deck(self, data):
        f = self._clean_deck_fields({"language": "en", "new_per_day": 20, "direction": "front", **data})
        if "name" not in f:
            raise ValueError("Deste adı boş olamaz.")
        self._check_deck_name(f["name"])
        cur = self._db.run(
            "INSERT INTO decks(name, language, new_per_day, direction, created) VALUES (?,?,?,?,?)",
            f["name"], f["language"], f["new_per_day"], f["direction"], now_ts())
        return cur.lastrowid

    @exposed
    def create_deck(self, data):
        with self._db.lock:
            deck_id = self._create_deck(data)
            return dict(self._deck(deck_id))

    @exposed
    def update_deck(self, deck_id, data):
        with self._db.lock:
            self._deck(deck_id)
            f = self._clean_deck_fields(data)
            if "name" in f:
                self._check_deck_name(f["name"], exclude_id=deck_id)
            if f:
                sets = ", ".join(f"{k}=?" for k in f)
                self._db.run(f"UPDATE decks SET {sets} WHERE id=?", *f.values(), deck_id)
            return dict(self._deck(deck_id))

    @exposed
    def delete_deck(self, deck_id):
        with self._db.transaction():
            self._db.run("DELETE FROM revlog WHERE deck_id=?", deck_id)
            self._db.run("DELETE FROM cards WHERE deck_id=?", deck_id)
            self._db.run("DELETE FROM decks WHERE id=?", deck_id)
        self._undo = None
        return True

    @exposed
    def get_deck_stats(self, deck_id):
        with self._db.lock:
            today = day_start(now_ts())
            c = self._db.row(
                """SELECT COUNT(*) total, IFNULL(SUM(state=0),0) new, IFNULL(SUM(state IN (1,3)),0) learning,
                          IFNULL(SUM(state=2 AND ivl<21),0) young, IFNULL(SUM(state=2 AND ivl>=21),0) mature
                   FROM cards WHERE deck_id=?""", deck_id)
            r = self._db.row(
                "SELECT COUNT(*) n, IFNULL(SUM(rating>1),0) ok FROM revlog WHERE deck_id=? AND time>=?",
                deck_id, today)
            return {**dict(c), "today": r["n"], "today_correct": round(100 * r["ok"] / r["n"]) if r["n"] else 0}

    # ---- kartlar

    @exposed
    def list_cards(self, deck_id, query="", limit=1000):
        with self._db.lock:
            where, args = "deck_id=?", [deck_id]
            q = (query or "").strip()
            if q:
                like = "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
                where += (" AND (word LIKE ? ESCAPE '\\' OR translation LIKE ? ESCAPE '\\'"
                          " OR synonyms LIKE ? ESCAPE '\\' OR sentence LIKE ? ESCAPE '\\')")
                args += [like] * 4
            total = self._db.scalar(f"SELECT COUNT(*) FROM cards WHERE {where}", *args)
            rows = self._db.rows(
                f"SELECT * FROM cards WHERE {where} ORDER BY position, id LIMIT ?", *args, int(limit))
            return {"total": total, "cards": [card_dict(r) for r in rows]}

    @exposed
    def save_card(self, data):
        word = " ".join(str(data.get("word", "")).split())
        if not word:
            raise ValueError("Kelime boş olamaz.")
        key = word_key(word)
        synonyms = to_list(data.get("synonyms"))
        extra = {str(k).strip(): str(v).strip() for k, v in (data.get("extra") or {}).items() if str(k).strip()}
        values = (word, key, to_text(data.get("translation")), to_text(data.get("sentence"), sep="\n"),
                  json.dumps(synonyms, ensure_ascii=False), to_text(data.get("notes")),
                  json.dumps(extra, ensure_ascii=False))
        now = now_ts()
        with self._db.transaction():
            card_id = data.get("id")
            if card_id:
                deck_id = self._db.scalar("SELECT deck_id FROM cards WHERE id=?", card_id)
                if deck_id is None:
                    raise ValueError("Kart bulunamadı.")
            else:
                deck_id = data.get("deck_id")
                self._deck(deck_id)
            dup = self._db.scalar("SELECT id FROM cards WHERE deck_id=? AND wkey=? AND id<>?",
                                  deck_id, key, card_id or 0)
            if dup:
                raise ValueError(f"“{word}” bu destede zaten var.")
            if card_id:
                self._db.run(
                    """UPDATE cards SET word=?, wkey=?, translation=?, sentence=?, synonyms=?, notes=?, extra=?,
                       updated=? WHERE id=?""", *values, now, card_id)
            else:
                pos = (self._db.scalar("SELECT MAX(position) FROM cards WHERE deck_id=?", deck_id) or 0) + 1
                card_id = self._db.run(
                    """INSERT INTO cards(word, wkey, translation, sentence, synonyms, notes, extra,
                       deck_id, position, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                    *values, deck_id, pos, now, now).lastrowid
        return card_dict(self._db.row("SELECT * FROM cards WHERE id=?", card_id))

    @exposed
    def delete_cards(self, ids):
        ids = [int(i) for i in ids]
        if ids:
            marks = ",".join("?" * len(ids))
            with self._db.transaction():
                self._db.run(f"DELETE FROM revlog WHERE card_id IN ({marks})", *ids)
                self._db.run(f"DELETE FROM cards WHERE id IN ({marks})", *ids)
        self._undo = None
        return len(ids)

    @exposed
    def reset_cards(self, ids):
        ids = [int(i) for i in ids]
        if ids:
            marks = ",".join("?" * len(ids))
            self._db.run(
                f"""UPDATE cards SET state=0, due=0, ivl=0, ease=2.5, step=0, reps=0, lapses=0, updated=?
                    WHERE id IN ({marks})""", now_ts(), *ids)
        self._undo = None
        return len(ids)

    @exposed
    def move_cards(self, ids, target_deck_id):
        ids = [int(i) for i in ids]
        with self._db.transaction():
            self._deck(target_deck_id)
            marks = ",".join("?" * len(ids))
            movable = [r[0] for r in self._db.rows(
                f"""SELECT id FROM cards c WHERE id IN ({marks}) AND NOT EXISTS
                    (SELECT 1 FROM cards o WHERE o.deck_id=? AND o.wkey=c.wkey)""", *ids, target_deck_id)]
            if movable:
                m = ",".join("?" * len(movable))
                self._db.run(f"UPDATE cards SET deck_id=? WHERE id IN ({m})", target_deck_id, *movable)
                self._db.run(f"UPDATE revlog SET deck_id=? WHERE card_id IN ({m})", target_deck_id, *movable)
        self._undo = None
        return {"moved": len(movable), "skipped": len(ids) - len(movable)}

    # ---- içe / dışa aktarma

    @exposed
    def pick_import_file(self):
        res = self._window.create_file_dialog(
            webview.FileDialog.OPEN, allow_multiple=False,
            file_types=("JSON dosyaları (*.json)", "Tüm dosyalar (*.*)"))
        if not res:
            return None
        path = res[0] if isinstance(res, (list, tuple)) else res
        with open(path, encoding="utf-8-sig") as f:
            return {"name": os.path.basename(path), "text": f.read()}

    @exposed
    def import_cards(self, target, raw_cards):
        """target: {"deck_id": id} ya da {"name": ..., "language": ...} (aynı isimli deste varsa ona ekler)."""
        if not isinstance(raw_cards, list):
            raise ValueError("Kart listesi bulunamadı.")
        cards = [c for c in (normalize_card(r) for r in raw_cards) if c]
        skipped = len(raw_cards) - len(cards)
        added = updated = 0
        now = now_ts()
        with self._db.transaction():
            deck_id = target.get("deck_id")
            if deck_id:
                self._deck(deck_id)
            else:
                name = " ".join(str(target.get("name") or "").split()) or "İçe aktarılan"
                existing = next((r["id"] for r in self._db.rows("SELECT id, name FROM decks")
                                 if r["name"].casefold() == name.casefold()), None)
                deck_id = existing or self._create_deck({"name": name, "language": target.get("language") or "en"})
            known = {r["wkey"]: r["id"] for r in self._db.rows("SELECT id, wkey FROM cards WHERE deck_id=?", deck_id)}
            pos = self._db.scalar("SELECT MAX(position) FROM cards WHERE deck_id=?", deck_id) or 0
            for c in cards:
                key = word_key(c["word"])
                syn = json.dumps(c["synonyms"], ensure_ascii=False)
                extra = json.dumps(c["extra"], ensure_ascii=False)
                if key in known:
                    # Var olan kartın içeriğini güncelle (boş gelen alanlar eskisini korur),
                    # çalışma ilerlemesine dokunma
                    self._db.run(
                        """UPDATE cards SET word=?, translation=COALESCE(NULLIF(?, ''), translation),
                           sentence=COALESCE(NULLIF(?, ''), sentence), synonyms=COALESCE(NULLIF(?, '[]'), synonyms),
                           notes=COALESCE(NULLIF(?, ''), notes), extra=COALESCE(NULLIF(?, '{}'), extra), updated=?
                           WHERE id=?""",
                        c["word"], c["translation"], c["sentence"], syn, c["notes"], extra, now, known[key])
                    updated += 1
                else:
                    pos += 1
                    known[key] = self._db.run(
                        """INSERT INTO cards(deck_id, word, wkey, translation, sentence, synonyms, notes, extra,
                           position, created, updated) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                        deck_id, c["word"], key, c["translation"], c["sentence"], syn, c["notes"], extra,
                        pos, now, now).lastrowid
                    added += 1
        return {"deck_id": deck_id, "added": added, "updated": updated, "skipped": skipped}

    @exposed
    def export_deck(self, deck_id):
        with self._db.lock:
            deck = self._deck(deck_id)
            cards = []
            for r in self._db.rows("SELECT * FROM cards WHERE deck_id=? ORDER BY position, id", deck_id):
                c = card_dict(r)
                item = {"word": c["word"], "translation": c["translation"],
                        "sentence": c["sentence"], "synonyms": c["synonyms"]}
                if c["notes"]:
                    item["notes"] = c["notes"]
                item.update(c["extra"])
                cards.append(item)
        safe = "".join(ch if ch.isalnum() or ch in " -_" else "_" for ch in deck["name"]).strip() or "deste"
        res = self._window.create_file_dialog(
            webview.FileDialog.SAVE, save_filename=f"{safe}.json", file_types=("JSON dosyaları (*.json)",))
        if not res:
            return None
        path = res[0] if isinstance(res, (list, tuple)) else res
        if not path.lower().endswith(".json"):
            path += ".json"
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"deck": deck["name"], "language": deck["language"], "cards": cards},
                      f, ensure_ascii=False, indent=2)
        return path

    # ---- seslendirme

    @exposed
    def tts(self, text, lang):
        """Metni dilin doğal sesiyle seslendirir; mp3'ü data URL olarak döndürür."""
        text = " ".join(str(text or "").split())
        voice = TTS_VOICES.get(str(lang or "").lower().split("-")[0])
        if not text or not voice:
            return None
        name = hashlib.sha1(f"{voice}|{TTS_RATE}|{text}".encode("utf-8")).hexdigest() + ".mp3"
        path = os.path.join(TTS_DIR, name)
        if not os.path.isfile(path):
            import asyncio
            import edge_tts

            async def fetch():
                data = bytearray()
                async for chunk in edge_tts.Communicate(text, voice, rate=TTS_RATE).stream():
                    if chunk["type"] == "audio":
                        data += chunk["data"]
                return bytes(data)

            audio = asyncio.run(fetch())
            if not audio:
                raise RuntimeError("Ses alınamadı.")
            os.makedirs(TTS_DIR, exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(audio)
            os.replace(tmp, path)
        with open(path, "rb") as f:
            return "data:audio/mpeg;base64," + base64.b64encode(f.read()).decode("ascii")

    # ---- çalışma

    def _payload(self, deck_id, card, deck=None):
        now = now_ts()
        counts = self._counts(deck_id, deck)
        if card is None:
            nxt = self._db.scalar("SELECT MIN(due) FROM cards WHERE deck_id=? AND state IN (1,3)", deck_id)
            return {"card": None, "counts": counts, "next_due": nxt, "now": now}
        previews = {}
        for rating in (1, 2, 3, 4):
            res = schedule(card, rating, now, fuzz=False)
            previews[rating] = fmt_days(res["ivl"]) if res["state"] == REVIEW else fmt_seconds(res["due"] - now)
        return {"card": card_dict(card), "counts": counts, "previews": previews, "now": now}

    def _next(self, deck_id):
        db = self._db
        deck = self._deck(deck_id)
        now = now_ts()
        card = db.row("SELECT * FROM cards WHERE deck_id=? AND state IN (1,3) AND due<=? ORDER BY due LIMIT 1",
                      deck_id, now)
        if not card:
            n_review = db.scalar("SELECT COUNT(*) FROM cards WHERE deck_id=? AND state=2 AND due<=?", deck_id, now)
            new_left = max(0, deck["new_per_day"] - self._new_today(deck_id, day_start(now)))
            n_new = min(new_left, db.scalar("SELECT COUNT(*) FROM cards WHERE deck_id=? AND state=0", deck_id))
            if n_new and (not n_review or random.random() < n_new / (n_new + n_review)):
                card = db.row("SELECT * FROM cards WHERE deck_id=? AND state=0 ORDER BY position, id LIMIT 1",
                              deck_id)
            elif n_review:
                card = db.row("""SELECT * FROM cards WHERE deck_id=? AND state=2 AND due<=?
                                 ORDER BY due, RANDOM() LIMIT 1""", deck_id, now)
        if not card:
            card = db.row("SELECT * FROM cards WHERE deck_id=? AND state IN (1,3) AND due<=? ORDER BY due LIMIT 1",
                          deck_id, now + LEARN_AHEAD)
        return self._payload(deck_id, card, deck)

    @exposed
    def next_card(self, deck_id):
        with self._db.lock:
            return self._next(deck_id)

    @exposed
    def answer(self, card_id, rating, deck_id):
        rating = int(rating)
        if rating not in (1, 2, 3, 4):
            raise ValueError("Geçersiz cevap.")
        now = now_ts()
        with self._db.transaction():
            card = self._db.row("SELECT * FROM cards WHERE id=?", card_id)
            if not card:
                raise ValueError("Kart bulunamadı.")
            upd = schedule(card, rating, now)
            log_id = self._db.run(
                "INSERT INTO revlog(card_id, deck_id, time, rating, state_before, ivl) VALUES (?,?,?,?,?,?)",
                card_id, card["deck_id"], now, rating, card["state"], upd["ivl"]).lastrowid
            self._db.run(
                """UPDATE cards SET state=?, due=?, ivl=?, ease=?, step=?, lapses=?, reps=reps+1, updated=?
                   WHERE id=?""",
                upd["state"], upd["due"], upd["ivl"], upd["ease"], upd["step"], upd["lapses"], now, card_id)
            self._undo = (dict(card), log_id)
        with self._db.lock:
            return self._next(deck_id)

    @exposed
    def undo(self, deck_id):
        if not self._undo:
            raise ValueError("Geri alınacak bir cevap yok.")
        snap, log_id = self._undo
        with self._db.transaction():
            self._db.run(
                "UPDATE cards SET state=?, due=?, ivl=?, ease=?, step=?, lapses=?, reps=? WHERE id=?",
                snap["state"], snap["due"], snap["ivl"], snap["ease"], snap["step"], snap["lapses"],
                snap["reps"], snap["id"])
            self._db.run("DELETE FROM revlog WHERE id=?", log_id)
        self._undo = None
        with self._db.lock:
            card = self._db.row("SELECT * FROM cards WHERE id=?", snap["id"])
            if card["deck_id"] != deck_id:
                return self._next(deck_id)
            return self._payload(deck_id, card)


# ---------------------------------------------------------------- başlatma

def system_dark():
    try:
        import winreg
        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER,
                             r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        return winreg.QueryValueEx(key, "AppsUseLightTheme")[0] == 0
    except OSError:
        return False


def main():
    if sys.platform == "win32":
        # Görev çubuğunda python simgesi yerine uygulamanın kendi simgesi görünsün
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("Kelime.App")
    api = Api(Store(DB_PATH))
    window = webview.create_window(
        "Kelime",
        url=os.path.join(UI_DIR, "index.html"),
        js_api=api,
        width=1200, height=800, min_size=(820, 560),
        background_color="#14161b" if system_dark() else "#f5f6f8",
        text_select=True,
    )
    api._window = window
    webview.start(private_mode=False, storage_path=os.path.join(DATA_DIR, "webview"),
                  icon=ICON_PATH, debug="--debug" in sys.argv)


if __name__ == "__main__":
    main()

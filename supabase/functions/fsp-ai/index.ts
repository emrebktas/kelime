// Kelime: Fachsprachprüfung (FSP) Zahnmedizin alıştırmaları için yapay zekâ (Google Gemini vekili)
//
// Gemini anahtarı sadece burada, Supabase'in gizli değişkenlerinde (GEMINI_API_KEY) durur;
// uygulamaya, depoya ya da APK'ya hiç inmez. Sadece giriş yapmış kullanıcılar çağırabilir.
// Model GEMINI_MODEL gizli değişkeniyle değiştirilebilir.
//
// İstek: POST { action, ... }
//   patient   { case, history }                 → { reply }           Teil 1: simüle hasta
//   oberarzt  { case, history }                 → { reply, done }     Teil 3: simüle Oberarzt
//   evaluate  { part, case, history | brief, konjunktiv } → { report } değerlendirme
//   case      { fachgebiet, hint }              → { case }            yeni (uydurma) vaka

import { createClient } from 'npm:@supabase/supabase-js@2';

const MODEL = Deno.env.get('GEMINI_MODEL') ?? 'gemini-3.8-flash';
// GEMINI_BASE_URL sadece yerel testte sahte sunucuya yönlendirmek için
const GEMINI_BASE = Deno.env.get('GEMINI_BASE_URL') ?? 'https://generativelanguage.googleapis.com';
const GEMINI_URL = (model: string) => `${GEMINI_BASE}/v1beta/models/${model}:generateContent`;
const DAILY_LIMIT = Number(Deno.env.get('FSP_DAILY_LIMIT') ?? 600); // kişi başı, son 24 saatte birim
const COST = { turn: 1, evaluate: 8, case: 6 };
const MAX_TURNS = 80;
const MAX_MSG = 3000;

const ALLOWED_ORIGINS = [
  'https://emrebktas.github.io', // web
  'https://localhost', // Android uygulaması (Capacitor)
  'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174', // geliştirme
];

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max: number, each = 300) =>
  (Array.isArray(v) ? v : []).map((x) => str(x, each)).filter(Boolean).slice(0, max);

type Turn = { role: 'user' | 'model'; text: string };
type Case = Record<string, unknown>;

/** İstemciden gelen vakayı sınırlar içinde okur (gizli bilgiler dahil; vaka uygulamanın kendi verisidir). */
function readCase(raw: unknown): Case | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const p = (c.patient && typeof c.patient === 'object' ? c.patient : {}) as Record<string, unknown>;
  const e = (c.expected && typeof c.expected === 'object' ? c.expected : {}) as Record<string, unknown>;
  const out = {
    title: str(c.title, 200),
    fachgebiet: str(c.fachgebiet, 80),
    patient: { name: str(p.name, 80), age: Number(p.age) || 0, sex: str(p.sex, 10), job: str(p.job, 80) },
    complaint: str(c.complaint, 400),
    greeting: str(c.greeting, 600),
    facts: str(c.facts, 4000),
    worry: str(c.worry, 400),
    xray: str(c.xray, 1500),
    expected: {
      diagnosis: str(e.diagnosis, 400),
      differential: list(e.differential, 8),
      diagnostics: list(e.diagnostics, 10),
      therapy: list(e.therapy, 12),
      anamnesis: list(e.anamnesis, 30),
      risks: list(e.risks, 10),
    },
    questions: list(c.questions, 14, 400),
  };
  return out.facts ? out : null;
}

function readHistory(raw: unknown): Turn[] {
  return (Array.isArray(raw) ? raw : []).slice(-MAX_TURNS).map((t) => {
    const r = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
    return { role: r.role === 'model' ? 'model' : 'user', text: str(r.text, MAX_MSG) } as Turn;
  }).filter((t) => t.text);
}

const transcript = (h: Turn[], me: string, other: string) =>
  h.map((t) => `${t.role === 'user' ? me : other}: ${t.text}`).join('\n');

const caseSheet = (c: Case) => {
  const p = c.patient as Record<string, unknown>;
  const e = c.expected as Record<string, unknown>;
  return `Fall: ${c.title} (${c.fachgebiet})
Patient: ${p.name}, ${p.age} Jahre, ${p.job}
Anlass: ${c.complaint}
Fakten (vollständig):
${c.facts}
Sorge des Patienten: ${c.worry}
Röntgenbefund/Befund: ${c.xray}
Erwartete Verdachtsdiagnose: ${e.diagnosis}
Differentialdiagnosen: ${(e.differential as string[]).join('; ')}
Weitere Diagnostik: ${(e.diagnostics as string[]).join('; ')}
Therapie: ${(e.therapy as string[]).join('; ')}
Pflichtpunkte der Anamnese: ${(e.anamnesis as string[]).join('; ')}
Risiken/Aufklärungspunkte: ${(e.risks as string[]).join('; ')}`;
};

/* ------------------------------------------------------------------ istemler */

const patientPrompt = (c: Case) => {
  const p = c.patient as Record<string, unknown>;
  return `Du spielst in einer Übung zur Fachsprachprüfung Zahnmedizin einen Patienten in einer deutschen Zahnarztpraxis.
Der Nutzer ist die Zahnärztin / der Zahnarzt und führt mit dir das Anamnese- und Aufklärungsgespräch.

Deine Rolle: ${p.name}, ${p.age} Jahre, ${p.job}.
Grund des Besuchs: ${c.complaint}
Alles, was du über dich weißt (nur auf Nachfrage preisgeben):
${c.facts}
Deine Sorge: ${c.worry}

Regeln:
- Sprich natürliches, gesprochenes Alltagsdeutsch, wie ein echter Patient. 1–3 kurze Sätze. Keine Listen, kein Markdown.
- Beantworte nur, was gefragt wird. Gib keine Informationen von dir aus preis, die nicht erfragt wurden.
- Du kennst keine Fachbegriffe. Benutzt die Zahnärztin einen Fachbegriff (z. B. "Analgetika", "Perkussion", "Antikoagulanzien", "Pulpitis", "anamnestisch"), verstehst du ihn nicht und fragst nach ("Was heißt das?", "Wie meinen Sie das?").
- Ist eine Frage unklar oder grammatisch so falsch, dass man sie nicht versteht, frag nach.
- Was nicht in deinen Fakten steht, verneinst du oder sagst, dass du es nicht weißt. Erfinde keine neuen Krankheiten oder Medikamente.
- Medikamente kennst du oft nur ungefähr ("so eine Tablette für den Blutdruck, ich glaube Ramipril").
- Wenn die Zahnärztin erklärt, was sie vorhat, stellst du passend zu deiner Sorge ein bis zwei Rückfragen.
- Du bist nie die Ärztin, stellst keine Diagnose und gibst keine Tipps zur Prüfung.
- Verabschiedet sich die Zahnärztin, verabschiedest du dich auch.`;
};

const oberarztPrompt = (c: Case) => `Du bist Oberärztin/Oberarzt in einer deutschen Zahnklinik und Prüfer/in im Teil 3 der Fachsprachprüfung (Arzt-Arzt-Gespräch).
Der Nutzer hat den folgenden Patienten gesehen und stellt ihn dir jetzt vor.

${caseSheet(c)}

Geplante Rückfragen (in sinnvoller Reihenfolge, frei formuliert stellen):
${(c.questions as string[]).map((q, i) => `${i + 1}. ${q}`).join('\n') || '- Verdachtsdiagnose, Differentialdiagnosen, weitere Diagnostik, Therapie, Risiken, Aufklärung'}

Ablauf und Regeln:
- Lass den Kandidaten zuerst den Fall vorstellen. Ist die Vorstellung sehr knapp, bitte um eine strukturierte Vorstellung.
- Stelle danach immer nur EINE Frage pro Nachricht, kurz, in kollegialer Fachsprache, Sie-Form.
- Frage nach fehlenden Angaben aus der Anamnese, nach der Verdachtsdiagnose und Begründung, Differentialdiagnosen, weiterer Diagnostik, Therapieplan, Risiken und Aufklärung.
- Bitte ein- bis zweimal darum, einen Fachbegriff so zu erklären, wie man ihn dem Patienten in einfachen Worten sagen würde.
- Gib keine Bewertung und keine Lösungen, korrigiere nicht. Kurze Reaktionen wie "Gut." oder "Verstehe." sind erlaubt.
- Insgesamt etwa 6–9 Fragen. Wenn alles besprochen ist, bedanke dich, beende das Gespräch und schreibe am Ende genau: [ENDE]
- Kein Markdown.`;

const REPORT_SHAPE = `{
 "gesamt": 0-100,
 "ergebnis": "bestanden" | "knapp" | "nicht bestanden",
 "fazit": "2-4 Sätze auf Türkisch",
 "kategorien": [{"name": "...", "punkte": 0-100, "kommentar": "Türkisch, 1-2 Sätze"}],
 "fehlend": ["fehlende Pflichtpunkte, auf Deutsch"],
 "korrekturen": [{"original": "wörtlich aus dem Text", "korrigiert": "korrekte deutsche Fassung", "typ": "Grammatik|Wortwahl|Fachsprache|Register|Konjunktiv|Rechtschreibung", "erklaerung": "kurz auf Türkisch"}],
 "besser": [{"statt": "...", "besser": "...", "warum": "kurz auf Türkisch"}],
 "staerken": ["Türkisch"],
 "vokabeln": [{"de": "nützlicher Fachbegriff oder Redemittel mit Artikel", "tr": "Türkisch"}]
}`;

function evaluatePrompt(part: number, c: Case, konjunktiv: boolean) {
  const common = `Du bist strenge/r, faire/r Prüfer/in der Fachsprachprüfung Zahnmedizin (Niveau B2–C1) einer deutschen Landeszahnärztekammer.
Bewerte die Leistung eines ausländischen Zahnarztes/einer Zahnärztin. Bewertet wird die Sprache und die kommunikative Leistung; das Fachwissen wird vorausgesetzt, Fehler darin werden aber genannt.
Erklärungen und Kommentare schreibst du auf Türkisch, Korrekturen und Formulierungen auf Deutsch.

${caseSheet(c)}

Antworte NUR mit gültigem JSON in genau dieser Form (keine Erklärung, kein Codeblock):
${REPORT_SHAPE}
- "korrekturen": bis zu 20 echte Fehler, wörtlich zitiert; keine erfundenen Fehler. Bei fehlerfreiem Text weniger Einträge.
- "besser": 3–6 Vorschläge für natürlichere oder präzisere Formulierungen.
- "vokabeln": 5–10 Begriffe/Redemittel, die in diesem Fall nützlich gewesen wären.
- "ergebnis": ab 70 bestanden, 60–69 knapp, darunter nicht bestanden.`;
  if (part === 1) {
    return `${common}

Teil 1: Anamnese- und Aufklärungsgespräch mit dem Patienten (simuliert). Bewerte die Äußerungen der Zahnärztin/des Zahnarztes.
"kategorien" genau: Sprache (Grammatik, Wortwahl) · Anamnese (Vollständigkeit) · Aufklärung (Verdacht, Diagnostik, Therapie, Risiken in einfachen Worten) · Kommunikation (Empathie, Sie-Form, Umgangssprache statt Fachbegriffen, Nachfragen) · Gesprächsstruktur (Begrüßung, Ablauf, Zusammenfassung, Abschluss).
"fehlend": alle Pflichtpunkte der Anamnese und Aufklärung, die nicht oder nur ungenau erfragt/erklärt wurden.
"besser": vor allem Fragen, die präziser oder patientengerechter gestellt werden könnten.`;
  }
  if (part === 2) {
    return `${common}

Teil 2: schriftlicher Arztbrief/Befundbericht an eine Kollegin/einen Kollegen mit vier Abschnitten: Aktuelle Anamnese, Allgemeinanamnese, Röntgenbefund, Therapieplan.
${konjunktiv
    ? 'Die Anamneseabschnitte sollen in indirekter Rede (Konjunktiv I, ersatzweise Konjunktiv II) stehen ("Der Patient berichtete, er habe seit drei Tagen Schmerzen."). Fehler in der indirekten Rede sind als Typ "Konjunktiv" zu korrigieren.'
    : 'Indirekte Rede ist nicht gefordert; Indikativ ist erlaubt.'}
Fachsprache, Passiv/Nominalstil und vollständige Sätze werden erwartet.
"kategorien" genau: Aktuelle Anamnese · Allgemeinanamnese · Röntgenbefund · Therapieplan · Sprache (Grammatik, Rechtschreibung)${konjunktiv ? ' · Indirekte Rede' : ''} · Fachsprache und Stil.
"fehlend": wichtige Inhalte, die im Brief fehlen.
Zusätzlich das Feld "abschnitte": [{"name": "Aktuelle Anamnese|Allgemeinanamnese|Röntgenbefund|Therapieplan", "verbessert": "vollständig korrigierte, stilistisch gute Fassung des Abschnitts des Kandidaten (Deutsch)"}].`;
  }
  return `${common}

Teil 3: Arzt-Arzt-Gespräch. Der Kandidat stellt den Fall einer Oberärztin/einem Oberarzt vor und beantwortet Rückfragen. Bewerte nur die Äußerungen des Kandidaten.
"kategorien" genau: Fallvorstellung (Struktur, Vollständigkeit) · Fachsprache · Diagnose und Differentialdiagnosen · Therapie und Diagnostik · Rückfragen beantworten (Präzision, Flüssigkeit) · Sprache (Grammatik).
"fehlend": Inhalte, die in der Vorstellung oder den Antworten fehlten oder falsch waren.`;
}

const CASE_SHAPE = `{
 "title": "Verdachtsdiagnose als kurzer Titel",
 "fachgebiet": "Endodontie|Parodontologie|Oralchirurgie|Prothetik|Funktionsdiagnostik|Kinderzahnheilkunde|Implantologie|Kieferorthopädie|Zahnerhaltung",
 "patient": {"name": "Frau/Herr Nachname (erfunden)", "age": 18-90, "sex": "w|m", "job": "Beruf"},
 "complaint": "Anlass in einem Satz",
 "greeting": "erster Satz des Patienten in Umgangssprache",
 "facts": "8-14 Zeilen: Name, Alter, Beruf; Beschwerden (Lokalisation, Beginn, Charakter, Intensität 0-10, Auslöser, Verlauf, Ausstrahlung, Begleitsymptome); bisherige Maßnahmen und Schmerzmittel mit Dosis; Vorerkrankungen; Medikamente mit Dosis; Allergien mit Reaktion; Voroperationen; Noxen (Rauchen, Alkohol); Sozialanamnese; Familienanamnese; letzter Zahnarztbesuch; zahnmedizinische Vorgeschichte",
 "worry": "Sorge/Frage des Patienten",
 "xray": "Röntgen- bzw. klinischer Befund in Fachsprache (OPG/Zahnfilm), wie er dem Kandidaten vorgelegt wird",
 "expected": {
   "diagnosis": "Verdachtsdiagnose mit Zahn",
   "differential": ["..."], "diagnostics": ["..."], "therapy": ["..."],
   "anamnesis": ["8-14 Pflichtpunkte der Anamnese für diesen Fall"],
   "risks": ["Aufklärungs- und Risikopunkte"]
 },
 "questions": ["6-8 Rückfragen der Oberärztin für Teil 3"]
}`;

/* ------------------------------------------------------------------ Gemini */

type GeminiOpts = { system: string; turns: Turn[]; json?: boolean; maxTokens: number; temperature: number; timeoutMs: number; think?: string };

async function callGemini(apiKey: string, o: GeminiOpts): Promise<{ text?: string; error?: string; status?: number }> {
  const send = async (withThinking: boolean) => {
    const body = {
      systemInstruction: { parts: [{ text: o.system }] },
      contents: o.turns.map((t) => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: {
        temperature: o.temperature,
        maxOutputTokens: o.maxTokens,
        ...(o.json ? { responseMimeType: 'application/json' } : {}),
        ...(withThinking && o.think ? { thinkingConfig: { thinkingLevel: o.think } } : {}),
      },
    };
    return await fetch(GEMINI_URL(MODEL), {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
  };
  let res: Response;
  try {
    res = await send(true);
    // Model düşünme ayarını tanımıyorsa ayarsız tekrar dene
    if (res.status === 400 && o.think) {
      const t = await res.clone().text();
      if (/thinking/i.test(t)) res = await send(false);
    }
  } catch {
    return { error: 'Yapay zekâ zamanında cevap vermedi. Tekrar dene.', status: 504 };
  }
  if (!res.ok) {
    const detail = await res.text();
    console.error('Gemini hata', MODEL, res.status, detail.slice(0, 800));
    if (res.status === 429) return { error: 'Gemini kotası doldu ya da servis yoğun. Biraz sonra tekrar dene.', status: 429 };
    if (res.status === 404) return { error: `Gemini modeli bulunamadı (${MODEL}). GEMINI_MODEL ayarını kontrol et.`, status: 502 };
    if (res.status === 400 && /api key/i.test(detail)) return { error: 'Gemini API anahtarı geçersiz (GEMINI_API_KEY).', status: 502 };
    if (res.status === 403) return { error: 'Gemini API anahtarının bu modele erişimi yok.', status: 502 };
    return { error: 'Yapay zekâ servisine ulaşılamadı.', status: 502 };
  }
  const data = await res.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p: Record<string, unknown>) => !p.thought && typeof p.text === 'string')
    .map((p: Record<string, unknown>) => p.text).join('').trim();
  if (!text) {
    const why = cand?.finishReason || data.promptFeedback?.blockReason || 'boş cevap';
    return { error: `Yapay zekâ cevap üretmedi (${why}). Tekrar dene.`, status: 502 };
  }
  return { text };
}

function parseJson(text: string): Record<string, unknown> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/* ------------------------------------------------------------------ rapor temizliği */

const num = (v: unknown) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
const objs = (v: unknown, max: number) =>
  (Array.isArray(v) ? v : []).filter((x) => x && typeof x === 'object').slice(0, max) as Record<string, unknown>[];

function cleanReport(r: Record<string, unknown>, part: number) {
  const gesamt = num(r.gesamt);
  const ergebnis = ['bestanden', 'knapp', 'nicht bestanden'].includes(String(r.ergebnis))
    ? String(r.ergebnis) : gesamt >= 70 ? 'bestanden' : gesamt >= 60 ? 'knapp' : 'nicht bestanden';
  return {
    part,
    gesamt,
    ergebnis,
    fazit: str(r.fazit, 1500),
    kategorien: objs(r.kategorien, 10).map((k) => ({ name: str(k.name, 80), punkte: num(k.punkte), kommentar: str(k.kommentar, 600) })).filter((k) => k.name),
    fehlend: list(r.fehlend, 30, 300),
    korrekturen: objs(r.korrekturen, 25).map((k) => ({
      original: str(k.original, 500), korrigiert: str(k.korrigiert, 500), typ: str(k.typ, 40), erklaerung: str(k.erklaerung, 500),
    })).filter((k) => k.original && k.korrigiert),
    besser: objs(r.besser, 10).map((k) => ({ statt: str(k.statt, 400), besser: str(k.besser, 400), warum: str(k.warum, 400) })).filter((k) => k.besser),
    staerken: list(r.staerken, 8, 400),
    vokabeln: objs(r.vokabeln, 14).map((k) => ({ de: str(k.de, 120), tr: str(k.tr, 160) })).filter((k) => k.de),
    abschnitte: objs(r.abschnitte, 4).map((k) => ({ name: str(k.name, 60), verbessert: str(k.verbessert, 4000) })).filter((k) => k.verbessert),
  };
}

function cleanCase(r: Record<string, unknown>) {
  const c = readCase({ ...r, questions: r.questions });
  if (!c || !c.title) return null;
  return c;
}

/* ------------------------------------------------------------------ sunucu */

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply({ error: 'Sadece POST.' }, 405);

  const apiKey = Deno.env.get('GEMINI_API_KEY');
  if (!apiKey) return reply({ error: 'Sunucuda GEMINI_API_KEY tanımlı değil.' }, 500);

  // Sadece gerçek, giriş yapmış kullanıcılar
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (authError || !user) return reply({ error: 'Bu özellik için giriş yapman gerekiyor.' }, 401);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: 'Geçersiz istek.' }, 400); }

  // Kişi başı günlük sınır (Gemini kotasını korur)
  const useQuota = async (units: number): Promise<Response | null> => {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: usage, error } = await admin.from('fsp_usage').select('units').eq('user_id', user.id).gte('at', since);
    if (error) {
      console.error('fsp_usage', error);
      return reply({ error: 'Kullanım bilgisi okunamadı (FSP SQL dosyası çalıştırıldı mı?).' }, 500);
    }
    const used = (usage ?? []).reduce((a, r) => a + (r.units as number), 0);
    if (used + units > DAILY_LIMIT) return reply({ error: 'Günlük FSP yapay zekâ sınırına ulaştın. Yarın tekrar dene.' }, 429);
    await admin.from('fsp_usage').insert({ user_id: user.id, units });
    return null;
  };
  const fail = (r: { error?: string; status?: number }) => reply({ error: r.error }, r.status ?? 502);

  const action = String(body.action ?? '');

  if (action === 'patient' || action === 'oberarzt') {
    const c = readCase(body.case);
    if (!c) return reply({ error: 'Vaka bilgisi eksik.' }, 400);
    const history = readHistory(body.history);
    if (action === 'patient' && !history.length) return reply({ reply: c.greeting || 'Guten Tag.' });
    const quota = await useQuota(COST.turn);
    if (quota) return quota;
    // Gemini sohbeti kullanıcı mesajıyla başlamalı
    const turns = history[0]?.role === 'model' ? [{ role: 'user', text: '(Gespräch beginnt)' } as Turn, ...history] : history;
    if (!turns.length) turns.push({ role: 'user', text: '(Der Kandidat ist bereit.)' });
    const r = await callGemini(apiKey, {
      system: action === 'patient' ? patientPrompt(c) : oberarztPrompt(c),
      turns, maxTokens: 600, temperature: action === 'patient' ? 0.7 : 0.5, timeoutMs: 45_000, think: 'low',
    });
    if (!r.text) return fail(r);
    const done = /\[ENDE\]/.test(r.text);
    return reply({ reply: r.text.replace(/\[ENDE\]/g, '').trim().slice(0, 2000), done });
  }

  if (action === 'evaluate') {
    const c = readCase(body.case);
    if (!c) return reply({ error: 'Vaka bilgisi eksik.' }, 400);
    const part = [1, 2, 3].includes(Number(body.part)) ? Number(body.part) : 1;
    let material = '';
    if (part === 2) {
      const b = (body.brief && typeof body.brief === 'object' ? body.brief : {}) as Record<string, unknown>;
      const sections = [['Aktuelle Anamnese', b.aktuell], ['Allgemeinanamnese', b.allgemein], ['Röntgenbefund', b.befund], ['Therapieplan', b.therapie]]
        .map(([n, v]) => `### ${n}\n${str(v, 6000) || '(leer)'}`).join('\n\n');
      if (sections.replace(/\(leer\)|###.*\n/g, '').trim().length < 40) return reply({ error: 'Arztbrief çok kısa.' }, 400);
      material = `Arztbrief des Kandidaten:\n\n${sections}`;
    } else {
      const history = readHistory(body.history);
      if (history.filter((t) => t.role === 'user').length < 2) return reply({ error: 'Değerlendirme için konuşma çok kısa.' }, 400);
      material = part === 1
        ? `Gesprächsprotokoll:\n${transcript(history, 'Zahnarzt/Zahnärztin', 'Patient')}`
        : `Gesprächsprotokoll:\n${transcript(history, 'Kandidat', 'Oberarzt')}`;
    }
    const quota = await useQuota(COST.evaluate);
    if (quota) return quota;
    const r = await callGemini(apiKey, {
      system: evaluatePrompt(part, c, body.konjunktiv !== false),
      turns: [{ role: 'user', text: material }],
      json: true, maxTokens: 8000, temperature: 0.2, timeoutMs: 140_000, think: 'medium',
    });
    if (!r.text) return fail(r);
    const raw = parseJson(r.text);
    if (!raw) return reply({ error: 'Yapay zekâ geçerli bir değerlendirme döndürmedi. Tekrar dene.' }, 502);
    return reply({ report: { ...cleanReport(raw, part), model: MODEL, at: Math.floor(Date.now() / 1000) } });
  }

  if (action === 'case') {
    const fach = str(body.fachgebiet, 60) || 'beliebig';
    const hint = str(body.hint, 6000);
    const quota = await useQuota(COST.case);
    if (quota) return quota;
    const r = await callGemini(apiKey, {
      system: `Du erstellst realistische, aber erfundene Übungsfälle für die Fachsprachprüfung Zahnmedizin in Deutschland.
Alle Namen sind erfunden. Medizinisch korrekt, typisch für die zahnärztliche Praxis, mit relevanten Allgemeinerkrankungen/Medikamenten (z. B. Antikoagulation, Bisphosphonate, Diabetes, Endokarditisrisiko, Allergien), die für die Behandlung wichtig sind.
Antworte NUR mit gültigem JSON in dieser Form:
${CASE_SHAPE}`,
      turns: [{ role: 'user', text: `Fachgebiet: ${fach}${hint ? `\n\nNutze diese Stichpunkte/diesen Erfahrungsbericht als Grundlage (Inhalt umformulieren, Namen erfinden):\n${hint}` : ''}` }],
      json: true, maxTokens: 4000, temperature: 0.9, timeoutMs: 100_000, think: 'low',
    });
    if (!r.text) return fail(r);
    const raw = parseJson(r.text);
    const c = raw && cleanCase(raw);
    if (!c) return reply({ error: 'Yapay zekâ geçerli bir vaka döndürmedi. Tekrar dene.' }, 502);
    return reply({ case: c });
  }

  return reply({ error: 'Bilinmeyen işlem.' }, 400);
});

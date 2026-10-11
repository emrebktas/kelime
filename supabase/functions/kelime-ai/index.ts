// Kelime: yapay zekâ ile kart doldurma (NVIDIA API vekili)
//
// NVIDIA anahtarı sadece burada, Supabase'in gizli değişkenlerinde (NVIDIA_API_KEY) durur;
// uygulamaya, depoya ya da APK'ya hiç inmez. Sadece giriş yapmış kullanıcılar çağırabilir.
//
// İstek:  POST { "words": ["abandon", "die Erfahrung"], "language": "en" }
// Cevap:  { "cards": [{ word, translation, sentence, synonyms, extra: { type, plural, forms } }] }

import { createClient } from 'npm:@supabase/supabase-js@2';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = Deno.env.get('NVIDIA_MODEL') ?? 'z-ai/glm-5.3-flash';
const DAILY_LIMIT = Number(Deno.env.get('AI_DAILY_LIMIT') ?? 300); // kişi başı, son 24 saatte kelime
const MAX_WORDS = 15; // tek istekte

const ALLOWED_ORIGINS = [
  'https://emrebktas.github.io', // web
  'https://localhost', // Android uygulaması (Capacitor)
  'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:5174', 'http://127.0.0.1:5174', // geliştirme
];

const LANG_NAMES: Record<string, string> = {
  en: 'İngilizce', de: 'Almanca', fr: 'Fransızca', es: 'İspanyolca', it: 'İtalyanca', nl: 'Felemenkçe',
  pt: 'Portekizce', ru: 'Rusça', ar: 'Arapça', ja: 'Japonca', zh: 'Çince', ko: 'Korece', tr: 'Türkçe',
};

const SYSTEM_PROMPT = `Sen bir dil öğretmenisin. Verilen kelimeler için kelime kartı verisi üretiyorsun.
Sadece geçerli JSON döndür, açıklama ya da kod bloğu ekleme:
{"cards":[{"word":"...","translation":"...","sentence":"...","synonyms":["..."],"type":"...","plural":"...","forms":"..."}]}

Kurallar:
- Her kelime için, verilen sırayla tam bir kart üret.
- word: sözlükteki temel hâl. Almanca isimleri artikeliyle yaz (der Hund, die Erfahrung, das Gebäude); dönüşlü fiillerde "sich" ekle. Yazım hatası varsa düzelt.
- translation: kısa, doğal Türkçe karşılık; birden çok anlam varsa en yaygın 1-3 tanesi virgülle.
- sentence: öğrenilen dilde, doğal, orta seviye tek bir cümle; kelime (ya da çekimli hâli) cümlede geçsin. Türkçe olmasın.
- synonyms: öğrenilen dilde 2-4 gerçek eş anlamlı; kelimenin kendisini yazma; gerçek eş anlamlı yoksa [].
- type: isim, fiil, sıfat, zarf, bağlaç, edat ya da kalıp.
- plural: sadece Almanca isimlerde (ör. "die Hunde").
- forms: sadece düzensiz fiillerde üç hâl (ör. "go – went – gone").
- Olmayan alanı hiç yazma.`;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const coreWord = (w: string) => w.toLocaleLowerCase().replace(/^(der|die|das|the|to|a|an|sich)\s+/, '').trim();

/** Modelin çıktısını doğrular, temizler ve uygulamanın sınırlarına indirir. */
function cleanCard(raw: Record<string, unknown>) {
  const word = str(raw.word, 300);
  if (!word) return null;
  const core = coreWord(word);
  const seen = new Set<string>();
  const synonyms = (Array.isArray(raw.synonyms) ? raw.synonyms : [])
    .map((s) => str(s, 100))
    .filter((s) => {
      const k = s.toLocaleLowerCase();
      if (!s || seen.has(k) || (core && coreWord(s).includes(core))) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 6);
  const extra: Record<string, string> = {};
  for (const key of ['type', 'plural', 'forms']) {
    const v = str(raw[key], 100);
    if (v) extra[key] = v;
  }
  return {
    word,
    translation: str(raw.translation, 300),
    sentence: str(raw.sentence, 600),
    synonyms,
    extra,
  };
}

function parseModelJson(text: string): Record<string, unknown>[] {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Model geçerli bir cevap vermedi.');
  const data = JSON.parse(m[0]);
  if (!Array.isArray(data.cards)) throw new Error('Model geçerli bir cevap vermedi.');
  return data.cards;
}

Deno.serve(async (req) => {
  const headers = corsHeaders(req);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return reply({ error: 'Sadece POST.' }, 405);

  const apiKey = Deno.env.get('NVIDIA_API_KEY');
  if (!apiKey) return reply({ error: 'Sunucuda NVIDIA_API_KEY tanımlı değil.' }, 500);

  // Sadece gerçek, giriş yapmış kullanıcılar (anon anahtarıyla gelen istekler reddedilir)
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  const { data: userData, error: authError } = await admin.auth.getUser(token);
  const user = userData?.user;
  if (authError || !user) return reply({ error: 'Bu özellik için giriş yapman gerekiyor.' }, 401);
  const userId = user.id;

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return reply({ error: 'Geçersiz istek.' }, 400); }

  // Kişi başı günlük sınır (NVIDIA kotasını korur). Birim: kelime kartı = 1, essay analizi = ESSAY_COST.
  const useQuota = async (units: number): Promise<Response | null> => {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: usage, error } = await admin.from('ai_usage').select('words').eq('user_id', userId).gte('at', since);
    if (error) return reply({ error: 'Kullanım bilgisi okunamadı.' }, 500);
    const used = (usage ?? []).reduce((a, r) => a + (r.words as number), 0);
    if (used + units > DAILY_LIMIT) {
      return reply({ error: 'Günlük yapay zekâ sınırına ulaştın. Yarın tekrar dene.' }, 429);
    }
    await admin.from('ai_usage').insert({ user_id: userId, words: units });
    return null;
  };

  // Modeli çağırır; hata durumunda kullanıcıya gösterilecek cevabı döndürür
  const callModel = async (messages: unknown[], maxTokens: number, timeoutMs: number): Promise<string | Response> => {
    let res: Response;
    try {
      res = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.2,
          max_tokens: maxTokens,
          reasoning_effort: 'low', // uzun "düşünme" aşamasını kapatır: cevap birkaç kat hızlı gelir
          messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return reply({ error: 'Yapay zekâ servisi zamanında cevap vermedi. Tekrar dene.' }, 504);
    }
    if (!res.ok) {
      console.error('NVIDIA hata', res.status, await res.text());
      const msg = res.status === 429 ? 'Yapay zekâ servisi şu an yoğun. Biraz sonra tekrar dene.' : 'Yapay zekâ servisine ulaşılamadı.';
      return reply({ error: msg }, 502);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  };

  if (body.action === 'essay') return evaluateEssay(body, useQuota, callModel, reply);

  const language = str(body.language, 12).toLowerCase() || 'en';
  const words = [...new Set((Array.isArray(body.words) ? body.words : [])
    .map((w) => str(w, 80)).filter(Boolean))].slice(0, MAX_WORDS);
  if (!words.length) return reply({ error: 'En az bir kelime gir.' }, 400);
  const quota = await useQuota(words.length);
  if (quota) return quota;

  const langName = LANG_NAMES[language] ?? language;
  const out = await callModel([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Öğrenilen dil: ${langName}\nKelimeler:\n${words.map((w) => `- ${w}`).join('\n')}` },
  ], 250 * words.length + 200, 110_000);
  if (out instanceof Response) return out;
  try {
    const cards = parseModelJson(out)
      .map((c) => cleanCard(c ?? {}))
      .filter((c): c is NonNullable<typeof c> => !!c);
    return reply({ cards });
  } catch (e) {
    console.error('Model cevabı çözülemedi', e);
    return reply({ error: 'Yapay zekâ anlaşılır bir cevap vermedi. Tekrar dene.' }, 502);
  }
});

/* ------------------------------------------------------------------ IELTS essay değerlendirmesi */

const ESSAY_COST = 25; // günlük sınırdan düşülen birim
const ESSAY_TASKS: Record<string, { label: string; min: number; criterion: string }> = {
  task2: { label: 'IELTS Writing Task 2 (essay)', min: 250, criterion: 'Task Response' },
  task1: { label: 'IELTS Academic Writing Task 1 (rapor)', min: 150, criterion: 'Task Achievement' },
  gt1: { label: 'IELTS General Training Writing Task 1 (mektup)', min: 150, criterion: 'Task Achievement' },
  free: { label: 'Serbest yazı (IELTS Task 2 ölçütleriyle)', min: 0, criterion: 'Task Response' },
};

const ESSAY_PROMPT = `Sen deneyimli, resmi IELTS Writing band tanımlayıcılarını (public band descriptors) çok iyi bilen bir sınav değerlendiricisisin.
Verilen yazıyı gerçek bir IELTS sınavındaki gibi değerlendir: ne cömert ne aşırı sert, dürüst ve tutarlı ol.

Sadece geçerli JSON döndür, açıklama ya da kod bloğu ekleme:
{
  "criteria": {
    "task": {"band": 6.5, "comment": "..."},
    "coherence": {"band": 6, "comment": "..."},
    "lexical": {"band": 6, "comment": "..."},
    "grammar": {"band": 5.5, "comment": "..."}
  },
  "summary": "2-3 cümlelik genel değerlendirme",
  "strengths": ["..."],
  "improvements": ["en önemli 3-5 somut öneri"],
  "errors": [{"original": "...", "correction": "...", "type": "grammar", "explanation": "..."}],
  "band9_tips": ["..."],
  "improved_sentence": {"original": "...", "improved": "..."}
}

Kurallar:
- Bantlar 0-9 arası, yarım puan adımlı. "task" ölçütü Task 2'de Task Response, Task 1'de Task Achievement'tır.
- Yorumlarda band tanımlayıcılarına somut atıf yap (ör. "pozisyon net ama fikirler yeterince geliştirilmemiş").
- Kelime sayısı alt sınırın altındaysa task puanını buna göre düşür ve bunu belirt.
- errors: yazıdaki gerçek hatalar (en fazla 15, en önemlileri önce). "original" yazıdan BİREBİR alıntı olsun; type: grammar, vocabulary, spelling, punctuation ya da style.
- band9_tips: bu yazıyı daha yüksek banda taşıyacak 2-4 somut ipucu.
- improved_sentence: yazıdaki zayıf bir cümleyi Band 8-9 seviyesinde yeniden yaz.
- Tüm yorumları, açıklamaları ve önerileri TÜRKÇE yaz; düzeltmeler, alıntılar ve örnek cümleler İngilizce kalsın.`;

const band = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(9, Math.max(0, Math.round(n * 2) / 2)) : null;
};
const strList = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : []).map((s) => str(s, len)).filter(Boolean).slice(0, max);

async function evaluateEssay(
  body: Record<string, unknown>,
  useQuota: (units: number) => Promise<Response | null>,
  callModel: (messages: unknown[], maxTokens: number, timeoutMs: number) => Promise<string | Response>,
  reply: (b: unknown, status?: number) => Response,
): Promise<Response> {
  const task = ESSAY_TASKS[String(body.task)] ?? ESSAY_TASKS.task2;
  const essay = typeof body.body === 'string' ? body.body.trim().slice(0, 15000) : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 3000) : '';
  const count = essay.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  if (count < 30) return reply({ error: 'Analiz için en az 30 kelimelik bir yazı gerekli.' }, 400);
  const quota = await useQuota(ESSAY_COST);
  if (quota) return quota;

  const out = await callModel([
    { role: 'system', content: ESSAY_PROMPT },
    {
      role: 'user',
      content: `Görev türü: ${task.label}${task.min ? ` · alt sınır ${task.min} kelime` : ''}\nKelime sayısı: ${count}\n\n`
        + `SORU:\n${prompt || '(soru verilmedi; yazının konusundan çıkar)'}\n\nYAZI:\n${essay}`,
    },
  ], 4000, 140_000);
  if (out instanceof Response) return out;

  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('JSON yok');
    const raw = JSON.parse(m[0]);
    const criteria: Record<string, { band: number; comment: string }> = {};
    for (const k of ['task', 'coherence', 'lexical', 'grammar']) {
      const c = raw.criteria?.[k] ?? {};
      const b = band(c.band);
      if (b === null) throw new Error(`${k} bandı yok`);
      criteria[k] = { band: b, comment: str(c.comment, 800) };
    }
    // IELTS gibi: dört ölçütün ortalaması, en yakın yarım banda yuvarlanır (x.25 → x.5, x.75 → x+1)
    const avg = Object.values(criteria).reduce((a, c) => a + c.band, 0) / 4;
    const errors = (Array.isArray(raw.errors) ? raw.errors : []).slice(0, 20).map((e: Record<string, unknown>) => ({
      original: str(e?.original, 300),
      correction: str(e?.correction, 300),
      type: ['grammar', 'vocabulary', 'spelling', 'punctuation', 'style'].includes(String(e?.type)) ? String(e.type) : 'grammar',
      explanation: str(e?.explanation, 400),
    })).filter((e: { original: string; correction: string }) => e.original && e.correction);
    const report = {
      overall: Math.round(avg * 2) / 2,
      criterion_name: task.criterion,
      criteria,
      summary: str(raw.summary, 1000),
      strengths: strList(raw.strengths, 6, 400),
      improvements: strList(raw.improvements, 6, 400),
      errors,
      band9_tips: strList(raw.band9_tips, 5, 400),
      improved_sentence: raw.improved_sentence?.original && raw.improved_sentence?.improved
        ? { original: str(raw.improved_sentence.original, 500), improved: str(raw.improved_sentence.improved, 600) }
        : null,
      words: count,
      model: MODEL,
    };
    return reply({ report });
  } catch (e) {
    console.error('Essay değerlendirmesi çözülemedi', e, out.slice(0, 500));
    return reply({ error: 'Yapay zekâ anlaşılır bir değerlendirme vermedi. Tekrar dene.' }, 502);
  }
}

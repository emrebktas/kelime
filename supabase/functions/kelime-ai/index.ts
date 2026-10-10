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

  let body: { words?: unknown; language?: unknown };
  try { body = await req.json(); } catch { return reply({ error: 'Geçersiz istek.' }, 400); }
  const language = str(body.language, 12).toLowerCase() || 'en';
  const words = [...new Set((Array.isArray(body.words) ? body.words : [])
    .map((w) => str(w, 80)).filter(Boolean))].slice(0, MAX_WORDS);
  if (!words.length) return reply({ error: 'En az bir kelime gir.' }, 400);

  // Kişi başı günlük sınır (NVIDIA kotasını korur)
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data: usage, error: usageError } = await admin.from('ai_usage').select('words').eq('user_id', user.id).gte('at', since);
  if (usageError) return reply({ error: 'Kullanım bilgisi okunamadı.' }, 500);
  const used = (usage ?? []).reduce((a, r) => a + (r.words as number), 0);
  if (used + words.length > DAILY_LIMIT) {
    return reply({ error: `Günlük yapay zekâ sınırına ulaştın (${DAILY_LIMIT} kelime). Yarın tekrar dene.` }, 429);
  }
  await admin.from('ai_usage').insert({ user_id: user.id, words: words.length });

  const langName = LANG_NAMES[language] ?? language;
  let res: Response;
  try {
    res = await fetch(NVIDIA_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        max_tokens: 250 * words.length + 200,
        reasoning_effort: 'low', // uzun "düşünme" aşamasını kapatır: cevap birkaç kat hızlı gelir
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `Öğrenilen dil: ${langName}\nKelimeler:\n${words.map((w) => `- ${w}`).join('\n')}` },
        ],
      }),
      signal: AbortSignal.timeout(110_000),
    });
  } catch {
    return reply({ error: 'Yapay zekâ servisi zamanında cevap vermedi. Tekrar dene.' }, 504);
  }
  if (!res.ok) {
    console.error('NVIDIA hata', res.status, await res.text());
    const msg = res.status === 429 ? 'Yapay zekâ servisi şu an yoğun. Biraz sonra tekrar dene.' : 'Yapay zekâ servisine ulaşılamadı.';
    return reply({ error: msg }, 502);
  }
  try {
    const data = await res.json();
    const cards = parseModelJson(data.choices?.[0]?.message?.content ?? '')
      .map((c) => cleanCard(c ?? {}))
      .filter((c): c is NonNullable<typeof c> => !!c);
    return reply({ cards });
  } catch (e) {
    console.error('Model cevabı çözülemedi', e);
    return reply({ error: 'Yapay zekâ anlaşılır bir cevap vermedi. Tekrar dene.' }, 502);
  }
});

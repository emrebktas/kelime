// Kelime: yapay zekâ ile kart doldurma (NVIDIA API vekili)
//
// NVIDIA anahtarı sadece burada, Supabase'in gizli değişkenlerinde (NVIDIA_API_KEY) durur;
// uygulamaya, depoya ya da APK'ya hiç inmez. Sadece giriş yapmış kullanıcılar çağırabilir.
//
// İstek:  POST { "words": ["abandon", "die Erfahrung"], "language": "en" }
// Cevap:  { "cards": [{ word, translation, sentence, synonyms, extra: { type, plural, forms } }] }

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';

const NVIDIA_URL = 'https://integrate.api.nvidia.com/v1/chat/completions';
const MODEL = Deno.env.get('NVIDIA_MODEL') ?? 'z-ai/glm-5.3-flash';
// Task 1 görselini (grafik/tablo/diyagram) okuyan görüntü modeli; okuduklarını yukarıdaki modele metin olarak verir
// Sırayla denenir; ilk çalışan kullanılır (NVIDIA_VISION_MODEL gizli değişkeniyle başa başka model eklenebilir)
const VISION_MODELS = [...new Set([
  Deno.env.get('NVIDIA_VISION_MODEL') ?? '',
  'google/gemma-4-31b-it',
  'meta/llama-3.2-90b-vision-instruct',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
].filter(Boolean))];
const FIGURE_PROMPT = `This image is the visual from an IELTS Academic Writing Task 1 question.
Transcribe it accurately for an examiner who cannot see it. Plain text, no tables, at most 350 words:
1. Type of visual, its title/subject, units and time period(s).
2. Every category/label and every data value you can read (write "approx." when estimated). If there are several charts, cover each one.
3. For a process or diagram: every stage in order. For maps: every feature and every change.
4. Key features an overview should mention: main trends, highest/lowest values, biggest changes, notable comparisons.
Describe only what is shown. Do not invent values you cannot read.`;
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
  const callModel = async (messages: unknown[], maxTokens: number, timeoutMs: number, temperature = 0.2, model = MODEL): Promise<string | Response> => {
    let res: Response;
    try {
      res = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature,
          max_tokens: maxTokens,
          // uzun "düşünme" aşamasını kapatır: cevap birkaç kat hızlı gelir (görüntü modeli bu ayarı tanımayabilir)
          ...(model === MODEL ? { reasoning_effort: 'low' } : {}),
          messages,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return reply({ error: 'Yapay zekâ servisi zamanında cevap vermedi. Tekrar dene.' }, 504);
    }
    if (!res.ok) {
      console.error('NVIDIA hata', model, res.status, await res.text());
      const msg = res.status === 429 ? 'Yapay zekâ servisi şu an yoğun. Biraz sonra tekrar dene.' : 'Yapay zekâ servisine ulaşılamadı.';
      return reply({ error: msg }, 502);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
  };

  if (body.action === 'essay') return evaluateEssay(body, admin, useQuota, callModel, reply, apiKey);
  // Task 1 görselini ayrı istekte okur (analizle aynı istekte süre sınırı aşılmasın diye)
  if (body.action === 'figure') {
    const image = validImage(body.image);
    if (!image) return reply({ error: 'Görsel geçersiz ya da çok büyük.' }, 400);
    const quota = await useQuota(FIGURE_COST);
    if (quota) return quota;
    const seen = await readFigure(apiKey, image);
    return reply({ notes: seen.text.slice(0, 4000), model: seen.model, error: seen.error.slice(0, 300) });
  }

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
const FIGURE_COST = 5;
const validImage = (v: unknown) => typeof v === 'string' && v.length <= 400_000
  && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(v) ? v : '';
const ESSAY_TASKS: Record<string, { label: string; min: number; criterion: string }> = {
  task2: { label: 'IELTS Writing Task 2 (essay)', min: 250, criterion: 'Task Response' },
  task1: { label: 'IELTS Academic Writing Task 1 (rapor)', min: 150, criterion: 'Task Achievement' },
  gt1: { label: 'IELTS General Training Writing Task 1 (mektup)', min: 150, criterion: 'Task Achievement' },
  free: { label: 'Serbest yazı (IELTS Task 2 ölçütleriyle)', min: 0, criterion: 'Task Response' },
};

// IELTS Writing band tanımlayıcıları (IELTS'in herkese açık yayımladığı "Writing band descriptors",
// Mayıs 2023 güncellemesi). Metin telif hakkıyla korunduğu için birebir değil, ayırt edici özellikleri
// kendi cümlelerimizle özetlenmiştir. Model puanı bu özelliklere ve görevli (examiner) yöntemine göre verir.
const DESCRIPTORS = {
  task2: `TASK RESPONSE (Task 2)
9: Fully addresses all parts of the prompt; a fully developed position directly answers the question; ideas are relevant, fully extended and well supported; lapses in content or support are extremely rare.
8: Sufficiently addresses all parts; a well-developed response with a clear position; ideas relevant, well extended and supported; only occasional omissions or lapses.
7: Addresses all parts of the prompt; presents a clear, developed position throughout; main ideas are extended and supported but there may be a tendency to over-generalise or supporting ideas may lack focus/precision.
6: Addresses all parts, though some more fully than others; presents a relevant position although conclusions may be unclear, unjustified or repetitive; main ideas are relevant but some are insufficiently developed or may lack clarity; some supporting arguments may be less relevant.
5: Addresses the prompt only partially; format may be inappropriate in places; a position is expressed but its development is not always clear; main ideas are limited and not sufficiently developed; there may be irrelevant detail and some repetition.
4: Responds only minimally or tangentially; format may be inappropriate; a position is discernible but unclear; main ideas are difficult to identify and may be repetitive, irrelevant or unsupported.
3 and below: does not adequately address any part of the prompt; no relevant position; few ideas, largely undeveloped or irrelevant.`,
  task1: `TASK ACHIEVEMENT (Academic Task 1)
9: All requirements of the task are fully and appropriately satisfied; lapses are extremely rare.
8: Covers all requirements appropriately, relevantly and sufficiently; key features are skilfully selected, clearly presented, highlighted and illustrated; occasional omissions or lapses.
7: Covers the requirements; content is relevant and accurate; presents a clear overview of main trends, differences or stages; key features are clearly presented and highlighted but could be more fully extended or illustrated.
6: Focuses on the requirements; presents an overview with information appropriately selected; key features are adequately highlighted, but some details may be irrelevant, inappropriate or inaccurate; some key features may be missing or under-developed.
5: Generally addresses the task; format may be inappropriate in places; recounts detail mechanically with no clear overview (or no data to support the description); key features are inadequately covered; may focus on details.
4: Attempts to address the task but does not cover all key features; format may be inappropriate; may confuse key features with detail; parts may be unclear, irrelevant, repetitive or inaccurate.
3 and below: fails to address the task; very limited content, largely irrelevant or inaccurate.`,
  gt1: `TASK ACHIEVEMENT (General Training Task 1 — letter)
9: All requirements fully satisfied; all bullet points fully and appropriately covered; purpose fully clear; tone consistently appropriate.
8: All requirements covered appropriately and sufficiently; all bullet points clearly presented, highlighted and extended; purpose clear; tone consistent and appropriate; occasional lapses.
7: Covers all requirements; all bullet points presented and highlighted but could be more fully extended; purpose clear; tone consistent and appropriate with possible minor lapses.
6: Addresses the requirements; all bullet points covered but some unevenly or inadequately; purpose generally clear though there may be inconsistencies in tone.
5: Generally addresses the task; may not cover all bullet points or some are covered only partially; purpose may be unclear at times; tone may be variable and sometimes inappropriate.
4: Attempts to address the task; does not cover all bullet points; purpose unclear; tone may be inappropriate.
3 and below: fails to address the task; purpose unclear; very limited relevant content.`,
  coherence: `COHERENCE AND COHESION
9: The message can be followed effortlessly; cohesion is used in a way that attracts no attention; paragraphing is skilfully managed.
8: The message can be followed with ease; information and ideas are logically sequenced and cohesion is well managed; occasional lapses; paragraphing is used sufficiently and appropriately.
7: Information and ideas are logically organised with clear progression throughout; a range of cohesive devices, including reference and substitution, is used flexibly but with some inaccuracies or some over/under-use; paragraphing is generally effective and each paragraph has a clear central topic.
6: Information and ideas are arranged coherently with clear overall progression; cohesive devices are used to some good effect but cohesion within and/or between sentences may be faulty or mechanical (e.g. overuse of linkers); referencing and substitution may be unclear or repetitive; paragraphing may not always be logical and the central topic may not always be clear.
5: Organisation is evident but not wholly logical and there may be a lack of overall progression; relationships between ideas can be followed but sentences are not fluently linked; limited range or overuse of cohesive devices with some inaccuracy; writing may be repetitive because of inadequate referencing; paragraphing may be inadequate or missing.
4: Ideas are evident but not arranged coherently; no clear progression; relationships between ideas are unclear or inadequately marked; basic cohesive devices used inaccurately or repetitively; paragraphing absent or confusing.
3 and below: no apparent logical organisation; ideas discernible but difficult to relate; minimal use of linking.`,
  lexical: `LEXICAL RESOURCE
9: Full flexibility and precise use; wide range of vocabulary used accurately and appropriately with very natural and sophisticated control of lexical features; minor errors in spelling and word formation are extremely rare.
8: A wide resource is used fluently and flexibly to convey precise meanings; skilful use of uncommon and idiomatic items when appropriate, despite occasional inaccuracies in word choice and collocation; occasional errors in spelling/word formation with minimal impact.
7: Sufficient resource to allow some flexibility and precision; some ability to use less common and idiomatic items; awareness of style and collocation, though inappropriacies occur; only a few errors in spelling/word formation that do not detract from clarity.
6: Generally adequate and appropriate resource; meaning is generally clear despite a rather restricted range or lack of precision in word choice; if risks are taken, some wrong word choice; some errors in spelling/word formation that do not impede communication.
5: Limited but minimally adequate resource; simple vocabulary may be used accurately but the range does not permit much variation; frequent lapses in appropriacy and/or repetition; errors in spelling/word formation may be noticeable and cause some difficulty for the reader.
4: Limited and inadequate or unrelated vocabulary; basic vocabulary used repetitively; inappropriate use of lexical chunks (e.g. memorised phrases, formulaic language); errors may impede meaning.
3 and below: very limited range; errors predominate and may severely distort meaning.`,
  grammar: `GRAMMATICAL RANGE AND ACCURACY
9: A wide range of structures used with full flexibility and control; punctuation and grammar are used appropriately throughout; minor errors are extremely rare.
8: A wide range of structures used flexibly and accurately; the majority of sentences are error-free; punctuation is well managed; occasional, non-systematic errors and inappropriacies with minimal impact.
7: A variety of complex structures used with some flexibility and accuracy; grammar and punctuation are generally well controlled and error-free sentences are frequent; a few errors in grammar may persist but do not impede communication.
6: A mix of simple and complex sentence forms but flexibility is limited; more complex structures are not as accurate as simple ones; errors in grammar and punctuation occur but rarely impede communication.
5: Range of structures is limited and rather repetitive; complex sentences are attempted but tend to be faulty; greatest accuracy is in simple sentences; grammatical errors may be frequent and cause some difficulty for the reader; punctuation may be faulty.
4: Very limited range of structures; subordinate clauses are rare and simple sentences predominate; some structures are produced accurately but grammatical errors are frequent and may impede meaning; punctuation is often faulty or inadequate.
3 and below: sentence forms attempted but errors in grammar and punctuation predominate and distort meaning.`,
};

// Resmi tanımlayıcı metni (Mayıs 2023) Supabase'deki gizli tablodan okunur; telif hakkı nedeniyle
// herkese açık depoda tutulmaz. Tablo yoksa yukarıdaki özetler kullanılır.
let descriptorCache: Record<string, string> | null = null;
async function officialDescriptors(admin: SupabaseClient): Promise<Record<string, string> | null> {
  if (descriptorCache) return descriptorCache;
  const { data, error } = await admin.from('ielts_descriptors').select('key, content');
  if (error || !data?.length) return null;
  descriptorCache = Object.fromEntries(data.map((r: { key: string; content: string }) => [r.key, r.content]));
  return descriptorCache;
}

function essayPrompt(taskKey: string, official: Record<string, string> | null): string {
  const isTask1 = taskKey === 'task1' || taskKey === 'gt1';
  const officialText = official?.[isTask1 ? 'task1' : 'task2'];
  const variant = taskKey === 'task1'
    ? 'This is an ACADEMIC Task 1 (report on visual data): apply the lines marked (Academic) and ignore those marked (General Training).'
    : taskKey === 'gt1'
      ? 'This is a GENERAL TRAINING Task 1 (letter): apply the lines marked (General Training) and ignore those marked (Academic).'
      : 'This is a Task 2 essay.';
  const descriptorBlock = officialText
    ? `OFFICIAL IELTS WRITING BAND DESCRIPTORS (public version, updated May 2023) — apply them word for word:\n${officialText}\n\n${variant}`
    : `${taskKey === 'task1' ? DESCRIPTORS.task1 : taskKey === 'gt1' ? DESCRIPTORS.gt1 : DESCRIPTORS.task2}\n\n${DESCRIPTORS.coherence}\n\n${DESCRIPTORS.lexical}\n\n${DESCRIPTORS.grammar}`;
  return `You are a certified IELTS Writing examiner. Assess the candidate's response strictly against the IELTS Writing band descriptors below, exactly as a trained examiner would.

${descriptorBlock}

EXAMINER METHOD (follow exactly):
1. Rate each of the four criteria independently; do not let one criterion influence another.
2. For each criterion, find the band whose description best fits the response. Official rule: "A script must fully fit the positive features of the descriptor at a particular level." If it does not fully fit a band's positive features, award the band below. Features marked in **bold** are negative features that LIMIT the rating: if one applies, the response cannot be rated above that band for that criterion. Use whole bands per criterion; use a half band only when the response sits clearly between two bands.
   Official rules: responses of 20 words or fewer are rated at Band 1; any copied rubric (words copied from the question) must be discounted; Band 0 only if not attempted, not in English, or proven to be totally memorised.
3. Base every judgement on evidence in the text. Do not reward length, memorised phrases or "impressive" words used inaccurately; do not penalise British/American spelling variation if used consistently.
4. Task penalties: if the response is under the minimum word count, it cannot fully address/cover the task and the task criterion must reflect this (typically capped around band 5–6 depending on how far under). Words copied verbatim from the question are not counted. An off-topic, memorised or largely irrelevant response must receive a low task score. For Task 2, a response without a clear position cannot score above 5 for Task Response.
5. Be calibrated: most real candidates score between 5 and 7. Bands 8–9 require near-native control. Neither generous nor harsh.

OUTPUT: valid JSON only, no prose and no code fences, in exactly this shape:
{
  "criteria": {
    "task": {"band": 6, "descriptor": "...", "evidence": ["exact quote", "..."], "next_band": "...", "comment": "..."},
    "coherence": {"band": 6, "descriptor": "...", "evidence": ["..."], "next_band": "...", "comment": "..."},
    "lexical": {"band": 6, "descriptor": "...", "evidence": ["..."], "next_band": "...", "comment": "..."},
    "grammar": {"band": 6, "descriptor": "...", "evidence": ["..."], "next_band": "...", "comment": "..."}
  },
  "summary": "...",
  "strengths": ["..."],
  "improvements": ["..."],
  "errors": [{"original": "...", "correction": "...", "type": "grammar", "explanation": "..."}],
  "band9_tips": ["..."],
  "improved_sentence": {"original": "...", "improved": "..."},
  "vocab_suggestions": [{"word": "...", "original": "...", "suggestion": "...", "why": "..."}]
}

FIELD RULES:
- "descriptor": which band-descriptor features this response matches (paraphrase them).
- "evidence": 1–3 short quotes copied EXACTLY from the response that justify the band.
- "next_band": what is specifically missing to reach the next band up, referring to that band's descriptor features.
- "comment": a short overall judgement for the criterion.
- "errors": real errors only (max 15, most important first); "original" must be copied EXACTLY from the response; type is one of grammar, vocabulary, spelling, punctuation, style.
- "band9_tips": 2–4 concrete, actionable tips. "improved_sentence": rewrite one weak sentence at band 8–9 level.
- LANGUAGE: write descriptor, next_band, comment, summary, strengths, improvements, explanations, band9_tips and why fields in TURKISH. Keep quotes, corrections and example sentences in English.`;
}

const band = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(9, Math.max(0, Math.round(n * 2) / 2)) : null;
};
const strList = (v: unknown, max: number, len: number) =>
  (Array.isArray(v) ? v : []).map((s) => str(s, len)).filter(Boolean).slice(0, max);

/** Görseli görüntü modelleriyle sırayla okumayı dener (en fazla ~60 sn). Hata nedenleri rapora yazılır. */
async function readFigure(apiKey: string, image: string): Promise<{ text: string; model: string; error: string }> {
  const deadline = Date.now() + 60_000;
  const errors: string[] = [];
  for (const model of VISION_MODELS) {
    const left = deadline - Date.now();
    if (left < 8_000) { errors.push('süre doldu'); break; }
    try {
      const res = await fetch(NVIDIA_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.1,
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: image } },
              { type: 'text', text: FIGURE_PROMPT },
            ],
          }],
        }),
        signal: AbortSignal.timeout(Math.min(40_000, left)),
      });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        console.error('Görsel modeli hata', model, res.status, detail);
        errors.push(`${model.split('/')[1]}: HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      // "Düşünen" modellerin düşünme bölümü atılır
      const text = String(data.choices?.[0]?.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      if (text.length > 40) return { text, model, error: '' };
      errors.push(`${model.split('/')[1]}: boş cevap`);
    } catch (e) {
      console.error('Görsel modeli ulaşılamadı', model, e);
      errors.push(`${model.split('/')[1]}: zaman aşımı`);
    }
  }
  return { text: '', model: '', error: errors.join(' · ') };
}

async function evaluateEssay(
  body: Record<string, unknown>,
  admin: SupabaseClient,
  useQuota: (units: number) => Promise<Response | null>,
  callModel: (messages: unknown[], maxTokens: number, timeoutMs: number, temperature?: number, model?: string) => Promise<string | Response>,
  reply: (b: unknown, status?: number) => Response,
  apiKey: string,
): Promise<Response> {
  const started = Date.now();
  const task = ESSAY_TASKS[String(body.task)] ?? ESSAY_TASKS.task2;
  // Academic Task 1 görseli (uygulamada küçültülmüş JPEG/PNG/WebP)
  // Uygulama görseli önce ayrı istekte okutup okunanları (figure_notes) gönderir; eski sürümler görseli doğrudan gönderir
  const image = String(body.task) === 'task1' ? validImage(body.image) : '';
  const givenNotes = String(body.task) === 'task1' && typeof body.figure_notes === 'string' ? body.figure_notes.trim().slice(0, 4000) : '';
  const givenFailed = String(body.task) === 'task1' && body.figure_failed === true;
  const essay = typeof body.body === 'string' ? body.body.trim().slice(0, 15000) : '';
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim().slice(0, 3000) : '';
  const count = essay.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t)).length;
  // Öğrencinin destesindeki (çalıştığı) kelimeler: yazıda doğal kullanılabilecek yerler önerilir
  const targets = (Array.isArray(body.target_words) ? body.target_words : []).slice(0, 80)
    .map((t: Record<string, unknown>) => ({ word: str(t?.word, 80), translation: str(t?.translation, 120) }))
    .filter((t: { word: string }) => t.word);
  if (count < 30) return reply({ error: 'Analiz için en az 30 kelimelik bir yazı gerekli.' }, 400);
  const quota = await useQuota(ESSAY_COST);
  if (quota) return quota;

  // 1) Görsel varsa önce görüntü modeli verileri okur. Okuyamazsa analiz yine de sadece soru metniyle yapılır.
  let figure = givenNotes;
  let figureStatus: 'none' | 'used' | 'failed' = givenNotes ? 'used' : givenFailed ? 'failed' : 'none';
  let figureModel = givenNotes ? str(body.figure_model, 120) : '';
  let figureError = givenFailed ? str(body.figure_error, 300) : '';
  if (image && !givenNotes && !givenFailed) {
    const seen = await readFigure(apiKey, image);
    figure = seen.text.slice(0, 4000);
    figureModel = seen.model;
    figureError = seen.error;
    figureStatus = figure ? 'used' : 'failed';
  }
  const figureText = figure
    ? '\n\nGÖREV GÖRSELİ — bir görüntü modelinin görselden okuduğu veriler. Yazıdaki rakamları, karşılaştırmaları ve '
      + 'genel bakışı (overview) bunlarla karşılaştır: yanlış ya da uydurma veri, eksik ana eğilim/önemli özellik veya '
      + 'overview yoksa Task Achievement puanına yansıt. Okumada küçük belirsizlikler olabilir; küçük sayı farklarını ceza sebebi yapma.\n'
      + figure
    : figureStatus === 'failed'
      ? '\n\n(Görevin görseli okunamadı. Sadece soru metnine göre değerlendir; verilerin doğruluğu hakkında kesin hüküm verme.)'
      : '';

  // 2) Değerlendirme. Supabase fonksiyonları ~150 sn'de kesilir: görsel okuma süresi buradan düşülür.
  const out = await callModel([
    { role: 'system', content: essayPrompt(String(body.task), await officialDescriptors(admin)) },
    {
      role: 'user',
      content: `Görev türü: ${task.label}${task.min ? ` · alt sınır ${task.min} kelime` : ''}\nKelime sayısı: ${count}\n\n`
        + `SORU:\n${prompt || '(soru verilmedi; yazının konusundan çıkar)'}${figureText}\n\nYAZI:\n${essay}`
        + (targets.length
          ? `\n\nÖĞRENCİNİN ÇALIŞTIĞI KELİMELER (destesinden):\n${targets.map((t: { word: string; translation: string }) => `- ${t.word}${t.translation ? ` (${t.translation})` : ''}`).join('\n')}\n\n`
            + 'Bu listedeki kelimelerden, yazıdaki bir cümleye anlamı bozmadan ve doğal şekilde oturanları bul; '
            + '"vocab_suggestions" alanına yaz (en fazla 8, sadece gerçekten uygun olanlar, zorlama yok). '
            + '"word" listedeki kelime olmalı; "original" yazıdan BİREBİR alıntı; "suggestion" o cümlenin kelimeyi kullanan yeni hâli; '
            + '"why" kısa Türkçe açıklama. Uygun yer yoksa boş dizi ver.'
          : ''),
    },
  ], 5500, Math.max(60_000, 140_000 - (Date.now() - started)), 0.1);
  if (out instanceof Response) return out;

  try {
    const m = out.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('JSON yok');
    const raw = JSON.parse(m[0]);
    const criteria: Record<string, { band: number; comment: string; descriptor: string; evidence: string[]; next_band: string }> = {};
    for (const k of ['task', 'coherence', 'lexical', 'grammar']) {
      const c = raw.criteria?.[k] ?? {};
      const b = band(c.band);
      if (b === null) throw new Error(`${k} bandı yok`);
      criteria[k] = {
        band: b,
        comment: str(c.comment, 800),
        descriptor: str(c.descriptor, 600),
        evidence: strList(c.evidence, 3, 240),
        next_band: str(c.next_band, 500),
      };
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
      descriptor_source: descriptorCache ? 'official-2023' : 'summary',
      figure_status: figureStatus,
      figure_model: figureModel,
      figure_error: figureError.slice(0, 300),
      figure_notes: figure.slice(0, 2500),
      vocab_suggestions: (() => {
        const allowed = new Set(targets.map((t: { word: string }) => t.word.toLowerCase()));
        return (Array.isArray(raw.vocab_suggestions) ? raw.vocab_suggestions : []).slice(0, 10)
          .map((v: Record<string, unknown>) => ({
            word: str(v?.word, 80), original: str(v?.original, 400), suggestion: str(v?.suggestion, 500), why: str(v?.why, 300),
          }))
          // sadece öğrencinin listesindeki kelimeler (model uydurmasın)
          .filter((v: { word: string; original: string; suggestion: string }) =>
            v.original && v.suggestion && allowed.has(v.word.toLowerCase()));
      })(),
    };
    return reply({ report });
  } catch (e) {
    console.error('Essay değerlendirmesi çözülemedi', e, out.slice(0, 500));
    return reply({ error: 'Yapay zekâ anlaşılır bir değerlendirme vermedi. Tekrar dene.' }, 502);
  }
}

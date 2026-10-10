// Aralıklı tekrar zamanlaması (Anki varsayılanlarına yakın)

export const NEW = 0;
export const LEARNING = 1;
export const REVIEW = 2;
export const RELEARNING = 3;

const DAY_CUTOFF_HOUR = 4;     // gün sabah 04:00'te döner
const LEARN_STEPS = [1, 10];   // dakika
const RELEARN_STEPS = [10];    // dakika
const GRADUATING_IVL = 1;      // gün
const EASY_IVL = 4;            // gün
const MAX_IVL = 36500;
export const LEARN_AHEAD = 20 * 60;  // saniye

export const nowSec = () => Math.floor(Date.now() / 1000);

/** Verilen anın ait olduğu çalışma gününün başlangıcı (yerel saatle 04:00). */
export function dayStart(ts) {
  const d = new Date(ts * 1000);
  const cut = new Date(d);
  cut.setHours(DAY_CUTOFF_HOUR, 0, 0, 0);
  if (d < cut) cut.setDate(cut.getDate() - 1);
  return Math.floor(cut.getTime() / 1000);
}

function addDays(ts, days) {
  const d = new Date(ts * 1000);
  d.setDate(d.getDate() + days);
  return Math.floor(d.getTime() / 1000);
}

export const emptyState = () => ({ state: NEW, due: 0, ivl: 0, ease: 2.5, step: 0, reps: 0, lapses: 0 });

/**
 * Bir cevaptan sonra kartın yeni zamanlama alanları.
 * rating: 1=Tekrar, 2=Zor, 3=İyi, 4=Kolay
 */
export function schedule(card, rating, now, fuzz = true) {
  const { state } = card;
  let { ivl, ease, step, lapses } = card;
  const today = dayStart(now);

  const toReview = (days) => {
    days = Math.max(1, Math.min(MAX_IVL, days));
    if (fuzz && days >= 3) days *= 0.95 + Math.random() * 0.1;
    days = Math.round(days);
    return { state: REVIEW, due: addDays(today, days), ivl: days, ease, step: 0, lapses };
  };
  const learn = (st, newStep, secs) => ({ state: st, due: now + Math.round(secs), ivl, ease, step: newStep, lapses });

  if (state === NEW || state === LEARNING || state === RELEARNING) {
    const relearn = state === RELEARNING;
    const steps = relearn ? RELEARN_STEPS : LEARN_STEPS;
    const st = relearn ? RELEARNING : LEARNING;
    step = state === NEW ? 0 : Math.min(step, steps.length - 1);
    if (rating === 1) return learn(st, 0, steps[0] * 60);
    if (rating === 2) {
      const next = step + 1 < steps.length ? steps[step + 1] : steps[step] * 1.5;
      return learn(st, step, ((steps[step] + next) / 2) * 60);
    }
    if (rating === 3) {
      if (step + 1 < steps.length) return learn(st, step + 1, steps[step + 1] * 60);
      return toReview(relearn ? ivl : GRADUATING_IVL);
    }
    return toReview(relearn ? ivl + 1 : EASY_IVL);
  }

  // REVIEW
  if (rating === 1) {
    lapses += 1;
    ease = Math.max(1.3, ease - 0.2);
    ivl = Math.max(1, Math.round(ivl * 0.25));
    return learn(RELEARNING, 0, RELEARN_STEPS[0] * 60);
  }
  if (rating === 2) {
    ease = Math.max(1.3, ease - 0.15);
    return toReview(Math.max(ivl + 1, ivl * 1.2));
  }
  if (rating === 3) return toReview(Math.max(ivl + 1, ivl * ease));
  const days = Math.max(ivl + 2, ivl * ease * 1.3);
  ease += 0.15;
  return toReview(days);
}

const trimNum = (n) => n.toFixed(1).replace(/\.0$/, '');

export function fmtDays(days) {
  if (days < 30) return `${Math.round(days)} g`;
  if (days < 365) return `${trimNum(days / 30)} ay`;
  return `${trimNum(days / 365)} yıl`;
}

export function fmtSeconds(secs) {
  secs = Math.max(0, secs);
  if (secs < 60) return '<1 dk';
  if (secs < 3600) return `${Math.round(secs / 60)} dk`;
  if (secs < 86400) return `${Math.round(secs / 3600)} sa`;
  return fmtDays(secs / 86400);
}

export function previews(card, now) {
  const out = {};
  for (const r of [1, 2, 3, 4]) {
    const res = schedule(card, r, now, false);
    out[r] = res.state === REVIEW ? fmtDays(res.ivl) : fmtSeconds(res.due - now);
  }
  return out;
}

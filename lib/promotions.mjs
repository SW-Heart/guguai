/**
 * Time-limited recharge promotions.
 *
 * The server alone decides whether an order earns a bonus. An order created
 * inside the window records its bonus at creation time; the bonus is granted
 * when the payment settles, provided the payment arrives before the window
 * closes plus a short grace period (QR codes and cashier pages outlive the
 * click that opened them). Clients only display what this module returns.
 */

// Payments confirmed this long after the window closes still honour the
// bonus recorded on an order created inside the window.
export const PROMOTION_SETTLE_GRACE_MS = 30 * 60 * 1000;
const BASIS_POINTS = 10_000;

export const PROMOTIONS = Object.freeze([
  Object.freeze({
    id: 'black-friday-2026',
    title: '黑色星期五充值赠送',
    bonusBasisPoints: 1_000,
    // Beijing time: preview from 26 Nov, bonus for the whole of 27 Nov.
    previewAt: '2026-11-26T00:00:00+08:00',
    startsAt: '2026-11-27T00:00:00+08:00',
    endsAt: '2026-11-28T00:00:00+08:00',
  }),
]);

let clock = () => Date.now();

const at = value => Date.parse(value);
const nowMs = () => clock();

function findPromotion(id) {
  return PROMOTIONS.find(item => item.id === id) || null;
}

/** The promotion that is currently previewing or running, if any. */
export function currentPromotion(now = nowMs()) {
  return PROMOTIONS.find(item => now >= at(item.previewAt || item.startsAt) && now < at(item.endsAt)) || null;
}

/** The promotion that grants a bonus to an order created at `now`. */
export function activePromotion(now = nowMs()) {
  return PROMOTIONS.find(item => now >= at(item.startsAt) && now < at(item.endsAt)) || null;
}

export function bonusMicroFor(creditsMicro, promotion) {
  if (!promotion || !Number.isSafeInteger(creditsMicro) || creditsMicro <= 0) return 0;
  return Math.floor(creditsMicro * promotion.bonusBasisPoints / BASIS_POINTS);
}

/** Bonus snapshot written onto a new order. */
export function orderPromotion(creditsMicro, now = nowMs()) {
  const promotion = activePromotion(now);
  const bonusMicro = bonusMicroFor(creditsMicro, promotion);
  return bonusMicro > 0 ? { promotionId: promotion.id, bonusMicro } : { promotionId: null, bonusMicro: 0 };
}

/** Bonus to grant when an order settles now; 0 once the grace period passed. */
export function settlementBonusMicro(promotionId, bonusMicro, now = nowMs()) {
  const promotion = promotionId ? findPromotion(promotionId) : null;
  if (!promotion || !Number.isSafeInteger(bonusMicro) || bonusMicro <= 0) return 0;
  return now < at(promotion.endsAt) + PROMOTION_SETTLE_GRACE_MS ? bonusMicro : 0;
}

export function promotionNote(promotionId) {
  return findPromotion(promotionId)?.title || '充值活动赠送';
}

/** What clients may show; null hides every promotion surface. */
export function publicPromotion(now = nowMs()) {
  const promotion = currentPromotion(now);
  if (!promotion) return null;
  return {
    id: promotion.id,
    title: promotion.title,
    bonusRate: promotion.bonusBasisPoints / BASIS_POINTS,
    startsAt: new Date(at(promotion.startsAt)).toISOString(),
    endsAt: new Date(at(promotion.endsAt)).toISOString(),
    phase: now < at(promotion.startsAt) ? 'upcoming' : 'active',
    serverNow: new Date(now).toISOString(),
  };
}

export const __test = {
  setClock(fn) { clock = typeof fn === 'function' ? fn : () => Date.now(); },
};

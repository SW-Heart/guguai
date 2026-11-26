import assert from 'node:assert/strict';
import test from 'node:test';
import { compactCountdown, promotionBonusCredits, promotionCountdownParts, promotionWindowText } from '../public/features/promotions/recharge-promotion.js';
import { createCreditPresentation } from '../public/features/credits/presentation.js';

const promotion = { id: 'black-friday-2026', phase: 'active', bonusRate: 0.1, startsAt: '2026-11-26T16:00:00.000Z', endsAt: '2026-11-27T16:00:00.000Z' };

test('the window is shown in Beijing time with an inclusive last minute', () => {
  assert.equal(promotionWindowText(promotion), '11月27日 00:00 – 23:59（北京时间）');
});

test('countdowns stay readable in the narrow rail', () => {
  assert.deepEqual(promotionCountdownParts(3_725_000), { hours: 1, minutes: 2, seconds: 5 });
  assert.equal(compactCountdown(3_725_000), '01:02');
  assert.equal(compactCountdown(299_000), '04:59');
  assert.equal(compactCountdown(-5), '00:00');
});

test('bonus previews only while the promotion is running', () => {
  const inside = Date.parse('2026-11-27T02:00:00Z');
  assert.equal(promotionBonusCredits(1000, promotion, inside), 100);
  assert.equal(promotionBonusCredits(15, promotion, inside), 1.5);
  assert.equal(promotionBonusCredits(1000, { ...promotion, phase: 'upcoming' }, inside), 0);
  assert.equal(promotionBonusCredits(1000, promotion, Date.parse(promotion.endsAt)), 0);
  assert.equal(promotionBonusCredits(1000, null, inside), 0);
});

test('the bonus has its own label in the credit history', () => {
  const { creditEarnType } = createCreditPresentation();
  assert.equal(creditEarnType({ type: 'promotion_bonus' }), '充值活动赠送');
});

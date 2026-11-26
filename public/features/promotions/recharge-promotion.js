// Recharge promotion: a one-time popup, a compact rail entry with a countdown,
// and bonus hints for the purchase sheet. The server decides eligibility; this
// module only shows what /api/credits reports and hides itself when the
// promotion ends.

const pad = value => String(value).padStart(2, '0');
const beijingParts = iso => {
  const date = new Date(Date.parse(iso) + 8 * 3600_000);
  return { month: date.getUTCMonth() + 1, day: date.getUTCDate(), hour: date.getUTCHours(), minute: date.getUTCMinutes() };
};

export function promotionCountdownParts(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  return { hours: Math.floor(total / 3600), minutes: Math.floor(total / 60) % 60, seconds: total % 60 };
}

// Short countdown for the 48px rail entry: "12:05" above an hour, "04:59" below.
export function compactCountdown(ms) {
  const { hours, minutes, seconds } = promotionCountdownParts(ms);
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function promotionBonusCredits(credits, promotion, now) {
  if (!promotion || promotion.phase !== 'active' || !(now >= Date.parse(promotion.startsAt) && now < Date.parse(promotion.endsAt))) return 0;
  const value = Math.floor(Number(credits) * Number(promotion.bonusRate) * 1_000_000) / 1_000_000;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function promotionWindowText(promotion) {
  const start = beijingParts(promotion.startsAt);
  // endsAt is exclusive; show the last minute of the window.
  const end = beijingParts(new Date(Date.parse(promotion.endsAt) - 60_000).toISOString());
  const sameDay = start.month === end.month && start.day === end.day;
  return sameDay
    ? `${start.month}月${start.day}日 ${pad(start.hour)}:${pad(start.minute)} – ${pad(end.hour)}:${pad(end.minute)}（北京时间）`
    : `${start.month}月${start.day}日 ${pad(start.hour)}:${pad(start.minute)} – ${end.month}月${end.day}日 ${pad(end.hour)}:${pad(end.minute)}（北京时间）`;
}

const percentText = rate => `${Math.round(Number(rate) * 100)}%`;

const HERO_ART = `<svg class="promo-hero-art" viewBox="0 0 440 196" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="promoSky" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14123a"/><stop offset=".55" stop-color="#2b2580"/><stop offset="1" stop-color="#5b3fc4"/></linearGradient>
    <radialGradient id="promoGlow" cx=".5" cy=".62" r=".5"><stop offset="0" stop-color="#ffd27a" stop-opacity=".55"/><stop offset=".45" stop-color="#a78bfa" stop-opacity=".22"/><stop offset="1" stop-color="#6366f1" stop-opacity="0"/></radialGradient>
    <linearGradient id="promoGold" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff1c2"/><stop offset=".45" stop-color="#f8c95a"/><stop offset="1" stop-color="#d9932a"/></linearGradient>
    <linearGradient id="promoBox" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7c6cf6"/><stop offset="1" stop-color="#4338ca"/></linearGradient>
    <linearGradient id="promoBoxSide" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5a4bd8"/><stop offset="1" stop-color="#2e2696"/></linearGradient>
    <linearGradient id="promoLid" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#9b8cff"/><stop offset="1" stop-color="#6d5cf0"/></linearGradient>
    <linearGradient id="promoBeam" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#ffe6a3" stop-opacity=".75"/><stop offset="1" stop-color="#ffe6a3" stop-opacity="0"/></linearGradient>
    <pattern id="promoGrid" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0v22" fill="none" stroke="#ffffff" stroke-opacity=".05"/></pattern>
  </defs>
  <rect width="440" height="196" fill="url(#promoSky)"/>
  <rect width="440" height="196" fill="url(#promoGrid)"/>
  <ellipse cx="220" cy="128" rx="190" ry="96" fill="url(#promoGlow)"/>
  <g class="promo-orbit" fill="none" stroke="#c7d2fe" stroke-opacity=".22"><ellipse cx="220" cy="120" rx="150" ry="40"/><ellipse cx="220" cy="120" rx="188" ry="58" stroke-dasharray="2 7"/></g>
  <g class="promo-stars" fill="#ffffff">
    <circle cx="38" cy="30" r="1.4"/><circle cx="92" cy="58" r="1"/><circle cx="138" cy="22" r="1.6"/><circle cx="312" cy="26" r="1.2"/><circle cx="366" cy="54" r="1.6"/><circle cx="404" cy="24" r="1"/><circle cx="60" cy="150" r="1"/><circle cx="392" cy="150" r="1.3"/>
  </g>
  <path class="promo-beam" d="M196 112 168 0h104l-28 112Z" fill="url(#promoBeam)"/>
  <g class="promo-confetti">
    <rect x="74" y="92" width="7" height="3" rx="1.5" fill="#f8c95a" transform="rotate(-24 77 93)"/>
    <rect x="118" y="44" width="6" height="3" rx="1.5" fill="#f9a8d4" transform="rotate(30 121 45)"/>
    <rect x="330" y="88" width="7" height="3" rx="1.5" fill="#a5f3fc" transform="rotate(18 333 89)"/>
    <rect x="352" y="124" width="6" height="3" rx="1.5" fill="#f8c95a" transform="rotate(-36 355 125)"/>
    <circle cx="104" cy="122" r="2.4" fill="#a5b4fc"/><circle cx="300" cy="52" r="2.2" fill="#f8c95a"/><circle cx="148" cy="150" r="2" fill="#f9a8d4"/>
  </g>
  <g class="promo-coin promo-coin-a" transform="translate(112 74)"><circle r="15" fill="url(#promoGold)"/><circle r="10.5" fill="none" stroke="#b7791f" stroke-opacity=".45" stroke-width="1.6"/><path d="M0-6.5l1.9 4.1 4.6.5-3.4 3.1 1 4.5L0 3.4l-4.1 2.3 1-4.5-3.4-3.1 4.6-.5Z" fill="#c2841f" opacity=".75"/></g>
  <g class="promo-coin promo-coin-b" transform="translate(330 104)"><circle r="11" fill="url(#promoGold)"/><circle r="7.5" fill="none" stroke="#b7791f" stroke-opacity=".45" stroke-width="1.4"/></g>
  <g class="promo-coin promo-coin-c" transform="translate(290 40)"><circle r="7" fill="url(#promoGold)"/></g>
  <g class="promo-gift">
    <ellipse cx="220" cy="176" rx="66" ry="9" fill="#0b0a24" opacity=".45"/>
    <path d="M168 116h104v52a6 6 0 0 1-6 6h-92a6 6 0 0 1-6-6Z" fill="url(#promoBox)"/>
    <path d="M168 116h22v58h-16a6 6 0 0 1-6-6Z" fill="url(#promoBoxSide)" opacity=".7"/>
    <rect x="209" y="116" width="22" height="58" fill="url(#promoGold)"/>
    <g class="promo-lid"><rect x="160" y="100" width="120" height="20" rx="5" fill="url(#promoLid)"/><rect x="209" y="100" width="22" height="20" fill="url(#promoGold)"/>
      <path d="M220 100c-10-20-34-24-38-12-3 9 15 14 38 12Z" fill="url(#promoGold)"/><path d="M220 100c10-20 34-24 38-12 3 9-15 14-38 12Z" fill="url(#promoGold)"/>
      <circle cx="220" cy="99" r="6" fill="#f2b441"/></g>
    <path d="M176 122h10v4h-10z" fill="#fff" opacity=".18"/>
  </g>
  <g transform="translate(304 150)"><g class="promo-badge">
    <circle r="30" fill="url(#promoGold)"/><circle r="25" fill="none" stroke="#fff7d6" stroke-opacity=".75" stroke-dasharray="2 3"/>
    <text y="7" text-anchor="middle" fill="#5b2c05" font-size="19" font-weight="800" font-family="Inter, 'PingFang SC', sans-serif" data-promo-badge>+10%</text>
  </g></g>
  <g class="promo-sparkles" fill="#fff6d6">
    <path d="M150 104l2.2 5.8 5.8 2.2-5.8 2.2-2.2 5.8-2.2-5.8-5.8-2.2 5.8-2.2Z"/><path d="M286 82l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4-4.4-1.6 4.4-1.6Z"/><path d="M252 30l1.2 3.3 3.3 1.2-3.3 1.2-1.2 3.3-1.2-3.3-3.3-1.2 3.3-1.2Z"/>
  </g>
</svg>`;

const GIFT_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/></svg>';
const CLOSE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export function createRechargePromotion({ openPurchase, getUserId, onChange = () => {}, storage = globalThis.localStorage, root = document } = {}) {
  let promotion = null;
  let offset = 0;
  let timer = 0;
  let dialog = null;
  let railButton = null;
  let autoOpenPending = false;

  const now = () => Date.now() + offset;
  const seenKey = () => promotion ? `gugu-promotion-seen:${promotion.id}:${promotion.phase}:${getUserId?.() || 'guest'}` : '';
  const hasSeen = () => { try { return storage?.getItem(seenKey()) === '1'; } catch { return false; } };
  const markSeen = () => { try { storage?.setItem(seenKey(), '1'); } catch {} };

  function ensureElements() {
    if (dialog) return;
    dialog = root.createElement('dialog');
    dialog.id = 'rechargePromotionDialog';
    dialog.className = 'promo-dialog';
    dialog.setAttribute('aria-labelledby', 'rechargePromotionTitle');
    dialog.hidden = true;
    dialog.innerHTML = `<div class="promo-card">
      <div class="promo-hero">${HERO_ART}<span class="promo-hero-brand" aria-hidden="true"><span class="brand-gem"></span></span><button class="promo-close" type="button" data-promo-minimize aria-label="收起活动">${CLOSE_ICON}</button></div>
      <div class="promo-body">
        <h2 id="rechargePromotionTitle" class="promo-title"></h2>
        <p class="promo-lead" data-promo-lead></p>
        <dl class="promo-facts">
          <div><dt>活动时间</dt><dd data-promo-window></dd></div>
          <div><dt>活动内容</dt><dd data-promo-content></dd></div>
          <div><dt>举个例子</dt><dd data-promo-example></dd></div>
        </dl>
        <div class="promo-countdown" role="timer" aria-live="off"><span class="promo-countdown-label" data-promo-countdown-label></span><span class="promo-countdown-digits"><b data-promo-h>00</b><i>:</i><b data-promo-m>00</b><i>:</i><b data-promo-s>00</b></span></div>
        <p class="promo-note">赠送积分与充值积分同时到账。申请退款时，赠送积分将一并扣回。</p>
        <div class="promo-actions"><button class="secondary-button promo-later" type="button" data-promo-minimize>稍后再说</button><button class="promo-join" type="button" data-promo-join></button></div>
      </div>
    </div>`;
    root.body.append(dialog);
    dialog.addEventListener('cancel', event => { event.preventDefault(); minimize(); });
    dialog.addEventListener('click', event => {
      if (event.target === dialog) minimize();
      else if (event.target.closest('[data-promo-minimize]')) minimize();
      else if (event.target.closest('[data-promo-join]')) join();
    });

    railButton = root.createElement('button');
    railButton.id = 'rechargePromotionButton';
    railButton.type = 'button';
    railButton.className = 'rail-promo-button hidden';
    railButton.setAttribute('aria-haspopup', 'dialog');
    railButton.setAttribute('aria-controls', 'rechargePromotionDialog');
    railButton.innerHTML = `<span class="rail-promo-icon">${GIFT_ICON}</span><span class="rail-promo-rate" data-promo-rail-rate></span><span class="rail-promo-time" data-promo-rail-time></span>`;
    railButton.addEventListener('click', () => open());
    const footer = root.querySelector('#appRail .rail-footer');
    footer?.prepend(railButton);
  }

  function remaining() {
    if (!promotion) return 0;
    return Date.parse(promotion.phase === 'upcoming' ? promotion.startsAt : promotion.endsAt) - now();
  }

  function render() {
    if (!promotion) return;
    ensureElements();
    const rate = percentText(promotion.bonusRate);
    const active = promotion.phase === 'active';
    dialog.querySelector('#rechargePromotionTitle').textContent = `黑色星期五 · 充值多送 ${rate}`;
    const start = beijingParts(promotion.startsAt);
    dialog.querySelector('[data-promo-lead]').textContent = active
      ? `活动进行中，活动期间每笔充值都额外赠送 ${rate} 积分。`
      : `${start.month}月${start.day}日充值，每笔都额外赠送 ${rate} 积分，记得来看看。`;
    dialog.querySelector('[data-promo-window]').textContent = promotionWindowText(promotion);
    dialog.querySelector('[data-promo-content]').textContent = `活动期间充值，按到账积分额外赠送 ${rate}，不限次数。`;
    const exampleCredits = 1000;
    dialog.querySelector('[data-promo-example]').textContent = `充值 100 元，到账 ${exampleCredits} 积分，另赠 ${Math.floor(exampleCredits * promotion.bonusRate)} 积分`;
    dialog.querySelector('[data-promo-countdown-label]').textContent = active ? '距活动结束' : '距活动开始';
    dialog.querySelector('[data-promo-badge]').textContent = `+${rate}`;
    dialog.querySelector('[data-promo-join]').textContent = active ? '参加活动' : '知道了';
    dialog.dataset.phase = promotion.phase;
    railButton.dataset.phase = promotion.phase;
    railButton.querySelector('[data-promo-rail-rate]').textContent = `+${rate}`;
    tick();
  }

  function tick() {
    if (!promotion) return;
    if (now() >= Date.parse(promotion.endsAt)) { setPromotion(null); onChange(); return; }
    if (promotion.phase === 'upcoming' && now() >= Date.parse(promotion.startsAt)) {
      promotion = { ...promotion, phase: 'active' };
      autoOpenPending = !hasSeen();
      render();
      onChange();
      return;
    }
    const left = remaining();
    const { hours, minutes, seconds } = promotionCountdownParts(left);
    dialog.querySelector('[data-promo-h]').textContent = pad(hours);
    dialog.querySelector('[data-promo-m]').textContent = pad(minutes);
    dialog.querySelector('[data-promo-s]').textContent = pad(seconds);
    const short = compactCountdown(left);
    railButton.querySelector('[data-promo-rail-time]').textContent = short;
    const tip = promotion.phase === 'active'
      ? `黑五充值多送 ${percentText(promotion.bonusRate)} · 剩余 ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
      : `黑五活动 · ${pad(hours)}:${pad(minutes)}:${pad(seconds)} 后开始`;
    railButton.dataset.railTip = tip;
    railButton.setAttribute('aria-label', tip);
    if (autoOpenPending && !root.querySelector('dialog[open]')) { autoOpenPending = false; open(); }
  }

  function open() {
    if (!promotion) return;
    ensureElements();
    markSeen();
    autoOpenPending = false;
    railButton.setAttribute('aria-expanded', 'true');
    dialog.hidden = false;
    if (!dialog.open) dialog.showModal();
    requestAnimationFrame(() => dialog.querySelector('[data-promo-join]')?.focus());
  }

  function close() {
    if (!dialog?.open) return;
    dialog.close();
    dialog.hidden = true;
    railButton?.setAttribute('aria-expanded', 'false');
  }

  // Shrinks the card towards its rail entry so people see where it went.
  function minimize({ then } = {}) {
    if (!dialog?.open) { then?.(); return; }
    const target = railButton && !railButton.classList.contains('hidden') ? railButton.getBoundingClientRect() : null;
    const card = dialog.querySelector('.promo-card');
    const reduce = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (!target || !target.width || !card?.animate || reduce) { close(); then?.(); return; }
    const from = card.getBoundingClientRect();
    const dx = target.left + target.width / 2 - (from.left + from.width / 2);
    const dy = target.top + target.height / 2 - (from.top + from.height / 2);
    dialog.classList.add('is-minimizing');
    const animation = card.animate([
      { transform: 'translate(0,0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px,${dy}px) scale(.08)`, opacity: .2 },
    ], { duration: 360, easing: 'cubic-bezier(.5,0,.75,.2)' });
    const finish = () => {
      dialog.classList.remove('is-minimizing');
      close();
      railButton?.animate?.([{ transform: 'scale(1)' }, { transform: 'scale(1.12)' }, { transform: 'scale(1)' }], { duration: 320, easing: 'ease-out' });
      then?.();
    };
    animation.onfinish = finish;
    animation.oncancel = finish;
  }

  function join() {
    if (promotion?.phase !== 'active') { minimize(); return; }
    minimize({ then: () => openPurchase?.() });
  }

  function setPromotion(next) {
    const valid = next && Number.isFinite(Date.parse(next.startsAt)) && Number.isFinite(Date.parse(next.endsAt));
    if (!valid) {
      promotion = null;
      window.clearInterval(timer);
      timer = 0;
      close();
      railButton?.classList.add('hidden');
      return;
    }
    const serverNow = Date.parse(next.serverNow);
    if (Number.isFinite(serverNow)) offset = serverNow - Date.now();
    const changed = promotion?.id !== next.id || promotion?.phase !== next.phase;
    promotion = { ...next };
    ensureElements();
    railButton.classList.remove('hidden');
    if (changed) autoOpenPending = !hasSeen();
    render();
    if (!timer) timer = window.setInterval(tick, 1000);
  }

  return Object.freeze({
    update(next) {
      const before = promotion?.phase || null;
      setPromotion(next || null);
      if ((promotion?.phase || null) !== before) onChange();
    },
    bonusFor(credits) { return promotionBonusCredits(credits, promotion, now()); },
    rateText() { return promotion ? percentText(promotion.bonusRate) : ''; },
    isActive() { return promotion?.phase === 'active' && now() < Date.parse(promotion.endsAt); },
    reset() { setPromotion(null); offset = 0; },
    open,
  });
}

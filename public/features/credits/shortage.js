// Every paid action that finds the wallet short ends the same way: say so,
// then open the purchase dialog. Only our own ledger answers 402; an upstream
// provider running out of balance is a service failure and never lands here.
export const INSUFFICIENT_CREDITS_STATUS = 402;
export const CREDIT_SHORTAGE_DELAY_MS = 900;

export function isInsufficientCreditsError(error) {
  return Number(error?.status) === INSUFFICIENT_CREDITS_STATUS;
}

export function createCreditShortagePrompt({
  toast,
  openPurchase,
  isPurchaseOpen = () => false,
  delayMs = CREDIT_SHORTAGE_DELAY_MS,
  setTimer = (callback, ms) => setTimeout(callback, ms),
  clearTimer = timer => clearTimeout(timer),
} = {}) {
  let timer = null;

  function notify(message) {
    // Several requests can come back short at once; one prompt is enough.
    if (timer !== null || isPurchaseOpen()) return false;
    toast(String(message || '').trim() || '积分不足，请充值后继续');
    timer = setTimer(() => {
      timer = null;
      if (!isPurchaseOpen()) openPurchase();
    }, delayMs);
    return true;
  }

  function cancel() {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  }

  return Object.freeze({ notify, cancel });
}

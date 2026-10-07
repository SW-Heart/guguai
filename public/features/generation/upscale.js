// Video upscale rules shared by the workbench and the server. The upstream
// service always doubles both sides, accepts sources up to 1080p and rejects
// oversized sources only after queueing, so both sides validate up front.
export const VIDEO_UPSCALE_MODEL_ID = 'video-upscale';
export const VIDEO_UPSCALE_PROVIDER = 'aliyun-vsr';
export const VIDEO_UPSCALE_FACTOR = 2;
export const VIDEO_UPSCALE_CREDITS_PER_SECOND = 1;
export const VIDEO_UPSCALE_PRICE_QUALITY = '2 倍';
export const VIDEO_UPSCALE_LIMITS = Object.freeze({
  minShortSide: 361,
  maxLongSide: 1920,
  maxShortSide: 1080,
  maxBytes: 1024 * 1024 * 1024,
  maxDurationSeconds: 120,
});

function dimension(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= 16_384 ? number : 0;
}

export function videoUpscaleLabel(width, height) {
  const shortSide = Math.min(dimension(width), dimension(height));
  if (!shortSide) return '';
  if (shortSide >= 2160) return '4K';
  if (shortSide >= 1440) return '2K';
  return `${shortSide}p`;
}

export function videoUpscalePlan({ width, height, duration } = {}) {
  const sourceWidth = dimension(width);
  const sourceHeight = dimension(height);
  if (!sourceWidth || !sourceHeight) return { eligible:false, reason:'暂时无法读取视频尺寸，请稍后重试' };
  const longSide = Math.max(sourceWidth, sourceHeight);
  const shortSide = Math.min(sourceWidth, sourceHeight);
  if (longSide > VIDEO_UPSCALE_LIMITS.maxLongSide || shortSide > VIDEO_UPSCALE_LIMITS.maxShortSide) {
    return { eligible:false, reason:'这个视频已经是高清画质，无需再放大', sourceWidth, sourceHeight };
  }
  if (shortSide < VIDEO_UPSCALE_LIMITS.minShortSide) return { eligible:false, reason:'视频尺寸过小，暂不支持放大', sourceWidth, sourceHeight };
  const seconds = Number(duration);
  if (duration !== undefined && (!Number.isFinite(seconds) || seconds <= 0)) return { eligible:false, reason:'暂时无法读取视频时长，请稍后重试', sourceWidth, sourceHeight };
  if (seconds > VIDEO_UPSCALE_LIMITS.maxDurationSeconds) return { eligible:false, reason:`视频超过 ${VIDEO_UPSCALE_LIMITS.maxDurationSeconds} 秒，暂不支持放大`, sourceWidth, sourceHeight };
  const outputWidth = sourceWidth * VIDEO_UPSCALE_FACTOR;
  const outputHeight = sourceHeight * VIDEO_UPSCALE_FACTOR;
  return {
    eligible:true,
    sourceWidth,
    sourceHeight,
    outputWidth,
    outputHeight,
    label:videoUpscaleLabel(outputWidth, outputHeight),
    // Encoded files run a few frames past their nominal length (5.04s for a
    // 5s video), so bill by the nearest whole second.
    ...(duration === undefined ? {} : { billedSeconds:Math.max(1, Math.round(seconds)) }),
  };
}

// Output bitrate in Mbps. Higher resolutions need more bits to keep the
// restored detail; the upstream service accepts 1-20.
export function videoUpscaleBitRate(outputWidth, outputHeight) {
  const shortSide = Math.min(dimension(outputWidth), dimension(outputHeight));
  if (shortSide >= 2000) return 20;
  if (shortSide >= 1400) return 12;
  return 10;
}

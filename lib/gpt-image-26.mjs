export const GPT_IMAGE_26_MODEL_ID = 'gpt-image-2.6';
export const GPT_IMAGE_26_CREDITS = 1;
export const GPT_IMAGE_26_QUALITIES = Object.freeze(['1k', '2k', '4k']);
// Exact pixel sizes accepted upstream; other sizes are rejected.
export const GPT_IMAGE_26_DIMENSIONS = Object.freeze({
  '1:1':  Object.freeze({ '1k':'1024x1024', '2k':'2048x2048', '4k':'3840x3840' }),
  '4:3':  Object.freeze({ '1k':'1152x896',  '2k':'2048x1536', '4k':'3840x2880' }),
  '3:4':  Object.freeze({ '1k':'896x1152',  '2k':'1536x2048', '4k':'2880x3840' }),
  '16:9': Object.freeze({ '1k':'1536x864',  '2k':'2048x1152', '4k':'3840x2160' }),
  '9:16': Object.freeze({ '1k':'864x1536',  '2k':'1152x2048', '4k':'2160x3840' }),
  '3:2':  Object.freeze({ '1k':'1536x1024', '2k':'2048x1360', '4k':'3840x2560' }),
  '2:3':  Object.freeze({ '1k':'1024x1536', '2k':'1360x2048', '4k':'2560x3840' }),
  '5:4':  Object.freeze({ '1k':'1280x1024', '2k':'2560x2048', '4k':'3840x3072' }),
  '4:5':  Object.freeze({ '1k':'1024x1280', '2k':'2048x2560', '4k':'3072x3840' }),
});
export const GPT_IMAGE_26_ASPECTS = Object.freeze(Object.keys(GPT_IMAGE_26_DIMENSIONS));

export function gptImage26Size(aspect = '1:1', quality = '1k') {
  return GPT_IMAGE_26_DIMENSIONS[String(aspect)]?.[String(quality || '1k').toLowerCase()] || '';
}

// Accepts an aspect ratio or one of the exact pixel sizes above.
export function gptImage26Selection(size = '1:1', quality = '') {
  const value = String(size || '1:1').trim().toLowerCase();
  if (GPT_IMAGE_26_DIMENSIONS[value]) return { aspect:value, quality:String(quality || '1k').toLowerCase() };
  for (const [aspect, tiers] of Object.entries(GPT_IMAGE_26_DIMENSIONS)) {
    const tier = Object.keys(tiers).find(key => tiers[key] === value);
    if (tier) return { aspect, quality:String(quality || tier).toLowerCase(), pixelTier:tier };
  }
  return null;
}

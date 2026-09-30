// Electron's net.fetch copies response headers into Node's Headers. A header
// containing a character outside ByteString throws from Electron's response
// event handler, outside the caller's try/catch.
const byteString = /^[\u0000-\u00ff]*$/u;

export function sanitizeResponseHeaders(responseHeaders) {
  if (!responseHeaders) return null;
  let safeHeaders = null;
  const removedNames = [];
  for (const [name, values] of Object.entries(responseHeaders)) {
    if (!Array.isArray(values)) continue;
    const safeValues = values.filter(value => typeof value === 'string' && byteString.test(value));
    if (safeValues.length === values.length) continue;
    safeHeaders ||= { ...responseHeaders };
    if (safeValues.length) safeHeaders[name] = safeValues;
    else delete safeHeaders[name];
    removedNames.push(name);
  }
  return safeHeaders ? { responseHeaders:safeHeaders, removedNames } : null;
}

export function installResponseHeaderGuard(webRequest, onRemoved = () => {}) {
  webRequest.onHeadersReceived({ urls:['*://*/*'] }, (details, callback) => {
    const sanitized = sanitizeResponseHeaders(details.responseHeaders);
    if (!sanitized) return callback({});
    try { onRemoved(details.url, sanitized.removedNames); } catch {}
    callback({ responseHeaders:sanitized.responseHeaders });
  });
}

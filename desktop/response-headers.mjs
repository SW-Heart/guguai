// Electron's net.fetch copies response headers into Node's Headers. A header
// containing a character outside ByteString throws from Electron's response
// event handler, outside the caller's try/catch.
const byteString = /^[\u0000-\u00ff]*$/u;
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const invalidValue = /[\u0000\r\n]/;

export function sanitizeResponseHeaders(responseHeaders) {
  if (!responseHeaders) return null;
  let safeHeaders = null;
  const removedNames = [];
  for (const [name, values] of Object.entries(responseHeaders)) {
    const safeValues = headerName.test(name) && Array.isArray(values)
      ? values.filter(value => typeof value === 'string' && byteString.test(value) && !invalidValue.test(value))
      : [];
    if (Array.isArray(values) && safeValues.length === values.length && headerName.test(name)) continue;
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

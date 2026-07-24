// Renders a caught error into a line that is never blank.
//
// The usual `error.response?.data || error.message` idiom silently loses the only field that
// identifies a network failure: axios puts the HTTP body on `response.data` (present only when a
// response actually arrived) and the cause of a transport failure on `error.code` (ETIMEDOUT,
// ECONNABORTED, EAI_AGAIN, ECONNREFUSED...). When a request never reaches Twitch at all there is
// no `response`, and the message can be empty - which is exactly how the 2026-07-24 outage logged
// itself as a bare `Error User Token:` with nothing after the colon, hiding the cause for a day.
function describeError(error) {
  if (!error) return 'unknown error';

  const parts = [];
  if (error.code) parts.push(error.code);
  if (error.response) {
    const data = error.response.data;
    parts.push(`HTTP ${error.response.status}${data ? ' ' + safeStringify(data) : ''}`);
  }
  if (error.message) parts.push(error.message);

  return parts.length ? parts.join(' | ') : String(error);
}

function safeStringify(value) {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

module.exports = describeError;

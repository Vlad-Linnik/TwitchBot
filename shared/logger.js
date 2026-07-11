// Patches console.log/warn/error to prefix every line with a timestamp, so pm2 logs
// (which don't add their own timestamps) stay readable. Must be required before any
// other module so early startup logs (e.g. dotenv's own output) get stamped too.
const pad = (n) => String(n).padStart(2, '0');

function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

['log', 'warn', 'error'].forEach((method) => {
  const original = console[method].bind(console);
  console[method] = (...args) => original(`[${timestamp()}]`, ...args);
});
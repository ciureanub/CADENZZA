/**
 * Offline guard. Preload it to make any non-loopback connection or DNS lookup throw:
 *   node --import ./infra/offline-guard.mjs bin/cadenzza.js doctor
 * Covers net/tls sockets (and therefore fetch/undici and the mongodb driver) and dns.
 * Every blocked attempt is printed to stderr and makes the process exit non-zero.
 */
import net from 'node:net';
import dns from 'node:dns';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const isLoopback = (h) => h == null || LOOPBACK_HOSTS.has(String(h).toLowerCase()) || /^127\./.test(h) || /^::ffff:127\./.test(h);

let blocked = 0;
function deny(what, host) {
  blocked++;
  process.exitCode = 3;
  const err = new Error(`offline-guard: blocked ${what} to ${host}`);
  process.stderr.write(`${err.message}\n`);
  return err;
}

/* sockets: net.Socket#connect(options | port, host | path) */
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const a = args[0];
  const host = Array.isArray(a) ? a[0]?.host : typeof a === 'object' ? (a.path ? null : a.host) : typeof args[1] === 'string' ? args[1] : null;
  if (!isLoopback(host ?? 'localhost')) {
    const err = deny('connect', host);
    process.nextTick(() => this.destroy(err));
    return this;
  }
  return connect.apply(this, args);
};

/* dns: callback and promise APIs */
const lookup = dns.lookup;
dns.lookup = function (host, ...rest) {
  if (!isLoopback(host)) {
    const cb = rest.find((x) => typeof x === 'function');
    const err = deny('dns.lookup', host);
    if (cb) return process.nextTick(() => cb(err));
    throw err;
  }
  return lookup.call(this, host, ...rest);
};
const plookup = dns.promises.lookup;
dns.promises.lookup = async function (host, ...rest) {
  if (!isLoopback(host)) throw deny('dns.promises.lookup', host);
  return plookup.call(this, host, ...rest);
};

process.on('exit', () => {
  process.stderr.write(`offline-guard: ${blocked} outbound attempt(s) blocked\n`);
});

// Preloaded (node --import) into every offline test process, including forked children:
// any socket connection to a non-loopback address, and any DNS lookup for a non-loopback name, throws.
import dns from "node:dns";
import net from "node:net";

const isLoopback = (host: unknown): boolean =>
  typeof host !== "string" || host === "" || host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host);

const target = (args: unknown[]): { host: unknown; unix: boolean } => {
  // net.connect() hands Socket#connect a pre-normalised array `[options, cb]`, not the options object itself.
  const a0 = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (a0 !== null && typeof a0 === "object") {
    const o = a0 as { path?: string; host?: unknown };
    return { host: o.host, unix: typeof o.path === "string" };
  }
  if (typeof a0 === "string" && Number.isNaN(Number(a0))) return { host: undefined, unix: true };
  return { host: typeof args[1] === "string" ? args[1] : undefined, unix: false };
};

// eslint-disable-next-line @typescript-eslint/unbound-method -- re-applied with the original `this` below
const realConnect = net.Socket.prototype.connect as unknown as (this: net.Socket, ...a: unknown[]) => net.Socket;
net.Socket.prototype.connect = function patched(this: net.Socket, ...args: unknown[]): net.Socket {
  const t = target(args);
  if (!t.unix && !isLoopback(t.host)) throw new Error(`no-network guard: refused connection to ${String(t.host)}`);
  return realConnect.apply(this, args);
};

const realLookup = dns.lookup as (...a: unknown[]) => unknown;
dns.lookup = function patched(hostname: string, ...rest: unknown[]): unknown {
  if (!isLoopback(hostname)) throw new Error(`no-network guard: refused DNS lookup of ${hostname}`);
  return realLookup(hostname, ...rest);
} as typeof dns.lookup;

// cdp.js — a WebSocket client and a Chrome DevTools Protocol session, with no
// dependency.
//
// The whole of RFC 6455 that CDP needs is one asymmetry: frames a client sends
// are masked, frames a server sends are not. That is ~120 lines, which is why
// this is here rather than behind `ws` or `puppeteer` — a package that pulls a
// browser binary into `node_modules` is not something a zero-dependency factory
// can install to take a screenshot.
//
// It is Node and not the kernel for two reasons. Taking a screenshot is one
// round trip, not a hot loop, so there is nothing for Rust to win. And deciding
// whether a frame came back blank means inflating the PNG, which the kernel
// cannot do without a crate and will not hand-roll a DEFLATE decoder for.
import net from "node:net";
import crypto from "node:crypto";

const FIN = 0x80;
const TEXT = 0x1;
const CLOSE = 0x8;
const PING = 0x9;
const PONG = 0xa;

/** Text frames only, which is all CDP speaks. */
export class WS {
  constructor(url, { timeout = 15000 } = {}) {
    const m = /^ws:\/\/([^/:]+):(\d+)(\/.*)$/.exec(String(url));
    if (!m) throw new Error(`not a ws:// url: ${url}`);
    this.host = m[1]; this.port = Number(m[2]); this.path = m[3];
    this.timeout = timeout;
    this.buf = Buffer.alloc(0);
    this.sock = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: this.host, port: this.port }, () => {
        const key = crypto.randomBytes(16).toString("base64");
        sock.write(
          `GET ${this.path} HTTP/1.1\r\nHost: ${this.host}:${this.port}\r\n` +
          `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      });
      sock.setTimeout(this.timeout);
      sock.on("timeout", () => { sock.destroy(); reject(new Error(`ws timeout to ${this.host}:${this.port}`)); });
      sock.on("error", reject);
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf("\r\n\r\n");
        if (end < 0) return;
        const status = head.subarray(0, head.indexOf("\r\n")).toString();
        if (!/ 101 /.test(status)) { sock.destroy(); reject(new Error(`ws upgrade refused: ${status}`)); return; }
        sock.removeListener("data", onData);
        this.buf = head.subarray(end + 4);
        this.sock = sock;
        sock.on("data", (c) => { this.buf = Buffer.concat([this.buf, c]); this._drain(); });
        resolve(this);
      };
      sock.on("data", onData);
    });
  }

  send(obj) {
    const payload = Buffer.from(JSON.stringify(obj));
    const n = payload.length;
    const head = n < 126 ? Buffer.from([FIN | TEXT, 0x80 | n])
      : n < 65536 ? Buffer.concat([Buffer.from([FIN | TEXT, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; })()])
        : Buffer.concat([Buffer.from([FIN | TEXT, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(n)); return b; })()]);
    const mask = crypto.randomBytes(4);
    const masked = Buffer.alloc(n);
    for (let i = 0; i < n; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.sock.write(Buffer.concat([head, mask, masked]));
  }

  /** Pull whole messages out of the buffer. A large accessibility tree arrives
   *  fragmented, so continuation frames are reassembled rather than assumed
   *  away — the bug that would otherwise appear only on big pages. */
  _drain() {
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1];
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (this.buf.length < off + len) return;
      const payload = this.buf.subarray(off, off + len);
      this.buf = this.buf.subarray(off + len);
      if (opcode === CLOSE) { this._closed = true; this.sock?.destroy(); return; }
      if (opcode === PING) { this.sock.write(Buffer.from([FIN | PONG, 0])); continue; }
      this._frag = (this._frag || Buffer.alloc(0));
      this._frag = Buffer.concat([this._frag, payload]);
      if (!(b0 & FIN)) continue;
      const text = this._frag.toString("utf8");
      this._frag = Buffer.alloc(0);
      let msg;
      try { msg = JSON.parse(text); } catch { continue; }
      (this.onMessage || (() => {}))(msg);
    }
  }

  close() { try { this.sock?.destroy(); } catch { /* already gone */ } }
}

async function getJson(host, port, path, timeout) {
  const body = await new Promise((resolve, reject) => {
    const sock = net.connect({ host, port }, () => sock.write(`GET ${path} HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: close\r\n\r\n`));
    sock.setTimeout(timeout);
    sock.on("timeout", () => { sock.destroy(); reject(new Error(`no CDP endpoint at ${host}:${port}`)); });
    sock.on("error", (e) => reject(new Error(e.code === "ECONNREFUSED" ? `nothing is listening on ${host}:${port}` : e.message)));
    let raw = Buffer.alloc(0);
    // Chrome's DevTools HTTP endpoint does NOT honour `Connection: close`, so
    // waiting for `end` waits for the timeout on a response that already
    // arrived. Content-Length is the only thing that says when the body is
    // whole; `end` stays as the fallback for a server that omits it.
    const done = () => {
      const i = raw.indexOf("\r\n\r\n");
      resolve(i < 0 ? raw.toString("utf8") : raw.subarray(i + 4).toString("utf8"));
      sock.destroy();
    };
    sock.on("data", (c) => {
      raw = Buffer.concat([raw, c]);
      const i = raw.indexOf("\r\n\r\n");
      if (i < 0) return;
      const head = raw.subarray(0, i).toString("latin1");
      const m = /content-length:\s*(\d+)/i.exec(head);
      if (m && raw.length - (i + 4) >= Number(m[1])) done();
    });
    sock.on("end", done);
  });
  return JSON.parse(body);
}

/** One CDP session against one page. */
export class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiting = new Map(); ws.onMessage = (m) => this._on(m); }

  _on(m) {
    if (m.id && this.waiting.has(m.id)) {
      const { resolve, reject, timer } = this.waiting.get(m.id);
      clearTimeout(timer);
      this.waiting.delete(m.id);
      if (m.error) reject(new Error(`${m.error.message || JSON.stringify(m.error)}`));
      else resolve(m.result || {});
      return;
    }
    // A CDP message with no `id` is an EVENT, and this dropped every one of
    // them. `Page.captureScreenshot` is a call and needed nothing else; a
    // console error is only ever an event, so there was no way to observe one
    // and the whole class of "the screen rendered and the page threw" was
    // invisible. A caller that wants events sets `onEvent`; one that does not
    // is unaffected, and a listener that throws must not take the session down
    // with it.
    if (!m.id && m.method && this.onEvent) {
      try { this.onEvent(m.method, m.params || {}); } catch { /* a listener is a courtesy */ }
    }
  }

  call(method, params = {}, { timeout = 30000 } = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`${method} timed out after ${timeout}ms`)); }, timeout);
      this.waiting.set(id, { resolve, reject, timer });
      try { this.ws.send({ id, method, params }); }
      catch (e) { clearTimeout(timer); this.waiting.delete(id); reject(e); }
    });
  }

  close() { for (const { timer } of this.waiting.values()) clearTimeout(timer); this.ws.close(); }
}

/** The pages an endpoint is serving. */
export async function targets({ host = "127.0.0.1", port = 9222, timeout = 5000 } = {}) {
  const list = await getJson(host, port, "/json/list", timeout);
  return (Array.isArray(list) ? list : []).filter((t) => t.type === "page")
    .map((t) => ({ id: t.id, title: t.title, url: t.url, ws: t.webSocketDebuggerUrl }));
}

export async function version({ host = "127.0.0.1", port = 9222, timeout = 5000 } = {}) {
  const v = await getJson(host, port, "/json/version", timeout);
  return { browser: v.Browser, protocol: v["Protocol-Version"] };
}

/** Open a session on a page, creating one if `url` is given and no page
 *  matches. Returns the session and the target it attached to. */
export async function attach({ host = "127.0.0.1", port = 9222, url = "", timeout = 15000 } = {}) {
  let list = await targets({ host, port, timeout: Math.min(timeout, 5000) });
  if (!list.length) {
    await getJson(host, port, `/json/new?${encodeURIComponent(url || "about:blank")}`, timeout).catch(() => null);
    list = await targets({ host, port, timeout: Math.min(timeout, 5000) });
  }
  if (!list.length) throw new Error(`no page target at ${host}:${port}`);
  const target = list[0];
  const ws = await new WS(target.ws, { timeout }).connect();
  return { session: new Session(ws), target };
}

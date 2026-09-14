//! http.rs — a minimal HTTP/1.1 client over TcpStream.
//!
//! `http://` only. TLS would mean a dependency and the kernel must build
//! offline with nothing but rustc and cargo, so the scheme is checked by the
//! caller and `https://` is routed to the JS runner, which has fetch. That is
//! the right split anyway: the kernel's job is thousands of fast local calls
//! against a mirror or a dev service, and those are plaintext on loopback.
//!
//! Connections are reused when the response says they can be, because a
//! simulation that opens a socket per request measures the kernel's TCP
//! handshake rate rather than the service's throughput. A reused connection
//! that the server closed between requests is retried once on a fresh socket:
//! without that, every idle-timeout on the far side reads as a failed request.
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub struct Url { pub scheme: String, pub host: String, pub port: u16, pub path: String }

pub fn parse_url(s: &str) -> Result<Url, String> {
    let s = s.trim();
    let (scheme, rest) = match s.find("://") { Some(i) => (s[..i].to_lowercase(), &s[i + 3..]), None => ("http".to_string(), s) };
    let (hostport, path) = match rest.find('/') { Some(i) => (&rest[..i], rest[i..].to_string()), None => (rest, "/".to_string()) };
    let hostport = match hostport.rfind('@') { Some(i) => &hostport[i + 1..], None => hostport };
    let default_port = if scheme == "https" { 443 } else { 80 };
    let (host, port) = if let Some(end) = hostport.strip_prefix('[').and_then(|r| r.find(']').map(|i| i + 1)) {
        // [::1]:8080 — the colons inside the brackets are the address, not the port.
        let h = hostport[1..end].to_string();
        let p = hostport[end + 1..].strip_prefix(':').and_then(|d| d.parse::<u16>().ok()).unwrap_or(default_port);
        (h, p)
    } else {
        match hostport.rfind(':') {
            Some(i) if !hostport[i + 1..].is_empty() && hostport[i + 1..].bytes().all(|c| c.is_ascii_digit()) =>
                (hostport[..i].to_string(), hostport[i + 1..].parse::<u16>().map_err(|e| e.to_string())?),
            _ => (hostport.to_string(), default_port),
        }
    };
    if host.is_empty() { return Err(format!("no host in {:?}", s)); }
    Ok(Url { scheme, host, port, path })
}

pub struct Resp { pub status: u16, pub headers: Vec<(String, String)>, pub body: String, pub ms: f64 }

impl Resp {
    pub fn header(&self, name: &str) -> Option<&str> {
        let n = name.to_ascii_lowercase();
        self.headers.iter().find(|(k, _)| k.to_ascii_lowercase() == n).map(|(_, v)| v.as_str())
    }
    /// `Retry-After` in seconds. Only the delta-seconds form; an HTTP-date is
    /// reported as None rather than guessed, and the caller uses its own backoff.
    pub fn retry_after(&self) -> Option<f64> { self.header("retry-after").and_then(|v| v.trim().parse::<f64>().ok()) }
}

pub struct Conn {
    host: String,
    port: u16,
    timeout: Duration,
    reader: Option<BufReader<TcpStream>>,
    writer: Option<TcpStream>,
}

impl Conn {
    pub fn new(host: &str, port: u16, timeout: Duration) -> Conn {
        Conn { host: host.to_string(), port, timeout, reader: None, writer: None }
    }
    fn connect(&mut self) -> Result<(), String> {
        let addr = (self.host.as_str(), self.port).to_socket_addrs().map_err(|e| format!("resolve {}:{}: {}", self.host, self.port, e))?
            .next().ok_or_else(|| format!("no address for {}:{}", self.host, self.port))?;
        let s = TcpStream::connect_timeout(&addr, self.timeout).map_err(|e| format!("connect {}: {}", addr, e))?;
        s.set_read_timeout(Some(self.timeout)).ok();
        s.set_write_timeout(Some(self.timeout)).ok();
        s.set_nodelay(true).ok();
        let w = s.try_clone().map_err(|e| e.to_string())?;
        self.reader = Some(BufReader::new(s));
        self.writer = Some(w);
        Ok(())
    }
    pub fn close(&mut self) { self.reader = None; self.writer = None; }

    /// One request. `headers` are sent verbatim after the mandatory ones.
    pub fn request(&mut self, method: &str, path: &str, headers: &[(String, String)], body: Option<&str>) -> Result<Resp, String> {
        let fresh = self.reader.is_none();
        match self.attempt(method, path, headers, body) {
            Ok(r) => Ok(r),
            Err(e) => {
                self.close();
                // A reused connection the far side had already closed is the
                // common case and is not a failed request; a fresh one that
                // failed is a real error and is reported.
                if fresh { Err(e) } else { self.attempt(method, path, headers, body).map_err(|e2| e2) }
            }
        }
    }

    fn attempt(&mut self, method: &str, path: &str, headers: &[(String, String)], body: Option<&str>) -> Result<Resp, String> {
        if self.reader.is_none() { self.connect()?; }
        let t0 = Instant::now();
        let mut req = format!("{} {} HTTP/1.1\r\nHost: {}\r\nConnection: keep-alive\r\nAccept: application/json, */*\r\n",
            method, if path.starts_with('/') { path } else { "/" }, host_header(&self.host, self.port));
        let mut has_ct = false;
        for (k, v) in headers {
            let lk = k.to_ascii_lowercase();
            if lk == "host" || lk == "connection" || lk == "content-length" { continue; }
            if lk == "content-type" { has_ct = true; }
            req.push_str(&format!("{}: {}\r\n", k, v));
        }
        match body {
            Some(b) => {
                if !has_ct { req.push_str("Content-Type: application/json\r\n"); }
                req.push_str(&format!("Content-Length: {}\r\n\r\n", b.len()));
                req.push_str(b);
            }
            None => {
                if matches!(method, "POST" | "PUT" | "PATCH") { req.push_str("Content-Length: 0\r\n"); }
                req.push_str("\r\n");
            }
        }
        {
            let w = self.writer.as_mut().ok_or("no connection")?;
            w.write_all(req.as_bytes()).map_err(|e| format!("write: {}", e))?;
            w.flush().map_err(|e| format!("flush: {}", e))?;
        }
        let r = self.reader.as_mut().ok_or("no connection")?;
        let mut line = String::new();
        let n = r.read_line(&mut line).map_err(|e| format!("read status: {}", e))?;
        if n == 0 { return Err("connection closed before a status line".into()); }
        let status: u16 = line.split_whitespace().nth(1).and_then(|c| c.parse().ok())
            .ok_or_else(|| format!("bad status line: {:?}", line.trim()))?;
        let mut hdrs: Vec<(String, String)> = Vec::new();
        loop {
            let mut h = String::new();
            if r.read_line(&mut h).map_err(|e| format!("read header: {}", e))? == 0 { return Err("connection closed in headers".into()); }
            let t = h.trim_end_matches(['\r', '\n']);
            if t.is_empty() { break; }
            if let Some(i) = t.find(':') { hdrs.push((t[..i].trim().to_string(), t[i + 1..].trim().to_string())); }
        }
        let lower = |name: &str| hdrs.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.to_ascii_lowercase());
        let chunked = lower("transfer-encoding").map(|v| v.contains("chunked")).unwrap_or(false);
        let len = hdrs.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.trim().parse::<usize>().ok());
        let no_body = status == 204 || status == 304 || method == "HEAD";
        let mut buf: Vec<u8> = Vec::new();
        let mut closed = lower("connection").map(|v| v.contains("close")).unwrap_or(false);
        if no_body {
        } else if chunked {
            read_chunked(r, &mut buf)?;
        } else if let Some(n) = len {
            buf.resize(n, 0);
            r.read_exact(&mut buf).map_err(|e| format!("read body: {}", e))?;
        } else {
            r.read_to_end(&mut buf).map_err(|e| format!("read body: {}", e))?;
            closed = true;
        }
        if closed { self.close(); }
        Ok(Resp { status, headers: hdrs, body: String::from_utf8_lossy(&buf).to_string(), ms: t0.elapsed().as_secs_f64() * 1000.0 })
    }
}

fn host_header(host: &str, port: u16) -> String {
    if port == 80 { host.to_string() } else if host.contains(':') { format!("[{}]:{}", host, port) } else { format!("{}:{}", host, port) }
}

fn read_chunked(r: &mut BufReader<TcpStream>, out: &mut Vec<u8>) -> Result<(), String> {
    loop {
        let mut size_line = String::new();
        if r.read_line(&mut size_line).map_err(|e| format!("read chunk size: {}", e))? == 0 { return Err("closed mid-chunk".into()); }
        let hex = size_line.trim().split(';').next().unwrap_or("").trim();
        let n = usize::from_str_radix(hex, 16).map_err(|_| format!("bad chunk size {:?}", hex))?;
        if n == 0 {
            loop { let mut t = String::new(); if r.read_line(&mut t).map_err(|e| e.to_string())? == 0 { break; } if t.trim().is_empty() { break; } }
            return Ok(());
        }
        let start = out.len();
        out.resize(start + n, 0);
        r.read_exact(&mut out[start..]).map_err(|e| format!("read chunk: {}", e))?;
        let mut crlf = [0u8; 2];
        r.read_exact(&mut crlf).map_err(|e| format!("read chunk crlf: {}", e))?;
    }
}

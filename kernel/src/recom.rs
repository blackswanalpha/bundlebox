//! recom.rs — the probe vocabulary, evaluated in parallel with real timeouts.
//!
//! `bb scan` answers questions about the SOURCE for nothing. `bb runbook`
//! answers them about the RUNNING system for nothing. recom answers a third
//! kind, and it is the one that costs whole sessions:
//!
//! > Has this automation already been run, and is its result still true?
//!
//! Driving a browser through nine screens to learn that checkout stops at the
//! address step costs tens of thousands of tokens and ten minutes of wall
//! clock. The answer is worth keeping. The record of it is worth keeping ONLY
//! while the world that produced it still stands — which is why this is not a
//! cache. A record declares the facts its result rests on, and those facts are
//! re-probed on every read.
//!
//! Three properties this module exists to hold:
//!
//! 1. **The vocabulary is CLOSED.** A record is data that arrives by pull
//!    request, so it must not be able to run a command. There is no `cmd`
//!    probe. `git` and `adb` are invoked with fixed argument vectors and the
//!    record's text only ever lands in a positional slot, never in a shell.
//! 2. **Unreadable is not matching.** A probe that fails returns `ok:false`,
//!    and the verdict built on it is `unknown`, never `fresh`. A store that let
//!    those collapse would eventually tell a session a service was up when
//!    there was no service.
//! 3. **Parallel, with a deadline.** A record with nine dependencies is nine
//!    network or process round trips. Serially that is the wall clock the
//!    record was supposed to save.
use crate::http::{parse_url, Conn};
use crate::json::Json;
use crate::sha1::sha1;
use std::io::Read;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

const BODY_CAP: usize = 256 * 1024;

fn ok(v: String) -> (bool, String, String) { (true, v, String::new()) }
fn no(why: &str) -> (bool, String, String) { (false, String::new(), why.to_string()) }

/// Run a fixed program with a fixed argument vector. No shell, ever: the only
/// text a record contributes is a positional argument, so a record containing
/// `; rm -rf /` is a path that does not exist rather than a command.
fn capture(prog: &str, args: &[&str], cwd: Option<&str>, timeout: Duration) -> Result<String, String> {
    let mut c = Command::new(prog);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some(d) = cwd { c.current_dir(d); }
    let mut child = c.spawn().map_err(|e| format!("{}: {}", prog, e))?;
    // wait_timeout is not in std, so poll. A hung adb is the common case and
    // waiting for it forever is the failure this whole module is avoiding.
    let deadline = std::time::Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut s) = child.stdout.take() { let _ = s.read_to_string(&mut out); }
                if !status.success() {
                    let mut err = String::new();
                    if let Some(mut s) = child.stderr.take() { let _ = s.read_to_string(&mut err); }
                    let msg = err.trim().lines().next().unwrap_or("non-zero exit").to_string();
                    return Err(msg);
                }
                return Ok(out);
            }
            Ok(None) => {
                if std::time::Instant::now() > deadline { let _ = child.kill(); return Err(format!("{} timed out", prog)); }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(e.to_string()),
        }
    }
}

/// One probe. `(readable, value, why)` — and `readable == false` is the whole
/// reason the verdict has three values rather than two.
fn probe(spec: &str, root: &str, timeout: Duration) -> (bool, String, String) {
    let (kind, rest) = match spec.split_once(':') { Some(p) => p, None => return no("not a probe: expected <kind>:<arg>") };
    let joined = |p: &str| -> String {
        if std::path::Path::new(p).is_absolute() { p.to_string() } else { format!("{}/{}", root.trim_end_matches('/'), p) }
    };
    match kind {
        "file_sha" => match std::fs::read(joined(rest)) {
            Ok(b) => ok(sha1(&b)),
            Err(e) => no(&format!("{}: {}", rest, e)),
        },
        "git_head" => match capture("git", &["-C", &joined(rest), "rev-parse", "HEAD"], None, timeout) {
            Ok(s) => ok(s.trim().to_string()),
            Err(e) => no(&e),
        },
        // The probe that matters most. A record about checkout depends on the
        // checkout files, so it survives every unrelated commit and goes stale
        // the moment somebody touches what it was actually about — INCLUDING an
        // uncommitted edit, because `hash-object` reads the working tree and
        // the working tree is what the next session is looking at.
        "git_paths" => {
            let (sub, list) = match rest.split_once(':') { Some(p) => p, None => return no("git_paths:<dir>:<a>,<b>") };
            let dir = joined(sub);
            let paths: Vec<&str> = list.split(',').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
            if paths.is_empty() { return no("git_paths names no path"); }
            let mut parts = Vec::new();
            for p in paths {
                // A path that does not exist is a FACT that moved, not an
                // unreadable one: a record about a file somebody deleted must
                // go stale, not silent.
                let full = format!("{}/{}", dir.trim_end_matches('/'), p);
                match std::fs::read(&full) {
                    Ok(b) => parts.push(format!("{}={}", p, &sha1(&b)[..12])),
                    Err(_) => parts.push(format!("{}=absent", p)),
                }
            }
            ok(sha1(parts.join(",").as_bytes())[..16].to_string())
        }
        "http" | "http_body" => {
            let url = match parse_url(rest) { Ok(u) => u, Err(e) => return no(&e) };
            if url.scheme == "https" { return no("https: the kernel cannot probe TLS"); }
            let mut c = Conn::new(&url.host, url.port, timeout);
            match c.request("GET", &url.path, &[], None) {
                Ok(r) => {
                    if kind == "http" { ok(r.status.to_string()) }
                    else {
                        let b = r.body.as_bytes();
                        ok(format!("{}:{}", r.status, &sha1(&b[..b.len().min(BODY_CAP)])[..16]))
                    }
                }
                Err(e) => no(&e),
            }
        }
        "port" => {
            let (host, p) = match rest.rsplit_once(':') { Some(x) => x, None => return no("port:<host>:<port>") };
            let n: u16 = match p.parse() { Ok(n) => n, Err(_) => return no("port is not a number") };
            match (host, n).to_socket_addrs().ok().and_then(|mut a| a.next()) {
                None => no("host does not resolve"),
                Some(addr) => match TcpStream::connect_timeout(&addr, timeout) {
                    Ok(_) => ok("listening".into()),
                    Err(_) => ok("closed".into()),
                },
            }
        }
        // Presence, never the value: a record travels in a pull request and a
        // probe that carried a secret's contents would put it there.
        "env" => ok(if std::env::var(rest).is_ok() { "set".into() } else { "unset".into() }),
        "adb_state" => match capture("adb", &["-s", rest, "get-state"], None, timeout) {
            Ok(s) => ok(s.trim().to_string()),
            Err(e) => no(&e),
        },
        "adb_package" => {
            let (serial, pkg) = match rest.split_once('/') { Some(p) => p, None => return no("adb_package:<serial>/<pkg>") };
            match capture("adb", &["-s", serial, "shell", "dumpsys", "package", pkg], None, timeout) {
                Ok(s) => {
                    let g = |k: &str| s.lines().find_map(|l| l.trim().strip_prefix(k).map(|v| v.trim().to_string())).unwrap_or_default();
                    let v = g("versionName=");
                    let u = g("lastUpdateTime=");
                    if v.is_empty() && u.is_empty() { ok("absent".into()) } else { ok(format!("{}@{}", v, u)) }
                }
                Err(e) => no(&e),
            }
        }
        "adb_foreground" => match capture("adb", &["-s", rest, "shell", "dumpsys", "activity", "activities"], None, timeout) {
            Ok(s) => ok(s.lines().find(|l| l.contains("ResumedActivity") || l.contains("mResumedActivity"))
                .map(|l| l.split_whitespace().find(|w| w.contains('/')).unwrap_or("?").to_string())
                .unwrap_or_else(|| "none".into())),
            Err(e) => no(&e),
        },
        _ => no(&format!("unknown probe `{}`. The vocabulary is closed; adding one is a code change somebody reviews", kind)),
    }
}

pub fn op_recom(input: &Json) -> Json {
    let specs: Vec<String> = input.str_list("probes");
    let root = input.string("root", ".");
    let timeout = Duration::from_millis(input.num("timeout_ms", 8000.0).max(200.0) as u64);
    let results: Mutex<Vec<(usize, Json)>> = Mutex::new(Vec::new());
    let next = AtomicUsize::new(0);
    std::thread::scope(|scope| {
        for _ in 0..specs.len().clamp(1, 12) {
            scope.spawn(|| loop {
                let i = next.fetch_add(1, Ordering::Relaxed);
                let Some(spec) = specs.get(i) else { break };
                let t0 = std::time::Instant::now();
                let (readable, value, why) = probe(spec, &root, timeout);
                let mut r = Json::obj();
                r.set("probe", spec.clone().into());
                r.set("ok", readable.into());
                r.set("value", value.into());
                if !why.is_empty() { r.set("why", why.into()); }
                r.set("ms", Json::Num(t0.elapsed().as_millis() as f64));
                results.lock().unwrap_or_else(|e| e.into_inner()).push((i, r));
            });
        }
    });
    let mut rows = results.into_inner().unwrap_or_else(|e| e.into_inner());
    rows.sort_by_key(|(i, _)| *i);
    let mut o = Json::obj();
    o.set("ok", true.into());
    o.set("probes", Json::Arr(rows.into_iter().map(|(_, v)| v).collect()));
    o
}

//! Run an acceptance command with a real timeout and a bounded output, and
//! report the exit code as the verdict. `set -o pipefail` is the whole point of
//! wrapping: without it a pipe eats the exit code and every acceptance passes.
//! The timeout is enforced by the kernel, not by the shell, so a gate that
//! hangs before its first byte is still killed.
use crate::json::Json;
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

pub fn op_gate(input: &Json) -> Json {
    let cmd = input.string("cmd", "");
    let cwd = input.string("cwd", ".");
    let timeout = Duration::from_secs(input.num("timeout", 1800.0) as u64);
    let cap = input.num("cap_bytes", 4000.0) as usize;
    let mut out = Json::obj();
    if cmd.trim().is_empty() { out.set("rc", Json::Null); out.set("verdict", "unproven".into()); out.set("why", "no acceptance command".into()); return out; }
    let wrapped = format!("set -o pipefail; {{ {} ; }} 2>&1", cmd);
    let started = Instant::now();
    let mut child = match Command::new("bash").arg("-lc").arg(&wrapped).current_dir(&cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn() {
        Ok(c) => c, Err(e) => { out.set("rc", 127.into()); out.set("verdict", "failed".into()); out.set("why", format!("spawn: {}", e).into()); return out; }
    };
    let mut stdout = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || { let mut buf = Vec::new(); let _ = stdout.read_to_end(&mut buf); buf });
    let mut timed_out = false;
    let status = loop {
        match child.try_wait() { Ok(Some(s)) => break Some(s), Ok(None) => {}, Err(_) => break None }
        if started.elapsed() > timeout { let _ = child.kill(); timed_out = true; break child.wait().ok(); }
        std::thread::sleep(Duration::from_millis(50));
    };
    let buf = reader.join().unwrap_or_default();
    let tail = if buf.len() > cap { &buf[buf.len() - cap..] } else { &buf[..] };
    let rc = status.and_then(|s| s.code()).unwrap_or(if timed_out { 124 } else { 1 });
    out.set("rc", (rc as i64).into());
    out.set("seconds", ((started.elapsed().as_secs_f64() * 10.0).round() / 10.0).into());
    out.set("timed_out", timed_out.into());
    out.set("verdict", (if timed_out { "timeout" } else if rc == 0 { "passed" } else { "failed" }).into());
    out.set("output_tail", String::from_utf8_lossy(tail).to_string().into());
    out.set("output_bytes", buf.len().into());
    out
}

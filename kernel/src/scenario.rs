//! scenario.rs — run a corpus of scenarios against a running system, fast.
//!
//! A detector asks what the FILES say. A scenario asks what the running system
//! DOES, with a persona whose week is dense enough to reach the paths that only
//! fire under state. That is the one class of question in this factory that
//! makes a request, and it is here rather than in the CLI for one reason: a
//! corpus is hundreds of steps, each of them a socket, and a scripting runtime
//! spends the wall clock on its own scheduler. Threads, one connection per
//! worker, one shared pacer.
//!
//! Four properties the runner enforces, each because the alternative produces a
//! board that is green for the wrong reason:
//!
//! 1. **Pacing is part of the design.** A service that limits to 60 requests a
//!    minute turns an unpaced 130-step corpus into an all-red board about the
//!    limiter. `rpm` throttles globally and a 429 is retried, not recorded.
//! 2. **A failed `precondition` BLOCKS its scenario** instead of cascading. One
//!    unwritable directory used to read as nineteen product defects.
//! 3. **An unresolved `{{token}}` is an error**, never a literal comparison.
//! 4. **Green means something was checked.** A step that asserts nothing is
//!    reported `empty`, and the caller's `check` refuses the corpus.
//!
//! The runner is three files. This one owns the shared shapes (`Run`, `Step`,
//! `Pacer`) and the op that drives the thread pool; `expect.rs` decides whether
//! a step passed; `steps.rs` performs the three kinds of step. The split is
//! along the line the corpus itself draws: what was asked, what was done, and
//! what it means.
mod expect;
mod steps;

use crate::http::parse_url;
use crate::json::Json;
use crate::subst::{self, Clock};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use steps::{conn_of, run_steps, scenario_json};

struct Pacer { gap: Duration, next: Mutex<Instant> }
impl Pacer {
    fn new(rpm: f64) -> Option<Pacer> {
        if rpm <= 0.0 { return None; }
        Some(Pacer { gap: Duration::from_secs_f64(60.0 / rpm), next: Mutex::new(Instant::now()) })
    }
    fn wait(&self) {
        let sleep_for = {
            let mut next = self.next.lock().unwrap_or_else(|e| e.into_inner());
            let now = Instant::now();
            let at = if *next > now { *next } else { now };
            *next = at + self.gap;
            at.saturating_duration_since(now)
        };
        if !sleep_for.is_zero() { std::thread::sleep(sleep_for); }
    }
}

pub struct Run {
    host: String,
    port: u16,
    base_path: String,
    base: String,
    headers: Json,
    clock: Clock,
    globals: BTreeMap<String, Json>,
    actors: Json,
    pacer: Option<Pacer>,
    timeout: Duration,
    cap: usize,
    root: String,
    max_429: u32,
    requests: AtomicUsize,
    throttled: AtomicUsize,
}

pub struct Step { pub name: String, kind: &'static str, state: String, status: Option<u16>, ms: f64, why: Vec<String>, request: String, evidence: Json }

fn s(v: &str) -> Json { Json::Str(v.to_string()) }

impl Step {
    fn to_json(&self) -> Json {
        let mut o = Json::obj();
        o.set("name", s(&self.name));
        o.set("kind", s(self.kind));
        o.set("state", s(&self.state));
        o.set("status", self.status.map(|x| Json::Num(x as f64)).unwrap_or(Json::Null));
        o.set("ms", Json::Num((self.ms * 10.0).round() / 10.0));
        o.set("why", Json::Arr(self.why.iter().map(|w| s(w)).collect()));
        o.set("request", s(&self.request));
        o.set("evidence", self.evidence.clone());
        o
    }
}

pub fn op_scenario(input: &Json) -> Json {
    let mut out = Json::obj();
    let base_raw = input.string("base", "");
    let url = match parse_url(&base_raw) { Ok(u) => u, Err(e) => { out.set("ok", Json::Bool(false)); out.set("why", s(&e)); return out; } };
    if url.scheme == "https" {
        out.set("ok", Json::Bool(false));
        out.set("why", s("the kernel speaks http only (TLS would be a dependency); run this corpus with --engine js"));
        return out;
    }
    let scenarios: Vec<Json> = input.get("scenarios").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
    let mut globals: BTreeMap<String, Json> = BTreeMap::new();
    if let Json::Obj(m) = input.get("vars").cloned().unwrap_or_else(Json::obj) { for (k, v) in m { globals.insert(k, v); } }
    let now = subst::now_secs();
    let run = Run {
        host: url.host.clone(), port: url.port, base_path: url.path.clone(), base: base_raw.clone(),
        headers: input.get("headers").cloned().unwrap_or_else(Json::obj),
        clock: Clock { now, tz_offset_minutes: input.num("tz_offset_minutes", 0.0) as i64,
            timezone: input.string("timezone", "UTC"), run: input.string("run", &subst::stamp(now)) },
        globals: BTreeMap::new(),
        actors: input.get("actors").cloned().unwrap_or_else(Json::obj),
        pacer: Pacer::new(input.num("rpm", 0.0)),
        timeout: Duration::from_millis(input.num("timeout_ms", 20000.0) as u64),
        cap: input.num("cap_bytes", 1200.0) as usize,
        root: input.string("root", "."),
        max_429: input.num("max_429", 6.0) as u32,
        requests: AtomicUsize::new(0), throttled: AtomicUsize::new(0),
    };
    let t0 = Instant::now();

    // Setup runs once, sequentially, and what it saves is global. A corpus with
    // a sign-in writes it here rather than in every scenario.
    let setup_steps: Vec<Json> = input.get("setup").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
    let mut setup_vars = globals.clone();
    let (setup_rows, setup_blocked) = if setup_steps.is_empty() { (Vec::new(), None) } else {
        let mut c = conn_of(&run);
        run_steps(&run, &mut c, &setup_steps, &mut setup_vars)
    };
    let setup_failed = setup_rows.iter().any(|r| r.state == "failed" || r.state == "error") || setup_blocked.is_some();
    let mut setup_out = Json::obj();
    setup_out.set("state", s(if setup_steps.is_empty() { "none" } else if setup_failed { "failed" } else { "passed" }));
    setup_out.set("steps", Json::Arr(setup_rows.iter().map(|x| x.to_json()).collect()));

    let run = Run { globals: setup_vars, ..run };
    let results: Mutex<Vec<(usize, Json)>> = Mutex::new(Vec::new());

    if setup_failed {
        // Nothing after a failed setup means anything about the product.
        let mut rows = Vec::new();
        for (i, sc) in scenarios.iter().enumerate() {
            let steps: Vec<Step> = sc.get("steps").and_then(|v| v.as_arr()).cloned().unwrap_or_default().iter().enumerate()
                .map(|(j, st)| Step { name: st.string("name", &format!("step {}", j + 1)), kind: "blocked", state: "blocked".into(), status: None, ms: 0.0,
                    why: vec!["setup failed; nothing after it is a claim about the product".into()], request: String::new(), evidence: Json::obj() }).collect();
            rows.push((i, scenario_json(sc, steps, 0.0)));
        }
        *results.lock().unwrap() = rows;
    } else {
        let parallel = (input.num("parallel", 1.0) as usize).clamp(1, 32);
        let next = AtomicUsize::new(0);
        std::thread::scope(|scope| {
            for _ in 0..parallel.min(scenarios.len().max(1)) {
                scope.spawn(|| {
                    let mut conn = conn_of(&run);
                    loop {
                        let i = next.fetch_add(1, Ordering::Relaxed);
                        let Some(sc) = scenarios.get(i) else { break };
                        let st0 = Instant::now();
                        let steps: Vec<Json> = sc.get("steps").and_then(|v| v.as_arr()).cloned().unwrap_or_default();
                        let mut vars = run.globals.clone();
                        let (rows, _) = run_steps(&run, &mut conn, &steps, &mut vars);
                        results.lock().unwrap_or_else(|e| e.into_inner()).push((i, scenario_json(sc, rows, st0.elapsed().as_secs_f64())));
                    }
                });
            }
        });
    }

    let mut rows = results.into_inner().unwrap_or_else(|e| e.into_inner());
    rows.sort_by_key(|(i, _)| *i);
    let mut totals: BTreeMap<&str, usize> = BTreeMap::new();
    for (_, sc) in &rows {
        for st in sc.get("steps").and_then(|v| v.as_arr()).cloned().unwrap_or_default() {
            *totals.entry(match st.string("state", "").as_str() {
                "passed" => "passed", "failed" => "failed", "blocked" => "blocked", "error" => "error", _ => "empty" }).or_insert(0) += 1;
        }
    }
    let mut t = Json::obj();
    for k in ["passed", "failed", "blocked", "error", "empty"] { t.set(k, Json::Num(*totals.get(k).unwrap_or(&0) as f64)); }
    out.set("ok", Json::Bool(true));
    out.set("engine", s("kernel"));
    out.set("base", s(&run.base));
    out.set("setup", setup_out);
    out.set("scenarios", Json::Arr(rows.into_iter().map(|(_, v)| v).collect()));
    out.set("totals", t);
    out.set("seconds", Json::Num((t0.elapsed().as_secs_f64() * 10.0).round() / 10.0));
    out.set("requests", Json::Num(run.requests.load(Ordering::Relaxed) as f64));
    out.set("throttled", Json::Num(run.throttled.load(Ordering::Relaxed) as f64));
    out.set("rpm", Json::Num(input.num("rpm", 0.0)));
    out
}

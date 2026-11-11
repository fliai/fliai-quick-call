// FLiAI Quick Call: tap a teammate on the shoulder over the office LAN.
// No server: peers find each other with mDNS and talk over a tiny JSON-over-TCP protocol.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};

const SERVICE_TYPE: &str = "_quickcall._tcp.local.";
const DEFAULT_PORT: u16 = 47800;
const CALL_TIMEOUT_SECS: u64 = 30;
const RING_EVERY_SECS: u64 = 5;
const POLL_EVERY: Duration = Duration::from_secs(3);
const REBROWSE_EVERY: Duration = Duration::from_secs(120);
// How long the cursor must rest in (or stay away from) the top-center hot zone before the island
// opens (or closes). Short, so it feels immediate; just enough to ignore a cursor passing by.
const HOVER_OPEN_AFTER: Duration = Duration::from_millis(120);
const HOVER_CLOSE_AFTER: Duration = Duration::from_millis(300);
const NET_TIMEOUT: Duration = Duration::from_millis(1500);
// A call waits longer for its answer than the quick status checks: the callee may be slow to answer.
const CALL_REPLY_TIMEOUT: Duration = Duration::from_secs(5);
// Deployment / GitHub activity pushed by the DevOps relay (see .github/status-relay.yml).
const ACTIVITY_KEEP: usize = 20; // recent events kept for the open island
const ACTIVITY_MAX_AGE_SECS: u64 = 10 * 60; // older events are dropped, never replayed
const FLASH_FOR: Duration = Duration::from_secs(6); // red border on a failed deploy

// ---------- state ----------

#[derive(Serialize, Deserialize, Clone)]
struct Me {
    id: String,
    name: String,
    status: String, // "available" | "busy"
    /// "Deployment updates": show deploy / PR / issue activity. Off until the person turns it on.
    #[serde(default)]
    activity: bool,
}

struct Peer {
    name: String,
    status: String,
    addr: SocketAddr,
    online: bool,
    misses: u8,
}

struct Incoming {
    call_id: u64,
    from_id: String,
    reply_to: SocketAddr,
}

/// One deployment, pull request or issue event. Published on the relay's own machine by a
/// GitHub Actions job (loopback only), then pushed to every peer on the LAN.
#[derive(Serialize, Deserialize, Clone)]
struct Activity {
    id: String,    // unique per event, used to drop duplicates
    repo: String,  // e.g. "snap-core"
    kind: String,  // "deploy" | "pr" | "issue"
    state: String, // deploy: "started" | "success" | "failure" | "cancelled"; pr: "opened" | "merged" | "closed"; issue: "opened"
    #[serde(default)]
    env: String, // deploy: "staging" | "production"
    #[serde(default)]
    title: String,
    #[serde(default)]
    number: u64,
    #[serde(default)]
    actor: String,
    at: u64, // unix seconds when it happened
}

struct State {
    me: Me,
    port: u16,
    config_path: PathBuf,
    peers: HashMap<String, Peer>,
    incoming: Option<Incoming>,
    outgoing: Option<String>, // peer id we are calling
    next_call_id: u64,
    activity: Vec<Activity>, // newest first
}

type Shared = Arc<Mutex<State>>;

/// Where the island window currently sits, in logical pixels, plus its hover hot zone.
#[derive(Default, Clone, Copy)]
struct Geo {
    // The island's visible rectangle (it sits inside a larger, fixed, transparent window).
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    interactive: bool,
    scale: f64,
    hot_x: f64,
    hot_w: f64,
    hot_h: f64,
    // Where the window was last put, so we only move it when the screen layout changes.
    win_x: f64,
    win_y: f64,
    placed: bool,
}

/// The island's window never changes size: resizing a webview mid-animation (or tucking a tiny
/// window into the notch, where macOS treats it as hidden and pauses rendering) makes the
/// island jump instead of flowing. Big enough for the largest island plus its glow.
const WIN_W: f64 = 820.0;
const WIN_H: f64 = 640.0;

type SharedGeo = Arc<Mutex<Geo>>;

/// The primary screen's notch (MacBooks since 2021), if it has one.
#[derive(Serialize, Clone, Copy, Default)]
#[serde(rename_all = "camelCase")]
struct Screen {
    notch: bool,
    notch_width: f64,
    notch_height: f64,
}

#[derive(Serialize, Clone)]
struct PeerView {
    id: String,
    name: String,
    status: String, // "available" | "busy" | "offline"
}

#[derive(Serialize, Clone)]
struct StateView {
    me: Me,
    peers: Vec<PeerView>,
    activity: Vec<Activity>,
}

fn view(s: &State) -> StateView {
    let rank = |st: &str| match st {
        "available" => 0,
        "busy" => 1,
        _ => 2,
    };
    let mut peers: Vec<PeerView> = s
        .peers
        .iter()
        .map(|(id, p)| PeerView {
            id: id.clone(),
            name: p.name.clone(),
            status: if p.online { p.status.clone() } else { "offline".into() },
        })
        .collect();
    peers.sort_by(|a, b| rank(&a.status).cmp(&rank(&b.status)).then(a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    StateView { me: s.me.clone(), peers, activity: s.activity.clone() }
}

fn push_state(app: &AppHandle, shared: &Shared) {
    let v = view(&shared.lock().unwrap());
    let _ = app.emit("state", v);
}

fn save_config(s: &State) {
    if let Some(dir) = s.config_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // Write to a temp file and rename over the original, so a crash or an overlapping launch
    // never sees a half-written file (which would mint a new id and show up as a duplicate).
    let tmp = s.config_path.with_extension("json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(&s.me).unwrap()).is_ok() {
        let _ = std::fs::rename(&tmp, &s.config_path);
    }
}

fn load_config(path: &PathBuf) -> Me {
    if let Some(me) = std::fs::read(path).ok().and_then(|b| serde_json::from_slice::<Me>(&b).ok()) {
        return me;
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "Teammate".into());
    let mut name: Vec<char> = user.chars().collect();
    if let Some(c) = name.first_mut() {
        *c = c.to_ascii_uppercase();
    }
    Me {
        id: format!("{:x}{:x}", nanos, std::process::id()),
        name: name.into_iter().collect(),
        status: "available".into(),
        activity: false,
    }
}

fn color_for(id: &str) -> String {
    let hue = id.bytes().fold(7u32, |h, b| h.wrapping_mul(31).wrapping_add(b as u32)) % 360;
    format!("hsl({hue}, 85%, 55%)")
}

fn clean(s: &str, max: usize) -> String {
    s.chars().filter(|c| !c.is_control()).take(max).collect::<String>().trim().to_string()
}

// ---------- wire protocol: one JSON line in, one JSON line out ----------

#[derive(Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
enum Msg {
    Info,
    Hello { id: String, name: String, status: String, port: u16 },
    Call { id: String, name: String, port: u16 },
    Cancel { id: String },
    Reply { id: String, name: String, answer: String },
    /// From the relay job on this same machine only: show it here and push it to every peer.
    Publish { ev: Activity },
    /// From a peer: an activity event to show.
    Status { ev: Activity },
}

fn send(addr: SocketAddr, msg: &Msg) -> std::io::Result<Value> {
    send_with(addr, msg, NET_TIMEOUT)
}

fn send_with(addr: SocketAddr, msg: &Msg, reply_timeout: Duration) -> std::io::Result<Value> {
    let mut stream = TcpStream::connect_timeout(&addr, NET_TIMEOUT)?;
    stream.set_read_timeout(Some(reply_timeout))?;
    stream.set_write_timeout(Some(NET_TIMEOUT))?;
    stream.write_all(format!("{}\n", serde_json::to_string(msg).unwrap()).as_bytes())?;
    let mut line = String::new();
    BufReader::new(stream.take(64 * 1024)).read_line(&mut line)?;
    serde_json::from_str(&line).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn hello_msg(s: &State, status: &str) -> Msg {
    Msg::Hello { id: s.me.id.clone(), name: s.me.name.clone(), status: status.into(), port: s.port }
}

fn broadcast_hello(shared: &Shared, status: Option<&str>) {
    let (msg, addrs) = {
        let s = shared.lock().unwrap();
        let st = status.unwrap_or(&s.me.status).to_string();
        (hello_msg(&s, &st), s.peers.values().filter(|p| p.online).map(|p| p.addr).collect::<Vec<_>>())
    };
    thread::scope(|sc| {
        for a in addrs {
            let msg = &msg;
            sc.spawn(move || send(a, msg));
        }
    });
}

fn upsert_peer(shared: &Shared, id: String, name: String, status: String, addr: SocketAddr) {
    let mut s = shared.lock().unwrap();
    if id == s.me.id {
        return;
    }
    let online = status != "offline";
    // The same person may come back under a new id (reinstall, wiped config) or from the same
    // address a previous instance used. Drop those stale entries so they don't show twice.
    if online && !s.peers.contains_key(&id) {
        s.peers.retain(|_, p| p.addr != addr && (p.online || !p.name.eq_ignore_ascii_case(&name)));
    }
    let p = s.peers.entry(id).or_insert(Peer { name: String::new(), status: String::new(), addr, online, misses: 0 });
    p.name = name;
    p.addr = addr;
    p.online = online;
    p.misses = 0;
    if online {
        p.status = status;
    }
}

fn start_server(app: AppHandle, shared: Shared) -> u16 {
    let listener = TcpListener::bind(("0.0.0.0", DEFAULT_PORT))
        .or_else(|_| TcpListener::bind(("0.0.0.0", 0)))
        .expect("cannot open a network port");
    let port = listener.local_addr().unwrap().port();
    thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let (app, shared) = (app.clone(), shared.clone());
            thread::spawn(move || handle_conn(app, shared, stream));
        }
    });
    port
}

fn handle_conn(app: AppHandle, shared: Shared, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(NET_TIMEOUT));
    let Ok(remote) = stream.peer_addr() else { return };
    let ip = match remote.ip() {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    let mut line = String::new();
    let Ok(clone) = stream.try_clone() else { return };
    if BufReader::new(clone.take(64 * 1024)).read_line(&mut line).is_err() {
        return;
    }
    let Ok(msg) = serde_json::from_str::<Msg>(&line) else { return };

    let reply = match msg {
        Msg::Info => {
            let s = shared.lock().unwrap();
            json!({ "id": s.me.id, "name": s.me.name, "status": s.me.status, "port": s.port })
        }
        Msg::Hello { id, name, status, port } => {
            upsert_peer(&shared, clean(&id, 64), clean(&name, 40), clean(&status, 16), SocketAddr::new(ip, port));
            push_state(&app, &shared);
            json!({})
        }
        Msg::Call { id, name, port } => {
            // Busy means do not disturb: no alert at all, the caller is told straight away.
            let status = shared.lock().unwrap().me.status.clone();
            if status != "busy" {
                // Answer the caller first; opening the border windows can take seconds (several
                // monitors, Windows), and a slow answer made the caller think the call failed.
                let (app, shared, reply_to) = (app.clone(), shared.clone(), SocketAddr::new(ip, port));
                let (id, name) = (clean(&id, 64), clean(&name, 40));
                thread::spawn(move || on_incoming_call(&app, &shared, id, name, reply_to));
            }
            json!({ "status": status })
        }
        Msg::Cancel { id } => {
            let matches = shared.lock().unwrap().incoming.as_ref().is_some_and(|i| i.from_id == id);
            if matches {
                end_incoming(&app, &shared);
            }
            json!({})
        }
        Msg::Reply { id, name, answer } => {
            let was_calling = {
                let mut s = shared.lock().unwrap();
                let hit = s.outgoing.as_deref() == Some(id.as_str());
                if hit {
                    s.outgoing = None;
                }
                hit
            };
            if was_calling {
                let _ = app.emit("reply", json!({ "name": clean(&name, 40), "answer": clean(&answer, 16), "color": color_for(&id) }));
            }
            json!({})
        }
        Msg::Publish { ev } => {
            // Only a job running on this machine may publish; peers can't make us rebroadcast.
            if !ip.is_loopback() {
                json!({ "error": "local only" })
            } else {
                match accept_activity(&app, &shared, ev) {
                    Some(ev) => json!({ "sent": broadcast_activity(&shared, &ev) }),
                    None => json!({ "skipped": true }),
                }
            }
        }
        Msg::Status { ev } => {
            accept_activity(&app, &shared, ev);
            json!({})
        }
    };
    let _ = stream.write_all(format!("{reply}\n").as_bytes());
}

// ---------- deployment / GitHub activity ----------

fn now_secs() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A deploy's events share an id up to the last ":" ("snap-core:run:123:started" and
/// "snap-core:run:123:success"), so its start and finish can be shown as one row.
fn run_key(id: &str) -> &str {
    id.rsplit_once(':').map_or(id, |(k, _)| k)
}

/// Clean an incoming event, drop it if it's stale, unknown or already seen, then store and show it.
/// Returns the stored event so the relay can pass it on.
fn accept_activity(app: &AppHandle, shared: &Shared, ev: Activity) -> Option<Activity> {
    let ev = Activity {
        id: clean(&ev.id, 120),
        repo: clean(&ev.repo, 40),
        kind: clean(&ev.kind, 10),
        state: clean(&ev.state, 12),
        env: clean(&ev.env, 12),
        title: clean(&ev.title, 120),
        number: ev.number,
        actor: clean(&ev.actor, 40),
        at: ev.at,
    };
    let now = now_secs();
    let known = matches!(
        (ev.kind.as_str(), ev.state.as_str()),
        ("deploy", "started" | "success" | "failure" | "cancelled") | ("pr", "opened" | "merged" | "closed") | ("issue", "opened")
    );
    if !known || ev.id.is_empty() || ev.repo.is_empty() || ev.at + ACTIVITY_MAX_AGE_SECS < now || ev.at > now + 120 {
        return None;
    }
    let (busy, wanted) = {
        let mut s = shared.lock().unwrap();
        if s.activity.iter().any(|a| a.id == ev.id) {
            return None;
        }
        if ev.kind == "deploy" {
            let key = run_key(&ev.id).to_string();
            let same_run = |a: &Activity| a.kind == "deploy" && run_key(&a.id) == key;
            if ev.state == "started" {
                // A start that arrives after its own finish changes nothing.
                if s.activity.iter().any(same_run) {
                    return None;
                }
            } else {
                // The finish replaces this deploy's "deploying…" row (one row per deploy).
                s.activity.retain(|a| !same_run(a));
            }
        }
        s.activity.insert(0, ev.clone());
        s.activity.truncate(ACTIVITY_KEEP);
        (s.me.status == "busy", s.me.activity)
    };
    push_state(app, shared);
    if !wanted {
        return Some(ev); // kept quietly (the relay still passes it on); nothing is shown
    }
    let _ = app.emit("activity", ev.clone());
    // A failed deploy flashes a red border, like a call, unless they're on Busy (do not disturb).
    if ev.kind == "deploy" && ev.state == "failure" && !busy {
        let short = ev.repo.trim_start_matches("snap-").to_string();
        flash(app, &format!("{short} → {} deploy failed", if ev.env.is_empty() { "?" } else { &ev.env }));
    }
    Some(ev)
}

/// Push an event to every peer that's online. Returns how many were reached.
fn broadcast_activity(shared: &Shared, ev: &Activity) -> usize {
    let addrs: Vec<SocketAddr> = shared.lock().unwrap().peers.values().filter(|p| p.online).map(|p| p.addr).collect();
    let msg = Msg::Status { ev: ev.clone() };
    thread::scope(|sc| {
        let handles: Vec<_> = addrs.into_iter().map(|a| { let msg = &msg; sc.spawn(move || send(a, msg).is_ok()) }).collect();
        handles.into_iter().filter_map(|h| h.join().ok()).filter(|ok| *ok).count()
    })
}

/// Show the red border with a banner for a few seconds, then retract it.
fn flash(app: &AppHandle, text: &str) {
    if app.state::<Shared>().lock().unwrap().incoming.is_some() {
        return; // never cover an incoming call
    }
    let generation = show_overlays(app, "", "#ff453a", Some(text));
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(FLASH_FOR);
        let _ = app.emit("flash-end", generation);
        close_overlays_soon(&app, generation);
    });
}

// ---------- calls ----------

fn on_incoming_call(app: &AppHandle, shared: &Shared, from_id: String, from_name: String, reply_to: SocketAddr) {
    let name = if from_name.is_empty() { "Someone".to_string() } else { from_name };
    let color = color_for(&from_id);
    let call_id = {
        let mut s = shared.lock().unwrap();
        s.next_call_id += 1;
        s.incoming = Some(Incoming { call_id: s.next_call_id, from_id, reply_to });
        s.next_call_id
    };
    hide_overlays(app);
    show_overlays(app, &name, &color, None);
    let _ = app.emit("incoming", json!({ "name": name, "color": color }));

    // Ring while unanswered; give up after the timeout.
    let (app, shared) = (app.clone(), shared.clone());
    thread::spawn(move || {
        for sec in 0..CALL_TIMEOUT_SECS {
            let still = shared.lock().unwrap().incoming.as_ref().is_some_and(|i| i.call_id == call_id);
            if !still {
                return;
            }
            if sec % RING_EVERY_SECS == 0 {
                play_sound();
            }
            thread::sleep(Duration::from_secs(1));
        }
        let still = shared.lock().unwrap().incoming.as_ref().is_some_and(|i| i.call_id == call_id);
        if still {
            answer_incoming(&app, &shared, "missed");
        }
    });
}

fn answer_incoming(app: &AppHandle, shared: &Shared, answer: &str) {
    let (target, msg) = {
        let s = shared.lock().unwrap();
        let Some(inc) = s.incoming.as_ref() else { return };
        (inc.reply_to, Msg::Reply { id: s.me.id.clone(), name: s.me.name.clone(), answer: answer.into() })
    };
    end_incoming(app, shared);
    thread::spawn(move || send(target, &msg));
}

fn end_incoming(app: &AppHandle, shared: &Shared) {
    shared.lock().unwrap().incoming = None;
    hide_overlays_soon(app); // the "incoming-end" event below makes the border retract first
    let _ = app.emit("incoming-end", ());
}

/// A soft two-note chime, built into the app so it sounds the same everywhere.
static CHIME: &[u8] = include_bytes!("../sounds/chime.wav");

fn play_sound() {
    #[cfg(target_os = "macos")]
    {
        let path = std::env::temp_dir().join("fliai-quickcall-chime.wav");
        if std::fs::metadata(&path).map(|m| m.len()).ok() != Some(CHIME.len() as u64) {
            let _ = std::fs::write(&path, CHIME);
        }
        let _ = std::process::Command::new("afplay").arg("-v").arg("0.5").arg(&path).spawn();
    }
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::Media::Audio::{PlaySoundW, SND_ASYNC, SND_MEMORY, SND_NODEFAULT};
        // SND_MEMORY plays straight from the bytes; they're static, so async playback is safe.
        unsafe { PlaySoundW(CHIME.as_ptr() as *const u16, std::ptr::null_mut(), SND_MEMORY | SND_ASYNC | SND_NODEFAULT) };
    }
}

// ---------- windows ----------

/// Each call's overlay windows get their own generation in their label, so closing one call's
/// overlays after its exit animation never removes a newer call's.
static OVERLAY_GEN: AtomicU64 = AtomicU64::new(0);
const OVERLAY_EXIT: Duration = Duration::from_millis(800); // a little over overlay.html's retract

fn show_overlays(app: &AppHandle, name: &str, color: &str, banner: Option<&str>) -> u64 {
    let generation = OVERLAY_GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let Ok(monitors) = app.available_monitors() else { return generation };
    let data = json!({ "name": name, "color": color, "banner": banner, "gen": generation });
    for (i, m) in monitors.iter().enumerate() {
        let scale = m.scale_factor();
        let (pos, size) = (m.position(), m.size());
        let built = WebviewWindowBuilder::new(app, format!("overlay-{generation}-{i}"), WebviewUrl::App("overlay.html".into()))
            .initialization_script(format!("window.__CALL__ = {data};"))
            .position(pos.x as f64 / scale, pos.y as f64 / scale)
            .inner_size(size.width as f64 / scale, size.height as f64 / scale)
            .decorations(false)
            .transparent(true)
            .shadow(false)
            .resizable(false)
            .skip_taskbar(true)
            .always_on_top(true)
            .visible_on_all_workspaces(true)
            .focused(false)
            .build();
        if let Ok(w) = built {
            let _ = w.set_ignore_cursor_events(true);
            raise(&w, OVERLAY_LEVEL);
        }
    }
    // Keep the island (with the answer buttons) above the border.
    #[cfg(not(target_os = "macos"))]
    if let Some(pill) = app.get_webview_window("pill") {
        let _ = pill.set_always_on_top(false);
        let _ = pill.set_always_on_top(true);
    }
    generation
}

// macOS window levels: above the menu bar and over full-screen apps.
const OVERLAY_LEVEL: isize = 1000; // NSScreenSaverWindowLevel
const ISLAND_LEVEL: isize = 1001;

#[cfg(target_os = "macos")]
fn raise(w: &tauri::WebviewWindow, level: isize) {
    let win = w.clone();
    let _ = w.run_on_main_thread(move || {
        use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior as B};
        let Ok(ptr) = win.ns_window() else { return };
        let ns: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
        ns.setLevel(level);
        ns.setCollectionBehavior(B::CanJoinAllSpaces | B::Stationary | B::FullScreenAuxiliary | B::IgnoresCycle);
        ns.setHasShadow(false);
    });
}

#[cfg(not(target_os = "macos"))]
fn raise(_w: &tauri::WebviewWindow, _level: isize) {}

#[cfg(target_os = "macos")]
fn detect_notch() -> Screen {
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSScreen;
    let Some(mtm) = MainThreadMarker::new() else { return Screen::default() };
    let screens = NSScreen::screens(mtm);
    let Some(s) = screens.iter().next() else { return Screen::default() };
    let top = s.safeAreaInsets().top;
    if top <= 0.0 {
        return Screen::default();
    }
    let (left, right) = (s.auxiliaryTopLeftArea(), s.auxiliaryTopRightArea());
    Screen { notch: true, notch_width: s.frame().size.width - left.size.width - right.size.width, notch_height: top }
}

#[cfg(not(target_os = "macos"))]
fn detect_notch() -> Screen {
    Screen::default()
}

/// Close the current call's overlays once their border has retracted.
fn hide_overlays_soon(app: &AppHandle) {
    close_overlays_soon(app, OVERLAY_GEN.load(Ordering::SeqCst));
}

/// Close one generation's overlays once their border has retracted.
fn close_overlays_soon(app: &AppHandle, generation: u64) {
    let prefix = format!("overlay-{generation}-");
    let app = app.clone();
    thread::spawn(move || {
        thread::sleep(OVERLAY_EXIT);
        for (label, w) in app.webview_windows() {
            if label.starts_with(&prefix) {
                let _ = w.destroy();
            }
        }
    });
}

/// Close every overlay right away (a new call replaces the old one).
fn hide_overlays(app: &AppHandle) {
    for (label, w) in app.webview_windows() {
        if label.starts_with("overlay-") {
            let _ = w.destroy();
        }
    }
}

/// Size the island window and pin it to the very top center of the primary screen.
fn place_island(app: &AppHandle, width: f64, height: f64, interactive: bool) {
    let Some(pill) = app.get_webview_window("pill") else { return };
    let Ok(Some(m)) = pill.primary_monitor() else { return };
    let scale = m.scale_factor();
    let (pos, size) = (m.position(), m.size());
    let mut center = pos.x as f64 / scale + size.width as f64 / scale / 2.0;
    if std::env::var("QUICKCALL_PROFILE").is_ok() {
        center += 460.0; // second test instance on the same machine
    }
    let top = pos.y as f64 / scale;
    let (win_x, win_y) = (center - WIN_W / 2.0, top);

    let geo = app.state::<SharedGeo>();
    let mut g = geo.lock().unwrap();
    if !g.placed {
        let _ = pill.set_size(LogicalSize::new(WIN_W, WIN_H));
        let _ = pill.set_ignore_cursor_events(true); // the hover watcher enables clicks over the island
    }
    if !g.placed || g.win_x != win_x || g.win_y != win_y {
        let _ = pill.set_position(LogicalPosition::new(win_x, win_y));
    }

    let screen = *app.state::<Screen>();
    let (hot_w, hot_h) = if screen.notch { (screen.notch_width + 40.0, screen.notch_height) } else { (240.0, 6.0) };
    *g = Geo {
        x: center - width / 2.0,
        y: top,
        w: width,
        h: height,
        interactive,
        scale,
        hot_x: center - hot_w / 2.0,
        hot_w,
        hot_h,
        win_x,
        win_y,
        placed: true,
    };
}

/// Tell the UI when the mouse reaches the top-center hot zone, or leaves the open island.
/// Also makes the window clickable only while the cursor is over an interactive island, so the
/// rest of the (transparent) window never blocks clicks to apps underneath.
fn start_hover_watch(app: AppHandle, geo: SharedGeo) {
    thread::spawn(move || {
        let (mut inside, mut raw_was, mut since) = (false, false, Instant::now());
        let mut clickable = false;
        loop {
            thread::sleep(Duration::from_millis(60));
            let Ok(p) = app.cursor_position() else { continue };
            let g = *geo.lock().unwrap();
            if g.scale == 0.0 {
                continue;
            }
            let (x, y) = (p.x / g.scale, p.y / g.scale);
            let in_hot = x >= g.hot_x && x <= g.hot_x + g.hot_w && y >= g.y - 2.0 && y <= g.y + g.hot_h;
            let in_island = g.interactive && x >= g.x - 16.0 && x <= g.x + g.w + 16.0 && y >= g.y - 2.0 && y <= g.y + g.h + 16.0;
            let over_island = g.interactive && x >= g.x && x <= g.x + g.w && y >= g.y - 2.0 && y <= g.y + g.h;
            if over_island != clickable {
                clickable = over_island;
                if let Some(pill) = app.get_webview_window("pill") {
                    let _ = pill.set_ignore_cursor_events(!clickable);
                }
            }
            let raw = in_hot || (inside && in_island);
            if raw != raw_was {
                raw_was = raw;
                since = Instant::now();
            }
            let dwell = if raw { HOVER_OPEN_AFTER } else { HOVER_CLOSE_AFTER };
            if raw != inside && since.elapsed() >= dwell {
                inside = raw;
                let _ = app.emit("hover", inside);
            }
        }
    });
}

// ---------- commands from the pill UI ----------

#[tauri::command]
fn get_state(shared: tauri::State<Shared>) -> StateView {
    view(&shared.lock().unwrap())
}

#[tauri::command]
fn set_status(app: AppHandle, shared: tauri::State<Shared>, status: String) {
    if status != "available" && status != "busy" {
        return;
    }
    {
        let mut s = shared.lock().unwrap();
        s.me.status = status;
        save_config(&s);
    }
    push_state(&app, &shared);
    let shared = shared.inner().clone();
    thread::spawn(move || broadcast_hello(&shared, None));
}

#[tauri::command]
fn set_name(app: AppHandle, shared: tauri::State<Shared>, name: String) {
    let name = clean(&name, 40);
    if name.is_empty() {
        return;
    }
    {
        let mut s = shared.lock().unwrap();
        s.me.name = name;
        save_config(&s);
    }
    push_state(&app, &shared);
    let shared = shared.inner().clone();
    thread::spawn(move || broadcast_hello(&shared, None));
}

#[tauri::command]
fn set_activity(app: AppHandle, shared: tauri::State<Shared>, on: bool) {
    {
        let mut s = shared.lock().unwrap();
        s.me.activity = on;
        save_config(&s);
    }
    push_state(&app, &shared);
}

#[tauri::command]
fn call_peer(app: AppHandle, shared: tauri::State<Shared>, id: String) {
    let shared = shared.inner().clone();
    thread::spawn(move || {
        let (addr, peer_name, msg) = {
            let s = shared.lock().unwrap();
            let Some(p) = s.peers.get(&id) else { return };
            (p.addr, p.name.clone(), Msg::Call { id: s.me.id.clone(), name: s.me.name.clone(), port: s.port })
        };
        match send_with(addr, &msg, CALL_REPLY_TIMEOUT) {
            Ok(resp) => {
                let their = resp.get("status").and_then(Value::as_str).unwrap_or("available").to_string();
                if their == "busy" {
                    let _ = app.emit("reply", json!({ "name": peer_name, "answer": "busy", "color": color_for(&id) }));
                    return;
                }
                shared.lock().unwrap().outgoing = Some(id.clone());
                let _ = app.emit("outgoing", json!({ "name": peer_name, "status": their, "color": color_for(&id) }));
                // Safety net in case their "missed" reply never arrives.
                thread::sleep(Duration::from_secs(CALL_TIMEOUT_SECS + 5));
                let mut s = shared.lock().unwrap();
                if s.outgoing.as_deref() == Some(id.as_str()) {
                    s.outgoing = None;
                    let _ = app.emit("reply", json!({ "name": peer_name, "answer": "missed", "color": color_for(&id) }));
                }
            }
            Err(_) => {
                let _ = app.emit("toast", json!({ "text": format!("Couldn't reach {peer_name}") }));
            }
        }
    });
}

#[tauri::command]
fn cancel_call(app: AppHandle, shared: tauri::State<Shared>) {
    let target = {
        let mut s = shared.lock().unwrap();
        let Some(id) = s.outgoing.take() else { return };
        s.peers.get(&id).map(|p| (p.addr, Msg::Cancel { id: s.me.id.clone() }))
    };
    let _ = app.emit("outgoing-end", ());
    if let Some((addr, msg)) = target {
        thread::spawn(move || send(addr, &msg));
    }
}

#[tauri::command]
fn answer(app: AppHandle, shared: tauri::State<Shared>, answer: String) {
    let answer = if answer == "coming" { "coming" } else { "busy" };
    answer_incoming(&app, shared.inner(), answer);
}

#[tauri::command]
fn resize(app: AppHandle, width: f64, height: f64, interactive: bool) {
    // Reports the island's size (for hover and clicks); the window itself stays fixed.
    place_island(&app, width.clamp(40.0, WIN_W), height.clamp(4.0, WIN_H), interactive);
}

#[tauri::command]
fn get_screen(screen: tauri::State<Screen>) -> Screen {
    *screen
}

#[tauri::command]
fn focus_island(app: AppHandle) {
    if let Some(pill) = app.get_webview_window("pill") {
        let _ = pill.set_focus();
    }
}

#[tauri::command]
fn quit(app: AppHandle, shared: tauri::State<Shared>) {
    broadcast_hello(shared.inner(), Some("offline"));
    app.exit(0);
}

#[tauri::command]
fn refresh(app: AppHandle, shared: tauri::State<Shared>) {
    let shared = shared.inner().clone();
    thread::spawn(move || {
        browse(&app, &shared);
        poll_once(&app, &shared);
        check_update(&app);
    });
}

// ---------- update check ----------

const LATEST_URL: &str = "https://cdn-quickcall.fliai.lk/latest.json";
const UPDATE_CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// Look for a newer version shortly after launch (once the network is up), then every few hours.
fn start_update_checks(app: AppHandle) {
    // The Microsoft Store version updates itself through the Store.
    if std::env::current_exe().is_ok_and(|p| p.to_string_lossy().to_lowercase().contains("\\windowsapps\\")) {
        return;
    }
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(10));
        loop {
            check_update(&app);
            thread::sleep(UPDATE_CHECK_EVERY);
        }
    });
}

/// Fetch latest.json with the system's curl (built into macOS and Windows 10/11, so no HTTP
/// library is needed; the CDN doesn't allow the web view to fetch it directly). Tells the UI
/// the latest version if it's newer than this one.
fn check_update(app: &AppHandle) {
    let mut cmd = std::process::Command::new("curl");
    cmd.args(["-fsSL", "--max-time", "10", LATEST_URL]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let Ok(out) = cmd.output() else { return };
    let Some(latest) = serde_json::from_slice::<Value>(&out.stdout).ok().and_then(|v| v["version"].as_str().map(str::to_string)) else {
        return;
    };
    let parse = |v: &str| v.split('.').map(|n| n.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let current = app.package_info().version.to_string();
    if parse(&latest) > parse(&current) {
        let _ = app.emit("update", json!({ "latest": clean(&latest, 20) }));
    }
}

// ---------- discovery ----------

/// The mDNS daemon, kept so discovery can be restarted.
struct Discovery(Option<ServiceDaemon>);

fn start_discovery(app: AppHandle, shared: Shared) {
    let mdns = ServiceDaemon::new().ok();
    if let Some(mdns) = &mdns {
        let (my_id, port) = {
            let s = shared.lock().unwrap();
            (s.me.id.clone(), s.port)
        };
        let short: String = my_id.chars().rev().take(12).collect();
        let props = [("id", my_id.as_str())];
        if let Ok(info) = ServiceInfo::new(SERVICE_TYPE, &format!("quickcall-{short}"), &format!("quickcall-{short}.local."), "", port, &props[..]) {
            let _ = mdns.register(info.enable_addr_auto());
        }
    }
    app.manage(Discovery(mdns));
    browse(&app, &shared);

    // mDNS backs off its queries up to once an hour, so someone whose announcement was lost
    // could stay invisible for ages. Restarting the browse resets that to 1, 2, 4... seconds.
    thread::spawn(move || loop {
        thread::sleep(REBROWSE_EVERY);
        browse(&app, &shared);
    });
}

/// (Re)start browsing: query the network right away and handle whoever answers.
/// A new browse replaces the old one, whose loop then ends.
fn browse(app: &AppHandle, shared: &Shared) {
    let Some(mdns) = app.state::<Discovery>().0.clone() else { return };
    let Ok(rx) = mdns.browse(SERVICE_TYPE) else { return };
    let my_id = shared.lock().unwrap().me.id.clone();
    let (app, shared) = (app.clone(), shared.clone());

    thread::spawn(move || {
        while let Ok(ev) = rx.recv() {
            let ServiceEvent::ServiceResolved(svc) = ev else { continue };
            let Some(id) = svc.get_property_val_str("id").map(str::to_string) else { continue };
            if id == my_id {
                continue;
            }
            let Some(ip) = svc.get_addresses_v4().into_iter().find(|ip| !ip.is_loopback()) else { continue };
            let addr = SocketAddr::new(IpAddr::V4(ip), svc.port);
            // Ask them who they are, and tell them who we are.
            let (app, shared) = (app.clone(), shared.clone());
            thread::spawn(move || {
                if let Ok(info) = send(addr, &Msg::Info) {
                    let get = |k: &str| info.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
                    upsert_peer(&shared, id, clean(&get("name"), 40), clean(&get("status"), 16), addr);
                    push_state(&app, &shared);
                }
                let hello = {
                    let s = shared.lock().unwrap();
                    hello_msg(&s, &s.me.status.clone())
                };
                let _ = send(addr, &hello);
            });
        }
    });
}

fn start_polling(app: AppHandle, shared: Shared) {
    thread::spawn(move || loop {
        thread::sleep(POLL_EVERY);
        poll_once(&app, &shared);
    });
}

/// Ask every known peer for its name and status; mark them offline after two misses.
fn poll_once(app: &AppHandle, shared: &Shared) {
    {
        let targets: Vec<(String, SocketAddr)> = shared.lock().unwrap().peers.iter().map(|(id, p)| (id.clone(), p.addr)).collect();
        let results: Vec<(String, Option<Value>)> = thread::scope(|sc| {
            let handles: Vec<_> = targets.into_iter().map(|(id, a)| sc.spawn(move || (id, send(a, &Msg::Info).ok()))).collect();
            handles.into_iter().filter_map(|h| h.join().ok()).collect()
        });
        let mut changed = false;
        {
            let mut s = shared.lock().unwrap();
            for (id, res) in results {
                let Some(p) = s.peers.get_mut(&id) else { continue };
                match res {
                    Some(info) => {
                        let name = clean(info.get("name").and_then(Value::as_str).unwrap_or_default(), 40);
                        let status = clean(info.get("status").and_then(Value::as_str).unwrap_or_default(), 16);
                        if !p.online || p.name != name || p.status != status {
                            changed = true;
                        }
                        p.online = true;
                        p.misses = 0;
                        p.name = name;
                        p.status = status;
                    }
                    None => {
                        p.misses = p.misses.saturating_add(1);
                        if p.online && p.misses >= 2 {
                            p.online = false;
                            changed = true;
                        }
                    }
                }
            }
        }
        if changed {
            push_state(app, shared);
        }
    }
}

/// macOS: a Launch Agent that starts the app at login and restarts it if it crashes or is
/// force-quit. Quitting from the island exits cleanly (status 0), so it then stays closed until
/// the next login. Written only when it changes; takes effect from the next login.
#[cfg(all(not(debug_assertions), target_os = "macos"))]
fn register_login_item() {
    let (Ok(exe), Some(home)) = (std::env::current_exe(), std::env::var_os("HOME")) else { return };
    let dir = PathBuf::from(home).join("Library/LaunchAgents");
    // Earlier versions registered through the autostart plugin under this name.
    let _ = std::fs::remove_file(dir.join("FLiAI Quick Call.plist"));
    let exe = exe.to_string_lossy().replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>lk.fliai.quickcall</string>
  <key>AssociatedBundleIdentifiers</key><array><string>lk.fliai.quickcall</string></array>
  <key>ProgramArguments</key><array><string>{exe}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>LimitLoadToSessionType</key><string>Aqua</string>
</dict>
</plist>
"#
    );
    let path = dir.join("lk.fliai.quickcall.plist");
    if std::fs::read_to_string(&path).ok().as_deref() != Some(plist.as_str()) {
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(&path, plist);
    }
}

fn main() {
    let mut builder = tauri::Builder::default();
    // One copy per user. The island is invisible until hovered, so people often launch the app
    // again thinking it's closed; a second copy would advertise itself from another port.
    // QUICKCALL_PROFILE is for running a second test copy on the same machine.
    if std::env::var("QUICKCALL_PROFILE").is_err() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = app.emit("toast", json!({ "text": "Quick Call is already running" }));
        }));
    }
    // Start at sign-in on Windows (registry Run key). macOS uses our own Launch Agent instead,
    // see register_login_item(), so it can also restart the app after a crash.
    #[cfg(not(target_os = "macos"))]
    {
        builder = builder.plugin(tauri_plugin_autostart::Builder::new().build());
    }
    builder
        .invoke_handler(tauri::generate_handler![
            get_state, get_screen, set_status, set_name, set_activity, call_peer, cancel_call, answer, resize, focus_island, refresh, quit
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory); // no Dock icon

            // Start at login. Re-registered every launch so the path stays right after updates.
            // The Microsoft Store (MSIX) build declares a startup task in its manifest instead.
            #[cfg(all(not(debug_assertions), target_os = "macos"))]
            register_login_item();
            #[cfg(all(not(debug_assertions), not(target_os = "macos")))]
            if !std::env::current_exe().is_ok_and(|p| p.to_string_lossy().to_lowercase().contains("\\windowsapps\\")) {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }

            let file = match std::env::var("QUICKCALL_PROFILE") {
                Ok(p) => format!("config-{p}.json"),
                Err(_) => "config.json".into(),
            };
            let config_path = app.path().app_config_dir()?.join(file);
            let me = load_config(&config_path);
            let shared: Shared = Arc::new(Mutex::new(State {
                me,
                port: 0,
                config_path,
                peers: HashMap::new(),
                incoming: None,
                outgoing: None,
                next_call_id: 0,
                activity: Vec::new(),
            }));
            save_config(&shared.lock().unwrap());
            app.manage(shared.clone());
            let geo: SharedGeo = Arc::default();
            app.manage(geo.clone());
            app.manage(detect_notch());

            let handle = app.handle().clone();
            let port = start_server(handle.clone(), shared.clone());
            shared.lock().unwrap().port = port;
            start_discovery(handle.clone(), shared.clone());
            start_polling(handle.clone(), shared);

            place_island(&handle, 1.0, 4.0, false); // the UI sizes it once loaded
            if let Some(pill) = app.get_webview_window("pill") {
                let _ = pill.set_visible_on_all_workspaces(true);
                raise(&pill, ISLAND_LEVEL);
                let _ = pill.show();
            }
            start_update_checks(handle.clone());
            start_hover_watch(handle, geo);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running FLiAI Quick Call");
}

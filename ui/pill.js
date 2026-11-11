const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const island = document.getElementById("island");
const content = document.getElementById("content");
const LABEL = { available: "Available", busy: "Busy", offline: "Offline" };
const SHOULDER = 14;   // matches the largest --s in CSS
const OUT_MS = 520;    // the close transition; content stays in place while the shape swallows it

let screen = { notch: false, notchWidth: 0, notchHeight: 0 };
let state = { me: { name: "", status: "available" }, peers: [] };
let hovering = false;
let editingName = false;
let incoming = null; // { name, color }
let outgoing = null; // { name, status, color }
let notice = null;   // { name, answer, color }
let act = null;      // the latest activity event, shown briefly
let actTimer = null;
let tab = "people";  // open island: "people" | "updates"
let openRow = "";   // the update whose details are showing (one at a time)
let unread = 0;      // updates that arrived while the Updates tab wasn't showing
let noticeTimer = null;
let mode = null;
let refreshing = false;
let version = "";
let latest = ""; // set when a newer version is out
let clearTimer = null;
let shownHtml = ""; // what's in the island now; unchanged content is never rebuilt, so a click can't land on a replaced button
const REFRESH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const initial = (name) => esc((name || "?").trim().charAt(0).toUpperCase());

function currentMode() {
  if (incoming) return "incoming";
  if (outgoing) return "outgoing";
  if (hovering || editingName) return "open";
  if (notice) return "notice";
  if (act) return "activity";
  return "hidden";
}

// ---------- content for each mode ----------

function compact(left, right) {
  if (screen.notch) {
    return `<div class="wings"><div class="wing">${left}</div><div class="gap"></div><div class="wing right">${right}</div></div>`;
  }
  return `<div class="row1">${left}<span class="grow"></span>${right}</div>`;
}

function outgoingHtml() {
  const busy = outgoing.status === "busy" ? " · Busy" : "";
  return compact(
    `<span class="av" style="--c:${esc(outgoing.color)}">${initial(outgoing.name)}</span>
     <span class="ellipsis">${screen.notch ? "" : "Calling "}${esc(outgoing.name)}${busy}</span>`,
    `<span class="bars" style="--c:${esc(outgoing.color)}"><i></i><i></i><i></i><i></i></span>
     <button class="x" data-act="cancel" title="Cancel">✕</button>`
  );
}

function noticeHtml() {
  const { name, answer } = notice;
  const icon = { coming: "✓", busy: "✕", missed: "–" }[answer] || "•";
  const text = { coming: "Accepted", busy: "Busy", missed: "No answer" }[answer] || answer;
  if (screen.notch) {
    return compact(
      `<span class="icon ${esc(answer)}">${icon}</span><span class="ellipsis">${esc(name)}</span>`,
      `<span>${esc(text)}</span>`
    );
  }
  const long = { coming: `${name} accepted`, busy: `${name} is busy right now`, missed: `${name} didn't answer` }[answer] || `${name}: ${answer}`;
  return compact(`<span class="icon ${esc(answer)}">${icon}</span><span class="ellipsis">${esc(long)}</span>`, "");
}

// ---------- deployment / GitHub activity ----------

const ACT_ICON = { started: "", success: "✓", failure: "✕", cancelled: "–", unknown: "?", opened: "•", merged: "✓", closed: "–" };
const repoShort = (r) => String(r).replace(/^snap-/, "");
const ENV_SHORT = { production: "prod" };

// A deploy that started but whose result never arrived (the relay laptop went offline mid-deploy),
// or that ended in a way we can't name. It says "not available": never a guess, never a spinner forever.
const DEPLOY_RESULT_WAIT = 30 * 60; // seconds
const ROW_LIFE = 12 * 60 * 60; // seconds; rows from a previous day leave the list
const noResult = (ev) => ev.kind === "deploy" && (ev.state === "unknown" || (ev.state === "started" && Date.now() / 1000 - ev.at > DEPLOY_RESULT_WAIT));

// The three parts of an update: what it is, its status (never cut short), and extra detail
// (who wrote it, the title) that gives way with "…" when space is tight.
function actText(ev) {
  const who = ev.actor || "";
  if (ev.kind === "deploy") {
    const status = noResult(ev)
      ? "not available"
      : { started: "deploying…", success: "deployed", failure: "failed", cancelled: "cancelled" }[ev.state];
    return { head: `${repoShort(ev.repo)} → ${ENV_SHORT[ev.env] || ev.env || "?"}`, status, extra: who };
  }
  const label = ev.kind === "pr" ? "PR" : "Issue";
  return { head: `${repoShort(ev.repo)} ${label} #${ev.number}`, status: ev.state, extra: [who, ev.title].filter(Boolean).join(" · ") };
}

function actIcon(ev) {
  if (noResult(ev)) return `<span class="icon act unknown">?</span>`;
  const cls = ev.kind === "deploy" ? ev.state : `${ev.kind}-${ev.state}`;
  return `<span class="icon act ${esc(cls)}">${ACT_ICON[ev.state] ?? "•"}</span>`;
}

function activityHtml() {
  const { head, status, extra } = actText(act);
  const more = extra ? `<span class="ellipsis">${esc(extra)}</span>` : "";
  if (screen.notch) {
    // Left of the notch: what it is. Right: its status first, so only the detail can be cut.
    return act.kind === "deploy"
      ? compact(`${actIcon(act)}<span class="keep">${esc(head)}</span>`, `<span class="keep">${esc(status)}</span>${more}`)
      : compact(`${actIcon(act)}<span class="keep">${esc(head)} ${esc(status)}</span>`, more);
  }
  return compact(`${actIcon(act)}<span class="keep"><b>${esc(head)}</b> ${esc(status)}</span>${more}`, "");
}

// A row keeps its key through its lifecycle (the id without its state), so it stays open as it changes.
const rowKey = (ev) => String(ev.id).replace(/:[^:]*$/, "");

// Everything about one update, uncut. Shown under its row when clicked.
function detailHtml(ev) {
  const line = (k, v) => `<div class="k">${k}</div><div class="v">${esc(v)}</div>`;
  const time = new Date(ev.at * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const { status } = actText(ev);
  const what = ev.kind === "deploy" ? `Deploy to ${ev.env || "?"}` : ev.kind === "pr" ? `Pull request #${ev.number}` : `Issue #${ev.number}`;
  return `<div class="act-detail">
    ${ev.title ? `<div class="t">${esc(ev.title)}</div>` : ""}
    <div class="kv">
      ${line("What", what)}
      ${line("Repo", ev.repo)}
      ${line("Status", !noResult(ev) ? status : ev.state === "unknown" ? "not available (ended without a clear result)" : "not available (no result received)")}
      ${line(ev.kind === "deploy" ? "Changes by" : "Opened by", ev.actor || "not available")}
      ${line("Time", time)}
    </div>
  </div>`;
}

function ago(at) {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - at);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

function clearActivity() {
  tab = "people";
  unread = 0;
  act = null;
  clearTimeout(actTimer);
}

function showActivity(ev) {
  if (!state.me.activity) return;
  if (!(hovering && tab === "updates")) unread++;
  act = ev;
  clearTimeout(actTimer);
  actTimer = setTimeout(() => { act = null; render(); }, ev.state === "failure" ? 9000 : 5000);
  render();
}

function incomingHtml() {
  return `
    <div class="incoming">
      <div class="who">
        <span class="av big ripple" style="--c:${esc(incoming.color)}">${initial(incoming.name)}</span>
        <div class="ellipsis">
          <div class="title ellipsis">${esc(incoming.name)}</div>
          <div class="sub">is calling you</div>
        </div>
      </div>
      <div class="actions">
        <button class="go" data-act="answer" data-v="coming">Accept</button>
        <button class="no" data-act="answer" data-v="busy">Busy</button>
      </div>
    </div>`;
}

function openHtml() {
  const { name, status } = state.me;
  const updatesOn = !!state.me.activity;
  if (!updatesOn) tab = "people";
  const next = status === "available" ? "busy" : "available";

  // Availability is one button that always shows its colour and word; a click swaps it.
  const statusSwitch = `<button class="avail ${status}" data-act="status" data-v="${next}" title="Switch to ${LABEL[next]}"><span class="dot ${status}"></span>${LABEL[status]}</button>`;
  const refreshBtn = `<button class="ghost refresh${refreshing ? " spin" : ""}" data-act="refresh" title="Find teammates again">${REFRESH_ICON}</button>`;
  const you = `<span class="nm">${editingName
    ? `<input id="name" maxlength="40" value="${esc(name)}">`
    : `<span class="ellipsis" title="You"><b>${esc(name)}</b></span><button class="ghost pen" data-act="edit-name" title="Change name">✎</button>`}</span>`;

  const people = state.peers.length
    ? state.peers.map((p) => `
        <div class="row">
          <span class="dot ${p.status}"></span>
          <span class="name ellipsis">${esc(p.name)}</span>
          <span class="st">${LABEL[p.status] || ""}</span>
          <button data-act="call" data-id="${esc(p.id)}" ${p.status === "available" ? "" : "disabled"}>Call</button>
        </div>`).join("")
    : `<div class="empty">No one yet. Teammates appear here<br>when they run FLiAI Quick Call on the same Wi-Fi.</div>`;

  const items = (state.activity || []).filter((ev) => Date.now() / 1000 - ev.at <= ROW_LIFE);
  const updates = items.length
    ? items.map((ev) => {
        const { head, status, extra } = actText(ev);
        const key = rowKey(ev);
        const on = key === openRow;
        const row = `<button class="act-row${on ? " on" : ""}" data-act="detail" data-id="${esc(key)}" aria-expanded="${on}">${actIcon(ev)}<span class="keep"><b>${esc(head)}</b> ${esc(status)}</span><span class="ellipsis">${on ? "" : esc(extra)}</span><span class="when">${ago(ev.at)}</span></button>`;
        return on ? row + detailHtml(ev) : row;
      }).join("")
    : `<div class="empty">No updates yet. Deployments, pull requests<br>and issues show here as they happen.</div>`;

  const online = state.peers.filter((p) => p.status !== "offline").length;
  const tabs = updatesOn
    ? `<div class="tabs">
         <button class="${tab === "people" ? "on" : ""}" data-act="tab" data-v="people">People <span class="n">${online}</span></button>
         <button class="${tab === "updates" ? "on" : ""}" data-act="tab" data-v="updates">Updates${unread ? ` <span class="badge">${unread}</span>` : ""}</button>
       </div>`
    : "";

  return `
    <div class="panel">
      <div class="head">
        <div class="hl">${statusSwitch}</div>
        <div class="hc">${you}</div>
        <div class="hr">${refreshBtn}</div>
      </div>
      ${tabs}
      <div class="list">${tab === "updates" ? updates : people}</div>
      <div class="foot">
        <button class="toggle" data-act="activity" data-v="${updatesOn ? "off" : "on"}" aria-pressed="${updatesOn}" title="Show deployments, pull requests and issues">
          <span class="sw${updatesOn ? " on" : ""}"><i></i></span>Deployment updates
        </button>
        <span class="ver">${version ? `v${esc(version)}` : ""}${latest ? `<span class="upd" title="Update available: run the update command"><i></i>v${esc(latest)}</span>` : ""}</span>
        <button class="ghost" data-act="quit">Quit</button>
      </div>
    </div>`;
}

// ---------- layout + animation ----------

function render() {
  const m = currentMode();
  const { notch, notchWidth, notchHeight } = screen;
  const isCompact = m === "outgoing" || m === "notice" || m === "activity";
  const top = notch ? notchHeight : 0; // expanded content sits below the notch

  const from = shape(); // where the island is right now, mid-animation or not
  island.className =`m-${m}${isCompact ? " m-compact" : ""}${notch ? " notch" : ""}`;
  const color = incoming?.color || outgoing?.color || notice?.color;
  if (color) island.style.setProperty("--c", color);

  let w, h;
  if (m === "hidden") {
    [w, h] = notch ? [notchWidth, notchHeight] : [110, 6];
  } else if (isCompact) {
    [w, h] = notch ? [notchWidth + 240, notchHeight] : [300, 38];
  } else {
    w = m === "incoming" ? 380 : 340;
  }

  clearTimeout(clearTimer);
  if (m === "hidden") {
    // Leave the old content in place to blur out while the shape pulls back, then clear it.
    if (mode && mode !== "hidden") {
      content.classList.remove("in");
      content.classList.add("out");
    }
    clearTimer = setTimeout(() => { if (currentMode() === "hidden") { content.innerHTML = ""; shownHtml = ""; } }, OUT_MS);
  } else {
    content.classList.remove("out");
    setContentWidth(w);
    content.style.paddingTop = isCompact ? "0" : `${top}px`;
    content.style.setProperty("--t", `${notchHeight}px`);
    content.style.setProperty("--nw", `${notchWidth}px`);
    const html = { outgoing: outgoingHtml, notice: noticeHtml, activity: activityHtml, incoming: incomingHtml, open: openHtml }[m]();
    if (html !== shownHtml) {
      const scrolled = content.querySelector(".list")?.scrollTop || 0; // a rebuild must not jump the list back to the top
      content.innerHTML = html;
      shownHtml = html;
      const list = content.querySelector(".list");
      if (list && scrolled) list.scrollTop = scrolled;
      wireNameInput(); // only for freshly built content, so listeners aren't stacked
    }
  }
  if (isCompact && !notch) {
    // No notch (other Macs, Windows): the pill grows to fit its text instead of cutting it.
    const row = content.querySelector(".row1");
    if (row) {
      const kids = [...row.children].filter((el) => !el.classList.contains("grow"));
      const cs = getComputedStyle(row);
      const need = kids.reduce((sum, el) => sum + (el.classList.contains("ellipsis") ? el.scrollWidth : el.offsetWidth), 0)
        + (parseFloat(cs.columnGap) || 0) * Math.max(0, kids.length - 1)
        + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 4;
      w = Math.min(Math.max(need, ROW_MIN), ROW_MAX);
      setContentWidth(w);
    }
  }
  if (isCompact && notch) {
    // Grow both wings (equally, so the gap stays over the notch) to fit the longer side.
    const need = Math.max(...[...content.querySelectorAll(".wing")].map(naturalWidth));
    w = notchWidth + 2 * WING_PAD + 2 * Math.min(Math.max(need, WING_MIN), WING_MAX);
    setContentWidth(w);
  }
  if (h === undefined) h = content.offsetHeight;

  if (m !== mode) {
    if (m !== "hidden") {
      content.classList.remove("in");
      void content.offsetWidth; // restart the reveal animation
      content.classList.add("in");
    }
    mode = m;
  }

  setIsland(w, h, m !== "hidden" && m !== "notice" && m !== "activity");
  const target =`${island.className}|${w}|${h}`;
  if (target !== lastTarget) {
    lastTarget = target;
    morph(from, m === "hidden");
  }
}

// ---------- the liquid morph ----------
// Opening stretches sideways, then drops down with a soft overshoot. Closing pulls up, then
// narrows back into the notch or bar, without bounce. [duration, delay] in ms per property.
// Corners are animated as plain border radii: WebKit stops width/height animations from applying
// while custom properties (--r, --s) animate on the same element, which made the island jump.
const RADIUS = ["border-bottom-left-radius", "border-bottom-right-radius"];
const MOTION = {
  open: { easing: "cubic-bezier(0.34, 1.4, 0.5, 1)", width: [620, 0], height: [660, 70], radius: [500, 50], opacity: [300, 0] },
  close: { easing: "cubic-bezier(0.5, 0, 0.25, 1)", width: [420, 100], height: [360, 0], radius: [360, 0], opacity: [300, 200] },
};
const SHAPE_PROPS = ["width", "height", ...RADIUS, "opacity"];
const camel = (p) => p.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
let morphs = [];
let lastTarget = "";

const shape = () => {
  const cs = getComputedStyle(island);
  return Object.fromEntries(SHAPE_PROPS.map((p) => [p, cs.getPropertyValue(p).trim()]));
};

// Animate from `from` to wherever the island's styles now say it should be. These are Web
// Animations, which get their start time on the first frame they draw, so they never skip.
function morph(from, closing) {
  morphs.forEach((a) => a.cancel());
  morphs = [];
  const to = shape();
  const m = closing ? MOTION.close : MOTION.open;
  for (const p of SHAPE_PROPS) {
    if (!from[p] || from[p] === to[p]) continue;
    const [duration, delay] = m[RADIUS.includes(p) ? "radius" : p];
    const k = camel(p);
    morphs.push(island.animate([{ [k]: from[p] }, { [k]: to[p] }], { duration, delay, easing: m.easing, fill: "backwards" }));
  }
}

const ROW_MIN = 300;  // the pill without a notch: at least this wide,
const ROW_MAX = 560;  // and past this, the detail ends with "…"
const WING_PAD = 12;  // matches .wings horizontal padding
const WING_MIN = 108; // the old fixed wing width
const WING_MAX = 240; // past this, text ends with "…"

// Width a wing's content wants, counting truncated text at its full length.
function naturalWidth(wing) {
  const kids = [...wing.children];
  const gap = parseFloat(getComputedStyle(wing).columnGap) || 0;
  return kids.reduce((sum, el) => sum + (el.classList.contains("ellipsis") ? el.scrollWidth : el.offsetWidth), 0)
    + gap * Math.max(0, kids.length - 1) + 2; // +2 so text never rounds into an ellipsis
}

// The content keeps its final width while the shape grows around it; --cw centers it.
function setContentWidth(w) {
  content.style.width = `${w}px`;
  content.style.setProperty("--cw", `${w}px`);
}

// The window is fixed and transparent; the island animates inside it. Tell the app the
// island's final footprint (with its shoulders) so hover and clicks line up with it.
function setIsland(w, h, interactive) {
  island.style.width = `${w}px`;
  island.style.height = `${h}px`;
  invoke("resize", { width: w + 2 * SHOULDER, height: h, interactive });
}

function wireNameInput() {
  const input = document.getElementById("name");
  if (!input) return;
  input.focus();
  input.select();
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") saveName(input.value);
    if (e.key === "Escape") { editingName = false; render(); }
  });
  input.addEventListener("blur", () => saveName(input.value));
}

function saveName(value) {
  if (!editingName) return;
  editingName = false;
  if (value.trim()) invoke("set_name", { name: value });
  render();
}

function showNotice(n) {
  notice = n;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { notice = null; render(); }, 4500);
  render();
}

// ---------- events ----------

document.body.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const { act, v, id } = el.dataset;
  switch (act) {
    case "status": invoke("set_status", { status: v }); break;
    case "edit-name": editingName = true; invoke("focus_island"); render(); break;
    case "call": invoke("call_peer", { id }); break;
    case "cancel": invoke("cancel_call"); break;
    case "answer": invoke("answer", { answer: v }); break;
    case "refresh":
      if (refreshing) break;
      refreshing = true;
      render();
      invoke("refresh");
      setTimeout(() => { refreshing = false; render(); }, 1200); // matches the spin; results stream in via "state"
      break;
    case "detail":
      openRow = openRow === id ? "" : id; // opening one closes the one before it
      render();
      content.querySelector(".act-row.on")?.nextElementSibling?.scrollIntoView({ block: "nearest" });
      break;
    case "tab":
      tab = v;
      if (tab === "updates") unread = 0;
      render();
      break;
    case "activity":
      if (v === "off") clearActivity(); // (the click's own `act` shadows the global here)
      invoke("set_activity", { on: v === "on" });
      break;
    case "quit": invoke("quit"); break;
  }
});

listen("update", (e) => { latest = e.payload.latest; render(); });
listen("activity", (e) => showActivity(e.payload));
// Keep the Updates tab honest while it's open: ages tick, a silent deploy turns to "no result yet".
setInterval(() => { if (currentMode() === "open" && tab === "updates") render(); }, 30000);
listen("hover", (e) => { hovering = e.payload; if (hovering && tab === "updates") unread = 0; render(); });
listen("state", (e) => { state = e.payload; render(); });
listen("incoming", (e) => { incoming = e.payload; render(); });
listen("incoming-end", () => { incoming = null; render(); });
listen("outgoing", (e) => { outgoing = e.payload; render(); });
listen("outgoing-end", () => { outgoing = null; render(); });
listen("reply", (e) => { outgoing = null; showNotice(e.payload); });
listen("toast", (e) => { outgoing = null; showNotice({ name: e.payload.text, answer: "missed", color: "" }); });

window.__TAURI__.app?.getVersion().then((v) => { version = v; render(); }).catch(() => {});

Promise.all([invoke("get_screen"), invoke("get_state")]).then(([sc, st]) => {
  screen = sc;
  state = st;
  render();
});

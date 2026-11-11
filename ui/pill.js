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

const ACT_ICON = { started: "", success: "✓", failure: "✕", cancelled: "–", opened: "•", merged: "✓", closed: "–" };
const repoShort = (r) => String(r).replace(/^snap-/, "");

// Short text for the compact island and the activity list.
function actText(ev) {
  if (ev.kind === "deploy") {
    const what = { started: "deploying…", success: "deployed", failure: "deploy failed", cancelled: "deploy cancelled" }[ev.state];
    return { head: `${repoShort(ev.repo)} → ${ev.env || "?"}`, tail: what };
  }
  const label = ev.kind === "pr" ? "PR" : "Issue";
  return { head: `${repoShort(ev.repo)} ${label} #${ev.number} ${ev.state}`, tail: ev.title };
}

function actIcon(ev) {
  const cls = ev.kind === "deploy" ? ev.state : `${ev.kind}-${ev.state}`;
  return `<span class="icon act ${esc(cls)}">${ACT_ICON[ev.state] ?? "•"}</span>`;
}

function activityHtml() {
  const { head, tail } = actText(act);
  if (screen.notch) {
    return compact(`${actIcon(act)}<span class="ellipsis">${esc(head)}</span>`, `<span class="ellipsis">${esc(tail)}</span>`);
  }
  return compact(`${actIcon(act)}<span class="ellipsis"><b>${esc(head)}</b> ${esc(tail)}</span>`, "");
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

  const items = (state.activity || []);
  const updates = items.length
    ? items.map((ev) => {
        const { head, tail } = actText(ev);
        return `<div class="act-row">${actIcon(ev)}<span class="ellipsis"><b>${esc(head)}</b> ${esc(tail || "")}</span><span class="when">${ago(ev.at)}</span></div>`;
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
      content.innerHTML = html;
      shownHtml = html;
      wireNameInput(); // only for freshly built content, so listeners aren't stacked
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

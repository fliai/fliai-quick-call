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
let noticeTimer = null;
let mode = null;
let refreshing = false;
let clearTimer = null;
const REFRESH_ICON = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>`;

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const initial = (name) => esc((name || "?").trim().charAt(0).toUpperCase());

function currentMode() {
  if (incoming) return "incoming";
  if (outgoing) return "outgoing";
  if (hovering || editingName) return "open";
  if (notice) return "notice";
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
  const text = { coming: "Coming", busy: "Busy", missed: "No answer" }[answer] || answer;
  if (screen.notch) {
    return compact(
      `<span class="icon ${esc(answer)}">${icon}</span><span class="ellipsis">${esc(name)}</span>`,
      `<span>${esc(text)}</span>`
    );
  }
  const long = { coming: `${name} is coming`, busy: `${name} is busy right now`, missed: `${name} didn't answer` }[answer] || `${name}: ${answer}`;
  return compact(`<span class="icon ${esc(answer)}">${icon}</span><span class="ellipsis">${esc(long)}</span>`, "");
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
        <button class="go" data-act="answer" data-v="coming">Coming</button>
        <button class="no" data-act="answer" data-v="busy">Busy</button>
      </div>
    </div>`;
}

function openHtml() {
  const { name, status } = state.me;
  const rows = state.peers.length
    ? state.peers.map((p) => `
        <div class="row">
          <span class="dot ${p.status}"></span>
          <span class="name ellipsis">${esc(p.name)}</span>
          <span class="st">${LABEL[p.status] || ""}</span>
          <button data-act="call" data-id="${esc(p.id)}" ${p.status === "available" ? "" : "disabled"}>Call</button>
        </div>`).join("")
    : `<div class="empty">No one yet. Teammates appear here<br>when they run FLiAI Quick Call on the same Wi-Fi.</div>`;
  const you = editingName
    ? `<input id="name" maxlength="40" value="${esc(name)}">`
    : `<span class="ellipsis">You: <b>${esc(name)}</b></span><button class="ghost" data-act="edit-name" title="Change name">✎</button>
       <button class="ghost refresh${refreshing ? " spin" : ""}" data-act="refresh" title="Find teammates again">${REFRESH_ICON}</button>`;
  return `
    <div class="panel">
      <div class="seg">
        <button class="${status === "available" ? "on" : ""}" data-act="status" data-v="available"><span class="dot available"></span>Available</button>
        <button class="${status === "busy" ? "on" : ""}" data-act="status" data-v="busy"><span class="dot busy"></span>Busy</button>
      </div>
      <div class="you">${you}</div>
      <div class="list">${rows}</div>
      <div class="foot"><button class="ghost" data-act="quit">Quit</button></div>
    </div>`;
}

// ---------- layout + animation ----------

function render() {
  const m = currentMode();
  const { notch, notchWidth, notchHeight } = screen;
  const isCompact = m === "outgoing" || m === "notice";
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
    clearTimer = setTimeout(() => { if (currentMode() === "hidden") content.innerHTML = ""; }, OUT_MS);
  } else {
    content.classList.remove("out");
    content.style.width = `${w}px`;
    content.style.paddingTop = isCompact ? "0" : `${top}px`;
    content.style.setProperty("--t", `${notchHeight}px`);
    content.style.setProperty("--nw", `${notchWidth}px`);
    content.innerHTML = { outgoing: outgoingHtml, notice: noticeHtml, incoming: incomingHtml, open: openHtml }[m]();
  }
  if (isCompact && notch) {
    // Grow both wings (equally, so the gap stays over the notch) to fit the longer side.
    const need = Math.max(...[...content.querySelectorAll(".wing")].map(naturalWidth));
    w = notchWidth + 2 * WING_PAD + 2 * Math.min(Math.max(need, WING_MIN), WING_MAX);
    content.style.width = `${w}px`;
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

  setIsland(w, h, m !== "hidden" && m !== "notice");
  const target = `${island.className}|${w}|${h}`;
  if (target !== lastTarget) {
    lastTarget = target;
    morph(from, m === "hidden");
  }
  wireNameInput();
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
    case "quit": invoke("quit"); break;
  }
});

listen("hover", (e) => { hovering = e.payload; render(); });
listen("state", (e) => { state = e.payload; render(); });
listen("incoming", (e) => { incoming = e.payload; render(); });
listen("incoming-end", () => { incoming = null; render(); });
listen("outgoing", (e) => { outgoing = e.payload; render(); });
listen("outgoing-end", () => { outgoing = null; render(); });
listen("reply", (e) => { outgoing = null; showNotice(e.payload); });
listen("toast", (e) => { outgoing = null; showNotice({ name: e.payload.text, answer: "missed", color: "" }); });

Promise.all([invoke("get_screen"), invoke("get_state")]).then(([sc, st]) => {
  screen = sc;
  state = st;
  render();
});

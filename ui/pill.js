const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const island = document.getElementById("island");
const content = document.getElementById("content");
const LABEL = { available: "Available", busy: "Busy", offline: "Offline" };
const SHOULDER = 14;   // matches the largest --s in CSS
const PAD = 20;        // room around the island for the glow
const SPRING_MS = 560; // matches the width/height transition

let screen = { notch: false, notchWidth: 0, notchHeight: 0 };
let state = { me: { name: "", status: "available" }, peers: [] };
let hovering = false;
let editingName = false;
let incoming = null; // { name, color, soft }
let outgoing = null; // { name, status, color }
let notice = null;   // { name, answer, color }
let noticeTimer = null;
let mode = null;
let win = { w: 0, h: 0 };
let shrinkTimer = null;

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
        <span class="av big ${incoming.soft ? "" : "ripple"}" style="--c:${esc(incoming.color)}">${initial(incoming.name)}</span>
        <div class="ellipsis">
          <div class="title ellipsis">${esc(incoming.name)}</div>
          <div class="sub">${incoming.soft ? "is calling · you're Busy, so it's quiet" : "is calling you"}</div>
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
          <button data-act="call" data-id="${esc(p.id)}" ${p.status === "offline" ? "disabled" : ""}>Call</button>
        </div>`).join("")
    : `<div class="empty">No one yet. Teammates appear here<br>when they run FLiAI Quick Call on the same Wi-Fi.</div>`;
  const you = editingName
    ? `<input id="name" maxlength="40" value="${esc(name)}">`
    : `<span class="ellipsis">You: <b>${esc(name)}</b></span><button class="ghost" data-act="edit-name" title="Change name">✎</button>`;
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

  island.className = `m-${m}${isCompact ? " m-compact" : ""}${notch ? " notch" : ""}`;
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

  content.style.width = `${w}px`;
  content.style.paddingTop = isCompact || m === "hidden" ? "0" : `${top}px`;
  content.style.setProperty("--t", `${notchHeight}px`);
  content.style.setProperty("--nw", `${notchWidth}px`);
  content.innerHTML = { hidden: () => "", outgoing: outgoingHtml, notice: noticeHtml, incoming: incomingHtml, open: openHtml }[m]();
  if (h === undefined) h = content.offsetHeight;

  if (m !== mode) {
    content.classList.remove("in");
    void content.offsetWidth; // restart the reveal animation
    content.classList.add("in");
    mode = m;
  }

  setIsland(w, h, m !== "hidden" && m !== "notice");
  wireNameInput();
}

// Grow the window first, let the island spring inside it, then trim the window.
function setIsland(w, h, interactive) {
  const target = interactive ? { w: w + 2 * (SHOULDER + PAD), h: h + PAD } : { w: w + 2 * SHOULDER, h };
  const grown = { w: Math.max(target.w, win.w), h: Math.max(target.h, win.h) };
  clearTimeout(shrinkTimer);
  invoke("resize", { width: grown.w, height: grown.h, interactive });
  win = grown;
  island.style.width = `${w}px`;
  island.style.height = `${h}px`;
  shrinkTimer = setTimeout(() => {
    win = target;
    invoke("resize", { width: target.w, height: target.h, interactive });
  }, SPRING_MS);
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

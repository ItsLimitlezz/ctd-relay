// OBS dock (GET /dock): a compact, dark page for an OBS "Custom Browser Dock" (300–500 px wide).
// The token comes from the URL fragment (#token=ctd_pat_…), which browsers never send to the
// server; the script sends it as an Authorization header to /api/v1. No inline scripts (CSP
// script-src 'self'); user text is rendered with textContent only.

import { PLATFORM_BADGES } from '../chat/overlay-assets.js';

export const DOCK_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="dark">
<title>CTD Relay</title>
<link rel="stylesheet" href="/dock/dock.css">
</head>
<body>
<div id="setup" class="setup" hidden>
  <h1>CTD Relay dock</h1>
  <p id="setup-reason"></p>
  <ol>
    <li>Open CTD Relay in your browser and go to <b>Settings → API</b>.</li>
    <li>Click <b>OBS dock</b> (or create a token with <b>status:read</b> and <b>chat:read</b>).</li>
    <li>Copy the dock URL (it ends with <code>/dock#token=ctd_pat_…</code>).</li>
    <li>In OBS: <b>Docks → Custom Browser Docks</b>, paste it as the URL.</li>
  </ol>
  <p class="hint">Each profile has its own dock link. A token for every profile shows the default profile unless the link ends with <code>&amp;profile=&lt;profile id&gt;</code>.</p>
</div>
<main id="app" class="app" hidden>
  <section id="status-panel" class="status-panel" hidden>
    <header class="session">
      <span id="session-pill" class="pill">OFFLINE</span>
      <span id="profile-chip" class="profile-chip" hidden><span id="profile-dot" class="profile-dot"></span><span id="profile-name" class="profile-name"></span></span>
      <span id="session-timer" class="timer"></span>
      <span id="test-badge" class="pill test" hidden>TEST MODE</span>
      <span class="spacer"></span>
      <label class="alert-toggle" title="Flash and beep when a destination goes down or a feed is lost"><input type="checkbox" id="alert-toggle"> Alert</label>
    </header>
    <div id="session-title" class="session-title"></div>
    <div id="feeds" class="feeds"></div>
    <ul id="issues" class="issues" hidden></ul>
    <ul id="destinations" class="destinations"></ul>
    <div id="toast" class="toast" hidden></div>
  </section>
  <section id="chat-panel" class="chat-panel" hidden>
    <ol id="chat" class="chat" aria-live="polite"></ol>
  </section>
</main>
<div id="conn" class="conn"></div>
<script src="/dock/dock.js" defer></script>
</body>
</html>
`;

export const DOCK_CSS = `:root {
  color-scheme: dark;
  --bg: #1e1f26;
  --panel: #272a33;
  --panel-2: #2f323d;
  --border: #3a3e4b;
  --text: #e8e9ee;
  --muted: #9a9daa;
  --red: #e5484d;
  --red-bg: #3b1f24;
  --green: #3dd68c;
  --amber: #f1a10d;
  --blue: #5b8def;
  --font: "Segoe UI", Inter, system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 12px/1.35 var(--font); }
body { display: flex; flex-direction: column; overflow: hidden; }
[hidden] { display: none !important; }
.setup { padding: 12px; overflow: auto; }
.setup h1 { font-size: 14px; margin: 0 0 8px; }
.setup p { color: var(--amber); margin: 0 0 8px; }
.setup ol { padding-left: 18px; margin: 0; }
.setup li { margin-bottom: 4px; }
.setup code { background: var(--panel-2); padding: 0 3px; border-radius: 3px; overflow-wrap: anywhere; }
.setup .hint { color: var(--muted); margin-top: 8px; }
.profile-chip { display: inline-flex; align-items: center; gap: 4px; min-width: 0; flex: 0 1 auto; font-weight: 600; }
.profile-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.profile-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.app { flex: 1; display: flex; flex-direction: column; min-height: 0; }
.status-panel { flex: 0 0 auto; padding: 6px 8px; border-bottom: 1px solid var(--border); background: var(--panel); max-height: 60vh; overflow: auto; }
.app.status-only .status-panel { max-height: none; flex: 1; border-bottom: 0; }
.session { display: flex; align-items: center; gap: 6px; }
.spacer { flex: 1; }
.pill { display: inline-block; padding: 1px 6px; border-radius: 3px; font-weight: 700; font-size: 11px; letter-spacing: 0.04em; background: var(--panel-2); color: var(--muted); }
.pill.live { background: var(--red); color: #fff; }
.pill.busy { background: var(--amber); color: #1b1b1b; }
.pill.test { background: var(--blue); color: #fff; }
.timer { font-variant-numeric: tabular-nums; font-weight: 600; }
.alert-toggle { color: var(--muted); display: inline-flex; align-items: center; gap: 3px; cursor: pointer; user-select: none; }
.alert-toggle input { margin: 0; }
.session-title { margin: 4px 0 2px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.feeds { display: flex; gap: 8px; flex-wrap: wrap; color: var(--muted); margin: 2px 0 4px; }
.feed .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 4px; background: var(--muted); vertical-align: 0; }
.feed.online .dot { background: var(--green); }
.feed .name { color: var(--text); font-weight: 600; margin-right: 4px; }
.destinations { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.dest { background: var(--panel-2); border-radius: 4px; padding: 3px 6px; border-left: 3px solid transparent; }
.dest.live { border-left-color: var(--green); }
.dest.down { background: var(--red-bg); border-left-color: var(--red); }
.dest.disabled { opacity: 0.55; }
.dest.flash { animation: flash 0.4s ease-in-out 3; }
.dest .row { display: flex; align-items: center; gap: 5px; min-width: 0; }
.dest .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
.dest .phase { color: var(--muted); white-space: nowrap; }
.dest.live .phase { color: var(--green); }
.dest.down .phase { color: var(--red); font-weight: 700; }
.dest .stats { color: var(--muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.dest .reason { color: #ffb4b6; margin-top: 2px; overflow-wrap: anywhere; }
.dest .info { color: var(--muted); margin-top: 2px; overflow-wrap: anywhere; }
.badge { display: inline-block; min-width: 16px; height: 16px; line-height: 16px; border-radius: 3px; text-align: center; font-size: 10px; font-weight: 800; flex: 0 0 auto; }
.issues { list-style: none; margin: 0 0 3px; padding: 0; display: flex; flex-direction: column; gap: 3px; }
.issue { background: var(--panel-2); border-radius: 4px; padding: 3px 6px; border-left: 3px solid var(--amber); overflow-wrap: anywhere; }
.issue.critical { background: var(--red-bg); border-left-color: var(--red); }
.issue.info { border-left-color: var(--muted); }
.issue .title { font-weight: 600; }
.issue .detail { color: var(--muted); margin-top: 2px; }
.toast { margin-top: 4px; padding: 3px 6px; border-radius: 3px; background: var(--panel-2); overflow-wrap: anywhere; }
.toast.warn { color: var(--amber); }
.toast.error { color: var(--red); }
.chat-panel { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 8px; }
.chat { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.msg { overflow-wrap: anywhere; }
.msg .badge { margin-right: 4px; vertical-align: 1px; }
.msg .author { font-weight: 700; margin-right: 4px; }
.msg.event { font-style: italic; color: var(--muted); }
.msg .emote { height: 1.6em; vertical-align: middle; }
.msg .link { color: var(--blue); }
.conn { flex: 0 0 auto; color: var(--muted); font-size: 10px; padding: 1px 8px; border-top: 1px solid var(--border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.conn.bad { color: var(--amber); }
body.flash { animation: flash-bg 0.4s ease-in-out 3; }
@keyframes flash { 50% { background: var(--red); } }
@keyframes flash-bg { 50% { background: #5a1d22; } }
@media (prefers-reduced-motion: reduce) { .dest.flash, body.flash { animation: none; } }
`;

/** Embedded in a template literal: no backticks or placeholders besides the constants injected here. */
export const DOCK_JS = `(function () {
  'use strict';
  var BADGES = ${JSON.stringify(PLATFORM_BADGES)};
  var FALLBACK = { label: 'Chat', letter: '?', bg: '#888888', fg: '#FFFFFF' };
  var API = '/api/v1';
  var TOKEN_RE = /^ctd_pat_[A-Za-z0-9_-]{43}$/;
  var HEX_COLOR = /^#[0-9a-f]{6}$/i;
  var MAX_CHAT = 200;
  var STALL_MS = 45000;
  var PHASES = {
    idle: 'Idle', disabled: 'Disabled', 'waiting-for-feed': 'Waiting for feed', preparing: 'Preparing',
    connecting: 'Connecting', confirming: 'Confirming', live: 'Live', retrying: 'Retrying',
    recovering: 'Recovering', ending: 'Ending', error: 'Error'
  };
  var ALERT_KEY = 'ctd-dock-alert';

  function $(id) { return document.getElementById(id); }

  var fragment = readFragment();
  var token = fragment.token;
  var scopes = [];
  // The token's own profile, else #…&profile=<id>, else the default profile (set by start()).
  var profile = null;
  var session = null;
  var feeds = {};
  var destinations = [];
  var issues = []; // open issues (GET /status → issues, then issue.raised / issue.cleared; docs/API.md §15)
  var cursor = null;
  var retryMs = 1000;
  var stopped = false;
  var shownChat = new Map();
  var toastTimer = null;
  var audio = null;

  function readFragment() {
    try {
      var p = new URLSearchParams(location.hash.replace(/^#/, ''));
      return { token: p.get('token') || '', profile: p.get('profile') || '' };
    } catch (e) {
      return { token: '', profile: '' };
    }
  }

  function withProfile(path) {
    return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'profile=' + encodeURIComponent(profile);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function badge(platform) {
    var known = Object.prototype.hasOwnProperty.call(BADGES, platform);
    var b = known ? BADGES[platform] : FALLBACK;
    var node = el('span', 'badge', b.letter);
    node.title = b.label;
    node.style.backgroundColor = b.bg;
    node.style.color = b.fg;
    return node;
  }

  function has(scope) { return scopes.indexOf(scope) >= 0; }

  function setConn(text, bad) {
    var c = $('conn');
    c.textContent = text;
    c.className = bad ? 'conn bad' : 'conn';
  }

  function showSetup(reason) {
    stopped = true;
    $('app').hidden = true;
    $('conn').hidden = true;
    $('setup').hidden = false;
    $('setup-reason').textContent = reason;
  }

  function HttpError(status, retryAfter) {
    this.status = status;
    this.retryAfter = retryAfter;
  }

  function api(path) {
    return fetch(API + path, { headers: { authorization: 'Bearer ' + token }, cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new HttpError(res.status, Number(res.headers.get('retry-after')) || 0);
      return res.json();
    });
  }

  // ---- alert ----

  function alertEnabled() {
    try { return localStorage.getItem(ALERT_KEY) !== 'off'; } catch (e) { return true; }
  }

  function beep() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      if (!audio) audio = new Ctx();
      if (audio.state === 'suspended' && audio.resume) audio.resume();
      var osc = audio.createOscillator();
      var gain = audio.createGain();
      osc.type = 'square';
      osc.frequency.value = 880;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + 0.2);
    } catch (e) { /* no audio */ }
  }

  function flash(destinationId) {
    if (!$('alert-toggle').checked) return;
    document.body.classList.remove('flash');
    void document.body.offsetWidth;
    document.body.classList.add('flash');
    setTimeout(function () { document.body.classList.remove('flash'); }, 1300);
    if (destinationId) {
      var row = document.querySelector('[data-dest="' + String(destinationId).replace(/[^A-Za-z0-9_-]/g, '') + '"]');
      if (row) row.classList.add('flash');
    }
    beep();
  }

  // ---- status ----

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function renderTimer() {
    var t = $('session-timer');
    if (!session || (session.status !== 'live' && session.status !== 'starting') || !session.startedAt) {
      t.textContent = '';
      return;
    }
    var start = Date.parse(session.startedAt);
    if (!isFinite(start)) { t.textContent = ''; return; }
    var s = Math.max(0, Math.floor((Date.now() - start) / 1000));
    t.textContent = Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60);
  }

  function renderSession() {
    var pill = $('session-pill');
    var status = session ? session.status : 'offline';
    pill.textContent = status === 'live' ? 'LIVE' : status === 'starting' ? 'STARTING' : status === 'stopping' ? 'STOPPING' : 'OFFLINE';
    pill.className = 'pill' + (status === 'live' ? ' live' : status === 'starting' || status === 'stopping' ? ' busy' : '');
    $('test-badge').hidden = !(session && session.testMode);
    var title = $('session-title');
    title.textContent = session && session.title ? session.title : '';
    title.title = title.textContent;
    renderTimer();
  }

  function renderProfile(p) {
    if (!p || p.id !== profile) return;
    var chip = $('profile-chip');
    var name = $('profile-name');
    name.textContent = p.name || '';
    chip.title = 'Profile: ' + (p.name || '');
    $('profile-dot').style.backgroundColor = typeof p.color === 'string' && HEX_COLOR.test(p.color) ? p.color : '';
    chip.hidden = !p.name;
  }

  function renderFeeds() {
    var box = $('feeds');
    box.textContent = '';
    ['landscape', 'vertical'].forEach(function (name) {
      var f = feeds[name];
      var node = el('span', 'feed' + (f && f.online ? ' online' : ''));
      node.appendChild(el('span', 'dot'));
      node.appendChild(el('span', 'name', name === 'landscape' ? 'Landscape' : 'Vertical'));
      var parts = [];
      if (f && f.online) {
        if (f.video && f.video.width && f.video.height) parts.push(f.video.width + '×' + f.video.height);
        if (typeof f.bitrateKbps === 'number') parts.push(Math.round(f.bitrateKbps) + ' kbps');
      } else {
        parts.push('offline');
      }
      node.appendChild(el('span', '', parts.join(' · ')));
      box.appendChild(node);
    });
  }

  function renderDestinations() {
    var list = $('destinations');
    list.textContent = '';
    destinations.forEach(function (d) {
      var cls = 'dest' + (d.down ? ' down' : d.live ? ' live' : '') + (d.enabled ? '' : ' disabled');
      var li = el('li', cls);
      li.setAttribute('data-dest', String(d.id).replace(/[^A-Za-z0-9_-]/g, ''));
      var row = el('div', 'row');
      row.appendChild(badge(d.platform));
      var name = el('span', 'name', d.name);
      name.title = d.name;
      row.appendChild(name);
      var stats = [];
      if (d.stats && d.live) {
        if (typeof d.stats.bitrateKbps === 'number') stats.push(Math.round(d.stats.bitrateKbps) + ' kbps');
        if (typeof d.stats.fps === 'number') stats.push(Math.round(d.stats.fps) + ' fps');
      }
      if (typeof d.viewers === 'number') stats.push(d.viewers + ' viewers');
      if (d.recoveries > 0) stats.push('↻' + d.recoveries);
      if (stats.length) row.appendChild(el('span', 'stats', stats.join(' · ')));
      row.appendChild(el('span', 'phase', d.down ? 'DOWN' : PHASES[d.phase] || d.phase));
      li.appendChild(row);
      if (d.down) li.appendChild(el('div', 'reason', d.message || (PHASES[d.phase] || d.phase)));
      else if (d.message && d.phase !== 'live') li.appendChild(el('div', 'info', d.message));
      list.appendChild(li);
    });
  }

  // Open issues that aren't a down destination (those already are red rows below): a lost feed,
  // the whole stream down, a source or output in OBS. Critical first, then oldest first.
  function renderIssues() {
    var list = $('issues');
    if (!list) return;
    var rank = { info: 0, warning: 1, critical: 2 };
    var shown = issues.filter(function (i) { return i.kind !== 'destination.down'; });
    shown.sort(function (a, b) { return (rank[b.severity] || 0) - (rank[a.severity] || 0) || (a.firstSeen || 0) - (b.firstSeen || 0); });
    list.textContent = '';
    shown.forEach(function (i) {
      var li = el('li', 'issue ' + (i.severity === 'critical' ? 'critical' : i.severity === 'info' ? 'info' : 'warning'));
      li.appendChild(el('div', 'title', i.title || i.kind));
      if (i.message) li.appendChild(el('div', 'detail', i.message));
      list.appendChild(li);
    });
    list.hidden = shown.length === 0;
  }

  function upsertIssue(i) {
    issues = issues.filter(function (x) { return x.id !== i.id; });
    issues.push(i);
    renderIssues();
  }

  function removeIssue(id) {
    issues = issues.filter(function (x) { return x.id !== id; });
    renderIssues();
  }

  function applyStatus(s) {
    session = s.session;
    feeds = {};
    (s.feeds || []).forEach(function (f) { feeds[f.feed] = f; });
    destinations = s.destinations || [];
    issues = s.issues || []; // absent on a server older than v1.11
    renderSession();
    renderFeeds();
    renderDestinations();
    renderIssues();
  }

  function upsertDestination(d) {
    for (var i = 0; i < destinations.length; i++) {
      if (destinations[i].id === d.id) { destinations[i] = d; renderDestinations(); return; }
    }
    destinations.push(d);
    renderDestinations();
  }

  function toast(level, message) {
    var t = $('toast');
    t.textContent = message;
    t.className = 'toast ' + (level === 'warn' || level === 'error' ? level : '');
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 10000);
  }

  // ---- chat ----

  function chatPanel() { return $('chat-panel'); }

  function atBottom() {
    var p = chatPanel();
    return p.scrollHeight - p.scrollTop - p.clientHeight < 40;
  }

  function addChat(m) {
    if (!m || typeof m.id !== 'string' || shownChat.has(m.id)) return;
    var stick = atBottom();
    var li = el('li', m.kind === 'event' ? 'msg event' : 'msg');
    li.appendChild(badge(m.platform));
    var user = m.user || {};
    var author = el('span', 'author', user.name || '');
    if (typeof user.color === 'string' && HEX_COLOR.test(user.color)) author.style.color = user.color;
    li.appendChild(author);
    var text = el('span', 'text');
    var frags = Array.isArray(m.fragments) && m.fragments.length ? m.fragments : [{ type: 'text', text: m.text }];
    frags.forEach(function (f) {
      if (f.type === 'emote' && typeof f.image === 'string' && f.image.indexOf('https://') === 0) {
        var img = document.createElement('img');
        img.className = 'emote';
        img.alt = f.text;
        img.title = f.text;
        img.referrerPolicy = 'no-referrer';
        img.src = f.image;
        text.appendChild(img);
      } else {
        text.appendChild(el('span', f.type === 'link' ? 'link' : '', f.text));
      }
    });
    li.appendChild(text);
    $('chat').appendChild(li);
    shownChat.set(m.id, { node: li, dest: m.destinationId, userId: user.id, name: user.name, login: user.login, pmid: m.platformMessageId });
    var list = $('chat');
    while (list.childElementCount > MAX_CHAT && list.firstElementChild) removeChatNode(list.firstElementChild);
    if (stick) chatPanel().scrollTop = chatPanel().scrollHeight;
  }

  function removeChatNode(node) {
    shownChat.forEach(function (entry, id) { if (entry.node === node) shownChat.delete(id); });
    node.remove();
  }

  function removeChatWhere(pred) {
    var victims = [];
    shownChat.forEach(function (entry, id) { if (pred(entry, id)) victims.push(id); });
    victims.forEach(function (id) {
      var entry = shownChat.get(id);
      shownChat.delete(id);
      if (entry) entry.node.remove();
    });
  }

  function lower(v) { return typeof v === 'string' ? v.toLowerCase() : null; }

  function moderate(type, d) {
    if (!d || typeof d.destinationId !== 'string') return;
    if (type === 'chat.message.deleted') {
      removeChatWhere(function (e, id) {
        return e.dest === d.destinationId && (id === d.messageId || (d.platformMessageId && (e.pmid === d.platformMessageId || id === d.platform + ':' + d.platformMessageId)));
      });
    } else if (type === 'chat.user.cleared') {
      var name = lower(d.userName);
      var nameForm = d.platform + ':name:';
      var realId = function (id) { return typeof id === 'string' && id.indexOf(nameForm) !== 0; };
      removeChatWhere(function (e) {
        if (e.dest !== d.destinationId) return false;
        // Same rule as the server: two real user ids decide alone; names only when either side has none.
        if (realId(d.userId) && realId(e.userId)) return e.userId === d.userId;
        if (d.userId && e.userId === d.userId) return true;
        return name !== null && (lower(e.name) === name || lower(e.login) === name);
      });
    } else if (type === 'chat.cleared') {
      removeChatWhere(function (e) { return e.dest === d.destinationId; });
    }
  }

  // ---- loading ----

  function loadStatus() {
    return api(withProfile('/status')).then(applyStatus);
  }

  function loadProfile() {
    return api('/profiles/' + encodeURIComponent(profile)).then(renderProfile);
  }

  function loadChat() {
    return api(withProfile('/chat?limit=100')).then(function (res) {
      $('chat').textContent = '';
      shownChat = new Map();
      (res.items || []).forEach(function (env) { addChat(env.data); });
      chatPanel().scrollTop = chatPanel().scrollHeight;
    });
  }

  function refetch() {
    var jobs = [];
    if (has('status:read')) jobs.push(loadStatus());
    if (has('chat:read')) jobs.push(loadChat());
    return Promise.all(jobs);
  }

  function dispatch(env) {
    if (!env || typeof env.type !== 'string') return;
    var d = env.data;
    switch (env.type) {
      case 'system.reset': refetch().catch(function () {}); break;
      case 'stream.status': session = d; renderSession(); break;
      case 'feed.status': if (d && d.feed) { feeds[d.feed] = d; renderFeeds(); } break;
      case 'destination.status': if (d && d.id) upsertDestination(d); break;
      case 'destination.down': if (d) flash(d.destinationId); break;
      case 'issue.raised':
        if (d && d.id) {
          upsertIssue(d);
          // A new critical problem that isn't a destination (those flash on destination.down).
          if (d.update === false && d.severity === 'critical' && d.kind !== 'destination.down') flash(null);
        }
        break;
      case 'issue.cleared': if (d && d.id) removeIssue(d.id); break;
      case 'system.notice': if (d && d.message) toast(d.level, d.message); break;
      case 'profile.status': renderProfile(d); break;
      case 'profiles.changed': if (has('status:read')) loadProfile().catch(function () {}); break;
      case 'chat.message': addChat(d); break;
      case 'chat.message.deleted':
      case 'chat.user.cleared':
      case 'chat.cleared': moderate(env.type, d); break;
    }
  }

  function handleFrame(frame) {
    var data = [];
    frame.split('\\n').forEach(function (line) {
      if (line.indexOf('data:') === 0) data.push(line.slice(line.charAt(5) === ' ' ? 6 : 5));
    });
    if (!data.length) return false;
    var env;
    try { env = JSON.parse(data.join('\\n')); } catch (e) { return false; }
    if (env && typeof env.id === 'string') cursor = env.id;
    dispatch(env);
    return true;
  }

  function retryLater(ms) {
    if (stopped) return;
    setTimeout(connect, ms + Math.floor(Math.random() * 250));
  }

  function connect() {
    if (stopped) return;
    var headers = { authorization: 'Bearer ' + token, accept: 'text/event-stream' };
    if (cursor) headers['last-event-id'] = cursor;
    var openedAt = Date.now();
    var healthy = false;
    var delivered = false;
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var watchdog = null;
    function stopWatchdog() {
      if (watchdog) clearTimeout(watchdog);
      watchdog = null;
    }
    function feedWatchdog() {
      if (!controller) return;
      stopWatchdog();
      // The server pings every 15 s: this much silence means a dead connection. Reconnect.
      watchdog = setTimeout(function () { controller.abort(); }, STALL_MS);
    }
    var init = { headers: headers, cache: 'no-store' };
    if (controller) init.signal = controller.signal;
    feedWatchdog();
    fetch(API + withProfile('/events'), init).then(function (res) {
      if (res.status === 401) { stopWatchdog(); showSetup('This token is invalid or was revoked. Create a new one.'); return null; }
      if (res.status === 404) { stopWatchdog(); showSetup('This profile no longer exists. Copy the dock link again in Settings → API.'); return null; }
      if (!res.ok || !res.body) throw new HttpError(res.status, Number(res.headers.get('retry-after')) || 0);
      setConn('Connected');
      healthy = true;
      feedWatchdog();
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) throw new Error('stream ended');
          feedWatchdog();
          buf += decoder.decode(r.value, { stream: true }).replace(/\\r\\n/g, '\\n');
          var i;
          while ((i = buf.indexOf('\\n\\n')) >= 0) {
            var frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            if (handleFrame(frame)) delivered = true;
          }
          return pump();
        });
      }
      return pump();
    }).catch(function (err) {
      stopWatchdog();
      if (stopped) return;
      // A stream that delivered events (or stayed up) was healthy: don't inherit an outage's backoff.
      if (delivered || (healthy && Date.now() - openedAt > 10000)) retryMs = 1000;
      var wait = err && err.retryAfter ? err.retryAfter * 1000 : retryMs;
      setConn('Reconnecting…', true);
      retryLater(wait);
      retryMs = Math.min(retryMs * 2, 30000);
    });
  }

  function start() {
    if (!TOKEN_RE.test(token)) {
      showSetup(token ? 'The token in the dock URL is not a CTD Relay API token.' : 'No API token in the dock URL.');
      return;
    }
    setConn('Connecting…');
    api('/').then(function (me) {
      scopes = me && me.token && Array.isArray(me.token.scopes) ? me.token.scopes : [];
      var own = me && me.token && typeof me.token.profileId === 'string' ? me.token.profileId : '';
      profile = own || fragment.profile || 'default';
      var showStatus = has('status:read');
      var showChat = has('chat:read');
      if (!showStatus && !showChat) { showSetup('This token has no scopes the dock can use.'); return null; }
      $('setup').hidden = true;
      $('app').hidden = false;
      $('status-panel').hidden = !showStatus;
      $('chat-panel').hidden = !showChat;
      if (!showChat) $('app').className = 'app status-only';
      // Take the cursor first, then load: the stream replays whatever happens in between.
      return api(withProfile('/events/poll')).then(function (p) {
        cursor = p && p.next ? p.next : null;
        return showStatus ? loadProfile() : null;
      }).then(refetch).then(connect);
    }).catch(function (err) {
      if (err instanceof HttpError && err.status === 401) {
        showSetup('This token is invalid or was revoked. Create a new one.');
        return;
      }
      if (err instanceof HttpError && (err.status === 403 || err.status === 404) && profile) {
        showSetup('This dock link names a profile this token can’t show (deleted, or another profile’s token). Copy the dock link again in Settings → API.');
        return;
      }
      setConn('Cannot reach CTD Relay; retrying…', true);
      setTimeout(start, Math.max(retryMs, err && err.retryAfter ? err.retryAfter * 1000 : 0));
      retryMs = Math.min(retryMs * 2, 30000);
    });
  }

  var toggle = $('alert-toggle');
  toggle.checked = alertEnabled();
  toggle.addEventListener('change', function () {
    try { localStorage.setItem(ALERT_KEY, toggle.checked ? 'on' : 'off'); } catch (e) { /* ignore */ }
    if (toggle.checked) beep();
  });
  setInterval(renderTimer, 1000);
  start();
})();
`;

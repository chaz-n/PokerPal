/* global io, qrcode */
const socket = io();

// PWA install support (no-op on plain HTTP where SWs are unavailable).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

const $ = (id) => document.getElementById(id);
const screens = {
  home: $('screen-home'),
  lobby: $('screen-lobby'),
  table: $('screen-table'),
  league: $('screen-league'),
};

let state = null; // last game state from server
let session = loadSession(); // {code, playerId, token}
let raiseOpen = false;

// ---------------------------------------------------------------- session

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('countchip-session')) || null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem('countchip-session', JSON.stringify(s));
  else localStorage.removeItem('countchip-session');
}

// ---------------------------------------------------------------- socket

socket.on('connect', () => {
  if (session) socket.emit('rejoin', session);
});

socket.on('rejoin_failed', () => {
  saveSession(null);
  show('home');
});

socket.on('joined', ({ code, playerId, token }) => {
  saveSession({ code, playerId, token });
});

socket.on('left', () => {
  saveSession(null);
  state = null;
  show('home');
});

socket.on('state', (s) => {
  // If we're no longer in the player list, the host removed us.
  if (session && !s.players.some((p) => p.id === session.playerId)) {
    saveSession(null);
    state = null;
    show('home');
    toast('You were removed from the game.');
    return;
  }
  state = s;
  render();
});

socket.on('game_error', ({ message }) => toast(message));

// ---------------------------------------------------------------- home screen

// ---------------------------------------------------------------- theme

const THEME_LABELS = { auto: '◐ Auto', light: '☀ Light', dark: '● Dark' };
let theme = localStorage.getItem('countchip-theme') || 'auto';

function applyTheme() {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  $('theme-btn').textContent = THEME_LABELS[theme];
}

$('theme-btn').addEventListener('click', () => {
  const order = ['auto', 'light', 'dark'];
  theme = order[(order.indexOf(theme) + 1) % order.length];
  localStorage.setItem('countchip-theme', theme);
  applyTheme();
});
applyTheme();

const savedName = localStorage.getItem('countchip-name');
if (savedName) $('name-input').value = savedName;
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('code-input').value = urlCode.toUpperCase();

function myName() {
  const name = $('name-input').value.trim();
  localStorage.setItem('countchip-name', name);
  return name;
}

$('set-mode').addEventListener('change', () => {
  $('level-length-label').classList.toggle('hidden', $('set-mode').value !== 'tournament');
});

$('create-btn').addEventListener('click', () => {
  socket.emit('create', {
    name: myName(),
    leagueCode: $('set-league').value.trim().toUpperCase() || undefined,
    settings: {
      startingStack: Number($('set-stack').value),
      smallBlind: Number($('set-sb').value),
      bigBlind: Number($('set-bb').value),
      turnTimer: Number($('set-timer').value),
      mode: $('set-mode').value,
      levelMinutes: Number($('set-level-minutes').value),
      currency: $('set-currency').value,
      chipValue: Number($('set-chip-value').value) || 0,
      ante: Number($('set-ante').value) || 0,
      allowStraddle: $('set-straddle').checked,
    },
  });
});

$('join-btn').addEventListener('click', () => {
  socket.emit('join', { code: $('code-input').value, name: myName() });
});

$('code-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('join-btn').click();
});

// ---------------------------------------------------------------- table actions

$('lobby-start-btn').addEventListener('click', () => socket.emit('start_hand'));
$('next-hand-btn').addEventListener('click', () => socket.emit('start_hand'));
$('lobby-leave-btn').addEventListener('click', leave);
$('table-leave-btn').addEventListener('click', leave);

function leave() {
  const msg = amHost()
    ? 'Leave this game? Hosting passes to the first seat unless you make someone else host first (♛).'
    : 'Leave this game?';
  if (confirm(msg)) socket.emit('leave');
}

$('btn-fold').addEventListener('click', () => socket.emit('action', { type: 'fold' }));
$('btn-check-call').addEventListener('click', () => {
  const me = getMe();
  if (!me || !state) return;
  const toCall = state.currentBet - me.betThisRound;
  socket.emit('action', { type: toCall > 0 ? 'call' : 'check' });
});

$('btn-raise').addEventListener('click', () => {
  raiseOpen = true;
  render();
});
$('raise-cancel').addEventListener('click', () => {
  raiseOpen = false;
  render();
});
$('raise-confirm').addEventListener('click', () => {
  socket.emit('action', { type: 'raise', amount: Number($('raise-amount').value) });
  raiseOpen = false;
});

$('raise-slider').addEventListener('input', () => {
  $('raise-amount').value = $('raise-slider').value;
});
$('raise-amount').addEventListener('input', () => {
  $('raise-slider').value = $('raise-amount').value;
});
$('raise-min').addEventListener('click', () => setRaise(minRaiseTo()));
$('raise-allin').addEventListener('click', () => setRaise(maxRaiseTo()));
$('raise-pot').addEventListener('click', () => {
  const me = getMe();
  if (!me) return;
  // Pot-size raise: current bet + (pot after you call)
  const potAfterCall = state.potTotal + (state.currentBet - me.betThisRound);
  setRaise(state.currentBet + potAfterCall);
});

$('host-force-fold').addEventListener('click', () => socket.emit('host_action', { type: 'fold' }));
$('host-force-check').addEventListener('click', () => socket.emit('host_action', { type: 'check' }));

$('apply-settings').addEventListener('click', () => {
  socket.emit('update_settings', {
    smallBlind: Number($('live-sb').value),
    bigBlind: Number($('live-bb').value),
    ante: Number($('live-ante').value) || 0,
    allowStraddle: $('live-straddle').checked,
    turnTimer: Number($('live-timer').value),
  });
  $('host-settings').open = false;
});

// Tick all visible countdowns twice a second.
setInterval(() => {
  if (!state) return;
  if (state.actorDeadline) {
    const secs = Math.max(0, Math.ceil((state.actorDeadline - Date.now()) / 1000));
    document.querySelectorAll('.countdown').forEach((el) => {
      el.textContent = ` ${secs}s`;
    });
  }
  const lc = document.querySelector('.level-countdown');
  if (lc && state.levelEndsAt) lc.textContent = fmtClock(state.levelEndsAt - Date.now());
}, 500);

function fmtClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Money display: chips stay the unit of play; money appears alongside when
// the host set a chip value.
function moneyOn() {
  return state && state.valueMinor > 0 && state.currency;
}

function fmtMoney(chips) {
  const v = (chips * state.valueMinor) / 100;
  const sign = v < 0 ? '-' : '';
  return `${sign}${state.currency}${Math.abs(v).toFixed(2)}`;
}

function countdownSpan() {
  const span = document.createElement('span');
  span.className = 'countdown';
  if (state.actorDeadline) {
    span.textContent = ` ${Math.max(0, Math.ceil((state.actorDeadline - Date.now()) / 1000))}s`;
  }
  return span;
}

function setRaise(v) {
  const clamped = Math.max(minRaiseTo(), Math.min(maxRaiseTo(), Math.floor(v)));
  $('raise-amount').value = clamped;
  $('raise-slider').value = clamped;
}

function minRaiseTo() {
  return Math.min(state.minRaiseTo, maxRaiseTo());
}

function maxRaiseTo() {
  const me = getMe();
  return me ? me.betThisRound + me.chips : 0;
}

// ---------------------------------------------------------------- rendering

function show(name) {
  for (const [key, el] of Object.entries(screens)) {
    el.classList.toggle('hidden', key !== name);
  }
}

function myId() {
  return session ? session.playerId : null;
}

function getMe() {
  return state ? state.players.find((p) => p.id === myId()) || null : null;
}

function amHost() {
  return state && state.actingHostId != null && state.actingHostId === myId();
}

function render() {
  if (leagueOpen) return; // viewing the leaderboard — don't yank the screen away
  if (!state) return show('home');
  turnAlert();
  keepAwake();
  if (state.stage === 'lobby') return renderLobby();
  renderTable();
}

// Buzz the phone and flag the tab title when it becomes your turn.
let wasMyTurn = false;
function turnAlert() {
  const myTurn = state.actorId != null && state.actorId === myId();
  if (myTurn && !wasMyTurn && navigator.vibrate) navigator.vibrate([150, 75, 150]);
  wasMyTurn = myTurn;
  document.title = myTurn ? '● Your turn — CountChip' : 'CountChip — virtual chips for real cards';
}

// Keep the screen on during a game (needs HTTPS; silently unavailable otherwise).
let wakeLock = null;
async function keepAwake() {
  if (!('wakeLock' in navigator) || wakeLock || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    /* denied (e.g. battery saver) — not critical */
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state) keepAwake();
});

function seatControls(p) {
  const frag = document.createDocumentFragment();
  frag.appendChild(seatBtn('↑', 'Move up', () => socket.emit('move_player', { targetId: p.id, direction: -1 })));
  frag.appendChild(seatBtn('↓', 'Move down', () => socket.emit('move_player', { targetId: p.id, direction: 1 })));
  if (p.chips > 0 && !(state.next && state.next.dealerId === p.id)) {
    frag.appendChild(seatBtn('D', 'Give the button next hand', () => socket.emit('set_dealer', { targetId: p.id })));
  }
  if (!p.isHost && p.id !== myId()) {
    frag.appendChild(
      seatBtn('♛', 'Make host', () => {
        if (confirm(`Make ${p.name} the host? They'll take over running the game.`)) {
          socket.emit('transfer_host', { targetId: p.id });
        }
      })
    );
  }
  return frag;
}

function seatBtn(label, title, onClick) {
  const b = document.createElement('button');
  b.className = 'btn seat';
  b.textContent = label;
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

function kickButton(p) {
  const btn = document.createElement('button');
  btn.className = 'btn kick';
  btn.textContent = '✕';
  btn.title = `Remove ${p.name}`;
  btn.addEventListener('click', () => {
    if (confirm(`Remove ${p.name} from the game?`)) socket.emit('kick', { targetId: p.id });
  });
  return btn;
}

// The QR encodes the join URL; regenerate only when the code changes.
let qrForCode = null;
function renderQr() {
  if (typeof qrcode === 'undefined' || qrForCode === state.code) return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(`${location.origin}/?code=${state.code}`);
    qr.make();
    $('lobby-qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
    qrForCode = state.code;
  } catch {
    /* URL too long or lib missing — the 4-letter code still works */
  }
}

function settingsSummary() {
  const s = state.settings;
  const parts = [`Stack ${s.startingStack}`, `Blinds ${s.smallBlind}/${s.bigBlind}`];
  if (s.ante > 0) parts.push(`Ante ${s.ante}`);
  if (s.mode === 'tournament') parts.push(`Tournament · ${s.levelMinutes} min levels`);
  if (s.allowStraddle) parts.push('Straddles');
  if (moneyOn()) parts.push(`1 chip = ${fmtMoney(1)}`);
  if (state.leagueName) parts.push(`League: ${state.leagueName}`);
  return parts.join(' · ');
}

// Straddle opt-in: shown between hands to the player who'll be UTG next hand.
function renderStraddle(container) {
  container.innerHTML = '';
  const me = getMe();
  if (!state.settings.allowStraddle || !me || !state.next) return;
  if (state.next.utgId !== me.id || me.chips <= 0) return;
  const btn = document.createElement('button');
  btn.className = 'btn wide straddle-btn' + (me.straddleNext ? ' on' : '');
  btn.textContent = me.straddleNext
    ? `✓ Straddling next hand (${state.settings.bigBlind * 2})`
    : `Straddle next hand (${state.settings.bigBlind * 2})`;
  btn.addEventListener('click', () => socket.emit('set_straddle', { on: !me.straddleNext }));
  container.appendChild(btn);
}

function renderLobby() {
  show('lobby');
  $('lobby-code').textContent = state.code;
  renderQr();
  renderStraddle($('lobby-straddle-area'));
  $('lobby-settings').textContent = settingsSummary();
  const ul = $('lobby-players');
  ul.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.className = 'p-who';
    left.appendChild(document.createTextNode(p.name + (p.id === myId() ? ' (you)' : '')));
    appendPositionBadges(left, p, state.next);
    li.appendChild(left);

    const right = document.createElement('span');
    right.className = 'row-controls';
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'HOST';
      right.appendChild(tag);
    }
    if (amHost()) {
      right.appendChild(seatControls(p));
      if (p.id !== myId()) right.appendChild(kickButton(p));
    }
    li.appendChild(right);
    ul.appendChild(li);
  }
  const canStart = amHost() && state.players.length >= 2;
  $('lobby-start-btn').classList.toggle('hidden', !amHost());
  $('lobby-start-btn').disabled = !canStart;
  $('lobby-start-btn').textContent =
    state.players.length >= 2 ? 'Start first hand' : 'Waiting for players…';
  $('lobby-wait').classList.toggle('hidden', amHost());
  $('lobby-help').classList.toggle('hidden', !amHost());
}

function renderTable() {
  show('table');
  const me = getMe();
  const betting = ['preflop', 'flop', 'turn', 'river'].includes(state.stage);

  $('table-code').textContent = `GAME ${state.code}`;
  $('table-hand').textContent = `HAND #${state.handNumber}`;
  $('pot-amount').textContent = state.potTotal;
  renderLevelNote();

  // dealer prompt
  let prompt = '';
  if (betting) prompt = state.prompt;
  else if (state.stage === 'showdown') {
    prompt = state.ranOut
      ? 'All-in! Deal out the rest of the board, then compare hands.'
      : 'Showdown — reveal your hands!';
  } else if (state.stage === 'hand_over') prompt = 'Hand complete. Badges show next hand’s positions.';
  $('dealer-prompt').textContent = prompt;

  renderPlayers(betting);
  renderActionBar(me, betting);
  renderHostForce(betting);
  renderShowdown();
  renderHandOver();
  renderScoreboard();
  renderPayouts();
  renderSettle();
  renderHostSettings();
  renderLog();
}

function renderLevelNote() {
  const el = $('level-note');
  const on = state.level != null;
  el.classList.toggle('hidden', !on);
  if (!on) return;
  el.innerHTML = '';
  const s = state.settings;
  let text = `LEVEL ${state.level} · ${s.smallBlind}/${s.bigBlind}`;
  el.appendChild(document.createTextNode(text));
  if (state.levelPaused) {
    el.appendChild(document.createTextNode(' · ⏸ ON BREAK'));
  } else if (state.levelEndsAt && state.nextLevel) {
    el.appendChild(
      document.createTextNode(` · ${state.nextLevel.smallBlind}/${state.nextLevel.bigBlind} in `)
    );
    const cd = document.createElement('span');
    cd.className = 'level-countdown';
    cd.textContent = fmtClock(state.levelEndsAt - Date.now());
    el.appendChild(cd);
  }
}

function renderPayouts() {
  const card = $('payouts-card');
  const on = !!state.payouts;
  card.classList.toggle('hidden', !on);
  if (!on) return;
  const el = $('payouts');
  el.innerHTML = '';
  const p = state.payouts;
  const info = document.createElement('p');
  info.className = 'hint';
  info.textContent =
    `${p.entries} buy-in${p.entries === 1 ? '' : 's'} · prize pool ${p.pool} chips` +
    (moneyOn() ? ` (${fmtMoney(p.pool)})` : '');
  el.appendChild(info);
  const ul = document.createElement('ul');
  ul.className = 'settle-list';
  const medals = ['🥇', '🥈', '🥉'];
  for (const place of p.places) {
    const li = document.createElement('li');
    li.textContent =
      `${medals[place.place - 1] || place.place} ${Math.round(place.pct * 100)}% — ${place.chips} chips` +
      (moneyOn() ? ` (${fmtMoney(place.chips)})` : '');
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

function playerName(id) {
  const p = state.players.find((x) => x.id === id);
  return p ? p.name : '?';
}

function renderSettle() {
  const hint = $('settle-hint');
  const ul = $('settle-list');
  ul.innerHTML = '';
  if (!state.settle.length) {
    hint.textContent = 'Everyone is even — nothing to settle.';
  } else {
    hint.textContent = moneyOn()
      ? 'Fewest payments to square the night:'
      : 'Fewest chip payments to square the night (set a chip value when creating a game to see money):';
    for (const t of state.settle) {
      const li = document.createElement('li');
      li.textContent = moneyOn()
        ? `${playerName(t.fromId)} pays ${playerName(t.toId)} ${fmtMoney(t.chips)} (${t.chips} chips)`
        : `${playerName(t.fromId)} pays ${playerName(t.toId)} ${t.chips} chips`;
      ul.appendChild(li);
    }
  }
  renderLeaguePanel();
}

function renderLeaguePanel() {
  const panel = $('league-panel');
  panel.classList.remove('hidden');
  const host = amHost();
  const betweenHands = state.stage === 'hand_over' || state.stage === 'lobby';
  $('league-status').textContent = state.leagueCode
    ? `League: ${state.leagueName} (${state.leagueCode})`
    : host
      ? 'No league attached — create one to keep an all-time leaderboard.'
      : 'No league attached.';
  $('league-host-controls').classList.toggle('hidden', !host || !!state.leagueCode);
  $('league-save-btn').classList.toggle('hidden', !host || !state.leagueCode);
  $('league-save-btn').disabled = !betweenHands;
  $('league-open-btn').classList.toggle('hidden', !state.leagueCode);
}

$('league-attach-btn').addEventListener('click', () => {
  socket.emit('league_attach', { code: $('league-attach-input').value.trim().toUpperCase() });
});
$('league-create-btn').addEventListener('click', () => {
  const name = $('league-create-input').value.trim();
  if (!name) return toast('Give the league a name.');
  socket.emit('league_create', { name });
});
$('league-save-btn').addEventListener('click', () => socket.emit('league_save'));
$('league-open-btn').addEventListener('click', () => {
  if (state && state.leagueCode) openLeague(state.leagueCode);
});

function renderScoreboard() {
  const el = $('scoreboard');
  el.innerHTML = '';
  const table = document.createElement('table');
  const head = table.insertRow();
  for (const h of ['Player', 'Buy-in', 'Stack', 'Net', 'Wins']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  const rows = [...state.players]
    .map((p) => ({ ...p, stack: p.chips + p.totalCommitted, net: p.chips + p.totalCommitted - p.buyIn }))
    .sort((a, b) => b.net - a.net);
  for (const p of rows) {
    const tr = table.insertRow();
    tr.insertCell().textContent = p.name;
    tr.insertCell().textContent = p.buyIn;
    tr.insertCell().textContent = p.stack;
    const net = tr.insertCell();
    net.textContent = (p.net > 0 ? `+${p.net}` : p.net) + (moneyOn() ? ` (${fmtMoney(p.net)})` : '');
    if (p.net > 0) net.className = 'net-pos';
    if (p.net < 0) net.className = 'net-neg';
    tr.insertCell().textContent = p.handsWon;
  }
  el.appendChild(table);
}

function renderHostSettings() {
  const panel = $('host-settings');
  panel.classList.toggle('hidden', !amHost());
  if (!amHost()) return;
  // Don't clobber the host's typing while the panel is open.
  if (!panel.open) {
    $('live-sb').value = state.settings.smallBlind;
    $('live-bb').value = state.settings.bigBlind;
    $('live-ante').value = state.settings.ante;
    $('live-straddle').checked = state.settings.allowStraddle;
    $('live-timer').value = String(state.settings.turnTimer);
  }
  const pauseBtn = $('pause-level-btn');
  pauseBtn.classList.toggle('hidden', state.level == null);
  if (state.level != null) {
    const started = state.levelEndsAt || state.levelPaused;
    pauseBtn.disabled = !started;
    pauseBtn.textContent = state.levelPaused
      ? '▶ Resume level clock'
      : '⏸ Pause level clock (break)';
  }
}

$('pause-level-btn').addEventListener('click', () => {
  socket.emit('tournament_pause', { paused: !state.levelPaused });
});

function renderPlayers(betting) {
  const ul = $('player-list');
  ul.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    if (p.id === state.actorId) li.classList.add('actor');
    if (betting && !p.inHand) li.classList.add('folded');
    if (p.id === myId()) li.classList.add('me');

    const who = document.createElement('div');
    who.className = 'p-who';
    const dot = document.createElement('span');
    dot.className = 'dot' + (p.connected ? '' : ' off');
    dot.title = p.connected ? 'online' : 'offline';
    who.appendChild(dot);
    who.appendChild(document.createTextNode(p.name));
    if (p.isHost) {
      const crown = document.createElement('span');
      crown.className = 'host-tag';
      crown.textContent = '♛';
      crown.title = 'Host';
      who.appendChild(crown);
    }
    // Between hands the badges preview the NEXT hand's positions.
    appendPositionBadges(who, p, state.next || state);
    if (state.stage === 'hand_over' && amHost()) who.appendChild(seatControls(p));

    const stack = document.createElement('div');
    stack.className = 'p-stack';
    stack.textContent = p.chips;

    const status = document.createElement('div');
    status.className = 'p-status';
    if (p.id === state.actorId) {
      status.textContent = 'to act…';
      if (state.actorDeadline) status.appendChild(countdownSpan());
    } else if (betting && !p.inHand && p.lastAction) status.textContent = 'folded';
    else status.textContent = p.lastAction || (p.chips === 0 && !p.inHand ? 'busted' : '');

    const bet = document.createElement('div');
    bet.className = 'p-bet';
    bet.textContent = p.betThisRound > 0 ? `bet ${p.betThisRound}` : '';

    if (state.stage === 'hand_over' && amHost() && p.id !== myId()) who.appendChild(kickButton(p));
    li.append(who, stack, status, bet);
    ul.appendChild(li);
  }
}

function appendPositionBadges(el, p, pos) {
  if (!pos) return;
  if (p.id === pos.dealerId) el.appendChild(badge('D', 'd'));
  if (p.id === pos.sbId) el.appendChild(badge('SB', 'sb'));
  if (p.id === pos.bbId) el.appendChild(badge('BB', 'bb'));
}

function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

function renderActionBar(me, betting) {
  const myTurn = betting && me && state.actorId === me.id;
  $('action-bar').classList.toggle('hidden', !myTurn);
  $('wait-note').classList.toggle('hidden', myTurn || !betting);

  if (betting && !myTurn) {
    const actor = state.players.find((p) => p.id === state.actorId);
    const note = $('wait-note');
    note.textContent = actor ? `Waiting for ${actor.name}…` : 'Waiting…';
    if (actor && state.actorDeadline) note.appendChild(countdownSpan());
  }
  if (!myTurn) {
    raiseOpen = false;
    return;
  }

  const timerNote = $('timer-note');
  timerNote.classList.toggle('hidden', !state.actorDeadline);
  if (state.actorDeadline) {
    timerNote.textContent = 'Your turn —';
    timerNote.appendChild(countdownSpan());
  }

  const toCall = state.currentBet - me.betThisRound;
  const callBtn = $('btn-check-call');
  if (toCall <= 0) {
    callBtn.textContent = 'Check';
  } else if (toCall >= me.chips) {
    callBtn.textContent = `All-in ${me.chips}`;
  } else {
    callBtn.textContent = `Call ${toCall}`;
  }

  // Can't raise if calling already puts you all-in, or no one can respond.
  const canRaise = me.chips > toCall;
  $('btn-raise').disabled = !canRaise;

  $('raise-panel').classList.toggle('hidden', !raiseOpen);
  $('action-buttons').classList.toggle('hidden', raiseOpen);
  if (raiseOpen) {
    const slider = $('raise-slider');
    slider.min = minRaiseTo();
    slider.max = maxRaiseTo();
    slider.step = 1;
    if (!$('raise-amount').value || Number($('raise-amount').value) < slider.min) {
      setRaise(minRaiseTo());
    }
    $('raise-confirm').textContent =
      state.currentBet > 0 ? 'Raise' : 'Bet';
  }
}

function renderHostForce(betting) {
  const actor = state.players.find((p) => p.id === state.actorId);
  const showForce = betting && amHost() && actor && !actor.connected && actor.id !== myId();
  $('host-force').classList.toggle('hidden', !showForce);
  if (showForce) {
    $('host-force-note').textContent = `${actor.name} is disconnected and it's their turn.`;
    const toCall = state.currentBet - actor.betThisRound;
    $('host-force-check').classList.toggle('hidden', toCall > 0);
  }
}

function renderShowdown() {
  const panel = $('showdown-panel');
  if (state.stage !== 'showdown') {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const host = amHost();
  $('showdown-hint').textContent = host
    ? 'Compare hands at the table, then tap the winner(s) of each pot. Tap two players to split.'
    : 'Waiting for the host to award the pot…';

  const area = $('pot-award-area');
  area.innerHTML = '';
  state.pots.forEach((pot, i) => {
    const box = document.createElement('div');
    box.className = 'pot-box';
    const title = document.createElement('h3');
    const label = state.pots.length === 1 ? 'Pot' : i === 0 ? 'Main pot' : `Side pot ${i}`;
    title.innerHTML = `${label}: <span>${pot.amount}</span>`;
    box.appendChild(title);

    if (pot.awarded) {
      const done = document.createElement('p');
      done.className = 'pot-awarded';
      const names = pot.winners
        .map((id) => state.players.find((p) => p.id === id)?.name)
        .join(', ');
      done.textContent = `✓ Awarded to ${names}`;
      box.appendChild(done);
    } else if (host) {
      const opts = document.createElement('div');
      opts.className = 'winner-options';
      for (const id of pot.eligibleIds) {
        const p = state.players.find((x) => x.id === id);
        const lbl = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.value = id;
        lbl.append(cb, document.createTextNode(p ? p.name : '?'));
        opts.appendChild(lbl);
      }
      box.appendChild(opts);
      const award = document.createElement('button');
      award.className = 'btn primary';
      award.textContent = 'Award pot';
      award.addEventListener('click', () => {
        const winnerIds = [...opts.querySelectorAll('input:checked')].map((c) => c.value);
        if (!winnerIds.length) return toast('Pick at least one winner.');
        socket.emit('award_pot', { potIndex: i, winnerIds });
      });
      box.appendChild(award);
    } else {
      const wait = document.createElement('p');
      wait.className = 'hint';
      const names = pot.eligibleIds
        .map((id) => state.players.find((p) => p.id === id)?.name)
        .join(', ');
      wait.textContent = `Contenders: ${names}`;
      box.appendChild(wait);
    }
    area.appendChild(box);
  });
}

function renderHandOver() {
  const panel = $('handover-panel');
  if (state.stage !== 'hand_over') {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  const res = $('hand-result');
  res.innerHTML = '';
  for (const line of state.handResult || []) {
    const p = document.createElement('p');
    p.textContent = line;
    res.appendChild(p);
  }

  $('next-hand-btn').classList.toggle('hidden', !amHost());
  renderStraddle($('straddle-area'));

  const rebuyArea = $('rebuy-area');
  rebuyArea.innerHTML = '';
  if (amHost()) {
    for (const p of state.players.filter((x) => x.chips === 0)) {
      const row = document.createElement('div');
      row.className = 'rebuy-row';
      const name = document.createElement('span');
      name.textContent = `${p.name} is busted`;
      const btn = document.createElement('button');
      btn.className = 'btn small';
      btn.textContent = `Rebuy ${state.settings.startingStack}`;
      btn.addEventListener('click', () => socket.emit('rebuy', { targetId: p.id }));
      row.append(name, btn);
      rebuyArea.appendChild(row);
    }
  }
}

function renderLog() {
  const ul = $('game-log');
  ul.innerHTML = '';
  for (const entry of [...state.log].reverse()) {
    const li = document.createElement('li');
    li.textContent = entry.message;
    ul.appendChild(li);
  }
}

// ---------------------------------------------------------------- league screen

let leagueOpen = false;

async function openLeague(code) {
  code = String(code || '').trim().toUpperCase();
  if (!code) return toast('Enter a league code.');
  try {
    const res = await fetch(`/api/league/${encodeURIComponent(code)}`);
    if (!res.ok) throw new Error();
    renderLeague(await res.json());
    leagueOpen = true;
    show('league');
  } catch {
    toast('No league found with that code.');
  }
}

$('league-view-btn').addEventListener('click', () => openLeague($('league-input').value));
$('league-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('league-view-btn').click();
});
$('league-back-btn').addEventListener('click', () => {
  leagueOpen = false;
  if (state) render();
  else show('home');
});

function renderLeague(league) {
  $('league-title').textContent = `${league.name} (${league.code})`;
  const nights = league.nights.length;
  $('league-meta').textContent = `${nights} night${nights === 1 ? '' : 's'} recorded · share code ${league.code} to reuse it`;

  const board = $('league-board');
  board.innerHTML = '';
  if (!league.players.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'No nights saved yet. Attach this league to a game and hit “Save night”.';
    board.appendChild(p);
    return;
  }
  const table = document.createElement('table');
  table.className = 'league-table';
  const head = table.insertRow();
  for (const h of ['Player', 'Nights', 'Net', 'Wins']) {
    const th = document.createElement('th');
    th.textContent = h;
    head.appendChild(th);
  }
  for (const p of league.players) {
    const tr = table.insertRow();
    tr.insertCell().textContent = p.name;
    tr.insertCell().textContent = p.nights;
    const net = tr.insertCell();
    net.textContent = league.moneyOk
      ? `${p.netMinor >= 0 ? '+' : '-'}${league.currency}${Math.abs(p.netMinor / 100).toFixed(2)}`
      : `${p.netChips > 0 ? '+' : ''}${p.netChips}`;
    if (p.netChips > 0) net.className = 'net-pos';
    if (p.netChips < 0) net.className = 'net-neg';
    tr.insertCell().textContent = p.handsWon;
  }
  board.appendChild(table);

  const nightsEl = $('league-nights');
  nightsEl.innerHTML = '';
  const ul = document.createElement('ul');
  ul.className = 'log-list';
  for (const n of league.nights) {
    const li = document.createElement('li');
    const date = new Date(n.savedAt).toLocaleDateString();
    const top = [...n.results].sort((a, b) => b.net - a.net)[0];
    li.textContent = `${date} — ${n.results.length} players, biggest pot ${n.biggestPot}` +
      (top && top.net > 0 ? `, ${top.name} won ${top.net}` : '');
    ul.appendChild(li);
  }
  nightsEl.appendChild(ul);
}

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

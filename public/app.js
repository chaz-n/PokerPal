/* global io */
const socket = io();

const $ = (id) => document.getElementById(id);
const screens = {
  home: $('screen-home'),
  lobby: $('screen-lobby'),
  table: $('screen-table'),
};

let state = null; // last game state from server
let session = loadSession(); // {code, playerId, token}
let raiseOpen = false;

// ---------------------------------------------------------------- session

function loadSession() {
  try {
    return JSON.parse(localStorage.getItem('pokerpal-session')) || null;
  } catch {
    return null;
  }
}

function saveSession(s) {
  session = s;
  if (s) localStorage.setItem('pokerpal-session', JSON.stringify(s));
  else localStorage.removeItem('pokerpal-session');
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
  state = s;
  render();
});

socket.on('game_error', ({ message }) => toast(message));

// ---------------------------------------------------------------- home screen

const savedName = localStorage.getItem('pokerpal-name');
if (savedName) $('name-input').value = savedName;
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) $('code-input').value = urlCode.toUpperCase();

function myName() {
  const name = $('name-input').value.trim();
  localStorage.setItem('pokerpal-name', name);
  return name;
}

$('create-btn').addEventListener('click', () => {
  socket.emit('create', {
    name: myName(),
    settings: {
      startingStack: Number($('set-stack').value),
      smallBlind: Number($('set-sb').value),
      bigBlind: Number($('set-bb').value),
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
  if (confirm('Leave this game?')) socket.emit('leave');
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
  if (!state) return show('home');
  if (state.stage === 'lobby') return renderLobby();
  renderTable();
}

function renderLobby() {
  show('lobby');
  $('lobby-code').textContent = state.code;
  $('lobby-settings').textContent =
    `Stack ${state.settings.startingStack} · Blinds ${state.settings.smallBlind}/${state.settings.bigBlind}`;
  const ul = $('lobby-players');
  ul.innerHTML = '';
  for (const p of state.players) {
    const li = document.createElement('li');
    const left = document.createElement('span');
    left.textContent = p.name + (p.id === myId() ? ' (you)' : '');
    li.appendChild(left);
    if (p.isHost) {
      const tag = document.createElement('span');
      tag.className = 'host-tag';
      tag.textContent = 'HOST';
      li.appendChild(tag);
    }
    ul.appendChild(li);
  }
  const canStart = amHost() && state.players.length >= 2;
  $('lobby-start-btn').classList.toggle('hidden', !amHost());
  $('lobby-start-btn').disabled = !canStart;
  $('lobby-start-btn').textContent =
    state.players.length >= 2 ? 'Start first hand' : 'Waiting for players…';
  $('lobby-wait').classList.toggle('hidden', amHost());
}

function renderTable() {
  show('table');
  const me = getMe();
  const betting = ['preflop', 'flop', 'turn', 'river'].includes(state.stage);

  $('table-code').textContent = `GAME ${state.code}`;
  $('table-hand').textContent = `HAND #${state.handNumber}`;
  $('pot-amount').textContent = state.potTotal;

  // dealer prompt
  let prompt = '';
  if (betting) prompt = state.prompt;
  else if (state.stage === 'showdown') {
    prompt = state.ranOut
      ? 'All-in! Deal out the rest of the board, then compare hands.'
      : 'Showdown — reveal your hands!';
  } else if (state.stage === 'hand_over') prompt = 'Hand complete.';
  $('dealer-prompt').textContent = prompt;

  renderPlayers(betting);
  renderActionBar(me, betting);
  renderHostForce(betting);
  renderShowdown();
  renderHandOver();
  renderLog();
}

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
    if (p.id === state.dealerId) who.appendChild(badge('D', 'd'));
    if (p.id === state.sbId) who.appendChild(badge('SB', 'sb'));
    if (p.id === state.bbId) who.appendChild(badge('BB', 'bb'));

    const stack = document.createElement('div');
    stack.className = 'p-stack';
    stack.textContent = p.chips;

    const status = document.createElement('div');
    status.className = 'p-status';
    if (p.id === state.actorId) status.textContent = 'to act…';
    else if (betting && !p.inHand && p.lastAction) status.textContent = 'folded';
    else status.textContent = p.lastAction || (p.chips === 0 && !p.inHand ? 'busted' : '');

    const bet = document.createElement('div');
    bet.className = 'p-bet';
    bet.textContent = p.betThisRound > 0 ? `bet ${p.betThisRound}` : '';

    li.append(who, stack, status, bet);
    ul.appendChild(li);
  }
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
    $('wait-note').textContent = actor
      ? `Waiting for ${actor.name}…`
      : 'Waiting…';
  }
  if (!myTurn) {
    raiseOpen = false;
    return;
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

// ---------------------------------------------------------------- toast

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

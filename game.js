// CountChip game engine — chips/betting only, cards stay physical.
// Texas Hold'em betting structure: blinds, four streets, side pots.

const crypto = require('crypto');

const STAGES = ['preflop', 'flop', 'turn', 'river'];
const CURRENCIES = ['$', '£', '€'];

const STAGE_PROMPTS = {
  preflop: 'Deal 2 cards to each player.',
  flop: 'Deal the flop (3 community cards).',
  turn: 'Deal the turn (4th community card).',
  river: 'Deal the river (5th community card).',
};

function makeCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'; // no I/L/O to avoid confusion
  let code = '';
  for (let i = 0; i < 4; i++) code += letters[crypto.randomInt(letters.length)];
  return code;
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function createGame(hostName, settings = {}) {
  const game = {
    code: makeCode(),
    createdAt: Date.now(),
    lastActivity: Date.now(),
    settings: {
      startingStack: clampInt(settings.startingStack, 1, 1000000, 1000),
      smallBlind: clampInt(settings.smallBlind, 1, 100000, 5),
      bigBlind: clampInt(settings.bigBlind, 1, 200000, 10),
      turnTimer: clampInt(settings.turnTimer, 0, 300, 0), // seconds; 0 = off
      ante: clampInt(settings.ante, 0, 100000, 0),
      allowStraddle: !!settings.allowStraddle,
      currency: CURRENCIES.includes(settings.currency) ? settings.currency : '',
      chipValue: clampMoney(settings.chipValue), // money per chip; 0 = chips only
      mode: settings.mode === 'tournament' ? 'tournament' : 'cash',
      levelMinutes: clampInt(settings.levelMinutes, 1, 120, 15),
    },
    players: [],
    stage: 'lobby', // lobby | preflop | flop | turn | river | showdown | hand_over
    handNumber: 0,
    dealerId: null,
    nextDealerId: null, // host override: who gets the button next hand
    sbId: null,
    bbId: null,
    actorId: null,
    currentBet: 0,
    minRaise: 0,
    pots: null, // computed at showdown: [{amount, eligibleIds, awarded, winners}]
    handResult: null, // summary lines for the last completed hand
    ranOut: false, // betting finished early, board must be run out
    biggestPot: 0,
    // tournament clock (mode: 'tournament' only)
    level: 1,
    levelEndsAt: null, // ms timestamp; null until the first hand starts (or while paused)
    levelPausedMs: null, // remaining ms while on break
    log: [],
  };
  if (game.settings.bigBlind < game.settings.smallBlind) {
    game.settings.bigBlind = game.settings.smallBlind * 2;
  }
  if (game.settings.mode === 'tournament') {
    game.schedule = buildSchedule(game.settings.smallBlind, game.settings.bigBlind);
  }
  const host = addPlayer(game, hostName, true);
  return { game, player: host };
}

function addPlayer(game, name, isHost = false) {
  name = String(name || '').trim().slice(0, 20);
  if (!name) throw new GameError('Please enter a name.');
  if (game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
    throw new GameError('That name is already taken in this game.');
  }
  if (game.players.length >= 10) throw new GameError('Game is full (10 players max).');
  const player = {
    id: makeId(),
    token: makeId() + makeId(),
    name,
    isHost,
    chips: game.settings.startingStack,
    buyIn: game.settings.startingStack,
    handsWon: 0,
    connected: true,
    straddleNext: false,
    // per-hand state
    inHand: false,
    allIn: false,
    betThisRound: 0,
    totalCommitted: 0,
    acted: false,
    lastAction: null,
  };
  game.players.push(player);
  log(game, `${name} joined the game.`);
  touch(game);
  return player;
}

class GameError extends Error {}

function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

// Money per chip, kept to whole minor units (cents/pence) so settle-up math
// stays exact integers. 0 disables money display.
function clampMoney(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100000, Math.round(n * 100) / 100);
}

// Tournament blind schedule: escalate ~1.5× per level, rounded up to "nice"
// chip numbers. Level 1 is the host's chosen blinds.
function buildSchedule(smallBlind, bigBlind, count = 24) {
  const levels = [{ smallBlind, bigBlind }];
  let sb = smallBlind;
  while (levels.length < count) {
    sb = niceCeil(sb * 1.5);
    levels.push({ smallBlind: sb, bigBlind: sb * 2 });
  }
  return levels;
}

function niceCeil(n) {
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const m = n / mag;
  const nice = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find((x) => x >= m - 1e-9);
  return Math.round(nice * mag);
}

function touch(game) {
  game.lastActivity = Date.now();
}

function log(game, message) {
  game.log.push({ t: Date.now(), message });
  if (game.log.length > 80) game.log.splice(0, game.log.length - 80);
}

function getPlayer(game, playerId) {
  return game.players.find((p) => p.id === playerId) || null;
}

// The host runs the table; if they drop, the first connected player takes over.
function isActingHost(game, playerId) {
  const host = game.players.find((p) => p.isHost);
  if (host && host.connected) return host.id === playerId;
  const standIn = game.players.find((p) => p.connected);
  return standIn ? standIn.id === playerId : false;
}

function isBettingStage(game) {
  return STAGES.includes(game.stage);
}

function canAct(p) {
  return p.inHand && !p.allIn;
}

function nextByIndex(game, fromIndex, pred) {
  const n = game.players.length;
  for (let step = 1; step <= n; step++) {
    const p = game.players[(fromIndex + step) % n];
    if (pred(p)) return p;
  }
  return null;
}

function nextAfterId(game, id, pred) {
  const idx = game.players.findIndex((p) => p.id === id);
  return nextByIndex(game, idx === -1 ? 0 : idx, pred);
}

function pay(game, player, amount) {
  const paid = Math.min(amount, player.chips);
  player.chips -= paid;
  player.betThisRound += paid;
  player.totalCommitted += paid;
  if (player.chips === 0) player.allIn = true;
  return paid;
}

function potCollected(game) {
  // Chips committed in earlier rounds (bets on the table this round shown separately).
  return game.players.reduce((s, p) => s + p.totalCommitted - p.betThisRound, 0);
}

function potTotal(game) {
  return game.players.reduce((s, p) => s + p.totalCommitted, 0);
}

// ---------------------------------------------------------------- hands

// Who will be dealer / small blind / big blind when the next hand starts:
// the host's override if set, otherwise the button rotates one seat.
function nextPositions(game) {
  const isEligible = (p) => p.chips > 0;
  const eligible = game.players.filter(isEligible);
  if (eligible.length < 2) return null;

  let dealer = null;
  if (game.nextDealerId) {
    const pinned = getPlayer(game, game.nextDealerId);
    if (pinned && isEligible(pinned)) dealer = pinned;
  }
  if (!dealer) {
    dealer = game.dealerId ? nextAfterId(game, game.dealerId, isEligible) : eligible[0];
  }

  let sb, bb;
  if (eligible.length === 2) {
    sb = dealer; // heads-up: button posts the small blind
    bb = nextAfterId(game, dealer.id, isEligible);
  } else {
    sb = nextAfterId(game, dealer.id, isEligible);
    bb = nextAfterId(game, sb.id, isEligible);
  }
  // UTG can straddle (3+ players only — no straddling heads-up).
  const utg = eligible.length >= 3 ? nextAfterId(game, bb.id, isEligible) : null;
  return { dealerId: dealer.id, sbId: sb.id, bbId: bb.id, utgId: utg ? utg.id : null };
}

function startHand(game, playerId) {
  if (!isActingHost(game, playerId)) throw new GameError('Only the host can start a hand.');
  if (game.stage !== 'lobby' && game.stage !== 'hand_over') {
    throw new GameError('A hand is already in progress.');
  }
  const eligible = game.players.filter((p) => p.chips > 0);
  if (eligible.length < 2) {
    throw new GameError('Need at least 2 players with chips to start a hand.');
  }

  game.handNumber += 1;
  game.pots = null;
  game.handResult = null;
  game.ranOut = false;
  for (const p of game.players) {
    p.inHand = p.chips > 0;
    p.allIn = false;
    p.betThisRound = 0;
    p.totalCommitted = 0;
    p.acted = false;
    p.lastAction = null;
  }

  const pos = nextPositions(game);
  game.dealerId = pos.dealerId;
  game.nextDealerId = null;
  const dealer = getPlayer(game, pos.dealerId);
  const sb = getPlayer(game, pos.sbId);
  const bb = getPlayer(game, pos.bbId);
  game.sbId = sb.id;
  game.bbId = bb.id;

  // Antes go straight to the pot — they don't count toward calling a bet,
  // so the per-round tally is cleared after posting.
  const ante = game.settings.ante;
  if (ante > 0) {
    for (const p of game.players) if (p.inHand) pay(game, p, ante);
    for (const p of game.players) p.betThisRound = 0;
  }

  pay(game, sb, game.settings.smallBlind);
  pay(game, bb, game.settings.bigBlind);
  sb.lastAction = `SB ${sb.betThisRound}`;
  bb.lastAction = `BB ${bb.betThisRound}`;

  game.stage = 'preflop';
  game.currentBet = game.settings.bigBlind;
  game.minRaise = game.settings.bigBlind;

  log(
    game,
    `Hand #${game.handNumber} — ${dealer.name} has the button. ` +
      `${sb.name} posts SB ${game.settings.smallBlind}, ${bb.name} posts BB ${game.settings.bigBlind}.` +
      (ante > 0 ? ` Everyone antes ${ante}.` : '')
  );

  // Straddle: the UTG player may post a live 2×BB blind; action then starts
  // on their left and they get the option, like a third blind.
  let straddler = null;
  const utg = pos.utgId ? getPlayer(game, pos.utgId) : null;
  if (game.settings.allowStraddle && utg && utg.straddleNext && canAct(utg)) {
    const target = game.settings.bigBlind * 2;
    pay(game, utg, target);
    utg.lastAction = utg.allIn ? `All-in ${utg.betThisRound}` : `Straddle ${utg.betThisRound}`;
    game.currentBet = Math.max(game.currentBet, utg.betThisRound);
    // A full straddle doubles the price of a min-raise (to 2× the straddle).
    if (utg.betThisRound === target) game.minRaise = target;
    straddler = utg;
    log(game, `${utg.name} straddles ${utg.betThisRound}.`);
  }
  for (const p of game.players) p.straddleNext = false;

  const first = nextAfterId(game, (straddler || bb).id, canAct);
  game.actorId = first ? first.id : null;

  // Tournament: the level clock starts with the first hand.
  if (game.settings.mode === 'tournament' && !game.levelEndsAt && game.levelPausedMs == null) {
    game.levelEndsAt = Date.now() + game.settings.levelMinutes * 60 * 1000;
    log(game, `Level ${game.level} — ${game.settings.levelMinutes} minutes per level.`);
  }
  touch(game);

  if (!game.actorId || !someoneCanRespond(game)) {
    // Blinds put everyone all-in already.
    finishBettingRound(game);
  }
  return game;
}

// True if at least one player can still make a decision this round.
function someoneCanRespond(game) {
  return game.players.some((p) => canAct(p) && !p.acted);
}

// ---------------------------------------------------------------- actions

// via: 'self' (the player), 'host' (acting for a disconnected player), 'timeout' (turn timer)
function applyAction(game, playerId, action, via = 'self') {
  if (!isBettingStage(game)) throw new GameError('No betting round is active.');
  const player = getPlayer(game, playerId);
  if (!player) throw new GameError('Player not found.');
  if (game.actorId !== player.id) throw new GameError("It's not your turn.");
  if (via === 'host' && player.connected) throw new GameError('Player is connected — they act for themselves.');

  const type = action && action.type;
  const toCall = game.currentBet - player.betThisRound;
  const suffix = via === 'host' ? ' (by host — disconnected)' : via === 'timeout' ? ' (time ran out)' : '';

  if (type === 'fold') {
    player.inHand = false;
    player.acted = true;
    player.lastAction = 'Fold';
    log(game, `${player.name} folds${suffix}.`);
  } else if (type === 'check') {
    if (toCall > 0) throw new GameError(`You must call ${toCall} (or fold/raise).`);
    player.acted = true;
    player.lastAction = 'Check';
    log(game, `${player.name} checks${suffix}.`);
  } else if (type === 'call') {
    if (toCall <= 0) throw new GameError('Nothing to call — you can check.');
    const paid = pay(game, player, toCall);
    player.acted = true;
    player.lastAction = player.allIn ? `All-in ${player.betThisRound}` : `Call ${paid}`;
    log(game, `${player.name} calls ${paid}${player.allIn ? ' and is all-in' : ''}.`);
  } else if (type === 'raise') {
    if (via !== 'self') throw new GameError('Host can only fold or check for a disconnected player.');
    const raiseTo = clampInt(action.amount, 1, 100000000, 0);
    const maxTo = player.betThisRound + player.chips;
    const minTo = Math.min(game.currentBet + game.minRaise, maxTo);
    if (raiseTo <= game.currentBet) throw new GameError('Raise must be higher than the current bet.');
    if (raiseTo > maxTo) throw new GameError("You don't have enough chips for that raise.");
    if (raiseTo < minTo) throw new GameError(`Minimum raise is to ${minTo}.`);

    const isFullRaise = raiseTo - game.currentBet >= game.minRaise;
    if (isFullRaise) game.minRaise = raiseTo - game.currentBet;
    game.currentBet = raiseTo;
    pay(game, player, raiseTo - player.betThisRound);
    player.acted = true;
    const verb = game.players.some((p) => p !== player && p.betThisRound > 0 && p.inHand) || game.stage === 'preflop' ? 'raises to' : 'bets';
    player.lastAction = player.allIn ? `All-in ${player.betThisRound}` : `${verb === 'bets' ? 'Bet' : 'Raise'} ${raiseTo}`;
    log(game, `${player.name} ${verb} ${raiseTo}${player.allIn ? ' (all-in)' : ''}.`);
    // Everyone else who can still act must respond to the new price.
    for (const p of game.players) {
      if (p !== player && canAct(p) && p.betThisRound < game.currentBet) p.acted = false;
    }
  } else {
    throw new GameError('Unknown action.');
  }

  touch(game);
  resolveAfterAction(game);
  return game;
}

// Turn timer expired: check if possible, otherwise fold.
function timeoutAction(game) {
  if (!isBettingStage(game) || !game.actorId) return game;
  const player = getPlayer(game, game.actorId);
  const toCall = game.currentBet - player.betThisRound;
  return applyAction(game, player.id, { type: toCall > 0 ? 'fold' : 'check' }, 'timeout');
}

function resolveAfterAction(game) {
  const remaining = game.players.filter((p) => p.inHand);
  if (remaining.length === 1) {
    // Everyone else folded — no showdown needed.
    const winner = remaining[0];
    const amount = potTotal(game);
    game.biggestPot = Math.max(game.biggestPot, amount);
    winner.chips += amount;
    winner.handsWon += 1;
    game.handResult = [`${winner.name} wins ${amount} — everyone else folded.`];
    log(game, `${winner.name} wins ${amount} (everyone folded).`);
    endHand(game);
    return;
  }

  if (!someoneCanRespond(game)) {
    finishBettingRound(game);
    return;
  }

  const next = nextAfterId(game, game.actorId, (p) => canAct(p) && !p.acted);
  if (next) {
    game.actorId = next.id;
  } else {
    finishBettingRound(game);
  }
}

function finishBettingRound(game) {
  // Sweep bets into the pot.
  for (const p of game.players) p.betThisRound = 0;
  game.currentBet = 0;
  game.actorId = null;

  const canStillBet = game.players.filter(canAct);
  const stageIdx = STAGES.indexOf(game.stage);

  if (canStillBet.length <= 1 && stageIdx < STAGES.length - 1) {
    // No more betting possible — run out the board and go straight to showdown.
    game.ranOut = true;
    goToShowdown(game);
    return;
  }

  if (game.stage === 'river') {
    goToShowdown(game);
    return;
  }

  game.stage = STAGES[stageIdx + 1];
  game.minRaise = game.settings.bigBlind;
  for (const p of game.players) p.acted = false;
  const first = nextAfterId(game, game.dealerId, canAct);
  game.actorId = first ? first.id : null;
  log(game, `— ${game.stage.toUpperCase()} — ${STAGE_PROMPTS[game.stage]}`);
}

function goToShowdown(game) {
  game.stage = 'showdown';
  game.biggestPot = Math.max(game.biggestPot, potTotal(game));
  game.pots = computePots(game);
  if (game.ranOut) {
    log(game, 'No more betting possible. Deal out the rest of the board, then compare hands.');
  } else {
    log(game, 'Showdown! Players reveal their hands.');
  }

  // A pot only one player can win is an uncalled bet — return it automatically.
  for (const pot of game.pots) {
    if (pot.eligibleIds.length === 1) {
      const p = getPlayer(game, pot.eligibleIds[0]);
      p.chips += pot.amount;
      pot.awarded = true;
      pot.winners = [p.id];
      log(game, `Uncalled ${pot.amount} returned to ${p.name}.`);
    }
  }
  maybeFinishShowdown(game);
}

function computePots(game) {
  const inHand = game.players.filter((p) => p.inHand);
  const cutoffs = [...new Set(inHand.map((p) => p.totalCommitted))].sort((a, b) => a - b);
  const pots = [];
  let prev = 0;
  for (const c of cutoffs) {
    let amount = 0;
    for (const p of game.players) {
      amount += Math.max(0, Math.min(p.totalCommitted, c) - prev);
    }
    if (amount > 0) {
      pots.push({
        amount,
        eligibleIds: inHand.filter((p) => p.totalCommitted >= c).map((p) => p.id),
        awarded: false,
        winners: null,
      });
    }
    prev = c;
  }
  // Safety net: any stray chips (shouldn't happen) go to the last pot.
  const leftover = potTotal(game) - pots.reduce((s, p) => s + p.amount, 0);
  if (leftover > 0 && pots.length) pots[pots.length - 1].amount += leftover;
  return pots;
}

function awardPot(game, playerId, potIndex, winnerIds) {
  if (game.stage !== 'showdown') throw new GameError('There is no pot to award right now.');
  if (!isActingHost(game, playerId)) throw new GameError('Only the host can award pots.');
  const pot = game.pots && game.pots[potIndex];
  if (!pot) throw new GameError('Unknown pot.');
  if (pot.awarded) throw new GameError('That pot was already awarded.');
  if (!Array.isArray(winnerIds) || winnerIds.length === 0) {
    throw new GameError('Pick at least one winner.');
  }
  const winners = [];
  for (const id of new Set(winnerIds)) {
    if (!pot.eligibleIds.includes(id)) throw new GameError('That player is not eligible for this pot.');
    winners.push(getPlayer(game, id));
  }

  const share = Math.floor(pot.amount / winners.length);
  let remainder = pot.amount - share * winners.length;
  // Order winners by seat so odd chips go to the earliest position.
  winners.sort((a, b) => game.players.indexOf(a) - game.players.indexOf(b));
  for (const w of winners) {
    let got = share;
    if (remainder > 0) {
      got += 1;
      remainder -= 1;
    }
    w.chips += got;
    log(game, `${w.name} wins ${got} from ${potLabel(game, potIndex)}.`);
  }
  pot.awarded = true;
  pot.winners = winners.map((w) => w.id);
  touch(game);
  maybeFinishShowdown(game);
  return game;
}

function potLabel(game, index) {
  if (game.pots.length === 1) return 'the pot';
  return index === 0 ? 'the main pot' : `side pot ${index}`;
}

function maybeFinishShowdown(game) {
  if (game.stage !== 'showdown') return;
  if (game.pots.every((p) => p.awarded)) {
    // Count the hand as won for anyone who took a contested pot
    // (an auto-returned uncalled bet isn't a win).
    const winners = new Set();
    for (const pot of game.pots) {
      if (pot.eligibleIds.length > 1) pot.winners.forEach((id) => winners.add(id));
    }
    for (const id of winners) getPlayer(game, id).handsWon += 1;
    game.handResult = game.pots.map((pot, i) => {
      const names = pot.winners.map((id) => getPlayer(game, id).name).join(', ');
      return `${names} — ${pot.amount} (${potLabel(game, i)})`;
    });
    endHand(game);
  }
}

function endHand(game) {
  game.stage = 'hand_over';
  game.actorId = null;
  game.currentBet = 0;
  for (const p of game.players) {
    p.betThisRound = 0;
    p.totalCommitted = 0;
    if (p.chips === 0) log(game, `${p.name} is out of chips.`);
  }
  log(game, 'Hand complete. Host can start the next hand.');
}

// ---------------------------------------------------------------- straddle

// Any player can pre-commit to straddling; it only takes effect if they turn
// out to be UTG when the hand starts (and straddling is enabled).
function setStraddle(game, playerId, on) {
  if (!game.settings.allowStraddle) throw new GameError('Straddling is not enabled in this game.');
  if (game.stage !== 'lobby' && game.stage !== 'hand_over') {
    throw new GameError('You can only straddle between hands.');
  }
  const player = getPlayer(game, playerId);
  if (!player) throw new GameError('Player not found.');
  if (player.chips <= 0) throw new GameError('You have no chips to straddle with.');
  player.straddleNext = !!on;
  touch(game);
  return game;
}

// ---------------------------------------------------------------- tournament

function scheduleLevel(game, level) {
  return game.schedule[Math.min(level - 1, game.schedule.length - 1)];
}

// Called by the server when the level clock runs out.
function advanceLevel(game) {
  if (game.settings.mode !== 'tournament' || !game.levelEndsAt) return game;
  game.level += 1;
  const lv = scheduleLevel(game, game.level);
  game.settings.smallBlind = lv.smallBlind;
  game.settings.bigBlind = lv.bigBlind;
  game.levelEndsAt = Date.now() + game.settings.levelMinutes * 60 * 1000;
  const midHand = isBettingStage(game) || game.stage === 'showdown';
  log(
    game,
    `Level ${game.level} — blinds are now ${lv.smallBlind}/${lv.bigBlind}${midHand ? ' (from the next hand)' : ''}.`
  );
  touch(game);
  return game;
}

// Break time: pause freezes the remaining level time, resume restores it.
function setTournamentPaused(game, playerId, paused) {
  if (!isActingHost(game, playerId)) throw new GameError('Only the host can pause the clock.');
  if (game.settings.mode !== 'tournament') throw new GameError('This is not a tournament.');
  if (paused) {
    if (!game.levelEndsAt) return game; // not started or already paused
    game.levelPausedMs = Math.max(0, game.levelEndsAt - Date.now());
    game.levelEndsAt = null;
    log(game, 'Tournament clock paused — on break.');
  } else {
    if (game.levelPausedMs == null) return game;
    game.levelEndsAt = Date.now() + game.levelPausedMs;
    game.levelPausedMs = null;
    log(game, 'Break over — tournament clock running.');
  }
  touch(game);
  return game;
}

// Suggested payout split for the prize pool (host settles up physically).
function payouts(game) {
  const entries = Math.round(
    game.players.reduce((s, p) => s + p.buyIn, 0) / game.settings.startingStack
  );
  const pool = game.players.reduce((s, p) => s + p.buyIn, 0);
  const n = game.players.length;
  const split = n >= 8 ? [0.5, 0.3, 0.2] : n >= 5 ? [0.65, 0.35] : [1];
  let remaining = pool;
  const places = split.map((pct, i) => {
    const chips = i === split.length - 1 ? remaining : Math.round(pool * pct);
    remaining -= chips;
    return { place: i + 1, pct, chips };
  });
  return { entries, pool, places };
}

// ---------------------------------------------------------------- settle up

// Minimal payments so everyone's net win/loss is settled, largest debts
// matched to largest wins first (at most players-1 transfers).
function settleTransfers(game) {
  const nets = game.players.map((p) => ({
    id: p.id,
    net: p.chips + p.totalCommitted - p.buyIn,
  }));
  const creditors = nets.filter((n) => n.net > 0).sort((a, b) => b.net - a.net);
  const debtors = nets.filter((n) => n.net < 0).sort((a, b) => a.net - b.net);
  const transfers = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const amount = Math.min(-debtors[i].net, creditors[j].net);
    transfers.push({ fromId: debtors[i].id, toId: creditors[j].id, chips: amount });
    debtors[i].net += amount;
    creditors[j].net -= amount;
    if (debtors[i].net === 0) i++;
    if (creditors[j].net === 0) j++;
  }
  return transfers;
}

// ---------------------------------------------------------------- misc

function rebuy(game, playerId, targetId) {
  if (!isActingHost(game, playerId)) throw new GameError('Only the host can approve a rebuy.');
  if (game.stage !== 'lobby' && game.stage !== 'hand_over') {
    throw new GameError('Rebuys are only allowed between hands.');
  }
  const target = getPlayer(game, targetId);
  if (!target) throw new GameError('Player not found.');
  target.chips += game.settings.startingStack;
  target.buyIn += game.settings.startingStack;
  log(game, `${target.name} rebuys for ${game.settings.startingStack}.`);
  touch(game);
  return game;
}

// Host can retune blinds and the turn timer mid-game. Blinds are read when a
// hand starts, so mid-hand changes simply apply from the next hand.
function updateSettings(game, playerId, patch = {}) {
  if (!isActingHost(game, playerId)) throw new GameError('Only the host can change settings.');
  const s = game.settings;
  const smallBlind = clampInt(patch.smallBlind, 1, 100000, s.smallBlind);
  const bigBlind = clampInt(patch.bigBlind, 1, 200000, s.bigBlind);
  const turnTimer = clampInt(patch.turnTimer, 0, 300, s.turnTimer);
  const ante = clampInt(patch.ante, 0, 100000, s.ante);
  const allowStraddle = patch.allowStraddle === undefined ? s.allowStraddle : !!patch.allowStraddle;
  if (bigBlind < smallBlind) throw new GameError('Big blind must be at least the small blind.');

  const blindsChanged = smallBlind !== s.smallBlind || bigBlind !== s.bigBlind;
  const timerChanged = turnTimer !== s.turnTimer;
  const anteChanged = ante !== s.ante;
  const straddleChanged = allowStraddle !== s.allowStraddle;
  s.smallBlind = smallBlind;
  s.bigBlind = bigBlind;
  s.turnTimer = turnTimer;
  s.ante = ante;
  s.allowStraddle = allowStraddle;
  const midHand = game.stage !== 'lobby' && game.stage !== 'hand_over';
  if (blindsChanged) {
    log(game, `Blinds are now ${smallBlind}/${bigBlind}${midHand ? ' (from the next hand)' : ''}.`);
  }
  if (anteChanged) {
    log(game, ante ? `Ante set to ${ante}${midHand ? ' (from the next hand)' : ''}.` : 'Ante removed.');
  }
  if (straddleChanged) {
    log(game, allowStraddle ? 'Straddling is now allowed.' : 'Straddling turned off.');
  }
  if (timerChanged) {
    log(game, turnTimer ? `Turn timer set to ${turnTimer}s.` : 'Turn timer turned off.');
  }
  touch(game);
  return game;
}

// Host hands control of the game to another player.
function transferHost(game, hostId, targetId) {
  if (!isActingHost(game, hostId)) throw new GameError('Only the host can transfer hosting.');
  const target = getPlayer(game, targetId);
  if (!target) throw new GameError('Player not found.');
  if (target.isHost) return game;
  for (const p of game.players) p.isHost = false;
  target.isHost = true;
  log(game, `${target.name} is now the host.`);
  touch(game);
  return game;
}

// Host reorders seats (to match the physical table). Between hands only.
function movePlayer(game, hostId, targetId, direction) {
  if (!isActingHost(game, hostId)) throw new GameError('Only the host can change the seating.');
  if (isBettingStage(game) || game.stage === 'showdown') {
    throw new GameError('You can only change seats between hands.');
  }
  const from = game.players.findIndex((p) => p.id === targetId);
  if (from === -1) throw new GameError('Player not found.');
  const to = from + (direction < 0 ? -1 : 1);
  if (to < 0 || to >= game.players.length) return game; // already at the edge
  const [player] = game.players.splice(from, 1);
  game.players.splice(to, 0, player);
  touch(game);
  return game;
}

// Host hands the button to a specific player for the next hand.
function setNextDealer(game, hostId, targetId) {
  if (!isActingHost(game, hostId)) throw new GameError('Only the host can move the button.');
  if (isBettingStage(game) || game.stage === 'showdown') {
    throw new GameError('You can only move the button between hands.');
  }
  const target = getPlayer(game, targetId);
  if (!target) throw new GameError('Player not found.');
  if (target.chips <= 0) throw new GameError('That player has no chips.');
  game.nextDealerId = targetId;
  log(game, `${target.name} will have the button next hand.`);
  touch(game);
  return game;
}

function kickPlayer(game, hostId, targetId) {
  if (!isActingHost(game, hostId)) throw new GameError('Only the host can remove a player.');
  if (hostId === targetId) throw new GameError('Use "Leave game" to remove yourself.');
  if (isBettingStage(game) || game.stage === 'showdown') {
    throw new GameError('You can only remove players between hands.');
  }
  const target = getPlayer(game, targetId);
  if (!target) throw new GameError('Player not found.');
  game.players = game.players.filter((p) => p.id !== targetId);
  if (target.isHost && game.players.length) game.players[0].isHost = true;
  log(game, `${target.name} was removed by the host.`);
  touch(game);
  return game;
}

function leaveGame(game, playerId) {
  const player = getPlayer(game, playerId);
  if (!player) return game;
  if (isBettingStage(game) || game.stage === 'showdown') {
    throw new GameError('You can only leave between hands.');
  }
  game.players = game.players.filter((p) => p.id !== playerId);
  if (player.isHost && game.players.length) game.players[0].isHost = true;
  log(game, `${player.name} left the game.`);
  touch(game);
  return game;
}

function publicState(game) {
  return {
    code: game.code,
    stage: game.stage,
    handNumber: game.handNumber,
    settings: game.settings,
    dealerId: game.dealerId,
    sbId: game.sbId,
    bbId: game.bbId,
    actorId: game.actorId,
    actorDeadline: game.actorDeadline || null,
    currentBet: game.currentBet,
    minRaiseTo: game.currentBet + game.minRaise,
    potCollected: potCollected(game),
    potTotal: potTotal(game),
    ranOut: game.ranOut,
    next:
      game.stage === 'lobby' || game.stage === 'hand_over' ? nextPositions(game) : null,
    pots: game.pots,
    handResult: game.handResult,
    prompt: isBettingStage(game) ? STAGE_PROMPTS[game.stage] : null,
    biggestPot: game.biggestPot,
    // money display (0/empty = chips only)
    currency: game.settings.currency,
    valueMinor: Math.round(game.settings.chipValue * 100),
    settle: settleTransfers(game),
    // tournament clock
    level: game.settings.mode === 'tournament' ? game.level : null,
    levelEndsAt: game.levelEndsAt,
    levelPaused: game.levelPausedMs != null,
    nextLevel:
      game.settings.mode === 'tournament' ? scheduleLevel(game, game.level + 1) : null,
    payouts: game.settings.mode === 'tournament' ? payouts(game) : null,
    leagueCode: game.leagueCode || null,
    leagueName: game.leagueName || null,
    actingHostId:
      game.players.find((p) => p.isHost && p.connected)?.id ??
      game.players.find((p) => p.connected)?.id ??
      null,
    players: game.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.isHost,
      chips: p.chips,
      buyIn: p.buyIn,
      handsWon: p.handsWon,
      connected: p.connected,
      inHand: p.inHand,
      allIn: p.allIn,
      betThisRound: p.betThisRound,
      totalCommitted: p.totalCommitted,
      lastAction: p.lastAction,
      straddleNext: p.straddleNext,
    })),
    log: game.log.slice(-40),
  };
}

module.exports = {
  GameError,
  createGame,
  addPlayer,
  getPlayer,
  startHand,
  applyAction,
  timeoutAction,
  awardPot,
  rebuy,
  updateSettings,
  setStraddle,
  advanceLevel,
  setTournamentPaused,
  payouts,
  settleTransfers,
  buildSchedule,
  transferHost,
  movePlayer,
  setNextDealer,
  kickPlayer,
  leaveGame,
  publicState,
  isActingHost,
  isBettingStage,
  log,
};

// Engine tests: node test.js
const assert = require('assert');
const G = require('./game');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

function setup(names, settings = { startingStack: 1000, smallBlind: 5, bigBlind: 10 }) {
  const { game, player: host } = G.createGame(names[0], settings);
  const players = [host];
  for (const n of names.slice(1)) players.push(G.addPlayer(game, n));
  return { game, players };
}

function byName(game, name) {
  return game.players.find((p) => p.name === name);
}

function actor(game) {
  return G.getPlayer(game, game.actorId);
}

function chipsTotal(game) {
  return game.players.reduce((s, p) => s + p.chips + p.totalCommitted, 0);
}

// ------------------------------------------------------------------

test('blinds and preflop order (3 players)', () => {
  const { game } = setup(['A', 'B', 'C']);
  G.startHand(game, byName(game, 'A').id);
  // A is dealer, B SB, C BB, A acts first (UTG = dealer in 3-handed)
  assert.equal(game.dealerId, byName(game, 'A').id);
  assert.equal(byName(game, 'B').betThisRound, 5);
  assert.equal(byName(game, 'C').betThisRound, 10);
  assert.equal(actor(game).name, 'A');
  assert.equal(game.currentBet, 10);
});

test('fold-around awards pot without showdown', () => {
  const { game } = setup(['A', 'B', 'C']);
  G.startHand(game, byName(game, 'A').id);
  G.applyAction(game, byName(game, 'A').id, { type: 'fold' });
  G.applyAction(game, byName(game, 'B').id, { type: 'fold' });
  assert.equal(game.stage, 'hand_over');
  assert.equal(byName(game, 'C').chips, 1005); // wins the SB
  assert.equal(chipsTotal(game), 3000);
});

test('big blind gets the option preflop', () => {
  const { game } = setup(['A', 'B', 'C']);
  G.startHand(game, byName(game, 'A').id);
  G.applyAction(game, byName(game, 'A').id, { type: 'call' });
  G.applyAction(game, byName(game, 'B').id, { type: 'call' });
  // BB has matched but must still get the option to raise
  assert.equal(game.stage, 'preflop');
  assert.equal(actor(game).name, 'C');
  G.applyAction(game, byName(game, 'C').id, { type: 'check' });
  assert.equal(game.stage, 'flop');
  // Postflop, SB (first after dealer) acts first
  assert.equal(actor(game).name, 'B');
});

test('full hand to showdown with betting each street', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  G.applyAction(game, a.id, { type: 'raise', amount: 30 });
  G.applyAction(game, b.id, { type: 'call' });
  G.applyAction(game, c.id, { type: 'call' });
  assert.equal(game.stage, 'flop');
  assert.equal(game.potTotal, undefined); // internal fields only via publicState
  G.applyAction(game, b.id, { type: 'check' });
  G.applyAction(game, c.id, { type: 'raise', amount: 50 }); // opening bet
  G.applyAction(game, a.id, { type: 'call' });
  G.applyAction(game, b.id, { type: 'fold' });
  assert.equal(game.stage, 'turn');
  G.applyAction(game, c.id, { type: 'check' });
  G.applyAction(game, a.id, { type: 'check' });
  assert.equal(game.stage, 'river');
  G.applyAction(game, c.id, { type: 'check' });
  G.applyAction(game, a.id, { type: 'check' });
  assert.equal(game.stage, 'showdown');
  assert.equal(game.pots.length, 1);
  assert.equal(game.pots[0].amount, 30 * 3 + 50 * 2); // 190
  assert.deepEqual(game.pots[0].eligibleIds.sort(), [a.id, c.id].sort());
  G.awardPot(game, a.id, 0, [c.id]);
  assert.equal(game.stage, 'hand_over');
  assert.equal(c.chips, 1000 - 80 + 190);
  assert.equal(chipsTotal(game), 3000);
});

test('side pots with two all-ins', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  // Give uneven stacks: A 1000, B 300, C 600
  b.chips = 300;
  c.chips = 600;
  G.startHand(game, a.id); // A dealer, B SB 5, C BB 10
  G.applyAction(game, a.id, { type: 'raise', amount: 1000 }); // A all-in
  G.applyAction(game, b.id, { type: 'call' }); // B all-in for 300
  G.applyAction(game, c.id, { type: 'call' }); // C all-in for 600
  assert.equal(game.stage, 'showdown');
  assert.ok(game.ranOut);
  // Main pot: 300×3=900 (all), side 1: 300×2=600 (A,C), side 2: 400 uncalled → back to A
  assert.equal(game.pots.length, 3);
  assert.equal(game.pots[0].amount, 900);
  assert.equal(game.pots[0].eligibleIds.length, 3);
  assert.equal(game.pots[1].amount, 600);
  assert.deepEqual(game.pots[1].eligibleIds.sort(), [a.id, c.id].sort());
  assert.equal(game.pots[2].amount, 400);
  assert.ok(game.pots[2].awarded); // auto-returned to A
  assert.equal(a.chips, 400);
  // B wins main, C wins side 1
  G.awardPot(game, a.id, 0, [b.id]);
  G.awardPot(game, a.id, 1, [c.id]);
  assert.equal(game.stage, 'hand_over');
  assert.equal(b.chips, 900);
  assert.equal(c.chips, 600);
  assert.equal(chipsTotal(game), 1900);
});

test('split pot divides evenly with odd chip to earliest seat', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  G.applyAction(game, a.id, { type: 'raise', amount: 25 });
  G.applyAction(game, b.id, { type: 'call' });
  G.applyAction(game, c.id, { type: 'call' });
  // check it down
  for (let street = 0; street < 3; street++) {
    G.applyAction(game, b.id, { type: 'check' });
    G.applyAction(game, c.id, { type: 'check' });
    G.applyAction(game, a.id, { type: 'check' });
  }
  assert.equal(game.stage, 'showdown');
  assert.equal(game.pots[0].amount, 75);
  G.awardPot(game, a.id, 0, [b.id, c.id]);
  // 75 split: 38 + 37, odd chip to earlier seat (B)
  assert.equal(b.chips, 1000 - 25 + 38);
  assert.equal(c.chips, 1000 - 25 + 37);
  assert.equal(chipsTotal(game), 3000);
});

test('heads-up: dealer posts SB and acts first preflop', () => {
  const { game } = setup(['A', 'B']);
  const [a, b] = ['A', 'B'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  assert.equal(game.dealerId, a.id);
  assert.equal(game.sbId, a.id);
  assert.equal(game.bbId, b.id);
  assert.equal(actor(game).id, a.id);
  G.applyAction(game, a.id, { type: 'call' });
  G.applyAction(game, b.id, { type: 'check' });
  assert.equal(game.stage, 'flop');
  // Postflop the non-dealer acts first
  assert.equal(actor(game).id, b.id);
});

test('minimum raise enforcement and re-raise sizing', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b] = ['A', 'B'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  assert.throws(() => G.applyAction(game, a.id, { type: 'raise', amount: 15 }), /Minimum raise/);
  G.applyAction(game, a.id, { type: 'raise', amount: 30 }); // raise of 20
  assert.throws(() => G.applyAction(game, b.id, { type: 'raise', amount: 40 }), /Minimum raise/);
  G.applyAction(game, b.id, { type: 'raise', amount: 50 }); // min re-raise (another 20)
  assert.equal(game.currentBet, 50);
});

test('short all-in below min raise is allowed', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  b.chips = 42;
  G.startHand(game, a.id);
  G.applyAction(game, a.id, { type: 'raise', amount: 30 });
  G.applyAction(game, b.id, { type: 'raise', amount: 42 }); // all-in, under min raise-to of 50
  assert.equal(game.currentBet, 42);
  assert.ok(b.allIn);
  G.applyAction(game, c.id, { type: 'fold' });
  G.applyAction(game, a.id, { type: 'call' });
  assert.equal(game.stage, 'showdown');
});

test('busted player is not dealt in; rebuy restores them', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  b.chips = 0;
  G.startHand(game, a.id);
  assert.ok(!b.inHand);
  assert.ok(a.inHand && c.inHand);
  // finish the hand quickly: A dealer; heads-up-style order among inHand players
  const first = actor(game);
  G.applyAction(game, first.id, { type: 'fold' });
  assert.equal(game.stage, 'hand_over');
  G.rebuy(game, a.id, b.id);
  assert.equal(b.chips, 1000);
});

test('host can kick between hands, not mid-hand, and not non-hosts', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  assert.throws(() => G.kickPlayer(game, b.id, c.id), /Only the host/);
  G.startHand(game, a.id);
  assert.throws(() => G.kickPlayer(game, a.id, c.id), /between hands/);
  G.applyAction(game, a.id, { type: 'fold' });
  G.applyAction(game, b.id, { type: 'fold' });
  assert.equal(game.stage, 'hand_over');
  G.kickPlayer(game, a.id, c.id);
  assert.equal(game.players.length, 2);
  assert.ok(!byName(game, 'C'));
});

test('timeout checks when free, folds when facing a bet', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  G.applyAction(game, a.id, { type: 'call' });
  G.applyAction(game, b.id, { type: 'call' });
  G.timeoutAction(game); // C (BB) can check
  assert.ok(c.inHand);
  assert.equal(game.stage, 'flop');
  G.applyAction(game, b.id, { type: 'raise', amount: 50 });
  G.timeoutAction(game); // C faces a bet — folds
  assert.ok(!c.inHand);
});

test('host can change blinds mid-game; applies next hand', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b] = ['A', 'B'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  assert.throws(() => G.updateSettings(game, b.id, { smallBlind: 10 }), /Only the host/);
  assert.throws(
    () => G.updateSettings(game, a.id, { smallBlind: 50, bigBlind: 20 }),
    /at least the small blind/
  );
  G.updateSettings(game, a.id, { smallBlind: 10, bigBlind: 20, turnTimer: 30 });
  assert.equal(game.currentBet, 10); // current hand unaffected
  assert.equal(game.settings.turnTimer, 30);
  // fold out and start the next hand with new blinds
  G.applyAction(game, a.id, { type: 'fold' });
  G.applyAction(game, b.id, { type: 'fold' });
  G.startHand(game, a.id);
  assert.equal(game.currentBet, 20);
});

test('scoreboard stats: buy-ins and hands won', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  G.applyAction(game, a.id, { type: 'fold' });
  G.applyAction(game, b.id, { type: 'fold' });
  assert.equal(c.handsWon, 1);
  assert.equal(a.handsWon, 0);
  c.chips = 0;
  G.rebuy(game, a.id, c.id);
  assert.equal(c.buyIn, 2000);
  assert.equal(a.buyIn, 1000);
});

test('host can reorder seats between hands', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  assert.throws(() => G.movePlayer(game, b.id, c.id, -1), /Only the host/);
  G.movePlayer(game, a.id, c.id, -1); // C up: A, C, B
  assert.deepEqual(game.players.map((p) => p.name), ['A', 'C', 'B']);
  G.movePlayer(game, a.id, a.id, -1); // A already at top: no-op
  assert.deepEqual(game.players.map((p) => p.name), ['A', 'C', 'B']);
  G.startHand(game, a.id);
  assert.throws(() => G.movePlayer(game, a.id, c.id, 1), /between hands/);
  // new order drives the blinds: A dealer, C SB, B BB
  assert.equal(game.sbId, c.id);
  assert.equal(game.bbId, b.id);
});

test('host can assign the button; rotation continues from there', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  G.setNextDealer(game, a.id, c.id);
  G.startHand(game, a.id);
  assert.equal(game.dealerId, c.id);
  assert.equal(game.sbId, a.id); // seat after C wraps to A
  assert.equal(game.bbId, b.id);
  // override is one-shot: next hand rotates normally from C
  const first = actor(game);
  G.applyAction(game, first.id, { type: 'fold' });
  G.applyAction(game, actor(game).id, { type: 'fold' });
  assert.equal(game.stage, 'hand_over');
  G.startHand(game, a.id);
  assert.equal(game.dealerId, a.id);
});

test('host transfer, and default fallback when host leaves', () => {
  const { game } = setup(['A', 'B', 'C']);
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  assert.throws(() => G.transferHost(game, b.id, c.id), /Only the host/);
  G.transferHost(game, a.id, c.id);
  assert.ok(c.isHost && !a.isHost);
  assert.ok(G.isActingHost(game, c.id));
  assert.ok(!G.isActingHost(game, a.id));
  // C (now host) leaves without picking — hosting falls back to first seat
  G.leaveGame(game, c.id);
  assert.ok(byName(game, 'A').isHost);
});

test('turn order rejects out-of-turn actions', () => {
  const { game } = setup(['A', 'B', 'C']);
  G.startHand(game, byName(game, 'A').id);
  assert.throws(
    () => G.applyAction(game, byName(game, 'B').id, { type: 'fold' }),
    /not your turn/
  );
});

test('chip conservation across many random hands', () => {
  const { game } = setup(['A', 'B', 'C', 'D']);
  const host = byName(game, 'A');
  let rngState = 42;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  for (let hand = 0; hand < 200; hand++) {
    if (game.players.filter((p) => p.chips > 0).length < 2) {
      // rebuy everyone to keep the sim going
      for (const p of game.players) if (p.chips === 0) G.rebuy(game, host.id, p.id);
    }
    G.startHand(game, host.id);
    let guard = 0;
    while (G.isBettingStage(game) && guard++ < 200) {
      const p = G.getPlayer(game, game.actorId);
      const toCall = game.currentBet - p.betThisRound;
      const r = rng();
      try {
        if (r < 0.2 && toCall > 0) G.applyAction(game, p.id, { type: 'fold' });
        else if (r < 0.75) G.applyAction(game, p.id, { type: toCall > 0 ? 'call' : 'check' });
        else {
          const maxTo = p.betThisRound + p.chips;
          const minTo = Math.min(game.currentBet + game.minRaise, maxTo);
          const to = minTo + Math.floor(rng() * (maxTo - minTo + 1));
          G.applyAction(game, p.id, { type: 'raise', amount: to });
        }
      } catch (e) {
        // e.g. raise attempt when call is all-in — just call instead
        G.applyAction(game, p.id, { type: toCall > 0 ? 'call' : 'check' });
      }
    }
    if (game.stage === 'showdown') {
      for (let i = 0; i < game.pots.length; i++) {
        const pot = game.pots[i];
        if (pot.awarded) continue;
        const winner = pot.eligibleIds[Math.floor(rng() * pot.eligibleIds.length)];
        G.awardPot(game, host.id, i, [winner]);
      }
    }
    assert.equal(game.stage, 'hand_over', `hand ${hand} did not finish (stage=${game.stage})`);
    const total = game.players.reduce((s, p) => s + p.chips, 0);
    assert.ok(total > 0 && total % 1000 === 0, `chips leaked on hand ${hand}: total=${total}`);
  }
});

// ------------------------------------------------------------------ antes

test('antes go to the pot and do not count toward calling', () => {
  const { game } = setup(['A', 'B', 'C'], { startingStack: 1000, smallBlind: 5, bigBlind: 10, ante: 2 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  G.startHand(game, a.id);
  // 3 antes + SB + BB in the pot; betThisRound only reflects blinds
  assert.equal(a.totalCommitted, 2);
  assert.equal(a.betThisRound, 0);
  assert.equal(b.betThisRound, 5);
  assert.equal(c.betThisRound, 10);
  assert.equal(game.currentBet, 10);
  // A (UTG) must call the full BB, not BB minus ante
  G.applyAction(game, a.id, { type: 'call' });
  assert.equal(a.totalCommitted, 12);
  G.applyAction(game, b.id, { type: 'fold' });
  G.applyAction(game, c.id, { type: 'check' });
  assert.equal(game.stage, 'flop');
  assert.equal(chipsTotal(game), 3000);
});

test('ante can put a short stack all-in', () => {
  const { game } = setup(['A', 'B', 'C'], { startingStack: 1000, smallBlind: 5, bigBlind: 10, ante: 5 });
  const [a, b, c] = ['A', 'B', 'C'].map((n) => byName(game, n));
  a.chips = 3; // can't cover the ante
  G.startHand(game, a.id);
  assert.ok(a.allIn);
  assert.equal(a.totalCommitted, 3);
  assert.ok(a.inHand);
});

// ------------------------------------------------------------------ straddle

function straddleSetup() {
  const { game } = setup(['A', 'B', 'C', 'D'], {
    startingStack: 1000, smallBlind: 5, bigBlind: 10, allowStraddle: true,
  });
  return { game, ...Object.fromEntries(['a', 'b', 'c', 'd'].map((k, i) => [k, game.players[i]])) };
}

test('straddle posts 2xBB, action starts after straddler, straddler has option', () => {
  const { game, a, b, c, d } = straddleSetup();
  // A dealer, B SB, C BB, D UTG
  G.setStraddle(game, d.id, true);
  G.startHand(game, a.id);
  assert.equal(d.betThisRound, 20);
  assert.equal(game.currentBet, 20);
  assert.equal(actor(game).id, a.id); // action starts left of the straddler
  G.applyAction(game, a.id, { type: 'call' });
  G.applyAction(game, b.id, { type: 'call' });
  G.applyAction(game, c.id, { type: 'call' });
  // straddler still gets the option
  assert.equal(game.stage, 'preflop');
  assert.equal(actor(game).id, d.id);
  G.applyAction(game, d.id, { type: 'check' });
  assert.equal(game.stage, 'flop');
  assert.equal(chipsTotal(game), 4000);
});

test('min raise over a straddle is to 2x the straddle', () => {
  const { game, a, d } = straddleSetup();
  G.setStraddle(game, d.id, true);
  G.startHand(game, a.id);
  assert.throws(() => G.applyAction(game, a.id, { type: 'raise', amount: 30 }), /Minimum raise/);
  G.applyAction(game, a.id, { type: 'raise', amount: 40 });
  assert.equal(game.currentBet, 40);
});

test('straddle is one-shot and requires the setting', () => {
  const { game, a, b, c, d } = straddleSetup();
  G.setStraddle(game, d.id, true);
  G.startHand(game, a.id);
  for (const p of [a, b, c]) G.applyAction(game, p.id, { type: 'fold' });
  assert.equal(game.stage, 'hand_over');
  // next hand: nobody re-straddled, so no straddle
  G.startHand(game, a.id);
  assert.equal(game.currentBet, 10);
  assert.ok(game.players.every((p) => !p.straddleNext));

  const plain = setup(['X', 'Y', 'Z']).game;
  assert.throws(() => G.setStraddle(plain, plain.players[0].id, true), /not enabled/);
});

test('straddle only applies to the actual UTG player', () => {
  const { game, a, b, c, d } = straddleSetup();
  G.setStraddle(game, b.id, true); // B will be SB, not UTG
  G.startHand(game, a.id);
  assert.equal(b.betThisRound, 5); // just the SB — no straddle
  assert.equal(game.currentBet, 10);
});

// ------------------------------------------------------------------ settle up

test('settle-up produces minimal zero-sum transfers', () => {
  const { game } = setup(['A', 'B', 'C', 'D']);
  const [a, b, c, d] = ['A', 'B', 'C', 'D'].map((n) => byName(game, n));
  // fake final stacks: A +500, B -300, C -350, D +150
  a.chips = 1500; b.chips = 700; c.chips = 650; d.chips = 1150;
  const transfers = G.settleTransfers(game);
  assert.ok(transfers.length <= 3);
  const nets = new Map(game.players.map((p) => [p.id, 0]));
  for (const t of transfers) {
    assert.ok(t.chips > 0);
    nets.set(t.fromId, nets.get(t.fromId) - t.chips);
    nets.set(t.toId, nets.get(t.toId) + t.chips);
  }
  // applying the transfers settles everyone exactly
  assert.equal(nets.get(a.id), 500);
  assert.equal(nets.get(b.id), -300);
  assert.equal(nets.get(c.id), -350);
  assert.equal(nets.get(d.id), 150);
});

test('settle-up is empty when everyone is even', () => {
  const { game } = setup(['A', 'B']);
  assert.deepEqual(G.settleTransfers(game), []);
});

// ------------------------------------------------------------------ tournament

test('blind schedule escalates to nice numbers', () => {
  const levels = G.buildSchedule(5, 10, 8);
  assert.deepEqual(levels[0], { smallBlind: 5, bigBlind: 10 });
  for (let i = 1; i < levels.length; i++) {
    assert.ok(levels[i].smallBlind > levels[i - 1].smallBlind, `level ${i} must escalate`);
    assert.equal(levels[i].bigBlind, levels[i].smallBlind * 2);
  }
});

test('advancing a level raises the blinds for the next hand', () => {
  const { game } = setup(['A', 'B', 'C'], {
    startingStack: 1000, smallBlind: 5, bigBlind: 10, mode: 'tournament', levelMinutes: 15,
  });
  const [a, b] = ['A', 'B'].map((n) => byName(game, n));
  assert.equal(game.levelEndsAt, null); // clock hasn't started
  G.startHand(game, a.id);
  assert.ok(game.levelEndsAt > Date.now());
  G.advanceLevel(game);
  assert.equal(game.level, 2);
  assert.ok(game.settings.bigBlind > 10);
  assert.equal(game.currentBet, 10); // current hand unaffected
  G.applyAction(game, actor(game).id, { type: 'fold' });
  G.applyAction(game, actor(game).id, { type: 'fold' });
  G.startHand(game, a.id);
  assert.equal(game.currentBet, game.settings.bigBlind);
});

test('pause freezes the level clock; resume restores it', () => {
  const { game } = setup(['A', 'B'], {
    startingStack: 1000, smallBlind: 5, bigBlind: 10, mode: 'tournament', levelMinutes: 15,
  });
  const a = byName(game, 'A');
  G.startHand(game, a.id);
  G.setTournamentPaused(game, a.id, true);
  assert.equal(game.levelEndsAt, null);
  assert.ok(game.levelPausedMs > 0);
  G.advanceLevel(game); // no-op while paused
  assert.equal(game.level, 1);
  G.setTournamentPaused(game, a.id, false);
  assert.ok(game.levelEndsAt > Date.now());
});

test('payout suggestions split the pool by player count', () => {
  const { game } = setup(['A', 'B', 'C', 'D', 'E'], {
    startingStack: 1000, smallBlind: 5, bigBlind: 10, mode: 'tournament',
  });
  const p = G.payouts(game);
  assert.equal(p.entries, 5);
  assert.equal(p.pool, 5000);
  assert.equal(p.places.length, 2); // 5-7 players pay two places
  assert.equal(p.places.reduce((s, x) => s + x.chips, 0), 5000);
});

// ------------------------------------------------------------------ league store

test('league store: create, save nights, aggregate leaderboard', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pokerpal-test-'));
  const store = require('./store');

  const league = store.createLeague('Thursday Crew');
  assert.equal(league.code.length, 6);
  assert.throws(() => store.createLeague('  '), /name/);

  const night = (gameCode, aNet, bNet) => ({
    savedAt: Date.now(),
    gameCode,
    currency: '£',
    valueMinor: 5, // 1 chip = £0.05
    biggestPot: 400,
    results: [
      { name: 'Alice', buyIn: 1000, stack: 1000 + aNet, net: aNet, handsWon: 3 },
      { name: 'bob', buyIn: 1000, stack: 1000 + bNet, net: bNet, handsWon: 1 },
    ],
  });
  store.saveNight(league.code, night('AAAA', 200, -200));
  store.saveNight(league.code, night('BBBB', -100, 100));
  // re-saving the same game replaces the night instead of duplicating it
  store.saveNight(league.code, night('BBBB', -150, 150));

  const sum = store.summary(league.code);
  assert.equal(sum.nights.length, 2);
  assert.ok(sum.moneyOk);
  assert.equal(sum.currency, '£');
  const alice = sum.players.find((p) => p.name === 'Alice');
  assert.equal(alice.nights, 2);
  assert.equal(alice.netChips, 50);
  assert.equal(alice.netMinor, 250); // £2.50
  assert.equal(alice.handsWon, 6);
  assert.equal(store.summary('NOPE'), null);
});

// ------------------------------------------------------------------ sim with antes + straddles

test('chip conservation with antes and straddles', () => {
  const { game } = setup(['A', 'B', 'C', 'D'], {
    startingStack: 1000, smallBlind: 5, bigBlind: 10, ante: 3, allowStraddle: true,
  });
  const host = byName(game, 'A');
  let rngState = 7;
  const rng = () => {
    rngState = (rngState * 1103515245 + 12345) % 2147483648;
    return rngState / 2147483648;
  };
  for (let hand = 0; hand < 150; hand++) {
    for (const p of game.players) if (p.chips === 0) G.rebuy(game, host.id, p.id);
    if (rng() < 0.4) {
      const nxt = game.stage === 'lobby' || game.stage === 'hand_over' ? game : null;
      const candidates = game.players.filter((p) => p.chips > 0);
      const pick = candidates[Math.floor(rng() * candidates.length)];
      if (pick) G.setStraddle(game, pick.id, true);
    }
    G.startHand(game, host.id);
    let guard = 0;
    while (G.isBettingStage(game) && guard++ < 200) {
      const p = G.getPlayer(game, game.actorId);
      const toCall = game.currentBet - p.betThisRound;
      const r = rng();
      try {
        if (r < 0.2 && toCall > 0) G.applyAction(game, p.id, { type: 'fold' });
        else if (r < 0.75) G.applyAction(game, p.id, { type: toCall > 0 ? 'call' : 'check' });
        else {
          const maxTo = p.betThisRound + p.chips;
          const minTo = Math.min(game.currentBet + game.minRaise, maxTo);
          const to = minTo + Math.floor(rng() * (maxTo - minTo + 1));
          G.applyAction(game, p.id, { type: 'raise', amount: to });
        }
      } catch (e) {
        G.applyAction(game, p.id, { type: toCall > 0 ? 'call' : 'check' });
      }
    }
    if (game.stage === 'showdown') {
      for (let i = 0; i < game.pots.length; i++) {
        const pot = game.pots[i];
        if (pot.awarded) continue;
        const winner = pot.eligibleIds[Math.floor(rng() * pot.eligibleIds.length)];
        G.awardPot(game, host.id, i, [winner]);
      }
    }
    assert.equal(game.stage, 'hand_over', `hand ${hand} did not finish (stage=${game.stage})`);
    const total = game.players.reduce((s, p) => s + p.chips, 0);
    assert.ok(total % 1000 === 0, `chips leaked on hand ${hand}: total=${total}`);
    // settle transfers always zero-sum, even mid-session
    const t = G.settleTransfers(game);
    const out = t.reduce((s, x) => s + x.chips, 0);
    const inn = t.reduce((s, x) => s + x.chips, 0);
    assert.equal(out, inn);
  }
});

console.log(`\n${passed} tests passed`);

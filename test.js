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

console.log(`\n${passed} tests passed`);

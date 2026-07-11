# PokerPal

Virtual chips for real cards. You've got a deck but no chips — PokerPal runs the
pot on everyone's phones while the cards stay physical.

## How it works

1. One player hosts a game (sets starting stack and blinds) and shares the
   4-letter code.
2. Everyone else joins from their phone browser.
3. The host starts each hand. The app rotates the button, posts blinds, and
   tells the table when to deal (hole cards, flop, turn, river).
4. Players fold / check / call / bet / raise from their phones. The app enforces
   turn order, minimum raises, and builds side pots for all-ins.
5. At showdown, players compare their real cards and the host taps the
   winner(s) of each pot. Ties split automatically. If everyone folds, the pot
   is awarded automatically.

Extras: reconnect support (rejoin automatically after a dropped connection),
host rebuys for busted players, host can fold/check for a disconnected player,
and a full action log.

## Running

```sh
npm install
npm start        # http://localhost:3000  (PORT env var to change)
```

Everyone at the table needs to reach the server, so run it somewhere your
friends' phones can reach — either a machine on the same Wi-Fi (share your
LAN IP, e.g. `http://192.168.1.20:3000`) or any Node host on the internet.

## Tests

```sh
npm test
```

Covers blind posting, turn order, min-raise rules, side pots, split pots,
heads-up play, and a 200-hand randomized simulation asserting chips are never
created or destroyed.

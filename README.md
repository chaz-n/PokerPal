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
host rebuys for busted players, host can fold/check for a disconnected player
or remove someone between hands, and a full action log.

- **Turn timer (optional):** off by default; auto-checks or folds when time
  runs out. The host can change or disable it mid-game (e.g. for a break).
- **Live settings:** the host can change the blinds at any time — they apply
  from the next hand.
- **Scoreboard:** buy-ins, current stacks, net win/loss, and hands won.
- **Light/dark theme:** follows the device by default (nice for playing
  outside), with a manual override toggle.

## Running

```sh
npm install
npm start        # http://localhost:3000  (PORT env var to change)
```

Everyone at the table needs to reach the server, so run it somewhere your
friends' phones can reach — either a machine on the same Wi-Fi (share your
LAN IP, e.g. `http://192.168.1.20:3000`) or any Node host on the internet.

## Deploying publicly

State lives in a single Node process's memory, so run **exactly one instance**
(no load balancing) — which is also the cheapest setup. Two good options:

- **PaaS (easiest):** Fly.io, Railway, or Render. Connect the repo, they build
  and run `npm start`, and you get HTTPS automatically. Note that a redeploy
  or instance restart wipes in-progress games.
- **VPS (~$5/mo):** any small box (Hetzner, DigitalOcean, etc.). Run the app
  under systemd or pm2 and put [Caddy](https://caddyserver.com) in front for
  automatic HTTPS — it proxies WebSockets out of the box:

  ```
  poker.example.com {
      reverse_proxy localhost:3000
  }
  ```

HTTPS matters beyond hygiene: the wake-lock and vibration features only work
on secure origins. When running behind a reverse proxy, set `TRUST_PROXY=1` so
rate limiting sees real client IPs instead of the proxy's.

### Security model

Game codes are 4 letters (~280k combinations) and joining is rate-limited to
15 attempts per minute per IP, so scanning for games isn't practical. Rejoins
require a 32-byte secret token, every action is validated server-side (turn
order, bet sizing, host-only operations), and the host can remove anyone from
the game between hands. There are no accounts, no real money, and no secrets
in the game state — worst case for a leaked code is a nuisance guest, who can
be kicked.

## Tests

```sh
npm test
```

Covers blind posting, turn order, min-raise rules, side pots, split pots,
heads-up play, and a 200-hand randomized simulation asserting chips are never
created or destroyed.

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const G = require('./game');
const store = require('./store');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// League leaderboard (read-only, no secrets — codes are shared within a group).
app.get('/api/league/:code', (req, res) => {
  const league = store.summary(req.params.code);
  if (!league) return res.status(404).json({ error: 'League not found.' });
  res.json(league);
});

const games = new Map(); // code -> game
const MAX_GAMES = 500;

// Drop games idle for 12 hours.
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.lastActivity < cutoff) removeGame(code);
  }
}, 60 * 60 * 1000).unref();

function removeGame(code) {
  const timer = timers.get(code);
  if (timer) clearTimeout(timer.handle);
  timers.delete(code);
  const level = levelTimers.get(code);
  if (level) clearTimeout(level.handle);
  levelTimers.delete(code);
  games.delete(code);
}

// --- tournament level clock (server-side, like the turn timer) ---
const levelTimers = new Map(); // code -> {key, handle}

function armLevelTimer(game) {
  const key = `${game.level}:${game.levelEndsAt}`;
  const current = levelTimers.get(game.code);
  if (current && current.key === key) return;
  if (current) clearTimeout(current.handle);
  levelTimers.delete(game.code);

  if (!game.levelEndsAt) return; // cash game, paused, or not started
  const handle = setTimeout(() => {
    levelTimers.delete(game.code);
    try {
      G.advanceLevel(game);
    } catch (err) {
      console.error(err);
    }
    broadcast(game);
  }, Math.max(0, game.levelEndsAt - Date.now()) + 250);
  levelTimers.set(game.code, { key, handle });
}

// --- turn timer (runs server-side so it fires even if every phone is locked) ---
const timers = new Map(); // code -> {key, handle}

function armTimer(game) {
  // Re-arm only when the situation changed; unrelated broadcasts
  // (someone joining, a disconnect) must not reset the countdown.
  const key = `${game.handNumber}:${game.stage}:${game.actorId}:${game.settings.turnTimer}`;
  const current = timers.get(game.code);
  if (current && current.key === key) return;
  if (current) clearTimeout(current.handle);
  timers.delete(game.code);
  game.actorDeadline = null;

  if (!game.settings.turnTimer || !G.isBettingStage(game) || !game.actorId) return;
  const ms = game.settings.turnTimer * 1000;
  game.actorDeadline = Date.now() + ms;
  const handle = setTimeout(() => {
    timers.delete(game.code);
    try {
      G.timeoutAction(game);
    } catch (err) {
      console.error(err);
    }
    broadcast(game);
  }, ms + 500); // slight grace so the on-screen countdown hits 0 first
  timers.set(game.code, { key, handle });
}

// --- per-IP rate limiting for lobby actions (makes code brute-forcing impractical) ---
const buckets = new Map(); // "ip:action" -> {count, resetAt}
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (now > b.resetAt) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

function clientIp(socket) {
  if (process.env.TRUST_PROXY) {
    const fwd = socket.handshake.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return socket.handshake.address;
}

function rateLimit(socket, action, max, windowMs) {
  const key = `${clientIp(socket)}:${action}`;
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  if (b.count > max) {
    throw new G.GameError("You're doing that too often — wait a minute and try again.");
  }
}

function room(code) {
  return `game:${code}`;
}

function broadcast(game) {
  armTimer(game);
  armLevelTimer(game);
  io.to(room(game.code)).emit('state', G.publicState(game));
}

function bind(socket, game, player) {
  socket.data.code = game.code;
  socket.data.playerId = player.id;
  socket.join(room(game.code));
}

// Wraps a handler so GameErrors surface to the client as friendly messages.
function safe(socket, fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      if (err instanceof G.GameError || err instanceof store.StoreError) {
        socket.emit('game_error', { message: err.message });
      } else {
        console.error(err);
        socket.emit('game_error', { message: 'Something went wrong on the server.' });
      }
    }
  };
}

function currentGame(socket) {
  const game = games.get(socket.data.code);
  const player = game && G.getPlayer(game, socket.data.playerId);
  if (!game || !player) throw new G.GameError('You are not in a game. Refresh and rejoin.');
  return { game, player };
}

io.on('connection', (socket) => {
  socket.on(
    'create',
    safe(socket, ({ name, settings, leagueCode } = {}) => {
      rateLimit(socket, 'create', 6, 10 * 60 * 1000);
      if (games.size >= MAX_GAMES) throw new G.GameError('Server is full right now — try again later.');
      const { game, player } = G.createGame(name, settings || {});
      if (leagueCode) {
        const league = store.getLeague(leagueCode);
        if (!league) throw new G.GameError('No league found with that code.');
        game.leagueCode = league.code;
        game.leagueName = league.name;
      }
      games.set(game.code, game);
      bind(socket, game, player);
      socket.emit('joined', { code: game.code, playerId: player.id, token: player.token });
      broadcast(game);
    })
  );

  socket.on(
    'join',
    safe(socket, ({ code, name } = {}) => {
      rateLimit(socket, 'join', 15, 60 * 1000);
      const game = games.get(String(code || '').trim().toUpperCase());
      if (!game) throw new G.GameError('No game found with that code.');
      const player = G.addPlayer(game, name);
      bind(socket, game, player);
      socket.emit('joined', { code: game.code, playerId: player.id, token: player.token });
      broadcast(game);
    })
  );

  socket.on(
    'rejoin',
    safe(socket, ({ code, playerId, token } = {}) => {
      rateLimit(socket, 'rejoin', 30, 60 * 1000);
      const game = games.get(String(code || '').trim().toUpperCase());
      const player = game && G.getPlayer(game, playerId);
      if (!game || !player || player.token !== token) {
        socket.emit('rejoin_failed');
        return;
      }
      player.connected = true;
      bind(socket, game, player);
      socket.emit('joined', { code: game.code, playerId: player.id, token: player.token });
      broadcast(game);
    })
  );

  socket.on(
    'start_hand',
    safe(socket, () => {
      const { game, player } = currentGame(socket);
      G.startHand(game, player.id);
      broadcast(game);
    })
  );

  socket.on(
    'action',
    safe(socket, (action = {}) => {
      const { game, player } = currentGame(socket);
      G.applyAction(game, player.id, action);
      broadcast(game);
    })
  );

  // Host acts (fold/check only) for a disconnected player whose turn it is.
  socket.on(
    'host_action',
    safe(socket, ({ type } = {}) => {
      const { game, player } = currentGame(socket);
      if (!G.isActingHost(game, player.id)) throw new G.GameError('Only the host can do that.');
      if (type !== 'fold' && type !== 'check') throw new G.GameError('Host can only fold or check for a player.');
      G.applyAction(game, game.actorId, { type }, 'host');
      broadcast(game);
    })
  );

  socket.on(
    'award_pot',
    safe(socket, ({ potIndex, winnerIds } = {}) => {
      const { game, player } = currentGame(socket);
      G.awardPot(game, player.id, potIndex, winnerIds);
      broadcast(game);
    })
  );

  socket.on(
    'rebuy',
    safe(socket, ({ targetId } = {}) => {
      const { game, player } = currentGame(socket);
      G.rebuy(game, player.id, targetId);
      broadcast(game);
    })
  );

  socket.on(
    'kick',
    safe(socket, ({ targetId } = {}) => {
      const { game, player } = currentGame(socket);
      G.kickPlayer(game, player.id, targetId);
      if (game.players.length === 0) {
        removeGame(game.code);
      } else {
        broadcast(game);
      }
    })
  );

  socket.on(
    'transfer_host',
    safe(socket, ({ targetId } = {}) => {
      const { game, player } = currentGame(socket);
      G.transferHost(game, player.id, targetId);
      broadcast(game);
    })
  );

  socket.on(
    'move_player',
    safe(socket, ({ targetId, direction } = {}) => {
      const { game, player } = currentGame(socket);
      G.movePlayer(game, player.id, targetId, Number(direction) || 1);
      broadcast(game);
    })
  );

  socket.on(
    'set_dealer',
    safe(socket, ({ targetId } = {}) => {
      const { game, player } = currentGame(socket);
      G.setNextDealer(game, player.id, targetId);
      broadcast(game);
    })
  );

  socket.on(
    'update_settings',
    safe(socket, (patch = {}) => {
      const { game, player } = currentGame(socket);
      G.updateSettings(game, player.id, patch);
      broadcast(game);
    })
  );

  socket.on(
    'set_straddle',
    safe(socket, ({ on } = {}) => {
      const { game, player } = currentGame(socket);
      G.setStraddle(game, player.id, on);
      broadcast(game);
    })
  );

  socket.on(
    'tournament_pause',
    safe(socket, ({ paused } = {}) => {
      const { game, player } = currentGame(socket);
      G.setTournamentPaused(game, player.id, !!paused);
      broadcast(game);
    })
  );

  socket.on(
    'league_create',
    safe(socket, ({ name } = {}) => {
      const { game, player } = currentGame(socket);
      if (!G.isActingHost(game, player.id)) throw new G.GameError('Only the host can create a league.');
      rateLimit(socket, 'league_create', 4, 10 * 60 * 1000);
      const league = store.createLeague(name);
      game.leagueCode = league.code;
      game.leagueName = league.name;
      G.log(game, `This game is now part of league ${league.name} (${league.code}).`);
      broadcast(game);
    })
  );

  socket.on(
    'league_attach',
    safe(socket, ({ code } = {}) => {
      const { game, player } = currentGame(socket);
      if (!G.isActingHost(game, player.id)) throw new G.GameError('Only the host can attach a league.');
      rateLimit(socket, 'league_attach', 15, 60 * 1000);
      const league = store.getLeague(code);
      if (!league) throw new G.GameError('No league found with that code.');
      game.leagueCode = league.code;
      game.leagueName = league.name;
      G.log(game, `This game is now part of league ${league.name} (${league.code}).`);
      broadcast(game);
    })
  );

  // Save (or update) tonight's results into the league. Host-only, between hands.
  socket.on(
    'league_save',
    safe(socket, () => {
      const { game, player } = currentGame(socket);
      if (!G.isActingHost(game, player.id)) throw new G.GameError('Only the host can save the night.');
      if (!game.leagueCode) throw new G.GameError('This game is not attached to a league.');
      if (G.isBettingStage(game) || game.stage === 'showdown') {
        throw new G.GameError('Save the night between hands.');
      }
      store.saveNight(game.leagueCode, {
        savedAt: Date.now(),
        gameCode: game.code,
        currency: game.settings.currency,
        valueMinor: Math.round(game.settings.chipValue * 100),
        biggestPot: game.biggestPot,
        results: game.players.map((p) => ({
          name: p.name,
          buyIn: p.buyIn,
          stack: p.chips,
          net: p.chips - p.buyIn,
          handsWon: p.handsWon,
        })),
      });
      G.log(game, `Night saved to league ${game.leagueName}.`);
      broadcast(game);
    })
  );

  socket.on(
    'leave',
    safe(socket, () => {
      const { game, player } = currentGame(socket);
      G.leaveGame(game, player.id);
      socket.leave(room(game.code));
      socket.data.code = null;
      socket.data.playerId = null;
      socket.emit('left');
      if (game.players.length === 0) {
        removeGame(game.code);
      } else {
        broadcast(game);
      }
    })
  );

  socket.on('disconnect', () => {
    const game = games.get(socket.data.code);
    const player = game && G.getPlayer(game, socket.data.playerId);
    if (player) {
      player.connected = false;
      broadcast(game);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`PokerPal running at http://localhost:${PORT}`);
});

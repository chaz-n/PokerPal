const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const G = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const games = new Map(); // code -> game

// Drop games idle for 12 hours.
setInterval(() => {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000;
  for (const [code, game] of games) {
    if (game.lastActivity < cutoff) games.delete(code);
  }
}, 60 * 60 * 1000).unref();

function room(code) {
  return `game:${code}`;
}

function broadcast(game) {
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
      if (err instanceof G.GameError) {
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
    safe(socket, ({ name, settings } = {}) => {
      const { game, player } = G.createGame(name, settings || {});
      games.set(game.code, game);
      bind(socket, game, player);
      socket.emit('joined', { code: game.code, playerId: player.id, token: player.token });
      broadcast(game);
    })
  );

  socket.on(
    'join',
    safe(socket, ({ code, name } = {}) => {
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
      G.applyAction(game, game.actorId, { type }, true);
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
    'leave',
    safe(socket, () => {
      const { game, player } = currentGame(socket);
      G.leaveGame(game, player.id);
      socket.leave(room(game.code));
      socket.data.code = null;
      socket.data.playerId = null;
      socket.emit('left');
      if (game.players.length === 0) {
        games.delete(game.code);
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

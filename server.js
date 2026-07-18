// Neon Arena — online multiplayer shooter backend
// Node.js + Express + Socket.io
// Handles lobby matchmaking (2-8 players per room), position/aim relay, and
// server-validated hit/damage/kill tracking.

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;
const LOBBY_WAIT_MS = 6000; // grace window to let more players join once min is reached

// 8 spawn points around a ring
const SPAWN_POINTS = Array.from({ length: MAX_PLAYERS }, (_, i) => {
  const angle = (i / MAX_PLAYERS) * Math.PI * 2;
  return { x: Math.cos(angle) * 11, z: Math.sin(angle) * 11 };
});

const PALETTE = ['#3ee6d0', '#e23e6b', '#e2b83e', '#8a5ce2', '#3ea6e2', '#e2653e', '#5ce28a', '#e23ee0'];

let lobby = []; // array of sockets waiting
let lobbyTimer = null;

const rooms = new Map(); // roomId -> { players: Map(id -> {name,hp,alive,kills,color,spawnIndex}), alive: Set }

function makeRoomId() {
  return 'r_' + Math.random().toString(36).slice(2, 9);
}

function startLobbyCountdown() {
  if (lobbyTimer) return;
  broadcastLobby();
  lobbyTimer = setTimeout(finalizeLobby, LOBBY_WAIT_MS);
}

function broadcastLobby() {
  lobby.forEach(s => {
    s.emit('lobbyUpdate', {
      count: lobby.length,
      max: MAX_PLAYERS,
      names: lobby.map(p => p.data.name)
    });
  });
}

function finalizeLobby() {
  lobbyTimer = null;
  if (lobby.length < MIN_PLAYERS) return; // not enough players, keep waiting

  const participants = lobby.splice(0, MAX_PLAYERS);
  const roomId = makeRoomId();
  const players = new Map();

  participants.forEach((s, i) => {
    s.join(roomId);
    s.data.roomId = roomId;
    players.set(s.id, {
      name: s.data.name,
      hp: 100,
      alive: true,
      kills: 0,
      color: PALETTE[i % PALETTE.length],
      spawnIndex: i
    });
  });

  rooms.set(roomId, { players });

  participants.forEach(s => {
    s.emit('matchFound', {
      roomId,
      selfId: s.id,
      players: Array.from(players.entries()).map(([id, p]) => ({
        id, name: p.name, color: p.color, spawnIndex: p.spawnIndex, hp: p.hp
      })),
      spawnPoints: SPAWN_POINTS
    });
  });

  // if leftover players still waiting, keep the lobby loop going
  if (lobby.length >= MIN_PLAYERS) startLobbyCountdown();
}

function checkRoundEnd(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const aliveIds = Array.from(room.players.entries()).filter(([, p]) => p.alive).map(([id]) => id);
  if (aliveIds.length <= 1) {
    io.to(roomId).emit('matchOver', {
      winnerId: aliveIds[0] || null,
      scores: Array.from(room.players.entries()).map(([id, p]) => ({ id, name: p.name, kills: p.kills }))
    });
  }
}

io.on('connection', (socket) => {
  socket.data.roomId = null;
  socket.data.name = 'Player';

  socket.on('findMatch', (payload) => {
    socket.data.name = (payload && payload.name) ? String(payload.name).slice(0, 16) : 'Player';
    if (lobby.find(s => s.id === socket.id)) return;
    if (lobby.length >= MAX_PLAYERS) return;
    lobby.push(socket);
    socket.emit('waiting');
    broadcastLobby();
    if (lobby.length >= MIN_PLAYERS) startLobbyCountdown();
    if (lobby.length >= MAX_PLAYERS) finalizeLobby();
  });

  socket.on('cancelFind', () => {
    lobby = lobby.filter(s => s.id !== socket.id);
    if (lobby.length < MIN_PLAYERS && lobbyTimer) {
      clearTimeout(lobbyTimer);
      lobbyTimer = null;
    }
    broadcastLobby();
  });

  // position/rotation relay
  socket.on('state', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponentState', { id: socket.id, ...data });
  });

  // visual-only tracer relay (server does not use this for damage)
  socket.on('shoot', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponentShoot', { id: socket.id, ...data });
  });

  // server-validated hit
  socket.on('hit', ({ targetId, damage }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const target = room.players.get(targetId);
    const shooter = room.players.get(socket.id);
    if (!target || !shooter || !target.alive || targetId === socket.id) return;

    const dmg = Math.max(0, Math.min(100, Number(damage) || 0));
    target.hp = Math.max(0, target.hp - dmg);
    io.to(roomId).emit('hpUpdate', { targetId, hp: target.hp });

    if (target.hp <= 0 && target.alive) {
      target.alive = false;
      shooter.kills += 1;
      io.to(roomId).emit('playerDown', { targetId, killerId: socket.id, killerName: shooter.name });
      checkRoundEnd(roomId);
    }
  });

  socket.on('rematch', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.forEach(p => { p.hp = 100; p.alive = true; p.kills = 0; });
    io.to(roomId).emit('rematchStart', {
      players: Array.from(room.players.entries()).map(([id, p]) => ({
        id, name: p.name, color: p.color, spawnIndex: p.spawnIndex, hp: p.hp
      })),
      spawnPoints: SPAWN_POINTS
    });
  });

  socket.on('disconnect', () => {
    lobby = lobby.filter(s => s.id !== socket.id);
    if (lobby.length < MIN_PLAYERS && lobbyTimer) {
      clearTimeout(lobbyTimer);
      lobbyTimer = null;
    }

    const roomId = socket.data.roomId;
    if (roomId) {
      const room = rooms.get(roomId);
      if (room) {
        const p = room.players.get(socket.id);
        if (p) p.alive = false;
        room.players.delete(socket.id);
        socket.to(roomId).emit('opponentLeft', { id: socket.id });
        if (room.players.size === 0) {
          rooms.delete(roomId);
        } else {
          checkRoundEnd(roomId);
        }
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Neon Arena server running on port ' + PORT);
});

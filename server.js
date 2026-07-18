// سرور دوئل سه‌بعدی آنلاین
// Node.js + Express + Socket.io
// این سرور بازیکن‌ها را دو به دو جفت می‌کند و حرکت/ضربه‌هایشان را بین‌شان رد و بدل می‌کند.

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

// صف انتظار برای جفت‌سازی
let waitingPlayer = null;

// اتاق‌های فعال: roomId -> { players: [socketId, socketId], hp: {id:hp} }
const rooms = new Map();

function makeRoomId() {
  return 'r_' + Math.random().toString(36).slice(2, 9);
}

io.on('connection', (socket) => {
  console.log('connected', socket.id);

  socket.data.roomId = null;

  socket.on('findMatch', (payload) => {
    socket.data.name = (payload && payload.name) ? String(payload.name).slice(0, 20) : 'Player';

    if (waitingPlayer && waitingPlayer.connected && waitingPlayer.id !== socket.id) {
      const roomId = makeRoomId();
      const p1 = waitingPlayer;
      const p2 = socket;

      p1.join(roomId);
      p2.join(roomId);
      p1.data.roomId = roomId;
      p2.data.roomId = roomId;

      rooms.set(roomId, {
        players: [p1.id, p2.id],
        hp: { [p1.id]: 100, [p2.id]: 100 }
      });

      p1.emit('matchFound', { roomId, side: 'p1', opponentName: p2.data.name, selfName: p1.data.name });
      p2.emit('matchFound', { roomId, side: 'p2', opponentName: p1.data.name, selfName: p2.data.name });

      waitingPlayer = null;
    } else {
      waitingPlayer = socket;
      socket.emit('waiting');
    }
  });

  socket.on('cancelFind', () => {
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;
  });

  // حرکت/چرخش بازیکن - فقط برای حریف در همون اتاق پخش میشه
  socket.on('state', (data) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponentState', data);
  });

  // رویداد حمله
  socket.on('attack', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    socket.to(roomId).emit('opponentAttack');
  });

  // اعلام برخورد (کلاینت مهاجم تشخیص میده و به سرور میگه ضربه خورده یا نه)
  // هدف همیشه «بازیکن دیگر همان اتاق» است، نه چیزی که کلاینت مشخص کند (برای جلوگیری از تقلب ساده)
  socket.on('hit', ({ damage, blocked }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const targetId = room.players.find(id => id !== socket.id);
    if (!targetId || !room.hp.hasOwnProperty(targetId)) return;

    if (!blocked) {
      room.hp[targetId] = Math.max(0, room.hp[targetId] - damage);
    }

    io.to(roomId).emit('hpUpdate', { targetId, hp: room.hp[targetId], blocked });

    if (room.hp[targetId] <= 0) {
      io.to(roomId).emit('roundOver', { loserId: targetId });
    }
  });

  socket.on('rematch', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    room.hp[room.players[0]] = 100;
    room.hp[room.players[1]] = 100;
    io.to(roomId).emit('rematchStart');
  });

  socket.on('disconnect', () => {
    console.log('disconnected', socket.id);
    if (waitingPlayer && waitingPlayer.id === socket.id) waitingPlayer = null;

    const roomId = socket.data.roomId;
    if (roomId) {
      socket.to(roomId).emit('opponentLeft');
      rooms.delete(roomId);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log('Sword Duel 3D server running on port ' + PORT);
});

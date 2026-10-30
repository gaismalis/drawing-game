const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // rooms idle longer than this are deleted
const MAX_NAME_LENGTH = 20;
const MAX_PLAYERS = 20;

// One word per line; lines starting with # are category comments.
const WORDS = [
  ...new Set(
    fs
      .readFileSync(path.join(__dirname, 'data', 'words.txt'), 'utf8')
      .split('\n')
      .map((w) => w.trim())
      .filter((w) => w && !w.startsWith('#'))
  ),
];
console.log(`Loaded ${WORDS.length} words`);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const io = new Server(server);

/**
 * rooms: code -> {
 *   code, adminId, createdAt, lastActivity,
 *   players: Map<playerId, { id, name, token, socketId, online, joinedAt }>,
 *   usedWords: Set<string>,
 *   round: null | { number, word, impostorIds: Set, firstPlayerId, revealed },
 *   roundCount,
 * }
 */
const rooms = new Map();

function randomInt(max) {
  return crypto.randomInt(max);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function newRoomCode() {
  for (let i = 0; i < 1000; i++) {
    const code = String(randomInt(10000)).padStart(4, '0');
    if (!rooms.has(code)) return code;
  }
  throw new Error('No free room codes');
}

function pickWord(room) {
  let available = WORDS.filter((w) => !room.usedWords.has(w));
  if (available.length === 0) {
    // Every word has been played in this room — start over.
    room.usedWords.clear();
    available = WORDS;
  }
  const word = available[randomInt(available.length)];
  room.usedWords.add(word);
  return word;
}

function cleanName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH);
}

function nameTaken(room, name) {
  const lower = name.toLocaleLowerCase('lv');
  return [...room.players.values()].some((p) => p.name.toLocaleLowerCase('lv') === lower);
}

function addPlayer(room, name) {
  const player = {
    id: crypto.randomUUID(),
    name,
    token: crypto.randomBytes(24).toString('hex'),
    socketId: null,
    online: false,
    joinedAt: Date.now(),
  };
  room.players.set(player.id, player);
  return player;
}

function attachSocket(socket, room, player) {
  // A newer tab/connection for the same player takes over.
  if (player.socketId && player.socketId !== socket.id) {
    const old = io.sockets.sockets.get(player.socketId);
    if (old) {
      old.data = {};
      old.emit('replaced');
    }
  }
  player.socketId = socket.id;
  player.online = true;
  socket.data = { code: room.code, playerId: player.id };
  room.lastActivity = Date.now();
}

/** Build the state a single player is allowed to see. Never leaks other players' roles. */
function stateFor(room, player) {
  const round = room.round;
  let roundView = null;
  if (round) {
    const participating = round.participantIds.has(player.id);
    roundView = {
      number: round.number,
      participating,
      role: participating ? (round.impostorIds.has(player.id) ? 'impostor' : 'artist') : null,
      word: participating && !round.impostorIds.has(player.id) ? round.word : null,
      firstPlayerName: room.players.get(round.firstPlayerId)?.name || null,
      impostorCount: round.impostorIds.size,
      revealed: round.revealed,
    };
    if (round.revealed) {
      roundView.word = round.word;
      roundView.impostorNames = round.impostorNames;
    }
  }
  return {
    code: room.code,
    me: { id: player.id, name: player.name, isAdmin: room.adminId === player.id },
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      online: p.online,
      isAdmin: room.adminId === p.id,
    })),
    round: roundView,
    wordsUsed: room.usedWords.size,
    wordsTotal: WORDS.length,
  };
}

function broadcast(room) {
  for (const player of room.players.values()) {
    if (player.socketId) io.to(player.socketId).emit('state', stateFor(room, player));
  }
}

function getContext(socket) {
  const { code, playerId } = socket.data || {};
  const room = code && rooms.get(code);
  const player = room && room.players.get(playerId);
  if (!room || !player) return null;
  room.lastActivity = Date.now();
  return { room, player, isAdmin: room.adminId === player.id };
}

function removePlayer(room, playerId) {
  room.players.delete(playerId);
  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.adminId === playerId) {
    // Hand admin to the longest-standing player, preferring someone online.
    const candidates = [...room.players.values()].sort(
      (a, b) => b.online - a.online || a.joinedAt - b.joinedAt
    );
    room.adminId = candidates[0].id;
  }
}

io.on('connection', (socket) => {
  socket.data = {};

  socket.on('create', ({ name } = {}, ack = () => {}) => {
    name = cleanName(name);
    if (!name) return ack({ error: 'Ievadi savu vārdu' });
    const code = newRoomCode();
    const room = {
      code,
      adminId: null,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      players: new Map(),
      usedWords: new Set(),
      round: null,
      roundCount: 0,
    };
    rooms.set(code, room);
    const player = addPlayer(room, name);
    room.adminId = player.id;
    attachSocket(socket, room, player);
    ack({ code, playerId: player.id, token: player.token });
    broadcast(room);
  });

  socket.on('join', ({ code, name } = {}, ack = () => {}) => {
    name = cleanName(name);
    code = String(code || '').trim();
    if (!name) return ack({ error: 'Ievadi savu vārdu' });
    const room = rooms.get(code);
    if (!room) return ack({ error: 'Istaba ar šādu kodu nav atrasta' });
    if (room.players.size >= MAX_PLAYERS) return ack({ error: 'Istaba ir pilna' });
    if (nameTaken(room, name)) return ack({ error: 'Šis vārds jau ir aizņemts' });
    const player = addPlayer(room, name);
    attachSocket(socket, room, player);
    ack({ code, playerId: player.id, token: player.token });
    broadcast(room);
  });

  // Reconnect after refresh / screen lock / closed tab.
  socket.on('resume', ({ code, playerId, token } = {}, ack = () => {}) => {
    const room = rooms.get(String(code || ''));
    const player = room && room.players.get(playerId);
    if (!player || player.token !== token) return ack({ error: 'gone' });
    attachSocket(socket, room, player);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('kick', ({ playerId } = {}) => {
    const ctx = getContext(socket);
    if (!ctx || !ctx.isAdmin || playerId === ctx.player.id) return;
    const target = ctx.room.players.get(playerId);
    if (!target) return;
    if (target.socketId) {
      const s = io.sockets.sockets.get(target.socketId);
      if (s) {
        s.data = {};
        s.emit('kicked');
      }
    }
    removePlayer(ctx.room, playerId);
    broadcast(ctx.room);
  });

  socket.on('makeAdmin', ({ playerId } = {}) => {
    const ctx = getContext(socket);
    if (!ctx || !ctx.isAdmin || !ctx.room.players.has(playerId)) return;
    ctx.room.adminId = playerId;
    broadcast(ctx.room);
  });

  socket.on('leave', () => {
    const ctx = getContext(socket);
    if (!ctx) return;
    socket.data = {};
    removePlayer(ctx.room, ctx.player.id);
    if (rooms.has(ctx.room.code)) broadcast(ctx.room);
  });

  socket.on('startRound', ({ impostors } = {}, ack = () => {}) => {
    const ctx = getContext(socket);
    if (!ctx || !ctx.isAdmin) return;
    const { room } = ctx;
    const participants = [...room.players.values()];
    if (participants.length < 3) return ack({ error: 'Vajag vismaz 3 spēlētājus' });
    const count = Math.max(1, Math.min(Number(impostors) || 1, participants.length - 2));
    const shuffled = shuffle(participants.map((p) => p.id));
    const impostorIds = new Set(shuffled.slice(0, count));
    room.roundCount += 1;
    room.round = {
      number: room.roundCount,
      word: pickWord(room),
      participantIds: new Set(participants.map((p) => p.id)),
      impostorIds,
      impostorNames: [...impostorIds].map((id) => room.players.get(id).name),
      firstPlayerId: participants[randomInt(participants.length)].id,
      revealed: false,
    };
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('reveal', () => {
    const ctx = getContext(socket);
    if (!ctx || !ctx.isAdmin || !ctx.room.round) return;
    ctx.room.round.revealed = true;
    broadcast(ctx.room);
  });

  socket.on('disconnect', () => {
    const ctx = getContext(socket);
    if (!ctx || ctx.player.socketId !== socket.id) return;
    // Disconnecting is NOT leaving — the player stays in the room and can resume.
    ctx.player.online = false;
    ctx.player.socketId = null;
    broadcast(ctx.room);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (now - room.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));

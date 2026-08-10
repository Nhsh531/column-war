/* ============================================================
   מלחמת טורים — שרת אונליין (Node + WebSocket)
   חדרים עם קוד הצטרפות, מצב סמכותי, סנכרון בזמן אמת
   ============================================================ */
'use strict';

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const core = require('./game-core');

const app = express();
// הקליינט הוא קובץ יחיד (index.html) שיושב לצד השרת
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/* rooms: code -> { code, mode, timerLen, names:[], sockets:[ws,ws], game, timer } */
const rooms = new Map();

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function broadcastState(room) {
  room.sockets.forEach((ws, i) => {
    if (ws) send(ws, { type: 'state', state: core.view(room.game, i, room.names) });
  });
}

function clearTimer(room) { if (room.timer) { clearTimeout(room.timer); room.timer = null; } }

function armTimer(room) {
  clearTimer(room);
  if (!room.game || room.game.over || room.game.turnEndsAt == null) return;
  const ms = Math.max(0, room.game.turnEndsAt - Date.now());
  room.timer = setTimeout(() => {
    if (!room.game || room.game.over) return;
    core.autoMove(room.game);
    broadcastState(room);
    progress(room);
  }, ms + 50);
}

/* decide what happens after a state change: bot plays, or human timer arms */
function progress(room) {
  if (!room.game) return;
  if (room.game.over) { clearTimer(room); return; }
  if (room.bot && room.game.turn === 1) {
    clearTimer(room);
    room.timer = setTimeout(() => {
      if (!room.game || room.game.over) return;
      core.botMove(room.game, room.difficulty);
      broadcastState(room);
      progress(room);
    }, 700);
  } else {
    armTimer(room);
  }
}

function startGame(room) {
  room.game = core.createGame(room.mode, room.timerLen);
  core.startTurn(room.game);
  broadcastState(room);
  progress(room);
}

wss.on('connection', (ws) => {
  ws.room = null;
  ws.seat = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'create') {
      const code = makeCode();
      const room = {
        code,
        mode: msg.mode || 'majority',
        timerLen: msg.timer || 20,
        names: [(msg.name || 'שחקן 1').slice(0, 16), null],
        sockets: [ws, null],
        game: null, timer: null,
      };
      rooms.set(code, room);
      ws.room = code; ws.seat = 0;
      send(ws, { type: 'created', code, seat: 0 });
      send(ws, { type: 'lobby', code, names: room.names, canStart: false });
      return;
    }

    if (msg.type === 'solo') {
      const code = makeCode();
      const room = {
        code,
        mode: msg.mode || 'majority',
        timerLen: msg.timer || 20,
        names: [(msg.name || 'שחקן').slice(0, 16), 'המחשב'],
        sockets: [ws, null],
        game: null, timer: null, bot: true,
        difficulty: ['easy', 'medium', 'hard'].includes(msg.difficulty) ? msg.difficulty : 'medium',
      };
      rooms.set(code, room);
      ws.room = code; ws.seat = 0;
      send(ws, { type: 'created', code, seat: 0, solo: true });
      startGame(room);
      return;
    }

    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) return send(ws, { type: 'error', msg: 'לא נמצא חדר עם הקוד הזה' });
      if (room.sockets[1]) return send(ws, { type: 'error', msg: 'החדר מלא' });
      room.sockets[1] = ws;
      room.names[1] = (msg.name || 'שחקן 2').slice(0, 16);
      ws.room = code; ws.seat = 1;
      send(ws, { type: 'joined', code, seat: 1 });
      // notify both that the room is ready, then start
      room.sockets.forEach((s, i) => send(s, { type: 'lobby', code, names: room.names, canStart: true }));
      startGame(room);
      return;
    }

    if (msg.type === 'move') {
      const room = rooms.get(ws.room);
      if (!room || !room.game) return;
      let res;
      if (msg.action === 'place') res = core.place(room.game, ws.seat, msg.cardId, msg.col);
      else if (msg.action === 'burn') res = core.burn(room.game, ws.seat, msg.cardId);
      else return;
      if (!res.ok) { send(ws, { type: 'error', msg: res.error }); return; }
      broadcastState(room);
      progress(room);
      return;
    }

    if (msg.type === 'rematch') {
      const room = rooms.get(ws.room);
      if (!room) return;
      // PvP needs both players; solo just needs the human
      if (room.bot ? !room.sockets[0] : (!room.sockets[0] || !room.sockets[1])) return;
      startGame(room);
      return;
    }
  });

  ws.on('close', () => {
    const room = rooms.get(ws.room);
    if (!room) return;
    clearTimer(room);
    const other = room.sockets[1 - ws.seat];
    send(other, { type: 'opponent_left', msg: 'היריב התנתק' });
    rooms.delete(room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  מלחמת טורים — השרת פועל`);
  console.log(`  פתחו בדפדפן:  http://localhost:${PORT}`);
  console.log(`  לשחק עם חברים באותה רשת: http://<כתובת-ה-IP-שלכם>:${PORT}\n`);
});

/* ============================================================
   מלחמת טורים — מנוע משחק סמכותי (רץ בצד השרת)
   מודול משותף: חפיסה, הערכת פוקר, מהלכים, סיום, תצוגה מותאמת
   ============================================================ */
'use strict';

const SUITS = ['♠', '♥', '♦', '♣'];
const RED = new Set(['♥', '♦']);
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
const rankLabel = r => RANK_LABEL[r] || String(r);

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let r = 2; r <= 14; r++) d.push({ rank: r, suit: s, id: r + s });
  return d;
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- poker ---------- */
function evaluate5(cards) {
  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);
  const uniq = [...new Set(ranks)];
  let straight = false, high = 0;
  if (uniq.length === 5) {
    if (ranks[0] - ranks[4] === 4) { straight = true; high = ranks[0]; }
    else if (ranks[0] === 14 && ranks[1] === 5 && ranks[4] === 2) { straight = true; high = 5; }
  }
  const counts = {};
  ranks.forEach(r => counts[r] = (counts[r] || 0) + 1);
  const g = Object.entries(counts).map(([r, c]) => ({ rank: +r, count: c }))
    .sort((a, b) => b.count - a.count || b.rank - a.rank);
  const pat = g.map(x => x.count).join('');
  let cat;
  if (straight && isFlush) cat = 8;
  else if (pat === '41') cat = 7;
  else if (pat === '32') cat = 6;
  else if (isFlush) cat = 5;
  else if (straight) cat = 4;
  else if (pat === '311') cat = 3;
  else if (pat === '221') cat = 2;
  else if (pat === '2111') cat = 1;
  else cat = 0;
  const tb = (cat === 8 || cat === 4) ? [high] : g.map(x => x.rank);
  return { cat, score: [cat, ...tb], cards };
}
const HAND_NAMES = ['קלף גבוה', 'זוג', 'זוג כפול', 'שלישייה', 'סטרייט', 'פלאש', 'פול האוס', 'רביעייה', 'סטרייט פלאש'];
function handName(e) { return (e.cat === 8 && e.score[1] === 14) ? 'רויאל פלאש' : HAND_NAMES[e.cat]; }
function cmp(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const x = a[i] || 0, y = b[i] || 0; if (x !== y) return x - y; }
  return 0;
}
function bestOf(cards) {
  if (cards.length === 5) return evaluate5(cards);
  let best = null;
  for (let i = 0; i < cards.length; i++) {
    const sub = cards.filter((_, j) => j !== i);
    const e = sub.length === 5 ? evaluate5(sub) : bestOf(sub);
    if (!best || cmp(e.score, best.score) > 0) best = e;
  }
  return best;
}

/* ---------- game state ---------- */
function createGame(mode, timerLen) {
  const deck = shuffle(makeDeck());
  const players = [newPlayer(), newPlayer()];
  for (let k = 0; k < 6; k++) { players[0].hand.push(deck.pop()); players[1].hand.push(deck.pop()); }
  return {
    mode: (mode === 'points' ? 'points' : 'majority'),
    timerLen: [10, 20, 30].includes(timerLen) ? timerLen : 20,
    deck, discard: [], players,
    turn: 0, started: true, over: false,
    justDrawn: [null, null], turnEndsAt: null, result: null,
  };
}
function newPlayer() { return { hand: [], columns: [[], [], [], []], burnedUsed: false }; }
function allFull(p) { return p.columns.every(c => c.length === 5); }
function drawCard(g) {
  if (g.deck.length === 0 && g.discard.length) { g.deck = shuffle(g.discard); g.discard = []; }
  return g.deck.length ? g.deck.pop() : null;
}

/* draw one card for the player whose turn it now is */
function startTurn(g) {
  if (g.over) return;
  const p = g.players[g.turn];
  if (allFull(p)) { g.turn = 1 - g.turn; if (allFull(g.players[g.turn])) { finish(g); return; } }
  const d = drawCard(g);
  if (d) g.players[g.turn].hand.push(d);
  g.justDrawn[g.turn] = d ? d.id : null;
  g.turnEndsAt = Date.now() + g.timerLen * 1000;
}

function place(g, player, cardId, col) {
  if (g.over) return { ok: false, error: 'המשחק נגמר' };
  if (player !== g.turn) return { ok: false, error: 'לא תורך' };
  const p = g.players[player];
  if (col < 0 || col > 3) return { ok: false, error: 'טור לא חוקי' };
  if (p.columns[col].length >= 5) return { ok: false, error: 'הטור מלא' };
  const i = p.hand.findIndex(c => c.id === cardId);
  if (i < 0) return { ok: false, error: 'אין קלף כזה ביד' };
  p.columns[col].push(p.hand.splice(i, 1)[0]);
  advance(g);
  return { ok: true };
}
function burn(g, player, cardId) {
  if (g.over) return { ok: false, error: 'המשחק נגמר' };
  if (player !== g.turn) return { ok: false, error: 'לא תורך' };
  const p = g.players[player];
  if (p.burnedUsed) return { ok: false, error: 'כבר שרפת פעם אחת' };
  const i = p.hand.findIndex(c => c.id === cardId);
  if (i < 0) return { ok: false, error: 'אין קלף כזה ביד' };
  g.discard.push(p.hand.splice(i, 1)[0]);
  const d = drawCard(g);
  if (d) p.hand.push(d);
  p.burnedUsed = true;
  g.justDrawn[player] = d ? d.id : null;
  return { ok: true }; // still same turn, must place afterwards
}
function advance(g) {
  if (g.players.every(allFull)) { finish(g); return; }
  g.turn = 1 - g.turn;
  if (allFull(g.players[g.turn])) {
    g.turn = 1 - g.turn;
    if (allFull(g.players[g.turn])) { finish(g); return; }
  }
  startTurn(g);
}

/* auto-move on timeout: place a random legal card */
function autoMove(g) {
  if (g.over) return { ok: false };
  const p = g.players[g.turn];
  const cols = p.columns.map((c, i) => i).filter(i => p.columns[i].length < 5);
  if (!cols.length || !p.hand.length) { advance(g); return { ok: true, auto: true }; }
  const card = p.hand[Math.floor(Math.random() * p.hand.length)];
  const col = cols[Math.floor(Math.random() * cols.length)];
  return { ...place(g, g.turn, card.id, col), auto: true };
}

function finish(g) {
  g.over = true;
  g.turnEndsAt = null;
  const [A, B] = g.players;
  const ha = hands(A), hb = hands(B);
  const labels = ['טור 1', 'טור 2', 'טור 3', 'טור 4', 'היד'];
  let wA = 0, wB = 0, ties = 0, pA = 0, pB = 0;
  const rows = [];
  for (let i = 0; i < 5; i++) {
    const c = cmp(ha[i].score, hb[i].score);
    pA += ha[i].cat + 1; pB += hb[i].cat + 1;
    let w = 0; if (c > 0) { wA++; w = 0; } else if (c < 0) { wB++; w = 1; } else { ties++; w = -1; }
    rows.push({ label: labels[i], a: { cards: ha[i].cards, name: handName(ha[i]) }, b: { cards: hb[i].cards, name: handName(hb[i]) }, winner: w });
  }
  let winner;
  if (g.mode === 'majority') winner = wA > wB ? 0 : wB > wA ? 1 : -1;
  else winner = pA > pB ? 0 : pB > pA ? 1 : -1;
  g.result = { mode: g.mode, winner, wins: [wA, wB], points: [pA, pB], ties, rows };
}
function hands(p) { const h = p.columns.map(c => evaluate5(c)); h.push(bestOf(p.hand)); return h; }

/* ---------- personalized view sent to one player ---------- */
function view(g, player, names) {
  const meIdx = player, oppIdx = 1 - player;
  const me = g.players[meIdx], opp = g.players[oppIdx];
  return {
    you: player,
    names,
    mode: g.mode,
    timerLen: g.timerLen,
    turn: g.turn,
    yourTurn: g.turn === player && !g.over,
    turnEndsAt: g.turnEndsAt,
    deckCount: g.deck.length,
    over: g.over,
    justDrawnId: g.justDrawn[player],
    me: {
      name: names[meIdx],
      hand: me.hand,
      columns: me.columns,
      burnedUsed: me.burnedUsed,
    },
    opp: {
      name: names[oppIdx],
      handCount: opp.hand.length,
      burnedUsed: opp.burnedUsed,
      // opponent columns: first 4 face up, 5th hidden
      columns: opp.columns.map(col => col.map((c, ci) => ci === 4 ? { back: true } : c)),
    },
    result: g.over ? g.result : null,
  };
}

/* ============================================================
   בוט — יריב מחשב (אותה היוריסטיקה כמו בגרסה המקומית)
   מניח שכבר נמשך קלף בתחילת התור (startTurn), רק שורף-אולי + מוריד
   ============================================================ */
function synergy(card, col) {
  let s = 0;
  for (const e of col) {
    if (e.rank === card.rank) s += 32;
    if (e.suit === card.suit) s += 9;
    const d = Math.abs(e.rank - card.rank);
    if (d === 1) s += 7; else if (d <= 4) s += 3;
  }
  return s;
}
function keepValue(card, p) {
  let v = card.rank * 0.35;
  for (const e of p.hand) {
    if (e.id !== card.id && e.rank === card.rank) v += 6;
    if (e.id !== card.id && e.suit === card.suit) v += 1;
  }
  return v * 0.4;
}
function leastUseful(p) {
  let worst = null;
  for (const card of p.hand) {
    let best = 0;
    for (const col of p.columns) if (col.length < 5) best = Math.max(best, synergy(card, col));
    best += keepValue(card, p);
    if (!worst || best < worst.score) worst = { id: card.id, score: best };
  }
  return worst;
}
function botMove(g, difficulty = 'medium') {
  if (g.over) return;
  const player = g.turn;
  const p = g.players[player];
  const open = p.columns.map((c, i) => i).filter(i => p.columns[i].length < 5);
  if (!open.length || !p.hand.length) return;

  // EASY: random placement, never burns — a beatable opponent
  if (difficulty === 'easy') {
    const card = p.hand[Math.floor(Math.random() * p.hand.length)];
    const ci = open[Math.floor(Math.random() * open.length)];
    place(g, player, card.id, ci);
    return;
  }

  // MEDIUM / HARD: optional one-time burn of the least useful card
  if (!p.burnedUsed && g.deck.length > 6) {
    const worst = leastUseful(p);
    const thresh = difficulty === 'hard' ? 6 : 4;
    if (worst && worst.score < thresh) burn(g, player, worst.id);
  }

  // score every (card, column) by synergy, keeping strong cards in hand
  const options = [];
  for (const card of p.hand) {
    for (const ci of open) {
      options.push({ cardId: card.id, ci, s: synergy(card, p.columns[ci]) - keepValue(card, p) });
    }
  }
  options.sort((a, b) => b.s - a.s);

  // HARD always takes the best move; MEDIUM picks from the top few (some slack)
  let pick;
  if (difficulty === 'hard') pick = options[0];
  else { const top = options.slice(0, Math.min(3, options.length)); pick = top[Math.floor(Math.random() * top.length)]; }

  if (pick) place(g, player, pick.cardId, pick.ci);
  else place(g, player, p.hand[0].id, open[0]); // fallback
}

module.exports = {
  createGame, startTurn, place, burn, autoMove, botMove, finish, view, allFull,
  evaluate5, handName, rankLabel, RED,
};

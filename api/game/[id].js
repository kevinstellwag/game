const {
  db, verifyToken, push, sessionChannel,
  ok, err, cors,
  BLACK_CARDS, WHITE_CARDS, shuffle,
} = require('../_lib');

// ── CAH game logic ────────────────────────────────────────

function startCAH(session) {
  const extra_b = session.custom_black || [];
  const extra_w = session.custom_white || [];
  const bDeck = shuffle([...extra_b, ...BLACK_CARDS]);
  const wDeck = shuffle([...extra_w, ...WHITE_CARDS]);
  const players = session.players.map(p => p.userId);

  const hands = {};
  let wi = 0;
  players.forEach(p => {
    hands[p] = wDeck.slice(wi, wi + 7);
    wi += 7;
  });

  return {
    phase: 'playing',
    round: 1,
    czarIndex: 0,
    czar: players[0],
    currentBlack: bDeck[0],
    blackDeck: bDeck.slice(1),
    whiteDeck: wDeck.slice(wi),
    hands,
    submissions: {},
    scores: Object.fromEntries(players.map(p => [p, 0])),
    winner: null,
    lastWinner: null,
    lastWinnerName: null,
    lastWinningCard: null,
    lastBlackCard: null,
  };
}

function playerView(gs, playerId, players) {
  const showSubs = gs.phase === 'judging' || gs.phase === 'scores';
  const czarPlayer = players.find(p => p.userId === gs.czar);
  const lastWinnerPlayer = players.find(p => p.userId === gs.lastWinner);
  return {
    phase: gs.phase,
    round: gs.round,
    czar: gs.czar,
    czarName: czarPlayer?.name || '?',
    currentBlack: gs.currentBlack,
    submissions: showSubs ? gs.submissions : {},
    submittedIds: Object.keys(gs.submissions),
    scores: gs.scores,
    winner: gs.winner,
    lastWinner: gs.lastWinner,
    lastWinnerName: lastWinnerPlayer?.name || '?',
    lastWinningCard: gs.lastWinningCard,
    lastBlackCard: gs.lastBlackCard,
    myHand: gs.hands?.[playerId] || [],
    hasSubmitted: !!gs.submissions?.[playerId],
    mySubmission: gs.submissions?.[playerId] || null,
    maxPoints: gs.maxPoints,
    players: players.map(p => ({
      id: p.userId,
      name: p.name,
      color: p.color,
      isHost: p.isHost,
      score: gs.scores?.[p.userId] || 0,
    })),
  };
}

// ── Handler ───────────────────────────────────────────────

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const sid = req.query.id || req.url.split('/').pop().split('?')[0];
  const { action } = req.body || {};

  try {
    const r = await db.query('SELECT * FROM game_sessions WHERE id=$1', [sid]);
    if (!r.rows[0]) return err(res, 404, 'Sessie niet gevonden');

    let session = r.rows[0];
    let players = session.players || [];
    let gs = session.game_state;
    const isHost = session.host_id === user.id;
    const maxPoints = session.max_points || 7;

    // ── START ──────────────────────────────────────────────
    if (action === 'start') {
      if (!isHost) return err(res, 403, 'Alleen de host kan starten');
      if (players.length < 2) return err(res, 400, 'Minimaal 2 spelers nodig');

      gs = startCAH({ ...session, players });
      gs.maxPoints = maxPoints;

      await db.query(
        "UPDATE game_sessions SET game_state=$1, status='playing', updated_at=NOW() WHERE id=$2",
        [JSON.stringify(gs), sid]
      );

      // Broadcast personalised state to each player
      for (const p of players) {
        await push(sessionChannel(sid), 'game-state', {
          targetUserId: p.userId,
          state: playerView(gs, p.userId, players),
        });
      }
      return ok(res, { ok: true });
    }

    if (!gs) return err(res, 400, 'Spel nog niet gestart');

    // ── ADD CUSTOM CARD ────────────────────────────────────
    if (action === 'add-card') {
      if (!isHost) return err(res, 403, 'Alleen host');
      const { cardType, card } = req.body;
      if (cardType === 'black') {
        const cb = [...(session.custom_black || []), card];
        await db.query('UPDATE game_sessions SET custom_black=$1, updated_at=NOW() WHERE id=$2',
          [JSON.stringify(cb), sid]);
      } else {
        const cw = [...(session.custom_white || []), card];
        await db.query('UPDATE game_sessions SET custom_white=$1, updated_at=NOW() WHERE id=$2',
          [JSON.stringify(cw), sid]);
      }
      return ok(res, { ok: true });
    }

    // ── SUBMIT CARD ────────────────────────────────────────
    if (action === 'submit') {
      const { card } = req.body;
      if (gs.phase !== 'playing') return err(res, 400, 'Verkeerde fase');
      if (user.id === gs.czar) return err(res, 400, 'Tsaar kan niet submitten');
      if (gs.submissions[user.id]) return err(res, 400, 'Al gespeeld');
      if (!gs.hands[user.id]?.includes(card)) return err(res, 400, 'Kaart niet in hand');

      gs.submissions[user.id] = card;
      gs.hands[user.id] = gs.hands[user.id].filter(c => c !== card);

      const nonCzar = players.filter(p => p.userId !== gs.czar);
      if (nonCzar.every(p => gs.submissions[p.userId])) {
        gs.phase = 'judging';
      }

      await db.query(
        'UPDATE game_sessions SET game_state=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(gs), sid]
      );

      for (const p of players) {
        await push(sessionChannel(sid), 'game-state', {
          targetUserId: p.userId,
          state: playerView(gs, p.userId, players),
        });
      }
      return ok(res, { ok: true });
    }

    // ── PICK WINNER ────────────────────────────────────────
    if (action === 'pick-winner') {
      if (gs.phase !== 'judging') return err(res, 400, 'Verkeerde fase');
      if (user.id !== gs.czar) return err(res, 403, 'Alleen de Tsaar');

      const { card } = req.body;
      const winnerId = Object.entries(gs.submissions).find(([, c]) => c === card)?.[0];
      if (!winnerId) return err(res, 400, 'Kaart niet gevonden');

      gs.scores[winnerId] = (gs.scores[winnerId] || 0) + 1;
      gs.lastWinner = winnerId;
      gs.lastWinningCard = card;
      gs.lastBlackCard = gs.currentBlack;
      gs.phase = 'scores';
      if (gs.scores[winnerId] >= maxPoints) gs.winner = winnerId;

      await db.query(
        'UPDATE game_sessions SET game_state=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(gs), sid]
      );

      // Update DB stats
      db.query('UPDATE user_stats SET czar_picks=czar_picks+1 WHERE user_id=$1', [user.id]).catch(() => {});
      db.query('UPDATE user_stats SET wins=wins+1, rounds_played=rounds_played+1 WHERE user_id=$1', [winnerId]).catch(() => {});
      players.filter(p => p.userId !== winnerId).forEach(p => {
        db.query('UPDATE user_stats SET rounds_played=rounds_played+1 WHERE user_id=$1', [p.userId]).catch(() => {});
      });

      for (const p of players) {
        await push(sessionChannel(sid), 'game-state', {
          targetUserId: p.userId,
          state: playerView(gs, p.userId, players),
        });
      }
      return ok(res, { ok: true });
    }

    // ── NEXT ROUND ─────────────────────────────────────────
    if (action === 'next-round') {
      if (gs.phase !== 'scores') return err(res, 400, 'Verkeerde fase');
      if (!isHost) return err(res, 403, 'Alleen host');

      if (gs.winner) {
        // New game — reset scores, keep players
        gs = startCAH({ ...session, players });
        gs.maxPoints = maxPoints;
      } else {
        // Next round
        const playerIds = players.map(p => p.userId);
        playerIds.forEach(pid => {
          gs.hands[pid] = gs.hands[pid] || [];
          while (gs.hands[pid].length < 7 && gs.whiteDeck.length > 0) {
            gs.hands[pid].push(gs.whiteDeck.shift());
          }
        });
        gs.czarIndex = (gs.czarIndex + 1) % playerIds.length;
        gs.czar = playerIds[gs.czarIndex];
        gs.submissions = {};
        gs.currentBlack = gs.blackDeck.shift()
          || BLACK_CARDS[Math.floor(Math.random() * BLACK_CARDS.length)];
        gs.phase = 'playing';
        gs.round++;
        gs.lastWinner = null;
        gs.lastWinningCard = null;
      }

      await db.query(
        'UPDATE game_sessions SET game_state=$1, updated_at=NOW() WHERE id=$2',
        [JSON.stringify(gs), sid]
      );

      for (const p of players) {
        await push(sessionChannel(sid), 'game-state', {
          targetUserId: p.userId,
          state: playerView(gs, p.userId, players),
        });
      }
      return ok(res, { ok: true });
    }

    err(res, 400, 'Onbekende actie');
  } catch (e) {
    console.error('[game/id]', e.message);
    err(res, 500, e.message);
  }
};

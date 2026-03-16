const {
  db, verifyToken, publish, sessionChannel, parseBody,
  ok, err, cors, BLACK_CARDS, WHITE_CARDS, shuffle,
} = require('../_lib');

function startCAH(session) {
  const bDeck = shuffle([...(session.custom_black || []), ...BLACK_CARDS]);
  const wDeck = shuffle([...(session.custom_white || []), ...WHITE_CARDS]);
  const playerIds = session.players.map(p => p.userId);
  const hands = {};
  let wi = 0;
  playerIds.forEach(p => { hands[p] = wDeck.slice(wi, wi + 7); wi += 7; });
  return {
    phase: 'playing', round: 1, czarIndex: 0, czar: playerIds[0],
    currentBlack: bDeck[0], blackDeck: bDeck.slice(1), whiteDeck: wDeck.slice(wi),
    hands, submissions: {},
    scores: Object.fromEntries(playerIds.map(p => [p, 0])),
    winner: null, lastWinner: null, lastWinningCard: null, lastBlackCard: null,
  };
}

function playerView(gs, playerId, players, maxPoints) {
  const showSubs = gs.phase === 'judging' || gs.phase === 'scores';
  return {
    phase: gs.phase, round: gs.round, czar: gs.czar,
    czarName: players.find(p => p.userId === gs.czar)?.name || '?',
    currentBlack: gs.currentBlack,
    submissions: showSubs ? gs.submissions : {},
    submittedIds: Object.keys(gs.submissions),
    scores: gs.scores, winner: gs.winner,
    lastWinner: gs.lastWinner,
    lastWinnerName: players.find(p => p.userId === gs.lastWinner)?.name || '?',
    lastWinningCard: gs.lastWinningCard,
    lastBlackCard: gs.lastBlackCard,
    myHand: gs.hands?.[playerId] || [],
    hasSubmitted: !!gs.submissions?.[playerId],
    mySubmission: gs.submissions?.[playerId] || null,
    maxPoints,
    players: players.map(p => ({
      id: p.userId, name: p.name, color: p.color,
      isHost: p.isHost, score: gs.scores?.[p.userId] || 0,
    })),
  };
}

async function pushToAll(players, sid, gs, maxPoints) {
  await Promise.all(players.map(p =>
    publish(sessionChannel(sid), 'game-state', {
      targetUserId: p.userId,
      state: playerView(gs, p.userId, players, maxPoints),
    })
  ));
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const sid = req.query.id || req.url.replace(/^\/api\/game\//, '').split('?')[0];
  const body = await parseBody(req);
  const { action } = body;

  try {
    const r = await db.query('SELECT * FROM game_sessions WHERE id=$1', [sid]);
    if (!r.rows[0]) return err(res, 404, 'Sessie niet gevonden');

    const session = r.rows[0];
    let players = session.players || [];
    let gs = session.game_state;
    const isHostUser = session.host_id === user.id;
    const maxPoints = session.max_points || 7;

    if (action === 'start') {
      if (!isHostUser) return err(res, 403, 'Alleen de host kan starten');
      if (players.length < 2) return err(res, 400, 'Minimaal 2 spelers nodig');
      gs = startCAH({ ...session, players });
      gs.maxPoints = maxPoints;
      await db.query(
        "UPDATE game_sessions SET game_state=$1, status='playing', updated_at=NOW() WHERE id=$2",
        [JSON.stringify(gs), sid]
      );
      await pushToAll(players, sid, gs, maxPoints);
      return ok(res, { ok: true });
    }

    if (!gs) return err(res, 400, 'Spel nog niet gestart');

    if (action === 'submit') {
      const { card } = body;
      if (gs.phase !== 'playing') return err(res, 400, 'Verkeerde fase');
      if (user.id === gs.czar) return err(res, 400, 'Tsaar kan niet submitten');
      if (gs.submissions[user.id]) return err(res, 400, 'Al gespeeld');
      if (!gs.hands[user.id]?.includes(card)) return err(res, 400, 'Kaart niet in hand');
      gs.submissions[user.id] = card;
      gs.hands[user.id] = gs.hands[user.id].filter(c => c !== card);
      const nonCzar = players.filter(p => p.userId !== gs.czar);
      if (nonCzar.every(p => gs.submissions[p.userId])) gs.phase = 'judging';
      await db.query('UPDATE game_sessions SET game_state=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(gs), sid]);
      await pushToAll(players, sid, gs, maxPoints);
      return ok(res, { ok: true });
    }

    if (action === 'pick-winner') {
      if (gs.phase !== 'judging') return err(res, 400, 'Verkeerde fase');
      if (user.id !== gs.czar) return err(res, 403, 'Alleen de Tsaar');
      const { card } = body;
      const winnerId = Object.entries(gs.submissions).find(([, c]) => c === card)?.[0];
      if (!winnerId) return err(res, 400, 'Kaart niet gevonden');
      gs.scores[winnerId] = (gs.scores[winnerId] || 0) + 1;
      gs.lastWinner = winnerId;
      gs.lastWinningCard = card;
      gs.lastBlackCard = gs.currentBlack;
      gs.phase = 'scores';
      if (gs.scores[winnerId] >= maxPoints) gs.winner = winnerId;
      await db.query('UPDATE game_sessions SET game_state=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(gs), sid]);
      db.query('UPDATE user_stats SET czar_picks=czar_picks+1 WHERE user_id=$1', [user.id]).catch(() => {});
      db.query('UPDATE user_stats SET wins=wins+1, rounds_played=rounds_played+1 WHERE user_id=$1', [winnerId]).catch(() => {});
      players.filter(p => p.userId !== winnerId).forEach(p =>
        db.query('UPDATE user_stats SET rounds_played=rounds_played+1 WHERE user_id=$1', [p.userId]).catch(() => {})
      );
      await pushToAll(players, sid, gs, maxPoints);
      return ok(res, { ok: true });
    }

    if (action === 'next-round') {
      if (gs.phase !== 'scores') return err(res, 400, 'Verkeerde fase');
      if (!isHostUser) return err(res, 403, 'Alleen host');
      if (gs.winner) {
        gs = startCAH({ ...session, players });
        gs.maxPoints = maxPoints;
      } else {
        const playerIds = players.map(p => p.userId);
        playerIds.forEach(pid => {
          gs.hands[pid] = gs.hands[pid] || [];
          while (gs.hands[pid].length < 7 && gs.whiteDeck.length > 0) gs.hands[pid].push(gs.whiteDeck.shift());
        });
        gs.czarIndex = (gs.czarIndex + 1) % playerIds.length;
        gs.czar = playerIds[gs.czarIndex];
        gs.submissions = {};
        gs.currentBlack = gs.blackDeck.shift() || BLACK_CARDS[Math.floor(Math.random() * BLACK_CARDS.length)];
        gs.phase = 'playing';
        gs.round++;
        gs.lastWinner = null;
        gs.lastWinningCard = null;
      }
      await db.query('UPDATE game_sessions SET game_state=$1, updated_at=NOW() WHERE id=$2', [JSON.stringify(gs), sid]);
      await pushToAll(players, sid, gs, maxPoints);
      return ok(res, { ok: true });
    }

    return err(res, 400, 'Onbekende actie: ' + action);
  } catch (e) {
    console.error('[game/id]', e.message);
    return err(res, 500, e.message);
  }
};

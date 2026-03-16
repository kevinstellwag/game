const { db, verifyToken, publish, sessionChannel, userChannel, parseBody, ok, err, cors } = require('../_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const sid = req.query.id || req.url.replace(/^\/api\/session\//, '').split('?')[0];

  try {
    const r = await db.query('SELECT * FROM game_sessions WHERE id=$1', [sid]);
    if (!r.rows[0]) return err(res, 404, 'Sessie niet gevonden');
    const session = r.rows[0];
    let players = session.players || [];

    if (req.method === 'GET') {
      return ok(res, {
        sessionId: sid,
        status: session.status,
        isHost: session.host_id === user.id,
        isInSession: players.some(p => p.userId === user.id),
        players,
        settings: {
          maxPoints: session.max_points,
          customBlack: session.custom_black || [],
          customWhite: session.custom_white || [],
        },
        gameState: session.game_state,
      });
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      const { action } = body;

      if (action === 'join') {
        if (session.status === 'playing' && !players.some(p => p.userId === user.id))
          return err(res, 400, 'Spel is al bezig');

        if (!players.some(p => p.userId === user.id)) {
          const newPlayer = { userId: user.id, name: user.username, color: user.color, isHost: false, score: 0 };
          players = [...players, newPlayer];
          await db.query(
            'UPDATE game_sessions SET players=$1, updated_at=NOW() WHERE id=$2',
            [JSON.stringify(players), sid]
          );
          publish(sessionChannel(sid), 'player-joined', { player: newPlayer, players });
        }

        return ok(res, {
          sessionId: sid,
          isHost: session.host_id === user.id,
          players,
          settings: {
            maxPoints: session.max_points,
            customBlack: session.custom_black || [],
            customWhite: session.custom_white || [],
          },
          gameState: session.game_state,
        });
      }

      if (action === 'leave') {
        players = players.filter(p => p.userId !== user.id);
        if (players.length === 0) {
          await db.query('DELETE FROM game_sessions WHERE id=$1', [sid]);
          return ok(res, { ok: true });
        }
        let newHostId = session.host_id;
        if (session.host_id === user.id) {
          players[0].isHost = true;
          newHostId = players[0].userId;
        }
        await db.query(
          'UPDATE game_sessions SET players=$1, host_id=$2, updated_at=NOW() WHERE id=$3',
          [JSON.stringify(players), newHostId, sid]
        );
        publish(sessionChannel(sid), 'player-left', { userId: user.id, name: user.username, newHostId, players });
        return ok(res, { ok: true });
      }

      if (action === 'invite') {
        const friendId = body.friendId || body.userId;
        if (!friendId) return err(res, 400, 'friendId verplicht');
        publish(userChannel(friendId), 'game-invite', {
          from: { id: user.id, username: user.username, color: user.color },
          sessionId: sid,
        });
        return ok(res, { ok: true });
      }

      if (action === 'settings') {
        if (session.host_id !== user.id) return err(res, 403, 'Alleen de host kan dit');
        const { maxPoints, customBlack, customWhite } = body;
        await db.query(
          `UPDATE game_sessions SET
            max_points=COALESCE($1, max_points),
            custom_black=COALESCE($2, custom_black),
            custom_white=COALESCE($3, custom_white),
            updated_at=NOW()
           WHERE id=$4`,
          [maxPoints || null, customBlack ? JSON.stringify(customBlack) : null, customWhite ? JSON.stringify(customWhite) : null, sid]
        );
        const newSettings = {
          maxPoints: maxPoints || session.max_points,
          customBlack: customBlack || session.custom_black || [],
          customWhite: customWhite || session.custom_white || [],
        };
        publish(sessionChannel(sid), 'settings-update', newSettings);
        return ok(res, newSettings);
      }

      return err(res, 400, 'Onbekende actie: ' + action);
    }

    return err(res, 405, 'Method not allowed');
  } catch (e) {
    console.error('[session/id]', e.message);
    return err(res, 500, e.message);
  }
};

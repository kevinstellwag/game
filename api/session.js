const { db, verifyToken, parseBody, ok, err, cors } = require('./_lib');

function genId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const { maxPoints = 7, customBlack = [], customWhite = [] } = await parseBody(req);

  try {
    await db.query("DELETE FROM game_sessions WHERE updated_at < NOW() - INTERVAL '3 hours'").catch(() => {});

    let id;
    let tries = 0;
    do {
      id = genId();
      const existing = await db.query('SELECT id FROM game_sessions WHERE id=$1', [id]);
      if (!existing.rows.length) break;
    } while (++tries < 10);

    const hostPlayer = { userId: user.id, name: user.username, color: user.color, isHost: true, score: 0 };

    await db.query(
      'INSERT INTO game_sessions (id,host_id,status,max_points,custom_black,custom_white,players) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, user.id, 'lobby', maxPoints, JSON.stringify(customBlack), JSON.stringify(customWhite), JSON.stringify([hostPlayer])]
    );

    ok(res, {
      sessionId: id,
      isHost: true,
      players: [hostPlayer],
      settings: { maxPoints, customBlack, customWhite },
    });
  } catch (e) {
    console.error('[session POST]', e.message);
    err(res, 500, 'Serverfout');
  }
};

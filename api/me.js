const { db, verifyToken, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  try {
    const r = await db.query(`
      SELECT u.id, u.username, u.avatar_color AS color, u.created_at,
        s.wins, s.rounds_played, s.czar_picks, s.best_streak
      FROM users u
      LEFT JOIN user_stats s ON s.user_id=u.id
      WHERE u.id=$1
    `, [user.id]);
    ok(res, r.rows[0] || user);
  } catch (e) {
    err(res, 500, e.message);
  }
};

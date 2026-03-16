const { db, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const r = await db.query(`
      SELECT u.id, u.username, u.avatar_color AS color,
        s.wins, s.rounds_played, s.czar_picks, s.best_streak
      FROM users u
      JOIN user_stats s ON s.user_id=u.id
      ORDER BY s.wins DESC, s.czar_picks DESC
      LIMIT 20
    `);
    ok(res, r.rows);
  } catch (e) {
    ok(res, []);
  }
};

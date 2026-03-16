const { db, initDB, hashPw, signToken, ok, err, cors, randomColor } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const { username, password, avatarColor } = req.body || {};
  if (!username?.trim() || !password)
    return err(res, 400, 'Vul je naam en wachtwoord in');

  const name = username.trim();
  if (name.length < 2 || name.length > 20)
    return err(res, 400, 'Naam moet 2-20 tekens zijn');
  if (password.length < 4)
    return err(res, 400, 'Wachtwoord minimaal 4 tekens');

  try {
    await initDB();
    const exists = await db.query(
      'SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [name]
    );
    if (exists.rows.length) return err(res, 409, 'Naam al in gebruik');

    const hash = await hashPw(password);
    const r = await db.query(
      'INSERT INTO users (username,password_hash,avatar_color) VALUES ($1,$2,$3) RETURNING id,username,avatar_color',
      [name, hash, avatarColor || randomColor()]
    );
    await db.query('INSERT INTO user_stats (user_id) VALUES ($1)', [r.rows[0].id]);
    const u = r.rows[0];
    const token = signToken(u);
    ok(res, { token, user: { id: u.id, username: u.username, color: u.avatar_color } });
  } catch (e) {
    console.error('[register]', e.message);
    err(res, 500, 'Serverfout');
  }
};

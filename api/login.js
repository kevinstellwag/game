const { db, hashPw, signToken, parseBody, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const { username, password } = await parseBody(req);
  if (!username || !password) return err(res, 400, 'Vul je naam en wachtwoord in');

  try {
    const r = await db.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!r.rows[0]) return err(res, 401, 'Gebruiker niet gevonden');
    const u = r.rows[0];
    const inputHash = await hashPw(password);
    if (inputHash !== u.password_hash) return err(res, 401, 'Verkeerd wachtwoord');
    await db.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]);
    ok(res, { token: signToken(u), user: { id: u.id, username: u.username, color: u.avatar_color } });
  } catch (e) {
    console.error('[login]', e.message);
    err(res, 500, 'Serverfout');
  }
};

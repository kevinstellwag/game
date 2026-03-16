const { db, verifyToken, push, userChannel, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  // GET — list friends
  if (req.method === 'GET') {
    try {
      const r = await db.query(`
        SELECT
          u.id, u.username, u.avatar_color AS color,
          f.status, f.id AS friendship_id,
          CASE WHEN f.requester_id=$1 THEN 'sent' ELSE 'received' END AS direction
        FROM friendships f
        JOIN users u ON u.id = CASE WHEN f.requester_id=$1
          THEN f.addressee_id ELSE f.requester_id END
        WHERE f.requester_id=$1 OR f.addressee_id=$1
        ORDER BY
          CASE WHEN f.status='accepted' THEN 1
               WHEN f.status='pending'  THEN 2 ELSE 3 END,
          u.username
      `, [user.id]);
      return ok(res, r.rows);
    } catch (e) {
      return err(res, 500, e.message);
    }
  }

  // POST — send friend request
  if (req.method === 'POST') {
    const { username } = req.body || {};
    if (!username?.trim()) return err(res, 400, 'Gebruikersnaam verplicht');

    try {
      const target = await db.query(
        'SELECT id, username, avatar_color FROM users WHERE LOWER(username)=LOWER($1) AND id!=$2',
        [username.trim(), user.id]
      );
      if (!target.rows[0]) return err(res, 404, 'Gebruiker niet gevonden');
      const t = target.rows[0];

      const existing = await db.query(
        `SELECT id, status, requester_id FROM friendships
         WHERE (requester_id=$1 AND addressee_id=$2)
            OR (requester_id=$2 AND addressee_id=$1)`,
        [user.id, t.id]
      );

      if (existing.rows[0]) {
        const f = existing.rows[0];
        if (f.status === 'accepted')
          return err(res, 409, 'Jullie zijn al vrienden!');
        // They sent us a request → auto-accept
        if (f.status === 'pending' && f.requester_id === t.id) {
          await db.query('UPDATE friendships SET status=$1 WHERE id=$2',
            ['accepted', f.id]);
          await push(userChannel(t.id), 'friend-accepted', {
            user: { id: user.id, username: user.username, color: user.color }
          });
          return ok(res, {
            status: 'accepted',
            user: { id: t.id, username: t.username, color: t.avatar_color }
          });
        }
        return err(res, 409, 'Vriendschapsverzoek al verstuurd');
      }

      await db.query(
        'INSERT INTO friendships (requester_id,addressee_id) VALUES ($1,$2)',
        [user.id, t.id]
      );
      await push(userChannel(t.id), 'friend-request', {
        from: { id: user.id, username: user.username, color: user.color }
      });
      return ok(res, {
        status: 'pending',
        user: { id: t.id, username: t.username, color: t.avatar_color }
      });
    } catch (e) {
      return err(res, 500, e.message);
    }
  }

  err(res, 405, 'Method not allowed');
};

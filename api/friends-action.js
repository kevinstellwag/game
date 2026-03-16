const { db, verifyToken, publish, userChannel, parseBody, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const body = await parseBody(req);
  const { action, friendshipId } = body;

  try {
    if (action === 'accept') {
      const r = await db.query(
        "UPDATE friendships SET status='accepted' WHERE id=$1 AND addressee_id=$2 AND status='pending' RETURNING requester_id",
        [friendshipId, user.id]
      );
      if (r.rows[0]) {
        publish(userChannel(r.rows[0].requester_id), 'friend-accepted', {
          user: { id: user.id, username: user.username, color: user.color }
        });
      }
      return ok(res, { ok: true });
    }
    if (action === 'decline') {
      await db.query('DELETE FROM friendships WHERE id=$1 AND (requester_id=$2 OR addressee_id=$2)', [friendshipId, user.id]);
      return ok(res, { ok: true });
    }
    if (action === 'remove') {
      await db.query(
        'DELETE FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)',
        [user.id, body.userId]
      );
      return ok(res, { ok: true });
    }
    err(res, 400, 'Onbekende actie');
  } catch (e) { err(res, 500, e.message); }
};

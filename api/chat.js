const { db, verifyToken, push, sessionChannel, ok, err, cors } = require('./_lib');
const { v4: uuidv4 } = require('uuid');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const { sessionId, text } = req.body || {};
  if (!sessionId || !text?.trim()) return err(res, 400, 'sessionId en text verplicht');

  try {
    // Verify user is in this session
    const r = await db.query(
      "SELECT players FROM game_sessions WHERE id=$1", [sessionId]
    );
    if (!r.rows[0]) return err(res, 404, 'Sessie niet gevonden');

    const players = r.rows[0].players || [];
    if (!players.some(p => p.userId === user.id))
      return err(res, 403, 'Je bent geen deelnemer van dit spel');

    const msg = {
      id: uuidv4(),
      playerId: user.id,
      playerName: user.username,
      playerColor: user.color,
      text: text.slice(0, 200),
      time: Date.now(),
    };

    await push(sessionChannel(sessionId), 'chat-msg', { message: msg });
    ok(res, { ok: true });
  } catch (e) {
    err(res, 500, e.message);
  }
};

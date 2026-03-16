const { pusher, verifyToken, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return err(res, 405, 'Method not allowed');

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  const { socket_id, channel_name } = req.body || {};
  if (!socket_id || !channel_name)
    return err(res, 400, 'socket_id en channel_name verplicht');

  try {
    // Presence channel → include user info
    if (channel_name.startsWith('presence-')) {
      const presenceData = {
        user_id: user.id,
        user_info: {
          username: user.username,
          color: user.color,
        },
      };
      const auth = pusher.authorizeChannel(socket_id, channel_name, presenceData);
      return res.status(200).json(auth);
    }

    // Private channel → just authenticate
    if (channel_name.startsWith('private-')) {
      // Only allow user to auth their own private channel
      const expectedChannel = `private-user-${user.id}`;
      if (channel_name !== expectedChannel)
        return err(res, 403, 'Geen toegang tot dit kanaal');

      const auth = pusher.authorizeChannel(socket_id, channel_name);
      return res.status(200).json(auth);
    }

    err(res, 403, 'Kanaal niet toegestaan');
  } catch (e) {
    console.error('[pusher-auth]', e.message);
    err(res, 500, 'Auth mislukt');
  }
};

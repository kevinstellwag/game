const Ably = require('ably');
const { verifyToken, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  try {
    const ably = new Ably.Rest(process.env.ABLY_API_KEY);
    const tokenParams = {
      clientId: user.id,
      capability: {
        [`user-${user.id}`]: ['subscribe', 'publish'],
        'session-*': ['subscribe', 'publish'],
      },
    };
    const tokenRequest = await ably.auth.createTokenRequest(tokenParams);
    ok(res, tokenRequest);
  } catch (e) {
    console.error('[ably-token]', e.message);
    err(res, 500, 'Token aanmaken mislukt');
  }
};

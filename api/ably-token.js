const Ably = require('ably');
const { verifyToken, ok, err, cors } = require('./_lib');

module.exports = async (req, res) => {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const user = verifyToken(req);
  if (!user) return err(res, 401, 'Niet ingelogd');

  try {
    const ably = new Ably.Rest({ key: process.env.ABLY_API_KEY });

    // createTokenRequest with callback-style wrapped in Promise
    const tokenRequest = await new Promise((resolve, reject) => {
      ably.auth.createTokenRequest(
        {
          clientId: user.id,
          capability: {
            [`user-${user.id}`]: ['subscribe', 'publish'],
            'session-*': ['subscribe', 'publish'],
          },
        },
        null,
        (err, tokenRequest) => {
          if (err) reject(err);
          else resolve(tokenRequest);
        }
      );
    });

    ok(res, tokenRequest);
  } catch (e) {
    console.error('[ably-token]', e.message);
    err(res, 500, 'Token aanmaken mislukt: ' + e.message);
  }
};

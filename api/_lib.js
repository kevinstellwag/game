// api/_lib.js  — shared helpers (DB, auth, Pusher)
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const Pusher = require('pusher');

// ── Database ──────────────────────────────────────────────
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,                 // serverless: keep pool tiny
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 5000,
});

async function initDB() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT DEFAULT '#4d96ff',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_seen TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS user_stats (
      user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      wins INT DEFAULT 0,
      rounds_played INT DEFAULT 0,
      czar_picks INT DEFAULT 0,
      best_streak INT DEFAULT 0,
      current_streak INT DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS friendships (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      requester_id UUID REFERENCES users(id) ON DELETE CASCADE,
      addressee_id UUID REFERENCES users(id) ON DELETE CASCADE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(requester_id, addressee_id)
    );
    CREATE TABLE IF NOT EXISTS game_sessions (
      id TEXT PRIMARY KEY,
      host_id UUID REFERENCES users(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'lobby',
      max_points INT DEFAULT 7,
      custom_black JSONB DEFAULT '[]',
      custom_white JSONB DEFAULT '[]',
      game_state JSONB DEFAULT NULL,
      players JSONB DEFAULT '[]',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_friendships_users
      ON friendships(requester_id, addressee_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_updated
      ON game_sessions(updated_at);
  `);
}

// ── Password ──────────────────────────────────────────────
function hashPw(pw) {
  return new Promise((res, rej) =>
    crypto.scrypt(pw, 'cah_salt_v3', 64,
      (e, k) => e ? rej(e) : res(k.toString('hex')))
  );
}

// ── JWT ───────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'cah_dev_secret';

function signToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, color: user.avatar_color || user.color },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
}

function verifyToken(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ── Pusher ────────────────────────────────────────────────
const pusher = new Pusher({
  appId:   process.env.PUSHER_APP_ID,
  key:     process.env.PUSHER_KEY,
  secret:  process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER || 'eu',
  useTLS:  true,
});

// Pusher channel helpers
// private-user-{userId}   → personal notifications
// presence-session-{sid}  → game session (presence channel)
function userChannel(userId)    { return `private-user-${userId}`; }
function sessionChannel(sid)    { return `presence-session-${sid}`; }

async function push(channel, event, data) {
  try { await pusher.trigger(channel, event, data); }
  catch (e) { console.error('[Pusher]', e.message); }
}

// ── CORS helper ───────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

// ── Standard JSON response ────────────────────────────────
function ok(res, data)        { cors(res); res.status(200).json(data); }
function err(res, code, msg)  { cors(res); res.status(code).json({ error: msg }); }

// ── CAH card decks ────────────────────────────────────────
const BLACK_CARDS = [
  "Waarom kan ik niet slapen 's nachts? ___",
  "Het ergste dat je bij een begrafenis kunt zeggen is ___",
  "Ik heb 99 problemen maar ___ is er geen.",
  "Misschien is ze ermee geboren. Misschien is het ___",
  "Thomas' Tinder-bio zegt: ___",
  "Jossa's zoekgeschiedenis om 3 uur 's nachts: ___",
  "Kevin werd gearresteerd vanwege ___",
  "Lucas fluisterde: ___",
  "Dani's nachtmerrie begint met ___",
  "Milan postte per ongeluk ___ op de groepsapp.",
  "Roman's kelder ruikt naar ___",
  "Stef schreeuwde midden in de nacht: ___",
  "Jop's reactie na de ruzie: ___",
  "Wat vond de politie in Thomas' vriezer?",
  "Waarom blokkeerde Jossa al zijn contacten?",
  "Kevin's bucketlist bevat alleen ___",
  "Lucas claimt dat ___ de economie verpest.",
  "Roman's therapeut zei: stop met ___",
  "Stef's nieuwe tattoo: ___",
  "Jop werd gecanceld vanwege ___",
  "Wat is het geluid dat Thomas het meest haat?",
  "Waarom huilt Kevin bij het zien van ___?",
  "Jossa's droombaan: ___ schreeuwen in een kantoor.",
  "Dani fluisterde tijdens het spel: ___",
  "Milan's oma zei: pas op voor ___",
  "Roman's ringtone: ___",
  "Stef's excuus: 'Het was maar een ___'",
  "Thomas' bumpersticker: ___",
  "Kevin googelde: 'hoe overleef ik ___?'",
  "Jossa's playlist heet: ___",
  "Lucas' nachtkastje bevat: ___",
  "Milan fluisterde: 'Ik haat ___'",
  "Dimma zet ___ op een timer",
  "Hurmple wilt altijd ___",
  "Thomas' lelijke corsa rijdt vol met ___",
  "Kevin's favoriete grap gaat over ___",
  "Jop is altijd bang voor ___ maar doet alsof",
  "Stef denkt dat zijn IQ 130 is maar eigenlijk ___",
  "Roman is bang voor ___ en liegt erover",
  "Milan ___",
  "Wat schreeuwde Jossa bij de bushalte? ___",
  "Kevin's beats klinken als ___",
  "Lucas' geheim: hij houdt eigenlijk heel erg van ___",
  "Wat vond iedereen in Stef's browser? ___",
  "Roman's bi-moment: ___",
  "Dani's leven zonder ___",
  "Jop pijpt ___ in zijn vrije tijd",
  "Wat doet Milan als niemand kijkt? ___",
  "Thomas' stanky legs ruiken naar ___",
  "Stef's lange nek: ___",
];

const WHITE_CARDS = [
  "jonko klappe", "el torro", "nino baars", "ouwe kanker gek",
  "hou je kankerbek", "lekker pik", "lucas is gay",
  "thomas met zn stanky legs", "dani slaat vrouwen", "ja",
  "kaas", "neppe marokkaan", "cartier planga", "Jeffrey Epstein",
  "Hentai", "hurmple zegt alleen ja", "lucas gay gooner",
  "kevin noob", "jop", "stef", "roman", "milan", "dimma", "hurmple",
  "Dani's Voorhuid", "batsen", "Schaamhaar", "Bestef je die?",
  "kanker dimma", "kanker hurmple", "grasspriet",
  "jop is bang voor nino baars", "jop pijpt rens", "kanker lange nek",
  "stef kanker dom", "Taliyah", "Lotte", "Anne", "assie",
  "zet het op een timer", "rob jetten", "napoleon bonaparte",
  "goonen", "1 procent batterij", "een kale band om 2 uur",
  "vergeten te antwoorden", "3 dagen op dezelfde broek",
  "snap de grap niet maar lachen", "te laat omdat je lag te goonen",
  "jezelf betrappen op een cringe foto van 2019",
  "een app-groep met je ex erin", "bellen in plaats van appen",
  "een tikkie sturen voor 73 cent", "openbare wifi wachtwoord vragen",
  "in een voicemail praten als een boomer",
  "je eigen geuren niet ruiken", "hardop lachen om je eigen grap",
  "screenshots doorsturen naar de verkeerde persoon",
  "'k ga zo' en dan 3 uur later", "een meme uitleggen",
  "stiekem tevreden als iemand het slechter doet",
  "doen alsof je de film kent", "een volle koelkast maar geen eten",
];

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

const COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94',
                '#B4F8C8','#A0C4FF','#FFADAD','#C77DFF','#80FFDB'];
function randomColor() { return COLORS[Math.floor(Math.random() * COLORS.length)]; }

module.exports = {
  db, initDB, hashPw, signToken, verifyToken,
  pusher, push, userChannel, sessionChannel,
  cors, ok, err,
  BLACK_CARDS, WHITE_CARDS, shuffle, COLORS, randomColor,
};

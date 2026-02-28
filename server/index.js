const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || 'partygames_secret_2024';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'kevin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';

function hashPw(pw) {
  return new Promise((res, rej) =>
    crypto.scrypt(pw, 'pg_salt_2024', 64, (e, k) => e ? rej(e) : res(k.toString('hex')))
  );
}

const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('[DB] No DATABASE_URL'); return; }
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        color TEXT DEFAULT '#4d96ff', is_admin BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(), last_seen TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS user_stats (
        user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        cah_wins INT DEFAULT 0, cah_losses INT DEFAULT 0, cah_rounds INT DEFAULT 0,
        czar_picks INT DEFAULT 0, cah_best_streak INT DEFAULT 0, cah_current_streak INT DEFAULT 0,
        mono_props_bought INT DEFAULT 0, mono_jail_visits INT DEFAULT 0,
        mono_money_earned BIGINT DEFAULT 0, max_players_in_game INT DEFAULT 0,
        played_at_midnight BOOLEAN DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS achievements (
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        achievement_id TEXT NOT NULL, unlocked_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, achievement_id)
      );
      CREATE TABLE IF NOT EXISTS friendships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        requester_id UUID REFERENCES users(id) ON DELETE CASCADE,
        addressee_id UUID REFERENCES users(id) ON DELETE CASCADE,
        status TEXT DEFAULT 'pending', created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(requester_id, addressee_id)
      );
      CREATE TABLE IF NOT EXISTS groups_table (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL, color TEXT DEFAULT '#4d96ff',
        owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
        invite_code TEXT UNIQUE NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS group_members (
        group_id UUID REFERENCES groups_table(id) ON DELETE CASCADE,
        user_id UUID REFERENCES users(id) ON DELETE CASCADE,
        joined_at TIMESTAMPTZ DEFAULT NOW(), PRIMARY KEY (group_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        channel TEXT NOT NULL, sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
        sender_name TEXT NOT NULL, sender_color TEXT DEFAULT '#4d96ff',
        content TEXT NOT NULL, msg_type TEXT DEFAULT 'text',
        metadata JSONB DEFAULT '{}', created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, created_at ASC);
      CREATE INDEX IF NOT EXISTS idx_friendships_users ON friendships(requester_id, addressee_id);
    `);

    // Always sync admin account
    const adminHash = await hashPw(ADMIN_PASSWORD);
    const adminCheck = await db.query('SELECT id FROM users WHERE username=$1', [ADMIN_USERNAME]);
    if (!adminCheck.rows.length) {
      const r = await db.query(
        'INSERT INTO users (username,password_hash,color,is_admin) VALUES ($1,$2,$3,TRUE) RETURNING id',
        [ADMIN_USERNAME, adminHash, '#ff6b6b']
      );
      await db.query('INSERT INTO user_stats (user_id) VALUES ($1)', [r.rows[0].id]);
      console.log('[DB] Admin created:', ADMIN_USERNAME);
    } else {
      await db.query('UPDATE users SET password_hash=$1, is_admin=TRUE WHERE username=$2', [adminHash, ADMIN_USERNAME]);
      console.log('[DB] Admin synced:', ADMIN_USERNAME);
    }
    console.log('[DB] Ready');
  } catch (e) {
    console.error('[DB] Init error:', e.message);
  }
}
initDB();

// ===== MIDDLEWARE =====
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Niet ingelogd' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sessie verlopen' });
  }
}

function adminAuth(req, res, next) {
  auth(req, res, () => {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Geen toegang' });
    next();
  });
}

// ===== AUTH ROUTES =====
app.post('/api/register', async (req, res) => {
  const { username, password, color } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Vul alles in' });
  if (username.length < 2 || username.length > 20) return res.status(400).json({ error: 'Naam: 2-20 tekens' });
  if (password.length < 4) return res.status(400).json({ error: 'Wachtwoord: minimaal 4 tekens' });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database niet beschikbaar' });
  try {
    const exists = await db.query('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (exists.rows.length) return res.status(409).json({ error: 'Naam al in gebruik' });
    const hash = await hashPw(password);
    const r = await db.query(
      'INSERT INTO users (username,password_hash,color) VALUES ($1,$2,$3) RETURNING id,username,color,is_admin',
      [username.trim(), hash, color || '#4d96ff']
    );
    await db.query('INSERT INTO user_stats (user_id) VALUES ($1)', [r.rows[0].id]);
    const u = r.rows[0];
    const token = jwt.sign(
      { id: u.id, username: u.username, color: u.color, isAdmin: u.is_admin },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: u.id, username: u.username, color: u.color, isAdmin: u.is_admin } });
  } catch (e) {
    console.error('[register]', e.message);
    res.status(500).json({ error: 'Server fout' });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Vul alles in' });
  if (!process.env.DATABASE_URL) return res.status(503).json({ error: 'Database niet beschikbaar' });
  try {
    const r = await db.query('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [username]);
    if (!r.rows[0]) return res.status(401).json({ error: 'Gebruiker niet gevonden' });
    const u = r.rows[0];
    const inputHash = await hashPw(password);
    if (inputHash !== u.password_hash) return res.status(401).json({ error: 'Verkeerd wachtwoord' });
    await db.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]);
    const token = jwt.sign(
      { id: u.id, username: u.username, color: u.color, isAdmin: u.is_admin },
      JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ token, user: { id: u.id, username: u.username, color: u.color, isAdmin: u.is_admin } });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Server fout' });
  }
});

app.get('/api/me', auth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.username, u.color, u.is_admin, u.created_at,
        s.cah_wins, s.cah_losses, s.cah_rounds, s.czar_picks, s.cah_best_streak,
        s.mono_props_bought, s.mono_money_earned,
        (s.cah_wins*3 + s.czar_picks + s.mono_money_earned/1000) AS total_score,
        COALESCE(json_agg(a.achievement_id) FILTER (WHERE a.achievement_id IS NOT NULL), '[]') AS achievements
      FROM users u
      LEFT JOIN user_stats s ON s.user_id = u.id
      LEFT JOIN achievements a ON a.user_id = u.id
      WHERE u.id = $1
      GROUP BY u.id, s.user_id, s.cah_wins, s.cah_losses, s.cah_rounds, s.czar_picks,
               s.cah_best_streak, s.mono_props_bought, s.mono_money_earned,
               s.max_players_in_game, s.played_at_midnight
    `, [req.user.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Niet gevonden' });
    res.json(r.rows[0]);
  } catch (e) {
    console.error('[me]', e.message);
    res.status(500).json({ error: 'Server fout' });
  }
});

// ===== FRIENDS =====
app.get('/api/friends', auth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.username, u.color, f.status,
        CASE WHEN f.requester_id=$1 THEN 'sent' ELSE 'received' END AS direction
      FROM friendships f
      JOIN users u ON u.id = CASE WHEN f.requester_id=$1 THEN f.addressee_id ELSE f.requester_id END
      WHERE f.requester_id=$1 OR f.addressee_id=$1
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/friends/add', auth, async (req, res) => {
  const { username } = req.body || {};
  if (!username) return res.status(400).json({ error: 'Gebruikersnaam verplicht' });
  try {
    const target = await db.query(
      'SELECT id, username, color FROM users WHERE LOWER(username)=LOWER($1) AND id!=$2',
      [username, req.user.id]
    );
    if (!target.rows[0]) return res.status(404).json({ error: 'Gebruiker niet gevonden' });
    const t = target.rows[0];
    const existing = await db.query(
      'SELECT id, status, requester_id FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)',
      [req.user.id, t.id]
    );
    if (existing.rows[0]) {
      if (existing.rows[0].status === 'accepted') return res.status(409).json({ error: 'Al bevriend' });
      if (existing.rows[0].status === 'pending' && existing.rows[0].requester_id !== req.user.id) {
        await db.query('UPDATE friendships SET status=$1 WHERE id=$2', ['accepted', existing.rows[0].id]);
        broadcastToUser(t.id, { type: 'FRIEND_ACCEPTED', user: { id: req.user.id, username: req.user.username, color: req.user.color } });
        return res.json({ status: 'accepted', user: t });
      }
      return res.status(409).json({ error: 'Verzoek al verzonden' });
    }
    await db.query('INSERT INTO friendships (requester_id,addressee_id) VALUES ($1,$2)', [req.user.id, t.id]);
    broadcastToUser(t.id, { type: 'FRIEND_REQUEST', from: { id: req.user.id, username: req.user.username, color: req.user.color } });
    res.json({ status: 'pending', user: t });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/friends/accept', auth, async (req, res) => {
  const { userId } = req.body || {};
  try {
    await db.query(
      'UPDATE friendships SET status=$1 WHERE requester_id=$2 AND addressee_id=$3 AND status=$4',
      ['accepted', userId, req.user.id, 'pending']
    );
    broadcastToUser(userId, { type: 'FRIEND_ACCEPTED', user: { id: req.user.id, username: req.user.username, color: req.user.color } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/friends/:userId', auth, async (req, res) => {
  try {
    await db.query(
      'DELETE FROM friendships WHERE (requester_id=$1 AND addressee_id=$2) OR (requester_id=$2 AND addressee_id=$1)',
      [req.user.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== GROUPS =====
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

app.post('/api/groups', auth, async (req, res) => {
  const { name, color } = req.body || {};
  if (!name?.trim()) return res.status(400).json({ error: 'Naam verplicht' });
  try {
    let code;
    do {
      code = genCode();
    } while ((await db.query('SELECT id FROM groups_table WHERE invite_code=$1', [code])).rows.length);
    const r = await db.query(
      'INSERT INTO groups_table (name,color,owner_id,invite_code) VALUES ($1,$2,$3,$4) RETURNING *',
      [name.trim().slice(0, 40), color || '#4d96ff', req.user.id, code]
    );
    await db.query('INSERT INTO group_members (group_id,user_id) VALUES ($1,$2)', [r.rows[0].id, req.user.id]);
    res.json(r.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/groups', auth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT g.*, u.username AS owner_name, COUNT(gm.user_id)::int AS member_count
      FROM groups_table g
      JOIN users u ON u.id = g.owner_id
      JOIN group_members gm ON gm.group_id = g.id
      WHERE g.id IN (SELECT group_id FROM group_members WHERE user_id=$1)
      GROUP BY g.id, u.username
      ORDER BY g.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/groups/join', auth, async (req, res) => {
  const { inviteCode } = req.body || {};
  if (!inviteCode) return res.status(400).json({ error: 'Code verplicht' });
  try {
    const g = await db.query('SELECT * FROM groups_table WHERE invite_code=UPPER($1)', [inviteCode]);
    if (!g.rows[0]) return res.status(404).json({ error: 'Groep niet gevonden' });
    await db.query(
      'INSERT INTO group_members (group_id,user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [g.rows[0].id, req.user.id]
    );
    res.json(g.rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/groups/:id/members', auth, async (req, res) => {
  try {
    const r = await db.query(
      'SELECT u.id, u.username, u.color FROM group_members gm JOIN users u ON u.id=gm.user_id WHERE gm.group_id=$1 ORDER BY gm.joined_at',
      [req.params.id]
    );
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== LEADERBOARD =====
app.get('/api/leaderboard', async (req, res) => {
  if (!process.env.DATABASE_URL) return res.json([]);
  try {
    const r = await db.query(`
      SELECT u.id, u.username, u.color, s.cah_wins, s.czar_picks, s.cah_rounds,
        s.mono_money_earned, s.cah_best_streak,
        (s.cah_wins*3 + s.czar_picks + s.mono_money_earned/1000) AS total_score,
        COUNT(DISTINCT a.achievement_id)::int AS achievement_count
      FROM users u
      JOIN user_stats s ON s.user_id = u.id
      LEFT JOIN achievements a ON a.user_id = u.id
      WHERE u.is_admin = FALSE
      GROUP BY u.id, s.user_id, s.cah_wins, s.czar_picks, s.cah_rounds, s.mono_money_earned, s.cah_best_streak
      ORDER BY total_score DESC LIMIT 25
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json([]);
  }
});

// ===== ADMIN =====
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  try {
    const [u, g, m, r] = await Promise.all([
      db.query("SELECT COUNT(*)::int c FROM users WHERE is_admin=FALSE"),
      db.query("SELECT COUNT(*)::int c FROM groups_table"),
      db.query("SELECT COUNT(*)::int c FROM messages"),
      db.query("SELECT COUNT(*)::int c FROM users WHERE last_seen > NOW()-INTERVAL '24 hours'"),
    ]);
    res.json({
      users: u.rows[0].c,
      groups: g.rows[0].c,
      messages: m.rows[0].c,
      activeToday: r.rows[0].c,
      onlineNow: onlineUsers.size,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/users', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT u.id, u.username, u.color, u.is_admin, u.created_at, u.last_seen,
        s.cah_wins, s.cah_rounds,
        (s.cah_wins*3 + s.czar_picks + s.mono_money_earned/1000) AS total_score
      FROM users u
      LEFT JOIN user_stats s ON s.user_id = u.id
      ORDER BY u.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/users/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM users WHERE id=$1 AND is_admin=FALSE', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/admin/reset-stats/:id', adminAuth, async (req, res) => {
  try {
    await db.query(`
      UPDATE user_stats SET
        cah_wins=0, cah_losses=0, cah_rounds=0, czar_picks=0,
        cah_best_streak=0, cah_current_streak=0,
        mono_props_bought=0, mono_jail_visits=0, mono_money_earned=0
      WHERE user_id=$1
    `, [req.params.id]);
    await db.query('DELETE FROM achievements WHERE user_id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/groups', adminAuth, async (req, res) => {
  try {
    const r = await db.query(`
      SELECT g.*, u.username AS owner_name, COUNT(gm.user_id)::int AS member_count
      FROM groups_table g
      JOIN users u ON u.id = g.owner_id
      JOIN group_members gm ON gm.group_id = g.id
      GROUP BY g.id, u.username
      ORDER BY g.created_at DESC
    `);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/groups/:id', adminAuth, async (req, res) => {
  try {
    await db.query('DELETE FROM groups_table WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ===== ONLINE TRACKING =====
const onlineUsers = new Map(); // userId -> Set<ws>

function broadcastToUser(userId, data) {
  const msg = JSON.stringify(data);
  (onlineUsers.get(userId) || new Set()).forEach(ws => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

function broadcastToChannel(channel, data) {
  const msg = JSON.stringify(data);
  for (const wsSet of onlineUsers.values()) {
    for (const ws of wsSet) {
      if (ws.readyState === 1 && ws._subs?.has(channel)) ws.send(msg);
    }
  }
}

// ===== GAME SESSIONS =====
const gameSessions = new Map(); // channel -> session

function roomState(code) {
  const session = gameSessions.get(code);
  if (!session) return { code, game: '?', phase: 'lobby', players: [], settings: {} };
  return {
    code: session.channel,
    game: session.game,
    phase: session.gameState?.phase || 'lobby',
    players: session.players.map(c => ({
      id: c.id, userId: c.userId, name: c.name,
      isHost: c.isHost, score: c.score || 0, color: c.color,
    })),
    settings: session.settings || {},
  };
}

function send(ws, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(data));
}

function bcast(room, data, skipId = null) {
  room.clients.forEach(c => {
    if (c.id !== skipId) send(c.ws, data);
  });
}

// ===== WEBSOCKET =====
setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 25000);

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws._userId = null;
  ws._user = null;
  ws._subs = new Set();
  ws._gameChannel = null;

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'PING') { ws.send(JSON.stringify({ type: 'PONG' })); return; }

    // AUTH
    if (msg.type === 'WS_AUTH') {
      try {
        const u = jwt.verify(msg.token, JWT_SECRET);
        ws._userId = u.id;
        ws._user = u;
        if (!onlineUsers.has(u.id)) onlineUsers.set(u.id, new Set());
        onlineUsers.get(u.id).add(ws);
        if (process.env.DATABASE_URL) {
          db.query('UPDATE users SET last_seen=NOW() WHERE id=$1', [u.id]).catch(() => {});
        }
        ws.send(JSON.stringify({ type: 'AUTH_OK', user: u, onlineIds: [...onlineUsers.keys()] }));
        broadcastToChannel('global', { type: 'USER_ONLINE', userId: u.id });
      } catch {
        ws.send(JSON.stringify({ type: 'AUTH_ERROR' }));
      }
      return;
    }

    if (!ws._userId) return;

    // SUBSCRIBE
    if (msg.type === 'SUB') {
      const ch = msg.channel;
      if (!ch) return;

      if (ch.startsWith('group:') && process.env.DATABASE_URL) {
        const ok = await db.query(
          'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
          [ch.replace('group:', ''), ws._userId]
        ).catch(() => ({ rows: [] }));
        if (!ok.rows.length) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Geen lid van deze groep' }));
          return;
        }
      }

      if (ch.startsWith('dm:')) {
        const ids = ch.replace('dm:', '').split(':');
        if (!ids.includes(ws._userId)) return;
      }

      ws._subs.add(ch);

      if (process.env.DATABASE_URL) {
        try {
          const msgs = await db.query(
            'SELECT * FROM messages WHERE channel=$1 ORDER BY created_at ASC LIMIT 100',
            [ch]
          );
          ws.send(JSON.stringify({ type: 'HISTORY', channel: ch, messages: msgs.rows }));
        } catch {}
      }

      // Send active game if any
      const gs = gameSessions.get(ch);
      if (gs) {
        ws.send(JSON.stringify({
          type: 'GAME_ACTIVE', channel: ch, game: gs.game,
          players: gs.players.map(p => ({ id: p.userId, name: p.name, color: p.color, isHost: p.isHost })),
        }));
      }
      return;
    }

    if (msg.type === 'UNSUB') { ws._subs.delete(msg.channel); return; }

    // CHAT MESSAGE
    if (msg.type === 'MSG') {
      const { channel, text } = msg;
      if (!text?.trim() || !channel) return;
      if (channel.startsWith('dm:') && !channel.includes(ws._userId)) return;
      if (channel.startsWith('group:') && process.env.DATABASE_URL) {
        const ok = await db.query(
          'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
          [channel.replace('group:', ''), ws._userId]
        ).catch(() => ({ rows: [] }));
        if (!ok.rows.length) return;
      }

      const m = {
        id: uuidv4(), channel,
        sender_id: ws._userId, sender_name: ws._user.username, sender_color: ws._user.color,
        content: text.slice(0, 500), msg_type: 'text', metadata: {},
        created_at: new Date().toISOString(),
      };

      if (process.env.DATABASE_URL) {
        db.query(
          'INSERT INTO messages (id,channel,sender_id,sender_name,sender_color,content) VALUES ($1,$2,$3,$4,$5,$6)',
          [m.id, m.channel, m.sender_id, m.sender_name, m.sender_color, m.content]
        ).catch(() => {});
      }

      broadcastToChannel(channel, { type: 'MSG', message: m });
      return;
    }

    // START GAME
    if (msg.type === 'START_GAME') {
      const { channel, game } = msg;
      if (!channel || !game) return;

      let memberIds = [];
      if (channel.startsWith('group:') && process.env.DATABASE_URL) {
        const ok = await db.query(
          'SELECT 1 FROM group_members WHERE group_id=$1 AND user_id=$2',
          [channel.replace('group:', ''), ws._userId]
        ).catch(() => ({ rows: [] }));
        if (!ok.rows.length) return;
        const members = await db.query(
          'SELECT user_id FROM group_members WHERE group_id=$1',
          [channel.replace('group:', '')]
        ).catch(() => ({ rows: [] }));
        memberIds = members.rows.map(r => r.user_id);
      } else if (channel.startsWith('dm:')) {
        memberIds = channel.replace('dm:', '').split(':');
        if (!memberIds.includes(ws._userId)) return;
      }

      const session = {
        game, channel, players: [], clients: null,
        gameState: null, settings: { maxPoints: 7 },
        chat: [], startedAt: Date.now(), allowedUserIds: memberIds,
      };
      session.clients = session.players;
      session.code = channel;
      gameSessions.set(channel, session);

      const host = {
        id: uuidv4(), userId: ws._userId, ws,
        name: ws._user.username, color: ws._user.color,
        isHost: true, score: 0,
      };
      session.players.push(host);
      ws._gameChannel = channel;

      const gameNames = { cah: 'Cards Against Humanity', poker: 'Poker', monopoly: 'Monopoly Straatvariant' };
      const gameIcons = { cah: '🃏', poker: '♠️', monopoly: '🏦' };

      const ann = {
        id: uuidv4(), channel, sender_id: null, sender_name: 'PartyGames', sender_color: '#ffd93d',
        content: `${ws._user.username} start een potje ${gameNames[game] || game}! Klik Meedoen om mee te spelen.`,
        msg_type: 'game_invite',
        metadata: { channel, game, hostName: ws._user.username, gameIcon: gameIcons[game] || '🎮' },
        created_at: new Date().toISOString(),
      };

      if (process.env.DATABASE_URL) {
        db.query(
          'INSERT INTO messages (id,channel,sender_id,sender_name,sender_color,content,msg_type,metadata) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [ann.id, ann.channel, null, 'PartyGames', '#ffd93d', ann.content, 'game_invite', JSON.stringify(ann.metadata)]
        ).catch(() => {});
      }

      broadcastToChannel(channel, { type: 'MSG', message: ann });
      ws.send(JSON.stringify({
        type: 'GAME_JOINED', channel, isHost: true, game,
        players: session.players.map(p => ({ id: p.userId, name: p.name, color: p.color, isHost: p.isHost })),
      }));
      return;
    }

    // JOIN GAME
    if (msg.type === 'JOIN_GAME') {
      const { channel } = msg;
      const session = gameSessions.get(channel);
      if (!session) { ws.send(JSON.stringify({ type: 'ERROR', message: 'Geen actief spel' })); return; }

      if (session.allowedUserIds.length && !session.allowedUserIds.includes(ws._userId)) {
        ws.send(JSON.stringify({ type: 'ERROR', message: 'Je bent geen lid van dit gesprek' }));
        return;
      }

      // Already in?
      if (session.players.find(p => p.userId === ws._userId)) {
        ws._gameChannel = channel;
        ws.send(JSON.stringify({
          type: 'GAME_JOINED', channel, isHost: false, game: session.game,
          players: session.players.map(p => ({ id: p.userId, name: p.name, color: p.color, isHost: p.isHost })),
        }));
        if (session.gameState) {
          if (session.game === 'cah') cahBroadcast(session);
          else if (session.game === 'poker') pokerBroadcast(session);
          else if (session.game === 'monopoly') monoBroadcast(session);
        }
        return;
      }

      const player = {
        id: uuidv4(), userId: ws._userId, ws,
        name: ws._user.username, color: ws._user.color,
        isHost: false, score: 0,
      };
      session.players.push(player);
      ws._gameChannel = channel;
      broadcastToChannel(channel, { type: 'GAME_PLAYER_JOINED', channel, player: { id: ws._userId, name: ws._user.username, color: ws._user.color } });
      ws.send(JSON.stringify({
        type: 'GAME_JOINED', channel, isHost: false, game: session.game,
        players: session.players.map(p => ({ id: p.userId, name: p.name, color: p.color, isHost: p.isHost })),
      }));
      return;
    }

    // GAME ACTION
    if (msg.type === 'GAME_ACTION') {
      const channel = ws._gameChannel || msg.channel;
      const session = gameSessions.get(channel);
      if (!session) return;

      const clientPlayer = session.players.find(p => p.userId === ws._userId);
      if (!clientPlayer) return;
      const clientId = clientPlayer.userId;

      if (msg.action === 'SWITCH_GAME') {
        if (!clientPlayer.isHost) return;
        session.game = msg.game;
        session.gameState = null;
        session.players.forEach(p => { p.score = 0; });
        broadcastGameLobby(session);
        return;
      }

      if (session.game === 'cah') handleCAH(session, clientId, ws, msg);
      else if (session.game === 'poker') handlePoker(session, clientId, ws, msg);
      else if (session.game === 'monopoly') handleMonopoly(session, clientId, ws, msg);
      return;
    }

    // GAME SETTINGS
    if (msg.type === 'GAME_SETTINGS') {
      const channel = ws._gameChannel || msg.channel;
      const session = gameSessions.get(channel);
      if (!session) return;
      if (!session.players.find(p => p.userId === ws._userId)?.isHost) return;
      session.settings = { ...session.settings, ...msg.settings };
      broadcastGameLobby(session);
      return;
    }

    // GAME CHAT
    if (msg.type === 'GAME_CHAT') {
      const channel = ws._gameChannel || msg.channel;
      const session = gameSessions.get(channel);
      if (!session) return;
      const player = session.players.find(p => p.userId === ws._userId);
      if (!player || !msg.text?.trim()) return;
      const m = {
        id: uuidv4(), playerId: ws._userId, playerName: player.name,
        text: msg.text.slice(0, 200), time: Date.now(),
      };
      session.chat.push(m);
      if (session.chat.length > 100) session.chat.shift();
      session.players.forEach(p => send(p.ws, { type: 'GAME_CHAT', message: m }));
      return;
    }

    // LEAVE GAME
    if (msg.type === 'LEAVE_GAME') {
      handleLeaveGame(ws);
      return;
    }
  });

  ws.on('close', () => {
    if (ws._userId) {
      const wsSet = onlineUsers.get(ws._userId);
      if (wsSet) {
        wsSet.delete(ws);
        if (!wsSet.size) {
          onlineUsers.delete(ws._userId);
          broadcastToChannel('global', { type: 'USER_OFFLINE', userId: ws._userId });
        }
      }
    }
    if (ws._gameChannel) handleLeaveGame(ws, true);
  });

  ws.on('error', () => {});
});

function handleLeaveGame(ws, disconnected = false) {
  const channel = ws._gameChannel;
  if (!channel) return;
  const session = gameSessions.get(channel);
  if (!session) return;

  const idx = session.players.findIndex(p => p.ws === ws);
  if (idx === -1) { ws._gameChannel = null; return; }

  const leaving = session.players[idx];
  session.players.splice(idx, 1);
  ws._gameChannel = null;

  if (session.players.length === 0) {
    gameSessions.delete(channel);
    broadcastToChannel(channel, { type: 'GAME_ENDED', game: session.game, channel });
    return;
  }

  if (leaving.isHost) session.players[0].isHost = true;
  session.players.forEach(p => send(p.ws, { type: 'GAME_PLAYER_LEFT', userId: ws._userId, name: leaving.name }));
}

function broadcastGameLobby(session) {
  const data = {
    type: 'GAME_STATE', game: session.game,
    state: {
      phase: 'lobby',
      players: session.players.map(p => ({ id: p.id, userId: p.userId, name: p.name, color: p.color, isHost: p.isHost, score: p.score })),
      settings: session.settings,
    },
  };
  session.players.forEach(p => send(p.ws, data));
}

function broadcastGameEnded(session, reason = '') {
  const data = { type: 'GAME_ENDED', game: session.game, channel: session.channel, reason };
  session.players.forEach(p => send(p.ws, data));
  broadcastToChannel(session.channel, { type: 'GAME_ENDED', game: session.game, channel: session.channel });
}

app.get('/health', (req, res) => res.json({ ok: true, online: onlineUsers.size, sessions: gameSessions.size }));

// ==================== CAH CARDS ====================
// Dutch dark humor CAH deck — adults only, no CSAM or hate speech
const BLACK = [
  "Waarom ben ik uit de supermarkt gegooid?",
  "Mijn therapeut is gestopt na mijn verhaal over ___.",
  "Wat heb ik meegenomen naar mijn eerste date?",
  "Wat vond de buurman in mijn garage?",
  "Mijn laatste zoekterm op Google: ___.",
  "Wat maak ik klaar als ik wil imponeren?",
  "De werkelijke reden dat ik single ben: ___.",
  "Wat hebben mijn collega's gevonden in mijn bureaulade?",
  "Mijn auto-aanvulling na 'Hoe maak je ___?'",
  "Wat heb ik als excuus opgegeven voor mijn te late thuiskomst?",
  "Waarom ben ik van de familieapp gegooid?",
  "De reden dat mijn buren verhuisd zijn: ___.",
  "Wat heb ik meegenomen naar het schoolplein?",
  "Mijn geheim voor een geslaagd feestje: ___.",
  "Wat heb ik gegeten terwijl ik wachtte op de ambulance?",
  "De app die mijn leven heeft geruïneerd: ___.",
  "Mijn noodplan als er geen wifi is: ___.",
  "Wat zit er in mijn Emergency Kit?",
  "Waarom mag ik niet meer mee op schoolreisje?",
  "Wat heb ik besteld terwijl ik ziek thuis was?",
  "Mijn zoekopdracht die per ongeluk aan heel de groepschat gedeeld werd: ___.",
  "Wat vond mijn moeder in mijn slaapkamer?",
  "De reden dat ik nooit meer mag oppassen: ___.",
  "Mijn excuus voor te laat op het werk: ___.",
  "Wat ligt er altijd in mijn koelkast?",
  "Waarom heeft de huisarts mij doorverwezen naar een specialist?",
  "De reden dat ik gebanned ben op Twitch: ___.",
  "Mijn meest gênante hobby: ___.",
  "Wat heb ik gedaan op mijn eerste dag als vrijwilliger?",
  "De reden dat mijn tinder-match mij geblokkeerd heeft: ___.",
  "Wat ga ik doen als ik met pensioen ga?",
  "Mijn bucket-list bevat onder andere: ___.",
  "Wat neemt mijn opa altijd mee naar verjaardagen?",
  "De vreemdste vraag die ik ooit bij een sollicitatie heb gekregen was over ___.",
  "Mijn favoriete verkleedkostuum: ___.",
  "Wat heb ik opgegeven voor de goede doelen veiling?",
  "Mijn app-store zoekgeschiedenis na een slechte week: ___.",
  "Waarom ben ik gebanned bij de lokale sportschool?",
  "Wat gaat er mis bij mijn thuis-kookshow?",
  "De reden dat ik niet meer uitgenodigd word voor vakanties: ___.",
  "Wat heb ik ingebracht in de spelletjesavond?",
  "Mijn meest obscure fetish: ___.",
  "Waarom heeft de cameraman mij weggestuurd?",
  "Wat heb ik per ongeluk live gestreamd?",
  "De reden dat mijn vriendin haar wachtwoord heeft veranderd: ___.",
  "Mijn antwoord op 'wat doe je in je vrije tijd?': ___.",
  "Wat staat er op mijn verlanglijstje dat ik nooit hardop zeg?",
  "De vreemdste dingen die ik verzamel: ___.",
  "Waarom heb ik de gordijnen nooit opengedaan deze week?",
  "Mijn favoriete excuus om een feestje te verlaten: ___.",
  "Wat heb ik nagelaten toen ik babysitte?",
  "De reden dat mijn ex mij op alle platforms heeft geblokkeerd: ___.",
  "Mijn noodstrategie voor familiediner: ___.",
  "Wat heb ik gevonden in de verloren-gevonden bak?",
  "Mijn geheime talent dat niemand weet: ___.",
  "De reden dat ik nooit meezang bij de campingbingo: ___.",
  "Wat staat er op mijn wenslijst maar ik durf het niet te kopen?",
  "Mijn favoriete Netflix-genre dat ik verborgen houd: ___.",
  "Waarom zit mijn account in de 'verdachte activiteiten' map?",
  "Mijn plan B als dit alles mislukt: ___.",
  "De reden dat mijn telefoon's ochtends altijd op 1% zit: ___.",
];

const WHITE = [
  // Kort
  "Drie flessen wijn en een bad beslissing",
  "De verkeerde persoon bellen om 3 uur 's nachts",
  "Googelen wat je al weet maar toch opzoekt",
  "Een totaal nutteloze universiteitsdiploma",
  "Spontaan huilen in de supermarkt",
  "Per ongeluk liken op een oud Instagram-post",
  "Autorijden met één hand en een pizza",
  "Vragen of je er goed uitziet terwijl je al buiten staat",
  "Vergeten wat je zocht toen je naar de keuken liep",
  "Een zak chips openen en dan beslissen dat je op dieet gaat",
  "Nep-ziek zijn maar dan echt ziek worden",
  "Liegen over je leeftijd op het internet",
  "Snoozen tot het geen zin meer heeft",
  "Een relatie beginnen via een meme",
  "Jezelf feliciteren voor niets gedaan hebben",
  "Eten bestellen en dan ook koken",
  "Toch die vierde borrel nemen",
  "Een plan maken dat je nooit uitvoert",
  "De stoute zoekgeschiedenis wissen voor het geval je sterft",
  "Zeggen 'ik bel je terug' en dat nooit doen",
  "Op vakantie hetzelfde doen als thuis maar ergens anders",
  "Andermans wifi stelen",
  "Beweren dat je het gelezen hebt",
  "Spontaan veganist worden en na drie dagen stoppen",
  "Gefeliciteerd zeggen op de verkeerde dag",
  "Zeggen dat je vijf minuten nodig hebt en dan twee uur verdwijnen",
  "Per ongeluk een hond uitlaten die van iemand anders is",
  "Iemand helpen en dan spijt krijgen",
  "Een verrassingspakket bestellen voor jezelf",
  "Huilen om een dier in een film maar niet om mensen",
  "Vergeten hoeveel je gedronken hebt",
  "Opnieuw beginnen met sporten omdat het maandag is",
  "Je eigen verjaardag vergeten",
  "Op TikTok kijken tot je de zin van het leven kwijt bent",
  "Zeggen dat je vijf minuten kijkt en dan wakker worden bij de credits",
  "Besluiten op de meest ongelegene moment om te stoppen roken",
  "Proberen indruk te maken met iets wat je niet kunt",
  "Een compleet verhaal verzinnen in je hoofd voordat je hem belt",
  "Aan iedereen vertellen hoeveel je slaapt terwijl je niet slaapt",
  "Een compleet diner maken omdat je had gezegd dat je zou koken",
  "Zeggen dat je geen geld hebt maar toch iets kopen",
  "Online shoppen wanneer je moe bent",
  "Eén goed idee per dag en de rest vergeten",
  "Bewust slechte keuzes maken omdat je toch al moe bent",
  "De supermarkt uit lopen met alleen maar ongezond eten",
  "Stiekem iemand googelen voordat je hem ontmoet",
  "Jezelf opbellen om te testen of je telefoon het doet",
  "Ruzie maken met iemand die er niet is",
  "Een andere route nemen en dan verdwalen",
  "Zeggen dat je zo terugkomt en dan nooit terugkomen",
  "Iemand een compliment geven en dan meteen wegrennen",

  // Langer
  "Vergeten dat je iets op het vuur had staan totdat de rook alarm afgaat",
  "Op vakantie gaan zonder te vragen of je de oven uitgedaan hebt",
  "Per ongeluk iemand volgen die je eigenlijk wil ontvolgen",
  "Beweren dat je het restaurant kent terwijl het je eerste keer is",
  "Zeggen 'Ik hoef maar een glaasje' en dan de host worden van een feestje",
  "Drie uur in de supermarkt staan voor één product",
  "Een motiverende speech geven aan jezelf in de spiegel en dan toch niet gaan",
  "Beloven dat je vroeg naar bed gaat en dan om 4 uur documentaires kijken",
  "Een gezonde maaltijd plannen maar toch bellen voor een pizza",
  "Zeggen dat je 'morgen echt begint' voor de negende keer deze maand",
];

function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function cahBroadcast(room) {
  const gs = room.gameState;
  const rs = roomState(room.code);
  room.clients.forEach(c => {
    const cid = c.userId || c.id;
    const showSubs = gs.phase === 'judging' || gs.phase === 'scores';
    send(c.ws, {
      type: 'GAME_STATE', game: 'cah', roomState: rs,
      state: {
        phase: gs.phase, round: gs.round, czar: gs.czar,
        czarName: room.clients.find(cl => (cl.userId || cl.id) === gs.czar)?.name || '?',
        currentBlack: gs.currentBlack,
        submissions: showSubs ? gs.submissions : {},
        submittedIds: Object.keys(gs.submissions),
        scores: gs.scores,
        winner: gs.winner, lastWinner: gs.lastWinner,
        lastWinnerName: room.clients.find(cl => (cl.userId || cl.id) === gs.lastWinner)?.name || '?',
        lastWinningCard: gs.lastWinningCard,
        lastBlackCard: gs.lastBlackCard,
        myHand: gs.hands[cid] || [],
        hasSubmitted: !!gs.submissions[cid],
        mySubmission: gs.submissions[cid] || null,
        totalPlayers: room.clients.length,
        maxPoints: room.settings.maxPoints || 7,
        settings: room.settings,
      },
    });
  });
}

function startCAH(room) {
  const extra_b = room.settings.customBlackCards || [];
  const extra_w = room.settings.customWhiteCards || [];
  const bDeck = shuffle([...extra_b, ...BLACK]);
  const wDeck = shuffle([...extra_w, ...WHITE]);
  const players = room.clients.map(c => c.userId || c.id);
  const hands = {};
  let wi = 0;
  players.forEach(p => { hands[p] = wDeck.slice(wi, wi + 7); wi += 7; });
  room.gameState = {
    phase: 'playing', round: 1, czarIndex: 0, czar: players[0],
    currentBlack: bDeck[0], blackDeck: bDeck.slice(1), whiteDeck: wDeck.slice(wi),
    hands, submissions: {}, scores: Object.fromEntries(players.map(p => [p, 0])),
    winner: null, lastWinner: null, lastWinningCard: null, lastBlackCard: null,
  };
  room.phase = 'ingame';
  cahBroadcast(room);
}

function handleCAH(room, clientId, ws, msg) {
  const client = room.clients.find(c => (c.userId || c.id) === clientId);

  if (msg.action === 'START_GAME') {
    if (client?.isHost) startCAH(room);
    return;
  }

  if (msg.action === 'ADD_CARD') {
    if (!client?.isHost) return;
    if (msg.cardType === 'black') {
      (room.settings.customBlackCards = room.settings.customBlackCards || []).push(msg.card);
    } else {
      (room.settings.customWhiteCards = room.settings.customWhiteCards || []).push(msg.card);
    }
    send(ws, { type: 'TOAST', text: '✅ Kaart toegevoegd!' });
    return;
  }

  const gs = room.gameState;
  if (!gs) return;

  if (msg.action === 'SUBMIT_CARD') {
    if (gs.phase !== 'playing' || clientId === gs.czar || gs.submissions[clientId]) return;
    if (!gs.hands[clientId]?.includes(msg.card)) return;
    gs.submissions[clientId] = msg.card;
    gs.hands[clientId] = gs.hands[clientId].filter(c => c !== msg.card);
    const nonCzar = room.clients.filter(c => (c.userId || c.id) !== gs.czar);
    if (nonCzar.every(c => gs.submissions[c.userId || c.id])) gs.phase = 'judging';
    cahBroadcast(room);
    return;
  }

  if (msg.action === 'PICK_WINNER') {
    if (gs.phase !== 'judging' || clientId !== gs.czar) return;
    const winnerId = Object.entries(gs.submissions).find(([, c]) => c === msg.card)?.[0];
    if (!winnerId) return;
    gs.scores[winnerId] = (gs.scores[winnerId] || 0) + 1;
    room.clients.forEach(c => { c.score = gs.scores[c.userId || c.id] || 0; });
    gs.lastWinner = winnerId;
    gs.lastWinningCard = msg.card;
    gs.lastBlackCard = gs.currentBlack;
    gs.phase = 'scores';
    if (gs.scores[winnerId] >= (room.settings.maxPoints || 7)) gs.winner = winnerId;
    cahBroadcast(room);
    return;
  }

  if (msg.action === 'NEXT_ROUND') {
    if (gs.phase !== 'scores' || !client?.isHost) return;
    if (gs.winner) { startCAH(room); return; }
    const players = room.clients.map(c => c.userId || c.id);
    players.forEach(pid => {
      gs.hands[pid] = gs.hands[pid] || [];
      while (gs.hands[pid].length < 7 && gs.whiteDeck.length > 0) {
        gs.hands[pid].push(gs.whiteDeck.shift());
      }
    });
    gs.czarIndex = (gs.czarIndex + 1) % players.length;
    gs.czar = players[gs.czarIndex];
    gs.submissions = {};
    gs.currentBlack = gs.blackDeck.shift() || BLACK[Math.floor(Math.random() * BLACK.length)];
    gs.phase = 'playing';
    gs.round++;
    gs.lastWinner = null;
    gs.lastWinningCard = null;
    cahBroadcast(room);
    return;
  }
}

// ==================== POKER ====================
function makeDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const d = [];
  for (const s of suits) for (const r of ranks) d.push({ r, s });
  return shuffle(d);
}

function pokerBroadcast(room) {
  const gs = room.gameState;
  const rs = roomState(room.code);
  room.clients.forEach(c => {
    const cid = c.userId || c.id;
    const myHand = gs.phase === 'showdown'
      ? Object.fromEntries(Object.entries(gs.hands || {}).map(([id, h]) => [id, h]))
      : { [cid]: gs.hands?.[cid] || [] };
    send(c.ws, {
      type: 'GAME_STATE', game: 'poker', roomState: rs,
      state: {
        ...gs, hands: undefined, deck: undefined, myHand,
        currentPlayerName: room.clients.find(cl => (cl.userId || cl.id) === gs.players?.[gs.currentPlayerIndex])?.name || '?',
        settings: room.settings,
      },
    });
  });
}

function startPokerHand(room) {
  const prevChips = room.gameState?.chips;
  const prevDealer = room.gameState?.dealerIndex ?? -1;
  const players = room.clients.map(c => c.userId || c.id);
  const chips = prevChips || Object.fromEntries(players.map(p => [p, 1000]));
  const blind = 10;
  const deck = makeDeck();
  const hands = {};
  players.forEach(p => { hands[p] = [deck.pop(), deck.pop()]; });
  const dIdx = (prevDealer + 1) % players.length;
  const sbIdx = (dIdx + 1) % players.length;
  const bbIdx = (dIdx + 2) % players.length;
  const bets = Object.fromEntries(players.map(p => [p, 0]));
  chips[players[sbIdx]] = Math.max(0, (chips[players[sbIdx]] || 0) - blind);
  chips[players[bbIdx]] = Math.max(0, (chips[players[bbIdx]] || 0) - blind * 2);
  bets[players[sbIdx]] = blind;
  bets[players[bbIdx]] = blind * 2;
  room.gameState = {
    phase: 'preflop', players, chips, hands, deck,
    community: [], pot: blind * 3, bets, currentBet: blind * 2, blind,
    dealerIndex: dIdx, currentPlayerIndex: (dIdx + 3) % players.length,
    folded: {}, winner: null, actionsThisStreet: 0,
  };
  room.phase = 'ingame';
  pokerBroadcast(room);
}

function pokerAdvance(room) {
  const gs = room.gameState;
  const active = gs.players.filter(p => !gs.folded[p]);

  if (active.length === 1) {
    gs.winner = active[0];
    gs.chips[active[0]] = (gs.chips[active[0]] || 0) + gs.pot;
    gs.pot = 0;
    gs.phase = 'showdown';
    pokerBroadcast(room);
    return;
  }

  gs.actionsThisStreet++;
  const allEq = active.every(p => (gs.bets[p] || 0) === (gs.currentBet || 0));

  if (allEq && gs.actionsThisStreet >= active.length) {
    gs.bets = Object.fromEntries(gs.players.map(p => [p, 0]));
    gs.currentBet = 0;
    gs.actionsThisStreet = 0;
    let ni = (gs.dealerIndex + 1) % gs.players.length;
    while (gs.folded[gs.players[ni]]) ni = (ni + 1) % gs.players.length;
    gs.currentPlayerIndex = ni;

    if (gs.phase === 'preflop') {
      gs.community = [gs.deck.pop(), gs.deck.pop(), gs.deck.pop()];
      gs.phase = 'flop';
    } else if (gs.phase === 'flop') {
      gs.community.push(gs.deck.pop());
      gs.phase = 'turn';
    } else if (gs.phase === 'turn') {
      gs.community.push(gs.deck.pop());
      gs.phase = 'river';
    } else if (gs.phase === 'river') {
      // Simple random winner (no hand evaluation)
      gs.winner = active[Math.floor(Math.random() * active.length)];
      gs.chips[gs.winner] = (gs.chips[gs.winner] || 0) + gs.pot;
      gs.pot = 0;
      gs.phase = 'showdown';
    }
  } else {
    let ni = (gs.currentPlayerIndex + 1) % gs.players.length;
    let tries = 0;
    while (gs.folded[gs.players[ni]] && tries++ < gs.players.length) {
      ni = (ni + 1) % gs.players.length;
    }
    gs.currentPlayerIndex = ni;
  }
  pokerBroadcast(room);
}

function handlePoker(room, clientId, ws, msg) {
  const client = room.clients.find(c => (c.userId || c.id) === clientId);

  if (msg.action === 'START_GAME') { if (client?.isHost) startPokerHand(room); return; }
  if (msg.action === 'NEXT_HAND') { if (client?.isHost) startPokerHand(room); return; }

  const gs = room.gameState;
  if (!gs || gs.phase === 'showdown') return;
  if (gs.players[gs.currentPlayerIndex] !== clientId) return;

  if (msg.action === 'FOLD') {
    gs.folded[clientId] = true;
    pokerAdvance(room);
  } else if (msg.action === 'CHECK') {
    pokerAdvance(room);
  } else if (msg.action === 'CALL') {
    const toCall = Math.min((gs.currentBet - (gs.bets[clientId] || 0)), gs.chips[clientId] || 0);
    gs.chips[clientId] = (gs.chips[clientId] || 0) - toCall;
    gs.bets[clientId] = (gs.bets[clientId] || 0) + toCall;
    gs.pot += toCall;
    pokerAdvance(room);
  } else if (msg.action === 'RAISE') {
    const toCall = gs.currentBet - (gs.bets[clientId] || 0);
    const raiseAmt = Math.max(gs.blind * 2, msg.amount || gs.blind * 2);
    const total = Math.min(toCall + raiseAmt, gs.chips[clientId] || 0);
    gs.chips[clientId] = (gs.chips[clientId] || 0) - total;
    gs.bets[clientId] = (gs.bets[clientId] || 0) + total;
    gs.pot += total;
    gs.currentBet = gs.bets[clientId];
    gs.actionsThisStreet = 0;
    pokerAdvance(room);
  }
}

// ==================== MONOPOLY ====================
const MONO_BOARD = [
  { n: 'START',              t: 'go',      emoji: '🏁', desc: 'Passeer en ontvang €2.000!' },
  { n: 'Crack Steeg',        t: 'prop',    emoji: '🏚️', c: '#8B4513', p: 600,  r: 20,  desc: '1 kamer. Veel ratten.' },
  { n: 'Gemeentekas',        t: 'chest',   emoji: '📬', desc: 'Post van de gemeente.' },
  { n: 'Jordaan Slop',       t: 'prop',    emoji: '🏠', c: '#8B4513', p: 1000, r: 40,  desc: 'Gezellig als je dronken bent.' },
  { n: 'Inkomstenbelasting', t: 'tax',     emoji: '⚡', a: 2000, desc: 'Betaal €2.000 belasting.' },
  { n: 'Schiphol',           t: 'rr',      emoji: '✈️', p: 2000, r: 250, desc: 'Vliegveld. 4x = jackpot.' },
  { n: 'AH Straat',          t: 'prop',    emoji: '🛒', c: '#87CEEB', p: 1000, r: 60,  desc: 'Bonusbroodjes inbegrepen.' },
  { n: 'Kans',               t: 'chance',  emoji: '🎲', desc: 'Druk op je geluk.' },
  { n: 'Wallen Wijk',        t: 'prop',    emoji: '🪟', c: '#87CEEB', p: 1000, r: 60,  desc: 'Toeristen betalen goed.' },
  { n: 'Coffeeshop Corner',  t: 'prop',    emoji: '☕', c: '#87CEEB', p: 1200, r: 80,  desc: 'Hoge huur, hogere bewoners.' },
  { n: 'Gevangenis',         t: 'jail',    emoji: '🔒', desc: 'Op bezoek... toch?' },
  { n: 'Kattenburgh',        t: 'prop',    emoji: '🐱', c: '#FF69B4', p: 1400, r: 100, desc: 'Meer katten dan mensen.' },
  { n: 'Waterleiding',       t: 'util',    emoji: '💧', p: 1500, r: 0, desc: 'Huur = dobbelsteen × €40.' },
  { n: 'Kinkerstraat',       t: 'prop',    emoji: '🛵', c: '#FF69B4', p: 1400, r: 100, desc: 'Scooters overal.' },
  { n: 'De Pijp',            t: 'prop',    emoji: '🥐', c: '#FF69B4', p: 1600, r: 120, desc: 'Avocadotoast €14.' },
  { n: 'Centraal Station',   t: 'rr',      emoji: '🚂', p: 2000, r: 250, desc: 'Trein. 4x = jackpot.' },
  { n: 'NDSM Loods',         t: 'prop',    emoji: '🏭', c: '#FFA500', p: 1800, r: 140, desc: 'Hipsters inbegrepen.' },
  { n: 'Gemeentekas',        t: 'chest',   emoji: '📬', desc: 'Misschien goed nieuws.' },
  { n: 'Zuidas Tower',       t: 'prop',    emoji: '🏢', c: '#FFA500', p: 1800, r: 140, desc: 'Pakken en BMWs.' },
  { n: 'Vondelpark',         t: 'prop',    emoji: '🌳', c: '#FFA500', p: 2000, r: 160, desc: 'Joggers en junkies.' },
  { n: 'Gratis Parkeren',    t: 'free',    emoji: '🚗', desc: 'Niets. Geniet ervan.' },
  { n: 'Herengracht',        t: 'prop',    emoji: '🏰', c: '#CC2200', p: 2200, r: 180, desc: 'Grachtenpand. Steil.' },
  { n: 'Kans',               t: 'chance',  emoji: '🎲', desc: 'Druk op je geluk.' },
  { n: 'Keizersgracht',      t: 'prop',    emoji: '🏯', c: '#CC2200', p: 2200, r: 180, desc: 'Nog steiler.' },
  { n: 'Prinsengracht',      t: 'prop',    emoji: '🏛️', c: '#CC2200', p: 2400, r: 200, desc: 'Anne Frank was hier.' },
  { n: 'Zuid-As Metro',      t: 'rr',      emoji: '🚇', p: 2000, r: 250, desc: 'Metro. 4x = jackpot.' },
  { n: 'Museumplein',        t: 'prop',    emoji: '🎨', c: '#FFD700', p: 2600, r: 220, desc: 'Toeristen betalen goed.' },
  { n: 'Luxebelasting',      t: 'tax',     emoji: '💸', a: 1000, desc: 'Betaal €1.000 luxebelasting.' },
  { n: 'Oud-Zuid Laan',      t: 'prop',    emoji: '🏡', c: '#FFD700', p: 2600, r: 220, desc: 'Bomen, stilte, geld.' },
  { n: 'Vondelweg',          t: 'prop',    emoji: '🌿', c: '#FFD700', p: 2800, r: 240, desc: 'Rustige laan, dure buurt.' },
  { n: 'Ga Naar Bak',        t: 'gotojail',emoji: '🚔', desc: 'Geen €2000. Direct naar bak.' },
  { n: 'Apollolaan',         t: 'prop',    emoji: '🌴', c: '#2E8B57', p: 3000, r: 260, desc: 'Celebrities en villas.' },
  { n: 'Gemeentekas',        t: 'chest',   emoji: '📬', desc: 'Post uit de dure buurt.' },
  { n: 'Buitenveldert',      t: 'prop',    emoji: '🏘️', c: '#2E8B57', p: 3000, r: 260, desc: 'Rustig. Te rustig.' },
  { n: 'Kans',               t: 'chance',  emoji: '🎲', desc: 'Druk op je geluk.' },
  { n: 'Amstelveen Park',    t: 'prop',    emoji: '🏗️', c: '#2E8B57', p: 3200, r: 280, desc: 'Mega-pand staat er al.' },
  { n: 'Snelweg A10',        t: 'rr',      emoji: '🚌', p: 2000, r: 250, desc: 'Bus. 4x = jackpot.' },
  { n: 'Leidseplein',        t: 'prop',    emoji: '🌟', c: '#3333CC', p: 3500, r: 350, desc: 'Uitzicht over de stad.' },
  { n: 'Gemeentebelasting',  t: 'tax',     emoji: '🏛️', a: 750, desc: 'Betaal €750 gemeentebelasting.' },
  { n: 'Rembrandtplein',     t: 'prop',    emoji: '👑', c: '#3333CC', p: 4500, r: 500, desc: 'Het duurste pand van Amsterdam.' },
];

const MONO_LEVEL_NAMES = ['Leeg', 'Kraakpand', 'Rijtjeshuis', 'Appartement', 'Villa', 'Mansion'];
const MONO_LEVEL_EMOJI = ['🏚️', '🏠', '🏡', '🏢', '🏰', '👑'];

function monoUpgradeCost(sq) { return Math.floor((sq.p || 100) * 0.5); }

function monoCalcRent(sqIdx, gs) {
  const sq = MONO_BOARD[sqIdx];
  const prop = gs.props[sqIdx];
  if (!prop) return 0;

  if (sq.t === 'rr') {
    const owner = prop.ownerId;
    const count = Object.entries(gs.props).filter(([i, p]) => MONO_BOARD[i].t === 'rr' && p.ownerId === owner).length;
    return [0, 250, 500, 1000, 2000][count] || 250 * count;
  }
  if (sq.t === 'util') {
    return (gs.lastDiceSum || 7) * 40;
  }
  const mults = [1, 3, 6, 12, 20, 32];
  return Math.round((sq.r || 10) * (mults[prop.level] || 1));
}

const MONO_CHANCE = [
  { txt: 'Je wint een weddenschap! +€500 🎉', eff: { t: 'money', v: 500 } },
  { txt: 'Belastingteruggave! +€1.000 💵', eff: { t: 'money', v: 1000 } },
  { txt: 'Oom Henk is dood. Je erft €2.000 🪦', eff: { t: 'money', v: 2000 } },
  { txt: 'Parkeerboete. -€500 🚔', eff: { t: 'money', v: -500 } },
  { txt: 'Ziekenhuisrekening. -€1.000 🏥', eff: { t: 'money', v: -1000 } },
  { txt: 'Straatloterij! +€3.000 🎰', eff: { t: 'money', v: 3000 } },
  { txt: 'Terug naar START! Pak €2.000 💰', eff: { t: 'goto', pos: 0, bonus: 2000 } },
  { txt: 'Rechtstreeks naar de gevangenis 🔒', eff: { t: 'jail' } },
  { txt: 'Vrijlatingspas gevonden! Bewaar voor later 🗝️', eff: { t: 'freepass' } },
  { txt: 'Iedereen geeft jou €500! 🤑', eff: { t: 'collect', v: 500 } },
  { txt: 'Je trakteert iedereen op kroketjes. -€300 per persoon 🍺', eff: { t: 'payall', v: 300 } },
  { txt: 'Dakgoot kapot! -€500 per pand 🔧', eff: { t: 'perprop', v: 500 } },
  { txt: 'Cryptobelegging GECRASHED. -€2.000 📉', eff: { t: 'money', v: -2000 } },
  { txt: 'Je wint een rechtszaak! +€1.500 ⚖️', eff: { t: 'money', v: 1500 } },
];

const MONO_CHEST = [
  { txt: 'WOZ-aanslag. -€800 📄', eff: { t: 'money', v: -800 } },
  { txt: 'Buren klagen over geluidsoverlast. -€400 😤', eff: { t: 'money', v: -400 } },
  { txt: 'Je verkoopt je Vespa op Marktplaats. +€600 🛵', eff: { t: 'money', v: 600 } },
  { txt: 'Jaareinde bonus! +€1.500 💼', eff: { t: 'money', v: 1500 } },
  { txt: 'Gewoon de bak in. Nu. 🔒', eff: { t: 'jail' } },
  { txt: 'Buurtfeest: iedereen betaalt jou €300 🏘️', eff: { t: 'collect', v: 300 } },
  { txt: 'Energiesubsidie! +€750 🏛️', eff: { t: 'money', v: 750 } },
  { txt: 'Riool gesprongen onder je pand. -€1.200 💧', eff: { t: 'money', v: -1200 } },
  { txt: 'Gewonnen bij de rechtbank! +€1.000 ⚖️', eff: { t: 'money', v: 1000 } },
  { txt: 'Huurders staken! Miss een beurt. ✊', eff: { t: 'money', v: 0 } },
  { txt: 'Fout geld gevonden in je muur. +€2.500 🤑', eff: { t: 'money', v: 2500 } },
];

const MONO_SPIN = [
  { txt: '🎉 VRIJUIT! Agent at zijn donut en zag niks.', type: 'free',  prob: 0.25 },
  { txt: '💸 Rijboete €300. Had je gordel op?',         type: 'fine',  v: 300,  prob: 0.20 },
  { txt: '💸 Snelheidsboete €600. Beetje snel!',        type: 'fine',  v: 600,  prob: 0.18 },
  { txt: '💸 Rijden onder invloed €1.500. Au.',         type: 'fine',  v: 1500, prob: 0.12 },
  { txt: '🔒 GEARRESTEERD! Rechtstreeks naar de gevangenis!', type: 'jail', prob: 0.13 },
  { txt: '🏃 ACHTERVOLGING! Je ontsnapt maar gaat 3 stappen terug.', type: 'chase', prob: 0.12 },
];

function monoSpin() {
  const r = Math.random();
  let acc = 0;
  for (const s of MONO_SPIN) { acc += s.prob; if (r < acc) return s; }
  return MONO_SPIN[0];
}

function monoBroadcast(room) {
  const rs = roomState(room.code);
  room.clients.forEach(c => {
    const cid = c.userId || c.id;
    send(c.ws, { type: 'GAME_STATE', game: 'monopoly', roomState: rs, state: { ...room.gameState, myId: cid }, settings: room.settings });
  });
}

function monoApplyCard(room, pid, card) {
  const gs = room.gameState;
  const name = room.clients.find(c => (c.userId || c.id) === pid)?.name || '?';
  const eff = card.eff;

  if (eff.t === 'money') {
    gs.money[pid] = (gs.money[pid] || 0) + eff.v;
  } else if (eff.t === 'goto') {
    gs.pos[pid] = eff.pos || 0;
    if (eff.bonus) gs.money[pid] = (gs.money[pid] || 0) + eff.bonus;
  } else if (eff.t === 'jail') {
    gs.pos[pid] = 10; gs.jail[pid] = true; gs.jailTurns[pid] = 0;
  } else if (eff.t === 'freepass') {
    gs.freePass[pid] = true;
  } else if (eff.t === 'collect') {
    const others = gs.players.filter(p => p !== pid && !gs.bankrupt[p]);
    others.forEach(p => { gs.money[p] = (gs.money[p] || 0) - eff.v; });
    gs.money[pid] = (gs.money[pid] || 0) + eff.v * others.length;
  } else if (eff.t === 'payall') {
    const others = gs.players.filter(p => p !== pid && !gs.bankrupt[p]);
    others.forEach(p => { gs.money[p] = (gs.money[p] || 0) + eff.v; });
    gs.money[pid] = (gs.money[pid] || 0) - eff.v * others.length;
  } else if (eff.t === 'perprop') {
    const count = Object.values(gs.props).filter(p => p.ownerId === pid).length;
    gs.money[pid] = (gs.money[pid] || 0) - eff.v * count;
  }

  gs.log.unshift(`${name}: ${card.txt}`);
  monoCheckBankruptcy(gs, pid, name);
}

function monoDrawCard(gs, type) {
  if (type === 'chance') {
    if (!gs.chanceDeck.length) gs.chanceDeck = monoShufArr([...Array(MONO_CHANCE.length).keys()]);
    return MONO_CHANCE[gs.chanceDeck.pop()];
  } else {
    if (!gs.chestDeck.length) gs.chestDeck = monoShufArr([...Array(MONO_CHEST.length).keys()]);
    return MONO_CHEST[gs.chestDeck.pop()];
  }
}

function monoShufArr(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

function monoCheckBankruptcy(gs, pid, name) {
  if ((gs.money[pid] || 0) <= 0 && !gs.bankrupt[pid]) {
    gs.bankrupt[pid] = true;
    gs.money[pid] = 0;
    gs.log.unshift(`💀 ${name || pid} is FAILLIET!`);
    return true;
  }
  return false;
}

function startMonopoly(room) {
  const players = room.clients.map(c => c.userId || c.id);
  const copId = 'cop';
  const allPlayers = [...players, copId];
  room.gameState = {
    players: allPlayers, copId,
    realPlayers: players,
    pos:       Object.fromEntries(allPlayers.map(p => [p, 0])),
    money:     Object.fromEntries(allPlayers.map(p => [p, p === 'cop' ? 0 : 10000])),
    jail:      Object.fromEntries(allPlayers.map(p => [p, false])),
    jailTurns: Object.fromEntries(allPlayers.map(p => [p, 0])),
    freePass:  Object.fromEntries(allPlayers.map(p => [p, false])),
    props: {},
    bankrupt: {},
    currentIdx: 0,
    current: allPlayers[0],
    dice: null,
    lastDiceSum: 0,
    rolled: false,
    phase: 'playing',
    popup: null,
    spinResult: null,
    log: ['🎮 Spel gestart! Pas op voor agent 👮 die na elke ronde rondrijdt!'],
    chanceDeck: monoShufArr([...Array(MONO_CHANCE.length).keys()]),
    chestDeck:  monoShufArr([...Array(MONO_CHEST.length).keys()]),
  };
  room.phase = 'ingame';
  monoBroadcast(room);
}

function monoCopTurn(room) {
  const gs = room.gameState;
  const d1 = Math.ceil(Math.random() * 6);
  const d2 = Math.ceil(Math.random() * 6);
  gs.dice = [d1, d2];
  gs.lastDiceSum = d1 + d2;
  const old = gs.pos['cop'];
  gs.pos['cop'] = (old + d1 + d2) % 40;
  const newPos = gs.pos['cop'];
  const sq = MONO_BOARD[newPos];
  gs.log.unshift(`👮 Agent rijdt ${d1}+${d2}=${d1 + d2} vakjes → ${sq.emoji} ${sq.n}`);

  const victims = gs.realPlayers.filter(p => !gs.bankrupt[p] && gs.pos[p] === newPos);
  if (victims.length > 0) {
    gs.spinVictims = victims;
    gs.phase = 'spinning';
    gs.popup = {
      kind: 'spin_intro',
      victims: victims.map(v => room.clients.find(c => (c.userId || c.id) === v)?.name || '?'),
    };
    gs.log.unshift(`👮 Agent staat op hetzelfde vak als ${gs.popup.victims.join(', ')}! RAD DRAAIEN!`);
    monoBroadcast(room);
    return;
  }

  monoCopDone(room);
}

function monoCopDone(room) {
  const gs = room.gameState;
  gs.dice = null; gs.rolled = false; gs.phase = 'playing'; gs.popup = null; gs.spinResult = null;
  let ni = 0, guard = 0;
  while (gs.bankrupt[gs.realPlayers[ni]] && guard++ < gs.realPlayers.length) {
    ni = (ni + 1) % gs.realPlayers.length;
  }
  gs.currentIdx = ni;
  gs.current = gs.realPlayers[ni];
  const nextName = room.clients.find(c => (c.userId || c.id) === gs.current)?.name || '?';
  gs.log.unshift(`▶️ ${nextName} is aan de beurt.`);
  monoBroadcast(room);
}

function monoEndTurn(room) {
  const gs = room.gameState;
  gs.rolled = false; gs.dice = null; gs.phase = 'playing'; gs.popup = null; gs.spinResult = null;

  const alive = gs.realPlayers.filter(p => !gs.bankrupt[p]);
  if (alive.length <= 1) {
    gs.winner = alive[0] || gs.realPlayers[0];
    gs.phase = 'gameover';
    gs.log.unshift('🏆 ' + (room.clients.find(c => (c.userId || c.id) === gs.winner)?.name || '?') + ' WINT HET SPEL!');
    monoBroadcast(room);
    return;
  }

  const curRealIdx = gs.realPlayers.indexOf(gs.current);
  let ni = (curRealIdx + 1) % gs.realPlayers.length;
  let guard = 0;
  while (gs.bankrupt[gs.realPlayers[ni]] && guard++ < gs.realPlayers.length) {
    ni = (ni + 1) % gs.realPlayers.length;
  }

  // If wrapped around — cop takes his turn first
  if (ni <= curRealIdx && curRealIdx !== 0) {
    gs.log.unshift('👮 Nieuwe ronde! Agent rijdt zijn ronde...');
    gs.current = 'cop';
    gs.currentIdx = gs.realPlayers.length;
    monoBroadcast(room);
    setTimeout(() => {
      if (room.gameState && room.gameState.current === 'cop') {
        monoCopTurn(room);
      }
    }, 1500);
    return;
  }

  gs.current = gs.realPlayers[ni];
  gs.currentIdx = ni;
  const nextName = room.clients.find(c => (c.userId || c.id) === gs.current)?.name || '?';
  gs.log.unshift(`▶️ ${nextName} is aan de beurt.`);
  monoBroadcast(room);
}

function handleMonopoly(room, clientId, ws, msg) {
  const client = room.clients.find(c => (c.userId || c.id) === clientId);
  if (msg.action === 'START_GAME') { if (client?.isHost) startMonopoly(room); return; }
  const gs = room.gameState;
  if (!gs) return;
  if (gs.current !== clientId) return;
  const name = client?.name || '?';

  // ROLL
  if (msg.action === 'ROLL' && !gs.rolled) {
    const d1 = Math.ceil(Math.random() * 6);
    const d2 = Math.ceil(Math.random() * 6);
    gs.dice = [d1, d2]; gs.rolled = true; gs.lastDiceSum = d1 + d2;

    // Jail handling
    if (gs.jail[clientId]) {
      gs.jailTurns[clientId]++;
      if (d1 === d2) {
        gs.jail[clientId] = false; gs.jailTurns[clientId] = 0;
        gs.log.unshift(`🎉 ${name} gooide dubbel! Vrij!`);
      } else if (gs.jailTurns[clientId] >= 3) {
        gs.jail[clientId] = false; gs.jailTurns[clientId] = 0;
        gs.money[clientId] = (gs.money[clientId] || 0) - 500;
        gs.log.unshift(`${name} betaalt €500 borgtocht en is vrij.`);
        monoCheckBankruptcy(gs, clientId, name);
      } else {
        gs.log.unshift(`${name} in de bak. Poging ${gs.jailTurns[clientId]}/3 — geen dubbel.`);
        monoBroadcast(room); return;
      }
    }

    const oldPos = gs.pos[clientId];
    gs.pos[clientId] = (oldPos + d1 + d2) % 40;
    const newPos = gs.pos[clientId];

    if (newPos < oldPos && !gs.jail[clientId]) {
      gs.money[clientId] = (gs.money[clientId] || 0) + 2000;
      gs.log.unshift(`💰 ${name} passeert START en pakt €2.000!`);
    }

    const sq = MONO_BOARD[newPos];
    gs.log.unshift(`🎲 ${name} gooit ${d1}+${d2}=${d1 + d2} en landt op ${sq.emoji} ${sq.n}`);

    if (sq.t === 'gotojail') {
      gs.pos[clientId] = 10; gs.jail[clientId] = true;
      gs.log.unshift(`🔒 ${name} gaat DIRECT naar de gevangenis!`);
      gs.popup = { kind: 'jail_card' }; gs.phase = 'popup';
    } else if (sq.t === 'tax') {
      gs.money[clientId] = (gs.money[clientId] || 0) - sq.a;
      monoCheckBankruptcy(gs, clientId, name);
      gs.popup = { kind: 'tax_card', sq }; gs.phase = 'popup';
    } else if (sq.t === 'chance') {
      const card = monoDrawCard(gs, 'chance');
      gs.pendingCard = { card, pid: clientId };
      gs.popup = { kind: 'chance_card', card }; gs.phase = 'popup';
    } else if (sq.t === 'chest') {
      const card = monoDrawCard(gs, 'chest');
      gs.pendingCard = { card, pid: clientId };
      gs.popup = { kind: 'chest_card', card }; gs.phase = 'popup';
    } else if ((sq.t === 'prop' || sq.t === 'rr' || sq.t === 'util') && !gs.props[newPos]) {
      gs.popup = { kind: 'buy_card', sq, sqIdx: newPos }; gs.phase = 'popup';
    } else if ((sq.t === 'prop' || sq.t === 'rr' || sq.t === 'util') && gs.props[newPos] && gs.props[newPos].ownerId !== clientId) {
      const rent = monoCalcRent(newPos, gs);
      const ownerName = room.clients.find(c => (c.userId || c.id) === gs.props[newPos].ownerId)?.name || '?';
      gs.pendingRent = { sqIdx: newPos, rent, ownerId: gs.props[newPos].ownerId };
      gs.popup = { kind: 'rent_card', sq, rent, ownerName }; gs.phase = 'dash';
    }
    monoBroadcast(room); return;
  }

  // CLOSE POPUP
  if (msg.action === 'CLOSE_POPUP' && gs.phase === 'popup') {
    if (gs.pendingCard) {
      monoApplyCard(room, clientId, gs.pendingCard.card);
      gs.pendingCard = null;
    }
    gs.popup = null; gs.phase = 'playing';
    monoBroadcast(room); return;
  }

  // BUY
  if (msg.action === 'BUY' && gs.phase === 'popup') {
    const sqIdx = gs.popup?.sqIdx ?? gs.pos[clientId];
    const sq = MONO_BOARD[sqIdx];
    if (!gs.props[sqIdx] && (gs.money[clientId] || 0) >= (sq.p || 9999)) {
      gs.money[clientId] -= sq.p;
      gs.props[sqIdx] = { ownerId: clientId, level: 0 };
      gs.log.unshift(`🏠 ${name} koopt ${sq.emoji} ${sq.n} voor €${sq.p.toLocaleString('nl')}!`);
    }
    gs.popup = null; gs.phase = 'playing';
    monoBroadcast(room); return;
  }

  // UPGRADE
  if (msg.action === 'UPGRADE') {
    const sqIdx = msg.sqIdx;
    const prop = gs.props[sqIdx];
    if (!prop || prop.ownerId !== clientId || prop.level >= 5) return;
    const sq = MONO_BOARD[sqIdx];
    const cost = monoUpgradeCost(sq);
    if ((gs.money[clientId] || 0) < cost) {
      send(ws, { type: 'TOAST', text: `Upgrade kost €${cost}. Te weinig!` });
      return;
    }
    gs.money[clientId] -= cost;
    prop.level++;
    gs.log.unshift(`${name} upgradet ${sq.emoji} ${sq.n} → ${MONO_LEVEL_EMOJI[prop.level]} ${MONO_LEVEL_NAMES[prop.level]}!`);
    monoBroadcast(room); return;
  }

  // DASH
  if (msg.action === 'DASH' && gs.phase === 'dash') {
    const pr = gs.pendingRent;
    const success = Math.random() < 0.30;
    if (success) {
      gs.log.unshift(`💨 ${name} dashte weg! Ontsnapt aan de huur! 🏃`);
    } else {
      const pay = pr.rent * 2;
      gs.money[clientId] = (gs.money[clientId] || 0) - pay;
      gs.money[pr.ownerId] = (gs.money[pr.ownerId] || 0) + pay;
      const ownerName = room.clients.find(c => (c.userId || c.id) === pr.ownerId)?.name || '?';
      gs.log.unshift(`${name} probeerde te dashen maar GEPAKT! Betaalt DUBBEL €${pay} aan ${ownerName} 😂`);
      monoCheckBankruptcy(gs, clientId, name);
    }
    gs.pendingRent = null; gs.popup = null; gs.phase = 'playing';
    monoBroadcast(room); return;
  }

  // PAY RENT
  if (msg.action === 'PAY_RENT' && gs.phase === 'dash') {
    const pr = gs.pendingRent;
    gs.money[clientId] = (gs.money[clientId] || 0) - pr.rent;
    gs.money[pr.ownerId] = (gs.money[pr.ownerId] || 0) + pr.rent;
    const ownerName = room.clients.find(c => (c.userId || c.id) === pr.ownerId)?.name || '?';
    gs.log.unshift(`${name} betaalt €${pr.rent} huur aan ${ownerName}.`);
    monoCheckBankruptcy(gs, clientId, name);
    gs.pendingRent = null; gs.popup = null; gs.phase = 'playing';
    monoBroadcast(room); return;
  }

  // SPIN WHEEL (triggered when cop landed on player)
  if (msg.action === 'SPIN_WHEEL' && gs.phase === 'spinning') {
    const result = monoSpin();
    gs.spinResult = result;
    const victims = gs.spinVictims || [];
    victims.forEach(vid => {
      const vname = room.clients.find(c => (c.userId || c.id) === vid)?.name || '?';
      if (result.type === 'free') {
        gs.log.unshift(`🎉 ${vname} komt vrijuit! Agent had zijn donut.`);
      } else if (result.type === 'fine') {
        gs.money[vid] = (gs.money[vid] || 0) - result.v;
        gs.log.unshift(`💸 ${vname} betaalt €${result.v} boete!`);
        monoCheckBankruptcy(gs, vid, vname);
      } else if (result.type === 'jail') {
        gs.pos[vid] = 10; gs.jail[vid] = true;
        gs.log.unshift(`🔒 ${vname} gearresteerd door de agent!`);
      } else if (result.type === 'chase') {
        gs.pos[vid] = (gs.pos[vid] - 3 + 40) % 40;
        gs.log.unshift(`🏃 ${vname} ontsnapt maar gaat 3 stappen terug!`);
      }
    });
    gs.spinVictims = [];
    gs.phase = 'spin_result';
    monoBroadcast(room); return;
  }

  // CLOSE SPIN RESULT
  if (msg.action === 'CLOSE_SPIN' && gs.phase === 'spin_result') {
    gs.spinResult = null;
    monoCopDone(room); return;
  }

  // USE FREE PASS
  if (msg.action === 'USE_FREE_PASS') {
    if (!gs.freePass[clientId]) return;
    gs.freePass[clientId] = false; gs.jail[clientId] = false; gs.jailTurns[clientId] = 0;
    gs.log.unshift(`${name} gebruikt de vrijlatingspas! 🗝️`);
    monoBroadcast(room); return;
  }

  // END TURN
  if (msg.action === 'END_TURN') {
    monoEndTurn(room); return;
  }
}

// ==================== START ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`🎮 PartyGames on port ${PORT}`));

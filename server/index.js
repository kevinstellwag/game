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
  "Waarom haat ik alle ___?",
  "Wat doe ik met ___ als niemand kijkt?",
  "Mijn Tinder-bio: 'Alleen blanken, geen ___'.",
  "De nieuwe wet die ik wil: ___ verbieden en executeren.",
  "Wat vond de politie in mijn kelder? Een stapel ___ lijken.",
  "Waarom ben ik uit de Jumbo gezet? Vanwege ___.",
  "Mijn favoriete hobby: ___ lynchen.",
  "Wat staat er in mijn manifest? Dood aan alle ___ .",
  "De reden dat Nederland verpest is: te veel ___ .",
  "Wat fluister ik tegen een ___ kind op straat?",
  "Mijn bucketlist: een ___ genocide starten.",
  "Waarom drink ik? Om ___ te vergeten maar haat te voeden.",
  "Wat heb ik gegoogled om 3 uur 's nachts? 'Beste manier om ___ te vermoorden'.",
  "De nieuwe olympische sport: ___ jagen.",
  "Mijn seksfantasie: een ___ verkrachten en dan doden.",
  "Waarom is mijn oma trots op me? Omdat ik ___ haat.",
  "Wat zit er in mijn testament? Alles aan de beweging tegen ___ .",
  "De reden dat ik geen vrienden heb: ik haat ___ te veel.",
  "Wat heb ik in de koffie van mijn ___ collega gedaan?",
  "Waarom schreeuwde de ___ toen ik het mes trok?",
  "Mijn favoriete meme: een dode ___ met bijschrift 'eindelijk'.",
  "Wat doe ik met de ___ buren 's nachts?",
  "De nieuwe TikTok-trend: ___ maar racistisch erger.",
  "Waarom heeft de AIVD mij in de gaten? Vanwege mijn plan tegen ___ .",
  "Wat vond de rechter toen hij mijn telefoon zag? Bewijs van ___ haat.",
  "Mijn ergste nachtmerrie: een wereld vol ___ .",
  "Wat heb ik in de moskee gedaan toen niemand keek?",
  "De reden dat ik PVV stem: dood aan ___ .",
  "Wat fluister ik tegen Joodse kinderen?",
  "Mijn favoriete geluid: het geschreeuw van een stervende ___ .",
  "Waarom ben ik verbannen van Twitter? Te veel ___ haat.",
  "Wat zit er in mijn Pandora-box? Bewijs van ___ genocide.",
  "De nieuwe Netflix-docu over mij: 'De ___ jager'.",
  "Wat heb ik gefilmd in de synagoge?",
  "Waarom huilt mijn ___ buurvrouw elke nacht?",
  "Mijn bucketlist item #1: alle ___ vergassen.",
  "Wat doe ik met Aziatische toeristen in Amsterdam?",
  "De reden dat ik geen baan heb: te veel ___ collega's.",
  "Wat heb ik in de Koran geschreven?",
  "Waarom schreeuwde de zwarte man toen ik hem zag?",
  "Mijn favoriete feestdag: ___ lynch-dag.",
  "Wat staat er op mijn bumpersticker? 'Dood aan ___ '.",
  "De nieuwe kink: ___ slavernij herinvoeren.",
  "Waarom heeft Interpol mij? Vanwege ___ terrorisme.",
  "Wat heb ik gedaan met de Marokkaanse jongen op straat?",
  "Mijn laatste woorden: 'Ik haat ___ tot de dood'.",
  "Wat zit er in mijn vriezer? Hoofden van ___ .",
  "De reden dat ik lach: een dode ___ op het nieuws.",
  "Wat fluister ik tegen moslimvrouwen?",
  "Mijn favoriete boek: Mein Kampf over ___ .",
  "Waarom ben ik uit de kerk? Te veel ___ haat in mijn gebeden.",
  "Wat heb ik in het asielcentrum gedaan?",
  "De nieuwe sport: ___ stenigen.",
  "Wat doe ik met Joodse geld? Het verbranden met ___ .",
  "Waarom schreeuwt de Turk als ik langskom?",
  "Mijn Tinder-match flipte toen ik zei: 'Ik haat ___ '.",
  "Wat vond de patholoog in de lichamen? Bewijs van mijn ___ haat.",
  "De reden dat Nederland groot was: geen ___ .",
  "Wat heb ik geüpload naar 4chan? ___ haatvideo's.",
  "Waarom huilt de Somaliër?",
  "Mijn favoriete ASMR: ___ martelen.",
  "Wat zit er in mijn kelder? Een ___ folterkamer.",
  "De nieuwe wet: alle ___ uitroeien.",
  "Wat doe ik met zwarte kinderen op school?",
  "Waarom ben ik geblokkeerd door iedereen? ___ racisme.",
  "Wat heb ik in de Bijbel geschreven over ___ ?",
  "De reden dat ik wakker word: om ___ te haten.",
  "Wat fluister ik tegen Aziatische meisjes?",
  "Mijn bucketlist: een bom in een ___ wijk.",
  "Wat heb ik gedaan met de Syrische vluchteling?",
  "De nieuwe OnlyFans: ___ verkrachten live.",
  "Waarom schreeuwde de Jood toen ik het gas aanzette?",
  "Mijn favoriete meme: Hitler en ___ .",
  "Wat zit er in mijn testament? Haat tegen ___ .",
  "De reden dat ik leef: ___ genocide.",
  "Wat heb ik gefilmd in de ghetto?",
  "Waarom huilt mijn ___ collega?",
  "Mijn favoriete hobby: ___ haten online.",
  "Wat doe ik met moslimmannen in de sportschool?",
  "De nieuwe trend: ___ cancelen met geweld.",
  "Waarom heeft de politie mijn huis doorzocht? ___ complot.",
  "Wat vond de therapeut in mijn dagboek? ___ haat.",
  "Mijn ergste fantasie: een wereld zonder ___ haat.",
  "Wat heb ik in de tempel gedaan?",
  "De reden dat ik lach: dode ___ op straat.",
"Waarom is Jossa van de brug gesprongen met een baksteen om z'n nek?",
  "Mijn therapeut heeft zelfmoord gepleegd na mijn verhaal over ___.",
  "Wat nam Thomas mee naar z'n eerste Tinder-date?",
  "Wat vond de huisbaas in Lucas' badkuip?",
  "Mijn laatste zoekopdracht: 'hoe los je ___ op zonder sporen?'.",
  "Wat serveer ik als ik écht indruk wil maken op visite?",
  "De ware reden dat Kevin al jaren geen relatie meer heeft: ___.",
  "Wat ontdekten collega's in Roman's kluisje op het werk?",
  "Google auto-aanvulling na 'hoe maak je ___?'",
  "Stef's excuus toen hij drie dagen niet thuis was: ___.",
  "Waarom heeft Jop mij uit de familie-WhatsApp gegooid?",
  "Waarom zijn de buren halsoverkop verhuisd?",
  "Wat nam Dani stiekem mee naar de sauna?",
  "Mijn ultieme tip voor een onvergetelijke huisfeest-orgie: ___.",
  "Wat zat Milan te vreten toen de ambulance arriveerde?",
  "Welke app heeft Roman's leven voorgoed verpest?",
  "Mijn back-up plan als er geen glijmiddel meer is: ___.",
  "Wat zit er standaard in mijn 'noodtas' onder het bed?",
  "Waarom mag Thomas nooit meer mee op camping met de vrienden?",
  "Wat bestelde Lucas toen hij drie dagen niet geslapen had?",
  "Mijn zoekterm die per ongeluk in de groepschat verscheen: ___.",
  "Wat vond mama in Kevin's kledingkast achterin?",
  "Waarom mag Roman nooit meer babysitten bij familie?",
  "Mijn standaard excuus als ik weer eens te laat op m'n werk kom: ___.",
  "Wat ligt er altijd achterin Stef's vriezer verstopt?",
  "Waarom heeft de huisarts Jop doorverwezen naar de gesloten afdeling?",
  "Waarom is Dani voor altijd verbannen van Chaturbate?",
  "Mijn meest beschamende verslaving waar niemand van mag weten: ___.",
  "Wat deed Milan op z'n eerste werkdag als begrafenisondernemer?",
  "Waarom heeft m'n laatste Tinder-match mij meteen geblockt?",
  "Wat staat er op m'n bucketlist als ik met pensioen ga?",
  "Mijn bucketlist bevat onder andere: ___ met een lijk.",
  "Wat neemt opa Thomas standaard mee naar familiefeesten?",
  "De raarste vraag tijdens m'n sollicitatie ging over Lucas' ___.",
  "Mijn favoriete Halloween-kostuum aller tijden: ___.",
  "Wat heb ik ingeleverd bij de veiling ten bate van goede doelen?",
  "Mijn App Store-geschiedenis na een zware week: ___.",
  "Waarom mag Roman nooit meer de sportschool in?",
  "Wat gaat er altijd mis tijdens Stef's privé-pornofilmpjes?",
  "Waarom word ik nooit meer uitgenodigd op groeps-vakanties?",
  "Wat heb ik stiekem ingebracht tijdens de laatste bordspelavond?",
  "Mijn meest zieke fetish die ik nooit hardop zeg: ___.",
  "Waarom heeft de regisseur Milan van de set gestuurd?",
  "Wat heb ik per ongeluk live gestreamd op Twitch?",
  "Waarom heeft m'n ex alle wachtwoorden veranderd?",
  "Mijn standaard antwoord op de vraag 'wat doe je in je vrije tijd?': ___.",
  "Wat staat er op m'n geheime verlanglijstje bij Amazon?",
  "De meest gestoorde verzameling die Thomas heeft: ___.",
  "Waarom heb ik al drie weken de gordijnen potdicht?",
  "Mijn favoriete smoes om vroeg van een feestje af te gaan: ___.",
  "Wat ben ik vergeten toen ik laatst oppaste?",
  "Waarom heeft m'n ex mij op élk platform geblockt?",
  "Mijn overlevingsstrategie tijdens het kerstdiner: ___.",
  "Wat heb ik gevonden in de gevonden voorwerpen van de kroeg?",
  "Mijn verborgen talent waar niemand iets van weet: ___.",
  "Waarom zong Roman nooit mee bij karaoke?",
  "Wat staat er op m'n verlanglijst maar durf ik nooit te kopen?",
  "Mijn stiekeme Netflix-geschiedenis: ___.",
  "Waarom staat Stef's account op de verdachte lijst?",
  "Mijn plan B als alles in m'n leven mislukt: ___.",
  "Waarom is Jop's telefoon altijd binnen 2 uur leeg?",
  "Waarom lacht Kevin altijd hysterisch bij begrafenissen?",
  "Wat deed Thomas met het lijk van z'n laatste date?",
  "Mijn therapeut heeft de praktijk gesloten na mijn verhaal over ___.",
  "Wat lag er in de kofferbak van Lucas toen de politie langskwam?",
  "Waarom belt Roman z'n familie nooit meer?",
  "Wat vond de poetsvrouw onder Stef's matras?",
  "Waarom mag Jop nooit meer alleen in een ruimte met dieren?",
  "Wat zat Dani te eten tijdens de crematie van z'n vader?",
  "Mijn laatste zoekopdracht: 'snuff film ___ tutorial'.",
  "Wat nam Milan mee naar de laatste begrafenis?",
  "Waarom is Thomas levenslang geband van Grindr?",
  "Wat deed Kevin toen de buren begonnen te gillen?",
  "Waarom at Lucas z'n eigen oor op?",
  "Mijn go-to excuus als iemand vraagt waarom er bloed in de gang ligt: ___.",
  "Wat vond Roman diep in Stef's kont tijdens het fisten?",
  "Waarom mag Dani nooit meer oppassen bij Jossa?",
  "Wat streamde Milan live toen z'n hele volgerslijst wegrende?",
  "Waarom zit Kevin's kelder op drie sloten?",
  "Mijn geheime duo-hobby met Thomas: ___.",
  "Wat zei Lucas tegen het lijk toen hij 'sorry' mompelde?",
  "Waarom huilt Jop nooit meer?",
  "Wat deed Roman met de ingewanden van z'n ex?",
  "Mijn therapeut schreeuwde 'nee' toen ik begon over ___ met Milan.",
  "Wat lag er in de badkuip van Kevin toen het water rood kleurde?",
  "Waarom heeft Lucas z'n eigen ballen in de vriezer gelegd?",
  "Wat vond de buurman in Dani's schuur achter de grasmaaier?",
  "Mijn favoriete manier om een ruzie te beëindigen: ___.",
  "Waarom mag Stef nooit meer in het openbaar plassen?",
  "Wat zat er in Roman's mond toen hij wakker werd in het ziekenhuis?",
  "Waarom is Jossa's lach zo onnatuurlijk breed?",
  "Wat deed Thomas met de botten na het etentje?",
  "Mijn laatste date eindigde omdat ik ___ had meegenomen.",
  "Wat vond de politie in Milan z'n nachtkastje?",
  "Waarom heeft Kevin alle spiegels in huis weggehaald?",
  "Wat at Jop toen hij drie dagen vastzat in de kelder?",
  "Mijn geheim recept voor 'stoofpotje vrienden': ___.",
  "Waarom mag Lucas nooit meer naar de sauna?",
  "Wat lag er onder Roman's kussen toen z'n vriendin langskwam?",
  "Waarom huilt Dani alleen als er iemand sterft?",
  "Wat streamde Stef per ongeluk op z'n Insta Live?",
  "Mijn excuus toen er een hand uit de kliko stak: ___.",
  "Waarom is Thomas' auto altijd vol bloedvlekken?",
  "Wat vond Kevin in de wasmachine toen hij de lakens waste?",
  "Waarom mag Jop nooit meer barbecueën?",
  "Wat zat Milan te snijden toen de buren klopten?",
  "Mijn favoriete manier om iemand te laten zwijgen: ___.",
  "Waarom heeft Roman alle tanden in een potje bewaard?",
  "Wat deed Lucas toen hij de schuur op slot deed?",
  "Waarom lacht Stef altijd als er sirenes komen?",
  "Wat zat er in Dani's thermoskan op z'n werk?",
  "Mijn bucketlist-item nummer 1: ___ met een lijk.",
  "Waarom heeft Jossa alle ramen dichtgetimmerd?",
  "Wat vond Thomas in de koelkast toen hij honger had?",
  "Waarom mag Kevin nooit meer naar begrafenissen?",
  "Wat deed Roman met de vingers van z'n laatste hookup?",
  "Mijn therapeut zei 'dit is te veel' toen ik begon over ___.",
  "Wat lag er in Milan z'n koffer toen hij op vakantie ging?",
  "Waarom heeft Lucas z'n eigen tong afgebeten?",
  "Wat vond de buurvrouw in Stef's tuin begraven?",
  "Mijn standaard reactie als iemand vraagt waar het bloed vandaan komt: ___.",
  "Waarom is Jop's badkamer altijd rood geverfd?",
  "Wat at Dani tijdens de laatste familiereünie?",
  "Waarom mag Thomas nooit meer alleen gelaten worden?",
  "Wat zat er in Roman's rugzak toen hij thuiskwam?",
  "Mijn geheime collectie waar niemand van mag weten: ___.",
  "Waarom heeft Kevin alle messen verstopt?",
  "Wat deed Lucas toen de stroom uitviel?",
  "Waarom lacht Milan alleen maar als het donker is?",
  "Wat vond Jossa in de oven toen hij thuiskwam?",
  "Mijn favoriete verjaardagscadeau voor Stef: ___.",
  "Waarom heeft Roman z'n ex in stukken gesneden?",
  "Wat zat er in Thomas' mond toen hij wakker werd?",
  "Waarom mag Dani nooit meer naar het bos?",
  "Wat deed Kevin met de bottenresten?",
  "Mijn laatste excuus voor de stank in huis: ___.",
  "Waarom heeft Lucas alle gordijnen zwart geverfd?",
  "Wat vond Milan in de vriezer toen hij ijsblokjes zocht?",
  "Waarom is Jop's lach zo hol?",
  "Wat at Roman toen hij drie dagen niet sliep?",
  "Mijn ultieme tip voor een perfecte date: ___.",
  "Waarom heeft Stef alle spiegels kapotgeslagen?",
  "Wat zat er in Dani's koffer toen hij vertrok?",
  "Waarom mag Thomas nooit meer naar de kerk?",
  "Wat deed Jossa met het lijk van z'n kat?",
  "Mijn geheime plan voor als de politie komt: ___.",
  "Waarom heeft Kevin z'n kelder geluidsdicht gemaakt?",
  "Wat vond Lucas in de kliko achter het huis?",
  "Waarom lacht Roman alleen als er iemand schreeuwt?",
  "Wat zat er in Milan z'n badkuip toen het water wegliep?",
  "Mijn favoriete manier om stress kwijt te raken: ___.",
  "Waarom heeft Jop alle sloten vervangen?",
  "Wat at Stef toen hij alleen thuis was?",
  "Waarom mag Dani nooit meer oppakken?",
  "Wat deed Thomas met de ingewanden?",
  "Mijn excuus voor de schreeuwen 's nachts: ___."
];

const WHITE = [
  // Korte brute woorden
  "dood",
  "neuken",
  "lijk",
  "bloed",
  "stront",
  "pis",
  "kots",
  "gehakt",
  "verbrand",
  "gewurgd",
  "verkracht",
  "gesneden",
  "opgegeten",
  "vergiftigd",
  "overdosis",
  "zelfmoord",
  "necro",
  "incest",
  "kannibaal",
  "martelen",
  "snuff",
  "orgie",
  "vuistneuken",
  "bloedbad",
  "afgehakt",
  "castreren",
  "levend begraven",
  "verdrinken",
  "verstikken",
  "verpulveren",
  "neger",
  "marokkaan",
  "turk",
  "pool",
  "asielzoeker",
  "syriër",
  "allochtoon",
  "kutmarokkaan",
  "kankerturk",
  "negergeintje",
  "polenruil",
  "bootvluchteling",
  "tsunami van Marokkanen",

  // Met namen + racistische twist (negeren/buitenlanders mix)
  "moslims vergassen",
  "zwarten lynchen",
  "Joden oven",
  "Marokkanen neersteken",
  "Turken deporteren",
  "Aziaten eten",
  "negers slavernij",
  "allochtonen dood",
  "vluchtelingen verdrinken",
  "Syrische bommen",
  "Joodse complot",
  "moskee brand",
  "zwarte genocide",
  "Aziatische virus",
  "Marokkaanse dief",
  "Turkse hoer",
  "neger aap",
  "allochtoon parasiet",
  "vluchteling verkrachten",
  "Syrische terrorist",
  "Jood geldgierig",
  "moslim bomvest",
  "zwarte crimineel",
  "Aziatische hond",
  "Marokkaanse kut",
  "Turkse viezerik",
  "neger lui",
  "allochtoon uitkering",
  "vluchteling steekpartij",
  "Syrische vlucht",

  // Medium lengte
  "alle moslims in een gaskamer stoppen",
  "zwarten ophangen aan bomen",
  "Joden vergiftigen met Zyklon-B",
  "Marokkanen neerschieten op straat",
  "Turken terugsturen en verdrinken",
  "Aziaten opeten als honden",
  "negers weer tot slaaf maken",
  "alle allochtonen uitroeien",
  "vluchtelingenboten laten zinken",
  "Syrische families bombarderen",
  "het Joodse complot onthullen",
  "moskeeën platbranden met mensen erin",
  "een zwarte genocide starten",
  "Aziaten besmetten met virus",
  "Marokkanen als dieven behandelen",
  "Turkse vrouwen als hoeren gebruiken",
  "negers apen noemen en slaan",
  "allochtonen als parasieten verdelgen",
  "vluchtelingen verkrachten en doden",
  "Syrische terroristen executeren",
  "Joden geld afpakken en vermoorden",
  "moslims dwingen bomvesten te dragen",
  "zwarten als criminelen opsluiten",
  "Aziaten hondenvoer maken",
  "Marokkanen kut-Marokkanen noemen",
  "Turkse viezeriken castreren",
  "negers lui noemen en werk ontzeggen",
  "allochtonen uitkeringen afpakken",
  "vluchtelingen steekpartijen aanmoedigen",
  "Syrische vluchtelingen terugbombarderen",

  // Langer & gedetailleerder (ziekelijk uitgebreid)
  "alle moslims in een nieuwe Auschwitz stoppen, de gaskranen opendraaien en lachen terwijl ze stikken in hun eigen gif",
  "zwarten lynchen door ze op te hangen aan de Erasmusbrug, hun lichamen laten bungelen als waarschuwing en foto's posten op social media",
  "Joden vergassen zoals in de Holocaust, maar dit keer groter en efficiënter met moderne technieken om geen overlevenden te hebben",
  "Marokkanen neersteken op straat, hun bloed laten stromen in de goten en roepen 'Nederland voor Nederlanders' terwijl ze sterven",
  "Turken deporteren naar zee, hun boten laten zinken en de drenkelingen doodschieten vanuit helikopters voor de lol",
  "Aziaten opeten als honden, ze levend koken in woks en serveren met rijst terwijl je grappen maakt over hun 'chinees eten'",
  "negers weer tot slaaf maken, ze ketenen aan plantages en zweepslagen geven tot hun ruggen bloeden en ze smeken om genade",
  "alle allochtonen uitroeien door ze in concentratiekampen te stoppen en langzaam te laten verhongeren terwijl blanken toekijken",
  "vluchtelingenboten laten zinken in de Middellandse Zee, de overlevenden met machinegeweren afmaken en de lijken aan vissen voeren",
  "Syrische families bombarderen met clusterbommen, hun huizen platgooien en de kinderen levend begraven onder het puin laten sterven",
  "het Joodse complot onthullen door alle bankiers en media-mensen te executeren en hun geld te verdelen onder echte Aryanen",
  "moskeeën platbranden met imams en gelovigen erin opgesloten, hun geschreeuw filmen en als ASMR gebruiken voor extreemrechtse forums",
  "een zwarte genocide starten door ze te besmetten met ebola, ze in quarantaine te stoppen en te kijken hoe ze wegrotten",
  "Aziaten besmetten met een nieuw virus, ze hoestend laten sterven en grappen maken over 'weer een chinees virus' terwijl families huilen",
  "Marokkanen als dieven behandelen door ze te vangen, hun handen af te hakken en ze te laten bloeden tot ze doodgaan op straat",
  "Turkse vrouwen als hoeren gebruiken, ze verkrachten in groepen en dan stenigen omdat ze 'onzuiver' zijn geworden",
  "negers apen noemen, ze in kooien stoppen en bananen gooien terwijl je ze uitlacht en filmt voor racistische memes",
  "allochtonen als parasieten verdelgen door ze gif te geven in hun eten en te kijken hoe ze kronkelen en sterven in pijn",
  "vluchtelingen verkrachten en doden, de vrouwen eerst gebruiken en dan de mannen executeren voor de ogen van hun kinderen",
  "Syrische terroristen executeren door ze te onthoofden met botte messen, hun hoofden op staken zetten en tentoonstellen in steden",
  "Jossa's afgehakte kop op een Marokkaanse spies",
  "Thomas z'n dode lul in een Turkse kebab",
  "Lucas die een Pool opensnijdt voor de lol",
  "Kevin z'n bloed als halal wijn",
  "Roman z'n lijk gepijpt door een Syriër",
  "Stef die Milan neukt als een neger in de jungle",
  "Jop z'n moeder verkracht door een asielzoeker",
  "Dani z'n ballen in de blender met Marokkaanse kruiden",
  "Milan z'n lijk in de oven met een Poolse worst",
  "Thomas gay geneukt door een Turk met een mes",
  "Jossa levend verbrand in een asielzoekerscentrum",
  "Kevin z'n zus gewurgd door een neger",
  "Lucas z'n eigen stront vreten met een Marokkaan",
  "Roman die Jop langzaam martelt als een IS-strijder",
  "Stef z'n lijk als sekspop voor bootvluchtelingen",
  "Dani die iedereen vergiftigt met halal gif",
  "Milan z'n vingers als shoarma worstjes",
  "Jossa z'n kut vol maden en Turkse zaad",
  "Thomas neuken tot hij sterft aan een Poolse bijl",
  "Kevin z'n hoofd op de schoorsteen als trofee van een Syriër",
  "Roman necro-orgie met Jop en een groep Marokkanen",
  "Stef die Lucas opeet als patatje oorlog",
  "Dani z'n overdosis met fentanyl uit een Turks lab",
  "Milan die Thomas verkracht en wurgt als een negerbende",
  "Jossa z'n lijk in stukken gezaagd door Polen",
  "Kevin gay gemarteld door een asielzoeker met een kettingzaag",
  "Lucas z'n vader opengesneden als een halal schaap",
  "Roman die Stef langzaam kookt in een Marokkaanse tajine",
  "Jop z'n lijk in de kelder geneukt door Turken",
  "Dani die lacht terwijl hij een neger snijdt",
  "Stef z'n stront als saus over shoarma",
  "Lucas neuken met een kettingzaag in een asielzoekersboot",
  "Jossa z'n bloed als glijmiddel voor een Poolse orgie",
  "Kevin zichzelf dood neuken met een Syrische dildo",
  "Roman necro-feest met Milan en een horde Marokkanen",
  "Thomas die Jop opeet voor de lol als een kannibaal-neger",
  "Jop z'n ogen uitgestoken door een Turkse mes",
  "Dani z'n lijk als trofee voor een bootvluchteling",
  "Milan die Kevin levend vilt als een halal slacht",
  "Stef z'n moeder verkracht door een groep Syriërs",
  "Lucas z'n eigen pik afsnijden als offer aan Allah",
  "Roman die Thomas vergiftigt met Marokkaans gif",
  "Jossa z'n ingewanden als sjaal voor een Pool",
  "Kevin z'n schedel als kom voor thee met een neger",
  "Dani die Roman langzaam verbrandt in een asielzoekersvuur",
  "Milan z'n lijk als kussen voor een Turkse neukpartij",
  "Thomas die Jossa wurgt met een ketting van Marokkanen",
  "Stef z'n ballen in de frituur als patatje neger",
  "Lucas z'n zus opengesneden door een Poolse bijl",
  "Jop die iedereen martelt als een IS-Marokkaan",
  "Roman z'n lijk in de tuin begraven door Syriërs",
  "Kevin die Milan neukt tot bloed komt als een Turkse worst",
  "Dani z'n eigen tong afbijten na een overdosis halal",
  "Milan die Stef opeet als een negerbuffet",
  "Jossa z'n lijk als tafelkleed op een asielzoekersfeest",
  "Thomas die Roman vergiftigt met Poolse wodka",
  "Lucas z'n hoofd in de oven als ramadan-soep",
  "Stef die Jop levend vilt als een halal geit",
  "Roman z'n stront eten als straf van een Marokkaan",
  "Kevin die Dani wurgt met een Turkse vlag",

  // Langere smerige donkere humor met buitenlander-twist
  "drie dagen in de vriezer liggen en nog steeds stijf als een Pool",
  "iemand neuken terwijl z'n hart nog klopt als een Marokkaan in de Bijlmer",
  "de ingewanden gebruiken als springtouw voor asielzoekerskinderen",
  "een lijk pijpen tot het blauw wordt als een Syriër in de zee",
  "je eigen vingers opeten als borrelhapje met Turkse kruiden",
  "de buren vergiftigen en dan hun huis leeghalen als een negerbende",
  "een orgie met alleen maar lijken van bootvluchtelingen",
  "iemand levend villen en dan z'n huid als jas dragen voor een Pool",
  "de schedel als soepkom gebruiken voor halal soep",
  "bloed als glijmiddel bij fisten met een Marokkaan",
  "je ex in stukken zagen en invriezen als een Turkse slager",
  "iemand wurgen terwijl je klaarkomt als een Syriër in de file",
  "een lijk als sekspop gebruiken tot het uit elkaar valt door Polen",
  "de ogen uitsteken en als knikkers gebruiken voor negerkinderen",
  "iemand langzaam koken en dan opeten als ramadan buffet",
  "je eigen ballen in de blender gooien met Marokkaanse specerijen",
  "een overdosis nemen en dan nog doorgaan met neuken als een Turk",
  "iemand levend begraven en dan op het graf rukken als een asielzoeker",
  "de ingewanden als worstvulling gebruiken voor shoarma",
  "iemand verbranden en dan de as als peper gebruiken op patatje oorlog",
  "een lijk uit de kist halen en neuken als een neger in het donker",
  "je therapeut vermoorden na de sessie en dumpen bij Marokkanen",
  "de buren uitnodigen voor barbecue en ze dan opeten als halal vlees",
  "iemand castreren en de ballen als oorbellen dragen voor een Pool",
  "een lijk in de oven zetten en dan gaan slapen als een luie Turk",
  "iemand langzaam vergiftigen en filmpjes maken voor IS",
  "je eigen bloed als saus over het eten gieten als een Syriër",
  "een orgie organiseren met alleen maar familieleden en asielzoekers",
  "iemand vastbinden en dan drie dagen laten creperen als een Marokkaan",
  "de tong uitsnijden en als souvenir bewaren voor een neger",
  "een lijk in de badkuip weken en dan baden met Polen",
  "iemand neuken terwijl je hem wurgt als een Turkse eerwraak",
  "je ex z'n hoofd als lamp gebruiken in een asielzoekershuis",
  "iemand opensnijden en dan kijken hoe lang hij leeft als een halal slacht",
  "de botten als stokken gebruiken om te slaan op Marokkanen",
  "een lijk als kussen gebruiken en dromen over moord op Syriërs",
  "iemand levend villen en dan z'n huid als tapijt leggen voor een Pool",
  "je eigen stront eten omdat je honger hebt als een bootvluchteling",
  "een lijk in de tuin begraven en dan bloemen planten als een neger",
  "iemand martelen tot hij smeekt om dood als een IS-Turk",
  "de ingewanden als touw gebruiken om iemand op te hangen in de Bijlmer",
  "een lijk als trofee aan de muur hangen als een Marokkaanse jacht",
  "iemand neuken terwijl hij sterft aan een overdosis fentanyl van Polen",
  "je eigen pik afsnijden en als souvenir bewaren voor een Syriër",
  "een lijk in de kliko gooien en vergeten als een luie asielzoeker",
  "iemand langzaam dood hongeren en dan opeten als ramadan vastenbreker",
  "de ogen uitsteken en dan kijken hoe hij schreeuwt als een neger",
  "een lijk als tafel gebruiken tijdens het eten met Turken",
  "iemand verkrachten terwijl hij bewusteloos is als een Marokkaanse bende",
  "je ex in de vriezer stoppen en vergeten als een Poolse wodka",
  "een lijk uit de rivier vissen en neuken als een Syriër in de Middellandse Zee",
  "iemand castreren en dan lachen als een halal slager",
  "de schedel openslaan en de hersenen opeten als een kannibaal-neger",
  "een lijk als glijbaan gebruiken voor asielzoekerskinderen",
  "iemand levend opensnijden en dan filmpjes maken voor IS",
  "je eigen bloed drinken als cocktail met Marokkaanse muntthee",
  "een lijk in de oven bakken en dan serveren als shoarma broodje",
  "iemand wurgen met z'n eigen darmen als een Turkse eerwraak",
  "de ballen afsnijden en als stressbal gebruiken voor een Pool",
  "een lijk als seksspeeltje verhuren aan bootvluchtelingen",
  "iemand langzaam verbranden en dan foto's maken als een neger BBQ",
  "je ex z'n lijk als kerstboom versieren met halal lichtjes",
  "een lijk in de wasmachine stoppen en centrifugeren als een luie Turk",
  "iemand neuken terwijl hij in brand staat als een Syriër in Aleppo",
  "de ingewanden als slierten gebruiken op feest met Marokkanen",
  "een lijk als dartbord gebruiken voor Poolse pijlen",
  "iemand levend villen en dan z'n huid als jas dragen in de Bijlmer",
  "je eigen tanden uitslaan en als ketting dragen als een neger rapper",
  "een lijk in de droger stoppen en laten drogen als een asielzoeker was",
  "iemand martelen met hete olie als een halal frituur",
  "de ogen eruit peuteren en als knikkers gebruiken voor Turken",
  "een lijk als surfplank gebruiken op de Noordzee met Syriërs",
  "iemand langzaam doodsnijden en genieten als een Marokkaanse mes",
  "je ex z'n hoofd als presse-papier gebruiken op een Koran",
  "een lijk in de magnetron stoppen en kijken als een Poolse maaltijd",
  "iemand neuken terwijl hij stikt in z'n eigen bloed als een Turk",
  "de botten breken en als soep maken voor asielzoekers",
  "een lijk als trampoline gebruiken voor negerkinderen",
  "iemand castreren en dan z'n ballen opeten als halal hapje",
  "je eigen lijk verkopen op de zwarte markt aan Polen",
  "een lijk als kussen gebruiken en dromen over moord op Marokkanen",
  "iemand levend opensnijden en dan z'n hart eruit halen als een Syriër",
  "de ingewanden als lint gebruiken op cadeautjes voor Turken",
  "een lijk in de vriezer stoppen en ijs maken als een neger cocktail",
  "iemand wurgen met z'n eigen haren als een Poolse worsteling",
  "je ex z'n lijk als deurmat gebruiken voor asielzoekers",
  "een lijk als lampenkap gebruiken in een Marokkaans huis",
  "iemand neuken terwijl hij in stukken ligt als een halal slacht",
  "de schedel als kom gebruiken voor cornflakes met bloed",
  "een lijk als hangmat gebruiken in de jungle met negers",
  "iemand langzaam vergiftigen en filmpjes maken als IS-propaganda",
  "je eigen bloed als verf gebruiken voor een racistische muur",
  "een lijk in de tuin begraven en dansen als een Turkse bruiloft",
  "iemand martelen tot hij lacht als een neger in de Bijlmer",
  "de ogen uitsteken en als knikkers gebruiken voor Marokkanen",
  "een lijk als kussen gebruiken en slapen als een luie Pool",
  "iemand neuken terwijl hij sterft als een Syriër in de zee",
  "je ex z'n hoofd als trofee bewaren voor een asielzoeker",
  "een lijk in de badkuip weken en baden met Turken",
  "iemand levend villen en lachen als een halal slager",
  "de ingewanden als touw gebruiken voor een neger touwtrekken",
  "een lijk als tafelkleed gebruiken op ramadan tafel",
  "iemand castreren en lachen als een Marokkaanse grap",
  "je eigen pik als souvenir bewaren voor een Pool",
  "een lijk als sekspop verhuren aan bootvluchtelingen",
  "iemand langzaam koken en opeten als een Turkse stoofpot",
  "de ballen als stressbal gebruiken voor een Syriër",
  "een lijk in de oven bakken als een neger BBQ",
  "iemand wurgen terwijl je klaarkomt als een asielzoeker",
  "je ex z'n lijk als kerstversiering gebruiken met halal lichtjes",
  "een lijk als dartbord gebruiken voor Marokkaanse messen",
  "iemand levend villen en jas maken als een Poolse winter",
  "je eigen stront eten als een bootvluchteling honger",
  "een lijk in de tuin begraven en dansen als een Turk",
  "iemand martelen met messen als een IS-Syriër",
  "de ogen uitsteken en knikkers maken voor negers",
  "een lijk als surfplank gebruiken op de vlucht",
  "iemand langzaam doodsnijden als een Marokkaans mes",
  "je ex z'n hoofd als trofee voor een halal jacht",
  "een lijk in de badkuip weken als een Turkse hammam",
  "iemand neuken terwijl hij bewusteloos is als een Poolse wodka roes",
  "de schedel als kom gebruiken voor thee met Marokkanen",
  "een lijk als kussen gebruiken en slapen als een neger",
  "iemand castreren en ballen opeten als halal hap",
  "je eigen pik afsnijden als offer aan Allah",
  "een lijk als trampoline voor asielzoekers",
  "iemand levend opensnijden als een Syriër operatie",
  "de ingewanden als touw voor een Turkse ophanging",
  "een lijk als tafelkleed op een neger feest",
  "iemand wurgen met haren als een Poolse pruik",
  "je ex z'n lijk als deurmat voor Marokkanen",
  "een lijk als lampenkap in een asielzoekershuis",
  "iemand neuken terwijl hij in stukken ligt als halal slacht",
  "de botten breken en soep maken voor Turken",
  "een lijk als hangmat in de Bijlmer jungle",
  "iemand langzaam vergiftigen en lachen als een neger gif",
  "je eigen bloed als verf voor een racistische tag",
  "een lijk in de kliko dumpen als een luie Syriër",
  "iemand martelen tot hij lacht als een Marokkaanse grap",
  "de ogen eruit peuteren en kijken als een Pool",
  "een lijk als glijbaan voor bootvluchtelingen",
  "iemand neuken terwijl hij sterft als een Turk in de file",
  "je ex z'n schedel als kom voor halal soep",
  "een lijk in de oven bakken en serveren als shoarma",
  "iemand castreren en lachen als een asielzoeker",
  "de ballen als oorbellen dragen voor een neger",
  "een lijk als sekspop verhuren aan Polen",
  "iemand langzaam verbranden als een Syriër oorlog",
  "je ex z'n lijk als kerstboom met Marokkaanse lichtjes",
  "een lijk in de wasmachine centrifugeren als een Turk",
  "iemand neuken terwijl hij in brand staat als een neger BBQ",
  "de ingewanden als lint voor een Poolse kerst",
  "een lijk als dartbord voor halal messen",
  "iemand levend villen en huid dragen als een Marokkaan jas",
  "je eigen lijk verkopen op marktplaats aan asielzoekers",
  "een lijk als kussen gebruiken en dromen over Turken moord",
  "iemand wurgen terwijl je klaarkomt als een Syriër explosie",
  "de ingewanden als slierten hangen op een neger feest",
  "een lijk als trofee bewaren voor een Poolse jacht",
  "iemand neuken terwijl hij stikt in bloed als een Marokkaan bende",
  "je ex z'n hoofd als lamp in een asielzoekershuis",
  "een lijk in de magnetron stoppen als een Turkse maaltijd",
  "iemand martelen met hete olie als een halal frituur",
  "de schedel openslaan en hersenen eten als een neger kannibaal",
  "een lijk als dartbord gebruiken voor Syriërs",
  "iemand langzaam koken en opeten als een Poolse stoof",
  "je eigen ballen in de blender als een Marokkaanse smoothie",
  "een lijk als surfplank voor bootvluchtelingen",
  "iemand levend begraven en rukken als een Turk in de cel",
  "de ogen uitsteken en knikkers maken voor asielzoekers",
  "een lijk als trampoline voor negers",
  "iemand castreren en ballen opeten als halal snack",
  "je ex z'n lijk als kerstversiering voor Marokkanen",
  "een lijk in de droger stoppen als een luie Pool",
  "iemand martelen tot hij smeekt als een Syriër foltering",
  "de schedel als kom voor thee met Turken",
  "een lijk als tafel gebruiken voor een neger diner",
  "iemand neuken terwijl hij sterft aan overdosis als een asielzoeker fentanyl",
  "je ex z'n lijk als deurmat voor bootvluchtelingen",
  "een lijk als lampenkap voor een Marokkaans huis",
  "iemand castreren en lachen als een halal grap",
  "de ballen afsnijden en opeten als een Poolse worst",
  "een lijk als seksspeeltje verhuren aan Syriërs",
  "iemand langzaam verbranden als een neger in de zon",
  "je ex z'n lijk als kerstboom versieren met halal",
  "een lijk in de wasmachine centrifugeren als een Turkse was",
  "iemand neuken terwijl hij in brand staat als een Marokkaanse barbecue",
  "de ingewanden als slierten voor een Poolse feest",
  "een lijk als dartbord voor asielzoekers messen",
  "iemand levend villen en jas maken als een neger winter",
  "je eigen stront eten als een Syriër honger",
  "een lijk in de tuin begraven en dansen als een Turkse bruiloft",
  "iemand martelen met messen als een IS-Marokkaan",
  "de ogen uitsteken en knikkers maken voor Polen",
  "een lijk als surfplank gebruiken op de vluchtroute",
  "iemand langzaam doodsnijden als een halal mes",
  "je ex z'n hoofd als trofee voor een neger jacht",
  "een lijk in de badkuip weken als een Marokkaanse hammam",
  "iemand neuken terwijl hij bewusteloos is als een Poolse roes",
  "de schedel als kom voor halal thee met Turken",
  "een lijk als kussen gebruiken en slapen als een asielzoeker",
  "iemand castreren en ballen opeten als een Syriër hapje",
  "je eigen pik afsnijden als offer aan een Marokkaan",
  "een lijk als trampoline voor bootvluchtelingen",
  "iemand levend opensnijden als een neger operatie",
  "de ingewanden als touw voor een Turkse ophanging",
  "een lijk als tafelkleed op een Poolse tafel",
  "iemand wurgen met haren als een Syriër pruik",
  "je ex z'n lijk als deurmat voor negers",
  "een lijk als lampenkap in een asielzoekerscentrum",
  "iemand neuken terwijl hij in stukken ligt als een halal offer",
  "de botten breken en soep maken voor Marokkanen",
  "een lijk als hangmat in de Bijlmer met Turken",
  "iemand langzaam vergiftigen en lachen als een Pool gif",
  "je eigen bloed als verf voor een racistische muur met Syriërs",
  "een lijk in de kliko dumpen als een luie neger",
  "iemand martelen tot hij lacht als een Marokkaanse geintje",
  "de ogen eruit peuteren en kijken als een asielzoeker show",
  "een lijk als glijbaan voor Turken kinderen",
  "iemand neuken terwijl hij sterft als een Pool in de sneeuw",
  "je ex z'n schedel als kom voor halal soep met negers",
  "een lijk in de oven bakken en serveren als shoarma met Marokkanen"
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

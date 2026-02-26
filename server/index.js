const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// ==================== DATABASE ====================
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('[DB] No DATABASE_URL — running without DB'); return; }
  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#4d96ff',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        last_seen TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS player_stats (
        player_id TEXT PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
        cah_wins INT DEFAULT 0,
        cah_losses INT DEFAULT 0,
        cah_rounds INT DEFAULT 0,
        czar_picks INT DEFAULT 0,
        cah_best_streak INT DEFAULT 0,
        cah_current_streak INT DEFAULT 0,
        cah_loser_rounds INT DEFAULT 0,
        mono_props_bought INT DEFAULT 0,
        mono_jail_visits INT DEFAULT 0,
        mono_money_earned INT DEFAULT 0,
        max_players_in_game INT DEFAULT 0,
        played_at_midnight BOOLEAN DEFAULT FALSE,
        total_score INT GENERATED ALWAYS AS (cah_wins * 3 + czar_picks + mono_money_earned / 1000) STORED
      );
      CREATE TABLE IF NOT EXISTS achievements (
        id SERIAL PRIMARY KEY,
        player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
        achievement_id TEXT NOT NULL,
        unlocked_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(player_id, achievement_id)
      );
      CREATE TABLE IF NOT EXISTS game_history (
        id SERIAL PRIMARY KEY,
        game_type TEXT NOT NULL,
        room_code TEXT NOT NULL,
        played_at TIMESTAMPTZ DEFAULT NOW(),
        player_count INT,
        winner_id TEXT REFERENCES players(id) ON DELETE SET NULL,
        winner_name TEXT,
        rounds_played INT DEFAULT 0,
        duration_seconds INT DEFAULT 0,
        metadata JSONB DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS game_history_players (
        game_id INT REFERENCES game_history(id) ON DELETE CASCADE,
        player_id TEXT REFERENCES players(id) ON DELETE CASCADE,
        player_name TEXT,
        score INT DEFAULT 0,
        finished_rank INT,
        PRIMARY KEY (game_id, player_id)
      );
      CREATE INDEX IF NOT EXISTS idx_achievements_player ON achievements(player_id);
      CREATE INDEX IF NOT EXISTS idx_game_history_player ON game_history_players(player_id);
      CREATE INDEX IF NOT EXISTS idx_game_history_played_at ON game_history(played_at DESC);
    `);
    console.log('[DB] Schema ready ✅');
  } catch(e) {
    console.error('[DB] Init error:', e.message);
  }
}
initDB();

// ==================== DB HELPERS ====================
const DB = {
  async upsertPlayer(id, name, color) {
    if (!process.env.DATABASE_URL) return;
    try {
      await db.query(`
        INSERT INTO players (id, name, color, last_seen) VALUES ($1, $2, $3, NOW())
        ON CONFLICT (id) DO UPDATE SET name=$2, color=$3, last_seen=NOW()
      `, [id, name, color || '#4d96ff']);
      await db.query(`
        INSERT INTO player_stats (player_id) VALUES ($1)
        ON CONFLICT (player_id) DO NOTHING
      `, [id]);
    } catch(e) { console.error('[DB] upsertPlayer:', e.message); }
  },

  async getPlayer(id) {
    if (!process.env.DATABASE_URL) return null;
    try {
      const r = await db.query(`
        SELECT p.*, ps.*, 
          COALESCE(json_agg(a.achievement_id) FILTER (WHERE a.achievement_id IS NOT NULL), '[]') as achievements
        FROM players p
        LEFT JOIN player_stats ps ON ps.player_id = p.id
        LEFT JOIN achievements a ON a.player_id = p.id
        WHERE p.id = $1
        GROUP BY p.id, ps.player_id, ps.cah_wins, ps.cah_losses, ps.cah_rounds,
          ps.czar_picks, ps.cah_best_streak, ps.cah_current_streak, ps.cah_loser_rounds,
          ps.mono_props_bought, ps.mono_jail_visits, ps.mono_money_earned,
          ps.max_players_in_game, ps.played_at_midnight, ps.total_score
      `, [id]);
      return r.rows[0] || null;
    } catch(e) { console.error('[DB] getPlayer:', e.message); return null; }
  },

  async updateCAHStats(id, { won, czarPick, players }) {
    if (!process.env.DATABASE_URL) return;
    try {
      const h = new Date().getHours();
      const midnight = h >= 0 && h < 4;
      if (won) {
        await db.query(`
          UPDATE player_stats SET
            cah_wins = cah_wins + 1,
            cah_rounds = cah_rounds + 1,
            czar_picks = czar_picks + $2,
            cah_current_streak = cah_current_streak + 1,
            cah_best_streak = GREATEST(cah_best_streak, cah_current_streak + 1),
            max_players_in_game = GREATEST(max_players_in_game, $3),
            played_at_midnight = played_at_midnight OR $4
          WHERE player_id = $1
        `, [id, czarPick ? 1 : 0, players || 2, midnight]);
      } else {
        await db.query(`
          UPDATE player_stats SET
            cah_losses = cah_losses + 1,
            cah_rounds = cah_rounds + 1,
            czar_picks = czar_picks + $2,
            cah_loser_rounds = cah_loser_rounds + 1,
            cah_current_streak = 0,
            max_players_in_game = GREATEST(max_players_in_game, $3),
            played_at_midnight = played_at_midnight OR $4
          WHERE player_id = $1
        `, [id, czarPick ? 1 : 0, players || 2, midnight]);
      }
      await DB.checkAchievements(id);
    } catch(e) { console.error('[DB] updateCAHStats:', e.message); }
  },

  async updateMonoStats(id, { propsBought, jailVisits, moneyEarned, players }) {
    if (!process.env.DATABASE_URL) return;
    try {
      await db.query(`
        UPDATE player_stats SET
          mono_props_bought = mono_props_bought + $2,
          mono_jail_visits = mono_jail_visits + $3,
          mono_money_earned = mono_money_earned + $4,
          max_players_in_game = GREATEST(max_players_in_game, $5)
        WHERE player_id = $1
      `, [id, propsBought||0, jailVisits||0, moneyEarned||0, players||2]);
      await DB.checkAchievements(id);
    } catch(e) { console.error('[DB] updateMonoStats:', e.message); }
  },

  ACHIEVEMENT_CONDITIONS: [
    { id: 'first_win',   check: s => s.cah_wins >= 1 },
    { id: 'five_wins',   check: s => s.cah_wins >= 5 },
    { id: 'czar_boss',   check: s => s.czar_picks >= 10 },
    { id: 'degen',       check: s => s.cah_rounds >= 50 },
    { id: 'monopolist',  check: s => s.mono_props_bought >= 20 },
    { id: 'jailbird',    check: s => s.mono_jail_visits >= 5 },
    { id: 'banker',      check: s => s.mono_money_earned >= 50000 },
    { id: 'streaker',    check: s => s.cah_best_streak >= 3 },
    { id: 'loser',       check: s => s.cah_loser_rounds >= 10 },
    { id: 'nightowl',    check: s => s.played_at_midnight },
    { id: 'politician',  check: s => s.cah_wins >= 1 && s.cah_losses >= s.cah_wins * 3 },
  ],

  async checkAchievements(playerId) {
    if (!process.env.DATABASE_URL) return [];
    try {
      const sRes = await db.query('SELECT * FROM player_stats WHERE player_id=$1', [playerId]);
      const achRes = await db.query('SELECT achievement_id FROM achievements WHERE player_id=$1', [playerId]);
      const s = sRes.rows[0]; if (!s) return [];
      const existing = new Set(achRes.rows.map(r => r.achievement_id));
      const newOnes = [];
      for (const { id, check } of DB.ACHIEVEMENT_CONDITIONS) {
        if (!existing.has(id) && check(s)) {
          await db.query('INSERT INTO achievements (player_id, achievement_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [playerId, id]);
          newOnes.push(id);
        }
      }
      return newOnes;
    } catch(e) { console.error('[DB] checkAchievements:', e.message); return []; }
  },

  async saveGame(gameType, roomCode, winnerId, winnerName, rounds, durationSecs, players, metadata) {
    if (!process.env.DATABASE_URL) return null;
    try {
      const r = await db.query(`
        INSERT INTO game_history (game_type, room_code, winner_id, winner_name, rounds_played, duration_seconds, player_count, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id
      `, [gameType, roomCode, winnerId||null, winnerName||null, rounds||0, durationSecs||0, players?.length||0, JSON.stringify(metadata||{})]);
      const gameId = r.rows[0].id;
      for (const p of (players||[])) {
        if (p.id && p.id !== 'cop') {
          await db.query(`
            INSERT INTO game_history_players (game_id, player_id, player_name, score, finished_rank)
            VALUES ($1,$2,$3,$4,$5)
            ON CONFLICT DO NOTHING
          `, [gameId, p.id, p.name, p.score||0, p.rank||null]);
        }
      }
      return gameId;
    } catch(e) { console.error('[DB] saveGame:', e.message); return null; }
  },

  async getLeaderboard(limit = 20) {
    if (!process.env.DATABASE_URL) return [];
    try {
      const r = await db.query(`
        SELECT p.id, p.name, p.color, ps.cah_wins, ps.czar_picks,
               ps.cah_rounds, ps.mono_money_earned, ps.cah_best_streak,
               ps.total_score,
               COUNT(DISTINCT a.achievement_id) as achievement_count
        FROM players p
        JOIN player_stats ps ON ps.player_id = p.id
        LEFT JOIN achievements a ON a.player_id = p.id
        GROUP BY p.id, p.name, p.color, ps.cah_wins, ps.czar_picks,
                 ps.cah_rounds, ps.mono_money_earned, ps.cah_best_streak, ps.total_score
        ORDER BY ps.total_score DESC
        LIMIT $1
      `, [limit]);
      return r.rows;
    } catch(e) { console.error('[DB] getLeaderboard:', e.message); return []; }
  },

  async getGameHistory(playerId, limit = 10) {
    if (!process.env.DATABASE_URL) return [];
    try {
      const r = await db.query(`
        SELECT gh.*, ghp.score, ghp.finished_rank
        FROM game_history gh
        JOIN game_history_players ghp ON ghp.game_id = gh.id
        WHERE ghp.player_id = $1
        ORDER BY gh.played_at DESC
        LIMIT $2
      `, [playerId, limit]);
      return r.rows;
    } catch(e) { console.error('[DB] getGameHistory:', e.message); return []; }
  },
};

// ==================== HTTP API ====================
app.get('/api/player/:id', async (req, res) => {
  const p = await DB.getPlayer(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

app.get('/api/leaderboard', async (req, res) => {
  const lb = await DB.getLeaderboard(20);
  res.json(lb);
});

app.get('/api/history/:id', async (req, res) => {
  const h = await DB.getGameHistory(req.params.id, 20);
  res.json(h);
});

app.get('/api/lobby', (req, res) => {
  // Return list of open (lobby phase) rooms for the home lobby
  const open = Object.values(rooms)
    .filter(r => r.phase === 'lobby' && r.clients.length > 0 && r.isPublic)
    .map(r => ({
      code: r.code,
      game: r.game,
      hostName: r.clients.find(c => c.isHost)?.name || '?',
      playerCount: r.clients.length,
      maxPlayers: r.maxPlayers || 8,
    }));
  res.json(open);
});

// ==================== KEEPALIVE ====================
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

// ==================== HOME LOBBY (pre-room chat + invites) ====================
// Players in the "home lobby" — before joining a room
const homeLobby = {
  clients: new Map(), // clientId -> { ws, name, color, dbId }
  chat: [],           // last 50 messages
};

function homeLobbyCast(data, skipId = null) {
  for (const [id, c] of homeLobby.clients) {
    if (id !== skipId) send(c.ws, data);
  }
}

function homeLobbyState() {
  return {
    players: [...homeLobby.clients.values()].map(c => ({
      id: c.clientId, name: c.name, color: c.color,
      inRoom: c.inRoom || null,
    })),
    openRooms: Object.values(rooms)
      .filter(r => r.phase === 'lobby' && r.isPublic)
      .map(r => ({
        code: r.code, game: r.game,
        hostName: r.clients.find(c => c.isHost)?.name || '?',
        playerCount: r.clients.length,
      })),
    chat: homeLobby.chat.slice(-30),
  };
}

// ==================== ROOMS ====================
const rooms = {};

function genCode() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function roomState(code) {
  const r = rooms[code];
  if (!r) return null;
  return {
    code,
    game: r.game,
    phase: r.phase,
    players: r.clients.map(c => ({ id: c.id, name: c.name, isHost: c.isHost, score: c.score || 0, color: c.color })),
    settings: r.settings,
    isPublic: r.isPublic || false,
  };
}

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function bcast(code, data, skip = null) {
  (rooms[code]?.clients || []).forEach(c => { if (c.id !== skip) send(c.ws, data); });
}

// ==================== WEBSOCKET ====================
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const clientId = uuidv4();
  let room = null;
  let inHomeLobby = false;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'PING') { send(ws, { type: 'PONG' }); return; }

    // ── HOME LOBBY ──────────────────────────────────────────────────────
    if (msg.type === 'HOME_JOIN') {
      // Player opens the app and enters the home lobby
      const name = (msg.name || 'Gast').slice(0, 20);
      const color = msg.color || '#4d96ff';
      const dbId = msg.dbId || null;
      homeLobby.clients.set(clientId, { clientId, ws, name, color, dbId, inRoom: null });
      inHomeLobby = true;
      if (dbId) DB.upsertPlayer(dbId, name, color);
      send(ws, { type: 'HOME_STATE', state: homeLobbyState(), yourId: clientId });
      homeLobbyCast({ type: 'HOME_STATE', state: homeLobbyState() }, clientId);
      return;
    }

    if (msg.type === 'HOME_CHAT') {
      if (!inHomeLobby) return;
      const c = homeLobby.clients.get(clientId);
      if (!c || !msg.text?.trim()) return;
      const m = {
        id: uuidv4(), senderId: clientId, senderName: c.name,
        senderColor: c.color, text: msg.text.slice(0, 200), time: Date.now(),
      };
      homeLobby.chat.push(m);
      if (homeLobby.chat.length > 50) homeLobby.chat.shift();
      homeLobbyCast({ type: 'HOME_CHAT', message: m });
      send(ws, { type: 'HOME_CHAT', message: m });
      return;
    }

    if (msg.type === 'INVITE') {
      // Host invites a specific player from the home lobby to join their room
      if (!room) return;
      const host = room.clients.find(c => c.id === clientId);
      if (!host?.isHost) return;
      const target = homeLobby.clients.get(msg.targetId);
      if (!target) return;
      send(target.ws, {
        type: 'INVITE',
        fromName: host.name,
        fromColor: host.color || '#4d96ff',
        game: room.game,
        code: room.code,
        roomCode: room.code,
      });
      return;
    }

    // ── ROOM ACTIONS ────────────────────────────────────────────────────
    if (msg.type === 'CREATE_ROOM') {
      let code;
      do { code = genCode(); } while (rooms[code]);
      rooms[code] = {
        code, game: msg.game || 'cah', phase: 'lobby',
        clients: [], gameState: null,
        settings: { maxPoints: 7 },
        chat: [],
        isPublic: msg.isPublic !== false, // public by default
        startedAt: Date.now(),
      };
      room = rooms[code];
      const color = msg.color || '#FF6B6B';
      const client = { id: clientId, ws, name: (msg.playerName || 'Host').slice(0, 20), isHost: true, score: 0, color, dbId: msg.dbId || null };
      room.clients.push(client);
      // Update home lobby
      const hl = homeLobby.clients.get(clientId);
      if (hl) { hl.inRoom = code; homeLobbyCast({ type: 'HOME_STATE', state: homeLobbyState() }); }
      send(ws, { type: 'ROOM_JOINED', yourId: clientId, roomState: roomState(code) });
      if (client.dbId) DB.upsertPlayer(client.dbId, client.name, color);
      return;
    }

    if (msg.type === 'JOIN_ROOM') {
      const code = (msg.code || '').toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: 'ERROR', message: 'Kamer niet gevonden!' }); return; }
      room = rooms[code];
      const color = msg.color || '#4d96ff';
      const client = { id: clientId, ws, name: (msg.playerName || 'Speler').slice(0, 20), isHost: false, score: 0, color, dbId: msg.dbId || null };
      room.clients.push(client);
      const hl = homeLobby.clients.get(clientId);
      if (hl) { hl.inRoom = code; homeLobbyCast({ type: 'HOME_STATE', state: homeLobbyState() }); }
      send(ws, { type: 'ROOM_JOINED', yourId: clientId, roomState: roomState(code) });
      send(ws, { type: 'CHAT_HISTORY', messages: room.chat.slice(-30) });
      bcast(code, { type: 'ROOM_UPDATE', roomState: roomState(code) }, clientId);
      bcast(code, { type: 'SYS', text: `${client.name} heeft de kamer betreden!` }, clientId);
      if (client.dbId) DB.upsertPlayer(client.dbId, client.name, color);
      return;
    }

    if (!room) return;

    if (msg.type === 'CHAT') {
      const sender = room.clients.find(c => c.id === clientId);
      if (!sender || !msg.text?.trim()) return;
      const m = { id: uuidv4(), playerId: clientId, playerName: sender.name, text: msg.text.slice(0, 200), time: Date.now() };
      room.chat.push(m);
      if (room.chat.length > 100) room.chat.shift();
      bcast(room.code, { type: 'CHAT', message: m });
      send(ws, { type: 'CHAT', message: m });
      return;
    }

    if (msg.type === 'SET_GAME') {
      const host = room.clients.find(c => c.id === clientId);
      if (!host?.isHost) return;
      room.game = msg.game; room.gameState = null; room.phase = 'lobby';
      room.clients.forEach(c => { c.score = 0; });
      const update = { type: 'ROOM_UPDATE', roomState: roomState(room.code) };
      bcast(room.code, update); send(ws, update);
      return;
    }

    if (msg.type === 'UPDATE_SETTINGS') {
      const host = room.clients.find(c => c.id === clientId);
      if (!host?.isHost) return;
      room.settings = { ...room.settings, ...msg.settings };
      if (msg.settings.isPublic !== undefined) room.isPublic = msg.settings.isPublic;
      bcast(room.code, { type: 'ROOM_UPDATE', roomState: roomState(room.code) });
      send(ws, { type: 'ROOM_UPDATE', roomState: roomState(room.code) });
      return;
    }

    if (msg.type === 'GAME_ACTION') {
      if (room.game === 'cah') handleCAH(room, clientId, ws, msg);
      else if (room.game === 'poker') handlePoker(room, clientId, ws, msg);
      else if (room.game === 'monopoly') handleMonopoly(room, clientId, ws, msg);
      return;
    }

    // DB actions from client
    if (msg.type === 'DB_UPDATE_CAH') {
      const c = room.clients.find(c => c.id === clientId);
      if (c?.dbId) DB.updateCAHStats(c.dbId, msg.data);
      return;
    }
    if (msg.type === 'DB_UPDATE_MONO') {
      const c = room.clients.find(c => c.id === clientId);
      if (c?.dbId) DB.updateMonoStats(c.dbId, msg.data);
      return;
    }
  });

  ws.on('close', () => {
    // Leave home lobby
    if (inHomeLobby) {
      homeLobby.clients.delete(clientId);
      homeLobbyCast({ type: 'HOME_STATE', state: homeLobbyState() });
    }
    if (!room) return;
    const idx = room.clients.findIndex(c => c.id === clientId);
    if (idx === -1) return;
    const leaving = room.clients[idx];
    room.clients.splice(idx, 1);
    if (room.clients.length === 0) { delete rooms[room.code]; return; }
    if (leaving.isHost) room.clients[0].isHost = true;
    bcast(room.code, { type: 'ROOM_UPDATE', roomState: roomState(room.code) });
    bcast(room.code, { type: 'SYS', text: `${leaving.name} heeft de kamer verlaten.` });
    homeLobbyCast({ type: 'HOME_STATE', state: homeLobbyState() });
  });

  ws.on('error', () => {});
});

// ==================== CAH (DUTCH EDITION — 18+) ====================
const BLACK = [
  // Klassiekers
  "Waarom ben ik gecanceld?",
  "Wat heb ik verstopt in mijn zoekgeschiedenis?",
  "Mijn therapeut zegt dat ik een ongezonde obsessie heb met ___.",
  "Nieuwe Happy Meal toy: ___.",
  "Wat is het ergste om te zeggen bij een begrafenis?",
  "Mijn Tinder-bio zegt gewoon: ___.",
  "Waarom drink ik?",
  "Wat staat er in mijn testament?",
  "Nieuwe olympische sport: ___.",
  "Mijn seksleven is eigenlijk gewoon ___.",
  // NL politiek
  "Mark Rutte verliet de politiek vanwege ___.",
  "Geert Wilders stelt voor om ___ te verbieden.",
  "De nieuwe coalitieakkoord bestaat voor 80% uit ___.",
  "Dick Schoof werd premier omdat alle andere opties ___ waren.",
  "Thierry Baudet claimt dat ___ door de deep state wordt verborgen.",
  "De Tweede Kamer is deze week tot stilstand gekomen door ___.",
  "Wat staat er echt in het regeerakkoord? ___.",
  "Caroline van der Plas wil subsidie voor ___.",
  // Vrienden-kaarten
  "Kevin's zoekopdracht om 3 uur 's nachts: ___.",
  "Thomas doet alsof hij ___ niet begrijpt, maar thuis doet hij er alles aan.",
  "Jossa heeft ___ opgeslagen onder 'Werk-contacten'.",
  "Lucas' excuus voor te laat komen: ___.",
  "Dani's Spotify Wrapped: 87 uur ___ luisteren.",
  "Jop heeft weer eens ___ gestuurd naar de groepsapp.",
  "Wat heeft Kevin gegoogled vlak voor zijn eerste date?",
  "Wat staat er op Lucas zijn telefoon onder 'Notities'?",
  // Celebs & internet
  "Jeffrey Epstein stierf NIET door ___.",
  "Wat staat er op Epsteins guestlist naast jouw naam?",
  "Andrew Tate's motivatietip van de dag: ___.",
  "Elon Musk heeft Twitter hernoemd naar ___ en niemand weet waarom.",
  "OnlyFans heeft een nieuw genre: ___.",
  "De volgende Netflix-documentaire gaat over ___.",
  "Wat heeft AI geleerd van het internet? ___.",
  "ChatGPT weigert te praten over ___, maar jij vroeg er toch naar.",
  // Grof maar grappig
  "Mijn arts kijkt me zo aan als ik vertel over ___.",
  "Ik ben verbannen uit de Jumbo vanwege ___.",
  "Het nieuwe Axe-parfum heet ___ en ruikt naar ___.",
  "Kinderboek dat niemand vroeg: ___ en ___.",
  "Wat vind je in de zak van een politicus?",
  "Mijn paniekaanval werd getriggerd door ___.",
  "Ik heb een date gewonnen op Tinder en verloren aan ___.",
  "Wat maak je als je nuchter had moeten zijn maar toch ___?",
  "Stap 1: ___. Stap 2: ___. Stap 3: Kijk naar de gevolgen.",
  "Waarom ben ik geblokkeerd door mijn tandarts?",
  "Nieuwe TikTok-trend: ___ maar dan nóg erger.",
  "Het woord dat mijn oma nooit meer mag zeggen: ___.",
  "Wat heeft de AIVD op mij staan?",
  "De rechter vroeg me: waarom deed u ___?",
  "Mijn moeder denkt dat ik ___. Ze heeft gelijk.",
  "Wat zit er in de Pandora Papers naast mijn naam?",
  "Breaking news: man gearresteerd voor ___ bij de Albert Heijn.",
];

const WHITE = [
  // Klassieke NL humor
  "Een bami zonder eiwit bestellen en toch klagen",
  "Onverklaarbaar lang in de Hema blijven hangen",
  "De verkeerde persoon een screenshot sturen",
  "Zeiknat worden op de fiets maar toch doorgaan",
  "Een vegan worst eten en doen alsof het lekker is",
  "Thuisbezorgd bestellen voor twee maar alles zelf opeten",
  "Ja zeggen op een feestje en dan niet komen",
  "Uit de groepsapp gaan en niets uitleggen",
  // Vrienden
  "Kevin's porno-zoekterm die per ongeluk in de autocomplete stond",
  "Thomas die vraagt 'wat is er mis?' terwijl hij zelf het probleem is",
  "Jossa die expres vaag antwoordt om interessant te lijken",
  "Lucas' excuus: 'mijn oma was ziek' (voor de vijfde keer dit jaar)",
  "Dani die om 4 uur 's nachts voice memos stuurt",
  "Jop die grappig probeert te zijn maar het niet is",
  "Kevin zijn zoekgeschiedenis wissen terwijl zijn moeder al mee kan kijken",
  "Thomas die bij elke grap uitlegt waarom het grappig is",
  // Politiek NL
  "Rutte die met een non-antwoord wegkomt",
  "Wilders die zijn eigen tweet niet meer begrijpt",
  "Het coalitieakkoord dat nergens op slaat",
  "Een Tweede Kamerlid dat vergeet dat er camera's zijn",
  "Baudet en zijn ridderverhalen",
  "Sigrid Kaag die huilt maar er toch mooier van wordt",
  "Jesse Klaver die zijn haar doet voor een serieus interview",
  "De VVD die belooft iets te doen aan de woningmarkt",
  "Een D66-stemmer die vijf lattes per dag drinkt maar klimaat serieus neemt",
  "NSC dat al ruzie maakt voor de vergadering begint",
  // Celebrities
  "Jeffrey Epstein zijn notitieboekje",
  "Andrew Tate's motivatiecursus: €1.499 voor niets leren",
  "Elon Musk om 3 uur 's nachts op zijn eigen platform",
  "Een rijke man die zegt dat hard werken het geheim is",
  "Johnny Depp die denkt dat hij gewonnen heeft",
  "De prins die zegt 'ik wist van niks'",
  "Een tiktoker die denkt dat hij influencer is",
  "Een OnlyFans-account van iemand die je kent",
  // Extra grof
  "Ongewenste penisfoto's als introductie",
  "Een kelder die je niet mocht binnengaan",
  "Je zoekgeschiedenis als NFT",
  "Een telefoontje van een advocaat",
  "Iemand die zegt 'ik heb niks te verbergen'",
  "Een schermtijd van 14 uur per dag",
  "Vergeten dat je nog getrouwd bent",
  "Terugkomen bij je ex omdat je lui bent",
  "Een ex die 'gewoon checken hoe het gaat' stuurt om 2 uur 's nachts",
  "Doen alsof de politie het niet weet",
  "Iets posten wat je had moeten bewaren voor een rechtszaak",
  "De verkeerde groepsapp kiezen",
  "Klagen over belasting terwijl je zwart werkt",
  "Je vader bellen voor raad en spijt krijgen",
  "Het bewijs vernietigen maar je telefoon vergeten",
  "Zeggen 'ik ben geen racist, maar...' en dan toch racist zijn",
  "Een nacht in de cel die je karakter opbouwde",
  "Googelen of iets strafbaar is terwijl je het al gedaan hebt",
  "Echt hopen dat niemand de screenshots heeft",
  "Zeggen dat het voor het werk was",
  "Een meme maken van je eigen rechtszaak",
  "Iemand uitleggen waarom je eigenlijk niet verkeerd zit terwijl je dat wel doet",
  "Een biertje op een donderdagmiddag omdat 'het kan'",
  "De datingapp verwijderen maar hem twee dagen later herinstalleren",
  "Doen alsof je slaap hebt wanneer iemand vraagt iets te doen",
  "Een screenshot lekken zonder je naam eruit te halen",
  "Janken om iemands dood terwijl je hem nooit gemogen hebt",
  "Zeggen dat je 'gewoon eerlijk bent' als excuus om gemeen te zijn",
];

function shuffle(a) {
  const b = [...a];
  for (let i = b.length-1; i>0; i--) { const j=Math.floor(Math.random()*(i+1)); [b[i],b[j]]=[b[j],b[i]]; }
  return b;
}

function cahBroadcast(room) {
  const gs = room.gameState;
  const rs = roomState(room.code);
  room.clients.forEach(c => {
    const showSubs = gs.phase === 'judging' || gs.phase === 'scores';
    send(c.ws, {
      type: 'GAME_STATE', game: 'cah', roomState: rs,
      state: {
        phase: gs.phase, round: gs.round,
        czar: gs.czar,
        czarName: room.clients.find(cl=>cl.id===gs.czar)?.name || '?',
        currentBlack: gs.currentBlack,
        submissions: showSubs ? gs.submissions : {},
        submittedIds: Object.keys(gs.submissions),
        scores: gs.scores,
        winner: gs.winner,
        lastWinner: gs.lastWinner,
        lastWinnerName: room.clients.find(cl=>cl.id===gs.lastWinner)?.name || '?',
        lastWinningCard: gs.lastWinningCard,
        lastBlackCard: gs.lastBlackCard,
        myHand: gs.hands[c.id] || [],
        hasSubmitted: !!gs.submissions[c.id],
        mySubmission: gs.submissions[c.id] || null,
        totalPlayers: room.clients.length,
        maxPoints: room.settings.maxPoints || 7,
      }
    });
  });
}

function startCAH(room) {
  const extra_b = room.settings.customBlackCards || [];
  const extra_w = room.settings.customWhiteCards || [];
  const bDeck = shuffle([...extra_b, ...BLACK]);
  const wDeck = shuffle([...extra_w, ...WHITE]);
  const players = room.clients.map(c=>c.id);
  const hands = {};
  let wi = 0;
  players.forEach(p => { hands[p] = wDeck.slice(wi, wi+7); wi+=7; });
  room.gameState = {
    phase:'playing', round:1, czarIndex:0, czar:players[0],
    currentBlack: bDeck[0], blackDeck: bDeck.slice(1), whiteDeck: wDeck.slice(wi),
    hands, submissions:{}, scores: Object.fromEntries(players.map(p=>[p,0])),
    winner:null, lastWinner:null, lastWinningCard:null, lastBlackCard:null,
  };
  room.phase = 'ingame';
  cahBroadcast(room);
}

function handleCAH(room, clientId, ws, msg) {
  const client = room.clients.find(c=>c.id===clientId);
  if (msg.action === 'START_GAME') { if (client?.isHost) startCAH(room); return; }
  if (msg.action === 'ADD_CARD') {
    if (!client?.isHost) return;
    if (msg.cardType === 'black') { (room.settings.customBlackCards = room.settings.customBlackCards||[]).push(msg.card); }
    else { (room.settings.customWhiteCards = room.settings.customWhiteCards||[]).push(msg.card); }
    send(ws, { type: 'TOAST', text: '✅ Kaart toegevoegd!' });
    return;
  }
  const gs = room.gameState; if (!gs) return;
  if (msg.action === 'SUBMIT_CARD') {
    if (gs.phase!=='playing'||clientId===gs.czar||gs.submissions[clientId]) return;
    if (!gs.hands[clientId]?.includes(msg.card)) return;
    gs.submissions[clientId] = msg.card;
    gs.hands[clientId] = gs.hands[clientId].filter(c=>c!==msg.card);
    if (room.clients.filter(c=>c.id!==gs.czar).every(c=>gs.submissions[c.id])) gs.phase='judging';
    cahBroadcast(room); return;
  }
  if (msg.action === 'PICK_WINNER') {
    if (gs.phase!=='judging'||clientId!==gs.czar) return;
    const winnerId = Object.entries(gs.submissions).find(([,c])=>c===msg.card)?.[0];
    if (!winnerId) return;
    gs.scores[winnerId]=(gs.scores[winnerId]||0)+1;
    room.clients.forEach(c=>{c.score=gs.scores[c.id]||0;});
    gs.lastWinner=winnerId; gs.lastWinningCard=msg.card; gs.lastBlackCard=gs.currentBlack; gs.phase='scores';
    if (gs.scores[winnerId]>=(room.settings.maxPoints||7)) gs.winner=winnerId;
    cahBroadcast(room); return;
  }
  if (msg.action === 'NEXT_ROUND') {
    if (gs.phase!=='scores'||!client?.isHost) return;
    if (gs.winner) { startCAH(room); return; }
    const players = room.clients.map(c=>c.id);
    players.forEach(pid => {
      gs.hands[pid] = gs.hands[pid]||[];
      while (gs.hands[pid].length < 7 && gs.whiteDeck.length > 0) gs.hands[pid].push(gs.whiteDeck.shift());
    });
    gs.czarIndex=(gs.czarIndex+1)%players.length; gs.czar=players[gs.czarIndex];
    gs.submissions={}; gs.currentBlack=gs.blackDeck.shift()||BLACK[Math.floor(Math.random()*BLACK.length)];
    gs.phase='playing'; gs.round++; gs.lastWinner=null; gs.lastWinningCard=null;
    cahBroadcast(room); return;
  }
}

// ==================== POKER ====================
function makeDeck() {
  const suits=['♠','♥','♦','♣'], ranks=['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const d=[];
  for(const s of suits) for(const r of ranks) d.push({r,s});
  return shuffle(d);
}

function pokerBroadcast(room) {
  const gs = room.gameState;
  const rs = roomState(room.code);
  room.clients.forEach(c => {
    const myHand = gs.phase==='showdown' 
      ? Object.fromEntries(Object.entries(gs.hands||{}).map(([id,h])=>[id,h]))
      : { [c.id]: gs.hands?.[c.id]||[] };
    send(c.ws, {
      type:'GAME_STATE', game:'poker', roomState:rs,
      state:{ ...gs, hands:undefined, deck:undefined, myHand, currentPlayerName: room.clients.find(cl=>cl.id===gs.players?.[gs.currentPlayerIndex])?.name || '?' }
    });
  });
}

function startPokerHand(room) {
  const prevChips = room.gameState?.chips;
  const prevDealer = room.gameState?.dealerIndex ?? -1;
  const players = room.clients.map(c=>c.id);
  const chips = prevChips || Object.fromEntries(players.map(p=>[p,1000]));
  const blind = 10;
  const deck = makeDeck();
  const hands = {};
  players.forEach(p => { hands[p]=[deck.pop(),deck.pop()]; });
  const dIdx = (prevDealer+1)%players.length;
  const sbIdx = (dIdx+1)%players.length;
  const bbIdx = (dIdx+2)%players.length;
  const bets = Object.fromEntries(players.map(p=>[p,0]));
  chips[players[sbIdx]]=Math.max(0,(chips[players[sbIdx]]||0)-blind);
  chips[players[bbIdx]]=Math.max(0,(chips[players[bbIdx]]||0)-blind*2);
  bets[players[sbIdx]]=blind; bets[players[bbIdx]]=blind*2;
  room.gameState = {
    phase:'preflop', players, chips, hands, deck,
    community:[], pot:blind*3, bets, currentBet:blind*2, blind,
    dealerIndex:dIdx, currentPlayerIndex:(dIdx+3)%players.length,
    folded:{}, winner:null, actionsThisStreet:0,
  };
  room.phase='ingame';
  pokerBroadcast(room);
}

function pokerAdvance(room) {
  const gs = room.gameState;
  const active = gs.players.filter(p=>!gs.folded[p]);
  if (active.length===1) {
    gs.winner=active[0]; gs.chips[active[0]]=(gs.chips[active[0]]||0)+gs.pot; gs.pot=0; gs.phase='showdown';
    pokerBroadcast(room); return;
  }
  gs.actionsThisStreet++;
  const allEq = active.every(p=>(gs.bets[p]||0)===(gs.currentBet||0));
  if (allEq && gs.actionsThisStreet>=active.length) {
    gs.bets=Object.fromEntries(gs.players.map(p=>[p,0])); gs.currentBet=0; gs.actionsThisStreet=0;
    let ni=(gs.dealerIndex+1)%gs.players.length;
    while(gs.folded[gs.players[ni]]) ni=(ni+1)%gs.players.length;
    gs.currentPlayerIndex=ni;
    if (gs.phase==='preflop') { gs.community=[gs.deck.pop(),gs.deck.pop(),gs.deck.pop()]; gs.phase='flop'; }
    else if (gs.phase==='flop') { gs.community.push(gs.deck.pop()); gs.phase='turn'; }
    else if (gs.phase==='turn') { gs.community.push(gs.deck.pop()); gs.phase='river'; }
    else if (gs.phase==='river') {
      gs.winner=active[Math.floor(Math.random()*active.length)];
      gs.chips[gs.winner]=(gs.chips[gs.winner]||0)+gs.pot; gs.pot=0; gs.phase='showdown';
    }
  } else {
    let ni=(gs.currentPlayerIndex+1)%gs.players.length, tries=0;
    while(gs.folded[gs.players[ni]]&&tries++<gs.players.length) ni=(ni+1)%gs.players.length;
    gs.currentPlayerIndex=ni;
  }
  pokerBroadcast(room);
}

function handlePoker(room, clientId, ws, msg) {
  const client = room.clients.find(c=>c.id===clientId);
  if (msg.action==='START_GAME') { if(client?.isHost) startPokerHand(room); return; }
  if (msg.action==='NEXT_HAND') { if(client?.isHost) startPokerHand(room); return; }
  const gs=room.gameState; if(!gs||gs.phase==='showdown') return;
  if (gs.players[gs.currentPlayerIndex]!==clientId) return;
  if (msg.action==='FOLD') { gs.folded[clientId]=true; pokerAdvance(room); }
  else if (msg.action==='CHECK') pokerAdvance(room);
  else if (msg.action==='CALL') {
    const toCall=Math.min((gs.currentBet-(gs.bets[clientId]||0)),gs.chips[clientId]||0);
    gs.chips[clientId]=(gs.chips[clientId]||0)-toCall;
    gs.bets[clientId]=(gs.bets[clientId]||0)+toCall; gs.pot+=toCall;
    pokerAdvance(room);
  }
  else if (msg.action==='RAISE') {
    const toCall=gs.currentBet-(gs.bets[clientId]||0);
    const raiseAmt=Math.max(gs.blind*2, msg.amount||gs.blind*2);
    const total=Math.min(toCall+raiseAmt, gs.chips[clientId]||0);
    gs.chips[clientId]=(gs.chips[clientId]||0)-total;
    gs.bets[clientId]=(gs.bets[clientId]||0)+total; gs.pot+=total;
    gs.currentBet=gs.bets[clientId]; gs.actionsThisStreet=0;
    pokerAdvance(room);
  }
}

// ==================== MONOPOLY: STRAAT VARIANT ====================
// Board: sq0=START(bottom-right), clockwise:
//   sq0-9:   bottom row RIGHT→LEFT  (sq0=BR, sq9=second-from-BL)
//   sq10:    bottom-left corner (JAIL)
//   sq11-19: left col BOTTOM→TOP
//   sq20:    top-left corner (FREE PARKING)
//   sq21-29: top row LEFT→RIGHT
//   sq30:    top-right corner (GO TO JAIL)
//   sq31-39: right col TOP→BOTTOM (sq39=last before START)

const MONO_BOARD = [
  // ── BOTTOM ROW (left→right, sq0=START bottom-left) ──────────────────
  {n:'START',             t:'go',       emoji:'🏁', desc:'Passeer en ontvang €2.000!'},
  {n:'Crack Steeg',       t:'prop',     emoji:'🏚️', c:'#8B4513', p:600,  r:20,  desc:'1 kamer. Veel ratten.'},
  {n:'Gemeentekas',       t:'chest',    emoji:'📬', desc:'Post van de gemeente.'},
  {n:'Jordaan Slop',      t:'prop',     emoji:'🏠', c:'#8B4513', p:1000, r:40,  desc:'Gezellig als je dronken bent.'},
  {n:'Inkomstenbelasting',t:'tax',      emoji:'⚡', a:2000, desc:'Betaal €2.000 belasting.'},
  {n:'Schiphol',          t:'rr',       emoji:'✈️', p:2000, r:250,  desc:'Vliegveld. 4x = jackpot.'},
  {n:'AH Straat',         t:'prop',     emoji:'🛒', c:'#87CEEB', p:1000, r:60,  desc:'Bonusbroodjes inbegrepen.'},
  {n:'Kans',              t:'chance',   emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Wallen Wijk',       t:'prop',     emoji:'🪟', c:'#87CEEB', p:1000, r:60,  desc:'Toeristen betalen goed.'},
  {n:'Coffeeshop Corner', t:'prop',     emoji:'☕', c:'#87CEEB', p:1200, r:80,  desc:'Hoge huur, hogere bewoners.'},
  // ── BOTTOM-RIGHT CORNER: sq10 = JAIL ────────────────────────────────
  {n:'Gevangenis',        t:'jail',     emoji:'🔒', desc:'Op bezoek... toch?'},
  // ── RIGHT COL (bottom→top) ───────────────────────────────────────────
  {n:'Kattenburgh',       t:'prop',     emoji:'🐱', c:'#FF69B4', p:1400, r:100, desc:'Meer katten dan mensen.'},
  {n:'Waterleiding',      t:'util',     emoji:'💧', p:1500, r:0,   desc:'Huur = dobbelsteen × €40.'},
  {n:'Kinkerstraat',      t:'prop',     emoji:'🛵', c:'#FF69B4', p:1400, r:100, desc:'Scooters overal.'},
  {n:'De Pijp',           t:'prop',     emoji:'🥐', c:'#FF69B4', p:1600, r:120, desc:'Avocadotoast €14.'},
  {n:'Centraal Station',  t:'rr',       emoji:'🚂', p:2000, r:250,  desc:'Trein. 4x = jackpot.'},
  {n:'NDSM Loods',        t:'prop',     emoji:'🏭', c:'#FFA500', p:1800, r:140, desc:'Hipsters inbegrepen.'},
  {n:'Gemeentekas',       t:'chest',    emoji:'📬', desc:'Misschien goed nieuws.'},
  {n:'Zuidas Tower',      t:'prop',     emoji:'🏢', c:'#FFA500', p:1800, r:140, desc:'Pakken en BMWs.'},
  {n:'Vondelpark',        t:'prop',     emoji:'🌳', c:'#FFA500', p:2000, r:160, desc:'Joggers en junkies.'},
  // ── TOP-RIGHT CORNER: sq20 = FREE PARKING ───────────────────────────
  {n:'Gratis Parkeren',   t:'free',     emoji:'🚗', desc:'Niets. Geniet ervan.'},
  // ── TOP ROW (right→left) ─────────────────────────────────────────────
  {n:'Herengracht',       t:'prop',     emoji:'🏰', c:'#CC2200', p:2200, r:180, desc:'Grachtenpand. Steil.'},
  {n:'Kans',              t:'chance',   emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Keizersgracht',     t:'prop',     emoji:'🏯', c:'#CC2200', p:2200, r:180, desc:'Nog steiler.'},
  {n:'Prinsengracht',     t:'prop',     emoji:'🏛️', c:'#CC2200', p:2400, r:200, desc:'Anne Frank was hier.'},
  {n:'Zuid-As Metro',     t:'rr',       emoji:'🚇', p:2000, r:250,  desc:'Metro. 4x = jackpot.'},
  {n:'Museumplein',       t:'prop',     emoji:'🎨', c:'#FFD700', p:2600, r:220, desc:'Toeristen betalen goed.'},
  {n:'Luxebelasting',     t:'tax',      emoji:'💸', a:1000, desc:'Betaal €1.000 luxebelasting.'},
  {n:'Oud-Zuid Laan',     t:'prop',     emoji:'🏡', c:'#FFD700', p:2600, r:220, desc:'Bomen, stilte, geld.'},
  {n:'Vondelweg',         t:'prop',     emoji:'🌿', c:'#FFD700', p:2800, r:240, desc:'Rustige laan, dure buurt.'},
  // ── TOP-LEFT CORNER: sq30 = GA NAAR BAK ─────────────────────────────
  {n:'Ga Naar Bak',       t:'gotojail', emoji:'🚔', desc:'Geen €2000. Direct naar bak.'},
  // ── LEFT COL (top→bottom) ────────────────────────────────────────────
  {n:'Apollolaan',        t:'prop',     emoji:'🌴', c:'#2E8B57', p:3000, r:260, desc:'Celebrities en villas.'},
  {n:'Gemeentekas',       t:'chest',    emoji:'📬', desc:'Post uit de dure buurt.'},
  {n:'Buitenveldert',     t:'prop',     emoji:'🏘️', c:'#2E8B57', p:3000, r:260, desc:'Rustig. Te rustig.'},
  {n:'Kans',              t:'chance',   emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Amstelveen Park',   t:'prop',     emoji:'🏗️', c:'#2E8B57', p:3200, r:280, desc:'Mega-pand staat er al.'},
  {n:'Snelweg A10',       t:'rr',       emoji:'🚌', p:2000, r:250,  desc:'Bus. 4x = jackpot.'},
  {n:'Leidseplein',       t:'prop',     emoji:'🌟', c:'#3333CC', p:3500, r:350, desc:'Uitzicht over de stad.'},
  {n:'Gemeentebelasting', t:'tax',      emoji:'🏛️', a:750,  desc:'Betaal €750 gemeentebelasting.'},
  {n:'Rembrandtplein',    t:'prop',     emoji:'👑', c:'#3333CC', p:4500, r:500, desc:'Het duurste pand van Amsterdam.'},
];

const MONO_LEVEL_NAMES = ['Leeg','Kraakpand','Rijtjeshuis','Appartement','Villa','Mansion'];
const MONO_LEVEL_EMOJI = ['🏚️','🏠','🏡','🏢','🏰','👑'];

// Upgrade cost = 60% of purchase price
function monoUpgradeCost(sq) { return Math.floor((sq.p||100) * 0.5); }

// Rent based on level
function monoCalcRent(sqIdx, gs) {
  const sq = MONO_BOARD[sqIdx];
  const prop = gs.props[sqIdx];
  if (!prop) return 0;
  if (sq.t === 'rr') {
    const owner = prop.ownerId;
    const count = Object.entries(gs.props).filter(([i,p]) => MONO_BOARD[i].t==='rr' && p.ownerId===owner).length;
    return [0,250,500,1000,2000][count] || 250 * count;
  }
  if (sq.t === 'util') {
    return (gs.lastDiceSum||7) * 40;
  }
  const mults = [1, 3, 6, 12, 20, 32]; // aggressive scaling: mansions are brutal
  return Math.round((sq.r||10) * (mults[prop.level]||1));
}

const MONO_CHANCE = [
  {txt:'Je wint een weddenschap! +€500 🎉', eff:{t:'money', v:500}},
  {txt:'Belastingteruggave! +€1.000 💵', eff:{t:'money', v:1000}},
  {txt:'Oom Henk is dood. Je erft €2.000 🪦', eff:{t:'money', v:2000}},
  {txt:'Parkeerboete. -€500 🚔', eff:{t:'money', v:-500}},
  {txt:'Ziekenhuisrekening. -€1.000 🏥', eff:{t:'money', v:-1000}},
  {txt:'Straatloterij! +€3.000 🎰', eff:{t:'money', v:3000}},
  {txt:'Terug naar START! Pak €2.000 💰', eff:{t:'goto', pos:0, bonus:2000}},
  {txt:'Rechtstreeks naar de gevangenis 🔒', eff:{t:'jail'}},
  {txt:'Vrijlatingspas gevonden! Bewaar voor later 🗝️', eff:{t:'freepass'}},
  {txt:'Iedereen geeft jou €500! 🤑', eff:{t:'collect', v:500}},
  {txt:'Je trakteert iedereen op kroketjes. -€300 per persoon 🍺', eff:{t:'payall', v:300}},
  {txt:'Dakgoot kapot! -€500 per pand 🔧', eff:{t:'perprop', v:500}},
  {txt:'Cryptobelegging GECRASHED. -€2.000 📉', eff:{t:'money', v:-2000}},
  {txt:'Je wint een rechtszaak! +€1.500 ⚖️', eff:{t:'money', v:1500}},
];

const MONO_CHEST = [
  {txt:'WOZ-aanslag. -€800 📄', eff:{t:'money', v:-800}},
  {txt:'Buren klagen over geluidsoverlast. -€400 😤', eff:{t:'money', v:-400}},
  {txt:'Je verkoopt je Vespa op Marktplaats. +€600 🛵', eff:{t:'money', v:600}},
  {txt:'Jaareinde bonus! +€1.500 💼', eff:{t:'money', v:1500}},
  {txt:'Gewoon de bak in. Nu. 🔒', eff:{t:'jail'}},
  {txt:'Buurtfeest: iedereen betaalt jou €300 🏘️', eff:{t:'collect', v:300}},
  {txt:'Energiesubsidie! +€750 🏛️', eff:{t:'money', v:750}},
  {txt:'Riool gesprongen onder je pand. -€1.200 💧', eff:{t:'money', v:-1200}},
  {txt:'Gewonnen bij de rechtbank! +€1.000 ⚖️', eff:{t:'money', v:1000}},
  {txt:'Huurders staken! Miss een beurt. Maar geen kosten. ✊', eff:{t:'money', v:0}},
  {txt:'Fout geld gevonden in je muur. +€2.500 🤑', eff:{t:'money', v:2500}},
];

const MONO_SPIN = [
  {txt:'🎉 VRIJUIT! Agent at zijn donut en zag niks.', type:'free',  prob:0.25},
  {txt:'💸 Rijboete €300. Had je gordel op?', type:'fine',  v:300,  prob:0.20},
  {txt:'💸 Snelheidsboete €600. Beetje snel!', type:'fine',  v:600, prob:0.18},
  {txt:'💸 Rijden onder invloed €1.500. Au.', type:'fine',  v:1500, prob:0.12},
  {txt:'🔒 GEARRESTEERD! Rechtstreeks naar de gevangenis!', type:'jail', prob:0.13},
  {txt:'🏃 ACHTERVOLGING! Je ontsnapt maar gaat 3 stappen terug.', type:'chase',prob:0.12},
];

function monoSpin() {
  const r = Math.random();
  let acc = 0;
  for (const s of MONO_SPIN) { acc += s.prob; if (r < acc) return s; }
  return MONO_SPIN[0];
}

function monoBroadcast(room) {
  const rs = roomState(room.code);
  room.clients.forEach(c => send(c.ws, {type:'GAME_STATE', game:'monopoly', roomState:rs, state:room.gameState}));
}

function monoApplyCard(room, pid, card) {
  const gs = room.gameState;
  const name = room.clients.find(c=>c.id===pid)?.name||'?';
  const eff = card.eff;
  if (eff.t==='money') {
    gs.money[pid] = (gs.money[pid]||0) + eff.v;
  } else if (eff.t==='goto') {
    gs.pos[pid] = eff.pos||0;
    if (eff.bonus) gs.money[pid] = (gs.money[pid]||0) + eff.bonus;
  } else if (eff.t==='jail') {
    gs.pos[pid] = 10; gs.jail[pid] = true; gs.jailTurns[pid] = 0;
  } else if (eff.t==='freepass') {
    gs.freePass[pid] = true;
  } else if (eff.t==='collect') {
    const others = gs.players.filter(p=>p!==pid&&!gs.bankrupt[p]);
    others.forEach(p => { gs.money[p] = (gs.money[p]||0) - eff.v; });
    gs.money[pid] = (gs.money[pid]||0) + eff.v * others.length;
  } else if (eff.t==='payall') {
    const others = gs.players.filter(p=>p!==pid&&!gs.bankrupt[p]);
    others.forEach(p => { gs.money[p] = (gs.money[p]||0) + eff.v; });
    gs.money[pid] = (gs.money[pid]||0) - eff.v * others.length;
  } else if (eff.t==='perprop') {
    const count = Object.values(gs.props).filter(p=>p.ownerId===pid).length;
    gs.money[pid] = (gs.money[pid]||0) - eff.v * count;
  }
  gs.log.unshift(`${name}: ${card.txt}`);
  if ((gs.money[pid]||0) <= 0 && !gs.bankrupt[pid]) {
    gs.bankrupt[pid] = true; gs.money[pid] = 0;
    gs.log.unshift(`💀 ${name} is FAILLIET!`);
  }
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
  const b=[...a]; for(let i=b.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[b[i],b[j]]=[b[j],b[i]];}return b;
}

function monoCheckBankruptcy(gs, pid) {
  if ((gs.money[pid]||0) <= 0 && !gs.bankrupt[pid]) {
    gs.bankrupt[pid] = true; gs.money[pid] = 0;
    return true;
  }
  return false;
}

function startMonopoly(room) {
  const players = room.clients.map(c=>c.id);
  // NPC cop: fake player 'cop' appended at end of player list
  const copId = 'cop';
  const allPlayers = [...players, copId];
  room.gameState = {
    players: allPlayers, copId,
    realPlayers: players,
    pos:       Object.fromEntries(allPlayers.map(p=>[p,0])),
    money:     Object.fromEntries(allPlayers.map(p=>[p, p==='cop' ? 0 : 10000])),
    jail:      Object.fromEntries(allPlayers.map(p=>[p,false])),
    jailTurns: Object.fromEntries(allPlayers.map(p=>[p,0])),
    freePass:  Object.fromEntries(allPlayers.map(p=>[p,false])),
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

// NPC cop takes his turn automatically after all real players have gone
function monoCopTurn(room) {
  const gs = room.gameState;
  const d1 = Math.ceil(Math.random()*6), d2 = Math.ceil(Math.random()*6);
  gs.dice = [d1, d2]; gs.lastDiceSum = d1+d2;
  const old = gs.pos['cop'];
  gs.pos['cop'] = (old + d1 + d2) % 40;
  const newPos = gs.pos['cop'];
  const sq = MONO_BOARD[newPos];
  gs.log.unshift(`👮 Agent rijdt ${d1}+${d2}=${d1+d2} vakjes → ${sq.emoji} ${sq.n}`);

  // Check if cop landed on same square as any real player
  const victims = gs.realPlayers.filter(p => !gs.bankrupt[p] && gs.pos[p] === newPos);
  if (victims.length > 0) {
    gs.spinVictims = victims;
    gs.phase = 'spinning';
    gs.popup = {
      kind: 'spin_intro',
      victims: victims.map(v => room.clients.find(c=>c.id===v)?.name||'?')
    };
    gs.log.unshift(`👮 Agent staat op hetzelfde vak als ${gs.popup.victims.join(', ')}! RAD DRAAIEN!`);
    monoBroadcast(room);
    return; // spin_wheel action from human player will continue the turn
  }

  // Cop just passes through — end cop turn, go to next real player
  monoCopDone(room);
}

function monoCopDone(room) {
  const gs = room.gameState;
  gs.dice = null; gs.rolled = false; gs.phase = 'playing'; gs.popup = null; gs.spinResult = null;
  // Find first non-bankrupt real player
  let ni = 0;
  let guard = 0;
  while (gs.bankrupt[gs.realPlayers[ni]] && guard++ < gs.realPlayers.length) ni = (ni+1) % gs.realPlayers.length;
  gs.currentIdx = ni;
  gs.current = gs.realPlayers[ni];
  const nextName = room.clients.find(c=>c.id===gs.current)?.name||'?';
  gs.log.unshift(`▶️ ${nextName} is aan de beurt.`);
  monoBroadcast(room);
}

function monoEndTurn(room) {
  const gs = room.gameState;
  gs.rolled = false; gs.dice = null; gs.phase = 'playing'; gs.popup = null; gs.spinResult = null;

  // Check win condition: only 1 non-bankrupt real player left
  const alive = gs.realPlayers.filter(p => !gs.bankrupt[p]);
  if (alive.length <= 1) {
    gs.winner = alive[0] || gs.realPlayers[0];
    gs.phase = 'gameover';
    gs.log.unshift('🏆 ' + (room.clients.find(c=>c.id===gs.winner)?.name||'?') + ' WINT HET SPEL!');
    monoBroadcast(room); return;
  }

  // Find next real player
  const curRealIdx = gs.realPlayers.indexOf(gs.current);
  let ni = (curRealIdx + 1) % gs.realPlayers.length;
  let guard = 0;
  while (gs.bankrupt[gs.realPlayers[ni]] && guard++ < gs.realPlayers.length) ni = (ni+1) % gs.realPlayers.length;

  // If we wrapped around (ni went back to 0 from a higher index), cop goes first
  if (ni < curRealIdx || (ni === 0 && curRealIdx === gs.realPlayers.length - 1)) {
    gs.log.unshift('👮 Nieuwe ronde! Agent rijdt zijn ronde...');
    gs.current = 'cop';
    gs.currentIdx = gs.realPlayers.length; // cop index
    monoBroadcast(room);
    // Auto-execute cop turn after short delay (500ms for suspense)
    setTimeout(() => {
      if (room.gameState && room.gameState.current === 'cop') {
        monoCopTurn(room);
      }
    }, 1500);
    return;
  }

  gs.current = gs.realPlayers[ni];
  gs.currentIdx = ni;
  const nextName = room.clients.find(c=>c.id===gs.current)?.name||'?';
  gs.log.unshift(`▶️ ${nextName} is aan de beurt.`);
  monoBroadcast(room);
}

function handleMonopoly(room, clientId, ws, msg) {
  const client = room.clients.find(c=>c.id===clientId);
  if (msg.action==='START_GAME') { if(client?.isHost) startMonopoly(room); return; }
  const gs = room.gameState; if (!gs) return;
  // Only allow actions from current player (cop is NPC so nobody can act as cop)
  if (gs.current !== clientId) return;
  const name = client?.name||'?';

  // ---- ROLL ----
  if (msg.action==='ROLL' && !gs.rolled) {
    const d1=Math.ceil(Math.random()*6), d2=Math.ceil(Math.random()*6);
    gs.dice=[d1,d2]; gs.rolled=true; gs.lastDiceSum=d1+d2;

    // Jail handling
    if (gs.jail[clientId]) {
      gs.jailTurns[clientId]++;
      if (d1===d2) {
        gs.jail[clientId]=false; gs.jailTurns[clientId]=0;
        gs.log.unshift(`🎉 ${name} gooide dubbel! Vrij!`);
      } else if (gs.jailTurns[clientId]>=3) {
        gs.jail[clientId]=false; gs.jailTurns[clientId]=0;
        gs.money[clientId] = (gs.money[clientId]||0) - 500;
        gs.log.unshift(`${name} betaalt €1.000 borgtocht en is vrij.`);
        monoCheckBankruptcy(gs, clientId);
      } else {
        gs.log.unshift(`${name} in de bak. Poging ${gs.jailTurns[clientId]}/3 — geen dubbel.`);
        monoBroadcast(room); return;
      }
    }

    const oldPos = gs.pos[clientId];
    gs.pos[clientId] = (oldPos + d1 + d2) % 40;
    const newPos = gs.pos[clientId];

    if (newPos < oldPos && !gs.jail[clientId]) {
      gs.money[clientId] = (gs.money[clientId]||0) + 2000;
      gs.log.unshift(`💰 ${name} passeert START en pakt €2.000!`);
    }

    const sq = MONO_BOARD[newPos];
    const diceWords = ['','één','twee','drie','vier','vijf','zes'];
    gs.log.unshift(`🎲 ${name} gooit ${d1}+${d2}=${d1+d2} en landt op ${sq.emoji} ${sq.n}`);

    // --- SQUARE EFFECTS ---
    if (sq.t==='gotojail') {
      gs.pos[clientId]=10; gs.jail[clientId]=true;
      gs.log.unshift(`🔒 ${name} gaat DIRECT naar de gevangenis!`);
      gs.popup = {kind:'jail_card'};
      gs.phase = 'popup';
    } else if (sq.t==='tax') {
      gs.money[clientId] = (gs.money[clientId]||0) - sq.a;
      monoCheckBankruptcy(gs, clientId);
      gs.popup = {kind:'tax_card', sq};
      gs.phase = 'popup';
    } else if (sq.t==='chance') {
      const card = monoDrawCard(gs, 'chance');
      gs.pendingCard = {card, pid:clientId};
      gs.popup = {kind:'chance_card', card};
      gs.phase = 'popup';
    } else if (sq.t==='chest') {
      const card = monoDrawCard(gs, 'chest');
      gs.pendingCard = {card, pid:clientId};
      gs.popup = {kind:'chest_card', card};
      gs.phase = 'popup';
    } else if ((sq.t==='prop'||sq.t==='rr'||sq.t==='util') && !gs.props[newPos]) {
      gs.popup = {kind:'buy_card', sq, sqIdx:newPos};
      gs.phase = 'popup';
    } else if ((sq.t==='prop'||sq.t==='rr'||sq.t==='util') && gs.props[newPos] && gs.props[newPos].ownerId!==clientId) {
      const rent = monoCalcRent(newPos, gs);
      const ownerName = room.clients.find(c=>c.id===gs.props[newPos].ownerId)?.name||'?';
      gs.pendingRent = {sqIdx:newPos, rent, ownerId:gs.props[newPos].ownerId};
      gs.popup = {kind:'rent_card', sq, rent, ownerName};
      gs.phase = 'dash';
    }
    monoBroadcast(room); return;
  }

  // ---- CLOSE POPUP ----
  if (msg.action==='CLOSE_POPUP' && gs.phase==='popup') {
    if (gs.pendingCard) {
      monoApplyCard(room, clientId, gs.pendingCard.card);
      gs.pendingCard = null;
    }
    gs.popup = null; gs.phase = 'playing';
    monoBroadcast(room); return;
  }

  // ---- BUY ----
  if (msg.action==='BUY' && gs.phase==='popup') {
    const sqIdx = gs.popup?.sqIdx ?? gs.pos[clientId];
    const sq = MONO_BOARD[sqIdx];
    if (!gs.props[sqIdx] && (gs.money[clientId]||0) >= (sq.p||9999)) {
      gs.money[clientId] -= sq.p;
      gs.props[sqIdx] = {ownerId:clientId, level:0};
      gs.log.unshift(`🏠 ${name} koopt ${sq.emoji} ${sq.n} voor €${sq.p.toLocaleString('nl')}!`);
    }
    gs.popup=null; gs.phase='playing';
    monoBroadcast(room); return;
  }

  // ---- UPGRADE ----
  if (msg.action==='UPGRADE') {
    const sqIdx = msg.sqIdx;
    const prop = gs.props[sqIdx];
    if (!prop||prop.ownerId!==clientId||prop.level>=5) return;
    const sq = MONO_BOARD[sqIdx];
    const cost = monoUpgradeCost(sq);
    if ((gs.money[clientId]||0) < cost) { send(ws,{type:'TOAST',text:`Upgrade kost €${cost}. Te weinig!`}); return; }
    gs.money[clientId] -= cost;
    prop.level++;
    gs.log.unshift(`${name} upgradet ${sq.emoji} ${sq.n} → ${MONO_LEVEL_EMOJI[prop.level]} ${MONO_LEVEL_NAMES[prop.level]}!`);
    monoBroadcast(room); return;
  }

  // ---- DASH ----
  if (msg.action==='DASH' && gs.phase==='dash') {
    const pr = gs.pendingRent;
    const success = Math.random() < 0.30;
    if (success) {
      gs.log.unshift(`💨 ${name} dashte weg! Ontsnapt aan de huur! 🏃`);
    } else {
      const pay = pr.rent * 2;
      gs.money[clientId] = (gs.money[clientId]||0) - pay;
      gs.money[pr.ownerId] = (gs.money[pr.ownerId]||0) + pay;
      const ownerName = room.clients.find(c=>c.id===pr.ownerId)?.name||'?';
      gs.log.unshift(`${name} probeerde te dashen maar GEPAKT! Betaalt DUBBEL €${pay} aan ${ownerName} 😂`);
      monoCheckBankruptcy(gs, clientId);
    }
    gs.pendingRent=null; gs.popup=null; gs.phase='playing';
    monoBroadcast(room); return;
  }

  // ---- PAY RENT ----
  if (msg.action==='PAY_RENT' && gs.phase==='dash') {
    const pr = gs.pendingRent;
    gs.money[clientId] = (gs.money[clientId]||0) - pr.rent;
    gs.money[pr.ownerId] = (gs.money[pr.ownerId]||0) + pr.rent;
    const ownerName = room.clients.find(c=>c.id===pr.ownerId)?.name||'?';
    gs.log.unshift(`${name} betaalt €${pr.rent} huur aan ${ownerName}.`);
    monoCheckBankruptcy(gs, clientId);
    gs.pendingRent=null; gs.popup=null; gs.phase='playing';
    monoBroadcast(room); return;
  }

  // ---- SPIN WHEEL (triggered by current player when cop landed on them) ----
  if (msg.action==='SPIN_WHEEL' && gs.phase==='spinning') {
    const result = monoSpin();
    gs.spinResult = result;
    const victims = gs.spinVictims||[];
    victims.forEach(vid => {
      const vname = room.clients.find(c=>c.id===vid)?.name||'?';
      if (result.type==='free') {
        gs.log.unshift(`🎉 ${vname} komt vrijuit! Agent had zijn donut.`);
      } else if (result.type==='fine') {
        gs.money[vid] = (gs.money[vid]||0) - result.v;
        gs.log.unshift(`💸 ${vname} betaalt €${result.v} boete!`);
        monoCheckBankruptcy(gs, vid);
      } else if (result.type==='jail') {
        gs.pos[vid]=10; gs.jail[vid]=true;
        gs.log.unshift(`🔒 ${vname} gearresteerd door de agent!`);
      } else if (result.type==='chase') {
        gs.pos[vid]=(gs.pos[vid]-3+40)%40;
        gs.log.unshift(`🏃 ${vname} ontsnapt maar gaat 3 stappen terug!`);
      }
    });
    gs.spinVictims=[];
    gs.phase='spin_result';
    monoBroadcast(room); return;
  }

  // ---- CLOSE SPIN RESULT ----
  if (msg.action==='CLOSE_SPIN' && gs.phase==='spin_result') {
    gs.spinResult=null;
    monoCopDone(room); return;
  }

  // ---- USE FREE PASS ----
  if (msg.action==='USE_FREE_PASS') {
    if (!gs.freePass[clientId]) return;
    gs.freePass[clientId]=false; gs.jail[clientId]=false; gs.jailTurns[clientId]=0;
    gs.log.unshift(`${name} gebruikt de vrijlatingspas! 🗝️`);
    monoBroadcast(room); return;
  }

  // ---- END TURN ----
  if (msg.action==='END_TURN') {
    monoEndTurn(room); return;
  }
}

// ==================== START ====================
const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`🎮 PartyGames running on port ${PORT}`));

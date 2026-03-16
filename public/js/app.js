/* ============================================================
   CAH FRIENDS — FRONTEND (Vercel + Pusher edition)
   ============================================================ */

// ── State ─────────────────────────────────────────────────
let myUser     = null;
let myToken    = null;
let mySession  = null;   // { id, isHost, players, settings }
let isHost     = false;
let friends    = [];
let currentGs  = null;   // latest game state for this user
let chatUnread = 0;
let selectedPts = 7;
let customBlack = [];
let customWhite = [];
let selectedColor = '#FF6B6B';

// ── Pusher ────────────────────────────────────────────────
let pusher          = null;
let presenceChannel = null;   // presence-session-{id}
let privateChannel  = null;   // private-user-{userId}

const PUSHER_KEY     = window.PUSHER_KEY     || '';   // injected at build or from meta tag
const PUSHER_CLUSTER = window.PUSHER_CLUSTER || 'eu';

function initPusher() {
  if (pusher) return;
  if (!PUSHER_KEY) { console.warn('No PUSHER_KEY set'); return; }

  pusher = new Pusher(PUSHER_KEY, {
    cluster: PUSHER_CLUSTER,
    authEndpoint: '/api/pusher-auth',
    auth: {
      headers: { Authorization: 'Bearer ' + myToken }
    },
  });

  pusher.connection.bind('connected', () => console.log('[Pusher] connected'));
  pusher.connection.bind('error',     (e) => console.error('[Pusher] error', e));

  // Subscribe to private personal channel for notifications
  privateChannel = pusher.subscribe(`private-user-${myUser.id}`);
  bindPrivateEvents(privateChannel);
}

function bindPrivateEvents(ch) {
  ch.bind('friend-request', (data) => {
    toast(`👥 Vriendschapsverzoek van ${data.from.username}!`, 'info', 8000);
    loadFriends();
  });

  ch.bind('friend-accepted', (data) => {
    toast(`🎉 ${data.user.username} is nu jouw vriend!`, 'success', 5000);
    loadFriends();
  });

  ch.bind('game-invite', (data) => {
    showGameInviteToast(data);
  });
}

function joinSessionChannel(sid) {
  if (presenceChannel) {
    pusher.unsubscribe(presenceChannel.name);
    presenceChannel = null;
  }

  presenceChannel = pusher.subscribe(`presence-session-${sid}`);

  presenceChannel.bind('pusher:subscription_succeeded', (members) => {
    console.log('[Pusher] joined session channel, members:', members.count);
  });

  presenceChannel.bind('pusher:member_added', (member) => {
    console.log('[Pusher] member joined:', member.info.username);
  });

  presenceChannel.bind('pusher:member_removed', (member) => {
    console.log('[Pusher] member left:', member.info.username);
  });

  presenceChannel.bind('player-joined', (data) => {
    if (mySession) mySession.players = data.players;
    renderLobby(data.players, mySession?.settings, mySession?.id);
    addChatMsg({ system: true, text: `${data.player.name} heeft de lobby betreden!` });
    toast(`${data.player.name} is meegedaan!`, 'info');
  });

  presenceChannel.bind('player-left', (data) => {
    if (mySession) {
      mySession.players = data.players;
      if (data.newHostId === myUser.id) {
        isHost = true;
        mySession.isHost = true;
        toast('Je bent nu de host!', 'info');
      }
    }
    renderLobby(data.players, mySession?.settings, mySession?.id);
    addChatMsg({ system: true, text: `${data.name} heeft de lobby verlaten` });
  });

  presenceChannel.bind('settings-update', (settings) => {
    if (mySession) mySession.settings = settings;
    const el = document.getElementById('lobby-maxpts-display');
    if (el) el.textContent = settings.maxPoints || 7;
  });

  presenceChannel.bind('game-state', (data) => {
    // Server sends targetUserId so each client only renders their own state
    if (data.targetUserId && data.targetUserId !== myUser.id) return;

    currentGs = data.state;
    if (document.getElementById('screen-lobby').classList.contains('active')) {
      document.getElementById('game-chat-msgs').innerHTML = '';
      showScreen('screen-game');
    }
    renderGame(data.state);
  });

  presenceChannel.bind('chat-msg', (data) => {
    addChatMsg(data.message);
  });
}

function leaveSessionChannel() {
  if (presenceChannel) {
    pusher.unsubscribe(presenceChannel.name);
    presenceChannel = null;
  }
}

// ── Colors ────────────────────────────────────────────────
const COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94',
                '#B4F8C8','#A0C4FF','#FFADAD','#C77DFF','#80FFDB'];

// ── Toast ─────────────────────────────────────────────────
function toast(text, variant = 'default', duration = 3500) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${variant}`;
  el.textContent = text;
  c.appendChild(el);
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  const t = setTimeout(remove, duration);
  el.addEventListener('click', () => { clearTimeout(t); remove(); });
}

function showGameInviteToast(data) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-info';
  el.style.cssText = 'cursor:default;padding:0.9rem 1.1rem;';
  el.innerHTML = `
    <div style="font-weight:800;margin-bottom:0.3rem">🃏 Speluitnodiging!</div>
    <div style="margin-bottom:0.6rem">${esc(data.from.username)} nodigt je uit voor CAH</div>
    <button style="padding:0.35rem 0.8rem;background:var(--accent4);border:none;border-radius:6px;
      color:white;font-weight:700;cursor:pointer;font-family:inherit"
      onclick="Game.joinById('${data.sessionId}')">Meedoen →</button>`;
  c.appendChild(el);
  const remove = () => { el.classList.add('out'); setTimeout(() => el.remove(), 300); };
  setTimeout(remove, 15000);
}

// ── Screen ────────────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}
function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }
function openModal(id)  { document.getElementById(id)?.classList.remove('hidden'); }

// ── Auth tab ──────────────────────────────────────────────
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.auth-form').forEach(f => f.classList.add('hidden'));
  event.currentTarget.classList.add('active');
  document.getElementById(`auth-${tab}`)?.classList.remove('hidden');
}

function initColorPicker() {
  const picker = document.getElementById('color-picker');
  if (!picker) return;
  picker.innerHTML = COLORS.map(c =>
    `<div class="color-dot ${c === selectedColor ? 'selected' : ''}"
          style="background:${c}" onclick="selectColor('${c}',this)"></div>`
  ).join('');
}

function selectColor(color, el) {
  selectedColor = color;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
  el?.classList.add('selected');
}

// ── API fetch ─────────────────────────────────────────────
async function api(url, method = 'GET', body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (myToken) opts.headers['Authorization'] = 'Bearer ' + myToken;
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

// ── Auth ──────────────────────────────────────────────────
const Auth = {
  async login() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;
    if (!username || !password) { toast('Vul alles in', 'error'); return; }
    const r = await api('/api/login', 'POST', { username, password }).catch(() => null);
    if (!r || r.error) { toast(r?.error || 'Verbindingsfout', 'error'); return; }
    saveAuth(r.token, r.user);
    enterDashboard();
  },

  async register() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    if (!username || !password) { toast('Vul alles in', 'error'); return; }
    const r = await api('/api/register', 'POST', { username, password, avatarColor: selectedColor }).catch(() => null);
    if (!r || r.error) { toast(r?.error || 'Verbindingsfout', 'error'); return; }
    saveAuth(r.token, r.user);
    enterDashboard();
  },

  logout() {
    localStorage.removeItem('cah_token');
    localStorage.removeItem('cah_user');
    if (pusher) { pusher.disconnect(); pusher = null; }
    myToken = null; myUser = null; mySession = null;
    showScreen('screen-auth');
  },
};

function saveAuth(token, user) {
  myToken = token; myUser = user;
  localStorage.setItem('cah_token', token);
  localStorage.setItem('cah_user', JSON.stringify(user));
}

// ── Dashboard ─────────────────────────────────────────────
async function enterDashboard() {
  document.getElementById('dash-username').textContent = myUser.username;
  const dot = document.getElementById('dash-user-dot');
  if (dot) dot.style.background = myUser.color || '#4d96ff';
  showScreen('screen-dashboard');
  initPusher();
  loadFriends();
  loadStats();
  loadLeaderboard();
}

async function loadFriends() {
  friends = await api('/api/friends').catch(() => []);
  renderFriendsList();
}

function renderFriendsList() {
  const list = document.getElementById('friends-list');
  if (!list) return;
  if (!friends.length) {
    list.innerHTML = '<div class="empty-state">Nog geen vrienden. Voeg iemand toe! 👆</div>';
    return;
  }

  const accepted = friends.filter(f => f.status === 'accepted');
  const pending  = friends.filter(f => f.status === 'pending');
  let html = '';

  pending.forEach(f => {
    if (f.direction === 'received') {
      html += `<div class="friend-row">
        <div class="friend-avatar" style="background:${f.color}">${f.username[0].toUpperCase()}</div>
        <div class="friend-name">${esc(f.username)}</div>
        <span class="pending-badge">verzoek</span>
        <div class="friend-actions">
          <button class="btn-friend-action btn-friend-accept" onclick="Friends.accept('${f.friendship_id}')">✓</button>
          <button class="btn-friend-action btn-friend-decline" onclick="Friends.decline('${f.friendship_id}')">✕</button>
        </div></div>`;
    } else {
      html += `<div class="friend-row">
        <div class="friend-avatar" style="background:${f.color}">${f.username[0].toUpperCase()}</div>
        <div class="friend-name">${esc(f.username)}</div>
        <span class="pending-badge">verstuurd</span></div>`;
    }
  });

  accepted.forEach(f => {
    html += `<div class="friend-row">
      <div class="friend-avatar" style="background:${f.color}">${f.username[0].toUpperCase()}</div>
      <div><div class="friend-name">${esc(f.username)}</div></div>
    </div>`;
  });

  list.innerHTML = html;
}

async function loadStats() {
  const data = await api('/api/me').catch(() => ({}));
  document.getElementById('stat-wins').textContent   = data.wins || 0;
  document.getElementById('stat-rounds').textContent = data.rounds_played || 0;
  document.getElementById('stat-czar').textContent   = data.czar_picks || 0;
  document.getElementById('stat-streak').textContent = data.best_streak || 0;
}

async function loadLeaderboard() {
  const list = document.getElementById('leaderboard-list');
  const data = await api('/api/leaderboard').catch(() => []);
  if (!data.length) { list.innerHTML = '<div class="empty-state">Nog geen data</div>'; return; }
  list.innerHTML = data.map((u, i) => `
    <div class="lb-row">
      <div class="lb-rank ${i < 3 ? 'top' : ''}">${i===0?'🥇':i===1?'🥈':i===2?'🥉':i+1}</div>
      <div class="friend-avatar" style="background:${u.color};width:28px;height:28px;font-size:0.75rem">${u.username[0].toUpperCase()}</div>
      <div class="lb-name">${esc(u.username)}</div>
      <div><span class="lb-wins">${u.wins}</span><span class="lb-label"> wins</span></div>
    </div>`).join('');
}

// ── Friends ───────────────────────────────────────────────
const Friends = {
  showAdd() {
    document.getElementById('addfriend-input').value = '';
    openModal('modal-addfriend');
    setTimeout(() => document.getElementById('addfriend-input')?.focus(), 100);
  },

  async sendRequest() {
    const username = document.getElementById('addfriend-input').value.trim();
    if (!username) { toast('Vul een gebruikersnaam in', 'error'); return; }
    const r = await api('/api/friends', 'POST', { username }).catch(() => null);
    if (!r || r.error) { toast(r?.error || 'Fout', 'error'); return; }
    closeModal('modal-addfriend');
    toast(r.status === 'accepted'
      ? `Je bent nu vrienden met ${username}! 🎉`
      : `Verzoek verstuurd naar ${username}!`, 'success');
    loadFriends();
  },

  async accept(friendshipId) {
    await api('/api/friends-action', 'POST', { action: 'accept', friendshipId });
    toast('Vriendschapsverzoek geaccepteerd! 🎉', 'success');
    loadFriends();
  },

  async decline(friendshipId) {
    await api('/api/friends-action', 'POST', { action: 'decline', friendshipId });
    loadFriends();
  },
};

// ── Game create ───────────────────────────────────────────
function selectPts(el, pts) {
  selectedPts = pts;
  document.querySelectorAll('.pts-opt').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

const Game = {
  showCreate() {
    customBlack = []; customWhite = [];
    renderCustomCards();
    openModal('modal-create');
  },

  addCustomCard(type) {
    const input = document.getElementById(type === 'black' ? 'custom-black-input' : 'custom-white-input');
    const val = input?.value.trim();
    if (!val) return;
    if (type === 'black' && !val.includes('___')) { toast('Zwarte kaart moet ___ bevatten!', 'error'); return; }
    if (type === 'black') customBlack.push(val);
    else customWhite.push(val);
    input.value = '';
    renderCustomCards();
  },

  async create() {
    closeModal('modal-create');
    const r = await api('/api/session', 'POST', {
      maxPoints: selectedPts,
      customBlack,
      customWhite,
    });
    if (r.error) { toast(r.error, 'error'); return; }
    mySession = { id: r.sessionId, isHost: true, players: r.players, settings: r.settings };
    isHost = true;
    document.getElementById('lobby-chat-msgs').innerHTML = '';
    showScreen('screen-lobby');
    renderLobby(r.players, r.settings, r.sessionId);
    joinSessionChannel(r.sessionId);
  },

  async joinById(sessionId) {
    // Dismiss invite toasts
    document.querySelectorAll('.toast').forEach(t => {
      t.classList.add('out'); setTimeout(() => t.remove(), 300);
    });
    const r = await api(`/api/session/${sessionId}`, 'POST', { action: 'join' });
    if (r.error) { toast(r.error, 'error'); return; }
    mySession = { id: sessionId, isHost: r.isHost, players: r.players, settings: r.settings };
    isHost = r.isHost;
    document.getElementById('lobby-chat-msgs').innerHTML = '';
    showScreen('screen-lobby');
    renderLobby(r.players, r.settings, sessionId);
    joinSessionChannel(sessionId);

    // If game already in progress, render it
    if (r.gameState && r.gameState.phase) {
      const gs = r.gameState;
      // build a minimal player view
      currentGs = {
        ...gs,
        myHand: gs.hands?.[myUser.id] || [],
        hasSubmitted: !!gs.submissions?.[myUser.id],
        mySubmission: gs.submissions?.[myUser.id] || null,
        players: r.players.map(p => ({ id: p.userId, name: p.name, color: p.color, isHost: p.isHost, score: gs.scores?.[p.userId] || 0 })),
        czarName: r.players.find(p => p.userId === gs.czar)?.name || '?',
        lastWinnerName: r.players.find(p => p.userId === gs.lastWinner)?.name || '?',
        maxPoints: r.settings.maxPoints,
        submittedIds: Object.keys(gs.submissions || {}),
      };
      document.getElementById('game-chat-msgs').innerHTML = '';
      showScreen('screen-game');
      renderGame(currentGs);
    }
  },

  lobbyAddCard(type) {
    const input = document.getElementById(type === 'black' ? 'lob-black-input' : 'lob-white-input');
    const val = input?.value.trim();
    if (!val) return;
    if (type === 'black' && !val.includes('___')) { toast('Zwarte kaart moet ___ bevatten!', 'error'); return; }
    api(`/api/session/${mySession.id}`, 'POST', {
      action: 'settings',
      customBlack: type === 'black' ? [...(mySession.settings.customBlack || []), val] : undefined,
      customWhite: type === 'white' ? [...(mySession.settings.customWhite || []), val] : undefined,
    }).then(() => {
      toast('✅ Kaart toegevoegd!', 'success');
      input.value = '';
    });
  },

  async start() {
    if (!isHost || !mySession) return;
    const r = await api(`/api/game/${mySession.id}`, 'POST', { action: 'start' });
    if (r.error) { toast(r.error, 'error'); }
  },

  async leave() {
    if (!confirm('Weet je zeker dat je wilt verlaten?')) return;
    if (mySession) {
      await api(`/api/session/${mySession.id}`, 'POST', { action: 'leave' }).catch(() => {});
      leaveSessionChannel();
      mySession = null; currentGs = null; isHost = false;
    }
    showScreen('screen-dashboard');
    loadFriends(); loadStats();
  },

  async inviteFriend(friendId) {
    if (!mySession) return;
    await api(`/api/session/${mySession.id}`, 'POST', { action: 'invite', friendId });
    toast('Uitnodiging verstuurd! 📨', 'success');
  },

  sendChat() {
    const inLobby = document.getElementById('screen-lobby').classList.contains('active');
    const inputId = inLobby ? 'lobby-chat-input' : 'game-chat-input';
    const input = document.getElementById(inputId);
    const text = input?.value.trim();
    if (!text || !mySession) return;
    input.value = '';

    // Optimistically add message locally
    const m = {
      playerId: myUser.id,
      playerName: myUser.username,
      playerColor: myUser.color,
      text,
    };
    addChatMsg(m);

    // Push via Pusher server-side trigger
    api('/api/chat', 'POST', { sessionId: mySession.id, text }).catch(() => {});
  },
};

// ── Custom cards preview ──────────────────────────────────
function renderCustomCards() {
  const bl = document.getElementById('custom-black-list');
  const wl = document.getElementById('custom-white-list');
  if (bl) bl.innerHTML = customBlack.map((c, i) =>
    `<span class="custom-card-chip chip-black">${esc(c.length>30?c.slice(0,30)+'…':c)}
     <button class="chip-remove" onclick="customBlack.splice(${i},1);renderCustomCards()">✕</button></span>`
  ).join('');
  if (wl) wl.innerHTML = customWhite.map((c, i) =>
    `<span class="custom-card-chip chip-white">${esc(c.length>30?c.slice(0,30)+'…':c)}
     <button class="chip-remove" onclick="customWhite.splice(${i},1);renderCustomCards()">✕</button></span>`
  ).join('');
}

// ── Lobby render ──────────────────────────────────────────
function renderLobby(players, settings, sessionId) {
  document.getElementById('lobby-session-id').textContent = sessionId || '';
  document.getElementById('lobby-maxpts-display').textContent = settings?.maxPoints || 7;

  const grid = document.getElementById('lobby-players');
  if (grid) {
    grid.innerHTML = players.map(p => `
      <div class="player-row">
        <div class="player-avatar" style="background:${p.color}">${p.name[0].toUpperCase()}</div>
        <div class="player-name">${esc(p.name)}
          ${p.userId === myUser?.id ? '<span class="player-you">(jij)</span>' : ''}
        </div>
        ${p.isHost ? '<span class="player-host">👑 Host</span>' : '<span style="color:var(--text3);font-size:.75rem">🎮</span>'}
      </div>`).join('');
  }

  const hostCtrl = document.getElementById('lobby-host-controls');
  const waitMsg  = document.getElementById('lobby-waiting-msg');
  const inviteSec = document.getElementById('lobby-invite-section');

  if (isHost) {
    hostCtrl?.classList.remove('hidden');
    waitMsg?.classList.add('hidden');
    inviteSec?.classList.remove('hidden');
    const warn = document.getElementById('lobby-min-warn');
    if (players.length < 3) warn?.classList.remove('hidden');
    else warn?.classList.add('hidden');
    renderLobbyFriendList(players);
  } else {
    hostCtrl?.classList.add('hidden');
    waitMsg?.classList.remove('hidden');
    inviteSec?.classList.add('hidden');
  }
}

function renderLobbyFriendList(currentPlayers) {
  const list = document.getElementById('lobby-friend-list');
  if (!list) return;
  const accepted = friends.filter(f => f.status === 'accepted');
  const inGame = new Set(currentPlayers.map(p => p.userId));

  if (!accepted.length) {
    list.innerHTML = '<div class="empty-state" style="padding:.75rem">Nog geen vrienden om uit te nodigen</div>';
    return;
  }
  list.innerHTML = accepted.map(f => {
    const already = inGame.has(f.id);
    return `<div class="lobby-friend-row">
      <div class="friend-avatar" style="background:${f.color};width:28px;height:28px;font-size:.75rem">${f.username[0].toUpperCase()}</div>
      <div class="friend-name">${esc(f.username)}</div>
      ${already
        ? '<span style="font-size:.75rem;color:var(--accent3)">✓ In spel</span>'
        : `<button class="btn-friend-action btn-friend-invite" onclick="Game.inviteFriend('${f.id}')">Uitnodigen</button>`
      }
    </div>`;
  }).join('');
}

// ── Game render ───────────────────────────────────────────
function renderGame(state) {
  currentGs = state;
  const main = document.getElementById('game-main');
  if (!main) return;

  // Score pills
  const pills = document.getElementById('game-score-pills');
  if (pills) {
    pills.innerHTML = (state.players || []).map(p => {
      const czar = p.id === state.czar;
      return `<div class="score-pill ${czar?'czar':''}" style="background:${p.color}22;border-color:${p.color}66;color:${p.color}">
        ${czar?'👑 ':''}${esc(p.name)}: ${p.score}</div>`;
    }).join('');
  }

  switch (state.phase) {
    case 'playing': renderPlaying(main, state); break;
    case 'judging': renderJudging(main, state); break;
    case 'scores':  renderScores(main, state);  break;
  }
}

function renderPlaying(main, state) {
  const isCzar = state.czar === myUser?.id;
  const needed = (state.players?.length || 1) - 1;
  const submittedCount = state.submittedIds?.length || 0;

  main.innerHTML = `
    <div class="cah-round-bar">
      <span class="cah-round-label">Ronde ${state.round}</span>
      <span class="cah-czar-label">🎩 Tsaar: <strong>${esc(state.czarName)}</strong></span>
    </div>
    <div class="black-card">
      <div class="black-card-corner">CAH</div>
      <div class="black-card-text">${esc(state.currentBlack || '')}</div>
      <div class="black-card-pick">Kies 1</div>
    </div>
    ${isCzar ? `
      <div class="czar-waiting-box">
        <div class="czar-icon">👑</div>
        <div class="czar-box-title">Jij bent de Kaart Tsaar!</div>
        <div class="czar-box-sub">Wacht tot iedereen een kaart heeft gespeeld.</div>
        <div class="submitted-count">${submittedCount} / ${needed} ingestuurd</div>
      </div>`
    : state.hasSubmitted ? `
      <div class="submitted-box">
        <div class="czar-icon">✅</div>
        <div class="czar-box-title">Kaart gespeeld!</div>
        <div class="submitted-card-preview">"${esc(state.mySubmission || '')}"</div>
        <div class="submitted-count">${submittedCount} / ${needed} ingestuurd</div>
      </div>`
    : `
      <div class="hand-label">Kies jouw grappigste antwoord:</div>
      <div class="white-cards-grid">
        ${(state.myHand || []).map(card => `
          <div class="white-card" onclick="CAH.submit(this,${JSON.stringify(card)})">
            <div class="white-card-text">${esc(card)}</div>
            <div class="white-card-brand">🂠</div>
          </div>`).join('')}
      </div>`}`;
}

function renderJudging(main, state) {
  const isCzar = state.czar === myUser?.id;
  const cards = Object.values(state.submissions || {});
  const shuffled = [...cards].sort(() => Math.random() - 0.5);

  main.innerHTML = `
    <div class="cah-round-bar">
      <span class="cah-round-label">Ronde ${state.round}</span>
    </div>
    <div class="black-card">
      <div class="black-card-corner">CAH</div>
      <div class="black-card-text">${esc(state.currentBlack || '')}</div>
    </div>
    <div class="judge-header">
      ${isCzar
        ? '<h3>👑 Kies de grappigste kaart!</h3><p>Klik op de kaart die jij het grappigst vindt</p>'
        : '<h3>🤔 Alle kaarten zijn binnen!</h3><p>De Tsaar kiest de winnaar...</p>'}
    </div>
    <div class="judge-grid">
      ${shuffled.map(card => `
        <div class="white-card ${isCzar ? 'judge-card' : ''}"
          ${isCzar ? `onclick="CAH.pickWinner(${JSON.stringify(card)})"` : 'style="cursor:default"'}>
          <div class="white-card-text">${esc(card)}</div>
          <div class="white-card-brand">🂠</div>
        </div>`).join('')}
    </div>`;
}

function renderScores(main, state) {
  const maxPts = state.maxPoints || 7;
  const roundWinner = state.players?.find(p => p.id === state.lastWinner);
  const gameWinner  = state.players?.find(p => p.id === state.winner);

  let html = '';
  if (state.winner) {
    html += `<div class="game-winner-banner">
      <span class="winner-crown">🏆</span>
      <div class="winner-name">${esc(gameWinner?.name || '?')} WINT!</div>
      <div class="winner-sub">Absolute legend.</div>
    </div>`;
  } else if (roundWinner) {
    html += `<div class="round-winner-banner">
      <div class="czar-icon">🎉</div>
      <div class="czar-box-title">${esc(roundWinner.name)} wint deze ronde!</div>
      <div class="winning-card-display">"${esc(state.lastWinningCard || '')}"</div>
    </div>`;
  }

  html += '<div class="scores-list">';
  [...(state.players || [])]
    .sort((a, b) => (state.scores?.[b.id]||0) - (state.scores?.[a.id]||0))
    .forEach(p => {
      const pts = state.scores?.[p.id] || 0;
      html += `<div class="score-row ${p.id===state.lastWinner?'is-winner':''}">
        <div class="friend-avatar" style="background:${p.color};width:28px;height:28px;font-size:.75rem;flex-shrink:0">${p.name[0].toUpperCase()}</div>
        <div class="score-player-name">${esc(p.name)}</div>
        <div class="score-bar-wrap"><div class="score-bar" style="width:${Math.min(100,(pts/maxPts)*100)}%"></div></div>
        <div class="score-pts">${pts}/${maxPts}</div>
      </div>`;
    });
  html += '</div>';

  if (isHost) {
    html += `<button class="btn-next-round" onclick="CAH.nextRound()">
      ${state.winner ? '🔄 Nieuw spel' : '➡️ Volgende ronde'}
    </button>`;
  } else {
    html += '<div class="waiting-msg"><div class="loading-dots"><span></span><span></span><span></span></div>Wachten op host...</div>';
  }
  main.innerHTML = html;
}

// ── CAH actions ───────────────────────────────────────────
const CAH = {
  submit(el, card) {
    document.querySelectorAll('.white-card').forEach(c => c.classList.remove('selected'));
    el?.classList.add('selected');
    setTimeout(() => api(`/api/game/${mySession.id}`, 'POST', { action: 'submit', card }).then(r => {
      if (r.error) toast(r.error, 'error');
    }), 200);
  },

  pickWinner(card) {
    api(`/api/game/${mySession.id}`, 'POST', { action: 'pick-winner', card }).then(r => {
      if (r.error) toast(r.error, 'error');
    });
  },

  nextRound() {
    api(`/api/game/${mySession.id}`, 'POST', { action: 'next-round' }).then(r => {
      if (r.error) toast(r.error, 'error');
    });
  },
};

// ── Chat ──────────────────────────────────────────────────
function addChatMsg(msg, scroll = true) {
  const inLobby = document.getElementById('screen-lobby').classList.contains('active');
  const chatId  = inLobby ? 'lobby-chat-msgs' : 'game-chat-msgs';
  const el = document.getElementById(chatId);
  if (!el) return;

  const isMe = msg.playerId === myUser?.id;
  const div = document.createElement('div');
  div.className = `chat-msg ${isMe ? 'mine' : ''} ${msg.system ? 'system' : ''}`;

  if (msg.system) {
    div.textContent = msg.text;
  } else {
    div.innerHTML = `<div class="chat-msg-name" style="color:${msg.playerColor||'#aaa'}">${esc(msg.playerName||'')}</div>
      <div class="chat-msg-text">${esc(msg.text||'')}</div>`;
  }
  el.appendChild(div);
  if (scroll) el.scrollTop = el.scrollHeight;

  if (!inLobby && document.getElementById('game-chat-panel')?.classList.contains('hidden') && !isMe) {
    chatUnread++;
    document.querySelector('.chat-btn-badge')?.classList.add('show');
  }
}

function toggleGameChat() {
  const panel = document.getElementById('game-chat-panel');
  panel?.classList.toggle('hidden');
  if (!panel?.classList.contains('hidden')) {
    chatUnread = 0;
    document.querySelector('.chat-btn-badge')?.classList.remove('show');
    const msgs = document.getElementById('game-chat-msgs');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }
}

// ── Utils ─────────────────────────────────────────────────
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
            .replace(/"/g,'&quot;').replace(/'/g,'&#039;');
}

// ── Init ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initColorPicker();

  document.getElementById('login-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') Auth.login();
  });
  document.getElementById('reg-password')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') Auth.register();
  });
  document.getElementById('addfriend-input')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') Friends.sendRequest();
  });

  // Restore session from localStorage
  const savedToken = localStorage.getItem('cah_token');
  const savedUser  = localStorage.getItem('cah_user');
  if (savedToken && savedUser) {
    try {
      myToken = savedToken;
      myUser  = JSON.parse(savedUser);
      enterDashboard();
    } catch { showScreen('screen-auth'); }
  } else {
    showScreen('screen-auth');
  }
});

// ===== APP STATE =====
let ws = null;
let myId = null;
let roomState = null;
let selectedGame = 'cah';
let activeTab = 'game-tab';
let unreadChat = 0;

// ===== WEBSOCKET =====
let _pendingAction = null;

function connectWS(onOpenCallback) {
  // Always use wss:// on https, ws:// on http
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}`;
  console.log('Connecting to:', url);

  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('WebSocket connected!');
    if (onOpenCallback) onOpenCallback();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    handleMessage(msg);
  };

  ws.onclose = (e) => {
    console.log('WebSocket closed:', e.code, e.reason);
    showToast('Disconnected. Refresh to reconnect.');
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
    showToast('Connection error! Check console for details.');
  };
}

function sendWS(data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'ROOM_JOINED':
      myId = msg.yourId;
      roomState = msg.roomState;
      enterRoom();
      break;

    case 'ROOM_UPDATE':
      roomState = msg.roomState;
      updatePlayersTab();
      updateRoomHeader();
      if (msg.roomState.game !== (roomState?.game)) {
        loadCurrentGame();
      }
      break;

    case 'PLAYER_JOINED':
      showToast(`${msg.player.name} joined!`);
      roomState = msg.roomState;
      updatePlayersTab();
      break;

    case 'CHAT':
      addChatMessage(msg.message);
      break;

    case 'GAME_STATE':
      roomState = msg.roomState;
      updatePlayersTab();
      if (msg.game === 'cah') renderCAH(msg.state);
      if (msg.game === 'poker') renderPoker(msg.state);
      if (msg.game === 'monopoly') renderMonopoly(msg.state);
      break;

    case 'ERROR':
      showToast('❌ ' + msg.message);
      break;

    case 'SETTINGS_UPDATED':
      showToast('✅ Card added!');
      break;
  }
}

// ===== HOME SCREEN =====
function showCreateRoom() {
  document.getElementById('create-form').classList.remove('hidden');
  document.getElementById('join-form').classList.add('hidden');
}

function showJoinRoom() {
  document.getElementById('join-form').classList.remove('hidden');
  document.getElementById('create-form').classList.add('hidden');
}

function hideAllForms() {
  document.getElementById('create-form').classList.add('hidden');
  document.getElementById('join-form').classList.add('hidden');
}

function selectGame(el) {
  document.querySelectorAll('#create-form .game-option').forEach(o => o.classList.remove('selected'));
  el.classList.add('selected');
  selectedGame = el.dataset.game;
}

function createRoom() {
  const name = document.getElementById('create-name').value.trim() || 'Host';
  if (!name) { showToast('Enter your name!'); return; }
  connectWS(() => {
    sendWS({ type: 'CREATE_ROOM', playerName: name, game: selectedGame });
  });
}

function joinRoom() {
  const name = document.getElementById('join-name').value.trim() || 'Player';
  const code = document.getElementById('join-code').value.trim().toUpperCase();
  if (!code) { showToast('Enter a room code!'); return; }
  connectWS(() => {
    sendWS({ type: 'JOIN_ROOM', playerName: name, code });
  });
}

function enterRoom() {
  document.getElementById('home-screen').classList.remove('active');
  document.getElementById('room-screen').classList.add('active');
  document.getElementById('room-code-text').textContent = roomState.code;
  updatePlayersTab();
  updateRoomHeader();
  loadCurrentGame();

  // Show settings tab only for host
  const isHost = roomState.players.find(p => p.id === myId)?.isHost;
  document.querySelectorAll('.host-only').forEach(el => {
    el.style.display = isHost ? '' : 'none';
  });

  // Set settings values
  if (roomState.settings?.maxPoints) {
    document.getElementById('setting-maxpoints').value = roomState.settings.maxPoints;
  }
}

function updateRoomHeader() {
  document.getElementById('room-code-text').textContent = roomState.code;
}

function loadCurrentGame() {
  const game = roomState?.game || 'cah';
  const container = document.getElementById('game-container');
  if (game === 'cah') renderCAHLobby(container);
  else if (game === 'poker') renderPokerLobby(container);
  else if (game === 'monopoly') renderMonopolyLobby(container);
}

// ===== CHAT =====
function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  sendWS({ type: 'CHAT', text });
  input.value = '';
}

function addChatMessage(msg) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');

  if (msg.system) {
    div.className = 'chat-msg system';
    div.textContent = msg.text;
  } else {
    const isMe = msg.playerId === myId;
    div.className = `chat-msg ${isMe ? 'mine' : ''}`;
    div.innerHTML = `<div class="chat-name">${escHtml(msg.playerName)}</div><div class="chat-text">${escHtml(msg.text)}</div>`;
  }

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;

  // Badge if not on chat tab
  if (activeTab !== 'chat-tab' && !msg.system) {
    unreadChat++;
    const badge = document.getElementById('chat-badge');
    badge.textContent = unreadChat > 9 ? '9+' : unreadChat;
    badge.classList.remove('hidden');
  }
}

// ===== PLAYERS TAB =====
function updatePlayersTab() {
  if (!roomState) return;
  const colors = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#B4F8C8','#FBE7C6','#A0C4FF'];
  const container = document.getElementById('players-list');
  container.innerHTML = roomState.players.map((p, i) => `
    <div class="player-card">
      <div class="player-avatar" style="background:${colors[i % colors.length]};color:#1a1a2e">
        ${p.name.charAt(0).toUpperCase()}
      </div>
      <div class="player-info">
        <div class="player-name">${escHtml(p.name)} ${p.id === myId ? '<span style="color:var(--accent4)">(you)</span>' : ''}</div>
        <div class="player-role">${p.isHost ? '👑 Host' : '🎮 Player'}</div>
      </div>
      <div class="player-score">${p.score || 0}</div>
    </div>
  `).join('');
}

// ===== TABS =====
function showTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');
  event.currentTarget.classList.add('active');
  activeTab = tabId;

  if (tabId === 'chat-tab') {
    unreadChat = 0;
    document.getElementById('chat-badge').classList.add('hidden');
    const msgs = document.getElementById('chat-messages');
    msgs.scrollTop = msgs.scrollHeight;
  }
}

// ===== SETTINGS =====
function updateSettings() {
  sendWS({
    type: 'UPDATE_SETTINGS',
    settings: {
      maxPoints: parseInt(document.getElementById('setting-maxpoints').value) || 7
    }
  });
}

function switchGame(game) {
  sendWS({ type: 'SET_GAME', game });
  showToast(`Switching to ${game === 'cah' ? 'Cards Against Humanity' : game === 'poker' ? 'Poker' : 'Monopoly'}...`);
}

function addCustomCard(type) {
  const input = document.getElementById(`custom-${type}`);
  const card = input.value.trim();
  if (!card) { showToast('Type a card first!'); return; }
  sendWS({
    type: 'GAME_ACTION',
    action: type === 'black' ? 'ADD_BLACK_CARD' : 'ADD_WHITE_CARD',
    card
  });
  input.value = '';
  showToast(`${type === 'black' ? 'Black' : 'White'} card added! 🎉`);
}

// ===== UTILS =====
function copyCode() {
  navigator.clipboard.writeText(roomState?.code || '').then(() => showToast('Room code copied! 📋'));
}

function showToast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isHost() {
  return roomState?.players?.find(p => p.id === myId)?.isHost || false;
}

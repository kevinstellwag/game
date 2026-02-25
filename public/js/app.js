// ===== STATE =====
let WS = null;
let myId = null;
let myRoomState = null;
let selectedGame = 'cah';
let chatOpen = false;
let unread = 0;
let wsReconnectTimer = null;

const COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#B4F8C8','#FBE7C6','#A0C4FF'];

// ===== WEBSOCKET =====
function connectWS(onOpen) {
  if (WS && (WS.readyState === 0 || WS.readyState === 1)) {
    // Already connecting or connected
    if (WS.readyState === 1 && onOpen) onOpen();
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${proto}//${location.host}`;
  console.log('[WS] Connecting to', url);
  
  WS = new WebSocket(url);

  WS.onopen = () => {
    console.log('[WS] Connected!');
    // Start client-side keepalive ping every 15s
    if (wsReconnectTimer) clearInterval(wsReconnectTimer);
    wsReconnectTimer = setInterval(() => {
      if (WS && WS.readyState === 1) WS.send(JSON.stringify({ type: 'PING' }));
    }, 15000);
    if (onOpen) onOpen();
  };

  WS.onmessage = (e) => {
    try {
      handleMsg(JSON.parse(e.data));
    } catch(err) {
      console.error('[WS] Parse error:', err);
    }
  };

  WS.onclose = (e) => {
    console.log('[WS] Closed:', e.code, e.reason);
    if (wsReconnectTimer) clearInterval(wsReconnectTimer);
    // Only show error if we were actually in a room
    if (myRoomState) toast('❌ Verbinding verbroken! Ververs de pagina.');
  };

  WS.onerror = (e) => {
    console.error('[WS] Error:', e);
  };
}

function sendWS(data) {
  if (!WS || WS.readyState !== 1) {
    toast('❌ Niet verbonden!');
    return;
  }
  WS.send(JSON.stringify(data));
}

function handleMsg(msg) {
  if (msg.type === 'PONG') return; // keepalive response

  if (msg.type === 'ROOM_JOINED') {
    myId = msg.yourId;
    myRoomState = msg.roomState;
    UI.enterLobby();
    return;
  }
  if (msg.type === 'ROOM_UPDATE') {
    myRoomState = msg.roomState;
    // If server reset to lobby, go back to lobby screen for everyone
    if (msg.roomState.phase === 'lobby') {
      show('screen-lobby');
    }
    UI.refreshLobby();
    return;
  }
  if (msg.type === 'SYS') {
    addChatMsg({ system: true, text: msg.text });
    return;
  }
  if (msg.type === 'CHAT') {
    addChatMsg(msg.message);
    return;
  }
  if (msg.type === 'CHAT_HISTORY') {
    msg.messages.forEach(m => addChatMsg(m, false));
    return;
  }
  if (msg.type === 'GAME_STATE') {
    myRoomState = msg.roomState;
    UI.enterGame();
    if (msg.game === 'cah') CAH.render(msg.state);
    else if (msg.game === 'poker') Poker.render(msg.state);
    else if (msg.game === 'monopoly') Mono.render(msg.state);
    return;
  }
  if (msg.type === 'TOAST') {
    toast(msg.text);
    return;
  }
  if (msg.type === 'ERROR') {
    toast('❌ ' + msg.message);
    return;
  }
}

// ===== APP ACTIONS =====
const App = {
  createRoom() {
    const name = document.getElementById('in-create-name').value.trim();
    if (!name) { toast('Vul je naam in!'); return; }
    connectWS(() => sendWS({ type: 'CREATE_ROOM', playerName: name, game: selectedGame }));
  },

  joinRoom() {
    const name = document.getElementById('in-join-name').value.trim();
    const code = document.getElementById('in-join-code').value.trim().toUpperCase();
    if (!name) { toast('Vul je naam in!'); return; }
    if (!code) { toast('Vul de kamer code in!'); return; }
    connectWS(() => sendWS({ type: 'JOIN_ROOM', playerName: name, code }));
  },

  startGame() {
    sendWS({ type: 'GAME_ACTION', action: 'START_GAME' });
  },

  sendChat() {
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    sendWS({ type: 'CHAT', text });
    input.value = '';
  },

  copyCode() {
    const code = myRoomState?.code || '';
    navigator.clipboard.writeText(code).then(() => toast('📋 Code gekopieerd: ' + code));
  },

  updateSettings() {
    const pts = parseInt(document.getElementById('lob-maxpts').value) || 7;
    sendWS({ type: 'UPDATE_SETTINGS', settings: { maxPoints: pts } });
  },

  addCard(type) {
    const el = document.getElementById(type === 'black' ? 'cah-custom-black' : 'cah-custom-white');
    const card = el.value.trim();
    if (!card) { toast('Type eerst een kaart!'); return; }
    if (type === 'black' && !card.includes('___')) { toast('Zwarte kaart moet ___ bevatten!'); return; }
    sendWS({ type: 'GAME_ACTION', action: 'ADD_CARD', cardType: type, card });
    el.value = '';
    toast('✅ Kaart toegevoegd!');
  },

  switchGame(game) {
    sendWS({ type: 'SET_GAME', game });
  },
};

// ===== UI =====
const UI = {
  showForm(type) {
    document.getElementById('form-create').classList.add('hidden');
    document.getElementById('form-join').classList.add('hidden');
    document.getElementById(`form-${type}`).classList.remove('hidden');
  },
  hideForm() {
    document.getElementById('form-create').classList.add('hidden');
    document.getElementById('form-join').classList.add('hidden');
  },

  enterLobby() {
    show('screen-lobby');
    UI.refreshLobby();
  },

  refreshLobby() {
    if (!myRoomState) return;
    const rs = myRoomState;
    const amHost = rs.players.find(p => p.id === myId)?.isHost;

    document.getElementById('lob-code').textContent = rs.code;
    const gameNames = { cah: '🃏 Cards Against Humanity', poker: '♠️ Poker', monopoly: '🏦 Monopoly' };
    document.getElementById('lob-game-name').textContent = gameNames[rs.game] || rs.game;

    // Players
    const pList = document.getElementById('lob-players');
    pList.innerHTML = rs.players.map((p, i) => `
      <div class="lobby-player-row">
        <div class="lp-avatar" style="background:${COLORS[i%COLORS.length]};color:#1a1a2e">${p.name.charAt(0).toUpperCase()}</div>
        <div class="lp-name">${esc(p.name)} ${p.id === myId ? '<span style="color:var(--accent4)">(jij)</span>' : ''}</div>
        <div class="lp-badge">${p.isHost ? '👑 Host' : '🎮'}</div>
      </div>
    `).join('');

    // Host controls
    document.getElementById('lob-host-controls').classList.toggle('hidden', !amHost);
    document.getElementById('lob-wait-msg').classList.toggle('hidden', !!amHost);

    if (amHost) {
      // Sync maxpoints
      const pts = document.getElementById('lob-maxpts');
      if (rs.settings?.maxPoints) pts.value = rs.settings.maxPoints;
    }

    // If game started AND we're on the lobby screen, go to game screen
    // (Don't auto-redirect if we intentionally came back to lobby)
    const onLobby = document.getElementById('screen-lobby').classList.contains('active');
    if (rs.phase === 'ingame' && !onLobby) {
      UI.enterGame();
    }
  },

  enterGame() {
    show('screen-game');
    document.getElementById('game-room-code').textContent = myRoomState?.code || '';
  },

  backToLobby() {
    // Reset game on server back to lobby so new players can join cleanly
    if (isHost()) {
      sendWS({ type: 'SET_GAME', game: myRoomState?.game || 'cah' });
    }
    show('screen-lobby');
    // Small delay so server has time to reset before we refresh
    setTimeout(() => UI.refreshLobby(), 100);
  },

  toggleChat() {
    chatOpen = !chatOpen;
    document.getElementById('chat-panel').classList.toggle('hidden', !chatOpen);
    if (chatOpen) {
      unread = 0;
      document.querySelector('.chat-badge-dot')?.classList.remove('show');
      const msgs = document.getElementById('chat-messages');
      msgs.scrollTop = msgs.scrollHeight;
    }
  },
};

// ===== GAME PICKER =====
function initGamePickers() {
  document.querySelectorAll('.game-picker').forEach(picker => {
    picker.querySelectorAll('.gpick').forEach(el => {
      el.addEventListener('click', () => {
        const game = el.dataset.game;
        if (picker.id === 'game-picker-create') {
          picker.querySelectorAll('.gpick').forEach(g => g.classList.remove('active'));
          el.classList.add('active');
          selectedGame = game;
        } else if (picker.id === 'game-picker-switch') {
          App.switchGame(game);
          toast('Spel wisselen naar ' + el.textContent + '...');
        }
      });
    });
  });
}

// ===== CHAT =====
function addChatMsg(msg, scroll = true) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');

  if (msg.system) {
    div.className = 'chat-msg sys';
    div.textContent = msg.text;
  } else {
    const isMe = msg.playerId === myId;
    div.className = `chat-msg ${isMe ? 'mine' : ''}`;
    div.innerHTML = `<div class="chat-name">${esc(msg.playerName)}</div><div class="chat-text">${esc(msg.text)}</div>`;
  }

  container.appendChild(div);
  if (scroll) container.scrollTop = container.scrollHeight;

  if (!chatOpen && !msg.system) {
    unread++;
    const dot = document.querySelector('.chat-badge-dot');
    if (dot) dot.classList.add('show');
  }
}

// ===== HELPERS =====
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function toast(text) {
  const t = document.getElementById('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(window._toastT);
  window._toastT = setTimeout(() => t.classList.remove('show'), 3000);
}

function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function isHost() {
  return myRoomState?.players?.find(p => p.id === myId)?.isHost || false;
}

// Add chat badge dot to chat toggle button
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('chat-toggle-btn');
  if (btn) {
    const dot = document.createElement('span');
    dot.className = 'chat-badge-dot';
    btn.appendChild(dot);
  }
  initGamePickers();
});

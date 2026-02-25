/* ===== MONOPOLY ===== */

const PLAYER_COLORS_MONO = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#B4F8C8','#FBE7C6','#A0C4FF'];
const PLAYER_TOKENS = ['🚂','🎩','👟','🐕','🚗','⛵','🎲','🤑'];

const MONO_BOARD = [
  {name:'GO',type:'go'},{name:'Mediterranean',type:'property',color:'#A52A2A',price:60,rent:2},
  {name:'Community\nChest',type:'chest'},{name:'Baltic',type:'property',color:'#A52A2A',price:60,rent:4},
  {name:'Income Tax\n$200',type:'tax',amount:200},{name:'Railroad',type:'railroad',price:200,rent:25},
  {name:'Oriental',type:'property',color:'#87CEEB',price:100,rent:6},{name:'Chance',type:'chance'},
  {name:'Vermont',type:'property',color:'#87CEEB',price:100,rent:6},{name:'Connecticut',type:'property',color:'#87CEEB',price:120,rent:8},
  {name:'Jail\nVisiting',type:'jail'},{name:'St. Charles',type:'property',color:'#FF69B4',price:140,rent:10},
  {name:'Electric\nCo.',type:'utility',price:150,rent:0},{name:'States Ave',type:'property',color:'#FF69B4',price:140,rent:10},
  {name:'Virginia',type:'property',color:'#FF69B4',price:160,rent:12},{name:'Railroad',type:'railroad',price:200,rent:25},
  {name:'St. James',type:'property',color:'#FFA500',price:180,rent:14},{name:'Community\nChest',type:'chest'},
  {name:'Tennessee',type:'property',color:'#FFA500',price:180,rent:14},{name:'New York',type:'property',color:'#FFA500',price:200,rent:16},
  {name:'Free\nParking',type:'free'},{name:'Kentucky',type:'property',color:'#FF0000',price:220,rent:18},
  {name:'Chance',type:'chance'},{name:'Indiana',type:'property',color:'#FF0000',price:220,rent:18},
  {name:'Illinois',type:'property',color:'#FF0000',price:240,rent:20},{name:'Railroad',type:'railroad',price:200,rent:25},
  {name:'Atlantic',type:'property',color:'#FFFF00',price:260,rent:22},{name:'Ventnor',type:'property',color:'#FFFF00',price:260,rent:22},
  {name:'Water\nWorks',type:'utility',price:150,rent:0},{name:'Marvin\nGardens',type:'property',color:'#FFFF00',price:280,rent:24},
  {name:'Go To\nJail',type:'gotojail'},{name:'Pacific',type:'property',color:'#00AA00',price:300,rent:26},
  {name:'N. Carolina',type:'property',color:'#00AA00',price:300,rent:26},{name:'Community\nChest',type:'chest'},
  {name:'Pennsylvania',type:'property',color:'#00AA00',price:320,rent:28},{name:'Railroad',type:'railroad',price:200,rent:25},
  {name:'Chance',type:'chance'},{name:'Park Place',type:'property',color:'#0000FF',price:350,rent:35},
  {name:'Luxury Tax\n$100',type:'tax',amount:100},{name:'Boardwalk',type:'property',color:'#0000FF',price:400,rent:50}
];

function renderMonopolyLobby(container) {
  if (roomState?.gameState?.phase) return;
  container.innerHTML = `
    <div class="mono-lobby">
      <div class="game-header-banner" style="background:linear-gradient(135deg,#1a0a2e,#2d1a5a)">
        <div class="game-title-big">🏦 Monopoly</div>
        <div class="game-subtitle">Destroy your friendships. Legally.</div>
      </div>
      <div class="lobby-info">
        <div class="info-card">
          <h3>How to Play</h3>
          <p>Roll dice, move around the board, buy properties, charge rent! Everyone starts with <strong>$1,500</strong>. Pass GO to collect $200. Don't go to jail. First to bankrupt everyone wins.</p>
        </div>
        <div class="info-card">
          <h3>Players (${roomState?.players?.length || 1})</h3>
          ${roomState?.players?.map((p, i) => `<div class="lobby-player">${PLAYER_TOKENS[i]} ${escHtml(p.name)} - $1,500 ${p.isHost ? '👑' : ''}</div>`).join('') || ''}
        </div>
        ${isHost() ? `
          <button class="btn-start btn-mono-start" onclick="sendWS({type:'GAME_ACTION',action:'START_GAME'})">
            🎲 Start Game!
          </button>
          ${(roomState?.players?.length||0) < 2 ? '<p class="warn-text">⚠️ Monopoly needs at least 2 players!</p>' : ''}
        ` : '<div class="waiting-host">Waiting for host to start...</div>'}
      </div>
    </div>
  `;
}

function renderMonopoly(state) {
  const container = document.getElementById('game-container');
  if (!container) return;

  const isMyTurn = state.currentPlayer === myId;
  const myPos = state.positions?.[myId] || 0;
  const myMoney = state.money?.[myId] || 0;
  const square = MONO_BOARD[myPos];
  const currentPlayerName = roomState?.players?.find(p => p.id === state.currentPlayer)?.name || '?';
  const canBuy = state.rolled && square && (square.type === 'property' || square.type === 'railroad' || square.type === 'utility') && !state.properties?.[myPos] && myMoney >= (square.price || 0);

  container.innerHTML = `
    <div class="mono-game">
      <!-- Top bar -->
      <div class="mono-top-bar">
        <span>Round ${state.round || 1}</span>
        ${state.diceRoll ? `<span>🎲 ${state.diceRoll[0]} + ${state.diceRoll[1]} = ${state.diceRoll[0]+state.diceRoll[1]}</span>` : ''}
        ${isMyTurn ? '<span class="your-turn-badge">YOUR TURN!</span>' : `<span>⏳ ${escHtml(currentPlayerName)}'s turn</span>`}
      </div>

      <!-- Board Mini Map -->
      <div class="mono-board-area">
        <div class="mono-mini-board" id="mini-board">
          ${renderMiniBoardHTML(state)}
        </div>
      </div>

      <!-- Player Panels -->
      <div class="mono-players-grid">
        ${(state.players || []).map((pid, i) => {
          const p = roomState?.players?.find(pl => pl.id === pid);
          const money = state.money?.[pid] || 0;
          const pos = state.positions?.[pid] || 0;
          const inJail = state.inJail?.[pid];
          const bankrupt = state.bankrupt?.[pid];
          const isCurrent = state.currentPlayer === pid;
          const ownedCount = Object.values(state.properties || {}).filter(owner => owner === pid).length;
          return `
            <div class="mono-player-card ${isCurrent ? 'current' : ''} ${bankrupt ? 'bankrupt' : ''}">
              <div class="mono-token">${PLAYER_TOKENS[i]}</div>
              <div class="mono-player-info">
                <div class="mono-player-name">${escHtml(p?.name || '?')} ${pid === myId ? '(you)' : ''}</div>
                <div class="mono-player-money" style="color:${money > 0 ? 'var(--accent3)' : 'var(--accent)'}">$${money}</div>
                <div class="mono-player-extra">${MONO_BOARD[pos]?.name?.replace('\n', ' ')} • ${ownedCount} props${inJail ? ' • 🔒 JAIL' : ''}${bankrupt ? ' • 💀 BANKRUPT' : ''}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      <!-- Current Square Info -->
      ${isMyTurn ? `
        <div class="mono-square-info">
          <strong>You're on:</strong> ${square?.name?.replace('\n',' ')}
          ${square?.price ? ` — $${square.price}` : ''}
          ${square?.type === 'property' || square?.type === 'railroad' || square?.type === 'utility' ? `
            <span class="square-badge" style="background:${square?.color || '#888'};color:${isColorDark(square?.color || '#888') ? 'white' : '#111'}">
              ${state.properties?.[myPos] ? (state.properties[myPos] === myId ? '✅ Yours' : `💸 Rent: $${square?.rent || 0}`) : '🔓 Unowned'}
            </span>
          ` : ''}
        </div>
        <div class="mono-actions">
          ${!state.rolled ? `<button class="mono-btn btn-roll" onclick="sendWS({type:'GAME_ACTION',action:'ROLL'})">🎲 Roll Dice</button>` : ''}
          ${canBuy ? `<button class="mono-btn btn-buy" onclick="sendWS({type:'GAME_ACTION',action:'BUY'})">🏠 Buy ${square?.name?.replace('\n',' ')} ($${square?.price})</button>` : ''}
          ${state.rolled ? `<button class="mono-btn btn-endturn" onclick="sendWS({type:'GAME_ACTION',action:'END_TURN'})">➡️ End Turn</button>` : ''}
        </div>
      ` : ''}

      <!-- Log -->
      <div class="mono-log">
        ${(state.log || []).slice(0, 8).map(l => `<div class="log-entry">📢 ${escHtml(l)}</div>`).join('')}
      </div>
    </div>
  `;
}

function renderMiniBoardHTML(state) {
  // Show a 10x10 grid of the board with player tokens
  const cells = [];
  for (let i = 0; i < 40; i++) {
    const sq = MONO_BOARD[i];
    const owner = state.properties?.[i];
    const ownerIdx = owner ? (state.players || []).indexOf(owner) : -1;
    const playersHere = (state.players || []).filter(pid => (state.positions?.[pid] || 0) === i);
    let bgColor = '#1a1a2e';
    if (sq?.type === 'property' && sq.color) bgColor = sq.color + '33';
    if (sq?.type === 'go') bgColor = '#003300';
    if (sq?.type === 'jail') bgColor = '#332200';
    if (sq?.type === 'gotojail') bgColor = '#330000';
    if (sq?.type === 'free') bgColor = '#003300';
    if (sq?.type === 'chance') bgColor = '#2a1a00';
    if (sq?.type === 'chest') bgColor = '#001a33';
    if (sq?.type === 'railroad') bgColor = '#111';
    if (sq?.type === 'tax') bgColor = '#1a0000';

    cells.push(`
      <div class="mini-cell" style="background:${bgColor}" title="${sq?.name?.replace('\n',' ') || ''}">
        <div class="mini-cell-name">${sq?.name?.split('\n')[0] || ''}</div>
        ${owner ? `<div class="mini-owner-dot" style="background:${PLAYER_COLORS_MONO[ownerIdx] || '#fff'}"></div>` : ''}
        ${playersHere.map((pid, ti) => {
          const pi = (state.players || []).indexOf(pid);
          return `<span class="mini-token" style="color:${PLAYER_COLORS_MONO[pi] || '#fff'}">${PLAYER_TOKENS[pi] || '●'}</span>`;
        }).join('')}
      </div>
    `);
  }
  return cells.join('');
}

function isColorDark(hex) {
  if (!hex || hex.length < 7) return true;
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return (r*0.299 + g*0.587 + b*0.114) < 128;
}

// Monopoly CSS
const monoCSS = document.createElement('style');
monoCSS.textContent = `
.mono-lobby, .mono-game { padding: 1rem; }
.btn-mono-start { background: linear-gradient(135deg, #4d1a99, #2d0a66) !important; box-shadow: 0 8px 24px rgba(77,26,153,0.4) !important; }
.mono-top-bar {
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  background: #0d0d2e; border: 1px solid #2d2d5a; border-radius: 10px; padding: 0.6rem 1rem; font-size: 0.85rem;
}
.mono-board-area { overflow-x: auto; }
.mono-mini-board {
  display: grid; grid-template-columns: repeat(10, 1fr);
  gap: 2px; min-width: 300px; background: #000; border-radius: 8px; padding: 3px;
}
.mini-cell {
  aspect-ratio: 1; border-radius: 3px; padding: 2px;
  position: relative; overflow: hidden; min-width: 28px;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  border: 1px solid rgba(255,255,255,0.05);
}
.mini-cell-name { font-size: 0.38rem; color: rgba(255,255,255,0.7); text-align: center; line-height: 1.1; }
.mini-owner-dot { width: 6px; height: 6px; border-radius: 50%; position: absolute; bottom: 2px; right: 2px; }
.mini-token { font-size: 0.7rem; line-height: 1; }

.mono-players-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.5rem; }
.mono-player-card {
  display: flex; gap: 0.6rem; align-items: flex-start;
  background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 0.6rem;
}
.mono-player-card.current { border-color: var(--accent2); background: rgba(255,217,61,0.08); }
.mono-player-card.bankrupt { opacity: 0.4; filter: grayscale(1); }
.mono-token { font-size: 1.5rem; }
.mono-player-name { font-weight: 800; font-size: 0.85rem; }
.mono-player-money { font-family: 'Bangers', cursive; font-size: 1.1rem; }
.mono-player-extra { font-size: 0.7rem; color: var(--text2); }

.mono-square-info {
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
  background: var(--card); border-radius: 10px; padding: 0.75rem 1rem;
  border: 1px solid var(--border); font-weight: 700;
}
.square-badge { padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.8rem; font-weight: 800; }

.mono-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.mono-btn {
  flex: 1; min-width: 100px; padding: 0.75rem 1rem;
  border: none; border-radius: 10px; color: white;
  font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem;
  cursor: pointer; transition: all 0.15s;
}
.btn-roll { background: linear-gradient(135deg, #4d1a99, #9933ff); }
.btn-buy { background: linear-gradient(135deg, #006600, #00aa00); }
.btn-endturn { background: linear-gradient(135deg, #333, #555); }
.mono-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }

.mono-log {
  background: var(--card); border-radius: 10px; padding: 0.75rem;
  border: 1px solid var(--border); max-height: 140px; overflow-y: auto;
}
.log-entry { font-size: 0.8rem; color: var(--text2); padding: 0.15rem 0; border-bottom: 1px solid var(--border); }
.log-entry:last-child { border: none; }
`;
document.head.appendChild(monoCSS);

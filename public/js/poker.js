/* ===== POKER ===== */

function renderPokerLobby(container) {
  if (roomState?.gameState?.phase) return;
  container.innerHTML = `
    <div class="poker-lobby">
      <div class="game-header-banner" style="background:linear-gradient(135deg,#0a3a0a,#1a5a1a)">
        <div class="game-title-big">♠️ Texas Hold'em Poker</div>
        <div class="game-subtitle">May the best hand win. Or the best bluffer.</div>
      </div>
      <div class="lobby-info">
        <div class="info-card">
          <h3>How to Play</h3>
          <p>Classic Texas Hold'em. Everyone starts with <strong>$1,000</strong>. Small blind: $10, Big blind: $20. Community cards are dealt after betting rounds. Best 5-card hand wins the pot!</p>
        </div>
        <div class="info-card">
          <h3>Players (${roomState?.players?.length || 1})</h3>
          ${roomState?.players?.map(p => `<div class="lobby-player">👤 ${escHtml(p.name)} - $1,000 ${p.isHost ? '👑' : ''}</div>`).join('') || ''}
        </div>
        ${isHost() ? `
          <button class="btn-start btn-poker-start" onclick="sendWS({type:'GAME_ACTION',action:'START_GAME'})">
            ♠️ Deal Cards!
          </button>
          ${(roomState?.players?.length||0) < 2 ? '<p class="warn-text">⚠️ Poker needs at least 2 players!</p>' : ''}
        ` : '<div class="waiting-host">Waiting for host to deal...</div>'}
      </div>
    </div>
  `;
}

function renderPoker(state) {
  const container = document.getElementById('game-container');
  if (!container) return;

  if (state.phase === 'showdown' || state.phase === 'waiting') {
    renderPokerShowdown(container, state);
    return;
  }

  const myHand = state.myHand || [];
  const isMyTurn = state.currentPlayer === myId;
  const myBet = state.bets?.[myId] || 0;
  const myChips = state.chips?.[myId] || 0;
  const toCall = Math.max(0, (state.currentBet || 0) - myBet);
  const isFolded = state.folded?.[myId];
  const currentPlayerName = roomState?.players?.find(p => p.id === state.currentPlayer)?.name || '?';
  const czarName = roomState?.players?.find(p => p.id === state.players?.[state.dealerIndex])?.name || '?';

  container.innerHTML = `
    <div class="poker-game">
      <div class="poker-info-bar">
        <span>🃏 ${state.phase?.toUpperCase()}</span>
        <span>💰 Pot: <strong>$${state.pot || 0}</strong></span>
        <span>🎯 Dealer: ${escHtml(czarName)}</span>
        ${isMyTurn && !isFolded ? '<span class="your-turn-badge">YOUR TURN!</span>' : ''}
      </div>

      <div class="community-area">
        <div class="community-label">Community Cards</div>
        <div class="community-cards">
          ${(state.community || []).map(c => renderCard(c)).join('')}
          ${Array.from({length: 5 - (state.community?.length || 0)}, () => '<div class="card card-back">🂠</div>').join('')}
        </div>
      </div>

      <div class="players-poker-grid">
        ${(state.players || []).map(pid => {
          const p = roomState?.players?.find(pl => pl.id === pid);
          const chips = state.chips?.[pid] || 0;
          const bet = state.bets?.[pid] || 0;
          const folded = state.folded?.[pid];
          const isCurrent = state.currentPlayer === pid;
          return `
            <div class="poker-player-seat ${folded ? 'folded' : ''} ${isCurrent ? 'current-turn' : ''}">
              <div class="seat-name">${escHtml(p?.name || '?')} ${pid === myId ? '(you)' : ''}</div>
              <div class="seat-chips">💵 $${chips}</div>
              <div class="seat-bet">${bet > 0 ? `Bet: $${bet}` : ''}</div>
              ${folded ? '<div class="folded-label">FOLDED</div>' : ''}
              ${pid === myId ? `<div class="my-cards-row">${myHand.map(c => renderCard(c)).join('')}</div>` : '<div class="hidden-cards">🂠🂠</div>'}
            </div>
          `;
        }).join('')}
      </div>

      ${isMyTurn && !isFolded ? `
        <div class="poker-actions">
          <button class="poker-btn btn-fold" onclick="sendWS({type:'GAME_ACTION',action:'FOLD'})">🚫 Fold</button>
          ${toCall === 0 ? `<button class="poker-btn btn-check" onclick="sendWS({type:'GAME_ACTION',action:'CHECK'})">✋ Check</button>` : ''}
          ${toCall > 0 ? `<button class="poker-btn btn-call" onclick="sendWS({type:'GAME_ACTION',action:'CALL'})">📲 Call $${toCall}</button>` : ''}
          ${myChips > toCall ? `<button class="poker-btn btn-raise" onclick="pokerRaise()">📈 Raise</button>` : ''}
        </div>
        <div class="raise-row hidden" id="raise-row">
          <input type="range" id="raise-slider" min="${state.blind*2}" max="${myChips - toCall}" step="${state.blind}" value="${state.blind*2}" oninput="document.getElementById('raise-amt').textContent='$'+this.value">
          <span>Raise: <strong id="raise-amt">$${state.blind*2}</strong></span>
          <button class="poker-btn btn-raise" onclick="confirmRaise()">Raise!</button>
        </div>
      ` : !isFolded ? `<div class="waiting-turn">Waiting for ${escHtml(currentPlayerName)}...</div>` : `<div class="waiting-turn">You folded. Better luck next hand!</div>`}
    </div>
  `;
}

function renderPokerShowdown(container, state) {
  const winnerPlayer = roomState?.players?.find(p => p.id === state.winner);
  container.innerHTML = `
    <div class="poker-game">
      <div class="showdown-banner">
        <div style="font-size:3rem">🏆</div>
        <h3>${escHtml(winnerPlayer?.name || '?')} wins the pot!</h3>
        <p>$${(state.pot || 0)} chips</p>
      </div>
      <div class="chips-summary">
        ${(state.players || []).map(pid => {
          const p = roomState?.players?.find(pl => pl.id === pid);
          return `<div class="chip-row"><span>${escHtml(p?.name || '?')}</span><span>$${state.chips?.[pid] || 0}</span></div>`;
        }).join('')}
      </div>
      ${isHost() ? `<button class="btn-start btn-poker-start" onclick="sendWS({type:'GAME_ACTION',action:'START_GAME'})">🔄 Next Hand</button>` : '<div class="waiting-host">Waiting for host to deal...</div>'}
    </div>
  `;
}

function renderCard(c) {
  if (!c) return '';
  const isRed = c.suit === '♥' || c.suit === '♦';
  return `<div class="card ${isRed ? 'red' : 'black'}">
    <div class="card-rank">${c.rank}</div>
    <div class="card-suit">${c.suit}</div>
  </div>`;
}

function pokerRaise() {
  document.getElementById('raise-row').classList.toggle('hidden');
}

function confirmRaise() {
  const amt = parseInt(document.getElementById('raise-slider').value);
  sendWS({ type: 'GAME_ACTION', action: 'RAISE', amount: amt });
}

// Poker Styles
const pokerCSS = document.createElement('style');
pokerCSS.textContent = `
.poker-lobby { padding: 1rem; }
.btn-poker-start {
  background: linear-gradient(135deg, #2d8a2d, #1a5a1a) !important;
  box-shadow: 0 8px 24px rgba(45,138,45,0.4) !important;
}
.poker-game { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.poker-info-bar {
  display: flex; align-items: center; gap: 1rem; flex-wrap: wrap;
  background: #0a200a; border: 1px solid #2d5a2d;
  border-radius: 10px; padding: 0.6rem 1rem; font-size: 0.85rem;
}
.your-turn-badge {
  background: var(--accent2); color: #111; font-weight: 900;
  padding: 0.2rem 0.75rem; border-radius: 20px; font-size: 0.8rem;
  animation: pulse 1s infinite;
}
@keyframes pulse { 0%,100%{transform:scale(1)} 50%{transform:scale(1.05)} }

.community-area { background: #0a2a0a; border-radius: 16px; padding: 1rem; border: 2px solid #1a4a1a; }
.community-label { font-size: 0.75rem; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #4a8a4a; margin-bottom: 0.75rem; }
.community-cards { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.card {
  width: 52px; height: 72px; background: white;
  border-radius: 8px; display: flex; flex-direction: column;
  align-items: center; justify-content: center;
  border: 2px solid #ddd; box-shadow: 0 4px 12px rgba(0,0,0,0.4);
  position: relative; font-weight: 900; gap: 2px;
}
.card.red { color: #cc0000; }
.card.black { color: #111; }
.card-back { background: linear-gradient(135deg, #1a1a8a, #111); color: #3a3aaa; font-size: 1.8rem; border: 2px solid #2a2aaa; }
.card-rank { font-size: 1rem; line-height: 1; }
.card-suit { font-size: 1.2rem; line-height: 1; }

.players-poker-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.75rem;
}
.poker-player-seat {
  background: var(--card); border: 2px solid var(--border);
  border-radius: 12px; padding: 0.75rem; text-align: center;
}
.poker-player-seat.current-turn { border-color: var(--accent2); background: rgba(255,217,61,0.08); }
.poker-player-seat.folded { opacity: 0.4; }
.seat-name { font-weight: 800; font-size: 0.9rem; margin-bottom: 0.25rem; }
.seat-chips { color: var(--accent3); font-size: 0.85rem; font-weight: 700; }
.seat-bet { color: var(--accent2); font-size: 0.75rem; min-height: 1rem; }
.folded-label { color: var(--accent); font-weight: 900; font-size: 0.75rem; }
.my-cards-row { display: flex; gap: 0.3rem; justify-content: center; margin-top: 0.5rem; }
.hidden-cards { font-size: 1.3rem; margin-top: 0.4rem; letter-spacing: 3px; }

.poker-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.poker-btn {
  flex: 1; min-width: 80px; padding: 0.75rem 0.5rem;
  border: none; border-radius: 10px; color: white;
  font-family: 'Nunito', sans-serif; font-weight: 800; font-size: 0.9rem;
  cursor: pointer; transition: all 0.15s;
}
.btn-fold { background: linear-gradient(135deg, #880000, #cc0000); }
.btn-check { background: linear-gradient(135deg, #006688, #0099cc); }
.btn-call { background: linear-gradient(135deg, #006600, #00aa00); }
.btn-raise { background: linear-gradient(135deg, #884400, #cc6600); }
.poker-btn:hover { filter: brightness(1.15); transform: translateY(-1px); }
.raise-row { display: flex; align-items: center; gap: 0.75rem; padding: 0.5rem; background: var(--card); border-radius: 10px; border: 1px solid var(--border); }
.raise-row input { flex: 1; accent-color: var(--accent2); }
.waiting-turn { text-align: center; color: var(--text2); padding: 1rem; font-style: italic; }

.showdown-banner {
  text-align: center; padding: 2rem; background: var(--card); border-radius: 16px; border: 2px solid var(--accent2);
}
.showdown-banner h3 { font-family: 'Bangers', cursive; font-size: 2rem; letter-spacing: 2px; color: var(--accent2); }
.chips-summary { display: flex; flex-direction: column; gap: 0.4rem; }
.chip-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.6rem 1rem; background: var(--card); border-radius: 8px; border: 1px solid var(--border);
}
`;
document.head.appendChild(pokerCSS);

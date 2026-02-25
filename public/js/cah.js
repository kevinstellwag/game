/* ===== CARDS AGAINST HUMANITY ===== */

function renderCAHLobby(container) {
  const hasState = roomState?.gameState;
  if (hasState) return; // Game already in progress, wait for GAME_STATE event

  container.innerHTML = `
    <div class="cah-lobby">
      <div class="game-header-banner" style="background:linear-gradient(135deg,#1a1a1a,#2d2d2d)">
        <div class="game-title-big">🃏 Cards Against Humanity</div>
        <div class="game-subtitle">For terrible people. Perfect for you.</div>
      </div>
      <div class="lobby-info">
        <div class="info-card">
          <h3>How to Play</h3>
          <p>One player is the <strong>Card Czar</strong>. They read a black card with a blank in it. Everyone else submits their funniest white card. The Czar picks the best answer. First to <strong>${roomState?.settings?.maxPoints || 7} points</strong> wins.</p>
        </div>
        <div class="info-card">
          <h3>Players (${roomState?.players?.length || 1})</h3>
          ${roomState?.players?.map(p => `<div class="lobby-player">👤 ${escHtml(p.name)} ${p.isHost ? '👑' : ''}</div>`).join('') || ''}
        </div>
        ${isHost() ? `
        <button class="btn-start" onclick="sendWS({type:'GAME_ACTION',action:'START_GAME'})">
          🚀 Start Game (${roomState?.players?.length || 1} player${(roomState?.players?.length||1)>1?'s':''})
        </button>
        ${(roomState?.players?.length||0) < 3 ? '<p class="warn-text">⚠️ CAH is best with 3+ players!</p>' : ''}
        ` : `<div class="waiting-host">Waiting for host to start...</div>`}
      </div>
    </div>
  `;
}

function renderCAH(state) {
  const container = document.getElementById('game-container');
  if (!container) return;

  // Update scores on players in room state
  if (state.scores && roomState?.players) {
    roomState.players.forEach(p => { p.score = state.scores[p.id] || 0; });
    updatePlayersTab();
  }

  if (state.phase === 'playing') renderCAHPlaying(container, state);
  else if (state.phase === 'judging') renderCAHJudging(container, state);
  else if (state.phase === 'scores') renderCAHScores(container, state);
}

function renderCAHPlaying(container, state) {
  const isCzar = state.czar === myId;
  const hasSubmitted = state.submissions && state.submissions[myId];
  const czarName = roomState?.players?.find(p => p.id === state.czar)?.name || 'Someone';

  container.innerHTML = `
    <div class="cah-game">
      <div class="cah-top-bar">
        <div class="round-info">Round ${state.round}</div>
        <div class="czar-info">🎩 Card Czar: <strong>${escHtml(czarName)}</strong></div>
        <div class="scoreboard-mini">
          ${Object.entries(state.scores || {}).map(([pid, score]) => {
            const p = roomState?.players?.find(pl => pl.id === pid);
            return `<span class="score-chip">${escHtml(p?.name || '?')}: ${score}</span>`;
          }).join('')}
        </div>
      </div>
      
      <div class="black-card-area">
        <div class="black-card">
          <div class="card-corner-tl">CAH</div>
          <div class="black-card-text">${escHtml(state.currentBlack || '')}</div>
          <div class="black-card-count">Pick 1</div>
        </div>
      </div>

      ${isCzar ? `
        <div class="czar-waiting">
          <div class="czar-crown">👑</div>
          <h3>You're the Card Czar!</h3>
          <p>Sit back and wait for everyone to submit their cards.<br>Then pick your favorite!</p>
          <div class="submission-counter">
            Waiting for ${Object.keys(state.submissions || {}).length}/${(roomState?.players?.length || 1) - 1} submissions...
          </div>
        </div>
      ` : hasSubmitted ? `
        <div class="submitted-msg">
          <div style="font-size:3rem">✅</div>
          <h3>Card submitted!</h3>
          <p>Your answer: <em>"${escHtml(state.submissions[myId] || '')}"</em></p>
          <p>Waiting for others...</p>
          <div class="submission-counter">
            ${Object.keys(state.submissions || {}).length}/${(roomState?.players?.length || 1) - 1} submitted
          </div>
        </div>
      ` : `
        <div class="hand-area">
          <div class="hand-label">Pick your best answer:</div>
          <div class="white-cards-hand">
            ${(state.myHand || []).map(card => `
              <div class="white-card" onclick="submitCAHCard(this, '${card.replace(/'/g,"\\'")}')">
                <div class="white-card-text">${escHtml(card)}</div>
                <div class="card-brand">🂠</div>
              </div>
            `).join('')}
          </div>
        </div>
      `}
    </div>
  `;
}

function renderCAHJudging(container, state) {
  const isCzar = state.czar === myId;
  const submissions = state.submissions || {};
  const cards = Object.values(submissions);
  // Shuffle to anonymize
  const shuffled = [...cards].sort(() => Math.random() - 0.5);

  container.innerHTML = `
    <div class="cah-game">
      <div class="black-card-area">
        <div class="black-card">
          <div class="black-card-text">${escHtml(state.currentBlack || '')}</div>
        </div>
      </div>
      
      ${isCzar ? `
        <div class="judging-area">
          <h3 class="judge-title">👑 Pick the funniest answer!</h3>
          <div class="judge-cards">
            ${shuffled.map(card => `
              <div class="white-card judge-card" onclick="pickWinner('${card.replace(/'/g,"\\'")}')">
                <div class="white-card-text">${escHtml(card)}</div>
                <div class="card-brand">🂠</div>
              </div>
            `).join('')}
          </div>
        </div>
      ` : `
        <div class="waiting-judge">
          <div style="font-size:3rem">🤔</div>
          <h3>All cards are in!</h3>
          <p>The Card Czar is judging...</p>
          <div class="judge-cards-preview">
            ${shuffled.map(card => `
              <div class="white-card judge-card-preview">
                <div class="white-card-text">${escHtml(card)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `}
    </div>
  `;
}

function renderCAHScores(container, state) {
  const winnerPlayer = roomState?.players?.find(p => p.id === state.lastWinner);
  const gameWinner = roomState?.players?.find(p => p.id === state.winner);
  const maxPts = roomState?.settings?.maxPoints || 7;

  container.innerHTML = `
    <div class="cah-game scores-screen">
      ${gameWinner ? `
        <div class="game-winner-banner">
          <div style="font-size:4rem">🏆</div>
          <h2>${escHtml(gameWinner.name)} WINS THE GAME!</h2>
          <p>With ${state.scores?.[gameWinner.id] || maxPts} points. What a legend.</p>
        </div>
      ` : `
        <div class="round-winner-banner">
          <div style="font-size:3rem">🎉</div>
          <h3>${escHtml(winnerPlayer?.name || '?')} wins this round!</h3>
          <p>With: <em>"${escHtml(state.lastWinningCard || '')}"</em></p>
        </div>
      `}
      
      <div class="scores-list">
        ${roomState?.players?.sort((a,b) => (state.scores?.[b.id]||0)-(state.scores?.[a.id]||0)).map(p => `
          <div class="score-row ${p.id === state.lastWinner ? 'winner-row' : ''}">
            <span class="score-name">${escHtml(p.name)}</span>
            <div class="score-bar-wrap">
              <div class="score-bar" style="width:${Math.min(100, ((state.scores?.[p.id]||0)/maxPts)*100)}%"></div>
            </div>
            <span class="score-pts">${state.scores?.[p.id]||0} / ${maxPts}</span>
          </div>
        `).join('')}
      </div>
      
      ${isHost() ? `
        <button class="btn-start" onclick="sendWS({type:'GAME_ACTION',action:'NEXT_ROUND'})">
          ${gameWinner ? '🔄 Play Again' : '➡️ Next Round'}
        </button>
      ` : '<div class="waiting-host">Waiting for host to continue...</div>'}
    </div>
  `;
}

function submitCAHCard(el, card) {
  document.querySelectorAll('.white-card').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  setTimeout(() => {
    sendWS({ type: 'GAME_ACTION', action: 'SUBMIT_CARD', card });
  }, 300);
}

function pickWinner(card) {
  sendWS({ type: 'GAME_ACTION', action: 'PICK_WINNER', card });
}

// ===== CAH STYLES =====
const cahCSS = document.createElement('style');
cahCSS.textContent = `
.cah-lobby { padding: 1rem; }
.game-header-banner {
  border-radius: 16px; padding: 2rem;
  text-align: center; margin-bottom: 1rem;
  border: 1px solid rgba(255,255,255,0.1);
}
.game-title-big {
  font-family: 'Bangers', cursive; font-size: 2.5rem;
  letter-spacing: 3px; color: white;
}
.game-subtitle { color: #999; font-style: italic; margin-top: 0.3rem; }
.lobby-info { display: flex; flex-direction: column; gap: 1rem; }
.info-card {
  background: var(--card); border-radius: 12px;
  padding: 1rem; border: 1px solid var(--border);
}
.info-card h3 { color: var(--accent2); font-family: 'Bangers', cursive; font-size: 1.3rem; letter-spacing: 2px; margin-bottom: 0.5rem; }
.info-card p { color: var(--text2); font-size: 0.9rem; line-height: 1.5; }
.lobby-player { padding: 0.3rem 0; color: var(--text); }
.btn-start {
  width: 100%; padding: 1rem; background: linear-gradient(135deg, #ff6b6b, #ee0979);
  border: none; border-radius: 12px; color: white;
  font-family: 'Bangers', cursive; font-size: 1.5rem; letter-spacing: 2px;
  cursor: pointer; transition: all 0.2s;
}
.btn-start:hover { transform: translateY(-2px); filter: brightness(1.1); box-shadow: 0 8px 24px rgba(255,107,107,0.5); }
.warn-text { color: var(--accent2); text-align: center; font-size: 0.85rem; }
.waiting-host { text-align: center; color: var(--text2); padding: 1rem; font-style: italic; }

/* CAH Game */
.cah-game { padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.cah-top-bar {
  display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap;
  background: var(--card); border-radius: 10px; padding: 0.6rem 1rem;
  border: 1px solid var(--border); font-size: 0.85rem;
}
.round-info { font-family: 'Bangers', cursive; font-size: 1.2rem; color: var(--accent2); }
.czar-info { color: var(--text2); }
.scoreboard-mini { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-left: auto; }
.score-chip {
  background: var(--card2); border-radius: 20px; padding: 0.2rem 0.6rem;
  font-size: 0.75rem; font-weight: 700; color: var(--text);
}

/* Black Card */
.black-card-area { display: flex; justify-content: center; }
.black-card {
  background: #000; color: white;
  border-radius: 12px; padding: 1.5rem;
  width: 100%; max-width: 400px; min-height: 120px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.6);
  position: relative; font-weight: 700;
  border: 2px solid rgba(255,255,255,0.1);
}
.card-corner-tl { position: absolute; top: 10px; left: 14px; font-size: 0.7rem; opacity: 0.5; font-family: 'Bangers', cursive; letter-spacing: 1px; }
.black-card-text { font-size: 1.2rem; line-height: 1.5; padding-top: 0.5rem; }
.black-card-count { position: absolute; bottom: 10px; right: 14px; font-size: 0.7rem; opacity: 0.5; }

/* White Cards */
.hand-area { }
.hand-label { font-weight: 800; color: var(--text2); text-transform: uppercase; letter-spacing: 1px; font-size: 0.8rem; margin-bottom: 0.75rem; }
.white-cards-hand {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 0.75rem;
}
.white-card {
  background: white; color: #111;
  border-radius: 10px; padding: 1rem;
  min-height: 100px; cursor: pointer;
  position: relative; font-weight: 700;
  transition: all 0.2s; border: 3px solid transparent;
  box-shadow: 0 4px 12px rgba(0,0,0,0.3);
}
.white-card:hover { transform: translateY(-4px) rotate(-1deg); box-shadow: 0 8px 24px rgba(0,0,0,0.4); border-color: #333; }
.white-card.selected { border-color: var(--accent4); transform: translateY(-6px) scale(1.03); }
.white-card-text { font-size: 0.9rem; line-height: 1.4; }
.card-brand { position: absolute; bottom: 8px; right: 10px; font-size: 0.8rem; opacity: 0.3; }

/* Czar Waiting */
.czar-waiting, .waiting-judge, .submitted-msg {
  text-align: center; padding: 2rem 1rem;
  background: var(--card); border-radius: 16px; border: 1px solid var(--border);
}
.czar-crown { font-size: 3rem; margin-bottom: 0.5rem; }
.czar-waiting h3, .waiting-judge h3, .submitted-msg h3 { font-family: 'Bangers', cursive; font-size: 1.8rem; letter-spacing: 2px; color: var(--accent2); }
.czar-waiting p, .waiting-judge p, .submitted-msg p { color: var(--text2); margin-top: 0.3rem; }
.submission-counter { margin-top: 1rem; font-weight: 800; color: var(--accent4); }

/* Judging */
.judging-area, .waiting-judge { }
.judge-title { font-family: 'Bangers', cursive; font-size: 1.8rem; letter-spacing: 2px; color: var(--accent2); text-align: center; }
.judge-cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 0.75rem; margin-top: 1rem; }
.judge-card:hover { transform: translateY(-6px) rotate(1deg); box-shadow: 0 12px 32px rgba(0,0,0,0.5); }
.judge-cards-preview { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0.5rem; margin-top: 1rem; }
.judge-card-preview { opacity: 0.7; pointer-events: none; min-height: 80px; }

/* Scores */
.scores-screen { }
.game-winner-banner, .round-winner-banner {
  text-align: center; padding: 2rem;
  background: linear-gradient(135deg, rgba(255,215,0,0.15), rgba(255,107,107,0.15));
  border-radius: 16px; border: 2px solid rgba(255,215,0,0.3);
}
.game-winner-banner h2, .round-winner-banner h3 {
  font-family: 'Bangers', cursive; letter-spacing: 3px;
  color: var(--accent2); font-size: 2rem;
}
.game-winner-banner p, .round-winner-banner p { color: var(--text2); margin-top: 0.5rem; }
.scores-list { display: flex; flex-direction: column; gap: 0.5rem; }
.score-row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.75rem; background: var(--card);
  border-radius: 10px; border: 1px solid var(--border);
}
.score-row.winner-row { border-color: var(--accent2); background: rgba(255,217,61,0.08); }
.score-name { width: 100px; font-weight: 800; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.score-bar-wrap { flex: 1; height: 10px; background: var(--bg); border-radius: 5px; overflow: hidden; }
.score-bar { height: 100%; background: linear-gradient(90deg, var(--accent4), var(--accent)); border-radius: 5px; transition: width 0.5s ease; }
.score-pts { width: 60px; text-align: right; font-family: 'Bangers', cursive; font-size: 1.1rem; color: var(--accent2); flex-shrink: 0; }
`;
document.head.appendChild(cahCSS);

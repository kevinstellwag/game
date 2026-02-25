// ===== CARDS AGAINST HUMANITY =====
const CAH = {
  render(state) {
    const area = document.getElementById('game-area');
    if (!area) return;

    if (state.phase === 'playing') CAH.renderPlaying(area, state);
    else if (state.phase === 'judging') CAH.renderJudging(area, state);
    else if (state.phase === 'scores') CAH.renderScores(area, state);
    else CAH.renderLobby(area);
  },

  renderLobby(area) {
    area.innerHTML = `
      <div class="game-banner" style="background:linear-gradient(135deg,#1a1a1a,#2d2d2d)">
        <div class="game-banner-title" style="color:white">🃏 Cards Against Humanity</div>
        <div class="game-banner-sub">Voor vreselijk slechte mensen. Zoals jij.</div>
      </div>
      <div class="info-box"><h3>Hoe speel je?</h3>
        <p>Één speler is de <strong>Kaart Tsaar</strong>. Die leest een zwarte kaart met een blanco. Iedereen submittet hun grappigste witte kaart. De Tsaar kiest de winnaar. Eerste naar <strong>${myRoomState?.settings?.maxPoints||7} punten</strong> wint.</p>
      </div>
      ${isHost() ? `
        <button class="btn-start-game" onclick="App.startGame()">🚀 Start! (${myRoomState?.players?.length||1} spelers)</button>
        ${(myRoomState?.players?.length||0)<3?'<p class="warn">⚠️ CAH is het leukst met 3+ spelers!</p>':''}
      ` : '<div class="waiting-txt">Wachten op host om te starten...</div>'}
    `;
  },

  renderPlaying(area, state) {
    const isCzar = state.czar === myId;
    const submitted = state.hasSubmitted;
    const submittedCount = state.submittedIds?.length || 0;
    const needed = (myRoomState?.players?.length || 1) - 1;

    area.innerHTML = `
      <div class="cah-topbar">
        <span class="cah-round">Ronde ${state.round}</span>
        <span class="cah-czar">🎩 Tsaar: <strong>${esc(state.czarName)}</strong></span>
        <div class="sc-chips">
          ${Object.entries(state.scores||{}).map(([pid, sc]) => {
            const p = myRoomState?.players?.find(pl=>pl.id===pid);
            return `<span class="sc-chip">${esc(p?.name||'?')}: ${sc}</span>`;
          }).join('')}
        </div>
      </div>
      <div class="black-card">
        <div class="black-card-corner">CAH</div>
        <div class="black-card-text">${esc(state.currentBlack||'')}</div>
        <div class="black-card-pick">Kies 1</div>
      </div>
      ${isCzar ? `
        <div class="czar-box">
          <div style="font-size:2.5rem">👑</div>
          <h3>Jij bent de Kaart Tsaar!</h3>
          <p>Wacht tot iedereen een kaart heeft ingestuurd. Dan kies jij de winnaar.</p>
          <div class="sub-counter">${submittedCount} / ${needed} ingestuurd...</div>
        </div>
      ` : submitted ? `
        <div class="submitted-box">
          <div style="font-size:2.5rem">✅</div>
          <h3>Kaart ingediend!</h3>
          <p>Jouw antwoord: <em>"${esc(state.mySubmission||'')}"</em></p>
          <div class="sub-counter">${submittedCount} / ${needed} ingestuurd...</div>
        </div>
      ` : `
        <div class="hand-label">Kies jouw beste antwoord:</div>
        <div class="white-cards-grid">
          ${(state.myHand||[]).map(card => `
            <div class="wcard" onclick="CAH.submit(this, '${esc(card).replace(/'/g,"\\'")}')">
              <div class="wcard-text">${esc(card)}</div>
              <div class="wcard-brand">🂠</div>
            </div>
          `).join('')}
        </div>
      `}
    `;
  },

  renderJudging(area, state) {
    const isCzar = state.czar === myId;
    const cards = Object.values(state.submissions || {});
    // Shuffle for anonymity
    const shuffled = [...cards].sort(() => Math.random() - 0.5);

    area.innerHTML = `
      <div class="cah-topbar">
        <span class="cah-round">Ronde ${state.round}</span>
        <span class="cah-czar">🎩 Tsaar: <strong>${esc(state.czarName)}</strong></span>
      </div>
      <div class="black-card">
        <div class="black-card-corner">CAH</div>
        <div class="black-card-text">${esc(state.currentBlack||'')}</div>
      </div>
      ${isCzar ? `
        <div class="judge-box">
          <h3>👑 Kies de grappigste kaart!</h3>
        </div>
        <div class="judge-grid">
          ${shuffled.map(card => `
            <div class="wcard judge-card" onclick="CAH.pickWinner('${esc(card).replace(/'/g,"\\'")}')">
              <div class="wcard-text">${esc(card)}</div>
              <div class="wcard-brand">🂠</div>
            </div>
          `).join('')}
        </div>
      ` : `
        <div class="czar-box">
          <div style="font-size:2.5rem">🤔</div>
          <h3>Alle kaarten zijn binnen!</h3>
          <p>De Kaart Tsaar kiest de winnaar...</p>
        </div>
        <div class="judge-grid">
          ${shuffled.map(card => `
            <div class="wcard" style="pointer-events:none;opacity:0.8">
              <div class="wcard-text">${esc(card)}</div>
              <div class="wcard-brand">🂠</div>
            </div>
          `).join('')}
        </div>
      `}
    `;
  },

  renderScores(area, state) {
    const maxPts = myRoomState?.settings?.maxPoints || 7;
    const winnerPlayer = myRoomState?.players?.find(p => p.id === state.winner);
    const lastWinnerPlayer = myRoomState?.players?.find(p => p.id === state.lastWinner);

    area.innerHTML = `
      ${state.winner ? `
        <div class="game-winner">
          <div style="font-size:3.5rem">🏆</div>
          <h2>${esc(winnerPlayer?.name||'?')} WINT HET SPEL!</h2>
          <p style="color:var(--text2);margin-top:0.4rem">Met ${state.scores?.[state.winner]||maxPts} punten. Wat een legend.</p>
        </div>
      ` : `
        <div class="round-winner">
          <div style="font-size:2.5rem">🎉</div>
          <h3>${esc(lastWinnerPlayer?.name||'?')} wint deze ronde!</h3>
          <p>"${esc(state.lastWinningCard||'')}"</p>
        </div>
      `}
      <div style="margin-bottom:0.75rem">
        ${(myRoomState?.players||[])
          .sort((a,b)=>(state.scores?.[b.id]||0)-(state.scores?.[a.id]||0))
          .map(p => `
            <div class="scores-row ${p.id===state.lastWinner?'winner':''}">
              <span class="sc-name">${esc(p.name)}</span>
              <div class="sc-bar-wrap"><div class="sc-bar" style="width:${Math.min(100,((state.scores?.[p.id]||0)/maxPts)*100)}%"></div></div>
              <span class="sc-pts">${state.scores?.[p.id]||0}/${maxPts}</span>
            </div>
          `).join('')}
      </div>
      ${isHost() ? `
        <button class="cah-next-btn" onclick="sendWS({type:'GAME_ACTION',action:'NEXT_ROUND'})">
          ${state.winner ? '🔄 Nieuw Spel' : '➡️ Volgende Ronde'}
        </button>
      ` : '<div class="waiting-txt">Wachten op host...</div>'}
    `;
  },

  submit(el, card) {
    document.querySelectorAll('.wcard').forEach(c => c.classList.remove('selected'));
    el.classList.add('selected');
    setTimeout(() => sendWS({ type: 'GAME_ACTION', action: 'SUBMIT_CARD', card }), 250);
  },

  pickWinner(card) {
    sendWS({ type: 'GAME_ACTION', action: 'PICK_WINNER', card });
  },
};

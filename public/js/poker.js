// ===== POKER =====
const Poker = {
  render(state) {
    const area = document.getElementById('game-area');
    if (!area) return;
    if (!state || !state.phase || state.phase === 'waiting') { Poker.renderLobby(area); return; }
    if (state.phase === 'showdown') { Poker.renderShowdown(area, state); return; }
    Poker.renderGame(area, state);
  },

  renderLobby(area) {
    area.innerHTML = `
      <div class="game-banner" style="background:linear-gradient(135deg,#0a3a0a,#1a5a1a)">
        <div class="game-banner-title" style="color:white">♠️ Texas Hold'em Poker</div>
        <div class="game-banner-sub">Bluf je vrienden arm. Letterlijk.</div>
      </div>
      <div class="info-box"><h3>Hoe speel je?</h3>
        <p>Texas Hold'em. Iedereen start met <strong>$1.000</strong>. Small blind $10, big blind $20. Community kaarten na elke betsronde. Beste 5-kaarten hand wint de pot!</p>
      </div>
      <div class="info-box"><h3>Spelers</h3>
        ${(myRoomState?.players||[]).map((p,i)=>`<div style="padding:0.3rem 0">${['🚂','🎩','👟','🐕','🚗','⛵'][i]||'👤'} ${esc(p.name)} — $1.000 ${p.isHost?'👑':''}</div>`).join('')}
      </div>
      ${isHost() ? `
        <button class="btn-start-game" style="background:linear-gradient(135deg,#2d8a2d,#1a5a1a)" onclick="App.startGame()">♠️ Deal Cards!</button>
        ${(myRoomState?.players?.length||0)<2?'<p class="warn">⚠️ Poker heeft minstens 2 spelers nodig!</p>':''}
      ` : '<div class="waiting-txt">Wachten op host om te dealen...</div>'}
    `;
  },

  renderGame(area, state) {
    const myHand = state.myHand?.[myId] || state.myHand || [];
    const isMyTurn = state.players?.[state.currentPlayerIndex] === myId;
    const isFolded = state.folded?.[myId];
    const myBet = state.bets?.[myId] || 0;
    const myChips = state.chips?.[myId] || 0;
    const toCall = Math.max(0, (state.currentBet||0) - myBet);
    const tokens = ['🚂','🎩','👟','🐕','🚗','⛵'];
    const dealerName = myRoomState?.players?.find(p=>p.id===state.players?.[state.dealerIndex])?.name||'?';

    area.innerHTML = `
      <div class="poker-info">
        <strong>${(state.phase||'').toUpperCase()}</strong>
        <span>💰 Pot: <strong>$${state.pot||0}</strong></span>
        <span>🎯 Dealer: ${esc(dealerName)}</span>
        ${isMyTurn&&!isFolded ? '<span class="your-turn-pill">JOUW BEURT!</span>' : ''}
      </div>

      <div class="community-box">
        <div class="community-label">Community Cards</div>
        <div class="cards-row">
          ${(state.community||[]).map(c=>Poker.card(c)).join('')}
          ${Array.from({length:5-(state.community?.length||0)},()=>'<div class="pcard pcard-back">🂠</div>').join('')}
        </div>
      </div>

      <div class="poker-seats">
        ${(state.players||[]).map((pid,i) => {
          const p = myRoomState?.players?.find(pl=>pl.id===pid);
          const chips = state.chips?.[pid]||0;
          const bet = state.bets?.[pid]||0;
          const folded = state.folded?.[pid];
          const isCurrent = state.players[state.currentPlayerIndex]===pid;
          const hand = pid===myId ? (Array.isArray(myHand)?myHand:[]) : null;
          return `
            <div class="seat ${folded?'folded':''} ${isCurrent?'active-turn':''}">
              <div class="seat-name">${tokens[i]||'👤'} ${esc(p?.name||'?')} ${pid===myId?'<span style="color:var(--accent4)">(jij)</span>':''}</div>
              <div class="seat-chips">$${chips}</div>
              <div class="seat-bet">${bet>0?`inzet: $${bet}`:''}</div>
              ${folded?'<div class="seat-fold-tag">GEPAST</div>':''}
              ${pid===myId&&hand ? `<div class="my-hole">${hand.map(c=>Poker.card(c)).join('')}</div>` : '<div class="hidden-cards">🂠🂠</div>'}
            </div>
          `;
        }).join('')}
      </div>

      ${isMyTurn && !isFolded ? `
        <div class="poker-actions">
          <button class="paction pa-fold" onclick="sendWS({type:'GAME_ACTION',action:'FOLD'})">🚫 Passen</button>
          ${toCall===0 ? `<button class="paction pa-check" onclick="sendWS({type:'GAME_ACTION',action:'CHECK'})">✋ Check</button>` : ''}
          ${toCall>0 ? `<button class="paction pa-call" onclick="sendWS({type:'GAME_ACTION',action:'CALL'})">📲 Callen $${toCall}</button>` : ''}
          ${myChips>toCall ? `<button class="paction pa-raise" onclick="Poker.showRaise(${toCall}, ${myChips}, ${state.blind||10})">📈 Raisen</button>` : ''}
        </div>
        <div class="raise-row hidden" id="raise-row">
          <span>Raise:</span>
          <input type="range" id="raise-slider" min="${(state.blind||10)*2}" max="${Math.max((state.blind||10)*2, myChips-toCall)}" step="${state.blind||10}" value="${(state.blind||10)*2}" oninput="document.getElementById('raise-amt').textContent='$'+this.value">
          <strong id="raise-amt">$${(state.blind||10)*2}</strong>
          <button class="paction pa-raise" onclick="Poker.confirmRaise()" style="flex:0;padding:0.5rem 0.9rem">Raise!</button>
        </div>
      ` : !isFolded ? `<div class="waiting-txt">Wachten op ${esc(state.currentPlayerName||'?')}...</div>` : `<div class="waiting-txt">Je hebt gepast. Volgende keer beter!</div>`}
    `;
  },

  renderShowdown(area, state) {
    const winnerPlayer = myRoomState?.players?.find(p=>p.id===state.winner);
    const tokens = ['🚂','🎩','👟','🐕','🚗','⛵'];
    area.innerHTML = `
      <div class="poker-showdown">
        <div style="font-size:3rem">🏆</div>
        <h3>${esc(winnerPlayer?.name||'?')} wint de pot!</h3>
        ${state.pot===0?`<p style="color:var(--text2)">Pot gewonnen</p>`:''}
      </div>
      <div class="chips-list">
        ${(state.players||[]).map((pid,i)=>{
          const p=myRoomState?.players?.find(pl=>pl.id===pid);
          return `<div class="chip-row"><span>${tokens[i]||'👤'} ${esc(p?.name||'?')}</span><span style="color:var(--accent3);font-weight:800">$${state.chips?.[pid]||0}</span></div>`;
        }).join('')}
      </div>
      ${isHost() ? `<button class="btn-start-game" style="background:linear-gradient(135deg,#2d8a2d,#1a5a1a)" onclick="sendWS({type:'GAME_ACTION',action:'NEXT_HAND'})">🔄 Volgende Hand</button>` : '<div class="waiting-txt">Wachten op host...</div>'}
    `;
  },

  card(c) {
    if (!c) return '';
    const red = c.s==='♥'||c.s==='♦';
    return `<div class="pcard ${red?'red':'black'}"><div class="pcard-r">${c.r}</div><div class="pcard-s">${c.s}</div></div>`;
  },

  showRaise(toCall, myChips, blind) {
    document.getElementById('raise-row')?.classList.toggle('hidden');
  },

  confirmRaise() {
    const amt = parseInt(document.getElementById('raise-slider')?.value || 0);
    sendWS({ type: 'GAME_ACTION', action: 'RAISE', amount: amt });
  },
};

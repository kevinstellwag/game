// ===== MONOPOLY =====
const BOARD = [
  {n:'GO',t:'go'},{n:'Mediterranean',t:'prop',c:'#8B4513',p:60,r:2},{n:'Community Chest',t:'chest'},
  {n:'Baltic',t:'prop',c:'#8B4513',p:60,r:4},{n:'Income Tax',t:'tax',a:200},
  {n:'Reading RR',t:'rr',p:200,r:25},{n:'Oriental',t:'prop',c:'#87CEEB',p:100,r:6},
  {n:'Chance',t:'chance'},{n:'Vermont',t:'prop',c:'#87CEEB',p:100,r:6},
  {n:'Connecticut',t:'prop',c:'#87CEEB',p:120,r:8},{n:'Jail',t:'jail'},
  {n:'St. Charles',t:'prop',c:'#FF69B4',p:140,r:10},{n:'Electric Co.',t:'util',p:150,r:0},
  {n:'States',t:'prop',c:'#FF69B4',p:140,r:10},{n:'Virginia',t:'prop',c:'#FF69B4',p:160,r:12},
  {n:'Pennsylvania RR',t:'rr',p:200,r:25},{n:'St. James',t:'prop',c:'#FFA500',p:180,r:14},
  {n:'Community Chest',t:'chest'},{n:'Tennessee',t:'prop',c:'#FFA500',p:180,r:14},
  {n:'New York',t:'prop',c:'#FFA500',p:200,r:16},{n:'Free Parking',t:'free'},
  {n:'Kentucky',t:'prop',c:'#e00',p:220,r:18},{n:'Chance',t:'chance'},
  {n:'Indiana',t:'prop',c:'#e00',p:220,r:18},{n:'Illinois',t:'prop',c:'#e00',p:240,r:20},
  {n:'B&O RR',t:'rr',p:200,r:25},{n:'Atlantic',t:'prop',c:'#FFD700',p:260,r:22},
  {n:'Ventnor',t:'prop',c:'#FFD700',p:260,r:22},{n:'Water Works',t:'util',p:150,r:0},
  {n:'Marvin Gardens',t:'prop',c:'#FFD700',p:280,r:24},{n:'Go To Jail',t:'gotojail'},
  {n:'Pacific',t:'prop',c:'#0a0',p:300,r:26},{n:'N. Carolina',t:'prop',c:'#0a0',p:300,r:26},
  {n:'Community Chest',t:'chest'},{n:'Pennsylvania',t:'prop',c:'#0a0',p:320,r:28},
  {n:'Short Line RR',t:'rr',p:200,r:25},{n:'Chance',t:'chance'},
  {n:'Park Place',t:'prop',c:'#4444ff',p:350,r:35},{n:'Luxury Tax',t:'tax',a:100},
  {n:'Boardwalk',t:'prop',c:'#4444ff',p:400,r:50}
];

const TOKENS = ['🚂','🎩','👟','🐕','🚗','⛵','🎲','🤑'];
const TCOLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#B4F8C8','#FBE7C6','#A0C4FF'];

const Mono = {
  render(state) {
    const area = document.getElementById('game-area');
    if (!area) return;
    if (!state) { Mono.renderLobby(area); return; }
    Mono.renderGame(area, state);
  },

  renderLobby(area) {
    area.innerHTML = `
      <div class="game-banner" style="background:linear-gradient(135deg,#1a0a2e,#2d1a5a)">
        <div class="game-banner-title" style="color:white">🏦 Monopoly</div>
        <div class="game-banner-sub">Vernietig je vriendschappen. Legaal.</div>
      </div>
      <div class="info-box"><h3>Hoe speel je?</h3>
        <p>Gooi dobbelstenen, beweeg over het bord, koop straten, vraag huur! Start met <strong>€1.500</strong>. Passeer GO → +€200. Maak je tegenstanders failliet!</p>
      </div>
      <div class="info-box"><h3>Spelers</h3>
        ${(myRoomState?.players||[]).map((p,i)=>`<div style="padding:0.3rem 0">${TOKENS[i]||'👤'} ${esc(p.name)} — €1.500 ${p.isHost?'👑':''}</div>`).join('')}
      </div>
      ${isHost() ? `
        <button class="btn-start-game" style="background:linear-gradient(135deg,#4d1a99,#2d0a66)" onclick="App.startGame()">🎲 Start Spel!</button>
        ${(myRoomState?.players?.length||0)<2?'<p class="warn">⚠️ Monopoly heeft minstens 2 spelers nodig!</p>':''}
      ` : '<div class="waiting-txt">Wachten op host om te starten...</div>'}
    `;
  },

  renderGame(area, state) {
    const isMyTurn = state.current === myId;
    const myPos = state.pos?.[myId] || 0;
    const myMoney = state.money?.[myId] || 0;
    const sq = BOARD[myPos];
    const canBuy = state.rolled && sq && (sq.t==='prop'||sq.t==='rr'||sq.t==='util')
      && !state.props?.[myPos] && myMoney >= (sq.p||9999);
    const currentName = myRoomState?.players?.find(p=>p.id===state.current)?.name||'?';

    area.innerHTML = `
      <div class="mono-topbar">
        ${state.dice ? `<span>🎲 ${state.dice[0]}+${state.dice[1]}=${state.dice[0]+state.dice[1]}</span>` : '<span>🎲 Geen worp</span>'}
        ${isMyTurn ? '<span class="your-turn-pill">JOUW BEURT!</span>' : `<span>⏳ ${esc(currentName)} is aan de beurt</span>`}
      </div>

      <div class="mono-board-wrap">
        <div class="mono-board">${Mono.renderBoard(state)}</div>
      </div>

      <div class="mono-seats">
        ${(state.players||[]).map((pid,i)=>{
          const p = myRoomState?.players?.find(pl=>pl.id===pid);
          const money = state.money?.[pid]||0;
          const pos = state.pos?.[pid]||0;
          const inJail = state.jail?.[pid];
          const bankrupt = state.bankrupt?.[pid];
          const isCurrent = state.current===pid;
          const owned = Object.values(state.props||{}).filter(o=>o===pid).length;
          return `
            <div class="mono-seat ${isCurrent?'current':''} ${bankrupt?'bankrupt':''}">
              <div class="m-token-lg">${TOKENS[i]||'👤'}</div>
              <div>
                <div class="m-name">${esc(p?.name||'?')} ${pid===myId?'<span style="color:var(--accent4)">(jij)</span>':''}</div>
                <div class="m-money" style="color:${money>0?'var(--accent3)':'var(--accent)'}">€${money}</div>
                <div class="m-sub">${BOARD[pos]?.n||'?'} • ${owned} strd${inJail?' • 🔒 Gevangenis':''}${bankrupt?' • 💀 FAILLIET':''}</div>
              </div>
            </div>
          `;
        }).join('')}
      </div>

      ${isMyTurn ? `
        <div class="mono-sq-info">
          <strong>Jij staat op:</strong> ${sq?.n||'?'}
          ${sq?.p?` — €${sq.p}`:''}
          ${(sq?.t==='prop'||sq?.t==='rr'||sq?.t==='util') ? `
            <span class="sq-badge" style="background:${sq?.c||'#555'};color:${Mono.darkBg(sq?.c)?'white':'#111'}">
              ${state.props?.[myPos] ? (state.props[myPos]===myId ? '✅ Van jou' : `💸 Huur: €${sq?.r||25}`) : '🔓 Te koop'}
            </span>
          ` : ''}
        </div>
        <div class="mono-actions">
          ${!state.rolled ? `<button class="maction ma-roll" onclick="sendWS({type:'GAME_ACTION',action:'ROLL'})">🎲 Gooi Dobbelstenen</button>` : ''}
          ${canBuy ? `<button class="maction ma-buy" onclick="sendWS({type:'GAME_ACTION',action:'BUY'})">🏠 Koop ${sq?.n} (€${sq?.p})</button>` : ''}
          ${state.rolled ? `<button class="maction ma-end" onclick="sendWS({type:'GAME_ACTION',action:'END_TURN'})">➡️ Beurt Beëindigen</button>` : ''}
        </div>
      ` : ''}

      <div class="mono-log">
        ${(state.log||[]).slice(0,10).map(l=>`<div class="log-line">📢 ${esc(l)}</div>`).join('')}
      </div>
    `;
  },

  renderBoard(state) {
    return BOARD.map((sq, i) => {
      const owner = state.props?.[i];
      const ownerIdx = owner ? (state.players||[]).indexOf(owner) : -1;
      const here = (state.players||[]).filter(pid=>(state.pos?.[pid]||0)===i);
      let bg = '#1a1a2e';
      if (sq.t==='prop'&&sq.c) bg = sq.c+'22';
      else if (sq.t==='go') bg = '#00330055';
      else if (sq.t==='jail') bg = '#33220055';
      else if (sq.t==='gotojail') bg = '#33000055';
      else if (sq.t==='free') bg = '#00220055';
      else if (sq.t==='chance') bg = '#2a1a0055';
      else if (sq.t==='chest') bg = '#001a3355';
      else if (sq.t==='rr') bg = '#11111155';
      else if (sq.t==='tax') bg = '#1a000055';
      return `
        <div class="mcell" style="background:${bg}" title="${sq.n}">
          <div class="mcell-name">${sq.n.split(' ')[0]}</div>
          ${owner&&ownerIdx>=0?`<div class="mcell-owner" style="background:${TCOLORS[ownerIdx]}"></div>`:''}
          <div class="mcell-tokens">
            ${here.map(pid=>{const pi=(state.players||[]).indexOf(pid);return `<span class="mtoken-sm">${TOKENS[pi]||'●'}</span>`;}).join('')}
          </div>
        </div>
      `;
    }).join('');
  },

  darkBg(hex) {
    if (!hex||hex.length<7) return true;
    const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
    return (r*0.299+g*0.587+b*0.114)<128;
  },
};

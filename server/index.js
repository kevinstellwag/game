const express = require('express');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const http = require('http');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());
app.get('/health', (req, res) => res.json({ ok: true, rooms: Object.keys(rooms).length }));

// Keep WebSocket connections alive (Railway/Render close idle connections after ~30s)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 20000);

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
    players: r.clients.map(c => ({ id: c.id, name: c.name, isHost: c.isHost, score: c.score || 0 })),
    settings: r.settings,
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

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    
    if (msg.type === 'PING') { send(ws, { type: 'PONG' }); return; }

    if (msg.type === 'CREATE_ROOM') {
      let code;
      do { code = genCode(); } while (rooms[code]);
      rooms[code] = { code, game: msg.game || 'cah', phase: 'lobby', clients: [], gameState: null, settings: { maxPoints: 7 }, chat: [] };
      room = rooms[code];
      const client = { id: clientId, ws, name: (msg.playerName || 'Host').slice(0, 20), isHost: true, score: 0 };
      room.clients.push(client);
      send(ws, { type: 'ROOM_JOINED', yourId: clientId, roomState: roomState(code) });
      return;
    }

    if (msg.type === 'JOIN_ROOM') {
      const code = (msg.code || '').toUpperCase().trim();
      if (!rooms[code]) { send(ws, { type: 'ERROR', message: 'Room niet gevonden!' }); return; }
      room = rooms[code];
      const client = { id: clientId, ws, name: (msg.playerName || 'Speler').slice(0, 20), isHost: false, score: 0 };
      room.clients.push(client);
      send(ws, { type: 'ROOM_JOINED', yourId: clientId, roomState: roomState(code) });
      send(ws, { type: 'CHAT_HISTORY', messages: room.chat.slice(-30) });
      bcast(code, { type: 'ROOM_UPDATE', roomState: roomState(code) }, clientId);
      bcast(code, { type: 'SYS', text: `${client.name} heeft de kamer betreden!` }, clientId);
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
      send(ws, { type: 'CHAT', message: m }); // also send back to sender
      return;
    }

    if (msg.type === 'SET_GAME') {
      const host = room.clients.find(c => c.id === clientId);
      if (!host?.isHost) return;
      room.game = msg.game; room.gameState = null; room.phase = 'lobby';
      // Reset scores when going back to lobby
      room.clients.forEach(c => { c.score = 0; });
      // Broadcast to ALL clients including host
      const update = { type: 'ROOM_UPDATE', roomState: roomState(room.code) };
      bcast(room.code, update);
      send(ws, update);
      return;
    }

    if (msg.type === 'UPDATE_SETTINGS') {
      const host = room.clients.find(c => c.id === clientId);
      if (!host?.isHost) return;
      room.settings = { ...room.settings, ...msg.settings };
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
  });

  ws.on('close', () => {
    if (!room) return;
    const idx = room.clients.findIndex(c => c.id === clientId);
    if (idx === -1) return;
    const leaving = room.clients[idx];
    room.clients.splice(idx, 1);
    if (room.clients.length === 0) { delete rooms[room.code]; return; }
    if (leaving.isHost) room.clients[0].isHost = true;
    bcast(room.code, { type: 'ROOM_UPDATE', roomState: roomState(room.code) });
    bcast(room.code, { type: 'SYS', text: `${leaving.name} heeft de kamer verlaten.` });
  });

  ws.on('error', () => {});
});

// ==================== CAH ====================
const BLACK = [
  "What's the next Happy Meal toy?","I got 99 problems but ___ ain't one.",
  "What ended my last relationship?","The new Pornhub category: ___.",
  "What's the most disappointing thing about turning 30?","What did I bring to the church potluck?",
  "My therapist says I have an unhealthy obsession with ___.",
  "Step 1: ___. Step 2: ___. Step 3: Profit.","I'm not racist, but ___.",
  "What's the real reason Santa is so jolly?","Before I die, I want to ___.",
  "The doctors say I only have 6 weeks to live because of ___.","Why do I drink?",
  "What am I thinking about during sex?","Breaking news: Man arrested for ___.",
  "I asked my AI for therapy and it responded with ___.",
  "My sex life is basically ___.","I got banned from the library for ___.",
  "What's wrong with millennials?","Scientists discovered ___% of people are addicted to ___.",
  "Introducing the new fragrance: ___.",
  "What am I not allowed to talk about at Christmas dinner?",
  "My OnlyFans is just me doing ___.","What did grandma leave me in her will?",
  "What's my safe word?","The children's book nobody asked for: ___ and ___.",
  "What's the worst thing to say at a funeral?","My tinder bio just says: ___.",
  "New Olympic sport: ___.", "What's in the mystery box?",
];

const WHITE = [
  "A disappointing birthday party","Pretending to care","Buying drugs on Craigslist",
  "Accidentally texting your boss a nude","Having a meltdown at IKEA",
  "Getting catfished by your own mom","A suspiciously enthusiastic divorce lawyer",
  "Explaining your OnlyFans to grandma","Unresolved childhood trauma",
  "Accidentally joining a cult","A Florida man","Texting your ex at 3am",
  "Forgetting which kid is yours","Burning the house down for the insurance money",
  "The void staring back","Emotional unavailability","A LinkedIn influencer",
  "Microwaving fish in the office","Saying 'per my last email' passive-aggressively",
  "An open casket with WiFi","Weaponized incompetence","Sentient furniture with depression",
  "Crying in the Wendy's parking lot","Speed-running a nervous breakdown","A haunted Roomba",
  "Blaming everything on Mercury retrograde","Three raccoons in a trenchcoat",
  "The contents of a divorced dad's fridge","Technically legal but morally wrong",
  "Doing a little crime","Accidentally starting a religion","A strongly worded letter to God",
  "Getting blocked by your dentist","An unsolicited pickle",
  "Your therapist's face when you said that","An emotional support mullet",
  "Waking up in a Denny's","Winning an argument on the internet",
  "A cheese board with no cheese","Dad's secret browser history",
  "A passive-aggressive sticky note","Making eye contact while eating a banana",
  "Crying but make it sexy","Accidentally liking a 3-year-old Instagram photo",
  "Jeffrey Bezos's second testicle","A motivational poster that says 'lol no'",
  "The entirety of Twitter/X","Your body pillow girlfriend",
  "A suspiciously moist handshake","Getting eaten by a roommate",
  "Lying on your resume about Excel skills","Naruto running into Area 51",
  "The forbidden nap at work","Forgetting a safeword",
  "A really long elevator ride with your ex","Finishing someone else's sentence incorrectly",
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
    winner:null, lastWinner:null, lastWinningCard:null,
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
    gs.lastWinner=winnerId; gs.lastWinningCard=msg.card; gs.phase='scores';
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

const MONO_BOARD = [
  // idx 0-9: bottom row, right to left (start bottom-right)
  {n:'START',          t:'go',      emoji:'💰', desc:'Passeer hier voor €400!'},
  {n:'Crack Steeg',    t:'prop',    emoji:'🏚️', c:'#7B3F00', p:80,  r:8,  desc:'1 kamer. Veel ratten.'},
  {n:'Kans',           t:'chance',  emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Jordaan Slop',   t:'prop',    emoji:'🏚️', c:'#7B3F00', p:100, r:12, desc:'Gezellig als je dronken bent.'},
  {n:'Energieheffing', t:'tax',     emoji:'⚡', a:150, desc:'Overheid wil geld.'},
  {n:'Tramlijn 9',     t:'rr',      emoji:'🚋', p:200, r:25, desc:'4 lijnen = rijkdom.'},
  {n:'AH Straat',      t:'prop',    emoji:'🛒', c:'#4fa8c5', p:120, r:14, desc:'Bonusbroodjes inbegrepen.'},
  {n:'Kans',           t:'chance',  emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Wallen Wijk',    t:'prop',    emoji:'🪟', c:'#4fa8c5', p:140, r:16, desc:'Toeristen graag.'},
  {n:'Coffeeshop Corner', t:'prop', emoji:'☕', c:'#4fa8c5', p:160, r:20, desc:'Hoge huur, hoge bewoners.'},
  // idx 10-19: left column, bottom to top
  {n:'Gevangenis',     t:'jail',    emoji:'🔒', desc:'Gewoon op bezoek... toch?'},
  {n:'Kattenburgh',    t:'prop',    emoji:'🐱', c:'#e75480', p:180, r:22, desc:'Meer katten dan mensen.'},
  {n:'Waterleiding',   t:'util',    emoji:'💧', p:150, r:0,  desc:'Huur = dobbelsteen × €10.'},
  {n:'Kinkerstraat',   t:'prop',    emoji:'🛵', c:'#e75480', p:200, r:26, desc:'Scooters overal.'},
  {n:'De Pijp',        t:'prop',    emoji:'🥐', c:'#e75480', p:220, r:30, desc:'Avocadotoast €14.'},
  {n:'Metrolijn',      t:'rr',      emoji:'🚇', p:200, r:25, desc:'4 lijnen = rijkdom.'},
  {n:'NDSM Loods',     t:'prop',    emoji:'🏭', c:'#f4a460', p:240, r:34, desc:'Hipsters inbegrepen.'},
  {n:'Post',           t:'chest',   emoji:'📬', desc:'Burenruzie post.'},
  {n:'Zuidas Tower',   t:'prop',    emoji:'🏢', c:'#f4a460', p:260, r:38, desc:'Pakken en BMW's.'},
  {n:'Vondelpark',     t:'prop',    emoji:'🌳', c:'#f4a460', p:280, r:42, desc:'Joggers én junkies.'},
  // idx 20-29: top row, left to right
  {n:'Gratis Parkeren',t:'free',    emoji:'🚗', desc:'Niets! Geniet ervan.'},
  {n:'Herengracht',    t:'prop',    emoji:'🏰', c:'#cc2200', p:300, r:48, desc:'Grachtenpand. Steil.'},
  {n:'Kans',           t:'chance',  emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Keizersgracht',  t:'prop',    emoji:'🏰', c:'#cc2200', p:320, r:54, desc:'Nog steiler.'},
  {n:'Prinsengracht',  t:'prop',    emoji:'🏰', c:'#cc2200', p:340, r:60, desc:'Anne Frank was hier.'},
  {n:'Buslijn',        t:'rr',      emoji:'🚌', p:200, r:25, desc:'4 lijnen = rijkdom.'},
  {n:'Museumplein',    t:'prop',    emoji:'🎨', c:'#ccbb00', p:360, r:68, desc:'Toeristen betalen goed.'},
  {n:'Luxebelasting',  t:'tax',     emoji:'💸', a:200, desc:'Voor de rijken. Dat ben jij.'},
  {n:'Oud-Zuid Laan',  t:'prop',    emoji:'🏡', c:'#ccbb00', p:380, r:76, desc:'Bomen, stilte, geld.'},
  {n:'Ga Naar Bak',    t:'gotojail',emoji:'👮', desc:'Geen €400. Direct naar bak.'},
  // idx 30-39: right column, top to bottom
  {n:'Apollolaan',     t:'prop',    emoji:'🌴', c:'#228b22', p:400, r:86, desc:'Celebrities en villa's.'},
  {n:'Post',           t:'chest',   emoji:'📬', desc:'Burenruzie post.'},
  {n:'Buitenveldert',  t:'prop',    emoji:'🏘️', c:'#228b22', p:420, r:94, desc:'Rustig. Te rustig.'},
  {n:'Kans',           t:'chance',  emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Amstelveen Mega',t:'prop',    emoji:'🏗️', c:'#228b22', p:440, r:100, desc:'Mega-pand staat er al.'},
  {n:'Snelweg',        t:'rr',      emoji:'🚐', p:200, r:25, desc:'4 lijnen = rijkdom.'},
  {n:'Kans',           t:'chance',  emoji:'🎲', desc:'Druk op je geluk.'},
  {n:'Leidseplein Ph', t:'prop',    emoji:'🌟', c:'#3333cc', p:480, r:120, desc:'Uitzicht over de stad.'},
  {n:'Heffing',        t:'tax',     emoji:'🏛️', a:100, desc:'Belasting. Omdat.'},
  {n:'Rembrandtplein', t:'prop',    emoji:'👑', c:'#3333cc', p:500, r:150, desc:'Het duurste. Ouch.'},
];

const MONO_LEVEL_NAMES = ['Kaal','Kraakpand','Rijtjeshuis','Appartement','Villa','Mansion'];
const MONO_LEVEL_EMOJI = ['🏚️','🏠','🏡','🏢','🏰','👑'];

// Upgrade cost = 60% of purchase price
function monoUpgradeCost(sq) { return Math.floor((sq.p||100) * 0.6); }

// Rent based on level
function monoCalcRent(sqIdx, gs) {
  const sq = MONO_BOARD[sqIdx];
  const prop = gs.props[sqIdx];
  if (!prop) return 0;
  if (sq.t === 'rr') {
    const owner = prop.ownerId;
    const count = Object.entries(gs.props).filter(([i,p]) => MONO_BOARD[i].t==='rr' && p.ownerId===owner).length;
    return 25 * count;
  }
  if (sq.t === 'util') {
    return (gs.lastDiceSum||7) * 10;
  }
  const mults = [1, 2, 3.5, 6, 10, 16];
  return Math.round((sq.r||10) * (mults[prop.level]||1));
}

const MONO_CHANCE = [
  {txt:'Je wint een weddenschap! 🎉', eff:{t:'money', v:200}},
  {txt:'Belastingteruggave! 💵', eff:{t:'money', v:150}},
  {txt:'Oom Henk is dood. Je erft €300 🪦', eff:{t:'money', v:300}},
  {txt:'Parkeerboete. -€100 🚔', eff:{t:'money', v:-100}},
  {txt:'Ziekenhuisrekening. -€200 🏥', eff:{t:'money', v:-200}},
  {txt:'Loterij! +€500 🎰', eff:{t:'money', v:500}},
  {txt:'Terug naar START. Pak €400! 💰', eff:{t:'goto', pos:0, bonus:400}},
  {txt:'Rechtstreeks naar de gevangenis 🔒', eff:{t:'jail'}},
  {txt:'Vrijlatingspas! Bewaar voor later 🗝️', eff:{t:'freepass'}},
  {txt:'Iedereen geeft jou €50! 🤑', eff:{t:'collect', v:50}},
  {txt:'Je trakteert iedereen. -€40 per persoon 🍺', eff:{t:'payall', v:40}},
  {txt:'Reparaties! -€40 per pand dat je hebt 🔧', eff:{t:'perprop', v:40}},
];

const MONO_CHEST = [
  {txt:'Rekening van de verhuurder. -€150 📄', eff:{t:'money', v:-150}},
  {txt:'Buren klagen. -€75 😤', eff:{t:'money', v:-75}},
  {txt:'Je verkoopt je Vespa. +€120 🛵', eff:{t:'money', v:120}},
  {txt:'Bonus van de baas! +€250 💼', eff:{t:'money', v:250}},
  {txt:'Gewoon de bak in. Nu. 🔒', eff:{t:'jail'}},
  {txt:'Buren betalen jou elk €30 🏘️', eff:{t:'collect', v:30}},
  {txt:'Gemeentesubsidie! +€100 🏛️', eff:{t:'money', v:100}},
  {txt:'Waterleiding gesprongen. -€180 💧', eff:{t:'money', v:-180}},
  {txt:'Gewonnen bij de rechtbank! +€200 ⚖️', eff:{t:'money', v:200}},
];

const MONO_SPIN = [
  {txt:'🎉 VRIJUIT! Agent had zijn donut.', type:'free',  prob:0.28},
  {txt:'💸 Boete €75. Betaal de agent.', type:'fine',  v:75,  prob:0.22},
  {txt:'💸 Boete €150. Pech!', type:'fine',  v:150, prob:0.18},
  {txt:'💸 Boete €300. Zware dag.', type:'fine',  v:300, prob:0.10},
  {txt:'🔒 GEARRESTEERD! Naar de gevangenis!', type:'jail', prob:0.12},
  {txt:'🏃 ACHTERVOLGING! 3 stappen terug.', type:'chase',prob:0.10},
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
    money:     Object.fromEntries(allPlayers.map(p=>[p,0])), // cop has no money
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
  gs.log.unshift(`${nextName} is aan de beurt.`);
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

  // If we wrapped around (new round), cop goes first
  if (ni <= curRealIdx && curRealIdx !== -1) {
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
  gs.log.unshift(`${nextName} is aan de beurt.`);
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
        gs.money[clientId] = (gs.money[clientId]||0) - 150;
        gs.log.unshift(`${name} betaalt €150 borgtocht en is vrij.`);
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
      gs.money[clientId] = (gs.money[clientId]||0) + 400;
      gs.log.unshift(`${name} passeert START! +€400 💰`);
    }

    const sq = MONO_BOARD[newPos];
    gs.log.unshift(`${name} gooit ${d1}+${d2} → ${sq.emoji} ${sq.n}`);

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
      gs.log.unshift(`${name} koopt ${sq.emoji} ${sq.n} voor €${sq.p}!`);
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

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

// ==================== MONOPOLY ====================
const BOARD=[
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

function monoBroadcast(room) {
  bcast(room.code, { type:'GAME_STATE', game:'monopoly', roomState:roomState(room.code), state:room.gameState });
  const host = room.clients.find(c=>c.isHost);
  if (host) send(host.ws, { type:'GAME_STATE', game:'monopoly', roomState:roomState(room.code), state:room.gameState });
}

function startMonopoly(room) {
  const players=room.clients.map(c=>c.id);
  room.gameState={
    players,
    pos:Object.fromEntries(players.map(p=>[p,0])),
    money:Object.fromEntries(players.map(p=>[p,1500])),
    jail:Object.fromEntries(players.map(p=>[p,false])),
    props:{}, bankrupt:{},
    currentIdx:0, current:players[0],
    dice:null, rolled:false,
    log:['Spel gestart! Gooi de dobbelstenen.'],
  };
  room.phase='ingame';
  monoBroadcast(room);
}

function handleMonopoly(room, clientId, ws, msg) {
  const client=room.clients.find(c=>c.id===clientId);
  if (msg.action==='START_GAME') { if(client?.isHost) startMonopoly(room); return; }
  const gs=room.gameState; if(!gs) return;
  if (gs.current!==clientId) return;
  const name=client?.name||'?';
  if (msg.action==='ROLL'&&!gs.rolled) {
    const d1=Math.ceil(Math.random()*6), d2=Math.ceil(Math.random()*6);
    gs.dice=[d1,d2]; gs.rolled=true;
    if (gs.jail[clientId]) {
      if(d1===d2){gs.jail[clientId]=false;gs.log.unshift(`${name} gooide dubbel, vrij!`);}
      else{gs.log.unshift(`${name} zit nog in de gevangenis.`);monoBroadcast(room);return;}
    }
    const old=gs.pos[clientId]; gs.pos[clientId]=(old+d1+d2)%40;
    if(gs.pos[clientId]<old){gs.money[clientId]+=200;gs.log.unshift(`${name} passeert GO, +€200!`);}
    const sq=BOARD[gs.pos[clientId]];
    gs.log.unshift(`${name} gooit ${d1}+${d2}=${d1+d2} → ${sq.n}`);
    if(sq.t==='gotojail'){gs.pos[clientId]=10;gs.jail[clientId]=true;gs.log.unshift(`${name} gaat naar gevangenis!`);}
    else if(sq.t==='tax'){gs.money[clientId]-=sq.a;gs.log.unshift(`${name} betaalt €${sq.a} belasting.`);}
    else if((sq.t==='prop'||sq.t==='rr'||sq.t==='util')&&gs.props[gs.pos[clientId]]&&gs.props[gs.pos[clientId]]!==clientId){
      const owner=gs.props[gs.pos[clientId]], rent=sq.r||25;
      gs.money[clientId]-=rent; gs.money[owner]+=rent;
      gs.log.unshift(`${name} betaalt €${rent} aan ${room.clients.find(c=>c.id===owner)?.name||'?'}.`);
    }
    if(gs.money[clientId]<=0){gs.bankrupt[clientId]=true;gs.money[clientId]=0;gs.log.unshift(`${name} is FAILLIET!`);}
    monoBroadcast(room);
  }
  else if(msg.action==='BUY'){
    const sq=BOARD[gs.pos[clientId]];
    if(!gs.rolled||gs.props[gs.pos[clientId]]||gs.money[clientId]<(sq.p||9999)) return;
    gs.money[clientId]-=sq.p; gs.props[gs.pos[clientId]]=clientId;
    gs.log.unshift(`${name} koopt ${sq.n} voor €${sq.p}!`);
    monoBroadcast(room);
  }
  else if(msg.action==='END_TURN'){
    gs.rolled=false; gs.dice=null;
    let ni=(gs.currentIdx+1)%gs.players.length, s=0;
    while(gs.bankrupt[gs.players[ni]]&&s++<gs.players.length) ni=(ni+1)%gs.players.length;
    gs.currentIdx=ni; gs.current=gs.players[ni];
    gs.log.unshift(`${room.clients.find(c=>c.id===gs.current)?.name||'?'} is aan de beurt.`);
    monoBroadcast(room);
  }
}

// ==================== START ====================
const PORT=process.env.PORT||3000;
server.listen(PORT,'0.0.0.0',()=>console.log(`🎮 PartyGames running on port ${PORT}`));

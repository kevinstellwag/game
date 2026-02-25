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

// In-memory rooms storage
const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function broadcast(roomCode, data, excludeWs = null) {
  const room = rooms[roomCode];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client !== excludeWs && client.ws && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  });
}

function broadcastAll(roomCode, data) {
  broadcast(roomCode, data);
  // Also send to excluded (send to all)
  const room = rooms[roomCode];
  if (!room) return;
  const msg = JSON.stringify(data);
  room.clients.forEach(client => {
    if (client.ws && client.ws.readyState === 1) {
      client.ws.send(msg);
    }
  });
}

function getRoomState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return null;
  return {
    code: roomCode,
    game: room.game,
    players: room.clients.map(c => ({ id: c.id, name: c.name, isHost: c.isHost, score: c.score || 0 })),
    gameState: room.gameState,
    settings: room.settings,
    chat: room.chat.slice(-50)
  };
}

wss.on('connection', (ws) => {
  let clientId = uuidv4();
  let currentRoom = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'CREATE_ROOM': {
        let code;
        do { code = generateRoomCode(); } while (rooms[code]);
        rooms[code] = {
          code,
          game: msg.game || 'lobby',
          clients: [],
          gameState: null,
          settings: { maxPoints: 7, ...msg.settings },
          chat: []
        };
        currentRoom = code;
        const client = { id: clientId, ws, name: msg.playerName || 'Host', isHost: true, score: 0 };
        rooms[code].clients.push(client);
        ws.send(JSON.stringify({ type: 'ROOM_JOINED', roomState: getRoomState(code), yourId: clientId }));
        break;
      }

      case 'JOIN_ROOM': {
        const code = msg.code?.toUpperCase();
        if (!rooms[code]) {
          ws.send(JSON.stringify({ type: 'ERROR', message: 'Room not found! Check the code.' }));
          return;
        }
        currentRoom = code;
        const client = { id: clientId, ws, name: msg.playerName || 'Player', isHost: false, score: 0 };
        rooms[code].clients.push(client);
        const state = getRoomState(code);
        ws.send(JSON.stringify({ type: 'ROOM_JOINED', roomState: state, yourId: clientId }));
        broadcast(code, { type: 'PLAYER_JOINED', player: { id: clientId, name: client.name }, roomState: state }, ws);
        broadcastAll(code, { type: 'ROOM_UPDATE', roomState: state });
        break;
      }

      case 'CHAT': {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const sender = room.clients.find(c => c.id === clientId);
        const chatMsg = { id: uuidv4(), playerId: clientId, playerName: sender?.name || 'Unknown', text: msg.text, time: Date.now() };
        room.chat.push(chatMsg);
        if (room.chat.length > 200) room.chat.shift();
        broadcastAll(currentRoom, { type: 'CHAT', message: chatMsg });
        break;
      }

      case 'GAME_ACTION': {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        handleGameAction(room, clientId, msg, ws);
        break;
      }

      case 'SET_GAME': {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const host = room.clients.find(c => c.id === clientId);
        if (!host?.isHost) return;
        room.game = msg.game;
        room.gameState = null;
        broadcastAll(currentRoom, { type: 'ROOM_UPDATE', roomState: getRoomState(currentRoom) });
        break;
      }

      case 'UPDATE_SETTINGS': {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        const host = room.clients.find(c => c.id === clientId);
        if (!host?.isHost) return;
        room.settings = { ...room.settings, ...msg.settings };
        broadcastAll(currentRoom, { type: 'ROOM_UPDATE', roomState: getRoomState(currentRoom) });
        break;
      }
    }
  });

  ws.on('close', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const idx = room.clients.findIndex(c => c.id === clientId);
    if (idx === -1) return;
    const leaving = room.clients[idx];
    room.clients.splice(idx, 1);
    if (room.clients.length === 0) {
      delete rooms[currentRoom];
      return;
    }
    if (leaving.isHost && room.clients.length > 0) {
      room.clients[0].isHost = true;
    }
    broadcastAll(currentRoom, { type: 'ROOM_UPDATE', roomState: getRoomState(currentRoom) });
    broadcastAll(currentRoom, { type: 'CHAT', message: { id: uuidv4(), playerName: 'System', text: `${leaving.name} left the game.`, time: Date.now(), system: true } });
  });
});

// ==================== GAME LOGIC ====================

const DEFAULT_BLACK_CARDS = [
  "What's the next Happy Meal toy?",
  "I got 99 problems but ___ ain't one.",
  "What ended my last relationship?",
  "The new Pornhub category: ___.",
  "What's the most disappointing thing about turning 30?",
  "What did I bring to the church potluck?",
  "What's that smell?",
  "What do old people smell like?",
  "My therapist says I have an unhealthy obsession with ___.",
  "Step 1: ___. Step 2: ___. Step 3: Profit.",
  "I'm not racist, but ___.",
  "What's the real reason Santa is so jolly?",
  "What's the new item on the McDonald's dollar menu?",
  "Before I die, I want to ___.",
  "What's my dad's excuse for missing my birthday again?",
  "The doctors say I only have 6 weeks to live because of ___.",
  "Why do I drink?",
  "What's the gift that keeps on giving?",
  "Scientists have discovered that ___% of Americans are secretly addicted to ___.",
  "What am I thinking about during sex?",
  "In 1000 years, historians will remember the 21st century for ___.",
  "Breaking news: Man arrested for ___.",
  "I asked ChatGPT for therapy and it responded with ___.",
  "What's actually in a hot dog?",
  "My sex life is basically ___.",
  "I got banned from the library for ___.",
  "What's in the mystery box?",
  "My New Year's resolution is to stop ___.",
  "What's wrong with millennials?",
  "Introducing the new fragrance: ___."
];

const DEFAULT_WHITE_CARDS = [
  "A disappointing birthday party", "Pretending to care", "Buying drugs on Craigslist",
  "Accidentally texting your boss a nude", "Having a meltdown at IKEA", "Blaming your farts on the dog",
  "Getting catfished by your own mom", "A suspiciously enthusiastic divorce lawyer",
  "Explaining your OnlyFans to grandma", "Eating the whole thing", "Unresolved childhood trauma",
  "Accidentally joining a cult", "A Florida man", "Naruto running into Area 51",
  "Texting your ex at 3am", "Forgetting which kid is yours", "Your body pillow girlfriend",
  "Burning the house down for the insurance money", "A disappointing amount of cheese",
  "The concept of Mondays", "Swipe left on life", "Doing your taxes while crying",
  "The void staring back", "Emotional unavailability", "A LinkedIn influencer",
  "Microwaving fish in the office", "Saying 'per my last email' passive-aggressively",
  "Lying on your resume about Excel skills", "An open casket with WiFi",
  "Putting your grandma on eBay", "Weaponized incompetence",
  "Aggressively normal people", "Sentient furniture with depression",
  "A really stupid hat", "The entirety of Twitter/X", "Crying in the Wendy's parking lot",
  "Getting blocked by your dentist", "Speed-running a nervous breakdown",
  "Screaming into a pillow", "A haunted Roomba",
  "An unsolicited pickle", "Jeffrey Bezos's second testicle",
  "A motivational poster that says 'lol no'", "Blaming everything on Mercury retrograde",
  "Losing a staring contest with a dog", "A suspiciously moist handshake",
  "Getting eaten by a roommate", "Three raccoons in a trenchcoat",
  "Surprise therapy", "The contents of a divorced dad's fridge",
  "Technically legal but morally wrong", "A very confused grandparent",
  "Doing a little crime", "Finishing someone else's sentence incorrectly",
  "The last slice nobody takes", "Emotionally manipulating a toaster",
  "The forbidden spreadsheet", "Reading terms & conditions",
  "Accidentally starting a religion", "A strongly worded letter to God"
];

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function handleGameAction(room, clientId, msg, ws) {
  if (room.game === 'cah') handleCAHAction(room, clientId, msg, ws);
  if (room.game === 'poker') handlePokerAction(room, clientId, msg, ws);
  if (room.game === 'monopoly') handleMonopolyAction(room, clientId, msg, ws);
}

// ---- CARDS AGAINST HUMANITY ----

function startCAH(room) {
  const blackCards = shuffle([...(room.settings.customBlackCards || []), ...DEFAULT_BLACK_CARDS]);
  const whiteCards = shuffle([...(room.settings.customWhiteCards || []), ...DEFAULT_WHITE_CARDS]);
  const players = room.clients.map(c => c.id);
  const hands = {};
  let wi = 0;
  players.forEach(pid => {
    hands[pid] = whiteCards.slice(wi, wi + 7);
    wi += 7;
  });
  room.gameState = {
    phase: 'playing', // playing | judging | scores
    round: 1,
    czarIndex: 0,
    czar: players[0],
    currentBlack: blackCards[0],
    blackDeck: blackCards.slice(1),
    whiteDeck: whiteCards.slice(wi),
    hands,
    submissions: {},
    scores: Object.fromEntries(players.map(p => [p, 0])),
    winner: null,
    lastWinner: null,
    lastWinningCard: null
  };
  broadcastCAHState(room);
}

function broadcastCAHState(room) {
  const gs = room.gameState;
  const roomState = getRoomState(room.code);
  // Send personalized state to each player (hide others' hands)
  room.clients.forEach(client => {
    if (client.ws.readyState !== 1) return;
    const personalState = {
      ...gs,
      myHand: gs.hands[client.id] || [],
      allHands: undefined,
      hands: undefined // don't leak hands
    };
    client.ws.send(JSON.stringify({ type: 'GAME_STATE', game: 'cah', state: personalState, roomState }));
  });
}

function handleCAHAction(room, clientId, msg, ws) {
  const gs = room.gameState;
  const client = room.clients.find(c => c.id === clientId);

  if (msg.action === 'START_GAME') {
    if (!client?.isHost) return;
    startCAH(room);
    return;
  }

  if (!gs) return;

  if (msg.action === 'SUBMIT_CARD') {
    if (gs.phase !== 'playing') return;
    if (clientId === gs.czar) return;
    if (gs.submissions[clientId]) return;
    gs.submissions[clientId] = msg.card;
    // Remove from hand
    const hand = gs.hands[clientId];
    const idx = hand.indexOf(msg.card);
    if (idx > -1) hand.splice(idx, 1);

    const nonCzarPlayers = room.clients.filter(c => c.id !== gs.czar);
    const allSubmitted = nonCzarPlayers.every(c => gs.submissions[c.id]);
    if (allSubmitted) {
      gs.phase = 'judging';
    }
    broadcastCAHState(room);
    return;
  }

  if (msg.action === 'PICK_WINNER') {
    if (gs.phase !== 'judging') return;
    if (clientId !== gs.czar) return;
    const winnerCard = msg.card;
    const winnerId = Object.entries(gs.submissions).find(([, card]) => card === winnerCard)?.[0];
    if (!winnerId) return;
    gs.scores[winnerId] = (gs.scores[winnerId] || 0) + 1;
    gs.lastWinner = winnerId;
    gs.lastWinningCard = winnerCard;
    gs.phase = 'scores';

    // Update scores on client objects
    room.clients.forEach(c => { c.score = gs.scores[c.id] || 0; });

    const maxPts = room.settings.maxPoints || 7;
    if (gs.scores[winnerId] >= maxPts) {
      gs.winner = winnerId;
    }
    broadcastCAHState(room);
    return;
  }

  if (msg.action === 'NEXT_ROUND') {
    if (gs.phase !== 'scores') return;
    if (gs.winner) {
      // game over - reset
      startCAH(room);
      return;
    }
    // Refill hands
    room.clients.forEach(c => {
      while (gs.hands[c.id] && gs.hands[c.id].length < 7 && gs.whiteDeck.length > 0) {
        gs.hands[c.id].push(gs.whiteDeck.shift());
      }
    });
    const players = room.clients.map(c => c.id);
    gs.czarIndex = (gs.czarIndex + 1) % players.length;
    gs.czar = players[gs.czarIndex];
    gs.submissions = {};
    gs.currentBlack = gs.blackDeck.shift() || DEFAULT_BLACK_CARDS[Math.floor(Math.random() * DEFAULT_BLACK_CARDS.length)];
    gs.phase = 'playing';
    gs.round++;
    broadcastCAHState(room);
    return;
  }

  if (msg.action === 'ADD_BLACK_CARD') {
    if (!client?.isHost) return;
    room.settings.customBlackCards = room.settings.customBlackCards || [];
    room.settings.customBlackCards.push(msg.card);
    ws.send(JSON.stringify({ type: 'SETTINGS_UPDATED', settings: room.settings }));
    return;
  }

  if (msg.action === 'ADD_WHITE_CARD') {
    if (!client?.isHost) return;
    room.settings.customWhiteCards = room.settings.customWhiteCards || [];
    room.settings.customWhiteCards.push(msg.card);
    ws.send(JSON.stringify({ type: 'SETTINGS_UPDATED', settings: room.settings }));
    return;
  }
}

// ---- POKER (Texas Hold'em) ----

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];

function makeDeck() {
  const deck = [];
  for (const suit of SUITS) for (const rank of RANKS) deck.push({ rank, suit });
  return shuffle(deck);
}

function startPoker(room) {
  const players = room.clients.map(c => c.id);
  const chips = {};
  players.forEach(p => chips[p] = room.gameState?.chips?.[p] || 1000);
  
  room.gameState = {
    phase: 'waiting',
    players,
    chips,
    hands: {},
    community: [],
    pot: 0,
    bets: {},
    currentBet: 0,
    dealerIndex: 0,
    currentPlayerIndex: 0,
    deck: [],
    folded: {},
    blind: 10
  };
  dealPokerHand(room);
}

function dealPokerHand(room) {
  const gs = room.gameState;
  gs.deck = makeDeck();
  gs.community = [];
  gs.pot = 0;
  gs.bets = {};
  gs.currentBet = gs.blind * 2;
  gs.folded = {};
  gs.phase = 'preflop';
  gs.hands = {};
  gs.players.forEach(p => {
    gs.hands[p] = [gs.deck.pop(), gs.deck.pop()];
    gs.bets[p] = 0;
  });
  // Post blinds
  const sb = gs.players[(gs.dealerIndex + 1) % gs.players.length];
  const bb = gs.players[(gs.dealerIndex + 2) % gs.players.length];
  gs.bets[sb] = gs.blind;
  gs.bets[bb] = gs.blind * 2;
  gs.chips[sb] -= gs.blind;
  gs.chips[bb] -= gs.blind * 2;
  gs.pot = gs.blind * 3;
  gs.currentPlayerIndex = (gs.dealerIndex + 3) % gs.players.length;
  gs.actionsThisRound = 0;
  broadcastPokerState(room);
}

function broadcastPokerState(room) {
  const gs = room.gameState;
  const roomState = getRoomState(room.code);
  room.clients.forEach(client => {
    if (client.ws.readyState !== 1) return;
    const personal = {
      ...gs,
      myHand: gs.hands[client.id] || [],
      hands: undefined
    };
    client.ws.send(JSON.stringify({ type: 'GAME_STATE', game: 'poker', state: personal, roomState }));
  });
}

function handlePokerAction(room, clientId, msg, ws) {
  const client = room.clients.find(c => c.id === clientId);
  if (msg.action === 'START_GAME') {
    if (!client?.isHost) return;
    startPoker(room);
    return;
  }
  const gs = room.gameState;
  if (!gs) return;

  if (msg.action === 'FOLD') {
    gs.folded[clientId] = true;
    advancePoker(room);
    return;
  }
  if (msg.action === 'CALL') {
    const toCall = gs.currentBet - (gs.bets[clientId] || 0);
    const actual = Math.min(toCall, gs.chips[clientId]);
    gs.chips[clientId] -= actual;
    gs.bets[clientId] = (gs.bets[clientId] || 0) + actual;
    gs.pot += actual;
    advancePoker(room);
    return;
  }
  if (msg.action === 'RAISE') {
    const toCall = gs.currentBet - (gs.bets[clientId] || 0);
    const raise = msg.amount || gs.blind * 2;
    const total = toCall + raise;
    const actual = Math.min(total, gs.chips[clientId]);
    gs.chips[clientId] -= actual;
    gs.bets[clientId] = (gs.bets[clientId] || 0) + actual;
    gs.pot += actual;
    gs.currentBet = gs.bets[clientId];
    advancePoker(room);
    return;
  }
  if (msg.action === 'CHECK') {
    advancePoker(room);
    return;
  }
}

function advancePoker(room) {
  const gs = room.gameState;
  const activePlayers = gs.players.filter(p => !gs.folded[p]);
  
  if (activePlayers.length === 1) {
    gs.phase = 'showdown';
    gs.winner = activePlayers[0];
    gs.chips[activePlayers[0]] += gs.pot;
    gs.pot = 0;
    broadcastPokerState(room);
    return;
  }

  let next = (gs.currentPlayerIndex + 1) % gs.players.length;
  let checked = 0;
  while (gs.folded[gs.players[next]] && checked < gs.players.length) {
    next = (next + 1) % gs.players.length;
    checked++;
  }

  const allCalledOrFolded = activePlayers.every(p => gs.bets[p] === gs.currentBet);
  gs.actionsThisRound = (gs.actionsThisRound || 0) + 1;

  if (allCalledOrFolded && gs.actionsThisRound >= activePlayers.length) {
    // Move to next phase
    gs.bets = {};
    gs.currentBet = 0;
    gs.actionsThisRound = 0;
    activePlayers.forEach(p => gs.bets[p] = 0);
    
    if (gs.phase === 'preflop') {
      gs.community = [gs.deck.pop(), gs.deck.pop(), gs.deck.pop()];
      gs.phase = 'flop';
    } else if (gs.phase === 'flop') {
      gs.community.push(gs.deck.pop());
      gs.phase = 'turn';
    } else if (gs.phase === 'turn') {
      gs.community.push(gs.deck.pop());
      gs.phase = 'river';
    } else if (gs.phase === 'river') {
      gs.phase = 'showdown';
      gs.winner = activePlayers[Math.floor(Math.random() * activePlayers.length)]; // simplified winner
      gs.chips[gs.winner] += gs.pot;
      gs.pot = 0;
    }
    gs.currentPlayerIndex = (gs.dealerIndex + 1) % gs.players.length;
  } else {
    gs.currentPlayerIndex = next;
  }
  broadcastPokerState(room);
}

// ---- MONOPOLY (Simplified) ----

const MONOPOLY_BOARD = [
  {name:'GO',type:'go'},{name:'Mediterranean Ave',type:'property',color:'#A52A2A',price:60,rent:2},
  {name:'Community Chest',type:'chest'},{name:'Baltic Ave',type:'property',color:'#A52A2A',price:60,rent:4},
  {name:'Income Tax',type:'tax',amount:200},{name:'Reading Railroad',type:'railroad',price:200,rent:25},
  {name:'Oriental Ave',type:'property',color:'#87CEEB',price:100,rent:6},{name:'Chance',type:'chance'},
  {name:'Vermont Ave',type:'property',color:'#87CEEB',price:100,rent:6},{name:'Connecticut Ave',type:'property',color:'#87CEEB',price:120,rent:8},
  {name:'Just Visiting',type:'jail'},{name:'St. Charles Place',type:'property',color:'#FF69B4',price:140,rent:10},
  {name:'Electric Co.',type:'utility',price:150,rent:0},{name:'States Ave',type:'property',color:'#FF69B4',price:140,rent:10},
  {name:'Virginia Ave',type:'property',color:'#FF69B4',price:160,rent:12},{name:'Pennsylvania Railroad',type:'railroad',price:200,rent:25},
  {name:'St. James Place',type:'property',color:'#FFA500',price:180,rent:14},{name:'Community Chest',type:'chest'},
  {name:'Tennessee Ave',type:'property',color:'#FFA500',price:180,rent:14},{name:'New York Ave',type:'property',color:'#FFA500',price:200,rent:16},
  {name:'Free Parking',type:'free'},{name:'Kentucky Ave',type:'property',color:'#FF0000',price:220,rent:18},
  {name:'Chance',type:'chance'},{name:'Indiana Ave',type:'property',color:'#FF0000',price:220,rent:18},
  {name:'Illinois Ave',type:'property',color:'#FF0000',price:240,rent:20},{name:'B.&O. Railroad',type:'railroad',price:200,rent:25},
  {name:'Atlantic Ave',type:'property',color:'#FFFF00',price:260,rent:22},{name:'Ventnor Ave',type:'property',color:'#FFFF00',price:260,rent:22},
  {name:'Water Works',type:'utility',price:150,rent:0},{name:'Marvin Gardens',type:'property',color:'#FFFF00',price:280,rent:24},
  {name:'Go To Jail',type:'gotojail'},{name:'Pacific Ave',type:'property',color:'#00AA00',price:300,rent:26},
  {name:'North Carolina Ave',type:'property',color:'#00AA00',price:300,rent:26},{name:'Community Chest',type:'chest'},
  {name:'Pennsylvania Ave',type:'property',color:'#00AA00',price:320,rent:28},{name:'Short Line Railroad',type:'railroad',price:200,rent:25},
  {name:'Chance',type:'chance'},{name:'Park Place',type:'property',color:'#0000FF',price:350,rent:35},
  {name:'Luxury Tax',type:'tax',amount:100},{name:'Boardwalk',type:'property',color:'#0000FF',price:400,rent:50}
];

const PLAYER_COLORS = ['#FF6B6B','#4ECDC4','#FFE66D','#A8E6CF','#FF8B94','#B4F8C8','#FBE7C6','#A0C4FF'];

function startMonopoly(room) {
  const players = room.clients.map(c => c.id);
  const positions = {}, moneyAmounts = {}, inJail = {}, properties = {};
  players.forEach((p, i) => {
    positions[p] = 0;
    moneyAmounts[p] = 1500;
    inJail[p] = false;
  });
  MONOPOLY_BOARD.forEach((_, i) => { properties[i] = null; }); // null = unowned

  room.gameState = {
    phase: 'playing',
    players,
    positions,
    money: moneyAmounts,
    inJail,
    properties,
    currentPlayerIndex: 0,
    currentPlayer: players[0],
    diceRoll: null,
    rolled: false,
    log: ['Game started! Roll the dice to begin.'],
    bankrupt: {}
  };
  broadcastMonopolyState(room);
}

function broadcastMonopolyState(room) {
  const roomState = getRoomState(room.code);
  const msg = JSON.stringify({ type: 'GAME_STATE', game: 'monopoly', state: room.gameState, roomState });
  room.clients.forEach(client => { if (client.ws.readyState === 1) client.ws.send(msg); });
}

function handleMonopolyAction(room, clientId, msg, ws) {
  const client = room.clients.find(c => c.id === clientId);
  if (msg.action === 'START_GAME') {
    if (!client?.isHost) return;
    startMonopoly(room);
    return;
  }
  const gs = room.gameState;
  if (!gs) return;
  if (gs.currentPlayer !== clientId) return;

  if (msg.action === 'ROLL') {
    if (gs.rolled) return;
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    const roll = d1 + d2;
    gs.diceRoll = [d1, d2];
    gs.rolled = true;
    
    const playerName = room.clients.find(c => c.id === clientId)?.name || 'Player';

    if (gs.inJail[clientId]) {
      if (d1 === d2) {
        gs.inJail[clientId] = false;
        gs.log.unshift(`${playerName} rolled doubles and escaped jail!`);
      } else {
        gs.log.unshift(`${playerName} is stuck in jail.`);
        endTurnMonopoly(room, clientId);
        return;
      }
    }

    const oldPos = gs.positions[clientId];
    gs.positions[clientId] = (oldPos + roll) % 40;
    const newPos = gs.positions[clientId];
    if (newPos < oldPos && !gs.inJail[clientId]) {
      gs.money[clientId] += 200;
      gs.log.unshift(`${playerName} passed GO and collected $200!`);
    }

    const square = MONOPOLY_BOARD[newPos];
    gs.log.unshift(`${playerName} rolled ${d1}+${d2}=${roll} and landed on ${square.name}`);

    if (square.type === 'gotojail') {
      gs.positions[clientId] = 10;
      gs.inJail[clientId] = true;
      gs.log.unshift(`${playerName} is going to jail!`);
    } else if (square.type === 'tax') {
      gs.money[clientId] -= square.amount;
      gs.log.unshift(`${playerName} paid $${square.amount} in tax.`);
    } else if ((square.type === 'property' || square.type === 'railroad' || square.type === 'utility') && gs.properties[newPos] !== null && gs.properties[newPos] !== clientId) {
      const rent = square.rent || 25;
      gs.money[clientId] -= rent;
      gs.money[gs.properties[newPos]] += rent;
      const ownerName = room.clients.find(c => c.id === gs.properties[newPos])?.name || 'Someone';
      gs.log.unshift(`${playerName} paid $${rent} rent to ${ownerName}.`);
    }
    
    // Check bankruptcy
    if (gs.money[clientId] <= 0) {
      gs.bankrupt[clientId] = true;
      gs.money[clientId] = 0;
      gs.log.unshift(`${playerName} is BANKRUPT!`);
    }

    broadcastMonopolyState(room);
    return;
  }

  if (msg.action === 'BUY') {
    const pos = gs.positions[clientId];
    const square = MONOPOLY_BOARD[pos];
    if (!gs.rolled) return;
    if (gs.properties[pos] !== null) return;
    if (gs.money[clientId] < square.price) return;
    gs.money[clientId] -= square.price;
    gs.properties[pos] = clientId;
    const playerName = room.clients.find(c => c.id === clientId)?.name || 'Player';
    gs.log.unshift(`${playerName} bought ${square.name} for $${square.price}!`);
    broadcastMonopolyState(room);
    return;
  }

  if (msg.action === 'END_TURN') {
    endTurnMonopoly(room, clientId);
    return;
  }
}

function endTurnMonopoly(room, clientId) {
  const gs = room.gameState;
  gs.rolled = false;
  gs.diceRoll = null;
  let next = (gs.currentPlayerIndex + 1) % gs.players.length;
  let safety = 0;
  while (gs.bankrupt[gs.players[next]] && safety < gs.players.length) {
    next = (next + 1) % gs.players.length;
    safety++;
  }
  gs.currentPlayerIndex = next;
  gs.currentPlayer = gs.players[next];
  const nextName = room.clients.find(c => c.id === gs.currentPlayer)?.name || 'Next Player';
  gs.log.unshift(`It's ${nextName}'s turn.`);
  broadcastMonopolyState(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🎮 Party Games running on http://localhost:${PORT}`));

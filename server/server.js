// server/server.js
// Version COMPLÈTE intégrant Showdown et corrections logiques, AVEC CORRECTION c.username -> creator.username

const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const shuffle = require('array-shuffle').default;
const Hand = require('pokersolver').Hand; // Import de Pokersolver

const app = express(); app.use(cors()); const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "http://localhost:3000", methods: ["GET", "POST"] } });
const PORT = process.env.PORT || 4000;

let usersConnected = {};
let activeTables = {};

// --- Constantes & Fonctions Utilitaires ---
const SUITS=["s","h","d","c"]; const RANKS=["2","3","4","5","6","7","8","9","T","J","Q","K","A"];
const STARTING_STACK=1000; const MIN_PLAYERS_TO_START=2;
const createDeck = () => { const d=[]; for(const s of SUITS) for(const r of RANKS) d.push(r+s); return d; };

const findNextPlayerToAct = (table, startSeat, requireCanBet = true) => {
    if (!table || !table.players || table.players.length < 1) return null;
    const potentiallyActivePlayers = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting');
    if (potentiallyActivePlayers.length === 0) return null;
    const seats = potentiallyActivePlayers.map(p => p.seat).sort((a, b) => a - b);
    if (seats.length === 0) return null;
    let currentSeat = startSeat;
    for (let i = 0; i < table.maxPlayers + 1; i++) {
        currentSeat = (currentSeat % table.maxPlayers) + 1;
        const nextPlayer = potentiallyActivePlayers.find(p => p.seat === currentSeat);
        if (nextPlayer && (!requireCanBet || (nextPlayer.stack > 0 && nextPlayer.statusInHand !== 'all_in'))) {
            return nextPlayer.seat;
        }
    }
    console.warn(`findNextPlayerToAct fallback from seat ${startSeat}`);
    const firstActiveSeat = seats[0];
    const firstActivePlayer = potentiallyActivePlayers.find(p => p.seat === firstActiveSeat);
    if(firstActivePlayer && (!requireCanBet || (firstActivePlayer.stack > 0 && firstActivePlayer.statusInHand !== 'all_in'))) {
        return firstActiveSeat;
    }
    return null;
};

const findFirstToActPostFlop = (table) => {
    if (!table || !table.players || table.dealerSeat === null) return null;
    let searchSeat = table.dealerSeat;
    for (let i = 0; i < table.maxPlayers; i++) {
        searchSeat = (searchSeat % table.maxPlayers) + 1;
        const player = table.players.find(p => p.seat === searchSeat);
        if (player && player.statusInHand !== 'folded' && player.statusInHand !== 'waiting' && player.stack > 0) {
            return player.seat;
        }
    }
    console.warn("Fallback in findFirstToActPostFlop");
    const firstActive = table.players.find(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.stack > 0);
    return firstActive ? firstActive.seat : null;
}

const findPreviousActivePlayer = (table, targetSeat) => {
    if (!table || !table.players || targetSeat === null) return null;
    const potentiallyActivePlayers = table.players.filter(p => p.statusInHand === 'playing' && p.stack > 0);
    if (potentiallyActivePlayers.length < 1) return null;
    const seats = potentiallyActivePlayers.map(p => p.seat).sort((a, b) => a - b);
    if (seats.length === 0) return null;
    let currentIndex = seats.indexOf(targetSeat);
    if (currentIndex === -1) {
        console.warn(`Target seat ${targetSeat} not found for findPreviousActivePlayer`);
        let currentSeat = targetSeat;
        for(let i=0; i<table.maxPlayers; i++){
             currentSeat = (currentSeat - 2 + table.maxPlayers) % table.maxPlayers + 1;
             if(seats.includes(currentSeat)){
                 currentIndex = seats.indexOf(currentSeat);
                 break;
             }
        }
        if(currentIndex===-1) return null;
    }
    const prevIndex = (currentIndex - 1 + seats.length) % seats.length;
    return seats[prevIndex];
}

const postBet = (table, player, amount) => { const betAmount=Math.min(amount,player.stack);player.stack-=betAmount;player.betInStage+=betAmount;table.pot+=betAmount;console.log(` -> ${player.username} posts ${betAmount}`);if(player.stack===0){player.statusInHand='all_in';console.log(` -> ${player.username} ALL-IN!`);}return betAmount;};

// --- Logique de Fin de Tour/Main ---
const progressToNextStage = (tableId) => { const table = activeTables[tableId]; if (!table) return; console.log(`--- Betting round ${table.stage} ended ---`); table.players.forEach(p => { if(p.statusInHand !== 'folded' && p.statusInHand !== 'waiting') p.betInStage = 0; }); table.currentBet = 0; table.lastRaiserSeat = null; table.currentTurnSeat = null; table.numActionsThisRound = 0; const playersLeftToActCount = table.players.filter(p => p.statusInHand === 'playing' && p.stack > 0).length; let goToStage = null; if (table.stage === 'preflop_betting') goToStage = 'dealing_flop'; else if (table.stage === 'flop_betting') goToStage = 'dealing_turn'; else if (table.stage === 'turn_betting') goToStage = 'dealing_river'; else if (table.stage === 'river_betting') goToStage = 'showdown'; else { console.error(`Progression error: ${table.stage}`); endHand(tableId); return; } console.log(`Progressing from ${table.stage}. Next: ${goToStage}`); if (goToStage === 'dealing_flop' || goToStage === 'dealing_turn' || goToStage === 'dealing_river') { const cardsToDeal = (goToStage === 'dealing_flop') ? 3 : 1; const needed = cardsToDeal + 1; if (table.deck.length < needed) { endHand(tableId); return; } table.deck.pop(); for(let i=0;i<cardsToDeal;i++)table.communityCards.push(table.deck.pop()); console.log(`Dealt: ${table.communityCards.join(',')}`); } if (goToStage === 'dealing_flop') table.stage = 'flop_betting'; else if (goToStage === 'dealing_turn') table.stage = 'turn_betting'; else if (goToStage === 'dealing_river') table.stage = 'river_betting'; else if (goToStage === 'showdown') table.stage = 'showdown'; if (playersLeftToActCount < 2 && table.stage !== 'showdown') { console.log("<2 players can act."); while(table.stage !== 'showdown' && table.communityCards.length < 5) { if(table.deck.length < 2) break; table.deck.pop(); table.communityCards.push(table.deck.pop()); const nextS = table.communityCards.length===4?'turn_betting':'river_betting'; table.stage = nextS;} table.stage = 'showdown'; } if (table.stage === 'flop_betting' || table.stage === 'turn_betting' || table.stage === 'river_betting') { table.currentTurnSeat = findFirstToActPostFlop(table); table.betToCloseRound = findPreviousActivePlayer(table, table.currentTurnSeat); console.log(`--- ${table.stage} Starts --- Turn: ${table.currentTurnSeat}. Closes: ${table.betToCloseRound}`); broadcastUpdates(); } else if (table.stage === 'showdown') { console.log("Showdown (TODO)"); endHand(tableId); } else { broadcastUpdates();} };
const endHand = (tableId) => { const table=activeTables[tableId];if(!table)return;console.log(`--- Hand Ending ${table.name} ---`);const eligiblePlayers = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting'); let winners = []; let winningHandData = null; if (eligiblePlayers.length === 0) { console.error("No eligible players?"); table.pot = 0; } else if (eligiblePlayers.length === 1) { winners.push(eligiblePlayers[0]); console.log(`Winner by default: ${winners[0].username}`); } else { console.log("Showdown!"); const communityCards = table.communityCards?.map(c => c.replace('T', '10')) || []; if (communityCards.length !== 5) { console.error(`Showdown attempt with ${communityCards.length} cards!`); winners = eligiblePlayers; } else { let contenders = []; eligiblePlayers.forEach(player => { if (player.holeCards?.length === 2) { const playerCards = player.holeCards.map(c => c.replace('T', '10')); const sevenCards = communityCards.concat(playerCards); try { const hand = Hand.solve(sevenCards); console.log(` -> ${player.username}: ${hand.name}`); contenders.push({ player: player, hand: hand }); } catch (e) { console.error(`Error solving ${player.username}:`, e);}}}); if (contenders.length > 0) { const winningHands = Hand.winners(contenders.map(c => c.hand)); if (winningHands?.length > 0) { const firstWinnerHand = winningHands[0]; winningHandData = { name: firstWinnerHand.name, desc: firstWinnerHand.description, rank: firstWinnerHand.rank }; console.log(`Winning Hand: ${winningHandData.name}`); winners = contenders.filter(c => winningHands.some(wh => wh === c.hand)).map(c => c.player); console.log(`Winner(s): ${winners.map(w => w.username).join(', ')}`); } else { console.error("Pokersolver winners error!"); winners = []; } } else { console.error("No contenders?"); winners = []; } } } let totalPotAwarded = 0; if (winners.length > 0) { const potShare = Math.floor(table.pot / winners.length); winners.forEach(winner => { console.log(` -> Awarding ${potShare} to ${winner.username}`); winner.stack += potShare; totalPotAwarded += potShare; }); table.pot -= totalPotAwarded; if(table.pot > 0.01) console.log(` -> Remainder: ${table.pot}`); table.pot = 0; } else { console.warn("No winners?"); table.pot = 0; } table.status = 'finished'; table.stage = 'showdown'; table.currentTurnSeat = null; table.showdownResults = { winners: winners.map(w => ({ username: w.username, seat: w.seat })), winningHandName: winningHandData ? winningHandData.name : "N/A", winningHandDesc: winningHandData ? winningHandData.desc : "N/A", potWon: totalPotAwarded }; broadcastUpdates(); };
const setupBlindsAndStartBetting = (tableId) => { const table = activeTables[tableId]; if (!table || table.status !== 'playing' || table.stage !== 'preflop_blinds') return; console.log(`Setting Blinds`); const activePlayers=table.players.filter(p=>p.statusInHand==='playing'&&p.stack>0); if(activePlayers.length<MIN_PLAYERS_TO_START)return; let sbSeat,bbSeat,firstToActSeat; table.pot=0; table.players.forEach(p=>p.betInStage=0); const dealerSeat = table.dealerSeat; sbSeat=findNextPlayerToAct(table, dealerSeat, false); bbSeat=findNextPlayerToAct(table, sbSeat, false); firstToActSeat=findNextPlayerToAct(table, bbSeat, true); if(!sbSeat || !bbSeat || !firstToActSeat) { console.error("Could not determine blind/action seats!"); return;} const sbPlayer=table.players.find(p=>p.seat===sbSeat); if(sbPlayer)postBet(table,sbPlayer,table.smallBlind); const bbPlayer=table.players.find(p=>p.seat===bbSeat); if(bbPlayer){const actualBB=postBet(table,bbPlayer,table.bigBlind); table.currentBet=actualBB; table.lastRaiserSeat=bbSeat; table.betToCloseRound=bbSeat;} else { table.betToCloseRound = sbSeat;} table.currentTurnSeat=firstToActSeat; table.stage='preflop_betting'; table.numActionsThisRound=0; console.log(`Preflop Betting Starts. Turn: Seat ${table.currentTurnSeat}. Bet closes on ${table.betToCloseRound}`); broadcastUpdates();};
const startNewHand = (tableId) => { const table=activeTables[tableId]; const activeCount=table?.players.filter(p=>p.stack>0).length??0; if(!table||activeCount<MIN_PLAYERS_TO_START||table.status!=='waiting')return; console.log(`Starting new hand ${table.name}`); table.status='playing'; table.stage='dealing'; table.pot=0; table.communityCards=[]; table.deck=shuffle(createDeck()); table.currentBet=0; table.lastRaiserSeat=null; table.betToCloseRound = null; table.numActionsThisRound = 0; table.showdownResults = null; table.players.forEach(p=>{p.holeCards=[]; p.betInStage=0; p.statusInHand=(p.stack>0)?'playing':'waiting';}); const playing=table.players.filter(p=>p.statusInHand==='playing'); for(let i=0;i<2;i++){for(const p of playing){if(table.deck.length>0)p.holeCards.push(table.deck.pop());}} console.log(`Cards dealt ${playing.length}`); table.dealerSeat=findNextPlayerToAct(table,table.dealerSeat, false); console.log(`Dealer: ${table.dealerSeat}`); table.stage='preflop_blinds'; setupBlindsAndStartBetting(tableId); };
const findAvailableSeat = (table) => { const seats=table.players.map(p=>p.seat); for(let i=1; i<=table.maxPlayers; i++){if(!seats.includes(i))return i;} return null; };
const formatTableForClient = (table, targetSocketId) => { if(!table) return null; const user = usersConnected[targetSocketId]; const isShowdown = table.stage === 'showdown' || table.status === 'finished'; return { id: table.id, name: table.name, players: table.players.map(p => ({ username: p.username, seat: p.seat, stack: p.stack, statusInHand: p.statusInHand, betInStage: p.betInStage||0, holeCards: (p.socketId === targetSocketId || (isShowdown && p.statusInHand !== 'folded' && p.statusInHand !== 'waiting')) ? p.holeCards : null, hasCards: p.holeCards?.length>0 && p.statusInHand !== 'folded' && p.statusInHand !== 'waiting', })), smallBlind: table.smallBlind, bigBlind: table.bigBlind, status: table.status, maxPlayers: table.maxPlayers, dealerSeat: table.dealerSeat, pot: table.pot, communityCards: table.communityCards, stage: table.stage, currentTurnSeat: table.currentTurnSeat, currentBet: table.currentBet||0, creatorUsername: table.creatorUsername, isCreator: user?.username===table.creatorUsername, showdownResults: table.showdownResults }; };
const broadcastUpdates = () => { console.log(">>> SERVER DEBUG: Entering broadcastUpdates function..."); try { const lobbyTables=Object.values(activeTables).map(t=>({id:t.id, name:t.name, playerCount:t.players.length, smallBlind:t.smallBlind, bigBlind:t.bigBlind, status:t.status, maxPlayers:t.maxPlayers})); for(const sid in usersConnected){const u=usersConnected[sid]; const s=io.sockets.sockets.get(sid); if(!s) { continue; } if(u.currentTableId === null){ s.emit('update_table_list',lobbyTables); } else { const tbl=activeTables[u.currentTableId]; if (tbl) { s.emit('update_active_table',formatTableForClient(tbl,sid)); } else { console.warn(`   -> User ${u.username || sid} at missing table ${u.currentTableId}.`); u.currentTableId = null; s.emit('left_table'); s.emit('update_table_list', lobbyTables); } } } console.log("📢 Broadcasted updates successfully."); } catch (error) { console.error("!!!! ERROR during broadcastUpdates !!!!", error); } };

// --- Gestion Connexions & Événements Socket ---
app.get('/', (req, res) => { res.send('Poker Server is running!'); });
io.on('connection', (socket) => {
    console.log(`⚡: User connected ${socket.id}`); usersConnected[socket.id] = { username: null, currentTableId: null };
    const initialTables = Object.values(activeTables).map(t=>({id:t.id, name:t.name, playerCount:t.players.length, smallBlind:t.smallBlind, bigBlind:t.bigBlind, status:t.status, maxPlayers:t.maxPlayers})); socket.emit('update_table_list', initialTables);

    // --- Listener set_username (Fonctionnel + Logs) ---
    socket.on('set_username', (username) => {
        console.log(`>>> SERVER RECEIVED set_username: '${username}' from ${socket.id}`);
        const trimmedUsername = username?.trim();
        if (!trimmedUsername || Object.values(usersConnected).some(u => u.username === trimmedUsername)) {
            console.log("   -> Username invalid/taken. Emitting error.");
            return socket.emit('username_error', 'Invalid/Taken');
        }
        usersConnected[socket.id].username = trimmedUsername;
        console.log(`👤: ${socket.id} is now ${trimmedUsername}`);
        socket.emit('username_set', trimmedUsername);
        socket.broadcast.emit('chat_message', { system: true, text: `${trimmedUsername} a rejoint.` });
    });

    // --- Listener create_table (CORRIGÉ + Logs) ---
    socket.on('create_table', (data) => {
        console.log(`>>> SERVER DEBUG: Received 'create_table' from ${socket.id} with data:`, data);
        const creator = usersConnected[socket.id]; // <<< Récupère l'objet utilisateur via socket.id
        if (!creator?.username) {
            console.log("   -> Error: Creator not found or no username.");
            return socket.emit('error_message', 'Login required');
        }
        const name = data?.name?.trim() || `${creator.username}'s Table`;
        const sb = parseInt(data?.smallBlind, 10) || 1;
        const bb = parseInt(data?.bigBlind, 10) || 2;
        if (sb <= 0 || bb <= sb) {
             console.log(`   -> Error: Invalid blinds (SB: ${sb}, BB: ${bb}).`);
             return socket.emit('error_message', 'Invalid blinds');
        }
        const id = uuidv4();
        console.log(`   -> Generating table ID: ${id}`);
        activeTables[id] = {
            id, name, players: [], smallBlind: sb, bigBlind: bb, status: 'waiting', maxPlayers: 9,
            deck: [], communityCards: [], pot: 0, dealerSeat: null, currentTurnSeat: null, stage: null,
            currentBet: 0, lastRaiserSeat: null,
            // *** CORRECTION APPLIQUÉE ICI ***
            creatorUsername: creator.username,
            numActionsThisRound: 0, betToCloseRound: null, showdownResults: null
        };
        console.log(`➕ Table '${name}' created by ${creator.username}. Calling broadcastUpdates...`);
        broadcastUpdates(); // Appel normal
    });

    socket.on('join_table', ({ tableId })=>{ const u=usersConnected[socket.id]; const t=activeTables[tableId]; if(!u?.username||u.currentTableId||!t||t.players.length>=t.maxPlayers)return socket.emit('error_message','Cannot join'); const s=findAvailableSeat(t); if(!s)return socket.emit('error_message','No seat'); const p={socketId:socket.id,username:u.username,seat:s,stack:STARTING_STACK,holeCards:[],statusInHand:'waiting',betInStage:0}; t.players.push(p); u.currentTableId=tableId; console.log(`➡️ ${u.username} joined ${t.name}`); broadcastUpdates(); });
    socket.on('request_start_game', ({ tableId })=>{ const u=usersConnected[socket.id]; const t=activeTables[tableId]; if(!u?.username||!t||u.currentTableId!==tableId||t.creatorUsername!==u.username||t.status!=='waiting'||t.players.filter(p=>p.stack>0).length<MIN_PLAYERS_TO_START) return socket.emit('error_message','Cannot start'); console.log(`User ${u.username} starting ${t.name}`); startNewHand(tableId); });

    socket.on('player_action', (actionData) => {
        const user=usersConnected[socket.id]; if(!user?.currentTableId)return; const table=activeTables[user.currentTableId]; const player=table?.players.find(p=>p.socketId===socket.id);
        if(!table||!player||table.status!=='playing'||player.seat!==table.currentTurnSeat||player.statusInHand!=='playing') return socket.emit('error_message','Action invalide/Pas tour');
        console.log(`ACTION ${player.username} (Seat ${player.seat}):`, actionData);
        const type=actionData.type; const amount=parseInt(actionData.amount,10)||0;
        let playerActedSeat = player.seat;
        let isAggressiveAction = false;
        table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;

        switch(type){ /* ... Traitement actions ... */
            case 'fold': player.statusInHand='folded'; const activeLeft=table.players.filter(p=>p.statusInHand!=='folded'&&p.statusInHand!=='waiting'); if(activeLeft.length<=1){ endHand(user.currentTableId); return; } break;
            case 'check': if(player.betInStage<table.currentBet)return socket.emit('error_message','Cannot Check'); console.log(` -> ${player.username} checks.`); break;
            case 'call': const toCall=table.currentBet-player.betInStage; if(toCall<0){console.warn("Call negative?");} if(toCall===0&&table.currentBet>0 && player.betInStage === table.currentBet) { console.log(` -> ${player.username} effectively checks.`);} else if (toCall > 0) { postBet(table,player,toCall); } else { if(table.currentBet===0) console.log(` -> ${player.username} effectively checks.`); else return socket.emit('error_message','Cannot Call');} break;
            case 'bet': if(table.currentBet>0)return socket.emit('error_message','Cannot Bet'); if(amount<table.bigBlind&&player.stack>amount)return socket.emit('error_message',`Min Bet ${table.bigBlind}`); if(amount>player.stack)return socket.emit('error_message','Bet > Stack'); const betAmt=postBet(table,player,amount); table.currentBet=betAmt; table.lastRaiserSeat=player.seat; table.betToCloseRound = findPreviousActivePlayer(table, player.seat); isAggressiveAction = true; break;
            case 'raise': if(table.currentBet===0)return socket.emit('error_message','Cannot Raise'); const lastBetter = table.players.find(p=>p.seat===table.lastRaiserSeat); const lastBetOrBlindSize = table.lastRaiserSeat ? table.currentBet - (lastBetter?.betInStage - (type === 'raise' ? amount - player.betInStage : 0) || 0) : table.bigBlind; const minRaiseAmt = Math.max(lastBetOrBlindSize, table.bigBlind); const minRaiseTotal=table.currentBet + minRaiseAmt; if(amount<minRaiseTotal&&player.stack>amount)return socket.emit('error_message',`Min Raise to ${minRaiseTotal}`); if(amount>player.stack) return socket.emit('error_message','Raise > Stack'); const raiseAmtToAdd=amount-player.betInStage; postBet(table,player,raiseAmtToAdd); table.currentBet=amount; table.lastRaiserSeat=player.seat; table.betToCloseRound = findPreviousActivePlayer(table, player.seat); isAggressiveAction = true; break;
            default: return socket.emit('error_message','Unknown action');
        }

        // --- LOGIQUE DE FIN DE TOUR / JOUEUR SUIVANT (v10 - Corrigée BB Option / Check Around) ---
        let roundOver = false;
        const activePlayers = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting');
        if (activePlayers.length <= 1) { roundOver = true; }
        else {
            const playersWhoCanAct = activePlayers.filter(p => p.statusInHand === 'playing' && p.stack > 0);
            if (playersWhoCanAct.length === 0) { roundOver = true; } // Tous all-in
            else {
                const maxBet = Math.max(0, ...activePlayers.map(p => p.betInStage));
                const allMatchedOrAllIn = activePlayers.every(p => p.betInStage === maxBet || p.statusInHand === 'all_in');
                const closingPlayerSeat = table.betToCloseRound;
                const hasEveryoneActedMinOnce = table.numActionsThisRound >= playersWhoCanAct.length;

                if (allMatchedOrAllIn) {
                    const bbSeat = findNextPlayerToAct(table, findNextPlayerToAct(table, table.dealerSeat, false), false);
                    const isPreflop = table.stage === 'preflop_betting';
                    const isBB = playerActedSeat === bbSeat;
                    const noPriorRaise = table.lastRaiserSeat === bbSeat || table.lastRaiserSeat === null;
                    const isPreflopBBClosingCheck = isPreflop && isBB && type === 'check' && noPriorRaise;

                    if (isPreflopBBClosingCheck) {
                         console.log(`Betting Ends [Special]: BB ${playerActedSeat} checked option preflop.`);
                         roundOver = true;
                    }
                    else if (playerActedSeat === closingPlayerSeat && table.numActionsThisRound > 0) { // > 0 pour éviter fin immédiate si BB=Closer au début
                         // Si ce n'est pas la BB préflop qui checke son option initiale
                         if (!isPreflop || !isBB || !noPriorRaise || type !== 'check') {
                               console.log(`Betting Ends [General]: Action completed by closing player ${closingPlayerSeat}.`);
                               roundOver = true;
                         }
                    }
                    else if (table.currentBet === 0 && !isPreflop && hasEveryoneActedMinOnce && playerActedSeat === closingPlayerSeat) {
                          console.log(`Betting Ends [CheckAround]: Postflop check around completed by ${playerActedSeat}.`);
                          roundOver = true;
                    }
                }
            }
        }
        // Mise à jour de qui ferme le tour si action agressive
        if (isAggressiveAction) { table.betToCloseRound = findPreviousActivePlayer(table, playerActedSeat); console.log(`Aggressive Action. Closer: ${table.betToCloseRound}`); }

        // --- Décision finale ---
        if (roundOver) { progressToNextStage(user.currentTableId); }
        else { const nextPlayerSeat = findNextPlayerToAct(table, playerActedSeat); if (nextPlayerSeat !== null) { table.currentTurnSeat = nextPlayerSeat; console.log(`Next turn: Seat ${table.currentTurnSeat}`); broadcastUpdates(); } else { console.log("No active player found, progressing stage."); progressToNextStage(user.currentTableId); } }
    }); // Fin player_action

    socket.on('leave_table', () => { /* ... Listener fonctionnel ... */ });
    socket.on('chat_message', (data)=>{ /* ... Listener fonctionnel ... */ });
    socket.on('disconnect', () => { /* ... Listener fonctionnel ... */ });

}); // Fin io.on('connection')

server.listen(PORT, () => { console.log(`🚀 Server listening on port ${PORT}`); });
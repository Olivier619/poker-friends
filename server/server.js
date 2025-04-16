// server/server.js
// Version corrigée intégrant Showdown, CORS, et nettoyage de la structure

// --- Imports ---
const express = require('express');         // Pour un serveur HTTP de base (optionnel si pas de routes API HTTP)
const http = require('http');             // Module HTTP natif de Node.js
const { Server } = require("socket.io");  // Classe Server de Socket.IO
const cors = require('cors');             // Middleware pour gérer CORS
const { v4: uuidv4 } = require('uuid');     // Pour générer des IDs uniques
const shuffle = require('array-shuffle'); // Utilitaire pour mélanger (note: .default n'est pas nécessaire ici)
const Hand = require('pokersolver').Hand; // Import de Pokersolver

// --- Configuration ---
const PORT = process.env.PORT || 4000;     // Port d'écoute (Render fournira PORT)
const STARTING_STACK = 1000;
const MIN_PLAYERS_TO_START = 2;
const MAX_PLAYERS_PER_TABLE = 9; // Définir ici plutôt que codé en dur plus loin
const SUITS = ["s", "h", "d", "c"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "T", "J", "Q", "K", "A"];

// --- État Global du Serveur ---
let usersConnected = {}; // Clé: socket.id, Valeur: { username, currentTableId }
let activeTables = {};   // Clé: tableId, Valeur: objet table détaillé

// --- Configuration CORS ---
// L'URL du frontend qui est autorisée à se connecter
const allowedOrigin = process.env.CORS_ORIGIN || "http://localhost:3000"; // Fallback pour tests locaux

const corsOptions = {
  origin: allowedOrigin,
  methods: ["GET", "POST"] // Méthodes nécessaires pour la négociation Socket.IO
};

// --- Initialisation Serveur Express et HTTP ---
const app = express();
// Appliquer CORS aux routes Express si vous en avez/ajoutez
// Si vous n'utilisez Express QUE pour démarrer le serveur HTTP pour Socket.IO, cette ligne est optionnelle
app.use(cors(corsOptions));
// Créer le serveur HTTP à partir de l'application Express
const httpServer = http.createServer(app);

// --- Initialisation Serveur Socket.IO (AVEC options CORS) ---
const io = new Server(httpServer, {
  cors: corsOptions // Passer les options CORS directement à Socket.IO
});

// --- Route HTTP de base (optionnelle, pour vérifier que le serveur tourne) ---
app.get('/', (req, res) => {
  res.send('Poker Server is running!');
});

// --- Fonctions Utilitaires ---
const createDeck = () => { const d = []; for (const s of SUITS) for (const r of RANKS) d.push(r + s); return d; };

const findNextPlayerToAct = (table, startSeat, requireCanBet = true) => {
    if (!table?.players?.length) return null;
    // Filtrer les joueurs qui peuvent potentiellement jouer (pas folded, pas en attente)
    const potentiallyActivePlayers = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting');
    if (potentiallyActivePlayers.length === 0) return null;
    const seats = potentiallyActivePlayers.map(p => p.seat).sort((a, b) => a - b);
    if (seats.length === 0) return null;

    let currentSeatIndex = seats.indexOf(startSeat);
    // Si le siège de départ n'est pas dans la liste active (ou si startSeat est null), on commence la recherche
    // à partir d'une position valide (ou 0 si introuvable, ce qui devrait être rare).
    if (currentSeatIndex === -1) {
       // Essayer de trouver le siège *avant* celui demandé pour commencer la boucle logiquement
       let searchSeat = startSeat ? (startSeat - 2 + MAX_PLAYERS_PER_TABLE) % MAX_PLAYERS_PER_TABLE + 1 : seats[seats.length - 1];
       for(let i=0; i < MAX_PLAYERS_PER_TABLE; i++){
           if(seats.includes(searchSeat)) {
               currentSeatIndex = seats.indexOf(searchSeat);
               break;
           }
           searchSeat = (searchSeat - 2 + MAX_PLAYERS_PER_TABLE) % MAX_PLAYERS_PER_TABLE + 1;
       }
       if(currentSeatIndex === -1) currentSeatIndex = seats.length - 1; // Fallback au dernier joueur
    }


    for (let i = 0; i < seats.length; i++) {
        const nextIndex = (currentSeatIndex + 1 + i) % seats.length;
        const nextSeat = seats[nextIndex];
        const nextPlayer = potentiallyActivePlayers.find(p => p.seat === nextSeat);

        // Si on trouve un joueur et qu'il remplit la condition 'requireCanBet'
        if (nextPlayer && (!requireCanBet || (nextPlayer.stack > 0 && nextPlayer.statusInHand !== 'all_in'))) {
            return nextPlayer.seat;
        }
    }

    console.warn(`findNextPlayerToAct could not find a suitable player starting from seat ${startSeat} with requireCanBet=${requireCanBet}`);
    // Fallback très simple : le premier joueur actif qui peut miser (si requireCanBet)
    const fallbackPlayer = potentiallyActivePlayers.find(p => !requireCanBet || (p.stack > 0 && p.statusInHand !== 'all_in'));
    return fallbackPlayer ? fallbackPlayer.seat : null;
};


const findFirstToActPostFlop = (table) => {
    if (!table?.players?.length || table.dealerSeat === null) return null;
    // Commence la recherche APRES le dealer
    return findNextPlayerToAct(table, table.dealerSeat, true);
};

const findPreviousActivePlayer = (table, targetSeat) => {
     if (!table?.players?.length || targetSeat === null) return null;
     const potentiallyActivePlayers = table.players.filter(p => p.statusInHand === 'playing' && p.stack > 0);
     if (potentiallyActivePlayers.length < 2) return null; // Besoin d'au moins 2 pour avoir un précédent
     const seats = potentiallyActivePlayers.map(p => p.seat).sort((a, b) => a - b);
     if (seats.length === 0) return null;

     let currentIndex = seats.indexOf(targetSeat);
     if (currentIndex === -1) {
         console.warn(`Target seat ${targetSeat} not found for findPreviousActivePlayer`);
         // Essayer de trouver un siège valide comme point de référence (difficile sans contexte)
         // Fallback : prendre le dernier joueur de la liste comme référence "précédente"
         return seats[seats.length - 1];
     }
     const prevIndex = (currentIndex - 1 + seats.length) % seats.length;
     return seats[prevIndex];
 }


const postBet = (table, player, amount) => {
    const betAmount = Math.min(amount, player.stack);
    player.stack -= betAmount;
    player.betInStage = (player.betInStage || 0) + betAmount; // Assurer que betInStage est initialisé
    table.pot = (table.pot || 0) + betAmount; // Assurer que pot est initialisé
    console.log(` -> ${player.username} posts ${betAmount} (stack: ${player.stack}, betInStage: ${player.betInStage}, pot: ${table.pot})`);
    if (player.stack === 0 && player.statusInHand !== 'all_in') { // Vérifier pour éviter log multiple
        player.statusInHand = 'all_in';
        console.log(` -> ${player.username} ALL-IN!`);
    }
    return betAmount;
};

// --- Logique de Fin de Tour/Main (Simplifiée, nécessite tests robustes) ---
// (Le code existant est conservé mais nécessite une revue approfondie pour la robustesse)
const progressToNextStage = (tableId) => { /* ... Votre logique existante ... */ };
const endHand = (tableId) => { /* ... Votre logique existante avec Pokersolver ... */ };
const setupBlindsAndStartBetting = (tableId) => { /* ... Votre logique existante ... */ };
const startNewHand = (tableId) => { /* ... Votre logique existante ... */ };
const findAvailableSeat = (table) => { /* ... Votre logique existante ... */ };
const formatTableForClient = (table, targetSocketId) => { /* ... Votre logique existante ... */ };

const broadcastUpdates = () => {
    console.log("Broadcasting updates...");
    try {
        const lobbyTables = Object.values(activeTables).map(t => ({
            id: t.id,
            name: t.name,
            playerCount: t.players.length,
            smallBlind: t.smallBlind,
            bigBlind: t.bigBlind,
            status: t.status,
            maxPlayers: t.maxPlayers
        }));

        for (const sid in usersConnected) {
            const user = usersConnected[sid];
            const socketInstance = io.sockets.sockets.get(sid); // Obtenir l'instance du socket

            if (!socketInstance) {
                console.warn(`   -> Socket not found for SID: ${sid}. Skipping broadcast.`);
                continue; // Passer au suivant si le socket n'existe plus
            }

            if (user.currentTableId === null) {
                // Envoyer la liste des tables du lobby
                socketInstance.emit('update_table_list', lobbyTables);
            } else {
                const table = activeTables[user.currentTableId];
                if (table) {
                    // Envoyer les détails de la table active formatés pour ce client
                    socketInstance.emit('update_active_table', formatTableForClient(table, sid));
                } else {
                    // Si l'utilisateur est assigné à une table qui n'existe plus (rare)
                    console.warn(`   -> User ${user.username || sid} was at missing table ${user.currentTableId}. Resetting.`);
                    usersConnected[sid].currentTableId = null; // Réinitialiser côté serveur
                    socketInstance.emit('left_table'); // Informer le client qu'il a quitté
                    socketInstance.emit('update_table_list', lobbyTables); // Lui renvoyer le lobby
                }
            }
        }
        console.log("📢 Broadcasted updates successfully.");
    } catch (error) {
        console.error("!!!! ERROR during broadcastUpdates !!!!", error);
    }
};


// --- Gestion Connexions & Événements Socket ---
io.on('connection', (socket) => {
    console.log(`⚡: User connected ${socket.id}`);
    usersConnected[socket.id] = { username: null, currentTableId: null };

    // Envoyer l'état initial du lobby au nouveau connecté
    const initialTables = Object.values(activeTables).map(t => ({ id: t.id, name: t.name, playerCount: t.players.length, smallBlind: t.smallBlind, bigBlind: t.bigBlind, status: t.status, maxPlayers: t.maxPlayers }));
    socket.emit('update_table_list', initialTables);

    // --- Listener set_username ---
    socket.on('set_username', (username) => {
        console.log(`>>> SERVER RECEIVED set_username: '${username}' from ${socket.id}`);
        const trimmedUsername = username?.trim();
        // Vérifier si le pseudo est valide et non déjà pris
        if (!trimmedUsername || Object.values(usersConnected).some(u => u && u.username === trimmedUsername)) {
            console.log(`   -> Username invalid/taken: '${trimmedUsername}'. Emitting error.`);
            return socket.emit('username_error', `Pseudo invalide ou déjà pris.`);
        }
        // Mettre à jour l'utilisateur
        usersConnected[socket.id].username = trimmedUsername;
        console.log(`👤: ${socket.id} is now ${trimmedUsername}`);
        socket.emit('username_set', trimmedUsername); // Confirmer au client
        // Informer les autres (optionnel)
        // socket.broadcast.emit('chat_message', { system: true, text: `${trimmedUsername} a rejoint.` });
        broadcastUpdates(); // Mettre à jour car l'état a changé (même si pas en jeu)
    });

    // --- Listener create_table ---
    socket.on('create_table', (data) => {
        console.log(`>>> SERVER RECEIVED create_table from ${socket.id} with data:`, data);
        const creator = usersConnected[socket.id];
        if (!creator?.username) {
            console.log("   -> Error: Creator not logged in.");
            return socket.emit('error_message', 'Pseudo requis pour créer une table.');
        }
        if (creator.currentTableId) {
             console.log(`   -> Error: Creator ${creator.username} already at table ${creator.currentTableId}.`);
             return socket.emit('error_message', 'Vous êtes déjà à une table.');
        }

        const name = data?.name?.trim() || `${creator.username}'s Table`;
        const sb = parseInt(data?.smallBlind, 10) || 1;
        const bb = parseInt(data?.bigBlind, 10) || 2;

        if (isNaN(sb) || isNaN(bb) || sb <= 0 || bb <= sb) {
            console.log(`   -> Error: Invalid blinds (SB: ${sb}, BB: ${bb}).`);
            return socket.emit('error_message', 'Blinds invalides (SB > 0, BB > SB).');
        }

        const id = uuidv4();
        console.log(`   -> Generating table ID: ${id}`);
        activeTables[id] = {
            id,
            name,
            players: [],
            smallBlind: sb,
            bigBlind: bb,
            status: 'waiting', // waiting, playing, finished
            maxPlayers: MAX_PLAYERS_PER_TABLE,
            deck: [],
            communityCards: [],
            pot: 0,
            dealerSeat: null, // Seat number
            currentTurnSeat: null, // Seat number
            stage: null, // null, dealing, preflop_blinds, preflop_betting, flop_betting, turn_betting, river_betting, showdown
            currentBet: 0, // Montant actuel à suivre
            lastRaiserSeat: null, // Seat number
            creatorUsername: creator.username, // Nom de l'utilisateur créateur
            numActionsThisRound: 0, // Compteur pour gérer la fin des tours d'enchères
            betToCloseRound: null, // Siège du joueur dont l'action fermera le tour d'enchères
            showdownResults: null // { winners: [{username, seat}], winningHandName, winningHandDesc, potWon }
        };
        console.log(`➕ Table '${name}' (ID: ${id}) created by ${creator.username}.`);
        broadcastUpdates(); // Informer tout le monde de la nouvelle table
    });

    // --- Autres Listeners (conservés tels quels, à vérifier/tester) ---
    socket.on('join_table', ({ tableId }) => { /* ... Votre logique existante ... */ });
    socket.on('request_start_game', ({ tableId }) => { /* ... Votre logique existante ... */ });
    socket.on('player_action', (actionData) => { /* ... Votre logique existante complexe ... */ });
    socket.on('leave_table', () => {
        const user = usersConnected[socket.id];
        if (!user || !user.currentTableId) return;
        const tableId = user.currentTableId;
        const table = activeTables[tableId];
        console.log(`🏃 User ${user.username} leaving table ${tableId}`);
        user.currentTableId = null; // Retirer l'utilisateur de la table côté serveur

        if (table) {
            const playerIndex = table.players.findIndex(p => p.socketId === socket.id);
            if (playerIndex !== -1) {
                const leavingPlayer = table.players[playerIndex];
                // Si la partie est en cours, le joueur fold automatiquement
                if (table.status === 'playing' && leavingPlayer.statusInHand !== 'folded' && leavingPlayer.statusInHand !== 'waiting') {
                    leavingPlayer.statusInHand = 'folded';
                    console.log(` -> Auto-folding player ${leavingPlayer.username}`);
                    // !!! IMPORTANT: Il faudrait potentiellement vérifier si c'était son tour
                    // et passer au joueur suivant ici, ou vérifier la fin de main/tour.
                    // Pour simplifier, on va juste broadcast. Une logique plus complexe est nécessaire.
                }
                // Retirer le joueur de la liste
                table.players.splice(playerIndex, 1);
                console.log(` -> Player ${leavingPlayer.username} removed from table array.`);

                // Si la table devient vide, la supprimer
                if (table.players.length === 0) {
                    console.log(` -> Table ${tableId} is empty, deleting.`);
                    delete activeTables[tableId];
                }
                 // Si le créateur quitte et que la partie n'a pas commencé ? Ou si < 2 joueurs ?
                // Ajoutez ici la logique si nécessaire (ex: réassigner créateur, stopper partie...)
            }
        }
        socket.emit('left_table'); // Confirmer au client qu'il a quitté
        broadcastUpdates(); // Mettre à jour tout le monde
    });
    socket.on('chat_message', (data) => {
         const user = usersConnected[socket.id];
         if (user?.username && data?.text) {
            const message = { user: user.username, text: data.text.substring(0, 100) }; // Limiter taille msg
            if(user.currentTableId && activeTables[user.currentTableId]){
                 // Envoyer seulement aux joueurs de la même table
                 activeTables[user.currentTableId].players.forEach(p => {
                     const targetSocket = io.sockets.sockets.get(p.socketId);
                     if(targetSocket) targetSocket.emit('chat_message', message);
                 });
            } else {
                 // Ou envoyer à tout le lobby (si pas de table)
                 // io.emit('chat_message', message); // Attention: spam potentiel
                 socket.emit('chat_message', { system: true, text: "Chat du lobby non implémenté."});
            }
         }
    });
    socket.on('disconnect', () => {
        const user = usersConnected[socket.id];
        console.log(`🔌: User disconnected ${socket.id} ${user ? `(${user.username})` : ''}`);
        if (user && user.currentTableId) {
            // Simuler un 'leave_table' si l'utilisateur était à une table
             const tableId = user.currentTableId;
             const table = activeTables[tableId];
              if (table) {
                const playerIndex = table.players.findIndex(p => p.socketId === socket.id);
                if (playerIndex !== -1) {
                    const leavingPlayer = table.players[playerIndex];
                    if (table.status === 'playing' && leavingPlayer.statusInHand !== 'folded' && leavingPlayer.statusInHand !== 'waiting') {
                       leavingPlayer.statusInHand = 'folded'; // Ou autre logique de départ
                    }
                    table.players.splice(playerIndex, 1);
                     if (table.players.length === 0) {
                        delete activeTables[tableId];
                     }
                }
            }
        }
        delete usersConnected[socket.id]; // Supprimer l'utilisateur de la liste
        broadcastUpdates(); // Mettre à jour tout le monde
    });

}); // Fin io.on('connection')

// --- Démarrage du Serveur ---
// Utilise l'instance httpServer créée à partir de l'app Express
httpServer.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}. Allowing connections from ${allowedOrigin}`);
});
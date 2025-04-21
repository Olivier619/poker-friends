const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const shuffle = require('array-shuffle').default;
const Hand = require('pokersolver').Hand; // Import de Pokersolver

// --- Déclaration de 'app' et configuration de base ---
const app = express(); // <-- IMPORTANT: Déclaré avant d'être utilisé

app.use(cors()); // Utilisez 'app' ici
const server = http.createServer(app); // Utilisez 'app' ici

const io = new Server(server, {
    cors: {
        origin: "http://localhost:3000", // Assurez-vous que cela correspond à l'URL de votre client React
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 4000;

// --- Stockage des états du serveur ---
let usersConnected = {}; // { socket.id: { username: string, currentTableId: string | null } }
let activeTables = {}; // { table.id: { ...table state... } }


// --- Constantes & Fonctions Utilitaires ---
const SUITS=["s","h","d","c"]; // Spades, Hearts, Diamonds, Clubs
// Use Pokersolver's expected ranks including 'T' for 10
const RANKS=["2","3","4","5","6","7","8","9","T","J","Q","K","A"];


const STARTING_STACK = 1000; // Stack de départ pour les nouveaux joueurs
const MIN_PLAYERS_TO_START = 2; // Minimum de joueurs pour démarrer une main


// Crée un nouveau deck de 52 cartes mélangées
const createDeck = () => {
    const d = [];
    for (const s of SUITS) {
        for (const r of RANKS) {
            d.push(r + s); // Format: RankSuit (ex: 'Ah', 'Ts', '2c')
        }
    }
    return shuffle(d); // Mélange le deck
};


// Trouve le siège du prochain joueur à agir dans la main, dans l'ordre des sièges, en bouclant.
// Si requireCanAct est true, cherche seulement les joueurs avec stack > 0 et statusInHand === 'playing'.
// Si requireCanAct est false, cherche tous les joueurs avec statusInHand !== 'folded' et 'waiting' et 'sitting_out' (playing ou all_in).
const findNextPlayerToAct = (table, startSeat, requireCanAct = true) => {
    if (!table || !table.players || table.players.length < 1) return null;

    // Joueurs potentiellement actifs dans la main (pas foldé, pas waiting, pas sitting_out)
    const eligiblePlayers = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
     if (eligiblePlayers.length === 0) return null;

    // Joueurs qui peuvent *faire une action standard* (pas all-in, stack > 0) si requireCanAct est true
    const potentiallyActingPlayers = requireCanAct
        ? eligiblePlayers.filter(p => p.stack > 0.001 && p.statusInHand === 'playing') // Use tolerance for stack 0
        : eligiblePlayers; // Tous ceux qui sont encore dans la main (playing, all_in)

    if (potentiallyActingPlayers.length === 0) {
         // If requireCanAct is true and nobody can bet (all all-in or stack 0),
         // or if requireCanAct is false and nobody is in the hand.
        return null; // Betting round is potentially over (if requireCanAct=true) or hand is over (if requireCanAct=false)
    }


    const seats = potentiallyActingPlayers.map(p => p.seat).sort((a, b) => a - b);
    if (seats.length === 0) return null; // Should not happen if potentiallyActingPlayers.length > 0

    let currentSeat = startSeat;
    // Loop to find the next player, cycling around the table (maxPlayers turns + 1 to ensure wrap-around check)
    for (let i = 0; i < table.maxPlayers + 1; i++) {
        // Move to next seat (1 -> 2 -> ... maxP -> 1)
        currentSeat = (currentSeat % table.maxPlayers) + 1;

        // If the current seat is the starting seat AND we've gone at least one full loop,
        // it means no other players were found after the startSeat. The round is potentially finished.
         if (currentSeat === startSeat && i > 0) {
              return null; // No *next* player found in the cycle after startSeat
         }

        // Find the player at this seat among those who can potentially act
        const nextPlayer = potentiallyActingPlayers.find(p => p.seat === currentSeat);

        if (nextPlayer) {
            // Found the next valid player
            return nextPlayer.seat;
        }
    }

    // If the loop completes without finding (shouldn't happen if potentiallyActingPlayers.length > 0 and no issue with seats),
    // it's an unexpected state.
    console.error(`findNextPlayerToAct failed to find next player from seat ${startSeat}.`);
    return null;
};


// Finds the seat of the first active player post-flop (flop, turn, river).
// This is the first player still in hand (not folded, waiting, sitting_out) to the left of the dealer.
const findFirstToActPostFlop = (table) => {
    if (!table || !table.players || table.dealerSeat === null) return null;

    // Postflop, action starts with the first active player (playing ou all_in) *to the left* of the dealer.
    const playersInHand = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
    if (playersInHand.length === 0) return null;

    let searchSeat = table.dealerSeat;
    for (let i = 0; i < table.maxPlayers; i++) {
        searchSeat = (searchSeat % table.maxPlayers) + 1; // Move to next seat (clockwise)
        const player = playersInHand.find(p => p.seat === searchSeat);
        // The first player in hand (playing or all_in) to the left of the dealer acts first postflop
        if (player) {
            return player.seat;
        }
    }

    console.warn("findFirstToActPostFlop: No player in hand found after dealer. This indicates an issue.");
    // Fallback: return the seat of the first player in hand found (lowest seat number)
     const seats = playersInHand.map(p => p.seat).sort((a, b) => a - b);
     if(seats.length > 0) return seats[0]; // Return the first player in hand if any

    return null; // No player in hand found
}


// Finds the seat of the active player *before* the target player (cyclically). Used to determine who "closes" the round.
// Searches among players who are still "in hand" (playing or all_in).
const findPreviousActivePlayer = (table, targetSeat) => {
    if (!table || !table.players || targetSeat === null) return null;

    // Search among players who are still "in hand" (playing or all_in)
    const playersInHand = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
    if (playersInHand.length < 1) return null;

    // Sort seats to make reverse cyclic search easier
    const seats = playersInHand.map(p => p.seat).sort((a, b) => a - b);
    if (seats.length === 0) return null; // Should not happen if playersInHand.length > 0

    let currentIndex = seats.indexOf(targetSeat);
    if (currentIndex === -1) {
         // Target seat not found in the list of players in hand. This can happen if targetSeat is an empty seat
         // or if the player cible left or folded JUST before the call.
         console.warn(`Target seat ${targetSeat} not found among players in hand for findPreviousActivePlayer.`);
         // In this context, targetSeat is supposed to be currentTurnSeat, so they should always be a player in hand.
         return null;
    }

    // Find the index of the previous player in the sorted list (wrapping around)
    const prevIndex = (currentIndex - 1 + seats.length) % seats.length;
    return seats[prevIndex]; // Return the seat of the previous player
}


// Function to post a bet or blind for a player. Handles stack and pot.
// Uses parseFloat and toFixed(2) to handle decimal precision.
const postBet = (table, player, amount) => {
    // Ensure the amount to post does not exceed player's stack and is non-negative
    const amountToPost = parseFloat(Math.max(0, Math.min(amount, player.stack)).toFixed(2));

    // If amountToPost is 0, it's an implicit check if possible, not a real bet
    if (amountToPost <= 0.001 && amount > 0.001) { // Use tolerance
         // Attempt to post a positive amount (amount > 0) but stack is 0 or negative.
         if (player.stack <= 0.001) { // Use tolerance
              console.warn(` -> ${player.username} (Seat ${player.seat}) stack is ${player.stack}. Cannot post bet amount > 0.`);
              return 0; // Cannot bet if stack is 0
         }
         // Case where amount > 0 but amountToPost <= 0 (float imprecision? Or very small amount)
         console.warn(` -> postBet called with amount ${amount} but amountToPost calculated as ${amountToPost}.`);
         return 0;
    }
    if (amountToPost <= 0.001 && amount <= 0.001) { // Use tolerance
         // Called with 0 or negative, and amountToPost is 0. No real bet.
         return 0;
    }


    player.stack = parseFloat((player.stack - amountToPost).toFixed(2)); // Deduct from stack, rounded
    player.betInStage = parseFloat((player.betInStage + amountToPost).toFixed(2)); // Add to player's bet for this round, rounded
    table.pot = parseFloat((table.pot + amountToPost).toFixed(2)); // Add to total pot, rounded

    console.log(` -> ${player.username} (Seat ${player.seat}) posts ${amountToPost}. New stack: ${player.stack}, Bet in stage: ${player.betInStage}, Total Pot: ${table.pot}`);

    // Mark as all-in if stack reaches 0 (or very close) and they haven't folded or left the hand
    if (player.stack <= 0.001 && player.statusInHand !== 'folded' && player.statusInHand !== 'waiting' && player.statusInHand !== 'sitting_out') {
         player.stack = 0; // Ensure stack is exactly 0 if very close
        player.statusInHand = 'all_in';
        console.log(` -> ${player.username} ALL-IN!`);
    }

    return amountToPost; // Return the amount actually posted
};


// Progresses the game to the next stage (dealing, betting, showdown)
const progressToNextStage = (tableId) => {
    const table = activeTables[tableId];
    if (!table) return;

    console.log(`--- Ending Betting round ${table.stage} ---`);

    // Reset end-of-betting-round variables
    table.players.forEach(p => {
        if(p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out') {
             p.betInStage = 0; // Reset for the next betting round
        }
    });
    table.currentBet = 0; // Reset current bet for the next round
    table.lastRaiserSeat = null; // Reset last raiser
    table.lastRaiseSize = 0; // Reset size of last raise (per round de mise)
    table.currentTurnSeat = null; // Turn is not on anyone during transition
    table.numActionsThisRound = 0; // Reset action count
    table.betToCloseRound = null; // Reset player closing the round


    // Determine the next logical stage and the number of cards to deal
    let nextStage = null;
    let cardsToDeal = 0;

    if (table.stage === 'preflop_betting') {
        cardsToDeal = 3; // Deal Flop
        nextStage = 'flop_betting'; // Next is flop betting
    } else if (table.stage === 'flop_betting') {
        cardsToDeal = 1; // Deal Turn
        nextStage = 'turn_betting'; // Next is turn betting
    } else if (table.stage === 'turn_betting') {
        cardsToDeal = 1; // Deal River
        nextStage = 'river_betting'; // <-- Next is RIVER BETTING
    } else if (table.stage === 'river_betting') {
        nextStage = 'showdown'; // After river betting, it's showdown
    } else {
         console.error(`Progression error: Invalid stage "${table.stage}" to end betting round.`);
         endHand(tableId); // End hand if stage is invalid
         return;
    }

    console.log(`Current stage was ${table.stage}. Calculated next stage: ${nextStage}. Cards to deal: ${cardsToDeal}.`);

    // --- Deal community cards if needed ---
    if (cardsToDeal > 0) {
        table.stage = 'dealing'; // Set an intermediate 'dealing' stage
        broadcastUpdates(); // Broadcast the 'dealing' state

        const needed = cardsToDeal + 1; // Cards to deal + 1 burn card
        if (table.deck.length < needed) {
            console.warn(`Not enough cards (${table.deck.length}) to deal ${cardsToDeal} (+1 burn). Ending hand.`);
            endHand(tableId); // Not enough cards to continue the game
            return;
        }

        table.deck.pop(); // Burn card
        for (let i = 0; i < cardsToDeal; i++) {
            // Ensure deck is not empty (double check)
            if (table.deck.length > 0) {
                table.communityCards.push(table.deck.pop());
            } else {
                 console.error("Deck ran out while dealing community cards!");
                 endHand(tableId); // Force end if dealing fails
                 return;
            }
        }
        console.log(`Dealt ${cardsToDeal} card(s). Community cards: ${table.communityCards.join(',')}.`);

        // After dealing, the stage becomes the calculated next stage (flop_betting, turn_betting, or river_betting)
        table.stage = nextStage;

         // The stage is NOT forced to showdown here after dealing the river.
         // The transition to showdown happens *after* the river_betting round concludes.

    } else {
         // No cards to deal (transition from river_betting betting round end to showdown)
         table.stage = nextStage; // Set stage directly to 'showdown' (should be 'showdown' here)
         console.log(`No cards to deal. Transitioning to ${table.stage}.`);
    }


    // --- Check for immediate showdown if < 2 players can bet ---
    // This check happens *after* setting the new stage.
    // Players who can still bet/raise (playing + stack > 0).
    const playersWhoCanBetCount = table.players.filter(p => p.stack > 0.001 && p.statusInHand === 'playing').length; // Use tolerance
     // Players who are still in hand (playing or all_in) and will see the next cards or the showdown.
     const playersInHandCount = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out').length;


    // If less than 2 players can *bet* in the *current* stage, and it's not already showdown,
    // we skip the betting round and go directly to showdown.
    // This handles scenarios like everyone folding before the river betting round.
     if (playersWhoCanBetCount < 2 && table.stage !== 'showdown') {
         console.log(`<2 players can bet (${playersWhoCanBetCount}) in stage ${table.stage}. Skipping betting round and proceeding to showdown.`);
          // If skipping to showdown, deal any remaining community cards to complete the board.
          while (table.communityCards.length < 5) {
               if (table.deck.length < 2) { console.warn("Not enough cards for runout during skip to showdown."); break; } // Safety check
               table.deck.pop(); // Burn
               table.communityCards.push(table.deck.pop()); // Deal
          }
          console.log(`Community cards completed for forced showdown: ${table.communityCards.join(',')}`);
          table.stage = 'showdown'; // Force stage to showdown
     }

     // If only one player remains in the hand *total* (playing or all-in), the hand ends immediately (by win by default).
     // This check needs to happen *before* setting the turn for the next betting round.
      if (playersInHandCount <= 1 && table.status === 'playing') {
           console.log(`Only ${playersInHandCount} player(s) left in hand. Ending hand immediately.`);
           endHand(tableId); // This will call endHand which handles win by default.
           return; // Stop progression here.
      }

    // --- Commence le prochain tour de mise ou va au showdown ---
    // The table stage has been correctly updated (`flop_betting`, `turn_betting`, `river_betting`, or `showdown`)

    if (table.stage === 'flop_betting' || table.stage === 'turn_betting' || table.stage === 'river_betting') {
        console.log(`--- ${table.stage} Starts ---`);
        // Find the first player to act in this new post-flop betting round.
        // This is the first player *in hand* (not folded/waiting/sitting_out) to the left of the dealer.
        const firstPlayerInHandSeat = findFirstToActPostFlop(table);
         if (firstPlayerInHandSeat === null) {
             console.error(`No player found in hand to start ${table.stage} betting round! Ending hand.`);
             endHand(tableId); // Grave error, no players to continue
             return;
         }

        // Then, find the first player *who can ACT* (status 'playing' and stack > 0) starting from that seat.
        // We use `findNextPlayerToAct` starting from the seat *before* the first player in hand to find the first eligible.
        table.currentTurnSeat = findNextPlayerToAct(table, firstPlayerInHandSeat - 1, true);

         // If even after this search, no one can act (all remaining players in hand are all-in or stack 0),
         // this betting round doesn't happen. We should have ideally already gone to showdown via the playersWhoCanBetCount check.
        if (table.currentTurnSeat === null) {
            console.warn(`No player found who can start the ${table.stage} betting round (all remaining players in hand are all-in/stack 0). Ending betting round and progressing.`);
             // If nobody can bet, this betting round is over. The stage remains what it is (e.g. river_betting) but we must move on.
             // The logic based on `playersWhoCanBetCount < 2` should already have handled this by forcing showdown.
             // If we somehow reach here and stage is NOT showdown, force it now.
              if (table.stage !== 'showdown') {
                   console.warn("Failsafe: Forcing stage to showdown as no player can bet in this stage.");
                    // Deal remaining cards if needed before forced showdown (handled by <2 players check or endHand)
                   while (table.communityCards.length < 5) { // Ensure board is complete
                        if(table.deck.length < 2) { console.warn("Not enough cards for runout during failsafe skip to showdown."); break; } // Safety check
                        table.deck.pop(); table.communityCards.push(table.deck.pop());
                   }
                   console.log(`Community cards completed for failsafe forced showdown: ${table.communityCards.join(',')}`);

                   table.stage = 'showdown'; // Force stage to showdown
              }
             // Now that the stage is 'showdown', the next branch `else if (table.stage === 'showdown')` will be activated.
             endHand(tableId); // Proceed to showdown
             return; // Stop progression here
        }


        // The player who closes the post-flop round is the player *previous* to the first to act (cyclically) among players *in hand*.
        // Use the actual `currentTurnSeat` to find the closer.
        table.betToCloseRound = findPreviousActivePlayer(table, table.currentTurnSeat);
         if (table.betToCloseRound === null && playersInHandCount > 1) { // Only warn if there's more than one player, otherwise null closer is expected
              console.warn(`Could not find betToCloseRound for Seat ${table.currentTurnSeat} with ${playersInHandCount} players in hand.`);
         }


        console.log(`Turn: Seat ${table.currentTurnSeat}. Current Bet: ${table.currentBet}. Last Raise Size: ${table.lastRaiseSize}. Action closes after Seat ${table.betToCloseRound}`);
        broadcastUpdates(); // Broadcast table state with new turn

    } else if (table.stage === 'showdown') {
         console.log("Stage is Showdown. Calling endHand.");
         // Ensure there are 5 community cards before launching endHand (endHand handles if less, but it's better to have them)
         if(table.communityCards.length < 5) {
              console.warn(`Showdown reached with ${table.communityCards.length} community cards! Dealing remaining for showdown logic.`);
              while (table.deck.length > 0 && table.communityCards.length < 5) { // Also check deck length
                   // Need a burn card if this wasn't handled in previous dealing stages before the skip
                   // To be safe, let's burn if deck has > 1 card
                   if (table.deck.length > 1) table.deck.pop();
                   else if (table.deck.length === 1) console.warn("Only one card left for runout, cannot burn.");

                   if (table.deck.length > 0) table.communityCards.push(table.deck.pop());
                   else { console.warn("Deck empty before completing community cards for showdown."); break; }
              }
              console.log(`Community cards completed for showdown: ${table.communityCards.join(',')}`);
         }
         endHand(tableId); // Call the end hand function to handle showdown and payment
         return; // Stop progression here

    } else if (table.stage === 'dealing' || table.stage === 'preflop_blinds' || table.stage === 'showdown_complete') {
        // These are intermediate stages that should not trigger this function or where progression is handled elsewhere.
        // If we arrive here, it's a logic error in calls or transitions.
        console.error(`progressToNextStage called but table is in unexpected intermediate stage "${table.stage}".`);
        // As a fallback, if the hand is ongoing, force the end to prevent a block.
        if(table.status === 'playing') {
             console.warn("Table seems stuck in an intermediate stage after betting round. Forcing hand end.");
             endHand(tableId);
        } else {
             // If not in playing mode, just broadcast the current state.
              broadcastUpdates();
        }

    } else {
         // This else should catch any unhandled stage.
         console.error(`progressToNextStage: Reached unexpected stage "${table.stage}". Forcing hand end.`);
          endHand(tableId);
    }
};


// Terminates a poker hand, determines the winner(s), distributes the pot(s), manages showdown reveal, and prepares the table for the hand suivante.
const endHand = (tableId) => {
    const table = activeTables[tableId];
    if (!table) return;
    console.log(`--- Hand Ending ${table.name} --- Pot: ${table.pot}`);

    // Players who reached showdown: not folded, waiting, or sitting_out, and were dealt hole cards.
    // These are the players whose hands MIGHT be shown.
    const showdownPlayers = table.players.filter(p =>
         p.statusInHand !== 'folded' &&
         p.statusInHand !== 'waiting' &&
         p.statusInHand !== 'sitting_out' &&
         p.holeCards?.length === 2 // Only players dealt in can reach showdown
    );

    let winners = []; // Array of player objects who won
    let winningHandData = null; // Details of the winning hand (name, desc, rank)
    let totalPotAmount = table.pot; // Capture the pot total before distribution


    if (showdownPlayers.length <= 1) {
        // Hand ends with 1 or 0 players remaining in contention (not folded, etc.)
        // This usually happens because everyone else folded. The last remaining player wins the pot without a showdown.
        if (showdownPlayers.length === 1) {
            winners.push(showdownPlayers[0]); // The single player remaining is the winner
            console.log(`Winner by default: ${winners[0].username} (Seat ${winners[0].seat})`);

            table.showdownResults = {
                 // Only the winner by default is listed
                 orderedShowdown: [{
                      username: winners[0].username,
                      seat: winners[0].seat,
                      holeCards: winners[0].holeCards, // Include hole cards for win by default reveal
                      hand: null, // No hand evaluated by solver in win-by-default
                      show: true, // They implicitly show their hand (optional in real poker, but clear here)
                      isWinner: true, // Mark them as winner
                      winningHandName: "Wins by default", // Indicate the reason for the win
                      winningHandDesc: "All other players folded"
                 }],
                 winners: [{ username: winners[0].username, seat: winners[0].seat }], // Simplified winners list
                 winningHandName: "Wins by default",
                 winningHandDesc: "All other players folded",
                 potWon: totalPotAmount // The whole pot goes to this player
            };
            // Award the pot
            winners[0].stack = parseFloat((winners[0].stack + totalPotAmount).toFixed(2)); // Add pot to stack, rounded
            table.pot = 0; // Pot is emptied

        } else { // showdownPlayers.length === 0
             console.error("No eligible players at end of hand? Pot not awarded.");
             // If no one is eligible (e.g., everyone folded), the pot is not distributed.
             table.showdownResults = { orderedShowdown: [], winners: [], winningHandName: "No eligible players", winningHandDesc: "", potWon: 0 };
             table.pot = 0; // Pot lost?
        }

    } else {
        // --- Showdown with multiple players! ---
        console.log(`Showdown with ${showdownPlayers.length} players!`);
        // Ensure there are 5 community cards for the solver
        const communityCards = table.communityCards || [];
        if (communityCards.length !== 5) {
            // This shouldn't happen with correct progression, but as a safeguard
            console.error(`Showdown attempted with ${communityCards.length} community cards! Cannot determine winner.`);
            console.warn("Pot not awarded due to incomplete community cards at showdown.");
            winners = [];
             table.showdownResults = { orderedShowdown: [], winners: [], winningHandName: "Showdown error (incomplete board)", winningHandDesc: "", potWon: 0 };
            table.pot = 0;

        } else {
            // --- Solve Hands for all Showdown Players ---
            let contenders = []; // Array of { player: playerObject, hand: pokersolverHandObject }
            showdownPlayers.forEach(player => {
                 // Verify player has hole cards (already filtered, but safety)
                if (player.holeCards?.length === 2) {
                    // Use player cards directly (format 'Ts' is correct for Pokersolver)
                    const playerCards = player.holeCards;
                    const sevenCardsInput = communityCards.concat(playerCards); // The 7 cards to pass to solver

                    try {
                         // Solve the best 5-card hand using the 7 cards
                         console.log(`Solving hand for ${player.username} (S${player.seat}) with cards: [${sevenCardsInput.join(',')}]`); // Log INPUT cards
                        const hand = Hand.solve(sevenCardsInput);
                         // Ensure hand object has a UUID for reliable comparison later if needed
                         if (!hand.uuid) hand.uuid = uuidv4(); // Add UUID if missing (Pokersolver should add it)

                         // Log details including the 5 best cards (hand.cards) and rank from Pokersolver result
                        console.log(` -> ${player.username} (S${player.seat}) Hand Result: ${hand.name} (Rank ${hand.rank}) (${hand.description || 'No description'}) -> Best 5: [${hand.cards.join(',')}]`);
                        contenders.push({ player: player, hand: hand });
                    } catch (e) {
                        console.error(`Error solving hand for ${player.username} (Seat ${player.seat}):`, e);
                        // If a hand cannot be solved, that player is excluded from contenders.
                    }
                } else {
                     console.warn(` -> ${player.username} (Seat ${player.seat}) is eligible but has no hole cards for showdown.`);
                     // This player will not be included in 'contenders'.
                }
            });

            // --- Determine Winner(s) based on solved hands ---
            let winningHands = [];
            if (contenders.length > 0) {
                 const allContenderHands = contenders.map(c => c.hand).filter(hand => hand !== null); // Filter out null hands from solver errors
                 try {
                     if (allContenderHands.length > 0) {
                         winningHands = Hand.winners(allContenderHands); // Find the winning hand(s)
                     } else {
                          console.warn("No valid hands submitted to Hand.winners after solving.");
                     }
                 } catch (e) {
                     console.error("Error determining winners with Pokersolver:", e);
                      console.warn("Pokersolver error in finding winners. Pot not awarded correctly.");
                      // Clear winners if solver fails here
                      winningHands = [];
                 }
            } else {
                 console.warn("No valid contenders with solvable hands for showdown.");
                 // No contenders means no one to find winners from. Winners list is empty.
            }


            if (winningHands?.length > 0) {
                 // Get the winning rank and details from the first winning hand
                 const winningRank = winningHands[0].rank;
                 winningHandData = {
                     name: winningHands[0].name,
                     desc: winningHands[0].description || 'No description',
                     rank: winningRank
                 };
                 console.log(`Winning Hand: ${winningHandData.name} (Rank ${winningRank})`);

                 // Identify winning player(s) by matching their hand's rank to the winning rank
                 // Use contenders list, as it maps player objects to solved hands.
                 winners = contenders.filter(c => c.hand?.rank === winningRank).map(c => c.player); // Check c.hand existence
                 console.log(`Winner(s): ${winners.map(w => `${w.username} (Seat ${w.seat})`).join(', ')}`);

            } else {
                console.warn("No winners found via Pokersolver (winningHands array was empty).");
                winners = []; // Ensure winners list is empty if solver returned no winners
            }

            // --- Determine Showdown Reveal Order ---
            // The reveal order is: Last raiser, then clockwise around the table for all players who are still in the hand (showdownPlayers).
            let orderedShowdownPlayersList = []; // Array to store players in reveal order (simple player objects initially)
            const playersInHandSeats = showdownPlayers.map(p => p.seat); // Seats of players still in hand

            // Find the seat to start the reveal order
            let startRevealSeat = null;
            // 1. Start with the last raiser if they are still in hand
            if (table.lastRaiserSeat !== null && playersInHandSeats.includes(table.lastRaiserSeat)) {
                 startRevealSeat = table.lastRaiserSeat;
                 console.log(`Showdown reveal starts with last raiser: Seat ${startRevealSeat}`);
            } else {
                 // 2. If no last raiser, or last raiser folded/left, start with the first player in hand after the dealer (post-flop first-to-act order)
                 const firstPostFlopSeat = findFirstToActPostFlop(table); // This finds the first player *in hand* after the dealer
                  if (firstPostFlopSeat !== null && playersInHandSeats.includes(firstPostFlopSeat)) { // Ensure this player is still in showdownPlayers
                      startRevealSeat = firstPostFlopSeat;
                      console.log(`Showdown reveal starts with first player in hand after dealer: Seat ${startRevealSeat}`);
                  } else {
                       // 3. If somehow no players in hand after dealer, or that player isn't in showdownPlayers,
                       // just start with the lowest seat number among players in hand.
                        if (playersInHandSeats.length > 0) {
                            startRevealSeat = playersInHandSeats.sort((a, b) => a.seat - b.seat)[0];
                             console.log(`Showdown reveal starts with lowest seat number: Seat ${startRevealSeat}`);
                        } else {
                             // Should not happen if showdownPlayers.length > 1, but safety
                             console.error("No seat found to start showdown reveal order.");
                             // Fallback: if showdownPlayers is not empty, take the first one. If empty, startRevealSeat remains null.
                             startRevealSeat = showdownPlayers.length > 0 ? showdownPlayers[0].seat : null;
                        }
                  }
            }


            // Populate the orderedShowdownPlayersList by iterating clockwise from the startRevealSeat
            if (startRevealSeat !== null) {
                 let currentSeat = startRevealSeat;
                 let playersAddedCount = 0;

                 // Add players in clockwise order starting from startRevealSeat
                 // Iterate through all possible seats (up to maxPlayers to prevent infinite loops in edge cases)
                 for (let i = 0; i < table.maxPlayers && playersAddedCount < showdownPlayers.length; i++) {
                     // Find the player at the current seat who is still in the showdownPlayers list
                     const playerToAdd = showdownPlayers.find(p => p.seat === currentSeat);

                     // If a player is found at this seat AND they haven't been added to the ordered list yet
                     if (playerToAdd && !orderedShowdownPlayersList.find(p => p.seat === playerToAdd.seat)) {
                         orderedShowdownPlayersList.push(playerToAdd);
                         playersAddedCount++;
                     }

                     // Move to the next seat for the next iteration
                     currentSeat = (currentSeat % table.maxPlayers) + 1;

                 }
                 console.log("Showdown reveal order determined:", orderedShowdownPlayersList.map(p => `${p.username}(S${p.seat})`).join(' -> '));

            } else {
                 // Fallback: If no start reveal seat found (e.g., 0 players?), just use the default seat order
                 console.warn("Could not determine complex showdown reveal order. Using default seat order.");
                 orderedShowdownPlayersList = [...showdownPlayers].sort((a, b) => a.seat - b.seat);
            }


            // --- Prepare Showdown Results with Reveal Status ---
            // Create the detailed list including solved hand and show/muck status
            let playersShowdownData = []; // Array to send to client with detailed info

            // Track the rank of the best hand *revealed* so far.
            // A player only *has* to show if their hand is currently the best *shown*.
            // The last raiser always shows first (if in showdown).
            // After that, players show in order IF their hand is better than or equal to the current best hand *that has already been shown*.

            let currentBestHandShownRank = -1; // Initialize with a rank lower than any possible hand (-1 ensures any valid hand > -1)


            // Iterate through players in the determined reveal order
            for (const player of orderedShowdownPlayersList) {
                 const playerContender = contenders.find(c => c.player.seat === player.seat); // Find their solved hand data
                 const playerHand = playerContender?.hand || null; // Get the solved hand object (null if solver failed)
                 const isWinner = winners.some(w => w.seat === player.seat); // Check if this player is a winner (based on overall winners list)
                 const isLastRaiser = table.lastRaiserSeat === player.seat; // Check if this player was the last raiser

                 let shouldShow = false; // Default: muck
                 let muckReason = null; // Reason if mucked

                 if (!playerHand) {
                      // If solver failed for this player, they automatically muck.
                      shouldShow = false;
                      muckReason = "Hand could not be evaluated";
                      console.log(`${player.username} (S${player.seat}) mucks because hand could not be solved.`);

                 } else if (isLastRaiser) {
                      // The player who made the last aggressive action MUST show their hand first if they reached showdown.
                      shouldShow = true;
                      console.log(`${player.username} (S${player.seat}) shows (Last Raiser). Hand Rank: ${playerHand.rank}`);
                       // Update the current best hand shown rank
                      if (playerHand.rank > currentBestHandShownRank) {
                           currentBestHandShownRank = playerHand.rank;
                           console.log(`New best hand shown is rank ${currentBestHandShownRank}.`);
                      }

                 } else if (playerHand.rank >= currentBestHandShownRank) {
                      // Any subsequent player MUST show if their hand is EQUAL TO or BETTER than the best hand *already shown*.
                      // This includes winners (who will have a rank >= winningRank).
                      shouldShow = true;
                      console.log(`${player.username} (S${player.seat}) shows because hand rank ${playerHand.rank} >= currentBestShownRank ${currentBestHandShownRank}.`);
                       // Update the current best hand shown rank if this hand is STRICTLY better
                      if (playerHand.rank > currentBestHandShownRank) {
                           currentBestHandShownRank = playerHand.rank;
                           console.log(`New best hand shown is rank ${currentBestHandShownRank}.`);
                      }

                 } else {
                      // Their hand is strictly worse than the current best hand *shown*. They have the option to muck.
                      // In simulation, we assume they muck if not required to show (not last raiser, and not beating current best shown).
                      shouldShow = false;
                      muckReason = `Worse than shown hand (Rank ${playerHand.rank} < Shown Rank ${currentBestHandShownRank})`;
                      console.log(`${player.username} (S${player.seat}) mucks (not last raiser, hand rank ${playerHand.rank} < currentBestShownRank ${currentBestHandShownRank}).`);
                 }


                 playersShowdownData.push({
                      username: player.username,
                      seat: player.seat,
                      holeCards: player.holeCards, // Always include hole cards in server state
                      hand: playerHand ? { // Include hand details only if solved
                           name: playerHand.name,
                           desc: playerHand.description || 'No description',
                           rank: playerHand.rank,
                           cards: playerHand.cards, // The 5 best cards used
                           cardPool: playerHand.cardPool // The 7 input cards (for debugging if needed)
                      } : null, // Hand is null if solver failed or player not in contenders (shouldn't happen for showdownPlayers)
                      show: shouldShow, // Boolean: true if hand is revealed
                      isWinner: isWinner, // Boolean: true if this player is a winner (based on overall winners list)
                      muckReason: muckReason // String: reason for mucking (optional)
                 });
            }


            // Store the detailed showdown results in table state
            table.showdownResults = {
                 orderedShowdown: playersShowdownData, // Ordered list of players and their show/muck status
                 winners: winners.map(w => ({ username: w.username, seat: w.seat })), // Simplified winners list (for quick client check)
                 winningHandName: winningHandData ? winningHandData.name : "N/A",
                 winningHandDesc: winningHandData ? winningHandData.desc : "N/A",
                 potWon: 0 // Placeholder, updated after distribution
            };

        } // End if (communityCards.length === 5)
    } // End else (showdownPlayers.length > 1)


    // --- Pot Distribution ---
    // Simple distribution of the total pot to the winners. Does NOT handle side pots.
    let totalPotAwarded = 0;
    if (winners.length > 0 && table.pot > 0.001) { // Only distribute if there are winners AND pot > 0 (tolerance)
        // Divide the total pot into equal shares, rounded to 2 decimal places.
        // Use toFixed(2) to get a string with 2 decimals, then parseFloat to convert back to a number.
        const potShare = parseFloat((table.pot / winners.length).toFixed(2));

        winners.forEach(winner => {
            console.log(` -> Awarding ${potShare} to ${winner.username} (Seat ${winner.seat})`);
            // Add the share to the stack, rounding to 2 decimal places.
            winner.stack = parseFloat((winner.stack + potShare).toFixed(2));
            totalPotAwarded = parseFloat((totalPotAwarded + potShare).toFixed(2));
        });

        // Calculate any remainder pot after distribution (due to float division)
         const remainder = parseFloat((table.pot - totalPotAwarded).toFixed(2));

         // If a small positive remainder exists, add it to the first winner (convention)
         if (remainder > 0.001 && winners.length > 0) { // Use a small tolerance
              console.log(` -> Distributing remainder ${remainder} to first winner ${winners[0].username}.`);
               winners[0].stack = parseFloat((winners[0].stack + remainder).toFixed(2));
               totalPotAwarded = parseFloat((totalPotAwarded + remainder).toFixed(2));
         } else if (remainder < -0.001) {
              console.warn(`Calculated significant negative remainder: ${remainder}. This suggests a floating point issue during pot distribution.`);
         }


        // Update the remaining pot on the table (should be 0 or very close)
        table.pot = parseFloat((table.pot - totalPotAwarded).toFixed(2));
         if(table.pot > 0.001 || table.pot < -0.001) console.warn(` -> Pot remainder > 0.001 after award: ${table.pot}`); // Log if a significant remainder


        // Update the total amount won in the showdown results
        if (table.showdownResults) {
            table.showdownResults.potWon = totalPotAwarded;
        }

    } else if (table.pot > 0.001) {
         console.warn(`Pot (${table.pot}) remains but no winners found or pot could not be awarded.`);
         table.pot = 0; // Pot lost if no winners or error
          if (table.showdownResults) table.showdownResults.potWon = 0;
    } else {
         console.log("Pot was 0 or negative (or very small). No distribution needed.");
          if (table.showdownResults) table.showdownResults.potWon = 0;
    }

     // Ensure the pot is 0 at the end (or very close)
    table.pot = 0;


    // --- Final Hand State Cleanup ---
    table.status = 'finished'; // Indicates the hand is over, ready for a new hand
    table.stage = 'showdown_complete'; // New stage to mark the end state after showdown reveal/payment
    table.currentTurnSeat = null; // No active turn

    // Reset player status and clear hand data for the next hand
    table.players.forEach(p => {
         // If stack is 0 (or very close), mark as sitting out for the next hand
         if (p.stack <= 0.001) {
              p.stack = 0; // Ensure exactly 0
             p.statusInHand = 'sitting_out';
         } else if (p.statusInHand !== 'waiting' && p.statusInHand !== 'folded' && p.statusInHand !== 'sitting_out') {
             // Players with stack > 0 who were in the hand redeviennent 'waiting' for the next hand
             p.statusInHand = 'waiting';
         }
         // Players who fold or were already sitting_out keep that status until startNewHand resets them to playing/sitting_out based on stack.

         p.holeCards = []; // Clear hole cards at the end of the hand for privacy/next hand
         p.betInStage = 0; // Clear any remaining bet in stage (should be 0 already)
    });

     console.log(`--- Hand Ended. Table status: ${table.status}, Stage: ${table.stage} ---`);

    // Broadcast updates. Player stacks now reflect winnings, showdown results are available.
    broadcastUpdates();
};


// Initialise les blindes et démarre le premier tour de mise pré-flop
const setupBlindsAndStartBetting = (tableId) => {
    const table = activeTables[tableId];
    // Vérifie si la table est dans l'état correct pour configurer les blindes
    if (!table || table.status !== 'playing' || table.stage !== 'preflop_blinds') {
         console.warn(`setupBlindsAndStartBetting called for table ${tableId} in unexpected state (status: ${table?.status}, stage: ${table?.stage}). Aborting.`);
         return;
    }

    console.log(`Setting Blinds for table ${table.name} (ID: ${table.id})`);

    // Joueurs éligibles pour poster les blindes ou jouer dans cette main (stack > 0 et status 'playing')
    // Le statut 'playing' est assigné dans startNewHand pour ceux qui ont stack > 0.
    const playersReadyForHand = table.players.filter(p => p.stack > 0.001 && p.statusInHand === 'playing'); // Use tolerance


     // Si moins de MIN_PLAYERS_TO_START joueurs sont prêts, la main ne peut pas commencer.
     if(playersReadyForHand.length < MIN_PLAYERS_TO_START) {
          console.warn(`Not enough players ready for hand (${playersReadyForHand.length}/${MIN_PLAYERS_TO_START}). Returning table to waiting state.`);
           // Remettre la table en attente
          table.status = 'waiting';
          table.stage = null; // Pas de stage actif
          // Réinitialiser les joueurs au statut 'waiting' s'ils ont des jetons (ceux avec stack 0 sont sitting_out)
          table.players.forEach(p => { if(p.stack > 0.001) p.statusInHand = 'waiting'; }); // Use tolerance
           // Inform the creator (if present and still connected)
           const creatorSocketId = Object.keys(usersConnected).find(sid => usersConnected[sid].username === table.creatorUsername && usersConnected[sid].currentTableId === tableId);
            if (creatorSocketId) {
                 io.to(creatorSocketId).emit('error_message', `Impossible de démarrer la main. Il faut au moins ${MIN_PLAYERS_TO_START} joueurs avec des jetons.`);
            }

          broadcastUpdates();
          return;
     }

    let sbSeat, bbSeat, firstToActSeat;
    table.pot = 0; // Réinitialise le pot pour la nouvelle main
    table.currentBet = 0; // Réinitialise la mise courante
    table.lastRaiserSeat = null; // Réinitialise le dernier relanceur
    table.lastRaiseSize = 0; // <-- Initialize lastRaiseSize at the start of the hand

    // Reset betInStage for all players (even those who folded or sit out in previous hand)
    table.players.forEach(p => p.betInStage = 0);


    // Find the blind seats among players who are 'playing' or 'all_in' (are in the hand)
    // Find the next player 'playing' or 'all_in' after the dealer for SB.
    const playersInHandForBlinds = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
     if (playersInHandForBlinds.length === 0) {
          console.error("No players in hand to assign blinds! Ending Hand.");
           endHand(tableId); // If no players in hand, cannot post blinds, hand ends.
          return;
     }

    const dealerSeat = table.dealerSeat;

    // Find the next player *en main* après la SB pour la BB.
    sbSeat = findNextPlayerToAct(table, dealerSeat, false);
    bbSeat = findNextPlayerToAct(table, sbSeat, false);


    if (!sbSeat || !bbSeat || sbSeat === bbSeat) {
         console.error(`Could not determine blind seats properly! SB: ${sbSeat}, BB: ${bbSeat}. Ending Hand.`);
          endHand(tableId); // If blinds cannot be determined, hand ends.
         return;
    }

    const sbPlayer = table.players.find(p => p.seat === sbSeat);
    const bbPlayer = table.players.find(p => p.seat === bbSeat);

     // Verify players exist (should be in playersInHandForBlinds if seats found)
     if (!sbPlayer || !bbPlayer) {
          console.error(`Could not find player object for blind seats! SB:${sbSeat}, BB:${bbSeat}. Ending Hand.`);
           endHand(tableId);
          return;
     }


    // Post Small Blind
     let actualSBPosted = 0;
     // Only post if the player has stack > 0 (tolerance)
     if (sbPlayer.stack > 0.001) {
          actualSBPosted = postBet(table, sbPlayer, table.smallBlind);
          io.to(table.id).emit('chat_message', { user: sbPlayer.username, text: `posts SB ${actualSBPosted}` });
          console.log(`${sbPlayer.username} (Seat ${sbSeat}) posts Small Blind ${actualSBPosted}`);
     } else {
          console.log(`${sbPlayer.username} (Seat ${sbSeat}) has stack ${sbPlayer.stack}. Cannot post SB.`);
          sbPlayer.statusInHand = 'all_in'; // Mark as all-in if stack is 0
     }


     // Post Big Blind
     let actualBBPosted = 0;
     if (bbPlayer.stack > 0.001) { // Use tolerance
          actualBBPosted = postBet(table, bbPlayer, table.bigBlind);
          io.to(table.id).emit('chat_message', { user: bbPlayer.username, text: `posts BB ${actualBBPosted}` });
          console.log(`${bbPlayer.username} (Seat ${bbSeat}) posts Big Blind ${actualBBPosted}`);

          // The current bet is the amount of the Big Blind posted
          table.currentBet = actualBBPosted;
          // The BB is considered the initial "raiser" that sets the amount to call/raise
          table.lastRaiserSeat = bbSeat;
          // The size of the initial "raise" is the amount of the BB itself (for determining min size of future raises)
          table.lastRaiseSize = actualBBPosted;

     } else {
          console.log(`${bbPlayer.username} (Seat ${bbSeat}) has stack ${bbPlayer.stack}. Cannot post BB.`);
           bbPlayer.statusInHand = 'all_in'; // Mark as all-in if stack is 0
          // If BB cannot post, set currentBet to SB amount if SB was posted, otherwise 0.
           if (actualBBPosted < table.bigBlind - 0.001) { // Use tolerance - This happens if BB stack < table.bigBlind
                console.log(`BB stack ${bbPlayer.stack} < BB amount ${table.bigBlind}. BB is all-in for ${actualBBPosted}.`);
                table.currentBet = actualBBPosted; // Current bet is the amount BB was all-in for
                table.lastRaiserSeat = bbSeat; // BB is the last raiser for this amount
                table.lastRaiseSize = actualBBPosted; // Size of the initial bet is the BB all-in amount
           }
           // If BB stack was 0, actualBBPosted is 0. Current bet becomes SB amount if SB was posted.
           // This case is already handled above if actualBBPosted < table.bigBlind. Redundant check below.
           /*
           if (bbPlayer.stack <= 0.001) {
                if (actualSBPosted > 0.001) {
                    table.currentBet = actualSBPosted;
                     table.lastRaiserSeat = sbSeat;
                     table.lastRaiseSize = actualSBPosted;
                     console.log(`BB stack 0. Current bet set to SB (${actualSBPosted}). Last raiser: Seat ${sbSeat}. Last raise size: ${actualSBPosted}.`);
                } else {
                     table.currentBet = 0; // No blinds posted effectively
                     table.lastRaiserSeat = null;
                     table.lastRaiseSize = 0;
                     console.log(`BB stack 0 and SB stack 0 or SB post 0. Current bet 0.`);
                }
           }
           */

     }


    // Find the first player to act pre-flop
    // This is the first player *who can ACT* (stack > 0, status 'playing') to the left of the BB.
    firstToActSeat = findNextPlayerToAct(table, bbSeat, true);

     // In heads-up (only 2 players with stack > 0 and status 'playing'), the dealer/SB acts first pre-flop.
     const playersReadyAndPlayingCount = table.players.filter(p => p.stack > 0.001 && p.statusInHand === 'playing').length; // Use tolerance
     const sbPlayerInHand = playersInHandForBlinds.find(p => p.seat === sbSeat); // Check if SB is in hand at all
     if (playersReadyAndPlayingCount === 2 && sbPlayerInHand?.statusInHand === 'playing' && sbPlayerInHand.stack > 0.001) { // Use tolerance
         // If the dealer is also the SB (which is the case in heads-up), the first to act is the dealer/SB.
         // Verify that SB is present, in hand, playing, and has stack > 0 to actually make an action.
          firstToActSeat = sbSeat;
          console.log(`Heads-up detected (${playersReadyAndPlayingCount} players playing). SB (Seat ${sbSeat}) acts first pre-flop.`);

     }


    if (!firstToActSeat) {
         console.error("Could not determine first to act seat for pre-flop betting! No player can act. Ending hand.");
         // If no player can act after blinds (everyone is all-in or stack 0), the hand ends immediately.
          endHand(tableId); // Hand ends (pot split among all-ins? Or collected? Simplified endHand handles this)
          return;
    }

    table.currentTurnSeat = firstToActSeat; // Assign the turn to the first player
    table.stage = 'preflop_betting'; // Transition to pre-flop betting stage
    table.numActionsThisRound = 0; // Reset action count for the new betting round

    // Who closes the pre-flop round? It's the player *before* the first to act (cyclically) among players *in hand*.
    table.betToCloseRound = findPreviousActivePlayer(table, table.currentTurnSeat);
     if (table.betToCloseRound === null && playersInHandForBlinds.length > 1) { // Only warn if there's more than one player, otherwise null closer is expected
          console.warn(`Could not find betToCloseRound for Seat ${table.currentTurnSeat} with ${playersInHandForBlinds.length} players in hand.`);
          // This is unusual, might indicate an issue with findPreviousActivePlayer or player states.
     } else if (playersInHandForBlinds.length <= 1) {
          // If only 1 player in hand, betToCloseRound logic is moot, hand should have ended.
          console.log(`Only ${playersInHandForBlinds.length} players in hand. BetToCloseRound is null.`);
     }


    console.log(`Preflop Betting Starts. Turn: Seat ${table.currentTurnSeat}. Current Bet: ${table.currentBet}. Last Raise Size: ${table.lastRaiseSize}. Action closes after Seat ${table.betToCloseRound}`);

    broadcastUpdates(); // Broadcast table state
};


// Starts a new poker hand on the specified table.
const startNewHand = (tableId) => {
    const table = activeTables[tableId];
    // Count players with stack > 0 (eligible for the hand)
    const eligiblePlayersCount = table?.players.filter(p => p.stack > 0.001).length ?? 0; // Use tolerance


    // A new hand starts if:
    // - The table exists
    // - There are at least MIN_PLAYERS_TO_START eligible players
    // - The table is in 'waiting' or 'finished' status
    if(!table || eligiblePlayersCount < MIN_PLAYERS_TO_START || (table.status !== 'waiting' && table.status !== 'finished')) {
         const reason = !table ? "Table not found" :
                        eligiblePlayersCount < MIN_PLAYERS_TO_START ? `Not enough eligible players (${eligiblePlayersCount}/${MIN_PLAYERS_TO_START})` :
                        `Wrong table status (${table.status})`;
         console.log(`Cannot start new hand for table ${tableId}. Reason: ${reason}`);
         // Inform the creator if they tried to start when not possible?
         const creatorSocketId = Object.keys(usersConnected).find(sid => usersConnected[sid].username === table?.creatorUsername && usersConnected[sid].currentTableId === tableId);
         if (creatorSocketId) {
              io.to(creatorSocketId).emit('error_message', `Impossible de démarrer la partie. ${reason}`);
         }
         return;
    }

    console.log(`Starting new hand for ${table.name} (ID: ${table.id})`);

    // Set table status to 'playing' and initial stage to 'dealing'
    table.status = 'playing';
    table.stage = 'dealing'; // Initial stage is dealing

    // Reset hand variables
    table.pot = 0;
    table.communityCards = [];
    table.deck = createDeck(); // Create and shuffle a new deck
    table.currentBet = 0;
    table.lastRaiserSeat = null;
    table.lastRaiseSize = 0;
    table.betToCloseRound = null;
    table.numActionsThisRound = 0;
    table.showdownResults = null; // Reset showdown results from the previous hand


    // Prepare players for the new hand
    const playersForHand = []; // List of players who will be dealt cards (stack > 0)
    table.players.forEach(p => {
        p.holeCards = []; // Reset hole cards
        p.betInStage = 0; // Reset bet in stage
        // If player has chips, they participate in the hand ('playing'), otherwise they are 'sitting_out'
        p.statusInHand = (p.stack > 0.001) ? 'playing' : 'sitting_out'; // Use tolerance
        if (p.statusInHand === 'playing') {
             playersForHand.push(p); // Add to the list for dealing
        } else {
             console.log(`${p.username} (Seat ${p.seat}) is sitting out this hand (Stack: ${p.stack}).`);
        }
    });

     // Check if enough 'playing' players to start the hand after updating statuses
     if (playersForHand.length < MIN_PLAYERS_TO_START) {
          console.warn(`Not enough 'playing' players after status update (${playersForHand.length}/${MIN_PLAYERS_TO_START}). Returning table to waiting state.`);
          table.status = 'waiting'; table.stage = null; broadcastUpdates();
           const creatorSocketId = Object.keys(usersConnected).find(sid => usersConnected[sid].username === table.creatorUsername && usersConnected[sid].currentTableId === tableId);
            if (creatorSocketId) {
                 io.to(creatorSocketId).emit('error_message', `Impossible de démarrer la main. Il faut au moins ${MIN_PLAYERS_TO_START} joueurs avec des jetons.`);
            }
          return;
     }


    // Deal hole cards (2 per 'playing' player)
    // Check if enough cards in deck
    if (table.deck.length < playersForHand.length * 2) {
        console.error(`Not enough cards in deck (${table.deck.length}) to deal ${playersForHand.length * 2} hole cards! Ending hand.`);
        endHand(tableId); // Cannot start hand if dealing fails
        return;
    }
    for(let i=0; i<2; i++){
        for(const p of playersForHand){
            // Ensure deck is not empty (double check)
            if (table.deck.length > 0) {
                p.holeCards.push(table.deck.pop());
            } else {
                console.error("Deck ran out during hole card dealing!");
                 endHand(tableId); // Force end if dealing fails
                 return;
            }
        }
    }
    console.log(`Hole cards dealt to ${playersForHand.length} players.`);


    // Rotate the dealer button
    // The next dealer is the first 'playing' player after the previous dealer (cyclically)
    // We search among players who *will play* this hand (statusInHand === 'playing').
    const playersForDealerSelection = table.players.filter(p => p.statusInHand === 'playing');

    if (playersForDealerSelection.length === 0) {
         console.error("No 'playing' players to select dealer from. This should not happen if startNewHand was called.");
         table.dealerSeat = null; // No dealer if nobody is playing
    } else {
        // If it's the very first hand (dealerSeat is null or 0), choose the player with the lowest seat number among those who are playing.
        // Also reset if the previous dealer is no longer playing this hand.
        if (table.dealerSeat === null || table.dealerSeat === 0 || !playersForDealerSelection.find(p => p.seat === table.dealerSeat)) {
             console.log("Selecting first dealer (table start or previous dealer not playing this hand).");
             // Sort by seat to find the first
             table.dealerSeat = playersForDealerSelection.sort((a, b) => a.seat - b.seat)[0].seat;
             console.log(`Initial dealer selected: Seat ${table.dealerSeat}`);
         } else {
             // The previous dealer was a player who is still participating in this hand ('playing').
              const previousDealerSeat = table.dealerSeat;
              // Find the next 'playing' player after the previous dealer.
              let nextDealerCandidateSeat = previousDealerSeat;
              let foundNextDealer = false;
              // Loop through seats to find the next 'playing' player
              for(let i = 0; i < table.maxPlayers; i++) { // Loop over maxPlayers seats
                  nextDealerCandidateSeat = (nextDealerCandidateSeat % table.maxPlayers) + 1; // Next seat number
                  const candidatePlayer = playersForDealerSelection.find(p => p.seat === nextDealerCandidateSeat);
                  if (candidatePlayer) {
                      table.dealerSeat = candidatePlayer.seat;
                      foundNextDealer = true;
                      break; // Found the next dealer
                  }
              }
              if (!foundNextDealer) {
                   // This case means the only 'playing' player was the old dealer. Keep them as dealer.
                   // console.warn("Could not find next 'playing' player for dealer seat! Keeping previous dealer."); // Too chatty
                   // table.dealerSeat remains the same (previousDealerSeat)
              }
              console.log(`Dealer moved to: Seat ${table.dealerSeat}`);
         }
    }


    // Transition to the blinds stage to start pre-flop betting
    table.stage = 'preflop_blinds'; // Transition to an intermediate stage to post blinds
    setupBlindsAndStartBetting(tableId); // Call the function to post blinds and start the betting round
};


// Finds the first available seat at the table
const findAvailableSeat = (table) => {
    const occupiedSeats = table.players.map(p => p.seat);
    for (let i = 1; i <= table.maxPlayers; i++) {
        if (!occupiedSeats.includes(i)) {
            return i; // Return the first unoccupied seat
        }
    }
    return null; // No available seat found
};


// Formats the table details to send to a specific client.
// Hides other players' hole cards except during showdown reveal based on show/muck status.
const formatTableForClient = (table, targetSocketId) => {
    if (!table) return null;

    const user = usersConnected[targetSocketId];
     // Flag to indicate if showdown details should potentially be shown (end of hand stages)
    const isShowdownVisible = table.stage === 'showdown_complete' || table.status === 'finished';


    return {
        id: table.id,
        name: table.name,
        players: table.players.map(p => {
             // Find this player's showdown data if available
             const showdownPlayerInfo = isShowdownVisible && table.showdownResults?.orderedShowdown
                 ? table.showdownResults.orderedShowdown.find(sdp => sdp.seat === p.seat)
                 : null;

             return {
                username: p.username,
                seat: p.seat,
                stack: parseFloat(p.stack.toFixed(2)), // Round stack to 2 decimals
                statusInHand: p.statusInHand, // 'playing', 'folded', 'all_in', 'waiting', 'sitting_out'
                betInStage: parseFloat((p.betInStage || 0).toFixed(2)), // Round betInStage to 2 decimals
                // Show hole cards if:
                // 1. It's the target user's own hand (client has the data).
                // 2. It's showdown/complete stage AND the player is in the orderedShowdown list AND their 'show' flag is true.
                // Server provides hole cards data ONLY if it should be revealed to THIS client.
                holeCards: (p.socketId === targetSocketId || showdownPlayerInfo?.show === true) ? p.holeCards : null,

                // Indicate if the player *had* cards dealt at the start of the hand and didn't fold/sit out.
                // Used by client to show card backs before showdown.
                 // hasCards is true if player was 'playing' at the start of the hand and didn't fold or sit out later.
                 // Check statusInHand: if playing or all_in, they were dealt cards and are still in hand (not folded/sitting out).
                hasCards: p.statusInHand === 'playing' || p.statusInHand === 'all_in',

                // Include showdown specific data for this player if available
                showdownInfo: showdownPlayerInfo ? {
                     hand: showdownPlayerInfo.hand ? { // Include hand details only if solved and exists
                          name: showdownPlayerInfo.hand.name,
                          desc: showdownPlayerInfo.hand.desc || 'No description',
                          rank: showdownPlayerInfo.hand.rank,
                          cards: showdownPlayerInfo.hand.cards // Include the 5 best cards
                          // cardPool is not needed by client typically
                     } : null,
                     show: showdownPlayerInfo.show, // Whether this hand is revealed
                     isWinner: showdownPlayerInfo.isWinner, // Whether this player won
                     muckReason: showdownPlayerInfo.muckReason // Reason if mucked
                } : null, // Null if not in showdownPlayers or not in showdown stages
             };
        }),
        smallBlind: table.smallBlind,
        bigBlind: table.bigBlind,
        status: table.status, // 'waiting', 'playing', 'finished'
        maxPlayers: table.maxPlayers,
        dealerSeat: table.dealerSeat,
        pot: parseFloat(table.pot.toFixed(2)), // Round pot to 2 decimals
        communityCards: table.communityCards, // Cards are already correct format 'Ts'
        stage: table.stage, // Current stage (null, 'dealing', 'preflop_blinds', etc.)
        currentTurnSeat: table.currentTurnSeat, // Seat of the player whose turn it is
        currentBet: parseFloat((table.currentBet || 0).toFixed(2)), // Total amount to match (rounded)
        lastRaiserSeat: table.lastRaiserSeat, // Seat of the last player to make an aggressive action
        lastRaiseSize: parseFloat((table.lastRaiseSize || 0).toFixed(2)), // Size of the last raise (rounded)
        creatorUsername: table.creatorUsername, // Username of table creator
        isCreator: user?.username === table.creatorUsername, // If the connected user is the creator
        // Full showdown results including order, hands, show/muck status
        showdownResults: table.showdownResults // This now includes the orderedShowdown array
    };
};


// Broadcast updates to all connected clients
const broadcastUpdates = () => {
    // console.log(">>> SERVER DEBUG: Entering broadcastUpdates function..."); // Too chatty
    try {
        // Prepare the list of tables for the lobby (public info)
        const lobbyTables = Object.values(activeTables).map(t => ({
            id: t.id,
            name: t.name,
            playerCount: t.players.length,
            smallBlind: t.smallBlind,
            bigBlind: t.bigBlind,
            status: t.status, // 'waiting', 'playing', 'finished'
            maxPlayers: t.maxPlayers
        }));

        // Iterate through all connected users
        for (const sid in usersConnected) {
            const u = usersConnected[sid];
            const s = io.sockets.sockets.get(sid); // Get the socket object

            if (!s) {
                // If socket doesn't exist, it should be handled by 'disconnect' listener.
                continue; // Skip if socket is not valid
            }

            // If user is not at a table, send the lobby table list
            if (u.currentTableId === null) {
                s.emit('update_table_list', lobbyTables);
            } else {
                // If user is at a table, send details of that table
                const tbl = activeTables[u.currentTableId];
                if (tbl) {
                    // Send active table details, formatted specifically for this user
                    s.emit('update_active_table', formatTableForClient(tbl, sid));
                } else {
                    // If user is registered at a table that no longer exists (deleted)
                    console.warn(` -> User ${u.username || sid} at missing table ${u.currentTableId}. Removing from table state.`);
                    // Force user to leave this phantom table state client-side and server-side
                    user.currentTableId = null; // Reset server state in the loop variable 'u'
                    s.emit('left_table'); // Inform client they left
                    // Note: socket.leave(u.currentTableId) would be ideal here, but u.currentTableId might be stale/invalid room name if table deleted.
                    s.emit('update_table_list', lobbyTables); // Send lobby list now they are not at a table
                }
            }
        }
        // console.log("📢 Broadcasted updates successfully."); // Too chatty
    } catch (error) {
        console.error("!!!! ERROR during broadcastUpdates !!!!", error);
    }
};


// --- Gestion Connexions & Événements Socket ---

// Base route to check Express server is running
app.get('/', (req, res) => {
    res.send('Poker Server is running!');
});


// Handles new Socket.IO connections
io.on('connection', (socket) => {
    console.log(`⚡: User connected ${socket.id}`);
    // Initialize user state in connected users list
    usersConnected[socket.id] = { username: null, currentTableId: null };

    // Send initial list of available tables to the new client
    const initialTables = Object.values(activeTables).map(t => ({
        id: t.id, name: t.name, playerCount: t.players.length,
        smallBlind: t.smallBlind, bigBlind: t.bigBlind, status: t.status, maxPlayers: t.maxPlayers
    }));
    socket.emit('update_table_list', initialTables);


    // --- Listener 'set_username' ---
    // Handles setting the user's username
    socket.on('set_username', (username) => {
        console.log(`>>> SERVER RECEIVED set_username: '${username}' from ${socket.id}`);
        const trimmedUsername = username?.trim();

        // Validate username
        if (!trimmedUsername || trimmedUsername.length < 3) {
             console.log(`   -> Username '${trimmedUsername}' invalid (too short or empty). Emitting error.`);
             return socket.emit('username_error', 'Pseudo trop court (min 3 caractères)');
        }

        // Check if username is already taken by a currently connected user
        if (Object.values(usersConnected).some(u => u.username === trimmedUsername)) {
            console.log(`   -> Username '${trimmedUsername}' already taken. Emitting error.`);
            return socket.emit('username_error', 'Pseudo déjà pris');
        }

        // Check if user already has a username set (shouldn't happen if button is disabled on client)
        if (usersConnected[socket.id]?.username !== null) {
             console.warn(`   -> Socket ${socket.id} is trying to set username again. Current username: ${usersConnected[socket.id]?.username}`);
             return socket.emit('username_error', 'Pseudo déjà défini');
        }

        // Associate username with socket id
        usersConnected[socket.id] = { ...usersConnected[socket.id], username: trimmedUsername }; // Use spread to keep currentTableId (which is null here)
        console.log(`👤: ${socket.id} is now ${trimmedUsername}`);

        // Confirmer au client que pseudo est défini
        socket.emit('username_set', trimmedUsername);
        // Diffuser un message système dans le chat global (lobby)
        io.emit('chat_message', { system: true, text: `${trimmedUsername} a rejoint le lobby.` });

         // Diffuser les mises à jour. Potentiellement le nombre de connectés dans le lobby a changé.
        broadcastUpdates();
    });


    // --- Listener 'create_table' ---
    // Handles creating a new game table
    socket.on('create_table', (data) => {
        console.log(`>>> SERVER RECEIVED 'create_table' from ${socket.id} with data:`, data);
        const creator = usersConnected[socket.id];

        // Check preconditions
        if (!creator?.username) {
            console.log("   -> Error: Creator not found or no username set.");
            return socket.emit('error_message', 'Veuillez définir un pseudo pour créer une table.');
        }
         if (creator.currentTableId !== null) {
             console.log(`   -> Error: User ${creator.username} is already at table ${creator.currentTableId}.`);
             return socket.emit('error_message', 'Vous êtes déjà à une table. Quittez-la d\'abord.');
         }

        // Validate and parse received data
        const name = data?.name?.trim() || `${creator.username}'s Table`;
        const sb = parseFloat(data?.smallBlind) || 0;
        const bb = parseFloat(data?.bigBlind) || 0;
        const maxP = parseInt(data?.maxPlayers, 10);

        // Validate inputs
        if (isNaN(sb) || sb <= 0 || isNaN(bb) || bb <= sb) {
             console.log(`   -> Error: Invalid blinds (SB: ${sb}, BB: ${bb}).`);
             return socket.emit('error_message', 'Blinds invalides (SB > 0, BB > SB).');
        }
         if (isNaN(maxP) || maxP < 2 || maxP > 10) {
             console.log(`   -> Error: Invalid max players detected: ${maxP}`);
             return socket.emit('error_message', 'Nombre de joueurs invalide (entre 2 et 10).');
         }

        // Generate a unique ID for the table
        const id = uuidv4();
        console.log(`   -> Generating table ID: ${id}`);

        // Create table object and add it to active tables
        activeTables[id] = {
            id, name, players: [], smallBlind: sb, bigBlind: bb, status: 'waiting', maxPlayers: maxP,
            deck: [], communityCards: [], pot: 0, dealerSeat: null, currentTurnSeat: null, stage: null,
            currentBet: 0, lastRaiserSeat: null, lastRaiseSize: 0, // <-- Initialize lastRaiseSize
            creatorUsername: creator.username, // Store creator's username
            numActionsThisRound: 0, betToCloseRound: null, showdownResults: null // Initialize hand/round variables
        };

        console.log(`➕ Table '${name}' (ID: ${id}) created by ${creator.username}. Status: waiting.`);

        // Broadcast updates so the new table appears in others' lobby
        broadcastUpdates();

        // Creator automatically joins the table they created
        handleJoinTable({ tableId: id }, socket); // Call the internal handler with creator's socket
    });


    // --- Listener 'join_table' ---
    // Handles joining an existing table. Can be called by client or internally (for create_table).
    const handleJoinTable = ({ tableId }, socketToUse) => {
         const currentSocket = socketToUse || socket; // Use socket from param or default socket
         const u = usersConnected[currentSocket.id];

        // Check preconditions
         if (!u?.username){
             console.log(`-> Join failed for ${currentSocket.id}: No username.`);
             return currentSocket.emit('error_message','Veuillez définir un pseudo pour rejoindre une table.');
         }
         if (u.currentTableId !== null){
              console.log(`-> Join failed for ${u.username} (${currentSocket.id}): Already at table ${u.currentTableId}.`);
              return currentSocket.emit('error_message','Vous êtes déjà à une table. Quittez-la d\'abord.');
         }

         const t = activeTables[tableId];
         if(!t){
             console.log(`-> Join failed for ${u.username}: Table ${tableId} not found.`);
             return currentSocket.emit('error_message','Table introuvable.');
         }
         if(t.players.length >= t.maxPlayers){
             console.log(`-> Join failed for ${u.username}: Table ${tableId} is full (${t.players.length}/${t.maxPlayers}).`);
             return currentSocket.emit('error_message','Table pleine.');
         }
         // Only join a table if it's waiting or finished (not in progress or dealing/blinds/showdown stages)
         if(t.status === 'playing' || t.stage === 'dealing' || t.stage === 'preflop_blinds' || t.stage === 'showdown' || t.stage === 'showdown_complete'){
             console.log(`-> Join failed for ${u.username}: Table ${tableId} game in progress (${t.status}, ${t.stage}).`);
              return currentSocket.emit('error_message','La partie est déjà en cours sur cette table.');
         }


         // Find an available seat at the table
         const seat = findAvailableSeat(t);
         if(!seat){
             console.log(`-> Join failed for ${u.username}: No available seat in table ${tableId}.`);
             return currentSocket.emit('error_message','Aucun siège disponible à cette table.');
         }

         // Create player object and add to table
         // Use parseFloat for stack as well if starting stack could be non-integer in the future
         const player = {socketId: currentSocket.id, username: u.username, seat: seat, stack: parseFloat(STARTING_STACK.toFixed(2)), holeCards:[], statusInHand:'waiting', betInStage:0};
         t.players.push(player);

         // Update user's state in the global connected users list
         u.currentTableId = tableId;

         console.log(`➡️ ${u.username} (Seat ${seat}) joined table ${t.name} (ID: ${tableId}).`);

         // Inform other players at the table that a new player joined
         // Use io.to(roomId) to send to all sockets in the room (the table ID)
         io.to(tableId).emit('chat_message', { system: true, text: `${u.username} a rejoint la table (Siège ${seat}).` });

         // Associate the socket with a room corresponding to the table ID for easier targeted sending
         currentSocket.join(tableId);
         console.log(`Socket ${currentSocket.id} joined room ${tableId}`);

         // Broadcast updates (lobby list change, active table details change for players at that table)
         broadcastUpdates();
    };
    // Associate the 'join_table' socket event with the internal handler function
     socket.on('join_table', (data) => handleJoinTable(data, socket));


    // --- Listener 'request_start_game' ---
    // Handles the creator's request to start a new hand.
    socket.on('request_start_game', ({ tableId })=>{
         const u = usersConnected[socket.id];
         const t = activeTables[tableId];

         // Strict server-side checks before starting the hand
         // User exists, has username, is at this table, is the creator,
         // table is in 'waiting' or 'finished' status, and there are enough eligible players (> 0 stack).
         const eligiblePlayersCount = t?.players.filter(p => p.stack > 0.001).length ?? 0; // Use tolerance


         if(!u?.username || !t || u.currentTableId !== tableId || t.creatorUsername !== u.username || (t.status !== 'waiting' && t.status !== 'finished') || eligiblePlayersCount < MIN_PLAYERS_TO_START) {
              const reason = !u?.username ? "No username" :
                             !t ? "Table not found" :
                             u.currentTableId !== tableId ? "Not at this table" :
                             t.creatorUsername !== u.username ? "Not creator" :
                             (t.status !== 'waiting' && t.status !== 'finished') ? `Wrong status (${t.status})` :
                             `Not enough eligible players (${eligiblePlayersCount}/${MIN_PLAYERS_TO_START})`;
              console.warn(`Cannot start game for ${u?.username || socket.id}: ${reason}`);
              return socket.emit('error_message', 'Impossible de démarrer la partie. Conditions non remplies.');
         }

         console.log(`User ${u.username} requesting to start hand for table ${t.name} (ID: ${tableId}).`);
         startNewHand(tableId); // Launch the function to start a new hand
    });


    // --- Listener 'player_action' ---
    // Handles player actions during a betting round (fold, check, call, bet, raise).
    socket.on('player_action', (actionData) => {
        const user = usersConnected[socket.id];
         // Check that the user is at a table
        if(!user?.currentTableId) {
             console.warn(`Action received from ${socket.id} with no current table.`);
             return socket.emit('error_message','Action invalide (pas à une table).');
        }

        const table = activeTables[user.currentTableId];
        const player = table?.players.find(p=>p.socketId===socket.id);

        // Essential checks of game state and player state
        if(!table) {
            console.warn(`Action received from ${player?.username || socket.id} for non-existent table ${user.currentTableId}.`);
             // Force user state cleanup if associated with a missing table
             user.currentTableId = null;
             socket.emit('left_table');
             // Leave the room if user was in one (safer to try)
             if (user.currentTableId) socket.leave(user.currentTableId);
             broadcastUpdates();
            return socket.emit('error_message','Table introuvable.');
        }
         // Game must be playing and in a betting stage
         const isBettingStage = table.stage && table.stage.includes('_betting');
         if(table.status !== 'playing' || !isBettingStage) {
              console.warn(`Action received from ${player?.username || socket.id} for table ${table.id}, but game not in playing/betting state (Status: ${table.status}, Stage: ${table.stage}).`);
              return socket.emit('error_message','Action invalide (jeu non en cours ou non dans une phase de mise).');
         }
        // Check it's this player's turn
        if(player?.seat !== table.currentTurnSeat) {
            console.warn(`Action received from ${player?.username || socket.id} (Seat ${player?.seat}), but it's Seat ${table.currentTurnSeat}'s turn.`);
            return socket.emit('error_message','Ce n\'est pas votre tour.');
        }
         // Player must exist and not be sitting_out or folded (shouldn't have turn if they were)
          if (!player || player.statusInHand === 'sitting_out' || player.statusInHand === 'folded') {
              console.warn(`Action received from ${player?.username || socket.id}, but status is ${player?.statusInHand}.`);
              return socket.emit('error_message', `Action impossible avec votre statut actuel (${player?.statusInHand}).`);
          }


        console.log(`ACTION RECEIVED: ${player.username} (Seat ${player.seat}) [Stack: ${player.stack}, BetInStage: ${player.betInStage}] -> Type: ${actionData.type}, Amount: ${actionData.amount}`);

        const type = actionData.type;
        // Amount should be integer or float, parseFloat handles both. Default to 0 if invalid/missing.
        const amount = parseFloat(actionData.amount) || 0;
        let playerActedSeat = player.seat;
        let isAggressiveAction = false; // Flag for bet or raise


        // Store current bet before action for raise size calculation
        const prevCurrentBet = table.currentBet;
         const prevLastRaiseSize = table.lastRaiseSize;

        // Increment action counter only if action is valid below
        // table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;


        switch(type){
            case 'fold':
                // Player can always fold if it's their turn and they haven't already.
                if (player.statusInHand === 'folded') {
                     console.warn(` -> ${player.username} attempted to fold but is already folded.`);
                     return socket.emit('error_message','Vous avez déjà foldé.');
                }
                console.log(` -> ${player.username} folds.`);
                player.statusInHand = 'folded'; // Mark as folded

                // Chat message for the action
                 io.to(table.id).emit('chat_message', { user: player.username, text: "folds" }); // Use past tense

                // Check if hand ends (only one player in hand remaining)
                const playersInHandCountAfterFold = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out').length;
                if(playersInHandCountAfterFold <= 1){
                     console.log(`Only ${playersInHandCountAfterFold} player(s) left in hand after fold. Ending hand.`);
                     // If 0 or 1 player left in hand, hand is over. endHand handles win by default.
                     endHand(user.currentTableId);
                     return; // Stop processing
                }
                // Action is valid, increment action counter
                table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;
                break; // Continue to progression/next turn logic


            case 'check':
                // Player can check if their betInStage matches the currentBet (or if currentBet is 0).
                // This implies player.betInStage === table.currentBet.
                if (player.betInStage < table.currentBet - 0.001) { // Use tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) cannot check. Bet in stage (${player.betInStage}) < Current bet (${table.currentBet}).`);
                     return socket.emit('error_message','Vous ne pouvez pas checker. Vous devez Call ou Fold.');
                }
                 // A player who is all-in can also "check" if they have already matched the bet (betInStage === currentBet).
                 // Player must not be sitting_out or folded (checked at the start).
                 if (player.stack <= 0.001 && player.statusInHand !== 'all_in' && Math.abs(player.betInStage - table.currentBet) < 0.001) { // Use tolerance
                     // This case is bizarre, a player stack 0 should not be 'playing'. But gered.
                      console.warn(` -> ${player.username} checks with stack 0.`);
                 }
                 // If player is 'all_in' but betInStage < currentBet, they cannot Check. They must Fold.
                  if (player.statusInHand === 'all_in' && player.betInStage < table.currentBet - 0.001) { // Use tolerance
                       console.warn(` -> ${player.username} (Seat ${player.seat}) is All-in but betInStage (${player.betInStage}) < currentBet (${table.currentBet}). Cannot Check.`);
                       return socket.emit('error_message','Vous êtes All-in pour moins que la mise actuelle. Vous ne pouvez que Fold.');
                  }


                console.log(` -> ${player.username} checks.`);
                io.to(table.id).emit('chat_message', { user: player.username, text: "checks" }); // Past tense
                // Action is valid, increment action counter
                table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;
                break; // Continue to progression/next turn logic


            case 'call':
                 // Cannot call if player has already matched or exceeded the current bet in this stage.
                if (player.betInStage >= table.currentBet - 0.001) { // Use tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) cannot call. Bet in stage (${player.betInStage}) >= Current bet (${table.currentBet}).`);
                    if (Math.abs(player.betInStage - table.currentBet) < 0.001) { // Use tolerance
                         return socket.emit('error_message','Vous avez déjà égalé la mise. Vous pouvez Check ou Raise.');
                    } else { // Should not happen if logic is followed
                         return socket.emit('error_message','Action invalide pour appeler.');
                    }
                }

                 // Amount needed to call = current bet - player's bet already in this stage
                const amountNeededToCall = parseFloat((table.currentBet - player.betInStage).toFixed(2));

                 // The actual amount posted is the minimum between what's needed and player's remaining stack.
                 // If stack < amountNeededToCall, the player goes all-in when calling.
                const actualAmountCalled = parseFloat(Math.min(amountNeededToCall, player.stack).toFixed(2));

                 // If needed amount > 0 (tolerance) but player has stack 0 (or very close) and not already all-in, they cannot call.
                 // A player who is 'all_in' but betInStage < currentBet cannot 'Call' - they can only Fold.
                 // So, if player is 'playing' with stack 0 and amountNeededToCall > 0, it's invalid.
                 if (amountNeededToCall > 0.001 && player.stack <= 0.001 && player.statusInHand === 'playing') { // Use tolerance
                      console.warn(` -> ${player.username} (Seat ${player.seat}) cannot call ${amountNeededToCall}. Stack is ${player.stack} and status is playing.`);
                       return socket.emit('error_message','Stack insuffisant pour appeler.');
                 }
                 // If player is 'all_in' but betInStage < currentBet, they can ONLY Fold.
                  if (player.statusInHand === 'all_in' && player.betInStage < table.currentBet - 0.001) { // Use tolerance
                       console.warn(` -> ${player.username} (Seat ${player.seat}) is All-in but betInStage (${player.betInStage}) < currentBet (${table.currentBet}). Cannot Call.`);
                       return socket.emit('error_message','Vous êtes All-in pour moins que la mise actuelle. Vous ne pouvez que Fold.');
                  }

                // If needed amount is 0 or negative, this should be a check. Client should prevent Call 0 button when currentBet is 0.
                // If currentBet > 0 but amountNeededToCall <= 0, they already matched/exceeded, handled above.
                if (amountNeededToCall <= 0.001) { // Use tolerance
                      console.warn(` -> ${player.username} attempted call when amountNeededToCall is ${amountNeededToCall}. Current bet ${table.currentBet}, betInStage ${player.betInStage}. This should be a check.`);
                       return socket.emit('error_message','Action invalide pour appeler.');
                }


                postBet(table, player, actualAmountCalled); // Perform the call (postBet handles the actual amount and all-in status)
                console.log(` -> ${player.username} calls ${actualAmountCalled} (total in stage: ${player.betInStage}).`);

                // Chat message (distinguish simple call and all-in call)
                 io.to(table.id).emit('chat_message', { user: player.username, text: player.statusInHand === 'all_in' ? `all-in call ${actualAmountCalled}` : `calls ${actualAmountCalled}` }); // Past tense

                 // A Call action is not an aggressive action. lastRaiserSeat and lastRaiseSize do not change.
                // Action is valid, increment action counter
                table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;
                break; // Continue to progression/next turn logic


            case 'bet':
                 // Can only bet if currentBet is 0.
                if (table.currentBet > 0.001) { // Use tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) cannot bet. Current bet is ${table.currentBet}.`);
                    return socket.emit('error_message','Vous ne pouvez pas Bet, vous devez Raise ou Call.');
                }
                 // A player who is all-in or stack 0 cannot Bet. Must be 'playing' with stack > 0.
                 if (player.statusInHand !== 'playing' || player.stack <= 0.001) { // Use tolerance
                      console.warn(` -> ${player.username} (Seat ${player.seat}) cannot bet. Status: ${player.statusInHand}, Stack: ${player.stack}.`);
                       return socket.emit('error_message','Action impossible avec votre stack ou statut.');
                 }

                // Validate bet amount
                // Bet amount must be >= the standard Big Blind of the table, unless it's an all-in for less.
                if (amount < table.bigBlind - 0.001 && Math.abs(amount - player.stack) > 0.001) { // Use tolerance for amount and all-in check
                     console.warn(` -> ${player.username} (Seat ${player.seat}) bet ${amount}, which is less than Big Blind (${table.bigBlind}) and not an all-in.`);
                    return socket.emit('error_message',`Mise minimum ${table.bigBlind} (ou All-in pour moins).`);
                }
                // Amount cannot exceed available stack.
                if (amount > player.stack + 0.001) { // Add tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) attempted to bet ${amount}, which is more than their stack (${player.stack}).`);
                    return socket.emit('error_message','Mise supérieure à votre stack.');
                }
                 // Amount must be positive if player has chips.
                 if (amount <= 0.001) { // Use tolerance
                      console.warn(` -> ${player.username} (Seat ${player.seat}) attempted to bet 0 or less.`);
                       return socket.emit('error_message','Mise invalide (doit être positive).');
                 }


                const betAmtPosted = postBet(table, player, amount); // Perform the bet
                table.currentBet = betAmtPosted; // The new current bet is this bet amount
                table.lastRaiserSeat = player.seat; // This player is the last to make an aggressive action
                table.lastRaiseSize = betAmtPosted; // <-- The size of the first bet sets the reference for future raises
                isAggressiveAction = true; // This is an aggressive action

                console.log(` -> ${player.username} bets ${betAmtPosted}. Current Bet: ${table.currentBet}, Last Raise Size: ${table.lastRaiseSize}.`);
                io.to(table.id).emit('chat_message', { user: player.username, text: player.statusInHand === 'all_in' ? `all-in bet ${betAmtPosted}` : `bets ${betAmtPosted}` }); // Past tense

                // Action is valid, increment action counter
                table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;
                break; // Continue to progression/next turn logic


            case 'raise':
                 // Can only raise if currentBet > 0.
                if (table.currentBet < 0.001) { // Use tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) cannot raise. Current bet is ${table.currentBet}.`);
                    return socket.emit('error_message','Vous ne pouvez pas Raise, vous devez Bet ou Check.');
                }
                 // Player must be 'playing' with stack > 0 for a standard raise.
                 // An all-in for less than min raise is possible but validated differently.
                 if (player.statusInHand !== 'playing' || player.stack <= 0.001) { // Use tolerance
                      console.warn(` -> ${player.username} (Seat ${player.seat}) cannot raise. Status: ${player.statusInHand}, Stack: ${player.stack}.`);
                       return socket.emit('error_message','Action impossible avec votre stack ou statut.');
                 }

                // The total raise amount requested (amount) must be strictly greater than currentBet.
                if (amount <= table.currentBet + 0.001) { // Use tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) raise amount (${amount}) is not > currentBet (${table.currentBet}).`);
                    return socket.emit('error_message',`Le montant total de votre relance (${amount}) doit être strictement supérieur à la mise actuelle (${table.currentBet}).`);
                }

                // Calculate the minimum amount for a STANDARD raise.
                // The size of the previous raise is lastRaiseSize (or BB if it's the first raise pre-flop after blinds).
                const minRaiseSize = table.lastRaiseSize > 0.001 ? table.lastRaiseSize : table.bigBlind; // Use tolerance
                // The total raise amount must be at least (current_bet + min_raise_size).
                const minTotalRaiseRequired = parseFloat((table.currentBet + minRaiseSize).toFixed(2));

                // Check if the requested amount is sufficient for a STANDARD raise, OR if it's an all-in.
                // If amount is less than the minimum required for a standard raise BUT it is NOT an all-in: invalid.
                if (amount < minTotalRaiseRequired - 0.001 && Math.abs(amount - player.stack) > 0.001) { // Use tolerance for comparison and all-in check
                     console.warn(` -> ${player.username} (Seat ${player.seat}) raise amount (${amount}) is less than minTotalRaiseRequired (${minTotalRaiseRequired}) and not an all-in.`);
                    return socket.emit('error_message',`Montant total de relance minimum ${minTotalRaiseRequired} (ou All-in pour moins).`);
                }

                // Amount cannot exceed available stack.
                if (amount > player.stack + 0.001) { // Add tolerance
                     console.warn(` -> ${player.username} (Seat ${player.seat}) attempted to raise ${amount}, which is more than their stack (${player.stack}).`);
                    return socket.emit('error_message','Relance supérieure à votre stack.');
                }

                // Calculate amount to add for this raise (desired total amount - player's bet already in this stage)
                const raiseAmtToAdd = parseFloat((amount - player.betInStage).toFixed(2));

                 // Validate that the amount to add is positive (cannot raise by adding 0 or less)
                 if (raiseAmtToAdd <= 0.001) { // Use tolerance
                      console.warn(` -> ${player.username} (Seat ${player.seat}) calculated raiseAmtToAdd ${raiseAmtToAdd} based on amount ${amount} and betInStage ${player.betInStage}.`);
                      return socket.emit('error_message','Montant de relance invalide.'); // Shouldn't happen with validations preceding this
                 }
                // Check stack sufficient for amount to add (already covered by amount > player.stack check)
                 if (raiseAmtToAdd > player.stack + 0.001) { // Add tolerance
                      console.error(`Logic error: raiseAmtToAdd (${raiseAmtToAdd}) > player.stack (${player.stack}) for ${player.username}.`);
                       return socket.emit('error_message','Erreur interne: Stack insuffisant.');
                 }


                postBet(table, player, raiseAmtToAdd); // Add the bet to the pot

                // Update the current bet and the last raiser
                table.currentBet = amount; // The new current bet is the TOTAL amount of the raise
                table.lastRaiserSeat = player.seat; // This player is the last to make an aggressive action

                // Update the size of the last raise *only* if it was a standard raise or more.
                const actualRaiseSize = parseFloat((amount - prevCurrentBet).toFixed(2)); // The size of this raise is the difference between the new total bet and the old total bet
                 // Note: An all-in for less than the minimum re-raise (minTotalRaiseRequired) does NOT change the table.lastRaiseSize for players behind.
                 // If amount is player's stack (it's an all-in), AND if this all-in is less than the standard min raise size,
                 // the effective raise size is actualRaiseSize, BUT the `lastRaiseSize` for following players REMAINS the old `prevLastRaiseSize`.
                 if (Math.abs(amount - player.stack) < 0.001 && actualRaiseSize < minRaiseSize - 0.001) { // Use tolerance for all-in and raise size checks
                     console.log(` -> ${player.username} (Seat ${player.seat}) is All-in for less than min raise size (${actualRaiseSize} < ${minRaiseSize}). lastRaiseSize remains ${prevLastRaiseSize}.`);
                     // lastRaiseSize remains unchanged.
                 } else {
                     // This is a standard raise or more, or an all-in >= min raise size
                     table.lastRaiseSize = actualRaiseSize; // The new raise size is the difference
                     console.log(` -> ${player.username} raises to ${amount}. Current Bet: ${table.currentBet}, New Last Raise Size: ${table.lastRaiseSize}.`);
                 }

                isAggressiveAction = true; // This is an aggressive action

                // Chat message (distinguish simple raise and all-in raise)
                 io.to(table.id).emit('chat_message', { user: player.username, text: player.statusInHand === 'all_in' ? `all-in raise to ${amount}` : `raises to ${amount}` }); // Past tense

                // Action is valid, increment action counter
                table.numActionsThisRound = (table.numActionsThisRound || 0) + 1;
                break; // Continue to progression/next turn logic


            default:
                 console.warn(`Received unknown action type "${type}" from ${player.username} (Seat ${player.seat}).`);
                return socket.emit('error_message','Action inconnue.'); // Invalid action
        }

        // --- LOGIC FOR ENDING ROUND / PASSING TURN ---

        let roundOver = false;
        // Who are the players still in the hand (not folded, waiting, sitting_out) ?
        const playersInHand = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
         // Who are the players who can still bet/raise (playing + stack > 0) ?
        const playersWhoCanBet = table.players.filter(p => p.stack > 0.001 && p.statusInHand === 'playing'); // Use tolerance


        // If 1 player or less is still in the hand, the hand is over.
        if (playersInHand.length <= 1) {
            roundOver = true;
            console.log(`Round/Hand ends: <= ${playersInHand.length} player left in hand.`);
        } else {
            // Conditions for a standard betting round end:
            // 1. All players IN HAND (playing or all_in) have bet the same amount *in this round*, OR are all-in.
            // 2. The action has returned to the player who "closes" the round.
            //    Special case: BB option pre-flop.

            const maxBetInStage = Math.max(0, ...playersInHand.map(p => p.betInStage)); // Highest bet posted by a player IN HAND in this round
            // Have all players IN HAND either matched the maxBetInStage OR are all-in?
            // This condition detects if everyone has called the highest bet or cannot put more chips in.
            const allMatchedOrAllIn = playersInHand.every(p => Math.abs(p.betInStage - maxBetInStage) < 0.001 || p.statusInHand === 'all_in'); // Use tolerance

            const closingPlayerSeat = table.betToCloseRound;
            const isActionReturnedToCloser = playerActedSeat === closingPlayerSeat;


            // Special case pre-flop: BB Option.
            const bbSeat = findNextPlayerToAct(table, findNextPlayerToAct(table, table.dealerSeat, false), false); // Find the BB seat (among players in hand)
            const isPreflop = table.stage === 'preflop_betting';
            const isBB = playerActedSeat === bbSeat;
            // BB has option if facing a bet that is NOT a raise (i.e., currentBet is BB amount, and no one has raised after BB yet).
             // lastRaiserSeat === bbSeat means BB was the last "raiser" (posted BB)
             // OR lastRaiserSeat is null (no bet/raise after blinds, shouldn't happen if BB posted)
            const bbHasOption = isPreflop && isBB && Math.abs(table.currentBet - table.bigBlind) < 0.001 && Math.abs(player.betInStage - table.bigBlind) < 0.001 && (table.lastRaiserSeat === bbSeat || table.lastRaiserSeat === null);


            // Determine if the betting round is over
             if (allMatchedOrAllIn) {
                  // All remaining players have bet the same amount or are all-in.
                  // The round is over if action has returned to the closer...
                  if (isActionReturnedToCloser) { // <-- CORRECT VARIABLE NAME HERE
                       // ... UNLESS it's the BB pre-flop who has the option and just checked.
                       // If BB has option and checks, round is over.
                       if (bbHasOption && type === 'check') {
                            console.log(`Betting Ends [Special]: BB (Seat ${playerActedSeat}) checked option preflop. Action closed.`);
                            roundOver = true;
                       }
                       // Otherwise, if action has returned to the closer (and it's not the BB option check case), the round is over.
                       // This includes post-flop check around (currentBet=0, allMatchedOrAllIn=true with betInStage=0 everywhere)
                       else if (!(bbHasOption && type === 'check')) { // Ensure we are not in the BB option check case
                            console.log(`Betting Ends [General]: Action completed by closing player (Seat ${closingPlayerSeat}). All bets matched or players all-in.`);
                            roundOver = true;
                       }
                       // If BB pre-flop has option and RAISEs (type='raise'), round is NOT over, action continues after them, and closingPlayerSeat is recalculated by aggressive action.
                  }
                 // If allMatchedOrAllIn is true, but isActionReturnedToCloser is false, it means
                 // the player who just acted has indeed matched/all-in, but action needs to pass to other players *between* them and the closingPlayerSeat
                 // who haven't acted yet in this round. The round is NOT over.

             }
             // If !allMatchedOrAllIn, the round is NOT over, because there are still players in hand who haven't matched/all-in
             // and who still have chips to bet.

        } // End of the else (playersInHand.length > 1)

        // --- Handle aggressive actions to update betToCloseRound ---
        // If the action was a Bet or a Raise, the player who acted becomes the new point of reference for the round.
        // The round will end after all players *behind* him (in playing order) have acted, up to the player just *before* him.
        if (isAggressiveAction) {
             console.log(`Action was aggressive (Bet/Raise). Recalculating betToCloseRound.`);
            // The player who closes the round is the ACTIVE player *before* the player who just acted (cyclically).
            // We search among players who are still IN HAND.
            const newBetToCloseRound = findPreviousActivePlayer(table, playerActedSeat);
            if (newBetToCloseRound !== null) {
                table.betToCloseRound = newBetToCloseRound;
                console.log(`New action closes after Seat ${table.betToCloseRound}`);
            } else {
                 // This case should not happen if playerActedSeat is a player in hand.
                 console.error("Could not determine new betToCloseRound after aggressive action!");
                 // Leave the old betToCloseRound? Or set it to null (which might block)?
                 // Leaving the old one is less risky if the next round-end detection is robust.
            }
        }


        // --- Final Decision: Progress or Pass Turn ---
        if (roundOver) {
            console.log("Betting round is over. Progressing to next stage.");
            progressToNextStage(user.currentTableId); // Go to the next stage (dealing cards or showdown)
        } else {
            // The betting round continues. Find the next player whose turn it is.
            // Search for the next player *who can ACT* (stack > 0, status 'playing') after the player who just acted.
            const nextPlayerSeat = findNextPlayerToAct(table, playerActedSeat, true);

            if (nextPlayerSeat !== null) {
                 // A next player who can act was found. Pass the turn to them.
                table.currentTurnSeat = nextPlayerSeat;
                console.log(`Next turn: Seat ${table.currentTurnSeat}`);
                broadcastUpdates(); // Broadcast table state with the new turn
            } else {
                 // No player who can act was found after the player who just acted.
                 // This means all REMAINING players (after requireCanAct=true filtering)
                 // are either the player who just acted (impossible as findNextPlayerToAct searches after),
                 // or they are all all-in or stack 0 (even if statusInHand=='playing').
                 // If all other players in hand are all-in or stack 0, no more betting is possible. The round is over.
                 console.log("No next player found who can bet/raise/call. Checking if betting round should end based on all players in hand state.");

                 // Verify if all players IN HAND have matched the current bet or are all-in.
                 // This final check is crucial if requireCanAct=true finds nobody.
                 const playersInHandFinalCheck = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
                 const maxBetInStageFinalCheck = Math.max(0, ...playersInHandFinalCheck.map(p => p.betInStage));
                 const allMatchedOrAllInFinalCheck = playersInHandFinalCheck.every(p => Math.abs(p.betInStage - maxBetInStageFinalCheck) < 0.001 || p.statusInHand === 'all_in'); // Use tolerance

                 if (allMatchedOrAllInFinalCheck) {
                     console.log("All players in hand have matched or are all-in. Ending betting round and progressing stage.");
                     progressToNextStage(user.currentTableId); // Go to next stage
                 } else {
                     // This situation should ideally not happen if logic is correct.
                     // It would mean there are players in hand who haven't matched/all-in, but findNextPlayerToAct (true) finds none.
                     console.error("Logic error: No next player found who can act, but not all players in hand have matched or are all-in. Forcing hand end.");
                     // In doubt, force hand end to prevent a block.
                     endHand(user.currentTableId);
                 }
            }
        }
    }); // End listener 'player_action'


    // --- Listener 'leave_table' ---
    // Allows a player to leave the table.
    socket.on('leave_table', () => {
        const user = usersConnected[socket.id];
        // Check if the user is at a table
        if (!user?.currentTableId) {
             console.log(`User ${user?.username || socket.id} attempted to leave but is not at a table.`);
             return socket.emit('error_message', 'Vous n\'êtes pas à une table.');
        }

        const table = activeTables[user.currentTableId];
         // Check that the table exists
        if (!table) {
             console.error(`User ${user.username || socket.id} is registered at table ${user.currentTableId} which does not exist!`);
             // Clean up user state even if table is missing
             user.currentTableId = null;
             socket.emit('left_table'); // Inform client
             // Try to leave the room (safer)
             if (user.currentTableId) socket.leave(user.currentTableId);
             broadcastUpdates(); // Update lobby
             return socket.emit('error_message', 'La table n\'existe plus.');
        }

        // Find the player in the table's player list
        const playerIndex = table.players.findIndex(p => p.socketId === socket.id);
        if (playerIndex === -1) {
            console.error(`User ${user.username || socket.id} is registered at table ${table.id} but not found in players list!`);
             // Clean up user state
             user.currentTableId = null;
             socket.emit('left_table'); // Inform client
             if (table.id) socket.leave(table.id); // Leave the actual table room
             broadcastUpdates(); // Update lobby
            return socket.emit('error_message','Erreur interne lors de la sortie de table.');
        }

        const player = table.players[playerIndex];
        const leaverSeat = player.seat;
        const leaverUsername = player.username;
        // Keep creator status if needed later (e.g., pass status to another player)
        const leaverWasCreator = table.creatorUsername === leaverUsername;

        console.log(`🚪 ${leaverUsername} (Seat ${leaverSeat}) is leaving table ${table.name} (ID: ${table.id}).`);

        // Remove player from the list
        table.players.splice(playerIndex, 1);

        // Update user's state in the global connected users list
        user.currentTableId = null;

        // Make the socket leave the table's Socket.IO room
        socket.leave(table.id);
        console.log(`Socket ${socket.id} left room ${table.id}`);


        // Send a chat message to the table to inform remaining players
        io.to(table.id).emit('chat_message', { system: true, text: `${leaverUsername} a quitté la table.` });


        // --- Handle impacts on the current hand/game ---
        // If the hand was playing or finished (a player can leave after hand ends)
        if (table.status === 'playing' || table.status === 'finished') {
            // If the hand was in a betting stage AND it was the leaving player's turn
            const isBettingStage = table.stage && table.stage.includes('_betting');
            if (table.status === 'playing' && isBettingStage && table.currentTurnSeat === leaverSeat) {
                console.log(`Leaver was current turn (Seat ${leaverSeat}) during betting stage. Advancing turn.`);
                // Pass the turn to the next player who can act (stack > 0, 'playing')
                const nextPlayerSeat = findNextPlayerToAct(table, leaverSeat, true);
                table.currentTurnSeat = nextPlayerSeat; // Can be null if no one else can act

                 // If no one can act after the leaving player's turn, the betting round is potentially over.
                 if (table.currentTurnSeat === null) {
                      console.log("No player found who can bet after leaver's turn. Checking round end state.");
                       // Verify if all players IN HAND have matched the current bet or are all-in.
                       const playersInHandAfterLeave = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
                       const maxBetInStageAfterLeave = Math.max(0, ...playersInHandAfterLeave.map(p => p.betInStage));
                       const allMatchedOrAllInAfterLeave = playersInHandAfterLeave.every(p => Math.abs(p.betInStage - maxBetInStageAfterLeave) < 0.001 || p.statusInHand === 'all_in'); // Use tolerance

                       if (allMatchedOrAllInAfterLeave) {
                           console.log("All players in hand matched/all-in after leaver. Ending betting round.");
                           progressToNextStage(user.currentTableId); // Go to next stage
                       } else {
                           // Error or unexpected state: player quits with turn, nobody after can act, but round shouldn't end.
                           console.error("Logic error: Leaver had turn, no subsequent player can act, but not all players in hand matched/all-in. Forcing hand end to prevent block.");
                           endHand(user.currentTableId); // Force hand end
                       }
                 }
                // The betToCloseRound is not updated here, it will be recalculated at the next stage if the hand continues.

            }

             // Check if the hand must end (less than 2 players in hand remaining)
             // Players in hand: not folded/waiting/sitting_out
             const playersInHandCountAfterLeave = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out').length;
             if (playersInHandCountAfterLeave <= 1 && table.status === 'playing') { // Only if the hand was active
                 console.log(`Only ${playersInHandCountAfterLeave} player(s) left in hand after leaver. Ending hand.`);
                 endHand(table.id); // endHand handles win by default if 1 player, or pot lost if 0.
             }
        }

        // If the table becomes empty, delete it
        if (table.players.length === 0) {
            console.log(`Table ${table.name} (ID: ${table.id}) is now empty. Deleting table.`);
            delete activeTables[table.id];
             // broadcastUpdates will be called at the end to update the lobby.
        }

        // Inform the client that requested to leave that they have left the table
        socket.emit('left_table');

        // Broadcast updates (lobby list may change if table deleted, clients at active tables see player leave)
        broadcastUpdates();
    });


    // --- Listener 'chat_message' ---
    // Relays chat messages between users (lobby or table).
    socket.on('chat_message', (data)=>{
        const user = usersConnected[socket.id];
        // Only users with a username set can send messages
        if (!user?.username) {
            console.warn(`Chat message ignored from ${socket.id}: No username set.`);
            return socket.emit('error_message', 'Veuillez définir un pseudo pour chatter.');
        }

        const messageText = data?.text?.trim();
        if (!messageText) {
            // console.warn(`Empty chat message ignored from ${user.username}.`); // Too chatty
            return; // Ignore empty messages
        }

        const message = {
            user: user.username, // Sender's username
            text: messageText, // Message content
            timestamp: new Date().toISOString() // Add a timestamp (useful for client sorting)
        };

        console.log(`[CHAT] ${user.username}${user.currentTableId ? ` (Table ${user.currentTableId})` : ' (Lobby)'}: ${messageText}`);

        if (user.currentTableId !== null) {
            // If user is at a table, send message ONLY to other users at this table
            // io.to(roomId).emit() sends to all sockets IN that room, including the sender IF they joined the room.
            // Since the socket joins the table room in handleJoinTable, this is correct.
            io.to(user.currentTableId).emit('chat_message', message);
        } else {
            // Otherwise (user in lobby), send message to all users WHO ARE IN THE LOBBY.
            // There's no default "lobby room", so we need to target.
             Object.keys(usersConnected).forEach(sid => {
                 // Send message only to sockets of users who are NOT at a table (are in lobby)
                 if (usersConnected[sid].currentTableId === null) {
                     // io.sockets.sockets.get(sid) retrieves the socket object by ID
                     io.sockets.sockets.get(sid)?.emit('chat_message', message);
                 }
             });
        }
    });


    // --- Listener 'disconnect' ---
    // Handles a user disconnecting
    socket.on('disconnect', (reason) => {
        console.log(`🔥: User disconnected ${socket.id} (Reason: ${reason})`);

        const user = usersConnected[socket.id];

        // If the disconnected user was at a table, remove them cleanly
        if (user?.currentTableId !== null) {
            const table = activeTables[user.currentTableId];
             // Check that the table exists before trying to modify it
             if (table) {
                 const playerIndex = table.players.findIndex(p => p.socketId === socket.id);
                 if (playerIndex !== -1) {
                     const player = table.players[playerIndex];
                     console.log(`   -> User ${user.username || socket.id} (Seat ${player.seat}) was at table ${table.name} (ID: ${table.id}). Removing.`);

                     // Remove player from the list
                     table.players.splice(playerIndex, 1);

                     // Broadcast a disconnection message to the table
                     io.to(table.id).emit('chat_message', { system: true, text: `${user.username || 'Un joueur'} s'est déconnecté.` });

                     // Socket.IO automatically removes the socket from rooms on disconnect, so explicit leave is not strictly needed.

                     // --- Handle impacts on the current hand/game (simililar to leave_table) ---
                      // If the hand was in a betting stage AND it was the disconnected player's turn
                      const isBettingStage = table.stage && table.stage.includes('_betting');
                      if (table.status === 'playing' && isBettingStage && table.currentTurnSeat === player.seat) {
                           console.log(`Disconnected player had turn (Seat ${player.seat}) during betting stage. Advancing.`);
                           const nextPlayerSeat = findNextPlayerToAct(table, player.seat, true); // Find next player who can act
                           table.currentTurnSeat = nextPlayerSeat; // Can be null

                           // If no one can act after the disconnected player, the betting round is potentially over.
                           if (table.currentTurnSeat === null) {
                                console.log("No player found who can bet after disconnected player's turn. Checking round end state.");
                                 // Verify if all players IN HAND have matched the current bet or are all-in.
                                 const playersInHandAfterDisconnect = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out');
                                 const maxBetInStageAfterDisconnect = Math.max(0, ...playersInHandAfterDisconnect.map(p => p.betInStage));
                                 const allMatchedOrAllInAfterDisconnect = playersInHandAfterDisconnect.every(p => Math.abs(p.betInStage - maxBetInStageAfterDisconnect) < 0.001 || p.statusInHand === 'all_in'); // Use tolerance

                                 if (allMatchedOrAllInAfterDisconnect) {
                                     console.log("All players in hand matched/all-in after disconnect. Ending betting round.");
                                      progressToNextStage(table.id); // Go to next stage
                                 } else {
                                     console.error("Logic error: Disconnected player had turn, no subsequent player can act, but not all players in hand matched/all-in. Forcing hand end.");
                                     endHand(table.id); // Force hand end
                                 }
                           }
                      }

                     // Check if the hand must end (less than 2 players in hand remaining)
                     const playersInHandCountAfterDisconnect = table.players.filter(p => p.statusInHand !== 'folded' && p.statusInHand !== 'waiting' && p.statusInHand !== 'sitting_out').length;
                      if (playersInHandCountAfterDisconnect <= 1 && table.status === 'playing') { // Only if the hand was active
                          console.log(`Only ${playersInHandCountAfterDisconnect} player(s) left in hand after disconnect. Ending hand.`);
                           endHand(table.id); // endHand handles win by default if 1 player, or pot lost if 0.
                      }


                     // If the table becomes empty, delete it
                    if (table.players.length === 0) {
                        console.log(`Table ${table.name} (ID: ${table.id}) is now empty after disconnect. Deleting table.`);
                        delete activeTables[table.id];
                         // broadcastUpdates will be called at the end to update the lobby.
                    }
                 } else {
                      console.warn(`User ${user.username || socket.id} had currentTableId ${user.currentTableId} but player object not found in table's players list.`);
                      // State inconsistency, just clean up user state below.
                 }
             } else {
                  console.warn(`User ${user.username || socket.id} had currentTableId ${user.currentTableId} but table object is missing.`);
                  // State inconsistency, just clean up user state below.
             }
        } else {
             // The user was in the lobby
             // Broadcast a disconnection message in the global lobby chat
             io.emit('chat_message', { system: true, text: `${user?.username || 'Un joueur anonyme'} a quitté le lobby.` }); // Send to all for now
        }

        // Remove user from the list of connected users
        delete usersConnected[socket.id];
        console.log(`   -> ${user?.username || socket.id} removed from usersConnected.`);

        // Broadcast updates (lobby list potentially changed, active table changed for those remaining)
        broadcastUpdates();
    });

}); // End io.on('connection')


// Start the HTTP/Socket.IO server
server.listen(PORT, () => {
    console.log(`🚀 Server listening on port ${PORT}`);
});
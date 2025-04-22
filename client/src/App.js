// client/src/App.js

import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css'; // Import the CSS file for styling

// --- Card Component ---
// Component to display a single card
function Card({ card }) {
    if (!card) return <div className="card empty"></div>;
    const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
    const rank = card.substring(0, card.length - 1);
    const suit = card.substring(card.length - 1);
    // Use Pokersolver ranks 'T', 'J', 'Q', 'K', 'A' directly if present
    const displayRank = rank === 'T' ? '10' : rank; // Display '10' instead of 'T'


    const color = (suit === 'h' || suit === 'd') ? 'red' : 'black';

    return (
        <div className={`card suit-${suit} color-${color}`}>
            <span className="rank">{displayRank}</span>
            <span className="suit">{suitSymbols[suit]}</span>
        </div>
    );
}

// --- Player Cards Component ---
// Component to display a player's two hole cards (face up, face down, or mucked)
function PlayerCards({ player, isSelf }) {
    // Determine if cards should be displayed face up
    // 1. If it's the current user (isSelf)
    // 2. If the game is in showdown/complete stage AND player's showdownInfo exists and says to 'show' their hand
    const isShowdownPhase = player?.showdownInfo; // Check if showdown info is present for this player (implies showdown stage)
    const shouldShowFaceUp = isSelf || (isShowdownPhase && player.showdownInfo?.show === true);

    // Determine if cards should be displayed as backs
    // Server's `hasCards` property is true if player was dealt cards and didn't fold/sit out *initially*.
    // We show backs if hasCards is true AND cards are not face up AND player is still in hand (not folded/sitting out)
     const shouldShowBacks = player?.hasCards && !shouldShowFaceUp && player?.statusInHand !== 'folded' && player?.statusInHand !== 'sitting_out' && player?.statusInHand !== 'empty';


    // Check if player mucked their hand at showdown
    const hasMucked = isShowdownPhase && player.showdownInfo?.show === false;


    if (shouldShowFaceUp && player?.holeCards && player.holeCards.length === 2) {
         return (
             <div className="player-hole-cards">
                 <Card card={player.holeCards[0]} />
                 <Card card={player.holeCards[1]} />
             </div>
         );
    } else if (hasMucked) {
         // Explicitly show mucked state at showdown if the player *was* in showdownPlayers list
         // The server sends showdownInfo for all players who reached showdown state, even if they muck.
          // We only show the 'MUCK' visual if they reached showdown and explicitly mucked.
         return (
              <div className="player-hole-cards">
                  <div className="card mucked">MUCK</div> {/* Visual indicator for mucked */}
              </div>
         );
    } else if (shouldShowBacks) {
        // Display card backs if player had cards, but they are hidden
        return (
            <div className="player-hole-cards">
                <div className="card back"></div>
                <div className="card back"></div>
            </div>
        );
    } else {
        // Empty space if the player didn't have cards (e.g. joined late) or is folded/sitting out/empty seat
        return <div className="player-hole-cards empty"></div>;
    }
}


// --- Player Seat Component ---
// Represents a single player position around the table
function PlayerSeat({ player, isCurrentUser, tableDetails }) {
    // Determine player status class
    const playerStatusClass = player.statusInHand || ''; // Use statusInHand for classes

    // Check if it's this player's turn
    const isPlayerTurn = player.seat === tableDetails?.currentTurnSeat && tableDetails?.status === 'playing' && !(tableDetails?.stage?.includes('dealing')) && tableDetails?.stage !== 'showdown' && tableDetails?.stage !== 'showdown_complete';

    // Get showdown info if available and valid
     const showdownPlayerInfo = player?.showdownInfo; // showdownInfo is null if not in showdown stage


    // Determine player list item class name
    const listItemClassName = [
        `seat-${player.seat}`, // Class for positioning based on seat number (requires CSS rules per seat)
        playerStatusClass,
        isPlayerTurn ? 'current-turn' : '',
        // Apply winner class ONLY during or after showdown if they are marked as winner
        (tableDetails?.stage === 'showdown' || tableDetails?.stage === 'showdown_complete' || tableDetails?.status === 'finished') && showdownPlayerInfo?.isWinner ? 'winner' : '',
         // Add 'mucked' class during showdown stages if mucked
        (tableDetails?.stage === 'showdown' || tableDetails?.stage === 'showdown_complete' || tableDetails?.status === 'finished') && showdownPlayerInfo?.show === false ? 'mucked' : '',
        isCurrentUser ? 'current-user-seat' : '' // Special class for the current user's seat
    ].filter(Boolean).join(' ');


     // Determine if player info block should be visible (hide if seat is empty)
     const isSeatOccupied = player && player.statusInHand !== 'empty';


    return (
        <li key={player.seat} className={listItemClassName}>
            {isSeatOccupied ? (
                 <div className="player-area">
                     {/* Placeholder for Avatar */}
                     <div className="player-avatar"></div> {/* Add avatar styling */}

                     <div className="player-info-block">
                         <div className="player-name">
                             {player.username} {isCurrentUser ? '(Vous)' : ''}
                         </div>
                          <div className="player-status">
                                {/* Show Dealer button only when game is playing */}
                                {tableDetails?.status === 'playing' && player.seat === tableDetails?.dealerSeat ? ' (D)' : ''}
                                {player.statusInHand === 'all_in' ? ' (ALL-IN)' : ''}
                                {player.statusInHand === 'sitting_out' ? ' (Sit Out)' : ''}
                                 {isPlayerTurn && !isCurrentUser ? ' (Action...)' : ''}
                                   {/* Display winner indicator ONLY during/after showdown if they are marked as winner */}
                                    {(tableDetails?.stage === 'showdown' || tableDetails?.stage === 'showdown_complete' || tableDetails?.status === 'finished') && showdownPlayerInfo?.isWinner ? <span className="winner-indicator"> 🏆</span> : null}
                          </div>
                         <div className="player-stack">Stack: {player.stack}</div>
                         {/* Player Bet (visible only when betting and > 0) */}
                         {tableDetails?.status === 'playing' && tableDetails?.stage && tableDetails.stage.includes('_betting') && player.betInStage > 0 ? (
                              <div className="player-bet-chips">{player.betInStage}</div> // Add chip styling later
                         ) : null}
                     </div>

                     {/* Player Cards (handles face up/down based on state) */}
                     <PlayerCards player={player} isSelf={isCurrentUser} />

                     {/* Dealer button - Positioned absolutely on the li */}
                     {tableDetails?.status === 'playing' && player.seat === tableDetails?.dealerSeat ? (
                         <div className="dealer-button">D</div> // Add styling
                     ) : null}


                 </div>
            ) : (
                 <div className="empty-seat">Siège {player.seat}</div> // Placeholder for empty seats
            )}
        </li>
    );
}


// --- Main App Component ---
function App() {
    // --- App States ---
    const [isConnected, setIsConnected] = useState(false);
    const [username, setUsername] = useState('');
    const [isUsernameSet, setIsUsernameSet] = useState(false);
    const [error, setError] = useState('');
    const [usernameInput, setUsernameInput] = useState('');

    const [tables, setTables] = useState([]);
    const [tableNameInput, setTableNameInput] = useState('');
    const [smallBlindInput, setSmallBlindInput] = useState('1');
    const [bigBlindInput, setBigBlindInput] = useState('2');
    const [maxPlayersInput, setMaxPlayersInput] = useState('9');

    const [currentTableId, setCurrentTableId] = useState(null);
    const [activeTableDetails, setActiveTableDetails] = useState(null);

    const [messages, setMessages] = useState([]);
    const [messageInput, setMessageInput] = useState('');

    const [betAmountInput, setBetAmountInput] = useState('');

    // --- Refs ---
    const socketRef = useRef(null);
    const messagesEndRef = useRef(null);
     const previousTableStateRef = useRef({ stage: null, status: null }); // Ref to track previous stage/status for chat messages


    // --- Constants ---
    const MIN_PLAYERS_TO_START = 2; // Must match server


    // --- Effects ---

    // Effect to auto-scroll chat to bottom
    const scrollToBottom = () => {
        requestAnimationFrame(() => {
             messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
    };
    // Trigger scroll when messages change OR when the active table stage/status changes (for potential system messages added by this effect)
    useEffect(() => {
         scrollToBottom();
    }, [messages, activeTableDetails?.stage, activeTableDetails?.status]);


    // Effect to manage Socket.IO connection and listeners
    useEffect(() => {
        const socketIoUrl = process.env.REACT_APP_SOCKET_URL;
        if (!socketIoUrl) {
            console.error("ERREUR: La variable d'environnement REACT_APP_SOCKET_URL n'est pas définie !");
            setError("Configuration du serveur manquante.");
            setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: "Erreur: Configuration du serveur manquante (REACT_APP_SOCKET_URL)." }]);
            return;
        }
        console.log(`[CLIENT App.js] Tentative de connexion à : ${socketIoUrl}`);

        socketRef.current = io(socketIoUrl, {
            reconnectionAttempts: 5,
            reconnectionDelay: 1000,
             transports: ['websocket'] // Use websocket transport
        });
        const socket = socketRef.current;

        // --- Event Listeners ---
        socket.on('connect', () => {
            setIsConnected(true);
            setError('');
            console.log('[CLIENT App.js] Socket Connected');
            setMessages((prevMessages) => [...prevMessages, { system: true, text: "Connecté au serveur." }]);
             // Reset table state on new connection in case it was left dangling from a previous session
             setCurrentTableId(null);
             setActiveTableDetails(null);
             previousTableStateRef.current = { stage: null, status: null }; // Reset state trackers
        });

        socket.on('disconnect', (reason) => {
            setIsConnected(false);
            setCurrentTableId(null);
            setActiveTableDetails(null);
             previousTableStateRef.current = { stage: null, status: null }; // Reset state trackers
            setError('Déconnecté du serveur.');
            console.log(`[CLIENT App.js] Socket Disconnected: ${reason}`);
             setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: `Déconnecté du serveur. (${reason})` }]);
        });

        socket.on('connect_error', (err) => {
            // Avoid flooding error messages on temporary connect errors
            if (!error.includes('Erreur de connexion')) { // Simple check to avoid duplicates
                 setError(`Erreur de connexion: ${err.message}`);
                  setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: `Erreur de connexion: ${err.message}` }]);
            }
            console.error('[CLIENT App.js] Socket Connect Error:', err);
        });

        socket.on('username_set', (newUsername) => {
            console.log('>>> [CLIENT App.js] RECEIVED username_set:', newUsername);
            setUsername(newUsername);
            setIsUsernameSet(true);
            setError('');
            setUsernameInput('');
        });

        socket.on('username_error', (message) => {
            setError(`Erreur pseudo: ${message}`);
            setIsUsernameSet(false);
            console.warn('[CLIENT App.js] Received username_error:', message);
             setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: `Erreur pseudo: ${message}` }]);
        });

        socket.on('error_message', (message) => {
            setError(`Erreur: ${message}`);
            console.error('[CLIENT App.js] Received error_message:', message);
            setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: `Erreur serveur: ${message}` }]);
        });

        socket.on('update_table_list', (tablesData) => {
            console.log('[CLIENT App.js] Received update_table_list:', tablesData);
            if (Array.isArray(tablesData)) {
               setTables(tablesData);
            } else {
               console.error('[CLIENT App.js] Received invalid table list data:', tablesData);
            }
        });


        socket.on('update_active_table', (details) => {
             console.log('>>> [CLIENT App.js] RECEIVED update_active_table:', details);

             if (details && typeof details === 'object' && details.id) {
                const previousStage = previousTableStateRef.current.stage;
                const previousStatus = previousTableStateRef.current.status;
                const currentStage = details.stage;
                const currentStatus = details.status;

                // Use functional update for messages to avoid dependency on 'messages' state in effect
                 setMessages(prevMessages => {
                     let newMessages = [...prevMessages];
                      const timestamp = new Date().toISOString(); // Use consistent timestamp

                     // --- Chat messages based on game progression ---
                     // Only add system messages for transitions between stages/statuses
                     if (previousStage !== currentStage || previousStatus !== currentStatus) {
                          console.log(`Stage/Status Transition: ${previousStatus}/${previousStage} -> ${currentStatus}/${currentStage}`);

                          // Transitions *into* playing state
                          if ((previousStatus === 'waiting' || previousStatus === 'finished' || previousStatus === null) && currentStatus === 'playing') {
                               newMessages = [...newMessages, { system: true, text: "Une nouvelle main commence.", timestamp }];
                          }
                          // Transitions into betting stages after dealing (dealing messages handled by server chat now)
                          // Add messages for community cards dealt
                          if (previousStage === 'dealing' && currentStage === 'preflop_blinds') { // Transition after dealing hole cards (before blinds)
                                // No community cards yet
                          } else if ((previousStage === 'preflop_betting' || previousStage === 'preflop_blinds') && currentStage === 'flop_betting') {
                              if (details.communityCards && details.communityCards.length >= 3) {
                                    newMessages = [...newMessages, { system: true, text: `Le Flop est distribué : [ ${details.communityCards.slice(0, 3).join(', ')} ]`, timestamp }];
                              }
                          } else if (previousStage === 'flop_betting' && currentStage === 'turn_betting') {
                               if (details.communityCards && details.communityCards.length >= 4) {
                                    newMessages = [...newMessages, { system: true, text: `Le Turn est distribué : [ ${details.communityCards.slice(3, 4).join(', ')} ]`, timestamp }];
                               }
                          } else if (previousStage === 'turn_betting' && currentStage === 'river_betting') {
                               if (details.communityCards && details.communityCards.length >= 5) {
                                    newMessages = [...newMessages, { system: true, text: `La River est distribuée : [ ${details.communityCards.slice(4, 5).join(', ')} ]`, timestamp }];
                               }
                          }
                          // Transition to showdown (before results are shown)
                          else if (previousStage && previousStage.includes('_betting') && currentStage === 'showdown') {
                               newMessages = [...newMessages, { system: true, text: "Le tour de mise est terminé. Showdown !", timestamp }];
                          }
                          // Transition to showdown_complete (after results are calculated and distributed)
                          else if ((previousStage === 'showdown' || (previousStage && previousStage.includes('_betting') && currentStage !== 'showdown')) && currentStage === 'showdown_complete') {
                               // Results are now available - Add Showdown details to chat
                              if (details.showdownResults) {
                                   const winnerNames = Array.isArray(details.showdownResults.winners) ? details.showdownResults.winners.map(w => w.username).join(', ') : 'Aucun';
                                   const winningHandName = details.showdownResults.winningHandName || 'N/A';
                                   const winningHandDesc = details.showdownResults.winningHandDesc || 'No description';
                                   const potWon = details.showdownResults.potWon ?? 0;

                                  // Summary message
                                  if (Array.isArray(details.showdownResults.winners) && details.showdownResults.winners.length > 0) {
                                       const summaryText = winningHandName === "Wins by default"
                                        ? `Main terminée. ${winnerNames} gagne par défaut (${winningHandDesc}). Pot total : ${potWon}.`
                                        : `Main terminée. ${winnerNames} gagne${details.showdownResults.winners.length > 1 ? 'nt' : ''} avec un ${winningHandName} (${winningHandDesc}). Pot total : ${potWon}.`;
                                        newMessages = [...newMessages, { system: true, text: summaryText, timestamp }];
                                  } else {
                                      newMessages = [...newMessages, { system: true, text: `Main terminée. Aucun gagnant déclaré. Pot total : ${potWon}.`, timestamp }];
                                  }


                                  // Detailed Showdown Reveal messages
                                  if (Array.isArray(details.showdownResults.orderedShowdown) && details.showdownResults.orderedShowdown.length > 0) {
                                      newMessages = [...newMessages, { system: true, text: "--- Révélation des mains ---", timestamp }]; // Header

                                      details.showdownResults.orderedShowdown.forEach(sdPlayer => {
                                          let revealText = `${sdPlayer.username} (S${sdPlayer.seat})`;
                                          if (sdPlayer.show) {
                                               const cardString = Array.isArray(sdPlayer.holeCards) ? `[${sdPlayer.holeCards.join(', ')}]` : '[]';
                                               const handName = sdPlayer.hand?.name || 'Main inconnue';
                                               const handDesc = sdPlayer.hand?.desc && handName !== sdPlayer.hand?.desc ? ` - ${sdPlayer.hand.desc}` : ''; // Add desc if different from name
                                               revealText += ` montre ${cardString} (${handName}${handDesc}).`;
                                               if (sdPlayer.isWinner) revealText += " Gagne le pot.";
                                          } else {
                                               revealText += ` couche sa main (${sdPlayer.muckReason || 'raison inconnue'}).`;
                                          }
                                          newMessages = [...newMessages, { system: true, text: revealText, timestamp }];
                                      });
                                  }
                              } else {
                                   // Fallback if no showdownResults despite showdown_complete
                                    newMessages = [...newMessages, { system: true, text: `Main terminée (Showdown Complete). Pas de résultats détaillés disponibles.`, timestamp }];
                              }
                          } else if (currentStatus === 'waiting' && previousStatus !== 'waiting') {
                               // Transition back to waiting (e.g., after hand finished and players remain)
                               newMessages = [...newMessages, { system: true, text: "Table en attente de la prochaine main.", timestamp }];
                          }
                     }

                     // Ensure we don't add duplicate messages by checking timestamp and text? Or just trust the logic above adds them once per transition.
                     // For simplicity, just add the new messages generated by the transition logic.

                    return newMessages; // Return the updated message array
                 });


                // Update state AFTER handling messages to ensure UI reacts to latest data
                setActiveTableDetails(details);
                setCurrentTableId(details.id);
                setError('');


                // Store current states to become previous states for the next update
                previousTableStateRef.current = { stage: currentStage, status: currentStatus };


             } else {
                console.error('[CLIENT App.js] Received invalid active table details:', details);
                 // If table details are invalid, assume user is no longer at a valid table
                setCurrentTableId(null);
                setActiveTableDetails(null);
                 previousTableStateRef.current = { stage: null, status: null }; // Reset state trackers
                setError('Erreur lors de la réception des données de la table.');
                setMessages(prevMessages => [...prevMessages, { system: true, error: true, text: "Erreur lors du chargement des détails de la table.", timestamp: new Date().toISOString() }]);
             }
        });

        socket.on('left_table', () => {
            console.log('[CLIENT App.js] Received left_table');
            setCurrentTableId(null); // Reset table ID
            setActiveTableDetails(null); // Reset details
             previousTableStateRef.current = { stage: null, status: null }; // Reset state trackers
             // System message added by server now (handled by chat_message listener)
        });

        socket.on('chat_message', (message) => {
            console.log('[CLIENT App.js] Received chat_message:', message);
             // Validate and add message
            if (message && (message.text !== undefined || message.system !== undefined)) { // Ensure message has content
                // Add timestamp if not present (for messages from server) or use it
                if (!message.timestamp) message.timestamp = new Date().toISOString();
                setMessages((prevMessages) => [...prevMessages, message]);
            } else {
                console.warn('[CLIENT App.js] Received invalid chat message:', message);
            }
        });

        // --- Cleanup function ---
        return () => {
            if (socket) {
                // Consider emitting a 'leaving_app' event here if you want server to know user is closing tab/browser
                socket.disconnect(); // Disconnect socket on component unmount
                console.log('[CLIENT App.js] Socket cleanup: disconnected.');
            }
        };
    // Empty dependency array ensures this effect runs only once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);


    // --- UI Event Handlers ---

    // Handles username form submission
    const handleUsernameSubmit = (e) => {
        e.preventDefault();
        setError('');
        const trimmedUsername = usernameInput.trim();

        console.log(`[CLIENT App.js] handleUsernameSubmit: Trying with username='${trimmedUsername}', isConnected=${isConnected}, socketRef=${socketRef.current ? 'exists' : 'null'}`);

         if (!trimmedUsername || trimmedUsername.length < 3) {
             setError('Pseudo trop court (min 3 caractères).');
             return;
         }

        if (socketRef.current && isConnected) {
            console.log(`>>> [CLIENT App.js] EMITTING set_username: '${trimmedUsername}'`);
            socketRef.current.emit('set_username', trimmedUsername);
        } else {
            setError('Connexion au serveur non établie ou problème technique.');
            console.error('[CLIENT App.js] Cannot emit set_username', { socketExists: !!socketRef.current, connected: isConnected });
        }
    };

    // Handles sending a chat message
    const sendMessage = (e) => {
        e.preventDefault();
        const messageText = messageInput.trim();
        if (messageText && socketRef.current && isUsernameSet && isConnected) {
             console.log(`[CLIENT App.js] Emitting chat_message: ${messageText}`);
             socketRef.current.emit('chat_message', { text: messageText });
             setMessageInput('');
        } else if (!messageText) {
             // Ignore sending empty messages
        } else {
             setError('Pseudo/Connexion requis pour envoyer un message.');
             console.warn(`[CLIENT App.js] Cannot send chat message: `, {messageText, socket: !!socketRef.current, isUsernameSet, isConnected});
        }
    };

    // Handles create table form submission
    const handleCreateTableSubmit = (e) => {
        console.log("[CLIENT App.js] handleCreateTableSubmit called!");
        e.preventDefault();
        setError('');
        const name = tableNameInput.trim() || `${username}'s Table`;
        const sb = parseFloat(smallBlindInput); // Use parseFloat for potential decimal blinds
        const bb = parseFloat(bigBlindInput); // Use parseFloat
        const maxP = parseInt(maxPlayersInput, 10);

        // Validate inputs
        if (isNaN(sb) || sb <= 0 || isNaN(bb) || bb <= sb) {
            console.log(`   [handleCreateTableSubmit] Invalid blinds detected. SB: ${sb}, BB: ${bb}.`);
            setError('Blinds invalides (SB > 0, BB > SB).');
            return;
        }
         if (isNaN(maxP) || maxP < 2 || maxP > 10) {
             console.log(`   [handleCreateTableSubmit] Invalid max players detected: ${maxP}.`);
             setError('Nombre de joueurs invalide (entre 2 et 10).');
             return;
         }
         if (!isUsernameSet) {
              setError('Veuillez définir un pseudo d\'abord.');
              return;
         }
         if (currentTableId !== null) {
             setError('Vous êtes déjà à une table. Quittez-la d\'abord.');
             return;
         }


        const tableData = { name: name, smallBlind: sb, bigBlind: bb, maxPlayers: maxP };

        console.log(`   [handleCreateTableSubmit Debug] Checking conditions: socketRef=${!!socketRef.current}, isUsernameSet=${isUsernameSet}, isConnected=${isConnected}.`);
        if (socketRef.current && isConnected) { // isUsernameSet, currentTableId check above
            console.log(`   [handleCreateTableSubmit] Conditions met. Emitting 'create_table'... Data:`, tableData);
            socketRef.current.emit('create_table', tableData);
            // Reset inputs after emitting (client-side optimistic)
            setTableNameInput('');
            setSmallBlindInput('1');
            setBigBlindInput('2');
            setMaxPlayersInput('9');
            console.log("   [handleCreateTableSubmit] Inputs reset.");
        } else {
             setError('Connexion requise pour créer une table.');
             console.warn(`   [handleCreateTableSubmit] Conditions FAILED.`);
        }
        console.log("[CLIENT App.js] handleCreateTableSubmit finished.");
    };

    // Handles joining a table
    const handleJoinTable = (id) => {
        setError('');
        console.log(`[CLIENT App.js] handleJoinTable called for tableId: ${id}. Emitting 'join_table'.`);
        // Check user is connected, has username, is not already at a table, and socket is ready
         if (!isUsernameSet) {
             setError('Veuillez définir un pseudo pour rejoindre une table.');
             return;
         }
         if (currentTableId !== null) {
              setError('Vous êtes déjà à une table. Quittez-la d\'abord.');
              return;
         }


        if (socketRef.current && isConnected) { // isUsernameSet and currentTableId check above
            socketRef.current.emit('join_table', { tableId: id }); // Emit event
             // Client will receive 'update_active_table' or 'error_message'
        } else {
            setError('Impossible de rejoindre (Vérifiez connexion)');
            console.warn('[CLIENT App.js] Condition to join table failed:', {isUsernameSet, isConnected, currentTableId});
        }
    };

    // Handles leaving the current table
    const handleLeaveTable = () => {
        setError('');
         if (!socketRef.current || !isConnected) {
             setError('Connexion perdue.');
             return;
         }
        // Check user is at a table before emitting
        if (currentTableId) {
             console.log("[CLIENT App.js] Emitting 'leave_table'");
             socketRef.current.emit('leave_table'); // Emit event
             // State will be reset by 'left_table' listener if server confirms
        } else {
             setError('Vous n\'êtes pas à une table.');
             console.warn('[CLIENT App.js] Condition to leave table failed: not at table.');
        }
    };

    // Handles request to start game (for creator)
    const handleStartGame = () => {
        setError('');
        console.log(`[CLIENT App.js] handleStartGame called. Checking conditions...`);
        console.log(`  - socketRef: ${!!socketRef.current}, isUsernameSet: ${isUsernameSet}, isConnected: ${isConnected}.`);
        console.log(`  - currentTableId: ${currentTableId}, isCreator: ${activeTableDetails?.isCreator}.`);

        // Start button visibility conditions checked by 'canIStartGame' in JSX.
        // Re-validate here before emitting for double security.
         const eligiblePlayersForStart = activeTableDetails?.players?.filter(p => p.stack > 0.001 && (p.statusInHand === 'playing' || p.statusInHand === 'waiting' || p.statusInHand === 'sitting_out')) ?? []; // Use tolerance
         const isStartPossible = amIAtTable && activeTableDetails?.isCreator &&
                                (activeTableDetails?.status === 'waiting' || activeTableDetails?.status === 'finished') &&
                                eligiblePlayersForStart.length >= MIN_PLAYERS_TO_START;


        if (socketRef.current && isConnected && isStartPossible) { // isUsernameSet implicit in myPlayerData check
            console.log(`[CLIENT App.js] Conditions met. Requesting start game for table ${currentTableId}`);
            socketRef.current.emit('request_start_game', { tableId: currentTableId });
        } else {
            // Should ideally not happen if button is disabled/hidden correctly
            setError('Impossible de démarrer la partie. Vérifiez les conditions.');
            console.warn('[CLIENT App.js] Condition to start game failed inside handler.');
             if (!amIAtTable || !activeTableDetails?.isCreator) setError('Seul le créateur de la table peut démarrer la partie.');
             else if (activeTableDetails?.status !== 'waiting' && activeTableDetails?.status !== 'finished') setError('La partie ne peut être démarrée qu\'en statut "En attente" ou "Terminée".');
             else if (eligiblePlayersForStart.length < MIN_PLAYERS_TO_START) setError(`Il faut au moins ${MIN_PLAYERS_TO_START} joueurs avec des jetons pour démarrer.`);
             else setError('Connexion ou pseudo requis.');
        }
    };

    // Helper to emit player action
    const emitPlayerAction = (actionType, amount = 0) => {
        setError(''); // Clear previous errors on new action
        if (!socketRef.current || !isConnected) {
             setError('Connexion perdue. Impossible d\'envoyer l\'action.');
             console.warn('[CLIENT App.js] Cannot emit player action: no socket or not connected.');
             return;
        }
        if (!currentTableId) {
             setError("Impossible d'envoyer l'action (pas à une table).");
             console.warn('[CLIENT App.js] Cannot emit player action: not at table.');
             return;
        }
         // Basic validation for amount for bet/raise before sending (server will validate strictly)
         // Ensure amount is parsed as float for consistency
        const floatAmount = parseFloat(amount);
        if ((actionType === 'bet' || actionType === 'raise') && (isNaN(floatAmount) || floatAmount < 0)) {
             console.warn(`Invalid amount for ${actionType}: ${amount}`);
             setError("Montant invalide.");
             return;
        }


        console.log(`[CLIENT App.js] Emitting player_action: ${actionType}, Amount: ${floatAmount}`);
        socketRef.current.emit('player_action', { type: actionType, amount: floatAmount }); // Emit action to server
        // Don't clear input immediately for bet/raise, user might want to adjust quickly on error.
        // setBetAmountInput(''); // Clear the input after emitting action (optimistic)
    };

    // Handlers for specific actions
    const handleFold = () => emitPlayerAction('fold');
    const handleCheck = () => emitPlayerAction('check'); // Amount 0 is fine for check
    const handleCall = () => emitPlayerAction('call', amountToCall); // Send the amount needed to call (or stack if less)

    const handleBet = () => {
        const amount = parseFloat(betAmountInput);
        // Client-side validation (basic) - server does strict validation
        if (isNaN(amount) || amount <= 0) { setError("Montant de la mise invalide."); return; }
        // Use tolerance for comparisons with stack/blinds
        if (myPlayerData && amount > myPlayerData.stack + 0.001) { setError("Mise supérieure à votre stack."); return; }
         // Check min bet unless it's an all-in (Amount === player stack)
        if (activeTableDetails && amount < activeTableDetails.bigBlind - 0.001 && Math.abs(amount - (myPlayerData?.stack ?? 0)) > 0.001) {
             setError(`Mise min ${activeTableDetails.bigBlind} (ou All-in pour moins).`);
             return;
        }
        emitPlayerAction('bet', amount);
         setBetAmountInput(''); // Clear input on successful action emit

    };

    const handleRaise = () => {
        const amount = parseFloat(betAmountInput);
         // Client-side validation (basic) - server does strict validation
         if (isNaN(amount) || amount <= 0) { setError("Montant de la relance invalide."); return; } // Raise amount must be positive

         const currentBet = activeTableDetails?.currentBet ?? 0;
         // Cannot raise if amount <= currentBet (total amount must be higher)
          // Allow all-in = currentBet if stack < amount needed - This case should be handled by the All-in button.
          // The Raise button is for raises *greater* than currentBet.
          if (amount <= currentBet + 0.001) { // Use tolerance
              setError(`Le montant total de votre relance (${amount}) doit être strictement supérieur à la mise actuelle (${currentBet}).`);
              return;
          }

         // Calculate min raise total for client-side hint/validation
         // Min raise size is the size of the LAST raise (or BB if it's the first raise pre-flop after blinds). Use tolerance.
         const lastRaiseSize = activeTableDetails?.lastRaiseSize > 0.001 ? activeTableDetails.lastRaiseSize : (activeTableDetails?.bigBlind ?? 1);
         const minTotalRaiseRequired = parseFloat((currentBet + lastRaiseSize).toFixed(2)); // Calculate min total needed


         // Allow raise if amount is >= minTotalRaiseRequired OR it's an all-in
         // Note: An all-in that is less than the standard min raise is allowed by the server (if > call amount),
         // but won't enable the standard "Raise" button here unless it's an all-in *equal to or greater than* the min raise size.
         if (amount < minTotalRaiseRequired - 0.001 && Math.abs(amount - (myPlayerData?.stack ?? 0)) > 0.001) { // Use tolerance for comparison and all-in check
              setError(`Relance min totale ${minTotalRaiseRequired} (ou All-in pour moins).`);
              return;
         }

         if (myPlayerData && amount > myPlayerData.stack + 0.001) { setError("Relance supérieure à votre stack."); return; } // Add tolerance


        emitPlayerAction('raise', amount);
         setBetAmountInput(''); // Clear input on successful action emit
    };

    // Helper to handle All-in action
    const handleAllIn = () => {
        const myStack = myPlayerData?.stack ?? 0;
        if (myStack <= 0.001) { // Use tolerance for stack 0
            setError("Votre stack est vide.");
            return;
        }
         // If player is already All-in, button should be disabled via JSX. Check defensively.
         if (myPlayerData?.statusInHand === 'all_in') {
             console.warn("Attempted All-in action while status is already all-in.");
             return;
         }
         // Cannot all-in if not my turn (JSX should handle this)
          if (!isMyTurn) {
              setError("Impossible de faire All-in pour l'instant (pas votre tour).");
              console.warn("Attempted All-in action when not player's turn.");
              return;
          }


        // Server will determine if All-in is a bet or raise based on currentBet
        const currentBet = activeTableDetails?.currentBet ?? 0;
        // If currentBet is 0, it's a bet. If currentBet > 0, it's a raise (even if stack < min raise).
        const actionType = currentBet < 0.001 ? 'bet' : 'raise'; // Use tolerance
        console.log(`[CLIENT App.js] Attempting All-in action: Type=${actionType}, Amount=${myStack}`);
        // Send the action type ('bet' or 'raise') and the full stack amount. Server will validate.
        emitPlayerAction(actionType, myStack);
         setBetAmountInput(''); // Clear input on successful action emit
    };


    // --- Constants and logic for rendering (derived from state) ---
    const amIAtTable = currentTableId !== null && activeTableDetails !== null; // True if user is at a table

    // Find current player's data in the active table
    const myPlayerData = amIAtTable ? activeTableDetails.players.find(p => p.username === username) : null;

    // Is it my turn at all (regardless of status/stack)? Based on seat and table status/stage.
    // Not my turn during dealing or showdown/complete stages.
    const isMyTurn = amIAtTable && myPlayerData?.seat === activeTableDetails.currentTurnSeat && activeTableDetails.status === 'playing' && !(activeTableDetails.stage?.includes('dealing')) && activeTableDetails.stage !== 'showdown' && activeTableDetails.stage !== 'showdown_complete';


    // Can I make a standard action (Check, Call, Bet, Raise)? Requires turn, 'playing' status, and stack > 0.
     // Use tolerance for stack 0
    const isMyTurnAndCanAct = isMyTurn && myPlayerData?.statusInHand === 'playing' && (myPlayerData?.stack ?? 0) > 0.001;


    // Start game button visibility conditions
     const eligiblePlayersForStart = activeTableDetails?.players?.filter(p => p.stack > 0.001 && (p.statusInHand === 'playing' || p.statusInHand === 'waiting' || p.statusInHand === 'sitting_out')) ?? []; // Use tolerance
    const canIStartGame = amIAtTable && activeTableDetails?.isCreator &&
                          (activeTableDetails?.status === 'waiting' || activeTableDetails?.status === 'finished') &&
                          eligiblePlayersForStart.length >= MIN_PLAYERS_TO_START;


    // Conditions for enabling standard action buttons (Check, Call, Bet, Raise)
    const currentBet = activeTableDetails?.currentBet ?? 0;
    const playerBetInStage = myPlayerData?.betInStage ?? 0;
    const playerStack = myPlayerData?.stack ?? 0;
    const bigBlind = activeTableDetails?.bigBlind ?? 1;
    const lastRaiseSize = activeTableDetails?.lastRaiseSize ?? 0; // <-- Get lastRaiseSize from server state


    // Can Check: Is my turn AND (my betInStage matches currentBet OR currentBet is 0).
    // Player can be 'playing' or 'all_in' to check if bets match.
     const canCheck = isMyTurn && (myPlayerData?.statusInHand === 'playing' || myPlayerData?.statusInHand === 'all_in') && Math.abs(playerBetInStage - currentBet) < 0.001;


    // Can Call: Is my turn AND my betInStage is less than currentBet AND I have stack > 0 (to put chips in).
    // Includes players who are 'playing' or 'all_in'.
     const canCall = isMyTurn && (myPlayerData?.statusInHand === 'playing' || myPlayerData?.statusInHand === 'all_in') && playerStack > 0.001 && playerBetInStage < currentBet - 0.001; // Use tolerance
    const amountToCall = canCall ? parseFloat((currentBet - playerBetInStage).toFixed(2)) : 0; // Amount needed to call, rounded


    // Can Bet: Is my turn AND I can make a standard action ('playing' + stack > 0) AND there is no current bet.
    const canBet = isMyTurnAndCanAct && currentBet < 0.001; // Check if current bet is effectively zero

    // Can Raise: Is my turn and I can make a standard action (playing + stack > 0), there is a current bet > 0,
    // and player has enough stack for a standard raise total.
     // Use tolerance for lastRaiseSize and bigBlind
    const minAmountToAddForRaise = lastRaiseSize > 0.001 ? lastRaiseSize : (bigBlind > 0.001 ? bigBlind : 1); // Min raise size is last raise or BB (default 1 if BB is 0)
    const minTotalRaiseRequired = parseFloat((currentBet + minAmountToAddForRaise).toFixed(2)); // Calculate min total needed


    // Can raise if it's my turn AND I can make a standard action (playing + stack > 0), AND I'm facing a bet (currentBet > 0),
    // AND I have enough stack for a standard raise total.
    // Note: An all-in that is less than the standard min raise is allowed by the server (if > call amount),
    // but won't enable the standard "Raise" button here. The All-in button handles that case.
     // Use tolerance for stack check
    const canRaise = isMyTurnAndCanAct && currentBet > 0.001 && playerStack >= minTotalRaiseRequired - 0.001;


    // Minimum value for the bet/raise input for client-side hint and validation
     const minBetRaiseInputValue = currentBet < 0.001 ? (bigBlind > 0.001 ? bigBlind : 1) : minTotalRaiseRequired; // Use default 1 if BB is somehow 0
    // Ensure min input is not less than 0 and not more than player's stack
    const safeMinBetRaiseInputValue = Math.max(0, parseFloat(Math.min(minBetRaiseInputValue, playerStack).toFixed(2)) ); // Cap min at player stack


    // Can All-in: Is it my turn AND I have chips > 0.
    // This button is enabled whenever it's their turn AND they have chips > 0.
    // Server will determine if the all-in constitutes a Bet, Call, or Raise.
     const canAllIn = isMyTurn && playerStack > 0.001; // Use tolerance for stack 0


     // Is the game in a stage where showdown results are displayed?
     // This is now primarily driven by the presence of showdownResults data, used by the chat logic.
     // We no longer have a dedicated UI section for this.
     // const isShowdownVisible = activeTableDetails?.stage === 'showdown_complete' || activeTableDetails?.status === 'finished';


     // Prepare players data for mapping in the player list (create placeholders for empty seats)
     const playersInSeats = new Array(activeTableDetails?.maxPlayers || 9).fill(null); // Default to 9 seats if maxPlayers is null
      activeTableDetails?.players.forEach(p => {
          if (p?.seat && p.seat >= 1 && p.seat <= (activeTableDetails?.maxPlayers || 9)) {
              playersInSeats[p.seat - 1] = p;
          }
      });
     // Populate empty seats with placeholder objects
     for(let i = 0; i < playersInSeats.length; i++) {
          if(playersInSeats[i] === null) {
               playersInSeats[i] = { seat: i + 1, username: null, stack: 0, statusInHand: 'empty', holeCards: null, betInStage: 0, hasCards: false, showdownInfo: null };
          }
     }


    // --- Render UI ---
    return (
        <div className="App">
            <h1>Poker entre Amis</h1>
            {/* Display connection status and username */}
            <p>Status: {isConnected ? `Connecté ✅ ${username ? `(${username})` : ''}` : 'Déconnecté ❌'}</p>
            {/* Display error messages */}
            {error && <p className="error-message">{error}</p>}

            {/* Username Form: Show if connected but username not set */}
            {isConnected && !isUsernameSet && (
                <form onSubmit={handleUsernameSubmit} className="username-form">
                    <h2>Définir votre Pseudo</h2>
                    <input
                        type="text"
                        value={usernameInput}
                        onChange={(e) => setUsernameInput(e.target.value)}
                        placeholder="Entrez pseudo..."
                        required
                        disabled={!isConnected}
                         minLength={3}
                         maxLength={20}
                    />
                    <button type="submit" disabled={!isConnected || usernameInput.trim().length < 3}>Définir Pseudo</button>
                </form>
            )}

            {/* Main Content: Show only if username is set */}
            {isConnected && isUsernameSet && (
                <div className="main-content">
                    {!amIAtTable ? ( /* --- LOBBY --- */
                        <div className="lobby">
                            <h2>Tables Disponibles</h2>
                            {/* Ensure tables is an array before mapping */}
                            {Array.isArray(tables) && tables.length === 0 ? (<p>Aucune table n'est actuellement disponible.</p>) : (
                                <ul className="table-list">
                                    {Array.isArray(tables) && tables.map((t) => {
                                        // Disable join button if table is full OR user is already at a table OR game is in progress/dealing/showdown stages
                                         // A player can only join if table status is 'waiting' or 'finished'
                                        const isJoinDisabled = t.playerCount >= t.maxPlayers || !!currentTableId || (t.status !== 'waiting' && t.status !== 'finished');
                                         // Add a class for tables where game is in progress
                                        const listItemClassName = t.status === 'playing' ? 'table-in-progress' : '';

                                        return (
                                        <li key={t.id} className={listItemClassName}>
                                            <span>{t.name} ({t.playerCount}/{t.maxPlayers}) - SB/BB: {t.smallBlind}/{t.bigBlind} - Statut: {t.status}</span>
                                            <button onClick={() => handleJoinTable(t.id)} disabled={isJoinDisabled}>Rejoindre</button>
                                        </li>
                                    );})}
                                </ul>
                            )}
                            <div className="create-table-form">
                                <h3>Créer une Nouvelle Table</h3>
                                <form onSubmit={handleCreateTableSubmit}>
                                    <div><label htmlFor="tableName">Nom:</label><input type="text" id="tableName" value={tableNameInput} onChange={(e) => setTableNameInput(e.target.value)} placeholder={`${username}'s Table`} disabled={!!currentTableId} /></div>
                                    <div><label htmlFor="smallBlind">Small Blind:</label><input type="number" id="smallBlind" value={smallBlindInput} onChange={(e) => setSmallBlindInput(e.target.value)} min="0.01" step="0.01" disabled={!!currentTableId} /></div> {/* Allow decimals */}
                                    <div><label htmlFor="bigBlind">Big Blind:</label><input type="number" id="bigBlind" value={bigBlindInput} onChange={(e) => setBigBlindInput(e.target.value)} min="0.02" step="0.01" disabled={!!currentTableId} /></div> {/* Allow decimals */}
                                    <div><label htmlFor="maxPlayers">Joueurs Max:</label><input type="number" id="maxPlayers" value={maxPlayersInput} onChange={(e) => setMaxPlayersInput(e.target.value)} min="2" max="10" disabled={!!currentTableId} /></div>
                                    <button type="submit" disabled={!!currentTableId || parseFloat(smallBlindInput) <= 0 || parseFloat(bigBlindInput) <= parseFloat(smallBlindInput) || parseInt(maxPlayersInput, 10) < 2 || parseInt(maxPlayersInput, 10) > 10}>Créer Table</button>
                                </form>
                            </div>
                        </div>
                    ) : ( /* --- ACTIVE TABLE --- */
                        <div className="game-table-container"> {/* Wrapper for table area */}
                             {activeTableDetails ? (
                                 <>
                                     <div className="table-info-bar">
                                          <h2>Table : {activeTableDetails.name}</h2>
                                          <p>Blinds: {activeTableDetails.smallBlind}/{activeTableDetails.bigBlind} - Pot: {activeTableDetails.pot} - Phase: {activeTableDetails.stage || 'En attente...'}</p>
                                     </div>


                                    <div className="game-table-area"> {/* The main table oval area */}
                                        <div className="community-cards-area"> {/* Community cards and pot */}
                                            <div className="community-cards">
                                                {/* Display community cards */}
                                                {Array.isArray(activeTableDetails.communityCards) && activeTableDetails.communityCards.length > 0
                                                 ? activeTableDetails.communityCards.map((c, i) => <Card key={`comm-${i}`} card={c} />)
                                                 : <p>(Aucune carte commune pour l'instant)</p>}
                                            </div>
                                             <div className="pot-info">
                                                 Pot : {activeTableDetails.pot}
                                             </div>
                                        </div>

                                        {/* Player Seats - Use the playersInSeats array to render fixed positions */}
                                        <ul className="player-seats">
                                            {playersInSeats.map((player) => {
                                                 const isCurrentUser = player.username === username;
                                                 // Pass full player object, PlayerSeat handles null/empty
                                                 return (
                                                      <PlayerSeat
                                                          key={player.seat} // Use seat as key as it's unique per li
                                                          player={player}
                                                          isCurrentUser={isCurrentUser}
                                                          tableDetails={activeTableDetails} // Pass table details needed by PlayerSeat
                                                      />
                                                 );
                                            })}
                                        </ul>

                                    </div> {/* End game-table-area */}

                                     {/* Section for "Start Game" button */}
                                     {/* Display if is creator, table is waiting OR finished, and enough eligible players */}
                                     {canIStartGame && (
                                         <div className="start-game-section">
                                             <button onClick={handleStartGame} className="start-game-button" disabled={!canIStartGame}>
                                                 {activeTableDetails.status === 'finished' ? 'Démarrer Nouvelle Main' : 'Démarrer Partie'} ({eligiblePlayersForStart.length} J éligibles)
                                             </button>
                                         </div>
                                     )}

                                    {/* Section for current player actions - Displayed at the bottom fixed area */}
                                    {/* This section displays if it's potentially my turn, regardless of status, to show action status */}
                                    {isMyTurn && myPlayerData && (
                                        <div className="game-actions">
                                            {/* Display player's status and stack in the actions section title */}
                                            <h4>
                                                Votre Action
                                                {myPlayerData.statusInHand === 'playing' ? ' (Stack: ' : ' ('}
                                                {myPlayerData.statusInHand === 'all_in' ? 'ALL-IN Stack: ' : ''}
                                                {myPlayerData.statusInHand === 'sitting_out' ? 'Sit Out Stack: ' : ''}
                                                {playerStack}) {/* Use playerStack variable for consistency */}
                                            </h4>

                                            {/* Actions possible if it's my turn (depends on status) */}
                                            {/* Fold is always an option if it's my turn and not folded/waiting/sitting_out */}
                                             { myPlayerData.statusInHand !== 'folded' && myPlayerData.statusInHand !== 'waiting' && myPlayerData.statusInHand !== 'sitting_out' && (
                                                 <button onClick={handleFold} disabled={!isMyTurn}>Fold</button>
                                             )}


                                            {/* Checkable if betInStage == currentBet */}
                                            { canCheck && (
                                                 <button onClick={handleCheck} disabled={!isMyTurn}>Check</button>
                                            )}

                                            {/* Callable if betInStage < currentBet AND stack > 0 */}
                                             { canCall && playerStack > 0.001 && ( // Redundant playerStack > 0.001 check, canCall includes it
                                                   <button onClick={handleCall} disabled={!isMyTurn}>Call {amountToCall > 0 ? amountToCall : ''}</button>
                                             )}


                                            {/* Section for Bet and Raise with input - Visible if I am 'playing' and Stack > 0 */}
                                             { isMyTurnAndCanAct && ( // isMyTurnAndCanAct already checks 'playing' + stack > 0
                                                <div className="bet-raise-section">
                                                     {/* Input is for the TOTAL bet/raise amount */}
                                                     <input
                                                         type="number"
                                                         value={betAmountInput}
                                                         onChange={(e) => setBetAmountInput(e.target.value)}
                                                          // Placeholder changes depending on whether it's a bet or raise
                                                         placeholder={currentBet < 0.001 ? `Min ${safeMinBetRaiseInputValue}` : `Min Total ${safeMinBetRaiseInputValue}`}
                                                         min={currentBet < 0.001 ? (activeTableDetails?.bigBlind > 0.001 ? activeTableDetails.bigBlind : 1) : minTotalRaiseRequired} // Logical minimum based on rules (use 1 as default if BB is 0 or less)
                                                         step="any" // Allow decimals for small blinds/stacks
                                                         disabled={!isMyTurnAndCanAct} // Disabled if cannot perform standard action (playing + stack > 0)
                                                         className="bet-input"
                                                         // Set initial value if the player has a bet already in this stage (helps with raising UI)
                                                         // defaultValue={playerBetInStage > 0 ? playerBetInStage : ''} // Removed defaultValue to allow blank input
                                                     />
                                                     {/* Bet/Raise Buttons: enabled if possible and input has a valid positive value */}
                                                     {/* Bet button appears only if currentBet is effectively 0 and I can act */}
                                                     { canBet && ( // canBet already checks currentBet < 0.001 and isMyTurnAndCanAct
                                                          <button onClick={handleBet} disabled={!isMyTurnAndCanAct || !betAmountInput || parseFloat(betAmountInput) < (activeTableDetails?.bigBlind > 0.001 ? activeTableDetails.bigBlind : 1)}>Bet</button> // Use BB as min bet client-side
                                                     )}
                                                     {/* Raise button appears only if currentBet > 0 and I can act */}
                                                     { canRaise && ( // canRaise already checks currentBet > 0.001 and isMyTurnAndCanAct and stack >= minTotalRaiseRequired
                                                          <button onClick={handleRaise} disabled={!isMyTurnAndCanAct || !betAmountInput || parseFloat(betAmountInput) < minTotalRaiseRequired}>Raise</button> // Use minTotalRaiseRequired client-side
                                                     )}

                                                </div>
                                            )}

                                            {/* All-in Button - Appears if I have chips and it's my turn */}
                                             { canAllIn && ( // canAllIn already checks isMyTurn + stack > 0
                                                 // Disable if already all-in (defensive)
                                                 <button onClick={handleAllIn} className="allin-button" disabled={!canAllIn || myPlayerData?.statusInHand === 'all_in'}>All-in ({playerStack})</button>
                                              )}


                                             {/* Message and actions if it's my turn but I'm all-in (statusInHand === 'all_in') with stack 0 */}
                                             {/* This block is for players who *are* already all-in and it's their turn, and stack is effectively 0 */}
                                             {isMyTurn && myPlayerData?.statusInHand === 'all_in' && playerStack <= 0.001 && (
                                                  <>
                                                       {/* Stack is 0, can only Fold or wait */}
                                                       { /* If betInStage < currentBet and stack 0, they can only Fold */ }
                                                        { (myPlayerData?.betInStage ?? 0) < (activeTableDetails?.currentBet ?? 0) - 0.001 ? ( // Use tolerance
                                                            <p>Vous êtes All-in pour moins que la mise actuelle. Vous pouvez Fold.</p>
                                                       ) : ( // BetInStage >= currentBet (matched or exceeded, but stack 0 so matched/exceeded up to 0)
                                                            <p>Vous êtes All-in et avez égalé ou dépassé la mise actuelle (avec votre stack restant). Attendez la fin de la main.</p>
                                                       )}
                                                        {/* Allow fold action for all-in player if facing bet */}
                                                          {(myPlayerData?.betInStage ?? 0) < (activeTableDetails?.currentBet ?? 0) - 0.001 && ( // Use tolerance
                                                              <button onClick={handleFold} disabled={!isMyTurn}>Fold</button>
                                                          )}
                                                  </>
                                             )}

                                              {/* Message if it's my turn but stack is 0 or status is sitting_out/waiting */}
                                              {/* This case is for players who are NOT 'all_in' but have stack 0 or are sitting_out/waiting */}
                                             {isMyTurn && (playerStack <= 0.001 || myPlayerData?.statusInHand === 'sitting_out' || myPlayerData?.statusInHand === 'waiting') && myPlayerData?.statusInHand !== 'all_in' && (
                                                  <div className="game-actions">
                                                        <h4>Votre Action (Stack: {playerStack} - {myPlayerData?.statusInHand === 'sitting_out' ? 'Sit Out' : (myPlayerData?.statusInHand === 'waiting' ? 'En attente' : 'Stack 0')})</h4>
                                                        <p>Vous ne pouvez pas effectuer d'action avec votre stack actuel ou votre statut ({myPlayerData?.statusInHand}).</p>
                                                        {/* No action buttons available */}
                                                  </div>
                                             )}

                                              {/* Message if it's someone else's turn */}
                                             {!isMyTurn && activeTableDetails?.status === 'playing' && !(activeTableDetails.stage?.includes('dealing')) && activeTableDetails.stage !== 'showdown' && activeTableDetails.stage !== 'showdown_complete' && activeTableDetails.currentTurnSeat !== null && activeTableDetails.players.length > 0 && (
                                                <p>En attente de l'action de {activeTableDetails.players.find(p => p.seat === activeTableDetails.currentTurnSeat)?.username || `joueur au siège ${activeTableDetails.currentTurnSeat}`}...</p>
                                             )}
                                              {/* Message if game is playing but nobody has the turn (intermediate stage or error) */}
                                              {activeTableDetails?.status === 'playing' && (activeTableDetails.stage?.includes('dealing') || activeTableDetails.stage === 'showdown' || activeTableDetails.stage === 'showdown_complete') && (
                                                  <p>Phase de jeu en cours ({activeTableDetails.stage}). Attendez la prochaine action ou main.</p>
                                              )}
                                              {/* Message if game is not playing */}
                                               {activeTableDetails?.status !== 'playing' && (
                                                    <p>Attente de {activeTableDetails.players.length < (activeTableDetails?.maxPlayers || 9) ? 'joueurs...' : 'démarrage de la main...'}</p>
                                               )}


                                        </div>
                                    )}


                                    {/* "Leave Table" button */}
                                    <button onClick={handleLeaveTable} className="leave-button">Quitter la Table</button>
                                 </>
                            ) : (
                                <p>Chargement des détails de la table...</p> // Message during loading (shouldn't happen if currentTableId is not null)
                            )}
                        </div>
                    )}

                    {/* --- CHAT --- */}
                    <div className="chat-box">
                        <h2>Chat</h2>
                        <div className="messages">
                            {messages.map((m, i) => (
                                // Add a unique key prop for list rendering efficiency
                                <p key={i} className={m.system ? (m.error ? 'system-error-message' : 'system-message') : 'user-message'}>
                                    {m.system ? (m.error ? '❗' : 'ℹ️') + ' ' + m.text : <><strong>{m.user}:</strong> {m.text}</>}
                                </p>
                            ))}
                            <div ref={messagesEndRef} /> {/* Element to scroll to */}
                        </div>
                        {/* Message sending form */}
                        <form onSubmit={sendMessage} className="message-form">
                            <input
                                type="text"
                                value={messageInput}
                                onChange={(e) => setMessageInput(e.target.value)}
                                placeholder={isConnected && isUsernameSet ? (amIAtTable ? "Envoyer un message à la table..." : "Envoyer un message au lobby...") : "Connectez-vous pour chatter..."}
                                disabled={!isConnected || !isUsernameSet}
                            />
                            <button type="submit" disabled={!isConnected || !isUsernameSet || messageInput.trim().length === 0}>Envoyer</button>
                        </form>
                    </div>
                </div>
            )}

            {/* Message if not connected and username not set (Initial state) */}
            {!isConnected && !isUsernameSet && <p>En attente de connexion au serveur...</p>}
        </div>
    );
}

// Export the App component
export default App;

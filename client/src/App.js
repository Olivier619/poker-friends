// client/src/App.js

import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

// --- Composants Card, PlayerCards ---

// Composant pour afficher une seule carte
function Card({ card }) {
    if (!card) return <div className="card empty"></div>; // Carte vide si pas de données
    const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
    // Extrait le rang et la couleur (le dernier caractère est la couleur)
    const rank = card.substring(0, card.length - 1);
    const suit = card.substring(card.length - 1);
    const color = (suit === 'h' || suit === 'd') ? 'red' : 'black';

    return (
        <div className={`card suit-${suit} color-${color}`}>
            <span className="rank">{rank}</span>
            <span className="suit">{suitSymbols[suit]}</span>
        </div>
    );
}

// Composant pour afficher les deux cartes fermées d'un joueur
// Receives the player object which now includes showdownInfo
function PlayerCards({ player, isSelf }) {
    // Determine if cards should be displayed face up
    // 1. If it's the current user (isSelf)
    // 2. If the game is in showdown/complete stage AND player's showdownInfo says to 'show' their hand
    const shouldShowFaceUp = isSelf || (player?.showdownInfo?.show === true);

    // Determine if cards should be displayed as backs
    // Player had cards dealt IF they are currently 'playing' or 'all_in'
    const playerHadCards = player?.statusInHand === 'playing' || player?.statusInHand === 'all_in';
    // Show backs if player had cards, but they are NOT being shown face up right now, and they didn't fold or muck.
    // Server's `hasCards` property is simpler and designed for this. Let's use that.
    const shouldShowBacks = player?.hasCards && !shouldShowFaceUp && player?.statusInHand !== 'folded' && player?.statusInHand !== 'sitting_out';

    // Check if player mucked their hand at showdown
    const hasMucked = player?.showdownInfo?.show === false;

    if (shouldShowFaceUp && player?.holeCards && player.holeCards.length === 2) {
         return (
             <div className="player-hole-cards">
                 <Card card={player.holeCards[0]} />
                 <Card card={player.holeCards[1]} />
             </div>
         );
    } else if (hasMucked) {
         // Explicitly show mucked state at showdown
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
        // Empty space if the player didn't have cards or is folded/sitting out
        return <div className="player-hole-cards empty"></div>;
    }
}

// --- Composant Principal App ---
function App() {
    // --- États de l'application ---
    const [isConnected, setIsConnected] = useState(false); // État de la connexion Socket.IO
    const [username, setUsername] = useState(''); // Pseudo de l'utilisateur actuel
    const [isUsernameSet, setIsUsernameSet] = useState(false); // Pseudo défini ?
    const [error, setError] = useState(''); // Messages d'erreur à afficher
    const [usernameInput, setUsernameInput] = useState(''); // Input pour le pseudo

    const [tables, setTables] = useState([]); // Liste des tables disponibles dans le lobby
    const [tableNameInput, setTableNameInput] = useState(''); // Input pour nom de table
    const [smallBlindInput, setSmallBlindInput] = useState('1'); // Input Small Blind
    const [bigBlindInput, setBigBlindInput] = useState('2'); // Input Big Blind
    const [maxPlayersInput, setMaxPlayersInput] = useState('9'); // Input Max Players

    const [currentTableId, setCurrentTableId] = useState(null); // ID de la table actuelle si l'utilisateur est à une table
    const [activeTableDetails, setActiveTableDetails] = useState(null); // Détails complets de la table active

    const [messages, setMessages] = useState([]); // Messages du chat
    const [messageInput, setMessageInput] = useState(''); // Input pour le chat

    const [betAmountInput, setBetAmountInput] = useState(''); // Input pour les montants de bet/raise

    // --- Références ---
    const socketRef = useRef(null); // Référence pour l'instance Socket.IO
    const messagesEndRef = useRef(null); // Référence pour scroller le chat
     const previousTableStateRef = useRef({ stage: null, status: null }); // Ref to track previous stage/status for chat messages

    // --- Constantes ---
    const MIN_PLAYERS_TO_START = 2; // Nombre minimum de joueurs pour commencer une main (doit matcher le serveur)

    // --- Effets ---

    // Effect to auto-scroll chat to bottom
    const scrollToBottom = () => {
        requestAnimationFrame(() => {
             messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
        });
    };
    // Trigger scroll when messages change OR when the active table stage/status changes (for potential system messages)
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
            reconnectionDelay: 1000
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
            setError(`Erreur de connexion: ${err.message}`);
            console.error('[CLIENT App.js] Socket Connect Error:', err);
            // Use a ref for messages state access within this effect's closure
             // eslint-disable-next-line react-hooks/exhaustive-deps
             // Note: Accessing `messages` state directly here violates exhaustive-deps rule, but adding it
             // would cause infinite re-renders on messages. Ref is better, or just ignore the rule here.
             // Using the ignore rule here as intended for this pattern
             if (!messages.some(m => m.text?.includes('Erreur de connexion') && (Date.now() - new Date(m.timestamp || Date.now()).getTime() < 5000))) { // Check for recent similar message
                 setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: `Erreur de connexion: ${err.message}` }]);
             }
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

        // Use a ref for previous state tracking to avoid unnecessary effect re-runs
        // previousTableStateRef initialized outside the effect.


        socket.on('update_active_table', (details) => {
             console.log('>>> [CLIENT App.js] RECEIVED update_active_table:', details);

             if (details && typeof details === 'object' && details.id) {
                const previousStage = previousTableStateRef.current.stage;
                const previousStatus = previousTableStateRef.current.status;
                const currentStage = details.stage;
                const currentStatus = details.status;

                // Update state FIRST so the rendering logic has the latest data
                setActiveTableDetails(details);
                setCurrentTableId(details.id);
                setError('');

                // --- Chat messages based on game progression ---
                // Only add system messages for transitions between stages/statuses
                if (previousStage !== currentStage || previousStatus !== currentStatus) {
                     console.log(`Stage/Status Transition: ${previousStatus}/${previousStage} -> ${currentStatus}/${currentStage}`);

                     // Transitions *into* playing state
                     if ((previousStatus === 'waiting' || previousStatus === 'finished' || previousStatus === null) && currentStatus === 'playing') {
                          setMessages((prevMessages) => [...prevMessages, { system: true, text: "Une nouvelle main commence." }]);
                     }
                     // Transitions into betting stages after dealing (dealing messages handled by server chat now)
                     else if (previousStage === 'dealing_flop' && currentStage === 'flop_betting') {
                         setMessages((prevMessages) => [...prevMessages, { system: true, text: "Le Flop est distribué." }]);
                     } else if (previousStage === 'dealing_turn' && currentStage === 'turn_betting') {
                         setMessages((prevMessages) => [...prevMessages, { system: true, text: "Le Turn est distribué." }]);
                     } else if (previousStage === 'dealing_river' && currentStage === 'river_betting') {
                         setMessages((prevMessages) => [...prevMessages, { system: true, text: "La River est distribuée." }]);
                     }
                     // Transition to showdown (before results are shown)
                     else if (previousStage && previousStage.includes('_betting') && currentStage === 'showdown') {
                          setMessages((prevMessages) => [...prevMessages, { system: true, text: "Le tour de mise est terminé. Showdown !" }]);
                     }
                     // Transition to showdown_complete (after results are calculated and distributed)
                     else if ((previousStage === 'showdown' || (previousStage && previousStage.includes('_betting'))) && currentStage === 'showdown_complete') { // Also handle direct jump from betting to complete
                          // Results are now available
                         if (details.showdownResults) {
                              const winnerNames = details.showdownResults.winners.map(w => w.username).join(', ');
                              const winningHandText = details.showdownResults.winningHandName === "Wins by default"
                               ? `(${details.showdownResults.winningHandDesc})` // For win by default, use desc
                               : details.showdownResults.winningHandName ? `: ${details.showdownResults.winningHandName}` : ''; // For showdown, show hand name

                             setMessages((prevMessages) => [...prevMessages, { system: true, text: `Main terminée. ${winnerNames} gagne${details.showdownResults.winners.length > 1 ? 'nt' : ''} ${winningHandText}. Pot total : ${details.showdownResults.potWon}.` }]);
                         } else {
                              // Fallback if no showdownResults despite showdown_complete
                               setMessages((prevMessages) => [...prevMessages, { system: true, text: `Main terminée (Showdown Complete).` }]);
                         }
                     } else if (currentStatus === 'waiting' && previousStatus !== 'waiting') {
                          // Transition back to waiting (e.g., after hand finished and players remain)
                          setMessages((prevMessages) => [...prevMessages, { system: true, text: "Table en attente de la prochaine main." }]);
                     }
                }

                // Store current states to become previous states for the next update
                previousTableStateRef.current = { stage: currentStage, status: currentStatus };


             } else {
                console.error('[CLIENT App.js] Received invalid active table details:', details);
                 // If table details are invalid, assume user is no longer at a valid table
                setCurrentTableId(null);
                setActiveTableDetails(null);
                 previousTableStateRef.current = { stage: null, status: null }; // Reset state trackers
                setError('Erreur lors de la réception des données de la table.');
                setMessages((prevMessages) => [...prevMessages, { system: true, error: true, text: "Erreur lors du chargement des détails de la table." }]);
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
        const sb = parseInt(smallBlindInput, 10);
        const bb = parseInt(bigBlindInput, 10);
        const maxP = parseInt(maxPlayersInput, 10);

        // Validate inputs
        if (isNaN(sb) || sb <= 0 || isNaN(bb) || bb <= sb) {
            console.log(`   [handleCreateTableSubmit] Invalid blinds detected. SB: ${sb}, BB: ${bb}`);
            setError('Blinds invalides (SB > 0, BB > SB).');
            return;
        }
         if (isNaN(maxP) || maxP < 2 || maxP > 10) {
             console.log(`   [handleCreateTableSubmit] Invalid max players detected: ${maxP}`);
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

        console.log(`   [handleCreateTableSubmit Debug] Checking conditions: socketRef=${!!socketRef.current}, isUsernameSet=${isUsernameSet}, isConnected=${isConnected}`);
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
        console.log(`  - socketRef: ${!!socketRef.current}, isUsernameSet: ${isUsernameSet}, isConnected: ${isConnected}`);
        console.log(`  - currentTableId: ${currentTableId}, isCreator: ${activeTableDetails?.isCreator}`);

        // Start button visibility conditions checked by 'canIStartGame' in JSX.
        // Re-validate here before emitting for double security.
         const eligiblePlayersForStart = activeTableDetails?.players?.filter(p => p.stack > 0 && (p.statusInHand === 'playing' || p.statusInHand === 'waiting' || p.statusInHand === 'sitting_out')) ?? [];
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
             // Optional: provide specific error message based on which condition failed
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
        if ((actionType === 'bet' || actionType === 'raise') && (isNaN(amount) || amount < 0)) {
             console.warn(`Invalid amount for ${actionType}: ${amount}`);
             setError("Montant invalide."); // Specific errors for bet/raise handled in their functions
             return;
        }
        // Ensure amount is parsed as float for consistency
        const floatAmount = parseFloat(amount);
        if (isNaN(floatAmount) || floatAmount < 0) { // Should not happen with initial check but safety
             console.warn(`Amount not a valid number after parseFloat: ${amount}`);
             setError("Montant invalide.");
             return;
        }


        console.log(`[CLIENT App.js] Emitting player_action: ${actionType}, Amount: ${floatAmount}`);
        socketRef.current.emit('player_action', { type: actionType, amount: floatAmount }); // Emit action to server
        setBetAmountInput(''); // Clear the input after emitting action (optimistic)
    };

    // Handlers for specific actions
    const handleFold = () => emitPlayerAction('fold');
    const handleCheck = () => emitPlayerAction('check');
    const handleCall = () => emitPlayerAction('call'); // Amount 0 is fine for call, server uses currentBet - betInStage

    const handleBet = () => {
        const amount = parseFloat(betAmountInput);
        // Client-side validation (basic) - server does strict validation
        if (isNaN(amount) || amount <= 0) { setError("Montant de la mise invalide."); return; }
        if (myPlayerData && amount > myPlayerData.stack + 0.001) { setError("Mise supérieure à votre stack."); return; } // Add tolerance
         // Check min bet unless it's an all-in
        if (activeTableDetails && amount < activeTableDetails.bigBlind && Math.abs(amount - myPlayerData?.stack) > 0.001) { // Add tolerance for all-in check
             setError(`Mise min ${activeTableDetails.bigBlind} (ou All-in pour moins).`);
             return;
        }

        emitPlayerAction('bet', amount);
    };

    const handleRaise = () => {
        const amount = parseFloat(betAmountInput);
         // Client-side validation (basic) - server does strict validation
         if (isNaN(amount) || amount <= 0) { setError("Montant de la relance invalide."); return; } // Raise amount must be positive

         const currentBet = activeTableDetails?.currentBet ?? 0;
         // Cannot raise if amount <= currentBet (total amount must be higher)
          if (amount <= currentBet + 0.001 && Math.abs(amount - myPlayerData?.stack) > 0.001) { // Allow all-in = currentBet if stack < amount needed, add tolerance
              setError(`Le montant total de votre relance (${amount}) doit être strictement supérieur à la mise actuelle (${currentBet}).`);
              return;
          }

         // Calculate min raise total for client-side hint/validation
         // Min raise size is the size of the LAST raise (or BB if no prior raise)
         const lastRaiseSize = activeTableDetails?.lastRaiseSize ?? 0;
         const bigBlind = activeTableDetails?.bigBlind ?? 1;
         const minAmountToAdd = lastRaiseSize > 0 ? lastRaiseSize : bigBlind; // Size to add is last raise size or BB
         const minTotalRaiseRequired = parseFloat((currentBet + minAmountToAdd).toFixed(2)); // Calculate min total needed


         // Allow raise if amount is >= minTotalRaiseRequired OR it's an all-in
         if (amount < minTotalRaiseRequired && Math.abs(amount - myPlayerData?.stack) > 0.001) { // Add tolerance for all-in check
              setError(`Relance min totale ${minTotalRaiseRequired} (ou All-in pour moins).`);
              return;
         }

         if (myPlayerData && amount > myPlayerData.stack + 0.001) { setError("Relance supérieure à votre stack."); return; } // Add tolerance


        emitPlayerAction('raise', amount);
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
        const actionType = currentBet === 0 ? 'bet' : 'raise';
        console.log(`[CLIENT App.js] Attempting All-in action: Type=${actionType}, Amount=${myStack}`);
        // Send the action type ('bet' or 'raise') and the full stack amount. Server will validate.
        emitPlayerAction(actionType, myStack);
    };


    // --- Constants and logic for rendering (derived from state) ---
    const amIAtTable = currentTableId !== null && activeTableDetails !== null; // True if user is at a table

    // Find current player's data in the active table
    const myPlayerData = amIAtTable ? activeTableDetails.players.find(p => p.username === username) : null;

    // Is it my turn at all (regardless of status/stack)? Based on seat and table status/stage.
    // Not my turn during dealing or showdown/complete stages.
    const isMyTurn = amIAtTable && myPlayerData?.seat === activeTableDetails.currentTurnSeat && activeTableDetails.status === 'playing' && !(activeTableDetails.stage?.includes('dealing')) && activeTableDetails.stage !== 'showdown' && activeTableDetails.stage !== 'showdown_complete';


    // Can I make a standard action (Check, Call, Bet, Raise)? Requires turn, 'playing' status, and stack > 0.
    const isMyTurnAndCanAct = isMyTurn && myPlayerData?.statusInHand === 'playing' && (myPlayerData?.stack ?? 0) > 0.001; // Use tolerance for stack 0


    // Start game button visibility conditions
    const eligiblePlayersForStart = activeTableDetails?.players?.filter(p => p.stack > 0 && (p.statusInHand === 'playing' || p.statusInHand === 'waiting' || p.statusInHand === 'sitting_out')) ?? [];
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
     const canCall = isMyTurn && (myPlayerData?.statusInHand === 'playing' || myPlayerData?.statusInHand === 'all_in') && playerStack > 0.001 && playerBetInStage < currentBet;
    const amountToCall = canCall ? parseFloat((currentBet - playerBetInStage).toFixed(2)) : 0; // Amount needed to call, rounded


    // Can Bet: Is my turn AND I can make a standard action ('playing' + stack > 0) AND there is no current bet.
    const canBet = isMyTurnAndCanAct && currentBet < 0.001; // Check if current bet is effectively zero

    // Can Raise: Is my turn and I can make a standard action (playing + stack > 0), there is a current bet > 0,
    // and player has enough stack for a standard raise total.
    const minAmountToAddForRaise = lastRaiseSize > 0 ? lastRaiseSize : bigBlind; // Size to add is last raise size or BB
    const minTotalRaiseRequired = parseFloat((currentBet + minAmountToAddForRaise).toFixed(2)); // Total amount needed for a standard raise


    // Can raise if it's my turn AND I can make a standard action (playing + stack > 0), AND I'm facing a bet (currentBet > 0),
    // AND I have enough stack for a standard raise total.
    // Note: An all-in that is less than the standard min raise is allowed by the server (if > call amount),
    // but won't enable the standard "Raise" button here. The All-in button handles that case.
    const canRaise = isMyTurnAndCanAct && currentBet > 0.001 && playerStack >= minTotalRaiseRequired - 0.001; // Add tolerance for stack check


    // Minimum value for the bet/raise input for client-side hint and validation
    const minBetRaiseInputValue = currentBet < 0.001 ? bigBlind : minTotalRaiseRequired;
    // Ensure min input is not less than 0 and not more than player's stack
    const safeMinBetRaiseInputValue = Math.max(0, Math.min(minBetRaiseInputValue, playerStack));

    // Can All-in: Is it my turn AND I have chips > 0.
    // This button is enabled whenever it's their turn AND they have chips > 0.
    // Server will determine if the all-in constitutes a Bet, Call, or Raise.
    const canAllIn = isMyTurn && playerStack > 0.001; // Use tolerance for stack 0


     // Is the game in a stage where showdown results are displayed?
     const isShowdownVisible = activeTableDetails?.stage === 'showdown_complete' || activeTableDetails?.status === 'finished';


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
                                        const isJoinDisabled = t.playerCount >= t.maxPlayers || !!currentTableId || t.status === 'playing' || t.stage === 'dealing' || t.stage === 'preflop_blinds' || t.stage === 'showdown' || t.stage === 'showdown_complete';
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
                                    <div><label htmlFor="smallBlind">Small Blind:</label><input type="number" id="smallBlind" value={smallBlindInput} onChange={(e) => setSmallBlindInput(e.target.value)} min="1" disabled={!!currentTableId} /></div>
                                    <div><label htmlFor="bigBlind">Big Blind:</label><input type="number" id="bigBlind" value={bigBlindInput} onChange={(e) => setBigBlindInput(e.target.value)} min="2" disabled={!!currentTableId} /></div>
                                    <div><label htmlFor="maxPlayers">Joueurs Max:</label><input type="number" id="maxPlayers" value={maxPlayersInput} onChange={(e) => setMaxPlayersInput(e.target.value)} min="2" max="10" disabled={!!currentTableId} /></div>
                                    <button type="submit" disabled={!!currentTableId || parseFloat(smallBlindInput) <= 0 || parseFloat(bigBlindInput) <= parseFloat(smallBlindInput) || parseInt(maxPlayersInput, 10) < 2 || parseInt(maxPlayersInput, 10) > 10}>Créer Table</button>
                                </form>
                            </div>
                        </div>
                    ) : ( /* --- ACTIVE TABLE --- */
                        <div className="game-table-active">
                            {activeTableDetails ? (
                                <>
                                    <h2>Table : {activeTableDetails.name}</h2>
                                    <p>Blinds: {activeTableDetails.smallBlind}/{activeTableDetails.bigBlind} - Pot: {activeTableDetails.pot} - Phase: {activeTableDetails.stage || 'En attente...'}</p>

                                    <div className="community-cards">
                                        <h3>Cartes Communes</h3>
                                        {/* Display community cards or message if none */}
                                        {Array.isArray(activeTableDetails.communityCards) && activeTableDetails.communityCards.length > 0
                                         ? activeTableDetails.communityCards.map((c, i) => <Card key={`comm-${i}`} card={c} />)
                                         : <p>(Aucune carte commune pour l'instant)</p>}
                                    </div>

                                    {/* Section for Showdown Results - Displayed after hand ends and results are ready */}
                                    {(isShowdownVisible && activeTableDetails.showdownResults?.orderedShowdown) && (
                                        <div className="showdown-results">
                                            <h3>Résultats du Showdown</h3>

                                            {/* Summary of winners and winning hand if available */}
                                            {Array.isArray(activeTableDetails.showdownResults.winners) && activeTableDetails.showdownResults.winners.length > 0 && (
                                                <p>Gagnant(s) : {activeTableDetails.showdownResults.winners.map(w => w.username).join(', ')} (Pot total gagné : {activeTableDetails.showdownResults.potWon})</p>
                                            )}
                                             {activeTableDetails.showdownResults.winningHandName && activeTableDetails.showdownResults.winningHandName !== "Wins by default" && (
                                                 <p>Main gagnante : <strong>{activeTableDetails.showdownResults.winningHandName}</strong> ({activeTableDetails.showdownResults.winningHandDesc})</p>
                                             )}
                                              {activeTableDetails.showdownResults.winningHandName === "Wins by default" && (
                                                   <p>Gagne par défaut : ({activeTableDetails.showdownResults.winningHandDesc})</p>
                                              )}
                                             {Array.isArray(activeTableDetails.showdownResults.winners) && activeTableDetails.showdownResults.winners.length === 0 && (
                                                  <p>Aucun gagnant déclaré. Pot non distribué.</p>
                                             )}

                                            {/* Detailed Showdown Reveal Order */}
                                            {Array.isArray(activeTableDetails.showdownResults.orderedShowdown) && activeTableDetails.showdownResults.orderedShowdown.length > 0 && (
                                                <div className="showdown-reveal-order">
                                                    <h4>Révélation des mains :</h4>
                                                    <ol>
                                                        {activeTableDetails.showdownResults.orderedShowdown.map(sdPlayer => (
                                                            <li key={`sd-${sdPlayer.seat}`}>
                                                                <strong>{sdPlayer.username} (S{sdPlayer.seat}):</strong>
                                                                {sdPlayer.show ? (
                                                                     <>
                                                                         <span> Montre </span>
                                                                         {/* Display hole cards for the shown hand */}
                                                                         <div className="player-hole-cards small-cards">
                                                                             {sdPlayer.holeCards?.map((card, idx) => <Card key={idx} card={card} />)}
                                                                         </div>
                                                                         {/* Display hand name and if they won */}
                                                                         {sdPlayer.hand ? (
                                                                             <span className={sdPlayer.isWinner ? 'winner-text' : 'hand-text'}>
                                                                                ({sdPlayer.hand.name}{sdPlayer.hand.desc && sdPlayer.hand.name !== sdPlayer.hand.desc ? ` - ${sdPlayer.hand.desc}` : ''}) {sdPlayer.isWinner ? '🏆' : ''}
                                                                             </span>
                                                                         ) : (
                                                                              <span className="hand-text">(Main non résolue)</span> // Fallback if hand object is missing but shown
                                                                         )}
                                                                     </>
                                                                ) : (
                                                                     <span className="mucked-text">Couche sa main ({sdPlayer.muckReason || 'raison inconnue'}).</span>
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ol>
                                                </div>
                                            )}
                                        </div>
                                    )}


                                    <h3>Joueurs ({activeTableDetails.players?.length ?? 0}/{activeTableDetails.maxPlayers}) :</h3>
                                    {/* Ensure players is an array */}
                                    {Array.isArray(activeTableDetails.players) && (
                                        <ul className="player-list">
                                            {activeTableDetails.players.map((player) => {
                                                // Check if player is defined (safety)
                                                if (!player) return null;

                                                const isCurrentUser = player.username === username;
                                                // Is it this player's turn (Seat === CurrentTurnSeat) AND game is playing and in a betting stage?
                                                const isPlayerTurn = player.seat === activeTableDetails.currentTurnSeat && activeTableDetails.status === 'playing' && activeTableDetails.stage && activeTableDetails.stage.includes('_betting');


                                                // Get showdown info for this player if available
                                                const showdownPlayerInfo = player.showdownInfo;
                                                const isWinner = showdownPlayerInfo?.isWinner; // Use showdownInfo if available, otherwise check main list (fallback)
                                                // Fallback winner check if showdownInfo is missing for some reason but winners list exists
                                                const isWinnerFallback = !showdownPlayerInfo && Array.isArray(activeTableDetails.showdownResults?.winners) ? activeTableDetails.showdownResults.winners.some(w => w.seat === player.seat) : false;
                                                const finalIsWinner = isWinner || isWinnerFallback;


                                                // Determine player status classes for the list item
                                                const listItemClassName = [
                                                    player.statusInHand === 'folded' ? 'folded' : '',
                                                    player.statusInHand === 'all_in' ? 'all-in' : '',
                                                    player.statusInHand === 'sitting_out' ? 'sitting-out' : '',
                                                    isPlayerTurn ? 'current-turn' : '',
                                                    finalIsWinner ? 'winner' : '', // Apply winner class
                                                    // Add 'mucked' class if showdownInfo indicates mucked
                                                     (isShowdownVisible && showdownPlayerInfo?.show === false) ? 'mucked' : ''
                                                ].filter(Boolean).join(' ');


                                                return (
                                                    <li key={player.seat} className={listItemClassName}>
                                                        <div className="player-info">
                                                            <span>
                                                                S{player.seat}: <strong>{player.username}</strong>
                                                                {player.seat === activeTableDetails.dealerSeat ? ' (D)' : ''}
                                                                {isCurrentUser ? ' (Vous)' : ''}
                                                                {isPlayerTurn && !isCurrentUser ? ' (Action...)' : ''} {/* Only show "Action..." for others during betting */}
                                                                {player.statusInHand === 'all_in' ? ' (ALL-IN)' : ''}
                                                                {player.statusInHand === 'sitting_out' ? ' (Sit Out)' : ''}
                                                            </span>
                                                            <span>Stack: {player.stack}</span>
                                                            {/* Display player's bet in current stage, except during showdown/complete */}
                                                            {activeTableDetails.status === 'playing' && activeTableDetails.stage && activeTableDetails.stage.includes('_betting') && player.betInStage > 0 && (
                                                                 <span className="player-bet">Mise: {player.betInStage}</span>
                                                            )}
                                                             {/* Display hand name for winners during showdown if hand was shown */}
                                                             {/* OR display 'Mucked' if player was in showdown but mucked */}
                                                             {isShowdownVisible && showdownPlayerInfo && (
                                                                 showdownPlayerInfo.show ? (
                                                                      showdownPlayerInfo.hand ? (
                                                                           <span className="player-hand-name">({showdownPlayerInfo.hand.name})</span>
                                                                      ) : (
                                                                           <span className="player-hand-name">(Main montrée, non résolue)</span>
                                                                      )
                                                                 ) : (
                                                                      <span className="player-hand-name mucked-status">Couche sa main</span>
                                                                 )
                                                             )}
                                                              {/* Display winner indicator next to name if not shown in hand name span */}
                                                              {finalIsWinner && !(isShowdownVisible && showdownPlayerInfo?.show && showdownPlayerInfo?.hand) && (
                                                                    <span className="winner-indicator"> 🏆</span>
                                                              )}
                                                        </div>
                                                        {/* The PlayerCards component handles face up/down/empty based on player object data */}
                                                        <PlayerCards player={player} isSelf={isCurrentUser} />
                                                    </li>
                                                );
                                            })}
                                        </ul>
                                    )}

                                    {/* Section for "Start Game" button */}
                                    {/* Display if is creator, table is waiting OR finished, and enough eligible players */}
                                    {canIStartGame && (
                                        <div className="start-game-section">
                                            <button onClick={handleStartGame} className="start-game-button">
                                                {activeTableDetails.status === 'finished' ? 'Démarrer Nouvelle Main' : 'Démarrer Partie'} ({eligiblePlayersForStart.length} J éligibles)
                                            </button>
                                        </div>
                                    )}

                                    {/* Section for current player actions */}
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
                                             { canCall && playerStack > 0.001 && (
                                                   <button onClick={handleCall} disabled={!isMyTurn}>Call {amountToCall > 0 ? amountToCall : ''}</button>
                                             )}


                                            {/* Section for Bet and Raise with input - Visible if I am 'playing' and Stack > 0 */}
                                            { isMyTurnAndCanAct && (
                                                <div className="bet-raise-section">
                                                     {/* Input is for the TOTAL bet/raise amount */}
                                                     <input
                                                         type="number"
                                                         value={betAmountInput}
                                                         onChange={(e) => setBetAmountInput(e.target.value)}
                                                          // Placeholder changes depending on whether it's a bet or raise
                                                         placeholder={currentBet < 0.001 ? `Min ${safeMinBetRaiseInputValue}` : `Min Total ${safeMinBetRaiseInputValue}`}
                                                         min={currentBet < 0.001 ? (activeTableDetails?.bigBlind ?? 1) : minTotalRaiseRequired} // Logical minimum based on rules
                                                         step="any" // Allow decimals for small blinds/stacks
                                                         disabled={!isMyTurnAndCanAct} // Disabled if cannot perform standard action (playing + stack > 0)
                                                         className="bet-input"
                                                     />
                                                     {/* Bet/Raise Buttons: enabled if possible and input has a valid positive value */}
                                                     {/* Bet button appears only if currentBet is effectively 0 and I can act */}
                                                     { canBet && (
                                                          <button onClick={handleBet} disabled={!isMyTurnAndCanAct || !betAmountInput || parseFloat(betAmountInput) < (activeTableDetails?.bigBlind ?? 1)}>Bet</button>
                                                     )}
                                                     {/* Raise button appears only if currentBet > 0 and I can act */}
                                                     { canRaise && ( // canRaise already checks currentBet > 0 and stack >= minTotalRaiseRequired
                                                          <button onClick={handleRaise} disabled={!isMyTurnAndCanAct || !betAmountInput || parseFloat(betAmountInput) < minTotalRaiseRequired}>Raise</button>
                                                     )}

                                                     {/* All-in Button - Appears if I have chips and it's my turn */}
                                                      { canAllIn && (
                                                          <button onClick={handleAllIn} className="allin-button" disabled={!isMyTurn || playerStack <= 0.001}>All-in ({playerStack})</button>
                                                       )}
                                                </div>
                                            )}


                                             {/* Message and actions if it's my turn but I'm all-in (statusInHand === 'all_in') with stack 0 */}
                                             {/* This block is for players who *are* already all-in and it's their turn, and stack is 0 */}
                                             {isMyTurn && myPlayerData?.statusInHand === 'all_in' && playerStack <= 0.001 && (
                                                  <>
                                                       {/* Stack is 0, can only Fold or wait */}
                                                       { (myPlayerData?.betInStage ?? 0) < (activeTableDetails?.currentBet ?? 0) ? (
                                                            <p>Vous êtes All-in pour moins que la mise actuelle. Vous pouvez Fold.</p>
                                                       ) : ( // BetInStage >= currentBet (matched or exceeded, but stack 0 so matched)
                                                            <p>Vous êtes All-in et avez égalé la mise. Attendez la fin de la main.</p>
                                                       )}
                                                        {/* Allow fold action for all-in player if facing bet */}
                                                          {(myPlayerData?.betInStage ?? 0) < (activeTableDetails?.currentBet ?? 0) && (
                                                              <button onClick={handleFold} disabled={!isMyTurn}>Fold</button>
                                                          )}
                                                  </>
                                             )}

                                              {/* Message if it's my turn but stack is 0 or status is sitting_out */}
                                              {/* This case is for players who are NOT 'all_in' but have stack 0 or are sitting_out */}
                                             {isMyTurn && (playerStack <= 0.001 || myPlayerData?.statusInHand === 'sitting_out') && myPlayerData?.statusInHand !== 'all_in' && (
                                                  <div className="game-actions">
                                                        <h4>Votre Action (Stack: {playerStack} - {myPlayerData?.statusInHand === 'sitting_out' ? 'Sit Out' : 'Stack 0'})</h4>
                                                        <p>Vous ne pouvez pas effectuer d'action avec votre stack actuel ou votre statut ({myPlayerData?.statusInHand}).</p>
                                                        {/* No action buttons available */}
                                                  </div>
                                             )}

                                              {/* Message if it's someone else's turn */}
                                             {!isMyTurn && activeTableDetails?.status === 'playing' && !(activeTableDetails.stage?.includes('dealing')) && activeTableDetails.stage !== 'showdown' && activeTableDetails.stage !== 'showdown_complete' && (
                                                <p>En attente de l'action de {activeTableDetails.players.find(p => p.seat === activeTableDetails.currentTurnSeat)?.username || `joueur au siège ${activeTableDetails.currentTurnSeat}`}...</p>
                                             )}


                                        </div>
                                    )}



                                    {/* The "Leave Table" button is always visible when at a table */}
                                    <button onClick={handleLeaveTable} className="leave-button">Quitter la Table</button>
                                </>
                            ) : (
                                <p>Chargement des détails de la table...</p> // Message during loading
                            )}
                        </div>
                    )}

                    {/* --- CHAT --- */}
                    <div className="chat-box">
                        <h2>Chat</h2>
                        <div className="messages">
                            {/* Map and display messages */}
                            {messages.map((m, i) => (
                                <p key={i} className={m.system ? (m.error ? 'system-error-message' : 'system-message') : 'user-message'}>
                                    {/* Display system messages or user messages */}
                                    {m.system ? (m.error ? '❗' : 'ℹ️') + ' ' + m.text : <><strong>{m.user}:</strong> {m.text}</>}
                                </p>
                            ))}
                            {/* Empty element for auto-scroll */}
                            <div ref={messagesEndRef} />
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

            {/* Message if not connected and username not set */}
            {!isConnected && !isUsernameSet && <p>En attente de connexion au serveur...</p>}
        </div>
    );
}

// Export the App component
export default App;
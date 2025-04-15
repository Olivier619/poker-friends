// client/src/App.js
import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';
import './App.css';

// --- Composants Card, PlayerCards ---
function Card({ card }) {
    if (!card) return <div className="card empty"></div>;
    const suitSymbols = { s: '♠', h: '♥', d: '♦', c: '♣' };
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

function PlayerCards({ player, isSelf }) {
    const showCards = player.hasCards && player.statusInHand !== 'folded';
    if (isSelf && player.holeCards?.length === 2) {
        return (<div className="player-hole-cards"><Card card={player.holeCards[0]} /><Card card={player.holeCards[1]} /></div>);
    } else if (!isSelf && showCards) {
        return (<div className="player-hole-cards"><div className="card back"></div><div className="card back"></div></div>);
    } else {
        return <div className="player-hole-cards empty"></div>;
    }
} // Fin de PlayerCards

// --- Composant Principal App ---
function App() {
    // --- États ---
    const [isConnected, setIsConnected] = useState(false);
    const [username, setUsername] = useState('');
    const [isUsernameSet, setIsUsernameSet] = useState(false);
    const [error, setError] = useState('');
    const [usernameInput, setUsernameInput] = useState('');
    const [tables, setTables] = useState([]); // Lobby
    const [tableNameInput, setTableNameInput] = useState('');
    const [smallBlindInput, setSmallBlindInput] = useState('1');
    const [bigBlindInput, setBigBlindInput] = useState('2');
    const [currentTableId, setCurrentTableId] = useState(null); // Table Active
    const [activeTableDetails, setActiveTableDetails] = useState(null);
    const [messages, setMessages] = useState([]); // Chat
    const [messageInput, setMessageInput] = useState('');
    const [betAmountInput, setBetAmountInput] = useState('');

    // --- Références ---
    const socketRef = useRef(null);
    const messagesEndRef = useRef(null); // Pour scroll chat

    // --- Effets ---
    const scrollToBottom = () => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); };
    useEffect(scrollToBottom, [messages]); // Scroll chat

    // *** CODE CORRIGÉ ICI : Un seul useEffect pour le socket ***
    useEffect(() => { // Connexion Socket & Listeners
        // Utilise la variable d'environnement définie dans .env.local (local) ou Vercel (déployé)
        const socketIoUrl = process.env.REACT_APP_SOCKET_URL;

        // Si la variable n'est pas définie, afficher une erreur et sortir
        if (!socketIoUrl) {
            console.error("ERREUR: La variable d'environnement REACT_APP_SOCKET_URL n'est pas définie !");
            setError("Configuration du serveur manquante."); // Informer l'utilisateur
            return; // Important: sortir de l'effet si l'URL manque
        }

        console.log(`Tentative de connexion à : ${socketIoUrl}`); // Log pour débogage

        // Initialisation de la connexion
        // On assigne le socket à la référence useRef
        socketRef.current = io(socketIoUrl, { reconnectionAttempts: 5, reconnectionDelay: 1000 });
        // On crée une variable locale 'socket' pour simplifier l'accès dans ce scope
        const socket = socketRef.current;

        // --- Listeners ---
        // (Tous les listeners sont ajoutés sur l'instance 'socket' créée ci-dessus)
        socket.on('connect', () => { setIsConnected(true); setError(''); console.log('Connected'); });
        socket.on('disconnect', (r) => { setIsConnected(false); setCurrentTableId(null); setActiveTableDetails(null); setError('Déconnecté...'); console.log(`Disconnected: ${r}`); });
        socket.on('connect_error', (err) => { setError(`Conn Error: ${err.message}`); console.error(err); });

        socket.on('username_set', (n) => {
            console.log('>>> CLIENT RECEIVED username_set:', n);
            setUsername(n);
            setIsUsernameSet(true);
            setError('');
            setUsernameInput('');
        });
        socket.on('username_error', (m) => { setError(m); setIsUsernameSet(false); });
        socket.on('error_message', (m) => { setError(`Erreur: ${m}`); console.error(m); });

        socket.on('update_table_list', setTables);
        socket.on('update_active_table', (d) => { console.log('Active table update:', d); setActiveTableDetails(d); setCurrentTableId(d?.id); setError(''); });
        socket.on('left_table', () => { console.log('Left table'); setCurrentTableId(null); setActiveTableDetails(null); });

        socket.on('chat_message', (m) => { setMessages((p) => [...p, m]); });

        // --- Fonction de nettoyage ---
        // Sera appelée quand le composant est démonté ou avant la prochaine exécution de l'effet
        // (ici, seulement au démontage car le tableau de dépendances est vide)
        return () => {
            if (socket) { // Vérifier si socket a bien été initialisé
               socket.disconnect();
               console.log('Socket cleanup');
            }
        };
    }, []); // Le tableau de dépendances vide [] signifie que cet effet ne s'exécute qu'une fois au montage et se nettoie au démontage.

    // --- Handlers ---
    const handleUsernameSubmit = (e) => {
        e.preventDefault();
        setError('');
        const trimmedUsername = usernameInput.trim();
        console.log(`handleUsernameSubmit: Trying with username='${trimmedUsername}', isConnected=${isConnected}, socketRef=${socketRef.current ? 'exists' : 'null'}`);
        if (trimmedUsername && socketRef.current && isConnected) {
            console.log('>>> CLIENT EMITTING set_username:', trimmedUsername);
            socketRef.current.emit('set_username', trimmedUsername);
        } else if (!trimmedUsername) {
            setError('Veuillez entrer un pseudo.');
        } else {
            setError('Connexion au serveur non établie ou problème technique.');
            console.error('Cannot emit set_username', { socketExists: !!socketRef.current, connected: isConnected });
        }
    };

    const sendMessage = (e) => { e.preventDefault(); const m = messageInput.trim(); if (m && socketRef.current && isUsernameSet && isConnected) { socketRef.current.emit('chat_message', { text: m }); setMessageInput(''); } else setError('Pseudo/Connexion requis'); };
    const handleCreateTableSubmit = (e) => { e.preventDefault(); setError(''); const d = { name: tableNameInput, smallBlind: smallBlindInput, bigBlind: bigBlindInput }; const sb = parseInt(d.smallBlind, 10), bb = parseInt(d.bigBlind, 10); if (isNaN(sb) || isNaN(bb) || sb <= 0 || bb <= sb) { setError('Blinds invalides'); return; } if (socketRef.current && isUsernameSet && isConnected) { socketRef.current.emit('create_table', d); setTableNameInput(''); setSmallBlindInput('1'); setBigBlindInput('2'); } else setError('Pseudo/Connexion requis'); };
    const handleJoinTable = (id) => { setError(''); if (socketRef.current && isUsernameSet && isConnected && !currentTableId) socketRef.current.emit('join_table', { tableId: id }); else setError('Impossible rejoindre'); };
    const handleLeaveTable = () => { setError(''); if (socketRef.current && isUsernameSet && isConnected && currentTableId) socketRef.current.emit('leave_table'); else setError('Impossible quitter'); };
    const handleStartGame = () => { setError(''); if (socketRef.current && isUsernameSet && isConnected && currentTableId && activeTableDetails?.isCreator) { console.log(`Req start ${currentTableId}`); socketRef.current.emit('request_start_game', { tableId: currentTableId }); } else { setError('Impossible de démarrer.'); } };

    // Handlers Actions Jeu
    const emitPlayerAction = (actionType, amount = 0) => { setError(''); if (!socketRef.current || !currentTableId) return; console.log(`Emit: ${actionType}, Amt: ${amount}`); socketRef.current.emit('player_action', { type: actionType, amount: amount }); setBetAmountInput(''); };
    const handleFold = () => emitPlayerAction('fold');
    const handleCheck = () => emitPlayerAction('check');
    const handleCall = () => emitPlayerAction('call');
    const handleBet = () => { const amount = parseInt(betAmountInput, 10); if (isNaN(amount) || amount <= 0) { setError("Montant invalide."); return; } emitPlayerAction('bet', amount); };
    const handleRaise = () => { const amount = parseInt(betAmountInput, 10); if (isNaN(amount) || amount <= 0) { setError("Montant invalide."); return; } emitPlayerAction('raise', amount); };

    // --- Constantes / Logique pour le Rendu ---
    const amIAtTable = currentTableId !== null && activeTableDetails !== null;
    const myPlayerData = amIAtTable ? activeTableDetails.players.find(p => p.username === username) : null;
    const isMyTurn = amIAtTable && myPlayerData?.seat === activeTableDetails.currentTurnSeat && activeTableDetails.status === 'playing' && myPlayerData?.statusInHand === 'playing';
    const canIStartGame = amIAtTable && activeTableDetails.isCreator && activeTableDetails.status === 'waiting' && activeTableDetails.players.length >= 2;
    const canCheck = isMyTurn && myPlayerData?.betInStage === activeTableDetails?.currentBet;
    const canCall = isMyTurn && myPlayerData?.betInStage < activeTableDetails?.currentBet && myPlayerData?.stack > 0;
    const amountToCall = canCall ? Math.min(activeTableDetails.currentBet - myPlayerData.betInStage, myPlayerData.stack) : 0;
    const canBet = isMyTurn && activeTableDetails?.currentBet === 0 && myPlayerData?.stack > 0;
    const canRaise = isMyTurn && activeTableDetails?.currentBet > 0 && myPlayerData?.stack > amountToCall;

    // --- Rendu ---
    return (
        <div className="App">
            <h1>Poker entre Amis</h1>
            <p>Status: {isConnected ? `Connecté ✅ ${username ? `(${username})` : ''}` : 'Déconnecté ❌'}</p>
            {error && <p className="error-message">{error}</p>}

            {/* Formulaire Pseudo */}
            {!isUsernameSet && isConnected && (
                <form onSubmit={handleUsernameSubmit} className="username-form">
                    <h2>Pseudo</h2>
                    <input type="text" value={usernameInput} onChange={(e) => setUsernameInput(e.target.value)} placeholder="Entrez pseudo..." required />
                    <button type="submit">Rejoindre</button>
                </form>
            )}

            {/* Contenu Principal */}
            {isConnected && isUsernameSet && (
                <div className="main-content">
                    {!amIAtTable ? ( /* --- LOBBY --- */
                        <div className="lobby">
                            <h2>Tables Disponibles</h2>
                            {tables.length === 0 ? (<p>Aucune table.</p>) : (
                                <ul className="table-list">
                                    {tables.map((t) => (
                                        <li key={t.id}>
                                            <span>{t.name}({t.playerCount}/{t.maxPlayers}) SB/BB:{t.smallBlind}/{t.bigBlind}</span>
                                            <button onClick={() => handleJoinTable(t.id)} disabled={t.playerCount >= t.maxPlayers || !!currentTableId}>Rejoindre</button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                            <div className="create-table-form">
                                <h3>Créer Table</h3>
                                <form onSubmit={handleCreateTableSubmit}>
                                    <div><label htmlFor="tableName">Nom:</label><input type="text" id="tableName" value={tableNameInput} onChange={(e) => setTableNameInput(e.target.value)} placeholder={`${username}'s Table`} /></div>
                                    <div><label htmlFor="smallBlind">SB:</label><input type="number" id="smallBlind" value={smallBlindInput} onChange={(e) => setSmallBlindInput(e.target.value)} min="1" /></div>
                                    <div><label htmlFor="bigBlind">BB:</label><input type="number" id="bigBlind" value={bigBlindInput} onChange={(e) => setBigBlindInput(e.target.value)} min="2" /></div>
                                    <button type="submit" disabled={!!currentTableId}>Créer</button>
                                </form>
                            </div>
                        </div>
                    ) : ( /* --- TABLE ACTIVE --- */
                        <div className="game-table-active">
                            <h2>Table : {activeTableDetails?.name || '...'}</h2>
                            {activeTableDetails ? (
                                <>
                                    <p>Blinds: {activeTableDetails.smallBlind}/{activeTableDetails.bigBlind} - Pot: {activeTableDetails.pot} - Phase: {activeTableDetails.stage || 'N/A'}</p>
                                    <div className="community-cards">
                                        <h3>Cartes Communes</h3>
                                        {activeTableDetails.communityCards?.length > 0 ? activeTableDetails.communityCards.map((c, i) => <Card key={`comm-${i}`} card={c} />) : <p>(Aucune)</p>}
                                    </div>
                                    <h3>Joueurs ({activeTableDetails.players.length}/{activeTableDetails.maxPlayers}) :</h3>
                                    <ul className="player-list">
                                        {activeTableDetails.players.map((player) => {
                                            const isCurrentUser = player.username === username;
                                            const isPlayerTurn = player.seat === activeTableDetails.currentTurnSeat && activeTableDetails.status === 'playing';
                                            return (
                                                <li key={player.seat} className={`${player.statusInHand === 'folded' ? 'folded' : ''} ${isPlayerTurn ? 'current-turn' : ''}`}>
                                                    <div className="player-info">
                                                        <span>S{player.seat}: <strong>{player.username}</strong> {player.seat === activeTableDetails.dealerSeat ? '(D)' : ''}{isCurrentUser ? ' (Vous)' : ''}{isPlayerTurn ? ' (Action...)' : ''}</span>
                                                        <span>Stack: {player.stack}</span>
                                                        {player.betInStage > 0 && <span className="player-bet">Mise: {player.betInStage}</span>}
                                                    </div>
                                                    <PlayerCards player={player} isSelf={isCurrentUser} />
                                                </li>
                                            );
                                        })}
                                    </ul>
                                    {canIStartGame && (<div className="start-game-section"><button onClick={handleStartGame} className="start-game-button">Démarrer Partie ({activeTableDetails.players.length} J)</button></div>)}
                                    {isMyTurn && (
                                        <div className="game-actions">
                                            <h4>Vos Actions (Stack: {myPlayerData?.stack})</h4>
                                            <button onClick={handleFold} disabled={!isMyTurn}>Fold</button>
                                            <button onClick={handleCheck} disabled={!canCheck}>Check</button>
                                            <button onClick={handleCall} disabled={!canCall}>Call {amountToCall > 0 ? amountToCall : ''}</button>
                                            <div className="bet-raise-section">
                                                <input type="number" value={betAmountInput} onChange={(e) => setBetAmountInput(e.target.value)} placeholder="Montant" min={activeTableDetails?.bigBlind} step="1" disabled={!isMyTurn || myPlayerData?.stack === 0} className="bet-input" />
                                                <button onClick={handleBet} disabled={!canBet || !betAmountInput}>Bet</button>
                                                <button onClick={handleRaise} disabled={!canRaise || !betAmountInput}>Raise</button>
                                            </div>
                                        </div>
                                    )}
                                    <button onClick={handleLeaveTable} className="leave-button">Quitter</button>
                                </>
                            ) : (<p>Chargement...</p>)}
                        </div>
                    )}
                    {/* --- CHAT --- */}
                    <div className="chat-box">
                        <h2>Chat</h2>
                        <div className="messages">{messages.map((m, i) => (<p key={i} className={m.system ? (m.error ? 'system-error-message' : 'system-message') : 'user-message'}>{m.system ? <em>{m.text}</em> : <><strong>{m.user}:</strong> {m.text}</>}</p>))}<div ref={messagesEndRef} /></div>
                        <form onSubmit={sendMessage} className="message-form"><input type="text" value={messageInput} onChange={(e) => setMessageInput(e.target.value)} placeholder="..." disabled={!isConnected} /> <button type="submit" disabled={!isConnected}>Envoyer</button></form>
                    </div>
                </div>
            )}
            {!isConnected && <p>Connexion perdue...</p>}
        </div>
    );
}
export default App;
// tournaments.js - ENHANCED VERSION WITH SCORING, TOURNAMENT CLOSURE, AND HOST REGISTRATION
const API_BASE = 'https://lobby-websocket-server.onrender.com';
let selectedPlayerCount = null;
let currentLobbyId = null;
let currentUserId = null;
let userCache = {}; // Cache for user profile data

// Initialize tournament system
let _tournamentListenersAttached = false;
function initTournaments(lobbyId, userId) {
    currentLobbyId = lobbyId;
    currentUserId = userId;
    
    // Add tournament button to lobby menu
    addTournamentButton();
    
    // Load existing tournaments for this lobby
    loadTournaments();
    
    // Set up event listeners only once
    if (!_tournamentListenersAttached) {
        setupEventListeners();
        _tournamentListenersAttached = true;
    }
}

// Add tournament setup button to lobby menu
function addTournamentButton() {
    const lobbyMenu = document.querySelector('.server-actions');
    if (!lobbyMenu) return;

    // Remove any existing tournament button to avoid duplicates
    const existing = lobbyMenu.querySelector('.tournament-setup-btn');
    if (existing) existing.remove();

    const tournamentItem = document.createElement('div');
    tournamentItem.className = 'server-action-item tournament-setup-btn';
    tournamentItem.innerHTML = `
        <span class="sa-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
        </svg></span>
        Tournament Setup
    `;
    tournamentItem.onclick = openTournamentModal;
    
    lobbyMenu.appendChild(tournamentItem);
}

// Open tournament creation modal
function openTournamentModal() {
    const container = document.getElementById('tournamentContainer');
    if (container) {
        container.classList.add('active');
        document.body.style.overflow = 'hidden';
    }
}

// Close tournament modal
function closeTournamentModal() {
    const container = document.getElementById('tournamentContainer');
    if (container) {
        container.classList.remove('active');
        document.body.style.overflow = 'auto';
        // Reset form
        document.getElementById('tournamentForm').reset();
        selectedPlayerCount = null;
        updatePlayerCountButtons();
    }
}

// Set up event listeners
function setupEventListeners() {
    // Player count buttons
    document.querySelectorAll('.player-count-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            selectedPlayerCount = parseInt(btn.dataset.count);
            updatePlayerCountButtons();
        });
    });

    // Form submission
    const form = document.getElementById('tournamentForm');
    if (form) {
        form.addEventListener('submit', handleTournamentSubmit);
    }

    // Close modal on background click
    const container = document.getElementById('tournamentContainer');
    if (container) {
        container.addEventListener('click', (e) => {
            if (e.target === container) {
                closeTournamentModal();
            }
        });
    }
}

// Update player count button UI
function updatePlayerCountButtons() {
    document.querySelectorAll('.player-count-btn').forEach(btn => {
        if (parseInt(btn.dataset.count) === selectedPlayerCount) {
            btn.classList.add('active');
        } else {
            btn.classList.remove('active');
        }
    });
}

// Handle tournament form submission
async function handleTournamentSubmit(e) {
    e.preventDefault();

    if (!selectedPlayerCount) {
        alert('Please select number of players');
        return;
    }

    const tournamentData = {
        lobbyId: currentLobbyId,
        name: document.getElementById('tournamentName').value,
        description: document.getElementById('tournamentDesc').value,
        format: document.getElementById('tournamentFormat').value,
        playerCount: selectedPlayerCount,
        rules: document.getElementById('tournamentRules').value,
        prize: document.getElementById('tournamentPrize').value
    };

    try {
        const response = await fetch(`${API_BASE}/api/tournaments/create`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            },
            body: JSON.stringify(tournamentData)
        });

        if (!response.ok) {
            throw new Error('Failed to create tournament');
        }

        const data = await response.json();
        console.log('Tournament created:', data);
        
        closeTournamentModal();
        loadTournaments();
        
        // Show success message
        showNotification('Tournament created successfully!', 'success');
        
        // Emit socket event
        if (window.socket) {
            window.socket.emit('tournament-created', {
                tournamentId: data.tournament.id,
                lobbyId: currentLobbyId
            });
        }
    } catch (error) {
        console.error('Tournament creation error:', error);
        showNotification('Failed to create tournament', 'error');
    }
}

// Load tournaments for current lobby
async function loadTournaments() {
    if (!currentLobbyId) return;

    try {
        const response = await fetch(`${API_BASE}/api/tournaments/lobby/${currentLobbyId}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to load tournaments');
        }

        const tournaments = await response.json();
        displayTournaments(tournaments);
    } catch (error) {
        console.error('Load tournaments error:', error);
    }
}

// Display tournaments
function displayTournaments(tournaments) {
    const container = document.getElementById('tournamentsList');
    if (!container) return;

    if (tournaments.length === 0) {
        container.innerHTML = '<p style="color: #7a8591; text-align: center; padding: 2rem;">No tournaments yet. Create one to get started!</p>';
        return;
    }

    container.innerHTML = tournaments.map(tournament => `
        <div class="tournament-card" onclick="openTournamentDetails('${tournament.id}')">
            <div class="tournament-card-header">
                <div class="tournament-card-title">${tournament.name}</div>
                <span class="tournament-card-status ${tournament.status === 'in-progress' ? 'in-progress' : ''}\">${tournament.status}</span>
            </div>
            <div class="tournament-card-details">
                <div class="tournament-detail">
                    <div class="tournament-detail-label">Players</div>
                    <div class="tournament-detail-value">${tournament.registeredPlayers.length}/${tournament.playerCount}</div>
                </div>
                <div class="tournament-detail">
                    <div class="tournament-detail-label">Format</div>
                    <div class="tournament-detail-value">${tournament.format}</div>
                </div>
                <div class="tournament-detail">
                    <div class="tournament-detail-label">Host</div>
                    <div class="tournament-detail-value">${tournament.hostId === currentUserId ? 'You' : 'Other'}</div>
                </div>
                <div class="tournament-detail">
                    <div class="tournament-detail-label">Created</div>
                    <div class="tournament-detail-value">${new Date(tournament.createdAt).toLocaleDateString()}</div>
                </div>
            </div>
        </div>
    `).join('');
}

// Fetch user profile data
async function fetchUserProfile(userId) {
    // Check cache first
    if (userCache[userId]) {
        return userCache[userId];
    }

    try {
        const response = await fetch(`${API_BASE}/api/users/${userId}/profile`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (response.ok) {
            const profile = await response.json();
            userCache[userId] = profile;
            return profile;
        }
    } catch (error) {
        console.error(`Failed to fetch profile for user ${userId}:`, error);
    }

    // Return default profile if fetch fails
    return { userId, username: 'Unknown', profilePicture: null };
}

// Get initials for avatar fallback
function getInitials(username) {
    return (username || 'U')
        .split(' ')
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2);
}

// Open tournament details and bracket
async function openTournamentDetails(tournamentId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to load tournament');
        }

        const tournament = await response.json();
        displayTournamentBracket(tournament);
    } catch (error) {
        console.error('Load tournament details error:', error);
        showNotification('Failed to load tournament details', 'error');
    }
}

// Display tournament bracket with scoring
async function displayTournamentBracket(tournament) {
    const modal = document.createElement('div');
    modal.className = 'tournament-container active';
    
    // Fetch all player profiles
    const playerProfiles = {};
    if (tournament.bracket && tournament.bracket.rounds) {
        for (const round of tournament.bracket.rounds) {
            for (const match of round.matches) {
                if (match.player1?.userId && !playerProfiles[match.player1.userId]) {
                    playerProfiles[match.player1.userId] = await fetchUserProfile(match.player1.userId);
                }
                if (match.player2?.userId && !playerProfiles[match.player2.userId]) {
                    playerProfiles[match.player2.userId] = await fetchUserProfile(match.player2.userId);
                }
            }
        }
    }

    const isHost = tournament.hostId === currentUserId;
    const isRegistered = tournament.registeredPlayers.some(p => p.userId === currentUserId);
    const canEdit = isHost && tournament.status !== 'completed';

    let bracketHTML = '';
    if (tournament.bracket && tournament.bracket.rounds && tournament.bracket.rounds.length > 0) {
        bracketHTML = tournament.bracket.rounds.map((round, idx) => `
            <div class="bracket-round">
                <div class="bracket-round-title">Round ${round.roundNumber}</div>
                ${round.matches.map((match, matchIdx) => {
                    const p1Profile = playerProfiles[match.player1?.userId] || match.player1;
                    const p2Profile = playerProfiles[match.player2?.userId] || match.player2;
                    const p1Avatar = p1Profile?.profilePicture || null;
                    const p2Avatar = p2Profile?.profilePicture || null;
                    const hasWinner = !!match.winner;

                    return `
                        <div class="match-card ${hasWinner ? 'has-winner' : ''}">
                            <!-- Player 1 -->
                            <div class="match-player-row">
                                <div class="player-avatar">
                                    ${p1Avatar ? `<img src="${p1Avatar}" alt="${match.player1?.username || 'TBD'}">` : getInitials(match.player1?.username || '?')}
                                </div>
                                <div class="player-info">
                                    <div class="player-name ${match.winner === match.player1?.userId ? 'winner' : ''}">
                                        ${match.player1?.username || 'TBD'}
                                    </div>
                                </div>
                                ${canEdit ? `
                                    <input type="number" class="score-input" min="0" data-match-id="${match.matchId}" data-player="1" placeholder="0">
                                    <button type="button" class="winner-btn ${match.winner === match.player1?.userId ? 'active' : ''}" 
                                        onclick="setWinner('${tournament.id}', '${round.roundNumber}', '${matchIdx}', '${match.player1?.userId}', this)"
                                        ${!match.player1?.userId ? 'disabled' : ''}>✓</button>
                                ` : ''}
                            </div>
                            
                            <div class="bracket-divider"></div>

                            <!-- Player 2 -->
                            <div class="match-player-row">
                                <div class="player-avatar">
                                    ${p2Avatar ? `<img src="${p2Avatar}" alt="${match.player2?.username || 'TBD'}">` : getInitials(match.player2?.username || '?')}
                                </div>
                                <div class="player-info">
                                    <div class="player-name ${match.winner === match.player2?.userId ? 'winner' : ''}">
                                        ${match.player2?.username || 'TBD'}
                                    </div>
                                </div>
                                ${canEdit ? `
                                    <input type="number" class="score-input" min="0" data-match-id="${match.matchId}" data-player="2" placeholder="0">
                                    <button type="button" class="winner-btn ${match.winner === match.player2?.userId ? 'active' : ''}" 
                                        onclick="setWinner('${tournament.id}', '${round.roundNumber}', '${matchIdx}', '${match.player2?.userId}', this)"
                                        ${!match.player2?.userId ? 'disabled' : ''}>✓</button>
                                ` : ''}
                            </div>

                            ${!canEdit && (match.winner || match.status === 'pending') ? `
                                <div class="host-only-notice">Only host can edit</div>
                            ` : ''}
                        </div>
                    `;
                }).join('')}
            </div>
        `).join('');
    } else {
        bracketHTML = '<p style="color: #7a8591;">Bracket not yet generated. Host will generate it once all players register.</p>';
    }

    modal.innerHTML = `
        <div class="tournament-modal">
            <div class="tournament-header">
                <div class="tournament-header-left">
                    <h2>${tournament.name}</h2>
                    <span class="tournament-status-badge">${tournament.status}</span>
                </div>
                <button class="close-btn" onclick="this.closest('.tournament-container').remove()">×</button>
            </div>
            
            <div class="tournament-details-info" style="margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(100, 200, 255, 0.1);">
                <p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Format:</strong> ${tournament.format}</p>
                <p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Players:</strong> ${tournament.registeredPlayers.length}/${tournament.playerCount}</p>
                <p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Status:</strong> ${tournament.status}</p>
                ${tournament.description ? `<p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Description:</strong> ${tournament.description}</p>` : ''}
            </div>

            <div style="margin-bottom: 1.5rem;">
                <h3 style="color: #ffffff; margin-top: 0; margin-bottom: 0.75rem;">Registered Players (${tournament.registeredPlayers.length}/${tournament.playerCount})</h3>
                <div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">
                    ${tournament.registeredPlayers.map(p => `
                        <div style="background: rgba(100, 200, 255, 0.15); border: 1px solid rgba(100, 200, 255, 0.3); border-radius: 4px; padding: 0.5rem 0.75rem; color: #b0b8c1; font-size: 13px;">
                            ${p.username}
                        </div>
                    `).join('')}
                </div>
            </div>

            <div class="bracket-container">
                ${bracketHTML}
            </div>

            <div class="tournament-actions">
                ${!isRegistered && !isHost && tournament.status === 'setup' ? `
                    <button onclick="registerForTournament('${tournament.id}')" class="btn-primary">Join Tournament</button>
                ` : ''}
                
                ${isHost && tournament.status === 'setup' ? `
                    <button onclick="generateBracket('${tournament.id}')" class="btn-primary">Generate Bracket</button>
                ` : ''}
                
                ${isHost && tournament.status !== 'completed' ? `
                    <button onclick="closeTournament('${tournament.id}')" class="btn-danger">End Tournament</button>
                ` : ''}
                
                <button onclick="this.closest('.tournament-container').remove()" class="btn-secondary">Close</button>
            </div>
        </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// Set winner for a match (HOST ONLY)
async function setWinner(tournamentId, roundNumber, matchIdx, winnerUserId, btnElement) {
    const isHost = true; // Verify this on the backend
    
    if (!isHost) {
        showNotification('Only the host can set winners', 'error');
        return;
    }

    if (!winnerUserId) {
        showNotification('Cannot set winner for TBD player', 'error');
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/set-winner`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            },
            body: JSON.stringify({
                roundNumber: parseInt(roundNumber),
                matchNumber: parseInt(matchIdx),
                winnerId: winnerUserId
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to set winner');
        }

        // Update button UI
        const matchCard = btnElement.closest('.match-card');
        const allWinnerBtns = matchCard.querySelectorAll('.winner-btn');
        allWinnerBtns.forEach(btn => btn.classList.remove('active'));
        btnElement.classList.add('active');

        // Update player names
        const playerRows = matchCard.querySelectorAll('.match-player-row');
        playerRows.forEach((row, idx) => {
            const playerName = row.querySelector('.player-name');
            if (idx === 0) {
                playerName.classList.toggle('winner', winnerUserId === playerName.textContent);
            }
        });

        showNotification('✓ Winner Declared', 'success');
        
        // Emit socket event
        if (window.socket) {
            window.socket.emit('match-result', {
                tournamentId,
                roundNumber,
                matchNumber: matchIdx,
                winnerId: winnerUserId
            });
        }
    } catch (error) {
        console.error('Set winner error:', error);
        showNotification(error.message || 'Failed to set winner', 'error');
    }
}

// Close/End tournament (HOST ONLY)
async function closeTournament(tournamentId) {
    if (!confirm('Are you sure you want to end this tournament? This action cannot be undone.')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/close`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to close tournament');
        }

        showNotification('Tournament has been ended', 'success');
        
        // Close modal and refresh
        document.querySelector('.tournament-container.active')?.remove();
        loadTournaments();

        // Emit socket event
        if (window.socket) {
            window.socket.emit('tournament-closed', { tournamentId });
        }
    } catch (error) {
        console.error('Close tournament error:', error);
        showNotification(error.message || 'Failed to end tournament', 'error');
    }
}

// Generate bracket (host only)
async function generateBracket(tournamentId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/generate-bracket`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to generate bracket');
        }

        showNotification('Bracket generated successfully!', 'success');
        loadTournaments();
        
        // Refresh tournament details
        const modal = document.querySelector('.tournament-container.active');
        if (modal) {
            modal.remove();
            // Reopen to show updated bracket
            setTimeout(() => openTournamentDetails(tournamentId), 500);
        }
    } catch (error) {
        console.error('Generate bracket error:', error);
        showNotification('Failed to generate bracket', 'error');
    }
}

// Register player for tournament
async function registerForTournament(tournamentId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/register`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to register');
        }

        showNotification('Successfully registered for tournament!', 'success');
        
        // Close current modal and reload
        document.querySelector('.tournament-container.active')?.remove();
        loadTournaments();
        
        // Reopen to show updated bracket
        setTimeout(() => openTournamentDetails(tournamentId), 500);
    } catch (error) {
        console.error('Registration error:', error);
        showNotification(error.message || 'Failed to register for tournament', 'error');
    }
}

// Show notification
function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        padding: 1rem 1.5rem;
        background: ${type === 'success' ? '#4caf50' : type === 'error' ? '#f44336' : '#2196f3'};
        color: white;
        border-radius: 6px;
        font-size: 14px;
        z-index: 10000;
        animation: slideIn 0.3s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    `;
    notification.textContent = message;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

// Add animation styles
const style = document.createElement('style');
style.textContent = `
    @keyframes slideIn {
        from {
            transform: translateX(400px);
            opacity: 0;
        }
        to {
            transform: translateX(0);
            opacity: 1;
        }
    }
    
    @keyframes slideOut {
        from {
            transform: translateX(0);
            opacity: 1;
        }
        to {
            transform: translateX(400px);
            opacity: 0;
        }
    }
`;
document.head.appendChild(style);

// Socket.io integration (if using real-time updates)
if (window.socket) {
    window.socket.on('tournament-update', (data) => {
        console.log('Tournament update:', data);
        loadTournaments();
    });

    window.socket.on('bracket-generated', (data) => {
        console.log('Bracket generated:', data);
        loadTournaments();
    });

    window.socket.on('match-completed', (data) => {
        console.log('Match completed:', data);
        loadTournaments();
    });

    window.socket.on('tournament-closed', (data) => {
        console.log('Tournament closed:', data);
        loadTournaments();
    });
}

// Export functions
window.initTournaments = initTournaments;
window.openTournamentModal = openTournamentModal;
window.closeTournamentModal = closeTournamentModal;
window.openTournamentDetails = openTournamentDetails;
window.generateBracket = generateBracket;
window.registerForTournament = registerForTournament;
window.setWinner = setWinner;
window.closeTournament = closeTournament;
window.showNotification = showNotification;

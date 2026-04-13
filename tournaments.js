// tournaments.js
const API_BASE = window.location.protocol === 'file:' ? 'http://localhost:3000' : '';
let selectedPlayerCount = null;
let currentLobbyId = null;
let currentUserId = null;

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
                'Authorization': `Bearer ${localStorage.getItem('token')}`
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
                'Authorization': `Bearer ${localStorage.getItem('token')}`
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
                <span class="tournament-card-status ${tournament.status === 'in-progress' ? 'in-progress' : ''}">${tournament.status}</span>
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

// Open tournament details and bracket
async function openTournamentDetails(tournamentId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}`, {
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('token')}`
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

// Display tournament bracket
function displayTournamentBracket(tournament) {
    const modal = document.createElement('div');
    modal.className = 'tournament-container active';
    modal.innerHTML = `
        <div class="tournament-modal">
            <div class="tournament-header">
                <h2>${tournament.name}</h2>
                <button onclick="this.closest('.tournament-container').remove()" style="background: none; border: none; color: #64c8ff; cursor: pointer; font-size: 24px;">×</button>
            </div>
            
            <div class="tournament-details-info" style="margin-bottom: 1.5rem; padding-bottom: 1rem; border-bottom: 1px solid rgba(100, 200, 255, 0.1);">
                <p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Format:</strong> ${tournament.format}</p>
                <p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Players:</strong> ${tournament.registeredPlayers.length}/${tournament.playerCount}</p>
                <p style="color: #b0b8c1; margin: 0.5rem 0;"><strong>Status:</strong> ${tournament.status}</p>
                ${tournament.description ? `<p style="color: #b0b8c1; margin: 0.5rem 0;">${tournament.description}</p>` : ''}
            </div>

            <div class="bracket-container">
                ${tournament.bracket && tournament.bracket.rounds ? tournament.bracket.rounds.map((round, idx) => `
                    <div class="bracket-round">
                        <div class="bracket-round-title">Round ${round.roundNumber}</div>
                        ${round.matches.map(match => `
                            <div class="match-card">
                                <div class="match-player ${match.winner === match.player1?.userId ? 'winner' : match.status === 'pending' ? 'pending' : ''}">
                                    ${match.player1?.username || 'TBD'}
                                </div>
                                <div class="bracket-divider"></div>
                                <div class="match-player ${match.winner === match.player2?.userId ? 'winner' : match.status === 'pending' ? 'pending' : ''}">
                                    ${match.player2?.username || 'TBD'}
                                </div>
                            </div>
                        `).join('')}
                    </div>
                `).join('') : '<p style="color: #7a8591;">Bracket not yet generated</p>'}
            </div>

            ${tournament.hostId === currentUserId && tournament.status === 'setup' ? `
                <div style="margin-top: 1.5rem;">
                    <button onclick="generateBracket('${tournament.id}')" class="btn-primary" style="width: 100%;">Generate Bracket</button>
                </div>
            ` : ''}
        </div>
    `;

    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.remove();
        }
    });
}

// Generate bracket (host only)
async function generateBracket(tournamentId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/generate-bracket`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to generate bracket');
        }

        showNotification('Bracket generated successfully!', 'success');
        loadTournaments();
        
        // Refresh tournament details
        const tournamentCard = document.querySelector(`[data-tournament-id="${tournamentId}"]`);
        if (tournamentCard) {
            openTournamentDetails(tournamentId);
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
                'Authorization': `Bearer ${localStorage.getItem('token')}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to register');
        }

        showNotification('Successfully registered for tournament!', 'success');
        loadTournaments();
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
}

// Export functions
window.initTournaments = initTournaments;
window.openTournamentModal = openTournamentModal;
window.closeTournamentModal = closeTournamentModal;
window.openTournamentDetails = openTournamentDetails;
window.generateBracket = generateBracket;
window.registerForTournament = registerForTournament;

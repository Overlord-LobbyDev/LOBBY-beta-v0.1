// Example Integration in your main.js or lobby initialization

// Add this to your existing lobby initialization function

// ============================================
// Tournament System Integration Example
// ============================================

// When user enters a lobby, add this call:
function setupLobby(lobbyId, userId) {
    // ... your existing lobby setup code ...
    
    // Initialize the tournament system
    // This will add the tournament button and load existing tournaments
    if (typeof initTournaments === 'function') {
        initTournaments(lobbyId, userId);
    }
}

// Example: In your socket event handlers, add tournament events
if (window.socket) {
    // Listen for tournament updates from other players
    window.socket.on('tournament-created', (data) => {
        console.log('New tournament created:', data);
        loadTournaments(); // Refresh the list
        // Optionally show a notification
        showNotification(`${data.hostName} created a new tournament!`, 'info');
    });

    window.socket.on('tournament-update', (data) => {
        console.log('Tournament updated:', data);
        loadTournaments();
    });

    window.socket.on('bracket-generated', (data) => {
        console.log('Bracket generated:', data);
        showNotification('Tournament bracket has been generated!', 'info');
    });

    window.socket.on('match-result', (data) => {
        console.log('Match result:', data);
        showNotification(`Match completed! Winner: ${data.winnerName}`, 'info');
    });
}

// Example: Add tournament menu item to your existing lobby menu
function addTournamentMenuOption() {
    const menuContainer = document.querySelector('.lobby-menu'); // Adjust selector if needed
    
    if (menuContainer && !document.querySelector('.tournament-setup-btn')) {
        const tournamentBtn = document.createElement('button');
        tournamentBtn.className = 'lobby-menu-item tournament-setup-btn';
        tournamentBtn.style.cssText = `
            display: flex;
            align-items: center;
            gap: 0.75rem;
            padding: 0.75rem 1rem;
            background: rgba(100, 200, 255, 0.05);
            border: 1px solid rgba(100, 200, 255, 0.2);
            border-radius: 6px;
            color: #64c8ff;
            cursor: pointer;
            font-size: 14px;
            font-weight: 500;
            transition: all 0.3s ease;
        `;
        tournamentBtn.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
            </svg>
            <span>Tournament Setup</span>
        `;
        tournamentBtn.onmouseover = () => {
            tournamentBtn.style.background = 'rgba(100, 200, 255, 0.1)';
            tournamentBtn.style.borderColor = '#64c8ff';
        };
        tournamentBtn.onmouseout = () => {
            tournamentBtn.style.background = 'rgba(100, 200, 255, 0.05)';
            tournamentBtn.style.borderColor = 'rgba(100, 200, 255, 0.2)';
        };
        tournamentBtn.onclick = openTournamentModal;
        
        menuContainer.appendChild(tournamentBtn);
    }
}

// Example: Add tournament section to your lobby page
function displayLobbyTournaments(lobbyId) {
    const container = document.querySelector('.lobby-content'); // Adjust selector
    
    if (container) {
        const tournamentSection = document.createElement('div');
        tournamentSection.id = 'tournamentSection';
        tournamentSection.style.cssText = `
            margin-top: 2rem;
            padding: 1.5rem;
            background: rgba(15, 20, 25, 0.5);
            border: 1px solid rgba(100, 200, 255, 0.1);
            border-radius: 8px;
        `;
        tournamentSection.innerHTML = `
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem;">
                <h3 style="font-size: 16px; font-weight: 600; color: #ffffff; margin: 0;">Active Tournaments</h3>
                <button onclick="openTournamentModal()" style="
                    padding: 0.5rem 1rem;
                    background: linear-gradient(135deg, #64c8ff 0%, #3d9fd6 100%);
                    border: none;
                    border-radius: 6px;
                    color: white;
                    font-size: 12px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s ease;
                ">+ Create Tournament</button>
            </div>
            <div id="tournamentsList" style="display: grid; gap: 1rem;"></div>
        `;
        container.appendChild(tournamentSection);
    }
}

// Example: Show tournament notifications to players
function notifyPlayerOfTournamentEvent(eventType, data) {
    let message = '';
    let type = 'info';
    
    switch(eventType) {
        case 'tournament_created':
            message = `${data.hostName} created "${data.tournamentName}"`;
            type = 'info';
            break;
        case 'tournament_started':
            message = `Tournament "${data.tournamentName}" has started!`;
            type = 'success';
            break;
        case 'player_registered':
            message = `${data.playerName} registered for "${data.tournamentName}"`;
            type = 'info';
            break;
        case 'bracket_ready':
            message = `Bracket is ready for "${data.tournamentName}"`;
            type = 'success';
            break;
        case 'match_scheduled':
            message = `Your match in "${data.tournamentName}" is coming up!`;
            type = 'warning';
            break;
    }
    
    if (message && typeof showNotification === 'function') {
        showNotification(message, type);
    }
}

// Example: Handle player joining a tournament
function joinTournament(tournamentId) {
    registerForTournament(tournamentId);
}

// Example: Tournament status indicator
function getTournamentStatusBadge(status) {
    const statusColors = {
        'setup': '#7a8591',
        'registration': '#64c8ff',
        'in-progress': '#4caf50',
        'completed': '#9c27b0',
        'cancelled': '#f44336'
    };
    
    return `
        <span style="
            display: inline-block;
            padding: 0.25rem 0.75rem;
            background: ${statusColors[status] || '#7a8591'}22;
            border: 1px solid ${statusColors[status] || '#7a8591'}44;
            border-radius: 4px;
            font-size: 12px;
            font-weight: 600;
            color: ${statusColors[status] || '#7a8591'};
            text-transform: uppercase;
        ">
            ${status.replace('-', ' ')}
        </span>
    `;
}

// Example: Add keyboard shortcut for tournament modal
document.addEventListener('keydown', (e) => {
    // Ctrl+T to open tournament creation
    if ((e.ctrlKey || e.metaKey) && e.key === 't' && document.activeElement.tagName !== 'INPUT') {
        openTournamentModal();
    }
});

// ============================================
// Usage in your existing code
// ============================================

/*
// In your lobbyJoin or loadLobby function:
async function joinLobby(lobbyId) {
    try {
        // ... existing code ...
        
        // Initialize tournament system
        setupLobby(lobbyId, currentUserId);
        addTournamentMenuOption();
        displayLobbyTournaments(lobbyId);
        
        // ... rest of your code ...
    } catch (error) {
        console.error('Error joining lobby:', error);
    }
}

// In your socket connection handler:
socket.on('connect', () => {
    socket.on('tournament-created', (data) => {
        notifyPlayerOfTournamentEvent('tournament_created', data);
    });
});
*/

// ============================================
// Styling helper for tournament elements
// ============================================

function injectTournamentStyles() {
    const style = document.createElement('style');
    style.textContent = `
        .tournament-setup-btn {
            animation: none;
        }
        
        .tournament-setup-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 4px 12px rgba(100, 200, 255, 0.2);
        }
        
        .tournament-card {
            cursor: pointer;
            user-select: none;
        }
        
        .tournament-card:active {
            transform: scale(0.98);
        }
        
        @media (max-width: 768px) {
            .tournament-modal {
                width: 95% !important;
                max-width: none !important;
            }
        }
    `;
    document.head.appendChild(style);
}

// Call this on page load
injectTournamentStyles();

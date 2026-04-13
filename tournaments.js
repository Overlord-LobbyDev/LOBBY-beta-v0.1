// tournaments.js - ENHANCED VERSION WITH SCORING, TOURNAMENT CLOSURE, AND HOST REGISTRATION
const API_BASE = 'https://lobby-websocket-server.onrender.com';
const AUTH_BASE = 'https://lobby-auth-server.onrender.com';
let selectedPlayerCount = null;
let currentLobbyId = null;
let currentUserId = null;
let userCache = {}; // Cache for user profile data

// Initialize tournament system
let _tournamentListenersAttached = false;
function initTournaments(lobbyId, userId) {
    currentLobbyId = lobbyId;
    currentUserId = userId;

    // Sync card data from the global me object (populated by /me on boot)
    if (typeof me !== 'undefined' && me?.tournamentCard) {
        window.currentUserTournamentCard = me.tournamentCard;
    }
    
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
    if (userCache[userId]) return userCache[userId];
    try {
        const response = await fetch(`${AUTH_BASE}/profile/${userId}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        if (response.ok) {
            const profile = await response.json();
            profile._avatarUrl = profile.avatar_url || profile.profilePicture || null;
            userCache[userId] = profile;
            return profile;
        }
    } catch (error) {
        console.error(`Failed to fetch profile for user ${userId}:`, error);
    }
    return { userId, username: 'Unknown', _avatarUrl: null };
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
        showBracketPanel(tournament);
    } catch (error) {
        console.error('Load tournament details error:', error);
        showNotification('Failed to load tournament details', 'error');
    }
}

function showBracketPanel(tournament) {
    const chatPanel = document.getElementById('chatPanel');
    if (!chatPanel) return;

    window.bracketPanelActive = true;
    window.activeTournament = tournament;

    document.getElementById('homePanel')?.classList.add('hidden');
    document.getElementById('profilePage')?.classList.add('hidden');
    document.getElementById('vcPanel')?.classList.add('hidden');
    chatPanel.classList.remove('hidden');

    const chatHeader = chatPanel.querySelector('.chat-header') || chatPanel.querySelector('#chatHeader');
    const chatMain   = chatPanel.querySelector('.chat-main')   || chatPanel.querySelector('#chatMain');

    const players  = tournament.registeredPlayers || [];
    const bracket  = tournament.bracket || { rounds: [] };
    const fmtMap   = { single:'Single', double:'Double', 'round-robin':'Round Robin' };
    const isHost   = tournament.hostId === currentUserId;
    const isReg    = players.some(p => p.userId === currentUserId);
    const canStart = players.length >= 2;

    // ── Build full bracket skeleton merged with real data ──
    function buildSkeleton(playerCount) {
        const slots = Math.pow(2, Math.ceil(Math.log2(Math.max(playerCount||2, 2))));
        const nr = Math.log2(slots);
        const rounds = [];
        for (let r = 1; r <= nr; r++) {
            const mc = slots / Math.pow(2, r);
            rounds.push({ roundNumber: r, matches: Array.from({length:mc}, (_,i) => ({ matchNumber:i+1, player1:null, player2:null, winner:null, player1Score:null, player2Score:null })) });
        }
        return rounds;
    }

    // Use actual registered players to size the bracket (rounded to nearest power of 2),
    // but never fewer than 2. If a real bracket already exists, use that size.
    const realRounds = bracket.rounds || [];
    let effectiveCount;
    if (realRounds.length > 0) {
        // Derive from actual bracket: first round match count * 2 = slots
        effectiveCount = (realRounds[0]?.matches?.length || 1) * 2;
    } else {
        // Pre-start: use actual registered players (min 2), rounded up to power of 2
        const actualPlayers = Math.max(players.length, 2);
        effectiveCount = Math.pow(2, Math.ceil(Math.log2(actualPlayers)));
    }

    const skeleton = buildSkeleton(effectiveCount);
    const rounds   = skeleton.map(sr => realRounds.find(r => r.roundNumber === sr.roundNumber) || sr);
    const numRounds = rounds.length;

    function getRoundName(r, total) {
        const rem = total - r + 1;
        if (rem === 1) return 'Final';
        if (rem === 2) return 'Semi-Final';
        if (rem === 3) return 'Quarter-Final';
        return `Round ${r}`;
    }

    // ── Tree bracket with absolute positioning ──
    const CARD_H  = 58;   // height of one player card
    const CARD_GAP = 8;   // gap between the two player cards in a match
    const MATCH_H = CARD_H * 2 + CARD_GAP;
    const MATCH_W = 210, COL_GAP = 56, V_PAD = 36;
    const MATCH_GAP = 32; // gap between different matches in same round
    const firstCount = rounds[0]?.matches?.length || 1;
    const slotH0  = MATCH_H + MATCH_GAP;
    const totalH  = firstCount * slotH0 - MATCH_GAP;
    const totalW  = numRounds * MATCH_W + (numRounds - 1) * COL_GAP;

    // Card data comes from server via /me (set on boot as window.currentUserTournamentCard)
    let bgStyle = '';

    // Build a lookup map from registered players for avatar + card style fallback
    const playerAvatarMap = {};
    const playerCardMap = {};
    players.forEach(p => {
        if (p.userId) {
            playerAvatarMap[p.userId] = p.avatar_url || null;
            playerCardMap[p.userId]   = p.tournamentCard || null;
        }
    });

    function playerCard(p, isWinner, isLoser, score) {
        // Use player's own card data from server (works for all players, not just current user)
        const cardData = p?.tournamentCard || (p?.userId ? playerCardMap[p.userId] : null) || {};
        const hasCustom = !!(cardData.imageUrl || (cardData.bgColour && cardData.bgColour !== '#2c3440') || (cardData.borderColour && cardData.borderColour !== '#f9a8d4'));

        const avatarUrl = p?.avatar_url || (p?.userId ? playerAvatarMap[p.userId] : null);
        const avatarContent = avatarUrl
            ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;">`
            : `<span style="font-size:13px;font-weight:800;color:#fff">${p ? (p.username||'?')[0].toUpperCase() : '?'}</span>`;

        let cardBg, border, nameClr;
        if (hasCustom && !isWinner) {
            const bgPos = cardData.bgPos || '50% 50%';
            cardBg  = cardData.imageUrl
                ? `background-image:url(${cardData.imageUrl});background-size:cover;background-position:${bgPos};`
                : `background-color:${cardData.bgColour||'var(--bg-2)'};`;
            border  = `1.5px solid ${cardData.borderColour||'rgba(249,168,212,.5)'}`;
            nameClr = cardData.nameColour || 'var(--text-1)';
        } else {
            cardBg  = isWinner ? 'background-color:rgba(35,165,90,.14);' : 'background-color:var(--bg-2);';
            border  = isWinner ? '1.5px solid rgba(35,165,90,.45)' : '1.5px solid rgba(255,255,255,.09)';
            nameClr = isWinner ? '#57f287' : 'var(--text-1)';
        }

        const nameFw  = isWinner ? 700 : 500;
        const opac    = isLoser ? 'opacity:.35;' : '';
        const sBg     = isWinner ? 'rgba(35,165,90,.22)' : 'var(--bg-3)';
        const sBdr    = isWinner ? 'rgba(35,165,90,.3)' : 'rgba(255,255,255,.1)';
        const sClr    = isWinner ? '#57f287' : 'var(--text-3)';
        return `<div style="display:flex;align-items:center;gap:10px;padding:10px 12px;${cardBg}border:${border};border-radius:10px;${opac}box-shadow:0 3px 10px rgba(0,0,0,.22);height:${CARD_H}px;transition:border-color .15s" onmouseover="this.style.borderColor='rgba(249,168,212,.45)'" onmouseout="this.style.borderColor='${isWinner?'rgba(35,165,90,.45)':hasCustom&&cardData.borderColour?cardData.borderColour:'rgba(255,255,255,.09)'}'">
            <div style="width:34px;height:34px;border-radius:9px;flex-shrink:0;overflow:hidden;background:linear-gradient(135deg,var(--accent),var(--accent-h));display:flex;align-items:center;justify-content:center;box-shadow:0 2px 6px rgba(0,0,0,.3)">${avatarContent}</div>
            <span style="flex:1;font-size:12px;font-weight:${nameFw};color:${nameClr};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p?.username||'TBD'}</span>
            <span style="font-size:11px;font-weight:700;background:${sBg};border:1px solid ${sBdr};border-radius:5px;padding:3px 8px;min-width:26px;text-align:center;color:${sClr}">${score!=null?score:'-'}</span>
        </div>`;
    }

    let matchCards = '';
    let connPaths  = '';

    rounds.forEach((round, rIdx) => {
        const mc    = round.matches.length;
        const slotH = totalH / mc;
        const x     = rIdx * (MATCH_W + COL_GAP);
        const lbl   = getRoundName(round.roundNumber, numRounds);

        matchCards += `<div style="position:absolute;left:${x}px;top:0;width:${MATCH_W}px;text-align:center;font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.3)">${lbl}</div>`;

        round.matches.forEach((match, mIdx) => {
            const matchCY = V_PAD + slotH * mIdx + slotH / 2 - MATCH_H / 2;
            const p1  = match.player1, p2 = match.player2;
            const p1w = !!(match.winner && match.winner === p1?.userId);
            const p2w = !!(match.winner && match.winner === p2?.userId);

            // P1 card
            matchCards += `<div style="position:absolute;left:${x}px;top:${matchCY}px;width:${MATCH_W}px">${playerCard(p1, p1w, p2w && !p1w, match.player1Score)}</div>`;
            // P2 card — separate, below with gap
            matchCards += `<div style="position:absolute;left:${x}px;top:${matchCY + CARD_H + CARD_GAP}px;width:${MATCH_W}px">${playerCard(p2, p2w, p1w && !p2w, match.player2Score)}</div>`;

            // Connector to next round — connect from mid-point between the two cards
            if (rIdx < numRounds - 1) {
                const nextSlotH = totalH / (mc / 2);
                const nextMIdx  = Math.floor(mIdx / 2);
                const y1 = V_PAD + slotH * mIdx + slotH / 2;  // mid of this match slot
                const y2 = V_PAD + nextSlotH * nextMIdx + nextSlotH / 2;
                const x1 = x + MATCH_W;
                const x2 = x + MATCH_W + COL_GAP;
                const mx = x1 + COL_GAP / 2;
                connPaths += `<path d="M${x1},${y1} H${mx} V${y2} H${x2}" fill="none" stroke="rgba(249,168,212,.22)" stroke-width="1.5" stroke-linecap="round"/>`;
            }
        });
    });

    // Trophy icon after final
    const trophyX = numRounds * (MATCH_W + COL_GAP) - COL_GAP + 6;
    const trophyY = V_PAD + totalH / 2 - 18;
    matchCards += `<div style="position:absolute;left:${trophyX}px;top:${trophyY}px;font-size:28px;opacity:.3;pointer-events:none">🏆</div>`;

    const canvasW = totalW + 50;
    const canvasH = totalH + V_PAD + 20;

    const bracketInner = `
      <div style="position:relative;width:${canvasW}px;height:${canvasH}px;display:inline-block">
        <svg style="position:absolute;left:0;top:0;width:100%;height:100%;overflow:visible;pointer-events:none" xmlns="http://www.w3.org/2000/svg">${connPaths}</svg>
        ${matchCards}
      </div>`;

    // ── Sidebar: players + action buttons ──
    const playerHTML = players.length === 0
        ? '<div style="color:var(--text-3);font-size:12px">No players yet</div>'
        : players.map(p => {
            const tag = p.userId === tournament.hostId ? `<span style="font-size:9px;font-weight:700;color:var(--accent);background:rgba(249,168,212,.12);padding:2px 5px;border-radius:4px;flex-shrink:0;margin-left:4px">HOST</span>` : '';
            // Reuse playerCard but inject host tag — wrap in relative div
            const card = playerCard(p, false, false, null);
            // Replace the closing </div> to inject host tag before it
            return card.replace(
                `${p?.username||'TBD'}</span>`,
                `${p?.username||'Unknown'}</span>${tag}`
            );
          }).join('');

    const btnBase = 'display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:9px 14px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity .15s;margin-bottom:6px';

    let actionHTML = '';
    if (tournament.status === 'setup') {
        if (!isReg) {
            actionHTML += `<button style="${btnBase};background:var(--accent);color:#1a0a10" onclick="bracketJoin('${tournament.id}')">🎮 Join Tournament</button>`;
        } else if (!isHost) {
            actionHTML += `<button style="${btnBase};background:var(--bg-3);color:var(--text-2);border:1px solid rgba(255,255,255,.1)" onclick="bracketLeave('${tournament.id}')">🚪 Leave Tournament</button>`;
        }
        if (isHost) {
            actionHTML += `<button style="${btnBase};background:rgba(35,165,90,.15);color:#57f287;border:1px solid rgba(35,165,90,.3);${!canStart?'opacity:.45;cursor:not-allowed':''}" onclick="${canStart?`bracketStart('${tournament.id}')`:''}" ${!canStart?'disabled':''}> ▶ Start Tournament</button>`;
            if (!canStart) actionHTML += `<div style="font-size:11px;color:var(--text-3);text-align:center;margin-top:-4px;margin-bottom:6px">Need at least 2 players</div>`;
        }
    }
    if (tournament.status === 'in-progress' && isHost) {
        actionHTML += `<button style="${btnBase};background:rgba(237,66,69,.12);color:var(--danger);border:1px solid rgba(237,66,69,.3)" onclick="bracketEnd('${tournament.id}')">⏹ End Tournament</button>`;
    }
    if (tournament.status === 'completed') {
        actionHTML += `<div style="text-align:center;font-size:12px;color:var(--text-3);padding:6px 0">🏆 Tournament Complete</div>`;
    }

    const statusColour = tournament.status === 'in-progress' ? '#57f287' : tournament.status === 'completed' ? '#5865f2' : 'var(--yellow)';

    // ── Header ──
    if (chatHeader) {
        const cp  = players.find(p => p.userId === currentUserId);
        const cav = cp?.avatar_url ? `<img src="${cp.avatar_url}" style="width:100%;height:100%;object-fit:cover">` : (cp?.username||'?')[0].toUpperCase();
        chatHeader.innerHTML = `
          <div style="display:flex;align-items:center;justify-content:space-between;flex:1">
            <div style="display:flex;align-items:center;gap:12px">
              <div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--accent),var(--accent-h));display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:15px;flex-shrink:0;overflow:hidden">${cav}</div>
              <div>
                <h2 style="font-size:15px;font-weight:800;margin:0;color:var(--text-1)">${tournament.name}</h2>
                <div style="display:flex;align-items:center;gap:6px;margin-top:4px">
                  <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px;background:rgba(88,101,242,.1);border:1px solid rgba(88,101,242,.25);color:var(--text-2)">👥 ${players.length}/${tournament.playerCount}</span>
                  <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px;background:rgba(88,101,242,.1);border:1px solid rgba(88,101,242,.25);color:var(--text-2)">📋 ${fmtMap[tournament.format]||tournament.format}</span>
                  <span style="font-size:10px;font-weight:700;padding:3px 8px;border-radius:12px;color:${statusColour};background:rgba(0,0,0,.2);border:1px solid currentColor">${tournament.status.replace(/-/g,' ').toUpperCase()}</span>
                </div>
              </div>
            </div>
            <button onclick="closeBracketPanel()" style="background:transparent;border:none;color:var(--text-2);cursor:pointer;font-size:18px;padding:4px 8px;opacity:.6;border-radius:6px" onmouseover="this.style.opacity='1';this.style.background='var(--bg-3)'" onmouseout="this.style.opacity='.6';this.style.background='transparent'">✕</button>
          </div>`;
    }

    // ── Main content ──
    if (chatMain) {
        chatMain.innerHTML = `
          <div style="display:flex;flex:1;min-height:0;overflow:hidden">
            <!-- Sidebar -->
            <div style="width:240px;min-width:240px;background:var(--bg-1);border-right:1px solid rgba(255,255,255,.06);display:flex;flex-direction:column;overflow-y:auto;flex-shrink:0">
              <!-- Stats -->
              <div style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.06)">
                <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:10px">Stats</div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:7px">
                  <div style="background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.15);border-radius:6px;padding:9px;text-align:center"><div style="font-size:8px;color:var(--text-3);text-transform:uppercase;font-weight:700;margin-bottom:2px">Format</div><div style="font-size:13px;font-weight:800;color:var(--accent)">${(fmtMap[tournament.format]||tournament.format).split(' ')[0]}</div></div>
                  <div style="background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.15);border-radius:6px;padding:9px;text-align:center"><div style="font-size:8px;color:var(--text-3);text-transform:uppercase;font-weight:700;margin-bottom:2px">Status</div><div style="font-size:11px;font-weight:800;color:${statusColour}">${tournament.status}</div></div>
                  <div style="background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.15);border-radius:6px;padding:9px;text-align:center"><div style="font-size:8px;color:var(--text-3);text-transform:uppercase;font-weight:700;margin-bottom:2px">Players</div><div style="font-size:13px;font-weight:800;color:var(--accent)">${players.length}</div></div>
                  <div style="background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.15);border-radius:6px;padding:9px;text-align:center"><div style="font-size:8px;color:var(--text-3);text-transform:uppercase;font-weight:700;margin-bottom:2px">Slots</div><div style="font-size:13px;font-weight:800;color:var(--accent)">${tournament.playerCount}</div></div>
                </div>
              </div>
              <!-- Actions -->
              ${actionHTML ? `<div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.06)">${actionHTML}</div>` : ''}
              <!-- Players -->
              <div style="padding:14px 16px;flex:1">
                <div style="font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:10px">Players (${players.length})</div>
                <div style="display:flex;flex-direction:column;gap:6px">${playerHTML}</div>
              </div>
            </div>
            <!-- Bracket area -->
            <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">
              <div style="padding:10px 18px;background:var(--bg-1);border-bottom:1px solid rgba(255,255,255,.06);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3);flex-shrink:0">Tournament Bracket</div>
              <div style="flex:1;overflow:auto;padding:28px 32px;${bgStyle}" id="bracketInnerScroll">
                ${bracketInner}
              </div>
            </div>
          </div>`;
    }
}

// Bracket panel action helpers
async function bracketJoin(tournamentId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to join');
        showNotification('Joined tournament! 🎮', 'success');
        setTimeout(() => openTournamentDetails(tournamentId), 400);
    } catch(e) { showNotification(e.message || 'Failed to join', 'error'); }
}

async function bracketLeave(tournamentId) {
    if (!confirm('Leave this tournament?')) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/leave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to leave');
        showNotification('Left tournament', 'success');
        setTimeout(() => openTournamentDetails(tournamentId), 400);
    } catch(e) { showNotification(e.message || 'Failed to leave', 'error'); }
}

async function bracketStart(tournamentId) {
    if (!confirm('Start the tournament? Players cannot join after this.')) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/generate-bracket`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to start');
        showNotification('Tournament started! ▶', 'success');
        setTimeout(() => openTournamentDetails(tournamentId), 400);
    } catch(e) { showNotification(e.message || 'Failed to start', 'error'); }
}

async function bracketEnd(tournamentId) {
    if (!confirm('End this tournament? This cannot be undone.')) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/close`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to end');
        showNotification('Tournament ended 🏁', 'success');
        closeBracketPanel();
        loadTournaments();
    } catch(e) { showNotification(e.message || 'Failed to end', 'error'); }
}

window.bracketJoin  = bracketJoin;
window.bracketLeave = bracketLeave;
window.bracketStart = bracketStart;
window.bracketEnd   = bracketEnd;

function closeBracketPanel() {
    // Clean up state
    window.bracketPanelActive = false;
    window.activeTournament = null;
    
    const chatPanel = document.getElementById('chatPanel');
    if (!chatPanel) return;
    
    // Get or find the message container
    const messageContainer = chatPanel.querySelector('.messages-container') || 
                             chatPanel.querySelector('#messagesContainer') ||
                             chatPanel.querySelector('.chat-main');
    
    if (messageContainer) {
        // Just clear it - let the app reinitialize when switching channels
        messageContainer.innerHTML = '';
    }
    
    // Also clear header if it exists
    const chatHeader = chatPanel.querySelector('.chat-header') || chatPanel.querySelector('#chatHeader');
    if (chatHeader) {
        chatHeader.innerHTML = '';
    }
}

// Intercept ALL panel switches to clean up bracket state
const originalSelectServer = window.selectServer;
if (originalSelectServer && typeof originalSelectServer === 'function') {
    window.selectServer = async function(server) {
        if (window.bracketPanelActive) {
            closeBracketPanel();
        }
        return originalSelectServer.call(this, server);
    };
}

// Monitor for panel visibility changes to clean up when leaving chat panel
const observer = new MutationObserver(function(mutations) {
    mutations.forEach(function(mutation) {
        if (mutation.attributeName === 'class') {
            const chatPanel = document.getElementById('chatPanel');
            // If chatPanel is being hidden while bracket is active, clean up
            if (window.bracketPanelActive && chatPanel && chatPanel.classList.contains('hidden')) {
                closeBracketPanel();
            }
        }
    });
});

// Start observing chatPanel for class changes
document.addEventListener('DOMContentLoaded', function() {
    const chatPanel = document.getElementById('chatPanel');
    if (chatPanel) {
        observer.observe(chatPanel, { attributes: true, attributeFilter: ['class'] });
    }
});

// Also observe on script load in case DOM is already ready
(function() {
    const _cp = document.getElementById('chatPanel');
    if (_cp) observer.observe(_cp, { attributes: true, attributeFilter: ['class'] });
})();

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
                    const p1Avatar = p1Profile?._avatarUrl || p1Profile?.avatar_url || p1Profile?.profilePicture || null;
                    const p2Avatar = p2Profile?._avatarUrl || p2Profile?.avatar_url || p2Profile?.profilePicture || null;
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
                
                ${isHost && tournament.status === 'completed' ? `
                    <button onclick="deleteTournament('${tournament.id}')" class="btn-delete">Delete Tournament</button>
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

// Delete tournament (host only - completed tournaments only)
async function deleteTournament(tournamentId) {
    if (!confirm('Are you sure you want to delete this tournament? This cannot be undone.')) {
        return;
    }

    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${localStorage.getItem('vh_token')}`
            }
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.error || 'Failed to delete tournament');
        }

        showNotification('Tournament deleted successfully', 'success');
        
        // Close modal and refresh
        document.querySelector('.tournament-container.active')?.remove();
        loadTournaments();

        // Emit socket event
        if (window.socket) {
            window.socket.emit('tournament-deleted', { tournamentId });
        }
    } catch (error) {
        console.error('Delete tournament error:', error);
        showNotification(error.message || 'Failed to delete tournament', 'error');
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
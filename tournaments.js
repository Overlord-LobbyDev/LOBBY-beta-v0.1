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

    // Start schedule checker (fires alerts for upcoming tournaments)
    startScheduleChecker();
    
    // Add tournament button to lobby menu
    addTournamentButton();
    
    // Load existing tournaments for this lobby
    loadTournaments();

    // Register WebSocket handlers — retry until socket is ready
    registerTournamentSocketHandlers();
    if (!ws) {
        const _sockPoll = setInterval(() => {
            if (ws) {
                clearInterval(_sockPoll);
                registerTournamentSocketHandlers();
            }
        }, 500);
    }
    // Also re-register whenever the socket reconnects
    window._tournamentSocketRegistered = true;
    
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

    // Read result mode — "automatic" maps to the specific API type
    // Sources: radio buttons (tournaments.html) OR hidden #tournamentResultMode (index.html dropdown)
    const rawMode   = (document.querySelector('input[name="resultMode"]:checked')?.value)
                        || document.getElementById('tournamentResultMode')?.value
                        || window._pendingResultMode
                        || 'manual';
    const apiType   = document.getElementById('autoApiType')?.value  || 'riot-api';
    const apiGame   = document.getElementById('autoGameValue')?.value || 'lol';
    const resultMode = rawMode === 'automatic' ? apiType : rawMode;
    const resolvedApiGame = rawMode === 'automatic' ? apiGame : null;

    const tournamentData = {
        lobbyId: currentLobbyId,
        name: document.getElementById('tournamentName').value,
        description: document.getElementById('tournamentDesc').value,
        format: document.getElementById('tournamentFormat').value,
        playerCount: selectedPlayerCount,
        rules: document.getElementById('tournamentRules').value,
        prize: document.getElementById('tournamentPrize').value,
        hasLosersBracket:     document.getElementById('tournamentLosers')?.checked || false,
        hasPointsTally:       document.getElementById('tournamentPoints')?.checked !== false,
        hostJoinsAsPlayer:    document.getElementById('tournamentHostJoins')?.checked !== false,
        resultMode,
        apiGame:              resolvedApiGame,
        disputeTimeout:       parseInt(document.getElementById('disputeTimeoutInput')?.value)
                                || window._pendingDisputeTimeout
                                || 30,
        scheduledStart:       document.getElementById('tournamentScheduleToggle')?.checked
                                ? document.getElementById('tournamentScheduledTime')?.value || null
                                : null,
        alertBeforeMinutes:   parseInt(document.getElementById('tournamentAlertMins')?.value) || 15
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
        if (ws) {
            wsSend('tournament-created', {
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

    // Update status badge in sidebar header
    if (typeof window._updateTournamentBadge === 'function') {
        window._updateTournamentBadge(tournaments);
    }

    if (tournaments.length === 0) {
        container.innerHTML = '<p style="color: #7a8591; text-align: center; padding: 2rem;">No tournaments yet. Create one to get started!</p>';
        return;
    }

    container.innerHTML = tournaments.map(tournament => {
        // Build scheduled countdown string if applicable
        let schedBadge = '';
        if (tournament.scheduledStart && tournament.status === 'setup') {
            const ms = new Date(tournament.scheduledStart).getTime() - Date.now();
            if (ms > 0) {
                const h = Math.floor(ms / 3600000);
                const m = Math.floor((ms % 3600000) / 60000);
                const timeStr = h > 0 ? `${h}h ${m}m` : `${m}m`;
                const localTime = new Date(tournament.scheduledStart).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
                schedBadge = `<div style="margin-top:4px;font-size:9px;color:rgba(250,200,80,.85);display:flex;align-items:center;gap:4px">
                    <span>⏰</span>
                    <span id="countdown_${tournament.id}">${timeStr}</span>
                    <span style="color:var(--text-3)">· ${localTime}</span>
                </div>`;
            }
        }
        return `
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
            ${schedBadge}
        </div>
    `}).join('');
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
    const CARD_H  = 52;   // height of one player card
    const CARD_GAP = 6;   // gap between the two player cards in a match
    const MATCH_H = CARD_H * 2 + CARD_GAP;
    const MATCH_W = 210, COL_GAP = 80, V_PAD = 36;
    // Lock row sits below match cards: 28px row + 6px gap above + 10px gap below = 44px
    const LOCK_ROW_H = 44;
    const scoringCardH = 130;
    // slotH must include the match cards + lock row + padding before the next match
    const MATCH_GAP = window._bracketScoringMode ? (LOCK_ROW_H + 28) : (LOCK_ROW_H + 14);
    const effectiveMatchH = window._bracketScoringMode ? scoringCardH : MATCH_H;
    const firstCount = rounds[0]?.matches?.length || 1;
    const slotH0  = effectiveMatchH + MATCH_GAP;
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

    function playerCard(p, isWinner, isLoser, score, isLocked) {
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
            <span style="flex:1;font-size:12px;font-weight:700;color:${nameClr};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:${hasCustom?'0 1px 4px rgba(0,0,0,.7)':''}">${p?.username||'TBD'}</span>
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
            const scoringMode = window._bracketScoringMode && isHost && tournament.status === 'in-progress';
            const mid = match.matchId || null;
            const hasRealMatch = !!mid;

            if (scoringMode) {
                const p1name = p1?.username || 'TBD';
                const p2name = p2?.username || 'TBD';
                const p1score = match.player1Score ?? 0;
                const p2score = match.player2Score ?? 0;
                const p1uid = p1?.userId || null;
                const p2uid = p2?.userId || null;
                const canEdit = hasRealMatch;

                // Avatar helpers
                const mkAvatar = (player) => {
                    if (player?.avatar_url) return `<img src="${player.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:7px;">`;
                    const ch = (player?.username || '?')[0].toUpperCase();
                    return `<span style="font-size:11px;font-weight:800;color:#fff">${ch}</span>`;
                };

                if (!canEdit) {
                    // Awaiting players — compact greyed placeholder, exact MATCH_W
                    matchCards += `
                    <div style="position:absolute;left:${x}px;top:${matchCY}px;width:${MATCH_W}px;background:var(--bg-2);border:1px dashed rgba(255,255,255,.1);border-radius:10px;padding:12px 12px;opacity:.4">
                      <div style="font-size:8px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:8px">⏳ Awaiting Players</div>
                      <div style="height:26px;background:rgba(255,255,255,.05);border-radius:6px;margin-bottom:5px"></div>
                      <div style="height:26px;background:rgba(255,255,255,.05);border-radius:6px"></div>
                    </div>`;
                } else {
                    // Active edit card — exactly MATCH_W wide so it never overflows into next column
                    const cardStyle = `position:absolute;left:${x}px;top:${matchCY}px;width:${MATCH_W}px;background:var(--bg-1);border:1.5px solid rgba(88,101,242,.45);border-radius:12px;overflow:hidden`;

                    // Per-player card background (respects their custom card style)
                    const rowBg = (player) => {
                        const cd = player?.tournamentCard || (player?.userId ? playerCardMap[player.userId] : null) || {};
                        if (cd.imageUrl) return `background-image:url(${cd.imageUrl});background-size:cover;background-position:${cd.bgPos||'50% 50%'};`;
                        if (cd.bgColour && cd.bgColour !== '#2c3440') return `background-color:${cd.bgColour};`;
                        return 'background:var(--bg-2);';
                    };
                    const rowBorder = (player) => {
                        const cd = player?.tournamentCard || (player?.userId ? playerCardMap[player.userId] : null) || {};
                        return cd.borderColour || 'rgba(255,255,255,.06)';
                    };
                    const nameClr = (player) => {
                        const cd = player?.tournamentCard || (player?.userId ? playerCardMap[player.userId] : null) || {};
                        return cd.nameColour || 'var(--text-1)';
                    };

                    const winBtn = (uid) => `<button onclick="bracketAdvance('${tournament.id}','${mid}','${uid}')" style="flex-shrink:0;padding:4px 8px;background:rgba(35,165,90,.18);color:#57f287;border:1px solid rgba(35,165,90,.35);border-radius:6px;cursor:pointer;font-size:10px;font-weight:800;font-family:inherit;white-space:nowrap" onmouseover="this.style.background='rgba(35,165,90,.32)'" onmouseout="this.style.background='rgba(35,165,90,.18)'">▶ Win</button>`;

                    const scoreInput = (id, val) => `<input id="${id}" type="number" min="0" max="999" value="${val}" style="width:40px;flex-shrink:0;background:rgba(0,0,0,.3);border:1px solid rgba(255,255,255,.15);border-radius:5px;color:#fff;font-size:12px;font-weight:700;padding:3px 0;text-align:center;outline:none;font-family:inherit" onfocus="this.style.borderColor='rgba(88,101,242,.7)'" onblur="this.style.borderColor='rgba(255,255,255,.15)'" />`;

                    const avatarDiv = (player) => {
                        const av = mkAvatar(player);
                        return `<div style="width:24px;height:24px;flex-shrink:0;border-radius:6px;background:linear-gradient(135deg,var(--accent),var(--accent-h));display:flex;align-items:center;justify-content:center;overflow:hidden">${av}</div>`;
                    };

                    matchCards += `
                    <div style="${cardStyle}">
                      <div style="padding:5px 10px 4px;background:rgba(88,101,242,.12);border-bottom:1px solid rgba(88,101,242,.2);display:flex;align-items:center;justify-content:space-between">
                        <div style="display:flex;align-items:center;gap:5px">
                          <span style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(150,160,255,.8)">Match ${mIdx + 1}</span>
                          ${match.roundLocked ? `<span data-lock-ready="${mid}" style="font-size:8px;font-weight:800;color:#57f287;background:rgba(35,165,90,.15);border:1px solid rgba(35,165,90,.3);border-radius:3px;padding:1px 4px">✅ Ready</span>` : `<span data-lock-ready="${mid}" style="display:none;font-size:8px;font-weight:800;color:#57f287;background:rgba(35,165,90,.15);border:1px solid rgba(35,165,90,.3);border-radius:3px;padding:1px 4px">✅ Ready</span>`}
                        </div>
                        <div style="display:flex;gap:4px">
                          <button onclick="bracketSaveScores('${tournament.id}','${mid}')" style="font-size:8px;font-weight:800;padding:3px 7px;background:rgba(88,101,242,.25);color:rgba(160,170,255,.9);border:1px solid rgba(88,101,242,.4);border-radius:4px;cursor:pointer;font-family:inherit;text-transform:uppercase;letter-spacing:.4px" onmouseover="this.style.background='rgba(88,101,242,.45)'" onmouseout="this.style.background='rgba(88,101,242,.25)'">💾 Save</button>
                        </div>
                      </div>
                      <div style="display:flex;align-items:center;gap:7px;padding:8px 10px;${rowBg(p1)}border-bottom:1px solid ${rowBorder(p1)}">
                        ${avatarDiv(p1)}
                        <span style="flex:1;font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${nameClr(p1)};text-shadow:${p1?.tournamentCard?.imageUrl?'0 1px 3px rgba(0,0,0,.8)':''}">${p1name}</span>
                        ${(match.lockedPlayers||[]).includes(p1uid) ? `<span style="font-size:9px;color:#57f287;flex-shrink:0">✅</span>` : ''}
                        ${scoreInput(`s_${mid}_1`, p1score)}
                        ${winBtn(p1uid)}
                      </div>
                      <div style="display:flex;align-items:center;justify-content:center;height:14px;position:relative">
                        <span style="font-size:8px;font-weight:800;color:var(--text-3);letter-spacing:1px;padding:0 5px;background:var(--bg-1);position:relative;z-index:1">VS</span>
                        <div style="position:absolute;left:10px;right:10px;height:1px;background:rgba(255,255,255,.04)"></div>
                      </div>
                      <div style="display:flex;align-items:center;gap:7px;padding:8px 10px;${rowBg(p2)}">
                        ${avatarDiv(p2)}
                        <span style="flex:1;font-size:11px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:${nameClr(p2)};text-shadow:${p2?.tournamentCard?.imageUrl?'0 1px 3px rgba(0,0,0,.8)':''}">${p2name}</span>
                        ${(match.lockedPlayers||[]).includes(p2uid) ? `<span style="font-size:9px;color:#57f287;flex-shrink:0">✅</span>` : ''}
                        ${scoreInput(`s_${mid}_2`, p2score)}
                        ${winBtn(p2uid)}
                      </div>
                    </div>`;
                } // end canEdit else
            } else {
                // Normal view
                // Normalise locked list to strings for safe comparison
                const locked = (match.lockedPlayers||[]).map(String);
                const p1locked = locked.includes(String(p1?.userId));
                const p2locked = locked.includes(String(p2?.userId));
                const isInMatch = (String(p1?.userId) === String(currentUserId) || String(p2?.userId) === String(currentUserId)) && tournament.status === 'in-progress' && !!mid;
                const iAmP1 = String(p1?.userId) === String(currentUserId);
                const myLocked = iAmP1 ? p1locked : p2locked;

                matchCards += `<div style="position:absolute;left:${x}px;top:${matchCY}px;width:${MATCH_W}px">${playerCard(p1, p1w, p2w && !p1w, match.player1Score, false)}</div>`;
                matchCards += `<div style="position:absolute;left:${x}px;top:${matchCY + CARD_H + CARD_GAP}px;width:${MATCH_W}px">${playerCard(p2, p2w, p1w && !p2w, match.player2Score, false)}</div>`;

                // Lock-in status row — visible to everyone when match has real players & is in-progress
                if ((p1?.userId || p2?.userId) && tournament.status === 'in-progress' && mid) {
                    const lockRowY = matchCY + MATCH_H + 8;
                    const statusPill = (name, uid, isLocked) =>
                        `<div data-lock-match="${mid}" data-lock-user="${uid}" data-lock-name="${name||''}" style="flex:1;display:flex;align-items:center;gap:4px;padding:3px 7px;border-radius:5px;background:${isLocked?'rgba(35,165,90,.12)':'rgba(255,255,255,.04)'};border:1px solid ${isLocked?'rgba(35,165,90,.3)':'rgba(255,255,255,.1)'}">
                           <span style="font-size:10px;line-height:1">${isLocked?'✔':'✘'}</span>
                           <span style="font-size:8px;font-weight:700;color:${isLocked?'#57f287':'var(--text-3)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${name||'TBD'}</span>
                         </div>`;

                    const isSelfReport = tournament.resultMode === 'self-report';
                    const isApiMode    = tournament.resultMode === 'riot-api' || tournament.resultMode === 'chess-api';
                    const bothLocked = p1locked && p2locked;
                    const myReport = iAmP1 ? match.p1Report : match.p2Report;
                    const alreadyReported = !!myReport;
                    const hasDispute = match.disputeStatus === 'disputed' || match.disputeStatus === 'timeout';

                    // Report Result button — shown to players in self-report mode once both locked in
                    const reportBtn = isSelfReport && isInMatch && bothLocked && !alreadyReported && !match.winner
                        ? `<button onclick="showReportModal('${tournament.id}','${mid}','${p1?.username||''}','${p2?.username||''}','${p1?.userId||''}','${p2?.userId||''}')" style="flex-shrink:0;font-size:8px;font-weight:800;padding:3px 8px;background:rgba(88,101,242,.2);color:rgba(160,170,255,.95);border:1px solid rgba(88,101,242,.35);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap" onmouseover="this.style.background='rgba(88,101,242,.35)'" onmouseout="this.style.background='rgba(88,101,242,.2)'">📊 Report</button>`
                        : alreadyReported && !match.winner
                            ? `<span style="flex-shrink:0;font-size:8px;font-weight:700;color:var(--text-3);padding:3px 8px">⏳ Waiting</span>`
                            : '';

                    // Dispute badge for host (disputed or timed out)
                    const disputeBtn = hasDispute && isHost && !match.winner
                        ? `<button onclick="showDisputeModal('${tournament.id}','${mid}','${p1?.username||''}','${p2?.username||''}','${p1?.userId||''}','${p2?.userId||''}')" style="flex-shrink:0;font-size:8px;font-weight:800;padding:3px 8px;background:rgba(237,66,69,.2);color:rgba(255,120,120,.95);border:1px solid rgba(237,66,69,.35);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap;animation:pulse 1s ease infinite alternate" onmouseover="this.style.background='rgba(237,66,69,.35)'" onmouseout="this.style.background='rgba(237,66,69,.2)'">${match.disputeStatus === 'timeout' ? '⏰ Timeout' : '⚠ Dispute'}</button>`
                        : '';

                    // API mode: "Check Result" button — shown to both players and host once both locked in
                    const apiCheckBtn = isApiMode && bothLocked && !match.winner && mid
                        ? `<button onclick="bracketApiPoll('${tournament.id}','${mid}')" style="flex-shrink:0;font-size:8px;font-weight:800;padding:3px 8px;background:rgba(88,101,242,.2);color:rgba(160,170,255,.95);border:1px solid rgba(88,101,242,.35);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap" onmouseover="this.style.background='rgba(88,101,242,.35)'" onmouseout="this.style.background='rgba(88,101,242,.2)'">🔍 Check Result</button>`
                        : '';

                    // Watch Live button — shown when game_url is set (chess-api mode)
                    const gameUrl = match.gameUrl || null;
                    const platform = tournament.apiGame || '';
                    const watchBtn = gameUrl && tournament.resultMode === 'chess-api'
                        ? platform === 'lichess'
                            ? `<button onclick="toggleLiveBoard('${mid}','${gameUrl}')" style="flex-shrink:0;font-size:8px;font-weight:800;padding:3px 8px;background:rgba(35,165,90,.15);color:#57f287;border:1px solid rgba(35,165,90,.3);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap">📺 Watch</button>`
                            : `<a href="${gameUrl}" target="_blank" style="flex-shrink:0;font-size:8px;font-weight:800;padding:3px 8px;background:rgba(35,165,90,.15);color:#57f287;border:1px solid rgba(35,165,90,.3);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap;text-decoration:none">🔗 Watch</a>`
                        : '';

                    matchCards += `<div style="position:absolute;left:${x}px;top:${lockRowY}px;width:${MATCH_W}px;display:flex;gap:4px;align-items:center;flex-wrap:wrap">
                        ${statusPill(p1?.username, p1?.userId, p1locked)}
                        ${statusPill(p2?.username, p2?.userId, p2locked)}
                        ${isInMatch && !myLocked ? `<button data-lock-btn="${mid}" onclick="bracketLockIn('${tournament.id}','${mid}')" style="flex-shrink:0;font-size:8px;font-weight:800;padding:3px 8px;background:rgba(250,166,26,.2);color:rgba(250,200,80,.95);border:1px solid rgba(250,166,26,.35);border-radius:5px;cursor:pointer;font-family:inherit;white-space:nowrap" onmouseover="this.style.background='rgba(250,166,26,.35)'" onmouseout="this.style.background='rgba(250,166,26,.2)'">🔒 Lock</button>` : ''}
                        ${reportBtn}
                        ${apiCheckBtn}
                        ${disputeBtn}
                        ${watchBtn}
                    </div>
                    <div id="liveBoard_${mid}" style="display:none;position:absolute;left:${x}px;top:${lockRowY + 34}px;width:${MATCH_W}px;z-index:10"></div>`;
                }
            }

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
    const showPoints = tournament.hasPointsTally !== false; // default on

    // Calculate points tally per player from all matches
    const pointsMap = {};
    players.forEach(p => { if (p.userId) pointsMap[p.userId] = 0; });
    const eliminatedSet = new Set();
    const winnerId = tournament.winnerId || null;  // overall tournament winner user_id

    if (bracket.rounds) {
        bracket.rounds.forEach(round => {
            (round.matches || []).forEach(match => {
                if (match.player1?.userId && match.player1Score != null)
                    pointsMap[match.player1.userId] = (pointsMap[match.player1.userId] || 0) + (match.player1Score || 0);
                if (match.player2?.userId && match.player2Score != null)
                    pointsMap[match.player2.userId] = (pointsMap[match.player2.userId] || 0) + (match.player2Score || 0);
                // Mark loser as eliminated (only if a winner is set, no losers bracket)
                if (match.winner && !tournament.hasLosersBracket) {
                    if (match.player1?.userId && match.winner !== match.player1.userId) eliminatedSet.add(match.player1.userId);
                    if (match.player2?.userId && match.winner !== match.player2.userId) eliminatedSet.add(match.player2.userId);
                }
            });
        });
    }

    // Never mark the tournament winner as eliminated
    if (winnerId) eliminatedSet.delete(winnerId);

    // Sort active players by points desc, exclude winner from main list
    const winnerPlayer      = players.find(p => p.userId === winnerId);
    // Active players — all registered players except the winner (host CAN appear here if they joined as player)
    const activePlayers     = players.filter(p => !eliminatedSet.has(p.userId) && p.userId !== winnerId);
    const eliminatedPlayers = players.filter(p => eliminatedSet.has(p.userId));
    activePlayers.sort((a, b) => (pointsMap[b.userId] || 0) - (pointsMap[a.userId] || 0));

    const renderPlayerRow = (p, isEliminated) => {
        const isHost = p.userId === tournament.hostId;
        const pts = pointsMap[p.userId] || 0;
        const avatarUrl = p.avatar_url;
        const cardData = p.tournamentCard || {};
        const hasImg = !!cardData.imageUrl;
        const bgCss = hasImg
            ? `background-image:url(${cardData.imageUrl});background-size:cover;background-position:${cardData.bgPos||'50% 50%'};`
            : cardData.bgColour && cardData.bgColour !== '#2c3440'
                ? `background-color:${cardData.bgColour};`
                : 'background:var(--bg-2);';
        const borderCss = `1px solid ${cardData.borderColour||'rgba(255,255,255,.09)'}`;
        const nameClrCss = cardData.nameColour || 'var(--text-1)';

        const av = avatarUrl
            ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:7px;${isEliminated?'filter:grayscale(1)':''}">`
            : `<span style="font-size:11px;font-weight:800;color:#fff">${(p.username||'?')[0].toUpperCase()}</span>`;

        // Right-click context menu for host (setup only)
        const ctxAttr = (isHost && tournament.status === 'setup' && p.userId !== currentUserId)
            ? `oncontextmenu="bracketRemovePlayer(event,'${tournament.id}','${p.userId}','${p.username}')"` : '';

        if (isEliminated) {
            return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.05);border-radius:8px;opacity:.45" ${ctxAttr}>
              <div style="width:26px;height:26px;flex-shrink:0;border-radius:7px;background:rgba(255,255,255,.08);display:flex;align-items:center;justify-content:center;overflow:hidden">${av}</div>
              <span style="flex:1;font-size:11px;font-weight:600;color:var(--text-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-decoration:line-through">${p.username||'Unknown'}</span>
              ${isHost ? `<span style="font-size:8px;font-weight:700;color:var(--accent);background:rgba(249,168,212,.12);padding:2px 5px;border-radius:4px;flex-shrink:0">HOST</span>` : ''}
            </div>`;
        }

        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;${bgCss}border:${borderCss};border-radius:8px;overflow:hidden;cursor:${isHost && tournament.status === 'setup' && p.userId !== currentUserId ? 'context-menu' : 'default'}" ${ctxAttr} title="${isHost && tournament.status === 'setup' && p.userId !== currentUserId ? 'Right-click to remove' : ''}">
          <div style="width:26px;height:26px;flex-shrink:0;border-radius:7px;background:linear-gradient(135deg,var(--accent),var(--accent-h));display:flex;align-items:center;justify-content:center;overflow:hidden">${av}</div>
          <span style="flex:1;font-size:11px;font-weight:700;color:${hasImg?'#fff':nameClrCss};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:${hasImg?'0 1px 3px rgba(0,0,0,.8)':''}">${p.username||'Unknown'}</span>
          ${isHost ? `<span style="font-size:8px;font-weight:700;color:var(--accent);background:rgba(249,168,212,.15);padding:2px 5px;border-radius:4px;flex-shrink:0">HOST</span>` : ''}
          ${showPoints && tournament.status === 'in-progress' ? `<span style="font-size:10px;font-weight:800;color:var(--accent);background:rgba(249,168,212,.1);border:1px solid rgba(249,168,212,.2);padding:1px 6px;border-radius:10px;flex-shrink:0">${pts}pts</span>` : ''}
        </div>`;
    };

    const activeHTML = activePlayers.length === 0
        ? '<div style="color:var(--text-3);font-size:11px;padding:4px 0">No players yet</div>'
        : activePlayers.map(p => renderPlayerRow(p, false)).join('');

    const eliminatedHTML = eliminatedPlayers.length > 0
        ? `<div style="margin-top:10px">
             <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:5px;display:flex;align-items:center;gap:5px">
               <span style="flex:1;height:1px;background:rgba(255,255,255,.07)"></span>ELIMINATED<span style="flex:1;height:1px;background:rgba(255,255,255,.07)"></span>
             </div>
             <div style="display:flex;flex-direction:column;gap:4px">${eliminatedPlayers.map(p => renderPlayerRow(p, true)).join('')}</div>
           </div>` : '';

    const winnerHTML = winnerPlayer
        ? `<div style="margin-bottom:10px">
             <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,200,50,.7);margin-bottom:5px">🏆 CHAMPION</div>
             <div style="position:relative">
               ${renderPlayerRow(winnerPlayer, false)}
               <div style="position:absolute;top:-2px;right:-2px;background:rgba(255,200,50,.15);border:1px solid rgba(255,200,50,.4);border-radius:5px;padding:1px 6px;font-size:8px;font-weight:800;color:rgba(255,200,50,.9)">🏆 Winner</div>
             </div>
           </div>` : '';

    // Host card — always shown at top, uses server-provided hostInfo (works even if host left as player)
    const hostCard = (() => {
        const h = tournament.hostInfo || { userId: tournament.hostId, username: 'Host', avatar_url: null, tournamentCard: {} };
        const cd = h.tournamentCard || {};
        const hasImg = !!cd.imageUrl;
        const bgCss = hasImg
            ? `background-image:url(${cd.imageUrl});background-size:cover;background-position:${cd.bgPos||'50% 50%'};`
            : cd.bgColour && cd.bgColour !== '#2c3440' ? `background-color:${cd.bgColour};` : 'background:rgba(249,168,212,.06);';
        const borderCss = cd.borderColour ? `1px solid ${cd.borderColour}` : '1px solid rgba(249,168,212,.18)';
        const av = h.avatar_url
            ? `<img src="${h.avatar_url}" style="width:100%;height:100%;object-fit:cover;border-radius:6px;">`
            : `<span style="font-size:10px;font-weight:800;color:#fff">${(h.username||'?')[0].toUpperCase()}</span>`;
        return `<div style="display:flex;align-items:center;gap:8px;padding:7px 10px;${bgCss}border:${borderCss};border-radius:8px;overflow:hidden">
          <div style="width:26px;height:26px;flex-shrink:0;border-radius:6px;background:linear-gradient(135deg,var(--accent),var(--accent-h));display:flex;align-items:center;justify-content:center;overflow:hidden">${av}</div>
          <span style="flex:1;font-size:11px;font-weight:700;color:${hasImg?'#fff':cd.nameColour||'var(--text-1)'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-shadow:${hasImg?'0 1px 3px rgba(0,0,0,.8)':''}">${h.username||'Host'}</span>
          <span style="font-size:8px;font-weight:800;color:var(--accent);background:rgba(249,168,212,.12);border:1px solid rgba(249,168,212,.2);padding:2px 6px;border-radius:4px;flex-shrink:0">HOST</span>
        </div>`;
    })();

    const playerHTML = winnerHTML + activeHTML + eliminatedHTML;

    const btnBase = 'display:flex;align-items:center;justify-content:center;gap:6px;width:100%;padding:9px 14px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit;transition:opacity .15s;margin-bottom:6px';

    let actionHTML = '';
    if (tournament.status === 'setup') {
        if (!isReg) {
            actionHTML += `<button style="${btnBase};background:var(--accent);color:#1a0a10" onclick="bracketJoin('${tournament.id}')">🎮 Join Tournament</button>`;
        } else if (!isHost) {
            actionHTML += `<button style="${btnBase};background:var(--bg-3);color:var(--text-2);border:1px solid rgba(255,255,255,.1)" onclick="bracketLeave('${tournament.id}')">🚪 Leave Tournament</button>`;
        } else if (isHost && isReg) {
            // Host is registered as player — give option to leave as player (still hosts)
            actionHTML += `<button style="${btnBase};background:var(--bg-3);color:var(--text-3);border:1px solid rgba(255,255,255,.08);font-size:11px" onclick="bracketLeaveAsHost('${tournament.id}')">🚪 Leave as Player (stay as host)</button>`;
        }
        if (isHost) {
            actionHTML += `<button style="${btnBase};background:rgba(35,165,90,.15);color:#57f287;border:1px solid rgba(35,165,90,.3);${!canStart?'opacity:.45;cursor:not-allowed':''}" onclick="${canStart?`bracketStart('${tournament.id}')`:''}" ${!canStart?'disabled':''}> ▶ Start Tournament</button>`;
            if (!canStart) actionHTML += `<div style="font-size:11px;color:var(--text-3);text-align:center;margin-top:-4px;margin-bottom:6px">Need at least 2 players</div>`;
            actionHTML += `<button style="${btnBase};background:rgba(237,66,69,.1);color:var(--danger);border:1px solid rgba(237,66,69,.25);margin-top:4px" onclick="bracketDelete('${tournament.id}')">🗑 Delete Tournament</button>`;
        }
    }
    if (tournament.status === 'in-progress') {
        if (isHost) {
            actionHTML += `<button style="${btnBase};background:rgba(237,66,69,.12);color:var(--danger);border:1px solid rgba(237,66,69,.3)" onclick="bracketEnd('${tournament.id}')">⏹ End Tournament</button>`;
            actionHTML += `<button style="${btnBase};background:rgba(88,101,242,.12);color:#7289da;border:1px solid rgba(88,101,242,.3)" onclick="bracketOpenScoring('${tournament.id}')">⚙ Edit Scores / Advance</button>`;
            actionHTML += `<button style="${btnBase};background:rgba(237,66,69,.1);color:var(--danger);border:1px solid rgba(237,66,69,.25)" onclick="bracketDelete('${tournament.id}')">🗑 Delete Tournament</button>`;
        }
    }
    if (tournament.status === 'completed') {
        actionHTML += `<div style="text-align:center;font-size:12px;color:var(--text-3);padding:6px 0">🏆 Tournament Complete</div>`;
        if (isHost) {
            actionHTML += `<button style="${btnBase};background:rgba(237,66,69,.1);color:var(--danger);border:1px solid rgba(237,66,69,.25);margin-top:4px" onclick="bracketDelete('${tournament.id}')">🗑 Delete Tournament</button>`;
        }
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
                  <div style="grid-column:1/-1;background:rgba(88,101,242,.08);border:1px solid rgba(88,101,242,.15);border-radius:6px;padding:7px 9px;display:flex;align-items:center;justify-content:space-between"><div style="font-size:8px;color:var(--text-3);text-transform:uppercase;font-weight:700">Results</div><div style="font-size:10px;font-weight:800;color:${
                    tournament.resultMode==='self-report' ? '#57f287'
                    : tournament.resultMode==='riot-api'  ? '#e57373'
                    : tournament.resultMode==='chess-api' ? 'var(--yellow)'
                    : tournament.resultMode==='automatic' ? 'var(--accent)'
                    : 'var(--text-2)'
                  }">${
                    tournament.resultMode==='self-report' ? '🤝 Self-report'
                    : tournament.resultMode==='riot-api'  ? `⚔️ Riot API${tournament.apiGame ? ' · ' + tournament.apiGame.toUpperCase() : ''}`
                    : tournament.resultMode==='chess-api' ? `♟️ ${tournament.apiGame === 'lichess' ? 'Lichess' : 'Chess.com'}`
                    : tournament.resultMode==='automatic' ? `⚡ Auto${tournament.apiGame ? ' · ' + tournament.apiGame : ''}`
                    : '🖊️ Manual'
                  }</div></div>
                </div>
              </div>
              <!-- Actions -->
              ${actionHTML ? `<div style="padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.06)">${actionHTML}</div>` : ''}
              <!-- Host -->
              <div style="padding:10px 14px;border-bottom:1px solid rgba(255,255,255,.06)">
                <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:6px">Host</div>
                ${hostCard}
              </div>
              <!-- Players -->
              <div style="padding:10px 14px;flex:1">
                <div style="font-size:8px;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--text-3);margin-bottom:6px">Players (${activePlayers.length + eliminatedPlayers.length})</div>
                <div style="display:flex;flex-direction:column;gap:5px">${playerHTML}</div>
              </div>
            </div>
            <!-- Bracket area -->
            <div style="flex:1;display:flex;flex-direction:column;overflow:hidden;min-width:0">
              <div style="padding:10px 18px;background:var(--bg-1);border-bottom:1px solid rgba(255,255,255,.06);display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
                <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.6px;color:var(--text-3)">
                  ${window._bracketScoringMode && isHost ? '<span style="color:#7289da">⚙ Editing Scores</span>' : 'Tournament Bracket'}
                </span>
                ${window._bracketScoringMode && isHost ? `<button onclick="window._bracketScoringMode=false;openTournamentDetails('${tournament.id}')" style="font-size:11px;padding:5px 12px;background:rgba(88,101,242,.2);color:#7289da;border:1px solid rgba(88,101,242,.4);border-radius:6px;cursor:pointer;font-family:inherit;font-weight:700">↺ Refresh Bracket</button>` : ''}
              </div>
              <div style="flex:1;overflow:hidden;position:relative;background:var(--bg-0,var(--bg-2))" id="bracketViewport">
                <div id="bracketCanvas" style="position:absolute;top:0;left:0;transform-origin:0 0;will-change:transform;padding:28px 32px;cursor:grab;${bgStyle}">
                  ${bracketInner}
                </div>
                <!-- Zoom controls -->
                <div style="position:absolute;bottom:14px;right:14px;display:flex;flex-direction:column;gap:4px;z-index:10">
                  <button onclick="bracketZoom(0.15)" style="width:28px;height:28px;background:var(--bg-2);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--text-1);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1" title="Zoom in">+</button>
                  <button onclick="bracketZoom(-0.15)" style="width:28px;height:28px;background:var(--bg-2);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--text-1);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1" title="Zoom out">−</button>
                  <button onclick="bracketResetView()" style="width:28px;height:28px;background:var(--bg-2);border:1px solid rgba(255,255,255,.12);border-radius:6px;color:var(--text-2);font-size:9px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-weight:700" title="Reset view">FIT</button>
                </div>
                <div style="position:absolute;bottom:14px;left:14px;font-size:9px;color:var(--text-3);pointer-events:none">Drag to pan · Ctrl+scroll to zoom</div>
              </div>
            </div>
          </div>`;
        // Init pan/zoom after DOM is ready
        setTimeout(_initBracketPanZoom, 0);
    }
}

// ── Bracket pan/zoom ──────────────────────────────────────────
let _bpz = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 };

function _bracketApplyTransform() {
    const canvas = document.getElementById('bracketCanvas');
    if (canvas) canvas.style.transform = `translate(${_bpz.x}px,${_bpz.y}px) scale(${_bpz.scale})`;
}

function bracketZoom(delta, cx, cy) {
    const vp = document.getElementById('bracketViewport');
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    const ox = cx !== undefined ? cx - rect.left : rect.width / 2;
    const oy = cy !== undefined ? cy - rect.top  : rect.height / 2;
    const newScale = Math.max(0.3, Math.min(2.5, _bpz.scale + delta));
    const factor = newScale / _bpz.scale;
    _bpz.x = ox - factor * (ox - _bpz.x);
    _bpz.y = oy - factor * (oy - _bpz.y);
    _bpz.scale = newScale;
    _bracketApplyTransform();
}

function bracketResetView() {
    const vp = document.getElementById('bracketViewport');
    const canvas = document.getElementById('bracketCanvas');
    if (!vp || !canvas) return;
    const scale = Math.min(1, Math.min(vp.clientWidth / canvas.scrollWidth, vp.clientHeight / canvas.scrollHeight) * 0.9);
    _bpz.scale = scale;
    _bpz.x = (vp.clientWidth  - canvas.scrollWidth  * scale) / 2;
    _bpz.y = (vp.clientHeight - canvas.scrollHeight * scale) / 2;
    _bracketApplyTransform();
}

function _initBracketPanZoom() {
    const vp = document.getElementById('bracketViewport');
    const canvas = document.getElementById('bracketCanvas');
    if (!vp || !canvas) return;
    _bpz = { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 };
    setTimeout(bracketResetView, 30);

    vp.addEventListener('mousedown', e => {
        if (e.target.closest('button') || e.target.closest('input')) return;
        _bpz.dragging = true;
        _bpz.startX = e.clientX - _bpz.x;
        _bpz.startY = e.clientY - _bpz.y;
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
        if (!_bpz.dragging) return;
        _bpz.x = e.clientX - _bpz.startX;
        _bpz.y = e.clientY - _bpz.startY;
        _bracketApplyTransform();
    });
    window.addEventListener('mouseup', () => {
        if (_bpz.dragging) { _bpz.dragging = false; const c = document.getElementById('bracketCanvas'); if (c) c.style.cursor = 'grab'; }
    });

    vp.addEventListener('wheel', e => {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault();
            bracketZoom(e.deltaY > 0 ? -0.1 : 0.1, e.clientX, e.clientY);
        } else {
            e.preventDefault();
            _bpz.x -= e.deltaX; _bpz.y -= e.deltaY;
            _bracketApplyTransform();
        }
    }, { passive: false });
}

window.bracketZoom      = bracketZoom;
window.bracketResetView = bracketResetView;

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

async function bracketDelete(tournamentId) {
    if (!confirm('Delete this tournament permanently? This cannot be undone.')) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to delete');
        showNotification('Tournament deleted', 'success');
        closeBracketPanel();
        loadTournaments();
    } catch(e) { showNotification(e.message || 'Failed to delete', 'error'); }
}

function bracketOpenScoring(tournamentId) {
    // Refresh bracket with scoring mode enabled
    const tournament = window.activeTournament;
    if (!tournament) return;
    window._bracketScoringMode = true;
    openTournamentDetails(tournamentId);
}

window.bracketDelete      = bracketDelete;
window.bracketOpenScoring = bracketOpenScoring;

// Host leaves as player but stays as host
async function bracketLeaveAsHost(tournamentId) {
    if (!confirm('Leave the bracket as a player? You will still be the host.')) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/leave`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to leave');
        showNotification('Left bracket as player', 'success');
        setTimeout(() => openTournamentDetails(tournamentId), 300);
    } catch(e) { showNotification(e.message || 'Failed to leave', 'error'); }
}
window.bracketLeaveAsHost = bracketLeaveAsHost;

// Host removes a player via right-click context menu
async function bracketRemovePlayer(event, tournamentId, userId, username) {
    event.preventDefault();

    // Remove any existing context menu
    document.getElementById('_bracketCtxMenu')?.remove();

    const menu = document.createElement('div');
    menu.id = '_bracketCtxMenu';
    menu.style.cssText = `position:fixed;left:${event.clientX}px;top:${event.clientY}px;background:var(--bg-2);border:1px solid rgba(255,255,255,.12);border-radius:8px;padding:4px;z-index:99999;min-width:160px;box-shadow:0 8px 24px rgba(0,0,0,.4)`;
    menu.innerHTML = `
        <div style="padding:6px 10px;font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.5px">${username}</div>
        <div onclick="bracketRemovePlayerConfirm('${tournamentId}','${userId}','${username}')" style="padding:8px 12px;font-size:12px;font-weight:600;color:var(--danger);cursor:pointer;border-radius:5px;display:flex;align-items:center;gap:8px" onmouseover="this.style.background='rgba(237,66,69,.12)'" onmouseout="this.style.background=''">
            🗑 Remove from tournament
        </div>`;
    document.body.appendChild(menu);

    // Close on outside click
    setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function bracketRemovePlayerConfirm(tournamentId, userId, username) {
    document.getElementById('_bracketCtxMenu')?.remove();
    if (!confirm(`Remove ${username} from the tournament?`)) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/players/${userId}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to remove player');
        showNotification(`${username} removed from tournament`, 'success');
        setTimeout(() => openTournamentDetails(tournamentId), 300);
    } catch(e) { showNotification(e.message || 'Failed to remove player', 'error'); }
}

window.bracketRemovePlayer        = bracketRemovePlayer;
window.bracketRemovePlayerConfirm = bracketRemovePlayerConfirm;

// Save both scores for a match at once
async function bracketSaveScores(tournamentId, matchId) {
    const s1 = parseInt(document.getElementById(`s_${matchId}_1`)?.value) || 0;
    const s2 = parseInt(document.getElementById(`s_${matchId}_2`)?.value) || 0;
    try {
        const [r1, r2] = await Promise.all([
            fetch(`${API_BASE}/api/tournaments/${tournamentId}/match-score`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` },
                body: JSON.stringify({ matchId, player: 1, score: s1 })
            }),
            fetch(`${API_BASE}/api/tournaments/${tournamentId}/match-score`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` },
                body: JSON.stringify({ matchId, player: 2, score: s2 })
            })
        ]);
        if (!r1.ok || !r2.ok) throw new Error('Failed to save scores');
        showNotification('Scores saved ✓', 'success');
    } catch(e) { showNotification(e.message || 'Failed to save scores', 'error'); }
}

window.bracketSaveScores = bracketSaveScores;

async function bracketAdvance(tournamentId, matchId, winnerUserId) {
    if (!winnerUserId || winnerUserId === 'null' || winnerUserId === 'undefined') {
        showNotification('Cannot advance TBD player', 'error'); return;
    }
    if (!matchId || matchId === 'null') {
        showNotification('This match has no real DB record yet — advance the previous round first', 'error'); return;
    }
    if (!confirm('Advance this player to the next round?')) return;
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/set-winner`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` },
            body: JSON.stringify({ matchId, winnerId: winnerUserId })
        });
        const data = await response.json();
        console.log('[bracketAdvance] status:', response.status, 'data:', JSON.stringify(data));
        if (!response.ok) throw new Error(data.error || 'Failed to advance player');

        if (data.tournamentStatus === 'completed' && data.winner) {
            window._bracketScoringMode = false;
            showWinnerPopup(data.winner, tournamentId);
        } else {
            showNotification('Player advanced ✓', 'success');
            window._bracketScoringMode = true;
            setTimeout(() => openTournamentDetails(tournamentId), 300);
        }
    } catch(e) { showNotification(e.message || 'Failed to advance', 'error'); }
}

function showWinnerPopup(winner, tournamentId) {
    // Remove any existing popup
    document.getElementById('tournamentWinnerPopup')?.remove();

    const card = winner.tournamentCard || {};
    const bgPos = card.bgPos || '50% 50%';
    const cardBg = card.imageUrl
        ? `background-image:url(${card.imageUrl});background-size:cover;background-position:${bgPos};`
        : `background-color:${card.bgColour||'#2c3440'};`;
    const avatarContent = winner.avatarUrl
        ? `<img src="${winner.avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:10px;">`
        : `<span style="font-size:22px;font-weight:800;color:#fff">${(winner.username||'?')[0].toUpperCase()}</span>`;

    const popup = document.createElement('div');
    popup.id = 'tournamentWinnerPopup';
    popup.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(8px);animation:fadeIn .4s ease';
    popup.innerHTML = `
      <div style="text-align:center;max-width:420px;padding:40px 32px;animation:popIn .5s cubic-bezier(.34,1.56,.64,1)">
        <div style="font-size:64px;margin-bottom:16px;animation:spin 1s ease">🏆</div>
        <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:rgba(249,168,212,.7);margin-bottom:8px">Tournament Winner</div>
        <div style="font-size:32px;font-weight:900;color:#fff;margin-bottom:24px;text-shadow:0 0 40px rgba(249,168,212,.6)">${winner.username}</div>

        <!-- Winner's match card (big) -->
        <div style="display:flex;align-items:center;gap:14px;padding:16px 20px;${cardBg}border:2px solid ${card.borderColour||'rgba(249,168,212,.6)'};border-radius:14px;box-shadow:0 8px 40px rgba(249,168,212,.25);margin-bottom:32px;max-width:300px;margin-left:auto;margin-right:auto">
          <div style="width:52px;height:52px;border-radius:12px;flex-shrink:0;overflow:hidden;background:linear-gradient(135deg,var(--accent),var(--accent-h));display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,.4)">${avatarContent}</div>
          <div>
            <div style="font-size:16px;font-weight:800;color:${card.nameColour||'#fff'};text-shadow:0 1px 4px rgba(0,0,0,.6)">${winner.username}</div>
            <div style="font-size:12px;color:rgba(255,255,255,.6);margin-top:2px">🥇 Champion</div>
          </div>
        </div>

        <div style="display:flex;gap:12px;justify-content:center">
          <button onclick="document.getElementById('tournamentWinnerPopup').remove();loadTournaments();" style="padding:12px 28px;background:var(--accent);color:#1a0a10;border:none;border-radius:10px;font-size:14px;font-weight:800;cursor:pointer;font-family:inherit">🎉 Celebrate!</button>
          <button onclick="document.getElementById('tournamentWinnerPopup').remove();window._bracketScoringMode=false;openTournamentDetails('${tournamentId}');" style="padding:12px 28px;background:var(--bg-3);color:var(--text-2);border:1px solid rgba(255,255,255,.1);border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit">View Bracket</button>
        </div>
      </div>`;

    // Add animations
    if (!document.getElementById('winnerPopupStyles')) {
        const style = document.createElement('style');
        style.id = 'winnerPopupStyles';
        style.textContent = `
          @keyframes fadeIn { from { opacity:0 } to { opacity:1 } }
          @keyframes popIn  { from { transform:scale(.5);opacity:0 } to { transform:scale(1);opacity:1 } }
          @keyframes spin   { 0%{transform:rotate(-20deg) scale(.8)} 50%{transform:rotate(10deg) scale(1.2)} 100%{transform:rotate(0deg) scale(1)} }
        `;
        document.head.appendChild(style);
    }

    document.body.appendChild(popup);
    // Close on backdrop click
    popup.addEventListener('click', e => { if (e.target === popup) popup.remove(); });
}

window.bracketSaveScores = bracketSaveScores;
window.bracketAdvance   = bracketAdvance;
window.showWinnerPopup  = showWinnerPopup;


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
        if (ws) {
            wsSend('match-result', {
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
        if (ws) {
            wsSend('tournament-closed', { tournamentId });
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
        if (ws) {
            wsSend('tournament-deleted', { tournamentId });
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
// ── Lock-in ───────────────────────────────────────────────────
async function bracketLockIn(tournamentId, matchId) {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/lock-in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` },
            body: JSON.stringify({ matchId })
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || 'Failed to lock in');

        const btn = document.getElementById(`lockInBtn_${matchId}`);
        if (btn) {
            btn.textContent = '✅ Locked';
            btn.style.background = 'rgba(35,165,90,.25)';
            btn.style.color = '#57f287';
            btn.style.borderColor = 'rgba(35,165,90,.4)';
            btn.disabled = true;
        }

        if (data.bothLocked) {
            showNotification('🔒 Both players locked in — match is ready!', 'success');
        } else {
            showNotification('🔒 Locked in — waiting for opponent', 'success');
        }

        // Broadcast lock-in state change so all viewers update their bracket
        if (ws) {
            wsSend('tournament-lock-in', {
                tournamentId,
                matchId,
                userId: currentUserId,
                bothLocked: data.bothLocked
            });
        }

        // Also notify opponent to lock in
        if (ws) {
            wsSend('tournament-notify', {
                tournamentId,
                notifType: 'lock-in-request',
                text: `Your opponent has locked in for their match in <b>${window.activeTournament?.name || 'the tournament'}</b>. Lock in to begin!`,
                matchId
            });
        }
    } catch(e) { showNotification(e.message || 'Failed to lock in', 'error'); }
}

window.bracketLockIn = bracketLockIn;

// ── API Mode: Check Result (Riot / Chess.com / Lichess) ───────
async function bracketApiPoll(tournamentId, matchId) {
    const btn = event?.target;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Checking…'; }
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/api-poll`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('vh_token')}` },
            body: JSON.stringify({ matchId })
        });
        const data = await response.json();

        if (data.status === 'found' && data.autoAdvanced) {
            showNotification('✅ Result found — winner auto-advanced!', 'success');
            if (ws) wsSend('tournament-result', { tournamentId, matchId, status: 'agreed', gameUrl: data.gameUrl || null });
            setTimeout(() => openTournamentDetails(tournamentId), 500);
        } else if (data.status === 'already_completed') {
            showNotification('This match is already completed', 'success');
            setTimeout(() => openTournamentDetails(tournamentId), 300);
        } else if (data.status === 'not_found') {
            showNotification(`⏳ No result found yet${data.reason ? ' — ' + data.reason : '. Play your match and check again.'}`, 'error');
            if (btn) { btn.disabled = false; btn.textContent = '🔍 Check Result'; }
        } else {
            showNotification(data.error || 'Failed to check result', 'error');
            if (btn) { btn.disabled = false; btn.textContent = '🔍 Check Result'; }
        }
    } catch(e) {
        showNotification(e.message || 'Failed to check result', 'error');
        if (btn) { btn.disabled = false; btn.textContent = '🔍 Check Result'; }
    }
}
window.bracketApiPoll = bracketApiPoll;

// ── Watch Live: toggle Lichess board embed under a match card ──
function toggleLiveBoard(matchId, gameUrl) {
    const el = document.getElementById(`liveBoard_${matchId}`);
    if (!el) return;
    const isOpen = el.style.display !== 'none';
    if (isOpen) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    // Lichess embed — dark theme, no ad, no chat
    const embedUrl = gameUrl.replace('lichess.org/', 'lichess.org/embed/game/') + '?theme=brown&bg=dark';
    el.style.display = 'block';
    el.innerHTML = `
        <div style="background:var(--bg-1);border:1px solid rgba(35,165,90,.3);border-radius:8px;overflow:hidden;margin-top:4px">
            <div style="display:flex;align-items:center;justify-content:space-between;padding:5px 10px;background:rgba(35,165,90,.08);border-bottom:1px solid rgba(35,165,90,.15)">
                <span style="font-size:9px;font-weight:700;color:#57f287;text-transform:uppercase;letter-spacing:.6px">📺 Live Game</span>
                <div style="display:flex;gap:6px">
                    <a href="${gameUrl}" target="_blank" style="font-size:9px;color:var(--text-3);text-decoration:none;font-weight:600">Open ↗</a>
                    <button onclick="toggleLiveBoard('${matchId}','${gameUrl}')" style="background:none;border:none;color:var(--text-3);cursor:pointer;font-size:11px;padding:0;line-height:1">✕</button>
                </div>
            </div>
            <iframe src="${embedUrl}"
                style="width:100%;height:240px;border:none;display:block"
                allowtransparency="true">
            </iframe>
        </div>`;
}
window.toggleLiveBoard = toggleLiveBoard;

// ── Self-Report: Report Result Modal ─────────────────────────
function showReportModal(tournamentId, matchId, p1name, p2name, p1uid, p2uid) {
    document.getElementById('_reportModal')?.remove();

    const iAmP1 = String(p1uid) === String(currentUserId);
    const myName = iAmP1 ? p1name : p2name;
    const oppName = iAmP1 ? p2name : p1name;

    const overlay = document.createElement('div');
    overlay.id = '_reportModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99998;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
    overlay.innerHTML = `
      <div style="background:var(--bg-1);border:1.5px solid rgba(255,255,255,.12);border-radius:16px;padding:24px;width:min(400px,90vw);font-family:inherit">
        <div style="font-size:16px;font-weight:800;color:var(--text-1);margin-bottom:4px">📊 Report Match Result</div>
        <div style="font-size:12px;color:var(--text-3);margin-bottom:20px">${myName} vs ${oppName}</div>

        <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:12px;align-items:center;margin-bottom:20px">
          <div style="text-align:center">
            <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">You (${myName})</div>
            <input id="_myScore" type="number" min="0" max="99" value="0" style="width:100%;text-align:center;font-size:28px;font-weight:800;background:var(--bg-3);border:1.5px solid rgba(255,255,255,.15);border-radius:10px;color:var(--text-1);padding:10px;outline:none;font-family:inherit" onfocus="this.style.borderColor='rgba(88,101,242,.6)'" onblur="this.style.borderColor='rgba(255,255,255,.15)'" />
          </div>
          <div style="font-size:18px;font-weight:800;color:var(--text-3);padding-top:22px">—</div>
          <div style="text-align:center">
            <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Opponent (${oppName})</div>
            <input id="_oppScore" type="number" min="0" max="99" value="0" style="width:100%;text-align:center;font-size:28px;font-weight:800;background:var(--bg-3);border:1.5px solid rgba(255,255,255,.15);border-radius:10px;color:var(--text-1);padding:10px;outline:none;font-family:inherit" onfocus="this.style.borderColor='rgba(88,101,242,.6)'" onblur="this.style.borderColor='rgba(255,255,255,.15)'" />
          </div>
        </div>

        <div style="margin-bottom:16px">
          <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:700;text-transform:uppercase;letter-spacing:.4px">Screenshot proof (optional but recommended)</div>
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-3);border:1.5px dashed rgba(255,255,255,.15);border-radius:8px;cursor:pointer" onmouseover="this.style.borderColor='rgba(88,101,242,.5)'" onmouseout="this.style.borderColor='rgba(255,255,255,.15)'">
            <span style="font-size:16px">🖼</span>
            <span id="_screenshotLabel" style="font-size:12px;color:var(--text-3)">Click to attach screenshot</span>
            <input type="file" accept="image/*" id="_screenshotInput" style="display:none" onchange="handleReportScreenshot(this)">
          </label>
          <div id="_screenshotPreview" style="margin-top:8px;display:none"><img style="width:100%;border-radius:6px;max-height:120px;object-fit:cover" id="_screenshotImg"></div>
        </div>

        <div style="display:flex;gap:8px">
          <button onclick="submitMatchReport('${tournamentId}','${matchId}','${iAmP1}')" style="flex:1;padding:11px;background:var(--accent);color:#1a0a10;border:none;border-radius:8px;font-size:13px;font-weight:800;cursor:pointer;font-family:inherit">Submit Result</button>
          <button onclick="document.getElementById('_reportModal').remove()" style="padding:11px 16px;background:var(--bg-3);color:var(--text-2);border:1px solid rgba(255,255,255,.1);border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;font-family:inherit">Cancel</button>
        </div>
      </div>`;

    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
    document.getElementById('_myScore')?.focus();
}
window.showReportModal = showReportModal;

let _reportScreenshotUrl = null;

function handleReportScreenshot(input) {
    const file = input.files[0];
    if (!file) return;
    const label = document.getElementById('_screenshotLabel');
    const preview = document.getElementById('_screenshotPreview');
    const img = document.getElementById('_screenshotImg');
    if (label) label.textContent = '⏳ Uploading…';

    const fd = new FormData();
    fd.append('image', file);
    fetch(`${AUTH_BASE}/tournament-card-image`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('vh_token')}` },
        body: fd
    }).then(r => r.json()).then(data => {
        if (data.imageUrl) {
            _reportScreenshotUrl = data.imageUrl;
            if (label) label.textContent = '✓ Screenshot attached';
            if (img) img.src = data.imageUrl;
            if (preview) preview.style.display = 'block';
        }
    }).catch(() => { if (label) label.textContent = 'Upload failed — you can still submit without it'; });
}
window.handleReportScreenshot = handleReportScreenshot;

async function submitMatchReport(tournamentId, matchId, iAmP1Str) {
    const myScore   = parseInt(document.getElementById('_myScore')?.value)   || 0;
    const oppScore  = parseInt(document.getElementById('_oppScore')?.value)  || 0;
    const btn = document.querySelector('#_reportModal button');

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/report-result`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('vh_token')}` },
            body: JSON.stringify({ matchId, myScore, opponentScore: oppScore, screenshotUrl: _reportScreenshotUrl })
        });
        const data = await response.json();
        _reportScreenshotUrl = null;
        document.getElementById('_reportModal')?.remove();

        if (!response.ok) { showNotification(data.error || 'Failed to submit', 'error'); return; }

        if (data.status === 'agreed') {
            showNotification('✅ Both players agreed — advancing winner!', 'success');
            // Notify all via WebSocket
            if (ws) wsSend('tournament-result', {
                tournamentId, matchId, status: 'agreed'
            });
            setTimeout(() => openTournamentDetails(tournamentId), 600);
        } else if (data.status === 'disputed') {
            showNotification('⚠ Scores don\'t match — host has been notified to resolve', 'error');
            if (ws) wsSend('tournament-result', {
                tournamentId, matchId, status: 'disputed'
            });
        } else {
            showNotification('📊 Result submitted — waiting for opponent to confirm', 'success');
            if (ws) wsSend('tournament-result', {
                tournamentId, matchId, status: 'submitted'
            });
        }
    } catch(e) {
        document.getElementById('_reportModal')?.remove();
        showNotification(e.message || 'Failed to submit result', 'error');
    }
}
window.submitMatchReport = submitMatchReport;

// ── Self-Report: Host dispute resolution modal ─────────────────
function showDisputeModal(tournamentId, matchId, p1name, p2name, p1uid, p2uid) {
    document.getElementById('_disputeModal')?.remove();

    // Fetch match data to show both reports
    fetch(`${API_BASE}/api/tournaments/${tournamentId}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('vh_token')}` }
    }).then(r => r.json()).then(t => {
        let match = null;
        t.bracket?.rounds?.forEach(r => r.matches?.forEach(m => { if (String(m.matchId) === String(matchId)) match = m; }));
        const p1r = match?.p1Report || {};
        const p2r = match?.p2Report || {};

        const overlay = document.createElement('div');
        overlay.id = '_disputeModal';
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(4px)';
        overlay.innerHTML = `
          <div style="background:var(--bg-1);border:1.5px solid rgba(237,66,69,.3);border-radius:16px;padding:24px;width:min(480px,92vw);font-family:inherit">
            <div style="font-size:16px;font-weight:800;color:var(--danger);margin-bottom:4px">⚠ Disputed Result</div>
            <div style="font-size:12px;color:var(--text-3);margin-bottom:18px">${p1name} vs ${p2name} — players reported different scores</div>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:18px">
              <div style="background:var(--bg-2);border-radius:10px;padding:12px">
                <div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">${p1name} reported</div>
                <div style="font-size:24px;font-weight:800;color:var(--text-1);margin-bottom:4px">${p1r.myScore ?? '?'} — ${p1r.opponentScore ?? '?'}</div>
                <div style="font-size:11px;color:var(--text-3)">Claims: ${(p1r.myScore ?? 0) > (p1r.opponentScore ?? 0) ? `${p1name} won` : `${p2name} won`}</div>
                ${p1r.screenshotUrl ? `<a href="${p1r.screenshotUrl}" target="_blank" style="display:inline-block;margin-top:6px;font-size:10px;color:var(--accent)">View screenshot</a>` : '<div style="font-size:10px;color:var(--text-3);margin-top:6px">No screenshot</div>'}
              </div>
              <div style="background:var(--bg-2);border-radius:10px;padding:12px">
                <div style="font-size:10px;font-weight:700;color:var(--text-3);text-transform:uppercase;letter-spacing:.4px;margin-bottom:8px">${p2name} reported</div>
                <div style="font-size:24px;font-weight:800;color:var(--text-1);margin-bottom:4px">${p2r.myScore ?? '?'} — ${p2r.opponentScore ?? '?'}</div>
                <div style="font-size:11px;color:var(--text-3)">Claims: ${(p2r.myScore ?? 0) > (p2r.opponentScore ?? 0) ? `${p2name} won` : `${p1name} won`}</div>
                ${p2r.screenshotUrl ? `<a href="${p2r.screenshotUrl}" target="_blank" style="display:inline-block;margin-top:6px;font-size:10px;color:var(--accent)">View screenshot</a>` : '<div style="font-size:10px;color:var(--text-3);margin-top:6px">No screenshot</div>'}
              </div>
            </div>

            <div style="font-size:12px;font-weight:700;color:var(--text-2);margin-bottom:10px">Decide the correct result:</div>
            <div style="display:grid;grid-template-columns:1fr auto 1fr;gap:8px;align-items:center;margin-bottom:16px">
              <input id="_dp1score" type="number" min="0" max="99" value="${p1r.myScore ?? 0}" placeholder="P1 score" style="text-align:center;font-size:18px;font-weight:700;background:var(--bg-3);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:var(--text-1);padding:8px;outline:none;font-family:inherit">
              <div style="font-size:14px;color:var(--text-3);font-weight:700">—</div>
              <input id="_dp2score" type="number" min="0" max="99" value="${p1r.opponentScore ?? 0}" placeholder="P2 score" style="text-align:center;font-size:18px;font-weight:700;background:var(--bg-3);border:1px solid rgba(255,255,255,.15);border-radius:8px;color:var(--text-1);padding:8px;outline:none;font-family:inherit">
            </div>

            <div style="display:flex;gap:8px;margin-bottom:10px">
              <button onclick="resolveDispute('${tournamentId}','${matchId}','${p1uid}',true)" style="flex:1;padding:10px;background:rgba(35,165,90,.15);color:#57f287;border:1px solid rgba(35,165,90,.3);border-radius:8px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">${p1name} wins</button>
              <button onclick="resolveDispute('${tournamentId}','${matchId}','${p2uid}',false)" style="flex:1;padding:10px;background:rgba(35,165,90,.15);color:#57f287;border:1px solid rgba(35,165,90,.3);border-radius:8px;font-size:12px;font-weight:800;cursor:pointer;font-family:inherit">${p2name} wins</button>
            </div>
            <button onclick="document.getElementById('_disputeModal').remove()" style="width:100%;padding:10px;background:var(--bg-3);color:var(--text-2);border:1px solid rgba(255,255,255,.1);border-radius:8px;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit">Close — decide later</button>
          </div>`;

        overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
        document.body.appendChild(overlay);
    }).catch(() => showNotification('Failed to load match data', 'error'));
}
window.showDisputeModal = showDisputeModal;

async function resolveDispute(tournamentId, matchId, winnerUid, winnerIsP1) {
    const p1score = parseInt(document.getElementById('_dp1score')?.value) || 0;
    const p2score = parseInt(document.getElementById('_dp2score')?.value) || 0;
    document.getElementById('_disputeModal')?.remove();
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/${tournamentId}/resolve-dispute`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('vh_token')}` },
            body: JSON.stringify({ matchId, winnerId: winnerUid, p1Score: p1score, p2Score: p2score })
        });
        const data = await response.json();
        if (!response.ok) { showNotification(data.error || 'Failed to resolve', 'error'); return; }
        showNotification('✅ Dispute resolved — bracket updated', 'success');
        if (ws) wsSend('tournament-result', { tournamentId, matchId, status: 'resolved' });
        setTimeout(() => openTournamentDetails(tournamentId), 400);
    } catch(e) { showNotification(e.message || 'Failed to resolve dispute', 'error'); }
}
window.resolveDispute = resolveDispute;

window.bracketSetScore = bracketSaveScores;

// ── Tournament schedule countdown ─────────────────────────────
// Polls scheduled tournaments and fires alerts at the right time
let _scheduleCheckInterval = null;

function startScheduleChecker() {
    if (_scheduleCheckInterval) clearInterval(_scheduleCheckInterval);
    _scheduleCheckInterval = setInterval(_checkScheduledTournaments, 60 * 1000); // every minute
    _checkScheduledTournaments(); // run immediately
}

async function _checkScheduledTournaments() {
    try {
        const response = await fetch(`${API_BASE}/api/tournaments/scheduled/upcoming`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('vh_token')}` }
        });
        if (!response.ok) return;
        const tournaments = await response.json();
        const now = Date.now();

        tournaments.forEach(t => {
            const startMs = new Date(t.scheduled_start).getTime();
            const alertMs = (t.alert_before_minutes || 15) * 60 * 1000;
            const alertAt = startMs - alertMs;
            const msUntilAlert = alertAt - now;
            const msUntilStart = startMs - now;

            // Fire alert notification if within this minute's window
            if (msUntilAlert >= 0 && msUntilAlert < 65000) {
                const mins = Math.round(msUntilStart / 60000);
                _fireTournamentAlert(t, mins);
            }
            // Fire start notification
            if (msUntilStart >= 0 && msUntilStart < 65000) {
                _fireTournamentAlert(t, 0);
            }
        });

        // Update countdown displays in sidebar
        _updateCountdownDisplays(tournaments);
    } catch(e) { /* silent */ }
}

function _fireTournamentAlert(t, minsUntil) {
    const isStart = minsUntil === 0;
    const text = isStart
        ? `🏆 <b>${t.name}</b> is starting now! Head to the bracket.`
        : `⏰ <b>${t.name}</b> starts in <b>${minsUntil} minute${minsUntil !== 1 ? 's' : ''}</b>. Get ready!`;

    // Push to notification panel
    if (typeof pushNotif === 'function') {
        pushNotif({ type: 'tournament', icon: '🏆', text,
            actions: [{ label: 'View', action: `openTournamentDetails:${t.id}`, style: 'primary' }]
        });
    }

    // Shake the bell
    shakeBell();

    // Notify registered players via WebSocket
    if (ws && t.player_user_ids?.length) {
        wsSend('tournament-notify', {
            tournamentId: t.id,
            tournamentName: t.name,
            notifType: isStart ? 'round-start' : 'schedule-alert',
            text,
            userIds: t.player_user_ids,
            minutesUntil: minsUntil
        });
    }
}

function _updateCountdownDisplays(tournaments) {
    // Update any countdown badges in the sidebar tournament cards
    const now = Date.now();
    tournaments.forEach(t => {
        const el = document.getElementById(`countdown_${t.id}`);
        if (!el || !t.scheduled_start) return;
        const ms = new Date(t.scheduled_start).getTime() - now;
        if (ms <= 0) { el.textContent = 'Starting now'; return; }
        const h = Math.floor(ms / 3600000);
        const m = Math.floor((ms % 3600000) / 60000);
        el.textContent = h > 0 ? `in ${h}h ${m}m` : `in ${m}m`;
    });
}

// ── Bell shake ────────────────────────────────────────────────
function shakeBell() {
    const bell = document.getElementById('notifNavIcon');
    if (!bell) return;
    bell.classList.remove('bell-shake');
    void bell.offsetWidth; // reflow to restart animation
    bell.classList.add('bell-shake');
    setTimeout(() => bell.classList.remove('bell-shake'), 800);
}
window.shakeBell = shakeBell;

// ── WebSocket send helper ─────────────────────────────────────
function wsSend(type, payload) {
    if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type, ...payload }));
    }
}
window.wsSend = wsSend;

// ── WebSocket: incoming tournament message handler ─────────────
// Hooks into the existing ws.onmessage by registering a sub-handler
// stored on window so index.html's onmessage dispatcher can call it
function _handleTournamentWsMsg(msg) {
    const data = msg;

    if (data.type === 'tournament-notify') {
        if (data.notifType === 'lock-in-request') {
            if (typeof pushNotif === 'function') {
                pushNotif({ type: 'tournament', icon: '🔒', text: data.text,
                    actions: data.matchId ? [{ label: 'Lock In', action: `lockIn:${data.tournamentId}:${data.matchId}`, style: 'primary' }] : []
                });
            }
            shakeBell();
        } else if (data.notifType === 'schedule-alert' || data.notifType === 'round-start') {
            if (typeof pushNotif === 'function') {
                pushNotif({ type: 'tournament', icon: '🏆', text: data.text,
                    actions: [{ label: 'View Bracket', action: `openTournamentDetails:${data.tournamentId}`, style: 'primary' }]
                });
            }
            shakeBell();
        }
        return;
    }

    if (data.type === 'tournament-lock-in') {
        if (!window.bracketPanelActive || window.activeTournament?.id != data.tournamentId) return;

        // Update cached match state
        const t = window.activeTournament;
        if (t?.bracket?.rounds) {
            t.bracket.rounds.forEach(round => {
                (round.matches || []).forEach(match => {
                    if (match.matchId == data.matchId) {
                        if (!match.lockedPlayers) match.lockedPlayers = [];
                        const uid = String(data.userId);
                        if (!match.lockedPlayers.map(String).includes(uid)) match.lockedPlayers.push(data.userId);
                        if (data.bothLocked) match.roundLocked = true;
                    }
                });
            });
        }

        // Update pills directly in the DOM — no full re-render
        const mid = String(data.matchId);
        const uid = String(data.userId);
        document.querySelectorAll(`[data-lock-match="${mid}"]`).forEach(pill => {
            if (String(pill.dataset.lockUser) === uid) {
                pill.innerHTML = `<span style="font-size:10px;line-height:1">✔</span><span style="font-size:8px;font-weight:700;color:#57f287;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0">${pill.dataset.lockName||''}</span>`;
                pill.style.background = 'rgba(35,165,90,.12)';
                pill.style.borderColor = 'rgba(35,165,90,.3)';
            }
        });
        // Hide lock button for the person who just locked
        const lockBtn = document.querySelector(`[data-lock-btn="${mid}"]`);
        if (lockBtn && uid === String(currentUserId)) lockBtn.style.display = 'none';
        // Show ready badge if both locked
        if (data.bothLocked) {
            const badge = document.querySelector(`[data-lock-ready="${mid}"]`);
            if (badge) badge.style.display = 'inline-flex';
            // Also show Report/Check button if self-report or API mode — just refresh
            if (window.activeTournament?.resultMode === 'self-report' ||
                window.activeTournament?.resultMode === 'riot-api' ||
                window.activeTournament?.resultMode === 'chess-api') {
                setTimeout(() => openTournamentDetails(data.tournamentId), 200);
            }
        }
        return;
    }

    if (data.type === 'tournament-result') {
        if (data.status === 'agreed' || data.status === 'resolved' || data.status === 'api-resolved') {
            // If a game_url came through, cache it on the match before refreshing
            if (data.gameUrl && window.activeTournament?.bracket?.rounds) {
                window.activeTournament.bracket.rounds.forEach(round => {
                    (round.matches || []).forEach(match => {
                        if (String(match.matchId) === String(data.matchId)) {
                            match.gameUrl = data.gameUrl;
                        }
                    });
                });
            }
            if (window.bracketPanelActive && window.activeTournament?.id == data.tournamentId) {
                setTimeout(() => openTournamentDetails(data.tournamentId), 300);
            }
            loadTournaments();
        } else if (data.status === 'disputed') {
            if (String(window.activeTournament?.hostId) === String(currentUserId)) {
                if (typeof pushNotif === 'function') {
                    pushNotif({ type: 'tournament', icon: '⚠', text: `<b>Score dispute</b> in <b>${window.activeTournament?.name || 'a tournament'}</b> — players reported different results.`,
                        actions: [{ label: 'Resolve', action: `openTournamentDetails:${data.tournamentId}`, style: 'primary' }]
                    });
                }
                shakeBell();
            }
            if (window.bracketPanelActive && window.activeTournament?.id == data.tournamentId) {
                setTimeout(() => openTournamentDetails(data.tournamentId), 300);
            }
        } else if (data.status === 'submitted') {
            if (window.bracketPanelActive && window.activeTournament?.id == data.tournamentId) {
                setTimeout(() => openTournamentDetails(data.tournamentId), 300);
            }
        }
        return;
    }

    if (['tournament-update','bracket-generated','match-completed','tournament-closed'].includes(data.type)) {
        loadTournaments();
        return;
    }
}

// Register the handler on window so index.html's ws.onmessage can call it
window._handleTournamentWsMsg = _handleTournamentWsMsg;

function registerTournamentSocketHandlers() {
    // Nothing to do — handler is registered via window._handleTournamentWsMsg
    // which index.html's ws.onmessage calls for every message
}
window.registerTournamentSocketHandlers = registerTournamentSocketHandlers;

// Start the schedule checker when tournaments are initialised
// (called from initTournaments)

// Export functions
window.initTournaments = initTournaments;
window.registerTournamentSocketHandlers = registerTournamentSocketHandlers;
window.openTournamentModal = openTournamentModal;
window.closeTournamentModal = closeTournamentModal;
window.openTournamentDetails = openTournamentDetails;
window.generateBracket = generateBracket;
window.registerForTournament = registerForTournament;
window.setWinner = setWinner;
window.closeTournament = closeTournament;
window.showNotification = showNotification;
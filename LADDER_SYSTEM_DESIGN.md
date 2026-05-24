# LOBBY Ladder System — Design Doc

**Version:** 1.0 (Phase 1)
**Status:** Design + Schema + Engine ready for review
**Author:** Drafted with Connor, May 2026
**Implements:** Global ladder, per-game ladders, seasonal ladders, anti-abuse, admin featuring

---

## 1. Goals & Non-Goals

### Goals
- A ranking system that rewards **participation + legitimacy + competition quality**, not raw grinding.
- A public-facing **Seasonal RP** number that resets each season for hype, backed by a hidden Elo/MMR for accuracy.
- **Per-game ladders** that emerge automatically from whatever games hosts run tournaments in — no curation gates.
- A **unified Global ladder** aggregating cross-game performance for top-of-Lobby prestige.
- **Automatic tournament tier classification** based on objective signals (size, host trust, opponent strength, match credibility).
- **Admin-controlled featuring** that lets you (and only you) hand-promote tournaments to Featured status with custom RP rewards.
- **Recommended skill level** on tournaments, with hosts **rank-gated** to creating tournaments at or below their own per-game rank.
- **Host rank visibility** on every tournament card / bracket header so smurfs can't hide.
- **Full anti-abuse:** match confirmation, diminishing returns on repeat opponents, smurf detection, host cooldowns.

### Non-Goals (this phase)
- Matchmaking / queueing (Elo exists but isn't used for auto-matching yet).
- Cross-server / regional leaderboards (data structure supports it; surfaces come later).
- Tournament organizer-specific leaderboard (data exists; UI deferred).
- Cash/prize-pool integration with RP.

---

## 2. System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│  TOURNAMENT COMPLETES (advanceWinner sets status='completed')        │
└──────────────────────────┬───────────────────────────────────────────┘
                           │
                           ▼
         ┌─────────────────────────────────────────┐
         │  rating-engine.applyTournamentResults() │
         └─────────────────────────────────────────┘
                           │
       ┌───────────────────┼───────────────────────┐
       ▼                   ▼                       ▼
 [credibility]      [winner RP]              [Elo updates]
   from size,       base from               per match in
   host trust,      credibility +           bracket (chess-style
   confirm rate,    distribution            K-factor)
   public flag      curve, OR admin
                    override
                           │
                           ▼
   ┌────────────────────────────────────────┐
   │  diminishing-returns + smurf-flag pass │
   └────────────────────────────────────────┘
                           │
                           ▼
   ┌────────────────────────────────────────┐
   │  write rp_transactions + update        │
   │  user_ratings + season_ratings         │
   └────────────────────────────────────────┘
```

The rating engine is a single backend module (`backend/rating-engine.js`) that hooks into the existing tournament completion flow. Everything below the engine is pure data writes.

---

## 3. Rating Model: Hybrid Elo + Seasonal RP

Two numbers track every player **per game** (and a derived Global aggregate):

| Number | Visibility | Purpose | Lifetime |
|---|---|---|---|
| **Seasonal RP** | Public | What players chase. Tier badge derives from this. | Compressed at season end. |
| **Elo / MMR** | Hidden (until we ship matchmaking) | True skill estimate. Drives opponent-strength multipliers. | Persistent across seasons. |

### 3.1 Elo

Standard chess-style Elo, computed per individual match in a tournament bracket:

```
expected_a = 1 / (1 + 10^((rating_b - rating_a) / 400))
rating_a_new = rating_a + K * (score_a - expected_a)
```

- K-factor: 32 for players with <30 ranked matches (provisional), 24 for 30–100, 16 for 100+.
- Elo is **per game**. Global Elo isn't tracked directly; Global ladder uses aggregated RP.
- New players start at Elo 1200.
- Elo updates happen per match, so a player gains/loses Elo even mid-tournament.

### 3.2 Seasonal RP

RP moves at **tournament completion**, not per match. Rationale: makes the moment of awarding feel earned, and lets the engine apply credibility/anti-abuse multipliers to the whole event at once.

A player's RP change from a tournament is:

```
rp_delta = winner_rp_base * placement_share * opponent_strength_mult
                          * confirmation_mult * diminishing_returns_mult
                          * placement_match_mult * smurf_penalty
```

We unpack each factor below.

---

## 4. Tournament Credibility & Auto-Tier

Every completed tournament gets a **credibility score** between 0.0 and 1.0, computed from four factors. The score determines (a) which auto-tier the tournament falls into and (b) the base RP awarded to the winner.

### 4.1 Inputs

| Factor | Range | How it's measured |
|---|---|---|
| `size_factor` | 0.0–1.0 | Bracket size: 4=0.25, 8=0.4, 16=0.6, 32=0.8, 64=0.95, 128=1.0. |
| `field_strength` | 0.0–1.0 | `clamp((avg_player_elo - 1200) / 600, 0, 1)`. A field of 1200-Elo players scores 0.0; a field of 1800+ scores 1.0. |
| `host_trust` | 0.0–1.0 | Computed from host's tournament history (§7). New hosts start at 0.2. Lobby Verified hosts floor at 0.7. |
| `match_credibility` | 0.0–1.0 | `0.5 * confirm_rate + 0.3 * public_bracket + 0.2 * format_rigor`. See §4.2. |

### 4.2 Match credibility components

- **confirm_rate**: fraction of completed matches in the bracket where both `p1_report` and `p2_report` agreed (or were resolved without dispute). Self-report tournaments naturally hit high confirm_rates; manual-mode tournaments where the host clicked "Set Winner" only count if both players were registered + present.
- **public_bracket**: 1.0 if the tournament's lobby is public; 0.5 if invite-only but >16 players; 0.0 if private and <16 players.
- **format_rigor**: 1.0 for double-elim or round-robin, 0.8 for single-elim, 0.5 for ad-hoc.

### 4.3 Credibility composite

```
credibility = 0.30 * size_factor
            + 0.25 * field_strength
            + 0.25 * host_trust
            + 0.20 * match_credibility
```

Weights sum to 1.0. This score is **stored on the tournament row** (`credibility_score`) at completion time so it never changes after the fact.

### 4.4 Auto-tier thresholds

```
credibility < 0.35  → 'casual'    (RP range 5–50)
credibility < 0.65  → 'verified'  (RP range 50–250)
credibility >= 0.65 → 'official'  (RP range 250–500)
```

Additional gates:
- **Casual** requires at least 4 players.
- **Verified** requires at least 16 players AND host_trust >= 0.5 AND public bracket.
- **Official** is normally only reached by Lobby Verified hosts with 32+ players. Auto-classifier can hit it, but it's the rarest tier in practice.

### 4.5 Computing `winner_rp_base`

Within each tier band, RP scales smoothly with credibility:

```
casual:    rp_base = 5   + (credibility / 0.35) * 45
verified:  rp_base = 50  + ((credibility - 0.35) / 0.30) * 200
official:  rp_base = 250 + ((credibility - 0.65) / 0.35) * 250  (capped at 500)
```

This gives a continuous award curve from 5 RP (4-player casual brawl) to 500 RP (perfect-credibility official tournament). No cliff between tiers.

### 4.6 Admin override

If `is_featured = true` and `admin_rp_override` is set on the tournament, **steps 4.3–4.5 are bypassed entirely**. The override value becomes `winner_rp_base` directly. The credibility score is still computed and stored (for transparency), but it doesn't affect RP. The featured tournament's `auto_tier` is replaced by `featured_tier_label` for display purposes.

Anti-abuse rules (confirmations, diminishing returns, smurf penalties) **still apply** to featured tournaments — featuring controls the ceiling, not the floor.

---

## 5. RP Distribution by Placement

The winner gets `winner_rp_base`. Everyone else scales down from that with a power-law distribution that rewards deep runs more than mid-bracket finishes:

```
share(placement, n_players) = winner_share * (1 / 2^(placement - 1)) * decay_factor
```

Practically, for a 16-player single-elimination bracket with `winner_rp_base = 200`:

| Placement | Multiplier | RP |
|---|---|---|
| 1st (Winner) | 1.00 | 200 |
| 2nd (Finalist) | 0.60 | 120 |
| 3rd–4th (SF) | 0.35 | 70 |
| 5th–8th (QF) | 0.18 | 36 |
| 9th–16th (R1) | 0.05 | 10 |

Players eliminated in round 1 of a Casual tournament might only walk away with 2–5 RP. That's intentional — participation matters but doesn't carry the day.

**Special cases:**
- Players who registered but never played a match: 0 RP (and don't count toward credibility's `size_factor`).
- Players who forfeited: 50% of their earned share (incentive to play it out).

---

## 6. Opponent Strength, Confirmation & Anti-Abuse Multipliers

These multiplicative factors apply *on top of* the placement share:

### 6.1 Opponent strength
```
opponent_mult = clamp(0.5 + (winner_elo_at_start - field_avg_elo) / 800, 0.5, 1.5)
```
- If the winner is +400 Elo above field average (i.e. expected to dominate), `opponent_mult = 1.0` — no bonus.
- If they're at field average, `opponent_mult ≈ 1.25` — slight bonus.
- If they're 400 Elo *below* average (huge upset), `opponent_mult = 1.5` — capped bonus.
- Losses: inverse — losing to a much weaker field hits harder.

This is the smurf-killer. A 1800-Elo player joining a 1200-Elo bracket gets the floor multiplier (0.5x) because they're expected to dominate. Worth roughly nothing.

### 6.2 Confirmation multiplier
```
confirmation_mult = 0.4 + 0.6 * fraction_of_user_matches_confirmed
```
A player whose matches all went unconfirmed gets 40% of the calculated RP. All confirmed = 100%. This makes lobby-wide refusal to confirm an exploit that hurts everyone equally.

### 6.3 Diminishing returns on repeat opponents

For each opponent the user has beaten in a *ranked* tournament in the **last 30 days**:

| Prior wins vs same opponent | Multiplier on RP from beating them again |
|---|---|
| 0 | 1.00 |
| 1 | 0.50 |
| 2 | 0.25 |
| 3 | 0.10 |
| 4+ | 0.00 |

Implemented per-match within the engine: when calculating the user's RP, the engine pulls match history and weights each match's contribution by how many times they've beaten that specific opponent recently.

### 6.4 Placement match boost
The first 5 ranked tournaments a player enters in a new season have **2.0x RP movement** (both gains and losses). This is the "calibration" period — get them to their real rank fast.

Tracked via `user_ratings.placement_matches_remaining`, set to 5 at season reset, decrements per tournament.

### 6.5 Smurf flag

When a user finishes a tournament, the engine checks if they meet the smurf profile:
- Account age < 14 days
- Total ranked tournaments played < 10
- Win rate > 85%
- Average opponent Elo at least 200 above their starting Elo (i.e. they're dominating people significantly stronger on paper)

If 3 of 4 conditions hit, the user is **flagged** in `smurf_flags`. While flagged:
- RP gains are halved (`smurf_penalty = 0.5`).
- A banner shows on their profile to admins (not publicly).
- The flag auto-clears after 20 ranked tournaments with normal performance, OR an admin can clear it manually.

### 6.6 Host cooldown

If the same host runs back-to-back ranked tournaments where >50% of players overlap, the second tournament's RP is multiplied by 0.25 until 24h have passed since the first one's start.

---

## 7. Host Trust Score

Each host has a `host_trust_score` between 0.0 and 1.0, recomputed weekly (or on-demand when computing credibility for one of their tournaments). Components:

```
host_trust = 0.25 * completion_rate         (tournaments started → completed)
           + 0.25 * confirm_rate            (avg confirm_rate across hosted tournaments)
           + 0.20 * no_dispute_rate         (1 - disputes_resolved / matches_played)
           + 0.15 * tournaments_completed_factor  (saturates at 20)
           + 0.15 * lobby_verified_bonus    (1.0 if their lobby is verified, else 0)
```

- New hosts start at 0.2 (lets them run small Casual brackets right away).
- Lobby Verified hosts floor at 0.7 (auto-qualifies them for Verified tier).
- Trust score drops on dispute spikes, no-show hosts, abandoned tournaments.

### Lobby Verified
A flag on the `servers` table (`lobby_verified BOOLEAN DEFAULT FALSE`) that an admin sets manually in admin.html. Triggers:
- All hosts in that lobby get the +0.15 lobby_verified_bonus
- Their tournaments default to Verified tier (subject to other gates)
- Display a "Lobby Verified" badge in tournament cards from this lobby

---

## 8. Seasons

### 8.1 Naming convention
Seasons are named `<SeasonName> '<YY>`:
- Spring '27 — March 1 to May 31
- Summer '27 — June 1 to August 31
- Fall '27 — September 1 to November 30
- Winter '27/'28 — December 1 to February 28/29

Stored in `seasons` table with `code` (slug like `spring-2027`), `name` (display `Spring '27`), `start_at`, `end_at`, `status` ('upcoming' / 'active' / 'archived').

Exactly one season has `status = 'active'` at any time. A cron / startup job rolls over when `now >= active.end_at`.

### 8.2 Season rollover ("soft reset")

When a season ends, every user's RP gets compressed toward the median:

```
new_rp = max(0, round(old_rp * 0.5 + 500))
```

This means:
- 3000 RP (Legend) → 2000 RP (still very high, but climbs again)
- 1000 RP (median) → 1000 RP (no change at the median)
- 500 RP (Wanderer) → 750 RP (slight bump for the floor)

The Elo number does **not** reset. Elo carries across seasons — it's the persistent skill measure.

### 8.3 Placement matches
At rollover, every user gets `placement_matches_remaining = 5`. Their first 5 ranked tournaments in the new season carry 2x RP movement.

### 8.4 Peak rank archive
For each player, for each game, for each season:
- Final RP, peak RP that season, final tier name, peak tier name → snapshotted into `season_ratings`.

This powers:
- "Peak Rank" badge on profile (shows highest tier ever achieved across all games)
- Per-season history view ("Spring '27 — Elite II, peak Overlord III")
- Achievement-style flair without the data ever being lost

### 8.5 Rank floor (anti-frustration)
A player cannot drop more than **two full tiers below their previous season's peak** at the start of the new season. If the soft reset formula would push them below that floor, RP is raised to the floor's threshold. This prevents Legends from being thrown back to Wanderer.

---

## 9. Rank Tiers

8 named tiers, each with 3 sub-divisions (III → II → I, climbing). Total: 24 rungs from bottom to top.

| Tier | Sub-rungs | RP threshold (entry) | Approx. percentile |
|---|---|---|---|
| **Wanderer** | III, II, I | 0 / 100 / 200 | Bottom ~35% |
| **Challenger** | III, II, I | 300 / 450 / 600 | ~35–55% |
| **Contender** | III, II, I | 750 / 900 / 1050 | ~55–70% |
| **Elite** | III, II, I | 1200 / 1400 / 1600 | ~70–85% |
| **Overlord** | III, II, I | 1800 / 2000 / 2200 | ~85–93% |
| **Ascendant** | III, II, I | 2400 / 2600 / 2800 | ~93–97% |
| **Mythic** | III, II, I | 3000 / 3200 / 3400 | ~97–99.5% |
| **Legend** | — | 3600+ | Top 0.5%, uncapped |

- Default starting RP for a new player in a new game: 0 (Wanderer III).
- Legend has no sub-divisions — once you're in, you're a Legend. The number keeps climbing for leaderboard ordering, but the badge is the same.
- Thresholds are deliberately spaced wider at the top so climbing into Mythic+ takes serious volume.

Per-game tier and Global tier are independent — a Legend in Rocket League can be a Wanderer in Chess.

---

## 10. Per-Game Ladders & Global Ladder

### 10.1 Game tagging
Every tournament gets a `game_tag` (free text, host-provided) and `game_tag_normalized` (slugified server-side: lowercased, spaces→hyphens, common aliases collapsed: `cs:go` / `csgo` / `cs2` → `counter-strike`).

A simple alias table maintained in `backend/rating-engine.js` (or as a `game_aliases` table later) handles known collapses. Unknown tags pass through as-is.

### 10.2 Per-game ladder query
```sql
SELECT user_id, current_rp, current_tier
FROM user_ratings
WHERE game_tag_normalized = $1 AND season_id = $current_season
ORDER BY current_rp DESC
LIMIT 100;
```

A per-game leaderboard exists for any game with at least one ranked tournament in the current season — fully emergent.

### 10.3 Global ladder
Aggregates a user's top RP across their best games. Formula:

```
global_rp = sum_top_3(per_game_rp * game_weight) / 3
```

Where `game_weight` is 1.0 for games with >=20 ranked tournaments completed this season globally (i.e. "active" games), 0.7 for less-active games. This stops a single player from cheesing the Global ladder by being top-1 in a game only 4 people play.

Global RP is recomputed nightly (or on-demand on the leaderboard endpoint) — not on every tournament completion.

---

## 11. Recommended Skill Level & Host Rank-Gate

### 11.1 Recommended skill level
On tournament creation, host picks `recommended_skill_tier`:
- `open` — any rank
- One of the 8 tier names — "Elite or below," "Mythic only," etc.

Stored as a string. Used for **discovery / filtering only** — does not directly affect RP. The natural opponent-strength multiplier handles "this bracket was tougher than expected, pay more" automatically.

### 11.2 Host rank-gate
At tournament creation, the backend pulls the host's current **per-game tier** for the tournament's `game_tag`. The dropdown of allowed `recommended_skill_tier` values is capped at that tier.

- Host at Contender II in chess → can host Wanderer, Challenger, Contender brackets only.
- Host at Legend in chess → can host any tier.
- Host with no ranked history in that game → capped at Wanderer-tier (max).

Server-side enforcement: when a tournament `POST /create` is received, the engine calls `canHostAtTier(hostId, gameTag, requestedTier)`. If false, the create is rejected with a 403.

### 11.3 Host rank snapshot
At creation time, the engine snapshots `host_rank_at_creation_global` and `host_rank_at_creation_game` (tier strings, e.g. "Overlord II") onto the tournament row. Displayed in tournament cards and bracket headers.

**Why snapshot?** If the host climbs mid-season, the tournament card shouldn't suddenly say "hosted by a Legend" when at creation they were Contender. Snapshotting preserves the truth at the moment the tournament was created.

### 11.4 Tournaments tagged 'Other'
If a host runs a tournament with a never-before-seen game tag (or explicitly tags `other`), their rank-gate for that tournament defaults to Wanderer-cap, since they have no per-game history. They can still host it; they just can't claim it's an Elite bracket.

---

## 12. Admin Featured Tournaments

### 12.1 Capabilities
Only users with `is_admin = true` can:
- Set `tournaments.is_featured = true` / `false`
- Set `tournaments.admin_rp_override` (integer, 0–10000)
- Set `tournaments.featured_tier_label` (one of `casual` / `verified` / `official` / null)

### 12.2 Admin endpoints
```
PATCH /api/ladder/admin/tournament/:id/feature
  body: { isFeatured: bool, rpOverride: int|null, tierLabel: string|null }
  auth: requires is_admin

GET   /api/ladder/admin/featured
  returns: list of currently featured tournaments
  auth: requires is_admin

PATCH /api/ladder/admin/lobby/:lobbyId/verify
  body: { verified: bool }
  auth: requires is_admin
```

### 12.3 Featured Tournaments rail on main page
A new endpoint:
```
GET /api/ladder/featured
  returns: list of currently featured tournaments (public)
```

The home page renders these in a "Featured Tournaments" rail above the regular tournament list. Each card displays:
- Featured badge (gold)
- Tier label as set by admin
- Custom RP reward ("Winner takes 1000 RP")
- Host's snapshotted rank

### 12.4 Override interaction with anti-abuse
**Important:** even featured tournaments with high RP overrides still respect:
- Diminishing returns on repeat opponents
- Smurf penalties
- Confirmation requirements
- Opponent strength multipliers

This means featuring a tournament guarantees the *base* RP value, but actual payouts to participants can still be modulated downward by their individual circumstances. This prevents featured-tournament farming.

---

## 13. Database Schema Changes

Detailed schema added to `backend/db.js`. Summary:

### 13.1 New tables

**`seasons`**
```
id SERIAL PRIMARY KEY
code TEXT UNIQUE NOT NULL            -- 'spring-2027'
name TEXT NOT NULL                   -- 'Spring ''27'
start_at TIMESTAMPTZ NOT NULL
end_at TIMESTAMPTZ NOT NULL
status TEXT NOT NULL DEFAULT 'upcoming'  -- upcoming | active | archived
compression_multiplier NUMERIC DEFAULT 0.5
compression_anchor INTEGER DEFAULT 500
created_at TIMESTAMPTZ DEFAULT NOW()
```

**`user_ratings`** — current rating per user per game (and `game_tag_normalized = '__global__'` for Global)
```
id SERIAL PRIMARY KEY
user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
game_tag_normalized TEXT NOT NULL
current_rp INTEGER NOT NULL DEFAULT 0
current_elo INTEGER NOT NULL DEFAULT 1200
peak_rp INTEGER NOT NULL DEFAULT 0
peak_tier TEXT
season_id INTEGER REFERENCES seasons(id)
placement_matches_remaining INTEGER DEFAULT 5
ranked_matches_played INTEGER DEFAULT 0
ranked_tournaments_played INTEGER DEFAULT 0
ranked_wins INTEGER DEFAULT 0
last_active TIMESTAMPTZ DEFAULT NOW()
UNIQUE(user_id, game_tag_normalized, season_id)
```

**`season_ratings`** — archived snapshot per user per game per past season
```
id SERIAL PRIMARY KEY
user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
season_id INTEGER REFERENCES seasons(id) ON DELETE CASCADE
game_tag_normalized TEXT NOT NULL
final_rp INTEGER NOT NULL
peak_rp INTEGER NOT NULL
final_tier TEXT NOT NULL
peak_tier TEXT NOT NULL
final_placement INTEGER          -- rank order within season for this game
tournaments_played INTEGER
UNIQUE(user_id, season_id, game_tag_normalized)
```

**`rp_transactions`** — audit log of every RP change
```
id SERIAL PRIMARY KEY
user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
tournament_id INTEGER REFERENCES tournaments(id) ON DELETE SET NULL
season_id INTEGER REFERENCES seasons(id) ON DELETE SET NULL
game_tag_normalized TEXT NOT NULL
delta INTEGER NOT NULL                  -- can be negative
reason TEXT NOT NULL                    -- 'tournament_win', 'tournament_placement', 'season_reset', 'admin_adjustment', 'smurf_penalty'
breakdown JSONB                         -- { base, opponent_mult, confirmation_mult, ... } for transparency
rp_before INTEGER NOT NULL
rp_after INTEGER NOT NULL
created_at TIMESTAMPTZ DEFAULT NOW()
```

**`match_confirmations`** — per-match per-player confirmation log (in addition to existing p1_report/p2_report flow)
```
id SERIAL PRIMARY KEY
match_id INTEGER REFERENCES tournament_matches(id) ON DELETE CASCADE
user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
confirmed_at TIMESTAMPTZ DEFAULT NOW()
UNIQUE(match_id, user_id)
```

**`host_trust_scores`** — cached per-host
```
host_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE
score NUMERIC NOT NULL DEFAULT 0.2
components JSONB                        -- { completion, confirm, no_dispute, ... }
last_computed TIMESTAMPTZ DEFAULT NOW()
```

**`smurf_flags`**
```
id SERIAL PRIMARY KEY
user_id INTEGER REFERENCES users(id) ON DELETE CASCADE
reason TEXT NOT NULL
score NUMERIC NOT NULL
flagged_at TIMESTAMPTZ DEFAULT NOW()
cleared_at TIMESTAMPTZ DEFAULT NULL
cleared_by INTEGER REFERENCES users(id) ON DELETE SET NULL
```

**`games`** — emergent registry (a row is added the first time a normalized tag is used)
```
id SERIAL PRIMARY KEY
tag_normalized TEXT UNIQUE NOT NULL
display_name TEXT NOT NULL              -- best human-readable form seen
tournaments_count INTEGER DEFAULT 0
first_seen TIMESTAMPTZ DEFAULT NOW()
last_seen TIMESTAMPTZ DEFAULT NOW()
```

### 13.2 Columns added to existing tables

**`tournaments`** (via ALTER TABLE):
- `game_tag` TEXT
- `game_tag_normalized` TEXT
- `is_ranked` BOOLEAN DEFAULT TRUE
- `recommended_skill_tier` TEXT DEFAULT 'open'
- `host_rank_at_creation_global` TEXT
- `host_rank_at_creation_game` TEXT
- `auto_tier` TEXT                              -- casual | verified | official
- `credibility_score` NUMERIC
- `computed_winner_rp` INTEGER
- `is_featured` BOOLEAN DEFAULT FALSE
- `admin_rp_override` INTEGER
- `featured_tier_label` TEXT
- `featured_by` INTEGER REFERENCES users(id)
- `featured_at` TIMESTAMPTZ
- `rp_awarded` BOOLEAN DEFAULT FALSE           -- guard so applyTournamentResults can't double-award
- `season_id_at_completion` INTEGER REFERENCES seasons(id)

**`servers`**:
- `lobby_verified` BOOLEAN DEFAULT FALSE
- `verified_at` TIMESTAMPTZ
- `verified_by` INTEGER REFERENCES users(id)

**`tournament_matches`**:
- `confirmed_by_p1` BOOLEAN DEFAULT FALSE
- `confirmed_by_p2` BOOLEAN DEFAULT FALSE

---

## 14. API Surface (Phase 2 reference)

```
GET  /api/ladder/me                                — my ranks across all my games + Global
GET  /api/ladder/user/:userId                      — public ranks for any user
GET  /api/ladder/leaderboard/global                — top 100 Global
GET  /api/ladder/leaderboard/game/:gameTag         — top 100 for a specific game
GET  /api/ladder/leaderboard/lobby/:lobbyId        — top 100 within a lobby
GET  /api/ladder/season/current                    — current active season
GET  /api/ladder/season/history/:userId            — a user's past-season archive

GET  /api/ladder/featured                          — public Featured rail
GET  /api/ladder/games                             — list of all known game tags

PATCH /api/ladder/admin/tournament/:id/feature     — admin-only
PATCH /api/ladder/admin/lobby/:lobbyId/verify      — admin-only
POST  /api/ladder/admin/clear-smurf-flag           — admin-only
POST  /api/ladder/admin/season/rollover            — admin-only manual trigger

POST  /api/ladder/internal/apply-results/:tournamentId  — called by tournaments.advanceWinner() on completion
```

---

## 15. Integration Points

### 15.1 Tournament creation (`POST /api/tournaments/create`)
Add validation step before INSERT:
1. Parse `gameTag` → compute `gameTagNormalized`.
2. Call `ratingEngine.canHostAtTier(req.user.id, gameTagNormalized, recommendedSkillTier)` — reject 403 if false.
3. Call `ratingEngine.getUserTier(req.user.id, '__global__')` and `ratingEngine.getUserTier(req.user.id, gameTagNormalized)` to snapshot.
4. INSERT including all new columns.
5. UPSERT into `games` table.

### 15.2 Tournament completion (`advanceWinner` in tournaments.js)
When `advanceWinner` sets `tournaments.status = 'completed'`:
1. Check `rp_awarded` flag — if already true, no-op (idempotent guard).
2. Call `ratingEngine.applyTournamentResults(tournamentId)`.
3. Set `rp_awarded = true`.

The engine handles everything: credibility computation, RP distribution, Elo updates, anti-abuse, transactions, user_ratings updates.

### 15.3 Match completion (existing self-report agreement path)
When `p1_report` and `p2_report` agree:
- Insert two rows into `match_confirmations` (one per player).
- This already exists effectively; we're just materializing it into a normalized table so credibility math has a clean source.

### 15.4 Season rollover
A scheduled task or startup check (`ratingEngine.checkSeasonRollover()`) runs on server boot and once per hour:
1. If current `active` season has `end_at < NOW()`, run rollover.
2. Archive all `user_ratings` rows for that season into `season_ratings`.
3. Compress each user_ratings row: `new_rp = max(rank_floor, round(old_rp * 0.5 + 500))`.
4. Reset `placement_matches_remaining = 5`.
5. Activate the next season.

---

## 16. Edge Cases & Decisions

| Case | Decision |
|---|---|
| Tournament cancelled before completion | No RP awarded. No effect on host_trust beyond the abandonment hit. |
| Player joins but never gets a match (bye to final, loses) | Counts as 1 ranked match for placement_matches, gets full placement share. |
| Host plays in their own tournament | Allowed. Their host_trust still applies. No special restriction. |
| Same player in 2 games of the same tournament (shouldn't happen but) | Engine deduplicates by user_id. |
| Tournament with 0 confirmed matches | `confirm_rate = 0`, credibility plummets, RP is 5–10 max. |
| Tournament ended in a forfeit at the final | Winner still gets full RP, runner-up gets 75% of normal runner-up share (forfeit penalty). |
| Player banned mid-season | `user_ratings` rows are kept (for historical leaderboard integrity) but excluded from active leaderboard queries. |
| Account deletion | `ON DELETE CASCADE` clears their `user_ratings`, but `rp_transactions` keep `user_id` as NULL (audit log integrity). |
| What if admin sets `admin_rp_override = 0`? | Tournament gives 0 RP. Useful for "exhibition" featured tournaments. |
| What if a Legend hosts a Wanderer-tier featured tournament? | Allowed. The host gate is "≤ host's own tier," and Legend is above everything. The recommended_skill_tier filter helps Wanderers find it. |
| Two seasons accidentally `status='active'` | Server startup runs a consistency check: enforce exactly one. The earlier-started one wins. |

---

## 17. Future Phases (deferred)

| Phase | Scope |
|---|---|
| **Phase 3** | Leaderboard endpoints + JSON shapes |
| **Phase 4** | Frontend: tournament card rank badges, recommended-tier filter, host rank-gate UI |
| **Phase 5** | Global / per-game / lobby leaderboard pages |
| **Phase 6** | Admin panel additions in `admin.html` (feature tournaments, verify lobbies, clear smurf flags) |
| **Phase 7** | Profile-page additions (current rank, peak rank, season history) |
| **Phase 8** | Matchmaking using Elo (optional — separate product surface) |
| **Phase 9** | Cross-lobby tournament discovery by skill tier |

---

## 18. Worked Example

> **"Lobby Cup #3" — Rocket League, hosted by Connor (admin)**
>
> - 32 players, all checked in.
> - Host: Connor, Lobby Verified, host_trust = 0.85.
> - Avg field Elo: 1650.
> - Public bracket, single-elim, all matches confirmed both ways.
> - **Admin feature:** Connor sets `is_featured = true`, `admin_rp_override = 1000`, `featured_tier_label = 'official'`.
>
> **Credibility computation (for the record, not used for RP since override is set):**
> - size_factor = 0.8 (32 players)
> - field_strength = clamp((1650 − 1200) / 600, 0, 1) = 0.75
> - host_trust = 0.85
> - match_credibility = 0.5 * 1.0 + 0.3 * 1.0 + 0.2 * 0.8 = 0.96
> - credibility = 0.30 * 0.8 + 0.25 * 0.75 + 0.25 * 0.85 + 0.20 * 0.96 = **0.83**
> - Would have hit Official tier naturally (0.83 ≥ 0.65). Override matches what auto would have done.
>
> **RP distribution (1000 base):**
> | Placement | Share | RP |
> |---|---|---|
> | Winner | 1.00 | 1000 |
> | Finalist | 0.60 | 600 |
> | SF (×2) | 0.35 | 350 ea |
> | QF (×4) | 0.18 | 180 ea |
> | R2 (×8) | 0.09 | 90 ea |
> | R1 (×16) | 0.04 | 40 ea |
>
> **Winner is also a Legend (Elo 2100) in a field averaging 1650:**
> - opponent_mult for winner = clamp(0.5 + (2100 − 1650) / 800, 0.5, 1.5) = 0.5 + 0.56 = **1.06**
> - Winner's actual RP: 1000 * 1.06 = **1060 RP**
>
> **A finalist who is 1500-Elo:**
> - Below field avg → opponent_mult = clamp(0.5 + (1500 − 1650) / 800, 0.5, 1.5) = 0.5 + (−0.19) = **0.31, clamped to 0.5**
> - Wait, finalist is the *loser* path so we use loser logic — finalists get the placement share regardless of opponent direction (they earned their placement).
> - Finalist's RP: 600 * confirmation_mult (1.0) * placement_match_mult (1.0 if not in their first 5) = **600 RP**
>
> Outcome: Winner climbs 2 sub-divisions. Finalist climbs 1. Everyone else gets a meaningful nudge. Felt like a real event.

---

## 19. Open Questions for Connor

1. **Season rollover trigger:** auto on cron, or manual via admin button only? Recommendation: auto, with admin override button as escape valve.
2. **Should Casual tournaments count toward placement matches?** Recommendation: yes — otherwise new players never finish their calibration if they only play casual.
3. **Display the hidden Elo on the user's own profile (private to them)?** Recommendation: yes, behind a "show advanced stats" toggle. Doesn't show to other users.
4. **What's the policy if a Lobby Verified server gets a wave of disputes/no-shows?** Recommendation: auto-revoke verification if host_trust of ANY host in the lobby drops below 0.4 over a 30-day window, and notify the admin.
5. **Should ranked tournaments require a minimum of 8 players?** Currently the engine supports 4-player ranked tournaments at near-zero RP. Worth raising the floor?

---

/* ============================================
   AURUM — The Arena — Final Fix Chat (continued)
   FIX (this pass) — Duel creation:
   The create-duel modal was sending { opponent_username,
   stake_amount, type, duration_hours } to POST /api/duels, but
   the backend (services/duel.js createDuel) requires
   { target_username, title, duel_tip_amount } — it has no concept
   of "type" or "duration" for duels at all (those fields were
   silently ignored even if sent), and "title" was never collected
   or sent, which is why creation failed with "target_username is
   required" / title-related 400s.
   Fixed: added a required Title field, removed the Type and
   Duration selectors (they did nothing on the backend), and
   renamed the submit payload to match the real contract.
============================================ */

window.ArenaPage = {
  container:   null,
  initialized: false,
  activeTab:   'challenges',
  activeQuickDuelId: null,

  TRIVIA_QUESTIONS: [
    { q: 'What is the capital of France?', options: ['Berlin', 'Madrid', 'Paris', 'Rome'], correct: 2 },
    { q: 'How many continents are there?', options: ['5', '6', '7', '8'], correct: 2 },
    { q: '2 + 2 × 2 = ?', options: ['6', '8', '4', '2'], correct: 0 },
    { q: 'Largest planet in our solar system?', options: ['Earth', 'Jupiter', 'Saturn', 'Mars'], correct: 1 },
    { q: 'HTML stands for?', options: ['Hyper Trainer Marking Language', 'Hyper Text Markup Language', 'Hyper Text Marketing Language', 'Hyperlink Text Markup Language'], correct: 1 },
  ],

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadChallenges('active');
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="arena-wrap">

        <!-- Header -->
        <div class="arena-header">
          <div>
            <p class="section-eyebrow">Drop Circles</p>
            <h2 class="arena-title">The Arena</h2>
          </div>
          <button class="btn btn-primary btn-sm" id="btn-create-challenge">+ Create</button>
        </div>

        <!-- Stats bar -->
        <div class="arena-stats">
          <div class="arena-stat">
            <span class="arena-stat-value mono" id="arena-total-pool">—</span>
            <span class="arena-stat-label">Total Pooled</span>
          </div>
          <div class="arena-stat-divider"></div>
          <div class="arena-stat">
            <span class="arena-stat-value mono" id="arena-active">—</span>
            <span class="arena-stat-label">Active</span>
          </div>
          <div class="arena-stat-divider"></div>
          <div class="arena-stat">
            <span class="arena-stat-value mono" id="arena-ending">—</span>
            <span class="arena-stat-label">Ending Soon</span>
          </div>
        </div>

        <!-- Section tabs: Challenges / Duels / Crews -->
        <div class="arena-section-tabs">
          <button class="arena-section-tab active" data-section="challenges">Challenges</button>
          <button class="arena-section-tab" data-section="duels">Duels</button>
          <button class="arena-section-tab" data-section="crews">Crews</button>
        </div>

        <!-- Challenges panel -->
        <div id="panel-challenges">
          <div class="arena-tabs" style="margin-bottom:var(--space-3);">
            <button class="arena-tab active" data-status="active">Active</button>
            <button class="arena-tab" data-status="upcoming">Upcoming</button>
            <button class="arena-tab" data-status="completed">Completed</button>
          </div>
          <div class="challenge-list" id="challenge-list"></div>
        </div>

                <!-- Duels panel -->
        <div id="panel-duels" style="display:none;">
          <div class="duel-marquee-wrap">
            <div class="duel-marquee-track">🎮 More game types coming soon: Reaction Time · Typing Speed &nbsp;&nbsp;&nbsp;&nbsp; 🎮 More game types coming soon: Reaction Time · Typing Speed</div>
          </div>
          <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
            <button class="btn btn-outline btn-sm" id="btn-create-duel">+ New Duel</button>
          </div>
          <div class="challenge-list" id="duel-list"></div>
        </div>

        <!-- Crews panel -->
        <div id="panel-crews" style="display:none;">
          <div style="display:flex;justify-content:flex-end;margin-bottom:var(--space-3);">
            <button class="btn btn-outline btn-sm" id="btn-create-crew">+ New Crew</button>
          </div>
          <div class="challenge-list" id="crew-list"></div>
        </div>

      </div>

      <!-- Create Crew Battle Modal -->
      <div class="modal-overlay" id="create-crew-battle-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title">Challenge a Crew</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-4);">
            <div class="input-group">
              <label class="input-label">Battle Title</label>
              <input class="input" id="crew-battle-title" placeholder="e.g. Most Revenue This Week" />
            </div>
            <div class="input-group">
              <label class="input-label">Target Crew Name</label>
              <input class="input" id="crew-battle-target" placeholder="Exact crew name" />
            </div>
            <div class="input-group">
              <label class="input-label">Entry Contribution</label>
              <select class="input" id="crew-battle-entry">
                <option value="10">$10</option>
                <option value="25">$25</option>
                <option value="50">$50</option>
                <option value="100">$100</option>
                <option value="250">$250</option>
              </select>
              <p style="font-size:var(--text-xs);color:var(--color-text-muted);margin-top:var(--space-1);">
                Deducted from your personal wallet as your crew's entry into the prize pool.
              </p>
            </div>
            <div class="input-group">
              <label class="input-label">Battle Duration</label>
              <select class="input" id="crew-battle-duration">
                <option value="24">24 Hours</option>
                <option value="48">48 Hours</option>
                <option value="168">7 Days</option>
              </select>
            </div>
            <p style="font-size:var(--text-xs);color:var(--color-text-muted);line-height:1.5;">
              This starts immediately — the target crew is not asked to accept. Non-participant members vote on a winner once the window ends.
            </p>
            <div style="display:flex;gap:var(--space-3);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-crew-battle">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-crew-battle">Launch Battle</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Create Challenge Modal -->
      <div class="modal-overlay" id="create-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title">New Challenge</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-4);">
            <div class="input-group">
              <label class="input-label">Challenge Title</label>
              <input class="input" id="ch-title" placeholder="e.g. Most Revenue This Month" />
            </div>
            <div class="input-group">
              <label class="input-label">Challenge Type</label>
              <select class="input" id="ch-type">
                <option value="revenue">Most Revenue</option>
                <option value="deals_closed">Most Deals Closed</option>
                <option value="growth">Best Growth %</option>
                <option value="savings">Most Saved</option>
                <option value="charity_brawl">Charity Brawl</option>
              </select>
            </div>
            <div class="input-group">
              <label class="input-label">Description</label>
              <textarea class="input" id="ch-description"
                placeholder="Describe what participants need to prove..."
                rows="3"
                style="resize:none;font-family:var(--font-body);"></textarea>
            </div>
            <div class="input-group">
              <label class="input-label">Entry Fee</label>
              <select class="input" id="ch-fee">
                <option value="5">$5</option>
                <option value="10">$10</option>
                <option value="25">$25</option>
                <option value="50">$50</option>
                <option value="100">$100</option>
                <option value="250">$250</option>
                <option value="500">$500</option>
                <option value="1000">$1,000</option>
              </select>
            </div>
            <div class="input-group">
              <label class="input-label">Duration</label>
              <select class="input" id="ch-duration">
                <option value="24">24 Hours</option>
                <option value="48">48 Hours</option>
                <option value="168">7 Days</option>
                <option value="720">30 Days</option>
              </select>
            </div>
            <div style="display:flex;gap:var(--space-3);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-challenge">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-challenge">Launch</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Challenge Detail Modal -->
      <div class="modal-overlay" id="challenge-detail-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <div id="challenge-detail-content"></div>
        </div>
      </div>

      <!-- Create Duel Modal
           FIX: added required Title field. Removed Challenge Type
           and Duration selectors — the backend never accepted or
           stored either of them (duels have no "type" column, and
           the accept/resolve windows are fixed server-side at
           48h / 7 days, not user-selectable). -->
      <div class="modal-overlay" id="create-duel-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title">New Duel</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-4);">
            <div class="input-group">
              <label class="input-label">Duel Title</label>
              <input class="input" id="duel-title" placeholder="e.g. Most Revenue This Week" />
            </div>
            <div class="input-group">
              <label class="input-label">Opponent Username</label>
              <input class="input" id="duel-opponent" placeholder="@username" />
            </div>
            <div class="input-group">
              <label class="input-label">Stake Amount</label>
              <select class="input" id="duel-stake">
                <option value="10">$10</option>
                <option value="25">$25</option>
                <option value="50">$50</option>
                <option value="100">$100</option>
                <option value="250">$250</option>
              </select>
            </div>
            <div class="input-group">
              <label class="input-label">Description (optional)</label>
              <textarea class="input" id="duel-description"
                placeholder="What are you proving with this duel?" rows="2"
                style="resize:none;font-family:var(--font-body);"></textarea>
            </div>
            <div class="input-group">
              <label class="input-label">Duel Format</label>
              <select class="input" id="duel-format">
                <option value="proof">Proof Duel (submit evidence, community votes)</option>
                <option value="quick">Quick Duel (instant mini-game, no voting)</option>
              </select>
            </div>
            <div class="input-group" id="duel-quick-game-group" style="display:none;">
              <label class="input-label">Game</label>
              <select class="input" id="duel-quick-game">
                <option value="reflex_tap">Reflex Tap</option>
                <option value="trivia">Trivia Duel</option>
              </select>
            </div>
            <div style="display:flex;gap:var(--space-3);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-duel">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-duel">Challenge</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Quick Duel Play Modal -->
      <div class="modal-overlay" id="quick-duel-play-modal" style="display:none;">
        <div class="modal" style="text-align:center;">
          <div class="modal-handle"></div>
          <h3 class="modal-title" id="qd-play-title">Quick Duel</h3>
          <div id="qd-play-area"></div>
        </div>
      </div>

      <!-- Create Crew Modal -->

      <!-- Create Crew Modal -->
      <div class="modal-overlay" id="create-crew-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title">Create Crew</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-4);">
            <div class="input-group">
              <label class="input-label">Crew Name</label>
              <input class="input" id="crew-name" placeholder="e.g. The Builders" />
            </div>
            <div class="input-group">
              <label class="input-label">Description</label>
              <textarea class="input" id="crew-desc"
                placeholder="What your crew is about..." rows="3"
                style="resize:none;font-family:var(--font-body);"></textarea>
            </div>
            <div style="display:flex;gap:var(--space-3);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-crew">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-crew">Create Crew</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Crew Chat Modal -->
      <div class="modal-overlay" id="crew-chat-modal" style="display:none;">
        <div class="modal" style="display:flex;flex-direction:column;height:80vh;max-height:600px;">
          <div class="modal-handle"></div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:var(--space-2);">
            <h3 class="modal-title" id="crew-chat-title" style="margin:0;">Crew Chat</h3>
            <button class="btn btn-ghost btn-sm" id="btn-open-crew-profile-from-chat">Crew Profile ›</button>
          </div>
          <div id="crew-chat-messages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-2) 0;"></div>
          <div id="crew-chat-reply-bar-container"></div>
          <div style="display:flex;gap:var(--space-2);padding-top:var(--space-3);">
            <input class="input" id="crew-chat-input" placeholder="Message your crew..." style="flex:1;" />
            <button class="btn btn-primary btn-sm" id="btn-send-crew-message">Send</button>
          </div>
        </div>
      </div>

      <!-- Request Spend Modal (Crew Wallet) -->
      <div class="modal-overlay" id="request-spend-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title">Request Spend</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-4);">
            <div class="input-group">
              <label class="input-label">Amount (USD)</label>
              <input class="input" id="spend-amount-input" type="number" min="0.01" step="0.01" placeholder="0.00" />
            </div>
            <div class="input-group">
              <label class="input-label">Reason</label>
              <input class="input" id="spend-reason-input" placeholder="What is this spend for?" />
            </div>
            <div style="display:flex;gap:var(--space-3);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-spend">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-spend">Submit</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Co-Sign Request Modal (Crew Wallet) -->
      <div class="modal-overlay" id="cosign-request-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title">Co-Sign Request</h3>
          <div class="card" style="margin-bottom:var(--space-3);">
            <div style="display:flex;justify-content:space-between;margin-bottom:var(--space-2);">
              <span style="color:var(--color-text-muted);">Requested by</span>
              <span style="font-weight:700;" id="cosign-requested-by">—</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:var(--space-2);">
              <span style="color:var(--color-text-muted);">Reason</span>
              <span style="font-weight:700;" id="cosign-reason">—</span>
            </div>
            <div style="display:flex;justify-content:space-between;">
              <span style="color:var(--color-text-muted);">Amount</span>
              <span style="font-weight:700;color:var(--color-gold);" id="cosign-amount">—</span>
            </div>
          </div>
          <p style="font-size:var(--text-xs);color:var(--color-text-muted);margin-bottom:var(--space-3);" id="cosign-status-note"></p>
          <div class="input-group" style="margin-bottom:var(--space-3);">
            <label class="input-label">Reason (if rejecting)</label>
            <input class="input" id="cosign-veto-reason-input" placeholder="Optional" />
          </div>
          <div style="display:flex;gap:var(--space-3);">
            <button class="btn btn-ghost btn-full" id="btn-reject-cosign">Reject</button>
            <button class="btn btn-primary btn-full" id="btn-approve-cosign">Approve (Co-Sign)</button>
          </div>
        </div>
      </div>

            <!-- Battle Vote Modal -->
      <div class="modal-overlay" id="battle-vote-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title" id="battle-vote-title">Crew Battle</h3>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:var(--space-3);">Pick the crew you think should win this battle.</p>
          <div class="card" id="battle-vote-option-a" style="cursor:pointer;margin-bottom:var(--space-2);display:flex;justify-content:space-between;align-items:center;">
            <span id="battle-vote-option-a-label" style="font-weight:700;">—</span>
            <span class="badge badge-muted" id="battle-vote-option-a-pct">—</span>
          </div>
          <div class="card" id="battle-vote-option-b" style="cursor:pointer;margin-bottom:var(--space-2);display:flex;justify-content:space-between;align-items:center;">
            <span id="battle-vote-option-b-label" style="font-weight:700;">—</span>
            <span class="badge badge-muted" id="battle-vote-option-b-pct">—</span>
          </div>
          <p style="font-size:var(--text-xs);color:var(--color-text-muted);" id="battle-vote-status"></p>
        </div>
      </div>

      <!-- Member Action Modal -->
      <div class="modal-overlay" id="member-action-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <h3 class="modal-title" id="member-action-title">Member</h3>
          <div style="display:flex;flex-direction:column;gap:var(--space-3);">
            <button class="btn btn-outline btn-full" id="btn-action-promote" style="display:none;">Promote to Moderator</button>
            <button class="btn btn-outline btn-full" id="btn-action-mute" style="display:none;">Mute in Crew Chat</button>
            <button class="btn btn-danger btn-full" id="btn-action-kick" style="display:none;">Remove from Crew</button>
          </div>
        </div>
      </div>

      <div class="modal-overlay" id="crew-detail-modal" style="display:none;">
        <div class="modal" style="display:flex;flex-direction:column;max-height:80vh;overflow-y:auto;">
          <div class="modal-handle"></div>
          <h3 class="modal-title" id="crew-detail-title">Crew</h3>
          <div id="crew-detail-body"></div>
        </div>
      </div>
    `;
    this.applyStyles();
    this.bindEvents();
  },

  bindEvents() {
    /* Section tabs */
    document.querySelectorAll('.arena-section-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.arena-section-tab')
          .forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.switchSection(tab.dataset.section);
      });
    });

    /* Challenge status filter tabs */
    document.querySelectorAll('.arena-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.arena-tab')
          .forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.loadChallenges(tab.dataset.status);
      });
    });

    /* Create challenge modal */
    document.getElementById('btn-create-challenge')
      ?.addEventListener('click', () => {
        document.getElementById('create-modal').style.display = 'flex';
      });
    document.getElementById('btn-cancel-challenge')
      ?.addEventListener('click', () => {
        document.getElementById('create-modal').style.display = 'none';
      });
    document.getElementById('create-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'create-modal')
          e.target.style.display = 'none';
      });
    document.getElementById('btn-submit-challenge')
      ?.addEventListener('click', () => this.submitChallenge());

    /* Challenge detail modal close */
    document.getElementById('challenge-detail-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'challenge-detail-modal')
          e.target.style.display = 'none';
      });

    /* Create duel modal */
    document.getElementById('btn-create-duel')
      ?.addEventListener('click', () => {
        document.getElementById('create-duel-modal').style.display = 'flex';
      });
    document.getElementById('btn-cancel-duel')
      ?.addEventListener('click', () => {
        document.getElementById('create-duel-modal').style.display = 'none';
      });
    document.getElementById('create-duel-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'create-duel-modal')
          e.target.style.display = 'none';
      });
    document.getElementById('btn-submit-duel')
      ?.addEventListener('click', () => this.submitDuel());
    document.getElementById('duel-format')
      ?.addEventListener('change', (e) => {
        document.getElementById('duel-quick-game-group').style.display =
          e.target.value === 'quick' ? 'block' : 'none';
      });
    document.getElementById('quick-duel-play-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'quick-duel-play-modal')
          e.target.style.display = 'none';
      });

    /* Crew chat modal close */
    document.getElementById('crew-chat-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'crew-chat-modal') {
          e.target.style.display = 'none';
          this.closeCrewChat();
        }
      });
    document.getElementById('crew-detail-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'crew-detail-modal')
          e.target.style.display = 'none';
      });
    /* Crew chat send */
    document.getElementById('btn-send-crew-message')
      ?.addEventListener('click', () => this.sendCrewMessage());
    document.getElementById('crew-chat-input')
      ?.addEventListener('keydown', e => {
        if (e.key === 'Enter') this.sendCrewMessage();
      });

    document.getElementById('btn-create-crew')
      ?.addEventListener('click', () => {
        document.getElementById('create-crew-modal').style.display = 'flex';
      });
    document.getElementById('btn-cancel-crew')
      ?.addEventListener('click', () => {
        document.getElementById('create-crew-modal').style.display = 'none';
      });
    document.getElementById('create-crew-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'create-crew-modal')
          e.target.style.display = 'none';
      });
    document.getElementById('btn-submit-crew')
      ?.addEventListener('click', () => this.submitCrew());

    /* Create crew battle modal */
    document.getElementById('btn-cancel-crew-battle')
      ?.addEventListener('click', () => {
        document.getElementById('create-crew-battle-modal').style.display = 'none';
      });
    document.getElementById('create-crew-battle-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'create-crew-battle-modal')
          e.target.style.display = 'none';
      });document.getElementById('btn-submit-crew-battle')
      ?.addEventListener('click', () => this.submitCrewBattle());

    /* Request Spend modal (Crew Wallet) */
    document.getElementById('btn-cancel-spend')
      ?.addEventListener('click', () => {
        document.getElementById('request-spend-modal').style.display = 'none';
      });
    document.getElementById('request-spend-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'request-spend-modal')
          e.target.style.display = 'none';
      });
    document.getElementById('btn-submit-spend')
      ?.addEventListener('click', () => this.submitSpendRequest());

    /* Co-Sign Request modal (Crew Wallet) */
    document.getElementById('btn-reject-cosign')
      ?.addEventListener('click', () => this.rejectCosignRequest());
    document.getElementById('cosign-request-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'cosign-request-modal')
          e.target.style.display = 'none';
      });
        document.getElementById('btn-approve-cosign')
      ?.addEventListener('click', () => this.approveCosignRequest());

    /* Battle Vote modal */
    document.getElementById('battle-vote-option-a')
      ?.addEventListener('click', (e) => this.castBattleVote(e.currentTarget.dataset.crewId));
    document.getElementById('battle-vote-option-b')
      ?.addEventListener('click', (e) => this.castBattleVote(e.currentTarget.dataset.crewId));
    document.getElementById('battle-vote-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'battle-vote-modal')
          e.target.style.display = 'none';
      });

    /* Member Action modal */
    document.getElementById('member-action-modal')
      ?.addEventListener('click', e => {
        if (e.target.id === 'member-action-modal')
          e.target.style.display = 'none';
      });
    document.getElementById('btn-action-promote')
      ?.addEventListener('click', async (e) => {
        const makeMod = e.currentTarget.dataset.makeMod === 'true';
        try {
          await AURUM.CrewAPI.setModerator(this.activeActionCrewId, this.activeActionUserId, makeMod);
          document.getElementById('member-action-modal').style.display = 'none';
          AURUM.showToast(makeMod ? 'Member promoted to moderator.' : 'Moderator demoted.', 'default');
          this.openCrewDetail(this.activeActionCrewId);
        } catch (err) {
          AURUM.showToast(err.message || 'Could not update role.', 'error');
        }
      });
    document.getElementById('btn-action-mute')
      ?.addEventListener('click', async () => {
        const reason = prompt(`Reason for muting ${this.activeActionUsername}:`);
        if (!reason || !reason.trim()) return;
        const durationInput = prompt('Mute duration in hours (e.g. 24):', '24');
        const duration = parseFloat(durationInput);
        if (!duration || duration <= 0) return AURUM.showToast('Invalid duration.', 'error');
        try {
          await AURUM.CrewAPI.muteMember(this.activeActionCrewId, this.activeActionUserId, duration, reason.trim());
          document.getElementById('member-action-modal').style.display = 'none';
          AURUM.showToast(`${this.activeActionUsername} muted.`, 'default');
          this.openCrewDetail(this.activeActionCrewId);
        } catch (err) {
          AURUM.showToast(err.message || 'Could not mute member.', 'error');
        }
      });
    document.getElementById('btn-action-kick')
      ?.addEventListener('click', async () => {
        if (!confirm(`Remove ${this.activeActionUsername} from the crew?`)) return;
        try {
          await AURUM.CrewAPI.kickMember(this.activeActionCrewId, this.activeActionUserId);
          document.getElementById('member-action-modal').style.display = 'none';
          AURUM.showToast('Member removed.', 'default');
          this.openCrewDetail(this.activeActionCrewId);
        } catch (err) {
          AURUM.showToast(err.message || 'Could not remove member.', 'error');
        }
      });
  },

  switchSection(section) {
    ['challenges', 'duels', 'crews'].forEach(s => {
      const el = document.getElementById(`panel-${s}`);
      if (el) el.style.display = s === section ? 'block' : 'none';
    });
    this.activeTab = section;
    if (section === 'challenges') this.loadChallenges('active');
    if (section === 'duels')      this.loadDuels();
    if (section === 'crews')      this.loadCrews();
  },

  /* --------------------------------------------------
     CHALLENGES
  -------------------------------------------------- */

  async loadChallenges(tab = 'active') {
    const list = document.getElementById('challenge-list');
    if (!list) return;
    list.innerHTML = this.skeletons(3);

    const statusMap = { active: 'open', upcoming: 'upcoming', completed: 'completed' };
    const backendStatus = statusMap[tab] || 'open';

    try {
      const data = await AURUM.ArenaAPI.getChallenges(20, 0, backendStatus);
      const challenges = data.challenges || [];
      this.renderChallenges(challenges);
      this.updateStats(challenges);
    } catch (err) {
      this.renderChallenges([]);
      this.updateStats([]);
      AURUM.showToast('Could not load challenges.', 'error');
    }
  },

  renderChallenges(challenges) {
    const list = document.getElementById('challenge-list');
    if (!list) return;
    if (!challenges.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⚔️</div>
          <h4>No challenges here</h4>
          <p>Be the first to create one.</p>
        </div>`;
      return;
    }
    list.innerHTML = challenges
      .map((ch, i) => this.challengeHTML(ch, i))
      .join('');
    this.bindChallengeEvents();
  },

  getDisplayStatus(ch) {
    if (ch.status === 'open' && ch.starts_at && new Date(ch.starts_at) > new Date()) {
      return 'upcoming';
    }
    return ch.status || 'open';
  },

  challengeHTML(ch, index) {
    const typeIcons = {
      revenue: '💰', deals: '🤝', growth: '📈',
      savings: '🏦', charity: '🏆',
    };
    const statusColors = {
      open:      'var(--color-success)',
      upcoming:  'var(--color-gold)',
      completed: 'var(--color-text-muted)',
    };
    const icon          = typeIcons[ch.type] || '⚔️';
    const displayStatus = this.getDisplayStatus(ch);
    const statusColor   = statusColors[displayStatus] || 'var(--color-text-muted)';
    const timeLeft       = this.getTimeLeft(ch.ends_at);
    const poolAmount     = AURUM.formatAmount(ch.pool_amount || 0);
    const entryFee       = AURUM.formatAmount(ch.entry_fee || 0);
    const goldCount      = ch.gold_count || 0;
    const userGolded     = ch.user_golded || false;
    const isBoosted      = ch.is_boosted || false;
    const canEnter       = displayStatus === 'open';

    return `
      <div class="challenge-card card fade-in" style="animation-delay:${index * 80}ms;">

        ${isBoosted ? `
          <div style="display:flex;align-items:center;gap:var(--space-2);
            margin-bottom:var(--space-2);">
            <span style="font-size:9px;letter-spacing:0.1em;text-transform:uppercase;
              color:var(--color-gold);background:var(--color-gold-glow);
              border:1px solid var(--color-border-gold);border-radius:var(--radius-full);
              padding:2px 8px;">⚡ Boosted</span>
          </div>
        ` : ''}

        <div class="challenge-top">
          <div class="challenge-icon">${icon}</div>
          <div class="challenge-info">
            <p class="challenge-title">${ch.title}</p>
            <div class="challenge-meta">
              <span class="badge badge-muted" style="font-size:9px;">${ch.type || 'achievement'}</span>
              <span style="font-size:10px;color:${statusColor};letter-spacing:0.06em;
                text-transform:uppercase;">${displayStatus}</span>
            </div>
          </div>
          <div class="challenge-pool">
            <span class="challenge-pool-amount mono">${poolAmount}</span>
            <span class="challenge-pool-label">pool</span>
          </div>
        </div>

        <div class="challenge-details">
          <div class="challenge-detail">
            <span class="challenge-detail-value mono">${entryFee}</span>
            <span class="challenge-detail-label">Entry</span>
          </div>
          <div class="challenge-detail">
            <span class="challenge-detail-value mono">${ch.entries || 0}</span>
            <span class="challenge-detail-label">Entries</span>
          </div>
          <div class="challenge-detail">
            <span class="challenge-detail-value mono"
              style="color:${canEnter
                ? 'var(--color-danger)' : 'var(--color-text-muted)'};">
              ${timeLeft}
            </span>
            <span class="challenge-detail-label">Remaining</span>
          </div>
        </div>

        <div style="display:flex;gap:var(--space-2);align-items:center;">

          ${canEnter ? `
            <button class="btn btn-outline btn-full btn-sm btn-enter-challenge"
              data-challenge-id="${ch.id}"
              data-entry-fee="${ch.entry_fee}"
              ${ch.user_joined ? 'disabled' : ''}>
              ${ch.user_joined ? 'Entered ✦' : 'Enter Challenge'}
            </button>
          ` : `
            <button class="btn btn-ghost btn-full btn-sm" disabled>
              ${displayStatus === 'completed' ? 'Completed' : 'Starting Soon'}
            </button>
          `}

          <!-- Gold Button — free for all members -->
          <button class="btn-gold-button ${userGolded ? 'golded' : ''}"
            data-challenge-id="${ch.id}"
            title="Give Gold"
            ${userGolded ? 'disabled' : ''}>
            <svg width="16" height="16" viewBox="0 0 24 24"
              fill="${userGolded ? '#C9A84C' : 'none'}"
              stroke="#C9A84C" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14
                18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27
                8.91 8.26 12 2"/>
            </svg>
            <span class="gold-count">${goldCount}</span>
          </button>

          <!-- View detail -->
          <button class="btn-detail-challenge btn btn-ghost btn-sm"
            data-challenge-id="${ch.id}"
            style="flex-shrink:0;padding:var(--space-2);">
            ···
          </button>

        </div>
      </div>
    `;
  },

  bindChallengeEvents() {
    /* Enter challenge — POST /api/challenges/:id/join */
    document.querySelectorAll('.btn-enter-challenge').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.dataset.challengeId;
        btn.textContent = 'Entering...';
        btn.disabled    = true;
        try {
          await AURUM.ArenaAPI.joinChallenge(id);
          AURUM.showToast('You\'re in the Arena.', 'gold');
          btn.textContent = 'Entered ✦';
          btn.classList.replace('btn-outline', 'btn-ghost');
        } catch (err) {
          AURUM.showToast(err.message || 'Entry failed.', 'error');
          btn.textContent = 'Enter Challenge';
          btn.disabled    = false;
        }
      });
    });

    /* Gold Button */
    document.querySelectorAll('.btn-gold-button').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id      = btn.dataset.challengeId;
        const countEl = btn.querySelector('.gold-count');
        const prev    = parseInt(countEl?.textContent || '0', 10);

        /* Optimistic */
        btn.classList.add('golded');
        btn.disabled = true;
        const svgEl = btn.querySelector('svg');
        if (svgEl) svgEl.setAttribute('fill', '#C9A84C');
        if (countEl) countEl.textContent = prev + 1;

        try {
          await AURUM.ArenaAPI.giveGoldButton(id);
          AURUM.showToast('Gold given! ✦', 'gold');
        } catch (err) {
          /* Roll back */
          btn.classList.remove('golded');
          btn.disabled = false;
          if (svgEl) svgEl.setAttribute('fill', 'none');
          if (countEl) countEl.textContent = prev;
          AURUM.showToast(err.message || 'Could not give gold.', 'error');
        }
      });
    });

    /* Challenge detail */
    document.querySelectorAll('.btn-detail-challenge').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        this.openChallengeDetail(btn.dataset.challengeId);
      });
    });
  },

  async openChallengeDetail(id) {
    const modal   = document.getElementById('challenge-detail-modal');
    const content = document.getElementById('challenge-detail-content');
    modal.style.display = 'flex';

    content.innerHTML = this.skeletons(1);

    try {
      const data = await AURUM.ArenaAPI.getChallenge(id);
      const ch   = data.challenge || data;
      content.innerHTML = this.detailHTML(ch);
      this.bindDetailEvents(ch);
    } catch (err) {
      content.innerHTML = `
        <p style="color:var(--color-text-muted);text-align:center;
          padding:var(--space-8);">Could not load challenge.</p>`;
    }
  },

  detailHTML(ch) {
    const typeIcons = {
      revenue: '💰', deals: '🤝', growth: '📈',
      savings: '🏦', charity: '🏆',
    };
    const displayStatus = this.getDisplayStatus(ch);
    const canEnter       = displayStatus === 'open';

    return `
      <div style="display:flex;align-items:center;gap:var(--space-3);
        margin-bottom:var(--space-5);">
        <div style="font-size:2rem;">${typeIcons[ch.type] || '⚔️'}</div>
        <div>
          <h3 style="font-family:var(--font-display);font-size:var(--text-2xl);
            font-weight:300;color:var(--color-text);">${ch.title}</h3>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);">
            ${ch.type || 'Challenge'} · ${ch.entries || 0} entries
          </p>
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;
        gap:var(--space-3);margin-bottom:var(--space-5);">
        <div class="card card-sm" style="text-align:center;">
          <p class="mono" style="font-size:var(--text-xl);color:var(--color-gold);">
            ${AURUM.formatAmount(ch.pool_amount || 0)}
          </p>
          <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;
            color:var(--color-text-muted);">Pool</p>
        </div>
        <div class="card card-sm" style="text-align:center;">
          <p class="mono" style="font-size:var(--text-xl);color:var(--color-text);">
            ${AURUM.formatAmount(ch.entry_fee || 0)}
          </p>
          <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;
            color:var(--color-text-muted);">Entry</p>
        </div>
        <div class="card card-sm" style="text-align:center;">
          <p class="mono" style="font-size:var(--text-xl);
            color:var(--color-danger);" id="detail-countdown">
            ${this.getTimeLeft(ch.ends_at)}
          </p>
          <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;
            color:var(--color-text-muted);">Remaining</p>
        </div>
      </div>

      ${ch.description ? `
        <p style="font-size:var(--text-sm);color:var(--color-text-muted);
          line-height:1.7;margin-bottom:var(--space-5);">${ch.description}</p>
      ` : ''}

      <!-- Boost section -->
      <div style="padding:var(--space-4);background:var(--color-surface-2);
        border-radius:var(--radius-md);border:1px solid var(--color-border);
        margin-bottom:var(--space-5);">
        <p style="font-size:var(--text-xs);letter-spacing:0.08em;text-transform:uppercase;
          color:var(--color-text-muted);margin-bottom:var(--space-3);">⚡ Boost This Challenge</p>
        <p style="font-size:var(--text-sm);color:var(--color-text-muted);
          margin-bottom:var(--space-3);line-height:1.6;">
          Pin this challenge to the top of The Arena for 24h.
          Deducted from your Aurum Balance.
        </p>
        <div style="display:flex;gap:var(--space-2);margin-bottom:var(--space-3);">
          ${[5, 10, 25].map(amt => `
            <button class="btn-boost-amount btn btn-ghost btn-sm"
              data-amount="${amt}"
              style="flex:1;">₳${amt}</button>
          `).join('')}
        </div>
        <button class="btn btn-outline btn-full btn-sm" id="btn-boost-challenge"
          data-challenge-id="${ch.id}" data-boost-amount="5">
          Boost for ₳<span id="boost-amount-display">5</span>
        </button>
      </div>

      ${canEnter ? `
        <button class="btn btn-primary btn-full btn-enter-challenge-detail"
          data-challenge-id="${ch.id}"
          data-entry-fee="${ch.entry_fee}"
          ${ch.user_joined ? 'disabled' : ''}>
          ${ch.user_joined ? 'Already Entered ✦' : 'Enter — ' + AURUM.formatAmount(ch.entry_fee || 0)}
        </button>
      ` : ''}
    `;
  },

  bindDetailEvents(ch) {
    /* Boost amount selector */
    let selectedBoost = 5;
    document.querySelectorAll('.btn-boost-amount').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.btn-boost-amount')
          .forEach(b => b.classList.replace('btn-primary', 'btn-ghost'));
        btn.classList.replace('btn-ghost', 'btn-primary');
        selectedBoost = parseInt(btn.dataset.amount, 10);
        const display = document.getElementById('boost-amount-display');
        if (display) display.textContent = selectedBoost;
        const boostBtn = document.getElementById('btn-boost-challenge');
        if (boostBtn) boostBtn.dataset.boostAmount = selectedBoost;
      });
    });

    /* Boost submit */
    document.getElementById('btn-boost-challenge')
      ?.addEventListener('click', async (e) => {
        const id     = e.currentTarget.dataset.challengeId;
        const amount = parseInt(e.currentTarget.dataset.boostAmount || '5', 10);
        const btn    = e.currentTarget;
        btn.textContent = 'Boosting...';
        btn.disabled    = true;
        try {
          await AURUM.ArenaAPI.boostChallenge(id, { amount });
          AURUM.showToast(`Challenge boosted for ₳${amount}!`, 'gold');
          document.getElementById('challenge-detail-modal').style.display = 'none';
          this.loadChallenges('active');
        } catch (err) {
          AURUM.showToast(err.message || 'Boost failed.', 'error');
          btn.textContent = `Boost for ₳${amount}`;
          btn.disabled    = false;
        }
      });

    /* Enter from detail */
    document.querySelector('.btn-enter-challenge-detail')
      ?.addEventListener('click', async (btn_el) => {
        const btn = document.querySelector('.btn-enter-challenge-detail');
        const id  = btn.dataset.challengeId;
        btn.textContent = 'Entering...';
        btn.disabled    = true;
        try {
          await AURUM.ArenaAPI.joinChallenge(id);
          AURUM.showToast('You\'re in the Arena.', 'gold');
          btn.textContent = 'Already Entered ✦';
          document.getElementById('challenge-detail-modal').style.display = 'none';
          this.loadChallenges('active');
        } catch (err) {
          AURUM.showToast(err.message || 'Entry failed.', 'error');
          btn.textContent = 'Enter — ' + AURUM.formatAmount(ch.entry_fee || 0);
          btn.disabled    = false;
        }
      });
  },

  /* --------------------------------------------------
     DUELS
  -------------------------------------------------- */
  async loadDuels() {
    const list = document.getElementById('duel-list');
    if (!list) return;
    list.innerHTML = this.skeletons(3);

    try {
      const data  = await AURUM.DuelAPI.getDuels(20, 0);
      const duels = data.duels || [];
      if (!duels.length) {
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">🥊</div>
            <h4>No active duels</h4>
            <p>Challenge someone to a duel.</p>
          </div>`;
        return;
      }
      list.innerHTML = duels.map((d, i) => this.duelHTML(d, i)).join('');
      this.bindDuelEvents();
    } catch (err) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">🥊</div>
          <h4>No active duels</h4>
          <p>Challenge someone to a duel.</p>
        </div>`;
    }
  },

  duelHTML(duel, index) {
    const isActive     = duel.status === 'active';
    const isPending     = duel.status === 'pending';
    const isResolved    = duel.status === 'resolved' || duel.status === 'tied';
    const disputeOpen   = duel.dispute_status === 'window_open';
    const isLoser = !!duel.is_loser;

    const secondsLeft = duel.ends_at
      ? Math.max(0, Math.floor((new Date(duel.ends_at) - new Date()) / 1000))
      : 0;

    const challenger = duel.challenger_username || 'Challenger';
    const opponent   = duel.target_username     || 'Opponent';

    const statusLabel = duel.status === 'tied' ? 'tied — under review' : (duel.status || 'pending');

    return `
      <div class="challenge-card card fade-in" style="animation-delay:${index * 80}ms;">

        <!-- Duel header -->
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span class="badge badge-muted" style="font-size:9px;">
            duel
          </span>
          <span style="font-size:10px;letter-spacing:0.06em;text-transform:uppercase;
            color:${isActive ? 'var(--color-success)' : isResolved
              ? 'var(--color-text-muted)' : 'var(--color-gold)'};">
            ${statusLabel}
          </span>
        </div>

        <p class="challenge-title" style="margin: 0;">${duel.title || 'Untitled Duel'}</p>

        <!-- Combatants -->
        <div style="display:flex;align-items:center;justify-content:space-between;
          padding:var(--space-3);background:var(--color-surface-2);
          border-radius:var(--radius-md);">
          <div style="text-align:center;flex:1;">
            <div class="avatar avatar-sm avatar-gold" style="margin:0 auto var(--space-1);">
              ${challenger.charAt(0).toUpperCase()}
            </div>
            <p style="font-size:var(--text-xs);color:var(--color-text);">${challenger}</p>
          </div>
          <div class="duel-vs-badge">VS</div>
          <div style="text-align:center;flex:1;">
            <div class="avatar avatar-sm" style="margin:0 auto var(--space-1);">
              ${opponent.charAt(0).toUpperCase()}
            </div>
            <p style="font-size:var(--text-xs);color:var(--color-text);">${opponent}</p>
          </div>
        </div>

        ${isResolved && duel.winner_username ? `
          <div style="text-align:center;padding:var(--space-2);color:var(--color-gold);
            font-size:var(--text-sm);">
            🏆 Winner: @${duel.winner_username}
          </div>
        ` : ''}

        <!-- Stake + countdown -->
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-family:var(--font-mono);font-size:var(--text-sm);
            color:var(--color-gold);">
            ${AURUM.formatAmount(duel.duel_tip_amount || 0)} stake
          </span>
          ${isActive ? `
            <span class="duel-countdown mono" style="font-size:var(--text-xs);
              color:var(--color-danger);"
              data-ends="${duel.ends_at}">
              ${AURUM.formatCountdown(secondsLeft)}
            </span>
          ` : ''}
        </div>

        <!-- Action buttons -->
        <div style="display:flex;flex-wrap:wrap;gap:var(--space-2);">

          ${isPending && duel.is_opponent ? `
            <button class="btn btn-primary btn-full btn-sm btn-accept-duel"
              data-duel-id="${duel.id}">Accept</button>
            <button class="btn btn-ghost btn-sm btn-decline-duel"
              data-duel-id="${duel.id}">Decline</button>
          ` : ''}

          ${isActive && duel.duel_type === 'quick' && (duel.is_challenger || duel.is_opponent) ? `
            <button class="btn btn-primary btn-full btn-sm btn-play-quick-duel"
              data-duel-id="${duel.id}"
              data-game-type="${duel.quick_game_type}"
              style="flex:1;">
              ▶ Play Now
            </button>
          ` : ''}

          ${isActive ? `
            <!-- Audience tip buttons — held in escrow, not paid out instantly -->
            <button class="btn btn-ghost btn-sm btn-tip-challenger"
              data-duel-id="${duel.id}"
              data-participant-id="${duel.challenger_id}"
              style="flex:1;">
              Tip ${challenger.split(' ')[0]} ₳1
            </button>
            <button class="btn btn-ghost btn-sm btn-tip-opponent"
              data-duel-id="${duel.id}"
              data-participant-id="${duel.target_id}"
              style="flex:1;">
              Tip ${opponent.split(' ')[0]} ₳1
            </button>

            <!-- Vote buttons — available for the full active window -->
            <button class="btn btn-outline btn-sm btn-vote-duel"
              data-duel-id="${duel.id}"
              data-participant-id="${duel.challenger_id}"
              style="flex:1;">
              Vote ${challenger.split(' ')[0]}
            </button>
            <button class="btn btn-outline btn-sm btn-vote-duel"
              data-duel-id="${duel.id}"
              data-participant-id="${duel.target_id}"
              style="flex:1;">
              Vote ${opponent.split(' ')[0]}
            </button>
          ` : ''}

          ${isLoser ? `
            <button class="btn btn-danger btn-full btn-sm btn-report-duel"
              data-duel-id="${duel.id}"
              style="flex:1;">🚩 Report Cheating</button>
          ` : ''}

          ${isActive && duel.is_challenger ? `
            <button class="btn btn-primary btn-sm btn-announce-duel"
              data-duel-id="${duel.id}"
              style="flex-shrink:0;">📣 Announce</button>
          ` : ''}

        </div>
      </div>
    `;
  },
	
  bindDuelEvents() {
    /* Accept duel */
    document.querySelectorAll('.btn-accept-duel').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.dataset.duelId;
        btn.textContent = 'Accepting...';
        btn.disabled    = true;
        try {
          await AURUM.DuelAPI.acceptDuel(id);
          AURUM.showToast('Duel accepted. Fight on.', 'gold');
          this.loadDuels();
        } catch (err) {
          AURUM.showToast(err.message || 'Could not accept.', 'error');
          btn.textContent = 'Accept';
          btn.disabled    = false;
        }
      });
    });

    /* Decline duel */
    document.querySelectorAll('.btn-decline-duel').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.dataset.duelId;
        try {
          await AURUM.DuelAPI.declineDuel(id);
          AURUM.showToast('Duel declined.', 'default');
          this.loadDuels();
        } catch (err) {
          AURUM.showToast(err.message || 'Could not decline.', 'error');
        }
      });
    });

    /* Audience tips */
    document.querySelectorAll('.btn-tip-challenger, .btn-tip-opponent').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const duelId        = btn.dataset.duelId;
        const participantId = btn.dataset.participantId;
        btn.disabled = true;
        try {
          await AURUM.DuelAPI.tip(duelId, participantId, { amount_usd: 1 });
          AURUM.showToast('Tip sent! ₳1', 'gold');
        } catch (err) {
          AURUM.showToast(err.message || 'Tip failed.', 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });

    /* Vote */
    document.querySelectorAll('.btn-vote-duel').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const duelId        = btn.dataset.duelId;
        const participantId = btn.dataset.participantId;
        btn.textContent = 'Voting...';
        btn.disabled    = true;
        try {
          await AURUM.DuelAPI.vote(duelId, participantId);
          AURUM.showToast('Vote cast.', 'gold');
          /* Disable all vote buttons for this duel */
          document.querySelectorAll(
            `.btn-vote-duel[data-duel-id="${duelId}"]`
          ).forEach(b => { b.disabled = true; });
        } catch (err) {
          AURUM.showToast(err.message || 'Vote failed.', 'error');
          btn.textContent = 'Vote';
          btn.disabled    = false;
        }
      });
    });

    /* Play Quick Duel */
    document.querySelectorAll('.btn-play-quick-duel').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        this.openQuickDuelPlay(btn.dataset.duelId, btn.dataset.gameType);
      });
    });

    /* Announce */
    document.querySelectorAll('.btn-announce-duel').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.dataset.duelId;
        btn.textContent = 'Announcing...';
        btn.disabled    = true;
        try {
          await AURUM.DuelAPI.announce(id);
          AURUM.showToast('Duel announced to the platform!', 'gold');
          btn.textContent = 'Announced ✦';
        } catch (err) {
          AURUM.showToast(err.message || 'Announce failed.', 'error');
          btn.textContent = '📣 Announce';
          btn.disabled    = false;
        }
      });
    });

    /* Live countdown tickers */
    document.querySelectorAll('.duel-countdown[data-ends]').forEach(el => {
      const tick = () => {
        const secs = Math.max(
          0,
          Math.floor((new Date(el.dataset.ends) - new Date()) / 1000)
        );
        el.textContent = AURUM.formatCountdown(secs);
        if (secs > 0) setTimeout(tick, 60000);
        else el.textContent = 'Ended';
      };
      setTimeout(tick, 1000);
    });
  },

  /* FIX: submitDuel now sends the fields the backend actually
     expects — target_username, title, description, duel_tip_amount.
     Previously sent opponent_username, stake_amount, type,
     duration_hours, none of which matched the backend contract,
     and never sent a title at all despite it being required. */
  async submitDuel() {
    const title       = document.getElementById('duel-title')?.value.trim();
    const opponent    = document.getElementById('duel-opponent')?.value.trim();
    const stake       = document.getElementById('duel-stake')?.value;
    const description = document.getElementById('duel-description')?.value.trim();
    const duelFormat  = document.getElementById('duel-format')?.value || 'proof';
    const quickGame   = document.getElementById('duel-quick-game')?.value;
    const btn         = document.getElementById('btn-submit-duel');

    if (!title) {
      AURUM.showToast('Add a duel title.', 'error'); return;
    }
    if (!opponent) {
      AURUM.showToast('Enter opponent username.', 'error'); return;
    }

    btn.textContent = 'Sending...';
    btn.disabled    = true;

    try {
      await AURUM.DuelAPI.createDuel({
        target_username: opponent,
        title,
        description:     description || null,
        duel_tip_amount: parseFloat(stake),
        duel_type:       duelFormat,
        quick_game_type: duelFormat === 'quick' ? quickGame : null,
      });
      document.getElementById('create-duel-modal').style.display = 'none';
      document.getElementById('duel-title').value       = '';
      document.getElementById('duel-opponent').value    = '';
      document.getElementById('duel-description').value = '';
      document.getElementById('duel-format').value       = 'proof';
      document.getElementById('duel-quick-game-group').style.display = 'none';
      AURUM.showToast('Duel challenge sent!', 'gold');
      this.loadDuels();
    } catch (err) {
      AURUM.showToast(err.message || 'Could not create duel.', 'error');
    } finally {
      btn.textContent = 'Challenge';
      btn.disabled    = false;
    }
  },

  /* --------------------------------------------------
     QUICK DUEL — PLAY SCREEN
  -------------------------------------------------- */
  openQuickDuelPlay(duelId, gameType) {
    this.activeQuickDuelId = duelId;
    document.getElementById('qd-play-title').textContent =
      gameType === 'trivia' ? 'Trivia Duel' : 'Reflex Tap';
    document.getElementById('quick-duel-play-modal').style.display = 'flex';
    this.startQuickDuelCountdown(gameType);
  },

  startQuickDuelCountdown(gameType) {
    const area = document.getElementById('qd-play-area');
    const seq  = ['Ready', '3', '2', '1', 'GO'];
    let i = 0;
    area.innerHTML = `<div style="font-size:48px;font-weight:900;color:var(--color-gold);padding:var(--space-8) 0;" id="qd-countdown-num">${seq[0]}</div>`;
    const numEl = document.getElementById('qd-countdown-num');
    const iv = setInterval(() => {
      i++;
      if (i >= seq.length) {
        clearInterval(iv);
        if (gameType === 'trivia') this.runTriviaGame();
        else this.runReflexTapGame();
        return;
      }
      numEl.textContent = seq[i];
    }, 550);
  },

  runReflexTapGame() {
    const area = document.getElementById('qd-play-area');
    let taps = 0;
    let timeLeft = 5;
    area.innerHTML = `
      <p style="color:var(--color-text-muted);margin-bottom:var(--space-2);">Tap as fast as you can!</p>
      <div style="font-size:14px;color:var(--color-danger);margin-bottom:var(--space-3);" id="qd-timer">${timeLeft}s</div>
      <div style="font-size:40px;font-weight:900;color:var(--color-gold);margin-bottom:var(--space-4);" id="qd-tap-count">0</div>
      <button class="btn btn-primary btn-full" id="qd-tap-btn" style="padding:var(--space-6);font-size:18px;">TAP</button>
    `;
    const tapBtn  = document.getElementById('qd-tap-btn');
    const countEl = document.getElementById('qd-tap-count');
    const timerEl = document.getElementById('qd-timer');

    tapBtn.addEventListener('click', () => {
      taps++;
      countEl.textContent = taps;
    });

    const iv = setInterval(() => {
      timeLeft--;
      timerEl.textContent = `${timeLeft}s`;
      if (timeLeft <= 0) {
        clearInterval(iv);
        tapBtn.disabled = true;
        this.finishQuickDuelGame(taps);
      }
    }, 1000);
  },

  runTriviaGame() {
    this.qdTriviaIndex   = 0;
    this.qdTriviaCorrect = 0;
    this.qdTriviaStartTime = Date.now();
    this.renderTriviaQuestion();
  },

  renderTriviaQuestion() {
    const area = document.getElementById('qd-play-area');
    const q    = this.TRIVIA_QUESTIONS[this.qdTriviaIndex];
    area.innerHTML = `
      <p style="color:var(--color-text-muted);font-size:12px;margin-bottom:var(--space-2);">Question ${this.qdTriviaIndex + 1} of ${this.TRIVIA_QUESTIONS.length}</p>
      <p style="font-weight:700;font-size:15px;margin-bottom:var(--space-4);">${q.q}</p>
      <div style="display:flex;flex-direction:column;gap:var(--space-2);">
        ${q.options.map((opt, idx) => `
          <button class="btn btn-outline btn-full qd-trivia-option" data-idx="${idx}">${opt}</button>
        `).join('')}
      </div>
    `;
    document.querySelectorAll('.qd-trivia-option').forEach(btn => {
      btn.addEventListener('click', () => this.answerTriviaQuestion(parseInt(btn.dataset.idx, 10)));
    });
  },

  answerTriviaQuestion(idx) {
    const q = this.TRIVIA_QUESTIONS[this.qdTriviaIndex];
    if (idx === q.correct) this.qdTriviaCorrect++;
    this.qdTriviaIndex++;

    if (this.qdTriviaIndex >= this.TRIVIA_QUESTIONS.length) {
      const elapsedSeconds = (Date.now() - this.qdTriviaStartTime) / 1000;
      // Speed bonus baked into one score number: each correct answer is
      // worth 100 points, minus total seconds taken, floored at 0.
      const rawScore = this.qdTriviaCorrect * 100 - Math.floor(elapsedSeconds);
      this.finishQuickDuelGame(Math.max(0, rawScore));
    } else {
      this.renderTriviaQuestion();
    }
  },

  finishQuickDuelGame(score) {
    const area = document.getElementById('qd-play-area');
    area.innerHTML = `<p style="color:var(--color-text-muted);">Submitting your score...</p>`;
    this.submitQuickDuelScore(this.activeQuickDuelId, score);
  },

  async submitQuickDuelScore(duelId, score) {
    const area = document.getElementById('qd-play-area');
    try {
      const result = await AURUM.DuelAPI.submitScore(duelId, score);

      if (result.waiting_on_opponent) {
        area.innerHTML = `
          <div style="font-size:32px;margin-bottom:var(--space-2);">⏳</div>
          <p style="font-weight:700;">Score submitted: ${score}</p>
          <p style="color:var(--color-text-muted);font-size:13px;margin-top:var(--space-2);">Waiting on your opponent to finish...</p>
          <button class="btn btn-ghost btn-full" style="margin-top:var(--space-4);" onclick="document.getElementById('quick-duel-play-modal').style.display='none';">Close</button>
        `;
      } else if (result.tied) {
        area.innerHTML = `
          <div style="font-size:32px;margin-bottom:var(--space-2);">🤝</div>
          <p style="font-weight:700;">It's a tie!</p>
          <p style="color:var(--color-text-muted);font-size:13px;margin-top:var(--space-2);">Sent to admin review to decide the winner.</p>
          <button class="btn btn-primary btn-full" style="margin-top:var(--space-4);" onclick="document.getElementById('quick-duel-play-modal').style.display='none';">Close</button>
        `;
      } else {
        const myUserId = AURUM.ProfileCache.get()?.id;
        const won      = result.winner_id === myUserId;
        area.innerHTML = `
          <div style="font-size:32px;margin-bottom:var(--space-2);">${won ? '🏆' : '💔'}</div>
          <p style="font-weight:700;font-size:18px;color:${won ? 'var(--color-gold)' : 'var(--color-text)'};">${won ? 'You Won!' : 'You Lost'}</p>
          <p style="color:var(--color-text-muted);font-size:13px;margin-top:var(--space-2);">
            ${result.challenger_score} - ${result.target_score}
          </p>
          <button class="btn btn-primary btn-full" style="margin-top:var(--space-4);" onclick="document.getElementById('quick-duel-play-modal').style.display='none';">Close</button>
        `;
        this.loadDuels();
      }
    } catch (err) {
      area.innerHTML = `
        <p style="color:var(--color-danger);">${err.message || 'Could not submit score.'}</p>
        <button class="btn btn-ghost btn-full" style="margin-top:var(--space-4);" onclick="document.getElementById('quick-duel-play-modal').style.display='none';">Close</button>
      `;
    }
  },

  /* --------------------------------------------------
     CREWS
  -------------------------------------------------- */
  async loadCrews() {
    const list = document.getElementById('crew-list');
    if (!list) return;
    list.innerHTML = this.skeletons(3);

    try {
      const data  = await AURUM.CrewAPI.getCrews(20, 0);
      const crews = data.crews || [];
      if (!crews.length) {
        list.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">⚔️</div>
            <h4>No crews yet</h4>
            <p>Create the first crew.</p>
          </div>`;
        return;
      }
      list.innerHTML = crews.map((c, i) => this.crewHTML(c, i)).join('');
      this.bindCrewEvents();
    } catch (err) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">⚔️</div>
          <h4>No crews yet</h4>
          <p>Create the first crew.</p>
        </div>`;
    }
  },

  crewHTML(crew, index) {
    return `
      <div class="challenge-card card fade-in" style="animation-delay:${index * 80}ms;">
        <div class="challenge-top" ${crew.user_member ? `style="cursor:pointer;" data-crew-chat-id="${crew.id}" data-crew-chat-name="${this.escapeHTML(crew.name)}"` : ''}>
          <div class="challenge-icon">⚔️</div>
          <div class="challenge-info">
            <p class="challenge-title">${crew.name}</p>
			<div class="challenge-meta">
              <span class="badge badge-muted" style="font-size:9px;">
                ${crew.member_count || 0} members
              </span>
            </div>
          </div>
        </div>
        ${crew.description ? `
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);
            line-height:1.6;">${crew.description}</p>
        ` : ''}
        <div style="display:flex;gap:var(--space-2);">
          <button class="btn btn-outline btn-full btn-sm btn-join-crew"
            data-crew-id="${crew.id}"
            ${crew.user_member ? 'disabled' : ''}>
            ${crew.user_member ? 'Member ✦' : 'Join Crew'}
          </button>
          ${crew.user_member ? `
            <button class="btn btn-ghost btn-sm btn-chat-crew"
              data-crew-id="${crew.id}"
              data-crew-name="${crew.name}"
              style="flex-shrink:0;">💬 Chat</button>
            <button class="btn btn-ghost btn-sm btn-battle-crew"
              data-crew-id="${crew.id}"
              style="flex-shrink:0;">⚔️ Battle</button>
          ` : ''}
        </div>
      </div>
    `;
  },

  bindCrewEvents() {
    document.querySelectorAll('.btn-join-crew').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', async () => {
        const id = btn.dataset.crewId;
        btn.textContent = 'Joining...';
        btn.disabled    = true;
        try {
          await AURUM.CrewAPI.joinCrew(id);
          AURUM.showToast('Crew joined!', 'gold');
          btn.textContent = 'Member ✦';
        } catch (err) {
          AURUM.showToast(err.message || 'Could not join.', 'error');
          btn.textContent = 'Join Crew';
          btn.disabled    = false;
        }
      });
    });

    document.querySelectorAll('.btn-battle-crew').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        this.activeBattleCrewId = btn.dataset.crewId;
        document.getElementById('crew-battle-title').value = '';
        document.getElementById('crew-battle-target').value = '';
        document.getElementById('create-crew-battle-modal').style.display = 'flex';
      });
    });

    document.querySelectorAll('.btn-chat-crew').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        this.openCrewChat(btn.dataset.crewId, btn.dataset.crewName);
      });
    });
    document.querySelectorAll('[data-crew-detail-id]').forEach(el => {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('click', () => {
        this.openCrewDetail(el.dataset.crewDetailId);
      });
    });
	  document.querySelectorAll('[data-crew-chat-id]').forEach(el => {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      el.addEventListener('click', () => {
        this.openCrewChat(el.dataset.crewChatId, el.dataset.crewChatName);
      });
    });
  },

/* --------------------------------------------------
     CREW CHAT
  -------------------------------------------------- */
  activeChatCrewId: null,
  chatSocket:       null,
  crewMemberNames:  {},
  async openCrewDetail(crewId) {
    const modal = document.getElementById('crew-detail-modal');
    const body  = document.getElementById('crew-detail-body');
    document.getElementById('crew-detail-title').textContent = 'Loading...';
    body.innerHTML = '';
    modal.style.display = 'flex';
    try {
      const { crew } = await AURUM.CrewAPI.getCrew(crewId);
      document.getElementById('crew-detail-title').textContent = crew.name;
      let me = AURUM.ProfileCache.get();
      if (!me) {
        try { me = (await AURUM.AuthAPI.me()).user; } catch { me = null; }
      }
      const myMembership = (crew.members || []).find(m => m.user_id === me?.id);
      const isCaptain = myMembership?.role === 'captain';
      const isModerator = myMembership?.role === 'moderator';
      this.activeDetailCrewId = crewId;
      const membersHTML = (crew.members || []).map(m => {
        const canPromote = isCaptain && m.user_id !== me?.id && m.role !== 'captain';
        const canMute    = (isCaptain || isModerator) && m.user_id !== me?.id && m.role !== 'captain';
        const canKick    = isCaptain && m.user_id !== me?.id && m.role !== 'captain';
        const actionable = canPromote || canMute || canKick;
        return `
        <div class="${actionable ? 'btn-member-row' : ''}"
          style="display:flex;justify-content:space-between;align-items:center;
            padding:var(--space-2) 0;border-bottom:1px solid var(--color-border);${actionable ? 'cursor:pointer;' : ''}"
          ${actionable ? `data-user-id="${m.user_id}" data-username="${this.escapeHTML(m.username)}" data-role="${m.role}" data-can-promote="${canPromote}" data-can-mute="${canMute}" data-can-kick="${canKick}"` : ''}>
          <div style="display:flex;align-items:center;gap:var(--space-2);">
            <div class="avatar avatar-sm" style="width:24px;height:24px;font-size:11px;">${AURUM.avatarInnerHTML(m.avatar_url, this.escapeHTML(m.username).charAt(0).toUpperCase())}</div>
            <span>${this.escapeHTML(m.username)}</span>
          </div>
          <div style="display:flex;gap:var(--space-2);align-items:center;">
            <span class="badge badge-muted" style="font-size:9px;">${m.role}</span>
            ${actionable ? `<span style="color:var(--color-text-muted);font-size:11px;">›</span>` : ''}
          </div>
        </div>
      `;
      }).join('');
      body.innerHTML = `
        ${crew.description ? `
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);
            line-height:1.6;margin-bottom:var(--space-3);">${this.escapeHTML(crew.description)}</p>
        ` : ''}
        <div class="crew-status-strip">
          <span class="crew-status-pill">${crew.member_count || 0} Members</span>
          <span class="crew-status-pill ${crew.is_locked ? 'crew-status-pill-locked' : 'crew-status-pill-open'}">
            ${crew.is_locked ? '🔒 Locked' : '🔓 Open'}
          </span>
          ${crew.is_frozen ? `<span class="crew-status-pill crew-status-pill-frozen">⚠ Frozen</span>` : ''}
        </div>

        <div class="crew-action-row">
          ${myMembership && !isCaptain ? `
            <button class="btn btn-outline btn-sm" id="btn-detail-leave">Leave Crew</button>
          ` : ''}
          ${isCaptain ? `
            <button class="btn btn-outline btn-sm" id="btn-detail-toggle-lock" data-locked="${crew.is_locked ? '1' : '0'}">
              ${crew.is_locked ? 'Unlock Crew' : 'Lock Crew'}
            </button>
          ` : ''}
        </div>

        ${isCaptain ? `
          <div class="crew-danger-zone">
            <p class="crew-danger-zone-label">Danger Zone</p>
            <button class="btn btn-danger btn-sm btn-full" id="btn-detail-disband">Disband Crew</button>
          </div>
        ` : ''}
        <div style="margin-bottom:var(--space-3);">
          <p style="font-size:var(--text-xs);color:var(--color-text-muted);
            text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-1);">Crew Wallet</p>
          <p class="mono" style="font-size:var(--text-lg);">$${(crew.balance_usd || 0).toFixed(2)}</p>
          ${isCaptain ? `<button class="btn btn-outline btn-sm" id="btn-detail-new-spend" style="margin-top:var(--space-1);">Request Spend</button>` : ''}
        </div>
                <div style="margin-bottom:var(--space-3);">
          <p style="font-size:var(--text-xs);color:var(--color-text-muted);
            text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-1);">Wallet Activity</p>
          <div id="crew-detail-transactions"><p style="font-size:var(--text-sm);color:var(--color-text-muted);">Loading...</p></div>
        </div>
        <div id="crew-detail-battle-section"></div>
        <div class="crew-rules-block">
          <div class="crew-rules-header">
            <p class="crew-rules-label">✦ Crew Codex</p>
            ${isCaptain ? `<button class="btn btn-ghost btn-sm" id="btn-detail-edit-rules">Edit</button>` : ''}
          </div>
          ${crew.rules ? `<p class="crew-rules-text">${this.escapeHTML(crew.rules)}</p>` : `<p class="crew-rules-empty">No rules set yet.</p>`}
          <div id="crew-detail-rules-form" style="display:none;margin-top:var(--space-2);">
            <textarea class="input" id="rules-textarea" maxlength="2000" rows="4" style="width:100%;margin-bottom:var(--space-2);" placeholder="Crew rules (2000 char max)">${crew.rules ? this.escapeHTML(crew.rules) : ''}</textarea>
            <div style="display:flex;gap:var(--space-2);">
              <button class="btn btn-primary btn-sm" id="btn-save-rules">Save</button>
              <button class="btn btn-ghost btn-sm" id="btn-cancel-rules">Cancel</button>
            </div>
          </div>
        </div>
        <div>
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-1);">
          <p style="font-size:var(--text-xs);color:var(--color-text-muted);
            text-transform:uppercase;letter-spacing:0.06em;">Members</p>
          <button class="btn btn-ghost btn-sm" id="btn-detail-open-chat">💬 Chat</button>
        </div>
        <div>
          ${membersHTML}
        </div>
      `;
      document.getElementById('btn-detail-open-chat')
        ?.addEventListener('click', () => {
          modal.style.display = 'none';
          this.openCrewChat(crewId, crew.name);
        });
      document.querySelectorAll('.btn-member-row').forEach(row => {
        row.addEventListener('click', () => {
          this.activeActionCrewId  = crewId;
          this.activeActionUserId  = row.dataset.userId;
          this.activeActionUsername = row.dataset.username;
          const isMod = row.dataset.role === 'moderator';
          document.getElementById('member-action-title').textContent = row.dataset.username;
          const promoteBtn = document.getElementById('btn-action-promote');
          promoteBtn.style.display = row.dataset.canPromote === 'true' ? 'block' : 'none';
          promoteBtn.textContent = isMod ? 'Demote to Member' : 'Promote to Moderator';
          promoteBtn.dataset.makeMod = isMod ? 'false' : 'true';
          document.getElementById('btn-action-mute').style.display = row.dataset.canMute === 'true' ? 'block' : 'none';
          document.getElementById('btn-action-kick').style.display = row.dataset.canKick === 'true' ? 'block' : 'none';
          document.getElementById('member-action-modal').style.display = 'flex';
        });
      });
      this.loadCrewWalletTransactions(crewId, myMembership?.role);
      this.loadCrewBattleSection(crewId, me?.id);
      document.getElementById('btn-detail-new-spend')
        ?.addEventListener('click', () => {
          this.activeSpendCrewId = crewId;
          document.getElementById('spend-amount-input').value = '';
          document.getElementById('spend-reason-input').value = '';
          document.getElementById('request-spend-modal').style.display = 'flex';
        });
      document.getElementById('btn-detail-leave')
        ?.addEventListener('click', async () => {
          if (!confirm('Leave this crew?')) return;
          try {
            await AURUM.CrewAPI.leaveCrew();
            AURUM.showToast('You left the crew.', 'default');
            modal.style.display = 'none';
            this.loadCrews();
          } catch (err) {
            AURUM.showToast(err.message || 'Could not leave crew.', 'error');
          }
        });
      document.getElementById('btn-detail-toggle-lock')
        ?.addEventListener('click', async (e) => {
          const nowLocked = e.target.dataset.locked === '1';
          try {
            await AURUM.CrewAPI.setLocked(crewId, !nowLocked);
            AURUM.showToast(nowLocked ? 'Crew unlocked.' : 'Crew locked.', 'default');
            this.openCrewDetail(crewId);
          } catch (err) {
            AURUM.showToast(err.message || 'Could not update lock status.', 'error');
          }
        });
      document.getElementById('btn-detail-disband')
        ?.addEventListener('click', async () => {
          const typed = prompt(`This permanently deletes "${crew.name}" and splits the crew wallet among members. Type the crew name to confirm.`);
          if (typed !== crew.name) {
            if (typed !== null) AURUM.showToast('Crew name did not match. Disband cancelled.', 'error');
            return;
          }
          try {
            const result = await AURUM.CrewAPI.disbandCrew(crewId);
            AURUM.showToast(`Crew disbanded. $${(result.total_split_usd || 0).toFixed(2)} split among ${result.members_paid} member(s).`, 'default');
            modal.style.display = 'none';
            this.loadCrews();
          } catch (err) {
            AURUM.showToast(err.message || 'Could not disband crew.', 'error');
          }
        });
      document.getElementById('btn-detail-edit-rules')
        ?.addEventListener('click', () => {
          const form = document.getElementById('crew-detail-rules-form');
          form.style.display = form.style.display === 'none' ? 'block' : 'none';
        });
      document.getElementById('btn-cancel-rules')
        ?.addEventListener('click', () => {
          document.getElementById('crew-detail-rules-form').style.display = 'none';
        });
      document.getElementById('btn-save-rules')
        ?.addEventListener('click', async () => {
          const rules = document.getElementById('rules-textarea').value.trim();
          if (rules.length > 2000) return AURUM.showToast('Rules must be 2000 characters or less.', 'error');
          try {
            await AURUM.CrewAPI.setRules(crewId, rules);
            AURUM.showToast('Rules updated.', 'default');
            this.openCrewDetail(crewId);
          } catch (err) {
            AURUM.showToast(err.message || 'Could not update rules.', 'error');
          }
        });
      } catch (err) {
      body.innerHTML = `<p style="color:var(--color-danger);">Failed to load crew.</p>`;
      AURUM.showToast(err.message || 'Could not load crew.', 'error');
    }
  },
  async loadCrewWalletTransactions(crewId, myRole) {
    const container = document.getElementById('crew-detail-transactions');
    if (!container) return;
    try {
      const { transactions } = await AURUM.CrewAPI.getWalletTransactions(crewId);
      if (!transactions || !transactions.length) {
        container.innerHTML = `<p style="font-size:var(--text-sm);color:var(--color-text-muted);">No activity yet.</p>`;
        return;
      }
      container.innerHTML = transactions.map(t => {
        const statusColor = t.status === 'executed' ? 'var(--color-text-muted)'
          : t.status === 'vetoed' ? 'var(--color-danger)' : 'var(--color-gold, orange)';
        const canAct = myRole === 'moderator' && t.status === 'pending_cosign';
        const canFlag = myRole === 'member' && t.status === 'executed';
        return `
          <div style="padding:var(--space-2) 0;border-bottom:1px solid var(--color-border);${canAct ? 'cursor:pointer;' : ''}"
            ${canAct ? `class="btn-review-cosign" data-txn-id="${t.id}" data-amount="${t.amount_usd}" data-reason="${this.escapeHTML(t.reason || '')}" data-by="${this.escapeHTML(t.initiated_by_username || 'unknown')}" data-required="${t.required_cosigns}"` : ''}>
            <div style="display:flex;justify-content:space-between;">
              <span class="mono">-$${t.amount_usd.toFixed(2)}</span>
              <span style="font-size:10px;color:${statusColor};text-transform:uppercase;">${t.status.replace('_', ' ')}</span>
            </div>
            <p style="font-size:var(--text-sm);color:var(--color-text-muted);">${this.escapeHTML(t.reason || '')}</p>
            <p style="font-size:11px;color:var(--color-text-muted);">by ${this.escapeHTML(t.initiated_by_username || 'unknown')}${t.status === 'pending_cosign' ? ` · needs ${t.required_cosigns} co-sign(s)` : ''}</p>
            ${canAct ? `<p style="font-size:11px;color:var(--color-gold);margin-top:var(--space-1);">Tap to review ›</p>` : ''}
            ${canFlag ? `
              <button class="btn btn-ghost btn-sm btn-flag-spend" data-txn-id="${t.id}" style="margin-top:var(--space-1);">Flag this spend</button>
            ` : ''}
          </div>
        `;
      }).join('');
      document.querySelectorAll('.btn-review-cosign').forEach(row => {
        row.addEventListener('click', () => {
          this.activeCosignTxnId  = row.dataset.txnId;
          this.activeCosignCrewId = crewId;
          this.activeCosignMyRole = myRole;
          document.getElementById('cosign-requested-by').textContent = row.dataset.by;
          document.getElementById('cosign-reason').textContent = row.dataset.reason || '—';
          document.getElementById('cosign-amount').textContent = '$' + parseFloat(row.dataset.amount).toFixed(2);
          document.getElementById('cosign-veto-reason-input').value = '';
          document.getElementById('cosign-status-note').textContent =
            `Requires ${row.dataset.required} moderator co-sign(s) to release funds.`;
          document.getElementById('cosign-request-modal').style.display = 'flex';
        });
      });
      document.querySelectorAll('.btn-flag-spend').forEach(btn => {
        btn.addEventListener('click', async () => {
          const reason = prompt('Why are you flagging this spend?');
          if (!reason || !reason.trim()) return;
          try {
            await AURUM.CrewAPI.flagSpend(btn.dataset.txnId, reason.trim());
            AURUM.showToast('Spend flagged for admin review.', 'default');
            this.loadCrewWalletTransactions(crewId, myRole);
          } catch (err) {
            AURUM.showToast(err.message || 'Could not flag spend.', 'error');
          }
        });
      });
        } catch (err) {
      container.innerHTML = `<p style="color:var(--color-danger);font-size:var(--text-sm);">Failed to load activity.</p>`;
    }
  },

  async loadCrewBattleSection(crewId, myUserId) {
    const container = document.getElementById('crew-detail-battle-section');
    if (!container) return;
    try {
      const { battle } = await AURUM.CrewAPI.getActiveBattle(crewId);
      if (!battle) { container.innerHTML = ''; return; }
      this.activeCrewBattle = battle;
      const isChallengerSide = battle.challenger_crew_id === crewId;
      const usName   = isChallengerSide ? battle.challenger_crew_name : battle.target_crew_name;
      const themName = isChallengerSide ? battle.target_crew_name     : battle.challenger_crew_name;
      const usPct    = isChallengerSide ? battle.challenger_pct       : battle.target_pct;
      const themPct  = isChallengerSide ? battle.target_pct           : battle.challenger_pct;
      container.innerHTML = `
        <div style="margin-bottom:var(--space-3);">
          <p style="font-size:var(--text-xs);color:var(--color-text-muted);
            text-transform:uppercase;letter-spacing:0.06em;margin-bottom:var(--space-1);">Crew Battle</p>
          <div class="card card-sm">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:var(--space-2);">
              <span style="font-weight:700;">${this.escapeHTML(usName)} <span style="color:var(--color-text-muted);">vs</span> ${this.escapeHTML(themName)}</span>
              <span class="badge badge-muted" style="font-size:9px;">${battle.status === 'pending' ? 'Voting Open' : battle.status}</span>
            </div>
            <p style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:var(--space-2);">${this.escapeHTML(battle.title)} · ${battle.total_votes} vote(s)</p>
            <div style="display:flex;gap:2px;height:8px;border-radius:4px;overflow:hidden;margin-bottom:var(--space-2);">
              <div style="width:${usPct}%;background:var(--color-gold);"></div>
              <div style="width:${themPct}%;background:var(--color-surface-2);"></div>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--color-text-muted);margin-bottom:var(--space-3);">
              <span>${this.escapeHTML(usName)}: ${usPct}%</span>
              <span>${this.escapeHTML(themName)}: ${themPct}%</span>
            </div>
            ${battle.can_vote ? `
              <button class="btn btn-outline btn-full btn-sm" id="btn-open-battle-vote">
                ${battle.my_vote ? 'Change Your Vote' : 'Cast Your Vote'}
              </button>
            ` : `<p style="font-size:11px;color:var(--color-text-muted);">Members of either crew cannot vote on this battle.</p>`}
          </div>
        </div>
      `;
      document.getElementById('btn-open-battle-vote')
        ?.addEventListener('click', () => this.openBattleVoteSheet(crewId, myUserId));
    } catch (err) {
      container.innerHTML = '';
    }
  },

  openBattleVoteSheet(crewId, myUserId) {
    const battle = this.activeCrewBattle;
    if (!battle) return;
    this.activeVoteCrewId = crewId;
    this.activeVoteUserId = myUserId;
    document.getElementById('battle-vote-title').textContent = battle.title;
    document.getElementById('battle-vote-option-a').dataset.crewId = battle.challenger_crew_id;
    document.getElementById('battle-vote-option-a-label').textContent = battle.challenger_crew_name;
    document.getElementById('battle-vote-option-a-pct').textContent = battle.challenger_pct + '%';
    document.getElementById('battle-vote-option-b').dataset.crewId = battle.target_crew_id;
    document.getElementById('battle-vote-option-b-label').textContent = battle.target_crew_name;
    document.getElementById('battle-vote-option-b-pct').textContent = battle.target_pct + '%';
    document.getElementById('battle-vote-status').textContent =
      battle.my_vote ? 'You already voted — tap to change your vote' : 'Tap a crew to cast your vote';
    document.getElementById('battle-vote-modal').style.display = 'flex';
  },

  async castBattleVote(votedCrewId) {
    const battle = this.activeCrewBattle;
    if (!battle) return;
    try {
      await AURUM.CrewAPI.voteBattle(battle.id, votedCrewId);
      AURUM.showToast('Vote recorded.', 'gold');
      document.getElementById('battle-vote-modal').style.display = 'none';
      this.loadCrewBattleSection(this.activeVoteCrewId, this.activeVoteUserId);
    } catch (err) {
      AURUM.showToast(err.message || 'Could not cast vote.', 'error');
    }
  },

  async openCrewChat(crewId, crewName) {
    this.activeChatCrewId = crewId;
    document.getElementById('crew-chat-title').textContent = crewName || 'Crew Chat';
    document.getElementById('crew-chat-modal').style.display = 'flex';
    document.getElementById('btn-open-crew-profile-from-chat').onclick = () => {
      document.getElementById('crew-chat-modal').style.display = 'none';
      this.closeCrewChat();
      this.openCrewDetail(crewId);
    };

    const list = document.getElementById('crew-chat-messages');
    list.innerHTML = '<p style="text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Loading...</p>';

    /* Build id -> username lookup so messages can show real names */
    this.crewMemberNames = {};
    this.crewMemberAvatars = {};
    try {
      const crewData = await AURUM.CrewAPI.getCrew(crewId);
      const members = crewData.crew?.members || [];
      members.forEach(m => {
        if (m.user_id && m.username) this.crewMemberNames[m.user_id] = m.username;
        if (m.user_id) this.crewMemberAvatars[m.user_id] = m.avatar_url;
      });
    } catch (err) {
      /* Non-fatal — chat still works, just shows raw IDs if this fails */
    }

    try {
      const data = await AURUM.CrewAPI.getMessages(crewId);
      const messages = (data.messages || []).slice().reverse();
      this.crewMessageReactions = {};
      try {
        const reactData = await AURUM.CrewAPI.getReactions(messages.map(m => m.id));
        this.crewMessageReactions = reactData.reactions || {};
      } catch (err) {
        /* Non-fatal — messages still show, just without reaction counts if this fails */
      }
      this.renderCrewMessages(messages);
    } catch (err) {
      list.innerHTML = '<p style="text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">Could not load messages.</p>';
    }

    this.connectCrewChatSocket(crewId);
    this.wireCrewReactionHandlers();
    this.wireCrewSwipeToReply();
  },
  wireCrewReactionHandlers() {
    const list = document.getElementById('crew-chat-messages');
    if (!list || list.dataset.reactionsWired) return;
    list.dataset.reactionsWired = '1';
    list.addEventListener('click', async (e) => {
      const pill = e.target.closest('.reaction-pill');
      const addBtn = e.target.closest('.reaction-add-btn');
      if (pill) {
        const messageId = pill.dataset.messageId;
        const emoji = pill.dataset.emoji;
        const isActive = pill.classList.contains('reaction-pill-active');
        try {
          if (isActive) {
            await AURUM.CrewAPI.removeReaction(messageId);
          } else {
            await AURUM.CrewAPI.reactToMessage(messageId, emoji);
          }
          await this.refreshCrewReactions();
        } catch (err) {
          AURUM.showToast(err.message || 'Could not react.', 'error');
        }
        return;
      }
      if (addBtn) {
        const messageId = addBtn.dataset.messageId;
        this.openCrewEmojiPicker(addBtn, messageId);
      }
    });
  },
	wireCrewSwipeToReply() {
    const list = document.getElementById('crew-chat-messages');
    if (!list || list.dataset.swipeWired) return;
    list.dataset.swipeWired = '1';
    let swipe = null;
    list.addEventListener('touchstart', (e) => {
      const bubble = e.target.closest('.chat-message');
      if (!bubble) return;
      swipe = { bubble, startX: e.touches[0].clientX };
    }, { passive: true });
    list.addEventListener('touchmove', (e) => {
      if (!swipe) return;
      const dx = e.touches[0].clientX - swipe.startX;
      const clamped = Math.max(0, Math.min(dx, 70));
      swipe.currentX = clamped;
      swipe.bubble.style.transform = `translateX(${clamped}px)`;
      swipe.bubble.classList.toggle('swipe-armed', clamped > 45);
    }, { passive: true });
    const endSwipe = () => {
      if (!swipe) return;
      swipe.bubble.style.transform = '';
      swipe.bubble.classList.remove('swipe-armed');
      if (swipe.currentX > 45) {
        this.startCrewReply(swipe.bubble.dataset.messageId);
      }
      swipe = null;
    };
    list.addEventListener('touchend', endSwipe);
    list.addEventListener('touchcancel', endSwipe);
  },

  startCrewReply(messageId) {
    const bubble = document.querySelector(`#crew-chat-messages [data-message-id="${messageId}"]`);
    if (!bubble) return;
    const sender = bubble.querySelector('.chat-message-sender')?.textContent || 'Someone';
    const text = bubble.querySelector('.chat-message-text')?.textContent || '';
    this.replyingToCrewMessage = { id: messageId, sender, text: text.slice(0, 80) };
    this.renderCrewReplyBar();
  },

  renderCrewReplyBar() {
    const container = document.getElementById('crew-chat-reply-bar-container');
    if (!container) return;
    if (!this.replyingToCrewMessage) { container.innerHTML = ''; return; }
    const r = this.replyingToCrewMessage;
    container.innerHTML = `
      <div class="reply-preview-bar">
        <div class="reply-preview-content">
          <span class="reply-preview-label">Replying to ${this.escapeHTML(r.sender)}</span>
          <span class="reply-preview-text">${this.escapeHTML(r.text)}</span>
        </div>
        <button class="reply-preview-cancel" id="btn-cancel-crew-reply">&times;</button>
      </div>
    `;
    document.getElementById('btn-cancel-crew-reply')?.addEventListener('click', () => {
      this.replyingToCrewMessage = null;
      this.renderCrewReplyBar();
    });
  },

  openCrewEmojiPicker(anchorEl, messageId) {
    document.querySelectorAll('.reaction-picker-popup').forEach(p => p.remove());
    const emojiList = ['🔥', '👑', '💰', '⚔️', '😂', '🖤'];
    const popup = document.createElement('div');
    popup.className = 'reaction-picker-popup';
    popup.style.cssText = 'position:absolute;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:4px 6px;display:flex;gap:4px;z-index:1000;';
    popup.innerHTML = emojiList.map(e => `<span data-emoji="${e}" style="cursor:pointer;font-size:16px;padding:2px;">${e}</span>`).join('');
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = `${window.scrollY + rect.bottom + 4}px`;
    popup.style.left = `${window.scrollX + rect.left}px`;
    popup.querySelectorAll('span').forEach(span => {
      span.addEventListener('click', async () => {
        popup.remove();
        try {
          await AURUM.CrewAPI.reactToMessage(messageId, span.dataset.emoji);
          await this.refreshCrewReactions();
        } catch (err) {
          AURUM.showToast(err.message || 'Could not react.', 'error');
        }
      });
    });
    setTimeout(() => {
      document.addEventListener('click', function closePopup(ev) {
        if (!popup.contains(ev.target) && ev.target !== anchorEl) {
          popup.remove();
          document.removeEventListener('click', closePopup);
        }
      });
    }, 0);
  },
  async refreshCrewReactions() {
    const list = document.getElementById('crew-chat-messages');
    if (!list) return;
    const messageIds = [...list.querySelectorAll('[data-message-id]')].map(el => el.dataset.messageId);
    if (!messageIds.length) return;
    try {
      const reactData = await AURUM.CrewAPI.getReactions(messageIds);
      this.crewMessageReactions = reactData.reactions || {};
      list.querySelectorAll('.reaction-bar').forEach(bar => {
        const messageId = bar.closest('[data-message-id]')?.dataset.messageId;
        if (messageId) bar.outerHTML = this.reactionBarHTML(messageId, (this.crewMessageReactions[messageId] || {}));
      });
    } catch (err) {
      /* Non-fatal — reaction counts just won't refresh */
    }
  },
	
  connectCrewChatSocket(crewId) {
    if (this.chatSocket) {
      this.chatSocket.close();
      this.chatSocket = null;
    }

    const token = AURUM.Auth.getToken();
    if (!token) return;

    const wsBase = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');
    this.chatSocket = new WebSocket(`${wsBase}/api/crews/${crewId}/ws?token=${encodeURIComponent(token)}`);

    this.chatSocket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'reaction') {
          this.refreshCrewReactions();
        } else {
          this.appendCrewMessage(msg);
        }
      } catch (err) {
        /* ignore malformed message */
      }
    });

    this.chatSocket.addEventListener('close', () => {
      this.chatSocket = null;
    });
  },

  closeCrewChat() {
    if (this.chatSocket) {
      this.chatSocket.close();
      this.chatSocket = null;
    }
    this.activeChatCrewId = null;
  },

  renderCrewMessages(messages) {
    const list = document.getElementById('crew-chat-messages');
    if (!list) return;
    if (!messages.length) {
      list.innerHTML = '<p style="text-align:center;color:var(--color-text-muted);font-size:var(--text-sm);">No messages yet. Say something.</p>';
      return;
    }
    list.innerHTML = messages.map(m => this.crewMessageHTML(m)).join('');
    list.scrollTop = list.scrollHeight;
  },

  crewMessageHTML(m) {
    const text = m.deleted ? '<em>Message removed</em>' : this.escapeHTML(m.content);
    const isMe = m.sender_id === AURUM.ProfileCache.get()?.id;
    const senderLabel = isMe ? 'You' : (this.crewMemberNames[m.sender_id] || m.sender_id);
    const senderAvatar = this.crewMemberAvatars?.[m.sender_id];
    const reactions = (this.crewMessageReactions && this.crewMessageReactions[m.id]) || {};
    const replyHTML = m.reply_to ? `
      <div class="reply-quote">
        <span class="reply-quote-sender">${this.escapeHTML(m.reply_to.sender_username || 'Someone')}</span>
        <span class="reply-quote-text">${m.reply_to.deleted ? 'Message removed' : this.escapeHTML(m.reply_to.content)}</span>
      </div>
    ` : '';
    return `
      <div class="chat-message${isMe ? ' chat-message-me' : ''}" data-message-id="${m.id}">
        <div class="avatar avatar-sm" style="width:22px;height:22px;font-size:10px;flex-shrink:0;">${AURUM.avatarInnerHTML(senderAvatar, senderLabel.charAt(0).toUpperCase())}</div>
        <div class="chat-message-body">
          ${replyHTML}
          <span class="chat-message-sender mono">${senderLabel}</span>
          <span class="chat-message-text">${text}</span>
          ${this.reactionBarHTML(m.id, reactions)}
        </div>
      </div>
    `;
  },

  reactionBarHTML(messageId, reactions) {
    const emojiList = ['🔥', '👑', '💰', '⚔️', '😂', '🖤'];
    const pills = Object.entries(reactions).map(([emoji, data]) => `
      <button class="reaction-pill${data.reacted_by_me ? ' reaction-pill-active' : ''}" data-message-id="${messageId}" data-emoji="${emoji}" style="font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid ${data.reacted_by_me ? 'var(--color-gold-dim)' : 'var(--color-border)'};background:${data.reacted_by_me ? 'var(--color-gold-glow)' : 'transparent'};color:${data.reacted_by_me ? 'var(--color-gold)' : 'var(--color-text-muted)'};cursor:pointer;margin-right:2px;">
        ${emoji} ${data.count}
      </button>
    `).join('');
    return `
      <div class="reaction-bar" style="margin-top:2px;display:flex;align-items:center;flex-wrap:wrap;">
        ${pills}
        <button class="reaction-add-btn" data-message-id="${messageId}" style="font-size:11px;padding:1px 6px;border-radius:10px;border:1px dashed var(--color-border);background:transparent;cursor:pointer;color:var(--color-text-muted);">+</button>
      </div>
    `;
  },

  appendCrewMessage(msg) {
    const list = document.getElementById('crew-chat-messages');
    if (!list) return;
    let replyTo = null;
    if (msg.replyToMessageId) {
      const originalBubble = list.querySelector(`[data-message-id="${msg.replyToMessageId}"]`);
      if (originalBubble) {
        replyTo = {
          sender_username: originalBubble.querySelector('.chat-message-sender')?.textContent || 'Someone',
          content: originalBubble.querySelector('.chat-message-text')?.textContent || '',
          deleted: false,
        };
      }
    }
    list.insertAdjacentHTML('beforeend', this.crewMessageHTML({
      id: msg.id,
      sender_id: msg.senderId,
      content: msg.content,
      deleted: false,
      reply_to: replyTo,
    }));
    list.scrollTop = list.scrollHeight;
  },

  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  async sendCrewMessage() {
    const input = document.getElementById('crew-chat-input');
    const content = input?.value.trim();
    if (!content || !this.activeChatCrewId) return;

    const replyToId = this.replyingToCrewMessage?.id || null;
    input.value = '';
    this.replyingToCrewMessage = null;
    this.renderCrewReplyBar();
    try {
      await AURUM.CrewAPI.sendMessage(this.activeChatCrewId, content, replyToId);
    } catch (err) {
      AURUM.showToast(err.message || 'Message failed to send.', 'error');
    }
  },
	
  async submitCrew() {
    const name = document.getElementById('crew-name')?.value.trim();
    const desc = document.getElementById('crew-desc')?.value.trim();
    const btn  = document.getElementById('btn-submit-crew');

    if (!name) {
      AURUM.showToast('Enter a crew name.', 'error'); return;
    }

    btn.textContent = 'Creating...';
    btn.disabled    = true;

    try {
      await AURUM.CrewAPI.createCrew({ name, description: desc });
      document.getElementById('create-crew-modal').style.display = 'none';
      document.getElementById('crew-name').value = '';
      document.getElementById('crew-desc').value = '';
      AURUM.showToast('Crew created!', 'gold');
      this.loadCrews();
    } catch (err) {
      AURUM.showToast(err.message || 'Could not create crew.', 'error');
    } finally {
      btn.textContent = 'Create Crew';
      btn.disabled    = false;
    }
  },

  async submitCrewBattle() {
    const title    = document.getElementById('crew-battle-title')?.value.trim();
    const target   = document.getElementById('crew-battle-target')?.value.trim();
    const entry    = document.getElementById('crew-battle-entry')?.value;
    const duration = document.getElementById('crew-battle-duration')?.value;
    const btn      = document.getElementById('btn-submit-crew-battle');

    if (!title) {
      AURUM.showToast('Add a battle title.', 'error'); return;
    }
    if (!target) {
      AURUM.showToast('Enter the target crew\'s exact name.', 'error'); return;
    }
    if (!this.activeBattleCrewId) {
      AURUM.showToast('Could not identify your crew.', 'error'); return;
    }

    btn.textContent = 'Launching...';
    btn.disabled    = true;

    try {
      const endsAt = new Date(
        Date.now() + parseInt(duration, 10) * 60 * 60 * 1000
      ).toISOString();

      await AURUM.CrewAPI.startBattle(this.activeBattleCrewId, {
        target_crew_name: target,
        title,
        entry_contribution_usd: parseFloat(entry),
        ends_at: endsAt,
      });
      document.getElementById('create-crew-battle-modal').style.display = 'none';
      AURUM.showToast('Crew battle launched!', 'gold');
    } catch (err) {
      AURUM.showToast(err.message || 'Could not launch crew battle.', 'error');
    } finally {
      btn.textContent = 'Launch Battle';
      btn.disabled    = false;
    }
  },

  async submitSpendRequest() {
    const crewId = this.activeSpendCrewId;
    const amount = parseFloat(document.getElementById('spend-amount-input').value);
    const reason = document.getElementById('spend-reason-input').value.trim();
    const btn    = document.getElementById('btn-submit-spend');

    if (!amount || amount <= 0) return AURUM.showToast('Enter a valid amount.', 'error');
    if (!reason) return AURUM.showToast('A reason is required.', 'error');
    if (!crewId) return AURUM.showToast('Could not identify crew.', 'error');

    btn.textContent = 'Submitting...';
    btn.disabled    = true;

    try {
      const result = await AURUM.CrewAPI.initiateSpend(crewId, amount, reason);
      document.getElementById('request-spend-modal').style.display = 'none';
      AURUM.showToast(
        result.spend?.status === 'executed' ? 'Spend executed.' : 'Spend submitted, awaiting co-sign.',
        'default'
      );
      this.openCrewDetail(crewId);
    } catch (err) {
      AURUM.showToast(err.message || 'Could not submit spend.', 'error');
    } finally {
      btn.textContent = 'Submit';
      btn.disabled    = false;
    }
  },

  async approveCosignRequest() {
    const txnId  = this.activeCosignTxnId;
    const crewId = this.activeCosignCrewId;
    const myRole = this.activeCosignMyRole;
    const btn    = document.getElementById('btn-approve-cosign');

    btn.textContent = 'Co-signing...';
    btn.disabled    = true;

    try {
      await AURUM.CrewAPI.cosignSpend(txnId);
      document.getElementById('cosign-request-modal').style.display = 'none';
      AURUM.showToast('Co-signed.', 'default');
      this.loadCrewWalletTransactions(crewId, myRole);
    } catch (err) {
      AURUM.showToast(err.message || 'Could not co-sign.', 'error');
    } finally {
      btn.textContent = 'Approve (Co-Sign)';
      btn.disabled    = false;
    }
  },

  async rejectCosignRequest() {
    const txnId  = this.activeCosignTxnId;
    const crewId = this.activeCosignCrewId;
    const myRole = this.activeCosignMyRole;
    const reason = document.getElementById('cosign-veto-reason-input').value.trim();

    try {
      await AURUM.CrewAPI.vetoSpend(txnId, reason);
      document.getElementById('cosign-request-modal').style.display = 'none';
      AURUM.showToast('Spend vetoed.', 'default');
      this.loadCrewWalletTransactions(crewId, myRole);
    } catch (err) {
      AURUM.showToast(err.message || 'Could not veto.', 'error');
    }
  },

  /* --------------------------------------------------
     CREATE CHALLENGE
  -------------------------------------------------- */
  async submitChallenge() {
    const title       = document.getElementById('ch-title')?.value.trim();
    const type        = document.getElementById('ch-type')?.value;
    const description = document.getElementById('ch-description')?.value.trim();
    const fee         = document.getElementById('ch-fee')?.value;
    const duration    = document.getElementById('ch-duration')?.value;
    const btn         = document.getElementById('btn-submit-challenge');

    if (!title) {
      AURUM.showToast('Add a challenge title.', 'error'); return;
    }

    btn.textContent = 'Launching...';
    btn.disabled    = true;

    try {
      const endsAt = new Date(
        Date.now() + parseInt(duration, 10) * 60 * 60 * 1000
      ).toISOString();

      await AURUM.ArenaAPI.createChallenge({
        title,
        type,
        description: description || null,
        entry_fee:   parseFloat(fee),
        ends_at:     endsAt,
      });
      document.getElementById('create-modal').style.display = 'none';
      document.getElementById('ch-title').value = '';
      document.getElementById('ch-description').value = '';
      AURUM.showToast('Challenge live in the Arena.', 'gold');
      this.loadChallenges('active');
    } catch (err) {
      AURUM.showToast(err.message || 'Failed to create challenge.', 'error');
    } finally {
      btn.textContent = 'Launch';
      btn.disabled    = false;
    }
  },

  /* --------------------------------------------------
     STATS BAR
  -------------------------------------------------- */
  updateStats(challenges) {
    const active   = challenges.filter(c => c.status === 'open');
    const ending   = active.filter(c => {
      const h = this.hoursLeft(c.ends_at);
      return h <= 24 && h > 0;
    });
    const totalPool = active.reduce((s, c) => s + (c.pool_amount || 0), 0);

    const poolEl   = document.getElementById('arena-total-pool');
    const activeEl = document.getElementById('arena-active');
    const endingEl = document.getElementById('arena-ending');
    if (poolEl)   poolEl.textContent   = AURUM.formatAmount(totalPool);
    if (activeEl) activeEl.textContent = active.length;
    if (endingEl) endingEl.textContent = ending.length;
  },

  getTimeLeft(endsAt) {
    if (!endsAt) return '—';
    const hours = this.hoursLeft(endsAt);
    if (hours <= 0) return 'Ended';
    if (hours < 1)  return `${Math.floor(hours * 60)}m`;
    if (hours < 24) return `${Math.floor(hours)}h`;
    return `${Math.floor(hours / 24)}d`;
  },

  hoursLeft(endsAt) {
    if (!endsAt) return 0;
    return (new Date(endsAt) - new Date()) / 3600000;
  },

  skeletons(count) {
    return Array(count).fill(`
      <div class="card" style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;gap:12px;align-items:center;">
          <div class="skeleton" style="width:40px;height:40px;border-radius:8px;flex-shrink:0;"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <div class="skeleton" style="height:14px;width:60%;"></div>
            <div class="skeleton" style="height:10px;width:40%;"></div>
          </div>
          <div class="skeleton" style="width:60px;height:32px;border-radius:8px;"></div>
        </div>
        <div class="skeleton" style="height:40px;border-radius:8px;"></div>
        <div class="skeleton" style="height:36px;border-radius:8px;"></div>
      </div>
    `).join('');
  },

  applyStyles() {
    if (document.getElementById('arena-styles')) return;
    const style = document.createElement('style');
    style.id = 'arena-styles';
    style.textContent = `
      .arena-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-4);
        position: relative;
      }

      .arena-wrap::before {
        content: '';
        position: absolute;
        top: -40px;
        left: 50%;
        transform: translateX(-50%);
        width: 320px;
        height: 200px;
        background: radial-gradient(ellipse at center,
          rgba(201,168,76,0.08), transparent 70%);
        pointer-events: none;
        z-index: 0;
      }

      .arena-header {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        padding-top: var(--space-2);
      }

      .arena-title {
        font-family: var(--font-display);
        font-size: var(--text-3xl);
        font-weight: var(--weight-light);
        background: linear-gradient(135deg, var(--color-text) 40%, var(--color-gold) 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .arena-stats {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
      }

      .arena-stat {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1;
        align-items: center;
      }

      .arena-stat-value {
        font-size: var(--text-lg);
        font-weight: var(--weight-medium);
        color: var(--color-text);
      }

      .arena-stat-label {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .arena-stat-divider {
        width: 1px;
        height: 32px;
        background: var(--color-border);
        flex-shrink: 0;
      }

      /* Section tabs */
      .arena-section-tabs {
        display: flex;
        gap: var(--space-2);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--space-3);
      }

      .arena-section-tab {
        padding: var(--space-2) var(--space-4);
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        letter-spacing: 0.06em;
        color: var(--color-text-muted);
        border-radius: var(--radius-md);
        transition: all var(--transition-base);
        cursor: pointer;
        background: none;
        border: none;
      }

      .arena-section-tab {
        position: relative;
      }

      .arena-section-tab.active {
        color: var(--color-gold);
        background: var(--color-gold-glow);
      }

      .arena-section-tab.active::after {
        content: '';
        position: absolute;
        bottom: -13px;
        left: 50%;
        transform: translateX(-50%);
        width: 60%;
        height: 2px;
        background: var(--color-gold);
        box-shadow: 0 0 8px rgba(201,168,76,0.6);
      }

      /* Status filter tabs */
      .arena-tabs {
        display: flex;
        gap: var(--space-2);
      }

      .arena-tab {
        padding: var(--space-2) var(--space-3);
        font-size: var(--text-xs);
        font-weight: var(--weight-medium);
        letter-spacing: 0.06em;
        color: var(--color-text-muted);
        border-radius: var(--radius-md);
        transition: all var(--transition-base);
        cursor: pointer;
        background: none;
        border: none;
      }

      .arena-tab.active {
        color: var(--color-gold);
        background: var(--color-gold-glow);
      }

      .challenge-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .challenge-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        position: relative;
        overflow: hidden;
        transition: transform var(--transition-base), box-shadow var(--transition-base);
      }

      .challenge-card::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 2px;
        background: linear-gradient(90deg, transparent, var(--color-gold), transparent);
        opacity: 0;
        transition: opacity var(--transition-base);
      }

      .challenge-card:hover {
        transform: translateY(-2px);
        box-shadow: var(--shadow-lg), 0 0 16px rgba(201,168,76,0.08);
      }

      .challenge-card:hover::before {
        opacity: 1;
      }

      .challenge-top {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
      }

      .challenge-icon {
        width: 40px;
        height: 40px;
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.2rem;
        flex-shrink: 0;
      }

      .challenge-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
      }

      .challenge-title {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .challenge-meta {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .challenge-pool {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
        flex-shrink: 0;
      }

      .challenge-pool-amount {
        font-size: var(--text-lg);
        font-weight: var(--weight-medium);
        color: var(--color-gold);
      }

      .challenge-pool-label {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .challenge-details {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        padding: var(--space-3);
        background: var(--color-surface-2);
        border-radius: var(--radius-md);
      }

      .challenge-detail {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
        flex: 1;
      }

      .challenge-detail-value {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--color-text);
      }

      .challenge-detail-label {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      /* Gold Button */
      .btn-gold-button {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: var(--space-2) var(--space-3);
        background: transparent;
        border: 1px solid var(--color-border-gold);
        border-radius: var(--radius-md);
        cursor: pointer;
        transition: all var(--transition-base);
        flex-shrink: 0;
      }

      .btn-gold-button:hover:not(:disabled) {
        background: var(--color-gold-glow);
      }

      .btn-gold-button.golded {
        background: var(--color-gold-glow);
        border-color: var(--color-gold);
      }

      .gold-count {
        font-family: var(--font-mono);
        font-size: var(--text-xs);
        color: var(--color-gold);
      }

      .duel-vs-badge {
        position: relative;
        font-family: var(--font-mono);
        font-size: var(--text-lg);
        font-weight: var(--weight-bold);
        color: var(--color-gold);
        padding: 0 var(--space-3);
        text-shadow: 0 0 10px rgba(201,168,76,0.5);
        animation: vsPulse 2s ease-in-out infinite;
      }

            @keyframes vsPulse {
        0%, 100% { text-shadow: 0 0 6px rgba(201,168,76,0.35); }
        50%      { text-shadow: 0 0 16px rgba(201,168,76,0.75); }
      }

      .duel-marquee-wrap {
        overflow: hidden;
        white-space: nowrap;
        background: var(--color-gold-glow);
        border: 1px solid var(--color-border-gold);
        border-radius: var(--radius-md);
        padding: var(--space-2) 0;
        margin-bottom: var(--space-3);
      }

      .duel-marquee-track {
        display: inline-block;
        padding-left: 100%;
        font-size: var(--text-xs);
        font-weight: var(--weight-medium);
        color: var(--color-gold);
        letter-spacing: 0.02em;
        animation: duelMarqueeScroll 18s linear infinite;
      }

      @keyframes duelMarqueeScroll {
        0%   { transform: translateX(0); }
        100% { transform: translateX(-50%); }
      }

      /* Crew chat */
      .chat-message {
        display: flex;
        gap: var(--space-2);
        align-items: flex-start;
        max-width: 100%;
      }

      .chat-message-body {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding: var(--space-2) var(--space-3);
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        max-width: 78%;
      }

      .chat-message-me {
        flex-direction: row-reverse;
      }

      .chat-message-me .chat-message-body {
        background: linear-gradient(135deg, rgba(201,168,76,0.10), var(--color-surface-2));
        border-color: var(--color-border-gold);
        align-items: flex-end;
        text-align: right;
      }

      .chat-message-sender {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-gold);
      }

      .chat-message-text {
        font-size: var(--text-sm);
        color: var(--color-text);
        line-height: 1.5;
        word-break: break-word;
      }

      .chat-message {
        transition: transform 0.15s ease;
        position: relative;
        touch-action: pan-y;
      }
      .chat-message.swipe-armed::after {
        content: '↩';
        position: absolute;
        left: -26px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-gold);
        font-size: 16px;
      }
      .reply-quote {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 4px 8px;
        margin-bottom: 4px;
        border-left: 2px solid var(--color-gold-dim);
        background: rgba(201,168,76,0.06);
        border-radius: 4px;
      }
      .reply-quote-sender {
        font-size: 10px;
        color: var(--color-gold);
        font-weight: var(--weight-medium);
      }
      .reply-quote-text {
        font-size: 11px;
        color: var(--color-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
      }
      .reply-preview-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        background: var(--color-surface-2);
        border-left: 2px solid var(--color-gold);
        border-radius: var(--radius-md);
        margin-bottom: var(--space-2);
      }
      .reply-preview-content {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .reply-preview-label {
        font-size: 10px;
        color: var(--color-gold);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .reply-preview-text {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .reply-preview-cancel {
        background: none;
        border: none;
        color: var(--color-text-muted);
        font-size: 18px;
        cursor: pointer;
        flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  },
};

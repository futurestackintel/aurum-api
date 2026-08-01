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
            <div style="display:flex;gap:var(--space-3);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-duel">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-duel">Challenge</button>
            </div>
          </div>
        </div>
      </div>

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

    <!-- Crew Chat Modal -->
      <div class="modal-overlay" id="crew-chat-modal" style="display:none;">
        <div class="modal" style="display:flex;flex-direction:column;height:80vh;max-height:600px;">
          <div class="modal-handle"></div>
          <h3 class="modal-title" id="crew-chat-title">Crew Chat</h3>
          <div id="crew-chat-messages" style="flex:1;overflow-y:auto;display:flex;flex-direction:column;gap:var(--space-2);padding:var(--space-2) 0;"></div>
          <div style="display:flex;gap:var(--space-2);padding-top:var(--space-3);">
            <input class="input" id="crew-chat-input" placeholder="Message your crew..." style="flex:1;" />
            <button class="btn btn-primary btn-sm" id="btn-send-crew-message">Send</button>
          </div>
        </div>
      </div>
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
          <div style="font-family:var(--font-mono);font-size:var(--text-lg);
            color:var(--color-gold);padding:0 var(--space-3);">VS</div>
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
      });
      document.getElementById('create-duel-modal').style.display = 'none';
      document.getElementById('duel-title').value       = '';
      document.getElementById('duel-opponent').value    = '';
      document.getElementById('duel-description').value = '';
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
        <div class="challenge-top">
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
        AURUM.showToast('Battle flow coming soon.', 'default');
      });
    });
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
        color: var(--color-text);
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

      .arena-section-tab.active {
        color: var(--color-gold);
        background: var(--color-gold-glow);
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
    `;
    document.head.appendChild(style);
  },
};

/* ============================================
   AURUM — The Arena (Drop Circles)
   Skill-based challenge browser and entry.
============================================ */

window.ArenaPage = {
  container: null,
  initialized: false,

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadChallenges();
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
          <button class="btn btn-primary btn-sm" id="btn-create-challenge">
            + Create
          </button>
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

        <!-- Filter tabs -->
        <div class="arena-tabs">
          <button class="arena-tab active" data-status="active">Active</button>
          <button class="arena-tab" data-status="upcoming">Upcoming</button>
          <button class="arena-tab" data-status="completed">Completed</button>
        </div>

        <!-- Challenge list -->
        <div class="challenge-list" id="challenge-list">
          <!-- Loads here -->
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
                <option value="deals">Most Deals Closed</option>
                <option value="growth">Best Growth %</option>
                <option value="savings">Most Saved</option>
                <option value="charity">Charity Brawl</option>
              </select>
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
            <div style="display:flex;gap:var(--space-3);padding-top:var(--space-2);">
              <button class="btn btn-ghost btn-full" id="btn-cancel-challenge">Cancel</button>
              <button class="btn btn-primary btn-full" id="btn-submit-challenge">Launch Challenge</button>
            </div>
          </div>
        </div>
      </div>
    `;

    this.applyStyles();
    this.bindEvents();
  },

  bindEvents() {
    /* Filter tabs */
    document.querySelectorAll('.arena-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.arena-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.loadChallenges(tab.dataset.status);
      });
    });

    /* Create modal */
    document.getElementById('btn-create-challenge')?.addEventListener('click', () => {
      document.getElementById('create-modal').style.display = 'flex';
    });

    document.getElementById('btn-cancel-challenge')?.addEventListener('click', () => {
      document.getElementById('create-modal').style.display = 'none';
    });

    document.getElementById('create-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'create-modal') {
        document.getElementById('create-modal').style.display = 'none';
      }
    });

    /* Submit challenge */
    document.getElementById('btn-submit-challenge')?.addEventListener('click', () => {
      this.submitChallenge();
    });
  },

  async loadChallenges(status = 'active') {
    const list = document.getElementById('challenge-list');
    if (!list) return;

    list.innerHTML = this.skeletons(3);

    try {
      const data = await AURUM.ArenaAPI.getChallenges(status);
      const challenges = data.challenges || getMockChallenges(status);
      this.renderChallenges(challenges);
      this.updateStats(challenges);
    } catch (err) {
      const challenges = getMockChallenges(status);
      this.renderChallenges(challenges);
      this.updateStats(challenges);
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
        </div>
      `;
      return;
    }

    list.innerHTML = challenges.map((ch, i) => this.challengeHTML(ch, i)).join('');
    this.bindChallengeEvents();
  },

  challengeHTML(ch, index) {
    const typeIcons = {
      revenue: '💰',
      deals: '🤝',
      growth: '📈',
      savings: '🏦',
      charity: '🏆'
    };

    const statusColors = {
      active: 'var(--color-success)',
      upcoming: 'var(--color-gold)',
      completed: 'var(--color-text-muted)'
    };

    const icon = typeIcons[ch.type] || '⚔️';
    const statusColor = statusColors[ch.status] || 'var(--color-text-muted)';
    const timeLeft = this.getTimeLeft(ch.ends_at);
    const poolAmount = AURUM.formatAmount(ch.pool_amount || 0);
    const entryFee = AURUM.formatAmount(ch.entry_fee || 0);
    const entries = ch.entries || 0;

    return `
      <div class="challenge-card card fade-in" style="animation-delay:${index * 80}ms">
        <div class="challenge-top">
          <div class="challenge-icon">${icon}</div>
          <div class="challenge-info">
            <p class="challenge-title">${ch.title}</p>
            <div class="challenge-meta">
              <span class="badge badge-muted" style="font-size:9px;">${ch.type || 'achievement'}</span>
              <span style="font-size:10px;color:${statusColor};letter-spacing:0.06em;text-transform:uppercase;">
                ${ch.status || 'active'}
              </span>
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
            <span class="challenge-detail-value mono">${entries}</span>
            <span class="challenge-detail-label">Entries</span>
          </div>
          <div class="challenge-detail">
            <span class="challenge-detail-value mono" style="color:${ch.status === 'active' ? 'var(--color-danger)' : 'var(--color-text-muted)'}">
              ${timeLeft}
            </span>
            <span class="challenge-detail-label">Remaining</span>
          </div>
        </div>

        ${ch.status === 'active' ? `
          <button class="btn btn-outline btn-full btn-sm btn-enter-challenge"
            data-challenge-id="${ch.id}"
            data-entry-fee="${ch.entry_fee}">
            Enter Challenge
          </button>
        ` : `
          <button class="btn btn-ghost btn-full btn-sm" disabled>
            ${ch.status === 'completed' ? 'Completed' : 'Starting Soon'}
          </button>
        `}
      </div>
    `;
  },

  bindChallengeEvents() {
    document.querySelectorAll('.btn-enter-challenge').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.challengeId;
        const fee = btn.dataset.entryFee;

        btn.textContent = 'Entering...';
        btn.disabled = true;

        try {
          await AURUM.ArenaAPI.fundChallenge(id, { amount: parseFloat(fee) });
          AURUM.showToast('You\'re in the Arena.', 'gold');
          btn.textContent = 'Entered ✦';
          btn.classList.remove('btn-outline');
          btn.classList.add('btn-ghost');
        } catch (err) {
          AURUM.showToast(err.message || 'Entry failed.', 'error');
          btn.textContent = 'Enter Challenge';
          btn.disabled = false;
        }
      });
    });
  },

  async submitChallenge() {
    const title = document.getElementById('ch-title')?.value.trim();
    const type = document.getElementById('ch-type')?.value;
    const fee = document.getElementById('ch-fee')?.value;
    const duration = document.getElementById('ch-duration')?.value;
    const btn = document.getElementById('btn-submit-challenge');

    if (!title) {
      AURUM.showToast('Add a challenge title.', 'error');
      return;
    }

    btn.textContent = 'Launching...';
    btn.disabled = true;

    try {
      await AURUM.ArenaAPI.createChallenge({
        title,
        type,
        entry_fee: parseFloat(fee),
        duration_hours: parseInt(duration)
      });
      document.getElementById('create-modal').style.display = 'none';
      document.getElementById('ch-title').value = '';
      AURUM.showToast('Challenge live in the Arena.', 'gold');
      this.loadChallenges('active');
    } catch (err) {
      AURUM.showToast(err.message || 'Failed to create challenge.', 'error');
    } finally {
      btn.textContent = 'Launch Challenge';
      btn.disabled = false;
    }
  },

  updateStats(challenges) {
    const active = challenges.filter(c => c.status === 'active');
    const ending = active.filter(c => {
      const h = this.hoursLeft(c.ends_at);
      return h <= 24 && h > 0;
    });
    const totalPool = active.reduce((sum, c) => sum + (c.pool_amount || 0), 0);

    const poolEl = document.getElementById('arena-total-pool');
    const activeEl = document.getElementById('arena-active');
    const endingEl = document.getElementById('arena-ending');

    if (poolEl) poolEl.textContent = AURUM.formatAmount(totalPool);
    if (activeEl) activeEl.textContent = active.length;
    if (endingEl) endingEl.textContent = ending.length;
  },

  getTimeLeft(endsAt) {
    if (!endsAt) return '—';
    const hours = this.hoursLeft(endsAt);
    if (hours <= 0) return 'Ended';
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

      .arena-tabs {
        display: flex;
        gap: var(--space-2);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--space-3);
      }

      .arena-tab {
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
    `;
    document.head.appendChild(style);
  }
};

/* Mock challenges */
function getMockChallenges(status = 'active') {
  const now = new Date();
  return [
    {
      id: '1',
      title: 'Most Revenue — June Edition',
      type: 'revenue',
      status: status,
      pool_amount: 4750,
      entry_fee: 50,
      entries: 95,
      ends_at: new Date(now.getTime() + 172800000).toISOString()
    },
    {
      id: '2',
      title: 'Most Deals Closed This Week',
      type: 'deals',
      status: status,
      pool_amount: 1200,
      entry_fee: 25,
      entries: 48,
      ends_at: new Date(now.getTime() + 86400000).toISOString()
    },
    {
      id: '3',
      title: 'Charity Brawl — Build Africa Fund',
      type: 'charity',
      status: status,
      pool_amount: 8500,
      entry_fee: 100,
      entries: 85,
      ends_at: new Date(now.getTime() + 604800000).toISOString()
    }
  ];
}
/* ============================================
   AURUM — Admin Review Queue
   Triggered by the hidden shield icon in the app bar (only shown
   if /api/admin/check succeeds for the logged-in user). Renders
   as a full-screen overlay appended to <body>, not wired into
   App.navigate() since it's not one of the five main bottom-nav
   views. Covers six categories across all previously-confirmed,
   real backend endpoints (AdminAPI in api.js):
     - Disputed Posts   (suspended, needs verify/fake verdict)
     - Appeals          (submitted, needs upheld/rejected decision)
     - Moderation Flags (needs actioned/dismissed decision)
     - Badge Requests   (needs approve/reject)
     - Challenge Entries (needs a numeric score)
     - Resolvable Challenges (ended, needs winner picked)
============================================ */

window.AdminPage = {
  initialized: false,
  activeTab:   'disputes',

  TABS: [
    { key: 'disputes',   label: 'Posts'    },
    { key: 'appeals',    label: 'Appeals'  },
    { key: 'flags',      label: 'Flags'    },
    { key: 'badges',     label: 'Badges'   },
    { key: 'entries',    label: 'Entries'  },
    { key: 'challenges', label: 'Resolve'  },
  ],

  open() {
    if (!this.initialized) {
      this.render();
      this.initialized = true;
    }
    document.getElementById('admin-overlay').style.display = 'flex';
    this.loadTab(this.activeTab);
  },

  close() {
    const el = document.getElementById('admin-overlay');
    if (el) el.style.display = 'none';
  },

  render() {
    const div = document.createElement('div');
    div.id = 'admin-overlay';
    div.innerHTML = `
      <div class="admin-header">
        <button class="admin-back-btn" id="admin-back-btn">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2">
            <path d="M19 12H5M12 19l-7-7 7-7"/>
          </svg>
          <span>Back</span>
        </button>
        <span class="admin-header-title">Admin Review Queue</span>
      </div>

      <div class="admin-tabs" id="admin-tabs">
        ${this.TABS.map(t => `
          <button class="admin-tab ${t.key === this.activeTab ? 'active' : ''}"
            data-tab="${t.key}">${t.label}</button>
        `).join('')}
      </div>

      <div class="admin-scroll" id="admin-scroll">
        <div class="admin-list" id="admin-list"></div>
      </div>
    `;
    document.body.appendChild(div);
    this.applyStyles();
    this.bindEvents();
  },

  bindEvents() {
    document.getElementById('admin-back-btn')
      ?.addEventListener('click', () => this.close());

    document.querySelectorAll('.admin-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.activeTab = tab.dataset.tab;
        this.loadTab(this.activeTab);
      });
    });
  },

  async loadTab(tab) {
    const list = document.getElementById('admin-list');
    if (!list) return;
    list.innerHTML = this.skeletons(2);
    document.getElementById('admin-scroll')?.scrollTo(0, 0);

    try {
      switch (tab) {
        case 'disputes':   return this.loadDisputes(list);
        case 'appeals':    return this.loadAppeals(list);
        case 'flags':      return this.loadFlags(list);
        case 'badges':     return this.loadBadges(list);
        case 'entries':    return this.loadEntries(list);
        case 'challenges': return this.loadResolvable(list);
      }
    } catch (err) {
      list.innerHTML = `<div class="admin-empty">Could not load this queue.</div>`;
    }
  },

  /* --------------------------------------------------
     DISPUTED POSTS — suspended_posts from getDisputes()
  -------------------------------------------------- */
  async loadDisputes(list) {
    const data  = await AURUM.AdminAPI.getDisputes();
    const items = data.disputes?.suspended_posts || [];

    if (!items.length) {
      list.innerHTML = `<div class="admin-empty">No suspended posts awaiting review.</div>`;
      return;
    }

    list.innerHTML = items.map(p => `
      <div class="admin-card" data-post-id="${p.id}">
        <div class="admin-card-top">
          <span class="admin-card-user">${p.username}</span>
          <span class="admin-card-flag-count">${p.flag_count} flag${p.flag_count === 1 ? '' : 's'}</span>
        </div>
        <p class="admin-card-content">${this.escapeHTML(p.content)}</p>
        <div class="admin-card-meta">
          <span>Stake: ${AURUM.formatAurum(p.stake_amount || 0)}</span>
          <span>${AURUM.timeAgo(p.created_at)}</span>
        </div>
        <div class="admin-card-actions">
          <button class="btn btn-primary btn-sm admin-btn-verify" data-post-id="${p.id}">Verify</button>
          <button class="btn btn-outline btn-sm admin-btn-slash" data-post-id="${p.id}">Rule Fake</button>
        </div>
      </div>
    `).join('');

    this.bindDisputeEvents();
  },

  bindDisputeEvents() {
    document.querySelectorAll('.admin-btn-verify').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.postId;
        btn.textContent = 'Verifying...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.verifyPost(id);
          AURUM.showToast('Post verified. Stake returned.', 'gold');
          this.loadTab('disputes');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not verify post.', 'error');
          btn.textContent = 'Verify';
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll('.admin-btn-slash').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.postId;
        if (!confirm('Rule this post fake? A 48h appeal window opens for the user.')) return;
        btn.textContent = 'Ruling...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.slashPost(id, 'Ruled fake by admin review');
          AURUM.showToast('Post ruled fake. Appeal window opened.', 'default');
          this.loadTab('disputes');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not rule on post.', 'error');
          btn.textContent = 'Rule Fake';
          btn.disabled = false;
        }
      });
    });
  },

  /* --------------------------------------------------
     APPEALS — submitted_appeals from getDisputes()
  -------------------------------------------------- */
  async loadAppeals(list) {
    const data  = await AURUM.AdminAPI.getDisputes();
    const items = data.disputes?.submitted_appeals || [];

    if (!items.length) {
      list.innerHTML = `<div class="admin-empty">No submitted appeals awaiting a decision.</div>`;
      return;
    }

    list.innerHTML = items.map(a => `
      <div class="admin-card" data-post-id="${a.id}">
        <div class="admin-card-top">
          <span class="admin-card-user">${a.username}</span>
          <span class="admin-card-deadline">Deadline: ${AURUM.timeAgo(a.appeal_deadline)}</span>
        </div>
        <p class="admin-card-content">${this.escapeHTML(a.content)}</p>
        <div class="admin-card-appeal-reason">
          <span class="admin-card-label">Appeal reason:</span>
          <p>${this.escapeHTML(a.appeal_reason || '—')}</p>
        </div>
        <div class="admin-card-meta">
          <span>Stake: ${AURUM.formatAurum(a.stake_amount || 0)}</span>
        </div>
        <div class="admin-card-actions">
          <button class="btn btn-primary btn-sm admin-btn-uphold" data-post-id="${a.id}">Uphold Appeal</button>
          <button class="btn btn-outline btn-sm admin-btn-reject" data-post-id="${a.id}">Reject Appeal</button>
        </div>
      </div>
    `).join('');

    this.bindAppealEvents();
  },

  bindAppealEvents() {
    document.querySelectorAll('.admin-btn-uphold').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.postId;
        btn.textContent = 'Upholding...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.decideAppeal(id, 'upheld');
          AURUM.showToast('Appeal upheld. Stake returned.', 'gold');
          this.loadTab('appeals');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not decide appeal.', 'error');
          btn.textContent = 'Uphold Appeal';
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll('.admin-btn-reject').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.postId;
        if (!confirm('Reject this appeal? The stake will be finalized as slashed.')) return;
        btn.textContent = 'Rejecting...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.decideAppeal(id, 'rejected');
          AURUM.showToast('Appeal rejected. Stake slashed.', 'default');
          this.loadTab('appeals');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not decide appeal.', 'error');
          btn.textContent = 'Reject Appeal';
          btn.disabled = false;
        }
      });
    });
  },

  /* --------------------------------------------------
     MODERATION FLAGS
  -------------------------------------------------- */
  async loadFlags(list) {
    const data  = await AURUM.AdminAPI.getFlags();
    const items = data.flags || [];

    if (!items.length) {
      list.innerHTML = `<div class="admin-empty">No pending flags.</div>`;
      return;
    }

    list.innerHTML = items.map(f => `
      <div class="admin-card" data-flag-id="${f.id}">
        <div class="admin-card-top">
          <span class="admin-card-user">${f.reporter_username || 'Anonymous'}</span>
          <span class="badge badge-muted" style="font-size:9px;">${f.reason}</span>
        </div>
        <p class="admin-card-content">
          <span class="admin-card-label">Target:</span> ${f.target_type} (${f.target_id})
        </p>
        ${f.notes ? `<p class="admin-card-content">${this.escapeHTML(f.notes)}</p>` : ''}
        <div class="admin-card-meta">
          <span>${AURUM.timeAgo(f.created_at)}</span>
        </div>
        <div class="admin-card-actions">
          <button class="btn btn-primary btn-sm admin-btn-flag-action" data-flag-id="${f.id}">Take Action</button>
          <button class="btn btn-outline btn-sm admin-btn-flag-dismiss" data-flag-id="${f.id}">Dismiss</button>
        </div>
      </div>
    `).join('');

    this.bindFlagEvents();
  },

  bindFlagEvents() {
    document.querySelectorAll('.admin-btn-flag-action').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.flagId;
        const note = prompt('Briefly describe the action taken:');
        if (note === null) return;
        btn.textContent = 'Saving...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.resolveFlag(id, 'actioned', note || 'Action taken by admin');
          AURUM.showToast('Flag actioned.', 'gold');
          this.loadTab('flags');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not resolve flag.', 'error');
          btn.textContent = 'Take Action';
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll('.admin-btn-flag-dismiss').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.flagId;
        btn.textContent = 'Dismissing...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.resolveFlag(id, 'dismissed', 'Dismissed by admin');
          AURUM.showToast('Flag dismissed.', 'default');
          this.loadTab('flags');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not dismiss flag.', 'error');
          btn.textContent = 'Dismiss';
          btn.disabled = false;
        }
      });
    });
  },

  /* --------------------------------------------------
     BADGE REQUESTS
  -------------------------------------------------- */
  async loadBadges(list) {
    const data  = await AURUM.AdminAPI.getBadgeRequests();
    const items = data.requests || [];

    if (!items.length) {
      list.innerHTML = `<div class="admin-empty">No pending badge requests.</div>`;
      return;
    }

    list.innerHTML = items.map(b => `
      <div class="admin-card" data-badge-id="${b.id}">
        <div class="admin-card-top">
          <span class="admin-card-user">${b.username || b.user_id}</span>
          <span class="badge badge-muted" style="font-size:9px;">${b.badge_type}</span>
        </div>
        ${b.evidence_url ? `
          <a href="${b.evidence_url}" target="_blank" class="admin-card-evidence-link">
            View evidence →
          </a>
        ` : ''}
        ${b.notes ? `<p class="admin-card-content">${this.escapeHTML(b.notes)}</p>` : ''}
        <div class="admin-card-meta">
          <span>${AURUM.timeAgo(b.created_at)}</span>
        </div>
        <div class="admin-card-actions">
          <button class="btn btn-primary btn-sm admin-btn-badge-approve" data-badge-id="${b.id}">Approve</button>
          <button class="btn btn-outline btn-sm admin-btn-badge-reject" data-badge-id="${b.id}">Reject</button>
        </div>
      </div>
    `).join('');

    this.bindBadgeEvents();
  },

  bindBadgeEvents() {
    document.querySelectorAll('.admin-btn-badge-approve').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.badgeId;
        btn.textContent = 'Approving...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.approveBadgeRequest(id);
          AURUM.showToast('Badge approved.', 'gold');
          this.loadTab('badges');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not approve badge.', 'error');
          btn.textContent = 'Approve';
          btn.disabled = false;
        }
      });
    });

    document.querySelectorAll('.admin-btn-badge-reject').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.badgeId;
        const reason = prompt('Reason for rejection:');
        if (reason === null) return;
        btn.textContent = 'Rejecting...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.rejectBadgeRequest(id, reason || 'Not sufficient evidence');
          AURUM.showToast('Badge request rejected.', 'default');
          this.loadTab('badges');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not reject badge.', 'error');
          btn.textContent = 'Reject';
          btn.disabled = false;
        }
      });
    });
  },

  /* --------------------------------------------------
     CHALLENGE ENTRIES — needs a score
  -------------------------------------------------- */
  async loadEntries(list) {
    const data  = await AURUM.AdminAPI.getUnscoredEntries();
    const items = data.entries || [];

    if (!items.length) {
      list.innerHTML = `<div class="admin-empty">No entries awaiting a score.</div>`;
      return;
    }

    list.innerHTML = items.map(e => `
      <div class="admin-card" data-entry-id="${e.id}" data-challenge-id="${e.challenge_id}" data-user-id="${e.user_id}">
        <div class="admin-card-top">
          <span class="admin-card-user">${e.username}</span>
          <span class="badge badge-muted" style="font-size:9px;">${e.challenge_title}</span>
        </div>
        ${e.proof_description ? `<p class="admin-card-content">${this.escapeHTML(e.proof_description)}</p>` : ''}
        ${e.achievement_proof_urls ? `
          <a href="${e.achievement_proof_urls}" target="_blank" class="admin-card-evidence-link">
            View proof →
          </a>
        ` : ''}
        <div class="admin-card-meta">
          <span>Claimed value: ${e.achievement_value ?? '—'}</span>
          <span>${AURUM.timeAgo(e.submitted_at)}</span>
        </div>
        <div class="admin-card-score-row">
          <input type="number" class="input admin-score-input" placeholder="Score" style="max-width:120px;" />
          <button class="btn btn-primary btn-sm admin-btn-submit-score"
            data-entry-user-id="${e.user_id}" data-challenge-id="${e.challenge_id}">Submit Score</button>
        </div>
      </div>
    `).join('');

    this.bindEntryEvents();
  },

  bindEntryEvents() {
    document.querySelectorAll('.admin-btn-submit-score').forEach(btn => {
      btn.addEventListener('click', async () => {
        const card       = btn.closest('.admin-card');
        const input       = card.querySelector('.admin-score-input');
        const score       = parseFloat(input.value);
        const challengeId = btn.dataset.challengeId;
        const userId      = btn.dataset.entryUserId;

        if (isNaN(score)) {
          AURUM.showToast('Enter a numeric score.', 'error');
          return;
        }

        btn.textContent = 'Saving...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.scoreEntry(challengeId, userId, score);
          AURUM.showToast('Score submitted.', 'gold');
          this.loadTab('entries');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not submit score.', 'error');
          btn.textContent = 'Submit Score';
          btn.disabled = false;
        }
      });
    });
  },

  /* --------------------------------------------------
     RESOLVABLE CHALLENGES — needs a winner picked
  -------------------------------------------------- */
  async loadResolvable(list) {
    const data  = await AURUM.AdminAPI.getResolvableChallenges();
    const items = data.challenges || [];

    if (!items.length) {
      list.innerHTML = `<div class="admin-empty">No challenges ready to resolve.</div>`;
      return;
    }

    list.innerHTML = items.map(c => `
      <div class="admin-card" data-challenge-id="${c.id}">
        <div class="admin-card-top">
          <span class="admin-card-user">${c.title}</span>
          <span class="badge badge-muted" style="font-size:9px;">${c.challenge_type}</span>
        </div>
        <div class="admin-card-meta">
          <span>Pool: ${AURUM.formatAurum((c.pool_total_cents || 0) / 100)}</span>
          <span>${c.participant_count || 0} participants</span>
        </div>
        <div class="admin-card-meta">
          <span>Ended: ${AURUM.timeAgo(c.ends_at)}</span>
        </div>
        <div class="admin-card-actions">
          <button class="btn btn-primary btn-sm admin-btn-resolve" data-challenge-id="${c.id}">
            Resolve — Pick Top Score
          </button>
        </div>
      </div>
    `).join('');

    this.bindResolveEvents();
  },

  bindResolveEvents() {
    document.querySelectorAll('.admin-btn-resolve').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.challengeId;
        if (!confirm('Resolve this challenge? This picks the winner and pays out the pool.')) return;
        btn.textContent = 'Resolving...';
        btn.disabled = true;
        try {
          await AURUM.AdminAPI.resolveChallenge(id);
          AURUM.showToast('Challenge resolved. Winner paid out.', 'gold');
          this.loadTab('challenges');
        } catch (err) {
          AURUM.showToast(err.message || 'Could not resolve challenge.', 'error');
          btn.textContent = 'Resolve — Pick Top Score';
          btn.disabled = false;
        }
      });
    });
  },

  /* --------------------------------------------------
     SHARED HELPERS
  -------------------------------------------------- */
  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  skeletons(count) {
    return Array(count).fill(`
      <div class="admin-card">
        <div class="skeleton" style="height:14px;width:40%;margin-bottom:8px;"></div>
        <div class="skeleton" style="height:14px;width:90%;margin-bottom:6px;"></div>
        <div class="skeleton" style="height:14px;width:70%;margin-bottom:12px;"></div>
        <div class="skeleton" style="height:32px;width:100%;border-radius:8px;"></div>
      </div>
    `).join('');
  },

  applyStyles() {
    if (document.getElementById('admin-styles')) return;
    const style = document.createElement('style');
    style.id = 'admin-styles';
    style.textContent = `
      #admin-overlay {
        display: none;
        flex-direction: column;
        position: fixed;
        inset: 0;
        background: var(--color-bg);
        z-index: 9500;
      }

      .admin-header {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-4);
        border-bottom: 1px solid var(--color-border);
        flex-shrink: 0;
      }

      .admin-back-btn {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        background: none;
        border: none;
        color: var(--color-text-muted);
        font-size: var(--text-sm);
        cursor: pointer;
        padding: 0;
        transition: color var(--transition-base);
      }
      .admin-back-btn:hover { color: var(--color-text); }

      .admin-header-title {
        font-family: var(--font-display);
        font-size: var(--text-lg);
        font-weight: var(--weight-light);
        letter-spacing: 0.08em;
        color: var(--color-text);
      }

      .admin-tabs {
        display: flex;
        gap: var(--space-2);
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--color-border);
        overflow-x: auto;
        flex-shrink: 0;
      }

      .admin-tab {
        padding: var(--space-2) var(--space-3);
        font-size: var(--text-xs);
        font-weight: var(--weight-medium);
        letter-spacing: 0.04em;
        color: var(--color-text-muted);
        border-radius: var(--radius-md);
        transition: all var(--transition-base);
        cursor: pointer;
        background: none;
        border: none;
        white-space: nowrap;
        flex-shrink: 0;
      }
      .admin-tab.active {
        color: var(--color-gold);
        background: var(--color-gold-glow);
      }

      .admin-scroll {
        flex: 1;
        overflow-y: auto;
        padding: var(--space-4);
      }

      .admin-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .admin-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
      }

      .admin-card-top {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .admin-card-user {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        color: var(--color-text);
      }

      .admin-card-flag-count,
      .admin-card-deadline {
        font-size: 10px;
        color: var(--color-danger);
        letter-spacing: 0.04em;
      }

      .admin-card-content {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        line-height: 1.5;
      }

      .admin-card-label {
        font-size: 10px;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-text-dim);
      }

      .admin-card-appeal-reason p {
        font-size: var(--text-sm);
        color: var(--color-text);
        margin-top: 2px;
      }

      .admin-card-meta {
        display: flex;
        gap: var(--space-3);
        font-size: 10px;
        color: var(--color-text-dim);
      }

      .admin-card-evidence-link {
        font-size: var(--text-xs);
        color: var(--color-gold);
        text-decoration: underline;
      }

      .admin-card-actions {
        display: flex;
        gap: var(--space-2);
        margin-top: var(--space-2);
      }

      .admin-card-score-row {
        display: flex;
        gap: var(--space-2);
        align-items: center;
        margin-top: var(--space-2);
      }

      .admin-empty {
        padding: var(--space-8) var(--space-4);
        text-align: center;
        font-size: var(--text-sm);
        color: var(--color-text-muted);
      }
    `;
    document.head.appendChild(style);
  },
};

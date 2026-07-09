/* ============================================
   AURUM — The Ledger (Main Feed) — Final Fix Chat
   Fix: tip button now sends receiver_id and amount_usd, matching
   POST /api/tips' actual required body shape. Previously sent
   { post_id, amount: 1 } — missing receiver_id entirely and using
   the wrong field name for the amount, so every tip attempt
   returned 400 "post_id, receiver_id, and amount_usd required".
============================================ */

/* ---- Fix 1: Aurum-branded amount formatter (₳ not $) ---- */
function formatAurum(amount) {
  const n = parseFloat(amount) || 0;
  if (n >= 1000000) return `₳${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000)    return `₳${(n / 1000).toFixed(1)}K`;
  return `₳${n.toFixed(2)}`;
}

window.LedgerPage = {
  container:   null,
  offset:      0,
  pageSize:    20,
  loading:     false,
  initialized: false,
  hasMore:     true,

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadPosts(false);
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="ledger-wrap">

        <!-- Composer -->
        <div class="composer card">
          <div class="composer-top">
            <div class="avatar avatar-sm avatar-gold" id="composer-avatar">—</div>
            <div class="composer-input-wrap">
              <textarea
                class="composer-input"
                id="post-content"
                placeholder="Post a verified win..."
                rows="1"
              ></textarea>
            </div>
          </div>
          <div class="composer-bottom">
            <div class="stake-selector">
              <span class="stake-label">Stake</span>
              <select class="stake-select" id="post-stake">
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
            <button class="btn btn-primary btn-sm" id="btn-post">Post Win</button>
          </div>
        </div>

        <!-- Feed -->
        <div class="feed" id="ledger-feed"></div>

        <!-- Load more -->
        <div style="padding:var(--space-6);text-align:center;" id="load-more-wrap">
          <button class="btn btn-ghost btn-sm" id="btn-load-more">Load More</button>
        </div>

      </div>
    `;

    this.applyStyles();
    this.bindEvents();
    this.setComposerAvatar();
  },

  setComposerAvatar() {
    const avatar = document.getElementById('composer-avatar');
    if (avatar && window.App?.user?.username) {
      avatar.textContent = window.App.user.username.charAt(0).toUpperCase();
    }
  },

  bindEvents() {
    /* Auto-resize textarea */
    const textarea = document.getElementById('post-content');
    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });
    }

    /* Post button */
    document.getElementById('btn-post')
      ?.addEventListener('click', () => this.submitPost());

    /* Load more */
    document.getElementById('btn-load-more')
      ?.addEventListener('click', () => {
        if (!this.loading && this.hasMore) {
          this.loadPosts(true);
        }
      });
  },

  async loadPosts(append = false) {
    if (this.loading) return;
    this.loading = true;

    const feed       = document.getElementById('ledger-feed');
    const loadMoreWrap = document.getElementById('load-more-wrap');
    if (!feed) { this.loading = false; return; }

    if (!append) {
      this.offset = 0;
      this.hasMore = true;
      feed.innerHTML = this.skeletons(3);
    } else {
      /* Append a skeleton at bottom while loading */
      feed.insertAdjacentHTML('beforeend',
        `<div id="append-skeleton">${this.skeletons(2)}</div>`);
    }

    try {
      const data  = await AURUM.LedgerAPI.getFeed(this.offset);
      const posts = data.posts || [];

      /* Remove append skeleton if present */
      document.getElementById('append-skeleton')?.remove();

      if (!append) feed.innerHTML = '';

      if (!posts.length && !append) {
        feed.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            <h4>No posts yet</h4>
            <p>Be the first to post a verified win.</p>
          </div>`;
        if (loadMoreWrap) loadMoreWrap.style.display = 'none';
        this.loading = false;
        return;
      }

      posts.forEach(post => {
        feed.insertAdjacentHTML('beforeend', this.postHTML(post));
      });

      /* Pagination state */
      this.offset  += posts.length;
      this.hasMore  = posts.length >= this.pageSize;

      if (loadMoreWrap) {
        loadMoreWrap.style.display = this.hasMore ? 'block' : 'none';
      }

    } catch (err) {
      document.getElementById('append-skeleton')?.remove();

      if (!append) {
        /* Show mock posts so feed is never blank */
        feed.innerHTML = '';
        getMockPosts().forEach(post => {
          feed.insertAdjacentHTML('beforeend', this.postHTML(post));
        });
        if (loadMoreWrap) loadMoreWrap.style.display = 'none';
      }
    } finally {
      this.loading = false;
      this.bindPostEvents();
    }
  },

  async submitPost() {
    const content = document.getElementById('post-content')?.value.trim();
    const stake   = document.getElementById('post-stake')?.value;
    const btn     = document.getElementById('btn-post');

    if (!content) {
      AURUM.showToast('Write something worth staking.', 'error');
      return;
    }

    btn.textContent = 'Posting...';
    btn.disabled    = true;

    try {
      await AURUM.LedgerAPI.createPost({
        content,
        stake_amount: parseFloat(stake),
      });
      document.getElementById('post-content').value = '';
      document.getElementById('post-content').style.height = 'auto';
      AURUM.showToast('Win posted. Stake locked.', 'gold');
      /* Reload from top */
      this.loadPosts(false);
    } catch (err) {
      AURUM.showToast(err.message || 'Post failed.', 'error');
    } finally {
      btn.textContent = 'Post Win';
      btn.disabled    = false;
    }
  },

  bindPostEvents() {
    /* ---- Tip buttons — optimistic UI ----
       Fix: now reads data-receiver-id (the post author's internal
       user id) and sends { post_id, receiver_id, amount_usd }
       matching what POST /api/tips actually requires. */
    document.querySelectorAll('.btn-tip').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', async () => {
        const postId     = btn.dataset.postId;
        const receiverId = btn.dataset.receiverId;
        const counterEl  = document.querySelector(`[data-tips="${postId}"]`);
        const prev       = parseFloat(counterEl?.dataset.total || '0');

        if (!receiverId) {
          AURUM.showToast('Could not identify post author for tip.', 'error');
          return;
        }

        /* Optimistic update */
        if (counterEl) {
          const optimistic = prev + 1;
          counterEl.textContent     = formatAurum(optimistic);
          counterEl.dataset.total   = optimistic;
          btn.style.color           = 'var(--color-gold)';
        }

        try {
          await AURUM.TipsAPI.send({
            post_id:     postId,
            receiver_id: receiverId,
            amount_usd:  1,
          });
          AURUM.showToast('Tip sent!', 'gold');
        } catch (err) {
          /* Roll back on failure */
          if (counterEl) {
            counterEl.textContent   = formatAurum(prev);
            counterEl.dataset.total = prev;
            btn.style.color         = '';
          }
          AURUM.showToast(err.message || 'Tip failed.', 'error');
        }
      });
    });

    /* ---- Cheer (Gold Button on posts) ---- */
    document.querySelectorAll('.btn-cheer').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', async () => {
        const postId    = btn.dataset.postId;
        const countEl   = btn.querySelector('.cheer-count');
        const prevCount = parseInt(countEl?.textContent || '0', 10);

        /* Optimistic */
        btn.classList.add('cheered');
        btn.disabled = true;
        if (countEl) countEl.textContent = prevCount + 1;

        try {
          await AURUM.LedgerAPI.cheer(postId);
        } catch (err) {
          /* Roll back */
          btn.classList.remove('cheered');
          btn.disabled = false;
          if (countEl) countEl.textContent = prevCount;
          // FIX: was a hardcoded generic message that hid the real
          // backend reason (e.g. "already cheered", "user not found").
          AURUM.showToast(err.message || 'Could not cheer post.', 'error');
        }
      });
    });
  },

  postHTML(post) {
    const initials    = post.username?.charAt(0).toUpperCase() || '?';
    const league      = post.league || 'bronze';
    const stakeStatus = post.stake_status || 'pending';
    const stakeColor  = {
      verified: 'var(--color-success)',
      pending:  'var(--color-gold)',
      disputed: 'var(--color-danger)',
    }[stakeStatus] || 'var(--color-text-muted)';

    const cheers = post.cheers || 0;

    return `
      <div class="post-card card fade-in">
        <div class="post-header">
          <div class="avatar avatar-sm ${league === 'sovereign' ? 'avatar-gold' : ''}">
            ${initials}
          </div>
          <div class="post-meta">
            <div class="post-username">
              ${post.username || 'Anonymous'}
              ${post.verified
                ? '<span style="color:var(--color-gold);font-size:10px;">✦</span>'
                : ''}
            </div>
            <div class="post-sub">
              <span class="badge ${AURUM.getLeagueBadge(league)}" style="font-size:9px;">
                ${league}
              </span>
              <span class="post-time">
                ${AURUM.timeAgo(post.created_at || new Date())}
              </span>
            </div>
          </div>
          <div class="post-stake" style="border-color:${stakeColor};">
            <span class="post-stake-amount mono" style="color:${stakeColor};">
              ₳${post.stake_amount_usd || (post.stake_amount_cents / 100) || 5}
            </span>
            <span class="post-stake-label">stake</span>
          </div>
        </div>

        <p class="post-content">${post.content || ''}</p>

        ${post.media_url ? `
          <img src="${post.media_url}" class="post-media" alt="Achievement proof" />
        ` : ''}

        <div class="post-actions">

          <!-- Tip button -->
          <button class="btn-tip post-action-btn" data-post-id="${post.id}"
            data-receiver-id="${post.user_id || ''}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
            <span class="post-action-value mono"
              data-tips="${post.id}"
              data-total="${post.tips_received || 0}">
              ${formatAurum(post.tips_received || 0)}
            </span>
          </button>

          <!-- Cheer (Gold Button) -->
          <button class="btn-cheer post-action-btn ${post.user_cheered ? 'cheered' : ''}"
            data-post-id="${post.id}"
            ${post.user_cheered ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24"
              fill="${post.user_cheered ? 'var(--color-gold)' : 'none'}"
              stroke="var(--color-gold)" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02
                12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span class="cheer-count post-action-value mono">${cheers}</span>
          </button>

          <!-- Comments (disabled — placeholder, not yet built) -->
          <button class="post-action-btn" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <span class="post-action-value mono">${post.comments || 0}</span>
          </button>

          <!-- Stake status -->
          <div class="post-stake-status" style="margin-left:auto;">
            <span style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;
              color:${stakeColor};">
              ${stakeStatus}
            </span>
          </div>

        </div>
      </div>
    `;
  },

  skeletons(count) {
    return Array(count).fill(`
      <div class="post-card card">
        <div class="post-header">
          <div class="skeleton" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <div class="skeleton" style="height:14px;width:120px;"></div>
            <div class="skeleton" style="height:10px;width:80px;"></div>
          </div>
          <div class="skeleton" style="width:48px;height:40px;border-radius:8px;"></div>
        </div>
        <div class="skeleton" style="height:14px;width:100%;margin-top:12px;"></div>
        <div class="skeleton" style="height:14px;width:80%;margin-top:6px;"></div>
        <div class="skeleton" style="height:14px;width:60%;margin-top:6px;"></div>
        <div style="display:flex;gap:16px;margin-top:12px;padding-top:12px;
          border-top:1px solid var(--color-border);">
          <div class="skeleton" style="height:20px;width:60px;border-radius:4px;"></div>
          <div class="skeleton" style="height:20px;width:40px;border-radius:4px;"></div>
        </div>
      </div>
    `).join('');
  },

  applyStyles() {
    if (document.getElementById('ledger-styles')) return;
    const style = document.createElement('style');
    style.id = 'ledger-styles';
    style.textContent = `
      .ledger-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-4);
      }

      .composer {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .composer-top {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
      }

      .composer-input-wrap { flex: 1; }

      .composer-input {
        width: 100%;
        background: transparent;
        border: none;
        color: var(--color-text);
        font-size: var(--text-base);
        resize: none;
        outline: none;
        line-height: 1.6;
        min-height: 40px;
        font-family: var(--font-body);
      }

      .composer-input::placeholder { color: var(--color-text-dim); }

      .composer-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-top: var(--space-3);
        border-top: 1px solid var(--color-border);
      }

      .stake-selector {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .stake-label {
        font-size: var(--text-xs);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .stake-select {
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-gold);
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        padding: var(--space-1) var(--space-2);
        cursor: pointer;
      }

      .feed {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .post-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .post-header {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
      }

      .post-meta {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }

      .post-username {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        color: var(--color-text);
        display: flex;
        align-items: center;
        gap: var(--space-1);
      }

      .post-sub {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .post-time {
        font-size: 10px;
        color: var(--color-text-muted);
        letter-spacing: 0.04em;
      }

      .post-stake {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: var(--space-2) var(--space-3);
        border: 1px solid;
        border-radius: var(--radius-md);
        flex-shrink: 0;
      }

      .post-stake-amount {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        line-height: 1;
      }

      .post-stake-label {
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .post-content {
        font-size: var(--text-base);
        color: var(--color-text);
        line-height: 1.6;
      }

      .post-media {
        width: 100%;
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
        max-height: 240px;
        object-fit: cover;
      }

      .post-actions {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        padding-top: var(--space-2);
        border-top: 1px solid var(--color-border);
      }

      .post-action-btn {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        transition: color var(--transition-base);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
      }

      .post-action-btn:hover { color: var(--color-gold); }

      .post-action-value { font-size: var(--text-xs); }

      /* Cheer active state */
      .btn-cheer.cheered { color: var(--color-gold); }
      .btn-cheer:not(:disabled):hover { color: var(--color-gold); }
    `;
    document.head.appendChild(style);
  },
};

/* ---- Mock posts fallback ---- */
function getMockPosts() {
  return [
    {
      id: '1',
      username: 'ShadowKing',
      league: 'sovereign',
      verified: true,
      content: 'Just closed a $84K SaaS contract. Three months of cold outreach paid off.',
      stake_amount: 100,
      stake_status: 'verified',
      tips_received: 1240,
      cheers: 47,
      comments: 18,
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: '2',
      username: 'NovaBuild',
      league: 'gold',
      verified: true,
      content: 'Hit $10K MRR on my B2B tool. 8 months from zero. No investors. No co-founder.',
      stake_amount: 50,
      stake_status: 'verified',
      tips_received: 870,
      cheers: 31,
      comments: 31,
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      id: '3',
      username: 'IronFounder',
      league: 'gold',
      verified: false,
      content: 'First enterprise client signed. $2K/month recurring.',
      stake_amount: 25,
      stake_status: 'pending',
      tips_received: 340,
      cheers: 12,
      comments: 9,
      created_at: new Date(Date.now() - 14400000).toISOString(),
    },
    {
      id: '4',
      username: 'ZeroToOne',
      league: 'silver',
      verified: false,
      content: 'Crossed $1K saved for the first time. Small win. But it\'s on the board.',
      stake_amount: 5,
      stake_status: 'verified',
      tips_received: 95,
      cheers: 8,
      comments: 22,
      created_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ];
}

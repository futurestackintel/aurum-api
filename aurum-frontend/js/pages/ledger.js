/* ============================================
   AURUM — The Ledger (Main Feed)
   Achievement posts, tips, proof of stake.
============================================ */

window.LedgerPage = {
  container: null,
  page: 1,
  loading: false,
  initialized: false,

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    // Only rebuild DOM once
    if (!this.initialized) {
      this.render();
      this.loadPosts();
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="ledger-wrap">

        <!-- Post composer -->
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
        <div class="feed" id="ledger-feed">
          <!-- Posts load here -->
        </div>

        <!-- Load more -->
        <div style="padding: var(--space-6); text-align:center;" id="load-more-wrap">
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
      avatar.textContent = App.user.username.charAt(0).toUpperCase();
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
    const btn = document.getElementById('btn-post');
    if (btn) btn.addEventListener('click', () => this.submitPost());

    /* Load more */
    const loadMore = document.getElementById('btn-load-more');
    if (loadMore) loadMore.addEventListener('click', () => {
      this.page++;
      this.loadPosts(true);
    });
  },

  async loadPosts(append = false) {
    if (this.loading) return;
    this.loading = true;

    const feed = document.getElementById('ledger-feed');
    if (!feed) return;

    if (!append) {
      feed.innerHTML = this.skeletons(3);
    }

    try {
      const data = await AURUM.LedgerAPI.getFeed(this.page);
      const posts = data.posts || getMockPosts();
      if (!append) feed.innerHTML = '';
      posts.forEach(post => {
        feed.insertAdjacentHTML('beforeend', this.postHTML(post));
      });
    } catch (err) {
      if (!append) {
        const posts = getMockPosts();
        feed.innerHTML = '';
        posts.forEach(post => {
          feed.insertAdjacentHTML('beforeend', this.postHTML(post));
        });
      }
    } finally {
      this.loading = false;
      this.bindPostEvents();
    }
  },

  async submitPost() {
    const content = document.getElementById('post-content')?.value.trim();
    const stake = document.getElementById('post-stake')?.value;
    const btn = document.getElementById('btn-post');

    if (!content) {
      AURUM.showToast('Write something worth staking.', 'error');
      return;
    }

    btn.textContent = 'Posting...';
    btn.disabled = true;

    try {
      await AURUM.LedgerAPI.createPost({ content, stake_amount: parseFloat(stake) });
      document.getElementById('post-content').value = '';
      document.getElementById('post-content').style.height = 'auto';
      this.page = 1;
      this.loadPosts(false);
      AURUM.showToast('Win posted. Stake locked.', 'gold');
    } catch (err) {
      AURUM.showToast(err.message || 'Post failed.', 'error');
    } finally {
      btn.textContent = 'Post Win';
      btn.disabled = false;
    }
  },

  bindPostEvents() {
    /* Tip buttons */
    document.querySelectorAll('.btn-tip').forEach(btn => {
      btn.addEventListener('click', async () => {
        const postId = btn.dataset.postId;
        const amount = 1; // default $1 tip
        try {
          await AURUM.TipsAPI.initialize({ post_id: postId, amount });
          AURUM.showToast('Tip sent!', 'success');
          const counter = document.querySelector(`[data-tips="${postId}"]`);
          if (counter) {
            counter.textContent = AURUM.formatAmount(
              parseFloat(counter.dataset.total || 0) + amount
            );
          }
        } catch (err) {
          AURUM.showToast('Tip failed.', 'error');
        }
      });
    });
  },

  postHTML(post) {
    const initials = post.username?.charAt(0).toUpperCase() || '?';
    const league = post.league || 'bronze';
    const stakeStatus = post.stake_status || 'pending';
    const stakeColor = {
      verified: 'var(--color-success)',
      pending:  'var(--color-gold)',
      disputed: 'var(--color-danger)'
    }[stakeStatus] || 'var(--color-text-muted)';

    return `
      <div class="post-card card fade-in">
        <div class="post-header">
          <div class="avatar avatar-sm ${league === 'sovereign' ? 'avatar-gold' : ''}">
            ${initials}
          </div>
          <div class="post-meta">
            <div class="post-username">
              ${post.username || 'Anonymous'}
              ${post.verified ? '<span style="color:var(--color-gold);font-size:10px;">✦</span>' : ''}
            </div>
            <div class="post-sub">
              <span class="badge ${AURUM.getLeagueBadge(league)}" style="font-size:9px;">
                ${league}
              </span>
              <span class="post-time">${AURUM.timeAgo(post.created_at || new Date())}</span>
            </div>
          </div>
          <div class="post-stake" style="border-color:${stakeColor}">
            <span class="post-stake-amount mono" style="color:${stakeColor}">
              $${post.stake_amount || 5}
            </span>
            <span class="post-stake-label">stake</span>
          </div>
        </div>

        <p class="post-content">${post.content || ''}</p>

        ${post.media_url ? `
          <img src="${post.media_url}" class="post-media" alt="Achievement proof" />
        ` : ''}

        <div class="post-actions">
          <button class="btn-tip post-action-btn" data-post-id="${post.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
            <span
              class="post-action-value mono"
              data-tips="${post.id}"
              data-total="${post.tips_received || 0}"
            >${AURUM.formatAmount(post.tips_received || 0)}</span>
          </button>

          <button class="post-action-btn" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <span class="post-action-value mono">${post.comments || 0}</span>
          </button>

          <div class="post-stake-status">
            <span style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;color:${stakeColor};">
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
        </div>
        <div class="skeleton" style="height:14px;width:100%;margin-top:12px;"></div>
        <div class="skeleton" style="height:14px;width:80%;margin-top:6px;"></div>
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

      /* Composer */
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

      .composer-input-wrap {
        flex: 1;
      }

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
      }

      .composer-input::placeholder {
        color: var(--color-text-dim);
      }

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

      /* Feed */
      .feed {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      /* Post card */
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

      .post-action-btn:hover {
        color: var(--color-gold);
      }

      .post-action-value {
        font-size: var(--text-xs);
      }

      .post-stake-status {
        margin-left: auto;
      }
    `;
    document.head.appendChild(style);
  }
};

/* Mock posts for when API isn't live */
function getMockPosts() {
  return [
    {
      id: '1',
      username: 'ShadowKing',
      league: 'sovereign',
      verified: true,
      content: 'Just closed a $84K SaaS contract. Three months of cold outreach paid off. The board doesn\'t lie.',
      stake_amount: 100,
      stake_status: 'verified',
      tips_received: 1240,
      comments: 18,
      created_at: new Date(Date.now() - 3600000).toISOString()
    },
    {
      id: '2',
      username: 'NovaBuild',
      league: 'gold',
      verified: true,
      content: 'Hit $10K MRR on my B2B tool. 8 months from zero. No investors. No co-founder. Just shipping.',
      stake_amount: 50,
      stake_status: 'verified',
      tips_received: 870,
      comments: 31,
      created_at: new Date(Date.now() - 7200000).toISOString()
    },
    {
      id: '3',
      username: 'IronFounder',
      league: 'gold',
      verified: false,
      content: 'First enterprise client signed. $2K/month recurring. This is just the beginning.',
      stake_amount: 25,
      stake_status: 'pending',
      tips_received: 340,
      comments: 9,
      created_at: new Date(Date.now() - 14400000).toISOString()
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
      comments: 22,
      created_at: new Date(Date.now() - 86400000).toISOString()
    }
  ];
}
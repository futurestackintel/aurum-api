/* ============================================
   AURUM — Full Leaderboard Page — Module G
   Real data, stealth mode, skeleton loaders.
============================================ */

window.LeaderboardPage = {
  container:    null,
  initialized:  false,
  currentBoard: 'earners',
  cachedBoards: {},

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadBoard('earners');
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="lb-page-wrap">

        <!-- Header -->
        <div class="lb-page-header">
          <p class="section-eyebrow">Live Rankings</p>
          <h2 class="lb-page-title">The Leaderboard</h2>
          <span class="live-dot">
            <span class="live-pulse"></span>
            Live
          </span>
        </div>

        <!-- Your rank card -->
        <div class="your-rank-card card card-gold" id="your-rank-card">
          <div style="display:flex;align-items:center;gap:var(--space-3);">
            <div class="avatar avatar-sm avatar-gold" id="lb-user-avatar">—</div>
            <div style="flex:1;">
              <p style="font-size:var(--text-sm);font-weight:var(--weight-medium);
                color:var(--color-text);" id="lb-username">—</p>
              <div style="display:flex;align-items:center;gap:var(--space-2);
                margin-top:var(--space-1);">
                <span class="badge badge-muted" id="lb-league"
                  style="font-size:9px;">—</span>
                <span style="font-size:10px;color:var(--color-text-muted);">
                  Score: <span class="mono" id="lb-user-score">—</span>
                </span>
              </div>
            </div>
            <div style="text-align:right;">
              <p class="mono" style="font-size:var(--text-xl);color:var(--color-gold);"
                id="lb-your-rank">#—</p>
              <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;
                color:var(--color-text-muted);">Your Rank</p>
            </div>
          </div>
        </div>

        <!-- Board tabs -->
        <div class="board-tabs">
          <button class="board-tab active" data-board="earners">Top Earners</button>
          <button class="board-tab" data-board="generous">Most Generous</button>
          <button class="board-tab" data-board="champions">Challenge Wins</button>
        </div>

        <!-- Board list -->
        <div class="lb-full-list" id="lb-full-list"></div>

      </div>
    `;

    this.applyStyles();
    this.bindEvents();
    this.setUserCard();
  },

  setUserCard() {
    const user = window.App?.user;
    if (!user) return;

    const username = user.username || user.firstName || '?';
    const league   = user.league   || 'Bronze';
    const score    = user.aurum_score || 0;

    const avatar   = document.getElementById('lb-user-avatar');
    const nameEl   = document.getElementById('lb-username');
    const leagueEl = document.getElementById('lb-league');
    const scoreEl  = document.getElementById('lb-user-score');

    if (avatar)   avatar.textContent   = username.charAt(0).toUpperCase();
    if (nameEl)   nameEl.textContent   = username;
    if (scoreEl)  scoreEl.textContent  = AURUM.formatNumber(score);
    if (leagueEl) {
      leagueEl.textContent = league;
      leagueEl.className   = `badge ${AURUM.getLeagueBadge(league)}`;
      leagueEl.style.fontSize = '9px';
    }

    /* Rank is populated after board loads — set placeholder */
    const rankEl = document.getElementById('lb-your-rank');
    if (rankEl) rankEl.textContent = '#—';
  },

  bindEvents() {
    document.querySelectorAll('.board-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.board-tab')
          .forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentBoard = tab.dataset.board;
        this.loadBoard(tab.dataset.board);
      });
    });
  },

  async loadBoard(type) {
    const list = document.getElementById('lb-full-list');
    if (!list) return;

    /* Show cached instantly while refetching */
    if (this.cachedBoards[type]) {
      this.renderBoard(this.cachedBoards[type], type);
    } else {
      list.innerHTML = this.skeletons(7);
    }

    try {
      const data    = await AURUM.LeaderboardAPI.getFull(type);
      const entries = data.entries || data[type] || [];

      if (entries.length) {
        this.cachedBoards[type] = entries;
        this.renderBoard(entries, type);
        this.updateUserRank(entries, type);
      } else {
        /* API returned empty — use mock */
        const mock = getMockLeaderboardFull(type);
        this.renderBoard(mock, type);
      }
    } catch (err) {
      if (!this.cachedBoards[type]) {
        this.renderBoard(getMockLeaderboardFull(type), type);
      }
    }
  },

  updateUserRank(entries, type) {
    const user   = window.App?.user;
    if (!user) return;
    const rankEl = document.getElementById('lb-your-rank');
    if (!rankEl) return;

    const username = user.username || user.firstName;
    const index    = entries.findIndex(e =>
      e.username?.toLowerCase() === username?.toLowerCase()
    );

    if (index !== -1) {
      rankEl.textContent = `#${index + 1}`;
    } else {
      rankEl.textContent = '#—';
    }
  },

  renderBoard(entries, type) {
    const list = document.getElementById('lb-full-list');
    if (!list) return;

    const labels = {
      earners:   'earned',
      generous:  'given',
      champions: 'wins',
    };
    const label = labels[type] || 'score';

    if (!entries.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📊</div>
          <h4>No data yet</h4>
          <p>The board fills as members compete.</p>
        </div>`;
      return;
    }

    list.innerHTML = entries.map((entry, index) => {
      const rank     = index + 1;
      const isTop3   = rank <= 3;
      const isStealth = entry.stealth || entry.hide_identity || false;

      const rankDisplay = rank === 1 ? '🥇'
        : rank === 2 ? '🥈'
        : rank === 3 ? '🥉'
        : `#${rank}`;

      const displayName    = isStealth ? 'Anonymous' : (entry.username || '—');
      const displayInitial = isStealth ? '◈'
        : (entry.initials || entry.username?.charAt(0)?.toUpperCase() || '?');

      const value = entry.value
        || entry.total_earned
        || entry.total_given
        || entry.challenge_wins
        || 0;

      /* Highlight current user's row */
      const currentUser = window.App?.user?.username;
      const isMe = !isStealth
        && currentUser
        && entry.username?.toLowerCase() === currentUser.toLowerCase();

      return `
        <div class="lb-full-item fade-in
          ${isTop3 ? 'lb-full-item-top' : ''}
          ${isMe   ? 'lb-full-item-me'  : ''}"
          style="animation-delay:${index * 50}ms;">

          <div class="lb-full-rank">${rankDisplay}</div>

          <div class="avatar avatar-sm ${isTop3 || isMe ? 'avatar-gold' : ''}">
            ${isStealth ? displayInitial : AURUM.avatarInnerHTML(entry.avatar_url, displayInitial)}
          </div>

          <div class="lb-full-info">
            <p class="lb-full-name">
              ${displayName}
              ${entry.verified && !isStealth
                ? '<span style="color:var(--color-gold);font-size:10px;">✦</span>'
                : ''}
              ${isMe
                ? '<span style="font-size:9px;color:var(--color-gold);'
                  + 'letter-spacing:0.06em;"> (you)</span>'
                : ''}
            </p>
            <div style="display:flex;align-items:center;gap:var(--space-2);">
              ${!isStealth ? `
                <span class="badge ${AURUM.getLeagueBadge(entry.league)}"
                  style="font-size:9px;">
                  ${entry.league || 'Bronze'}
                </span>
              ` : `
                <span class="badge badge-muted" style="font-size:9px;">
                  Hidden
                </span>
              `}
              ${!isStealth ? `
                <span style="font-size:10px;color:var(--color-text-muted);">
                  Score: <span class="mono">
                    ${AURUM.formatNumber(entry.aurum_score || 0)}
                  </span>
                </span>
              ` : ''}
            </div>
          </div>

          <div class="lb-full-value">
            <span class="mono" style="font-size:var(--text-lg);
              color:${isTop3 || isMe
                ? 'var(--color-gold)' : 'var(--color-text)'};">
              ${type === 'champions'
                ? AURUM.formatNumber(value)
                : AURUM.formatAmount(value)}
            </span>
            <span style="font-size:10px;letter-spacing:0.08em;
              text-transform:uppercase;color:var(--color-text-muted);">
              ${label}
            </span>
          </div>

        </div>
      `;
    }).join('');
  },

  skeletons(count) {
    return Array(count).fill(`
      <div style="display:flex;align-items:center;gap:12px;padding:12px;
        background:var(--color-surface);border:1px solid var(--color-border);
        border-radius:12px;">
        <div class="skeleton" style="width:28px;height:20px;border-radius:4px;"></div>
        <div class="skeleton" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;"></div>
        <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
          <div class="skeleton" style="height:14px;width:100px;"></div>
          <div class="skeleton" style="height:10px;width:70px;"></div>
        </div>
        <div class="skeleton" style="width:60px;height:24px;border-radius:4px;"></div>
      </div>
    `).join('');
  },

  applyStyles() {
    if (document.getElementById('lb-page-styles')) return;
    const style = document.createElement('style');
    style.id = 'lb-page-styles';
    style.textContent = `
      .lb-page-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
        padding: var(--space-4);
        position: relative;
      }

      .lb-page-wrap::before {
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

      .lb-page-header {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        padding-top: var(--space-2);
      }

      .lb-page-title {
        font-family: var(--font-display);
        font-size: var(--text-3xl);
        font-weight: var(--weight-light);
        background: linear-gradient(135deg, var(--color-text) 40%, var(--color-gold) 100%);
        -webkit-background-clip: text;
        background-clip: text;
        -webkit-text-fill-color: transparent;
      }

      .your-rank-card {
        background: linear-gradient(135deg,
          var(--color-surface), rgba(201,168,76,0.05));
      }

      .board-tabs {
        display: flex;
        gap: var(--space-2);
        border-bottom: 1px solid var(--color-border);
        padding-bottom: var(--space-3);
      }

      .board-tab {
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

      .board-tab.active {
        color: var(--color-gold);
        background: var(--color-gold-glow);
      }

      .lb-full-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .lb-full-item {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--color-surface);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        transition: border-color var(--transition-base);
      }

      .lb-full-item:hover {
        border-color: var(--color-border-gold);
      }

      .lb-full-item-top {
        background: linear-gradient(135deg,
          var(--color-surface), rgba(201,168,76,0.04));
        border-color: var(--color-border-gold);
      }

      /* Current user's row */
      .lb-full-item-me {
        border-color: var(--color-gold);
        background: linear-gradient(135deg,
          var(--color-surface), rgba(201,168,76,0.08));
      }

      .lb-full-rank {
        width: 32px;
        text-align: center;
        font-size: var(--text-lg);
        flex-shrink: 0;
      }

      .lb-full-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
      }

      .lb-full-name {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        color: var(--color-text);
        display: flex;
        align-items: center;
        gap: var(--space-1);
      }

      .lb-full-value {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
        flex-shrink: 0;
      }

      /* Live dot */
      .live-dot {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-xs);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-success);
        margin-top: var(--space-1);
      }

      .live-pulse {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--color-success);
        animation: livePulse 1.5s ease-in-out infinite;
        flex-shrink: 0;
      }

      @keyframes livePulse {
        0%, 100% { opacity: 1; transform: scale(1); }
        50%       { opacity: 0.4; transform: scale(1.4); }
      }
    `;
    document.head.appendChild(style);
  },
};

/* ---- Mock fallback ---- */
function getMockLeaderboardFull(type) {
  return [
    { username: 'ShadowKing', initials: 'SK', league: 'Sovereign', value: 284000, aurum_score: 9840, verified: true  },
    { username: 'NovaBuild',  initials: 'NB', league: 'Gold',      value: 197500, aurum_score: 8210, verified: true  },
    { stealth: true,                           league: 'Sovereign', value: 156000, aurum_score: 7650                  },
    { username: 'IronFounder',initials: 'IF', league: 'Gold',      value: 134200, aurum_score: 6890, verified: false },
    { username: 'ZeroToOne',  initials: 'ZO', league: 'Silver',    value: 98700,  aurum_score: 5420, verified: false },
    { username: 'ApexStar',   initials: 'AS', league: 'Gold',      value: 87300,  aurum_score: 4980, verified: true  },
    { username: 'VaultMind',  initials: 'VM', league: 'Silver',    value: 65100,  aurum_score: 3760, verified: false },
    { username: 'CodeEmpire', initials: 'CE', league: 'Bronze',    value: 43200,  aurum_score: 2840, verified: false },
    { username: 'RiseFirst',  initials: 'RF', league: 'Bronze',    value: 28900,  aurum_score: 1920, verified: false },
    { username: 'BuildMode',  initials: 'BM', league: 'Bronze',    value: 14500,  aurum_score: 980,  verified: false },
  ];
}

/* ============================================
   AURUM — Full Leaderboard Page
============================================ */

window.LeaderboardPage = {
  container: null,
  initialized: false,
  currentBoard: 'earners',

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
              <p style="font-size:var(--text-sm);font-weight:var(--weight-medium);color:var(--color-text);" id="lb-username">—</p>
              <span class="badge badge-muted" id="lb-league" style="font-size:9px;">—</span>
            </div>
            <div style="text-align:right;">
              <p class="mono" style="font-size:var(--text-xl);color:var(--color-gold);" id="lb-your-rank">#—</p>
              <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-text-muted);">Your Rank</p>
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
        <div class="lb-full-list" id="lb-full-list">
        </div>
      </div>
    `;

    this.applyStyles();
    this.bindEvents();
    this.setUserCard();
  },

  setUserCard() {
    const user = window.App?.user;
    if (!user) return;
    const avatar = document.getElementById('lb-user-avatar');
    const username = document.getElementById('lb-username');
    const league = document.getElementById('lb-league');
    if (avatar) avatar.textContent = user.username?.charAt(0).toUpperCase() || '?';
    if (username) username.textContent = user.username || '—';
    if (league) {
      league.textContent = user.league || 'Bronze';
      league.className = `badge ${AURUM.getLeagueBadge(user.league)} `;
      league.style.fontSize = '9px';
    }
  },

  bindEvents() {
    document.querySelectorAll('.board-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.board-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        this.currentBoard = tab.dataset.board;
        this.loadBoard(tab.dataset.board);
      });
    });
  },

  async loadBoard(type) {
    const list = document.getElementById('lb-full-list');
    if (!list) return;

    list.innerHTML = this.skeletons(7);

    try {
      const data = await AURUM.LeaderboardAPI.getFull(type);
      const entries = data.entries || getMockLeaderboardFull(type);
      this.renderBoard(entries, type);
    } catch (err) {
      this.renderBoard(getMockLeaderboardFull(type), type);
    }
  },

  renderBoard(entries, type) {
    const list = document.getElementById('lb-full-list');
    if (!list) return;

    const labels = { earners: 'earned', generous: 'given', champions: 'wins' };
    const label = labels[type] || 'score';

    list.innerHTML = entries.map((entry, index) => {
      const rank = index + 1;
      const isTop3 = rank <= 3;
      const rankDisplay = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `#${rank}`;

      return `
        <div class="lb-full-item fade-in ${isTop3 ? 'lb-full-item-top' : ''}"
          style="animation-delay:${index * 50}ms">
          <div class="lb-full-rank">${rankDisplay}</div>
          <div class="avatar avatar-sm ${isTop3 ? 'avatar-gold' : ''}">
            ${entry.stealth ? '◈' : entry.initials || '?'}
          </div>
          <div class="lb-full-info">
            <p class="lb-full-name">
              ${entry.stealth ? 'Anonymous' : entry.username || '—'}
              ${entry.verified ? '<span style="color:var(--color-gold);font-size:10px;">✦</span>' : ''}
            </p>
            <div style="display:flex;align-items:center;gap:var(--space-2);">
              <span class="badge ${AURUM.getLeagueBadge(entry.league)}" style="font-size:9px;">
                ${entry.league || 'Bronze'}
              </span>
              <span style="font-size:10px;color:var(--color-text-muted);">
                Score: <span class="mono">${AURUM.formatNumber(entry.aurum_score || 0)}</span>
              </span>
            </div>
          </div>
          <div class="lb-full-value">
            <span class="mono" style="font-size:var(--text-lg);color:${isTop3 ? 'var(--color-gold)' : 'var(--color-text)'};">
              ${AURUM.formatAmount(entry.value || 0)}
            </span>
            <span style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-text-muted);">
              ${label}
            </span>
          </div>
        </div>
      `;
    }).join('');
  },

  skeletons(count) {
    return Array(count).fill(`
      <div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--color-surface);border:1px solid var(--color-border);border-radius:12px;">
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
        gap: var(--space-4);
        padding: var(--space-4);
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
        color: var(--color-text);
      }

      .your-rank-card {
        background: linear-gradient(135deg, var(--color-surface), rgba(201,168,76,0.05));
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
        background: linear-gradient(135deg, var(--color-surface), rgba(201,168,76,0.04));
        border-color: var(--color-border-gold);
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
    `;
    document.head.appendChild(style);
  }
};

function getMockLeaderboardFull(type) {
  const labels = { earners: 'earned', generous: 'given', champions: 'wins' };
  return [
    { username: 'ShadowKing', initials: 'SK', league: 'Sovereign', value: 284000, aurum_score: 9840, verified: true },
    { username: 'NovaBuild', initials: 'NB', league: 'Gold', value: 197500, aurum_score: 8210, verified: true },
    { stealth: true, league: 'Sovereign', value: 156000, aurum_score: 7650 },
    { username: 'IronFounder', initials: 'IF', league: 'Gold', value: 134200, aurum_score: 6890, verified: false },
    { username: 'ZeroToOne', initials: 'ZO', league: 'Silver', value: 98700, aurum_score: 5420, verified: false },
    { username: 'ApexStar', initials: 'AS', league: 'Gold', value: 87300, aurum_score: 4980, verified: true },
    { username: 'VaultMind', initials: 'VM', league: 'Silver', value: 65100, aurum_score: 3760, verified: false },
    { username: 'CodeEmpire', initials: 'CE', league: 'Bronze', value: 43200, aurum_score: 2840, verified: false },
    { username: 'RiseFirst', initials: 'RF', league: 'Bronze', value: 28900, aurum_score: 1920, verified: false },
    { username: 'BuildMode', initials: 'BM', league: 'Bronze', value: 14500, aurum_score: 980, verified: false },
  ];
}
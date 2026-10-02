function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window.SearchPage = {
  currentTab: 'users',
  requestId: 0,
  lastResults: { users: [], crews: [], posts: [] },

  init(containerId) {
    const el = document.getElementById(containerId);
    el.innerHTML = `
      <div class="search-page">
        <div class="search-page-header">
          <span class="section-eyebrow">Discover</span>
          <h1 class="search-page-title">Search</h1>
        </div>
        <div class="search-input-wrap">
          <svg class="search-input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="text" id="search-input" placeholder="Search users, crews, posts..." class="search-input" />
        </div>
        <div class="search-tabs">
          <button class="search-tab active" data-tab="users">Users</button>
          <button class="search-tab" data-tab="crews">Crews</button>
          <button class="search-tab" data-tab="posts">Posts</button>
        </div>
        <div id="search-results" class="search-results"></div>
      </div>
    `;

    const input = document.getElementById('search-input');
    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => this.runSearch(input.value.trim()), 350);
    });

    document.querySelectorAll('.search-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.search-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        this.currentTab = btn.dataset.tab;
        this.renderResults();
      });
    });

    const results = document.getElementById('search-results');
    const activateRow = (row) => {
      if (row.matches('.search-post-open')) {
        window.LedgerPage?.openPostById(row.dataset.postId);
      } else if (row.matches('.search-crew-open')) {
        App.navigate('arena');
        setTimeout(() => {
          document.querySelector('.arena-section-tab[data-section="crews"]')?.click();
          setTimeout(() => window.ArenaPage?.openCrewDetail(row.dataset.crewId), 80);
        }, 80);
      }
    };
    results.addEventListener('click', (e) => {
      const btn = e.target.closest('.search-message-btn');
      if (btn) { this.messageUser(btn.dataset.userId, btn.dataset.username, btn.dataset.avatar); return; }
      const profile = e.target.closest('.search-profile-btn');
      if (profile) { App.openPublicProfile(profile.dataset.username); return; }
      const row = e.target.closest('.search-post-open, .search-crew-open');
      if (row) activateRow(row);
    });
    results.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const row = e.target.closest('.search-post-open, .search-crew-open');
      if (!row) return;
      e.preventDefault();
      activateRow(row);
    });
  },

  async messageUser(userId, username, avatarUrl) {
    try {
      const { channel_id } = await AURUM.DmAPI.getOrCreateChannel(userId);
      App.navigate('messages');
      window.DmPage.openThread(channel_id, username, avatarUrl);
    } catch (err) {
      showToast('Could not start conversation', 'error');
    }
  },

  async runSearch(q) {
    const requestId = ++this.requestId;
    const resultsEl = document.getElementById('search-results');
    if (q.length < 2) {
      resultsEl.innerHTML = '<div class="search-empty"><span>Type at least 2 characters...</span></div>';
      return;
    }
    resultsEl.innerHTML = `
      <div class="search-status">
        <span class="search-status-dot"></span><span class="search-status-dot"></span><span class="search-status-dot"></span>
      </div>
    `;
    try {
      const data = await SearchAPI.search(q);
      if (requestId !== this.requestId) return;
      this.lastResults = data;
      this.renderResults();
    } catch (err) {
      if (requestId !== this.requestId) return;
      resultsEl.innerHTML = '<div class="search-empty">Search failed. Try again.</div>';
    }
  },

  renderResults() {
    const resultsEl = document.getElementById('search-results');
    const items = this.lastResults[this.currentTab] || [];
    if (items.length === 0) {
      resultsEl.innerHTML = `
        <div class="search-empty">
          <svg class="search-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <span>No results</span>
        </div>
      `;
      return;
    }
    if (this.currentTab === 'users') {
      resultsEl.innerHTML = items.map((u, i) => `
        <div class="search-result-row" style="animation-delay:${i * 40}ms">
          <div class="avatar avatar-sm search-result-avatar">${AURUM.avatarInnerHTML(u.avatar_url, escapeHTML(u.username).charAt(0).toUpperCase())}</div>
          <div class="search-result-body">
            <button class="search-result-title search-profile-btn" data-username="${escapeHTML(u.username)}">${escapeHTML(u.username)}</button>
            ${u.league ? `<span class="search-result-sub">${escapeHTML(u.league)} League</span>` : ''}
            ${u.aurum_score != null ? `<span class="search-result-sub">Score ${escapeHTML(u.aurum_score)}</span>` : ''}
          </div>
          <button class="search-message-btn" data-user-id="${escapeHTML(u.id)}" data-username="${escapeHTML(u.username)}" data-avatar="${escapeHTML(u.avatar_url || '')}">Message</button>
        </div>
      `).join('');
    } else if (this.currentTab === 'crews') {
      resultsEl.innerHTML = items.map((c, i) => `
          <div class="search-result-row search-crew-open" data-crew-id="${escapeHTML(c.id)}" role="button" tabindex="0" style="animation-delay:${i * 40}ms">
          <div class="search-result-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M17 20v-2a4 4 0 00-4-4H7a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 20v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/></svg>
          </div>
          <div class="search-result-body">
            <span class="search-result-title">${escapeHTML(c.name)}</span>
            <span class="search-result-sub">${c.member_count} members</span>
          </div>
        </div>
      `).join('');
    } else {
      resultsEl.innerHTML = items.map((p, i) => `
        <div class="search-result-row search-result-row-post search-post-open" data-post-id="${escapeHTML(p.id)}" role="button" tabindex="0" style="animation-delay:${i * 40}ms">
          <span class="search-result-quote">&ldquo;</span>
          <div class="search-result-body">
            <span class="search-result-title">${escapeHTML(p.author_username)}</span>
            <span class="search-result-sub">${escapeHTML(p.content).slice(0, 80)}</span>
          </div>
        </div>
      `).join('');
    }
  },
};

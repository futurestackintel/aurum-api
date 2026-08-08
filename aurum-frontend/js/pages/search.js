window.SearchPage = {
  currentTab: 'users',
  lastResults: { users: [], crews: [], posts: [] },

  init(containerId) {
    const el = document.getElementById(containerId);
    el.innerHTML = `
      <div class="search-page">
        <input type="text" id="search-input" placeholder="Search users, crews, posts..." class="search-input" />
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
  },

  async runSearch(q) {
    const resultsEl = document.getElementById('search-results');
    if (q.length < 2) {
      resultsEl.innerHTML = '<div class="search-empty">Type at least 2 characters...</div>';
      return;
    }
    resultsEl.innerHTML = '<div class="search-empty">Searching...</div>';
    try {
      const data = await SearchAPI.search(q);
      this.lastResults = data;
      this.renderResults();
    } catch (err) {
      resultsEl.innerHTML = '<div class="search-empty">Search failed. Try again.</div>';
    }
  },

  renderResults() {
    const resultsEl = document.getElementById('search-results');
    const items = this.lastResults[this.currentTab] || [];
    if (items.length === 0) {
      resultsEl.innerHTML = '<div class="search-empty">No results</div>';
      return;
    }
    if (this.currentTab === 'users') {
      resultsEl.innerHTML = items.map(u => `
        <div class="search-result-row">
          <span class="search-result-title">${escapeHTML(u.username)}</span>
          <span class="search-result-sub">${u.league ? escapeHTML(u.league) : ''}</span>
        </div>
      `).join('');
    } else if (this.currentTab === 'crews') {
      resultsEl.innerHTML = items.map(c => `
        <div class="search-result-row">
          <span class="search-result-title">${escapeHTML(c.name)}</span>
          <span class="search-result-sub">${c.member_count} members</span>
        </div>
      `).join('');
    } else {
      resultsEl.innerHTML = items.map(p => `
        <div class="search-result-row">
          <span class="search-result-title">${escapeHTML(p.author_username)}</span>
          <span class="search-result-sub">${escapeHTML(p.content).slice(0, 80)}</span>
        </div>
      `).join('');
    }
  },
};

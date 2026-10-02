window.PublicProfilePage = {
  username: null,
  standalone: false,
  async open(containerId, username, standalone = false) {
    this.container = document.getElementById(containerId);
    this.username = username;
    this.standalone = standalone;
    if (!this.container) return;
    this.applyStyles();
    this.container.innerHTML = '<p class="dm-loading-text">Loading profile…</p>';
    try {
      const profile = await AURUM.ProfileAPI.getPassport(username);
      if (this.username !== username) return;
      const badges = (profile.badges || []).map(b => `<span class="badge badge-gold">${this.escape(b.badge_type)}</span>`).join(' ');
      this.container.innerHTML = `
        <section class="profile-wrap public-profile-view">
          <button class="btn btn-ghost" id="public-profile-back">← Back</button>
          <header class="profile-header">
            <div class="avatar avatar-xl">${AURUM.avatarInnerHTML(profile.avatar_url, this.escape(profile.username).charAt(0).toUpperCase())}</div>
            <div class="profile-identity"><h2 class="profile-username">${this.escape(profile.username)}</h2>
              ${profile.verified ? '<span class="badge badge-gold">Verified</span>' : ''}</div>
          </header>
          <div class="profile-stats">
            <div class="profile-stat card card-sm"><span class="profile-stat-value">${profile.aurum_score == null ? 'Hidden' : this.escape(profile.aurum_score)}</span><span class="profile-stat-label">AURUM Score</span></div>
            <div class="profile-stat card card-sm"><span class="profile-stat-value">${profile.league == null ? 'Hidden' : `${this.escape(profile.league)} League`}</span><span class="profile-stat-label">League</span></div>
            <div class="profile-stat card card-sm"><span class="profile-stat-value">${this.escape(profile.challenge_wins ?? 0)}</span><span class="profile-stat-label">Challenge wins</span></div>
            <div class="profile-stat card card-sm"><span class="profile-stat-value">${this.escape(profile.streak ?? 0)}</span><span class="profile-stat-label">Current streak</span></div>
            <div class="profile-stat card card-sm"><span class="profile-stat-value">${this.escape(profile.total_tips_given ?? 0)}</span><span class="profile-stat-label">Tips given</span></div>
          </div>
          <section class="profile-section"><h3 class="profile-section-title">Badges</h3>${badges || '<p>No public badges.</p>'}</section>
          <div class="public-profile-actions">
            <button class="btn btn-primary" id="public-profile-message">Message</button>
            <a class="btn btn-outline" href="/passport/${encodeURIComponent(profile.username)}" target="_blank" rel="noopener">Wealth Passport</a>
            <a class="btn btn-ghost" href="/public-profile.html?username=${encodeURIComponent(profile.username)}" target="_blank" rel="noopener">Share profile</a>
          </div>
          <section class="profile-section"><h3 class="profile-section-title">Public activity</h3><div id="public-profile-posts"><p>Loading posts…</p></div></section>
        </section>`;
      this.container.querySelector('#public-profile-back')?.addEventListener('click', () => this.close());
      this.container.querySelector('#public-profile-message')?.addEventListener('click', () => this.startMessage(profile));
      if (window.App?.pendingProfileMessage?.toLowerCase() === profile.username.toLowerCase()) {
        window.App.pendingProfileMessage = null;
        await this.startMessage(profile);
        return;
      }
      try {
        const { posts } = await AURUM.ProfileAPI.getPublicPosts(username);
        if (this.username !== username) return;
        const postsEl = this.container.querySelector('#public-profile-posts');
        postsEl.innerHTML = posts?.length ? posts.map(post => this.postHTML(post)).join('') : '<p>No public posts yet.</p>';
      } catch (_) {
        const postsEl = this.container.querySelector('#public-profile-posts');
        if (postsEl) postsEl.innerHTML = '<p>Public activity could not be loaded.</p>';
      }
    } catch (error) {
      if (this.username !== username) return;
      const needsSignIn = /sign in/i.test(error.message || '');
      const signInUrl = `/app.html?profile=${encodeURIComponent(username)}`;
      this.container.innerHTML = `<section class="profile-wrap"><button class="btn btn-ghost" id="public-profile-back">← Back</button><div class="empty-state"><h3>Profile unavailable</h3><p>${this.escape(error.message || 'This profile cannot be viewed.')}</p>${needsSignIn ? `<a class="btn btn-primary" href="${signInUrl}">Sign in to AURUM</a>` : ''}</div></section>`;
      this.container.querySelector('#public-profile-back')?.addEventListener('click', () => this.close());
    }
  },
  async startMessage(profile) {
    if (!window.App) {
      window.location.href = `/app.html?message=${encodeURIComponent(profile.username)}`;
      return;
    }
    try {
      let userId = profile.user_id;
      let avatar = profile.avatar_url;
      if (!userId) {
        const search = await SearchAPI.search(profile.username);
        const user = search.users?.find(u => u.username === profile.username);
        userId = user?.id;
        avatar = avatar || user?.avatar_url;
      }
      if (!userId) throw new Error('This user is not available to message.');
      const { channel_id } = await AURUM.DmAPI.getOrCreateChannel(userId);
      App.navigate('messages');
      window.DmPage?.openThread(channel_id, profile.username, avatar);
    } catch (error) { AURUM.showToast(error.message || 'Could not start conversation.', 'error'); }
  },
  postHTML(post) {
    let media = '';
    if (post.media_urls) {
      try {
        const url = new URL(post.media_urls, location.origin);
        if (url.protocol === 'https:' || url.protocol === 'http:') media = `<img class="public-profile-post-media" src="${this.escape(url.href)}" alt="Post evidence" loading="lazy">`;
      } catch (_) { /* Ignore malformed evidence URL. */ }
    }
    return `<article class="public-profile-post"><time>${this.escape(post.created_at ? new Date(post.created_at).toLocaleDateString() : '')}</time>${post.title ? `<h4>${this.escape(post.title)}</h4>` : ''}<p>${this.escape(post.content || '')}</p>${media}</article>`;
  },
  applyStyles() {
    if (document.getElementById('public-profile-styles')) return;
    const style = document.createElement('style');
    style.id = 'public-profile-styles';
    style.textContent = `.public-profile-view{display:grid;gap:20px;padding:var(--space-4)}.public-profile-view .profile-header{display:flex;align-items:center;gap:16px}.public-profile-view .profile-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(135px,1fr));gap:12px}.public-profile-view .profile-stat{padding:14px}.public-profile-actions{display:flex;flex-wrap:wrap;gap:12px}.public-profile-post{padding:14px;border:1px solid var(--color-border);border-radius:var(--radius-md);background:var(--color-surface)}.public-profile-post time{font-size:11px;color:var(--color-text-muted)}.public-profile-post p{white-space:pre-wrap;overflow-wrap:anywhere}.public-profile-post-media{display:block;max-width:100%;max-height:360px;object-fit:contain;border-radius:var(--radius-md);margin-top:10px}`;
    document.head.appendChild(style);
  },
  close() {
    if (this.standalone) { history.back(); return; }
    const query = new URLSearchParams(location.search);
    query.delete('profile');
    const suffix = query.toString();
    history.replaceState(history.state, '', `${location.pathname}${suffix ? `?${suffix}` : ''}`);
    App.navigate(App.publicProfileReturnView || 'search');
  },
  escape(value) {
    const node = document.createElement('span');
    node.textContent = value == null ? '' : String(value);
    return node.innerHTML;
  },
};

if (new URLSearchParams(location.search).has('username')) {
  window.addEventListener('DOMContentLoaded', () => {
    PublicProfilePage.open('public-profile-root', new URLSearchParams(location.search).get('username'), true);
  });
}

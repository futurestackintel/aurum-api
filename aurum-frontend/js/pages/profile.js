/* ============================================
   AURUM — Profile Page + Wealth Passport
============================================ */

window.ProfilePage = {
  container: null,
  initialized: false,
  user: null,

  init(containerId, user) {
    this.container = document.getElementById(containerId);
    this.user = user;
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadProfile();
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="profile-wrap">

        <!-- Profile header -->
        <div class="profile-header">
          <div class="profile-avatar-wrap">
            <div class="avatar avatar-xl avatar-gold" id="profile-avatar">—</div>
            <div class="profile-verified" id="profile-verified-badge" style="display:none;">✦</div>
          </div>
          <div class="profile-identity">
            <h3 class="profile-username" id="profile-username">—</h3>
            <span class="badge badge-muted" id="profile-league">—</span>
          </div>
          <button class="btn btn-ghost btn-sm" id="btn-sign-out">Sign Out</button>
        </div>

        <!-- Aurum Score -->
        <div class="score-card card card-gold">
          <div class="score-card-top">
            <div>
              <p style="font-size:var(--text-xs);letter-spacing:0.1em;text-transform:uppercase;color:var(--color-text-muted);">
                Aurum Score
              </p>
              <p class="mono" style="font-size:var(--text-4xl);color:var(--color-gold);line-height:1.1;" id="profile-score">—</p>
            </div>
            <div style="text-align:right;">
              <p style="font-size:var(--text-xs);letter-spacing:0.1em;text-transform:uppercase;color:var(--color-text-muted);">
                Streak
              </p>
              <p class="mono" style="font-size:var(--text-2xl);color:var(--color-text);" id="profile-streak">— days</p>
            </div>
          </div>
          <div class="score-bar-wrap">
            <div class="score-bar">
              <div class="score-bar-fill shimmer" id="score-bar-fill"></div>
            </div>
            <p style="font-size:10px;color:var(--color-text-muted);text-align:right;" id="score-next-league">
              — to next league
            </p>
          </div>
        </div>

        <!-- Stats grid -->
        <div class="profile-stats">
          <div class="profile-stat card card-sm">
            <span class="stat-value" id="stat-earned">—</span>
            <span class="stat-label">Total Earned</span>
          </div>
          <div class="profile-stat card card-sm">
            <span class="stat-value" id="stat-given">—</span>
            <span class="stat-label">Total Given</span>
          </div>
          <div class="profile-stat card card-sm">
            <span class="stat-value" id="stat-wins">—</span>
            <span class="stat-label">Challenge Wins</span>
          </div>
          <div class="profile-stat card card-sm">
            <span class="stat-value" id="stat-posts">—</span>
            <span class="stat-label">Posts</span>
          </div>
        </div>

        <!-- Badges -->
        <div class="card">
          <p class="profile-section-title">Achievement Badges</p>
          <div class="badges-grid" id="badges-grid">
            <div class="badge-item badge-item-locked">
              <span class="badge-item-icon">🥉</span>
              <span class="badge-item-name">Verified Builder</span>
            </div>
            <div class="badge-item badge-item-locked">
              <span class="badge-item-icon">🥈</span>
              <span class="badge-item-name">Verified Founder</span>
            </div>
            <div class="badge-item badge-item-locked">
              <span class="badge-item-icon">🥇</span>
              <span class="badge-item-name">Verified Millionaire</span>
            </div>
            <div class="badge-item badge-item-locked">
              <span class="badge-item-icon">💎</span>
              <span class="badge-item-name">Sovereign</span>
            </div>
          </div>
        </div>

        <!-- Wealth Passport -->
        <div class="card">
          <p class="profile-section-title">Wealth Passport</p>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:var(--space-4);">
            Your shareable achievement card.
          </p>

          <!-- Passport card -->
          <div class="passport-card" id="passport-card">
            <div class="passport-bg-grid"></div>
            <div class="passport-content">
              <div class="passport-top">
                <span class="passport-logo">AURUM</span>
                <span class="passport-tier" id="passport-tier">Explorer</span>
              </div>
              <div class="passport-avatar" id="passport-avatar">—</div>
              <div class="passport-name" id="passport-name">—</div>
              <div class="passport-league" id="passport-league">Bronze League</div>
              <div class="passport-stats">
                <div class="passport-stat">
                  <span class="passport-stat-value" id="pp-score">—</span>
                  <span class="passport-stat-label">Score</span>
                </div>
                <div class="passport-stat-div"></div>
                <div class="passport-stat">
                  <span class="passport-stat-value" id="pp-given">—</span>
                  <span class="passport-stat-label">Given</span>
                </div>
                <div class="passport-stat-div"></div>
                <div class="passport-stat">
                  <span class="passport-stat-value" id="pp-wins">—</span>
                  <span class="passport-stat-label">Wins</span>
                </div>
              </div>
              <div class="passport-footer">
                <span style="font-size:9px;letter-spacing:0.1em;color:rgba(201,168,76,0.5);">
                  aurum.app
                </span>
                <span class="passport-streak" id="pp-streak">— day streak 🔥</span>
              </div>
            </div>
          </div>

          <button class="btn btn-outline btn-full" style="margin-top:var(--space-4);" id="btn-share-passport">
            Share Wealth Passport
          </button>
        </div>

        <!-- Upgrade CTA (for free users) -->
        <div class="upgrade-card card card-gold" id="upgrade-cta" style="display:none;">
          <p class="profile-section-title gold">Upgrade to Contender</p>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:var(--space-4);">
            Join Drop Circles, get verified, and unlock boosted placement.
          </p>
          <button class="btn btn-primary btn-full">Upgrade — $29/mo</button>
        </div>

      </div>
    `;

    this.applyStyles();
    this.bindEvents();
  },

  async loadProfile() {
    try {
      const data = await AURUM.AuthAPI.me();
      this.user = { ...this.user, ...data.user };
    } catch (err) {
      /* Use existing user data */
    }
    this.populateProfile();
  },

  populateProfile() {
    const u = this.user || {};
    const username = u.username || u.firstName || 'Member';
    const league = u.league || 'Bronze';
    const score = u.aurum_score || 0;
    const streak = u.streak || 0;
    const tier = u.tier || 'explorer';

    /* Header */
    const avatar = document.getElementById('profile-avatar');
    if (avatar) avatar.textContent = username.charAt(0).toUpperCase();

    const usernameEl = document.getElementById('profile-username');
    if (usernameEl) usernameEl.textContent = username;

    const leagueEl = document.getElementById('profile-league');
    if (leagueEl) {
      leagueEl.textContent = league;
      leagueEl.className = `badge ${AURUM.getLeagueBadge(league)}`;
    }

    /* Score */
    const scoreEl = document.getElementById('profile-score');
    if (scoreEl) scoreEl.textContent = AURUM.formatNumber(score);

    const streakEl = document.getElementById('profile-streak');
    if (streakEl) streakEl.textContent = `${streak} days`;

    /* Score bar */
    const leagueThresholds = { bronze: 1000, silver: 5000, gold: 15000, sovereign: 50000 };
    const currentThreshold = leagueThresholds[league.toLowerCase()] || 1000;
    const percent = Math.min((score / currentThreshold) * 100, 100);
    const fill = document.getElementById('score-bar-fill');
    if (fill) fill.style.width = `${percent}%`;

    const nextLeague = document.getElementById('score-next-league');
    if (nextLeague) {
      const remaining = Math.max(currentThreshold - score, 0);
      nextLeague.textContent = `${AURUM.formatNumber(remaining)} points to next league`;
    }

    /* Stats */
    const earned = document.getElementById('stat-earned');
    const given = document.getElementById('stat-given');
    const wins = document.getElementById('stat-wins');
    const posts = document.getElementById('stat-posts');
    if (earned) earned.textContent = AURUM.formatAmount(u.total_earned || 0);
    if (given) given.textContent = AURUM.formatAmount(u.total_given || 0);
    if (wins) wins.textContent = u.challenge_wins || 0;
    if (posts) posts.textContent = u.post_count || 0;

    /* Passport */
    const pAvatar = document.getElementById('passport-avatar');
    const pName = document.getElementById('passport-name');
    const pLeague = document.getElementById('passport-league');
    const pTier = document.getElementById('passport-tier');
    const ppScore = document.getElementById('pp-score');
    const ppGiven = document.getElementById('pp-given');
    const ppWins = document.getElementById('pp-wins');
    const ppStreak = document.getElementById('pp-streak');

    if (pAvatar) pAvatar.textContent = username.charAt(0).toUpperCase();
    if (pName) pName.textContent = username;
    if (pLeague) pLeague.textContent = `${league} League`;
    if (pTier) pTier.textContent = tier.charAt(0).toUpperCase() + tier.slice(1);
    if (ppScore) ppScore.textContent = AURUM.formatNumber(score);
    if (ppGiven) ppGiven.textContent = AURUM.formatAmount(u.total_given || 0);
    if (ppWins) ppWins.textContent = u.challenge_wins || 0;
    if (ppStreak) ppStreak.textContent = `${streak} day streak 🔥`;

    /* Show upgrade CTA for free users */
    if (tier === 'explorer' || !tier) {
      const cta = document.getElementById('upgrade-cta');
      if (cta) cta.style.display = 'block';
    }
  },

  bindEvents() {
    /* Sign out */
    document.getElementById('btn-sign-out')?.addEventListener('click', async () => {
      try {
        if (window.Clerk) await Clerk.signOut();
        AURUM.Auth.clearToken();
        location.reload();
      } catch (err) {
        AURUM.Auth.clearToken();
        location.reload();
      }
    });

    /* Share passport */
    document.getElementById('btn-share-passport')?.addEventListener('click', () => {
      AURUM.showToast('Screenshot your Passport and share it.', 'gold', 4000);
    });
  },

  applyStyles() {
    if (document.getElementById('profile-styles')) return;
    const style = document.createElement('style');
    style.id = 'profile-styles';
    style.textContent = `
      .profile-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-4);
      }

      .profile-header {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding-top: var(--space-2);
      }

      .profile-avatar-wrap {
        position: relative;
        flex-shrink: 0;
      }

      .profile-verified {
        position: absolute;
        bottom: -2px;
        right: -2px;
        background: var(--color-gold);
        color: #0A0A0A;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 9px;
      }

      .profile-identity {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .profile-username {
        font-family: var(--font-display);
        font-size: var(--text-2xl);
        font-weight: var(--weight-light);
        color: var(--color-text);
      }

      .score-card {
        background: linear-gradient(135deg, var(--color-surface), rgba(201,168,76,0.06));
      }

      .score-card-top {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: var(--space-4);
      }

      .score-bar-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .score-bar {
        height: 3px;
        background: var(--color-border);
        border-radius: var(--radius-full);
        overflow: hidden;
      }

      .score-bar-fill {
        height: 100%;
        background: var(--color-gold);
        border-radius: var(--radius-full);
        transition: width 1s ease;
      }

      .profile-stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }

      .profile-stat {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        align-items: center;
        text-align: center;
      }

      .profile-section-title {
        font-family: var(--font-display);
        font-size: var(--text-xl);
        font-weight: var(--weight-light);
        color: var(--color-text);
        margin-bottom: var(--space-4);
      }

      .badges-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
      }

      .badge-item {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-4);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-lg);
        text-align: center;
        transition: all var(--transition-base);
      }

      .badge-item-locked {
        opacity: 0.4;
        filter: grayscale(1);
      }

      .badge-item-earned {
        border-color: var(--color-border-gold);
        opacity: 1;
        filter: none;
      }

      .badge-item-icon {
        font-size: 1.8rem;
      }

      .badge-item-name {
        font-size: var(--text-xs);
        letter-spacing: 0.06em;
        color: var(--color-text-muted);
      }

      /* Wealth Passport */
      .passport-card {
        position: relative;
        background: linear-gradient(135deg, #0F0F0F, #1A1500);
        border: 1px solid var(--color-gold-dim);
        border-radius: var(--radius-xl);
        padding: var(--space-6);
        overflow: hidden;
        box-shadow: var(--shadow-gold);
      }

      .passport-bg-grid {
        position: absolute;
        inset: 0;
        background-image:
          linear-gradient(rgba(201,168,76,0.04) 1px, transparent 1px),
          linear-gradient(90deg, rgba(201,168,76,0.04) 1px, transparent 1px);
        background-size: 24px 24px;
        pointer-events: none;
      }

      .passport-content {
        position: relative;
        z-index: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-3);
      }

      .passport-top {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
      }

      .passport-logo {
        font-family: var(--font-display);
        font-size: var(--text-xl);
        letter-spacing: 0.2em;
        color: var(--color-gold);
      }

      .passport-tier {
        font-size: var(--text-xs);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--color-gold-dim);
        border: 1px solid var(--color-border-gold);
        padding: 2px var(--space-3);
        border-radius: var(--radius-full);
      }

      .passport-avatar {
        width: 64px;
        height: 64px;
        border-radius: 50%;
        background: var(--color-surface-3);
        border: 2px solid var(--color-gold-dim);
        display: flex;
        align-items: center;
        justify-content: center;
        font-family: var(--font-display);
        font-size: var(--text-3xl);
        color: var(--color-gold);
      }

      .passport-name {
        font-family: var(--font-display);
        font-size: var(--text-2xl);
        font-weight: var(--weight-light);
        letter-spacing: 0.08em;
        color: var(--color-text);
      }

      .passport-league {
        font-size: var(--text-xs);
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--color-gold-dim);
      }

      .passport-stats {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        width: 100%;
        justify-content: center;
        padding: var(--space-3) 0;
        border-top: 1px solid rgba(201,168,76,0.15);
        border-bottom: 1px solid rgba(201,168,76,0.15);
      }

      .passport-stat {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 2px;
      }

      .passport-stat-value {
        font-family: var(--font-mono);
        font-size: var(--text-base);
        color: var(--color-gold);
      }

      .passport-stat-label {
        font-size: 9px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgba(201,168,76,0.5);
      }

      .passport-stat-div {
        width: 1px;
        height: 28px;
        background: rgba(201,168,76,0.15);
      }

      .passport-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
        width: 100%;
      }

      .passport-streak {
        font-size: 10px;
        color: var(--color-text-muted);
      }

      .upgrade-card {
        background: linear-gradient(135deg, var(--color-surface), rgba(201,168,76,0.06));
      }
    `;
    document.head.appendChild(style);
  }
};
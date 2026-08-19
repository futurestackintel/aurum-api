/* ============================================
   AURUM — Profile Page + Wealth Passport — Module G
   Web Share API, platform buttons, cache-first load.
============================================ */

window.ProfilePage = {
  container:   null,
  initialized: false,
  user:        null,

  init(containerId, user) {
    this.container = document.getElementById(containerId);
    this.user      = user;
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadProfile();
      this.initialized = true;
    } else {
      /* Re-entering page — refresh user data silently */
      this._refreshProfile();
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="profile-wrap">

        <!-- Header -->
        <div class="profile-header">
          <div class="profile-avatar-wrap">
            <div class="avatar avatar-xl avatar-gold" id="profile-avatar">—</div>
            <div class="profile-verified" id="profile-verified-badge" style="display:none;">✦</div>
          </div>
          <div class="profile-identity">
            <h3 class="profile-username" id="profile-username">—</h3>
            <span class="badge badge-muted" id="profile-league">—</span>
          </div>
          <div style="display:flex;flex-direction:column;gap:var(--space-2);align-items:flex-end;">
            <a href="settings.html" class="btn btn-ghost btn-sm">Settings</a>
            <button class="btn btn-ghost btn-sm" id="btn-sign-out">Sign Out</button>
          </div>
        </div>

        <!-- Aurum Score card -->
        <div class="score-card card card-gold">
          <div class="score-card-top">
            <div>
              <p style="font-size:var(--text-xs);letter-spacing:0.1em;
                text-transform:uppercase;color:var(--color-text-muted);">
                Aurum Score
              </p>
              <p class="mono" style="font-size:var(--text-4xl);color:var(--color-gold);
                line-height:1.1;" id="profile-score">—</p>
            </div>
            <div style="text-align:right;">
              <p style="font-size:var(--text-xs);letter-spacing:0.1em;
                text-transform:uppercase;color:var(--color-text-muted);">
                Streak
              </p>
              <p class="mono" style="font-size:var(--text-2xl);color:var(--color-text);"
                id="profile-streak">— days</p>
            </div>
          </div>
          <div class="score-bar-wrap">
            <div class="score-bar">
              <div class="score-bar-fill shimmer" id="score-bar-fill"
                style="width:0%;"></div>
            </div>
            <p style="font-size:10px;color:var(--color-text-muted);text-align:right;"
              id="score-next-league">— to next league</p>
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
          <div class="profile-stat card card-sm" id="stat-wallet-wrap"
            style="cursor:pointer;" onclick="App.openWalletModal()">
            <span class="stat-value" id="stat-wallet" style="color:var(--color-gold);">—</span>
            <span class="stat-label">Wallet Balance</span>
          </div>
        </div>

        <!-- Badges -->
        <div class="card">
          <p class="profile-section-title">Achievement Badges</p>
          <div class="badges-grid" id="badges-grid">
            <!-- Skeleton until loaded -->
            <div class="skeleton" style="height:80px;border-radius:12px;"></div>
            <div class="skeleton" style="height:80px;border-radius:12px;"></div>
            <div class="skeleton" style="height:80px;border-radius:12px;"></div>
            <div class="skeleton" style="height:80px;border-radius:12px;"></div>
          </div>
        </div>

        <!-- Wealth Passport -->
        <div class="card">
          <p class="profile-section-title">Wealth Passport</p>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);
            margin-bottom:var(--space-4);">
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
                  <span class="passport-stat-value" id="pp-wins">—</span>
                  <span class="passport-stat-label">Wins</span>
                </div>
                <div class="passport-stat-div"></div>
                <div class="passport-stat">
                  <span class="passport-stat-value" id="pp-streak">—</span>
                  <span class="passport-stat-label">Streak</span>
                </div>
              </div>
              <div class="passport-footer">
                <span style="font-size:9px;letter-spacing:0.1em;
                  color:rgba(201,168,76,0.5);">tryaurum.store</span>
                <span class="passport-streak" id="pp-since">Member since —</span>
              </div>
            </div>
          </div>

          <!-- Share button -->
          <button class="btn btn-outline btn-full"
            style="margin-top:var(--space-4);" id="btn-share-passport">
            Share Wealth Passport
          </button>

          <!-- Desktop share buttons — hidden until share triggered -->
          <div id="passport-share-links" style="display:none;
            margin-top:var(--space-3);display:none;">
            <p style="font-size:var(--text-xs);letter-spacing:0.08em;
              text-transform:uppercase;color:var(--color-text-muted);
              margin-bottom:var(--space-3);">Share on</p>
            <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
              <button class="btn btn-ghost btn-sm" id="share-twitter">𝕏 Twitter</button>
              <button class="btn btn-ghost btn-sm" id="share-linkedin">LinkedIn</button>
              <button class="btn btn-ghost btn-sm" id="share-facebook">Facebook</button>
              <button class="btn btn-ghost btn-sm" id="share-copy">Copy Link</button>
            </div>
          </div>
        </div>

                <!-- Refer & Earn -->
        <div class="card">
          <p class="profile-section-title">Refer & Earn</p>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);
            margin-bottom:var(--space-4);">
            Share your link. Earn 50 Aurum Score for every friend who joins.
          </p>
          <div style="display:flex;gap:var(--space-2);align-items:center;
            background:var(--color-surface-2,rgba(255,255,255,0.04));
            border-radius:12px;padding:var(--space-3);">
            <span class="mono" id="referral-link-display"
              style="flex:1;font-size:var(--text-sm);color:var(--color-gold);
              overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">â€”</span>
            <button class="btn btn-ghost btn-sm" id="btn-copy-referral">Copy</button>
          </div>
        </div>
        <!-- Upgrade CTA (Explorer only) -->
        <div class="upgrade-card card card-gold" id="upgrade-cta" style="display:none;">
          <p class="profile-section-title gold">Upgrade to Contender</p>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);
            margin-bottom:var(--space-4);">
            Join Drop Circles, get verified, and unlock boosted placement.
          </p>
          <button class="btn btn-primary btn-full" id="btn-upgrade-contender">
            Upgrade — $9/mo
          </button>
        </div>

      </div>
    `;

    this.applyStyles();
    this.bindEvents();
  },

  async loadProfile() {
    /* Cache-first: populate immediately if cache exists */
    const cached = AURUM.ProfileCache.get();
    if (cached) {
      this.user = { ...this.user, ...cached };
      this.populateProfile();
    }
    await this._refreshProfile();
  },

  async _refreshProfile() {
    try {
      const data = await AURUM.AuthAPI.me();
      this.user  = { ...this.user, ...data.user };
      AURUM.ProfileCache.set(data.user);
      this.populateProfile();
      /* Sync wallet balance to stat card */
      this.loadWalletStat();
    } catch (err) {
      if (this.user) this.populateProfile();
    }
  },

  async loadWalletStat() {
    try {
      const data = await AURUM.WalletAPI.getBalance();
      const el   = document.getElementById('stat-wallet');
      if (el) el.textContent = AURUM.formatAurum(data.balance || 0);
      /* Keep App-level balance in sync */
      if (window.App) {
        window.App.walletBalance = data.balance || 0;
        window.App.updateWalletInBar?.();
      }
    } catch (err) { /* wallet unavailable */ }
  },

  populateProfile() {
    const u        = this.user || {};
    const username = u.username  || u.firstName || 'Member';
    const league   = u.league    || 'Bronze';
    const score    = u.aurum_score || 0;
    const streak   = u.streak    || 0;
    const tier     = u.tier      || 'explorer';
    const memberSince = u.created_at
      ? new Date(u.created_at).getFullYear()
      : new Date().getFullYear();

    /* Header */
    const avatar = document.getElementById('profile-avatar');
    if (avatar) avatar.innerHTML = AURUM.avatarInnerHTML(u.avatar_url, username.charAt(0).toUpperCase());

    const usernameEl = document.getElementById('profile-username');
    if (usernameEl) usernameEl.textContent = username;

    const leagueEl = document.getElementById('profile-league');
    if (leagueEl) {
      leagueEl.textContent = league;
      leagueEl.className   = `badge ${AURUM.getLeagueBadge(league)}`;
    }

    /* Verified badge */
    const verifiedBadge = document.getElementById('profile-verified-badge');
    if (verifiedBadge) {
      verifiedBadge.style.display = u.verified ? 'flex' : 'none';
    }

    /* Score */
        const scoreEl = document.getElementById('profile-score');
    if (scoreEl) scoreEl.textContent = AURUM.formatNumber(score);
    /* Referral link */
    const referralEl = document.getElementById('referral-link-display');
    if (referralEl && u.referral_code) {
      referralEl.textContent = `tryaurum.store/?ref=${u.referral_code}`;
    }
    const streakEl = document.getElementById('profile-streak');
    if (streakEl) streakEl.textContent = `${streak} days`;

    /* Score progress bar */
    const leagueThresholds = {
      bronze: 1000, silver: 5000, gold: 15000, sovereign: 50000,
    };
    const threshold = leagueThresholds[league.toLowerCase()] || 1000;
    const percent   = Math.min((score / threshold) * 100, 100);
    const fill      = document.getElementById('score-bar-fill');
    if (fill) fill.style.width = `${percent}%`;

    const nextLeagueEl = document.getElementById('score-next-league');
    if (nextLeagueEl) {
      const remaining = Math.max(threshold - score, 0);
      nextLeagueEl.textContent = remaining > 0
        ? `${AURUM.formatNumber(remaining)} points to next league`
        : 'League maxed — you\'re at the top';
    }

    /* Stats */
    const earnedEl = document.getElementById('stat-earned');
    const givenEl  = document.getElementById('stat-given');
    const winsEl   = document.getElementById('stat-wins');
    if (earnedEl) earnedEl.textContent = AURUM.formatAmount(u.total_earned || 0);
    if (givenEl)  givenEl.textContent  = AURUM.formatAmount(u.total_given  || 0);
    if (winsEl)   winsEl.textContent   = u.challenge_wins || 0;

    /* Badges */
    this.renderBadges(u.badges || []);

    /* Passport */
    const pAvatar  = document.getElementById('passport-avatar');
    const pName    = document.getElementById('passport-name');
    const pLeague  = document.getElementById('passport-league');
    const pTier    = document.getElementById('passport-tier');
    const ppScore  = document.getElementById('pp-score');
    const ppWins   = document.getElementById('pp-wins');
    const ppStreak = document.getElementById('pp-streak');
    const ppSince  = document.getElementById('pp-since');

    if (pAvatar)  pAvatar.textContent  = username.charAt(0).toUpperCase();
    if (pName)    pName.textContent    = username;
    if (pLeague)  pLeague.textContent  = `${league} League`;
    if (pTier)    pTier.textContent    = tier.charAt(0).toUpperCase() + tier.slice(1);
    if (ppScore)  ppScore.textContent  = AURUM.formatNumber(score);
    if (ppWins)   ppWins.textContent   = u.challenge_wins || 0;
    if (ppStreak) ppStreak.textContent = `${streak}d`;
    if (ppSince)  ppSince.textContent  = `Member since ${memberSince}`;

    /* Upgrade CTA */
    const cta = document.getElementById('upgrade-cta');
    if (cta) cta.style.display = (tier === 'explorer' || !tier) ? 'block' : 'none';
  },

  renderBadges(earnedBadges) {
    const grid = document.getElementById('badges-grid');
    if (!grid) return;

    const allBadges = [
      { key: 'verified_builder',     icon: '🥉', name: 'Verified Builder'     },
      { key: 'verified_founder',     icon: '🥈', name: 'Verified Founder'     },
      { key: 'verified_millionaire', icon: '🥇', name: 'Verified Millionaire' },
      { key: 'sovereign',            icon: '💎', name: 'Sovereign'            },
    ];

    grid.innerHTML = allBadges.map(badge => {
      const earned = earnedBadges.includes(badge.key)
        || earnedBadges.some(b => b?.key === badge.key || b === badge.key);
      return `
        <div class="badge-item ${earned ? 'badge-item-earned' : 'badge-item-locked'}">
          <span class="badge-item-icon">${badge.icon}</span>
          <span class="badge-item-name">${badge.name}</span>
          ${earned
            ? '<span style="font-size:9px;color:var(--color-gold);">Earned</span>'
            : ''}
        </div>
      `;
    }).join('');
  },

  bindEvents() {
    /* Sign out */
    document.getElementById('btn-sign-out')
      ?.addEventListener('click', async () => {
        try {
          if (window.Clerk) await window.Clerk.signOut();
        } catch (e) { /* ignore */ }
        AURUM.Auth.clearToken();
        AURUM.ProfileCache.clear();
        location.reload();
      });

    /* Upgrade button */
    document.getElementById('btn-upgrade-contender')
      ?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-upgrade-contender');
        btn.textContent = 'Processing...';
        btn.disabled    = true;
        try {
          const data = await AURUM.SubAPI.upgrade({ tier: 'contender' });
          if (data.authorization_url) window.location.href = data.authorization_url;
          else {
            AURUM.showToast('Upgrade failed to start. Please try again.', 'error');
            btn.textContent = 'Upgrade — $9/mo';
            btn.disabled    = false;
          }
        } catch (err) {
          AURUM.showToast(err.message || 'Upgrade failed.', 'error');
          btn.textContent = 'Upgrade — $9/mo';
          btn.disabled    = false;
        }
      });

    /* Share passport */
    document.getElementById('btn-share-passport')
      ?.addEventListener('click', () => this.sharePassport());

    /* Desktop share buttons */
    document.getElementById('share-twitter')
      ?.addEventListener('click', () => this.shareViaTwitter());
    document.getElementById('share-linkedin')
      ?.addEventListener('click', () => this.shareViaLinkedIn());
    document.getElementById('share-facebook')
      ?.addEventListener('click', () => this.shareViaFacebook());
        document.getElementById('share-copy')
      ?.addEventListener('click', () => this.copyPassportLink());
    document.getElementById('btn-copy-referral')
      ?.addEventListener('click', () => this.copyReferralLink());
  },

  /* --------------------------------------------------
     SHARE LOGIC
  -------------------------------------------------- */
  getPassportURL() {
    const username = this.user?.username || 'member';
    return `https://tryaurum.store/passport/${username}`;
  },

  getShareText() {
    const username = this.user?.username || 'member';
    const league   = this.user?.league   || 'Bronze';
    const score    = AURUM.formatNumber(this.user?.aurum_score || 0);
    const url      = this.getPassportURL();
    return `My AURUM Wealth Passport ðŸ† League: ${league} | Score: ${score} ${url} #AURUM`;
  },
    async copyReferralLink() {
    const code = this.user?.referral_code;
    if (!code) {
      AURUM.showToast('Referral link not ready yet. Try again shortly.', 'error');
      return;
    }
    const link = `https://tryaurum.store/?ref=${code}`;
    const message = `Join me on AURUM — the competitive achievement network where verified wins earn real money and status. Sign up with my link and we both earn: ${link}`;
    try {
      await navigator.clipboard.writeText(message);
      AURUM.showToast('Referral message copied!', 'success');
    } catch (err) {
      AURUM.showToast('Could not copy link. Long-press to copy manually.', 'error');
    }
  },
  async sharePassport() {
    const url  = this.getPassportURL();
    const text = this.getShareText();

    /* Web Share API — works on mobile */
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'My AURUM Wealth Passport',
          text,
          url,
        });
        return;
      } catch (err) {
        /* User cancelled or API failed — fall through to desktop buttons */
        if (err.name === 'AbortError') return;
      }
    }

    /* Desktop fallback — show share buttons */
    const linksEl = document.getElementById('passport-share-links');
    if (linksEl) {
      linksEl.style.display = linksEl.style.display === 'none' ? 'block' : 'none';
    }
  },

  shareViaTwitter() {
    const tweet = encodeURIComponent(this.getShareText());
    window.open(
      `https://twitter.com/intent/tweet?text=${tweet}`,
      '_blank',
      'noopener,noreferrer'
    );
  },

  shareViaLinkedIn() {
    const url = encodeURIComponent(this.getPassportURL());
    window.open(
      `https://www.linkedin.com/sharing/share-offsite/?url=${url}`,
      '_blank',
      'noopener,noreferrer'
    );
  },

  shareViaFacebook() {
    const url = encodeURIComponent(this.getPassportURL());
    window.open(
      `https://www.facebook.com/sharer/sharer.php?u=${url}`,
      '_blank',
      'noopener,noreferrer'
    );
  },

  async copyPassportLink() {
    const url = this.getPassportURL();
    try {
      await navigator.clipboard.writeText(url);
      AURUM.showToast('Link copied!', 'gold');
    } catch (err) {
      /* Clipboard API not available */
      AURUM.showToast(url, 'default', 5000);
    }
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
        background: linear-gradient(135deg,
          var(--color-surface), rgba(201,168,76,0.06));
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
        transition: border-color var(--transition-base);
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
        opacity: 0.35;
        filter: grayscale(1);
      }

      .badge-item-earned {
        border-color: var(--color-border-gold);
        box-shadow: var(--shadow-gold);
        opacity: 1;
        filter: none;
      }

      .badge-item-icon { font-size: 1.8rem; }

      .badge-item-name {
        font-size: var(--text-xs);
        letter-spacing: 0.06em;
        color: var(--color-text-muted);
      }

      /* Passport card */
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
        background: linear-gradient(135deg,
          var(--color-surface), rgba(201,168,76,0.06));
      }
    `;
    document.head.appendChild(style);
  },
};

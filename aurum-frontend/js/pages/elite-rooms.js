/* ============================================
   AURUM — Elite Rooms Browser
   Sovereign-tier invite-only circles.
============================================ */

window.ElitePage = {
  container: null,
  initialized: false,

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadRooms();
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="elite-wrap">

        <!-- Header -->
        <div class="elite-header">
          <p class="section-eyebrow">Sovereign Only</p>
          <h2 class="elite-title">Elite Rooms</h2>
          <p class="elite-subtitle">
            Invite-only circles for the top tier. 
            Upgrade to Sovereign to gain access.
          </p>
        </div>

        <!-- Sovereign gate (shown for non-sovereign) -->
        <div class="sovereign-gate card card-gold" id="sovereign-gate">
          <div class="gate-icon">💎</div>
          <h4 class="gate-title">Sovereign Access Required</h4>
          <p class="gate-desc">
            Elite Rooms are private circles reserved exclusively for 
            Sovereign members. Network with verified founders, 
            investors, and high performers.
          </p>
          <div class="gate-perks">
            <div class="gate-perk">
              <span class="gate-perk-icon">🏛️</span>
              <span>SaaS Founders Circle</span>
            </div>
            <div class="gate-perk">
              <span class="gate-perk-icon">📊</span>
              <span>Investor Network</span>
            </div>
            <div class="gate-perk">
              <span class="gate-perk-icon">⛓️</span>
              <span>Crypto Builders Den</span>
            </div>
            <div class="gate-perk">
              <span class="gate-perk-icon">🛒</span>
              <span>E-commerce Operators</span>
            </div>
          </div>
          <button class="btn btn-primary btn-full" id="btn-upgrade-sovereign">
            Upgrade to Sovereign — $99/mo
          </button>
        </div>

        <!-- Rooms list (shown for sovereign members) -->
        <div class="rooms-list" id="rooms-list" style="display:none;">
          <!-- Loads here -->
        </div>

      </div>

      <!-- Room detail modal -->
      <div class="modal-overlay" id="room-modal" style="display:none;">
        <div class="modal">
          <div class="modal-handle"></div>
          <div id="room-modal-content"></div>
        </div>
      </div>
    `;

    this.applyStyles();
    this.bindEvents();
  },

  async loadRooms() {
    const user = window.App?.user;
    const isSovereign = user?.tier === 'sovereign';

    if (isSovereign) {
      document.getElementById('sovereign-gate').style.display = 'none';
      document.getElementById('rooms-list').style.display = 'flex';
      this.fetchRooms();
    }
    /* else gate stays visible */
  },

  async fetchRooms() {
    const list = document.getElementById('rooms-list');
    if (!list) return;

    list.innerHTML = this.skeletons(4);

    try {
      const data = await AURUM.ArenaAPI.getChallenges('elite');
      const rooms = data.rooms || getMockRooms();
      this.renderRooms(rooms);
    } catch (err) {
      this.renderRooms(getMockRooms());
    }
  },

  renderRooms(rooms) {
    const list = document.getElementById('rooms-list');
    if (!list) return;

    list.innerHTML = rooms.map((room, i) => this.roomHTML(room, i)).join('');
    this.bindRoomEvents();
  },

  roomHTML(room, index) {
    const memberCount = room.members?.length || room.member_count || 0;
    const isNew = room.is_new || false;

    return `
      <div class="room-card card fade-in" 
        style="animation-delay:${index * 80}ms"
        data-room-id="${room.id}">
        <div class="room-top">
          <div class="room-icon">${room.icon || '🏛️'}</div>
          <div class="room-info">
            <div class="room-name-row">
              <p class="room-name">${room.name}</p>
              ${isNew ? '<span class="badge badge-gold" style="font-size:9px;">New</span>' : ''}
            </div>
            <p class="room-category">${room.category || 'General'}</p>
          </div>
          <div class="room-members">
            <span class="room-member-count mono">${memberCount}</span>
            <span class="room-member-label">members</span>
          </div>
        </div>

        <p class="room-desc">${room.description || ''}</p>

        <div class="room-tags">
          ${(room.tags || []).map(tag => `
            <span class="badge badge-muted" style="font-size:9px;">${tag}</span>
          `).join('')}
        </div>

        <button class="btn btn-outline btn-full btn-sm btn-view-room"
          data-room-id="${room.id}">
          Enter Room
        </button>
      </div>
    `;
  },

  bindRoomEvents() {
    document.querySelectorAll('.btn-view-room').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.roomId;
        this.openRoom(id);
      });
    });
  },

  openRoom(id) {
    const rooms = getMockRooms();
    const room = rooms.find(r => r.id === id) || rooms[0];

    const modal = document.getElementById('room-modal');
    const content = document.getElementById('room-modal-content');

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:var(--space-3);margin-bottom:var(--space-6);">
        <div style="font-size:2rem;">${room.icon || '🏛️'}</div>
        <div>
          <h3 style="font-family:var(--font-display);font-size:var(--text-2xl);font-weight:300;color:var(--color-text);">
            ${room.name}
          </h3>
          <p style="font-size:var(--text-sm);color:var(--color-text-muted);">${room.category}</p>
        </div>
      </div>

      <p style="font-size:var(--text-sm);color:var(--color-text-muted);margin-bottom:var(--space-6);line-height:1.7;">
        ${room.description}
      </p>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-3);margin-bottom:var(--space-6);">
        <div class="card card-sm" style="text-align:center;">
          <p class="mono" style="font-size:var(--text-xl);color:var(--color-gold);">
            ${room.member_count || 0}
          </p>
          <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-text-muted);">
            Members
          </p>
        </div>
        <div class="card card-sm" style="text-align:center;">
          <p class="mono" style="font-size:var(--text-xl);color:var(--color-text);">
            ${room.active_discussions || 0}
          </p>
          <p style="font-size:10px;letter-spacing:0.08em;text-transform:uppercase;color:var(--color-text-muted);">
            Discussions
          </p>
        </div>
      </div>

      <div style="margin-bottom:var(--space-6);">
        <p style="font-size:var(--text-xs);letter-spacing:0.08em;text-transform:uppercase;color:var(--color-text-muted);margin-bottom:var(--space-3);">
          Members
        </p>
        <div style="display:flex;gap:var(--space-2);flex-wrap:wrap;">
          ${(room.preview_members || []).map(m => `
            <div class="avatar avatar-sm" title="${m}">${m.charAt(0)}</div>
          `).join('')}
          ${room.member_count > 5 ? `
            <div class="avatar avatar-sm" style="background:var(--color-surface-3);color:var(--color-text-muted);font-size:var(--text-xs);">
              +${room.member_count - 5}
            </div>
          ` : ''}
        </div>
      </div>

      <button class="btn btn-primary btn-full" id="btn-join-room">
        Join This Room
      </button>
    `;

    modal.style.display = 'flex';

    document.getElementById('btn-join-room')?.addEventListener('click', () => {
      AURUM.showToast(`Joined ${room.name}`, 'gold');
      modal.style.display = 'none';
    });

    modal.addEventListener('click', (e) => {
      if (e.target.id === 'room-modal') modal.style.display = 'none';
    });
  },

  bindEvents() {
    document.getElementById('btn-upgrade-sovereign')?.addEventListener('click', async () => {
      const btn = document.getElementById('btn-upgrade-sovereign');
      btn.textContent = 'Processing...';
      btn.disabled = true;

      try {
        const data = await AURUM.SubAPI.upgrade({ tier: 'sovereign' });
        if (data.payment_url) {
          window.location.href = data.payment_url;
        } else {
          AURUM.showToast('Upgrade initiated.', 'gold');
        }
      } catch (err) {
        AURUM.showToast(err.message || 'Upgrade failed.', 'error');
        btn.textContent = 'Upgrade to Sovereign — $99/mo';
        btn.disabled = false;
      }
    });

    document.getElementById('room-modal')?.addEventListener('click', (e) => {
      if (e.target.id === 'room-modal') {
        document.getElementById('room-modal').style.display = 'none';
      }
    });
  },

  skeletons(count) {
    return Array(count).fill(`
      <div class="card" style="display:flex;flex-direction:column;gap:12px;">
        <div style="display:flex;gap:12px;align-items:center;">
          <div class="skeleton" style="width:44px;height:44px;border-radius:10px;flex-shrink:0;"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <div class="skeleton" style="height:14px;width:55%;"></div>
            <div class="skeleton" style="height:10px;width:35%;"></div>
          </div>
          <div class="skeleton" style="width:48px;height:32px;border-radius:8px;"></div>
        </div>
        <div class="skeleton" style="height:12px;width:100%;"></div>
        <div class="skeleton" style="height:12px;width:75%;"></div>
        <div class="skeleton" style="height:36px;border-radius:8px;"></div>
      </div>
    `).join('');
  },

  applyStyles() {
    if (document.getElementById('elite-styles')) return;
    const style = document.createElement('style');
    style.id = 'elite-styles';
    style.textContent = `
      .elite-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
        padding: var(--space-4);
      }

      .elite-header {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding-top: var(--space-2);
      }

      .elite-title {
        font-family: var(--font-display);
        font-size: var(--text-3xl);
        font-weight: var(--weight-light);
        color: var(--color-text);
      }

      .elite-subtitle {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        line-height: 1.6;
      }

      /* Sovereign gate */
      .sovereign-gate {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--space-4);
        text-align: center;
        background: linear-gradient(135deg, var(--color-surface), rgba(201,168,76,0.06));
      }

      .gate-icon {
        font-size: 3rem;
        animation: goldShimmer 3s ease-in-out infinite;
      }

      .gate-title {
        font-family: var(--font-display);
        font-size: var(--text-2xl);
        font-weight: var(--weight-light);
        color: var(--color-gold);
      }

      .gate-desc {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        line-height: 1.7;
        max-width: 320px;
      }

      .gate-perks {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-3);
        width: 100%;
      }

      .gate-perk {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        padding: var(--space-3);
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        font-size: var(--text-xs);
        color: var(--color-text-muted);
      }

      .gate-perk-icon {
        font-size: 1rem;
        flex-shrink: 0;
      }

      /* Rooms list */
      .rooms-list {
        flex-direction: column;
        gap: var(--space-3);
      }

      .room-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        cursor: pointer;
      }

      .room-top {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
      }

      .room-icon {
        width: 44px;
        height: 44px;
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 1.3rem;
        flex-shrink: 0;
      }

      .room-info {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
      }

      .room-name-row {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .room-name {
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--color-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .room-category {
        font-size: var(--text-xs);
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--color-gold-dim);
      }

      .room-members {
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 2px;
        flex-shrink: 0;
      }

      .room-member-count {
        font-size: var(--text-lg);
        font-weight: var(--weight-medium);
        color: var(--color-text);
      }

      .room-member-label {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .room-desc {
        font-size: var(--text-sm);
        color: var(--color-text-muted);
        line-height: 1.6;
      }

      .room-tags {
        display: flex;
        gap: var(--space-2);
        flex-wrap: wrap;
      }
    `;
    document.head.appendChild(style);
  }
};

/* Mock rooms */
function getMockRooms() {
  return [
    {
      id: '1',
      name: 'SaaS Founders Circle',
      category: 'Software & Products',
      icon: '🏛️',
      description: 'A private circle for verified SaaS founders. Share revenue milestones, growth tactics, and deal flow with people who are actually building.',
      member_count: 47,
      active_discussions: 12,
      tags: ['SaaS', 'Founders', 'B2B'],
      is_new: false,
      preview_members: ['ShadowKing', 'NovaBuild', 'IronFounder', 'ApexStar', 'VaultMind']
    },
    {
      id: '2',
      name: 'Investor Network',
      category: 'Capital & Deals',
      icon: '📊',
      description: 'Verified investors and allocators. Deal flow, co-investment opportunities, and portfolio strategy discussions.',
      member_count: 23,
      active_discussions: 8,
      tags: ['Investing', 'Angel', 'VC'],
      is_new: true,
      preview_members: ['ZeroToOne', 'CodeEmpire', 'RiseFirst', 'BuildMode', 'ApexStar']
    },
    {
      id: '3',
      name: 'Crypto Builders Den',
      category: 'Web3 & Blockchain',
      icon: '⛓️',
      description: 'For serious builders in the Web3 space. Protocol discussions, token strategy, and on-chain achievement tracking.',
      member_count: 61,
      active_discussions: 24,
      tags: ['Web3', 'DeFi', 'NFT'],
      is_new: false,
      preview_members: ['ShadowKing', 'NovaBuild', 'VaultMind', 'ZeroToOne', 'IronFounder']
    },
    {
      id: '4',
      name: 'E-commerce Operators',
      category: 'Commerce & Retail',
      icon: '🛒',
      description: 'High-volume e-commerce operators sharing margins, supplier relationships, logistics wins, and scaling playbooks.',
      member_count: 38,
      active_discussions: 15,
      tags: ['Ecom', 'DTC', 'Shopify'],
      is_new: false,
      preview_members: ['BuildMode', 'ApexStar', 'CodeEmpire', 'RiseFirst', 'NovaBuild']
    }
  ];
}
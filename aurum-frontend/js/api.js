/* ============================================================
   AURUM — API Module — Registration Root-Cause Fix
   THE BUG: AuthAPI.register passed `false` as the requiresAuth
   argument to apiRequest, meaning it NEVER attached the Clerk
   token. The backend route requires auth. Every single
   registration call has been failing silently (app.html wraps it
   in try{}catch(e){}), meaning Clerk sign-up succeeded but the
   matching row in the `users` table was never created — the exact
   cause of every "user not found" error hit on crews, duels, and
   gold buttons. Fixed: requiresAuth now defaults to true (omitted,
   same as explicitly true) for this call.
============================================================ */

const API_BASE = 'https://aurum-api.futurestack001.workers.dev';

/* --- Token management --- */
const Auth = {
  getToken:   () => localStorage.getItem('aurum_token'),
  setToken:   (token) => localStorage.setItem('aurum_token', token),
  clearToken: () => localStorage.removeItem('aurum_token'),
  isLoggedIn: () => !!localStorage.getItem('aurum_token'),
};

/* --- Live token refresh — call before every authenticated request --- */
async function getFreshToken() {
  try {
    if (window.Clerk?.session) {
      const token = await window.Clerk.session.getToken();
      if (token) {
        Auth.setToken(token);
        return token;
      }
    }
  } catch (err) {
    /* session expired or Clerk not ready — fall through */
  }
  return Auth.getToken();
}

/* --- Core fetch wrapper --- */
async function apiRequest(method, path, body = null, requiresAuth = true) {
  const headers = { 'Content-Type': 'application/json' };

  if (requiresAuth) {
    const token = await getFreshToken();
    if (!token) throw new Error('NOT_AUTHENTICATED');
    headers['Authorization'] = `Bearer ${token}`;
  }

  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  try {
    const response = await fetch(`${API_BASE}${path}`, options);
    const data     = await response.json();

    if (!response.ok) {
      throw new Error(data.error || `HTTP ${response.status}`);
    }

    return data;
  } catch (err) {
    if (err.message === 'NOT_AUTHENTICATED') throw err;
    throw new Error(err.message || 'Network error');
  }
}

/* ============================================================
   API METHODS
============================================================ */

/* --- Auth ---
   FIX: register now requires auth (was `false`, the root cause
   of the entire registration gap). At the moment register() is
   called, Clerk sign-up has already completed and a session
   token is available, so requiring auth here is correct and safe.
*/
const AuthAPI = {
  register: (data) => apiRequest('POST', '/api/auth/register', data, true),
  me:       ()     => apiRequest('GET',  '/api/auth/me'),
};

/* --- Leaderboard --- */
const LeaderboardAPI = {
  getPublic: ()     => apiRequest('GET', '/leaderboard/public', null, false),
  getFull:   (type) => apiRequest('GET', `/leaderboard?type=${type}`),
};

/* --- Public platform stats --- */
const StatsAPI = {
  get: () => apiRequest('GET', '/api/stats/public', null, false),
};

/* --- Posts / Ledger ---
     offset-based pagination — getFeed(offset)
     tipPost removed — use TipsAPI.send()
*/
const LedgerAPI = {
  getFeed:    (offset = 0) => apiRequest('GET',  `/api/posts?limit=20&offset=${offset}`),
  createPost: (data)       => apiRequest('POST', '/api/posts', data),
  flagPost:   (postId, data) => apiRequest('POST', `/api/posts/${postId}/flag`, data),
  appeal:     (postId, data) => apiRequest('POST', `/api/posts/${postId}/appeal`, data),
  cheer:      (postId)       => apiRequest('POST', `/api/posts/${postId}/cheer`),
};

/* --- Challenges / Arena ---
     fundChallenge / verifyChallenge / payoutChallenge removed.
     Entry = POST /api/challenges/:id/join  (joinChallenge)
     getChallenges takes an optional status filter.
*/
const ArenaAPI = {
  getChallenges: (limit = 20, offset = 0, status) => {
    let path = `/api/challenges?limit=${limit}&offset=${offset}`;
    if (status) path += `&status=${encodeURIComponent(status)}`;
    return apiRequest('GET', path, null, false);
  },

  getChallenge:    (id) =>
    apiRequest('GET', `/api/challenges/${id}`, null, false),

  createChallenge: (data) =>
    apiRequest('POST', '/api/challenges', data),

  joinChallenge:   (id) =>
    apiRequest('POST', `/api/challenges/${id}/join`),

  submitProof:     (id, data) =>
    apiRequest('POST', `/api/challenges/${id}/proof`, data),

  giveGoldButton:  (id) =>
    apiRequest('POST', `/api/challenges/${id}/gold`),

  boostChallenge:  (id, data) =>
    apiRequest('POST', `/api/challenges/${id}/boost`, data),

  freeEntry:       () =>
    apiRequest('POST', '/api/challenges/free-entry'),
};

/* --- Duels --- */
const DuelAPI = {
  getDuels:    (limit = 20, offset = 0) =>
    apiRequest('GET', `/api/duels?limit=${limit}&offset=${offset}`, null, false),

  getDuel:     (id) =>
    apiRequest('GET', `/api/duels/${id}`, null, false),

  createDuel:  (data) =>
    apiRequest('POST', '/api/duels', data),

  acceptDuel:  (id) =>
    apiRequest('POST', `/api/duels/${id}/accept`),

  declineDuel: (id) =>
    apiRequest('POST', `/api/duels/${id}/decline`),

  submitProof: (id, data) =>
    apiRequest('POST', `/api/duels/${id}/proof`, data),

  announce:    (id) =>
    apiRequest('POST', `/api/duels/${id}/announce`),

  watch:       (id) =>
    apiRequest('POST', `/api/duels/${id}/notify`),

  tip:         (id, participantId, data) =>
    apiRequest('POST', `/api/duels/${id}/tip/${participantId}`, data),

  vote:        (id, participantId) =>
    apiRequest('POST', `/api/duels/${id}/vote/${participantId}`),
};

/* --- Tips --- */
const TipsAPI = {
  send: (data) => apiRequest('POST', '/api/tips', data),
};

/* --- Comments --- */
const CommentsAPI = {
  getForPost: (postId) =>
    apiRequest('GET', `/api/posts/${postId}/comments`, null, false),

  create: (postId, data) =>
    apiRequest('POST', `/api/posts/${postId}/comments`, data),

  remove: (commentId) =>
    apiRequest('DELETE', `/api/comments/${commentId}`),
};

/* --- Subscriptions --- */
const SubAPI = {
  upgrade: (data) => apiRequest('POST', '/api/subscriptions/upgrade', data),
  verify:  (data) => apiRequest('POST', '/api/subscriptions/verify', data),
};

/* --- Profile --- */
const ProfileAPI = {
  getPassport:  (username) =>
    apiRequest('GET', `/api/passport/${username}`, null, false),

  updateProfile: (data) =>
    apiRequest('PATCH', '/api/users/me', data),
};

/* --- Settings --- */
const SettingsAPI = {
  updateProfile: (data) =>
    apiRequest('PATCH', '/api/users/me', data),

  updateNotifications: (data) =>
    apiRequest('PATCH', '/api/users/me/notifications', data),

  updateBankAccount: (data) =>
    apiRequest('POST', '/api/wallet/bank-details', data),

  deleteAccount: () =>
    apiRequest('POST', '/api/users/me/delete'),
};

/* --- Wallet --- */
const WalletAPI = {
  deposit: (data) =>
    apiRequest('POST', '/api/wallet/deposit', data),

  confirmDeposit: (data) =>
    apiRequest('POST', '/api/wallet/deposit/confirm', data),

  getBalance: () =>
    apiRequest('GET', '/api/wallet/balance'),

  withdraw: (data) =>
    apiRequest('POST', '/api/wallet/withdraw', data),

  setCurrency: (data) =>
    apiRequest('POST', '/api/wallet/currency', data),

  getTransactions: (page = 0) =>
    apiRequest('GET', `/api/wallet/transactions?limit=20&offset=${page * 20}`),

  getBankDetails: () =>
    apiRequest('GET', '/api/wallet/bank-details'),
};

/* --- Founding Member --- */
const FoundingAPI = {
  join: () => apiRequest('POST', '/api/founding/join'),
  stats: () => apiRequest('GET', '/api/founding/stats', null, false),
};

/* --- Crews --- */
const CrewAPI = {
  getCrews: (limit = 20, offset = 0) =>
    apiRequest('GET', `/api/crews?limit=${limit}&offset=${offset}`, null, false),

  getCrew: (id) =>
    apiRequest('GET', `/api/crews/${id}`, null, false),

  createCrew: (data) =>
    apiRequest('POST', '/api/crews', data),

  joinCrew: (id) =>
    apiRequest('POST', `/api/crews/${id}/join`),

  startBattle: (id, data) =>
    apiRequest('POST', `/api/crews/${id}/battle`, data),
};

/* ============================================================
   UI HELPERS
============================================================ */

function showToast(message, type = 'default', duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className   = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity    = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* League promotion toast — gold animated */
function showLeaguePromotion(leagueName) {
  const existing = document.querySelector('.promotion-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'promotion-toast';
  toast.innerHTML = `
    <div class="promo-toast-inner">
      <span class="promo-toast-icon">🏆</span>
      <div>
        <p class="promo-toast-title">League Promotion!</p>
        <p class="promo-toast-body">You've been promoted to ${leagueName} League</p>
      </div>
    </div>
  `;
  document.body.appendChild(toast);

  /* Inject styles once */
  if (!document.getElementById('promo-toast-styles')) {
    const s = document.createElement('style');
    s.id = 'promo-toast-styles';
    s.textContent = `
      .promotion-toast {
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9000;
        animation: promoSlideIn 0.5s cubic-bezier(0.34,1.56,0.64,1) forwards,
                   promoFadeOut 0.4s ease 4.6s forwards;
      }
      .promo-toast-inner {
        display: flex;
        align-items: center;
        gap: 12px;
        padding: 14px 20px;
        background: linear-gradient(135deg, #1A1200, #0F0A00);
        border: 1px solid #C9A84C;
        border-radius: 14px;
        box-shadow: 0 0 32px rgba(201,168,76,0.4);
        white-space: nowrap;
      }
      .promo-toast-icon { font-size: 1.5rem; animation: goldPulse 1s ease infinite; }
      .promo-toast-title {
        font-size: 11px;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: #C9A84C;
        font-family: 'DM Sans', sans-serif;
      }
      .promo-toast-body {
        font-size: 14px;
        color: #F5F5F0;
        font-family: 'DM Sans', sans-serif;
        font-weight: 500;
      }
      @keyframes promoSlideIn {
        from { opacity: 0; transform: translateX(-50%) translateY(-20px) scale(0.9); }
        to   { opacity: 1; transform: translateX(-50%) translateY(0) scale(1); }
      }
      @keyframes promoFadeOut {
        to { opacity: 0; transform: translateX(-50%) translateY(-10px); }
      }
      @keyframes goldPulse {
        0%,100% { filter: drop-shadow(0 0 4px rgba(201,168,76,0.6)); }
        50%      { filter: drop-shadow(0 0 12px rgba(201,168,76,1)); }
      }
    `;
    document.head.appendChild(s);
  }

  setTimeout(() => toast.remove(), 5200);
}

function formatAmount(amount) {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000)    return `$${(amount / 1000).toFixed(1)}K`;
  return `$${Number(amount).toFixed(2)}`;
}

function formatAurum(amount) {
  if (amount >= 1000000) return `₳${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000)    return `₳${(amount / 1000).toFixed(1)}K`;
  return `₳${Number(amount).toFixed(2)}`;
}

function formatNumber(num) {
  return Number(num || 0).toLocaleString();
}

function getLeagueBadge(league) {
  const map = {
    bronze:    'badge-bronze',
    silver:    'badge-silver',
    gold:      'badge-gold-lg',
    sovereign: 'badge-sovereign',
  };
  return map[league?.toLowerCase()] || 'badge-muted';
}

function timeAgo(dateString) {
  const date = new Date(dateString);
  const now  = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function formatCountdown(seconds) {
  if (!seconds || seconds <= 0) return 'Ended';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h remaining`;
  if (h > 0) return `${h}h ${m}m remaining`;
  return `${m}m remaining`;
}

/* ============================================================
   PROFILE CACHE
   Cache /api/auth/me in localStorage. Refresh if > 5 min stale.
============================================================ */
const ProfileCache = {
  KEY:      'aurum_profile_cache',
  TTL_MS:   5 * 60 * 1000,

  get() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (!raw) return null;
      const { data, ts } = JSON.parse(raw);
      if (Date.now() - ts > this.TTL_MS) return null;
      return data;
    } catch { return null; }
  },

  set(data) {
    try {
      localStorage.setItem(this.KEY, JSON.stringify({ data, ts: Date.now() }));
    } catch { /* storage full — ignore */ }
  },

  clear() {
    localStorage.removeItem(this.KEY);
  },
};

/* ============================================================
   EXPORT
============================================================ */

window.AURUM = {
  Auth,
  AuthAPI,
  LeaderboardAPI,
  StatsAPI,
  LedgerAPI,
  ArenaAPI,
  DuelAPI,
  TipsAPI,
  CommentsAPI,
  SubAPI,
  ProfileAPI,
  SettingsAPI,
  WalletAPI,
  FoundingAPI,
  CrewAPI,
  ProfileCache,
  showToast,
  showLeaguePromotion,
  formatAmount,
  formatAurum,
  formatNumber,
  getLeagueBadge,
  timeAgo,
  formatCountdown,
};

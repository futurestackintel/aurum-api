/* ============================================================
   AURUM — API Module — Module Chat F
   Added: CrewAPI, DuelAPI expanded, SettingsAPI, CheerAPI
============================================================ */

const API_BASE = 'https://api.tryaurum.store';

/* --- Token management --- */
const Auth = {
  getToken:   () => localStorage.getItem('aurum_token'),
  setToken:   (token) => localStorage.setItem('aurum_token', token),
  clearToken: () => localStorage.removeItem('aurum_token'),
  isLoggedIn: () => !!localStorage.getItem('aurum_token'),
};

/* --- Core fetch wrapper --- */
async function apiRequest(method, path, body = null, requiresAuth = true) {
  const headers = { 'Content-Type': 'application/json' };

  if (requiresAuth) {
    const token = Auth.getToken();
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

/* --- Auth --- */
const AuthAPI = {
  register: (data) => apiRequest('POST', '/api/auth/register', data, false),
  me:       ()     => apiRequest('GET',  '/api/auth/me'),
};

/* --- Leaderboard --- */
const LeaderboardAPI = {
  getPublic: ()     => apiRequest('GET', '/leaderboard/public', null, false),
  getFull:   (type) => apiRequest('GET', `/leaderboard?type=${type}`),
};

/* --- Posts / Ledger --- */
const LedgerAPI = {
  getFeed:    (page = 1) => apiRequest('GET',  `/api/posts?page=${page}`),
  createPost: (data)     => apiRequest('POST', '/api/posts', data),
  flagPost:   (postId, data) => apiRequest('POST', `/api/posts/${postId}/flag`, data),
  appeal:     (postId, data) => apiRequest('POST', `/api/posts/${postId}/appeal`, data),
  cheer:      (postId)       => apiRequest('POST', `/api/posts/${postId}/cheer`),
};

/* --- Challenges / Arena --- */
const ArenaAPI = {
  getChallenges:   (limit = 20, offset = 0) =>
    apiRequest('GET', `/api/challenges?limit=${limit}&offset=${offset}`, null, false),

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
};

/* --- Founding Member --- */
const FoundingAPI = {
  join: () => apiRequest('POST', '/api/founding/join'),
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

function formatAmount(amount) {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000)    return `$${(amount / 1000).toFixed(1)}K`;
  return `$${Number(amount).toFixed(2)}`;
}

function formatNumber(num) {
  return num.toLocaleString();
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
   EXPORT
============================================================ */

window.AURUM = {
  Auth,
  AuthAPI,
  LeaderboardAPI,
  LedgerAPI,
  ArenaAPI,
  DuelAPI,
  TipsAPI,
  SubAPI,
  ProfileAPI,
  SettingsAPI,
  WalletAPI,
  FoundingAPI,
  CrewAPI,
  showToast,
  formatAmount,
  formatNumber,
  getLeagueBadge,
  timeAgo,
  formatCountdown,
};

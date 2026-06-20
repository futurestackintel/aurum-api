/* ============================================================
   AURUM — API Module
   Central hub for all Worker communication.
   Every fetch in the app goes through here.
============================================================ */

const API_BASE = 'https://api.tryaurum.store';

/* --- Token management --- */
const Auth = {
  getToken:  () => localStorage.getItem('aurum_token'),
  setToken:  (token) => localStorage.setItem('aurum_token', token),
  clearToken: () => localStorage.removeItem('aurum_token'),
  isLoggedIn: () => !!localStorage.getItem('aurum_token'),
};

/* --- Core fetch wrapper --- */
async function apiRequest(method, path, body = null, requiresAuth = true) {
  const headers = {
    'Content-Type': 'application/json',
  };

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
   API METHODS — grouped by feature
============================================================ */

/* --- Auth --- */
const AuthAPI = {
  register: (data) => apiRequest('POST', '/auth/register', data, false),
  me:       ()     => apiRequest('GET',  '/auth/me'),
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
};

/* --- Challenges / Arena --- */
const ArenaAPI = {
  getChallenges:   (status = 'active') => apiRequest('GET',  `/challenges?status=${status}`),
  getChallenge:    (id)                => apiRequest('GET',  `/challenges/${id}`),
  createChallenge: (data)              => apiRequest('POST', '/challenges', data),
  fundChallenge:   (id, data)          => apiRequest('POST', `/challenges/${id}/fund`, data),
  verifyChallenge: (id, data)          => apiRequest('POST', `/challenges/${id}/verify`, data),
  payoutChallenge: (id)                => apiRequest('POST', `/challenges/${id}/payout`),
};

/* --- Tips --- */
// Tips are internal wallet transfers — no Paystack checkout
const TipsAPI = {
  send: (data) => apiRequest('POST', '/api/tips', data),
};

/* --- Subscriptions --- */
const SubAPI = {
  upgrade: (data) => apiRequest('POST', '/subscriptions/upgrade', data),
  verify:  (data) => apiRequest('POST', '/subscriptions/verify', data),
};

/* --- Profile --- */
const ProfileAPI = {
  getProfile:    (username) => apiRequest('GET',   `/users/${username}`, null, false),
  updateProfile: (data)     => apiRequest('PATCH', '/users/me', data),
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

/* ============================================================
   UI HELPERS
============================================================ */

/* Show toast notification */
function showToast(message, type = 'default', duration = 3000) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className  = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity    = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

/* Format currency */
function formatAmount(amount) {
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000)    return `$${(amount / 1000).toFixed(1)}K`;
  return `$${amount.toFixed(2)}`;
}

/* Format number with commas */
function formatNumber(num) {
  return num.toLocaleString();
}

/* Get league badge class */
function getLeagueBadge(league) {
  const map = {
    bronze:    'badge-bronze',
    silver:    'badge-silver',
    gold:      'badge-gold-lg',
    sovereign: 'badge-sovereign',
  };
  return map[league?.toLowerCase()] || 'badge-muted';
}

/* Time ago */
function timeAgo(dateString) {
  const date = new Date(dateString);
  const now  = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60)    return 'just now';
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
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
  TipsAPI,
  SubAPI,
  ProfileAPI,
  WalletAPI,
  FoundingAPI,
  showToast,
  formatAmount,
  formatNumber,
  getLeagueBadge,
  timeAgo,
};

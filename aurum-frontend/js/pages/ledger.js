/* ============================================
   AURUM — The Ledger (Main Feed)
   FIX (stake colors): stakeColor map previously checked for
   'verified'/'pending'/'disputed', which never matched the real
   stake_status values ('locked'/'returned'/'appeal_pending'/
   'slashed') — every post fell through to the same dull grey
   default regardless of actual state. Fixed to match real values.

   FIX (media): postHTML read post.media_url (singular) but the
   backend writes and returns media_urls (plural) — images never
   rendered. Fixed to read the real field name.

   NEW: comment threads. Each post can be expanded to show/post
   threaded comments (replies to replies), matching the new
   POST/GET /api/posts/:id/comments and DELETE /api/comments/:id
   endpoints. 180 character limit per comment, author-only delete.
============================================ */

/* ---- Aurum-branded amount formatter (₳ not $) ---- */
function formatAurum(amount) {
  const n = parseFloat(amount) || 0;
  if (n >= 1000000) return `₳${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000)    return `₳${(n / 1000).toFixed(1)}K`;
  return `₳${n.toFixed(2)}`;
}

const COMMENT_MAX_LENGTH = 180;

window.LedgerPage = {
  container:   null,
  offset:      0,
  pageSize:    20,
  loading:     false,
  initialized: false,
  hasMore:     true,

  /* Tracks which posts currently have their comment section open,
     and caches loaded comment trees so re-opening doesn't refetch
     unless explicitly refreshed. */
  openComments: new Set(),
  commentCache: new Map(),

  init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;
    if (!this.initialized) {
      this.render();
      this.loadPosts(false);
      this.initialized = true;
    }
  },

  render() {
    this.container.innerHTML = `
      <div class="ledger-wrap">

        <!-- Composer -->
        <div class="composer card">
          <div class="composer-top">
            <div class="avatar avatar-sm avatar-gold" id="composer-avatar">—</div>
            <div class="composer-input-wrap">
              <textarea
                class="composer-input"
                id="post-content"
                placeholder="Post a verified win..."
                rows="1"
              ></textarea>
            </div>
          </div>
          <div class="composer-bottom">
            <div class="stake-selector">
              <span class="stake-label">Stake</span>
              <select class="stake-select" id="post-stake">
                <option value="5">$5</option>
                <option value="10">$10</option>
                <option value="25">$25</option>
                <option value="50">$50</option>
                <option value="100">$100</option>
                <option value="250">$250</option>
                <option value="500">$500</option>
                <option value="1000">$1,000</option>
              </select>
            </div>
            <button class="btn btn-primary btn-sm" id="btn-post">Post Win</button>
          </div>
        </div>

        <!-- Feed -->
        <div class="feed" id="ledger-feed"></div>

        <!-- Load more -->
        <div style="padding:var(--space-6);text-align:center;" id="load-more-wrap">
          <button class="btn btn-ghost btn-sm" id="btn-load-more">Load More</button>
        </div>

      </div>
    `;

    this.applyStyles();
    this.bindEvents();
    this.setComposerAvatar();
  },

  setComposerAvatar() {
    const avatar = document.getElementById('composer-avatar');
    if (avatar && window.App?.user?.username) {
      avatar.textContent = window.App.user.username.charAt(0).toUpperCase();
    }
  },

  bindEvents() {
    /* Auto-resize textarea */
    const textarea = document.getElementById('post-content');
    if (textarea) {
      textarea.addEventListener('input', () => {
        textarea.style.height = 'auto';
        textarea.style.height = textarea.scrollHeight + 'px';
      });
    }

    /* Post button */
    document.getElementById('btn-post')
      ?.addEventListener('click', () => this.submitPost());

    /* Load more */
    document.getElementById('btn-load-more')
      ?.addEventListener('click', () => {
        if (!this.loading && this.hasMore) {
          this.loadPosts(true);
        }
      });
  },

  async loadPosts(append = false) {
    if (this.loading) return;
    this.loading = true;

    const feed       = document.getElementById('ledger-feed');
    const loadMoreWrap = document.getElementById('load-more-wrap');
    if (!feed) { this.loading = false; return; }

    if (!append) {
      this.offset = 0;
      this.hasMore = true;
      feed.innerHTML = this.skeletons(3);
    } else {
      /* Append a skeleton at bottom while loading */
      feed.insertAdjacentHTML('beforeend',
        `<div id="append-skeleton">${this.skeletons(2)}</div>`);
    }

    try {
      const data  = await AURUM.LedgerAPI.getFeed(this.offset);
      const posts = data.posts || [];

      /* Remove append skeleton if present */
      document.getElementById('append-skeleton')?.remove();

      if (!append) feed.innerHTML = '';

      if (!posts.length && !append) {
        feed.innerHTML = `
          <div class="empty-state">
            <div class="empty-state-icon">📋</div>
            <h4>No posts yet</h4>
            <p>Be the first to post a verified win.</p>
          </div>`;
        if (loadMoreWrap) loadMoreWrap.style.display = 'none';
        this.loading = false;
        return;
      }

      posts.forEach(post => {
        feed.insertAdjacentHTML('beforeend', this.postHTML(post));
      });

      /* Pagination state */
      this.offset  += posts.length;
      this.hasMore  = posts.length >= this.pageSize;

      if (loadMoreWrap) {
        loadMoreWrap.style.display = this.hasMore ? 'block' : 'none';
      }

    } catch (err) {
      document.getElementById('append-skeleton')?.remove();

      if (!append) {
        /* Show mock posts so feed is never blank */
        feed.innerHTML = '';
        getMockPosts().forEach(post => {
          feed.insertAdjacentHTML('beforeend', this.postHTML(post));
        });
        if (loadMoreWrap) loadMoreWrap.style.display = 'none';
      }
    } finally {
      this.loading = false;
      this.bindPostEvents();
    }
  },

  async submitPost() {
    const content = document.getElementById('post-content')?.value.trim();
    const stake   = document.getElementById('post-stake')?.value;
    const btn     = document.getElementById('btn-post');

    if (!content) {
      AURUM.showToast('Write something worth staking.', 'error');
      return;
    }

    btn.textContent = 'Posting...';
    btn.disabled    = true;

    try {
      await AURUM.LedgerAPI.createPost({
        content,
        stake_amount: parseFloat(stake),
      });
      document.getElementById('post-content').value = '';
      document.getElementById('post-content').style.height = 'auto';
      AURUM.showToast('Win posted. Stake locked.', 'gold');
      /* Reload from top */
      this.loadPosts(false);
    } catch (err) {
      AURUM.showToast(err.message || 'Post failed.', 'error');
    } finally {
      btn.textContent = 'Post Win';
      btn.disabled    = false;
    }
  },

  bindPostEvents() {
    /* ---- Tip buttons — optimistic UI ---- */
    document.querySelectorAll('.btn-tip').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', async () => {
        const postId     = btn.dataset.postId;
        const receiverId = btn.dataset.receiverId;
        const counterEl  = document.querySelector(`[data-tips="${postId}"]`);
        const prev       = parseFloat(counterEl?.dataset.total || '0');

        if (!receiverId) {
          AURUM.showToast('Could not identify post author for tip.', 'error');
          return;
        }

        /* Optimistic update */
        if (counterEl) {
          const optimistic = prev + 1;
          counterEl.textContent     = formatAurum(optimistic);
          counterEl.dataset.total   = optimistic;
          btn.style.color           = 'var(--color-gold)';
        }

        try {
          await AURUM.TipsAPI.send({
            post_id:     postId,
            receiver_id: receiverId,
            amount_usd:  1,
          });
          AURUM.showToast('Tip sent!', 'gold');
        } catch (err) {
          /* Roll back on failure */
          if (counterEl) {
            counterEl.textContent   = formatAurum(prev);
            counterEl.dataset.total = prev;
            btn.style.color         = '';
          }
          AURUM.showToast(err.message || 'Tip failed.', 'error');
        }
      });
    });

    /* ---- Cheer (Gold Button on posts) ---- */
    document.querySelectorAll('.btn-cheer').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', async () => {
        const postId    = btn.dataset.postId;
        const countEl   = btn.querySelector('.cheer-count');
        const prevCount = parseInt(countEl?.textContent || '0', 10);

        /* Optimistic */
        btn.classList.add('cheered');
        btn.disabled = true;
        if (countEl) countEl.textContent = prevCount + 1;

        try {
          await AURUM.LedgerAPI.cheer(postId);
        } catch (err) {
          /* Roll back */
          btn.classList.remove('cheered');
          btn.disabled = false;
          if (countEl) countEl.textContent = prevCount;
          AURUM.showToast(err.message || 'Could not cheer post.', 'error');
        }
      });
    });

    /* ---- Comment toggle buttons ---- */
    document.querySelectorAll('.btn-comment-toggle').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', () => {
        const postId = btn.dataset.postId;
        this.toggleComments(postId);
      });
    });

    /* ---- Comment submit buttons (top-level, per post) ---- */
    document.querySelectorAll('.btn-comment-submit').forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', () => {
        const postId = btn.dataset.postId;
        this.submitComment(postId, null, btn);
      });
    });

    /* ---- Comment input character counters (top-level) ---- */
    document.querySelectorAll('.comment-input').forEach(input => {
      if (input.dataset.bound) return;
      input.dataset.bound = '1';

      input.addEventListener('input', () => {
        this.updateCharCount(input);
      });
    });
  },

  /* -----------------------------------------
     COMMENTS — toggle open/closed per post
  ----------------------------------------- */
  async toggleComments(postId) {
    const section = document.getElementById(`comments-${postId}`);
    if (!section) return;

    const isOpen = this.openComments.has(postId);

    if (isOpen) {
      this.openComments.delete(postId);
      section.style.display = 'none';
      return;
    }

    this.openComments.add(postId);
    section.style.display = 'block';

    /* Load from cache if we have it, otherwise fetch fresh */
    if (this.commentCache.has(postId)) {
      this.renderCommentList(postId, this.commentCache.get(postId));
    } else {
      await this.loadComments(postId);
    }
  },

  async loadComments(postId) {
    const listEl = document.getElementById(`comments-list-${postId}`);
    if (!listEl) return;

    listEl.innerHTML = `
      <div class="skeleton" style="height:40px;border-radius:8px;margin-bottom:8px;"></div>
      <div class="skeleton" style="height:40px;border-radius:8px;"></div>
    `;

    try {
      const data = await AURUM.CommentsAPI.getForPost(postId);
      const comments = data.comments || [];
      this.commentCache.set(postId, comments);
      this.renderCommentList(postId, comments);
    } catch (err) {
      listEl.innerHTML = `<p style="font-size:var(--text-sm);color:var(--color-text-muted);
        padding:var(--space-3) 0;">Could not load comments.</p>`;
    }
  },

  renderCommentList(postId, comments) {
    const listEl = document.getElementById(`comments-list-${postId}`);
    if (!listEl) return;

    if (!comments.length) {
      listEl.innerHTML = `<p style="font-size:var(--text-sm);color:var(--color-text-muted);
        padding:var(--space-3) 0;">No comments yet. Be the first to say something.</p>`;
      return;
    }

    listEl.innerHTML = comments.map(c => this.commentHTML(postId, c, 0)).join('');
    this.bindCommentEvents(postId);
  },

  /* Recursive — a comment renders itself, then all of its
     replies indented one level further. depth is capped
     visually so deep threads don't run off-screen on mobile. */
  commentHTML(postId, comment, depth) {
    const initials    = comment.username?.charAt(0).toUpperCase() || '?';
    const indent       = Math.min(depth, 4) * 20;
    const isOwnComment = window.App?.user?.id === comment.user_id;

    const repliesHTML = (comment.replies || [])
      .map(reply => this.commentHTML(postId, reply, depth + 1))
      .join('');

    return `
      <div class="comment-item" style="margin-left:${indent}px;" data-comment-id="${comment.id}">
        <div class="comment-row">
          <div class="avatar avatar-sm" style="width:24px;height:24px;font-size:11px;flex-shrink:0;">
            ${initials}
          </div>
          <div class="comment-body">
            <div class="comment-meta">
              <span class="comment-username">${comment.username || 'Anonymous'}</span>
              <span class="comment-time">${AURUM.timeAgo(comment.created_at)}</span>
            </div>
            <p class="comment-text">${this.escapeHTML(comment.content)}</p>
            <div class="comment-actions">
              <button class="comment-action-link btn-reply-toggle"
                data-post-id="${postId}" data-comment-id="${comment.id}">
                Reply
              </button>
              ${isOwnComment ? `
                <button class="comment-action-link comment-action-danger btn-comment-delete"
                  data-post-id="${postId}" data-comment-id="${comment.id}">
                  Delete
                </button>
              ` : ''}
            </div>
            <div class="reply-input-wrap" id="reply-wrap-${comment.id}" style="display:none;">
              <textarea class="comment-input reply-input" maxlength="${COMMENT_MAX_LENGTH}"
                data-parent-id="${comment.id}" placeholder="Write a reply..." rows="1"></textarea>
              <div class="comment-input-footer">
                <span class="comment-char-count" data-max="${COMMENT_MAX_LENGTH}">0/${COMMENT_MAX_LENGTH}</span>
                <button class="btn btn-primary btn-sm btn-reply-submit"
                  data-post-id="${postId}" data-comment-id="${comment.id}">Reply</button>
              </div>
            </div>
          </div>
        </div>
        ${repliesHTML}
      </div>
    `;
  },

  bindCommentEvents(postId) {
    /* Reply toggle — shows/hides the inline reply box under a comment */
    document.querySelectorAll(`#comments-list-${postId} .btn-reply-toggle`).forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', () => {
        const commentId = btn.dataset.commentId;
        const wrap = document.getElementById(`reply-wrap-${commentId}`);
        if (wrap) {
          const showing = wrap.style.display !== 'none';
          wrap.style.display = showing ? 'none' : 'block';
          if (!showing) wrap.querySelector('textarea')?.focus();
        }
      });
    });

    /* Reply submit */
    document.querySelectorAll(`#comments-list-${postId} .btn-reply-submit`).forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', () => {
        const parentId = btn.dataset.commentId;
        this.submitComment(postId, parentId, btn);
      });
    });

    /* Reply textarea char counters */
    document.querySelectorAll(`#comments-list-${postId} .reply-input`).forEach(input => {
      if (input.dataset.bound) return;
      input.dataset.bound = '1';

      input.addEventListener('input', () => this.updateCharCount(input));
    });

    /* Delete own comment */
    document.querySelectorAll(`#comments-list-${postId} .btn-comment-delete`).forEach(btn => {
      if (btn.dataset.bound) return;
      btn.dataset.bound = '1';

      btn.addEventListener('click', () => {
        const commentId = btn.dataset.commentId;
        this.deleteComment(postId, commentId);
      });
    });
  },

  updateCharCount(input) {
    const wrap    = input.closest('.reply-input-wrap') || input.closest('.comment-composer');
    const counter = wrap?.querySelector('.comment-char-count');
    if (!counter) return;
    const max = parseInt(counter.dataset.max || COMMENT_MAX_LENGTH, 10);
    const len = input.value.length;
    counter.textContent = `${len}/${max}`;
    counter.style.color = len >= max ? 'var(--color-danger)' : 'var(--color-text-muted)';
  },

  async submitComment(postId, parentId, triggerBtn) {
    const inputSelector = parentId
      ? `#reply-wrap-${parentId} .reply-input`
      : `#comment-composer-${postId} .comment-input`;
    const input = document.querySelector(inputSelector);
    if (!input) return;

    const content = input.value.trim();
    if (!content) {
      AURUM.showToast('Write something before posting.', 'error');
      return;
    }
    if (content.length > COMMENT_MAX_LENGTH) {
      AURUM.showToast(`Comments are limited to ${COMMENT_MAX_LENGTH} characters.`, 'error');
      return;
    }

    const originalText = triggerBtn.textContent;
    triggerBtn.textContent = 'Posting...';
    triggerBtn.disabled    = true;

    try {
      await AURUM.CommentsAPI.create(postId, {
        content,
        parent_comment_id: parentId ?? undefined,
      });
      input.value = '';

      /* Update the visible comment count on the post card */
      const countEl = document.querySelector(`[data-comment-count="${postId}"]`);
      if (countEl) {
        countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + 1;
      }

      /* Collapse the reply box if this was a reply */
      if (parentId) {
        const wrap = document.getElementById(`reply-wrap-${parentId}`);
        if (wrap) wrap.style.display = 'none';
      }

      /* Refresh the thread from the server so the new comment
         (and correct nesting) shows up immediately */
      this.commentCache.delete(postId);
      await this.loadComments(postId);

      AURUM.showToast(parentId ? 'Reply posted.' : 'Comment posted.', 'gold');
    } catch (err) {
      AURUM.showToast(err.message || 'Could not post comment.', 'error');
    } finally {
      triggerBtn.textContent = originalText;
      triggerBtn.disabled    = false;
    }
  },

  async deleteComment(postId, commentId) {
    if (!confirm('Delete this comment? This cannot be undone.')) return;

    try {
      await AURUM.CommentsAPI.remove(commentId);

      /* Update the visible comment count on the post card */
      const countEl = document.querySelector(`[data-comment-count="${postId}"]`);
      if (countEl) {
        countEl.textContent = Math.max((parseInt(countEl.textContent, 10) || 1) - 1, 0);
      }

      this.commentCache.delete(postId);
      await this.loadComments(postId);
      AURUM.showToast('Comment deleted.', 'default');
    } catch (err) {
      AURUM.showToast(err.message || 'Could not delete comment.', 'error');
    }
  },

  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  },

  postHTML(post) {
    const initials    = post.username?.charAt(0).toUpperCase() || '?';
    const league      = post.league || 'bronze';
    const stakeStatus = post.stake_status || 'locked';

    /* FIX: real stake_status values are locked / returned /
       appeal_pending / slashed — not verified / pending / disputed. */
    const stakeColor  = {
      locked:         'var(--color-gold)',
      returned:       'var(--color-success)',
      appeal_pending: 'var(--color-danger)',
      slashed:        'var(--color-danger)',
    }[stakeStatus] || 'var(--color-text-muted)';

    const stakeStatusLabel = {
      locked:         'Locked — Pending Review',
      returned:       'Verified',
      appeal_pending: 'Disputed — Appeal Open',
      slashed:        'Removed — Fake Claim',
    }[stakeStatus] || stakeStatus;

    /* Tips are only meaningful once a post is verified.
       Unverified posts can still be cheered — matches the
       cheer-priority verification-queue idea. */
    const tipsEnabled = stakeStatus === 'returned';

    const cheers = post.cheers || 0;
    const commentCount = post.comment_count ?? post.comments ?? 0;

    /* FIX: backend field is media_urls (plural) — was reading
       media_url and silently never rendering any image. */
    const mediaUrl = post.media_urls || post.media_url || null;

    return `
      <div class="post-card card fade-in">
        <div class="post-header">
          <div class="avatar avatar-sm ${league === 'sovereign' ? 'avatar-gold' : ''}">
            ${initials}
          </div>
          <div class="post-meta">
            <div class="post-username">
              ${post.username || 'Anonymous'}
              ${post.verified
                ? '<span style="color:var(--color-gold);font-size:10px;">✦</span>'
                : ''}
            </div>
            <div class="post-sub">
              <span class="badge ${AURUM.getLeagueBadge(league)}" style="font-size:9px;">
                ${league}
              </span>
              <span class="post-time">
                ${AURUM.timeAgo(post.created_at || new Date())}
              </span>
            </div>
          </div>
          <div class="post-stake" style="border-color:${stakeColor};">
            <span class="post-stake-amount mono" style="color:${stakeColor};">
              ₳${post.stake_amount_usd || (post.stake_amount_cents / 100) || 5}
            </span>
            <span class="post-stake-label">stake</span>
          </div>
        </div>

        <p class="post-content">${post.content || ''}</p>

        ${mediaUrl ? `
          <img src="${mediaUrl}" class="post-media" alt="Achievement proof" />
        ` : ''}

        <div class="post-actions">

          <!-- Tip button — disabled with explanation until verified -->
          <button class="btn-tip post-action-btn" data-post-id="${post.id}"
            data-receiver-id="${post.user_id || ''}"
            ${tipsEnabled ? '' : 'disabled'}
            title="${tipsEnabled ? 'Send a tip' : 'Tips unlock once this win is verified'}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/>
            </svg>
            <span class="post-action-value mono"
              data-tips="${post.id}"
              data-total="${post.tips_received || 0}">
              ${formatAurum(post.tips_received || 0)}
            </span>
          </button>

          <!-- Cheer (Gold Button) — always available, even pre-verification -->
          <button class="btn-cheer post-action-btn ${post.user_cheered ? 'cheered' : ''}"
            data-post-id="${post.id}"
            ${post.user_cheered ? 'disabled' : ''}>
            <svg width="14" height="14" viewBox="0 0 24 24"
              fill="${post.user_cheered ? 'var(--color-gold)' : 'none'}"
              stroke="var(--color-gold)" stroke-width="2">
              <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02
                12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
            </svg>
            <span class="cheer-count post-action-value mono">${cheers}</span>
          </button>

          <!-- Comments — now live -->
          <button class="post-action-btn btn-comment-toggle" data-post-id="${post.id}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2">
              <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
            </svg>
            <span class="post-action-value mono" data-comment-count="${post.id}">${commentCount}</span>
          </button>

          <!-- Stake status -->
          <div class="post-stake-status" style="margin-left:auto;">
            <span style="font-size:9px;letter-spacing:0.08em;text-transform:uppercase;
              color:${stakeColor};">
              ${stakeStatusLabel}
            </span>
          </div>

        </div>

        <!-- Comment section — hidden until toggled -->
        <div class="comments-section" id="comments-${post.id}" style="display:none;">
          <div class="comments-list" id="comments-list-${post.id}"></div>

          <div class="comment-composer" id="comment-composer-${post.id}">
            <textarea class="comment-input" maxlength="${COMMENT_MAX_LENGTH}"
              placeholder="Add a comment..." rows="1"></textarea>
            <div class="comment-input-footer">
              <span class="comment-char-count" data-max="${COMMENT_MAX_LENGTH}">0/${COMMENT_MAX_LENGTH}</span>
              <button class="btn btn-primary btn-sm btn-comment-submit" data-post-id="${post.id}">
                Post
              </button>
            </div>
          </div>
        </div>

      </div>
    `;
  },

  skeletons(count) {
    return Array(count).fill(`
      <div class="post-card card">
        <div class="post-header">
          <div class="skeleton" style="width:32px;height:32px;border-radius:50%;flex-shrink:0;"></div>
          <div style="flex:1;display:flex;flex-direction:column;gap:6px;">
            <div class="skeleton" style="height:14px;width:120px;"></div>
            <div class="skeleton" style="height:10px;width:80px;"></div>
          </div>
          <div class="skeleton" style="width:48px;height:40px;border-radius:8px;"></div>
        </div>
        <div class="skeleton" style="height:14px;width:100%;margin-top:12px;"></div>
        <div class="skeleton" style="height:14px;width:80%;margin-top:6px;"></div>
        <div class="skeleton" style="height:14px;width:60%;margin-top:6px;"></div>
        <div style="display:flex;gap:16px;margin-top:12px;padding-top:12px;
          border-top:1px solid var(--color-border);">
          <div class="skeleton" style="height:20px;width:60px;border-radius:4px;"></div>
          <div class="skeleton" style="height:20px;width:40px;border-radius:4px;"></div>
        </div>
      </div>
    `).join('');
  },

  applyStyles() {
    if (document.getElementById('ledger-styles')) return;
    const style = document.createElement('style');
    style.id = 'ledger-styles';
    style.textContent = `
      .ledger-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        padding: var(--space-4);
      }

      .composer {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .composer-top {
        display: flex;
        gap: var(--space-3);
        align-items: flex-start;
      }

      .composer-input-wrap { flex: 1; }

      .composer-input {
        width: 100%;
        background: transparent;
        border: none;
        color: var(--color-text);
        font-size: var(--text-base);
        resize: none;
        outline: none;
        line-height: 1.6;
        min-height: 40px;
        font-family: var(--font-body);
      }

      .composer-input::placeholder { color: var(--color-text-dim); }

      .composer-bottom {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding-top: var(--space-3);
        border-top: 1px solid var(--color-border);
      }

      .stake-selector {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .stake-label {
        font-size: var(--text-xs);
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .stake-select {
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-gold);
        font-family: var(--font-mono);
        font-size: var(--text-sm);
        padding: var(--space-1) var(--space-2);
        cursor: pointer;
      }

      .feed {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .post-card {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .post-header {
        display: flex;
        align-items: flex-start;
        gap: var(--space-3);
      }

      .post-meta {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }

      .post-username {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        color: var(--color-text);
        display: flex;
        align-items: center;
        gap: var(--space-1);
      }

      .post-sub {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .post-time {
        font-size: 10px;
        color: var(--color-text-muted);
        letter-spacing: 0.04em;
      }

      .post-stake {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: var(--space-2) var(--space-3);
        border: 1px solid;
        border-radius: var(--radius-md);
        flex-shrink: 0;
      }

      .post-stake-amount {
        font-size: var(--text-sm);
        font-weight: var(--weight-medium);
        line-height: 1;
      }

      .post-stake-label {
        font-size: 9px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--color-text-muted);
      }

      .post-content {
        font-size: var(--text-base);
        color: var(--color-text);
        line-height: 1.6;
      }

      .post-media {
        width: 100%;
        border-radius: var(--radius-md);
        border: 1px solid var(--color-border);
        max-height: 240px;
        object-fit: cover;
      }

      .post-actions {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        padding-top: var(--space-2);
        border-top: 1px solid var(--color-border);
      }

      .post-action-btn {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--color-text-muted);
        font-size: var(--text-xs);
        transition: color var(--transition-base);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
      }

      .post-action-btn:hover { color: var(--color-gold); }
      .post-action-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      .post-action-btn:disabled:hover { color: var(--color-text-muted); }

      .post-action-value { font-size: var(--text-xs); }

      /* Cheer active state */
      .btn-cheer.cheered { color: var(--color-gold); }
      .btn-cheer:not(:disabled):hover { color: var(--color-gold); }

      /* ---- Comments ---- */
      .comments-section {
        margin-top: var(--space-2);
        padding-top: var(--space-3);
        border-top: 1px solid var(--color-border);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .comments-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }

      .comment-item {
        display: flex;
        flex-direction: column;
      }

      .comment-row {
        display: flex;
        gap: var(--space-2);
        align-items: flex-start;
      }

      .comment-body {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .comment-meta {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }

      .comment-username {
        font-size: var(--text-xs);
        font-weight: var(--weight-medium);
        color: var(--color-text);
      }

      .comment-time {
        font-size: 10px;
        color: var(--color-text-muted);
      }

      .comment-text {
        font-size: var(--text-sm);
        color: var(--color-text);
        line-height: 1.5;
        word-break: break-word;
      }

      .comment-actions {
        display: flex;
        gap: var(--space-3);
        margin-top: 2px;
      }

      .comment-action-link {
        font-size: 10px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--color-text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        transition: color var(--transition-base);
      }

      .comment-action-link:hover { color: var(--color-gold); }
      .comment-action-danger:hover { color: var(--color-danger); }

      .reply-input-wrap {
        margin-top: var(--space-2);
      }

      .comment-composer,
      .reply-input-wrap {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }

      .comment-input {
        width: 100%;
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        border-radius: var(--radius-md);
        color: var(--color-text);
        font-size: var(--text-sm);
        padding: var(--space-2) var(--space-3);
        resize: none;
        outline: none;
        font-family: var(--font-body);
        line-height: 1.5;
      }

      .comment-input:focus {
        border-color: var(--color-gold-dim);
      }

      .comment-input::placeholder { color: var(--color-text-dim); }

      .comment-input-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
      }

      .comment-char-count {
        font-size: 10px;
        color: var(--color-text-muted);
        font-family: var(--font-mono);
      }
    `;
    document.head.appendChild(style);
  },
};

/* ---- Mock posts fallback ---- */
function getMockPosts() {
  return [
    {
      id: '1',
      username: 'ShadowKing',
      league: 'sovereign',
      verified: true,
      content: 'Just closed a $84K SaaS contract. Three months of cold outreach paid off.',
      stake_amount: 100,
      stake_status: 'returned',
      tips_received: 1240,
      cheers: 47,
      comment_count: 18,
      created_at: new Date(Date.now() - 3600000).toISOString(),
    },
    {
      id: '2',
      username: 'NovaBuild',
      league: 'gold',
      verified: true,
      content: 'Hit $10K MRR on my B2B tool. 8 months from zero. No investors. No co-founder.',
      stake_amount: 50,
      stake_status: 'returned',
      tips_received: 870,
      cheers: 31,
      comment_count: 31,
      created_at: new Date(Date.now() - 7200000).toISOString(),
    },
    {
      id: '3',
      username: 'IronFounder',
      league: 'gold',
      verified: false,
      content: 'First enterprise client signed. $2K/month recurring.',
      stake_amount: 25,
      stake_status: 'locked',
      tips_received: 340,
      cheers: 12,
      comment_count: 9,
      created_at: new Date(Date.now() - 14400000).toISOString(),
    },
    {
      id: '4',
      username: 'ZeroToOne',
      league: 'silver',
      verified: false,
      content: 'Crossed $1K saved for the first time. Small win. But it\'s on the board.',
      stake_amount: 5,
      stake_status: 'locked',
      tips_received: 95,
      cheers: 8,
      comment_count: 22,
      created_at: new Date(Date.now() - 86400000).toISOString(),
    },
  ];
}

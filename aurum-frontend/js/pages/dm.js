const DmPage = {
  activeChannelId: null,

  async init(containerId) {
    this.container = document.getElementById(containerId);
    this.applyStyles();
    await this.renderList();
  },

  async renderList() {
    this.container.innerHTML = `
      <div class="dm-page-header">
        <p class="section-eyebrow">Private Channel</p>
        <h2 class="dm-page-title">Messages</h2>
      </div>
      <p class="dm-loading-text">Loading conversations...</p>`;
    try {
      const { channels } = await AURUM.DmAPI.getChannels();
      if (!channels || !channels.length) {
        this.container.innerHTML = `
          <div class="dm-page-header">
            <p class="section-eyebrow">Private Channel</p>
            <h2 class="dm-page-title">Messages</h2>
          </div>
          <div class="empty-state">
            <div class="empty-state-icon">✦</div>
            <h4>No conversations yet</h4>
            <p>Find someone in Search and say hello.</p>
          </div>`;
        return;
      }
      this.container.innerHTML = `
        <div class="dm-page-header">
          <p class="section-eyebrow">Private Channel</p>
          <h2 class="dm-page-title">Messages</h2>
        </div>
        <div id="dm-list" class="dm-list">
          ${channels.map(c => `
            <div class="dm-list-item" data-channel-id="${c.channel_id}" data-username="${this.escapeHTML(c.other_username)}" data-avatar="${this.escapeHTML(c.other_avatar_url || '')}">
              <div class="avatar avatar-sm dm-list-avatar">${AURUM.avatarInnerHTML(c.other_avatar_url, this.escapeHTML(c.other_username).charAt(0).toUpperCase())}</div>
              <div class="dm-list-info">
                <p class="dm-list-name">${this.escapeHTML(c.other_username)}</p>
                <p class="dm-list-preview">${c.last_message ? this.escapeHTML(c.last_message) : 'No messages yet'}</p>
              </div>
            </div>
          `).join('')}
        </div>`;
      document.querySelectorAll('.dm-list-item').forEach(item => {
        item.addEventListener('click', () => {
          this.openThread(item.dataset.channelId, item.dataset.username, item.dataset.avatar);
        });
      });
    } catch (err) {
      this.container.innerHTML = `<p class="dm-loading-text" style="color:var(--color-danger);">Failed to load conversations.</p>`;
    }
  },
	
  async openThread(channelId, username, avatarUrl) {
    this.activeChannelId = channelId;
    this.activeUsername = username;
    this.container.innerHTML = `
      <div class="dm-thread">
        <div class="dm-thread-header">
          <button class="dm-back-btn" id="dm-back-btn" aria-label="Back">&larr;</button>
          <div class="avatar avatar-sm dm-thread-avatar">${AURUM.avatarInnerHTML(avatarUrl, this.escapeHTML(username).charAt(0).toUpperCase())}</div>
          <p class="dm-thread-name">${this.escapeHTML(username)}</p>
        </div>
        <div id="dm-thread-messages" class="dm-thread-messages">
          <p class="dm-loading-text">Loading messages...</p>
        </div>
        <div id="dm-reply-bar-container"></div>
        <div class="dm-input-bar">
          <input class="input dm-input" id="dm-message-input" placeholder="Send a message..." />
          <button class="dm-send-btn" id="dm-send-btn" aria-label="Send">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>
          </button>
        </div>
      </div>`;
    document.getElementById('dm-back-btn').addEventListener('click', () => this.closeThread());
    document.getElementById('dm-send-btn').addEventListener('click', () => this.sendMessage());
    document.getElementById('dm-message-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.sendMessage();
    });
    await this.loadMessages();
    this.connectSocket(channelId);
    this.wireReactionHandlers();
    this.wireSwipeToReply();
  },
  wireReactionHandlers() {
    const list = document.getElementById('dm-thread-messages');
    if (!list || list.dataset.reactionsWired) return;
    list.dataset.reactionsWired = '1';
    list.addEventListener('click', async (e) => {
      const pill = e.target.closest('.reaction-pill');
      const addBtn = e.target.closest('.reaction-add-btn');
      if (pill) {
        const messageId = pill.dataset.messageId;
        const emoji = pill.dataset.emoji;
        const isActive = pill.classList.contains('reaction-pill-active');
        try {
          if (isActive) {
            await AURUM.DmAPI.removeReaction(messageId);
          } else {
            await AURUM.DmAPI.reactToMessage(messageId, emoji);
          }
          await this.loadMessages();
        } catch (err) {
          AURUM.showToast(err.message || 'Could not react.', 'error');
        }
        return;
      }
      if (addBtn) {
        const messageId = addBtn.dataset.messageId;
        this.openEmojiPicker(addBtn, messageId, 'dm');
      }
    });
  },
	wireSwipeToReply() {
    const list = document.getElementById('dm-thread-messages');
    if (!list || list.dataset.swipeWired) return;
    list.dataset.swipeWired = '1';
    let swipe = null;
    list.addEventListener('touchstart', (e) => {
      const bubble = e.target.closest('.dm-message-wrap');
      if (!bubble) return;
      swipe = { bubble, startX: e.touches[0].clientX };
    }, { passive: true });
    list.addEventListener('touchmove', (e) => {
      if (!swipe) return;
      const dx = e.touches[0].clientX - swipe.startX;
      const clamped = Math.max(0, Math.min(dx, 70));
      swipe.currentX = clamped;
      swipe.bubble.style.transform = `translateX(${clamped}px)`;
      swipe.bubble.classList.toggle('swipe-armed', clamped > 45);
    }, { passive: true });
    const endSwipe = () => {
      if (!swipe) return;
      swipe.bubble.style.transform = '';
      swipe.bubble.classList.remove('swipe-armed');
      if (swipe.currentX > 45) {
        this.startReply(swipe.bubble.dataset.messageId);
      }
      swipe = null;
    };
    list.addEventListener('touchend', endSwipe);
    list.addEventListener('touchcancel', endSwipe);
  },

  startReply(messageId) {
    const bubble = document.querySelector(`#dm-thread-messages [data-message-id="${messageId}"]`);
    if (!bubble) return;
    const text = bubble.querySelector('.dm-bubble')?.textContent || '';
    const isMine = bubble.classList.contains('dm-message-mine');
    const sender = isMine ? 'yourself' : this.activeUsername;
    this.replyingToMessage = { id: messageId, sender, text: text.slice(0, 80) };
    this.renderReplyBar();
  },

  renderReplyBar() {
    const container = document.getElementById('dm-reply-bar-container');
    if (!container) return;
    if (!this.replyingToMessage) { container.innerHTML = ''; return; }
    const r = this.replyingToMessage;
    container.innerHTML = `
      <div class="reply-preview-bar">
        <div class="reply-preview-content">
          <span class="reply-preview-label">Replying to ${this.escapeHTML(r.sender)}</span>
          <span class="reply-preview-text">${this.escapeHTML(r.text)}</span>
        </div>
        <button class="reply-preview-cancel" id="btn-cancel-dm-reply">&times;</button>
      </div>
    `;
    document.getElementById('btn-cancel-dm-reply')?.addEventListener('click', () => {
      this.replyingToMessage = null;
      this.renderReplyBar();
    });
  },

  openEmojiPicker(anchorEl, messageId, surface) {
    document.querySelectorAll('.reaction-picker-popup').forEach(p => p.remove());
    const emojiList = ['🔥', '👑', '💰', '⚔️', '😂', '🖤'];
    const popup = document.createElement('div');
    popup.className = 'reaction-picker-popup';
    popup.style.cssText = 'position:absolute;background:var(--color-surface);border:1px solid var(--color-border);border-radius:8px;padding:4px 6px;display:flex;gap:4px;z-index:1000;';
    popup.innerHTML = emojiList.map(e => `<span data-emoji="${e}" style="cursor:pointer;font-size:16px;padding:2px;">${e}</span>`).join('');
    document.body.appendChild(popup);
    const rect = anchorEl.getBoundingClientRect();
    popup.style.top = `${window.scrollY + rect.bottom + 4}px`;
    popup.style.left = `${window.scrollX + rect.left}px`;
    popup.querySelectorAll('span').forEach(span => {
      span.addEventListener('click', async () => {
        popup.remove();
        try {
          if (surface === 'dm') {
            await AURUM.DmAPI.reactToMessage(messageId, span.dataset.emoji);
            await this.loadMessages();
          } else {
            await AURUM.CrewAPI.reactToMessage(messageId, span.dataset.emoji);
            await AURUM.ArenaPage.refreshCrewReactions();
          }
        } catch (err) {
          AURUM.showToast(err.message || 'Could not react.', 'error');
        }
      });
    });
    setTimeout(() => {
      document.addEventListener('click', function closePopup(ev) {
        if (!popup.contains(ev.target) && ev.target !== anchorEl) {
          popup.remove();
          document.removeEventListener('click', closePopup);
        }
      });
    }, 0);
  },

  connectSocket(channelId) {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    const token = AURUM.Auth.getToken();
    if (!token) return;
    const wsBase = API_BASE.replace('https://', 'wss://').replace('http://', 'ws://');
    this.socket = new WebSocket(`${wsBase}/api/dm/channels/${channelId}/ws?token=${encodeURIComponent(token)}`);
    this.socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'reaction') {
          this.loadMessages();
        } else {
          this.appendMessage(msg);
        }
      } catch (err) {
        /* ignore malformed message */
      }
    });
    this.socket.addEventListener('close', () => {
      this.socket = null;
    });
  },

  closeThread() {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.activeChannelId = null;
    this.renderList();
  },

  appendMessage(msg) {
    const list = document.getElementById('dm-thread-messages');
    if (!list) return;
    const me = AURUM.ProfileCache.get();
    const isMine = msg.senderId === me?.id;
    const wasEmpty = list.querySelector('p') && !list.querySelector('div');
    if (wasEmpty) list.innerHTML = '';
    let replyQuoteHTML = '';
    if (msg.replyToMessageId) {
      const originalBubble = list.querySelector(`[data-message-id="${msg.replyToMessageId}"]`);
      if (originalBubble) {
        const originalIsMine = originalBubble.classList.contains('dm-message-mine');
        const originalSender = originalIsMine ? 'You' : this.activeUsername;
        const originalText = originalBubble.querySelector('.dm-bubble')?.textContent || '';
        replyQuoteHTML = `
          <div class="reply-quote">
            <span class="reply-quote-sender">${this.escapeHTML(originalSender)}</span>
            <span class="reply-quote-text">${this.escapeHTML(originalText)}</span>
          </div>`;
      }
    }
    const bubble = document.createElement('div');
    bubble.className = `dm-message-wrap${isMine ? ' dm-message-mine' : ''}`;
    bubble.dataset.messageId = msg.id;
    bubble.innerHTML = `
      ${replyQuoteHTML}
      <p class="dm-bubble">${this.escapeHTML(msg.content)}</p>
      ${this.reactionBarHTML(msg.id, {})}`;
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
  },
	
  reactionBarHTML(messageId, reactions) {
    const pills = Object.entries(reactions).map(([emoji, data]) => `
      <button class="reaction-pill${data.reacted_by_me ? ' reaction-pill-active' : ''}" data-message-id="${messageId}" data-emoji="${emoji}" style="font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid ${data.reacted_by_me ? 'var(--color-gold-dim)' : 'var(--color-border)'};background:${data.reacted_by_me ? 'var(--color-gold-glow)' : 'transparent'};color:${data.reacted_by_me ? 'var(--color-gold)' : 'var(--color-text-muted)'};cursor:pointer;margin-right:2px;">
        ${emoji} ${data.count}
      </button>
    `).join('');
    return `
      <div class="reaction-bar" style="margin-top:4px;">
        ${pills}
        <button class="reaction-add-btn" data-message-id="${messageId}" style="font-size:11px;padding:1px 6px;border-radius:10px;border:1px dashed var(--color-border);background:transparent;cursor:pointer;color:var(--color-text-muted);">+</button>
      </div>
    `;
  },

  async loadMessages() {
    const list = document.getElementById('dm-thread-messages');
    try {
      const me = AURUM.ProfileCache.get();
      const { messages } = await AURUM.DmAPI.getMessages(this.activeChannelId);
      if (!messages || !messages.length) {
        list.innerHTML = `<p style="color:var(--color-text-muted);">No messages yet. Say hello.</p>`;
        return;
      }
      this.dmMessageReactions = {};
      try {
        const reactData = await AURUM.DmAPI.getReactions(messages.map(m => m.id));
        this.dmMessageReactions = reactData.reactions || {};
      } catch (err) {
        /* Non-fatal — messages still show, just without reaction counts if this fails */
      }
      list.innerHTML = messages.slice().reverse().map(m => `
        <div class="dm-message-wrap${m.sender_id === me?.id ? ' dm-message-mine' : ''}" data-message-id="${m.id}">
          ${m.reply_to ? `
            <div class="reply-quote">
              <span class="reply-quote-sender">${this.escapeHTML(m.reply_to.sender_username || 'Someone')}</span>
              <span class="reply-quote-text">${m.reply_to.deleted ? 'Message removed' : this.escapeHTML(m.reply_to.content)}</span>
            </div>` : ''}
          <p class="dm-bubble">${m.deleted ? '<em>message deleted</em>' : this.escapeHTML(m.content)}</p>
          ${this.reactionBarHTML(m.id, (this.dmMessageReactions[m.id] || {}))}
        </div>
      `).join('');
      list.scrollTop = list.scrollHeight;
    } catch (err) {
      list.innerHTML = `<p style="color:var(--color-danger);">Failed to load messages.</p>`;
    }
  },

  async sendMessage() {
    const input = document.getElementById('dm-message-input');
    const content = input.value.trim();
    if (!content) return;
    const replyToId = this.replyingToMessage?.id || null;
    input.value = '';
    this.replyingToMessage = null;
    this.renderReplyBar();
    try {
      await AURUM.DmAPI.sendMessage(this.activeChannelId, content, replyToId);
    } catch (err) {
      AURUM.showToast(err.message || 'Could not send message.', 'error');
    }
  },

  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  },

  applyStyles() {
    if (document.getElementById('dm-page-styles')) return;
    const style = document.createElement('style');
    style.id = 'dm-page-styles';
    style.textContent = `
      .dm-page-header {
        padding: var(--space-4) var(--space-4) var(--space-2);
      }
      .dm-page-title {
        font-family: var(--font-display);
        font-size: var(--text-3xl);
        font-weight: var(--weight-light);
        font-style: italic;
        color: var(--color-text);
      }
      .dm-loading-text {
        padding: var(--space-4);
        color: var(--color-text-muted);
        font-size: var(--text-sm);
      }
      .dm-list {
        display: flex;
        flex-direction: column;
      }
      .dm-list-item {
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--color-border);
        cursor: pointer;
        display: flex;
        align-items: center;
        gap: var(--space-3);
        transition: background var(--transition-fast);
      }
      .dm-list-item:hover {
        background: var(--color-surface-2);
      }
      .dm-list-avatar {
        box-shadow: 0 0 0 1px var(--color-border);
        flex-shrink: 0;
      }
      .dm-list-info {
        flex: 1;
        min-width: 0;
      }
      .dm-list-name {
        font-family: var(--font-display);
        font-size: var(--text-base);
        font-weight: var(--weight-medium);
        color: var(--color-text);
      }
      .dm-list-preview {
        font-size: var(--text-sm);
        color: var(--color-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-top: 2px;
      }
      /* Thread */
      .dm-thread {
        display: flex;
        flex-direction: column;
        height: 100%;
      }
      .dm-thread-header {
        padding: var(--space-3) var(--space-4);
        border-bottom: 1px solid var(--color-border);
        display: flex;
        align-items: center;
        gap: var(--space-3);
        background: var(--color-surface);
      }
      .dm-back-btn {
        background: none;
        border: none;
        color: var(--color-text-muted);
        font-size: var(--text-lg);
        cursor: pointer;
        padding: var(--space-1) var(--space-2);
        transition: color var(--transition-fast);
      }
      .dm-back-btn:hover {
        color: var(--color-gold);
      }
      .dm-thread-avatar {
        width: 30px;
        height: 30px;
        box-shadow: 0 0 0 1px var(--color-border-gold);
      }
      .dm-thread-name {
        font-family: var(--font-display);
        font-style: italic;
        font-size: var(--text-lg);
        color: var(--color-text);
      }
      .dm-thread-messages {
        flex: 1;
        overflow-y: auto;
        padding: var(--space-4);
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
      }
      .dm-message-wrap {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        animation: fadeIn 0.25s ease;
      }
      .dm-message-mine {
        align-items: flex-end;
      }
      .dm-bubble {
        display: inline-block;
        padding: var(--space-2) var(--space-3);
        border-radius: var(--radius-lg);
        background: var(--color-surface-2);
        border: 1px solid var(--color-border);
        color: var(--color-text);
        max-width: 78%;
        font-size: var(--text-sm);
        line-height: 1.5;
        word-break: break-word;
      }
      .dm-message-mine .dm-bubble {
        background: rgba(201,168,76,0.06);
        border-color: var(--color-border-gold);
        color: var(--color-text);
      }
      .dm-input-bar {
        padding: var(--space-3) var(--space-4);
        border-top: 1px solid var(--color-border);
        display: flex;
        gap: var(--space-2);
        align-items: center;
        background: var(--color-surface);
      }
      .dm-input {
        flex: 1;
      }
      .dm-send-btn {
        width: 38px;
        height: 38px;
        flex-shrink: 0;
        border-radius: var(--radius-full);
        background: var(--color-gold-glow);
        border: 1px solid var(--color-border-gold);
        color: var(--color-gold);
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        transition: all var(--transition-base);
      }
      .dm-send-btn svg {
        width: 16px;
        height: 16px;
      }
      .dm-send-btn:hover {
        background: var(--color-gold);
        color: #0A0A0A;
      }
      .dm-send-btn:active {
        transform: scale(0.92);
      }

      .dm-message-wrap {
        transition: transform 0.15s ease;
        touch-action: pan-y;
      }
      .dm-message-wrap.swipe-armed::after {
        content: '↩';
        position: absolute;
        left: -22px;
        top: 50%;
        transform: translateY(-50%);
        color: var(--color-gold);
        font-size: 14px;
      }
      .reply-quote {
        display: flex;
        flex-direction: column;
        gap: 1px;
        padding: 4px 8px;
        margin-bottom: 4px;
        border-left: 2px solid var(--color-border-gold);
        background: var(--color-surface-2);
        border-radius: 4px;
        opacity: 0.85;
      }
      .reply-quote-sender {
        font-size: 10px;
        color: var(--color-text-muted);
        font-weight: var(--weight-medium);
      }
      .reply-quote-text {
        font-size: 11px;
        color: var(--color-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 220px;
      }
      .reply-preview-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-2);
        padding: var(--space-2) var(--space-3);
        margin: 0 var(--space-4);
        background: var(--color-surface-2);
        border-left: 2px solid var(--color-border-gold);
        border-radius: var(--radius-md);
      }
      .reply-preview-content {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
      }
      .reply-preview-label {
        font-size: 10px;
        color: var(--color-text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .reply-preview-text {
        font-size: var(--text-sm);
        color: var(--color-text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .reply-preview-cancel {
        background: none;
        border: none;
        color: var(--color-text-muted);
        font-size: 18px;
        cursor: pointer;
        flex-shrink: 0;
      }
    `;
    document.head.appendChild(style);
  },
};
window.DmPage = DmPage;

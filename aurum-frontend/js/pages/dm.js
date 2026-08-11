const DmPage = {
  activeChannelId: null,

  async init(containerId) {
    this.container = document.getElementById(containerId);
    await this.renderList();
  },

  async renderList() {
    this.container.innerHTML = `<p style="padding:var(--space-4);color:var(--color-text-muted);">Loading conversations...</p>`;
    try {
      const { channels } = await AURUM.DmAPI.getChannels();
      if (!channels || !channels.length) {
        this.container.innerHTML = `
          <div style="padding:var(--space-4);text-align:center;color:var(--color-text-muted);">
            <p>No conversations yet.</p>
          </div>`;
        return;
      }
      this.container.innerHTML = `
        <div id="dm-list">
          ${channels.map(c => `
            <div class="dm-list-item" data-channel-id="${c.channel_id}" data-username="${this.escapeHTML(c.other_username)}" data-avatar="${this.escapeHTML(c.other_avatar_url || '')}"
              style="padding:var(--space-3);border-bottom:1px solid var(--color-border);cursor:pointer;display:flex;align-items:center;gap:var(--space-3);">
              <div class="avatar avatar-sm">${AURUM.avatarInnerHTML(c.other_avatar_url, this.escapeHTML(c.other_username).charAt(0).toUpperCase())}</div>
              <div style="flex:1;min-width:0;">
                <p style="font-weight:600;">${this.escapeHTML(c.other_username)}</p>
                <p style="font-size:var(--text-sm);color:var(--color-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                  ${c.last_message ? this.escapeHTML(c.last_message) : 'No messages yet'}
                </p>
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
      this.container.innerHTML = `<p style="padding:var(--space-4);color:var(--color-danger);">Failed to load conversations.</p>`;
    }
  },

  async openThread(channelId, username, avatarUrl) {
    this.activeChannelId = channelId;
    this.activeUsername = username;
    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;">
        <div style="padding:var(--space-3);border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:var(--space-2);">
          <button class="btn btn-ghost btn-sm" id="dm-back-btn">&larr; Back</button>
          <div class="avatar avatar-sm" style="width:28px;height:28px;">${AURUM.avatarInnerHTML(avatarUrl, this.escapeHTML(username).charAt(0).toUpperCase())}</div>
          <p style="font-weight:600;">${this.escapeHTML(username)}</p>
        </div>
				<div id="dm-thread-messages" style="flex:1;overflow-y:auto;padding:var(--space-3);">
          <p style="color:var(--color-text-muted);">Loading messages...</p>
        </div>
        <div style="padding:var(--space-3);border-top:1px solid var(--color-border);display:flex;gap:var(--space-2);">
          <input class="input" id="dm-message-input" placeholder="Message..." style="flex:1;" />
          <button class="btn btn-primary btn-sm" id="dm-send-btn">Send</button>
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
        this.appendMessage(msg);
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
    const bubble = document.createElement('div');
    bubble.className = 'dm-message-wrap';
    bubble.dataset.messageId = msg.id;
    bubble.style.marginBottom = 'var(--space-2)';
    bubble.style.textAlign = isMine ? 'right' : 'left';
    bubble.innerHTML = `
      <p style="display:inline-block;padding:var(--space-2);border-radius:8px;
        background:${isMine ? 'var(--color-gold, #b8964f)' : 'var(--color-surface)'};
        color:${isMine ? '#000' : 'inherit'};max-width:80%;">
        ${this.escapeHTML(msg.content)}
      </p>
      ${this.reactionBarHTML(msg.id, {})}`;
    list.appendChild(bubble);
    list.scrollTop = list.scrollHeight;
  },
  reactionBarHTML(messageId, reactions) {
    const pills = Object.entries(reactions).map(([emoji, data]) => `
      <button class="reaction-pill${data.reacted_by_me ? ' reaction-pill-active' : ''}" data-message-id="${messageId}" data-emoji="${emoji}" style="font-size:11px;padding:1px 6px;border-radius:10px;border:1px solid var(--color-border);background:${data.reacted_by_me ? 'var(--color-primary-muted, #333)' : 'transparent'};cursor:pointer;margin-right:2px;">
        ${emoji} ${data.count}
      </button>
    `).join('');
    return `
      <div class="reaction-bar" style="margin-top:2px;">
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
        <div class="dm-message-wrap" data-message-id="${m.id}" style="margin-bottom:var(--space-2);text-align:${m.sender_id === me?.id ? 'right' : 'left'};">
          <p style="display:inline-block;padding:var(--space-2);border-radius:8px;
            background:${m.sender_id === me?.id ? 'var(--color-gold, #b8964f)' : 'var(--color-surface)'};
            color:${m.sender_id === me?.id ? '#000' : 'inherit'};max-width:80%;">
            ${m.deleted ? '<em>message deleted</em>' : this.escapeHTML(m.content)}
          </p>
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
    input.value = '';
    try {
      await AURUM.DmAPI.sendMessage(this.activeChannelId, content);
    } catch (err) {
      AURUM.showToast(err.message || 'Could not send message.', 'error');
    }
  },

  escapeHTML(str) {
    const div = document.createElement('div');
    div.textContent = str ?? '';
    return div.innerHTML;
  },
};
window.DmPage = DmPage;

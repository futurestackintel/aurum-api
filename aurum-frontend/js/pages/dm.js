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
            <div class="dm-list-item" data-channel-id="${c.channel_id}" data-username="${this.escapeHTML(c.other_username)}"
              style="padding:var(--space-3);border-bottom:1px solid var(--color-border);cursor:pointer;">
              <p style="font-weight:600;">${this.escapeHTML(c.other_username)}</p>
              <p style="font-size:var(--text-sm);color:var(--color-text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
                ${c.last_message ? this.escapeHTML(c.last_message) : 'No messages yet'}
              </p>
            </div>
          `).join('')}
        </div>`;
      document.querySelectorAll('.dm-list-item').forEach(item => {
        item.addEventListener('click', () => {
          this.openThread(item.dataset.channelId, item.dataset.username);
        });
      });
    } catch (err) {
      this.container.innerHTML = `<p style="padding:var(--space-4);color:var(--color-danger);">Failed to load conversations.</p>`;
    }
  },

  async openThread(channelId, username) {
    this.activeChannelId = channelId;
    this.container.innerHTML = `
      <div style="display:flex;flex-direction:column;height:100%;">
        <div style="padding:var(--space-3);border-bottom:1px solid var(--color-border);display:flex;align-items:center;gap:var(--space-2);">
          <button class="btn btn-ghost btn-sm" id="dm-back-btn">← Back</button>
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
    document.getElementById('dm-back-btn').addEventListener('click', () => this.renderList());
    document.getElementById('dm-send-btn').addEventListener('click', () => this.sendMessage());
    document.getElementById('dm-message-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.sendMessage();
    });
    await this.loadMessages();
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
      list.innerHTML = messages.slice().reverse().map(m => `
        <div style="margin-bottom:var(--space-2);text-align:${m.sender_id === me?.id ? 'right' : 'left'};">
          <p style="display:inline-block;padding:var(--space-2);border-radius:8px;
            background:${m.sender_id === me?.id ? 'var(--color-gold, #b8964f)' : 'var(--color-surface)'};
            color:${m.sender_id === me?.id ? '#000' : 'inherit'};max-width:80%;">
            ${m.deleted ? '<em>message deleted</em>' : this.escapeHTML(m.content)}
          </p>
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
      await this.loadMessages();
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

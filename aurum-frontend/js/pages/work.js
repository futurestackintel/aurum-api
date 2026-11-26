
/* ============================================================
   AURUM WORK — Marketplace
   Discovery, publishing, applications and hiring.
   Financial settlement is intentionally not implemented here.
============================================================ */

window.WorkPage = {
  container: null,
  initialized: false,
  opportunities: [],
  activeOpportunity: null,
  loading: false,

  escape(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[char]);
  },

  money(minor, currency) {
    if (minor == null) return 'Negotiable';
    return `${this.escape(currency)} ${(Number(minor) / 100).toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  },

  async init(containerId) {
    this.container = document.getElementById(containerId);
    if (!this.container) return;

    if (!this.initialized) {
      this.render();
      this.bindEvents();
      this.initialized = true;
    }

    await this.loadOpportunities();
  },

  render() {
    this.container.innerHTML = `
      <div class="work-wrap">
        <header class="work-header">
          <div>
            <p class="section-eyebrow">AURUM PROFESSIONAL NETWORK</p>
            <h2>Work</h2>
            <p>Discover opportunities. Build your reputation. Deliver meaningful work.</p>
          </div>
          <button class="btn btn-primary" id="work-create-open">+ Post Work</button>
        </header>

        <div class="work-tabs">
          <button class="work-tab active" data-work-tab="discover">Discover</button>
          <button class="work-tab" data-work-tab="manage">My Opportunities</button>
        </div>

        <section id="work-discover-panel">
          <div class="work-filters">
            <input class="input" id="work-search" maxlength="100"
              placeholder="Search opportunities..." />
            <select class="input" id="work-pricing-filter">
              <option value="">All pricing</option>
              <option value="fixed">Fixed price</option>
              <option value="hourly">Hourly</option>
            </select>
            <select class="input" id="work-eligibility-filter">
              <option value="">All applicants</option>
              <option value="individuals">Individuals</option>
              <option value="crews">Crews</option>
            </select>
            <button class="btn btn-outline" id="work-search-button">Search</button>
          </div>
          <div id="work-opportunity-list" class="work-grid">
            <p class="work-empty">Loading opportunities...</p>
          </div>
        </section>

        <section id="work-manage-panel" hidden>
          <div class="work-panel-heading">
            <h3>Your published opportunities</h3>
            <p>Review applications and manage your hiring process.</p>
          </div>
          <div id="work-owned-list" class="work-grid">
            <p class="work-empty">Your opportunities will appear here.</p>
          </div>
        </section>

        <section id="work-detail-panel" hidden>
          <button class="btn btn-ghost btn-sm" id="work-back-button">← Back to opportunities</button>
          <div id="work-detail-content"></div>
        </section>

        <div class="work-modal" id="work-create-modal" hidden>
          <div class="work-modal-card">
            <div class="work-modal-heading">
              <div>
                <p class="section-eyebrow">CLIENT WORKSPACE</p>
                <h3>Publish an opportunity</h3>
              </div>
              <button class="work-close" data-work-close="work-create-modal" aria-label="Close">×</button>
            </div>

            <form id="work-create-form">
              <label class="input-group">
                <span class="input-label">Opportunity title</span>
                <input class="input" name="title" minlength="5" maxlength="160" required
                  placeholder="What do you need done?" />
              </label>

              <label class="input-group">
                <span class="input-label">Description</span>
                <textarea class="input" name="description" minlength="20" maxlength="12000"
                  rows="5" required placeholder="Describe the work, expectations and deliverables."></textarea>
              </label>

              <div class="work-form-grid">
                <label class="input-group">
                  <span class="input-label">Category</span>
                  <input class="input" name="category" maxlength="80" placeholder="e.g. Design" />
                </label>
                <label class="input-group">
                  <span class="input-label">Currency (ISO code)</span>
                  <input class="input" name="currency" maxlength="3" minlength="3"
                    value="NGN" required />
                </label>
              </div>

              <label class="input-group">
                <span class="input-label">Applicant eligibility</span>
                <select class="input" name="applicant_eligibility">
                  <option value="individuals">Individuals</option>
                  <option value="crews">Crews</option>
                  <option value="both">Individuals and Crews</option>
                </select>
              </label>

              <label class="input-group">
                <span class="input-label">Pricing model</span>
                <select class="input" name="pricing_model" id="work-pricing-model">
                  <option value="fixed">Fixed price</option>
                  <option value="hourly">Hourly</option>
                </select>
              </label>

              <div id="work-fixed-fields">
                <label class="input-group">
                  <span class="input-label">Total fixed budget (major currency units)</span>
                  <input class="input" name="fixed_budget" type="number" min="0.01"
                    step="0.01" required />
                </label>
              </div>

              <div id="work-hourly-fields" hidden>
                <label class="input-group">
                  <span class="input-label">Hourly rate (major currency units)</span>
                  <input class="input" name="hourly_rate" type="number" min="0.01" step="0.01" />
                </label>
                <label class="input-group">
                  <span class="input-label">Maximum spending limit (major currency units)</span>
                  <input class="input" name="spending_limit" type="number" min="0.01" step="0.01" />
                </label>
              </div>

              <label class="work-check">
                <input type="checkbox" name="multi_hire_enabled" id="work-multi-hire" />
                Allow multiple hires
              </label>

              <label class="input-group" id="work-capacity-field" hidden>
                <span class="input-label">Maximum number of hires</span>
                <input class="input" name="hire_capacity" type="number" min="2" max="100" value="2" />
              </label>

              <p class="work-notice">
                Publishing an opportunity does not reserve funds or create escrow.
                Payment arrangements are handled separately under AURUM's approved financial architecture.
              </p>

              <p class="work-message" id="work-create-message" role="status"></p>

              <div class="work-form-actions">
                <button type="button" class="btn btn-ghost" data-work-close="work-create-modal">Cancel</button>
                <button type="submit" class="btn btn-primary">Create and publish</button>
              </div>
            </form>
          </div>
        </div>

        <div class="work-modal" id="work-apply-modal" hidden>
          <div class="work-modal-card">
            <div class="work-modal-heading">
              <div>
                <p class="section-eyebrow">APPLICATION</p>
                <h3>Apply for this opportunity</h3>
              </div>
              <button class="work-close" data-work-close="work-apply-modal" aria-label="Close">×</button>
            </div>
            <form id="work-apply-form">
              <label class="input-group">
                <span class="input-label">Why are you suitable for this work?</span>
                <textarea class="input" name="cover_message" minlength="10" maxlength="5000"
                  rows="5" required></textarea>
              </label>
              <label class="input-group" id="work-proposed-price-field">
                <span class="input-label" id="work-proposed-price-label">Your proposed amount (major units)</span>
                <input class="input" name="proposed_price" type="number" min="0.01" step="0.01" />
              </label>
              <p class="work-message" id="work-apply-message" role="status"></p>
              <div class="work-form-actions">
                <button type="button" class="btn btn-ghost" data-work-close="work-apply-modal">Cancel</button>
                <button type="submit" class="btn btn-primary">Submit application</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    `;

    this.updatePricingFields();
  },

  bindEvents() {
    this.container.addEventListener('click', event => {
      const tab = event.target.closest('[data-work-tab]');
      if (tab) return this.switchTab(tab.dataset.workTab);

      const close = event.target.closest('[data-work-close]');
      if (close) {
        this.modal(close.dataset.workClose, false);
        return;
      }

      const detail = event.target.closest('[data-work-detail]');
      if (detail) return this.openOpportunity(detail.dataset.workDetail);

      const apply = event.target.closest('[data-work-apply]');
      if (apply) return this.openApply(apply.dataset.workApply);

      const applications = event.target.closest('[data-work-applications]');
      if (applications) return this.showApplications(applications.dataset.workApplications);

      const action = event.target.closest('[data-work-action]');
      if (action) return this.handleApplicationAction(action);

      if (event.target.id === 'work-create-open') {
        this.modal('work-create-modal', true);
      }

      if (event.target.id === 'work-search-button') {
        this.loadOpportunities();
      }

      if (event.target.id === 'work-back-button') {
        this.showPanel('discover');
      }
    });

    this.container.addEventListener('change', event => {
      if (event.target.id === 'work-pricing-model') this.updatePricingFields();

      if (event.target.id === 'work-multi-hire') {
        this.container.querySelector('#work-capacity-field').hidden = !event.target.checked;
      }
    });

    this.container.querySelector('#work-create-form').addEventListener('submit', event => {
      event.preventDefault();
      this.createOpportunity(event.currentTarget);
    });

    this.container.querySelector('#work-apply-form').addEventListener('submit', event => {
      event.preventDefault();
      this.submitApplication(event.currentTarget);
    });

    this.container.querySelector('#work-search').addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        event.preventDefault();
        this.loadOpportunities();
      }
    });
  },

  modal(id, open) {
    const element = this.container.querySelector(`#${id}`);
    if (element) element.hidden = !open;
  },

  switchTab(tab) {
    this.container.querySelectorAll('[data-work-tab]').forEach(button => {
      button.classList.toggle('active', button.dataset.workTab === tab);
    });
    this.showPanel(tab);

    if (tab === 'manage') this.loadOwnedOpportunities();
    if (tab === 'discover') this.loadOpportunities();
  },

  showPanel(panel) {
    this.container.querySelector('#work-discover-panel').hidden = panel !== 'discover';
    this.container.querySelector('#work-manage-panel').hidden = panel !== 'manage';
    this.container.querySelector('#work-detail-panel').hidden = panel !== 'detail';
  },

  updatePricingFields() {
    const hourly = this.container.querySelector('#work-pricing-model').value === 'hourly';
    this.container.querySelector('#work-fixed-fields').hidden = hourly;
    this.container.querySelector('#work-hourly-fields').hidden = !hourly;

    this.container.querySelector('[name="fixed_budget"]').required = !hourly;
    this.container.querySelector('[name="hourly_rate"]').required = hourly;
    this.container.querySelector('[name="spending_limit"]').required = hourly;
  },

  async loadOpportunities() {
    const list = this.container.querySelector('#work-opportunity-list');
    list.innerHTML = '<p class="work-empty">Loading opportunities...</p>';

    try {
      const result = await AURUM.WorkAPI.listOpportunities({
        search: this.container.querySelector('#work-search').value.trim(),
        pricing_model: this.container.querySelector('#work-pricing-filter').value,
        eligibility: this.container.querySelector('#work-eligibility-filter').value,
      });

      this.opportunities = result.opportunities || [];
      this.renderOpportunityList(list, this.opportunities);
    } catch (error) {
      list.innerHTML = `<p class="work-empty">${this.escape(error.message)}</p>`;
    }
  },

  renderOpportunityList(container, opportunities) {
    if (!opportunities.length) {
      container.innerHTML = '<p class="work-empty">No opportunities found. Check back soon or broaden your search.</p>';
      return;
    }

    container.innerHTML = opportunities.map(item => `
      <article class="work-card">
        <div class="work-card-top">
          <span class="work-tag">${this.escape(item.pricing_model)}</span>
          <span class="work-tag">${this.escape(item.applicant_eligibility)}</span>
        </div>
        <h3>${this.escape(item.title)}</h3>
        <p class="work-card-description">${this.escape(item.description.slice(0, 220))}${item.description.length > 220 ? '…' : ''}</p>
        <div class="work-card-meta">
          <strong>${this.money(
            item.pricing_model === 'fixed' ? item.fixed_budget_minor : item.hourly_rate_minor,
            item.currency
          )}${item.pricing_model === 'hourly' ? ' / hour' : ''}</strong>
          <span>${this.escape(item.client_display_name || item.client_username || 'AURUM member')}</span>
        </div>
        <div class="work-card-footer">
          <span>${item.multi_hire_enabled ? `Up to ${Number(item.hire_capacity)} hires` : 'Single hire'}</span>
          <button class="btn btn-outline btn-sm" data-work-detail="${this.escape(item.id)}">View opportunity</button>
        </div>
      </article>
    `).join('');
  },

  async openOpportunity(id) {
    this.activeOpportunity = id;
    this.showPanel('detail');
    const target = this.container.querySelector('#work-detail-content');
    target.innerHTML = '<p class="work-empty">Loading opportunity...</p>';

    try {
      const result = await AURUM.WorkAPI.getOpportunity(id);
      const item = result.opportunity;
      if (!item) throw new Error('Opportunity not found');

      const own = item.client_user_id === window.App?.user?.id;

      target.innerHTML = `
        <article class="work-detail-card">
          <div class="work-card-top">
            <span class="work-tag">${this.escape(item.status)}</span>
            <span class="work-tag">${this.escape(item.pricing_model)}</span>
          </div>
          <h2>${this.escape(item.title)}</h2>
          <p>${this.escape(item.description)}</p>
          <div class="work-detail-facts">
            <div><span>Budget / rate</span><strong>${this.money(
              item.pricing_model === 'fixed' ? item.fixed_budget_minor : item.hourly_rate_minor,
              item.currency
            )}${item.pricing_model === 'hourly' ? ' / hour' : ''}</strong></div>
            <div><span>Eligibility</span><strong>${this.escape(item.applicant_eligibility)}</strong></div>
            <div><span>Applications</span><strong>${Number(item.application_count || 0)}</strong></div>
            <div><span>Hiring capacity</span><strong>${item.multi_hire_enabled ? Number(item.hire_capacity) : 1}</strong></div>
          </div>
          <p class="work-client">Posted by ${this.escape(item.client_display_name || item.client_username || 'AURUM member')}</p>
          <div class="work-form-actions">
            ${own
              ? `<button class="btn btn-primary" data-work-applications="${this.escape(item.id)}">Review applications</button>`
              : `<button class="btn btn-primary" data-work-apply="${this.escape(item.id)}">Apply now</button>`}
          </div>
        </article>
      `;
    } catch (error) {
      target.innerHTML = `<p class="work-empty">${this.escape(error.message)}</p>`;
    }
  },

  openApply(id) {
    this.activeOpportunity = id;
    const item = this.opportunities.find(opportunity => opportunity.id === id);

    if (item) {
      const priceField = this.container.querySelector('#work-proposed-price-field');
      const priceInput = this.container.querySelector('[name="proposed_price"]');
      priceField.hidden = false;
      priceInput.required = false;

      this.container.querySelector('#work-proposed-price-label').textContent =
        item.pricing_model === 'fixed'
          ? 'Your proposed total (major currency units)'
          : 'Your proposed hourly rate (major currency units)';
    }

    this.modal('work-apply-modal', true);
  },

  async submitApplication(form) {
    const item = this.opportunities.find(opportunity => opportunity.id === this.activeOpportunity);
    const message = this.container.querySelector('#work-apply-message');
    const data = new FormData(form);

    if (!item) {
      message.textContent = 'Please reopen the opportunity and try again.';
      return;
    }

    const payload = { cover_message: data.get('cover_message').trim() };
    const price = Number(data.get('proposed_price'));

    if (price > 0) {
      if (item.pricing_model === 'fixed') {
        payload.proposed_fixed_amount_minor = Math.round(price * 100);
      } else {
        payload.proposed_hourly_rate_minor = Math.round(price * 100);
      }
    }

    message.textContent = 'Submitting application...';

    try {
      await AURUM.WorkAPI.apply(this.activeOpportunity, payload);
      message.textContent = 'Application submitted successfully.';
      form.reset();
      setTimeout(() => this.modal('work-apply-modal', false), 900);
    } catch (error) {
      message.textContent = error.message;
    }
  },

  async createOpportunity(form) {
    const message = this.container.querySelector('#work-create-message');
    const data = new FormData(form);
    const hourly = data.get('pricing_model') === 'hourly';
    const multiHire = data.get('multi_hire_enabled') === 'on';

    const toMinor = value => Math.round(Number(value) * 100);

    const payload = {
      title: data.get('title').trim(),
      description: data.get('description').trim(),
      category: data.get('category').trim() || null,
      currency: data.get('currency').trim().toUpperCase(),
      applicant_eligibility: data.get('applicant_eligibility'),
      pricing_model: hourly ? 'hourly' : 'fixed',
      multi_hire_enabled: multiHire,
      hire_capacity: multiHire ? Number(data.get('hire_capacity')) : 1,
    };

    if (hourly) {
      payload.hourly_rate_minor = toMinor(data.get('hourly_rate'));
      payload.spending_limit_minor = toMinor(data.get('spending_limit'));
    } else {
      payload.fixed_budget_minor = toMinor(data.get('fixed_budget'));
    }

    message.textContent = 'Creating and publishing opportunity...';

    try {
      const result = await AURUM.WorkAPI.createOpportunity(payload);
      const opportunityId = result.opportunity?.id;

      if (!opportunityId) throw new Error('Opportunity was created but its ID was not returned.');

      await AURUM.WorkAPI.publishOpportunity(opportunityId);

      message.textContent = 'Your opportunity is now published.';
      form.reset();
      this.updatePricingFields();
      this.modal('work-create-modal', false);
      await this.loadOpportunities();
    } catch (error) {
      message.textContent = error.message;
    }
  },

  async loadOwnedOpportunities() {
    const list = this.container.querySelector('#work-owned-list');
    list.innerHTML = '<p class="work-empty">Loading your opportunities...</p>';

    try {
      const result = await AURUM.WorkAPI.listOpportunities({ limit: 50 });
      const owned = (result.opportunities || []).filter(
        item => item.client_user_id === window.App?.user?.id
      );

      if (!owned.length) {
        list.innerHTML = '<p class="work-empty">You have no open opportunities yet. Create one to get started.</p>';
        return;
      }

      list.innerHTML = owned.map(item => `
        <article class="work-card">
          <span class="work-tag">${this.escape(item.status)}</span>
          <h3>${this.escape(item.title)}</h3>
          <p>${this.escape(item.description.slice(0, 160))}</p>
          <div class="work-card-footer">
            <span>${Number(item.multi_hire_enabled ? item.hire_capacity : 1)} hire capacity</span>
            <button class="btn btn-outline btn-sm" data-work-applications="${this.escape(item.id)}">Applications</button>
          </div>
        </article>
      `).join('');
    } catch (error) {
      list.innerHTML = `<p class="work-empty">${this.escape(error.message)}</p>`;
    }
  },

  async showApplications(opportunityId) {
    this.showPanel('detail');
    const target = this.container.querySelector('#work-detail-content');
    target.innerHTML = '<p class="work-empty">Loading applications...</p>';

    try {
      const result = await AURUM.WorkAPI.listApplications(opportunityId);
      const applications = result.applications || [];

      target.innerHTML = `
        <div class="work-panel-heading">
          <p class="section-eyebrow">CLIENT WORKSPACE</p>
          <h2>Applications</h2>
          <p>Review applicants and make hiring decisions.</p>
        </div>
        <div class="work-application-list">
          ${applications.length ? applications.map(application => `
            <article class="work-card">
              <div class="work-card-top">
                <span class="work-tag">${this.escape(application.applicant_type)}</span>
                <span class="work-tag">${this.escape(application.status)}</span>
              </div>
              <h3>${this.escape(application.applicant_display_name || application.applicant_username || application.submitted_by_display_name || 'Crew applicant')}</h3>
              <p>${this.escape(application.cover_message)}</p>
              <p class="work-client">Submitted by ${this.escape(application.submitted_by_display_name || application.submitted_by_username || 'AURUM member')}</p>
              ${application.proposed_fixed_amount_minor
                ? `<strong>Proposed: ${this.money(application.proposed_fixed_amount_minor, '')}</strong>`
                : ''}
              ${application.proposed_hourly_rate_minor
                ? `<strong>Proposed hourly rate: ${this.money(application.proposed_hourly_rate_minor, '')}</strong>`
                : ''}
              <div class="work-action-row">
                ${application.status === 'submitted'
                  ? `<button class="btn btn-ghost btn-sm" data-work-action="under_review" data-application="${this.escape(application.id)}">Review</button>
                     <button class="btn btn-outline btn-sm" data-work-action="shortlisted" data-application="${this.escape(application.id)}">Shortlist</button>`
                  : ''}
                ${['submitted', 'under_review', 'shortlisted'].includes(application.status)
                  ? `<button class="btn btn-primary btn-sm" data-work-action="hire" data-application="${this.escape(application.id)}">Hire</button>
                     <button class="btn btn-danger btn-sm" data-work-action="rejected" data-application="${this.escape(application.id)}">Reject</button>`
                  : ''}
              </div>
            </article>
          `).join('') : '<p class="work-empty">No applications received yet.</p>'}
        </div>
      `;
    } catch (error) {
      target.innerHTML = `<p class="work-empty">${this.escape(error.message)}</p>`;
    }
  },

  async handleApplicationAction(button) {
    const action = button.dataset.workAction;
    const id = button.dataset.application;

    button.disabled = true;

    try {
      if (action === 'hire') {
        const amount = prompt('Enter the agreed amount in major currency units. Leave blank to use the application/opportunity amount.');
        const opportunity = await AURUM.WorkAPI.getOpportunity(this.activeOpportunity);
        const item = opportunity.opportunity;
        const payload = {};

        if (amount !== null && amount.trim() !== '') {
          const minor = Math.round(Number(amount) * 100);
          if (!Number.isSafeInteger(minor) || minor <= 0) {
            throw new Error('Enter a valid positive amount.');
          }

          if (item.pricing_model === 'fixed') payload.agreed_fixed_amount_minor = minor;
          else payload.agreed_hourly_rate_minor = minor;
        }

        if (!confirm('Create this engagement? This does not transfer or hold funds.')) return;

        const result = await AURUM.WorkAPI.hire(id, payload);
        alert(`Engagement created: ${result.engagement_id || 'success'}`);
      } else {
        await AURUM.WorkAPI.updateApplication(id, action);
      }

      await this.showApplications(this.activeOpportunity);
    } catch (error) {
      alert(error.message);
      button.disabled = false;
    }
  },
};


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

    currencyDecimals(currency) {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
      }).resolvedOptions().maximumFractionDigits;
    } catch {
      return 2;
    }
  },

  money(minor, currency) {
    if (minor == null) return 'Negotiable';

    const code = String(currency || '').toUpperCase();
    const decimals = this.currencyDecimals(code || 'USD');
    const amount = Number(minor) / (10 ** decimals);

    if (!code) {
      return amount.toLocaleString(undefined, {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
    }

    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code,
    }).format(amount);
  },

  toMinorUnits(value, currency) {
    const amount = Number(value);
    const decimals = this.currencyDecimals(String(currency || 'USD').toUpperCase());

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('Enter a valid positive amount.');
    }

    const minor = Math.round(amount * (10 ** decimals));

    if (!Number.isSafeInteger(minor) || minor <= 0) {
      throw new Error('Amount is outside the supported range.');
    }

    return minor;
  },

  fromMinorUnits(value, currency) {
    const decimals = this.currencyDecimals(String(currency || 'USD').toUpperCase());
    return Number(value) / (10 ** decimals);
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

        <section class="work-hero">
          <div class="work-hero-copy">
            <div class="work-kicker">
              <span class="work-kicker-line"></span>
              AURUM / PROFESSIONAL NETWORK
            </div>

            <h1>Make your next move <em>count.</em></h1>

            <p class="work-hero-description">
              Find meaningful opportunities, work with exceptional people,
              and turn what you do best into something greater.
            </p>

            <div class="work-hero-actions">
              <button class="work-primary-action" id="work-explore-button" type="button">
                Explore opportunities
                <span aria-hidden="true">↗</span>
              </button>
              <button class="work-secondary-action" id="work-create-open" type="button">
                Post an opportunity
                <span aria-hidden="true">＋</span>
              </button>
            </div>

            <div class="work-hero-footnote">
              <span class="work-live-dot"></span>
              A marketplace for individuals and Crews
            </div>
          </div>

          <div class="work-hero-art" aria-hidden="true">
            <div class="work-orbit work-orbit-one"></div>
            <div class="work-orbit work-orbit-two"></div>
            <div class="work-art-core">
              <span class="work-art-monogram">W</span>
              <span class="work-art-caption">WORK / CREATE / GROW</span>
            </div>
            <span class="work-art-star work-star-one">✦</span>
            <span class="work-art-star work-star-two">✧</span>
            <span class="work-art-coordinate">AURUM<br>01 — 04</span>
          </div>
        </section>

        <section class="work-principles" aria-label="Marketplace features">
          <div class="work-principle">
            <span class="work-principle-number">01</span>
            <div>
              <strong>Discover</strong>
              <span>Find work that fits your strengths</span>
            </div>
          </div>
          <div class="work-principle">
            <span class="work-principle-number">02</span>
            <div>
              <strong>Collaborate</strong>
              <span>Apply as an individual or a Crew</span>
            </div>
          </div>
          <div class="work-principle">
            <span class="work-principle-number">03</span>
            <div>
              <strong>Deliver</strong>
              <span>Build a record of meaningful work</span>
            </div>
          </div>
        </section>

        <section class="work-marketplace" id="work-discover-panel">
          <div class="work-section-heading">
            <div>
              <div class="work-kicker">
                <span class="work-kicker-line"></span>
                THE MARKETPLACE
              </div>
              <h2>Find your <em>opportunity.</em></h2>
              <p>Explore projects from across the AURUM community.</p>
            </div>
            <button class="work-manage-link" data-work-tab="manage" type="button">
              My opportunities <span>↗</span>
            </button>
          </div>

          <div class="work-search-panel">
            <div class="work-search-field">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7"></circle>
                <path d="m20 20-4-4"></path>
              </svg>
              <input
                id="work-search"
                type="search"
                maxlength="100"
                placeholder="What kind of work are you looking for?"
                aria-label="Search opportunities"
              />
            </div>

            <div class="work-filter-field">
              <label for="work-pricing-filter">Pricing</label>
              <select id="work-pricing-filter">
                <option value="">All types</option>
                <option value="fixed">Fixed price</option>
                <option value="hourly">Hourly</option>
              </select>
            </div>

            <div class="work-filter-field">
              <label for="work-eligibility-filter">Open to</label>
              <select id="work-eligibility-filter">
                <option value="">Everyone</option>
                <option value="individuals">Individuals</option>
                <option value="crews">Crews</option>
              </select>
            </div>

            <button class="work-search-button" id="work-search-button" type="button">
              Search
            </button>
          </div>

          <div class="work-results-heading">
            <div>
              <span class="work-results-label">LATEST OPPORTUNITIES</span>
              <span class="work-results-count" id="work-result-count">Loading listings</span>
            </div>
            <span class="work-results-note">Recently published</span>
          </div>

          <div id="work-opportunity-list" class="work-grid">
            <div class="work-loading-card">
              <span class="work-loading-mark"></span>
              <p>Finding opportunities for you...</p>
            </div>
          </div>
        </section>

        <section id="work-manage-panel" class="work-manage-panel" hidden>
          <div class="work-section-heading">
            <div>
              <div class="work-kicker">
                <span class="work-kicker-line"></span>
                CLIENT WORKSPACE
              </div>
              <h2>Your <em>opportunities.</em></h2>
              <p>Keep track of your published listings and applicants.</p>
            </div>
            <button class="work-primary-action" id="work-create-open-manage" type="button">
              Post an opportunity <span>＋</span>
            </button>
          </div>

          <div id="work-owned-list" class="work-grid">
            <div class="work-loading-card">
              <span class="work-loading-mark"></span>
              <p>Loading your opportunities...</p>
            </div>
          </div>
        </section>

        <section id="work-detail-panel" class="work-detail-panel" hidden>
          <button class="work-back-link" id="work-back-button" type="button">
            <span>←</span> Back to opportunities
          </button>
          <div id="work-detail-content"></div>
        </section>

        <!-- Create opportunity modal -->
        <div class="work-modal" id="work-create-modal" hidden>
          <div class="work-modal-card">
            <div class="work-modal-heading">
              <div>
                <p class="work-modal-eyebrow">CLIENT WORKSPACE</p>
                <h3>Create an opportunity</h3>
                <p>Tell the community what you need help with.</p>
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

        <!-- Application modal -->
        <div class="work-modal" id="work-apply-modal" hidden>
          <div class="work-modal-card">
            <div class="work-modal-heading">
              <div>
                <p class="work-modal-eyebrow">YOUR APPLICATION</p>
                <h3>Make your case.</h3>
                <p>Show the client why you're right for this opportunity.</p>
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
	 if (event.target.closest('#work-explore-button')) {
        this.container.querySelector('#work-search')?.focus();
        this.container.querySelector('#work-discover-panel')?.scrollIntoView({
          behavior: 'smooth',
          block: 'start',
        });
        return;
      }

      if (event.target.closest('#work-create-open-manage')) {
        this.modal('work-create-modal', true);
        return;
      }
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

      const withdraw = event.target.closest('[data-work-withdraw]');
      if (withdraw) return this.withdrawApplication(withdraw);

      const engagement = event.target.closest('[data-work-engagement]');
      if (engagement) return this.openEngagement(engagement.dataset.workEngagement);

	  const workspaceAction = event.target.closest('[data-ws-action]');
      if (workspaceAction) return this.handleWorkspaceAction(workspaceAction);
		
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

  this.container.addEventListener('submit', event => {
      const form = event.target.closest('[data-ws-form]');
      if (!form) return;
      event.preventDefault();
      this.handleWorkspaceForm(form);
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
    const count = this.container.querySelector('#work-result-count');

    if (count) {
      count.textContent = `${opportunities.length} ${
        opportunities.length === 1 ? 'opportunity' : 'opportunities'
      }`;
    }

    if (!opportunities.length) {
      container.innerHTML = `
        <div class="work-empty-state">
          <span class="work-empty-icon">✧</span>
          <h3>Nothing here. Yet.</h3>
          <p>There are no matching opportunities right now. Try another search or check back soon.</p>
        </div>
      `;
      return;
    }

    container.innerHTML = opportunities.map((item, index) => {
      const description = String(item.description || '');
      const pricing = item.pricing_model === 'fixed'
        ? this.money(item.fixed_budget_minor, item.currency)
        : `${this.money(item.hourly_rate_minor, item.currency)} <small>/ hour</small>`;

      const applicantType = item.applicant_eligibility === 'both'
        ? 'Individuals + Crews'
        : item.applicant_eligibility === 'crews'
          ? 'Crews'
          : 'Individuals';

      return `
        <article class="work-opportunity-card" style="--work-card-index:${index};">
          <div class="work-card-topline">
            <span class="work-card-category">
              ${this.escape(item.category || 'Opportunity')}
            </span>
            <span class="work-card-pricing">
              ${item.pricing_model === 'hourly' ? 'HOURLY' : 'FIXED PRICE'}
            </span>
          </div>

          <h3>${this.escape(item.title)}</h3>

          <p class="work-card-description">
            ${this.escape(description.length > 190
              ? `${description.slice(0, 190).trim()}…`
              : description)}
          </p>

          <div class="work-card-divider"></div>

          <div class="work-card-budget">
            <span>OFFERED BUDGET</span>
            <strong>${pricing}</strong>
          </div>

          <div class="work-card-details">
            <span>
              <i class="work-detail-dot"></i>
              ${this.escape(applicantType)}
            </span>
            <span>
              ${item.multi_hire_enabled
                ? `Up to ${Number(item.hire_capacity)} hires`
                : 'Single hire'}
            </span>
          </div>

          <div class="work-card-footer">
            <div class="work-client-identity">
              <span class="work-client-avatar">
                ${item.client_avatar_url
                  ? `<img src="${this.escape(item.client_avatar_url)}" alt="" />`
                  : this.escape(
                      (item.client_display_name || item.client_username || 'A')
                        .trim().charAt(0).toUpperCase()
                    )}
              </span>
              <span>
                <small>POSTED BY</small>
                <strong>${this.escape(
                  item.client_display_name || item.client_username || 'AURUM member'
                )}</strong>
              </span>
            </div>

            <button
              class="work-card-open"
              type="button"
              data-work-detail="${this.escape(item.id)}"
              aria-label="View ${this.escape(item.title)}"
            >
              View <span>↗</span>
            </button>
          </div>
        </article>
      `;
    }).join('');
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
        payload.proposed_fixed_amount_minor = this.toMinorUnits(price, item.currency);
      } else {
        payload.proposed_hourly_rate_minor = this.toMinorUnits(price, item.currency);
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

    const currency = String(data.get('currency') || '').trim().toUpperCase();
	const toMinor = value => this.toMinorUnits(value, currency);

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
    list.innerHTML = '<p class="work-empty">Loading your Work dashboard...</p>';

    try {
      const result = await AURUM.WorkAPI.getMyWork();

      const opportunities = result.opportunities || [];
      const applications = result.applications || [];
      const engagements = result.engagements || [];

      const section = (title, description, content) => `
        <section class="work-dashboard-section">
          <div class="work-panel-heading">
            <p class="section-eyebrow">YOUR WORKSPACE</p>
            <h3>${title}</h3>
            <p>${description}</p>
          </div>
          <div class="work-application-list">
            ${content || '<p class="work-empty">Nothing here yet.</p>'}
          </div>
        </section>
      `;

      const opportunityCards = opportunities.map(item => `
        <article class="work-card">
          <div class="work-card-top">
            <span class="work-tag">${this.escape(item.status)}</span>
            <span class="work-tag">${Number(item.application_count || 0)} applicants</span>
          </div>
          <h3>${this.escape(item.title)}</h3>
          <p>${this.escape(item.description.slice(0, 180))}</p>
          <div class="work-card-footer">
            <span>${this.money(
              item.pricing_model === 'fixed'
                ? item.fixed_budget_minor
                : item.hourly_rate_minor,
              item.currency
            )}</span>
            <button class="btn btn-outline btn-sm"
              data-work-applications="${this.escape(item.id)}">
              Review applications
            </button>
          </div>
        </article>
      `).join('');

      const applicationCards = applications.map(item => `
        <article class="work-card">
          <div class="work-card-top">
            <span class="work-tag">${this.escape(item.applicant_type)}</span>
            <span class="work-tag">${this.escape(item.status)}</span>
          </div>
          <h3>${this.escape(item.opportunity_title)}</h3>
          <p>Client: ${this.escape(
            item.client_display_name || item.client_username || 'AURUM member'
          )}</p>
          <p>${this.escape(item.cover_message)}</p>
          ${item.status === 'submitted' ||
            item.status === 'under_review' ||
            item.status === 'shortlisted'
            ? `<div class="work-action-row">
                <button class="btn btn-ghost btn-sm"
                  data-work-withdraw="${this.escape(item.id)}">
                  Withdraw application
                </button>
              </div>`
            : ''}
        </article>
      `).join('');

      const engagementCards = engagements.map(item => `
        <article class="work-card">
          <div class="work-card-top">
            <span class="work-tag">${this.escape(item.status)}</span>
            <span class="work-tag">${this.escape(item.pricing_model)}</span>
          </div>
          <h3>${this.escape(item.opportunity_title)}</h3>
          <p>${this.money(
            item.pricing_model === 'fixed'
              ? item.agreed_fixed_amount_minor
              : item.agreed_hourly_rate_minor,
            item.currency
          )}${item.pricing_model === 'hourly' ? ' / hour' : ''}</p>
          <p class="work-client">
            ${item.provider_type === 'crew' ? 'Crew engagement' : 'Individual engagement'}
          </p>
          <div class="work-action-row">
            <button class="btn btn-primary btn-sm"
              data-work-engagement="${this.escape(item.id)}">
              Open workspace
            </button>
          </div>
        </article>
      `).join('');

      list.innerHTML = `
        ${section(
          'Opportunities you posted',
          'Manage drafts, published listings and applicants.',
          opportunityCards
        )}
        ${section(
          'Your applications',
          'Follow the opportunities you have applied to.',
          applicationCards
        )}
        ${section(
          'Your engagements',
          'Manage accepted work and delivery.',
          engagementCards
        )}
      `;
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

 async withdrawApplication(button) {
    if (!confirm('Withdraw this application?')) return;

    button.disabled = true;

    try {
      await AURUM.WorkAPI.withdrawApplication(button.dataset.workWithdraw);
      AURUM.showToast('Application withdrawn.', 'success');
      await this.loadOwnedOpportunities();
    } catch (error) {
      AURUM.showToast(error.message, 'error');
      button.disabled = false;
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
          const minor = this.toMinorUnits(amount, item.currency);

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

  async openEngagement(id) {
    this.activeEngagement = id;
    this.showPanel('detail');

    const target = this.container.querySelector('#work-detail-content');
    target.innerHTML = '<p class="work-empty">Opening engagement workspace...</p>';

    try {
      const data = await AURUM.WorkAPI.getWorkspace(id);

      if (!data.engagement) throw new Error('Engagement not found.');

      this.renderEngagementWorkspace(target, data);
    } catch (error) {
      target.innerHTML = `<p class="work-empty">${this.escape(error.message)}</p>`;
    }
  },

  renderEngagementWorkspace(target, data) {
    const e = data.engagement;
    const isClient = e.client_user_id === window.App?.user?.id;
    const fixed = e.pricing_model === 'fixed';

    const participants = (data.participants || []).map(p => `
      <div class="work-card">
        <strong>${this.escape(p.username || 'Crew member')}</strong>
        <span class="work-tag">${this.escape(p.assigned_role)}</span>
        <span class="work-tag">${this.escape(p.status)}</span>
      </div>
    `).join('');

    const milestones = (data.milestones || []).map(m => `
      <article class="work-card">
        <div class="work-card-top">
          <strong>${this.escape(m.title)}</strong>
          <span class="work-tag">${this.escape(m.status)}</span>
        </div>
        <p>${this.escape(m.description || '')}</p>
        <strong>${this.money(m.amount_minor, e.currency)}</strong>
      </article>
    `).join('');

    const submissions = (data.submissions || []).map(s => `
      <article class="work-card">
        <div class="work-card-top">
          <strong>Submission</strong>
          <span class="work-tag">${this.escape(s.status)}</span>
        </div>
        <p>${this.escape(s.message)}</p>
        <small>Submitted by ${this.escape(s.submitted_by_username || 'Provider')}</small>
        ${s.status === 'submitted' && isClient ? `
          <div class="work-action-row">
            <button class="btn btn-primary btn-sm"
              data-ws-action="approve-submission"
              data-id="${this.escape(s.id)}">Approve</button>
            <button class="btn btn-outline btn-sm"
              data-ws-action="request-revision"
              data-id="${this.escape(s.id)}">Request revision</button>
            <button class="btn btn-danger btn-sm"
              data-ws-action="reject-submission"
              data-id="${this.escape(s.id)}">Reject</button>
          </div>
        ` : ''}
        ${s.status === 'revision_requested' ? `
          <form data-ws-form="revision" data-id="${this.escape(s.id)}">
            <textarea class="input" name="message" minlength="3"
              maxlength="5000" required placeholder="Describe the revision..."></textarea>
            <button class="btn btn-primary btn-sm">Submit revision response</button>
          </form>
        ` : ''}
      </article>
    `).join('');

    const timeEntries = (data.time_entries || []).map(t => `
      <article class="work-card">
        <div class="work-card-top">
          <strong>${this.escape(t.description)}</strong>
          <span class="work-tag">${this.escape(t.status)}</span>
        </div>
        <p>${Number(t.duration_minutes)} minutes</p>
        ${t.status === 'submitted' && isClient ? `
          <div class="work-action-row">
            <button class="btn btn-primary btn-sm"
              data-ws-action="approve-time"
              data-id="${this.escape(t.id)}">Approve</button>
            <button class="btn btn-outline btn-sm"
              data-ws-action="reject-time"
              data-id="${this.escape(t.id)}">Reject</button>
            <button class="btn btn-danger btn-sm"
              data-ws-action="dispute-time"
              data-id="${this.escape(t.id)}">Dispute</button>
          </div>
        ` : ''}
      </article>
    `).join('');

    const pendingParticipants = (data.participants || []).some(p => p.status !== 'accepted');

    target.innerHTML = `
      <button class="work-back-link" id="work-back-button">← Back to My Work</button>

      <div class="work-panel-heading">
        <p class="section-eyebrow">AURUM / WORKSPACE</p>
        <h2>${this.escape(e.opportunity_title || 'Engagement')}</h2>
        <p>Manage your engagement, delivery and communication.</p>
      </div>

      <article class="work-card">
        <div class="work-card-top">
          <span class="work-tag">${this.escape(e.status)}</span>
          <span class="work-tag">${this.escape(e.pricing_model)}</span>
        </div>
        <h3>${this.money(
          fixed ? e.agreed_fixed_amount_minor : e.agreed_hourly_rate_minor,
          e.currency
        )}${fixed ? '' : ' / hour'}</h3>
        ${e.pricing_model === 'hourly' ? `
          <p>Spending limit: ${this.money(e.agreed_spending_limit_minor, e.currency)}</p>
        ` : ''}
        ${e.status === 'pending_acceptance' && isClient && !pendingParticipants ? `
          <button class="btn btn-primary" data-ws-action="activate">
            Activate engagement
          </button>
        ` : ''}
      </article>

      <section class="work-dashboard-section">
        <div class="work-panel-heading"><h3>Selected participants</h3></div>
        <div class="work-application-list">${participants || '<p>No additional participants.</p>'}</div>
      </section>

      ${e.status === 'pending_acceptance' && !isClient ? `
        <button class="btn btn-primary" data-ws-action="accept-role">
          Accept my assigned role
        </button>
      ` : ''}

      ${fixed ? `
        <section class="work-dashboard-section">
          <div class="work-panel-heading"><h3>Milestones</h3></div>
          <div class="work-application-list">
            ${milestones || '<p class="work-empty">No milestones created yet.</p>'}
          </div>
          ${isClient && ['active', 'revision_requested'].includes(e.status) ? `
            <form data-ws-form="milestone">
              <input class="input" name="title" minlength="3" maxlength="160"
                required placeholder="Milestone title" />
              <textarea class="input" name="description"
                placeholder="Description (optional)"></textarea>
              <input class="input" name="amount" type="number" min="0.000001"
                step="any" required placeholder="Amount in ${this.escape(e.currency)}" />
              <button class="btn btn-primary">Add milestone</button>
            </form>
          ` : ''}
          ${!isClient && ['active', 'revision_requested'].includes(e.status) ? `
            <form data-ws-form="deliverable">
              <select class="input" name="milestone_id">
                <option value="">General submission</option>
                ${(data.milestones || []).filter(m =>
                  ['pending', 'in_progress', 'revision_requested'].includes(m.status)
                ).map(m => `<option value="${this.escape(m.id)}">${this.escape(m.title)}</option>`).join('')}
              </select>
              <textarea class="input" name="message" minlength="5"
                maxlength="12000" required placeholder="Describe your completed work"></textarea>
              <button class="btn btn-primary">Submit deliverable</button>
            </form>
          ` : ''}
          <div class="work-application-list">${submissions || '<p>No submissions yet.</p>'}</div>
        </section>
      ` : `
        <section class="work-dashboard-section">
          <div class="work-panel-heading"><h3>Timesheets</h3></div>
          <div class="work-application-list">
            ${timeEntries || '<p>No time entries yet.</p>'}
          </div>
          ${!isClient && e.status === 'active' ? `
            <form data-ws-form="time-entry">
              <input class="input" name="description" minlength="5"
                maxlength="2000" required placeholder="Work performed" />
              <label>Start time
                <input class="input" type="datetime-local" name="started_at" required />
              </label>
              <label>End time
                <input class="input" type="datetime-local" name="ended_at" required />
              </label>
              <button class="btn btn-primary">Submit time entry</button>
            </form>
          ` : ''}
        </section>
      `}

      ${['active', 'submitted', 'revision_requested'].includes(e.status) ? `
        <section class="work-dashboard-section">
          <div class="work-panel-heading"><h3>Dispute support</h3></div>
          <form data-ws-form="dispute">
            <input class="input" name="category" minlength="2"
              maxlength="80" required placeholder="Dispute category" />
            <textarea class="input" name="description" minlength="10"
              maxlength="12000" required placeholder="Explain the issue"></textarea>
            <button class="btn btn-outline">Open a dispute</button>
          </form>
        </section>
      ` : ''}

      <p class="work-notice">
        Workspace approvals record delivery and time. They do not transfer,
        reserve or release funds.
      </p>
      <p class="work-message" id="work-workspace-message" role="status"></p>
    `;
  },

  async handleWorkspaceAction(button) {
    const action = button.dataset.wsAction;
    const id = button.dataset.id;
    const message = this.container.querySelector('#work-workspace-message');

    button.disabled = true;

    try {
      if (action === 'accept-role') {
        await AURUM.WorkAPI.acceptEngagementRole(this.activeEngagement);
      } else if (action === 'activate') {
        if (!confirm('Activate this engagement? This does not transfer or hold funds.')) return;
        await AURUM.WorkAPI.activateEngagement(this.activeEngagement);
      } else if (action === 'approve-submission') {
        await AURUM.WorkAPI.reviewSubmission(id, { decision: 'approve' });
      } else if (action === 'request-revision') {
        const note = prompt('Explain what needs to be revised:');
        if (!note) return;
        await AURUM.WorkAPI.reviewSubmission(id, {
          decision: 'request_revision',
          message: note,
        });
      } else if (action === 'reject-submission') {
        if (!confirm('Reject this submission? This opens a formal dispute.')) return;
        await AURUM.WorkAPI.reviewSubmission(id, { decision: 'reject' });
      } else if (action === 'approve-time') {
        await AURUM.WorkAPI.reviewTimeEntry(id, 'approve');
      } else if (action === 'reject-time') {
        await AURUM.WorkAPI.reviewTimeEntry(id, 'reject');
      } else if (action === 'dispute-time') {
        await AURUM.WorkAPI.reviewTimeEntry(id, 'dispute');
      }

      await this.openEngagement(this.activeEngagement);
    } catch (error) {
      if (message) message.textContent = error.message;
      button.disabled = false;
    }
  },

  async handleWorkspaceForm(form) {
    const data = new FormData(form);
    const kind = form.dataset.wsForm;
    const message = this.container.querySelector('#work-workspace-message');
    const e = (await AURUM.WorkAPI.getWorkspace(this.activeEngagement)).engagement;

    try {
      if (kind === 'milestone') {
        await AURUM.WorkAPI.createMilestone(this.activeEngagement, {
          title: data.get('title').trim(),
          description: data.get('description').trim() || null,
          amount_minor: this.toMinorUnits(data.get('amount'), e.currency),
        });
      } else if (kind === 'deliverable') {
        await AURUM.WorkAPI.submitDeliverable(this.activeEngagement, {
          milestone_id: data.get('milestone_id') || null,
          message: data.get('message').trim(),
        });
      } else if (kind === 'time-entry') {
        await AURUM.WorkAPI.submitTimeEntry(this.activeEngagement, {
          description: data.get('description').trim(),
          started_at: new Date(data.get('started_at')).toISOString(),
          ended_at: new Date(data.get('ended_at')).toISOString(),
        });
      } else if (kind === 'revision') {
        await AURUM.WorkAPI.respondToRevision(
          form.dataset.id,
          data.get('message').trim(),
        );
      } else if (kind === 'dispute') {
        await AURUM.WorkAPI.openDispute(this.activeEngagement, {
          category: data.get('category').trim(),
          description: data.get('description').trim(),
        });
      }

      await this.openEngagement(this.activeEngagement);
    } catch (error) {
      if (message) message.textContent = error.message;
    }
  },
};

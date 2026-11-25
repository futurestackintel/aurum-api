import { hasCrewPermission } from './crew.js';

const MAX_TITLE_LENGTH = 160;
const MAX_DESCRIPTION_LENGTH = 12000;
const MAX_COVER_MESSAGE_LENGTH = 5000;
const MAX_CREW_MEMBERS = 100;

function nowISO() {
  return new Date().toISOString();
}

function newId() {
  return crypto.randomUUID();
}

function validText(value, min, max) {
  return typeof value === 'string'
    && value.trim().length >= min
    && value.trim().length <= max;
}

function validMinorAmount(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function normalizeOpportunityInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Invalid opportunity payload');
  }

  const title = input.title?.trim();
  const description = input.description?.trim();
  const pricingModel = input.pricing_model;
  const currency = input.currency;

  if (!validText(title, 5, MAX_TITLE_LENGTH)) {
    throw new Error('Title must be between 5 and 160 characters');
  }

  if (!validText(description, 20, MAX_DESCRIPTION_LENGTH)) {
    throw new Error('Description must be between 20 and 12,000 characters');
  }

  if (!['fixed', 'hourly'].includes(pricingModel)) {
    throw new Error('Invalid pricing model');
  }

  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error('A valid uppercase currency code is required');
  }

  const fixedBudget = input.fixed_budget_minor ?? null;
  const hourlyRate = input.hourly_rate_minor ?? null;
  const spendingLimit = input.spending_limit_minor ?? null;

  if (pricingModel === 'fixed') {
    if (!validMinorAmount(fixedBudget)) {
      throw new Error('A valid fixed budget is required');
    }

    if (hourlyRate !== null || spendingLimit !== null) {
      throw new Error('Hourly pricing fields are not allowed for fixed work');
    }
  }

  if (pricingModel === 'hourly') {
    if (!validMinorAmount(hourlyRate) || !validMinorAmount(spendingLimit)) {
      throw new Error('Hourly rate and spending limit are required');
    }

    if (fixedBudget !== null) {
      throw new Error('Fixed budget is not allowed for hourly work');
    }

    if (hourlyRate > spendingLimit) {
      throw new Error('Hourly rate cannot exceed the spending limit');
    }
  }

  const multiHire = input.multi_hire_enabled === true;
  const capacity = input.hire_capacity ?? 1;

  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 100
  ) {
    throw new Error('Hire capacity must be between 1 and 100');
  }

  if (!multiHire && capacity !== 1) {
    throw new Error('Multiple hires must be explicitly enabled');
  }

  const eligibility = input.applicant_eligibility ?? 'individuals';

  if (!['individuals', 'crews', 'both'].includes(eligibility)) {
    throw new Error('Invalid applicant eligibility');
  }

  return {
    title,
    description,
    category: validText(input.category, 1, 80)
      ? input.category.trim()
      : null,
    skills: Array.isArray(input.skills)
      ? JSON.stringify(
          [...new Set(
            input.skills
              .filter(skill => typeof skill === 'string')
              .map(skill => skill.trim().slice(0, 60))
              .filter(Boolean)
          )].slice(0, 30)
        )
      : null,
    pricingModel,
    currency,
    fixedBudget,
    hourlyRate,
    spendingLimit,
    multiHire,
    capacity,
    eligibility,
  };
}

async function getActiveUser(userId, db) {
  return db.prepare(`
    SELECT id
    FROM users
    WHERE id = ?
      AND account_deleted = 0
      AND deleted_at IS NULL
      AND is_suspended = 0
  `).bind(userId).first();
}

async function getActiveMembership(crewId, userId, db) {
  return db.prepare(`
    SELECT cm.id, cm.role
    FROM crew_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.crew_id = ?
      AND cm.user_id = ?
      AND u.account_deleted = 0
      AND u.deleted_at IS NULL
      AND u.is_suspended = 0
  `).bind(crewId, userId).first();
}

async function getEligibleCrewMembers(crewId, db) {
  const result = await db.prepare(`
    SELECT cm.user_id, cm.role
    FROM crew_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.crew_id = ?
      AND u.account_deleted = 0
      AND u.deleted_at IS NULL
      AND u.is_suspended = 0
    ORDER BY cm.joined_at ASC
  `).bind(crewId).all();

  return result.results || [];
}

export async function createWorkOpportunity(clientUserId, input, db) {
  try {
    const client = await getActiveUser(clientUserId, db);

    if (!client) {
      return { error: 'Your account is unavailable for Work publishing' };
    }

    const data = normalizeOpportunityInput(input);
    const id = newId();
    const now = nowISO();

    await db.prepare(`
      INSERT INTO work_opportunities (
        id,
        client_user_id,
        title,
        description,
        category,
        skills,
        applicant_eligibility,
        pricing_model,
        currency,
        fixed_budget_minor,
        hourly_rate_minor,
        spending_limit_minor,
        multi_hire_enabled,
        hire_capacity,
        status,
        created_at,
        updated_at,
        published_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL)
    `).bind(
      id,
      clientUserId,
      data.title,
      data.description,
      data.category,
      data.skills,
      data.eligibility,
      data.pricingModel,
      data.currency,
      data.fixedBudget,
      data.hourlyRate,
      data.spendingLimit,
      data.multiHire ? 1 : 0,
      data.capacity,
      now,
      now,
    ).run();

    return {
      success: true,
      opportunity: await getWorkOpportunity(id, clientUserId, db),
    };
  } catch (error) {
    return { error: error.message || 'Unable to create opportunity' };
  }
}

export async function publishWorkOpportunity(opportunityId, clientUserId, db) {
  const opportunity = await db.prepare(`
    SELECT id, status
    FROM work_opportunities
    WHERE id = ? AND client_user_id = ?
  `).bind(opportunityId, clientUserId).first();

  if (!opportunity) return { error: 'Opportunity not found' };

  if (opportunity.status !== 'draft') {
    return { error: 'Only draft opportunities can be published' };
  }

  const now = nowISO();

  const result = await db.prepare(`
    UPDATE work_opportunities
    SET status = 'open',
        published_at = ?,
        updated_at = ?
    WHERE id = ?
      AND client_user_id = ?
      AND status = 'draft'
  `).bind(now, now, opportunityId, clientUserId).run();

  if (!result.meta.changes) {
    return { error: 'Opportunity could not be published' };
  }

  return { success: true, opportunity_id: opportunityId };
}

export async function getWorkOpportunity(opportunityId, viewerUserId, db) {
  const opportunity = await db.prepare(`
    SELECT
      o.*,
      u.username AS client_username,
      u.display_name AS client_display_name,
      u.avatar_url AS client_avatar_url
    FROM work_opportunities o
    JOIN users u ON u.id = o.client_user_id
    WHERE o.id = ?
      AND u.account_deleted = 0
      AND u.deleted_at IS NULL
      AND u.is_suspended = 0
      AND (
        o.status = 'open'
        OR o.client_user_id = ?
      )
  `).bind(opportunityId, viewerUserId || null).first();

  if (!opportunity) return null;

  const applicationCount = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM work_applications
    WHERE opportunity_id = ?
      AND status NOT IN ('withdrawn', 'rejected')
  `).bind(opportunityId).first();

  return {
    ...opportunity,
    skills: opportunity.skills ? JSON.parse(opportunity.skills) : [],
    application_count: applicationCount?.count || 0,
  };
}

export async function listWorkOpportunities({
  viewerUserId = null,
  category = null,
  pricingModel = null,
  eligibility = null,
  currency = null,
  search = null,
  limit = 20,
  offset = 0,
} = {}, db) {
  limit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 20));
  offset = Math.max(0, Number.parseInt(offset, 10) || 0);

  let query = `
    SELECT
      o.id,
      o.client_user_id,
      o.title,
      o.description,
      o.category,
      o.skills,
      o.applicant_eligibility,
      o.pricing_model,
      o.currency,
      o.fixed_budget_minor,
      o.hourly_rate_minor,
      o.spending_limit_minor,
      o.multi_hire_enabled,
      o.hire_capacity,
      o.status,
      o.created_at,
      o.published_at,
      u.username AS client_username,
      u.display_name AS client_display_name,
      u.avatar_url AS client_avatar_url
    FROM work_opportunities o
    JOIN users u ON u.id = o.client_user_id
    WHERE o.status = 'open'
      AND u.account_deleted = 0
      AND u.deleted_at IS NULL
      AND u.is_suspended = 0
  `;

  const bindings = [];

  if (category) {
    query += ' AND o.category = ?';
    bindings.push(category);
  }

  if (pricingModel) {
    if (!['fixed', 'hourly'].includes(pricingModel)) {
      return { error: 'Invalid pricing model' };
    }

    query += ' AND o.pricing_model = ?';
    bindings.push(pricingModel);
  }

  if (eligibility) {
    if (!['individuals', 'crews', 'both'].includes(eligibility)) {
      return { error: 'Invalid eligibility filter' };
    }

    query += ' AND o.applicant_eligibility IN (?, ?)';
    bindings.push(
      eligibility,
      eligibility === 'individuals' ? 'both' : 'both',
    );
  }

  if (currency) {
    if (!/^[A-Z]{3}$/.test(currency)) {
      return { error: 'Invalid currency filter' };
    }

    query += ' AND o.currency = ?';
    bindings.push(currency);
  }

  if (search) {
    if (typeof search !== 'string' || search.trim().length > 100) {
      return { error: 'Invalid search query' };
    }

    query += ' AND (o.title LIKE ? OR o.description LIKE ?)';
    const term = `%${search.trim()}%`;
    bindings.push(term, term);
  }

  query += `
    ORDER BY o.published_at DESC, o.id DESC
    LIMIT ? OFFSET ?
  `;

  bindings.push(limit, offset);

  const result = await db.prepare(query).bind(...bindings).all();

  return {
    opportunities: (result.results || []).map(row => ({
      ...row,
      skills: row.skills ? JSON.parse(row.skills) : [],
    })),
  };
}

export async function submitIndividualWorkApplication(
  opportunityId,
  applicantUserId,
  input,
  db,
) {
  try {
    const applicant = await getActiveUser(applicantUserId, db);

    if (!applicant) return { error: 'Your account is unavailable' };

    const opportunity = await db.prepare(`
      SELECT *
      FROM work_opportunities
      WHERE id = ? AND status = 'open'
    `).bind(opportunityId).first();

    if (!opportunity) return { error: 'Opportunity is not available' };

    if (!['individuals', 'both'].includes(opportunity.applicant_eligibility)) {
      return { error: 'This opportunity is not accepting individual applicants' };
    }

    if (opportunity.client_user_id === applicantUserId) {
      return { error: 'You cannot apply to your own opportunity' };
    }

    if (!validText(input?.cover_message, 10, MAX_COVER_MESSAGE_LENGTH)) {
      return { error: 'Cover message must be between 10 and 5,000 characters' };
    }

    const proposedFixed = input.proposed_fixed_amount_minor ?? null;
    const proposedHourly = input.proposed_hourly_rate_minor ?? null;

    if (opportunity.pricing_model === 'fixed') {
      if (proposedHourly !== null) {
        return { error: 'Hourly rate is not valid for fixed-price work' };
      }

      if (
        proposedFixed !== null &&
        !validMinorAmount(proposedFixed)
      ) {
        return { error: 'Invalid proposed fixed amount' };
      }
    } else {
      if (proposedFixed !== null) {
        return { error: 'Fixed amount is not valid for hourly work' };
      }

      if (
        proposedHourly !== null &&
        !validMinorAmount(proposedHourly)
      ) {
        return { error: 'Invalid proposed hourly rate' };
      }
    }

    const id = newId();
    const now = nowISO();

    await db.prepare(`
      INSERT INTO work_applications (
        id,
        opportunity_id,
        applicant_type,
        applicant_user_id,
        applicant_crew_id,
        submitted_by_user_id,
        cover_message,
        proposed_fixed_amount_minor,
        proposed_hourly_rate_minor,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, 'individual', ?, NULL, ?, ?, ?, ?, 'submitted', ?, ?)
    `).bind(
      id,
      opportunityId,
      applicantUserId,
      applicantUserId,
      input.cover_message.trim(),
      proposedFixed,
      proposedHourly,
      now,
      now,
    ).run();

    return { success: true, application_id: id };
  } catch (error) {
    if (error.message?.includes('UNIQUE')) {
      return { error: 'You have already applied to this opportunity' };
    }

    return { error: error.message || 'Unable to submit application' };
  }
}

export async function submitCrewWorkApplication(
  opportunityId,
  crewId,
  submittingUserId,
  input,
  db,
) {
  try {
    const submitter = await getActiveUser(submittingUserId, db);

    if (!submitter) return { error: 'Your account is unavailable' };

    const opportunity = await db.prepare(`
      SELECT *
      FROM work_opportunities
      WHERE id = ? AND status = 'open'
    `).bind(opportunityId).first();

    if (!opportunity) return { error: 'Opportunity is not available' };

    if (!['crews', 'both'].includes(opportunity.applicant_eligibility)) {
      return { error: 'This opportunity is not accepting Crew applicants' };
    }

    if (opportunity.client_user_id === submittingUserId) {
      return { error: 'You cannot apply to your own opportunity' };
    }

    const membership = await getActiveMembership(
      crewId,
      submittingUserId,
      db,
    );

    if (!membership) {
      return { error: 'You must be an active member of this Crew' };
    }

    if (
      membership.role !== 'captain' &&
      !(await hasCrewPermission(
        crewId,
        submittingUserId,
        'submit_work_proposals',
        db,
      ))
    ) {
      return {
        error: 'Only the Captain or a delegated Vice Captain can submit Crew proposals',
      };
    }

    if (!validText(input?.cover_message, 10, MAX_COVER_MESSAGE_LENGTH)) {
      return { error: 'Cover message must be between 10 and 5,000 characters' };
    }

    if (
      !Array.isArray(input.members) ||
      input.members.length < 1 ||
      input.members.length > MAX_CREW_MEMBERS
    ) {
      return { error: 'Select between 1 and 100 proposed Crew members' };
    }

    const proposedMembers = input.members;
    const memberIds = proposedMembers.map(member => member?.user_id);

    if (
      memberIds.some(id => typeof id !== 'string' || !id.trim()) ||
      new Set(memberIds).size !== memberIds.length
    ) {
      return { error: 'Invalid or duplicate Crew member selection' };
    }

    const eligibleMembers = await getEligibleCrewMembers(crewId, db);
    const eligibleIds = new Set(eligibleMembers.map(member => member.user_id));

    for (const member of proposedMembers) {
      if (!eligibleIds.has(member.user_id)) {
        return {
          error: 'Every proposed participant must be an active eligible Crew member',
        };
      }

      if (!validText(member.proposed_role, 2, 100)) {
        return { error: 'Each proposed member needs a valid assigned role' };
      }
    }

    const proposedFixed = input.proposed_fixed_amount_minor ?? null;
    const proposedHourly = input.proposed_hourly_rate_minor ?? null;

    if (opportunity.pricing_model === 'fixed') {
      if (proposedHourly !== null) {
        return { error: 'Hourly rate is not valid for fixed-price work' };
      }

      if (proposedFixed !== null && !validMinorAmount(proposedFixed)) {
        return { error: 'Invalid proposed fixed amount' };
      }
    } else {
      if (proposedFixed !== null) {
        return { error: 'Fixed amount is not valid for hourly work' };
      }

      if (proposedHourly !== null && !validMinorAmount(proposedHourly)) {
        return { error: 'Invalid proposed hourly rate' };
      }
    }

    const applicationId = newId();
    const now = nowISO();

    const statements = [
      db.prepare(`
        INSERT INTO work_applications (
          id,
          opportunity_id,
          applicant_type,
          applicant_user_id,
          applicant_crew_id,
          submitted_by_user_id,
          cover_message,
          proposed_fixed_amount_minor,
          proposed_hourly_rate_minor,
          status,
          created_at,
          updated_at
        )
        VALUES (?, ?, 'crew', NULL, ?, ?, ?, ?, ?, 'submitted', ?, ?)
      `).bind(
        applicationId,
        opportunityId,
        crewId,
        submittingUserId,
        input.cover_message.trim(),
        proposedFixed,
        proposedHourly,
        now,
        now,
      ),
    ];

    for (const member of proposedMembers) {
      statements.push(db.prepare(`
        INSERT INTO work_application_crew_members (
          id,
          application_id,
          crew_id,
          user_id,
          proposed_role,
          membership_confirmed_at,
          role_accepted,
          role_accepted_at,
          created_at
        )
        VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)
      `).bind(
        newId(),
        applicationId,
        crewId,
        member.user_id,
        member.proposed_role.trim(),
        now,
        now,
      ));
    }
		
    // Freeze the eligible voting membership at submission time.
    for (const member of eligibleMembers) {
      statements.push(db.prepare(`
        INSERT INTO work_crew_application_voter_snapshot (
          id,
          application_id,
          crew_id,
          user_id,
          role_snapshot
        )
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        newId(),
        applicationId,
        crewId,
        member.user_id,
        member.role,
      ));
		}
		
    await db.batch(statements);

    return {
      success: true,
      application_id: applicationId,
      governance_required: true,
      selected_member_count: proposedMembers.length,
    };
  } catch (error) {
    if (error.message?.includes('UNIQUE')) {
      return { error: 'This Crew has already applied to this opportunity' };
    }

    return { error: error.message || 'Unable to submit Crew proposal' };
  }
}

export async function castCrewWorkApplicationVote(
  applicationId,
  voterUserId,
  vote,
  db,
) {
  if (!['approve', 'reject'].includes(vote)) {
    return { error: 'Vote must be approve or reject' };
  }

  const application = await db.prepare(`
    SELECT
      a.id,
      a.applicant_type,
      a.applicant_crew_id,
      a.status
    FROM work_applications a
    WHERE a.id = ?
      AND a.applicant_type = 'crew'
  `).bind(applicationId).first();

  if (!application) return { error: 'Crew application not found' };

  if (!['submitted', 'under_review', 'shortlisted'].includes(application.status)) {
    return { error: 'This application is no longer accepting votes' };
  }

    const membership = await getActiveMembership(
    application.applicant_crew_id,
    voterUserId,
    db,
  );

  if (!membership) {
    return { error: 'Only active Crew members can vote' };
  }

  const voterSnapshot = await db.prepare(`
    SELECT role_snapshot
    FROM work_crew_application_voter_snapshot
    WHERE application_id = ?
      AND crew_id = ?
      AND user_id = ?
  `).bind(
    applicationId,
    application.applicant_crew_id,
    voterUserId,
  ).first();

  if (!voterSnapshot) {
    return { error: 'You were not eligible to vote when this proposal was submitted' };
  }

  const snapshotCount = await db.prepare(`
    SELECT COUNT(*) AS count
    FROM work_crew_application_voter_snapshot
    WHERE application_id = ?
      AND crew_id = ?
  `).bind(
    applicationId,
    application.applicant_crew_id,
  ).first();

  const eligibleCount = Number(snapshotCount?.count || 0);

  if (!eligibleCount) {
    return { error: 'Crew voting snapshot is unavailable' };
  }

  const captain = voterSnapshot.role_snapshot === 'captain';
  const now = nowISO();

  try {
    await db.prepare(`
      INSERT INTO work_crew_application_approvals (
        id,
        application_id,
        crew_id,
        user_id,
        vote,
        is_captain_approval,
        eligible_member_snapshot,
        eligible_member_count_snapshot,
        created_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).bind(
      newId(),
      applicationId,
      application.applicant_crew_id,
      voterUserId,
      vote,
      captain ? 1 : 0,
      eligibleCount,
      now,
    ).run();
  } catch (error) {
    if (error.message?.includes('UNIQUE')) {
      return { error: 'You have already voted on this proposal' };
    }

    throw error;
  }

  const tally = await db.prepare(`
    SELECT
      COUNT(*) AS total_votes,
      SUM(CASE WHEN vote = 'approve' THEN 1 ELSE 0 END) AS approvals,
      SUM(CASE WHEN vote = 'reject' THEN 1 ELSE 0 END) AS rejections,
            MAX(
        CASE
          WHEN is_captain_approval = 1 AND vote = 'approve' THEN 1
          ELSE 0
        END
      ) AS captain_approved
    FROM work_crew_application_approvals
    WHERE application_id = ?
      AND crew_id = ?
  `).bind(applicationId, application.applicant_crew_id).first();

  const majorityApproved =
    Number(tally.approvals || 0) > eligibleCount / 2;

  const captainApproved = Number(tally.captain_approved || 0) === 1;

  
  const snapshotsConsistent = true;
	
  return {
    success: true,
    vote,
    governance: {
      eligible_member_count: eligibleCount,
      votes_cast: Number(tally.total_votes || 0),
      approvals: Number(tally.approvals || 0),
      rejections: Number(tally.rejections || 0),
      majority_approved: majorityApproved,
      captain_approved: captainApproved,
      snapshots_consistent: snapshotsConsistent,
      approved: majorityApproved && captainApproved && snapshotsConsistent,
    },
  };
}

export async function acceptCrewWorkApplicationRole(
  applicationId,
  memberUserId,
  db,
) {
  const applicationMember = await db.prepare(`
    SELECT
      m.id,
      m.crew_id,
      m.user_id,
      m.role_accepted,
      a.status,
      a.applicant_crew_id
    FROM work_application_crew_members m
    JOIN work_applications a ON a.id = m.application_id
    WHERE m.application_id = ?
      AND m.user_id = ?
      AND a.applicant_type = 'crew'
  `).bind(applicationId, memberUserId).first();

  if (!applicationMember) {
    return { error: 'You are not a proposed participant in this application' };
  }

  if (applicationMember.role_accepted) {
    return { error: 'You have already accepted this proposed role' };
  }

  if (!['submitted', 'under_review', 'shortlisted'].includes(applicationMember.status)) {
    return { error: 'This proposal is no longer accepting role acceptances' };
  }

  const membership = await getActiveMembership(
    applicationMember.crew_id,
    memberUserId,
    db,
  );

  if (!membership) {
    return { error: 'You must remain an active Crew member to accept this role' };
  }

  const result = await db.prepare(`
    UPDATE work_application_crew_members
    SET role_accepted = 1,
        role_accepted_at = ?
    WHERE id = ?
      AND role_accepted = 0
  `).bind(nowISO(), applicationMember.id).run();

  if (!result.meta.changes) {
    return { error: 'Role acceptance could not be recorded' };
  }

  return { success: true, application_id: applicationId };
    }

// ── WORK ENGAGEMENTS ─────────────────────────────────────────

export async function hireWorkApplication(
  applicationId,
  clientUserId,
  input = {},
  db,
) {
  try {
    const application = await db.prepare(`
      SELECT
        a.*,
        o.client_user_id,
        o.pricing_model,
        o.currency,
        o.fixed_budget_minor,
        o.hourly_rate_minor,
        o.spending_limit_minor,
        o.hire_capacity,
        o.multi_hire_enabled,
        o.status AS opportunity_status
      FROM work_applications a
      JOIN work_opportunities o ON o.id = a.opportunity_id
      WHERE a.id = ?
    `).bind(applicationId).first();

    if (!application) return { error: 'Application not found' };

    if (application.client_user_id !== clientUserId) {
      return { error: 'Only the opportunity owner can hire applicants' };
    }

    if (application.opportunity_status !== 'open') {
      return { error: 'This opportunity is no longer accepting hires' };
    }

    if (!['submitted', 'under_review', 'shortlisted'].includes(application.status)) {
      return { error: 'This application cannot be hired' };
    }

    const existing = await db.prepare(`
      SELECT id FROM work_engagements WHERE application_id = ?
    `).bind(applicationId).first();

    if (existing) return { error: 'This application already has an engagement' };

    const hireCount = await db.prepare(`
      SELECT COUNT(*) AS count
      FROM work_engagements
      WHERE opportunity_id = ?
        AND status NOT IN ('cancelled')
    `).bind(application.opportunity_id).first();

    if (Number(hireCount?.count || 0) >= application.hire_capacity) {
      return { error: 'This opportunity has reached its hiring capacity' };
    }

    let fixedAmount = null;
    let hourlyRate = null;
    let spendingLimit = null;

    if (application.pricing_model === 'fixed') {
      fixedAmount = input.agreed_fixed_amount_minor
        ?? application.proposed_fixed_amount_minor
        ?? application.fixed_budget_minor;

      if (!validMinorAmount(fixedAmount)) {
        return { error: 'A valid agreed fixed amount is required' };
      }
    } else {
      hourlyRate = input.agreed_hourly_rate_minor
        ?? application.proposed_hourly_rate_minor
        ?? application.hourly_rate_minor;

      spendingLimit = input.agreed_spending_limit_minor
        ?? application.spending_limit_minor;

      if (
        !validMinorAmount(hourlyRate) ||
        !validMinorAmount(spendingLimit) ||
        hourlyRate > spendingLimit ||
        spendingLimit > application.spending_limit_minor
      ) {
        return { error: 'Invalid agreed hourly rate or spending limit' };
      }
    }

    const engagementId = newId();
    const now = nowISO();

    const statements = [
      db.prepare(`
        INSERT INTO work_engagements (
          id,
          opportunity_id,
          application_id,
          client_user_id,
          provider_type,
          provider_user_id,
          provider_crew_id,
          pricing_model,
          currency,
          agreed_fixed_amount_minor,
          agreed_hourly_rate_minor,
          agreed_spending_limit_minor,
          status,
          created_at,
          updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'pending_acceptance', ?, ?
        WHERE (
          SELECT COUNT(*)
          FROM work_engagements
          WHERE opportunity_id = ?
            AND status <> 'cancelled'
        ) < ?
      `).bind(
        engagementId,
        application.opportunity_id,
        applicationId,
        clientUserId,
        application.applicant_type,
        application.applicant_user_id,
        application.applicant_crew_id,
        application.pricing_model,
        application.currency,
        fixedAmount,
        hourlyRate,
        spendingLimit,
        now,
        now,
        application.opportunity_id,
        application.hire_capacity,
      ),
      db.prepare(`
        UPDATE work_applications
         SET status = 'accepted', updated_at = ?
        WHERE id = ?
          AND status IN ('submitted', 'under_review', 'shortlisted')
      `).bind(now, applicationId),
    ];

    let selectedMembers = [];

    if (application.applicant_type === 'crew') {
      const governance = await db.prepare(`
        SELECT
          COUNT(*) AS eligible_count,
          SUM(CASE WHEN a.vote = 'approve' THEN 1 ELSE 0 END) AS approvals,
          MAX(
            CASE
              WHEN a.is_captain_approval = 1 AND a.vote = 'approve'
              THEN 1 ELSE 0
            END
          ) AS captain_approved
        FROM work_crew_application_voter_snapshot s
        LEFT JOIN work_crew_application_approvals a
          ON a.application_id = s.application_id
         AND a.user_id = s.user_id
        WHERE s.application_id = ?
          AND s.crew_id = ?
      `).bind(applicationId, application.applicant_crew_id).first();

      const eligibleCount = Number(governance?.eligible_count || 0);
      const approvals = Number(governance?.approvals || 0);

      if (
        !eligibleCount ||
        approvals <= eligibleCount / 2 ||
        Number(governance.captain_approved || 0) !== 1
      ) {
        return { error: 'Crew governance approval is incomplete' };
      }

      const proposed = await db.prepare(`
        SELECT user_id, proposed_role, role_accepted
        FROM work_application_crew_members
        WHERE application_id = ?
          AND crew_id = ?
      `).bind(applicationId, application.applicant_crew_id).all();

      const proposedMembers = proposed.results || [];
      const requestedIds = input.selected_member_user_ids;

      if (
        !Array.isArray(requestedIds) ||
        requestedIds.length < 1 ||
        new Set(requestedIds).size !== requestedIds.length
      ) {
        return { error: 'Select the Crew members who will participate' };
      }

      const proposedById = new Map(
        proposedMembers.map(member => [member.user_id, member]),
      );

      for (const userId of requestedIds) {
        const member = proposedById.get(userId);

        if (!member || !member.role_accepted) {
          return {
            error: 'Every selected Crew participant must have accepted their proposed role',
          };
        }

        const activeMembership = await getActiveMembership(
          application.applicant_crew_id,
          userId,
          db,
        );

        if (!activeMembership) {
          return {
            error: 'A selected participant is no longer an active Crew member',
          };
        }

        selectedMembers.push(member);
      }

      const snapshot = await db.prepare(`
        SELECT user_id, role_snapshot
        FROM work_crew_application_voter_snapshot
        WHERE application_id = ?
          AND crew_id = ?
      `).bind(applicationId, application.applicant_crew_id).all();

      for (const voter of snapshot.results || []) {
        const current = await getActiveMembership(
          application.applicant_crew_id,
          voter.user_id,
          db,
        );

        if (!current || current.role !== voter.role_snapshot) {
          return {
            error: 'Crew membership or leadership changed after voting. Submit a new proposal for fresh approval.',
          };
        }
      }

      for (const member of selectedMembers) {
        statements.push(db.prepare(`
          INSERT INTO work_engagement_participants (
            id,
            engagement_id,
            user_id,
            assigned_role,
            accepted_at,
            status
          )
          VALUES (?, ?, ?, ?, ?, 'accepted')
        `).bind(
          newId(),
          engagementId,
          member.user_id,
          member.proposed_role,
          now,
        ));
      }
    } else {
      selectedMembers = [{
        user_id: application.applicant_user_id,
        proposed_role: 'Individual provider',
      }];

      statements.push(db.prepare(`
        INSERT INTO work_engagement_participants (
          id,
          engagement_id,
          user_id,
          assigned_role,
          accepted_at,
          status
        )
        VALUES (?, ?, ?, ?, NULL, 'pending')
      `).bind(
        newId(),
        engagementId,
        application.applicant_user_id,
        'Individual provider',
      ));
    }

    const result = await db.batch(statements);

    if (!result[0]?.meta?.changes) {
      return { error: 'Hiring capacity was reached or engagement creation failed' };
    }

    if (!result[1]?.meta?.changes) {
      return { error: 'Application status changed. Please refresh and try again.' };
    }

    return {
      success: true,
      engagement_id: engagementId,
      status: 'pending_acceptance',
      provider_type: application.applicant_type,
      participant_count: selectedMembers.length,
    };
  } catch (error) {
    if (error.message?.includes('UNIQUE')) {
      return { error: 'An engagement already exists for this application' };
    }

    return { error: error.message || 'Unable to create engagement' };
  }
}


// ── PROVIDER ROLE ACCEPTANCE ──────────────────────────────────

export async function acceptWorkEngagementRole(
  engagementId,
  userId,
  db,
) {
  const participant = await db.prepare(`
    SELECT
      p.id,
      p.status,
      e.status AS engagement_status,
      e.provider_type,
      e.provider_crew_id
    FROM work_engagement_participants p
    JOIN work_engagements e ON e.id = p.engagement_id
    WHERE p.engagement_id = ?
      AND p.user_id = ?
  `).bind(engagementId, userId).first();

  if (!participant) return { error: 'Engagement participant not found' };

  if (participant.status !== 'pending') {
    return { error: 'This participation is no longer pending' };
  }

  if (participant.engagement_status !== 'pending_acceptance') {
    return { error: 'This engagement is no longer awaiting acceptance' };
  }

  if (participant.provider_type === 'crew') {
    const membership = await getActiveMembership(
      participant.provider_crew_id,
      userId,
      db,
    );

    if (!membership) {
      return { error: 'You must remain an active Crew member to participate' };
    }
  }

  const result = await db.prepare(`
    UPDATE work_engagement_participants
    SET status = 'accepted',
        accepted_at = ?
    WHERE id = ?
      AND status = 'pending'
  `).bind(nowISO(), participant.id).run();

  if (!result.meta.changes) {
    return { error: 'Your acceptance could not be recorded' };
  }

  return { success: true, engagement_id: engagementId };
}


// ── ENGAGEMENT ACTIVATION ─────────────────────────────────────

export async function activateWorkEngagement(
  engagementId,
  clientUserId,
  db,
) {
  const engagement = await db.prepare(`
    SELECT *
    FROM work_engagements
    WHERE id = ?
      AND client_user_id = ?
  `).bind(engagementId, clientUserId).first();

  if (!engagement) return { error: 'Engagement not found' };

  if (engagement.status !== 'pending_acceptance') {
    return { error: 'Engagement is not awaiting activation' };
  }

  const participants = await db.prepare(`
    SELECT user_id, status
    FROM work_engagement_participants
    WHERE engagement_id = ?
  `).bind(engagementId).all();

  const rows = participants.results || [];

  if (!rows.length || rows.some(row => row.status !== 'accepted')) {
    return { error: 'Every selected provider must accept before activation' };
  }

  if (engagement.provider_type === 'crew') {
    for (const participant of rows) {
      const membership = await getActiveMembership(
        engagement.provider_crew_id,
        participant.user_id,
        db,
      );

      if (!membership) {
        return {
          error: 'A selected participant is no longer an active Crew member',
        };
      }
    }

    const captain = await db.prepare(`
      SELECT user_id
      FROM crew_members
      WHERE crew_id = ?
        AND role = 'captain'
    `).bind(engagement.provider_crew_id).first();

    if (!captain) {
      return { error: 'Crew leadership must be restored before activation' };
    }

    const application = await db.prepare(`
      SELECT id FROM work_applications
      WHERE id = ?
    `).bind(engagement.application_id).first();

    const snapshot = await db.prepare(`
      SELECT user_id, role_snapshot
      FROM work_crew_application_voter_snapshot
      WHERE application_id = ?
        AND crew_id = ?
    `).bind(
      application.id,
      engagement.provider_crew_id,
    ).all();

    for (const voter of snapshot.results || []) {
      const membership = await getActiveMembership(
        engagement.provider_crew_id,
        voter.user_id,
        db,
      );

      if (!membership || membership.role !== voter.role_snapshot) {
        return {
          error: 'Crew membership changed after approval. This engagement cannot be activated.',
        };
      }
    }
  }

  const now = nowISO();

  const result = await db.prepare(`
    UPDATE work_engagements
    SET status = 'active',
        activated_at = ?,
        updated_at = ?
    WHERE id = ?
      AND client_user_id = ?
      AND status = 'pending_acceptance'
  `).bind(now, now, engagementId, clientUserId).run();

  if (!result.meta.changes) {
    return { error: 'Engagement activation failed. Refresh and try again.' };
  }

  return { success: true, engagement_id: engagementId, status: 'active' };
}


// ── MILESTONES ────────────────────────────────────────────────

export async function createWorkMilestone(
  engagementId,
  clientUserId,
  input,
  db,
) {
  const engagement = await db.prepare(`
    SELECT *
    FROM work_engagements
    WHERE id = ?
      AND client_user_id = ?
      AND status IN ('active', 'revision_requested')
      AND pricing_model = 'fixed'
  `).bind(engagementId, clientUserId).first();

  if (!engagement) {
    return { error: 'Active fixed-price engagement not found' };
  }

  if (!validText(input?.title, 3, 160)) {
    return { error: 'Milestone title must be between 3 and 160 characters' };
  }

  if (
    input.description != null &&
    !validText(input.description, 1, 5000)
  ) {
    return { error: 'Invalid milestone description' };
  }

  if (!validMinorAmount(input.amount_minor)) {
    return { error: 'A valid milestone amount is required' };
  }

  const totals = await db.prepare(`
    SELECT COALESCE(SUM(amount_minor), 0) AS total
    FROM work_milestones
    WHERE engagement_id = ?
      AND status <> 'cancelled'
  `).bind(engagementId).first();

  if (
    Number(totals?.total || 0) + input.amount_minor >
    engagement.agreed_fixed_amount_minor
  ) {
    return { error: 'Milestone amounts cannot exceed the agreed engagement amount' };
  }

  const dueAt = input.due_at ?? null;

  if (dueAt && (!Number.isFinite(Date.parse(dueAt)) || Date.parse(dueAt) <= Date.now())) {
    return { error: 'Milestone due date must be a valid future date' };
  }

  const position = await db.prepare(`
    SELECT COALESCE(MAX(position), 0) + 1 AS next_position
    FROM work_milestones
    WHERE engagement_id = ?
  `).bind(engagementId).first();

  const id = newId();
  const now = nowISO();

  await db.prepare(`
    INSERT INTO work_milestones (
      id, engagement_id, title, description,
      amount_minor, due_at, position, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    engagementId,
    input.title.trim(),
    input.description?.trim() || null,
    input.amount_minor,
    dueAt,
    position.next_position,
    now,
    now,
  ).run();

  return { success: true, milestone_id: id };
}


// ── WORK SUBMISSIONS ──────────────────────────────────────────

async function canUserDeliverForEngagement(engagement, userId, db) {
  if (
    engagement.provider_type === 'individual' &&
    engagement.provider_user_id === userId
  ) {
    return true;
  }

  if (engagement.provider_type === 'crew') {
    const participant = await db.prepare(`
      SELECT id
      FROM work_engagement_participants
      WHERE engagement_id = ?
        AND user_id = ?
        AND status = 'accepted'
    `).bind(engagement.id, userId).first();

    if (!participant) return false;

    return !!(await getActiveMembership(
      engagement.provider_crew_id,
      userId,
      db,
    ));
  }

  return false;
}

export async function submitWorkDeliverable(
  engagementId,
  submittingUserId,
  input,
  db,
) {
  const engagement = await db.prepare(`
    SELECT *
    FROM work_engagements
    WHERE id = ?
      AND status IN ('active', 'revision_requested')
      AND pricing_model = 'fixed'
  `).bind(engagementId).first();

  if (!engagement) return { error: 'Active fixed-price engagement not found' };

  if (!(await canUserDeliverForEngagement(engagement, submittingUserId, db))) {
    return { error: 'You are not an accepted provider on this engagement' };
  }

  if (!validText(input?.message, 5, 12000)) {
    return { error: 'Submission message must be between 5 and 12,000 characters' };
  }

  const milestoneId = input.milestone_id ?? null;

  if (milestoneId) {
    const milestone = await db.prepare(`
      SELECT id, status
      FROM work_milestones
      WHERE id = ?
        AND engagement_id = ?
    `).bind(milestoneId, engagementId).first();

    if (!milestone) return { error: 'Milestone not found' };

    if (!['pending', 'in_progress', 'revision_requested'].includes(milestone.status)) {
      return { error: 'This milestone is not accepting submissions' };
    }
  }

  const id = newId();
  const now = nowISO();

  const statements = [
    db.prepare(`
      INSERT INTO work_submissions (
        id, engagement_id, milestone_id,
        submitted_by_user_id, message, status, submitted_at
      )
      VALUES (?, ?, ?, ?, ?, 'submitted', ?)
    `).bind(
      id,
      engagementId,
      milestoneId,
      submittingUserId,
      input.message.trim(),
      now,
    ),
    db.prepare(`
      UPDATE work_engagements
      SET status = 'submitted', updated_at = ?
      WHERE id = ?
        AND status IN ('active', 'revision_requested')
    `).bind(now, engagementId),
  ];

  if (milestoneId) {
    statements.push(db.prepare(`
      UPDATE work_milestones
      SET status = 'submitted', updated_at = ?
      WHERE id = ?
    `).bind(now, milestoneId));
  }

  await db.batch(statements);

  return { success: true, submission_id: id };
}


// ── CLIENT SUBMISSION REVIEW ──────────────────────────────────

export async function reviewWorkSubmission(
  submissionId,
  clientUserId,
  decision,
  message,
  db,
) {
  if (!['approve', 'request_revision', 'reject'].includes(decision)) {
    return { error: 'Invalid submission decision' };
  }

  if (
    decision === 'request_revision' &&
    !validText(message, 3, 5000)
  ) {
    return { error: 'A revision explanation is required' };
  }

  const submission = await db.prepare(`
    SELECT
      s.*,
      e.client_user_id,
      e.id AS engagement_id,
      e.status AS engagement_status
    FROM work_submissions s
    JOIN work_engagements e ON e.id = s.engagement_id
    WHERE s.id = ?
  `).bind(submissionId).first();

  if (!submission) return { error: 'Submission not found' };

  if (submission.client_user_id !== clientUserId) {
    return { error: 'Only the client can review this submission' };
  }

  if (submission.status !== 'submitted') {
    return { error: 'This submission has already been reviewed' };
  }

  const now = nowISO();

  const submissionStatus = decision === 'approve'
    ? 'approved'
    : decision === 'request_revision'
      ? 'revision_requested'
      : 'rejected';

  const engagementStatus = decision === 'approve'
    ? 'active'
    : decision === 'request_revision'
      ? 'revision_requested'
      : 'disputed';

  const statements = [
    db.prepare(`
      UPDATE work_submissions
      SET status = ?,
          reviewed_at = ?,
          reviewed_by_user_id = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(
      submissionStatus,
      now,
      clientUserId,
      submissionId,
    ),
    db.prepare(`
      UPDATE work_engagements
      SET status = ?, updated_at = ?
      WHERE id = ?
        AND status = 'submitted'
    `).bind(
      engagementStatus,
      now,
      submission.engagement_id,
    ),
  ];

  if (submission.milestone_id) {
    const milestoneStatus = decision === 'approve'
      ? 'approved'
      : decision === 'request_revision'
        ? 'revision_requested'
        : 'cancelled';

    statements.push(db.prepare(`
      UPDATE work_milestones
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).bind(milestoneStatus, now, submission.milestone_id));
  }

  if (decision === 'approve' && !submission.milestone_id) {
    statements.push(db.prepare(`
      UPDATE work_engagements
      SET status = 'completed',
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).bind(now, now, submission.engagement_id));
  }

  if (decision === 'request_revision') {
    statements.push(db.prepare(`
      INSERT INTO work_submission_revisions (
        id, submission_id, author_user_id, message, created_at
      )
      VALUES (?, ?, ?, ?, ?)
    `).bind(
      newId(),
      submissionId,
      clientUserId,
      message.trim(),
      now,
    ));
  }

  await db.batch(statements);

  return {
    success: true,
    submission_id: submissionId,
    status: submissionStatus,
  };
}


// ── HOURLY TIME ENTRIES ───────────────────────────────────────

export async function submitWorkTimeEntry(
  engagementId,
  submittingUserId,
  input,
  db,
) {
  const engagement = await db.prepare(`
    SELECT *
    FROM work_engagements
    WHERE id = ?
      AND status = 'active'
      AND pricing_model = 'hourly'
  `).bind(engagementId).first();

  if (!engagement) return { error: 'Active hourly engagement not found' };

  if (!(await canUserDeliverForEngagement(engagement, submittingUserId, db))) {
    return { error: 'You are not an accepted provider on this engagement' };
  }

  if (!validText(input?.description, 5, 2000)) {
    return { error: 'Time entry description must be between 5 and 2,000 characters' };
  }

  const start = Date.parse(input.started_at);
  const end = Date.parse(input.ended_at);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start
  ) {
    return { error: 'Valid start and end timestamps are required' };
  }

  const durationMinutes = Math.round((end - start) / 60000);

  if (durationMinutes < 1) {
    return { error: 'Time entry must be at least one minute' };
  }

  const existing = await db.prepare(`
    SELECT id
    FROM work_time_entries
    WHERE engagement_id = ?
      AND user_id = ?
      AND status <> 'rejected'
      AND started_at < ?
      AND ended_at > ?
    LIMIT 1
  `).bind(
    engagementId,
    submittingUserId,
    new Date(end).toISOString(),
    new Date(start).toISOString(),
  ).first();

  if (existing) {
    return { error: 'This time entry overlaps an existing entry' };
  }

  const used = await db.prepare(`
    SELECT COALESCE(SUM(duration_minutes), 0) AS minutes
    FROM work_time_entries
    WHERE engagement_id = ?
      AND status IN ('submitted', 'approved', 'disputed')
  `).bind(engagementId).first();

  const alreadyUsedMinor =
    Math.ceil(Number(used?.minutes || 0) * engagement.agreed_hourly_rate_minor / 60);

  const proposedMinor =
    Math.ceil(durationMinutes * engagement.agreed_hourly_rate_minor / 60);

  if (
    alreadyUsedMinor + proposedMinor >
    engagement.agreed_spending_limit_minor
  ) {
    return { error: 'This time entry would exceed the agreed spending limit' };
  }

  const id = newId();

  await db.prepare(`
    INSERT INTO work_time_entries (
      id, engagement_id, user_id, description,
      started_at, ended_at, duration_minutes,
      status, submitted_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'submitted', ?)
  `).bind(
    id,
    engagementId,
    submittingUserId,
    input.description.trim(),
    new Date(start).toISOString(),
    new Date(end).toISOString(),
    durationMinutes,
    nowISO(),
  ).run();

  return {
    success: true,
    time_entry_id: id,
    duration_minutes: durationMinutes,
    status: 'submitted',
  };
}


// ── CLIENT TIME ENTRY REVIEW ──────────────────────────────────

export async function reviewWorkTimeEntry(
  timeEntryId,
  clientUserId,
  decision,
  db,
) {
  if (!['approve', 'reject', 'dispute'].includes(decision)) {
    return { error: 'Invalid time entry decision' };
  }

  const entry = await db.prepare(`
    SELECT
      t.*,
      e.client_user_id,
      e.id AS engagement_id,
      e.agreed_hourly_rate_minor,
      e.agreed_spending_limit_minor
    FROM work_time_entries t
    JOIN work_engagements e ON e.id = t.engagement_id
    WHERE t.id = ?
  `).bind(timeEntryId).first();

  if (!entry) return { error: 'Time entry not found' };

  if (entry.client_user_id !== clientUserId) {
    return { error: 'Only the client can review time entries' };
  }

  if (entry.status !== 'submitted') {
    return { error: 'This time entry has already been reviewed' };
  }

  if (decision === 'approve') {
    const approved = await db.prepare(`
      SELECT COALESCE(SUM(duration_minutes), 0) AS minutes
      FROM work_time_entries
      WHERE engagement_id = ?
        AND status = 'approved'
    `).bind(entry.engagement_id).first();

    const approvedMinor = Math.ceil(
      Number(approved?.minutes || 0) *
      entry.agreed_hourly_rate_minor / 60,
    );

    const entryMinor = Math.ceil(
      entry.duration_minutes *
      entry.agreed_hourly_rate_minor / 60,
    );

    if (approvedMinor + entryMinor > entry.agreed_spending_limit_minor) {
      return { error: 'Approval would exceed the agreed spending limit' };
    }
  }

  const status = decision === 'approve'
    ? 'approved'
    : decision === 'dispute'
      ? 'disputed'
      : 'rejected';

  const result = await db.prepare(`
    UPDATE work_time_entries
    SET status = ?,
        reviewed_at = ?,
        reviewed_by_user_id = ?
    WHERE id = ?
      AND status = 'submitted'
  `).bind(
    status,
    nowISO(),
    clientUserId,
    timeEntryId,
  ).run();

  if (!result.meta.changes) {
    return { error: 'Time entry review could not be recorded' };
  }

  return {
    success: true,
    time_entry_id: timeEntryId,
    status,
  };
}

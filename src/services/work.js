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
    return { error: 'Only active eligible Crew members can vote' };
  }

  const eligibleMembers = await getEligibleCrewMembers(
    application.applicant_crew_id,
    db,
  );

  const eligibleCount = eligibleMembers.length;

  if (!eligibleCount) {
    return { error: 'Crew has no eligible members' };
  }

  const eligibleIds = new Set(eligibleMembers.map(member => member.user_id));

  if (!eligibleIds.has(voterUserId)) {
    return { error: 'You are not eligible to vote on this proposal' };
  }

  const captain = membership.role === 'captain';
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
      MAX(is_captain_approval) AS captain_voted,
      MAX(
        CASE
          WHEN is_captain_approval = 1 AND vote = 'approve' THEN 1
          ELSE 0
        END
      ) AS captain_approved,
      MIN(eligible_member_count_snapshot) AS min_snapshot,
      MAX(eligible_member_count_snapshot) AS max_snapshot
    FROM work_crew_application_approvals
    WHERE application_id = ?
      AND crew_id = ?
  `).bind(applicationId, application.applicant_crew_id).first();

  const majorityApproved =
    Number(tally.approvals || 0) > eligibleCount / 2;

  const captainApproved = Number(tally.captain_approved || 0) === 1;

  const snapshotsConsistent =
    Number(tally.min_snapshot) === eligibleCount &&
    Number(tally.max_snapshot) === eligibleCount;

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

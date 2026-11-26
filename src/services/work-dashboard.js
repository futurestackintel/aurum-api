export async function getMyWork(userId, db) {
  const user = await db.prepare(`
    SELECT id FROM users
    WHERE id = ?
      AND account_deleted = 0
      AND deleted_at IS NULL
      AND is_suspended = 0
  `).bind(userId).first();

  if (!user) return { error: 'Active AURUM account required' };

  const opportunities = await db.prepare(`
    SELECT
      o.*,
      (
        SELECT COUNT(*)
        FROM work_applications a
        WHERE a.opportunity_id = o.id
        AND a.status NOT IN ('withdrawn', 'rejected')
      ) AS application_count
    FROM work_opportunities o
    WHERE o.client_user_id = ?
    ORDER BY o.updated_at DESC
    LIMIT 100
  `).bind(userId).all();

  const applications = await db.prepare(`
    SELECT
      a.*,
      o.title AS opportunity_title,
      o.currency,
      o.pricing_model,
      o.status AS opportunity_status,
      o.client_user_id,
      client.username AS client_username,
      client.display_name AS client_display_name
    FROM work_applications a
    JOIN work_opportunities o ON o.id = a.opportunity_id
    JOIN users client ON client.id = o.client_user_id
    WHERE (
      a.applicant_user_id = ?
      OR a.submitted_by_user_id = ?
      OR EXISTS (
        SELECT 1
        FROM crew_members cm
        JOIN users member ON member.id = cm.user_id
        WHERE cm.crew_id = a.applicant_crew_id
          AND cm.user_id = ?
          AND member.account_deleted = 0
          AND member.deleted_at IS NULL
          AND member.is_suspended = 0
      )
    )
    ORDER BY a.created_at DESC
    LIMIT 100
  `).bind(userId, userId, userId).all();

  const engagements = await db.prepare(`
    SELECT
      e.*,
      o.title AS opportunity_title,
      client.username AS client_username,
      client.display_name AS client_display_name,
      provider.username AS provider_username,
      provider.display_name AS provider_display_name,
      (
        SELECT COUNT(*)
        FROM work_engagement_participants p
        WHERE p.engagement_id = e.id
      ) AS participant_count,
      (
        SELECT COUNT(*)
        FROM work_engagement_participants p
        WHERE p.engagement_id = e.id
          AND p.status = 'accepted'
      ) AS accepted_participant_count
    FROM work_engagements e
    JOIN work_opportunities o ON o.id = e.opportunity_id
    JOIN users client ON client.id = e.client_user_id
    LEFT JOIN users provider ON provider.id = e.provider_user_id
    WHERE (
      e.client_user_id = ?
      OR e.provider_user_id = ?
      OR EXISTS (
        SELECT 1
        FROM work_engagement_participants p
        WHERE p.engagement_id = e.id
          AND p.user_id = ?
      )
      OR EXISTS (
        SELECT 1
        FROM crew_members cm
        JOIN users member ON member.id = cm.user_id
        WHERE cm.crew_id = e.provider_crew_id
          AND cm.user_id = ?
          AND member.account_deleted = 0
          AND member.deleted_at IS NULL
          AND member.is_suspended = 0
      )
    )
    ORDER BY e.updated_at DESC
    LIMIT 100
  `).bind(userId, userId, userId, userId).all();

  return {
    opportunities: opportunities.results || [],
    applications: applications.results || [],
    engagements: engagements.results || [],
  };
}

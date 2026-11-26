import {
  createWorkOpportunity,
  publishWorkOpportunity,
  getWorkOpportunity,
  listWorkOpportunities,
  submitIndividualWorkApplication,
  submitCrewWorkApplication,
  castCrewWorkApplicationVote,
  acceptCrewWorkApplicationRole,
  hireWorkApplication,
  acceptWorkEngagementRole,
  activateWorkEngagement,
  createWorkMilestone,
  submitWorkDeliverable,
  reviewWorkSubmission,
  submitWorkTimeEntry,
  reviewWorkTimeEntry,
  getWorkEngagementWorkspace,
  respondToWorkRevision,
  createWorkReview,
  listWorkReviews,
  openWorkDispute,
  addWorkDisputeMessage,
  getWorkDispute,
  getWorkDisputeAdmin,
  listWorkDisputesAdmin,
  setWorkDisputeUnderReview,
  resolveWorkDispute,
  listWorkApplications,
 updateWorkApplicationStatus,
 withdrawWorkApplication,
 addWorkDisputeAdminMessage,
 payWorkEngagement,
} from '../services/work.js';

import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getMyWork } from '../services/work-dashboard.js';

export async function handleWorkRoutes(path, method, request, env) {
  const db = env.DB;

  async function authenticatedUser() {
    const auth = await requireAuth(request, env);
    if (auth.error) return { response: json({ error: auth.error }, 401) };

    const user = await db.prepare(
      `SELECT id FROM users
       WHERE clerk_id = ?
         AND account_deleted = 0
         AND deleted_at IS NULL
         AND is_suspended = 0`
    ).bind(auth.id).first();

    if (!user) {
      return { response: json({ error: 'Active AURUM account required' }, 403) };
    }

    return { userId: user.id };
  }

  async function adminUser() {
    const auth = await requireAdmin(request, env);
    if (auth.error) return { response: json({ error: auth.error }, 403) };

    const user = await db.prepare(
      `SELECT id FROM users
       WHERE clerk_id = ?
         AND account_deleted = 0
         AND deleted_at IS NULL
         AND is_suspended = 0`
    ).bind(auth.id).first();

    if (!user) {
      return { response: json({ error: 'Admin account unavailable' }, 403) };
    }

    return { userId: user.id };
  }

  async function body() {
    try {
      return await request.json();
    } catch {
      return null;
    }
  }

  async function execute(action, successStatus = 200) {
    try {
      const result = await action();
      if (!result) return json({ error: 'Resource not found' }, 404);
      if (result.error) {
        const status = /not found|not available|unavailable/i.test(result.error)
          ? 404
          : 400;
        return json({ error: result.error }, status);
      }
      return json(result, successStatus);
    } catch (error) {
      console.error('[Work API]', error);
      return json({ error: 'Work request failed. Please try again.' }, 500);
    }
  }

  // --------------------------------------------------
  // PERSONAL WORK DASHBOARD
  // --------------------------------------------------

  if (path === '/api/work/my-work' && method === 'GET') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(() => getMyWork(auth.userId, db));
  }

  // --------------------------------------------------
  // OPPORTUNITIES
  // --------------------------------------------------

  if (path === '/api/work/opportunities' && method === 'GET') {
    const url = new URL(request.url);
    const auth = await requireAuth(request, env);
    let viewerUserId = null;

    if (!auth.error) {
      const user = await db.prepare(
        `SELECT id FROM users WHERE clerk_id = ?`
      ).bind(auth.id).first();
      viewerUserId = user?.id ?? null;
    }

    return execute(() => listWorkOpportunities({
      viewerUserId,
      category: url.searchParams.get('category'),
      pricingModel: url.searchParams.get('pricing_model'),
      eligibility: url.searchParams.get('eligibility'),
      currency: url.searchParams.get('currency'),
      search: url.searchParams.get('search'),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    }, db));
  }

  if (path === '/api/work/opportunities' && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => createWorkOpportunity(auth.userId, data, db),
      201,
    );
  }

  const opportunityMatch = path.match(/^\/api\/work\/opportunities\/([^/]+)$/);

  if (opportunityMatch && method === 'GET') {
    const auth = await requireAuth(request, env);
    let viewerId = null;

    if (!auth.error) {
      const user = await db.prepare(
        `SELECT id FROM users WHERE clerk_id = ?`
      ).bind(auth.id).first();
      viewerId = user?.id ?? null;
    }

    return execute(async () => {
      const opportunity = await getWorkOpportunity(
        opportunityMatch[1],
        viewerId,
        db,
      );
      return opportunity ? { opportunity } : null;
    });
  }

  const publishMatch = path.match(
    /^\/api\/work\/opportunities\/([^/]+)\/publish$/
  );

  if (publishMatch && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => publishWorkOpportunity(publishMatch[1], auth.userId, db),
    );
  }

	  const opportunityApplicationsMatch = path.match(
    /^\/api\/work\/opportunities\/([^/]+)\/applications$/
  );

  if (opportunityApplicationsMatch && method === 'GET') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const url = new URL(request.url);

    return execute(() => listWorkApplications(
      opportunityApplicationsMatch[1],
      auth.userId,
      {
        status: url.searchParams.get('status'),
        limit: url.searchParams.get('limit'),
        offset: url.searchParams.get('offset'),
      },
      db,
    ));
	}

  const individualApplicationMatch = path.match(
    /^\/api\/work\/opportunities\/([^/]+)\/applications$/
  );

  if (individualApplicationMatch && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => submitIndividualWorkApplication(
        individualApplicationMatch[1],
        auth.userId,
        data,
        db,
      ),
      201,
    );
  }

  const crewApplicationMatch = path.match(
    /^\/api\/work\/opportunities\/([^/]+)\/crew-applications$/
  );

  if (crewApplicationMatch && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => submitCrewWorkApplication(
        crewApplicationMatch[1],
        data.crew_id,
        auth.userId,
        data,
        db,
      ),
      201,
    );
  }

  // --------------------------------------------------
  // APPLICATIONS
  // --------------------------------------------------

  let match = path.match(
    /^\/api\/work\/applications\/([^/]+)\/vote$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => castCrewWorkApplicationVote(
        match[1],
        auth.userId,
        data.vote,
        db,
      ),
    );
  }

  match = path.match(
    /^\/api\/work\/applications\/([^/]+)\/accept-role$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => acceptCrewWorkApplicationRole(match[1], auth.userId, db),
    );
  }

  match = path.match(
    /^\/api\/work\/applications\/([^/]+)\/hire$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => hireWorkApplication(match[1], auth.userId, data, db),
      201,
    );
  }

	  // Update application status — opportunity owner only.
  let applicationStatusMatch = path.match(
    /^\/api\/work\/applications\/([^/]+)\/status$/
  );

  if (applicationStatusMatch && method === 'PATCH') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(() => updateWorkApplicationStatus(
      applicationStatusMatch[1],
      auth.userId,
      data.status,
      db,
    ));
  }

  // Withdraw an application — applicant or original Crew submitter.
  let applicationWithdrawMatch = path.match(
    /^\/api\/work\/applications\/([^/]+)\/withdraw$/
  );

  if (applicationWithdrawMatch && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(() => withdrawWorkApplication(
      applicationWithdrawMatch[1],
      auth.userId,
      db,
    ));
  }
	
  // --------------------------------------------------
  // ENGAGEMENTS
  // --------------------------------------------------

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/accept-role$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => acceptWorkEngagementRole(match[1], auth.userId, db),
    );
  }

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/activate$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => activateWorkEngagement(match[1], auth.userId, db),
    );
  }

      const workspaceMatch = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/workspace$/
  );

  if (workspaceMatch && method === 'GET') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => getWorkEngagementWorkspace(
        workspaceMatch[1],
        auth.userId,
        db,
      ),
    );
  }

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/pay$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => payWorkEngagement(match[1], auth.userId, db),
    );
  }
	
  if (match && method === 'GET') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => getWorkEngagementWorkspace(match[1], auth.userId, db),
    );
  }

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/milestones$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => createWorkMilestone(match[1], auth.userId, data, db),
      201,
    );
  }

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/deliverables$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => submitWorkDeliverable(match[1], auth.userId, data, db),
      201,
    );
  }

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/time-entries$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => submitWorkTimeEntry(match[1], auth.userId, data, db),
      201,
    );
  }

  // --------------------------------------------------
  // SUBMISSIONS AND TIME ENTRY REVIEWS
  // --------------------------------------------------

  match = path.match(
    /^\/api\/work\/submissions\/([^/]+)\/review$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => reviewWorkSubmission(
        match[1],
        auth.userId,
        data.decision,
        data.message,
        db,
      ),
    );
  }

  match = path.match(
    /^\/api\/work\/submissions\/([^/]+)\/revision-response$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => respondToWorkRevision(
        match[1],
        auth.userId,
        data.message,
        db,
      ),
      201,
    );
  }

  match = path.match(
    /^\/api\/work\/time-entries\/([^/]+)\/review$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => reviewWorkTimeEntry(
        match[1],
        auth.userId,
        data.decision,
        db,
      ),
    );
  }

  // --------------------------------------------------
  // REVIEWS
  // --------------------------------------------------

  if (path === '/api/work/reviews' && method === 'GET') {
    const url = new URL(request.url);

    return execute(() => listWorkReviews({
      userId: url.searchParams.get('user_id'),
      crewId: url.searchParams.get('crew_id'),
      limit: url.searchParams.get('limit'),
      offset: url.searchParams.get('offset'),
    }, db));
  }

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/reviews$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => createWorkReview(match[1], auth.userId, data, db),
      201,
    );
  }

  // --------------------------------------------------
  // DISPUTES
  // --------------------------------------------------

  match = path.match(
    /^\/api\/work\/engagements\/([^/]+)\/disputes$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => openWorkDispute(match[1], auth.userId, data, db),
      201,
    );
  }

  match = path.match(
    /^\/api\/work\/disputes\/([^/]+)$/
  );

  if (match && method === 'GET') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    return execute(
      () => getWorkDispute(match[1], auth.userId, db),
    );
  }

  match = path.match(
    /^\/api\/work\/disputes\/([^/]+)\/messages$/
  );

  if (match && method === 'POST') {
    const auth = await authenticatedUser();
    if (auth.response) return auth.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => addWorkDisputeMessage(
        match[1],
        auth.userId,
        data.message,
        db,
      ),
      201,
    );
  }

  // --------------------------------------------------
  // ADMIN DISPUTE MANAGEMENT
  // --------------------------------------------------

  if (path === '/api/admin/work/disputes' && method === 'GET') {
    const admin = await adminUser();
    if (admin.response) return admin.response;

    const url = new URL(request.url);

    return execute(() => listWorkDisputesAdmin(
      url.searchParams.get('status'),
      url.searchParams.get('limit'),
      url.searchParams.get('offset'),
      db,
    ));
  }

  match = path.match(
    /^\/api\/admin\/work\/disputes\/([^/]+)$/
  );

  if (match && method === 'GET') {
    const admin = await adminUser();
    if (admin.response) return admin.response;

    return execute(
      () => getWorkDisputeAdmin(match[1], db),
    );
  }	

  match = path.match(
    /^\/api\/admin\/work\/disputes\/([^/]+)\/under-review$/
  );

  if (match && method === 'POST') {
    const admin = await adminUser();
    if (admin.response) return admin.response;

    return execute(
      () => setWorkDisputeUnderReview(match[1], admin.userId, db),
    );
  }

  match = path.match(
    /^\/api\/admin\/work\/disputes\/([^/]+)\/messages$/
  );

  if (match && method === 'POST') {
    const admin = await adminUser();
    if (admin.response) return admin.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => addWorkDisputeAdminMessage(
        match[1],
        admin.userId,
        data.message,
        db,
      ),
      201,
    );
  }
	
  match = path.match(
    /^\/api\/admin\/work\/disputes\/([^/]+)\/resolve$/
  );

  if (match && method === 'POST') {
    const admin = await adminUser();
    if (admin.response) return admin.response;

    const data = await body();
    if (!data) return json({ error: 'Invalid JSON body' }, 400);

    return execute(
      () => resolveWorkDispute(
        match[1],
        admin.userId,
        data.resolution_summary,
        db,
      ),
    );
  }

  return null;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
    }

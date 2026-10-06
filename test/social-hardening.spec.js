import { env } from 'cloudflare:test';
import notificationMigration from '../migrations/0030_social_notification_types.sql?raw';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  requireAuth: vi.fn(async () => ({ id: 'clerk-hardening-viewer' })),
  optionalAuth: vi.fn(async () => ({ id: null })),
}));
vi.mock('../src/middleware/auth.js', async importOriginal => ({ ...await importOriginal(), ...auth }));

import { createComment } from '../src/services/comments.js';
import { handlePostCheer } from '../src/index.js';
import { handleSearchRoutes } from '../src/routes/search.js';
import { handleSocialRoutes } from '../src/routes/social.js';

const viewerId = 'social-hardening-viewer';
const viewerClerkId = 'clerk-hardening-viewer';
const searchTerm = 'social_privacy_hardening_marker';

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, clerk_id TEXT, username TEXT, display_name TEXT, email TEXT,
    league TEXT, aurum_score INTEGER DEFAULT 0, hide_aurum_score INTEGER DEFAULT 0,
    hide_league INTEGER DEFAULT 0, avatar_url TEXT, profile_visibility TEXT DEFAULT 'public',
    stealth_mode INTEGER DEFAULT 0, is_suspended INTEGER DEFAULT 0,
    account_deleted INTEGER DEFAULT 0, deleted_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS crews (
    id TEXT PRIMARY KEY, name TEXT, description TEXT, member_count INTEGER,
    is_locked INTEGER DEFAULT 0, is_frozen INTEGER DEFAULT 0
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY, user_id TEXT, content TEXT, created_at TEXT,
    visibility TEXT, moderation_status TEXT, deleted_at TEXT
  )`).run();

  const fixtures = [
    [viewerId, viewerClerkId, 'hardening_viewer', 'Hardening Viewer', 'hardening-viewer@test.invalid', 'public', 0],
    ['social-hardening-public', null, 'hardening_public', 'Public Author', 'hardening-public@test.invalid', 'public', 0],
    ['social-hardening-private', null, 'hardening_private', 'Private Author', 'hardening-private@test.invalid', 'private', 0],
    ['social-hardening-stealth', null, 'hardening_stealth', 'Stealth Author', 'hardening-stealth@test.invalid', 'public', 1],
  ];
  for (const [id, clerkId, username, displayName, email, visibility, stealth] of fixtures) {
    await env.DB.prepare(`INSERT INTO users (
      id, clerk_id, username, display_name, email, league, profile_visibility, stealth_mode
    ) VALUES (?, ?, ?, ?, ?, 'gold', ?, ?) ON CONFLICT(id) DO NOTHING`)
      .bind(id, clerkId, username, displayName, email, visibility, stealth).run();
  }
  for (const [id, authorId] of [
    ['social-hardening-public-post', 'social-hardening-public'],
    ['social-hardening-private-post', 'social-hardening-private'],
    ['social-hardening-stealth-post', 'social-hardening-stealth'],
  ]) {
    await env.DB.prepare(`INSERT INTO posts (
      id, user_id, content, created_at, visibility, moderation_status
    ) VALUES (?, ?, ?, ?, 'public', 'active') ON CONFLICT(id) DO NOTHING`)
      .bind(id, authorId, `Public matching ${searchTerm}`, new Date().toISOString()).run();
  }
});

function interactionDb({ activeUser = true } = {}) {
  const statements = [];
  return {
    statements,
    prepare(sql) {
      statements.push(sql);
      return { bind() { return {
        async first() {
          if (sql.includes('FROM users')) return activeUser ? { id: 'actor-id', league: 'gold' } : null;
          if (sql.includes('FROM posts p')) return null;
          throw new Error(`Unexpected query: ${sql}`);
        },
        async run() { return { meta: { changes: 1 } }; },
      }; } };
    },
  };
}

describe('social authorization and privacy hardening', () => {
  it('rejects comments on posts the commenter cannot view', async () => {
    const db = interactionDb();
    const result = await createComment('private-post', 'clerk-commenter', { content: 'Hello' }, db);
    expect(result).toEqual({ error: 'Post not found' });
    expect(db.statements.some(sql => sql.includes('INSERT INTO post_comments'))).toBe(false);
  });

  it('rejects Cheer on posts the viewer cannot view', async () => {
    auth.requireAuth.mockResolvedValue({ id: viewerClerkId });
    const db = interactionDb();
    const response = await handlePostCheer('private-post', new Request('https://aurum.test/api/posts/private-post/cheer', { method: 'POST' }), { DB: db });
    expect(response.status).toBe(404);
    expect(db.statements.some(sql => sql.includes('INSERT INTO post_cheers'))).toBe(false);
  });

  it('rejects comments and Cheer for unavailable actors', async () => {
    const commentDb = interactionDb({ activeUser: false });
    expect(await createComment('public-post', 'clerk-disabled', { content: 'Hello' }, commentDb))
      .toEqual({ error: 'User not found' });
    expect(commentDb.statements).toHaveLength(1);
    expect(commentDb.statements[0]).toContain('account_deleted = 0');
    expect(commentDb.statements[0]).toContain('is_suspended = 0');

    auth.requireAuth.mockResolvedValue({ id: viewerClerkId });
    const cheerDb = interactionDb({ activeUser: false });
    const response = await handlePostCheer('public-post', new Request('https://aurum.test/api/posts/public-post/cheer', { method: 'POST' }), { DB: cheerDb });
    expect(response.status).toBe(404);
    expect(cheerDb.statements).toHaveLength(1);
    expect(cheerDb.statements[0]).toContain('deleted_at IS NULL');
    expect(cheerDb.statements[0]).toContain('is_suspended = 0');
  });

  it("omits private and stealth authors' posts from search", async () => {
    auth.requireAuth.mockResolvedValue({ id: viewerClerkId });
    const response = await handleSearchRoutes('/api/search', 'GET',
      new Request(`https://aurum.test/api/search?q=${searchTerm}`), { DB: env.DB });
    expect(response.status).toBe(200);
    const { posts } = await response.json();
    expect(posts.map(post => post.id)).toEqual(['social-hardening-public-post']);
  });

  it('reports self relationship state so the profile hides Follow for its owner', async () => {
    auth.optionalAuth.mockResolvedValue({ id: viewerClerkId });
    const db = {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() {
                if (sql.includes('SELECT id, username, is_suspended')) return { id: viewerId, username: 'hardening_viewer', is_suspended: 0 };
                if (sql.includes('SELECT id, profile_visibility')) return { id: viewerId, profile_visibility: 'public', stealth_mode: 0, is_suspended: 0 };
                if (sql.includes('CASE WHEN ? IS NULL')) return { following: 0, followers_count: 3, following_count: 4 };
                throw new Error(`Unexpected query: ${sql} ${values}`);
              },
            };
          },
        };
      },
    };
    const response = await handleSocialRoutes('/api/profiles/hardening_viewer/relationship', 'GET',
      new Request('https://aurum.test/api/profiles/hardening_viewer/relationship'), { DB: db });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ following: false, is_self: true, followers_count: 3, following_count: 4 });
  });

  it('attributes follower notifications and avoids duplicates on retries', async () => {
    auth.requireAuth.mockResolvedValue({ id: 'clerk-actual-follower' });
    const notifications = [];
    let following = false;
    const db = {
      prepare(sql) {
        return {
          bind(...values) {
            return {
              async first() {
                if (sql.includes('SELECT id, username, is_suspended')) return { id: 'actual-follower-id', username: 'actual_follower', is_suspended: 0 };
                if (sql.includes('SELECT id, profile_visibility')) return { id: 'recipient-id', profile_visibility: 'public', stealth_mode: 0, is_suspended: 0 };
                if (sql.includes('SELECT EXISTS')) return { following: following ? 1 : 0, followers_count: following ? 1 : 0, following_count: 0 };
                throw new Error(`Unexpected query: ${sql}`);
              },
              async run() {
                if (sql.includes('INSERT OR IGNORE INTO user_follows')) {
                  const changes = following ? 0 : 1;
                  following = true;
                  return { meta: { changes } };
                }
                if (sql.includes('INSERT INTO notifications')) notifications.push({ sql, values });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    };
    const request = () => new Request('https://aurum.test/api/users/recipient/follow', { method: 'POST' });
    await handleSocialRoutes('/api/users/recipient/follow', 'POST', request(), { DB: db });
    await handleSocialRoutes('/api/users/recipient/follow', 'POST', request(), { DB: db });
    expect(notifications).toHaveLength(1);
    expect(notifications[0].values[1]).toBe('recipient-id');
    expect(notifications[0].values[2]).toBe('@actual_follower started following you.');
    expect(notifications[0].values[3]).toBe('/app.html?profile=actual_follower');
  });

  it('preserves existing notification rows and indexes in a local 0030 migration test', async () => {
    await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('crew_mention', 'message_reaction', 'crew_join_request')),
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      action_url TEXT,
      metadata TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      read_at TEXT
    )`).run();
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body)
      VALUES ('social-migration-row-a', ?, 'crew_mention', 'Mention', 'Existing row A'),
             ('social-migration-row-b', ?, 'message_reaction', 'Reaction', 'Existing row B'),
             ('social-migration-row-c', ?, 'crew_join_request', 'Request', 'Existing row C')`)
      .bind(viewerId, viewerId, viewerId).run();

    for (const statement of notificationMigration.split(';').map(sql => sql.trim()).filter(Boolean)) {
      await env.DB.prepare(statement).run();
    }

    const preserved = await env.DB.prepare(`SELECT id, type FROM notifications
      WHERE id LIKE 'social-migration-row-%' ORDER BY id`).all();
    expect(preserved.results).toEqual([
      { id: 'social-migration-row-a', type: 'crew_mention' },
      { id: 'social-migration-row-b', type: 'message_reaction' },
      { id: 'social-migration-row-c', type: 'crew_join_request' },
    ]);
    await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, title, body)
      VALUES ('social-migration-new-type', ?, 'new_follower', 'New follower', 'New follower')`)
      .bind(viewerId).run();
    const indexes = await env.DB.prepare('PRAGMA index_list(notifications)').all();
    expect(indexes.results.map(index => index.name)).toContain('idx_notifications_user_unread');
    expect(indexes.results.map(index => index.name)).toContain('idx_notifications_user_all');
  });
});

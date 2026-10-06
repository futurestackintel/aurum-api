import { describe, expect, it } from 'vitest';
import { handleSocialRoutes } from '../src/routes/social.js';

function relationshipDb(profile) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT id, profile_visibility')) return profile;
              if (sql.includes('SELECT\n      CASE WHEN')) {
                return { following: values[0] == null ? 0 : 1, followers_count: 12, following_count: 8 };
              }
              throw new Error(`Unexpected query: ${sql}`);
            },
          };
        },
      };
    },
  };
}

describe('Phase 3 social relationship privacy', () => {
  it('returns public relationship counts to an unauthenticated viewer', async () => {
    const response = await handleSocialRoutes(
      '/api/profiles/alice/relationship',
      'GET',
      new Request('https://aurum.test/api/profiles/alice/relationship'),
      { DB: relationshipDb({ id: 'alice-id', profile_visibility: 'public', stealth_mode: 0, is_suspended: 0 }) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ following: false, is_self: false, followers_count: 12, following_count: 8 });
  });

  it('excludes members-only accounts from anonymous relationship lists', async () => {
    let listSql = '';
    let listBindings = null;
    const db = {
      prepare(sql) {
        if (sql.includes('FROM user_follows f JOIN users u')) listSql = sql;
        return {
          bind(...values) {
            if (sql === listSql) listBindings = values;
            return {
              async first() {
                if (sql.includes('SELECT id, profile_visibility')) return { id: 'alice-id', profile_visibility: 'public', stealth_mode: 0, is_suspended: 0 };
                throw new Error(`Unexpected query: ${sql}`);
              },
              async all() { return { results: [] }; },
            };
          },
        };
      },
    };
    const response = await handleSocialRoutes(
      '/api/profiles/alice/followers', 'GET',
      new Request('https://aurum.test/api/profiles/alice/followers'), { DB: db },
    );

    expect(response.status).toBe(200);
    expect(listSql).toContain("COALESCE(u.profile_visibility, 'members') = 'public' OR ? IS NOT NULL");
    expect(listBindings).toEqual(['alice-id', null, 20, 0]);
  });
  it('does not disclose relationship counts for a private profile', async () => {
    const response = await handleSocialRoutes(
      '/api/profiles/alice/relationship',
      'GET',
      new Request('https://aurum.test/api/profiles/alice/relationship'),
      { DB: relationshipDb({ id: 'alice-id', profile_visibility: 'private', stealth_mode: 0, is_suspended: 0 }) },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Profile not found' });
  });
});

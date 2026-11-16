import { describe, expect, it } from 'vitest';
import { handleSocialRoutes } from '../src/routes/social.js';

function relationshipDb(profile) {
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT id, is_suspended')) return profile;

              if (sql.includes('SELECT\n      CASE WHEN')) {
                return {
                  following: values[0] == null ? 0 : 1,
                  followers_count: 12,
                  following_count: 8,
                };
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
      {
        DB: relationshipDb({
          id: 'alice-id',
          is_suspended: 0,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      following: false,
      is_self: false,
      followers_count: 12,
      following_count: 8,
    });
  });

  it('includes followers regardless of legacy profile flags', async () => {
    let listSql = '';
    let listBindings = null;

    const db = {
      prepare(sql) {
        if (sql.includes('FROM user_follows f JOIN users u')) {
          listSql = sql;
        }

        return {
          bind(...values) {
            if (sql === listSql) listBindings = values;

            return {
              async first() {
                if (sql.includes('SELECT id, is_suspended')) {
                  return { id: 'alice-id', is_suspended: 0 };
                }

                throw new Error(`Unexpected query: ${sql}`);
              },
              async all() {
                return { results: [] };
              },
            };
          },
        };
      },
    };

    const response = await handleSocialRoutes(
      '/api/profiles/alice/followers',
      'GET',
      new Request('https://aurum.test/api/profiles/alice/followers'),
      { DB: db },
    );

    expect(response.status).toBe(200);
    expect(listSql).not.toContain('profile_visibility');
    expect(listSql).not.toContain('stealth_mode');
    expect(listBindings).toEqual(['alice-id', 20, 0]);
  });

  it('returns relationship counts regardless of legacy private flags', async () => {
    const response = await handleSocialRoutes(
      '/api/profiles/alice/relationship',
      'GET',
      new Request('https://aurum.test/api/profiles/alice/relationship'),
      {
        DB: relationshipDb({
          id: 'alice-id',
          is_suspended: 0,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      following: false,
      is_self: false,
      followers_count: 12,
      following_count: 8,
    });
  });
});

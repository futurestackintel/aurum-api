
import { describe, it, expect } from 'vitest';
import { leaveCrew } from '../src/services/crew.js';

function createSuccessionDb({
  actorRole = 'captain',
  candidates = {},
} = {}) {
  const state = {
    batchCalls: [],
  };

  const actorMembership = {
    id: 'captain-membership',
    crew_id: 'crew-1',
    user_id: 'captain-id',
    role: actorRole,
  };

  const db = {
    prepare(sql) {
      return {
        sql,
        values: [],

        bind(...values) {
          this.values = values;
          return this;
        },

        async first() {
          if (sql.includes('SELECT id FROM users')) {
            return { id: 'captain-id' };
          }

          if (
            sql.includes('SELECT * FROM crew_members') &&
            sql.includes('WHERE user_id = ?')
          ) {
            return actorMembership;
          }

          if (sql.includes("role = 'vice_captain'")) {
            return candidates.vice_captain ?? null;
          }

          if (sql.includes("role = 'moderator'")) {
            return candidates.moderator ?? null;
          }

          if (sql.includes("role = 'member'")) {
            return candidates.member ?? null;
          }

          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },

    async batch(statements) {
      state.batchCalls.push(
        statements.map(statement => ({
          sql: statement.sql,
          values: statement.values,
        })),
      );
      return [];
    },
  };

  return { db, state };
}

describe('Crew leadership succession', () => {
  it('selects the Vice Captain before Moderators and Members', async () => {
    const { db, state } = createSuccessionDb({
      candidates: {
        vice_captain: {
          id: 'vice-membership',
          user_id: 'vice-id',
          role: 'vice_captain',
        },
        moderator: {
          id: 'moderator-membership',
          user_id: 'moderator-id',
          role: 'moderator',
        },
        member: {
          id: 'member-membership',
          user_id: 'member-id',
          role: 'member',
        },
      },
    });

    const result = await leaveCrew('clerk-captain', db);

    expect(result.new_captain_id).toBe('vice-id');
    expect(state.batchCalls).toHaveLength(1);

    const statements = state.batchCalls[0];
    const promotion = statements.find(statement =>
      statement.sql.includes("UPDATE crew_members SET role = 'captain'")
    );

    expect(promotion.values).toEqual(['vice-membership']);
  });

  it('selects a Moderator when no Vice Captain is available', async () => {
    const { db } = createSuccessionDb({
      candidates: {
        moderator: {
          id: 'moderator-membership',
          user_id: 'moderator-id',
          role: 'moderator',
        },
        member: {
          id: 'member-membership',
          user_id: 'member-id',
          role: 'member',
        },
      },
    });

    const result = await leaveCrew('clerk-captain', db);

    expect(result.new_captain_id).toBe('moderator-id');
  });

  it('selects an ordinary Member when no Vice Captain or Moderator is available', async () => {
    const { db } = createSuccessionDb({
      candidates: {
        member: {
          id: 'member-membership',
          user_id: 'member-id',
          role: 'member',
        },
      },
    });

    const result = await leaveCrew('clerk-captain', db);

    expect(result.new_captain_id).toBe('member-id');
  });

  it('leaves the crew empty when no eligible successor exists', async () => {
    const { db, state } = createSuccessionDb();

    const result = await leaveCrew('clerk-captain', db);

    expect(result.left).toBe(true);
    expect(result.note).toBe('Crew now has no members');

    const statements = state.batchCalls[0];

    expect(
      statements.some(statement =>
        statement.sql.includes('UPDATE crews SET member_count = 0')
      )
    ).toBe(true);

    expect(
      statements.some(statement =>
        statement.sql.includes('DELETE FROM crew_members')
      )
    ).toBe(true);
  });

  it('removes a departing Vice Captain delegation when they leave voluntarily', async () => {
    const { db, state } = createSuccessionDb({
      actorRole: 'vice_captain',
    });

    const result = await leaveCrew('clerk-captain', db);

    expect(result.left).toBe(true);

    const statements = state.batchCalls[0];

    expect(
      statements.some(statement =>
        statement.sql.includes('DELETE FROM crew_role_delegations')
      )
    ).toBe(true);
  });

  it('records the succession and removes old and successor Vice Captain delegations', async () => {
    const { db, state } = createSuccessionDb({
      candidates: {
        vice_captain: {
          id: 'vice-membership',
          user_id: 'vice-id',
          role: 'vice_captain',
        },
      },
    });

    const result = await leaveCrew('clerk-captain', db);

    expect(result.new_captain_id).toBe('vice-id');

    const statements = state.batchCalls[0];
    const history = statements.find(statement =>
      statement.sql.includes('INSERT INTO crew_governance_history')
    );

    expect(history).toBeDefined();
    expect(history.values[1]).toBe('crew-1');
    expect(history.values[2]).toBe('captain-id');
    expect(history.values[3]).toBe('vice-id');
    expect(history.values[4]).toBe('vice_captain');

    const delegationDeletes = statements.filter(statement =>
      statement.sql.includes('DELETE FROM crew_role_delegations')
    );

    expect(delegationDeletes).toHaveLength(2);
    expect(delegationDeletes[0].values).toEqual(['crew-1', 'captain-id']);
    expect(delegationDeletes[1].values).toEqual(['crew-1', 'vice-id']);
  });
});

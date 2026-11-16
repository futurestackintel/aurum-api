
import { describe, it, expect } from 'vitest';
import { setCrewMemberRole } from '../src/services/crew.js';

function createRoleDb({
  actorRole = 'captain',
  targetRole = 'member',
  existingRoleHolder = null,
} = {}) {
  const state = {
    actorRole,
    targetRole,
    existingRoleHolder,
    history: [],
    batchCalls: 0,
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
            return { id: 'actor-id' };
          }

          if (sql.includes('SELECT role FROM crew_members')) {
            return { role: state.actorRole };
          }

          if (sql.includes('SELECT id, role FROM crew_members')) {
            return {
              id: 'membership-id',
              role: state.targetRole,
            };
          }

          if (sql.includes('SELECT user_id') && sql.includes('role = ?')) {
            if (state.existingRoleHolder) {
              return { user_id: state.existingRoleHolder };
            }
            return null;
          }

          throw new Error(`Unexpected query: ${sql}`);
        },
      };
    },

    async batch(statements) {
      state.batchCalls++;

      for (const statement of statements) {
        if (statement.sql.includes('UPDATE crew_members')) {
          state.targetRole = statement.values[0];
        }

        if (statement.sql.includes('INSERT INTO crew_governance_history')) {
          state.history.push(statement.values);
        }
      }

      return [];
    },
  };

  return { db, state };
}

describe('Crew role management', () => {
  it('appoints a Vice Captain and records governance history', async () => {
    const { db, state } = createRoleDb();

    const result = await setCrewMemberRole(
      'crew-1',
      'clerk-captain',
      'target-id',
      'vice_captain',
      db,
    );

    expect(result.success).toBe(true);
    expect(result.role).toBe('vice_captain');
    expect(result.previous_role).toBe('member');
    expect(state.targetRole).toBe('vice_captain');
    expect(state.history).toHaveLength(1);
    expect(state.history[0][4]).toBe('role_appointed');
    expect(state.batchCalls).toBe(1);
  });

  it('returns a removed role holder to ordinary Member', async () => {
    const { db, state } = createRoleDb({
      targetRole: 'treasurer',
    });

    const result = await setCrewMemberRole(
      'crew-1',
      'clerk-captain',
      'target-id',
      'member',
      db,
    );

    expect(result.success).toBe(true);
    expect(result.previous_role).toBe('treasurer');
    expect(result.role).toBe('member');
    expect(state.targetRole).toBe('member');
    expect(state.history[0][4]).toBe('role_removed');
  });

  it('rejects role changes by anyone who is not Captain', async () => {
    const { db, state } = createRoleDb({
      actorRole: 'moderator',
    });

    const result = await setCrewMemberRole(
      'crew-1',
      'clerk-moderator',
      'target-id',
      'treasurer',
      db,
    );

    expect(result.error).toBe('Only the crew captain can manage crew roles');
    expect(state.batchCalls).toBe(0);
  });

  it('rejects appointing a second Treasurer', async () => {
    const { db, state } = createRoleDb({
      existingRoleHolder: 'another-user',
    });

    const result = await setCrewMemberRole(
      'crew-1',
      'clerk-captain',
      'target-id',
      'treasurer',
      db,
    );

    expect(result.error).toContain('already has a treasurer');
    expect(state.batchCalls).toBe(0);
  });

  it('rejects unsupported roles', async () => {
    const { db, state } = createRoleDb();

    const result = await setCrewMemberRole(
      'crew-1',
      'clerk-captain',
      'target-id',
      'owner',
      db,
    );

    expect(result.error).toBe('Invalid crew role');
    expect(state.batchCalls).toBe(0);
  });

  it('rejects changing the Captain role through member role management', async () => {
    const { db, state } = createRoleDb({
      targetRole: 'captain',
    });

    const result = await setCrewMemberRole(
      'crew-1',
      'clerk-captain',
      'target-id',
      'member',
      db,
    );

    expect(result.error).toBe(
      'The captain role cannot be changed through this action',
    );
    expect(state.batchCalls).toBe(0);
  });
});


import { describe, it, expect } from 'vitest';
import {
  inviteToCrew,
  getPendingJoinRequestsForCrew,
  kickMember,
  setCrewLocked,
  setCrewRules,
  muteMember,
  deleteCrewMessage,
} from '../src/services/crew.js';

function createPermissionDb({
  role = 'vice_captain',
  permission = null,
  targetExists = true,
} = {}) {
  const state = {
    updates: [],
    batches: [],
    delegationChecks: 0,
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
          if (sql.includes('SELECT id FROM users WHERE clerk_id')) {
            return { id: 'actor-id' };
          }

if (sql.replace(/\s+/g, ' ').includes('SELECT role FROM crew_members')) { 
	 const userId = this.values[1];

            if (userId === 'actor-id') return { role };
            return targetExists ? { role: 'member' } : null;
          }

          if (sql.includes('SELECT id FROM crew_role_delegations')) {
            state.delegationChecks++;
            return permission === this.values[2]
              ? { id: 'delegation-id' }
              : null;
          }

          if (sql.includes('SELECT crew_id, deleted_at FROM crew_messages')) {
            return { crew_id: 'crew-1', deleted_at: null };
          }

          if (sql.includes('SELECT * FROM crew_members')) {
            return targetExists
              ? { id: 'target-membership', role: 'member' }
              : null;
          }

          if (sql.includes('SELECT name FROM crews')) {
            return { name: 'Test Crew' };
          }

          throw new Error(`Unexpected first() query: ${sql}`);
        },

        async all() {
          if (sql.includes('FROM crew_join_requests')) {
            return { results: [] };
          }

          throw new Error(`Unexpected all() query: ${sql}`);
        },

        async run() {
          state.updates.push({ sql, values: this.values });
          return { meta: { changes: 1 } };
        },
      };
    },

    async batch(statements) {
      state.batches.push(statements);
      return [];
    },
  };

  return { db, state };
}

describe('Vice Captain delegated permission enforcement', () => {
  it('denies a Vice Captain without manage_invites', async () => {
    const { db } = createPermissionDb();

    const result = await inviteToCrew('crew-1', 'clerk-actor', '', db);

    expect(result.error).toBe(
      'You do not have permission to send crew invites',
    );
  });

  it('allows a Vice Captain with manage_invites to reach invite validation', async () => {
    const { db } = createPermissionDb({ permission: 'manage_invites' });

    const result = await inviteToCrew('crew-1', 'clerk-actor', '', db);

    expect(result.error).toBe('target_username is required');
  });

  it('denies a Vice Captain without manage_join_requests', async () => {
    const { db } = createPermissionDb();

    const result = await getPendingJoinRequestsForCrew(
      'crew-1',
      'clerk-actor',
      db,
    );

    expect(result.error).toBe(
      'You do not have permission to view join requests',
    );
  });

  it('allows a Vice Captain with manage_join_requests to view requests', async () => {
    const { db } = createPermissionDb({
      permission: 'manage_join_requests',
    });

    const result = await getPendingJoinRequestsForCrew(
      'crew-1',
      'clerk-actor',
      db,
    );

    expect(result.requests).toEqual([]);
  });

  it('denies a Vice Captain without remove_members', async () => {
    const { db } = createPermissionDb();

    const result = await kickMember(
      'crew-1',
      'clerk-actor',
      'another-user',
      db,
    );

    expect(result.error).toBe(
      'You do not have permission to remove crew members',
    );
  });

  it('allows a Vice Captain with remove_members to reach removal safeguards', async () => {
    const { db } = createPermissionDb({
      permission: 'remove_members',
    });

    const result = await kickMember(
      'crew-1',
      'clerk-actor',
      'actor-id',
      db,
    );

    expect(result.error).toBe('Use leave-crew to remove yourself');
  });

  it('denies a Vice Captain without manage_crew_lock', async () => {
    const { db } = createPermissionDb();

    const result = await setCrewLocked(
      'crew-1',
      'clerk-actor',
      true,
      db,
    );

    expect(result.error).toBe(
      'You do not have permission to lock or unlock this crew',
    );
  });

  it('allows a Vice Captain with manage_crew_lock', async () => {
    const { db } = createPermissionDb({
      permission: 'manage_crew_lock',
    });

    const result = await setCrewLocked(
      'crew-1',
      'clerk-actor',
      true,
      db,
    );

    expect(result).toEqual({
      crew_id: 'crew-1',
      is_locked: true,
    });
  });

  it('denies a Vice Captain without edit_crew_rules', async () => {
    const { db } = createPermissionDb();

    const result = await setCrewRules(
      'crew-1',
      'clerk-actor',
      'Updated rules',
      db,
    );

    expect(result.error).toBe(
      'You do not have permission to edit crew rules',
    );
  });

  it('allows a Vice Captain with edit_crew_rules', async () => {
    const { db } = createPermissionDb({
      permission: 'edit_crew_rules',
    });

    const result = await setCrewRules(
      'crew-1',
      'clerk-actor',
      '  Updated rules  ',
      db,
    );

    expect(result.rules).toBe('Updated rules');
  });

  it('denies a Vice Captain without moderate_discussions', async () => {
    const { db } = createPermissionDb();

    const result = await deleteCrewMessage(
      'message-1',
      'clerk-actor',
      db,
    );

    expect(result.error).toBe(
      'You do not have permission to delete crew messages',
    );
  });

  it('allows a Vice Captain with moderate_discussions to delete a message', async () => {
    const { db } = createPermissionDb({
      permission: 'moderate_discussions',
    });

    const result = await deleteCrewMessage(
      'message-1',
      'clerk-actor',
      db,
    );

    expect(result).toEqual({
      deleted: true,
      message_id: 'message-1',
    });
  });

  it('preserves Moderator moderation access without a delegation', async () => {
    const { db, state } = createPermissionDb({
      role: 'moderator',
    });

    const result = await muteMember(
      'crew-1',
      'clerk-actor',
      'target-id',
      2,
      'Test moderation reason',
      db,
    );

    expect(result.mute).toBeDefined();
    expect(state.delegationChecks).toBe(0);
  });
});

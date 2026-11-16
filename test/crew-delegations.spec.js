
import { describe, it, expect } from 'vitest';
import {
  getCrewRoleDelegations,
  grantCrewRoleDelegation,
  revokeCrewRoleDelegation,
} from '../src/services/crew.js';

function createDelegationDb({
  actorRole = 'captain',
  targetRole = 'vice_captain',
  delegations = [],
} = {}) {
  const state = {
    memberships: new Map([
      ['captain-id', actorRole],
      ['vice-id', targetRole],
    ]),
    delegations: delegations.map(item => ({ ...item })),
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
            const clerkId = this.values[0];
            if (clerkId === 'clerk-captain') return { id: 'captain-id' };
            if (clerkId === 'clerk-member') return { id: 'member-id' };
            return null;
          }

          if (sql.includes('SELECT role FROM crew_members')) {
            const [, userId] = this.values;
            const role = state.memberships.get(userId);
            return role ? { role } : null;
          }

          throw new Error(`Unexpected first() query: ${sql}`);
        },

        async all() {
          if (sql.includes('FROM crew_role_delegations')) {
            return {
              results: state.delegations
                .filter(item => item.crew_id === this.values[0])
                .map(item => ({
                  ...item,
                  username: item.vice_captain_user_id === 'vice-id'
                    ? 'vicecaptain'
                    : 'anotheruser',
                })),
            };
          }

          throw new Error(`Unexpected all() query: ${sql}`);
        },

        async run() {
          if (sql.includes('INSERT INTO crew_role_delegations')) {
            const [
              id,
              crewId,
              viceCaptainUserId,
              permission,
              grantedByUserId,
              createdAt,
            ] = this.values;

            const duplicate = state.delegations.some(item =>
              item.crew_id === crewId &&
              item.vice_captain_user_id === viceCaptainUserId &&
              item.permission === permission
            );

            if (duplicate) {
              throw new Error('UNIQUE constraint failed');
            }

            state.delegations.push({
              id,
              crew_id: crewId,
              vice_captain_user_id: viceCaptainUserId,
              permission,
              granted_by_user_id: grantedByUserId,
              created_at: createdAt,
            });

            return { meta: { changes: 1 } };
          }

          if (sql.includes('DELETE FROM crew_role_delegations')) {
            const [crewId, viceCaptainUserId, permission] = this.values;
            const previousLength = state.delegations.length;

            state.delegations = state.delegations.filter(item =>
              !(
                item.crew_id === crewId &&
                item.vice_captain_user_id === viceCaptainUserId &&
                item.permission === permission
              )
            );

            return {
              meta: { changes: previousLength - state.delegations.length },
            };
          }

          throw new Error(`Unexpected run() query: ${sql}`);
        },
      };
    },
  };

  return { db, state };
}

describe('Vice Captain permission delegations', () => {
  it('allows the Captain to list crew delegations', async () => {
    const { db } = createDelegationDb({
      delegations: [{
        id: 'delegation-1',
        crew_id: 'crew-1',
        vice_captain_user_id: 'vice-id',
        permission: 'manage_invites',
        granted_by_user_id: 'captain-id',
        created_at: '2026-11-16T00:00:00.000Z',
      }],
    });

    const result = await getCrewRoleDelegations(
      'crew-1',
      'clerk-captain',
      db,
    );

    expect(result.delegations).toHaveLength(1);
    expect(result.delegations[0].permission).toBe('manage_invites');
    expect(result.delegations[0].username).toBe('vicecaptain');
  });

  it('denies delegation listing to non-Captains', async () => {
    const { db } = createDelegationDb({
      actorRole: 'moderator',
    });

    const result = await getCrewRoleDelegations(
      'crew-1',
      'clerk-captain',
      db,
    );

    expect(result.error).toBe(
      'Only the crew captain can view role delegations',
    );
  });

  it('allows the Captain to grant an approved permission to the Vice Captain', async () => {
    const { db, state } = createDelegationDb();

    const result = await grantCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result.success).toBe(true);
    expect(result.delegation.permission).toBe('manage_invites');
    expect(state.delegations).toHaveLength(1);
    expect(state.delegations[0].granted_by_user_id).toBe('captain-id');
  });

  it('rejects grants by non-Captains', async () => {
    const { db, state } = createDelegationDb({
      actorRole: 'moderator',
    });

    const result = await grantCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result.error).toBe(
      'Only the crew captain can grant permissions',
    );
    expect(state.delegations).toHaveLength(0);
  });

  it('rejects unsupported delegation permissions', async () => {
    const { db, state } = createDelegationDb();

    const result = await grantCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'disband_crew',
      db,
    );

    expect(result.error).toBe('Invalid delegation permission');
    expect(state.delegations).toHaveLength(0);
  });

  it('rejects grants to anyone who is not the current Vice Captain', async () => {
    const { db, state } = createDelegationDb({
      targetRole: 'moderator',
    });

    const result = await grantCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result.error).toBe(
      'Delegations can only be granted to the current Vice Captain',
    );
    expect(state.delegations).toHaveLength(0);
  });

  it('rejects duplicate grants', async () => {
    const { db, state } = createDelegationDb({
      delegations: [{
        id: 'existing',
        crew_id: 'crew-1',
        vice_captain_user_id: 'vice-id',
        permission: 'manage_invites',
        granted_by_user_id: 'captain-id',
        created_at: '2026-11-16T00:00:00.000Z',
      }],
    });

    const result = await grantCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result.error).toBe('This permission has already been granted');
    expect(state.delegations).toHaveLength(1);
  });

  it('allows the Captain to revoke a delegation', async () => {
    const { db, state } = createDelegationDb({
      delegations: [{
        id: 'delegation-1',
        crew_id: 'crew-1',
        vice_captain_user_id: 'vice-id',
        permission: 'manage_invites',
        granted_by_user_id: 'captain-id',
        created_at: '2026-11-16T00:00:00.000Z',
      }],
    });

    const result = await revokeCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result).toEqual({ success: true, revoked: true });
    expect(state.delegations).toHaveLength(0);
  });

  it('denies revocation by non-Captains', async () => {
    const { db, state } = createDelegationDb({
      actorRole: 'moderator',
      delegations: [{
        id: 'delegation-1',
        crew_id: 'crew-1',
        vice_captain_user_id: 'vice-id',
        permission: 'manage_invites',
        granted_by_user_id: 'captain-id',
        created_at: '2026-11-16T00:00:00.000Z',
      }],
    });

    const result = await revokeCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result.error).toBe(
      'Only the crew captain can revoke permissions',
    );
    expect(state.delegations).toHaveLength(1);
  });

  it('returns an error when the requested delegation does not exist', async () => {
    const { db } = createDelegationDb();

    const result = await revokeCrewRoleDelegation(
      'crew-1',
      'clerk-captain',
      'vice-id',
      'manage_invites',
      db,
    );

    expect(result.error).toBe('Delegation not found');
  });
});

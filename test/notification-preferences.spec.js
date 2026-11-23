
import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('notification preference schema', () => {
  it('includes message and crew notification preferences', async () => {
    const result = await env.DB
      .prepare('PRAGMA table_info(notification_preferences)')
      .all();

    const columns = result.results.map(column => column.name);

    expect(columns).toContain('messages');
    expect(columns).toContain('crew_updates');
    expect(columns).toContain('tips_received');
    expect(columns).toContain('challenge_updates');
    expect(columns).toContain('duel_challenges');
    expect(columns).toContain('league_promotions');
    expect(columns).toContain('badge_awards');
    expect(columns).toContain('weekly_summary');
  });
});

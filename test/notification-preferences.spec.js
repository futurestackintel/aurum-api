import { env } from 'cloudflare:test';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import notificationPreferenceMigration from '../migrations/0028_add_message_crew_notification_preferences.sql?raw';

vi.mock('../src/middleware/auth.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    requireAuth: async () => ({ id: 'clerk-notification-preferences-test' }),
  };
});

import worker from '../src';

const clerkId = 'clerk-notification-preferences-test';
const userId = 'notification-preferences-test-user';

beforeAll(async () => {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    clerk_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE
  )`).run();

  await env.DB.prepare(`INSERT INTO users (id, clerk_id, username, display_name, email)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING`)
    .bind(userId, clerkId, 'notification_prefs_test', 'Notification Prefs Test', 'notification-prefs@test.invalid')
    .run();

  await env.DB.prepare('DROP TABLE IF EXISTS notification_preferences').run();
  await env.DB.prepare(`CREATE TABLE notification_preferences (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
    tips_received INTEGER NOT NULL DEFAULT 1,
    challenge_updates INTEGER NOT NULL DEFAULT 1,
    duel_challenges INTEGER NOT NULL DEFAULT 1,
    league_promotions INTEGER NOT NULL DEFAULT 1,
    badge_awards INTEGER NOT NULL DEFAULT 1,
    weekly_summary INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
  )`).run();

  await env.DB.prepare(`INSERT INTO notification_preferences (
    id, user_id, tips_received, challenge_updates, duel_challenges,
    league_promotions, badge_awards, weekly_summary
  ) VALUES (?, ?, 0, 0, 1, 0, 1, 0)`)
    .bind('notification-preferences-test-row', userId)
    .run();
});

describe('Phase 2B notification preference migration and API', () => {
  it('adds message preferences with defaults, preserves saved values, and accepts API updates', async () => {
    const statements = notificationPreferenceMigration
      .split(';')
      .map(statement => statement.trim())
      .filter(Boolean);

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      await env.DB.prepare(statement).run();
    }

    const columns = await env.DB.prepare('PRAGMA table_info(notification_preferences)').all();
    const columnNames = columns.results.map(column => column.name);
    expect(columnNames).toContain('messages');
    expect(columnNames).toContain('crew_updates');

    const beforeApiUpdate = await env.DB.prepare(`
      SELECT tips_received, challenge_updates, duel_challenges, league_promotions,
             badge_awards, weekly_summary, messages, crew_updates
      FROM notification_preferences WHERE user_id = ?
    `).bind(userId).first();
    expect(beforeApiUpdate).toEqual({
      tips_received: 0,
      challenge_updates: 0,
      duel_challenges: 1,
      league_promotions: 0,
      badge_awards: 1,
      weekly_summary: 0,
      messages: 1,
      crew_updates: 1,
    });

    const response = await worker.fetch(new Request('https://aurum.test/api/users/me/notifications', {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages: false, crew_updates: false }),
    }), env);

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.updated).toBe(true);
    expect(body.preferences.messages).toBe(0);
    expect(body.preferences.crew_updates).toBe(0);

    const persisted = await env.DB.prepare(`
      SELECT tips_received, challenge_updates, duel_challenges, league_promotions,
             badge_awards, weekly_summary, messages, crew_updates
      FROM notification_preferences WHERE user_id = ?
    `).bind(userId).first();
    expect(persisted).toEqual({
      tips_received: 0,
      challenge_updates: 0,
      duel_challenges: 1,
      league_promotions: 0,
      badge_awards: 1,
      weekly_summary: 0,
      messages: 0,
      crew_updates: 0,
    });
  });
});

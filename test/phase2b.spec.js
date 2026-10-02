import { env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src';
import { getOrCreateDmChannel } from '../src/services/dm.js';

async function createPrivacyFixtures() {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, clerk_id TEXT, username TEXT, display_name TEXT, email TEXT,
    league TEXT, aurum_score INTEGER, streak_current INTEGER, created_at TEXT,
    is_verified INTEGER, total_challenges_won INTEGER, total_tips_sent_cents INTEGER,
    hide_aurum_score INTEGER, hide_league INTEGER, profile_visibility TEXT,
    avatar_url TEXT, stealth_mode INTEGER, is_suspended INTEGER,
    account_deleted INTEGER, deleted_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS badges (
    user_id TEXT, badge_type TEXT, is_public INTEGER, revoked_at TEXT, verified_at TEXT
  )`).run();
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
    id TEXT PRIMARY KEY, rank INTEGER, display_name TEXT, score REAL,
    league_at_snapshot TEXT, board_type TEXT, period TEXT, period_key TEXT,
    user_id TEXT, avatar_url TEXT, league TEXT
  )`).run();

  const hiddenId = crypto.randomUUID();
  const visibleId = crypto.randomUUID();
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();
  const insertUser = env.DB.prepare(`INSERT INTO users (
    id, username, display_name, email, league, aurum_score, streak_current,
    created_at, is_verified, total_challenges_won, total_tips_sent_cents,
    hide_aurum_score, hide_league, profile_visibility, stealth_mode,
    is_suspended, account_deleted
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'public', 0, 0, 0)`);
  await env.DB.batch([
    insertUser.bind(hiddenId, `hidden_${hiddenId}`, 'Hidden', `${hiddenId}@test.invalid`, 'gold', 900, 4, now, 0, 0, 0, 1, 1),
    insertUser.bind(visibleId, `visible_${visibleId}`, 'Visible', `${visibleId}@test.invalid`, 'silver', 500, 2, now, 0, 0, 0, 0, 1),
  ]);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO leaderboard_snapshots
      (id, rank, display_name, score, league_at_snapshot, board_type, period, period_key, user_id)
      VALUES (?, 1, 'Hidden', 900, 'gold', 'aurum_score', 'daily', ?, ?)`)
      .bind(crypto.randomUUID(), today, hiddenId),
    env.DB.prepare(`INSERT INTO leaderboard_snapshots
      (id, rank, display_name, score, league_at_snapshot, board_type, period, period_key, user_id)
      VALUES (?, 2, 'Visible', 500, 'silver', 'aurum_score', 'daily', ?, ?)`)
      .bind(crypto.randomUUID(), today, visibleId),
    env.DB.prepare(`INSERT INTO leaderboard_snapshots
      (id, rank, display_name, score, league_at_snapshot, board_type, period, period_key, user_id)
      VALUES (?, 1, 'Hidden', 10, 'gold', 'most_generous', 'daily', ?, ?)`)
      .bind(crypto.randomUUID(), today, hiddenId),
  ]);
  return { hiddenId, today };
}

describe('Phase 2B score privacy', () => {
  it('hides score rank from passport and current public leaderboard responses', async () => {
    const { hiddenId } = await createPrivacyFixtures();
    const user = await env.DB.prepare('SELECT username FROM users WHERE id = ?').bind(hiddenId).first();

    const passportResponse = await worker.fetch(
      new Request(`https://aurum.test/api/passport/${encodeURIComponent(user.username)}`),
      env,
    );
    expect(passportResponse.status).toBe(200);
    const passport = await passportResponse.json();
    expect(passport.aurum_score).toBeNull();
    expect(passport.rank_on_leaderboard).toBeNull();

    const leaderboardResponse = await worker.fetch(new Request('https://aurum.test/leaderboard/public'), env);
    expect(leaderboardResponse.status).toBe(200);
    const { leaderboard } = await leaderboardResponse.json();
    expect(leaderboard.aurum_score).toEqual([
      expect.objectContaining({ rank: 1, display_name: 'Visible', score: 500 }),
    ]);
    expect(leaderboard.most_generous[0].league_at_snapshot).toBeNull();
  });
});

describe('Phase 2B DM creation race', () => {
  it('returns the winner channel to both concurrent callers', async () => {
    let channel = null;
    let initialReads = 0;
    let releaseInitialReads;
    const initialReadBarrier = new Promise(resolve => { releaseInitialReads = resolve; });
    const statements = [];
    const db = {
      prepare(sql) {
        return {
          bind(...values) {
            statements.push(sql);
            return {
              async first() {
                if (sql.includes('FROM users')) return { id: values[0], stealth_mode: 0 };
                if (sql.includes('FROM dm_channels')) {
                  if (initialReads < 2) {
                    const observed = channel ? { id: channel.id } : null;
                    initialReads += 1;
                    if (initialReads === 2) releaseInitialReads();
                    await initialReadBarrier;
                    return observed;
                  }
                  return channel ? { id: channel.id } : null;
                }
                throw new Error(`Unexpected query: ${sql}`);
              },
              async run() {
                if (channel) throw new Error('UNIQUE constraint failed: dm_channels.user_a_id, dm_channels.user_b_id');
                channel = { id: values[0] };
                return { success: true };
              },
            };
          },
        };
      },
    };

    const results = await Promise.all([
      getOrCreateDmChannel('user-a', 'user-b', db),
      getOrCreateDmChannel('user-b', 'user-a', db),
    ]);

    expect(results.map(result => result.channel_id)).toEqual([channel.id, channel.id]);
    expect(results.map(result => result.created).sort()).toEqual([false, true]);
    expect(statements.filter(sql => sql.includes('INSERT INTO dm_channels'))).toHaveLength(2);
    expect(statements.filter(sql => sql.includes('is_suspended = 0') && sql.includes('deleted_at IS NULL'))).toHaveLength(2);
  });
});

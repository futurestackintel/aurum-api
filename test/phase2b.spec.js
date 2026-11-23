
import { describe, it, expect } from 'vitest';
import { getOrCreateDmChannel } from '../src/services/dm.js';

describe('DM creation race protection', () => {
  it('returns the same channel to both concurrent callers', async () => {
    let channel = null;
    let initialReads = 0;
    let releaseInitialReads;

    const initialReadBarrier = new Promise(resolve => {
      releaseInitialReads = resolve;
    });

    const statements = [];

    const db = {
      prepare(sql) {
        return {
          bind(...values) {
            statements.push({ sql, values });

            return {
              async first() {
                if (sql.includes('FROM users')) {
                  return { id: values[0] };
                }

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
                if (channel) {
                  throw new Error(
                    'UNIQUE constraint failed: dm_channels.user_a_id, dm_channels.user_b_id',
                  );
                }

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

    expect(channel).not.toBeNull();
    expect(results.map(result => result.channel_id))
      .toEqual([channel.id, channel.id]);
    expect(results.map(result => result.created).sort())
      .toEqual([false, true]);

    expect(statements.filter(item =>
      item.sql.includes('INSERT INTO dm_channels')
    )).toHaveLength(2);

    expect(statements.filter(item =>
      item.sql.includes('FROM users')
    )).toHaveLength(2);
  });
});


import { describe, expect, it } from 'vitest';
import { createComment } from '../src/services/comments.js';

function makeDb({ user = null, visiblePost = null } = {}) {
  const statements = [];

  return {
    statements,
    prepare(sql) {
      statements.push(sql);

      return {
        bind() {
          return {
            async first() {
              if (sql.includes('FROM users')) return user;
              if (sql.includes('FROM posts p')) return visiblePost;
              throw new Error(`Unexpected query: ${sql}`);
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe('social authorization hardening', () => {
  it('rejects comments from users who are unavailable', async () => {
    const db = makeDb();

    const result = await createComment(
      'post-1',
      'clerk-disabled-user',
      { content: 'Hello' },
      db,
    );

    expect(result).toEqual({ error: 'User not found' });
    expect(db.statements).toHaveLength(1);
    expect(db.statements[0]).toContain('account_deleted = 0');
    expect(db.statements[0]).toContain('is_suspended = 0');
  });

  it('rejects comments on posts the user cannot view', async () => {
    const db = makeDb({
      user: { id: 'active-user', league: 'gold' },
      visiblePost: null,
    });

    const result = await createComment(
      'private-post',
      'clerk-active-user',
      { content: 'Hello' },
      db,
    );

    expect(result).toEqual({ error: 'Post not found' });
    expect(db.statements.some(sql =>
      sql.includes('INSERT INTO post_comments')
    )).toBe(false);
  });

  it('rejects empty comments before checking post visibility', async () => {
    const db = makeDb({
      user: { id: 'active-user', league: 'gold' },
    });

    const result = await createComment(
      'post-1',
      'clerk-active-user',
      { content: '   ' },
      db,
    );

    expect(result).toEqual({ error: 'Comment content is required' });
    expect(db.statements).toHaveLength(1);
  });

  it('rejects comments that exceed the maximum length', async () => {
    const db = makeDb({
      user: { id: 'active-user', league: 'gold' },
    });

    const result = await createComment(
      'post-1',
      'clerk-active-user',
      { content: 'x'.repeat(1001) },
      db,
    );

    expect(result).toEqual({
      error: 'Comment must be 1000 characters or fewer',
    });
    expect(db.statements).toHaveLength(1);
  });
});

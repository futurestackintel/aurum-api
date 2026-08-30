-- Step 0: break the circular FK between posts and duels
UPDATE posts SET duel_id = NULL WHERE duel_id IS NOT NULL;
UPDATE duels SET post_id = NULL WHERE post_id IS NOT NULL;

-- Step 0b: preserve score history, just clear its post/challenge back-references
UPDATE aurum_score_events SET post_id = NULL WHERE post_id IS NOT NULL;
UPDATE aurum_score_events SET challenge_id = NULL WHERE challenge_id IS NOT NULL;

-- Posts family
DELETE FROM boost_tokens;
DELETE FROM post_stakes;
DELETE FROM post_flags;
DELETE FROM post_cheers;
DELETE FROM post_reactions;
DELETE FROM post_comments;
DELETE FROM moderation_log;
DELETE FROM tips;
DELETE FROM posts;

-- Challenges family
DELETE FROM treasury_ledger;
DELETE FROM challenge_entries;
DELETE FROM challenge_boosts;
DELETE FROM challenge_gold_buttons;
DELETE FROM challenge_payouts;
DELETE FROM free_challenge_entries;
DELETE FROM challenges;

-- Duels family
DELETE FROM duel_votes;
DELETE FROM duel_watchers;
DELETE FROM duels;
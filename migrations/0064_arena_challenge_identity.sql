ALTER TABLE challenges
ADD COLUMN primary_skill TEXT;

ALTER TABLE challenges
ADD COLUMN skill_tags TEXT NOT NULL DEFAULT '[]';

ALTER TABLE challenges
ADD COLUMN competition_format TEXT NOT NULL DEFAULT 'practical_task';

CREATE INDEX IF NOT EXISTS idx_challenges_primary_skill
ON challenges(primary_skill);

CREATE INDEX IF NOT EXISTS idx_challenges_competition_format
ON challenges(competition_format);

export class TreasuryService {
  constructor(db) {
    this.db = db;
  }

  async initializeTreasury(challengeId) {
    await this.db
      .prepare(
        `INSERT INTO treasury_ledger (challenge_id, total_held, status)
         VALUES (?, 0, 'holding')`
      )
      .bind(challengeId)
      .run();
  }

  async addFunds(challengeId, amount) {
    await this.db
      .prepare(
        `UPDATE treasury_ledger
         SET total_held = total_held + ?
         WHERE challenge_id = ? AND status = 'holding'`
      )
      .bind(amount, challengeId)
      .run();

    return this.getBalance(challengeId);
  }

  async getBalance(challengeId) {
    const result = await this.db
      .prepare(
        `SELECT total_held, status FROM treasury_ledger WHERE challenge_id = ?`
      )
      .bind(challengeId)
      .first();
    return result;
  }

  async markReleasing(challengeId) {
    await this.db
      .prepare(
        `UPDATE treasury_ledger
         SET status = 'releasing'
         WHERE challenge_id = ?`
      )
      .bind(challengeId)
      .run();
  }

  async markReleased(challengeId) {
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `UPDATE treasury_ledger
         SET status = 'released', released_at = ?
         WHERE challenge_id = ?`
      )
      .bind(now, challengeId)
      .run();
  }
}
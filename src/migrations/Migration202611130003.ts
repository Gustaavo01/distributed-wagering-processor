
import { Migration } from '@mikro-orm/migrations';

export class Migration202611130003 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      ALTER TABLE wager_transactions
      ADD COLUMN reference_attempts INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN reference_next_retry_at TIMESTAMPTZ,
      ADD COLUMN reference_expires_at TIMESTAMPTZ,
      ADD CONSTRAINT wager_reference_attempts_valid
        CHECK (reference_attempts >= 0);
    `);

    this.addSql(`
      CREATE UNIQUE INDEX wager_one_processed_reversal_per_type
      ON wager_transactions (reference_transaction_id, kind)
      WHERE kind IN ('REFUND', 'ROLLBACK')
        AND status = 'PROCESSED'
        AND reference_transaction_id IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX wager_pending_reference_due_idx
      ON wager_transactions (reference_next_retry_at, id)
      WHERE status = 'PENDING_REFERENCE';
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP INDEX IF EXISTS wager_pending_reference_due_idx;
    `);

    this.addSql(`
      DROP INDEX IF EXISTS wager_one_processed_reversal_per_type;
    `);

    this.addSql(`
      ALTER TABLE wager_transactions
      DROP CONSTRAINT IF EXISTS wager_reference_attempts_valid,
      DROP COLUMN IF EXISTS reference_attempts,
      DROP COLUMN IF EXISTS reference_next_retry_at,
      DROP COLUMN IF EXISTS reference_expires_at;
    `);
  }
}


import { Migration } from '@mikro-orm/migrations';

export class Migration202611120001 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency VARCHAR(3) NOT NULL,
        balance NUMERIC(20, 2) NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT wallets_player_currency_unique
          UNIQUE (player_id, currency),

        CONSTRAINT wallets_balance_nonnegative
          CHECK (balance >= 0),

        CONSTRAINT wallets_version_positive
          CHECK (version >= 1),

        CONSTRAINT wallets_currency_valid
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(100) NOT NULL,
        external_transaction_id VARCHAR(160) NOT NULL,
        idempotency_key VARCHAR(256) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,

        wallet_id UUID NOT NULL REFERENCES wallets(id),
        player_id UUID NOT NULL,
        round_id VARCHAR(160) NOT NULL,
        game_id VARCHAR(160) NOT NULL,

        kind VARCHAR(20) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,

        reference_external_transaction_id VARCHAR(160),
        reference_transaction_id UUID
          REFERENCES wager_transactions(id),

        status VARCHAR(30) NOT NULL DEFAULT 'PENDING',
        failure_code VARCHAR(100),

        result_balance NUMERIC(20, 2),
        result_wallet_version INTEGER,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,

        CONSTRAINT wager_external_unique
          UNIQUE (provider_id, external_transaction_id),

        CONSTRAINT wager_idempotency_unique
          UNIQUE (idempotency_key),

        CONSTRAINT wager_hash_valid
          CHECK (payload_hash ~ '^[0-9a-f]{64}$'),

        CONSTRAINT wager_amount_nonnegative
          CHECK (amount >= 0),

        CONSTRAINT wager_result_nonnegative
          CHECK (result_balance IS NULL OR result_balance >= 0),

        CONSTRAINT wager_kind_valid
          CHECK (kind IN (
            'OPENING', 'BET', 'WIN',
            'LOSS', 'REFUND', 'ROLLBACK'
          )),

        CONSTRAINT wager_status_valid
          CHECK (status IN (
            'PENDING', 'PENDING_REFERENCE',
            'PROCESSED', 'REJECTED', 'FAILED'
          )),

        CONSTRAINT wager_reference_required
          CHECK (
            kind NOT IN ('REFUND', 'ROLLBACK')
            OR reference_external_transaction_id IS NOT NULL
          ),

        CONSTRAINT wager_currency_valid
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE INDEX wager_reference_lookup_idx
      ON wager_transactions (
        provider_id,
        reference_external_transaction_id
      );
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id UUID PRIMARY KEY,
        wallet_id UUID NOT NULL REFERENCES wallets(id),
        transaction_id UUID NOT NULL UNIQUE
          REFERENCES wager_transactions(id),

        direction VARCHAR(10) NOT NULL,
        amount NUMERIC(20, 2) NOT NULL,
        currency VARCHAR(3) NOT NULL,

        balance_before NUMERIC(20, 2) NOT NULL,
        balance_after NUMERIC(20, 2) NOT NULL,

        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT ledger_amount_positive
          CHECK (amount > 0),

        CONSTRAINT ledger_balances_nonnegative
          CHECK (
            balance_before >= 0
            AND balance_after >= 0
          ),

        CONSTRAINT ledger_direction_valid
          CHECK (direction IN ('DEBIT', 'CREDIT')),

        CONSTRAINT ledger_arithmetic_valid
          CHECK (
            (direction = 'DEBIT'
              AND balance_before - amount = balance_after)
            OR
            (direction = 'CREDIT'
              AND balance_before + amount = balance_after)
          ),

        CONSTRAINT ledger_currency_valid
          CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE INDEX ledger_wallet_cursor_idx
      ON wallet_ledger_entries (
        wallet_id, created_at DESC, id DESC
      );
    `);

    this.addSql(`
      CREATE FUNCTION reject_ledger_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'Ledger entries are immutable';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      CREATE TRIGGER ledger_immutable_trigger
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW
      EXECUTE FUNCTION reject_ledger_mutation();
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS wallet_ledger_entries;
    `);

    this.addSql(`
      DROP FUNCTION IF EXISTS reject_ledger_mutation();
    `);

    this.addSql(`
      DROP TABLE IF EXISTS wager_transactions;
    `);

    this.addSql(`
      DROP TABLE IF EXISTS wallets;
    `);
  }
}

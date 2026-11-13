
import { Migration } from '@mikro-orm/migrations';

export class Migration202611130002 extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE inbox_messages (
        message_id VARCHAR(200) NOT NULL,
        consumer_name VARCHAR(100) NOT NULL,
        payload_hash VARCHAR(64) NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        processed_at TIMESTAMPTZ,

        CONSTRAINT inbox_messages_pk
          PRIMARY KEY (consumer_name, message_id),

        CONSTRAINT inbox_payload_hash_valid
          CHECK (payload_hash ~ '^[0-9a-f]{64}$')
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ,

        CONSTRAINT outbox_attempts_nonnegative
          CHECK (attempts >= 0),

        CONSTRAINT outbox_payload_object
          CHECK (jsonb_typeof(payload) = 'object')
      );
    `);

    this.addSql(`
      CREATE INDEX outbox_pending_idx
      ON outbox_messages (
        next_attempt_at,
        occurred_at,
        id
      )
      WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql(`
      DROP TABLE IF EXISTS outbox_messages;
    `);

    this.addSql(`
      DROP TABLE IF EXISTS inbox_messages;
    `);
  }
}

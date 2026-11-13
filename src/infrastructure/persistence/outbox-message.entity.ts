
import {
  Entity,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({
    fieldName: 'aggregate_id',
    type: 'uuid',
  })
  aggregateId!: string;

  @Property({
    fieldName: 'event_type',
    length: 100,
  })
  eventType!: string;

  @Property({
    type: 'json',
    columnType: 'jsonb',
  })
  payload!: Record<string, unknown>;

  @Property({
    fieldName: 'occurred_at',
    type: 'datetime',
    columnType: 'timestamptz',
  })
  occurredAt!: Date;

  @Property({ type: 'integer' })
  attempts!: number;

  @Property({
    fieldName: 'next_attempt_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  nextAttemptAt?: Date | null;

  @Property({
    fieldName: 'published_at',
    type: 'datetime',
    columnType: 'timestamptz',
    nullable: true,
  })
  publishedAt?: Date | null;
}

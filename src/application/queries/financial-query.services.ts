
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import { MikroORM } from '@mikro-orm/postgresql';

import {
  WalletEntity,
} from '../../infrastructure/persistence/entities/wallet.entity.js';

import {
  WagerTransactionEntity,
} from '../../infrastructure/persistence/wager-transaction.entity.js';

interface LedgerRow {
  id: string;
  transactionId: string;
  direction: string;
  amount: string;
  currency: string;
  balanceBefore: string;
  balanceAfter: string;
  createdAt: Date | string;
}

interface LedgerCursor {
  createdAt: string;
  id: string;
}

interface ReconciliationRow {
  walletId: string;
  currency: string;
  storedBalance: string;
  calculatedBalance: string;
  difference: string;
  checkedEntries: number;
}

function decodeCursor(value: string): LedgerCursor {
  try {
    if (value.length > 1024) {
      throw new Error('Cursor too long');
    }

    const raw = Buffer.from(
      value,
      'base64url',
    ).toString('utf8');

    const parsed: unknown = JSON.parse(raw);

    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error('Invalid cursor');
    }

    const data = parsed as Record<string, unknown>;

    const uuidPattern =
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

    if (
      typeof data.id !== 'string' ||
      !uuidPattern.test(data.id) ||
      typeof data.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(data.createdAt))
    ) {
      throw new Error('Invalid cursor fields');
    }

    return {
      id: data.id,
      createdAt: new Date(
        data.createdAt,
      ).toISOString(),
    };
  } catch {
    throw new BadRequestException(
      'Invalid ledger cursor',
    );
  }
}

function encodeCursor(row: LedgerRow): string {
  const data: LedgerCursor = {
    id: row.id,
    createdAt: new Date(
      row.createdAt,
    ).toISOString(),
  };

  return Buffer.from(
    JSON.stringify(data),
  ).toString('base64url');
}

@Injectable()
export class FinancialQueryService {
  private readonly logger =
    new Logger(FinancialQueryService.name);

  constructor(
    private readonly orm: MikroORM,
  ) {}

  // =====================================
  // WALLET
  // =====================================

  async getWallet(walletId: string) {
    const wallet = await this.orm.em
      .fork()
      .findOne(
        WalletEntity,
        { id: walletId },
      );

    if (!wallet) {
      throw new NotFoundException(
        'Wallet not found',
      );
    }

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: {
        amount: wallet.balance,
        currency: wallet.currency,
      },
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }

  // =====================================
  // TRANSACTION SERIALIZATION
  // =====================================

  private formatTransaction(
    row: WagerTransactionEntity,
  ) {
    return {
      id: row.id,
      providerId: row.providerId,
      externalTransactionId:
        row.externalTransactionId,
      walletId: row.walletId,
      playerId: row.playerId,
      roundId: row.roundId,
      gameId: row.gameId,
      kind: row.kind,
      status: row.status,
      money: {
        amount: row.amount,
        currency: row.currency,
      },
      referenceExternalTransactionId:
        row.referenceExternalTransactionId ?? null,
      referenceTransactionId:
        row.referenceTransactionId ?? null,
      failureCode: row.failureCode ?? null,
      resultBalance:
        row.resultBalance == null
          ? null
          : {
              amount: row.resultBalance,
              currency: row.currency,
            },
      resultWalletVersion:
        row.resultWalletVersion ?? null,
      createdAt: row.createdAt.toISOString(),
      processedAt:
        row.processedAt?.toISOString() ?? null,
    };
  }

  // =====================================
  // TRANSACTION BY INTERNAL ID
  // =====================================

  async getTransaction(
    transactionId: string,
  ) {
    const row = await this.orm.em
      .fork()
      .findOne(
        WagerTransactionEntity,
        { id: transactionId },
      );

    if (!row) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return this.formatTransaction(row);
  }

  // =====================================
  // TRANSACTION BY PROVIDER IDENTITY
  // =====================================

  async getTransactionByExternalId(
    providerId: string,
    externalTransactionId: string,
  ) {
    const row = await this.orm.em
      .fork()
      .findOne(
        WagerTransactionEntity,
        {
          providerId,
          externalTransactionId,
        },
      );

    if (!row) {
      throw new NotFoundException(
        'Transaction not found',
      );
    }

    return this.formatTransaction(row);
  }

  // =====================================
  // PAGINATED LEDGER
  // =====================================

  async getLedger(
    walletId: string,
    limit = 20,
    cursor?: string,
  ) {
    await this.getWallet(walletId);

    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100
    ) {
      throw new BadRequestException(
        'limit must be between 1 and 100',
      );
    }

    const decoded = cursor
      ? decodeCursor(cursor)
      : null;

    const parameters: Array<string | number> = [
      walletId,
    ];

    let cursorCondition = '';

    if (decoded) {
      cursorCondition = `
        AND (created_at, id) <
            (?::timestamptz, ?::uuid)
      `;

      parameters.push(
        decoded.createdAt,
        decoded.id,
      );
    }

    parameters.push(limit + 1);

    const sql = `
      SELECT
        id::text AS "id",
        transaction_id::text AS "transactionId",
        direction AS "direction",
        amount::text AS "amount",
        currency AS "currency",
        balance_before::text AS "balanceBefore",
        balance_after::text AS "balanceAfter",
        created_at AS "createdAt"
      FROM wallet_ledger_entries
      WHERE wallet_id = ?::uuid
      ${cursorCondition}
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `;

    const rows = await this.orm.em
      .fork()
      .execute<LedgerRow[]>(
        sql,
        parameters,
      );

    const hasMore = rows.length > limit;

    const page = rows.slice(0, limit);

    const nextCursor =
      hasMore && page.length > 0
        ? encodeCursor(
            page[page.length - 1]!,
          )
        : null;

    return {
      items: page.map((row) => ({
        id: row.id,
        transactionId: row.transactionId,
        direction: row.direction,
        money: {
          amount: row.amount,
          currency: row.currency,
        },
        balanceBefore: {
          amount: row.balanceBefore,
          currency: row.currency,
        },
        balanceAfter: {
          amount: row.balanceAfter,
          currency: row.currency,
        },
        createdAt: new Date(
          row.createdAt,
        ).toISOString(),
      })),
      nextCursor,
      hasMore,
    };
  }

  // =====================================
  // RECONCILIATION DATA
  // =====================================

  private async readReconciliation(
    walletId: string,
  ): Promise<ReconciliationRow> {
    // A wallet e os lancamentos sao lidos
    // no mesmo statement SQL e, portanto,
    // no mesmo snapshot da consulta.
    //
    // A aritmetica monetaria e executada
    // pelo PostgreSQL com NUMERIC, nunca
    // por number do JavaScript.

    const rows = await this.orm.em
      .fork()
      .execute<ReconciliationRow[]>(
        `
        WITH totals AS (
          SELECT
            w.id,
            w.currency,
            w.balance AS stored_balance,

            COALESCE(
              SUM(
                CASE
                  WHEN l.direction = 'CREDIT'
                    THEN l.amount
                  WHEN l.direction = 'DEBIT'
                    THEN -l.amount
                  ELSE 0
                END
              ),
              0
            ) AS calculated_balance,

            COUNT(l.id)::integer AS checked_entries

          FROM wallets w
          LEFT JOIN wallet_ledger_entries l
            ON l.wallet_id = w.id

          WHERE w.id = ?::uuid

          GROUP BY
            w.id,
            w.currency,
            w.balance
        )

        SELECT
          id::text AS "walletId",
          currency AS "currency",

          stored_balance::numeric(20,2)::text
            AS "storedBalance",

          calculated_balance::numeric(20,2)::text
            AS "calculatedBalance",

          (
            stored_balance - calculated_balance
          )::numeric(20,2)::text
            AS "difference",

          checked_entries AS "checkedEntries"

        FROM totals
        `,
        [walletId],
      );

    const result = rows[0];

    if (!result) {
      throw new NotFoundException(
        'Wallet not found',
      );
    }

    return result;
  }

  // =====================================
  // OFFICIAL RECONCILIATION CONTRACT
  // POST /wallets/:walletId/reconciliation
  // =====================================

  async reconcileWalletContract(
    walletId: string,
  ) {
    const result = await this.readReconciliation(
      walletId,
    );

    const consistent =
      result.difference === '0.00';

    if (!consistent) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet_reconciliation_mismatch',
          walletId,
          storedBalance: result.storedBalance,
          calculatedBalance:
            result.calculatedBalance,
          difference: result.difference,
          currency: result.currency,
        }),
      );
    }

    return {
      walletId: result.walletId,
      storedBalance: {
        amount: result.storedBalance,
        currency: result.currency,
      },
      calculatedBalance: {
        amount: result.calculatedBalance,
        currency: result.currency,
      },
      difference: {
        amount: result.difference,
        currency: result.currency,
      },
      consistent,
      checkedEntries: result.checkedEntries,
    };
  }

  // =====================================
  // LEGACY GET - PREVIOUS TESTS
  // =====================================

  async reconcileWallet(
    walletId: string,
  ) {
    const result = await this.readReconciliation(
      walletId,
    );

    const matches =
      result.difference === '0.00';

    if (!matches) {
      this.logger.warn(
        JSON.stringify({
          event: 'wallet_reconciliation_mismatch',
          walletId,
          difference: result.difference,
        }),
      );
    }

    return {
      walletId: result.walletId,
      currency: result.currency,
      storedBalance: result.storedBalance,
      ledgerBalance: result.calculatedBalance,
      entryCount: result.checkedEntries,
      matches,
      status: matches
        ? 'MATCH'
        : 'MISMATCH',
      checkedAt: new Date().toISOString(),
    };
  }
}

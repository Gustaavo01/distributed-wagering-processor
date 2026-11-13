
import { Money } from '../value-objects/money.js';
import { LedgerDirection } from './wallet-ledger-entry.js';

export enum WagerTransactionKind {
  Opening = 'OPENING',
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}

export enum WagerTransactionStatus {
  Pending = 'PENDING',
  PendingReference = 'PENDING_REFERENCE',
  Processed = 'PROCESSED',
  Rejected = 'REJECTED',
  Failed = 'FAILED',
}

export enum FailureCode {
  InsufficientBalance = 'INSUFFICIENT_BALANCE',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  InvalidReference = 'INVALID_REFERENCE',
  DuplicateReversal = 'DUPLICATE_REVERSAL',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  PermanentInfrastructureFailure = 'PERMANENT_INFRASTRUCTURE_FAILURE',
}

export class InvalidWagerTransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerTransactionError';
  }
}

export class InvalidTransactionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidTransactionStateError';
  }
}

export class InvalidWagerReferenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWagerReferenceError';
  }
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
}

export interface WagerTransactionState
  extends CreateWagerTransactionProps {
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    public readonly referenceExternalTransactionId: string | undefined,
    private readonly _createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
  ) {}

  static create(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    if (props.kind === WagerTransactionKind.Opening) {
      throw new InvalidWagerTransactionError(
        'OPENING is an internal transaction',
      );
    }

    return WagerTransaction.build(props);
  }

  static createOpening(
    props: Omit<
      CreateWagerTransactionProps,
      'kind' | 'referenceExternalTransactionId'
    >,
  ): WagerTransaction {
    return WagerTransaction.build({
      ...props,
      kind: WagerTransactionKind.Opening,
    });
  }

  private static build(
    props: CreateWagerTransactionProps,
  ): WagerTransaction {
    const required = [
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
    ];

    if (required.some(value =>
      typeof value !== 'string' || !value.trim()
    )) {
      throw new InvalidWagerTransactionError(
        'Required transaction fields are missing',
      );
    }

    if (!/^[0-9a-f]{64}$/.test(props.payloadHash)) {
      throw new InvalidWagerTransactionError(
        'Invalid SHA-256 payload hash',
      );
    }

    if (
      !Object.values(WagerTransactionKind)
        .includes(props.kind)
    ) {
      throw new InvalidWagerTransactionError(
        'Invalid transaction kind',
      );
    }

    if (
      !(props.money instanceof Money) ||
      !props.money.isPositive()
    ) {
      throw new InvalidWagerTransactionError(
        'Transaction amount must be positive',
      );
    }

    const requiresReference =
      props.kind === WagerTransactionKind.Refund ||
      props.kind === WagerTransactionKind.Rollback;

    if (
      requiresReference &&
      !props.referenceExternalTransactionId?.trim()
    ) {
      throw new InvalidWagerTransactionError(
        'Reference transaction is required',
      );
    }

    if (
      props.referenceExternalTransactionId !== undefined &&
      props.kind !== WagerTransactionKind.Win &&
      !requiresReference
    ) {
      throw new InvalidWagerTransactionError(
        'This transaction kind cannot reference another',
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      props.referenceExternalTransactionId,
      new Date(),
      WagerTransactionStatus.Pending,
    );
  }

  static rehydrate(
    state: WagerTransactionState,
  ): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      new Date(state.createdAt),
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt
        ? new Date(state.processedAt)
        : undefined,
    );
  }

  get createdAt(): Date {
    return new Date(this._createdAt);
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt)
      : undefined;
  }

  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    // Classifica o tipo da operação, não seu status atual.
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  markPendingReference(): void {
    this.assertNotTerminal();

    if (
      !this.requiresReference() &&
      !this.referenceExternalTransactionId
    ) {
      throw new InvalidTransactionStateError(
        'Transaction does not require a reference',
      );
    }

    this._status = WagerTransactionStatus.PendingReference;
  }

  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
  ): void {
    this.assertNotTerminal();

    const expectsReference =
      this.requiresReference() ||
      this.referenceExternalTransactionId !== undefined;

    if (expectsReference && !referenceTransactionId) {
      throw new InvalidWagerReferenceError(
        'Resolved reference is required',
      );
    }

    if (!expectsReference && referenceTransactionId) {
      throw new InvalidWagerReferenceError(
        'Unexpected resolved reference',
      );
    }

    this._referenceTransactionId = referenceTransactionId;
    this._status = WagerTransactionStatus.Processed;
    this._processedAt = new Date(at);
  }

  reject(code: FailureCode): void {
    this.assertNotTerminal();

    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
  }

  fail(code: FailureCode): void {
    this.assertNotTerminal();

    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
  }

  ledgerDirectionFor(
    reference?: WagerTransaction,
  ): LedgerDirection {
    if (this.kind === WagerTransactionKind.Loss) {
      throw new InvalidWagerTransactionError(
        'LOSS does not generate ledger entries',
      );
    }

    if (
      this.requiresReference() ||
      this.referenceExternalTransactionId !== undefined
    ) {
      this.assertValidReference(reference);
    }

    switch (this.kind) {
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;

      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;

      case WagerTransactionKind.Rollback:
        return reference!.kind === WagerTransactionKind.Bet
          ? LedgerDirection.Credit
          : LedgerDirection.Debit;

      default:
        throw new InvalidWagerTransactionError(
          'Unsupported ledger operation',
        );
    }
  }

  private assertValidReference(
    reference?: WagerTransaction,
  ): void {
    if (
      !reference ||
      reference.id === this.id ||
      reference.status !== WagerTransactionStatus.Processed
    ) {
      throw new InvalidWagerReferenceError(
        'Reference must be a different processed transaction',
      );
    }

    if (
      reference.externalTransactionId !==
        this.referenceExternalTransactionId ||
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.roundId !== this.roundId ||
      reference.money.currency !== this.money.currency
    ) {
      throw new InvalidWagerReferenceError(
        'Reference does not belong to the same context',
      );
    }

    if (
      this.requiresReference() &&
      !this.money.equals(reference.money)
    ) {
      throw new InvalidWagerReferenceError(
        'Reversal amount must match original amount',
      );
    }

    if (
      (this.kind === WagerTransactionKind.Refund ||
       this.kind === WagerTransactionKind.Win) &&
      reference.kind !== WagerTransactionKind.Bet
    ) {
      throw new InvalidWagerReferenceError(
        'This operation must reference a BET',
      );
    }

    if (
      this.kind === WagerTransactionKind.Rollback &&
      ![
        WagerTransactionKind.Bet,
        WagerTransactionKind.Win,
        WagerTransactionKind.Refund,
      ].includes(reference.kind)
    ) {
      throw new InvalidWagerReferenceError(
        'Invalid ROLLBACK reference kind',
      );
    }
  }

  private assertNotTerminal(): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot transition terminal status ${this._status}`,
      );
    }
  }
}

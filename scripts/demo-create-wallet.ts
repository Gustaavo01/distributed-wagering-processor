
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/mikro-orm.config.js';

import { CreateWalletUseCase } from '../src/application/use-cases/create-wallet.use-case.js';

import { WalletEntity } from '../src/infrastructure/persistence/entities/wallet.entity.js';

import { WagerTransactionEntity } from '../src/infrastructure/persistence/wager-transaction.entity.js';

import { WalletLedgerEntryEntity } from '../src/infrastructure/persistence/entities/wallet-ledger-entry.entity.js';

import { OutboxMessageEntity } from '../src/infrastructure/persistence/outbox-message.entity.js';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const useCase = new CreateWalletUseCase(orm);

    const playerId = randomUUID();

    const result = await useCase.execute({
      playerId,
      initialBalance: {
        amount: '100.00',
        currency: 'BRL',
      },
    });

    const em = orm.em.fork();

    const wallet = await em.findOneOrFail(
      WalletEntity,
      { id: result.id },
    );

    const transactions = await em.find(
      WagerTransactionEntity,
      { walletId: result.id },
    );

    const entries = await em.find(
      WalletLedgerEntryEntity,
      { walletId: result.id },
    );

    const outbox = await em.find(
      OutboxMessageEntity,
      { aggregateId: result.id },
    );

    assert.equal(wallet.balance, '100.00');
    assert.equal(wallet.version, 1);

    assert.equal(transactions.length, 1);
    assert.equal(transactions[0]!.kind, 'OPENING');
    assert.equal(transactions[0]!.status, 'PROCESSED');

    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.direction, 'CREDIT');
    assert.equal(entries[0]!.balanceBefore, '0.00');
    assert.equal(entries[0]!.balanceAfter, '100.00');

    assert.equal(outbox.length, 2);

    console.log('Carteira criada:', result);
    console.log('Transacao OPENING:', transactions.length);
    console.log('Lancamentos no ledger:', entries.length);
    console.log('Eventos na outbox:', outbox.length);
    console.log('Verificacoes financeiras passaram!');

    // Testa a unicidade de playerId + currency.
    await assert.rejects(() =>
      useCase.execute({
        playerId,
        initialBalance: {
          amount: '200.00',
          currency: 'BRL',
        },
      }),
    );

    console.log('Carteira duplicada bloqueada!');

    // Verifica que uma wallet zerada não gera lançamento.
    const zeroWallet = await useCase.execute({
      playerId: randomUUID(),
      initialBalance: {
        amount: '0.00',
        currency: 'BRL',
      },
    });

    const zeroEntries = await orm.em.fork().find(
      WalletLedgerEntryEntity,
      { walletId: zeroWallet.id },
    );

    assert.equal(zeroEntries.length, 0);

    console.log('Carteira com saldo zero validada!');
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error('Erro no teste de criação:', error);
  process.exitCode = 1;
});

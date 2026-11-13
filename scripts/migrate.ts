
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const pending = await orm.migrator.getPending();

    console.log('Migrations pendentes:', pending);

    await orm.migrator.up();

    const executed = await orm.migrator.getExecuted();

    console.log('Migrations executadas:', executed);
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error('Erro ao executar migrations:', error);
  process.exitCode = 1;
});

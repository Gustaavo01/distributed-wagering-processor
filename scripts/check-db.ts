
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../src/mikro-orm.config';

async function main(): Promise<void> {
  const orm = await MikroORM.init(config);

  try {
    const result = await orm.em
      .getConnection()
      .execute('SELECT 1 AS ok');

    console.log('Database connection successful!');
    console.log(result);
  } finally {
    await orm.close();
  }
}

main().catch((error: unknown) => {
  console.error('Database connection failed:', error);
  process.exitCode = 1;
});

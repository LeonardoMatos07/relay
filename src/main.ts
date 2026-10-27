import 'reflect-metadata';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { loadConfig } from './config';
import { DatabaseService } from './infra/database.service';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const logger = new ConsoleLogger({ prefix: `relay-${config.role}`, json: config.logJson });

  if (config.role === 'migrate') {
    const app = await NestFactory.createApplicationContext(AppModule.forRole(config), { logger });
    const applied = await app.get(DatabaseService).migrate();
    logger.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema up to date');
    await app.close();
    return;
  }

  const app = await NestFactory.create(AppModule.forRole(config), { logger });
  app.enableShutdownHooks();
  await app.listen(config.port, '0.0.0.0');
  Logger.log(`listening on :${config.port}`, 'Bootstrap');
}

bootstrap().catch((err: unknown) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

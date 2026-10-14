import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { CONFIG, type AppConfig } from './config/configuration';
import { TiktokExceptionFilter } from './common/errors/tiktok-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger:
      process.env.LOG_LEVEL === 'debug'
        ? ['log', 'error', 'warn', 'debug', 'verbose']
        : ['log', 'error', 'warn'],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      stopAtFirstError: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: false },
      validationError: { target: false, value: false },
    }),
  );
  app.useGlobalFilters(new TiktokExceptionFilter());
  app.enableShutdownHooks();

  const config = app.get<AppConfig>(CONFIG);
  await app.listen(config.server.port, config.server.host);

  const logger = new Logger('Bootstrap');
  logger.log(`tiktok-web-api listening on http://${config.server.host}:${config.server.port}`);
  logger.log(
    `Upstream origin ${config.tiktok.origin} | region ${config.tiktok.region} | proxy ${
      config.tiktok.proxyUrl ? 'enabled' : 'disabled'
    }`,
  );
  logger.log('Try: curl -s localhost:%d/internal/health | jq', config.server.port);
}

void bootstrap();

import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module';
import { buildOpenApiDocument } from './openapi';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  // I client girano su un'altra origine (Vite): senza CORS il browser non arriverebbe a /health.
  const origins = config
    .get<string>('CORS_ORIGINS', 'http://localhost:5173,http://localhost:5174')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  app.enableCors({ origin: origins, credentials: true });

  SwaggerModule.setup('docs', app, buildOpenApiDocument(app));

  const port = Number.parseInt(config.get<string>('API_PORT', '3000'), 10);
  await app.listen(port);
  console.log(`ROAd API in ascolto su http://localhost:${port} (contratto su /docs)`);
}

void bootstrap();

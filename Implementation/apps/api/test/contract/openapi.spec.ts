import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';

import { AppModule } from '../../src/app.module';
import { buildOpenApiDocument } from '../../src/openapi';

/**
 * Il contratto pubblicato non può cambiare di nascosto (HARNESS.md §4).
 *
 * `contracts/openapi.json` è committato. Questo test lo rigenera dai decoratori Nest e fallisce se
 * differisce: se la modifica è voluta si aggiorna il file con `pnpm contract:update` e il diff
 * compare nella pull request, dove il team lo vede; se non è voluta, la build si ferma qui.
 *
 * Con `ROAD_UPDATE_OPENAPI=1` il file viene riscritto invece che confrontato: è ciò che fa
 * `pnpm contract:update`, e resta l'unico modo previsto per aggiornarlo.
 */
const contractPath = resolve(__dirname, '..', '..', '..', '..', 'contracts', 'openapi.json');

describe('Contratto OpenAPI', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(AppModule, { logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('è identico a contracts/openapi.json', () => {
    const generated = `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`;

    if (process.env.ROAD_UPDATE_OPENAPI === '1') {
      mkdirSync(dirname(contractPath), { recursive: true });
      writeFileSync(contractPath, generated, 'utf8');
      return;
    }

    const committed = readFileSync(contractPath, 'utf8').replace(/\r\n/g, '\n');

    // Il messaggio conta: chi vede rosso qui dev'essere in grado di risolverlo senza indagare.
    expect({
      hint: 'Se la modifica è voluta esegui `pnpm contract:update` e committa il risultato.',
      contract: generated,
    }).toEqual({
      hint: 'Se la modifica è voluta esegui `pnpm contract:update` e committa il risultato.',
      contract: committed,
    });
  });

  it('descrive GET /health con la risposta 200 tipizzata', () => {
    const document = buildOpenApiDocument(app);
    const health = document.paths['/health']?.get;

    expect(health).toBeDefined();
    expect(health?.responses['200']).toBeDefined();
  });
});

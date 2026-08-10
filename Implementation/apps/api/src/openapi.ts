import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';

/**
 * Versione del contratto pubblicato. Cambia quando cambia l'API, non a ogni build: il file
 * `contracts/openapi.json` è committato e il suo diff dev'essere leggibile in pull request
 * (HARNESS.md §4).
 */
export const OPENAPI_VERSION = '0.1.0';

/**
 * Costruisce il documento OpenAPI dai decoratori Nest.
 *
 * Lo usano due chiamanti: `main.ts`, per servire la UI su `/docs`, e il test di contratto, che
 * rigenera il documento e fallisce se differisce da quello in repo. Avere un'unica funzione
 * garantisce che il file committato sia esattamente quello che l'applicazione espone.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('ROAd API')
    .setDescription(
      'Contratto pubblico del backend ROAd. È la sola cosa che i client devono conoscere: ' +
        'nessun client importa codice da apps/api.',
    )
    .setVersion(OPENAPI_VERSION)
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'bearer')
    .build();

  return SwaggerModule.createDocument(app, config);
}

import { BadRequestException, type PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/**
 * Valida un corpo di richiesta con lo schema Zod di `packages/shared`.
 *
 * Gli schemi condivisi sono la sorgente unica di verità per DTO ed enum (HARNESS.md §4, DD §2.2.1:
 * «request and response shapes are declared once as schemas shared by backend and clients»). Senza
 * questa pipe i DTO decorati per Swagger descriverebbero il contratto pubblicato senza farlo
 * rispettare: `contracts/openapi.json` prometterebbe una `email` valida e il controller
 * accetterebbe qualunque stringa.
 *
 * Restituisce il valore **parsato**, non quello ricevuto: gli schemi normalizzano — l'indirizzo
 * viene ripulito e portato in minuscolo — e usare l'originale renderebbe la normalizzazione
 * decorativa.
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodType<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (parsed.success) return parsed.data;

    throw new BadRequestException({
      message: 'Il corpo della richiesta non è conforme al contratto.',
      // Solo percorso e messaggio: `issue.input` porterebbe il valore rifiutato dentro la
      // risposta, e su `POST /auth/login` quel valore è la password.
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }
}

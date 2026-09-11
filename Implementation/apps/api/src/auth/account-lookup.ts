import { Injectable } from '@nestjs/common';

import { PersistencePort } from '../persistence/persistence.port';

/**
 * Se l'account che il token dichiara **esista ancora** (decisione D78).
 *
 * È l'unica lettura che l'autenticazione fa, e sta in una classe sua perché i cammini che devono
 * farla sono due e non si somigliano: `JwtStrategy` protegge le rotte HTTP e solleva, `TokenVerifier`
 * protegge l'handshake della WebSocket e restituisce `null`. Scritta due volte divergerebbe alla
 * prima modifica, e un token accettato dalla socket ma rifiutato dalle rotte — o il contrario — è
 * peggio di entrambi i comportamenti presi da soli.
 *
 * **Legge il livello dati condiviso, non un registro di sessione**, ed è la distinzione su cui NFR3
 * si regge: una seconda replica del tier applicativo, che non ha mai visto quel login, esegue questa
 * stessa interrogazione sullo stesso database e accetta lo stesso token. Ciò che il requisito vieta
 * è lo stato *in memoria del processo*, che renderebbe le repliche non intercambiabili; questa
 * lettura è indistinguibile da quella che qualunque rotta fa subito dopo.
 *
 * Guarda **solo l'esistenza**, non i campi. Ruolo e indirizzo restano quelli firmati nel token: un
 * ruolo riletto dal database si applicherebbe a metà — sulle rotte sì, sulla socket già aperta no —
 * e non è ciò che questo difetto chiedeva di risolvere.
 */
@Injectable()
export class AccountLookup {
  constructor(private readonly persistence: PersistencePort) {}

  async exists(userId: string): Promise<boolean> {
    const [found] = await this.persistence.find('user', { where: { id: userId }, limit: 1 });
    return found !== undefined;
  }
}

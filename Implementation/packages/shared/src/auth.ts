import { z } from 'zod';

import { USER_ROLES } from './domain.js';

/**
 * Il contratto pubblico dell'autenticazione (RASD R1, R2; DD §2.2 `AuthenticationManager`).
 *
 * Sta in `packages/shared` per la stessa ragione di `health.ts`: gli schemi sono la sorgente unica
 * di verità per DTO ed enum (HARNESS.md §4). Il backend li usa per validare ciò che riceve e i suoi
 * DTO li `implements`, così il compilatore fallisce se contratto pubblicato e tipi condivisi
 * divergono; i client di M8 li useranno per validare ciò che ricevono, senza importare una riga da
 * `apps/api`.
 *
 * **Nessuno schema di questo file contiene la password in uscita.** `userProfileSchema` è la sola
 * forma con cui un utente lascia il backend, ed è costruita elencando i campi ammessi invece di
 * togliere quelli vietati: un campo nuovo sull'entità non ci finisce dentro per distrazione.
 */

/**
 * Lunghezza minima della password.
 *
 * Otto caratteri è il minimo del NIST SP 800-63B per una password scelta dall'utente. Il RASD non
 * fissa una politica: questa è la scelta più conservativa che non aggiunge requisiti non richiesti
 * (nessun obbligo di maiuscole o simboli, che il NIST stesso sconsiglia).
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * L'indirizzo, **normalizzato prima di essere validato**.
 *
 * L'ordine è il punto: in Zod controlli e trasformazioni si applicano nell'ordine in cui sono
 * dichiarati, quindi `z.email().trim()` valida l'originale e ripulisce dopo — un indirizzo
 * incollato con uno spazio in coda, che è il modo più comune di sbagliarlo, verrebbe rifiutato
 * invece che sistemato. Con la `pipe` si ripulisce prima e si valida ciò che verrà davvero scritto,
 * che è anche la sola forma in cui l'unicità dell'indirizzo significa qualcosa: `Mario@x.it` e
 * `mario@x.it` devono essere lo stesso account.
 */
const emailSchema = z.string().trim().toLowerCase().pipe(z.email().max(320));
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH).max(200);
const personNameSchema = z.string().trim().min(1).max(120);
/** Il numero di telefono è il campo che il RASD §2.2.1 attribuisce al solo `Passenger`. */
const phoneNumberSchema = z.string().trim().min(1).max(40);

/**
 * `POST /auth/register`.
 *
 * Non c'è `role`: il RASD §1.4 elenca «Passenger registration» fra i requisiti del sistema e
 * «Fleet operator login» senza la registrazione corrispondente, quindi l'iscrizione pubblica crea
 * sempre un `PASSENGER`. Gli account operatore sono forniti dall'amministrazione (in questo
 * prototipo, dal seed).
 */
export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  name: personNameSchema,
  surname: personNameSchema,
  phoneNumber: phoneNumberSchema.optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/** `POST /auth/login`. Vale per entrambi i ruoli (R1). */
export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * `PATCH /auth/me` — R2, «update their personal information **and credentials**».
 *
 * Ogni campo è facoltativo, ma almeno uno dev'esserci: una `PATCH` vuota non è un aggiornamento
 * riuscito di nulla, è una richiesta malformata, e accettarla nasconderebbe un difetto del client.
 */
export const updateProfileRequestSchema = z
  .object({
    email: emailSchema.optional(),
    password: passwordSchema.optional(),
    name: personNameSchema.optional(),
    surname: personNameSchema.optional(),
    /** `null` cancella il numero; ometterlo lo lascia com'è. */
    phoneNumber: phoneNumberSchema.nullable().optional(),
  })
  .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
    message: 'Indicare almeno un campo da aggiornare.',
  });
export type UpdateProfileRequest = z.infer<typeof updateProfileRequestSchema>;

/**
 * L'utente come lo vedono i client. **La password non compare, in nessuna forma.**
 *
 * Non c'è `passwordHash` e non c'è `password`: il cancello di M1b verifica che nessuna risposta
 * dell'API contenga l'una o l'altra chiave, e che la password in chiaro non finisca nei log.
 */
export const userProfileSchema = z.object({
  id: z.uuid(),
  email: z.email(),
  name: z.string(),
  surname: z.string(),
  phoneNumber: z.string().nullable(),
  role: z.enum(USER_ROLES),
  createdAt: z.iso.datetime(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

/**
 * La risposta di registrazione e login: il profilo e **un solo** access token (MILESTONES.md §M1b).
 *
 * Niente refresh token. Con un solo token a scadenza breve non esiste stato di sessione lato
 * server da replicare (NFR3): un token emesso da un'istanza è accettato da qualunque altra che
 * conosca la stessa chiave di firma, e nessuna delle due consulta un registro in memoria.
 */
export const authResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  /** Durata residua del token in secondi, perché il client sappia quando ripetere il login. */
  expiresInSeconds: z.number().int().positive(),
  user: userProfileSchema,
});
export type AuthResponse = z.infer<typeof authResponseSchema>;

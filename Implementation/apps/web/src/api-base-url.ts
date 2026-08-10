/**
 * Indirizzo del backend.
 *
 * È l'unica cosa che questo client sa di `apps/api`: nessun import di codice, solo un URL e il
 * contratto HTTP (CLAUDE.md Regola 1).
 */
export const apiBaseUrl: string = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3000';

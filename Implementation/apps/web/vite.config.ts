import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * I file d'ambiente si leggono dalla **radice del monorepo**, non da questa cartella.
 *
 * Senza questa riga `envDir` cade sulla radice del progetto Vite — cioè `apps/web/` — e
 * `Implementation/.env`, l'unico file che il README dice di copiare, non viene letto affatto. Il
 * difetto è vecchio quanto il progetto e lo nascondeva un ripiego: `VITE_API_BASE_URL` è dichiarata
 * nel `.env.example` della radice fin dal M0 con il commento «letta da Vite al build», e non lo era —
 * funzionava solo perché `api-base-url.ts` cabla `http://localhost:3000` come valore di riserva.
 *
 * Un solo file d'ambiente per tutto il monorepo, quindi, e una sola istruzione nel README. Le
 * variabili dell'ambiente del processo continuano a vincere sui file (è così che la CI le passa), e
 * `loadEnv` filtra per prefisso `VITE_`: `DATABASE_URL` e le password del seed, che stanno nello
 * stesso file, non raggiungono il bundle.
 */
export default defineConfig({
  envDir: '../..',
  plugins: [react()],
  server: { port: 5173, strictPort: true },
  preview: { port: 4173 },
  build: { outDir: 'dist', sourcemap: true },
});

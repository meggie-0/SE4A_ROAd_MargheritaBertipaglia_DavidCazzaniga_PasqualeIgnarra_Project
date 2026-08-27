import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * I file d'ambiente si leggono dalla **radice del monorepo**, non da questa cartella.
 *
 * Senza questa riga `envDir` cade sulla radice del progetto Vite — cioè `apps/passenger/` — e
 * `Implementation/.env`, l'unico file che il README dice di copiare, non viene letto affatto.
 *
 * Qui il difetto costava più che nella dashboard: `VITE_MAPTILER_API_KEY` non arrivava, quindi
 * `reverseGeocodeMilanPoint()` sollevava, il punto di ritiro non si poteva selezionare e non si
 * arrivava a richiedere una corsa. Il rimedio era un secondo file d'esempio in questa cartella, che
 * nessuna istruzione diceva di copiare — cioè la trappola dei due file, che è la causa vera. Un file
 * solo, alla radice, e una sola istruzione.
 *
 * Le variabili dell'ambiente del processo continuano a vincere sui file (è così che la CI le passa),
 * e `loadEnv` filtra per prefisso `VITE_`: `DATABASE_URL` e le password del seed, che stanno nello
 * stesso file, non raggiungono il bundle.
 */
export default defineConfig({
  envDir: '../..',
  plugins: [react()],
  server: { port: 5174, strictPort: true },
  preview: { port: 4174 },
  build: { outDir: 'dist', sourcemap: true },
});

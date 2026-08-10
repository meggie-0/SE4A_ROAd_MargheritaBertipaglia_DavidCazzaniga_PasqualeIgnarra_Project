import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * Il complemento di dependency-cruiser (HARNESS.md §3).
 *
 * dependency-cruiser guarda gli import: chi importa cosa. Questo test guarda l'array `exports`
 * dei `@Module`, cioè cosa Nest rende *iniettabile* fuori dal modulo. Sono due superfici diverse:
 * si può rispettare la prima e sfondare la seconda esportando un manager concreto, che poi
 * qualcuno inietterà al posto della porta.
 *
 * Regola: l'array `exports` di un @Module può contenere solo classi il cui nome finisce in `Port`
 * (CLAUDE.md Regola 1). Gli altri moduli Nest ri-esportati sono ammessi: `exports: [SomeModule]`
 * non espone implementazioni, espone di nuovo le porte di quel modulo.
 */

const apiSrc = resolve(__dirname, '..', '..', 'src');

function collectModuleFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collectModuleFiles(full, found);
    else if (entry.endsWith('.module.ts')) found.push(full);
  }
  return found;
}

/** Estrae il contenuto testuale dell'array `exports: [...]` di un decoratore @Module. */
function exportedSymbols(source: string): string[] {
  const match = /exports\s*:\s*\[([^\]]*)\]/.exec(source);
  const body = match?.[1];
  if (body === undefined) return [];
  return body
    .split(',')
    .map((entry) => entry.replace(/\/\/.*$/gm, '').trim())
    .filter((entry) => entry.length > 0);
}

describe('Confini fra moduli: gli @Module esportano solo porte', () => {
  const moduleFiles = collectModuleFiles(apiSrc);

  it('trova almeno un modulo Nest da controllare', () => {
    // Se questo test passasse a vuoto, tutto il resto del file sarebbe teatro.
    expect(moduleFiles.length).toBeGreaterThan(0);
  });

  it.each(moduleFiles.map((file) => [relative(apiSrc, file).replace(/\\/g, '/'), file]))(
    '%s esporta solo classi *Port (o altri moduli Nest)',
    (_label, file) => {
      const exported = exportedSymbols(readFileSync(file, 'utf8'));
      const illegal = exported.filter(
        (symbol) => !symbol.endsWith('Port') && !symbol.endsWith('Module'),
      );

      expect(illegal).toEqual([]);
    },
  );
});

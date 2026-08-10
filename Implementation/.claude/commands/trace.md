---
description: Mostra la copertura dei requisiti e segnala quelli scoperti
allowed-tools: Bash, Read, Grep
---

Esegui `pnpm trace` e presenta la matrice di copertura dei requisiti.

Poi indica esplicitamente:

- quali requisiti attesi dalle milestone già completate non hanno ancora nessun test;
- quali requisiti hanno test che li nominano ma con asserzioni deboli (per esempio un solo caso
  felice, senza casi limite né errori);
- se la tabella prodotta è coerente con quella del DD §4, e in cosa differisce.

Non inventare copertura: se un requisito non ha test, dillo.

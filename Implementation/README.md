# ROAd — Robotaxi Optimized Allocation

This directory contains the implementation of **ROAd (Robotaxi Optimized Allocation)**, developed for the *Software Engineering for Automation* course at Politecnico di Milano.

The system consists of:

- a **NestJS backend** providing the application API and business logic;
- an **operator dashboard** for fleet monitoring and management;
- a **passenger application** for ride requests and reservations;
- a **PostgreSQL database**;
- a **robotaxi fleet simulator** used to emulate vehicle movement and telemetry.

---

## Prerequisites

The implementation is intended to be run on **Windows**.

All installation, execution, and demo commands reported in this document are therefore provided for **Windows PowerShell**.

The following software is required:

| Software | Required version |
|---|---|
| Node.js | >= 20.12 |
| pnpm | 11.x |
| Docker Desktop | Recent version with Docker Compose v2 |
| Git | Recent version |

Node.js includes `npm`, which can be used to install the required pnpm version:

```powershell
npm install -g pnpm@11.21.0
```

Verify the installation with:

```powershell
node --version
npm --version
pnpm --version
docker --version
docker compose version
git --version
```

The pnpm version used by the project is also defined in `package.json`.

---

## Dependencies and assumptions

The implementation assumes that:

- the software is executed on Windows using PowerShell;
- Docker Desktop is installed and running;
- Docker can start a local PostgreSQL container;
- ports `3000`, `5173`, `5174`, and `5432` are available;
- commands are executed from the `Implementation/` directory;
- the local development configuration is created from `.env.example`;
- Internet access is available when using the default external map, geocoding, and routing services.

By default, the backend uses the public OSRM routing service configured through `OSRM_BASE_URL`. If the service is unavailable, the backend can fall back to a linear distance-based estimate.

The passenger application uses MapTiler for map/geocoding functionality and OSRM for road routing. The corresponding services can be changed through the variables in `.env`.

PostgreSQL runs through Docker Compose. The required database initialization, including the `btree_gist` extension, is automatically performed when the database volume is created.

---

## Installation

Clone the repository and move to the implementation directory:

```powershell
cd Implementation
```

Install all project dependencies:

```powershell
pnpm install
```

Create the local environment configuration from the provided example:

```powershell
Copy-Item .env.example .env
```

The values provided in `.env.example` are suitable for local development and demonstration.

Start PostgreSQL:

```powershell
docker compose up -d
```

Docker Desktop must be **open and fully started** before running this command. The first time, the command **downloads the PostgreSQL image**, which can take a few minutes; later runs start immediately.

Apply the database migrations:

```powershell
pnpm db:migrate
```

Populate the database with the initial data:

```powershell
pnpm db:seed
```

Start the backend and both frontend applications:

```powershell
pnpm dev
```

Once started, the services are available at:

| Service | URL |
|---|---|
| Backend API | http://localhost:3000 |
| Swagger / OpenAPI | http://localhost:3000/docs |
| Operator dashboard | http://localhost:5173 |
| Passenger application | http://localhost:5174 |

The default development accounts created by `pnpm db:seed` are:

| Application | Email | Password |
|---|---|---|
| Operator dashboard | `operatore@road.example` | `operatore-di-sviluppo` |
| Passenger application | `passeggero@road.example` | `passeggero-di-sviluppo` |

These credentials can be changed through the corresponding `SEED_*` variables in `.env`.

Stop the running applications with:

```text
Ctrl+C
```

To stop the PostgreSQL container:

```powershell
docker compose down
```

---

## Demo commands

The repository provides four predefined demonstration scenarios.

Before running a demo:

- Docker Desktop must be running;
- `pnpm install` must have been executed;
- ports `3000`, `5173`, and `5174` must be free;
- no existing `pnpm dev` instance should be running.

Each demo automatically prepares the required database state and starts the application stack.

In the immediate-ride, advance-booking and traffic scenarios, `Demo pronta` is followed by a 7-second countdown («La demo comincia fra 7…»), which leaves time to open the pages and sign in; nothing happens before `La demo è cominciata`. The margin can be changed, or removed with 0, through the `DEMO_START_DELAY_SECONDS` environment variable, for example `$env:DEMO_START_DELAY_SECONDS="10"` before the command.
For details on the demonstration environment, scenarios and diagrams,

see [Demonstration Environment](docs/DEMONSTRATION.md).


### Scenario 1 - Immediate ride

```powershell
pnpm demo:immediate --live
```

Demonstrates an immediate passenger ride request, robotaxi allocation, vehicle approach, passenger pickup, and ride execution.

- **Open:** wait for `Demo pronta` in the terminal (the first API compilation can take a minute), then, during the countdown, open the passenger application at http://localhost:5174 with the passenger account and the operator dashboard at http://localhost:5173 with the operator account.
- **Do:** in the passenger application, select the pickup point and the destination on the map and request the ride.
- **Watch:** the ride panel goes through assignment, approach, pickup, and ride; on the dashboard the assigned robotaxi moves and the operational log («Log operativo») updates in real time.
- **Duration:** about two minutes, depending on the chosen route.
- A ride can be requested from the passenger application during the other scenarios too; this one is simply the quietest.

### Scenario 2 - Advance booking

```powershell
pnpm demo:advance
```

Demonstrates the creation of an advance booking and its automatic activation before the requested departure time.

- **Open:** wait for `Demo pronta` in the terminal, then, during the countdown, open the passenger application at http://localhost:5174 with the passenger account and the operator dashboard at http://localhost:5173 with the operator account.
- **Do:** book a ride with a departure **two or three minutes from now**. In this demo the activation happens 1 minute before the departure time instead of 15.
- **Watch:** the booking first appears among the scheduled rides, without a robotaxi; one minute before the departure time the system activates it by itself, assigns a robotaxi, and the ride starts.
- **Duration:** about three or four minutes.

### Scenario 3 - Traffic-aware allocation

```powershell
pnpm demo:traffic
```

Demonstrates changing traffic conditions, automatic allocation-strategy switching, and traffic-aware robotaxi assignment.

- **Open:** when `Demo pronta` appears, open the operator dashboard at http://localhost:5173 with the operator account during the countdown. Nothing needs to be pressed.
- **Watch:** timings are counted from `La demo è cominciata` and can shift by up to ten seconds; the first ride requests arrive about ten seconds after it. At 60 s traffic in the centre reaches MEDIUM, a suggestion appears, but the strategy does not change. At 90 s it reaches HIGH and the strategy switches by itself to «ETA minimo». At 150 s (MEDIUM) it stays there, and at 180 s (LOW) it returns to «Più vicino disponibile».
- In the operational log, lines ending in «… il più vicino, RT-xx, ne avrebbe impiegati …» are assignments where the algorithm picked a robotaxi that is farther away but faster. The minutes in the log are simulated-world minutes: the world runs about 30 times faster than the clock.
- **Duration:** about three minutes. The 51 ride requests are generated automatically with a fixed seed, so they are the same at every run; which robotaxi serves each one can vary slightly, because the stack runs in real time and the travel-time estimates come from the OSRM service.

### Scenario 4 - Fleet rebalancing

```powershell
pnpm demo:rebalancing
```

Demonstrates automatic fleet rebalancing toward an area with increased expected demand.

- **Open:** open the operator dashboard at http://localhost:5173 with the operator account **immediately** after `Demo pronta`: the first robotaxi leaves within a few seconds. Nothing needs to be pressed.
- **Watch:** there is a football match at San Siro, a scene staged by the demo dataset (`pnpm db:demo`). Idle robotaxis from other zones switch to «In riposizionamento» and head to the stadium, one every 15 seconds, and the log records each decision. Each one becomes available again when it reaches the zone.
- **Duration:** about two minutes of departures; after that the fleet stays still. The alert panel keeps the history after a reload.

The demo stack remains active until it is stopped with:

```text
Ctrl+C
```

For the automated version of the immediate-ride scenario, Playwright Chromium must first be installed:

```powershell
pnpm exec playwright install chromium
```

The automated scenario can then be executed with:

```powershell
pnpm demo:immediate
```

---

## Verification

`pnpm verify` is the complete check, the same one that runs in CI. It executes nine steps in order and stops at the first one that fails: package build, typecheck, lint with the determinism rules and Prettier, module boundaries, OpenAPI contract, unit tests, milestone gates, requirement traceability, and integration tests on a real PostgreSQL. Docker Desktop must be running, because the integration tests start their own PostgreSQL container.

```powershell
pnpm verify
```

`pnpm trace` cross-references the 34 requirements and goals of the RASD in `docs/requirements.json` (R1–R14, NFR1–NFR10, G1–G10) with the tests that name them, and fails if a requirement of a completed milestone has no test. On the current version it reports full coverage: 34/34.

```powershell
pnpm trace
```

The design choices behind the implementation are documented in [`docs/DD.md`](docs/DD.md).

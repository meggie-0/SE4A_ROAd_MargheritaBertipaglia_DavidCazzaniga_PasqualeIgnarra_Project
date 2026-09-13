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

### Scenario 1 - Immediate ride

```powershell
pnpm demo:immediate --live
```

Demonstrates an immediate passenger ride request, robotaxi allocation, vehicle approach, passenger pickup, and ride execution.

### Scenario 2 - Advance booking

```powershell
pnpm demo:advance
```

Demonstrates the creation of an advance booking and its automatic activation before the requested departure time.

### Scenario 3 - Traffic-aware allocation

```powershell
pnpm demo:traffic
```

Demonstrates changing traffic conditions, automatic allocation-strategy switching, and traffic-aware robotaxi assignment.

### Scenario 4 - Fleet rebalancing

```powershell
pnpm demo:rebalancing
```

Demonstrates automatic fleet rebalancing toward an area with increased expected demand.

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
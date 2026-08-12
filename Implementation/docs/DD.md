# DD — Design Document

**ROAd — Autonomous Mobility Application**

| | |
|---|---|
| Authors | Margherita Bertipaglia, David Cazzaniga, Pasquale Ludovico Ignarra |
| University | Politecnico di Milano |
| Course | Software Engineering for Automation |
| Academic year | 2025-2026 |
| Date | July 2026 |

> **Nota sull'estrazione.** Questo file nasce come trascrizione integrale del testo di
> `../DD/ROAd__DD.pdf` (19 pagine), estratta con `pdftotext` e riformattata in Markdown senza
> riassumere. La numerazione dei capitoli e i riferimenti a requisiti `[Rn]`/`[NFRn]`, goal `[Gn]` e
> vincoli `[Cn]` sono quelli originali. Le figure, che nel PDF sono immagini, sono rese come sorgenti
> PlantUML presi da `../DD/diagrams/` (fedeli all'originale) e — per la FSM di design, disegnata in
> draw.io — come tabella di transizione trascritta dal PDF.
>
> **Da v1.1 questo Markdown è la fonte autorevole**, non il PDF: il PDF v1.0 verrà rigenerato a fine
> progetto a partire da qui. Tutte le modifiche rispetto al PDF v1.0 sono raccolte nell'
> [Appendice A — Registro delle decisioni](#appendice-a--registro-delle-decisioni), e nel corpo del
> documento sono marcate con la versione che le ha introdotte — **[v1.1]** o **[v1.2]**.

---

## Contents

1. [Introduction](#1-introduction) — 2
   - 1.1 [Purpose](#11-purpose) — 2
   - 1.2 [Definitions, Acronyms, Abbreviations](#12-definitions-acronyms-abbreviations) — 2
   - 1.3 [Revision history](#13-revision-history) — 3
   - 1.4 [Document Structure](#14-document-structure) — 3
2. [Architectural Design](#2-architectural-design) — 4
   - 2.1 [Overview and architectural style](#21-overview-and-architectural-style) — 4
   - 2.2 [Component view](#22-component-view) — 4
   - 2.3 [Class view](#23-class-view) — 6
     - 2.3.1 [AllocationManager (Strategy)](#231-allocationmanager-strategy) — 6
     - 2.3.2 [Robotaxi (State)](#232-robotaxi-state) — 7
     - 2.3.3 [NotificationManager (Observer)](#233-notificationmanager-observer) — 7
   - 2.4 [Runtime view](#24-runtime-view) — 8
   - 2.5 [Deployment view](#25-deployment-view) — 10
   - 2.6 [Selected architectural styles and patterns](#26-selected-architectural-styles-and-patterns) — 11
     - 2.6.1 [Strategy — allocation algorithms](#261-strategy--allocation-algorithms) — 11
     - 2.6.2 [Observer — state-change notifications](#262-observer--state-change-notifications) — 11
     - 2.6.3 [State — robotaxi lifecycle](#263-state--robotaxi-lifecycle) — 11
     - 2.6.4 [Other patterns and styles](#264-other-patterns-and-styles) — 12
3. [User Interface Design](#3-user-interface-design) — 13
   - 3.1 [Passenger mobile app](#31-passenger-mobile-app) — 13
   - 3.2 [Operator web dashboard](#32-operator-web-dashboard) — 13
4. [Requirements Traceability](#4-requirements-traceability) — 15
   - 4.1 [Functional requirements](#41-functional-requirements) — 15
   - 4.2 [Non-functional requirements](#42-non-functional-requirements) — 16
5. [Implementation, Integration and Test Plan](#5-implementation-integration-and-test-plan) — 17
   - 5.1 [Feature prioritisation](#51-feature-prioritisation) — 17
   - 5.2 [Implementation and integration order](#52-implementation-and-integration-order) — 17
   - 5.3 [Testing strategy](#53-testing-strategy) — 18
6. [References](#6-references) — 19
- [Appendice A — Registro delle decisioni](#appendice-a--registro-delle-decisioni)

---

# 1 Introduction

## 1.1 Purpose

This is the Design Document (DD) of ROAd (Robotaxi Optimized Allocation). The document describes how
the system is built: the software architecture, the components and their interfaces, the way they
interact at runtime, the design patterns we adopt, the user interface, the mapping from requirements
to design, and the plan to implement, integrate and test the system.

### Main Goals

ROAd supports the management of an autonomous taxi fleet in a city. Passengers can request immediate
rides or book rides in advance from a mobile app; the system assigns a suitable robotaxi according
to a vehicle-allocation strategy that the fleet operator can choose at runtime. The system tracks
the lifecycle of each robotaxi, notifies passengers about relevant events, lets the operator monitor
the fleet from a web dashboard, and proactively rebalances available robotaxis toward areas of
expected high demand. Autonomous driving, mapping and payment are treated as external dependencies
and are not implemented as part of the system.

The design explicitly addresses these goals in terms of design patterns:

- **Strategy** pattern for switching between allocation algorithms.
- **Observer** pattern for notifying users when the state of a vehicle changes.
- **State** pattern for managing the lifecycle of a robotaxi.

## 1.2 Definitions, Acronyms, Abbreviations

### Definitions

- **Component**: A modular, replaceable unit of the system that provides and requires services
  through well-defined interfaces.
- **Tier**: A physical (deployment) layer of the architecture. ROAd is organised in three tiers:
  presentation, application, data.
- **S2B — Software To Be**: The ROAd backend together with the two clients.
- **Manager**: An internal backend component responsible for one coherent area of the application
  logic (e.g. `AllocationManager`).
- **Gateway**: A component that mediates access to an external system, hiding its specific protocol
  from the rest of the system.
- **Context**: In the State/Strategy patterns, the object that delegates part of its behaviour to a
  separate state/strategy object.

### Acronyms

- **DD** (Design Document)
- **RASD** (Requirements Analysis and Specification Document)
- **API** (Application Programming Interface)
- **REST** (Representational State Transfer)
- **MVC** (Model-View-Controller)
- **ETA** (Estimated Time of Arrival)
- **FSM** (Finite State Machine)
- **UML** (Unified Modeling Language)

### Abbreviations

- **[Rn]** n-th functional requirement
- **[NFRn]** n-th non-functional requirement
- **[Cn]** n-th component
- **[UCn]** n-th use case

## 1.3 Revision history

| Version | Date | Description |
|---|---|---|
| 1.0 | July 11, 2026 | Initial release of the Design Document |
| 1.1 | August 10, 2026 | **[v1.1]** Realisation decisions taken before implementation: port signatures aligned with the code contract, Observer realisation, `IllegalTransitionError` naming, reservation timeline for immediate rides, advance-booking activation, zone membership rule, `enableAuto()` re-evaluation, demand ranking, operational definitions for NFR3/NFR6/NFR8, R14. See [Appendice A](#appendice-a--registro-delle-decisioni). |
| 1.2 | August 11, 2026 | **[v1.2]** Decisions taken while implementing the ride request flows (M4), and the resolution of two contradictions the document carried: R14 required a cancelled ride to free an already assigned vehicle while Figure 2.10 gave `ASSIGNED` no exit towards `AVAILABLE` (transition 11 added), and Figures 2.5 and the activation diagram disagreed on the order of `reserve()` and `assign()`. Also: the `RideRequestManager` arcs missing from Figure 2.1, the sixth `FleetMonitor` operation, the nominal filtering window of Figure 2.8, and the meaning of "still eligible" at activation. See decisions D27–D33 in [Appendice A](#appendice-a--registro-delle-decisioni). |
| 1.3 | August 12, 2026 | **[v1.3]** Decisions taken while implementing the notification channel (M5), and the resolution of the gap the document carried on its second subject: Section 2.3.3 draws `Ride` as a `Subject` with a `RideStatus`, but no table, no component operation and no flow ever created one — the entity existed in the RASD and nowhere in this design. Also: the four lifecycle transitions that had no way of being triggered, the two ports of `notifications`, the three arcs Figure 2.1 was missing, token verification outside the HTTP path, and the ordering rule between persisting a transition and notifying it. See decisions D36–D46 in [Appendice A](#appendice-a--registro-delle-decisioni). |

## 1.4 Document Structure

- **Chapter 1 — Introduction**: Purpose, terminology, revision history, structure.
- **Chapter 2 — Architectural Design**: The architectural style, the component view, the class view
  of the most relevant components, the runtime view, the deployment view, and the selected styles
  and design patterns.
- **Chapter 3 — User Interface Design**: An overview of the passenger app and of the operator
  dashboard through wireframes.
- **Chapter 4 — Requirements Traceability**: How the requirements of the RASD are satisfied by the
  components and patterns of this document.
- **Chapter 5 — Implementation, Integration and Test Plan**: The order in which we plan to
  implement, integrate and test the subcomponents.
- **Chapter 6 — References**

---

# 2 Architectural Design

## 2.1 Overview and architectural style

ROAd adopts a **three-tier client-server architecture**:

- A **presentation tier** with two thin clients:
  1. The Passenger Mobile App
  2. The Operator Web Dashboard
- An **application tier** for the ROAd backend (the S2B core), which contains all the management
  logic, organised as a set of cooperating components behind an API Gateway.
- A **data tier** for a single relational database that stores accounts, requests, rides, vehicles
  and reservations.

This style is useful for three main reasons.

First, the two kinds of user need different clients (a mobile app for passengers, a data-rich web
console for operators), but they must work on the same, consistent state: a centralized server is
the natural place to realize this constraint, which is also what lets us prevent conflicting
assignments (NFR4, C1).

Second, the application tier is internally layered: the business logic never talks to an external
system directly but always through the `ExternalServicesGateway`, so the volatile parts (mapping
provider, demand source, vehicle protocol) are isolated from the stable core (NFR8, separation of
concerns).

Third, the authoritative shared state is stored in the data tier, while the application tier keeps
only disposable local caches. The backend can therefore be replicated horizontally, which supports
scalability (NFR3) and concurrency (NFR1).

Inside the backend we also use, locally, two well-known styles: **MVC** on the client side (the
views are a function of an observable model) and an **event-driven** mechanism for notifications,
realised with the Observer pattern (Section 2.6).

## 2.2 Component view

Figure 2.1 shows the high-level component diagram. The backend is decomposed into
single-responsibility managers; each one exposes a small interface and depends on the others only
through those interfaces.

#### Figure 2.1: High-level component diagram of ROAd

with the two clients, the backend managers, the database, and the external systems.
Source: `../DD/diagrams/component_diagrams/main_components.puml`

```plantuml
component "Passenger Client" as PassengerClient
component "Fleet Operator" as FleetOperator

package "Backend" {
    component "API Gateway" as APIGateway
    () "IClientAPI"
    () "IOperatorAPI"

    component "Authentication Manager" as AuthenticationManager
    () "IAuthenticationService"

    component "Ride Request Manager" as RideRequestManager
    () "IRideRequestService"

    component "Fleet Monitor" as FleetMonitor
    () "IFleetMonitorService"

    component "Mode Controller" as ModeController
    () "IModeControlService"

    component "Maintenance Manager" as MaintenanceManager
    () "IMaintenanceService"

    component "Allocation Manager" as AllocationManager
    () "IAllocationService"

    component "Persistence Manager" as PersistenceManager
    () "IPersistenceService"

    component "External Services Gateway" as ExternalServicesGateway
    () "IExternalServices"

    component "Notification Manager" as NotificationManager
    () "INotificationService"
    () "INotificationSessionService"

    component "Rebalancing Manager" as RebalancingManager
}

database "Database" as DB
node "External Systems\n\nmaps, traffic,\ndemand,\nrobotaxi fleet" as ExternalSystems

PassengerClient --( IClientAPI
FleetOperator --( IOperatorAPI

APIGateway -up- IClientAPI
APIGateway -up- IOperatorAPI

APIGateway --( IAuthenticationService
APIGateway --( IRideRequestService
APIGateway --( IFleetMonitorService
APIGateway --( IModeControlService
APIGateway --( IMaintenanceService
APIGateway --( INotificationSessionService

AuthenticationManager -up- IAuthenticationService
RideRequestManager   -up- IRideRequestService
FleetMonitor         -up- IFleetMonitorService
ModeController       -up- IModeControlService
MaintenanceManager   -up- IMaintenanceService
AllocationManager    -up- IAllocationService
PersistenceManager   -up- IPersistenceService
ExternalServicesGateway -up- IExternalServices
NotificationManager  -up- INotificationService
NotificationManager  -up- INotificationSessionService

RideRequestManager --( IPersistenceService
RideRequestManager --( IAllocationService
RideRequestManager --( INotificationService
RideRequestManager --( IFleetMonitorService
RideRequestManager --( IExternalServices

AllocationManager --( IExternalServices

FleetMonitor --( IPersistenceService
FleetMonitor --( IExternalServices
FleetMonitor --( INotificationService

NotificationManager --( IPersistenceService

ModeController --( IAllocationService
ModeController --( INotificationService

MaintenanceManager --( IFleetMonitorService
MaintenanceManager --( IPersistenceService
MaintenanceManager --( INotificationService

RebalancingManager --( IFleetMonitorService
RebalancingManager --( IExternalServices
RebalancingManager --( IPersistenceService
RebalancingManager --( INotificationService

PersistenceManager --> DB : stores and retrieves data
ExternalServicesGateway --> ExternalSystems : adapts external APIs
```

The main components and the operations they export are:

- **API Gateway**: Single entry point for the clients. Exposes the REST endpoints and the WebSocket
  channel used to push notifications. Routes each call to the right manager and enforces
  authentication.
- **AuthenticationManager**: `authenticate()`, `register()`, `updateProfile()`. Manages accounts and
  issues the signed access tokens with which callers identify themselves (R1, R2). **[v1.1]** *(v1.0
  said "accounts and sessions"; there are no sessions — NFR3 excludes any server-side session state,
  and Section 2.2.1 states what the component does and does not own.)*
- **RideRequestManager**: `submitImmediate()`, `submitAdvance()`, `cancel()`. Validates requests,
  coordinates advance reservations and drives the request lifecycle (R3, R4, R14). **[v1.2]** It
  also owns `AdvanceBookingActivator.runOnce()`, published as a second port of the component
  (decision D33), and it reaches `IFleetMonitorService` and `IExternalServices` — two arcs the v1.1
  Figure 2.1 omitted although Figure 2.9 and Figure 2.5 both used them (decision D29). **[v1.3]** A
  **third port**, `IRideLifecycleService` (`startPickupNavigation()`, `pickupReached()`,
  `startRide()`, `completeRide()`), advances an assigned ride to its destination, moving the vehicle
  and the `Ride` together — the vehicle first (decision D38). It owns the `ride` table and is the
  only writer of `RideStatus` (decision D36), and it reaches `INotificationService`, since `Ride` is
  the second `Subject` of Section 2.3.3.
- **AllocationManager**: `allocate(request, candidates)`, `setActiveStrategy()`. Selects the
  robotaxi to assign by delegating to the active allocation strategy (R5, R8). This is the context
  of the Strategy pattern.
- **ModeController**: `onTrafficLevel()`, `setManual()`, `enableAuto()`, `getMode()` **[v1.1]**.
  Implements Auto/Manual mode, the automatic strategy switching with hysteresis and the priority of
  human intervention (R12, R13, NFR9, NFR10). **[v1.4]** It owns `TrafficMonitor.runOnce()`,
  published as a **second port** of the component (decision D49), and it is the only writer that
  returns the mode to Auto; the opposite direction is written by `AllocationManager`, because R13
  ties the switch to Manual to the choice of a policy and the two must land in one transaction.
- **FleetMonitor**: `getCandidates()`, `getBookableRobotaxis()` **[v1.2]**,
  `getAvailableRobotaxis()`, `getFleetStatus()`, `assign()`,
  `startPickupNavigation()`, `pickupReached()`, `startRide()`, `completeRide()` **[v1.3]**,
  `releaseAssignment()` **[v1.2]**, `requestRebalancing()`. The four operations added in v1.3 are
  transitions 4-7 of Figure 2.10, which the figure defined from v1.0 and no component operation could
  trigger (decision D37). Keeps the real-time picture of every
  robotaxi (position, state) and coordinates vehicle lifecycle updates (R7, G6, G8). Each Robotaxi
  manages its own lifecycle through the State pattern. `releaseAssignment()` drives transition 11 and
  is what makes R14 realisable: `RideRequestManager` owns the cancellation, but the state column is
  written only here (decision D28).
- **RebalancingManager**: `analyzeDemand()`, `rebalance()`. Identifies high-demand zones and
  repositions available robotaxis (R10, R11, G9). **[v1.4]** It owns the `rebalancing_action` table,
  which records where each vehicle was sent — the target zone is neither a column of `robotaxi` nor
  an argument of `requestRebalancing()`, so without it the destination would be written nowhere. Its
  arc to `IExternalServices` is not yet realised: in this prototype the demand source is the
  `demand_sample` / `demand_event` pair, read through `IPersistenceService` (decision D47).
- **MaintenanceManager**: `requestMaintenance()`, `completeMaintenance()`. Marks robotaxis in/out of
  maintenance and prevents their assignment (R9). **[v1.3]** It is the second component that writes
  the state column, so it is also the second that notifies: a vehicle leaving the fleet disappears
  from the operator's map exactly as one that departs on a ride, and the dashboard must learn it
  without reloading (decision D42).
- **NotificationManager**: `update(event)`; `registerSession(session)`, `removeSession(session)`,
  `registeredSessions()` **[v1.3]**. Receives domain events and dispatches notifications to
  the interested clients (R6, G7). Concrete observer of the Observer pattern. The three session
  operations are published by a **second port** of the component: Section 2.3.3 already requires the
  manager to register and deregister sessions at connection and disconnection, but v1.2 listed only
  `update()` among its exported operations (decision D40).
- **PersistenceManager**: `create()`, `update()`, `find()` **[v1.1]**, `filterAvailable()`,
  `reserve()`. The only component that talks to the database; it filters candidates according to
  their availability timelines and atomically stores each advance booking together with the
  corresponding robotaxi reservation. It is where the uniqueness/consistency constraints live
  (NFR4, C1). `find()` is the read path that v1.0 used without listing — `findBookingsDueAt(now)`
  in §2.4 and the strategy/mode readers of §2.2.1 both go through it (decision D18).
- **ExternalServicesGateway**: `getETA()`, `getTraffic()`, `getDemandData()`, `commandRoute()`,
  `readTelemetry()`. A facade over the external systems (mapping service, demand data source,
  robotaxi fleet), with one adapter per provider (NFR8). **[v1.4]** The facade/adapter split becomes
  real here, with the second operation: one class delegates, one adapter per provider implements
  (decision D54). Operations enter the port with the milestone that puts them to use — `getETA()` in
  M3, `getTraffic()` in M6, the remaining three in M7.

### 2.2.1 Realisation notes **[v1.1]**

This subsection fixes the details that Section 2.2 left open and that the implementation needs in
order to be deterministic and testable. It does not change the decomposition of Figure 2.1.

**Exported operations, exact signatures.** Every component is reachable only through its interface,
realised in code as an abstract class (the *port*) that doubles as the injection token. Three
signatures are more precise than in v1.0:

- `AllocationManager.allocate(request, candidates): Robotaxi | null` — v1.0 declared a `Robotaxi`
  return type, but the RASD requires the request to be rejected when no feasible vehicle exists
  (RASD Figure 3.1, `[request rejected]` branch), so the absence of a selection must be
  representable.
- `AllocationManager.setActiveStrategy(name: StrategyName, source: 'auto' | 'manual'): void` — v1.0
  passed a strategy object. Passing the *name* keeps the caller free of concrete strategy classes,
  and passing the *origin* of the change lets a manual selection flip the strategy and the mode in a
  single atomic write, which is what NFR10 demands ("immediate and atomic transition to Manual
  Mode"). A companion reader `getActiveStrategy(): StrategyName` is added, needed by the dashboard
  and by R8.
- `ModeController.getMode(): Mode` — added, because NFR10 requires the current control mode to be
  always visible on the dashboard (Section 3.2), which needs a read path.

`RebalancingManager.analyzeDemand()` is exported **without arguments**: the
`analyzeDemand(demandData, trafficData, fleetStatus)` message in Figure 2.7 is a self-call, and the
manager gathers its own inputs from `ExternalServicesGateway` and `FleetMonitor` before computing.

**Ownership of the `system_mode` record.** The active strategy and the Auto/Manual mode are one
persistent record, so that every replica of the application tier reads the same authoritative value
(NFR3). `AllocationManager.setActiveStrategy()` is the only writer of the active strategy, and it
also sets the mode to Manual in the same transaction when `source` is `'manual'`.
`ModeController.enableAuto()` is the only writer that sets the mode back to Auto. Both read paths
(`getActiveStrategy()`, `getMode()`) go through `PersistenceManager`; this is the
`AllocationManager → PersistenceManager` edge already shown in the deployment view (Figure 2.9).

**`AllocationManager` does not depend on `FleetMonitor`.** As in Figure 2.1, the candidate set is
produced by `FleetMonitor.getCandidates()` and passed *into* `allocate()` by `RideRequestManager`.
The allocation component therefore depends only on `ExternalServicesGateway` and
`PersistenceManager`, which keeps each strategy testable with a plain list of vehicles.

**Authentication has no sessions, and the `AuthenticationManager` does not verify tokens.** Section
2.2 describes the component as managing "accounts and sessions", but NFR3 (Section 4.3) rules out
any server-side session state: there is no session to manage. What the component owns is the
account — `register()`, `authenticate()`, `updateProfile()` — and the issuing of a single signed
access token, with no refresh token, because a refresh token would require a register of revoked
tokens, which is exactly the state NFR3 excludes.

*Verifying* a token on each request is a different responsibility, and it belongs to the request
path that Figure 2.1 already assigns to the API Gateway ("enforces authentication"). It is realised
as guards, published by a **second port** of the authentication component alongside the service
port — the same split already used by `FleetMonitor` (service) and `Robotaxi` (vocabulary). The
gateway *applies* the guards to its routes; it does not implement them. A guard reconstructs the
caller from the token alone and reads no store, in memory or persistent, which is what makes the
NFR3 proposition of Section 4.3 true and testable.

Two consequences worth stating, because they are what the design buys and what it costs:

- a token stays valid until it expires even if the account behind it changes or disappears. The
  short lifetime is the mitigation; the alternative — checking the account on every request — would
  reintroduce the shared read that NFR3 exists to avoid;
- the exported operations stay **three**. Reading a profile back is not among them: registration,
  login and update all return the profile, which covers R1 and R2. A read path will be added as a
  declared fourth operation if and when a client needs it, rather than by calling `updateProfile()`
  with an empty change.

**Registration creates passengers only.** RASD Section 1.4 lists "Passenger registration",
"Passenger login" and "Fleet operator login", but no operator registration: the public endpoint
therefore always creates a `PASSENGER`. The role is a parameter of the port, not of the HTTP
contract, so that operator accounts can be provisioned — in this prototype by the seed — through the
same code path that hashes every other password.

**Zone membership.** A `Zone` is a partition of the urban area (RASD §2.2.1), realised as a
**Voronoi partition over the zone centroids**: a point belongs to the zone whose centroid is nearest
by haversine distance, ties broken by ascending `zoneID`. There is no zone radius: a radius would
leave both uncovered points and overlaps, and "partition" excludes either.

**Expected demand and ranking.** `analyzeDemand()` estimates, for each zone `z` at instant `t`:

```
expectedDemand(z, t) = base(z, weekdayHourSlot(t)) * Π multiplier(e)
                                                     for each event e active in z at t
```

where `base` is the historical baseline per zone and weekly hour slot, and an event is active when
`t ∈ [e.start, e.end)`. Zones are returned by **descending expected demand, ties broken by ascending
`zoneID`**. `rebalance()` then ranks zones by
`deficit(z) = expectedDemand(z, t) − availableRobotaxisIn(z)` and, for each zone with a positive
deficit taken in that order, sends the nearest idle robotaxi drawn from a zone in surplus, ties
broken by ascending `robotaxiID`. Every ordering is total and deterministic, so the tests are stable.

**Periodic work.** The design contains no timer inside the business logic. Each periodic activity is
a component with a public `runOnce()` driven by a scheduler in production and called directly by the
tests:

| Driver | Component | Drives |
|---|---|---|
| `RebalancingScheduler.runOnce()` | RebalancingManager | the cycle of Figure 2.7 |
| `TrafficMonitor.runOnce()` | ModeController | reads `getTraffic()` and calls `onTrafficLevel()` (Figure 2.6) |
| `AdvanceBookingActivator.runOnce()` | RideRequestManager | activates due bookings (see §2.4) |

**Validation and the published contract.** Request and response shapes are declared once as schemas
shared by backend and clients, and the REST contract published by the API Gateway is generated from
the same source, so a change to a payload cannot reach the clients unnoticed.

## 2.3 Class view

This section zooms into the three components that carry the patterns required for the project. The
remaining components are mostly procedural and do not need a class-level view.

### 2.3.1 AllocationManager (Strategy)

Figure 2.2 shows the classes of the allocation logic. The `AllocationManager` holds a reference to an
abstract `AllocationStrategy` and calls `selectRobotaxi()` on it; the two concrete strategies
(`NearestAvailableStrategy`, `MinimumETAStrategy`) implement the actual policy. The `ModeController`
is the object that swaps the active strategy at runtime.

**[v1.1]** The signatures below carry the refinements of §2.2.1: `allocate()` may return no vehicle,
and `setActiveStrategy()` takes the strategy *name* plus the *origin* of the change.

**[v1.4]** The two `ModeController` attributes drawn in Figure 2.2 — `autoMode` and
`currentTrafficLevel` — are **not fields of the object**. They are two columns of the `system_mode`
record (decisions D6 and D20), and the component holds no state at all: with a replicable
application tier (NFR3) a value kept in memory would diverge from the column as soon as another
instance handled a traffic reading, and the dashboard would show a mode different from the one the
system is allocating with. The figure keeps them because they are the *state* the component governs;
where that state lives is a realisation detail fixed here.

**[v1.1]** `selectRobotaxi()` carries the same multiplicity `[0..1]` as `allocate()`. The manager is
a context that delegates and returns what the strategy returned, so a manager that can decline while
its strategies cannot is not implementable: the absence of a selection has to be representable on
both sides of the delegation (decision D24). Ties are broken deterministically — the smallest
`robotaxiID` at equal score — and a candidate whose score cannot be computed is not eligible
(decision D25).

**[v1.1]** The manager holds the **registry** of the registered strategies and not a reference to
the active one alone. The authoritative seat of the active strategy is the `system_mode` record
(decision D6), so the manager resolves it by name on every `allocate()`: a reference kept in memory
would be a second copy of that value, and it would diverge from the column as soon as another
replica changed it (NFR3). The pattern is unaffected — the context still knows no concrete class
and still delegates — but the association is `1 o--> 1..*` and the choice of which policy to use is
a lookup (decision D26).

Asynchrony is a realisation detail and is not represented in Figure 2.2. `MinimumETAStrategy` asks
`ExternalServicesGateway` for the ETAs (Figure 2.5), so `selectRobotaxi()` and, through it,
`allocate()` complete asynchronously; policies that need no I/O pay only an already-resolved
promise, which is the price of a single signature for all of them.

#### Figure 2.2: Class diagram of the AllocationManager

The Strategy pattern applied to vehicle allocation.
Source: `../DD/diagrams/class_diagrams/allocation_manager.puml`

```plantuml
class AllocationStrategy <<interface>> {
    + selectRobotaxi(request: RideRequest, candidates: List<Robotaxi>): Robotaxi [0..1]
}

class NearestAvailableStrategy {
    + selectRobotaxi(request: RideRequest, candidates: List<Robotaxi>): Robotaxi [0..1]
}

class MinimumETAStrategy {
    + selectRobotaxi(request: RideRequest, candidates: List<Robotaxi>): Robotaxi [0..1]
}

class AllocationManager {
    - strategies: Map<StrategyName, AllocationStrategy>
    --
    + allocate(request: RideRequest, candidates: List<Robotaxi>): Robotaxi [0..1]
    + setActiveStrategy(name: StrategyName, source: ChangeSource): void
    + getActiveStrategy(): StrategyName
}

class ModeController {
    - autoMode: boolean
    - currentTrafficLevel: TrafficLevel
    --
    + onTrafficLevel(level: TrafficLevel): void
    + setManual(name: StrategyName): void
    + enableAuto(): void
    + getMode(): Mode
}

enum StrategyName {
    NEAREST_AVAILABLE
    MINIMUM_ETA
}

enum ChangeSource {
    AUTO
    MANUAL
}

enum Mode {
    AUTO
    MANUAL
}

AllocationStrategy <|.. NearestAvailableStrategy
AllocationStrategy <|.. MinimumETAStrategy

AllocationManager "1" o--> "1..*" AllocationStrategy : registered strategies
ModeController "1" --> "1" AllocationManager : selects active strategy
```

### 2.3.2 Robotaxi (State)

Figure 2.3 shows the lifecycle classes. The `Robotaxi` keeps a reference to the `RobotaxiState`
interface. The concrete states are `AvailableState`, `AssignedState`, `ArrivingState`,
`ArrivedState`, `InRideState`, `RebalancingState` and `MaintenanceState`. Each concrete state
defines the behaviour of the transitions that are legal from it, while calls for any other
transition are rejected. This makes illegal transitions impossible by construction (NFR5).

#### Figure 2.3: Class diagram of the Robotaxi

The State pattern applied to the vehicle lifecycle.
Source: `../DD/diagrams/class_diagrams/robotaxi_state.puml`

```plantuml
class Robotaxi {
    - state: RobotaxiState
    --
    + assignRide(request: RideRequest): void
    + startPickupNavigation(): void
    + pickupReached(): void
    + startRide(): void
    + completeRide(): void
    + requestRebalancing(): void
    + completeRebalancing(): void
    + requestMaintenance(): void
    + completeMaintenance(): void
    + setState(state: RobotaxiState): void
}

class RobotaxiState <<interface>> {
    + assignRide(r: Robotaxi, request: RideRequest): void
    + startPickupNavigation(r: Robotaxi): void
    + pickupReached(r: Robotaxi): void
    + startRide(r: Robotaxi): void
    + completeRide(r: Robotaxi): void
    + requestRebalancing(r: Robotaxi): void
    + completeRebalancing(r: Robotaxi): void
    + requestMaintenance(r: Robotaxi): void
    + completeMaintenance(r: Robotaxi): void
}

class AvailableState {
    + assignRide(r: Robotaxi, request: RideRequest): void
    + requestRebalancing(r: Robotaxi): void
    + requestMaintenance(r: Robotaxi): void
}

class AssignedState {
    + startPickupNavigation(r: Robotaxi): void
}

class ArrivingState {
    + pickupReached(r: Robotaxi): void
}

class ArrivedState {
    + startRide(r: Robotaxi): void
}

class InRideState {
    + completeRide(r: Robotaxi): void
}

class RebalancingState {
    + assignRide(r: Robotaxi, request: RideRequest): void
    + completeRebalancing(r: Robotaxi): void
}

class MaintenanceState {
    + completeMaintenance(r: Robotaxi): void
}

Robotaxi "1" o-- "1" RobotaxiState : current state

RobotaxiState <|.. AvailableState
RobotaxiState <|.. AssignedState
RobotaxiState <|.. ArrivingState
RobotaxiState <|.. ArrivedState
RobotaxiState <|.. InRideState
RobotaxiState <|.. RebalancingState
RobotaxiState <|.. MaintenanceState
```

### 2.3.3 NotificationManager (Observer)

Figure 2.4 shows the notification classes. `Robotaxi` and `Ride` are subjects, while the
`NotificationManager` is the observer that is notified whenever a subject changes state. It then
dispatches the received events to the `PassengerAppSession` and the `OperatorDashboardSession`.

#### Figure 2.4: Class diagram of the notification mechanism

The Observer pattern used to propagate domain events from subjects to observers.
Source: `../DD/diagrams/class_diagrams/class_notification.puml`

```plantuml
class Subject <<interface>> {
    + registerObserver(o: Observer): void
    + removeObserver(o: Observer): void
    + notifyObservers(event: DomainEvent): void
}

class Observer <<interface>> {
    + update(event: DomainEvent): void
}

class Robotaxi {
    - observers: List<Observer>
    - state: RobotaxiState
    --
    + notifyObservers(event: DomainEvent): void
}

class Ride {
    - observers: List<Observer>
    - status: RideStatus
    --
    + updateStatus(status: RideStatus): void
    + notifyObservers(event: DomainEvent): void
}

class NotificationManager {
    + update(event: DomainEvent): void
    + dispatch(event: DomainEvent): void
}

class PassengerAppSession {
    + pushToPassenger(event: DomainEvent): void
}

class OperatorDashboardSession {
    + pushToOperator(event: DomainEvent): void
}

class DomainEvent <<event>>

Subject "1" o--> "0..*" Observer : observed_by

Subject <|.. Robotaxi
Subject <|.. Ride
Observer <|.. NotificationManager

NotificationManager "1" --> "0..*" PassengerAppSession : pushes events
NotificationManager "1" --> "0..*" OperatorDashboardSession : pushes events
```

**Realisation of the two subscription levels [v1.1].** The diagram has two distinct one-to-many
relations, and they have very different lifetimes; conflating them is the easiest way to get this
pattern wrong.

- **Subject → Observer** is *process-wide and static*. `Robotaxi` and `Ride` are domain objects that
  are reconstructed from the database on each operation (see `RobotaxiStateFactory`, §2.6.3), so
  they cannot carry a durable subscriber list. The list they hold lives for the duration of the
  operation, and the single observer registered into it is the `NotificationManager`, a singleton
  registered by the owning module at construction time. `notifyObservers(event)` is therefore always
  called on a subject that has exactly one observer.
- **NotificationManager → session** is *per-connection and dynamic*. `PassengerAppSession` and
  `OperatorDashboardSession` are explicit objects created when a client opens its WebSocket and
  destroyed when it closes; the `NotificationManager` registers and deregisters them at those two
  moments, and holds no reference to a session afterwards. A `PassengerAppSession` receives only the
  events of its own passenger's rides; an `OperatorDashboardSession` receives fleet-wide events.

The consequence is that "who is listening" changes at the session level, where it genuinely varies,
while the domain objects stay free of any knowledge of transport or connections. Whatever event bus
the runtime provides may carry the messages, but it does not replace the observer classes: `Subject`,
`Observer`, `NotificationManager` and the two session classes exist as named classes in the code.

**When a subject notifies [v1.3].** `notifyObservers(event)` is called **after** the transition has
been persisted, by the component that wrote it — `FleetMonitor` for `Robotaxi`, the ride journal that the
`RideRequestManager` component owns, and which its activation and lifecycle flows share, for `Ride` — and not from inside the state class. Figure 2.10 places
`notifyPassenger()` among the actions of a transition, but a transition that is legal when the row
is read can be illegal when it is written: that is precisely what `ConcurrentTransitionError`
reports, and it follows from the conditional write that Section 2.6.3 requires. Notifying from
inside the state class would announce to the passenger an assignment the database then refused, and
a write can be undone while a notification cannot. The structure of the pattern is unchanged — the
observer is registered on the subject at construction, and it is always the single
`NotificationManager` (decision D39).

**The second subject exists [v1.3].** `Ride` is backed by a `ride` table, added in M5: v1.2 drew it
here as a `Subject` carrying a `RideStatus` while no table, no component operation and no flow in
Section 2.4 ever created one, so half of this diagram was not implementable. See decision D36, and
Section 2.2 for the operations that now own it.

## 2.4 Runtime view

The sequence diagrams below refine, at component level, the requirement-level scenarios of the RASD.
They show the order of messages exchanged among components to accomplish the most relevant tasks.

#### Figure 2.5: Sequence diagram of the immediate ride request and allocation flow

including request persistence, robotaxi selection, assignment, and passenger notification (R3, R5, R6).
Source: `../DD/diagrams/sequence_diagrams/immediate_ride_request.puml`

```plantuml
participant "p:PassengerClient" as P
participant "api:APIGateway" as API
participant "rrm:RideRequestManager" as RRM
participant "pm:PersistenceManager" as PM
database "db:Database" as DB
participant "fm:FleetMonitor" as FM
participant "am:AllocationManager" as AM
participant "esg:ExternalServicesGateway" as ESG
participant "nm:NotificationManager" as NM

P -> API : submitImmediateRide(pickup, destination)
API -> RRM : submitImmediate(passengerId, pickup, destination)

RRM -> PM : create(request)
PM -> DB : insertRideRequest(request)
DB --> PM : requestId
PM --> RRM : rideRequest

RRM -> FM : getCandidates(pickup)
FM --> RRM : candidates

RRM -> AM : allocate(request, candidates)
AM -> ESG : getETA(candidates, pickup)
ESG --> AM : etaList
AM --> RRM : selectedRobotaxi

RRM -> FM : assign(selectedRobotaxi, request)
FM --> RRM : assignmentConfirmed

RRM -> PM : reserve(request, selectedRobotaxi)
PM -> DB : updateAssignment(request, selectedRobotaxi)
DB --> PM : ok
PM --> RRM : reservationConfirmed

RRM --> API : rideConfirmed(rideId, robotaxi, ETA)
API --> P : ride confirmation

' [v1.3] Il soggetto notifica, non il manager, e solo dopo che la transizione e' stata scritta:
' l'evento nasce dentro assign(), dal Robotaxi verso il suo unico observer (decisione D39).
FM ->> NM : update(RobotaxiStateChangedEvent)
NM ->> API : push(RideAssignedEvent)
API ->> P : push(RideAssignedEvent)
```

#### Figure 2.6: Sequence diagram of the automatic strategy switching flow

showing hysteresis-based strategy selection in Auto Mode and the priority of human manual override
(R12, R13, NFR9, NFR10).
Source: `../DD/diagrams/sequence_diagrams/seq_auto_strategy_switch.puml`

```plantuml
participant "esg:ExternalServicesGateway" as ESG
participant "mc:ModeController" as MC
participant "am:AllocationManager" as AM
participant "pm:PersistenceManager" as PM
participant "nm:NotificationManager" as NM
participant "api:APIGateway" as API
participant "operatorClient:FleetOperatorClient" as Operator

== Automatic strategy switching in Auto Mode ==

ESG ->> MC : onTrafficLevel(level)
MC -> MC : checkAutoMode()
MC -> MC : checkHysteresis(level)

alt autoMode enabled and hysteresis satisfied
    MC -> AM : setActiveStrategy(strategy)
    AM --> MC : strategyUpdated
    MC -> PM : update(modeConfig)
    PM --> MC : ok
    MC ->> NM : update(StrategyChangedEvent)
    NM ->> API : push(StrategyChangedEvent)
    API ->> Operator : push(StrategyChangedEvent)
else hysteresis not satisfied
    MC -> MC : keepCurrentStrategy()
else manualMode enabled
    MC -> MC : ignoreAutomaticSwitch()
end

== Human manual override ==

Operator -> API : setManualStrategy(strategy)
API -> MC : setManual(strategy)
MC -> AM : setActiveStrategy(strategy)
AM --> MC : strategyUpdated
MC -> PM : update(modeConfig)
PM --> MC : ok
MC ->> NM : update(ManualOverrideEvent)
NM ->> API : push(ManualOverrideEvent)
API ->> Operator : push(ManualOverrideEvent)
MC --> API : manualModeEnabled
API --> Operator : manual override confirmation
```

**The hysteresis rule, stated completely [v1.1].** `checkHysteresis(level)` in Figure 2.6 decides on
the *last observed* traffic level, which `ModeController` keeps in `currentTrafficLevel`:

| Observed level | Effect in Auto Mode |
|---|---|
| `LOW` | switch to `NEAREST_AVAILABLE` if not already active |
| `MEDIUM` | alert the operator, **never** switch (either direction) |
| `HIGH` | switch to `MINIMUM_ETA` if not already active |

`enableAuto()` sets the mode back to Auto and then **immediately re-evaluates `currentTrafficLevel`
through the same table**, switching at once if the outcome differs from the strategy the operator
had selected manually. Without this, R12 ("in Auto Mode the system dynamically manages the active
strategy") would be violated for an unbounded time after the mode is restored — the system would sit
on a manual choice while claiming to be automatic. Because `MEDIUM` never triggers a switch, an
`enableAuto()` observed at `MEDIUM` deliberately keeps the strategy that was active at that instant.
NFR9 is unaffected: hysteresis exists to damp *oscillation* of the traffic level, not to defer a
level that is already known.

Note that `MEDIUM` is asymmetric on purpose. Reverting only at `LOW` is what R12 and NFR9 ask for,
so the pair of thresholds `HIGH` (switch up) and `LOW` (switch down) leaves `MEDIUM` as the dead
band between them.

#### Figure 2.7: Sequence diagram of the dynamic fleet rebalancing flow

including demand analysis, available vehicle selection, and route command dispatch (R10, R11).
Source: `../DD/diagrams/sequence_diagrams/seq_rebalancing.puml`

```plantuml
participant "scheduler:RebalancingScheduler" as S
participant "rbm:RebalancingManager" as RBM
participant "esg:ExternalServicesGateway" as ESG
participant "fm:FleetMonitor" as FM
participant "pm:PersistenceManager" as PM
database "db:Database" as DB
participant "nm:NotificationManager" as NM
participant "api:APIGateway" as API
participant "operatorClient:FleetOperatorClient" as OP

S ->> RBM : triggerRebalancingCycle()

RBM -> ESG : getDemandData()
ESG --> RBM : demandData
RBM -> ESG : getTraffic()
ESG --> RBM : trafficData
RBM -> FM : getFleetStatus()
FM --> RBM : fleetStatus

RBM -> RBM : analyzeDemand(demandData, trafficData, fleetStatus)
RBM -> RBM : identifyHighDemandZones()

alt rebalancing needed
    RBM -> FM : getAvailableRobotaxis()
    FM --> RBM : availableRobotaxis
    RBM -> RBM : selectVehiclesAndTargetZones()

    loop for each selected robotaxi
        RBM -> FM : requestRebalancing(robotaxi)
        FM --> RBM : rebalancingStarted
        RBM -> ESG : commandRoute(robotaxi, targetZone)
        ESG --> RBM : commandAccepted
    end

    RBM -> PM : saveRebalancingPlan(rebalancingPlan, stateUpdates)
    PM -> DB : saveRebalancingPlan(rebalancingPlan)
    DB --> PM : ok
    PM -> DB : updateRobotaxiStates(stateUpdates)
    DB --> PM : ok
    PM --> RBM : updateConfirmed

    RBM ->> NM : update(RebalancingStartedEvent)
    NM ->> API : push(RebalancingStartedEvent)
    API ->> OP : push(RebalancingStartedEvent)
else no rebalancing needed
    RBM -> RBM : keepCurrentFleetDistribution()
end
```

#### Figure 2.8: Sequence diagram of the advance booking flow

including request validation, future vehicle allocation, conflict prevention, atomic booking and
robotaxi reservation, and passenger notification (R4, NFR4, C1).
Source: `../DD/diagrams/sequence_diagrams/seq_advance_booking.puml`

```plantuml
participant "p:PassengerClient" as P
participant "api:APIGateway" as API
participant "rrm:RideRequestManager" as RRM
participant "pm:PersistenceManager" as PM
database "db:Database" as DB
participant "fm:FleetMonitor" as FM
participant "am:AllocationManager" as AM
participant "esg:ExternalServicesGateway" as ESG
participant "nm:NotificationManager" as NM

P -> API : submitAdvanceBooking(pickup, destination, timeWindow)
API -> RRM : submitAdvance(passengerId, pickup, destination, timeWindow)

RRM -> RRM : validateAdvanceRequest()

RRM -> FM : getBookableRobotaxis()
FM --> RRM : bookableRobotaxis

RRM -> PM : filterAvailable(candidates, timeWindow)
PM -> DB : findOverlappingAssignments(candidateIds, timeWindow)
DB --> PM : conflicts
PM --> RRM : availableCandidates

RRM -> AM : allocate(advanceRequest, availableCandidates)
AM -> ESG : getETA(availableCandidates, pickup)
ESG --> AM : etaList
AM --> RRM : selectedRobotaxi

alt feasible robotaxi found
    RRM -> PM : reserve(advanceRequest, selectedRobotaxi, timeWindow)
    PM -> DB : insertBookingAndReservation(advanceRequest, selectedRobotaxi, timeWindow)
    DB --> PM : reservationResult
    PM --> RRM : reservationResult

    alt reservation committed
        RRM --> API : advanceBookingConfirmed(bookingId)
        API --> P : booking confirmation
        ' [v1.3] Il soggetto e' la Ride che la richiesta accettata genera, in stato SCHEDULED:
        ' nessun veicolo e' ancora assegnato, quindi non c'e' un Robotaxi che abbia da dire nulla.
        RRM ->> NM : update(RideStatusChangedEvent)
        NM ->> API : push(BookingConfirmedEvent)
        API ->> P : push(BookingConfirmedEvent)
    else concurrent reservation conflict
        RRM --> API : bookingRejected(conflictReason)
        API --> P : conflict error
    end
else no feasible robotaxi
    RRM --> API : bookingRejected(noAvailabilityReason)
    API --> P : no availability error
end
```

**[v1.2] Who is a candidate for a booking.** The v1.1 figure called `getCandidates(pickup)` here,
the same operation the immediate flow uses. That was wrong, and the error was not cosmetic:
`getCandidates()` answers "which vehicles can take a ride **right now**", while a booking asks
"which vehicles will be able to serve one **in two hours**". A vehicle that is currently `IN_RIDE`
will be free long before the scheduled time, and rejecting it would mean that as soon as the fleet
is busy, *every* future booking is refused — R4 would work only when it is not needed. The step is
therefore `getBookableRobotaxis()`, every vehicle except those in maintenance, and it is
`filterAvailable()` on the next line that decides who is actually taken during the requested window.
That filter can be trusted precisely because every assignment reserves a **bounded** interval
(decision D8), so the timeline is a complete statement of who is busy and until when. Maintenance is
the one state kept out: `maintenance_record` has no expected end date, so the system cannot claim
the vehicle will be back (decision D34).

#### The reservation timeline **[v1.1]**

Figures 2.5 and 2.8 both end in `reserve()`, so an immediate ride and an advance booking compete on
the same timeline; this is what makes C1 enforceable by a single database constraint rather than by
application code. For that to work, **every assignment writes a reservation covering a bounded time
interval** — an unbounded interval would make each running ride block every future booking on that
vehicle.

| Case | Interval reserved |
|---|---|
| Immediate ride | `[assignedAt, assignedAt + etaToPickup + estimatedRideDuration + buffer)` |
| Advance booking | `[scheduledPickup − activationLead, scheduledPickup + etaToPickup + estimatedRideDuration + buffer)` |

`buffer` and `activationLead` are configuration constants (defaults: 10 and 15 minutes). The upper
bound is **closed to the actual instant** when the ride completes or is cancelled, which returns the
released time to the pool. If a ride overruns its reserved interval the interval is extended; should
the extension collide with a later reservation, the colliding booking is re-allocated at activation
time, which re-validates availability anyway (see below).

#### Advance booking activation **[v1.1]**

RASD Scenario 2 requires that "shortly before the scheduled time, the system activates the
reservation": a booking is not an assignment, and something must turn it into one. The activation is
owned by `RideRequestManager` and driven by `AdvanceBookingActivator.runOnce()`, a public method
called by the scheduler in production and directly by the tests.

For each booking whose `scheduledPickup − activationLead` has been reached, `runOnce()` re-validates
that the reserved robotaxi is still eligible (it is `AVAILABLE`, and not in maintenance). If it is,
the vehicle transitions `AVAILABLE → ASSIGNED` and the passenger is notified, joining the ordinary
lifecycle of Figure 2.5. If it is not, the manager re-allocates among the vehicles free in that
window through `AllocationManager.allocate()`; if none is feasible, the request is rejected and the
passenger notified, which is the branch already described by RASD Figure 3.2.

```plantuml
participant "sched:AdvanceBookingActivator" as S
participant "rrm:RideRequestManager" as RRM
participant "pm:PersistenceManager" as PM
participant "fm:FleetMonitor" as FM
participant "am:AllocationManager" as AM
participant "nm:NotificationManager" as NM

S ->> RRM : activateDueBookings(now)
RRM -> PM : findBookingsDueAt(now + activationLead)
PM --> RRM : dueBookings

loop for each due booking
    RRM -> FM : getCandidates(pickup)
    FM --> RRM : candidates

    alt reserved robotaxi still eligible
        RRM -> FM : assign(reservedRobotaxi, request)
        FM --> RRM : assignmentConfirmed
    else reserved robotaxi no longer eligible
        RRM -> PM : filterAvailable(candidates, timeWindow)
        PM --> RRM : availableCandidates
        RRM -> AM : allocate(request, availableCandidates)
        AM --> RRM : selectedRobotaxi

        alt feasible robotaxi found
            RRM -> PM : reserve(request, selectedRobotaxi, timeWindow)
            PM --> RRM : reservationConfirmed
            RRM -> FM : assign(selectedRobotaxi, request)
            FM --> RRM : assignmentConfirmed
        else no feasible robotaxi
            RRM -> PM : update(request, REJECTED)
            ' [v1.3] La corsa e' l'altro soggetto: e' lei a dire al passeggero che e' finita.
            RRM ->> NM : update(RideStatusChangedEvent)
        end
    end

    ' [v1.3] L'assegnazione l'ha gia' notificata il Robotaxi dentro assign() (decisione D39).
end
```

#### Cancellation **[v1.1]**

`RideRequestManager.cancel()` realises **R14**: it sets the request to `CANCELLED`, releases the
reservation, and returns the robotaxi to `AVAILABLE` if it had already been assigned. Releasing the
reservation makes the window bookable again, which is the observable effect the tests assert.

**[v1.2]** The return to `AVAILABLE` is **transition 11** of Figure 2.10, driven through
`FleetMonitor.releaseAssignment()` (decisions D27 and D28): `RideRequestManager` never writes the
state column itself. The vehicle is released **before** the reservation, so that a cancellation
refused by the state machine — the vehicle has already left towards the pickup point — leaves the
reservation standing and the request untouched, rather than freeing a window for a ride that is
still going to happen.

## 2.5 Deployment view

Figure 2.9 shows how the components are deployed onto physical nodes. The clients run on the users'
devices, the backend on an application server (replicable), the database on its own node, and the
robotaxis expose an on-board control API reached over the network. The `PersistenceManager` is the
only component that accesses the database, while communication with the robotaxis and the other
external systems is handled by the `ExternalServicesGateway`.

#### Figure 2.9: Deployment view of the three-tier architecture

Source: `../DD/diagrams/component_diagrams/deployment_view.puml`

```plantuml
node "Passenger Device" <<device>> as PassengerDevice {
    artifact "Passenger Client" as PassengerClient
}

node "Fleet Operator Device" <<device>> as OperatorDevice {
    artifact "Fleet Operator Client" as OperatorClient
}

cloud "Internet / Network" as Network

node "Application Server\n(replicable)" <<server>> as AppServer {
    component "API Gateway" as APIGateway
    component "Authentication\nManager" as AuthManager
    component "Ride Request\nManager" as RideRequestManager
    component "Allocation\nManager" as AllocationManager
    component "Notification\nManager" as NotificationManager
    component "Maintenance\nManager" as MaintenanceManager
    component "Rebalancing\nManager" as RebalancingManager
    component "Fleet Monitor" as FleetMonitor
    component "Mode Controller" as ModeController
    component "Persistence\nManager" as PersistenceManager
    component "External Services\nGateway" as ExternalServicesGateway
}

database "Database Node" as DB {
    artifact "ROAd Database" as RoadDB
}

node "Robotaxi" <<device>> as Robotaxi {
    component "On-board\nControl API" as RobotaxiAPI
}

cloud "External Systems\nMaps / Traffic / Demand" as ExternalSystems

PassengerClient --> Network : HTTPS / WebSocket
OperatorClient --> Network : HTTPS / WebSocket
Network --> APIGateway : REST API requests

APIGateway --> AuthManager
APIGateway --> RideRequestManager
APIGateway --> NotificationManager
APIGateway --> MaintenanceManager
APIGateway --> RebalancingManager
APIGateway --> ModeController

RideRequestManager --> AllocationManager
RideRequestManager --> FleetMonitor
ModeController --> AllocationManager
MaintenanceManager --> FleetMonitor
RebalancingManager --> FleetMonitor

AllocationManager --> ExternalServicesGateway
RideRequestManager --> ExternalServicesGateway
MaintenanceManager --> ExternalServicesGateway
RebalancingManager --> ExternalServicesGateway
FleetMonitor --> ExternalServicesGateway

AuthManager --> PersistenceManager
RideRequestManager --> PersistenceManager
AllocationManager --> PersistenceManager
NotificationManager --> PersistenceManager
MaintenanceManager --> PersistenceManager
RebalancingManager --> PersistenceManager
FleetMonitor --> PersistenceManager
ModeController --> PersistenceManager
PersistenceManager --> RoadDB

ExternalServicesGateway --> Network : external API calls
Network <--> RobotaxiAPI : commands / telemetry
Network <--> ExternalSystems : maps / traffic / demand
```

## 2.6 Selected architectural styles and patterns

We document here the design patterns we adopt. For each one we follow the same scheme used in the
course: the problem, the solution in our system, and the reason why the pattern is the right answer.
The first three are the patterns explicitly requested for this project.

### 2.6.1 Strategy — allocation algorithms

**Problem.** The system must assign a robotaxi to a request, but there is no single "best" rule:
depending on traffic, the operator may want the nearest available vehicle (to save distance) or the
vehicle with the minimum ETA (to cut waiting time during congestion). The rule must be
interchangeable at runtime, and new rules should be addable later without touching the
request-handling code (NFR7).

**Solution.** We define an abstract `AllocationStrategy` with a single operation
`selectRobotaxi(request, candidates)`, and two concrete subclasses (`NearestAvailableStrategy`,
`MinimumETAStrategy`). The `AllocationManager` is the context: it owns references to the abstract
strategy and never to a concrete one, in a registry keyed by strategy name from which it resolves
the active policy (decision D26). The `ModeController` replaces the active strategy via
`setActiveStrategy()` (see Figures 2.2 and 2.6).

**Why.** Strategy turns "which algorithm" into a runtime choice instead of a hard-coded branch, which
is exactly what R8/R12 ask for. It also makes each policy independently testable and keeps the
allocation logic open for extension but closed for modification.

### 2.6.2 Observer — state-change notifications

**Problem.** Several parties are interested in the same events — when a robotaxi changes state or a
ride progresses, the passenger app must update, the operator dashboard must refresh, and the
notification logic must fire. The producers of the events should not need to know who is listening,
and listeners may come and go (a passenger opens/closes the app).

**Solution.** `Robotaxi` and `Ride` implement the `Subject` interface, keep a list of `Observer`s and
call `notifyObservers(event)` on every state change. The `NotificationManager` implements
`Observer.update(event)` and dispatches each received event to the `PassengerAppSession` and the
`OperatorDashboardSession`. The `APIGateway` forwards the corresponding push messages to the
connected clients through its WebSocket channel (Figure 2.4).

**Why.** Observer realises the one-to-many dependency between a subject and its listeners with
minimal coupling, and supports dynamic subscription. It is the natural way to satisfy R6/G7
(real-time updates) and, over a WebSocket push channel, also helps NFR2 (near-real-time
responsiveness) by avoiding polling.

### 2.6.3 State — robotaxi lifecycle

**Problem.** A robotaxi behaves differently depending on its state (available, assigned, arriving,
arrived, in ride, maintenance, and, added in this design, rebalancing), and only some transitions are
legal. Encoding this as a large conditional spread across the code is error-prone and risks reaching
invalid states (NFR5).

**Solution.** The `Robotaxi` (context) delegates its behaviour to a `RobotaxiState` object. Each
concrete state defines the behaviour of the events that are legal from it; any other call raises an
`IllegalTransitionError`. **[v1.1]** *(v1.0 called this error `InvalidTransition`; the name is fixed
here so that document, code and tests use one spelling.)* The full state machine is shown in
Figure 2.10; the classes in Figure 2.3.

The state is persisted as an enum column and the state object is rebuilt by a
`RobotaxiStateFactory` on each read **[v1.1]**: the behaviour lives in the classes, the database
stores only which class to instantiate. This is what lets the lifecycle survive a restart and stay
identical across replicas of the application tier (NFR3), and it is why the state objects hold no
durable observer list (§2.3.3).

#### Figure 2.10: Design-level state machine of the Robotaxi

realised by the State pattern. **The `REBALANCING` state is added with respect to the RASD FSM.**
Source: `../DD/diagrams/finite_state_machine/robotaxi_state.drawio` (and `.pdf`).
The figure is a drawn image; the transitions are transcribed below.

| # | From | Trigger `[guard] / action` | To |
|---|---|---|---|
| 1 | `AVAILABLE` | `requestMaintenance()` `[requiresMaintenance()]` / `disableAssignment()` | `MAINTENANCE` |
| 2 | `MAINTENANCE` | `completeMaintenance()` `[isOperational()]` / `enableAssignment()` | `AVAILABLE` |
| 3 | `AVAILABLE` | `assignRide(request)` `[isAvailable()]` / `storeRide()` | `ASSIGNED` |
| 4 | `ASSIGNED` | `startPickupNavigation()` `[hasAssignedRide()]` / `updateStatus()` | `ARRIVING` |
| 5 | `ARRIVING` | `pickupReached()` `[hasReachedPickup()]` / `notifyPassenger()` | `ARRIVED` |
| 6 | `ARRIVED` | `startRide()` `[isPassengerOnBoard()]` / `beginTrip()` | `IN RIDE` |
| 7 | `IN RIDE` | `completeRide()` `[hasReachedDestination()]` / `releaseRobotaxi()` | `AVAILABLE` |
| 8 | `AVAILABLE` | `requestRebalancing()` `[hasNoActiveRide()]` / `computeTargetArea()` | `REBALANCING` |
| 9 | `REBALANCING` | `completeRebalancing()` `[hasReachedTargetArea()]` / `setAvailable()` | `AVAILABLE` |
| 10 | `REBALANCING` | `assignRide(request)` `[hasReceivedRideRequest()]` / `interruptRebalancing()` | `ASSIGNED` |
| 11 **[v1.2]** | `ASSIGNED` | `cancelRide()` `[hasAssignedRide()]` / `releaseRobotaxi()` | `AVAILABLE` |

States: `AVAILABLE`, `ASSIGNED`, `ARRIVING`, `ARRIVED`, `IN RIDE`, `REBALANCING`, `MAINTENANCE`.
Every transition not listed above raises `IllegalTransitionError`.

**[v1.2]** Transition 11 is added because without it **R14 is not implementable**. The requirement,
and §2.4 with it, ask that cancelling a ride "returns the vehicle to the available state if it had
already been assigned"; the v1.1 figure gave `ASSIGNED` a single exit, transition 4 towards
`ARRIVING`, so the document contradicted itself. The contradiction is resolved where the machine is
written rather than worked around in a service, which is what the State pattern exists to prevent
(§2.6.3, NFR5). Two consequences:

- The action is `releaseRobotaxi()`, the same as transition 7: the vehicle lets go of the ride it
  was holding and becomes available again. What differs is who originates it — the passenger rather
  than the arrival at the destination.
- Cancellation is legal **only from `ASSIGNED`**. R14 speaks of cancelling "before the ride begins",
  which would also cover `ARRIVING` and `ARRIVED`, but a vehicle already moving towards the pickup
  point is executing a physical manoeuvre: declaring it available while it is still on the road
  requires countermanding its route (`commandRoute()`, M7), which is a command to the fleet and not
  a lifecycle transition. Until that command exists, cancellation stops where the vehicle is still
  stationary, and a passenger who cancels later is refused with the vehicle's current state.

**[v1.1]** This seven-state machine — not the six-state one of RASD §3.2 — is the machine the system
implements, and the one the tests enumerate exhaustively. The RASD machine remains correct as the
requirements-level abstraction: `REBALANCING` is a vehicle that is not serving a passenger, which a
requirements reader sees simply as unavailable for the moment. Two consequences worth stating,
because they are the ones an implementation gets wrong:

- A robotaxi in `REBALANCING` **is still allocatable**. Transition 10 interrupts the repositioning
  and assigns the ride, which is the whole point of moving idle vehicles toward expected demand
  (R11, G9); treating a rebalancing vehicle as unavailable would defeat the feature.
- A robotaxi in `REBALANCING` **cannot enter maintenance directly** — `RebalancingState` exposes
  only `assignRide()` and `completeRebalancing()`. Maintenance is requested once the vehicle is back
  to `AVAILABLE`. Any other call from any other state is an `IllegalTransitionError`, with no
  exceptions.

**Why.** State localises each transition rule next to the state it belongs to, so illegal
transitions become impossible by construction. It directly supports G6 (lifecycle tracking) and NFR5
(robustness), and makes the (finite) set of transitions easy to test exhaustively.

### 2.6.4 Other patterns and styles

- **Adapter / Facade** — the `ExternalServicesGateway` exposes a uniform interface to the mapping
  service, the demand source and the vehicle API, hiding their specific protocols (NFR8).
- **MVC** — both clients separate the observable model (a local copy of the relevant server state)
  from the view and the controller, so the view is a function of the model.
- **Singleton** — the `FleetMonitor` is a single dependency-injected instance within each backend
  process. Its in-memory fleet index is a disposable cache synchronised with persistent data and
  external telemetry, and is not the authoritative shared state.

---

# 3 User Interface Design

This chapter gives an overview of the two user interfaces through wireframes. They are low-fidelity
on purpose: the goal is to show structure and the main interactions, not the final graphic design.
Both interfaces are designed to be intuitive and require no training (NFR6).

## 3.1 Passenger mobile app

The passenger app is centered on a map. The main screen (Figure 3.1) lets the user set pickup and
destination, choose between an immediate ride and a scheduled one, and request the ride with a
single button. After the request, the same screen turns into a live status view that follows the
ride through its states (searching, assigned, arriving, arrived, in ride), driven by the Observer
notifications.

**[v1.1] Delivery form.** The passenger app is delivered as a **responsive progressive web
application** rather than a native mobile build. Nothing in the RASD or in this document depends on
a native runtime — R3, R4, R6 and NFR6 constrain the interaction, not the packaging — and a web
delivery keeps the client on the same public HTTP and WebSocket contract as the dashboard, which is
what makes either client replaceable (NFR8). Wherever this document says "mobile app", read
"passenger client".

#### Figure 3.1: Wireframe of the passenger app: request a ride and follow its status

> **Nota:** nel PDF v1.0 questa figura non è renderizzata; al suo posto compare il segnaposto
> `Images/diagrams/ui_passenger — Render the PlantUML source to PDF or PNG`. Il sorgente del
> wireframe non è presente in `../DD/diagrams/`.

## 3.2 Operator web dashboard

The dashboard (Figure 3.2) is a command-and-control console. It shows the live fleet on a map, a
strategy panel where the operator sees the active allocation strategy and can switch it (moving the
system to Manual mode), and an alerts panel that surfaces automatic strategy switches and
rebalancing suggestions. A status bar summarises the fleet by state. The Auto/Manual toggle makes
the current control mode always visible (NFR10).

#### Figure 3.2: Wireframe of the operator dashboard: fleet monitoring and strategy control

> **Nota:** nel PDF v1.0 questa figura non è renderizzata; al suo posto compare il segnaposto
> `Images/diagrams/ui_operator — Render the PlantUML source to PDF or PNG`. Il sorgente del
> wireframe non è presente in `../DD/diagrams/`.

---

# 4 Requirements Traceability

This chapter shows how the requirements defined in the RASD are covered by the design elements of
this document. Each functional requirement is mapped to the components (and, where relevant, the
patterns) that realise it; each non-functional requirement is mapped to the design decision that
supports it.

## 4.1 Functional requirements

| Req | Description (short) | Components / patterns |
|---|---|---|
| R1 | Registration and login | AuthenticationManager; clients |
| R2 | Profile management | AuthenticationManager |
| R3 | Immediate ride request | RideRequestManager; AllocationManager; Passenger App |
| R4 | Advance booking (no conflicts) | RideRequestManager; FleetMonitor; AllocationManager + Strategy; PersistenceManager (filterAvailable/reserve) |
| R5 | Automated vehicle allocation | AllocationManager + *Strategy*; FleetMonitor |
| R6 | Ride status notifications | NotificationManager + *Observer*; Robotaxi and Ride as `Subject`; RideRequestManager (`IRideLifecycleService`); API Gateway (WebSocket push) |
| R7 | Real-time fleet monitoring | FleetMonitor; Operator Dashboard |
| R8 | Runtime strategy selection | ModeController; AllocationManager + Strategy |
| R9 | Maintenance management | MaintenanceManager; FleetMonitor + *State* |
| R10 | Demand analysis | RebalancingManager; ExternalServicesGateway **[v1.4]** *(the demand source is realised as `demand_sample` / `demand_event` read through PersistenceManager — decision D47; the gateway takes over in M7)* |
| R11 | Proactive fleet rebalancing | RebalancingManager; FleetMonitor |
| R12 | Auto Mode (traffic-driven switching) | ModeController; ExternalServicesGateway |
| R13 | Manual Mode (override) | ModeController; Operator Dashboard |
| R14 **[v1.1]** | Ride cancellation | RideRequestManager (`cancel`); PersistenceManager (reservation release); FleetMonitor + *State* |

## 4.2 Non-functional requirements

| NFR | Quality | Design decision that supports it |
|---|---|---|
| NFR1 | Concurrency handling | Replicable application tier behind API Gateway; DB transactions in PersistenceManager |
| NFR2 | Real-time responsiveness | Observer + WebSocket push instead of polling |
| NFR3 | Scalability | Horizontally replicable backend; single data tier |
| NFR4 | Data consistency | Uniqueness/timeline constraints in PersistenceManager; atomic `reserve()` |
| NFR5 | Robustness (valid transitions) | State pattern in Robotaxi; FleetMonitor coordinates lifecycle updates |
| NFR6 | Ease of use | Map-centric app and command-and-control dashboard (Ch. 3) |
| NFR7 | Extensibility of allocation logic | Strategy pattern; AllocationManager closed for modification |
| NFR8 | Separation of concerns | ExternalServicesGateway (Adapter/Facade); layered backend |
| NFR9 | Stability of auto-switching | Hysteresis in ModeController (revert only at LOW) |
| NFR10 | Priority of human intervention | Manual mode in ModeController suspends auto switches |

## 4.3 Operational definitions of the quality requirements **[v1.1]**

Section 4.2 maps each quality to the decision that supports it, which is the right level for a
design document but is not falsifiable: "the architecture is scalable" cannot fail a test. Since
every requirement in this project must be demonstrated by at least one test that names it, each NFR
is restated below as a proposition that can actually be refuted. Three of them (NFR3, NFR6, NFR8)
had no observable form at all in v1.0 and are the reason this section exists; the others are listed
so that the whole set is verified the same way.

| NFR | Proposition that must hold | How it is refuted |
|---|---|---|
| NFR1 | Two concurrent requests for the last available robotaxi produce exactly one assignment and one rejection | Both succeed, or both fail |
| NFR2 | A state change reaches a connected client over the push channel without the client polling | The client only learns of the change by issuing a new request |
| NFR3 | No server-side session state exists: a token issued by one application instance is accepted by a second instance that never handled the login, and authentication consults no in-memory store | The second instance rejects the token |
| NFR4 | No two reservations of the same robotaxi ever overlap, whatever the interleaving of writers | An overlapping pair is committed |
| NFR5 | Every transition absent from Figure 2.10 raises `IllegalTransitionError`, and the state survives persistence and reconstruction | Any illegal transition succeeds, or a reconstructed vehicle answers differently from the original |
| NFR6 | A passenger completes a ride request from a cold start of the client in at most four interactions, and the operator sees mode and active strategy on the dashboard's first render, without navigating | An extra step is needed, or either indicator is not visible initially |
| NFR7 | A new allocation policy is added by writing one class and registering it, with no edit to `AllocationManager` or to `RideRequestManager` | Adding the third strategy in the tests requires touching either manager |
| NFR8 | No component outside `ExternalServicesGateway` references a provider protocol or SDK, and the domain tests run with only that gateway substituted | A provider import appears elsewhere, or a domain test needs a second substitute |
| NFR9 | The sequence Low→Medium→High→Medium→Low switches strategy exactly twice, at High and at the final Low | A switch happens at either Medium |
| NFR10 | After a manual selection, no traffic level whatsoever changes the active strategy until `enableAuto()` is called; the switch to Manual is atomic with the strategy change | An automatic switch is observed while in Manual, or an interleaving leaves Manual mode and the manual strategy out of step |

---

# 5 Implementation, Integration and Test Plan

## 5.1 Feature prioritisation

We rank the features by importance (value for the core service) and difficulty, to decide what to
build first. The viable prototype must cover the high-importance features; the rest are
nice-to-have.

| Feature | Importance | Difficulty |
|---|---|---|
| Accounts and authentication (R1, R2) | High | Low |
| Immediate ride + allocation (R3, R5) | High | Medium |
| Robotaxi lifecycle / State (R9, G6) | High | Medium |
| Conflict-free advance booking (R4) | High | High |
| Notifications / Observer (R6) | High | Medium |
| Fleet monitoring dashboard (R7) | High | Medium |
| Runtime strategy selection (R8) | Medium | Low |
| Auto mode + hysteresis (R12, NFR9) | Medium | High |
| Demand analysis + rebalancing (R10, R11) | Medium | High |
| Manual override (R13, NFR10) | Medium | Low |

## 5.2 Implementation and integration order

We integrate bottom-up, so that every component is integrated only after the components it depends
on are already in place and tested. External systems are replaced by stubs/mocks at the beginning
and connected through the `ExternalServicesGateway` later.

1. **PersistenceManager + database schema**: foundation for everything; includes the
   uniqueness/timeline constraints (NFR4).
2. **FleetMonitor + Robotaxi (State)**: the vehicle model and its lifecycle, first against a vehicle
   mock.
3. **AllocationManager + strategies (Strategy)**: on top of FleetMonitor.
4. **RideRequestManager**: immediate first, then advance booking with candidate filtering, vehicle
   allocation and atomic reservation, then cancellation (R14) and the booking activation cycle
   **[v1.1]**.
5. **NotificationManager (Observer) + API Gateway push**: wire events to clients.
6. **ModeController + RebalancingManager**: the higher-level control logic, including the traffic
   monitor that feeds `onTrafficLevel()` **[v1.1]**.
7. **ExternalServicesGateway adapters**: replace the mocks with the real mapping and demand
   services.
8. **Clients**: Passenger App and Operator Dashboard against the stable API.

## 5.3 Testing strategy

We follow the V-model: each artifact is verified against the specification it refines. Verification
("are we building the software right?") is our focus; validation is addressed through the demos with
the teacher.

**Unit testing**
: Each manager and each pure-logic class in isolation. Highest priority: (i) the two
  `AllocationStrategy` subclasses, with equivalence partitioning over the candidate set (empty fleet
  / no suitable vehicle / one suitable / several) and boundary values on ETA and distance; (ii) the
  `RobotaxiState` transitions, tested exhaustively because the state machine is finite, including
  the rejection of every illegal transition (NFR5); (iii) the conflict check of advance booking
  (NFR4).

**Integration testing**
: The request→allocation→notification chain, and the booking→reserve→persistence chain, with
  external systems mocked. We test the integration in the same bottom-up order used to build it.

**System testing**
: The four RASD scenarios end-to-end on a staging deployment: immediate ride, advance booking,
  auto/manual strategy management, dynamic rebalancing. Includes a concurrency test that fires two
  requests for the last available robotaxi and checks that exactly one is assigned (NFR1, NFR4).

**Acceptance testing**
: Walkthrough of the goals (G1-G10) with the teacher at the milestone demo.

**Tools [v1.1].** The backend is implemented in TypeScript, so the toolchain is: a unit-test
framework for TypeScript for the unit and integration levels, an HTTP assertion library driving the
application for API tests, disposable database containers so that every integration run starts from
a clean schema with fixed seed data, and a browser automation framework for the system level. The
concurrency tests do not need a load generator: they fire the competing operations directly and
assert the outcome, which is both faster and deterministic. The repository runs the whole suite in
continuous integration on every push, as required by the project rules.

**Determinism [v1.1].** No test may depend on the wall clock or on an unseeded random source: time
is read through a clock abstraction and randomness through a seeded one, both substitutable in
tests, and every periodic activity is invoked through the `runOnce()` methods listed in §2.2.1. This
is a precondition for testing advance booking, hysteresis and rebalancing at all — each of them is
defined in terms of time — and it is what keeps the suite from producing failures that do not
correspond to defects.

---

# 6 References

- *ROAd: Robotaxi Optimized Allocation — Requirements Analysis and Specification Document*, v1.0.
- M. Camilli, *Software Engineering for Automation — Course Slides*, Politecnico di Milano, A.Y.
  2025-2026 (in particular: modular design, OO design, design patterns, V&V).
- E. Gamma, R. Helm, R. Johnson, J. Vlissides, *Design Patterns: Elements of Reusable
  Object-Oriented Software*, Addison-Wesley, 1994.
- M. Jackson and P. Zave, *The World and the Machine*, ICSE, 1995.
- Object Management Group, *Unified Modeling Language Specification*, https://www.omg.org/spec/UML/.
- PlantUML, https://plantuml.com (diagram sources in `./Images/diagrams/`).

---

# Appendice A — Registro delle decisioni

Questa appendice raccoglie tutte le differenze fra il PDF v1.0 e questo documento: D1–D26 sono di
v1.1, D27–D33 di v1.2, D34–D46 di v1.3, D47–D58 di v1.4. Serve a due cose:
rigenerare il PDF a fine progetto senza rileggere il diff, e permettere a chi rivede il codice di
capire *perché* un dettaglio è come è. Ogni riga dice cosa è cambiato, dove, e per quale ragione.

| # | Decisione | Sezione | Motivo |
|---|---|---|---|
| D1 | La FSM implementata è quella a **sette stati** del design (Fig. 2.10), non quella a sei del RASD §3.2. `REBALANCING` è uno stato a tutti gli effetti, con le sue tre transizioni | §2.6.3 | Senza `REBALANCING` R11/G9 non sono realizzabili: `rebalance()` deve poter muovere un veicolo inattivo e poterlo dirottare su una corsa. Il v1.0 lo dichiarava già ("added with respect to the RASD FSM") ma non ne traeva le conseguenze |
| D2 | L'eccezione si chiama `IllegalTransitionError` | §2.6.3, Fig. 2.10 | Il v1.0 la chiamava `InvalidTransition`; un solo nome fra documento, codice e test |
| D3 | `allocate()` può non restituire alcun veicolo | §2.2.1, Fig. 2.2 | Il RASD (Fig. 3.1) prevede il rifiuto quando nessun veicolo è idoneo: l'assenza di scelta dev'essere rappresentabile |
| D4 | `setActiveStrategy(name, source)` invece di `setActiveStrategy(strategy)`; aggiunti `getActiveStrategy()` e `getMode()` | §2.2.1, Fig. 2.2 | Il nome tiene il chiamante libero dalle classi concrete; l'origine rende atomico il passaggio a Manual richiesto da NFR10; i due lettori servono a R8 e alla visibilità del modo (NFR10) |
| D5 | `AllocationManager` **non** dipende da `FleetMonitor`: i candidati glieli passa `RideRequestManager` | §2.2.1 | È già l'architettura di Fig. 2.1; renderlo esplicito evita un arco di troppo e tiene ogni strategia testabile con una semplice lista di veicoli |
| D6 | Il record `system_mode` (strategia attiva + modo) è persistito; `setActiveStrategy` ne è l'unico scrittore per la strategia, `enableAuto()` per il ritorno ad Auto | §2.2.1 | Con più repliche del tier applicativo (NFR3) una strategia tenuta solo in memoria divergerebbe fra istanze |
| D7 | I due livelli dell'Observer hanno vite diverse: `Subject → NotificationManager` è di processo, `NotificationManager → sessioni` è per connessione | §2.3.3 | Le entità sono ricostruite a ogni operazione e non possono portarsi dietro una lista di subscriber durevole; senza questa distinzione il pattern non è implementabile come disegnato |
| D8 | Ogni assegnazione scrive una riserva su un intervallo **limitato**; il limite superiore si chiude al completamento | §2.4 | Un intervallo illimitato renderebbe impossibile qualunque prenotazione futura sullo stesso veicolo. È la condizione perché C1 sia garantito da un vincolo di database e non dal codice applicativo |
| D9 | Le prenotazioni anticipate sono attivate da `AdvanceBookingActivator.runOnce()`, con anticipo configurabile e ri-allocazione se il veicolo non è più idoneo | §2.4 | Lo scenario 2 del RASD lo richiede ("the system activates the reservation") e nessun componente lo copriva |
| D10 | L'appartenenza di un punto a una zona è per **centroide più vicino** (Voronoi), pareggi su `zoneID` crescente | §2.2.1 | Il RASD dice "partition": un raggio lascerebbe punti scoperti e sovrapposizioni, che una partizione esclude |
| D11 | `enableAuto()` rivaluta subito l'ultimo livello di traffico noto | §2.4 | Altrimenti R12 resterebbe violato per un tempo arbitrario dopo il ritorno ad Auto. NFR9 non ne risente: l'isteresi smorza le oscillazioni, non rinvia un livello già noto |
| D12 | `analyzeDemand()` è `base × moltiplicatori degli eventi attivi`, zone in ordine decrescente con pareggi su `zoneID`; `rebalance()` ordina per deficit | §2.2.1 | Ogni ordinamento dev'essere totale e deterministico, o i test diventano instabili — stesso criterio già adottato per i pareggi fra strategie |
| D13 | Aggiunto **R14 — Ride Cancellation** | §4.1, §2.4 | L'annullamento era un fenomeno condiviso del RASD §1.2.2 e uno stato `CANCELLED` del dominio, ma nessun requisito lo copriva: restava fuori dalla tracciabilità |
| D14 | NFR1–NFR10 hanno una formulazione operativa falsificabile | §4.3 | NFR3, NFR6 e NFR8 non avevano forma osservabile: senza questa sezione la loro copertura sarebbe stata soddisfatta da test che non asseriscono nulla |
| D15 | Il client passeggero è una PWA responsive | §3.1 | Nulla nei requisiti dipende dal packaging nativo, e una consegna web tiene entrambi i client sullo stesso contratto pubblico (NFR8) |
| D16 | Ogni attività periodica è un `runOnce()` pubblico; niente timer nella logica di dominio | §2.2.1, §5.3 | Prenotazioni, isteresi e rebalancing sono definiti sul tempo: senza controllo del tempo i loro test sono instabili |
| D17 | Strumenti di test aggiornati allo stack effettivo | §5.3 | Il v1.0 citava strumenti di altri linguaggi |
| D18 | `PersistenceManager` espone anche `find(kind, criteri)` | §2.2 | Il documento presupponeva già la lettura in due punti (`findBookingsDueAt(now)` in §2.4, i lettori di strategia e modo in §2.2.1) senza elencarla fra le operazioni. Una sola operazione generica invece di una per caso d'uso: il registro dei tipi persistiti la rende sicura sui tipi e la porta non cresce a ogni milestone |
| D19 | Una riserva si **rilascia** (`released_at`), oltre a potersi accorciare; il vincolo di esclusione è parziale su `released_at IS NULL` | §2.4 | D8 chiude il limite superiore quando la corsa *termina*, ma R14 annulla anche prima che la finestra cominci, e lì accorciare non basta: servirebbe un intervallo vuoto, che non escluderebbe nulla. Con il rilascio l'intera finestra torna prenotabile e la riga resta per lo storico |
| D20 | `system_mode` porta anche l'ultimo livello di traffico noto | §2.2.1 | D11 richiede che `enableAuto()` rivaluti *subito* l'ultimo livello; con più repliche del tier applicativo (NFR3) un valore tenuto in memoria divergerebbe fra istanze, esattamente come la strategia attiva secondo D6 |
| D21 | L'`AuthenticationManager` non gestisce sessioni e **non verifica i token**: espone tre sole operazioni, e la verifica per richiesta è realizzata da guard pubblicati da una **seconda porta** del componente, che l'API Gateway applica alle proprie rotte | §2.2, §2.2.1 | Il §2.2 diceva «accounts and sessions», ma NFR3 esclude ogni stato di sessione lato server: non c'è sessione da gestire. La verifica è invece un'attività del cammino di richiesta, che la Fig. 2.1 attribuisce già al gateway («enforces authentication») e che nessuna delle tre operazioni copriva: senza un punto dichiarato, ogni controller reinventerebbe l'estrazione del token. La divisione fra porta di servizio e porta di meccanismo è la stessa già adottata per `fleet` |
| D22 | La registrazione pubblica crea sempre un `PASSENGER`; il ruolo è parametro della **porta**, non del contratto HTTP, e gli account operatore nascono dal seed | §2.2.1 | Il RASD §1.4 elenca «Passenger registration», «Passenger login» e «Fleet operator login», ma non la registrazione di un operatore. Senza un account seminato nessuno potrebbe mai entrare come operatore, e metà di R1 resterebbe irrealizzabile; farlo passare dalla porta invece che da una riga scritta a mano tiene un solo codice a produrre gli hash |
| D23 | `PersistenceManager` traduce la violazione di un vincolo di unicità in `UniqueConstraintError` | §2.2 | Stessa ragione di D19 per le riserve: un indirizzo già registrato è un esito previsto del dominio (R1), non un guasto, e il codice SQLSTATE del driver non deve uscire dal modulo. Il rifiuto arriva dal database e non da una lettura precedente, perché fra la lettura e la scrittura ci sta un'altra registrazione — su due repliche del tier applicativo (NFR3) quella finestra è reale |
| D24 | `AllocationStrategy.selectRobotaxi()` restituisce `Robotaxi [0..1]` | §2.3.1, Fig. 2.2 | D3 ha allargato `allocate()`, ma il manager è un contesto che delega e restituisce ciò che la strategia gli dà: una firma che può rifiutare sopra e non sotto non è implementabile |
| D25 | A parità di metrica vince il `robotaxiID` lessicograficamente minore; un candidato il cui punteggio non è un numero finito non è idoneo | §2.3.1 | D12 dava già per esistente «lo stesso criterio adottato per i pareggi fra strategie», ma il documento non lo enunciava da nessuna parte. Senza una regola totale l'esito di un'allocazione dipenderebbe dall'ordine con cui il database ha restituito i candidati, e i test sarebbero instabili. Il secondo punto è la stessa esigenza vista da vicino: `NaN` non è confrontabile, quindi un veicolo di cui non si conosce la posizione — o, per `MinimumETA`, un veicolo per cui il fornitore non sa dare un ETA — resta fuori dalla scelta invece di renderla arbitraria |
| D26 | Il contesto tiene il **registro** delle strategie — `strategies: Map<StrategyName, AllocationStrategy>` — e non un riferimento alla sola strategia attiva: il nome di quella attiva sta nel record `system_mode` e viene risolto a ogni `allocate()` | §2.3.1, Fig. 2.2, §2.6.1 | Conseguenza diretta di D6: se la sede autorevole della strategia attiva è la riga, un riferimento tenuto in memoria dal manager è una seconda copia che diverge dalla colonna appena un'altra replica la cambia (NFR3). Il pattern Strategy resta intatto — il contesto continua a non conoscere nessuna classe concreta e a delegare — ma l'associazione della Fig. 2.2 è `1 o--> 1..*` verso le politiche registrate, e la scelta di quale usare è una ricerca per nome. È anche ciò che rende vera la promessa di NFR7: si registra una politica in più, non si sostituisce quella corrente |
| D27 | Aggiunta la **transizione 11**: `ASSIGNED --cancelRide()--> AVAILABLE` | §2.6.3, Fig. 2.10, §2.4 | Senza di essa **R14 non è implementabile**: il requisito e il §2.4 pretendono che l'annullamento riporti ad `AVAILABLE` un veicolo già assegnato, ma la figura v1.1 dava ad `ASSIGNED` una sola uscita, la 4 verso `ARRIVING`. Il documento contraddiceva sé stesso. È legale **solo** da `ASSIGNED`: fermare un veicolo già in movimento verso il ritiro richiede di revocarne la rotta (`commandRoute()`, M7), che è un comando alla flotta e non una transizione del ciclo di vita |
| D28 | `FleetMonitor` espone una sesta operazione, `releaseAssignment(robotaxiID)` | §2.2 | Conseguenza di D27. Il §2.4 attribuisce a `RideRequestManager` il compito di riportare il veicolo fra i disponibili, ma `rides` non può scrivere la colonna di stato — la macchina la governa `fleet`, ed è il punto del pattern State (§2.6.3). Sta a `assign()` come la transizione 11 sta alla 3 |
| D29 | `RideRequestManager` dipende anche da `ExternalServicesGateway` | §2.2.1, Fig. 2.1, §2.4 | D8 impone che ogni riserva copra `[…, … + etaToPickup + estimatedRideDuration + buffer)`, ma la Fig. 2.1 non dà a questo componente l'arco verso il gateway, e nessun altro componente sa produrre quei due numeri. Le alternative erano peggiori: allargare il tipo di ritorno di `allocate()` per farci passare un ETA (che è un dato del percorso, non della scelta), oppure ricalcolare i tempi di viaggio dentro `rides`, cioè duplicare la responsabilità che NFR8 assegna al facade |
| D30 | Nella richiesta immediata l'ordine è `reserve()` **poi** `assign()`, e su rifiuto si ri-alloca fra i candidati rimanenti | §2.4, Fig. 2.5 | Il documento si contraddiceva: la Fig. 2.5 mette `assign()` prima di `reserve()`, il diagramma di attivazione delle prenotazioni l'inverso. Vince il secondo, perché `reserve()` è il punto in cui la concorrenza viene arbitrata (`FOR UPDATE SKIP LOCKED` più il vincolo di esclusione): prenotare per primo significa che un rifiuto non lascia nulla da disfare, mentre l'ordine opposto lascerebbe un veicolo in `ASSIGNED` per una corsa che non ha ottenuto la finestra. Il ciclo sui candidati rimanenti è la risposta che il §2.4 prevede già per `ROBOTAXI_BUSY` |
| D31 | Il filtro sulla timeline di una prenotazione anticipata usa una finestra **nominale**, con ETA verso il ritiro pari a zero | §2.4, Fig. 2.8 | La Fig. 2.8 chiama `filterAvailable(candidates, timeWindow)` *prima* di conoscere il veicolo, ma la finestra reale dipende dall'ETA del veicolo scelto: la sequenza non è eseguibile alla lettera. La finestra nominale è contenuta in ogni finestra reale, quindi il filtro non scarta mai un candidato idoneo; a decidere resta il vincolo di esclusione al momento della `reserve()`, che è dove D8 e C1 vogliono che si decida |
| D32 | All'attivazione, «il veicolo riservato è ancora idoneo» significa che compare fra i candidati di `getCandidates()` | §2.4 | Il §2.4 lo scriveva come «it is `AVAILABLE`, and not in maintenance», che escluderebbe un veicolo in `REBALANCING` — ma il §2.6.3 dichiara esplicitamente che un veicolo in `REBALANCING` **è allocabile** (transizione 10), e la 10 esiste proprio per dirottarlo su una corsa. Con la lettura letterale si rilascerebbe la riserva di un veicolo perfettamente utilizzabile per ri-allocarne un altro |
| D33 | `AdvanceBookingActivator` è pubblicato da una **seconda porta** del modulo `rides` | §2.2, §2.2.1 | `runOnce()` non è una delle tre operazioni di `IRideRequestService`, e il §2.2.1 pretende che sia pubblico e chiamabile dai test senza passare da uno scheduler. È la stessa divisione fra porta di servizio e porta di meccanismo già adottata per `fleet` (D21) |
| D34 | Una prenotazione anticipata parte da `FleetMonitor.getBookableRobotaxis()` — **tutti i veicoli tranne quelli in manutenzione** — e non da `getCandidates()` | §2.2, §2.4, Fig. 2.8 | La Fig. 2.8 riusava `getCandidates(pickup)`, cioè «chi può prendere una corsa **adesso**», per rispondere a «chi potrà servirne una **fra due ore**». Sono domande diverse, e confonderle rendeva R4 quasi inutile: con la flotta impegnata ogni prenotazione futura veniva rifiutata, anche per un orario in cui la flotta sarà tutta libera. R4 chiede di riservare la disponibilità «for the required time interval», e a dire chi è occupato in quella finestra è la timeline — `filterAvailable()` — che esiste ed è precisa proprio perché ogni riserva è limitata (D8). `MAINTENANCE` resta escluso: un intervento non ha una data di fine prevista, quindi prenotare quel veicolo prometterebbe una corsa su un'ipotesi (R9) |
| D35 | `PersistenceManager.reserve()` scrive anche il legame richiesta↔veicolo, nella **stessa transazione** | §2.2, §2.4, Fig. 2.5 | È l'`updateAssignment(request, selectedRobotaxi)` che la Fig. 2.5 disegna già dentro `reserve()`, e che l'implementazione aveva lasciato fuori. Fuori transazione lascia una finestra in cui la riserva esiste e nessuna richiesta la rivendica: da lì il veicolo non è più recuperabile, perché `cancel()` cerca il veicolo proprio su `ride_request.assignedRobotaxiId` e lo troverebbe nullo — un robotaxi bloccato in `ASSIGNED` per sempre. Per la stessa ragione l'attivazione scrive il legame **prima** di `assign()`: la finestra che resta — legame scritto, veicolo ancora libero — è quella che l'annullamento sa assorbire, trattando un veicolo già `AVAILABLE` come lavoro già fatto |
| D36 | La tabella **`ride`** esiste, e con lei l'entità `Ride` con il suo `RideStatus` | §2.3.3, Fig. 2.4; RASD §2.2.3 | La §2.3.3 disegna `Ride` come uno dei due `Subject` dell'Observer, con `status: RideStatus` e `updateStatus()`, ma nessuna tabella la sosteneva, nessuna operazione di componente la creava e nessun flusso del §2.4 la nominava: metà del pattern non era implementabile. Non è un doppione di `ride_request`, ed è il RASD §2.2.1 a tenerle separate («An accepted Ride Request can generate one Ride»): la richiesta è la domanda, la corsa è il viaggio. Una richiesta resta `ACCEPTED` mentre la sua corsa attraversa `SCHEDULED → WAITING_FOR_PICKUP → IN_PROGRESS → COMPLETED`, che è esattamente la progressione che R6 chiede di notificare — schiacciate in una colonna, «il sistema ha trovato un veicolo» e «il passeggero è a bordo» diventerebbero indistinguibili |
| D37 | `FleetMonitor` espone le **transizioni 4, 5, 6 e 7** — `startPickupNavigation()`, `pickupReached()`, `startRide()`, `completeRide()` | §2.2, §2.6.3, Fig. 2.10 | La Fig. 2.10 le definisce dal v1.0 e le classi di stato le implementano dal M2, ma nessuna operazione di componente le innescava: `assign()` e `releaseAssignment()` aprivano e chiudevano il ciclo di vita senza che nulla lo attraversasse. R6 chiede di notificare «vehicle assignment, ETA, arrival at the pickup point, and ride completion», cioè proprio i passi intermedi, quindi senza un modo di provocarli il canale di questa milestone non avrebbe avuto niente da trasportare. Non nasce comportamento nuovo: si pubblica il modo di innescare quello che la figura già prescriveva. Da M7 le innescherà la telemetria del simulatore, che è ciò che risolve le guardie `hasReachedPickup()` e `hasReachedDestination()` |
| D38 | Le quattro transizioni si guidano da una **terza porta** di `rides`, `IRideLifecycleService`, che muove insieme veicolo e corsa — **il veicolo prima, la corsa poi** | §2.2, §2.4 | Ogni passo tocca due moduli: la colonna di stato la scrive solo `fleet` (D28) e la tabella `ride` solo `rides`. Il componente che coordina due moduli è per il §2.2 il `RideRequestManager`, che già raggiunge `IFleetMonitorService`; metterlo in `fleet` avrebbe invertito un arco della Fig. 2.1 e costretto quel modulo a conoscere le corse. L'ordine è la parte che conta: la transizione del veicolo è l'unico passo che può *rifiutare*, e rifiuta senza scrivere nulla (NFR5), quindi metterla per prima fa sì che un passo fuori tempo lasci la corsa intatta. Nell'ordine opposto la corsa risulterebbe avanzata su un veicolo fermo, e il passeggero avrebbe già ricevuto la notifica di un fatto mai accaduto |
| D39 | Un soggetto notifica **dopo** che la transizione è stata persistita, e a chiamare `notifyObservers()` è il componente che ha scritto — non la classe di stato | §2.3.3, §2.6.3, Fig. 2.10 | L'azione `notifyPassenger()` della Fig. 2.10 sta dentro una transizione, ma una transizione può essere legale al momento della lettura e non esserlo più al momento della scrittura: è il caso che `ConcurrentTransitionError` descrive, e nasce dalla scrittura condizionata che D28 e la §2.6.3 richiedono. Notificando da dentro la classe di stato, il passeggero riceverebbe l'annuncio di un'assegnazione che il database ha poi rifiutato — e una scrittura si disfa, una notifica no. La struttura del pattern resta quella della Fig. 2.4: `Robotaxi` e `Ride` implementano `Subject`, l'observer è registrato alla costruzione dell'oggetto ed è sempre il solo `NotificationManager` |
| D40 | Il modulo `notifications` espone **due porte**: `INotificationService` (`update`) verso i soggetti e `INotificationSessionService` (`registerSession`, `removeSession`, `registeredSessions`) verso l'API Gateway | §2.2, §2.3.3 | La §2.3.3 descrive due relazioni con vite diverse (D7) e affida al `NotificationManager` la registrazione e la deregistrazione delle sessioni, ma il §2.2 gli attribuiva la sola `update(event)`: l'operazione che il testo pretende non compariva fra quelle esportate. I due lati hanno chiamanti disgiunti, e tenerli in una porta sola darebbe a `fleet` la possibilità di registrare sessioni e al gateway quella di inventare eventi di dominio. `registeredSessions()` esiste perché il criterio di completamento («non restano riferimenti») è un'affermazione sul registro, e senza un modo di leggerlo sarebbe inverificabile. È la stessa divisione fra porta di servizio e porta di meccanismo già adottata per `fleet` (D21) e per `rides` (D33) |
| D41 | `AuthenticationManager` pubblica `verify(accessToken)` sulla propria porta di meccanismo | §2.2.1, D21 | D21 realizza la verifica del token con dei guard applicati alle rotte, e copre tutto finché ciò che si protegge è una richiesta HTTP. L'handshake di una WebSocket non lo è — aprendo una socket il browser non può impostare l'header `Authorization`, quindi il token viaggia nel campo `auth` dell'handshake — e senza questa operazione il gateway dovrebbe verificarlo da sé, conoscendo la chiave di firma e il formato del payload di un altro modulo. Restituisce `null` invece di sollevare: un token scaduto mentre l'app è aperta è un esito ordinario del canale, non un guasto |
| D42 | Sul canale push il campo `type` è **annullabile**, e un evento di flotta che nessuna corsa riguarda non lascia una riga in `notification` | §2.3.3; RASD §2.2.3, Fig. 2.2 | L'enum `NotificationType` del RASD ha cinque valori pensati per il passeggero, e la `Notification` del RASD è indirizzata a un passeggero (`Notification "0..*" --> "1" Passenger : sent to`). Un veicolo che entra in manutenzione o comincia a riposizionarsi non ha un destinatario: raggiunge la dashboard dell'operatore, che sorveglia la flotta (R7, G8), ma non è una `Notification` e non ne esiste una categoria. Le alternative erano inventare un valore fuori dall'enum — facendo divergere codice e documento — o attribuire all'evento una categoria che non gli appartiene. Per la stessa ragione anche `MaintenanceManager` notifica, pur non essendo `FleetMonitor`: la §1.3 dice che l'Observer serve a segnalare «when the state of a vehicle changes», senza distinguere da quale componente la transizione sia stata innescata, e questo è il secondo componente che scrive quella colonna |
| D43 | La Figura 2.1 acquisisce **tre archi**: `FleetMonitor --( INotificationService`, `NotificationManager --( IPersistenceService`, `APIGateway --( INotificationSessionService` | §2.2, Fig. 2.1 | Stessa omissione che D29 ha corretto per il `RideRequestManager`, su un componente diverso. La §2.3.3 pretende che ogni cambiamento di stato di un `Robotaxi` raggiunga il `NotificationManager`, ma la figura dava al `FleetMonitor` due soli archi e nessuno dei due era quello: il componente che *produce* gli eventi non aveva modo di consegnarli. Il secondo arco è la conseguenza di due cose che la figura già chiede — la tabella `notification` (RASD §2.2.3) va scritta da qualcuno, e l'evento di un veicolo porta al più l'identificatore della richiesta, quindi risalire al passeggero è una lettura. Il terzo è la realizzazione di D40: le sessioni nascono e muoiono con le connessioni, che sono dell'API Gateway. `MaintenanceManager --( INotificationService` la figura ce l'ha già |
| D44 | Un modulo può **leggere** le tabelle di un altro attraverso `IPersistenceService`; a scriverle resta il modulo che le possiede | §2.2, §2.2.1 | `FleetMonitor` e `NotificationManager` leggono `ride_request` per instradare una notifica: il primo per sapere quale corsa il veicolo stia servendo, il secondo per risalire al passeggero. Nessuno dei due la scrive. La regola è quella che il progetto già applica senza enunciarla — `AllocationManager` legge `system_mode` e solo `ModeController` e lui stesso lo scrivono — e va detta perché il confine fra moduli non la copre: passare da `IPersistenceService` è meccanicamente lecito, quindi un cambiamento di semantica su una colonna altrui non verrebbe segnalato da nessun controllo automatico. Il costo è reale e accettato: chi cambia il significato di `ride_request.status` o di `assignedRobotaxiId` deve cercarne i lettori. L'alternativa — far passare il dato dal chiamante, come fa già `assign()` — vale dove il chiamante lo conosce, e infatti lì si fa; per le transizioni che nessuno innesca da `rides` non lo conosce nessuno |
| D45 | Il canale push assegna a ogni client una **room** (`passenger:<id>` o `operators`), ma la consegna di un evento di dominio passa dalla sessione | §2.3.3 | MILESTONES.md §M5 chiede le room, la §2.3.3 chiede che a decidere chi riceve cosa siano `PassengerAppSession` e `OperatorDashboardSession`. Consegnare per entrambe le vie duplicherebbe ogni notifica, quindi la via è una: la room resta l'**indirizzo** — il modo in cui il trasporto raggiunge un passeggero o l'insieme degli operatori senza passare da un evento di dominio — e la sessione l'**autorità** su chi ha diritto di vedere. Le firme delle sessioni portano di conseguenza un `NotificationDelivery` e non un `DomainEvent` come nella Fig. 2.4: la traduzione da evento a messaggio si fa una volta sola, nel manager, e `dispatch()` resta privato perché nessuno fuori dal modulo deve poter iniettare una consegna |
| D46 | Il canale push **non trasporta un ETA numerico** in M5: `VEHICLE_ARRIVING` annuncia che il veicolo è in avvicinamento, non fra quanti minuti arriva | §2.2, §2.4; RASD R6 | R6 elenca «vehicle assignment, **ETA**, arrival at the pickup point, and ride completion», e delle quattro cose questa è l'unica che il messaggio non porta. È una rinuncia consapevole e temporanea, non una svista. In M5 l'unico fornitore di tempi di viaggio è il mock deterministico di M3: un numero preso da lì e mostrato al passeggero come «il tuo robotaxi arriva fra 7 minuti» sarebbe una promessa inventata, e peggiorerebbe R6 invece di completarlo — un ETA sbagliato è meno utile di nessun ETA. Il dato diventa reale con M7, quando l'adapter OSRM e la telemetria del simulatore sostituiscono il mock ed è la posizione vera del veicolo a innescare la transizione 4: lì `NotificationDelivery` e `notificationPushSchema` prendono il campo, e la vista di stato dell'app passeggero (§3.1, M8) lo mostra. Fino ad allora il documento non deve lasciar credere che R6 sia coperto per intero |
| D47 | `IExternalServices.getDemandData()` **non entra in M6**: la domanda la legge il `RebalancingManager` da `demand_sample` e `demand_event` attraverso `IPersistenceService` | §2.2, §2.4 Fig. 2.7 | La Figura 2.7 disegna la domanda come dato di un servizio esterno, e con un fornitore vero è così. In questo prototipo però la sorgente di domanda *è* il database: le due tabelle sono fra le undici di M1, e i criteri con cui si interrogano — «gli eventi attivi in un istante», cioè `startsAt` non oltre `t` ed `endsAt` oltre `t` — sono già nella porta di persistenza, messi lì dalla D12. Farle passare da `IExternalServices` avrebbe messo il gateway dei servizi esterni **sopra** il gestore di persistenza per rileggere righe che il `RebalancingManager` può leggere da sé (D44), aggiungendo un arco fra moduli e un livello di traduzione senza aggiungere né verifica né sostituibilità. L'operazione entra in M7 insieme a un fornitore vero, che è ciò che la rende un servizio esterno invece di un giro di parole attorno a una `SELECT`. Conseguenza sulla Figura 2.1: l'arco `RebalancingManager --( IExternalServices` esiste nel disegno ma non è ancora realizzato |
| D48 | `setActiveStrategy(name, 'auto')` scrive **condizionatamente al modo Auto** e solleva se il modo è cambiato nel frattempo; con `'manual'` scrive sempre | §2.2.1, §2.4 Fig. 2.6 | La v1.1 aveva stabilito che il controllo su *se* un cambio automatico possa avvenire sta nel `ModeController`, per non scrivere la regola dell'isteresi in due posti. Resta vero, ma fra la lettura su cui il controller decide e la scrittura ci sta l'intera azione di un operatore su un'altra replica del tier applicativo (NFR3): senza condizione, un cambio automatico deciso un istante prima sovrascriverebbe una scelta manuale appena fatta, che è precisamente il modo in cui la §4.3 falsifica NFR10. La condizione non duplica l'isteresi — la valuta il database nella stessa istruzione della scrittura — ed è la stessa disciplina che D28 impone a ogni transizione di stato. L'asimmetria è il contenuto di NFR10: la scelta dell'essere umano non è condizionata da nulla |
| D49 | Il modulo `mode` espone **due porte**: `IModeControlService` e `ITrafficMonitorService` (`runOnce()`); `RebalancingScheduler` **non** ha una porta corrispondente | §2.2, §2.2.1 | La §2.2.1 elenca `TrafficMonitor.runOnce()` fra le attività periodiche e CLAUDE.md Regola 3 pretende che sia chiamabile dai test, ma HARNESS.md §3 vieta anche ai test di raggiungere l'interno di un modulo: senza porta, l'unico modo di provarlo sarebbe rompere il confine. È la stessa divisione fra porta di servizio e porta di meccanismo di D21, D33 e D40. `RebalancingScheduler` non la riceve perché non fa nulla oltre a chiamare `rebalance()`, che è già pubblica: pubblicarlo darebbe due nomi alla stessa operazione, e ciò che i test guidano è `rebalance()` attraverso la sua porta |
| D50 | Il `DomainEvent` della Fig. 2.4 acquisisce tre varianti — `StrategyChangedEvent`, `TrafficAlertEvent`, `RebalancingStartedEvent` — che non nascono da un `Subject` e portano `type: null` | §2.3.3, §2.4 Fig. 2.6 e 2.7 | Le Figure 2.6 e 2.7 disegnano `ModeController` e `RebalancingManager` mentre chiamano `update(...)` **direttamente** sul `NotificationManager`, senza essere soggetti dell'Observer, ed è la relazione giusta: soggetto è chi ha uno stato che gli altri osservano, mentre modo e riposizionamento sono decisioni, e una decisione si comunica una volta sola a chi la deve sapere. I soggetti restano due. `type: null` per la ragione già data da D42 — nessuno dei tre ha un passeggero come destinatario — quindi nessuno lascia una riga in `notification`. La regola di instradamento verso l'operatore passa di conseguenza da un elenco a un'esclusione: gli arrivano tutti gli eventi che non sono di corsa |
| D51 | L'alert della soglia `MEDIUM` si emette **quando la si raggiunge**, non a ogni lettura del traffico | §2.4; RASD R12 | R12 dice «if traffic conditions *reach* a Medium threshold»: è un passaggio di soglia, non uno stato. Il `TrafficMonitor` legge il traffico ogni pochi minuti, quindi ripetere l'alert a ogni lettura riempirebbe il pannello dell'operatore della stessa riga per tutta la durata della condizione — e un pannello che si riempie da solo è un pannello che si smette di guardare. La verifica ne risente in meglio: «esattamente un alert per attraversamento» è falsificabile, «almeno un alert» no |
| D52 | `rebalance()` manda **un veicolo per zona in deficit per ciclo**, e una zona cede solo i veicoli che eccedono la propria domanda attesa arrotondata per eccesso | §2.2.1, decisione D12 | La D12 fissa gli ordinamenti ma non *quanti* veicoli muovere. Il deficit è una domanda **attesa**, non una coda di richieste: pareggiarlo in un colpo svuoterebbe le zone in surplus e produrrebbe l'oscillazione che il ciclo successivo dovrebbe correggere — lo stesso effetto ping-pong che NFR9 vieta sul versante delle strategie. L'arrotondamento per eccesso della quota che una zona trattiene è prudente per la stessa ragione: cedere il veicolo che copre «1,2 corse attese» scoprirebbe una zona per riempirne un'altra |
| D53 | La zona di un veicolo si **calcola** con la regola della D10 a ogni ciclo, invece di leggere `robotaxi.zoneId` | §2.2.1, decisione D10 | La colonna esiste dallo schema di M1 ma nessun componente la aggiorna quando un veicolo si muove: da M7, con la telemetria del simulatore, sarebbe sistematicamente vecchia, e il riposizionamento deciderebbe in base a dove i veicoli erano al seed. La regola autorevole dell'appartenenza è la D10 ed è una funzione pura delle coordinate, quindi applicarla costa un confronto per veicolo e non può invecchiare |
| D54 | `ExternalServicesGateway` diventa un **facade** con un adapter per fornitore già in M6; l'adapter di traffico deduce il livello dall'ora locale di Milano | §2.2; NFR8 | Fino a M5 la porta aveva una sola operazione e una sola classe la realizzava, quindi facade e adapter coincidevano. Con `getTraffic()` i fornitori diventano due, e tenerli nella stessa classe avrebbe significato che l'adapter delle mappe risponde anche di quanto traffico c'è — la confusione che la §4.3 usa per falsificare NFR8. Il modello orario è un'**assunzione dichiarata del prototipo**, come la velocità media della stima lineare degli ETA: deterministico perché il suo unico ingresso è `ClockPort` (CLAUDE.md Regola 3), e sostituibile in M7 senza toccare `mode`, che conosce solo la porta |
| D55 | La Figura 2.1 acquisisce **due archi**: `ModeController --( IExternalServices` e `APIGateway --( IRebalancingService` | §2.2, Fig. 2.1 | Stessa omissione che D29 ha corretto per il `RideRequestManager` e D43 per il `FleetMonitor`, su altri due componenti. Il primo arco è richiesto dalla §2.2.1 stessa, che elenca `TrafficMonitor.runOnce()` fra le attività periodiche descrivendolo come «reads `getTraffic()` and calls `onTrafficLevel()`»: la Figura 2.6 disegna il verso opposto (`ESG ->> MC`) perché è un diagramma di sequenza e mostra chi *manda il messaggio*, non chi dipende da chi — a leggere il traffico è ROAd, non il fornitore a offrirlo. Il secondo è la conseguenza di R10: «identify high-demand zones» è un risultato che esiste solo se qualcuno lo può guardare, e chi lo guarda è l'operatore; la vista di deployment §2.5 l'arco ce l'ha già, la vista a componenti no |
| D56 | `ModeController.enableAuto()` emette `ModeChangedEvent` quando **non** commuta, distinto da `StrategyChangedEvent` | §2.3.3, §2.4 Fig. 2.6 | La Figura 2.6 non copre il rientro in Auto, e il caso più frequente è proprio quello che non commuta: su `MEDIUM` la banda morta prescrive di *tenere* la strategia (RASD R13). Riusare `StrategyChangedEvent` avrebbe messo nel pannello degli switch automatici (§3.2) il messaggio «strategia commutata automaticamente a X» esattamente dove nulla è stato commutato — una notizia falsa all'operatore. Non emettere nulla era l'altra uscita, e costava di più: le dashboard già connesse continuerebbero a mostrare `MANUAL` per un sistema tornato automatico, cioè l'indicatore che NFR10 vuole «always visible» direbbe il falso fino al ricaricamento |
| D57 | `GET /mode` **non** è uno snapshot transazionale: legge la strategia e poi il modo, in quest'ordine | §2.2.1; NFR10 | I due valori stanno su una riga sola (D6) ma le due letture appartengono a due componenti diversi, quindi arrivano al database separate e una scelta manuale può committare fra le due. Non essendoci un componente con titolo per esporre una lettura unica, si sceglie **quale disallineamento è possibile**: leggendo il modo per ultimo, la risposta non può mai dire `AUTO` dopo che un operatore ha preso il controllo — che è la falsificazione di NFR10 nella §4.3 mostrata a schermo. Il caso residuo, modo `MANUAL` con la strategia di un istante prima, si corregge alla richiesta successiva e non nega nessun intervento umano |
| D58 | `Zone.demandLevel` e l'enum `DemandLevel` del RASD non sono realizzati | RASD §2.2.3, Fig. 2.2 | Il RASD attribuisce a `Zone` un livello di domanda discreto (`LOW`, `MEDIUM`, `HIGH`). La decisione D12 lo sostituisce con una domanda attesa **continua**, calcolata a ogni analisi da base storica e moltiplicatori: una colonna con tre valori sarebbe una discretizzazione di quel numero, e per di più persistita — cioè una seconda verità da riscrivere a ogni cambio di fascia oraria e a ogni evento che comincia o finisce. `analyzeDemand()` restituisce il numero e l'ordinamento, che è ciò di cui R10 e R11 hanno bisogno; se la dashboard vorrà tre colori userà tre soglie sue |

**Fuori dal perimetro di questo documento.** Le decisioni D1, D2, D3, D4, D5, D10, D12, D13, D16, D25, D37,
D38, D39, D40, D41, D47, D49 e D54 hanno un riflesso anche nei file operativi del repository (`CLAUDE.md`, `MILESTONES.md`,
`HARNESS.md`, `docs/requirements.json`), che sono stati allineati nella stessa occasione. Il DD
resta la fonte: se in futuro divergono, è il file operativo a doversi adeguare.

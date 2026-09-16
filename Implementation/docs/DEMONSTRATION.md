# Demonstration Environment

This document describes the tools, configuration settings and scenario data used to demonstrate ROAd. The demonstrations cover representative passenger and operator workflows and relate their observable outcomes to the RASD goals.

They complement the automated checks with a review of the system from the users' perspective.

## Purpose

The RASD scenarios unfold over time scales that are difficult to show during a short presentation. Under normal configuration, advance bookings are activated fifteen minutes before departure, rebalancing runs every ten minutes, and traffic levels follow the local time of day.

The demonstration environment makes these behaviours observable within a few minutes by adjusting simulation parameters, scheduling intervals and input data. The application uses the same request-processing logic, state transitions and allocation rules.

## Environment structure

The demonstration environment consists of two groups of elements.

### Tools outside the application

These tools prepare and exercise the application and are not part of its deployment:

- **Demonstration runner:** prepares the database, applies the scenario configuration, starts the backend and both clients, and reports what to observe.
- **Scenario dataset:** stages a demand event at the San Siro stadium and prepares the fleet and demand records for the rebalancing scenario.
- **Ride-request generator:** submits passenger requests through the public API.
- **Browser automation script:** replays the immediate-ride scenario as a regression check.

### Configuration points inside the application

The application exposes configuration settings for:

- the time step of the fleet simulator;
- the cadence of periodic activities;
- the activation lead time of advance bookings;
- the traffic source;
- traffic slowdown factors and the zones affected by scripted traffic;
- allocation explanations.

Each setting has a default value for normal operation. The demonstration runner supplies scenario-specific values when needed.

![Demonstration environment: tools outside the application and configuration points inside it.](demonstration_environment.svg)

## Execution flow

The runner starts from a known database state and launches the services required by the selected scenario.

During an interactive demonstration, the stack remains active. Scheduled activities, generated requests and people using the clients can operate concurrently.

The automated browser replay terminates after checking its scenario.

![Activity diagram of a demonstration run.](demonstration_run.svg)

## Demonstration scenarios

| Scenario | Configuration | Observable behaviour | Related requirements and goals |
| --- | --- | --- | --- |
| **Immediate ride** | Accelerated simulated time. | A passenger request is assigned; the vehicle approaches the pickup point, picks up the passenger and completes the ride. Both clients update without a page reload. | R3, R5, R6, R7, NFR2 |
| **Advance booking** | Activation one minute before departure, checked every ten seconds. | The booking initially waits without an assigned vehicle. It is then activated and assigned automatically before departure. | R4, R5, R6 |
| **Traffic-aware allocation** | Scripted traffic in central zones, slowdown factors, allocation explanations and generated requests. | Medium traffic raises a suggestion. High traffic switches the strategy to Minimum ETA, allowing some pickups to be assigned to farther but faster vehicles. The strategy is retained at Medium and restored to Nearest Available at Low. | R5, R8, R12, NFR9 |
| **Fleet rebalancing** | Rebalancing every fifteen seconds and a staged stadium event. | Available vehicles from surplus zones move toward the stadium, one per cycle in this scenario, and become available again on arrival. | R10, R11, G9 |

## Traffic-aware allocation

### Interchangeable traffic sources

The external-services module provides two implementations of the `TrafficSource` abstraction:

- **`HourlyTrafficGateway`:** derives a traffic level from the current day and hour in Milan.
- **`ScriptedTrafficGateway`:** follows a configured sequence of traffic levels relative to backend startup.

Configuration selects which implementation is injected. `ExternalServicesGateway` delegates traffic queries to that source without depending on its concrete implementation.

The scripted source allows the demonstration to reproduce a sequence such as Low → Medium → High → Medium → Low at any time of day.

When central zones are configured, the script applies to those zones while the remaining zones stay at Low. Without a zone restriction, the scripted level applies throughout the service area.

### Traffic effects on movement and estimates

A shared `TrafficSlowdown` model translates the traffic level at a geographical point into a slowdown factor.

It is used by:

- the fleet simulator, to reduce vehicle progress according to traffic along its movement;
- travel-time estimation, to adjust the times compared by the Minimum ETA strategy.

The local traffic model remains encapsulated within the external-services module. The mode controller receives the single traffic level used for automatic strategy switching.

For travel-time adjustment, the current implementation samples the straight segment between origin and destination. This is an approximation when the routing provider supplies a road route. The simulator applies slowdown along the actual polyline it follows, so estimated and observed travel times are not guaranteed to match exactly.

![Class diagram of the traffic sources and shared slowdown model.](traffic_sources.svg)

### Automatic strategy switching

In automatic mode:

- **Low:** selects Nearest Available.
- **Medium:** retains the current strategy and raises a suggestion when the threshold is reached.
- **High:** selects Minimum ETA.

Retaining the current strategy at Medium creates a hysteresis band and avoids unnecessary switching.

In manual mode, traffic observations continue to be recorded, but they do not change the operator's selected strategy.

### Generated requests and allocation explanations

The request generator submits rides through the public API. These requests follow the same authentication, validation, allocation, reservation and notification flow as requests submitted through the passenger application.

During high traffic, Minimum ETA compares estimates that include traffic slowdown. A geographically closer vehicle can therefore have a longer estimated arrival time than a farther vehicle.

When allocation explanations are enabled, the operator can inspect the reasoning associated with the selected vehicle.

![Sequence diagram of a generated ride request allocated under high traffic, including the allocation explanation.](seq_demo_traffic_allocation.svg)

## Fleet simulation

The simulated fleet receives route commands through the external-services gateway.

A route command registers the waypoints that a vehicle must follow. A periodic scheduler then advances the simulator through explicit ticks. At each tick, the simulator calculates the distance the vehicle can cover and updates its coordinates along the route, accounting for configured traffic slowdown.

Telemetry exposes the updated position and whether the vehicle has reached its destination. The backend records those positions and processes the corresponding lifecycle transitions.

The clients periodically retrieve vehicle positions to update their map markers. Domain notifications, such as ride-status changes, are delivered through the notification channel.

This separation also supports automated testing: tests can advance the simulator explicitly without waiting for real time to pass.

## Demand and the rebalancing scenario

### Demand model

The prototype represents historical demand using persisted weekly profiles. The seed generates these profiles from predefined hourly patterns and zone-specific scale factors; they are synthetic scenario data.

At runtime, the rebalancing manager reads:

- the base demand for each zone at the current day and hour in Milan;
- demand events currently active in each zone;
- the available vehicles grouped by their current geographical positions.

Expected demand is calculated as:

**Expected demand = base demand × product of active-event multipliers**

The deficit used for rebalancing is:

**Deficit = expected demand − number of available vehicles**

A zone can release vehicles only when its available fleet exceeds its expected demand rounded upward. Target zones are considered in decreasing order of deficit, and eligible vehicles are selected by proximity to the target-zone centroid.

### Staged stadium event

The rebalancing dataset creates an event active around the time of the demonstration at San Siro and prepares lower demand in other zones so that vehicles can be released.

The event changes the inputs read by the regular rebalancing algorithm. The algorithm still evaluates demand, identifies surplus and deficit zones, requests valid robotaxi state transitions and sends route commands through the external-services gateway.

With one deficit zone in this scenario, a cycle dispatches at most one eligible vehicle toward the stadium. On arrival, the vehicle returns to Available.

The current deficit calculation counts available vehicles already in the zone. Vehicles still travelling toward it are not counted as coverage. At the shortened demonstration cadence, this can cause an additional dispatch before an earlier vehicle arrives.

## Reproducibility and scope

The runner prepares a known initial database state, and the request generator uses a fixed seed to reproduce its request sequence.

The complete execution is not strictly deterministic: scheduled activities, user interactions and generated requests run concurrently. Selected vehicles and observed timings may vary slightly between runs because vehicle positions evolve in real time and travel-time estimates depend on the configured routing provider.

The stadium event, demand profiles and generated requests are explicitly staged demonstration inputs. They illustrate the system's behaviour and do not represent measured demand or live traffic in Milan.

## Design rationale

- **Configurable timing:** periodic activities retain their application logic while their cadence can be shortened for observation.
- **Substitutable providers:** scripted and hourly traffic sources implement the same abstraction, demonstrating the provider substitution required by NFR8.
- **Encapsulated traffic modelling:** local traffic effects are handled within the external-services module through a shared slowdown model.
- **Public API access:** generated requests exercise the same application flow as passenger requests.
- **Declared scenario data:** demand events, historical profiles and request sequences are documented as controlled inputs.
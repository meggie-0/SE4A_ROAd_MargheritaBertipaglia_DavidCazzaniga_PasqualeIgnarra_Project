# RASD — Requirements Analysis and Specification Document

**ROAd — Autonomous Mobility Application**

| | |
|---|---|
| Authors | Margherita Bertipaglia, David Cazzaniga, Pasquale Ludovico Ignarra |
| University | Politecnico di Milano |
| Course | Software Engineering for Automation |
| Academic year | 2025-2026 |
| Date | July 2026 |

> **Nota sull'estrazione.** Questo file nasce come trascrizione integrale del testo di
> `../RASD/ROAd___RASD.pdf` (23 pagine), estratta con `pdftotext` e riformattata in Markdown senza
> riassumere. La numerazione dei capitoli, dei goal `[Gn]`, dei requisiti `[Rn]`/`[NFRn]`, delle
> assunzioni `[Dn]` e dei vincoli `[Cn]` è quella originale. Le figure, che nel PDF sono immagini,
> sono rese come sorgenti PlantUML presi da `../RASD/diagrams/` (fedeli all'originale) e — per le
> FSM, disegnate in draw.io — come tabella di transizione trascritta dal PDF.
>
> **Da v1.1 questo Markdown è la fonte autorevole**, non il PDF: il PDF v1.0 verrà rigenerato a fine
> progetto a partire da qui. Le modifiche rispetto al PDF v1.0 sono elencate nell'
> [Appendice A](#appendice-a--modifiche-rispetto-al-pdf-v10) e marcate **[v1.1]** nel testo. Sono
> deliberatamente poche: il RASD descrive il problema, e il problema non è cambiato.

---

## Contents

1. [Introduction](#1-introduction) — 2
   - 1.1 [Purpose](#11-purpose) — 2
     - 1.1.1 [General purpose](#111-general-purpose) — 2
     - 1.1.2 [Goals](#112-goals) — 2
   - 1.2 [Scope](#12-scope) — 3
     - 1.2.1 [General Scope](#121-general-scope) — 3
     - 1.2.2 [Phenomena](#122-phenomena) — 3
   - 1.3 [Definitions, Acronyms, Abbreviations](#13-definitions-acronyms-abbreviations) — 4
     - 1.3.1 [Definitions](#131-definitions) — 4
     - 1.3.2 [Acronyms](#132-acronyms) — 6
     - 1.3.3 [Abbreviations](#133-abbreviations) — 6
   - 1.4 [Document Structure](#14-document-structure) — 6
2. [Overall Description](#2-overall-description) — 8
   - 2.1 [Scenarios](#21-scenarios) — 8
   - 2.2 [Domain Model](#22-domain-model) — 9
     - 2.2.1 [Main Entities](#221-main-entities) — 9
     - 2.2.2 [Key Relationships](#222-key-relationships) — 10
     - 2.2.3 [Class Diagrams](#223-class-diagrams) — 11
   - 2.3 [User Characteristics](#23-user-characteristics) — 14
   - 2.4 [Product Functions](#24-product-functions) — 14
   - 2.5 [Nonfunctional Aspects](#25-nonfunctional-aspects) — 16
   - 2.6 [Assumptions, Dependencies and Constraints](#26-assumptions-dependencies-and-constraints) — 17
3. [Additional Models](#3-additional-models) — 19
   - 3.1 [Requirements-level Sequence Diagrams](#31-requirements-level-sequence-diagrams) — 19
   - 3.2 [Finite State Machines](#32-finite-state-machines) — 22
4. [References](#4-references) — 23
- [Appendice A — Modifiche rispetto al PDF v1.0](#appendice-a--modifiche-rispetto-al-pdf-v10)

---

# 1 Introduction

## 1.1 Purpose

### 1.1.1 General purpose

ROAd, Robotaxi Optimized Allocation, is a software system created to support the management of an
autonomous taxi fleet within an urban environment. Its purpose is to help fleet operators keep track
of robotaxis, manage passenger ride requests, assign vehicles effectively, and redistribute idle
vehicles across the city based on expected demand.

The main goal of ROAd is to reduce passenger waiting times while improving the overall efficiency of
the fleet. To achieve this, the system supports different vehicle allocation strategies, such as
assigning the nearest available robotaxi or choosing the vehicle with the lowest estimated arrival
time. The fleet operator can change the selected strategy at runtime, allowing the system to adapt
to different operational needs. In addition, dynamic fleet rebalancing supports this process by
moving idle taxis toward areas where demand is expected to be higher, using both historical and
real-time data.

ROAd also supports advance ride booking, which requires the system to manage vehicle availability
over time and avoid conflicts between immediate rides and scheduled bookings. The system explicitly
follows the lifecycle of each robotaxi, from availability to assignment, arrival, ride execution,
and maintenance. Passengers are informed whenever relevant changes occur in the state of their
assigned vehicle.

The project focuses on the software architecture and management logic of the robotaxi allocation
platform. Autonomous driving, payment processing, and mapping services are treated as external
dependencies and are not implemented as part of the system.

### 1.1.2 Goals

- **[G1]** Users must be able to register, log in, and manage their personal account.
- **[G2]** Users must be able to request an immediate robotaxi ride by providing pickup and
  destination locations.
- **[G3]** Users must be able to book a robotaxi ride in advance by specifying pickup location,
  destination, date, and time.
- **[G4]** The system must be able to assign an available robotaxi to a ride request according to
  the allocation strategy selected by the fleet operator.
- **[G5]** The fleet operator must be able to select and change the vehicle allocation strategy at
  runtime.
- **[G6]** The system must be able to track and update the state of each robotaxi during its
  lifecycle.
- **[G7]** Users must be notified about relevant updates concerning their ride, such as vehicle
  assignment, vehicle arrival, and ride status changes.
- **[G8]** The fleet operator must be able to monitor the current status and position of the
  robotaxi fleet.
- **[G9]** The system must be able to identify zones with expected high demand and suggest or
  trigger the rebalancing of idle robotaxis.
- **[G10]** The system must prevent conflicting assignments or reservations of the same robotaxi for
  overlapping rides or bookings.

## 1.2 Scope

### 1.2.1 General Scope

The S2B will interact with both passengers and fleet operators. For passengers, it will provide a
mobile application that allows them to request or book robotaxi rides. For fleet operators, it will
provide a web-based graphical user interface to monitor and manage the autonomous fleet.

The main functionality offered to passengers is the possibility to request a robotaxi ride directly
from the application, either immediately or in advance, making urban transportation simpler and
helping reduce waiting times.

Fleet operators are responsible for supervising the robotaxi fleet, selecting the vehicle allocation
strategy, monitoring vehicle states and positions, and managing the distribution of idle vehicles
across the city. The system also supports demand-driven rebalancing, helping operators improve fleet
efficiency and reduce passenger waiting times.

### 1.2.2 Phenomena

The ROAd system includes several interactions among passengers, fleet operators, robotaxis, and
external services.

| Phenomenon | Controller | Shared |
|---|---|---|
| Passenger decides to use the ROAd service | W | N |
| Passenger registration | W | Y |
| Passenger login | W | Y |
| Passenger submits an immediate ride request | W | Y |
| Passenger submits an advance ride booking request | W | Y |
| Passenger provides pickup and destination locations | W | Y |
| Passenger cancels a pending or scheduled ride | W | Y |
| Fleet operator login | W | Y |
| Fleet operator selects the vehicle allocation strategy | W | Y |
| Fleet operator monitors fleet status and positions | W | Y |
| Robotaxi sends its current position to the system | W | Y |
| Robotaxi sends its current operational state to the system | W | Y |
| Robotaxi is moved toward a rebalancing zone | W | Y |
| Robotaxi enters maintenance | W | Y |
| External mapping service provides route and travel-time information | W | Y |
| External demand data source provides historical or real-time demand data | W | Y |
| Ride starts when the passenger boards the assigned robotaxi | W | Y |
| Ride ends when the passenger reaches the destination | W | Y |
| System validates user credentials | M | N |
| System stores passenger and fleet operator account data | M | N |
| System checks robotaxi availability | M | N |
| System checks for conflicts between immediate rides and advance bookings | M | N |
| System assigns a robotaxi to a ride request | M | Y |
| System reserves a robotaxi for an advance booking | M | Y |
| System applies the currently selected allocation strategy | M | N |
| System updates the state of a robotaxi | M | Y |
| System updates the state of a ride | M | Y |
| System marks a robotaxi as unavailable during maintenance | M | Y |
| System notifies the passenger about vehicle assignment | M | Y |
| System notifies the passenger about robotaxi arrival | M | Y |
| System notifies the passenger about ride status changes | M | Y |
| System identifies zones with expected high demand | M | N |
| System suggests or triggers the rebalancing of idle robotaxis | M | Y |

*(Controller: `W` = World, `M` = Machine.)*

## 1.3 Definitions, Acronyms, Abbreviations

### 1.3.1 Definitions

- **User**: a generic actor who interacts with the ROAd system. Depending on the context, a user can
  be either a passenger or a fleet operator.
- **Passenger**: a person who uses the ROAd mobile application to request an immediate robotaxi
  ride, book a ride in advance, monitor the assigned vehicle, and receive ride-related
  notifications.
- **Fleet Operator**: a person responsible for supervising and managing the robotaxi fleet through
  the ROAd web interface. The fleet operator can monitor vehicles, select allocation strategies, and
  manage fleet rebalancing.
- **Robotaxi**: an autonomous taxi belonging to the fleet managed by ROAd. A robotaxi can be
  assigned to passengers, execute rides, become unavailable, or enter maintenance.
- **Fleet**: the set of robotaxis managed by the ROAd system in the considered urban area.
- **Ride Request**: a request submitted by a passenger to travel from a pickup location to a
  destination. A ride request can be immediate or scheduled in advance.
- **Immediate Ride**: a ride requested by a passenger to be served as soon as possible.
- **Advance Booking**: a ride request scheduled by a passenger for a future date and time. The
  system must reserve a suitable robotaxi while avoiding conflicts with other assignments or
  reservations.
- **Pickup Location**: the location where the passenger wants to be picked up by the assigned
  robotaxi.
- **Destination**: the location where the passenger wants to be dropped off.
- **Allocation Strategy**: a policy used by the system to select which available robotaxi should be
  assigned to a ride request. Examples include selecting the nearest available vehicle or the
  vehicle with the minimum estimated arrival time.
- **Runtime Strategy Selection**: the possibility for the fleet operator to change the active
  allocation strategy while the system is running, without stopping the service.
- **Vehicle State**: the current lifecycle condition of a robotaxi. In ROAd, relevant states include
  available, assigned, arriving, arrived, in ride, and maintenance.
- **Available Robotaxi**: a robotaxi that is currently not assigned to any ride, not executing a
  ride, and not under maintenance.
- **Assigned Robotaxi**: a robotaxi that has been selected by the system to serve a passenger's ride
  request.
- **Idle Robotaxi**: a robotaxi that is available and not currently serving a passenger. Idle
  robotaxis may be considered for fleet rebalancing.
- **Fleet Rebalancing**: the process of repositioning idle robotaxis toward areas where high demand
  is expected, in order to reduce future passenger waiting times.
- **Demand Zone**: an area of the city associated with expected or detected ride demand.
- **High-Demand Zone**: a demand zone where the system predicts or detects a high number of ride
  requests.
- **Estimated Time of Arrival**: the estimated time needed by a robotaxi to reach a passenger's
  pickup location.
- **Notification**: a message sent by the system to a passenger or fleet operator to communicate
  relevant events, such as vehicle assignment, vehicle arrival, ride status changes, or rebalancing
  information.
- **Maintenance**: a condition in which a robotaxi is unavailable because it requires inspection,
  repair, cleaning, or any other operation that prevents it from serving rides.
- **External Mapping Service**: an external service used by ROAd to obtain geographical information,
  routes, distances, and travel-time estimations.
- **External Demand Data Source**: an external or historical data source used by ROAd to estimate
  future ride demand in different city zones.
- **Conflict**: a situation in which the same robotaxi would be assigned or reserved for two or more
  overlapping rides or bookings. The system must prevent such situations.

### 1.3.2 Acronyms

- **ROAd**: Robotaxi Optimized Allocation.
- **S2B**: Software To Be, the software system described and specified in this document.
- **API**: Application Programming Interface.
- **ETA**: Estimated Time of Arrival.
- **GPS**: Global Positioning System.
- **UI**: User Interface.
- **GUI**: Graphical User Interface.
- **FSM**: Finite State Machine.
- **UML**: Unified Modeling Language.

### 1.3.3 Abbreviations

- **[Gn]**: used to identify the n-th goal.
- **[Rn]**: used to identify the n-th functional requirement.
- **[NFRn]**: used to identify the n-th non-functional requirement.
- **[Dn]**: used to identify the n-th domain assumption.
- **[UCn]**: used to identify the n-th use case.
- **[SDn]**: used to identify the n-th sequence diagram.
- **[FSMn]**: used to identify the n-th finite state machine.

## 1.4 Document Structure

- **Chapter 1 - Introduction**: this chapter introduces the ROAd system, describing its purpose,
  goals, scope, main phenomena, and terminology. It also provides the structure of the document.
- **Chapter 2 - Overall Description**: this chapter provides a general description of the system
  from a requirements perspective. It includes relevant scenarios, the domain model, user
  characteristics, main product functions, non-functional aspects, and the main assumptions,
  dependencies, and constraints.
- **Chapter 3 - Additional Models**: this chapter provides additional models used to clarify the
  expected behavior of the system. In particular, it includes requirements-level sequence diagrams
  and finite state machines for the most relevant system processes.
- **Chapter 4 - References**: this chapter lists the documents, papers, standards, and other sources
  used as references for the preparation of this document.

---

# 2 Overall Description

## 2.1 Scenarios

This section provides an informal description of relevant scenarios to illustrate the shared
phenomena between the ROAd system and the external world, highlighting the interactions involving
the main actors: Passengers and Fleet Operators.

### Scenario 1: Immediate Ride Request and Vehicle Lifecycle

Alice, a registered Passenger, needs to travel from her office to the city center. She opens the
ROAd mobile application and submits an immediate ride request by providing her pickup location and
destination. The system processes the request and applies the currently active allocation strategy,
assigning the nearest available robotaxi to her. The chosen robotaxi passes from the available state
to the assigned state, and Alice receives a notification on her app confirming the assignment.
Shortly after, the robotaxi starts moving towards Alice's pickup location, transiting to the
arriving state, and Alice is notified again. Once the vehicle reaches the pickup location, it enters
the arrived state, and Alice receives a final notification to board. Alice boards the robotaxi,
changing its state to in-ride. Upon reaching the destination, Alice exits the vehicle, and the
robotaxi becomes available again to serve new requests.

### Scenario 2: Advance Ride Booking

Bob wants to ensure he arrives at the airport on time. He opens the ROAd application and books a
robotaxi in advance, specifying his home as the pickup location, the airport as the destination, and
scheduling the pickup for 7:00 AM the following day. The system applies the active allocation
strategy, selects a suitable robotaxi and atomically reserves its availability for the required time
interval, avoiding conflicts with other immediate rides and advance bookings. The next morning,
shortly before the scheduled time, the system activates the reservation. The selected robotaxi
transitions from available to assigned and then to arriving, and Bob is notified of the ride
progress.

### Scenario 3: Automated and Manual Allocation Strategy Management

Mark is a Fleet Operator supervising the city's robotaxi fleet through the ROAd web interface while
the system is in Auto Mode. During a period of heavy rain, traffic in the city increases. The system
detects the traffic level as Medium and displays a notification on Mark's dashboard suggesting a
switch from the default Nearest Available Vehicle strategy to the Minimum Estimated Time of Arrival
(ETA) policy to mitigate delays. Mark observes the situation but decides to remain in Auto Mode. As
congestion continues to rise, the system detects a High traffic level and automatically switches the
active strategy to Minimum ETA to ensure faster passenger pickups. Later, Mark determines that a
specific operational condition requires a manual override, he manually selects the Nearest Available
strategy. The system immediately transitions to Manual Mode, suspending all automated strategy
changes until Mark explicitly re-enables Auto Mode via the dashboard interface.

### Scenario 4: Dynamic Fleet Rebalancing

The ROAd system continuously collects and analyzes historical and real-time data provided by
external demand data sources. Late in the evening, a major concert ends at the city stadium. The
system predicts this area as a high-demand zone. To minimize customer wait times, the system
proactively initiates dynamic fleet rebalancing. It identifies several idle robotaxis scattered in
low-demand areas of the city and triggers their repositioning toward the stadium. Mark, the Fleet
Operator, observes these rebalancing movements on his monitor as the vehicles are routed to
efficiently manage the increases in ride requests.

## 2.2 Domain Model

The domain model captures the core entities of the ROAd ecosystem and the relationships between
them, representing the conceptual structure of the urban autonomous mobility service.

### 2.2.1 Main Entities

- **User**: An abstract entity representing any person interacting with the system, holding account
  credentials and personal data.
- **Passenger**: A specialized user who utilizes the mobile application to request or book rides and
  receive notifications.
- **Fleet Operator**: A specialized user responsible for supervising the fleet, selecting allocation
  strategies, and managing rebalancing through the web interface.
- **Robotaxi**: An autonomous vehicle characterized by its unique ID, current GPS position, and
  operational state (Available, Assigned, Arriving, Arrived, In Ride, Maintenance).
- **Ride Request**: A conceptual entity representing a passenger's need for transport. It contains
  the pickup location, destination, and status. A request is initially pending, then it can be
  accepted if a suitable robotaxi is assigned, rejected if no feasible vehicle is available,
  cancelled by the passenger, or completed after the ride has ended.
  - **Immediate Ride**: A request to be served as soon as possible.
  - **Advance Booking**: A request scheduled for a specific future date and time. When accepted, it
    reserves the selected Robotaxi for the corresponding time interval.
- **Ride**: An actual transport service generated from an accepted Ride Request. It represents the
  execution of the trip assigned to a Robotaxi, from pickup to destination, and keeps track of its
  lifecycle through states such as Scheduled, Waiting for Pickup, In Progress, Completed, or
  Cancelled.
- **Location**: A geographical point defined by coordinates, used to specify Pickup and Destination
  points.
- **Zone**: A partition of the urban area used to track demand and trigger fleet rebalancing.
- **System Mode**: An attribute of the ROAd system that determines the control logic for vehicle
  allocation, supporting Auto and Manual modes.
- **Traffic Level**: A dynamic parameter provided by external mapping services, classified as Low,
  Medium, or High, which serves as the input for automated strategy switching.
- **Allocation Strategy**: The policy used for vehicle assignment.
  - **Nearest Available Vehicle**: Optimized for energy efficiency and battery preservation
    (default).
  - **Minimum ETA**: Optimized for service performance and passenger wait-time reduction during
    congestion.
- **Maintenance Event**: An event representing a period in which a Robotaxi is unavailable due to
  inspection, repair, cleaning, or any other operational reason. During a maintenance event, the
  corresponding Robotaxi cannot be assigned to ride requests.

### 2.2.2 Key Relationships

- **Passenger - Ride Request**: A Passenger can submit multiple Ride Requests over time, but each
  request is associated with exactly one Passenger.
- **Ride Request - Location**: Each Ride Request must specify exactly one Pickup Location and one
  Destination.
- **Passenger - Ride**: A Passenger can take multiple Rides over time, but each Ride is associated
  with exactly one Passenger.
- **Robotaxi - Ride Request**: A Robotaxi is selected for a Ride Request by the system based on the
  active strategy. A Robotaxi may serve multiple requests over time, but its assignments and
  reservations must never overlap.
- **Fleet Operator - Allocation Strategy**: The Fleet Operator selects and can change the active
  Allocation Strategy at runtime.
- **Fleet Operator - System Mode**: The Fleet Operator can switch the system between Auto and Manual
  modes via the web interface.
- **System - Allocation Strategy**: In Auto Mode, the system dynamically selects the Allocation
  Strategy based on the current Traffic Level and provides suggestions to the operator.
- **Fleet Operator - Allocation Strategy**: In Manual Mode, the Operator directly selects the
  strategy; performing this action while in Auto Mode triggers an automatic override and switches
  the system to Manual Mode.
- **External Mapping Service - Traffic Level**: The external service provides real-time Traffic
  Level data used by the system to evaluate strategy transitions.
- **Robotaxi - Zone**: Every Robotaxi is located within a specific Zone at any given time. Zones are
  used to identify High-Demand areas for Rebalancing.
- **Fleet - Robotaxi**: A Fleet is composed of multiple Robotaxis managed by the system.
- **Ride Request - Ride**: An accepted Ride Request can generate one Ride, while rejected or
  cancelled requests do not produce any Ride.
- **Robotaxi - Maintenance Event**: A Robotaxi can be associated with multiple Maintenance Events
  over time. When a Maintenance Event is active, the Robotaxi is considered unavailable for
  assignment.

### 2.2.3 Class Diagrams

The diagrams presented in this section describe the domain model of the ROAd system. They provide a
conceptual view of the main entities involved in the autonomous robotaxi allocation service,
together with their relevant attributes and relationships.

Since the purpose of these diagrams is to support requirements analysis, they abstract from
implementation details and do not aim to represent the complete software architecture or all the
classes that will be introduced in the design phase.

Some attributes are represented through enumerations in order to make the possible states or
categories explicit.

#### Figure 2.1: Core ROAd domain entities

Source: `../RASD/diagrams/class_diagrams/domain_model_base.puml`

```plantuml
package "Data types" {
    class DateTime <<datatype>> {
        + day: Integer
        + month: Integer
        + year: Integer
        + hour: Integer
        + minutes: Integer
        + seconds: Integer
    }
    class GNSSPose <<datatype>> {
        + latitude: Real
        + longitude: Real
        + altitude: Real
    }
}

package "Enumerations" {
    enum RequestStatus {
        PENDING
        ACCEPTED
        REJECTED
        CANCELLED
        COMPLETED
    }
    enum RobotaxiState {
        AVAILABLE
        ASSIGNED
        ARRIVING
        ARRIVED
        IN_RIDE
        MAINTENANCE
    }
}

class User <<abstract>> {
    - userID: String
    - name: String
    - surname: String
    - email: String
    - password: String
}
class Passenger {
    - phoneNumber: String
}
class FleetOperator {
    - operatorID: String
}
class Fleet {
    - fleetID: String
    - city: String
}
class Robotaxi {
    - robotaxiID: String
    - currentPosition: GNSSPose
    - state: RobotaxiState
}
class RideRequest <<abstract>> {
    - requestID: String
    - status: RequestStatus
    - creationTime: DateTime
}
class ImmediateRide {
}
class AdvanceBooking {
    - scheduledDateTime: DateTime
}
class Location {
    - locationPose: GNSSPose
    - address: String
}

User <|-- Passenger
User <|-- FleetOperator
RideRequest <|-- ImmediateRide
RideRequest <|-- AdvanceBooking

Passenger "1" --> "0..*" RideRequest : submits
FleetOperator "1..*" --> "1" Fleet : monitors
Fleet "1" *-- "1..*" Robotaxi : contains
RideRequest "0..*" --> "0..1" Robotaxi : assigned to
RideRequest "1" -- "1" Location : pickup
RideRequest "1" -- "1" Location : destination
```

#### Figure 2.2: Allocation, rebalancing, and notification entities

Source: `../RASD/diagrams/class_diagrams/allocation_rebalancing.puml`

```plantuml
class FleetOperator {
    - operatorID: String
}
class AllocationStrategy <<abstract>> {
    - strategyID: String
    - name: String
}
class NearestAvailableStrategy {
}
class MinimumETAStrategy {
}
class RideRequest <<abstract>> {
    - requestID: String
    - status: RequestStatus
    - creationTime: DateTime
}
class Passenger {
    - phoneNumber: String
}
class Notification {
    - notificationID: String
    - message: String
    - creationTime: DateTime
    - type: NotificationType
}
class Robotaxi {
    - robotaxiID: String
    - currentPosition: GNSSPose
    - state: RobotaxiState
}
class Zone {
    - zoneID: String
    - zoneName: String
    - demandLevel: DemandLevel
}
class RebalancingAction {
    - actionID: String
    - status: RebalancingStatus
    - creationTime: DateTime
}

enum DemandLevel {
    LOW
    MEDIUM
    HIGH
}
enum RebalancingStatus {
    SUGGESTED
    TRIGGERED
    COMPLETED
    CANCELLED
}
enum NotificationType {
    VEHICLE_ASSIGNED
    VEHICLE_ARRIVING
    VEHICLE_ARRIVED
    RIDE_STATUS_CHANGED
    REBALANCING_ALERT
}

NearestAvailableStrategy --|> AllocationStrategy
MinimumETAStrategy --|> AllocationStrategy

FleetOperator "0..*" --> "1" AllocationStrategy : selects
AllocationStrategy "1" --> "0..*" RideRequest : used for
Notification "0..*" --> "1" Passenger : sent to
Notification "0..*" --> "0..1" RideRequest : refers to
Robotaxi "0..*" --> "1" Zone : located in
RebalancingAction "1" --> "1..*" Robotaxi : involves
RebalancingAction "0..*" --> "1" Zone : targets
```

#### Figure 2.3: Ride execution and robotaxi lifecycle entities

Source: `../RASD/diagrams/class_diagrams/ride_lifecycle.puml`

```plantuml
class RideRequest <<abstract>> {
    - requestID: String
    - status: RequestStatus
    - creationTime: DateTime
}
class Ride {
    - rideID: String
    - startTime: DateTime
    - endTime: DateTime
    - status: RideStatus
}
class Location {
    - locationPose: GNSSPose
    - address: String
}
class Passenger {
    - phoneNumber: String
}
class Robotaxi {
    - robotaxiID: String
    - currentPosition: GNSSPose
    - state: RobotaxiState
}
class MaintenanceEvent {
    - maintenanceID: String
    - startTime: DateTime
    - endTime: DateTime
    - reason: String
    - status: MaintenanceStatus
}

enum RideStatus {
    SCHEDULED
    WAITING_FOR_PICKUP
    IN_PROGRESS
    COMPLETED
    CANCELLED
}
enum MaintenanceStatus {
    SCHEDULED
    ONGOING
    COMPLETED
    CANCELLED
}

RideRequest "1" --> "0..1" Ride : generates
Passenger "1" --> "0..*" Ride : takes
Robotaxi "0..1" --> "0..1" Ride : serves
Robotaxi "1" --> "0..*" MaintenanceEvent : has
Ride "1" -- "1" Location : pickup
Ride "1" -- "1" Location : destination
```

## 2.3 User Characteristics

The ROAd system is designed to be used by two primary categories of users, each with distinct roles,
technical requirements, and operational goals. Understanding these characteristics is essential to
ensure the system meets the practical needs of urban mobility.

### Passengers

Passengers represent the general public and are the primary consumers of the robotaxi service. Their
main objective is to obtain reliable, point-to-point transportation with minimal effort and waiting
time.

- **Technical Literacy**: Passengers are expected to have a basic to intermediate level of
  familiarity with mobile applications. The interface must be intuitive, requiring no specialized
  training.
- **Needs**: They require a streamlined process for requesting immediate rides or scheduling advance
  bookings. Real-time updates and clear notifications regarding vehicle status (e.g., assignment,
  arrival) are critical for a positive user experience.
- **Mobility Patterns**: Their usage varies from daily commuting to occasional trips (e.g., airport
  transfers), necessitating a system that can handle both spontaneous and planned requests
  efficiently.

### Fleet Operators

Fleet Operators are professional users responsible for the supervision, management, and optimization
of the autonomous vehicle fleet. They act as the "controllers" of the system's high-level logic.

- **Technical Literacy**: They are expected to be proficient in using web-based management
  interfaces and interpreting data visualizations (e.g., fleet maps, demand heatmaps). They must
  understand the implications of different vehicle allocation strategies.
- **Responsibilities**: Their primary tasks include monitoring the real-time distribution and state
  of the fleet and overseeing proactive rebalancing operations. Crucially, they act as supervisors
  of the automated allocation logic; they are responsible for evaluating system-generated
  suggestions triggered by traffic fluctuations and executing manual overrides to take direct
  control of the active allocation strategy during exceptional or unforeseen operational conditions.
- **Needs**: They require a comprehensive "command and control" dashboard that provides a clear
  overview of traffic levels, high-demand zones, and vehicle lifecycle transitions. Furthermore, the
  interface must clearly display the current operational state of the system (Auto or Manual mode)
  and provide immediate alerts for strategy switch suggestions, empowering them to make informed
  decisions safely and without service interruption.

## 2.4 Product Functions

The main functions of the ROAd system are categorized based on the primary interactions between the
software and its users (Passengers and Fleet Operators) and its autonomous management logic. These
functions are designed to satisfy the project goals.

### User Management and Authentication

- **[R1] Registration and Login**: The system will allow Passengers to create and manage personal
  accounts and allow both Passengers and Fleet Operators to securely authenticate into their
  respective interfaces.
- **[R2] Profile Management**: Users will be able to update their personal information and
  credentials.

### Ride Management

- **[R3] Immediate Ride Request**: The system will allow Passengers to request a robotaxi for
  immediate pickup by specifying a pickup location and a destination.
- **[R4] Advance Booking**: The system will allow Passengers to schedule a ride for a future date
  and time. The system will select a suitable robotaxi and reserve its availability for the required
  time interval, preventing overlapping assignments and reservations.
- **[R5] Automated Vehicle Allocation**: The system will automatically assign an available robotaxi
  to a request based on the allocation strategy currently selected.
- **[R6] Ride Status Notifications**: The system will provide real-time updates to Passengers
  regarding vehicle assignment, ETA, arrival at the pickup point, and ride completion.
- **[R14] Ride Cancellation [v1.1]**: The system will allow a Passenger to cancel a pending
  immediate request or a scheduled advance booking before the ride begins. Cancelling releases the
  reservation held on the selected robotaxi, returns the vehicle to the available state if it had
  already been assigned, and makes the released time window bookable again.

  *Perché è nuovo:* l'annullamento era già nel documento come fenomeno condiviso (§1.2.2,
  "Passenger cancels a pending or scheduled ride") e come stato `CANCELLED` di `RequestStatus` e
  `RideStatus` (§2.2.3), ma nessun requisito lo enunciava, quindi restava fuori dalla tracciabilità.
  È numerato R14 per non rinumerare R1–R13, ampiamente citati altrove.

  *Copertura [v1.3]:* **il requisito è coperto per intero da M7.** «Before the ride begins»
  comprende, alla lettera, anche i momenti in cui il veicolo si è già mosso verso il punto di ritiro
  — la corsa comincia con la salita del passeggero, non con la partenza del veicolo — e il sistema
  ora annulla anche da lì: le transizioni 12 e 13 del DD §2.6.3 (decisione D59) riportano ad
  `AVAILABLE` un veicolo in avvicinamento o fermo al ritiro, dopo avergli **revocato la rotta** con
  `commandRoute()`. L'ordine conta: senza la revoca, un veicolo verrebbe dichiarato disponibile
  mentre continua a percorrere la rotta di una corsa annullata.

  Il solo rifiuto che resta è da `IN_RIDE`, ed è il confine che il requisito stesso pone: lì il
  passeggero è a bordo e la corsa è cominciata (§1.2.2). Fino a M6 il rifiuto arrivava molto prima —
  bastava che il veicolo si fosse mosso — perché `commandRoute()` non esisteva ancora (DD §2.6.3,
  decisione D27), e la copertura era dichiaratamente parziale.

### Fleet Supervision and Control

- **[R7] Real-time Fleet Monitoring**: The system will provide Fleet Operators with a live overview
  of the entire fleet, displaying the position and state (e.g., available, assigned, maintenance) of
  every robotaxi.
- **[R8] Runtime Strategy Selection**: The system will allow Fleet Operators to switch the active
  vehicle allocation policy (e.g., Nearest Available vs. Minimum ETA) at runtime without service
  interruption.
- **[R9] Maintenance Management**: The system will allow robotaxis to be marked as unavailable for
  maintenance and prevent their assignment to rides during such periods.

### Optimization and Rebalancing

- **[R10] Demand Analysis**: The system will process data from external sources to identify
  high-demand zones in the city.
- **[R11] Proactive Fleet Rebalancing**: The system will suggest or automatically trigger the
  repositioning of idle robotaxis toward high-demand areas to reduce future passenger waiting times.

### Dynamic Allocation Strategy Management

To minimize customer wait times and optimize battery usage, the system manages the vehicle
allocation strategy through two distinct operational modes: Auto and Manual.

- **[R12] Auto Mode (Default)**: The system dynamically manages the active allocation strategy based
  on real-time traffic data.
  - The default strategy is Nearest Available Vehicle to optimize travel distance and battery
    consumption.
  - If traffic conditions reach a Medium threshold, the system alerts the Fleet Operator, suggesting
    a switch to the Minimum Estimated Time of Arrival (ETA) strategy.
  - If traffic conditions reach a High threshold, the system automatically switches the active
    strategy to Minimum ETA to efficiently handle the queue of requests.
  - To prevent a ping-pong effect, the system will automatically revert to the Nearest Available
    Vehicle strategy only when traffic conditions drop back to the Low threshold.
- **[R13] Manual Mode (Override)**: The Fleet Operator retains ultimate control over the system.
  - If the Operator manually selects a specific allocation strategy, overriding the automated
    choice, the system immediately transitions to Manual Mode.
  - In Manual Mode, all automated strategy switches are suspended. The system will strictly follow
    the Operator's chosen strategy regardless of traffic changes.
  - The system remains in Manual Mode until the Operator explicitly re-enables Auto Mode via the
    dashboard.
  - **[v1.1]** When the Operator re-enables Auto Mode, the system immediately re-evaluates the
    current traffic level and applies the strategy that R12 prescribes for it, without waiting for
    the next traffic change. Should the level be Medium, which R12 never treats as a switching
    threshold, the strategy active at that instant is kept.

    *Perché è stato aggiunto:* il v1.0 diceva quando si esce dal Manual Mode ma non che cosa vale
    subito dopo. Senza questa frase il sistema potrebbe restare a tempo indeterminato sulla scelta
    manuale pur dichiarandosi in Auto Mode, in contraddizione con R12. Non intacca NFR9: l'isteresi
    serve a smorzare le oscillazioni del livello di traffico, non a rinviare un livello già noto.

## 2.5 Nonfunctional Aspects

The nonfunctional requirements (NFRs) specify the system's quality attributes, focusing on
performance, reliability, usability, and maintainability. These aspects are critical to ensure that
the ROAd platform operates efficiently in a dynamic urban environment.

### Performance and Scalability

- **[NFR1] Concurrency Handling**: The system will be capable of handling multiple concurrent ride
  requests and data updates from various users and robotaxis without performance degradation.
- **[NFR2] Real-time Responsiveness**: The notification system shall deliver state-change updates to
  Passengers and Fleet Operators in near real-time to guarantee an accurate representation of the
  vehicle's status.
- **[NFR3] Scalability**: The centralized software architecture must be scalable to accommodate a
  growing fleet of robotaxis and an increasing number of registered passengers, supporting the rapid
  evolution of urban mobility.

### Reliability and Consistency

- **[NFR4] Data Consistency**: The system must enforce strict database constraints to guarantee that
  vehicle availability timelines are accurately maintained, unequivocally preventing conflicting
  assignments or reservations of the same robotaxi for overlapping rides or bookings.
- **[NFR5] Robustness**: The system shall explicitly enforce valid robotaxi state transitions (e.g.,
  from available to assigned or maintenance), avoiding the reaching of invalid or inconsistent
  states.

### Usability

- **[NFR6] Ease of Use**: The ROAd interfaces, both the mobile application for Passengers and the
  web graphical user interface for Fleet Operators, will be intuitive and easy-to-use, minimizing
  the learning curve required to request rides or monitor the fleet.

### Maintainability and Extensibility

- **[NFR7] Extensibility of Allocation Logic**: The allocation logic shall be extensible, allowing
  new allocation policies to be added without modifying the core request management logic.
- **[NFR8] Separation of Concerns**: The project architecture will maintain a strict separation
  between its core management logic (user accounts, concurrent requests, state tracking) and
  external dependencies (autonomous driving, payment gateways, mapping services).

### Reliability and Consistency

*(second heading with this title in the original document)*

- **[NFR9] Stability of Auto-Switching**: The system will implement hysteresis logic to prevent
  frequent and rapid oscillations between allocation strategies (the "ping-pong effect") when
  traffic levels fluctuate around the defined thresholds. Specifically, the system will only revert
  to the Nearest Available strategy when traffic drops to the Low threshold, ensuring operational
  stability.
- **[NFR10] Priority of Human Intervention**: A manual command from the Fleet Operator must always
  take absolute priority over the automated allocation logic. The system will ensure an immediate
  and atomic transition to Manual Mode upon operator intervention, suspending all automated triggers
  to guarantee human-in-the-loop control.

## 2.6 Assumptions, Dependencies and Constraints

To clearly define the boundaries of the ROAd software architecture, several domain assumptions,
external dependencies, and system constraints are established.

### Domain Assumptions

- **[D1] Vehicle Autonomy**: It is assumed that the robotaxis are fully capable of autonomous
  driving and safe navigation within the urban environment. The core system does not handle the
  physical control or sensor data processing of the vehicles.
- **[D2] Connectivity**: It is assumed that both the robotaxis and the users (Passengers and Fleet
  Operators) maintain a reliable network connection to transmit GPS positions, state changes, and
  ride requests to the centralized software system.
- **[D3] User Behavior**: It is assumed that passengers will be present at the specified pickup
  location at the time of the robotaxi's arrival.

### Dependencies

- **External Mapping Services**: The system relies on third-party mapping providers to obtain
  geographical information, compute routes, calculate distances, and estimate travel times (ETAs).
  Crucially, the system also strictly depends on these services to retrieve real-time traffic level
  data (categorized as Low, Medium, or High). This real-time traffic data is the fundamental input
  required for the system to evaluate conditions and execute automated allocation strategy switching
  while operating in Auto Mode. Dynamic fleet rebalancing feature depends on external data sources
  or historical databases to provide the necessary information to identify expected high-demand
  zones.
- **Payment Gateways**: The processing of financial transactions and ride fares is treated as an
  external dependency and is not implemented as part of the core ROAd system.

### Constraints

- **[C1] Non-Overlapping Assignments**: The system must strictly enforce database constraints to
  manage vehicle availability timelines, absolutely preventing conflicting assignments or
  reservations where the same robotaxi is scheduled for overlapping immediate rides or advance
  bookings.
- **[C2] Scope Limitation**: The focus of the project is strictly constrained to the software
  architecture, including managing user accounts, handling concurrent requests, tracking vehicle
  state transitions, and routing logic. The actual autonomous driving mechanics and payment
  processing are explicitly excluded from the implementation.

---

# 3 Additional Models

## 3.1 Requirements-level Sequence Diagrams

The sequence diagrams presented in this section describe the main interactions between external
actors and the ROAd system at requirements level. They abstract from internal software components
and focus on the order of events needed to satisfy the main functionalities of the system.

### Immediate Ride Request

The passenger submits pickup and destination locations, while the ROAd system validates the request,
retrieves available robotaxis, applies the active allocation strategy, assigns a suitable vehicle,
and notifies the passenger about the assignment and vehicle arrival. If no suitable robotaxi is
available, the request is rejected and the passenger is notified.

#### Figure 3.1: Requirements-level sequence diagram for immediate ride request

Source: `../RASD/diagrams/sequence_diagrams/immediate_ride_request.puml`

```plantuml
actor "p:PassengerClient" as P
participant "road:ROAdSystem" as ROAD
participant "map:ExternalMapService" as MAP
participant "fleet:Fleet" as FLEET
participant "robotaxi:Robotaxi" as ROBOTAXI

P -> ROAD : submitImmediateRideRequest(pickup, destination)
ROAD -> ROAD : validateRideRequest()
ROAD -> FLEET : getAvailableRobotaxis()
FLEET --> ROAD : availableRobotaxis
ROAD -> MAP : requestETA(pickup, destination, robotaxiPoses)
MAP --> ROAD : ETAInfo

alt request accepted
    ROAD -> ROAD : applyActiveAllocationStrategy()
    ROAD -> ROAD : selectRobotaxi()
    ROAD -> ROAD : updateRideRequestStatus(ACCEPTED)
    ROAD -> ROAD : updateRobotaxiStatus(ASSIGNED)
    ROAD -> ROBOTAXI : assignRide(rideRequest)
    ROBOTAXI --> ROAD : assignConfirmed
    ROAD --> P : notifyVehicleAssigned(robotaxi, ETAInfo)
    ROAD -> ROBOTAXI : moveToPickup()
    ROBOTAXI --> ROAD : movingToPickup
    ROAD -> ROAD : updateRobotaxiStatus(ARRIVING)
    ROAD --> P : notifyVehicleArriving(ETAInfo)
else request rejected
    ROAD -> ROAD : updateRideRequestStatus(REJECTED)
    ROAD --> P : notifyRideRequestRejected()
end
```

### Advance Ride Booking

The passenger submits a pickup location, a destination, and a future date and time. The ROAd system
validates the request, checks future robotaxi availability, applies the active allocation strategy
and selects a suitable vehicle. If no conflicting assignment or reservation exists, the system
reserves the selected robotaxi for the required time interval and confirms the booking. Otherwise,
the booking is rejected. The passenger is then notified about the result.

#### Figure 3.2: Requirements-level sequence diagram for advance ride booking

Source: `../RASD/diagrams/sequence_diagrams/advance_ride_booking.puml`

```plantuml
actor "p:PassengerClient" as P
participant "road:ROAdSystem" as ROAD
participant "map:ExternalMapService" as MAP
participant "fleet:Fleet" as FLEET

P -> ROAD : submitAdvanceBooking(pickup, destination, dateTime)
ROAD -> ROAD : validateBookingRequest()
ROAD -> FLEET : getAvailableRobotaxis(dateTime)
FLEET --> ROAD : availableRobotaxis
ROAD -> MAP : estimateTravelTimes(pickup, destination, robotaxiPoses)
MAP --> ROAD : travelTimes
ROAD -> ROAD : applyActiveAllocationStrategy()
ROAD -> ROAD : selectRobotaxi()
ROAD -> ROAD : checkBookingConflicts(selectedRobotaxi, dateTime)

alt robotaxi selected and no conflicting assignment
    ROAD -> ROAD : reserveRobotaxi(selectedRobotaxi, dateTime)
    ROAD -> ROAD : createAdvanceBooking(selectedRobotaxi)
    ROAD -> ROAD : updateRideRequestStatus(ACCEPTED)
    ROAD --> P : notifyBookingConfirmed(bookingInfo)
else no feasible robotaxi or conflicting assignment
    ROAD -> ROAD : updateRideRequestStatus(REJECTED)
    ROAD --> P : notifyRideRequestRejected()
end
```

### Fleet Rebalancing

The ROAd system retrieves demand information, identifies zones where high demand is expected,
selects idle robotaxis that can be repositioned, and either suggests a rebalancing action to the
fleet operator or automatically triggers it, depending on the operational configuration. If no
high-demand imbalance is detected, the fleet distribution remains unchanged.

#### Figure 3.3: Requirements-level sequence diagram for fleet rebalancing

Source: `../RASD/diagrams/sequence_diagrams/fleet_rebalancing.puml`

```plantuml
participant "road:ROAdSystem" as ROAD
participant "demand:ExternalDemandDataService" as DEMAND
participant "fleet:Fleet" as FLEET
actor "operator:FleetOperator" as OP
participant "selectedRobotaxis:RobotaxiGroup" as TAXIS

ROAD -> DEMAND : requestDemandData()
DEMAND --> ROAD : demandData
ROAD -> ROAD : identifyHighDemandZones()
ROAD -> FLEET : getIdleRobotaxis()
FLEET --> ROAD : idleRobotaxis
ROAD -> ROAD : selectRebalancingRobotaxis()

alt manual approval required
    ROAD -> OP : suggestRebalancing(targetZone, selectedRobotaxis)
    OP --> ROAD : approveRebalancing()
    ROAD -> TAXIS : sendRebalancingInstruction(targetZone)
    TAXIS --> ROAD : rebalancingStarted
    ROAD -> ROAD : updateRebalancingStatus(TRIGGERED)
else automatic rebalancing enabled
    ROAD -> TAXIS : sendRebalancingInstruction(targetZone)
    TAXIS --> ROAD : rebalancingStarted
    ROAD -> ROAD : updateRebalancingStatus(TRIGGERED)
end
```

## 3.2 Finite State Machines

The finite state machine presented in this section describes the lifecycle of a robotaxi within the
ROAd domain. It is intended to clarify the admissible transitions between the main operational
states of a vehicle at requirements level. The model abstracts from implementation details and
focuses on the states that are relevant for allocation, ride execution, passenger notifications, and
maintenance management.

### Robotaxi State Machine

A robotaxi can be assigned to a ride request only when it is in the `AVAILABLE` state. Once
assigned, it moves through the states required to reach the passenger, execute the ride, and become
available again. If the vehicle is not suitable for service, it enters the `MAINTENANCE` state and
cannot be assigned to ride requests until maintenance is completed.

#### Figure 3.4: Requirements-level finite state machine of the Robotaxi lifecycle

Source: `../RASD/diagrams/finite_state_machines/robotaxi_state.drawio` (and `.pdf`).
The figure is a drawn image; the transitions are transcribed below.

| # | From | Event / trigger | To |
|---|---|---|---|
| 1 | `AVAILABLE` | maintenance required | `MAINTENANCE` |
| 2 | `MAINTENANCE` | maintenance completed | `AVAILABLE` |
| 3 | `AVAILABLE` | ride assigned | `ASSIGNED` |
| 4 | `ASSIGNED` | starts moving to pickup | `ARRIVING` |
| 5 | `ARRIVING` | pickup location reached | `ARRIVED` |
| 6 | `ARRIVED` | ride starts | `IN RIDE` |
| 7 | `IN RIDE` | ride completed | `AVAILABLE` |

States: `AVAILABLE`, `ASSIGNED`, `ARRIVING`, `ARRIVED`, `IN RIDE`, `MAINTENANCE`. Every transition
not listed above is not admissible at requirements level.

> **[v1.1] Rapporto con la FSM implementata.** Questa macchina resta la vista *a livello di
> requisiti* e non cambia. La macchina che il sistema realizza è quella del DD §2.6.3, Figura 2.10,
> che ha **sette** stati: aggiunge `REBALANCING` con le transizioni `AVAILABLE → REBALANCING`,
> `REBALANCING → AVAILABLE` e `REBALANCING → ASSIGNED`. Le due viste sono coerenti: un veicolo in
> riposizionamento non sta servendo un passeggero, e a livello di requisiti si legge semplicemente
> come un veicolo momentaneamente non in servizio. Lo stato aggiuntivo esiste perché R11 e G9
> richiedono di muovere i veicoli inattivi verso la domanda attesa e, se nel frattempo arriva una
> richiesta, di dirottarli su quella. **Il riferimento normativo per l'implementazione e per i test
> è la Figura 2.10 del DD, non questa.**

---

# 4 References

- ROAd: Robotaxi Optimized Allocation project proposal.
- M. Jackson and P. Zave, *The World and the Machine*, Proceedings of the 17th International
  Conference on Software Engineering, 1995.
- ISO/IEC/IEEE 29148:2018, *Systems and software engineering - Life cycle processes - Requirements
  engineering*.
- Object Management Group, *Unified Modeling Language Specification*. Available at:
  https://www.omg.org/spec/UML/
- M. Camilli, *Software Engineering for Automation - Course Slides*, Politecnico di Milano, A.Y.
  2025-2026.

---

# Appendice A — Modifiche rispetto al PDF v1.0

| # | Modifica | Sezione | Motivo |
|---|---|---|---|
| 1 | Aggiunto **[R14] Ride Cancellation** | §2.4 | L'annullamento era già un fenomeno condiviso (§1.2.2) e uno stato del dominio (`CANCELLED`), ma nessun requisito lo enunciava: restava fuori dalla tracciabilità |
| 2 | Aggiunto a **[R13]** il comportamento al rientro in Auto Mode | §2.4 | Il v1.0 diceva quando si esce dal Manual Mode, non che cosa vale subito dopo; senza la precisazione R12 resterebbe violato per un tempo arbitrario |
| 3 | Chiarito il rapporto fra la FSM del §3.2 e quella a sette stati del DD | §3.2 | Le due macchine differiscono e il documento non diceva quale valesse per l'implementazione |
| 4 **[v1.3]** | Aggiornata la nota di copertura di **[R14]**: il requisito è ora coperto per intero | §2.4 | La nota dichiarava parziale la copertura e ne indicava la causa — l'assenza di `commandRoute()`, che impediva di fermare un veicolo già in movimento. Il comando esiste da M7 e le transizioni 12 e 13 del DD §2.6.3 completano il requisito (decisione D59): la nota descriveva uno stato dei lavori, e lasciarla ferma la renderebbe falsa |

Nient'altro del RASD è cambiato: i goal G1–G10, i requisiti R1–R13, gli NFR1–NFR10, le assunzioni
D1–D3, i vincoli C1–C2, gli scenari e il modello di dominio sono quelli del PDF v1.0. Le decisioni
di realizzazione prese nella stessa occasione vivono nel DD, [Appendice A del Design
Document](./DD.md#appendice-a--registro-delle-decisioni-v11), perché riguardano il *come* e non il
*che cosa*.

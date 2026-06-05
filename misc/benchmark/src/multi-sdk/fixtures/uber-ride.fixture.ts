// core/src/benchmarks/multi-sdk/fixtures/uber-ride.fixture.ts

import type { BenchmarkFixture } from "./types";

export const uberRide: BenchmarkFixture = {
  id: "uber-ride",
  name: "Uber Active Ride",
  description: "Live map tracking + multi-commit controls + drill-down driver profile",
  complexity: "medium",
  expectedMinScore: 55,
  shellType: "fullscreen",
  screen: "mobile",

  prompt: `Build a ride tracking screen for an active Uber ride. Layout:

- Full-screen map as the primary surface.
- Place three markers on the map: driver's current position, pickup location, and destination.
- Update the driver's position in real time as position events arrive.
- Top banner showing ride status ("searching", "on the way", "arrived", "in progress") and ETA, updated when status events arrive.
- Four action buttons overlaid on the bottom half of the map:
  - Cancel Ride
  - Change Destination
  - Contact Driver
  - Add Stop
- Clicking the driver marker opens a modal with the driver's full profile (fetched on demand).

Requirements:
- All geo coordinates come from props/stream — do not hardcode locations.
- Buttons should be positioned over the map, not below it.
- Use design system CSS variables for all colors and spacing.`,

  contract: {
    intent: "Track active ride and manage in-ride actions",
    propsSpec: {
      properties: {
        ride: {
          schema: {
            type: "object",
            properties: {
              id: { type: "string" },
              status: {
                type: "string",
                enum: ["searching", "on-way", "arrived", "in-progress", "completed"],
              },
              eta: { type: "number" },
              fare: { type: "number" },
              driver: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  rating: { type: "number" },
                  lat: { type: "number" },
                  lng: { type: "number" },
                  photo: { type: "string" },
                },
              },
              pickup: {
                type: "object",
                properties: {
                  lat: { type: "number" },
                  lng: { type: "number" },
                  address: { type: "string" },
                },
              },
              destination: {
                type: "object",
                properties: {
                  lat: { type: "number" },
                  lng: { type: "number" },
                  address: { type: "string" },
                },
              },
            },
          },
          required: true,
          description: "Active ride object with driver, pickup, and destination",
          example: {
            id: "r1",
            status: "on-way",
            eta: 7,
            fare: 18.5,
            driver: { name: "Alex K.", rating: 4.9, lat: 37.7749, lng: -122.4194 },
            pickup: { lat: 37.7849, lng: -122.4094, address: "1 Market St" },
            destination: { lat: 37.7649, lng: -122.4294, address: "Mission Bay" },
          },
        },
      },
    },
    actionSpec: {
      cancel: {
        label: "Cancel Ride",
        description: "Cancel the active ride",
        nextStep: "uber_cancel_ride",
        example: { rideId: "r1" },
      },
      changeDest: {
        label: "Change Destination",
        description: "Update ride destination mid-trip",
        nextStep: "uber_update_destination",
        example: { rideId: "r1", lat: 37.77, lng: -122.41 },
      },
      contactDriver: {
        label: "Contact Driver",
        description: "Send message to driver",
        nextStep: "uber_message_driver",
        example: { rideId: "r1", message: "At front door" },
      },
      addStop: {
        label: "Add Stop",
        description: "Insert a waypoint before destination",
        nextStep: "uber_add_stop",
        example: { rideId: "r1", lat: 37.78, lng: -122.42 },
      },
    },
    streamSpec: {
      driverPosition: {
        description: "Driver location updates while en route",
        schema: {
          type: "object",
          properties: {
            rideId: { type: "string" },
            lat: { type: "number" },
            lng: { type: "number" },
            heading: { type: "number" },
          },
        },
        example: { rideId: "r1", lat: 37.7772, lng: -122.4172, heading: 89 },
      },
      rideStatus: {
        description: "Ride status changes",
        schema: {
          type: "object",
          properties: {
            rideId: { type: "string" },
            status: {
              type: "string",
              enum: ["searching", "on-way", "arrived", "in-progress", "completed"],
            },
            eta: { type: "number" },
          },
        },
        example: { rideId: "r1", status: "arrived", eta: 0 },
      },
    },
    agentCapabilities: {
      tools: {
        getDriverProfile: {
          toolInfo: {
            description: "Fetch driver full profile for the drill-down modal",
            inputSchema: {
              type: "object",
              properties: { driverId: { type: "string" } },
            },
            outputSchema: {
              type: "object",
              properties: {
                name: { type: "string" },
                rating: { type: "number" },
                carModel: { type: "string" },
                plateNumber: { type: "string" },
                totalTrips: { type: "number" },
              },
            },
          },
          example: {
            input: { driverId: "d1" },
            output: {
              name: "Alex K.",
              rating: 4.9,
              carModel: "Toyota Prius",
              plateNumber: "ABC123",
              totalTrips: 2134,
            },
          },
        },
      },
    },
  },

  props: {
    ride: {
      id: "r1",
      status: "on-way",
      eta: 7,
      fare: 18.5,
      driver: {
        name: "Alex K.",
        rating: 4.9,
        lat: 37.7749,
        lng: -122.4194,
        photo: "",
      },
      pickup: { lat: 37.7849, lng: -122.4094, address: "1 Market St" },
      destination: { lat: 37.7649, lng: -122.4294, address: "Mission Bay" },
    },
  },

  expected: {
    vector: {
      render: "spatial",
      state: "merge",
      writes: "multi-commit",
      writeTrigger: "click",
      // Both streams target the ride singleton (rideId-keyed). Entity-targeted
      // streams are 'merge' even when one carries an enum status field —
      // the enum updates a field IN the entity, not an independent variable.
      realtime: "merge",
      fetch: "drill-down",
      layout: "overlay",
    tooling: "wired",
    },
    // High: render=spatial AND realtime !== 'none' auto-promotes.
    riskTier: "high",
    provenance: {
      render: "contract",
      state: "contract",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "prompt",
    tooling: "contract",
    },
  },

  whyNotReducible: `
    - render=spatial: no existing fixture (kanban/chat/stock-ticker are list/grid)
    - writes=multi-commit: 4 independent actions with distinct payload shapes, none
      entity-id-keyed; no prior fixture covers this (kanban is per-item; product-page is commit)
    - realtime=mixed (merge+status combo): stock-ticker's marketStatus is status-shaped
      but the fixture treats it as merge; Uber explicitly separates ride-entity merge
      from singular ride-status replacement
    - fetch=drill-down: no existing fixture uses agentCapabilities tools
    - layout=overlay: no existing fixture has non-single, non-multi-step layouts
  `.trim(),

  evalGoals: [
    "Map primitive is imported and used (not a <Card> fallback)",
    "Driver marker reads from live useState-backed state, not props.ride.driver directly",
    "Each of four action buttons is attached to a distinct useAction invocation",
    "Action payloads match the ActionEntry.example shapes exactly",
    "Ride status banner reads from live state updated by useStream('rideStatus')",
    "Driver position stream updates via useStream('driverPosition') merging by rideId",
    "Driver marker click triggers wiredTool getDriverProfile and opens a modal",
    "Action buttons are positioned over the map (absolute or fixed, not inline below)",
    "No hardcoded lat/lng values in source",
  ],
};

export default uberRide;

// core/src/benchmarks/multi-sdk/fixtures/place-search.fixture.ts

import type { BenchmarkFixture } from "./types";

export const placeSearch: BenchmarkFixture = {
  id: "place-search",
  name: "Place Search",
  description: "Map + sidebar list with search, click marker to drill down",
  complexity: "medium",
  expectedMinScore: 55,
  shellType: "fullscreen",
  screen: "desktop",

  prompt: `Build a place search screen with a map and a results list.

Layout:
- Top: search input. Typing fires a search that updates both panes.
- Left sidebar: scrollable list of results (name, category, rating, distance).
- Right main area: full map with a marker for each result at its coordinates.
- Clicking either a sidebar row or a map marker selects that place and opens a detail panel at the bottom of the map showing address, hours, phone.

Requirements:
- Initial results come from props. Subsequent searches call the search tool.
- Sidebar and map are always in sync — same result set, same selection.
- Use design system CSS variables.`,

  contract: {
    intent: "Find places near a location with search + map + detail drill-down",
    propsSpec: {
      properties: {
        places: {
          schema: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                name: { type: "string" },
                category: { type: "string" },
                rating: { type: "number" },
                lat: { type: "number" },
                lng: { type: "number" },
                address: { type: "string" },
                hours: { type: "string" },
                phone: { type: "string" },
                distanceMeters: { type: "number" },
              },
            },
          },
          required: true,
          description: "Place search results",
        },
        center: {
          schema: {
            type: "object",
            properties: {
              lat: { type: "number" },
              lng: { type: "number" },
            },
          },
          required: true,
          description: "Map center (user's location or search origin)",
        },
      },
    },
    agentCapabilities: {
      tools: {
        searchPlaces: {
          description: "Run a new place search with the given query",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string" },
              category: { type: "string" },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              places: { type: "array", items: { type: "object" } },
            },
          },
          example: {
            input: { query: "pizza near me" },
            output: { places: [] },
          },
        },
      },
    },
  },

  props: {
    center: { lat: 37.7749, lng: -122.4194 },
    places: [
      { id: "p1", name: "Tony's Pizza", category: "Italian", rating: 4.5, lat: 37.7779, lng: -122.4164, address: "1 Market St", hours: "11am-10pm", phone: "555-0100", distanceMeters: 450 },
      { id: "p2", name: "Giordano's", category: "Italian", rating: 4.2, lat: 37.7719, lng: -122.4204, address: "200 Main", hours: "11am-11pm", phone: "555-0101", distanceMeters: 620 },
      { id: "p3", name: "Pizza My Heart", category: "Italian", rating: 4.0, lat: 37.7769, lng: -122.4224, address: "300 Mission", hours: "10am-midnight", phone: "555-0102", distanceMeters: 800 },
    ],
  },

  expected: {
    vector: {
      render: "spatial",
      state: "ui-affordance",
      writes: "none",
      writeTrigger: "click",
      realtime: "none",
      fetch: "search",
      layout: "master-detail",
    tooling: "wired",
    },
    riskTier: "medium",
    provenance: {
      render: "contract",
      state: "prompt",
      writes: "contract",
      writeTrigger: "default",
      realtime: "contract",
      fetch: "contract",
      layout: "prompt",
    tooling: "contract",
    },
  },

  whyNotReducible: `
    - fetch=search: first fixture exercising query-shaped wiredTool. uber-ride uses
      drill-down (id), activity-feed will use pagination (cursor). search is distinct.
    - render=spatial + state=ui-affordance + writes=none: passive spatial display
      with local UI state for search query and selection. uber-ride is spatial
      with merge state; this is spatial with purely client state.
    - layout=master-detail paired with spatial render: tasks master-detail
      inference that cares about whether the "master" is a list, and whether the
      "detail" appears inline or in a panel. Different from plan-my-week's two-pane
      split between two entity lists.
  `.trim(),

  evalGoals: [
    "Map primitive imported and used with markers per place",
    "Marker positions read from places.lat/lng, not hardcoded",
    "Search input triggers searchPlaces wiredTool, not client-side filter",
    "useState for query + selected place (ui-affordance)",
    "Selected place reflects on both sidebar and map",
    "Detail panel renders selected place's address/hours/phone",
    "Sidebar and map share the same places source of truth",
    "No merge state — results replace entirely on new search",
  ],
};

export default placeSearch;

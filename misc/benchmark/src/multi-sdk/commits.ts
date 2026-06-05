// core/src/benchmarks/multi-sdk/commits.ts
//
// Benchmark test cases — each entry models one generation invocation.
// "Commit" here = the generation commit unit (a single benchmark run),
// NOT the retired ggui_commit tool.

import type { BenchmarkCommit } from './types';

/**
 * Standard UI Generation Benchmark Suite
 *
 * 10 commits designed to test different generation capabilities:
 *
 * | #  | Commit             | Mode      | Complexity | Tests                                        |
 * |----|--------------------|-----------|------------|----------------------------------------------|
 * | 1  | Weather Card       | display   | simple     | Data display, props, design tokens, responsive|
 * | 2  | Multi-Step Survey  | collect   | medium     | Forms, validation, state machine, callbacks  |
 * | 3  | Kanban Board       | collect   | medium     | Lists, drag-like interaction, state mgmt     |
 * | 4  | Periodic Table     | display   | complex    | CSS grid, category coloring, search, detail panel |
 * | 5  | Product Page       | collect   | complex    | Tabs, quantity selector, image, cart actions  |
 * | 6  | Chat Interface     | converse  | medium     | Message list, input area, send callback      |
 * | 7  | Stock Ticker       | broadcast | simple     | Data grid, color-coded changes, responsive   |
 * | 8  | Onboarding Wizard  | flow      | medium     | Multi-step, validation, step navigation      |
 * | 9  | Leaflet Map        | display   | medium     | Component gadget: registered `<LeafletMap>`  |
 * | 10 | Revenue Chart      | display   | medium     | Mixed gadget: `<Chart>` + `useChartTheme`    |
 *
 * Each commit is parameterized via props (no hardcoded data) and includes
 * sample props for rendering realistic previews in the benchmarks app.
 */
// ── Reference component-gadget `.d.ts` (GG.8.7) ─────────────────────
// Hand-maintained public type surface of the two reference component
// gadget packages, threaded into the coding agent's typecheck via
// `BenchmarkCommit.gadgetTypes`. Kept inline (like the inline gadget
// descriptors below) so a bench commit stays self-contained — no
// build-output cross-dependency on the sample package. Mirror
// `packages/samples/gadgets/{leaflet,chart}/src/index.tsx`.

const LEAFLET_GADGET_DTS = `
export interface LeafletMarker {
  readonly id?: string;
  readonly lat: number;
  readonly lng: number;
  readonly label?: string;
}
export interface LeafletMapProps {
  readonly center: readonly [number, number];
  readonly zoom: number;
  readonly markers?: readonly LeafletMarker[];
  readonly tileUrl?: string;
  readonly attribution?: string;
  readonly height?: number;
  readonly className?: string;
}
export declare function LeafletMap(props: LeafletMapProps): JSX.Element;
`;

const CHART_GADGET_DTS = `
export interface ChartDatum {
  readonly label: string;
  readonly value: number;
}
export interface ChartProps {
  readonly data: readonly ChartDatum[];
  readonly height?: number;
  readonly barColor?: string;
  readonly emptyMessage?: string;
}
export declare function Chart(props: ChartProps): JSX.Element;
export interface ChartTheme {
  readonly palette: readonly string[];
  readonly axisColor: string;
  readonly labelColor: string;
  readonly gridColor: string;
}
export declare function useChartTheme(): ChartTheme;
`;

export const BENCHMARK_COMMITS: BenchmarkCommit[] = [
  // ── 1. SIMPLE: Data Display ───────────────────────────────────────
  {
    id: 'weather-card',
    name: 'Weather Card',
    description: 'Data display with props, design tokens, and responsive layout',
    complexity: 'simple',
    expectedMinScore: 70,
    shellType: 'chat',
    screen: 'universal',
    prompt: `Build a weather card component. It should display:
- Current temperature (large, prominent)
- Weather condition with an appropriate icon/emoji (sunny, cloudy, rainy, etc.)
- Humidity percentage
- Wind speed
- A 5-day forecast strip at the bottom showing day name, icon, and high/low temps

All data must come from props — never hardcode weather data. Use CSS variables from the design system for all colors and spacing.`,
    contract: {
      propsSpec: {
        properties: {
          city: { schema: { type: 'string' }, required: true, description: 'City name', example: 'Tokyo' },
          temperature: { schema: { type: 'number' }, required: true, description: 'Current temperature', example: 28 },
          condition: { schema: { type: 'string' }, required: true, description: 'Weather condition (Sunny, Cloudy, Rainy, etc.)', example: 'Sunny' },
          humidity: { schema: { type: 'number' }, required: true, description: 'Humidity percentage', example: 45 },
          windSpeed: { schema: { type: 'number' }, required: true, description: 'Wind speed', example: 8 },
          unit: { schema: { type: 'string' }, description: 'Temperature unit (C or F)', example: 'C' },
          forecast: { schema: { type: 'array', items: { type: 'object', properties: { day: { type: 'string' }, icon: { type: 'string' }, high: { type: 'number' }, low: { type: 'number' } } } }, required: true, description: '5-day forecast array', example: [{ day: 'Mon', icon: '☀️', high: 30, low: 22 }, { day: 'Tue', icon: '⛅', high: 27, low: 20 }] },
        },
      },
    },
    props: {
      city: 'Tokyo',
      temperature: 28,
      condition: 'Sunny',
      humidity: 45,
      windSpeed: 8,
      unit: 'C',
      forecast: [
        { day: 'Mon', icon: '☀️', high: 30, low: 22 },
        { day: 'Tue', icon: '⛅', high: 27, low: 20 },
        { day: 'Wed', icon: '🌧️', high: 23, low: 18 },
        { day: 'Thu', icon: '⛈️', high: 21, low: 17 },
        { day: 'Fri', icon: '☀️', high: 29, low: 21 },
      ],
    },
  },

  // ── 2. MEDIUM: Forms & Validation ─────────────────────────────────
  {
    id: 'survey-form',
    name: 'Multi-Step Survey Form',
    description: 'Multi-step form with validation, progress tracking, and review',
    complexity: 'medium',
    expectedMinScore: 65,
    shellType: 'fullscreen',
    screen: 'desktop',
    prompt: `Build a multi-step survey form with 4 steps:
- Step 1: Text inputs for name (required) and email (required, must be valid email format) with inline validation
- Step 2: Radio button group for satisfaction rating (1-5 scale with labels from props)
- Step 3: Checkbox group for feature interests (options from props)
- Step 4: Textarea for open-ended comments (optional, with character counter, max 500 chars)

Requirements:
- Progress bar at the top showing current step (e.g., "Step 2 of 4")
- Back/Next navigation buttons (Next disabled until required fields valid)
- Final review step showing all answers before submission
- Call props.onSubmit with all collected answers as a structured object
- All option labels and feature lists must come from props
- Use design system CSS variables for all styling`,
    contract: {
      propsSpec: {
        properties: {
          featureOptions: { schema: { type: 'array', items: { type: 'string' } }, required: true, description: 'Available feature options for the checkbox step', example: ['Dashboard Analytics', 'Team Collaboration', 'API Integration', 'Custom Workflows', 'Mobile App', 'AI Assistance'] },
          satisfactionLabels: { schema: { type: 'array', items: { type: 'string' } }, required: true, description: 'Labels for satisfaction rating (e.g., Very Unsatisfied to Very Satisfied)', example: ['Very Unsatisfied', 'Unsatisfied', 'Neutral', 'Satisfied', 'Very Satisfied'] },
        },
      },
      actionSpec: {
        submit: { label: 'Submit Survey', description: 'Called with all collected answers as a structured object', nextStep: 'survey_submit_response', example: { name: 'John', email: 'john@example.com', satisfaction: 4, features: ['API Integration', 'Mobile App'], comments: 'Great product!' } },
      },
    },
    props: {
      featureOptions: [
        'Dashboard Analytics',
        'Team Collaboration',
        'API Integration',
        'Custom Workflows',
        'Mobile App',
        'AI Assistance',
      ],
      satisfactionLabels: [
        'Very Unsatisfied',
        'Unsatisfied',
        'Neutral',
        'Satisfied',
        'Very Satisfied',
      ],
    },
  },

  // ── 3. MEDIUM: Interactive Lists & State ──────────────────────────
  {
    id: 'kanban-board',
    name: 'Kanban Task Board',
    description: 'Column-based task board with task cards and state management',
    complexity: 'medium',
    expectedMinScore: 60,
    shellType: 'fullscreen',
    screen: 'desktop',
    prompt: `Build a Kanban-style task board with 3 columns: To Do, In Progress, Done.

Each column:
- Has a header with column name and task count
- Contains a vertical list of task cards
- Has an "Add Task" button at the bottom

Each task card displays:
- Task title (editable on double-click or via edit button)
- Priority badge (low/medium/high with color coding from design tokens)
- Assignee avatar or initials
- Due date (if set)
- A move button or dropdown to move the task to another column

Requirements:
- Tasks can be moved between columns via move controls (buttons or select dropdown)
- New tasks start in "To Do" column
- "Add Task" shows an inline form with title input and priority selector
- Track total tasks and completed count in a summary bar at the top
- Initial tasks come from props; real-time updates from other team members arrive via stream
- Call the taskUpdate action when a task is moved, edited, or created
- Use design system CSS variables for all colors, spacing, and shadows`,
    contract: {
      propsSpec: {
        properties: {
          tasks: {
            schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, assignee: { type: 'string' }, column: { type: 'string' }, dueDate: { type: 'string' } } } },
            required: true,
            description: 'Array of tasks with id, title, priority (low/medium/high), assignee initials, column ID, and optional dueDate',
            example: [
              { id: '1', title: 'Design landing page', priority: 'high', assignee: 'AS', column: 'todo', dueDate: '2026-03-20' },
              { id: '2', title: 'Implement auth flow', priority: 'high', assignee: 'BK', column: 'in-progress', dueDate: '2026-03-18' },
            ],
          },
          columns: {
            schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } } },
            required: true,
            description: 'Column definitions: [{id: "todo", name: "To Do"}, {id: "in-progress", name: "In Progress"}, {id: "done", name: "Done"}]',
            example: [{ id: 'todo', name: 'To Do' }, { id: 'in-progress', name: 'In Progress' }, { id: 'done', name: 'Done' }],
          },
        },
      },
      actionSpec: {
        taskUpdate: {
          label: 'Task Updated',
          description: 'Called when a task is moved, edited, or created. Payload: { action, taskId, data }',
          nextStep: 'todoist_update_task',
          schema: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['create', 'move', 'edit', 'delete'] },
              taskId: { type: 'string' },
              data: {
                type: 'object',
                properties: {
                  column: { type: 'string' },
                  title: { type: 'string' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high'] },
                  assignee: { type: 'string' },
                  dueDate: { type: 'string' },
                },
              },
            },
          },
          example: { action: 'move', taskId: '1', data: { column: 'in-progress' } },
        },
      },
      streamSpec: {
        taskChanged: {
          description: 'A task was moved, edited, or created by another user — update it in the board',
          schema: { type: 'object', properties: { action: { type: 'string', enum: ['create', 'move', 'edit', 'delete'] }, task: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' }, priority: { type: 'string', enum: ['low', 'medium', 'high'] }, assignee: { type: 'string' }, column: { type: 'string' }, dueDate: { type: 'string' } } } } },
          example: { action: 'move', task: { id: '2', title: 'Implement auth flow', priority: 'high', assignee: 'BK', column: 'done' } },
        },
      },
    },
    props: {
      tasks: [
        { id: '1', title: 'Design landing page', priority: 'high', assignee: 'AS', column: 'todo', dueDate: '2026-03-20' },
        { id: '2', title: 'Implement auth flow', priority: 'high', assignee: 'BK', column: 'in-progress', dueDate: '2026-03-18' },
        { id: '3', title: 'Write API docs', priority: 'medium', assignee: 'CL', column: 'todo' },
        { id: '4', title: 'Fix navigation bug', priority: 'low', assignee: 'AS', column: 'done' },
        { id: '5', title: 'Add dark mode', priority: 'medium', assignee: 'DM', column: 'in-progress' },
        { id: '6', title: 'Deploy staging', priority: 'high', assignee: 'BK', column: 'done', dueDate: '2026-03-15' },
      ],
      columns: [
        { id: 'todo', name: 'To Do' },
        { id: 'in-progress', name: 'In Progress' },
        { id: 'done', name: 'Done' },
      ],
    },
  },

  // ── 4. COMPLEX: Periodic Table Grid ─────────────────────────────
  {
    id: 'periodic-table',
    name: 'Interactive Periodic Table',
    description: 'CSS Grid periodic table with category coloring, search, and detail panel',
    complexity: 'complex',
    expectedMinScore: 55,
    shellType: 'fullscreen',
    screen: 'desktop',
    prompt: `Build an interactive periodic table of elements.

Layout:
- CSS Grid: 18 columns. Place each element using gridRow and gridColumn from its data.
- Each cell: symbol (large, centered), atomic number (small, top-left)
- Color-code by category using design tokens (e.g., noble-gas → one color, halogen → another)
- Search input at top — filters by name or symbol (case-insensitive)
- Click an element → detail panel below grid shows: name, symbol, atomicNumber, atomicWeight, category
- Legend showing each category with its color

All element data comes from props.elements. Use design system CSS variables.`,
    contract: {
      propsSpec: {
        properties: {
          elements: {
            schema: { type: 'array', items: { type: 'object', properties: { atomicNumber: { type: 'number' }, symbol: { type: 'string' }, name: { type: 'string' }, atomicWeight: { type: 'number' }, category: { type: 'string' }, row: { type: 'number' }, col: { type: 'number' } } } },
            required: true,
            description: 'Full periodic table element data',
            example: [
              { atomicNumber: 1, symbol: 'H', name: 'Hydrogen', atomicWeight: 1.008, category: 'nonmetal', row: 1, col: 1 },
              { atomicNumber: 2, symbol: 'He', name: 'Helium', atomicWeight: 4.003, category: 'noble-gas', row: 1, col: 18 },
            ],
          },
        },
      },
    },
    props: {
      elements: [
        // Row 1
        { atomicNumber: 1, symbol: 'H', name: 'Hydrogen', atomicWeight: 1.008, category: 'nonmetal', row: 1, col: 1 },
        { atomicNumber: 2, symbol: 'He', name: 'Helium', atomicWeight: 4.003, category: 'noble-gas', row: 1, col: 18 },
        // Row 2
        { atomicNumber: 3, symbol: 'Li', name: 'Lithium', atomicWeight: 6.941, category: 'alkali-metal', row: 2, col: 1 },
        { atomicNumber: 4, symbol: 'Be', name: 'Beryllium', atomicWeight: 9.012, category: 'alkaline-earth', row: 2, col: 2 },
        { atomicNumber: 5, symbol: 'B', name: 'Boron', atomicWeight: 10.81, category: 'metalloid', row: 2, col: 13 },
        { atomicNumber: 6, symbol: 'C', name: 'Carbon', atomicWeight: 12.01, category: 'nonmetal', row: 2, col: 14 },
        { atomicNumber: 7, symbol: 'N', name: 'Nitrogen', atomicWeight: 14.01, category: 'nonmetal', row: 2, col: 15 },
        { atomicNumber: 8, symbol: 'O', name: 'Oxygen', atomicWeight: 16.00, category: 'nonmetal', row: 2, col: 16 },
        { atomicNumber: 9, symbol: 'F', name: 'Fluorine', atomicWeight: 19.00, category: 'halogen', row: 2, col: 17 },
        { atomicNumber: 10, symbol: 'Ne', name: 'Neon', atomicWeight: 20.18, category: 'noble-gas', row: 2, col: 18 },
        // Row 3
        { atomicNumber: 11, symbol: 'Na', name: 'Sodium', atomicWeight: 22.99, category: 'alkali-metal', row: 3, col: 1 },
        { atomicNumber: 12, symbol: 'Mg', name: 'Magnesium', atomicWeight: 24.31, category: 'alkaline-earth', row: 3, col: 2 },
        { atomicNumber: 13, symbol: 'Al', name: 'Aluminium', atomicWeight: 26.98, category: 'post-transition-metal', row: 3, col: 13 },
        { atomicNumber: 14, symbol: 'Si', name: 'Silicon', atomicWeight: 28.09, category: 'metalloid', row: 3, col: 14 },
        { atomicNumber: 15, symbol: 'P', name: 'Phosphorus', atomicWeight: 30.97, category: 'nonmetal', row: 3, col: 15 },
        { atomicNumber: 16, symbol: 'S', name: 'Sulfur', atomicWeight: 32.07, category: 'nonmetal', row: 3, col: 16 },
        { atomicNumber: 17, symbol: 'Cl', name: 'Chlorine', atomicWeight: 35.45, category: 'halogen', row: 3, col: 17 },
        { atomicNumber: 18, symbol: 'Ar', name: 'Argon', atomicWeight: 39.95, category: 'noble-gas', row: 3, col: 18 },
        // Row 4
        { atomicNumber: 19, symbol: 'K', name: 'Potassium', atomicWeight: 39.10, category: 'alkali-metal', row: 4, col: 1 },
        { atomicNumber: 20, symbol: 'Ca', name: 'Calcium', atomicWeight: 40.08, category: 'alkaline-earth', row: 4, col: 2 },
        { atomicNumber: 21, symbol: 'Sc', name: 'Scandium', atomicWeight: 44.96, category: 'transition-metal', row: 4, col: 3 },
        { atomicNumber: 22, symbol: 'Ti', name: 'Titanium', atomicWeight: 47.87, category: 'transition-metal', row: 4, col: 4 },
        { atomicNumber: 23, symbol: 'V', name: 'Vanadium', atomicWeight: 50.94, category: 'transition-metal', row: 4, col: 5 },
        { atomicNumber: 24, symbol: 'Cr', name: 'Chromium', atomicWeight: 52.00, category: 'transition-metal', row: 4, col: 6 },
        { atomicNumber: 25, symbol: 'Mn', name: 'Manganese', atomicWeight: 54.94, category: 'transition-metal', row: 4, col: 7 },
        { atomicNumber: 26, symbol: 'Fe', name: 'Iron', atomicWeight: 55.85, category: 'transition-metal', row: 4, col: 8 },
        { atomicNumber: 27, symbol: 'Co', name: 'Cobalt', atomicWeight: 58.93, category: 'transition-metal', row: 4, col: 9 },
        { atomicNumber: 28, symbol: 'Ni', name: 'Nickel', atomicWeight: 58.69, category: 'transition-metal', row: 4, col: 10 },
        { atomicNumber: 29, symbol: 'Cu', name: 'Copper', atomicWeight: 63.55, category: 'transition-metal', row: 4, col: 11 },
        { atomicNumber: 30, symbol: 'Zn', name: 'Zinc', atomicWeight: 65.38, category: 'transition-metal', row: 4, col: 12 },
        { atomicNumber: 31, symbol: 'Ga', name: 'Gallium', atomicWeight: 69.72, category: 'post-transition-metal', row: 4, col: 13 },
        { atomicNumber: 32, symbol: 'Ge', name: 'Germanium', atomicWeight: 72.63, category: 'metalloid', row: 4, col: 14 },
        { atomicNumber: 33, symbol: 'As', name: 'Arsenic', atomicWeight: 74.92, category: 'metalloid', row: 4, col: 15 },
        { atomicNumber: 34, symbol: 'Se', name: 'Selenium', atomicWeight: 78.97, category: 'nonmetal', row: 4, col: 16 },
        { atomicNumber: 35, symbol: 'Br', name: 'Bromine', atomicWeight: 79.90, category: 'halogen', row: 4, col: 17 },
        { atomicNumber: 36, symbol: 'Kr', name: 'Krypton', atomicWeight: 83.80, category: 'noble-gas', row: 4, col: 18 },
        // Row 5
        { atomicNumber: 37, symbol: 'Rb', name: 'Rubidium', atomicWeight: 85.47, category: 'alkali-metal', row: 5, col: 1 },
        { atomicNumber: 38, symbol: 'Sr', name: 'Strontium', atomicWeight: 87.62, category: 'alkaline-earth', row: 5, col: 2 },
        { atomicNumber: 39, symbol: 'Y', name: 'Yttrium', atomicWeight: 88.91, category: 'transition-metal', row: 5, col: 3 },
        { atomicNumber: 40, symbol: 'Zr', name: 'Zirconium', atomicWeight: 91.22, category: 'transition-metal', row: 5, col: 4 },
        { atomicNumber: 41, symbol: 'Nb', name: 'Niobium', atomicWeight: 92.91, category: 'transition-metal', row: 5, col: 5 },
        { atomicNumber: 42, symbol: 'Mo', name: 'Molybdenum', atomicWeight: 95.95, category: 'transition-metal', row: 5, col: 6 },
        { atomicNumber: 43, symbol: 'Tc', name: 'Technetium', atomicWeight: 98, category: 'transition-metal', row: 5, col: 7 },
        { atomicNumber: 44, symbol: 'Ru', name: 'Ruthenium', atomicWeight: 101.07, category: 'transition-metal', row: 5, col: 8 },
        { atomicNumber: 45, symbol: 'Rh', name: 'Rhodium', atomicWeight: 102.91, category: 'transition-metal', row: 5, col: 9 },
        { atomicNumber: 46, symbol: 'Pd', name: 'Palladium', atomicWeight: 106.42, category: 'transition-metal', row: 5, col: 10 },
        { atomicNumber: 47, symbol: 'Ag', name: 'Silver', atomicWeight: 107.87, category: 'transition-metal', row: 5, col: 11 },
        { atomicNumber: 48, symbol: 'Cd', name: 'Cadmium', atomicWeight: 112.41, category: 'transition-metal', row: 5, col: 12 },
        { atomicNumber: 49, symbol: 'In', name: 'Indium', atomicWeight: 114.82, category: 'post-transition-metal', row: 5, col: 13 },
        { atomicNumber: 50, symbol: 'Sn', name: 'Tin', atomicWeight: 118.71, category: 'post-transition-metal', row: 5, col: 14 },
        { atomicNumber: 51, symbol: 'Sb', name: 'Antimony', atomicWeight: 121.76, category: 'metalloid', row: 5, col: 15 },
        { atomicNumber: 52, symbol: 'Te', name: 'Tellurium', atomicWeight: 127.60, category: 'metalloid', row: 5, col: 16 },
        { atomicNumber: 53, symbol: 'I', name: 'Iodine', atomicWeight: 126.90, category: 'halogen', row: 5, col: 17 },
        { atomicNumber: 54, symbol: 'Xe', name: 'Xenon', atomicWeight: 131.29, category: 'noble-gas', row: 5, col: 18 },
        // Row 6
        { atomicNumber: 55, symbol: 'Cs', name: 'Cesium', atomicWeight: 132.91, category: 'alkali-metal', row: 6, col: 1 },
        { atomicNumber: 56, symbol: 'Ba', name: 'Barium', atomicWeight: 137.33, category: 'alkaline-earth', row: 6, col: 2 },
        { atomicNumber: 72, symbol: 'Hf', name: 'Hafnium', atomicWeight: 178.49, category: 'transition-metal', row: 6, col: 4 },
        { atomicNumber: 73, symbol: 'Ta', name: 'Tantalum', atomicWeight: 180.95, category: 'transition-metal', row: 6, col: 5 },
        { atomicNumber: 74, symbol: 'W', name: 'Tungsten', atomicWeight: 183.84, category: 'transition-metal', row: 6, col: 6 },
        { atomicNumber: 75, symbol: 'Re', name: 'Rhenium', atomicWeight: 186.21, category: 'transition-metal', row: 6, col: 7 },
        { atomicNumber: 76, symbol: 'Os', name: 'Osmium', atomicWeight: 190.23, category: 'transition-metal', row: 6, col: 8 },
        { atomicNumber: 77, symbol: 'Ir', name: 'Iridium', atomicWeight: 192.22, category: 'transition-metal', row: 6, col: 9 },
        { atomicNumber: 78, symbol: 'Pt', name: 'Platinum', atomicWeight: 195.08, category: 'transition-metal', row: 6, col: 10 },
        { atomicNumber: 79, symbol: 'Au', name: 'Gold', atomicWeight: 196.97, category: 'transition-metal', row: 6, col: 11 },
        { atomicNumber: 80, symbol: 'Hg', name: 'Mercury', atomicWeight: 200.59, category: 'transition-metal', row: 6, col: 12 },
        { atomicNumber: 81, symbol: 'Tl', name: 'Thallium', atomicWeight: 204.38, category: 'post-transition-metal', row: 6, col: 13 },
        { atomicNumber: 82, symbol: 'Pb', name: 'Lead', atomicWeight: 207.2, category: 'post-transition-metal', row: 6, col: 14 },
        { atomicNumber: 83, symbol: 'Bi', name: 'Bismuth', atomicWeight: 208.98, category: 'post-transition-metal', row: 6, col: 15 },
        { atomicNumber: 84, symbol: 'Po', name: 'Polonium', atomicWeight: 209, category: 'post-transition-metal', row: 6, col: 16 },
        { atomicNumber: 85, symbol: 'At', name: 'Astatine', atomicWeight: 210, category: 'halogen', row: 6, col: 17 },
        { atomicNumber: 86, symbol: 'Rn', name: 'Radon', atomicWeight: 222, category: 'noble-gas', row: 6, col: 18 },
        // Row 7
        { atomicNumber: 87, symbol: 'Fr', name: 'Francium', atomicWeight: 223, category: 'alkali-metal', row: 7, col: 1 },
        { atomicNumber: 88, symbol: 'Ra', name: 'Radium', atomicWeight: 226, category: 'alkaline-earth', row: 7, col: 2 },
        { atomicNumber: 104, symbol: 'Rf', name: 'Rutherfordium', atomicWeight: 267, category: 'transition-metal', row: 7, col: 4 },
        { atomicNumber: 105, symbol: 'Db', name: 'Dubnium', atomicWeight: 268, category: 'transition-metal', row: 7, col: 5 },
        { atomicNumber: 106, symbol: 'Sg', name: 'Seaborgium', atomicWeight: 269, category: 'transition-metal', row: 7, col: 6 },
        { atomicNumber: 107, symbol: 'Bh', name: 'Bohrium', atomicWeight: 270, category: 'transition-metal', row: 7, col: 7 },
        { atomicNumber: 108, symbol: 'Hs', name: 'Hassium', atomicWeight: 277, category: 'transition-metal', row: 7, col: 8 },
        { atomicNumber: 109, symbol: 'Mt', name: 'Meitnerium', atomicWeight: 278, category: 'transition-metal', row: 7, col: 9 },
        { atomicNumber: 110, symbol: 'Ds', name: 'Darmstadtium', atomicWeight: 281, category: 'transition-metal', row: 7, col: 10 },
        { atomicNumber: 111, symbol: 'Rg', name: 'Roentgenium', atomicWeight: 282, category: 'transition-metal', row: 7, col: 11 },
        { atomicNumber: 112, symbol: 'Cn', name: 'Copernicium', atomicWeight: 285, category: 'transition-metal', row: 7, col: 12 },
        { atomicNumber: 113, symbol: 'Nh', name: 'Nihonium', atomicWeight: 286, category: 'post-transition-metal', row: 7, col: 13 },
        { atomicNumber: 114, symbol: 'Fl', name: 'Flerovium', atomicWeight: 289, category: 'post-transition-metal', row: 7, col: 14 },
        { atomicNumber: 115, symbol: 'Mc', name: 'Moscovium', atomicWeight: 290, category: 'post-transition-metal', row: 7, col: 15 },
        { atomicNumber: 116, symbol: 'Lv', name: 'Livermorium', atomicWeight: 293, category: 'post-transition-metal', row: 7, col: 16 },
        { atomicNumber: 117, symbol: 'Ts', name: 'Tennessine', atomicWeight: 294, category: 'halogen', row: 7, col: 17 },
        { atomicNumber: 118, symbol: 'Og', name: 'Oganesson', atomicWeight: 294, category: 'noble-gas', row: 7, col: 18 },
        // Lanthanides (row 8)
        { atomicNumber: 57, symbol: 'La', name: 'Lanthanum', atomicWeight: 138.91, category: 'lanthanide', row: 8, col: 3 },
        { atomicNumber: 58, symbol: 'Ce', name: 'Cerium', atomicWeight: 140.12, category: 'lanthanide', row: 8, col: 4 },
        { atomicNumber: 59, symbol: 'Pr', name: 'Praseodymium', atomicWeight: 140.91, category: 'lanthanide', row: 8, col: 5 },
        { atomicNumber: 60, symbol: 'Nd', name: 'Neodymium', atomicWeight: 144.24, category: 'lanthanide', row: 8, col: 6 },
        { atomicNumber: 61, symbol: 'Pm', name: 'Promethium', atomicWeight: 145, category: 'lanthanide', row: 8, col: 7 },
        { atomicNumber: 62, symbol: 'Sm', name: 'Samarium', atomicWeight: 150.36, category: 'lanthanide', row: 8, col: 8 },
        { atomicNumber: 63, symbol: 'Eu', name: 'Europium', atomicWeight: 151.96, category: 'lanthanide', row: 8, col: 9 },
        { atomicNumber: 64, symbol: 'Gd', name: 'Gadolinium', atomicWeight: 157.25, category: 'lanthanide', row: 8, col: 10 },
        { atomicNumber: 65, symbol: 'Tb', name: 'Terbium', atomicWeight: 158.93, category: 'lanthanide', row: 8, col: 11 },
        { atomicNumber: 66, symbol: 'Dy', name: 'Dysprosium', atomicWeight: 162.50, category: 'lanthanide', row: 8, col: 12 },
        { atomicNumber: 67, symbol: 'Ho', name: 'Holmium', atomicWeight: 164.93, category: 'lanthanide', row: 8, col: 13 },
        { atomicNumber: 68, symbol: 'Er', name: 'Erbium', atomicWeight: 167.26, category: 'lanthanide', row: 8, col: 14 },
        { atomicNumber: 69, symbol: 'Tm', name: 'Thulium', atomicWeight: 168.93, category: 'lanthanide', row: 8, col: 15 },
        { atomicNumber: 70, symbol: 'Yb', name: 'Ytterbium', atomicWeight: 173.05, category: 'lanthanide', row: 8, col: 16 },
        { atomicNumber: 71, symbol: 'Lu', name: 'Lutetium', atomicWeight: 174.97, category: 'lanthanide', row: 8, col: 17 },
        // Actinides (row 9)
        { atomicNumber: 89, symbol: 'Ac', name: 'Actinium', atomicWeight: 227, category: 'actinide', row: 9, col: 3 },
        { atomicNumber: 90, symbol: 'Th', name: 'Thorium', atomicWeight: 232.04, category: 'actinide', row: 9, col: 4 },
        { atomicNumber: 91, symbol: 'Pa', name: 'Protactinium', atomicWeight: 231.04, category: 'actinide', row: 9, col: 5 },
        { atomicNumber: 92, symbol: 'U', name: 'Uranium', atomicWeight: 238.03, category: 'actinide', row: 9, col: 6 },
        { atomicNumber: 93, symbol: 'Np', name: 'Neptunium', atomicWeight: 237, category: 'actinide', row: 9, col: 7 },
        { atomicNumber: 94, symbol: 'Pu', name: 'Plutonium', atomicWeight: 244, category: 'actinide', row: 9, col: 8 },
        { atomicNumber: 95, symbol: 'Am', name: 'Americium', atomicWeight: 243, category: 'actinide', row: 9, col: 9 },
        { atomicNumber: 96, symbol: 'Cm', name: 'Curium', atomicWeight: 247, category: 'actinide', row: 9, col: 10 },
        { atomicNumber: 97, symbol: 'Bk', name: 'Berkelium', atomicWeight: 247, category: 'actinide', row: 9, col: 11 },
        { atomicNumber: 98, symbol: 'Cf', name: 'Californium', atomicWeight: 251, category: 'actinide', row: 9, col: 12 },
        { atomicNumber: 99, symbol: 'Es', name: 'Einsteinium', atomicWeight: 252, category: 'actinide', row: 9, col: 13 },
        { atomicNumber: 100, symbol: 'Fm', name: 'Fermium', atomicWeight: 257, category: 'actinide', row: 9, col: 14 },
        { atomicNumber: 101, symbol: 'Md', name: 'Mendelevium', atomicWeight: 258, category: 'actinide', row: 9, col: 15 },
        { atomicNumber: 102, symbol: 'No', name: 'Nobelium', atomicWeight: 259, category: 'actinide', row: 9, col: 16 },
        { atomicNumber: 103, symbol: 'Lr', name: 'Lawrencium', atomicWeight: 266, category: 'actinide', row: 9, col: 17 },
      ],
    },
  },

  // ── 5. COMPLEX: E-Commerce Product Page ───────────────────────────
  {
    id: 'product-page',
    name: 'E-Commerce Product Page',
    description: 'Product detail page with image, tabs, quantity selector, and cart',
    complexity: 'complex',
    expectedMinScore: 55,
    shellType: 'fullscreen',
    screen: 'universal',
    prompt: `Build an e-commerce product detail page. Layout:

Top section:
- Product image placeholder (use a colored box with the product name)
- Product title, price (with currency from props), and rating stars (1-5)
- Stock status badge ("In Stock" green or "Low Stock" warning)

Middle section — Tab navigation with 3 tabs:
- "Description" tab: renders product description text from props
- "Specifications" tab: renders key-value pairs from props as a table
- "Reviews" tab: renders a list of reviews (author, rating, text, date) from props

Bottom section:
- Quantity selector (increment/decrement buttons, min 1, max from stock)
- "Add to Cart" button (disabled if out of stock)
- Call props.onAddToCart with { productId, quantity } when clicked

Requirements:
- All product data from props — nothing hardcoded
- Use design system tokens for all colors, spacing, typography
- Price should format with currency symbol from props
- Rating stars should be visual (filled/empty)
- Responsive: stack image above details on mobile widths`,
    contract: {
      propsSpec: {
        properties: {
          product: {
            schema: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, currency: { type: 'string' }, rating: { type: 'number' }, reviewCount: { type: 'number' }, stock: { type: 'number' }, description: { type: 'string' }, specifications: { type: 'array' }, reviews: { type: 'array' } } },
            required: true,
            description: 'Product object with id, name, price, currency, rating, stock, description, specifications[], reviews[]',
            example: {
              id: 'prod-001',
              name: 'Wireless Noise-Cancelling Headphones',
              price: 249.99,
              currency: 'USD',
              rating: 4.3,
              reviewCount: 128,
              stock: 12,
              description: 'Premium wireless headphones with adaptive noise cancellation, 30-hour battery life, and ultra-comfortable memory foam ear cushions.',
              specifications: [{ key: 'Brand', value: 'AudioMax' }, { key: 'Battery Life', value: '30 hours' }],
              reviews: [{ author: 'Alex M.', rating: 5, text: 'Best headphones I have ever owned. The noise cancellation is incredible.', date: '2026-03-01' }],
            },
          },
        },
      },
      actionSpec: {
        addToCart: { label: 'Add to Cart', description: 'Called when user clicks Add to Cart. Payload: { productId, quantity }', nextStep: 'shopify_add_to_cart', example: { productId: 'prod-001', quantity: 2 } },
      },
    },
    props: {
      product: {
        id: 'prod-001',
        name: 'Wireless Noise-Cancelling Headphones',
        price: 249.99,
        currency: 'USD',
        rating: 4.3,
        reviewCount: 128,
        stock: 12,
        description: 'Premium wireless headphones with adaptive noise cancellation, 30-hour battery life, and ultra-comfortable memory foam ear cushions.',
        specifications: [
          { key: 'Brand', value: 'AudioMax' },
          { key: 'Battery Life', value: '30 hours' },
          { key: 'Connectivity', value: 'Bluetooth 5.3' },
          { key: 'Weight', value: '250g' },
          { key: 'Driver Size', value: '40mm' },
          { key: 'Noise Cancellation', value: 'Adaptive ANC' },
        ],
        reviews: [
          { author: 'Alex M.', rating: 5, text: 'Best headphones I have ever owned. The noise cancellation is incredible.', date: '2026-03-01' },
          { author: 'Sarah K.', rating: 4, text: 'Great sound quality. A bit tight for my head but breaks in after a week.', date: '2026-02-15' },
          { author: 'James P.', rating: 4, text: 'Battery life is exactly as advertised. Very impressed.', date: '2026-01-28' },
        ],
      },
    },
  },

  // ── 6. MEDIUM: Chat UI (converse) ───────────────────────────────────
  {
    id: 'chat-interface',
    name: 'Chat Interface',
    description: 'Chat UI with message list, input area, and send callback',
    complexity: 'medium',
    expectedMinScore: 60,
    shellType: 'fullscreen',
    screen: 'universal',
    prompt: `Build a chat interface component with real-time messaging. Layout:

Header:
- Chat title from props
- Participant count badge
- Typing indicator (shows when another user is typing, received via stream)

Message list:
- Scrollable area showing messages (initial from props, new ones from stream)
- Each message shows: sender name, message text, formatted timestamp
- Messages from the current user (where sender matches props.currentUser) align right with primary color background
- Messages from others align left with surfaceVariant background
- Group consecutive messages from same sender

Input area at the bottom:
- Text input field for composing messages
- Send button (disabled when input is empty)
- Call the sendMessage action with { text, timestamp: new Date().toISOString() } on click or Enter

Requirements:
- Initial messages from props, new messages arrive via stream — append them to the list
- Typing indicator appears/disappears via stream events
- Use design system CSS variables for all colors and spacing
- Auto-scroll to bottom when new messages arrive`,
    contract: {
      propsSpec: {
        properties: {
          title: { schema: { type: 'string' }, required: true, description: 'Chat window title', example: 'Team Chat' },
          currentUser: { schema: { type: 'string' }, required: true, description: 'Current user name (for right-aligning own messages)', example: 'You' },
          participantCount: { schema: { type: 'number' }, description: 'Number of participants', example: 3 },
          messages: {
            schema: { type: 'array', items: { type: 'object', properties: { sender: { type: 'string' }, text: { type: 'string' }, timestamp: { type: 'string' } } } },
            required: true,
            description: 'Initial messages to display on mount',
            example: [
              { sender: 'Alice', text: 'Hey team, the design review is at 3pm', timestamp: '2026-03-15T14:00:00Z' },
              { sender: 'You', text: 'Perfect, see you both there', timestamp: '2026-03-15T14:03:00Z' },
            ],
          },
        },
      },
      actionSpec: {
        sendMessage: { label: 'Send Message', description: 'Called when user sends a message. Payload: { text, timestamp }', nextStep: 'slack_post_message', example: { text: 'Sounds good!', timestamp: '2026-03-15T14:10:00Z' } },
      },
      streamSpec: {
        message: {
          description: 'New message from another participant — append to message list',
          schema: { type: 'object', properties: { sender: { type: 'string' }, text: { type: 'string' }, timestamp: { type: 'string' } } },
          example: { sender: 'Alice', text: 'Just pushed the latest changes', timestamp: '2026-03-15T14:10:00Z' },
        },
        typing: {
          description: 'Typing indicator — show/hide based on active flag',
          schema: { type: 'object', properties: { sender: { type: 'string' }, active: { type: 'boolean' } } },
          example: { sender: 'Bob', active: true },
        },
      },
      agentCapabilities: {
        tools: {
          loadHistory: {
            toolInfo: {
              description: 'Fetch older messages for infinite scroll',
              inputSchema: { type: 'object', properties: {
                before: { type: 'string', description: 'ISO timestamp cursor' },
                limit: { type: 'number', description: 'Max messages to return' },
              }},
              outputSchema: { type: 'object', properties: {
                messages: { type: 'array', items: { type: 'object', properties: {
                  sender: { type: 'string' }, text: { type: 'string' }, timestamp: { type: 'string' },
                }}},
                hasMore: { type: 'boolean' },
              }},
            },
            example: {
              input: { before: '2026-03-15T14:00:00Z', limit: 20 },
              output: { messages: [{ sender: 'Alice', text: 'Earlier message', timestamp: '2026-03-15T13:55:00Z' }], hasMore: true },
            },
          },
          searchMessages: {
            toolInfo: {
              description: 'Full-text search across conversation',
              inputSchema: { type: 'object', properties: { query: { type: 'string' } }},
              outputSchema: { type: 'object', properties: {
                results: { type: 'array', items: { type: 'object', properties: {
                  sender: { type: 'string' }, text: { type: 'string' }, timestamp: { type: 'string' },
                }}},
              }},
            },
          },
        },
      },
    },
    props: {
      title: 'Team Chat',
      currentUser: 'You',
      participantCount: 3,
      messages: [
        { sender: 'Alice', text: 'Hey team, the design review is at 3pm', timestamp: '2026-03-15T14:00:00Z' },
        { sender: 'Bob', text: 'Got it, I will prepare the mockups', timestamp: '2026-03-15T14:02:00Z' },
        { sender: 'You', text: 'Perfect, see you both there', timestamp: '2026-03-15T14:03:00Z' },
        { sender: 'Alice', text: 'Also, can someone review the color palette?', timestamp: '2026-03-15T14:05:00Z' },
        { sender: 'Alice', text: 'I pushed the latest changes to the design branch', timestamp: '2026-03-15T14:05:30Z' },
        { sender: 'You', text: 'I will take a look after the meeting', timestamp: '2026-03-15T14:06:00Z' },
      ],
    },
  },

  // ── 7. SIMPLE: Live Data Stream (broadcast) ───────────────────────
  {
    id: 'stock-ticker',
    name: 'Stock Ticker Dashboard',
    description: 'Stock price display with color-coded changes and responsive grid',
    complexity: 'simple',
    expectedMinScore: 65,
    shellType: 'chat',
    screen: 'universal',
    prompt: `Build a stock ticker dashboard that displays stock prices with live updates. Layout:
- Header with "Market Watch" title and a "Last Updated" timestamp (updates in real-time)
- Responsive grid of stock cards (3 per row on desktop, 1 on mobile)
- Each card shows: ticker symbol (large, bold), company name, current price formatted with 2 decimals, change amount, and change percentage
- Color coding: green text/border for positive change, red for negative change
- A subtle arrow icon (▲ or ▼) next to the change percentage
- Brief flash/highlight animation when a stock price updates

Initial stock data comes from props. Live price updates arrive via stream events — merge them into the displayed data. Use design system CSS variables for all colors and spacing.`,
    contract: {
      propsSpec: {
        properties: {
          stocks: {
            schema: { type: 'array', items: { type: 'object', properties: { symbol: { type: 'string' }, name: { type: 'string' }, price: { type: 'number' }, change: { type: 'number' }, changePercent: { type: 'number' } } } },
            required: true,
            description: 'Array of stocks with symbol, name, price, change, changePercent',
            example: [
              { symbol: 'AAPL', name: 'Apple Inc.', price: 178.52, change: 2.34, changePercent: 1.33 },
              { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 141.80, change: -0.95, changePercent: -0.67 },
            ],
          },
        },
      },
      streamSpec: {
        priceUpdate: {
          description: 'Updated price data for one or more stocks',
          schema: { type: 'object', properties: { symbol: { type: 'string' }, price: { type: 'number' }, change: { type: 'number' }, changePercent: { type: 'number' } } },
          example: { symbol: 'AAPL', price: 179.10, change: 2.92, changePercent: 1.66 },
        },
        marketStatus: {
          description: 'Market open/closed status update',
          schema: { type: 'object', properties: { status: { type: 'string', enum: ['open', 'closed', 'pre-market', 'after-hours'] }, timestamp: { type: 'string' } } },
          example: { status: 'open', timestamp: '2026-03-15T16:30:00Z' },
        },
      },
      agentCapabilities: {
        tools: {
          getStockDetail: {
            toolInfo: {
              description: 'Get detailed info for a specific stock (52-week range, volume, etc.)',
              inputSchema: { type: 'object', properties: { symbol: { type: 'string' } }},
              outputSchema: { type: 'object', properties: {
                symbol: { type: 'string' }, name: { type: 'string' },
                high52w: { type: 'number' }, low52w: { type: 'number' },
                volume: { type: 'number' }, marketCap: { type: 'string' },
              }},
            },
            example: {
              input: { symbol: 'AAPL' },
              output: { symbol: 'AAPL', name: 'Apple Inc.', high52w: 199.62, low52w: 140.81, volume: 54123000, marketCap: '2.89T' },
            },
          },
        },
      },
    },
    props: {
      stocks: [
        { symbol: 'AAPL', name: 'Apple Inc.', price: 178.52, change: 2.34, changePercent: 1.33 },
        { symbol: 'GOOGL', name: 'Alphabet Inc.', price: 141.80, change: -0.95, changePercent: -0.67 },
        { symbol: 'MSFT', name: 'Microsoft Corp.', price: 378.91, change: 4.12, changePercent: 1.10 },
        { symbol: 'TSLA', name: 'Tesla Inc.', price: 248.42, change: -5.67, changePercent: -2.23 },
        { symbol: 'AMZN', name: 'Amazon.com', price: 178.25, change: 1.87, changePercent: 1.06 },
        { symbol: 'NVDA', name: 'NVIDIA Corp.', price: 875.28, change: 12.45, changePercent: 1.44 },
      ],
    },
  },

  // ── 8. MEDIUM: Multi-Step Flow ────────────────────────────────────
  {
    id: 'onboarding-wizard',
    name: 'Onboarding Wizard',
    description: 'Multi-step onboarding flow with step indicator and validation',
    complexity: 'medium',
    expectedMinScore: 60,
    shellType: 'fullscreen',
    screen: 'universal',
    prompt: `Build a 3-step onboarding wizard. Steps:

Step 1 - Profile Setup:
- Name input (required)
- Email input (required, validate email format)
- Avatar selection (choose from 4 emoji avatars)

Step 2 - Preferences:
- Role selection (dropdown: Developer, Designer, Manager, Other)
- Notification toggle (email notifications on/off)
- Theme preference (light/dark toggle)

Step 3 - Review & Confirm:
- Summary of all selections from steps 1-2
- "Go Back" button to edit
- "Complete Setup" button to submit

Requirements:
- Step indicator at top showing current step (1/2/3) with progress bar
- Back/Next navigation (Next disabled until required fields valid)
- Smooth transition between steps
- Call props.onComplete with all collected data on final submit
- All initial values from props (for editing existing profile)
- Use design system CSS variables for all styling`,
    contract: {
      propsSpec: {
        properties: {
          initialProfile: {
            schema: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' }, avatar: { type: 'string' }, role: { type: 'string' }, emailNotifications: { type: 'boolean' }, theme: { type: 'string' } } },
            description: 'Pre-filled profile data for editing (all fields optional)',
            example: {},
          },
          avatarOptions: {
            schema: { type: 'array', items: { type: 'string' } },
            required: true,
            description: 'Available avatar emojis to choose from',
            example: ['👤', '🧑‍💻', '🎨', '📊'],
          },
          roleOptions: {
            schema: { type: 'array', items: { type: 'string' } },
            required: true,
            description: 'Available role options for the dropdown',
            example: ['Developer', 'Designer', 'Manager', 'Other'],
          },
        },
      },
      actionSpec: {
        complete: { label: 'Complete Setup', description: 'Called with all profile data when user completes onboarding', nextStep: 'user_create_profile', example: { name: 'Jane', email: 'jane@example.com', avatar: '🧑‍💻', role: 'Developer', emailNotifications: true, theme: 'dark' } },
      },
    },
    props: {
      initialProfile: {},
      avatarOptions: ['👤', '🧑‍💻', '🎨', '📊'],
      roleOptions: ['Developer', 'Designer', 'Manager', 'Other'],
    },
  },

  // ── 9. COMPONENT GADGET: 3rd-party wrapper (Leaflet) ──────────────
  // GG.8.7 — component-gadget bench commit. Exercises the wrapper
  // path end-to-end: the contract declares the package-keyed
  // `clientCapabilities.gadgets['@ggui-samples/gadget-leaflet'] = { LeafletMap: {} }`;
  // `appGadgets` registers the canonical Leaflet wrapper descriptor
  // (mirrors what `packages/samples/gadgets/leaflet` emits via
  // `defineGadgetPackage`). The runner threads `appGadgets` into
  // `dispatchGeneration` so the code-gen system prompt's
  // `clientCapabilities — registered catalog` renders the operator's
  // actual plugin set; `gadgetTypes` threads the wrapper's `.d.ts` so
  // the typecheck resolves `<LeafletMap>` against real prop types; and
  // the post-generation `gadgetUsage` check verifies the LLM actually
  // rendered the registered component (not just declared it).
  {
    id: 'leaflet-map',
    name: 'Leaflet Delivery Map',
    description:
      'Component-gadget: render an interactive Leaflet map of delivery markers via the registered <LeafletMap> component.',
    complexity: 'medium',
    expectedMinScore: 60,
    shellType: 'fullscreen',
    screen: 'universal',
    prompt: `Build a delivery tracking component that shows recent deliveries on an interactive map.

Layout:
- Top: page header with the recipient name and a count of deliveries
- Map area: full-width Leaflet map centered on the city — render the registered \`<LeafletMap>\` component gadget declared under \`clientCapabilities.gadgets\`
- Below the map: a compact scrollable list of the deliveries with status, ETA, and a "view on map" affordance

All data comes from props (recipient name, list of deliveries with lat/lng/eta/status). Use design-system CSS variables for all colors and spacing. The map MUST render via the registered \`<LeafletMap>\` component — do NOT import Leaflet directly. The component owns its own sizing and map lifecycle; just pass \`center\`, \`zoom\`, and \`markers\` props.`,
    contract: {
      propsSpec: {
        properties: {
          recipientName: {
            schema: { type: 'string' },
            required: true,
            description: 'Account holder the deliveries are for',
            example: 'Park Min-jun',
          },
          center: {
            schema: {
              type: 'array',
              items: { type: 'number' },
            },
            required: true,
            description: 'Map starting center [lat, lng]',
            example: [37.5665, 126.978],
          },
          zoom: {
            schema: { type: 'number' },
            description: 'Map starting zoom (1..20)',
            example: 12,
          },
          deliveries: {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  label: { type: 'string' },
                  lat: { type: 'number' },
                  lng: { type: 'number' },
                  eta: { type: 'string' },
                  status: {
                    type: 'string',
                    enum: ['pending', 'in-transit', 'delivered'],
                  },
                },
              },
            },
            required: true,
            description: 'Array of delivery markers to plot on the map',
            example: [
              { id: 'd1', label: 'Grocery box', lat: 37.572, lng: 126.985, eta: '14:20', status: 'in-transit' },
            ],
          },
        },
      },
      clientCapabilities: {
        gadgets: {
          // The LLM MUST resolve this via the registered component
          // gadget, never raw `leaflet`. Package-keyed: the npm package
          // is the outer key, the export name (`LeafletMap`) the inner.
          '@ggui-samples/gadget-leaflet': {
            LeafletMap: {
              description:
                'Interactive Leaflet map for plotting delivery markers',
            },
          },
        },
      },
    },
    props: {
      recipientName: 'Park Min-jun',
      center: [37.5665, 126.978],
      zoom: 12,
      deliveries: [
        { id: 'd1', label: 'Grocery box', lat: 37.572, lng: 126.985, eta: '14:20', status: 'in-transit' },
        { id: 'd2', label: 'Replacement charger', lat: 37.561, lng: 126.965, eta: '15:05', status: 'pending' },
        { id: 'd3', label: 'Birthday gift', lat: 37.579, lng: 126.992, eta: '12:50', status: 'delivered' },
        { id: 'd4', label: 'Bookshop order', lat: 37.55, lng: 126.972, eta: '16:30', status: 'pending' },
      ],
    },
    appGadgets: [
      // Mirrors `packages/samples/gadgets/leaflet/src/index.tsx` —
      // the canonical descriptor a real operator would seed into
      // `App.gadgets` from `ggui.json`. Bench keeps the descriptor
      // inline so the commit is self-contained: no workspace
      // cross-dependency, and accidental drift in the sample wrapper
      // doesn't silently change the bench's prompt payload. The
      // matching `.d.ts` rides on the commit's `gadgetTypes` field.
      {
        package: '@ggui-samples/gadget-leaflet',
        version: '0.0.1',
        bundleUrl: 'https://registry.ggui.ai/leaflet@0.0.1/bundle.js',
        styleUrl: 'https://registry.ggui.ai/leaflet@0.0.1/leaflet.css',
        connect: ['https://tile.openstreetmap.org'],
        exports: [
          {
            component: 'LeafletMap',
            description:
              'GguiSession an interactive Leaflet map with a tile layer, pan/zoom, and optional markers. The component owns the container, sizing, and lifecycle.',
            usage:
              'GguiSession `<LeafletMap center={[lat, lng]} zoom={2..20} />` when the intent names a rendered map (location browsing, route preview, delivery tracking, points-of-interest). Optional `markers={[{ lat, lng, label? }]}` plot pins; optional `height` (default 400) sizes the map.',
            example: {
              componentSnippet:
                'function DeliveryMap({ center, deliveries }: Props) { return <LeafletMap center={center} zoom={12} markers={deliveries.map((d) => ({ id: d.id, lat: d.lat, lng: d.lng, label: d.label }))} />; }',
            },
            gotchas:
              'The component owns map sizing (default 400px height; override with `height`) and the full Leaflet lifecycle — just render `<LeafletMap center={[lat, lng]} zoom={n} />`. Do NOT import `leaflet` directly or hand-roll a container ref.',
          },
        ],
      },
    ],
    // GG.8.7 — thread the wrapper's `.d.ts` so the coding agent's
    // typecheck resolves `<LeafletMap>` against real prop types.
    gadgetTypes: {
      '@ggui-samples/gadget-leaflet': LEAFLET_GADGET_DTS,
    },
  },

  // ── 10. MIXED COMPONENT GADGET: chart (component + hook) ───────────
  // GG.8.7 — the mixed-package bench commit. `@ggui-samples/gadget-
  // chart` ships a `Chart` COMPONENT export and a `useChartTheme` HOOK
  // export under one descriptor. The contract binds the component; the
  // companion hook rounds out the registered catalog. `gadgetTypes`
  // threads the package's `.d.ts` so the typecheck sees both exports.
  {
    id: 'revenue-chart',
    name: 'Quarterly Revenue Chart',
    description:
      'Mixed component gadget: render a bar chart of quarterly revenue via the registered <Chart> component.',
    complexity: 'medium',
    expectedMinScore: 60,
    shellType: 'fullscreen',
    screen: 'universal',
    prompt: `Build a revenue summary card for a finance dashboard.

Layout:
- Top: a header with the report title and the total revenue across all quarters
- Chart: a bar chart of revenue per quarter — render the registered \`<Chart>\` component gadget declared under \`clientCapabilities.gadgets\`, and color its bars with the registered \`useChartTheme\` hook (\`const theme = useChartTheme();\` then pass \`theme.palette[0]\` to \`<Chart barColor>\`) so the chart tracks the app theme
- Below the chart: a compact legend listing each quarter with its revenue figure

All data comes from props (report title, list of quarters with a label and a revenue number). Use design-system CSS variables for all colors and spacing. The chart MUST render via the registered \`<Chart>\` component — do NOT hand-roll an SVG or pull in a charting library.`,
    contract: {
      propsSpec: {
        properties: {
          title: {
            schema: { type: 'string' },
            required: true,
            description: 'Report title shown in the header',
            example: 'FY25 Revenue Summary',
          },
          quarters: {
            schema: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  revenue: { type: 'number' },
                },
              },
            },
            required: true,
            description: 'Revenue figure for each quarter',
            example: [{ label: 'Q1', revenue: 128 }],
          },
        },
      },
      clientCapabilities: {
        gadgets: {
          '@ggui-samples/gadget-chart': {
            Chart: {
              description: 'Bar chart for plotting quarterly revenue',
            },
            useChartTheme: {
              description:
                'Resolved chart colors (categorical palette + axis / label / grid colors) for the active ggui theme',
            },
          },
        },
      },
    },
    props: {
      title: 'FY25 Revenue Summary',
      quarters: [
        { label: 'Q1', revenue: 128 },
        { label: 'Q2', revenue: 196 },
        { label: 'Q3', revenue: 164 },
        { label: 'Q4', revenue: 232 },
      ],
    },
    appGadgets: [
      // Mirrors `packages/samples/gadgets/chart/src/index.tsx` — a
      // MIXED package: a `Chart` component export plus a
      // `useChartTheme` companion hook export under one descriptor.
      // Kept inline so the commit is self-contained (see commit 9).
      {
        package: '@ggui-samples/gadget-chart',
        version: '0.0.1',
        bundleUrl: 'https://registry.ggui.ai/chart@0.0.1/bundle.js',
        exports: [
          {
            component: 'Chart',
            description:
              'GguiSession a responsive SVG bar chart. Each datum is a labelled magnitude; bars scale to the largest value.',
            usage:
              'GguiSession `<Chart data={[{ label, value }]} />` when the intent names a bar chart or a metric breakdown. Optional `height` (default 240) and `barColor`. The component owns the full SVG render — pass plain data, no refs.',
            example: {
              componentSnippet:
                'function RevenuePanel({ quarters }: Props) { return <Chart data={quarters.map((q) => ({ label: q.label, value: q.revenue }))} height={260} />; }',
            },
            gotchas:
              'Pass `data` as plain `{ label, value }` objects from props — never hardcode chart values.',
          },
          {
            hook: 'useChartTheme',
            description:
              'Read the active ggui theme and return resolved chart colors — a categorical palette plus axis / label / grid colors.',
            usage:
              'Call `const theme = useChartTheme();` then pass `theme.palette[0]` to `<Chart barColor>` so the chart tracks the app theme.',
            example: {
              call: 'const theme = useChartTheme();',
              returns: {
                palette: ['#3b82f6', '#0ea5e9', '#22c55e'],
                axisColor: '#d4d4d8',
                labelColor: '#18181b',
                gridColor: '#e4e4e7',
              },
            },
          },
        ],
      },
    ],
    gadgetTypes: {
      '@ggui-samples/gadget-chart': CHART_GADGET_DTS,
    },
  },
];

/**
 * Get a single benchmark commit by ID.
 */
export function getBenchmarkCommit(id: string): BenchmarkCommit | undefined {
  return BENCHMARK_COMMITS.find((c) => c.id === id);
}

// =============================================================================
// Personalization variance corpus
// =============================================================================
//
// Two commits sharing the same contract but tagged with different
// persona/aesthetic variance signals. The bench scores them
// independently and surfaces the variance side-by-side via the
// `byGenerator` breakdown in the report.
//
// Variance flows only through the user prompt (see
// `formatVarianceBlock` in `runner.ts`). The bench captures the
// variance-tagged outputs so the operator can compare aesthetics
// without re-running the whole corpus.

/**
 * Shared contract for both personalization variants. Lifted to a
 * constant so the two corpus entries cannot drift apart silently.
 */
const PERSONALIZATION_CARD_CONTRACT: BenchmarkCommit['contract'] = {
  propsSpec: {
    properties: {
      userName: {
        schema: { type: 'string' },
        required: true,
        description: 'Name of the user being greeted',
        example: 'Sam',
      },
      summary: {
        schema: { type: 'string' },
        required: true,
        description: 'Short summary line shown beneath the greeting',
        example: 'You have 3 new messages',
      },
      stats: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              value: { type: 'string' },
            },
          },
        },
        required: true,
        description: '4-6 quick stats to display beneath the summary',
        example: [
          { label: 'Tasks', value: '7 done' },
          { label: 'Streak', value: '5d' },
        ],
      },
    },
  },
};

const PERSONALIZATION_CARD_PROPS = {
  userName: 'Sam',
  summary: 'You have 3 new messages',
  stats: [
    { label: 'Tasks', value: '7 done' },
    { label: 'Streak', value: '5 days' },
    { label: 'Inbox', value: '12 unread' },
    { label: 'Goals', value: '4/5 met' },
  ],
};

/**
 * Personalization variants. Same contract; different
 * `variance.persona` hints. Each entry is a separate
 * {@link BenchmarkCommit} so the bench runner records them as
 * distinct fixtures — the report's `byGenerator` breakdown surfaces
 * them side-by-side when both are run.
 */
export const PERSONALIZATION_COMMITS: BenchmarkCommit[] = [
  {
    id: 'greeting-card-minimalist',
    name: 'Greeting Card — Minimalist',
    description:
      'Personalization probe: same contract, minimalist persona — expect spare, generous whitespace, monochrome.',
    complexity: 'simple',
    shellType: 'chat',
    screen: 'mobile',
    prompt:
      `Build a personalized greeting card. Display the user's name prominently, a one-line ` +
      `summary below it, and a list of quick stats. All data comes from props. Use the design ` +
      `system CSS variables; honor the variance hint at the end of this prompt for the visual tone.`,
    contract: PERSONALIZATION_CARD_CONTRACT,
    props: PERSONALIZATION_CARD_PROPS,
    variance: {
      persona: 'minimalist',
      aesthetic: 'flat',
      seedPrompt:
        'Spare layout, generous whitespace, monochrome with one accent color, no ornamental icons.',
    },
  },
  {
    id: 'greeting-card-data-dense',
    name: 'Greeting Card — Data Dense',
    description:
      'Personalization probe: same contract, data-dense persona — expect compact grid, multiple typographic weights, badge-style stats.',
    complexity: 'simple',
    shellType: 'chat',
    screen: 'mobile',
    prompt:
      `Build a personalized greeting card. Display the user's name prominently, a one-line ` +
      `summary below it, and a list of quick stats. All data comes from props. Use the design ` +
      `system CSS variables; honor the variance hint at the end of this prompt for the visual tone.`,
    contract: PERSONALIZATION_CARD_CONTRACT,
    props: PERSONALIZATION_CARD_PROPS,
    variance: {
      persona: 'data-dense',
      aesthetic: 'editorial',
      seedPrompt:
        'Compact grid, multiple typographic weights, badge-style stats with subtle color coding.',
    },
  },
];

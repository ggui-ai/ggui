/**
 * Default demo data — one fully-populated virtual restaurant.
 *
 * Seeds a believable menu (with photos + modifiers), a floor of tables in
 * mixed states, and several in-flight + completed orders so that EVERY
 * surface has data on first load: the owner's kitchen board shows live
 * tickets, the sales chart shows today's revenue, the floor map shows a
 * table calling for help. `POST /admin/reset` re-runs this.
 *
 * Photos are referenced as relative `/assets/<x>.svg` paths served by this
 * same server (see the HTTP layer); absolutized per-request so they resolve
 * from the browser that renders the menu card.
 */
import { truncateAll, type SqliteDatabase } from './db.js';
import { createStore, type MenuItemSeed, type OrderSeed, type TableSeed } from './store.js';
import { priceLine } from './pricing.js';
import type { ModifierGroup, OrderStatus, SelectedOption } from './types.js';

export const RESTAURANT_ID = 'demo-bistro';
/** The table a `customer` demo session binds to by default. */
export const DEMO_TABLE_ID = 'tbl-7';

// --- reusable modifier groups ---------------------------------------------

const SIZE: ModifierGroup = {
  id: 'size',
  label: 'Size',
  required: false,
  multi: false,
  options: [
    { id: 'reg', label: 'Regular', priceDeltaCents: 0 },
    { id: 'lg', label: 'Large', priceDeltaCents: 300 },
  ],
};
const SPICE: ModifierGroup = {
  id: 'spice',
  label: 'Spice level',
  required: false,
  multi: false,
  options: [
    { id: 'mild', label: 'Mild', priceDeltaCents: 0 },
    { id: 'med', label: 'Medium', priceDeltaCents: 0 },
    { id: 'hot', label: 'Hot', priceDeltaCents: 0 },
  ],
};
const EXTRAS: ModifierGroup = {
  id: 'extras',
  label: 'Extras',
  required: false,
  multi: true,
  options: [
    { id: 'cheese', label: 'Extra cheese', priceDeltaCents: 150 },
    { id: 'bacon', label: 'Bacon', priceDeltaCents: 200 },
    { id: 'avocado', label: 'Avocado', priceDeltaCents: 200 },
  ],
};
const MILK: ModifierGroup = {
  id: 'milk',
  label: 'Milk',
  required: false,
  multi: false,
  options: [
    { id: 'whole', label: 'Whole', priceDeltaCents: 0 },
    { id: 'oat', label: 'Oat', priceDeltaCents: 60 },
    { id: 'almond', label: 'Almond', priceDeltaCents: 60 },
  ],
};

// --- menu (two items pre-"86'd": calamari + iced tea) ----------------------

const MENU: readonly MenuItemSeed[] = [
  { id: 'item-bruschetta', name: 'Tomato Bruschetta', description: 'Grilled sourdough, vine tomatoes, basil, olive oil.', priceCents: 750, category: 'starters', tags: ['vegetarian', 'popular'], options: [], available: true, photoPath: '/assets/bruschetta.svg' },
  { id: 'item-calamari', name: 'Crispy Calamari', description: 'Lightly fried squid with lemon aioli.', priceCents: 1100, category: 'starters', tags: [], options: [], available: false, photoPath: '/assets/calamari.svg' },
  { id: 'item-soup', name: 'Soup of the Day', description: 'Always made fresh — ask your server.', priceCents: 650, category: 'starters', tags: ['vegetarian'], options: [], available: true, photoPath: '/assets/soup.svg' },
  { id: 'item-margherita', name: 'Margherita Pizza', description: 'San Marzano tomato, fresh mozzarella, basil.', priceCents: 1300, category: 'mains', tags: ['vegetarian', 'popular'], options: [SIZE, EXTRAS], available: true, photoPath: '/assets/margherita.svg' },
  { id: 'item-pepperoni', name: 'Pepperoni Pizza', description: 'Mozzarella, spicy pepperoni, oregano.', priceCents: 1500, category: 'mains', tags: ['popular'], options: [SIZE, EXTRAS], available: true, photoPath: '/assets/pepperoni.svg' },
  { id: 'item-carbonara', name: 'Spaghetti Carbonara', description: 'Guanciale, egg, pecorino, black pepper.', priceCents: 1450, category: 'mains', tags: [], options: [], available: true, photoPath: '/assets/carbonara.svg' },
  { id: 'item-burger', name: 'Classic Cheeseburger', description: 'Beef patty, cheddar, lettuce, tomato, brioche bun.', priceCents: 1350, category: 'mains', tags: ['popular'], options: [EXTRAS], available: true, photoPath: '/assets/burger.svg' },
  { id: 'item-curry', name: 'Thai Green Curry', description: 'Coconut curry with seasonal vegetables and jasmine rice.', priceCents: 1500, category: 'mains', tags: ['spicy', 'gluten_free'], options: [SPICE, SIZE], available: true, photoPath: '/assets/curry.svg' },
  { id: 'item-salad', name: 'Garden Salad', description: 'Mixed leaves, cucumber, radish, lemon vinaigrette.', priceCents: 1000, category: 'mains', tags: ['vegan', 'gluten_free'], options: [EXTRAS], available: true, photoPath: '/assets/salad.svg' },
  { id: 'item-cola', name: 'Cola', description: 'Chilled classic cola.', priceCents: 300, category: 'drinks', tags: [], options: [SIZE], available: true, photoPath: '/assets/cola.svg' },
  { id: 'item-lemonade', name: 'Fresh Lemonade', description: 'House-pressed, lightly sweetened.', priceCents: 400, category: 'drinks', tags: ['vegan'], options: [SIZE], available: true, photoPath: '/assets/lemonade.svg' },
  { id: 'item-coffee', name: 'Coffee', description: 'Single-origin espresso or filter.', priceCents: 350, category: 'drinks', tags: [], options: [MILK], available: true, photoPath: '/assets/coffee.svg' },
  { id: 'item-iced-tea', name: 'Iced Tea', description: 'House-brewed, unsweetened.', priceCents: 350, category: 'drinks', tags: ['vegan'], options: [SIZE], available: false, photoPath: '/assets/iced-tea.svg' },
  { id: 'item-tiramisu', name: 'Tiramisu', description: 'Espresso-soaked ladyfingers, mascarpone, cocoa.', priceCents: 700, category: 'desserts', tags: ['vegetarian', 'popular'], options: [], available: true, photoPath: '/assets/tiramisu.svg' },
  { id: 'item-gelato', name: 'Gelato', description: 'Three scoops — ask for today\'s flavors.', priceCents: 600, category: 'desserts', tags: ['vegetarian', 'gluten_free'], options: [], available: true, photoPath: '/assets/gelato.svg' },
];

// --- floor -----------------------------------------------------------------

const TABLES: readonly TableSeed[] = [
  { id: 'tbl-1', label: 'Table 1', status: 'seated' },
  { id: 'tbl-2', label: 'Table 2', status: 'seated' },
  { id: 'tbl-3', label: 'Table 3', status: 'seated' },
  { id: 'tbl-4', label: 'Table 4', status: 'needs_assistance' },
  { id: 'tbl-5', label: 'Table 5', status: 'seated' },
  { id: 'tbl-6', label: 'Table 6', status: 'seated' },
  { id: 'tbl-7', label: 'Table 7', status: 'seated' },
  { id: 'tbl-8', label: 'Table 8', status: 'empty' },
  { id: 'tbl-9', label: 'Table 9', status: 'empty' },
];

// --- in-flight + completed orders (timestamps relative to "now") -----------

interface SeedOrderSpec {
  readonly id: string;
  readonly tableId: string;
  readonly status: OrderStatus;
  readonly minutesAgo: number;
  readonly lines: readonly {
    readonly itemId: string;
    readonly qty: number;
    readonly selectedOptions: readonly SelectedOption[];
  }[];
}

const ORDER_SPECS: readonly SeedOrderSpec[] = [
  {
    id: 'ord-seed-1', tableId: 'tbl-1', status: 'cooking', minutesAgo: 18,
    lines: [
      { itemId: 'item-margherita', qty: 2, selectedOptions: [{ groupId: 'size', optionId: 'lg' }] },
      { itemId: 'item-cola', qty: 1, selectedOptions: [{ groupId: 'size', optionId: 'lg' }] },
    ],
  },
  {
    id: 'ord-seed-2', tableId: 'tbl-2', status: 'submitted', minutesAgo: 6,
    lines: [
      { itemId: 'item-burger', qty: 1, selectedOptions: [{ groupId: 'extras', optionId: 'bacon' }, { groupId: 'extras', optionId: 'avocado' }] },
      { itemId: 'item-lemonade', qty: 1, selectedOptions: [] },
    ],
  },
  {
    id: 'ord-seed-3', tableId: 'tbl-3', status: 'ready', minutesAgo: 25,
    lines: [
      { itemId: 'item-curry', qty: 1, selectedOptions: [{ groupId: 'spice', optionId: 'hot' }, { groupId: 'size', optionId: 'lg' }] },
      { itemId: 'item-coffee', qty: 1, selectedOptions: [{ groupId: 'milk', optionId: 'oat' }] },
    ],
  },
  {
    id: 'ord-seed-4', tableId: 'tbl-5', status: 'served', minutesAgo: 70,
    lines: [
      { itemId: 'item-carbonara', qty: 2, selectedOptions: [] },
      { itemId: 'item-tiramisu', qty: 1, selectedOptions: [] },
      { itemId: 'item-cola', qty: 2, selectedOptions: [] },
    ],
  },
  {
    id: 'ord-seed-5', tableId: 'tbl-6', status: 'served', minutesAgo: 110,
    lines: [
      { itemId: 'item-pepperoni', qty: 1, selectedOptions: [{ groupId: 'size', optionId: 'lg' }] },
      { itemId: 'item-salad', qty: 1, selectedOptions: [] },
      { itemId: 'item-gelato', qty: 1, selectedOptions: [] },
      { itemId: 'item-lemonade', qty: 2, selectedOptions: [] },
    ],
  },
];

const MENU_BY_ID = new Map(MENU.map((m) => [m.id, m]));

function buildSeedOrders(now: Date): OrderSeed[] {
  return ORDER_SPECS.map((spec) => {
    const placedAt = new Date(now.getTime() - spec.minutesAgo * 60_000).toISOString();
    const lines = spec.lines.map((l) => {
      const item = MENU_BY_ID.get(l.itemId);
      if (!item) throw new Error(`seed references unknown item ${l.itemId}`);
      return {
        itemId: l.itemId,
        name: item.name,
        qty: l.qty,
        selectedOptions: l.selectedOptions,
        lineTotalCents: priceLine(item, l.selectedOptions, l.qty),
      };
    });
    return { id: spec.id, tableId: spec.tableId, status: spec.status, placedAt, updatedAt: placedAt, lines };
  });
}

/** Wipe + repopulate the database with the demo restaurant. */
export function seedDatabase(db: SqliteDatabase, now: Date = new Date()): void {
  truncateAll(db);
  const store = createStore(db);
  MENU.forEach((item, i) => store.insertMenuItem(item, i));
  TABLES.forEach((table, i) => store.insertTable(table, i));
  for (const order of buildSeedOrders(now)) store.insertSeedOrder(order);
}

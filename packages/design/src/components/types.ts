import type { CSSProperties, ReactNode } from 'react';

/**
 * Base props shared across all component-level (molecule) interfaces.
 *
 * Every component in the design system accepts these for layout
 * integration. `style` is spread last onto the root element, so
 * caller overrides always win.
 */
export interface BaseProps {
  /** Inline styles merged onto the component's root element. Spread last, so these override internal styles. */
  style?: CSSProperties;
  /** CSS class applied to the component's root element. */
  className?: string;
}

// ============================================================================
// Components (Molecules)
// ============================================================================

/**
 * A text input with a leading search icon and optional submit button.
 *
 * Composes: `Input` (native `<input type="search">`), `Button`, `Spinner`, `Icon`.
 *
 * Supports controlled and uncontrolled usage. When `value` is `undefined` the
 * component tracks its own state internally. Pressing **Enter** triggers
 * `onSearch` with the current value. When `loading` is `true` the search icon
 * is replaced by a `Spinner` and the input is disabled.
 *
 * Tokens used: `colors.gray[300]` border, `colors.gray[50]` disabled bg,
 * `colors.gray[400]` icon color, `colors.gray[900]` text color.
 *
 * @example
 * ```tsx
 * <SearchField
 *   value={query}
 *   onChange={setQuery}
 *   onSearch={(q) => fetchResults(q)}
 *   placeholder="Search products..."
 *   showButton
 *   buttonText="Go"
 *   size="md"
 * />
 * ```
 */
export interface SearchFieldProps extends BaseProps {
  /**
   * Current search value. When provided, the component is **controlled**
   * and the caller must update this via `onChange`. When omitted, the
   * component manages its own internal state.
   */
  value?: string;
  /**
   * Called on every keystroke with the new input string (value directly, not
   * a React `ChangeEvent`).
   */
  onChange?: (value: string) => void;
  /**
   * Called when the user presses **Enter** or clicks the search button
   * (if `showButton` is `true`). Receives the current value directly.
   */
  onSearch?: (value: string) => void;
  /**
   * Placeholder text shown when the input is empty.
   * @default 'Search...'
   */
  placeholder?: string;
  /**
   * When `true`, renders a `Button` primitive to the right of the input.
   * The button's label is set by `buttonText`.
   * @default false
   */
  showButton?: boolean;
  /**
   * Label rendered inside the submit button. Only visible when
   * `showButton` is `true`.
   * @default 'Search'
   */
  buttonText?: string;
  /**
   * When `true`, replaces the search icon with a `Spinner`, disables the
   * input, and disables the submit button.
   */
  loading?: boolean;
  /**
   * When `true`, the input and button are visually disabled and do not
   * respond to interaction. The input background changes to `colors.gray[50]`.
   */
  disabled?: boolean;
  /**
   * Controls input height and font size.
   * - `'sm'` -- 6px vertical padding, 14px font
   * - `'md'` -- 10px vertical padding, 14px font
   * - `'lg'` -- 12px vertical padding, 16px font
   *
   * The Button size maps `sm`->`sm`, `md`->`md`, `lg`->`md`.
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
}

/**
 * A wrapper that adds a label, optional description, error message,
 * and helper text around any form input passed as `children`.
 *
 * Composes: no other primitives -- pure layout with semantic `<label>` and
 * `<span>` elements.
 *
 * Visual hierarchy (top to bottom):
 * 1. **Label** (required) -- `fontSize.sm`, `fontWeight.medium`, `colors.gray[700]`
 * 2. **Required indicator** -- red asterisk (`colors.error[500]`) appended to label
 * 3. **Description** -- `fontSize.xs`, `colors.gray[500]`, 4px bottom margin
 * 4. **Children** -- the form control itself
 * 5. **Error / Helper text** -- `fontSize.xs`; error in `colors.error[500]`,
 *    helper in `colors.gray[500]`. Error takes priority when both are provided.
 *
 * @example
 * ```tsx
 * <FormField
 *   label="Email address"
 *   required
 *   description="We will never share your email."
 *   error={errors.email}
 * >
 *   <Input value={email} onChange={setEmail} placeholder="you@example.com" />
 * </FormField>
 * ```
 */
export interface FormFieldProps extends BaseProps {
  /** Text rendered inside the `<label>` element above the input. */
  label: string;
  /** The form control (typically an `Input`, `Select`, or `Textarea` primitive) rendered between the label/description and the error/helper row. */
  children: ReactNode;
  /**
   * Error message displayed below `children` in `colors.error[500]`.
   * When present, it takes precedence over `helperText`.
   */
  error?: string;
  /**
   * Neutral guidance text displayed below `children` in `colors.gray[500]`.
   * Hidden when `error` is present.
   */
  helperText?: string;
  /**
   * When `true`, appends a red asterisk (`*`) after the label text.
   * Does **not** add any HTML validation attributes -- handle that on the
   * child input.
   */
  required?: boolean;
  /**
   * Secondary description rendered between the label and the child control
   * in `fontSize.xs` / `colors.gray[500]`. Use for longer guidance that
   * does not belong in `helperText`.
   */
  description?: string;
}

/**
 * A full-width clickable row for menus, sidebars, and action lists.
 *
 * Composes: none -- renders a native `<button>` element.
 *
 * Built-in transition: `background-color 0.15s` on hover.
 *
 * Color logic:
 * - **Normal**: text `colors.gray[700]`, hover bg `colors.gray[100]`
 * - **Active**: bg `colors.primary[50]`, text `colors.gray[700]`, `fontWeight.medium`
 * - **Danger**: text `colors.error[600]`, hover bg `colors.error[50]`, active bg `colors.error[100]`
 * - **Disabled**: text `colors.gray[400]`, `cursor: not-allowed`
 *
 * Layout: flexbox row with `8px` gap, `8px 12px` padding, `radius.md` border-radius.
 *
 * @example
 * ```tsx
 * <MenuItem
 *   label="Delete project"
 *   icon={<Icon name="trash" size={16} />}
 *   danger
 *   onClick={() => confirmDelete(projectId)}
 * />
 * ```
 */
export interface MenuItemProps extends BaseProps {
  /** Primary text content of the menu item. */
  label: string;
  /** Icon or element rendered to the left of the label. Flex-shrink 0. */
  icon?: ReactNode;
  /**
   * Element rendered to the right of the label (e.g., a keyboard shortcut
   * badge or a count). Colored `colors.gray[400]`, flex-shrink 0.
   */
  rightElement?: ReactNode;
  /** Called when the item is clicked. Suppressed when `disabled` is `true`. */
  onClick?: () => void;
  /**
   * When `true`, the item is non-interactive: `colors.gray[400]` text,
   * `cursor: not-allowed`, click handler suppressed.
   */
  disabled?: boolean;
  /**
   * Marks this item as the current selection. Applies a tinted background
   * (`colors.primary[50]`, or `colors.error[100]` when `danger` is also set)
   * and `fontWeight.medium`.
   */
  active?: boolean;
  /**
   * Switches the item to destructive styling: `colors.error[600]` text,
   * `colors.error[50]` hover background.
   */
  danger?: boolean;
}

/**
 * An inline label for categories, filters, statuses, or selections.
 * Optionally dismissable via a close button.
 *
 * Composes: none -- pure `<span>` with an optional close `<button>`.
 *
 * Each `variant` maps to a background / text / border color triple from the
 * design tokens:
 * - `'default'`  -- `gray[100]` / `gray[700]` / `gray[200]`
 * - `'primary'`  -- `primary[50]` / `primary[700]` / `primary[200]`
 * - `'success'`  -- `success[50]` / `success[700]` / `success[200]`
 * - `'warning'`  -- `warning[50]` / `warning[700]` / `warning[200]`
 * - `'error'`    -- `error[50]` / `error[700]` / `error[200]`
 * - `'info'`     -- `info[50]` / `info[700]` / `info[200]`
 *
 * The close button renders an inline SVG "x" icon (12x12) with `opacity: 0.7`
 * and an `aria-label="Remove"`.
 *
 * @example
 * ```tsx
 * <Tag variant="success" size="md" closable onClose={() => removeFilter(id)}>
 *   Active
 * </Tag>
 * ```
 */
export interface TagProps extends BaseProps {
  /** Tag content -- typically a short text string. */
  children: ReactNode;
  /**
   * Semantic color variant applied to background, text, and border.
   * @default 'default'
   */
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'error' | 'info';
  /**
   * Controls padding, font size, and internal gap.
   * - `'sm'` -- 2px/6px padding, `fontSize.xs`, 4px gap
   * - `'md'` -- 4px/8px padding, `fontSize.xs`, 6px gap
   * - `'lg'` -- 6px/10px padding, `fontSize.sm`, 6px gap
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * When `true`, renders a small close ("x") button after the content.
   * Clicking it fires `onClose`.
   */
  closable?: boolean;
  /**
   * Called when the close button is clicked. Only relevant when
   * `closable` is `true`.
   */
  onClose?: () => void;
  /** Icon or element rendered before the text content. */
  icon?: ReactNode;
}

/**
 * A single option inside a `Dropdown`. Each option maps to one `MenuItem`
 * internally.
 */
export interface DropdownOption {
  /** Unique identifier returned to `onChange` when this option is selected. */
  value: string;
  /** Human-readable text shown in the menu row. */
  label: string;
  /** Optional icon rendered to the left of the label via `MenuItem.icon`. */
  icon?: ReactNode;
  /** When `true`, the option is visible but non-interactive. */
  disabled?: boolean;
  /**
   * When `true`, the option uses destructive (red) styling via
   * `MenuItem.danger`.
   */
  danger?: boolean;
}

/**
 * A click-triggered menu anchored to a trigger element. Manages its own
 * open/close state internally.
 *
 * Composes: `MenuItem` for each option.
 *
 * Behavior:
 * - Clicking the trigger toggles the menu open/closed.
 * - Selecting an option calls `onChange(option.value)` and closes the menu.
 * - Clicking outside the container or pressing **Escape** closes the menu.
 * - The currently selected option (matching `value`) is rendered with
 *   `MenuItem`'s `active` state.
 *
 * Menu panel: `colors.white` bg, `colors.gray[200]` border, `radius.lg`
 * border-radius, `shadow.lg`, `zIndex.dropdown`, 160px min-width, 4px padding.
 *
 * @example
 * ```tsx
 * <Dropdown
 *   trigger={<Button variant="outline">Sort by</Button>}
 *   options={[
 *     { value: 'name', label: 'Name' },
 *     { value: 'date', label: 'Date created' },
 *     { value: 'delete', label: 'Delete', danger: true },
 *   ]}
 *   value={sortBy}
 *   onChange={setSortBy}
 *   placement="bottom-end"
 * />
 * ```
 */
export interface DropdownProps extends BaseProps {
  /**
   * The element the user clicks to open the menu. Receives a wrapping
   * `<div>` with `cursor: pointer` (or `not-allowed` when disabled).
   */
  trigger: ReactNode;
  /** Array of selectable options rendered as `MenuItem` rows. */
  options: DropdownOption[];
  /**
   * The `value` of the currently selected option. The matching
   * `MenuItem` is rendered with `active` styling.
   */
  value?: string;
  /**
   * Called with the `value` string of the selected option (not the full
   * `DropdownOption` object). The menu closes immediately after.
   */
  onChange?: (value: string) => void;
  /**
   * Where to anchor the menu panel relative to the trigger.
   * - `'bottom-start'` -- below, aligned to left edge
   * - `'bottom-end'`   -- below, aligned to right edge
   * - `'top-start'`    -- above, aligned to left edge
   * - `'top-end'`      -- above, aligned to right edge
   * @default 'bottom-start'
   */
  placement?: 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';
  /**
   * When `true`, the trigger shows `cursor: not-allowed` and clicking
   * it does not open the menu.
   */
  disabled?: boolean;
}

/**
 * A single option in the `Autocomplete` suggestion list.
 */
export interface AutocompleteOption {
  /** Unique identifier for this option. Also used for case-insensitive filtering against the input value. */
  value: string;
  /** Primary display text. Also used for case-insensitive filtering and is written into the input on selection. */
  label: string;
  /** Secondary description rendered below the label in `fontSize.xs` / `colors.gray[500]`. */
  description?: string;
  /** Icon rendered to the left of the label/description block. Flex-shrink 0. */
  icon?: ReactNode;
  /** When `true`, the option is visible but non-interactive (`cursor: not-allowed`, `colors.gray[400]` text). */
  disabled?: boolean;
}

/**
 * A text input with a filterable suggestion dropdown, keyboard navigation,
 * and loading/empty states.
 *
 * Composes: `Input` primitive (with `label`, `error`, `placeholder` forwarded),
 * `Spinner` (loading state).
 *
 * Filtering: options are filtered client-side by case-insensitive substring
 * match against both `option.label` and `option.value`.
 *
 * Keyboard support:
 * - **ArrowDown / ArrowUp** -- move highlight through filtered options
 *   (opens dropdown if closed)
 * - **Enter** -- selects the highlighted option
 * - **Escape** -- closes the dropdown
 *
 * On selection, `onChange` is called with `option.label` (the display text)
 * and `onSelect` is called with the full `AutocompleteOption` object.
 *
 * Dropdown panel: `colors.white` bg, `colors.gray[200]` border, `radius.lg`
 * border-radius, `shadow.lg`, `zIndex.dropdown`, max-height 240px with
 * overflow scroll.
 *
 * @example
 * ```tsx
 * <Autocomplete
 *   label="Country"
 *   value={country}
 *   onChange={setCountry}
 *   onSelect={(opt) => setCountryCode(opt.value)}
 *   options={countries}
 *   placeholder="Type to search..."
 *   noResultsText="No countries found"
 * />
 * ```
 */
export interface AutocompleteProps extends BaseProps {
  /**
   * Current text in the input field. On selection, this is set to the
   * selected option's `label`.
   * @default ''
   */
  value?: string;
  /**
   * Called on every keystroke with the new input string (value directly,
   * not a React event). Also called on selection with `option.label`.
   */
  onChange?: (value: string) => void;
  /**
   * Called when the user selects an option (click or Enter on highlighted
   * item). Receives the full `AutocompleteOption` object, not just the value
   * string.
   */
  onSelect?: (option: AutocompleteOption) => void;
  /**
   * The full list of available options. Filtering is handled internally
   * via case-insensitive substring match on `label` and `value`.
   */
  options: AutocompleteOption[];
  /** Placeholder text forwarded to the inner `Input` primitive. */
  placeholder?: string;
  /** Label text forwarded to the inner `Input` primitive. */
  label?: string;
  /**
   * When `true`, the dropdown shows a centered `Spinner` instead of
   * the option list. The input remains interactive.
   */
  loading?: boolean;
  /**
   * When `true`, the inner `Input` is disabled and the dropdown
   * does not open.
   */
  disabled?: boolean;
  /** Error message forwarded to the inner `Input` primitive. */
  error?: string;
  /**
   * Text shown in the dropdown when filtering produces zero matches.
   * Rendered centered in `colors.gray[500]` / `fontSize.sm`.
   * @default 'No results found'
   */
  noResultsText?: string;
}

/**
 * A single segment in a `Breadcrumb` trail. Items with `href` render as
 * `Link` primitives; items without render as plain `<button>` elements.
 * The last item in the array is always rendered as static text with
 * `aria-current="page"`.
 */
export interface BreadcrumbItem {
  /** Display text for this breadcrumb segment. */
  label: string;
  /**
   * URL for this segment. When provided (and this is not the last item),
   * the segment renders as a `Link` primitive with `underline="hover"`.
   * When omitted, it renders as a `<button>`.
   */
  href?: string;
  /**
   * Icon rendered immediately before the label. Its color follows the
   * segment's text color: `colors.gray[500]` for navigable items,
   * `colors.gray[900]` for the current (last) item.
   */
  icon?: ReactNode;
}

/**
 * A horizontal navigation trail showing the user's location within a
 * hierarchy. Renders a `<nav aria-label="Breadcrumb">`.
 *
 * Composes: `Link` primitive (for items with `href`).
 *
 * Rendering rules per item:
 * - **Last item**: static `<span>` with `colors.gray[900]`, `fontWeight: 500`,
 *   and `aria-current="page"`.
 * - **Non-last with `href`**: `Link` in `colors.gray[500]` with
 *   `underline="hover"`. If `onItemClick` is provided, `e.preventDefault()`
 *   is called and the handler fires instead of navigating.
 * - **Non-last without `href`**: unstyled `<button>` in `colors.gray[500]`.
 *
 * Layout: flexbox row, `8px` gap, `fontSize.sm`.
 *
 * @example
 * ```tsx
 * <Breadcrumb
 *   items={[
 *     { label: 'Home', href: '/' },
 *     { label: 'Projects', href: '/projects' },
 *     { label: 'ggui' },
 *   ]}
 *   separator="/"
 *   onItemClick={(item) => router.push(item.href!)}
 * />
 * ```
 */
export interface BreadcrumbProps extends BaseProps {
  /** Ordered array of breadcrumb segments from root to current page. */
  items: BreadcrumbItem[];
  /**
   * Separator rendered between each pair of items. Can be a string
   * (e.g., `"/"`, `">"`) or a ReactNode (e.g., an `Icon`). Rendered
   * in `colors.gray[400]`.
   * @default '/'
   */
  separator?: ReactNode;
  /**
   * Called when a non-last item is clicked. Receives the `BreadcrumbItem`
   * and its zero-based `index`. When provided on items that have `href`,
   * the default navigation is prevented via `e.preventDefault()`.
   */
  onItemClick?: (item: BreadcrumbItem, index: number) => void;
}

/**
 * Page navigation controls with previous/next arrows, numbered page buttons,
 * and optional first/last jumps. Renders a `<nav aria-label="Pagination">`.
 *
 * Composes: `Button` (ghost variant for prev/next/first/last arrows),
 * `Icon` (`chevron-left`, `chevron-right`).
 *
 * Built-in transition: `all 0.15s` on page number buttons.
 *
 * Page windowing: when `totalPages > maxVisible`, the component shows the
 * first page, last page, a window of pages around `currentPage`, and
 * ellipsis ("...") markers for gaps. The window adjusts when near the
 * start or end of the range.
 *
 * Active page button: `colors.primary[600]` bg, `colors.white` text,
 * `fontWeight.medium`. Inactive: transparent bg, `colors.gray[700]` text.
 *
 * Arrow buttons are automatically disabled at boundary pages (first/last).
 *
 * @example
 * ```tsx
 * <Pagination
 *   currentPage={page}
 *   totalPages={20}
 *   onPageChange={setPage}
 *   maxVisible={7}
 *   size="md"
 * />
 * ```
 */
export interface PaginationProps extends BaseProps {
  /** Current active page. **1-indexed** (first page is `1`). */
  currentPage: number;
  /** Total number of pages. Determines when last-page / next-page buttons disable. */
  totalPages: number;
  /**
   * Called when the user clicks a page number, arrow, or first/last button.
   * Receives the target page number (1-indexed) directly.
   */
  onPageChange?: (page: number) => void;
  /**
   * When `true`, renders double-chevron buttons for jumping to the first
   * and last page. These buttons are disabled when already on the
   * respective boundary.
   * @default true
   */
  showFirstLast?: boolean;
  /**
   * Maximum number of page buttons visible at once (including the first
   * and last page, but excluding ellipsis markers). When `totalPages`
   * exceeds this value, ellipsis gaps appear.
   * @default 5
   */
  maxVisible?: number;
  /**
   * Controls button dimensions and icon sizes.
   * - `'sm'` -- 28px buttons, 14px icons, Button size `xs`
   * - `'md'` -- 32px buttons, 16px icons, Button size `sm`
   * - `'lg'` -- 40px buttons, 20px icons, Button size `md`
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * When `true`, all page buttons and arrows are visually dimmed
   * (`opacity: 0.5`) and clicks are suppressed.
   */
  disabled?: boolean;
}

/**
 * EmptyState -- placeholder for a region with no data: empty lists,
 * zero search results, an error fallback. Render it instead of
 * nothing whenever a data array could be empty — a list that shows
 * nothing when empty looks broken.
 *
 * @example
 * {results.length === 0
 *   ? <EmptyState icon="search-x" title="No matches" description="Try a broader query." />
 *   : results.map((r) => <Row key={r.id}>…</Row>)}
 */
export interface EmptyStateProps extends BaseProps {
  /**
   * A Lucide icon name (kebab-case), rendered large and subtle above
   * the title, or a custom node. Omit for a text-only empty state.
   */
  icon?: string | ReactNode;
  /** The headline, e.g. "No results found". */
  title: string;
  /** Optional supporting line below the title. */
  description?: string;
  /** Optional call-to-action, typically a `<Button>`. */
  action?: ReactNode;
}

/**
 * Stat -- a single KPI / metric: a label, a large value, an optional
 * trend-coloured delta and icon. Reach for it whenever the UI is
 * "show a number" — dashboards, weather and price cards, analytics
 * tiles. Drop several into a `<Grid>` for a stat grid.
 *
 * @example
 * <Stat label="Revenue" value="$48.2k" delta="+12.5%" trend="up" icon="trending-up" />
 */
export interface StatProps extends BaseProps {
  /**
   * The metric name, e.g. "Revenue". Rendered small and uppercase
   * above the value.
   */
  label: string;
  /**
   * The headline value — the big number. A number, or a pre-formatted
   * string (`"$48.2k"`, `"18°C"`).
   */
  value: string | number;
  /** Optional change indicator, pre-formatted, e.g. `"+12.5%"` or `"-3"`. */
  delta?: string;
  /**
   * Direction of `delta` — colours it: `'up'` success, `'down'` error,
   * `'neutral'` muted.
   * @default 'neutral'
   */
  trend?: 'up' | 'down' | 'neutral';
  /**
   * Optional Lucide icon name (kebab-case) or custom node, shown next
   * to the label.
   */
  icon?: string | ReactNode;
}

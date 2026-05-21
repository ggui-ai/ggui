import type { CSSProperties, ReactNode } from 'react';

/**
 * Base props shared across all composition components.
 *
 * Every composition extends `BaseProps` to accept inline styles and a CSS class name
 * for host-element customization without breaking internal layout.
 */
export interface BaseProps {
  /** Inline style object applied to the composition's root element. */
  style?: CSSProperties;
  /** CSS class name applied to the composition's root element. */
  className?: string;
}

// ============================================================================
// Compositions (Organisms)
// ============================================================================

/**
 * Props for the `Header` composition.
 *
 * A horizontal page header that arranges a logo, navigation, and action slots
 * in a flex row (`justify-content: space-between`). Internally renders a `<header>` element;
 * does not compose other ggui primitives.
 *
 * When `sticky` is true the header gets `position: sticky; top: 0` with `zIndex.sticky`
 * and a `shadow.sm` box-shadow.
 *
 * @example
 * ```tsx
 * <Header
 *   logo={<img src="/logo.svg" alt="Acme" />}
 *   navigation={<a href="/docs">Docs</a>}
 *   actions={<Button size="sm">Sign In</Button>}
 *   sticky
 *   bordered
 * />
 * ```
 */
export interface HeaderProps extends BaseProps {
  /** Logo or brand element rendered at the start (flex-shrink: 0). */
  logo?: ReactNode;
  /** Navigation content rendered in a `<nav>` element with `flex: 1` and a 32 px left margin. */
  navigation?: ReactNode;
  /** Right-side action elements (buttons, avatar, etc.) rendered with a 12 px gap. */
  actions?: ReactNode;
  /**
   * When true, the header becomes `position: sticky` at the top of its scroll container
   * with `zIndex.sticky` and `shadow.sm`.
   * @default false
   */
  sticky?: boolean;
  /**
   * Background color of the header.
   * @default colors.white
   */
  background?: string;
  /**
   * When true, renders a 1 px bottom border in `colors.gray[200]`.
   * @default true
   */
  bordered?: boolean;
}

/**
 * A single navigation entry in a `Sidebar`. Supports nested children for
 * collapsible sub-menus and an optional badge slot.
 */
export interface SidebarItem {
  /** Unique identifier used for active-state matching and React keys. */
  id: string;
  /** Display label for the item. Hidden when the sidebar is collapsed. */
  label: string;
  /** Leading icon rendered before the label. Remains visible when collapsed. */
  icon?: ReactNode;
  /** Optional URL associated with this item (not rendered as a link by default). */
  href?: string;
  /** Trailing badge element (e.g., unread count). Hidden when collapsed. */
  badge?: ReactNode;
  /** Nested child items. When present, the item acts as a collapsible section (chevron indicator shown). */
  children?: SidebarItem[];
  /** When true, the item is visually dimmed and non-interactive (`cursor: not-allowed`). */
  disabled?: boolean;
}

/**
 * Props for the `Sidebar` composition.
 *
 * A vertical navigation panel that composes the `Icon` primitive for chevron indicators.
 * Items are rendered as `<button>` elements inside a scrollable `<nav>`. Nested items
 * are indented 16 px per depth level. The sidebar animates width changes with a 200 ms
 * CSS transition. Active items are highlighted with `colors.primary[50]` background
 * and `colors.primary[700]` text.
 *
 * @example
 * ```tsx
 * <Sidebar
 *   items={[
 *     { id: 'home', label: 'Home', icon: <Icon name="home" /> },
 *     { id: 'settings', label: 'Settings', icon: <Icon name="settings" />,
 *       children: [
 *         { id: 'profile', label: 'Profile' },
 *         { id: 'billing', label: 'Billing' },
 *       ]},
 *   ]}
 *   activeId="home"
 *   onItemClick={(item) => navigate(item.href)}
 *   collapsed={false}
 *   width={256}
 * />
 * ```
 */
export interface SidebarProps extends BaseProps {
  /** Array of navigation items to render. */
  items: SidebarItem[];
  /** ID of the currently active item. Matched items get a highlighted background and bold text. */
  activeId?: string;
  /** Called when any item (including parent items with children) is clicked. */
  onItemClick?: (item: SidebarItem) => void;
  /**
   * When true, hides labels and badges; only icons remain visible, centered in the collapsed width.
   * Nested children are hidden entirely.
   * @default false
   */
  collapsed?: boolean;
  /** Content rendered above the item list, separated by a bottom border. */
  header?: ReactNode;
  /** Content rendered below the item list, separated by a top border. */
  footer?: ReactNode;
  /**
   * Width in pixels when expanded.
   * @default 256
   */
  width?: number;
  /**
   * Width in pixels when collapsed.
   * @default 64
   */
  collapsedWidth?: number;
}

/**
 * Props for the `CardGrid` composition.
 *
 * A CSS Grid wrapper that arranges children in equal-width columns. When `columns`
 * is a number, it produces `repeat(N, 1fr)`. When it is a responsive object,
 * it falls back to `repeat(auto-fit, minmax(280px, 1fr))` for fluid responsive behavior.
 *
 * Does not compose any ggui primitives internally — it is a pure layout container.
 *
 * @example
 * ```tsx
 * <CardGrid columns={3} gap={24}>
 *   <Card>A</Card>
 *   <Card>B</Card>
 *   <Card>C</Card>
 * </CardGrid>
 * ```
 */
export interface CardGridProps extends BaseProps {
  /** Card elements to arrange in the grid. */
  children: ReactNode;
  /**
   * Number of columns, or a responsive breakpoint map.
   *
   * - `number` — fixed column count via `repeat(N, 1fr)`.
   * - `{ sm?, md?, lg? }` — triggers `repeat(auto-fit, minmax(280px, 1fr))` for fluid layout.
   * @default 3
   */
  columns?: number | { sm?: number; md?: number; lg?: number };
  /**
   * Gap between grid items in pixels.
   * @default 16
   */
  gap?: number;
}

/**
 * A single comment entry in a `CommentThread`. Supports nested replies
 * and emoji reactions with counts.
 */
export interface Comment {
  /** Unique identifier for this comment. */
  id: string;
  /** Comment author metadata. */
  author: {
    /** Display name of the author. */
    name: string;
    /** URL for the author's avatar image. Passed to the `Avatar` primitive. */
    avatar?: string;
  };
  /** The comment body text. */
  content: string;
  /** Timestamp of the comment. Rendered via `toLocaleString()` when a `Date` object. */
  timestamp: string | Date;
  /** Nested reply comments. Each reply is rendered indented 40 px deeper. */
  replies?: Comment[];
  /** Emoji reactions with their aggregated counts (e.g., `{ emoji: "👍", count: 3 }`). */
  reactions?: { emoji: string; count: number }[];
}

/**
 * Props for the `CommentThread` composition.
 *
 * A threaded comment section that composes `Avatar`, `Button`, `TextArea`, and `Spinner`
 * primitives. Comments are rendered recursively with 40 px indentation per nesting level.
 * Each comment shows author avatar, name, timestamp, content, reactions, and a "Reply" toggle.
 * When `currentUser` is provided, a new-comment input with avatar and submit button is shown
 * above the thread.
 *
 * @example
 * ```tsx
 * <CommentThread
 *   comments={[
 *     { id: '1', author: { name: 'Alice' }, content: 'Great work!', timestamp: new Date(),
 *       replies: [{ id: '2', author: { name: 'Bob' }, content: 'Thanks!', timestamp: new Date() }] }
 *   ]}
 *   currentUser={{ name: 'Alice', avatar: '/alice.jpg' }}
 *   onAddComment={(content) => post(content)}
 *   onReply={(commentId, content) => reply(commentId, content)}
 *   onReaction={(commentId, emoji) => react(commentId, emoji)}
 * />
 * ```
 */
export interface CommentThreadProps extends BaseProps {
  /** Array of top-level comments to render. Replies are nested within each comment. */
  comments: Comment[];
  /** Current user info. When provided, a new-comment input area is rendered above the thread. */
  currentUser?: {
    /** Display name for the current user's avatar. */
    name: string;
    /** Avatar image URL for the current user. */
    avatar?: string;
  };
  /**
   * Called when the user submits a new top-level comment.
   * @param content - The comment text.
   * @param parentId - Optional parent comment ID (unused at top level).
   */
  onAddComment?: (content: string, parentId?: string) => void;
  /**
   * Called when the user submits a reply to an existing comment.
   * @param commentId - The ID of the comment being replied to.
   * @param content - The reply text.
   */
  onReply?: (commentId: string, content: string) => void;
  /**
   * Called when the user clicks an emoji reaction on a comment.
   * @param commentId - The ID of the comment.
   * @param emoji - The emoji string that was clicked.
   */
  onReaction?: (commentId: string, emoji: string) => void;
  /** When true, shows a centered `Spinner` instead of the comment list. */
  loading?: boolean;
}

/**
 * Column definition for a `DataTable`. Controls header text, width, alignment,
 * sorting, and custom cell rendering.
 *
 * @typeParam T - The row data type.
 */
export interface DataTableColumn<T = Record<string, unknown>> {
  /** Property key on the row object used to extract cell values. Also serves as the sort key. */
  key: string;
  /** Column header text displayed in the `<thead>`. */
  header: string;
  /** Column width as a CSS value (number for pixels, string for any CSS unit). */
  width?: number | string;
  /** When true, the column header is clickable and triggers `onSort`. An arrow icon indicates direction. */
  sortable?: boolean;
  /**
   * Custom cell renderer. When omitted, the raw value is stringified via `String()`.
   * @param value - The cell value (`row[key]`).
   * @param row - The full row object.
   * @param index - The row index.
   */
  render?: (value: unknown, row: T, index: number) => ReactNode;
  /**
   * Text alignment for both header and body cells.
   * @default 'left'
   */
  align?: 'left' | 'center' | 'right';
}

/**
 * Props for the `DataTable` composition.
 *
 * A sortable, selectable data table that composes `Checkbox`, `Spinner`, and `Icon`
 * primitives. Renders a `<table>` inside a bordered container with 8 px border-radius.
 * The header row has a `colors.gray[50]` background. Sortable columns show a chevron
 * icon on click (toggles asc/desc). Selected rows are highlighted with `colors.primary[50]`.
 * Row background transitions use a 150 ms ease. The "select all" checkbox supports an
 * indeterminate state when a subset of rows is selected.
 *
 * @typeParam T - The row data type (must extend `Record<string, unknown>`).
 *
 * @example
 * ```tsx
 * <DataTable
 *   columns={[
 *     { key: 'name', header: 'Name', sortable: true },
 *     { key: 'email', header: 'Email' },
 *     { key: 'role', header: 'Role', render: (v) => <Badge>{v}</Badge> },
 *   ]}
 *   data={users}
 *   rowKey="id"
 *   selectable
 *   selectedKeys={selected}
 *   onSelectionChange={setSelected}
 *   onSort={(key, dir) => sort(key, dir)}
 *   sortKey="name"
 *   sortDirection="asc"
 * />
 * ```
 */
export interface DataTableProps<T = Record<string, unknown>> extends BaseProps {
  /** Column definitions that control header, alignment, sorting, and rendering. */
  columns: DataTableColumn<T>[];
  /** Row data array. Each entry corresponds to one table row. */
  data: T[];
  /**
   * Property name or function used to derive a unique key for each row.
   * @default 'id'
   */
  rowKey?: string | ((row: T) => string);
  /** When true, shows a centered `Spinner` instead of table body rows. */
  loading?: boolean;
  /**
   * Text shown when `data` is empty and not loading.
   * @default 'No data'
   */
  emptyText?: string;
  /**
   * Called when a sortable column header is clicked. Toggles direction automatically
   * (asc -> desc) if the same column is clicked again.
   * @param key - The column key.
   * @param direction - The new sort direction.
   */
  onSort?: (key: string, direction: 'asc' | 'desc') => void;
  /** The column key currently being sorted. */
  sortKey?: string;
  /** The current sort direction. */
  sortDirection?: 'asc' | 'desc';
  /**
   * Called when a row is clicked. Rows get `cursor: pointer` when this handler is provided.
   * @param row - The clicked row data.
   * @param index - The row index.
   */
  onRowClick?: (row: T, index: number) => void;
  /** When true, adds a checkbox column at the start of each row. */
  selectable?: boolean;
  /**
   * Array of currently selected row keys.
   * @default []
   */
  selectedKeys?: string[];
  /**
   * Called when the set of selected row keys changes (via row checkbox or select-all).
   * @param keys - The updated array of selected row keys.
   */
  onSelectionChange?: (keys: string[]) => void;
}

/**
 * A single message in a `ChatWindow`. Includes sender metadata, delivery status,
 * and a timestamp.
 */
export interface ChatMessage {
  /** Unique identifier for this message. */
  id: string;
  /** The message body text. */
  content: string;
  /** Sender metadata used for avatar rendering and alignment. */
  sender: {
    /** Unique ID of the sender. Compared to `currentUserId` to determine alignment. */
    id: string;
    /** Display name of the sender. */
    name: string;
    /** Avatar image URL. Only shown for non-current-user messages (xs size). */
    avatar?: string;
  };
  /** Message timestamp. Rendered as `HH:MM` via `toLocaleTimeString` when a `Date` object. */
  timestamp: string | Date;
  /**
   * Delivery status indicator shown on the current user's messages.
   * - `'sending'` — shows a dot bullet
   * - `'sent'` — shows a single checkmark
   * - `'delivered'` — shows double checkmarks
   * - `'read'` — shows double checkmarks (same visual as delivered)
   * - `'error'` — shows an exclamation mark
   */
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'error';
}

/**
 * Props for the `ChatWindow` composition.
 *
 * A messaging interface that composes `Avatar`, `Button`, `Spinner`, and `Icon` primitives.
 * Layout is a flex column filling 100% height with a bordered `radius.lg` container.
 * Messages from the current user align right with `colors.primary[600]` bubbles and white text.
 * Other users' messages align left with `colors.gray[100]` bubbles. The message area
 * auto-scrolls to the bottom on new messages via `scrollIntoView({ behavior: 'smooth' })`.
 * The text input sends on Enter (Shift+Enter for newline).
 *
 * @example
 * ```tsx
 * <ChatWindow
 *   messages={messages}
 *   currentUserId="user-1"
 *   onSendMessage={(content) => send(content)}
 *   typing={{ name: 'Alice' }}
 *   placeholder="Type a message..."
 *   header={<h3>Chat with Alice</h3>}
 * />
 * ```
 */
export interface ChatWindowProps extends BaseProps {
  /** Array of chat messages to display in chronological order. */
  messages: ChatMessage[];
  /** ID of the current user. Messages from this user render right-aligned with a primary color bubble. */
  currentUserId: string;
  /**
   * Called when the user submits a message (Enter key or send button).
   * @param content - The message text.
   */
  onSendMessage?: (content: string) => void;
  /** When true, shows a centered `Spinner` instead of the message list. */
  loading?: boolean;
  /** When non-null, displays a typing indicator below the last message (e.g., "Alice is typing..."). */
  typing?: { name: string } | null;
  /**
   * Placeholder text for the message input field.
   * @default 'Type a message...'
   */
  placeholder?: string;
  /** Optional header content rendered above the message area, separated by a bottom border. */
  header?: ReactNode;
}

/**
 * A single navigation entry in a `NavigationBar`. Supports nested children
 * for sub-menus (rendered by the parent via dropdown, not built-in).
 */
export interface NavItem {
  /** Unique identifier used for active-state matching and React keys. */
  id: string;
  /** Display label for the navigation link. */
  label: string;
  /** URL for the item. When provided, renders an `<a>` element instead of `<button>`. */
  href?: string;
  /** Optional icon rendered before the label. */
  icon?: ReactNode;
  /** Nested child items (for sub-menu structures; rendering is consumer-defined). */
  children?: NavItem[];
  /** When true, the item is visually dimmed (opacity 0.5) and non-interactive. */
  disabled?: boolean;
}

/**
 * Props for the `NavigationBar` composition.
 *
 * A horizontal or vertical navigation menu. Does not compose other ggui primitives
 * (uses plain `<button>` and `<a>` elements). Active items are styled per variant:
 *
 * - `'default'` — active item gets `colors.primary[600]` text and medium font weight.
 * - `'pills'` — active item gets a `radius.full` pill with `colors.primary[100]` background.
 * - `'underline'` — active item gets a 2 px bottom border in `colors.primary[600]`.
 *   When horizontal, the entire nav also has a 1 px bottom border.
 *
 * All items have a 150 ms transition on all properties.
 *
 * @example
 * ```tsx
 * <NavigationBar
 *   items={[
 *     { id: 'home', label: 'Home', icon: <Icon name="home" /> },
 *     { id: 'about', label: 'About' },
 *     { id: 'contact', label: 'Contact' },
 *   ]}
 *   activeId="home"
 *   onItemClick={(item) => navigate(item.id)}
 *   orientation="horizontal"
 *   variant="pills"
 * />
 * ```
 */
export interface NavigationBarProps extends BaseProps {
  /** Array of navigation items to render. */
  items: NavItem[];
  /** ID of the currently active item. Controls visual highlighting per variant style. */
  activeId?: string;
  /** Called when a non-disabled item is clicked. For `<a>` elements, `preventDefault` is called first. */
  onItemClick?: (item: NavItem) => void;
  /**
   * Layout direction.
   * - `'horizontal'` — flex-row with 4 px gap.
   * - `'vertical'` — flex-column with 2 px gap.
   * @default 'horizontal'
   */
  orientation?: 'horizontal' | 'vertical';
  /**
   * Visual style for active/inactive items.
   * - `'default'` — text color change only.
   * - `'pills'` — rounded pill background on active items.
   * - `'underline'` — bottom border on active items.
   * @default 'default'
   */
  variant?: 'default' | 'pills' | 'underline';
}

/**
 * A file entry in the `FileUploader` composition. Tracks upload progress,
 * status, and optional error messages.
 */
export interface UploadedFile {
  /** Unique identifier for this file entry. Used as a key and for removal callbacks. */
  id: string;
  /** Original file name. Rendered with text-overflow ellipsis when too long. */
  name: string;
  /** File size in bytes. Formatted as B/KB/MB/GB for display. */
  size: number;
  /** MIME type of the file (e.g., `'image/png'`). */
  type: string;
  /** Upload progress as a percentage (0-100). Shown via the `Progress` primitive when status is `'uploading'`. */
  progress?: number;
  /**
   * Current upload lifecycle status.
   * - `'pending'` — file selected but upload not started.
   * - `'uploading'` — upload in progress; `progress` bar is shown.
   * - `'success'` — upload completed.
   * - `'error'` — upload failed; `error` message is shown in `colors.error[500]`.
   */
  status: 'pending' | 'uploading' | 'success' | 'error';
  /** Error message displayed when status is `'error'`. */
  error?: string;
  /** The remote URL of the uploaded file after successful upload. */
  url?: string;
}

/**
 * Props for the `FileUploader` composition.
 *
 * A drag-and-drop file upload area that composes `Button`, `Progress`, and `Icon` primitives.
 * The drop zone is a dashed-border container that highlights in `colors.primary[400]`/`colors.primary[50]`
 * on drag-over. Below the drop zone, each file in `files` is listed with its name, size,
 * optional progress bar (for uploading status), and a remove button.
 *
 * File validation (max size, max count) is applied client-side before calling `onFilesSelected`.
 * Files exceeding `maxSize` are silently filtered out; files exceeding `maxFiles` are truncated.
 *
 * @example
 * ```tsx
 * <FileUploader
 *   files={uploadedFiles}
 *   onFilesSelected={(files) => startUpload(files)}
 *   onFileRemove={(id) => removeFile(id)}
 *   accept="image/*,.pdf"
 *   multiple
 *   maxSize={5 * 1024 * 1024}
 *   maxFiles={10}
 *   dragDrop
 * />
 * ```
 */
export interface FileUploaderProps extends BaseProps {
  /**
   * Array of files currently in the upload queue, shown below the drop zone.
   * @default []
   */
  files?: UploadedFile[];
  /**
   * Called when the user selects files via click or drag-and-drop. Receives native `File` objects
   * after client-side filtering (maxSize, maxFiles).
   */
  onFilesSelected?: (files: File[]) => void;
  /**
   * Called when the user clicks the remove button on a file entry.
   * @param fileId - The `id` of the file to remove.
   */
  onFileRemove?: (fileId: string) => void;
  /** Accepted file types passed to the hidden `<input type="file" accept="...">`. E.g., `'image/*,.pdf'`. */
  accept?: string;
  /**
   * When true, allows selecting multiple files at once.
   * @default true
   */
  multiple?: boolean;
  /** Maximum file size in bytes. Files exceeding this are silently excluded from the selection. */
  maxSize?: number;
  /** Maximum number of files. Excess files beyond `maxFiles - files.length` are truncated. */
  maxFiles?: number;
  /** When true, the drop zone is visually dimmed (opacity 0.5) and non-interactive. */
  disabled?: boolean;
  /**
   * When true, enables drag-and-drop on the drop zone. When false, the prompt text
   * changes to "Click to browse files".
   * @default true
   */
  dragDrop?: boolean;
}

/**
 * Props for the `UserProfileCard` composition.
 *
 * A profile display card that composes `Avatar` and `Card` primitives.
 * Has two layout modes:
 *
 * - **Default** — full card with optional cover image (120 px tall, `background-size: cover`),
 *   an XL avatar overlapping the cover by -40 px, centered name, subtitle, bio, stats row
 *   (separated by a top border), and action buttons.
 * - **Compact** (`compact: true`) — horizontal layout with a MD avatar, name, subtitle,
 *   and inline actions. No cover image, bio, or stats.
 *
 * @example
 * ```tsx
 * <UserProfileCard
 *   name="Jane Doe"
 *   subtitle="Product Designer"
 *   avatar="/jane.jpg"
 *   coverImage="/cover.jpg"
 *   bio="Designing interfaces that delight users."
 *   stats={[
 *     { label: 'Followers', value: '1.2k' },
 *     { label: 'Posts', value: 48 },
 *   ]}
 *   actions={<Button>Follow</Button>}
 * />
 * ```
 */
export interface UserProfileCardProps extends BaseProps {
  /** User's display name. Rendered as semibold text (lg size in default, sm in compact). */
  name: string;
  /** Secondary text below the name (e.g., email, job title). */
  subtitle?: string;
  /** Avatar image URL passed to the `Avatar` primitive. Falls back to initials if omitted. */
  avatar?: string;
  /** Cover image URL rendered as a 120 px tall background banner above the avatar. Ignored in compact mode. */
  coverImage?: string;
  /** Bio or description paragraph shown below the subtitle. Ignored in compact mode. */
  bio?: string;
  /** Key-value stat pairs (e.g., followers, posts) shown in a horizontal row below the bio. Ignored in compact mode. */
  stats?: { label: string; value: string | number }[];
  /** Action elements (buttons, links) rendered at the bottom (centered in default, inline in compact). */
  actions?: ReactNode;
  /**
   * When true, renders a horizontal compact layout (avatar + name inline) without cover image,
   * bio, or stats.
   * @default false
   */
  compact?: boolean;
}

/**
 * A single notification entry in the `NotificationCenter`. Supports semantic type coloring,
 * read state, and an optional inline action button.
 */
export interface Notification {
  /** Unique identifier for this notification. */
  id: string;
  /** Notification title rendered in medium weight. */
  title: string;
  /** Optional body text rendered below the title in a smaller font. */
  message?: string;
  /** Timestamp of the notification. Rendered via `toLocaleString()` when a `Date` object. */
  timestamp: string | Date;
  /**
   * Read state. Unread notifications get a `colors.primary[50]` background and a colored
   * status dot matching the notification type.
   * @default false
   */
  read?: boolean;
  /**
   * Semantic type that controls the status dot color on unread notifications.
   * - `'info'` — `colors.info[500]` (blue)
   * - `'success'` — `colors.success[500]` (green)
   * - `'warning'` — `colors.warning[500]` (amber)
   * - `'error'` — `colors.error[500]` (red)
   * @default 'info'
   */
  type?: 'info' | 'success' | 'warning' | 'error';
  /** Optional icon rendered alongside the notification (not used by the default implementation). */
  icon?: ReactNode;
  /** Optional inline action button rendered next to the timestamp. */
  action?: {
    /** Button label text. */
    label: string;
    /** Click handler for the action. */
    onClick: () => void;
  };
}

/**
 * Props for the `NotificationCenter` composition.
 *
 * A notification list with a header bar that composes `Button`, `Spinner`, and `Icon`
 * primitives. The header shows a "Notifications" title, an unread count badge
 * (pill in `colors.primary[100]`), and "Mark all read" / "Clear all" buttons.
 * Each notification item shows a colored status dot, title, message, timestamp,
 * "Mark as read" link, and optional action. The list is scrollable (`overflowY: auto`).
 *
 * @example
 * ```tsx
 * <NotificationCenter
 *   notifications={[
 *     { id: '1', title: 'Deployment complete', type: 'success', timestamp: new Date(), read: false },
 *     { id: '2', title: 'Build failed', type: 'error', message: 'Lint errors', timestamp: new Date() },
 *   ]}
 *   onMarkAsRead={(id) => markRead(id)}
 *   onMarkAllAsRead={() => markAllRead()}
 *   onDismiss={(id) => dismiss(id)}
 *   onClearAll={() => clearAll()}
 * />
 * ```
 */
export interface NotificationCenterProps extends BaseProps {
  /** Array of notifications to display, in the order provided. */
  notifications: Notification[];
  /**
   * Called when the user clicks "Mark as read" on an individual notification.
   * @param id - The notification ID.
   */
  onMarkAsRead?: (id: string) => void;
  /** Called when the user clicks the "Mark all read" header button. Only shown when there are unread items. */
  onMarkAllAsRead?: () => void;
  /**
   * Called when the user clicks the dismiss (X) button on an individual notification.
   * @param id - The notification ID.
   */
  onDismiss?: (id: string) => void;
  /** Called when the user clicks the "Clear all" header button. Only shown when there are any notifications. */
  onClearAll?: () => void;
  /**
   * Text shown when `notifications` is empty and not loading.
   * @default 'No notifications'
   */
  emptyText?: string;
  /** When true, shows a centered `Spinner` instead of the notification list. */
  loading?: boolean;
}

/**
 * Props for the `Modal` composition.
 *
 * A dialog overlay that composes `Button`, `Icon`, and `Heading` primitives.
 * The overlay uses `animation.fadeIn` (`ggui-fadeIn`) and the dialog panel uses
 * `animation.scaleIn` (`ggui-scaleIn`) — both GPU-composited (opacity + transform).
 * When open, `document.body.style.overflow` is set to `'hidden'` to prevent background
 * scrolling, and restored on close. The dialog has `role="dialog"` and `aria-modal="true"`.
 *
 * Size widths: `sm` = 400 px, `md` = 500 px, `lg` = 640 px, `xl` = 800 px,
 * `full` = 100vw (no border-radius, no padding).
 *
 * @example
 * ```tsx
 * <Modal
 *   open={isOpen}
 *   onClose={() => setOpen(false)}
 *   title="Confirm Action"
 *   size="md"
 *   footer={
 *     <>
 *       <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
 *       <Button onClick={handleConfirm}>Confirm</Button>
 *     </>
 *   }
 * >
 *   <p>Are you sure you want to proceed?</p>
 * </Modal>
 * ```
 */
export interface ModalProps extends BaseProps {
  /** Controls modal visibility. When false, the component renders nothing. */
  open: boolean;
  /** Called to close the modal (overlay click, escape key, or close button). */
  onClose: () => void;
  /** Optional title rendered in the modal header via the `Heading` primitive (level 4). */
  title?: string;
  /** Modal body content rendered in a scrollable area (`overflowY: auto`). */
  children: ReactNode;
  /** Footer content rendered below the body, right-aligned with an 8 px gap, separated by a top border. */
  footer?: ReactNode;
  /**
   * Controls the width of the modal panel.
   * - `'sm'` — 400 px
   * - `'md'` — 500 px
   * - `'lg'` — 640 px
   * - `'xl'` — 800 px
   * - `'full'` — 100vw, no border-radius, stretches to fill viewport
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /**
   * When true, clicking the semi-transparent overlay behind the modal calls `onClose`.
   * @default true
   */
  closeOnOverlayClick?: boolean;
  /**
   * When true, pressing the Escape key calls `onClose`.
   * @default true
   */
  closeOnEscape?: boolean;
  /**
   * When true, renders a ghost close button (X icon) in the modal header.
   * @default true
   */
  showCloseButton?: boolean;
}

/**
 * A single command entry in a `CommandPalette`. Commands can be grouped,
 * have keyboard shortcuts, and support a disabled state.
 */
export interface Command {
  /** Unique identifier for this command. */
  id: string;
  /** Display label for the command. Searchable by the palette's query filter. */
  label: string;
  /** Optional description text shown below the label. Also searchable. */
  description?: string;
  /** Icon rendered at the start of the command row. */
  icon?: ReactNode;
  /** Keyboard shortcut hint displayed at the end of the row in a `<kbd>` element. */
  shortcut?: string;
  /** Group name for visual sectioning. Commands with the same group are rendered under a shared header. Defaults to `'Commands'` if omitted. */
  group?: string;
  /** When true, the command is visually dimmed and cannot be selected. */
  disabled?: boolean;
}

/**
 * Props for the `CommandPalette` composition.
 *
 * A searchable command menu (Cmd+K / Ctrl+K pattern) that composes `Spinner` and `Icon`
 * primitives. Appears as a centered overlay at 15vh from the top. Commands are filtered
 * by label and description (case-insensitive substring match). Results are grouped under
 * uppercase section headers. Keyboard navigation is fully supported:
 * Arrow Up/Down to navigate, Enter to select, Escape to close.
 *
 * When `recentIds` are provided and the search query is empty, matching commands appear
 * in a "Recent" section at the top (deduplicated from their original groups).
 *
 * The footer shows navigation hints: "Up/Down Navigate", "Enter Select", "Esc Close".
 *
 * @example
 * ```tsx
 * <CommandPalette
 *   open={isOpen}
 *   onClose={() => setOpen(false)}
 *   commands={[
 *     { id: 'new', label: 'New File', shortcut: 'Ctrl+N', group: 'File' },
 *     { id: 'save', label: 'Save', shortcut: 'Ctrl+S', group: 'File' },
 *     { id: 'theme', label: 'Toggle Theme', group: 'Preferences' },
 *   ]}
 *   onSelect={(cmd) => executeCommand(cmd.id)}
 *   recentIds={['save']}
 *   placeholder="Search commands..."
 * />
 * ```
 */
export interface CommandPaletteProps extends BaseProps {
  /** Controls palette visibility. When false, the component renders nothing. */
  open: boolean;
  /** Called to close the palette (overlay click, Escape key, or after command selection). */
  onClose: () => void;
  /** Full array of available commands. Filtered client-side by the search query. */
  commands: Command[];
  /**
   * Called when a non-disabled command is selected (Enter key or click). The palette
   * auto-closes after selection.
   */
  onSelect: (command: Command) => void;
  /**
   * Placeholder text for the search input.
   * @default 'Search commands...'
   */
  placeholder?: string;
  /**
   * IDs of recently used commands. When the query is empty, these appear in a "Recent"
   * section at the top of the results.
   * @default []
   */
  recentIds?: string[];
  /** When true, shows a centered `Spinner` instead of the command list. */
  loading?: boolean;
}

// ============================================================================
// Footer
// ============================================================================

/**
 * A single link entry in a footer column or the bottom bar. Supports both
 * `href` navigation and `onClick` handlers (onClick takes precedence via `preventDefault`).
 */
export interface FooterLink {
  /** Display text for the link. */
  label: string;
  /** URL for the link. */
  href?: string;
  /** Click handler. When provided, `preventDefault` is called on the anchor click. */
  onClick?: () => void;
}

/**
 * A named column of links in the `Footer` layout. Each column has an optional title
 * and a list of links rendered as a vertical stack with 10 px gap.
 */
export interface FooterColumn {
  /** Column heading rendered as an `<h4>` with semibold weight. */
  title?: string;
  /** Links displayed in this column. */
  links: FooterLink[];
}

/**
 * A social media link in the `Footer` bottom bar. Rendered as an icon-only anchor
 * with `aria-label` for accessibility.
 */
export interface FooterSocialLink {
  /** Accessible label for the social link (used as `aria-label`). */
  label: string;
  /** URL for the social media profile or page. */
  href: string;
  /** Icon element rendered inside the anchor (typically an SVG or `Icon` primitive). */
  icon: ReactNode;
}

/**
 * Props for the `Footer` composition.
 *
 * A site footer with `role="contentinfo"` that lays out a brand slot, link columns,
 * social icons, and a bottom bar. Does not compose other ggui primitives (uses plain
 * HTML elements). Content is constrained to `max-width: 1280px` with auto margins.
 * Link columns use a responsive flex layout (`flex: 0 1 180px`). The bottom bar
 * includes copyright text, social links, and bottom-bar links separated by a top border.
 *
 * @example
 * ```tsx
 * <Footer
 *   brand={<img src="/logo.svg" alt="Acme" />}
 *   columns={[
 *     { title: 'Product', links: [{ label: 'Features', href: '/features' }] },
 *     { title: 'Company', links: [{ label: 'About', href: '/about' }] },
 *   ]}
 *   socialLinks={[
 *     { label: 'Twitter', href: 'https://twitter.com/acme', icon: <TwitterIcon /> },
 *   ]}
 *   bottomText="&copy; 2026 Acme Inc."
 *   bottomLinks={[{ label: 'Privacy', href: '/privacy' }]}
 *   bordered
 * />
 * ```
 */
export interface FooterProps extends BaseProps {
  /** Brand element (logo, tagline) rendered in a flexible column (`flex: 1 1 280px`). */
  brand?: ReactNode;
  /** Array of link columns rendered in a flex-wrap layout with 48 px gap. */
  columns?: FooterColumn[];
  /** Social media icon links rendered in the bottom bar. */
  socialLinks?: FooterSocialLink[];
  /** Text displayed at the start of the bottom bar (e.g., copyright notice). */
  bottomText?: string;
  /** Links displayed in the bottom bar after social icons (e.g., Privacy, Terms). */
  bottomLinks?: FooterLink[];
  /**
   * Background color of the footer.
   * @default colors.gray[50]
   */
  background?: string;
  /**
   * When true, renders a 1 px top border in `colors.gray[200]`.
   * @default true
   */
  bordered?: boolean;
}

// ============================================================================
// Hero
// ============================================================================

/**
 * A call-to-action button definition for the `Hero` composition.
 * Used for both the primary (filled) and secondary (outlined) action buttons.
 */
export interface HeroAction {
  /** Button label text. */
  label: string;
  /** Click handler for the button. */
  onClick?: () => void;
  /** Optional URL (not used by the default implementation; available for consumer routing). */
  href?: string;
}

// ============================================================================
// Incident Timeline
// ============================================================================

/**
 * Severity level of an incident. Controls the color coding in the uptime grid
 * and severity badge:
 * - `'minor'` — warning palette (amber)
 * - `'major'` — error palette (red)
 * - `'critical'` — error palette, darker shade (dark red)
 */
export type IncidentSeverity = 'minor' | 'major' | 'critical';

/**
 * Lifecycle status of an incident. Controls the status label text and styling:
 * - `'investigating'` — neutral gray
 * - `'identified'` — neutral gray
 * - `'monitoring'` — neutral gray
 * - `'resolved'` — success green with medium weight
 */
export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

/**
 * A single status update within an `Incident`. Displayed in the expandable
 * update log with timestamp, status label, and message.
 */
export interface IncidentUpdate {
  /** Unique identifier for this update entry. */
  id: string;
  /** Status at the time of this update. Rendered as a capitalized label. */
  status: IncidentStatus;
  /** Description of what changed or was observed. */
  message: string;
  /** Timestamp of the update. Formatted as `HH:MM AM/PM`. */
  timestamp: string | Date;
}

/**
 * A single incident with its metadata, status updates, and affected services.
 * Rendered as an expandable card in the `IncidentTimeline`.
 */
export interface Incident {
  /** Unique identifier for this incident. */
  id: string;
  /** Short incident title displayed in the card header. */
  title: string;
  /** Severity level controlling the badge color (minor=amber, major=red, critical=dark red). */
  severity: IncidentSeverity;
  /** Current lifecycle status of the incident. */
  status: IncidentStatus;
  /** When the incident was created. Used to assign it to a day in the timeline grid. */
  createdAt: string | Date;
  /** When the incident was resolved. Omitted for ongoing incidents. */
  resolvedAt?: string | Date;
  /** Chronological list of status updates shown in the expandable detail panel. */
  updates: IncidentUpdate[];
  /** List of affected service names displayed as small badges below the incident title. */
  affectedServices?: string[];
}

/**
 * Props for the `IncidentTimeline` composition.
 *
 * A status-page-style incident timeline. Renders a colored day grid (squares)
 * at the top showing the worst severity for each day (green = no incidents,
 * amber = minor, red = major/critical). Below the grid, incidents are grouped by day
 * with expandable cards showing severity badge, title, status label, affected services,
 * and a chronological update log.
 *
 * Uses CSS variables throughout (`--ggui-color-*`, `--ggui-font-size-*`, `--ggui-shape-radius-*`)
 * with hardcoded fallbacks. Does not compose ggui primitives — uses inline-styled `<div>`,
 * `<span>`, and `<svg>` elements. The expand/collapse chevron animates with a 200 ms
 * cubic-bezier transition.
 *
 * @example
 * ```tsx
 * <IncidentTimeline
 *   incidents={[
 *     {
 *       id: 'inc-1',
 *       title: 'API Latency Spike',
 *       severity: 'major',
 *       status: 'resolved',
 *       createdAt: '2026-03-15T10:00:00Z',
 *       resolvedAt: '2026-03-15T12:30:00Z',
 *       updates: [
 *         { id: 'u1', status: 'investigating', message: 'Elevated p99 latency detected', timestamp: '2026-03-15T10:00:00Z' },
 *         { id: 'u2', status: 'resolved', message: 'Root cause fixed', timestamp: '2026-03-15T12:30:00Z' },
 *       ],
 *       affectedServices: ['API', 'Dashboard'],
 *     },
 *   ]}
 *   days={14}
 *   emptyText="All systems operational"
 * />
 * ```
 */
export interface IncidentTimelineProps extends BaseProps {
  /** Array of incidents to display. Grouped by creation date in the timeline. */
  incidents: Incident[];
  /**
   * Number of days to show in the uptime grid (counting back from today).
   * @default 14
   */
  days?: number;
  /**
   * Message displayed next to a green dot when there are no incidents at all.
   * @default 'All systems operational'
   */
  emptyText?: string;
  /**
   * When true, incident cards are non-expandable — the update log is hidden and the
   * chevron indicator is removed.
   * @default false
   */
  compact?: boolean;
}

// ============================================================================
// Hero
// ============================================================================

/**
 * Props for the `Hero` composition.
 *
 * A prominent landing-page hero section that renders heading, description, CTA buttons,
 * and an optional media slot. Does not compose other ggui primitives (uses plain HTML
 * elements styled with design tokens). Content is constrained to `max-width: 1280px`.
 *
 * Layout modes:
 * - `align='center'` — single-column centered layout with `max-width: 800px` text area.
 * - `align='left'` — two-column side-by-side layout (50/50 split with media slot).
 *
 * Size controls vertical padding and font sizes:
 * - `'sm'` — 48 px vertical padding, 3xl heading, lg description.
 * - `'md'` — 80 px vertical padding, 4xl heading, xl description.
 * - `'lg'` — 120 px vertical padding, 5xl heading, xl description.
 *
 * The primary action button uses `colors.primary[600]` fill; the secondary action uses
 * an outlined style. When `overlay` is true with a `backgroundImage`, text switches to white
 * and borders become semi-transparent.
 *
 * @example
 * ```tsx
 * <Hero
 *   heading="Build Better UIs, Faster"
 *   description="The universal interface layer between AI agents and humans."
 *   primaryAction={{ label: 'Get Started', onClick: () => navigate('/signup') }}
 *   secondaryAction={{ label: 'Learn More', href: '/docs' }}
 *   media={<img src="/hero.png" alt="Hero" />}
 *   align="left"
 *   size="lg"
 * />
 * ```
 */
export interface HeroProps extends BaseProps {
  /** Main heading text rendered as an `<h1>` with bold weight and tight line-height. */
  heading?: string;
  /** Description paragraph rendered below the heading with relaxed line-height. */
  description?: string;
  /** Primary CTA button rendered with `colors.primary[600]` background and white text. */
  primaryAction?: HeroAction;
  /** Secondary CTA button rendered with a transparent background and a 1 px border. */
  secondaryAction?: HeroAction;
  /** Media element (image, video, illustration) rendered beside or below the text content. */
  media?: ReactNode;
  /**
   * Text and layout alignment.
   * - `'center'` — centered single-column layout.
   * - `'left'` — left-aligned text with media in a right column (50/50 split).
   * @default 'center'
   */
  align?: 'center' | 'left';
  /**
   * Controls vertical padding and heading/description font sizes.
   * - `'sm'` — compact (48 px padding, 3xl/lg fonts).
   * - `'md'` — standard (80 px padding, 4xl/xl fonts).
   * - `'lg'` — spacious (120 px padding, 5xl/xl fonts).
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg';
  /**
   * Background color of the hero section.
   * @default colors.white (when no backgroundImage is set)
   */
  background?: string;
  /** Background image URL applied as `background-size: cover; background-position: center`. */
  backgroundImage?: string;
  /**
   * When true and `backgroundImage` is set, renders a semi-transparent black overlay
   * (`rgba(0,0,0,0.5)`) and switches text to white/semi-transparent white for contrast.
   * @default false
   */
  overlay?: boolean;
}

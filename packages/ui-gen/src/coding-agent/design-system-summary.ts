// packages/ui-gen/src/coding-agent/design-system-summary.ts
//
// Compact design system summary for the planner.
// ~500 tokens instead of ~43K. Lists available primitives,
// key tokens, and rules — enough for architecture decisions.

/**
 * Generate a compact summary of available design system primitives and tokens.
 * Used by the planner to make architecture decisions without loading the full
 * 137KB design system docs.
 */
export function getDesignSystemSummary(): string {
  return `## Available Design System

EVERYTHING below imports from the single \`@ggui-ai/design\` entry —
there are no \`/primitives\`, \`/components\` or \`/compositions\` subpaths:

**Layout:**
Container, Card, Stack, Row, Grid, Box, Divider, Spacer

**Typography:**
Text (variants: body, bodySmall, bodyLarge, caption, label, overline)
Heading (levels: 1-6)

**Form:**
Input, TextArea, Select, Checkbox, Toggle, RadioGroup, Slider, SearchField, FormField

**Interactive:**
Button, Link, Tabs, Accordion, Dropdown, Autocomplete, Badge, Tag

**Feedback:**
Alert, Progress, Spinner, Skeleton, Toast, Tooltip, EmptyState

**Media:**
Image, Icon, Avatar

**Data:**
Table

**Animation:**
MotionKeyframes (inject once for animations)

**Components:**
MenuItem, Breadcrumb, Pagination, Header, Sidebar, Stat

**Compositions:**
CardGrid, DataTable, ChatWindow, Modal, CommandPalette, Footer, Hero

## Key Design Tokens

**Text colors** (semantic — theme-agnostic):
- var(--ggui-color-onSurface) — primary text
- var(--ggui-color-onSurfaceVariant) — secondary/muted text

**Backgrounds:**
- var(--ggui-color-surface) — main background
- var(--ggui-color-surfaceVariant) — cards, panels
- var(--ggui-color-container) — branded containers

**Brand:**
- var(--ggui-color-primary-50) through var(--ggui-color-primary-900)

**Borders:**
- var(--ggui-color-outline), var(--ggui-color-outlineVariant)

**States:**
- var(--ggui-color-success), var(--ggui-color-error), var(--ggui-color-warning)

**Spacing:**
- var(--ggui-spacing-1) 4px, var(--ggui-spacing-2) 8px, var(--ggui-spacing-4) 16px, var(--ggui-spacing-6) 24px

**DO NOT use:** neutral-*, gray-* tokens (break in dark themes)
**DO NOT invent:** Grid, Flex, Layout — use Stack, Box, Container`;
}

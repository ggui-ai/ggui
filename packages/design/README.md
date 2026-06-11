# @ggui-ai/design

The ggui design system — a themeable React component library built for
AI-generated UIs. Atomic-design primitives, components, compositions, and
page-level blueprints, all styled with CSS custom properties so a theme can
be swapped at runtime via [DTCG](https://design-tokens.github.io/community-group/format/)
token injection.

## Install

```bash
npm install @ggui-ai/design
```

`react` and `react-dom` (v18 or v19) are peer dependencies.

## Import paths

Generated component code and app code use the single bare barrel —
primitives, components, compositions, blueprints, and design tokens all
resolve from `@ggui-ai/design`:

```tsx
import { Card, Stack, Text, Button, Grid, colors, spacing } from "@ggui-ai/design";
```

Renderer integrators (packages that mount generated components) use the
subpaths that are deliberately kept **out** of the barrel:
`@ggui-ai/design/preview`, `@ggui-ai/design/rendering`,
`@ggui-ai/design/module-loader`, and `@ggui-ai/design/inline`. Per-layer
subpaths (`/primitives`, `/components`, `/compositions`, `/tokens`,
`/themes`, `/interact`) also exist for callers that want a narrower
entry point; they re-export the same symbols the barrel carries.

## Usage

```tsx
import { Card, Stack, Heading, Text, Button } from "@ggui-ai/design";

function Example() {
  return (
    <Card radius="lg" padding="lg">
      <Stack gap="md">
        <Heading level={2}>Welcome</Heading>
        <Text tone="muted">Sign in to continue.</Text>
        <Button variant="primary">Get started</Button>
      </Stack>
    </Card>
  );
}
```

## Component levels (atomic design)

| Level            | What it is                                   | Examples                                   |
| ---------------- | -------------------------------------------- | ------------------------------------------ |
| **Primitives**   | Single-purpose building blocks               | `Button`, `Text`, `Card`, `Grid`           |
| **Components**   | Functional units combining a few primitives  | `SearchField`, `FormField`, `Stat`         |
| **Compositions** | Self-contained sections with their own logic | `Header`, `Modal`, `DataTable`             |
| **Blueprints**   | Full-screen agent-interface layouts          | `Dashboard`, `ListDetail`, `ChatInterface` |

## Conventions

- **Layout primitives accept `as={Trait}`.** `Box`, `Stack`, `Row`, and
  `Card` become interactive by composing a trait (`Clickable`, `Hoverable`,
  `Pressable`) rather than sprouting handler props.
- **`Text` is a content primitive.** It renders a semantic element chosen
  by `is` (`p` / `span` / `div` / `label`) and takes `htmlFor` on labels.
  It is not a trait host — for clickable text reach for `Link` or wrap the
  text in a structural trait host.
- **Spacing props take t-shirt names** (`xs`, `sm`, `md`, `lg`, …) resolved
  to tokens; raw CSS lengths are rejected on `gap` / `padding`.
- **One `radius` prop** on a typed scale handles all corner rounding.
- **`Grid`** supports fixed, fluid, and per-breakpoint responsive columns
  (`columns={{ base: 1, md: 3 }}`).

## Theming

Components read CSS custom properties with built-in fallbacks, so they
render correctly with no theme and re-skin instantly when one is injected.
See [CUSTOM_THEMES.md](./CUSTOM_THEMES.md) for authoring themes.

## License

Apache-2.0

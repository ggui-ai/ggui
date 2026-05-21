/**
 * Interact — Interaction behavior wrappers for primitives.
 *
 * Use with the `as` prop pattern on any primitive:
 *   <Card as={Clickable} onClick={handler} hoverStyle={{ opacity: 0.8 }}>
 *   <Box as={Hoverable} hoverStyle={{ background: 'var(--ggui-color-surfaceVariant)' }}>
 *   <Card as={Pressable} onPress={handler} pressStyle={{ transform: 'scale(0.98)' }}>
 *
 * Or use standalone:
 *   <Clickable onClick={handler}>content</Clickable>
 */

export { Clickable } from './Clickable';
export { Hoverable } from './Hoverable';
export { Pressable } from './Pressable';

export type { ClickableProps } from './Clickable';
export type { HoverableProps } from './Hoverable';
export type { PressableProps } from './Pressable';

// Trait composition — the `as` prop type model.
export type { TraitComponent, TraitProps, WithTrait } from './trait';

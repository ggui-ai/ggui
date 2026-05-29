/**
 * Wire serialization for tool outputs.
 *
 * Menu items are decorated with an absolute `photoUrl` (built from the
 * per-request base URL + the stored relative `photoPath`) so the image
 * resolves from the browser that renders the card. Typed view — not a
 * `Record<string, unknown>` envelope.
 */
import type { MenuItem } from './types.js';

export interface MenuItemView extends MenuItem {
  readonly photoUrl: string;
}

export function menuItemView(item: MenuItem, baseUrl: string): MenuItemView {
  return { ...item, photoUrl: `${baseUrl}${item.photoPath}` };
}

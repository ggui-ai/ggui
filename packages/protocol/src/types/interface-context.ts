/**
 * Interface Context — device and viewport information for responsive UI generation.
 *
 * Threaded through the full pipeline:
 * Client → WebSocket/MCP → SQS → Queue Consumer → Generator → Prompts
 *
 * Allows Claude to generate UIs adapted to the user's device/viewport.
 */

import type { JsonObject } from './data-contract';

// =============================================================================
// Core Types
// =============================================================================

export type PlatformType = 'web' | 'mobile' | 'desktop';
export type DeviceType = 'phone' | 'tablet' | 'desktop';
export type Orientation = 'portrait' | 'landscape';

/**
 * Device category for blueprint variant selection.
 * Each blueprint can have optimized variants per device category.
 *
 * - mobile: viewport width < 768px
 * - tablet: viewport width 768-1023px
 * - desktop: viewport width >= 1024px
 * - spatial: 3D spatial shell (overrides width-based detection)
 */
export type DeviceCategory = 'mobile' | 'tablet' | 'desktop' | 'spatial';

/**
 * Shell type — describes the rendering container for generated UI.
 * The generator uses this to adapt layout, sizing, and interaction patterns.
 *
 * - chat: Inline card in a scrolling chat conversation. Compact, card-sized.
 * - fullscreen: Full-viewport swipeable card. Fill entire screen, immersive.
 * - agent: Character-based shell (R2D2-style). Screen panel + character + thinking bubble.
 * - spatial: 3D spatial panel (future: Meta Glass, Apple Vision Pro). Fixed-size floating panel.
 */
export type ShellType = 'chat' | 'fullscreen' | 'agent' | 'spatial';

/**
 * Viewport dimensions in CSS pixels.
 * Used for responsive breakpoint calculations and layout decisions.
 *
 * Extends {@link JsonObject} for direct JSON serialization over WebSocket.
 */
export interface ViewportInfo extends JsonObject {
  /** Width in CSS pixels */
  width: number;
  /** Height in CSS pixels */
  height: number;
}

/**
 * Complete interface context describing the rendering environment.
 * All fields except viewport are optional for graceful degradation.
 *
 * Extends {@link JsonObject} for direct JSON serialization over WebSocket.
 */
export interface InterfaceContext extends JsonObject {
  /** Viewport dimensions in CSS pixels */
  viewport: ViewportInfo;
  /** Platform type */
  platform: PlatformType;
  /** Device form factor */
  deviceType: DeviceType;
  /** Screen orientation */
  orientation: Orientation;
  /** Device pixel ratio (for high-DPI rendering decisions) */
  devicePixelRatio?: number;
  /** Whether touch is the primary input method */
  touchPrimary?: boolean;
  /**
   * Shell type — the rendering container for this UI.
   * Tells the generator how the component will be displayed so it can
   * adapt layout, sizing, spacing, and interaction patterns accordingly.
   */
  shellType?: ShellType;
  /** User's preferred color scheme */
  colorScheme?: 'light' | 'dark';
  /** Whether the user prefers reduced motion (prefers-reduced-motion) */
  reducedMotion?: boolean;
}

// =============================================================================
// Detection & Defaults
// =============================================================================

/**
 * Detect interface context from the browser `window` object.
 *
 * Reads viewport size, device pixel ratio, touch capability, color scheme,
 * and reduced-motion preference. Falls back to {@link defaultInterfaceContext}
 * when called in a non-browser environment (e.g., SSR).
 *
 * @returns Fully populated interface context derived from the browser
 */
export function detectInterfaceContext(): InterfaceContext {
  if (typeof window === 'undefined') {
    return defaultInterfaceContext();
  }

  const width = window.innerWidth;
  const height = window.innerHeight;
  const devicePixelRatio = window.devicePixelRatio || 1;
  const touchPrimary = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  const colorScheme = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' as const : 'light' as const;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  return {
    viewport: { width, height },
    platform: detectPlatform(touchPrimary),
    deviceType: detectDeviceType(width),
    orientation: width >= height ? 'landscape' : 'portrait',
    devicePixelRatio,
    touchPrimary,
    colorScheme,
    reducedMotion,
  };
}

/**
 * Default interface context for SSR or when browser detection is unavailable.
 *
 * Returns a standard desktop viewport (1280x800), landscape orientation,
 * non-touch, 1x pixel ratio. Suitable as a safe fallback for server-side
 * rendering where no `window` object exists.
 *
 * @returns A desktop-oriented default context
 */
export function defaultInterfaceContext(): InterfaceContext {
  return {
    viewport: { width: 1280, height: 800 },
    platform: 'web',
    deviceType: 'desktop',
    orientation: 'landscape',
    devicePixelRatio: 1,
    touchPrimary: false,
  };
}

// =============================================================================
// Device Category
// =============================================================================

/**
 * Derive the device category from an InterfaceContext.
 * Used for blueprint variant selection — determines which optimized
 * version of a blueprint to serve.
 *
 * Priority:
 * 1. If shellType is 'spatial', returns 'spatial' (overrides width)
 * 2. Otherwise, derives from viewport width using standard breakpoints
 */
export function getDeviceCategory(context: InterfaceContext): DeviceCategory {
  if (context.shellType === 'spatial') {
    return 'spatial';
  }

  const width = context.viewport.width;

  if (width < 768) return 'mobile';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Infer the platform type from the user agent string and touch capability.
 *
 * @param touchPrimary - Whether touch is the primary input method
 * @returns Detected platform: `'mobile'` for phones/tablets, `'web'` otherwise
 */
function detectPlatform(touchPrimary: boolean): PlatformType {
  if (typeof navigator === 'undefined') return 'web';
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('android') || ua.includes('iphone') || ua.includes('ipad')) return 'mobile';
  if (touchPrimary && ua.includes('mobile')) return 'mobile';
  return 'web';
}

/**
 * Classify device form factor from viewport width using standard breakpoints.
 *
 * @param width - Viewport width in CSS pixels
 * @returns `'phone'` (<768px), `'tablet'` (768-1023px), or `'desktop'` (>=1024px)
 */
function detectDeviceType(width: number): DeviceType {
  if (width < 768) return 'phone';
  if (width < 1024) return 'tablet';
  return 'desktop';
}

#!/usr/bin/env node
/**
 * Generate curated Lucide icon data for the Icon primitive.
 *
 * Extracts SVG path data from the `lucide` package (devDependency) and writes
 * it as a static TypeScript file. This avoids bundling the full 1,900+ icon set
 * (411KB) — only the curated subset (~31KB) ships at runtime.
 *
 * Run: node packages/design/scripts/generate-icon-data.mjs
 * Or:  pnpm --filter @ggui-ai/design generate:icons
 *
 * To add icons: add the PascalCase Lucide name to CURATED_ICONS below.
 * Full list: https://lucide.dev/icons
 */

import { icons } from 'lucide';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, '..', 'src', 'primitives', 'icon-data.ts');

// ---------------------------------------------------------------------------
// Curated icon set — ~200 icons covering common LLM-generated UI needs
// ---------------------------------------------------------------------------

const CURATED_ICONS = [
  // Weather
  'Sun', 'Moon', 'Cloud', 'CloudRain', 'CloudSnow', 'CloudLightning', 'CloudDrizzle',
  'CloudSun', 'CloudMoon', 'CloudFog', 'Wind', 'Thermometer', 'Droplets', 'Umbrella', 'Snowflake', 'Rainbow',
  // Navigation
  'Home', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ChevronLeft', 'ChevronRight',
  'ChevronUp', 'ChevronDown', 'ChevronsLeft', 'ChevronsRight', 'ChevronsUp', 'ChevronsDown',
  'ExternalLink', 'CornerDownLeft', 'CornerDownRight', 'MoveHorizontal', 'MoveVertical',
  // Actions
  'Plus', 'Minus', 'X', 'Check', 'Search', 'Edit', 'Trash2', 'Save', 'Download', 'Upload',
  'Share2', 'Copy', 'Clipboard', 'RotateCcw', 'RotateCw', 'RefreshCw', 'Undo2', 'Redo2',
  'Maximize2', 'Minimize2', 'ZoomIn', 'ZoomOut', 'Send', 'LogIn', 'LogOut',
  // Social / Communication
  'Heart', 'Star', 'ThumbsUp', 'ThumbsDown', 'MessageCircle', 'MessageSquare', 'Bell',
  'BellOff', 'Mail', 'Phone', 'PhoneCall', 'Video', 'AtSign', 'Users', 'UserPlus',
  // Commerce
  'ShoppingCart', 'ShoppingBag', 'CreditCard', 'DollarSign', 'Package', 'Tag', 'Receipt',
  'Wallet', 'Banknote', 'Percent', 'Gift', 'Store', 'Truck',
  // Status / Feedback
  'AlertCircle', 'AlertTriangle', 'Info', 'HelpCircle', 'CheckCircle', 'XCircle',
  'Loader', 'Loader2', 'CircleDot', 'ShieldCheck', 'ShieldAlert', 'Ban',
  // Media
  'Play', 'Pause', 'Square', 'SkipBack', 'SkipForward', 'Volume2', 'VolumeX',
  'Camera', 'Image', 'Film', 'Music', 'Mic', 'MicOff', 'Headphones',
  // Files / Data
  'File', 'FileText', 'Folder', 'FolderOpen', 'Database', 'HardDrive', 'Server',
  'PieChart', 'BarChart3', 'LineChart', 'TrendingUp', 'TrendingDown', 'Activity',
  // UI
  'Menu', 'MoreHorizontal', 'MoreVertical', 'Grid', 'List', 'Columns', 'Layout',
  'Sidebar', 'PanelLeft', 'PanelRight', 'SlidersHorizontal', 'Filter', 'SortAsc', 'SortDesc',
  'Table', 'Calendar', 'Clock', 'Timer', 'Hourglass',
  // People / Identity
  'User', 'UserCheck', 'Settings', 'Sliders', 'Cog',
  // Objects
  'MapPin', 'Map', 'Globe', 'Compass', 'Link', 'Lock', 'Unlock', 'Key', 'Shield',
  'Eye', 'EyeOff', 'Bookmark', 'Flag', 'Award', 'Target', 'Zap', 'Flame',
  'Coffee', 'Lightbulb', 'Puzzle', 'Rocket', 'Code', 'Terminal', 'Braces', 'Hash',
  'Wifi', 'WifiOff', 'Bluetooth', 'Battery', 'BatteryCharging', 'Power',
  'Printer', 'QrCode', 'Fingerprint', 'Gauge',
  // Greeting / conversational glyphs (ggui#1015): the names hello screens
  // and reply chips reach for first — an AI spark, a bot, a wave, an
  // outbound arrow. Missing names rendered the unknown-name placeholder
  // on greeting screens in the field.
  'Sparkles', 'Sparkle', 'Bot', 'BotMessageSquare', 'WandSparkles', 'Hand', 'PartyPopper', 'Smile',
  'Brain', 'Trophy', 'Waves', 'Paperclip', 'Cpu',
  'ArrowUpRight', 'ArrowDownRight', 'ArrowUpLeft', 'ArrowDownLeft',
];

// ---------------------------------------------------------------------------
// Extract and write
// ---------------------------------------------------------------------------

const result = {};
const missing = [];

for (const name of CURATED_ICONS) {
  if (icons[name]) {
    result[name] = icons[name];
  } else {
    missing.push(name);
  }
}

if (missing.length > 0) {
  console.error(`[icon-data] WARNING: ${missing.length} icons not found in lucide: ${missing.join(', ')}`);
}

// Lucide's own kebab spelling: `Trash2` → `trash-2`, `BarChart3` → `bar-chart-3`.
const kebabNames = Object.keys(result)
  .map((n) => n.replace(/([a-z])([A-Z0-9])/g, '$1-$2').replace(/([0-9])([A-Z])/g, '$1-$2').toLowerCase())
  .sort();

const ts = `// AUTO-GENERATED from lucide icons. Do not edit manually.
// To regenerate: node packages/design/scripts/generate-icon-data.mjs
// Source: https://lucide.dev/icons (MIT License)
// Icons: ${Object.keys(result).length} curated

type IconNode = [string, Record<string, string>][];

export const LUCIDE_ICONS: Record<string, IconNode> = ${JSON.stringify(result, null, 2)} as const;

/**
 * Every name the Icon primitive renders, kebab-case, sorted — the single
 * list the generator's icon tool and the check leg read (ggui#1015). A
 * name outside this list renders nothing.
 */
export const LUCIDE_ICON_NAMES: readonly string[] = ${JSON.stringify(kebabNames, null, 2)} as const;
`;

writeFileSync(OUTPUT, ts);

console.log(`[icon-data] Generated ${OUTPUT}`);
console.log(`[icon-data] ${Object.keys(result).length} icons, ${(ts.length / 1024).toFixed(1)} KB`);

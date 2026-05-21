/**
 * Compositions (Organisms)
 *
 * Self-contained sections with logic/state.
 * These are complex UI patterns that can stand alone.
 */

export { Header } from './Header';
export { Sidebar } from './Sidebar';
export { CardGrid } from './CardGrid';
export { CommentThread } from './CommentThread';
export { DataTable } from './DataTable';
export { ChatWindow } from './ChatWindow';
export { NavigationBar } from './NavigationBar';
export { FileUploader } from './FileUploader';
export { UserProfileCard } from './UserProfileCard';
export { NotificationCenter } from './NotificationCenter';
export { Modal } from './Modal';
export { CommandPalette } from './CommandPalette';
export { Footer } from './Footer';
export { Hero } from './Hero';
export { IncidentTimeline } from './IncidentTimeline';
export { MakeTabLayout } from './MakeTabLayout';

// Marketing compositions
export * from './marketing';

// Re-export types
export type {
  HeaderProps,
  SidebarProps,
  SidebarItem,
  CardGridProps,
  CommentThreadProps,
  Comment,
  DataTableProps,
  DataTableColumn,
  ChatWindowProps,
  ChatMessage,
  NavigationBarProps,
  NavItem,
  FileUploaderProps,
  UploadedFile,
  UserProfileCardProps,
  NotificationCenterProps,
  Notification,
  ModalProps,
  CommandPaletteProps,
  Command,
  FooterProps,
  FooterLink,
  FooterColumn,
  FooterSocialLink,
  HeroProps,
  HeroAction,
  IncidentTimelineProps,
  Incident,
  IncidentUpdate,
  IncidentSeverity,
  IncidentStatus,
} from './types';
export type { MakeTabLayoutProps } from './MakeTabLayout';

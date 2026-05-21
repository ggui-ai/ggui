import { useState, type ReactNode } from 'react';
import {
  Container,
  Row,
  Stack,
  Text,
  Button,
  Divider,
} from '@ggui-ai/design/primitives';

interface UserData {
  name?: string;
  avatar?: string;
  role?: string;
}

interface SidebarItem {
  id: string;
  label: string;
  icon?: string;
  href?: string;
  active?: boolean;
}

interface DashboardBlueprintProps {
  title?: string;
  user?: UserData;
  sidebarItems?: SidebarItem[];
  sidebarCollapsed?: boolean;
  showFooter?: boolean;
  onNavigate?: (item: SidebarItem) => void;
  onSidebarToggle?: (collapsed: boolean) => void;
  onUserMenuClick?: () => void;
  // Slot content
  headerSlot?: ReactNode;
  sidebarSlot?: ReactNode;
  mainSlot?: ReactNode;
  footerSlot?: ReactNode;
  // Alias for mainSlot (children)
  children?: ReactNode;
}

export default function DashboardBlueprint({
  title = 'Dashboard',
  user,
  sidebarItems = [],
  sidebarCollapsed: initialCollapsed = false,
  showFooter = false,
  onNavigate,
  onSidebarToggle,
  onUserMenuClick,
  headerSlot,
  sidebarSlot,
  mainSlot,
  footerSlot,
  children,
}: DashboardBlueprintProps) {
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleToggleSidebar = () => {
    const newCollapsed = !collapsed;
    setCollapsed(newCollapsed);
    onSidebarToggle?.(newCollapsed);
  };

  const handleNavigation = (item: SidebarItem) => {
    onNavigate?.(item);
    // Close mobile menu after navigation
    setMobileMenuOpen(false);
  };

  const sidebarWidth = collapsed ? 64 : 240;

  return (
    <Container
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
      }}
    >
      {/* Header */}
      <header
        style={{
          position: 'sticky',
          top: 0,
          zIndex: 40,
          backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
          borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
          boxShadow: 'var(--ggui-shape-shadow-sm, 0 1px 2px 0 rgb(0 0 0 / 0.05))',
        }}
      >
        {headerSlot ?? (
          <Row
            justify="between"
            align="center"
            style={{ padding: '12px 24px', height: 64 }}
          >
            <Row gap="md" align="center">
              {/* Mobile menu button */}
              <Button
                variant="ghost"
                onPress={() => setMobileMenuOpen(!mobileMenuOpen)}
                aria-label="Toggle menu"
                style={{
                  display: 'none',
                  // Show on mobile via CSS
                  '@media (max-width: 768px)': { display: 'flex' },
                } as React.CSSProperties}
              >
                {mobileMenuOpen ? '✕' : '☰'}
              </Button>

              {/* Sidebar toggle (desktop) */}
              <Button
                variant="ghost"
                onPress={handleToggleSidebar}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                {collapsed ? '→' : '←'}
              </Button>

              <Text variant="h2" style={{ fontWeight: 600 }}>
                {title}
              </Text>
            </Row>

            {user && (
              <Button
                variant="ghost"
                onPress={onUserMenuClick}
                aria-label="User menu"
              >
                <Row gap="sm" align="center">
                  {user.avatar && (
                    <div
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: '50%',
                        backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#ffffff',
                        fontSize: 14,
                        fontWeight: 500,
                      }}
                    >
                      {user.name?.[0]?.toUpperCase() ?? 'U'}
                    </div>
                  )}
                  <Stack gap="none">
                    <Text variant="body" style={{ fontWeight: 500 }}>
                      {user.name ?? 'User'}
                    </Text>
                    {user.role && (
                      <Text
                        variant="small"
                        style={{ color: 'var(--ggui-color-neutral-500, #6b7280)' }}
                      >
                        {user.role}
                      </Text>
                    )}
                  </Stack>
                </Row>
              </Button>
            )}
          </Row>
        )}
      </header>

      {/* Main layout with sidebar */}
      <div style={{ display: 'flex', flex: 1 }}>
        {/* Sidebar */}
        <aside
          style={{
            width: sidebarWidth,
            minWidth: sidebarWidth,
            backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
            borderRight: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
            transition: 'width 0.2s ease-in-out',
            overflowX: 'hidden',
            overflowY: 'auto',
            // Mobile: absolute positioned drawer
            position: mobileMenuOpen ? 'fixed' : 'relative',
            left: 0,
            top: 64,
            bottom: 0,
            zIndex: mobileMenuOpen ? 30 : 'auto',
          }}
        >
          {sidebarSlot ?? (
            <Stack gap="xs" style={{ padding: collapsed ? 8 : 16 }}>
              {sidebarItems.map((item) => (
                <Button
                  key={item.id}
                  variant={item.active ? 'secondary' : 'ghost'}
                  onPress={() => handleNavigation(item)}
                  style={{
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    width: '100%',
                    padding: collapsed ? 12 : '12px 16px',
                    backgroundColor: item.active
                      ? 'var(--ggui-color-neutral-100, #f3f4f6)'
                      : 'transparent',
                  }}
                  aria-current={item.active ? 'page' : undefined}
                >
                  {item.icon && (
                    <span style={{ marginRight: collapsed ? 0 : 12 }}>
                      {item.icon}
                    </span>
                  )}
                  {!collapsed && <Text variant="body">{item.label}</Text>}
                </Button>
              ))}
            </Stack>
          )}
        </aside>

        {/* Mobile overlay */}
        {mobileMenuOpen && (
          <div
            onClick={() => setMobileMenuOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              top: 64,
              backgroundColor: 'rgba(0, 0, 0, 0.3)',
              zIndex: 20,
            }}
            aria-hidden="true"
          />
        )}

        {/* Main content */}
        <main
          style={{
            flex: 1,
            padding: 24,
            overflowY: 'auto',
            minHeight: 0, // Allow flex child to scroll
          }}
        >
          {mainSlot ?? children ?? (
            <Stack gap="lg">
              <Text variant="h3" style={{ color: 'var(--ggui-color-neutral-700, #374151)' }}>
                Welcome to your dashboard
              </Text>
              <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #6b7280)' }}>
                Add content to the main slot to display your dashboard content.
              </Text>
            </Stack>
          )}
        </main>
      </div>

      {/* Footer */}
      {showFooter && (
        <footer
          style={{
            backgroundColor: 'var(--ggui-color-neutral-50, #ffffff)',
            borderTop: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
            padding: '16px 24px',
          }}
        >
          {footerSlot ?? (
            <Row justify="between" align="center">
              <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #6b7280)' }}>
                © 2026 Your Company. All rights reserved.
              </Text>
            </Row>
          )}
        </footer>
      )}
    </Container>
  );
}

import { useState, type ReactNode } from 'react';
import {
  Container,
  Card,
  Row,
  Stack,
  Text,
  Button,
} from '@ggui-ai/design/primitives';

interface NavItem {
  id: string;
  label: string;
  icon?: string;
  badge?: number;
}

interface TwoColumnLayoutProps {
  sidebarWidth?: number;
  sidebarTitle?: string;
  navItems?: NavItem[];
  mainTitle?: string;
  collapsible?: boolean;
  onNavSelect?: (item: NavItem) => void;
  onSidebarToggle?: (collapsed: boolean) => void;
  sidebarContent?: () => ReactNode;
  mainContent?: () => ReactNode;
  sidebarFooter?: () => ReactNode;
  mainHeader?: () => ReactNode;
  children?: ReactNode;
}

export default function TwoColumnLayout({
  sidebarWidth = 260,
  sidebarTitle = 'App Name',
  navItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'projects', label: 'Projects', badge: 3 },
    { id: 'team', label: 'Team' },
    { id: 'reports', label: 'Reports' },
    { id: 'settings', label: 'Settings' },
  ],
  mainTitle = 'Dashboard',
  collapsible = true,
  onNavSelect,
  onSidebarToggle,
  sidebarContent,
  mainContent,
  sidebarFooter,
  mainHeader,
  children,
}: TwoColumnLayoutProps) {
  const [activeNav, setActiveNav] = useState(navItems[0]?.id ?? '');
  const [collapsed, setCollapsed] = useState(false);

  const handleNavClick = (item: NavItem) => {
    setActiveNav(item.id);
    onNavSelect?.(item);
  };

  const handleToggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    onSidebarToggle?.(next);
  };

  const effectiveWidth = collapsed ? 64 : sidebarWidth;

  return (
    <Container
      style={{
        display: 'flex',
        height: '100vh',
        backgroundColor: 'var(--ggui-color-neutral-50, #f9fafb)',
      }}
    >
      {/* Sidebar */}
      <div
        style={{
          width: effectiveWidth,
          minWidth: effectiveWidth,
          backgroundColor: 'var(--ggui-color-neutral-900, #111827)',
          color: '#ffffff',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.2s ease',
          overflow: 'hidden',
        }}
      >
        {/* Sidebar Header */}
        <Row
          align="center"
          justify="between"
          style={{
            padding: collapsed ? '16px 12px' : '16px 20px',
            borderBottom: '1px solid rgba(255,255,255,0.1)',
            minHeight: 56,
          }}
        >
          {!collapsed && (
            <Text
              variant="h3"
              style={{ color: '#ffffff', fontSize: 18, fontWeight: 700 }}
            >
              {sidebarTitle}
            </Text>
          )}
          {collapsible && (
            <button
              onClick={handleToggle}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255,255,255,0.6)',
                cursor: 'pointer',
                padding: 4,
                fontSize: 16,
              }}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? '\u25B6' : '\u25C0'}
            </button>
          )}
        </Row>

        {/* Sidebar Navigation or Custom Content */}
        <div style={{ flex: 1, overflowY: 'auto', padding: collapsed ? '8px 4px' : '8px 12px' }}>
          {sidebarContent ? (
            sidebarContent()
          ) : (
            <Stack gap="xs">
              {navItems.map((item) => (
                <button
                  key={item.id}
                  onClick={() => handleNavClick(item)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: collapsed ? 'center' : 'space-between',
                    padding: collapsed ? '10px 8px' : '10px 12px',
                    borderRadius: 'var(--ggui-borderRadius-md, 6px)',
                    backgroundColor:
                      activeNav === item.id ? 'rgba(255,255,255,0.15)' : 'transparent',
                    color: activeNav === item.id ? '#ffffff' : 'rgba(255,255,255,0.7)',
                    border: 'none',
                    cursor: 'pointer',
                    textAlign: 'left',
                    width: '100%',
                    fontSize: 14,
                    fontWeight: activeNav === item.id ? 600 : 400,
                    transition: 'background-color 0.15s',
                  }}
                  aria-current={activeNav === item.id ? 'page' : undefined}
                >
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {collapsed ? item.label.charAt(0) : item.label}
                  </span>
                  {!collapsed && item.badge != null && item.badge > 0 && (
                    <span
                      style={{
                        backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
                        color: '#ffffff',
                        fontSize: 11,
                        fontWeight: 600,
                        padding: '2px 8px',
                        borderRadius: 10,
                        minWidth: 20,
                        textAlign: 'center',
                      }}
                    >
                      {item.badge}
                    </span>
                  )}
                </button>
              ))}
            </Stack>
          )}
        </div>

        {/* Sidebar Footer */}
        {sidebarFooter && !collapsed && (
          <div
            style={{
              padding: '12px 20px',
              borderTop: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            {sidebarFooter()}
          </div>
        )}
      </div>

      {/* Main Content */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {/* Main Header */}
        {mainHeader ? (
          mainHeader()
        ) : (
          <Row
            align="center"
            justify="between"
            style={{
              padding: '12px 24px',
              backgroundColor: '#ffffff',
              borderBottom: '1px solid var(--ggui-color-neutral-200, #e5e7eb)',
              minHeight: 56,
            }}
          >
            <Text variant="h2" style={{ fontSize: 20, fontWeight: 600 }}>
              {mainTitle}
            </Text>
            <Row gap="sm">
              <Button variant="ghost" size="sm">
                Help
              </Button>
              <Button variant="primary" size="sm">
                New
              </Button>
            </Row>
          </Row>
        )}

        {/* Main Body */}
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: 'var(--ggui-spacing-6, 24px)',
          }}
        >
          {mainContent ? (
            mainContent()
          ) : children ? (
            children
          ) : (
            <Stack gap="lg">
              <Row gap="md" style={{ flexWrap: 'wrap' }}>
                {['Total Users', 'Revenue', 'Active Projects', 'Tasks Done'].map((label, i) => (
                  <Card
                    key={label}
                    style={{
                      flex: '1 1 200px',
                      padding: 'var(--ggui-spacing-4, 16px)',
                    }}
                  >
                    <Stack gap="xs">
                      <Text variant="small" style={{ color: 'var(--ggui-color-neutral-500, #6b7280)' }}>
                        {label}
                      </Text>
                      <Text variant="h2" style={{ fontSize: 28, fontWeight: 700 }}>
                        {[1284, '$12.4k', 8, 142][i]}
                      </Text>
                    </Stack>
                  </Card>
                ))}
              </Row>
              <Card style={{ padding: 'var(--ggui-spacing-6, 24px)' }}>
                <Stack gap="md">
                  <Text variant="h3">Recent Activity</Text>
                  <Text variant="body" style={{ color: 'var(--ggui-color-neutral-500, #6b7280)' }}>
                    Your main content goes here. This is a placeholder showing a two-column layout
                    with a sidebar for navigation and a main content area.
                  </Text>
                </Stack>
              </Card>
            </Stack>
          )}
        </div>
      </div>
    </Container>
  );
}

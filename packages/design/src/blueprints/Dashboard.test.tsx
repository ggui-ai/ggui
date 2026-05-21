import { describe, it, expect } from 'vitest';
import React from 'react';
import { Dashboard } from './Dashboard';

describe('Dashboard', () => {
  it('exports Dashboard component', () => {
    expect(Dashboard).toBeDefined();
    expect(typeof Dashboard).toBe('function');
  });

  it('accepts all layout slots', () => {
    const element = React.createElement(Dashboard, {
      header: React.createElement('header', null, 'Dashboard'),
      sidebar: React.createElement('nav', null, 'Menu'),
      stats: React.createElement('div', null, 'Stats'),
      charts: React.createElement('div', null, 'Charts'),
      tables: React.createElement('div', null, 'Tables'),
    });
    expect(element.props.header).toBeDefined();
    expect(element.props.sidebar).toBeDefined();
    expect(element.props.stats).toBeDefined();
    expect(element.props.charts).toBeDefined();
    expect(element.props.tables).toBeDefined();
  });

  it('supports collapsed sidebar', () => {
    const element = React.createElement(Dashboard, {
      sidebar: React.createElement('nav'),
      sidebarCollapsed: true,
      sidebarWidth: '200px',
    });
    expect(element.props.sidebarCollapsed).toBe(true);
  });
});

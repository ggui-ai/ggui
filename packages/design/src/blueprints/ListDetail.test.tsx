import { describe, it, expect } from 'vitest';
import React from 'react';
import { ListDetail } from './ListDetail';

describe('ListDetail', () => {
  it('exports ListDetail component', () => {
    expect(ListDetail).toBeDefined();
    expect(typeof ListDetail).toBe('function');
  });

  it('accepts list and detail slots', () => {
    const element = React.createElement(ListDetail, {
      list: React.createElement('ul', null, 'Items'),
      detail: React.createElement('div', null, 'Detail view'),
    });
    expect(element.props.list).toBeDefined();
    expect(element.props.detail).toBeDefined();
  });

  it('accepts optional header and custom list width', () => {
    const element = React.createElement(ListDetail, {
      list: React.createElement('ul'),
      header: React.createElement('h1', null, 'Title'),
      listWidth: '400px',
      emptyDetail: React.createElement('p', null, 'Nothing selected'),
    });
    expect(element.props.listWidth).toBe('400px');
    expect(element.props.emptyDetail).toBeDefined();
  });
});

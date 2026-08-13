/**
 * Local ambient declarations for `react-test-renderer`.
 *
 * `react-test-renderer@19` does not ship its own types, and there is no
 * matching `@types/react-test-renderer@19` on npm. We only need a tiny
 * surface (`create`, `act`, `ReactTestRenderer.toJSON()`) for the SDK's
 * test files — full fidelity is not required.
 */
declare module 'react-test-renderer' {
  import type { ReactElement } from 'react';

  export interface ReactTestRendererJSON {
    type: string;
    props: Record<string, unknown>;
    children: null | Array<ReactTestRendererJSON | string>;
  }

  export interface ReactTestInstance {
    instance: unknown;
    type: string | { displayName?: string; name?: string };
    props: Record<string, unknown>;
    parent: ReactTestInstance | null;
    children: Array<ReactTestInstance | string>;
    find(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance;
    findAll(predicate: (node: ReactTestInstance) => boolean): ReactTestInstance[];
    findByType(type: unknown): ReactTestInstance;
    findAllByType(type: unknown): ReactTestInstance[];
    findByProps(props: Record<string, unknown>): ReactTestInstance;
    findAllByProps(props: Record<string, unknown>): ReactTestInstance[];
  }

  export interface ReactTestRenderer {
    root: ReactTestInstance;
    toJSON(): ReactTestRendererJSON | ReactTestRendererJSON[] | null;
    toTree(): unknown;
    update(element: ReactElement): void;
    unmount(): void;
  }

  export interface TestRendererOptions {
    createNodeMock?: (element: ReactElement) => unknown;
  }

  export function create(
    element: ReactElement,
    options?: TestRendererOptions,
  ): ReactTestRenderer;

  export function act(callback: () => void | Promise<void>): Promise<void>;
}

/**
 * The todo locators against static DOM: each shape a generated todo UI has
 * taken, plus the shapes the row-with-button leg must refuse. No app boots;
 * each case mounts its DOM in an iframe, the way the journeys see it.
 */
import { test, expect, type Page } from '@playwright/test';
import { findTodoCheckedIndicator, findTodoToggleable } from './todo-locators';

const VISUALLY_HIDDEN =
  'style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)"';

/** One row whose button carries the action label only, with a visually hidden status. */
const buttonRow = (item: string, status: string): string =>
  `<li><span>${item}</span><span ${VISUALLY_HIDDEN}>${status}</span><button>Toggle todo</button></li>`;

/** Three rows, each button named "Toggle todo", under a "N / 3 done" badge. */
const sharedNameList = (milkStatus: 'To do' | 'Done'): string =>
  `<h2>Todo list</h2><span>${milkStatus === 'Done' ? 1 : 0} / 3 done</span><ul>` +
  buttonRow('buy milk', milkStatus) +
  buttonRow('walk the dog', 'To do') +
  buttonRow('write code', 'To do') +
  '</ul>';

/** The loading preview: the same texts in a disabled, aria-busy shell. */
const PREVIEW =
  '<div data-ggui-preview aria-busy="true"><h2>To-do list</h2><ul>' +
  '<li><span>buy milk</span><button disabled>Toggle todo</button></li>' +
  '<li><span>walk the dog</span><button disabled>Toggle todo</button></li></ul></div>';

async function mount(page: Page, html: string) {
  await page.setContent(`<iframe srcdoc='${html.replace(/'/g, '&#39;')}'></iframe>`);
  const frame = page.frameLocator('iframe');
  await frame.locator('body').waitFor();
  return frame;
}

/** The text of the row the found toggle sits in, prefixed CHECKBOX when it is a checkbox. */
async function toggleRow(page: Page, html: string): Promise<string | null> {
  const toggle = findTodoToggleable(await mount(page, html), /buy milk/i);
  if ((await toggle.count()) === 0) return null;
  return toggle.evaluate(
    (el) =>
      (el.matches('input[type=checkbox]') ? 'CHECKBOX ' : '') +
      ((el.closest('li,label') ?? el.parentElement)?.textContent ?? ''),
  );
}

async function checkedCount(page: Page, html: string): Promise<number> {
  return findTodoCheckedIndicator(await mount(page, html), /buy milk/i).count();
}

test.describe('findTodoToggleable', () => {
  test('rows whose buttons all read "Toggle todo": the button in the item’s row', async ({
    page,
  }) => {
    expect(await toggleRow(page, sharedNameList('To do'))).toContain('buy milk');
  });

  test('div rows with role="button": the button in the item’s row', async ({ page }) => {
    const html =
      '<div><div><span>buy milk</span><div role="button" tabindex="0">Toggle todo</div></div>' +
      '<div><span>eggs</span><div role="button" tabindex="0">Toggle todo</div></div></div>';
    expect(await toggleRow(page, html)).toContain('buy milk');
  });

  test('a button named for its item ("Toggle todo: Buy milk")', async ({ page }) => {
    const html =
      '<ul><li>Buy milk <button>Toggle todo: Buy milk</button></li>' +
      '<li>Eggs <button>Toggle todo: Eggs</button></li></ul>';
    expect(await toggleRow(page, html)).toContain('Buy milk');
  });

  test('a labelled checkbox', async ({ page }) => {
    expect(await toggleRow(page, '<label><input type=checkbox> buy milk</label>')).toContain(
      'CHECKBOX',
    );
  });

  test('a checkbox row with a delete button before the checkbox: the checkbox', async ({
    page,
  }) => {
    const html =
      '<ul><li><button>Delete</button><input type=checkbox> buy milk</li>' +
      '<li><button>Delete</button><input type=checkbox> eggs</li></ul>';
    expect(await toggleRow(page, html)).toMatch(/^CHECKBOX .*buy milk/);
  });

  test('the generated list after a loading preview: the generated row’s button', async ({
    page,
  }) => {
    expect(await toggleRow(page, PREVIEW + sharedNameList('To do'))).toContain('buy milk');
  });

  test('the loading preview alone: nothing', async ({ page }) => {
    expect(await toggleRow(page, PREVIEW)).toBeNull();
  });

  test('a row whose only button is disabled: nothing', async ({ page }) => {
    const html = '<ul><li><span>buy milk</span><button disabled>Toggle todo</button></li></ul>';
    expect(await toggleRow(page, html)).toBeNull();
  });

  test('item texts and buttons in separate lists: nothing, rather than another row’s button', async ({
    page,
  }) => {
    const html =
      '<ul><li>buy milk</li><li>eggs</li></ul><div><button>Toggle</button><button>Toggle</button></div>';
    expect(await toggleRow(page, html)).toBeNull();
  });
});

test.describe('findTodoCheckedIndicator', () => {
  test('rows whose buttons all read "Toggle todo": unchecked until the row’s status reads Done', async ({
    page,
  }) => {
    expect(await checkedCount(page, sharedNameList('To do'))).toBe(0);
    expect(await checkedCount(page, sharedNameList('Done'))).toBe(1);
  });

  test('a pressed button in the item’s row reads as checked', async ({ page }) => {
    const list = (pressed: boolean) =>
      `<ul><li><span>buy milk</span> <button aria-pressed="${pressed}">Toggle todo</button></li>` +
      '<li><span>eggs</span> <button aria-pressed="false">Toggle todo</button></li></ul>';
    expect(await checkedCount(page, list(false))).toBe(0);
    expect(await checkedCount(page, list(true))).toBe(1);
  });
});

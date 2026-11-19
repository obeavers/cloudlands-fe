import { test, expect } from '../../test/ct-test';
import Preview from './task-confirmation.preview.svelte';
test.describe.configure({ retries: 0 });
test('requires a reason and shows captured criteria and attached evidence without inventing a reviewer', async ({
  mount,
}) => {
  const card = await mount(Preview);
  await expect(card.getByText('Explain the timeout and its recovery')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Request changes', exact: true })).toBeDisabled();
  await card
    .getByRole('textbox', { name: 'Reason', exact: true })
    .fill('Cover interruption before retry.');
  await card.getByRole('button', { name: 'Request changes', exact: true }).click();
  await expect(card.getByTestId('preview-decision')).toHaveText('request-changes');
  await card.getByRole('button', { name: /The final lost update/ }).click();
  await expect(card.getByText('1 passed')).toBeVisible();
  await expect(card.getByText('Reviewer and triage details are unavailable.')).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Complete without confirmation', exact: true }),
  ).toBeDisabled();
});
test('stale offers require refresh and agent claims never show an observed pass', async ({
  mount,
}) => {
  const card = await mount(Preview, { props: { scene: 'stale' } });
  await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeDisabled();
  await card.getByRole('button', { name: 'Refresh offer', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Confirm result', exact: true })).toBeEnabled();
});
test('confirmation-only receipt preserves separate task, adoption and publication outcomes on a narrow card', async ({
  mount,
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const card = await mount(Preview, { props: { scene: 'confirmation-only' } });
  await expect(card.getByText('Confirmation recorded')).toBeVisible();
  await expect(card.getByText('Task completion was not recorded')).toBeVisible();
  await expect(card.getByText('Source adoption and publication were not requested.')).toBeVisible();
  expect(await card.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await test
    .info()
    .attach('confirmation-only.png', { body: await card.screenshot(), contentType: 'image/png' });
});
test('agent claim detail remains a claim after expansion', async ({ mount }) => {
  const card = await mount(Preview, { props: { scene: 'agent-claim' } });
  await card.getByRole('button', { name: /The final lost update/ }).click();
  await expect(card.getByText('Agent claim').first()).toBeVisible();
  await expect(card.getByText('1 passed')).toHaveCount(0);
});

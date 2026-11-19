import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/svelte';
import TaskConfirmationCard from './TaskConfirmationCard.svelte';
import { confirmationPreviewReview } from './confirmation.preview-fixtures';
afterEach(cleanup);
function card(scene = 'ready') {
  const onDecide = vi.fn(),
    onDraft = vi.fn(),
    onRefresh = vi.fn();
  render(TaskConfirmationCard, {
    review: confirmationPreviewReview(scene),
    onDecide,
    onDraft,
    onRefresh,
  });
  return { onDecide, onDraft, onRefresh };
}
describe('task confirmation product card', () => {
  it('leads with captured outcome and criteria, preserves unknown result/review facts and blocks direct completion', async () => {
    const h = card();
    expect(screen.getByText('Explain the timeout and its recovery')).toBeTruthy();
    expect(screen.getByText('The result narrative is unavailable.')).toBeTruthy();
    expect(screen.getByText('Reviewer and triage details are unavailable.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Complete without confirmation' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Request changes', exact: true }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await fireEvent.input(screen.getByRole('textbox', { name: 'Reason' }), {
      target: { value: 'Cover interruption.' },
    });
    expect(h.onDraft).toHaveBeenCalledWith('Cover interruption.', false);
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm result', exact: true }));
    expect(h.onDecide).toHaveBeenCalledWith('accept');
  });
  it('keeps stale and uncertain offers from deciding', async () => {
    const h = card('stale');
    expect(
      (screen.getByRole('button', { name: 'Confirm result', exact: true }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh offer' }));
    expect(h.onRefresh).toHaveBeenCalledOnce();
    cleanup();
    card('uncertain');
    expect(
      (screen.getByRole('button', { name: 'Confirm result', exact: true }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Refresh offer' })).toBeNull();
  });
  it('does not relabel agent claims as observed checks or passing evidence', () => {
    card('agent-claim');
    expect(screen.getAllByText('Agent claim').length).toBeGreaterThan(0);
    expect(screen.queryByText('Observed check')).toBeNull();
    expect(screen.queryByText('1 passed')).toBeNull();
  });
  it.each(['confirmation-only', 'changes-requested'])(
    'shows only actual returned outcomes for %s',
    (scene) => {
      card(scene);
      expect(screen.getByText('Task completion was not recorded')).toBeTruthy();
      expect(screen.getByText('Source adoption and publication were not requested.')).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Confirm result', exact: true })).toBeNull();
    },
  );
});

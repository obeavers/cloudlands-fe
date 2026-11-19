<script lang="ts">
  import {
    selectTaskConfirmationReview,
    selectTaskConfirmationOffer,
  } from '$store/renderer/slices/task-confirmation/task-confirmation-selectors';
  import { store } from '$store/renderer/store';
  import { onDestroy } from 'svelte';
  import { toStore } from 'svelte/store';
  import { Button } from '$lib/components/ui/button';
  import { ContentDialog } from '$lib/components/patterns/confirm';
  import { m } from '$shared/paraglide/messages.js';
  import {
    taskConfirmationOpened,
    taskConfirmationClosed,
    taskConfirmationDraftChanged,
    taskConfirmationDecideRequested,
    taskConfirmationStale,
    type ConfirmationOwner,
  } from '$store/renderer/slices/task-confirmation/task-confirmation-slice';
  import TaskConfirmationCard from './TaskConfirmationCard.svelte';
  let { workspaceId, noteId, noteRev }: { workspaceId: string; noteId: string; noteRev?: number } =
    $props();
  let owner = $state.raw<ConfirmationOwner | null>(null);
  let open = $state(false);
  const offer = selectTaskConfirmationOffer(
    toStore(() => workspaceId),
    toStore(() => noteId),
    toStore(() => noteRev),
  );
  const review = selectTaskConfirmationReview(toStore(() => workspaceId));
  const currentReview = $derived(
    owner && $review?.owner.reviewId === owner.reviewId ? $review : null,
  );
  function close() {
    if (owner) store.dispatch(taskConfirmationClosed(owner.workspaceId, owner.reviewId));
    owner = null;
    open = false;
  }
  function start() {
    close();
    const selected = $offer;
    if (!selected) return;
    owner = Object.freeze({
      workspaceId,
      noteId,
      reviewId: crypto.randomUUID(),
      offerId: selected.offerId,
      offerDigest: selected.offerDigest,
      completionNoteRev: selected.completionNoteRev,
    });
    store.dispatch(taskConfirmationOpened(workspaceId, owner));
    open = true;
  }
  onDestroy(close);
  $effect(() => {
    if (!owner) return;
    if (owner.workspaceId !== workspaceId || owner.noteId !== noteId) {
      close();
      return;
    }
    // Selector delivery may trail dispatch. Check the canonical named selector
    // before treating an initial null/previous view as owner retirement.
    const current =
      currentReview ?? selectTaskConfirmationReview.select(store.state, owner.workspaceId);
    if (!current || current.owner.reviewId !== owner.reviewId) {
      close();
      return;
    }
    // Keep a successful transition receipt visible after its own note bump.
    if ((current.card?.offer.basis.completionNoteRev ?? owner.completionNoteRev) !== noteRev)
      store.dispatch(taskConfirmationStale(owner.workspaceId, owner));
  });
</script>

{#if $offer}
  <div class="px-4 py-2">
    <Button variant="secondary" onclick={start}>{m.work_confirmation_title_label()}</Button>
  </div>
{/if}
{#if open && owner}
  <ContentDialog
    bind:open
    title={m.work_confirmation_title_label()}
    closeLabel={m.work_confirmation_close_label()}
    onClose={close}
    busy={currentReview?.phase === 'submitting'}
  >
    <TaskConfirmationCard
      review={currentReview}
      onRefresh={start}
      onDraft={(reason, independent) => {
        if (owner)
          store.dispatch(
            taskConfirmationDraftChanged(owner.workspaceId, owner, reason, independent),
          );
      }}
      onDecide={(decision) => {
        if (owner)
          store.dispatch(
            taskConfirmationDecideRequested(
              owner.workspaceId,
              owner,
              decision,
              crypto.randomUUID(),
            ),
          );
      }}
    />
  </ContentDialog>
{/if}

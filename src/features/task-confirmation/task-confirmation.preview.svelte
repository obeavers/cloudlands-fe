<script module lang="ts">
  import { definePreview } from '$lib/component-catalog/preview-definition';
  export const preview = definePreview({
    id: 'task-confirmation',
    title: 'Experimental task confirmation',
    defaultState: 'ready',
    states: {
      ready: { props: { scene: 'ready' } },
      stale: { props: { scene: 'stale' } },
      'missing-evidence': { props: { scene: 'missing-evidence' } },
      'agent-claim': { props: { scene: 'agent-claim' } },
      confirmed: { props: { scene: 'confirmed' } },
      'confirmation-only': { props: { scene: 'confirmation-only' } },
      'changes-requested': { props: { scene: 'changes-requested' } },
      uncertain: { props: { scene: 'uncertain' } },
      unavailable: { props: { scene: 'unavailable' } },
    },
  });
</script>

<script lang="ts">
  import TaskConfirmationCard from './TaskConfirmationCard.svelte';
  import { confirmationPreviewReview } from './confirmation.preview-fixtures';
  let { scene = 'ready' }: { scene?: string } = $props();
  // Named preview only; no backend operation or global service is registered.
  let review = $state.raw(confirmationPreviewReview(scene));
  let lastDecision = $state('');
</script>

<div class="max-w-xl bg-background p-4 text-foreground">
  <TaskConfirmationCard
    {review}
    onDraft={(reason, independentCodeReview) => {
      review = { ...review, reason, independentCodeReview };
    }}
    onDecide={(decision) => {
      lastDecision = decision;
    }}
    onRefresh={() => {
      review = confirmationPreviewReview('ready');
    }}
  />
  {#if lastDecision}<output data-testid="preview-decision">{lastDecision}</output>{/if}
</div>

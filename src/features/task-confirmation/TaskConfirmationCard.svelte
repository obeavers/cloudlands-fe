<script lang="ts">
  import { Button } from '$lib/components/ui/button';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Checkbox } from '$lib/components/ui/checkbox';
  import { Label } from '$lib/components/ui/label';
  import * as Accordion from '$lib/components/ui/accordion';
  import { FormField, FormActions } from '$lib/components/patterns/form';
  import { ListRow } from '$lib/components/patterns/collection';
  import { IntentMarkLoader } from '$lib/components/ui/indicators';
  import { formatInteger } from '$lib/i18n/format';
  import { m } from '$shared/paraglide/messages.js';
  import type { ConfirmationDecisionRequest } from '$shared/types/work';
  import type { TaskConfirmationReview } from '$store/renderer/slices/task-confirmation/task-confirmation-slice';

  let {
    review,
    onDecide,
    onDraft,
    onRefresh,
  }: {
    review: TaskConfirmationReview | null;
    onDecide: (decision: ConfirmationDecisionRequest['decision']) => void;
    onDraft: (reason: string, independentCodeReview: boolean) => void;
    onRefresh: () => void;
  } = $props();
  function observationLabel(outcome: string) {
    if (outcome === 'passed')
      return m.chat_toolDetails_checksPassed_label({ count: formatInteger(1) });
    if (outcome === 'failed') return m.chat_toolCall_failed_label();
    if (outcome === 'cancelled') return m.workspace_taskStatus_cancelled_label();
    if (outcome === 'error') return m.devConsole_error_label();
    return m.work_confirmation_detailsUnknown_label();
  }
  const uid = $props.id();
  const card = $derived(review?.card);
  const task = $derived(card?.task.status === 'available' ? card.task.value : null);
  const ready = $derived(
    review?.phase === 'ready' && !!task && !!review.stateToken && card?.staleness.length === 0,
  );
  const busy = $derived(review?.phase === 'submitting');
  const decided = $derived(review?.outcome?.confirmation.request.decision);
  const outcomeTitle = $derived(
    decided === 'accept'
      ? m.work_confirmation_confirmed_label()
      : decided === 'request-changes'
        ? m.work_confirmation_changesRecorded_label()
        : m.work_confirmation_rejected_label(),
  );
</script>

<section class="min-w-0 space-y-4 text-foreground" aria-label={m.work_confirmation_title_label()}>
  <p class="type-caption text-muted-foreground">{m.work_confirmation_experimental_label()}</p>
  {#if !review || review.phase === 'loading'}
    <div class="flex items-center gap-2 type-body" role="status">
      <IntentMarkLoader class="size-4" />{m.work_confirmation_loading_label()}
    </div>
  {:else if review.phase === 'unavailable'}
    <p class="type-body" role="status">{m.work_confirmation_unavailable_label()}</p>
  {:else}
    {#if review.phase === 'stale'}<p class="type-body text-muted-foreground" role="status">
        {m.work_confirmation_stale_label()}
      </p>{/if}
    {#if review.phase === 'uncertain'}<p class="type-body text-muted-foreground" role="alert">
        {m.work_confirmation_uncertain_label()}
      </p>{/if}
    {#if review.phase === 'settled' && review.outcome}
      <div class="space-y-1" role="status">
        <h3 class="type-title">{outcomeTitle}</h3>
        <p class="type-body">
          {review.outcome.taskTransition
            ? m.work_confirmation_taskComplete_label()
            : m.work_confirmation_taskNotComplete_label()}
        </p>
        <p class="type-caption text-muted-foreground">{m.work_confirmation_separate_label()}</p>
        {#if review.outcome.confirmation.request.reason}<p
            class="type-body whitespace-pre-wrap break-words"
          >
            {review.outcome.confirmation.request.reason}
          </p>{/if}
      </div>
    {/if}
    {#if card}
      <div class="space-y-2">
        <h3 class="type-title break-words">{task?.title || m.work_confirmation_title_label()}</h3>
        <h4 class="type-caption font-medium">{m.work_confirmation_requested_label()}</h4>
        <p class="type-body whitespace-pre-wrap break-words">
          {task?.content || m.work_confirmation_detailsUnknown_label()}
        </p>
        <p class="type-caption text-muted-foreground">
          {m.work_confirmation_resultUnknown_label()}
        </p>
      </div>
      <div>
        <h4 class="type-title">{m.work_confirmation_criteria_label()}</h4>
        {#if task?.criteria.length}
          <Accordion.Root type="multiple">
            {#each task.criteria as criterion (criterion.criterionId)}
              <Accordion.Item value={criterion.criterionId}>
                <Accordion.Trigger
                  ><span class="whitespace-normal break-words">{criterion.text}</span><span
                    class="ml-2 text-muted-foreground"
                    >{card.offer.inputs.outstandingCriteria.includes(criterion.criterionId)
                      ? m.work_confirmation_outstanding_label()
                      : card.offer.inputs.satisfiedCriteria.includes(criterion.criterionId)
                        ? m.work_confirmation_met_label()
                        : m.work_confirmation_unassessed_label()}</span
                  ></Accordion.Trigger
                >
                <Accordion.Content>
                  <p class="type-caption">
                    {m.work_confirmation_required_label({
                      kinds: criterion.requiredKinds.join(', '),
                    })}
                  </p>
                  {#each card.checks.filter((check) => check.detail.status === 'available' && check.detail.value.observation?.coverage.some((coverage) => coverage.criterionId === criterion.criterionId)) as check (check.revision.runId)}
                    {#if check.detail.status === 'available'}
                      {@const run = check.detail.value}
                      <ListRow>
                        {#snippet title()}{run.spec.kind}{/snippet}
                        {#snippet description()}
                          {check.revision.origin === 'agent-claim'
                            ? m.work_confirmation_claim_label()
                            : m.work_confirmation_observed_label()}
                          {#if check.revision.origin === 'runner-observation' && run.observation}
                            · {observationLabel(run.observation.outcome)}
                          {/if}
                        {/snippet}
                      </ListRow>
                    {/if}
                  {:else}
                    <p class="type-caption text-muted-foreground">
                      {m.work_confirmation_detailsUnknown_label()}
                    </p>
                  {/each}
                </Accordion.Content>
              </Accordion.Item>
            {/each}
          </Accordion.Root>
        {:else}<p class="type-caption text-muted-foreground">
            {task
              ? m.work_confirmation_noCriteria_label()
              : m.work_confirmation_detailsUnknown_label()}
          </p>{/if}
      </div>
      <div class="space-y-2">
        <h4 class="type-title">{m.work_confirmation_evidence_label()}</h4>
        {#each card.checks as check (check.revision.runId)}
          <ListRow>
            {#snippet title()}{check.revision.origin === 'runner-observation'
                ? m.work_confirmation_observed_label()
                : m.work_confirmation_claim_label()}{/snippet}
            {#snippet description()}{check.detail.status === 'available'
                ? check.detail.value.spec.kind
                : m.work_confirmation_detailsUnknown_label()}{/snippet}
          </ListRow>
        {/each}
        <h4 class="type-caption font-medium">{m.work_confirmation_concerns_label()}</h4>
        <p class="type-caption text-muted-foreground">
          {m.work_confirmation_reviewUnknown_label()}
        </p>
        {#if card.offer.inputs.outstandingCriteria.length}<p
            class="type-caption text-muted-foreground"
          >
            {m.work_confirmation_outstanding_label()}: {formatInteger(
              card.offer.inputs.outstandingCriteria.length,
            )}
          </p>{/if}
      </div>
      {#if review.phase !== 'settled'}
        <FormField label={m.work_confirmation_reason_label()} disabled={!ready || busy}>
          {#snippet control(props)}<Textarea
              {...props}
              maxlength={4096}
              value={review.reason}
              oninput={(event) => onDraft(event.currentTarget.value, review!.independentCodeReview)}
            />{/snippet}
        </FormField>
        {#if card.offer.inputs.subject.kind === 'source'}
          <div class="flex items-start gap-2">
            <Checkbox
              id={`${uid}-review`}
              checked={review.independentCodeReview}
              disabled={!ready || busy}
              onCheckedChange={(value) => onDraft(review!.reason, value)}
            />
            <Label for={`${uid}-review`} class="type-caption"
              >{m.work_confirmation_independent_label()}</Label
            >
          </div>
        {/if}
        <FormActions>
          {#snippet primary()}<div class="flex min-w-0 flex-wrap justify-end gap-2">
              <Button variant="primary" disabled={!ready || busy} onclick={() => onDecide('accept')}
                >{m.work_confirmation_confirm_label()}</Button
              >
              <Button
                variant="secondary"
                disabled={!ready || busy || !review.reason.trim()}
                onclick={() => onDecide('request-changes')}
                >{m.work_confirmation_changes_label()}</Button
              >
              <Button
                variant="ghost"
                disabled={!ready || busy || !review.reason.trim()}
                onclick={() => onDecide('reject')}>{m.work_confirmation_reject_label()}</Button
              >
            </div>{/snippet}
        </FormActions>
        {#if review.phase === 'stale'}<Button variant="secondary" onclick={onRefresh}
            >{m.work_confirmation_refresh_label()}</Button
          >{/if}
      {/if}
    {/if}
  {/if}
  <div class="space-y-1">
    <Button variant="ghost" disabled aria-describedby={`${uid}-complete-reason`}
      >{m.work_confirmation_complete_label()}</Button
    >
    <p id={`${uid}-complete-reason`} class="type-caption text-muted-foreground">
      {m.work_confirmation_completeWhy_label()}
    </p>
  </div>
</section>

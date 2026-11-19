<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { store as appStore } from '$store/renderer/store';
  import { selectPrincipalActionContext } from '$store/renderer/slices/principal/principal-selectors';
  import {
    taskEvidenceAvailabilityRequested,
    taskEvidenceReadRequested,
  } from '$store/renderer/slices/task-evidence/task-evidence-slice';
  import type {
    TaskEvidenceRequest,
    TaskEvidenceResponse,
    TaskEvidenceRun,
  } from '$shared/types/task-run-evidence';
  import { m } from '$shared/paraglide/messages.js';

  let {
    workspaceId,
    noteId,
    currentNoteRev,
  }: { workspaceId: string; noteId: string; currentNoteRev?: number } = $props();
  let available = $state(false);
  let opened = $state(false);
  let busy = $state(false);
  let error = $state(false);
  let invalidated = $state(false);
  let result = $state.raw<TaskEvidenceResponse | null>(null);
  let owner = $state<string | null>(null);
  let expanded = $state<string | null>(null);
  let contributionPage = $state.raw<TaskEvidenceRun | null>(null);
  let effectPage = $state.raw<TaskEvidenceRun | null>(null);
  let requestId = 0;
  const principal = selectPrincipalActionContext();
  const retired = $derived(invalidated || (result !== null && owner !== $principal));
  const contributionView = $derived(contributionPage ?? (result?.kind === 'run' ? result : null));
  const effectView = $derived(effectPage ?? (result?.kind === 'run' ? result : null));
  onMount(() => {
    let mounted = true;
    void appStore.dispatch(taskEvidenceAvailabilityRequested()).then(
      (supported) => {
        if (mounted) available = supported;
      },
      () => {
        if (mounted) available = false;
      },
    );
    return () => {
      mounted = false;
      requestId++;
    };
  });

  async function read(query: TaskEvidenceRequest['query']) {
    const admission = selectPrincipalActionContext.select(appStore.state);
    if (!admission || busy) return;
    const selected = ++requestId;
    const scope = [workspaceId, noteId];
    opened = true;
    busy = true;
    error = false;
    invalidated = false;
    result = null;
    expanded = null;
    contributionPage = null;
    effectPage = null;
    try {
      const response = await appStore.dispatch(
        taskEvidenceReadRequested({ workspaceId, noteId, query }, admission),
      );
      if (selected !== requestId || workspaceId !== scope[0] || noteId !== scope[1]) return;
      if (admission !== selectPrincipalActionContext.select(appStore.state)) {
        invalidated = true;
        return;
      }
      owner = admission;
      result = response;
    } catch {
      if (selected === requestId) {
        invalidated = admission !== selectPrincipalActionContext.select(appStore.state);
        error = !invalidated;
      }
    } finally {
      if (selected === requestId) busy = false;
    }
  }

  function runs() {
    return read({ kind: 'runs', limit: 20 });
  }
  async function nextCategory(category: 'contributions' | 'effects') {
    const original = result;
    const page = category === 'contributions' ? contributionView : effectView;
    const after = page?.next[category];
    const admission = selectPrincipalActionContext.select(appStore.state);
    if (!original || original.kind !== 'run' || !after || busy || !admission || owner !== admission)
      return;
    const selected = ++requestId;
    busy = true;
    error = false;
    try {
      const response = await appStore.dispatch(
        taskEvidenceReadRequested(
          {
            workspaceId,
            noteId,
            query: {
              kind: 'run',
              agentId: original.run.agentId,
              page: { after: { [category]: after }, limit: 20 },
            },
          },
          admission,
        ),
      );
      if (selected !== requestId) return;
      if (admission !== selectPrincipalActionContext.select(appStore.state)) {
        invalidated = true;
        return;
      }
      if (
        response.kind !== 'run' ||
        response.binding.bindingId !== original.binding.bindingId ||
        JSON.stringify(response.run.taskRevision) !== JSON.stringify(original.run.taskRevision)
      )
        throw new Error('Task evidence page owner changed');
      // Each category retains its own server snapshot and cursor. An exhausted
      // category is never restarted while the other category advances.
      if (category === 'contributions') contributionPage = response;
      else effectPage = response;
      expanded = null;
    } catch {
      if (selected === requestId) {
        invalidated = admission !== selectPrincipalActionContext.select(appStore.state);
        error = !invalidated;
      }
    } finally {
      if (selected === requestId) busy = false;
    }
  }
</script>

{#if available}
  <section class="mt-3 min-w-0 space-y-3" aria-label={m.task_evidence_title_label()}>
    {#if !opened}
      <Button variant="ghost" size="sm" onclick={runs}>{m.task_evidence_open_label()}</Button>
    {:else}
      <div class="flex items-center justify-between gap-2">
        <h3 class="type-body font-medium">{m.task_evidence_title_label()}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => {
            opened = false;
            result = null;
          }}
        >
          {m.task_evidence_close_label()}
        </Button>
      </div>
      {#if busy}<p class="type-caption text-muted-foreground" role="status">
          {m.task_evidence_loading_description()}
        </p>
      {:else if retired}
        <p class="type-caption text-muted-foreground" role="status">
          {m.task_evidence_retired_error()}
        </p>
        <Button variant="secondary" size="sm" onclick={runs}
          >{m.task_evidence_refresh_label()}</Button
        >
      {:else if error}
        <p class="type-caption text-danger" role="alert">{m.task_evidence_read_error()}</p>
        <Button variant="secondary" size="sm" onclick={runs}
          >{m.task_evidence_refresh_label()}</Button
        >
      {:else if result?.kind === 'runs'}
        <p class="type-caption text-muted-foreground">{m.task_evidence_history_description()}</p>
        {#if result.runs.length === 0}<p class="type-body">
            {m.task_evidence_emptyRuns_description()}
          </p>{/if}
        <ul class="space-y-2">
          {#each result.runs as run (run.agentId)}
            <li class="space-y-1 rounded border border-border p-3">
              <p class="type-caption break-all">{m.task_evidence_agent_label()}: {run.agentId}</p>
              <p class="type-caption">
                {m.task_evidence_revision_label({ revision: String(run.taskRevision.rev) })}
              </p>
              {#if run.admission.status === 'admitted'}
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => read({ kind: 'run', agentId: run.agentId, page: { limit: 20 } })}
                  >{m.task_evidence_viewTurn_label()}</Button
                >
              {:else}<p class="type-caption text-muted-foreground">
                  {m.task_evidence_pending_description()}
                </p>{/if}
            </li>
          {/each}
        </ul>
        <p class="type-caption text-muted-foreground">
          {result.coverage.retainedPageComplete && !result.coverage.byteLimited
            ? m.task_evidence_completePage_description()
            : m.task_evidence_partialPage_description()}
        </p>
        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onclick={runs}
            >{m.task_evidence_refresh_label()}</Button
          >
          {#if result.next}<Button
              variant="secondary"
              size="sm"
              onclick={() => {
                if (result?.kind === 'runs' && result.next)
                  void read({ kind: 'runs', after: result.next, limit: 20 });
              }}>{m.task_evidence_next_label()}</Button
            >{/if}
        </div>
      {:else if result?.kind === 'run'}
        <p class="type-body text-muted-foreground">{m.task_evidence_firstTurn_description()}</p>
        <dl class="type-caption space-y-1">
          <div>
            <dt class="text-muted-foreground">{m.task_evidence_agent_label()}</dt>
            <dd class="break-all">{result.run.agentId}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">
              {m.task_evidence_revision_label({ revision: String(result.run.taskRevision.rev) })}
            </dt>
            <dd class="break-all">{result.run.taskRevision.digest}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{m.task_evidence_binding_label()}</dt>
            <dd class="break-all">{result.binding.bindingId}</dd>
          </div>
          <div>
            <dt class="text-muted-foreground">{m.task_evidence_attempt_label()}</dt>
            <dd class="break-all">{result.binding.turnAttempt}</dd>
          </div>
        </dl>
        {#if currentNoteRev !== undefined}<p class="type-caption text-muted-foreground">
            {m.task_evidence_currentRevision_description({ revision: String(currentNoteRev) })}
          </p>{/if}
        <p class="type-caption text-muted-foreground">
          {m.task_evidence_sourceRelation_description()}
        </p>
        {#if result.source.status === 'available'}
          <h4 class="type-body font-medium">{m.task_evidence_sourcePreview_label()}</h4>
          <p class="type-body whitespace-pre-wrap break-words">{result.source.titlePreview}</p>
          <ol class="list-decimal space-y-2 pl-5">
            {#each result.source.criteria as criterion (criterion.index)}
              <li class="type-caption whitespace-pre-wrap break-words">
                {criterion.textPreview}
                <span class="block break-all text-muted-foreground">{criterion.textDigest}</span>
                {#if criterion.requiredKinds.length}<span class="block text-muted-foreground"
                    >{m.task_plan_kinds_label()}: {criterion.requiredKinds.join(', ')}</span
                  >{/if}
              </li>
            {/each}
          </ol>
          {#if result.source.titleTruncated || result.source.criteriaOmitted > 0 || result.source.criteria.some((criterion) => criterion.textTruncated)}<p
              class="type-caption text-muted-foreground"
            >
              {m.task_evidence_previewLimited_description()}
            </p>{/if}
        {:else}<p class="type-caption text-muted-foreground">
            {m.task_evidence_sourceUnavailable_description()}
          </p>{/if}
        <h4 class="type-body font-medium">{m.task_evidence_contributions_label()}</h4>
        {#if contributionView?.contributions.length === 0}<p class="type-caption">
            {m.task_evidence_emptyPage_description()}
          </p>{/if}
        <ul class="space-y-2">
          {#each contributionView?.contributions ?? [] as contribution (contribution.operationId)}
            <li class="space-y-1 rounded border border-border p-3">
              <Button
                variant="ghost"
                size="sm"
                onclick={() => {
                  expanded =
                    expanded === `record:${contribution.operationId}`
                      ? null
                      : `record:${contribution.operationId}`;
                }}>{m.task_evidence_record_label({ operation: contribution.operationId })}</Button
              >
              <p class="type-caption text-muted-foreground">
                {contribution.provenance === 'recordingGovernanceOnlySharedWorkingCopy'
                  ? m.task_evidence_sharedProvenance_description()
                  : m.task_evidence_historicalProvenance_description()}
              </p>
              {#if expanded === `record:${contribution.operationId}`}
                <dl class="type-caption space-y-1 break-all">
                  <div>
                    <dt>{m.task_evidence_change_label()}</dt>
                    <dd>
                      {contribution.change.kind === 'git'
                        ? contribution.change.commit
                        : contribution.change.change}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.task_evidence_root_label()}</dt>
                    <dd>
                      {contribution.root.repositoryId} / {contribution.root.rootId} / {contribution
                        .root.rootEpoch}
                    </dd>
                  </div>
                  <div>
                    <dt>{m.task_evidence_digest_label()}</dt>
                    <dd>{contribution.receiptDigest}</dd>
                  </div>
                  <div>
                    <dt>{m.task_evidence_recordedAt_label()}</dt>
                    <dd>{contribution.recordedAt}</dd>
                  </div>
                </dl>
              {/if}
            </li>
          {/each}
        </ul>
        <p class="type-caption text-muted-foreground">
          {contributionView?.coverage.contributions.retainedPageComplete &&
          !contributionView?.coverage.contributions.byteLimited
            ? m.task_evidence_completePage_description()
            : m.task_evidence_partialPage_description()}
        </p>
        {#if contributionView?.next.contributions}<Button
            variant="secondary"
            size="sm"
            onclick={() => nextCategory('contributions')}
            >{m.task_evidence_moreContributions_label()}</Button
          >{/if}
        <h4 class="type-body font-medium">{m.task_evidence_effects_label()}</h4>
        <p class="type-caption text-muted-foreground">{m.task_evidence_effects_description()}</p>
        {#if effectView?.effects.length === 0}<p class="type-caption">
            {m.task_evidence_emptyPage_description()}
          </p>{/if}
        <ul class="space-y-2">
          {#each effectView?.effects ?? [] as effect (effect.operationId)}
            <li class="space-y-1 rounded border border-border p-3">
              <Button
                variant="ghost"
                size="sm"
                onclick={() => {
                  expanded =
                    expanded === `effect:${effect.operationId}`
                      ? null
                      : `effect:${effect.operationId}`;
                }}>{m.task_evidence_effect_label({ operation: effect.operationId })}</Button
              >
              {#if expanded === `effect:${effect.operationId}`}<dl
                  class="type-caption space-y-1 break-all"
                >
                  <div>
                    <dt>{m.task_evidence_grant_label()}</dt>
                    <dd>{effect.grantId}</dd>
                  </div>
                  <div>
                    <dt>{m.task_evidence_digest_label()}</dt>
                    <dd>{effect.effectDigest}</dd>
                  </div>
                  <div>
                    <dt>{m.task_evidence_recordedAt_label()}</dt>
                    <dd>{effect.committedAt}</dd>
                  </div>
                </dl>{/if}
            </li>
          {/each}
        </ul>
        <p class="type-caption text-muted-foreground">
          {effectView?.coverage.effects.retainedPageComplete &&
          !effectView?.coverage.effects.byteLimited
            ? m.task_evidence_completePage_description()
            : m.task_evidence_partialPage_description()}
        </p>
        {#if effectView?.next.effects}<Button
            variant="secondary"
            size="sm"
            onclick={() => nextCategory('effects')}>{m.task_evidence_moreEffects_label()}</Button
          >{/if}
        <p class="type-caption text-muted-foreground">{m.task_evidence_unlinked_description()}</p>
        <div class="flex flex-wrap gap-2">
          <Button variant="secondary" size="sm" onclick={runs}
            >{m.task_evidence_back_label()}</Button
          >
        </div>
      {/if}
    {/if}
  </section>
{/if}

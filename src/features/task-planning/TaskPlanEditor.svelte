<script lang="ts">
  import { onMount } from 'svelte';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Textarea } from '$lib/components/ui/textarea';
  import { Select } from '$lib/components/ui/select';
  import { FormField, FormActions } from '$lib/components/patterns/form';
  import type { Note } from '$shared/types';
  import type { TaskPlanConfirmation } from '$lib/client/app-client';
  import { m } from '$shared/paraglide/messages.js';
  import { store as appStore } from '$store/renderer/store';
  import { selectPrincipalActionContext } from '$store/renderer/slices/principal/principal-selectors';
  import {
    taskPlanOpened,
    taskPlanConfirmed,
    taskPlanAvailabilityRequested,
  } from '$store/renderer/slices/task-planning/task-planning-slice';
  import { runAgentForNoteRequested } from '$store/renderer/slices/workspace-agents/workspace-agents-slice';
  import {
    prepareTaskPlan,
    taskPlanDraft,
    taskPlanSourceKey,
    type TaskPlanDraft,
    type TaskPlanSubmission,
  } from './task-plan-draft';

  let { note, workspaceId }: { note: Note; workspaceId: string } = $props();
  let source = $state<Note | null>(null);
  let draft = $state<TaskPlanDraft>({ purpose: 'source', criteria: [], files: [] });
  let review = $state<TaskPlanSubmission | null>(null);
  let confirmed = $state<TaskPlanConfirmation | null>(null);
  let busy = $state(false);
  let error = $state('');
  let available = $state(false);
  let admission = $state<string | null>(null);
  const principal = selectPrincipalActionContext();
  onMount(() => {
    let current = true;
    // The saga reads the existing hello once; this does not send a capability RPC.
    void appStore.dispatch(taskPlanAvailabilityRequested(workspaceId)).then(
      (supported) => {
        if (current) available = supported;
      },
      () => {
        if (current) available = false;
      },
    );
    return () => {
      current = false;
    };
  });
  const stale = $derived(
    source !== null &&
      (admission !== $principal || taskPlanSourceKey(source) !== taskPlanSourceKey(note)),
  );
  function ownsSource() {
    return (
      source !== null &&
      admission !== null &&
      admission === selectPrincipalActionContext.select(appStore.state)
    );
  }
  const purposes = $derived([
    { value: 'source', label: m.task_plan_source_label() },
    { value: 'research', label: m.task_plan_research_label() },
    { value: 'review', label: m.task_plan_reviewPurpose_label() },
  ]);
  const roles = $derived([
    { value: 'reference', label: m.task_plan_reference_label() },
    { value: 'in-scope', label: m.task_plan_inScope_label() },
    { value: 'out-of-scope', label: m.task_plan_outOfScope_label() },
  ]);

  async function load(preserveDraft: boolean) {
    if (busy) return;
    const captured = selectPrincipalActionContext.select(appStore.state);
    if (!captured) {
      error = m.task_plan_unavailable_error();
      return;
    }
    const identity = [workspaceId, note.id];
    busy = true;
    error = '';
    try {
      const loaded = await appStore.dispatch(taskPlanOpened(workspaceId, note.id, captured));
      if (
        workspaceId !== identity[0] ||
        note.id !== identity[1] ||
        captured !== selectPrincipalActionContext.select(appStore.state)
      )
        return;
      admission = captured;
      source = loaded;
      if (!preserveDraft) draft = taskPlanDraft(loaded);
      review = null;
      confirmed = null;
    } catch {
      error = m.task_plan_unavailable_error();
    } finally {
      busy = false;
    }
  }

  function open() {
    return load(false);
  }
  function reload() {
    return load(true);
  }

  async function preview() {
    if (!source || busy || stale || !ownsSource()) return;
    busy = true;
    error = '';
    try {
      review = await prepareTaskPlan(source, draft);
    } catch {
      error = m.task_plan_invalid_error();
    } finally {
      busy = false;
    }
  }

  async function confirm() {
    if (!source || !review || stale || busy || !ownsSource() || !admission) return;
    const identity = [workspaceId, note.id];
    busy = true;
    error = '';
    try {
      const result = await appStore.dispatch(
        taskPlanConfirmed({ workspaceId, noteId: source.id, ...review }, admission),
      );
      if (workspaceId !== identity[0] || note.id !== identity[1] || !ownsSource()) return;
      source = result.note;
      confirmed = result;
      review = null;
    } catch {
      error = m.task_plan_save_error();
    } finally {
      busy = false;
    }
  }

  function run() {
    if (!confirmed || stale || busy || !ownsSource()) return;
    appStore.dispatch(
      runAgentForNoteRequested(
        workspaceId,
        confirmed.note.id,
        confirmed.note.title,
        confirmed.taskRevision,
        admission ?? undefined,
      ),
    );
  }
</script>

{#if available}
  <section class="mt-3 min-w-0 space-y-3" aria-label={m.task_plan_title_label()}>
    {#if !source}
      <Button variant="ghost" size="sm" disabled={busy} onclick={open}
        >{m.task_plan_edit_label()}</Button
      >
    {:else}
      <h3 class="type-body font-medium">{m.task_plan_title_label()}</h3>
      {#if stale}
        <p class="type-caption text-muted-foreground" role="status">{m.task_plan_stale_error()}</p>
        <Button variant="secondary" size="sm" disabled={busy} onclick={reload}
          >{m.task_plan_reload_label()}</Button
        >
      {:else if confirmed}
        <p class="type-body text-muted-foreground">{m.task_plan_confirmed_description()}</p>
        <FormActions>
          {#snippet secondary()}<Button variant="secondary" size="sm" disabled={busy} onclick={open}
              >{m.task_plan_edit_label()}</Button
            >{/snippet}
          {#snippet primary()}<Button size="sm" disabled={busy} onclick={run}
              >{m.task_plan_run_label()}</Button
            >{/snippet}
        </FormActions>
      {:else if review}
        <p class="type-body text-muted-foreground">{m.task_plan_confirmation_description()}</p>
        <h4 class="type-body font-medium">{source.title}</h4>
        <pre class="type-caption whitespace-pre-wrap break-words">{source.content}</pre>
        <p class="type-caption">
          {purposes.find((item) => item.value === review?.workDefinition.purpose)?.label}
        </p>
        <ol class="list-decimal space-y-2 pl-5">
          {#each review.acceptanceCriteria as criterion, index}
            <li class="type-body whitespace-pre-wrap break-words">
              {criterion}
              <span class="type-caption block text-muted-foreground"
                >{m.task_plan_kinds_label()}: {review.workDefinition.criteria
                  .find((item) => item.index === index)
                  ?.requiredKinds.join(', ') || m.task_plan_none_label()}</span
              >
            </li>
          {/each}
        </ol>
        {#each review.workDefinition.files as file}
          <p class="type-caption break-words">
            {file.rootId}/{file.path} · {roles.find((item) => item.value === file.role)?.label}
          </p>
        {/each}
        <FormActions>
          {#snippet secondary()}<Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onclick={() => {
                review = null;
              }}>{m.task_plan_back_label()}</Button
            >{/snippet}
          {#snippet primary()}<Button size="sm" disabled={busy} onclick={confirm}
              >{m.task_plan_confirm_label()}</Button
            >{/snippet}
        </FormActions>
      {:else}
        <FormField label={m.task_plan_purpose_label()} disabled={busy}>
          {#snippet control(props)}
            <Select.Root bind:value={draft.purpose} items={purposes} disabled={busy}>
              <Select.Trigger {...props}><Select.Value /></Select.Trigger>
              <Select.Content
                >{#each purposes as item}<Select.Item value={item.value}>{item.label}</Select.Item
                  >{/each}</Select.Content
              >
            </Select.Root>
          {/snippet}
        </FormField>
        {#each draft.criteria as criterion, index}
          <div class="space-y-2 rounded border border-border p-3">
            <FormField label={m.task_plan_criterion_label()} disabled={busy}>
              {#snippet control(props)}<Textarea {...props} bind:value={criterion.text} />{/snippet}
            </FormField>
            <FormField
              label={m.task_plan_kinds_label()}
              description={m.task_plan_kinds_description()}
              disabled={busy}
            >
              {#snippet control(props)}<Input
                  {...props}
                  bind:value={criterion.requiredKinds}
                />{/snippet}
            </FormField>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => {
                draft.criteria = draft.criteria.filter((_, i) => i !== index);
              }}>{m.task_plan_remove_label()}</Button
            >
          </div>
        {/each}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || draft.criteria.length >= 128}
          onclick={() => {
            draft.criteria = [...draft.criteria, { text: '', requiredKinds: '' }];
          }}>{m.task_plan_addCriterion_label()}</Button
        >
        <p class="type-caption text-muted-foreground">{m.task_plan_files_description()}</p>
        {#each draft.files as file, index}
          <div class="space-y-2 rounded border border-border p-3">
            <FormField label={m.task_plan_root_label()} disabled={busy}>
              {#snippet control(props)}<Input {...props} bind:value={file.rootId} />{/snippet}
            </FormField>
            <FormField label={m.task_plan_path_label()} disabled={busy}>
              {#snippet control(props)}<Input {...props} bind:value={file.path} />{/snippet}
            </FormField>
            <FormField label={m.task_plan_role_label()} disabled={busy}>
              {#snippet control(props)}
                <Select.Root bind:value={file.role} items={roles} disabled={busy}>
                  <Select.Trigger {...props}><Select.Value /></Select.Trigger>
                  <Select.Content
                    >{#each roles as item}<Select.Item value={item.value}>{item.label}</Select.Item
                      >{/each}</Select.Content
                  >
                </Select.Root>
              {/snippet}
            </FormField>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => {
                draft.files = draft.files.filter((_, i) => i !== index);
              }}>{m.task_plan_remove_label()}</Button
            >
          </div>
        {/each}
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || draft.files.length >= 512}
          onclick={() => {
            draft.files = [...draft.files, { rootId: '', path: '', role: 'reference' }];
          }}>{m.task_plan_addFile_label()}</Button
        >
        <FormActions>
          {#snippet secondary()}<Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onclick={() => {
                source = null;
              }}>{m.task_plan_cancel_label()}</Button
            >{/snippet}
          {#snippet primary()}<Button size="sm" disabled={busy} onclick={preview}
              >{m.task_plan_review_label()}</Button
            >{/snippet}
        </FormActions>
      {/if}
    {/if}
    {#if error}<p class="type-caption text-danger" role="alert">{error}</p>{/if}
    {#if error && source && !stale}
      <Button variant="secondary" size="sm" disabled={busy} onclick={reload}
        >{m.task_plan_reload_label()}</Button
      >
    {/if}
  </section>
{/if}

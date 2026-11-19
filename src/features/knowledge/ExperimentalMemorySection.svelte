<script lang="ts">
  import { store as appStore } from '$store/renderer/store';
  import { selectMemoryReadViews } from '$store/renderer/slices/memory-read/memory-read-selectors';
  import {
    memoryReadMounted,
    memoryReadUnmounted,
    memoryReadRequested,
  } from '$store/renderer/slices/memory-read/memory-read-slice';
  import { Button } from '$lib/components/ui/button';
  import { ListRow, ListView } from '$lib/components/patterns/collection';
  import SidebarGroupHeader from '$lib/components/workspace/sidebar/SidebarGroupHeader.svelte';
  import { m } from '$shared/paraglide/messages.js';

  let { workspaceId }: { workspaceId: string } = $props();
  let viewId = $state(crypto.randomUUID());
  const memoryViews = selectMemoryReadViews();
  let expanded = $state(false);
  const view = $derived($memoryViews[workspaceId]);
  const items = $derived(view?.items ?? []);
  $effect(() => {
    const originalWorkspace = workspaceId;
    const originalView = viewId;
    expanded = false;
    appStore.dispatch(memoryReadMounted(originalWorkspace, originalView));
    return () => {
      appStore.dispatch(memoryReadUnmounted(originalWorkspace, originalView));
    };
  });
  function read(after?: string) {
    appStore.dispatch(memoryReadRequested(workspaceId, viewId, after));
  }
  function refresh() {
    if (view?.status === 'retired') {
      expanded = false;
      viewId = crypto.randomUUID();
    } else read();
  }
  const kinds = {
    decision: () => m.experimental_memory_decision_label(),
    lesson: () => m.experimental_memory_lesson_label(),
    constraint: () => m.experimental_memory_constraint_label(),
    preference: () => m.experimental_memory_preference_label(),
    context: () => m.experimental_memory_context_label(),
  };
  const statuses = {
    proposed: () => m.experimental_memory_proposed_label(),
    accepted: () => m.experimental_memory_accepted_label(),
    superseded: () => m.experimental_memory_superseded_label(),
  };
</script>

{#if view && view.viewId === viewId && view.status !== 'unavailable'}
  <section class="mt-2 min-w-0" aria-label={m.experimental_memory_title_label()}>
    <SidebarGroupHeader
      title={m.experimental_memory_title_label()}
      {expanded}
      onclick={() => {
        expanded = !expanded;
        if (expanded && view?.status === 'ready') read();
      }}
    />
    {#if expanded}
      <div class="space-y-2 px-2 py-2">
        <p class="type-caption text-muted-foreground">
          {m.experimental_memory_provenance_description()}
        </p>
        {#if view.status === 'reading'}
          <p class="type-caption text-muted-foreground" role="status">
            {m.experimental_memory_loading_description()}
          </p>
        {:else if view.status === 'retired'}
          <p class="type-caption text-muted-foreground" role="status">
            {m.experimental_memory_retired_description()}
          </p>
          <Button variant="secondary" size="sm" onclick={refresh}
            >{m.experimental_memory_refresh_label()}</Button
          >
        {:else if view.status === 'error'}
          <p class="type-caption text-danger" role="alert">
            {m.experimental_memory_error_description()}
          </p>
          <Button variant="secondary" size="sm" onclick={refresh}
            >{m.experimental_memory_refresh_label()}</Button
          >
        {:else if view.status === 'page'}
          <ListView
            {items}
            getKey={(item) => item.id}
            ariaLabel={m.experimental_memory_title_label()}
          >
            {#snippet empty()}<p class="type-caption text-muted-foreground">
                {m.experimental_memory_empty_description()}
              </p>{/snippet}
            {#snippet row({ item })}
              <ListRow class="px-0">
                {#snippet title()}{kinds[item.value.candidate.kind]()}{/snippet}
                {#snippet meta()}{statuses[item.value.status]()}{/snippet}
                {#snippet description()}
                  <p class="whitespace-pre-wrap break-words">{item.value.candidate.preview}</p>
                  <p>
                    {m.experimental_memory_revision_label({
                      revision: String(item.value.candidate.reference.revision),
                    })} · {item.value.scope.visibility === 'owner-private'
                      ? m.experimental_memory_private_label()
                      : m.experimental_memory_shared_label()}
                  </p>
                {/snippet}
              </ListRow>
            {/snippet}
          </ListView>
          <p class="type-caption text-muted-foreground">
            {m.experimental_memory_preview_description()}
          </p>
          <div class="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" onclick={refresh}
              >{m.experimental_memory_refresh_label()}</Button
            >
            {#if view.nextCursor}<Button
                variant="secondary"
                size="sm"
                onclick={() => read(view?.nextCursor ?? undefined)}
                >{m.experimental_memory_next_label()}</Button
              >{/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>
{/if}

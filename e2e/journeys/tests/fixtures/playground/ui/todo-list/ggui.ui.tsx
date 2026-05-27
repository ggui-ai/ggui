/**
 * Todo list blueprint component — paired with ggui.ui.json.
 *
 * Two render paths, one component:
 *
 * 1. **Live wire** (session-backed mount) — `useStream('tasks')` binds
 *    to the `tasks` channel the Slice-11.5 wiredActionRouter refreshes
 *    on every action; `useAction('createTask')` + `useAction('toggleTask')`
 *    fire `data:submit` envelopes the router dispatches to the Tasks
 *    MCP's `tasks_create` / `tasks_complete` tools in-process. No
 *    agent code, no useEffect polling — the contract is the
 *    implementation.
 *
 * 2. **Static preview** (BlueprintViewer / `/preview/todo-list`) — the
 *    wire hooks are data-url shims that gracefully no-op when no
 *    render provider is mounted. `useStream` returns `{latest:
 *    null, all: [], isComplete: false}`; `useAction` returns a no-op
 *    dispatcher. The component detects the empty-stream state and
 *    paints the "no tasks yet" copy, so the blueprint renders
 *    standalone without a live session.
 *
 * The declared contract (see sibling ggui.ui.json):
 *
 *   actionSpec.createTask → tasks_create
 *   actionSpec.toggleTask → tasks_complete
 *   streamSpec.tasks      → refreshed from tasks_list on
 *                                    every wired action (mode: append)
 */
import { useState } from 'react';
import { useAction, useStream } from '@ggui-ai/wire';

interface Task {
  readonly id: string;
  readonly title: string;
  readonly status: 'todo' | 'done';
}

interface TasksPayload {
  readonly items: readonly Task[];
}

export default function TodoList(): JSX.Element {
  const [draft, setDraft] = useState('');

  // Session-bound subscription. The refresh tool (tasks_list) returns
  // `{items: Task[]}` on every wired-action completion — the channel
  // is declared mode:'append', so `.latest` gives the most-recent
  // snapshot and `.all` carries the history. We read `.latest?.items`
  // and fall back to an empty array when no session is bound OR no
  // refresh has fired yet (fresh subscriber / cold blueprint preview).
  const stream = useStream<TasksPayload>('tasks');
  const tasks: readonly Task[] = stream.latest?.items ?? [];

  // useAction returns a fire-and-forget dispatcher in both session
  // and standalone modes. Standalone mode is a no-op — the blueprint
  // preview renders without error even when the operator tries to
  // interact.
  const createTask = useAction<{ title: string }>('createTask');
  const toggleTask = useAction<{ id: string }>('toggleTask');

  return (
    <article
      data-testid="todo-list-blueprint"
      style={{ fontFamily: 'system-ui', maxWidth: 480 }}
    >
      <header style={{ marginBottom: 16 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Todo list</h1>
        <p style={{ color: '#666', fontSize: 13, margin: '4px 0 0' }}>
          Wired to the Tasks MCP (<code>tasks_create</code> +{' '}
          <code>tasks_complete</code>).
        </p>
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          const title = draft.trim();
          if (title.length === 0) return;
          // Fires a `data:submit` envelope with `action: 'createTask'`.
          // The server validates against actionSpec + routes to the
          // `tasks_create` tool via the wiredActionRouter. The refresh
          // pass then calls `tasks_list` and emits on `tasks`, which
          // flips the `useStream` subscriber below.
          createTask({ title });
          setDraft('');
        }}
        style={{ display: 'flex', gap: 8, marginBottom: 16 }}
      >
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Add a task…"
          aria-label="new task"
          style={{
            flex: 1,
            padding: '8px 12px',
            border: '1px solid #ccc',
            borderRadius: 4,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          style={{
            padding: '8px 16px',
            background: '#292929',
            color: '#fff',
            border: 0,
            borderRadius: 4,
            cursor: 'pointer',
            fontSize: 14,
          }}
        >
          add
        </button>
      </form>

      <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {tasks.length === 0 ? (
          <li
            data-ggui-tasks-state="empty"
            style={{
              padding: '12px 0',
              color: '#888',
              fontSize: 13,
              fontStyle: 'italic',
            }}
          >
            No tasks yet. Static preview renders without a session —
            mount via <code>Try live →</code> (or push from an agent)
            to see tasks stream in from the Tasks MCP.
          </li>
        ) : (
          tasks.map((task) => (
            <li
              key={task.id}
              data-task-id={task.id}
              data-task-status={task.status}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid #eee',
              }}
            >
              <input
                type="checkbox"
                checked={task.status === 'done'}
                onChange={() => {
                  // Fires `data:submit` with `action: 'toggleTask'` →
                  // `tasks_complete` via the router. Current-state
                  // read (`checked` above) comes from the most-recent
                  // stream snapshot, so the UI is never the source of
                  // truth — we dispatch intent and let the refresh
                  // drive the repaint.
                  toggleTask({ id: task.id });
                }}
                aria-label={`toggle ${task.title}`}
              />
              <span
                style={{
                  flex: 1,
                  textDecoration:
                    task.status === 'done' ? 'line-through' : 'none',
                  color: task.status === 'done' ? '#999' : '#222',
                }}
              >
                {task.title}
              </span>
            </li>
          ))
        )}
      </ul>
    </article>
  );
}

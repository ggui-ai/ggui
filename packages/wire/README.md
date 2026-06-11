# @ggui-ai/wire

Runtime React hooks that connect a ggui-generated component to its agent. This is the package the generated component code imports — `useAction` to send a user gesture, `useStream` to receive live updates — so the LLM never writes transport, polling, or event-handler glue.

```bash
npm install @ggui-ai/wire
```

`react` (`^18` or `^19`) is a peer dependency.

## How it fits

A ggui component runs inside an iframe wired to a live channel. `GguiWireProvider` injects the channel config; the hooks read it from context. Every hook is a thin, typed binding over that channel — no SDK, no manual subscriptions.

```tsx
import { GguiWireProvider, useAction, useStream } from "@ggui-ai/wire";

interface Todo {
  id: string;
  title: string;
}

function TodoList() {
  const addTodo = useAction<{ title: string }>("addTodo"); // fires an ActionEnvelope to the agent
  const { all } = useStream<Todo>("todos"); // receives StreamEnvelopes from the agent

  return (
    <>
      <button onClick={() => addTodo({ title: "Buy milk" })}>Add</button>
      <ul>
        {all.map((t) => (
          <li key={t.id}>{t.title}</li>
        ))}
      </ul>
    </>
  );
}
```

## Exports

| Symbol                                                         | What it is                                                                               |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `GguiWireProvider`                                             | Context provider — injects the live-channel `WireConfig`                                 |
| `useAction(name)`                                              | Returns a callback that fires a named action to the agent                                |
| `useStream(name)`                                              | Subscribes to a named agent stream channel                                               |
| `useContract(contract)`                                        | Contract-aware hook factory — autocompletes names, infers payloads                       |
| `useApp` / `useRender` / `useAuth`                             | Read app / render / auth info from the live channel                                      |
| `useGguiContext`                                               | Read `[value, setter]` for a declared `contextSpec` slot (client → agent mirrored state) |
| `buildActionEnvelope`, `validateOutbound*`, `validateInbound*` | Envelope build + contract-validation helpers                                             |

`useContract` gives you fully typed hooks: pass a `defineContract()` literal and action names autocomplete with payload types inferred from the contract's JSON Schemas.

## License

Apache-2.0.

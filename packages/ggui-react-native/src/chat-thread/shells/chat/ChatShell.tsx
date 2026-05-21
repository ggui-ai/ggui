/**
 * ChatShell — THREAD-backed reference chat UI (RN twin).
 *
 * ─────────────────────────────────────────────────────────────────────
 * ONE ChatShell lives in @ggui-ai/react-native (this file).
 * The web package ships TWO: a legacy session-backed shell at
 * `packages/ggui-react/src/shells/ChatShell.tsx` and the thread-backed
 * twin of this one at `packages/ggui-react/src/chat-thread/shells/chat/ChatShell.tsx`.
 * RN only ever got the thread-backed flavor — the legacy session shell
 * is web-only. Keep the naming parallel when cross-referencing docs.
 * ─────────────────────────────────────────────────────────────────────
 *
 * Deliberately small and generic: reads `useChatThread()`, renders a
 * timeline + composer + inline error banner, forwards user input back
 * through `send()`. No product-specific theming, no product logic, no
 * design-system imports — integrators who want richer UX either
 * compose on top of `useChatThread()` directly or wrap ChatShell.
 *
 * React Native variant: FlatList + TextInput + Pressable. Same prop
 * surface as the web twin — parity-checked at the barrel level.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useChatThread } from '../../useChatThread';
import type { ChatThreadMessage } from '../../useChatThread';

export interface ChatShellProps {
  /** One-shot scroll target (consumed on mount; host should clear after). */
  focusMessageId?: string;
  /** Deterministic transitions (no animated scroll). */
  reducedMotion?: boolean;
}

export function ChatShell({ focusMessageId, reducedMotion }: ChatShellProps = {}) {
  const { messages, send, isStreaming, error } = useChatThread();
  const listRef = useRef<FlatList<ChatThreadMessage>>(null);
  const hasScrolledRef = useRef(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    if (!focusMessageId || hasScrolledRef.current) return;
    const idx = messages.findIndex((m) => m.id === focusMessageId);
    if (idx < 0) return;
    listRef.current?.scrollToIndex({ index: idx, animated: !reducedMotion });
    hasScrolledRef.current = true;
  }, [focusMessageId, messages, reducedMotion]);

  const submit = useCallback(() => {
    const trimmed = draft.trim();
    if (!trimmed || isStreaming) return;
    void send(trimmed);
    setDraft('');
  }, [draft, isStreaming, send]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<ChatThreadMessage>) => <MessageRow message={item} />,
    [],
  );

  return (
    <View style={styles.root}>
      {error && (
        <View accessibilityRole="alert" style={styles.errorBar}>
          <Text style={styles.errorText}>{error.message}</Text>
        </View>
      )}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(m) => m.id}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
      />
      <View style={styles.composer}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          editable={!isStreaming}
          placeholder={isStreaming ? 'Agent is responding…' : 'Send a message'}
          style={styles.input}
          onSubmitEditing={submit}
          returnKeyType="send"
        />
        <Pressable
          onPress={submit}
          disabled={isStreaming || draft.trim().length === 0}
          style={({ pressed }) => [
            styles.sendBtn,
            (isStreaming || draft.trim().length === 0) && styles.sendBtnDisabled,
            pressed && styles.sendBtnPressed,
          ]}
        >
          <Text style={styles.sendBtnText}>Send</Text>
        </Pressable>
      </View>
    </View>
  );
}

function MessageRow({ message }: { message: ChatThreadMessage }) {
  return (
    <View style={styles.row}>
      <Text style={styles.role}>{message.role}</Text>
      {message.blocks.map((b, i) => {
        if (b.type === 'text') {
          return (
            <Text key={i} style={[styles.textBlock, message.isPending && styles.pending]}>
              {b.text}
            </Text>
          );
        }
        if (b.type === 'tool_use') {
          return (
            <Text key={i} style={styles.toolBlock}>
              {`[${b.name}]`}
            </Text>
          );
        }
        if (b.type === 'tool_result') {
          return (
            <Text key={i} style={styles.toolBlock}>
              {message.cardSnapshot ? '[card ready]' : '[card pending]'}
            </Text>
          );
        }
        return null;
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  errorBar: { backgroundColor: '#fee', padding: 8 },
  errorText: { color: '#900' },
  list: { padding: 8 },
  row: { marginBottom: 8 },
  role: { fontSize: 12, opacity: 0.5, marginBottom: 2 },
  textBlock: {},
  toolBlock: { fontSize: 12, opacity: 0.7 },
  pending: { opacity: 0.6 },
  composer: { flexDirection: 'row', padding: 8, gap: 8 },
  input: {
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  sendBtn: { paddingHorizontal: 12, justifyContent: 'center' },
  sendBtnDisabled: { opacity: 0.4 },
  sendBtnPressed: { opacity: 0.6 },
  sendBtnText: { fontWeight: '600' },
});

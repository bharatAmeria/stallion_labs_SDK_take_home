/**
 * ChatScreen — streaming chat UI.
 *
 * Demonstrates:
 *  • client.chatStream() — tokens stream in one-by-one
 *  • AbortController cancellation mid-generation
 *  • Full conversation history (multi-turn)
 *  • Generation stats (tokens/sec, latency)
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { client } from '../bitnet';
import type { ChatCompletionResult, ChatMessage } from 'react-native-bitnet';

// ── Types ─────────────────────────────────────────────────────────────────────

interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Filled in when generation completes */
  stats?: { tokensPerSecond: number; durationMs: number; tokenCount: number };
  /** True while the assistant is still streaming */
  streaming?: boolean;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ChatScreen() {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<UIMessage[]>([
    {
      id: 'sys',
      role: 'system',
      content: 'You are a helpful assistant running entirely on-device via BitNet.',
    },
  ]);
  const [input, setInput] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<FlatList<UIMessage>>(null);

  // Auto-scroll to bottom whenever messages change
  useEffect(() => {
    setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
  }, [messages]);

  // ── Send a message ──────────────────────────────────────────────────────────

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || isGenerating) return;

    if (!client.isModelLoaded()) {
      Alert.alert('No Model', 'Go back and load a model first.');
      return;
    }

    setInput('');

    // Append user message
    const userMsg: UIMessage = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: text,
    };

    // Placeholder for streaming assistant response
    const assistantId = `a_${Date.now()}`;
    const assistantMsg: UIMessage = {
      id: assistantId,
      role: 'assistant',
      content: '',
      streaming: true,
    };

    setMessages(prev => [...prev, userMsg, assistantMsg]);
    setIsGenerating(true);

    // Build history for the API (filter out UI-only fields)
    const history: ChatMessage[] = messages
      .filter(m => m.role !== 'system' || m.id === 'sys')
      .map(m => ({ role: m.role, content: m.content }));
    history.push({ role: 'user', content: text });

    abortRef.current = new AbortController();

    try {
      let accumulated = '';
      let result: ChatCompletionResult | null = null;

      for await (const chunk of client.chatStream(history, {
        signal: abortRef.current.signal,
        maxTokens: 512,
        temperature: 0.7,
        topP: 0.9,
        systemPrompt: 'You are a helpful assistant running on-device via BitNet.',
        onToken: (token: string) => {
          accumulated += token;
          // Update the streaming message in place
          setMessages(prev =>
            prev.map(m =>
              m.id === assistantId
                ? { ...m, content: accumulated, streaming: true }
                : m
            )
          );
        },
      })) {
        if (chunk.done) {
          result = {
            content: accumulated,
            tokenCount: chunk.tokenCount,
            durationMs: 0,
            tokensPerSecond: 0,
            stopReason: 'eos',
          };
        }
      }

      // Finalise the assistant message with stats
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                content: accumulated,
                streaming: false,
                stats: result
                  ? {
                      tokenCount: result.tokenCount,
                      durationMs: result.durationMs,
                      tokensPerSecond: result.tokensPerSecond,
                    }
                  : undefined,
              }
            : m
        )
      );
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? { ...m, content: `[Error: ${msg}]`, streaming: false }
            : m
        )
      );
    } finally {
      setIsGenerating(false);
      abortRef.current = null;
    }
  }, [input, isGenerating, messages]);

  // ── Cancel generation ───────────────────────────────────────────────────────

  const handleCancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Clear conversation ──────────────────────────────────────────────────────

  const handleClear = useCallback(() => {
    setMessages([
      {
        id: 'sys',
        role: 'system',
        content: 'You are a helpful assistant running entirely on-device via BitNet.',
      },
    ]);
  }, []);

  // ── Render each message ─────────────────────────────────────────────────────

  const renderMessage = useCallback(({ item }: { item: UIMessage }) => {
    if (item.role === 'system') return null; // Don't render system prompt
    const isUser = item.role === 'user';

    return (
      <View style={[styles.msgRow, isUser ? styles.msgRowUser : styles.msgRowAssistant]}>
        <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
          <Text style={[styles.bubbleText, isUser ? styles.bubbleTextUser : styles.bubbleTextAssistant]}>
            {item.content}
            {item.streaming ? <Text style={styles.cursor}>▌</Text> : null}
          </Text>
          {item.stats && !item.streaming ? (
            <Text style={styles.stats}>
              {item.stats.tokenCount} tokens
              {item.stats.tokensPerSecond > 0
                ? ` · ${item.stats.tokensPerSecond.toFixed(1)} tok/s`
                : ''}
              {item.stats.durationMs > 0
                ? ` · ${(item.stats.durationMs / 1000).toFixed(2)}s`
                : ''}
            </Text>
          ) : null}
        </View>
      </View>
    );
  }, []);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 0}
    >
      {/* Message list */}
      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={m => m.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Text style={styles.emptyText}>Say something to start chatting!</Text>
        }
      />

      {/* Input row */}
      <View style={[styles.inputRow, { paddingBottom: insets.bottom + 8 }]}>
        <TextInput
          style={styles.input}
          value={input}
          onChangeText={setInput}
          placeholder="Type a message…"
          placeholderTextColor="#4b5563"
          multiline
          maxLength={1000}
          editable={!isGenerating}
          onSubmitEditing={handleSend}
          returnKeyType="send"
        />

        {isGenerating ? (
          <TouchableOpacity style={styles.cancelBtn} onPress={handleCancel}>
            <Text style={styles.cancelBtnText}>✕</Text>
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.sendBtn, !input.trim() && styles.sendBtnDisabled]}
            onPress={handleSend}
            disabled={!input.trim()}
          >
            <Text style={styles.sendBtnText}>↑</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Generating indicator */}
      {isGenerating ? (
        <View style={styles.generatingBar}>
          <ActivityIndicator size="small" color="#7c3aed" />
          <Text style={styles.generatingText}>Generating…</Text>
          <TouchableOpacity onPress={handleCancel}>
            <Text style={styles.clearBtn}>Cancel</Text>
          </TouchableOpacity>
        </View>
      ) : (
        messages.length > 1 && (
          <TouchableOpacity style={styles.clearRow} onPress={handleClear}>
            <Text style={styles.clearBtn}>Clear conversation</Text>
          </TouchableOpacity>
        )
      )}
    </KeyboardAvoidingView>
  );
}

// ── Styles ────────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f1a',
  },
  list: {
    padding: 12,
    gap: 8,
    flexGrow: 1,
  },
  emptyText: {
    color: '#4b5563',
    textAlign: 'center',
    marginTop: 60,
    fontSize: 15,
  },
  msgRow: {
    flexDirection: 'row',
    marginVertical: 4,
  },
  msgRowUser: {
    justifyContent: 'flex-end',
  },
  msgRowAssistant: {
    justifyContent: 'flex-start',
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 4,
  },
  bubbleUser: {
    backgroundColor: '#7c3aed',
    borderBottomRightRadius: 4,
  },
  bubbleAssistant: {
    backgroundColor: '#1e1e38',
    borderBottomLeftRadius: 4,
  },
  bubbleText: {
    fontSize: 15,
    lineHeight: 22,
  },
  bubbleTextUser: {
    color: '#fff',
  },
  bubbleTextAssistant: {
    color: '#e2e8f0',
  },
  cursor: {
    color: '#7c3aed',
  },
  stats: {
    fontSize: 11,
    color: '#4b5563',
    marginTop: 2,
  },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: '#1e1e38',
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: '#1e1e38',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    color: '#e2e8f0',
    fontSize: 15,
    maxHeight: 120,
  },
  sendBtn: {
    width: 40,
    height: 40,
    backgroundColor: '#7c3aed',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnDisabled: {
    backgroundColor: '#374151',
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  cancelBtn: {
    width: 40,
    height: 40,
    backgroundColor: '#ef4444',
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cancelBtnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  generatingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 6,
    gap: 8,
  },
  generatingText: {
    color: '#94a3b8',
    fontSize: 13,
  },
  clearRow: {
    alignItems: 'center',
    paddingVertical: 6,
  },
  clearBtn: {
    color: '#4b5563',
    fontSize: 13,
  },
});

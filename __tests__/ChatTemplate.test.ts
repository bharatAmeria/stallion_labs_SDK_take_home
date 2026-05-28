/**
 * Unit tests for ChatTemplate — prompt formatting.
 */

import { formatChatPrompt, inferChatTemplate } from '../src/ChatTemplate';
import type { ChatMessage } from '../src/types';

const user   = (content: string): ChatMessage => ({ role: 'user',      content });
const system = (content: string): ChatMessage => ({ role: 'system',    content });
const asst   = (content: string): ChatMessage => ({ role: 'assistant', content });

// ─── llama3 template ──────────────────────────────────────────────────────────

describe('formatChatPrompt — llama3', () => {
  test('starts with <|begin_of_text|>', () => {
    const p = formatChatPrompt([user('Hello')], 'llama3');
    expect(p).toMatch(/^<\|begin_of_text\|>/);
  });

  test('wraps user message with header tags', () => {
    const p = formatChatPrompt([user('Hi')], 'llama3');
    expect(p).toContain('<|start_header_id|>user<|end_header_id|>');
    expect(p).toContain('Hi');
    expect(p).toContain('<|eot_id|>');
  });

  test('ends with open assistant header', () => {
    const p = formatChatPrompt([user('Hi')], 'llama3');
    expect(p).toMatch(/<\|start_header_id\|>assistant<\|end_header_id\|>/);
  });

  test('includes system message', () => {
    const p = formatChatPrompt([system('You are a pirate.'), user('Hello')], 'llama3');
    expect(p).toContain('<|start_header_id|>system<|end_header_id|>');
    expect(p).toContain('You are a pirate.');
  });

  test('multi-turn conversation includes all messages', () => {
    const p = formatChatPrompt([
      system('Be helpful.'),
      user('What is 2+2?'),
      asst('4'),
      user('And 3+3?'),
    ], 'llama3');
    expect(p).toContain('What is 2+2?');
    expect(p).toContain('4');
    expect(p).toContain('And 3+3?');
  });

  test('injects systemPrompt when no system message present', () => {
    const p = formatChatPrompt([user('Hi')], 'llama3', 'You are a robot.');
    expect(p).toContain('You are a robot.');
  });

  test('does NOT inject systemPrompt when system message already present', () => {
    const p = formatChatPrompt([system('Custom.'), user('Hi')], 'llama3', 'Injected');
    expect(p).toContain('Custom.');
    expect(p).not.toContain('Injected');
  });
});

// ─── mistral template ─────────────────────────────────────────────────────────

describe('formatChatPrompt — mistral', () => {
  test('starts with <s>', () => {
    const p = formatChatPrompt([user('Hello')], 'mistral');
    expect(p).toMatch(/^<s>/);
  });

  test('wraps user in [INST]..[/INST]', () => {
    const p = formatChatPrompt([user('Tell me a joke')], 'mistral');
    expect(p).toContain('[INST]');
    expect(p).toContain('[/INST]');
    expect(p).toContain('Tell me a joke');
  });

  test('prepends system to first user message inside [INST]', () => {
    const p = formatChatPrompt([system('Be funny.'), user('Joke?')], 'mistral');
    // Mistral format: [INST] {system}\n{user} [/INST]
    expect(p).toContain('Be funny.');
    expect(p).toContain('Joke?');
    // System and user are combined inside the same [INST] block
    expect(p).toMatch(/\[INST\][\s\S]*Be funny[\s\S]*Joke\?[\s\S]*\[\/INST\]/);
  });

  test('wraps assistant in </s>', () => {
    const p = formatChatPrompt([user('Q?'), asst('A!')], 'mistral');
    expect(p).toContain('A!</s>');
  });
});

// ─── chatml template ──────────────────────────────────────────────────────────

describe('formatChatPrompt — chatml', () => {
  test('contains <|im_start|> and <|im_end|>', () => {
    const p = formatChatPrompt([user('Hello')], 'chatml');
    expect(p).toContain('<|im_start|>user');
    expect(p).toContain('<|im_end|>');
  });

  test('ends with open assistant tag', () => {
    const p = formatChatPrompt([user('Hi')], 'chatml');
    expect(p).toMatch(/<\|im_start\|>assistant\n$/);
  });
});

// ─── alpaca template ──────────────────────────────────────────────────────────

describe('formatChatPrompt — alpaca', () => {
  test('contains ### Instruction and ### Response', () => {
    const p = formatChatPrompt([user('Say hi')], 'alpaca');
    expect(p).toContain('### Instruction:');
    expect(p).toContain('### Response:');
    expect(p).toContain('Say hi');
  });
});

// ─── none template ────────────────────────────────────────────────────────────

describe('formatChatPrompt — none', () => {
  test('returns plain concatenated content', () => {
    const p = formatChatPrompt([user('A'), asst('B')], 'none');
    expect(p).toContain('A');
    expect(p).toContain('B');
    expect(p).not.toContain('<|');
    expect(p).not.toContain('[INST]');
  });
});

// ─── unknown template ─────────────────────────────────────────────────────────

describe('formatChatPrompt — unknown template', () => {
  test('throws on unknown template', () => {
    expect(() => {
      formatChatPrompt([user('Hi')], 'unknown_format' as any);
    }).toThrow('Unknown chat template');
  });
});

// ─── inferChatTemplate ────────────────────────────────────────────────────────

describe('inferChatTemplate', () => {
  test('returns llama3 for bitnet models', () => {
    expect(inferChatTemplate('hf://microsoft/bitnet-b1.58-2B-4T-gguf')).toBe('llama3');
  });

  test('returns mistral for mistral repos', () => {
    expect(inferChatTemplate('hf://mistralai/Mistral-7B-Instruct')).toBe('mistral');
  });

  test('returns chatml for qwen repos', () => {
    expect(inferChatTemplate('hf://Qwen/Qwen2.5-0.5B-Instruct-GGUF')).toBe('chatml');
  });

  test('returns alpaca for alpaca repos', () => {
    expect(inferChatTemplate('hf://someone/my-alpaca-model')).toBe('alpaca');
  });

  test('returns llama3 by default', () => {
    expect(inferChatTemplate('hf://unknown/model')).toBe('llama3');
  });
});

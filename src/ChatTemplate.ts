/**
 * ChatTemplate — formats ChatMessage[] into a raw prompt string.
 *
 * Each model family uses a slightly different prompt format. BitNet b1.58
 * uses the Llama-3 template by default. The template is applied before the
 * prompt is sent to the native inference engine.
 *
 * Supported templates:
 *   'llama3'  — <|begin_of_text|>...<|eot_id|>  (BitNet b1.58, Llama-3)
 *   'mistral' — [INST]..[/INST]                 (Mistral / Mixtral)
 *   'chatml'  — <|im_start|>...<|im_end|>       (Qwen, Yi, etc.)
 *   'alpaca'  — ### Instruction / ### Response  (older fine-tunes)
 *   'none'    — concatenates content without special tokens
 */

import type { ChatMessage, ChatTemplateId } from './types';

// ─── Template implementations ──────────────────────────────────────────────────

/**
 * Llama-3 / BitNet b1.58 format.
 *
 * <|begin_of_text|>
 * <|start_header_id|>system<|end_header_id|>
 * {system}<|eot_id|>
 * <|start_header_id|>user<|end_header_id|>
 * {user}<|eot_id|>
 * <|start_header_id|>assistant<|end_header_id|>
 */
function applyLlama3(messages: ChatMessage[]): string {
  let prompt = '<|begin_of_text|>';
  for (const msg of messages) {
    prompt += `<|start_header_id|>${msg.role}<|end_header_id|>\n\n${msg.content}<|eot_id|>`;
  }
  // Leave the assistant header open so the model continues from here
  prompt += '<|start_header_id|>assistant<|end_header_id|>\n\n';
  return prompt;
}

/**
 * Mistral / Mixtral instruct format.
 *
 * <s>[INST] {system}\n{user} [/INST]
 * {assistant}</s>
 * [INST] {user} [/INST]
 */
function applyMistral(messages: ChatMessage[]): string {
  let prompt = '<s>';
  let systemContent = '';
  let inInst = false;

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemContent = msg.content;
    } else if (msg.role === 'user') {
      const content = systemContent
        ? `${systemContent}\n${msg.content}`
        : msg.content;
      systemContent = '';
      prompt += `[INST] ${content} [/INST]`;
      inInst = true;
    } else if (msg.role === 'assistant') {
      prompt += ` ${msg.content}</s>`;
      inInst = false;
    }
  }

  // If last message was user (no trailing assistant), leave open
  if (inInst) {
    prompt += ' ';
  }
  return prompt;
}

/**
 * ChatML format (Qwen, Yi, InternLM, etc.)
 *
 * <|im_start|>system
 * {system}<|im_end|>
 * <|im_start|>user
 * {user}<|im_end|>
 * <|im_start|>assistant
 */
function applyChatML(messages: ChatMessage[]): string {
  let prompt = '';
  for (const msg of messages) {
    prompt += `<|im_start|>${msg.role}\n${msg.content}<|im_end|>\n`;
  }
  prompt += '<|im_start|>assistant\n';
  return prompt;
}

/**
 * Alpaca instruct format (older fine-tunes).
 *
 * Below is an instruction that describes a task. Write a response.
 * ### Instruction:
 * {user}
 * ### Response:
 */
function applyAlpaca(messages: ChatMessage[]): string {
  const system = messages.find(m => m.role === 'system');
  const turns = messages.filter(m => m.role !== 'system');

  let prompt = system
    ? `${system.content}\n\n`
    : 'Below is an instruction that describes a task. Write a response that appropriately completes the request.\n\n';

  for (const msg of turns) {
    if (msg.role === 'user') {
      prompt += `### Instruction:\n${msg.content}\n\n`;
    } else if (msg.role === 'assistant') {
      prompt += `### Response:\n${msg.content}\n\n`;
    }
  }

  prompt += '### Response:\n';
  return prompt;
}

/**
 * "None" template — simple concatenation without special tokens.
 * Useful for base (non-instruct) models or custom templates.
 */
function applyNone(messages: ChatMessage[]): string {
  return messages.map(m => m.content).join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

const TEMPLATES: Record<ChatTemplateId, (messages: ChatMessage[]) => string> = {
  llama3:  applyLlama3,
  mistral: applyMistral,
  chatml:  applyChatML,
  alpaca:  applyAlpaca,
  none:    applyNone,
};

/**
 * Format a list of chat messages into a raw prompt string.
 *
 * @param messages  Ordered conversation history.
 * @param template  Template ID (defaults to 'llama3').
 * @param systemPrompt  Injected as the first system message if none is present.
 *
 * @example
 * const prompt = formatChatPrompt(
 *   [{ role: 'user', content: 'Hello!' }],
 *   'llama3',
 *   'You are a helpful assistant.'
 * );
 */
export function formatChatPrompt(
  messages: ChatMessage[],
  template: ChatTemplateId = 'llama3',
  systemPrompt?: string
): string {
  let msgs = [...messages];

  // Inject system prompt if caller supplied one and none exists yet
  if (systemPrompt && !msgs.some(m => m.role === 'system')) {
    msgs = [{ role: 'system', content: systemPrompt }, ...msgs];
  }

  const fn = TEMPLATES[template];
  if (!fn) {
    throw new Error(
      `Unknown chat template "${template}". ` +
      `Valid options: ${Object.keys(TEMPLATES).join(', ')}`
    );
  }

  return fn(msgs);
}

/**
 * Detect which template a model likely uses based on its name / family.
 * Used as a fallback when no explicit template is configured.
 *
 * @param modelId  The model identifier (hf://... or local path).
 */
export function inferChatTemplate(modelId: string): ChatTemplateId {
  const id = modelId.toLowerCase();
  if (id.includes('mistral') || id.includes('mixtral')) return 'mistral';
  if (id.includes('qwen') || id.includes('yi') || id.includes('intern')) return 'chatml';
  if (id.includes('alpaca') || id.includes('vicuna')) return 'alpaca';
  // BitNet b1.58, Llama-3 and most modern models
  return 'llama3';
}

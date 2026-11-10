import { encode as gptEncode } from "gpt-tokenizer";

/**
 * 精确 BPE 编码的字符数上限。超过后改用多窗口采样估算。
 *
 * 背景(2026-11-10 生产卡死事故):gpt-tokenizer 的 encode 是**同步**调用,且对超长/
 * 长重复串呈二次方级变慢——实测 `'a'.repeat(n)` 在 4K/8K/16K/32K 时分别约
 * 37/89/315/1368ms,4MB 20 秒仍未完成。线上一条 13.25MB 的 messages JSON 触发
 * 病态路径,网关主线程 100% CPU,整个应用(含 UI/HTTP)卡死。
 *
 * 取值依据:32KB 即使在纯重复串下也只要 ~1.4s,正常文本仅 ~1ms;超过 32KB 一律估算,
 * 估算只编码 5 个 4KB 窗口(最坏 ~0.2s),对压缩统计/预算判断的误差可接受。
 */
export const EXACT_TOKENIZE_MAX_CHARS = 32 * 1024;

const SAMPLE_WINDOW_CHARS = 4 * 1024;

/** 用 gpt-tokenizer(cl100k_base)统计 token 数,带超长/病态输入保护。 */
export function countTokensCapped(text: string): number {
  if (!text) return 0;
  if (text.length <= EXACT_TOKENIZE_MAX_CHARS) {
    return gptEncode(text).length;
  }
  const window = SAMPLE_WINDOW_CHARS;
  const lastStart = Math.max(0, text.length - window);
  const starts = new Set([
    0,
    lastStart,
    Math.max(0, Math.floor(text.length * 0.25) - window / 2),
    Math.max(0, Math.floor(text.length * 0.5) - window / 2),
    Math.max(0, Math.floor(text.length * 0.75) - window / 2)
  ]);
  let sampledChars = 0;
  let sampledTokens = 0;
  for (const start of starts) {
    const sample = text.slice(start, start + window);
    if (!sample) continue;
    sampledChars += sample.length;
    sampledTokens += gptEncode(sample).length;
  }
  const charsPerToken = sampledTokens > 0 ? sampledChars / sampledTokens : 3.5;
  return Math.max(1, Math.round(text.length / charsPerToken));
}

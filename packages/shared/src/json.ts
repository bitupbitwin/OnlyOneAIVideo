/**
 * 从 LLM 输出中宽容地提取 JSON：依次尝试整体解析、```json 代码块、首尾括号截取。
 */
export function extractJson<T = any>(text: string): T | undefined {
  const candidates: string[] = [text.trim()];

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) candidates.push(fence[1].trim());

  for (const open of ["[", "{"]) {
    const close = open === "[" ? "]" : "}";
    const start = text.indexOf(open);
    const end = text.lastIndexOf(close);
    if (start >= 0 && end > start) candidates.push(text.slice(start, end + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // 尝试下一个候选
    }
  }
  return undefined;
}

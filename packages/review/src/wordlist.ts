/**
 * 极限词/高风险词基础词库（广告法 + 平台常见违禁表述）。
 * 规则层预检使用，用户可按需扩充。
 */
export const BANNED_WORDS: string[] = [
  // 广告法极限词
  "国家级", "世界级", "全球首", "全网第一", "第一品牌", "最佳", "最优", "最好", "最强",
  "最先进", "最高级", "顶级", "极品", "绝无仅有", "史无前例", "万能", "百分之百", "100%有效",
  // 医疗/功效类
  "根治", "治愈", "药到病除", "包治", "立竿见影", "无副作用", "延年益寿",
  // 金融/收益类
  "稳赚", "保本", "零风险", "躺赚", "暴富", "翻倍收益",
  // 诱导类
  "点击领取", "免费送", "加微信", "加V", "私信领取",
];

export function ruleCheck(text: string): string[] {
  const issues: string[] = [];
  for (const word of BANNED_WORDS) {
    if (text.includes(word)) issues.push(`命中极限词/高风险词：「${word}」`);
  }
  return issues;
}

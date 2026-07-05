// Coarse §5 rule-2/3 helpers, isolated for unit-testing and reuse by the
// envelope-cost guard (§5 rule 8). The estimator is deliberately crude
// (chars/4) — an order-of-magnitude dial, not a precise counter (SPEC §5 rule 3).

export interface ContentBlock {
  type: string;
  text?: string;
}

export function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function concatTextBlocks(content: ContentBlock[]): string {
  let out = '';
  for (const b of content) if (b.type === 'text' && typeof b.text === 'string') out += b.text;
  return out;
}

export function hasNonTextBlock(content: ContentBlock[]): boolean {
  return content.some((b) => b.type !== 'text');
}

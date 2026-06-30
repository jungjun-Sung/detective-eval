// judge.ts — LLM-as-judge for detective-response quality.
// Scores each golden-set example (structured output), aggregates with gates + weighting,
// compares to human labels, and appends an agreement record to results.jsonl.
import * as dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import rubric from './rubric.json';
import goldenSet from './golden-set.json';

dotenv.config({ path: '.env.local' });
const client = new Anthropic();
const MODEL = 'claude-opus-4-8';
// Per-1M-token prices (USD). Store tokens, derive cost from this — old runs survive a price change.
const PRICES: Record<string, { input: number; output: number }> = {
  'claude-opus-4-8': { input: 5, output: 25 },
};
// Per-dimension weights (default 1). ⑦ spatial load and ⑥ AI-tell count more.
const WEIGHTS: Record<string, number> = { cognitive_ease: 3, ai_tell: 2 };

// Shape of one dimension's score: 0-5 (null if not applicable) + a reason.
const dimSchema = z.object({ score: z.number().nullable(), reason: z.string() });

// Build the schema from the rubric's dimensions (rubric.json is the single source of truth).
const shape: Record<string, z.ZodTypeAny> = {};
for (const d of rubric.dimensions) {
  shape[d.id] = dimSchema;
}
const ScoreSchema = z.object(shape);

const rubricText = rubric.dimensions
  .map((d) => `- ${d.id} (${d.name}): ${d.description}`)
  .join('\n');

type DimScores = Record<string, { score: number | null; reason: string }>;

// Score cache: save the expensive LLM scores to a file, so retuning aggregation (gates/weights) is free.
// (delete scores-cache.json to re-score from scratch)
const CACHE_PATH = 'scores-cache.json';
let cache: Record<string, DimScores> = {};
try {
  cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
} catch {
  cache = {};
}

// Score one detective reply across the 13 dimensions.
// NOTE: the prompt is Korean because the dialogue being judged is Korean game data.
async function judgeOne(
  userInput: string,
  detectiveResponse: string
): Promise<{ scores: DimScores; inTok: number; outTok: number }> {
  const prompt = `당신은 추리 게임에서 'AI 탐정'의 응답 품질을 채점하는 평가자입니다.
아래 채점 기준의 각 항목을 0~5점으로 매기고, 한 줄 이유를 다세요. (0=나쁨, 5=좋음)
이 응답에 해당하지 않는 항목은 score를 null로 두고 reason에 "해당 없음"이라고 적으세요.
[suspect], [victim], [poison], [beverage], [fabricated person], [fabricated business] — 이 정확한 토큰들만 비밀을 가린 자리표시자다. 정상 텍스트로 취급하고 형식/오타 감점하지 마라. 그 외의 깨진 형식·오타·이상 텍스트는 평소대로 평가하라.

[채점 기준]
${rubricText}

[용의자의 직전 답변]
${userInput}

[채점할 탐정 응답]
${detectiveResponse}`;

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: zodOutputFormat(ScoreSchema) },
  });
  return {
    scores: response.parsed_output as DimScores,
    inTok: response.usage.input_tokens,
    outTok: response.usage.output_tokens,
  };
}

// 13 dimension scores → weighted average → label ('good'/'fair'/'bad'), compared to golden-set's English `label` field.
function toLabel(scores: DimScores): { avg: number; label: string; note: string } {
  // Weighted average (dimensions in WEIGHTS count more, default 1x; null is skipped).
  let wsum = 0;
  let wtot = 0;
  for (const d of rubric.dimensions) {
    const s = scores[d.id]?.score;
    if (s == null) continue;
    const w = WEIGHTS[d.id] ?? 1;
    wsum += s * w;
    wtot += w;
  }
  const avg = wtot ? wsum / wtot : 0;
  const scoreOf = (id: string) => scores[id]?.score ?? null;

  // Gate 1: broken format (format ≤ 1) → bad, regardless of the average.
  const fmt = scoreOf('format');
  if (fmt !== null && fmt <= 1) return { avg, label: 'bad', note: 'format-gate' };

  // Gate 2: an applicable conditional dimension (confession / typo input) scored low (≤2) → bad.
  for (const id of ['confession_handling', 'ambiguous_input']) {
    const s = scoreOf(id);
    if (s !== null && s <= 2) return { avg, label: 'bad', note: `${id}-gate` };
  }

  // Gate 3: asserting a witness/evidence as settled fact (epistemic_honesty ≤ 2) → bad.
  const ehon = scoreOf('epistemic_honesty');
  if (ehon !== null && ehon <= 2) return { avg, label: 'bad', note: 'ehon-gate' };

  // Passed the gates → band the weighted average.
  const label = avg >= 3.5 ? 'good' : avg >= 2.5 ? 'fair' : 'bad';
  return { avg, label, note: 'weighted-avg' };
}

// Score the same reply N times and average per dimension (self-consistency).
const N = 3;
async function judgeStable(ex: { id: number; userInput: string; detectiveResponse: string }): Promise<{ scores: DimScores; inTok: number; outTok: number }> {
  // Reuse the cache if present (no API call → no token spend, so 0 tokens).
  if (cache[ex.id]) return { scores: cache[ex.id], inTok: 0, outTok: 0 };

  let inTok = 0;
  let outTok = 0;
  const results: DimScores[] = [];
  for (let i = 0; i < N; i++) {
    const r = await judgeOne(ex.userInput, ex.detectiveResponse);
    inTok += r.inTok;
    outTok += r.outTok;
    results.push(r.scores);
  }
  // Average each dimension (skip null; all-null stays null).
  const averaged: DimScores = {};
  for (const d of rubric.dimensions) {
    const vals = results
      .map((r) => r[d.id]?.score)
      .filter((s): s is number => s != null);
    averaged[d.id] = {
      score: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      reason: `avg of ${vals.length}/${N}`,
    };
  }
  cache[ex.id] = averaged;
  return { scores: averaged, inTok, outTok };
}

async function main() {
  let agree = 0;
  let totalIn = 0;
  let totalOut = 0;
  const mismatches: number[] = [];
  for (const ex of goldenSet.examples) {
    const { scores: averaged, inTok, outTok } = await judgeStable(ex);
    totalIn += inTok;
    totalOut += outTok;
    const { avg, label } = toLabel(averaged);
    const match = label === ex.label;
    if (match) agree++;
    else mismatches.push(ex.id);
    const cog = averaged['cognitive_ease']?.score;
    const ai = averaged['ai_tell']?.score;
    const ehon = averaged['epistemic_honesty']?.score;
    console.log(
      `#${String(ex.id).padStart(2)} [${ex.case.padEnd(14)}] human:${ex.label}  judge:${label}(${avg.toFixed(1)} ⑦${cog?.toFixed(1) ?? '-'} ⑥${ai?.toFixed(1) ?? '-'} ⑩${ehon?.toFixed(1) ?? '-'})  ${match ? '✓' : '✗'}`
    );
  }
  // Save the score cache (free from the next run on).
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  const total = goldenSet.examples.length;
  const rate = Math.round((agree / total) * 100);
  console.log(`\nagreement (N=${N}, weighted): ${agree}/${total} (${rate}%)`);

  // cost of THIS run (cached examples = 0 tokens; derive cost from tokens × price)
  const price = PRICES[MODEL];
  const costUsd = (totalIn * price.input + totalOut * price.output) / 1_000_000;
  console.log(`tokens: ${totalIn} in + ${totalOut} out  →  $${costUsd.toFixed(4)} this run (${MODEL}, cached examples cost $0)`);

  // === Regression tracking: append this run as one line ===
  const record = {
    date: new Date().toISOString(),
    rubricVersion: rubric.version,
    agg: 'weighted ⑦x3 ⑥x2 +ehon-gate',
    model: MODEL,
    N,
    agree,
    total,
    rate,
    inputTokens: totalIn,
    outputTokens: totalOut,
    mismatches,
  };
  appendFileSync('results.jsonl', JSON.stringify(record) + '\n');

  // === Print the cumulative log ===
  const rows = readFileSync('results.jsonl', 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  console.log('\n=== regression log (cumulative) ===');
  for (const r of rows) {
    // derive cost from stored tokens × price (older runs have no tokens → "$—")
    let cost = '$—';
    if (r.inputTokens != null && r.outputTokens != null) {
      const p = PRICES[r.model] ?? PRICES[MODEL];
      cost = '$' + ((r.inputTokens * p.input + r.outputTokens * p.output) / 1_000_000).toFixed(2);
    }
    console.log(
      `${r.date.slice(0, 10)}  rubric ${r.rubricVersion}  [${r.agg ?? 'plain'}]  ${r.rate}% (${r.agree}/${r.total})  ${cost}  mismatch:[${r.mismatches.join(',')}]`
    );
  }
}

main();

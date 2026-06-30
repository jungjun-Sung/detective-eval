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
// 항목별 가중치 (없으면 1). ⑦공간 부담·⑥AI 티를 더 무겁게 반영.
const WEIGHTS: Record<string, number> = { cognitive_ease: 3, ai_tell: 2 };

// 한 항목의 점수 모양: 0~5점(해당 없으면 null) + 이유
const dimSchema = z.object({ score: z.number().nullable(), reason: z.string() });

// rubric의 항목들로 스키마를 자동 생성 (rubric.json이 유일한 출처)
const shape: Record<string, z.ZodTypeAny> = {};
for (const d of rubric.dimensions) {
  shape[d.id] = dimSchema;
}
const ScoreSchema = z.object(shape);

const rubricText = rubric.dimensions
  .map((d) => `- ${d.id} (${d.name}): ${d.description}`)
  .join('\n');

type DimScores = Record<string, { score: number | null; reason: string }>;

// 채점 결과 캐시: 비싼 LLM 채점을 파일에 저장 → 합산 규칙(게이트·가중치)은 공짜로 실험
// (다시 채점하고 싶으면 scores-cache.json 파일을 지우면 됨)
const CACHE_PATH = 'scores-cache.json';
let cache: Record<string, DimScores> = {};
try {
  cache = JSON.parse(readFileSync(CACHE_PATH, 'utf-8'));
} catch {
  cache = {};
}

// 탐정 응답 1개를 13항목으로 채점
async function judgeOne(userInput: string, detectiveResponse: string): Promise<DimScores> {
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
  return response.parsed_output as DimScores;
}

// 13항목 점수 → 평균 → 좋음/보통/나쁨 라벨
function toLabel(scores: DimScores): { avg: number; label: string; note: string } {
  // 가중 평균 (WEIGHTS에 있는 항목은 더 무겁게, 없으면 1배; null은 제외)
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

  // 게이트 1: 형식이 깨지면(format ≤ 1) 다른 점수와 무관하게 나쁨
  const fmt = scoreOf('format');
  if (fmt !== null && fmt <= 1) return { avg, label: '나쁨', note: 'format게이트' };

  // 게이트 2: 적용된 조건부 항목(자백/오타)이 낮으면(≤2) 나쁨
  for (const id of ['confession_handling', 'ambiguous_input']) {
    const s = scoreOf(id);
    if (s !== null && s <= 2) return { avg, label: '나쁨', note: `${id}게이트` };
  }

  // 게이트 3: 증인/증거를 확정 사실로 단정(epistemic_honesty ≤ 2) → 나쁨
  const ehon = scoreOf('epistemic_honesty');
  if (ehon !== null && ehon <= 2) return { avg, label: '나쁨', note: 'ehon게이트' };

  // 게이트 통과 → 가중평균 밴드
  const label = avg >= 3.5 ? '좋음' : avg >= 2.5 ? '보통' : '나쁨';
  return { avg, label, note: '가중평균' };
}

// 같은 응답을 N번 채점해 항목별 점수를 평균 (self-consistency)
const N = 3;
async function judgeStable(ex: { id: number; userInput: string; detectiveResponse: string }): Promise<DimScores> {
  // 캐시에 있으면 재사용 (API 호출 안 함)
  if (cache[ex.id]) return cache[ex.id];

  const results: DimScores[] = [];
  for (let i = 0; i < N; i++) {
    results.push(await judgeOne(ex.userInput, ex.detectiveResponse));
  }
  // 항목별 점수를 평균 (null은 빼고 평균; 전부 null이면 null)
  const averaged: DimScores = {};
  for (const d of rubric.dimensions) {
    const vals = results
      .map((r) => r[d.id]?.score)
      .filter((s): s is number => s != null);
    averaged[d.id] = {
      score: vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
      reason: `${vals.length}/${N}회 평균`,
    };
  }
  cache[ex.id] = averaged;
  return averaged;
}

async function main() {
  let agree = 0;
  const mismatches: number[] = [];
  for (const ex of goldenSet.examples) {
    const averaged = await judgeStable(ex);
    const { avg, label } = toLabel(averaged);
    const match = label === ex.humanLabel;
    if (match) agree++;
    else mismatches.push(ex.id);
    const cog = averaged['cognitive_ease']?.score;
    const ai = averaged['ai_tell']?.score;
    const ehon = averaged['epistemic_honesty']?.score;
    console.log(
      `#${String(ex.id).padStart(2)} [${ex.case.padEnd(14)}] 사람:${ex.humanLabel}  judge:${label}(${avg.toFixed(1)} ⑦${cog?.toFixed(1) ?? '-'} ⑥${ai?.toFixed(1) ?? '-'} ⑩${ehon?.toFixed(1) ?? '-'})  ${match ? '✓' : '✗'}`
    );
  }
  // 채점 결과 캐시 저장 (다음 실행부턴 공짜)
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));

  const total = goldenSet.examples.length;
  const rate = Math.round((agree / total) * 100);
  console.log(`\n일치율(N=${N}, 가중평균): ${agree}/${total} (${rate}%)`);

  // === 회귀 추적: 이번 결과를 한 줄로 기록 ===
  const record = {
    date: new Date().toISOString(),
    rubricVersion: rubric.version,
    agg: 'weighted ⑦x3 ⑥x2 +ehon게이트',
    model: MODEL,
    N,
    agree,
    total,
    rate,
    mismatches,
  };
  appendFileSync('results.jsonl', JSON.stringify(record) + '\n');

  // === 지금까지 쌓인 기록 전부 보여주기 ===
  const rows = readFileSync('results.jsonl', 'utf-8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  console.log('\n=== 회귀 추적 (누적 기록) ===');
  for (const r of rows) {
    console.log(
      `${r.date.slice(0, 10)}  rubric ${r.rubricVersion}  [${r.agg ?? 'plain'}]  ${r.rate}% (${r.agree}/${r.total})  불일치:[${r.mismatches.join(',')}]`
    );
  }
}

main();

# Postmortem 01 — Masking dropped the golden-set agreement

> Draft (facts first). 2026-06-29. Target: the detective-response quality judge.

---

## 1. What happened (symptoms + numbers)

I masked the game's secrets in `golden-set.json` with `[placeholder]` tokens to make it public, then re-scored. The meta-eval agreement dropped.

**77% → 62% (10/13 → 8/13)**

Regression log (`results.jsonl`):
```
[weighted ⑦x3 ⑥x2 +ehon-gate]  77% (10/13)  mismatch:[3,4,10]     ← before masking
[weighted ⑦x3 ⑥x2 +ehon-gate]  62% (8/13)   mismatch:[3,4,6,7,12]  ← after masking
```

The 3 newly-wrong cases (#6, #7, #12) all disagreed with my labels, and all were gate misfires:
```
#6  case-A-R6  me:fair  judge:bad(2.2 ⑦3.0 ⑥2.0 ⑩1.7)   ← ⑩1.7 → ehon-gate
#7  case-A-R7  me:good  judge:bad(3.9 ...)               ← avg 3.9 but bad = a gate fired
#12 case-C-R1  me:good  judge:bad(3.8 ⑥2.0 ⑩4.0)         ← avg 3.8 but bad = a gate fired
```
(avg sits in the good/fair band but the label is bad = the gate decided the label, not the average.)

---

## 2. Cause (diagnosis)

The judge (Opus 4.8) read bracket tokens like `[suspect]` and `[fabricated person]` as broken output / a typo / weird text. That hit the gates I'd built:

- **format** — saw the brackets as broken format → low format score → `format-gate` (likely #12)
- **ambiguous_input** — saw `[fabricated person]` in the userInput as garbled input → low score → gate (likely #7)
- **epistemic_honesty** — read the masked trick quote ("you made up `[fabricated person]`") as uncertain/made up → #6 ⑩1.7 → `ehon-gate`

Relevant code (the gates in `toLabel`, `judge.ts`):
```ts
// Gate 1: broken format
if (fmt !== null && fmt <= 1) return { avg, label: 'bad', note: 'format-gate' };
// Gate 2: conditional dimension (confession / typo input) scored low
for (const id of ['confession_handling', 'ambiguous_input'])
  if (s !== null && s <= 2) return { avg, label: 'bad', note: `${id}-gate` };
// Gate 3: asserting a witness as settled fact
if (ehon !== null && ehon <= 2) return { avg, label: 'bad', note: 'ehon-gate' };
```

**Key point:** the real quality of the replies didn't change before vs after masking. The drop happened because the placeholder tokens lowered the scores. In other words, the masking added a confound to the scoring. The "quality-preserving" idea was broken by doing the masking as tokens.

---

## 3. Fix

I added one line to the judge prompt that excludes exactly 6 tokens (not a blanket "ignore all brackets"). The actual line in the code is Korean:
```
[suspect], [victim], [poison], [beverage], [fabricated person], [fabricated business]
— 이 정확한 토큰들만 비밀을 가린 자리표시자다. 정상 텍스트로 취급하고
형식/오타 감점하지 마라. 그 외의 깨진 형식·오타·이상 텍스트는 평소대로 평가하라.
```
(Meaning: treat only these exact tokens as placeholders, read them as normal text, don't dock format/typo points for them. Score any other broken format, typo, or weird text as usual.)

**Why only 6?** If I widen it to "ignore all brackets", the judge goes blind to real format problems too — like the `**` break in #8 (a case where the format gate is supposed to fire). Limiting it to the exact tokens keeps #8 caught as bad.

Side step: the scoring input changed, so I deleted the stale `scores-cache.json` and re-scored.

**Agreement after the fix: 62% → 69% (9/13).** Mismatch `[3,4,6,10]`.

- The gate misfires #7 and #12 went back to correct (✓). Diagnosis was right. #8's `**` break is still caught by the format gate, so the 6-token limit works (the judge isn't dumbed down).
- Not a full 77%: #6 is left. But it isn't a gate misfire — ⑩ went back to normal (1.7 → 3.3), and instead the masking pushed #6's weighted average from 3.0 to 3.5, just over the "good" band (≥3.5). That's the known "fair vs good 3.5 boundary" sensitivity (same family as #3, #4, #10), not a masking confound.

---

## 4. What I learned

1. **Masking/anonymizing isn't score-neutral.** Putting artificial tokens into the text being judged makes the tokens themselves a confound. "Quality-preserving" masking only counts as preserved once you check (with the regression run) that the verdicts are preserved too.
2. **The regression tracking caught it right away.** Without re-running I would've shipped a broken golden set. This is exactly why the regression table exists.
3. **Keep the fix narrow.** Over-correcting ("ignore all brackets") dumbs the judge down. Exactly 6 tokens excepted → real format problems are still caught.
4. **When the input or the prompt changes, invalidate the cache.** If I don't delete `scores-cache.json`, I'm comparing against old scores. (text change / prompt change = delete the cache.)
5. **A hard band boundary turns small noise into label flips.** A case sitting right on a sharp line like 3.5 (#6, avg 3.0–3.5) can flip on any text change, masking included. The leftover gap from not fully restoring 77% is this boundary sensitivity, not a bug. → Follow-up: boundary cases need softer handling (report the raw score) or a human re-check.

---

## Appendix — timeline (full regression table)
```
plain                          62% (8/13)   mismatch:[2,3,4,10,13]
weighted ⑦x3 ⑥x2               69% (9/13)   mismatch:[3,4,10,13]
weighted ⑦x3 ⑥x2 +ehon-gate    77% (10/13)  mismatch:[3,4,10]
weighted ⑦x3 ⑥x2 +ehon-gate    62% (8/13)   mismatch:[3,4,6,7,12]   ← masking incident
weighted ⑦x3 ⑥x2 +ehon-gate    69% (9/13)   mismatch:[3,4,6,10]     ← placeholder exception (restored)
```

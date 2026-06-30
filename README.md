# detective-eval

In a detective game, an AI detective questions a suspect. Whether a reply is good depends on who you ask. This repo is a tool I built to score that, so I can measure it and get the same result each time.

The scoring rules are made for my own game. But the real point is the method: how to check if an AI's answers match a human's opinion of "good".

## What I did
- I labeled 13 detective replies myself as good / fair / bad. So my opinion is the answer key.
- I split that opinion into a rubric with 13 parts.
- An AI judge scores each reply, and I check how often it agrees with my labels.
- Every time I fixed a case it got wrong, the agreement went up. 62% → 69% → 77%.
- When hiding the game's secrets broke the scoring, I wrote about it instead of hiding it. (`postmortems/`)

## Key ideas
- Quality isn't one number. Score it on several things.
- One bad part shouldn't get hidden by the average. A "gate" fails it right away.
- The things I care about more count more.
- An AI judge gives slightly different scores each run. So I score each reply 3 times and take the average.
- I save every run, so I can see if a change really helped, or was just luck.

## Run it
```bash
npm install
cp .env.local.example .env.local   # add your key
npx tsx judge.ts
```

## Limitations
- The data is Korean, and only from 3 cases in the game. It's not a big general test set.
- It checks how the detective asks questions, not whether it got the case's real answer.
- The rubric and the judge prompt are written in Korean, because the dialogue being scored is Korean. Making the whole thing English is a planned next step.

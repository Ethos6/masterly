# Contributing

Thanks for helping. masterly aims to stay small, honest about what it knows, and easy to read.

## Setup

```bash
git clone https://github.com/Ethos6/masterly && cd masterly
npm install
npm test             # unit and integration tests
npm run typecheck
npx playwright install chromium && npm run test:ui   # browser tests
node bin/masterly.js # run your branch
```

The tests use a scripted model (`test/helpers/mock-llm.js`), so no API key is needed.

## Principles

- **Grounding is enforced in code.** Anything the learner is told must carry evidence that `src/ground.js` verifies. Don't add a path that shows model output as fact without it.
- **Learning science over features.** Changes to scheduling or mastery rules need a short rationale and tests.
- **One runtime dependency.** pdf.js is the only one; please keep it that way.

## Pull requests

- Add a test for every behaviour change.
- `main` is protected: changes land through pull requests with passing CI.

# Working on PDF Read Aloud

- The user reads with the **stable** app (`npm start`, http://localhost:4173). Make and test fixes in the **development** app (`npm run dev`, http://localhost:5173). Never edit `deploy/` by hand.
- When a fix is finished and `npm run typecheck` and `npm test` pass, publish it with `npm run deploy -- -m "<one line, user-facing: what changed>"`. Deploy refuses to publish if the checks fail. Open stable tabs then offer the update in a pop-up.
- Test speech silently: the user may be using their speakers. In the browser, replace `speechSynthesis.speak`/`cancel` with a mock that fires `onboundary`/`onend` from timers.
- Test PDFs go in `test/local/` (gitignored). Never commit them.

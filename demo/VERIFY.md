/**

- Automated visual smoke-test runner for the demo page.
- Run: npm run demo (serves dist + opens browser).
-
- Manual verification checklist (docs/ANIMATIONS.md §1 budgets):
- [ ] Cold inference button: scramble ~200ms, dissolve ~450ms wave, pop ~180ms
- [ ] Cache hit button: compressed budgets (120/180/120ms)
- [ ] Super-fast button: near-instant
- [ ] Toggle reduced motion: hard swaps, no transforms
- [ ] Scroll during mass animation: no jank
      */

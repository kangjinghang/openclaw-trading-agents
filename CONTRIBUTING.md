# Contributing

## Development Setup

```bash
git clone <your-fork>
cd openclaw-trading-agents
npm install
pip install -r requirements.txt
npm run build
npm test
```

## PR Workflow

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Run `npm run build`, `npm test`, `npm run lint`, and `npx tsc --noEmit` — all must pass
4. Open a pull request with a clear title and description

## Code Style

- TypeScript strict mode, ES2020, CommonJS
- ESLint enforces style — run `npm run lint` before committing
- No Prettier; rely on `eslint --fix`
- Python scripts output JSON to stdout, errors to stderr

## Testing

- TypeScript tests: `npx vitest run tests/ts/<file>.test.ts`
- Python tests: `python -m pytest tests/scripts/`
- All external calls are mocked — no real API keys needed

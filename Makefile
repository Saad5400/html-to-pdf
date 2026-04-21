.PHONY: install local dev worker test test-e2e lint typecheck loadtest visual openapi clean

install:
	npm ci --no-audit --no-fund --ignore-scripts
	npx playwright install --with-deps chromium

# One command to bring up redis + server + worker and open the playground.
local:
	bash scripts/local.sh

dev:
	npm run dev

worker:
	npm run dev:worker

# Minimal mode — pure sync API, no Redis, no storage, no auth required.
minimal:
	npm run minimal

# Single-shot CLI: ./bin/htp --html '<h1>Hi</h1>' --out hi.pdf
cli:
	@echo "Usage: ./bin/htp --help"

test:
	npm test

test-e2e:
	npm run test:e2e

lint:
	npm run lint

typecheck:
	npm run typecheck

loadtest:
	API_KEY=dev-key-change-me TARGET=http://localhost:3000 \
	  CONCURRENCY=$${CONCURRENCY:-4} DURATION_MS=$${DURATION_MS:-15000} \
	  npx tsx scripts/loadtest.ts

visual:
	npx tsx scripts/visual-render.ts

openapi:
	npm run openapi

clean:
	rm -rf dist coverage tmp storage

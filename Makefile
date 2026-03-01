.PHONY: dev start stop typecheck clean install

install:
	bun install

dev:
	npx tsx src/pty-service.ts & npx tsx src/server-node.ts

start:
	pm2 start ecosystem.config.cjs

stop:
	pm2 stop all

typecheck:
	bunx tsc --noEmit

clean:
	rm -rf node_modules dist out

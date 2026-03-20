.PHONY: install seed start start-server start-client

## install - Install dependencies for client and server, apply database migrations
install:
	cd client && pnpm install
	cd server && pnpm install
	cd server && npx prisma db push

## seed - Create Keycloak client and test users (requires OpenTDF platform running)
seed:
	./scripts/setup-keycloak.sh
	./scripts/create-test-users.sh

## start - Start both server and client (server in background)
start: start-server start-client

start-server:
	@echo "Starting server..."
	@cd server && pnpm run dev:http &

start-client:
	@echo "Starting client..."
	cd client && pnpm dev

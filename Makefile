.PHONY: up down logs ps test e2e load report kind-up kind-down

RATE ?= 1000
DURATION ?= 5m

up:            ## build and start the whole stack
	docker compose up -d --build
	@echo "API http://localhost:3000 · Grafana http://localhost:3030 · Redpanda Console http://localhost:8081"

down:
	docker compose down -v

logs:
	docker compose logs -f api publisher worker

ps:
	docker compose ps

test:          ## unit tests
	pnpm test

e2e:           ## end-to-end tests against the running stack
	pnpm test:e2e

load:          ## k6 at a constant arrival rate, e.g. make load RATE=2000 DURATION=5m
	docker run --rm -i --network relay_default -e BASE_URL=http://api:3000 \
	  -e RATE=$(RATE) -e DURATION=$(DURATION) grafana/k6:0.54.0 run - < load/send.js

report:        ## numbers of the last run, from Prometheus, as a Markdown table
	node load/report.mjs --minutes $(subst m,,$(DURATION))

kind-up:       ## local Kubernetes: cluster, image, manifests
	kind create cluster --name relay
	docker build -t relay:local .
	kind load docker-image relay:local --name relay
	kubectl apply -k k8s/overlays/kind
	kubectl -n relay rollout status deploy/relay-api --timeout=300s

kind-down:
	kind delete cluster --name relay

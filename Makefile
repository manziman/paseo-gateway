.PHONY: check manifests chart dev connect
check:
	npm run check
manifests:
	npm run generate:crds
chart:
	helm lint charts/paseo
dev:
	npm run dev:up
connect:
	npm run dev:connect

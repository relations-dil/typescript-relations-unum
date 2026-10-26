ACCOUNT=gaf3
IMAGE=typescript-relations-unum
INSTALL=node:22.9.0-alpine3.20
VERSION?=$(shell cat VERSION)
DEBUG_PORT=9229
TTY=$(shell if tty -s; then echo "-it"; fi)
VOLUMES=-v ${PWD}/src:/opt/service/src \
		-v ${PWD}/test:/opt/service/test \
		-v ${PWD}/package.json:/opt/service/package.json \
		-v ${PWD}/package-lock.json:/opt/service/package-lock.json \
		-v ${PWD}/tsconfig.json:/opt/service/tsconfig.json \
		-v ${PWD}/tsconfig.test.json:/opt/service/tsconfig.test.json \
		-v ${PWD}/eslint.config.js:/opt/service/eslint.config.js
NPM=-v ${PWD}/LICENSE:/opt/service/LICENSE \
	-v ${PWD}/README.md:/opt/service/README.md
NPMRC=$(shell test -f ${HOME}/.npmrc && echo "-v ${HOME}/.npmrc:/root/.npmrc")
# Building a package reads the source and keeps nothing, so it gets only what it uses, read-only
PACKAGE=-v ${PWD}/src:/opt/service/src:ro \
	-v ${PWD}/package.json:/opt/service/package.json:ro \
	-v ${PWD}/package-lock.json:/opt/service/package-lock.json:ro \
	-v ${PWD}/tsconfig.json:/opt/service/tsconfig.json:ro \
	-v ${PWD}/VERSION:/opt/service/VERSION:ro \
	-v ${PWD}/LICENSE:/opt/service/LICENSE:ro \
	-v ${PWD}/README.md:/opt/service/README.md:ro \
	-v ${PWD}/CHANGELOG.md:/opt/service/CHANGELOG.md:ro

.PHONY: build shell debug test lint setup tag untag pack publish new sync version release-check release verify test-release help
.DEFAULT_GOAL := help

build: ## Builds the docker image
	docker build . -t $(ACCOUNT)/$(IMAGE):$(VERSION)

shell: ## Opens a shell in the container
	docker run --rm $(TTY) $(VOLUMES) $(NPMRC) -p 127.0.0.1:$(DEBUG_PORT):9229 $(ACCOUNT)/$(IMAGE):$(VERSION) sh

debug: ## Runs the tests under the debugger on port 9229
	docker run --rm $(TTY) $(VOLUMES) -p 127.0.0.1:$(DEBUG_PORT):9229 $(ACCOUNT)/$(IMAGE):$(VERSION) sh -c "node --import tsx --inspect-brk=0.0.0.0:9229 --test test/*.test.ts"

test: ## Runs the tests with coverage
	docker run --rm $(TTY) $(VOLUMES) $(ACCOUNT)/$(IMAGE):$(VERSION) npm run coverage

lint: ## Runs the typecheck and eslint
	docker run --rm $(TTY) $(VOLUMES) $(ACCOUNT)/$(IMAGE):$(VERSION) npm run lint

setup: ## Checks the package installs and its modules load
	docker run --rm $(TTY) $(VOLUMES) $(NPM) $(INSTALL) sh -c "cp -r /opt/service /opt/install && cd /opt/install && \
	npm ci && npm run build && npm pack && \
	mkdir /opt/consumer && cd /opt/consumer && npm init -y >/dev/null && npm install /opt/install/relations-dil-unum-*.tgz && \
	node --input-type=module -e \"import * as r from '@relations-dil/unum'; if (!r.UnumSource) process.exit(1); console.log('ok', Object.keys(r).length, 'exports')\""

tag: ## Tags the version and pushes the tag
	git rev-parse -q --verify refs/tags/$(VERSION) || git tag -a $(VERSION) -m "Version $(VERSION)"
	git push origin --tags

untag: ## Removes the version's tag
	-git tag -d $(VERSION)
	git push origin ":refs/tags/$(VERSION)"

pack: ## Builds the package and lists what would be published
	docker run --rm $(TTY) $(PACKAGE) $(ACCOUNT)/$(IMAGE):$(VERSION) sh -c "cp -r /opt/service /opt/install && cd /opt/install && \
	npm version $(VERSION) --no-git-tag-version --allow-same-version >/dev/null && npm run build && npm pack --dry-run"

publish: ## Publishes the version to npm
	@test -f ${HOME}/.npmrc || (echo "no ${HOME}/.npmrc to publish with" && exit 1)
	docker run --rm $(TTY) $(PACKAGE) $(NPMRC) $(ACCOUNT)/$(IMAGE):$(VERSION) sh -c "cp -r /opt/service /opt/install && cd /opt/install && \
	npm version $(VERSION) --no-git-tag-version --allow-same-version >/dev/null && npm run build && npm publish --access public"

# Releases: make new starts one, make release-check says where it's up to and what would stop it, make release finishes it.
# V is +0.0.1 (the default), +0.1, +1 or a version outright. Branch from the ticket first, make new works on that branch. The work is in scripts/.
V?=+0.0.1

new: ## Starts a release on the ticket branch you're on: next version, VERSION, changelog (V=+0.0.1|+0.1|+1|x.y.z)
	@sh scripts/new.sh "$(V)"

sync: ## Syncs package.json and the lockfile to VERSION
	docker run --rm $(TTY) -v ${PWD}/package.json:/opt/service/package.json -v ${PWD}/package-lock.json:/opt/service/package-lock.json -w /opt/service $(INSTALL) npm version $(VERSION) --no-git-tag-version --allow-same-version

version: ## Sets VERSION and syncs the package files (V=+0.0.1|+0.1|+1|x.y.z)
	@sh scripts/version.sh write "$(V)"

release-check: ## Says where the release is up to and what would stop it
	@sh scripts/release-check.sh

release: ## Does what's left of the release: checks, npm, the tag
	@sh scripts/release.sh

verify: ## Installs the version from npm in a clean container
	@sh scripts/verify.sh

# Tests the release scripts against a throwaway repo and a fake registry, nothing real is touched
test-release: ## Tests the release scripts against a throwaway repo and a fake registry
	docker run --rm $(TTY) -v ${PWD}/scripts:/opt/scripts python:3 sh /opt/scripts/test-release.sh

help: ## Lists the targets
	@awk -F ':.*## ' '/^[a-z-]+:.*## /{printf "%-16s %s\n", $$1, $$2}' $(MAKEFILE_LIST)


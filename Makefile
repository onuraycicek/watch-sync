.PHONY: config dev-server deploy zip release icons browser-a browser-b clean-profiles

# Build settings live in .env (see .env.example); nothing personal is in git.
-include .env
MAX_PEERS ?= 2
DEV_SERVER_URL := ws://127.0.0.1:8787
VERSION := $(shell sed -n 's/.*"version": "\(.*\)".*/\1/p' extension/manifest.json)

# First run: create .env from the example.
.env:
	@cp .env.example .env
	@echo "created .env; set SERVER_URL after make deploy"

define write_config
	@printf 'self.WATCH_SYNC_CONFIG = { roomKey: "%s", serverUrl: "%s" };\n' "$(3)" "$(2)" > $(1)
endef

# Writes extension/config.js for the unpacked dev build (local relay). The test
# browsers share one room so they pair right away.
config: .env
	$(call write_config,extension/config.js,$(DEV_SERVER_URL),$(or $(ROOM_KEY),DEVROOMLOCAL0001))
	@echo "extension/config.js -> $(DEV_SERVER_URL)"

# Local relay (Durable Objects run locally, no Cloudflare account needed).
dev-server:
	cd server && wrangler dev --port 8787 --ip 127.0.0.1 --var MAX_PEERS:$(MAX_PEERS)

# Deploy the relay to your Cloudflare account (the Workers Free plan is enough).
# With CUSTOM_DOMAIN set, the relay is served only there (*.workers.dev off).
deploy: .env
	cd server && \
	if [ -n "$(CLOUDFLARE_ENV_FILE)" ]; then set -a; . "../$(CLOUDFLARE_ENV_FILE)"; set +a; fi; \
	if [ -n "$(CUSTOM_DOMAIN)" ]; then \
		awk -v d="$(CUSTOM_DOMAIN)" '/^\[/ && !done { print "workers_dev = false\npreview_urls = false\nroutes = [{ pattern = \"" d "\", custom_domain = true }]\n"; done = 1 } { print }' \
			wrangler.toml > .wrangler.deploy.toml && \
		wrangler deploy -c .wrangler.deploy.toml --var MAX_PEERS:$(MAX_PEERS); \
	else \
		wrangler deploy --var MAX_PEERS:$(MAX_PEERS); \
	fi

# $(1) zip path, $(2) server url, $(3) room key (both may be empty).
define package
	rm -rf dist/build $(1) && mkdir -p dist/build
	cp -R extension/. dist/build/
	$(call write_config,dist/build/config.js,$(2),$(3))
	cd dist/build && zip -qr ../$(notdir $(1)) . -x '.*'
	rm -rf dist/build
endef

# Private package for your own group: relay and room from .env, if set
# (unzip, then "Load unpacked"). Don't publish it when ROOM_KEY is set.
zip: .env
	$(call package,dist/watch-sync.zip,$(SERVER_URL),$(ROOM_KEY))
	@echo "dist/watch-sync.zip -> $(or $(SERVER_URL),server asked in the popup)"

# Public package for GitHub Releases: never reads .env; the popup asks for the
# server and every install starts in its own random room.
release:
	$(call package,dist/watch-sync-$(VERSION).zip,,)
	@unzip -p dist/watch-sync-$(VERSION).zip config.js | grep -q 'roomKey: "", serverUrl: ""' || { echo "release config is not empty"; exit 1; }
	@echo "dist/watch-sync-$(VERSION).zip (generic)"

# Renders extension/icons/icon.svg to the PNG sizes the manifest uses
# (headless Chrome for the SVG, sips for downscaling; macOS).
CHROME_BIN ?= /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
icons:
	"$(CHROME_BIN)" --headless=new --disable-gpu --hide-scrollbars --default-background-color=00000000 \
		--window-size=128,128 --force-device-scale-factor=4 \
		--screenshot="$(CURDIR)/extension/icons/icon-512.png" "file://$(CURDIR)/extension/icons/icon.svg" 2>/dev/null
	for s in 16 32 48 128; do sips -s format png -z $$s $$s extension/icons/icon-512.png --out extension/icons/icon-$$s.png >/dev/null; done
	rm extension/icons/icon-512.png

# Two isolated test browsers side by side, extension preloaded.
browser-a: config
	node tools/launch-chrome.mjs a 9301 0

browser-b: config
	node tools/launch-chrome.mjs b 9302 960

clean-profiles:
	rm -rf .profiles

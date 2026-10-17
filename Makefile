UUID = googletasks@boleeinoe.github.io
# Override to use another bun, e.g. make install BUN="npx -y bun".
BUN ?= bun
SCHEMA_XML = schemas/org.gnome.shell.extensions.googletasks.gschema.xml
DIST_SCHEMA_XML = dist/schemas/org.gnome.shell.extensions.googletasks.gschema.xml
DIST_ASSETS = dist/metadata.json dist/stylesheet.css $(DIST_SCHEMA_XML)

.PHONY: all test typecheck check lint-dist pack install clean

all: dist/extension.js $(DIST_ASSETS)

bun.lock: package.json
	$(BUN) install

dist/extension.js: bun.lock src/*.ts src/*.d.ts
	$(BUN) run build

dist/metadata.json: metadata.json
	@cp metadata.json dist/

dist/stylesheet.css: src/stylesheet.css
	@cp src/stylesheet.css dist/

$(DIST_SCHEMA_XML): $(SCHEMA_XML)
	@mkdir -p dist/schemas
	@cp $(SCHEMA_XML) $(DIST_SCHEMA_XML)

$(UUID).zip: check lint-dist dist/extension.js $(DIST_ASSETS)
	@rm -f $(UUID).zip
	@(cd dist && zip ../$(UUID).zip -9r .)

# Unit tests (bun test) and the type check. Packing, and so installing,
# depends on these: nothing gets installed while a test fails.
test: bun.lock
	$(BUN) test

typecheck: bun.lock
	$(BUN) run typecheck

check: typecheck test

lint-dist: dist/extension.js $(DIST_ASSETS)
	-$(BUN) run lint:dist

pack: $(UUID).zip

install: check $(DIST_ASSETS) $(UUID).zip
	@gnome-extensions install --force $(UUID).zip

clean:
	@rm -rf dist node_modules $(UUID).zip

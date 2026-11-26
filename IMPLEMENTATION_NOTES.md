# Implementation notes

This update applies the source changes proposed by the accompanying audit. It is based on the uploaded `main` branch archive (HEAD `5c7c2aa1ef03421d32e185163202efdce37f6936`).

## Changes

- Replaced sidebar-only Vocs config extraction with a static `vocs.config.*` reader for `title`, `description`, `srcDir`, `logoUrl`, `iconUrl`, `banner`, `accentColor`, `colorScheme`, `sidebar`, and `topNav`. It resolves literal values, static bindings, and object/array spreads; it does not execute project configuration code.
- Connected the offline preview to the configured Vocs site metadata and theme. **Project theme** reads Vocs' documented top-level `accentColor` and `colorScheme` fields. The original manual palettes remain selectable. Unreadable or dynamic values use Vocs defaults (`light-dark(black, white)` and `light dark`).
- Reworked the offline preview into a Vocs-inspired site shell with top navigation, branding, optional banner text, configured sidebar or generated page tree, article column, heading outline, and desktop/tablet/mobile presets.
- Made preview navigation distinct from editor selection. Known local pages open inside the preview, anchors remain anchors, and external links open separately.
- Added keyboard-operable tabs with tablist/tab/panel semantics; removed automatically generated Callout headings; added code-language headers and copy controls; added a Faster/Slower Benchmarks legend.
- Replaced fabricated offline Changelog entries with a notice explaining that Vocs generates the actual changelog at runtime.
- Hardened Tauri page reads/writes by canonicalizing the docs directory and existing path ancestors, rejecting paths that resolve outside the docs directory, and revalidating before writes. Page discovery also checks that the docs directory remains within the project root and skips symlinks.
- Replaced the text-first `srcDir` scan with a small comment/string-aware scanner anchored to the default-exported config. It supports a literal `srcDir` and a simple top-level string binding.
- Added static config parser tests and documented the supported Node engine range.

## Preview fidelity limits

The offline preview is an approximation, not the Vocs runtime. Imported/dynamic MDX components, custom `_root.css` variables and fonts, generated changelog data, OpenAPI/reference components, runtime React providers, and Shiki token highlighting still require **Live Vocs**. Relative image/logo assets also may not resolve in the offline preview because the project asset server is not running.

## Verification

Passed in this environment:

- `node --check writer/sidebar.mjs`
- `node --check writer/sidebar.test.mjs`
- TypeScript transpile/syntax check for `writer/src.tsx` and `writer/native.ts`
- JSON parsing for `package.json` and `package-lock.json`
- CSS brace-balance sanity check

Not verified:

- `npm run writer:test`: dependencies were not installed, so `@babel/parser` could not be imported.
- `npm run writer:typecheck` / `npm run writer:build`: dependency installation could not complete. The offline npm cache is missing the `zwitch` tarball; the typecheck consequently reports missing React, Tauri, and Markdown modules/types. Node in this environment is 22.16.0, below the `@babel/parser` 8.1.3 engine range declared by the dependency (`^22.18.0 || >=24.11.0`).
- `cargo test` / Rust compilation: `cargo` and `rustc` are not installed in this environment.
- Interactive runtime testing in the Tauri WebView or browser.

Before merging, use Node.js `^22.18.0` or `>=24.11.0`, run `npm ci`, `npm run writer:test`, `npm run writer:typecheck`, and `npm run writer:build`; then run `cargo test --manifest-path src-tauri/Cargo.toml` in a Rust/Tauri environment and verify both Offline and Live Vocs previews.

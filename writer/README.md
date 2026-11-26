# Vocs Graphical Editor

A local desktop/web editor for existing Vocs documentation projects. The desktop version uses Tauri and the operating system's built-in WebView, not a bundled Chromium runtime.

## Use

1. Start the desktop app and choose the repository root (the folder with `package.json` and `vocs.config.*`, or a `vocs` dependency).
2. The editor scans the project's configured `srcDir/pages` folder (Vocs defaults to `src/pages`) and lists existing `.md` and `.mdx` pages.
3. Open a page, edit its Markdown/MDX source, and save. Existing YAML frontmatter and unrecognized MDX are preserved. New pages are saved under the Vocs pages directory.
4. Preview saves pending edits, restores missing dependencies from the project's lockfile when needed, starts its `dev` script with the detected package manager, and opens the current page route. Keep Node.js installed and use a working `dev` script.

The local browser build can connect to a folder using the browser's folder permission picker. Its preview expects the docs site to already be running; set the preview address in the preview pane. The desktop build can install missing project dependencies and start the Vocs dev script itself.

## Build

Requires Node.js 22.18+ (or 24.11+). Run `npm install`, then `npm run writer` for the browser development UI. Run `npm run writer:test` to test static Vocs configuration extraction. Build platform packages with:

- Run the desktop app in development: `npm run writer:tauri`
- macOS Apple Silicon: `npm run writer:mac:arm64`
- macOS Intel: `npm run writer:mac:x64` (install the Rust target first if building from Apple Silicon)
- Windows: `npm run writer:win` (build on Windows)
- Linux: `npm run writer:linux`

Build each desktop installer on its target OS. Install Rust and the platform prerequisites listed in the [Tauri setup guide](https://v2.tauri.app/start/prerequisites/). Bundles are written under `src-tauri/target/release/bundle/`. Tauri reuses the system WebView, so packages are much smaller than the old Electron installer. Builds are unsigned; macOS Gatekeeper and Windows SmartScreen may show warnings.

## Offline preview and project theme

The offline preview approximates the Vocs documentation shell with the configured site title, logo URL, banner, top navigation, sidebar (or a page-tree fallback), article outline, and desktop/tablet/mobile viewport presets. The **Project theme** option reads statically declared `accentColor` and `colorScheme` values from `vocs.config.*`; manual accent palettes remain available. The parser does not execute project configuration code. When a value is dynamic or cannot be read, it uses Vocs defaults (`light-dark(black, white)` and `light dark`).

The offline renderer is intentionally not a replacement for the Vocs runtime. Imported MDX components, dynamic configuration, custom `_root.css` tokens/fonts, generated changelog content, OpenAPI components, and Vocs/Shiki syntax highlighting are only rendered accurately in **Live Vocs**. Use the live preview to verify the final site.

## Vocs MDX palette

The palette includes standard Markdown plus Vocs 2.x MDX components: Callout variants, Steps, FileTree, CodeGroup, CodeBlock, Terminal, Prompt, Changelog, Benchmarks, tables, links, headings, lists, quotes, images and video. Component snippets use Vocs' `data-v-*` MDX component hooks where applicable. Vocs versions and project configuration can differ; check preview before publishing.

import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

/** @type {import('esbuild').BuildOptions} */
const extension = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewJs = {
  entryPoints: ["src/webview/index.tsx"],
  bundle: true,
  outfile: "dist/webview.js",
  format: "iife",
  platform: "browser",
  sourcemap: !production,
  minify: production,
  jsx: "automatic",
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewCss = {
  entryPoints: ["src/webview/styles.css"],
  bundle: true,
  outfile: "dist/webview.css",
  logLevel: "info",
  minify: production,
};

async function build() {
  if (watch) {
    const ctxs = await Promise.all([
      esbuild.context(extension),
      esbuild.context(webviewJs),
      esbuild.context(webviewCss),
    ]);
    await Promise.all(ctxs.map((ctx) => ctx.watch()));
    console.log("[watch] bundling extension + webview");
    return;
  }
  await Promise.all([
    esbuild.build(extension),
    esbuild.build(webviewJs),
    esbuild.build(webviewCss),
  ]);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});

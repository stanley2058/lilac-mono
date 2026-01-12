const packageVersion = (await Bun.file("./package.json").json()).version;
await Bun.build({
  entrypoints: ["./client.ts"],
  outdir: "./dist",
  target: "node",
  define: {
    PACKAGE_VERSION: `"${packageVersion}"`,
  },
});

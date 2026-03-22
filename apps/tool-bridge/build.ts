await Bun.build({
  entrypoints: ["./client.ts"],
  outdir: "./dist",
  target: "node",
});

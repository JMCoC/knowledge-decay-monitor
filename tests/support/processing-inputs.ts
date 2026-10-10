/** Produces one deterministic, roughly 1,600-character paragraph per section. */
export function markdownSections(count: number): Buffer {
  return Buffer.from(Array.from({ length: count }, (_, index) =>
    `# Synthetic section ${index}\n\n${"Controlled recovery procedure. ".repeat(50)}`
  ).join("\n\n"), "utf8");
}

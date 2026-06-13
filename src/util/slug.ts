/**
 * Build a stable, unique provider name for a profile, used as the config table
 * key for tools that store providers by name (Codex TOML, Open Claw JSON).
 * Combines a slug of the label with a short suffix from the profile id.
 */
export function slugProvider(label: string, id: string): string {
  const slug = label.replace(/[^A-Za-z0-9]+/g, "");
  const suffix = id.slice(-6);
  return slug ? `Zion${slug}_${suffix}` : `ZionRouter_${suffix}`;
}

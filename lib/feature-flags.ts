/**
 * Feature flags.
 *
 * Unfinished work is merged behind a flag that defaults to off, so production
 * stays on the stable behavior while development continues on main. A flag is
 * turned on per environment with FEATURE_FLAGS, a comma-separated list of flag
 * names; a leading "-" turns a default-on flag off:
 *
 *   FEATURE_FLAGS=workspaceSwitcher,commentsCenter   # Vercel Preview
 *   FEATURE_FLAGS=-zernioIntegration                 # hide an existing feature
 *
 * Flags are read on the server only. Pass the result of getEnabledFeatureFlags()
 * to client components as a prop instead of reading process.env there, and
 * check the flag again in the API route the feature calls, so a hidden screen
 * is never the only thing standing between a user and an unfinished endpoint.
 *
 * Removing a flag: once its feature is stable, delete the entry, its checks and
 * any FEATURE_FLAGS mention in a single pull request.
 */

export const FEATURE_FLAGS = {
  /** Auto Insta visual design system (roadmap F1). */
  newDesign: { default: false },
  /** Workspace and Instagram account switchers (roadmap F2). */
  workspaceSwitcher: { default: false },
  /** Comments center and moderation (roadmap F6). */
  commentsCenter: { default: false },
  /** Contacts, tags and the contact side panel in the inbox (roadmap F5). */
  contacts: { default: false },
  /** Consolidated, exportable reports (roadmap F8). */
  reportsV2: { default: false },
  /** Optional Zernio connection under advanced integrations. Shipped and stable. */
  zernioIntegration: { default: true },
} as const satisfies Record<string, { default: boolean }>;

export type FeatureFlag = keyof typeof FEATURE_FLAGS;

function isFeatureFlag(name: string): name is FeatureFlag {
  return Object.prototype.hasOwnProperty.call(FEATURE_FLAGS, name);
}

/**
 * Overrides from FEATURE_FLAGS. Unknown names are ignored rather than thrown on,
 * so removing a flag from the code never breaks a deployment that still lists it.
 */
function readOverrides(): Partial<Record<FeatureFlag, boolean>> {
  const overrides: Partial<Record<FeatureFlag, boolean>> = {};
  for (const raw of (process.env.FEATURE_FLAGS ?? "").split(",")) {
    const entry = raw.trim();
    if (!entry) continue;
    const enabled = !entry.startsWith("-");
    const name = enabled ? entry : entry.slice(1).trim();
    if (isFeatureFlag(name)) overrides[name] = enabled;
  }
  return overrides;
}

export function isFeatureEnabled(flag: FeatureFlag): boolean {
  return readOverrides()[flag] ?? FEATURE_FLAGS[flag].default;
}

export function getEnabledFeatureFlags(): Record<FeatureFlag, boolean> {
  const overrides = readOverrides();
  return Object.fromEntries(
    (Object.keys(FEATURE_FLAGS) as FeatureFlag[]).map((flag) => [
      flag,
      overrides[flag] ?? FEATURE_FLAGS[flag].default,
    ])
  ) as Record<FeatureFlag, boolean>;
}

export type StartupSnapshotTarget =
  | { readonly kind: "home" }
  | { readonly kind: "goal"; readonly goalId: string }
  | {
      readonly kind: "cycle";
      readonly goalId: string;
      readonly cycleId: string;
    }
  | { readonly kind: "review"; readonly goalId: string }
  | { readonly kind: "none" };

export function startupSnapshotTarget(pathname: string): StartupSnapshotTarget {
  if (pathname === "/" || /^\/goals\/new\/?$/u.test(pathname))
    return { kind: "home" };
  const cycle = pathname.match(/^\/goals\/([^/]+)\/cycles\/([^/]+)\/?$/u);
  if (cycle) return { kind: "cycle", goalId: cycle[1]!, cycleId: cycle[2]! };
  const review = pathname.match(/^\/goals\/([^/]+)\/review\/?$/u);
  if (review) return { kind: "review", goalId: review[1]! };
  const goal = pathname.match(/^\/goals\/([^/]+)\/?$/u);
  if (goal && goal[1] !== "new") return { kind: "goal", goalId: goal[1]! };
  return { kind: "none" };
}

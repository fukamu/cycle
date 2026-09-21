// Generated from tokens/fukamu.tokens.json. DO NOT EDIT.
// Contract version: 0.1.0
// Canonical source revision: b57d1531f26c14e2f1f82440b9f150a3a185bd16
export type TokenPath =
  "border.width.default" |
  "color.accent" |
  "color.action.on-primary" |
  "color.action.primary" |
  "color.action.primary-hover" |
  "color.border.default" |
  "color.border.strong" |
  "color.focus.ring" |
  "color.status.danger.border" |
  "color.status.danger.foreground" |
  "color.status.danger.strong" |
  "color.status.danger.surface" |
  "color.status.success.foreground" |
  "color.status.success.surface" |
  "color.status.warning.border" |
  "color.status.warning.foreground" |
  "color.status.warning.surface" |
  "color.surface.default" |
  "color.surface.subtle" |
  "color.text.primary" |
  "color.text.secondary" |
  "font.family.body.ja" |
  "font.line-height.body.ja" |
  "font.line-height.editor" |
  "font.line-height.ui" |
  "font.size.body" |
  "font.size.editor" |
  "font.size.small" |
  "font.weight.bold" |
  "font.weight.medium" |
  "font.weight.regular" |
  "font.weight.semibold" |
  "interaction.target.min" |
  "motion.duration.short" |
  "radius.lg" |
  "radius.md" |
  "radius.pill" |
  "radius.sm" |
  "radius.xl" |
  "spacing.1" |
  "spacing.2" |
  "spacing.3" |
  "spacing.4" |
  "spacing.5" |
  "spacing.6" |
  "spacing.8";

export type TokenType = "color" | "dimension" | "duration" | "fontFamily" | "fontWeight" | "number";

export interface ColorValue {
  readonly colorSpace: "srgb";
  readonly components: readonly [number, number, number];
  readonly alpha: number;
}

export interface NumericValue {
  readonly value: number;
  readonly unit: "px" | "rem" | "ms" | "s";
}

export interface ResolvedToken {
  readonly type: TokenType;
  readonly value: string | number | readonly string[] | ColorValue | NumericValue;
  readonly cssValue: string;
  readonly cssVariable: `--fukamu-${string}`;
  readonly description: string;
  readonly sourcePath: string;
}

export declare const contractVersion: "0.1.0";
export declare const sourceRevision: string;
export declare const tokens: Readonly<Record<TokenPath, Readonly<ResolvedToken>>>;
export default tokens;

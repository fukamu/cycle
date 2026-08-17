const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function formatActivePeriod(startedAt: string): string {
  return `${dateFormatter.format(new Date(startedAt))} 〜`;
}

export function formatCompletedPeriod(
  startedAt: string,
  completedAt: string,
): string {
  const started = dateFormatter.format(new Date(startedAt));
  const completed = dateFormatter.format(new Date(completedAt));
  return started === completed ? started : `${started} 〜 ${completed}`;
}

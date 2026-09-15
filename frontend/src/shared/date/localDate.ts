const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ReviewDateState = "today" | "upcoming" | "overdue";

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function isValidLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return (
    year >= 1 &&
    year <= 9999 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

export function browserLocalDate(now: Date): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function classifyReviewDate(
  reviewDate: string,
  today: string,
): ReviewDateState {
  if (reviewDate === today) return "today";
  return reviewDate > today ? "upcoming" : "overdue";
}

export function nextLocalDateRefreshDelay(now: Date): number {
  const nextMidnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate() + 1,
  );
  const untilMidnight = Math.max(1, nextMidnight.getTime() - now.getTime());
  return Math.min(untilMidnight, 60 * 60 * 1000);
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function freePeriod(now = new Date()): { start: string; end: string } {
  const jst = new Date(now.getTime() + JST_OFFSET_MS);
  const year = jst.getUTCFullYear();
  const month = jst.getUTCMonth();
  return {
    start: dateOnly(new Date(Date.UTC(year, month, 1))),
    end: dateOnly(new Date(Date.UTC(year, month + 1, 0))),
  };
}

export function paidPeriodFromNextBillingDate(
  nextBillingDate: string,
): { start: string; end: string } {
  const [year, month, day] = nextBillingDate.split("-").map(Number);
  if (!year || !month || !day) throw new Error("Invalid LINE nextBillingDate");
  const next = new Date(Date.UTC(year, month - 1, day));
  const previousMonthLastDay = new Date(Date.UTC(year, month - 1, 0)).getUTCDate();
  const start = new Date(
    Date.UTC(year, month - 2, Math.min(day, previousMonthLastDay)),
  );
  const end = new Date(next.getTime() - 24 * 60 * 60 * 1000);
  return { start: dateOnly(start), end: dateOnly(end) };
}

export function nextAvailableDate(periodEnd: string): string {
  const date = new Date(`${periodEnd}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return dateOnly(date);
}

export function formatJapaneseDate(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  return `${year}年${month}月${day}日`;
}

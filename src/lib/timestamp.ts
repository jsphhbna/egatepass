export interface AppTimestamp {
  seconds: number;
  nanoseconds: number;
  toDate(): Date;
  toMillis(): number;
  toISOString(): string;
}

export function asAppTimestamp(
  val: unknown
): AppTimestamp | null {
  if (!val) return null;
  let date: Date;
  if (typeof val === 'object' && val !== null && 'toDate' in val && typeof (val as { toDate: () => unknown }).toDate === 'function') {
    date = (val as { toDate: () => Date }).toDate();
  } else if (typeof val === 'object' && val !== null && 'toMillis' in val && typeof (val as { toMillis: () => unknown }).toMillis === 'function') {
    date = new Date((val as { toMillis: () => number }).toMillis());
  } else if (val instanceof Date) {
    date = val;
  } else if (typeof val === 'number') {
    date = new Date(val);
  } else if (typeof val === 'string') {
    date = new Date(val);
  } else {
    return null;
  }

  if (Number.isNaN(date.getTime())) return null;

  const millis = date.getTime();
  const seconds = Math.floor(millis / 1000);
  const nanoseconds = (millis % 1000) * 1_000_000;

  return {
    seconds,
    nanoseconds,
    toDate: () => date,
    toMillis: () => millis,
    toISOString: () => date.toISOString(),
  };
}

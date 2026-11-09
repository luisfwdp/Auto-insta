import type { CreateBatchInput } from "./schemas";

type BatchItem = CreateBatchInput["items"][number];

function dateParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

/** Convert local wall-clock input to UTC, including DST offsets. */
export function zonedDateTimeToUtc(date: string, time: string, timeZone: string) {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desired;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = dateParts(new Date(candidate), timeZone);
    const rendered = Date.UTC(
      Number(actual.year), Number(actual.month) - 1, Number(actual.day),
      Number(actual.hour), Number(actual.minute), Number(actual.second)
    );
    const correction = desired - rendered;
    candidate += correction;
    if (correction === 0) break;
  }

  const result = new Date(candidate);
  const actual = dateParts(result, timeZone);
  if (`${actual.year}-${actual.month}-${actual.day}` !== date || `${actual.hour}:${actual.minute}` !== time) {
    throw new Error(`The local time ${date} ${time} does not exist in ${timeZone}`);
  }
  return result;
}

function addUtcDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function seededShuffle<T>(items: T[], seed: string) {
  let state = [...seed].reduce((total, char) => (total * 31 + char.charCodeAt(0)) >>> 0, 2166136261);
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (1664525 * state + 1013904223) >>> 0;
    const swap = state % (index + 1);
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
}

export function orderBatchItems(items: BatchItem[], mode: CreateBatchInput["orderMode"], seed: string, filenames: Map<string, string>) {
  if (mode === "RANDOM") return seededShuffle(items, seed);
  if (mode === "SEQUENTIAL") {
    return [...items].sort((left, right) =>
      (filenames.get(left.assetId) ?? left.assetId).localeCompare(filenames.get(right.assetId) ?? right.assetId)
    );
  }
  return [...items];
}

export function generateBatchSchedule(input: Pick<CreateBatchInput, "startsOn" | "postsPerDay" | "timeSlots" | "timezone">, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const day = Math.floor(index / input.postsPerDay);
    const slot = input.timeSlots[index % input.postsPerDay];
    return zonedDateTimeToUtc(addUtcDays(input.startsOn, day), slot, input.timezone);
  });
}

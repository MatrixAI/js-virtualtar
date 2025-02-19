import * as errors from './errors';

function never(message: string): never {
  throw new errors.ErrorVirtualTarUndefinedBehaviour(message);
}

function pad(
  value: string | number,
  length: number,
  padValue: string,
  end?: string,
): string {
  if (end != null) {
    return value.toString(8).padStart(length - end.length, padValue) + end;
  } else {
    return value.toString(8).padStart(length, padValue);
  }
}

function splitFileName(
  fileName: string,
  offset: number,
  size: number,
  padding: string = '\0',
) {
  return fileName.slice(offset, offset + size).padEnd(size, padding);
}

function dateToUnixTime(date: Date): number {
  return Math.round(date.getTime() / 1000);
}

export { never, pad, splitFileName, dateToUnixTime };

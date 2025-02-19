import { HeaderOffset, HeaderSize } from './types';
import * as errors from './errors';
import * as constants from './constants';

const nullRegex = /\0/g;

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

// PARSER

const decoder = new TextDecoder(constants.TEXT_ENCODING);

function extractBytes(
  view: DataView,
  offset?: number,
  length?: number,
): Uint8Array {
  return new Uint8Array(view.buffer, offset, length);
}

function extractChars(
  view: DataView,
  offset?: number,
  length?: number,
): string {
  return decoder
    .decode(extractBytes(view, offset, length))
    .replace(nullRegex, '');
}

function extractOctal(
  view: DataView,
  offset?: number,
  length?: number,
): number {
  const value = extractChars(view, offset, length);
  return value.length > 0 ? parseInt(value, 8) : 0;
}

function parseFileName(view: DataView) {
  const fileNameLower = extractChars(
    view,
    HeaderOffset.FILE_NAME,
    HeaderSize.FILE_NAME,
  );
  const fileNameUpper = extractChars(
    view,
    HeaderOffset.FILE_NAME_EXTRA,
    HeaderSize.FILE_NAME_EXTRA,
  );
  return fileNameLower + fileNameUpper;
}

function checkNullView(view: DataView): boolean {
  for (let i = 0; i < constants.BLOCK_SIZE; i++) {
    if (view.getUint8(i) !== 0) return false;
  }
  return true;
}

export {
  never,
  pad,
  splitFileName,
  dateToUnixTime,
  extractBytes,
  extractChars,
  extractOctal,
  parseFileName,
  checkNullView,
};

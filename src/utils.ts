import { HeaderOffset, HeaderSize } from './types';
import * as errors from './errors';
import * as constants from './constants';

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

function calculateChecksum(array: Uint8Array): number {
  return array.reduce((sum, byte, index) => {
    // Checksum placeholder is ASCII space, so assume checksum character is
    // space while computing it.
    if (
      index >= HeaderOffset.CHECKSUM &&
      index < HeaderOffset.CHECKSUM + HeaderSize.CHECKSUM
    ) {
      return sum + 32;
    }
    return sum + byte;
  });
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

const decoder = new TextDecoder('ascii');

// Returns a view of the array with the given offset and length. Note that the
// returned value is a view and not a copy, so any modifications to the data
// will affect the original data.
function extractBytes(
  array: Uint8Array,
  offset?: number,
  length?: number,
  stopOnNull: boolean = false,
): Uint8Array {
  const start = offset ?? 0;
  let end = length != null ? start + length : array.length;

  if (stopOnNull) {
    for (let i = start; i < end; i++) {
      if (array[i] === 0) {
        end = i;
        break;
      }
    }
  }

  return array.subarray(start, end);
}

function extractString(
  array: Uint8Array,
  offset?: number,
  length?: number,
): string {
  return decoder.decode(extractBytes(array, offset, length, true));
}

function extractOctal(
  array: Uint8Array,
  offset?: number,
  length?: number,
): number {
  const value = extractString(array, offset, length);
  return value.length > 0 ? parseInt(value, 8) : 0;
}

function parseFilePath(array: Uint8Array) {
  const fileNameLower = extractString(
    array,
    HeaderOffset.FILE_NAME,
    HeaderSize.FILE_NAME,
  );
  const fileNameUpper = extractString(
    array,
    HeaderOffset.FILE_NAME_EXTRA,
    HeaderSize.FILE_NAME_EXTRA,
  );
  return fileNameLower + fileNameUpper;
}

function isNullBlock(array: Uint8Array): boolean {
  for (let i = 0; i < constants.BLOCK_SIZE; i++) {
    if (array[i] !== 0) return false;
  }
  return true;
}

function writeBytesToArray(
  array: Uint8Array,
  bytes: string | ArrayLike<number>,
  offset: number,
  length: number,
): number {
  // Ensure indices are within valid bounds
  const start = Math.max(0, Math.min(offset, array.length));
  const end = Math.min(array.length, start + Math.max(0, length));
  const maxLength = end - start;

  let i = 0;
  for (; i < bytes.length && i < maxLength; i++) {
    array[start + i] =
      typeof bytes === 'string' ? bytes.charCodeAt(i) : bytes[i];
  }

  // Return number of bytes written
  return i;
}

export {
  never,
  pad,
  calculateChecksum,
  splitFileName,
  dateToUnixTime,
  extractBytes,
  extractString,
  extractOctal,
  parseFilePath,
  isNullBlock,
  writeBytesToArray,
};

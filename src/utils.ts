import { ExtendedHeaderKeywords, HeaderOffset, HeaderSize } from './types';
import * as errors from './errors';
import * as constants from './constants';

// Text decoder for text parsing utilities
const decoder = new TextDecoder('ascii');

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

// Returns a view of the array with the given offset and length. Note that the
// returned value is a view and not a copy, so any modifications to the data
// will affect the original data.
function extractBytes(
  array: Uint8Array,
  offset?: number,
  length?: number,
  stoppingCharacter?: string,
): Uint8Array {
  const start = offset ?? 0;
  let end = length != null ? start + length : array.length;

  if (stoppingCharacter != null) {
    for (let i = start; i < end; i++) {
      if (array[i] === stoppingCharacter.charCodeAt(0)) {
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
  stoppingCharacter: string = '\0',
): string {
  return decoder.decode(extractBytes(array, offset, length, stoppingCharacter));
}

function extractOctal(
  array: Uint8Array,
  offset?: number,
  length?: number,
  stoppingCharacter?: string,
): number {
  const value = extractString(array, offset, length, stoppingCharacter);
  return value.length > 0 ? parseInt(value, 8) : 0;
}

function extractDecimal(
  array: Uint8Array,
  offset?: number,
  length?: number,
  stoppingCharacter?: string,
): number {
  const value = extractString(array, offset, length, stoppingCharacter);
  return value.length > 0 ? parseInt(value, 10) : 0;
}

function parseFilePath(array: Uint8Array) {
  const fileNamePrefix = extractString(
    array,
    HeaderOffset.FILE_NAME_PREFIX,
    HeaderSize.FILE_NAME_PREFIX,
  );

  const fileNameSuffix = extractString(
    array,
    HeaderOffset.FILE_NAME,
    HeaderSize.FILE_NAME,
  );

  if (fileNamePrefix !== '') {
    return fileNamePrefix + fileNameSuffix;
  } else {
    return fileNameSuffix;
  }
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

function encodeExtendedHeader(
  data: Partial<Record<ExtendedHeaderKeywords, string>>,
): Uint8Array {
  const encoder = new TextEncoder();
  let totalByteSize = 0;
  const entries: Array<string> = [];

  // For extended PAX headers, the format of metadata is as follows:
  //   <size> <key>=<value>\n
  // Where <size> is the total length of the line including the key-value
  // pair, the separator \n character, the space between the size and
  // the line, and the size characters itself. Note \n is written using two
  // characters but it is a single ASCII byte.
  for (const [key, value] of Object.entries(data)) {
    let size = key.length + value.length + 3; // Initial guess (' ', =, \n)
    size += size.toString().length; // Adjust for size itself

    const entry = `${size} ${key}=${value}\n`;
    entries.push(entry);

    // Update the total byte length of the header with the entry's size
    totalByteSize += size;
  }

  // The entries are encoded later to reduce memory allocation
  const output = new Uint8Array(totalByteSize);
  let offset = 0;

  for (const entry of entries) {
    // Older browsers and runtimes might return written as undefined. That is
    // not a concern for us.
    const { written } = encoder.encodeInto(entry, output.subarray(offset));
    if (!written) throw new Error('TMP not written');
    offset += written;
  }

  return output;
}

function decodeExtendedHeader(
  array: Uint8Array,
): Partial<Record<ExtendedHeaderKeywords, string>> {
  const decoder = new TextDecoder();
  const data: Partial<Record<ExtendedHeaderKeywords, string>> = {};

  // Track offset and remaining bytes in the array
  let offset = 0;
  let remainingBytes = array.byteLength;

  while (remainingBytes > 0) {
    const size = extractDecimal(array, offset, undefined, ' ');
    const fullLine = decoder.decode(array.subarray(offset, offset + size));

    const sizeSeparatorIndex = fullLine.indexOf(' ');
    if (sizeSeparatorIndex === -1) {
      throw new Error('TMP invalid ennnntry');
    }
    const line = fullLine.substring(sizeSeparatorIndex + 1);

    const entrySeparatorIndex = line.indexOf('=');
    if (entrySeparatorIndex === -1) {
      throw new Error('TMP invalid ennnntry');
    }
    const key = line.substring(0, entrySeparatorIndex);
    const _value = line.substring(entrySeparatorIndex + 1);

    if (
      !Object.values(ExtendedHeaderKeywords).includes(
        key as ExtendedHeaderKeywords,
      )
    ) {
      throw new Error('TMP key doesnt exist');
    }

    // Remove the trailing newline
    const value = _value.substring(0, _value.length - 1);
    switch (key as ExtendedHeaderKeywords) {
      case ExtendedHeaderKeywords.FILE_PATH: {
        data[ExtendedHeaderKeywords.FILE_PATH] = value;
      }
    }

    offset += size;
    remainingBytes -= size;
  }

  return data;
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
  extractDecimal,
  parseFilePath,
  isNullBlock,
  writeBytesToArray,
  encodeExtendedHeader,
  decodeExtendedHeader,
};

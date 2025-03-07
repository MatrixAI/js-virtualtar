import {
  EntryType,
  ExtendedHeaderKeywords,
  HeaderOffset,
  HeaderSize,
} from './types';
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

function decodeFilePath(array: Uint8Array): string {
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

function writeFilePath(header: Uint8Array, filePath: string): void {
  // return fileName.slice(offset, offset + size).padEnd(size, padding);
  // If the length of the file path is less than 100 bytes, then we write it to
  // the file name. Otherwise, we write it into the file name prefix and append
  // file name to it.

  const filePathSuffix = filePath
    .slice(0, HeaderSize.FILE_NAME)
    .padEnd(HeaderSize.FILE_NAME, '\0');

  if (filePath.length < HeaderSize.FILE_NAME) {
    writeBytesToArray(
      header,
      filePathSuffix,
      HeaderOffset.FILE_NAME,
      HeaderSize.FILE_NAME,
    );
  } else {
    const filePathPrefix = filePath
      .slice(
        HeaderSize.FILE_NAME,
        HeaderSize.FILE_NAME + HeaderSize.FILE_NAME_PREFIX,
      )
      .padEnd(HeaderSize.FILE_NAME_PREFIX, '\0');

    writeBytesToArray(
      header,
      filePathPrefix,
      HeaderOffset.FILE_NAME,
      HeaderSize.FILE_NAME,
    );
    writeBytesToArray(
      header,
      filePathSuffix,
      HeaderOffset.FILE_NAME_PREFIX,
      HeaderSize.FILE_NAME_PREFIX,
    );
  }
}

function writeFileMode(header: Uint8Array, mode?: number): void {
  // The file permissions, or the mode, is stored in the next chunk. This is
  // stored in an octal number format.
  writeBytesToArray(
    header,
    pad(mode ?? '', HeaderSize.FILE_MODE, '0', '\0'),
    HeaderOffset.FILE_MODE,
    HeaderSize.FILE_MODE,
  );
}

function writeOwnerUid(header: Uint8Array, uid?: number): void {
  writeBytesToArray(
    header,
    pad(uid ?? '', HeaderSize.OWNER_UID, '0', '\0'),
    HeaderOffset.OWNER_UID,
    HeaderSize.OWNER_UID,
  );
}

function writeOwnerGid(header: Uint8Array, gid?: number): void {
  writeBytesToArray(
    header,
    pad(gid ?? '', HeaderSize.OWNER_GID, '0', '\0'),
    HeaderOffset.OWNER_GID,
    HeaderSize.OWNER_GID,
  );
}

function writeFileSize(header: Uint8Array, size?: number): void {
  // The file size is stored in this chunk. The file size must be zero for
  // directories, and it must be set for files.
  writeBytesToArray(
    header,
    pad(size ?? '', HeaderSize.FILE_SIZE, '0', '\0'),
    HeaderOffset.FILE_SIZE,
    HeaderSize.FILE_SIZE,
  );
}

function writeFileMtime(header: Uint8Array, mtime?: Date): void {
  // The file mtime is stored in this chunk. As the mtime is not modified when
  // extracting a TAR file, the mtime can be preserved while still getting
  // deterministic archives.
  const date = mtime != null ? dateToUnixTime(mtime) : '';
  writeBytesToArray(
    header,
    pad(date, HeaderSize.FILE_MTIME, '0', '\0'),
    HeaderOffset.FILE_MTIME,
    HeaderSize.FILE_MTIME,
  );
}

function writeFileType(
  header: Uint8Array,
  type: 'file' | 'directory' | 'extended',
): void {
  // The file mtime is stored in this chunk. As the mtime is not modified when
  // extracting a TAR file, the mtime can be preserved while still getting
  // deterministic archives.
  let entryType: EntryType;
  switch (type) {
    case 'file':
      entryType = EntryType.FILE;
      break;
    case 'directory':
      entryType = EntryType.DIRECTORY;
      break;
    case 'extended':
      entryType = EntryType.EXTENDED;
      break;
  }
  writeBytesToArray(
    header,
    pad(entryType, HeaderSize.TYPE_FLAG, '0', '\0'),
    HeaderOffset.TYPE_FLAG,
    HeaderSize.TYPE_FLAG,
  );
}

function writeUstarMagic(header: Uint8Array): void {
  // This value is the USTAR magic string which makes this file appear as
  // a tar file. Without this, the file cannot be parsed and extracted.
  writeBytesToArray(
    header,
    constants.USTAR_NAME,
    HeaderOffset.USTAR_NAME,
    HeaderSize.USTAR_NAME,
  );

  // This chunk stores the version of USTAR, which is '00' in this case.
  writeBytesToArray(
    header,
    constants.USTAR_VERSION,
    HeaderOffset.USTAR_VERSION,
    HeaderSize.USTAR_VERSION,
  );
}

function writeChecksum(header: Uint8Array, checksum: number): void {
  writeBytesToArray(
    header,
    pad(checksum, HeaderSize.CHECKSUM, '0', '\0'),
    HeaderOffset.CHECKSUM,
    HeaderSize.CHECKSUM,
  );
}

function writeOwnerUserName(header: Uint8Array, username?: string): void {
  writeBytesToArray(
    header,
    pad(username ?? '', HeaderSize.OWNER_USERNAME, '0', '\0'),
    HeaderOffset.OWNER_USERNAME,
    HeaderSize.OWNER_USERNAME,
  );
}

function writeOwnerGroupName(header: Uint8Array, groupname?: string): void {
  writeBytesToArray(
    header,
    pad(groupname ?? '', HeaderSize.OWNER_GROUPNAME, '0', '\0'),
    HeaderOffset.OWNER_GROUPNAME,
    HeaderSize.OWNER_GROUPNAME,
  );
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
  dateToUnixTime,
  extractBytes,
  extractString,
  extractOctal,
  extractDecimal,
  decodeFilePath,
  isNullBlock,
  writeBytesToArray,
  writeFilePath,
  writeFileMode,
  writeOwnerUid,
  writeOwnerGid,
  writeFileSize,
  writeFileMtime,
  writeFileType,
  writeUstarMagic,
  writeChecksum,
  writeOwnerUserName,
  writeOwnerGroupName,
  encodeExtendedHeader,
  decodeExtendedHeader,
};

import type { FileStat } from './types';
import { EntryType, HeaderSize, HeaderOffset } from './types';
import * as errors from './errors';
import * as utils from './utils';
import * as constants from './constants';

// Computes the checksum by adding the value of every single byte in the header
function computeChecksum(header: Buffer): number {
  if (!header.subarray(148, 156).every((byte) => byte === 32)) {
    throw new errors.ErrorVirtualTarInvalidHeader(
      'Checksum field is not properly initialized with spaces',
    );
  }
  return header.reduce((sum, byte) => sum + byte, 0);
}

// TODO: Should logging be included?
function createHeader(
  filePath: string,
  stat: FileStat,
  type: EntryType,
): Buffer {
  // TODO: implement long-file-name headers
  if (filePath.length < 1 || filePath.length > 255) {
    throw new errors.ErrorVirtualTarInvalidFileName(
      'The file name must be longer than 1 character and shorter than 255 characters',
    );
  }

  // The file path must not contain any directories, and must only contain a
  // file name. This guard checks that.
  if (filePath.includes('/')) {
    throw new errors.ErrorVirtualTarInvalidFileName(
      'File name must not contain /',
    );
  }

  // As the size does not matter for directories, it can be undefined. However,
  // if the header is being generated for a file, then it needs to have a valid
  // size. This guard checks that.
  if (stat.size == null && type === EntryType.FILE) {
    throw new errors.ErrorVirtualTarInvalidStat('Size must be set for files');
  }
  const size = type === EntryType.FILE ? stat.size : 0;

  // The time can be undefined, which would be referring to epoch 0.
  const time = utils.dateToUnixTime(stat.mtime ?? new Date());

  // Make sure to initialise the header with zeros to avoid writing nullish
  // blocks.
  const header = Buffer.alloc(constants.BLOCK_SIZE, 0);

  // The TAR headers follow this structure
  // Start    Size    Description
  // ------------------------------
  // 0        100     File name (first 100 bytes)
  // 100      8       File permissions (null-padded octal)
  // 108      8       Owner UID (null-padded octal)
  // 116      8       Owner GID (null-padded octal)
  // 124      12      File size (null-padded octal, 0 for directories)
  // 136      12      Mtime (null-padded octal)
  // 148      8       Checksum (fill with ASCII spaces for computation)
  // 156      1       Type flag ('0' for file, '5' for directory)
  // 157      100     File owner name (null-terminated ASCII/UTF-8)
  // 257      6       'ustar\0' (magic string)
  // 263      2       '00' (ustar version)
  // 265      32      Owner user name (null-terminated ASCII/UTF-8)
  // 297      32      Owner group name (null-terminated ASCII/UTF-8)
  // 329      8       Device major (unset in this implementation)
  // 337      8       Device minor (unset in this implementation)
  // 345      155     File name (last 155 bytes, total 255 bytes, null-padded)
  // 500      12      '\0' (unused)
  //
  // Note that all values are in ASCII format, which is different from the
  // default formatting of UTF-8 for Buffer.write(). All numbers are also in
  // octal format as opposed to decimal or hexadecimal.

  // The first half of the file name (upto 100 bytes) is stored here.
  header.write(
    utils.splitFileName(filePath, 0, HeaderSize.FILE_NAME),
    HeaderOffset.FILE_NAME,
    HeaderSize.FILE_NAME,
    constants.HEADER_ENCODING,
  );

  // The file permissions, or the mode, is stored in the next chunk. This is
  // stored in an octal number format.
  header.write(
    utils.pad(stat.mode ?? '', HeaderSize.FILE_MODE, '0', '\0'),
    HeaderOffset.FILE_MODE,
    HeaderSize.FILE_MODE,
    constants.HEADER_ENCODING,
  );

  // The owner UID is stored in this chunk
  header.write(
    utils.pad(stat.uid ?? '', HeaderSize.OWNER_UID, '0', '\0'),
    HeaderOffset.OWNER_UID,
    HeaderSize.OWNER_UID,
    constants.HEADER_ENCODING,
  );

  // The owner GID is stored in this chunk
  header.write(
    utils.pad(stat.gid ?? '', HeaderSize.OWNER_GID, '0', '\0'),
    HeaderOffset.OWNER_GID,
    HeaderSize.OWNER_GID,
    constants.HEADER_ENCODING,
  );

  // The file size is stored in this chunk. The file size must be zero for
  // directories, and it must be set for files.
  header.write(
    utils.pad(size ?? '', HeaderSize.FILE_SIZE, '0', '\0'),
    HeaderOffset.FILE_SIZE,
    HeaderSize.FILE_SIZE,
    constants.HEADER_ENCODING,
  );

  // The file mtime is stored in this chunk. As the mtime is not modified when
  // extracting a TAR file, the mtime can be preserved while still getting
  // deterministic archives.
  header.write(
    utils.pad(time, HeaderSize.FILE_MTIME, '0', '\0'),
    HeaderOffset.FILE_MTIME,
    HeaderSize.FILE_MTIME,
    constants.HEADER_ENCODING,
  );

  // The checksum is calculated as the sum of all bytes in the header. It is
  // padded using ASCII spaces, as we currently don't have all the data yet.
  header.write(
    utils.pad('', HeaderSize.CHECKSUM, ' '),
    HeaderOffset.CHECKSUM,
    HeaderSize.CHECKSUM,
    constants.HEADER_ENCODING,
  );

  // The type of file is written as a single byte in the header.
  header.write(
    type,
    HeaderOffset.TYPE_FLAG,
    HeaderSize.TYPE_FLAG,
    constants.HEADER_ENCODING,
  );

  // File owner name will be null, as regular stat-ing cannot extract that
  // information.

  // This value is the USTAR magic string which makes this file appear as
  // a tar file. Without this, the file cannot be parsed and extracted.
  header.write(
    constants.USTAR_NAME,
    HeaderOffset.USTAR_NAME,
    HeaderSize.USTAR_NAME,
    constants.HEADER_ENCODING,
  );

  // This chunk stores the version of USTAR, which is '00' in this case.
  header.write(
    constants.USTAR_VERSION,
    HeaderOffset.USTAR_VERSION,
    HeaderSize.USTAR_VERSION,
    constants.HEADER_ENCODING,
  );

  // Owner user name will be null, as regular stat-ing cannot extract this
  // information.

  // Owner group name will be null, as regular stat-ing cannot extract this
  // information.

  // Device major will be null, as this specific to linux kernel knowing what
  // drivers to use for executing certain files, and is irrelevant here.

  // Device minor will be null, as this specific to linux kernel knowing what
  // drivers to use for executing certain files, and is irrelevant here.

  // The second half of the file name is entered here. This chunk handles file
  // names ranging 100 to 255 characters.
  header.write(
    utils.splitFileName(
      filePath,
      HeaderSize.FILE_NAME,
      HeaderSize.FILE_NAME_EXTRA,
    ),
    HeaderOffset.FILE_NAME_EXTRA,
    HeaderSize.FILE_NAME_EXTRA,
    constants.HEADER_ENCODING,
  );

  // Updating with the new checksum
  const checksum = computeChecksum(header);

  // Note the extra space in the padding for the checksum value. It is
  // intentionally placed there. The padding for checksum is ASCII spaces
  // instead of null, which is why it is used like this here.
  header.write(
    utils.pad(checksum, HeaderSize.CHECKSUM, '0', '\0 '),
    HeaderOffset.CHECKSUM,
    HeaderSize.CHECKSUM,
    constants.HEADER_ENCODING,
  );

  return header;
}

// Creates blocks marking the ned of the header. Returns one buffer of 1024
// bytes filled with nulls. This aligns with the tar end-of-archive marker
// being two null-filled blocks.
function generateEndMarker() {
  return [Buffer.alloc(512, 0), Buffer.alloc(512, 0)];
}

export { createHeader, generateEndMarker };

import type { FileStat } from './types';
import { GeneratorState, EntryType, HeaderSize, HeaderOffset } from './types';
import * as errors from './errors';
import * as utils from './utils';
import * as constants from './constants';

function generateHeader(filePath: string, type: EntryType, stat: FileStat) {
  if (filePath.length > 255) {
    throw new errors.ErrorVirtualTarGeneratorInvalidFileName(
      'The file name must shorter than 255 characters',
    );
  }

  // The time can be undefined, which would be referring to epoch 0.
  const time = utils.dateToUnixTime(stat.mtime ?? new Date());

  const header = new Uint8Array(constants.BLOCK_SIZE);

  // If the length of the file path is less than 100 bytes, then we write it to
  // the file name. Otherwise, we write it into the file name prefix and append
  // file name to it.
  if (filePath.length < HeaderSize.FILE_NAME) {
    utils.writeBytesToArray(
      header,
      utils.splitFileName(filePath, 0, HeaderSize.FILE_NAME),
      HeaderOffset.FILE_NAME,
      HeaderSize.FILE_NAME,
    );
  } else {
    utils.writeBytesToArray(
      header,
      utils.splitFileName(
        filePath,
        HeaderSize.FILE_NAME,
        HeaderSize.FILE_NAME_PREFIX,
      ),
      HeaderOffset.FILE_NAME,
      HeaderSize.FILE_NAME,
    );
    utils.writeBytesToArray(
      header,
      utils.splitFileName(filePath, 0, HeaderSize.FILE_NAME),
      HeaderOffset.FILE_NAME_PREFIX,
      HeaderSize.FILE_NAME_PREFIX,
    );
  }

  // The file permissions, or the mode, is stored in the next chunk. This is
  // stored in an octal number format.
  utils.writeBytesToArray(
    header,
    utils.pad(stat.mode ?? '', HeaderSize.FILE_MODE, '0', '\0'),
    HeaderOffset.FILE_MODE,
    HeaderSize.FILE_MODE,
  );

  // The owner UID is stored in this chunk
  utils.writeBytesToArray(
    header,
    utils.pad(stat.uid ?? '', HeaderSize.OWNER_UID, '0', '\0'),
    HeaderOffset.OWNER_UID,
    HeaderSize.OWNER_UID,
  );

  // The owner GID is stored in this chunk
  utils.writeBytesToArray(
    header,
    utils.pad(stat.gid ?? '', HeaderSize.OWNER_GID, '0', '\0'),
    HeaderOffset.OWNER_GID,
    HeaderSize.OWNER_GID,
  );

  // The file size is stored in this chunk. The file size must be zero for
  // directories, and it must be set for files.
  utils.writeBytesToArray(
    header,
    utils.pad(stat.size ?? '', HeaderSize.FILE_SIZE, '0', '\0'),
    HeaderOffset.FILE_SIZE,
    HeaderSize.FILE_SIZE,
  );

  // The file mtime is stored in this chunk. As the mtime is not modified when
  // extracting a TAR file, the mtime can be preserved while still getting
  // deterministic archives.
  utils.writeBytesToArray(
    header,
    utils.pad(time, HeaderSize.FILE_MTIME, '0', '\0'),
    HeaderOffset.FILE_MTIME,
    HeaderSize.FILE_MTIME,
  );

  // The checksum is calculated as the sum of all bytes in the header. It is
  // left blank for later calculation.

  // The type of file is written as a single byte in the header.
  utils.writeBytesToArray(
    header,
    type,
    HeaderOffset.TYPE_FLAG,
    HeaderSize.TYPE_FLAG,
  );

  // Link name will be null, as regular stat-ing cannot extract that
  // information.

  // This value is the USTAR magic string which makes this file appear as
  // a tar file. Without this, the file cannot be parsed and extracted.
  utils.writeBytesToArray(
    header,
    constants.USTAR_NAME,
    HeaderOffset.USTAR_NAME,
    HeaderSize.USTAR_NAME,
  );

  // This chunk stores the version of USTAR, which is '00' in this case.
  utils.writeBytesToArray(
    header,
    constants.USTAR_VERSION,
    HeaderOffset.USTAR_VERSION,
    HeaderSize.USTAR_VERSION,
  );

  // Owner user name will be null, as regular stat-ing cannot extract this
  // information.

  // Owner group name will be null, as regular stat-ing cannot extract this
  // information.

  // Device major will be null, as this specific to linux kernel knowing what
  // drivers to use for executing certain files, and is irrelevant here.

  // Device minor will be null, as this specific to linux kernel knowing what
  // drivers to use for executing certain files, and is irrelevant here.

  // Updating with the new checksum
  const checksum = utils.calculateChecksum(header);

  // Note the extra space in the padding for the checksum value. It is
  // intentionally placed there. The padding for checksum is ASCII spaces
  // instead of null, which is why it is used like this here.
  utils.writeBytesToArray(
    header,
    utils.pad(checksum, HeaderSize.CHECKSUM, '0', '\0'),
    HeaderOffset.CHECKSUM,
    HeaderSize.CHECKSUM,
  );

  return header;
}

/**
 * The TAR headers follow this structure
 * Start    Size    Description
 * ------------------------------
 * 0        100     File name (first 100 bytes)
 * 100      8       File mode (null-padded octal)
 * 108      8       Owner user id (null-padded octal)
 * 116      8       Owner group id (null-padded octal)
 * 124      12      File size in bytes (null-padded octal, 0 for directories)
 * 136      12      Mtime (null-padded octal)
 * 148      8       Checksum (fill with ASCII spaces for computation)
 * 156      1       Type flag ('0' for file, '5' for directory)
 * 157      100     Link name (null-terminated ASCII/UTF-8)
 * 257      6       'ustar\0' (magic string)
 * 263      2       '00' (ustar version)
 * 265      32      Owner user name (null-terminated ASCII/UTF-8)
 * 297      32      Owner group name (null-terminated ASCII/UTF-8)
 * 329      8       Device major (unset in this implementation)
 * 337      8       Device minor (unset in this implementation)
 * 345      155     File name (last 155 bytes, total 255 bytes, null-padded)
 * 500      12      '\0' (unused)
 *
 * Note that all numbers are in stringified octal format.
 */
class Generator {
  protected state: GeneratorState = GeneratorState.READY;
  protected remainingBytes = 0;

  generateFile(filePath: string, stat: FileStat): Uint8Array {
    if (this.state === GeneratorState.READY) {
      // Make sure the size is valid
      if (stat.size == null) {
        throw new errors.ErrorVirtualTarGeneratorInvalidStat(
          'Files should have valid file sizes',
        );
      }

      const generatedBlock = generateHeader(filePath, EntryType.FILE, stat);

      // If no data is in the file, then there is no need of a data block. It
      // will remain as READY.
      if (stat.size !== 0) this.state = GeneratorState.DATA;
      this.remainingBytes = stat.size;

      return generatedBlock;
    }
    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.READY]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  generateDirectory(filePath: string, stat: FileStat): Uint8Array {
    if (this.state === GeneratorState.READY) {
      const directoryStat: FileStat = {
        size: 0,
        mode: stat.mode,
        mtime: stat.mtime,
        uid: stat.uid,
        gid: stat.gid,
      };
      return generateHeader(filePath, EntryType.DIRECTORY, directoryStat);
    }
    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.READY]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  generateExtended(size: number): Uint8Array {
    if (this.state === GeneratorState.READY) {
      this.state = GeneratorState.DATA;
      this.remainingBytes = size;
      return generateHeader('', EntryType.EXTENDED, { size });
    }
    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.READY]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  generateData(data: Uint8Array): Uint8Array {
    if (data.byteLength > constants.BLOCK_SIZE) {
      throw new errors.ErrorVirtualTarGeneratorBlockSize(
        `Expected data to be ${constants.BLOCK_SIZE} bytes but received ${data.byteLength} bytes`,
      );
    }

    if (this.state === GeneratorState.DATA) {
      if (this.remainingBytes >= constants.BLOCK_SIZE) {
        this.remainingBytes -= constants.BLOCK_SIZE;
        if (this.remainingBytes === 0) this.state = GeneratorState.READY;
        return data;
      } else {
        // Update state
        this.remainingBytes = 0;
        this.state = GeneratorState.READY;

        // Pad the remaining data with nulls
        const paddedData = new Uint8Array(constants.BLOCK_SIZE);
        paddedData.set(data, 0);
        return paddedData;
      }
    }

    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.DATA]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  // Creates a single null block. A null block is a block filled with all zeros.
  // This is needed to end the archive, as two of these blocks mark the end of
  // archive.
  generateEnd() {
    switch (this.state) {
      case GeneratorState.READY:
        this.state = GeneratorState.NULL;
        break;
      case GeneratorState.NULL:
        this.state = GeneratorState.ENDED;
        break;
      default:
        throw new errors.ErrorVirtualTarGeneratorEndOfArchive(
          'Exactly two null chunks should be generated consecutively to end archive',
        );
    }
    return new Uint8Array(constants.BLOCK_SIZE);
  }
}

export default Generator;

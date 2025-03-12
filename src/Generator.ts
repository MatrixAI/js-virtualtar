import type { FileType, FileStat } from './types';
import { GeneratorState, HeaderSize } from './types';
import * as errors from './errors';
import * as utils from './utils';
import * as constants from './constants';

/**
 * The TAR headers follow this structure:
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
 *
 * The following data will be left blank (null):
 *  - Link name
 *  - Owner user name
 *  - Owner group name
 *  - Device major
 *  - Device minor
 *
 *  This is because this implementation does not interact with linked files.
 *  Owner user name and group name cannot be extracted via regular stat-ing,
 *  so it is left blank. In virtual situations, this field won't be useful
 *  anyways. The device major and minor are specific to linux kernel, which
 *  is not relevant to this virtual tar implementation. This is the reason
 *  these fields have been left blank.
 */
class Generator {
  protected state: GeneratorState = GeneratorState.HEADER;
  protected remainingBytes = 0;

  protected generateHeader(
    filePath: string,
    type: FileType,
    stat: FileStat,
  ): Uint8Array {
    if (filePath.length > 255) {
      throw new errors.ErrorVirtualTarGeneratorInvalidFileName(
        'The file name must shorter than 255 characters',
      );
    }

    if (stat?.size != null && stat?.size > 0o7777777) {
      throw new errors.ErrorVirtualTarGeneratorInvalidStat(
        'The file size must be smaller than 7.99 GiB (8,589,934,591 bytes)',
      );
    }

    if (stat?.uname != null && stat?.uname.length > HeaderSize.OWNER_USERNAME) {
      throw new errors.ErrorVirtualTarGeneratorInvalidStat(
        `The username must not exceed ${HeaderSize.OWNER_USERNAME} bytes`,
      );
    }

    if (
      stat?.gname != null &&
      stat?.gname.length > HeaderSize.OWNER_GROUPNAME
    ) {
      throw new errors.ErrorVirtualTarGeneratorInvalidStat(
        `The groupname must not exceed ${HeaderSize.OWNER_GROUPNAME} bytes`,
      );
    }

    const header = new Uint8Array(constants.BLOCK_SIZE);

    // Every directory in tar must have a trailing slash
    if (type === 'directory') {
      filePath = filePath.endsWith('/') ? filePath : filePath + '/';
    }

    utils.writeUstarMagic(header);
    utils.writeFileType(header, type);
    utils.writeFilePath(header, filePath);
    utils.writeFileMode(header, stat.mode);
    utils.writeOwnerUid(header, stat.uid);
    utils.writeOwnerGid(header, stat.gid);
    utils.writeOwnerUserName(header, stat.uname);
    utils.writeOwnerGroupName(header, stat.gname);
    utils.writeFileSize(header, stat.size);
    utils.writeFileMtime(header, stat.mtime);

    // The checksum can only be calculated once the entire header has been
    // written. This is why the checksum is calculated and written at the end.
    utils.writeChecksum(header, utils.calculateChecksum(header));

    return header;
  }

  generateFile(filePath: string, stat: FileStat): Uint8Array {
    if (this.state === GeneratorState.HEADER) {
      // Make sure the size is valid
      if (stat.size == null) {
        throw new errors.ErrorVirtualTarGeneratorInvalidStat(
          'Files must have valid file sizes',
        );
      }

      const generatedBlock = this.generateHeader(filePath, 'file', stat);

      // If no data is in the file, then there is no need of a data block. It
      // will remain as READY.
      if (stat.size !== 0) {
        this.state = GeneratorState.DATA;
        this.remainingBytes = stat.size;
      }

      return generatedBlock;
    }
    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.HEADER]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  generateDirectory(filePath: string, stat?: FileStat): Uint8Array {
    if (this.state === GeneratorState.HEADER) {
      // The size is zero for directories. Override this value in the stat if
      // set.
      const directoryStat: FileStat = {
        ...stat,
        size: 0,
      };
      return this.generateHeader(filePath, 'directory', directoryStat);
    }
    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.HEADER]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  generateExtended(size: number): Uint8Array {
    if (this.state === GeneratorState.HEADER) {
      this.state = GeneratorState.DATA;
      this.remainingBytes = size;
      return this.generateHeader('./PaxHeader', 'extended', { size });
    }
    throw new errors.ErrorVirtualTarGeneratorInvalidState(
      `Expected state ${GeneratorState[GeneratorState.HEADER]} but got ${
        GeneratorState[this.state]
      }`,
    );
  }

  generateData(data: Uint8Array): Uint8Array {
    if (this.state === GeneratorState.DATA) {
      if (data.byteLength > constants.BLOCK_SIZE) {
        throw new errors.ErrorVirtualTarGeneratorBlockSize(
          `Expected data to be ${constants.BLOCK_SIZE} bytes but received ${data.byteLength} bytes`,
        );
      }

      if (this.remainingBytes >= constants.BLOCK_SIZE) {
        this.remainingBytes -= constants.BLOCK_SIZE;
        if (this.remainingBytes === 0) this.state = GeneratorState.HEADER;
        return data;
      } else {
        // Make sure we don't attempt to write extra data
        if (data.byteLength !== this.remainingBytes) {
          throw new errors.ErrorVirtualTarGeneratorBlockSize(
            `Expected data to be ${this.remainingBytes} bytes but received ${data.byteLength} bytes`,
          );
        }

        // Update state
        this.remainingBytes = 0;
        this.state = GeneratorState.HEADER;

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
  generateEnd(): Uint8Array {
    switch (this.state) {
      case GeneratorState.HEADER:
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

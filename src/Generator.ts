import type { FileType, FileStat } from './types';
import { GeneratorState, HeaderSize } from './types';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

/**
 * The Generator can be used to generate blocks for a tar archive. The generator
 * can create three kinds of headers: FILE, DIRECTORY, and EXTENDED. The file and
 * directory is expected, but the extended header is able to store additional
 * metadata that does not fit in the standard header.
 *
 * This class can also be used to generate data chunks padded to 512 bytes. Note
 * that the chunk size shouldn't exceed 512 bytes.
 *
 * Note that the generator maintains an internal state and must be used for
 * operations like generating data chunks, end chunks, or headers, otherwise an
 * error will be thrown.
 *
 * For reference, this is the structure of a tar header.
 *
 * | Start  | Size | Description                                               |
 * |--------|------|-----------------------------------------------------------|
 * | 0      | 100  | File name (first 100 bytes)                               |
 * | 100    | 8    | File mode (null-padded octal)                             |
 * | 108    | 8    | Owner user ID (null-padded octal)                         |
 * | 116    | 8    | Owner group ID (null-padded octal)                        |
 * | 124    | 12   | File size in bytes (null-padded octal, 0 for directories) |
 * | 136    | 12   | Mtime (null-padded octal)                                 |
 * | 148    | 8    | Checksum (fill with ASCII spaces for computation)         |
 * | 156    | 1    | Type flag ('0' for file, '5' for directory)               |
 * | 157    | 100  | Link name (null-terminated ASCII/UTF-8)                   |
 * | 257    | 6    | 'ustar\0' (magic string)                                  |
 * | 263    | 2    | '00' (ustar version)                                      |
 * | 265    | 32   | Owner user name (null-terminated ASCII/UTF-8)             |
 * | 297    | 32   | Owner group name (null-terminated ASCII/UTF-8)            |
 * | 329    | 8    | Device major (unset in this implementation)               |
 * | 337    | 8    | Device minor (unset in this implementation)               |
 * | 345    | 155  | File name (last 155 bytes, total 255 bytes, null-padded)  |
 * | 500    | 12   | '\0' (unused)                                             |
 *
 * Note that all numbers are in stringified octal format, as opposed to the
 * numbers used in the extended header, which are all in stringified decimal.
 *
 * The following data will be left blank (null):
 *  - Link name
 *  - Device major
 *  - Device minor
 *
 * This is because this implementation does not interact with linked files.
 * The device major and minor are specific to linux kernel, which is not
 * relevant to this virtual tar implementation. This is the reason these fields
 * have been left blank.
 *
 * The data for extended headers is formatted slightly differently, with the
 * general format following this structure.
 *  <size> <key>=<value>\n
 *
 * Here, the <size> stands for the byte length of the entire line (including the
 * size number itself, the space, the equals, and the \n). Unlike in regular
 * strings, the end marker for a key-value pair is the \n (newline) character.
 * Moreover, unlike the USTAR header, the numbers are written in stringified
 * decimal format.
 *
 * The key can be any supported metadata key, and the value is binary data
 * storing the actual value. These are the currently supported keys for
 * the extended metadata:
 *  - path (corresponding to file path if it is longer than 255 characters)
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

    // Write the relevant sections in the header with the provided data
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

  /**
   * Generates a file header based on the file path and the stat. Note that the
   * stat must provide a size for the file, but all other fields are optional.
   * If the file path is longer than 255 characters, then an error will be
   * thrown. An extended header needs to be generated first, then the file path
   * can be set to an empty string.
   *
   * The content of the file must follow this header in separate chunks.
   *
   * @param filePath the path of the file relative to the tar root
   * @param stat the stats of the file
   * @returns one 512-byte chunk corresponding to the header
   *
   * @see {@link generateExtended} for generating headers with extended metadata
   * @see {@link generateDirectory} for generating directory headers instead
   * @see {@link generateData} for generating data chunks
   */
  generateFile(filePath: string, stat: FileStat): Uint8Array {
    if (this.state === GeneratorState.HEADER) {
      // Make sure the size is valid
      if (stat.size == null || stat.size < 0) {
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

  /**
   * Generates a directory header based on the file path and the stat. Note that
   * the size is ignored and set to 0 for directories. If the file path is longer
   * than 255 characters, then an error will be thrown. An extended header needs
   * to be generated first, then the file path can be set to an empty string.
   *
   * @param filePath the path of the file relative to the tar root
   * @param stat the stats of the file
   * @returns one 512-byte chunk corresponding to the header
   *
   * @see {@link generateExtended} for generating headers with extended metadata
   * @see {@link generateFile} for generating file headers instead
   */
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

  /**
   * Generates an extended metadata header based on the total size of the data
   * following the header. If there is no need for extended metadata, then avoid
   * using this, as it would just waste space.
   *
   * @param size the size of the binary data block containing the metadata
   * @returns one 512-byte chunk corresponding to the header
   */
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

  /**
   * Generates a data block. The input must be 512 bytes in size or smaller. The
   * input data cannot be chunked smaller than 512 bytes. For example, if the
   * file size is 1023 bytes, then you need to provide a 512-byte chunk first,
   * then provide the remaining 511-byte chunk later. You can not chunk it up
   * like sending over the first 100 bytes, then sending over the next 512.
   *
   * This method is used to generate blocks for both a file and the exnteded
   * header.
   *
   * @param data a block of binary data (512-bytes at largest)
   * @returns one 512-byte padded chunk corresponding to the data block
   *
   * @see {@link generateExtended} for generating headers with extended metadata
   * @see {@link generateFile} for generating file headers preceeding data block
   */
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
        if (data.byteLength > this.remainingBytes) {
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

  /**
   * Generates a null chunk. Two invocations are needed to create a valid
   * archive end marker. After two invocations, the generator state will be
   * set to ENDED and no further data can be fed through the generator.
   *
   * @returns one 512-byte null chunk
   */
  generateEnd(): Uint8Array {
    switch (this.state) {
      case GeneratorState.HEADER:
        this.state = GeneratorState.NULL;
        break;
      case GeneratorState.NULL:
        this.state = GeneratorState.ENDED;
        break;
      default:
        throw new errors.ErrorVirtualTarGeneratorInvalidState(
          `Expected state ${GeneratorState[GeneratorState.HEADER]} or ${
            GeneratorState[GeneratorState.NULL]
          } but got ${GeneratorState[this.state]}`,
        );
    }
    return new Uint8Array(constants.BLOCK_SIZE);
  }
}

export default Generator;

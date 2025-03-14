import type { TokenHeader, TokenData, TokenEnd } from './types';
import { ParserState } from './types';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

/**
 * The Parser is used to parse blocks from a tar archive. Each written chunk can
 * return either a token or undefined. Undefined will only be returned when
 * parsing the first null chunk which signifies that the archive has ended. The
 * tokens can be either a header token corresponding to either a file, a
 * directory, or an extended header, a data token returning the data, and an end
 * token signifiying the ending of the archive.
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
class Parser {
  protected state: ParserState = ParserState.HEADER;
  protected remainingBytes = 0;

  protected parseHeader(array: Uint8Array): TokenHeader {
    // Validate header by checking checksum and magic string
    const headerChecksum = utils.decodeChecksum(array);
    const calculatedChecksum = utils.calculateChecksum(array);

    if (headerChecksum !== calculatedChecksum) {
      throw new errors.ErrorVirtualTarParserInvalidHeader(
        `Expected checksum to be ${calculatedChecksum} but received ${headerChecksum}`,
      );
    }

    const ustarMagic = utils.decodeUstarMagic(array);
    if (ustarMagic !== constants.USTAR_NAME) {
      throw new errors.ErrorVirtualTarParserInvalidHeader(
        `Expected ustar magic to be '${constants.USTAR_NAME}', got '${ustarMagic}'`,
      );
    }

    const ustarVersion = utils.decodeUstarVersion(array);
    if (ustarVersion !== constants.USTAR_VERSION) {
      throw new errors.ErrorVirtualTarParserInvalidHeader(
        `Expected ustar version to be '${constants.USTAR_VERSION}', got '${ustarVersion}'`,
      );
    }

    // Extract the relevant metadata from the header
    const filePath = utils.decodeFilePath(array);
    const fileSize = utils.decodeFileSize(array);
    const fileMtime = utils.decodeFileMtime(array);
    const fileMode = utils.decodeFileMode(array);
    const ownerUid = utils.decodeOwnerUid(array);
    const ownerGid = utils.decodeOwnerGid(array);
    const ownerUserName = utils.decodeOwnerUserName(array);
    const ownerGroupName = utils.decodeOwnerGroupName(array);
    const fileType = utils.decodeFileType(array);

    return {
      type: 'header',
      filePath,
      fileType,
      fileMode,
      fileMtime,
      fileSize,
      ownerGid,
      ownerUid,
      ownerUserName,
      ownerGroupName,
    };
  }

  protected parseData(array: Uint8Array, remainingBytes: number): TokenData {
    if (remainingBytes > 512) {
      return { type: 'data', data: utils.extractBytes(array), end: false };
    } else {
      const data = utils.extractBytes(array, 0, remainingBytes);
      return { type: 'data', data: data, end: true };
    }
  }

  /**
   * Each chunk in a tar archive is exactly 512 bytes long. This chunk needs to
   * be written to the parser, which will return a single token. This token can
   * be one of a header token, a data token, an end token, or undefined. The
   * undefined token is only returned when the chunk does not correspond to an
   * actual token. For example, the first null chunk in the archive end marker
   * will return an undefined. The second null chunk will return an end token.
   *
   * The header token can return different types of headers. The three supported
   * headers are FILE, DIRECTORY, and EXTENDED. Note that the file stat is
   * returned with each header. It might contain default values if it was not
   * set in the header. The default value for strings is '', for numbers is 0,
   * and for dates is Date(0), which is 11:00 AM 1 January 1970.
   *
   * Note that extended headers will not be automatically parsed. If some
   * metadata was put into the extended header instead, then it will need to be
   * parsed separately to get the information out, and the metadata field in the
   * header will contain the default value for its type.
   *
   * A data header is pretty simple, containing the bytes of the file. Note that
   * this is not aligned to the 512-byte boundary. For example, if a file has
   * 513 bytes of data, then the first chunk will return the 512 bytes of data,
   * and the next data chunk will return 1 byte, removing the padding. The data
   * token also has another field, `end`. This is a boolean which is true when
   * the last chunk of data is being sent. The expected token after an ended
   * data token is a header or an end token.
   *
   * The end token signifies that the archive has ended. This sets the internal
   * state to ENDED, and no further data can be written to it and attempts to
   * write any additional data will throw an error.
   *
   * @param data a single 512-byte chunk from the tar file
   * @returns a parsed token, or undefined if no tokens can be returned
   */
  write(data: Uint8Array): TokenHeader | TokenData | TokenEnd | undefined {
    if (data.byteLength !== constants.BLOCK_SIZE) {
      throw new errors.ErrorVirtualTarParserBlockSize(
        `Expected block size to be ${constants.BLOCK_SIZE} bytes but received ${data.byteLength} bytes`,
      );
    }

    switch (this.state) {
      case ParserState.ENDED: {
        throw new errors.ErrorVirtualTarParserEndOfArchive(
          'Archive has already ended',
        );
      }

      case ParserState.HEADER: {
        // Check if we need to parse the end-of-archive marker
        if (utils.isNullBlock(data)) {
          this.state = ParserState.NULL;
          return;
        }

        // Set relevant state if the header corresponds to a file. If the file
        // size 0, then no data blocks will follow the header.
        const headerToken = this.parseHeader(data);
        if (headerToken.fileType === 'file') {
          if (headerToken.fileSize !== 0) {
            this.state = ParserState.DATA;
            this.remainingBytes = headerToken.fileSize;
          }
        } else if (headerToken.fileType === 'extended') {
          // A header might not have any data but a metadata header will always
          // be followed by data.
          this.state = ParserState.DATA;
          this.remainingBytes = headerToken.fileSize;
        }
        return headerToken;
      }

      case ParserState.DATA: {
        const parsedData = this.parseData(data, this.remainingBytes);
        this.remainingBytes -= constants.BLOCK_SIZE;
        if (this.remainingBytes <= 0) this.state = ParserState.HEADER;
        return parsedData;
      }

      case ParserState.NULL: {
        if (utils.isNullBlock(data)) {
          this.state = ParserState.ENDED;
          return { type: 'end' } as TokenEnd;
        } else {
          throw new errors.ErrorVirtualTarParserEndOfArchive(
            'Received garbage data after first end marker',
          );
        }
      }

      default:
        utils.never('Unexpected state');
    }
  }
}

export default Parser;

import type { TokenHeader, TokenData, TokenEnd } from './types';
import { ParserState } from './types';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

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

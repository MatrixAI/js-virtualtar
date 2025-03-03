import type { HeaderToken, DataToken, EndToken } from './types';
import { ParserState } from './types';
import { HeaderOffset, HeaderSize, EntryType } from './types';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

function parseHeader(array: Uint8Array): HeaderToken {
  // Validate header by checking checksum and magic string
  const headerChecksum = utils.extractOctal(
    array,
    HeaderOffset.CHECKSUM,
    HeaderSize.CHECKSUM,
  );
  const calculatedChecksum = utils.calculateChecksum(array);

  if (headerChecksum !== calculatedChecksum) {
    throw new errors.ErrorTarParserInvalidHeader(
      `Expected checksum to be ${calculatedChecksum} but received ${headerChecksum}`,
    );
  }

  const ustarMagic = utils.extractString(
    array,
    HeaderOffset.USTAR_NAME,
    HeaderSize.USTAR_NAME,
  );
  if (ustarMagic !== constants.USTAR_NAME) {
    throw new errors.ErrorTarParserInvalidHeader(
      `Expected ustar magic to be '${constants.USTAR_NAME}', got '${ustarMagic}'`,
    );
  }

  const ustarVersion = utils.extractString(
    array,
    HeaderOffset.USTAR_VERSION,
    HeaderSize.USTAR_VERSION,
  );
  if (ustarVersion !== constants.USTAR_VERSION) {
    throw new errors.ErrorTarParserInvalidHeader(
      `Expected ustar version to be '${constants.USTAR_VERSION}', got '${ustarVersion}'`,
    );
  }

  // Extract the relevant metadata from the header
  const filePath = utils.parseFilePath(array);
  const fileSize = utils.extractOctal(
    array,
    HeaderOffset.FILE_SIZE,
    HeaderSize.FILE_SIZE,
  );
  const fileMtime = new Date(
    utils.extractOctal(array, HeaderOffset.FILE_MTIME, HeaderSize.FILE_MTIME) *
      1000,
  );
  const fileMode = utils.extractOctal(
    array,
    HeaderOffset.FILE_MODE,
    HeaderSize.FILE_MODE,
  );
  const ownerGid = utils.extractOctal(
    array,
    HeaderOffset.OWNER_GID,
    HeaderSize.OWNER_GID,
  );
  const ownerUid = utils.extractOctal(
    array,
    HeaderOffset.OWNER_UID,
    HeaderSize.OWNER_UID,
  );
  const ownerName = utils.extractString(
    array,
    HeaderOffset.OWNER_NAME,
    HeaderSize.OWNER_NAME,
  );
  const ownerGroupName = utils.extractString(
    array,
    HeaderOffset.OWNER_GROUPNAME,
    HeaderSize.OWNER_GROUPNAME,
  );
  const ownerUserName = utils.extractString(
    array,
    HeaderOffset.OWNER_USERNAME,
    HeaderSize.OWNER_USERNAME,
  );
  const fileType =
    utils.extractString(array, HeaderOffset.TYPE_FLAG, HeaderSize.TYPE_FLAG) ===
    EntryType.FILE
      ? 'file'
      : 'directory';

  return {
    type: 'header',
    filePath,
    fileType,
    fileMode,
    fileMtime,
    fileSize,
    ownerGid,
    ownerUid,
    ownerName,
    ownerUserName,
    ownerGroupName,
  };
}

function parseData(array: Uint8Array, remainingBytes: number): DataToken {
  if (remainingBytes > 512) {
    return { type: 'data', data: utils.extractBytes(array) };
  } else {
    const data = utils.extractBytes(array, 0, remainingBytes);
    return { type: 'data', data: data };
  }
}

class Parser {
  protected state: ParserState = ParserState.READY;
  protected remainingBytes = 0;

  write(data: Uint8Array) {
    if (data.byteLength !== constants.BLOCK_SIZE) {
      throw new errors.ErrorTarParserBlockSize(
        `Expected block size to be ${constants.BLOCK_SIZE} bytes but received ${data.byteLength} bytes`,
      );
    }

    switch (this.state) {
      case ParserState.ENDED: {
        throw new errors.ErrorTarParserEndOfArchive(
          'Archive has already ended',
        );
      }

      case ParserState.READY: {
        // Check if we need to parse the end-of-archive marker
        if (utils.isNullBlock(data)) {
          this.state = ParserState.NULL;
          return;
        }

        // Set relevant state if the header corresponds to a file
        const headerToken = parseHeader(data);
        if (headerToken.fileType === 'file') {
          this.state = ParserState.DATA;
          this.remainingBytes = headerToken.fileSize;
        }
        return headerToken;
      }

      case ParserState.DATA: {
        const parsedData = parseData(data, this.remainingBytes);
        this.remainingBytes -= 512;
        if (this.remainingBytes < 0) this.state = ParserState.READY;
        return parsedData;
      }

      case ParserState.NULL: {
        if (utils.isNullBlock(data)) {
          this.state = ParserState.ENDED;
          return { type: 'end' } as EndToken;
        } else {
          throw new errors.ErrorTarParserEndOfArchive(
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

import type { HeaderToken, DataToken, EndToken } from './types';
import { ParserState } from './types';
import { HeaderOffset, HeaderSize, EntryType } from './types';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

function parseHeader(view: DataView): HeaderToken {
  // TODO: confirm integrity by checking against checksum
  const filePath = utils.parseFilePath(view);
  const fileSize = utils.extractOctal(
    view,
    HeaderOffset.FILE_SIZE,
    HeaderSize.FILE_SIZE,
  );
  const fileMtime = new Date(
    utils.extractOctal(view, HeaderOffset.FILE_MTIME, HeaderSize.FILE_MTIME) *
      1000,
  );
  const fileMode = utils.extractOctal(
    view,
    HeaderOffset.FILE_MODE,
    HeaderSize.FILE_MODE,
  );
  const ownerGid = utils.extractOctal(
    view,
    HeaderOffset.OWNER_GID,
    HeaderSize.OWNER_GID,
  );
  const ownerUid = utils.extractOctal(
    view,
    HeaderOffset.OWNER_UID,
    HeaderSize.OWNER_UID,
  );
  const ownerName = utils.extractString(
    view,
    HeaderOffset.OWNER_NAME,
    HeaderSize.OWNER_NAME,
  );
  const ownerGroupName = utils.extractString(
    view,
    HeaderOffset.OWNER_GROUPNAME,
    HeaderSize.OWNER_GROUPNAME,
  );
  const ownerUserName = utils.extractString(
    view,
    HeaderOffset.OWNER_USERNAME,
    HeaderSize.OWNER_USERNAME,
  );
  const fileType =
    utils.extractString(view, HeaderOffset.TYPE_FLAG, HeaderSize.TYPE_FLAG) ===
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

function parseData(view: DataView, remainingBytes: number): DataToken {
  if (remainingBytes > 512) {
    return { type: 'data', data: utils.extractBytes(view) };
  } else {
    const data = utils.extractBytes(view, 0, remainingBytes);
    return { type: 'data', data: data };
  }
}

class Parser {
  protected state: ParserState = ParserState.READY;
  protected remainingBytes = 0;

  write(data: Uint8Array) {
    if (data.byteLength !== constants.BLOCK_SIZE) {
      throw new errors.ErrorVirtualTarBlockSize(
        `Expected block size to be ${constants.BLOCK_SIZE} bytes but received ${data.byteLength} bytes`,
      );
    }

    const view = new DataView(data.buffer, 0, constants.BLOCK_SIZE);

    switch (this.state) {
      case ParserState.ENDED: {
        throw new errors.ErrorVirtualTarEndOfArchive(
          'Archive has already ended',
        );
      }

      case ParserState.READY: {
        // Check if we need to parse the end-of-archive marker
        if (utils.checkNullView(view)) {
          this.state = ParserState.NULL;
          return;
        }

        // Set relevant state if the header corresponds to a file
        const headerToken = parseHeader(view);
        if (headerToken.fileType === 'file') {
          this.state = ParserState.DATA;
          this.remainingBytes = headerToken.fileSize;
        }
        return headerToken;
      }

      case ParserState.DATA: {
        const parsedData = parseData(view, this.remainingBytes);
        this.remainingBytes -= 512;
        if (this.remainingBytes < 0) this.state = ParserState.READY;
        return parsedData;
      }

      case ParserState.NULL: {
        if (utils.checkNullView(view)) {
          this.state = ParserState.ENDED;
          return { type: 'end' } as EndToken;
        } else {
          throw new errors.ErrorVirtualTarEndOfArchive(
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

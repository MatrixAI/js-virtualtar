import type { ParserState, Header, Data, End } from './types';
import { HeaderOffset, HeaderSize, EntryType } from './types';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

class Parser {
  protected state: ParserState = 'ready';
  protected remainingBytes = 0;

  write(data: Uint8Array): Header | Data | End | undefined {
    if (data.byteLength !== constants.BLOCK_SIZE) {
      throw new errors.ErrorVirtualTarBlockSize(
        `Expected block size ${constants.BLOCK_SIZE} but received ${data.byteLength}`,
      );
    }

    const view = new DataView(data.buffer, 0, constants.BLOCK_SIZE);

    switch (this.state) {
      case 'ready': {
        if (utils.checkNullView(view)) {
          this.state = 'null';
          return;
        }

        const fileName = utils.parseFileName(view);
        const fileSize = utils.extractOctal(
          view,
          HeaderOffset.FILE_SIZE,
          HeaderSize.FILE_SIZE,
        );
        const fileMtime = new Date(
          utils.extractOctal(
            view,
            HeaderOffset.FILE_MTIME,
            HeaderSize.FILE_MTIME,
          ),
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
          utils.extractString(
            view,
            HeaderOffset.TYPE_FLAG,
            HeaderSize.TYPE_FLAG,
          ) === EntryType.FILE
            ? 'file'
            : 'directory';

        if (fileType === 'file') {
          this.state = 'header';
          this.remainingBytes = fileSize;
        }

        const parsedHeader: Header = {
          type: 'header',
          fileType,
          fileName,
          fileMode,
          fileMtime,
          fileSize,
          ownerGid,
          ownerUid,
          ownerName,
          ownerUserName,
          ownerGroupName,
        };

        return parsedHeader;
      }
      case 'header':
        if (this.remainingBytes > 512) {
          this.remainingBytes -= 512;
          return { type: 'data', data: utils.extractBytes(view) };
        } else {
          const data = utils.extractBytes(view, 0, this.remainingBytes);
          this.remainingBytes = 0;
          this.state = 'ready';
          return { type: 'data', data: data };
        }

      case 'null':
        if (utils.checkNullView(view)) return { type: 'end' };
        else throw new errors.ErrorVirtualTarEndOfArchive();

      default:
        utils.never('Unexpected state');
    }
  }
}

export default Parser;

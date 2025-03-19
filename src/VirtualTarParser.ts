import type {
  ParsedFile,
  ParsedDirectory,
  MetadataKeywords,
  TokenData,
  TokenHeader,
} from './types';
import Parser from './Parser';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

/**
 * VirtualTar is a library used to create tar files using a virtual file system
 * or a file tree. This library aims to provide a generator-parser pair to
 * create tar files without the reliance on a file system.
 *
 * This class is dedicated to parse an archive generated by the generator.
 */
class VirtualTarParser {
  /**
   * The parser object which converts each 512-byte chunk into a parsed token.
   */
  protected parser: Parser = new Parser();

  /**
   * The accumulator is used to, well, accumulate bytes until one chunk can be
   * parsed by the parser. Note that there is no limit to the size of the
   * writable chunk so the accumulator can grow to the size of the previously
   * written chunk.
   */
  protected accumulator: Uint8Array = new Uint8Array();

  /**
   * The working token is preserved in case additional data can follow the
   * header token. This gives the following data tokens some context.
   */
  protected workingToken: TokenHeader | undefined = undefined;

  /**
   * The data queue stores all the chunks for the extended metadata block. The
   * content of the extended metadata will be stored in memory anyways.
   */
  protected dataQueue: Array<Uint8Array> = [];

  /**
   * The extended metadata contains additional metadata in case it could not fit
   * in the standard tar header.
   */
  protected extendedMetadata:
    | Partial<Record<MetadataKeywords, string>>
    | undefined;

  /**
   * Each callback is a promise added to this set. Once the promise resolves, it
   * is removed from this set.
   */
  protected pendingCallbacks: Set<Promise<void>> = new Set();

  /**
   * This callback resolves a promise which is requesting the next data chunk.
   */
  protected resolveDataP: ((value: TokenData) => void) | undefined;

  /**
   * This callback resolves a promise waiting for all the pending callbacks to
   * resolve.
   */
  protected resolveSettledP: (() => void) | undefined;

  /**
   * This callback is triggered when a file entry is parsed. The file header is
   * sent over as a JSON object and the file data is sent in chunks via an async
   * generator.
   */
  protected fileCallback: (
    header: ParsedFile,
    data: () => AsyncGenerator<Uint8Array, void, void>,
  ) => Promise<void> | void;

  /**
   * This callback is triggered when a directory entry is parsed. The directory
   * header is sent over as a JSON object.
   */
  protected directoryCallback: (
    header: ParsedDirectory,
  ) => Promise<void> | void;

  /**
   * This callback is triggered when the archive has ended. Any cleanup can be
   * done here.
   */
  protected endCallback: () => Promise<void> | void;

  /**
   * Create a new VirtualTarParser object which can parse tar files.
   *
   * When parsing a tar file, optional callbacks are used to perform actions
   * on events. The `onFile` callback is triggered when a file is parsed. The
   * file data is queued up via an AsyncGenerator. The `onDirectory` callback
   * functions similarly, but without the presence of data. The `onEnd` callback
   * is triggered when the parser has generated an end token marking the archive
   * as completely parsed.
   *
   * Note that the file and directory callbacks aren't awaited, and instead
   * appended to an internal buffer of callbacks. Thus, {@link settled} can be
   * used to wait for all the pending promises to be completed.
   *
   * Note that each callback is not blocking, so it is possible that two
   * callbacks might try to modify the same resource.
   
   * @param onFile optional callback when a file has been parsed
   * @param onDirectory optional callback when a directory has been parsed
   * @param onEnd optional callback when the archive has ended
   *
   * @see {@link settled}
   */
  constructor({
    onFile,
    onDirectory,
    onEnd,
  }: {
    onFile?: (
      header: ParsedFile,
      data: () => AsyncGenerator<Uint8Array, void, void>,
    ) => Promise<void> | void;
    onDirectory?: (header: ParsedDirectory) => Promise<void> | void;
    onEnd?: () => Promise<void> | void;
  } = {}) {
    this.fileCallback = onFile ?? (() => Promise.resolve());
    this.directoryCallback = onDirectory ?? (() => Promise.resolve());
    this.endCallback = onEnd ?? (() => {});
  }

  /**
   * This waits for the internal queue of callbacks to resolve. Note that each
   * callback is not blocking, so it is possible that two callbacks might try to
   * modify the same resource.
   */
  public async settled(): Promise<void> {
    // Callbacks is already empty, so return early
    if (this.pendingCallbacks.size === 0) return;

    // Otherwise wait for all callbacks to be emptied
    await new Promise<void>((resolve) => {
      this.resolveSettledP = resolve;
    });
  }

  /**
   * Writes a chunk to the internal buffer. If the size of the internal buffer
   * is larger than or equal to 512 bytes, then the chunks are consumed from
   * the buffer until the buffer falls below this limit.
   *
   * Upon yielding a file or directory token, the relevant data is passed along
   * to the relevant callback. Note tha the callbacks are queued, so call
   * {@link settle} to wait for all the pending callbacks to resolve. The end
   * callback is synchronous, so it is executed immeidately instead of being
   * queued.
   *
   * Only usable when parsing an archive.
   *
   * @param chunk a chunk of the (or the entire) binary tar file
   */
  public async write(chunk: Uint8Array): Promise<void> {
    // Update the working accumulator with the new chunk
    this.accumulator = utils.concatUint8Arrays(this.accumulator, chunk);

    // Iterate over the accumulator until we run out of data
    while (this.accumulator.byteLength >= constants.BLOCK_SIZE) {
      // Extract the first chunk and remove that from the accumulator
      const block = this.accumulator.slice(0, constants.BLOCK_SIZE);
      this.accumulator = this.accumulator.slice(constants.BLOCK_SIZE);

      // Parse the next block. If the block is nullish, then we cannot parse
      // anything. Continue the loop.
      const token = this.parser.write(block);
      if (token == null) continue;

      const type = token.type;
      switch (type) {
        case 'header': {
          // If we get a new header token, then we are done working on the
          // previous token. Unset the working token.
          this.workingToken = undefined;

          // If we have additional metadata, then use it to override token data
          let filePath = token.filePath;
          if (this.extendedMetadata != null) {
            filePath = this.extendedMetadata.path ?? filePath;
            this.extendedMetadata = undefined;
          }

          switch (token.fileType) {
            case 'directory': {
              // Call the directory callback
              const p = (async () =>
                await this.directoryCallback({
                  type: 'directory',
                  path: filePath,
                  stat: {
                    size: token.fileSize,
                    mode: token.fileMode,
                    mtime: token.fileMtime,
                    uid: token.ownerUid,
                    gid: token.ownerGid,
                    uname: token.ownerUserName,
                    gname: token.ownerGroupName,
                  },
                }))();
              this.pendingCallbacks.add(p);

              // Remove the callback from the set after the promise settles
              p.finally(() => {
                this.pendingCallbacks.delete(p);
                // If we are waiting on settling the callbacks, then check is the
                // callbacks array is empty. If it is, then we have resolved all
                // pending callbacks.
                if (
                  this.resolveSettledP != null &&
                  this.pendingCallbacks.size === 0
                ) {
                  this.resolveSettledP();
                }
              });
              continue;
            }
            case 'file': {
              // The file token can be followed up with data, so set it as the
              // working token to prepare for following data tokens.
              this.workingToken = token;
              const parentThis = this;

              // Call the file callback
              const p = (async () => {
                await this.fileCallback(
                  {
                    type: 'file',
                    path: filePath,
                    stat: {
                      size: token.fileSize,
                      mode: token.fileMode,
                      mtime: token.fileMtime,
                      uid: token.ownerUid,
                      gid: token.ownerGid,
                      uname: token.ownerUserName,
                      gname: token.ownerGroupName,
                    },
                  },
                  async function* (): AsyncGenerator<Uint8Array, void, void> {
                    // If the file does not have any data, then return early
                    if (token.fileSize === 0) return;

                    while (true) {
                      const chunk = await new Promise<TokenData>((resolve) => {
                        parentThis.resolveDataP = resolve;
                      });
                      yield chunk.data;
                      if (chunk.end) break;
                    }
                  },
                );
              })();
              this.pendingCallbacks.add(p);

              // Remove the callback from the set after the promise settles
              p.finally(() => {
                this.pendingCallbacks.delete(p);
                // If we are waiting on settling the callbacks, then check is the
                // callbacks array is empty. If it is, then we have resolved all
                // pending callbacks.
                if (
                  this.resolveSettledP != null &&
                  this.pendingCallbacks.size === 0
                ) {
                  this.resolveSettledP();
                }
              });
              continue;
            }
            case 'extended':
              // If the token indicates extended metadata, then set the working
              // token and continue. There is no additional callbacks for this
              // token type.
              this.workingToken = token;
              continue;

            default:
              utils.never(`Unexpected type ${token.fileType}`);
          }
          break;
        }
        case 'data': {
          if (this.workingToken == null) {
            throw new errors.ErrorVirtualTarInvalidState(
              'Received data token before header token',
            );
          }

          // The value of this.workingToken.fileType can only be 'extended' or
          // 'file'.
          if (this.workingToken.fileType === 'extended') {
            this.dataQueue.push(token.data);

            // If we have acquired all the relevant data, then we can concat the
            // data.
            if (token.end) {
              // Concat the working data into a single Uint8Array and decode the
              // extended header.
              const data = utils.concatUint8Arrays(...this.dataQueue);
              this.extendedMetadata = utils.decodeExtendedHeader(data);
            }
          } else {
            if (this.resolveDataP != null) {
              this.resolveDataP(token);
            }
            // If the resolve callback is undefined, then nothing is waiting for
            // the data. We can ignore sending over the data and continue as
            // usual.
          }
          break;
        }
        case 'end':
          // Clean up the pending promises then trigger the end callback
          await this.settled();
          await this.endCallback();
          break;

        default:
          utils.never(`Invalid token type: ${type}`);
      }
    }
  }
}

export default VirtualTarParser;

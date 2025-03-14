import type {
  FileStat,
  ParsedFile,
  ParsedDirectory,
  MetadataKeywords,
  TokenData,
} from './types';
import { VirtualTarState } from './types';
import Generator from './Generator';
import Parser from './Parser';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

/**
 * VirtualTar is a library used to create tar files using a virtual file system
 * or a file tree. This library aims to provide a generator-parser pair to
 * create tar files without the reliance on a file system.
 */
class VirtualTar {
  protected ended: boolean;
  protected state: VirtualTarState;
  protected generator: Generator;
  protected parser: Parser;
  protected queue: Array<() => AsyncGenerator<Uint8Array, void, void>>;
  protected encoder = new TextEncoder();
  protected workingAccumulator: Uint8Array;
  protected workingTokenType: 'file' | 'extended' | undefined;
  protected workingData: Array<TokenData>;
  protected workingDataQueue: Array<Uint8Array>;
  protected workingMetadata:
    | Partial<Record<MetadataKeywords, string>>
    | undefined;
  protected resolveWaitP: (() => void) | undefined;
  protected resolveWaitDataP: (() => void) | undefined;
  protected settledP: Promise<void> | undefined;
  protected resolveSettledP: (() => void) | undefined;
  protected fileCallback: (
    header: ParsedFile,
    data: () => AsyncGenerator<Uint8Array, void, void>,
  ) => Promise<void>;
  protected directoryCallback: (header: ParsedDirectory) => Promise<void>;
  protected endCallback: () => void;
  protected callbacks: Array<Promise<void>>;

  /**
   * Create a new VirtualTar object initialized to a set mode. If the mode is
   * set to generate an archive, then operations involving parsing an archive
   * would be unavailable, and vice-versa.
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
   *
   * This method works slightly differently if an archive is being generated.
   * The operation of adding files to the archive will be added to an internal
   * buffer tracking all such 'operations', and the generated data can be
   * extracted via {@link yieldChunks}. In this case, awaiting {@link settled}
   * will wait until this internal queue of operations is empty.
   *
   * @param mode one of 'generate' or 'parse'
   * @param onFile optional callback when a file has been parsed
   * @param onDirectory optional callback when a directory has been parsed
   * @param onEnd optional callback when the archive has ended
   *
   * @see {@link settled}
   * @see {@link yieldChunks}
   */
  constructor({
    mode,
    onFile,
    onDirectory,
    onEnd,
  }: {
    mode: 'generate' | 'parse';
    onFile?: (
      header: ParsedFile,
      data: () => AsyncGenerator<Uint8Array, void, void>,
    ) => Promise<void>;
    onDirectory?: (header: ParsedDirectory) => Promise<void>;
    onEnd?: () => void;
  }) {
    if (mode === 'generate') {
      if (onFile != null || onDirectory != null || onEnd != null) {
        throw new errors.ErrorVirtualTar(
          'VirtualTar in generate mode does not support callbacks',
        );
      }
      this.state = VirtualTarState.GENERATOR;
      this.generator = new Generator();
      this.queue = [];
    } else {
      this.state = VirtualTarState.PARSER;
      this.parser = new Parser();
      this.workingData = [];
      this.workingDataQueue = [];
      this.workingAccumulator = new Uint8Array();
      this.callbacks = [];
      this.directoryCallback = onDirectory ?? (() => Promise.resolve());
      this.fileCallback = onFile ?? (() => Promise.resolve());
      this.endCallback = onEnd ?? (() => {});
    }
  }

  protected async *generateHeader(
    filePath: string,
    stat: FileStat = {},
    type: 'file' | 'directory',
  ): AsyncGenerator<Uint8Array, void, void> {
    if (filePath.length > constants.STANDARD_PATH_SIZE) {
      // Push the extended metadata header
      const data = utils.encodeExtendedHeader({ path: filePath });
      yield this.generator.generateExtended(data.byteLength);

      // Push the content
      for (
        let offset = 0;
        offset < data.byteLength;
        offset += constants.BLOCK_SIZE
      ) {
        yield this.generator.generateData(
          data.subarray(offset, offset + constants.BLOCK_SIZE),
        );
      }
    }

    filePath = filePath.length <= 255 ? filePath : '';

    // Generate the header
    if (type === 'file') {
      yield this.generator.generateFile(filePath, stat);
    } else {
      yield this.generator.generateDirectory(filePath, stat);
    }
  }

  /**
   * Queue up an operation to add a file to the archive.
   *
   * Only usable when generating an archive.
   *
   * @param filePath path of the file relative to the tar root
   * @param stat the stats of the file
   * @param data either a generator yielding data, a buffer, or a string
   */
  public addFile(
    filePath: string,
    stat: FileStat,
    data: () => AsyncGenerator<Uint8Array | string, void, void>,
  ): void;
  public addFile(filePath: string, stat: FileStat, data: Uint8Array): void;
  public addFile(filePath: string, stat: FileStat, data: string): void;
  public addFile(
    filePath: string,
    stat: FileStat,
    data:
      | Uint8Array
      | string
      | (() => AsyncGenerator<Uint8Array | string, void, void>),
  ): void {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }

    const globalThis = this;
    this.queue.push(async function* () {
      // Generate the header chunks (including extended header)
      yield* globalThis.generateHeader(filePath, stat, 'file');
      if (globalThis.resolveWaitP != null) {
        globalThis.resolveWaitP();
        globalThis.resolveWaitP = undefined;
      }

      // The base case of generating data is to have a async generator yielding
      // data, but in case the data is passed as an entire buffer or a string,
      // we need to chunk it up and wrap it in the async generator.
      let gen: AsyncGenerator<Uint8Array, void, void>;
      if (typeof data === 'function') {
        let workingBuffer: Array<Uint8Array> = [];
        let bufferSize = 0;

        // Ensure the data is properly converted into Uint8Arrays
        gen = (async function* () {
          for await (const chunk of data()) {
            let chunkBytes: Uint8Array;
            if (typeof chunk === 'string') {
              chunkBytes = globalThis.encoder.encode(chunk);
            } else {
              chunkBytes = chunk;
            }
            workingBuffer.push(chunkBytes);
            bufferSize += chunkBytes.byteLength;

            while (bufferSize >= constants.BLOCK_SIZE) {
              // Flatten buffer into one Uint8Array
              const fullBuffer = utils.concatUint8Arrays(...workingBuffer);

              yield globalThis.generator.generateData(
                fullBuffer.slice(0, constants.BLOCK_SIZE),
              );

              // Remove processed bytes from buffer
              const remaining = fullBuffer.slice(constants.BLOCK_SIZE);
              workingBuffer = [];
              if (remaining.byteLength > 0) workingBuffer.push(remaining);
              bufferSize = remaining.byteLength;

              if (globalThis.resolveWaitP != null) {
                globalThis.resolveWaitP();
                globalThis.resolveWaitP = undefined;
              }
            }
          }
          if (bufferSize !== 0) {
            yield globalThis.generator.generateData(
              utils.concatUint8Arrays(...workingBuffer),
            );
          }
        })();
      } else {
        // Ensure that the data is being chunked up to 512 bytes
        gen = (async function* () {
          if (data instanceof Uint8Array) {
            for (
              let offset = 0;
              offset < data.byteLength;
              offset += constants.BLOCK_SIZE
            ) {
              const chunk = data.subarray(
                offset,
                offset + constants.BLOCK_SIZE,
              );
              yield globalThis.generator.generateData(chunk);
              if (globalThis.resolveWaitP != null) {
                globalThis.resolveWaitP();
                globalThis.resolveWaitP = undefined;
              }
            }
          } else {
            while (data.length > 0) {
              const chunk = globalThis.encoder.encode(
                data.slice(0, constants.BLOCK_SIZE),
              );
              yield globalThis.generator.generateData(chunk);
              data = data.slice(constants.BLOCK_SIZE);
              if (globalThis.resolveWaitP != null) {
                globalThis.resolveWaitP();
                globalThis.resolveWaitP = undefined;
              }
            }
          }
        })();
      }
      yield* gen;
    });
  }

  /**
   * Queue up an operation to add a directory to the archive.
   *
   * Only usable when generating an archive.
   *
   * @param filePath path of the directory relative to the tar root
   * @param stat the stats of the directory
   */
  public addDirectory(filePath: string, stat?: FileStat): void {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }

    const globalThis = this;
    this.queue.push(async function* () {
      yield* globalThis.generateHeader(filePath, stat, 'directory');
    });
  }

  /**
   * Queue up an operation to finalize the archive by adding two null chunks
   * indicating the end of archive.
   *
   * Only usable when generating an archive.
   */
  public finalize(): void {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }
    const globalThis = this;
    this.queue.push(async function* () {
      yield globalThis.generator.generateEnd();
      yield globalThis.generator.generateEnd();
    });
    this.ended = true;
  }

  /**
   * While generating, this waits for the internal queue of operations to empty
   * before resolving. Note that if nothing is consuming the data in the queue,
   * then this promise will keep waiting.
   *
   * While parsing, this waits for the internal queue of callbacks to resolve.
   * Note that each callback is not blocking, so it is possible that two
   * callbacks might try to modify the same resource.
   *
   * Only usable when generating an archive.
   *
   * @see {@link yieldChunks} to consume the operations and yield binary chunks
   */
  public async settled(): Promise<void> {
    if (this.state === VirtualTarState.GENERATOR) {
      this.settledP = new Promise<void>((resolve) => {
        this.resolveSettledP = resolve;
      });
      await this.settledP;
    } else {
      await Promise.allSettled(this.callbacks);
    }
  }

  /**
   * Returns a generator which yields 512-byte chunks as they are generated from
   * the queued operations.
   *
   * Only usable when generating an archive.
   */
  public async *yieldChunks(): AsyncGenerator<Uint8Array, void, void> {
    while (true) {
      const gen = this.queue.shift();
      if (gen == null) {
        // We have gone through all the buffered tasks. Check if we have ended
        // yet or we are still going.
        if (this.ended) break;
        if (this.resolveSettledP != null) this.resolveSettledP();

        // Wait until more data is available
        const waitP = new Promise<void>((resolve) => {
          this.resolveWaitP = resolve;
        });
        await waitP;
        continue;
      }

      yield* gen();
    }
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
  public write(chunk: Uint8Array): void {
    if (this.state !== VirtualTarState.PARSER) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in parser mode',
      );
    }

    // Update the working accumulator
    this.workingAccumulator = utils.concatUint8Arrays(
      this.workingAccumulator,
      chunk,
    );

    while (this.workingAccumulator.byteLength >= constants.BLOCK_SIZE) {
      const block = this.workingAccumulator.slice(0, constants.BLOCK_SIZE);
      this.workingAccumulator = this.workingAccumulator.slice(
        constants.BLOCK_SIZE,
      );
      const token = this.parser.write(block);
      if (token == null) continue;

      if (token.type === 'header') {
        // If we have an extended header, then set the working header to the
        // extended type and continue. Otherwise, if we have a file, then set
        // the token type to file.
        if (token.fileType === 'extended') {
          this.workingTokenType = 'extended';
          continue;
        } else if (token.fileType === 'file') {
          this.workingTokenType = 'file';
        } else {
          this.workingTokenType = undefined;
        }

        // If we have additional metadata, then use it to override token data
        let filePath = token.filePath;
        if (this.workingMetadata != null) {
          filePath = this.workingMetadata.path ?? filePath;
          this.workingMetadata = undefined;
        }

        if (token.fileType === 'directory') {
          const p = this.directoryCallback({
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
          });
          this.callbacks.push(p);
          continue;
        } else if (token.fileType === 'file') {
          const globalThis = this;
          const p = this.fileCallback(
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
              // Return early if no data will be coming
              if (token.fileSize === 0) return;

              while (true) {
                const chunk = globalThis.workingData.shift();
                if (chunk == null) {
                  await new Promise<void>((resolve) => {
                    globalThis.resolveWaitDataP = resolve;
                  });
                  continue;
                }
                yield chunk.data;
                if (chunk.end) break;
              }
            },
          );
          this.callbacks.push(p);
          continue;
        }
      } else if (token.type === 'data') {
        if (this.workingTokenType == null) {
          throw new errors.ErrorVirtualTarInvalidState(
            'Received data token before header token',
          );
        }

        this.workingData.push(token);

        // If we are working on a file, then signal that we have gotten more
        // data.
        if (this.resolveWaitDataP != null) {
          this.resolveWaitDataP();
        }

        // If we are working on a metadata token, then we need to collect the
        // entire data array as we need to decode it to file stat which needs to
        // sit in memory anyways.
        if (token.end && this.workingTokenType === 'extended') {
          // Concat the working data into a single Uint8Array
          const data = utils.concatUint8Arrays(
            ...this.workingData.map(({ data }) => data),
          );
          this.workingData = [];

          // Decode the extended header
          this.workingMetadata = utils.decodeExtendedHeader(data);
        }
      } else {
        // Token is of type end. Clean up the pending promises then trigger the
        // end callback.
        (async () => {
          await this.settled();
          this.endCallback();
        })();
      }
    }
  }
}

export default VirtualTar;

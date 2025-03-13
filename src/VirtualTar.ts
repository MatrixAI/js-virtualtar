import type {
  FileStat,
  ParsedFile,
  ParsedDirectory,
  ParsedMetadata,
  ParsedEmpty,
  MetadataKeywords,
  TokenData,
} from './types';
import { VirtualTarState } from './types';
import Generator from './Generator';
import Parser from './Parser';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

class VirtualTar {
  protected ended: boolean;
  protected state: VirtualTarState;
  protected generator: Generator;
  protected parser: Parser;
  protected queue: Array<() => AsyncGenerator<Uint8Array, void, void>>;
  protected encoder = new TextEncoder();
  protected workingAccumulator: Uint8Array;
  protected workingToken: ParsedFile | ParsedMetadata | undefined;
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
        // Ensure the data is properly converted into Uint8Arrays
        gen = (async function* () {
          for await (const chunk of data()) {
            if (typeof chunk === 'string') {
              yield globalThis.encoder.encode(chunk);
            } else {
              yield chunk;
            }
            if (globalThis.resolveWaitP != null) {
              globalThis.resolveWaitP();
              globalThis.resolveWaitP = undefined;
            }
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
              const chunk = data.slice(offset, offset + constants.BLOCK_SIZE);
              yield globalThis.generator.generateData(chunk);
              if (globalThis.resolveWaitP != null) {
                globalThis.resolveWaitP();
                globalThis.resolveWaitP = undefined;
              }
            }
          } else {
            while (data.length > 0) {
              const chunk = this.encoder.encode(
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
    });
  }

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

  public finalize(): void {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }
    this.queue.push(async function* () {
      yield globalThis.generator.generateEnd();
      yield globalThis.generator.generateEnd();
    });
    this.ended = true;
  }

  public async settled(): Promise<void> {
    this.settledP = new Promise<void>((resolve) => {
      this.resolveSettledP = resolve;
    });
    await this.settledP;
  }

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
        // extended type and continue
        if (token.fileType === 'metadata') {
          this.workingToken = { type: 'metadata' };
          continue;
        }

        // If we have additional metadata, then use it to override token data
        let filePath = token.filePath;
        if (this.workingMetadata != null) {
          filePath = this.workingMetadata.path ?? filePath;
          this.workingMetadata = undefined;
        }

        if (token.fileType === 'directory') {
          this.directoryCallback({
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
          continue;
        } else if (token.fileType === 'file') {
          this.fileCallback(
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
              while (true) {
                const chunk = this.workingData.shift();
                if (chunk == null) {
                  await new Promise<void>((resolve) => {
                    this.resolveWaitDataP = resolve;
                  });
                }
                yield chunk.data;
                if (chunk.ended) break;
              }
            },
          );
          continue;
        }
      } else if (token.type === 'data') {
        if (this.workingToken == null) {
          throw new errors.ErrorVirtualTarInvalidState(
            'Received data token before header token',
          );
        }

        this.workingData.push(token);

        // If we are working on a file, then signal that we have gotten more
        // data.
        if (
          this.workingToken.type === 'file' &&
          this.resolveWaitDataP != null
        ) {
          this.resolveWaitDataP();
        }

        // If we are working on a metadata token, then we need to collect the
        // entire data array as we need to decode it to file stat which needs to
        // sit in memory anyways.
        if (token.end && this.workingToken.type === 'metadata') {
          // Concat the working data into a single Uint8Array
          const data = utils.concatUint8Arrays(
            ...this.workingData.map(({ data }) => data),
          );
          this.workingData = [];

          // Decode the extended header
          this.workingMetadata = utils.decodeExtendedHeader(data);
        }
      } else {
        // Token is of type end
        this.endCallback();
      }
    }
  }
}

export default VirtualTar;

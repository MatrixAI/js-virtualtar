import type {
  FileStat,
  ParsedFile,
  ParsedDirectory,
  ParsedMetadata,
  ParsedEmpty,
  MetadataKeywords,
} from './types';
import { VirtualTarState } from './types';
import Generator from './Generator';
import Parser from './Parser';
import * as constants from './constants';
import * as errors from './errors';
import * as utils from './utils';

class VirtualTar {
  protected state: VirtualTarState;
  protected generator: Generator;
  protected parser: Parser;
  protected chunks: Array<Uint8Array>;
  protected encoder = new TextEncoder();
  protected accumulator: Uint8Array;
  protected workingToken: ParsedFile | ParsedMetadata | undefined;
  protected workingData: Array<Uint8Array>;
  protected workingMetadata:
    | Partial<Record<MetadataKeywords, string>>
    | undefined;

  protected addEntry(
    filePath: string,
    type: 'file' | 'directory',
    stat: FileStat = {},
    dataOrCallback?:
      | Uint8Array
      | string
      | ((write: (chunk: string | Uint8Array) => void) => void),
  ): void {
    if (filePath.length > constants.STANDARD_PATH_SIZE) {
      // Push the extended metadata header
      const data = utils.encodeExtendedHeader({ path: filePath });
      this.chunks.push(this.generator.generateExtended(data.byteLength));

      // Push the content
      for (
        let offset = 0;
        offset < data.byteLength;
        offset += constants.BLOCK_SIZE
      ) {
        this.chunks.push(
          this.generator.generateData(
            data.subarray(offset, offset + constants.BLOCK_SIZE),
          ),
        );
      }
    }

    filePath = filePath.length <= 255 ? filePath : '';

    // Generate the header
    if (type === 'file') {
      this.chunks.push(this.generator.generateFile(filePath, stat));
    } else {
      this.chunks.push(this.generator.generateDirectory(filePath, stat));
    }

    // Generate the data
    if (dataOrCallback == null) return;

    const writeData = (data: string | Uint8Array) => {
      if (data instanceof Uint8Array) {
        for (
          let offset = 0;
          offset < data.byteLength;
          offset += constants.BLOCK_SIZE
        ) {
          const chunk = data.slice(offset, offset + constants.BLOCK_SIZE);
          this.chunks.push(this.generator.generateData(chunk));
        }
      } else {
        while (data.length > 0) {
          const chunk = this.encoder.encode(
            data.slice(0, constants.BLOCK_SIZE),
          );
          this.chunks.push(this.generator.generateData(chunk));
          data = data.slice(constants.BLOCK_SIZE);
        }
      }
    };

    if (typeof dataOrCallback === 'function') {
      const data: Array<Uint8Array> = [];
      const writer = (chunk: string | Uint8Array) => {
        if (chunk instanceof Uint8Array) data.push(chunk);
        else data.push(this.encoder.encode(chunk));
      };
      dataOrCallback(writer);
      writeData(utils.concatUint8Arrays(...data));
    } else {
      writeData(dataOrCallback);
    }
  }

  constructor({ mode }: { mode: 'generate' | 'parse' } = { mode: 'parse' }) {
    if (mode === 'generate') {
      this.state = VirtualTarState.GENERATOR;
      this.generator = new Generator();
      this.chunks = [];
    } else {
      this.state = VirtualTarState.PARSER;
      this.parser = new Parser();
      this.workingData = [];
    }
  }

  public addFile(
    filePath: string,
    stat: FileStat,
    data?: Uint8Array | string,
  ): void;

  public addFile(
    filePath: string,
    stat: FileStat,
    data?:
      | Uint8Array
      | string
      | ((writer: (chunk: string | Uint8Array) => void) => void),
  ): void;

  public addFile(
    filePath: string,
    stat: FileStat,
    data?:
      | Uint8Array
      | string
      | ((writer: (chunk: string | Uint8Array) => void) => void),
  ): void {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }
    this.addEntry(filePath, 'file', stat, data);
  }

  public addDirectory(filePath: string, stat?: FileStat): void {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }
    this.addEntry(filePath, 'directory', stat);
  }

  public finalize(): Uint8Array {
    if (this.state !== VirtualTarState.GENERATOR) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in generator mode',
      );
    }
    this.chunks.push(this.generator.generateEnd());
    this.chunks.push(this.generator.generateEnd());
    return utils.concatUint8Arrays(...this.chunks);
  }

  public push(chunk: Uint8Array): void {
    if (this.state !== VirtualTarState.PARSER) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in parser mode',
      );
    }
    this.accumulator = utils.concatUint8Arrays(this.accumulator, chunk);
  }

  public next(): ParsedFile | ParsedDirectory | ParsedEmpty {
    if (this.state !== VirtualTarState.PARSER) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in parser mode',
      );
    }
    if (this.accumulator.byteLength < constants.BLOCK_SIZE) {
      return { type: 'empty', awaitingData: true };
    }

    const chunk = this.accumulator.slice(0, constants.BLOCK_SIZE);
    this.accumulator = this.accumulator.slice(constants.BLOCK_SIZE);
    const token = this.parser.write(chunk);

    if (token == null) {
      return { type: 'empty', awaitingData: false };
    }

    if (token.type === 'header') {
      if (token.fileType === 'metadata') {
        this.workingToken = { type: 'metadata' };
        return { type: 'empty', awaitingData: false };
      }

      // If we have additional metadata, then use it to override token data
      let filePath = token.filePath;
      if (this.workingMetadata != null) {
        filePath = this.workingMetadata.path ?? filePath;
        this.workingMetadata = undefined;
      }

      if (token.fileType === 'directory') {
        return {
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
        };
      } else if (token.fileType === 'file') {
        this.workingToken = {
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
          content: new Uint8Array(token.fileSize),
        };
      }
    } else {
      if (this.workingToken == null) {
        throw new errors.ErrorVirtualTarInvalidState(
          'Received data token before header token',
        );
      }
      if (token.type === 'end') {
        throw new errors.ErrorVirtualTarInvalidState(
          'Received end token before header token',
        );
      }

      // Token is of type 'data' after this
      const { data, end } = token;
      this.workingData.push(data);

      if (end) {
        // Concat the working data into a single Uint8Array
        const data = utils.concatUint8Arrays(...this.workingData);
        this.workingData = [];

        // If the current working token is a metadata token, then decode the
        // accumulated header. Otherwise, we have obtained all the data for
        // a file. Set the content of the file then return it.
        if (this.workingToken.type === 'metadata') {
          this.workingMetadata = utils.decodeExtendedHeader(data);
          return { type: 'empty', awaitingData: false };
        } else if (this.workingToken.type === 'file') {
          this.workingToken.content.set(data);
          const fileToken = this.workingToken;
          this.workingToken = undefined;
          return fileToken;
        }
      }
    }
    return { type: 'empty', awaitingData: false };
  }

  public parseAvailable(): Array<ParsedFile | ParsedDirectory> {
    if (this.state !== VirtualTarState.PARSER) {
      throw new errors.ErrorVirtualTarInvalidState(
        'VirtualTar is not in parser mode',
      );
    }

    const parsedTokens: Array<ParsedFile | ParsedDirectory> = [];
    let token;
    while (token.type !== 'empty' && !token.awaitingData) {
      token = this.next();
      parsedTokens.push(token);
    }
    return parsedTokens;
  }
}

export default VirtualTar;

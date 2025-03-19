import type { FileStat } from './types';
import Generator from './Generator';
import * as constants from './constants';
import * as utils from './utils';

/**
 * VirtualTar is a library used to create tar files using a virtual file system
 * or a file tree. This library aims to provide a generator-parser pair to
 * create tar files without the reliance on a file system.
 *
 * This class is dedicated to generate an archive to be parsed by the parser.
 *
 * The operation of adding files to the archive will be added to an internal
 * buffer tracking all such 'operations', and the generated data can be
 * extracted via {@link yieldchunks}. In this case, awaiting {@link settled}
 * will wait until this internal queue of operations is empty.
 *
 * @see {@link settled}
 * @see {@link yieldchunks}
 */
class VirtualTarGenerator {
  /**
   * This flag tells the generator that no further data will be added to the
   * queue. This is the exit condition required to exit yielding chunks.
   */
  protected ended: boolean;

  /**
   * The generator object which generates a tar chunk given some file stats.
   */
  protected generator: Generator = new Generator();

  /**
   * The queue stores all the async generators which can yield chunks. The
   * generators in this queue are consumed in {@link yieldChunks}.
   */
  protected queue: Array<() => AsyncGenerator<Uint8Array, void, void>> = [];

  /**
   * This callback resolves a promise waiting for more chunks to be added to the
   * queue.
   */
  protected resolveWaitChunksP: (() => void) | undefined;

  /**
   * This callback resolves a promise waiting for more data to be added to a
   * file.
   */
  protected resolveWaitDataP: (() => void) | undefined;

  /**
   * This callback resolves a promise waiting for the queue to be drained.
   */
  protected resolveSettledP: (() => void) | undefined;

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
    const encoder = new TextEncoder();
    const parentThis = this;
    this.queue.push(async function* () {
      // Generate the header chunks (including extended header)
      yield* parentThis.generateHeader(filePath, stat, 'file');

      // The base case of generating data is to have a async generator yielding
      // data, but in case the data is passed as an entire buffer or a string,
      // we need to chunk it up and wrap it in the async generator.
      if (typeof data === 'function') {
        let workingBuffer: Array<Uint8Array> = [];
        let bufferSize = 0;

        // Ensure the data is properly converted into Uint8Arrays
        for await (const chunk of data()) {
          let chunkBytes: Uint8Array;
          if (typeof chunk === 'string') {
            chunkBytes = encoder.encode(chunk);
          } else {
            chunkBytes = chunk;
          }
          workingBuffer.push(chunkBytes);
          bufferSize += chunkBytes.byteLength;

          while (bufferSize >= constants.BLOCK_SIZE) {
            // Flatten buffer into one Uint8Array
            const fullBuffer = utils.concatUint8Arrays(...workingBuffer);

            yield parentThis.generator.generateData(
              fullBuffer.slice(0, constants.BLOCK_SIZE),
            );

            // Remove processed bytes from buffer
            const remaining = fullBuffer.slice(constants.BLOCK_SIZE);
            workingBuffer = [];
            if (remaining.byteLength > 0) workingBuffer.push(remaining);
            bufferSize = remaining.byteLength;
          }
        }
        if (bufferSize !== 0) {
          yield parentThis.generator.generateData(
            utils.concatUint8Arrays(...workingBuffer),
          );
        }
      } else {
        // Ensure that the data is being chunked up to 512 bytes
        if (data instanceof Uint8Array) {
          for (
            let offset = 0;
            offset < data.byteLength;
            offset += constants.BLOCK_SIZE
          ) {
            const chunk = data.subarray(offset, offset + constants.BLOCK_SIZE);
            yield parentThis.generator.generateData(chunk);
          }
        } else {
          while (data.length > 0) {
            const chunk = encoder.encode(data.slice(0, constants.BLOCK_SIZE));
            yield parentThis.generator.generateData(chunk);
            data = data.slice(constants.BLOCK_SIZE);
          }
        }
      }
    });

    // We have pushed a new generator to the queue. If the data generator is
    // waiting for data, then we can signal it to resume processing.
    if (parentThis.resolveWaitChunksP != null) {
      parentThis.resolveWaitChunksP();
      parentThis.resolveWaitChunksP = undefined;
    }
  }

  /**
   * Queue up an operation to add a directory to the archive.
   *
   * @param filePath path of the directory relative to the tar root
   * @param stat the stats of the directory
   */
  public addDirectory(filePath: string, stat?: FileStat): void {
    const parentThis = this;
    this.queue.push(async function* () {
      yield* parentThis.generateHeader(filePath, stat, 'directory');
    });
  }

  /**
   * Queue up an operation to finalize the archive by adding two null chunks
   * indicating the end of archive.
   */
  public finalize(): void {
    const parentThis = this;
    this.queue.push(async function* () {
      yield parentThis.generator.generateEnd();
      yield parentThis.generator.generateEnd();
    });

    // We have pushed a new generator to the queue. If the data generator is
    // waiting for data, then we can signal it to resume processing.
    if (parentThis.resolveWaitChunksP != null) {
      parentThis.resolveWaitChunksP();
      parentThis.resolveWaitChunksP = undefined;
    }

    // This flag will only be read after the queue is exhausted, signalling no
    // further data will be added.
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
   * @see {@link yieldChunks} to consume the operations and yield binary chunks
   */
  public async settled(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.resolveSettledP = resolve;
    });
  }

  /**
   * Returns a generator which yields 512-byte chunks as they are generated from
   * the queued operations.
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
        await new Promise<void>((resolve) => {
          this.resolveWaitChunksP = resolve;
        });
        continue;
      }

      yield* gen();
    }
  }
}

export default VirtualTarGenerator;

import fc from 'fast-check';
import { test } from '@fast-check/jest';
import Generator from '@/Generator';
import { EntryType, GeneratorState } from '@/types';
import * as tarUtils from '@/utils';
import * as tarErrors from '@/errors';
import * as utils from './utils';

describe('generating archive', () => {
  test.prop([utils.fileArb()])(
    'should generate a valid file header',
    (file) => {
      // Generate and split the header
      const generator = new Generator();
      const header = generator.generateFile(file.path, file.stat);
      const { name, type, mode, uid, gid, size, mtime, format, version } =
        utils.splitHeaderData(header);

      // @ts-ignore: accessing protected member for state analysis
      const state = generator.state;
      if (file.stat.size === 0) expect(state).toEqual(GeneratorState.READY);
      else expect(state).toEqual(GeneratorState.DATA);

      // Compare the values to the expected ones
      expect(name).toEqual(file.path);
      expect(type).toEqual(EntryType.FILE);
      expect(mode).toEqual(file.stat.mode);
      expect(uid).toEqual(file.stat.uid);
      expect(gid).toEqual(file.stat.gid);
      expect(size).toEqual(file.stat.size);
      expect(mtime).toEqual(tarUtils.dateToUnixTime(file.stat.mtime!));
      expect(format).toEqual('ustar');
      expect(version).toEqual('00');
    },
  );

  test.prop([utils.dirArb(0)])(
    'should generate a valid directory header',
    (file) => {
      // Generate and split the header
      const generator = new Generator();
      const header = generator.generateDirectory(file.path, file.stat);
      const { name, type, mode, uid, gid, size, mtime, format, version } =
        utils.splitHeaderData(header);

      // @ts-ignore: accessing protected member for state analysis
      const state = generator.state;
      if (file.stat.size === 0) expect(state).toEqual(GeneratorState.READY);

      // Compare the values to the expected ones
      expect(name).toEqual(file.path);
      expect(type).toEqual(EntryType.DIRECTORY);
      expect(mode).toEqual(file.stat.mode);
      expect(uid).toEqual(file.stat.uid);
      expect(gid).toEqual(file.stat.gid);
      expect(size).toEqual(0);
      expect(mtime).toEqual(tarUtils.dateToUnixTime(file.stat.mtime!));
      expect(format).toEqual('ustar');
      expect(version).toEqual('00');
    },
  );

  test('should generate a valid null chunk', () => {
    const generator = new Generator();
    const nullChunk = generator.generateEnd();
    expect(nullChunk.reduce((sum, byte) => (sum += byte))).toBe(0);

    // @ts-ignore: accessing protected member for state analysis
    const state = generator.state;
    expect(state).toEqual(GeneratorState.NULL);
  });
});

describe('generator state robustness', () => {
  test.prop([utils.fileContentArb(0)], { numRuns: 1 })(
    'should fail writing data when header is expected',
    (data) => {
      const generator = new Generator();
      const encoder = new TextEncoder();
      expect(() => generator.generateData(encoder.encode(data))).toThrowError(
        tarErrors.ErrorVirtualTarGeneratorInvalidState,
      );
    },
  );

  test.prop([utils.fileArb(), utils.fileArb()], { numRuns: 1 })(
    'should fail writing new header if previous file header has not sent any data',
    (file1, file2) => {
      fc.pre(file1.stat.size !== 0);
      const generator = new Generator();

      // Writing first file
      generator.generateFile(file1.path, file1.stat);
      // @ts-ignore: accessing protected member for state analysis
      const state1 = generator.state;
      expect(state1).toEqual(GeneratorState.DATA);

      // Writing second file
      expect(() => generator.generateFile(file2.path, file2.stat)).toThrowError(
        tarErrors.ErrorVirtualTarGeneratorInvalidState,
      );
    },
  );

  test.prop(
    [fc.oneof(utils.fileContentArb(), utils.fileArb(), utils.dirArb(0))],
    { numRuns: 10 },
  )('should fail writing data when attempting to end archive', (data) => {
    const generator = new Generator();

    // Parse the type of incoming data and smartly switch between different
    // methods of writing to the generator.
    const writeData = () => {
      if (typeof data === 'string') {
        // Data is file content
        const encoder = new TextEncoder();
        generator.generateData(encoder.encode(data));
      } else if (data.type === EntryType.FILE) {
        // Data is file
        generator.generateFile(data.path, data.stat);
      } else {
        // Data is directory
        generator.generateDirectory(data.path, data.stat);
      }
    };

    generator.generateEnd();
    expect(writeData).toThrowError(
      tarErrors.ErrorVirtualTarGeneratorInvalidState,
    );
  });

  test.prop(
    [fc.oneof(utils.fileContentArb(), utils.fileArb(), utils.dirArb(0))],
    { numRuns: 10 },
  )('should fail writing data after ending archive', (data) => {
    const generator = new Generator();

    // Parse the type of incoming data and smartly switch between different
    // methods of writing to the generator.
    const writeData = () => {
      if (typeof data === 'string') {
        // Data is file content
        const encoder = new TextEncoder();
        generator.generateData(encoder.encode(data));
      } else if (data.type === EntryType.FILE) {
        // Data is file
        generator.generateFile(data.path, data.stat);
      } else {
        // Data is directory
        generator.generateDirectory(data.path, data.stat);
      }
    };

    generator.generateEnd();
    generator.generateEnd();
    expect(writeData).toThrowError(
      tarErrors.ErrorVirtualTarGeneratorInvalidState,
    );
  });
});
